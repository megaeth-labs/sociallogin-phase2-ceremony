/** snarkjs caches a multi-threaded BN254 curve whose workers keep Node alive. */
export async function releaseSnarkjsCurve(): Promise<void> {
  const cached = (globalThis as { curve_bn128?: { terminate?: () => Promise<void> } | null }).curve_bn128;
  await cached?.terminate?.();
}
