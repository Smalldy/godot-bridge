/**
 * Task center — the pure model.
 *
 * No Cordis, no filesystem, no timers. Every function takes the current board,
 * returns the next board plus the events it produced, and uses a returned
 * { ok: false, code, message } for a refusal. The HTTP route, the tool and the
 * scheduler all call these same functions, which keeps the three surfaces from
 * inventing their own rules.
 *
 * Statuses:
 *   pending    not dispatched; readiness is DERIVED from dependsOn
 *   running    owned by a worker, with a lease
 *   done       finished; satisfies dependents
 *   blocked    needs a human: manual block, dead worker or exhausted attempts
 *   cancelled  abandoned
 *
 * Dependencies point from a task to its prerequisites: B.dependsOn = [A] means
 * A <- B (A must be done before B runs).
 */

import {
  CLOSED_STATUSES,
  TASK_HEARTBEAT_MS,
  TASK_LEASE_MS,
  TASK_LEASE_EXTENSION_MAX_MS,
  TASK_LEASE_REMINDER_MS,
  normaliseDispatch,
  normaliseMerge,

  validateVerify,
} from './schema.mjs'

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

/** Mark every live executor entry retired (the caller replaces them). */
function retireExecutorsIn(target, now, reason) {
  const list = Array.isArray(target.executors) ? target.executors : []
  target.executors = list.map((entry) => (entry.retiredAt !== null && entry.retiredAt !== undefined ? entry : Object.assign({}, entry, { retiredAt: iso(now), retiredReason: String(reason) })))
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

/** Executor identities still counted as live: handed the task, never retired.
 * A running claim always counts as one, even on a board written before the ledger
 * existed, so the panel never reports "0 live executors" for running work. */
export function liveExecutors(task) {
  const list = task === null || task === undefined || !Array.isArray(task.executors) ? [] : task.executors
  const live = list.filter((entry) => entry !== null && typeof entry === 'object' && (entry.retiredAt === null || entry.retiredAt === undefined))
  if (live.length === 0 && task !== null && task !== undefined && task.status === 'running' && task.assignee !== null && task.assignee !== undefined) {
    return [{ name: String(task.assignee.name), session: task.assignee.session === undefined ? null : task.assignee.session, at: null, retiredAt: null, retiredReason: null }]
  }
  return live
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
    status: 'pending',
    priority: Number.isFinite(input.priority) ? Math.floor(input.priority) : 0,
    dependsOn: checked.dependsOn,
    writeFiles: normaliseList(input.writeFiles),
    verify: declaredVerify,
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
  const updatedVerify = input.verify === undefined ? undefined : validateVerify(input.verify)
  if (updatedVerify !== undefined && updatedVerify.ok !== true) {
    return fail(
      'invalid-verify',
      'verify must be { command: "a shell command", timeoutMs?: number } or null; got ' + JSON.stringify(input.verify),
    )
  }
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
    Object.assign({}, next.dispatch, { state: 'running', request: null, since: iso(now), by: by }),
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
  next.dispatch = merged
  if (changedState) {
    next.dispatch.since = iso(now)
    next.dispatch.by = by
  }
  next.updatedAt = iso(now)
  return done(next, [{ kind: 'dispatch', state: merged.state, who: by }], { dispatch: merged })
}

// ── task lifecycle ─────────────────────────────────────────────────────────

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
  if (dependency.merge === null || dependency.merge === undefined) return true
  return dependency.merge.status === 'merged'
}

/** Dependencies that are missing or cancelled make the task BROKEN (visible to
 * the user instead of waiting forever). A done-but-unmerged dependency is not
 * broken: it is still WAITING, and shows up in waitingOn. */
export function dependencyInfo(board, task) {
  const waitingOn = []
  const brokenOn = []
  for (const id of task.dependsOn) {
    const dependency = findTask(board, id)
    if (dependency === undefined || dependency.status === 'cancelled') {
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
  return board.tasks
    .filter((task) => task.status === 'pending' && dependencyInfo(board, task).state === 'ready')
    .sort((left, right) => {
      if (right.priority !== left.priority) return right.priority - left.priority
      const created = Date.parse(left.createdAt) - Date.parse(right.createdAt)
      if (created !== 0) return created
      return left.id.localeCompare(right.id)
    })
}

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
  target.status = 'running'
  target.lastAssignee = null
  target.assignee = {
    name: worker.name === undefined ? '@worker' : String(worker.name),
    session: worker.session === undefined || worker.session === null ? null : String(worker.session),
  }
  target.leaseUntil = iso(now + TASK_LEASE_MS)
  target.attempts = target.attempts + 1
  // One live executor per task: everything handed this card before is retired by
  // this claim, so "live executors" is always 1 for a healthy running task.
  retireExecutorsIn(target, now, 'superseded by ' + target.assignee.name)
  pushExecutor(target, target.assignee, now)
  target.base = typeof worktree.base === 'string' ? worktree.base : null
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
  // The claim charged one attempt; the worker never ran, so give it back.
  target.attempts = Math.max(0, target.attempts - 1)
  target.interruptions = (Number.isFinite(target.interruptions) ? target.interruptions : 0) + 1
  const committed = typeof target.commit === 'string' && target.commit !== ''
  const tooMany = target.interruptions >= limit && committed !== true
  target.status = tooMany ? 'blocked' : 'pending'
  target.lastAssignee = target.assignee === null || target.assignee === undefined ? target.lastAssignee : Object.assign({}, target.assignee)
  retireExecutorsIn(target, now, 'interrupted: ' + reason)
  target.assignee = null
  target.leaseUntil = null
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

/** A dispatch that failed before or while delivering: drop the claim, count the
 * attempt that was already spent, and block once the budget is gone. */
export function failDispatch(board, id, error, now, maxAttempts) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  const limit = Number.isFinite(maxAttempts) ? maxAttempts : target.maxAttempts
  const exhausted = target.attempts >= limit
  target.status = exhausted ? 'blocked' : 'pending'
  target.lastAssignee = target.assignee === null || target.assignee === undefined ? target.lastAssignee : Object.assign({}, target.assignee)
  // A REAL failure is not an interruption: the streak restarts, so five host
  // restarts can never be charged against a worker that actually broke something.
  target.interruptions = 0
  retireExecutorsIn(target, now, 'dispatch failed')
  target.assignee = null
  target.leaseUntil = null
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
    target.status = exhausted ? 'blocked' : 'pending'
    target.lastAssignee = target.assignee === null || target.assignee === undefined ? target.lastAssignee : Object.assign({}, target.assignee)
    target.assignee = null
    target.leaseUntil = null
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
export function submitTask(board, id, input, now, by, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'running') return fail('not-running', id + ' is ' + task.status + ', not running')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  if (input !== undefined && input.evidence !== undefined) target.evidence = String(input.evidence)
  if (input !== undefined && input.commit !== undefined) target.commit = String(input.commit)
  if (input !== undefined && input.actualFiles !== undefined) target.actualFiles = normaliseList(input.actualFiles)
  if (input !== undefined && input.merge !== undefined) target.merge = normaliseMerge(input.merge)
  // A submission is proof the worker ran: the infrastructure-interruption streak
  // (and the attempt refunds that came with it) starts over.
  target.interruptions = 0
  target.status = 'reviewing'
  target.leaseUntil = null
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
 */
export function approveReview(board, id, now, by, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'reviewing') return fail('not-reviewing', id + ' is ' + task.status + ', not reviewing')
  if (task.review === null || task.review.status !== 'pending') return fail('no-pending-review', id + ' has no review decision to approve')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.review = Object.assign({}, target.review, { status: 'approved', by: by, byName: byName === undefined ? null : byName, at: iso(now) })
  target.test = {
    status: 'pending',
    by: null,
    byName: null,
    at: iso(now),
    evidence: null,
    attempt: (target.test === null ? 0 : target.test.attempt) + 1,
  }
  target.status = 'testing'
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

export function requestChanges(board, id, reasons, now, by, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'reviewing') return fail('not-reviewing', id + ' is ' + task.status + ', not reviewing')
  if (task.review === null || task.review.status !== 'pending') return fail('no-pending-review', id + ' has no review decision to change')
  const text = String(reasons === undefined || reasons === null ? '' : reasons).trim()
  if (text === '') return fail('missing-reasons', 'requestChanges needs reasons the worker can act on')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.review = Object.assign({}, target.review, { status: 'changes-requested', by: by, byName: byName === undefined ? null : byName, at: iso(now), reasons: text })
  target.status = 'running'
  target.leaseUntil = iso(now + TASK_LEASE_MS)
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
 */
export function passTest(board, id, now, by, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'testing') return fail('not-testing', id + ' is ' + task.status + ', not testing')
  if (task.test === null || task.test.status !== 'pending') return fail('no-pending-test', id + ' has no test decision to pass')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.test = Object.assign({}, target.test, { status: 'passed', by: by, byName: byName === undefined ? null : byName, at: iso(now) })
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

export function failTest(board, id, evidence, now, by, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'testing') return fail('not-testing', id + ' is ' + task.status + ', not testing')
  if (task.test === null || task.test.status !== 'pending') return fail('no-pending-test', id + ' has no test decision to fail')
  const text = String(evidence === undefined || evidence === null ? '' : evidence).trim()
  if (text === '') return fail('missing-evidence', 'failTest needs the evidence the worker can act on')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.test = Object.assign({}, target.test, { status: 'failed', by: by, byName: byName === undefined ? null : byName, at: iso(now), evidence: text })
  target.status = 'running'
  target.leaseUntil = iso(now + TASK_LEASE_MS)
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

export function cancelTask(board, id, now, by, note, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status === 'cancelled') return fail('already-cancelled', id + ' is already cancelled')
  if (task.status === 'done') return fail('done', id + ' is done; reopen it before cancelling')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.status = 'cancelled'
  // Keep the last owner: the assignee is cleared here, but the soft refusal has
  // to recognise this worker if it calls again on the cancelled task.
  target.lastAssignee = target.assignee === null || target.assignee === undefined ? null : Object.assign({}, target.assignee)
  retireExecutorsIn(target, now, 'task cancelled')
  target.assignee = null
  target.leaseUntil = null
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, byName: byName === undefined ? null : byName, from: task.status, to: 'cancelled', note: note === undefined ? 'cancelled' : String(note) })
  return done(next, [{ kind: 'cancelled', id: id, who: by }], { task: target })
}

export function reopenTask(board, id, now, by, note, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'blocked') {
    return fail('not-closed', id + ' is ' + task.status + '; only done, cancelled or blocked tasks are reopened')
  }
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.status = 'pending'
  target.assignee = null
  target.leaseUntil = null
  target.attempts = 0
  // A reopened task starts over: the interruption streak and the executor ledger
  // are history too, otherwise a triaged card would block again on the next restart.
  target.interruptions = 0
  target.executors = []
  target.dispatch = null
  // A reopened task starts the phase machine from scratch.
  target.review = null
  target.test = null
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, byName: byName === undefined ? null : byName, from: task.status, to: 'pending', note: note === undefined ? 'reopened' : String(note) })
  return done(next, [{ kind: 'reopened', id: id, who: by }], { task: target })
}

export function blockTask(board, id, now, by, note, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status === 'done' || task.status === 'cancelled') return fail('closed', id + ' is ' + task.status)
  if (task.status === 'blocked') return fail('already-blocked', id + ' is already blocked')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.status = 'blocked'
  target.lastAssignee = target.assignee === null || target.assignee === undefined ? null : Object.assign({}, target.assignee)
  retireExecutorsIn(target, now, 'task blocked')
  target.assignee = null
  target.leaseUntil = null
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, byName: byName === undefined ? null : byName, from: task.status, to: 'blocked', note: note === undefined ? 'blocked' : String(note) })
  return done(next, [{ kind: 'blocked', id: id, who: by }], { task: target })
}

export function unblockTask(board, id, now, by, note, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'blocked') return fail('not-blocked', id + ' is ' + task.status + ', not blocked')
  return reopenTask(board, id, now, by, note === undefined ? 'unblocked' : note, byName)
}

export function retryTask(board, id, now, by, note, byName) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'blocked' && task.status !== 'pending') {
    return fail('not-retryable', id + ' is ' + task.status + '; only a blocked or pending task is retried')
  }
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.status = 'pending'
  target.assignee = null
  target.leaseUntil = null
  target.attempts = 0
  // Retrying is an explicit human decision: the interruption streak and the
  // executor ledger are cleared so the card cannot block on old history.
  target.interruptions = 0
  target.executors = []
  target.dispatch = null
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
    target.leaseUntil = iso(now + TASK_LEASE_MS)
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
  target.leaseUntil = iso(now + TASK_LEASE_MS)
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
    target.leaseUntil = iso(now + TASK_LEASE_MS)
    touch(target, now)
    renewed.push(target.id)
  }
  if (renewed.length === 0) return done(board, [], { renewed: [] })
  return done(next, [], { renewed: renewed })
}

// ── views ──────────────────────────────────────────────────────────────────

export function counts(board) {
  const out = {
    total: board.tasks.length,
    pending: 0,
    ready: 0,
    running: 0,
    reviewing: 0,
    testing: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
  }
  const ready = new Set(readyTasks(board).map((task) => task.id))
  for (const task of board.tasks) {
    out[task.status] = (out[task.status] || 0) + 1
    if (ready.has(task.id)) out.ready += 1
  }
  return out
}

export function summary(board, task, now) {
  const dependency = dependencyInfo(board, task)
  const at = typeof now === 'number' ? now : Date.now()
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    dependsOn: task.dependsOn,
    dependency: dependency,
    writeFiles: task.writeFiles,
    verify: task.verify,
    worktree: task.worktree,
    worktreeError: task.worktreeError,
    branch: task.branch,
    base: task.base,
    target: task.target,
    commit: task.commit,
    actualFiles: task.actualFiles,
    requiredRole: task.requiredRole,
    merge: task.merge,
    review: task.review,
    test: task.test,
    assignee: task.assignee,
    lastAssignee: task.lastAssignee,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    interruptions: Number.isFinite(task.interruptions) ? task.interruptions : 0,
    executors: Array.isArray(task.executors) ? task.executors : [],
    liveExecutors: liveExecutors(task).length,
    leaseUntil: task.leaseUntil,
    leaseRemaining: task.leaseUntil === null ? null : Math.max(0, Date.parse(task.leaseUntil) - at),
    leaseExpired: task.leaseUntil !== null && Date.parse(task.leaseUntil) <= at,
    leaseReminder:
      task.status === 'running' &&
      task.leaseUntil !== null &&
      Date.parse(task.leaseUntil) > at &&
      Date.parse(task.leaseUntil) - at <= TASK_LEASE_REMINDER_MS,
    dispatch: task.dispatch,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

/** The whole picture for one task, with dependency states and history. */
export function detail(board, task, now) {
  return Object.assign(summary(board, task, now), {
    spec: task.spec,
    acceptance: task.acceptance,
    evidence: task.evidence,
    createdBy: task.createdBy,
    history: task.history,
  })
}
