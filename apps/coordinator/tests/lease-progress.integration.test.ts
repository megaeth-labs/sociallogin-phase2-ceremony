import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgCeremonyStore } from "@moss/phase2-db";
import { DOWNLOAD_RELEASE_POLICY } from "../src/lease-progress.js";
import { releaseHopelessDownloads } from "../src/operational-updates.js";

const url = process.env.CEREMONY_TEST_DATABASE_URL;
const hash = () => createHash("sha256").update(randomUUID()).digest("hex");

// Synthetic fixtures in a disposable schema; never reads existing ceremony data.
describe.skipIf(!url)("releasing slots whose download cannot finish", () => {
  let admin: Pool, pool: Pool, schema: string, store: PgCeremonyStore;
  let ceremonyId: string, participantId: string, leaseId: string, ticketId: string;

  beforeEach(async () => {
    schema = "progress_test_" + randomUUID().replaceAll("-", "");
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
    for (const file of (await readdir(migrations)).filter((file) => file.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    ceremonyId = randomUUID(); participantId = randomUUID();
    await pool.query(`INSERT INTO ceremonies
      (id,slug,state,manifest,manifest_sha256,verifier_policy,head_sha256,head_byte_length,event_hash,opens_at,seals_at)
      VALUES($1::uuid,$1::uuid::text,'OPEN',$2,$3,'{}',$3,100,$3,now()-interval '1 hour',now()+interval '1 day')`,
    [ceremonyId, { purpose: "production", contributionPolicy: { maximumContributions: 100 } }, hash()]);
    store = new PgCeremonyStore(pool, { production: false });
    const ticket = await store.joinQueue({ ceremonyId, participantId, authSubjectHash: hash(),
      publicPseudonym: "test-participant", ticketId: randomUUID(), idempotencyKey: randomUUID() });
    ticketId = ticket.id;
    const offer = (await store.issueNextOffer({ ceremonyId, leaseId: randomUUID(), capabilityHash: hash(),
      expiresAt: new Date(Date.now() + 60_000).toISOString() }))!;
    leaseId = offer.id;
    await store.claimLease({ leaseId, participantId, expiresAt: new Date(Date.now() + 1_800_000).toISOString() });
  });
  afterEach(async () => {
    await pool?.end();
    if (schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  const report = (stage: string, downloadFraction: number | null) =>
    store.heartbeat({ leaseId, participantId, progress: { stage, downloadFraction } });
  // Moves the claim and the last progress into the past to simulate elapsed time.
  const age = (claimedSecondsAgo: number, advancedSecondsAgo = 0) => pool.query(
    `UPDATE leases SET claimed_at=now()-($2 * interval '1 second'),
       progress_advanced_at=now()-($3 * interval '1 second') WHERE id=$1`,
    [leaseId, claimedSecondsAgo, advancedSecondsAgo]);
  const release = () => releaseHopelessDownloads(pool, ceremonyId, DOWNLOAD_RELEASE_POLICY);
  const state = async () => (await pool.query(
    `SELECT l.state, l.released_reason, q.status FROM leases l JOIN queue_tickets q ON q.id=l.ticket_id WHERE l.id=$1`,
    [leaseId])).rows[0];

  it("records progress and when it last advanced", async () => {
    await report("downloading", 0.1);
    const first = (await pool.query("SELECT progress_stage, progress_fraction, progress_advanced_at FROM leases WHERE id=$1", [leaseId])).rows[0];
    expect(first).toMatchObject({ progress_stage: "downloading", progress_fraction: 0.1 });
    await pool.query("UPDATE leases SET progress_advanced_at=now()-interval '1 minute' WHERE id=$1", [leaseId]);
    await report("downloading", 0.1);
    const same = (await pool.query("SELECT extract(epoch FROM now()-progress_advanced_at) AS idle FROM leases WHERE id=$1", [leaseId])).rows[0];
    expect(Number(same.idle)).toBeGreaterThan(50);
    await report("downloading", 0.2);
    const moved = (await pool.query("SELECT extract(epoch FROM now()-progress_advanced_at) AS idle FROM leases WHERE id=$1", [leaseId])).rows[0];
    expect(Number(moved.idle)).toBeLessThan(5);
  });

  it("never judges a download inside the grace period", async () => {
    await report("downloading", 0.01);
    await age(60);
    expect(await release()).toEqual([]);
    expect(await state()).toMatchObject({ state: "ACTIVE", status: "LEASED" });
  });

  it("releases a download that projects past the limit, and frees the ticket", async () => {
    await report("downloading", 0.1);
    await age(200);
    const released = await release();
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ leaseId, reason: "download-too-slow", downloadFraction: 0.1 });
    expect(await state()).toMatchObject({ state: "EXPIRED", released_reason: "download-too-slow", status: "EXPIRED" });
  });

  it("releases a download with no bytes after the grace period", async () => {
    await report("downloading", 0);
    await age(200);
    expect((await release())[0]).toMatchObject({ reason: "download-too-slow" });
  });

  it("keeps a download on track to finish in time", async () => {
    await report("downloading", 0.5);
    await age(200);
    expect(await release()).toEqual([]);
    expect(await state()).toMatchObject({ state: "ACTIVE" });
  });

  it("releases a download that stopped advancing", async () => {
    await report("downloading", 0.9);
    await age(600, 300);
    expect((await release())[0]).toMatchObject({ reason: "download-stalled" });
  });

  it("leaves computing, uploading and unreported attempts to the existing limits", async () => {
    await age(1_000);
    expect(await release()).toEqual([]);
    await report("computing", null);
    await age(1_000, 900);
    expect(await release()).toEqual([]);
    await report("uploading", null);
    await age(1_000, 900);
    expect(await release()).toEqual([]);
    expect(await state()).toMatchObject({ state: "ACTIVE" });
  });

  it("does not let a released slot heartbeat back to life", async () => {
    await report("downloading", 0.1);
    await age(200);
    await release();
    await expect(report("downloading", 0.2)).rejects.toThrow("lease is unavailable or expired");
  });
});
