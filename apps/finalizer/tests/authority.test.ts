import { access, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadFinalizationAuthority } from "../src/authority.js";
import {
  createTestFixture,
  type TestFixture,
} from "./fixture.js";

const fixtures: TestFixture[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) =>
      rm(fixture.root, { recursive: true, force: true }),
    ),
  );
});

describe("loadFinalizationAuthority", () => {
  it("verifies the root-pinned manifest and authorized SEALED checkpoint", async () => {
    const value = await fixture();
    const loaded = await loadFinalizationAuthority(value.options);
    expect(loaded.manifest.ceremonyId).toBe(value.manifest.ceremonyId);
    expect(loaded.checkpoint.state).toBe("SEALED");
    expect(loaded.manifestRootKeyId).toBe("root-1");
    expect(loaded.checkpointSignerKeyId).toBe("coordinator-1");
  });

  it("rejects a valid signature under a root key with the wrong expected fingerprint", async () => {
    const value = await fixture();
    await expect(
      loadFinalizationAuthority({
        ...value.options,
        expectedRootKeySpkiSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/root public key.*fingerprint/i);
  });

  it("rejects a checkpoint that is signed but not SEALED", async () => {
    const value = await createTestFixture({ checkpointState: "OPEN" });
    fixtures.push(value);
    await expect(loadFinalizationAuthority(value.options)).rejects.toThrow(
      /exactly SEALED/i,
    );
  });

  it("rejects a sealed checkpoint with no ordinary contribution", async () => {
    const value = await createTestFixture({ checkpointGeneration: 0 });
    fixtures.push(value);
    await expect(loadFinalizationAuthority(value.options)).rejects.toThrow(
      /at least one ordinary contribution/i,
    );
  });

  it("accepts the same full SHA-256 Git object IDs as protocol validation", async () => {
    const value = await createTestFixture({ sourceCommitLength: 64 });
    fixtures.push(value);
    await expect(loadFinalizationAuthority(value.options)).resolves.toMatchObject({
      manifest: { relation: { sourceCommit: "a".repeat(64) } },
    });
  });

  it("rejects a beacon workload that the finalizer policy does not support", async () => {
    const value = await createTestFixture({ beaconNumIterationsExp: 33 });
    fixtures.push(value);
    await expect(loadFinalizationAuthority(value.options)).rejects.toThrow(
      /between 10 and 32/i,
    );
  });

  it("rejects manifest-byte tampering", async () => {
    const value = await fixture();
    const envelope = JSON.parse(
      await readFile(value.options.manifestEnvelopePath, "utf8"),
    ) as { payload: { slug: string } };
    envelope.payload.slug = "tampered";
    await writeFile(
      value.options.manifestEnvelopePath,
      JSON.stringify(envelope),
    );
    await expect(loadFinalizationAuthority(value.options)).rejects.toThrow(
      /signature is invalid/i,
    );
  });

  it("requires the independent expected head hash to match the checkpoint", async () => {
    const value = await fixture();
    await expect(
      loadFinalizationAuthority({
        ...value.options,
        expectedSealedHeadSha256: "f".repeat(64),
      }),
    ).rejects.toThrow(/independently expected head/i);
    await expect(access(value.options.outputDir)).rejects.toThrow();
  });
});

async function fixture(): Promise<TestFixture> {
  const value = await createTestFixture();
  fixtures.push(value);
  return value;
}

it("accepts a root-signed Ethereum commitment and requires explicit rehearsal opt-in", async () => {
  const value = await createTestFixture({ rehearsal: true, ethereum: true });
  fixtures.push(value);
  await expect(loadFinalizationAuthority(value.options)).rejects.toThrow(/rehearsal/);
  await expect(loadFinalizationAuthority({ ...value.options, allowRehearsal: true })).resolves.toMatchObject({
    manifest: { purpose: "rehearsal", beacon: { source: "ethereum-block", chainId: 1, blockNumber: 22000000 } },
  });
});
