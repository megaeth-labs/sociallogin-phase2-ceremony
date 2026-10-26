import { createHash } from "node:crypto";
import { buildBn128, type Bn128Curve } from "ffjavascript";

import { ByteReader } from "./byteReader.js";
import { toHex } from "./hex.js";

/**
 * Reads the MPC (multi-party computation) parameters that snarkjs stores in
 * section 10 of a Groth16 zkey, and recomputes each contribution's hash the
 * same way snarkjs does. This is the server-side ground truth the C-1
 * continuity gate needs: snarkjs cannot tell the coordinator which zkey is the
 * recorded head, so the coordinator must read the embedded contribution list
 * itself.
 *
 * Why reimplemented instead of called from snarkjs: snarkjs does not export
 * `readMPCParams` or `hashPubKey`. They live in `src/zkey_utils.js` and the
 * package "exports" map only exposes the top-level dot path, so a deep import
 * is blocked. This module reproduces just those two operations, pinned to the
 * snarkjs version this package depends on. The conformance test asserts the
 * recomputed hash equals the value `snarkjs.zKey.contribute` returns.
 *
 * Threat model: the input bytes come from an untrusted contributor and are
 * parsed before any curve or pairing check. Every read is bounds-checked
 * against the real buffer length, the contribution count is bounded before any
 * allocation, and the TLV parameter list is validated. Parsing is pairing-free
 * — only field-element conversion runs — so it is cheap to run on every
 * submission.
 */

/*
 * zkey binary layout (snarkjs, Groth16). Sizes in bytes; integers little-endian.
 *
 *   "zkey"          4      magic
 *   version         u32
 *   nSections       u32
 *   section table   repeated nSections times: type u32 | size u64 | body[size]
 *
 * Sections, by type id. This parser reads only 2 and 10; the rest are skipped
 * by jumping over their body using the size from the table.
 *
 *   1   Header         protocolId u32 (1 = groth16)
 *   2   HeaderGroth    n8q u32 | q[n8q] | n8r u32 | r[n8r] | nVars u32 |
 *                      nPublic u32 | domainSize u32 | vk points...
 *                      └─ we read only n8q (base field element length)
 *   3-9 ProvingKey     IC, coeffs, A, B1, B2, C, H points          (skipped)
 *   10  Contributions  csHash[64] | count u32 | contribution[count]
 *                      └─ the recorded head chain
 *
 * One contribution entry (point sizes derive from n8q: G1 = 2*n8q, G2 = 4*n8q):
 *
 *   deltaAfter   G1  ┐
 *   g1_s         G1  │
 *   g1_sx        G1  ├─ hashPubKey hashes these five fields (points in
 *   g2_spx       G2  │   uncompressed form) to produce the contribution hash
 *   transcript   64  ┘
 *   type         u32                 0 = contribution, 1 = beacon
 *   paramLength  u32 | params[...]    sorted TLV: name / beacon iters / beacon hash
 */

export interface ContributionDigest {
  // 0 = a normal contribution, 1 = a beacon. Matches snarkjs's `type` field.
  type: number;
  /**
   * Recompute the 0x-prefixed Blake2b-512 over this contribution's public key
   * (snarkjs `hashPubKey`). Identical to the value `contribute()` returns for
   * that step. Lazy on purpose: the continuity gate hashes only the two entries
   * it checks (the link and the new head), not the whole chain, so a long head
   * is not re-hashed under the per-circuit lock. finalize maps over all of them.
   */
  hash(): string;
}

export interface MpcParams {
  // 0x-prefixed hex of the 64-byte circuit-identity hash snarkjs writes at the
  // start of section 10. The same for every zkey in one circuit's chain.
  csHash: string;
  contributions: ContributionDigest[];
}

export interface ParseMpcParamsOptions {
  /**
   * Upper bound on the contribution count, checked before the per-contribution
   * loop allocates. The continuity gate passes `headCount + 1`: a valid next
   * submission has exactly that many contributions, and anything larger is
   * rejected without walking a forged list.
   */
  maxContributions: number;
}

/**
 * Parse a zkey's MPC parameters and recompute each contribution's hash.
 *
 * @param zkey - Raw zkey bytes from an untrusted source.
 * @param options.maxContributions - Reject any file claiming more contributions
 *   than this before allocating; the continuity gate passes `headCount + 1`.
 * @returns The circuit-identity hash and the ordered list of contribution
 *   hashes. Throws on any malformed input (it never returns a partial result).
 */
export async function parseMpcParams(
  zkey: Uint8Array,
  options: ParseMpcParamsOptions,
): Promise<MpcParams> {
  const maxContributions = options.maxContributions;
  if (!Number.isInteger(maxContributions) || maxContributions < 0) {
    throw new Error(
      "mpcParams: maxContributions must be a non-negative integer",
    );
  }

  const reader = new ByteReader(zkey);
  const { header, contributions } = readSectionTable(reader);
  const sizes = readPointSizes(reader, header);

  reader.seek(contributions.start);
  const sectionEnd = contributions.start + contributions.size;

  const csHash = reader.readBytes(CS_HASH_LEN);
  const count = reader.readU32();
  if (count > maxContributions) {
    throw new Error(
      "mpcParams: contribution count exceeds the allowed maximum",
    );
  }

  const curve = await getCurve();
  const result: ContributionDigest[] = [];
  for (let i = 0; i < count; i++) {
    const contribution = readContribution(reader, sizes, sectionEnd, curve);
    result.push(contribution);
  }

  // The section must end exactly where the declared contributions end. Trailing
  // bytes mean the count and the body disagree.
  if (reader.pos !== sectionEnd) {
    throw new Error("mpcParams: trailing bytes after the contribution list");
  }

  return { csHash: toHex(csHash), contributions: result };
}

// --- internals -------------------------------------------------------------

// snarkjs zkey magic, version, and section ids. See zkey_utils.js.
const ZKEY_MAGIC = "zkey";
const HEADER_SECTION = 2;
const CONTRIBUTIONS_SECTION = 10;

// The only sections this parser reads. Both must appear exactly once.
const UNIQUE_SECTIONS = new Set([HEADER_SECTION, CONTRIBUTIONS_SECTION]);

// Phase 2 setups here are BN254 only. n8q is the byte length of a base field
// element; the parser rejects any other curve rather than guess point sizes.
const BN254_N8Q = 32;

const CS_HASH_LEN = 64;
const TRANSCRIPT_LEN = 64;

// TLV type ids inside a contribution's parameter block. See zkey_utils.js.
const PARAM_NAME = 1; // contributor name
const PARAM_NUM_ITERATIONS_EXP = 2; // beacon iteration exponent
const PARAM_BEACON_HASH = 3; // beacon hash

// A zkey has ten sections. A header claiming far more is malformed; cap it so a
// forged section count cannot drive a large loop before any real read.
const MAX_SECTIONS = 64;

interface Section {
  start: number;
  size: number;
}

// Byte length of one G1 and one G2 point, derived from the header's n8q.
interface PointSizes {
  g1Size: number;
  g2Size: number;
}

// Walk the section table once. Returns the unique header and contributions
// sections; throws if either is missing or duplicated (snarkjs treats both as
// unique, and a duplicate is a sign of a hand-crafted file).
function readSectionTable(reader: ByteReader): {
  header: Section;
  contributions: Section;
} {
  const magic = reader.readBytes(ZKEY_MAGIC.length);
  for (let i = 0; i < ZKEY_MAGIC.length; i++) {
    if (magic[i] !== ZKEY_MAGIC.charCodeAt(i)) {
      throw new Error("mpcParams: not a zkey file");
    }
  }
  // Version. snarkjs writes 1; accept any value it could read, the section
  // walk below is what actually constrains the layout.
  reader.readU32();

  const nSections = reader.readU32();
  if (nSections > MAX_SECTIONS) {
    throw new Error("mpcParams: too many sections");
  }

  const found = new Map<number, Section>();
  for (let i = 0; i < nSections; i++) {
    const type = reader.readU32();
    const size = reader.readU64();
    const start = reader.pos;
    // Confirm the section body is inside the buffer before skipping it.
    reader.seek(start + size);
    if (found.has(type)) {
      // The sections we read must be unique; snarkjs rejects duplicates too.
      // Repeats of sections we never read (the proving key) are ignored.
      if (UNIQUE_SECTIONS.has(type)) {
        throw new Error(`mpcParams: duplicated section ${type}`);
      }
      continue;
    }
    found.set(type, { start, size });
  }

  const header = found.get(HEADER_SECTION);
  const contributions = found.get(CONTRIBUTIONS_SECTION);
  if (!header) {
    throw new Error("mpcParams: missing header section");
  }
  if (!contributions) {
    throw new Error("mpcParams: missing contributions section");
  }
  return { header, contributions };
}

// Return the point byte sizes from the header's first field, n8q (base field
// element length). G1 is two coordinates, G2 is two coordinates over the
// quadratic extension, hence four base elements.
//
// We read only n8q, not the curve modulus q that follows it. n8q is all that is
// needed to size the points. We do not confirm the file is actually BN254 here:
// a wrong curve produces contribution hashes that fail the continuity link
// check, and the pairing check in verifyChainForCircuit rejects it at finalize.
// So curve identity is enforced downstream, not at parse time.
function readPointSizes(reader: ByteReader, header: Section): PointSizes {
  reader.seek(header.start);
  const n8q = reader.readU32();
  if (n8q !== BN254_N8Q) {
    throw new Error("mpcParams: unsupported curve (expected BN254)");
  }
  return { g1Size: n8q * 2, g2Size: n8q * 4 };
}

// Read one contribution entry and return its type plus a lazy hash. Mirrors
// snarkjs readContribution: three G1 points, one G2 point, the 64-byte
// transcript, the type, then the TLV parameter block. `sectionEnd` bounds the
// variable-length parameters so a forged paramLength cannot read past section
// 10.
function readContribution(
  reader: ByteReader,
  sizes: PointSizes,
  sectionEnd: number,
  curve: Bn128Curve,
): ContributionDigest {
  const deltaAfter = reader.readBytes(sizes.g1Size);
  const g1s = reader.readBytes(sizes.g1Size);
  const g1sx = reader.readBytes(sizes.g1Size);
  const g2spx = reader.readBytes(sizes.g2Size);
  const transcript = reader.readBytes(TRANSCRIPT_LEN);
  const type = reader.readU32();
  const paramLength = reader.readU32();
  if (reader.pos + paramLength > sectionEnd) {
    throw new Error("mpcParams: contribution parameters exceed the section");
  }
  consumeParams(reader, paramLength);

  // Capture the slices now; hash only when the caller asks. The slices are
  // views into the zkey buffer, so this keeps no extra copies.
  return {
    type,
    hash: () =>
      hashContribution(curve, deltaAfter, g1s, g1sx, g2spx, transcript),
  };
}

// Validate the trailing TLV parameter block of one contribution.
//
// Main reason: strict conformance. These fields (name, beacon iters, beacon
// hash) are NOT part of hashPubKey, so they never change a contribution hash or
// the continuity decision. We walk them anyway to reject a file that is not a
// well-formed zkey, rather than silently accept garbage in a region we do not
// read. snarkjs sorts the entries by type and rejects unknown types; we mirror
// that and keep every read inside the block so a lying paramLength cannot
// escape the section.
function consumeParams(reader: ByteReader, paramLength: number): void {
  const start = reader.pos;
  let lastType = 0;
  while (reader.pos - start < paramLength) {
    const type = reader.readBytes(1)[0];
    if (type <= lastType) {
      throw new Error("mpcParams: contribution parameters not sorted");
    }
    lastType = type;
    if (type === PARAM_NAME) {
      const len = reader.readBytes(1)[0];
      reader.readBytes(len);
    } else if (type === PARAM_NUM_ITERATIONS_EXP) {
      // A single byte, no length prefix.
      reader.readBytes(1);
    } else if (type === PARAM_BEACON_HASH) {
      const len = reader.readBytes(1)[0];
      reader.readBytes(len);
    } else {
      throw new Error("mpcParams: unknown contribution parameter");
    }
  }
  if (reader.pos - start !== paramLength) {
    throw new Error("mpcParams: contribution parameters overran their length");
  }
}

// Lazily built once and reused. `buildBn128(true)` runs single-threaded, so it
// spawns no worker pool to leak across serverless invocations.
let curvePromise: Promise<Bn128Curve> | null = null;
function getCurve(): Promise<Bn128Curve> {
  if (!curvePromise) {
    // Do not cache a rejected promise: a transient init failure would otherwise
    // be handed to every later call and brick parsing for the whole process.
    // Clear the cache on failure so the next call retries.
    curvePromise = buildBn128(true).catch((err) => {
      curvePromise = null;
      throw err;
    });
  }
  return curvePromise;
}

// Recompute snarkjs `hashPubKey`: Blake2b-512 over the three G1 points, the G2
// point, and the transcript — each point in uncompressed form. On disk the
// points are little-endian Montgomery, so they are converted before hashing,
// which is why the curve is needed at all.
function hashContribution(
  curve: Bn128Curve,
  deltaAfter: Uint8Array,
  g1s: Uint8Array,
  g1sx: Uint8Array,
  g2spx: Uint8Array,
  transcript: Uint8Array,
): string {
  const hasher = createHash("blake2b512");
  const g1Uncompressed = new Uint8Array(curve.G1.F.n8 * 2);
  for (const point of [deltaAfter, g1s, g1sx]) {
    curve.G1.toRprUncompressed(
      g1Uncompressed,
      0,
      curve.G1.fromRprLEM(point, 0),
    );
    hasher.update(g1Uncompressed);
  }
  const g2Uncompressed = new Uint8Array(curve.G2.F.n8 * 2);
  curve.G2.toRprUncompressed(g2Uncompressed, 0, curve.G2.fromRprLEM(g2spx, 0));
  hasher.update(g2Uncompressed);
  hasher.update(transcript);
  return `0x${hasher.digest("hex")}`;
}
