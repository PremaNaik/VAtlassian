/**
 * Finish a signed sprint completion from va-sprint-queue.
 *
 * lib/sprintStart.js#complete signs the completion, writes the ledger entry
 * and queues { operationId }. This worker moves the open work items to the
 * chosen future sprint or the backlog, then closes the sprint, as the app.
 *
 * The signature covered a specific set of open work items. If the sprint now
 * has open items that were not in that set, nothing is moved or closed: the
 * operation fails as SPRINT_CHANGED and has to be signed again. A redelivered
 * job is safe: moving an item already moved is harmless, and a sprint already
 * closed is not closed again.
 */
import { OPERATION_STATE, SPRINT_EVENT } from '../lib/sprintStart.js';

async function defaultDeps() {
  const [forge, sprintJira, store, ledger] = await Promise.all([
    import('@forge/api'), import('../lib/sprintJira.js'), import('../db/sprintStore.js'), import('../db/store.js')
  ]);
  const api = forge.default?.asApp ? forge.default : forge;
  const jira = sprintJira.createSprintJira({ api, route: forge.route });
  return {
    now: Date.now,
    readOperation: store.readOperation,
    updateOperation: store.updateOperation,
    readSprint: jira.readSprintAsApp,
    sprintIssues: id => jira.sprintIssues(id, { asApplication: true }),
    moveToSprint: jira.moveToSprint,
    moveToBacklog: jira.moveToBacklog,
    closeSprint: jira.closeSprint,
    tryAudit: ledger.tryAppend
  };
}

export async function runSprintWorker(eventOrBody, overrides = null) {
  const body = eventOrBody?.body ?? eventOrBody;
  const deps = overrides ?? await defaultDeps();
  const operationId = body?.operationId;
  if (typeof operationId !== 'string' || !/^[0-9a-f]{32}$/.test(operationId)) return { outcome: 'MALFORMED' };
  const op = await deps.readOperation(operationId);
  if (!op) return { outcome: 'NOT_FOUND' };
  if (op.state === OPERATION_STATE.DONE || op.state === OPERATION_STATE.FAILED) return { outcome: op.state };
  const at = () => deps.now();
  await deps.updateOperation({ operationId, state: OPERATION_STATE.RUNNING, at: at() });
  const fail = async (error, detail = {}) => {
    await deps.updateOperation({ operationId, state: OPERATION_STATE.FAILED, error, at: at() }).catch(() => {});
    await deps.tryAudit({ eventType: SPRINT_EVENT.COMPLETE_FAILED, actorAccountId: op.actorAccountId,
      payload: { operationId, sprintId: op.sprintId, reason: error, ...detail } });
    return { outcome: 'FAILED', reason: error };
  };
  try {
    const sprint = await deps.readSprint(op.sprintId);
    const signedOpen = new Map((op.payload?.openItems ?? []).map(i => [String(i.id), i.key]));
    const destination = op.payload?.destination ?? null;
    if (sprint?.state !== 'closed') {
      if (sprint?.state !== 'active') return fail('NOT_ACTIVE');
      const open = (await deps.sprintIssues(op.sprintId)).filter(i => !i.done);
      const unsigned = open.filter(i => !signedOpen.has(String(i.id)));
      if (unsigned.length) return fail('SPRINT_CHANGED', { unsignedOpenItems: unsigned.map(i => i.key).slice(0, 50) });
      const keys = open.map(i => i.key);
      if (keys.length) {
        if (destination?.type === 'sprint') await deps.moveToSprint(String(destination.sprintId), keys);
        else if (destination?.type === 'backlog') await deps.moveToBacklog(keys);
        else return fail('BAD_DESTINATION');
      }
      await deps.closeSprint(op.sprintId);
    }
    await deps.updateOperation({ operationId, state: OPERATION_STATE.DONE, at: at() });
    await deps.tryAudit({ eventType: SPRINT_EVENT.COMPLETED, actorAccountId: op.actorAccountId,
      payload: { operationId, sprintId: op.sprintId, moved: signedOpen.size, destination } });
    return { outcome: 'DONE' };
  } catch (error) {
    console.error('sprintWorker: completion failed', JSON.stringify({ operationId, status: error?.status ?? null }));
    return fail('JIRA_REFUSED', { status: error?.status ?? null });
  }
}

export async function handler(event) {
  return runSprintWorker(event);
}
