/**
 * Jira Software REST calls for sprint readiness, signed start and completion.
 *
 * Reads run as the user, so a person only checks sprints and work items they
 * can see. Writes (start, move, close) run as the app: Jira's "Manage sprints"
 * permission is meant to be held only by the app's role, which is what takes
 * Jira's own buttons away. Scopes: read:sprint:jira-software,
 * read:issue-details:jira, read:jql:jira, write:sprint:jira-software,
 * read:board-scope:jira-software, write:board-scope:jira-software.
 */
export const MOVE_BATCH = 50;

class JiraError extends Error {
  constructor(what, status) { super(`${what} failed (${status})`); this.status = status; }
}

async function ok(response, what) {
  if (!response?.ok) throw new JiraError(what, response?.status ?? 'no response');
  return response.status === 204 ? null : response.json().catch(() => null);
}

export function createSprintJira({ api, route }) {
  const asUser = () => api.asUser();
  const asApp = () => api.asApp();
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });

  async function readSprint(sprintId) {
    const s = await ok(await asUser().requestJira(route`/rest/agile/1.0/sprint/${sprintId}`), 'sprint read');
    return s ? { id: String(s.id), name: s.name, state: s.state, goal: s.goal ?? '', originBoardId: s.originBoardId ?? null,
      startDate: s.startDate ?? null, endDate: s.endDate ?? null } : null;
  }

  async function readSprintAsApp(sprintId) {
    const s = await ok(await asApp().requestJira(route`/rest/agile/1.0/sprint/${sprintId}`), 'sprint read');
    return s ? { id: String(s.id), name: s.name, state: s.state, originBoardId: s.originBoardId ?? null } : null;
  }

  /** Every work item in the sprint (sub-tasks included), paged. */
  async function sprintIssues(sprintId, { asApplication = false } = {}) {
    const out = [];
    for (let startAt = 0; ;) {
      const caller = asApplication ? asApp() : asUser();
      const page = await ok(await caller.requestJira(
        route`/rest/agile/1.0/sprint/${sprintId}/issue?startAt=${startAt}&maxResults=100&fields=summary,status,parent,issuetype`),
      'sprint issues read');
      for (const issue of page?.issues ?? []) {
        out.push({ id: String(issue.id), key: issue.key, summary: issue.fields?.summary ?? '',
          status: issue.fields?.status?.name ?? '', done: issue.fields?.status?.statusCategory?.key === 'done',
          parentId: issue.fields?.parent?.id ?? null });
      }
      const fetched = (page?.issues ?? []).length;
      startAt += fetched;
      if (!fetched || startAt >= Number(page?.total ?? 0) || out.length > 1000) break;
    }
    return out;
  }

  /** Direct children (any work type) of these parents, by JQL. */
  async function readChildren(parentIds) {
    const ids = [...new Set(parentIds.map(String).filter(id => /^\d+$/.test(id)))];
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      let nextPageToken = null;
      do {
        const body = { jql: `parent in (${ids.slice(i, i + 50).join(',')})`, fields: ['parent'], maxResults: 100,
          ...(nextPageToken ? { nextPageToken } : {}) };
        const page = await ok(await asUser().requestJira(route`/rest/api/3/search/jql`, json(body)), 'children read');
        for (const issue of page?.issues ?? []) out.push({ id: String(issue.id), key: issue.key, parentId: String(issue.fields?.parent?.id ?? '') });
        nextPageToken = page?.nextPageToken ?? null;
      } while (nextPageToken);
    }
    return out;
  }

  async function futureSprints(boardId) {
    if (!/^\d+$/.test(String(boardId ?? ''))) return [];
    const page = await ok(await asUser().requestJira(route`/rest/agile/1.0/board/${boardId}/sprint?state=future&maxResults=50`), 'board sprints read');
    return (page?.values ?? []).map(s => ({ id: String(s.id), name: s.name }));
  }

  async function myself() {
    return ok(await asUser().requestJira(route`/rest/api/3/myself`), 'user read');
  }

  async function startSprint(sprintId, { startDate, endDate }) {
    await ok(await asApp().requestJira(route`/rest/agile/1.0/sprint/${sprintId}`, json({ state: 'active', startDate, endDate })), 'sprint start');
  }

  async function closeSprint(sprintId) {
    await ok(await asApp().requestJira(route`/rest/agile/1.0/sprint/${sprintId}`, json({ state: 'closed' })), 'sprint close');
  }

  async function moveToSprint(sprintId, keys) {
    for (let i = 0; i < keys.length; i += MOVE_BATCH) {
      await ok(await asApp().requestJira(route`/rest/agile/1.0/sprint/${sprintId}/issue`, json({ issues: keys.slice(i, i + MOVE_BATCH) })), 'move to sprint');
    }
  }

  async function moveToBacklog(keys) {
    for (let i = 0; i < keys.length; i += MOVE_BATCH) {
      await ok(await asApp().requestJira(route`/rest/agile/1.0/backlog/issue`, json({ issues: keys.slice(i, i + MOVE_BATCH) })), 'move to backlog');
    }
  }

  return { readSprint, readSprintAsApp, sprintIssues, readChildren, futureSprints, myself, startSprint, closeSprint, moveToSprint, moveToBacklog };
}
