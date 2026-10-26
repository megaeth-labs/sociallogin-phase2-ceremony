import { describe, expect, it } from "vitest";
import type { CeremonyManifestV1 } from "@moss/phase2-protocol";
import { heartbeatGraceSeconds } from "../src/heartbeat-policy.js";

function manifest(purpose: CeremonyManifestV1["purpose"], heartbeatSeconds = 15) {
  return { purpose, contributionPolicy: { lease: { heartbeatSeconds, absoluteSeconds: 5400 } } } as CeremonyManifestV1;
}

describe("heartbeat grace", () => {
  it("allows five minutes only with both rehearsal gates", () => {
    expect(heartbeatGraceSeconds(manifest("rehearsal"), true)).toBe(300);
    expect(heartbeatGraceSeconds(manifest("rehearsal"), false)).toBe(15);
    expect(heartbeatGraceSeconds(manifest("production"), true)).toBe(15);
    expect(heartbeatGraceSeconds(manifest("production"))).toBe(15);
  });
  it("does not shorten a longer signed allowance or mutate the signed policy", () => {
    expect(heartbeatGraceSeconds(manifest("rehearsal", 600), true)).toBe(600);
    const original = manifest("rehearsal");
    heartbeatGraceSeconds(original, true);
    expect(original.contributionPolicy.lease).toEqual({ heartbeatSeconds: 15, absoluteSeconds: 5400 });
  });
});
