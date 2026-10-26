import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { powersOfTau, zKey } from "snarkjs";

export const CIRCUIT = join(dirname(fileURLToPath(import.meta.url)), "fixtures/proof-circuit");
// d for a=1, b=2, c=3, followed by the three public inputs.
export const EXPECTED = ["561925048666624554140524253652509148274242262846714993824144274063483837956", "1", "2", "3"];
const BEACON = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

/** Builds a power-10 PTAU and a beacon-finalized key for the 1,000-constraint fixture. */
export async function buildTinyCeremony(workspace: string) {
  // ffjavascript is snarkjs's own dependency; resolve it from there.
  const { buildBn128 } = createRequire(fileURLToPath(import.meta.resolve("snarkjs")))("ffjavascript") as {
    buildBn128: () => Promise<{ terminate: () => Promise<void> }>;
  };
  const curve = await buildBn128();
  try {
    await powersOfTau.newAccumulator(curve, 10, join(workspace, "p0.ptau"));
  } finally {
    await curve.terminate();
  }
  await powersOfTau.beacon(join(workspace, "p0.ptau"), join(workspace, "p1.ptau"), "test", BEACON, 10);
  await powersOfTau.preparePhase2(join(workspace, "p1.ptau"), join(workspace, "final.ptau"));
  await zKey.newZKey(join(CIRCUIT, "circuit.r1cs"), join(workspace, "final.ptau"), join(workspace, "genesis.zkey"));
  await zKey.beacon(join(workspace, "genesis.zkey"), join(workspace, "final.zkey"), "final", BEACON, 10);
  const vk = await zKey.exportVerificationKey(join(workspace, "final.zkey"));
  await writeFile(join(workspace, "verification_key.json"), JSON.stringify(vk));
  await writeFile(join(workspace, "expected.json"), JSON.stringify(EXPECTED));
}
