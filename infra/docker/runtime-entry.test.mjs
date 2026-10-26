import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, rm } from 'node:fs/promises';
import { prepareRuntime } from './runtime-entry.mjs';
test('runtime material is private and production safeguards cannot be overridden', async () => {
  const environment = {};
  const directory = await prepareRuntime({ environment: { CEREMONY_MODE: 'rehearsal' }, files: { VERIFIER_PRIVATE_KEY_FILE: 'synthetic fixture' } }, environment);
  try {
    assert.equal(environment.NODE_ENV, 'production');
    assert.equal((await stat(environment.VERIFIER_PRIVATE_KEY_FILE)).mode & 0o777, 0o600);
    await assert.rejects(prepareRuntime({ environment: { CEREMONY_MODE: 'rehearsal', NODE_OPTIONS: '--require evil' }, files: {} }, {}));
    await assert.rejects(prepareRuntime({ environment: { CEREMONY_MODE: 'development' }, files: {} }, {}));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
