import { canonicalSha256 } from "./jcs.js";
import type { TranscriptEventV1 } from "./types.js";
import { assertIsoDate, assertSha256, assertUuid } from "./validation.js";

export const GENESIS_EVENT_HASH = "0".repeat(64);

export function transcriptEventHash(event: TranscriptEventV1): string {
  const expectedKeys = ["ceremonyId", "createdAt", "eventType", "payload", "previousEventHash", "schemaVersion", "sequence"];
  const actualKeys = Object.keys(event).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("transcript event has missing or unsupported fields");
  }
  if (event.schemaVersion !== 1) throw new Error("transcript event schemaVersion must be 1");
  assertUuid(event.ceremonyId, "ceremonyId");
  assertSha256(event.previousEventHash, "previousEventHash");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new Error("transcript event sequence is invalid");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(event.eventType)) throw new Error("transcript event type is invalid");
  assertIsoDate(event.createdAt, "createdAt");
  return canonicalSha256("MOSS_PHASE2_EVENT_V1", event as unknown as import("./types.js").JsonValue);
}
