import { Readable } from "node:stream";

import {
  VERIFICATION_REPORT_SIGNATURE_DOMAIN,
  assertBlake2b512,
  assertSha256,
  verifyEnvelope,
  type SignedEnvelope,
  type VerificationReportV1,
} from "@moss/phase2-protocol";

import type { Authenticator } from "./auth.js";
import { parseLeaseProgress } from "./lease-progress.js";
import type { InternalVerifierPrincipal } from "./auth.js";
import type { CoordinatorOperations, FastifyLike, RouteReply, RouteRequest } from "./api.js";

export function registerCoordinatorRoutes(app: FastifyLike, dependencies: {
  operations: CoordinatorOperations;
  participantAuth: Authenticator;
  authenticateInternal(request: RouteRequest): InternalVerifierPrincipal;
  verifierPublicKeys: ReadonlyMap<string, string>;
  maxArtifactByteLength: number;
}): void {
  app.addContentTypeParser?.("application/octet-stream", (_request, payload, done) => done(null, payload));
  const route = (method: string, url: string, handler: (request: RouteRequest, reply: RouteReply) => Promise<unknown>, bodyLimit?: number) => {
    app.route({ method, url, bodyLimit, handler: async (request, reply) => {
      try { return await handler(request, reply); }
      catch (error) { return reply.code(errorStatus(error)).send({ error: error instanceof Error ? error.message : "request failed" }); }
    } });
  };

  route("GET", "/v1/ceremonies/:slug/web-release-authorization", async (request, reply) => reply.send(await dependencies.operations.getWebReleaseAuthorization?.(request.params.slug) ?? null));
  route("GET", "/v1/ceremonies/:slug/operational-updates", async (request, reply) => {
    return reply.send(await dependencies.operations.getOperationalUpdates?.(request.params.slug) ?? { updates: [], appliedAt: [] });
  });
  // The root signature is the authorization: participant/verifier credentials cannot authorize changes.
  route("POST", "/v1/ceremonies/:slug/operational-updates", async (request, reply) => {
    if (!dependencies.operations.applyOperationalUpdate) return reply.code(503).send({ error: "Operational updates are not configured" });
    return reply.send(await dependencies.operations.applyOperationalUpdate(request.params.slug, request.body as import("@moss/phase2-protocol").SignedEnvelope<import("@moss/phase2-protocol").OperationalUpdate>));
  }, 65_536);
  route("GET", "/healthz", async (_request, reply) => reply.send({ ok: true }));
  route("GET", "/v1/ceremonies/:slug/manifest", async (request, reply) => reply.send(await dependencies.operations.getManifest(request.params.slug)));
  route("GET", "/v1/ceremonies/:slug/checkpoint", async (request, reply) => reply.send(await dependencies.operations.getCheckpoint(request.params.slug)));
  route("GET", "/v1/ceremonies/:slug/status", async (request, reply) => reply.send(await dependencies.operations.getStatus(request.params.slug)));
  route("GET", "/v1/ceremonies/:slug/publications", async (request, reply) => {
    const after = request.query?.after;
    if (after !== undefined && (!/^(0|[1-9][0-9]*)$/.test(after) || !Number.isSafeInteger(Number(after)))) {
      return reply.code(400).send({ error: "after must be a nonnegative safe integer" });
    }
    return reply.send({ acknowledgements: await dependencies.operations.listPublications(request.params.slug, after === undefined ? -1 : Number(after)) });
  });
  route("GET", "/v1/ceremonies/:slug/contributions", async (request, reply) => {
    const after = request.query?.after ?? "0";
    if (!/^(0|[1-9][0-9]*)$/.test(after) || !Number.isSafeInteger(Number(after))) {
      return reply.code(400).send({ error: "after must be a nonnegative safe integer" });
    }
    const limit = request.query?.limit ?? "50";
    if (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 50) {
      return reply.code(400).send({ error: "limit must be an integer from 1 to 50" });
    }
    const receipts = await dependencies.operations.listContributions(request.params.slug, Number(after), Number(limit));
    // Accepted receipts never change, so a page that holds everything it asked
    // for is final and a CDN may keep it. A short page can still grow.
    if (receipts.length === Number(limit)) {
      reply.header("cache-control", "public, max-age=31536000, immutable");
      reply.header("vary", "origin");
      reply.removeHeader("pragma");
    }
    return reply.send({ receipts });
  });
  route("GET", "/v1/ceremonies/:slug/artifacts/:sha256.zkey", async (request, reply) => {
    assertSha256(request.params.sha256);
    const range = parseRangeHeader(request.headers.range);
    const location = await dependencies.operations.getCanonicalArtifactRedirect?.(request.params.slug, request.params.sha256);
    if (location) {
      reply.header("location", location);
      reply.header("cache-control", "public, immutable, max-age=31536000");
      return reply.code(307).send();
    }
    const artifact = await dependencies.operations.openCanonicalArtifact(
      request.params.slug,
      request.params.sha256,
      range,
    );
    reply.header("content-type", "application/octet-stream");
    reply.header("content-length", String(artifact.byteLength));
    reply.header("accept-ranges", "bytes");
    reply.header("cache-control", "public, immutable, max-age=31536000");
    if (range) {
      reply.code(206);
      reply.header(
        "content-range",
        `bytes ${artifact.start}-${artifact.endInclusive}/${artifact.totalByteLength}`,
      );
    }
    return reply.send(artifact.stream);
  });

  route("POST", "/v1/ceremonies/:slug/queue", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    const key = requireIdempotencyKey(request);
    return reply.code(201).send(await dependencies.operations.joinQueue(request.params.slug, principal, key));
  });
  route("GET", "/v1/ceremonies/:slug/queue/me", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    return reply.send(await dependencies.operations.getMyQueue(request.params.slug, principal.participantId));
  });
  route("GET", "/v1/ceremonies/:slug/me/state", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    return reply.send(await dependencies.operations.getParticipantState(
      request.params.slug,
      principal.participantId,
    ));
  });
  route("DELETE", "/v1/ceremonies/:slug/queue/me", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    await dependencies.operations.cancelMyQueue(request.params.slug, principal.participantId);
    return reply.code(204).send();
  });
  route("POST", "/v1/offers/:leaseId/claim", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    return reply.send(await dependencies.operations.claimOffer(request.params.leaseId, principal.participantId));
  });
  route("GET", "/v1/leases/:leaseId", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    return reply.send(await dependencies.operations.getLease(request.params.leaseId, principal.participantId));
  });
  route("POST", "/v1/leases/:leaseId/heartbeat", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    await dependencies.operations.heartbeat(request.params.leaseId, principal.participantId, parseLeaseProgress(request.body));
    return reply.code(204).send();
  });
  route("POST", "/v1/leases/:leaseId/uploads", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    return reply.code(201).send(await dependencies.operations.createUpload(request.params.leaseId, principal.participantId));
  });
  route("GET", "/v1/uploads/:uploadId", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    return reply.send(await dependencies.operations.getUpload(
      request.params.uploadId,
      principal.participantId,
    ));
  });
  route("POST", "/v1/uploads/:uploadId/parts", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    const body = objectBody(request.body);
    const partNumbers = body.partNumbers;
    if (!Array.isArray(partNumbers) || partNumbers.some((part) => !Number.isSafeInteger(part))) throw new Error("partNumbers must be an integer array");
    return reply.send(await dependencies.operations.createUploadParts(request.params.uploadId, principal.participantId, partNumbers as number[]));
  });
  route("PUT", "/v1/uploads/:uploadId/content", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    const body = request.body instanceof Readable ? request.body : request.raw;
    if (!body) throw new Error("binary upload body is required");
    return reply.send(await dependencies.operations.ingestLocalUpload(request.params.uploadId, principal.participantId, body));
  }, dependencies.maxArtifactByteLength);
  route("POST", "/v1/uploads/:uploadId/complete", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    const body = objectBody(request.body);
    if (typeof body.sha256 !== "string") throw new Error("sha256 is required");
    assertSha256(body.sha256);
    if (!Number.isSafeInteger(body.byteLength) || Number(body.byteLength) <= 0 || Number(body.byteLength) > dependencies.maxArtifactByteLength) throw new Error("byteLength is invalid");
    // Validate rather than cast. Acceptance never trusts an ETag — the
    // provider's whole-object checksum gates it and the verifier re-hashes
    // independently — but this is still client input travelling to the storage
    // provider, and a non-array slipped through the downstream length check
    // because `undefined === 0` is false.
    const parts = parseUploadParts(body.parts);
    return reply.send(await dependencies.operations.completeUpload(request.params.uploadId, principal.participantId, {
      sha256: body.sha256, byteLength: Number(body.byteLength), ...(parts === undefined ? {} : { parts }),
    }));
  });
  route("POST", "/v1/leases/:leaseId/submit", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    const body = objectBody(request.body);
    if (typeof body.uploadId !== "string" || typeof body.predecessorSha256 !== "string"
      || typeof body.contributionHashBlake2b512 !== "string") throw new Error("submission fields are missing");
    assertSha256(body.predecessorSha256, "predecessorSha256");
    assertBlake2b512(body.contributionHashBlake2b512, "contributionHashBlake2b512");
    if (body.clientKind !== "browser" && body.clientKind !== "cli" && body.clientKind !== "other") throw new Error("clientKind is invalid");
    if (body.clientReleaseSha256 !== undefined) {
      if (typeof body.clientReleaseSha256 !== "string") throw new Error("clientReleaseSha256 is invalid");
      assertSha256(body.clientReleaseSha256, "clientReleaseSha256");
    }
    return reply.code(202).send(await dependencies.operations.submit(request.params.leaseId, principal.participantId, {
      uploadId: body.uploadId,
      predecessorSha256: body.predecessorSha256,
      contributionHashBlake2b512: body.contributionHashBlake2b512,
      clientKind: body.clientKind,
      ...(body.clientReleaseSha256 === undefined ? {} : { clientReleaseSha256: body.clientReleaseSha256 }),
    }, requireIdempotencyKey(request)));
  });
  route("GET", "/v1/submissions/:submissionId", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    return reply.send(await dependencies.operations.getSubmission(request.params.submissionId, principal.participantId));
  });
  route("GET", "/v1/receipts/:receiptId", async (request, reply) => {
    const principal = await dependencies.participantAuth.authenticate(request);
    return reply.send(await dependencies.operations.getReceipt(request.params.receiptId, principal.participantId));
  });

  route("POST", "/v1/internal/verifier/jobs/claim", async (request, reply) => {
    const principal = dependencies.authenticateInternal(request);
    const body = objectBody(request.body);
    if (body.operatorKeyId !== undefined && body.operatorKeyId !== principal.operatorKeyId) {
      throw new Error("operatorKeyId does not match internal authentication");
    }
    if (!dependencies.verifierPublicKeys.has(principal.operatorKeyId)) throw new Error("operatorKeyId is invalid");
    const job = await dependencies.operations.claimVerifierJob(principal.operatorKeyId);
    return job === null ? reply.code(204).send() : reply.send(job);
  });
  route("POST", "/v1/internal/verifier/jobs/:jobId/heartbeat", async (request, reply) => {
    const principal = dependencies.authenticateInternal(request);
    return reply.send(await dependencies.operations.heartbeatVerifierJob(
      request.params.jobId,
      principal.operatorKeyId,
    ));
  });
  route("POST", "/v1/internal/verifier/reports", async (request, reply) => {
    const principal = dependencies.authenticateInternal(request);
    const envelope = request.body as SignedEnvelope<VerificationReportV1>;
    if (!envelope || typeof envelope !== "object" || typeof envelope.keyId !== "string") throw new Error("signed verification report is required");
    const publicKey = dependencies.verifierPublicKeys.get(envelope.keyId);
    if (!publicKey) throw new Error("verification report key is not authorized");
    if (envelope.keyId !== principal.operatorKeyId) {
      throw new Error("verification report signer does not match internal authentication");
    }
    const report = verifyEnvelope(envelope as never, {
      publicKey,
      domain: VERIFICATION_REPORT_SIGNATURE_DOMAIN,
    }) as unknown as VerificationReportV1;
    if (report.operatorKeyId !== envelope.keyId) throw new Error("verification report operator does not match signing key");
    await dependencies.operations.recordVerifierReport(envelope);
    return reply.code(202).send({ accepted: true });
  });
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON object body is required");
  return body as Record<string, unknown>;
}

function requireIdempotencyKey(request: RouteRequest): string {
  const value = request.headers["idempotency-key"];
  const key = Array.isArray(value) ? value[0] : value;
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(key)) throw new Error("valid Idempotency-Key header is required");
  return key;
}

function parseRangeHeader(
  value: string | string[] | undefined,
): { start: number; endInclusive?: number } | undefined {
  if (value === undefined) return undefined;
  const header = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
  const match = header?.match(/^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)?$/u);
  if (!match) throw new Error("artifact range is not satisfiable");
  const start = Number(match[1]);
  const endInclusive = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(start) ||
      (endInclusive !== undefined && (!Number.isSafeInteger(endInclusive) || endInclusive < start))) {
    throw new Error("artifact range is not satisfiable");
  }
  return { start, ...(endInclusive === undefined ? {} : { endInclusive }) };
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  // Internal invariant failures are matched first, because their text overlaps
  // the client-fault patterns below and misclassifying them sends an operator
  // after the wrong thing mid-incident. "transcript event signature is not
  // authorized by the manifest" contains "signature" and was returning 401, as
  // though a participant had presented a bad credential; "canonical head
  // compare-and-swap failed" was returning 400, as though they had sent a bad
  // request. Neither is the caller's fault.
  //
  // Classifying by message is fragile in exactly this way. Typed errors
  // carrying their own status would remove the guesswork.
  if (
    /compare-and-swap|not authorized by the manifest|is not awaiting acceptance|invariant/u
      .test(message)
  ) {
    return 500;
  }
  if (/auth|bearer|token|signature/u.test(message)) return 401;
  if (/not found/u.test(message)) return 404;
  if (/range is not satisfiable/u.test(message)) return 416;
  if (/expired|stale|not open|unavailable|conflict|deadline/u.test(message)) return 409;
  return 400;
}

/** Multipart completion parts, as supplied by the client. */
function parseUploadParts(
  value: unknown,
): Array<{ partNumber: number; etag: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("parts must be a non-empty array");
  }
  if (value.length > 10_000) throw new Error("parts exceeds the multipart maximum");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("part is not an object");
    const { partNumber, etag } = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(partNumber) || Number(partNumber) < 1 || Number(partNumber) > 10_000) {
      throw new Error("part number is invalid");
    }
    if (typeof etag !== "string" || etag.length === 0 || etag.length > 128) {
      throw new Error("part etag is invalid");
    }
    return { partNumber: Number(partNumber), etag };
  });
}
