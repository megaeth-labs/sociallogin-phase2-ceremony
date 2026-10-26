import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  generateInitialZkey,
  contribute,
  verify,
  verifyChain,
  verifyChainForCircuit,
  generateEntropy,
  deriveSeed,
  applyBeacon,
  exportVerificationKey,
} from "../src/index.js";
import { bytesToHexRaw, toHex } from "../src/hex.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): Uint8Array {
  const buf = readFileSync(join(FIXTURES, name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const r1cs = loadFixture("multiplier.r1cs");
const ptau = loadFixture("pot_final.ptau");

describe("generateInitialZkey", () => {
  it("generates a valid genesis zkey from ptau + r1cs", async () => {
    const zkey = await generateInitialZkey(ptau, r1cs);
    expect(zkey).toBeInstanceOf(Uint8Array);
    expect(zkey.length).toBeGreaterThan(0);
  });
});

describe("contribute", () => {
  it("produces a new zkey and contribution hash", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const entropy = new Uint8Array(32);
    crypto.getRandomValues(entropy);

    const result = await contribute(genesis, entropy, "test-contributor");
    expect(result.zkey).toBeInstanceOf(Uint8Array);
    expect(result.zkey.length).toBeGreaterThan(0);
    expect(result.contributionHash).toMatch(/^0x[0-9a-f]{128}$/);
    expect(result.zkeyHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces different zkeys for different entropy", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);

    const entropy1 = new Uint8Array(32).fill(1);
    const entropy2 = new Uint8Array(32).fill(2);

    const result1 = await contribute(genesis, entropy1);
    const result2 = await contribute(genesis, entropy2);

    expect(result1.contributionHash).not.toBe(result2.contributionHash);
    expect(result1.zkeyHash).not.toBe(result2.zkeyHash);
  });

  it("rejects empty entropy", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    await expect(
      contribute(genesis, new Uint8Array(0), "empty"),
    ).rejects.toThrow(/entropy must not be empty/i);
  });
});

describe("verify", () => {
  it("accepts a valid contributed zkey", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const entropy = new Uint8Array(32).fill(42);
    const { zkey } = await contribute(genesis, entropy);

    const valid = await verify(r1cs, ptau, zkey);
    expect(valid).toBe(true);
  });

  it("returns false for a tampered zkey", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const entropy = new Uint8Array(32).fill(42);
    const { zkey } = await contribute(genesis, entropy);

    // Tamper with the zkey data (corrupt bytes in the middle)
    const tampered = new Uint8Array(zkey);
    const mid = Math.floor(tampered.length / 2);
    tampered[mid] ^= 0xff;
    tampered[mid + 1] ^= 0xff;

    const valid = await verify(r1cs, ptau, tampered);
    expect(valid).toBe(false);
  });

  it("returns false on a completely invalid zkey instead of throwing", async () => {
    const garbage = new Uint8Array(64).fill(0xde);
    const valid = await verify(r1cs, ptau, garbage);
    expect(valid).toBe(false);
  });

  it("returns false on an empty zkey", async () => {
    const valid = await verify(r1cs, ptau, new Uint8Array(0));
    expect(valid).toBe(false);
  });
});

describe("verifyChain", () => {
  it("validates a chain of 3 contributions", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);

    const { zkey: zkey1 } = await contribute(
      genesis,
      new Uint8Array(32).fill(1),
    );
    const { zkey: zkey2 } = await contribute(
      zkey1,
      new Uint8Array(32).fill(2),
    );
    const { zkey: zkey3 } = await contribute(
      zkey2,
      new Uint8Array(32).fill(3),
    );

    const valid = await verifyChain(ptau, genesis, zkey3);
    expect(valid).toBe(true);
  });

  it("returns true when latestZkey equals initialZkey", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const valid = await verifyChain(ptau, genesis, genesis);
    expect(valid).toBe(true);
  });

  it("returns false when the latest zkey is tampered", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(7));

    const tampered = new Uint8Array(zkey);
    const mid = Math.floor(tampered.length / 2);
    tampered[mid] ^= 0xff;
    tampered[mid + 1] ^= 0xff;

    const valid = await verifyChain(ptau, genesis, tampered);
    expect(valid).toBe(false);
  });

  it("returns false on a completely invalid latestZkey instead of throwing", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const garbage = new Uint8Array(64).fill(0xde);
    const valid = await verifyChain(ptau, genesis, garbage);
    expect(valid).toBe(false);
  });
});

describe("verifyChainForCircuit", () => {
  it("validates a chain bound to the expected circuit", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey: zkey1 } = await contribute(
      genesis,
      new Uint8Array(32).fill(1),
    );
    const { zkey: zkey2 } = await contribute(
      zkey1,
      new Uint8Array(32).fill(2),
    );

    const valid = await verifyChainForCircuit(r1cs, ptau, genesis, zkey2);
    expect(valid).toBe(true);
  });

  it("validates the empty-chain case when the genesis matches the circuit", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const valid = await verifyChainForCircuit(r1cs, ptau, genesis, genesis);
    expect(valid).toBe(true);
  });

  it("rejects identical garbage inputs (closes the empty-chain footgun)", async () => {
    const garbage = new Uint8Array(64).fill(0xde);
    const valid = await verifyChainForCircuit(r1cs, ptau, garbage, garbage);
    expect(valid).toBe(false);
  });

  it("rejects a genesis that does not correspond to the circuit", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const tamperedGenesis = new Uint8Array(genesis);
    const mid = Math.floor(tamperedGenesis.length / 2);
    tamperedGenesis[mid] ^= 0xff;
    tamperedGenesis[mid + 1] ^= 0xff;

    const valid = await verifyChainForCircuit(
      r1cs,
      ptau,
      tamperedGenesis,
      tamperedGenesis,
    );
    expect(valid).toBe(false);
  });

  it("rejects a tampered tail even with a valid genesis", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(9));

    const tampered = new Uint8Array(zkey);
    const mid = Math.floor(tampered.length / 2);
    tampered[mid] ^= 0xff;
    tampered[mid + 1] ^= 0xff;

    const valid = await verifyChainForCircuit(r1cs, ptau, genesis, tampered);
    expect(valid).toBe(false);
  });

  it("returns false on a completely invalid latestZkey instead of throwing", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const garbage = new Uint8Array(64).fill(0xde);
    const valid = await verifyChainForCircuit(r1cs, ptau, genesis, garbage);
    expect(valid).toBe(false);
  });
});

describe("generateEntropy", () => {
  it("returns 64 bytes of entropy", async () => {
    const entropy = await generateEntropy();
    expect(entropy).toBeInstanceOf(Uint8Array);
    expect(entropy.length).toBe(64);
  });

  it("produces different values on each call", async () => {
    const e1 = await generateEntropy();
    const e2 = await generateEntropy();
    expect(Buffer.from(e1).equals(Buffer.from(e2))).toBe(false);
  });

  it("mixes additional entropy sources", async () => {
    const mouseData = new Uint8Array(16).fill(0xaa);
    const result = await generateEntropy([
      { type: "mouse", data: mouseData },
    ]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(64);
  });
});

describe("deriveSeed", () => {
  const ikm = new Uint8Array(64).fill(0x42);

  it("returns 64 bytes by default", async () => {
    const seed = await deriveSeed(ikm);
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBe(64);
  });

  it("honors a custom output length", async () => {
    const seed = await deriveSeed(ikm, new Uint8Array(), 32);
    expect(seed.length).toBe(32);
  });

  it("is deterministic for the same ikm and info", async () => {
    const a = await deriveSeed(ikm, new TextEncoder().encode("circuit-1"));
    const b = await deriveSeed(ikm, new TextEncoder().encode("circuit-1"));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("domain-separates by info", async () => {
    const a = await deriveSeed(ikm, new TextEncoder().encode("circuit-1"));
    const b = await deriveSeed(ikm, new TextEncoder().encode("circuit-2"));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("produces different output for different ikm", async () => {
    const a = await deriveSeed(new Uint8Array(64).fill(0x01));
    const b = await deriveSeed(new Uint8Array(64).fill(0x02));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe("applyBeacon", () => {
  const VALID_BEACON =
    "0102030405060708091011121314151617181920212223242526272829303132";

  it("produces a finalized zkey, contribution hash, and zkey hash", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    const finalized = await applyBeacon(zkey, VALID_BEACON);

    expect(finalized.zkey).toBeInstanceOf(Uint8Array);
    expect(finalized.zkey.length).toBeGreaterThan(0);
    expect(finalized.contributionHash).toMatch(/^0x[0-9a-f]{128}$/);
    expect(finalized.zkeyHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces deterministic output for the same beacon", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    const finalized1 = await applyBeacon(zkey, VALID_BEACON);
    const finalized2 = await applyBeacon(zkey, VALID_BEACON);

    expect(
      Buffer.from(finalized1.zkey).equals(Buffer.from(finalized2.zkey)),
    ).toBe(true);
    expect(finalized1.contributionHash).toBe(finalized2.contributionHash);
    expect(finalized1.zkeyHash).toBe(finalized2.zkeyHash);
  });

  it("accepts a beacon with the 0x prefix", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    const finalized = await applyBeacon(zkey, `0x${VALID_BEACON}`);
    expect(finalized.zkey.length).toBeGreaterThan(0);
  });

  it("rejects non-hex beacon", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    await expect(applyBeacon(zkey, "xyz")).rejects.toThrow(/hex/i);
  });

  it("rejects odd-length beacon", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    await expect(applyBeacon(zkey, "abc")).rejects.toThrow(/even/i);
  });

  it("rejects a beacon shorter than 32 bytes", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    await expect(applyBeacon(zkey, "00".repeat(31))).rejects.toThrow(
      /at least 32 bytes/i,
    );
  });

  it("rejects an empty beacon", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    await expect(applyBeacon(zkey, "")).rejects.toThrow(/at least 32 bytes/i);
  });

  it("rejects a beacon longer than 255 bytes (matches snarkjs upper bound)", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    await expect(applyBeacon(zkey, "00".repeat(256))).rejects.toThrow(
      /at most 255 bytes/i,
    );
  });

  it("rejects out-of-range numIterationsExp", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    // Below the new lower bound of 10 (was 1 before; snarkjs rejects < 10).
    await expect(applyBeacon(zkey, VALID_BEACON, 9)).rejects.toThrow(
      /numIterationsExp/,
    );
    await expect(applyBeacon(zkey, VALID_BEACON, 0)).rejects.toThrow(
      /numIterationsExp/,
    );
    await expect(applyBeacon(zkey, VALID_BEACON, 33)).rejects.toThrow(
      /numIterationsExp/,
    );
    await expect(applyBeacon(zkey, VALID_BEACON, 1.5)).rejects.toThrow(
      /numIterationsExp/,
    );
  });
});

describe("hex helpers", () => {
  it("bytesToHexRaw produces lowercase hex without prefix", () => {
    expect(bytesToHexRaw(new Uint8Array([0xab, 0xcd, 0xef]))).toBe("abcdef");
  });

  it("bytesToHexRaw left-pads single-digit nibbles", () => {
    expect(bytesToHexRaw(new Uint8Array([0x00, 0x0a, 0xff]))).toBe("000aff");
  });

  it("bytesToHexRaw on empty input returns empty string", () => {
    expect(bytesToHexRaw(new Uint8Array(0))).toBe("");
  });

  it("toHex prefixes the same encoding with 0x", () => {
    const bytes = new Uint8Array([0x12, 0x34]);
    expect(toHex(bytes)).toBe(`0x${bytesToHexRaw(bytes)}`);
  });

  it("Node and browser-worker entropy encodings agree", () => {
    // Regression guard: if the Node and worker hex paths drift apart,
    // identical entropy bytes will produce different snarkjs contributions.
    const entropy = new Uint8Array(64);
    for (let i = 0; i < entropy.length; i++) entropy[i] = i;

    const nodePath = bytesToHexRaw(entropy);
    const inlineFallback = Array.from(entropy)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    expect(nodePath).toBe(inlineFallback);
    expect(nodePath.startsWith("0x")).toBe(false);
  });
});

describe("exportVerificationKey", () => {
  it("extracts vkey from a finalized zkey", async () => {
    const genesis = await generateInitialZkey(ptau, r1cs);
    const { zkey } = await contribute(genesis, new Uint8Array(32).fill(1));

    const beaconHash =
      "0102030405060708091011121314151617181920212223242526272829303132";
    const finalized = await applyBeacon(zkey, beaconHash);

    const vkey = await exportVerificationKey(finalized.zkey);

    expect(vkey).toHaveProperty("protocol", "groth16");
    expect(vkey).toHaveProperty("curve");
    expect(vkey).toHaveProperty("nPublic");
    expect(vkey).toHaveProperty("vk_alpha_1");
    expect(vkey).toHaveProperty("vk_beta_2");
    expect(vkey).toHaveProperty("vk_gamma_2");
    expect(vkey).toHaveProperty("vk_delta_2");
    expect(vkey).toHaveProperty("IC");
  });
});
