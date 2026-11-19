// T-201: the card state machine. One table, one write entry, typed refusals.
//
// The suite is in two halves:
//   1. the PURE table: every legal (event, from) is reachable, every illegal one
//      is refused with a typed code, actors/guards/closed rules hold;
//   2. the MODEL paths that used to write a status by hand (submit/review/test/
//      merge/block/retry/reopen/interrupt/drift) now go through that table.

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { emptyBoard } from '../../plugin/task-center/board.mjs'
import { STATUSES, CLOSED_STATUSES } from '../../plugin/task-center/schema.mjs'
import {
  BLOCKED_REASON_CODES,
  CARD_STATES,
  CLOSED_STATES,
  EVENTS,
  MERGE_OUTCOMES,
  PHASES,
  TRANSITIONS,
  blockedFromOf,
  blockedReasonOf,
  enterState,
  isMergeEligible,
  phaseOf,
  transition,
} from '../../plugin/task-center/state-machine.mjs'
import {
  approveReview,
  blockTask,
  cancelTask,
  claimTask,
  createTask,
  failTest,
  findTask,
  interruptDispatch,
  passTest,
  reopenTask,
  requestChanges,
  retryTask,
  submitTask,
  summary,
  unblockTask,
  updateTask,
} from '../../plugin/task-center/service.mjs'
import { mergeEligible, recordCandidate, recordMergeResult, refreshMergeRequest } from '../../plugin/task-center/merge.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + String(detail).slice(0, 800)))
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const at = (offset) => T0 + (offset === undefined ? 0 : offset)
const iso = (offset) => new Date(at(offset)).toISOString()

function makeTask(status, over) {
  const task = {
    id: 'T-1',
    title: 'card',
    kind: 'dev',
    status: status,
    dependsOn: [],
    writeFiles: [],
    history: [],
    executors: [],
    assignee: null,
    lastAssignee: null,
    leaseUntil: null,
    review: null,
    test: null,
    merge: null,
    report: null,
    attempts: 1,
    maxAttempts: 3,
    interruptions: 0,
    dispatch: null,
    blockedReason: null,
    updatedAt: iso(0),
  }
  if (status === 'running') {
    task.assignee = { name: 'w', session: 's' }
    task.leaseUntil = iso(60 * 60 * 1000)
  }
  if (status === 'reviewing') task.review = { status: 'pending', by: 'r', at: iso(0), reasons: null, attempt: 1 }
  if (status === 'testing') {
    task.review = { status: 'approved', by: 'r', at: iso(0), attempt: 1 }
    task.test = { status: 'pending', by: null, at: iso(0), evidence: null, attempt: 1 }
    task.merge = { status: 'open', base: 'base-1', target: 'main', head: 'head-1', mergeCommit: null }
  }
  if (status === 'done') {
    task.review = { status: 'approved', by: 'r', at: iso(0), attempt: 1 }
    task.test = { status: 'passed', by: 't', at: iso(0), attempt: 1, record: null }
    task.merge = { status: 'merged', base: 'base-1', target: 'main', head: 'head-1', mergeCommit: 'merge-1' }
  }
  if (status === 'blocked') {
    task.blockedReason = { code: 'manual-block', detail: 'triage', from: 'running', auto: false, at: iso(0) }
    task.waitingReason = 'manual-block'
    task.lastAssignee = { name: 'w', session: 's' }
  }
  return Object.assign(task, over === undefined ? { kind: task.kind } : over)
}

/** The context one table row needs for its declared guards. */
function contextFor(row, over) {
  const from = row.from.length === 0 ? null : row.from[0]
  let task = makeTask(from === null ? 'pending' : from)
  if (row.event === 'report') task = makeTask('running', { kind: 'investigate', report: null })
  if (row.event === 'mergeMerged') task = makeTask('testing', { test: { status: 'passed', by: 't', at: iso(0), evidence: null, attempt: 1 } })
  if (row.event === 'refreshMerge' && from === 'blocked') {
    task = makeTask('blocked', {
      blockedReason: { code: 'merge-conflict', detail: 'conflict', from: 'testing', auto: false, at: iso(0) },
      review: { status: 'approved', by: 'r', at: iso(0), attempt: 1 },
      test: { status: 'passed', by: 't', at: iso(0), evidence: null, attempt: 1, record: null },
      merge: { status: 'conflict', base: 'base-0', target: 'main', head: 'head-0', mergeCommit: null },
    })
  }
  if (row.event === 'mergeRejected') task.merge = { status: 'open', base: 'base-1', target: 'main', head: 'head-1', mergeCommit: null }
  if (row.event === 'refreshMerge' && from !== 'blocked') task.merge = { status: 'open', base: 'base-1', target: 'main', head: 'head-1', mergeCommit: null }
  if (row.event === 'unblock' && from === 'blocked') {
    task = makeTask('blocked', { blockedReason: { code: 'manual-block', detail: 'triage', from: 'running', auto: false, at: iso(0) } })
  }
  if (row.event === 'retry' && from === 'blocked') {
    task = makeTask('blocked', { blockedReason: { code: 'manual-block', detail: 'triage', from: 'running', auto: false, at: iso(0) } })
  }
  if (row.event === 'reopen' && from === 'done') task = makeTask('done')
  const restoreTo = blockedFromOf(task) === 'reviewing' ? 'reviewing' : blockedFromOf(task) === 'testing' ? 'testing' : 'pending'
  const ctx = Object.assign(
    {
      task: task,
      actor: Array.isArray(row.actor) ? row.actor[0] : undefined,
      dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
      change: { base: true, head: false, outcome: false },
      hasImplementer: true,
      restoreTo: restoreTo,
    },
    over === undefined ? {} : over,
  )
  return { ctx: ctx, task: task }
}

// ── 1. the pure table ──────────────────────────────────────────────────────
console.log('\n# the table')
check('the card states are exactly the persisted board statuses', CARD_STATES.join(',') === STATUSES.join(','), CARD_STATES.join(','))
check('the closed states are done/cancelled', CLOSED_STATES.join(',') === CLOSED_STATUSES.join(','), CLOSED_STATES.join(','))
check('the phase projection has four values', PHASES.join(',') === 'implement,review,test,merge', PHASES.join(','))
check('the merge outcomes are the four real queue results', MERGE_OUTCOMES.join(',') === 'merged,conflict,failed,rejected', MERGE_OUTCOMES.join(','))
check('the blocked reason vocabulary is declared and non-empty', BLOCKED_REASON_CODES.length >= 10 && BLOCKED_REASON_CODES.indexOf('merge-conflict') >= 0)

const ids = TRANSITIONS.map((row) => row.id)
check('every table row has a unique document id', new Set(ids).size === ids.length, ids.join(','))
check('every table row has a unique event', new Set(EVENTS).size === EVENTS.length, EVENTS.join(','))
let shapeOk = true
for (const row of TRANSITIONS) {
  if (typeof row.event !== 'string' || row.event === '') shapeOk = false
  if (typeof row.to !== 'string' && typeof row.to !== 'function') shapeOk = false
  if (Array.isArray(row.from) === false) shapeOk = false
  if (!Array.isArray(row.guards)) shapeOk = false
  if (typeof row.effects !== 'function' && !Array.isArray(row.effects)) shapeOk = false
  if (typeof row.id !== 'string' || row.id === '') shapeOk = false
}
check('every row declares id/event/from/to/guards/effects', shapeOk)
let fromOk = true
for (const row of TRANSITIONS) for (const state of row.from) if (CARD_STATES.indexOf(state) < 0) fromOk = false
check('every from value is a real card state', fromOk)
let toOk = true
for (const row of TRANSITIONS) {
  if (typeof row.to === 'function') continue
  if (CARD_STATES.indexOf(row.to) < 0) toOk = false
}
check('every static to value is a real card state', toOk)
const closedRows = TRANSITIONS.filter((row) => row.from.some((state) => CLOSED_STATES.indexOf(state) >= 0) && row.event !== 'update')
check('closed states have exactly one exit: reopen', closedRows.length === 1 && closedRows[0].event === 'reopen', closedRows.map((row) => row.event).join(','))
const blockCodes = TRANSITIONS.filter((row) => row.to === 'blocked').map((row) => row.blockedCode)
check(
  'every row that ends blocked declares a typed blockedCode',
  blockCodes.every((code) => typeof code === 'string' && BLOCKED_REASON_CODES.indexOf(code) >= 0),
  JSON.stringify(blockCodes),
)

// ── 2. every legal transition is reachable ─────────────────────────────────
console.log('\n# legal transitions')
for (const row of TRANSITIONS) {
  const built = contextFor(row)
  const fromState = row.from.length === 0 ? null : built.task.status
  const decided = transition(row.event, fromState, built.ctx)
  const label = row.id + ' ' + row.event + ' from ' + (fromState === null ? 'nothing' : fromState)
  if (decided.ok !== true) {
    check(label, false, JSON.stringify(decided))
    continue
  }
  check(label + ' -> ' + decided.to, CARD_STATES.indexOf(decided.to) >= 0, decided.to)
}
// The two-target rows: the rework/recovery targets are context-dependent.
{
  const changes = contextFor(TRANSITIONS.find((row) => row.event === 'requestChanges'))
  const noImplementer = transition('requestChanges', 'reviewing', Object.assign({}, changes.ctx, { hasImplementer: false }))
  check('T16 requestChanges without an implementer lands on pending', noImplementer.ok === true && noImplementer.to === 'pending', JSON.stringify(noImplementer))
  const failed = contextFor(TRANSITIONS.find((row) => row.event === 'failTest'))
  check('T19 failTest with an implementer lands on running', transition('failTest', 'testing', failed.ctx).to === 'running')
  check('T19 failTest without an implementer lands on pending', transition('failTest', 'testing', Object.assign({}, failed.ctx, { hasImplementer: false })).to === 'pending')
  const interrupt = contextFor(TRANSITIONS.find((row) => row.event === 'interrupt'))
  check('T03 interrupt lands on pending', transition('interrupt', 'running', interrupt.ctx).to === 'pending')
  check('T03 interrupt at the interruption limit lands on blocked', transition('interrupt', 'running', Object.assign({}, interrupt.ctx, { to: 'blocked' })).to === 'blocked')
  const lease = contextFor(TRANSITIONS.find((row) => row.event === 'leaseExpired'))
  check('T04 leaseExpired at the attempt limit lands on blocked', transition('leaseExpired', 'running', Object.assign({}, lease.ctx, { to: 'blocked' })).to === 'blocked')
  const handoff = contextFor(TRANSITIONS.find((row) => row.event === 'handoffTakeover'))
  check('T05 handoff takeover of a running card lands on pending', transition('handoffTakeover', 'running', handoff.ctx).to === 'pending')
  const reviewingHandoff = makeTask('reviewing')
  check('T05 handoff takeover of a reviewing card keeps its state', transition('handoffTakeover', 'reviewing', { task: reviewingHandoff, actor: 'user' }).to === 'reviewing')
  const blockedResume = makeTask('blocked', { blockedReason: { code: 'manual-block', detail: null, from: 'reviewing', auto: false, at: iso(0) }, review: { status: 'pending', attempt: 1 } })
  check('T06 autoResume of a review-paused card lands back on reviewing', transition('autoResume', 'blocked', { task: blockedResume, actor: 'host' }).to === 'reviewing')
}

// ── 3. illegal transitions are refused with a typed code ───────────────────
console.log('\n# illegal transitions')
const illegal = []
function refuses(label, event, from, context, code) {
  const decided = transition(event, from, context === undefined ? {} : context)
  const ok = decided.ok !== true && (code === undefined || decided.code === code)
  illegal.push({ label: label, ok: ok, decided: decided })
  check(label + (code === undefined ? '' : ' -> ' + code), ok, JSON.stringify(decided))
}
refuses('X02 pending cannot be submitted', 'submit', 'pending', { task: makeTask('pending') }, 'not-running')
refuses('X04 a running card cannot be claimed again', 'claim', 'running', { task: makeTask('running'), actor: 'scheduler' }, 'not-pending')
refuses('X05 a reviewing card cannot pass a test', 'passTest', 'reviewing', { task: makeTask('reviewing'), actor: 'tester' }, 'not-testing')
refuses('X05 a testing card cannot be approved again', 'approveReview', 'testing', { task: makeTask('testing'), actor: 'reviewer' }, 'not-reviewing')
refuses('X06 testing cannot jump straight to done', 'mergeMerged', 'testing', { task: makeTask('testing') }, undefined)
refuses('X07 merging from reviewing is not an event', 'mergeMerged', 'reviewing', { task: makeTask('reviewing') }, 'not-testing')
refuses('X08 a blocked card cannot resume as running', 'claim', 'blocked', { task: makeTask('blocked'), actor: 'scheduler' }, 'not-pending')
refuses('X09 a done card cannot refresh its merge request', 'refreshMerge', 'done', { task: makeTask('done'), change: { base: true } }, 'closed')
refuses('X09 a done card cannot be blocked', 'block', 'done', { task: makeTask('done') }, 'closed')
refuses('X10 a pending card cannot be reopened', 'reopen', 'pending', { task: makeTask('pending') }, 'not-closed')
refuses('X10 a cancelled card cannot be submitted', 'submit', 'cancelled', { task: makeTask('cancelled'), actor: 'worker' }, 'closed')
refuses('X11 a done card cannot be cancelled', 'cancel', 'done', { task: makeTask('done') }, 'done')
refuses('an unknown event is refused', 'fly', 'pending', {}, 'unknown-event')
refuses('an unknown status is refused', 'claim', 'nonsense', {}, 'unknown-status')
refuses('a dev card cannot deliver a report', 'report', 'running', { task: makeTask('running') }, 'not-an-investigation')
refuses('an investigation cannot be submitted', 'submit', 'running', { task: makeTask('running', { kind: 'investigate' }), actor: 'worker' }, 'not-a-dev-task')
refuses('a decided review round cannot be approved', 'approveReview', 'reviewing', { task: makeTask('reviewing', { review: { status: 'changes-requested', attempt: 1 } }), actor: 'reviewer' }, 'no-pending-review')
refuses('a decided test round cannot be passed again', 'passTest', 'testing', { task: makeTask('testing', { test: { status: 'passed', attempt: 1 } }), actor: 'tester' }, 'no-pending-test')
refuses('an uneligible merge cannot complete a card', 'mergeMerged', 'testing', { task: makeTask('testing', { review: { status: 'pending', attempt: 1 } }) }, 'not-eligible')
refuses('a merged record cannot hide behind testing (not open)', 'mergeConflict', 'testing', { task: makeTask('testing', { merge: { status: 'conflict' } }) }, 'no-open-merge')
refuses('a stale queue answer is not a board outcome', 'mergeFailed', 'testing', { task: makeTask('testing', { merge: { status: 'stale' } }) }, 'no-open-merge')
refuses('refresh with an unchanged request is a no-op', 'refreshMerge', 'reviewing', { task: makeTask('reviewing', { merge: { status: 'open', base: 'b', head: 'h' } }), change: { base: false, head: false, outcome: false } }, 'no-change')
refuses('unblock on a card that is not blocked', 'unblock', 'reviewing', { task: makeTask('reviewing') }, 'not-blocked')
refuses('retry of a card paused in review', 'retry', 'blocked', { task: makeTask('blocked', { blockedReason: { code: 'review-timeout', from: 'reviewing', auto: false } }), actor: 'user' }, 'not-retryable')
refuses('retry of a round-limit block is refused (reopen only)', 'retry', 'blocked', { task: makeTask('blocked', { blockedReason: { code: 'review-round-limit', from: 'reviewing', auto: false } }), actor: 'user' }, 'not-retryable')
refuses('unblock of a round-limit block is refused (reopen only)', 'unblock', 'blocked', { task: makeTask('blocked', { blockedReason: { code: 'review-round-limit', from: 'reviewing', auto: false } }), actor: 'user' }, 'not-retryable')
refuses(
  'unblock cannot resolve a merge outcome (refreshMerge only)',
  'unblock',
  'blocked',
  { task: makeTask('blocked', { blockedReason: { code: 'merge-conflict', from: 'testing', auto: false }, review: { status: 'approved', attempt: 1 }, test: { status: 'passed', attempt: 1 }, merge: { status: 'conflict' } }), actor: 'user' },
  'merge-unresolved',
)
refuses(
  'unblock refuses a paused round that no longer matches',
  'unblock',
  'blocked',
  { task: makeTask('blocked', { blockedReason: { code: 'test-timeout', from: 'testing', auto: false }, review: { status: 'approved', attempt: 1 }, test: { status: 'passed', attempt: 1 }, merge: { status: 'open' } }), actor: 'user' },
  'phase-record-mismatch',
)
check('at least 8 illegal transitions are covered', illegal.filter((row) => row.ok).length >= 8, illegal.filter((row) => row.ok).length)

// actor matrix
console.log('\n# actors')
refuses('claim is scheduler-only', 'claim', 'pending', { task: makeTask('pending'), actor: 'user' }, 'forbidden')
refuses('approveReview is not a worker event', 'approveReview', 'reviewing', { task: makeTask('reviewing'), actor: 'worker' }, 'forbidden')
refuses('mergeRejected is user-only', 'mergeRejected', 'testing', { task: makeTask('testing'), actor: 'host' }, 'forbidden')
refuses('passTest is not a reviewer event', 'passTest', 'testing', { task: makeTask('testing'), actor: 'reviewer' }, 'forbidden')
refuses('reopen is not a scheduler event', 'reopen', 'done', { task: makeTask('done'), actor: 'scheduler' }, 'forbidden')
check('the documented actor is accepted for each event', transition('claim', 'pending', { task: makeTask('pending'), actor: 'scheduler' }).ok === true && transition('approveReview', 'reviewing', { task: makeTask('reviewing'), actor: 'reviewer' }).ok === true && transition('passTest', 'testing', { task: makeTask('testing'), actor: 'tester' }).ok === true)

// ── 4. enterState is the only writer and applies the declared effects ──────
console.log('\n# the single write entry')
{
  const task = makeTask('running')
  const decided = enterState(task, 'submit', { task: task, actor: 'worker' }, at(10))
  check('enterState writes the status and clears the lease', decided.ok === true && task.status === 'reviewing' && task.leaseUntil === null, JSON.stringify({ decided: decided, lease: task.leaseUntil }))
  const refused = enterState(task, 'claim', { task: task, actor: 'scheduler' }, at(11))
  check('a refused enterState leaves the status untouched', refused.ok !== true && task.status === 'reviewing', JSON.stringify(refused))
}
{
  const task = makeTask('running')
  task.lastAssignee = { name: 'old', session: 's' }
  enterState(task, 'interrupt', { task: task, actor: 'scheduler', to: 'pending' }, at(10))
  check('interrupt refunds the attempt and clears the claim', task.status === 'pending' && task.attempts === 0 && task.interruptions === 1 && task.assignee === null && task.leaseUntil === null, JSON.stringify({ attempts: task.attempts, interruptions: task.interruptions }))
  check('interrupt keeps the worker as the last owner', task.lastAssignee !== null && task.lastAssignee.name === 'w')
}
{
  const task = makeTask('testing', { test: { status: 'passed', by: 't', at: iso(0), evidence: null, attempt: 1 }, merge: { status: 'open', base: 'b', head: 'h' } })
  enterState(task, 'mergeConflict', { task: task, actor: 'host', blockedDetail: 'a.gd conflicts' }, at(10))
  const reason = blockedReasonOf(task)
  check('a merge conflict becomes a typed blocked reason, not a testing card', task.status === 'blocked' && reason !== null && reason.code === 'merge-conflict' && reason.from === 'testing' && reason.auto === false, JSON.stringify(reason))
  check('the blocked reason survives as the persisted waiting pair too', task.waitingReason === 'merge-conflict' && task.waitingDetail === 'a.gd conflicts', JSON.stringify({ waitingReason: task.waitingReason, waitingDetail: task.waitingDetail }))
}
{
  const task = makeTask('blocked', { blockedReason: { code: 'manual-block', from: 'running', auto: false } })
  enterState(task, 'unblock', { task: task, actor: 'user', restoreTo: 'pending' }, at(10))
  check('leaving blocked clears the typed reason', task.status === 'pending' && task.blockedReason === null && task.waitingReason === null, JSON.stringify(task.blockedReason))
}

// ── 5. model paths: merge outcomes ────────────────────────────────────────
console.log('\n# merge outcomes')
function flowBoard() {
  const made = createTask(emptyBoard(T0), { title: 'flow', verification: { probes: [{ id: 'p', command: 'npm test' }] } }, T0, '@me')
  let board = made.board
  board = claimTask(board, 'T-1', { name: 'w', session: 's' }, at(1)).board
  board = submitTask(board, 'T-1', { evidence: 'e', merge: { status: 'open', base: 'base-1', target: 'main', head: 'head-1' } }, at(2), 'w').board
  board = approveReview(board, 'T-1', at(3), 'reviewer').board
  board = passTest(board, 'T-1', at(4), 'tester').board
  return board
}
{
  const board = flowBoard()
  const task = findTask(board, 'T-1')
  check('a passed test projects the merge phase while the card is still testing', phaseOf(task) === 'merge' && task.status === 'testing', phaseOf(task))
  check('the merge gate follows the table eligibility', mergeEligible(task) === true && isMergeEligible(task) === true)
  const merged = recordMergeResult(board, 'T-1', { status: 'merged', mergeCommit: 'merge-sha' }, at(5), 'system')
  check('T21 merged moves testing -> done', merged.ok === true && findTask(merged.board, 'T-1').status === 'done' && findTask(merged.board, 'T-1').merge.status === 'merged', JSON.stringify(merged.ok === true ? findTask(merged.board, 'T-1').status : merged))
  check('a done card has no blocked reason', blockedReasonOf(findTask(merged.board, 'T-1')) === null)
}
for (const outcome of ['conflict', 'failed']) {
  const board = flowBoard()
  const recorded = recordMergeResult(board, 'T-1', { status: outcome, conflict: 'a.gd', output: 'boom' }, at(5), 'system')
  const task = recorded.ok === true ? findTask(recorded.board, 'T-1') : null
  const reason = task === null ? null : blockedReasonOf(task)
  check(
    'T22/T23 ' + outcome + ' moves testing -> blocked with merge-' + outcome,
    recorded.ok === true && task.status === 'blocked' && reason !== null && reason.code === 'merge-' + outcome && reason.from === 'testing',
    JSON.stringify(recorded.ok === true ? { status: task.status, reason: reason } : recorded),
  )
}
{
  const made = createTask(emptyBoard(T0), { title: 'rej', verification: { probes: [{ id: 'p', command: 'npm test' }] } }, T0, '@me')
  let board = claimTask(made.board, 'T-1', { name: 'w', session: 's' }, at(1)).board
  board = submitTask(board, 'T-1', { merge: { status: 'open', base: 'b', target: 'main', head: 'h' } }, at(2), 'w').board
  const rejected = recordMergeResult(board, 'T-1', { status: 'rejected' }, at(3), '@user', null, 'user')
  const task = rejected.ok === true ? findTask(rejected.board, 'T-1') : null
  const reason = task === null ? null : blockedReasonOf(task)
  check('T24 rejected moves reviewing -> blocked with merge-rejected', rejected.ok === true && task.status === 'blocked' && reason !== null && reason.code === 'merge-rejected' && reason.from === 'reviewing', JSON.stringify(rejected.ok === true ? { status: task.status, reason: reason } : rejected))
  check('the rejected merge record keeps its outcome', task.merge.status === 'rejected', JSON.stringify(task.merge))
}
{
  const board = flowBoard()
  const stale = recordMergeResult(board, 'T-1', { status: 'stale' }, at(5), 'system')
  check('a stale queue answer is refused instead of landing on the board', stale.ok !== true && stale.code === 'invalid-merge-outcome', JSON.stringify(stale))
  const made = createTask(emptyBoard(T0), { title: 'pending test', verification: { probes: [{ id: 'p', command: 'npm test' }] } }, T0, '@me')
  let pendingTest = claimTask(made.board, 'T-1', { name: 'w', session: 's' }, at(1)).board
  pendingTest = submitTask(pendingTest, 'T-1', { merge: { status: 'open', base: 'b', target: 'main', head: 'h' } }, at(2), 'w').board
  pendingTest = approveReview(pendingTest, 'T-1', at(3), 'reviewer').board
  const notEligible = recordMergeResult(pendingTest, 'T-1', { status: 'merged' }, at(4), 'system')
  check(
    'a merged outcome still needs the table guards (test not passed)',
    notEligible.ok !== true && notEligible.code === 'not-eligible' && findTask(pendingTest, 'T-1').status === 'testing',
    JSON.stringify(notEligible),
  )
}

// ── 6. target drift ───────────────────────────────────────────────────────
console.log('\n# target drift')
{
  const board = flowBoard()
  const candidate = recordCandidate(board, 'T-1', { base: 'base-2', head: 'head-2' }, at(5), { by: 'reviewer' })
  check('T25 a rebuilt candidate records the drift on the same testing card', candidate.ok === true && findTask(candidate.board, 'T-1').status === 'testing' && findTask(candidate.board, 'T-1').merge.base === 'base-2', JSON.stringify(candidate.ok === true ? findTask(candidate.board, 'T-1').merge : candidate))
  const retest = recordCandidate(candidate.board, 'T-1', { base: 'base-3', head: 'head-3' }, at(6), { by: 'reviewer', retest: true })
  const task = retest.ok === true ? findTask(retest.board, 'T-1') : null
  check(
    'T25 target drift retest resets the test round instead of inventing a status',
    retest.ok === true && task.status === 'testing' && task.test.status === 'pending' && task.test.attempt === 2 && phaseOf(task) === 'test',
    JSON.stringify(retest.ok === true ? { status: task.status, test: task.test } : retest),
  )
}
{
  const made = createTask(emptyBoard(T0), { title: 'drift', verification: { probes: [{ id: 'p', command: 'npm test' }] } }, T0, '@me')
  let board = claimTask(made.board, 'T-1', { name: 'w', session: 's' }, at(1)).board
  board = submitTask(board, 'T-1', { merge: { status: 'open', base: 'base-1', target: 'main', head: 'head-1' } }, at(2), 'w').board
  const same = refreshMergeRequest(board, 'T-1', 'base-1', 'head-1', [], at(3), 'w')
  check('T27 an unchanged refresh is a no-change and spends no review round', same.ok !== true && same.code === 'no-change' && findTask(board, 'T-1').review.attempt === 1, JSON.stringify(same))
  const moved = refreshMergeRequest(board, 'T-1', 'base-2', 'head-2', [], at(4), 'w')
  const task = moved.ok === true ? findTask(moved.board, 'T-1') : null
  check(
    'T27 a changed head reopens the review round and clears the test record',
    moved.ok === true && task.status === 'reviewing' && task.review.attempt === 2 && task.test === null && task.merge.status === 'open' && task.merge.head === 'head-2',
    JSON.stringify(moved.ok === true ? { status: task.status, review: task.review, test: task.test } : moved),
  )
  const closedBoard = JSON.parse(JSON.stringify(moved.board))
  const closedTask = findTask(closedBoard, 'T-1')
  closedTask.status = 'done'
  closedTask.merge = { status: 'merged', mergeCommit: 'mc' }
  const before = JSON.stringify(findTask(closedBoard, 'T-1').merge)
  const closed = refreshMergeRequest(closedBoard, 'T-1', 'base-9', 'head-9', [], at(5), '@user')
  check('T27 refresh refuses a closed card and leaves its merge record alone', closed.ok !== true && closed.code === 'closed' && JSON.stringify(findTask(closedBoard, 'T-1').merge) === before, JSON.stringify(closed))
}

// ── 7. timeout block ──────────────────────────────────────────────────────
console.log('\n# timeout block')
{
  let board = createTask(emptyBoard(T0), { title: 'timeout', verification: { probes: [{ id: 'p', command: 'npm test' }] } }, T0, '@me').board
  board = claimTask(board, 'T-1', { name: 'w', session: 's' }, at(1)).board
  board = submitTask(board, 'T-1', { merge: { status: 'open', base: 'b', target: 'main', head: 'h' } }, at(2), 'w').board
  const blocked = blockTask(board, 'T-1', at(3), 'system', 'review went silent', null, { reason: { code: 'review-timeout' }, actor: 'host' })
  const task = blocked.ok === true ? findTask(blocked.board, 'T-1') : null
  const reason = task === null ? null : blockedReasonOf(task)
  check('T17 a review timeout blocks the card with review-timeout', blocked.ok === true && task.status === 'blocked' && reason !== null && reason.code === 'review-timeout' && reason.from === 'reviewing', JSON.stringify(blocked.ok === true ? reason : blocked))
  const retry = retryTask(blocked.board, 'T-1', at(4), '@me')
  check('a review-timeout block is not retryable (same round resumes by unblock/reopen)', retry.ok !== true && retry.code === 'not-retryable', JSON.stringify(retry))
  const unblock = unblockTask(blocked.board, 'T-1', at(4), '@me')
  check('T28 unblock resumes the paused review round', unblock.ok === true && findTask(unblock.board, 'T-1').status === 'reviewing' && findTask(unblock.board, 'T-1').blockedReason === null, JSON.stringify(unblock.ok === true ? findTask(unblock.board, 'T-1').status : unblock))
}
{
  let board = createTask(emptyBoard(T0), { title: 'test timeout', verification: { probes: [{ id: 'p', command: 'npm test' }] } }, T0, '@me').board
  board = claimTask(board, 'T-1', { name: 'w', session: 's' }, at(1)).board
  board = submitTask(board, 'T-1', { merge: { status: 'open', base: 'b', target: 'main', head: 'h' } }, at(2), 'w').board
  board = approveReview(board, 'T-1', at(3), 'reviewer').board
  const blocked = blockTask(board, 'T-1', at(4), 'system', 'tester went silent', null, { reason: { code: 'test-timeout' } })
  const task = blocked.ok === true ? findTask(blocked.board, 'T-1') : null
  check('T20 a test timeout blocks with test-timeout from testing', blocked.ok === true && task.status === 'blocked' && blockedReasonOf(task).code === 'test-timeout' && blockedReasonOf(task).from === 'testing', JSON.stringify(blocked.ok === true ? blockedReasonOf(task) : blocked))
}

// ── 8. reopen vs retry ────────────────────────────────────────────────────
console.log('\n# reopen vs retry')
{
  const blockedTask = makeTask('blocked', {
    blockedReason: { code: 'manual-block', detail: 'triage', from: 'running', auto: false, at: iso(0) },
    review: { status: 'changes-requested', attempt: 2, at: iso(0) },
    test: { status: 'failed', attempt: 1, at: iso(0) },
    merge: { status: 'open', base: 'b', head: 'h' },
    attempts: 2,
    interruptions: 1,
    executors: [{ name: 'w', session: 's', at: iso(0), retiredAt: iso(1), retiredReason: 'block' }],
    dispatch: { status: 'exhausted' },
    branch: 'task/T-1-2',
    worktree: '/wt',
  })
  const board = { version: 2, seq: 2, tasks: [blockedTask] }
  const retried = retryTask(board, 'T-1', at(10), '@me')
  const retryTaskRow = retried.ok === true ? findTask(retried.board, 'T-1') : null
  check(
    'T29 retry returns to pending, resets attempts, and KEEPS the round records',
    retried.ok === true && retryTaskRow.status === 'pending' && retryTaskRow.attempts === 0 && retryTaskRow.review.attempt === 2 && retryTaskRow.test.attempt === 1 && retryTaskRow.merge === null && retryTaskRow.blockedReason === null,
    JSON.stringify(retried.ok === true ? { status: retryTaskRow.status, review: retryTaskRow.review, test: retryTaskRow.test, merge: retryTaskRow.merge } : retried),
  )
  const reopened = reopenTask(board, 'T-1', at(10), '@me')
  const reopenTaskRow = reopened.ok === true ? findTask(reopened.board, 'T-1') : null
  check(
    'T30 reopen starts a new generation and CLEARS every phase record',
    reopened.ok === true && reopenTaskRow.status === 'pending' && reopenTaskRow.review === null && reopenTaskRow.test === null && reopenTaskRow.merge === null && reopenTaskRow.attempts === 0 && reopenTaskRow.executors.length === 0,
    JSON.stringify(reopened.ok === true ? { status: reopenTaskRow.status, review: reopenTaskRow.review, test: reopenTaskRow.test, merge: reopenTaskRow.merge } : reopened),
  )
}
{
  const done = makeTask('done', { branch: 'task/T-1-1', worktree: '/wt1', commit: 'c1', base: 'b1' })
  const board = { version: 2, seq: 2, tasks: [done] }
  const reopened = reopenTask(board, 'T-1', at(10), '@me')
  const task = findTask(reopened.board, 'T-1')
  check('reopening a merged card drops its git identity with the merge', task.merge === null && task.branch === null && task.worktree === null && task.commit === null && task.base === null, JSON.stringify({ branch: task.branch, worktree: task.worktree, commit: task.commit }))
}

// ── 9. interrupt / lease expiry ───────────────────────────────────────────
console.log('\n# interrupt')
{
  let board = createTask(emptyBoard(T0), { title: 'intr', verification: { probes: [{ id: 'p', command: 'npm test' }] } }, T0, '@me').board
  board = claimTask(board, 'T-1', { name: 'w', session: 's' }, at(1)).board
  const first = interruptDispatch(board, 'T-1', 'host restart', at(2))
  const task = findTask(first.board, 'T-1')
  check('T03 an infrastructure interrupt refunds the attempt', first.ok === true && task.status === 'pending' && task.attempts === 0 && task.interruptions === 1 && task.assignee === null && task.leaseUntil === null, JSON.stringify(first.ok === true ? { status: task.status, attempts: task.attempts, interruptions: task.interruptions } : first))
  let loop = first.board
  for (let index = 0; index < 4; index += 1) {
    loop = claimTask(loop, 'T-1', { name: 'w', session: 's' }, at(10 + index * 2)).board
    loop = interruptDispatch(loop, 'T-1', 'host restart', at(11 + index * 2)).board
  }
  const exhausted = findTask(loop, 'T-1')
  const reason = blockedReasonOf(exhausted)
  check('T03 five interruptions without a submission block the card', exhausted.status === 'blocked' && reason !== null && reason.code === 'interruptions-exhausted' && reason.from === 'running', JSON.stringify({ status: exhausted.status, reason: reason, interruptions: exhausted.interruptions }))
}

// ── 10. views: state + phase ──────────────────────────────────────────────
console.log('\n# views')
{
  const board = flowBoard()
  const task = findTask(board, 'T-1')
  const view = summary(board, task, at(5))
  check('summary exposes state and phase without changing status', view.state === 'testing' && view.status === 'testing' && view.phase === 'merge', JSON.stringify({ state: view.state, phase: view.phase }))
  check('summary exposes no blockedReason on a live card', view.blockedReason === null)
  const blocked = blockTask(board, 'T-1', at(6), 'system', 'manual', null, { reason: { code: 'manual-block' } })
  const blockedView = summary(blocked.board, findTask(blocked.board, 'T-1'), at(7))
  check('summary exposes the typed blocked reason on a blocked card', blockedView.state === 'blocked' && blockedView.phase === null && blockedView.blockedReason.code === 'manual-block' && blockedView.blockedReason.from === 'testing', JSON.stringify(blockedView.blockedReason))
}

// ── 11. one status writer in the production code ──────────────────────────
console.log('\n# single writer')
{
  const directory = fileURLToPath(new URL('../../plugin/task-center/', import.meta.url))
  const files = ['service.mjs', 'merge.mjs', 'api.mjs', 'handoff.mjs', 'dispatch.mjs']
  for (const name of readdirSync(directory + 'actions')) if (name.endsWith('.mjs')) files.push('actions/' + name)
  const assignment = /\.status = '(pending|running|reviewing|testing|done|blocked|cancelled)'/
  const offenders = []
  for (const name of files) {
    const text = readFileSync(directory + name, 'utf8')
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) if (assignment.test(lines[index])) offenders.push(name + ':' + String(index + 1) + ' ' + lines[index].trim())
  }
  check('no module outside the state machine assigns a card status', offenders.length === 0, offenders.join(' | '))
  const machine = readFileSync(directory + 'state-machine.mjs', 'utf8')
  const writes = machine.split('\n').filter((line) => /^  task\.status = decided\.to$/.test(line))
  check('the state machine has exactly one status assignment', writes.length === 1, String(writes.length))
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
