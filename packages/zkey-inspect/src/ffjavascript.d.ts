declare module "ffjavascript" {
  interface CurveGroup {
    F: { n8: number };
    fromRprLEM(bytes: Uint8Array, offset: number): unknown;
    toRprUncompressed(bytes: Uint8Array, offset: number, point: unknown): void;
  }

  export interface Bn128Curve {
    G1: CurveGroup;
    G2: CurveGroup;
  }

  export function buildBn128(singleThread?: boolean): Promise<Bn128Curve>;
}
