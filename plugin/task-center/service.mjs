/**
 * Task center — the pure model.
 *
 * No Cordis, no filesystem, no timers. Every function takes the current board,
 * returns the next board plus the events it produced, and uses a returned
 * { ok: false, code, message } for a refusal. The HTTP route, the tool and the
 * scheduler all call these same functions, which keeps the three surfaces from
 * inventing their own rules.
 *
 * Statuses (T-201): the state set and every legal move live in state-machine.mjs.
 * This module never decides a transition itself: it asks enterState() for it.
 *   pending    not dispatched; readiness is DERIVED from dependsOn
 *   running    owned by a worker, with a lease
 *   reviewing  submitted; a review round is open
 *   testing    a test round is open (test.passed + merge.open projects phase 'merge')
 *   done       finished; satisfies dependents
 *   blocked    paused for a typed reason (blockedReason), waiting for a human
 *   cancelled  abandoned
 *
 * Dependencies point from a task to its prerequisites: B.dependsOn = [A] means
 * A <- B (A must be done before B runs).
 */

import {
  CLOSED_STATUSES,
  INVESTIGATE_KIND,
  REPORT_LIMITS,
  TASK_HEARTBEAT_MS,
  TASK_LEASE_MS,
  TASK_LEASE_EXTENSION_MAX_MS,
  normaliseDispatch,
  normaliseEvidence,
  normaliseKind,
  normaliseMerge,
  truncateBytes,

  validateVerification,
  validateVerify,
  CARD_MODEL_LIMITS,
  productionLinesOfArtifact,
  validateCardModel,
} from './schema.mjs'
import { normaliseReviewRecord, normaliseTestRecord } from './stage-contract.mjs'
// T-201: every card status write goes through the state machine (one table).
import { enterState, restoreTargetOf, transition } from './state-machine.mjs'
// T-230: the ONE card read model. These builders are pure; the summary/detail
// exports below are the compatibility delegation, not a second vocabulary.
import { buildTaskDetail, buildTaskSummary, counts, dependencyInfo, liveExecutors, readyTasks } from './read-model.mjs'
export { counts, dependencyInfo, liveExecutors, readyTasks }

const iso = (now) => new Date(now).toISOString()
const clone = (value) => JSON.parse(JSON.stringify(value))

function fail(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
}

function done(board, events, extra) {
  return Object.assign({ ok: true, board: board, events: events === undefined ? [] : events }, extra === undefined ? {} : extra)
}

function findTaskIn(tasks, id) {
  for (const task of tasks) if (task.id === id) return task
  return undefined
}

export function findTask(board, id) {
  return findTaskIn(board.tasks, id)
}

function pushHistory(task, entry) {
  task.history.push({
    at: entry.at,
    by: entry.by,
    byName: entry.byName === undefined || entry.byName === null || entry.byName === '' ? null : String(entry.byName),
    from: entry.from === undefined ? task.status : entry.from,
    to: entry.to === undefined ? task.status : entry.to,
    note: entry.note === undefined ? '' : entry.note,
  })
}

function touch(task, now) {
  task.updatedAt = iso(now)
}

/** How many infrastructure interruptions may hit one task before the streak is
 * treated as a real problem. Deliberately independent of maxAttempts: a host
 * reload is not the worker's fault, but five reloads with nothing committed IS a
 * dispatch loop that must stop. */
export const INTERRUPTION_LIMIT = 5

const MAX_EXECUTORS = 8

/** The identity a task remembers for one handover; a task never ran without one. */
function executorOf(assignee, now) {
  return {
    name: assignee === null || assignee === undefined ? 'unknown' : String(assignee.name),
    session: assignee === null || assignee === undefined || assignee.session === undefined ? null : assignee.session,
    at: iso(now),
    retiredAt: null,
    retiredReason: null,
  }
}

/** Append the executor this claim hands the task to, keeping the list bounded. */
function pushExecutor(target, assignee, now) {
  const list = Array.isArray(target.executors) ? target.executors.slice() : []
  list.push(executorOf(assignee, now))
  target.executors = list.length > MAX_EXECUTORS ? list.slice(list.length - MAX_EXECUTORS) : list
}

/**
 * The slot number this attempt occupies. `attempts` alone is not enough once a
 * host restart REFUNDS an attempt: without the interruption count, attempt 2
 * would reuse attempt 1's worker name and worktree directory — a taken teammate
 * name and a colliding checkout. Both counters are monotonic in the slot.
 */
export function attemptSlot(task) {
  if (task === null || task === undefined) return 1
  const attempts = Number.isFinite(task.attempts) ? Math.max(0, Math.floor(task.attempts)) : 0
  const interruptions = Number.isFinite(task.interruptions) ? Math.max(0, Math.floor(task.interruptions)) : 0
  return attempts + interruptions + 1
}

function normaliseList(value) {
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

/** True when start can reach target by following dependsOn edges. */
function reaches(tasksById, start, target) {
  const stack = [start]
  const seen = new Set()
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    const task = tasksById.get(id)
    if (task === undefined) continue
    for (const dep of task.dependsOn) stack.push(dep)
  }
  return false
}

/**
 * Validate a proposed dependsOn list for one task.
 *
 * @param board - current board.
 * @param taskId - the task being written (undefined for a create whose id is
 *   not allocated yet; self-reference is then impossible).
 * @param dependsOn - proposed ids.
 */
export function validateDepends(board, taskId, dependsOn, selfTarget) {
  const ids = normaliseList(dependsOn)
  if (taskId !== undefined && ids.indexOf(taskId) >= 0) return fail('self-dependency', 'a task cannot depend on itself')
  const byId = new Map(board.tasks.map((task) => [task.id, task]))
  const self = taskId === undefined ? null : byId.get(taskId)
  const selfBranch = selfTarget === undefined ? (self === null ? null : normaliseTarget(self.target)) : selfTarget
  for (const id of ids) {
    const task = byId.get(id)
    if (task === undefined) return fail('unknown-dependency', 'depends on ' + id + ', which does not exist')
    if (normaliseTarget(task.target) !== selfBranch) {
      return fail(
        'cross-target-dependency',
        'depends on ' + id + ' (' + (normaliseTarget(task.target) === null ? 'default target' : normaliseTarget(task.target)) + ') but this task targets ' + (selfBranch === null ? 'the default target' : selfBranch) + '; dependencies must share one target branch, so sequence the two lines by hand instead',
      )
    }
    if (task.status === 'cancelled') return fail('cancelled-dependency', 'depends on ' + id + ', which is cancelled')
    if (taskId !== undefined && reaches(byId, id, taskId)) {
      return fail('dependency-cycle', 'depends on ' + id + ', which already depends on ' + taskId + ' (a cycle)')
    }
  }
  return { ok: true, dependsOn: ids }
}
/** Create a task and allocate the next T-<n> id. */
export function createTask(board, input, now, by) {
  const title = String(input.title === undefined ? '' : input.title).trim()
  if (title === '') return fail('missing-title', 'a task needs a title')
  // T-131: 'dev' is the default pipeline; 'investigate' delivers a report. An
  // unknown kind is a typo, not a dev card: refuse it instead of guessing.
  const kind = normaliseKind(input.kind)
  if (kind === null) return fail('invalid-kind', 'kind must be dev or investigate; got ' + JSON.stringify(input.kind))
  // A declaration that cannot be normalised is a TYPO, not "no declaration":
  // silently dropping it would hand the work back to the tester with no
  // mechanical baseline at all.
  const checkedVerify = validateVerify(input.verify === undefined ? null : input.verify)
  if (checkedVerify.ok !== true) {
    return fail(
      'invalid-verify',
      'verify must be { command: "a shell command", timeoutMs?: number } or null; got ' + JSON.stringify(input.verify),
    )
  }
  const declaredVerify = input.verify === undefined ? null : checkedVerify.verify
  // T-191: the task's executable probes, validated strictly on write.
  const checkedVerification = validateVerification(input.verification)
  if (checkedVerification.ok !== true) return fail(checkedVerification.code, checkedVerification.message)
  const declaredVerification = checkedVerification.verification === undefined ? { probes: [] } : checkedVerification.verification
  // T-192 (STAGE-CONTRACT §5): a NEW dev card must fit the card model before it
  // exists — at least one executable probe, and the design-stage size budget.
  // An oversized or probe-less design is refused HERE, while it can still be
  // split; investigation cards are exempt (they deliver a report, no candidate).
  const card = validateCardModel(
    { kind: kind, acceptance: input.acceptance, writeFiles: input.writeFiles, verification: declaredVerification },
    { requireProbes: true },
  )
  if (card.ok !== true) return fail(card.code, card.message)
  const checked = validateDepends(board, undefined, input.dependsOn, normaliseTarget(input.target))
  if (checked.ok !== true) return checked
  const next = clone(board)
  const id = 'T-' + String(next.seq)
  next.seq = next.seq + 1
  const task = {
    id: id,
    title: title,
    spec: String(input.spec === undefined ? '' : input.spec),
    acceptance: String(input.acceptance === undefined ? '' : input.acceptance),
    // T-201: filled by the state machine below (create -> pending); a literal
    // here would be a second status writer.
    status: null,
    kind: kind,
    report: null,
    priority: Number.isFinite(input.priority) ? Math.floor(input.priority) : 0,
    dependsOn: checked.dependsOn,
    writeFiles: normaliseList(input.writeFiles),
    verify: declaredVerify,
    verification: declaredVerification,
    base: null,
    target: normaliseTarget(input.target),
    branch: null,
    worktree: null,
    worktreeError: null,
    commit: null,
    actualFiles: [],
    requiredRole: null,
    merge: null,
    review: null,
    test: null,
    assignee: null,
    attempts: 0,
    maxAttempts: Number.isFinite(input.maxAttempts) ? Math.min(10, Math.max(1, Math.floor(input.maxAttempts))) : 3,
    evidence: '',
    dispatch: null,
    leaseUntil: null,
    createdBy: by,
    createdAt: iso(now),
    updatedAt: iso(now),
    history: [
      {
        at: iso(now),
        by: by,
        from: null,
        to: 'pending',
        note: input.note === undefined ? 'created' : String(input.note),
      },
    ],
  }
  // T-201: the ONE status write of a create.
  const created = enterState(task, 'create', { task: task, actor: 'agent' }, now)
  if (created.ok !== true) return fail(created.code, created.message)
  next.tasks.push(task)
  return done(next, [{ kind: 'created', id: id, who: by }], { task: task })
}

/** Git-derived fields the host writes; an ordinary update may not forge them. */
const HOST_ONLY_FIELDS = ['base', 'branch', 'worktree', 'commit', 'actualFiles', 'merge']

/** A task's target branch: a trimmed name, or null for "follow the default". */
export function normaliseTarget(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Change content or structure.
 *
 * A running task freezes only its DEPENDENCIES: moving them could strand a
 * dependent. writeFiles stays editable while running — it is a reservation/hint
 * for the dispatcher, not a hard gate. Git identity (base/target/branch/
 * worktree/commit/merge) is host-written and refused here even if supplied.
 */
export function updateTask(board, id, input, now, by) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  // T-131: the kind decides the whole lifecycle (dev: review/test/merge,
  // investigate: report). Changing it in place would corrupt a running card, so
  // it is fixed at creation; a different lifecycle needs a new card.
  if (input.kind !== undefined) {
    return fail('kind-immutable', id + ' has kind ' + String(task.kind) + '; a card cannot change kind — create a new card instead')
  }
  const hostOnly = HOST_ONLY_FIELDS.filter((key) => input[key] !== undefined)
  if (hostOnly.length > 0) {
    return fail('host-only', 'the host writes ' + hostOnly.join(', ') + '; an ordinary update cannot set them')
  }
  if (input.dependsOn !== undefined && task.status === 'running') {
    return fail('running-structural', id + ' is running; finish it or cancel it before changing dependencies')
  }
  if (input.dependsOn !== undefined) {
    const proposedTarget = input.target === undefined ? normaliseTarget(task.target) : normaliseTarget(input.target)
    const checked = validateDepends(board, id, input.dependsOn, proposedTarget)
    if (checked.ok !== true) return checked
  }
  if (input.title !== undefined && String(input.title).trim() === '') return fail('missing-title', 'a task needs a title')
  const updatedVerification = input.verification === undefined ? undefined : validateVerification(input.verification)
  if (updatedVerification !== undefined && updatedVerification.ok !== true) {
    return fail(updatedVerification.code, updatedVerification.message)
  }
  // T-192 (STAGE-CONTRACT §5): an update may not shrink a dev card out of the
  // card model. Only the fields THIS update supplies are validated, so a LEGACY
  // card written before the rule existed keeps running: an unrelated edit
  // (priority, note, dependencies) never retroactively rewrites or rejects it.
  // Supplying verification is a scope decision, and it must keep a probe.
  const cardPatch = {}
  if (input.acceptance !== undefined) cardPatch.acceptance = input.acceptance
  if (input.writeFiles !== undefined) cardPatch.writeFiles = normaliseList(input.writeFiles)
  if (updatedVerification !== undefined) cardPatch.verification = updatedVerification.verification
  if (Object.keys(cardPatch).length > 0) {
    const card = validateCardModel(Object.assign({ kind: task.kind }, cardPatch), { requireProbes: updatedVerification !== undefined })
    if (card.ok !== true) return fail(card.code, card.message)
  }
  const updatedVerify = input.verify === undefined ? undefined : validateVerify(input.verify)
  if (updatedVerify !== undefined && updatedVerify.ok !== true) {
    return fail(
      'invalid-verify',
      'verify must be { command: "a shell command", timeoutMs?: number } or null; got ' + JSON.stringify(input.verify),
    )
  }
  // T-201 T08: an update is a declared same-state event; it may never move a card.
  const stays = transition('update', task.status, { task: task })
  if (stays.ok !== true) return fail(stays.code, stays.message)
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  const notes = []
  if (input.title !== undefined) target.title = String(input.title).trim()
  if (input.spec !== undefined) target.spec = String(input.spec)
  if (input.acceptance !== undefined) target.acceptance = String(input.acceptance)
  if (input.priority !== undefined && Number.isFinite(input.priority)) target.priority = Math.floor(input.priority)
  if (input.maxAttempts !== undefined && Number.isFinite(input.maxAttempts)) {
    target.maxAttempts = Math.min(10, Math.max(1, Math.floor(input.maxAttempts)))
  }
  if (input.dependsOn !== undefined) {
    target.dependsOn = normaliseList(input.dependsOn)
    notes.push('dependencies: ' + (target.dependsOn.length === 0 ? 'none' : target.dependsOn.join(', ')))
  }
  if (input.target !== undefined) {
    target.target = normaliseTarget(input.target)
    notes.push('target: ' + (target.target === null ? 'default' : target.target))
  }
  if (input.writeFiles !== undefined) {
    target.writeFiles = normaliseList(input.writeFiles)
    notes.push('files: ' + (target.writeFiles.length === 0 ? 'none' : target.writeFiles.join(', ')))
  }
  // `verify` is an ordinary task field (not host-only): the worker or the user
  // declares it, and null clears it back to the tester-runs-the-suite flow.
  if (input.verify !== undefined) {
    target.verify = updatedVerify.verify
    notes.push('verify: ' + (target.verify === null ? 'none' : target.verify.command))
  }
  if (input.verification !== undefined) {
    target.verification = updatedVerification.verification === null ? { probes: [] } : updatedVerification.verification
    notes.push('probes: ' + String(target.verification.probes.length))
  }
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: by,
    from: target.status,
    to: target.status,
    note: input.note === undefined ? notes.join('; ') || 'updated' : String(input.note),
  })
  return done(next, [{ kind: 'updated', id: id, who: by }], { task: target })
}

/** Remove a task. A task another live task depends on is refused, because
 * deleting it would silently make the dependent never run. */
export function deleteTask(board, id, now, by, options) {
  const opts = options === undefined ? {} : options
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status === 'running') return fail('running', id + ' is running; cancel it first')
  const referencedBy = board.tasks
    .filter((other) => other.id !== id && other.dependsOn.indexOf(id) >= 0 && CLOSED_STATUSES.indexOf(other.status) < 0)
    .map((other) => other.id)
  if (referencedBy.length > 0 && opts.force !== true) {
    return fail('referenced', id + ' is a dependency of ' + referencedBy.join(', ') + '; pass force to remove it from them', {
      referencedBy: referencedBy,
    })
  }
  const next = clone(board)
  next.tasks = next.tasks.filter((other) => other.id !== id)
  for (const other of next.tasks) {
    if (other.dependsOn.indexOf(id) < 0) continue
    other.dependsOn = other.dependsOn.filter((dep) => dep !== id)
    touch(other, now)
    pushHistory(other, { at: iso(now), by: by, note: 'dependency ' + id + ' deleted' })
  }
  return done(next, [{ kind: 'deleted', id: id, who: by }])
}

// ── dispatch state ─────────────────────────────────────────────────────────

/** Start or pause dispatch, or change its settings. */
/** Record an agent's request to start dispatch. The scheduler stays paused
 * until a user approves it in the panel. */
export function requestDispatch(board, request, now, by) {
  const source = request === undefined || request === null ? {} : request
  const at = iso(now)
  const next = clone(board)
  next.dispatch = normaliseDispatch(
    Object.assign({}, next.dispatch, {
      request: {
        id: 'R-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        by: source.by === undefined ? by : String(source.by),
        at: at,
        note: source.note === undefined ? '' : String(source.note),
      },
    }),
  )
  next.updatedAt = at
  return done(next, [{ kind: 'dispatch-requested', by: by }], { request: next.dispatch.request })
}

/** Drop a pending start request without changing the dispatch state. */
export function clearDispatchRequest(board, now, by) {
  const next = clone(board)
  next.dispatch = normaliseDispatch(Object.assign({}, next.dispatch, { request: null }))
  next.updatedAt = iso(now)
  return done(next, [{ kind: 'dispatch-request-cleared', who: by }], { request: null })
}

/** A user approved a start request: run, and clear the request in one write. */
export function approveDispatch(board, now, by) {
  const next = clone(board)
  next.dispatch = normaliseDispatch(
    Object.assign({}, next.dispatch, {
      state: 'running',
      request: null,
      since: iso(now),
      by: by,
      // T-165: a resume ends the pause episode; the audit fields describe a
      // CURRENT pause, not the previous one.
      pauseSource: null,
      pauseReason: null,
      error: null,
    }),
  )
  next.updatedAt = iso(now)
  return done(next, [{ kind: 'dispatch', state: 'running', who: by }], { dispatch: next.dispatch })
}

export function setDispatch(board, patch, now, by) {
  const source = patch === undefined || patch === null ? {} : patch
  if (source.state !== undefined && source.state !== 'running' && source.state !== 'paused') {
    return fail('invalid-dispatch', 'dispatch state must be running or paused')
  }
  const next = clone(board)
  const merged = normaliseDispatch(Object.assign({}, next.dispatch, source))
  const changedState = merged.state !== next.dispatch.state
  // T-165: a pause audit write (preflight/worktree) refreshes the actor even
  // when the board was already paused, so a legacy @user attribution can never
  // survive an automatic pause.
  // T-169: clearing an old error is NOT a pause-audit write. Only an explicit
  // source/reason (preflight/worktree failure, or preflight recovery naming
  // itself) may rewrite by/pauseSource/pauseReason; a plain error cleanup must
  // leave the user/scheduler attribution untouched.
  const pauseAuditWrite =
    merged.state === 'paused' &&
    (source.pauseSource !== undefined || source.pauseReason !== undefined)
  next.dispatch = merged
  if (changedState || pauseAuditWrite) {
    next.dispatch.since = iso(now)
    next.dispatch.by = by
    if (next.dispatch.state === 'running') {
      // T-165: running has no pause episode to describe.
      next.dispatch.pauseSource = null
      next.dispatch.pauseReason = null
    } else {
      // Every pause write names its actor. Explicit routes (control.mjs) call
      // this without a source, so default them to user/scheduler; preflight and
      // worktree pauses pass their own source and a readable reason.
      if (source.pauseSource === undefined) next.dispatch.pauseSource = by === 'scheduler' ? 'scheduler' : 'user'
      if (source.pauseReason === undefined) {
        // T-169: a NEW explicit pause starts a new pause episode. It must not
        // inherit an old preflight/worktree error as its reason; the audit field
        // stays null unless the caller supplies a reason. An audit refresh on an
        // already-paused board keeps the existing reason.
        next.dispatch.pauseReason = changedState ? null : next.dispatch.pauseReason
      }
    }
  }
  next.updatedAt = iso(now)
  return done(next, [{ kind: 'dispatch', state: merged.state, who: by }], { dispatch: merged })
}

// ── task lifecycle ─────────────────────────────────────────────────────────

/** Claim a ready task for a worker. The claim is the mutex: only claimTask can
 * produce status running, so a second dispatch of the same task fails on the
 * status check. The attempt counter is incremented exactly here. */
export function claimTask(board, id, worker, now) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'pending') return fail('not-pending', id + ' is ' + task.status + ', not pending')
  const dependency = dependencyInfo(board, task)
  if (dependency.state === 'broken') {
    return fail('dependency-broken', id + ' waits on missing or cancelled tasks: ' + dependency.brokenOn.join(', '))
  }
  if (dependency.state !== 'ready') {
    return fail('dependency-unmet', id + ' is still waiting on ' + dependency.waitingOn.join(', '))
  }
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // What the scheduler prepared for THIS attempt. A fallback carries no
  // worktree, so those fields are cleared and only the reason remains.
  const worktree = worker.worktree === undefined || worker.worktree === null ? {} : worker.worktree
  const adopted = worker.adopt === undefined || worker.adopt === null ? null : worker.adopt
  // T-201: pending -> running through the table (the claim is still the mutex).
  const entered = enterState(target, 'claim', { task: target, actor: 'scheduler', dependency: dependency }, now)
  if (entered.ok !== true) return fail(entered.code, entered.message)
  target.lastAssignee = null
  target.assignee = {
    name: worker.name === undefined ? '@worker' : String(worker.name),
    session: worker.session === undefined || worker.session === null ? null : String(worker.session),
  }
  target.leaseUntil = iso(now + TASK_LEASE_MS)
  // One live executor per task: the claim effect already retired everything this
  // card was handed before, so the ledger always has exactly one live entry.
  pushExecutor(target, target.assignee, now)
  target.base = typeof worktree.base === 'string' ? worktree.base : null
  // T-156: the audit baseline for this attempt. The dispatcher passes the SAME
  // target head the worktree was created on and the verify fingerprint it read;
  // fall back to the worktree base so older callers keep a usable baseline.
  target.targetBase = typeof worker.targetBase === 'string' && worker.targetBase !== '' ? worker.targetBase : target.base
  target.verifyFingerprint = typeof worker.verifyFingerprint === 'string' && worker.verifyFingerprint !== '' ? worker.verifyFingerprint : null
  target.target = typeof worktree.target === 'string' ? worktree.target : null
  target.branch = typeof worktree.branch === 'string' ? worktree.branch : null
  target.worktree = typeof worktree.path === 'string' ? worktree.path : null
  target.worktreeError = typeof worktree.error === 'string' ? worktree.error : null
  target.dispatch = {
    status: 'claimed',
    at: iso(now),
    target: target.assignee.name,
    targetId: target.assignee.session,
    via: adopted === null ? (worker.via === undefined ? null : String(worker.via)) : 'adopt',
    error: null,
    host: worker.host === undefined || worker.host === null ? null : String(worker.host),
    // T-97/T-106: who dispatched this card, under WHICH Lead (and that Lead's
    // session) and for which project/team, so history and the panel can prove it
    // never crossed sessions.
    lead: worker.lead === undefined || worker.lead === null ? null : String(worker.lead),
    leadSession: worker.leadSession === undefined || worker.leadSession === null ? null : String(worker.leadSession),
    // The CARD's session (worker.session is the worker's own identity above).
    session: worker.cardSession === undefined || worker.cardSession === null ? null : String(worker.cardSession),
    project: worker.project === undefined || worker.project === null ? null : String(worker.project),
    // T-107: an ownerless (pre-T-97) card dispatched on a single-team host says so.
    ownerCompat: worker.ownerCompat === true,
    compat: worker.compat === true,
    // Why the compatibility path was taken (Lead inventory), kept on the record so
    // the panel/history can explain a single-team host without re-scanning.
    compatDetail: worker.compatDetail === undefined || worker.compatDetail === null ? null : String(worker.compatDetail),
    keep: worktree.keep === true,
  }
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: 'scheduler',
    byName: target.assignee.name,
    from: 'pending',
    to: 'running',
    note:
      'dispatched to ' + target.assignee.name + (target.attempts > 1 ? ' (attempt ' + String(target.attempts) + ')' : '') +
      (worker.lead === undefined || worker.lead === null ? '' : ' under Lead ' + String(worker.lead)) +
      (worker.project === undefined || worker.project === null ? '' : ' for ' + String(worker.project)) +
      (worker.ownerCompat === true
        ? ' (' + (worker.compatDetail === undefined || worker.compatDetail === null ? 'compat: same-project single team; card had no ownerSession' : String(worker.compatDetail)) + ')'
        : '') +
      (worker.cardSession === undefined || worker.cardSession === null ? '' : ' (session ' + String(worker.cardSession) + ')') +
      (adopted === null
        ? ''
        : ' adopting ' + String(adopted.branch) +
          (adopted.head === null || adopted.head === undefined ? '' : ' @ ' + String(adopted.head).slice(0, 10)) +
          ' from attempt ' + String(adopted.fromAttempt)),
  })
  return done(next, [{ kind: 'claimed', id: id, who: target.assignee.name }], { task: target })
}

/** Fill in the identity a spawn only learns after it happened. */
export function attachWorker(board, id, worker, now) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  if (target.assignee !== null) {
    if (worker.session !== undefined && worker.session !== null) target.assignee.session = String(worker.session)
    if (worker.name !== undefined && worker.name !== null) target.assignee.name = String(worker.name)
  }
  if (target.dispatch !== null) {
    if (worker.session !== undefined && worker.session !== null) target.dispatch.targetId = String(worker.session)
    if (worker.name !== undefined && worker.name !== null) target.dispatch.target = String(worker.name)
    target.dispatch.status = 'spawned'
  }
  touch(target, now)
  return done(next, [{ kind: 'attached', id: id, who: target.assignee === null ? null : target.assignee.name }])
}

/** Record the delivery result on the dispatch record. */
export function recordDispatch(board, id, patch, now) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.dispatch = Object.assign({}, target.dispatch === null ? {} : target.dispatch, patch)
  touch(target, now)
  return done(next, [{ kind: 'dispatched', id: id, status: patch.status }])
}

/**
 * An INFRASTRUCTURE interruption (host restart, plugin reload): the worker never
 * got to work, so the attempt it was charged is REFUNDED and the interruption is
 * counted on its own axis.
 *
 * Requirements this encodes:
 *   - attempts stays where it was before the claim (a reload is not a failure);
 *   - interruptions + 1, visible in get/board;
 *   - the history says what happened ("interrupted by host restart; attempt
 *     refunded");
 *   - five consecutive interruptions with NOTHING ever committed blocks the task
 *     (interrupted-too-often) instead of retrying forever.
 *
 * The counter resets the moment real work lands (submit) or a genuine dispatch
 * failure is recorded, because only CONSECUTIVE interruptions are a loop.
 */
export function interruptDispatch(board, id, error, now, options) {
  const opts = options === undefined || options === null ? {} : options
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'running') return fail('not-running', id + ' is ' + task.status + ', not running')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  const limit = Number.isFinite(opts.maxInterruptions) && opts.maxInterruptions >= 1 ? Math.floor(opts.maxInterruptions) : INTERRUPTION_LIMIT
  const reason = error === null || error === undefined || String(error) === '' ? 'worker lost (host restart)' : String(error)
  // The claim charged one attempt; the worker never ran, so the transition refunds
  // it. Five consecutive interruptions with nothing committed stop the loop.
  const committed = typeof target.commit === 'string' && target.commit !== ''
  const nextInterruptions = (Number.isFinite(target.interruptions) ? target.interruptions : 0) + 1
  const tooMany = nextInterruptions >= limit && committed !== true
  const entered = enterState(
    target,
    'interrupt',
    { task: target, actor: 'scheduler', to: tooMany ? 'blocked' : 'pending', blockedDetail: reason },
    now,
  )
  if (entered.ok !== true) return fail(entered.code, entered.message)
  target.dispatch = Object.assign({}, target.dispatch === null ? {} : target.dispatch, {
    status: tooMany ? 'exhausted' : 'interrupted',
    error: tooMany ? 'interrupted-too-often' : reason,
    at: iso(now),
  })
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: 'scheduler',
    from: 'running',
    to: target.status,
    note:
      'interrupted by ' + reason + '; attempt refunded (interruptions ' +
      String(target.interruptions) + '/' + String(limit) + ')' +
      (tooMany ? '; blocked: repeated interruptions without a submission (' + 'interrupted-too-often)' : ''),
  })
  return done(next, [{ kind: tooMany ? 'interrupted-out' : 'interrupted', id: id }], { task: target, tooMany: tooMany })
}

/**
 * Retire the executors a re-dispatch replaces, and record it. This is the
 * bookkeeping half of the one-live-executor rule: the dispatcher interrupts the
 * old worker through the Team service and then calls this so the board itself
 * remembers that identity is no longer live, even when no interrupt API exists.
 */
export function retireExecutors(board, id, identities, now, reason) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  const wanted = Array.isArray(identities) ? identities.filter((entry) => typeof entry === 'string' && entry !== '') : []
  if (wanted.length === 0) return done(board, [])
  const list = Array.isArray(target.executors) ? target.executors : []
  target.executors = list.map((entry) =>
    entry !== null && typeof entry === 'object' && entry.retiredAt === null && wanted.indexOf(entry.name) >= 0
      ? Object.assign({}, entry, { retiredAt: iso(now), retiredReason: String(reason === undefined || reason === null ? 'retired' : reason) })
      : entry,
  )
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: 'scheduler',
    from: target.status,
    to: target.status,
    note: 'retired executor ' + wanted.join(', ') + ' (' + String(reason === undefined || reason === null ? 'retired' : reason) + ')',
  })
  return done(next, [{ kind: 'retired', id: id, names: wanted }], { task: target })
}

/**
 * Record a dispatch that was refused because another executor of the same task is
 * still alive (the one-live-executor guard). It never changes the status: the
 * point is the trace, so a stampede is visible instead of silent.
 */
export function noteDispatchRefused(board, id, now, names, reason) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  const who = Array.isArray(names) && names.length > 0 ? names.join(', ') : 'an unknown executor'
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: 'scheduler',
    from: target.status,
    to: target.status,
    note: 'already-dispatched: ' + who + ' is still live; refusing a second executor' + (typeof reason === 'string' && reason !== '' ? ' (' + reason + ')' : ''),
  })
  return done(next, [{ kind: 'already-dispatched', id: id }], { task: target })
}

/**
 * Record a role slot that was NOT reused because it belongs to another project
 * (its session workspace is that project). The status is untouched: the point is
 * the trace, so cross-project reuse is visible on the card instead of silently
 * borrowing another project's teammate.
 */
export function noteReuseRefused(board, id, now, refused, reason) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  const list = Array.isArray(refused) ? refused.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string') : []
  const who =
    list.length === 0
      ? 'an unknown executor'
      : list
          .map(function (entry) {
            if (typeof entry.root === 'string' && entry.root !== '') return entry.name + ' (' + entry.root + ')'
            if (typeof entry.project === 'string' && entry.project !== '') return entry.name + ' (project ' + entry.project + ')'
            return entry.name
          })
          .join(', ')
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: 'scheduler',
    from: target.status,
    to: target.status,
    note: 'reuse refused: executor ' + who + ' belongs to another project' + (typeof reason === 'string' && reason !== '' ? ' (' + reason + ')' : ''),
  })
  return done(next, [{ kind: 'reuse-refused', id: id }], { task: target })
}

/** A dispatch that failed before or while delivering: drop the claim, count the
 * attempt that was already spent, and block once the budget is gone. */
export function failDispatch(board, id, error, now, maxAttempts) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'running') return fail('not-running', id + ' is ' + task.status + ', not running')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  const limit = Number.isFinite(maxAttempts) ? maxAttempts : target.maxAttempts
  const exhausted = target.attempts >= limit
  // T-201 (T03b): running -> pending, or blocked once the attempt budget is gone.
  // The function has no production caller today (document G10); it stays exported,
  // so its write is declared in the table instead of being a second writer.
  const entered = enterState(
    target,
    'dispatchFailed',
    {
      task: target,
      actor: 'scheduler',
      to: exhausted ? 'blocked' : 'pending',
      blockedDetail: error === null || error === undefined ? 'dispatch failed' : String(error),
    },
    now,
  )
  if (entered.ok !== true) return fail(entered.code, entered.message)
  // A REAL failure is not an interruption: the streak restarts, so five host
  // restarts can never be charged against a worker that actually broke something.
  target.interruptions = 0
  target.dispatch = Object.assign({}, target.dispatch === null ? {} : target.dispatch, {
    status: exhausted ? 'exhausted' : 'failed',
    error: error === null || error === undefined ? 'dispatch failed' : String(error),
    at: iso(now),
  })
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: 'scheduler',
    from: 'running',
    to: target.status,
    note:
      (exhausted ? 'dispatch gave up after ' + String(target.attempts) + ' attempts: ' : 'dispatch failed: ') +
      String(target.dispatch.error),
  })
  return done(next, [{ kind: exhausted ? 'exhausted' : 'dispatch-failed', id: id }], { task: target })
}

/**
 * Running tasks whose lease expired come back to the pool; after the attempt
 * budget they become blocked instead, so a crash loop is visible.
 *
 * Options narrow the reap to one task and explain WHY it was let go, because the
 * liveness path distinguishes a holder that is gone from one that is alive but
 * past the hard cap. The claim identity (dispatch.target/targetId) is kept with
 * the requeued task: it is what tells the dispatcher whose liveness to check
 * before handing the task to a second agent.
 */
export function expireLeases(board, now, maxAttempts, options) {
  const opts = options === undefined || options === null ? {} : options
  const only = typeof opts.id === 'string' && opts.id !== '' ? opts.id : null
  const next = clone(board)
  const reaped = []
  for (const target of next.tasks) {
    if (target.status !== 'running') continue
    if (only !== null && target.id !== only) continue
    if (target.leaseUntil !== null && Date.parse(target.leaseUntil) > now) continue
    const limit = Number.isFinite(maxAttempts) ? maxAttempts : target.maxAttempts
    const exhausted = target.attempts >= limit
    const who = target.assignee === null ? 'unknown' : target.assignee.name
    // T-201: running -> pending (or blocked when the attempt budget is spent).
    const entered = enterState(
      target,
      'leaseExpired',
      {
        task: target,
        actor: 'scheduler',
        to: exhausted ? 'blocked' : 'pending',
        blockedDetail: typeof opts.reason === 'string' && opts.reason !== '' ? opts.reason : 'lease expired',
      },
      now,
    )
    if (entered.ok !== true) return fail(entered.code, entered.message)
    target.dispatch = Object.assign({}, target.dispatch === null ? {} : target.dispatch, {
      status: exhausted ? 'exhausted' : 'lease-expired',
      error: typeof opts.error === 'string' && opts.error !== '' ? opts.error : 'lease expired',
      at: iso(now),
    })
    touch(target, now)
    pushHistory(target, {
      at: iso(now),
      by: 'system',
      from: 'running',
      to: target.status,
      note:
        'lease expired for ' + who +
        (typeof opts.reason === 'string' && opts.reason !== '' ? ' (' + opts.reason + ')' : '') +
        (exhausted ? '; attempt budget spent' : '; returned to the pool'),
    })
    reaped.push(target.id)
  }
  if (reaped.length === 0) return done(board, [])
  return done(next, reaped.map((id) => ({ kind: 'lease-expired', id: id })), { reaped: reaped })
}

/**
 * An agent reports the work finished: the task enters the REVIEW phase, it does
 * not complete. The API commits a task's worktree BEFORE calling this and passes
 * the result (`commit`, `actualFiles`, `merge`); the model only records it,
 * because service.mjs stays pure.
 *
 * Each submission opens a new review round (review.attempt + 1). The previous
 * test record is kept for context; it is not a decision on this head, and the
 * merge gate only accepts the testing phase with a passed test.
 */
export function submitTask(board, id, input, now, by, byName, actor) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  // T-131: an investigation never merges code; its one completion action is a
  // report. Refusing here keeps submit from committing a scratch checkout at all.
  if (task.kind === INVESTIGATE_KIND) {
    return fail('investigation-report-only', id + ' is an investigation card: finish it with task_center { action: "report", id, summary, body, evidence? }, not submit')
  }
  if (task.status !== 'running') return fail('not-running', id + ' is ' + task.status + ', not running')
  // T-192 (STAGE-CONTRACT §5): the design-stage size budget is checked against
  // the candidate the host just derived. It fires only when EVERY changed file
  // is production, because the board keeps one aggregate diffstat: a candidate
  // that also touches tests or the generated client/client.js cannot attribute
  // its lines, and blaming the rebuilt bundle on the card would be wrong.
  const submittedArtifact = input !== undefined && input.merge !== null && typeof input.merge === 'object' && Array.isArray(input.merge) === false ? input.merge.artifact : null
  const productionLines = productionLinesOfArtifact(submittedArtifact)
  if (productionLines !== null && productionLines > CARD_MODEL_LIMITS.changedLines) {
    return fail(
      'too-many-changes',
      id + ' changes ' + String(productionLines) + ' production lines; the card model allows ' + String(CARD_MODEL_LIMITS.changedLines) + ' (tests and the generated client/client.js do not count). Report this to the Lead and split the card at design time instead of explaining it in review or test.',
    )
  }
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  if (input !== undefined && input.evidence !== undefined) target.evidence = String(input.evidence)
  if (input !== undefined && input.commit !== undefined) target.commit = String(input.commit)
  if (input !== undefined && input.actualFiles !== undefined) target.actualFiles = normaliseList(input.actualFiles)
  if (input !== undefined && input.merge !== undefined) target.merge = normaliseMerge(input.merge)
  // T-156: record the target head and verify fingerprint the submission SAW, and
  // flag a declaration that changed while the card was running. The old/new pair
  // rides on the merge request so the review brief can show it.
  if (input !== undefined && input.targetBase !== undefined) target.targetBase = typeof input.targetBase === 'string' && input.targetBase !== '' ? input.targetBase : null
  if (input !== undefined && input.verifyFingerprint !== undefined) {
    const previousPrint = typeof target.verifyFingerprint === 'string' && target.verifyFingerprint !== '' ? target.verifyFingerprint : null
    const nextPrint = typeof input.verifyFingerprint === 'string' && input.verifyFingerprint !== '' ? input.verifyFingerprint : null
    target.verifyFingerprint = nextPrint
    if (target.merge !== null && typeof target.merge === 'object' && !Array.isArray(target.merge)) {
      if (previousPrint !== null && nextPrint !== null && previousPrint !== nextPrint) {
        target.merge.verifyChanged = true
        target.merge.verifyFingerprints = { from: previousPrint, to: nextPrint }
      }
    }
  }
  // A submission is proof the worker ran: the infrastructure-interruption streak
  // (and the attempt refunds that came with it) starts over.
  target.interruptions = 0
  // T-201: running -> reviewing through the table (it clears the lease).
  const entered = enterState(target, 'submit', { task: target, actor: actor === undefined ? 'worker' : actor }, now)
  if (entered.ok !== true) return fail(entered.code, entered.message)
  target.review = {
    status: 'pending',
    by: by,
    byName: byName === undefined ? null : byName,
    at: iso(now),
    reasons: null,
    attempt: (target.review === null ? 0 : target.review.attempt) + 1,
  }
  target.dispatch = Object.assign({}, target.dispatch === null ? {} : target.dispatch, {
    status: 'submitted',
    at: iso(now),
  })
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: by,
    byName: byName === undefined ? null : byName,
    from: 'running',
    to: 'reviewing',
    note: input !== undefined && input.note !== undefined ? String(input.note) : 'submitted for review',
  })
  return done(next, [{ kind: 'submitted', id: id, who: by }], { task: target })
}

/**
 * The review phase: a reviewer approves the submission (-> testing) or asks for
 * changes (-> running, back to the same worker).
 *
 * T-191 CONTRACT NOTE: the structured record is validated and persisted by the
 * ACTION layer (actions/review-verdicts.mjs), which refuses an empty checked
 * list / a changes request without a blocking finding BEFORE any side effect.
 * These pure model functions only store a valid record and deliberately degrade
 * a missing/invalid one to "no record" so host-internal calls (e.g. the host
 * failTest in review-verdicts) and old boards can never throw here. A future
 * direct caller of the model is NOT allowed to skip the action layer.
 */
export function approveReview(board, id, now, by, byName, record, actor) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.kind === INVESTIGATE_KIND) return fail('not-a-dev-task', id + ' is an investigation card; it has no review phase (finish it with report)')
  if (task.status !== 'reviewing') return fail('not-reviewing', id + ' is ' + task.status + ', not reviewing')
  if (task.review === null || task.review.status !== 'pending') return fail('no-pending-review', id + ' has no review decision to approve')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // T-201: reviewing -> testing through the table (the review round must still be
  // open, which is checked before the record is closed below).
  const entered = enterState(target, 'approveReview', { task: target, actor: actor === undefined ? 'reviewer' : actor }, now)
  if (entered.ok !== true) return fail(entered.code, entered.message)
  target.review = Object.assign({}, target.review, { status: 'approved', by: by, byName: byName === undefined ? null : byName, at: iso(now) })
  // T-191: the validated ReviewRecord is the durable hand-off to the tester.
  const reviewRecord = normaliseReviewRecord(record)
  if (reviewRecord !== null) target.review.record = reviewRecord
  target.test = {
    status: 'pending',
    by: null,
    byName: null,
    at: iso(now),
    evidence: null,
    attempt: (target.test === null ? 0 : target.test.attempt) + 1,
  }
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: by,
    byName: byName === undefined ? null : byName,
    from: 'reviewing',
    to: 'testing',
    note: 'review approved' + (target.review.reasons === null ? '' : ': ' + target.review.reasons),
  })
  return done(next, [{ kind: 'review-approved', id: id, who: by }], { task: target })
}

/** Same T-191 contract note as approveReview: record validation lives in the action layer. */
export function requestChanges(board, id, reasons, now, by, byName, record, actor) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.kind === INVESTIGATE_KIND) return fail('not-a-dev-task', id + ' is an investigation card; it has no review phase (finish it with report)')
  if (task.status !== 'reviewing') return fail('not-reviewing', id + ' is ' + task.status + ', not reviewing')
  if (task.review === null || task.review.status !== 'pending') return fail('no-pending-review', id + ' has no review decision to change')
  const text = String(reasons === undefined || reasons === null ? '' : reasons).trim()
  if (text === '') return fail('missing-reasons', 'requestChanges needs reasons the worker can act on')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // T-201: reviewing -> running (or pending with no implementer) through the
  // table; the open review round must still be the one being decided.
  const entered = enterState(
    target,
    'requestChanges',
    { task: target, actor: actor === undefined ? 'reviewer' : actor, hasImplementer: target.assignee !== null && target.assignee !== undefined },
    now,
  )
  if (entered.ok !== true) return fail(entered.code, entered.message)
  target.review = Object.assign({}, target.review, { status: 'changes-requested', by: by, byName: byName === undefined ? null : byName, at: iso(now), reasons: text })
  // T-191: the findings ARE the reasons; the record keeps them structured so the
  // next round and the board can show what was requested, not just a blob.
  const changesRecord = normaliseReviewRecord(record)
  if (changesRecord !== null) target.review.record = changesRecord
  target.dispatch = Object.assign({}, target.dispatch === null ? {} : target.dispatch, { status: 'changes-requested', at: iso(now) })
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: by,
    byName: byName === undefined ? null : byName,
    from: 'reviewing',
    to: 'running',
    note: 'changes requested: ' + text,
  })
  return done(next, [{ kind: 'changes-requested', id: id, who: by }], { task: target })
}

/**
 * The test phase: a tester's pass makes the request merge-eligible (the queue
 * turns the task DONE after the merge), a failure sends it back to running.
 *
 * T-191 CONTRACT NOTE: the TestRecord (executed probes) is validated by the
 * ACTION layer (actions/test-verdicts.mjs) — an empty probe list is refused
 * there, before the board moves. The model stores a valid record and degrades an
 * invalid/missing one to "no record" so the host's own failTest paths stay
 * usable. A future direct caller is NOT allowed to skip the action layer.
 */
export function passTest(board, id, now, by, byName, record, actor) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.kind === INVESTIGATE_KIND) return fail('not-a-dev-task', id + ' is an investigation card; it has no test phase (finish it with report)')
  if (task.status !== 'testing') return fail('not-testing', id + ' is ' + task.status + ', not testing')
  if (task.test === null || task.test.status !== 'pending') return fail('no-pending-test', id + ' has no test decision to pass')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // T-201: the pass is a transition of the SAME testing state; the projection
  // (phase 'merge') and the merge gate are derived from test.status + merge.status.
  const entered = enterState(target, 'passTest', { task: target, actor: actor === undefined ? 'tester' : actor }, now)
  if (entered.ok !== true) return fail(entered.code, entered.message)
  target.test = Object.assign({}, target.test, { status: 'passed', by: by, byName: byName === undefined ? null : byName, at: iso(now) })
  // T-191: the executed probes are the verdict's durable evidence.
  const passedRecord = normaliseTestRecord(record)
  if (passedRecord !== null) target.test.record = passedRecord
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: by,
    byName: byName === undefined ? null : byName,
    from: 'testing',
    to: 'testing',
    note: 'tests passed; waiting for the merge',
  })
  return done(next, [{ kind: 'test-passed', id: id, who: by }], { task: target })
}

/** Same T-191 contract note as passTest: record validation lives in the action layer. */
export function failTest(board, id, evidence, now, by, byName, record, options) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.kind === INVESTIGATE_KIND) return fail('not-a-dev-task', id + ' is an investigation card; it has no test phase (finish it with report)')
  if (task.status !== 'testing') return fail('not-testing', id + ' is ' + task.status + ', not testing')
  if (task.test === null || task.test.status !== 'pending') return fail('no-pending-test', id + ' has no test decision to fail')
  const text = String(evidence === undefined || evidence === null ? '' : evidence).trim()
  if (text === '') return fail('missing-evidence', 'failTest needs the evidence the worker can act on')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // T-201: testing -> running (or pending with no implementer) through the table;
  // the failed round is a final record, and the merge request is voided.
  const opts = options === undefined || options === null ? {} : options
  const entered = enterState(
    target,
    'failTest',
    { task: target, actor: opts.actor === undefined ? (by === 'host' || by === 'system' ? 'host' : 'tester') : opts.actor, hasImplementer: target.assignee !== null && target.assignee !== undefined },
    now,
  )
  if (entered.ok !== true) return fail(entered.code, entered.message)
  target.test = Object.assign({}, target.test, { status: 'failed', by: by, byName: byName === undefined ? null : byName, at: iso(now), evidence: text })
  const failedRecord = normaliseTestRecord(record)
  if (failedRecord !== null) target.test.record = failedRecord
  target.dispatch = Object.assign({}, target.dispatch === null ? {} : target.dispatch, { status: 'test-failed', at: iso(now) })
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: by,
    byName: byName === undefined ? null : byName,
    from: 'testing',
    to: 'running',
    note: 'tests failed: ' + text,
  })
  return done(next, [{ kind: 'test-failed', id: id, who: by }], { task: target })
}

export function cancelTask(board, id, now, by, note, byName, options) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status === 'cancelled') return fail('already-cancelled', id + ' is already cancelled')
  if (task.status === 'done') return fail('done', id + ' is done; reopen it before cancelling')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // T-201: <any live state> -> cancelled through the table (it keeps the last
  // owner so the soft refusal still recognises the worker that was cancelled).
  const entered = enterState(target, 'cancel', { task: target, actor: (options === undefined || options === null ? {} : options).actor, blockedDetail: note }, now)
  if (entered.ok !== true) return fail(entered.code, entered.message)
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, byName: byName === undefined ? null : byName, from: task.status, to: 'cancelled', note: note === undefined ? 'cancelled' : String(note) })
  return done(next, [{ kind: 'cancelled', id: id, who: by }], { task: target })
}

/**
 * An investigation delivers its REPORT. This is the only completion action for
 * kind='investigate': status -> done, lease/dispatch cleared, locks released by
 * the caller, and NO merge request is ever created.
 *
 * The board stores a bounded copy (summary <= 4 KB, body <= 64 KB, at most 20
 * evidence rows with <= 4 KB tails); the full text is written to
 * `.agents/reports/<id>.md` by the API.
 */
export function reportTask(board, id, input, now, by, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.kind !== INVESTIGATE_KIND) {
    return fail('not-an-investigation', id + ' is a dev card; finish it with submit so it can be reviewed, tested and merged')
  }
  if (task.status !== 'running') return fail('not-running', id + ' is ' + task.status + ', not running')
  const source = input === undefined || input === null ? {} : input
  const summary = String(source.summary === undefined || source.summary === null ? '' : source.summary).trim()
  if (summary === '') return fail('missing-summary', 'a report needs a summary')
  if (Buffer.byteLength(summary, 'utf8') > REPORT_LIMITS.summaryBytes) {
    return fail('invalid-report', 'report.summary must be at most ' + String(REPORT_LIMITS.summaryBytes) + ' bytes')
  }
  const bodyText = typeof source.body === 'string' ? source.body : ''
  const evidence = normaliseEvidence(source.evidence)
  const artifacts = []
  if (Array.isArray(source.artifacts)) {
    for (const entry of source.artifacts) {
      if (typeof entry !== 'string') continue
      const path = entry.trim()
      if (path === '' || artifacts.indexOf(path) >= 0) continue
      artifacts.push(path)
      if (artifacts.length >= REPORT_LIMITS.artifacts) break
    }
  }
  const probeCommits = []
  if (Array.isArray(source.probeCommits)) {
    for (const entry of source.probeCommits) {
      if (typeof entry !== 'string') continue
      const text = entry.trim()
      if (text === '' || probeCommits.indexOf(text) >= 0) continue
      probeCommits.push(text)
      if (probeCommits.length >= REPORT_LIMITS.evidence) break
    }
  }
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // T-201: running -> done through the table (investigation report only).
  const entered = enterState(target, 'report', { task: target, actor: by === 'user' || by === '@user' ? 'user' : 'worker' }, now)
  if (entered.ok !== true) return fail(entered.code, entered.message)
  target.report = {
    summary: summary,
    body: truncateBytes(bodyText, REPORT_LIMITS.bodyBytes),
    evidence: evidence,
    artifacts: artifacts,
    probeCommits: probeCommits,
    createdAt: iso(now),
    by: by === undefined || by === null ? null : String(by),
    byName: byName === undefined || byName === null || byName === '' ? null : String(byName),
  }
  // No merge request, ever: target only served as the scratch base.
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: by,
    byName: byName === undefined ? null : byName,
    from: task.status,
    to: 'done',
    note: 'investigation report: ' + (summary.length > 120 ? summary.slice(0, 120) + '…' : summary),
  })
  return done(next, [{ kind: 'reported', id: id, who: by }], { task: target })
}

export function reopenTask(board, id, now, by, note, byName, options) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'blocked') {
    return fail('not-closed', id + ' is ' + task.status + '; only done, cancelled or blocked tasks are reopened')
  }
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // T-131: an investigation's previous report is history, not current state; the
  // reopened card must be investigated again before it can be reported.
  const hadReport = target.report !== null && target.report !== undefined
  // T-201: a new generation through the table: every phase record and the merge
  // request are cleared, and a merged candidate's git identity is dropped with it.
  const entered = enterState(target, 'reopen', { task: target, actor: (options === undefined || options === null ? null : options.actor) }, now)
  if (entered.ok !== true) return fail(entered.code, entered.message)
  touch(target, now)
  const reopenNote = note === undefined ? 'reopened' : String(note)
  pushHistory(target, {
    at: iso(now),
    by: by,
    byName: byName === undefined ? null : byName,
    from: task.status,
    to: 'pending',
    note: hadReport ? reopenNote + '; previous report discarded' : reopenNote,
  })
  return done(next, [{ kind: 'reopened', id: id, who: by }], { task: target })
}

export function blockTask(board, id, now, by, note, byName, options) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status === 'done' || task.status === 'cancelled') return fail('closed', id + ' is ' + task.status)
  if (task.status === 'blocked') return fail('already-blocked', id + ' is already blocked')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // T-201: every non-closed, non-blocked state -> blocked through the table, with
  // a TYPED reason (merge-conflict/merge-failed/.../manual-block). This is what
  // stops a merge result from hiding behind status='testing'.
  const opts = options === undefined || options === null ? {} : options
  const reason = opts.reason === undefined || opts.reason === null ? null : typeof opts.reason === 'string' ? { code: opts.reason } : opts.reason
  const entered = enterState(
    target,
    'block',
    {
      task: target,
      actor: (options === undefined || options === null ? null : options.actor),
      blockedCode: reason !== null && typeof reason.code === 'string' ? reason.code : undefined,
      blockedDetail: reason !== null && typeof reason.detail === 'string' && reason.detail !== '' ? reason.detail : note,
      auto: opts.auto === true,
    },
    now,
  )
  if (entered.ok !== true) return fail(entered.code, entered.message)
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, byName: byName === undefined ? null : byName, from: task.status, to: 'blocked', note: note === undefined ? 'blocked' : String(note) })
  return done(next, [{ kind: 'blocked', id: id, who: by }], { task: target })
}

/**
 * T-201 T28: resume a paused card WITHOUT discarding the round it paused in.
 * blockedFrom=reviewing/testing restores the same phase and is refused when the
 * merge request was resolved (merge-unresolved: only refreshMerge) or the paused
 * round is no longer the recorded one (phase-record-mismatch). blockedFrom
 * pending/running returns to the pool. Unlike retry/reopen this resets neither
 * attempts nor the round counters.
 */
export function unblockTask(board, id, now, by, note, byName, options) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'blocked') return fail('not-blocked', id + ' is ' + task.status + ', not blocked')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  const restoreTo = restoreTargetOf(target)
  const entered = enterState(
    target,
    'unblock',
    { task: target, actor: (options === undefined || options === null ? null : options.actor), restoreTo: restoreTo },
    now,
  )
  if (entered.ok !== true) return fail(entered.code, entered.message)
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: by,
    byName: byName === undefined ? null : byName,
    from: 'blocked',
    to: target.status,
    note: (note === undefined ? 'unblocked' : String(note)) + ' (restored to ' + target.status + ')',
  })
  return done(next, [{ kind: 'unblocked', id: id, who: by, restoredTo: restoreTo }], { task: target, restoredTo: restoreTo })
}

/**
 * T-201 T29: retry a paused card from blockedFrom pending/running. It resets the
 * attempt/interruption budget and voids the merge request but KEEPS the review/
 * test round records (the next submit opens a new round); a review-round-limit
 * block is refused (only reopen escapes it).
 */
export function retryTask(board, id, now, by, note, byName, options) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'blocked' && task.status !== 'pending') {
    return fail('not-retryable', id + ' is ' + task.status + '; only a blocked or pending task is retried')
  }
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  const entered = enterState(target, 'retry', { task: target, actor: (options === undefined || options === null ? null : options.actor) }, now)
  if (entered.ok !== true) return fail(entered.code, entered.message)
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, byName: byName === undefined ? null : byName, from: task.status, to: 'pending', note: note === undefined ? 'retry requested' : String(note) })
  return done(next, [{ kind: 'retried', id: id, who: by }], { task: target })
}

/** Renew the lease of every running task owned by this identity. Any tool call
 * by a worker is a heartbeat, which is why long tasks do not need a timer. */
export function renewLeases(board, owner, now) {
  const next = clone(board)
  let renewed = 0
  for (const target of next.tasks) {
    if (target.status !== 'running' || target.assignee === null) continue
    const sessionMatch = owner.session !== undefined && owner.session !== null && target.assignee.session === owner.session
    const nameMatch = owner.name !== undefined && owner.name !== null && target.assignee.name === owner.name
    if (!sessionMatch && !nameMatch) continue
    // T-201 T32: worker activity is a heartbeat of the same running card.
    const entered = enterState(target, 'heartbeat', { task: target, actor: 'scheduler' }, now)
    if (entered.ok !== true) continue
    touch(target, now)
    renewed += 1
  }
  if (renewed === 0) return done(board, [])
  return done(next, [], { renewed: renewed })
}

/** When the current attempt started (its claim record), or null. */
export function attemptStartedAt(task) {
  const record = task === null || task === undefined ? null : task.dispatch
  const at = record === null || record === undefined || typeof record.at !== 'string' ? null : Date.parse(record.at)
  return at === null || !Number.isFinite(at) ? null : at
}

/**
 * Extend a running task's lease WITHOUT changing its assignee or attempt: the
 * liveness path saw a lapsed lease whose holder is still alive, so the task is
 * kept instead of being handed to a second agent. The reason lands in history so
 * the board explains why a task did not move.
 */
export function extendLease(board, id, now, options) {
  const opts = options === undefined || options === null ? {} : options
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'running') return fail('not-running', id + ' is ' + task.status + ', not running')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  // T-201 T32: the heartbeat is a declared running -> running transition.
  const entered = enterState(target, 'heartbeat', { task: target, actor: 'scheduler' }, now)
  if (entered.ok !== true) return fail(entered.code, entered.message)
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: 'scheduler',
    from: 'running',
    to: 'running',
    note: 'lease extended: ' + (opts.reason === undefined ? 'assignee still alive' : String(opts.reason)),
  })
  return done(next, [{ kind: 'lease-extended', id: id }], { task: target, reason: opts.reason === undefined ? null : String(opts.reason) })
}

/**
 * The host heartbeat: extend the lease of every running task that still has a
 * known assignee once its lease is inside the heartbeat window.
 *
 * It is LIVENESS- and CAP-aware, which is what keeps the handover path reachable
 * in a host that ticks forever:
 *   - allow(task) must say the holder is alive (the dispatcher passes the Team
 *     roster check), so a dead holder is NOT renewed and its lease lapses into
 *     the reap, which hands the task over;
 *   - an attempt that already reached maxExtensionMs (default
 *     TASK_LEASE_EXTENSION_MAX_MS) is NOT renewed either, so a live holder past
 *     the cap also lapses into a handover.
 * A lease that already lapsed is never revived, and renewing only inside the
 * window keeps the writes bounded to one per lease period per task.
 */
export function renewRunningLeases(board, now, options) {
  const opts = options === undefined || options === null ? {} : options
  const windowMs = Number.isFinite(opts.windowMs) ? Math.max(1, Math.floor(opts.windowMs)) : TASK_HEARTBEAT_MS
  const maxExtensionMs = Number.isFinite(opts.maxExtensionMs) ? Math.max(1, Math.floor(opts.maxExtensionMs)) : TASK_LEASE_EXTENSION_MAX_MS
  const allow = typeof opts.allow === 'function' ? opts.allow : null
  const next = clone(board)
  const renewed = []
  for (const target of next.tasks) {
    if (target.status !== 'running' || target.assignee === null) continue
    if (target.leaseUntil === null) continue
    const until = Date.parse(target.leaseUntil)
    if (!Number.isFinite(until)) continue
    if (until <= now) continue
    if (until - now > windowMs) continue
    const startedAt = attemptStartedAt(target)
    if (startedAt !== null && now - startedAt >= maxExtensionMs) continue
    if (allow !== null && allow(target) !== true) continue
    // T-201 T32: the bulk heartbeat uses the same running -> running row as the
    // single extension, so the lease write has one declared owner too.
    const entered = enterState(target, 'heartbeat', { task: target, actor: 'host' }, now)
    if (entered.ok !== true) continue
    touch(target, now)
    renewed.push(target.id)
  }
  if (renewed.length === 0) return done(board, [], { renewed: [] })
  return done(next, [], { renewed: renewed })
}

// ── T-241: the agent identities a board OWNS vs only REMEMBERS ─────────────

/** Statuses whose cards still HOLD a stage agent (the same set the tree uses). */
const LIVE_STAGE_STATUSES = ['running', 'reviewing', 'testing']

/** How many historical agents one /meta?scope=history summary lists (bounded). */
export const AGENT_HISTORY_LIMIT = 200

/**
 * The stage sessions ONE card currently names, in pipeline order: the develop
 * worker (assignee.session), the review reviewer (review.deliveredTo.id) and the
 * test tester (test.deliveredTo.id). A missing/blank stage is simply absent —
 * nothing is minted and no other card's session is borrowed.
 *
 * T-241: this is the SAME projection the agent tab uses for its three stage
 * rows, kept pure so the tree and the history summary cannot drift.
 *
 * @returns {Array<{session:string,name:string|null,role:string,stage:string,taskId:string,taskStatus:string,at:string|null}>}
 */
export function stageAgentsOfTask(task) {
  if (task === null || task === undefined || typeof task !== 'object') return []
  const staged = []
  const push = function (role, stage, member) {
    if (member === null || member === undefined || typeof member !== 'object') return
    const session = typeof member.session === 'string' && member.session !== ''
      ? member.session
      : typeof member.id === 'string' && member.id !== ''
        ? member.id
        : null
    if (session === null) return
    staged.push({
      session: session,
      name: typeof member.name === 'string' && member.name !== '' ? member.name : null,
      role: role,
      stage: stage,
      taskId: String(task.id),
      taskStatus: typeof task.status === 'string' ? task.status : null,
      at: typeof member.at === 'string' && member.at !== '' ? member.at : null,
    })
  }
  push('worker', 'develop', task.assignee)
  push('reviewer', 'review', task.review !== null && task.review !== undefined && typeof task.review === 'object' ? task.review.deliveredTo : null)
  push('tester', 'test', task.test !== null && task.test !== undefined && typeof task.test === 'object' ? task.test.deliveredTo : null)
  return staged
}

/**
 * T-241: the stage agents the board currently OWNS — one entry per Session,
 * from the cards that are still in a live stage (running/reviewing/testing).
 *
 * The agent tree keeps a row whose id is in this map even when the host reports
 * it inactive: the card handed that stage to it, so it is a CURRENT executor of
 * the board, not history. The map (not an array) is the dedupe: a session reused
 * across stages or cards is one agent, named by its first live claim.
 *
 * @returns {Map<string, {session:string,name:string|null,role:string,stage:string,taskId:string,taskStatus:string,at:string|null}>}
 */
export function liveStageAgentsOf(board) {
  const live = new Map()
  const tasks = board !== null && board !== undefined && Array.isArray(board.tasks) ? board.tasks : []
  for (const task of tasks) {
    if (task === null || task === undefined) continue
    if (LIVE_STAGE_STATUSES.indexOf(task.status) < 0) continue
    for (const entry of stageAgentsOfTask(task)) {
      if (live.has(entry.session) !== true) live.set(entry.session, entry)
    }
  }
  return live
}

/**
 * T-241: every Session the board records on a card that no longer holds a live
 * stage — the HISTORICAL half of the execution tree, as a Set for membership
 * tests. A session a live card still owns is NOT history (the live claim wins),
 * so a reused session is never counted twice.
 *
 * The board is the authority here: a child the host still reports as running
 * for a card that has ENDED is that card's history too — the catalog simply has
 * not retired it yet.
 *
 * @returns {Set<string>}
 */
export function recordedStageAgentIdsOf(board) {
  const live = liveStageAgentsOf(board)
  const ids = new Set()
  const tasks = board !== null && board !== undefined && Array.isArray(board.tasks) ? board.tasks : []
  for (const task of tasks) {
    if (task === null || task === undefined) continue
    if (LIVE_STAGE_STATUSES.indexOf(task.status) >= 0) continue
    for (const entry of stageAgentsOfTask(task)) {
      if (live.has(entry.session) !== true) ids.add(entry.session)
    }
  }
  return ids
}

/**
 * T-241: the stage agents the board only REMEMBERS — everything the live stage
 * claims above do NOT cover, taken from the card records themselves:
 * assignee, review.deliveredTo and test.deliveredTo of cards that are no longer
 * running/reviewing/testing.
 *
 * There is NO host archive API to fake (DSH keeps no archived-agent index): the
 * board's delivery records ARE the durable identity of a historical agent, which
 * is exactly what a task detail exposes for one card. This summary is the same
 * data for the whole project, newest card first, one row per Session, and it
 * deliberately carries no host-tree read — /meta?scope=history stays light.
 *
 * @param board the board to summarize.
 * @param [options] { limit } how many entries to list (default AGENT_HISTORY_LIMIT).
 * @returns {{available:boolean,source:string,active:number,total:number,count:number,truncated:boolean,limit:number,entries:Array}}
 */
export function recordedStageAgentsOf(board, options) {
  const opts = options === undefined || options === null ? {} : options
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : AGENT_HISTORY_LIMIT
  const live = liveStageAgentsOf(board)
  const tasks = board !== null && board !== undefined && Array.isArray(board.tasks) ? board.tasks.slice() : []
  // Newest card first: the history summary answers who worked here recently,
  // and the board's own updatedAt is the ordering it already trusts.
  tasks.sort(function (left, right) {
    const leftAt = left !== null && left !== undefined && typeof left.updatedAt === 'string' ? Date.parse(left.updatedAt) : Number.NaN
    const rightAt = right !== null && right !== undefined && typeof right.updatedAt === 'string' ? Date.parse(right.updatedAt) : Number.NaN
    const delta = (Number.isFinite(rightAt) ? rightAt : 0) - (Number.isFinite(leftAt) ? leftAt : 0)
    if (delta !== 0) return delta
    return String(left === null || left === undefined ? '' : left.id).localeCompare(String(right === null || right === undefined ? '' : right.id))
  })
  const seen = new Set()
  const entries = []
  for (const task of tasks) {
    if (task === null || task === undefined) continue
    if (LIVE_STAGE_STATUSES.indexOf(task.status) >= 0) continue
    for (const entry of stageAgentsOfTask(task)) {
      if (live.has(entry.session) === true || seen.has(entry.session) === true) continue
      seen.add(entry.session)
      if (entries.length < limit) entries.push(entry)
    }
  }
  return {
    available: true,
    source: 'board',
    active: live.size,
    total: seen.size,
    count: entries.length,
    truncated: seen.size > entries.length,
    limit: limit,
    entries: entries,
  }
}

// ── views ──────────────────────────────────────────────────────────────────

/**
 * T-230: the card read views are the FROZEN read model (read-model.mjs).
 *
 * These two exports are a compatibility delegation, not a second vocabulary:
 * every read surface (/state.tasks, /state.queue, /list, the tool list, /task,
 * the tool board and get) goes through the same builders with the same view, so
 * a card has ONE shape. `summary` is the TaskSummary contract (no spec /
 * acceptance / evidence / history / writeFiles / verify / full stage records);
 * `detail` is its strict superset.
 */
export function summary(board, task, now, view) {
  return buildTaskSummary(board, task, now, view)
}

/** The whole picture for one task: the summary plus the detail-class fields. */
export function detail(board, task, now, view) {
  return buildTaskDetail(board, task, now, view)
}
