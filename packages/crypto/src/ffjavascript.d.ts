// ffjavascript ships no type declarations. Declare only the surface mpcParams.ts
// uses: the BN254 curve builder and the G1/G2 point (de)serialization needed to
// recompute snarkjs `hashPubKey`. Pinned to ffjavascript 0.3.1.
declare module "ffjavascript" {
  export const Scalar: {
    toRprLE(
      buffer: Uint8Array,
      offset: number,
      value: unknown,
      length: number,
    ): void;
    fromRprLE(buffer: Uint8Array, offset: number, length: number): unknown;
  };

  interface CurveGroup {
    F: { n8: number };
    // Reads a point from its on-disk little-endian Montgomery form.
    fromRprLEM(buf: Uint8Array, pos: number): unknown;
    // Writes a point in the uncompressed form snarkjs hashes.
    toRprUncompressed(buf: Uint8Array, pos: number, point: unknown): void;
  }

  export interface Bn128Curve {
    G1: CurveGroup;
    G2: CurveGroup;
    terminate?(): Promise<void>;
  }

  export function buildBn128(
    singleThread?: boolean,
    plugins?: unknown,
  ): Promise<Bn128Curve>;
}
