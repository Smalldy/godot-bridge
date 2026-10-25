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

/**
 * Refuse to load something this large. A task board is working state, not a
 * document, so a limit stays — but 4 MB was a time bomb: a real board is
 * ~16 KB/card, so ~250 cards would have stopped the task center from reading its
 * own board at all ("refusing to load more than 4194304") long before the 30-day
 * archive could help.
 *
 * 32 MB is the measured compromise: JSON.parse of a 1.5 MB / 92-card board takes
 * ~12 ms; a 32 MB board (~2 000 cards at today's per-card size) parses in
 * ~250-400 ms and peaks at roughly 3x its size (~100 MB) while normalising, which
 * is acceptable for a control-plane file read at panel cadence (a few seconds),
 * and still refuses a GB-scale file (a wrong path, a log, a binary) instead of
 * trying to parse it. The panel warns at 50% and 75% of this limit; see
 * boardSizeReport in board.mjs.
 */
export const MAX_BOARD_BYTES = 32 * 1024 * 1024

/** Fractions of MAX_BOARD_BYTES at which the panel warns (and the API reports). */
export const BOARD_WARN_FRACTIONS = [0.5, 0.75]

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
 * take it back. Any activity by the assignee renews it UNCONDITIONALLY (no
 * "half spent" gate), so this bounds a worker that vanished, not one that is
 * busy in a long tool run. */
export const TASK_LEASE_MS = 60 * 60 * 1000

/** The host's own renewal cadence for a running task. The scheduler extends a
 * lease once it is inside this window of lapsing — a FIXED interval, never "half
 * the lease" — so a task stays claimed through a long silent stretch. */
export const TASK_HEARTBEAT_MS = 5 * 60 * 1000

/** How long the LIVENESS path may keep extending one attempt after its lease
 * lapsed. While the assignee session is still alive a lapsed lease is renewed
 * (never a second agent), but only up to this much after the attempt started;
 * past it the task is handed over to a fresh attempt. */
export const TASK_LEASE_EXTENSION_MAX_MS = 4 * 60 * 60 * 1000

/** A lease this close to lapsing is reported as "expiring": the panel warns and
 * the board exposes leaseReminder so a silent worker is visible before it is
 * handled by liveness. */
export const TASK_LEASE_REMINDER_MS = 10 * 60 * 1000

/** The dispatch.error written when a handover is forced by the liveness cap
 * rather than by a dead holder. Shared by the writer (the dispatcher's
 * expireLeases call) and the single-agent guard, so the two can never drift. */
export const TASK_LEASE_CAP_ERROR = 'lease expired (liveness cap)'

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
 * The readable default prompt of the built-in worker, reviewer and tester
 * profiles. These instructions used to be host-fixed copy inside the brief; they
 * are now an ordinary profile prompt the panel can show, fork and edit, while
 * only the hard permission boundary and the verdict schema stay host-fixed.
 * English, like the rest of the brief.
 *
 * The worker prompt is injected per task through briefFor, so every implementer
 * wakes with it on both the spawn and the reused-teammate handover path.
 */
export const DEFAULT_ROLE_PROMPTS = {
  worker: [
    'Duties: implement the task in its worktree and prove it there.',
    'Edit files, run the project tests and commit ONLY inside the task worktree; never change the main checkout.',
    'You do not review or test your own task: a separate reviewer and tester decide those verdicts, and the host enforces that boundary.',
    'Report with task_center submit: what changed and how you checked it. Do not dispatch work yourself — the scheduler owns dispatch.',
    'After a change request or a failed test, continue in the SAME worktree and branch; do not start from a fresh checkout.',
  ].join('\n\n'),
  reviewer: [
    'Duties: review the submitted tree (the diff from its base to its head, the declared vs actual files, and the worker evidence), then approve it or request concrete changes.',
    'Review against the project conventions: keep the change consistent with the surrounding code and architecture, avoid unrelated rewrites and never restyle files the task did not touch.',
    'Review checklist:\n- The diff matches the spec and the acceptance criteria, and nothing unrelated changed.\n- Declared vs actual files match (or the extras are justified).\n- No secrets, debug leftovers, dead code or commented-out blocks.\n- The evidence plausibly matches the change (you do NOT need to run the full test suite; the test stage does that).\n- Error handling and naming follow the code around it.',
    'Decide: approve the review, or ask for changes with concrete, actionable reasons naming the files and lines.',
  ].join('\n\n'),
  tester: [
    'Duties: independently test the candidate tree for the task and record a pass or a failure with evidence.',
    'Test against the acceptance criteria in the candidate checkout: run the project test commands there and record the exact command and exit code, then exercise the acceptance check itself. A green unit suite is not a substitute for the acceptance check.',
    'Report evidence another person could replay: what you ran, what came back, and why it proves the criterion. Decide pass or fail; on a failure give the failing command and its tail output.',
  ].join('\n\n'),
}

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

/**
 * Silence alone does not prove a role is stuck: a tester may call task_center
 * (get / passTest / ...) while it works, and every identifiable call renews the
 * phase's last-activity clock. The watchdog measures SILENCE from that activity.
 * Before blocking it leaves this grace window after the hard threshold: reaching
 * TEST_TIMEOUT_MS only sends an "about to block" reminder; the task is blocked at
 * TEST_TIMEOUT_MS + PHASE_BLOCK_GRACE_MS with no activity, so a verdict landing
 * exactly on the boundary is not thrown away.
 *
 * The activity clock itself is MEMORY ONLY (dispatch.mjs): it is not persisted on
 * the board, so a host restart loses it and a round already older than the
 * silence threshold may be blocked on the first tick after the restart. That is
 * accepted deliberately: the clock is a liveness hint, not a decision record.
 */
export const PHASE_BLOCK_GRACE_MS = 2 * 60 * 1000

/** The host bounds one async action (candidate build / candidate merge / merge
 * request / role provisioning / notification) so a stuck await cannot hold the
 * action or the serialised merge queue forever. */
export const HOST_ACTION_TIMEOUT_MS = 2 * 60 * 1000

/**
 * Mechanical verification (the task's optional `verify` declaration).
 *
 * A task may name the command that proves it mechanically ("npm run verify").
 * The HOST runs it in the test candidate BEFORE any tester is involved: a
 * command that exits 0 or not is not a judgement call, so spending a tester
 * round (and its 20-minute watchdog) on it was the wrong place for it. A task
 * without the field keeps the historical flow, where the tester runs the suite
 * itself.
 */
export const VERIFY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
/** The task keeps only the TAIL of the command output (the part that explains a
 * failure), never the whole log. */
export const VERIFY_TAIL_BYTES = 4 * 1024
/** Output collected while the command runs; the tail is cut from this. */
export const VERIFY_COLLECT_BYTES = 256 * 1024

/** One task's mechanical-verification declaration, or null. A blank command is
 * no declaration at all, so a broken board degrades instead of running "". */
export function normaliseVerify(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (command === '') return null
  const out = { command: command }
  if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) out.timeoutMs = Math.floor(raw.timeoutMs)
  return out
}

/**
 * Strict form of normaliseVerify for WRITES: a malformed declaration is refused
 * with invalid-verify instead of being silently dropped. normaliseVerify stays
 * lenient for reading an existing board (a broken field degrades to "no check").
 */
export function validateVerify(raw) {
  if (raw === null) return { ok: true, verify: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'invalid-verify', message: 'verify must be an object with a non-empty command, or null' }
  }
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (command === '') {
    return { ok: false, code: 'invalid-verify', message: 'verify.command must be a non-empty string' }
  }
  const out = { command: command }
  if (raw.timeoutMs !== undefined) {
    if (!Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) {
      return { ok: false, code: 'invalid-verify', message: 'verify.timeoutMs must be a positive number, got ' + JSON.stringify(raw.timeoutMs) }
    }
    out.timeoutMs = Math.floor(raw.timeoutMs)
  }
  return { ok: true, verify: out }
}

/**
 * The host's record of one mechanical-verification run, or null.
 *
 * `timedOut` is separate from `exitCode` on purpose: a killed command has no
 * exit code, and reporting a made-up 1 would hide the difference between "the
 * suite failed" and "the suite never finished".
 */
export function normaliseHostCheck(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const command = typeof raw.command === 'string' ? raw.command : ''
  if (command === '') return null
  return {
    command: command,
    exitCode: Number.isFinite(raw.exitCode) ? Math.floor(raw.exitCode) : null,
    timedOut: raw.timedOut === true,
    durationMs: Number.isFinite(raw.durationMs) ? Math.max(0, Math.floor(raw.durationMs)) : null,
    tail: typeof raw.tail === 'string' ? raw.tail : '',
    at: typeof raw.at === 'string' ? raw.at : null,
  }
}

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

/** One built-in profile, carrying its readable default prompt when it has one. */
function defaultProfileFor(kind) {
  const prompt = DEFAULT_ROLE_PROMPTS[kind]
  return normaliseRoleProfile(prompt === undefined ? null : { prompt: prompt }, kind, kind)
}

/** The built-in profile set: one implement-stage worker, one reviewer, one tester. */
export function defaultRoleConfig() {
  const profiles = {}
  for (const kind of ROLE_KINDS) profiles[kind] = defaultProfileFor(kind)
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
  // Migration: an existing roles.json may carry a built-in profile with an empty
  // prompt (the old host-fixed duties). Fall back to the readable default for the
  // three built-in names only; a custom profile with an empty prompt stays empty,
  // and the fallback is not written back until the user saves.
  for (const kind of ROLE_KINDS) {
    const profile = normaliseRoleProfile(sourceProfiles[kind], kind, kind)
    profiles[kind] = profile.prompt === '' && DEFAULT_ROLE_PROMPTS[kind] !== undefined ? Object.assign({}, profile, { prompt: DEFAULT_ROLE_PROMPTS[kind] }) : profile
  }
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
  // The project's default target branch; null follows the main checkout's branch.
  defaultTarget: null,
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
  // Absolute roots are allowed only because the readiness gate validates them;
  // the dispatcher resolves them outside the project.
  if (text.startsWith('/') || text.startsWith('\\') || /^[a-zA-Z]:/.test(text)) {
    if (text.indexOf('..') >= 0) return fallback
    return text
  }
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
/** The member a stage brief was delivered to: durable name + agent session id. */
export function normaliseDeliveredTo(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
  if (name === null && id === null) return null
  return { name: name, id: id, at: typeof raw.at === 'string' ? raw.at : null }
}

export function normaliseReview(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (REVIEW_STATUSES.indexOf(raw.status) < 0) return null
  return {
    status: raw.status,
    by: typeof raw.by === 'string' ? raw.by : null,
    byName: typeof raw.byName === 'string' && raw.byName !== '' ? raw.byName : null,
    at: typeof raw.at === 'string' ? raw.at : null,
    reasons: typeof raw.reasons === 'string' ? raw.reasons : null,
    attempt: phaseAttempt(raw.attempt),
    // T-116: who the host actually handed this review round to. The verdict gate
    // trusts it even when the role member has since left the Lead's roster.
    deliveredTo: normaliseDeliveredTo(raw.deliveredTo),
  }
}

/** A test-phase record, or null. Mirrors normaliseReview with evidence. */
export function normaliseTest(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (TEST_STATUSES.indexOf(raw.status) < 0) return null
  return {
    status: raw.status,
    by: typeof raw.by === 'string' ? raw.by : null,
    byName: typeof raw.byName === 'string' && raw.byName !== '' ? raw.byName : null,
    at: typeof raw.at === 'string' ? raw.at : null,
    evidence: typeof raw.evidence === 'string' ? raw.evidence : null,
    attempt: phaseAttempt(raw.attempt),
    deliveredTo: normaliseDeliveredTo(raw.deliveredTo),
    // The host's own mechanical check of this round (see runHostCheck). Optional:
    // an older board or a task without `verify` has none.
    hostCheck: normaliseHostCheck(raw.hostCheck),
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
    // Cross-round automatic rebuild failures. It lives on the CARD (not in the
    // sweep's memory) so "the same conflict every round" can escalate to
    // needs-rebase instead of spinning candidate-stale forever.
    rebuildAttempts: Number.isFinite(raw.rebuildAttempts) ? Math.max(0, Math.min(10, Math.floor(raw.rebuildAttempts))) : 0,
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
    defaultTarget: typeof source.defaultTarget === 'string' && source.defaultTarget.trim() !== '' ? source.defaultTarget.trim() : null,
    request: normaliseRequest(source.request),
    // The readiness gate writes the missing items here so the panel can say what
    // blocked dispatch; a successful gate clears it.
    error: typeof source.error === 'string' && source.error !== '' ? source.error : null,
    worktree: normaliseWorktree(source.worktree),
  }
}
