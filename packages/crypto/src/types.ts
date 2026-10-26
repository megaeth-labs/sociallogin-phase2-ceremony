/** A source of entropy for contribution randomness */
export interface EntropySource {
  /** Type of entropy source */
  type: "csprng" | "mouse" | "click" | "keyboard" | "custom";
  /** Raw entropy data */
  data: Uint8Array;
}

/** Result of a contribution. */
export interface ContributionResult {
  /** The new zkey after applying the contribution. */
  zkey: Uint8Array;
  /**
   * snarkjs's own contribution hash, Blake2b over the contribution's public
   * key as recorded in the zkey transcript. Returned by `snarkjs.zKey.contribute`
   * and used as the contribution identifier across the ceremony log.
   * Encoded as a 0x-prefixed lowercase hex string.
   */
  contributionHash: string;
  /**
   * SHA-256 of the new zkey binary as a 0x-prefixed lowercase hex string.
   * Used by callers that want to integrity-check the zkey file independently
   * of the snarkjs transcript hash above.
   */
  zkeyHash: string;
}

/** Result of finalizing a ceremony by applying the beacon. */
export interface BeaconResult {
  /** The finalized zkey after applying the public-randomness beacon. */
  zkey: Uint8Array;
  /**
   * snarkjs's contribution hash for the beacon contribution, Blake2b over
   * the beacon contribution's public key. Encoded as 0x-prefixed lowercase
   * hex. Useful for the finalization transcript.
   */
  contributionHash: string;
  /**
   * SHA-256 of the finalized zkey binary as a 0x-prefixed lowercase hex
   * string. Used by callers that want to integrity-check the published
   * final zkey artifact.
   */
  zkeyHash: string;
}

/**
 * Groth16 verification key shape as emitted by snarkjs.
 *
 * Group element representations follow snarkjs's JSON convention:
 * - G1 points are `[x, y, z]` decimal-string tuples (typically Jacobian).
 * - G2 points are `[[x0, x1], [y0, y1], [z0, z1]]`.
 * - GT elements (pairing outputs) are deeply nested string arrays.
 *
 * Consumers usually pass this object directly to `snarkjs.groth16.verify`
 * or to onchain verifier contract generators.
 */
export interface Groth16VerificationKey {
  /** Protocol identifier; always `"groth16"` for keys this package emits. */
  protocol: "groth16";
  /** Pairing-friendly curve name (e.g. `"bn128"`). */
  curve: string;
  /** Number of public inputs the circuit declares. */
  nPublic: number;
  vk_alpha_1: string[];
  vk_beta_2: string[][];
  vk_gamma_2: string[][];
  vk_delta_2: string[][];
  vk_alphabeta_12: string[][][];
  /**
   * Encrypted public-input coefficient terms; one per public input plus one
   * extra for the constant term.
   */
  IC: string[][];
}
