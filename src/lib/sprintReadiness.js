/**
 * Sprint readiness: can this sprint be started under signature?
 *
 * A sprint item is ready only when its whole tree is baselined and has no
 * undecided drift:
 *
 *  - the item and every descendant (Jira children, sub-tasks, and their
 *    children) is covered by an active baseline: its own, or a node in an
 *    active tree baseline (db/sprintStore.js#coveredIssueIds);
 *  - no node in that tree is DRIFTED, DECIDING, RESTORING or ERROR in
 *    va_item_state, and none carries an undecided drift count.
 *
 * A tree that could not be read in full (depth or size cap reached) is not
 * ready: an unread child might be the unbaselined one. Fail closed.
 *
 * "Check readiness" only reports. "Sign and start sprint" re-runs this on the
 * server at signing time and signs the readiness hash, so the signer attests
 * to exactly the item set and baseline versions they were shown
 * (lib/sprintStart.js).
 *
 * Everything here is pure; the reads are injected.
 */
import { canonical, sha256Hex } from './hash.js';

/** The VAtlassian role (Approver roles page) allowed to sign sprint start and completion. */
export const SPRINT_ROLE = 'Sprint owner';

export const MAX_TREE_DEPTH = 4;
export const MAX_TREE_NODES = 500;
export const MAX_SPRINT_ITEMS = 200;

export const REASON = Object.freeze({
  NOT_BASELINED: 'NOT_BASELINED',
  UNDECIDED_DRIFT: 'UNDECIDED_DRIFT',
  REVIEW_IN_PROGRESS: 'REVIEW_IN_PROGRESS',
  REVIEW_ERROR: 'REVIEW_ERROR',
  TREE_INCOMPLETE: 'TREE_INCOMPLETE'
});

export const REASON_TEXT = Object.freeze({
  [REASON.NOT_BASELINED]: 'has no active baseline',
  [REASON.UNDECIDED_DRIFT]: 'has changes since approval that are not decided',
  [REASON.REVIEW_IN_PROGRESS]: 'has a decision or restore in progress',
  [REASON.REVIEW_ERROR]: 'has a review that needs attention',
  [REASON.TREE_INCOMPLETE]: 'has more descendants than can be checked; split it or check it manually'
});

/** Why one node holds the sprint, or null when it does not. */
export function nodeProblem(issueId, { reviews, covered }) {
  const id = Number(issueId);
  const review = reviews.get(id) ?? null;
  if (review?.state === 'ERROR') return REASON.REVIEW_ERROR;
  if (review?.state === 'DECIDING' || review?.state === 'RESTORING') return REASON.REVIEW_IN_PROGRESS;
  if (review?.state === 'DRIFTED' || Number(review?.drift_count ?? 0) > 0) return REASON.UNDECIDED_DRIFT;
  if (!covered.has(id)) return REASON.NOT_BASELINED;
  return null;
}

/**
 * Walk each root's descendants breadth-first through readChildren(parentIds),
 * which returns [{ id, key, parentId }]. Bounded by depth and total nodes;
 * hitting either marks the affected roots truncated.
 */
export async function collectTrees(roots, readChildren, { maxDepth = MAX_TREE_DEPTH, maxNodes = MAX_TREE_NODES } = {}) {
  const rootOf = new Map(roots.map(r => [String(r.id), String(r.id)]));
  const keys = new Map(roots.map(r => [String(r.id), r.key]));
  const descendants = new Map(roots.map(r => [String(r.id), []]));
  const truncated = new Set();
  let frontier = roots.map(r => String(r.id));
  let total = roots.length;
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const children = await readChildren(frontier);
    const next = [];
    for (const child of children ?? []) {
      const id = String(child.id);
      const root = rootOf.get(String(child.parentId));
      if (!root || rootOf.has(id)) continue;
      if (depth > maxDepth || total >= maxNodes) { truncated.add(root); continue; }
      rootOf.set(id, root);
      keys.set(id, child.key);
      descendants.get(root).push(id);
      next.push(id);
      total += 1;
    }
    frontier = next;
  }
  return { descendants, keys, truncated };
}

/** Assess every sprint item. items: [{ id, key, summary }]. */
export function assessSprint({ sprintId, items, descendants, keys, truncated, reviews, covered }) {
  const assessed = items.map(item => {
    const id = String(item.id);
    const reasons = [];
    if (truncated.has(id)) reasons.push({ code: REASON.TREE_INCOMPLETE, issueKey: item.key });
    for (const nodeId of [id, ...(descendants.get(id) ?? [])]) {
      const code = nodeProblem(nodeId, { reviews, covered });
      if (code) reasons.push({ code, issueKey: keys.get(nodeId) ?? item.key });
    }
    const review = reviews.get(Number(id)) ?? null;
    return {
      issueId: id, issueKey: item.key, summary: item.summary ?? '',
      treeSize: 1 + (descendants.get(id)?.length ?? 0),
      baselineId: review?.baseline_id == null ? null
        : Buffer.isBuffer(review.baseline_id) ? review.baseline_id.toString('hex') : String(review.baseline_id),
      baselineVersion: review?.baseline_version == null ? null : Number(review.baseline_version),
      ready: reasons.length === 0, reasons
    };
  });
  const readyCount = assessed.filter(i => i.ready).length;
  return {
    sprintId: String(sprintId),
    ready: assessed.length > 0 && readyCount === assessed.length,
    empty: assessed.length === 0,
    readyCount, total: assessed.length,
    items: assessed,
    readinessHash: readinessHash(sprintId, assessed, descendants)
  };
}

/**
 * What a sprint-start signature covers: the sprint, every item and its tree
 * members, and each item's baseline version. Any change between "Check
 * readiness" and "Sign" changes this hash and refuses the signature.
 */
export function readinessHash(sprintId, assessed, descendants) {
  const items = assessed
    .map(i => ({ id: i.issueId, baselineId: i.baselineId, baselineVersion: i.baselineVersion,
      tree: [...(descendants.get(i.issueId) ?? [])].sort(), ready: i.ready }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256Hex(canonical({ kind: 'SPRINT_READINESS', sprintId: String(sprintId), items }));
}

/** Plain-language lines for the reasons on one item. */
export function describeReasons(item) {
  return item.reasons.map(r => `${r.issueKey} ${REASON_TEXT[r.code] ?? r.code}`);
}
