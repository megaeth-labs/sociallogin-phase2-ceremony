// Generate a fresh set of ceremony keys and secrets, as listed in PRODUCTION_KEYS.md.
// Never prints private material; prints only key IDs and public fingerprints.
//
//   node infra/generate-secrets.mjs --out <new directory> [--with-root]
//
// The manifest root key is generated only with --with-root, for test ceremonies.
// For mainnet, generate it on an offline machine as PRODUCTION_KEYS.md describes.
// The GitHub OAuth app and the collectible keys are created elsewhere.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

const spkiSha256 = (publicKey) => createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
const token = (bytes) => randomBytes(bytes).toString("base64url");

try {
  const { values } = parseArgs({ options: {
    out: { type: "string" },
    "with-root": { type: "boolean", default: false },
    "root-key-id": { type: "string", default: "test-root" },
    "coordinator-key-id": { type: "string", default: "coordinator-1" },
    "verifier-key-id": { type: "string", default: "verifier-a" },
  } });
  if (!values.out) throw Error("missing --out");
  for (const id of [values["root-key-id"], values["coordinator-key-id"], values["verifier-key-id"]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw Error("invalid key ID");
  }
  await mkdir(values.out, { recursive: true, mode: 0o700 });
  if ((await readdir(values.out)).length) throw Error("output directory is not empty");

  // flag "wx" refuses to replace a file that appeared since the check above.
  const put = (name, text, mode = 0o600) => writeFile(join(values.out, name), text, { flag: "wx", mode });
  const keyPair = async (name) => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await put(`${name}.key`, privateKey.export({ type: "pkcs8", format: "pem" }));
    await put(`${name}.pub`, publicKey.export({ type: "spki", format: "pem" }), 0o644);
    return spkiSha256(publicKey);
  };

  const summary = { schemaVersion: 1, generatedAt: new Date().toISOString(), keys: {} };
  if (values["with-root"]) {
    summary.keys.manifestRoot = { keyId: values["root-key-id"], files: ["manifest-root.key", "manifest-root.pub"], spkiSha256: await keyPair("manifest-root") };
  }
  const coordinatorId = values["coordinator-key-id"];
  const verifierId = values["verifier-key-id"];
  summary.keys.coordinator = { keyId: coordinatorId, files: [`${coordinatorId}.key`, `${coordinatorId}.pub`], spkiSha256: await keyPair(coordinatorId) };
  summary.keys.verifier = { keyId: verifierId, files: [`${verifierId}.key`, `${verifierId}.pub`], spkiSha256: await keyPair(verifierId) };
  summary.keys.participantJwt = { files: ["participant-jwt.key", "participant-jwt.pub"], spkiSha256: await keyPair("participant-jwt") };

  // The verifier holds its token; the coordinator holds a map keyed by the signed operator ID.
  const verifierToken = token(48);
  await put(`${verifierId}.token`, verifierToken);
  await put("coordinator-verifier-tokens.json", JSON.stringify({ [verifierId]: verifierToken }) + "\n");
  await put("participant-id-derivation.key", token(32));
  await put("nextauth-secret", token(32));
  summary.secrets = [`${verifierId}.token`, "coordinator-verifier-tokens.json", "participant-id-derivation.key", "nextauth-secret"];
  await put("public.json", JSON.stringify(summary, null, 2) + "\n", 0o644);

  for (const [role, key] of Object.entries(summary.keys)) console.log(`${role}${key.keyId ? ` (${key.keyId})` : ""}: SPKI SHA-256 ${key.spkiSha256}`);
  console.log(`Wrote ${values.out}. Private files are mode 0600; public keys and public.json are 0644.`);
  if (!values["with-root"]) console.log("No manifest root key: generate it offline (PRODUCTION_KEYS.md, section 1).");
} catch (error) {
  console.error(`Secret generation failed: ${error.message}`);
  process.exitCode = 1;
}
