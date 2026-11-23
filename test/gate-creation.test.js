import test from 'node:test';
import assert from 'node:assert/strict';
import { createGate } from '../src/gate.js';

// Only the payload guard is exercised: a creation must pass, and an incomplete
// payload for an existing item must still be refused.
const gate = createGate({
  now: () => 1_760_000_000_000,
  log: () => {},
  audit: async () => {},
  load: async () => { throw new Error('load must not run for an incomplete payload'); },
  pending: async () => null
});

test('creating a work item passes the validator (no issue, no origin status)', async () => {
  const verdict = await gate({ transition: { to: { id: '10033' } } });
  assert.equal(verdict.result, true);
});

test('an incomplete payload for an existing item is still refused', async () => {
  const verdict = await gate({ issue: { key: 'VL-1' }, transition: { to: { id: '10033' } } });
  assert.equal(verdict.result, false);
});
