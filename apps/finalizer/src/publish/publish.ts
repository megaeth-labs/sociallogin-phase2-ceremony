import { createHash } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalize, type JsonValue } from "@moss/phase2-protocol";

import { hashRegularFile, sha256Bytes } from "../hashing.js";
import type { FinalArtifactSummaryV1 } from "../types.js";
import {
  ConditionalWriteConflict,
  PUBLICATION_INDEX_FILE,
  PUBLICATION_INDEX_TYPE,
  PUBLICATION_JOURNAL_TYPE,
  type FinalPublicationIndexV1,
  type PublicationJournalV1,
  type PublicationStore,
  type PublishDependencies,
  type PublishedArtifact,
  type PublishedRole,
  type PublishOptions,
  type PublishResult,
} from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MIB = 1024 * 1024;
const DEFAULT_SINGLE_PUT_MAX = 64 * MIB;
const DEFAULT_PART_SIZE = 64 * MIB;
const MAX_PARTS = 10_000;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const AUDIT_REPORT_FILE = "ceremony-audit.json" as const;
export const PROOF_EVIDENCE_FILE = "proof-verification-index.json" as const;

interface LocalArtifact {
  role: PublishedRole | "publicationIndex";
  fileName: string;
  contentType: string;
  sha256: string;
  byteLength: number;
  source: { path: string } | { bytes: Uint8Array };
}

/**
 * Publishes a finalizer output directory to hash-addressed, versioned object
 * keys and writes a content-addressed index over the exact versions.
 *
 * Every write is conditional on an empty key and every existing object is
 * checked against the local digest, so a rerun after a crash at any point
 * reuses what is already durable and converges on the same index bytes. The
 * journal only remembers multipart uploads to abort; the store is the truth.
 */
export async function publishFinalization(
  options: PublishOptions,
  dependencies: PublishDependencies,
): Promise<PublishResult> {
  if (!LABEL.test(options.label)) throw new Error("publication label is unsafe");
  if (options.minimumRetentionUntil !== undefined) {
    assertCanonicalDate(options.minimumRetentionUntil, "minimum retention horizon");
  }
  const singlePutMax = options.singlePutMaxBytes ?? DEFAULT_SINGLE_PUT_MAX;
  const partSize = options.partSizeBytes ?? DEFAULT_PART_SIZE;
  if (!Number.isSafeInteger(singlePutMax) || singlePutMax < 1) throw new Error("single PUT limit is invalid");
  if (!Number.isSafeInteger(partSize) || partSize < 1) throw new Error("multipart part size is invalid");
  const publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl);
  const fetchImpl = dependencies.fetch ?? fetch;

  const summaryBytes = await readFile(join(options.finalizerOutputDir, "final-artifacts.json"));
  const summary = parseSummary(summaryBytes);
  const locals = await collectLocalArtifacts(options, summary, summaryBytes);
  const prefix = `finalization/${summary.ceremonyId}/${options.label}`;

  const journal = await openJournal(options.journalPath, {
    ceremonyId: summary.ceremonyId,
    label: options.label,
    publicBaseUrl,
    finalizerSummarySha256: sha256Bytes(summaryBytes),
  });
  const save = () => writeJournal(options.journalPath, journal);
  const publisher = new Publisher(dependencies.store, journal, save, {
    singlePutMax,
    partSize,
    minimumRetentionUntil: options.minimumRetentionUntil,
  });

  // Uploads a previous run started but never confirmed hold no object; drop them.
  for (const pending of [...journal.pendingMultipart]) {
    await dependencies.store.abortMultipart(pending);
    journal.pendingMultipart = journal.pendingMultipart.filter((item) => item.uploadId !== pending.uploadId);
    await save();
  }

  const artifacts: Partial<Record<PublishedRole, PublishedArtifact>> = {};
  for (const local of locals) {
    const objectKey = `${prefix}/sha256/${local.sha256}/${local.fileName}`;
    const versionId = await publisher.ensure(objectKey, local);
    const entry = publishedEntry(publicBaseUrl, objectKey, versionId, local);
    artifacts[local.role as PublishedRole] = entry;
    journal.published[local.role] = entry;
    await save();
  }

  const index: FinalPublicationIndexV1 = {
    schemaVersion: 1,
    type: PUBLICATION_INDEX_TYPE,
    ceremonyId: summary.ceremonyId,
    label: options.label,
    publicBaseUrl,
    finalizerSummarySha256: sha256Bytes(summaryBytes),
    artifacts: artifacts as FinalPublicationIndexV1["artifacts"],
  };
  const indexBytes = Buffer.from(canonicalize(index as unknown as JsonValue), "utf8");
  const indexLocal: LocalArtifact = {
    role: "publicationIndex",
    fileName: PUBLICATION_INDEX_FILE,
    contentType: "application/json",
    sha256: sha256Bytes(indexBytes),
    byteLength: indexBytes.byteLength,
    source: { bytes: indexBytes },
  };
  const indexKey = `${prefix}/sha256/${indexLocal.sha256}/${PUBLICATION_INDEX_FILE}`;
  const indexVersion = await publisher.ensure(indexKey, indexLocal);
  const indexEntry = publishedEntry(publicBaseUrl, indexKey, indexVersion, indexLocal);
  journal.published.publicationIndex = indexEntry;
  await save();

  // Bytes are only published once a reader can fetch them back exactly.
  for (const entry of [...Object.values(artifacts), indexEntry]) {
    await verifyDownload(entry, fetchImpl);
  }
  if (options.indexOutPath) await writeOnceOrMatch(options.indexOutPath, indexBytes);
  return { index: indexEntry, artifacts: index.artifacts };
}

class Publisher {
  constructor(
    private readonly store: PublicationStore,
    private readonly journal: PublicationJournalV1,
    private readonly save: () => Promise<void>,
    private readonly limits: { singlePutMax: number; partSize: number; minimumRetentionUntil?: string },
  ) {}

  /** Returns the single version at `key` holding exactly `local`'s bytes. */
  async ensure(key: string, local: LocalArtifact): Promise<string> {
    const existing = await this.reconcile(key, local);
    if (existing) return existing;
    let written: string;
    try {
      written = local.byteLength <= this.limits.singlePutMax
        ? await this.putSingle(key, local)
        : await this.putMultipart(key, local);
    } catch (error) {
      // A conflict or an ambiguous completion may still have left exactly our
      // bytes behind. Accept them only after the same checks as any reuse.
      const recovered = await this.reconcile(key, local);
      if (recovered) {
        await this.dropPending(key);
        return recovered;
      }
      if (error instanceof ConditionalWriteConflict) {
        throw new Error(`object at ${key} appeared during upload and cannot be reconciled`);
      }
      throw error;
    }
    const confirmed = await this.reconcile(key, local);
    if (confirmed !== written) throw new Error(`object at ${key} did not retain the uploaded version`);
    return confirmed;
  }

  private async reconcile(key: string, local: LocalArtifact): Promise<string | null> {
    const versions = await this.store.listVersions(key);
    if (versions.length === 0) return null;
    if (versions.some((version) => version.deleteMarker)) {
      throw new Error(`hash-addressed key ${key} has a delete marker`);
    }
    if (versions.length !== 1) throw new Error(`hash-addressed key ${key} has ${versions.length} versions`);
    const [version] = versions;
    const head = await this.store.headVersion(key, version.versionId);
    if (!head || head.versionId !== version.versionId) {
      throw new Error(`existing object at ${key} cannot be read back`);
    }
    if (head.byteLength !== local.byteLength || head.sha256 !== local.sha256) {
      throw new Error(`existing object at ${key} differs from the local artifact`);
    }
    const minimum = this.limits.minimumRetentionUntil;
    if (minimum !== undefined) {
      if (head.objectLockMode !== "COMPLIANCE" || !head.objectLockRetainUntil) {
        throw new Error(`object at ${key} is not under COMPLIANCE Object Lock`);
      }
      if (Date.parse(head.objectLockRetainUntil) < Date.parse(minimum)) {
        throw new Error(`object at ${key} is retained for less than the required horizon`);
      }
    }
    return head.versionId;
  }

  private async putSingle(key: string, local: LocalArtifact): Promise<string> {
    const body = "bytes" in local.source
      ? local.source.bytes
      : await readExactFile(local.source.path, local.byteLength, local.sha256);
    const { versionId } = await this.store.putObject({
      key, body, sha256: local.sha256, contentType: local.contentType,
    });
    return requireVersion(versionId, key);
  }

  private async putMultipart(key: string, local: LocalArtifact): Promise<string> {
    if (!("path" in local.source)) throw new Error("multipart upload requires a file source");
    if (Math.ceil(local.byteLength / this.limits.partSize) > MAX_PARTS) {
      throw new Error("artifact needs more than 10,000 parts at this part size");
    }
    const { uploadId } = await this.store.createMultipart({
      key, sha256: local.sha256, contentType: local.contentType,
    });
    this.journal.pendingMultipart.push({ key, uploadId });
    await this.save();
    const parts: Array<{ partNumber: number; etag: string; checksumSha256?: string }> = [];
    const whole = createHash("sha256");
    const handle = await open(local.source.path, "r");
    try {
      const before = await handle.stat({ bigint: true });
      for (let offset = 0, partNumber = 1; offset < local.byteLength; partNumber += 1) {
        const size = Math.min(this.limits.partSize, local.byteLength - offset);
        const body = Buffer.alloc(size);
        let filled = 0;
        while (filled < size) {
          const { bytesRead } = await handle.read(body, filled, size - filled, offset + filled);
          if (bytesRead === 0) throw new Error("artifact shrank while it was being uploaded");
          filled += bytesRead;
        }
        whole.update(body);
        const uploaded = await this.store.uploadPart({
          key, uploadId, partNumber, body, sha256: sha256Bytes(body),
        });
        parts.push({ partNumber, etag: uploaded.etag, ...(uploaded.checksumSha256 ? { checksumSha256: uploaded.checksumSha256 } : {}) });
        offset += size;
      }
      const after = await handle.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || whole.digest("hex") !== local.sha256) {
        throw new Error("artifact changed while it was being uploaded");
      }
    } catch (error) {
      // If the abort fails too, the journal keeps the upload for the next run.
      const aborted = await this.store.abortMultipart({ key, uploadId }).then(() => true, () => false);
      if (aborted) await this.dropPending(key);
      throw error;
    } finally {
      await handle.close();
    }
    const { versionId } = await this.store.completeMultipart({ key, uploadId, parts });
    await this.dropPending(key);
    return requireVersion(versionId, key);
  }

  private async dropPending(key: string): Promise<void> {
    const before = this.journal.pendingMultipart.length;
    this.journal.pendingMultipart = this.journal.pendingMultipart.filter((item) => item.key !== key);
    if (this.journal.pendingMultipart.length !== before) await this.save();
  }
}

async function collectLocalArtifacts(
  options: PublishOptions,
  summary: FinalArtifactSummaryV1,
  summaryBytes: Uint8Array,
): Promise<LocalArtifact[]> {
  const directory = options.finalizerOutputDir;
  const bound: Array<[PublishedRole, { fileName: string; sha256: string; byteLength: number } | undefined, string]> = [
    ["finalZkey", summary.outputs.finalZkey, "application/octet-stream"],
    ["verificationKey", summary.outputs.verificationKey, "application/json"],
    ["solidityVerifier", summary.outputs.solidityVerifier, "text/plain; charset=utf-8"],
    ["beaconEvidence", summary.outputs.beaconEvidence, "application/json"],
    ["importedSealedZkey", summary.outputs.importedSealedZkey, "application/octet-stream"],
  ];
  const locals: LocalArtifact[] = [];
  for (const [role, output, contentType] of bound) {
    if (!output) continue;
    if (!FILE_NAME.test(output.fileName)) throw new Error(`${role} file name is unsafe`);
    const path = join(directory, output.fileName);
    const digests = await hashRegularFile(path);
    if (digests.sha256 !== output.sha256 || digests.byteLength !== output.byteLength) {
      throw new Error(`${output.fileName} does not match the finalizer summary`);
    }
    locals.push({ role, fileName: output.fileName, contentType, ...digests, source: { path } });
  }
  locals.push({
    role: "finalizerSummary",
    fileName: "final-artifacts.json",
    contentType: "application/json",
    sha256: sha256Bytes(summaryBytes),
    byteLength: summaryBytes.byteLength,
    source: { bytes: summaryBytes },
  });
  if (options.auditReportPath) {
    const bytes = await readFile(options.auditReportPath);
    const report = parseJsonObject(bytes, "audit report");
    if (report.type !== "moss.phase2.ceremony-audit.v1") throw new Error("audit report has the wrong type");
    if (report.ceremonyId !== undefined && report.ceremonyId !== summary.ceremonyId) {
      throw new Error("audit report belongs to a different ceremony");
    }
    locals.push(bytesArtifact("auditReport", AUDIT_REPORT_FILE, bytes));
  }
  if (options.proofEvidencePath) {
    const bytes = await readFile(options.proofEvidencePath);
    const evidence = parseJsonObject(bytes, "proof evidence");
    const finalZkey = evidence.finalZkey as { sha256?: unknown; byteLength?: unknown } | undefined;
    if (evidence.type !== "moss.phase2.proof-tests.v1") throw new Error("proof evidence has the wrong type");
    if (finalZkey?.sha256 !== summary.outputs.finalZkey.sha256 ||
        finalZkey?.byteLength !== summary.outputs.finalZkey.byteLength) {
      throw new Error("proof evidence was produced from a different final zkey");
    }
    locals.push(bytesArtifact("proofEvidence", PROOF_EVIDENCE_FILE, bytes));
  }
  return locals;
}

function bytesArtifact(role: PublishedRole, fileName: string, bytes: Uint8Array): LocalArtifact {
  return {
    role, fileName, contentType: "application/json",
    sha256: sha256Bytes(bytes), byteLength: bytes.byteLength, source: { bytes },
  };
}

function publishedEntry(
  publicBaseUrl: string,
  objectKey: string,
  versionId: string,
  local: LocalArtifact,
): PublishedArtifact {
  const url = new URL(objectKey, publicBaseUrl);
  url.searchParams.set("versionId", versionId);
  return {
    fileName: local.fileName,
    contentType: local.contentType,
    sha256: local.sha256,
    byteLength: local.byteLength,
    objectKey,
    versionId,
    url: url.href,
  };
}

export async function verifyDownload(entry: PublishedArtifact, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(entry.url, { redirect: "error" });
  if (response.status !== 200 || !response.body) {
    throw new Error(`published ${entry.fileName} returned HTTP ${response.status}`);
  }
  const hash = createHash("sha256");
  let byteLength = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > entry.byteLength) {
      await reader.cancel();
      throw new Error(`published ${entry.fileName} is longer than its index entry`);
    }
    hash.update(value);
  }
  if (byteLength !== entry.byteLength || hash.digest("hex") !== entry.sha256) {
    throw new Error(`published ${entry.fileName} does not hash to its index entry`);
  }
}

function parseSummary(bytes: Uint8Array): FinalArtifactSummaryV1 {
  const summary = parseJsonObject(bytes, "finalizer summary") as unknown as FinalArtifactSummaryV1;
  if (summary.schemaVersion !== 1 || summary.type !== "moss.phase2.final-artifacts.v1") {
    throw new Error("finalizer summary has the wrong type");
  }
  if (typeof summary.ceremonyId !== "string" || !UUID.test(summary.ceremonyId)) {
    throw new Error("finalizer summary ceremony ID is invalid");
  }
  const outputs = summary.outputs as Partial<FinalArtifactSummaryV1["outputs"]> | undefined;
  if (!outputs?.finalZkey || !outputs.verificationKey || !outputs.solidityVerifier || !outputs.beaconEvidence) {
    throw new Error("finalizer summary is missing required outputs");
  }
  return summary;
}

function parseJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("public base URL is invalid");
  }
  const loopback = url.protocol === "http:" && LOOPBACK.has(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new Error("public base URL must be a plain HTTPS origin");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.href;
}

async function openJournal(
  path: string,
  binding: Pick<PublicationJournalV1, "ceremonyId" | "label" | "publicBaseUrl" | "finalizerSummarySha256">,
): Promise<PublicationJournalV1> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const journal: PublicationJournalV1 = {
      schemaVersion: 1, type: PUBLICATION_JOURNAL_TYPE, ...binding, pendingMultipart: [], published: {},
    };
    await writeJournal(path, journal);
    return journal;
  }
  const journal = parseJsonObject(bytes, "publication journal") as unknown as PublicationJournalV1;
  if (journal.type !== PUBLICATION_JOURNAL_TYPE || journal.schemaVersion !== 1 ||
      !Array.isArray(journal.pendingMultipart) || typeof journal.published !== "object") {
    throw new Error("publication journal is malformed");
  }
  for (const field of ["ceremonyId", "label", "publicBaseUrl", "finalizerSummarySha256"] as const) {
    if (journal[field] !== binding[field]) {
      throw new Error(`publication journal belongs to a different publication (${field})`);
    }
  }
  return journal;
}

async function writeJournal(path: string, journal: PublicationJournalV1): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function writeOnceOrMatch(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o444 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!Buffer.from(await readFile(path)).equals(Buffer.from(bytes))) {
      throw new Error("local index copy already exists with different bytes");
    }
  }
}

async function readExactFile(path: string, byteLength: number, sha256: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.byteLength !== byteLength || sha256Bytes(bytes) !== sha256) {
    throw new Error("artifact changed before upload");
  }
  return bytes;
}

function requireVersion(versionId: string | undefined, key: string): string {
  if (!versionId) throw new Error(`store returned no version for ${key}; bucket versioning is required`);
  return versionId;
}

function assertCanonicalDate(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO date`);
  }
}
