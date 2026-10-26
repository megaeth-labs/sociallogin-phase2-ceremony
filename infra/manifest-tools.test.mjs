import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('manifest tools assemble and sign only an explicitly opted-in rehearsal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'moss-manifest-tools-test-'));
  const command = (file, args) => execFileSync(process.execPath, [file, ...args], { stdio: 'pipe' });
  try {
    const definition = { relation: { profile: 'google-rs256-zksync-v3', relationId: 'google-rs256-zksync-v3-groth16-bn254-2',
      verifierVersion: 4, proofSystem: 'groth16', curve: 'bn254', snarkjsVersion: '0.7.6',
      circuitSource: { upstreamRepository: 'https://example.test/source', upstreamCommit: 'a'.repeat(40),
        recursiveIncludeClosureSha256: 'b'.repeat(64), circomVersion: '2.2.3' },
      r1cs: { sha256: 'c'.repeat(64), byteLength: 10 },
      ptau: { sha256: 'd'.repeat(64), byteLength: 10, blake2b512: 'e'.repeat(128) },
      genesisZkey: { sha256: 'f'.repeat(64), byteLength: 10 } } };
    const defPath = join(dir, 'definition.json');
    await writeFile(defPath, JSON.stringify(definition));
    const productionPath = join(dir, 'production-inputs.json');
    command('infra/build-manifest.mjs', ['--definition', defPath, '--template', productionPath]);
    const production = JSON.parse(await readFile(productionPath, 'utf8'));
    assert.equal(production.purpose, 'production');
    assert.equal(production.beacon.numIterationsExp, 10);
    const draft = JSON.parse(await readFile('ceremonies/google-rs256-zksync-v3/inputs.draft.json', 'utf8'));
    assert.equal(draft.beacon.numIterationsExp, 10);
    const inputsPath = join(dir, 'inputs.json');
    command('infra/build-manifest.mjs', ['--definition', defPath, '--template', inputsPath, '--allow-rehearsal']);
    const input = JSON.parse(await readFile(inputsPath, 'utf8'));
    assert.equal(input.purpose, 'rehearsal');
    assert.equal(input.verifierKeys.length, 1);
    // Explicit commitments must survive assembly even when the default changes.
    input.beacon.numIterationsExp = 32;
    input.slug = 'synthetic-rehearsal';
    input.beacon.blockNumber = 30000000;
    input.artifactUrls = { r1cs: ['https://archive.example/r1cs'], ptau: ['https://archive.example/ptau'], genesisZkey: ['https://archive.example/genesis'] };
    input.publication.endpoint = 'https://witness.example/publish';
    for (const key of [...input.coordinatorKeys, ...input.verifierKeys, input.publication.witness]) {
      const pair = generateKeyPairSync('ed25519');
      key.publicKeyFile = join(dir, key.keyId + '.pub');
      await writeFile(key.publicKeyFile, pair.publicKey.export({ type: 'spki', format: 'pem' }));
      if ('verifierImageDigest' in key) key.verifierImageDigest = 'sha256:' + '1'.repeat(64);
    }
    for (const [index, release] of [input.webRelease, ...input.cliReleases].entries()) {
      release.sha256 = String(index + 2).repeat(64); release.byteLength = 10;
      release.urls = ['https://release.example/client']; release.sourceCommit = '3'.repeat(40);
    }
    await writeFile(inputsPath, JSON.stringify(input));
    const manifestPath = join(dir, 'manifest.json');
    const args = ['--definition', defPath, '--inputs', inputsPath, '--out', manifestPath];
    assert.throws(() => command('infra/build-manifest.mjs', args));
    command('infra/build-manifest.mjs', [...args, '--allow-rehearsal']);
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).beacon.numIterationsExp, 32);
    const pair = generateKeyPairSync('ed25519');
    const keyPath = join(dir, 'synthetic-root.key');
    await writeFile(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const signArgs = ['--manifest', manifestPath, '--root-key', keyPath, '--key-id', 'root-test', '--out', join(dir, 'envelope.json')];
    assert.throws(() => command('infra/sign-manifest.mjs', signArgs));
    command('infra/sign-manifest.mjs', [...signArgs, '--allow-rehearsal']);
    assert.equal(JSON.parse(await readFile(join(dir, 'envelope.json'), 'utf8')).payload.purpose, 'rehearsal');
    // Bellman rehearsals must preserve their exact export and native policy.
    delete input.publication;
    input.primaryPublication = { archiveBaseUrl: 'https://archive.example' };
    input.genesisBellman = { sha256: '8'.repeat(64), byteLength: 1000, urls: ['https://archive.example/genesis.params'] };
    input.verifierPolicy.verificationMethod = 'bellman-transition-v1';
    await writeFile(inputsPath, JSON.stringify(input));
    const bellmanPath = join(dir, 'bellman.json');
    command('infra/build-manifest.mjs', ['--definition', defPath, '--inputs', inputsPath, '--out', bellmanPath, '--allow-rehearsal']);
    const bellman = JSON.parse(await readFile(bellmanPath, 'utf8'));
    assert.deepEqual(bellman.relation.genesisBellman, input.genesisBellman);
    assert.equal(bellman.verifierPolicy.verificationMethod, 'bellman-transition-v1');
    assert.deepEqual(bellman.primaryPublication, input.primaryPublication);
    // Without the signed policy, no website or heartbeat update can be authorized after opening.
    assert.ok(input.operationalPolicy);
    assert.deepEqual(bellman.operationalPolicy, input.operationalPolicy);

  } finally { await rm(dir, { recursive: true, force: true }); }
});
