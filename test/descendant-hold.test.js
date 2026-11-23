import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftedDescendant, MAX_DESCENDANT_NODES } from '../src/lib/ancestorHold.js';

// Build deps from a tree: `kids` maps a key to its child keys; `drifted` is the
// set of keys whose own content has drift. Children are never read from Jira here.
function deps({ kids = {}, drifted = new Set(), exempt = new Set(), unreadable = new Set() } = {}) {
  const issueOf = key => ({ id: String(key.replace(/\D/g, '') || key), key, fields: {} });
  return {
    childrenOf: async key => {
      if (unreadable.has(key)) throw Object.assign(new Error('unreadable'), { reason: 'SERVICE_UNAVAILABLE' });
      return (kids[key] ?? []).map(issueOf);
    },
    exempt: async issue => exempt.has(issue.key),
    ownDriftOf: async child => (drifted.has(child.key) ? [{ fieldId: 'assignee' }] : []),
  };
}

const root = { id: '1', key: 'VL-1', fields: {} };

test('a parent with no children is not held', async () => {
  assert.equal(await driftedDescendant(root, deps()), null);
});

test('an item being created (no key yet) has no children to hold it, and is never refused', async () => {
  const unreadable = deps({ unreadable: new Set(['undefined']) });
  assert.equal(await driftedDescendant({ id: '99', fields: {} }, unreadable), null);
});

test('a drifted child holds the parent at depth 1', async () => {
  const held = await driftedDescendant(root, deps({ kids: { 'VL-1': ['VL-2'] }, drifted: new Set(['VL-2']) }));
  assert.equal(held.issueKey, 'VL-2');
  assert.equal(held.depth, 1);
  assert.equal(held.changed[0].fieldId, 'assignee');
});

test('drift on a grandchild holds the parent at depth 2', async () => {
  const held = await driftedDescendant(root, deps({
    kids: { 'VL-1': ['VL-2'], 'VL-2': ['VL-3'] }, drifted: new Set(['VL-3']) }));
  assert.equal(held.issueKey, 'VL-3');
  assert.equal(held.depth, 2);
});

test('a clean tree is not held, and a cycle back to the parent is not walked forever', async () => {
  const result = await driftedDescendant(root, deps({ kids: { 'VL-1': ['VL-2'], 'VL-2': ['VL-1'] } }));
  assert.equal(result, null);
});

test('a test-management child is exempt and its subtree is not walked', async () => {
  const result = await driftedDescendant(root, deps({
    kids: { 'VL-1': ['VT-9'], 'VT-9': ['VL-5'] }, drifted: new Set(['VL-5']), exempt: new Set(['VT-9']) }));
  assert.equal(result, null);
});

test('an unreadable child fails closed by propagating the read error', async () => {
  await assert.rejects(
    driftedDescendant(root, deps({ kids: { 'VL-1': ['VL-2'] }, unreadable: new Set(['VL-2']) })),
    error => error.reason === 'SERVICE_UNAVAILABLE');
});

test('a tree over the node limit is refused, never assumed clean', async () => {
  const many = Array.from({ length: MAX_DESCENDANT_NODES + 1 }, (_, i) => `VL-${i + 2}`);
  await assert.rejects(
    driftedDescendant(root, deps({ kids: { 'VL-1': many } })),
    error => error.reason === 'DESCENDANT_LIMIT');
});

test('a tree deeper than maxDepth with children still unread is refused', async () => {
  await assert.rejects(
    driftedDescendant(root, deps({ kids: { 'VL-1': ['VL-2'], 'VL-2': ['VL-3'] } }), { maxDepth: 1 }),
    error => error.reason === 'DESCENDANT_LIMIT');
});
