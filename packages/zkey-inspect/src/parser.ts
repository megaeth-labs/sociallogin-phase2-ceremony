import type { ByteSource } from "./source.js";

const BN254_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const EXPECTED_SECTION_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const FIXED_CONTRIBUTION_BYTES = 392;
const MAX_CONTRIBUTION_PARAMETER_BYTES = 1_024;

export interface ZkeySection {
  id: number;
  offset: number;
  byteLength: number;
}

export interface ContributionRecord {
  index: number;
  type: 0 | 1;
  name?: string;
  numIterationsExp?: number;
  beaconHash?: Uint8Array;
  raw: Uint8Array;
  pointBytes: {
    deltaAfter: Uint8Array;
    g1s: Uint8Array;
    g1sx: Uint8Array;
    g2spx: Uint8Array;
    transcript: Uint8Array;
  };
}

export interface ZkeyInspection {
  version: 1;
  nVars: number;
  nPublic: number;
  domainSize: number;
  csHash: Uint8Array;
  sections: ReadonlyMap<number, ZkeySection>;
  contributions: ContributionRecord[];
}

export interface InspectOptions {
  maxContributions: number;
}

export async function inspectBn254Groth16Zkey(source: ByteSource, options: InspectOptions): Promise<ZkeyInspection> {
  if (!Number.isSafeInteger(options.maxContributions) || options.maxContributions < 0) {
    throw new Error("maxContributions must be a non-negative safe integer");
  }
  const prefix = await source.read(0, 12);
  if (new TextDecoder().decode(prefix.subarray(0, 4)) !== "zkey") throw new Error("input is not a zkey file");
  const prefixView = dataView(prefix);
  const version = prefixView.getUint32(4, true);
  if (version !== 1) throw new Error("only canonical zkey version 1 is supported");
  const sectionCount = prefixView.getUint32(8, true);
  if (sectionCount !== 10) throw new Error("canonical Groth16 zkey must contain exactly ten sections");

  const sections = new Map<number, ZkeySection>();
  let cursor = 12;
  for (let index = 0; index < sectionCount; index += 1) {
    const header = await source.read(cursor, 12);
    const view = dataView(header);
    const id = view.getUint32(0, true);
    const byteLength = readU64(view, 4);
    const offset = cursor + 12;
    if (!EXPECTED_SECTION_IDS.has(id)) throw new Error(`unsupported zkey section ${id}`);
    if (sections.has(id)) throw new Error(`duplicate zkey section ${id}`);
    if (offset > source.byteLength || byteLength > source.byteLength - offset) throw new Error("zkey section exceeds file length");
    sections.set(id, { id, offset, byteLength });
    cursor = offset + byteLength;
  }
  if (cursor !== source.byteLength) throw new Error("zkey contains trailing bytes");
  for (const id of EXPECTED_SECTION_IDS) {
    if (!sections.has(id)) throw new Error(`zkey is missing section ${id}`);
  }

  const protocolSection = sections.get(1)!;
  if (protocolSection.byteLength !== 4) throw new Error("zkey protocol section length is invalid");
  if (dataView(await source.read(protocolSection.offset, 4)).getUint32(0, true) !== 1) {
    throw new Error("zkey is not Groth16");
  }

  const grothHeader = sections.get(2)!;
  if (grothHeader.byteLength < 84) throw new Error("zkey Groth16 header section is truncated");
  const minimumHeader = await source.read(grothHeader.offset, 4 + 32 + 4 + 32 + 12);
  const headerView = dataView(minimumHeader);
  const n8q = headerView.getUint32(0, true);
  if (n8q !== 32) throw new Error("zkey base-field width is not BN254");
  if (littleEndianBigInt(minimumHeader.subarray(4, 36)) !== BN254_Q) throw new Error("zkey base field is not BN254");
  const n8r = headerView.getUint32(36, true);
  if (n8r !== 32) throw new Error("zkey scalar-field width is not BN254");
  if (littleEndianBigInt(minimumHeader.subarray(40, 72)) !== BN254_R) throw new Error("zkey scalar field is not BN254");
  const nVars = headerView.getUint32(72, true);
  const nPublic = headerView.getUint32(76, true);
  const domainSize = headerView.getUint32(80, true);
  if (nVars <= nPublic + 1 || domainSize === 0 || (domainSize & (domainSize - 1)) !== 0) {
    throw new Error("zkey circuit dimensions are invalid");
  }

  const contributionSection = sections.get(10)!;
  if (contributionSection.byteLength < 68) throw new Error("zkey contribution section is truncated");
  const contributionHeader = await source.read(contributionSection.offset, 68);
  const csHash = contributionHeader.slice(0, 64);
  const count = dataView(contributionHeader).getUint32(64, true);
  if (count > options.maxContributions) throw new Error("zkey contribution count exceeds configured maximum");
  const contributionEnd = contributionSection.offset + contributionSection.byteLength;
  cursor = contributionSection.offset + 68;
  const contributions: ContributionRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + FIXED_CONTRIBUTION_BYTES > contributionEnd) throw new Error("zkey contribution record is truncated");
    const fixed = await source.read(cursor, FIXED_CONTRIBUTION_BYTES);
    const view = dataView(fixed);
    const type = view.getUint32(384, true);
    if (type !== 0 && type !== 1) throw new Error("zkey contribution type is unsupported");
    const parameterLength = view.getUint32(388, true);
    if (parameterLength > MAX_CONTRIBUTION_PARAMETER_BYTES) {
      throw new Error("zkey contribution parameters exceed the bounded metadata limit");
    }
    if (cursor + FIXED_CONTRIBUTION_BYTES + parameterLength > contributionEnd) {
      throw new Error("zkey contribution parameters exceed section length");
    }
    const parameters = await source.read(cursor + FIXED_CONTRIBUTION_BYTES, parameterLength);
    const metadata = parseParameters(parameters);
    if (type === 0 && (metadata.numIterationsExp !== undefined || metadata.beaconHash !== undefined)) {
      throw new Error("ordinary contribution contains beacon parameters");
    }
    if (type === 1) {
      if (metadata.numIterationsExp === undefined || metadata.beaconHash === undefined) {
        throw new Error("beacon contribution is missing beacon parameters");
      }
      if (metadata.numIterationsExp < 10 || metadata.numIterationsExp > 63) {
        throw new Error("beacon iteration exponent is invalid");
      }
    }
    const raw = concat(fixed, parameters);
    const pointBytes = {
      deltaAfter: fixed.slice(0, 64),
      g1s: fixed.slice(64, 128),
      g1sx: fixed.slice(128, 192),
      g2spx: fixed.slice(192, 320),
      transcript: fixed.slice(320, 384),
    };
    assertCanonicalFieldLimbs(pointBytes.deltaAfter, `contribution ${index} deltaAfter`);
    assertCanonicalFieldLimbs(pointBytes.g1s, `contribution ${index} g1s`);
    assertCanonicalFieldLimbs(pointBytes.g1sx, `contribution ${index} g1sx`);
    assertCanonicalFieldLimbs(pointBytes.g2spx, `contribution ${index} g2spx`);
    contributions.push({ index, type, ...metadata, raw, pointBytes });
    cursor += raw.byteLength;
  }
  if (cursor !== contributionEnd) throw new Error("zkey contribution section contains trailing bytes");
  return { version: 1, nVars, nPublic, domainSize, csHash, sections, contributions };
}

function parseParameters(bytes: Uint8Array): Pick<ContributionRecord, "name" | "numIterationsExp" | "beaconHash"> {
  let cursor = 0;
  let lastType = 0;
  const result: Pick<ContributionRecord, "name" | "numIterationsExp" | "beaconHash"> = {};
  while (cursor < bytes.byteLength) {
    const type = bytes[cursor++];
    if (type <= lastType) throw new Error("zkey contribution parameters are not uniquely sorted");
    lastType = type;
    if (type === 1) {
      if (cursor >= bytes.byteLength) throw new Error("zkey contribution name length is missing");
      const length = bytes[cursor++];
      if (length === 0 || cursor + length > bytes.byteLength) throw new Error("zkey contribution name is invalid");
      const encoded = bytes.slice(cursor, cursor + length);
      result.name = new TextDecoder("utf-8", { fatal: true }).decode(encoded);
      if (/[\u0000-\u001f\u007f]/u.test(result.name)) throw new Error("zkey contribution name contains control characters");
      cursor += length;
    } else if (type === 2) {
      if (cursor >= bytes.byteLength) throw new Error("zkey beacon exponent is missing");
      result.numIterationsExp = bytes[cursor++];
    } else if (type === 3) {
      if (cursor >= bytes.byteLength) throw new Error("zkey beacon hash length is missing");
      const length = bytes[cursor++];
      if (length === 0 || cursor + length > bytes.byteLength) throw new Error("zkey beacon hash is invalid");
      result.beaconHash = bytes.slice(cursor, cursor + length);
      cursor += length;
    } else {
      throw new Error("zkey contribution parameter type is unsupported");
    }
  }
  return result;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readU64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("zkey section length exceeds safe integer range");
  return Number(value);
}

function littleEndianBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index]);
  return value;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
}

export const bn254FieldConstants = { q: BN254_Q, r: BN254_R } as const;

/**
 * Curve coordinates are stored as little-endian Montgomery residues, so every
 * 32-byte limb must sit below the base field modulus.
 *
 * ffjavascript's fromRprLEM does not range check, and q is just under 2^254, so
 * for essentially any coordinate both x and x + q fit in 32 bytes and decode to
 * the same point. Any comparison made over raw point bytes is therefore
 * evadable by re-encoding a coordinate non-canonically — including the
 * duplicate-randomness check in verifyExactlyOneAppend, which a contributor
 * could otherwise slip by re-encoding g1s after contributing with a reused
 * secret. Pairing checks and the Blake2b contribution hash both round-trip
 * through the decoder, so neither notices the difference.
 *
 * Rejecting non-canonical limbs at parse time closes that for every consumer of
 * the record rather than for one call site.
 */
function assertCanonicalFieldLimbs(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength % 32 !== 0) {
    throw new Error(`zkey ${label} is not a whole number of field limbs`);
  }
  for (let offset = 0; offset < bytes.byteLength; offset += 32) {
    if (littleEndianBigInt(bytes.subarray(offset, offset + 32)) >= BN254_Q) {
      throw new Error(`zkey ${label} contains a non-canonical field element`);
    }
  }
}
