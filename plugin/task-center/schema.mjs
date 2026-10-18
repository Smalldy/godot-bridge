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

/** Every status a task can be stored with. The phase machine is
 * pending -> running -> reviewing -> testing -> done, with blocked/cancelled as
 * exits. 'pending' means "not dispatched"; readiness is DERIVED from the
 * dependency graph, never stored. */
export const STATUSES = ['pending', 'running', 'reviewing', 'testing', 'done', 'blocked', 'cancelled']

/** Statuses that no longer occupy a worker or a file lock. */
export const CLOSED_STATUSES = ['done', 'cancelled']

/** How long a claimed task stays owned by a worker before the scheduler may
 * take it back. Any tool call by the assignee renews it, so this bounds a dead
 * or silent worker, not a slow one. */
export const TASK_LEASE_MS = 15 * 60 * 1000

/** Worktree layout. A task checkout may only live inside the project, exactly
 * like a lock path; `root` is INTERNAL configuration, not a toggle. Worktrees
 * are how every task runs, so there is no "enabled" flag to turn off. */
export const WORKTREE_DEFAULTS = { root: '.worktrees' }

/** Review-phase outcomes. 'pending' means the phase is open; the reviewer
 * either approves or asks for changes. */
export const REVIEW_STATUSES = ['pending', 'approved', 'changes-requested']

/** Test-phase outcomes. 'pending' means the phase is open. */
export const TEST_STATUSES = ['pending', 'passed', 'failed']


/** The three role kinds the host provisions, and the stage each one owns. */
export const ROLE_KINDS = ['worker', 'reviewer', 'tester']
export const WORKFLOW_STAGES = ['implement', 'review', 'test']
export const STAGE_ROLE = { implement: 'worker', review: 'reviewer', test: 'tester' }
export const ROLE_STAGE = { worker: 'implement', reviewer: 'review', tester: 'test' }
export const ROLE_DEFAULT_INSTANCES = { worker: 1, reviewer: 1, tester: 1 }
export const ROLE_INSTANCES_LIMITS = { min: 1, max: 8 }

/** A role that stays 'provisioning' this long is treated as dead and replaced. */
export const ROLE_PROVISION_TIMEOUT_MS = 5 * 60 * 1000

/** The project-level role profile file (optional; defaults apply when absent). */
export const ROLE_CONFIG_FILENAME = 'roles.json'
export const ROLE_CONFIG_VERSION = 1

function roleStringList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** One normalised role profile. Role kinds are fixed in this version. */
export function normaliseRoleProfile(raw, kind) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const stage = WORKFLOW_STAGES.indexOf(source.stage) >= 0 ? source.stage : ROLE_STAGE[kind]
  const fallback = ROLE_DEFAULT_INSTANCES[kind] === undefined ? 1 : ROLE_DEFAULT_INSTANCES[kind]
  const instances = Number.isFinite(source.instances)
    ? Math.min(ROLE_INSTANCES_LIMITS.max, Math.max(ROLE_INSTANCES_LIMITS.min, Math.floor(source.instances)))
    : fallback
  return { role: kind, stage: stage, instances: instances, skills: roleStringList(source.skills) }
}

/** The built-in profile set: one implement-stage worker, one reviewer, one tester. */
export function defaultRoleConfig() {
  const profiles = {}
  for (const kind of ROLE_KINDS) profiles[kind] = normaliseRoleProfile(null, kind)
  return {
    version: ROLE_CONFIG_VERSION,
    defaultProfile: 'worker',
    stages: Object.assign({}, STAGE_ROLE),
    profiles: profiles,
  }
}

/**
 * Normalise a project role config. A hand-written or partial file is repaired
 * member by member; a garbage file falls back to the defaults instead of
 * blocking dispatch. Stage bindings are derived from the profiles, so a profile
 * that names a known stage owns it.
 */
export function normaliseRoleConfig(raw) {
  const base = defaultRoleConfig()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const sourceProfiles = raw.profiles !== null && typeof raw.profiles === 'object' && !Array.isArray(raw.profiles) ? raw.profiles : {}
  const profiles = {}
  for (const kind of ROLE_KINDS) profiles[kind] = normaliseRoleProfile(sourceProfiles[kind], kind)
  const stages = {}
  for (const stage of WORKFLOW_STAGES) {
    const owner = ROLE_KINDS.filter((kind) => profiles[kind].stage === stage)[0]
    stages[stage] = owner === undefined ? STAGE_ROLE[stage] : owner
  }
  const requestedDefault = typeof raw.defaultProfile === 'string' ? raw.defaultProfile : ''
  const defaultProfile = ROLE_KINDS.indexOf(requestedDefault) >= 0 ? requestedDefault : base.defaultProfile
  return { version: ROLE_CONFIG_VERSION, defaultProfile: defaultProfile, stages: stages, profiles: profiles }
}

/** Project-level dispatch defaults. Persisted in the board so the toggle,
 * concurrency and spawn policy survive a restart. */
export const DISPATCH_DEFAULTS = {
  state: 'paused',
  maxConcurrent: 3,
  allowSpawn: true,
  maxWorkAgents: 4,
  maxAttempts: 3,
  request: null,
  worktree: { root: '.worktrees' },
}

/** Upper bounds for user-provided dispatch settings. */
export const DISPATCH_LIMITS = {
  maxConcurrent: { min: 1, max: 8 },
  maxWorkAgents: { min: 1, max: 12 },
  maxAttempts: { min: 1, max: 10 },
}

/** A normalised pending start request, or null. */
export function normaliseRequest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    by: typeof raw.by === 'string' ? raw.by : 'unknown',
    at: typeof raw.at === 'string' ? raw.at : null,
    note: typeof raw.note === 'string' ? raw.note : '',
  }
}

/**
 * A project-relative directory for task worktrees, as POSIX text.
 *
 * Anything absolute, escaping (`..`) or unusable falls back to the default:
 * normalisation must never make a board unreadable, and a root outside the
 * project would escape the sandbox every path check in the task center relies on.
 */
export function normaliseWorktreeRoot(raw) {
  const fallback = WORKTREE_DEFAULTS.root
  if (typeof raw !== 'string') return fallback
  const text = raw.trim()
  if (text === '' || text.indexOf('\u0000') >= 0) return fallback
  // POSIX-absolute, Windows drive-absolute or UNC: none is project-relative.
  if (text.startsWith('/') || text.startsWith('\\') || /^[a-zA-Z]:/.test(text)) return fallback
  const segments = []
  for (const segment of text.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return fallback
    segments.push(segment)
  }
  if (segments.length === 0) return fallback
  return segments.join('/')
}

/**
 * Normalised `dispatch.worktree`. Only the internal checkout root survives: an
 * old board's `enabled: false` is dropped, because dispatch now always creates
 * a worktree and refuses to run when it cannot.
 */
export function normaliseWorktree(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return { root: normaliseWorktreeRoot(source.root) }
}

function mergeStringList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

const phaseAttempt = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)

/**
 * A review-phase record, or null. A record needs a known status; garbage is
 * dropped (null) rather than made to look like a decision.
 */
export function normaliseReview(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (REVIEW_STATUSES.indexOf(raw.status) < 0) return null
  return {
    status: raw.status,
    by: typeof raw.by === 'string' ? raw.by : null,
    at: typeof raw.at === 'string' ? raw.at : null,
    reasons: typeof raw.reasons === 'string' ? raw.reasons : null,
    attempt: phaseAttempt(raw.attempt),
  }
}

/** A test-phase record, or null. Mirrors normaliseReview with evidence. */
export function normaliseTest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (TEST_STATUSES.indexOf(raw.status) < 0) return null
  return {
    status: raw.status,
    by: typeof raw.by === 'string' ? raw.by : null,
    at: typeof raw.at === 'string' ? raw.at : null,
    evidence: typeof raw.evidence === 'string' ? raw.evidence : null,
    attempt: phaseAttempt(raw.attempt),
  }
}

/**
 * A merge-request record, or null. Every member is optional so a hand-written
 * board survives; `conflict` keeps a boolean or a description, whichever a
 * future merger wrote, instead of silently dropping it.
 */
export function normaliseMerge(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    status: typeof raw.status === 'string' ? raw.status : null,
    base: typeof raw.base === 'string' ? raw.base : null,
    target: typeof raw.target === 'string' ? raw.target : null,
    head: typeof raw.head === 'string' ? raw.head : null,
    mergeCommit: typeof raw.mergeCommit === 'string' ? raw.mergeCommit : null,
    declaredFiles: mergeStringList(raw.declaredFiles),
    actualFiles: mergeStringList(raw.actualFiles),
    tests: typeof raw.tests === 'string' ? raw.tests : null,
    reviewer: typeof raw.reviewer === 'string' ? raw.reviewer : null,
    conflict: typeof raw.conflict === 'string' || typeof raw.conflict === 'boolean' ? raw.conflict : null,
    output: typeof raw.output === 'string' ? raw.output : null,
    at: typeof raw.at === 'string' ? raw.at : null,
  }
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
    request: normaliseRequest(source.request),
    worktree: normaliseWorktree(source.worktree),
  }
}
