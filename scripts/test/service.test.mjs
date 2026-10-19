// Model tests: dependency graph, readiness, transitions, leases and dispatch
// settings. No filesystem and no Cordis — service.mjs is pure.

import { emptyBoard } from '../../plugin/task-center/board.mjs'
import { TASK_HEARTBEAT_MS, TASK_LEASE_EXTENSION_MAX_MS, TASK_LEASE_MS, TASK_LEASE_REMINDER_MS } from '../../plugin/task-center/schema.mjs'
import { mergeEligible, recordMergeResult } from '../../plugin/task-center/merge.mjs'
import {
  approveReview,
  blockTask,
  cancelTask,
  claimTask,
  clearDispatchRequest,
  approveDispatch,
  requestDispatch,
  counts,
  createTask,
  dependencyInfo,
  deleteTask,
  detail,
  expireLeases,
  failTest,
  findTask,
  passTest,
  requestChanges,
  readyTasks,
  renewLeases,
  renewRunningLeases,
  attemptStartedAt,
  extendLease,
  reopenTask,
  retryTask,
  setDispatch,
  submitTask,
  summary as taskSummary,
  unblockTask,
  updateTask,
} from '../../plugin/task-center/service.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}
const T0 = Date.parse('2026-01-01T00:00:00.000Z')
const at = (offset) => T0 + (offset === undefined ? 0 : offset)
const base = () => emptyBoard(T0)
const make = (board, title, input) => createTask(board, Object.assign({ title }, input), T0, '@me')
const finish = (board, id, offset) => {
  const start = offset === undefined ? 10 : offset
  const claimed = claimTask(board, id, { name: 'worker' }, at(start))
  if (claimed.ok !== true) throw new Error('claim failed: ' + JSON.stringify(claimed))
  const submitted = submitTask(
    claimed.board,
    id,
    {
      evidence: 'done',
      merge: { status: 'open', base: 'base-sha', target: 'main', head: 'head-sha', declaredFiles: [], actualFiles: [] },
    },
    at(start + 1),
    'worker',
  )
  if (submitted.ok !== true) throw new Error('submit failed: ' + JSON.stringify(submitted))
  const approved = approveReview(submitted.board, id, at(start + 2), 'reviewer')
  if (approved.ok !== true) throw new Error('review failed: ' + JSON.stringify(approved))
  const tested = passTest(approved.board, id, at(start + 3), 'tester')
  if (tested.ok !== true) throw new Error('test failed: ' + JSON.stringify(tested))
  const merged = recordMergeResult(tested.board, id, { status: 'merged', mergeCommit: 'merge-sha' }, at(start + 4), 'merger')
  if (merged.ok !== true) throw new Error('merge failed: ' + JSON.stringify(merged))
  return merged.board
}
const ids = (board) => board.tasks.map((task) => task.id).join(',')

// create
{
  let board = base()
  check('a task needs a title', make(board, '   ').code === 'missing-title')
  const created = make(board, 'A')
  check('creating allocates T-1', created.ok === true && created.task.id === 'T-1', JSON.stringify(created))
  check('a new task is pending', created.task.status === 'pending')
  check(
    'a new task defaults the worktree/MR fields',
    created.task.base === null &&
      created.task.target === null &&
      created.task.branch === null &&
      created.task.worktree === null &&
      created.task.commit === null &&
      created.task.requiredRole === null &&
      created.task.merge === null &&
      Array.isArray(created.task.actualFiles) &&
      created.task.actualFiles.length === 0,
    JSON.stringify(created.task),
  )
  check('creation is recorded', created.task.history[0].to === 'pending' && created.task.history[0].by === '@me')
  board = created.board
  const second = make(board, 'B')
  check('the next id is T-2', second.task.id === 'T-2')
}

// dependency validation
{
  let board = make(base(), 'A').board
  const unknown = make(board, 'B', { dependsOn: ['T-99'] })
  check('an unknown dependency is refused', unknown.code === 'unknown-dependency', JSON.stringify(unknown))
  const self = updateTask(board, 'T-1', { dependsOn: ['T-1'] }, T0, '@me')
  check('a self dependency is refused', self.code === 'self-dependency')
  board = make(board, 'B', { dependsOn: ['T-1'] }).board
  const cycle = updateTask(board, 'T-1', { dependsOn: ['T-2'] }, T0, '@me')
  check('a cycle is refused', cycle.code === 'dependency-cycle', JSON.stringify(cycle))
  const cancelled = cancelTask(board, 'T-1', T0, '@me').board
  const viaCancelled = make(cancelled, 'C', { dependsOn: ['T-1'] })
  check('a cancelled dependency is refused at write time', viaCancelled.code === 'cancelled-dependency', JSON.stringify(viaCancelled))
}

// update rules
{
  let board = make(base(), 'A').board
  board = make(board, 'B').board
  const updated = updateTask(board, 'T-1', { title: 'A2', spec: 's', priority: 3, dependsOn: [] }, T0, '@me')
  check('update changes fields', updated.ok === true && updated.task.title === 'A2' && updated.task.priority === 3)
  check('update records a history entry', updated.task.history[updated.task.history.length - 1].note.indexOf('dependencies') >= 0)
  const claimed = claimTask(updated.board, 'T-1', { name: 'w' }, T0)
  const structural = updateTask(claimed.board, 'T-1', { dependsOn: [] }, T0, '@me')
  check('structural changes are frozen while running', structural.code === 'running-structural', JSON.stringify(structural))
  const content = updateTask(claimed.board, 'T-1', { title: 'A3' }, T0, '@me')
  check('content changes are allowed while running', content.ok === true)
  const files = updateTask(claimed.board, 'T-1', { writeFiles: ['scripts/live.gd'] }, T0, '@me')
  check('a running task may still change writeFiles', files.ok === true && files.task.writeFiles.join(',') === 'scripts/live.gd', JSON.stringify(files))
  check('the writeFiles change is recorded', files.task.history[files.task.history.length - 1].note.indexOf('files') >= 0)
}

// delete
{
  let board = make(base(), 'A').board
  board = make(board, 'B', { dependsOn: ['T-1'] }).board
  const refused = deleteTask(board, 'T-1', T0, '@me')
  check('a referenced task is not deleted', refused.code === 'referenced', JSON.stringify(refused))
  const forced = deleteTask(board, 'T-1', T0, '@me', { force: true })
  check('forcing detaches dependents', forced.ok === true && findTask(forced.board, 'T-2').dependsOn.length === 0)
  check('the dependency is gone', findTask(forced.board, 'T-1') === undefined)
}

// dependency state and readiness
{
  let board = make(base(), 'A').board
  board = make(board, 'B', { dependsOn: ['T-1'] }).board
  check('B waits on A', dependencyInfo(board, findTask(board, 'T-2')).state === 'waiting')
  check('only A is ready', readyTasks(board).map((task) => task.id).join(',') === 'T-1')
  board = finish(board, 'T-1')
  check('B becomes ready when A is done', dependencyInfo(board, findTask(board, 'T-2')).state === 'ready')
  const broken = cancelTask(board, 'T-1', T0, '@me')
  check('cancelling a done task is refused', broken.code === 'done', JSON.stringify(broken))
  let missing = board
  missing = { ...missing, tasks: missing.tasks.filter((task) => task.id !== 'T-1') }
  const info = dependencyInfo(missing, findTask(missing, 'T-2'))
  check('a missing dependency is broken, not ready', info.state === 'broken' && info.brokenOn.join(',') === 'T-1', JSON.stringify(info))
}

// a done dependency only counts when its merge request is merged
{
  const doneWith = (status) => {
    let board = make(base(), 'A').board
    board = make(board, 'B', { dependsOn: ['T-1'] }).board
    board = finish(board, 'T-1')
    const dependency = findTask(board, 'T-1')
    dependency.merge =
      status === null
        ? null
        : {
            status: status,
            base: 'base-sha',
            target: 'main',
            head: 'head-sha',
            declaredFiles: [],
            actualFiles: [],
            tests: null,
            reviewer: null,
            conflict: null,
            output: null,
            at: null,
          }
    return board
  }
  for (const status of ['open', 'conflict', 'failed', 'rejected']) {
    const board = doneWith(status)
    const info = dependencyInfo(board, findTask(board, 'T-2'))
    check(
      'a done dependency with a ' + status + ' merge request keeps its dependent waiting',
      info.state === 'waiting' && info.waitingOn.join(',') === 'T-1' && info.brokenOn.length === 0,
      JSON.stringify(info),
    )
    check('and is not ready to dispatch (' + status + ')', readyTasks(board).every((task) => task.id !== 'T-2'), JSON.stringify(readyTasks(board).map((task) => task.id)))
    const refused = claimTask(board, 'T-2', { name: 'w' }, T0 + 100)
    check('and cannot be claimed (' + status + ')', refused.code === 'dependency-unmet', JSON.stringify(refused))
  }
  const merged = doneWith('merged')
  const info = dependencyInfo(merged, findTask(merged, 'T-2'))
  check('a merged dependency releases its dependent', info.state === 'ready' && info.waitingOn.length === 0, JSON.stringify(info))
  check('and the dependent is ready to dispatch', readyTasks(merged).map((task) => task.id).join(',') === 'T-2', JSON.stringify(readyTasks(merged).map((task) => task.id)))
  const legacy = doneWith(null)
  check('a legacy done dependency with no merge record is still ready', dependencyInfo(legacy, findTask(legacy, 'T-2')).state === 'ready')
}

// readiness order
{
  let board = base()
  board = make(board, 'A', { priority: 0 }).board
  board = make(board, 'B', { priority: 5 }).board
  board = make(board, 'C', { priority: 5 }).board
  check('ready order is priority then creation', readyTasks(board).map((task) => task.id).join(',') === 'T-2,T-3,T-1', readyTasks(board).map((task) => task.id).join(','))
}

// claim and dependencies
{
  let board = make(base(), 'A').board
  board = make(board, 'B', { dependsOn: ['T-1'] }).board
  const unmet = claimTask(board, 'T-2', { name: 'w' }, T0)
  check('a waiting task is not claimable', unmet.code === 'dependency-unmet', JSON.stringify(unmet))
  board = finish(board, 'T-1')
  const claimed = claimTask(board, 'T-2', { name: 'w', session: 's-w' }, T0 + 100)
  check('a ready task is claimable', claimed.ok === true && claimed.task.status === 'running')
  check('claiming increments attempts', claimed.task.attempts === 1)
  check('claiming starts a lease', Date.parse(claimed.task.leaseUntil) === T0 + 100 + TASK_LEASE_MS)
  const twice = claimTask(claimed.board, 'T-2', { name: 'other' }, T0 + 101)
  check('a running task cannot be claimed again', twice.code === 'not-pending', JSON.stringify(twice))
}

// lease expiry and the attempt budget
{
  let board = make(base(), 'A').board
  board = claimTask(board, 'T-1', { name: 'w' }, T0).board
  let reaped = expireLeases(board, T0 + TASK_LEASE_MS + 1, 3)
  check('an expired claim returns to pending', reaped.ok === true && findTask(reaped.board, 'T-1').status === 'pending')
  check('the expiry is recorded', findTask(reaped.board, 'T-1').dispatch.status === 'lease-expired')
  board = claimTask(reaped.board, 'T-1', { name: 'w' }, T0 + TASK_LEASE_MS + 2).board
  board = expireLeases(board, T0 + 2 * TASK_LEASE_MS + 5, 3).board
  board = claimTask(board, 'T-1', { name: 'w' }, T0 + 2 * TASK_LEASE_MS + 6).board
  const final = expireLeases(board, T0 + 3 * TASK_LEASE_MS + 10, 3)
  check('a task at the attempt budget blocks', findTask(final.board, 'T-1').status === 'blocked', findTask(final.board, 'T-1').status)
  check('and says why', findTask(final.board, 'T-1').dispatch.error === 'lease expired')
}

// ── lease mitigation: 60 minutes, activity renews, fixed host heartbeat ────
{
  check('the task lease is 60 minutes', TASK_LEASE_MS === 60 * 60 * 1000, String(TASK_LEASE_MS))
  check('the host heartbeat window is a fixed interval, not half the lease', TASK_HEARTBEAT_MS > 0 && TASK_HEARTBEAT_MS * 2 <= TASK_LEASE_MS, String(TASK_HEARTBEAT_MS))
  let board = make(base(), 'A').board
  board = claimTask(board, 'T-1', { name: 'w', session: 's-w' }, T0).board
  check('claiming starts the 60 minute lease', Date.parse(findTask(board, 'T-1').leaseUntil) === T0 + TASK_LEASE_MS)
  // The old 15 minute lease is gone: an idle lease survives well past it...
  const pastOldLease = T0 + 16 * 60 * 1000
  const atSixteen = expireLeases(board, pastOldLease, 3)
  check('a lease is not expired sixteen minutes in (the old 15 minute bound is gone)', atSixteen.events.length === 0 && findTask(atSixteen.board, 'T-1').status === 'running', JSON.stringify(atSixteen.events))
  check('the task is still running sixteen minutes in', findTask(board, 'T-1').status === 'running')
  // ...and only a full 60 idle minutes return it to the pool.
  check('a lease is not expired one millisecond before the 60 minutes', expireLeases(board, T0 + TASK_LEASE_MS - 1, 3).events.length === 0)
  const lapsed = expireLeases(board, T0 + TASK_LEASE_MS + 1, 3)
  check('sixty idle minutes expire the lease', lapsed.events.length === 1 && findTask(lapsed.board, 'T-1').status === 'pending', JSON.stringify(lapsed.events))
}

{
  let board = make(base(), 'A').board
  board = claimTask(board, 'T-1', { name: 'w', session: 's-w' }, T0).board
  const leaseEnd = T0 + TASK_LEASE_MS
  // Not due yet: the host heartbeat must not write on every tick.
  const early = renewRunningLeases(board, leaseEnd - TASK_HEARTBEAT_MS - 1, {})
  check('the host heartbeat leaves a lease that is not due alone', early.ok === true && early.renewed.length === 0 && Date.parse(findTask(early.board, 'T-1').leaseUntil) === leaseEnd, JSON.stringify(early.renewed))
  // Inside the fixed window: extended by the full lease, independent of any half-way point.
  const due = renewRunningLeases(board, leaseEnd - TASK_HEARTBEAT_MS + 1, {})
  check(
    'the host heartbeat extends a due lease by the full 60 minutes',
    due.ok === true && due.renewed.join(',') === 'T-1' && Date.parse(findTask(due.board, 'T-1').leaseUntil) === leaseEnd - TASK_HEARTBEAT_MS + 1 + TASK_LEASE_MS,
    JSON.stringify(due.renewed),
  )
  // A lapsed lease is never revived: that is the reap's job.
  const afterLapse = renewRunningLeases(board, leaseEnd + 1, {})
  check('the host heartbeat never revives a lapsed lease', afterLapse.ok === true && afterLapse.renewed.length === 0 && Date.parse(findTask(afterLapse.board, 'T-1').leaseUntil) === leaseEnd, JSON.stringify(afterLapse.renewed))
  check('and the lapsed task is still expired', findTask(board, 'T-1').status === 'running' && Date.parse(findTask(board, 'T-1').leaseUntil) <= leaseEnd + 1)
  // Scope: only running tasks with a known assignee.
  const reviewing = submitTask(board, 'T-1', { evidence: 'done' }, T0 + 1, 'w').board
  check('a task outside running is not heartbeated', renewRunningLeases(reviewing, leaseEnd - 1, {}).renewed.length === 0)
  const orphan = JSON.parse(JSON.stringify(board))
  orphan.tasks[0].assignee = null
  check('a running task without an assignee is not heartbeated', renewRunningLeases(orphan, leaseEnd - 1, {}).renewed.length === 0)
  // A shorter window is honoured (configurable, for tests and future tuning).
  const narrow = renewRunningLeases(board, leaseEnd - 1000, { windowMs: 500 })
  check('the heartbeat window is configurable', narrow.renewed.length === 0 && renewRunningLeases(board, leaseEnd - 1000, { windowMs: 5000 }).renewed.length === 1)
}

// submit enters the review phase: submission is not completion
{
  let board = make(base(), 'A').board
  const early = submitTask(board, 'T-1', {}, T0, 'w')
  check('a pending task cannot be submitted', early.code === 'not-running')
  board = claimTask(board, 'T-1', { name: 'w' }, T0).board
  const submitted = submitTask(
    board,
    'T-1',
    { evidence: 'tests pass', merge: { status: 'open', base: 'base-sha', target: 'main', head: 'head-sha', declaredFiles: [], actualFiles: [] } },
    T0 + 1,
    'w',
  )
  check('submit moves the task to reviewing', submitted.ok === true && submitted.task.status === 'reviewing', JSON.stringify(submitted))
  check('evidence is stored', submitted.task.evidence === 'tests pass')
  check(
    'the first review round is pending',
    submitted.task.review !== null &&
      submitted.task.review.status === 'pending' &&
      submitted.task.review.attempt === 1 &&
      submitted.task.review.by === 'w',
    JSON.stringify(submitted.task.review),
  )
  check('submit clears the lease', submitted.task.leaseUntil === null)
  check(
    'a worktree submit records the open request',
    submitted.task.merge !== null && submitted.task.merge.status === 'open',
    JSON.stringify(submitted.task.merge),
  )

  const reviewingCounts = counts(submitted.board)
  check('counts include the reviewing column', reviewingCounts.reviewing === 1 && reviewingCounts.running === 0, JSON.stringify(reviewingCounts))
  const approved = approveReview(submitted.board, 'T-1', T0 + 2, 'reviewer')
  check('approving the review moves to testing', approved.ok === true && approved.task.status === 'testing', JSON.stringify(approved))
  check('the review records the approval', approved.task.review.status === 'approved' && approved.task.review.by === 'reviewer')
  check(
    'the approval opens the first test round',
    approved.task.test !== null && approved.task.test.status === 'pending' && approved.task.test.attempt === 1,
    JSON.stringify(approved.task.test),
  )

  const testingCounts = counts(approved.board)
  check('counts include the testing column', testingCounts.testing === 1, JSON.stringify(testingCounts))
  const passed = passTest(approved.board, 'T-1', T0 + 3, 'tester')
  check('a passed test stays in testing until the merge', passed.ok === true && passed.task.status === 'testing' && passed.task.test.status === 'passed')

  const merged = recordMergeResult(passed.board, 'T-1', { status: 'merged', mergeCommit: 'merge-sha' }, T0 + 4, 'merger')
  const mergedTask = merged.ok === true ? findTask(merged.board, 'T-1') : null
  check(
    'the merge completes the task',
    merged.ok === true && mergedTask.status === 'done' && mergedTask.merge.status === 'merged',
    JSON.stringify(mergedTask && mergedTask.status),
  )
  check(
    'the history shows the whole chain',
    findTask(merged.board, 'T-1').history.map((entry) => entry.to).join(',') === 'pending,running,reviewing,testing,testing,done',
    findTask(merged.board, 'T-1').history.map((entry) => entry.to).join(','),
  )
}

// a submit without a merge record (no worktree) cannot reach a merge
{
  let board = make(base(), 'A').board
  board = claimTask(board, 'T-1', { name: 'w' }, T0).board
  const submitted = submitTask(board, 'T-1', { evidence: 'plain' }, T0 + 1, 'w')
  check(
    'a task without a worktree has no merge request',
    submitted.task.commit === null && submitted.task.merge === null && submitted.task.actualFiles.length === 0 && submitted.task.worktree === null,
    JSON.stringify({ commit: submitted.task.commit, merge: submitted.task.merge, worktree: submitted.task.worktree }),
  )
  const approved = approveReview(submitted.board, 'T-1', T0 + 2, 'r')
  const passed = passTest(approved.board, 'T-1', T0 + 3, 't')
  const refused = recordMergeResult(passed.board, 'T-1', { status: 'merged' }, T0 + 4, 'm')
  check('a task without a merge request cannot be merged', refused.code === 'no-merge-request', JSON.stringify(refused))
}

// phase attempts: rework opens a new review round, then a new test round
{
  let board = make(base(), 'A').board
  board = claimTask(board, 'T-1', { name: 'w' }, T0).board
  board = submitTask(board, 'T-1', { evidence: 'v1' }, T0 + 1, 'w').board
  const changes = requestChanges(board, 'T-1', 'rename the helper', T0 + 2, 'reviewer')
  check('changes-requested returns to running', changes.ok === true && changes.task.status === 'running', JSON.stringify(changes))
  check(
    'the review keeps the reasons and the round',
    changes.task.review.status === 'changes-requested' && changes.task.review.reasons === 'rename the helper' && changes.task.review.attempt === 1,
    JSON.stringify(changes.task.review),
  )
  check('the rework renews the lease', changes.task.leaseUntil === new Date(T0 + 2 + TASK_LEASE_MS).toISOString(), String(changes.task.leaseUntil))
  const resubmitted = submitTask(changes.board, 'T-1', { evidence: 'v2' }, T0 + 3, 'w')
  check(
    'the resubmission opens round two',
    resubmitted.ok === true && resubmitted.task.status === 'reviewing' && resubmitted.task.review.attempt === 2,
    JSON.stringify(resubmitted.task.review),
  )
  const approved = approveReview(resubmitted.board, 'T-1', T0 + 4, 'reviewer')
  check('an approval opens the first test round of this task', approved.ok === true && approved.task.test.attempt === 1, JSON.stringify(approved.task.test))
  const failed = failTest(approved.board, 'T-1', 'test_board fails on line 3', T0 + 5, 'tester')
  check('a failed test returns to running', failed.ok === true && failed.task.status === 'running', JSON.stringify(failed))
  check(
    'the test keeps the evidence and the round',
    failed.task.test.status === 'failed' && failed.task.test.evidence === 'test_board fails on line 3' && failed.task.test.attempt === 1,
    JSON.stringify(failed.task.test),
  )
  const again = submitTask(failed.board, 'T-1', { evidence: 'v3' }, T0 + 6, 'w')
  check('the next round is round three for the review', again.ok === true && again.task.review.attempt === 3, JSON.stringify(again.task.review))
  const approvedAgain = approveReview(again.board, 'T-1', T0 + 7, 'reviewer')
  check('and the test round follows the review round', approvedAgain.ok === true && approvedAgain.task.test.attempt === 2, JSON.stringify(approvedAgain.task.test))
}

// review/test decisions need the matching phase and an open round
{
  let board = make(base(), 'A').board
  board = claimTask(board, 'T-1', { name: 'w' }, T0).board
  check('a task outside review cannot be approved', approveReview(board, 'T-1', T0, 'r').code === 'not-reviewing')
  board = submitTask(board, 'T-1', {}, T0 + 1, 'w').board
  check('a task outside testing cannot pass', passTest(board, 'T-1', T0 + 2, 't').code === 'not-testing')
  check('changes need reasons', requestChanges(board, 'T-1', '  ', T0 + 2, 'r').code === 'missing-reasons')
  board = approveReview(board, 'T-1', T0 + 2, 'r').board
  check('a test failure needs evidence', failTest(board, 'T-1', '', T0 + 3, 't').code === 'missing-evidence')
  check('a decided round cannot be re-approved', approveReview(board, 'T-1', T0 + 3, 'r').code === 'not-reviewing')
}

// merge eligibility follows the phases, never the old done shortcut
{
  let board = make(base(), 'A').board
  board = claimTask(board, 'T-1', { name: 'w' }, T0).board
  board = submitTask(board, 'T-1', { merge: { status: 'open', base: 'b', target: 'main', head: 'h' } }, T0 + 1, 'w').board
  check('a reviewed-only task is not mergeable', mergeEligible(findTask(board, 'T-1')) === false)
  board = approveReview(board, 'T-1', T0 + 2, 'r').board
  check('a pending test is not mergeable', mergeEligible(findTask(board, 'T-1')) === false)
  board = passTest(board, 'T-1', T0 + 3, 't').board
  check('a passed test is mergeable', mergeEligible(findTask(board, 'T-1')) === true)
  const notReviewing = approveReview(board, 'T-1', T0 + 4, 'r')
  check('a testing task cannot be approved again', notReviewing.code === 'not-reviewing')
}

// dispatch requests: an agent records a request; a user approves it
{
  const requested = requestDispatch(base(), { by: '@agent', note: 'deps ready' }, T0, '@agent')
  check('a start request is recorded', requested.ok === true && requested.request !== null && requested.request.by === '@agent', JSON.stringify(requested))
  check('a request does not start dispatch', requested.board.dispatch.state === 'paused')
  check('the request keeps its note', requested.request.note === 'deps ready')
  const approved = approveDispatch(requested.board, T0 + 1, '@user')
  check('approving starts dispatch', approved.ok === true && approved.board.dispatch.state === 'running')
  check('approving clears the request', approved.board.dispatch.request === null)
  const rejected = clearDispatchRequest(requested.board, T0 + 1, '@user')
  check('rejecting clears the request and leaves dispatch paused', rejected.board.dispatch.request === null && rejected.board.dispatch.state === 'paused')
}

// cancel, reopen, block, unblock, retry
{
  let board = make(base(), 'A').board
  const cancelled = cancelTask(board, 'T-1', T0, '@me', 'not needed')
  check('a pending task can be cancelled', cancelled.ok === true && cancelled.task.status === 'cancelled')
  const reopened = reopenTask(cancelled.board, 'T-1', T0, '@me')
  check('a cancelled task can be reopened', reopened.ok === true && findTask(reopened.board, 'T-1').status === 'pending')
  const blocked = blockTask(reopened.board, 'T-1', T0, '@me', 'waiting for art')
  check('a task can be blocked', blocked.ok === true && blocked.task.status === 'blocked')
  const unblocked = unblockTask(blocked.board, 'T-1', T0, '@me')
  check('a blocked task can be unblocked', unblocked.ok === true && findTask(unblocked.board, 'T-1').status === 'pending')
  const done = finish(unblocked.board, 'T-1')
  check('a done task cannot be cancelled', cancelTask(done, 'T-1', T0, '@me').code === 'done')
  const doneReopen = reopenTask(done, 'T-1', T0, '@me')
  check('a done task can be reopened', doneReopen.ok === true && findTask(doneReopen.board, 'T-1').status === 'pending')
}

// retry resets the budget of a blocked task
{
  let board = make(base(), 'A').board
  board = blockTask(board, 'T-1', T0, '@me', 'boom').board
  const task = findTask(board, 'T-1')
  task.attempts = 3
  task.dispatch = { status: 'exhausted', error: 'boom' }
  const retried = retryTask(board, 'T-1', T0, '@user')
  check('retry returns a blocked task to pending', retried.ok === true && findTask(retried.board, 'T-1').status === 'pending')
  check('retry clears attempts and the dispatch record', findTask(retried.board, 'T-1').attempts === 0 && findTask(retried.board, 'T-1').dispatch === null)
}

// dispatch settings
{
  let board = base()
  check('dispatch starts paused', board.dispatch.state === 'paused')
  const started = setDispatch(board, { state: 'running' }, T0, '@user')
  check('start records the state', started.ok === true && started.dispatch.state === 'running' && started.dispatch.by === '@user')
  const clamped = setDispatch(started.board, { maxConcurrent: 99, maxWorkAgents: 99, maxAttempts: 0 }, T0, '@user')
  check('settings are clamped', clamped.dispatch.maxConcurrent === 8 && clamped.dispatch.maxWorkAgents === 12 && clamped.dispatch.maxAttempts === 1)
  check('an invalid state is refused', setDispatch(board, { state: 'sometimes' }, T0, '@user').code === 'invalid-dispatch')
  check(
    'dispatch.worktree defaults to the internal root with no switch',
    board.dispatch.worktree.root === '.worktrees' && board.dispatch.worktree.enabled === undefined,
    JSON.stringify(board.dispatch.worktree),
  )
  const worktree = setDispatch(board, { worktree: { enabled: true, root: '/tmp/wt' } }, T0, '@user')
  check(
    'dispatch settings normalise the worktree root and drop enabled',
    worktree.ok === true && worktree.dispatch.worktree.root === '.worktrees' && worktree.dispatch.worktree.enabled === undefined,
    JSON.stringify(worktree.dispatch && worktree.dispatch.worktree),
  )
  check('dispatch no longer carries a testing switch', board.dispatch.testing === undefined, JSON.stringify(board.dispatch))
  const ignored = setDispatch(board, { testing: 'independent' }, T0, '@user')
  check('the old testing setting is ignored', ignored.ok === true && ignored.dispatch.testing === undefined, JSON.stringify(ignored.dispatch))
  const merged = recordMergeResult(
    approveReview(
      submitTask(claimTask(make(base(), 'A').board, 'T-1', { name: 'w' }, T0).board, 'T-1', {}, T0 + 1, 'w').board,
      'T-1',
      T0 + 2,
      'r',
    ).board,
    'T-1',
    { status: 'merged' },
    T0 + 3,
    'm',
  )
  check('a merge without a request is refused', merged.code === 'no-merge-request', JSON.stringify(merged))
}

// renewLeases
{
  let board = make(base(), 'A').board
  board = claimTask(board, 'T-1', { name: 'w', session: 's-1' }, T0).board
  const renewed = renewLeases(board, { session: 's-1', name: '@w' }, T0 + 1000)
  check('the owner can renew', renewed.ok === true && Date.parse(findTask(renewed.board, 'T-1').leaseUntil) === T0 + 1000 + TASK_LEASE_MS)
  const stranger = renewLeases(board, { session: 's-2', name: '@x' }, T0 + 1000)
  check('a stranger does not renew', Date.parse(findTask(stranger.board, 'T-1').leaseUntil) === T0 + TASK_LEASE_MS)
}

// git-derived identity is host-only
{
  const board = make(base(), 'A').board
  for (const field of ['base', 'target', 'branch', 'worktree', 'commit', 'actualFiles']) {
    const refused = updateTask(board, 'T-1', { [field]: field === 'actualFiles' ? ['x'] : 'x' }, T0, '@me')
    check('update refuses host-written ' + field, refused.code === 'host-only', JSON.stringify(refused))
  }
  const merge = updateTask(board, 'T-1', { merge: { status: 'open' } }, T0, '@me')
  check('update refuses a host-written merge', merge.code === 'host-only', JSON.stringify(merge))
  check('a refused update leaves the task untouched', findTask(board, 'T-1').base === null && findTask(board, 'T-1').merge === null)
}

// summary/detail carry the worktree and merge-request fields
{
  const board = make(base(), 'A').board
  const task = findTask(board, 'T-1')
  task.base = 'base-sha'
  task.target = 'main'
  task.branch = 'task/T-1'
  task.worktree = 'C:/proj/.worktrees/T-1'
  task.commit = 'commit-sha'
  task.actualFiles = ['scripts/a.gd']
  task.requiredRole = 'reviewer'
  task.merge = {
    status: 'open',
    base: 'base-sha',
    target: 'main',
    head: 'commit-sha',
    declaredFiles: ['scripts/a.gd'],
    actualFiles: ['scripts/a.gd'],
    tests: 'verify',
    reviewer: null,
    conflict: null,
    at: '2026-01-01T00:00:00.000Z',
  }
  const view = taskSummary(board, task, T0)
  check(
    'summary carries the worktree fields',
    view.worktree === task.worktree && view.branch === 'task/T-1' && view.base === 'base-sha' && view.target === 'main' && view.commit === 'commit-sha' && view.requiredRole === 'reviewer',
    JSON.stringify(view),
  )
  check('summary carries actualFiles and merge', view.actualFiles.join(',') === 'scripts/a.gd' && view.merge.status === 'open', JSON.stringify(view))
  const full = detail(board, task, T0)
  check('detail carries the merge record', full.merge.head === 'commit-sha' && full.merge.declaredFiles.join(',') === 'scripts/a.gd' && full.worktree === task.worktree)
}

// counts
{
  let board = base()
  board = make(board, 'A').board
  board = make(board, 'B').board
  board = make(board, 'C').board
  board = finish(board, 'T-1')
  const summary = counts(board)
  check('counts know what is ready', summary.ready === 2, JSON.stringify(summary))
  check('counts know what is done', summary.done === 1 && summary.total === 3, JSON.stringify(summary))
}

// ── T-37 liveness: extension, handover options, adoption, views ────────────
{
  let board = make(base(), 'A').board
  board = claimTask(board, 'T-1', { name: 'w', session: 's-w' }, T0).board
  const claimed = findTask(board, 'T-1')

  // extendLease
  const extended = extendLease(board, 'T-1', T0 + 1000, { reason: 'holder alive' })
  const after = findTask(extended.board, 'T-1')
  check('extendLease pushes the lease by a full period', after.leaseUntil === new Date(T0 + 1000 + TASK_LEASE_MS).toISOString(), String(after.leaseUntil))
  check('extendLease keeps the assignee and the attempt', after.assignee.name === claimed.assignee.name && after.assignee.session === claimed.assignee.session && after.attempts === claimed.attempts, JSON.stringify({ assignee: after.assignee, attempts: after.attempts }))
  check('extendLease records the reason in history', String(after.history.slice(-1)[0].note).indexOf('holder alive') >= 0, JSON.stringify(after.history.slice(-1)))
  check('extendLease refuses a task that is not running', extendLease(make(base(), 'B').board, 'T-1', T0).code === 'not-running')

  // attemptStartedAt — the cap needs a claim time, and a missing/broken one must
  // read as "unknown" instead of silently capping at zero.
  check('attemptStartedAt reads the claim time', attemptStartedAt(after) === T0, String(attemptStartedAt(after)))
  const noClaim = JSON.parse(JSON.stringify(after)); noClaim.dispatch = null
  check('attemptStartedAt is null without a claim record', attemptStartedAt(noClaim) === null)
  const badClaim = JSON.parse(JSON.stringify(after)); badClaim.dispatch.at = 'not-a-date'
  check('attemptStartedAt is null for an unreadable claim time', attemptStartedAt(badClaim) === null)

  // expireLeases per-task options keep the claim identity the guard needs.
  const expired = expireLeases(board, T0 + TASK_LEASE_MS + 1, 3, { id: 'T-1', error: 'lease expired (liveness cap)', reason: 'alive but past the liveness cap' })
  const gone = findTask(expired.board, 'T-1')
  check('a per-task expiry writes the caller error and reason', gone.dispatch.error === 'lease expired (liveness cap)' && String(gone.history.slice(-1)[0].note).indexOf('past the liveness cap') >= 0, JSON.stringify({ error: gone.dispatch.error, note: gone.history.slice(-1)[0].note }))
  check('and keeps the previous claim identity for the guard', gone.dispatch.target === 'w' && gone.dispatch.targetId === 's-w', JSON.stringify(gone.dispatch))
  check('and only the named task is reaped', expireLeases(board, T0 + TASK_LEASE_MS + 1, 3, { id: 'T-9' }).events.length === 0)

  // claimTask records adoption instead of pretending it is a fresh attempt.
  const adopted = claimTask(
    expired.board,
    'T-1',
    { name: 'w2', session: 's-2', worktree: { base: 'base-sha', target: 'main', branch: 'task/T-1-1', path: '/tmp/wt', keep: true }, adopt: { fromAttempt: 1, branch: 'task/T-1-1', head: 'old-commit-sha' } },
    T0 + TASK_LEASE_MS + 2,
  )
  const next = findTask(adopted.board, 'T-1')
  check("an adopting claim records via='adopt'", next.dispatch.via === 'adopt', JSON.stringify(next.dispatch))
  check('and says what it adopted', String(next.history.slice(-1)[0].note).indexOf('adopting task/T-1-1 @ old-commit') >= 0 && String(next.history.slice(-1)[0].note).indexOf('from attempt 1') >= 0, JSON.stringify(next.history.slice(-1)))
  check('and keeps the adopted branch and base', next.branch === 'task/T-1-1' && next.base === 'base-sha', JSON.stringify({ branch: next.branch, base: next.base }))

  // Views: the panel needs the remainder and the reminder flag.
  const view = taskSummary(board, findTask(board, 'T-1'), T0 + 1000)
  check('the view exposes the lease remainder', view.leaseRemaining === TASK_LEASE_MS - 1000 && view.leaseExpired === false && view.leaseReminder === false, JSON.stringify({ remaining: view.leaseRemaining, expired: view.leaseExpired }))
  const soon = taskSummary(board, findTask(board, 'T-1'), T0 + TASK_LEASE_MS - 1000)
  check('and flags a lease inside the reminder window', soon.leaseReminder === true && soon.leaseExpired === false && soon.leaseRemaining <= TASK_LEASE_REMINDER_MS, JSON.stringify({ remaining: soon.leaseRemaining, reminder: soon.leaseReminder }))
  const lapsedView = taskSummary(board, findTask(board, 'T-1'), T0 + TASK_LEASE_MS + 1)
  check('and an expired lease reads as expired with nothing left', lapsedView.leaseExpired === true && lapsedView.leaseRemaining === 0, JSON.stringify({ expired: lapsedView.leaseExpired, remaining: lapsedView.leaseRemaining }))

  // The heartbeat policy: liveness gate and hard cap.
  const windowAt = T0 + TASK_LEASE_MS - 1000
  check('the heartbeat renews a live holder inside the window', renewRunningLeases(board, windowAt, { allow: () => true }).renewed.join(',') === 'T-1')
  check('the heartbeat refuses a holder the liveness check rejects', renewRunningLeases(board, windowAt, { allow: () => false }).renewed.length === 0)
  check('the heartbeat stops at the extension cap', renewRunningLeases(board, windowAt, { allow: () => true, maxExtensionMs: 10 * 60 * 1000 }).renewed.length === 0)
  check('the default cap is the schema cap', renewRunningLeases(board, windowAt, { allow: () => true }).renewed.length === 1 && TASK_LEASE_EXTENSION_MAX_MS === 4 * 60 * 60 * 1000)
  const noAtBoard = JSON.parse(JSON.stringify(board))
  noAtBoard.tasks[0].dispatch = null
  check('a task with no claim time cannot be capped, so a live holder is still renewed', renewRunningLeases(noAtBoard, windowAt, { allow: () => true }).renewed.join(',') === 'T-1')
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)