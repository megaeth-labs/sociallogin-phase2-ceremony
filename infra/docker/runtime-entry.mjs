import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENV_NAMES = new Set([
  'CEREMONY_MODE', 'DATABASE_URL', 'PUBLIC_BASE_URL', 'COORDINATOR_KEY_ID',
  'PARTICIPANT_JWT_ISSUER', 'PARTICIPANT_JWT_AUDIENCE', 'CORS_ALLOWED_ORIGINS',
  'S3_QUARANTINE_BUCKET', 'S3_ARCHIVE_BUCKET', 'S3_RETENTION_UNTIL',
  'COORDINATOR_URL', 'VERIFIER_OPERATOR_KEY_ID', 'VERIFIER_IMAGE_DIGEST',
  'VERIFIER_ALLOWED_ARTIFACT_ORIGINS', 'MAX_ARTIFACT_BYTE_LENGTH',
  'VERIFY_PASS_TIMEOUT_MS', 'POLL_INTERVAL_MS',
  'WITNESS_ARCHIVE_BUCKET', 'WITNESS_ARCHIVE_PUBLIC_URL', 'WITNESS_RETENTION_UNTIL',
  'WITNESS_ARTIFACT_ORIGINS', 'MANIFEST_ROOT_PUBLIC_KEY_SPKI_SHA256',
]);
const FILE_NAMES = new Set([
  'REHEARSAL_WEB_RELEASE_AUTHORIZATION_FILE',
  'CEREMONY_MANIFEST_ENVELOPE_PATH', 'MANIFEST_ROOT_PUBLIC_KEY_FILE',
  'COORDINATOR_PRIVATE_KEY_FILE', 'PARTICIPANT_JWT_PUBLIC_KEY_FILE',
  'INTERNAL_VERIFIER_BEARER_TOKENS_FILE', 'DATABASE_CA_FILE',
  'VERIFIER_PRIVATE_KEY_FILE', 'INTERNAL_VERIFIER_BEARER_TOKEN_FILE', 'WITNESS_PRIVATE_KEY_FILE',
]);

export async function prepareRuntime(config, environment = process.env) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some((key) => !['environment', 'files'].includes(key))) throw new Error('invalid runtime configuration');
  for (const [section, allowed] of [['environment', ENV_NAMES], ['files', FILE_NAMES]]) {
    const values = config[section];
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('invalid runtime configuration section');
    for (const [name, value] of Object.entries(values)) {
      if (!allowed.has(name) || typeof value !== 'string' || !value || Buffer.byteLength(value) > 65536) {
        throw new Error('unsupported runtime configuration entry');
      }
    }
  }
  if (!['production', 'rehearsal'].includes(config.environment.CEREMONY_MODE)) throw new Error('explicit ceremony mode is required');
  const directory = await mkdtemp(join(tmpdir(), 'moss-runtime-'));
  for (const [name, value] of Object.entries(config.environment)) environment[name] = value;
  for (const [name, value] of Object.entries(config.files)) {
    const path = join(directory, name);
    await writeFile(path, value, { mode: 0o600, flag: 'wx' });
    environment[name] = path;
  }
  environment.NODE_ENV = 'production';
  environment.ARTIFACT_BACKEND = 's3';
  environment.HOST = '0.0.0.0';
  environment.PORT = '8787';
  environment.VERIFIER_WORK_ROOT = join(directory, 'jobs');
  environment.GENESIS_ZKEY_PATH = join(directory, 'genesis.zkey');
  environment.PTAU_PATH = join(directory, 'powersoftau.ptau');
  environment.DOWNLOAD_PINNED_INPUTS = 'true';
  environment.VERIFIER_PASSES_PER_OPERATOR = '1';
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const encoded = process.env.CEREMONY_RUNTIME_CONFIG;
    delete process.env.CEREMONY_RUNTIME_CONFIG;
    if (!encoded) throw new Error('missing runtime configuration');
    await prepareRuntime(JSON.parse(encoded));
    const entry = process.argv[2];
    if (!['server', 'main', 'witness', 'review'].includes(entry)) throw new Error('invalid runtime entrypoint');
    const module = await import(`../dist/${entry === "witness" ? "server" : entry === "review" ? "review-server" : entry}.js`);
    if (entry === "witness") await module.startWitnessFromEnvironment();
    if (entry === "review") await module.startReviewFromEnvironment();
    if (entry === "server") await module.startCoordinatorFromEnvironment();
  } catch {
    // Config parsing and SDK errors can contain material. Do not print them.
    process.stderr.write('ceremony runtime bootstrap failed; check private configuration\n');
    process.exitCode = 1;
  }
}
