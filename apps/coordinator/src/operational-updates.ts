import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalize, operationalUpdateHash, verifyOperationalUpdate, verifyOperationalUpdates,
  type CeremonyManifestV1, type JsonValue, type OperationalUpdate, type SignedEnvelope } from "@moss/phase2-protocol";
import type { PublicationTarget } from "./publication.js";
import { heartbeatGraceSeconds } from "./heartbeat-policy.js";

type Envelope = SignedEnvelope<OperationalUpdate>;
type Reader = Pick<Pool, "query"> | PoolClient;

export async function expireParticipantLeases(db: Reader, ceremonyId: string, fallback: number): Promise<void> {
  await db.query(`WITH expired AS (
    UPDATE leases SET state='EXPIRED' WHERE ceremony_id=$1 AND (
      (state='OFFERED' AND expires_at<=now()) OR
      (state='ACTIVE' AND (expires_at<=now() OR heartbeat_at<=now()-(COALESCE(heartbeat_grace_seconds,$2) * interval '1 second')))
    ) RETURNING ticket_id
  ) UPDATE queue_tickets SET status='EXPIRED' WHERE id IN (SELECT ticket_id FROM expired)`, [ceremonyId, fallback]);
}

export interface ReleasedDownload {
  leaseId: string;
  reason: "download-too-slow" | "download-stalled";
  downloadFraction: number | null;
  elapsedSeconds: number;
}

/**
 * Release claimed slots whose download visibly cannot finish, so the next
 * participant is offered the slot within minutes instead of at the 30-minute
 * limit. Uses only the progress contributors report with their heartbeats.
 */
export async function releaseHopelessDownloads(
  db: Reader,
  ceremonyId: string,
  policy: { graceSeconds: number; projectedDownloadLimitSeconds: number; stallSeconds: number },
): Promise<ReleasedDownload[]> {
  const result = await db.query<{ id: string; released_reason: ReleasedDownload["reason"];
    progress_fraction: number | null; elapsed: string }>(`WITH released AS (
    UPDATE leases SET state='EXPIRED', released_reason = CASE
        WHEN progress_advanced_at <= now()-($3 * interval '1 second') THEN 'download-stalled'
        ELSE 'download-too-slow' END
      WHERE ceremony_id=$1 AND state='ACTIVE' AND progress_stage='downloading'
        AND claimed_at <= now()-($2 * interval '1 second')
        AND (progress_advanced_at <= now()-($3 * interval '1 second')
          OR extract(epoch FROM now()-claimed_at) > $4 * COALESCE(progress_fraction, 0))
      RETURNING id, ticket_id, released_reason, progress_fraction,
        extract(epoch FROM now()-claimed_at)::text AS elapsed
  ), tickets AS (
    UPDATE queue_tickets SET status='EXPIRED' WHERE id IN (SELECT ticket_id FROM released)
  ) SELECT id, released_reason, progress_fraction, elapsed FROM released`,
  [ceremonyId, policy.graceSeconds, policy.stallSeconds, policy.projectedDownloadLimitSeconds]);
  return result.rows.map((row) => ({ leaseId: row.id, reason: row.released_reason,
    downloadFraction: row.progress_fraction, elapsedSeconds: Math.round(Number(row.elapsed)) }));
}

/** Database-backed, root-authenticated updates. Never replaces the ceremony manifest. */
export class OperationalUpdates {
  constructor(private readonly options: {
    pool: Pool; manifest: SignedEnvelope<CeremonyManifestV1>; rootPublicKey: string;
    allowRehearsal?: boolean; archive?: PublicationTarget; production: boolean;
  }) {}

  private get id() { return this.options.manifest.payload.ceremonyId; }
  private get baseline() { return heartbeatGraceSeconds(this.options.manifest.payload, this.options.allowRehearsal); }

  async history(db: Reader = this.options.pool) {
    const result = await db.query<{ envelope: Envelope; applied_at: Date; archive_pin: unknown }>(
      "SELECT envelope,applied_at,archive_pin FROM operational_updates WHERE ceremony_id=$1 ORDER BY sequence", [this.id]);
    const updates = result.rows.map((row) => row.envelope);
    verifyOperationalUpdates(updates, this.options.manifest, this.options.rootPublicKey, this.options.allowRehearsal);
    return { updates, appliedAt: result.rows.map((row) => row.applied_at.toISOString()), archives: result.rows.map((row) => row.archive_pin) };
  }

  private grace(updates: Envelope[]) {
    return updates.reduce((value, update) => update.payload.heartbeatGraceSeconds ?? value, this.baseline);
  }

  private async locked<T>(action: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.options.pool.connect();
    try {
      await db.query("BEGIN");
      const row = await db.query("SELECT id FROM ceremonies WHERE id=$1 FOR UPDATE", [this.id]);
      if (!row.rows.length) throw new Error("Ceremony not found");
      const result = await action(db);
      await db.query("COMMIT");
      return result;
    } catch (error) { await db.query("ROLLBACK"); throw error; }
    finally { db.release(); }
  }

  async apply(envelope: Envelope): Promise<{ sequence: number; updateSha256: string }> {
    // Authenticate before acquiring any lock or publishing anything.
    const snapshot = await this.history();
    const existing = snapshot.updates.find((entry) => operationalUpdateHash(entry) === operationalUpdateHash(envelope));
    if (existing) return { sequence: existing.payload.sequence, updateSha256: operationalUpdateHash(existing) };
    verifyOperationalUpdate(envelope, this.options.manifest, this.options.rootPublicKey, snapshot.updates.at(-1) ?? null, this.options.allowRehearsal);
    return this.locked(async (db) => {
      const { updates } = await this.history(db);
      const duplicate = updates.find((entry) => operationalUpdateHash(entry) === operationalUpdateHash(envelope));
      if (duplicate) return { sequence: duplicate.payload.sequence, updateSha256: operationalUpdateHash(duplicate) };
      const value = verifyOperationalUpdate(envelope, this.options.manifest, this.options.rootPublicKey, updates.at(-1) ?? null, this.options.allowRehearsal);
      verifyOperationalUpdates([...updates, envelope], this.options.manifest, this.options.rootPublicKey, this.options.allowRehearsal);
      if (Date.parse(value.authorizedAt) > Date.now() + 300_000) throw new Error("Operational update authorization time is in the future");
      if (value.heartbeatGraceSeconds !== undefined) {
        const row = await db.query("SELECT state,seals_at FROM ceremonies WHERE id=$1", [this.id]);
        if (row.rows[0].state !== "OPEN" || new Date(row.rows[0].seals_at).getTime() <= Date.now()) throw new Error("Heartbeat updates require an open ceremony");
      }
      const updateSha256 = operationalUpdateHash(envelope);
      const bytes = Buffer.from(canonicalize(envelope as unknown as JsonValue));
      if (this.options.production && !this.options.archive) throw new Error("Operational updates require immutable publication");
      let archivePin: { key: string; versionId: string; sha256: string } | null = null;
      if (this.options.archive) {
        const key = `evidence/${this.id}/operations/${value.sequence}/${updateSha256}.json`;
        const stored = await this.options.archive.publishBytes(key, bytes);
        if (!stored.versionId || stored.versionId === "null" || stored.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("Operational update archive pin mismatch");
        archivePin = { key, ...stored };
      }
      // Expire under the OLD deadline first: updates must never revive a timed-out slot.
      await expireParticipantLeases(db, this.id, this.baseline);
      if (value.heartbeatGraceSeconds !== undefined) {
        // Preserve a slot's high-water allowance; reductions affect new claims only.
        await db.query(`UPDATE leases SET heartbeat_grace_seconds=GREATEST(COALESCE(heartbeat_grace_seconds,$2),$3)
          WHERE ceremony_id=$1 AND state='ACTIVE'`, [this.id, this.baseline, value.heartbeatGraceSeconds]);
      }
      await db.query("INSERT INTO operational_updates(ceremony_id,sequence,update_sha256,envelope,archive_pin) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)",
        [this.id, value.sequence, updateSha256, JSON.stringify(envelope), JSON.stringify(archivePin)]);
      return { sequence: value.sequence, updateSha256 };
    });
  }

  async claim(leaseId: string, participantId: string, expiresAt: string): Promise<void> {
    await this.locked(async (db) => {
      const { updates } = await this.history(db);
      const result = await db.query(`UPDATE leases SET state='ACTIVE',claimed_at=now(),heartbeat_at=now(),expires_at=$4,heartbeat_grace_seconds=$5
        WHERE id=$1 AND ceremony_id=$2 AND participant_id=$3 AND state='OFFERED' AND expires_at>now()
          AND EXISTS (SELECT 1 FROM ceremonies WHERE id=$2 AND state='OPEN' AND seals_at>now()) RETURNING ticket_id`,
        [leaseId, this.id, participantId, expiresAt, this.grace(updates)]);
      if (!result.rows.length) throw new Error("lease is unavailable or expired");
      await db.query("UPDATE queue_tickets SET status='LEASED' WHERE id=$1 AND status='OFFERED'", [result.rows[0].ticket_id]);
    });
  }
}
