import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, it, expect } from "vitest";
import {
  applyBeacon,
  generateInitialZkey,
  contribute,
  parseMpcParams,
} from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): Uint8Array {
  const buf = readFileSync(join(FIXTURES, name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const r1cs = loadFixture("multiplier.r1cs");
const ptau = loadFixture("pot_final.ptau");

const VALID_BEACON =
  "0102030405060708091011121314151617181920212223242526272829303132";

// One chain, built once and shared. The snarkjs ops (contribute/applyBeacon)
// are the slow part; building a single chain gives us many valid zkeys to parse
// cheaply. CHAIN_LEN stays small to keep the suite fast.
const CHAIN_LEN = 3;
// zkeyByCount[k] is the zkey holding exactly k contributions; index 0 is the
// genesis. snarkjsHashes[k] is the hash snarkjs returned for the k-th
// contribution (1-indexed: snarkjsHashes[0] is contribution 1).
let zkeyByCount: Uint8Array[];
let snarkjsHashes: string[];
let beaconZkey: Uint8Array;
let beaconHash: string;

beforeAll(async () => {
  const genesis = await generateInitialZkey(ptau, r1cs);
  zkeyByCount = [genesis];
  snarkjsHashes = [];
  let current = genesis;
  for (let i = 0; i < CHAIN_LEN; i++) {
    const result = await contribute(
      current,
      new Uint8Array(32).fill(i + 1),
      `contributor-${i}`,
    );
    current = result.zkey;
    zkeyByCount.push(current);
    snarkjsHashes.push(result.contributionHash);
  }
  const beacon = await applyBeacon(current, VALID_BEACON);
  beaconZkey = beacon.zkey;
  beaconHash = beacon.contributionHash;
}, 60_000);

describe("parseMpcParams conformance", () => {
  it("reads a genesis as an empty contribution list", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const mpc = await parseMpcParams(genesis, { maxContributions: 0 });
    expect(mpc.contributions).toHaveLength(0);
    expect(mpc.csHash).toMatch(/^0x[0-9a-f]{128}$/);
  });

  it("recomputes the same hash snarkjs returns for each contribution", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);

    const first = await contribute(
      genesis,
      new Uint8Array(32).fill(1),
      "alice",
    );
    const second = await contribute(
      first.zkey,
      new Uint8Array(32).fill(2),
      "bob",
    );

    const afterFirst = await parseMpcParams(first.zkey, {
      maxContributions: 1,
    });
    expect(afterFirst.contributions).toHaveLength(1);
    expect(afterFirst.contributions[0].hash()).toBe(first.contributionHash);
    expect(afterFirst.contributions[0].type).toBe(0);

    const afterSecond = await parseMpcParams(second.zkey, {
      maxContributions: 2,
    });
    expect(afterSecond.contributions).toHaveLength(2);
    // The prefix entry is byte-stable: the first contribution's recomputed hash
    // is unchanged after a second contribution is layered on top. This is the
    // property the continuity link check relies on.
    expect(afterSecond.contributions[0].hash()).toBe(first.contributionHash);
    expect(afterSecond.contributions[1].hash()).toBe(second.contributionHash);
  });

  it("keeps csHash stable across the whole chain", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(7));

    const genesisMpc = await parseMpcParams(genesis, { maxContributions: 0 });
    const contributedMpc = await parseMpcParams(zkey, { maxContributions: 1 });
    expect(contributedMpc.csHash).toBe(genesisMpc.csHash);
  });
});

describe("parseMpcParams fails closed", () => {
  it("rejects a count above the allowed maximum", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(3));
    // The chain holds one contribution; a head of 0 would only permit one, so
    // this stands in for a rebase that carries too many contributions.
    await expect(parseMpcParams(zkey, { maxContributions: 0 })).rejects.toThrow(
      /exceeds the allowed maximum/,
    );
  });

  it("rejects bytes that are not a zkey", async () => {
    const garbage = new Uint8Array(128).fill(0xab);
    await expect(
      parseMpcParams(garbage, { maxContributions: 10 }),
    ).rejects.toThrow(/not a zkey file/);
  });

  it("rejects a truncated zkey", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const truncated = genesis.subarray(0, Math.floor(genesis.length / 2));
    // A truncated file fails closed in the reader during the section walk.
    await expect(
      parseMpcParams(truncated, { maxContributions: 10 }),
    ).rejects.toThrow(/byteReader:/);
  });

  it("rejects a negative maximum", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    await expect(
      parseMpcParams(genesis, { maxContributions: -1 }),
    ).rejects.toThrow(/non-negative integer/);
  });
});

describe("parseMpcParams over a chain", () => {
  it("parses every prefix and every entry matches snarkjs", async () => {
    // Walk each zkey in the chain (1..CHAIN_LEN contributions) and confirm the
    // full embedded list re-hashes to the snarkjs hashes recorded as the chain
    // was built. This covers many distinct valid zkeys of growing length from a
    // single chain build, and confirms prefix entries stay byte-stable as more
    // contributions are layered on.
    for (let count = 1; count <= CHAIN_LEN; count++) {
      const mpc = await parseMpcParams(zkeyByCount[count], {
        maxContributions: count,
      });
      expect(mpc.contributions).toHaveLength(count);
      expect(mpc.contributions.map((c) => c.hash())).toEqual(
        snarkjsHashes.slice(0, count),
      );
      expect(mpc.contributions.every((c) => c.type === 0)).toBe(true);
    }
  });

  it("parses a beacon entry and matches the beacon hash", async () => {
    // The beacon is the only entry of type 1, and the only one whose parameter
    // block carries the iteration-exponent and beacon-hash TLV fields.
    const mpc = await parseMpcParams(beaconZkey, {
      maxContributions: CHAIN_LEN + 1,
    });
    expect(mpc.contributions).toHaveLength(CHAIN_LEN + 1);

    const last = mpc.contributions[CHAIN_LEN];
    expect(last.type).toBe(1);
    expect(last.hash()).toBe(beaconHash);

    // The contributions before the beacon are unchanged.
    expect(mpc.contributions.slice(0, CHAIN_LEN).map((c) => c.hash())).toEqual(
      snarkjsHashes,
    );
  });
});

// Seeded linear congruential generator. Keeps the mutation choices reproducible
// within a run (the base zkey itself still varies run to run, so the
// deterministic truncation sweep below carries the strongest guarantee).
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
}

function isMpcParams(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { contributions?: unknown }).contributions)
  );
}

describe("parseMpcParams fuzz", () => {
  it("rejects every truncation of a valid zkey", async () => {
    // A prefix of a valid file can never itself be valid: the section table or a
    // body read must run past the end. Step through many lengths and confirm
    // each one is rejected rather than silently parsed.
    const valid = zkeyByCount[CHAIN_LEN];
    const step = Math.max(1, Math.floor(valid.length / 200));
    for (let len = 0; len < valid.length; len += step) {
      await expect(
        parseMpcParams(valid.subarray(0, len), {
          maxContributions: CHAIN_LEN,
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects an inflated section count without scanning it", async () => {
    // nSections lives at offset 8 (after the 4-byte magic and the 4-byte
    // version). A huge value must be capped before the table walk allocates.
    const buf = zkeyByCount[CHAIN_LEN].slice();
    new DataView(buf.buffer, buf.byteOffset).setUint32(8, 0xffffffff, true);
    await expect(
      parseMpcParams(buf, { maxContributions: CHAIN_LEN }),
    ).rejects.toThrow(/too many sections/);
  });

  it("never hangs or returns a partial result on random byte flips", async () => {
    // Liveness: a single corrupted byte must leave the parser either returning a
    // well-formed result (the flip hit a section we skip) or throwing — never an
    // infinite loop, an out-of-memory, or a half-built object. maxContributions
    // is generous so a structurally intact file still parses.
    const valid = zkeyByCount[CHAIN_LEN];
    const rng = makeRng(0xc0ffee);
    for (let i = 0; i < 300; i++) {
      const buf = valid.slice();
      const index = rng() % buf.length;
      buf[index] ^= rng() & 0xff || 1;
      try {
        const result = await parseMpcParams(buf, {
          maxContributions: CHAIN_LEN + 4,
        });
        expect(isMpcParams(result)).toBe(true);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });
});
