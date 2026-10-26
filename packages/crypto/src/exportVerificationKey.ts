import * as snarkjs from "snarkjs";
import type { Groth16VerificationKey } from "./types.js";
import { withTempDir, writeTempFile } from "./util.js";

/**
 * Extract the verification key from a finalized zkey.
 *
 * Validates that the value snarkjs returns has the expected Groth16 shape
 * before handing it back, so consumers (onchain verifier generators, proof
 * verifiers, etc.) can rely on the typed result instead of doing their own
 * structural checks on an untyped `object`.
 *
 * @param zkey - The finalized zkey.
 * @returns Verification key in standard Groth16 JSON shape.
 * @throws Error if snarkjs returns something that is not a Groth16 VK
 *         (wrong protocol, missing required fields, non-object value).
 */
export async function exportVerificationKey(
  zkey: Uint8Array,
): Promise<Groth16VerificationKey> {
  return withTempDir(async (dir) => {
    const zkeyPath = await writeTempFile(dir, "final.zkey", zkey);
    const vkey = await snarkjs.zKey.exportVerificationKey(zkeyPath);
    return validateGroth16VK(vkey);
  });
}

const REQUIRED_VK_FIELDS = [
  "curve",
  "nPublic",
  "vk_alpha_1",
  "vk_beta_2",
  "vk_gamma_2",
  "vk_delta_2",
  "vk_alphabeta_12",
  "IC",
] as const;

function validateGroth16VK(value: unknown): Groth16VerificationKey {
  if (typeof value !== "object" || value === null) {
    throw new Error("exportVerificationKey: snarkjs returned a non-object");
  }
  const vk = value as Record<string, unknown>;

  if (vk.protocol !== "groth16") {
    throw new Error(
      `exportVerificationKey: expected protocol "groth16", got ` +
        `${JSON.stringify(vk.protocol)}`,
    );
  }

  for (const field of REQUIRED_VK_FIELDS) {
    if (!(field in vk)) {
      throw new Error(
        `exportVerificationKey: missing required field "${field}"`,
      );
    }
  }

  return vk as unknown as Groth16VerificationKey;
}
