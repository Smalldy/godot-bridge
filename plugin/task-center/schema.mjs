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
/** How a provisioned role instance starts: a fresh context (default) or a fork
 * of the Lead's context. */
export const ROLE_CONTEXTS = ['fresh', 'fork']
/** The permissions a profile may declare; they gate what the brief allows. */
export const ROLE_PERMISSIONS = ['read-only', 'implement', 'review', 'test', 'merge', 'admin']
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,40}$/
export const ROLE_PROMPT_MAX = 4000

/**
 * The variables a role prompt template may inject. The catalog is ONE list used
 * three ways: validateRoleProfile refuses a template that mentions anything else,
 * the brief builders substitute these tokens with the real task values, and the
 * panel renders them as the variable legend. Keeping it here is what stops the
 * editor, the validator and the brief from drifting apart.
 */
export const ROLE_TEMPLATE_VARIABLES = [
  { name: 'TASK_ID', description: 'The id of the task this instance is dispatched for.', sample: 'T-36' },
  { name: 'TASK_TITLE', description: 'The task title.', sample: 'Role context template editor' },
  { name: 'SPEC', description: 'The task spec: what the task involves.', sample: 'Replace the read-only preview with an editor.' },
  { name: 'COMPLETIONS_DEF', description: 'The task acceptance criteria: how completion is judged.', sample: 'Every suite passes.' },
  { name: 'GIT_INFO', description: 'The task checkout: branch, worktree, base and head commit.', sample: 'branch task/T-36-1 · worktree <path> · base db548b4 · commit abc1234' },
  { name: 'PROJECT', description: 'The project directory the board lives in.', sample: 'J:\\project' },
  { name: 'LEAD', description: 'The Team Lead this instance reports to.', sample: 'lead' },
  { name: 'ROLE', description: 'The role kind: worker, reviewer or tester.', sample: 'worker' },
  { name: 'STAGE', description: 'The workflow stage this role owns.', sample: 'implement' },
]

/** Every allowed variable name, in catalog order. */
export const ROLE_TEMPLATE_VARIABLE_NAMES = ROLE_TEMPLATE_VARIABLES.map((entry) => entry.name)

/** A {{NAME}} token. Unknown names are reported, never silently ignored. */
const ROLE_TEMPLATE_TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g

/** Every {{NAME}} a template mentions, in order, deduplicated. */
export function roleTemplateVariables(template) {
  const text = typeof template === 'string' ? template : ''
  const found = []
  const pattern = new RegExp(ROLE_TEMPLATE_TOKEN.source, 'g')
  let match = pattern.exec(text)
  while (match !== null) {
    if (found.indexOf(match[1]) < 0) found.push(match[1])
    match = pattern.exec(text)
  }
  return found
}

/** The variables a template mentions that are NOT in the catalog. */
export function unknownRoleTemplateVariables(template) {
  return roleTemplateVariables(template).filter((name) => ROLE_TEMPLATE_VARIABLE_NAMES.indexOf(name) < 0)
}

/**
 * Substitute the known {{NAME}} tokens of a template with their values. An
 * unknown token is left LITERAL: a hand-written roles.json must never be made
 * unreadable by a stray token, and the save path is where unknowns are refused.
 */
export function renderRoleTemplate(template, values) {
  const text = typeof template === 'string' ? template : ''
  const table = values !== null && values !== undefined && typeof values === 'object' ? values : {}
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, function (whole, name) {
    if (!Object.prototype.hasOwnProperty.call(table, name)) return whole
    const value = table[name]
    return String(value === undefined || value === null ? '' : value)
  })
}

/** The allowed variables as a readable {{A}}, {{B}} list, for an error message. */
export function roleTemplateVariableList() {
  return ROLE_TEMPLATE_VARIABLE_NAMES.map((name) => '{{' + name + '}}').join(', ')
}

/** A role that stays 'provisioning' this long is treated as dead and replaced. */
export const ROLE_PROVISION_TIMEOUT_MS = 5 * 60 * 1000

/** The test phase has two bounds, like the review phase: a reminder after
 * TEST_REMINDER_MS and a hard block after TEST_TIMEOUT_MS without a verdict.
 * Both are overridable through the host options (dispatcher/API) for tests. */
export const TEST_REMINDER_MS = 10 * 60 * 1000
export const TEST_TIMEOUT_MS = 20 * 60 * 1000

/** The host bounds one async action (candidate build / candidate merge / merge
 * request / role provisioning / notification) so a stuck await cannot hold the
 * action or the serialised merge queue forever. */
export const HOST_ACTION_TIMEOUT_MS = 2 * 60 * 1000

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

/** One normalised role profile. A profile names one of the fixed role kinds;
 * its stage is that kind's stage, and it may carry a context, permissions and a
 * custom prompt. Malformed members fall back instead of throwing. */
export function normaliseRoleProfile(raw, kind, name) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const stage = ROLE_STAGE[kind]
  const fallback = ROLE_DEFAULT_INSTANCES[kind] === undefined ? 1 : ROLE_DEFAULT_INSTANCES[kind]
  const requestedInstances = source.instances !== undefined ? source.instances : source.concurrency
  const instances = Number.isFinite(requestedInstances)
    ? Math.min(ROLE_INSTANCES_LIMITS.max, Math.max(ROLE_INSTANCES_LIMITS.min, Math.floor(requestedInstances)))
    : fallback
  const context = ROLE_CONTEXTS.indexOf(source.context) >= 0 ? source.context : 'fresh'
  const permissions = roleStringList(source.permissions).filter((entry) => ROLE_PERMISSIONS.indexOf(entry) >= 0)
  const prompt = typeof source.prompt === 'string' ? source.prompt.trim().slice(0, ROLE_PROMPT_MAX) : ''
  return {
    name: typeof name === 'string' && name !== '' ? name : kind,
    role: kind,
    stage: stage,
    instances: instances,
    skills: roleStringList(source.skills),
    context: context,
    permissions: permissions,
    prompt: prompt,
  }
}

/** The built-in profile set: one implement-stage worker, one reviewer, one tester. */
export function defaultRoleConfig() {
  const profiles = {}
  for (const kind of ROLE_KINDS) profiles[kind] = normaliseRoleProfile(null, kind, kind)
  return {
    version: ROLE_CONFIG_VERSION,
    defaultProfile: 'worker',
    stages: Object.assign({}, STAGE_ROLE),
    profiles: profiles,
  }
}

/** The profile bound to a kind's stage (a custom profile may replace the default
 * without changing which kind owns the stage). Never throws. */
export function profileForKind(config, kind) {
  const stage = ROLE_STAGE[kind]
  const bound = config !== null && config !== undefined && config.stages !== null && config.stages !== undefined ? config.stages[stage] : null
  if (typeof bound === 'string' && config.profiles !== null && config.profiles !== undefined && config.profiles[bound] !== undefined) {
    const profile = config.profiles[bound]
    if (profile.stage === stage) return profile
  }
  if (config !== null && config !== undefined && config.profiles !== null && config.profiles !== undefined && config.profiles[kind] !== undefined) {
    return config.profiles[kind]
  }
  return defaultRoleConfig().profiles[kind]
}

/**
 * Validate one role profile submitted through the API. Unlike the forgiving
 * normaliser, this REFUSES bad input: a name, a known kind, the kind's stage,
 * bounded instances, string skills, a known context, allowed permissions and a
 * bounded prompt (whose {{VARIABLES}} must exist in ROLE_TEMPLATE_VARIABLES).
 * Returns { ok, profile } or { ok: false, code, message }.
 */
export function validateRoleProfile(name, raw) {
  if (typeof name !== 'string' || !ROLE_NAME_PATTERN.test(name)) {
    return { ok: false, code: 'invalid-role-name', message: 'a role profile name must match ' + String(ROLE_NAME_PATTERN) }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'invalid-role-profile', message: 'the profile body must be a JSON object' }
  }
  const kind = raw.role !== undefined ? raw.role : raw.kind
  if (ROLE_KINDS.indexOf(kind) < 0) {
    return { ok: false, code: 'invalid-role-kind', message: 'role must be one of ' + ROLE_KINDS.join(', ') }
  }
  if (raw.stage !== undefined && raw.stage !== ROLE_STAGE[kind]) {
    return { ok: false, code: 'invalid-role-stage', message: 'a ' + kind + ' profile owns the ' + ROLE_STAGE[kind] + ' stage' }
  }
  const requestedInstances = raw.instances !== undefined ? raw.instances : raw.concurrency
  if (requestedInstances !== undefined) {
    if (!Number.isInteger(requestedInstances) || requestedInstances < ROLE_INSTANCES_LIMITS.min || requestedInstances > ROLE_INSTANCES_LIMITS.max) {
      return { ok: false, code: 'invalid-role-instances', message: 'instances must be an integer between ' + String(ROLE_INSTANCES_LIMITS.min) + ' and ' + String(ROLE_INSTANCES_LIMITS.max) }
    }
  }
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills) || raw.skills.some((entry) => typeof entry !== 'string')) {
      return { ok: false, code: 'invalid-role-skills', message: 'skills must be an array of strings' }
    }
  }
  if (raw.context !== undefined && ROLE_CONTEXTS.indexOf(raw.context) < 0) {
    return { ok: false, code: 'invalid-role-context', message: 'context must be one of ' + ROLE_CONTEXTS.join(', ') }
  }
  if (raw.permissions !== undefined) {
    if (!Array.isArray(raw.permissions) || raw.permissions.some((entry) => ROLE_PERMISSIONS.indexOf(entry) < 0)) {
      return { ok: false, code: 'invalid-role-permissions', message: 'permissions must be a subset of ' + ROLE_PERMISSIONS.join(', ') }
    }
  }
  if (raw.prompt !== undefined && (typeof raw.prompt !== 'string' || raw.prompt.length > ROLE_PROMPT_MAX)) {
    return { ok: false, code: 'invalid-role-prompt', message: 'prompt must be a string of at most ' + String(ROLE_PROMPT_MAX) + ' characters' }
  }
  // A template may only inject variables the host can fill. An unknown {{NAME}}
  // is a typo that would otherwise reach the agent as literal text, so the save
  // is refused with the allowed list. A blank template is legal.
  if (typeof raw.prompt === 'string') {
    const unknown = unknownRoleTemplateVariables(raw.prompt)
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'invalid-role-variable',
        message:
          'unknown template variable' + (unknown.length === 1 ? '' : 's') + ' ' +
          unknown.map((token) => '{{' + token + '}}').join(', ') +
          '; allowed variables are ' + roleTemplateVariableList(),
        variables: ROLE_TEMPLATE_VARIABLE_NAMES.slice(),
        unknown: unknown,
      }
    }
  }
  return { ok: true, profile: normaliseRoleProfile(raw, kind, name) }
}

/** Validate a stage binding: the stage exists and the named profile owns it. */
export function validateRoleBinding(config, stage, name) {
  if (WORKFLOW_STAGES.indexOf(stage) < 0) {
    return { ok: false, code: 'invalid-stage', message: 'stage must be one of ' + WORKFLOW_STAGES.join(', ') }
  }
  if (typeof name !== 'string' || name === '' || config === null || config === undefined || config.profiles === null || config.profiles === undefined || config.profiles[name] === undefined) {
    return { ok: false, code: 'unknown-role-profile', message: 'no role profile named ' + String(name) }
  }
  const profile = config.profiles[name]
  if (profile.stage !== stage) {
    return { ok: false, code: 'stage-mismatch', message: name + ' owns the ' + profile.stage + ' stage, not ' + stage }
  }
  return { ok: true, profile: profile }
}

/**
 * Normalise a project role config. A hand-written or partial file is repaired
 * member by member; a garbage file falls back to the defaults instead of
 * blocking dispatch.
 *
 * The default worker/reviewer/tester profiles always exist. Additional profiles
 * may be declared with a known role kind; a profile whose name/kind is invalid
 * is dropped. Stage bindings come from the file when they point at an existing
 * profile owning that stage; otherwise the kind's own profile (or the built-in
 * stage owner) is used.
 */
export function normaliseRoleConfig(raw) {
  const base = defaultRoleConfig()
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return base
  const sourceProfiles = raw.profiles !== null && typeof raw.profiles === 'object' && !Array.isArray(raw.profiles) ? raw.profiles : {}
  const profiles = {}
  for (const kind of ROLE_KINDS) profiles[kind] = normaliseRoleProfile(sourceProfiles[kind], kind, kind)
  for (const name of Object.keys(sourceProfiles)) {
    if (ROLE_KINDS.indexOf(name) >= 0) continue
    if (!ROLE_NAME_PATTERN.test(name)) continue
    const candidate = sourceProfiles[name]
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const requested = candidate.role !== undefined ? candidate.role : candidate.kind
    const kind = ROLE_KINDS.indexOf(requested) >= 0 ? requested : null
    if (kind === null) continue
    profiles[name] = normaliseRoleProfile(candidate, kind, name)
  }
  const requestedStages = raw.stages !== null && typeof raw.stages === 'object' && !Array.isArray(raw.stages) ? raw.stages : {}
  const stages = {}
  for (const stage of WORKFLOW_STAGES) {
    const requested = requestedStages[stage]
    if (typeof requested === 'string' && profiles[requested] !== undefined && profiles[requested].stage === stage) {
      stages[stage] = requested
      continue
    }
    const own = ROLE_KINDS.filter((kind) => kind === STAGE_ROLE[stage])[0]
    if (own !== undefined && profiles[own] !== undefined && profiles[own].stage === stage) {
      stages[stage] = own
      continue
    }
    const owner = Object.keys(profiles).filter((name) => profiles[name].stage === stage)[0]
    stages[stage] = owner === undefined ? STAGE_ROLE[stage] : owner
  }
  const requestedDefault = typeof raw.defaultProfile === 'string' ? raw.defaultProfile : ''
  const defaultProfile = profiles[requestedDefault] !== undefined ? requestedDefault : base.defaultProfile
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
