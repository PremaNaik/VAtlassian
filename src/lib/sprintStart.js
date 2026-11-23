/**
 * Signed sprint start and signed sprint completion.
 *
 * "Sign and start sprint" starts a future sprint, signed, only when every
 * item's tree is ready (lib/sprintReadiness.js). "Sign and complete sprint"
 * closes a running sprint, signed: the open items move to a future sprint of
 * the same board or to the backlog, then the sprint closes. The move and close
 * run on va-sprint-queue (jobs/sprintWorker.js) because a large sprint can
 * outrun a resolver's time budget.
 *
 * Jira gives apps no veto on its own Start/Complete buttons. They are taken
 * away by granting "Manage sprints" only to the app's role; the app then acts
 * as itself. triggers/sprint-event.js is the detective control behind that:
 * a sprint started or closed without a matching signed operation is recorded
 * in the ledger and alerted.
 *
 * Rules, all checked on the server:
 *  - The sprint and board come from the Forge module context, never the payload.
 *  - The signer holds SPRINT_ROLE (va_eligibility, all work types) for the
 *    board's project.
 *  - The signature is an authenticator code (lib/approval/totpVerification.js).
 *  - Start: the server re-assesses readiness and the readiness hash must match
 *    what the signer was shown; otherwise CONTENT_CHANGED.
 *  - The ledger entry is written before Jira is changed. If it cannot be
 *    written, nothing happens (LEDGER_UNAVAILABLE).
 */
import { assessSprint, collectTrees, SPRINT_ROLE, MAX_SPRINT_ITEMS } from './sprintReadiness.js';
import { canonical, sha256Hex } from './hash.js';

export const OPERATION_KIND = Object.freeze({ START: 'START', COMPLETE: 'COMPLETE' });
export const OPERATION_STATE = Object.freeze({
  SIGNED: 'SIGNED', QUEUED: 'QUEUED', RUNNING: 'RUNNING', DONE: 'DONE', FAILED: 'FAILED'
});

export const SPRINT_EVENT = Object.freeze({
  START_SIGNED: 'SPRINT_START_SIGNED',
  STARTED: 'SPRINT_STARTED',
  START_FAILED: 'SPRINT_START_FAILED',
  COMPLETE_SIGNED: 'SPRINT_COMPLETE_SIGNED',
  COMPLETED: 'SPRINT_COMPLETED',
  COMPLETE_FAILED: 'SPRINT_COMPLETE_FAILED',
  STARTED_UNSIGNED: 'SPRINT_STARTED_UNSIGNED',
  CLOSED_UNSIGNED: 'SPRINT_CLOSED_UNSIGNED'
});

export const SPRINT_MEANING = Object.freeze({
  START: 'I confirm every work item in this sprint is baselined with no undecided changes, and I start the sprint.',
  COMPLETE: 'I complete this sprint and move its open work items as shown.'
});

const MESSAGE = {
  NO_SPRINT: 'Open this from a sprint on a board backlog.',
  SPRINT_UNREADABLE: 'The sprint could not be read. Refresh and try again.',
  WRONG_BOARD: 'This sprint belongs to another board. Open it from its own board.',
  NOT_FUTURE: 'Only a sprint that has not started can be started.',
  NOT_ACTIVE: 'Only a running sprint can be completed.',
  NOT_ELIGIBLE: `You do not hold the "${SPRINT_ROLE}" role for this project, so you cannot sign for this sprint.`,
  NOT_READY: 'Not every work item in this sprint is ready. Check readiness to see what is holding it.',
  EMPTY: 'This sprint has no work items.',
  TOO_LARGE: `This sprint has more than ${MAX_SPRINT_ITEMS} work items, more than can be checked in one signature.`,
  CONTENT_CHANGED: 'The sprint changed after you checked it. Check readiness again, then sign.',
  BAD_END_DATE: 'Choose an end date after today.',
  BAD_DESTINATION: 'Choose where the open work items go: the backlog or a future sprint of this board.',
  LEDGER_UNAVAILABLE: 'The audit trail could not be written, so nothing was changed. Try again.',
  JIRA_REFUSED: 'Jira refused the change. Check that the app\'s role holds "Manage sprints" on this board.',
  NOT_FOUND: 'That operation was not found.'
};

export function sprintFailure(reason, error = MESSAGE[reason]) {
  return { success: false, reason, error: error ?? 'The request could not be completed.' };
}

class SprintRefusal extends Error {
  constructor(reason, error) { super(error ?? MESSAGE[reason] ?? reason); this.reason = reason; }
}
const refuse = (reason, error) => { throw new SprintRefusal(reason, error); };

/** Hash of the open item set a completion signature covers (the destination is signed in the payload). */
export function completionHash({ sprintId, openItems }) {
  return sha256Hex(canonical({ kind: 'SPRINT_COMPLETION', sprintId: String(sprintId),
    open: openItems.map(i => String(i.id)).sort() }));
}

export function createSprintActions(deps) {
  const now = () => deps.now();

  async function sprintFor(where) {
    if (!where?.sprintId || !/^\d+$/.test(String(where.sprintId))) refuse('NO_SPRINT');
    const sprint = await deps.readSprint(String(where.sprintId));
    if (!sprint) refuse('SPRINT_UNREADABLE');
    if (where.boardId != null && sprint.originBoardId != null && String(sprint.originBoardId) !== String(where.boardId)) {
      refuse('WRONG_BOARD');
    }
    return sprint;
  }

  async function assess(sprintId) {
    const items = await deps.sprintIssues(String(sprintId));
    if (items.length > MAX_SPRINT_ITEMS) refuse('TOO_LARGE');
    const { descendants, keys, truncated } = await collectTrees(items, deps.readChildren);
    const ids = [...new Set([...items.map(i => Number(i.id)), ...[...descendants.values()].flat().map(Number)])];
    const [reviews, covered] = await Promise.all([deps.reviews(ids), deps.covered(ids)]);
    return { items, assessment: assessSprint({ sprintId, items, descendants, keys, truncated, reviews, covered }) };
  }

  async function eligible(where) {
    return deps.eligible({ accountId: where.accountId, projectId: where.projectId });
  }

  async function signer(where) {
    const me = await deps.myself().catch(() => null);
    return { accountId: where.accountId, displayName: me?.displayName ?? where.accountId };
  }

  /** "Check readiness": report only, nothing is changed. */
  async function readiness(where) {
    const sprint = await sprintFor(where);
    const canSign = await eligible(where);
    const base = { success: true, sprint: publicSprint(sprint), canSign, role: SPRINT_ROLE };
    if (sprint.state === 'future') {
      const { assessment } = await assess(sprint.id);
      return { ...base, assessment, meaning: SPRINT_MEANING.START };
    }
    if (sprint.state === 'active') {
      const items = await deps.sprintIssues(String(sprint.id));
      const openItems = items.filter(i => !i.done);
      const futureSprints = (await deps.futureSprints(String(where.boardId ?? sprint.originBoardId)))
        .filter(s => String(s.id) !== String(sprint.id));
      return { ...base, openItems: openItems.map(publicItem), doneCount: items.length - openItems.length,
        completionHash: completionHash({ sprintId: sprint.id, openItems }), futureSprints, meaning: SPRINT_MEANING.COMPLETE };
    }
    return base;
  }

  async function verify(where, code, purpose, sprintId) {
    const verified = await deps.verifyTotp(where.accountId, code, { purpose, sprintId: String(sprintId) });
    if (!verified?.ok) refuse(verified?.reason ?? 'CODE_INVALID_OR_REPLAYED', verified?.error ?? 'The authenticator code was not accepted.');
  }

  async function ledger(event) {
    try { return await deps.audit(event); }
    catch { refuse('LEDGER_UNAVAILABLE'); }
  }

  /** "Sign and start sprint". */
  async function start(where, { code, readinessHash, endDate } = {}) {
    const sprint = await sprintFor(where);
    if (sprint.state !== 'future') refuse('NOT_FUTURE');
    if (!await eligible(where)) refuse('NOT_ELIGIBLE');
    const end = Date.parse(endDate ?? sprint.endDate ?? '');
    if (!Number.isFinite(end) || end <= now()) refuse('BAD_END_DATE');
    const { assessment } = await assess(sprint.id);
    if (assessment.empty) refuse('EMPTY');
    if (!assessment.ready) refuse('NOT_READY');
    if (!readinessHash || readinessHash !== assessment.readinessHash) refuse('CONTENT_CHANGED');
    await verify(where, code, 'SPRINT_START', sprint.id);
    const who = await signer(where);
    const operationId = deps.newId();
    const startDate = new Date(now()).toISOString();
    const endIso = new Date(end).toISOString();
    const payload = { operationId, sprintId: String(sprint.id), sprintName: sprint.name ?? null,
      boardId: where.boardId == null ? null : String(where.boardId), projectId: where.projectId == null ? null : String(where.projectId),
      printedName: who.displayName, role: SPRINT_ROLE, meaning: SPRINT_MEANING.START, assuranceLevel: 'ESIGNATURE',
      readinessHash: assessment.readinessHash, startDate, endDate: endIso,
      items: assessment.items.map(i => ({ key: i.issueKey, baselineVersion: i.baselineVersion, treeSize: i.treeSize })) };
    // The signed operation row exists before Jira hears about the start, so the
    // sprint-started event it causes always finds it (triggers/sprint-event.js).
    await deps.insertOperation({ operationId, sprintId: String(sprint.id), boardId: payload.boardId,
      kind: OPERATION_KIND.START, state: OPERATION_STATE.SIGNED, actorAccountId: where.accountId, payload, at: now() });
    const proof = await ledger({ eventType: SPRINT_EVENT.START_SIGNED, actorAccountId: where.accountId, payload }).catch(async e => {
      await deps.updateOperation({ operationId, state: OPERATION_STATE.FAILED, error: 'LEDGER_UNAVAILABLE', at: now() }).catch(() => {});
      throw e;
    });
    try {
      await deps.startSprint(String(sprint.id), { startDate, endDate: endIso });
    } catch (error) {
      await deps.updateOperation({ operationId, state: OPERATION_STATE.FAILED, error: 'JIRA_REFUSED', at: now() }).catch(() => {});
      await deps.tryAudit({ eventType: SPRINT_EVENT.START_FAILED, actorAccountId: where.accountId,
        payload: { operationId, sprintId: String(sprint.id), status: error?.status ?? null } });
      refuse('JIRA_REFUSED');
    }
    await deps.updateOperation({ operationId, state: OPERATION_STATE.DONE, at: now() }).catch(() => {});
    await deps.tryAudit({ eventType: SPRINT_EVENT.STARTED, actorAccountId: where.accountId,
      payload: { operationId, sprintId: String(sprint.id), auditSeq: proof?.seq ?? null } });
    return { success: true, operationId, state: OPERATION_STATE.DONE, auditSeq: proof?.seq ?? null };
  }

  /** "Sign and complete sprint": signs, then queues the move and close. */
  async function complete(where, { code, destination, completionHash: shown } = {}) {
    const sprint = await sprintFor(where);
    if (sprint.state !== 'active') refuse('NOT_ACTIVE');
    if (!await eligible(where)) refuse('NOT_ELIGIBLE');
    const boardId = String(where.boardId ?? sprint.originBoardId ?? '');
    let target;
    if (destination?.type === 'backlog') target = { type: 'backlog' };
    else if (destination?.type === 'sprint' && /^\d+$/.test(String(destination.sprintId ?? ''))) {
      const future = await deps.futureSprints(boardId);
      const match = future.find(s => String(s.id) === String(destination.sprintId) && String(s.id) !== String(sprint.id));
      if (!match) refuse('BAD_DESTINATION');
      target = { type: 'sprint', sprintId: String(match.id), sprintName: match.name ?? null };
    } else refuse('BAD_DESTINATION');
    const items = await deps.sprintIssues(String(sprint.id));
    const openItems = items.filter(i => !i.done);
    const hash = completionHash({ sprintId: sprint.id, openItems });
    if (!shown || shown !== hash) refuse('CONTENT_CHANGED');
    await verify(where, code, 'SPRINT_COMPLETE', sprint.id);
    const who = await signer(where);
    const operationId = deps.newId();
    const payload = { operationId, sprintId: String(sprint.id), sprintName: sprint.name ?? null, boardId,
      projectId: where.projectId == null ? null : String(where.projectId), printedName: who.displayName,
      role: SPRINT_ROLE, meaning: SPRINT_MEANING.COMPLETE, assuranceLevel: 'ESIGNATURE', completionHash: hash,
      destination: target, openItems: openItems.map(i => ({ id: String(i.id), key: i.key })), doneCount: items.length - openItems.length };
    await deps.insertOperation({ operationId, sprintId: String(sprint.id), boardId, kind: OPERATION_KIND.COMPLETE,
      state: OPERATION_STATE.SIGNED, actorAccountId: where.accountId, payload, at: now() });
    const proof = await ledger({ eventType: SPRINT_EVENT.COMPLETE_SIGNED, actorAccountId: where.accountId, payload }).catch(async e => {
      await deps.updateOperation({ operationId, state: OPERATION_STATE.FAILED, error: 'LEDGER_UNAVAILABLE', at: now() }).catch(() => {});
      throw e;
    });
    await deps.updateOperation({ operationId, state: OPERATION_STATE.QUEUED, at: now() });
    await deps.enqueueComplete({ operationId });
    return { success: true, operationId, state: OPERATION_STATE.QUEUED, auditSeq: proof?.seq ?? null };
  }

  /** Progress of a signed operation, for the screen to poll. Only the signer's own sprint context. */
  async function operation(where, { operationId } = {}) {
    if (typeof operationId !== 'string' || !/^[0-9a-f]{32}$/.test(operationId)) refuse('NOT_FOUND');
    const op = await deps.readOperation(operationId);
    if (!op || String(op.sprintId) !== String(where.sprintId)) refuse('NOT_FOUND');
    return { success: true, operationId, kind: op.kind, state: op.state, error: op.error ? (MESSAGE[op.error] ?? op.error) : null };
  }

  const guard = fn => async (...args) => {
    try { return await fn(...args); }
    catch (error) {
      if (error instanceof SprintRefusal) return sprintFailure(error.reason, error.message);
      if (deps.needsUserConsent?.(error)) throw error;
      console.error('sprint: unhandled failure', error?.message ?? error);
      return sprintFailure('SERVICE_UNAVAILABLE', 'The sprint service could not complete this. Nothing was signed or changed.');
    }
  };

  return { readiness: guard(readiness), start: guard(start), complete: guard(complete), operation: guard(operation) };
}

function publicSprint(s) {
  return { id: String(s.id), name: s.name ?? '', state: s.state, goal: s.goal ?? '',
    startDate: s.startDate ?? null, endDate: s.endDate ?? null };
}
function publicItem(i) { return { id: String(i.id), key: i.key, summary: i.summary ?? '', status: i.status ?? '' }; }
