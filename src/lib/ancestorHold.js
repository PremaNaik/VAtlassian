import { baselineDrift, logLiveDrift } from './liveDrift.js';
import { fieldsForItem } from './tree/nodeFields.js';
import { canonicaliseIssue } from './attachmentIdentity.js';
import { FailClosed } from './errors.js';

export { ancestorDriftMessage, descendantDriftMessage } from './errors.js';

/**
 * The children of a work item, read as the app (a child the user cannot see
 * still holds its parent). Keys are Jira's own PROJ-123; anything else is
 * refused rather than interpolated. Any failed page throws FailClosed, and a
 * tree over MAX_DESCENDANT_NODES throws DESCENDANT_LIMIT. `api` and `route` are
 * the Forge api and route helpers.
 */
export async function childrenOfKey(api, route, key) {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(String(key))) throw new FailClosed('SERVICE_UNAVAILABLE');
  const children = [];
  let nextPageToken = null;
  do {
    const body = { jql: `parent = ${key}`, maxResults: 100, fields: ['*all'] };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const response = await api.asApp().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch(() => { throw new FailClosed('SERVICE_UNAVAILABLE'); });
    if (!response?.ok) throw new FailClosed('SERVICE_UNAVAILABLE');
    const data = await response.json();
    for (const issue of data.issues ?? []) children.push(await canonicaliseIssue(issue));
    if (children.length > MAX_DESCENDANT_NODES) throw Object.assign(new Error('descendant limit'), { reason: 'DESCENDANT_LIMIT' });
    nextPageToken = data.isLast ? null : (data.nextPageToken ?? null);
  } while (nextPageToken);
  return children;
}

/**
 * Check whether an ancestor's own tracked fields have drifted.
 *
 * The 2026-10-12 decision flags drift upward and holds transitions downward.
 * A drifted item appears for review on every ancestor, but does not hold those
 * ancestors. It holds itself and its descendants. Siblings and linked issues
 * are outside that descendant set.
 *
 * Walk Jira's parent field upward. Compare each ancestor's own tracked fields
 * through lib/liveDrift.js, as its validator does. An ancestor merely flagged
 * because of another child's drift does not itself hold descendants.
 *
 * Failed reads throw so the validator can refuse the transition.
 *
 * deps supplies readIssue(key), returning a canonicalised issue with fields=*all,
 * and projectConfig, activeBaseline, activeRootsForNode, controlledFields and
 * rootNodeDigests.
 */
export const MAX_ANCESTOR_DEPTH = 8;

export async function driftedAncestor(issue, deps, { maxDepth = MAX_ANCESTOR_DEPTH, surface = 'ancestor' } = {}) {
  // A test-management issue was never signed through its parent: it sits
  // outside the parent's governed tree (testmgmt/treeExclusion.js), so the
  // parent's drift does not hold it. `exempt` is absent in older callers, and
  // asked only when there is a parent to be held by.
  let parent = issue?.fields?.parent ?? null;
  if (!parent?.key) return null;
  if (deps.exempt && await deps.exempt(issue)) return null;
  const seen = new Set([String(issue?.id)]);
  for (let depth = 1; parent?.key && depth <= maxDepth; depth += 1) {
    const ancestor = await deps.readIssue(parent.key);
    if (!ancestor?.id || seen.has(String(ancestor.id))) return null;
    seen.add(String(ancestor.id));
    const changed = await ownDrift(ancestor, deps, surface);
    if (changed.length > 0) {
      return { issueId: Number(ancestor.id), issueKey: ancestor.key, depth, changed: changed.slice(0, 40) };
    }
    parent = ancestor.fields?.parent ?? null;
  }
  return null;
}

/**
 * The fields of THIS work item that differ from its active baseline, judged
 * exactly as the validator judges it (lib/liveDrift.js): its own content only,
 * never its children's. [] for no baseline or a project switched off.
 */
export async function ownDrift(issue, deps, surface = 'own') {
  const issueId = Number(issue.id);
  const projectId = Number(issue.fields.project.id);
  const issueTypeId = String(issue.fields.issuetype.id);
  const [config, baseline] = await Promise.all([deps.projectConfig(projectId), deps.activeBaseline(issueId)]);
  // A project switched off in VAtlassian holds nothing for drift (gate.js).
  if (!baseline || config?.enabled === false) return [];
  const declared = await fieldsForItem({ issueId, projectId, issueTypeId },
    { activeRootsForNode: deps.activeRootsForNode, controlledFields: deps.controlledFields });
  const comparison = await baselineDrift({ baseline, issueId, issueFields: issue.fields, declared,
    readRootDigests: deps.rootNodeDigests });
  logLiveDrift(surface, { issueKey: issue.key, issueTypeId, comparison });
  return comparison.changed ?? [];
}

/**
 * The reverse hold: a work item cannot move while anything below it has
 * undecided drift of its own. The 2026-11-22 decision holds the parent when a
 * child has drift, so the whole chain above a changed item waits for its review.
 *
 * Walk Jira's children breadth-first to maxDepth. Each child is judged by its
 * own tracked fields (ownDrift), never by its ancestors. Test-management items
 * are exempt, as in driftedAncestor. Returns the first drifted descendant, or
 * null when none has drift.
 *
 * Fails closed: a read that throws propagates, and a tree larger than maxNodes,
 * or deeper than maxDepth with children still unread, throws DESCENDANT_LIMIT.
 * Nothing below the limit is ever assumed clean.
 *
 * deps supplies childrenOf(key) (canonicalised issues with fields=*all) and the
 * same deps as ownDrift. ownDriftOf(child) may replace ownDrift in tests.
 */
export const MAX_DESCENDANT_NODES = 200;

export async function driftedDescendant(issue, deps, { maxDepth = MAX_ANCESTOR_DEPTH, maxNodes = MAX_DESCENDANT_NODES, surface = 'descendant' } = {}) {
  // A work item being created has no key yet and therefore no children; there is
  // nothing below it to hold it. Without this, creating any item was refused as
  // "signature service could not be reached".
  if (!issue?.key) return null;
  const ownDriftOf = deps.ownDriftOf ?? (child => ownDrift(child, deps, surface));
  const seen = new Set([String(issue?.id)]);
  let frontier = [issue];
  let visited = 0;
  // One level at a time, with every read in the level in parallel. A Forge
  // function has 25 seconds; reading children one after another timed out a
  // signing challenge on a parent with several children (2026-11-22).
  for (let depth = 1; frontier.length > 0 && depth <= maxDepth; depth += 1) {
    const lists = await Promise.all(frontier.map(parent => deps.childrenOf(parent.key)));
    const level = [];
    for (const list of lists) {
      for (const child of list) {
        const id = String(child.id);
        if (seen.has(id)) continue;
        seen.add(id);
        visited += 1;
        if (visited > maxNodes) throw Object.assign(new Error('descendant limit'), { reason: 'DESCENDANT_LIMIT' });
        level.push(child);
      }
    }
    const judged = await Promise.all(level.map(async child => {
      if (deps.exempt && await deps.exempt(child)) return { child, exempt: true, changed: [] };
      return { child, exempt: false, changed: await ownDriftOf(child) };
    }));
    // The first drifted child in listing order wins, as the sequential walk did.
    const drifted = judged.find(entry => !entry.exempt && entry.changed.length > 0);
    if (drifted) {
      return { issueId: Number(drifted.child.id), issueKey: drifted.child.key, depth, changed: drifted.changed.slice(0, 40) };
    }
    frontier = judged.filter(entry => !entry.exempt).map(entry => entry.child);
  }
  if (frontier.length > 0) throw Object.assign(new Error('descendant depth'), { reason: 'DESCENDANT_LIMIT' });
  return null;
}

/**
 * The same reads as the viewer, for the surfaces that only display a hold (the
 * panel and the transition-screen field). They are never the authority: the
 * validator and the signing path read for themselves (lib/approval/runtime.js).
 */
export async function viewerAncestorDeps() {
  const [forge, config, baselines, trees, identity] = await Promise.all([import('@forge/api'),
    import('../db/configStore.js'), import('../db/baselineStore.js'), import('../db/baselineTreeStore.js'),
    import('./attachmentIdentity.js')]);
  const api = forge.default?.asUser ? forge.default : forge;
  const readIssue = async key => {
    const response = await api.asUser().requestJira(forge.route`/rest/api/3/issue/${key}?fields=*all`);
    if (!response?.ok) throw new Error(`ancestor ${key} unreadable (${response?.status})`);
    return identity.canonicaliseIssue(await response.json());
  };
  const { testManagementRole } = await import('../testmgmt/treeExclusion.js');
  return { readIssue, childrenOf: key => childrenOfKey(api, forge.route, key),
    projectConfig: config.projectConfig, activeBaseline: baselines.activeBaseline,
    activeRootsForNode: trees.activeRootsForNode, controlledFields: config.controlledFields,
    rootNodeDigests: trees.rootNodeDigests, exempt: async issue => !!(await testManagementRole(issue)) };
}
