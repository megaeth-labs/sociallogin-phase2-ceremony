import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalize, type JsonValue } from "@moss/phase2-protocol";

import { UnavailableBeaconResolver } from "../src/beacon.js";
import { finalizeCeremony } from "../src/finalize.js";
import {
  bellmanFixture,
  TestBackend,
  TestBeaconResolver,
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

describe("finalizeCeremony", () => {
  it("imports the sealed Bellman head once, preserves its identity, and publishes the imported zkey digest", async () => {
    const value = await createTestFixture({ bellman: true }); fixtures.push(value);
    let imports = 0;
    class BellmanBackend extends TestBackend {
      async exportBellman(_input: string, output: string) { await writeFile(output, bellmanFixture(0)); }
      async importBellman(_genesis: string, input: string, output: string) {
        expect(input).toBe(value.options.sealedHeadPath); imports++;
        await writeFile(output, "imported-sealed-key");
      }
    }
    const backend = new BellmanBackend();
    const summary = await finalizeCeremony(value.options, { backend, beaconResolver: new TestBeaconResolver(), now: () => new Date("2030-01-01T00:00:00.000Z") });
    expect(imports).toBe(1);
    expect(summary.inputs.sealedHead.sha256).toBe(value.options.expectedSealedHeadSha256);
    expect(summary.outputs.importedSealedZkey?.fileName).toBe("sealed-import.zkey");
    expect(await readFile(join(value.options.outputDir, "sealed-import.zkey"), "utf8")).toBe("imported-sealed-key");
    expect(backend.applyCalls).toBe(1);
  });

  it("fails closed when a Bellman finalizer lacks the original genesis", async () => {
    const value = await createTestFixture({ bellman: true }); fixtures.push(value);
    await expect(finalizeCeremony({ ...value.options, genesisZkeyPath: undefined }, { backend: new TestBackend(), beaconResolver: new TestBeaconResolver(), now: () => new Date("2030-01-01T00:00:00.000Z") })).rejects.toThrow(/original genesis/);
  });

  it("applies one beacon and emits a deterministic canonical artifact summary", async () => {
    const first = await fixture();
    const firstBackend = new TestBackend();
    const firstSummary = await finalizeCeremony(first.options, {
      backend: firstBackend,
      beaconResolver: new TestBeaconResolver(),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });

    expect(firstBackend.applyCalls).toBe(1);
    expect(firstSummary.inputs.sealedHead.ordinaryContributionCount).toBe(2);
    expect(firstSummary.outputs.verificationKey.publicInputCount).toBe(20);
    const evidenceBytes = await readFile(
      join(first.options.outputDir, "drand-evidence.json"),
    );
    expect(firstSummary.outputs.beaconEvidence.sha256).toBe(
      firstSummary.beacon.evidenceSha256,
    );
    expect(evidenceBytes.byteLength).toBe(
      firstSummary.outputs.beaconEvidence.byteLength,
    );
    const summaryBytes = await readFile(
      join(first.options.outputDir, "final-artifacts.json"),
      "utf8",
    );
    expect(summaryBytes).toBe(
      `${canonicalize(firstSummary as unknown as JsonValue)}\n`,
    );

    const secondSummary = await finalizeCeremony(
      { ...first.options, outputDir: join(first.root, "final-two") },
      {
      backend: new TestBackend(),
      beaconResolver: new TestBeaconResolver(),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      },
    );
    expect(secondSummary).toEqual(firstSummary);
  });

  it("rejects head bytes that differ from the signed checkpoint before proving work", async () => {
    const value = await fixture();
    await writeFile(value.options.sealedHeadPath, "tampered-head");
    const backend = new TestBackend();
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new TestBeaconResolver(),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/sealed head bytes|signed checkpoint/i);
    expect(backend.applyCalls).toBe(0);
    await expect(access(value.options.outputDir)).rejects.toThrow();
  });

  it("rejects a sealed head that already contains a beacon", async () => {
    const value = await fixture();
    const backend = new TestBackend();
    backend.inspectBeaconCount = 1;
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new TestBeaconResolver(),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/already contains a beacon/i);
    expect(backend.applyCalls).toBe(0);
  });

  it("does not accept an arbitrary beacon when no secure resolver exists", async () => {
    const value = await fixture();
    const backend = new TestBackend();
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new UnavailableBeaconResolver(),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/BEACON_RESOLVER_UNAVAILABLE/);
    expect(backend.applyCalls).toBe(0);
    await expect(access(value.options.outputDir)).rejects.toThrow();
  });

  it("rejects resolver output for a different precommitted round", async () => {
    const value = await fixture();
    const backend = new TestBackend();
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new TestBeaconResolver({ round: 999 }),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/does not match the signed manifest/i);
    expect(backend.applyCalls).toBe(0);
  });

  it("removes partial output when final verification rejects", async () => {
    const value = await fixture();
    const backend = new TestBackend();
    backend.verifyResults.splice(0, Infinity, true, false);
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new TestBeaconResolver(),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/final zkey failed verification/i);
    expect(backend.applyCalls).toBe(1);
    await expect(access(value.options.outputDir)).rejects.toThrow();
  });

  it("never resolves or applies the beacon when the sealed head is invalid", async () => {
    const value = await fixture();
    const backend = new TestBackend();
    backend.verifyResults.splice(0, Infinity, false);
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new TestBeaconResolver(),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/sealed head failed verification/i);
    expect(backend.applyCalls).toBe(0);
  });

  it("removes the beacon output if exact append validation fails", async () => {
    const value = await fixture();
    const backend = new TestBackend();
    backend.appendFails = true;
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new TestBeaconResolver(),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/append rejected/i);
    expect(backend.applyCalls).toBe(1);
    await expect(access(value.options.outputDir)).rejects.toThrow();
  });

  it("removes output when the exported verifier has the wrong public-input ABI", async () => {
    const value = await fixture();
    const backend = new TestBackend();
    backend.verificationKeyPublicInputs = 19;
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new TestBeaconResolver(),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/20 public inputs/i);
    await expect(access(value.options.outputDir)).rejects.toThrow();
  });

  it("refuses to resolve the future beacon before its committed availability", async () => {
    const value = await fixture();
    const backend = new TestBackend();
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new TestBeaconResolver(),
        now: () => new Date("2025-01-02T12:00:00.000Z"),
      }),
    ).rejects.toThrow(/not yet eligible/i);
    expect(backend.applyCalls).toBe(0);
  });

  it("never reuses an existing output directory", async () => {
    const value = await fixture();
    await writeFile(value.options.outputDir, "occupied");
    const backend = new TestBackend();
    await expect(
      finalizeCeremony(value.options, {
        backend,
        beaconResolver: new TestBeaconResolver(),
        now: () => new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow();
    expect(backend.applyCalls).toBe(0);
    expect(await readFile(value.options.outputDir, "utf8")).toBe("occupied");
  });
});

async function fixture(): Promise<TestFixture> {
  const value = await createTestFixture();
  fixtures.push(value);
  return value;
}
