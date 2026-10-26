import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, signEnvelope, type CeremonyManifestV1, type ContributionReceiptV1, type JsonValue } from "@moss/phase2-protocol";

const keys = generateKeyPairSync("ed25519");
const artifact = (digit: string) => ({ sha256: digit.repeat(64), byteLength: 100, urls: ["https://example.test/artifact"] });
const manifest = {
  ceremonyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", slug: "test",
  relation: { genesisZkey: artifact("1") },
  coordinatorKeys: [{ keyId: "coordinator", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }],
  contributionPolicy: { maximumContributions: 3 },
  verifierPolicy: { operatorKeyIds: ["verifier-test"], requiredOperators: 1, passesPerOperator: 1 },
} as CeremonyManifestV1;
const manifestHash = createHash("sha256").update("MOSS_PHASE2_MANIFEST_PAYLOAD_V1\0").update(canonicalize(manifest as unknown as JsonValue)).digest("hex");
const payload: ContributionReceiptV1 = {
  schemaVersion: 1, type: "moss.phase2.receipt.v1", ceremonyId: manifest.ceremonyId,
  relationManifestSha256: manifestHash, sequence: 1, generation: 1, contributionIndex: 1,
  predecessor: artifact("1"), successor: artifact("2"), contributionName: "Alice's contribution",
  contributionHashBlake2b512: "3".repeat(128), participantPseudonym: "Alice",
  clientKind: "cli", clientReleaseSha256: null, acceptedAt: "2026-09-22T12:00:00.000Z", transcriptEventHash: "4".repeat(64),
};
const signed = (value: unknown, domain = "MOSS_PHASE2_RECEIPT_V1") => signEnvelope(value as JsonValue, { keyId: "coordinator", privateKey: keys.privateKey, domain });

const participantId = "14e98dbb-d0f7-8ec4-8c44-e89dfd15e169";
let api: typeof import("./api");
let storage: Map<string, string>;
beforeEach(async () => {
  vi.resetModules(); storage = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
  api = await import("./api");
});
afterEach(() => vi.unstubAllGlobals());

function network(state = "VERIFYING", envelope: unknown = signed(payload), owner = participantId) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = String(input);
    if (url === "/api/ceremony/bootstrap") return Response.json({ coordinatorBaseUrl: "https://coordinator.test", manifest: { payload: manifest } });
    if (url === "/api/ceremony/auth/token") return Response.json({ token: "test", expiresAt: Date.now() / 1000 + 600, participantId, participantName: "Alice" });
    if (url.endsWith("/me/state")) return Response.json({ ceremonyId: manifest.ceremonyId, participantId: owner, queue: null, lease: null,
      submission: { submissionId: "submission-1", state, ...(state === "ACCEPTED" ? {receiptId: "receipt-1"} : {}) } });
    if (url.endsWith("/receipts/receipt-1")) return Response.json(envelope);
    throw Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetchMock); return fetchMock;
}

describe("participant activity recovery", () => {
  it("recovers pending verification after reload without claiming or resubmitting", async () => {
    const requests = network();
    expect(await api.getParticipantActivity(undefined, participantId)).toMatchObject({ state: {submission: {state: "VERIFYING"}}, receipts: [] });
    expect(requests.mock.calls.some(([url]) => String(url).includes("/receipts/"))).toBe(false);
  });
  it("recovers accepted receipts on a fresh device and does not invent local evidence", async () => {
    network("ACCEPTED");
    const activity = await api.getParticipantActivity(undefined, participantId);
    expect(activity.receipts).toHaveLength(1);
    expect(activity.receipts[0]?.signedReceipt).toEqual(signed(payload));
    expect(JSON.parse(storage.get("moss.phase2.contribution-journals.v1")!)[0].evidence).toBeUndefined();
    expect((await api.getMyReceipts()).receipts).toHaveLength(1);
  });
  it("observes verification becoming accepted without a new contribution", async () => {
    network(); expect((await api.getParticipantActivity()).receipts).toHaveLength(0);
    network("ACCEPTED"); expect((await api.getParticipantActivity()).receipts).toHaveLength(1);
  });
  it("rejects a tampered receipt rather than showing acceptance", async () => {
    network("ACCEPTED", { ...signed(payload), payload: {...payload, successor: artifact("8")} });
    await expect(api.getParticipantActivity()).rejects.toThrow(/signature/);
  });
  it("rejects another account and wrong participant state", async () => {
    network(); await expect(api.getParticipantActivity(undefined, "other-account")).rejects.toThrow(/Sign-in changed/);
    network("VERIFYING", signed(payload), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await expect(api.getParticipantActivity()).rejects.toThrow(/wrong identity/);
  });
  it("still rejects a receipt that disagrees with existing local evidence", async () => {
    storage.set("moss.phase2.contribution-journals.v1", JSON.stringify([{
      schemaVersion: 1, ceremonyId: manifest.ceremonyId, participantId, updatedAt: new Date().toISOString(), submissionId: "submission-1",
      evidence: {manifestSha256: manifestHash, predecessorSha256: payload.predecessor.sha256, predecessorByteLength: 100,
        successorSha256: "9".repeat(64), successorByteLength: 100, contributionHashBlake2b512: payload.contributionHashBlake2b512,
        contributionName: payload.contributionName, baseGeneration: 0},
    }]));
    network("ACCEPTED"); await expect(api.getParticipantActivity()).rejects.toThrow(/differs from the browser contribution journal/);
  });
});
