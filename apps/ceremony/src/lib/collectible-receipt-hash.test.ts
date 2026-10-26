import { describe, expect, it } from "vitest";
import { canonicalSha256, type JsonValue } from "@moss/phase2-protocol";
import { collectibleReceiptHash } from "./api";

describe("collectibleReceiptHash", () => {
  it("matches the server's NFT receipt hash for the same signed payload", async () => {
    const payload = {
      ceremonyId: "moss-zklogin-phase2",
      contributionIndex: 7,
      contributionName: "moss-browser",
      participantPseudonym: "quiet-fern",
      successor: { sha256: "ab".repeat(32), byteLength: 368440348 },
      predecessor: { sha256: "cd".repeat(32), byteLength: 368440348 },
      acceptedAt: "2026-10-04T12:00:00.000Z",
      generation: 8,
    };
    const envelope = { keyId: "coordinator-1", payload, signature: "sig" };
    const expected = `0x${canonicalSha256("MOSS_PHASE2_NFT_RECEIPT_V1", payload as unknown as JsonValue)}`;
    await expect(collectibleReceiptHash(envelope as never)).resolves.toBe(expected);
  });
});
