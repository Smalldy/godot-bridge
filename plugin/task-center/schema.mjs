/**
 * Task center — shared schema constants.
 *
 * One place for the board version, the status vocabulary, the dispatch defaults
 * and the bounds. board.mjs validates against these and service.mjs moves tasks
 * between them, so a status that exists in one and not the other is impossible
 * to write.
 */

export const BOARD_DIRECTORY = '.agents'
export const BOARD_FILENAME = 'tasks.json'

/** Current board schema. A board with a HIGHER version is refused, never
 * downgraded: silently writing version 1 over a future file loses whatever the
 * future version added. */
export const BOARD_VERSION = 2

/** Refuse to load something this large. A task board is working state, not a
 * document; four megabytes means something went wrong long before this point. */
export const MAX_BOARD_BYTES = 4 * 1024 * 1024

/** Per-task history entries kept on disk (the creation entry plus the newest). */
export const MAX_HISTORY = 120

/** Every status a task can be stored with. 'pending' means "not dispatched";
 * readiness is DERIVED from the dependency graph, never stored. */
export const STATUSES = ['pending', 'running', 'review', 'done', 'blocked', 'cancelled']

/** Statuses that no longer occupy a worker or a file lock. */
export const CLOSED_STATUSES = ['done', 'cancelled']

/** How long a claimed task stays owned by a worker before the scheduler may
 * take it back. Any tool call by the assignee renews it, so this bounds a dead
 * or silent worker, not a slow one. */
export const TASK_LEASE_MS = 15 * 60 * 1000

/** Project-level dispatch defaults. Persisted in the board so the toggle,
 * concurrency and spawn policy survive a restart. */
export const DISPATCH_DEFAULTS = {
  state: 'paused',
  maxConcurrent: 3,
  allowSpawn: true,
  maxWorkAgents: 4,
  maxAttempts: 3,
}

/** Upper bounds for user-provided dispatch settings. */
export const DISPATCH_LIMITS = {
  maxConcurrent: { min: 1, max: 8 },
  maxWorkAgents: { min: 1, max: 12 },
  maxAttempts: { min: 1, max: 10 },
}

/** A fresh dispatch record with every field present. */
export function normaliseDispatch(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const state = source.state === 'running' ? 'running' : 'paused'
  const clamp = (value, limit, fallback) =>
    Number.isFinite(value) ? Math.min(limit.max, Math.max(limit.min, Math.floor(value))) : fallback
  return {
    state: state,
    since: typeof source.since === 'string' ? source.since : null,
    by: typeof source.by === 'string' ? source.by : null,
    maxConcurrent: clamp(source.maxConcurrent, DISPATCH_LIMITS.maxConcurrent, DISPATCH_DEFAULTS.maxConcurrent),
    allowSpawn: source.allowSpawn === undefined ? DISPATCH_DEFAULTS.allowSpawn : source.allowSpawn === true,
    maxWorkAgents: clamp(source.maxWorkAgents, DISPATCH_LIMITS.maxWorkAgents, DISPATCH_DEFAULTS.maxWorkAgents),
    maxAttempts: clamp(source.maxAttempts, DISPATCH_LIMITS.maxAttempts, DISPATCH_DEFAULTS.maxAttempts),
  }
}