import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgCeremonyStore } from "@moss/phase2-db";
import type { CeremonyManifestV1 } from "@moss/phase2-protocol";

const url = process.env.CEREMONY_TEST_DATABASE_URL;
const hash = () => createHash("sha256").update(randomUUID()).digest("hex");

// Synthetic fixtures in a disposable schema; never reads existing ceremony data.
describe.skipIf(!url)("per-account queue limits against PostgreSQL", () => {
  let admin: Pool, pool: Pool, schema: string, store: PgCeremonyStore;
  let ceremonyId: string, participantId: string, authSubjectHash: string;
  const join = () => store.joinQueue({ ceremonyId, participantId, authSubjectHash,
    publicPseudonym: "test-participant", ticketId: randomUUID(), idempotencyKey: randomUUID() });
  const offer = () => store.issueNextOffer({ ceremonyId, leaseId: randomUUID(),
    capabilityHash: hash(), expiresAt: new Date(Date.now() + 60_000).toISOString() });

  beforeEach(async () => {
    schema = "queue_test_" + randomUUID().replaceAll("-", "");
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    ceremonyId = randomUUID(); participantId = randomUUID(); authSubjectHash = hash();
    await pool.query(`INSERT INTO ceremonies
      (id,slug,state,manifest,manifest_sha256,verifier_policy,head_sha256,head_byte_length,event_hash,opens_at,seals_at)
      VALUES($1::uuid,$1::uuid::text,'OPEN',$2,$3,'{}',$3,100,$3,now()-interval '1 hour',now()+interval '1 day')`,
    [ceremonyId, { purpose: "production", contributionPolicy: { maximumContributions: 100 } }, hash()]);
    // Publication is unrelated to these queue tests; use the real production
    // manifest purpose and database constraints without requiring a witness.
    store = new PgCeremonyStore(pool, { production: false });
  });
  afterEach(async () => {
    await pool?.end();
    if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it("reuses one FIFO entry across concurrent joins with different request IDs", async () => {
    const tickets = await Promise.all(Array.from({ length: 8 }, join));
    expect(new Set(tickets.map((ticket) => ticket.id)).size).toBe(1);
    expect(new Set(tickets.map((ticket) => ticket.enqueuedAt)).size).toBe(1);
    expect((await pool.query("SELECT count(*) FROM queue_tickets")).rows[0].count).toBe("1");
    const first = tickets[0]!;
    const offers = await Promise.all([offer(), offer()]);
    const lease = offers.find((value) => value !== null)!;
    expect(offers.filter(Boolean)).toHaveLength(1);
    expect(await join()).toMatchObject({ id: first.id, status: "OFFERED", enqueuedAt: first.enqueuedAt });
    const claims = await Promise.allSettled(Array.from({ length: 2 }, () => store.claimLease({
      leaseId: lease.id, participantId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })));
    expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const state of ["ACTIVE", "SUBMITTED", "VERIFYING"]) {
      await pool.query("UPDATE leases SET state=$1 WHERE id=$2", [state, lease.id]);
      expect(await join()).toMatchObject({ id: first.id, status: "LEASED" });
      expect(await offer()).toBeNull();
    }
  });

  it.each(["EXPIRED", "REJECTED", "CANCELLED"])("allows retry after %s before acceptance", async (state) => {
    const first = await join();
    const lease = (await offer())!;
    await pool.query("UPDATE leases SET state=$1 WHERE id=$2", [state, lease.id]);
    await pool.query("UPDATE queue_tickets SET status=$1 WHERE id=$2", [state === "EXPIRED" ? "EXPIRED" : "CANCELLED", first.id]);
    const retry = await join();
    expect(retry.id).not.toBe(first.id);
    expect(retry.status).toBe("QUEUED");
    expect(await offer()).not.toBeNull();
  });

  it("releases a claimed slot at once on cancel and offers the next participant", async () => {
    await join();
    const lease = (await offer())!;
    await store.claimLease({ leaseId: lease.id, participantId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const other = { participantId: randomUUID(), authSubjectHash: hash() };
    await store.joinQueue({ ceremonyId, ...other, publicPseudonym: "next", ticketId: randomUUID(), idempotencyKey: randomUUID() });
    expect(await offer()).toBeNull();

    await store.cancelParticipantAttempt({ ceremonyId, participantId });
    expect((await pool.query("SELECT state FROM leases WHERE id=$1", [lease.id])).rows[0].state).toBe("CANCELLED");
    const next = await offer();
    expect(next).not.toBeNull();
    expect((await pool.query("SELECT participant_id FROM leases WHERE id=$1", [next!.id])).rows[0].participant_id).toBe(other.participantId);
    expect((await join()).status).toBe("QUEUED");
  });

  it.each(["SUBMITTED", "VERIFYING"])("refuses to cancel a %s contribution", async (state) => {
    const ticket = await join();
    const lease = (await offer())!;
    await pool.query("UPDATE leases SET state=$1 WHERE id=$2", [state, lease.id]);
    await pool.query("UPDATE queue_tickets SET status='LEASED' WHERE id=$1", [ticket.id]);
    await expect(store.cancelParticipantAttempt({ ceremonyId, participantId })).rejects.toThrow("already submitted");
    expect((await pool.query("SELECT state FROM leases WHERE id=$1", [lease.id])).rows[0].state).toBe(state);
    expect((await pool.query("SELECT status FROM queue_tickets WHERE id=$1", [ticket.id])).rows[0].status).toBe("LEASED");
  });

  it("still leaves the queue before any offer", async () => {
    const ticket = await join();
    await store.cancelParticipantAttempt({ ceremonyId, participantId });
    expect((await pool.query("SELECT status FROM queue_tickets WHERE id=$1", [ticket.id])).rows[0].status).toBe("CANCELLED");
    await expect(store.cancelParticipantAttempt({ ceremonyId, participantId })).rejects.toThrow("not found");
  });

  // Seed only database records to exercise identity admission/uniqueness. These
  // are not cryptographically valid contributions and bypass no runtime checks.
  async function seedAccepted(generation: number) {
    const ticket = randomUUID(), lease = randomUUID(), submission = randomUUID(), digest = hash();
    await pool.query(`INSERT INTO queue_tickets(id,ceremony_id,participant_id,status,idempotency_key)
      VALUES($1,$2,$3,'COMPLETED',$1::uuid::text)`, [ticket, ceremonyId, participantId]);
    await pool.query(`INSERT INTO leases(id,ceremony_id,ticket_id,participant_id,state,base_generation,
      predecessor_sha256,predecessor_byte_length,expected_contribution_name,capability_hash,expires_at)
      VALUES($1,$2,$3,$4,'ACCEPTED',0,$5,100,'test',$5,now())`, [lease, ceremonyId, ticket, participantId, digest]);
    await pool.query(`INSERT INTO submissions(id,ceremony_id,lease_id,participant_id,state,predecessor_sha256,
      candidate_sha256,candidate_byte_length,quarantine_object_key,quarantine_version_id,claimed_contribution_hash,client_kind)
      VALUES($1,$2,$3,$4,'ACCEPTED',$5,$5,100,'test',$1::uuid::text,$6,'browser')`,
    [submission, ceremonyId, lease, participantId, digest, "a".repeat(128)]);
    await pool.query(`INSERT INTO artifacts(sha256,ceremony_id,kind,byte_length,storage_backend,object_key,
      storage_version_id,immutable,predecessor_sha256,generation)
      VALUES($1,$2,'CONTRIBUTION',100,'local',$4,$4,true,$1,$3)`, [digest, ceremonyId, generation, digest]);
    return pool.query(`INSERT INTO contributions(ceremony_id,generation,submission_id,participant_id,
      predecessor_sha256,successor_sha256,contribution_hash,contribution_name,receipt,receipt_signature,accepted_at,rehearsal_repeat)
      VALUES($1,$2,$3,$4,$5,$5,$6,'test','{}','test',now(),true)`,
    [ceremonyId, generation, submission, participantId, digest, "a".repeat(128)]);
  }

  it("blocks accepted production accounts even with rehearsal opt-in or a forged repeat flag", async () => {
    const ticket = await join();
    await pool.query("UPDATE queue_tickets SET status='COMPLETED' WHERE id=$1", [ticket.id]);
    await seedAccepted(1);
    store = new PgCeremonyStore(pool, { production: true, allowRehearsal: true,
      trustedManifest: { ceremonyId, purpose: "production" } as CeremonyManifestV1 });
    await expect(join()).rejects.toThrow("already contributed");
    await expect(seedAccepted(2)).rejects.toMatchObject({ code: "23505", constraint: "contributions_one_per_participant" });
  });

  it("keeps the explicit rehearsal repeat exception without permitting duplicate live entries", async () => {
    await pool.query("UPDATE ceremonies SET manifest=jsonb_set(manifest,'{purpose}','\"rehearsal\"') WHERE id=$1", [ceremonyId]);
    const ticket = await join();
    await pool.query("UPDATE queue_tickets SET status='COMPLETED' WHERE id=$1", [ticket.id]);
    await seedAccepted(1);
    await seedAccepted(2);
    await expect(join()).rejects.toThrow("already contributed");
    store = new PgCeremonyStore(pool, { production: true, allowRehearsal: true,
      trustedManifest: { ceremonyId, purpose: "rehearsal" } as CeremonyManifestV1 });
    const repeats = await Promise.all([join(), join()]);
    expect(repeats[0]!.id).toBe(repeats[1]!.id);
    expect(repeats[0]!.id).not.toBe(ticket.id);
  });
});
