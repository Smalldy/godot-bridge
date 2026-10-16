// Model tests for the task center: task transitions and file-lock arbitration.
//
// The rules worth pinning are the ones that are easy to get subtly wrong and
// hard to see in the UI: that releasing a lock grants the longest waiter within
// the same commit, that re-asking keeps your original place in the queue, that
// an expired task lease flags rather than reassigns, that a dead holder is reaped
// immediately while a live one is left alone, and that no operation mutates the
// state it was handed.
//
// Run by `npm test`.
import {
  STATUSES,
  TRANSITIONS,
  TASK_LEASE_MS,
  acquireLock,
  agentView,
  blockedPaths,
  cancelReservation,
  claimTask,
  createTask,
  emptyLocks,
  expireLocks,
  expireTaskLeases,
  findTask,
  forceReleaseLock,
  lockAt,
  lockedPaths,
  locksOfAgent,
  nextWinner,
  publishTask,
  releaseAllFor,
  releaseClaim,
  releaseLock,
  removeTask,
  reorderQueue,
  patchTask,
  renewClaim,
  reserveLock,
  setTaskStatus,
  unpublishTask,
} from '../../plugin/task-center/service.mjs'
import { emptyBoard } from '../../plugin/task-center/board.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || detail === undefined ? '' : '  -> ' + detail}`)
}

const T0 = Date.parse('2026-10-14T12:00:00.000Z')
const MIN = 60 * 1000
const ALICE = { name: '@alice', session: 'session-a' }
const BOB = { name: '@bob', session: 'session-b' }
const frozen = (value) => JSON.stringify(value)

// ── tasks: creation and identity ───────────────────────────────────────────
let board = emptyBoard()
check('an empty board carries a schema version and a sequence', board.version === 1 && board.seq === 1)

let result = createTask(board, { title: '   ' }, T0, 'user')
check('a task without a title is refused', result.ok === false && result.code === 'missing-title', JSON.stringify(result))

result = createTask(board, { title: '伤害系统重构' }, T0, 'user')
check('creating allocates T-1', result.ok === true && result.task.id === 'T-1', JSON.stringify(result.task && result.task.id))
check('a new task starts as a draft', result.task.status === 'draft')
check('a new task records its creation in history', result.task.history.length === 1 && result.task.history[0].to === 'draft')
check('history is stamped in ISO, not epoch', /^\d{4}-\d{2}-\d{2}T/.test(result.task.history[0].at), result.task.history[0].at)
board = result.board
result = createTask(board, { title: 'second' }, T0 + MIN, 'user')
check('ids do not repeat', result.task.id === 'T-2', result.task.id)
board = result.board
check('the sequence advanced past both tasks', board.seq === 3, String(board.seq))

// ── tasks: status transitions ──────────────────────────────────────────────
let before = frozen(board)
result = publishTask(board, 'T-1', T0, 'user')
check('publishing moves a draft into the queue', result.ok === true && result.task.status === 'queued', JSON.stringify(result))
check('publishing appends a history entry', result.task.history[1].from === 'draft' && result.task.history[1].to === 'queued')
check('publishing does not mutate the board it was given', frozen(board) === before)
board = result.board

result = unpublishTask(board, 'T-1', T0, 'user')
check('withdrawing returns it to draft', result.ok === true && result.task.status === 'draft')
board = result.board
board = publishTask(board, 'T-1', T0, 'user').board

result = claimTask(board, 'T-1', ALICE, T0)
check('claiming a released task assigns an agent', result.ok === true && result.task.assignee.name === '@alice', JSON.stringify(result.task && result.task.assignee))
check('claiming sets the status to claimed', result.task.status === 'claimed')
check('claiming starts a lease', Date.parse(result.task.leaseUntil) === T0 + TASK_LEASE_MS, result.task.leaseUntil)
check('claiming reports the event the panel localises', result.events[0].kind === 'claimed', JSON.stringify(result.events))
board = result.board

result = claimTask(board, 'T-1', BOB, T0 + MIN)
check('a live claim cannot be taken by another agent', result.ok === false && result.code === 'held', JSON.stringify(result))
result = renewClaim(board, 'T-1', BOB, T0 + MIN)
check('a non-holder cannot renew', result.ok === false && result.code === 'not-holder')
result = renewClaim(board, 'T-1', ALICE, T0 + MIN)
check('the holder can renew its own lease', result.ok === true && Date.parse(result.task.leaseUntil) === T0 + MIN + TASK_LEASE_MS)
check('renewing reports a lease event', result.events[0].kind === 'lease')
board = result.board

result = claimTask(board, 'T-1', BOB, T0 + 2 * TASK_LEASE_MS)
check('an expired claim can be taken over', result.ok === true && result.task.assignee.name === '@bob', JSON.stringify(result))
check('the takeover is reported as a lease event', result.events[0].kind === 'lease')
check('the takeover is recorded in history', /previous lease had expired/.test(result.task.history[result.task.history.length - 1].note))
board = result.board

result = setTaskStatus(board, 'T-1', 'in_progress', T0 + 2 * TASK_LEASE_MS, '@bob')
check('claimed → in_progress is legal', result.ok === true && result.task.status === 'in_progress')
board = result.board
result = setTaskStatus(board, 'T-2', 'in_progress', T0, '@bob')
check('a status jump from draft is refused', result.ok === false && result.code === 'illegal-transition', JSON.stringify(result))
check('the refusal names the legal targets', /allowed: queued, done, cancelled/.test(result.message), result.message)
result = setTaskStatus(board, 'T-1', 'bogus', T0, '@bob')
check('an unknown status is refused', result.ok === false && result.code === 'unknown-status')
result = setTaskStatus(board, 'T-9', 'review', T0, '@bob')
check('an unknown task is refused', result.ok === false && result.code === 'unknown-task')

result = setTaskStatus(board, 'T-1', 'review', T0, '@bob')
check('in_progress → review is legal', result.ok === true)
board = result.board
result = setTaskStatus(board, 'T-1', 'done', T0, 'user')
check('review → done is legal', result.ok === true && result.task.status === 'done')
check('closing reports the resolved event', result.events[0].kind === 'resolved', JSON.stringify(result.events))
check('a closed task keeps its assignee as a record', result.task.assignee.name === '@bob')
check('a closed task has no live lease', result.task.leaseUntil === null)
board = result.board
result = setTaskStatus(board, 'T-1', 'in_progress', T0, '@bob')
check('a closed task can be reopened', result.ok === true && result.task.status === 'in_progress')
board = result.board

result = releaseClaim(board, 'T-1', T0, '@bob')
check('releasing returns the task to the queue', result.ok === true && result.task.status === 'queued')
check('releasing clears the assignee', result.task.assignee === null)
check('releasing reports a freed event', result.events[0].kind === 'freed')
board = result.board
result = releaseClaim(board, 'T-1', T0, '@bob')
check('releasing an unclaimed task is refused', result.ok === false && result.code === 'not-claimed')

result = claimTask(board, 'T-1', ALICE, T0)
board = result.board
result = removeTask(board, 'T-1')
check('a claimed task cannot be deleted', result.ok === false && result.code === 'claimed', JSON.stringify(result))

// ── tasks: patch, ordering, leases ─────────────────────────────────────────
before = frozen(board)
result = patchTask(board, 'T-2', { title: 'renamed', spec: 'do it' }, T0, 'user')
check('patching changes non-owned fields', result.ok === true && result.task.title === 'renamed' && result.task.spec === 'do it')
check('patching does not mutate the board it was given', frozen(board) === before)
check('patching has no history noise without a note', result.task.history.length === 1)
board = result.board
result = patchTask(board, 'T-2', { assignee: { name: '@mallory' }, leaseUntil: '2030-01-01T00:00:00.000Z' }, T0, 'user')
check('patching cannot move a claim', result.ok === false && result.code === 'no-change', JSON.stringify(result))
check('and the assignee is still nobody', findTask(board, 'T-2').assignee === null, JSON.stringify(findTask(board, 'T-2').assignee))
result = patchTask(board, 'T-2', { note: 'looked at it' }, T0, 'user')
check('a note alone is applied', result.ok === true && result.task.history.length === 2)
check('and the fields it did not mention survive', result.task.title === 'renamed', String(result.task.title))
result = patchTask(result.board, 'T-2', { title: undefined, spec: '' }, T0, 'user')
check('an undefined value is not a change', result.ok === true && result.task.title === 'renamed', String(result.task.title))
check('while an empty string clears explicitly', result.task.spec === '')
result = patchTask(result.board, 'T-2', { blockedBy: ['T-1'] }, T0, 'user')
check('dependencies can be recorded without blocking the task', result.ok === true && result.task.blockedBy.join(',') === 'T-1')
check('and the status is untouched by it', result.task.status === 'draft')
board = result.board
board = publishTask(board, 'T-1', T0, 'user').board
board = publishTask(board, 'T-2', T0 + MIN, 'user').board
const queueIds = (value) =>
  value.tasks
    .filter((entry) => entry.status === 'queued')
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.id)
check('the queue is in release order', queueIds(board).join(',') === 'T-1,T-2', queueIds(board).join(','))
check('queue positions are distinct', new Set(board.tasks.filter((entry) => entry.status === 'queued').map((entry) => entry.order)).size === 2)
result = reorderQueue(board, 'T-2', -1)
check('reordering moves a task up', result.ok === true, JSON.stringify(result))
check('the queue order actually swapped', queueIds(result.board).join(',') === 'T-2,T-1', queueIds(result.board).join(','))
check('reordering reports the new queue', result.queue === undefined || result.queue.join(',') === 'T-2,T-1', JSON.stringify(result.queue))
board = result.board
result = reorderQueue(board, 'T-2', -1)
check('reordering past the top is refused', result.ok === false && result.code === 'edge')
result = reorderQueue(board, 'T-1', 1)
check('reordering past the bottom is refused', result.ok === false && result.code === 'edge')

board = claimTask(board, 'T-1', ALICE, T0).board
result = expireTaskLeases(board, T0 + MIN)
check('a live lease is not flagged', result.events.length === 0, JSON.stringify(result.events))
result = expireTaskLeases(board, T0 + TASK_LEASE_MS + 1)
check('an expired lease is flagged', result.ok === true && result.events.length === 1 && result.events[0].kind === 'expired', JSON.stringify(result.events))
check('flagging marks the task', result.board.tasks.filter((task) => task.id === 'T-1')[0].leaseExpired === true)
check('flagging does NOT reassign the task', findTask(result.board, 'T-1').assignee.name === '@alice')
check('flagging records it in history', /lease expired/.test(findTask(result.board, 'T-1').history.slice(-1)[0].note))
check('flagging twice in a row is a no-op', expireTaskLeases(result.board, T0 + TASK_LEASE_MS + 2).events.length === 0)

// An expired lease flags, so the task is still held — and therefore still not
// deletable. Releasing it first is what unlocks deletion.
board = result.board
result = removeTask(board, 'T-1')
check('an expired claim still blocks deletion', result.ok === false && result.code === 'claimed', JSON.stringify(result))
board = releaseClaim(board, 'T-1', T0, 'user').board
result = removeTask(board, 'T-1')
check('a released task can be deleted', result.ok === true && findTask(result.board, 'T-1') === undefined)
board = result.board

// ── locks: taking ──────────────────────────────────────────────────────────
let locks = emptyLocks()
before = frozen(locks)
result = acquireLock(locks, 'scripts/core/damage.gd', '@alice', 'T-1', T0)
check('a free path is granted outright', result.ok === true && result.granted === true)
check('the holder is recorded with its task label', result.locks['scripts/core/damage.gd'].holder === '@alice' && result.locks['scripts/core/damage.gd'].taskId === 'T-1')
check('taking reports the took event the panel localises', result.events[0].kind === 'took', JSON.stringify(result.events))
check('taking does not mutate the locks it was given', frozen(locks) === before)
locks = result.locks

result = acquireLock(locks, 'scripts/core/damage.gd', '@alice', 'T-1', T0 + MIN)
check('re-asking by the holder is not a new claim', result.granted === true && result.locks['scripts/core/damage.gd'].queue.length === 0)
check('re-asking renews the lease', Date.parse(result.locks['scripts/core/damage.gd'].leaseUntil) === T0 + MIN + TASK_LEASE_MS)
check('re-asking reports a lease event', result.events[0].kind === 'lease')
locks = result.locks

result = acquireLock(locks, 'scripts/core/damage.gd', '@bob', 'T-2', T0 + MIN)
check('a held path queues the second agent', result.granted === false && result.holder === '@alice', JSON.stringify(result))
check('the queue position is reported', result.position === 1, String(result.position))
check('a reservation reports the reserved event', result.events[0].kind === 'reserved')
locks = result.locks
result = acquireLock(locks, 'scripts/core/damage.gd', '@carol', 'T-3', T0 + 2 * MIN)
locks = result.locks
check('the queue is ordered by request time', locks['scripts/core/damage.gd'].queue.map((entry) => entry.who).join(',') === '@bob,@carol')

const bobWait = locks['scripts/core/damage.gd'].queue.filter((entry) => entry.who === '@bob')[0].since
result = acquireLock(locks, 'scripts/core/damage.gd', '@bob', 'T-2', T0 + 5 * MIN)
check('re-asking keeps the original request time', result.locks['scripts/core/damage.gd'].queue.filter((entry) => entry.who === '@bob')[0].since === bobWait, bobWait)
check('and does not duplicate the queue entry', result.locks['scripts/core/damage.gd'].queue.length === 2)
locks = result.locks
check('the longest waiter is the next winner', nextWinner(locks, 'scripts/core/damage.gd').who === '@bob')

result = reserveLock(locks, 'scripts/core/damage.gd', '@alice', 'T-1', T0)
check('reserving a path you already hold just renews it', result.granted === true && result.events[0].kind === 'lease')

// ── locks: releasing ───────────────────────────────────────────────────────
result = releaseLock(locks, 'scripts/core/damage.gd', '@bob', T0 + 6 * MIN)
check('a non-holder cannot release', result.ok === false && result.code === 'not-holder')
before = frozen(locks)
result = releaseLock(locks, 'scripts/core/damage.gd', '@alice', T0 + 6 * MIN)
check('the holder can release', result.ok === true)
check('release grants the longest waiter', result.grantedTo === '@bob', String(result.grantedTo))
check('the grant lands in the same commit', result.locks['scripts/core/damage.gd'].holder === '@bob')
check('the path is never left unheld with waiters', result.locks['scripts/core/damage.gd'].queue.length === 1)
check('release emits freed then granted, in order', result.events.map((event) => event.kind).join(',') === 'freed,granted')
check('release does not mutate the locks it was given', frozen(locks) === before)
locks = result.locks
check('the shorter waiter is still queued', locks['scripts/core/damage.gd'].queue[0].who === '@carol')

result = releaseLock(locks, 'scripts/core/damage.gd', '@bob', T0 + 7 * MIN)
check('releasing with one waiter hands over to it', result.grantedTo === '@carol')
locks = result.locks
result = releaseLock(locks, 'scripts/core/damage.gd', '@carol', T0 + 8 * MIN)
check('releasing with an empty queue frees the path', result.ok === true && result.grantedTo === null && lockAt(result.locks, 'scripts/core/damage.gd') === undefined)
locks = result.locks
result = releaseLock(locks, 'scripts/core/damage.gd', '@carol', T0 + 9 * MIN)
check('releasing a free path is refused', result.ok === false && result.code === 'not-held')

// ── locks: overrides, withdrawal, exit ─────────────────────────────────────
locks = acquireLock(emptyLocks(), 'a.gd', '@alice', 'T-1', T0).locks
locks = acquireLock(locks, 'a.gd', '@bob', 'T-2', T0).locks
result = cancelReservation(locks, 'a.gd', '@bob')
check('a reservation can be withdrawn', result.ok === true && result.locks['a.gd'].queue.length === 0)
locks = result.locks
result = cancelReservation(locks, 'a.gd', '@carol')
check('withdrawing a reservation you never made is refused', result.ok === false && result.code === 'not-queued')

locks = acquireLock(locks, 'a.gd', '@carol', 'T-3', T0 + MIN).locks
result = forceReleaseLock(locks, 'a.gd', T0 + 2 * MIN, 'user')
check('the user can force a path free', result.ok === true && result.locks['a.gd'].holder === '@carol', JSON.stringify(result.grantedTo))
check('the forced release is recorded as forced', result.events[0].forced === 'user')

locks = emptyLocks()
locks = acquireLock(locks, 'one.gd', '@alice', 'T-1', T0).locks
locks = acquireLock(locks, 'two.gd', '@alice', 'T-1', T0).locks
locks = acquireLock(locks, 'one.gd', '@bob', 'T-2', T0).locks
locks = acquireLock(locks, 'three.gd', '@bob', 'T-2', T0).locks
locks = acquireLock(locks, 'three.gd', '@carol', 'T-3', T0).locks
result = releaseAllFor(locks, '@alice')
check('an exiting agent releases everything it held', result.released.join(',') === 'one.gd,two.gd', result.released.join(','))
check('its files go to the queue', result.locks['one.gd'].holder === '@bob')
check('a path with no waiters is simply freed', lockAt(result.locks, 'two.gd') === undefined)

result = releaseAllFor(locks, '@bob')
check('an exiting agent also withdraws its reservations', lockAt(result.locks, 'three.gd').holder === '@carol')
check('and does not disturb paths it only held in the queue', lockAt(result.locks, 'one.gd').holder === '@alice')

// ── locks: expiry, and liveness beating the clock ──────────────────────────
locks = acquireLock(emptyLocks(), 'x.gd', '@alice', 'T-1', T0).locks
result = expireLocks(locks, T0 + MIN, () => true)
check('a live holder keeps its lock', result.expired.length === 0 && result.locks['x.gd'].holder === '@alice')
result = expireLocks(locks, T0 + TASK_LEASE_MS + 1, () => true)
check('an expired lease is reclaimed', result.expired.length === 1 && result.expired[0].reason === 'expired', JSON.stringify(result.expired))
check('and the path is freed when nobody waits', lockAt(result.locks, 'x.gd') === undefined)
check('the expiry is an event the holder must be told about', result.events[0].kind === 'expired', JSON.stringify(result.events))

result = expireLocks(locks, T0 + MIN, (who) => who !== '@alice')
check('a dead holder is reaped before its lease expires', result.expired.length === 1 && result.expired[0].reason === 'gone', JSON.stringify(result.expired))

locks = acquireLock(locks, 'y.gd', '@alice', 'T-1', T0).locks
locks = acquireLock(locks, 'y.gd', '@bob', 'T-2', T0).locks
result = expireLocks(locks, T0 + MIN, (who) => who !== '@alice')
check('a reaped path is handed to its longest waiter', lockAt(result.locks, 'y.gd').holder === '@bob')

// ── locks: views ───────────────────────────────────────────────────────────
locks = emptyLocks()
locks = acquireLock(locks, 'held/gd', '@alice', 'T-1', T0).locks
locks = acquireLock(locks, 'wait/gd', '@bob', 'T-2', T0).locks
locks = acquireLock(locks, 'wait/gd', '@carol', 'T-3', T0).locks
locks = acquireLock(locks, 'wait/gd', '@alice', 'T-1', T0 + MIN).locks
locks = acquireLock(locks, 'free/gd', '@bob', 'T-2', T0 + 2 * MIN).locks
const view = agentView(locks, '@alice')
check('the view lists what the agent holds', view.held.join(',') === 'held/gd', view.held.join(','))
check('the view lists what it waits for', view.waiting.length === 1 && view.waiting[0].path === 'wait/gd')
check('the view names the holder it is waiting behind', view.waiting[0].holder === '@bob', String(view.waiting[0].holder))
check('the view says who is ahead in the queue', view.waiting[0].ahead.join(',') === '@carol', view.waiting[0].ahead.join(','))
check('the view gives a queue position', view.waiting[0].position === 2, String(view.waiting[0].position))
check('the view names who is writing what', view.writing.map((entry) => entry.path + ':' + entry.who).join(',') === 'free/gd:@bob,held/gd:@alice,wait/gd:@bob', JSON.stringify(view.writing))
check('the view excludes the agent from blocked paths', blockedPaths(locks, '@alice').join(',') === 'free/gd,wait/gd', blockedPaths(locks, '@alice').join(','))
check('locksOfAgent splits held from waiting', locksOfAgent(locks, '@alice').waiting.join(',') === 'wait/gd')
check('lockedPaths puts contended paths first', lockedPaths(locks)[0] === 'wait/gd', lockedPaths(locks).join(','))

// ── the invariant the panel depends on ─────────────────────────────────────
check('every status in the transition table is a known status', Object.keys(TRANSITIONS).every((status) => STATUSES.indexOf(status) >= 0))
check('every transition target is a known status', Object.values(TRANSITIONS).every((targets) => targets.every((status) => STATUSES.indexOf(status) >= 0)))
check(
  'the statuses with no possible holder cannot jump into claimed',
  TRANSITIONS.draft.indexOf('claimed') < 0 && TRANSITIONS.queued.indexOf('claimed') < 0,
)
check(
  'claimed is reachable only from statuses that already hold the task',
  Object.keys(TRANSITIONS)
    .filter((status) => TRANSITIONS[status].indexOf('claimed') >= 0)
    .every((status) => status === 'blocked'),
  Object.keys(TRANSITIONS)
    .filter((status) => TRANSITIONS[status].indexOf('claimed') >= 0)
    .join(','),
)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
