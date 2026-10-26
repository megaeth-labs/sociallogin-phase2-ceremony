import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile, chown, chmod } from "node:fs/promises";
import path from "node:path";

const runtimeVersion = "moss-phase2-local-runtime-v3";
const configRoot = process.env.LOCAL_CONFIG_ROOT ?? "/runtime-config";
const coordinatorRoot = process.env.LOCAL_COORDINATOR_SECRET_ROOT ?? "/coordinator-secrets";
const verifierRoot = process.env.LOCAL_VERIFIER_SECRET_ROOT ?? "/verifier-secrets";
const participantPublicRoot = process.env.LOCAL_PARTICIPANT_PUBLIC_ROOT ?? "/participant-auth-public";
const webAuthRoot = process.env.LOCAL_WEB_AUTH_SECRET_ROOT ?? "/web-auth-secrets";
const verifierWorkRoot = process.env.LOCAL_VERIFIER_WORK_ROOT ?? "/verifier-work";
const artifactDataRoot = process.env.LOCAL_ARTIFACT_DATA_ROOT ?? "/artifact-data";
const artifactRoot = process.env.LOCAL_ARTIFACT_ROOT ?? "/artifacts";
const targetUid = Number(process.env.LOCAL_RUNTIME_UID ?? "1000");
const targetGid = Number(process.env.LOCAL_RUNTIME_GID ?? "1000");
const verifierImageDigest = process.env.MOSS_LOCAL_VERIFIER_IMAGE_DIGEST
  ?? `sha256:${"0".repeat(64)}`;
const maxArtifactByteLength = positiveSafeInteger(
  process.env.MOSS_LOCAL_MAX_ARTIFACT_BYTE_LENGTH ?? "2147483648",
  "MOSS_LOCAL_MAX_ARTIFACT_BYTE_LENGTH",
);

if (!/^sha256:[a-f0-9]{64}$/u.test(verifierImageDigest)) {
  throw new Error("MOSS_LOCAL_VERIFIER_IMAGE_DIGEST must be sha256 followed by 64 lowercase hex characters");
}
if (!Number.isSafeInteger(targetUid) || targetUid < 1 || !Number.isSafeInteger(targetGid) || targetGid < 1) {
  throw new Error("local runtime UID and GID must be positive safe integers");
}

const requiredArtifacts = {
  r1cs: process.env.MOSS_PHASE2_R1CS_FILE ?? "circuit.r1cs",
  ptau: process.env.MOSS_PHASE2_PTAU_FILE ?? "powersoftau.ptau",
  genesisZkey: process.env.MOSS_PHASE2_GENESIS_FILE ?? "genesis.zkey",
};

for (const directory of [configRoot, participantPublicRoot]) {
  await prepareDirectory(directory, 0o755);
}
for (const directory of [coordinatorRoot, verifierRoot, webAuthRoot, verifierWorkRoot, artifactDataRoot]) {
  await prepareDirectory(directory, 0o700);
}

const artifact = {};
for (const [name, fileName] of Object.entries(requiredArtifacts)) {
  const filePath = path.join(artifactRoot, fileName);
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size <= 0) {
    throw new Error(`required local verifier artifact is missing or empty: ${filePath}`);
  }
  const hashes = await hashFile(filePath, name === "ptau");
  artifact[name] = {
    sha256: hashes.sha256,
    byteLength: fileStat.size,
    // These local files are intentionally not published by the development
    // stack. The non-routable URL makes the manifest limitation explicit.
    urls: [`http://local-artifacts.invalid/${encodeURIComponent(fileName)}`],
  };
  if (hashes.blake2b512) artifact[name].blake2b512 = hashes.blake2b512;
}
if (artifact.genesisZkey.byteLength > maxArtifactByteLength) {
  throw new Error("MOSS_LOCAL_MAX_ARTIFACT_BYTE_LENGTH is smaller than the local genesis zkey");
}

const contributionPolicy = {
  targetContributions: 3,
  maximumContributions: 3,
  maxArtifactByteLength,
  requirePinnedClientRelease: false,
  lease: {
    offerSeconds: 120,
    absoluteSeconds: 5_400,
    heartbeatSeconds: 15,
  },
  verifierJobSeconds: 7_200,
  verifierMaxAttempts: 3,
};

const completed = path.join(configRoot, ".complete");
try {
  const marker = await readFile(completed, "utf8");
  if (marker.trim() !== runtimeVersion) {
    throw new Error("local runtime format changed; reset the Docker volumes before restarting");
  }
  if (marker.trim() === runtimeVersion) {
    const existing = JSON.parse(await readFile(path.join(configRoot, "manifest-envelope.json"), "utf8"));
    for (const name of Object.keys(requiredArtifacts)) {
      if (existing?.payload?.relation?.[name]?.sha256 !== artifact[name].sha256
        || existing?.payload?.relation?.[name]?.byteLength !== artifact[name].byteLength) {
        throw new Error("local verifier artifacts changed; reset Docker volumes before creating a new development identity");
      }
    }
    if (existing?.payload?.verifierKeys?.[0]?.verifierImageDigest !== verifierImageDigest
      || canonicalize(existing?.payload?.contributionPolicy) !== canonicalize(contributionPolicy)) {
      throw new Error("local signed policy changed; reset Docker volumes before restarting");
    }
    await assertGeneratedFiles();
    process.exit(0);
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const root = generateKeyPairSync("ed25519");
const coordinator = generateKeyPairSync("ed25519");
const verifier = generateKeyPairSync("ed25519");
const participant = generateKeyPairSync("ed25519");
const rootPublicPem = root.publicKey.export({ type: "spki", format: "pem" });
const coordinatorPublicPem = coordinator.publicKey.export({ type: "spki", format: "pem" });
const verifierPublicPem = verifier.publicKey.export({ type: "spki", format: "pem" });
const participantPublicPem = participant.publicKey.export({ type: "spki", format: "pem" });

const now = Date.now();
const manifest = {
  schemaVersion: 1,
  ceremonyId: randomUUID(),
  slug: "moss-phase2-local-development",
  relation: {
    profile: "google-rs256-zksync-v3",
    relationId: "google-rs256-zksync-v3-groth16-bn254-2",
    verifierVersion: 4,
    proofSystem: "groth16",
    curve: "bn254",
    sourceRepository: "local-development-only",
    sourceCommit: "local-development-only",
    sourceClosureSha256: createHash("sha256").update("local-development-only").digest("hex"),
    circomVersion: "2.2.3",
    snarkjsVersion: "0.7.6",
    r1cs: artifact.r1cs,
    ptau: artifact.ptau,
    genesisZkey: artifact.genesisZkey,
  },
  schedule: {
    opensAt: new Date(now - 5 * 60_000).toISOString(),
    sealsAt: new Date(now + 7 * 86_400_000).toISOString(),
  },
  beacon: {
    source: "drand",
    chainHash: "local-development-only",
    round: 1,
    expectedAt: new Date(now + 8 * 86_400_000).toISOString(),
    derivation: "MOSS_PHASE2_BEACON_V1",
    numIterationsExp: 10,
    contributionName: "Local development beacon",
  },
  coordinatorKeys: [{
    keyId: "coordinator-local-dev",
    algorithm: "Ed25519",
    publicKeyPem: coordinatorPublicPem,
  }],
  verifierKeys: [{
    keyId: "verifier-local-dev",
    algorithm: "Ed25519",
    publicKeyPem: verifierPublicPem,
    verifierImageDigest,
  }],
  verifierPolicy: {
    operatorKeyIds: ["verifier-local-dev"],
    requiredOperators: 1,
    passesPerOperator: 1,
  },
  contributionPolicy,
  webRelease: localRelease("web"),
  cliReleases: [localRelease("cli")],
};

const signingBytes = Buffer.concat([
  Buffer.from("MOSS_PHASE2_MANIFEST_V1", "utf8"),
  Buffer.from([0]),
  Buffer.from(canonicalize(manifest), "utf8"),
]);
const envelope = {
  schemaVersion: 1,
  keyId: "manifest-root-dev",
  payload: manifest,
  signature: sign(null, signingBytes, root.privateKey).toString("base64url"),
};

await writeOwned(path.join(configRoot, "manifest-envelope.json"), `${JSON.stringify(envelope, null, 2)}\n`, 0o444);
await writeOwned(path.join(configRoot, "manifest-root-public.pem"), rootPublicPem, 0o444);
await writeOwned(
  path.join(coordinatorRoot, "coordinator-private.pem"),
  coordinator.privateKey.export({ type: "pkcs8", format: "pem" }),
  0o400,
);
await writeOwned(
  path.join(verifierRoot, "verifier-private.pem"),
  verifier.privateKey.export({ type: "pkcs8", format: "pem" }),
  0o400,
);
await writeOwned(
  path.join(participantPublicRoot, "participant-jwt-public.pem"),
  participantPublicPem,
  0o444,
);
await writeOwned(
  path.join(webAuthRoot, "participant-jwt-private.pem"),
  participant.privateKey.export({ type: "pkcs8", format: "pem" }),
  0o400,
);
await writeOwned(
  path.join(webAuthRoot, "participant-id-derivation-key"),
  `${randomBytes(32).toString("base64url")}\n`,
  0o400,
);
const bearer = randomBytes(32).toString("base64url");
await writeOwned(
  path.join(coordinatorRoot, "internal-verifier-bearers.json"),
  `${JSON.stringify({ "verifier-local-dev": bearer })}\n`,
  0o400,
);
await writeOwned(path.join(verifierRoot, "internal-verifier-bearer"), `${bearer}\n`, 0o400);
await writeOwned(completed, `${runtimeVersion}\n`, 0o444);

async function hashFile(filePath, includeBlake2b512) {
  const sha256 = createHash("sha256");
  const blake2b512 = includeBlake2b512 ? createHash("blake2b512") : null;
  for await (const chunk of createReadStream(filePath)) {
    sha256.update(chunk);
    blake2b512?.update(chunk);
  }
  return {
    sha256: sha256.digest("hex"),
    blake2b512: blake2b512?.digest("hex"),
  };
}

function localRelease(kind) {
  return {
    sha256: createHash("sha256").update(`moss-phase2-${kind}-local-development`).digest("hex"),
    byteLength: 1,
    urls: [`http://127.0.0.1/${kind}-local-development`],
    sourceCommit: "local-development-only",
  };
}

async function writeOwned(filePath, contents, mode) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await chown(temporary, targetUid, targetGid);
  await chmod(temporary, mode);
  await rename(temporary, filePath);
}

async function prepareDirectory(directory, mode) {
  await mkdir(directory, { recursive: true, mode });
  await chmod(directory, mode);
  await chown(directory, targetUid, targetGid);
}

async function assertGeneratedFiles() {
  const files = [
    [path.join(configRoot, "manifest-root-public.pem"), false],
    [path.join(coordinatorRoot, "coordinator-private.pem"), true],
    [path.join(coordinatorRoot, "internal-verifier-bearers.json"), true],
    [path.join(verifierRoot, "verifier-private.pem"), true],
    [path.join(verifierRoot, "internal-verifier-bearer"), true],
    [path.join(participantPublicRoot, "participant-jwt-public.pem"), false],
    [path.join(webAuthRoot, "participant-jwt-private.pem"), true],
    [path.join(webAuthRoot, "participant-id-derivation-key"), true],
  ];
  for (const [filePath, secret] of files) {
    const metadata = await stat(filePath).catch(() => null);
    if (!metadata?.isFile() || (secret && (metadata.mode & 0o077) !== 0)) {
      throw new Error("local runtime files are missing or have unsafe permissions; reset Docker volumes");
    }
  }
}

function positiveSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive safe integer`);
  return parsed;
}

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
}
