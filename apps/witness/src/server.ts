import { pathToFileURL } from "node:url";
import { createHash, createPublicKey, createPrivateKey } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import Fastify from "fastify";
import type { CeremonyManifestV1, SignedEnvelope } from "@moss/phase2-protocol";
import { PublicationWitness } from "./witness.js";
import { S3MirrorArchive } from "./s3-mirror.js";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error("missing witness configuration"); return value; };
async function boundedFile(path: string, secret = false) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 1024 * 1024 || (secret && (metadata.mode & 0o077) !== 0)) throw new Error("invalid witness configuration file");
  return readFile(path, "utf8");
}
export async function startWitnessFromEnvironment() {
  const root = createPublicKey(await boundedFile(required("MANIFEST_ROOT_PUBLIC_KEY_FILE")));
  const fingerprint = createHash("sha256").update(root.export({ type: "spki", format: "der" })).digest("hex");
  if (fingerprint !== required("MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256")) throw new Error("witness root fingerprint mismatch");
  const manifest = JSON.parse(await boundedFile(required("CEREMONY_MANIFEST_ENVELOPE_PATH"))) as SignedEnvelope<CeremonyManifestV1>;
  const privateKey = createPrivateKey(await boundedFile(required("WITNESS_PRIVATE_KEY_FILE"), true));
  if (privateKey.asymmetricKeyType !== "ed25519" || !manifest.payload.publication
    || !createPublicKey(privateKey).equals(createPublicKey(manifest.payload.publication.witness.publicKeyPem))) throw new Error("witness signing key mismatch");
  const mode = required("CEREMONY_MODE"); if (mode !== "production" && mode !== "rehearsal") throw new Error("invalid witness mode");
  if (Date.parse(required("WITNESS_RETENTION_UNTIL")) <= Date.parse(manifest.payload.beacon.expectedAt)) throw new Error("mirror retention must extend beyond the beacon");
  const archive = new S3MirrorArchive(new S3Client({ region: required("AWS_REGION") }), {
    bucket: required("WITNESS_ARCHIVE_BUCKET"), publicBaseUrl: required("WITNESS_ARCHIVE_PUBLIC_URL"),
    retentionUntil: required("WITNESS_RETENTION_UNTIL"), artifactOrigins: required("WITNESS_ARTIFACT_ORIGINS").split(",").map(s => s.trim()),
  });
  const witness = new PublicationWitness({ manifest, rootPublicKey: root, privateKey, archive, allowRehearsal: mode === "rehearsal" });
  await archive.ready();
  const server = buildWitnessServer(witness);
  await server.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 8789) });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.close(); });
}
export function buildWitnessServer(witness: Pick<PublicationWitness, "acknowledge">) {
  const server = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024, requestTimeout: 60_000 });
  server.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  let busy = false;
  server.get("/healthz", async () => ({ ready: true }));
  server.post("/v1/publications", async (request, reply) => {
    if (busy) return reply.code(503).send({ error: "witness busy; retry" });
    busy = true;
    try { return await witness.acknowledge(request.body as Buffer); }
    catch { return reply.code(409).send({ error: "publication could not be witnessed" }); }
    finally { busy = false; }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void startWitnessFromEnvironment().catch(() => { process.stderr.write("witness startup failed; check private configuration\n"); process.exitCode = 1; });
