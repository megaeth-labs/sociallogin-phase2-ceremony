import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zKey } from "snarkjs";

import { SnarkjsPhase2Backend } from "../src/backend.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/crypto/tests/fixtures",
);

describe("SnarkjsPhase2Backend synthetic artifact integration", () => {
  let workspace: string;
  let r1csPath: string;
  let ptauPath: string;
  let sealedHeadPath: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "moss-finalizer-backend-test-"));
    r1csPath = join(FIXTURES, "multiplier.r1cs");
    ptauPath = join(FIXTURES, "pot_final.ptau");
    const genesisPath = join(workspace, "genesis.zkey");
    sealedHeadPath = join(workspace, "sealed-head.zkey");
    const created = await zKey.newZKey(r1csPath, ptauPath, genesisPath);
    if (created === -1) throw new Error("synthetic genesis creation failed");
    await zKey.contribute(
      genesisPath,
      sealedHeadPath,
      "synthetic-ordinary",
      randomBytes(64).toString("hex"),
    );
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it("performs the real path-based beacon, append, verification, and exports", async () => {
    const backend = new SnarkjsPhase2Backend();
    const finalZkeyPath = join(workspace, "final.zkey");
    const head = await backend.inspectSealedHead(sealedHeadPath, 1);
    expect(head.contributionCount).toBe(1);
    expect(head.beaconContributionCount).toBe(0);
    expect(await backend.verifyFromR1cs(r1csPath, ptauPath, sealedHeadPath)).toBe(true);

    const beaconHashHex = "ab".repeat(32);
    const applied = await backend.applyBeacon({
      sealedHeadPath,
      finalZkeyPath,
      contributionName: "synthetic-beacon",
      beaconHashHex,
      numIterationsExp: 10,
    });
    const append = await backend.verifyBeaconAppend({
      sealedHeadPath,
      finalZkeyPath,
      expectedContributionName: "synthetic-beacon",
      expectedContributionHashBlake2b512:
        applied.contributionHashBlake2b512,
      expectedBeaconHash: new Uint8Array(Buffer.from(beaconHashHex, "hex")),
      expectedBeaconIterationsExp: 10,
      maxPredecessorContributions: 1,
    });
    expect(append.predecessorCount).toBe(1);
    expect(append.candidateCount).toBe(2);
    expect(append.contributionHashBlake2b512).toBe(
      applied.contributionHashBlake2b512,
    );
    expect(await backend.verifyFromR1cs(r1csPath, ptauPath, finalZkeyPath)).toBe(true);

    const verificationKey = await backend.exportVerificationKey(finalZkeyPath) as {
      protocol?: unknown;
      curve?: unknown;
    };
    expect(verificationKey.protocol).toBe("groth16");
    expect(verificationKey.curve).toBe("bn128");
    expect(await backend.exportSolidityVerifier(finalZkeyPath)).toContain(
      "contract Groth16Verifier",
    );
  });
});
