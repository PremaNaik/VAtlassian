import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSprint, collectTrees, nodeProblem, REASON, SPRINT_ROLE } from '../src/lib/sprintReadiness.js';
import { createSprintActions, completionHash, OPERATION_STATE, SPRINT_EVENT } from '../src/lib/sprintStart.js';
import { runSprintWorker } from '../src/jobs/sprintWorker.js';
import { run as sprintEvent } from '../src/triggers/sprint-event.js';
import { sprintWhere } from '../src/usecases/sprint.js';
import { sprintUnsignedAlert, ALERT_KIND } from '../src/lib/alerts.js';

const NOW = Date.parse('2026-11-21T06:00:00Z');
const OP_ID = 'a'.repeat(32);

/** A small world: sprint 7 on board 3 with A-1 (child A-2) and B-1. */
function world(over = {}) {
  const state = {
    sprint: { id: '7', name: 'Sprint 7', state: 'future', originBoardId: '3', endDate: '2026-12-05T00:00:00Z' },
    issues: [{ id: '101', key: 'A-1', summary: 'Parent', done: false }, { id: '201', key: 'B-1', summary: 'Other', done: false }],
    children: { 101: [{ id: '102', key: 'A-2', parentId: '101' }] },
    reviews: new Map([[101, { issue_id: 101, state: 'BASELINED', drift_count: 0, baseline_id: Buffer.from('ab', 'hex'), baseline_version: 2 }],
      [201, { issue_id: 201, state: 'BASELINED', drift_count: 0, baseline_id: Buffer.from('cd', 'hex'), baseline_version: 1 }]]),
    covered: new Set([101, 102, 201]),
    eligible: true,
    totp: { ok: true },
    ops: new Map(),
    audits: [],
    started: [],
    queued: [],
    auditFails: false,
    ...over
  };
  const deps = {
    now: () => NOW,
    newId: () => OP_ID,
    readSprint: async id => (String(id) === state.sprint.id ? state.sprint : null),
    sprintIssues: async () => state.issues,
    readChildren: async parents => parents.flatMap(p => state.children[p] ?? []),
    futureSprints: async () => [{ id: '8', name: 'Sprint 8' }],
    myself: async () => ({ displayName: 'Pat Signer' }),
    reviews: async () => state.reviews,
    covered: async () => state.covered,
    eligible: async () => state.eligible,
    verifyTotp: async () => state.totp,
    audit: async event => { if (state.auditFails) throw new Error('ledger down'); state.audits.push(event); return { seq: state.audits.length }; },
    tryAudit: async event => { state.audits.push(event); return { seq: state.audits.length }; },
    insertOperation: async row => { state.ops.set(row.operationId, { ...row }); },
    updateOperation: async ({ operationId, state: s, error }) => { const op = state.ops.get(operationId); if (op) Object.assign(op, { state: s, error }); return true; },
    readOperation: async id => state.ops.get(id) ?? null,
    startSprint: async (id, dates) => { if (state.jiraRefuses) throw Object.assign(new Error('no'), { status: 403 }); state.started.push({ id, ...dates }); },
    enqueueComplete: async body => { state.queued.push(body); }
  };
  return { state, deps, actions: createSprintActions(deps) };
}
const where = { accountId: 'acc-1', sprintId: '7', boardId: '3', projectId: '10000' };

test('a node is ready only when covered by an active baseline and free of undecided drift', () => {
  const covered = new Set([1]);
  assert.equal(nodeProblem(1, { reviews: new Map(), covered }), null);
  assert.equal(nodeProblem(2, { reviews: new Map(), covered }), REASON.NOT_BASELINED);
  assert.equal(nodeProblem(1, { reviews: new Map([[1, { state: 'DRIFTED' }]]), covered }), REASON.UNDECIDED_DRIFT);
  assert.equal(nodeProblem(1, { reviews: new Map([[1, { state: 'BASELINED', drift_count: 2 }]]), covered }), REASON.UNDECIDED_DRIFT);
  assert.equal(nodeProblem(1, { reviews: new Map([[1, { state: 'DECIDING' }]]), covered }), REASON.REVIEW_IN_PROGRESS);
  assert.equal(nodeProblem(1, { reviews: new Map([[1, { state: 'ERROR' }]]), covered }), REASON.REVIEW_ERROR);
});

test('an unbaselined child holds its parent, and the reason names the child', async () => {
  const items = [{ id: '101', key: 'A-1' }];
  const trees = await collectTrees(items, async parents => parents.includes('101') ? [{ id: '102', key: 'A-2', parentId: '101' }] : []);
  const result = assessSprint({ sprintId: 7, items, ...trees, reviews: new Map(), covered: new Set([101]) });
  assert.equal(result.ready, false);
  assert.deepEqual(result.items[0].reasons, [{ code: REASON.NOT_BASELINED, issueKey: 'A-2' }]);
});

test('a tree larger than the cap is not ready: an unread child could be the unbaselined one', async () => {
  const items = [{ id: '1', key: 'R-1' }];
  let n = 100;
  const trees = await collectTrees(items, async parents => parents.map(p => ({ id: String(n++), key: `C-${n}`, parentId: p })), { maxDepth: 2 });
  assert.ok(trees.truncated.has('1'));
  const covered = new Set([1, ...trees.descendants.get('1').map(Number)]);
  const result = assessSprint({ sprintId: 7, items, ...trees, reviews: new Map(), covered });
  assert.equal(result.ready, false);
  assert.equal(result.items[0].reasons[0].code, REASON.TREE_INCOMPLETE);
});

test('Check readiness reports and changes nothing', async () => {
  const { state, actions } = world();
  const r = await actions.readiness(where);
  assert.equal(r.success, true);
  assert.equal(r.assessment.ready, true);
  assert.equal(r.assessment.items.find(i => i.issueKey === 'A-1').treeSize, 2);
  assert.equal(r.canSign, true);
  assert.equal(r.role, SPRINT_ROLE);
  assert.equal(state.audits.length + state.started.length + state.ops.size, 0);
});

test('Sign and start sprint starts a ready sprint, with the ledger entry and signed row written first', async () => {
  const { state, actions } = world();
  const { assessment } = await actions.readiness(where);
  const r = await actions.start(where, { code: '123456', readinessHash: assessment.readinessHash });
  assert.equal(r.success, true, r.error);
  assert.equal(state.started.length, 1);
  assert.equal(state.started[0].endDate, '2026-12-05T00:00:00.000Z');
  assert.equal(state.audits[0].eventType, SPRINT_EVENT.START_SIGNED);
  assert.equal(state.audits[0].payload.printedName, 'Pat Signer');
  assert.deepEqual(state.audits[0].payload.items.map(i => i.key), ['A-1', 'B-1']);
  assert.equal(state.ops.get(OP_ID).state, OPERATION_STATE.DONE);
});

test('the sprint will not start while any tree has undecided drift, and nothing is signed', async () => {
  const { state, actions } = world();
  const { assessment } = await actions.readiness(where);
  state.reviews.set(201, { issue_id: 201, state: 'DRIFTED', drift_count: 1 });
  const r = await actions.start(where, { code: '123456', readinessHash: assessment.readinessHash });
  assert.equal(r.success, false);
  assert.equal(r.reason, 'NOT_READY');
  assert.equal(state.started.length + state.audits.length, 0);
});

test('a sprint that changed after readiness was checked refuses the signature', async () => {
  const { state, actions } = world();
  const { assessment } = await actions.readiness(where);
  state.issues = [...state.issues, { id: '301', key: 'C-1', done: false }];
  state.covered.add(301);
  const r = await actions.start(where, { code: '123456', readinessHash: assessment.readinessHash });
  assert.equal(r.reason, 'CONTENT_CHANGED');
  assert.equal(state.started.length, 0);
});

test('only a holder of the sprint role can sign, and a bad code signs nothing', async () => {
  const a = world({ eligible: false });
  const ha = (await a.actions.readiness(where)).assessment.readinessHash;
  assert.equal((await a.actions.start(where, { code: '1', readinessHash: ha })).reason, 'NOT_ELIGIBLE');
  const b = world({ totp: { ok: false, reason: 'CODE_INVALID_OR_REPLAYED', error: 'Invalid code' } });
  const hb = (await b.actions.readiness(where)).assessment.readinessHash;
  const r = await b.actions.start(where, { code: '000000', readinessHash: hb });
  assert.equal(r.reason, 'CODE_INVALID_OR_REPLAYED');
  assert.equal(b.state.started.length + b.state.audits.length, 0);
});

test('if the audit trail cannot be written, Jira is not changed', async () => {
  const { state, actions } = world({ auditFails: true });
  const h = (await actions.readiness(where)).assessment.readinessHash;
  const r = await actions.start(where, { code: '123456', readinessHash: h });
  assert.equal(r.reason, 'LEDGER_UNAVAILABLE');
  assert.equal(state.started.length, 0);
  assert.equal(state.ops.get(OP_ID).state, OPERATION_STATE.FAILED);
});

test('a Jira refusal after signing is recorded and reported, and the operation fails', async () => {
  const { state, actions } = world({ jiraRefuses: true });
  const h = (await actions.readiness(where)).assessment.readinessHash;
  const r = await actions.start(where, { code: '123456', readinessHash: h });
  assert.equal(r.reason, 'JIRA_REFUSED');
  assert.ok(state.audits.some(e => e.eventType === SPRINT_EVENT.START_FAILED));
  assert.equal(state.ops.get(OP_ID).state, OPERATION_STATE.FAILED);
});

test('a sprint from another board is refused', async () => {
  const { actions } = world();
  assert.equal((await actions.readiness({ ...where, boardId: '99' })).reason, 'WRONG_BOARD');
});

test('Sign and complete sprint signs the open items and destination, then queues the move and close', async () => {
  const { state, actions } = world();
  state.sprint = { ...state.sprint, state: 'active' };
  state.issues = [{ id: '101', key: 'A-1', done: false }, { id: '201', key: 'B-1', done: true }];
  const r0 = await actions.readiness(where);
  assert.equal(r0.openItems.length, 1);
  assert.equal(r0.doneCount, 1);
  const r = await actions.complete(where, { code: '123456', destination: { type: 'sprint', sprintId: '8' }, completionHash: r0.completionHash });
  assert.equal(r.success, true, r.error);
  assert.deepEqual(state.queued, [{ operationId: OP_ID }]);
  const signed = state.audits.find(e => e.eventType === SPRINT_EVENT.COMPLETE_SIGNED);
  assert.deepEqual(signed.payload.destination, { type: 'sprint', sprintId: '8', sprintName: 'Sprint 8' });
  assert.deepEqual(signed.payload.openItems, [{ id: '101', key: 'A-1' }]);
  assert.equal(state.ops.get(OP_ID).state, OPERATION_STATE.QUEUED);
});

test('completion refuses a destination that is not a future sprint of this board', async () => {
  const { state, actions } = world();
  state.sprint = { ...state.sprint, state: 'active' };
  const hash = completionHash({ sprintId: '7', openItems: state.issues });
  assert.equal((await actions.complete(where, { code: '1', destination: { type: 'sprint', sprintId: '55' }, completionHash: hash })).reason, 'BAD_DESTINATION');
  assert.equal((await actions.complete(where, { code: '1', destination: {}, completionHash: hash })).reason, 'BAD_DESTINATION');
});

function workerWorld(over = {}) {
  const state = {
    op: { operationId: OP_ID, sprintId: '7', kind: 'COMPLETE', state: 'QUEUED', actorAccountId: 'acc-1',
      payload: { openItems: [{ id: '101', key: 'A-1' }], destination: { type: 'backlog' } } },
    sprint: { id: '7', state: 'active' },
    issues: [{ id: '101', key: 'A-1', done: false }, { id: '201', key: 'B-1', done: true }],
    moved: [], closed: [], audits: [], ...over
  };
  const deps = {
    now: () => NOW,
    readOperation: async () => state.op,
    updateOperation: async ({ state: s, error }) => { Object.assign(state.op, { state: s, error }); return true; },
    readSprint: async () => state.sprint,
    sprintIssues: async () => state.issues,
    moveToSprint: async (id, keys) => { state.moved.push({ to: id, keys }); },
    moveToBacklog: async keys => { state.moved.push({ to: 'backlog', keys }); },
    closeSprint: async id => { state.closed.push(id); state.sprint.state = 'closed'; },
    tryAudit: async e => { state.audits.push(e); }
  };
  return { state, deps };
}

test('the worker moves the signed open items, closes the sprint, and is safe to redeliver', async () => {
  const { state, deps } = workerWorld();
  assert.equal((await runSprintWorker({ body: { operationId: OP_ID } }, deps)).outcome, 'DONE');
  assert.deepEqual(state.moved, [{ to: 'backlog', keys: ['A-1'] }]);
  assert.deepEqual(state.closed, ['7']);
  assert.ok(state.audits.some(e => e.eventType === SPRINT_EVENT.COMPLETED));
  assert.equal((await runSprintWorker({ body: { operationId: OP_ID } }, deps)).outcome, 'DONE');
  assert.equal(state.closed.length, 1);
});

test('the worker refuses to close a sprint that gained open items after signing', async () => {
  const { state, deps } = workerWorld();
  state.issues.push({ id: '301', key: 'C-1', done: false });
  const r = await runSprintWorker({ body: { operationId: OP_ID } }, deps);
  assert.equal(r.reason, 'SPRINT_CHANGED');
  assert.equal(state.moved.length + state.closed.length, 0);
  assert.equal(state.op.state, OPERATION_STATE.FAILED);
});

test('a sprint started with Jira\'s button is recorded and alerted; a signed one is not', async () => {
  const audits = []; const alerts = [];
  const deps = (signed) => ({ now: () => NOW, signedOperationSince: async () => signed,
    tryAudit: async e => audits.push(e), raise: async d => alerts.push(d) });
  const event = { eventType: 'avi:jira-software:started:sprint', sprint: { id: '7', name: 'Sprint 7', state: 'active' }, atlassianId: 'u-9' };
  assert.equal((await sprintEvent(event, deps({ operationId: OP_ID }))).outcome, 'SIGNED');
  assert.equal(audits.length + alerts.length, 0);
  assert.equal((await sprintEvent(event, deps(null))).outcome, 'UNSIGNED');
  assert.equal(audits[0].eventType, SPRINT_EVENT.STARTED_UNSIGNED);
  assert.equal(alerts[0].action, 'STARTED');
  const closed = await sprintEvent({ ...event, eventType: 'avi:jira-software:closed:sprint' }, deps(null));
  assert.equal(closed.outcome, 'UNSIGNED');
  assert.equal(audits[1].eventType, SPRINT_EVENT.CLOSED_UNSIGNED);
});

test('the bypass alert is deduplicated per sprint and action', () => {
  const a = sprintUnsignedAlert({ sprintId: '7', sprintName: 'Sprint 7', action: 'STARTED', actorAccountId: 'u-9', occurredAt: NOW });
  assert.equal(a.kind, ALERT_KIND.SPRINT_UNSIGNED);
  assert.equal(a.dedupeKey, 'SPRINT_UNSIGNED:7:STARTED');
  assert.match(a.title, /started without a VAtlassian signature/);
});

test('the sprint, board and project come from the Forge context, not the payload', () => {
  const w = sprintWhere({ accountId: 'me', extension: { sprint: { id: 7 }, board: { id: 3 }, project: { id: 10000 } } });
  assert.deepEqual(w, { accountId: 'me', sprintId: '7', boardId: '3', projectId: '10000' });
});
