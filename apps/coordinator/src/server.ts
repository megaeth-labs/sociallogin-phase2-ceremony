import { createAwsArtifactClient, S3ArtifactStore } from "@moss/phase2-storage";
import { ceremonyValidationOptions } from "@moss/phase2-protocol";
import Fastify, { LogController } from "fastify";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  EdDsaJwtAuthenticator,
  verifierBearerAuthenticator,
  type Authenticator,
  type InternalVerifierPrincipal,
} from "./auth.js";
import type { CoordinatorOperations } from "./api.js";
import { loadSignedManifest } from "./manifest.js";
import { registerCoordinatorRoutes } from "./routes.js";
import { createLocalRuntime, createRuntime } from "./runtime.js";

export function buildCoordinatorServer(input: {
  operations: CoordinatorOperations;
  participantAuth: Authenticator;
  authenticateInternal(request: import("./api.js").RouteRequest): InternalVerifierPrincipal;
  verifierPublicKeys: ReadonlyMap<string, string>;
  maxArtifactByteLength: number;
  corsAllowedOrigins: ReadonlySet<string>;
}) {
  const app = Fastify({ logger: true, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 1_048_576 });
  // Proxies can add framing or a default media type to bodyless control
  // requests. Only these routes accept an empty unsupported body format;
  // routes carrying protocol payloads retain strict content-type validation.
  const bodylessControlRoutes = new Set([
    "POST /v1/ceremonies/:slug/queue",
    "DELETE /v1/ceremonies/:slug/queue/me",
    "POST /v1/offers/:leaseId/claim",
    "POST /v1/leases/:leaseId/heartbeat",
    "POST /v1/leases/:leaseId/uploads",
    "POST /v1/internal/verifier/jobs/:jobId/heartbeat",
  ]);
  app.addContentTypeParser("*", { parseAs: "buffer" }, (request, body, done) => {
    if (body.length === 0 && bodylessControlRoutes.has(`${request.method} ${request.routeOptions.url}`)) {
      done(null, undefined);
      return;
    }
    done(Object.assign(new Error("Unsupported Media Type"), { statusCode: 415 }));
  });
  app.addHook("onRequest", async (request, reply) => {
    // Authenticated participant and verifier state must not be retained by an
    // intermediary. The immutable artifact route explicitly overrides this.
    reply.header("cache-control", "no-store, max-age=0");
    reply.header("pragma", "no-cache");
    const origin = request.headers.origin;
    if (!origin) return;
    if (!input.corsAllowedOrigins.has(origin)) {
      return reply.code(403).send({ error: "request origin is not allowed" });
    }
    reply.header("access-control-allow-origin", origin);
    reply.header("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    reply.header(
      "access-control-allow-headers",
      "authorization,content-type,idempotency-key,range",
    );
    reply.header("access-control-expose-headers", "content-length,content-range,etag");
    reply.header("access-control-max-age", "600");
    reply.header("vary", "origin");
    if (request.method === "OPTIONS") return reply.code(204).send();
  });
  app.options("/*", async (_request, reply) => reply.code(204).send());
  registerCoordinatorRoutes(app as unknown as import("./api.js").FastifyLike, input);
  return app;
}

export async function startCoordinatorFromEnvironment(): Promise<void> {
  const nodeEnvironment = process.env.NODE_ENV ?? "production";
  if (nodeEnvironment !== "production" && nodeEnvironment !== "development" && nodeEnvironment !== "test") {
    throw new Error("NODE_ENV must be production, development, or test");
  }
  const production = nodeEnvironment === "production";
  const manifestEnvelope = await loadSignedManifest({
    envelopePath: requiredEnv("CEREMONY_MANIFEST_ENVELOPE_PATH"),
    rootPublicKeyPath: requiredEnv("MANIFEST_ROOT_PUBLIC_KEY_FILE"),
    ...ceremonyValidationOptions(nodeEnvironment, process.env.CEREMONY_MODE),
  });
  const authorizationPath = process.env.REHEARSAL_WEB_RELEASE_AUTHORIZATION_FILE;
  const webReleaseAuthorization = authorizationPath ? {
    envelope: JSON.parse(await readFile(authorizationPath, "utf8")),
    rootPublicKey: await readFile(requiredEnv("MANIFEST_ROOT_PUBLIC_KEY_FILE"), "utf8"),
  } : undefined;
  const artifactBackend = requiredEnv("ARTIFACT_BACKEND");
  if (artifactBackend !== "local" && artifactBackend !== "s3") throw new Error("ARTIFACT_BACKEND must be local or s3");
  const common = {
    databaseUrl: requiredEnv("DATABASE_URL"),
    manifestRootPublicKey: await readFile(requiredEnv("MANIFEST_ROOT_PUBLIC_KEY_FILE"), "utf8"),
    webReleaseAuthorization,
    manifestEnvelope,
    coordinatorKeyId: requiredEnv("COORDINATOR_KEY_ID"),
    coordinatorPrivateKeyFile: requiredEnv("COORDINATOR_PRIVATE_KEY_FILE"),
    publicBaseUrl: requiredEnv("PUBLIC_BASE_URL"),
    production,
    allowRehearsal: process.env.CEREMONY_MODE === "rehearsal",
    allowCeremonyInitialization: process.env.ALLOW_CEREMONY_INITIALIZATION === "true",
  };
  if (production && new URL(common.publicBaseUrl).protocol !== "https:") throw new Error("hosted coordinator URL must use HTTPS");
  let runtime;
  if (artifactBackend === "local") {
    runtime = await createLocalRuntime({ ...common, artifactRoot: requiredEnv("ARTIFACT_LOCAL_ROOT"),
      genesisZkeyPath: requiredEnv("GENESIS_ZKEY_PATH") });
  } else {
    const quarantineBucket = requiredEnv("S3_QUARANTINE_BUCKET");
    const archiveBucket = requiredEnv("S3_ARCHIVE_BUCKET");
    const retentionUntil = requiredEnv("S3_RETENTION_UNTIL");
    if (retentionUntil <= manifestEnvelope.payload.beacon.expectedAt) throw new Error("archive retention must extend beyond the beacon and review window");
    const client = createAwsArtifactClient({ region: requiredEnv("AWS_REGION"), quarantineBucket, archiveBucket,
      retentionUntil, maxArtifactByteLength: manifestEnvelope.payload.contributionPolicy.maxArtifactByteLength });
    await client.assertConfiguration();
    runtime = await createRuntime({ ...common, databaseCaFile: requiredEnv("DATABASE_CA_FILE"),
      genesisZkeyPath: process.env.GENESIS_ZKEY_PATH ?? "",
      store: new S3ArtifactStore(client, quarantineBucket, archiveBucket, { production: true, minimumRetentionUntil: retentionUntil }),
      publicationArchive: client });
  }
  const participantPublicKey = await readFile(requiredEnv("PARTICIPANT_JWT_PUBLIC_KEY_FILE"), "utf8");
  const verifierPublicKeys = new Map(manifestEnvelope.payload.verifierKeys.map((key) => [key.keyId, key.publicKeyPem]));
  const verifierTokens = await readVerifierTokenMap(
    requiredEnv("INTERNAL_VERIFIER_BEARER_TOKENS_FILE"),
    new Set(manifestEnvelope.payload.verifierPolicy.operatorKeyIds),
  );
  const app = buildCoordinatorServer({
    operations: runtime.operations,
    participantAuth: new EdDsaJwtAuthenticator({ publicKey: participantPublicKey,
      issuer: requiredEnv("PARTICIPANT_JWT_ISSUER"), audience: requiredEnv("PARTICIPANT_JWT_AUDIENCE") }),
    authenticateInternal: verifierBearerAuthenticator(verifierTokens),
    verifierPublicKeys,
    maxArtifactByteLength: manifestEnvelope.payload.contributionPolicy.maxArtifactByteLength,
    corsAllowedOrigins: parseCorsAllowedOrigins(
      requiredEnv("CORS_ALLOWED_ORIGINS"),
      production,
    ),
  });
  let maintenance: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (maintenance) return;
    maintenance = runtime.operations.maintain().catch(() => {
      // Error objects can contain signed URLs or provider request details.
      app.log.error("ceremony maintenance failed; publication/next-lease gate remains closed");
    }).finally(() => { maintenance = undefined; });
  }, 5000);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); await maintenance; await runtime.pool.end(); });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void app.close(); });
  await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: integerEnv("PORT", 8787) });
}

export function parseCorsAllowedOrigins(
  value: string,
  production: boolean,
): ReadonlySet<string> {
  const origins = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const url = new URL(entry);
      if (
        entry !== url.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" && url.protocol !== "http:")
      ) {
        throw new Error("CORS_ALLOWED_ORIGINS contains an invalid origin");
      }
      if (production && url.protocol !== "https:") {
        throw new Error("production CORS origins must use HTTPS");
      }
      return url.origin;
    });
  if (origins.length === 0 || new Set(origins).size !== origins.length) {
    throw new Error("CORS_ALLOWED_ORIGINS must be nonempty and unique");
  }
  return new Set(origins);
}

async function readSecret(path: string): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("secret file permissions are unsafe");
  return await readFile(path, "utf8");
}

export async function readVerifierTokenMap(
  path: string,
  expectedOperatorKeyIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readSecret(path));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("internal verifier token map is not valid JSON");
    }
    throw error;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("internal verifier token map must be an object");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== expectedOperatorKeyIds.size
    || entries.some(([operatorKeyId]) => !expectedOperatorKeyIds.has(operatorKeyId))) {
    throw new Error("internal verifier token map does not match the signed operator policy");
  }
  const result = new Map<string, string>();
  for (const [operatorKeyId, value] of entries) {
    if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{32,512}$/u.test(value)) {
      throw new Error(`internal verifier token for ${operatorKeyId} is malformed`);
    }
    result.set(operatorKeyId, value);
  }
  if (new Set(result.values()).size !== result.size) {
    throw new Error("internal verifier tokens must be unique per operator");
  }
  return result;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} is invalid`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startCoordinatorFromEnvironment().catch((error) => {
    process.stderr.write(`coordinator failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
