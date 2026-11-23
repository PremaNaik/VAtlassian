import { Queue } from '@forge/events';

/** va-sprint-queue: moves a signed completion's open items and closes the sprint (jobs/sprintWorker.js). */
export const SPRINT_QUEUE_KEY = 'va-sprint-queue';
const sprintQueue = new Queue({ key: SPRINT_QUEUE_KEY });

export function enqueueSprintCompletion({ operationId }, { queue = sprintQueue } = {}) {
  if (typeof operationId !== 'string' || !/^[0-9a-f]{32}$/.test(operationId)) throw new TypeError('operationId is required');
  return queue.push({ body: { operationId }, concurrency: { key: `sprint:${operationId}`, limit: 1 } });
}
