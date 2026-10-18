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

import { CLOSED_STATUSES, TASK_LEASE_MS, normaliseDispatch, normaliseMerge } from './schema.mjs'

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
    from: entry.from === undefined ? task.status : entry.from,
    to: entry.to === undefined ? task.status : entry.to,
    note: entry.note === undefined ? '' : entry.note,
  })
}

function touch(task, now) {
  task.updatedAt = iso(now)
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
export function validateDepends(board, taskId, dependsOn) {
  const ids = normaliseList(dependsOn)
  if (taskId !== undefined && ids.indexOf(taskId) >= 0) return fail('self-dependency', 'a task cannot depend on itself')
  const byId = new Map(board.tasks.map((task) => [task.id, task]))
  for (const id of ids) {
    const task = byId.get(id)
    if (task === undefined) return fail('unknown-dependency', 'depends on ' + id + ', which does not exist')
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
  const checked = validateDepends(board, undefined, input.dependsOn)
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
    base: null,
    target: null,
    branch: null,
    worktree: null,
    worktreeError: null,
    commit: null,
    actualFiles: [],
    requiredRole: null,
    merge: null,
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
const HOST_ONLY_FIELDS = ['base', 'target', 'branch', 'worktree', 'commit', 'actualFiles', 'merge']

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
    const checked = validateDepends(board, id, input.dependsOn)
    if (checked.ok !== true) return checked
  }
  if (input.title !== undefined && String(input.title).trim() === '') return fail('missing-title', 'a task needs a title')
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
  if (input.writeFiles !== undefined) {
    target.writeFiles = normaliseList(input.writeFiles)
    notes.push('files: ' + (target.writeFiles.length === 0 ? 'none' : target.writeFiles.join(', ')))
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
  target.status = 'running'
  target.assignee = {
    name: worker.name === undefined ? '@worker' : String(worker.name),
    session: worker.session === undefined || worker.session === null ? null : String(worker.session),
  }
  target.leaseUntil = iso(now + TASK_LEASE_MS)
  target.attempts = target.attempts + 1
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
    via: worker.via === undefined ? null : String(worker.via),
    error: null,
    host: worker.host === undefined || worker.host === null ? null : String(worker.host),
    keep: worktree.keep === true,
  }
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: 'scheduler',
    from: 'pending',
    to: 'running',
    note: 'dispatched to ' + target.assignee.name + (target.attempts > 1 ? ' (attempt ' + String(target.attempts) + ')' : ''),
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

/** Running tasks whose lease expired come back to the pool; after the attempt
 * budget they become blocked instead, so a crash loop is visible. */
export function expireLeases(board, now, maxAttempts) {
  const next = clone(board)
  const reaped = []
  for (const target of next.tasks) {
    if (target.status !== 'running') continue
    if (target.leaseUntil !== null && Date.parse(target.leaseUntil) > now) continue
    const limit = Number.isFinite(maxAttempts) ? maxAttempts : target.maxAttempts
    const exhausted = target.attempts >= limit
    const who = target.assignee === null ? 'unknown' : target.assignee.name
    target.status = exhausted ? 'blocked' : 'pending'
    target.assignee = null
    target.leaseUntil = null
    target.dispatch = Object.assign({}, target.dispatch === null ? {} : target.dispatch, {
      status: exhausted ? 'exhausted' : 'lease-expired',
      error: 'lease expired',
      at: iso(now),
    })
    touch(target, now)
    pushHistory(target, {
      at: iso(now),
      by: 'system',
      from: 'running',
      to: target.status,
      note: 'lease expired for ' + who + (exhausted ? '; attempt budget spent' : '; returned to the pool'),
    })
    reaped.push(target.id)
  }
  if (reaped.length === 0) return done(board, [])
  return done(next, reaped.map((id) => ({ kind: 'lease-expired', id: id })), { reaped: reaped })
}

/**
 * An agent reports the work finished. There is no review step in this version:
 * submission IS completion, so dependents are released immediately.
 *
 * The API commits a task's worktree BEFORE calling this and passes the result
 * (`commit`, `actualFiles`, `merge`); the model only records it, because
 * service.mjs stays pure. A task without a worktree simply never carries them.
 */
export function submitTask(board, id, input, now, by) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'running') return fail('not-running', id + ' is ' + task.status + ', not running')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  if (input !== undefined && input.evidence !== undefined) target.evidence = String(input.evidence)
  if (input !== undefined && input.commit !== undefined) target.commit = String(input.commit)
  if (input !== undefined && input.actualFiles !== undefined) target.actualFiles = normaliseList(input.actualFiles)
  if (input !== undefined && input.merge !== undefined) target.merge = normaliseMerge(input.merge)
  target.status = 'done'
  target.leaseUntil = null
  target.dispatch = Object.assign({}, target.dispatch === null ? {} : target.dispatch, {
    status: 'submitted',
    at: iso(now),
  })
  touch(target, now)
  pushHistory(target, {
    at: iso(now),
    by: by,
    from: 'running',
    to: 'done',
    note: input !== undefined && input.note !== undefined ? String(input.note) : 'completed',
  })
  return done(next, [{ kind: 'done', id: id, who: by }], { task: target })
}

export function cancelTask(board, id, now, by, note) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status === 'cancelled') return fail('already-cancelled', id + ' is already cancelled')
  if (task.status === 'done') return fail('done', id + ' is done; reopen it before cancelling')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.status = 'cancelled'
  target.assignee = null
  target.leaseUntil = null
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, from: task.status, to: 'cancelled', note: note === undefined ? 'cancelled' : String(note) })
  return done(next, [{ kind: 'cancelled', id: id, who: by }], { task: target })
}

export function reopenTask(board, id, now, by, note) {
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
  target.dispatch = null
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, from: task.status, to: 'pending', note: note === undefined ? 'reopened' : String(note) })
  return done(next, [{ kind: 'reopened', id: id, who: by }], { task: target })
}

export function blockTask(board, id, now, by, note) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status === 'done' || task.status === 'cancelled') return fail('closed', id + ' is ' + task.status)
  if (task.status === 'blocked') return fail('already-blocked', id + ' is already blocked')
  const next = clone(board)
  const target = findTaskIn(next.tasks, id)
  target.status = 'blocked'
  target.assignee = null
  target.leaseUntil = null
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, from: task.status, to: 'blocked', note: note === undefined ? 'blocked' : String(note) })
  return done(next, [{ kind: 'blocked', id: id, who: by }], { task: target })
}

export function unblockTask(board, id, now, by, note) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status !== 'blocked') return fail('not-blocked', id + ' is ' + task.status + ', not blocked')
  return reopenTask(board, id, now, by, note === undefined ? 'unblocked' : note)
}

export function retryTask(board, id, now, by, note) {
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
  target.dispatch = null
  touch(target, now)
  pushHistory(target, { at: iso(now), by: by, from: task.status, to: 'pending', note: note === undefined ? 'retry requested' : String(note) })
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

// ── views ──────────────────────────────────────────────────────────────────

export function counts(board) {
  const out = { total: board.tasks.length, pending: 0, ready: 0, running: 0, done: 0, blocked: 0, cancelled: 0 }
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
    worktree: task.worktree,
    worktreeError: task.worktreeError,
    branch: task.branch,
    base: task.base,
    target: task.target,
    commit: task.commit,
    actualFiles: task.actualFiles,
    requiredRole: task.requiredRole,
    merge: task.merge,
    assignee: task.assignee,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    leaseUntil: task.leaseUntil,
    leaseExpired: task.leaseUntil !== null && Date.parse(task.leaseUntil) <= at,
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
