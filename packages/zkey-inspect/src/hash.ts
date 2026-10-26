import { createHash } from "node:crypto";
import { buildBn128, type Bn128Curve } from "ffjavascript";

import type { ContributionRecord } from "./parser.js";

let curvePromise: Promise<Bn128Curve> | undefined;

export async function contributionHashBlake2b512(record: ContributionRecord): Promise<string> {
  const curve = await getCurve();
  const hasher = createHash("blake2b512");
  const g1 = new Uint8Array(curve.G1.F.n8 * 2);
  for (const encoded of [record.pointBytes.deltaAfter, record.pointBytes.g1s, record.pointBytes.g1sx]) {
    curve.G1.toRprUncompressed(g1, 0, curve.G1.fromRprLEM(encoded, 0));
    hasher.update(g1);
  }
  const g2 = new Uint8Array(curve.G2.F.n8 * 2);
  curve.G2.toRprUncompressed(g2, 0, curve.G2.fromRprLEM(record.pointBytes.g2spx, 0));
  hasher.update(g2);
  hasher.update(record.pointBytes.transcript);
  return hasher.digest("hex");
}

function getCurve(): Promise<Bn128Curve> {
  curvePromise ??= buildBn128(true).catch((error: unknown) => {
    curvePromise = undefined;
    throw error;
  });
  return curvePromise;
}
