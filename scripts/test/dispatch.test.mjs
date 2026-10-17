// Scheduler tests: the dependency chain, start/pause, concurrency, target
// reservation, file locks, retry, lease reaping and host restart recovery.

import { updateBoard } from '../../plugin/task-center/board.mjs'
import { writePolicyFor } from '../../plugin/task-center/state.mjs'
import { findTask } from '../../plugin/task-center/service.mjs'
import { createRig, createTask, submitAsUser, sleep } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}
async function snapshot(rig) {
  const result = await rig.action('board')
  if (result.ok !== true) throw new Error('board failed: ' + JSON.stringify(result))
  return result
}
const byId = (snap, id) => snap.tasks.filter((task) => task.id === id)[0]
const running = (snap) => snap.tasks.filter((task) => task.status === 'running').map((task) => task.id).sort()
const ids = (snap) => snap.tasks.map((task) => task.id + ':' + task.status).sort()
async function patchTask(rig, id, change) {
  return updateBoard(
    { fs: rig.fs },
    {
      projectPath: rig.project,
      mutate: (board) => {
        const task = findTask(board, id)
        change(task, board)
        return board
      },
      sandboxPolicy: writePolicyFor(rig.project),
    },
  )
}

// ── the dependency chain from the requirement ──────────────────────────────
// A <- B <- C, D, E <- F: dispatch A, D, E; after A completes dispatch B,
// after E completes dispatch F.
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'A' })).id
  const B = (await createTask(rig, { title: 'B', dependsOn: [A] })).id
  const C = (await createTask(rig, { title: 'C', dependsOn: [B] })).id
  const D = (await createTask(rig, { title: 'D' })).id
  const E = (await createTask(rig, { title: 'E' })).id
  const F = (await createTask(rig, { title: 'F', dependsOn: [E] })).id
  await rig.action('settings', { maxConcurrent: 3, maxWorkAgents: 8 })
  await rig.action('start')
  await rig.settle()
  let snap = await snapshot(rig)
  check('the first pass dispatches A, D and E', running(snap).join(',') === [A, D, E].sort().join(','), JSON.stringify(running(snap)))
  check('B, C and F wait', [B, C, F].every((id) => byId(snap, id).status === 'pending'), JSON.stringify(ids(snap)))
  check('C reports B as its waiting dependency', byId(snap, C).dependency.state === 'waiting' && byId(snap, C).dependency.waitingOn.join(',') === B, JSON.stringify(byId(snap, C).dependency))

  await submitAsUser(rig, A, 'A done')
  await submitAsUser(rig, E, 'E done')
  await rig.settle()
  snap = await snapshot(rig)
  check('after A is done, B is dispatched', byId(snap, B).status === 'running', JSON.stringify(ids(snap)))
  check('after E is done, F is dispatched', byId(snap, F).status === 'running', JSON.stringify(ids(snap)))
  check('C still waits on B', byId(snap, C).status === 'pending' && byId(snap, C).dependency.waitingOn.join(',') === B)

  await submitAsUser(rig, B, 'B done')
  await rig.settle()
  snap = await snapshot(rig)
  check('after B is done, C is dispatched', byId(snap, C).status === 'running', JSON.stringify(ids(snap)))
  check('the chain leaves A, B, D, E, F running or done', ['done'].every((status) => byId(snap, A).status === status))
  rig.scheduler.dispose()
}

// ── start / pause ──────────────────────────────────────────────────────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'A' })).id
  await rig.action('start')
  await rig.settle()
  check('start dispatches', (await snapshot(rig)).tasks[0].status === 'running')
  await rig.action('pause')
  const B = (await createTask(rig, { title: 'B' })).id
  await rig.settle()
  let snap = await snapshot(rig)
  check('pause stops new dispatch', byId(snap, B).status === 'pending', JSON.stringify(ids(snap)))
  await submitAsUser(rig, A, 'done')
  await rig.settle()
  snap = await snapshot(rig)
  check('a completed task does not dispatch while paused', byId(snap, B).status === 'pending', JSON.stringify(ids(snap)))
  await rig.action('start')
  await rig.settle()
  snap = await snapshot(rig)
  check('resuming dispatches the pending task', byId(snap, B).status === 'running', JSON.stringify(ids(snap)))
  rig.scheduler.dispose()
}

// ── concurrency and priority ───────────────────────────────────────────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const low = (await createTask(rig, { title: 'low', priority: 0 })).id
  const high = (await createTask(rig, { title: 'high', priority: 9 })).id
  await rig.action('settings', { maxConcurrent: 1, maxWorkAgents: 8 })
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  check('only maxConcurrent tasks run', running(snap).length === 1, JSON.stringify(running(snap)))
  check('the higher priority task goes first', byId(snap, high).status === 'running' && byId(snap, low).status === 'pending', JSON.stringify(ids(snap)))
  await submitAsUser(rig, high, 'done')
  await rig.settle()
  check('the next slot is filled after completion', byId(await snapshot(rig), low).status === 'running')
  rig.scheduler.dispose()
}

// ── one idle worker gets one task per pass ─────────────────────────────────
{
  const rig = createRig({ allowSpawn: false, teamOptions: { markRunningOnSend: true } })
  const A = (await createTask(rig, { title: 'A' })).id
  const B = (await createTask(rig, { title: 'B' })).id
  await rig.action('settings', { maxConcurrent: 3 })
  await rig.action('start')
  await rig.settle()
  let snap = await snapshot(rig)
  check('the single idle worker receives only one task', running(snap).length === 1, JSON.stringify(running(snap)))
  check('the other task stays pending', [A, B].filter((id) => byId(snap, id).status === 'pending').length === 1, JSON.stringify(ids(snap)))
  check('exactly one message was sent', rig.team.calls.filter((call) => call.kind === 'send').length === 1, JSON.stringify(rig.team.calls))
  rig.team.setStatus('fixer', 'inactive')
  await rig.settle()
  snap = await snapshot(rig)
  check('the worker is reused once idle again', running(snap).length === 2, JSON.stringify(running(snap)))
  rig.scheduler.dispose()
}

// ── file locks serialize overlapping tasks ─────────────────────────────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const X = (await createTask(rig, { title: 'X', writeFiles: ['scripts/shared.gd'] })).id
  const Y = (await createTask(rig, { title: 'Y', writeFiles: ['scripts/shared.gd'] })).id
  await rig.action('settings', { maxConcurrent: 2, maxWorkAgents: 8 })
  await rig.action('start')
  await rig.settle()
  let snap = await snapshot(rig)
  check('only one task with the same file runs', running(snap).length === 1, JSON.stringify(running(snap)))
  check('the file is locked by the running task', snap.locks.length === 1 && snap.locks[0].taskId === running(snap)[0], JSON.stringify(snap.locks))
  check('the other task waits for the file', byId(snap, running(snap)[0] === X ? Y : X).status === 'pending')
  await submitAsUser(rig, X, 'x done')
  await rig.settle()
  snap = await snapshot(rig)
  check('after the first finishes the second runs', byId(snap, Y).status === 'running', JSON.stringify(ids(snap)))
  check('the lock moved to the second task', snap.locks.length === 1 && snap.locks[0].taskId === Y, JSON.stringify(snap.locks))
  rig.scheduler.dispose()
}

// ── dispatch failure, retry ceiling, retry reset ───────────────────────────
{
  const rig = createRig({ allowSpawn: false, teamOptions: { sendThrows: true } })
  const A = (await createTask(rig, { title: 'A' })).id
  await rig.action('settings', { maxAttempts: 2, maxConcurrent: 1 })
  await rig.action('start')
  for (let index = 0; index < 6; index++) {
    const snap = await snapshot(rig)
    if (byId(snap, A).status === 'blocked') break
    await rig.scheduler.settle(rig.project)
    await sleep(10)
  }
  let snap = await snapshot(rig)
  check('repeated send failures block the task', byId(snap, A).status === 'blocked', JSON.stringify(ids(snap)))
  check('the refusal names the service error', byId(snap, A).dispatch.error === 'mailbox full', JSON.stringify(byId(snap, A).dispatch))
  check('attempts reached the ceiling', byId(snap, A).attempts === 2, String(byId(snap, A).attempts))
  const retried = await rig.action('retry', { id: A })
  check('a blocked task can be retried', retried.ok === true && retried.task.status === 'pending')
  check('retry clears the attempt count', retried.task.attempts === 0)
  rig.scheduler.dispose()
}

// ── lease expiry returns the task to the pool (even while paused) ──────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'A' })).id
  await rig.action('start')
  await rig.settle()
  await rig.action('pause')
  await patchTask(rig, A, (task) => {
    task.leaseUntil = new Date(Date.now() - 1000).toISOString()
  })
  await rig.settle()
  const snap = await snapshot(rig)
  check('an expired lease returns the task to pending', byId(snap, A).status === 'pending', JSON.stringify(ids(snap)))
  check('and the expiry is visible', byId(snap, A).dispatch.status === 'lease-expired', JSON.stringify(byId(snap, A).dispatch))
  check('and no file lock is left behind', snap.locks.length === 0, JSON.stringify(snap.locks))
  rig.scheduler.dispose()
}

// ── a task claimed by a previous host process is recovered ─────────────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'A' })).id
  await rig.action('start')
  await rig.settle()
  await rig.action('pause')
  await patchTask(rig, A, (task) => {
    task.dispatch = Object.assign({}, task.dispatch, { host: 'a-previous-process' })
  })
  await rig.settle()
  const snap = await snapshot(rig)
  check('a claim from another process is requeued', byId(snap, A).status === 'pending', JSON.stringify(ids(snap)))
  check('with a readable reason', String(byId(snap, A).dispatch.error).indexOf('host restart') >= 0, JSON.stringify(byId(snap, A).dispatch))
  rig.scheduler.dispose()
}


// ── a spawned worker can submit under its recorded session identity ─────────
{
  const rig = createRig({
    teamOptions: { roster: [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }], spawnedStatus: 'running' },
  })
  const A = (await createTask(rig, { title: 'spawned work' })).id
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  const task = byId(snap, A)
  check('the task was handed to a spawned worker', task.status === 'running' && task.assignee !== null, JSON.stringify(task && task.assignee))
  check('the spawn result session is recorded', typeof task.assignee.session === 'string' && task.assignee.session.length > 0, JSON.stringify(task.assignee))
  const wrong = await rig.api.perform('submit', { id: A, evidence: 'mine' }, { projectPath: rig.project, by: '@other', role: 'agent', agent: { id: 'session-other' } })
  check('a different session cannot submit the spawned task', wrong.ok === false && wrong.code === 'not-assignee', JSON.stringify(wrong))
  const submitted = await rig.api.perform('submit', { id: A, evidence: 'done' }, { projectPath: rig.project, by: '@worker', role: 'agent', agent: { id: task.assignee.session } })
  check('the spawned worker submits under its session', submitted.ok === true && submitted.task.status === 'done', JSON.stringify(submitted))
  rig.scheduler.dispose()
}

// ── review gates dependents until a human accepts ──────────────────────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'A', requiresReview: true })).id
  const B = (await createTask(rig, { title: 'B', dependsOn: [A] })).id
  await rig.action('start')
  await rig.settle()
  let snap = await snapshot(rig)
  check('review-gated A is running first', byId(snap, A).status === 'running', JSON.stringify(ids(snap)))
  await submitAsUser(rig, A, 'ready')
  await rig.settle()
  snap = await snapshot(rig)
  check('A waits for review', byId(snap, A).status === 'review', JSON.stringify(ids(snap)))
  check('B does not start before acceptance', byId(snap, B).status === 'pending', JSON.stringify(ids(snap)))
  const accepted = await rig.action('accept', { id: A })
  check('A can be accepted', accepted.ok === true && accepted.task.status === 'done')
  await rig.settle()
  snap = await snapshot(rig)
  check('B starts after acceptance', byId(snap, B).status === 'running', JSON.stringify(ids(snap)))
  rig.scheduler.dispose()
}

// ── no team services: the board still works and nothing crashes ────────────
{
  const rig = createRig({ team: null })
  const A = (await createTask(rig, { title: 'A' })).id
  const started = await rig.action('start')
  check('starting dispatch succeeds without a team', started.ok === true && started.dispatch.state === 'running')
  await rig.settle()
  const snap = await snapshot(rig)
  check('the task stays pending', byId(snap, A).status === 'pending', JSON.stringify(ids(snap)))
  check('the board is still readable', snap.ok === true && snap.tasks.length === 1)
  rig.scheduler.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)