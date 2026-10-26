import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const DEFAULT_ROOT = join(homedir(), ".moss-phase2-ceremony", "journals");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BLAKE2B512 = /^[a-f0-9]{128}$/u;

export interface ContributionJournalEvidence {
  manifestSha256: string;
  predecessorSha256: string;
  predecessorByteLength: number;
  successorSha256: string;
  successorByteLength: number;
  contributionHashBlake2b512: string;
  contributionName: string;
  baseGeneration: number;
  participantPseudonym: string;
}

export interface ContributionJournalV1 {
  schemaVersion: 1;
  ceremonyUrl: string;
  ceremonyId: string;
  participantId: string;
  queueIdempotencyKey?: string;
  queueTicketId?: string;
  leaseId?: string;
  uploadId?: string;
  submissionId?: string;
  receiptId?: string;
  /** Workspace holding this attempt's predecessor and computed successor. */
  workspaceId?: string;
  evidence?: ContributionJournalEvidence;
  updatedAt: string;
}

export function newContributionJournal(input: {
  ceremonyUrl: string;
  ceremonyId: string;
  participantId: string;
}): ContributionJournalV1 {
  const journal: ContributionJournalV1 = {
    schemaVersion: 1,
    ...input,
    updatedAt: new Date().toISOString(),
  };
  assertJournal(journal);
  return journal;
}

export async function loadContributionJournal(
  ceremonyUrl: string,
  participantId: string,
  root = DEFAULT_ROOT,
): Promise<ContributionJournalV1 | null> {
  const path = journalPath(ceremonyUrl, participantId, root);
  try {
    await assertPrivateRegularFile(path);
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    assertJournal(parsed);
    if (
      parsed.ceremonyUrl !== ceremonyUrl ||
      parsed.participantId !== participantId
    ) {
      throw new Error("Contribution journal identity does not match its path.");
    }
    return parsed;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
}

export async function saveContributionJournal(
  journal: ContributionJournalV1,
  root = DEFAULT_ROOT,
): Promise<void> {
  const next = { ...journal, updatedAt: new Date().toISOString() };
  assertJournal(next);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const path = journalPath(next.ceremonyUrl, next.participantId, root);
  const temporary = join(root, `journal.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
  journal.updatedAt = next.updatedAt;
}

export function assertJournalEvidence(
  evidence: ContributionJournalEvidence,
): void {
  if (
    !SHA256.test(evidence.manifestSha256) ||
    !SHA256.test(evidence.predecessorSha256) ||
    !Number.isSafeInteger(evidence.predecessorByteLength) ||
    evidence.predecessorByteLength < 1 ||
    !SHA256.test(evidence.successorSha256) ||
    !Number.isSafeInteger(evidence.successorByteLength) ||
    evidence.successorByteLength < 1 ||
    !BLAKE2B512.test(evidence.contributionHashBlake2b512) ||
    !validText(evidence.contributionName, 64) ||
    !Number.isSafeInteger(evidence.baseGeneration) ||
    evidence.baseGeneration < 0 ||
    !validText(evidence.participantPseudonym, 128)
  ) {
    throw new Error("Contribution journal evidence is invalid.");
  }
}

function assertJournal(value: unknown): asserts value is ContributionJournalV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Contribution journal is invalid.");
  }
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    typeof row.ceremonyUrl !== "string" ||
    !validUrl(row.ceremonyUrl) ||
    !validText(row.ceremonyId, 128) ||
    typeof row.participantId !== "string" ||
    !UUID.test(row.participantId) ||
    !optionalText(row.queueIdempotencyKey, 256) ||
    !optionalText(row.queueTicketId, 256) ||
    !optionalText(row.leaseId, 256) ||
    !optionalText(row.uploadId, 256) ||
    !optionalText(row.submissionId, 256) ||
    !optionalText(row.receiptId, 256) ||
    (row.workspaceId !== undefined && (typeof row.workspaceId !== "string" || !UUID.test(row.workspaceId))) ||
    typeof row.updatedAt !== "string" ||
    !canonicalDate(row.updatedAt)
  ) {
    throw new Error("Contribution journal is malformed.");
  }
  if (row.evidence !== undefined) {
    assertJournalEvidence(row.evidence as ContributionJournalEvidence);
  }
}

function journalPath(
  ceremonyUrl: string,
  participantId: string,
  root: string,
): string {
  const id = createHash("sha256")
    .update(ceremonyUrl)
    .update("\0")
    .update(participantId)
    .digest("hex");
  return join(root, `${id}.json`);
}

async function assertPrivateRegularFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Contribution journal must be a regular file.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Contribution journal permissions are unsafe.");
  }
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function optionalText(value: unknown, maximum: number): boolean {
  return value === undefined || validText(value, maximum);
}

function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function canonicalDate(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}
