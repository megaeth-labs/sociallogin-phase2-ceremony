import { afterEach, expect, it, vi } from "vitest";
import { readServerMaterial } from "./server-material";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
afterEach(() => vi.unstubAllEnvs());
it("accepts server-only inline material and rejects ambiguous or missing configuration", async () => {
  vi.stubEnv("TEST_MATERIAL", undefined); vi.stubEnv("TEST_MATERIAL_FILE", undefined);
  await expect(readServerMaterial("TEST_MATERIAL", true)).rejects.toThrow(/exactly one/);
  vi.stubEnv("TEST_MATERIAL", "synthetic test fixture");
  await expect(readServerMaterial("TEST_MATERIAL", true)).resolves.toBe("synthetic test fixture");
  vi.stubEnv("TEST_MATERIAL_FILE", "/unused");
  await expect(readServerMaterial("TEST_MATERIAL", true)).rejects.toThrow(/exactly one/);
});
it("retains permission checks for mounted secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "moss-material-test-"));
  try {
    const path = join(dir, "fixture");
    await writeFile(path, "synthetic test fixture", { mode: 0o644 });
    vi.stubEnv("TEST_MATERIAL", undefined); vi.stubEnv("TEST_MATERIAL_FILE", path);
    await expect(readServerMaterial("TEST_MATERIAL", true)).rejects.toThrow(/unsafe/);
    await expect(readServerMaterial("TEST_MATERIAL", false)).resolves.toBe("synthetic test fixture");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
