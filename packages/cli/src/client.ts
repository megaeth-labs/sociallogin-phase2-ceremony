import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";

import type {
  CheckpointEnvelope,
  CompletedUploadResponse,
  LeaseResponse,
  ManifestEnvelope,
  OfferResponse,
  OperationalUpdateEnvelope,
  ParticipantStateResponse,
  QueueResponse,
  ReceiptEnvelope,
  StatusResponse,
  SubmissionResponse,
  UploadGrant,
  UploadedArtifactResponse,
  UploadPartGrant,
  UploadStateResponse,
} from "./types.js";

const JSON_LIMIT_BYTES = 1_048_576;
// At most 256 updates of at most 8 KiB each, plus archive metadata.
const OPERATIONAL_UPDATES_LIMIT_BYTES = 2_200_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MULTIPART_SIZE_BYTES = 64 * 1024 * 1024;
const SAFE_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BLAKE2B512 = /^[a-f0-9]{128}$/u;

export interface CoordinatorTarget {
  baseUrl: string;
  slug: string;
  ceremonyUrl: string;
  production: boolean;
}

export class CeremonyClient {
  constructor(
    readonly target: CoordinatorTarget,
    private readonly token: string | null = null,
  ) {}

  async getManifest(): Promise<ManifestEnvelope> {
    return this.request(
      `/v1/ceremonies/${encodeURIComponent(this.target.slug)}/manifest`,
      parseSignedEnvelope,
    ) as Promise<ManifestEnvelope>;
  }

  /** The root-signed update history; the caller verifies it against the manifest. */
  async getOperationalUpdates(): Promise<OperationalUpdateEnvelope[]> {
    return this.request(
      `/v1/ceremonies/${encodeURIComponent(this.target.slug)}/operational-updates`,
      parseOperationalUpdates,
      {},
      OPERATIONAL_UPDATES_LIMIT_BYTES,
    );
  }

  async getCheckpoint(): Promise<CheckpointEnvelope> {
    return this.request(
      `/v1/ceremonies/${encodeURIComponent(this.target.slug)}/checkpoint`,
      parseSignedEnvelope,
    ) as Promise<CheckpointEnvelope>;
  }

  async getStatus(): Promise<StatusResponse> {
    return this.request(
      `/v1/ceremonies/${encodeURIComponent(this.target.slug)}/status`,
      parseStatus,
    );
  }

  async getMyState(): Promise<ParticipantStateResponse> {
    return this.request(
      `/v1/ceremonies/${encodeURIComponent(this.target.slug)}/me/state`,
      parseParticipantState,
    );
  }

  async joinQueue(idempotencyKey: string): Promise<QueueResponse> {
    return this.request(
      `/v1/ceremonies/${encodeURIComponent(this.target.slug)}/queue`,
      parseQueue,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
      },
    );
  }

  async getMyQueue(): Promise<QueueResponse> {
    return this.request(
      `/v1/ceremonies/${encodeURIComponent(this.target.slug)}/queue/me`,
      parseQueue,
    );
  }

  async cancelMyQueue(): Promise<void> {
    await this.requestNoContent(
      `/v1/ceremonies/${encodeURIComponent(this.target.slug)}/queue/me`,
      { method: "DELETE" },
    );
  }

  async claimOffer(leaseId: string): Promise<LeaseResponse> {
    return this.request(
      `/v1/offers/${encodeURIComponent(leaseId)}/claim`,
      parseLease,
      { method: "POST" },
    );
  }

  async getLease(leaseId: string): Promise<LeaseResponse> {
    return this.request(
      `/v1/leases/${encodeURIComponent(leaseId)}`,
      parseLease,
    );
  }

  async heartbeat(leaseId: string, progress: unknown): Promise<void> {
    await this.requestNoContent(
      `/v1/leases/${encodeURIComponent(leaseId)}/heartbeat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(progress),
      },
    );
  }

  async createUpload(leaseId: string): Promise<UploadGrant> {
    return this.request(
      `/v1/leases/${encodeURIComponent(leaseId)}/uploads`,
      parseUploadGrant,
      { method: "POST" },
    );
  }

  async getUpload(uploadId: string): Promise<UploadStateResponse> {
    return this.request(
      `/v1/uploads/${encodeURIComponent(uploadId)}`,
      parseUploadState,
    );
  }

  async uploadCandidate(input: {
    grant: UploadGrant;
    path: string;
    sha256: string;
    byteLength: number;
    onProgress?: (uploaded: number, total: number) => void;
  }): Promise<{ parts?: Array<{ partNumber: number; etag: string }> }> {
    assertSha256(input.sha256, "candidate SHA-256");
    const metadata = await stat(input.path);
    if (!metadata.isFile() || metadata.size !== input.byteLength || input.byteLength <= 0) {
      throw new Error("Candidate upload file does not match its declared byte length.");
    }
    if (Date.parse(input.grant.expiresAt) <= Date.now()) {
      throw new Error("Candidate upload grant is expired.");
    }

    const durable = await this.getUpload(input.grant.uploadId);
    if (durable.uploadId !== input.grant.uploadId) {
      throw new Error("Coordinator returned a different durable upload.");
    }
    if (durable.artifact) {
      if (
        durable.artifact.sha256 !== input.sha256 ||
        durable.artifact.byteLength !== input.byteLength
      ) {
        throw new Error("Durable upload state differs from the local candidate.");
      }
      if (durable.state === "UPLOADING" || durable.state === "COMPLETED") {
        input.onProgress?.(input.byteLength, input.byteLength);
        return {};
      }
    }
    if (durable.state !== "INITIATED") {
      throw new Error(`Candidate upload is in unsupported state ${durable.state}.`);
    }

    if (input.grant.method === "local-proxy") {
      const uploaded = await this.uploadLocal(input);
      if (uploaded.sha256 !== input.sha256 || uploaded.byteLength !== input.byteLength) {
        throw new Error("Coordinator upload result does not match the local candidate.");
      }
      return {};
    }
    if (input.grant.method === "s3-multipart") {
      return { parts: await this.uploadMultipart(input) };
    }
    throw new Error("Coordinator advertised an unsupported upload method.");
  }

  async completeUpload(
    uploadId: string,
    input: {
      sha256: string;
      byteLength: number;
      parts?: Array<{ partNumber: number; etag: string }>;
    },
  ): Promise<CompletedUploadResponse> {
    const completed = await this.request(
      `/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
      parseCompletedUpload,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (
      completed.uploadId !== uploadId ||
      completed.artifact.sha256 !== input.sha256 ||
      completed.artifact.byteLength !== input.byteLength
    ) {
      throw new Error("Completed upload does not match the local candidate.");
    }
    return completed;
  }

  async submit(
    leaseId: string,
    input: {
      uploadId: string;
      predecessorSha256: string;
      contributionHashBlake2b512: string;
      clientReleaseSha256?: string;
    },
    idempotencyKey: string,
  ): Promise<SubmissionResponse> {
    assertSha256(input.predecessorSha256, "predecessor SHA-256");
    if (!BLAKE2B512.test(input.contributionHashBlake2b512)) {
      throw new Error("Contribution hash must be 64-byte lowercase hex without 0x.");
    }
    if (input.clientReleaseSha256 !== undefined) {
      assertSha256(input.clientReleaseSha256, "CLI release SHA-256");
    }
    return this.request(
      `/v1/leases/${encodeURIComponent(leaseId)}/submit`,
      parseSubmission,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ ...input, clientKind: "cli" }),
      },
    );
  }

  async getSubmission(submissionId: string): Promise<SubmissionResponse> {
    return this.request(
      `/v1/submissions/${encodeURIComponent(submissionId)}`,
      parseSubmission,
    );
  }

  async getReceipt(receiptId: string): Promise<ReceiptEnvelope> {
    return this.request(
      `/v1/receipts/${encodeURIComponent(receiptId)}`,
      parseSignedEnvelope,
    ) as Promise<ReceiptEnvelope>;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Cache-Control": "no-store",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async request<T>(
    path: string,
    parse: (value: unknown) => T,
    init: RequestInit = {},
    limitBytes = JSON_LIMIT_BYTES,
  ): Promise<T> {
    const response = await fetch(new URL(path, this.target.baseUrl), {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...this.headers(), ...init.headers },
    });
    const body = await readLimitedJson(response, limitBytes);
    if (!response.ok) throw responseError(response, body);
    return parse(body);
  }

  private async requestNoContent(path: string, init: RequestInit): Promise<void> {
    const response = await fetch(new URL(path, this.target.baseUrl), {
      ...init,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...this.headers(), ...init.headers },
    });
    if (!response.ok) {
      const body = await readLimitedJson(response);
      throw responseError(response, body);
    }
    if (response.status !== 204) {
      throw new Error(`Coordinator returned unexpected ${response.status} for an empty response.`);
    }
  }

  private async uploadLocal(input: {
    grant: UploadGrant;
    path: string;
    sha256: string;
    byteLength: number;
    onProgress?: (uploaded: number, total: number) => void;
  }): Promise<UploadedArtifactResponse> {
    let uploaded = 0;
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        uploaded += chunk.byteLength;
        input.onProgress?.(uploaded, input.byteLength);
        callback(null, chunk);
      },
    });
    const body = createReadStream(input.path).pipe(progress);
    const init: RequestInit & { duplex: "half" } = {
      method: "PUT",
      duplex: "half",
      body: Readable.toWeb(body) as never,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(remainingGrantMs(input.grant.expiresAt)),
      headers: {
        ...this.headers(),
        Accept: "application/json",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(input.byteLength),
      },
    };
    const response = await fetch(
      new URL(`/v1/uploads/${encodeURIComponent(input.grant.uploadId)}/content`, this.target.baseUrl),
      init,
    );
    const value = await readLimitedJson(response);
    if (!response.ok) throw responseError(response, value);
    const result = parseUploadedArtifact(value);
    if (result.uploadId !== input.grant.uploadId) {
      throw new Error("Coordinator upload result uses a different upload id.");
    }
    return result;
  }

  private async uploadMultipart(input: {
    grant: UploadGrant;
    path: string;
    byteLength: number;
    onProgress?: (uploaded: number, total: number) => void;
  }): Promise<Array<{ partNumber: number; etag: string }>> {
    const partCount = Math.ceil(input.byteLength / MULTIPART_SIZE_BYTES);
    if (partCount < 1 || partCount > 10_000) {
      throw new Error("Candidate cannot be represented as a valid multipart upload.");
    }
    const partNumbers = Array.from({ length: partCount }, (_value, index) => index + 1);
    const grants = await this.request(
      `/v1/uploads/${encodeURIComponent(input.grant.uploadId)}/parts`,
      parseUploadParts,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partNumbers }),
      },
    );
    assertExactPartGrants(grants, partNumbers);

    let uploaded = 0;
    const completed: Array<{ partNumber: number; etag: string }> = [];
    for (const grant of grants) {
      const start = (grant.partNumber - 1) * MULTIPART_SIZE_BYTES;
      const length = Math.min(MULTIPART_SIZE_BYTES, input.byteLength - start);
      const stream = createReadStream(input.path, { start, end: start + length - 1 });
      const progress = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          uploaded += chunk.byteLength;
          input.onProgress?.(uploaded, input.byteLength);
          callback(null, chunk);
        },
      });
      const url = validateExternalUrl(grant.url, "multipart upload URL");
      const headers = safeSignedHeaders(grant.headers);
      headers["Content-Length"] = String(length);
      const response = await fetch(url, {
        method: "PUT",
        body: Readable.toWeb(stream.pipe(progress)) as never,
        duplex: "half",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(remainingGrantMs(input.grant.expiresAt)),
        headers,
      } as RequestInit & { duplex: "half" });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Multipart part ${grant.partNumber} failed (${response.status}).`);
      }
      const etag = response.headers.get("etag");
      await response.body?.cancel().catch(() => undefined);
      if (!etag || /[\r\n]/u.test(etag)) {
        throw new Error(`Multipart part ${grant.partNumber} returned no valid ETag.`);
      }
      completed.push({ partNumber: grant.partNumber, etag });
    }
    return completed;
  }
}

export function parseCoordinatorTarget(raw: string, explicitSlug?: string): CoordinatorTarget {
  let input = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(input)) input = `https://${input}`;
  const url = validateExternalUrl(input, "coordinator URL");
  if (url.search || url.hash) throw new Error("Coordinator URL must not contain a query or fragment.");

  const match = /^\/v1\/ceremonies\/([^/]+)\/?$/u.exec(url.pathname);
  let slug = explicitSlug;
  if (match) {
    const pathSlug = decodeURIComponent(match[1]);
    if (slug && slug !== pathSlug) throw new Error("Ceremony slug conflicts with the ceremony URL.");
    slug = pathSlug;
  } else if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Use a coordinator origin or a full /v1/ceremonies/<slug> URL.");
  }
  if (!slug || !SAFE_SLUG.test(slug)) {
    throw new Error("A valid ceremony slug is required (use --slug or a full ceremony URL).");
  }

  const baseUrl = url.origin;
  return {
    baseUrl,
    slug,
    ceremonyUrl: new URL(`/v1/ceremonies/${encodeURIComponent(slug)}`, baseUrl).toString(),
    production: !isLocalHost(url.hostname),
  };
}

function parseStatus(value: unknown): StatusResponse {
  const row = object(value, "status");
  const head = object(row.head, "status.head");
  const result: StatusResponse = {
    ceremonyId: text(row.ceremonyId, "status.ceremonyId"),
    state: state(row.state, "status.state"),
    generation: integer(row.generation, "status.generation"),
    head: {
      sha256: hash(rowValue(head, "sha256"), SHA256, "status.head.sha256"),
      byteLength: positiveInteger(rowValue(head, "byteLength"), "status.head.byteLength"),
      downloadUrl: externalUrl(rowValue(head, "downloadUrl"), "status.head.downloadUrl"),
    },
    queueDepth: integer(row.queueDepth, "status.queueDepth"),
    manifestSha256: hash(row.manifestSha256, SHA256, "status.manifestSha256"),
  };
  return result;
}

function parseQueue(value: unknown): QueueResponse {
  const row = object(value, "queue");
  return {
    ticketId: text(row.ticketId, "queue.ticketId"),
    status: state(row.status, "queue.status"),
    position: integer(row.position, "queue.position"),
    offer: row.offer === null ? null : parseOffer(row.offer),
  };
}

function parseOffer(value: unknown): OfferResponse {
  const row = object(value, "offer");
  const predecessor = object(row.predecessor, "offer.predecessor");
  const expiresAt = isoDate(row.expiresAt, "offer.expiresAt");
  return {
    leaseId: text(row.leaseId, "offer.leaseId"),
    expiresAt,
    baseGeneration: integer(row.baseGeneration, "offer.baseGeneration"),
    expectedContributionName: contributionName(row.expectedContributionName),
    predecessor: {
      sha256: hash(predecessor.sha256, SHA256, "offer.predecessor.sha256"),
      byteLength: positiveInteger(predecessor.byteLength, "offer.predecessor.byteLength"),
      downloadUrl: externalUrl(predecessor.downloadUrl, "offer.predecessor.downloadUrl"),
    },
  };
}

function parseLease(value: unknown): LeaseResponse {
  const row = object(value, "lease");
  return {
    ...parseOffer(row),
    state: state(row.state, "lease.state"),
    ...(row.submissionId === undefined
      ? {}
      : { submissionId: text(row.submissionId, "lease submission id") }),
  };
}

function parseUploadGrant(value: unknown): UploadGrant {
  const row = object(value, "upload grant");
  const method = row.method;
  if (method !== "local-proxy" && method !== "s3-multipart") {
    throw new Error("upload grant method is invalid");
  }
  const headers = row.headers === undefined ? undefined : stringRecord(row.headers, "upload grant headers");
  const uploadUrl = row.uploadUrl === undefined ? undefined : externalUrl(row.uploadUrl, "upload grant URL");
  return {
    uploadId: text(row.uploadId, "upload grant id"),
    objectKey: text(row.objectKey, "upload grant object key"),
    expiresAt: isoDate(row.expiresAt, "upload grant expiry"),
    method,
    ...(headers ? { headers } : {}),
    ...(uploadUrl ? { uploadUrl } : {}),
  };
}

function parseUploadParts(value: unknown): UploadPartGrant[] {
  const row = object(value, "upload parts");
  if (!Array.isArray(row.parts)) throw new Error("upload parts response is invalid");
  return row.parts.map((value, index) => {
    const part = object(value, `upload part ${index + 1}`);
    const headers = part.headers === undefined ? undefined : stringRecord(part.headers, "upload part headers");
    return {
      partNumber: positiveInteger(part.partNumber, "upload part number"),
      url: externalUrl(part.url, "upload part URL"),
      ...(headers ? { headers } : {}),
    };
  });
}

function parseUploadedArtifact(value: unknown): UploadedArtifactResponse {
  const row = object(value, "uploaded artifact");
  if (row.state !== "UPLOADING") throw new Error("uploaded artifact state is invalid");
  return {
    uploadId: text(row.uploadId, "uploaded artifact id"),
    state: "UPLOADING",
    byteLength: positiveInteger(row.byteLength, "uploaded artifact byte length"),
    sha256: hash(row.sha256, SHA256, "uploaded artifact SHA-256"),
  };
}

function parseCompletedUpload(value: unknown): CompletedUploadResponse {
  const row = object(value, "completed upload");
  const artifact = object(row.artifact, "completed upload artifact");
  if (row.state !== "COMPLETED") throw new Error("completed upload state is invalid");
  return {
    uploadId: text(row.uploadId, "completed upload id"),
    state: "COMPLETED",
    artifact: {
      sha256: hash(artifact.sha256, SHA256, "completed upload SHA-256"),
      byteLength: positiveInteger(artifact.byteLength, "completed upload byte length"),
    },
  };
}

function parseUploadState(value: unknown): UploadStateResponse {
  const row = object(value, "upload state");
  const parsedState = state(row.state, "upload state.state");
  const artifact = row.artifact === undefined
    ? undefined
    : object(row.artifact, "upload state.artifact");
  if (
    (parsedState === "UPLOADING" || parsedState === "COMPLETED") &&
    artifact === undefined
  ) {
    throw new Error("durable upload state is missing its artifact binding");
  }
  return {
    uploadId: text(row.uploadId, "upload state.id"),
    state: parsedState,
    expiresAt: isoDate(row.expiresAt, "upload state.expiresAt"),
    ...(artifact === undefined ? {} : {
      artifact: {
        sha256: hash(artifact.sha256, SHA256, "upload state.artifact.sha256"),
        byteLength: positiveInteger(
          artifact.byteLength,
          "upload state.artifact.byteLength",
        ),
      },
    }),
  };
}

function parseSubmission(value: unknown): SubmissionResponse {
  const row = object(value, "submission");
  return {
    submissionId: text(row.submissionId, "submission id"),
    state: state(row.state, "submission state"),
    ...(row.receiptId === undefined ? {} : { receiptId: text(row.receiptId, "receipt id") }),
  };
}

export function parseParticipantState(value: unknown): ParticipantStateResponse {
  const row = object(value, "participant state");
  const participantId = text(row.participantId, "participant state participant id");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(participantId)) {
    throw new Error("participant state participant id is invalid");
  }
  const queue = row.queue === null ? null : parseQueue(row.queue);
  const lease = row.lease === null ? null : parseLease(row.lease);
  const submission = row.submission === null
    ? null
    : parseSubmission(row.submission);
  if (
    queue?.offer &&
    lease &&
    queue.offer.leaseId !== lease.leaseId
  ) {
    throw new Error("participant state queue and lease disagree");
  }
  if (
    lease?.submissionId &&
    submission &&
    lease.submissionId !== submission.submissionId
  ) {
    throw new Error("participant state lease and submission disagree");
  }
  return {
    ceremonyId: text(row.ceremonyId, "participant state ceremony id"),
    participantId,
    queue,
    lease,
    submission,
  };
}

function parseOperationalUpdates(value: unknown): OperationalUpdateEnvelope[] {
  const updates = object(value, "operational update history").updates;
  if (!Array.isArray(updates)) throw new Error("operational update history is invalid");
  return updates as OperationalUpdateEnvelope[];
}

function parseSignedEnvelope(value: unknown): ManifestEnvelope | CheckpointEnvelope | ReceiptEnvelope {
  const row = object(value, "signed envelope");
  if (row.schemaVersion !== 1) throw new Error("signed envelope schema version is invalid");
  if (row.payload === null || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw new Error("signed envelope payload is invalid");
  }
  return {
    schemaVersion: 1,
    keyId: text(row.keyId, "signed envelope key id"),
    payload: row.payload,
    signature: text(row.signature, "signed envelope signature"),
  } as ManifestEnvelope | CheckpointEnvelope | ReceiptEnvelope;
}

async function readLimitedJson(response: Response, limitBytes = JSON_LIMIT_BYTES): Promise<unknown> {
  if (!response.body) return null;
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const value of Readable.fromWeb(response.body as never)) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    byteLength += chunk.byteLength;
    if (byteLength > limitBytes) {
      throw new Error("Coordinator JSON response exceeds the maximum size.");
    }
    chunks.push(chunk);
  }
  if (byteLength === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error(`Coordinator returned invalid JSON (${response.status}).`);
  }
}

function responseError(response: Response, body: unknown): Error {
  const row = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const detail = typeof row?.error === "string" && row.error.length <= 512
    ? `: ${row.error}`
    : "";
  return new Error(`Coordinator request failed (${response.status} ${response.statusText})${detail}`);
}

function validateExternalUrl(value: string, label: string): URL {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && isLocalHost(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !localHttp)) {
    throw new Error(`${label} must use HTTPS without embedded credentials.`);
  }
  return url;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function safeSignedHeaders(value: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value ?? {})) {
    const lower = name.toLowerCase();
    if (["authorization", "cookie", "proxy-authorization", "host", "content-length"].includes(lower)) {
      throw new Error(`Multipart upload grant contains forbidden header ${name}.`);
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || /[\r\n]/u.test(headerValue)) {
      throw new Error("Multipart upload grant contains an invalid header.");
    }
    result[name] = headerValue;
  }
  return result;
}

function assertExactPartGrants(grants: UploadPartGrant[], requested: number[]): void {
  if (grants.length !== requested.length) throw new Error("Coordinator returned an incomplete multipart grant set.");
  const actual = grants.map((grant) => grant.partNumber).sort((a, b) => a - b);
  if (actual.some((part, index) => part !== requested[index])) {
    throw new Error("Coordinator returned unexpected or duplicate multipart part grants.");
  }
  grants.sort((a, b) => a.partNumber - b.partNumber);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function rowValue(row: Record<string, unknown>, key: string): unknown {
  return row[key];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function state(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result < 1) throw new Error(`${label} is invalid`);
  return result;
}

function hash(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function isoDate(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(`${label} is invalid`);
  return value;
}

function externalUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return validateExternalUrl(value, label).toString();
}

function contributionName(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64 || /[^\x20-\x7e]/u.test(value)) {
    throw new Error("Expected contribution name is invalid.");
  }
  return value;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const row = object(value, label);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(row)) {
    if (typeof item !== "string") throw new Error(`${label} is invalid`);
    result[key] = item;
  }
  return result;
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be lowercase hex without 0x.`);
}

function remainingGrantMs(expiresAt: string): number {
  const remaining = Date.parse(expiresAt) - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error("Candidate upload grant is expired.");
  return remaining;
}
