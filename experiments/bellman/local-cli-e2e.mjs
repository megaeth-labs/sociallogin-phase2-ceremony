#!/usr/bin/env node
// Local end-to-end run of Bellman CLI contributions against the real
// coordinator, PostgreSQL and verifier worker, without Docker. Development
// only: every key, token and manifest it creates is throwaway.
//
// Prerequisites (from the repository root):
//   pnpm install && pnpm build
//   cargo build --release --locked --manifest-path packages/bellman-verify/Cargo.toml
//
// Usage:
//   node experiments/bellman/local-cli-e2e.mjs --work DIR [--pg-bin DIR] [--contributions N] [--keep] [--cli-release-update]
//
// DIR must not exist. --pg-bin defaults to /opt/homebrew/opt/postgresql@16/bin.
// --cli-release-update requires pinned client releases, pins a different CLI
// build in the manifest, checks the built CLI is refused, then authorizes it
// with a root-signed operational update before the contributions.
// The local artifact backend never publishes evidence bundles (that path needs
// S3 and production mode), so the ceremony audit cannot run here; the harness
// instead verifies every saved receipt offline and replays every transition
// from the coordinator's stored artifacts with the native verifier.
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { canonicalize, canonicalSha256, MANIFEST_SIGNATURE_DOMAIN, OPERATIONAL_UPDATE_DOMAIN, signEnvelope } =
  await import(join(repository, "packages/protocol/dist/index.js"));

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const flag = process.argv[i];
  if (flag === "--keep" || flag === "--cli-release-update") args.set(flag, "true");
  else args.set(flag, process.argv[++i]);
}
if (!args.get("--work")) throw new Error("--work DIR is required");
const work = resolve(args.get("--work"));
const pgBin = args.get("--pg-bin") ?? "/opt/homebrew/opt/postgresql@16/bin";
const contributions = Number(args.get("--contributions") ?? "2");
const keep = args.has("--keep");
const cliReleaseUpdate = args.has("--cli-release-update");
const pgPort = 55_000 + Math.floor(Math.random() * 900);
const coordinatorPort = pgPort + 1_000;
const coordinatorUrl = `http://127.0.0.1:${coordinatorPort}`;
const slug = "moss-phase2-local-bellman-cli";
const issuer = "moss-phase2-local-web";
const audience = "moss-phase2-local-coordinator";
const nativeVerifier = join(repository, "packages/bellman-verify/target/release/moss-bellman-verify");
const fixtures = join(repository, "packages/crypto/tests/fixtures");

const children = [];
const log = (message) => process.stdout.write(`[e2e] ${message}\n`);

async function sha256File(path, blake = false) {
  const sha = createHash("sha256");
  const b2 = blake ? createHash("blake2b512") : null;
  for await (const chunk of createReadStream(path)) { sha.update(chunk); b2?.update(chunk); }
  return { sha256: sha.digest("hex"), byteLength: (await stat(path)).size, ...(b2 ? { blake2b512: b2.digest("hex") } : {}) };
}

async function secret(path, contents) {
  await writeFile(path, contents, { mode: 0o600, flag: "wx" });
}

function pem(key, type) {
  return key.export({ type, format: "pem" });
}

function startService(name, command, commandArgs, env, logPath) {
  const child = spawn(command, commandArgs, { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const capture = (chunk) => { lines.push(chunk.toString()); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("exit", () => { void writeFile(logPath, lines.join("")).catch(() => undefined); });
  children.push({ name, child, lines, logPath });
  return child;
}

async function waitFor(label, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await check()) return; } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function participantToken(privateKey, participant) {
  const now = Math.floor(Date.now() / 1000);
  // Same header and claim order as apps/ceremony/src/lib/participant-identity.ts.
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: issuer, aud: audience, sub: participant.id, name: participant.name, ash: participant.ash,
    iat: now, nbf: now - 5, exp: now + 6 * 3600,
  })).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${payload}`, "ascii"), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function run(command, commandArgs, env = process.env) {
  return execFileSync(command, commandArgs, { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

async function main() {
  await mkdir(work, { recursive: false, mode: 0o700 });
  const dirs = Object.fromEntries(["artifacts", "config", "secrets", "pg", "verifier", "logs"].map((name) => [name, join(work, name)]));
  for (const dir of Object.values(dirs)) await mkdir(dir, { mode: 0o700 });

  log("generating the synthetic genesis zkey and its Bellman export");
  run(process.execPath, [join(repository, "packages/cli/tests/generate-bellman-genesis.mjs"), dirs.artifacts]);
  const genesisZkey = join(dirs.artifacts, "genesis.zkey");
  const genesisBellman = join(dirs.artifacts, "genesis.params");
  const r1cs = join(fixtures, "multiplier.r1cs");
  const ptau = join(fixtures, "pot_final.ptau");

  const root = generateKeyPairSync("ed25519");
  const coordinator = generateKeyPairSync("ed25519");
  const verifier = generateKeyPairSync("ed25519");
  const participantKey = generateKeyPairSync("ed25519");
  const localRelease = (kind) => ({
    sha256: createHash("sha256").update(`moss-phase2-${kind}-local-development`).digest("hex"),
    byteLength: 1, urls: [`http://127.0.0.1/${kind}-local-development`], sourceCommit: "local-development-only",
  });
  const artifact = async (path, urlName, blake = false) => ({ ...(await sha256File(path, blake)), urls: [`http://local-artifacts.invalid/${urlName}`] });
  const now = Date.now();
  const manifest = {
    schemaVersion: 1,
    ceremonyId: randomUUID(),
    slug,
    relation: {
      profile: "google-rs256-zksync-v3", relationId: "google-rs256-zksync-v3-groth16-bn254-2", verifierVersion: 4,
      proofSystem: "groth16", curve: "bn254", sourceRepository: "local-development-only", sourceCommit: "local-development-only",
      sourceClosureSha256: createHash("sha256").update("local-development-only").digest("hex"),
      circomVersion: "2.2.3", snarkjsVersion: "0.7.6",
      r1cs: await artifact(r1cs, "multiplier.r1cs"),
      ptau: await artifact(ptau, "pot_final.ptau", true),
      genesisBellman: await artifact(genesisBellman, "genesis.params"),
      genesisZkey: await artifact(genesisZkey, "genesis.zkey"),
    },
    schedule: { opensAt: new Date(now - 5 * 60_000).toISOString(), sealsAt: new Date(now + 86_400_000).toISOString() },
    beacon: {
      source: "drand", chainHash: "local-development-only", round: 1, expectedAt: new Date(now + 2 * 86_400_000).toISOString(),
      derivation: "MOSS_PHASE2_BEACON_V1", numIterationsExp: 10, contributionName: "Local development beacon",
    },
    coordinatorKeys: [{ keyId: "coordinator-local-dev", algorithm: "Ed25519", publicKeyPem: pem(coordinator.publicKey, "spki") }],
    verifierKeys: [{ keyId: "verifier-local-dev", algorithm: "Ed25519", publicKeyPem: pem(verifier.publicKey, "spki"),
      verifierImageDigest: `sha256:${"0".repeat(64)}` }],
    verifierPolicy: { verificationMethod: "bellman-transition-v1", operatorKeyIds: ["verifier-local-dev"], requiredOperators: 1, passesPerOperator: 1 },
    contributionPolicy: {
      targetContributions: contributions + 1, maximumContributions: contributions + 1, maxArtifactByteLength: 2_147_483_648,
      requirePinnedClientRelease: cliReleaseUpdate,
      lease: { offerSeconds: 120, absoluteSeconds: 5_400, heartbeatSeconds: cliReleaseUpdate ? 30 : 15 },
      verifierJobSeconds: 7_200, verifierMaxAttempts: 3,
    },
    webRelease: localRelease("web"),
    cliReleases: [localRelease("cli")],
    ...(cliReleaseUpdate ? { operationalPolicy: {
      minHeartbeatGraceSeconds: 30, maxHeartbeatGraceSeconds: 600, allowWebReleaseUpdates: true, allowCliReleaseUpdates: true } } : {}),
  };
  const envelope = signEnvelope(manifest, { keyId: "manifest-root-dev", privateKey: root.privateKey, domain: MANIFEST_SIGNATURE_DOMAIN });
  const manifestPath = join(dirs.config, "manifest-envelope.json");
  const rootPath = join(dirs.config, "manifest-root-public.pem");
  await writeFile(manifestPath, `${JSON.stringify(envelope, null, 2)}\n`);
  await writeFile(rootPath, pem(root.publicKey, "spki"));
  const participantPublic = join(dirs.config, "participant-jwt-public.pem");
  await writeFile(participantPublic, pem(participantKey.publicKey, "spki"));
  const coordinatorKeyPath = join(dirs.secrets, "coordinator-private.pem");
  const verifierKeyPath = join(dirs.secrets, "verifier-private.pem");
  await secret(coordinatorKeyPath, pem(coordinator.privateKey, "pkcs8"));
  await secret(verifierKeyPath, pem(verifier.privateKey, "pkcs8"));
  const bearer = randomBytes(32).toString("base64url");
  const bearersPath = join(dirs.secrets, "internal-verifier-bearers.json");
  const bearerPath = join(dirs.secrets, "internal-verifier-bearer");
  await secret(bearersPath, `${JSON.stringify({ "verifier-local-dev": bearer })}\n`);
  await secret(bearerPath, `${bearer}\n`);
  log(`manifest ${manifest.ceremonyId} signed (bellman-transition-v1)`);

  log(`starting PostgreSQL on 127.0.0.1:${pgPort}`);
  const pgEnv = { ...process.env, PATH: `${pgBin}:${process.env.PATH}` };
  run(join(pgBin, "initdb"), ["-D", dirs.pg, "-U", "moss_admin", "-A", "trust", "-E", "UTF8", "--no-locale"], pgEnv);
  run(join(pgBin, "pg_ctl"), ["-D", dirs.pg, "-l", join(dirs.logs, "postgres.log"), "-w",
    // TCP only: scratch paths can exceed the 103-byte Unix socket path limit.
    "-o", `-p ${pgPort} -c unix_socket_directories= -c listen_addresses=127.0.0.1`, "start"], pgEnv);
  const psqlArgs = ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "moss_admin", "-v", "ON_ERROR_STOP=1", "-q"];
  run(join(pgBin, "createdb"), ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "moss_admin", "moss_phase2"], pgEnv);
  for (const name of (await readdir(join(repository, "packages/db/migrations"))).filter((n) => n.endsWith(".sql")).sort()) {
    run(join(pgBin, "psql"), [...psqlArgs, "-d", "moss_phase2", "-f", join(repository, "packages/db/migrations", name)], pgEnv);
  }
  const coordinatorDbPassword = randomBytes(18).toString("base64url");
  run("sh", [join(repository, "infra/postgres/init-roles.sh")], {
    ...pgEnv, PGHOST: "127.0.0.1", PGPORT: String(pgPort), POSTGRES_DB: "moss_phase2", POSTGRES_USER: "moss_admin",
    MOSS_COORDINATOR_DB_USER: "moss_phase2_coordinator", MOSS_COORDINATOR_DB_PASSWORD: coordinatorDbPassword,
  });
  log("migrations applied; coordinator role created");

  startService("coordinator", process.execPath, ["apps/coordinator/dist/server.js"], {
    PATH: process.env.PATH, NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(coordinatorPort),
    DATABASE_URL: `postgresql://moss_phase2_coordinator:${coordinatorDbPassword}@127.0.0.1:${pgPort}/moss_phase2`,
    CEREMONY_MANIFEST_ENVELOPE_PATH: manifestPath, MANIFEST_ROOT_PUBLIC_KEY_FILE: rootPath,
    COORDINATOR_KEY_ID: "coordinator-local-dev", COORDINATOR_PRIVATE_KEY_FILE: coordinatorKeyPath,
    INTERNAL_VERIFIER_BEARER_TOKENS_FILE: bearersPath, PUBLIC_BASE_URL: coordinatorUrl,
    ARTIFACT_BACKEND: "local", ARTIFACT_LOCAL_ROOT: join(work, "artifact-store"),
    // A Bellman epoch's canonical contribution genesis is the Bellman export.
    GENESIS_ZKEY_PATH: genesisBellman,
    PARTICIPANT_JWT_PUBLIC_KEY_FILE: participantPublic, PARTICIPANT_JWT_ISSUER: issuer, PARTICIPANT_JWT_AUDIENCE: audience,
    CORS_ALLOWED_ORIGINS: "http://127.0.0.1:3000",
  }, join(dirs.logs, "coordinator.log"));
  await waitFor("coordinator health", async () => (await fetch(`${coordinatorUrl}/healthz`)).ok);
  log(`coordinator healthy at ${coordinatorUrl}`);

  startService("verifier", process.execPath, ["apps/verifier-worker/dist/main.js"], {
    PATH: process.env.PATH, NODE_ENV: "development", COORDINATOR_URL: coordinatorUrl,
    CEREMONY_MANIFEST_ENVELOPE_PATH: manifestPath, MANIFEST_ROOT_PUBLIC_KEY_FILE: rootPath,
    INTERNAL_VERIFIER_BEARER_TOKEN_FILE: bearerPath, VERIFIER_OPERATOR_KEY_ID: "verifier-local-dev",
    VERIFIER_PRIVATE_KEY_FILE: verifierKeyPath, VERIFIER_IMAGE_DIGEST: `sha256:${"0".repeat(64)}`,
    VERIFIER_PASSES_PER_OPERATOR: "1", VERIFIER_ALLOWED_ARTIFACT_ORIGINS: coordinatorUrl,
    VERIFIER_ALLOWED_ARTIFACT_FILE_ROOT: join(work, "artifact-store"), VERIFIER_WORK_ROOT: dirs.verifier,
    GENESIS_ZKEY_PATH: genesisZkey, PTAU_PATH: ptau, MAX_ARTIFACT_BYTE_LENGTH: "2147483648",
    BELLMAN_VERIFIER_PATH: nativeVerifier, POLL_INTERVAL_MS: "1000",
  }, join(dirs.logs, "verifier.log"));
  await waitFor("verifier ready", async () => children.find((c) => c.name === "verifier").lines.join("").includes("ready"));
  log("verifier worker ready (Bellman genesis export reproduced)");

  let cliRelease;
  if (cliReleaseUpdate) {
    const built = await sha256File(join(repository, "packages/cli/dist/index.js"));
    log("checking the coordinator-unlisted CLI build is refused before the update");
    const refused = await new Promise((resolveRun) => {
      const cli = spawn(process.execPath, [join(repository, "packages/cli/dist/index.js"), "contribute", coordinatorUrl,
        "--slug", slug, "--manifest-root-key", rootPath, "--token", "unused", "--allow-development-manifest"],
      { cwd: repository, env: { PATH: process.env.PATH, HOME: join(work, "refused") }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      cli.stdout.on("data", (c) => { text += c; });
      cli.stderr.on("data", (c) => { text += c; });
      cli.on("exit", (code) => resolveRun({ code, text }));
    });
    if (refused.code === 0 || !refused.text.includes(`This CLI build (${built.sha256}) is not authorized`)) {
      throw new Error(`the CLI was not refused before the update:\n${refused.text}`);
    }
    cliRelease = { sha256: built.sha256, byteLength: built.byteLength, urls: ["https://releases.invalid/moss-ceremony.js"],
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim() };
    const update = signEnvelope({ schemaVersion: 1, type: "moss.phase2.operational-update.v1", ceremonyId: manifest.ceremonyId,
      manifestSha256: canonicalSha256("MOSS_PHASE2_MANIFEST_PAYLOAD_V1", manifest), sequence: 1, previousUpdateSha256: null,
      authorizedAt: new Date().toISOString(), reason: "Authorize the locally built CLI", cliRelease },
    { keyId: "manifest-root-dev", privateKey: root.privateKey, domain: OPERATIONAL_UPDATE_DOMAIN });
    const response = await fetch(`${coordinatorUrl}/v1/ceremonies/${slug}/operational-updates`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
    if (!response.ok) throw new Error(`operational update rejected: ${response.status} ${await response.text()}`);
    log(`root-signed update 1 authorizes CLI build ${built.sha256.slice(0, 12)}…`);
  }

  const results = [];
  for (let index = 1; index <= contributions; index += 1) {
    const home = join(work, `participant-${index}`);
    await mkdir(home, { mode: 0o700 });
    const participant = { id: randomUUID(), name: `e2e-participant-${index}`, ash: randomBytes(32).toString("hex") };
    const tokenPath = join(home, "participant.jwt");
    await secret(tokenPath, participantToken(participantKey.privateKey, participant));
    log(`participant ${index}: running the CLI contribute command`);
    const started = Date.now();
    const output = await new Promise((resolveRun, rejectRun) => {
      const cli = spawn(process.execPath, [join(repository, "packages/cli/dist/index.js"), "contribute", coordinatorUrl,
        "--slug", slug, "--manifest-root-key", rootPath, "--token-file", tokenPath, "--allow-development-manifest"],
      { cwd: repository, env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
      let text = "";
      cli.stdout.on("data", (c) => { text += c; });
      cli.stderr.on("data", (c) => { text += c; });
      cli.on("exit", (code) => code === 0 ? resolveRun(text) : rejectRun(new Error(`CLI exited ${code}:\n${text}`)));
    });
    await writeFile(join(dirs.logs, `cli-${index}.log`), output);
    const receiptDir = join(home, ".moss-phase2-ceremony", "receipts");
    const receiptFiles = (await readdir(receiptDir, { recursive: true })).filter((n) => n.endsWith(".json"));
    if (receiptFiles.length !== 1) throw new Error(`expected one saved receipt for participant ${index}`);
    const saved = JSON.parse(await readFile(join(receiptDir, receiptFiles[0]), "utf8"));
    const accepted = /Contribution #(\d+) accepted\./u.exec(output);
    if (cliRelease && saved.receiptEnvelope.payload.clientReleaseSha256 !== cliRelease.sha256) {
      throw new Error(`receipt ${index} does not record the update-authorized CLI build`);
    }
    results.push({
      index, seconds: (Date.now() - started) / 1000, accepted: accepted ? Number(accepted[1]) : null,
      receiptPath: join(receiptDir, receiptFiles[0]), receipt: saved.receiptEnvelope.payload,
    });
    log(`participant ${index}: contribution #${accepted?.[1]} accepted in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  }

  log("verifying each saved receipt offline with the CLI");
  for (const result of results) {
    run(process.execPath, [join(repository, "packages/cli/dist/index.js"), "verify-receipt", result.receiptPath,
      "--manifest", manifestPath, "--manifest-root-key", rootPath, "--slug", slug, "--allow-development-manifest"]);
  }

  log("replaying every transition from the coordinator's stored artifacts with the native verifier");
  const stored = new Map();
  for (const name of await readdir(join(work, "artifact-store"), { recursive: true })) {
    const path = join(work, "artifact-store", name);
    if ((await stat(path)).isFile()) stored.set((await sha256File(path)).sha256, path);
  }
  const replay = [];
  for (const result of results) {
    const { predecessor, successor } = result.receipt;
    const before = stored.get(predecessor.sha256) ?? (predecessor.sha256 === manifest.relation.genesisBellman.sha256 ? genesisBellman : null);
    const after = stored.get(successor.sha256);
    if (!before || !after) throw new Error(`stored artifacts missing for contribution ${result.accepted}`);
    const verified = JSON.parse(run(process.execPath, [join(repository, "packages/bellman-verify/verify.mjs"), before, after,
      String(result.receipt.contributionIndex - 1)]));
    if (!verified.valid || verified.contributionHashBlake2b512 !== result.receipt.contributionHashBlake2b512) {
      throw new Error(`transition ${result.accepted} failed replay`);
    }
    replay.push({ contributionIndex: verified.contributionIndex, identifierMatchesReceipt: true });
  }

  const summary = {
    ceremonyId: manifest.ceremonyId, verificationMethod: "bellman-transition-v1", coordinatorUrl,
    contributions: results.map(({ index, seconds, accepted, receipt }) => ({
      participant: index, acceptedAs: accepted, seconds,
      predecessorSha256: receipt.predecessor.sha256, successorSha256: receipt.successor.sha256,
      successorByteLength: receipt.successor.byteLength, contributionHashBlake2b512: receipt.contributionHashBlake2b512,
    })),
    ...(cliRelease ? { cliReleaseAuthorizedByUpdate: cliRelease.sha256 } : {}),
    receiptsVerifiedOffline: results.length,
    transitionsReplayed: replay.length,
  };
  await writeFile(join(work, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return { pgEnv, dirs };
}

async function teardown(context) {
  for (const { child } of children.reverse()) child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 1_000));
  for (const { lines, logPath } of children) await writeFile(logPath, lines.join("")).catch(() => undefined);
  if (context) {
    try { execFileSync(join(pgBin, "pg_ctl"), ["-D", context.dirs.pg, "-m", "fast", "-w", "stop"], { env: context.pgEnv, stdio: "ignore" }); }
    catch { /* already stopped */ }
  }
}

let context;
let failed = false;
try {
  context = await main();
} catch (error) {
  failed = true;
  process.stderr.write(`[e2e] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  for (const { name, lines } of children) process.stderr.write(`--- ${name} (last lines)\n${lines.join("").split("\n").slice(-30).join("\n")}\n`);
} finally {
  await teardown(context ?? { dirs: { pg: join(work, "pg") }, pgEnv: { ...process.env, PATH: `${pgBin}:${process.env.PATH}` } });
  if (!keep && !failed) await rm(work, { recursive: true, force: true });
  if (failed || keep) log(`work directory kept at ${work}`);
}
process.exitCode = failed ? 1 : 0;
