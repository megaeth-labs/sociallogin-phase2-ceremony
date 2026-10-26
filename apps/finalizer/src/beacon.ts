import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchBeacon,
  type Chain,
  type ChainClient,
  type ChainInfo,
  type RandomnessBeacon,
} from "drand-client";

import {
  canonicalize,
  type BeaconSpec,
  type DrandBeaconSpec,
  type EthereumBlockBeaconSpec,
  type JsonValue,
} from "@moss/phase2-protocol";

import {
  deriveEthereumBlockBeaconV1,
  serializeEthereumBlockEvidence,
} from "./ethereum-beacon.js";

import { sha256Bytes } from "./hashing.js";
import type {
  BeaconResolver,
  DrandBeaconEvidenceV1,
  DrandBeaconRecordEvidenceV1,
  DrandChainInfoEvidenceV1,
  DrandEvidenceSourceV1,
  VerifiedBeaconV1,
  VerifiedEthereumBlockBeaconV1,
} from "./types.js";

const DRAND_CLIENT_VERSION = "1.4.2" as const;
const DERIVATION_DOMAIN = "MOSS_PHASE2_BEACON_V1" as const;
const DERIVATION_ENCODING =
  "sha256(utf8(domain)||00||chainHash32||uint64be(round)||randomness32)" as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const EVEN_LOWER_HEX = /^(?:[a-f0-9]{2})+$/u;
const SAFE_BEACON_ID = /^(?:default|[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u;
const SUPPORTED_SCHEMES = new Set<DrandChainInfoEvidenceV1["schemeId"]>([
  "pedersen-bls-chained",
  "pedersen-bls-unchained",
  "bls-unchained-on-g1",
  "bls-unchained-g1-rfc9380",
  "bls-bn254-unchained-on-g1",
]);
const MAX_RESPONSE_BYTES = 64 * 1024;
const MIN_ENDPOINTS = 2;
const MAX_ENDPOINTS = 8;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface DrandBeaconResolverOptions {
  /** Distinct HTTPS operator origins; every configured endpoint must agree. */
  endpoints: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface EndpointResult {
  chainInfo: DrandChainInfoEvidenceV1;
  beacon: DrandBeaconRecordEvidenceV1;
  source: DrandEvidenceSourceV1;
}

/**
 * Production resolver for a manifest-pinned drand round.
 *
 * Endpoint responses are untrusted. The resolver independently recomputes the
 * official chain-info hash and then delegates BLS signature and randomness
 * verification to exact-pinned drand-client 1.4.2. All configured, distinct
 * HTTPS origins must return identical cryptographic evidence.
 */
export class DrandBeaconResolver implements BeaconResolver {
  private readonly endpoints: readonly string[];
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: DrandBeaconResolverOptions) {
    this.endpoints = normalizeEndpoints(options.endpoints);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("global fetch is unavailable for drand resolution");
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1_000 ||
      this.timeoutMs > 120_000
    ) {
      throw new Error("drand timeout must be an integer from 1000 through 120000 ms");
    }
  }

  async resolve(spec: Readonly<BeaconSpec>): Promise<VerifiedBeaconV1> {
    assertBeaconSpecShape(spec);
    if (spec.source !== "drand") {
      throw new Error("drand resolver received a non-drand beacon specification");
    }
    await assertPinnedDrandClientVersion();

    const results = await Promise.all(
      this.endpoints.map(async (endpoint) =>
        await this.resolveFromEndpoint(endpoint, spec),
      ),
    );
    const agreedEvidence = canonicalize({
      chainInfo: results[0].chainInfo,
      beacon: results[0].beacon,
    } as unknown as JsonValue);
    for (const result of results.slice(1)) {
      const candidate = canonicalize({
        chainInfo: result.chainInfo,
        beacon: result.beacon,
      } as unknown as JsonValue);
      if (candidate !== agreedEvidence) {
        throw new Error("configured drand endpoints did not return identical evidence");
      }
    }

    const { chainInfo, beacon } = results[0];
    const beaconHashHex = deriveMossPhase2BeaconV1({
      chainHash: spec.chainHash,
      round: spec.round,
      randomness: beacon.randomness,
    });
    const evidence: DrandBeaconEvidenceV1 = {
      schemaVersion: 1,
      type: "moss.phase2.drand-evidence.v1",
      chainHash: spec.chainHash,
      round: spec.round,
      chainInfo,
      beacon,
      sources: results.map(({ source }) => source),
      verification: {
        implementation: "drand-client",
        implementationVersion: DRAND_CLIENT_VERSION,
        chainInfoHashAlgorithm: "drand-chain-info-v1",
        beaconVerification: "bls-signature-and-sha256-randomness",
        sourceAgreement: "all-configured-distinct-origins",
      },
      derivation: {
        name: DERIVATION_DOMAIN,
        encoding: DERIVATION_ENCODING,
        beaconHashHex,
      },
    };
    const evidenceBytes = serializeDrandEvidence(evidence);

    const verified: VerifiedBeaconV1 = {
      schemaVersion: 1,
      source: "drand",
      chainHash: spec.chainHash,
      round: spec.round,
      derivation: DERIVATION_DOMAIN,
      beaconHashHex,
      evidenceSha256: sha256Bytes(evidenceBytes),
      evidence,
      verifier: {
        id: "moss-finalizer/drand-client",
        version: DRAND_CLIENT_VERSION,
        method: "drand-bls-signature-and-chain-hash",
      },
    };
    assertVerifiedBeaconMatchesSpec(verified, spec);
    return verified;
  }

  private async resolveFromEndpoint(
    endpoint: string,
    spec: Readonly<DrandBeaconSpec>,
  ): Promise<EndpointResult> {
    const infoUrl = `${endpoint}/${spec.chainHash}/info`;
    const beaconUrl = `${endpoint}/${spec.chainHash}/public/${spec.round}`;
    try {
      const infoJson = await fetchBoundedJson(
        infoUrl,
        this.fetchImpl,
        this.timeoutMs,
      );
      const normalizedInfo = normalizeChainInfo(infoJson, spec);
      const beaconJson = await fetchBoundedJson(
        beaconUrl,
        this.fetchImpl,
        this.timeoutMs,
      );
      const normalizedBeacon = normalizeBeacon(
        beaconJson,
        normalizedInfo.evidence.schemeId,
        spec.round,
      );

      const chain: Chain = {
        baseUrl: endpoint,
        info: async () => normalizedInfo.client,
      };
      const client: ChainClient = {
        options: {
          disableBeaconVerification: false,
          noCache: true,
          chainVerificationParams: {
            chainHash: spec.chainHash,
            publicKey: normalizedInfo.client.public_key,
          },
        },
        latest: async () => normalizedBeacon.client,
        get: async (round: number) => {
          if (round !== spec.round) {
            throw new Error("drand verifier requested an unexpected round");
          }
          return normalizedBeacon.client;
        },
        chain: () => chain,
      };
      await fetchBeacon(client, spec.round);

      return {
        chainInfo: normalizedInfo.evidence,
        beacon: normalizedBeacon.evidence,
        source: { endpoint, infoUrl, beaconUrl },
      };
    } catch (error) {
      throw new Error(`drand endpoint verification failed for ${endpoint}`, {
        cause: error,
      });
    }
  }
}

/** Explicit fail-closed resolver retained for embedding callers. */
export class UnavailableBeaconResolver implements BeaconResolver {
  async resolve(_spec: Readonly<BeaconSpec>): Promise<VerifiedBeaconV1> {
    throw new Error(
      "BEACON_RESOLVER_UNAVAILABLE: configure at least two distinct HTTPS " +
        "drand endpoints for cryptographic beacon resolution",
    );
  }
}

export function assertVerifiedBeaconMatchesSpec(
  beacon: VerifiedBeaconV1,
  spec: Readonly<BeaconSpec>,
): void {
  assertBeaconSpecShape(spec);
  if (beacon.schemaVersion !== 1) {
    throw new Error("verified beacon schemaVersion is unsupported");
  }
  if (beacon.source !== spec.source) {
    throw new Error("verified beacon does not match the signed manifest commitment");
  }
  if (beacon.source === "ethereum-block" && spec.source === "ethereum-block") {
    assertVerifiedEthereumBlockBeaconMatchesSpec(beacon, spec);
    return;
  }
  if (beacon.source !== "drand" || spec.source !== "drand") {
    throw new Error("verified beacon source is unsupported");
  }
  if (
    beacon.chainHash !== spec.chainHash ||
    beacon.round !== spec.round ||
    beacon.derivation !== spec.derivation
  ) {
    throw new Error("verified beacon does not match the signed manifest commitment");
  }
  if (!SHA256.test(beacon.beaconHashHex)) {
    throw new Error("verified beacon hash must be exactly 32 lowercase hex bytes");
  }
  if (!SHA256.test(beacon.evidenceSha256)) {
    throw new Error("verified beacon evidence SHA-256 is malformed");
  }
  if (
    beacon.verifier.id !== "moss-finalizer/drand-client" ||
    beacon.verifier.version !== DRAND_CLIENT_VERSION ||
    beacon.verifier.method !== "drand-bls-signature-and-chain-hash"
  ) {
    throw new Error("verified beacon resolver identity is invalid");
  }

  assertDrandEvidence(beacon.evidence, spec);
  const evidenceSha256 = sha256Bytes(serializeDrandEvidence(beacon.evidence));
  if (evidenceSha256 !== beacon.evidenceSha256) {
    throw new Error("verified beacon evidence bytes do not match their SHA-256");
  }
  if (
    beacon.evidence.derivation.beaconHashHex !== beacon.beaconHashHex ||
    deriveMossPhase2BeaconV1({
      chainHash: beacon.chainHash,
      round: beacon.round,
      randomness: beacon.evidence.beacon.randomness,
    }) !== beacon.beaconHashHex
  ) {
    throw new Error("verified beacon derivation does not match its evidence");
  }

  const expectedAt = Date.parse(spec.expectedAt);
  const roundTime = Date.parse(beacon.evidence.chainInfo.roundTime);
  if (!Number.isFinite(expectedAt) || expectedAt < roundTime) {
    throw new Error("manifest beacon expectedAt predates the committed drand round");
  }
}

function assertVerifiedEthereumBlockBeaconMatchesSpec(
  beacon: VerifiedEthereumBlockBeaconV1,
  spec: Readonly<EthereumBlockBeaconSpec>,
): void {
  if (
    beacon.chainId !== spec.chainId ||
    beacon.blockNumber !== spec.blockNumber ||
    beacon.derivation !== spec.derivation
  ) {
    throw new Error("verified beacon does not match the signed manifest commitment");
  }
  if (!SHA256.test(beacon.beaconHashHex)) {
    throw new Error("verified beacon hash must be exactly 32 lowercase hex bytes");
  }
  if (!SHA256.test(beacon.evidenceSha256) || !SHA256.test(beacon.blockHash)) {
    throw new Error("verified beacon evidence SHA-256 is malformed");
  }
  if (
    beacon.verifier.id !== "moss-phase2-ethereum-block" ||
    beacon.verifier.method !== "ethereum-finalized-block-hash"
  ) {
    throw new Error("verified beacon resolver identity is invalid");
  }

  const evidence = beacon.evidence;
  if (
    evidence.type !== "moss.phase2.ethereum-block-evidence.v1" ||
    evidence.chainId !== spec.chainId ||
    evidence.blockNumber !== spec.blockNumber ||
    evidence.blockHash !== beacon.blockHash
  ) {
    throw new Error("verified beacon evidence does not match the signed manifest commitment");
  }
  // The block must be final, not merely deep. Anything less leaves a reorg
  // able to change the ceremony's ending after the fact.
  if (evidence.finalizedBlockNumber < evidence.blockNumber) {
    throw new Error("beacon block was not finalized when the evidence was produced");
  }
  if (evidence.endpointCount < 2) {
    throw new Error("beacon evidence must come from at least two independent endpoints");
  }
  if (
    sha256Bytes(Buffer.from(serializeEthereumBlockEvidence(evidence), "utf8")) !==
    beacon.evidenceSha256
  ) {
    throw new Error("verified beacon evidence bytes do not match their SHA-256");
  }
  if (
    deriveEthereumBlockBeaconV1({
      chainId: beacon.chainId,
      blockNumber: beacon.blockNumber,
      blockHash: beacon.blockHash,
    }) !== beacon.beaconHashHex
  ) {
    throw new Error("verified beacon derivation does not match its evidence");
  }

  const expectedAt = Date.parse(spec.expectedAt);
  // Ethereum block arrival is estimated, unlike a scheduled drand round.
  // Bind the exact height/hash above; assertBeaconWasFutureAtSeal separately
  // requires its actual consensus timestamp to be strictly after closing.
  if (!Number.isFinite(expectedAt)) {
    throw new Error("manifest beacon expectedAt is invalid");
  }
}

export function assertBeaconWasFutureAtSeal(
  beacon: VerifiedBeaconV1,
  sealsAt: string,
): void {
  const sealed = Date.parse(sealsAt);
  if (!Number.isFinite(sealed)) throw new Error("ceremony sealing time is invalid");
  if (beacon.source === "ethereum-block") {
    // The block's own consensus timestamp, so this is checked against the
    // chain's record of when the value came into existence rather than when
    // the finalizer happened to observe it.
    const blockTime = beacon.evidence.timestamp * 1000;
    if (!Number.isFinite(blockTime)) throw new Error("beacon block timestamp is invalid");
    if (blockTime <= sealed) {
      throw new Error(
        "precommitted beacon block was not strictly in the future when the ceremony sealed",
      );
    }
    return;
  }
  const roundTime = Date.parse(beacon.evidence.chainInfo.roundTime);
  if (!Number.isFinite(sealed) || !Number.isFinite(roundTime)) {
    throw new Error("drand round or ceremony sealing time is invalid");
  }
  if (roundTime <= sealed) {
    throw new Error(
      "precommitted drand round was not strictly in the future when the ceremony sealed",
    );
  }
}

export function serializeDrandEvidence(
  evidence: DrandBeaconEvidenceV1,
): Buffer {
  return Buffer.from(
    `${canonicalize(evidence as unknown as JsonValue)}\n`,
    "utf8",
  );
}

/** Official drand chain-info v1 hash encoding. The scheme is not hash input. */
export function computeDrandChainInfoHash(input: {
  periodSeconds: number;
  genesisTime: number;
  publicKey: string;
  groupHash: string;
  beaconId: string;
}): string {
  assertUint32(input.periodSeconds, "drand period");
  assertNonnegativeSafeInteger(input.genesisTime, "drand genesis time");
  assertBoundedHex(input.publicKey, "drand public key", 1, 512);
  assertBoundedHex(input.groupHash, "drand group hash", 1, 512);
  assertBeaconId(input.beaconId);

  const period = Buffer.alloc(4);
  period.writeUInt32BE(input.periodSeconds);
  const genesis = Buffer.alloc(8);
  genesis.writeBigInt64BE(BigInt(input.genesisTime));
  const hash = createHash("sha256")
    .update(period)
    .update(genesis)
    .update(Buffer.from(input.publicKey, "hex"))
    .update(Buffer.from(input.groupHash, "hex"));
  if (input.beaconId !== "" && input.beaconId !== "default") {
    hash.update(Buffer.from(input.beaconId, "utf8"));
  }
  return hash.digest("hex");
}

export function deriveMossPhase2BeaconV1(input: {
  chainHash: string;
  round: number;
  randomness: string;
}): string {
  assertSha256(input.chainHash, "drand chain hash");
  assertPositiveSafeInteger(input.round, "drand round");
  assertSha256(input.randomness, "drand randomness");
  const round = Buffer.alloc(8);
  round.writeBigUInt64BE(BigInt(input.round));
  return createHash("sha256")
    .update(Buffer.from(DERIVATION_DOMAIN, "utf8"))
    .update(Uint8Array.of(0))
    .update(Buffer.from(input.chainHash, "hex"))
    .update(round)
    .update(Buffer.from(input.randomness, "hex"))
    .digest("hex");
}

export function decodeBeaconHash(hex: string): Uint8Array {
  assertSha256(hex, "beacon hash");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function normalizeEndpoints(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length < MIN_ENDPOINTS || values.length > MAX_ENDPOINTS) {
    throw new Error(`configure ${MIN_ENDPOINTS}-${MAX_ENDPOINTS} drand endpoints`);
  }
  const normalized = values.map(normalizeEndpoint).sort();
  const origins = new Set<string>();
  for (const value of normalized) {
    const origin = new URL(value).origin;
    if (origins.has(origin)) {
      throw new Error("drand endpoints must use distinct HTTPS origins");
    }
    origins.add(origin);
  }
  return normalized;
}

function normalizeEndpoint(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error("drand endpoint is empty or too long");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("drand endpoint is not a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("drand endpoints must be credential-free HTTPS base URLs");
  }
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path === "" || path === "/" ? "" : path}`;
}

async function fetchBoundedJson(
  url: string,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": `moss-phase2-finalizer drand-client/${DRAND_CLIENT_VERSION}`,
      },
      redirect: "error",
      cache: "no-store",
      signal: abort.signal,
    });
    if (!response.ok) {
      throw new Error(`drand HTTP response was ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      throw new Error("drand response content type is not application/json");
    }
    const advertisedLength = response.headers.get("content-length");
    if (advertisedLength !== null) {
      const parsedLength = Number(advertisedLength);
      if (
        !Number.isSafeInteger(parsedLength) ||
        parsedLength < 1 ||
        parsedLength > MAX_RESPONSE_BYTES
      ) {
        throw new Error("drand response Content-Length is invalid");
      }
    }
    if (response.body === null) throw new Error("drand response body is empty");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("drand response exceeds the byte limit");
      }
      chunks.push(value);
    }
    if (total === 0) throw new Error("drand response body is empty");
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    } catch {
      throw new Error("drand response is not valid JSON");
    }
    return parsed;
  } catch (error) {
    if (abort.signal.aborted) {
      throw new Error("drand HTTP request timed out", { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeChainInfo(
  value: unknown,
  spec: Readonly<DrandBeaconSpec>,
): { client: ChainInfo; evidence: DrandChainInfoEvidenceV1 } {
  const record = requireRecord(value, "drand chain info");
  const publicKey = requireBoundedHex(record.public_key, "drand public key", 1, 512);
  const periodSeconds = requireUint32(record.period, "drand period");
  const genesisTime = requireNonnegativeSafeInteger(
    record.genesis_time,
    "drand genesis time",
  );
  const advertisedHash = requireSha256(record.hash, "advertised drand chain hash");
  const groupHash = requireBoundedHex(record.groupHash, "drand group hash", 1, 512);
  const schemeId = requireSupportedScheme(record.schemeID);
  const metadata = requireRecord(record.metadata, "drand chain metadata");
  const advertisedBeaconId = requireBeaconId(metadata.beaconID);
  const beaconId = advertisedBeaconId === "" ? "default" : advertisedBeaconId;
  const computedHash = computeDrandChainInfoHash({
    periodSeconds,
    genesisTime,
    publicKey,
    groupHash,
    beaconId,
  });
  if (advertisedHash !== spec.chainHash || computedHash !== spec.chainHash) {
    throw new Error("drand chain info does not match the manifest-pinned chain hash");
  }
  const roundTime = drandRoundTimeIso(genesisTime, periodSeconds, spec.round);

  return {
    client: {
      public_key: publicKey,
      period: periodSeconds,
      genesis_time: genesisTime,
      hash: computedHash,
      groupHash,
      schemeID: schemeId,
      metadata: { beaconID: beaconId },
    },
    evidence: {
      publicKey,
      periodSeconds,
      genesisTime,
      groupHash,
      schemeId,
      beaconId,
      roundTime,
    },
  };
}

function normalizeBeacon(
  value: unknown,
  schemeId: DrandChainInfoEvidenceV1["schemeId"],
  expectedRound: number,
): { client: RandomnessBeacon; evidence: DrandBeaconRecordEvidenceV1 } {
  const record = requireRecord(value, "drand beacon");
  const round = requirePositiveSafeInteger(record.round, "drand beacon round");
  if (round !== expectedRound) throw new Error("drand beacon round does not match the manifest");
  const randomness = requireSha256(record.randomness, "drand randomness");
  const signature = requireBoundedHex(record.signature, "drand signature", 1, 512);
  const isChained = schemeId === "pedersen-bls-chained";
  let previousSignature: string | undefined;
  if (isChained) {
    previousSignature = requireBoundedHex(
      record.previous_signature,
      "drand previous signature",
      1,
      512,
    );
  } else if (record.previous_signature !== undefined) {
    throw new Error("unchained drand beacon unexpectedly has a previous signature");
  }

  const evidence: DrandBeaconRecordEvidenceV1 = {
    round,
    randomness,
    signature,
    ...(previousSignature === undefined ? {} : { previousSignature }),
  };
  const client = (previousSignature === undefined
    ? { round, randomness, signature }
    : {
        round,
        randomness,
        signature,
        previous_signature: previousSignature,
      }) as RandomnessBeacon;
  return { client, evidence };
}

function assertDrandEvidence(
  evidence: DrandBeaconEvidenceV1,
  spec: Readonly<DrandBeaconSpec>,
): void {
  const root = requireRecord(evidence, "drand evidence");
  assertExactKeys(root, [
    "schemaVersion",
    "type",
    "chainHash",
    "round",
    "chainInfo",
    "beacon",
    "sources",
    "verification",
    "derivation",
  ], "drand evidence");
  if (
    evidence.schemaVersion !== 1 ||
    evidence.type !== "moss.phase2.drand-evidence.v1" ||
    evidence.chainHash !== spec.chainHash ||
    evidence.round !== spec.round
  ) {
    throw new Error("drand evidence authority fields are invalid");
  }

  const info = requireRecord(evidence.chainInfo, "drand evidence chain info");
  assertExactKeys(info, [
    "publicKey",
    "periodSeconds",
    "genesisTime",
    "groupHash",
    "schemeId",
    "beaconId",
    "roundTime",
  ], "drand evidence chain info");
  const schemeId = requireSupportedScheme(evidence.chainInfo.schemeId);
  const computedChainHash = computeDrandChainInfoHash(evidence.chainInfo);
  if (computedChainHash !== spec.chainHash) {
    throw new Error("drand evidence chain info hash is invalid");
  }
  if (
    evidence.chainInfo.roundTime !==
    drandRoundTimeIso(
      evidence.chainInfo.genesisTime,
      evidence.chainInfo.periodSeconds,
      spec.round,
    )
  ) {
    throw new Error("drand evidence round time is invalid");
  }

  const beacon = requireRecord(evidence.beacon, "drand evidence beacon");
  assertExactKeys(
    beacon,
    schemeId === "pedersen-bls-chained"
      ? ["round", "randomness", "signature", "previousSignature"]
      : ["round", "randomness", "signature"],
    "drand evidence beacon",
  );
  if (evidence.beacon.round !== spec.round) {
    throw new Error("drand evidence beacon round is invalid");
  }
  assertSha256(evidence.beacon.randomness, "drand evidence randomness");
  assertBoundedHex(evidence.beacon.signature, "drand evidence signature", 1, 512);
  if (schemeId === "pedersen-bls-chained") {
    assertBoundedHex(
      evidence.beacon.previousSignature,
      "drand evidence previous signature",
      1,
      512,
    );
  }
  if (
    sha256Bytes(Buffer.from(evidence.beacon.signature, "hex")) !==
    evidence.beacon.randomness
  ) {
    throw new Error("drand evidence randomness is not SHA-256(signature)");
  }

  if (!Array.isArray(evidence.sources)) {
    throw new Error("drand evidence sources must be an array");
  }
  const normalizedEndpoints = normalizeEndpoints(
    evidence.sources.map((source) => source.endpoint),
  );
  if (normalizedEndpoints.length !== evidence.sources.length) {
    throw new Error("drand evidence source count is invalid");
  }
  for (const [index, source] of evidence.sources.entries()) {
    const sourceRecord = requireRecord(source, `drand evidence source ${index}`);
    assertExactKeys(sourceRecord, ["endpoint", "infoUrl", "beaconUrl"], `drand evidence source ${index}`);
    if (source.endpoint !== normalizedEndpoints[index]) {
      throw new Error("drand evidence sources are not canonically ordered");
    }
    if (
      source.infoUrl !== `${source.endpoint}/${spec.chainHash}/info` ||
      source.beaconUrl !== `${source.endpoint}/${spec.chainHash}/public/${spec.round}`
    ) {
      throw new Error("drand evidence source URLs are invalid");
    }
  }

  const verification = requireRecord(evidence.verification, "drand evidence verification");
  assertExactKeys(verification, [
    "implementation",
    "implementationVersion",
    "chainInfoHashAlgorithm",
    "beaconVerification",
    "sourceAgreement",
  ], "drand evidence verification");
  if (
    evidence.verification.implementation !== "drand-client" ||
    evidence.verification.implementationVersion !== DRAND_CLIENT_VERSION ||
    evidence.verification.chainInfoHashAlgorithm !== "drand-chain-info-v1" ||
    evidence.verification.beaconVerification !==
      "bls-signature-and-sha256-randomness" ||
    evidence.verification.sourceAgreement !==
      "all-configured-distinct-origins"
  ) {
    throw new Error("drand evidence verification metadata is invalid");
  }

  const derivation = requireRecord(evidence.derivation, "drand evidence derivation");
  assertExactKeys(derivation, ["name", "encoding", "beaconHashHex"], "drand evidence derivation");
  if (
    evidence.derivation.name !== DERIVATION_DOMAIN ||
    evidence.derivation.encoding !== DERIVATION_ENCODING ||
    !SHA256.test(evidence.derivation.beaconHashHex)
  ) {
    throw new Error("drand evidence derivation metadata is invalid");
  }
}

function drandRoundTimeIso(
  genesisTime: number,
  periodSeconds: number,
  round: number,
): string {
  assertNonnegativeSafeInteger(genesisTime, "drand genesis time");
  assertUint32(periodSeconds, "drand period");
  assertPositiveSafeInteger(round, "drand round");
  const seconds =
    BigInt(genesisTime) + BigInt(round - 1) * BigInt(periodSeconds);
  const milliseconds = seconds * 1_000n;
  if (milliseconds > BigInt(8_640_000_000_000_000)) {
    throw new Error("drand round time exceeds the JavaScript date range");
  }
  return new Date(Number(milliseconds)).toISOString();
}

let drandVersionPromise: Promise<void> | undefined;

async function assertPinnedDrandClientVersion(): Promise<void> {
  drandVersionPromise ??= (async () => {
    const entry = fileURLToPath(import.meta.resolve("drand-client"));
    const packageRoot = dirname(dirname(dirname(entry)));
    const parsed = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    if (
      parsed.name !== "drand-client" ||
      parsed.version !== DRAND_CLIENT_VERSION
    ) {
      throw new Error(
        `finalizer requires exact drand-client ${DRAND_CLIENT_VERSION}; found ${String(parsed.version)}`,
      );
    }
  })().catch((error: unknown) => {
    drandVersionPromise = undefined;
    throw error;
  });
  await drandVersionPromise;
}

function assertBeaconSpecShape(spec: Readonly<BeaconSpec>): void {
  if (spec.derivation !== DERIVATION_DOMAIN) {
    throw new Error("manifest beacon source or derivation is unsupported");
  }
  if (spec.source === "ethereum-block") {
    assertPositiveSafeInteger(spec.chainId, "manifest beacon chain id");
    assertPositiveSafeInteger(spec.blockNumber, "manifest beacon block number");
    return;
  }
  if (spec.source !== "drand") {
    throw new Error("manifest beacon source or derivation is unsupported");
  }
  assertSha256(spec.chainHash, "manifest drand chain hash");
  assertPositiveSafeInteger(spec.round, "manifest drand round");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

function requireSupportedScheme(
  value: unknown,
): DrandChainInfoEvidenceV1["schemeId"] {
  if (typeof value !== "string" || !SUPPORTED_SCHEMES.has(value as DrandChainInfoEvidenceV1["schemeId"])) {
    throw new Error("drand scheme is not supported by pinned drand-client");
  }
  return value as DrandChainInfoEvidenceV1["schemeId"];
}

function requireBeaconId(value: unknown): string {
  if (typeof value !== "string") throw new Error("drand beacon ID must be a string");
  assertBeaconId(value);
  return value;
}

function assertBeaconId(value: string): void {
  if (value !== "" && !SAFE_BEACON_ID.test(value)) {
    throw new Error("drand beacon ID is malformed");
  }
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  assertSha256(value, label);
  return value;
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be lowercase SHA-256 hex`);
}

function requireBoundedHex(
  value: unknown,
  label: string,
  minBytes: number,
  maxBytes: number,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  assertBoundedHex(value, label, minBytes, maxBytes);
  return value;
}

function assertBoundedHex(
  value: unknown,
  label: string,
  minBytes: number,
  maxBytes: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !EVEN_LOWER_HEX.test(value) ||
    value.length < minBytes * 2 ||
    value.length > maxBytes * 2
  ) {
    throw new Error(`${label} must be bounded lowercase even-length hex`);
  }
}

function requireUint32(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  assertUint32(value, label);
  return value;
}

function assertUint32(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be a positive uint32`);
  }
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  assertNonnegativeSafeInteger(value, label);
  return value;
}

function assertNonnegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number`);
  assertPositiveSafeInteger(value, label);
  return value;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}
