import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalSha256, operationalUpdateHash, OPERATIONAL_UPDATE_DOMAIN, signEnvelope,
  type CeremonyManifestV1, type JsonValue, type OperationalUpdate, type SignedEnvelope } from "@moss/phase2-protocol";
import { OperationalUpdates, expireParticipantLeases } from "../src/operational-updates.js";

// Always creates and drops an isolated schema; never reads existing ceremony data.
const url = process.env.CEREMONY_TEST_DATABASE_URL;
describe.skipIf(!url)("operational updates against PostgreSQL", () => {
  let pool: Pool;
  let admin: Pool;
  let schema: string;
  let operations: OperationalUpdates;
  const root = generateKeyPairSync("ed25519");
  const id = randomUUID();
  const manifest = { keyId: "root", payload: { ceremonyId: id, purpose: "production",
    contributionPolicy: { lease: { heartbeatSeconds: 300, absoluteSeconds: 5400 } },
    operationalPolicy: { minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 600, allowWebReleaseUpdates: true },
  } } as SignedEnvelope<CeremonyManifestV1>;
  const archive = { async publishBytes(_key: string, bytes: Buffer) {
    return { versionId: "test-version", sha256: createHash("sha256").update(bytes).digest("hex") };
  } };
  const config = () => ({ pool, manifest, rootPublicKey: root.publicKey.export({ type: "spki", format: "pem" }).toString(), production: true, archive });
  async function update(grace: number, reason = "Queue tuning") {
    const { updates } = await operations.history();
    return signEnvelope({ schemaVersion: 1, type: "moss.phase2.operational-update.v1", ceremonyId: id,
      manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest.payload as unknown as JsonValue),
      sequence: updates.length + 1, previousUpdateSha256: updates.length ? operationalUpdateHash(updates.at(-1)!) : null,
      authorizedAt: new Date().toISOString(), reason, heartbeatGraceSeconds: grace,
    }, { keyId: "root", privateKey: root.privateKey, domain: OPERATIONAL_UPDATE_DOMAIN }) as SignedEnvelope<OperationalUpdate>;
  }
  async function lease(state = "OFFERED", ageSeconds = 0) {
    const leaseId = randomUUID(), ticket = randomUUID(), participant = randomUUID();
    await pool.query("INSERT INTO queue_tickets VALUES($1,'OFFERED')", [ticket]);
    await pool.query(`INSERT INTO leases(id,ceremony_id,ticket_id,participant_id,state,expires_at,heartbeat_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()-($6 * interval '1 second'))`, [leaseId, id, ticket, participant, state, ageSeconds]);
    return { leaseId, participant };
  }
  const readLease = async (leaseId: string) => (await pool.query("SELECT state,heartbeat_grace_seconds FROM leases WHERE id=$1", [leaseId])).rows[0];
  const claim = async (slot: Awaited<ReturnType<typeof lease>>) => operations.claim(slot.leaseId, slot.participant, new Date(Date.now() + 5400000).toISOString());
  beforeEach(async () => {
    schema = "ops_test_" + randomUUID().replaceAll("-", "");
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE ceremonies(id uuid PRIMARY KEY,state text NOT NULL,seals_at timestamptz NOT NULL);
      CREATE TABLE queue_tickets(id uuid PRIMARY KEY,status text);
      CREATE TABLE leases(id uuid PRIMARY KEY,ceremony_id uuid,ticket_id uuid,participant_id uuid,state text,
        expires_at timestamptz,heartbeat_at timestamptz,claimed_at timestamptz);
      CREATE FUNCTION reject_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable record'; END; $$;`);
    await pool.query(await readFile(new URL("../../../packages/db/migrations/006_operational_updates.sql", import.meta.url), "utf8"));
    await pool.query("INSERT INTO ceremonies VALUES($1,'OPEN',now()+interval '1 day')", [id]);
    operations = new OperationalUpdates(config());
  });
  afterEach(async () => {
    await pool?.end();
    if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  it("preserves active grace on decreases, applies increases, and persists across restarts", async () => {
    const existing = await lease(); await claim(existing);
    const reduction = await update(30); await operations.apply(reduction);
    expect((await readLease(existing.leaseId)).heartbeat_grace_seconds).toBe(300);
    const next = await lease(); await claim(next);
    expect((await readLease(next.leaseId)).heartbeat_grace_seconds).toBe(30);
    await operations.apply(await update(600));
    expect((await readLease(existing.leaseId)).heartbeat_grace_seconds).toBe(600);
    expect((await readLease(next.leaseId)).heartbeat_grace_seconds).toBe(600);
    await operations.apply(await update(60));
    expect((await readLease(next.leaseId)).heartbeat_grace_seconds).toBe(600);
    operations = new OperationalUpdates(config());
    const later = await lease(); await claim(later);
    expect((await readLease(later.leaseId)).heartbeat_grace_seconds).toBe(60);
    expect((await operations.history()).updates).toHaveLength(3);
    await expect(pool.query("DELETE FROM operational_updates WHERE ceremony_id=$1", [id])).rejects.toThrow(/immutable/);
  });
  it("never revives expired slots and retains the absolute deadline", async () => {
    const stale = await lease("ACTIVE", 301);
    await operations.apply(await update(600));
    expect((await readLease(stale.leaseId)).state).toBe("EXPIRED");
    const active = await lease(); await claim(active);
    await pool.query("UPDATE leases SET expires_at=now()-interval '1 second' WHERE id=$1", [active.leaseId]);
    await expireParticipantLeases(pool, id, 300);
    expect((await readLease(active.leaseId)).state).toBe("EXPIRED");
  });
  it("serializes competing updates, safely retries the winner, and fails closed on archive failure", async () => {
    const first = await update(120), competing = await update(180);
    const results = await Promise.allSettled([operations.apply(first), operations.apply(competing)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const winner = (await operations.history()).updates[0];
    expect(await operations.apply(winner)).toMatchObject({ sequence: 1 });
    const brokenArchive = new OperationalUpdates({ ...config(), archive: { async publishBytes() { throw new Error("unavailable"); } } });
    await expect(brokenArchive.apply(await update(240))).rejects.toThrow(/unavailable/);
    expect((await operations.history()).updates).toHaveLength(1);
  });
  it("rejects heartbeat changes after closing", async () => {
    await pool.query("UPDATE ceremonies SET seals_at=now()-interval '1 second' WHERE id=$1", [id]);
    await expect(operations.apply(await update(120))).rejects.toThrow(/open ceremony/);
  });
  it("authorizes a website repair after closing without changing heartbeat settings", async () => {
    const draft = await update(120);
    delete draft.payload.heartbeatGraceSeconds;
    draft.payload.webRelease = { sha256: "a".repeat(64), byteLength: 100, sourceCommit: "b".repeat(40), urls: ["https://archive.test/release.json"] };
    const signed = signEnvelope(draft.payload as unknown as JsonValue, { keyId: "root", privateKey: root.privateKey, domain: OPERATIONAL_UPDATE_DOMAIN }) as unknown as SignedEnvelope<OperationalUpdate>;
    await pool.query("UPDATE ceremonies SET state='SEALED',seals_at=now()-interval '1 second' WHERE id=$1", [id]);
    await expect(operations.apply(signed)).resolves.toMatchObject({ sequence: 1 });
    const history = await new OperationalUpdates(config()).history();
    expect(history.updates[0].payload.webRelease).toEqual(draft.payload.webRelease);
    expect(history.archives[0]).toMatchObject({ versionId: "test-version" });
  });
});
