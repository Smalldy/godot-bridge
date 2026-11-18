/**
 * Task center — shared schema constants.
 *
 * One place for the board version, the status vocabulary, the dispatch defaults
 * and the bounds. board.mjs validates against these and service.mjs moves tasks
 * between them, so a status that exists in one and not the other is impossible
 * to write.
 */

import { acceptanceItemsOf as contractAcceptanceItems, normaliseReviewRecord, normaliseTestRecord } from './stage-contract.mjs'

// The record size caps live with the contract module that enforces them; they
// are re-exported here because the schema is the documented boundary.
export { REVIEW_RECORD_MAX_BYTES, TEST_RECORD_MAX_BYTES } from './stage-contract.mjs'

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
    'Decide with a structured ReviewRecord: checked (the checks you actually ran: criterion/method/result), findings (severity blocking|non-blocking, file, line, text) and residualRisks. approveReview needs at least one checked entry; requestChanges needs at least one blocking finding and the reasons are rendered from it. Free-text-only verdicts are refused.',
  ].join('\n\n'),
  tester: [
    'Duties: independently test the candidate tree for the task and record a pass or a failure with evidence.',
    'Test against the acceptance criteria in the candidate checkout: run the project test commands there and record the exact command and exit code, then exercise the acceptance check itself. A green unit suite is not a substitute for the acceptance check.',
    'Execute every probe the CandidateArtifact declares; the TestRecord must contain each probe id (an empty probe list is refused).',
    'Report evidence another person could replay in a structured TestRecord: probes/adversarial rows of { id, command, exitCode, tail } plus notes. Report pass or fail; a failure must carry the failing command and its tail output.',
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

/** Bounds of one task's executable probes (TC-191). */
export const VERIFICATION_LIMITS = Object.freeze({
  probes: 8,
  id: 80,
  command: 500,
  timeoutMs: 30 * 60 * 1000,
})

function normaliseProbe(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  if (command === '') return null
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null
  const out = { id: id, command: command }
  if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) out.timeoutMs = Math.floor(raw.timeoutMs)
  return out
}

/**
 * The task's executable probes, read leniently: an old board has no verification
 * field and simply declares none.
 */
export function normaliseVerification(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { probes: [] }
  const probes = []
  if (Array.isArray(raw.probes)) {
    for (const entry of raw.probes) {
      const probe = normaliseProbe(entry)
      if (probe === null) continue
      if (probe.id === null) probe.id = 'probe-' + String(probes.length + 1)
      if (probes.some((other) => other.id === probe.id)) continue
      probes.push(probe)
      if (probes.length >= VERIFICATION_LIMITS.probes) break
    }
  }
  return { probes: probes }
}

/**
 * Strict form of normaliseVerification for WRITES: a malformed probe list is
 * refused as a typed error instead of being silently dropped, because a tester
 * who cannot see the task's probes cannot execute the contract.
 */
export function validateVerification(raw) {
  if (raw === undefined) return { ok: true, verification: undefined }
  if (raw === null) return { ok: true, verification: { probes: [] } }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'invalid-verification', message: 'verification must be { probes: [...] } or null' }
  }
  const source = Array.isArray(raw.probes) ? raw.probes : []
  if (source.length > VERIFICATION_LIMITS.probes) {
    return {
      ok: false,
      code: 'too-many-probes',
      message: 'at most ' + String(VERIFICATION_LIMITS.probes) + ' probes per task; split the card',
    }
  }
  const probes = []
  for (const entry of source) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, code: 'invalid-verification', message: 'every probe must be an object { id, command, timeoutMs? }' }
    }
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    if (command === '') {
      return { ok: false, code: 'invalid-verification', message: 'probe.command must be a non-empty shell command' }
    }
    if (command.length > VERIFICATION_LIMITS.command) {
      return { ok: false, code: 'invalid-verification', message: 'probe.command is longer than ' + String(VERIFICATION_LIMITS.command) + ' characters' }
    }
    const rawId = entry.id === undefined || entry.id === null ? '' : String(entry.id).trim()
    if (rawId.length > VERIFICATION_LIMITS.id) {
      return { ok: false, code: 'invalid-verification', message: 'probe.id is longer than ' + String(VERIFICATION_LIMITS.id) + ' characters' }
    }
    const id = rawId === '' ? 'probe-' + String(probes.length + 1) : rawId
    if (probes.some((probe) => probe.id === id)) {
      return { ok: false, code: 'invalid-verification', message: 'duplicate probe id ' + JSON.stringify(id) }
    }
    const probe = { id: id, command: command }
    if (entry.timeoutMs !== undefined && entry.timeoutMs !== null) {
      if (!Number.isFinite(entry.timeoutMs) || entry.timeoutMs <= 0 || entry.timeoutMs > VERIFICATION_LIMITS.timeoutMs) {
        return {
          ok: false,
          code: 'invalid-verification',
          message: 'probe.timeoutMs must be a positive number no larger than ' + String(VERIFICATION_LIMITS.timeoutMs),
        }
      }
      probe.timeoutMs = Math.floor(entry.timeoutMs)
    }
    probes.push(probe)
  }
  return { ok: true, verification: { probes: probes } }
}

// ── the card model (STAGE-CONTRACT §5) ──────────────────────────────────────

/**
 * The design-stage budget of ONE dev card: a card that cannot fit it must be
 * SPLIT WHILE IT IS BEING DESIGNED, not explained away in review or blamed on
 * the tester. Two kinds of paths are outside the production budget: generated
 * artifacts (`client/client.js` is rebuilt from `client/src` on every UI change,
 * so counting it would reject every UI card) and tests (a test file is the
 * consequence of a change, not the scope being designed).
 */
export const CARD_MODEL_LIMITS = Object.freeze({
  files: 5,
  changedLines: 250,
  acceptance: 6,
  probes: VERIFICATION_LIMITS.probes,
})

/** Paths BUILT from sources; never counted as card scope (STAGE-CONTRACT §5). */
export const GENERATED_PATHS = Object.freeze(['client/client.js'])

/** One repo-relative path, normalised for comparison (git uses "/"). */
export function normaliseCardPath(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

/** True for a generated artifact (the built bundle, or its source map). */
export function isGeneratedPath(value) {
  const path = normaliseCardPath(value)
  return path !== '' && GENERATED_PATHS.some((generated) => path === generated || path === generated + '.map')
}

/** True for a test path: test files are never production scope. */
export function isTestPath(value) {
  const path = normaliseCardPath(value)
  if (path === '') return false
  if (path.indexOf('scripts/test/') === 0) return true
  if (/(^|\/)tests?\//.test(path)) return true
  return /\.test\.(mjs|cjs|js)$/.test(path)
}

/** True when a changed/declared path counts toward the card's production budget. */
export function isProductionPath(value) {
  const path = normaliseCardPath(value)
  return path !== '' && isGeneratedPath(path) === false && isTestPath(path) === false
}

/** The production files of a path list: normalised, deduplicated, in order. */
export function productionFiles(list) {
  const out = []
  if (Array.isArray(list) === false) return out
  for (const entry of list) {
    const path = normaliseCardPath(entry)
    if (isProductionPath(path) === false) continue
    if (out.indexOf(path) >= 0) continue
    out.push(path)
  }
  return out
}

function normaliseChange(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const path = normaliseCardPath(entry.path)
  if (path === '') return null
  return {
    path: path,
    insertions: Number.isFinite(entry.insertions) ? Math.max(0, Math.floor(entry.insertions)) : 0,
    deletions: Number.isFinite(entry.deletions) ? Math.max(0, Math.floor(entry.deletions)) : 0,
  }
}

/** Production changed lines of a per-file list, or null when none was supplied (unknown is not zero). */
export function productionChangeLines(changes) {
  if (Array.isArray(changes) === false) return null
  let lines = 0
  for (const entry of changes) {
    const change = normaliseChange(entry)
    if (change === null || isProductionPath(change.path) === false) continue
    lines += change.insertions + change.deletions
  }
  return lines
}

/**
 * The production line budget of one SUBMITTED candidate, or null when it cannot
 * be attributed. The board keeps only the artifact SUMMARY (one aggregate
 * diffstat plus the changed-file list), so lines are attributable only when
 * EVERY changed file is production: a candidate that also touches tests or the
 * generated bundle is left unchecked instead of blaming the rebuilt bundle's
 * lines on the card. A candidate with NO production file has a known budget of
 * 0.
 */
export function productionLinesOfArtifact(artifact) {
  if (artifact === null || typeof artifact !== 'object' || Array.isArray(artifact)) return null
  if (Array.isArray(artifact.changedFiles) === false) return null
  const changed = artifact.changedFiles.map(normaliseCardPath).filter((path) => path !== '')
  if (changed.length === 0) return null
  const production = changed.filter(isProductionPath).length
  if (production === 0) return 0
  if (production !== changed.length) return null
  const stat = artifact.diffstat
  if (stat === null || typeof stat !== 'object' || Array.isArray(stat)) return null
  const insertions = Number.isFinite(stat.insertions) ? Math.max(0, Math.floor(stat.insertions)) : 0
  const deletions = Number.isFinite(stat.deletions) ? Math.max(0, Math.floor(stat.deletions)) : 0
  return insertions + deletions
}

function cardRefusal(code, message) {
  return { ok: false, code: code, message: message }
}

/**
 * Validate ONE card against the card model (STAGE-CONTRACT §5).
 *
 * input: { kind, acceptance, writeFiles, verification, changes? } — `changes` is
 * an optional per-file list; without it the line budget cannot be judged.
 * options: { requireProbes, limits }.
 *
 * Investigation cards are EXEMPT (a report, never a candidate). Returns
 * { ok: true, kind, exempt, files, acceptance, probes, lines } or a typed
 * refusal; never throws.
 */
export function validateCardModel(input, options) {
  const source = input === null || typeof input !== 'object' || Array.isArray(input) ? {} : input
  const opts = options === null || typeof options !== 'object' || Array.isArray(options) ? {} : options
  const overrides = opts.limits !== null && typeof opts.limits === 'object' && Array.isArray(opts.limits) === false ? opts.limits : {}
  const limits = Object.assign({}, CARD_MODEL_LIMITS, overrides)
  const kind = normaliseKind(source.kind)
  const resolvedKind = kind === null ? DEV_KIND : kind
  const shapes = {
    ok: true,
    kind: resolvedKind,
    exempt: true,
    files: 0,
    acceptance: 0,
    probes: 0,
    lines: null,
  }
  // Only a dev card owns a candidate; an investigation card is out of scope.
  if (resolvedKind !== DEV_KIND) return shapes
  const acceptance = contractAcceptanceItems({ acceptance: source.acceptance }).length
  if (acceptance > limits.acceptance) {
    return cardRefusal(
      'too-many-acceptance',
      'a dev card carries at most ' + String(limits.acceptance) + ' acceptance criteria; this one has ' + String(acceptance) + ' — split the card at design time',
    )
  }
  const files = productionFiles(source.writeFiles)
  if (files.length > limits.files) {
    return cardRefusal(
      'too-many-files',
      'a dev card touches at most ' + String(limits.files) + ' production files; this one declares ' + String(files.length) + ' (tests and the generated client/client.js do not count) — split the card at design time',
    )
  }
  const probes = normaliseVerification(source.verification).probes.length
  if (probes > limits.probes) {
    return cardRefusal(
      'too-many-probes',
      'a dev card declares at most ' + String(limits.probes) + ' probes; this one declares ' + String(probes) + ' — split the card at design time',
    )
  }
  if (opts.requireProbes === true && probes === 0) {
    return cardRefusal(
      'missing-probes',
      'a dev card needs at least one executable probe in verification.probes ({ id, command }): the host or the tester runs it to prove the card. An investigation card (kind "investigate") needs none.',
    )
  }
  const lines = productionChangeLines(source.changes)
  if (lines !== null && lines > limits.changedLines) {
    return cardRefusal(
      'too-many-changes',
      'the candidate changes ' + String(lines) + ' production lines; a dev card is limited to ' + String(limits.changedLines) + ' (tests and the generated client/client.js do not count) — split the card at design time',
    )
  }
  return {
    ok: true,
    kind: DEV_KIND,
    exempt: false,
    files: files.length,
    acceptance: acceptance,
    probes: probes,
    lines: lines,
  }
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
    // T-191: the CandidateArtifact fingerprint the check ran against, so an
    // unchanged candidate reuses the baseline instead of paying for it twice.
    fingerprint: typeof raw.fingerprint === 'string' && raw.fingerprint !== '' ? raw.fingerprint : null,
  }
}

// ── task kinds: dev (mergeable work) vs investigate (a report) ──────────────

/**
 * Every kind a card can have. 'dev' is the historical pipeline (worktree ->
 * review -> test -> merge); 'investigate' delivers a REPORT and never enters
 * review, test or merge. A board written before kinds existed has no field and
 * means 'dev'.
 */
export const TASK_KINDS = ['dev', 'investigate']
export const DEV_KIND = 'dev'
export const INVESTIGATE_KIND = 'investigate'

/** A stored/requested kind, or null when the value is not a known kind. */
export function normaliseKind(value) {
  if (value === undefined || value === null || value === '') return DEV_KIND
  if (typeof value !== 'string') return null
  const text = value.trim()
  return TASK_KINDS.indexOf(text) >= 0 ? text : null
}

/**
 * Size limits for an investigation report. The BOARD keeps at most this much of
 * each field (the full body is written to `.agents/reports/<id>.md`), so one
 * report cannot blow past the board budget the way a log paste would.
 */
export const REPORT_LIMITS = {
  summaryBytes: 4 * 1024,
  bodyBytes: 64 * 1024,
  evidence: 20,
  outputTailBytes: 4 * 1024,
  artifacts: 100,
}

/** Truncate a text to at most `limit` UTF-8 bytes without splitting a code
 * point, and say so — a silently shortened report would read as complete. */
export function truncateBytes(value, limit) {
  const text = typeof value === 'string' ? value : String(value === undefined || value === null ? '' : value)
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0
  if (cap === 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= cap) return text
  const suffix = '\n…(truncated)'
  const budget = Math.max(0, cap - Buffer.byteLength(suffix, 'utf8'))
  let used = 0
  let end = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > budget) break
    used += size
    end += char.length
  }
  return text.slice(0, end) + suffix
}

/**
 * One evidence row of an investigation report. Shape-repairing and bounded
 * because the panel renders it and the board stores it; a hand-written board
 * must not be able to smuggle a megabyte in through an evidence tail.
 */
export function normaliseEvidence(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const command = typeof entry.command === 'string' ? entry.command.trim() : ''
    const outputTail = typeof entry.outputTail === 'string' ? entry.outputTail : typeof entry.output === 'string' ? entry.output : ''
    if (command === '' && outputTail === '') continue
    out.push({
      command: truncateBytes(command, 2048),
      exitCode: Number.isFinite(entry.exitCode) ? Math.trunc(entry.exitCode) : null,
      outputTail: truncateBytes(outputTail, REPORT_LIMITS.outputTailBytes),
    })
    if (out.length >= REPORT_LIMITS.evidence) break
  }
  return out
}

/**
 * The stored report of an investigation card, or null. Missing/invalid fields
 * degrade to empty values (reading a board never throws); write-time validation
 * lives in service.reportTask.
 */
export function normaliseReport(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  if (summary === '') return null
  const artifacts = []
  if (Array.isArray(raw.artifacts)) {
    for (const entry of raw.artifacts) {
      if (typeof entry !== 'string') continue
      const path = entry.trim()
      if (path === '' || artifacts.indexOf(path) >= 0) continue
      artifacts.push(path)
      if (artifacts.length >= REPORT_LIMITS.artifacts) break
    }
  }
  const probeCommits = []
  if (Array.isArray(raw.probeCommits)) {
    for (const entry of raw.probeCommits) {
      if (typeof entry !== 'string') continue
      const text = entry.trim()
      if (text === '' || probeCommits.indexOf(text) >= 0) continue
      probeCommits.push(text)
      if (probeCommits.length >= REPORT_LIMITS.evidence) break
    }
  }
  return {
    summary: truncateBytes(summary, REPORT_LIMITS.summaryBytes),
    body: truncateBytes(typeof raw.body === 'string' ? raw.body : '', REPORT_LIMITS.bodyBytes),
    evidence: normaliseEvidence(raw.evidence),
    artifacts: artifacts,
    // A commit the investigator accidentally made in the scratch checkout: the
    // card still delivers a report and the commit is discarded, but the warning
    // is part of the record.
    probeCommits: probeCommits,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    by: typeof raw.by === 'string' ? raw.by : null,
    byName: typeof raw.byName === 'string' && raw.byName !== '' ? raw.byName : null,
  }
}

/** The project-level role profile file (optional; defaults apply when absent). */
export const ROLE_CONFIG_FILENAME = 'roles.json'
// T-138: v2 removes the per-profile `instances` field. Team size/concurrency now
// lives in the dispatch settings (maxConcurrent / maxWorkAgents), never in a role.
export const ROLE_CONFIG_VERSION = 2

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

/**
 * T-138: fields a pre-v2 role profile may still carry but that no longer belong
 * to a role definition. Team size moved to the dispatch settings; the reader
 * drops them and reports the migration instead of honouring them.
 */
const LEGACY_ROLE_FIELDS = ['instances', 'concurrency']

/** Which deprecated team-size fields a raw profile still carries ([] when clean). */
export function legacyRoleFields(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return LEGACY_ROLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(source, field))
}

/** One normalised role profile. A profile names one of the fixed role kinds;
 * its stage is that kind's stage, and it may carry a context, permissions and a
 * custom prompt. Malformed members fall back instead of throwing.
 *
 * T-138: a role describes BEHAVIOUR only. `instances`/`concurrency` from an old
 * file are deliberately ignored here (see legacyRoleFields), never normalised
 * into the profile and never consulted by dispatch. */
export function normaliseRoleProfile(raw, kind, name) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const stage = ROLE_STAGE[kind]
  const context = ROLE_CONTEXTS.indexOf(source.context) >= 0 ? source.context : 'fresh'
  const permissions = roleStringList(source.permissions).filter((entry) => ROLE_PERMISSIONS.indexOf(entry) >= 0)
  const prompt = typeof source.prompt === 'string' ? source.prompt.trim().slice(0, ROLE_PROMPT_MAX) : ''
  return {
    name: typeof name === 'string' && name !== '' ? name : kind,
    role: kind,
    stage: stage,
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
 * string skills, a known context, allowed permissions and a bounded prompt
 * (whose {{VARIABLES}} must exist in ROLE_TEMPLATE_VARIABLES).
 * T-138: `instances`/`concurrency` are accepted-but-ignored for old clients;
 * team size lives in the dispatch settings, so they are never validated here.
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
  pauseSource: null,
  pauseReason: null,
  maxConcurrent: 3,
  allowSpawn: true,
  maxAttempts: 3,
  // The project's default target branch; null follows the main checkout's branch.
  defaultTarget: null,
  request: null,
  worktree: { root: '.worktrees' },
}

/** Upper bounds for user-provided dispatch settings. */
export const DISPATCH_LIMITS = {
  maxConcurrent: { min: 1, max: 8 },
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
    // T-191: the structured ReviewRecord (checked/findings/residualRisks). Read
    // leniently so a hand-written board never breaks the board load.
    record: normaliseReviewRecord(raw.record),
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
    // T-191: the structured TestRecord (executed probes/adversarial/notes).
    record: normaliseTestRecord(raw.record),
    attempt: phaseAttempt(raw.attempt),
    deliveredTo: normaliseDeliveredTo(raw.deliveredTo),
    // The host's own mechanical check of this round (see runHostCheck). Optional:
    // an older board or a task without `verify` has none.
    hostCheck: normaliseHostCheck(raw.hostCheck),
  }
}

/** T-156: the audit record of a target moving under a card. */
function normaliseTargetDrift(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const from = typeof raw.from === 'string' && raw.from !== '' ? raw.from : null
  const to = typeof raw.to === 'string' && raw.to !== '' ? raw.to : null
  if (from === null || to === null) return null
  return { from: from, to: to, at: typeof raw.at === 'string' && raw.at !== '' ? raw.at : null }
}

/** T-156: the old/new verify fingerprints when the declaration changed. */
function normaliseVerifyFingerprints(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const from = typeof raw.from === 'string' && raw.from !== '' ? raw.from : null
  const to = typeof raw.to === 'string' && raw.to !== '' ? raw.to : null
  if (from === null || to === null) return null
  return { from: from, to: to }
}

/** T-191: the compact CandidateArtifact summary the board keeps. */
function normaliseArtifactSummary(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const hash = typeof raw.hash === 'string' && raw.hash !== '' ? raw.hash : null
  const base = typeof raw.base === 'string' && raw.base !== '' ? raw.base : null
  const head = typeof raw.head === 'string' && raw.head !== '' ? raw.head : null
  if (hash === null && base === null && head === null) return null
  const changedFiles = mergeStringList(raw.changedFiles)
  return {
    hash: hash,
    base: base,
    head: head,
    changedFiles: changedFiles,
    diffstat:
      raw.diffstat !== null && typeof raw.diffstat === 'object' && !Array.isArray(raw.diffstat) && Number.isFinite(raw.diffstat.files)
        ? {
            files: Math.max(0, Math.floor(raw.diffstat.files)),
            insertions: Number.isFinite(raw.diffstat.insertions) ? Math.max(0, Math.floor(raw.diffstat.insertions)) : 0,
            deletions: Number.isFinite(raw.diffstat.deletions) ? Math.max(0, Math.floor(raw.diffstat.deletions)) : 0,
          }
        : null,
    probeIds: mergeStringList(raw.probeIds),
    hostCheckFingerprint: typeof raw.hostCheckFingerprint === 'string' && raw.hostCheckFingerprint !== '' ? raw.hostCheckFingerprint : null,
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
    // T-156: the target moved while the card was in flight (candidate rebuilt on
    // the new head; base/actualFiles refreshed) — and/or the verify declaration
    // changed. Both are explicit, never inferred by the reviewer.
    targetDrift: normaliseTargetDrift(raw.targetDrift),
    verifyChanged: raw.verifyChanged === true,
    verifyFingerprints: normaliseVerifyFingerprints(raw.verifyFingerprints),
    // T-191: the board-sized CandidateArtifact summary (hash/base/head/files),
    // never the artifact body.
    artifact: normaliseArtifactSummary(raw.artifact),
  }
}

/** A fresh dispatch record with every field present. */
export function normaliseDispatch(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const state = source.state === 'running' ? 'running' : 'paused'
  // T-165: pause audit. A legacy board has neither field; it reads back as null
  // instead of being rewritten with a guessed source.
  const PAUSE_SOURCES = ['user', 'preflight', 'scheduler', 'worktree', 'legacy']
  const pauseSource =
    state === 'running' ? null : PAUSE_SOURCES.indexOf(source.pauseSource) >= 0 ? source.pauseSource : null
  const pauseReason =
    state === 'running'
      ? null
      : typeof source.pauseReason === 'string' && source.pauseReason.trim() !== ''
        ? source.pauseReason
        : null
  const clamp = (value, limit, fallback) =>
    Number.isFinite(value) ? Math.min(limit.max, Math.max(limit.min, Math.floor(value))) : fallback
  return {
    state: state,
    since: typeof source.since === 'string' ? source.since : null,
    by: typeof source.by === 'string' ? source.by : null,
    pauseSource: pauseSource,
    pauseReason: pauseReason,
    maxConcurrent: clamp(source.maxConcurrent, DISPATCH_LIMITS.maxConcurrent, DISPATCH_DEFAULTS.maxConcurrent),
    allowSpawn: source.allowSpawn === undefined ? DISPATCH_DEFAULTS.allowSpawn : source.allowSpawn === true,
    maxAttempts: clamp(source.maxAttempts, DISPATCH_LIMITS.maxAttempts, DISPATCH_DEFAULTS.maxAttempts),
    defaultTarget: typeof source.defaultTarget === 'string' && source.defaultTarget.trim() !== '' ? source.defaultTarget.trim() : null,
    request: normaliseRequest(source.request),
    // The readiness gate writes the missing items here so the panel can say what
    // blocked dispatch; a successful gate clears it.
    error: typeof source.error === 'string' && source.error !== '' ? source.error : null,
    worktree: normaliseWorktree(source.worktree),
  }
}

/**
 * T-195 — durable host decision requests.
 *
 * A DecisionRequest is a HOST-initiated, non-blocking two-phase question: the
 * host writes a pending request with a server deadline and (optionally) a
 * default option, the panel answers it once, and the timeout sweep records the
 * default when the deadline passes. The vocabulary and the bounds live here so
 * the store (decisions.mjs), the actions and the panel cannot drift.
 */
export const DECISION_FILENAME = 'decisions.json'
export const DECISION_VERSION = 1

/** Every stored state of one request. 'pending' is the only actionable one. */
export const DECISION_STATUSES = ['pending', 'answered', 'expired', 'cancelled']
export const DECISION_PENDING = 'pending'
export const DECISION_ANSWERED = 'answered'
export const DECISION_EXPIRED = 'expired'
export const DECISION_CANCELLED = 'cancelled'

/** A corrupt decisions file is refused above this size, never parsed blindly. */
export const MAX_DECISION_STORE_BYTES = 2 * 1024 * 1024
/** Refuse a new request when this many are still pending (a host bug, not a queue). */
export const MAX_DECISIONS = 200
/** Resolved records are trimmed to the newest ones; pending requests never are. */
export const MAX_RESOLVED_DECISIONS = 50
/** A modal queue with more than eight choices is not a decision. */
export const MAX_DECISION_OPTIONS = 8
export const MAX_DECISION_TITLE = 200
export const MAX_DECISION_BODY = 4000
/** The free-text answer / note cap. */
export const MAX_DECISION_TEXT = 2000
/** The opaque structured payload (event context) cap, in bytes. */
export const MAX_DECISION_PAYLOAD_BYTES = 8192
/** Every ask event in the requirement packet defaults to 120s (dispatch: 300s). */
export const DECISION_DEFAULT_TIMEOUT_MS = 120 * 1000
export const DECISION_MIN_TIMEOUT_MS = 1000
export const DECISION_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000
/** A destructive option is confirmed by typing this exact word. */
export const DECISION_CONFIRM_WORD = 'DELETE'
/** The option id a free-text-only answer is recorded under. */
export const DECISION_TEXT_OPTION = 'custom'

/** One option a decision offers. 'danger' marks a destructive choice: it never
 * auto-runs on timeout and the panel requires the DELETE word before it. */
export function normaliseDecisionOption(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  const label = typeof raw.label === 'string' ? raw.label.trim() : ''
  if (id === '' || label === '') return null
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  return {
    id: id.slice(0, 64),
    label: label.slice(0, 200),
    description: description.slice(0, 500),
    danger: raw.danger === true,
    // A default option is marked here as well, so the panel can show "默认"
    // without trusting a separate id comparison.
    default: raw.default === true,
  }
}

/** Normalise an option list; duplicate ids are refused (returns null). */
export function normaliseDecisionOptions(raw) {
  if (!Array.isArray(raw)) return []
  if (raw.length > MAX_DECISION_OPTIONS) return null
  const options = []
  const seen = new Set()
  for (const entry of raw) {
    const option = normaliseDecisionOption(entry)
    if (option === null) return null
    if (seen.has(option.id)) return null
    seen.add(option.id)
    options.push(option)
  }
  return options
}
