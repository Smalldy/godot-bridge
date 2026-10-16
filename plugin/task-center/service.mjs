/**
 * The task center's model: task transitions and file-lock arbitration.
 *
 * Pure functions over plain data, with no Cordis and no filesystem, so the rules
 * can be tested directly and reused by both the `task_center` tool and (later)
 * the panel's host route. Every function takes the current state and returns the
 * next state plus the events it produced; nothing mutates in place, and every
 * refusal is a returned `{ ok: false, code }` rather than a throw, because the
 * caller has to turn it into something an agent or a user can read.
 *
 * STORED TIMES ARE ISO-8601 STRINGS. The board is a JSON file that users open and
 * hand-edit — the module even accepts a minimal hand-written board — and
 * `1780000000000` is not readable there. Countdowns therefore parse: the client
 * store converts to epoch milliseconds at its boundary, which is the one place
 * that should know about the difference.
 *
 * WHO HOLDS A LOCK: the agent, not the task. A lock outlives no task on purpose —
 * `taskId` rides along only as a display label, because the file is held by
 * whoever is writing it right now.
 */

/** Task statuses, matching what the panel already renders as six columns. */
export const STATUSES = ['draft', 'queued', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'cancelled']

/** Statuses a task may move to, per status. The panel can reach any state along
 * a legal path; an illegal move is refused with the list of legal targets.
 *
 * `claimed` is absent as a target on purpose: only claimTask produces it, so a
 * task can never be `claimed` with nobody holding it. `queued` is listed on
 * `claimed` because releaseClaim writes that move directly. */
export const TRANSITIONS = {
  // `draft -> done` is the conversation's own work: a draft is its work list, it does
  // the work itself, and it marks it complete. This edge was DECIDED long before it
  // existed (the proposal's frozen decision: 对话自己的活生命周期是 draft → done). Its
  // absence is why a finished draft could only be closed by publishing it into the
  // pool — the wrong door, which then had an agent start work that was already done.
  draft: ['queued', 'done', 'cancelled'],
  // `queued -> blocked` exists for exactly one reason: a pooled task whose dispatch
  // keeps failing must become VISIBLE as stuck. Leaving it queued while the dispatcher
  // refuses to touch it is invisible retention — it looks like work waiting its turn,
  // forever. Blocking it names the problem where a human will see it.
  queued: ['draft', 'blocked', 'cancelled'],
  claimed: ['in_progress', 'blocked', 'review', 'queued', 'cancelled'],
  in_progress: ['blocked', 'review', 'cancelled'],
  // `blocked -> queued` is the way BACK, and it belongs with `queued -> blocked`: a
  // human looked at a task the dispatcher gave up on and says "try again". Without it,
  // exceeding the retry ceiling is a one-way door — blocked leads only to claimed,
  // in_progress or cancelled, and reviving from cancelled takes three moves.
  //
  // NOTE: `in_progress -> done` is deliberately still ABSENT. It was proposed during
  // this work and rejected: it would let anyone claim completion without submitting for
  // review, which is the entire point of the review step.
  blocked: ['claimed', 'in_progress', 'queued', 'cancelled'],
  review: ['in_progress', 'done', 'cancelled'],
  done: ['in_progress'],
  cancelled: ['draft'],
}

/** Fields only their own operation may write: letting patchTask set `assignee`
 * or `leaseUntil` would walk around claiming, and `order` belongs to the queue. */
const OWNED_FIELDS = ['id', 'status', 'history', 'assignee', 'leaseUntil', 'leaseExpired', 'order', 'createdAt']

/** Default task lease: 10 minutes. See the proposal: liveness reaping handles a
 * dead holder immediately, so the lease only bounds "alive but idle", which is
 * why it can be generous rather than tight. */
export const TASK_LEASE_MS = 10 * 60 * 1000

const fail = (code, message) => ({ ok: false, code: code, message: message })
const iso = (now) => new Date(now).toISOString()
const clone = (value) => JSON.parse(JSON.stringify(value))

/** A task that has never been touched beyond being created. */
export function newTask(id, input, now, by) {
  return {
    id: id,
    title: String(input.title || '').trim(),
    spec: String(input.spec || ''),
    status: 'draft',
    priority: input.priority === undefined ? 'normal' : input.priority,
    order: 0,
    assignee: null,
    leaseUntil: null,
    leaseExpired: false,
    blockedBy: Array.isArray(input.blockedBy) ? input.blockedBy.slice() : [],
    acceptance: String(input.acceptance || ''),
    evidence: String(input.evidence || ''),
    planRef: String(input.planRef || ''),
    proposalRef: input.proposalRef === undefined ? null : input.proposalRef,
    proposalRevision: input.proposalRevision === undefined ? null : input.proposalRevision,
    createdAt: iso(now),
    updatedAt: iso(now),
    history: [{ at: iso(now), by: by, from: null, to: 'draft', note: input.note === undefined ? '' : input.note }],
  }
}

/** Append a task, allocating the next `T-<n>` id. */
export function createTask(board, input, now, by) {
  if (String(input.title || '').trim() === '') return fail('missing-title', 'a task needs a title')
  const next = clone(board)
  const id = 'T-' + String(next.seq)
  next.seq = next.seq + 1
  const task = newTask(id, input, now, by)
  task.order = next.tasks.length
  next.tasks.push(task)
  return { ok: true, board: next, task: task, events: [{ kind: 'created', id: id, who: by }] }
}

/** Find a task; `undefined` when absent, so callers can answer with their own code. */
export function findTask(board, id) {
  return board.tasks.filter((task) => task.id === id)[0]
}

/**
 * Change fields that are not status. `history` is appended only when a note is
 * given, so a pure field edit does not fill the timeline with noise. Fields in
 * OWNED_FIELDS are ignored, not an error: a caller that read a whole task and
 * wrote it back should not be able to move a claim by accident.
 *
 * A key whose value is `undefined` was NOT supplied, and is skipped. Callers pass
 * their whole option object through, so keys the caller never mentioned arrive as
 * undefined; writing those would wipe the fields, which means a partial update
 * would erase a title. `null` or `''` clears a field explicitly.
 */
export function patchTask(board, id, change, now, by) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  const next = clone(board)
  const target = findTask(next, id)
  let applied = 0
  for (const key of Object.keys(change)) {
    if (OWNED_FIELDS.indexOf(key) >= 0) continue
    if (key === 'note') continue
    if (change[key] === undefined) continue
    target[key] = change[key]
    applied++
  }
  if (applied === 0 && change.note === undefined) {
    return fail('no-change', 'nothing to change on ' + String(id) + ' (owned fields: ' + OWNED_FIELDS.join(', ') + ')')
  }
  target.updatedAt = iso(now)
  if (change.note !== undefined) {
    target.history.push({ at: iso(now), by: by, from: target.status, to: target.status, note: String(change.note) })
  }
  return { ok: true, board: next, task: target, events: [{ kind: 'updated', id: id, who: by }] }
}

/** Move a task along a legal edge, recording who moved it. */
export function setTaskStatus(board, id, status, now, by, note) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (STATUSES.indexOf(status) < 0) {
    return fail('unknown-status', 'unknown status ' + String(status) + '; known: ' + STATUSES.join(', '))
  }
  if (task.status === status) return fail('no-change', 'the task is already ' + status)
  const allowed = TRANSITIONS[task.status] || []
  if (allowed.indexOf(status) < 0) {
    return fail(
      'illegal-transition',
      'cannot move ' + task.id + ' from ' + task.status + ' to ' + status + '; allowed: ' + (allowed.join(', ') || 'nothing'),
    )
  }
  const next = clone(board)
  const target = findTask(next, id)
  const from = target.status
  target.status = status
  target.updatedAt = iso(now)
  if (status === 'queued') {
    // Appending to the queue must produce a DISTINCT order, otherwise a later
    // swap is a no-op on two tasks that happen to share one.
    const others = next.tasks.filter((entry) => entry.status === 'queued' && entry.id !== id)
    target.order = others.reduce((highest, entry) => Math.max(highest, entry.order), -1) + 1
  }
  if (status === 'claimed' || status === 'in_progress') target.leaseExpired = false
  // A lease is only live while somebody is on the task; the assignee stays as a
  // record of who did the work.
  if (status !== 'claimed' && status !== 'in_progress') target.leaseUntil = null
  target.history.push({ at: iso(now), by: by, from: from, to: status, note: note === undefined ? '' : note })
  return { ok: true, board: next, task: target, events: [{ kind: status === 'done' ? 'resolved' : 'moved', id: id, from: from, to: status, who: by }] }
}

/** draft → queued: the user's release, the second and last authorisation point. */
export function publishTask(board, id, now, by) {
  return setTaskStatus(board, id, 'queued', now, by, 'released')
}

/** queued → draft: withdraw from the queue before anyone claims it. */
export function unpublishTask(board, id, now, by) {
  return setTaskStatus(board, id, 'draft', now, by, 'withdrawn')
}

/**
 * Claim a task for an agent, with a lease.
 *
 * Claiming a task another agent holds with a live lease is refused; an expired
 * lease is taken over (and says so), because the previous holder is not coming
 * back — the same rule as a file lock, and for the same reason.
 */
export function claimTask(board, id, agent, now) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.status === 'draft') return fail('not-released', task.id + ' is still a draft; the user has not released it')
  if (task.status === 'done' || task.status === 'cancelled') return fail('closed', task.id + ' is ' + task.status)
  if (task.assignee !== null && task.assignee.name !== agent.name) {
    const held = task.leaseUntil !== null && Date.parse(task.leaseUntil) > now
    if (held) {
      return fail('held', task.id + ' is held by ' + task.assignee.name + ' until ' + task.leaseUntil)
    }
  }
  const next = clone(board)
  const target = findTask(next, id)
  const takenOver = target.assignee !== null && target.assignee.name !== agent.name
  target.assignee = { name: agent.name, session: agent.session === undefined ? null : agent.session }
  target.leaseUntil = iso(now + TASK_LEASE_MS)
  target.leaseExpired = false
  target.updatedAt = iso(now)
  if (target.status === 'queued') target.status = 'claimed'
  target.history.push({
    at: iso(now),
    by: agent.name,
    from: target.status,
    to: target.status,
    note: takenOver ? 'claimed (previous lease had expired)' : 'claimed',
  })
  return {
    ok: true,
    board: next,
    task: target,
    events: [{ kind: takenOver ? 'lease' : 'claimed', id: id, who: agent.name }],
  }
}

/** Extend a held lease; refusal when someone else holds it. */
export function renewClaim(board, id, agent, now) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.assignee === null || task.assignee.name !== agent.name) {
    return fail('not-holder', 'no live claim by ' + agent.name + ' on ' + String(id))
  }
  const next = clone(board)
  const target = findTask(next, id)
  target.leaseUntil = iso(now + TASK_LEASE_MS)
  target.leaseExpired = false
  target.updatedAt = iso(now)
  return { ok: true, board: next, task: target, events: [{ kind: 'lease', id: id, who: agent.name }] }
}

/** Give a task back to the queue. */
export function releaseClaim(board, id, now, by) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.assignee === null) return fail('not-claimed', task.id + ' is not claimed')
  const next = clone(board)
  const target = findTask(next, id)
  const who = target.assignee.name
  target.assignee = null
  target.leaseUntil = null
  target.leaseExpired = false
  target.status = 'queued'
  target.order = next.tasks.length
  target.updatedAt = iso(now)
  target.history.push({ at: iso(now), by: by, from: 'claimed', to: 'queued', note: 'released by ' + who })
  return { ok: true, board: next, task: target, events: [{ kind: 'freed', id: id, who: who }] }
}

/**
 * Flag expired task leases. It deliberately does NOT reassign.
 *
 * An expired file lock lets another writer in; an expired claim only makes the
 * task look stuck. Reassigning would take work away from an agent that may still
 * be at it, so the lease marks the task and leaves the decision to the user.
 */
export function expireTaskLeases(board, now) {
  const stale = board.tasks.filter(
    (task) => task.assignee !== null && task.leaseUntil !== null && Date.parse(task.leaseUntil) <= now && !task.leaseExpired,
  )
  if (stale.length === 0) return { ok: true, board: board, events: [] }
  const next = clone(board)
  for (const task of stale) {
    const target = findTask(next, task.id)
    target.leaseExpired = true
    target.updatedAt = iso(now)
    target.history.push({ at: iso(now), by: 'system', from: target.status, to: target.status, note: 'lease expired' })
  }
  return {
    ok: true,
    board: next,
    events: stale.map((task) => ({ kind: 'expired', id: task.id, who: task.assignee.name })),
  }
}

/**
 * Queue order is user-owned: move a task up or down among the released ones.
 *
 * The queue is renumbered 0..n-1 on every move. `order` is a position, not a
 * timestamp, and normalising it is what keeps a swap meaningful when two tasks
 * were appended before anyone reordered anything.
 */
export function reorderQueue(board, id, delta) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  const ordered = board.tasks.filter((entry) => entry.status === 'queued').sort((a, b) => a.order - b.order)
  const at = ordered.map((entry) => entry.id).indexOf(id)
  if (at < 0) return fail('not-queued', String(id) + ' is not in the queue')
  const to = at + delta
  if (to < 0 || to >= ordered.length) return fail('edge', 'the task is already at the ' + (delta < 0 ? 'top' : 'bottom'))
  const moved = ordered.slice()
  moved.splice(to, 0, moved.splice(at, 1)[0])
  const next = clone(board)
  moved.forEach((entry, index) => {
    findTask(next, entry.id).order = index
  })
  return { ok: true, board: next, queue: moved.map((entry) => entry.id), events: [{ kind: 'reordered', id: id, to: to }] }
}

/** Delete a task. Refused while it is claimed, so work cannot vanish under an agent. */
export function removeTask(board, id) {
  const task = findTask(board, id)
  if (task === undefined) return fail('unknown-task', 'no task with id ' + String(id))
  if (task.assignee !== null) return fail('claimed', task.id + ' is held by ' + task.assignee.name + '; release it first')
  const next = clone(board)
  next.tasks = next.tasks.filter((entry) => entry.id !== id)
  return { ok: true, board: next, events: [{ kind: 'removed', id: id }] }
}

// ── file locks ─────────────────────────────────────────────────────────────
//
// A lock record: { holder, taskId, since, leaseUntil, queue: [{ who, taskId, since }] }
// keyed by project-relative path. Locks live in host memory only: they are
// written far too often to share the board's CAS, and a lock whose holder died
// with the host should be gone anyway.

/** Nothing locked. */
export function emptyLocks() {
  return {}
}

/** The lock on one path, or `undefined`. */
export function lockAt(locks, path) {
  return Object.prototype.hasOwnProperty.call(locks, path) ? locks[path] : undefined
}

/** Every path an agent holds, and every path it is queued for. */
export function locksOfAgent(locks, agent) {
  const held = []
  const waiting = []
  for (const path of Object.keys(locks)) {
    const lock = locks[path]
    if (lock.holder === agent) held.push(path)
    if (lock.queue.some((entry) => entry.who === agent)) waiting.push(path)
  }
  return { held: held.sort(), waiting: waiting.sort() }
}

/** Paths with a live holder, contended ones first — the Files view's order. */
export function lockedPaths(locks) {
  return Object.keys(locks).sort((a, b) => {
    const left = locks[a]
    const right = locks[b]
    if (left.queue.length !== right.queue.length) return right.queue.length - left.queue.length
    return Date.parse(left.since) - Date.parse(right.since)
  })
}

/** The reservation that has waited longest, which is who release will grant to. */
export function nextWinner(locks, path) {
  const lock = lockAt(locks, path)
  if (lock === undefined || lock.queue.length === 0) return null
  return lock.queue.slice().sort((a, b) => Date.parse(a.since) - Date.parse(b.since))[0]
}

/**
 * Ask for a file.
 *
 * Free → the agent holds it outright. Held by the agent itself → the lease is
 * renewed, because re-asking is not a new claim. Held by someone else → the agent
 * joins the queue, and re-asking keeps its ORIGINAL request time: otherwise
 * asking twice would cleanly wash away its own seniority.
 */
export function acquireLock(locks, path, agent, taskId, now) {
  const next = clone(locks)
  const lock = lockAt(next, path)
  if (lock === undefined) {
    next[path] = { holder: agent, taskId: taskId === undefined ? null : taskId, since: iso(now), leaseUntil: iso(now + TASK_LEASE_MS), queue: [] }
    return { ok: true, locks: next, granted: true, events: [{ kind: 'took', path: path, who: agent }] }
  }
  if (lock.holder === agent) {
    lock.leaseUntil = iso(now + TASK_LEASE_MS)
    if (taskId !== undefined && taskId !== null) lock.taskId = taskId
    return { ok: true, locks: next, granted: true, events: [{ kind: 'lease', path: path, who: agent }] }
  }
  const existing = lock.queue.filter((entry) => entry.who === agent)[0]
  if (existing !== undefined) {
    if (taskId !== undefined && taskId !== null) existing.taskId = taskId
    return {
      ok: true,
      locks: next,
      granted: false,
      position: lock.queue.slice().sort((a, b) => Date.parse(a.since) - Date.parse(b.since)).map((entry) => entry.who).indexOf(agent) + 1,
      events: [{ kind: 'reserved', path: path, who: agent }],
    }
  }
  lock.queue.push({ who: agent, taskId: taskId === undefined ? null : taskId, since: iso(now) })
  return {
    ok: true,
    locks: next,
    granted: false,
    position: lock.queue.length,
    events: [{ kind: 'reserved', path: path, who: agent }],
    holder: lock.holder,
  }
}

/** Reserve without taking: an explicit "I want this next". */
export function reserveLock(locks, path, agent, taskId, now) {
  const lock = lockAt(locks, path)
  if (lock !== undefined && lock.holder === agent) {
    return { ok: true, locks: clone(locks), granted: true, events: [{ kind: 'lease', path: path, who: agent }] }
  }
  return acquireLock(locks, path, agent, taskId, now)
}

/**
 * Give a file up.
 *
 * When anyone is queued, the longest-waiting reservation is granted IN THE SAME
 * COMMIT, so a path never exists in the intermediate state of being unheld with
 * waiters on it. Refuses when the agent does not hold the path, so a mistaken
 * release cannot silently free someone else's file.
 */
export function releaseLock(locks, path, agent, now) {
  const lock = lockAt(locks, path)
  if (lock === undefined) return fail('not-held', path + ' is not held by anyone')
  if (lock.holder !== agent) return fail('not-holder', path + ' is held by ' + lock.holder + ', not ' + agent)
  const next = clone(locks)
  const winner = nextWinner(next, path)
  if (winner === null) {
    delete next[path]
    return { ok: true, locks: next, grantedTo: null, events: [{ kind: 'freed', path: path, who: agent }] }
  }
  next[path] = {
    holder: winner.who,
    taskId: winner.taskId,
    since: iso(now),
    leaseUntil: iso(now + TASK_LEASE_MS),
    queue: next[path].queue.filter((entry) => entry.who !== winner.who),
  }
  return {
    ok: true,
    locks: next,
    grantedTo: winner.who,
    events: [
      { kind: 'freed', path: path, who: agent },
      { kind: 'granted', path: path, who: winner.who },
    ],
  }
}

/** The user's override: free a path regardless of who holds it. */
export function forceReleaseLock(locks, path, now, by) {
  if (lockAt(locks, path) === undefined) return fail('not-held', path + ' is not held by anyone')
  const next = clone(locks)
  const before = next[path]
  const winner = nextWinner(next, path)
  if (winner === null) {
    delete next[path]
    return { ok: true, locks: next, grantedTo: null, events: [{ kind: 'freed', path: path, who: before.holder, forced: by }] }
  }
  next[path] = {
    holder: winner.who,
    taskId: winner.taskId,
    since: iso(now),
    leaseUntil: iso(now + TASK_LEASE_MS),
    queue: next[path].queue.filter((entry) => entry.who !== winner.who),
  }
  return {
    ok: true,
    locks: next,
    grantedTo: winner.who,
    events: [
      { kind: 'freed', path: path, who: before.holder, forced: by },
      { kind: 'granted', path: path, who: winner.who },
    ],
  }
}

/** Withdraw a reservation. */
export function cancelReservation(locks, path, agent) {
  const lock = lockAt(locks, path)
  if (lock === undefined) return fail('not-held', path + ' is not held by anyone')
  if (!lock.queue.some((entry) => entry.who === agent)) {
    return fail('not-queued', agent + ' is not queued for ' + path)
  }
  const next = clone(locks)
  next[path].queue = next[path].queue.filter((entry) => entry.who !== agent)
  return { ok: true, locks: next, events: [{ kind: 'withdrawn', path: path, who: agent }] }
}

/** An agent's exit: drop everything it holds and every reservation it made. */
export function releaseAllFor(locks, agent) {
  const next = clone(locks)
  const released = []
  for (const path of Object.keys(next)) {
    const lock = next[path]
    lock.queue = lock.queue.filter((entry) => entry.who !== agent)
    if (lock.holder !== agent) continue
    released.push(path)
    if (lock.queue.length === 0) {
      delete next[path]
      continue
    }
    const ordered = lock.queue.slice().sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
    const winner = ordered[0]
    next[path] = {
      holder: winner.who,
      taskId: winner.taskId,
      since: lock.since,
      leaseUntil: lock.leaseUntil,
      queue: ordered.slice(1),
    }
  }
  return { ok: true, locks: next, released: released.sort(), events: released.map((path) => ({ kind: 'freed', path: path, who: agent })) }
}

/**
 * Expire leases. Returns the events a caller must act on: the holder is told it
 * lost exclusivity, because a lease that expires silently is how two writers end
 * up in one file.
 *
 * `alive` is the liveness oracle — a predicate over holder names. A holder that
 * is known dead is reaped immediately regardless of its lease, because the lease
 * only ever existed to bound the "alive but idle" case.
 */
export function expireLocks(locks, now, alive) {
  const next = clone(locks)
  const expired = []
  for (const path of Object.keys(next)) {
    const lock = next[path]
    const dead = typeof alive === 'function' && !alive(lock.holder)
    const timedOut = lock.leaseUntil !== null && Date.parse(lock.leaseUntil) <= now
    if (!dead && !timedOut) continue
    expired.push({ path: path, who: lock.holder, reason: dead ? 'gone' : 'expired' })
    const winner = nextWinner(next, path)
    if (winner === null) {
      delete next[path]
      continue
    }
    next[path] = {
      holder: winner.who,
      taskId: winner.taskId,
      since: iso(now),
      leaseUntil: iso(now + TASK_LEASE_MS),
      queue: next[path].queue.filter((entry) => entry.who !== winner.who),
    }
  }
  return {
    ok: true,
    locks: next,
    expired: expired,
    events: expired.map((entry) => ({ kind: 'expired', path: entry.path, who: entry.who, reason: entry.reason })),
  }
}

/**
 * The whole picture for one agent: what it holds, what it waits for, where it
 * stands in each queue, and who is writing what. This is what a waiting agent
 * needs in order to decide whether to wait or do something else.
 */
export function agentView(locks, agent) {
  const own = locksOfAgent(locks, agent)
  return {
    held: own.held,
    waiting: own.waiting.map((path) => {
      const lock = locks[path]
      const ordered = lock.queue.slice().sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
      return {
        path: path,
        holder: lock.holder,
        position: ordered.map((entry) => entry.who).indexOf(agent) + 1,
        ahead: ordered.slice(0, ordered.map((entry) => entry.who).indexOf(agent)).map((entry) => entry.who),
        since: lock.queue.filter((entry) => entry.who === agent)[0].since,
      }
    }),
    writing: Object.keys(locks)
      .filter((path) => locks[path].holder !== null && locks[path].holder !== undefined)
      .sort()
      .map((path) => ({ path: path, who: locks[path].holder, taskId: locks[path].taskId, leaseUntil: locks[path].leaseUntil })),
  }
}

/** Paths an agent must not write to: held by someone else. */
export function blockedPaths(locks, agent) {
  return Object.keys(locks)
    .filter((path) => locks[path].holder !== agent)
    .sort()
}
