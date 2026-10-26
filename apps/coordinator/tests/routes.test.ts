import { generateKeyPairSync, sign } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_SIGNATURE_DOMAIN,
  VERIFICATION_REPORT_SIGNATURE_DOMAIN,
  assertVerificationReport,
  signEnvelope,
  verifyEnvelope,
  type CeremonyManifestV1,
  type JsonValue,
  type SignedEnvelope,
  type VerificationReportV1,
} from "@moss/phase2-protocol";
import type { ArtifactStore } from "@moss/phase2-storage";
import type { Pool } from "pg";

import {
  verifierBearerAuthenticator,
  verifyParticipantToken,
} from "../src/auth.js";
import { buildCoordinatorServer, parseCorsAllowedOrigins } from "../src/server.js";
import type { CoordinatorOperations } from "../src/api.js";
import { PostgresCoordinatorOperations } from "../src/runtime.js";

describe("participant authentication", () => {
  it("validates a canonical EdDSA JWT itself", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "moss-auth", aud: "moss-phase2", exp: Math.floor(Date.now() / 1000) + 60,
      sub: "123e4567-e89b-42d3-a456-426614174000", name: "alice", ash: "1".repeat(64),
    })).toString("base64url");
    const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    expect(verifyParticipantToken(`${header}.${payload}.${signature}`, {
      publicKey, issuer: "moss-auth", audience: "moss-phase2",
    })).toMatchObject({ pseudonym: "alice" });
  });

  it("rejects an expired token", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: "moss-auth", aud: "moss-phase2", exp: 1,
      sub: "123e4567-e89b-42d3-a456-426614174000", name: "alice", ash: "1".repeat(64),
    })).toString("base64url");
    const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    expect(() => verifyParticipantToken(`${header}.${payload}.${signature}`, {
      publicKey, issuer: "moss-auth", audience: "moss-phase2",
    })).toThrow(/expired/u);
  });
});

describe("internal verifier authentication", () => {
  it("derives one operator identity from a unique bearer token", () => {
    const authenticate = verifierBearerAuthenticator(new Map([
      ["operator-a", "a".repeat(32)],
      ["operator-b", "b".repeat(32)],
    ]));
    expect(authenticate({
      headers: { authorization: `Bearer ${"b".repeat(32)}` },
    })).toEqual({ operatorKeyId: "operator-b" });
    expect(() => authenticate({
      headers: { authorization: `Bearer ${"c".repeat(32)}` },
    })).toThrow(/authentication failed/u);
    expect(() => verifierBearerAuthenticator(new Map([
      ["operator-a", "a".repeat(32)],
      ["operator-b", "a".repeat(32)],
    ]))).toThrow(/unique/u);
  });

  it("does not let one authenticated operator claim another operator's job", async () => {
    let claimedAs: string | undefined;
    const app = buildCoordinatorServer({
      operations: {
        async claimVerifierJob(operatorKeyId: string) {
          claimedAs = operatorKeyId;
          return null;
        },
      } as CoordinatorOperations,
      participantAuth: { async authenticate() { throw new Error("not used"); } },
      authenticateInternal() { return { operatorKeyId: "operator-a" }; },
      verifierPublicKeys: new Map([
        ["operator-a", "unused"],
        ["operator-b", "unused"],
      ]),
      maxArtifactByteLength: 1_000,
      corsAllowedOrigins: new Set(),
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/v1/internal/verifier/jobs/claim",
      payload: { operatorKeyId: "operator-b" },
    });
    expect(rejected.statusCode).toBe(401);
    expect(claimedAs).toBeUndefined();

    const accepted = await app.inject({
      method: "POST",
      url: "/v1/internal/verifier/jobs/claim",
      payload: { operatorKeyId: "operator-a" },
    });
    expect(accepted.statusCode).toBe(204);
    expect(claimedAs).toBe("operator-a");
    await app.close();
  });

  it("accepts the worker's strict report schema and Ed25519 envelope after JSON transport", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = verifierErrorEnvelope().payload;
    assertVerificationReport(payload, { production: false });
    const envelope = signEnvelope(payload as unknown as JsonValue, {
      keyId: payload.operatorKeyId,
      privateKey,
      domain: VERIFICATION_REPORT_SIGNATURE_DOMAIN,
    }) as unknown as SignedEnvelope<VerificationReportV1>;
    let received: SignedEnvelope<VerificationReportV1> | undefined;
    const app = buildCoordinatorServer({
      operations: {
        async recordVerifierReport(report: SignedEnvelope<VerificationReportV1>) {
          received = report;
        },
      } as CoordinatorOperations,
      participantAuth: { async authenticate() { throw new Error("not used"); } },
      authenticateInternal() { return { operatorKeyId: payload.operatorKeyId }; },
      verifierPublicKeys: new Map([[payload.operatorKeyId,
        publicKey.export({ type: "spki", format: "pem" }).toString()]]),
      maxArtifactByteLength: 1_000,
      corsAllowedOrigins: new Set(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/internal/verifier/reports",
      payload: envelope,
    });
    expect(response.statusCode).toBe(202);
    expect(received).toEqual(envelope);
    await app.close();
  });
});

describe("coordinator CORS policy", () => {
  it("accepts exact development origins", () => {
    expect(
      [...parseCorsAllowedOrigins("http://localhost:3000,https://ceremony.example", false)],
    ).toEqual(["http://localhost:3000", "https://ceremony.example"]);
  });

  it("rejects non-HTTPS production origins and origins with paths", () => {
    expect(() => parseCorsAllowedOrigins("http://ceremony.example", true)).toThrow(
      /HTTPS/u,
    );
    expect(() =>
      parseCorsAllowedOrigins("https://ceremony.example/path", false),
    ).toThrow(/invalid origin/u);
  });

  it("answers an allowed browser preflight before route authentication", async () => {
    const app = buildCoordinatorServer({
      operations: {} as CoordinatorOperations,
      participantAuth: {
        async authenticate() {
          throw new Error("authentication must not run for preflight");
        },
      },
      authenticateInternal() {
        throw new Error("internal authentication must not run for preflight");
      },
      verifierPublicKeys: new Map(),
      maxArtifactByteLength: 1_000,
      corsAllowedOrigins: new Set(["http://localhost:3000"]),
    });
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/ceremonies/test/queue",
      headers: { origin: "http://localhost:3000" },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    await app.close();
  });
});

describe("participant-scoped lease recovery", () => {
  it("scopes the ceremony recovery route to the authenticated participant", async () => {
    let lookup: { slug: string; participantId: string } | undefined;
    const app = buildCoordinatorServer({
      operations: {
        async getParticipantState(slug: string, participantId: string) {
          lookup = { slug, participantId };
          return {
            ceremonyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            participantId,
            queue: null,
            lease: null,
            submission: null,
          };
        },
      } as CoordinatorOperations,
      participantAuth: {
        async authenticate() {
          return { participantId: "22222222-2222-4222-8222-222222222222", pseudonym: "alice", authSubjectHash: "a".repeat(64) };
        },
      },
      authenticateInternal() { throw new Error("not used"); },
      verifierPublicKeys: new Map(),
      maxArtifactByteLength: 1_000,
      corsAllowedOrigins: new Set(),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/ceremonies/test-ceremony/me/state",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.headers.pragma).toBe("no-cache");
    expect(lookup).toEqual({
      slug: "test-ceremony",
      participantId: "22222222-2222-4222-8222-222222222222",
    });
    expect(response.json()).toEqual({
      ceremonyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      participantId: "22222222-2222-4222-8222-222222222222",
      queue: null,
      lease: null,
      submission: null,
    });
    await app.close();
  });

  it("passes only the authenticated participant ID to lease lookup", async () => {
    let lookup: { leaseId: string; participantId: string } | undefined;
    const app = buildCoordinatorServer({
      operations: {
        async getLease(leaseId: string, participantId: string) {
          lookup = { leaseId, participantId };
          return { leaseId, state: "SUBMITTED", submissionId: "33333333-3333-4333-8333-333333333333" };
        },
      } as CoordinatorOperations,
      participantAuth: {
        async authenticate() {
          return { participantId: "22222222-2222-4222-8222-222222222222", pseudonym: "alice", authSubjectHash: "a".repeat(64) };
        },
      },
      authenticateInternal() { throw new Error("not used"); },
      verifierPublicKeys: new Map(),
      maxArtifactByteLength: 1_000,
      corsAllowedOrigins: new Set(),
    });
    const response = await app.inject({ method: "GET", url: "/v1/leases/11111111-1111-4111-8111-111111111111" });
    expect(response.statusCode).toBe(200);
    expect(lookup).toEqual({
      leaseId: "11111111-1111-4111-8111-111111111111",
      participantId: "22222222-2222-4222-8222-222222222222",
    });
    expect(response.json()).toMatchObject({ state: "SUBMITTED", submissionId: "33333333-3333-4333-8333-333333333333" });
    await app.close();
  });

  it("returns the participant's submission ID from a submitted lease", async () => {
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        if (text.includes("FROM leases l LEFT JOIN submissions")) {
          return { rows: [{
            id: "11111111-1111-4111-8111-111111111111",
            state: "VERIFYING",
            expires_at: "2026-08-01T00:00:00.000Z",
            base_generation: 7,
            expected_contribution_name: "moss-participant",
            predecessor_sha256: "1".repeat(64),
            predecessor_byte_length: 460_000_000,
            submission_id: "33333333-3333-4333-8333-333333333333",
          }], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const { operations } = runtimeFixture(pool as unknown as Pool);
    const lease = await operations.getLease(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ) as { submissionId?: string };
    expect(lease.submissionId).toBe("33333333-3333-4333-8333-333333333333");
    expect(calls[0].values).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("recovers the latest durable accepted ticket, lease, submission, and receipt ID", async () => {
    const participantId = "22222222-2222-4222-8222-222222222222";
    const calls: Array<{ text: string; values?: readonly unknown[] }> = [];
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        calls.push({ text, values });
        if (text.includes("observed_time_high_water = greatest")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("AS target")) {
          return { rows: [{ state: "OPEN", target: "OPEN" }], rowCount: 1 };
        }
        if (text.includes("SELECT * FROM ceremonies")) {
          return { rows: [{ state: "OPEN" }], rowCount: 1 };
        }
        if (text.includes("FROM queue_tickets q") && text.includes("LEFT JOIN contributions")) {
          return { rows: [{
            ticket_id: "11111111-1111-4111-8111-111111111111",
            ticket_status: "COMPLETED",
            ticket_enqueued_at: "2026-07-20T00:00:00.000Z",
            lease_id: "33333333-3333-4333-8333-333333333333",
            lease_state: "ACCEPTED",
            lease_expires_at: "2026-07-21T00:00:00.000Z",
            base_generation: 7,
            predecessor_sha256: "1".repeat(64),
            predecessor_byte_length: 460_000_000,
            expected_contribution_name: "moss-participant",
            submission_id: "44444444-4444-4444-8444-444444444444",
            submission_state: "ACCEPTED",
            receipt_id: "44444444-4444-4444-8444-444444444444",
          }], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const { operations } = runtimeFixture(pool as unknown as Pool);
    const state = await operations.getParticipantState("test-ceremony", participantId);
    expect(state).toEqual({
      ceremonyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      participantId,
      queue: null,
      lease: {
        leaseId: "33333333-3333-4333-8333-333333333333",
        state: "ACCEPTED",
        expiresAt: "2026-07-21T00:00:00.000Z",
        baseGeneration: 7,
        expectedContributionName: "moss-participant",
        predecessor: {
          sha256: "1".repeat(64),
          byteLength: 460_000_000,
          downloadUrl: `https://ceremony.example/v1/ceremonies/test-ceremony/artifacts/${"1".repeat(64)}.zkey`,
        },
        submissionId: "44444444-4444-4444-8444-444444444444",
      },
      submission: {
        submissionId: "44444444-4444-4444-8444-444444444444",
        state: "ACCEPTED",
        receiptId: "44444444-4444-4444-8444-444444444444",
      },
    });
    const scoped = calls.find(({ text }) =>
      text.includes("FROM queue_tickets q") && text.includes("LEFT JOIN contributions"));
    expect(scoped?.values).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      participantId,
    ]);
    expect(scoped?.text).toContain("s.ceremony_id=q.ceremony_id");
    expect(scoped?.text).toContain("s.participant_id=q.participant_id");
    expect(scoped?.text).toContain("c.ceremony_id=q.ceremony_id");
    expect(scoped?.text).toContain("c.participant_id=q.participant_id");
  });
});

describe("participant-scoped upload recovery", () => {
  it("returns only the authenticated participant's durable upload state", async () => {
    let lookup: { uploadId: string; participantId: string } | undefined;
    const app = buildCoordinatorServer({
      operations: {
        async getUpload(uploadId: string, participantId: string) {
          lookup = { uploadId, participantId };
          return {
            uploadId,
            state: "COMPLETED",
            expiresAt: "2026-08-01T00:00:00.000Z",
            artifact: { sha256: "a".repeat(64), byteLength: 123 },
          };
        },
      } as CoordinatorOperations,
      participantAuth: {
        async authenticate() {
          return {
            participantId: "22222222-2222-4222-8222-222222222222",
            pseudonym: "alice",
            authSubjectHash: "a".repeat(64),
          };
        },
      },
      authenticateInternal() { throw new Error("not used"); },
      verifierPublicKeys: new Map(),
      maxArtifactByteLength: 1_000,
      corsAllowedOrigins: new Set(),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/uploads/55555555-5555-4555-8555-555555555555",
    });
    expect(response.statusCode).toBe(200);
    expect(lookup).toEqual({
      uploadId: "55555555-5555-4555-8555-555555555555",
      participantId: "22222222-2222-4222-8222-222222222222",
    });
    expect(response.json()).toMatchObject({
      state: "COMPLETED",
      artifact: { sha256: "a".repeat(64), byteLength: 123 },
    });
    await app.close();
  });
});

describe("coordinator upload identity boundary", () => {
  it("keeps the coordinator UUID public and persists a provider upload ID only server-side", async () => {
    let persistedGrant: Record<string, unknown> | undefined;
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        if (text.includes("observed_time_high_water = greatest")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("AS target")) {
          return { rows: [{ state: "OPEN", target: "OPEN" }], rowCount: 1 };
        }
        if (text.includes("SELECT * FROM ceremonies")) return { rows: [{ state: "OPEN" }], rowCount: 1 };
        if (text.includes("WITH expired AS")) return { rows: [], rowCount: 0 };
        if (text.includes("SELECT id,store_grant FROM artifact_uploads")) return { rows: [], rowCount: 0 };
        if (text.includes("SELECT ceremony_id,expires_at FROM leases")) {
          return { rows: [{
            ceremony_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            expires_at: "2026-08-01T00:00:00.000Z",
          }], rowCount: 1 };
        }
        if (text.includes("INSERT INTO artifact_uploads")) {
          persistedGrant = JSON.parse(String(values?.[4])) as Record<string, unknown>;
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const store = {
      async createUpload() {
        return {
          uploadId: "provider-multipart-secret",
          objectKey: "quarantine/candidate.zkey",
          expiresAt: "2026-08-01T00:00:00.000Z",
          method: "s3-multipart" as const,
          uploadUrl: "https://storage.example.test/upload",
        };
      },
    } as unknown as ArtifactStore;
    const { operations } = runtimeFixture(pool as unknown as Pool, store);
    const grant = await operations.createUpload(
      "33333333-3333-4333-8333-333333333333",
      "22222222-2222-4222-8222-222222222222",
    );
    expect(grant.uploadId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(grant).not.toHaveProperty("backendUploadId");
    expect(grant.uploadId).not.toBe("provider-multipart-secret");
    expect(persistedGrant).toMatchObject({
      uploadId: grant.uploadId,
      backendUploadId: "provider-multipart-secret",
    });
  });
});

describe("canonical artifact version boundary", () => {
  it("opens the exact object key and storage version persisted at acceptance", async () => {
    const sha256 = "a".repeat(64);
    const pinned = {
      backend: "s3" as const,
      objectKey: `canonical/test/sha256/${sha256}.zkey`,
      versionId: "accepted-object-version",
      sha256,
      byteLength: 4,
      immutable: true as const,
    };
    let statInput: unknown;
    let openInput: unknown;
    const pool = {
      async query(text: string) {
        if (text.includes("FROM artifacts WHERE ceremony_id=$1")) {
          return {
            rows: [{
              sha256,
              byte_length: 4,
              storage_backend: "s3",
              object_key: pinned.objectKey,
              storage_version_id: pinned.versionId,
              immutable: true,
            }],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const store = {
      async statCanonical(input: unknown) {
        statInput = input;
        return pinned;
      },
      async openCanonical(input: unknown) {
        openInput = input;
        return Readable.from([Buffer.from("test")]);
      },
    } as unknown as ArtifactStore;
    const { operations } = runtimeFixture(pool as unknown as Pool, store);
    const opened = await operations.openCanonicalArtifact(
      "test-ceremony",
      sha256,
    );
    expect(statInput).toEqual(pinned);
    expect(openInput).toEqual(pinned);
    expect(opened.byteLength).toBe(4);
  });
});

describe("hosted participant artifact delivery", () => {
  const sha256 = "a".repeat(64);
  const ceremonyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const objectKey = `canonical/${ceremonyId}/sha256/${sha256}.zkey`;
  function fixture(pin: { objectKey?: string; versionId?: string } = {}, archived = true) {
    const pool = {
      async query(text: string) {
        if (text.includes("FROM leases l LEFT JOIN submissions")) return { rows: [{
          id: "lease", state: "ACTIVE", expires_at: "2026-09-26T00:00:00.000Z",
          base_generation: 0, expected_contribution_name: "test", predecessor_sha256: sha256,
          predecessor_byte_length: 368440348,
        }] };
        if (archived && text.includes("FROM artifacts WHERE ceremony_id=$1")) return { rows: [{
          sha256, byte_length: 368440348, storage_backend: "s3", immutable: true,
          object_key: pin.objectKey ?? objectKey, storage_version_id: pin.versionId ?? "version+/=1",
        }] };
        throw new Error("unexpected query");
      },
    };
    return runtimeFixture(pool as unknown as Pool, {} as ArtifactStore, archived ? {
      purpose: "rehearsal", primaryPublication: { archiveBaseUrl: "https://archive.example" },
    } : {}).operations;
  }
  it("gives the browser the committed CDN object version instead of streaming through the API", async () => {
    const lease = await fixture().getLease("lease", "participant") as { predecessor: { downloadUrl: string; byteLength: number } };
    const url = new URL(lease.predecessor.downloadUrl);
    expect(url.origin).toBe("https://archive.example");
    expect(url.pathname).toBe(`/${objectKey}`);
    expect(url.searchParams.get("versionId")).toBe("version+/=1");
    expect(lease.predecessor.byteLength).toBe(368440348);
  });
  it.each(["", "null"])("rejects an unversioned canonical pin (%s)", async versionId => {
    await expect(fixture({ versionId }).getLease("lease", "participant")).rejects.toThrow("artifact pin is invalid");
  });
  it("rejects a canonical key from another ceremony", async () => {
    await expect(fixture({ objectKey: `canonical/other/sha256/${sha256}.zkey` }).getLease("lease", "participant"))
      .rejects.toThrow("artifact pin is invalid");
  });
  it("preserves loopback transport for manifests without archive publication", async () => {
    const lease = await fixture({}, false).getLease("lease", "participant") as { predecessor: { downloadUrl: string } };
    expect(lease.predecessor.downloadUrl).toBe(`https://ceremony.example/v1/ceremonies/test-ceremony/artifacts/${sha256}.zkey`);
  });
  it("redirects existing history/audit links without loading artifact bytes through the gateway", async () => {
    const app = buildCoordinatorServer({
      operations: fixture(),
      participantAuth: { async authenticate() { throw new Error("not used"); } },
      authenticateInternal() { throw new Error("not used"); },
      verifierPublicKeys: new Map(), maxArtifactByteLength: 600000000,
      corsAllowedOrigins: new Set(),
    });
    try {
      const response = await app.inject({ method: "GET",
        url: `/v1/ceremonies/test-ceremony/artifacts/${sha256}.zkey`, headers: { range: "bytes=0-31" } });
      expect(response.statusCode).toBe(307);
      expect(new URL(response.headers.location!).searchParams.get("versionId")).toBe("version+/=1");
      expect(response.body).toBe("");
    } finally { await app.close(); }
  });
});

describe("verifier job lease renewal", () => {
  it("renews only the authenticated operator's live job inside the signed epoch", async () => {
    let statement: { text: string; values?: readonly unknown[] } | undefined;
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        statement = { text, values };
        return {
          rows: [{ lease_until: "2026-08-01T00:10:00.000Z" }],
          rowCount: 1,
        };
      },
    };
    const { operations } = runtimeFixture(pool as unknown as Pool);
    await expect(operations.heartbeatVerifierJob(
      "11111111-1111-4111-8111-111111111111",
      "verifier-test",
    )).resolves.toEqual({ leaseExpiresAt: "2026-08-01T00:10:00.000Z" });
    expect(statement?.text).toContain("j.job_id=$1 AND j.operator_key_id=$2");
    expect(statement?.text).toContain("j.lease_until>clock_timestamp()");
    expect(statement?.text).toContain("clock_timestamp()<c.seals_at");
    expect(statement?.values?.slice(0, 2)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "verifier-test",
    ]);
  });
});

describe("verifier retry attempt accounting", () => {
  it("claims work based on distinct valid pass numbers across prior attempts", async () => {
    let candidateQuery = "";
    const transactionClient = {
      async query(text: string) {
        if (text.includes("SELECT s.*,l.expected_contribution_name")) {
          candidateQuery = text;
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const pool = {
      async query(text: string) {
        if (text.includes("SELECT * FROM ceremonies")) {
          return { rows: [{ state: "OPEN" }], rowCount: 1 };
        }
        if (text.includes("SELECT submission_id,count(*)::text")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("SELECT id FROM submissions")) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      },
      async connect() { return transactionClient; },
    };
    const { operations } = runtimeFixture(pool as unknown as Pool);
    await expect(operations.claimVerifierJob("verifier-test")).resolves.toBeNull();
    expect(candidateQuery).toContain("count(DISTINCT r.pass_number)");
  });

  it("scopes persistence and error exhaustion to the exact live retry attempt", async () => {
    const envelope = verifierErrorEnvelope();
    const transactionStatements: Array<{ text: string; values?: readonly unknown[] }> = [];
    const poolStatements: Array<{ text: string; values?: readonly unknown[] }> = [];
    const transactionClient = {
      async query(text: string, values?: readonly unknown[]) {
        transactionStatements.push({ text, values });
        if (text.includes("SELECT s.candidate_sha256,s.ceremony_id,s.predecessor_sha256")) {
          return { rows: [{
            candidate_sha256: envelope.payload.candidateSha256,
            ceremony_id: envelope.payload.ceremonyId,
            predecessor_sha256: envelope.payload.predecessorSha256,
            claimed_contribution_hash: envelope.payload.expectedContributionHashBlake2b512,
            expected_contribution_name: envelope.payload.expectedContributionName,
            base_generation: envelope.payload.expectedContributionIndex - 1,
            genesis_sha256: envelope.payload.genesisSha256,
            verifier_policy: { operatorKeyIds: ["verifier-test"], requiredOperators: 1, passesPerOperator: 2 },
            verifier_keys: [{ keyId: "verifier-test", verifierImageDigest: envelope.payload.verifierImageDigest }],
            job_live: true,
          }], rowCount: 1 };
        }
        if (text.includes("SELECT payload,signature,result FROM verification_reports")) {
          return { rows: [], rowCount: 0 };
        }
        if (text.includes("INSERT INTO verification_reports")) return { rows: [{}], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const pool = {
      async query(text: string, values?: readonly unknown[]) {
        poolStatements.push({ text, values });
        if (text.includes("SELECT result FROM verification_reports")) {
          return { rows: [{ result: "error" }], rowCount: 1 };
        }
        if (text.includes("AS current_attempt_count")) {
          return { rows: [{ valid_count: "1", current_attempt_count: "2" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      async connect() { return transactionClient; },
    };
    const { operations } = runtimeFixture(pool as unknown as Pool);
    await expect(operations.recordVerifierReport(envelope)).resolves.toBeUndefined();

    const persisted = poolStatements.find(({ text }) => text.includes("SELECT result FROM verification_reports"));
    expect(persisted?.text).toContain("job_id=$4 AND job_attempt=$5");
    expect(persisted?.values?.slice(-2)).toEqual([
      envelope.payload.jobId,
      envelope.payload.jobAttempt,
    ]);
    const progress = poolStatements.find(({ text }) => text.includes("AS current_attempt_count"));
    expect(progress?.text).toContain("count(DISTINCT pass_number)");
    expect(progress?.text).toContain("job_id=$3 AND job_attempt=$4");
    const expired = poolStatements.find(({ text }) => text.includes("SET state='EXPIRED'"));
    expect(expired?.text).toContain("attempt=$3");
    expect(expired?.values).toEqual([
      envelope.payload.jobId,
      envelope.payload.operatorKeyId,
      envelope.payload.jobAttempt,
    ]);
  });
});

describe("checkpoint schedule synchronization", () => {
  it("transitions OPEN to SEALED before signing a checkpoint", async () => {
    let state = "OPEN";
    const statements: string[] = [];
    const pool = {
      async query(text: string) {
        statements.push(text);
        if (text.includes("observed_time_high_water = greatest")) {
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("AS target")) {
          return { rows: [{ state, target: "SEALED" }], rowCount: 1 };
        }
        if (text.includes("UPDATE ceremonies SET state=$2")) {
          state = "SEALED";
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("SELECT * FROM ceremonies")) {
          return { rows: [{
            state, revision: 2, head_generation: 1, head_sha256: "1".repeat(64),
            head_byte_length: 460_000_000, event_sequence: 1, event_hash: "2".repeat(64),
          }], rowCount: 1 };
        }
        if (text.includes("WITH stale_submissions")) return { rows: [], rowCount: 0 };
        throw new Error(`unexpected query: ${text}`);
      },
    };
    const { operations, publicKey } = runtimeFixture(pool as unknown as Pool);
    const envelope = await operations.getCheckpoint("test-ceremony");
    // Observed time advances first, so a rolled-back clock cannot satisfy the
    // head compare-and-swap afterwards. The decision is then read from the
    // database clock and put through the declared state machine before
    // anything is written.
    expect(statements[0]).toContain("observed_time_high_water = greatest");
    expect(statements[1]).toContain("AS target");
    expect(statements[1]).toContain(
      "state='PREPARED' AND now()>=seals_at THEN 'SEALED'",
    );
    expect(statements[2]).toContain("UPDATE ceremonies SET state=$2");
    expect(envelope.payload.state).toBe("SEALED");
    const verified = verifyEnvelope(envelope as never, { publicKey, domain: CHECKPOINT_SIGNATURE_DOMAIN }) as unknown as { state: string };
    expect(verified.state).toBe("SEALED");
  });
});

function runtimeFixture(pool: Pool, store: ArtifactStore = {} as ArtifactStore, overrides: Partial<CeremonyManifestV1> = {}) {
  const coordinator = generateKeyPairSync("ed25519");
  const verifier = generateKeyPairSync("ed25519");
  const manifest: CeremonyManifestV1 = {
    schemaVersion: 1,
    ceremonyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "test-ceremony",
    relation: {
      profile: "google-rs256-zksync-v3", relationId: "google-rs256-zksync-v3-groth16-bn254-2",
      verifierVersion: 4, proofSystem: "groth16", curve: "bn254", sourceRepository: "local",
      sourceCommit: "local", sourceClosureSha256: "a".repeat(64), circomVersion: "2.2.3", snarkjsVersion: "0.7.6",
      r1cs: artifact("1"), ptau: { ...artifact("2"), blake2b512: "3".repeat(128) }, genesisZkey: artifact("4"),
    },
    schedule: { opensAt: "2026-07-01T00:00:00.000Z", sealsAt: "2026-07-29T00:00:00.000Z" },
    beacon: { source: "drand", chainHash: "local", round: 1, expectedAt: "2026-08-01T00:00:00.000Z",
      derivation: "MOSS_PHASE2_BEACON_V1", numIterationsExp: 10, contributionName: "beacon" },
    coordinatorKeys: [{ keyId: "coordinator-test", algorithm: "Ed25519", publicKeyPem: coordinator.publicKey.export({ type: "spki", format: "pem" }).toString() }],
    verifierKeys: [{ keyId: "verifier-test", algorithm: "Ed25519", publicKeyPem: verifier.publicKey.export({ type: "spki", format: "pem" }).toString(), verifierImageDigest: `sha256:${"5".repeat(64)}` }],
    verifierPolicy: { operatorKeyIds: ["verifier-test"], requiredOperators: 1, passesPerOperator: 2 },
    contributionPolicy: { targetContributions: 10, maximumContributions: 10, maxArtifactByteLength: 1_000_000_000,
      requirePinnedClientRelease: false, lease: { offerSeconds: 60, absoluteSeconds: 3_600, heartbeatSeconds: 30 },
      verifierJobSeconds: 3_600, verifierMaxAttempts: 3 },
    webRelease: { ...artifact("6"), sourceCommit: "local" },
    cliReleases: [{ ...artifact("7"), sourceCommit: "local" }],
    ...overrides,
  };
  return {
    operations: new PostgresCoordinatorOperations({
      pool, store, manifestEnvelope: { schemaVersion: 1, keyId: "root", payload: manifest, signature: "x" },
      coordinatorKeyId: "coordinator-test", coordinatorPrivateKey: coordinator.privateKey,
      publicBaseUrl: "https://ceremony.example", genesisZkeyPath: "/unused", production: false,
    }),
    publicKey: coordinator.publicKey,
  };
}

function artifact(digit: string) {
  return { sha256: digit.repeat(64), byteLength: 100, urls: [`https://example.test/${digit}`] };
}

function verifierErrorEnvelope(): SignedEnvelope<VerificationReportV1> {
  return {
    schemaVersion: 1,
    keyId: "verifier-test",
    signature: "test-signature",
    payload: {
      schemaVersion: 1,
      type: "moss.phase2.verification-report.v1",
      ceremonyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      submissionId: "22222222-2222-4222-8222-222222222222",
      jobId: "33333333-3333-4333-8333-333333333333",
      jobAttempt: 2,
      predecessorSha256: "8".repeat(64),
      candidateSha256: "9".repeat(64),
      genesisSha256: "4".repeat(64),
      expectedContributionName: "moss-participant",
      expectedContributionHashBlake2b512: "a".repeat(128),
      expectedContributionIndex: 1,
      observedContributionName: null,
      observedContributionHashBlake2b512: null,
      observedContributionIndex: null,
      operatorKeyId: "verifier-test",
      verifierImageDigest: `sha256:${"5".repeat(64)}`,
      snarkjsVersion: "0.7.6",
      passNumber: 2,
      checks: {
        objectHash: true,
        framing: false,
        exactPrefix: false,
        exactlyOneContribution: false,
        contributionMetadata: false,
        contributionHash: false,
        verifyFromInit: false,
      },
      result: "error",
      errorCode: "VERIFIER_PROCESS_ERROR",
      startedAt: "2026-07-30T00:00:00.000Z",
      completedAt: "2026-07-30T00:00:01.000Z",
    },
  };
}

describe("public contribution history", () => {
  it("requires no auth and rejects invalid cursors before accessing storage", async () => {
    const seen: Array<[string, number, number]> = [];
    const app = buildCoordinatorServer({
      operations: { async listContributions(slug: string, after: number, limit: number) { seen.push([slug, after, limit]); return []; } } as unknown as CoordinatorOperations,
      participantAuth: { async authenticate() { throw new Error("must not authenticate public history"); } },
      authenticateInternal() { throw new Error("must not authenticate public history"); },
      verifierPublicKeys: new Map(), maxArtifactByteLength: 1_000, corsAllowedOrigins: new Set(),
    });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/ceremonies/test/contributions?after=50" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ receipts: [] });
      expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
      for (const cursor of ["-1", "1.5", "1e2", "9007199254740992", "abc"]) {
        expect((await app.inject({ method: "GET", url: `/v1/ceremonies/test/contributions?after=${cursor}` })).statusCode).toBe(400);
      }
      for (const limit of ["0", "51", "05", "1.5", "abc"]) {
        expect((await app.inject({ method: "GET", url: `/v1/ceremonies/test/contributions?after=0&limit=${limit}` })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: "GET", url: "/v1/ceremonies/test/contributions?after=5&limit=5" })).statusCode).toBe(200);
      expect(seen).toEqual([["test", 50, 50], ["test", 5, 5]]);
    } finally { await app.close(); }
  });

  it("returns only accepted signed receipts scoped to the ceremony with a bounded page", async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = [];
    const payload = { type: "test-receipt" };
    const { operations } = runtimeFixture({ async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      return { rows: [{ receipt: payload, receipt_signature: "signature", participant_id: "private", auth_subject_hash: "private" }], rowCount: 1 };
    } } as unknown as Pool);
    expect(await operations.listContributions("test-ceremony", 50)).toEqual([
      { schemaVersion: 1, keyId: "coordinator-test", payload, signature: "signature" },
    ]);
    expect(queries[0]?.text).toContain("WHERE ceremony_id=$1 AND generation>$2 ORDER BY generation ASC LIMIT $3");
    expect(queries[0]?.values).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 50, 50]);
    await operations.listContributions("test-ceremony", 5, 5);
    expect(queries[1]?.values).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 5, 5]);
    await expect(operations.listContributions("wrong-ceremony", 0)).rejects.toThrow();
    await expect(operations.listContributions("test-ceremony", -1)).rejects.toThrow();
    for (const limit of [0, 51, 1.5]) await expect(operations.listContributions("test-ceremony", 0, limit)).rejects.toThrow();
    expect(queries).toHaveLength(2);
  });

  it("lets a CDN keep a full page, since accepted receipts never change", async () => {
    const receipt = { schemaVersion: 1, keyId: "coordinator-test", payload: {}, signature: "signature" };
    const app = buildCoordinatorServer({
      operations: { async listContributions(_slug: string, _after: number, limit: number) { return Array(Math.min(limit, 3)).fill(receipt); } } as unknown as CoordinatorOperations,
      participantAuth: { async authenticate() { throw new Error("must not authenticate public history"); } },
      authenticateInternal() { throw new Error("must not authenticate public history"); },
      verifierPublicKeys: new Map(), maxArtifactByteLength: 1_000, corsAllowedOrigins: new Set(),
    });
    try {
      const full = await app.inject({ method: "GET", url: "/v1/ceremonies/test/contributions?after=0&limit=3" });
      expect(full.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(full.headers.vary).toBe("origin");
      expect(full.headers.pragma).toBeUndefined();
      const partial = await app.inject({ method: "GET", url: "/v1/ceremonies/test/contributions?after=0&limit=5" });
      expect(partial.headers["cache-control"]).toBe("no-store, max-age=0");
    } finally { await app.close(); }
  });
});

it("exposes only public witness acknowledgements with bounded sequence pagination", async () => {
  const seen: Array<[string, number]> = [];
  const app = buildCoordinatorServer({
    operations: { async listPublications(slug: string, after: number) { seen.push([slug, after]); return []; } } as unknown as CoordinatorOperations,
    participantAuth: { async authenticate() { throw new Error("unexpected auth"); } },
    authenticateInternal() { throw new Error("unexpected auth"); }, verifierPublicKeys: new Map(),
    maxArtifactByteLength: 1000, corsAllowedOrigins: new Set(),
  });
  try {
    expect((await app.inject({ method: "GET", url: "/v1/ceremonies/test/publications" })).json()).toEqual({ acknowledgements: [] });
    expect((await app.inject({ method: "GET", url: "/v1/ceremonies/test/publications?after=0" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/ceremonies/test/publications?after=-1" })).statusCode).toBe(400);
    expect(seen).toEqual([["test", -1], ["test", 0]]);
  } finally { await app.close(); }
});


describe("gateway bodyless requests", () => {
  it("accepts framed empty upload initiation, authenticates it, and rejects unsupported payloads", async () => {
    let authenticated = 0;
    const created: string[][] = [];
    const participantId = "123e4567-e89b-42d3-a456-426614174000";
    const app = buildCoordinatorServer({
      operations: { async createUpload(leaseId: string, owner: string) {
        created.push([leaseId, owner]); return { uploadId: "test-upload" };
      } } as unknown as CoordinatorOperations,
      participantAuth: { async authenticate() {
        authenticated++;
        return { participantId, pseudonym: "alice", authSubjectHash: "1".repeat(64) };
      } },
      authenticateInternal() { throw new Error("not used"); },
      verifierPublicKeys: new Map(), maxArtifactByteLength: 1_000, corsAllowedOrigins: new Set(),
    });
    try {
      const url = "/v1/leases/test-lease/uploads";
      for (const contentType of [undefined, "application/x-www-form-urlencoded", "application/x-unknown"]) {
        const headers = { "transfer-encoding": "chunked", ...(contentType ? { "content-type": contentType } : {}) };
        const empty = await app.inject({ method: "POST", url, headers, payload: "" });
        expect(empty.statusCode).toBe(201);
        expect(empty.json()).toEqual({ uploadId: "test-upload" });
        const nonempty = await app.inject({ method: "POST", url, headers, payload: Buffer.from("unexpected") });
        expect(nonempty.statusCode).toBe(415);
      }
      expect(authenticated).toBe(3);
      expect(created).toEqual(Array.from({ length: 3 }, () => ["test-lease", participantId]));
      for (const url of ["/v1/uploads/test-upload/parts", "/v1/uploads/test-upload/complete", "/v1/leases/test-lease/submit"]) {
        expect((await app.inject({ method: "POST", url, headers: {
          "transfer-encoding": "chunked", "content-type": "application/x-unknown",
        }, payload: "" })).statusCode).toBe(415);
      }
    } finally { await app.close(); }
  });

  it("accepts proxy-framed empty controls without accepting protocol payloads", async () => {
    let joins = 0;
    const app = buildCoordinatorServer({
      operations: { async joinQueue() { joins++; return { status: "QUEUED" }; } } as unknown as CoordinatorOperations,
      participantAuth: { async authenticate() { return {
        participantId: "123e4567-e89b-42d3-a456-426614174000", pseudonym: "alice", authSubjectHash: "1".repeat(64),
      }; } },
      authenticateInternal() { throw new Error("not used"); },
      verifierPublicKeys: new Map(), maxArtifactByteLength: 1_000, corsAllowedOrigins: new Set(),
    });
    try {
      const headers = { "transfer-encoding": "chunked", "idempotency-key": "gateway-empty-post-01" };
      const empty = await app.inject({ method: "POST", url: "/v1/ceremonies/test/queue", headers, payload: "" });
      expect(empty.statusCode).toBe(201);
      const nonempty = await app.inject({ method: "POST", url: "/v1/ceremonies/test/queue", headers, payload: Buffer.from("unexpected") });
      expect(nonempty.statusCode).toBe(415);
      const unknown = await app.inject({ method: "POST", url: "/v1/ceremonies/test/queue", headers: { ...headers, "content-type": "application/x-unknown" }, payload: "" });
      expect(unknown.statusCode).toBe(201);
      const form = await app.inject({ method: "POST", url: "/v1/ceremonies/test/queue", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, payload: "" });
      expect(form.statusCode).toBe(201);
      const formPayload = await app.inject({ method: "POST", url: "/v1/ceremonies/test/queue", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, payload: "name=unexpected" });
      expect(formPayload.statusCode).toBe(415);
      const protocol = await app.inject({ method: "POST", url: "/v1/internal/verifier/reports", headers: { ...headers, "content-type": "application/x-unknown" }, payload: "" });
      expect(protocol.statusCode).toBe(415);
      expect(joins).toBe(3);
    } finally { await app.close(); }
  });
});
