/**
 * Detective control behind the signed sprint start and complete.
 *
 * Jira gives apps no veto on its own Start sprint and Complete sprint buttons.
 * The preventive control is permission: only the app's role holds "Manage
 * sprints". This trigger catches what that misses. For every started or
 * closed sprint it looks for a signed VAtlassian operation of the same kind
 * (db/sprintStore.js). A sprint started or closed without one is written to
 * the ledger and raised as an alert work item (lib/alerts.js).
 *
 * The signed operation row is written before the app asks Jira to start or
 * close the sprint, so the event Jira sends for the app's own change always
 * finds it.
 */
import { OPERATION_KIND, SPRINT_EVENT } from '../lib/sprintStart.js';

export const MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

const ACTION = {
  'avi:jira-software:started:sprint': { kind: OPERATION_KIND.START, action: 'STARTED', event: SPRINT_EVENT.STARTED_UNSIGNED },
  'avi:jira-software:closed:sprint': { kind: OPERATION_KIND.COMPLETE, action: 'CLOSED', event: SPRINT_EVENT.CLOSED_UNSIGNED }
};

async function defaultDeps() {
  const [store, ledger, alerts, alertStore] = await Promise.all([
    import('../db/sprintStore.js'), import('../db/store.js'), import('../lib/alerts.js'), import('../db/alertStore.js')
  ]);
  return {
    now: Date.now,
    signedOperationSince: store.signedOperationSince,
    tryAudit: ledger.tryAppend,
    raise: details => alertStore.enqueue(alerts.sprintUnsignedAlert(details))
  };
}

export async function run(event, suppliedDeps = null) {
  const what = ACTION[event?.eventType];
  const sprintId = event?.sprint?.id;
  if (!what || !/^\d+$/.test(String(sprintId ?? ''))) return { outcome: 'IGNORED' };
  const deps = suppliedDeps ?? await defaultDeps();
  const now = deps.now();
  const signed = await deps.signedOperationSince({ sprintId: String(sprintId), kind: what.kind, since: now - MATCH_WINDOW_MS });
  if (signed) return { outcome: 'SIGNED', operationId: signed.operationId };
  const actorAccountId = event?.atlassianId ?? 'system:jira';
  const details = { sprintId: String(sprintId), sprintName: event.sprint.name ?? null, action: what.action,
    actorAccountId: event?.atlassianId ?? null, occurredAt: now };
  await deps.tryAudit({ eventType: what.event, actorAccountId,
    payload: { sprintId: String(sprintId), sprintName: details.sprintName, originBoardId: event.sprint.originBoardId ?? null,
      state: event.sprint.state ?? null } });
  try { await deps.raise(details); }
  catch (error) { console.error('sprint-event: alert could not be queued', error?.message ?? error); }
  return { outcome: 'UNSIGNED' };
}
