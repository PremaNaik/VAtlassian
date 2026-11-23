/**
 * approval:publish. A signed capturing transition records its signature in
 * approval:submit and publishes its baseline here, in a call of its own with its
 * own 25-second budget. The capture runs under the same lock and content check a
 * drift decision uses; then the signed row is activated and, unless the client
 * pre-authorised it, the exact Jira transition runs.
 *
 * `helpers` is { fail, actorId, failure } from usecases/approval.js, passed in
 * so the two modules do not import each other.
 */
import { harnessLog } from '../lib/harnessLogger.js';

export function createPublish(deps, { fail, actorId, failure }) {
/**
 * Publish the baseline of a signed capturing transition (approval:publish).
 * It runs the same capture as a drift decision would, under the same lock and
 * content check, then activates the signed row so the gate will accept it.
 * Only the signer can publish, and only a row still VOID from the submit.
 */
async function publish({ payload = {}, context }) {
  try {
    const accountId = actorId(context);
    const phase = step => harnessLog('APPROVAL', 'publish:phase', { step, approvalId: payload.approvalId ?? null, issueKey: payload.issueKey ?? null });
    phase('start');
    if (typeof payload.approvalId !== 'string' || !/^[a-f0-9]{32}$/.test(payload.approvalId)) fail('NO_DECISION');
    const row = await deps.byId(Buffer.from(payload.approvalId, 'hex'));
    phase('row-read');
    if (!row || row.account_id !== accountId || row.state !== 'VOID' || row.decision !== 'APPROVE'
        || Number(row.expires_at) <= deps.now()) fail('NO_DECISION');
    const issue = await deps.issue({ payload: { issueKey: payload.issueKey }, context });
    phase('issue-read');
    if (String(issue.issueId) !== String(row.issue_id)) fail('NOT_CONFIGURED');
    const actor = await deps.actor(accountId);
    phase('actor-read');
    // The content check inside apply() refuses any change made since the signature.
    const applied = await deps.apply({ issue, actor, approval: row, prepared: {}, context, policy: null,
      workflowTransition: null, preparedIsCurrent: false });
    phase('applied');
    if (applied?.success !== true) fail('SERVICE_UNAVAILABLE');
    // A workflow transition's signature waits for its Jira transition (PENDING); a
    // drift or first-baseline decision has none and is consumed here.
    const workflow = row.transition_id != null && row.baseline_id == null;
    if (!await deps.activate({ approvalId: row.approval_id, now: deps.now(), state: workflow ? 'PENDING' : 'CONSUMED' })) fail('SERVICE_UNAVAILABLE');
    const result = { success: true, approvalId: payload.approvalId, state: workflow ? 'PENDING' : 'CONSUMED', transitioned: false,
      baselinePublished: applied?.baselinePublished === true || applied?.capture?.captured === true, retryableApprovalId: null };
    // The same transition step submit used to run inline: unless the client
    // pre-authorised it (the transition screen), perform the exact transition now.
    if (workflow && payload.preauthorize !== true) {
      try { Object.assign(result, await deps.performTransition(issue, await deps.transition(issue, { transitionId: row.transition_id }), row)); }
      catch { result.transitionError = 'Approval recorded. Refresh the work item to check the transition result.'; }
      if (result.transitioned !== true) await deps.invalidate?.({ approvalId: row.approval_id, now: deps.now() });
    }
    result.state = (await deps.byId(row.approval_id))?.state ?? result.state;
    return result;
  } catch (error) { return failure(error); }
}


  return publish;
}
