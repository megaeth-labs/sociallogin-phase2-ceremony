import { PRIMARY_PUBLICATION_DOMAIN } from "@moss/phase2-protocol";
import { publishAndWitness, type PublicationTarget } from "./publication.js";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  type KeyLike,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { Readable } from "node:stream";

import { PgCeremonyStore, type PgPoolLike } from "@moss/phase2-db";
import {
  CHECKPOINT_SIGNATURE_DOMAIN,
  RECEIPT_SIGNATURE_DOMAIN,
  TRANSCRIPT_EVENT_SIGNATURE_DOMAIN,
  assertCeremonyTransition,
  canonicalSha256,
  verifyRehearsalWebRelease,
  type RehearsalWebReleaseAuthorization,
  contributionGenesis,
  evaluateVerifierPolicy,
  signEnvelope,
  transcriptEventHash,
  type CeremonyManifestV1,
  type CeremonyState,
  type ContributionReceiptV1,
  type HeadCheckpointV1,
  type JsonValue,
  type SignedEnvelope,
  type TranscriptEventV1,
  type VerificationReportV1,
} from "@moss/phase2-protocol";
import {
  LocalArtifactStore,
  type ArtifactStore,
  type CanonicalArtifact,
  type QuarantineArtifact,
  type UploadGrant,
} from "@moss/phase2-storage";
import { Pool } from "pg";
import { OperationalUpdates, expireParticipantLeases } from "./operational-updates.js";
import { authorizedCliReleases, type OperationalUpdate } from "@moss/phase2-protocol";
import { heartbeatGraceSeconds } from "./heartbeat-policy.js";

import type {
  CoordinatorOperations,
  ParticipantCeremonyStateResponse,
} from "./api.js";
import type { ParticipantPrincipal } from "./auth.js";

interface RuntimeOptions {
  pool: Pool;
  manifestRootPublicKey?: string;
  store: ArtifactStore;
  manifestEnvelope: SignedEnvelope<CeremonyManifestV1>;
  coordinatorKeyId: string;
  coordinatorPrivateKey: KeyLike;
  publicBaseUrl: string;
  genesisZkeyPath: string;
  production: boolean;
  allowRehearsal?: boolean;
  publicationArchive?: PublicationTarget;
  webReleaseAuthorization?: { envelope: SignedEnvelope<RehearsalWebReleaseAuthorization>; rootPublicKey: string };
  /**
   * Permits seeding a ceremony row from genesis under NODE_ENV=production.
   * Required once, deliberately, when the epoch first opens; never afterwards,
   * so a coordinator restored against a blank database fails loudly instead of
   * restarting the ceremony.
   */
  allowCeremonyInitialization?: boolean;
  /**
   * Optional sink for faults that are deliberately swallowed so they cannot
   * halt the ceremony. Receives operational messages only — never environment
   * values, tokens, keys, entropy or artifact bytes, per AGENTS.md.
   */
  onRecoverableError?: (message: string, detail: string) => void;
}

type Row = Record<string, unknown>;
type StoredUploadGrant = UploadGrant & { backendUploadId?: string };

export class PostgresCoordinatorOperations implements CoordinatorOperations {
  private readonly manifest: CeremonyManifestV1;
  private readonly manifestSha256: string;
  private readonly database: PgCeremonyStore;
  private readonly authorizedBrowserReleases: string[];
  private readonly operationalUpdates?: OperationalUpdates;

  constructor(private readonly options: RuntimeOptions) {
    this.manifest = options.manifestEnvelope.payload;
    if (this.manifest.operationalPolicy && !options.manifestRootPublicKey) throw new Error("Operational policy requires the pinned manifest root");
    if (options.manifestRootPublicKey) this.operationalUpdates = new OperationalUpdates({
      pool: options.pool, manifest: options.manifestEnvelope, rootPublicKey: options.manifestRootPublicKey,
      allowRehearsal: options.allowRehearsal, archive: options.publicationArchive, production: options.production,
    });
    this.authorizedBrowserReleases = [this.manifest.webRelease.sha256];
    if (options.webReleaseAuthorization) {
      if (!options.allowRehearsal) throw new Error("web release authorization requires explicit rehearsal mode");
      const update = verifyRehearsalWebRelease(options.webReleaseAuthorization.envelope,
        options.manifestEnvelope, options.webReleaseAuthorization.rootPublicKey);
      this.authorizedBrowserReleases.push(update.release.sha256);
    }
    this.manifestSha256 = canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", this.manifest as unknown as JsonValue);
    this.database = new PgCeremonyStore(options.pool as unknown as PgPoolLike, {
      production: options.production,
      allowRehearsal: options.allowRehearsal,
      trustedManifest: this.manifest,
    });
  }

  async initialize(): Promise<void> {
    // Seeding is how a ceremony starts, and also what silently happens if a
    // coordinator is restored against a blank database: it would insert a fresh
    // row at generation 0 and begin again from genesis, discarding every
    // accepted contribution rather than refusing. ON CONFLICT DO NOTHING and
    // the manifest-hash check below only protect a populated database.
    //
    // In production, starting a ceremony is therefore a deliberate act.
    if (this.options.production && !this.options.allowCeremonyInitialization) {
      const existing = (await this.options.pool.query(
        "SELECT 1 FROM ceremonies WHERE id=$1", [this.manifest.ceremonyId],
      )).rowCount ?? 0;
      if (existing === 0) {
        throw new Error(
          "no ceremony row exists for the signed manifest; refusing to seed one from genesis in production without explicit initialization",
        );
      }
    }
    const genesis = await this.ensureGenesisArtifact();
    const state = Date.now() < Date.parse(this.manifest.schedule.opensAt) ? "PREPARED"
      : Date.now() >= Date.parse(this.manifest.schedule.sealsAt) ? "SEALED" : "OPEN";
    await this.options.pool.query(
      `INSERT INTO ceremonies
       (id,slug,state,manifest,manifest_sha256,verifier_policy,head_sha256,head_byte_length,
        event_hash,opens_at,seals_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [this.manifest.ceremonyId, this.manifest.slug, state, JSON.stringify(this.manifest),
        this.manifestSha256, JSON.stringify(this.manifest.verifierPolicy), genesis.sha256,
        genesis.byteLength, "0".repeat(64), this.manifest.schedule.opensAt, this.manifest.schedule.sealsAt],
    );
    const existing = requireRow((await this.options.pool.query(
      "SELECT slug, manifest_sha256, head_sha256 FROM ceremonies WHERE id = $1",
      [this.manifest.ceremonyId],
    )).rows[0], "ceremony initialization failed");
    if (existing.slug !== this.manifest.slug || existing.manifest_sha256 !== this.manifestSha256) {
      throw new Error("database ceremony does not match the signed manifest");
    }
    await this.options.pool.query(
      `INSERT INTO artifacts
       (sha256,ceremony_id,kind,byte_length,storage_backend,object_key,storage_version_id,
        immutable,generation,verified_at)
       VALUES ($1,$2,'GENESIS',$3,$4,$5,$6,true,0,now())
       ON CONFLICT (sha256) DO NOTHING`,
      [genesis.sha256, this.manifest.ceremonyId, genesis.byteLength, genesis.backend,
        genesis.objectKey, genesis.versionId],
    );
  }

  /** Periodic maintenance is independent of browser/participant polling. */
  async maintain(): Promise<void> {
    await this.syncSchedule();
    await this.expireLeases();
    await this.recoverVerifiedSubmission();
    if (this.options.production) await this.publishHead();
    await this.offerNext();
  }

  private async publishHead(): Promise<void> {
    const archive = this.options.publicationArchive;
    if (!archive || (!this.manifest.publication && !this.manifest.primaryPublication)) throw new Error("hosted publication is not configured");
    const head = await this.ceremonyRow();
    const sequence = number(head.event_sequence);
    const existing = await this.options.pool.query(
      "SELECT 1 FROM ceremony_publications WHERE ceremony_id=$1 AND event_sequence=$2 AND event_hash=$3",
      [this.manifest.ceremonyId, sequence, head.event_hash]);
    if (existing.rows.length) return;
    const receiptRows = await this.options.pool.query<Row>(
      "SELECT receipt,receipt_signature,submission_id FROM contributions WHERE ceremony_id=$1 AND generation=$2",
      [this.manifest.ceremonyId, number(head.head_generation)]);
    const eventRows = await this.options.pool.query<Row>(
      "SELECT * FROM transcript_events WHERE ceremony_id=$1 AND sequence=$2", [this.manifest.ceremonyId, sequence]);
    const receipt = receiptRows.rows[0];
    const event = eventRows.rows[0];
    if (sequence > 0 && (!receipt || !event)) throw new Error("publication evidence is incomplete");
    const reports = receipt ? await this.options.pool.query<Row>(
      "SELECT payload,signature,operator_key_id FROM verification_reports WHERE ceremony_id=$1 AND submission_id=$2 ORDER BY operator_key_id,pass_number,job_attempt,job_id",
      [this.manifest.ceremonyId, receipt.submission_id]) : { rows: [] };
    const envelope = (payload: unknown, signature: unknown, keyId = this.options.coordinatorKeyId) =>
      ({ schemaVersion: 1, keyId, payload, signature });
    const bundle = {
      type: "moss.phase2.publication.v1", manifest: this.options.manifestEnvelope,
      head: { generation: number(head.head_generation), sha256: head.head_sha256,
        byteLength: number(head.head_byte_length), eventSequence: sequence, eventHash: head.event_hash },
      receipt: receipt ? envelope(receipt.receipt, receipt.receipt_signature) : null,
      event: event ? envelope({ schemaVersion: 1,
        ceremonyId: this.manifest.ceremonyId, sequence, previousEventHash: event.previous_event_hash,
        eventType: event.event_type, payload: event.payload, createdAt: isoDate(event.created_at) }, event.signature) : null,
      reports: reports.rows.map((row) => envelope(row.payload, row.signature, string(row.operator_key_id))),
    } as unknown as JsonValue;
    const published = await publishAndWitness({ manifest: this.manifest, bundle,
      eventSequence: sequence, eventHash: string(head.event_hash), archive, signPrimary: record => this.sign(record, PRIMARY_PUBLICATION_DOMAIN) });
    const client = await this.options.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ceremony_publications (ceremony_id,event_sequence,event_hash,bundle_sha256,acknowledgement)
         VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (ceremony_id,event_sequence) DO NOTHING`,
        [this.manifest.ceremonyId, sequence, head.event_hash, published.sha256, JSON.stringify(published.acknowledgement)]);
      await client.query(
        `UPDATE outbox SET published_at=now() WHERE published_at IS NULL AND topic='contribution.accepted'
         AND payload->'receipt'->>'ceremonyId'=$1 AND (payload->'receipt'->>'sequence')::bigint=$2`,
        [this.manifest.ceremonyId, sequence]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async getOperationalUpdates(slug: string) {
    this.assertSlug(slug);
    return this.operationalUpdates ? this.operationalUpdates.history() : { updates: [], appliedAt: [] };
  }
  async applyOperationalUpdate(slug: string, update: SignedEnvelope<OperationalUpdate>) {
    this.assertSlug(slug);
    if (!this.operationalUpdates) throw new Error("Operational updates are not configured");
    return this.operationalUpdates.apply(update);
  }

  async getWebReleaseAuthorization(slug: string) { this.assertSlug(slug); return this.options.webReleaseAuthorization?.envelope ?? null; }

  async getManifest(slug: string) { this.assertSlug(slug); return this.options.manifestEnvelope; }

  async getCheckpoint(slug: string): Promise<SignedEnvelope<HeadCheckpointV1>> {
    this.assertSlug(slug);
    const row = await this.syncSchedule();
    const issuedAt = new Date();
    const payload: HeadCheckpointV1 = {
      schemaVersion: 1, type: "moss.phase2.checkpoint.v1", ceremonyId: this.manifest.ceremonyId,
      state: row.state as HeadCheckpointV1["state"], revision: number(row.revision),
      generation: number(row.head_generation), headSha256: string(row.head_sha256),
      headByteLength: number(row.head_byte_length), eventSequence: number(row.event_sequence),
      eventHash: string(row.event_hash), issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
    };
    return this.sign(payload, CHECKPOINT_SIGNATURE_DOMAIN);
  }

  async getStatus(slug: string) {
    this.assertSlug(slug);
    const row = await this.syncSchedule();
    const queue = await this.options.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM queue_tickets WHERE ceremony_id=$1 AND status='QUEUED'",
      [this.manifest.ceremonyId],
    );
    const sha256 = string(row.head_sha256);
    return {
      ceremonyId: this.manifest.ceremonyId, state: string(row.state), generation: number(row.head_generation),
      head: { sha256, byteLength: number(row.head_byte_length), downloadUrl: await this.publicArtifactUrl(sha256) },
      queueDepth: Number(queue.rows[0]?.count ?? 0), manifestSha256: this.manifestSha256,
    };
  }

  async getCanonicalArtifactRedirect(slug: string, sha256: string): Promise<string | null> {
    this.assertSlug(slug);
    return this.manifest.primaryPublication ? await this.publicArtifactUrl(sha256) : null;
  }

  async openCanonicalArtifact(
    slug: string,
    sha256: string,
    range?: { start: number; endInclusive?: number },
  ): Promise<{
    stream: Readable;
    byteLength: number;
    totalByteLength: number;
    start: number;
    endInclusive: number;
  }> {
    this.assertSlug(slug);
    const pinned = await this.canonicalArtifact(sha256);
    const artifact = await this.options.store.statCanonical(pinned);
    if (!artifact || !this.options.store.openCanonical) throw new Error("canonical artifact not found");
    const start = range?.start ?? 0;
    const endInclusive = Math.min(
      range?.endInclusive ?? artifact.byteLength - 1,
      artifact.byteLength - 1,
    );
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(endInclusive) ||
      start < 0 ||
      start >= artifact.byteLength ||
      endInclusive < start
    ) {
      throw new Error("artifact range is not satisfiable");
    }
    return {
      stream: await this.options.store.openCanonical(
        artifact,
        { start, endInclusive },
      ),
      byteLength: endInclusive - start + 1,
      totalByteLength: artifact.byteLength,
      start,
      endInclusive,
    };
  }

  async joinQueue(slug: string, principal: ParticipantPrincipal, idempotencyKey: string): Promise<unknown> {
    this.assertSlug(slug);
    await this.assertCeremonyOpen();
    await this.expireLeases();
    await this.database.joinQueue({
      ticketId: randomUUID(), ceremonyId: this.manifest.ceremonyId, participantId: principal.participantId,
      authSubjectHash: principal.authSubjectHash, publicPseudonym: principal.pseudonym, idempotencyKey,
    });
    await this.offerNext();
    return await this.queueView(principal.participantId);
  }

  async getMyQueue(slug: string, participantId: string): Promise<unknown> {
    this.assertSlug(slug);
    await this.offerNext();
    return await this.queueView(participantId);
  }

  async getParticipantState(
    slug: string,
    participantId: string,
  ): Promise<ParticipantCeremonyStateResponse> {
    this.assertSlug(slug);
    await this.syncSchedule();
    let row = await this.participantStateRow(participantId);
    if (row?.submission_state === "VERIFYING") {
      await this.tryAccept(string(row.submission_id));
      row = await this.participantStateRow(participantId);
    }
    if (!row) {
      return {
        ceremonyId: this.manifest.ceremonyId,
        participantId,
        queue: null,
        lease: null,
        submission: null,
      };
    }
    const position = row.ticket_status === "QUEUED"
      ? Number((await this.options.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM queue_tickets
         WHERE ceremony_id=$1 AND status='QUEUED' AND (enqueued_at,id)<=($2,$3)`,
        [this.manifest.ceremonyId, row.ticket_enqueued_at, row.ticket_id],
      )).rows[0]?.count ?? 0)
      : 0;
    const offer = row.lease_id ? {
      leaseId: string(row.lease_id),
      expiresAt: isoDate(row.lease_expires_at),
      baseGeneration: number(row.base_generation),
      expectedContributionName: string(row.expected_contribution_name),
      predecessor: {
        sha256: string(row.predecessor_sha256),
        byteLength: number(row.predecessor_byte_length),
        downloadUrl: await this.publicArtifactUrl(string(row.predecessor_sha256)),
      },
    } : null;
    const submission = row.submission_id ? {
      submissionId: string(row.submission_id),
      state: string(row.submission_state),
      ...(row.receipt_id ? { receiptId: string(row.receipt_id) } : {}),
    } : null;
    const queueIsActive = ["QUEUED", "OFFERED", "LEASED"].includes(
      string(row.ticket_status),
    );
    return {
      ceremonyId: this.manifest.ceremonyId,
      participantId,
      queue: queueIsActive ? {
        ticketId: string(row.ticket_id),
        status: string(row.ticket_status),
        position,
        offer,
      } : null,
      lease: offer ? {
        ...offer,
        state: string(row.lease_state),
        ...(submission ? { submissionId: submission.submissionId } : {}),
      } : null,
      submission,
    };
  }

  async cancelMyQueue(slug: string, participantId: string): Promise<void> {
    this.assertSlug(slug);
    await this.database.cancelParticipantAttempt({ ceremonyId: this.manifest.ceremonyId, participantId });
    await this.offerNext();
  }

  async claimOffer(leaseId: string, participantId: string): Promise<unknown> {
    await this.assertCeremonyOpen();
    await this.expireLeases();
    const expiresAt = new Date(Date.now() + this.manifest.contributionPolicy.lease.absoluteSeconds * 1_000).toISOString();
    if (this.operationalUpdates) await this.operationalUpdates.claim(leaseId, participantId, expiresAt);
    else await this.database.claimLease({ leaseId, participantId, expiresAt });
    return await this.leaseView(leaseId, participantId);
  }

  async getLease(leaseId: string, participantId: string): Promise<unknown> {
    return await this.leaseView(leaseId, participantId);
  }

  async heartbeat(leaseId: string, participantId: string): Promise<void> {
    await this.expireLeases();
    await this.database.heartbeat({ leaseId, participantId });
  }

  async createUpload(leaseId: string, participantId: string): Promise<UploadGrant> {
    await this.assertCeremonyOpen();
    await this.expireLeases();
    const existing = await this.options.pool.query<{ id: string; store_grant: StoredUploadGrant }>(
      "SELECT id,store_grant FROM artifact_uploads WHERE lease_id=$1 AND participant_id=$2 AND state IN ('INITIATED','UPLOADING','COMPLETED')",
      [leaseId, participantId],
    );
    if (existing.rows[0]) {
      return publicUploadGrant(existing.rows[0].id, existing.rows[0].store_grant);
    }
    const lease = requireRow((await this.options.pool.query<Row>(
      "SELECT ceremony_id,expires_at FROM leases WHERE id=$1 AND participant_id=$2 AND state='ACTIVE' AND expires_at>now()",
      [leaseId, participantId],
    )).rows[0], "active lease not found");
    const uploadId = randomUUID();
    const backendGrant = await this.options.store.createUpload({
      ceremonyId: string(lease.ceremony_id), leaseId, uploadId,
      expiresAt: new Date(lease.expires_at as string | Date).toISOString(),
      maxByteLength: this.manifest.contributionPolicy.maxArtifactByteLength,
    });
    const grant = persistedUploadGrant(uploadId, backendGrant);
    await this.options.pool.query(
      `INSERT INTO artifact_uploads
       (id,ceremony_id,lease_id,participant_id,state,store_grant,max_byte_length,expires_at)
       VALUES ($1,$2,$3,$4,'INITIATED',$5::jsonb,$6,$7)`,
      [uploadId, lease.ceremony_id, leaseId, participantId, JSON.stringify(grant),
        this.manifest.contributionPolicy.maxArtifactByteLength, grant.expiresAt],
    );
    return publicUploadGrant(uploadId, grant);
  }

  async getUpload(uploadId: string, participantId: string): Promise<{
    uploadId: string;
    state: string;
    expiresAt: string;
    artifact?: { sha256: string; byteLength: number };
  }> {
    const row = requireRow((await this.options.pool.query<Row>(
      `SELECT id,state,expires_at,artifact FROM artifact_uploads
       WHERE id=$1 AND participant_id=$2`,
      [uploadId, participantId],
    )).rows[0], "upload not found");
    const artifact = row.artifact as QuarantineArtifact | null | undefined;
    if ((row.state === "UPLOADING" || row.state === "COMPLETED") && !artifact) {
      throw new Error("upload state is missing its artifact binding");
    }
    return {
      uploadId: string(row.id),
      state: string(row.state),
      expiresAt: isoDate(row.expires_at),
      ...(artifact ? {
        artifact: {
          sha256: artifact.sha256,
          byteLength: artifact.byteLength,
        },
      } : {}),
    };
  }

  async createUploadParts(uploadId: string, participantId: string, partNumbers: number[]): Promise<unknown> {
    const upload = await this.uploadRow(uploadId, participantId);
    if (upload.state !== "INITIATED") throw new Error("local upload content has already been supplied");
    if (!this.options.store.createUploadParts) throw new Error("artifact backend does not support multipart uploads");
    return { parts: await this.options.store.createUploadParts({ grant: upload.store_grant as UploadGrant, partNumbers }) };
  }

  async ingestLocalUpload(uploadId: string, participantId: string, body: Readable): Promise<unknown> {
    const upload = await this.uploadRow(uploadId, participantId);
    // Same guard createUploadParts has. Without it a repeated PUT streamed and
    // hashed the entire artifact — hundreds of megabytes — before failing on
    // the link, which an authenticated lease holder could repeat freely.
    if (upload.state !== "INITIATED") throw new Error("local upload content has already been supplied");
    if (!this.options.store.ingestLocalUpload) throw new Error("artifact backend does not support coordinator-proxied uploads");
    const artifact = await this.options.store.ingestLocalUpload({
      grant: upload.store_grant as UploadGrant, body, maxByteLength: number(upload.max_byte_length),
    });
    await this.options.pool.query(
      "UPDATE artifact_uploads SET state='UPLOADING', artifact=$2::jsonb WHERE id=$1 AND state='INITIATED'",
      [uploadId, JSON.stringify(artifact)],
    );
    return { uploadId, state: "UPLOADING", byteLength: artifact.byteLength, sha256: artifact.sha256 };
  }

  async completeUpload(uploadId: string, participantId: string, input: {
    sha256: string; byteLength: number; parts?: Array<{ partNumber: number; etag: string }>;
  }): Promise<unknown> {
    const upload = await this.uploadRow(uploadId, participantId);
    const artifact = await this.options.store.completeUpload({
      grant: upload.store_grant as UploadGrant, expectedSha256: input.sha256,
      expectedByteLength: input.byteLength, multipartParts: input.parts,
    });
    await this.options.pool.query(
      `UPDATE artifact_uploads SET state='COMPLETED',artifact=$2::jsonb,completed_at=now()
       WHERE id=$1 AND participant_id=$3 AND state IN ('INITIATED','UPLOADING')`,
      [uploadId, JSON.stringify(artifact), participantId],
    );
    return { uploadId, state: "COMPLETED", artifact: { sha256: artifact.sha256, byteLength: artifact.byteLength } };
  }

  async submit(leaseId: string, participantId: string, input: {
    uploadId: string; predecessorSha256: string; contributionHashBlake2b512: string;
    clientKind: "browser" | "cli" | "other"; clientReleaseSha256?: string;
  }, _idempotencyKey: string): Promise<unknown> {
    await this.assertCeremonyOpen();
    await this.expireLeases();
    // For the CLI this is meaningful: an honest build hashes its own bundle at
    // run time. For the browser it cannot be — the page echoes the manifest's
    // own webRelease value, so this comparison always passes for a browser
    // client and proves nothing about the code that ran. The web release is
    // verified out of band against its published asset manifest instead.
    if (this.manifest.contributionPolicy.requirePinnedClientRelease) {
      const allowed = input.clientKind === "browser"
        ? [...this.authorizedBrowserReleases, ...(await this.getOperationalUpdates(this.manifest.slug)).updates.flatMap((update) => update.payload.webRelease ? [update.payload.webRelease.sha256] : [])]
        : input.clientKind === "cli"
          ? authorizedCliReleases(this.manifest, (await this.getOperationalUpdates(this.manifest.slug)).updates).map((release) => release.sha256)
          : [];
      if (!input.clientReleaseSha256 || !allowed.includes(input.clientReleaseSha256)) {
        throw new Error("submission client release is not permitted by the signed manifest");
      }
    }
    const existing = await this.options.pool.query<Row>(
      "SELECT id,state,predecessor_sha256,claimed_contribution_hash FROM submissions WHERE lease_id=$1 AND participant_id=$2",
      [leaseId, participantId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].predecessor_sha256 !== input.predecessorSha256
        || existing.rows[0].claimed_contribution_hash !== input.contributionHashBlake2b512) throw new Error("lease already has a different submission");
      return this.submissionResponse(existing.rows[0]);
    }
    const upload = requireRow((await this.options.pool.query<Row>(
      `SELECT u.*,l.ceremony_id,l.predecessor_sha256 AS lease_predecessor
       FROM artifact_uploads u JOIN leases l ON l.id=u.lease_id
       WHERE u.id=$1 AND u.lease_id=$2 AND u.participant_id=$3 AND u.state='COMPLETED'`,
      [input.uploadId, leaseId, participantId],
    )).rows[0], "completed lease upload not found");
    if (upload.lease_predecessor !== input.predecessorSha256) throw new Error("submission predecessor does not match the lease");
    const artifact = upload.artifact as QuarantineArtifact;
    const submission = await this.database.createSubmission({
      id: randomUUID(), ceremonyId: string(upload.ceremony_id), leaseId, participantId,
      predecessorSha256: input.predecessorSha256, candidateSha256: artifact.sha256,
      candidateByteLength: artifact.byteLength, quarantineObjectKey: artifact.objectKey,
      quarantineVersionId: artifact.versionId, claimedContributionHash: input.contributionHashBlake2b512,
      clientKind: input.clientKind, clientReleaseSha256: input.clientReleaseSha256,
    });
    return this.submissionResponse(submission as unknown as Row);
  }

  async getSubmission(submissionId: string, participantId: string): Promise<unknown> {
    let row = requireRow((await this.options.pool.query<Row>(
      `SELECT s.id,s.state,c.submission_id AS receipt_id
       FROM submissions s LEFT JOIN contributions c ON c.submission_id=s.id
       WHERE s.id=$1 AND s.participant_id=$2`,
      [submissionId, participantId],
    )).rows[0], "submission not found");
    if (row.state === "VERIFYING") {
      await this.tryAccept(submissionId);
      row = requireRow((await this.options.pool.query<Row>(
        `SELECT s.id,s.state,c.submission_id AS receipt_id
         FROM submissions s LEFT JOIN contributions c ON c.submission_id=s.id
         WHERE s.id=$1 AND s.participant_id=$2`,
        [submissionId, participantId],
      )).rows[0], "submission not found");
    }
    return this.submissionResponse(row);
  }

  async getReceipt(receiptId: string, participantId: string): Promise<SignedEnvelope<ContributionReceiptV1>> {
    const row = requireRow((await this.options.pool.query<Row>(
      `SELECT c.receipt,c.receipt_signature FROM contributions c
       JOIN submissions s ON s.id=c.submission_id WHERE c.submission_id=$1 AND s.participant_id=$2`,
      [receiptId, participantId],
    )).rows[0], "receipt not found");
    return { schemaVersion: 1, keyId: this.options.coordinatorKeyId,
      payload: row.receipt as ContributionReceiptV1, signature: string(row.receipt_signature) };
  }

  async listPublications(slug: string, after: number): Promise<unknown[]> {
    this.assertSlug(slug);
    if (!Number.isSafeInteger(after) || after < -1) throw new Error("invalid publication cursor");
    const rows = await this.options.pool.query<{ acknowledgement: unknown }>(
      "SELECT acknowledgement FROM ceremony_publications WHERE ceremony_id=$1 AND event_sequence>$2 ORDER BY event_sequence ASC LIMIT 50",
      [this.manifest.ceremonyId, after]);
    return rows.rows.map((row) => row.acknowledgement);
  }

  async listContributions(slug: string, after: number, limit = 50): Promise<Array<SignedEnvelope<ContributionReceiptV1>>> {
    this.assertSlug(slug);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid contribution cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid contribution page size");
    // Only immutable accepted receipts are public. Do not expose participant
    // IDs, auth subject hashes, pending submissions, or upload capabilities.
    const result = await this.options.pool.query<Row>(
      `SELECT receipt,receipt_signature FROM contributions
       WHERE ceremony_id=$1 AND generation>$2 ORDER BY generation ASC LIMIT $3`,
      [this.manifest.ceremonyId, after, limit],
    );
    return result.rows.map((row) => ({ schemaVersion: 1, keyId: this.options.coordinatorKeyId,
      payload: row.receipt as ContributionReceiptV1, signature: string(row.receipt_signature) }));
  }

  async claimVerifierJob(operatorKeyId: string): Promise<unknown | null> {
    if (!this.manifest.verifierPolicy.operatorKeyIds.includes(operatorKeyId)) throw new Error("verifier operator is not authorized");
    if ((await this.syncSchedule()).state !== "OPEN") return null;
    await this.expireVerifierJobsAndRejectImpossible();
    // Recovery is opportunistic and must never gate job claiming. If accepting
    // a previously verified submission fails — a storage fault during
    // promotion, say — letting that propagate would make this endpoint fail
    // for every operator on every poll, so a single stuck submission would halt
    // the whole ceremony rather than just itself.
    try {
      await this.recoverVerifiedSubmission();
    } catch (error) {
      this.options.onRecoverableError?.(
        "verified submission recovery failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    const client = await this.options.pool.connect();
    let committedJobId: string | undefined;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE verification_jobs SET state='EXPIRED' WHERE state='CLAIMED' AND lease_until<=now()");
      const candidate = (await client.query<Row>(
        `SELECT s.*,l.expected_contribution_name,l.base_generation
         FROM submissions s JOIN leases l ON l.id=s.lease_id
         WHERE s.ceremony_id=$1 AND s.state IN ('SUBMITTED','VERIFYING')
           AND (SELECT count(DISTINCT r.pass_number) FROM verification_reports r
                WHERE r.submission_id=s.id AND r.operator_key_id=$2 AND r.result='valid') < $3
           AND NOT EXISTS (SELECT 1 FROM verification_jobs j WHERE j.submission_id=s.id AND j.operator_key_id=$2 AND j.state='CLAIMED' AND j.lease_until>now())
           AND coalesce((SELECT max(j.attempt) FROM verification_jobs j WHERE j.submission_id=s.id AND j.operator_key_id=$2),0) < $4
         ORDER BY s.submitted_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT 1`,
        [this.manifest.ceremonyId, operatorKeyId, this.manifest.verifierPolicy.passesPerOperator,
          this.manifest.contributionPolicy.verifierMaxAttempts],
      )).rows[0];
      if (!candidate) { await client.query("COMMIT"); return null; }
      const jobId = randomUUID();
      const claimed = requireRow((await client.query<{
        attempt: number;
        lease_until: string | Date;
      }>(
        `INSERT INTO verification_jobs(job_id,submission_id,operator_key_id,state,attempt,lease_until)
         VALUES ($1,$2,$3,'CLAIMED',1,now()+($4 * interval '1 second'))
         ON CONFLICT (submission_id,operator_key_id) DO UPDATE
         SET job_id=EXCLUDED.job_id,state='CLAIMED',attempt=verification_jobs.attempt+1,
             claimed_at=now(),lease_until=EXCLUDED.lease_until,reported_at=NULL
         WHERE verification_jobs.state='EXPIRED'
         RETURNING attempt,lease_until`,
        [jobId, candidate.id, operatorKeyId, this.manifest.contributionPolicy.verifierJobSeconds],
      )).rows[0], "verifier job claim lost a concurrent race");
      await client.query("UPDATE submissions SET state='VERIFYING' WHERE id=$1 AND state='SUBMITTED'", [candidate.id]);
      await client.query("UPDATE leases SET state='VERIFYING' WHERE id=$1 AND state='SUBMITTED'", [candidate.lease_id]);
      await client.query("COMMIT");
      committedJobId = jobId;
      const quarantine: QuarantineArtifact = {
        backend: this.options.store instanceof LocalArtifactStore ? "local" : "s3",
        objectKey: string(candidate.quarantine_object_key), versionId: string(candidate.quarantine_version_id),
        sha256: string(candidate.candidate_sha256), byteLength: number(candidate.candidate_byte_length),
      };
      if (!this.options.store.quarantineDownloadUrl) throw new Error("artifact backend cannot issue verifier download URLs");
      const candidateUrl = await this.options.store.quarantineDownloadUrl(
        quarantine,
        Math.min(3600, this.manifest.contributionPolicy.verifierJobSeconds),
      );
      const predecessorSha256 = string(candidate.predecessor_sha256);
      const predecessor = await this.canonicalArtifact(predecessorSha256);
      const availablePredecessor = await this.options.store.statCanonical(predecessor);
      if (!availablePredecessor) throw new Error("canonical predecessor version is unavailable");
      const predecessorUrl = await this.options.store.downloadUrl(
        availablePredecessor,
        Math.min(3600, this.manifest.contributionPolicy.verifierJobSeconds),
      );
      return {
        schemaVersion: 1, type: "moss.phase2.verification-job.v1", jobId,
        attempt: number(claimed.attempt),
        leaseExpiresAt: isoDate(claimed.lease_until),
        ceremonyId: this.manifest.ceremonyId, submissionId: string(candidate.id),
        predecessor: {
          sha256: predecessorSha256,
          byteLength: availablePredecessor.byteLength,
          urls: [predecessorUrl], downloadUrl: predecessorUrl,
        },
        candidate: { sha256: quarantine.sha256, byteLength: quarantine.byteLength, urls: [candidateUrl], downloadUrl: candidateUrl },
        genesisSha256: contributionGenesis(this.manifest).sha256,
        ptauSha256: this.manifest.relation.ptau.sha256,
        expectedContributionName: string(candidate.expected_contribution_name),
        expectedContributionHashBlake2b512: string(candidate.claimed_contribution_hash),
        maxPredecessorContributions: number(candidate.base_generation),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (committedJobId) {
        await this.options.pool.query(
          "UPDATE verification_jobs SET state='EXPIRED' WHERE job_id=$1 AND state='CLAIMED'",
          [committedJobId],
        ).catch(() => undefined);
      }
      throw error;
    } finally { client.release(); }
  }

  async heartbeatVerifierJob(
    jobId: string,
    operatorKeyId: string,
  ): Promise<{ leaseExpiresAt: string }> {
    if (!this.manifest.verifierPolicy.operatorKeyIds.includes(operatorKeyId)) {
      throw new Error("verifier operator is not authorized");
    }
    const row = requireRow((await this.options.pool.query<{ lease_until: string | Date }>(
      `UPDATE verification_jobs j
       SET lease_until=clock_timestamp()+($3 * interval '1 second')
       FROM submissions s,ceremonies c
       WHERE j.job_id=$1 AND j.operator_key_id=$2 AND j.state='CLAIMED'
         AND j.lease_until>clock_timestamp()
         AND s.id=j.submission_id AND c.id=s.ceremony_id
         AND c.id=$4 AND c.state='OPEN' AND clock_timestamp()<c.seals_at
       RETURNING j.lease_until`,
      [jobId, operatorKeyId, this.manifest.contributionPolicy.verifierJobSeconds,
        this.manifest.ceremonyId],
    )).rows[0], "verifier job lease is unavailable or expired");
    return { leaseExpiresAt: isoDate(row.lease_until) };
  }

  async recordVerifierReport(envelope: SignedEnvelope<VerificationReportV1>): Promise<void> {
    await this.database.recordVerificationReport({ id: randomUUID(), report: envelope.payload, signature: envelope.signature });
    const persisted = requireRow((await this.options.pool.query<{ result: VerificationReportV1["result"] }>(
      `SELECT result FROM verification_reports
       WHERE submission_id=$1 AND operator_key_id=$2 AND pass_number=$3
         AND job_id=$4 AND job_attempt=$5`,
      [envelope.payload.submissionId, envelope.payload.operatorKeyId, envelope.payload.passNumber,
        envelope.payload.jobId, envelope.payload.jobAttempt],
    )).rows[0], "persisted verification report not found");
    if (persisted.result === "invalid") {
      await this.rejectSubmission(envelope.payload.submissionId);
      return;
    }
    const progress = requireRow((await this.options.pool.query<{
      valid_count: string;
      current_attempt_count: string;
    }>(
      `SELECT count(DISTINCT pass_number) FILTER (WHERE result='valid')::text AS valid_count,
              count(*) FILTER (WHERE job_id=$3 AND job_attempt=$4)::text AS current_attempt_count
       FROM verification_reports
       WHERE submission_id=$1 AND operator_key_id=$2`,
      [envelope.payload.submissionId, envelope.payload.operatorKeyId,
        envelope.payload.jobId, envelope.payload.jobAttempt],
    )).rows[0], "verification progress query failed");
    if (persisted.result === "error") {
      if (Number(progress.current_attempt_count) >= this.manifest.verifierPolicy.passesPerOperator) {
        if (envelope.payload.jobAttempt >= this.manifest.contributionPolicy.verifierMaxAttempts) {
          await this.rejectSubmission(envelope.payload.submissionId);
        } else {
          await this.options.pool.query(
            `UPDATE verification_jobs SET state='EXPIRED'
             WHERE job_id=$1 AND operator_key_id=$2 AND attempt=$3 AND state='CLAIMED'`,
            [envelope.payload.jobId, envelope.payload.operatorKeyId,
              envelope.payload.jobAttempt],
          );
        }
      }
      return;
    }
    if (Number(progress.valid_count) >= this.manifest.verifierPolicy.passesPerOperator) {
      await this.options.pool.query(
        `UPDATE verification_jobs SET state='REPORTED',reported_at=now()
         WHERE job_id=$1 AND operator_key_id=$2 AND attempt=$3 AND state='CLAIMED'`,
        [envelope.payload.jobId, envelope.payload.operatorKeyId,
          envelope.payload.jobAttempt],
      );
    }
    await this.tryAccept(envelope.payload.submissionId);
  }

  private async tryAccept(submissionId: string): Promise<void> {
    if ((await this.syncSchedule()).state !== "OPEN") {
      await this.rejectSubmission(submissionId);
      return;
    }
    const reports = await this.options.pool.query<{ payload: VerificationReportV1 }>(
      "SELECT payload FROM verification_reports WHERE submission_id=$1", [submissionId],
    );
    if (!evaluateVerifierPolicy(this.manifest.verifierPolicy, reports.rows.map((row) => row.payload)).satisfied) return;
    const row = (await this.options.pool.query<Row>(
      `SELECT s.*,l.expected_contribution_name,l.base_generation,p.public_pseudonym,
              c.head_generation,c.head_sha256,c.head_byte_length,c.event_sequence,c.event_hash
       FROM submissions s JOIN leases l ON l.id=s.lease_id JOIN participants p ON p.id=s.participant_id
       JOIN ceremonies c ON c.id=s.ceremony_id WHERE s.id=$1 AND s.state='VERIFYING'`, [submissionId],
    )).rows[0];
    // Acceptance is replayed from verifier polling and participant polling.
    // A concurrent replay may already have completed the transition.
    if (!row) return;
    const quarantine: QuarantineArtifact = {
      backend: this.options.store instanceof LocalArtifactStore ? "local" : "s3",
      objectKey: string(row.quarantine_object_key), versionId: string(row.quarantine_version_id),
      sha256: string(row.candidate_sha256), byteLength: number(row.candidate_byte_length),
    };
    const generation = number(row.head_generation) + 1;
    const canonical = await this.options.store.promoteImmutable({ ceremonyId: this.manifest.ceremonyId, generation, quarantine });
    const createdAt = new Date().toISOString();
    const event: TranscriptEventV1 = {
      schemaVersion: 1, ceremonyId: this.manifest.ceremonyId, sequence: number(row.event_sequence) + 1,
      previousEventHash: string(row.event_hash), eventType: "CONTRIBUTION_ACCEPTED",
      payload: {
        submissionId, generation, predecessorSha256: string(row.predecessor_sha256),
        successorSha256: canonical.sha256, contributionHashBlake2b512: string(row.claimed_contribution_hash),
        contributionName: string(row.expected_contribution_name),
        clientKind: string(row.client_kind),
        clientReleaseSha256: row.client_release_sha256 == null ? null : string(row.client_release_sha256),
      },
      createdAt,
    };
    const eventHash = transcriptEventHash(event);
    const receipt: ContributionReceiptV1 = {
      schemaVersion: 1, type: "moss.phase2.receipt.v1", ceremonyId: this.manifest.ceremonyId,
      relationManifestSha256: this.manifestSha256, sequence: event.sequence, generation,
      predecessor: {
        sha256: string(row.predecessor_sha256), byteLength: number(row.head_byte_length),
        urls: [await this.publicArtifactUrl(string(row.predecessor_sha256))],
      },
      successor: { sha256: canonical.sha256, byteLength: canonical.byteLength, urls: [await this.publicArtifactUrl(canonical.sha256, canonical)] },
      contributionIndex: generation, contributionName: string(row.expected_contribution_name),
      contributionHashBlake2b512: string(row.claimed_contribution_hash),
      participantPseudonym: string(row.public_pseudonym),
      clientKind: string(row.client_kind) as ContributionReceiptV1["clientKind"],
      clientReleaseSha256: row.client_release_sha256 == null ? null : string(row.client_release_sha256),
      acceptedAt: createdAt, transcriptEventHash: eventHash,
    };
    const eventEnvelope = this.sign(event, TRANSCRIPT_EVENT_SIGNATURE_DOMAIN);
    const receiptEnvelope = this.sign(receipt, RECEIPT_SIGNATURE_DOMAIN);
    try {
      await this.database.acceptVerifiedSubmission({
        ceremonyId: this.manifest.ceremonyId, submissionId,
        canonicalArtifact: { sha256: canonical.sha256, byteLength: canonical.byteLength,
          storageBackend: canonical.backend, objectKey: canonical.objectKey, storageVersionId: canonical.versionId },
        contributionHash: receipt.contributionHashBlake2b512, contributionName: receipt.contributionName,
        acceptedAt: createdAt, event, eventHash, eventSignature: eventEnvelope.signature,
        receipt, receiptSignature: receiptEnvelope.signature, outboxId: randomUUID(),
      });
    } catch (error) {
      // tryAccept is reachable from a verifier report, two participant polls
      // and recovery, and holds no row lock across promoteImmutable — a full
      // copy of the head, so the race window is wide. Losing it means another
      // caller already accepted this exact submission. A second application is
      // impossible regardless: the head compare-and-swap, the unique
      // constraints on lease_id and submission_id, and content-addressed
      // promotion each independently forbid it.
      //
      // Confirm that is what happened rather than surfacing a failure. Without
      // this, a verifier posting its final valid report while the participant
      // polls gets a 4xx for a report that was durably committed, and backs
      // off logging a cycle failure — spurious noise on the happy path, and
      // indistinguishable from a real fault during an incident.
      const settled = await this.options.pool.query<Row>(
        "SELECT state FROM submissions WHERE id=$1",
        [submissionId],
      );
      if (settled.rows[0]?.state !== "ACCEPTED") throw error;
      return;
    }
    await this.offerNext();
  }

  private async rejectSubmission(submissionId: string): Promise<void> {
    await this.options.pool.query(
      `WITH rejected AS (
         UPDATE submissions SET state='REJECTED',updated_at=now() WHERE id=$1 AND state IN ('SUBMITTED','VERIFYING') RETURNING lease_id
       ), leases_rejected AS (
         UPDATE leases SET state='REJECTED' WHERE id IN (SELECT lease_id FROM rejected) RETURNING ticket_id
       ) UPDATE queue_tickets SET status='EXPIRED' WHERE id IN (SELECT ticket_id FROM leases_rejected)`,
      [submissionId],
    );
    await this.offerNext();
  }

  /**
   * Replay the idempotent external-promotion/CAS step after a crash between a
   * durable final verifier report and canonical-head acceptance. There can be
   * at most one live submission per ceremony, so this is deliberately bounded.
   */
  private async recoverVerifiedSubmission(): Promise<void> {
    const row = (await this.options.pool.query<{ id: string }>(
      `SELECT id FROM submissions
       WHERE ceremony_id=$1 AND state='VERIFYING'
       ORDER BY submitted_at,id LIMIT 1`,
      [this.manifest.ceremonyId],
    )).rows[0];
    if (row) await this.tryAccept(row.id);
  }

  private async ensureGenesisArtifact() {
    const expected = contributionGenesis(this.manifest);
    const existing = await this.options.store.findCanonical(this.manifest.ceremonyId, expected.sha256);
    if (existing) {
      if (existing.byteLength !== expected.byteLength) throw new Error("canonical genesis size differs from manifest");
      return existing;
    }
    const source = await hashRegularFile(this.options.genesisZkeyPath);
    if (source.sha256 !== expected.sha256 || source.byteLength !== expected.byteLength) {
      throw new Error("coordinator genesis zkey does not match the signed manifest");
    }
    if (!this.options.store.ingestLocalUpload) throw new Error("genesis seeding requires a pre-provisioned canonical production artifact");
    const uploadId = randomUUID();
    const grant = await this.options.store.createUpload({ ceremonyId: this.manifest.ceremonyId,
      leaseId: "genesis", uploadId, expiresAt: new Date(Date.now() + 60_000).toISOString(), maxByteLength: expected.byteLength });
    const quarantine = await this.options.store.ingestLocalUpload({ grant, body: createReadStream(this.options.genesisZkeyPath), maxByteLength: expected.byteLength });
    return await this.options.store.promoteImmutable({ ceremonyId: this.manifest.ceremonyId, generation: 0, quarantine });
  }

  private async offerNext(): Promise<void> {
    await this.expireLeases();
    const head = await this.syncSchedule();
    if (head.state !== "OPEN") return;
    // This is only a fast path. The store rechecks the signed limit against
    // the latest head under the same row lock used by acceptance.
    if (number(head.head_generation) >= this.manifest.contributionPolicy.maximumContributions) return;
    await this.database.issueNextOffer({ ceremonyId: this.manifest.ceremonyId, leaseId: randomUUID(),
      capabilityHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + this.manifest.contributionPolicy.lease.offerSeconds * 1_000).toISOString() });
  }

  private async queueView(participantId: string): Promise<unknown> {
    const ticket = requireRow((await this.options.pool.query<Row>(
      `SELECT q.id,q.status,q.enqueued_at,l.id AS lease_id,l.expires_at,l.base_generation,
              l.predecessor_sha256,l.predecessor_byte_length,l.expected_contribution_name
       FROM queue_tickets q LEFT JOIN leases l ON l.ticket_id=q.id AND l.state IN ('OFFERED','ACTIVE','SUBMITTED','VERIFYING')
       WHERE q.ceremony_id=$1 AND q.participant_id=$2 AND q.status IN ('QUEUED','OFFERED','LEASED')
       ORDER BY q.enqueued_at DESC LIMIT 1`, [this.manifest.ceremonyId, participantId],
    )).rows[0], "queue ticket not found");
    const position = ticket.status === "QUEUED" ? Number((await this.options.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM queue_tickets
       WHERE ceremony_id=$1 AND status='QUEUED' AND (enqueued_at,id)<=($2,$3)`,
      [this.manifest.ceremonyId, ticket.enqueued_at, ticket.id],
    )).rows[0]?.count ?? 0) : 0;
    return { ticketId: ticket.id, status: ticket.status, position,
      offer: ticket.lease_id ? await this.offerPayload(ticket) : null };
  }

  private async participantStateRow(participantId: string): Promise<Row | undefined> {
    return (await this.options.pool.query<Row>(
      `SELECT q.id AS ticket_id,q.status AS ticket_status,q.enqueued_at AS ticket_enqueued_at,
              l.id AS lease_id,l.state AS lease_state,l.expires_at AS lease_expires_at,
              l.base_generation,l.predecessor_sha256,l.predecessor_byte_length,
              l.expected_contribution_name,s.id AS submission_id,
              s.state AS submission_state,c.submission_id AS receipt_id
       FROM queue_tickets q
       LEFT JOIN leases l ON l.ticket_id=q.id AND l.ceremony_id=q.ceremony_id
         AND l.participant_id=q.participant_id
       LEFT JOIN submissions s ON s.lease_id=l.id AND s.ceremony_id=q.ceremony_id
         AND s.participant_id=q.participant_id
       LEFT JOIN contributions c ON c.submission_id=s.id AND c.ceremony_id=q.ceremony_id
         AND c.participant_id=q.participant_id
       WHERE q.ceremony_id=$1 AND q.participant_id=$2
       ORDER BY CASE WHEN q.status IN ('QUEUED','OFFERED','LEASED') THEN 0 ELSE 1 END,
                q.enqueued_at DESC,q.id DESC
       LIMIT 1`,
      [this.manifest.ceremonyId, participantId],
    )).rows[0];
  }

  private async leaseView(leaseId: string, participantId: string): Promise<unknown> {
    const row = requireRow((await this.options.pool.query<Row>(
      `SELECT l.*,
              CASE WHEN l.state IN ('SUBMITTED','VERIFYING','ACCEPTED') THEN s.id END AS submission_id
       FROM leases l LEFT JOIN submissions s ON s.lease_id=l.id
       WHERE l.id=$1 AND l.participant_id=$2`,
      [leaseId, participantId],
    )).rows[0], "lease not found");
    return { leaseId: row.id, state: row.state, expiresAt: new Date(row.expires_at as string | Date).toISOString(),
      baseGeneration: number(row.base_generation), expectedContributionName: row.expected_contribution_name,
      ...(row.submission_id ? { submissionId: row.submission_id } : {}),
      predecessor: { sha256: row.predecessor_sha256, byteLength: number(row.predecessor_byte_length),
        downloadUrl: await this.publicArtifactUrl(string(row.predecessor_sha256)) } };
  }

  private async offerPayload(row: Row) {
    return { leaseId: row.lease_id, expiresAt: new Date(row.expires_at as string | Date).toISOString(),
      baseGeneration: number(row.base_generation), expectedContributionName: row.expected_contribution_name,
      predecessor: { sha256: row.predecessor_sha256, byteLength: number(row.predecessor_byte_length),
        downloadUrl: await this.publicArtifactUrl(string(row.predecessor_sha256)) } };
  }

  private async uploadRow(uploadId: string, participantId: string): Promise<Row> {
    return requireRow((await this.options.pool.query<Row>(
      "SELECT * FROM artifact_uploads WHERE id=$1 AND participant_id=$2 AND expires_at>now()",
      [uploadId, participantId],
    )).rows[0], "upload not found or expired");
  }

  private submissionResponse(row: Row) {
    return { submissionId: row.id, state: row.state, ...(row.receipt_id ? { receiptId: row.receipt_id } : {}) };
  }

  private async ceremonyRow(): Promise<Row> {
    return requireRow((await this.options.pool.query<Row>("SELECT * FROM ceremonies WHERE id=$1", [this.manifest.ceremonyId])).rows[0], "ceremony not found");
  }

  private async syncSchedule(): Promise<Row> {
    // Advance the monotonic high-water mark before deciding anything. The
    // canonical-head compare-and-swap refuses to run when the clock reads
    // behind this, so once the coordinator has observed any instant at or past
    // sealsAt — which it must, in order to seal — rolling the clock back stops
    // the ceremony instead of reopening it.
    await this.options.pool.query(
      `UPDATE ceremonies
       SET observed_time_high_water = greatest(observed_time_high_water, clock_timestamp())
       WHERE id=$1`,
      [this.manifest.ceremonyId],
    );
    // The schedule decision stays in SQL so it is taken on the same clock that
    // the canonical-head compare-and-swap later enforces the sealing instant
    // against; mixing in the Node clock would put two different clocks in
    // charge of one deadline. Only the decision is read here, so the declared
    // state machine can vet the transition before anything is written.
    const decision = (await this.options.pool.query<Row>(
      `SELECT state, CASE
         WHEN state='PREPARED' AND now()>=seals_at THEN 'SEALED'
         WHEN state='PREPARED' AND now()>=opens_at AND now()<seals_at THEN 'OPEN'
         WHEN state='OPEN' AND now()>=seals_at THEN 'SEALED'
         ELSE state END AS target
       FROM ceremonies WHERE id=$1`, [this.manifest.ceremonyId],
    )).rows[0];
    if (decision) {
      const from = string(decision.state) as CeremonyState;
      const to = string(decision.target) as CeremonyState;
      if (from !== to) {
        assertCeremonyTransition(from, to);
        // Guarded on the state just read, so a concurrent request that reached
        // the same conclusion first turns this into a no-op rather than a
        // second transition.
        await this.options.pool.query(
          "UPDATE ceremonies SET state=$2,updated_at=now() WHERE id=$1 AND state=$3",
          [this.manifest.ceremonyId, to, from],
        );
      }
    }
    const row = await this.ceremonyRow();
    if (row.state === "SEALED") {
      await this.options.pool.query(
        `WITH stale_submissions AS (
           UPDATE submissions SET state='STALE',updated_at=now()
           WHERE ceremony_id=$1 AND state IN ('SUBMITTED','VERIFYING') RETURNING lease_id
         ), stale_leases AS (
           UPDATE leases SET state='STALE'
           WHERE ceremony_id=$1 AND state IN ('OFFERED','ACTIVE','SUBMITTED','VERIFYING') RETURNING ticket_id
         ) UPDATE queue_tickets SET status='EXPIRED'
           WHERE ceremony_id=$1 AND status IN ('QUEUED','OFFERED','LEASED')`,
        [this.manifest.ceremonyId],
      );
    }
    return row;
  }

  private async assertCeremonyOpen(): Promise<void> {
    if ((await this.syncSchedule()).state !== "OPEN") throw new Error("ceremony is not open");
  }

  private async expireLeases(): Promise<void> {
    await expireParticipantLeases(this.options.pool, this.manifest.ceremonyId, heartbeatGraceSeconds(this.manifest, this.options.allowRehearsal));
  }

  private async expireVerifierJobsAndRejectImpossible(): Promise<void> {
    // verification_jobs carries no ceremony_id, so both statements join through
    // submissions. Without that they span every ceremony sharing the database,
    // and this coordinator would expire another epoch's jobs and reject its
    // submissions using this manifest's attempt and operator policy.
    await this.options.pool.query(
      `UPDATE verification_jobs j SET state='EXPIRED'
       FROM submissions s
       WHERE j.submission_id=s.id AND s.ceremony_id=$1
         AND j.state='CLAIMED' AND j.lease_until<=now()`,
      [this.manifest.ceremonyId],
    );
    const exhausted = await this.options.pool.query<{ submission_id: string; count: string }>(
      `SELECT j.submission_id,count(*)::text AS count FROM verification_jobs j
       JOIN submissions s ON s.id=j.submission_id
       WHERE s.ceremony_id=$2 AND j.state='EXPIRED' AND j.attempt >= $1
       GROUP BY j.submission_id`,
      [this.manifest.contributionPolicy.verifierMaxAttempts, this.manifest.ceremonyId],
    );
    const maximumExhausted = this.manifest.verifierPolicy.operatorKeyIds.length
      - this.manifest.verifierPolicy.requiredOperators;
    for (const row of exhausted.rows) {
      if (Number(row.count) > maximumExhausted) await this.rejectSubmission(row.submission_id);
    }
  }

  private async canonicalArtifact(sha256: string): Promise<CanonicalArtifact> {
    const row = requireRow((await this.options.pool.query<Row>(
      `SELECT sha256,byte_length,storage_backend,object_key,storage_version_id,immutable
       FROM artifacts WHERE ceremony_id=$1 AND sha256=$2 AND immutable=true`,
      [this.manifest.ceremonyId, sha256],
    )).rows[0], "canonical artifact pin not found");
    const backend = string(row.storage_backend);
    if (backend !== "local" && backend !== "s3") {
      throw new Error("canonical artifact backend is invalid");
    }
    if (row.immutable !== true) throw new Error("canonical artifact is not immutable");
    return {
      backend,
      objectKey: string(row.object_key),
      versionId: string(row.storage_version_id),
      sha256: string(row.sha256),
      byteLength: number(row.byte_length),
      immutable: true,
    };
  }

  private async publicArtifactUrl(sha256: string, promoted?: CanonicalArtifact): Promise<string> {
    // The AWS HTTPS API is a control plane, not a large-file transport. Bind
    // public download/receipt URLs to the committed S3 version behind the
    // manifest-authorized archive, without expiring capabilities or redirects.
    if (this.manifest.primaryPublication) {
      const artifact = promoted ?? await this.canonicalArtifact(sha256);
      const expectedKey = `canonical/${this.manifest.ceremonyId}/sha256/${sha256}.zkey`;
      if (artifact.backend !== "s3" || artifact.sha256 !== sha256
        || artifact.objectKey !== expectedKey || !artifact.immutable
        || !artifact.versionId || artifact.versionId === "null") {
        throw new Error("public archive artifact pin is invalid");
      }
      const url = new URL(`/${expectedKey}`, this.manifest.primaryPublication.archiveBaseUrl);
      url.searchParams.set("versionId", artifact.versionId);
      return url.toString();
    }
    return new URL(`/v1/ceremonies/${encodeURIComponent(this.manifest.slug)}/artifacts/${sha256}.zkey`, this.options.publicBaseUrl).toString();
  }

  private assertSlug(slug: string): void { if (slug !== this.manifest.slug) throw new Error("ceremony not found"); }

  private sign<T>(payload: T, domain: string): SignedEnvelope<T> {
    return signEnvelope(payload as unknown as JsonValue, { keyId: this.options.coordinatorKeyId,
      privateKey: this.options.coordinatorPrivateKey, domain }) as unknown as SignedEnvelope<T>;
  }
}

export async function createLocalRuntime(input: {
  databaseUrl: string; manifestEnvelope: SignedEnvelope<CeremonyManifestV1>;
  coordinatorKeyId: string; coordinatorPrivateKeyFile: string; publicBaseUrl: string;
  artifactRoot: string; genesisZkeyPath: string; production: boolean;
  allowCeremonyInitialization?: boolean;
}): Promise<{ operations: PostgresCoordinatorOperations; pool: Pool }> {
  if (input.production) throw new Error("local artifact backend is forbidden in production");
  return createRuntime({ ...input, store: new LocalArtifactStore(input.artifactRoot, { allowDevelopmentOnly: true }) });
}

export async function createRuntime(input: {
  manifestRootPublicKey?: string;
  databaseUrl: string; databaseCaFile?: string; manifestEnvelope: SignedEnvelope<CeremonyManifestV1>;
  coordinatorKeyId: string; coordinatorPrivateKeyFile: string; publicBaseUrl: string;
  store: ArtifactStore; genesisZkeyPath: string; production: boolean; allowRehearsal?: boolean;
  publicationArchive?: PublicationTarget;
  webReleaseAuthorization?: { envelope: SignedEnvelope<RehearsalWebReleaseAuthorization>; rootPublicKey: string };
  allowCeremonyInitialization?: boolean;
}): Promise<{ operations: PostgresCoordinatorOperations; pool: Pool }> {
  if (input.production && ((!input.manifestEnvelope.payload.publication && !input.manifestEnvelope.payload.primaryPublication) || !input.publicationArchive)) throw new Error("hosted ceremony requires transcript publication and a signed publication policy");
  if (input.production && !input.databaseCaFile) throw new Error("hosted PostgreSQL requires a trusted TLS CA file");
  const privateKey = createPrivateKey(await readSecretFile(input.coordinatorPrivateKeyFile));
  const declared = input.manifestEnvelope.payload.coordinatorKeys.find((key) => key.keyId === input.coordinatorKeyId);
  if (!declared) throw new Error("coordinator key is not authorized by the signed manifest");
  const expected = createPublicKey(declared.publicKeyPem).export({ type: "spki", format: "der" });
  const actual = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (!Buffer.from(expected).equals(Buffer.from(actual))) throw new Error("coordinator private key does not match the manifest");
  const databaseUrl = new URL(input.databaseUrl);
  if (input.production && [...databaseUrl.searchParams.keys()].some((key) => key.toLowerCase().startsWith("ssl"))) {
    throw new Error("database URL must not override the configured TLS policy");
  }
  const pool = new Pool({ connectionString: input.databaseUrl, max: 10,
    ...(input.databaseCaFile ? { ssl: { ca: await readFile(input.databaseCaFile, "utf8"), rejectUnauthorized: true } } : {}) });
  await pool.query("SELECT 1");
  const operations = new PostgresCoordinatorOperations({ pool, store: input.store,
    manifestRootPublicKey: input.manifestRootPublicKey,
    manifestEnvelope: input.manifestEnvelope, coordinatorKeyId: input.coordinatorKeyId,
    coordinatorPrivateKey: privateKey, publicBaseUrl: input.publicBaseUrl, genesisZkeyPath: input.genesisZkeyPath,
    production: input.production,
    allowRehearsal: input.allowRehearsal,
    publicationArchive: input.publicationArchive,
    webReleaseAuthorization: input.webReleaseAuthorization,
    allowCeremonyInitialization: input.allowCeremonyInitialization });
  try { await operations.initialize(); } catch (error) { await pool.end(); throw error; }
  return { operations, pool };
}

async function hashRegularFile(path: string): Promise<{ sha256: string; byteLength: number }> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error("genesis zkey must be a nonempty regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest("hex"), byteLength: metadata.size };
}

async function readSecretFile(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("secret file permissions are unsafe");
  return await readFile(path, "utf8");
}

function requireRow<T>(value: T | undefined, message: string): T { if (value === undefined) throw new Error(message); return value; }
function string(value: unknown): string { if (typeof value !== "string") throw new Error("database string is invalid"); return value; }
function number(value: unknown): number { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) throw new Error("database integer is invalid"); return result; }
function isoDate(value: unknown): string {
  if (!(typeof value === "string" || value instanceof Date)) throw new Error("database timestamp is invalid");
  const result = new Date(value).toISOString();
  return result;
}

function persistedUploadGrant(uploadId: string, backendGrant: UploadGrant): StoredUploadGrant {
  const backendUploadIdValue = (backendGrant as StoredUploadGrant).backendUploadId;
  if (backendUploadIdValue !== undefined
    && (typeof backendUploadIdValue !== "string" || backendUploadIdValue.length === 0)) {
    throw new Error("artifact backend returned an invalid backend upload ID");
  }
  const backendUploadId = backendUploadIdValue
    ?? (backendGrant.uploadId === uploadId ? undefined : backendGrant.uploadId);
  return {
    ...backendGrant,
    uploadId,
    ...(backendUploadId === undefined ? {} : { backendUploadId }),
  };
}

function publicUploadGrant(uploadId: string, storedGrant: StoredUploadGrant): UploadGrant {
  const { backendUploadId: _backendUploadId, ...grant } = storedGrant;
  return { ...grant, uploadId };
}
