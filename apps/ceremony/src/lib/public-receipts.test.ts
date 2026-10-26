import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, signEnvelope, type CeremonyManifestV1, type ContributionReceiptV1, type JsonValue } from "@moss/phase2-protocol";

const keys = generateKeyPairSync("ed25519");
const artifact = (digit: string) => ({ sha256: digit.repeat(64), byteLength: 100, urls: ["https://example.test/artifact"] });
const manifest = {
  ceremonyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", slug: "test",
  relation: { genesisZkey: artifact("1") },
  coordinatorKeys: [{ keyId: "coordinator", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }],
  contributionPolicy: { maximumContributions: 100 },
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
const cliReceipt = () => ({ receiptEnvelope: signed(payload), localEvidence: {
  predecessorSha256: payload.predecessor.sha256, successorSha256: payload.successor.sha256,
  contributionHashBlake2b512: payload.contributionHashBlake2b512, contributionName: payload.contributionName,
  submissionId: "unsigned-and-not-displayed",
} });
let api: typeof import("./api");
beforeEach(async () => { vi.resetModules(); api = await import("./api"); });
afterEach(() => vi.unstubAllGlobals());

function network(receipts: unknown[] | ((after: number) => unknown[]) = [signed(payload)], generation = 1, head = artifact("2")) {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === "/api/ceremony/bootstrap") return Response.json({ coordinatorBaseUrl: "https://coordinator.test", manifest: { payload: manifest } });
    if (url.endsWith("/checkpoint")) return Response.json(signed({
      schemaVersion: 1, type: "moss.phase2.checkpoint.v1", ceremonyId: manifest.ceremonyId,
      state: "OPEN", revision: generation, generation, headSha256: head.sha256, headByteLength: head.byteLength,
      eventSequence: generation, eventHash: payload.transcriptEventHash,
      issuedAt: new Date(Date.now() - 1_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, "MOSS_PHASE2_CHECKPOINT_V1"));
    if (url.includes("/contributions?after=")) return Response.json({ receipts: typeof receipts === "function" ? receipts(Number(new URL(url).searchParams.get("after"))) : receipts });
    throw new Error("Unexpected request, including authentication: " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("public receipt verification", () => {
  it("accepts real signed CLI, browser, and raw formats without participant authentication", async () => {
    const fetchMock = network();
    for (const value of [cliReceipt(), { signedReceipt: signed(payload), contributionIndex: 1, contributionHash: payload.successor.sha256 }, signed(payload)]) {
      const [result] = await api.verifyReceiptDocument(JSON.stringify(value));
      expect(result?.receipt.participantPseudonym).toBe("Alice");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/ceremony/bootstrap");
  });
  it("rejects tampered signatures and unauthorized signers", async () => {
    const bad = signed(payload);
    await expect(api.verifyPublicReceipt({ ...bad, payload: { ...payload, participantPseudonym: "Mallory" } }, manifest)).rejects.toThrow(/signature/);
    await expect(api.verifyPublicReceipt({ ...bad, keyId: "attacker" }, manifest)).rejects.toThrow(/signing key/);
  });
  it("rejects wrong ceremony, manifest, genesis and malformed signed fields", async () => {
    for (const patch of [{ ceremonyId: "other" }, { relationManifestSha256: "0".repeat(64) },
      { predecessor: artifact("9") }, { sequence: 0 }, { participantPseudonym: 42 }, { contributionIndex: 2 }]) {
      await expect(api.verifyPublicReceipt(signed({ ...payload, ...patch }), manifest)).rejects.toThrow();
    }
  });
  it("rejects mismatched CLI evidence and browser summaries", async () => {
    const cli = cliReceipt(); cli.localEvidence.successorSha256 = "9".repeat(64);
    await expect(api.verifyPublicReceipt(cli, manifest)).rejects.toThrow(/evidence/);
    await expect(api.verifyPublicReceipt({ signedReceipt: signed(payload), contributionIndex: 9 }, manifest)).rejects.toThrow(/summary/);
  });
  it("rejects invalid, oversized, empty and duplicate documents", async () => {
    network();
    for (const text of ["not json", "x".repeat(1_048_577), "[]", JSON.stringify([signed(payload), signed(payload)])]) {
      await expect(api.verifyReceiptDocument(text)).rejects.toThrow();
    }
  });
});

describe("public contribution history", () => {
  const receipt = (generation: number, predecessor: string, successor: string) => ({
    ...payload, generation, contributionIndex: generation, sequence: generation,
    predecessor: artifact(predecessor), successor: artifact(successor),
  });
  /** Ten accepted contributions: #n turns artifact n into artifact n+1 (hex digits). */
  const chain = Array.from({ length: 10 }, (_, i) => receipt(i + 1, (i + 1).toString(16), (i + 2).toString(16)));
  const serveChain = (receipts = chain) => network((after) => receipts.slice(after).map((value) => signed(value)), receipts.length, artifact((receipts.length + 1).toString(16)));

  it("verifies one receipt through the signed head without auth", async () => {
    network();
    expect(await api.getContributionHistoryPage(0)).toEqual({ total: 1, items: [expect.objectContaining({ receipt: payload })] });
  });
  it("fetches only the requested page, newest first", async () => {
    const fetchMock = serveChain();
    const first = await api.getContributionHistoryPage(0);
    expect(first.total).toBe(10);
    expect(first.items.map(({ receipt }) => receipt.generation)).toEqual([10, 9, 8, 7, 6]);
    const second = await api.getContributionHistoryPage(1);
    expect(second.items.map(({ receipt }) => receipt.generation)).toEqual([5, 4, 3, 2, 1]);
    expect(await api.getContributionHistoryPage(2)).toEqual({ total: 10, items: [] });
    const pages = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/contributions"));
    expect(pages.map((url) => new URL(url).search)).toEqual(["?after=5&limit=5", "?after=0&limit=5"]);
  });
  it("handles the empty genesis epoch", async () => {
    network([], 0, artifact("1"));
    expect(await api.getContributionHistoryPage(0)).toEqual({ total: 0, items: [] });
  });
  it("rejects a short page, a broken link inside the page and a mismatched signed head", async () => {
    network([], 1);
    await expect(api.getContributionHistoryPage(0)).rejects.toThrow(/incomplete/);
    const broken = chain.map((value) => value.generation === 8 ? { ...value, predecessor: artifact("f") } : value);
    serveChain(broken);
    await expect(api.getContributionHistoryPage(0)).rejects.toThrow(/broken/);
    network([signed(payload)], 1, artifact("9"));
    await expect(api.getContributionHistoryPage(0)).rejects.toThrow(/signed head/);
  });
  it("rejects a page that skips a generation", async () => {
    network(() => [signed(chain[5]), signed(chain[7])], 10, artifact("b"));
    await expect(api.getContributionHistoryPage(1)).rejects.toThrow(/incomplete|gap/);
  });
});
