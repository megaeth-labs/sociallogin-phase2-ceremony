import { createHash } from "node:crypto";

import type { BeaconSpec } from "@moss/phase2-protocol";

import type {
  BeaconResolver,
  EthereumBlockBeaconEvidenceV1,
  VerifiedEthereumBlockBeaconV1,
} from "./types.js";

const RESOLVER_ID = "moss-phase2-ethereum-block" as const;
const RESOLVER_VERSION = "1" as const;
const DERIVATION_DOMAIN = "MOSS_PHASE2_BEACON_V1" as const;
/**
 * Source tag 01 separates this from the drand derivation, which uses 00 in the
 * same position. Two ceremonies pinning the same 32 bytes from different
 * sources therefore cannot derive the same beacon.
 */
export const ETHEREUM_DERIVATION_ENCODING =
  "sha256(utf8(domain)||01||uint64be(chainId)||uint64be(blockNumber)||blockHash32)" as const;

const HEX32 = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MIN_ENDPOINTS = 2;
const MAX_ENDPOINTS = 8;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface EthereumBlockBeaconResolverOptions {
  endpoints: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => Date;
}

interface ObservedBlock {
  chainId: number;
  blockNumber: number;
  blockHash: string;
  parentHash: string;
  stateRoot: string;
  timestamp: number;
  finalizedBlockNumber: number;
}

/**
 * Resolve a precommitted future Ethereum block into a beacon value.
 *
 * Requires unanimity across at least two independently operated endpoints. One
 * provider is a single point of substitution: it could serve a block hash of
 * its choosing, and nothing else in the finalizer would notice, since the value
 * is only ever compared against what the manifest precommitted — a height, not
 * a hash.
 */
export class EthereumBlockBeaconResolver implements BeaconResolver {
  private readonly endpoints: readonly string[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: EthereumBlockBeaconResolverOptions) {
    this.endpoints = normalizeEndpoints(options.endpoints);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error("global fetch is unavailable for Ethereum beacon resolution");
    }
    this.fetchImpl = fetchImpl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 120_000) {
      throw new Error("Ethereum beacon timeout must be an integer from 1000 through 120000 ms");
    }
    this.now = options.now ?? (() => new Date());
  }

  async resolve(spec: Readonly<BeaconSpec>): Promise<VerifiedEthereumBlockBeaconV1> {
    if (spec.source !== "ethereum-block") {
      throw new Error("Ethereum beacon resolver received a non-Ethereum beacon specification");
    }
    if (!Number.isSafeInteger(spec.chainId) || spec.chainId < 1) {
      throw new Error("beacon chainId is invalid");
    }
    if (!Number.isSafeInteger(spec.blockNumber) || spec.blockNumber < 1) {
      throw new Error("beacon blockNumber is invalid");
    }

    const observations = await Promise.all(
      this.endpoints.map((endpoint) => this.observe(endpoint, spec.chainId, spec.blockNumber)),
    );

    // Every endpoint must agree on every field, not merely on the hash. A
    // disagreement anywhere means at least one provider is wrong or dishonest,
    // and there is no safe way to pick a winner.
    const [first, ...rest] = observations;
    for (const other of rest) {
      for (const key of [
        "chainId", "blockNumber", "blockHash", "parentHash", "stateRoot", "timestamp",
      ] as const) {
        if (first[key] !== other[key]) {
          throw new Error(`configured Ethereum endpoints disagree on ${key}`);
        }
      }
    }
    // Finalized heads legitimately differ by a slot or two between providers,
    // so require each to consider the block final rather than demanding they
    // report the same head.
    for (const observation of observations) {
      if (observation.finalizedBlockNumber < spec.blockNumber) {
        throw new Error(
          "precommitted beacon block is not finalized by every configured endpoint",
        );
      }
    }

    const evidence: EthereumBlockBeaconEvidenceV1 = {
      type: "moss.phase2.ethereum-block-evidence.v1",
      chainId: first.chainId,
      blockNumber: first.blockNumber,
      blockHash: first.blockHash,
      parentHash: first.parentHash,
      stateRoot: first.stateRoot,
      timestamp: first.timestamp,
      finalizedBlockNumber: Math.min(...observations.map((o) => o.finalizedBlockNumber)),
      endpointCount: observations.length,
      observedAt: this.now().toISOString(),
    };

    return {
      schemaVersion: 1,
      source: "ethereum-block",
      chainId: first.chainId,
      blockNumber: first.blockNumber,
      blockHash: first.blockHash,
      derivation: DERIVATION_DOMAIN,
      beaconHashHex: deriveEthereumBlockBeaconV1({
        chainId: first.chainId,
        blockNumber: first.blockNumber,
        blockHash: first.blockHash,
      }),
      evidenceSha256: createHash("sha256")
        .update(serializeEthereumBlockEvidence(evidence))
        .digest("hex"),
      evidence,
      verifier: {
        id: RESOLVER_ID,
        version: RESOLVER_VERSION,
        method: "ethereum-finalized-block-hash",
      },
    };
  }

  private async observe(
    endpoint: string,
    expectedChainId: number,
    blockNumber: number,
  ): Promise<ObservedBlock> {
    const [chainIdRaw, blockRaw, finalizedRaw] = await Promise.all([
      this.call(endpoint, "eth_chainId", []),
      this.call(endpoint, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]),
      this.call(endpoint, "eth_getBlockByNumber", ["finalized", false]),
    ]);

    const chainId = quantity(chainIdRaw, "eth_chainId");
    if (chainId !== expectedChainId) {
      throw new Error(
        `endpoint reports chain id ${chainId}, but the manifest precommitted ${expectedChainId}`,
      );
    }

    const block = requireRecord(blockRaw, "beacon block");
    const observedNumber = quantity(block.number, "block number");
    if (observedNumber !== blockNumber) {
      throw new Error("endpoint returned a different block than requested");
    }
    const finalized = requireRecord(finalizedRaw, "finalized block");

    return {
      chainId,
      blockNumber: observedNumber,
      blockHash: hash32(block.hash, "block hash"),
      parentHash: hash32(block.parentHash, "parent hash"),
      stateRoot: hash32(block.stateRoot, "state root"),
      timestamp: quantity(block.timestamp, "block timestamp"),
      finalizedBlockNumber: quantity(finalized.number, "finalized block number"),
    };
  }

  private async call(endpoint: string, method: string, params: unknown[]): Promise<unknown> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": `moss-phase2-finalizer ${RESOLVER_ID}/${RESOLVER_VERSION}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        redirect: "error",
        cache: "no-store",
        signal: abort.signal,
      });
      if (!response.ok) {
        throw new Error(`Ethereum RPC responded ${response.status} for ${method}`);
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error(`Ethereum RPC response for ${method} exceeds the bounded size`);
      }
      const body = requireRecord(JSON.parse(text), `${method} response`);
      if (body.error !== undefined) {
        throw new Error(`Ethereum RPC returned an error for ${method}`);
      }
      if (body.result === null || body.result === undefined) {
        throw new Error(`Ethereum RPC returned no result for ${method}`);
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function deriveEthereumBlockBeaconV1(input: {
  chainId: number;
  blockNumber: number;
  blockHash: string;
}): string {
  if (!HEX32.test(input.blockHash)) {
    throw new Error("beacon block hash must be 32-byte lowercase hex");
  }
  const chainId = Buffer.alloc(8);
  chainId.writeBigUInt64BE(BigInt(input.chainId));
  const blockNumber = Buffer.alloc(8);
  blockNumber.writeBigUInt64BE(BigInt(input.blockNumber));
  return createHash("sha256")
    .update(Buffer.from(DERIVATION_DOMAIN, "utf8"))
    .update(Uint8Array.of(1))
    .update(chainId)
    .update(blockNumber)
    .update(Buffer.from(input.blockHash, "hex"))
    .digest("hex");
}

/** Stable key order, so the evidence hash is reproducible by a third party. */
export function serializeEthereumBlockEvidence(
  evidence: EthereumBlockBeaconEvidenceV1,
): string {
  return `${JSON.stringify({
    type: evidence.type,
    chainId: evidence.chainId,
    blockNumber: evidence.blockNumber,
    blockHash: evidence.blockHash,
    parentHash: evidence.parentHash,
    stateRoot: evidence.stateRoot,
    timestamp: evidence.timestamp,
    finalizedBlockNumber: evidence.finalizedBlockNumber,
    endpointCount: evidence.endpointCount,
    observedAt: evidence.observedAt,
  }, null, 2)}\n`;
}

function normalizeEndpoints(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) throw new Error("Ethereum endpoints must be an array");
  const normalized = values.map((value) => {
    const url = new URL(value);
    if (url.username || url.password) {
      throw new Error("Ethereum endpoint must not embed credentials");
    }
    const localHttp =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !localHttp) {
      throw new Error("Ethereum endpoint must use HTTPS or loopback HTTP");
    }
    return url.toString();
  });
  const distinctOrigins = new Set(normalized.map((value) => new URL(value).origin));
  if (distinctOrigins.size < MIN_ENDPOINTS) {
    throw new Error(
      `Ethereum beacon resolution requires at least ${MIN_ENDPOINTS} distinct endpoint origins`,
    );
  }
  if (normalized.length > MAX_ENDPOINTS) {
    throw new Error(`Ethereum beacon resolution accepts at most ${MAX_ENDPOINTS} endpoints`);
  }
  return normalized;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

/** Decode an RPC 0x-prefixed quantity into a safe integer. */
function quantity(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/iu.test(value)) {
    throw new Error(`${label} is not a hex quantity`);
  }
  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is out of range`);
  return parsed;
}

/** Decode an RPC 32-byte hash into lowercase, unprefixed hex. */
function hash32(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  const normalized = value.toLowerCase().replace(/^0x/u, "");
  if (!HEX32.test(normalized)) throw new Error(`${label} is not 32-byte hex`);
  return normalized;
}

/**
 * Chooses a resolver from the beacon source the signed manifest precommitted.
 *
 * The finalizer is invoked before the manifest is read, so the operator
 * supplies endpoints for whichever sources they configured and the selection
 * happens once the commitment is known. A source with no endpoints configured
 * fails loudly rather than silently falling back to another.
 */
export class SourceDispatchingBeaconResolver implements BeaconResolver {
  constructor(
    private readonly resolvers: Partial<Record<BeaconSpec["source"], BeaconResolver>>,
  ) {}

  async resolve(spec: Readonly<BeaconSpec>) {
    const resolver = this.resolvers[spec.source];
    if (!resolver) {
      throw new Error(
        `the signed manifest precommits a ${spec.source} beacon, but no endpoints were configured for it`,
      );
    }
    return resolver.resolve(spec);
  }
}
