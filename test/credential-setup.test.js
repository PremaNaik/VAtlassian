import test from 'node:test';
import assert from 'node:assert/strict';
import { createSetupUsecases } from '../src/usecases/credentialSetup.js';

const deps = (over = {}) => ({
  readTotp: async () => ({ state: 'ACTIVE', failed_attempts: 1 }),
  devices: async () => [{ credential_id: 'x' }],
  biometricLock: async () => ({ locked: false, attemptsRemaining: 3 }),
  ...over
});

test('signing setup reports both credentials for the signed-in person only', async () => {
  const seen = [];
  const api = createSetupUsecases(deps({ readTotp: async id => { seen.push(id); return { state: 'ACTIVE', failed_attempts: 1 }; } }));
  const r = await api.status({ context: { accountId: 'me' }, payload: { accountId: 'someone-else' } });
  assert.equal(r.success, true);
  assert.deepEqual(seen, ['me']);
  assert.equal(r.setup.totp.enrolled, true);
  assert.equal(r.setup.biometric.enrolled, true);
  assert.equal(r.setup.biometric.locked, false);
});

test('a locked biometric lock and a locked authenticator are both reported', async () => {
  const api = createSetupUsecases(deps({
    readTotp: async () => ({ state: 'LOCKED' }),
    devices: async () => [],
    biometricLock: async () => ({ locked: true, attemptsRemaining: 0 })
  }));
  const r = await api.status({ context: { accountId: 'me' } });
  assert.equal(r.setup.totp.locked, true);
  assert.equal(r.setup.biometric.enrolled, false);
  assert.equal(r.setup.biometric.locked, true);
});

test('no signed-in person and a storage failure both fail without throwing', async () => {
  assert.equal((await createSetupUsecases(deps()).status({ context: {} })).success, false);
  const broken = createSetupUsecases(deps({ devices: async () => { throw new Error('db down'); } }));
  assert.equal((await broken.status({ context: { accountId: 'me' } })).success, false);
});
