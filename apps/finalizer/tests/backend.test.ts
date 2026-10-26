import { describe, expect, it } from "vitest";

import { SnarkjsPhase2Backend } from "../src/backend.js";
import { UnavailableBeaconResolver } from "../src/beacon.js";

describe("production backend pins", () => {
  it("loads exactly snarkjs 0.7.6 and hashes its Groth16 Solidity template", async () => {
    const metadata = await new SnarkjsPhase2Backend().metadata();
    expect(metadata.snarkjsVersion).toBe("0.7.6");
    expect(metadata.solidityTemplateSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("the default resolver fails closed instead of accepting unverified bytes", async () => {
    const resolver = new UnavailableBeaconResolver();
    await expect(
      resolver.resolve({
        source: "drand",
        chainHash: "1".repeat(64),
        round: 1,
        expectedAt: "2030-01-01T00:00:00.000Z",
        derivation: "MOSS_PHASE2_BEACON_V1",
        numIterationsExp: 10,
        contributionName: "beacon",
      }),
    ).rejects.toThrow(/at least two distinct HTTPS drand endpoints/i);
  });
});
