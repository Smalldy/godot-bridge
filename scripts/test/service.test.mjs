// Model tests: dependency graph, readiness, transitions, leases and dispatch
// settings. No filesystem and no Cordis — service.mjs is pure.

import { emptyBoard } from '../../plugin/task-center/board.mjs'
import { TASK_LEASE_MS } from '../../plugin/task-center/schema.mjs'
import {
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
  findTask,
  readyTasks,
  renewLeases,
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
  const claimed = claimTask(board, id, { name: 'worker' }, at(offset === undefined ? 10 : offset))
  if (claimed.ok !== true) throw new Error('claim failed: ' + JSON.stringify(claimed))
  const submitted = submitTask(claimed.board, id, { evidence: 'done' }, at((offset === undefined ? 10 : offset) + 1), 'worker')
  if (submitted.ok !== true) throw new Error('submit failed: ' + JSON.stringify(submitted))
  return submitted.board
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

// submit is completion; there is no review status
{
  let board = make(base(), 'A').board
  const early = submitTask(board, 'T-1', {}, T0, 'w')
  check('a pending task cannot be submitted', early.code === 'not-running')
  board = claimTask(board, 'T-1', { name: 'w' }, T0).board
  const done = submitTask(board, 'T-1', { evidence: 'tests pass' }, T0 + 1, 'w')
  check('submit completes the task', done.ok === true && done.task.status === 'done')
  check('evidence is stored', done.task.evidence === 'tests pass')
  check('a submitted task reaches done without a review state', findTask(done.board, 'T-1').status === 'done')
  check(
    'a task without a worktree has no merge request',
    done.task.commit === null && done.task.merge === null && done.task.actualFiles.length === 0 && done.task.worktree === null,
    JSON.stringify({ commit: done.task.commit, merge: done.task.merge, actualFiles: done.task.actualFiles, worktree: done.task.worktree }),
  )
}

// a worktree task records the commit and merge request on submit
{
  let board = make(base(), 'MR task', { writeFiles: ['scripts/a.gd'] }).board
  board = claimTask(board, 'T-1', {
    name: 'w',
    worktree: { base: 'base-sha', target: 'main', branch: 'task/T-1-1', path: '/worktrees/T-1', keep: true, error: null },
  }, T0).board
  const claimed = findTask(board, 'T-1')
  check(
    'the claim records the worktree identity',
    claimed.worktree === '/worktrees/T-1' && claimed.base === 'base-sha' && claimed.target === 'main' && claimed.branch === 'task/T-1-1',
    JSON.stringify({ worktree: claimed.worktree, base: claimed.base, target: claimed.target, branch: claimed.branch }),
  )
  check('and records that the worktree must be kept', claimed.dispatch.keep === true, JSON.stringify(claimed.dispatch))
  const merge = {
    status: 'open',
    base: 'base-sha',
    target: 'main',
    head: 'head-sha',
    declaredFiles: ['scripts/a.gd', 7, ' scripts/a.gd '],
    actualFiles: ['scripts/a.gd', 'scripts/b.gd', 'scripts/a.gd'],
    tests: 'npm run verify',
    reviewer: null,
    conflict: null,
    at: '2026-01-01T00:00:00.000Z',
  }
  const submitted = submitTask(board, 'T-1', { evidence: 'npm run verify', commit: 'head-sha', actualFiles: ['scripts/a.gd', 'scripts/b.gd'], merge: merge }, T0 + 10, 'w')
  check(
    'submit records the commit and actual files',
    submitted.ok === true && submitted.task.commit === 'head-sha' && submitted.task.actualFiles.join(',') === 'scripts/a.gd,scripts/b.gd',
    JSON.stringify(submitted),
  )
  const stored = findTask(submitted.board, 'T-1')
  check(
    'submit records an open merge request',
    stored.merge !== null && stored.merge.status === 'open' && stored.merge.base === 'base-sha' && stored.merge.target === 'main' && stored.merge.head === 'head-sha',
    JSON.stringify(stored.merge),
  )
  check(
    'the merge keeps declared and actual files apart',
    stored.merge.declaredFiles.join(',') === 'scripts/a.gd' && stored.merge.actualFiles.join(',') === 'scripts/a.gd,scripts/b.gd',
    JSON.stringify(stored.merge),
  )
  check(
    'the merge carries the tests line, no reviewer and no conflict',
    stored.merge.tests === 'npm run verify' && stored.merge.reviewer === null && stored.merge.conflict === null && stored.merge.at === '2026-01-01T00:00:00.000Z',
    JSON.stringify(stored.merge),
  )
  check('submit still completes the task and clears its lease', stored.status === 'done' && stored.leaseUntil === null)
  check('submit does not remove the worktree', stored.worktree === '/worktrees/T-1')
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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)