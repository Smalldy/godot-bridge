/**
 * The frozen card read model — TaskSummary and TaskDetail (T-230, Phase 0).
 *
 * One card used to leave the server in four different shapes:
 *
 *   /state.tasks   api.summaryOf      writeFileCount, events, no writeFiles
 *   /state.queue   service.summary    writeFiles, verify, liveExecutors: number
 *   /list          api.summaryOf
 *   tool list      service.summary
 *   tool board /   api.detailOf       summary + spec/acceptance/evidence/history
 *   full /state
 *
 * The field sets, the types and even the nullability disagreed. That is not a
 * cosmetic drift: it cost a real field (T-225's review.deliveredTo vanished from
 * the summary and the agent sidebar showed 未分配), it forced the UI to teach
 * itself two shapes of the same number (T-228's writeFiles array vs
 * writeFileCount), and it made every new reader guess which vocabulary it was
 * talking to.
 *
 * This module is now the ONE projection every read surface goes through:
 *
 *   buildTaskSummary(board, task, now, view)   the TaskSummary contract
 *   buildTaskDetail(board, task, now, view)    TaskSummary + the detail fields
 *   buildBoardSummary(board, now, view, rows)  a board/list page of summaries
 *
 * Both builders are PURE. Everything a summary cannot derive from the board
 * alone — the in-process lock table (waitingReason 'file-lock'), the stage slots
 * (queuePosition, review/test.deliveredAt), the testing candidate checkout —
 * arrives through the fourth argument `view`:
 *
 *   view.locks       the in-memory lock table (locks.mjs), or undefined
 *   view.stageSlot   (task, 'reviewer'|'tester') -> { at, position } | null
 *   view.candidate   (task) -> the small candidate object, or null
 *
 * A caller that passes the same view therefore produces the SAME summary on
 * every surface; api.mjs builds exactly one view per request and hands it to
 * /state.tasks, /state.queue, /list and the tool list.
 *
 * TaskDetail is a STRICT superset of TaskSummary: every summary field keeps its
 * name and its type in detail, and a detail-only field lives in
 * TASK_DETAIL_ONLY_FIELDS so it has exactly one, checkable home. The nested
 * records follow the same rule — a summary keeps the compact stage/merge facts
 * and the detail keeps those facts AND the detail-class payload (strings, file
 * lists, full records).
 *
 * The legacy `service.summary` / `service.detail` exports delegate here (a
 * delegation, so existing importers keep working); no surface may grow its own
 * card vocabulary again. scripts/test/read-model-contract.test.mjs pins every
 * claim above: the four summary surfaces carry the same field set, the same
 * types and the same values for the same card, and the detail is the superset.
 */

import { INVESTIGATE_KIND, TASK_LEASE_REMINDER_MS, normaliseVerification } from './schema.mjs'
import { conflictsFor } from './locks.mjs'
import { blockedReasonOf, phaseOf } from './state-machine.mjs'

/**
 * The top-level fields a TaskSummary carries, in contract order. A field added
 * to buildTaskSummary must be added here (and, when it is not detail-class, to
 * the summary of every surface at once — it is the same builder, so that is
 * automatic; the list exists to keep the contract explicit and testable).
 */
export const TASK_SUMMARY_FIELDS = Object.freeze([
  'id',
  'title',
  'status',
  'state',
  'phase',
  'blockedReason',
  'kind',
  'reportSummary',
  'ownerSession',
  'priority',
  'dependsOn',
  'dependency',
  'writeFileCount',
  'verification',
  'target',
  'base',
  'targetBase',
  'verifyFingerprint',
  'branch',
  'worktree',
  'worktreeError',
  'commit',
  'requiredRole',
  'merge',
  'review',
  'test',
  'assignee',
  'attempts',
  'maxAttempts',
  'interruptions',
  'executors',
  'liveExecutors',
  'leaseUntil',
  'leaseRemaining',
  'leaseExpired',
  'leaseReminder',
  'dispatch',
  'waitingReason',
  'candidate',
  'queuePosition',
  'createdAt',
  'updatedAt',
  'events',
])

/**
 * The fields ONLY a TaskDetail carries. A summary must never grow one of them
 * (that is what made a 221-card /state answer 4.85 MB); the detail keeps them so
 * the drawer and /task lose nothing.
 */
export const TASK_DETAIL_ONLY_FIELDS = Object.freeze([
  'spec',
  'acceptance',
  'evidence',
  'report',
  'createdBy',
  'history',
  'writeFiles',
  'verify',
  'actualFiles',
  'lastAssignee',
  'waitingDetail',
])

/** How many history rows the summary keeps as `events` (the newest two). */
export const SUMMARY_EVENT_LIMIT = 2
/** How many executor identities the summary keeps (the newest three). */
export const SUMMARY_EXECUTOR_LIMIT = 3
/** How long an event note may be before it is truncated on the summary. */
const SUMMARY_NOTE_LIMIT = 120

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function recordOrNull(value) {
  return isRecord(value) ? value : null
}

function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

function textOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}

function listOf(value) {
  return Array.isArray(value) ? value : []
}

function tasksOf(board) {
  return listOf(board === null || board === undefined ? undefined : board.tasks)
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0
}

function idOf(id) {
  if (typeof id === 'string') return id
  return id === undefined || id === null ? null : String(id)
}

function findTaskIn(tasks, id) {
  for (const task of tasks) {
    if (task !== null && task !== undefined && task.id === id) return task
  }
  return undefined
}

// ── dependency / readiness projections ─────────────────────────────────────

/**
 * Does this dependency satisfy its dependents?
 *
 * A task must be DONE and — when it has a merge request — MERGED. Starting a
 * dependent on an unmerged branch gives that dependent a stale base and all but
 * guarantees a conflict later. A legacy task with no merge record keeps the old
 * "done is enough" behaviour, so historical tasks do not block the board.
 */
function dependencySatisfied(dependency) {
  if (dependency.status !== 'done') return false
  // An investigation delivers a report, not a branch: done is the whole story.
  if (dependency.kind === INVESTIGATE_KIND) return true
  if (dependency.merge === null || dependency.merge === undefined) return true
  return dependency.merge.status === 'merged'
}

/**
 * T-242: the index row of a done card that has moved to the cold archive, or
 * undefined. The board carries one small row per archived card so a dependency
 * never needs a second file read (and the hot path stays a single stat).
 */
function archivedDependencyOf(board, id) {
  if (board === null || typeof board !== 'object' || !Array.isArray(board.archivedDone)) return undefined
  for (const row of board.archivedDone) {
    if (row !== null && typeof row === 'object' && String(row.id) === String(id)) return row
  }
  return undefined
}

/** The archived equivalent of dependencySatisfied(): only a DONE card satisfies,
 * and its merge state still decides whether a dependent may start. */
function archivedDependencySatisfied(row) {
  if (row.status !== 'done') return false
  if (row.kind === INVESTIGATE_KIND) return true
  if (row.mergeStatus === null || row.mergeStatus === undefined) return true
  return row.mergeStatus === 'merged'
}

/** Dependencies that are missing or cancelled make the task BROKEN (visible to
 * the user instead of waiting forever). A done-but-unmerged dependency is not
 * broken: it is still WAITING, and shows up in waitingOn. */
export function dependencyInfo(board, task) {
  const waitingOn = []
  const brokenOn = []
  const dependsOn = listOf(task === null || task === undefined ? undefined : task.dependsOn)
  for (const id of dependsOn) {
    const dependency = findTaskIn(tasksOf(board), id)
    if (dependency === undefined) {
      // T-242: a done card may have moved to the cold archive. Its index row is
      // the dependency evidence — the SAME done/merged rule as a hot card — so
      // archiving a prerequisite can never turn a dependent into 'broken'.
      const archived = archivedDependencyOf(board, id)
      if (archived !== undefined) {
        if (!archivedDependencySatisfied(archived)) waitingOn.push(id)
        continue
      }
      brokenOn.push(id)
      continue
    }
    if (dependency.status === 'cancelled') {
      brokenOn.push(id)
      continue
    }
    if (!dependencySatisfied(dependency)) waitingOn.push(id)
  }
  return {
    state: brokenOn.length > 0 ? 'broken' : waitingOn.length > 0 ? 'waiting' : 'ready',
    waitingOn: waitingOn,
    brokenOn: brokenOn,
  }
}

/** Pending tasks whose dependencies are all done (and merged, when they have a
 * merge request), in dispatch order: priority desc, then creation time, then id. */
export function readyTasks(board) {
  return tasksOf(board)
    .filter((task) => task !== null && task !== undefined && task.status === 'pending' && dependencyInfo(board, task).state === 'ready')
    .sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority
      const created = Date.parse(left.createdAt) - Date.parse(right.createdAt)
      if (created !== 0) return created
      return left.id.localeCompare(right.id)
    })
}

/** The board's counters, derived from the same readiness rule the dispatcher
 * uses (so the header can never promise a card the scheduler will not start). */
export function counts(board) {
  const tasks = tasksOf(board)
  const out = {
    total: tasks.length,
    pending: 0,
    ready: 0,
    running: 0,
    reviewing: 0,
    testing: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
    // T-131: how many of the running cards are investigations (they are also
    // counted in `running`, so the existing totals stay additive).
    investigating: 0,
  }
  const ready = new Set(readyTasks(board).map((task) => task.id))
  for (const task of tasks) {
    out[task.status] = (out[task.status] || 0) + 1
    if (task.status === 'running' && task.kind === INVESTIGATE_KIND) out.investigating += 1
    if (ready.has(task.id)) out.ready += 1
  }
  return out
}

/** Executor identities still counted as live: handed the task, never retired.
 * A running claim always counts as one, even on a board written before the ledger
 * existed, so the panel never reports "0 live executors" for running work. */
export function liveExecutors(task) {
  const list = task === null || task === undefined || !Array.isArray(task.executors) ? [] : task.executors
  const live = list.filter((entry) => isRecord(entry) && (entry.retiredAt === null || entry.retiredAt === undefined))
  if (live.length === 0 && task !== null && task !== undefined && task.status === 'running' && task.assignee !== null && task.assignee !== undefined) {
    return [{ name: String(task.assignee.name), session: task.assignee.session === undefined ? null : task.assignee.session, at: null, retiredAt: null, retiredReason: null }]
  }
  return live
}

// ── the view: the process facts a pure projection cannot know ───────────────

function viewOf(view) {
  return isRecord(view) ? view : {}
}

function slotFor(task, kind, view) {
  const read = viewOf(view).stageSlot
  if (typeof read !== 'function') return null
  const slot = read(task, kind)
  return isRecord(slot) ? slot : null
}

function deliveredAtOf(slot) {
  if (slot === null) return null
  return Number.isFinite(slot.at) ? new Date(slot.at).toISOString() : null
}

/**
 * Which stage slot describes the card RIGHT NOW (or nothing). Only the current
 * stage's slot may claim a queue position: falling back to the other stage's
 * slot is what let a stale review position reappear during testing.
 */
function currentStageSlot(task, view) {
  if (task.status === 'reviewing') return slotFor(task, 'reviewer', view)
  if (task.status === 'testing') return slotFor(task, 'tester', view)
  return null
}

function queuePositionOf(task, view) {
  const slot = currentStageSlot(task, view)
  if (slot === null || Number.isFinite(slot.at) || !Number.isFinite(slot.position)) return null
  return slot.position
}

function candidateOfView(task, view) {
  const read = viewOf(view).candidate
  if (typeof read !== 'function') return null
  const candidate = read(task)
  return isRecord(candidate) ? candidate : null
}

/**
 * Why a PENDING card is not being dispatched right now. The board's own words
 * (`waitingReason`) always win; otherwise the derivation names the first gate
 * the dispatcher would fail, in the dispatcher's order.
 */
function waitingReasonOf(board, task, locks) {
  if (typeof task.waitingReason === 'string' && task.waitingReason !== '') return task.waitingReason
  if (task.status !== 'pending') return null
  const dispatch = isRecord(board === null || board === undefined ? null : board.dispatch) ? board.dispatch : {}
  if (dispatch.state !== 'running') return 'dispatch-paused'
  const dependency = dependencyInfo(board, task)
  if (dependency.state === 'broken') return 'dependency-broken'
  if (dependency.state === 'waiting') return 'dependency'
  const files = listOf(task.writeFiles)
  if (files.length > 0 && isRecord(locks) && conflictsFor(locks, files, 'task:' + String(task.id)).length > 0) return 'file-lock'
  const running = tasksOf(board).filter((other) => other !== null && other !== undefined && other.status === 'running').length
  const limit = Number.isFinite(dispatch.maxConcurrent) ? dispatch.maxConcurrent : 1
  if (running >= limit) return 'concurrency'
  return null
}

// ── the compact nested records (summary) ───────────────────────────────────

/** The identity a stage was delivered to — name + id, never the record. */
function compactDeliveredTo(record) {
  const delivered = isRecord(record) && isRecord(record.deliveredTo) ? record.deliveredTo : null
  if (delivered === null) return null
  const name = textOrNull(delivered.name)
  const id = textOrNull(delivered.id)
  if (name === null && id === null) return null
  return { name: name, id: id }
}

/**
 * The merge-request facts a summary carries: the badge state, the commit, and
 * the CLASS of each detail string (lengths and file counts) so the board can
 * say "declared 3 / actual 4" without receiving the strings themselves.
 */
function compactMerge(merge) {
  const source = recordOrNull(merge)
  if (source === null) return null
  return {
    status: textOrNull(source.status),
    base: textOrNull(source.base),
    target: textOrNull(source.target),
    head: textOrNull(source.head),
    mergeCommit: textOrNull(source.mergeCommit),
    reviewer: textOrNull(source.reviewer),
    conflict: source.conflict === undefined ? null : source.conflict,
    at: textOrNull(source.at),
    declaredCount: listOf(source.declaredFiles).length,
    actualCount: listOf(source.actualFiles).length,
    outputLength: typeof source.output === 'string' ? source.output.length : 0,
    testsLength: typeof source.tests === 'string' ? source.tests.length : 0,
    // T-156: the audit signals are small facts, not detail-class strings — the
    // panel shows a drift/verify badge straight from /state, like queue[] does.
    targetDrift: source.targetDrift === undefined ? null : source.targetDrift,
    verifyChanged: source.verifyChanged === true,
    verifyFingerprints: source.verifyFingerprints === undefined ? null : source.verifyFingerprints,
  }
}

function compactReview(review, deliveredAt) {
  const source = recordOrNull(review)
  if (source === null) return null
  return {
    status: textOrNull(source.status),
    by: textOrNull(source.by),
    byName: textOrNull(source.byName),
    at: textOrNull(source.at),
    attempt: numberOrZero(source.attempt),
    deliveredAt: deliveredAt === undefined ? null : deliveredAt,
    // T-225: the stage rows need the delivery identity, not the record.
    deliveredTo: compactDeliveredTo(source),
  }
}

function compactTest(test, deliveredAt) {
  const source = recordOrNull(test)
  if (source === null) return null
  return {
    status: textOrNull(source.status),
    by: textOrNull(source.by),
    byName: textOrNull(source.byName),
    at: textOrNull(source.at),
    attempt: numberOrZero(source.attempt),
    deliveredAt: deliveredAt === undefined ? null : deliveredAt,
    evidenceLength: typeof source.evidence === 'string' ? source.evidence.length : 0,
    // T-225: same compact delivery identity as the review round.
    deliveredTo: compactDeliveredTo(source),
  }
}

function reportSummaryOf(report) {
  const source = recordOrNull(report)
  if (source === null) return null
  return {
    summary: textOrEmpty(source.summary),
    createdAt: textOrNull(source.createdAt),
    by: textOrNull(source.by),
    byName: textOrNull(source.byName),
    evidence: listOf(source.evidence).length,
    artifacts: listOf(source.artifacts).length,
    hasBody: typeof source.body === 'string' && source.body !== '',
  }
}

function eventsOf(history) {
  return listOf(history)
    .slice(-SUMMARY_EVENT_LIMIT)
    .map((entry) => {
      const row = recordOrNull(entry) === null ? {} : entry
      return {
        at: row.at === undefined ? null : row.at,
        by: row.by === undefined ? null : row.by,
        byName: row.byName === undefined ? null : row.byName,
        from: row.from === undefined ? null : row.from,
        to: row.to === undefined ? null : row.to,
        note: typeof row.note === 'string' ? row.note.slice(0, SUMMARY_NOTE_LIMIT) : '',
      }
    })
}

function verificationOf(task) {
  return normaliseVerification(task === null || task === undefined ? undefined : task.verification)
}

function leaseFactsOf(task, at) {
  const until = typeof task.leaseUntil === 'string' && task.leaseUntil !== '' ? Date.parse(task.leaseUntil) : Number.NaN
  if (!Number.isFinite(until)) return { leaseRemaining: null, leaseExpired: false, leaseReminder: false }
  return {
    leaseRemaining: Math.max(0, until - at),
    leaseExpired: until <= at,
    leaseReminder: task.status === 'running' && until > at && until - at <= TASK_LEASE_REMINDER_MS,
  }
}

// ── the contract builders ──────────────────────────────────────────────────

/**
 * ONE card as a TaskSummary.
 *
 * The fields are the panel's whole vocabulary: the card identity, the derived
 * state/phase, the dependency verdict, the file COUNT (never the list), the
 * compact merge/review/test records, the claim/lease facts, the current queue
 * slot and the newest two history rows. Everything detail-class (spec,
 * acceptance, evidence, history, writeFiles, verify, the full stage records)
 * lives in buildTaskDetail and is fetched on demand.
 *
 * No own field is ever `undefined`: a missing optional fact is `null`, so a
 * lossless JSON walker (tool.mjs) never has to drop or rewrite a key.
 *
 * @param board  the board the card belongs to (dependencies, dispatch, counts).
 * @param task   one card of that board.
 * @param now    the clock, in ms (lease projection).
 * @param view   optional process facts: { locks, stageSlot, candidate }.
 */
export function buildTaskSummary(board, task, now, view) {
  const source = task === null || task === undefined ? {} : task
  const at = Number.isFinite(now) ? now : Date.now()
  const lease = leaseFactsOf(source, at)
  const verification = verificationOf(source)
  const reviewSlot = slotFor(source, 'reviewer', view)
  const testSlot = slotFor(source, 'tester', view)
  return {
    id: idOf(source.id),
    title: textOrEmpty(source.title),
    status: textOrNull(source.status),
    // T-201: state is the persisted authority; phase is the derived stage
    // projection (a tested card waiting for its merge reads phase 'merge').
    state: textOrNull(source.status),
    phase: phaseOf(source),
    blockedReason: blockedReasonOf(source),
    // T-131: the panel needs the kind to render an investigation and the
    // headline to show its report without fetching the detail.
    kind: textOrNull(source.kind) === null ? 'dev' : source.kind,
    reportSummary: reportSummaryOf(source.report),
    // T-152: the card's owner is readable from the summary too, so the panel can
    // group cards by participating session without a /task round-trip per card.
    ownerSession: textOrNull(source.ownerSession),
    priority: numberOrZero(source.priority),
    dependsOn: listOf(source.dependsOn),
    dependency: dependencyInfo(board, source),
    writeFileCount: listOf(source.writeFiles).length,
    // T-191: the summary names HOW MANY executable probes the card declares; the
    // probe list itself is detail-class and rides /task.
    verification: { probeCount: verification.probes.length },
    target: textOrNull(source.target),
    base: textOrNull(source.base),
    // T-156: the dispatch/submit audit baseline rides the compact summary too.
    targetBase: textOrNull(source.targetBase),
    verifyFingerprint: textOrNull(source.verifyFingerprint),
    branch: textOrNull(source.branch),
    worktree: textOrNull(source.worktree),
    worktreeError: textOrNull(source.worktreeError),
    commit: textOrNull(source.commit),
    requiredRole: textOrNull(source.requiredRole),
    merge: compactMerge(source.merge),
    review: compactReview(source.review, deliveredAtOf(reviewSlot)),
    test: compactTest(source.test, deliveredAtOf(testSlot)),
    assignee: recordOrNull(source.assignee),
    attempts: numberOrZero(source.attempts),
    maxAttempts: numberOrZero(source.maxAttempts),
    interruptions: numberOrZero(source.interruptions),
    executors: listOf(source.executors).slice(-SUMMARY_EXECUTOR_LIMIT),
    // Live executors carry the project they were dispatched for, so a reader can
    // see that a member belongs to this board (and a cross-project borrow would
    // be visible instead of silent).
    liveExecutors: liveExecutors(source),
    leaseUntil: textOrNull(source.leaseUntil),
    leaseRemaining: lease.leaseRemaining,
    leaseExpired: lease.leaseExpired,
    leaseReminder: lease.leaseReminder,
    dispatch: recordOrNull(source.dispatch),
    waitingReason: waitingReasonOf(board, source, viewOf(view).locks),
    candidate: candidateOfView(source, view),
    queuePosition: queuePositionOf(source, view),
    createdAt: textOrNull(source.createdAt),
    updatedAt: textOrNull(source.updatedAt),
    events: eventsOf(source.history),
  }
}

/**
 * ONE card as a TaskDetail: the TaskSummary plus every detail-class field.
 *
 * The nested records are extended the same way — the full merge request keeps
 * its strings/files, the full review/test records keep reasons/evidence/record
 * AND the compact facts (status/by/byName/at/attempt/deliveredAt/deliveredTo),
 * so a detail reader never has to know which of the two vocabularies it holds.
 */
export function buildTaskDetail(board, task, now, view) {
  const source = task === null || task === undefined ? {} : task
  const summary = buildTaskSummary(board, task, now, view)
  const review = recordOrNull(source.review)
  const test = recordOrNull(source.test)
  const reviewSlot = slotFor(source, 'reviewer', view)
  const testSlot = slotFor(source, 'tester', view)
  const verification = verificationOf(source)
  return Object.assign(summary, {
    spec: textOrEmpty(source.spec),
    acceptance: textOrEmpty(source.acceptance),
    evidence: textOrEmpty(source.evidence),
    report: recordOrNull(source.report),
    createdBy: textOrNull(source.createdBy),
    history: listOf(source.history),
    writeFiles: listOf(source.writeFiles),
    // `verify` is the host mechanical check { command, timeoutMs } or null; it is
    // an ordinary task field, so the detail passes the stored value through.
    verify: source.verify === undefined ? null : source.verify,
    // The summary names the probe COUNT; the detail carries the probe list.
    verification: { probeCount: verification.probes.length, probes: verification.probes },
    actualFiles: listOf(source.actualFiles),
    lastAssignee: recordOrNull(source.lastAssignee),
    waitingDetail: textOrNull(source.waitingDetail),
    merge: fullRecord(compactMerge(source.merge), source.merge),
    review: fullRecord(compactReview(review, deliveredAtOf(reviewSlot)), review),
    test: fullRecord(compactTest(test, deliveredAtOf(testSlot)), test),
  })
}

/**
 * A detail-class record: the raw board record (its strings, file lists, reasons
 * and record payload) with every compact field it might be missing filled in, so
 * the detail's nested record is a strict superset of the summary's.
 */
function fullRecord(compact, raw) {
  if (compact === null) return null
  const out = Object.assign({}, recordOrNull(raw) === null ? {} : raw)
  for (const key of Object.keys(compact)) {
    if (out[key] === undefined) out[key] = compact[key]
  }
  return out
}

/**
 * The board's summary projection: the counters the header renders plus one
 * TaskSummary per card. `rows` selects the cards (a filtered /list page, a
 * status-filtered tool list); omitted, every card of the board is projected.
 */
export function buildBoardSummary(board, now, view, rows) {
  const tasks = Array.isArray(rows) ? rows : tasksOf(board)
  return {
    counts: counts(board),
    tasks: tasks.map((task) => buildTaskSummary(board, task, now, view)),
  }
}
