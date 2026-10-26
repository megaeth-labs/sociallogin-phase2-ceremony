import { describe, expect, it } from "vitest";

import type { BeaconSpec } from "@moss/phase2-protocol";

import {
  DrandBeaconResolver,
  assertBeaconWasFutureAtSeal,
  assertVerifiedBeaconMatchesSpec,
  computeDrandChainInfoHash,
  deriveMossPhase2BeaconV1,
} from "../src/beacon.js";

const DEFAULT_CHAIN_HASH =
  "8990e7a9aaed2ffed73dbd7092123d6f289930540d7651336225dc172e51b2ce";
const DEFAULT_CHAIN_INFO = {
  public_key:
    "868f005eb8e6e4ca0a47c8a77ceaa5309a47978a7c71bc5cce96366b5d7a569937c529eeda66c7293784a9402801af31",
  period: 30,
  genesis_time: 1_595_431_050,
  hash: DEFAULT_CHAIN_HASH,
  groupHash:
    "176f93498eac9ca337150b46d21dd58673ea4e3581185f869672e59fa4cb390a",
  schemeID: "pedersen-bls-chained",
  metadata: { beaconID: "default" },
};
const DEFAULT_ROUND_ONE = {
  round: 1,
  randomness:
    "101297f1ca7dc44ef6088d94ad5fb7ba03455dc33d53ddb412bbc4564ed986ec",
  signature:
    "8d61d9100567de44682506aea1a7a6fa6e5491cd27a0a0ed349ef6910ac5ac20ff7bc3e09d7c046566c9f7f3c6f3b10104990e7cb424998203d8f7de586fb7fa5f60045417a432684f85093b06ca91c769f0e7ca19268375e659c2a2352b4655",
  previous_signature:
    "176f93498eac9ca337150b46d21dd58673ea4e3581185f869672e59fa4cb390a",
};
const SPEC: BeaconSpec = {
  source: "drand",
  chainHash: DEFAULT_CHAIN_HASH,
  round: 1,
  expectedAt: "2020-07-22T15:17:30.000Z",
  derivation: "MOSS_PHASE2_BEACON_V1",
  numIterationsExp: 10,
  contributionName: "test-beacon",
};

describe("drand chain and beacon verification", () => {
  it("recomputes official default and quicknet chain hashes", () => {
    expect(
      computeDrandChainInfoHash({
        periodSeconds: DEFAULT_CHAIN_INFO.period,
        genesisTime: DEFAULT_CHAIN_INFO.genesis_time,
        publicKey: DEFAULT_CHAIN_INFO.public_key,
        groupHash: DEFAULT_CHAIN_INFO.groupHash,
        beaconId: DEFAULT_CHAIN_INFO.metadata.beaconID,
      }),
    ).toBe(DEFAULT_CHAIN_HASH);

    expect(
      computeDrandChainInfoHash({
        periodSeconds: 3,
        genesisTime: 1_692_803_367,
        publicKey:
          "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
        groupHash:
          "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
        beaconId: "quicknet",
      }),
    ).toBe(
      "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    );
  });

  it("derives the exact domain-separated 32-byte Phase 2 beacon", () => {
    expect(
      deriveMossPhase2BeaconV1({
        chainHash: DEFAULT_CHAIN_HASH,
        round: 1,
        randomness: DEFAULT_ROUND_ONE.randomness,
      }),
    ).toBe(
      "3e15f491f29941a6a49110761145a9ecca24de426d3e968b30576af0be3d440d",
    );
  });

  it("verifies an official BLS beacon through two offline endpoint fixtures", async () => {
    const resolver = new DrandBeaconResolver({
      endpoints: ["https://b.example.test", "https://a.example.test/"],
      fetchImpl: fixtureFetch(),
    });
    const verified = await resolver.resolve(SPEC);

    expect(verified.beaconHashHex).toBe(
      "3e15f491f29941a6a49110761145a9ecca24de426d3e968b30576af0be3d440d",
    );
    expect(verified.evidence.sources.map(({ endpoint }) => endpoint)).toEqual([
      "https://a.example.test",
      "https://b.example.test",
    ]);
    expect(verified.evidence.chainInfo.roundTime).toBe(SPEC.expectedAt);
    expect(() => assertVerifiedBeaconMatchesSpec(verified, SPEC)).not.toThrow();
  });

  it("rejects randomness that is not derived from the signed beacon", async () => {
    const resolver = new DrandBeaconResolver({
      endpoints: ["https://a.example.test", "https://b.example.test"],
      fetchImpl: fixtureFetch({
        beacon: { ...DEFAULT_ROUND_ONE, randomness: "00".repeat(32) },
      }),
    });
    await expect(resolver.resolve(SPEC)).rejects.toThrow(
      /endpoint verification failed/i,
    );
  });

  it("rejects evidence mutation and an expectedAt before the pinned round", async () => {
    const resolver = new DrandBeaconResolver({
      endpoints: ["https://a.example.test", "https://b.example.test"],
      fetchImpl: fixtureFetch(),
    });
    const verified = await resolver.resolve(SPEC);
    const mutated = structuredClone(verified);
    mutated.evidence.beacon.randomness = "00".repeat(32);
    expect(() => assertVerifiedBeaconMatchesSpec(mutated, SPEC)).toThrow(
      /randomness|evidence|derivation/i,
    );

    await expect(
      resolver.resolve({
        ...SPEC,
        expectedAt: "2020-07-22T15:17:29.999Z",
      }),
    ).rejects.toThrow(/expectedAt predates/i);
  });

  it("rejects chain info whose advertised hash is pinned but recomputation differs", async () => {
    const resolver = new DrandBeaconResolver({
      endpoints: ["https://a.example.test", "https://b.example.test"],
      fetchImpl: fixtureFetch({
        info: { ...DEFAULT_CHAIN_INFO, period: 31 },
      }),
    });
    await expect(resolver.resolve(SPEC)).rejects.toThrow(
      /endpoint verification failed/i,
    );
  });

  it("requires distinct HTTPS origins and a future-at-seal round", async () => {
    expect(
      () =>
        new DrandBeaconResolver({
          endpoints: ["https://same.example/a", "https://same.example/b"],
          fetchImpl: fixtureFetch(),
        }),
    ).toThrow(/distinct HTTPS origins/i);
    expect(
      () =>
        new DrandBeaconResolver({
          endpoints: ["http://a.example.test", "https://b.example.test"],
          fetchImpl: fixtureFetch(),
        }),
    ).toThrow(/HTTPS/i);

    const verified = await new DrandBeaconResolver({
      endpoints: ["https://a.example.test", "https://b.example.test"],
      fetchImpl: fixtureFetch(),
    }).resolve(SPEC);
    expect(() =>
      assertBeaconWasFutureAtSeal(
        verified,
        "2020-07-22T15:17:30.000Z",
      ),
    ).toThrow(/strictly in the future/i);
  });
});

function fixtureFetch(
  overrides: {
    info?: Record<string, unknown>;
    beacon?: Record<string, unknown>;
  } = {},
): typeof globalThis.fetch {
  return (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const value = url.endsWith("/info")
      ? (overrides.info ?? DEFAULT_CHAIN_INFO)
      : (overrides.beacon ?? DEFAULT_ROUND_ONE);
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}
