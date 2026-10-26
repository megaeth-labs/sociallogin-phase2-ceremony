import { describe, expect, it } from "vitest";

import { assertBeaconWasFutureAtSeal, assertVerifiedBeaconMatchesSpec } from "../src/beacon.js";
import {
  EthereumBlockBeaconResolver,
  SourceDispatchingBeaconResolver,
  deriveEthereumBlockBeaconV1,
} from "../src/ethereum-beacon.js";
import type { EthereumBlockBeaconSpec } from "@moss/phase2-protocol";

const BLOCK_HASH = "a".repeat(64);
const PARENT_HASH = "b".repeat(64);
const STATE_ROOT = "c".repeat(64);
const BLOCK_NUMBER = 23_000_000;
const BLOCK_TIMESTAMP = 1_790_000_000;

const spec: EthereumBlockBeaconSpec = {
  source: "ethereum-block",
  chainId: 1,
  blockNumber: BLOCK_NUMBER,
  expectedAt: new Date(BLOCK_TIMESTAMP * 1000).toISOString(),
  derivation: "MOSS_PHASE2_BEACON_V1",
  numIterationsExp: 32,
  contributionName: "final",
};

/** A stub Ethereum RPC whose per-endpoint answers a test can vary. */
function rpc(overrides: Record<string, Partial<Record<string, unknown>>> = {}) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const endpoint = new URL(String(url)).origin;
    const { method, params } = JSON.parse(String(init?.body)) as {
      method: string;
      params: unknown[];
    };
    const over = overrides[endpoint] ?? {};
    const block = {
      number: `0x${BLOCK_NUMBER.toString(16)}`,
      hash: `0x${BLOCK_HASH}`,
      parentHash: `0x${PARENT_HASH}`,
      stateRoot: `0x${STATE_ROOT}`,
      timestamp: `0x${BLOCK_TIMESTAMP.toString(16)}`,
      ...(over.block as object ?? {}),
    };
    const finalizedNumber = (over.finalizedNumber as number) ?? BLOCK_NUMBER + 64;
    let result: unknown;
    if (method === "eth_chainId") result = (over.chainId as string) ?? "0x1";
    else if (params[0] === "finalized") {
      result = { ...block, number: `0x${finalizedNumber.toString(16)}` };
    } else result = block;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const ENDPOINTS = ["https://rpc-a.example", "https://rpc-b.example"];

describe("Ethereum block beacon", () => {
  it("resolves a finalized precommitted block and matches the manifest", async () => {
    const resolver = new EthereumBlockBeaconResolver({
      endpoints: ENDPOINTS,
      fetchImpl: rpc() as typeof fetch,
      now: () => new Date("2026-09-19T00:00:00.000Z"),
    });
    const verified = await resolver.resolve(spec);

    expect(verified.source).toBe("ethereum-block");
    expect(verified.blockHash).toBe(BLOCK_HASH);
    expect(verified.evidence.endpointCount).toBe(2);
    expect(verified.beaconHashHex).toBe(
      deriveEthereumBlockBeaconV1({
        chainId: 1,
        blockNumber: BLOCK_NUMBER,
        blockHash: BLOCK_HASH,
      }),
    );
    // The full manifest cross-check, including evidence-hash reproduction.
    expect(() => assertVerifiedBeaconMatchesSpec(verified, spec)).not.toThrow();
  });

  it("accepts a pinned block arriving later than estimated without relaxing closing or height checks", async () => {
    const estimated = { ...spec, expectedAt: new Date((BLOCK_TIMESTAMP - 2700) * 1000).toISOString() };
    const verified = await new EthereumBlockBeaconResolver({ endpoints: ENDPOINTS,
      fetchImpl: rpc() as typeof fetch }).resolve(estimated);
    expect(() => assertVerifiedBeaconMatchesSpec(verified, estimated)).not.toThrow();
    expect(() => assertBeaconWasFutureAtSeal(verified, new Date((BLOCK_TIMESTAMP - 3600) * 1000).toISOString())).not.toThrow();
    expect(() => assertBeaconWasFutureAtSeal(verified, new Date(BLOCK_TIMESTAMP * 1000).toISOString())).toThrow(/strictly in the future/u);
    expect(() => assertVerifiedBeaconMatchesSpec(verified, { ...estimated, blockNumber: BLOCK_NUMBER + 1 })).toThrow(/commitment/u);
    expect(() => assertVerifiedBeaconMatchesSpec(verified, { ...estimated, expectedAt: "invalid" })).toThrow(/expectedAt is invalid/u);
  });

  it("separates its derivation from drand's", () => {
    // Both derivations start from the same domain string; only the source tag
    // byte differs, so a value pinned under one source can never collide with
    // the other.
    const value = deriveEthereumBlockBeaconV1({
      chainId: 1,
      blockNumber: BLOCK_NUMBER,
      blockHash: BLOCK_HASH,
    });
    expect(value).toMatch(/^[a-f0-9]{64}$/u);
    expect(value).not.toBe(BLOCK_HASH);
  });

  it("refuses a block that any endpoint has not finalized", async () => {
    const resolver = new EthereumBlockBeaconResolver({
      endpoints: ENDPOINTS,
      // Second endpoint's finalized head is still behind the target block.
      fetchImpl: rpc({
        "https://rpc-b.example": { finalizedNumber: BLOCK_NUMBER - 1 },
      }) as typeof fetch,
    });
    await expect(resolver.resolve(spec)).rejects.toThrow(/not finalized/u);
  });

  it("refuses when endpoints disagree on the block hash", async () => {
    const resolver = new EthereumBlockBeaconResolver({
      endpoints: ENDPOINTS,
      fetchImpl: rpc({
        "https://rpc-b.example": { block: { hash: `0x${"d".repeat(64)}` } },
      }) as typeof fetch,
    });
    await expect(resolver.resolve(spec)).rejects.toThrow(/disagree on blockHash/u);
  });

  it("refuses a chain other than the one precommitted", async () => {
    const resolver = new EthereumBlockBeaconResolver({
      endpoints: ENDPOINTS,
      fetchImpl: rpc({ "https://rpc-b.example": { chainId: "0x2" } }) as typeof fetch,
    });
    await expect(resolver.resolve(spec)).rejects.toThrow(/chain id/u);
  });

  it("requires at least two distinct endpoint origins", () => {
    // One provider is a single point of substitution: the manifest pins a
    // height, not a hash, so nothing else would catch a fabricated block.
    expect(() => new EthereumBlockBeaconResolver({
      endpoints: ["https://rpc-a.example", "https://rpc-a.example/other"],
    })).toThrow(/at least 2 distinct endpoint origins/u);
  });

  it("rejects a block that was not in the future when the ceremony sealed", async () => {
    const resolver = new EthereumBlockBeaconResolver({
      endpoints: ENDPOINTS,
      fetchImpl: rpc() as typeof fetch,
    });
    const verified = await resolver.resolve(spec);
    const afterBlock = new Date((BLOCK_TIMESTAMP + 1) * 1000).toISOString();
    expect(() => assertBeaconWasFutureAtSeal(verified, afterBlock)).toThrow(
      /strictly in the future/u,
    );
    const beforeBlock = new Date((BLOCK_TIMESTAMP - 1) * 1000).toISOString();
    expect(() => assertBeaconWasFutureAtSeal(verified, beforeBlock)).not.toThrow();
  });

  it("refuses a source the operator configured no endpoints for", async () => {
    const dispatching = new SourceDispatchingBeaconResolver({});
    await expect(dispatching.resolve(spec)).rejects.toThrow(
      /no endpoints were configured/u,
    );
  });
});
