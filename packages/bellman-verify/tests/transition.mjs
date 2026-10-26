// Real cryptographic regression: no candidate bytes, entropy, or library logs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspectBellmanAppend, normalizeBellmanForRust, inspectBellman, MemoryByteSource } from '../../zkey-inspect/dist/index.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(root, 'packages/crypto/package.json'));
const { zKey } = require('snarkjs');
const production = process.argv.includes('--production');
const inputRoot = join(root, production ? 'artifacts/moonsong-local' : 'packages/crypto/tests/fixtures');
const r1csPath = join(inputRoot, production ? 'circuit.r1cs' : 'multiplier.r1cs');
const ptauPath = join(inputRoot, production ? 'powersoftau.ptau' : 'pot_final.ptau');
if (process.argv[2] === '--generate') {
  console.log = () => {};
  const dir = process.argv[3];
  const { randomBytes } = await import('node:crypto');
  const { buildBn128 } = require('ffjavascript');
  const curve = await buildBn128();
  if (!production) await zKey.newZKey(r1csPath, ptauPath, join(dir, 'genesis.zkey'));
  const genesis = production ? join(inputRoot, 'genesis.zkey') : join(dir, 'genesis.zkey');
  if (production) {
    const { relation } = JSON.parse(await readFile(join(root, 'ceremonies/google-rs256-zksync-v3/definition.draft.json'), 'utf8'));
    for (const [path, pin] of [[genesis, relation.genesisZkey], [r1csPath, relation.r1cs], [ptauPath, relation.ptau]]) {
      assert.equal((await stat(path)).size, pin.byteLength); const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      assert.equal(hash.digest('hex'), pin.sha256);
    }
  }
  await zKey.exportBellman(genesis, join(dir, '0.params'));
  for (let i = 1; i <= 3; i++) await zKey.bellmanContribute(curve, join(dir, `${i-1}.params`), join(dir, `${i}.params`), randomBytes(64).toString('hex'));
  process.exit(0);
}
if (process.argv[2] === '--final-import') {
  console.log = () => {};
  const { SnarkjsPhase2Backend } = await import('../../../apps/finalizer/dist/backend.js');
  const backend = new SnarkjsPhase2Backend();
  const dir = process.argv[3];
  const imported = join(dir, 'sealed.zkey'), final = join(dir, 'final.zkey');
  await backend.importBellman(production ? join(inputRoot, 'genesis.zkey') : join(dir, 'genesis.zkey'), join(dir, '3.params'), imported);
  const r1cs = r1csPath;
  const ptau = ptauPath;
  assert.equal(await backend.verifyFromR1cs(r1cs, ptau, imported), true);
  await backend.applyBeacon({ sealedHeadPath: imported, finalZkeyPath: final,
    contributionName: 'test-beacon', beaconHashHex: '42'.repeat(32), numIterationsExp: 10 });
  assert.equal(await backend.verifyFromR1cs(r1cs, ptau, final), true);
  process.exit(0);
}
const directory = await mkdtemp(join(tmpdir(), 'moss-bellman-transition-'));
const binary = resolve(root, 'packages/bellman-verify/target/release/moss-bellman-verify');
const { BellmanPassRunner } = await import('../../../apps/verifier-worker/dist/bellman-runner.js');
const runner = new BellmanPassRunner(binary);
try {
  assert.equal(spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--generate', directory, ...(production ? ['--production'] : [])], { stdio: 'ignore', timeout: production ? 3600000 : 120000 }).status, 0, 'fixture generation');
  for (let i = 0; i <= 3; i++) await normalizeBellmanForRust(join(directory, `${i}.params`), join(directory, `${i}.rust`), i);
  const verify = (a,b,count) => spawnSync(binary, [join(directory,a), join(directory,b), String(count)], { encoding: 'utf8', timeout: production ? 300000 : 30000, maxBuffer: 1024 });
  for (let i = 1; i <= 3; i++) {
    const observed = await inspectBellmanAppend(join(directory, `${i-1}.params`), join(directory, `${i}.params`), i-1);
    const result = verify(`${i-1}.rust`, `${i}.rust`, i-1);
    assert.equal(result.status, 0, 'valid transition');
    assert.equal(result.stdout.trim(), observed.contributionHashBlake2b512, 'independent hash agrees');
    const pass = await runner.run({ predecessorPath: join(directory, `${i-1}.params`), candidatePath: join(directory, `${i}.params`), genesisPath: '', ptauPath: '', expectedContributionName: 'receipt-only-name', expectedContributionHashBlake2b512: observed.contributionHashBlake2b512, maxPredecessorContributions: i-1 }, production ? 300000 : 30000);
    assert.equal(pass.result, 'valid'); assert.equal(pass.verifyFromInit, false); assert.equal(pass.bellmanTransition, true); assert.equal(pass.observedContributionName, null);
  }
  if (!production) {
    const offline = spawnSync(process.execPath, [join(root, 'packages/bellman-verify/verify.mjs'), join(directory, '0.params'), join(directory, '1.params'), '0'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(offline.status, 0, 'offline verifier');
    assert.equal(JSON.parse(offline.stdout).valid, true);
    assert.equal(spawnSync(process.execPath, [join(root, 'packages/bellman-verify/verify.mjs'), join(directory, '0.params'), join(directory, '2.params'), '0'], { stdio: 'ignore', timeout: 30000 }).status, 1, 'offline skipped contribution rejected');
  }
  for (const [a,b,count] of [['0.rust','0.rust',0],['0.rust','2.rust',0],['2.rust','1.rust',2],['0.rust','1.rust',1]]) assert.equal(verify(a,b,count).status, 1);
  if (!production) {
  const bytes = await readFile(join(directory,'1.rust'));
  const layout = await inspectBellman(new MemoryByteSource(bytes),1);
  const cases = [Buffer.concat([bytes,Buffer.of(0)]),bytes.subarray(0,-1)];
  // Malformed point, zero proof point, changed H, changed fixed data, circuit hash.
  for (const offset of [0, layout.vectors[1].offset, layout.circuitHashOffset, layout.contributionsOffset]) {
    const bad = Buffer.from(bytes); bad[offset] ^= 1; cases.push(bad);
  }
  const zeroProof = Buffer.from(bytes); zeroProof.fill(0,layout.contributionsOffset,layout.contributionsOffset+64); zeroProof[layout.contributionsOffset]=0x40; cases.push(zeroProof);
  const countBomb = Buffer.from(bytes); countBomb.writeUInt32BE(0xffffffff,576); cases.push(countBomb);
  for (const bad of cases) {
    await writeFile(join(directory,'bad.rust'),bad,{mode:0o600});
    assert.equal(verify('0.rust','bad.rust',0).status,1,'malformed candidate must reject cleanly');
  }
  }
  console.log('Direct transitions verified; beginning final import and beacon verification.');
  const finalResult = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--final-import', directory, ...(production ? ['--production'] : [])], { encoding: 'utf8', timeout: production ? 3600000 : 120000 });
  assert.equal(finalResult.status, 0, 'one final import and full verification before/after beacon');
  console.log(production ? 'PASS: pinned production circuit; three direct transitions, four negative controls, final import and beacon verification.' : 'PASS: three direct transitions, independent hashes, and 12 negative controls; one final import, verified before/after beacon; no intermediate imports');
} finally { await rm(directory,{recursive:true,force:true}); }
