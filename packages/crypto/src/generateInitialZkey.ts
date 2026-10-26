import * as snarkjs from "snarkjs";
import { withTempDir, writeTempFile, readFileAsBytes } from "./util.js";

/**
 * Generate the genesis zkey from a Powers of Tau file and an R1CS circuit.
 *
 * @param ptau - Powers of Tau ceremony output
 * @param r1cs - R1CS circuit definition
 * @returns Genesis zkey as Uint8Array
 */
export async function generateInitialZkey(
  ptau: Uint8Array,
  r1cs: Uint8Array,
): Promise<Uint8Array> {
  return withTempDir(async (dir) => {
    const r1csPath = await writeTempFile(dir, "circuit.r1cs", r1cs);
    const ptauPath = await writeTempFile(dir, "pot.ptau", ptau);
    const zkeyPath = `${dir}/genesis.zkey`;

    const result = await snarkjs.zKey.newZKey(r1csPath, ptauPath, zkeyPath);

    // newZKey returns -1 on failure
    if (result === -1) {
      throw new Error("Failed to generate initial zkey");
    }

    return readFileAsBytes(zkeyPath);
  });
}
