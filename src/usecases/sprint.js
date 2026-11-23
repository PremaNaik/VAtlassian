/**
 * Resolver-facing sprint usecases for the "Start Sprint" sprint action
 * (va-sprint-readiness). The logic is lib/sprintStart.js; this file builds its
 * production dependencies.
 *
 * Identity comes from context.accountId. The sprint, board and project come
 * from the Forge module context (context.extension), never from the payload.
 */
import { randomBytes } from 'node:crypto';
import { createSprintActions } from '../lib/sprintStart.js';
import { SPRINT_ROLE } from '../lib/sprintReadiness.js';

/** Where the request came from, as Forge reports it. */
export function sprintWhere(context) {
  const ext = context?.extension ?? {};
  return {
    accountId: context?.accountId ?? null,
    sprintId: ext.sprint?.id == null ? null : String(ext.sprint.id),
    boardId: ext.board?.id == null ? null : String(ext.board.id),
    projectId: ext.project?.id == null ? null : String(ext.project.id)
  };
}

export async function sprintRuntime() {
  const [forge, sprintJira, store, items, ledger, errors, eligibility, db, queue, totp] = await Promise.all([
    import('@forge/api'), import('../lib/sprintJira.js'), import('../db/sprintStore.js'), import('../db/itemStateStore.js'),
    import('../db/store.js'), import('../lib/errors.js'), import('../lib/eligibility.js'), import('../lib/db.js'),
    import('../lib/sprintQueue.js'), import('../lib/approval/totpVerification.js')
  ]);
  const api = forge.default?.asUser ? forge.default : forge;
  const jira = sprintJira.createSprintJira({ api, route: forge.route });
  const { append } = await import('../lib/ledger.js');
  return {
    now: Date.now,
    newId: () => randomBytes(16).toString('hex'),
    needsUserConsent: errors.needsUserConsent,
    readSprint: jira.readSprint,
    sprintIssues: id => jira.sprintIssues(id),
    readChildren: jira.readChildren,
    futureSprints: jira.futureSprints,
    myself: jira.myself,
    startSprint: jira.startSprint,
    reviews: async ids => new Map((await items.reviewsByIds(ids)).map(r => [Number(r.issue_id), r])),
    covered: store.coveredIssueIds,
    // A sprint has no work type, so only an all-work-types grant ('*') of the
    // sprint role counts, for the board's project or site-wide.
    eligible: async ({ accountId, projectId }) => {
      if (!accountId) return false;
      const result = await db.executeQuery(`SELECT 1 AS ok FROM va_eligibility WHERE ${eligibility.ELIGIBILITY_PREDICATE} LIMIT 1`,
        eligibility.eligibilityParams({ accountId, issueTypeId: '*', role: SPRINT_ROLE, state: 'ACTIVE', projectId }));
      if (!result.result) throw new Error('Eligibility could not be read.');
      return (result.data ?? []).length > 0;
    },
    verifyTotp: (accountId, code, options) => totp.verifyTotp(accountId, code, options),
    audit: event => append(ledger.auditStore, { eventId: ledger.newId(), ...event }),
    tryAudit: event => ledger.tryAppend(event),
    insertOperation: store.insertOperation,
    updateOperation: store.updateOperation,
    readOperation: store.readOperation,
    enqueueComplete: body => queue.enqueueSprintCompletion(body)
  };
}

async function actions() { return createSprintActions(await sprintRuntime()); }

export async function readiness({ context }) { return (await actions()).readiness(sprintWhere(context)); }
export async function start({ payload, context }) { return (await actions()).start(sprintWhere(context), payload ?? {}); }
export async function complete({ payload, context }) { return (await actions()).complete(sprintWhere(context), payload ?? {}); }
export async function operation({ payload, context }) { return (await actions()).operation(sprintWhere(context), payload ?? {}); }
