/**
 * The card state machine (T-201, docs/refactor/TASK-STATE-MACHINE.md section 4).
 *
 * ONE table, ONE write entry. Every card status change in the production code
 * goes through enterState(): it looks the (event, from) pair up in TRANSITIONS,
 * checks the declared actor and guards, applies the declared state-entry side
 * effects and only then writes task.status. Nothing else in plugin/task-center
 * assigns a card status (board.mjs may still rewrite it while normalising a
 * board it refused to understand, and harness process state is not a card).
 *
 * Why 7 states and not the document's 8: this card may not change the panel or
 * the board version, and adding 'merging' needs a BOARD_VERSION 3 migration (an
 * unknown status would be rewritten to 'pending' by board.mjs on reload) plus a
 * new board column. The document's 'merging' phase is therefore expressed as the
 * PROJECTION testing + test.status='passed' + merge.status='open', and phaseOf()
 * exposes it as phase 'merge'. The meaning of every combination is pinned by the
 * table and by scripts/test/state-machine.test.mjs:
 *
 *   testing + test.pending              -> the test round is open
 *   testing + test.passed + merge.open  -> tested; the merge request is in flight
 *   testing + merge.merged              -> illegal (done is the only merged home)
 *   testing + merge.conflict/failed/    -> illegal: those move the card to blocked
 *            rejected
 *   blocked + merge.*                   -> the merge outcome is preserved as the
 *                                          typed blockedReason (merge-*), never
 *                                          hidden behind status='testing'
 *
 * Actor values are the document's vocabulary: user, scheduler, host, worker,
 * reviewer, tester (plus 'agent' for a generic caller). A row whose actor is
 * null accepts any caller; a row with an array refuses an unlisted actor with
 * code 'forbidden'. When the caller does not name an actor the actor gate is
 * skipped: the action layer (kernel/verdict-gate.mjs, kernel/gates.mjs) owns the
 * delivery/role check, and the state machine is the second, structural gate.
 * Service functions pass the actor they know, so a direct model call can still
 * prove the matrix (see the actor tests).
 */

import { CLOSED_STATUSES, MERGE_STATUSES, STATUSES, TASK_LEASE_MS } from './schema.mjs'

const iso = (now) => new Date(now).toISOString()
const clone = (value) => JSON.parse(JSON.stringify(value))

/** The seven persisted card states, in board order. */
export const CARD_STATES = Object.freeze(STATUSES.slice())

/** done/cancelled: only reopen (T30) leaves them, and a merged result is final. */
export const CLOSED_STATES = Object.freeze(CLOSED_STATUSES.slice())

/** The target machine's four stage phases, as a derived projection only. */
export const PHASES = Object.freeze(['implement', 'review', 'test', 'merge'])

/** Merge-request outcomes that may be recorded on the board ('open' is a live request, 'stale' a queue answer). */
export const MERGE_OUTCOMES = Object.freeze(MERGE_STATUSES.filter((status) => status !== 'open'))

/**
 * The typed reasons a card may be blocked for. The blockedReason object is the
 * only reason a blocked card is paused for; waitingReason mirrors the code for
 * the current panel and is never the source of truth.
 */
export const BLOCKED_REASON_CODES = Object.freeze([
  'manual-block',
  'interruptions-exhausted',
  'attempts-exhausted',
  'executor-unavailable',
  'dirty-worktree',
  'candidate-stale',
  'needs-rebase',
  'review-round-limit',
  'review-timeout',
  'test-timeout',
  'stage-continue-limit',
  'merge-conflict',
  'merge-failed',
  'merge-rejected',
  'invalid-merge-status',
])

/** True for the merge-outcome reasons: only refreshMerge (T27) resolves them. */
export function isMergeReason(code) {
  return typeof code === 'string' && code.indexOf('merge-') === 0
}

function refusal(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
}

function stateName(value) {
  return value === null || value === undefined ? 'no card' : String(value)
}

/** Retire every live executor entry; the caller never reuses an identity twice. */
export function retireExecutors(task, now, reason) {
  const list = Array.isArray(task.executors) ? task.executors : []
  task.executors = list.map((entry) =>
    entry !== null && typeof entry === 'object' && (entry.retiredAt === null || entry.retiredAt === undefined)
      ? Object.assign({}, entry, { retiredAt: iso(now), retiredReason: String(reason) })
      : entry,
  )
}

/** The phase a card is in right now, derived from status + the open round. */
export function phaseOf(task) {
  if (task === null || task === undefined) return null
  if (task.status === 'running') return 'implement'
  if (task.status === 'reviewing') return 'review'
  if (task.status === 'testing') {
    const passed = task.test !== null && task.test !== undefined && task.test.status === 'passed'
    const open = task.merge !== null && task.merge !== undefined && task.merge.status === 'open'
    return passed && open ? 'merge' : 'test'
  }
  return null
}

/** The card state (the persisted authority). */
export function stateOf(task) {
  return task === null || task === undefined ? null : task.status
}

/**
 * The blockedFrom of a card: the status it was paused from. The persisted
 * blockedReason carries it; a legacy/manual blocked card is read from history
 * (the newest row that entered blocked) and finally defaults to 'pending'.
 */
export function blockedFromOf(task) {
  if (task === null || task === undefined) return null
  const reason = task.blockedReason
  if (reason !== null && reason !== undefined && typeof reason.from === 'string' && CARD_STATES.indexOf(reason.from) >= 0) return reason.from
  const history = Array.isArray(task.history) ? task.history : []
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const row = history[index]
    if (row === null || typeof row !== 'object') continue
    if (row.to !== 'blocked') continue
    if (typeof row.from === 'string' && CARD_STATES.indexOf(row.from) >= 0 && row.from !== 'blocked') return row.from
  }
  return 'pending'
}

/**
 * The structured reason a card is blocked, or null. Reads the persisted
 * blockedReason; a legacy blocked card (written before T-201) derives a readable
 * one from waitingReason + history rather than pretending it has no reason.
 */
export function blockedReasonOf(task) {
  if (task === null || task === undefined || task.status !== 'blocked') return null
  const raw = task.blockedReason
  if (raw !== null && raw !== undefined && typeof raw.code === 'string' && raw.code !== '') {
    return {
      code: raw.code,
      detail: typeof raw.detail === 'string' && raw.detail !== '' ? raw.detail : null,
      from: blockedFromOf(task),
      auto: raw.auto === true,
      at: typeof raw.at === 'string' ? raw.at : null,
    }
  }
  const code = typeof task.waitingReason === 'string' && task.waitingReason !== '' ? task.waitingReason : 'manual-block'
  return {
    code: code,
    detail: typeof task.waitingDetail === 'string' && task.waitingDetail !== '' ? task.waitingDetail : null,
    from: blockedFromOf(task),
    auto: false,
    at: null,
  }
}

/** Is the merge request mergeable RIGHT NOW? status/test/review/merge must agree. */
export function isMergeEligible(task) {
  if (task === null || task === undefined) return false
  if (task.kind === 'investigate') return false
  if (task.status !== 'testing') return false
  const review = task.review
  if (review === null || review === undefined || typeof review !== 'object') return false
  if (review.status !== 'approved') return false
  const test = task.test
  if (test === null || test === undefined || typeof test !== 'object') return false
  if (test.status !== 'passed') return false
  const merge = task.merge
  if (merge === null || merge === undefined || typeof merge !== 'object' || Array.isArray(merge)) return false
  return merge.status === 'open'
}

// ── guards ─────────────────────────────────────────────────────────────
//
// A guard returns true, a rejection code string, or a full refusal object.
// Guards read the task itself (always provided) plus optional facts the caller
// supplies: dependency (claim), change (refreshMerge), hasImplementer (rework
// targets), restoreTo (unblock/resume). A guard whose optional fact is absent is
// considered satisfied: the caller is another gate in the same pipeline and the
// structural write is what this module owns.

function guardKindDev(ctx) {
  const task = ctx.task
  if (task === null || task === undefined || task.kind !== 'investigate') return true
  return { ok: false, code: 'not-a-dev-task', message: task.id + ' is an investigation card; it has no review/test/merge phase' }
}

function guardKindInvestigate(ctx) {
  const task = ctx.task
  if (task === null || task === undefined) return true
  return task.kind === 'investigate'
    ? true
    : { ok: false, code: 'not-an-investigation', message: task.id + ' is a dev card; finish it with submit so it can be reviewed, tested and merged' }
}

function guardDependencyReady(ctx) {
  const dependency = ctx.dependency
  if (dependency === null || dependency === undefined) return true
  if (dependency.state === 'broken') {
    return { ok: false, code: 'dependency-broken', message: 'waits on missing or cancelled tasks: ' + (Array.isArray(dependency.brokenOn) ? dependency.brokenOn.join(', ') : '') }
  }
  if (dependency.state !== 'ready') {
    return { ok: false, code: 'dependency-unmet', message: 'is still waiting on ' + (Array.isArray(dependency.waitingOn) ? dependency.waitingOn.join(', ') : '') }
  }
  return true
}

function guardReviewOpen(ctx) {
  const review = ctx.task === null || ctx.task === undefined ? null : ctx.task.review
  if (review !== null && review !== undefined && review.status === 'pending') return true
  return 'no-pending-review'
}

function guardTestOpen(ctx) {
  const test = ctx.task === null || ctx.task === undefined ? null : ctx.task.test
  if (test !== null && test !== undefined && test.status === 'pending') return true
  return 'no-pending-test'
}

function guardMergeExists(ctx) {
  const merge = ctx.task === null || ctx.task === undefined ? null : ctx.task.merge
  return merge !== null && merge !== undefined && typeof merge === 'object' && !Array.isArray(merge) ? true : 'no-merge-request'
}

function guardMergeOpen(ctx) {
  const merge = ctx.task === null || ctx.task === undefined ? null : ctx.task.merge
  return merge !== null && merge !== undefined && merge.status === 'open' ? true : 'no-open-merge'
}

function guardMergeEligible(ctx) {
  return isMergeEligible(ctx.task) ? true : 'not-eligible'
}

/** (base, head, outcome) at least one changed — otherwise refresh is a no-op. */
function guardMergeChange(ctx) {
  const change = ctx.change
  if (change === null || change === undefined || typeof change !== 'object') return true
  if (change.base === true || change.head === true || change.outcome === true) return true
  return 'no-change'
}

/** The target status restore/resume returns a blocked card to. */
export function restoreTargetOf(task) {
  const from = blockedFromOf(task)
  if (from === 'reviewing') return 'reviewing'
  if (from === 'testing') return 'testing'
  if (from === 'running') return 'pending'
  return 'pending'
}

function guardRestoreTarget(ctx) {
  const task = ctx.task
  if (task === null || task === undefined) return true
  const from = blockedFromOf(task)
  if (CARD_STATES.indexOf(from) < 0 || from === 'done' || from === 'cancelled' || from === 'blocked') {
    return { ok: false, code: 'invalid-blocked-from', message: 'blockedFrom ' + stateName(from) + ' cannot be restored' }
  }
  const target = restoreTargetOf(task)
  if (ctx.restoreTo !== undefined && ctx.restoreTo !== null && ctx.restoreTo !== target) {
    return { ok: false, code: 'invalid-restore-target', message: 'blockedFrom ' + from + ' restores to ' + target + ', not ' + String(ctx.restoreTo) }
  }
  return true
}

/** The paused round must still be the round being resumed (R3). */
function guardPhaseRecordMatch(ctx) {
  const task = ctx.task
  if (task === null || task === undefined) return true
  const target = restoreTargetOf(task)
  if (target === 'reviewing') {
    const review = task.review
    return review !== null && review !== undefined && review.status === 'pending' ? true : 'phase-record-mismatch'
  }
  if (target === 'testing') {
    const review = task.review
    const test = task.test
    const approved = review !== null && review !== undefined && review.status === 'approved'
    const open = test !== null && test !== undefined && test.status === 'pending'
    return approved && open ? true : 'phase-record-mismatch'
  }
  return true
}

/** Restoring a stage card keeps its merge request: a resolved merge is not reopened by unblock. */
function guardMergeOpenForPhase(ctx) {
  const task = ctx.task
  if (task === null || task === undefined) return true
  const target = restoreTargetOf(task)
  if (target !== 'reviewing' && target !== 'testing') return true
  const merge = task.merge
  if (merge === null || merge === undefined || merge.status === 'open') return true
  return 'merge-unresolved'
}

/** T27 from blocked: only a merge-outcome pause may be refreshed away (4.3/4.8). */
function guardMergeBlockedReason(ctx, entry) {
  if (entry === undefined || entry.from !== 'blocked') return true
  const reason = blockedReasonOf(ctx.task)
  if (reason !== null && isMergeReason(reason.code) === true) return true
  return 'merge-unresolved'
}

function guardRetryable(ctx) {
  const task = ctx.task
  if (task === null || task === undefined) return true
  if (task.status === 'pending') return true
  const reason = blockedReasonOf(task)
  if (reason !== null && reason.code === 'review-round-limit') return 'not-retryable'
  const from = blockedFromOf(task)
  if (from !== 'pending' && from !== 'running') return 'not-retryable'
  return true
}

function guardUnblockable(ctx) {
  const task = ctx.task
  if (task === null || task === undefined) return true
  const reason = blockedReasonOf(task)
  if (reason !== null && reason.code === 'review-round-limit') return 'not-retryable'
  return true
}

const GUARDS = Object.freeze({
  'kind-dev': guardKindDev,
  'kind-investigate': guardKindInvestigate,
  'dependency-ready': guardDependencyReady,
  'review-open': guardReviewOpen,
  'test-open': guardTestOpen,
  'merge-exists': guardMergeExists,
  'merge-open': guardMergeOpen,
  'merge-eligible': guardMergeEligible,
  'merge-blocked-reason': guardMergeBlockedReason,
  'merge-change': guardMergeChange,
  'restore-target': guardRestoreTarget,
  'phase-record-match': guardPhaseRecordMatch,
  'merge-open-for-phase': guardMergeOpenForPhase,
  retryable: guardRetryable,
  unblockable: guardUnblockable,
})

// ── effects ────────────────────────────────────────────────────────────
//
// Only the side effects that belong to ENTERING a state are declared here; the
// event payload (commit, review round, test record, dispatch text) is written by
// the caller after enterState returns. Every effect is idempotent.

/** A rework target: back to the same worker when one is known, else the pool. */
const reworkTarget = (ctx) => (ctx.hasImplementer === false ? 'pending' : 'running')

/** Purge every phase record of the previous generation (T30 reopen). */
function applyNewGeneration(task, now) {
  const hadMerged = task.merge !== null && task.merge !== undefined && task.merge.status === 'merged'
  task.review = null
  task.test = null
  task.report = null
  task.merge = null
  task.attempts = 0
  task.interruptions = 0
  task.executors = []
  task.dispatch = null
  task.assignee = null
  task.leaseUntil = null
  if (hadMerged) {
    // The merged commit is the previous generation's result, not this card's baseline.
    task.base = null
    task.targetBase = null
    task.commit = null
    task.branch = null
    task.worktree = null
    task.worktreeError = null
  }
}

function applyEffect(task, effect, info) {
  const now = info.now
  switch (effect) {
    case 'clear-lease':
      task.leaseUntil = null
      return
    case 'renew-lease':
      task.leaseUntil = iso(now + TASK_LEASE_MS)
      return
    case 'clear-assignee':
      task.assignee = null
      return
    case 'last-assignee':
      task.lastAssignee = task.assignee === null || task.assignee === undefined ? (task.lastAssignee === undefined ? null : task.lastAssignee) : clone(task.assignee)
      return
    case 'clear-claim':
      task.lastAssignee = task.assignee === null || task.assignee === undefined ? (task.lastAssignee === undefined ? null : task.lastAssignee) : clone(task.assignee)
      task.assignee = null
      task.leaseUntil = null
      return
    case 'retire-executors':
      // A caller that owns the readable audit reason (handoff names the takeover
      // session) supplies it; otherwise the row names itself.
      retireExecutors(
        task,
        now,
        typeof info.context.retireReason === 'string' && info.context.retireReason !== '' ? info.context.retireReason : info.row.id + ' ' + info.row.event,
      )
      return
    case 'clear-executors':
      task.executors = []
      return
    case 'clear-dispatch':
      task.dispatch = null
      return
    case 'clear-merge':
      task.merge = null
      return
    case 'reset-attempts':
      task.attempts = 0
      return
    case 'reset-interruptions':
      task.interruptions = 0
      return
    case 'attempts-refund':
      task.attempts = Math.max(0, (Number.isFinite(task.attempts) ? task.attempts : 0) - 1)
      return
    case 'attempts+1':
      task.attempts = (Number.isFinite(task.attempts) ? task.attempts : 0) + 1
      return
    case 'interruptions+1':
      task.interruptions = (Number.isFinite(task.interruptions) ? task.interruptions : 0) + 1
      return
    case 'new-generation':
      applyNewGeneration(task, now)
      return
    case 'requeue-stage-delivered-to':
      if (task.review !== null && task.review !== undefined && task.review.status === 'pending') task.review = Object.assign({}, task.review, { deliveredTo: null })
      if (task.test !== null && task.test !== undefined && task.test.status === 'pending') task.test = Object.assign({}, task.test, { deliveredTo: null })
      return
    default:
      throw new Error('unknown state-machine effect ' + JSON.stringify(effect))
  }
}

function applyEntry(task, row, info) {
  const declared = typeof row.effects === 'function' ? row.effects(info.context, { from: info.from, to: info.to }) : row.effects === undefined ? [] : row.effects
  for (const effect of declared) applyEffect(task, effect, info)
  if (info.to === 'blocked') {
    const code = typeof info.context.blockedCode === 'string' && info.context.blockedCode !== '' ? info.context.blockedCode : row.blockedCode === undefined ? 'manual-block' : row.blockedCode
    const detail = typeof info.context.blockedDetail === 'string' && info.context.blockedDetail !== '' ? info.context.blockedDetail : null
    task.blockedReason = { code: code, detail: detail, from: info.from, auto: info.context.auto === true, at: iso(info.now) }
    // The panel still renders waitingReason; it mirrors the canonical code.
    task.waitingReason = code
    task.waitingDetail = detail
    return
  }
  task.blockedReason = null
  if (info.from === 'blocked' || info.to === 'pending') {
    task.waitingReason = null
    task.waitingDetail = null
  }
}

// ── the table ──────────────────────────────────────────────────────────
//
// Columns: id (document section 4.3 row), event, from ([] = created from nothing),
// to (a state or a function of the context — the only events with two targets are
// the no-implementer rework paths), actor (null = any caller), guards, effects,
// refusal (the typed code when (event, from) is not legal) and blockedCode (the
// typed blocked reason for a row that ends blocked).
//
// Wiring note: every status the production code writes goes through a row here.
// The document also names composite/scan rows (approve+hostCheck-failure, review/
// test timeout, auto-resume, heartbeat); the production code performs the SAME
// board outcome through the rows it really executes — approveReview then failTest,
// block with the typed review-timeout/test-timeout reason, refreshMerge — and
// their rows are declared and table-tested so the vocabulary cannot drift.
//
// Document-row mapping where this code deliberately differs (see the 7-vs-8-state
// note above): the document's 'merging' -> testing + test.passed + merge.open;
// T25/T26 drift -> T25 baseOnlyDrift and T25b targetDriftRetest (content drift is
// detected by the host and explicitly refreshed, so it is the T27 row, no
// separate contentDrift row); G10 dispatch failure -> T03b dispatchFailed (the
// function is still exported); T33/T34 scan rows -> the same refreshMerge /
// mergeMerged rows the sweeps call, so no extra rows are declared.

export const TRANSITIONS = Object.freeze([
  {
    id: 'T01',
    event: 'create',
    from: Object.freeze([]),
    to: 'pending',
    actor: null,
    guards: Object.freeze([]),
    effects: Object.freeze([]),
    refusal: 'invalid-create',
  },
  {
    id: 'T02',
    event: 'claim',
    from: Object.freeze(['pending']),
    to: 'running',
    actor: Object.freeze(['scheduler']),
    guards: Object.freeze(['dependency-ready']),
    effects: Object.freeze(['attempts+1', 'clear-merge', 'retire-executors', 'clear-lease']),
    refusal: 'not-pending',
  },
  {
    id: 'T03',
    event: 'interrupt',
    from: Object.freeze(['running']),
    to: (ctx) => (ctx.to === 'blocked' ? 'blocked' : 'pending'),
    actor: Object.freeze(['scheduler', 'host']),
    guards: Object.freeze([]),
    effects: Object.freeze(['attempts-refund', 'interruptions+1', 'clear-claim', 'retire-executors']),
    refusal: 'not-running',
    blockedCode: 'interruptions-exhausted',
  },
  {
    // Not a document 4.3 row: G10 records that a dispatch failure is not a
    // reachable transition. The function is still exported, so its status write
    // is declared here rather than left as a hand-written branch.
    id: 'T03b',
    event: 'dispatchFailed',
    from: Object.freeze(['running']),
    to: (ctx) => (ctx.to === 'blocked' ? 'blocked' : 'pending'),
    actor: Object.freeze(['scheduler', 'host']),
    guards: Object.freeze([]),
    effects: Object.freeze(['clear-claim', 'retire-executors']),
    refusal: 'not-running',
    blockedCode: 'attempts-exhausted',
  },
  {
    id: 'T04',
    event: 'leaseExpired',
    from: Object.freeze(['running']),
    to: (ctx) => (ctx.to === 'blocked' ? 'blocked' : 'pending'),
    actor: Object.freeze(['scheduler', 'host']),
    guards: Object.freeze([]),
    effects: Object.freeze(['clear-claim']),
    refusal: 'not-running',
    blockedCode: 'attempts-exhausted',
  },
  {
    id: 'T05',
    event: 'handoffTakeover',
    from: Object.freeze(['running', 'reviewing', 'testing']),
    to: (ctx, from) => (from === 'running' ? 'pending' : from),
    actor: Object.freeze(['user']),
    guards: Object.freeze([]),
    effects: (ctx, entry) => (entry.from === 'running' ? ['clear-claim', 'retire-executors'] : ['requeue-stage-delivered-to']),
    refusal: 'no-takeover-targets',
  },
  {
    id: 'T06',
    event: 'autoResume',
    from: Object.freeze(['blocked']),
    to: (ctx) => (typeof ctx.restoreTo === 'string' && CARD_STATES.indexOf(ctx.restoreTo) >= 0 ? ctx.restoreTo : restoreTargetOf(ctx.task)),
    actor: Object.freeze(['host', 'scheduler']),
    guards: Object.freeze(['restore-target', 'phase-record-match', 'merge-open-for-phase']),
    effects: Object.freeze(['clear-claim']),
    refusal: 'not-blocked',
  },
  {
    id: 'T07',
    event: 'submit',
    from: Object.freeze(['running']),
    to: 'reviewing',
    actor: Object.freeze(['worker', 'user']),
    guards: Object.freeze(['kind-dev']),
    effects: Object.freeze(['clear-lease']),
    refusal: 'not-running',
  },
  {
    id: 'T08',
    event: 'update',
    from: CARD_STATES,
    to: (ctx, from) => from,
    actor: null,
    guards: Object.freeze([]),
    effects: Object.freeze([]),
    refusal: 'unknown-task',
  },
  {
    id: 'T09',
    event: 'block',
    from: Object.freeze(['pending', 'running', 'reviewing', 'testing']),
    to: 'blocked',
    // SM-3 tightens this to "own card"; the actors are the document's.
    actor: Object.freeze(['user', 'worker', 'agent', 'host', 'scheduler']),
    guards: Object.freeze([]),
    effects: Object.freeze(['clear-claim', 'retire-executors']),
    refusal: 'closed',
    refusals: { blocked: 'already-blocked' },
    blockedCode: 'manual-block',
  },
  {
    id: 'T10',
    event: 'cancel',
    from: Object.freeze(['pending', 'running', 'reviewing', 'testing', 'blocked']),
    to: 'cancelled',
    actor: Object.freeze(['user', 'worker', 'agent']),
    guards: Object.freeze([]),
    effects: Object.freeze(['clear-claim', 'retire-executors']),
    refusal: 'closed',
    refusals: { done: 'done', cancelled: 'already-cancelled' },
  },
  {
    id: 'T12',
    event: 'approveReview',
    from: Object.freeze(['reviewing']),
    to: 'testing',
    actor: Object.freeze(['reviewer', 'user']),
    guards: Object.freeze(['kind-dev', 'review-open']),
    effects: Object.freeze(['clear-lease']),
    refusal: 'not-reviewing',
  },
  {
    id: 'T13',
    event: 'approveReviewHostCheckFailed',
    from: Object.freeze(['reviewing']),
    to: reworkTarget,
    actor: Object.freeze(['reviewer', 'user', 'host']),
    guards: Object.freeze(['kind-dev', 'review-open']),
    effects: (ctx) => (ctx.hasImplementer === false ? ['clear-claim'] : ['renew-lease']),
    refusal: 'not-reviewing',
  },
  {
    id: 'T14',
    event: 'candidateConflict',
    from: Object.freeze(['reviewing']),
    to: 'blocked',
    actor: Object.freeze(['host', 'system']),
    guards: Object.freeze([]),
    effects: Object.freeze(['clear-claim', 'retire-executors']),
    refusal: 'not-reviewing',
    blockedCode: 'needs-rebase',
  },
  {
    id: 'T15',
    event: 'reviewRoundLimit',
    from: Object.freeze(['reviewing']),
    to: 'blocked',
    actor: Object.freeze(['host', 'system']),
    guards: Object.freeze([]),
    effects: Object.freeze(['clear-claim', 'retire-executors']),
    refusal: 'not-reviewing',
    blockedCode: 'review-round-limit',
  },
  {
    id: 'T16',
    event: 'requestChanges',
    from: Object.freeze(['reviewing']),
    to: reworkTarget,
    actor: Object.freeze(['reviewer', 'user']),
    guards: Object.freeze(['kind-dev', 'review-open']),
    effects: (ctx) => (ctx.hasImplementer === false ? ['clear-claim', 'clear-merge'] : ['renew-lease', 'clear-merge']),
    refusal: 'not-reviewing',
  },
  {
    id: 'T17',
    event: 'reviewTimeout',
    from: Object.freeze(['reviewing']),
    to: 'blocked',
    actor: Object.freeze(['host', 'system']),
    guards: Object.freeze([]),
    effects: Object.freeze(['clear-claim', 'retire-executors']),
    refusal: 'not-reviewing',
    blockedCode: 'review-timeout',
  },
  {
    id: 'T18',
    event: 'passTest',
    from: Object.freeze(['testing']),
    to: 'testing',
    actor: Object.freeze(['tester', 'user']),
    guards: Object.freeze(['kind-dev', 'test-open']),
    effects: Object.freeze([]),
    refusal: 'not-testing',
  },
  {
    id: 'T19',
    event: 'failTest',
    from: Object.freeze(['testing']),
    to: reworkTarget,
    actor: Object.freeze(['tester', 'user', 'host']),
    guards: Object.freeze(['kind-dev', 'test-open']),
    effects: (ctx) => (ctx.hasImplementer === false ? ['clear-claim', 'clear-merge'] : ['renew-lease', 'clear-merge']),
    refusal: 'not-testing',
  },
  {
    id: 'T20',
    event: 'testTimeout',
    from: Object.freeze(['testing']),
    to: 'blocked',
    actor: Object.freeze(['host', 'system']),
    guards: Object.freeze([]),
    effects: Object.freeze(['clear-claim', 'retire-executors']),
    refusal: 'not-testing',
    blockedCode: 'test-timeout',
  },
  {
    id: 'T21',
    event: 'mergeMerged',
    from: Object.freeze(['testing']),
    to: 'done',
    actor: Object.freeze(['host', 'user']),
    guards: Object.freeze(['merge-open', 'merge-eligible']),
    effects: Object.freeze(['clear-lease']),
    refusal: 'not-testing',
    // Idempotency key of the document's T21: a card already merged answers
    // already-merged instead of blaming its phase.
    refusals: { done: 'already-merged' },
  },
  {
    id: 'T22',
    event: 'mergeConflict',
    from: Object.freeze(['testing']),
    to: 'blocked',
    actor: Object.freeze(['host']),
    guards: Object.freeze(['merge-open']),
    effects: Object.freeze(['retire-executors']),
    refusal: 'no-open-merge',
    blockedCode: 'merge-conflict',
  },
  {
    id: 'T23',
    event: 'mergeFailed',
    from: Object.freeze(['testing']),
    to: 'blocked',
    actor: Object.freeze(['host']),
    guards: Object.freeze(['merge-open']),
    effects: Object.freeze(['retire-executors']),
    refusal: 'no-open-merge',
    blockedCode: 'merge-failed',
  },
  {
    id: 'T24',
    event: 'mergeRejected',
    from: Object.freeze(['reviewing', 'testing']),
    to: 'blocked',
    actor: Object.freeze(['user']),
    guards: Object.freeze(['merge-open']),
    effects: Object.freeze(['retire-executors']),
    refusal: 'no-open-merge',
    blockedCode: 'merge-rejected',
  },
  {
    // Extension row (no document number; the document's T25 is the rebuild the
    // host performs as a retest when the TESTED branch head did not move).
    id: 'T25b',
    event: 'targetDriftRetest',
    from: Object.freeze(['testing']),
    to: 'testing',
    actor: Object.freeze(['host']),
    guards: Object.freeze(['merge-open']),
    effects: Object.freeze([]),
    refusal: 'not-testing',
  },
  {
    id: 'T25',
    event: 'baseOnlyDrift',
    from: Object.freeze(['testing']),
    to: 'testing',
    actor: Object.freeze(['host']),
    guards: Object.freeze(['merge-open']),
    effects: Object.freeze([]),
    refusal: 'not-testing',
  },
  {
    id: 'T27',
    event: 'refreshMerge',
    from: Object.freeze(['reviewing', 'testing', 'blocked']),
    to: 'reviewing',
    actor: Object.freeze(['user', 'worker', 'host', 'agent']),
    // The document accepts blocked(merge-*) only: a card paused by a timeout or a
    // manual block must not escape through a refresh. The guard is enforced at the
    // MODEL boundary, not only in the action.
    guards: Object.freeze(['merge-exists', 'merge-blocked-reason', 'merge-change']),
    effects: Object.freeze(['clear-lease']),
    refusal: 'not-mergeable-phase',
    refusals: { done: 'closed', cancelled: 'closed' },
  },
  {
    id: 'T28',
    event: 'unblock',
    from: Object.freeze(['blocked']),
    to: (ctx) => (typeof ctx.restoreTo === 'string' && CARD_STATES.indexOf(ctx.restoreTo) >= 0 ? ctx.restoreTo : restoreTargetOf(ctx.task)),
    // merge-open-for-phase runs before phase-record-match: a card paused by a
    // merge outcome must answer merge-unresolved (refreshMerge is its only exit),
    // not a round-record mismatch.
    guards: Object.freeze(['unblockable', 'restore-target', 'merge-open-for-phase', 'phase-record-match']),
    actor: Object.freeze(['user', 'worker', 'agent']),
    // Document T28/X21: returning to the pool clears the request; a stage restore
    // keeps it (the paused round resumes on the same candidate).
    effects: (ctx, entry) => (entry.to === 'pending' ? ['clear-claim', 'clear-merge'] : ['clear-claim']),
    refusal: 'not-blocked',
  },
  {
    id: 'T29',
    event: 'retry',
    from: Object.freeze(['blocked', 'pending']),
    to: 'pending',
    actor: Object.freeze(['user', 'worker', 'agent']),
    guards: Object.freeze(['retryable']),
    effects: Object.freeze(['reset-attempts', 'reset-interruptions', 'clear-executors', 'clear-dispatch', 'clear-claim', 'clear-merge']),
    refusal: 'not-retryable',
  },
  {
    id: 'T30',
    event: 'reopen',
    from: Object.freeze(['done', 'cancelled', 'blocked']),
    to: 'pending',
    // SM-3 restricts reopen to the user; today an Agent may reopen its own card.
    actor: Object.freeze(['user', 'agent', 'worker']),
    guards: Object.freeze([]),
    effects: Object.freeze(['new-generation']),
    refusal: 'not-closed',
  },
  {
    id: 'T31',
    event: 'report',
    from: Object.freeze(['running']),
    to: 'done',
    actor: Object.freeze(['worker', 'user']),
    guards: Object.freeze(['kind-investigate']),
    effects: Object.freeze(['clear-claim', 'retire-executors', 'clear-dispatch']),
    refusal: 'not-running',
  },
  {
    id: 'T32',
    event: 'heartbeat',
    from: Object.freeze(['running']),
    to: 'running',
    actor: Object.freeze(['host', 'scheduler']),
    guards: Object.freeze([]),
    effects: Object.freeze(['renew-lease']),
    refusal: 'not-running',
  },
])

/** The unique event names, board order. */
export const EVENTS = Object.freeze(TRANSITIONS.map((row) => row.event))

function rowFor(event) {
  for (const row of TRANSITIONS) if (row.event === event) return row
  return undefined
}

function fromMatches(row, from) {
  if (from === null || from === undefined) return row.from.length === 0
  return row.from.indexOf(from) >= 0
}

function refusalOf(row, from) {
  if (row.refusals !== undefined && row.refusals !== null && typeof from === 'string' && Object.prototype.hasOwnProperty.call(row.refusals, from)) {
    return row.refusals[from]
  }
  if (CLOSED_STATES.indexOf(from) >= 0) return 'closed'
  return row.refusal === undefined ? 'illegal-transition' : row.refusal
}

function evalGuard(name, ctx, entry) {
  const guard = GUARDS[name]
  if (guard === undefined) return { ok: false, code: 'unknown-guard', message: 'no guard named ' + String(name) + ' is declared' }
  const verdict = guard(ctx, entry)
  if (verdict === true) return true
  if (typeof verdict === 'string') return { ok: false, code: verdict, message: 'the ' + name + ' guard refused ' + stateName(entry.from) + ' for ' + entry.event }
  return verdict
}

/**
 * The single transition entry: (event, from, context) -> { ok, to, row } or a
 * typed { ok: false, code, message }. Pure: it never mutates the task.
 *
 * Order of checks is the document's: is the event declared at all, is the
 * (event, from) pair legal, is the actor allowed, do the guards pass.
 */
export function transition(event, from, context) {
  const ctx = context === undefined || context === null ? {} : context
  const row = rowFor(event)
  if (row === undefined) return refusal('unknown-event', 'no transition is declared for event ' + String(event))
  const state = from === undefined ? null : from
  if (state !== null && CARD_STATES.indexOf(state) < 0) return refusal('unknown-status', 'cannot transition from unknown status ' + JSON.stringify(state))
  if (fromMatches(row, state) !== true) {
    const code = refusalOf(row, state)
    const legal = row.from.length === 0 ? 'none (create)' : row.from.join(', ')
    return refusal(code, stateName(state) + ' does not accept event ' + String(event) + ' (legal from: ' + legal + ')', { event: event, from: state, row: row.id })
  }
  if (ctx.actor !== undefined && ctx.actor !== null && Array.isArray(row.actor) && row.actor.indexOf(ctx.actor) < 0) {
    return refusal('forbidden', 'event ' + String(event) + ' accepts ' + row.actor.join('/') + ', not ' + String(ctx.actor), { event: event, from: state, row: row.id })
  }
  const to = typeof row.to === 'function' ? row.to(ctx, state) : row.to
  if (to === null || CARD_STATES.indexOf(to) < 0) {
    return refusal('invalid-target', 'event ' + String(event) + ' resolved to an invalid target ' + JSON.stringify(to), { event: event, from: state, row: row.id })
  }
  const entry = { event: event, from: state, to: to, row: row }
  for (const name of row.guards) {
    const verdict = evalGuard(name, ctx, entry)
    if (verdict !== true) {
      return refusal(verdict.code, verdict.message === undefined ? 'the ' + name + ' guard refused event ' + String(event) : verdict.message, {
        event: event,
        from: state,
        to: to,
        row: row.id,
      })
    }
  }
  return { ok: true, from: state, to: to, row: row }
}

/**
 * The single status WRITE in the production code. Validates the transition,
 * applies the row's declared entry effects (lease/assignee/executor/dispatch/
 * merge cleanup and the blockedReason invariant) and then sets task.status.
 *
 * Callers keep their event payload writes (commit, review round, dispatch text)
 * — those are not state-entry side effects.
 */
export function enterState(task, event, context, now) {
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    return refusal('invalid-task', 'enterState needs the card it is moving')
  }
  const ctx = context === undefined || context === null ? {} : context
  const from = task.status === undefined ? null : task.status
  const decided = transition(event, from, Object.assign({ task: task }, ctx))
  if (decided.ok !== true) return decided
  const at = Number.isFinite(now) ? now : Date.now()
  applyEntry(task, decided.row, { from: decided.from, to: decided.to, now: at, context: ctx, row: decided.row })
  task.status = decided.to
  return { ok: true, from: decided.from, to: decided.to, row: decided.row }
}
