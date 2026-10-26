import { describe, expect, it } from "vitest";

import {
  AppendExpectationMismatchError,
  bn254FieldConstants,
  inspectBn254Groth16Zkey,
  MemoryByteSource,
  verifyExactlyOneAppend,
} from "../src/index.js";

const fakeHash = async (record: { pointBytes: { transcript: Uint8Array } }) =>
  Buffer.from(record.pointBytes.transcript).toString("hex").padEnd(128, "0").slice(0, 128);

describe("strict zkey inspection", () => {
  it("accepts an exact ordinary append", async () => {
    const predecessor = zkey([record("alice", 1)]);
    const candidate = zkey([record("alice", 1), record("lease-0002", 2)]);
    const result = await verifyExactlyOneAppend(predecessor, candidate, {
      expectedContributionName: "lease-0002",
      maxPredecessorContributions: 10,
      expectedContributionHashBlake2b512: "02".repeat(64),
    }, fakeHash as never);
    expect(result).toMatchObject({
      predecessorCount: 1,
      candidateCount: 2,
      contributionIndex: 2,
      contributionName: "lease-0002",
      contributionHashBlake2b512: "02".repeat(64),
    });
  });

  it("preserves observed append metadata when an expectation differs", async () => {
    const error = await verifyExactlyOneAppend(
      zkey([record("alice", 1)]),
      zkey([record("alice", 1), record("unexpected", 2)]),
      {
        expectedContributionName: "lease-0002",
        expectedContributionHashBlake2b512: "03".repeat(64),
        maxPredecessorContributions: 1,
      },
      fakeHash as never,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppendExpectationMismatchError);
    expect((error as AppendExpectationMismatchError).inspection).toMatchObject({
      contributionIndex: 2,
      contributionName: "unexpected",
      contributionHashBlake2b512: "02".repeat(64),
    });
  });

  it("rejects a forked prefix and more than one append", async () => {
    await expect(verifyExactlyOneAppend(
      zkey([record("alice", 1)]),
      zkey([record("mallory", 9), record("lease-0002", 2)]),
      { expectedContributionName: "lease-0002", maxPredecessorContributions: 10 },
      fakeHash as never,
    )).rejects.toThrow(/prefix/u);
    await expect(verifyExactlyOneAppend(
      zkey([record("alice", 1)]),
      zkey([record("alice", 1), record("lease-0002", 2), record("extra", 3)]),
      { expectedContributionName: "lease-0002", maxPredecessorContributions: 10 },
      fakeHash as never,
    )).rejects.toThrow(/count exceeds|exactly one/u);
  });

  it("rejects a contribution reusing an earlier contributor's proof-of-knowledge points", async () => {
    // Two contributors seeded from the same CSPRNG state — a cloned VM
    // snapshot — emit identical g1s and g1sx while name, transcript and
    // deltaAfter all differ. Structurally valid, contributes no entropy.
    const predecessor = zkey([record("alice", 1)]);
    const candidate = zkey([record("alice", 1), record("lease-0002", 2, 1)]);
    const error = await verifyExactlyOneAppend(
      predecessor,
      candidate,
      { expectedContributionName: "lease-0002", maxPredecessorContributions: 10 },
      fakeHash as never,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppendExpectationMismatchError);
    expect((error as Error).message).toMatch(/g1s point.*randomness is not unique/u);
    // The prefix was proven byte-identical above, so the report must not
    // present this as a prefix fault, and must carry the observed metadata an
    // operator needs to diagnose a suspected CSPRNG failure.
    expect((error as AppendExpectationMismatchError).inspection).toMatchObject({
      contributionIndex: 2,
      contributionName: "lease-0002",
    });
  });

  it("rejects a reused g1sx even when g1s differs", async () => {
    await expect(verifyExactlyOneAppend(
      zkey([record("alice", 1)]),
      zkey([record("alice", 1), record("lease-0002", 2, 9, 1)]),
      { expectedContributionName: "lease-0002", maxPredecessorContributions: 10 },
      fakeHash as never,
    )).rejects.toThrow(/g1sx point.*randomness is not unique/u);
  });

  it("rejects a beacon that reuses an ordinary contributor's points", async () => {
    // Beacon randomness is derived from the beacon parameters, so a repeat is
    // equally detectable and equally disqualifying.
    const prefix = [record("alice", 1)];
    await expect(verifyExactlyOneAppend(
      zkey(prefix),
      zkey([...prefix, beaconRecord("final", 2, 1)]),
      {
        expectedContributionName: "final",
        maxPredecessorContributions: 10,
        kind: "beacon",
        expectedBeaconHash: new Uint8Array(32).fill(5),
        expectedBeaconIterationsExp: 10,
      },
      fakeHash as never,
    )).rejects.toThrow(/randomness is not unique/u);
  });

  it("rejects a non-canonical field element in a contribution point", async () => {
    // q is just under 2^254, so x and x + q both fit in 32 bytes and decode to
    // the same point. Without a range check, re-encoding g1s that way evades
    // the byte comparison while pairing checks and the Blake2b contribution
    // hash both still pass, because each round-trips through the decoder.
    const nonCanonical = record("lease-0002", 2);
    nonCanonical.fill(0xff, 64, 96); // first limb of g1s, far above q
    await expect(verifyExactlyOneAppend(
      zkey([record("alice", 1)]),
      zkey([record("alice", 1), nonCanonical]),
      { expectedContributionName: "lease-0002", maxPredecessorContributions: 10 },
      fakeHash as never,
    )).rejects.toThrow(/non-canonical field element/u);
  });

  it("accepts distinct proof-of-knowledge points across many contributions", async () => {
    const prefix = [record("a", 1), record("b", 2), record("c", 3)];
    const result = await verifyExactlyOneAppend(
      zkey(prefix),
      zkey([...prefix, record("lease-0004", 4)]),
      { expectedContributionName: "lease-0004", maxPredecessorContributions: 10 },
      fakeHash as never,
    );
    expect(result).toMatchObject({ predecessorCount: 3, candidateCount: 4 });
  });

  it("rejects malformed framing and non-BN254 headers", async () => {
    const valid = zkey([]);
    const trailing = new Uint8Array(valid.byteLength + 1);
    trailing.set(valid);
    await expect(inspectBn254Groth16Zkey(new MemoryByteSource(trailing), { maxContributions: 0 })).rejects.toThrow(/trailing/u);
    const wrong = valid.slice();
    const headerSectionOffset = findSectionBody(wrong, 2);
    wrong[headerSectionOffset + 4] ^= 1;
    await expect(inspectBn254Groth16Zkey(new MemoryByteSource(wrong), { maxContributions: 0 })).rejects.toThrow(/base field/u);
  });
});

/**
 * Build a contribution record. Point regions are derived from `marker` so that
 * distinct contributors carry distinct points, as real ones do. `pokMarker`
 * overrides only g1s and g1sx, letting a test emit two records that share
 * proof-of-knowledge randomness while differing everywhere else.
 */
/** A type-1 beacon record: name, iteration exponent, then beacon hash. */
function beaconRecord(name: string, marker: number, g1sMarker: number = marker): Uint8Array {
  const fixed = new Uint8Array(392);
  fixed.fill(marker, 0, 64);
  fixed.fill(g1sMarker, 64, 192);
  fixed.fill(marker, 192, 320);
  fixed.fill(marker, 320, 384);
  const view = new DataView(fixed.buffer);
  view.setUint32(384, 1, true); // beacon
  const nameBytes = new TextEncoder().encode(name);
  const beaconHash = new Uint8Array(32).fill(5);
  const params = concat(
    new Uint8Array([1, nameBytes.byteLength]),
    nameBytes,
    new Uint8Array([2, 10]), // numIterationsExp
    new Uint8Array([3, beaconHash.byteLength]),
    beaconHash,
  );
  view.setUint32(388, params.byteLength, true);
  return concat(fixed, params);
}

function record(
  name: string,
  marker: number,
  g1sMarker: number = marker,
  g1sxMarker: number = g1sMarker,
): Uint8Array {
  const fixed = new Uint8Array(392);
  fixed.fill(marker, 0, 64); // deltaAfter
  fixed.fill(g1sMarker, 64, 128); // g1s
  fixed.fill(g1sxMarker, 128, 192); // g1sx
  fixed.fill(marker, 192, 320); // g2spx
  fixed.fill(marker, 320, 384); // transcript
  new DataView(fixed.buffer).setUint32(384, 0, true);
  const nameBytes = new TextEncoder().encode(name);
  const params = new Uint8Array(2 + nameBytes.byteLength);
  params[0] = 1;
  params[1] = nameBytes.byteLength;
  params.set(nameBytes, 2);
  new DataView(fixed.buffer).setUint32(388, params.byteLength, true);
  return concat(fixed, params);
}

function zkey(records: Uint8Array[]): Uint8Array {
  const sections = new Map<number, Uint8Array>();
  sections.set(1, u32(1));
  const groth = new Uint8Array(84 + 64 * 3 + 128 * 3);
  const view = new DataView(groth.buffer);
  view.setUint32(0, 32, true);
  groth.set(le(bn254FieldConstants.q, 32), 4);
  view.setUint32(36, 32, true);
  groth.set(le(bn254FieldConstants.r, 32), 40);
  view.setUint32(72, 10, true);
  view.setUint32(76, 1, true);
  view.setUint32(80, 16, true);
  sections.set(2, groth);
  for (let id = 3; id <= 9; id += 1) sections.set(id, new Uint8Array());
  const contributionHeader = new Uint8Array(68);
  contributionHeader.fill(7, 0, 64);
  new DataView(contributionHeader.buffer).setUint32(64, records.length, true);
  sections.set(10, concat(contributionHeader, ...records));
  const fileHeader = new Uint8Array(12);
  fileHeader.set(new TextEncoder().encode("zkey"));
  const fileView = new DataView(fileHeader.buffer);
  fileView.setUint32(4, 1, true);
  fileView.setUint32(8, 10, true);
  const parts = [fileHeader];
  for (let id = 1; id <= 10; id += 1) {
    const body = sections.get(id)!;
    const sectionHeader = new Uint8Array(12);
    const sectionView = new DataView(sectionHeader.buffer);
    sectionView.setUint32(0, id, true);
    sectionView.setBigUint64(4, BigInt(body.byteLength), true);
    parts.push(sectionHeader, body);
  }
  return concat(...parts);
}

function findSectionBody(bytes: Uint8Array, wanted: number): number {
  let cursor = 12;
  for (let index = 0; index < 10; index += 1) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + cursor, 12);
    const id = view.getUint32(0, true);
    const size = Number(view.getBigUint64(4, true));
    if (id === wanted) return cursor + 12;
    cursor += 12 + size;
  }
  throw new Error("missing section");
}

function u32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}

function le(value: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let remaining = value;
  for (let index = 0; index < size; index += 1) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function concat(...values: Uint8Array[]): Uint8Array {
  const total = values.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}
