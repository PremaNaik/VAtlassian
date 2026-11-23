import { executeQuery, limitClause } from '../lib/db.js';
import { throwing } from './store.js';

/**
 * Signed sprint operations (va_sprint_operation, migration v185) and the
 * baseline coverage read that sprint readiness needs.
 *
 * One row per signed start or completion. The row is written before Jira is
 * changed, so triggers/sprint-event.js can tell a signed start or close from
 * one made with Jira's own buttons.
 */

function decode(row) {
  if (!row) return null;
  let payload = null;
  try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = null; }
  return {
    operationId: row.operation_id, sprintId: String(row.sprint_id), boardId: row.board_id == null ? null : String(row.board_id),
    kind: row.kind, state: row.state, actorAccountId: row.actor_account_id, payload, error: row.error ?? null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  };
}

export async function insertOperation({ operationId, sprintId, boardId, kind, state, actorAccountId, payload, at }) {
  await throwing(
    `INSERT INTO va_sprint_operation
       (operation_id, sprint_id, board_id, kind, state, actor_account_id, payload, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [operationId, Number(sprintId), boardId == null || boardId === '' ? null : Number(boardId), kind, state,
      actorAccountId, JSON.stringify(payload ?? {}), at, at]
  );
}

export async function readOperation(operationId) {
  const rows = await throwing(
    `SELECT operation_id, sprint_id, board_id, kind, state, actor_account_id, payload, error, created_at, updated_at
       FROM va_sprint_operation WHERE operation_id = ? LIMIT 1`, [operationId]);
  return decode(rows[0]);
}

/** Move an operation to a new state; with `from`, only from that state (compare-and-swap). */
export async function updateOperation({ operationId, state, error = null, from = null, at }) {
  const sql = `UPDATE va_sprint_operation SET state = ?, error = ?, updated_at = ?
     WHERE operation_id = ?${from ? ' AND state = ?' : ''}`;
  const result = await executeQuery(sql, [state, error, at, operationId, ...(from ? [from] : [])]);
  if (!result.result) throw new Error('Sprint operation could not be updated.');
  return (result.data?.affectedRows ?? 0) > 0;
}

/** A signed operation of this kind for this sprint since `since`, that did not fail. */
export async function signedOperationSince({ sprintId, kind, since }) {
  const rows = await throwing(
    `SELECT operation_id, sprint_id, board_id, kind, state, actor_account_id, payload, error, created_at, updated_at
       FROM va_sprint_operation
      WHERE sprint_id = ? AND kind = ? AND state <> 'FAILED' AND created_at >= ?
      ORDER BY created_at DESC LIMIT ${limitClause(1)}`,
    [Number(sprintId), kind, since]);
  return decode(rows[0]);
}

/**
 * Which of these work items an active baseline covers: their own, or as a node
 * in an active tree baseline. One read for the whole sprint.
 */
export async function coveredIssueIds(issueIds) {
  const ids = [...new Set((issueIds ?? []).map(Number).filter(Number.isSafeInteger))];
  if (!ids.length) return new Set();
  const marks = ids.map(() => '?').join(', ');
  const rows = await throwing(
    `SELECT b.issue_id AS issue_id FROM va_baseline b WHERE b.state = 'ACTIVE' AND b.issue_id IN (${marks})
     UNION
     SELECT n.current_issue_id AS issue_id FROM va_baseline_node n
       JOIN va_baseline b ON b.baseline_id = n.baseline_id AND b.state = 'ACTIVE'
      WHERE n.current_issue_id IN (${marks})`,
    [...ids, ...ids]);
  return new Set(rows.map(r => Number(r.issue_id)));
}

export const SPRINT_MIGRATIONS = [
  { id: 'v185_sprint_operation', sql: `CREATE TABLE IF NOT EXISTS va_sprint_operation (
    operation_id CHAR(32) NOT NULL PRIMARY KEY,
    sprint_id BIGINT NOT NULL,
    board_id BIGINT NULL,
    kind VARCHAR(16) NOT NULL,
    state VARCHAR(16) NOT NULL,
    actor_account_id VARCHAR(128) NOT NULL,
    payload MEDIUMTEXT NULL,
    error VARCHAR(255) NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    KEY idx_va_sprint_operation_sprint (sprint_id, kind, created_at)
  )` }
];
