// Scheduler tests: the dependency chain, start/pause, concurrency, target
// reservation, file locks, retry, lease reaping and host restart recovery.

import { join } from 'node:path'
import { readRoleConfig, rolesPath, updateBoard } from '../../plugin/task-center/board.mjs'
import { createState, writePolicyFor } from '../../plugin/task-center/state.mjs'
import { findTask } from '../../plugin/task-center/service.mjs'
import {
  briefFor,
  briefPartsFor,
  createActivity,
  createDispatcher,
  createRoleManager,
  ensureRole,
  gitFor,
  isRoleName,
  pickTarget,
  reviewBriefFor,
  reworkBriefFor,
  roleBriefFor,
  roleBriefSections,
  roleContextPreview,
  roleKindOf,
  roleTemplateValuesFor,
  serialiseWorktreeCreate,
  workerPool,
} from '../../plugin/task-center/dispatch.mjs'
import { DEFAULT_ROLE_PROMPTS, ROLE_PROVISION_TIMEOUT_MS, ROLE_TEMPLATE_VARIABLE_NAMES, TASK_HEARTBEAT_MS, TASK_LEASE_MS, defaultRoleConfig, normaliseRoleConfig } from '../../plugin/task-center/schema.mjs'
import { createApi } from '../../plugin/task-center/api.mjs'
import { createGit } from '../../plugin/task-center/git.mjs'
import { createRig, createTask, submitAsUser, sleep, createFakeFs, createTeam, createFakeGit, seedBoard, PROJECT } from './support/fixtures.mjs'

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
/** Submit a task and bring it through review/testing to done+merged — the state
 * a dependent now waits for. The phases are recorded directly: these tests are
 * about dispatch, not about who approves. */
async function submitAndMerge(rig, id, evidence) {
  const submitted = await submitAsUser(rig, id, evidence)
  if (submitted.ok !== true) throw new Error('submit failed: ' + JSON.stringify(submitted))
  await patchTask(rig, id, (task) => {
    if (task.merge !== null && task.merge !== undefined) task.merge = Object.assign({}, task.merge, { status: 'merged' })
    if (task.review === null || task.review === undefined) {
      task.review = { status: 'pending', by: 'worker', at: new Date().toISOString(), reasons: null, attempt: 1 }
    }
    task.review = Object.assign({}, task.review, { status: 'approved' })
    task.test = { status: 'passed', by: 'tester', at: new Date().toISOString(), evidence: 'tests pass', attempt: 1 }
    task.status = 'done'
  })
  return submitted
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

  await submitAndMerge(rig, A, 'A done')
  await submitAndMerge(rig, E, 'E done')
  await rig.settle()
  snap = await snapshot(rig)
  check('after A is done, B is dispatched', byId(snap, B).status === 'running', JSON.stringify(ids(snap)))
  check('after E is done, F is dispatched', byId(snap, F).status === 'running', JSON.stringify(ids(snap)))
  check('C still waits on B', byId(snap, C).status === 'pending' && byId(snap, C).dependency.waitingOn.join(',') === B)

  await submitAndMerge(rig, B, 'B done')
  await rig.settle()
  snap = await snapshot(rig)
  check('after B is done, C is dispatched', byId(snap, C).status === 'running', JSON.stringify(ids(snap)))
  check('the chain leaves A, B, D, E, F running or done', ['done'].every((status) => byId(snap, A).status === status))
  rig.scheduler.dispose()
}

// ── a dependent waits for its prerequisite's merge request ─────────────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'A' })).id
  const B = (await createTask(rig, { title: 'B', dependsOn: [A] })).id
  await rig.action('settings', { maxConcurrent: 2, maxWorkAgents: 4 })
  await rig.action('start')
  await rig.settle()
  let snap = await snapshot(rig)
  check('the prerequisite runs first', byId(snap, A).status === 'running' && byId(snap, B).status === 'pending', JSON.stringify(ids(snap)))
  await submitAsUser(rig, A, 'A done')
  await rig.settle()
  snap = await snapshot(rig)
  check(
    'a submitted prerequisite with an open merge request does not release its dependent',
    byId(snap, A).status === 'reviewing' && byId(snap, B).status === 'pending',
    JSON.stringify(ids(snap)),
  )
  check(
    'the dependent is waiting, not broken',
    byId(snap, B).dependency.state === 'waiting' && byId(snap, B).dependency.waitingOn.join(',') === A && byId(snap, B).dependency.brokenOn.length === 0,
    JSON.stringify(byId(snap, B).dependency),
  )
  check('and reports the dependency waiting reason', byId(snap, B).waitingReason === 'dependency', String(byId(snap, B).waitingReason))
  await patchTask(rig, A, (task) => {
    task.merge = Object.assign({}, task.merge, { status: 'merged' })
    task.status = 'done'
  })
  await rig.settle()
  snap = await snapshot(rig)
  check('merging the prerequisite releases the dependent', byId(snap, B).status === 'running', JSON.stringify(ids(snap)))
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

// ── lease liveness: a lapsed lease with a LIVE holder is extended; one whose
// holder is gone returns the task to the pool (even while paused) ──────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'A' })).id
  await rig.action('start')
  await rig.settle()
  await rig.action('pause')
  const claimed = (await snapshot(rig)).tasks.filter((task) => task.id === A)[0]
  const holder = claimed.assignee.name
  await patchTask(rig, A, (task) => {
    task.leaseUntil = new Date(Date.now() - 1000).toISOString()
  })
  await rig.settle()
  let snap = await snapshot(rig)
  check(
    'a lapsed lease whose holder is still alive is extended, never reaped',
    byId(snap, A).status === 'running' && Date.parse(byId(snap, A).leaseUntil) > Date.now(),
    JSON.stringify({ status: byId(snap, A).status, lease: byId(snap, A).leaseUntil }),
  )
  const history = Array.isArray(byId(snap, A).history) ? byId(snap, A).history : []
  check('and the extension is recorded in history', history.some((entry) => String(entry.note).indexOf('lease extended') >= 0), JSON.stringify(history.slice(-2)))
  // The holder disappears from the roster: the same lapsed lease is now a real
  // expiry and the task goes back to the pool for a fresh attempt.
  const roster = rig.team.roster
  const holderIndex = roster.findIndex((member) => member.name === holder)
  const removedHolder = holderIndex >= 0 ? roster.splice(holderIndex, 1)[0] : undefined
  await patchTask(rig, A, (task) => {
    task.leaseUntil = new Date(Date.now() - 1000).toISOString()
  })
  await rig.settle()
  snap = await snapshot(rig)
  check('an expired lease whose holder is gone returns the task to pending', byId(snap, A).status === 'pending', JSON.stringify(ids(snap)))
  check('and the expiry is visible', byId(snap, A).dispatch.status === 'lease-expired', JSON.stringify(byId(snap, A).dispatch))
  check('and no file lock is left behind', snap.locks.length === 0, JSON.stringify(snap.locks))
  if (removedHolder !== undefined) roster.push(removedHolder)
  rig.scheduler.dispose()
}
// ── lease mitigation: activity renews unconditionally, the host heartbeat
// keeps a lease that is still valid alive without any tool call ────────────
{
  let clock = 1_700_000_000_000
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' }, now: () => clock })
  const A = (await createTask(rig, { title: 'long run', writeFiles: ['scripts/a.gd'] })).id
  await rig.action('start')
  await rig.settle()
  let snap = await snapshot(rig)
  const claimed = byId(snap, A)
  check(
    'a claimed task gets the full 60 minute lease',
    claimed.status === 'running' && Date.parse(claimed.leaseUntil) === clock + TASK_LEASE_MS,
    JSON.stringify({ leaseUntil: claimed.leaseUntil, clock: clock }),
  )
  const owner = { name: claimed.assignee.name, session: claimed.assignee.session }
  const asAssignee = { projectPath: rig.project, by: owner.name, role: 'agent', agent: { id: owner.session } }

  // Past the OLD 15 minute bound, one activity call renews with no "half spent"
  // gate at all.
  clock += 16 * 60 * 1000
  const read = await rig.api.perform('get', { id: A }, asAssignee)
  check(
    'activity past the old 15 minute bound renews the lease unconditionally',
    read.ok === true && Date.parse(read.task.leaseUntil) === clock + TASK_LEASE_MS,
    JSON.stringify({ leaseUntil: read.task.leaseUntil, clock: clock }),
  )
  // The activities that never write the board must renew exactly like the rest,
  // together with a read and a board-writing action.
  const leaseOf = async function () { return Date.parse((await rig.action('get', { id: A })).task.leaseUntil) }
  clock += 2 * 60 * 1000
  const locked = await rig.api.perform('lock', { paths: ['scripts/extra.gd'] }, asAssignee)
  check('lock renews the lease like any other activity', locked.ok === true && (await leaseOf()) === clock + TASK_LEASE_MS, JSON.stringify({ clock: clock, lease: await leaseOf() }))
  clock += 2 * 60 * 1000
  const unlocked = await rig.api.perform('unlock', { paths: ['scripts/extra.gd'] }, asAssignee)
  check('unlock renews the lease too', unlocked.ok === true && (await leaseOf()) === clock + TASK_LEASE_MS, JSON.stringify({ clock: clock, lease: await leaseOf() }))
  clock += 2 * 60 * 1000
  const listed = await rig.api.perform('locks', {}, asAssignee)
  check('locks renews the lease', listed.ok === true && (await leaseOf()) === clock + TASK_LEASE_MS, JSON.stringify({ clock: clock, lease: await leaseOf() }))
  clock += 2 * 60 * 1000
  const updated = await rig.api.perform('update', { id: A, note: 'still working' }, asAssignee)
  check('a board-writing action renews the lease', updated.ok === true && (await leaseOf()) === clock + TASK_LEASE_MS, JSON.stringify({ clock: clock, lease: await leaseOf() }))
  snap = await snapshot(rig)
  check('the declared file lock is still held and not expired', snap.locks.some((lock) => lock.taskId === A && lock.expired === false), JSON.stringify(snap.locks))

  await rig.settle()
  snap = await snapshot(rig)
  check('the task is still running after a settle sixteen minutes in', byId(snap, A).status === 'running', JSON.stringify(ids(snap)))
  check('and its file lock is still held sixteen minutes in', snap.locks.some((lock) => lock.taskId === A), JSON.stringify(snap.locks))

  // The host heartbeat: NO tool call at all, but the scheduler extends the lease
  // once it is inside the fixed window.
  clock = Date.parse(byId(snap, A).leaseUntil) - TASK_HEARTBEAT_MS + 1000
  await rig.settle()
  snap = await snapshot(rig)
  const hostRenewed = byId(snap, A)
  check(
    'the host tick renews a valid lease with no tool call at all',
    hostRenewed.status === 'running' && Date.parse(hostRenewed.leaseUntil) === clock + TASK_LEASE_MS,
    JSON.stringify({ leaseUntil: hostRenewed.leaseUntil, clock: clock }),
  )
  check(
    'the host tick renews the file lock together with the lease',
    snap.locks.some((lock) => lock.taskId === A && Date.parse(lock.leaseUntil) === clock + TASK_LEASE_MS),
    JSON.stringify(snap.locks),
  )

  // Leaving running releases the lease: a submit must not carry one into review.
  const B = (await createTask(rig, { title: 'submitted run' })).id
  await rig.settle()
  snap = await snapshot(rig)
  check('a second task is claimed with a lease of its own', byId(snap, B).status === 'running' && byId(snap, B).leaseUntil !== null, JSON.stringify(byId(snap, B).leaseUntil))
  const submitted = await submitAsUser(rig, B, 'done')
  check('submit releases the lease of the task it moves out of running', submitted.ok === true && submitted.task.leaseUntil === null, JSON.stringify(submitted.task && submitted.task.leaseUntil))

  // A lapsed lease whose holder is GONE is a real expiry: the liveness path never
  // revives it, so the task is reaped (dispatch is paused first so the reap is
  // observed instead of an immediate re-dispatch).
  await rig.action('pause')
  const reapRoster = rig.team.roster
  const reapIndex = reapRoster.findIndex((member) => member.name === owner.name)
  const removedHolder = reapIndex >= 0 ? reapRoster.splice(reapIndex, 1)[0] : undefined
  clock = Date.parse(hostRenewed.leaseUntil) + 1
  await rig.settle()
  if (removedHolder !== undefined) reapRoster.push(removedHolder)
  clock = Date.parse(hostRenewed.leaseUntil) + 1
  await rig.settle()
  snap = await snapshot(rig)
  check(
    'a lapsed lease is reaped, never revived by the host heartbeat',
    byId(snap, A).status === 'pending' && byId(snap, A).dispatch.status === 'lease-expired',
    JSON.stringify(byId(snap, A).dispatch),
  )
  check('and the reaped task releases its file lock', snap.locks.length === 0, JSON.stringify(snap.locks))
  rig.scheduler.dispose()
}

// ── T-37 liveness: one live agent per task, handover adopts the checkout ───
// A lapsed lease is not proof the worker is gone: while the holder is alive the
// task stays claimed (never a second agent); when the holder is gone the task is
// handed over, and the next attempt reuses the previous attempt checkout.
{
  // nothingToCommit models an adopted checkout whose only commit is the old one:
  // submit must record that HEAD instead of inventing a new commit.
  const git = createFakeGit({ nothingToCommit: true })
  // A handover needs a replacement: after the old holder is gone the dispatcher
  // spawns the next work agent (the fake team records the spawn).
  const rig = createRig({ git: git, teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'handover', writeFiles: ['scripts/a.gd'] })).id
  await rig.action('start')
  await rig.settle()
  let snap = await snapshot(rig)
  const firstPath = join(PROJECT, '.worktrees', A + '-1')
  const first = byId(snap, A)
  const holder = first.assignee.name
  const session = first.assignee.session
  check('the first attempt runs in its own worktree', first.status === 'running' && first.worktree === firstPath && first.branch === 'task/' + A + '-1', JSON.stringify({ worktree: first.worktree, branch: first.branch }))
  check('and the attempt is recorded with its holder', first.attempts === 1 && first.dispatch.target === holder && first.dispatch.targetId === session, JSON.stringify(first.dispatch))

  // The lease lapses but the holder is still alive: the host extends it. No
  // second worker, no new worktree.
  await patchTask(rig, A, (task) => {
    task.leaseUntil = new Date(Date.now() - 1000).toISOString()
  })
  await rig.settle()
  snap = await snapshot(rig)
  check('a lapsed lease with a live holder keeps the task running', byId(snap, A).status === 'running' && byId(snap, A).attempts === 1, JSON.stringify(ids(snap)))
  check('and its lease is extended past now', Date.parse(byId(snap, A).leaseUntil) > Date.now(), String(byId(snap, A).leaseUntil))
  check('and no second worktree was created', git.calls.filter((call) => call.name === 'worktreeAdd').length === 1, JSON.stringify(git.calls.filter((call) => call.name === 'worktreeAdd')))

  // The host tick may run many times while the holder is alive: still one agent.
  for (let tick = 0; tick < 3; tick += 1) {
    await patchTask(rig, A, (task) => {
      task.leaseUntil = new Date(Date.now() - 1000).toISOString()
    })
    await rig.settle()
  }
  snap = await snapshot(rig)
  check('repeated lapses never dispatch a second agent', byId(snap, A).status === 'running' && byId(snap, A).attempts === 1 && git.calls.filter((call) => call.name === 'worktreeAdd').length === 1, JSON.stringify({ attempts: byId(snap, A).attempts, adds: git.calls.filter((call) => call.name === 'worktreeAdd').length }))

  // The holder dies (gone from the roster) and a commit exists: the task is
  // handed over and the next attempt ADOPTS the attempt-1 checkout.
  await rig.action('pause')
  const roster = rig.team.roster
  const holderIndex = roster.findIndex((member) => member.name === holder)
  const removedHolder = holderIndex >= 0 ? roster.splice(holderIndex, 1)[0] : undefined
  await patchTask(rig, A, (task) => {
    task.commit = 'old-commit-sha'
    task.leaseUntil = new Date(Date.now() - 1000).toISOString()
  })
  await rig.settle()
  snap = await snapshot(rig)
  check('a lapsed lease whose holder is gone is requeued', byId(snap, A).status === 'pending' && byId(snap, A).dispatch.status === 'lease-expired', JSON.stringify(byId(snap, A).dispatch))
  check('and the handover records why it was requeued', String((byId(snap, A).history || []).slice(-1)[0].note).indexOf('assignee gone') >= 0, JSON.stringify((byId(snap, A).history || []).slice(-1)))

  // Restart dispatch: the fresh attempt adopts the old checkout instead of
  // starting over from the target.
  await rig.action('start')
  await rig.settle()
  snap = await snapshot(rig)
  const adopted = byId(snap, A)
  const adds = git.calls.filter((call) => call.name === 'worktreeAdd')
  check('the next attempt is attempt 2', adopted.attempts === 2, String(adopted.attempts))
  check('and it adopts the attempt-1 worktree and branch', adopted.status === 'running' && adopted.worktree === firstPath && adopted.branch === 'task/' + A + '-1', JSON.stringify({ worktree: adopted.worktree, branch: adopted.branch }))
  check('without creating a duplicate worktree', adds.length === 1 && adds[0].detail.path === firstPath, JSON.stringify(adds.map((call) => call.detail.path)))
  check('the checkout keeps the original base so the merge spans the old work', adopted.base === 'base-sha', String(adopted.base))
  check('and the claim says it adopted', adopted.dispatch.via === 'adopt', JSON.stringify(adopted.dispatch))
  check('history records the adoption', (adopted.history || []).some((entry) => String(entry.note).indexOf('adopting task/' + A + '-1') >= 0 && String(entry.note).indexOf('from attempt 1') >= 0), JSON.stringify((adopted.history || []).slice(-1)))

  // The adopted attempt can submit the OLD commit: commitAll has nothing new,
  // and the recorded head is the adopted HEAD, not the target.
  git.head = async function () { return { ok: true, hash: 'old-commit-sha' } }
  const submitted = await submitAsUser(rig, A, 'handover submit')
  check('the adopted attempt submits', submitted.ok === true && submitted.task.merge !== null && submitted.task.merge.status === 'open', JSON.stringify(submitted.ok === true ? submitted.task.merge : submitted))
  check('and the merge request points at the adopted commit', submitted.ok === true && submitted.task.merge.head === 'old-commit-sha' && submitted.task.merge.base === 'base-sha', JSON.stringify(submitted.ok === true ? { base: submitted.task.merge.base, head: submitted.task.merge.head } : submitted))
  if (removedHolder !== undefined) roster.push(removedHolder)
  rig.scheduler.dispose()
}

// ── T-37 hard cap and the single-agent guard ───────────────────────────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'capped' })).id
  await rig.action('start')
  await rig.settle()
  await rig.action('pause')
  // Alive holder, but the attempt started longer ago than the cap allows.
  await patchTask(rig, A, (task) => {
    task.dispatch = Object.assign({}, task.dispatch, { at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() })
    task.leaseUntil = new Date(Date.now() - 1000).toISOString()
  })
  await rig.settle()
  let snap = await snapshot(rig)
  check('a live holder past the liveness cap is handed over anyway', byId(snap, A).status === 'pending', JSON.stringify(ids(snap)))
  check('and the reason names the cap', byId(snap, A).dispatch.error === 'lease expired (liveness cap)', JSON.stringify(byId(snap, A).dispatch))

  // Requirement 4: while the previous holder is alive, no second agent may be
  // dispatched — even if some other pass requeued the task.
  const claimed = (await snapshot(rig)).tasks.filter((task) => task.id === A)[0]
  const previousName = claimed.dispatch.target === null ? 'fixer' : claimed.dispatch.target
  await patchTask(rig, A, (task) => {
    task.status = 'pending'
    task.assignee = null
    task.dispatch = Object.assign({}, task.dispatch, { status: 'lease-expired', error: 'lease expired' })
  })
  await rig.action('start')
  await rig.settle()
  snap = await snapshot(rig)
  check('a live previous holder blocks the next attempt', byId(snap, A).status === 'pending', JSON.stringify(ids(snap)))
  const guard = rig.scheduler.status().lastResults.filter((entry) => entry.id === A && entry.skipped === 'previous-assignee-active')
  check('and the pass says why it skipped', guard.length >= 1, JSON.stringify(rig.scheduler.status().lastResults))
  // Once that holder is gone the task dispatches again.
  const roster = rig.team.roster
  const index = roster.findIndex((member) => member.name === previousName)
  const removed = index >= 0 ? roster.splice(index, 1)[0] : undefined
  await rig.settle()
  snap = await snapshot(rig)
  check('once the previous holder is gone the task runs again', byId(snap, A).status === 'running', JSON.stringify(ids(snap)))
  if (removed !== undefined) roster.push(removed)
  rig.scheduler.dispose()
}

// ── T-37 e2e on the production timer rhythm ────────────────────────────────
// The host ticks forever, so the heartbeat itself must let a dead holder lease
// lapse: these tests step the clock in small increments and NEVER patch
// leaseUntil, which is exactly the probe that exposed the unreachable path.
{
  let clock = 1_700_000_000_000
  const git = createFakeGit()
  const rig = createRig({ git: git, teamOptions: { spawnedStatus: 'running' }, now: () => clock })
  const A = (await createTask(rig, { title: 'dead holder', writeFiles: ['scripts/a.gd'] })).id
  await rig.action('start')
  await rig.settle()
  let snap = await snapshot(rig)
  const claimed = byId(snap, A)
  const firstPath = join(PROJECT, '.worktrees', A + '-1')
  check('the attempt is claimed with a full lease', claimed.status === 'running' && Date.parse(claimed.leaseUntil) === clock + TASK_LEASE_MS, JSON.stringify(claimed.leaseUntil))
  check('and runs in its own checkout', claimed.worktree === firstPath && claimed.branch === 'task/' + A + '-1')
  // The worker dies: it leaves the roster (and a commit) behind.
  const roster = rig.team.roster
  const index = roster.findIndex((member) => member.name === claimed.assignee.name)
  const removed = index >= 0 ? roster.splice(index, 1)[0] : undefined
  await patchTask(rig, A, (task) => {
    task.commit = 'dead-worker-commit'
  })
  let elapsed = 0
  for (let step = 0; step < 90; step += 1) {
    clock += 60 * 1000
    elapsed += 60 * 1000
    await rig.settle()
    const seen = byId(await snapshot(rig), A)
    if (seen.attempts > 1) break
  }
  snap = await snapshot(rig)
  const handedOver = byId(snap, A)
  check('a dead holder loses the task one lease after the claim, on the timer rhythm', handedOver.attempts >= 2 && elapsed <= 65 * 60 * 1000, JSON.stringify({ attempts: handedOver.attempts, minutes: Math.round(elapsed / 60000) }))
  check('and the next attempt adopts the dead attempt checkout', handedOver.status === 'running' && handedOver.worktree === firstPath && handedOver.branch === 'task/' + A + '-1' && handedOver.dispatch.via === 'adopt', JSON.stringify({ status: handedOver.status, worktree: handedOver.worktree, branch: handedOver.branch, via: handedOver.dispatch.via }))
  check('with exactly one worktree add for the whole handover', git.calls.filter((call) => call.name === 'worktreeAdd').length === 1, JSON.stringify(git.calls.filter((call) => call.name === 'worktreeAdd').map((call) => call.detail.path)))
  check('and history records the gone holder', (handedOver.history || []).some((entry) => String(entry.note).indexOf('assignee gone') >= 0), JSON.stringify((handedOver.history || []).slice(-3)))
  if (removed !== undefined) roster.push(removed)
  rig.scheduler.dispose()
}

// A live holder is never renewed past the cap: its lease lapses into a handover.
{
  let clock = 1_700_000_000_000
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' }, now: () => clock })
  const A = (await createTask(rig, { title: 'capped holder' })).id
  await rig.action('start')
  await rig.settle()
  await patchTask(rig, A, (task) => {
    task.dispatch = Object.assign({}, task.dispatch, { at: new Date(clock - 5 * 60 * 60 * 1000).toISOString() })
  })
  let elapsed = 0
  for (let step = 0; step < 130; step += 1) {
    clock += 60 * 1000
    elapsed += 60 * 1000
    await rig.settle()
    const seen = byId(await snapshot(rig), A)
    if (seen.attempts > 1) break
  }
  const snap = await snapshot(rig)
  const capped = byId(snap, A)
  const history = capped.history || []
  check(
    'a live holder past the cap is not renewed and is handed over',
    capped.attempts >= 2 && history.some((entry) => String(entry.note).indexOf('past the liveness cap') >= 0) && elapsed <= 65 * 60 * 1000,
    JSON.stringify({ attempts: capped.attempts, minutes: Math.round(elapsed / 60000), tail: history.slice(-2) }),
  )
  rig.scheduler.dispose()
}

// A claim without a readable start time cannot be capped, so a live holder keeps
// its lease (the fallback must not cap at zero).
{
  let clock = 1_700_000_000_000
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' }, now: () => clock })
  const A = (await createTask(rig, { title: 'no claim time' })).id
  await rig.action('start')
  await rig.settle()
  await patchTask(rig, A, (task) => {
    task.dispatch = Object.assign({}, task.dispatch, { at: null })
  })
  // Walk past the heartbeat window: the live holder must still be renewed.
  for (let step = 0; step < 56; step += 1) {
    clock += 60 * 1000
    await rig.settle()
  }
  const noClaim = byId(await snapshot(rig), A)
  check('a task without a claim time is never capped and keeps its lease', noClaim.status === 'running' && noClaim.attempts === 1 && Date.parse(noClaim.leaseUntil) > clock, JSON.stringify({ status: noClaim.status, attempts: noClaim.attempts, lease: noClaim.leaseUntil }))
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
  check('the spawned worker submits under its session', submitted.ok === true && submitted.task.status === 'reviewing', JSON.stringify(submitted))
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

// ── mandatory worktrees at claim time ──────────────────────────────────────
// A fake git that answers like a clean repository; every call is recorded so a
// test can assert the exact command and cwd without starting git.
function fakeRunner(replies) {
  const calls = []
  const run = (args, cwd) => {
    calls.push({ args: args.slice(), cwd: cwd })
    const key = args.join(' ')
    if (replies !== undefined && replies[key] !== undefined) return replies[key](args, cwd)
    if (key === 'rev-parse --is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
    if (key === 'status --porcelain') return { code: 0, stdout: '', stderr: '' }
    if (key === 'rev-parse HEAD') return { code: 0, stdout: 'base-sha\n', stderr: '' }
    if (key === 'branch --show-current') return { code: 0, stdout: 'main\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  run.calls = calls
  return run
}

/** A rig like createRig, with the git/subprocess seam resolved the way
 * index.mjs resolves it: one facade shared by the dispatcher and the API. */
function createWorktreeRig(options) {
  const opts = options === undefined ? {} : options
  const fs = createFakeFs()
  fs.dirs.add(PROJECT)
  const team = createTeam(opts.teamOptions)
  const ctx = {
    fs,
    sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
    get(key) {
      if (key === 'agents') return { list: () => [{ id: 'session-lead' }] }
      if (key === 'agentTeams') return team
      if (key === 'subagents') return { list: () => ['spawn'] }
      if (key === 'subprocess') return opts.subprocess
      return undefined
    },
  }
  const state = createState(ctx)
  const git = opts.git === undefined ? gitFor(ctx) : opts.git
  const scheduler = createDispatcher(ctx, {
    state: state,
    projectPath: () => PROJECT,
    allowSpawn: opts.allowSpawn !== false,
    git: git,
  })
  const api = createApi(ctx, { state: state, scheduler: scheduler, git: git })
  const user = { projectPath: PROJECT, by: '@user', role: 'user', agent: null }
  return {
    project: PROJECT,
    fs: fs,
    team: team,
    state: state,
    scheduler: scheduler,
    api: api,
    git: git,
    action: (name, body) => api.perform(name, body === undefined ? {} : body, user),
    settle: () => scheduler.settle(PROJECT),
  }
}

// a clean git repository is the normal path: the task gets a worktree
{
  const run = fakeRunner()
  const rig = createWorktreeRig({ git: createGit({ run: run }) })
  const task = await createTask(rig, { title: 'worktree task', writeFiles: ['scripts/a.gd'] })
  const started = await rig.action('start')
  check('dispatch starts when the project can host a worktree', started.ok === true && started.dispatch.state === 'running', JSON.stringify(started))
  await rig.settle()
  const branch = 'task/' + task.id + '-1'
  const path = join(PROJECT, '.worktrees', task.id + '-1')
  let snap = await snapshot(rig)
  let claimed = byId(snap, task.id)
  check('the task runs in its own worktree', claimed.status === 'running' && claimed.worktree === path, JSON.stringify({ status: claimed.status, worktree: claimed.worktree }))
  check(
    'and records the base commit, target branch and task branch',
    claimed.base === 'base-sha' && claimed.target === 'main' && claimed.branch === branch,
    JSON.stringify({ base: claimed.base, target: claimed.target, branch: claimed.branch }),
  )
  check('the claim keeps the worktree', claimed.dispatch.keep === true, JSON.stringify(claimed.dispatch))
  check('there is no worktree failure to report', claimed.worktreeError === null, String(claimed.worktreeError))
  check('the worktree stays inside the project', typeof claimed.worktree === 'string' && claimed.worktree.indexOf(PROJECT) === 0, String(claimed.worktree))
  const adds = run.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add')
  check(
    'git created the task branch from the base commit',
    adds.length === 1 && adds[0].args.join(' ') === ['worktree', 'add', '-b', branch, path, 'base-sha'].join(' ') && adds[0].cwd === PROJECT,
    JSON.stringify(adds.map((call) => call.args)),
  )
  const brief = rig.team.calls[0].text
  check(
    'the brief names the worktree, its branch and its base',
    brief.indexOf(path) >= 0 && brief.indexOf(branch) >= 0 && brief.indexOf('base-sha') >= 0,
    brief.slice(0, 500),
  )
  check('the brief says to edit and test only there', /ONLY inside that worktree/i.test(brief) && /run the tests there/i.test(brief), brief.slice(0, 500))
  check('the brief points task_center back at the main project', brief.indexOf('main project') >= 0 && brief.indexOf(PROJECT) >= 0, brief.slice(0, 500))
  await rig.action('submit', { id: task.id, evidence: 'done' })
  snap = await snapshot(rig)
  claimed = byId(snap, task.id)
  check('a submitted task keeps its worktree for the merge request', claimed.status === 'reviewing' && claimed.worktree === path, JSON.stringify({ status: claimed.status, worktree: claimed.worktree }))
  check(
    'and submit records an open merge request from that worktree',
    claimed.commit !== null && claimed.merge !== null && claimed.merge.status === 'open' && claimed.merge.base === 'base-sha',
    JSON.stringify({ commit: claimed.commit, merge: claimed.merge }),
  )
  check('the scheduler never removes it', run.calls.every((call) => call.args[0] !== 'worktree' || call.args[1] !== 'remove'), JSON.stringify(run.calls.map((call) => call.args)))
  rig.scheduler.dispose()
}

// no git service: dispatch refuses to start, nothing runs in the shared tree
{
  const rig = createWorktreeRig({ git: null })
  const task = await createTask(rig, { title: 'no git service task' })
  const started = await rig.action('start')
  check('start refuses without a git service', started.ok === false && started.code === 'worktree-unavailable', JSON.stringify(started))
  check('and names the missing worktree capability', started.worktree === 'no-git-service', JSON.stringify(started))
  await rig.settle()
  const snap = await snapshot(rig)
  check('dispatch stays paused', snap.dispatch.state === 'paused', JSON.stringify(snap.dispatch))
  check('the task stays pending', byId(snap, task.id).status === 'pending', JSON.stringify(ids(snap)))
  rig.scheduler.dispose()
}

// a project that is not a git repository cannot start dispatch
{
  const rig = createWorktreeRig({ git: createFakeGit({ repo: false }) })
  const task = await createTask(rig, { title: 'not a repo task' })
  const started = await rig.action('start')
  check('start refuses a non-repository project', started.ok === false && started.code === 'worktree-unavailable', JSON.stringify(started))
  check('and explains it is not a git repository', started.worktree === 'not-a-git-repository', JSON.stringify(started))
  await rig.settle()
  const snap = await snapshot(rig)
  check('nothing was claimed', byId(snap, task.id).status === 'pending' && snap.dispatch.state === 'paused', JSON.stringify(ids(snap)))
  check('and no worktree was added', rig.git.calls.filter((call) => call.name === 'worktreeAdd').length === 0, JSON.stringify(rig.git.calls))
  rig.scheduler.dispose()
}

// a dirty working tree cannot start dispatch
{
  const rig = createWorktreeRig({ git: createFakeGit({ clean: false }) })
  const task = await createTask(rig, { title: 'dirty tree task' })
  const started = await rig.action('start')
  check('start refuses a dirty working tree', started.ok === false && started.code === 'worktree-unavailable', JSON.stringify(started))
  check('and says the tree is dirty', started.worktree === 'dirty-worktree', JSON.stringify(started))
  await rig.settle()
  const snap = await snapshot(rig)
  check('the dirty tree keeps every task pending', byId(snap, task.id).status === 'pending' && snap.dispatch.state === 'paused', JSON.stringify(ids(snap)))
  check('and no worktree was added', rig.git.calls.filter((call) => call.name === 'worktreeAdd').length === 0, JSON.stringify(rig.git.calls))
  rig.scheduler.dispose()
}

// a refused worktree add at claim time pauses dispatch instead of falling back
{
  const git = createFakeGit({ addFails: true })
  const rig = createWorktreeRig({ git: git })
  const task = await createTask(rig, { title: 'refused add task', writeFiles: ['scripts/a.gd'] })
  const started = await rig.action('start')
  check('start accepts a clean repository', started.ok === true, JSON.stringify(started))
  await rig.settle()
  let snap = await snapshot(rig)
  const claimed = byId(snap, task.id)
  check('a refused add does not dispatch into the shared tree', claimed.status === 'pending' && claimed.worktree === null, JSON.stringify({ status: claimed.status, worktree: claimed.worktree }))
  check('and records the worktree failure on the task', String(claimed.worktreeError).indexOf('worktree-add-failed') === 0, String(claimed.worktreeError))
  check('dispatch pauses instead of retrying every tick', snap.dispatch.state === 'paused', JSON.stringify(snap.dispatch))
  check('the file locks taken for the attempt are released', snap.locks.length === 0, JSON.stringify(snap.locks))
  check('the scheduler reports the refusal', String(rig.scheduler.status().lastError).indexOf('worktree refused') >= 0, String(rig.scheduler.status().lastError))
  const addCall = git.calls.filter((call) => call.name === 'worktreeAdd')[0]
  const removeCall = git.calls.filter((call) => call.name === 'worktreeRemove')[0]
  const attemptedPath = join(PROJECT, '.worktrees', task.id + '-1')
  check('the refused add targets the attempt-specific directory', addCall !== undefined && addCall.detail.path === attemptedPath, JSON.stringify(addCall && addCall.detail))
  check('and the half-worktree cleanup targets the same directory', removeCall !== undefined && removeCall.detail === attemptedPath, JSON.stringify(removeCall && removeCall.detail))
  const adds = git.calls.filter((call) => call.name === 'worktreeAdd').length
  await rig.settle()
  await rig.settle()
  check('a paused dispatcher does not retry the worktree', git.calls.filter((call) => call.name === 'worktreeAdd').length === adds, String(git.calls.filter((call) => call.name === 'worktreeAdd').length))
  rig.scheduler.dispose()
}

// after the environment is fixed, start works again
{
  const git = createFakeGit()
  let addFails = true
  const attempted = []
  const realAdd = git.worktreeAdd
  git.worktreeAdd = function (root, input) {
    attempted.push(input)
    if (addFails) return Promise.resolve({ ok: false, code: 'worktree-add-failed', message: 'boom' })
    return realAdd.call(git, root, input)
  }
  const rig = createWorktreeRig({ git: git })
  const task = await createTask(rig, { title: 'fixable task' })
  await rig.action('start')
  await rig.settle()
  let snap = await snapshot(rig)
  check('the first attempt pauses dispatch', snap.dispatch.state === 'paused' && byId(snap, task.id).status === 'pending', JSON.stringify(ids(snap)))
  // T-43: a refused add is cleaned up and retried once inside the same tick, so
  // the pause only happens after TWO failures on the same directory.
  check(
    'the refused add is retried once in the same tick',
    attempted.length === 2 && attempted[0].path === attempted[1].path,
    JSON.stringify(attempted.map((entry) => entry.path)),
  )
  addFails = false
  const restarted = await rig.action('start')
  check('start works again once the environment is fixed', restarted.ok === true, JSON.stringify(restarted))
  await rig.settle()
  snap = await snapshot(rig)
  const retried = byId(snap, task.id)
  const firstPath = join(PROJECT, '.worktrees', task.id + '-1')
  check('the retry runs in a worktree', retried.status === 'running' && typeof retried.worktree === 'string', JSON.stringify(retried.worktree))
  check(
    'a pre-claim refusal does not consume an attempt, so the retry reuses attempt 1',
    attempted.length === 3 && attempted.every((entry) => entry.path === firstPath) && retried.branch === 'task/' + task.id + '-1',
    JSON.stringify(attempted.map((entry) => entry.path)),
  )
  check('and records the attempt-1 directory', retried.worktree === firstPath, String(retried.worktree))
  check('the failure reason is cleared on the new attempt', retried.worktreeError === null, String(retried.worktreeError))
  rig.scheduler.dispose()
}

// ── T-43 worktree creation: own budget, rollback, one retry, serialisation ──
// The T-41 incident: a concurrent `git worktree add` was killed by the generic
// 60 s runner timeout, left a registered LOCKED checkout, and the scheduler
// paused with no cleanup and no retry. These cases pin the recovery path.
{
  const git = createFakeGit()
  const trace = []
  const realAdd = git.worktreeAdd
  const realRemove = git.worktreeRemove
  let adds = 0
  git.worktreeAdd = async function (root, input) {
    adds += 1
    trace.push(adds === 1 ? 'add:timeout' : 'add:ok')
    if (adds === 1) return { ok: false, code: 'worktree-add-failed', message: 'git worktree add failed (budget 180000ms): timed out after 180000ms' }
    return realAdd.call(git, root, input)
  }
  git.worktreeRemove = async function (root, path) {
    trace.push('remove')
    return realRemove.call(git, root, path)
  }
  git.worktreeUnlock = async function () {
    trace.push('unlock')
    return { ok: true, unlocked: true }
  }
  git.deleteBranch = async function () {
    trace.push('branch-delete')
    return { ok: true }
  }
  git.worktreePrune = async function () {
    trace.push('prune')
    return { ok: true, pruned: [] }
  }
  const rig = createRig({ git: git })
  const task = await createTask(rig, { title: 'timed out once', writeFiles: ['scripts/a.gd'] })
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  const entry = byId(snap, task.id)
  check('a timed-out add is cleaned up and retried instead of pausing', entry.status === 'running' && snap.dispatch.state === 'running', JSON.stringify({ status: entry.status, dispatch: snap.dispatch.state }))
  check('the rollback unlocks, removes, deletes the branch and prunes before the retry', trace.join(',') === 'add:timeout,unlock,remove,branch-delete,prune,add:ok', JSON.stringify(trace))
  check('and the retry lands in the same attempt directory and branch', entry.worktree === join(PROJECT, '.worktrees', task.id + '-1') && entry.branch === 'task/' + task.id + '-1', JSON.stringify({ worktree: entry.worktree, branch: entry.branch }))
  check('no worktree error is left on the running task', entry.worktreeError === null, String(entry.worktreeError))
  rig.scheduler.dispose()
}

// A hanging git never settles: the scheduler deadline bounds it, the attempt is
// rolled back twice and only then does dispatch pause — with a readable note.
{
  const git = createFakeGit()
  const calls = []
  git.worktreeAdd = async function () {
    calls.push('add')
    return new Promise(() => {})
  }
  git.worktreeRemove = async function (root, path) {
    calls.push('remove')
    return { ok: true, path: path }
  }
  git.worktreeUnlock = async function () {
    calls.push('unlock')
    return { ok: true, unlocked: true }
  }
  git.deleteBranch = async function () {
    calls.push('branch-delete')
    return { ok: true }
  }
  git.worktreePrune = async function () {
    calls.push('prune')
    return { ok: true, pruned: [] }
  }
  const rig = createRig({ git: git, worktreeDeadlineMs: 40 })
  const task = await createTask(rig, { title: 'hanging add' })
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  const entry = byId(snap, task.id)
  check('a hanging worktree add is bounded by the deadline and pauses dispatch', snap.dispatch.state === 'paused' && entry.status === 'pending', JSON.stringify(ids(snap)))
  const note = String(entry.worktreeError)
  check('the note names the path, the command result, both attempts and the cleanup', note.indexOf('2 attempts') >= 0 && note.indexOf('.worktrees') >= 0 && note.indexOf('did not finish within') >= 0 && note.indexOf('cleanup:') >= 0, note)
  check('and the percent-elapsed time is recorded', /\d+ms/.test(note), note)
  check('the rollback ran for both attempts', calls.filter((value) => value === 'unlock').length === 2 && calls.filter((value) => value === 'prune').length === 2, JSON.stringify(calls))
  check('and nothing is reported as left behind', note.indexOf('leftovers: none') >= 0, note)
  rig.scheduler.dispose()
}

// The per-repository queue: concurrent creates never overlap, and a failure does
// not poison the next one.
{
  const order = []
  let running = 0
  let peak = 0
  const work = (name) => async () => {
    running += 1
    peak = Math.max(peak, running)
    order.push('start:' + name)
    await sleep(15)
    order.push('end:' + name)
    running -= 1
    return name
  }
  const results = await Promise.all([
    serialiseWorktreeCreate(PROJECT, work('a')),
    serialiseWorktreeCreate(PROJECT, work('b')),
    serialiseWorktreeCreate(PROJECT, work('c')),
  ])
  check('worktree creates for one repository are serialised in order', peak === 1 && order.join(',') === 'start:a,end:a,start:b,end:b,start:c,end:c', JSON.stringify({ order: order, peak: peak }))
  check('and every caller still gets its own result', results.join(',') === 'a,b,c', JSON.stringify(results))
  const rejected = await serialiseWorktreeCreate(PROJECT, async () => { throw new Error('boom') }).then(() => 'resolved', () => 'rejected')
  const afterFailure = await serialiseWorktreeCreate(PROJECT, async () => 'after')
  check('a failed create does not poison the next one for that repository', rejected === 'rejected' && afterFailure === 'after', JSON.stringify({ rejected: rejected, after: afterFailure }))
  // Independent repositories are not blocked by each other.
  const otherOrder = []
  await Promise.all([
    serialiseWorktreeCreate('/repo/one', async () => {
      otherOrder.push('one:start')
      await sleep(20)
      otherOrder.push('one:end')
    }),
    serialiseWorktreeCreate('/repo/two', async () => {
      otherOrder.push('two:start')
      otherOrder.push('two:end')
    }),
  ])
  check('two repositories do not queue behind each other', otherOrder.join(',') === 'one:start,two:start,two:end,one:end', JSON.stringify(otherOrder))
}

// a retry after a CLAIMED attempt gets its own directory instead of colliding
{
  const git = createFakeGit()
  const rig = createRig({ allowSpawn: false, git: git })
  const task = await createTask(rig, { title: 'retried after delivery' })
  const firstPath = join(PROJECT, '.worktrees', task.id + '-1')
  // A claimed attempt 1 that failed delivery: the board keeps its worktree and
  // its attempt count — exactly the state that used to collide on retry.
  await patchTask(rig, task.id, (entry) => {
    entry.attempts = 1
    entry.worktree = firstPath
    entry.branch = 'task/' + task.id + '-1'
  })
  await rig.action('start')
  const snap = await snapshot(rig)
  const retried = byId(snap, task.id)
  const secondPath = join(PROJECT, '.worktrees', task.id + '-2')
  const adds = git.calls.filter((call) => call.name === 'worktreeAdd').map((call) => call.detail.path)
  check('the retry is attempt 2', retried.attempts === 2, String(retried.attempts))
  check(
    'the retry runs in the attempt-2 worktree',
    retried.status === 'running' && retried.worktree === secondPath,
    JSON.stringify({ status: retried.status, worktree: retried.worktree }),
  )
  check('with the matching attempt-2 branch', retried.branch === 'task/' + task.id + '-2', String(retried.branch))
  check(
    'attempt 1 and attempt 2 use different worktree directories',
    adds.length === 1 && adds[0] === secondPath && firstPath !== secondPath,
    JSON.stringify({ first: firstPath, adds: adds }),
  )
  check(
    'the old attempt-1 worktree is left untouched',
    git.calls.filter((call) => call.name === 'worktreeRemove').length === 0,
    JSON.stringify(git.calls.filter((call) => call.name === 'worktreeRemove')),
  )
  rig.scheduler.dispose()
}

// a git facade that throws mid-preparation is a refusal, never a fallback
{
  const git = createFakeGit()
  git.head = async () => {
    throw new Error('head exploded')
  }
  const rig = createWorktreeRig({ git: git })
  const task = await createTask(rig, { title: 'throwing git task' })
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  const claimed = byId(snap, task.id)
  check('a throwing git facade keeps the task pending', claimed.status === 'pending' && snap.dispatch.state === 'paused', JSON.stringify({ status: claimed.status, state: snap.dispatch.state }))
  check(
    'and records the worktree error',
    String(claimed.worktreeError).indexOf('worktree-error') === 0 && String(claimed.worktreeError).indexOf('head exploded') >= 0,
    String(claimed.worktreeError),
  )
  rig.scheduler.dispose()
}

// the production path: git runs through ctx.get('subprocess'), one facade
{
  const spawns = []
  const subprocess = {
    async resolveExecutable(name) {
      return name === 'git' ? 'C:\\tools\\git.exe' : name
    },
    spawn(config) {
      spawns.push(config)
      const args = config.argv.slice(1)
      const key = args.join(' ')
      let stdout = ''
      if (key === 'rev-parse --is-inside-work-tree') stdout = 'true\n'
      else if (key === 'rev-parse HEAD') stdout = 'base-sha\n'
      else if (key === 'branch --show-current') stdout = 'main\n'
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  }
  const rig = createWorktreeRig({ subprocess: subprocess })
  const task = await createTask(rig, { title: 'subprocess task' })
  const started = await rig.action('start')
  check('start goes through the subprocess git runner', started.ok === true, JSON.stringify(started))
  await rig.settle()
  const claimed = byId(await snapshot(rig), task.id)
  const path = join(PROJECT, '.worktrees', task.id + '-1')
  check('the subprocess service is the git runner', claimed.worktree === path, String(claimed.worktree))
  check(
    'every git call is one unconfined spawn in the project',
    spawns.length >= 6 && spawns.every((config) => config.argv[0] === 'C:\\tools\\git.exe' && config.cwd === PROJECT),
    JSON.stringify(spawns.map((config) => config.argv.slice(0, 3))),
  )
  check(
    'the spawn collects stdout and stderr',
    spawns.every((config) => config.stdio.stdout.collect !== undefined && config.stdio.stderr.collect !== undefined),
    JSON.stringify(spawns[0] && spawns[0].stdio),
  )
  rig.scheduler.dispose()
}

// a leftover enabled flag is ignored: worktrees are not optional any more
{
  const run = fakeRunner()
  const rig = createWorktreeRig({ git: createGit({ run: run }) })
  const written = await updateBoard(
    { fs: rig.fs },
    {
      projectPath: PROJECT,
      sandboxPolicy: writePolicyFor(PROJECT),
      mutate: (board) => {
        board.dispatch = Object.assign({}, board.dispatch, { worktree: { enabled: false, root: '.worktrees' } })
        return board
      },
    },
  )
  check('the legacy board write succeeds', written.ok === true, JSON.stringify(written))
  const task = await createTask(rig, { title: 'legacy flag task' })
  const started = await rig.action('start')
  check('a leftover enabled=false no longer disables worktrees', started.ok === true, JSON.stringify(started))
  await rig.settle()
  const snap = await snapshot(rig)
  const claimed = byId(snap, task.id)
  check(
    'the task still runs in an attempt-specific worktree',
    claimed.status === 'running' && claimed.worktree === join(PROJECT, '.worktrees', task.id + '-1'),
    String(claimed.worktree),
  )
  check('the dispatch record no longer carries an enabled flag', snap.dispatch.worktree.enabled === undefined && snap.dispatch.worktree.root === '.worktrees', JSON.stringify(snap.dispatch.worktree))
  rig.scheduler.dispose()
}

// ── the dedicated merger is never a feature worker ─────────────────────────
{
  const rig = createRig({
    allowSpawn: false,
    teamOptions: {
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-merger', name: 'merger', role: 'teammate', status: 'inactive' },
      ],
    },
  })
  const A = (await createTask(rig, { title: 'merger only' })).id
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  check('a team whose only idle teammate is the merger dispatches nothing', byId(snap, A).status === 'pending', JSON.stringify(ids(snap)))
  check('and the merger is never handed feature work', rig.team.calls.length === 0, JSON.stringify(rig.team.calls))
  rig.scheduler.dispose()
}

{
  const rig = createRig({
    allowSpawn: false,
    teamOptions: {
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-merger', name: 'merger', role: 'teammate', status: 'inactive' },
        { id: 'session-idle', name: 'fixer', role: 'teammate', status: 'inactive' },
      ],
    },
  })
  const A = (await createTask(rig, { title: 'fixer takes it' })).id
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  const task = byId(snap, A)
  check('a feature task goes to the ordinary worker', task.status === 'running' && task.assignee.name === 'fixer', JSON.stringify(task.assignee))
  check('and the merger is not chosen', rig.team.calls.every((call) => call.target !== 'merger'), JSON.stringify(rig.team.calls))
  rig.scheduler.dispose()
}

// ── role registry: profiles, stage bindings, briefs, provisioning ──────────
function createRoleRig(options) {
  const opts = options === undefined ? {} : options
  const fs = createFakeFs()
  fs.dirs.add(PROJECT)
  const team =
    opts.team === undefined
      ? createTeam({
          roster: [
            { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
            { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
          ],
          spawnThrows: opts.spawnThrows === true,
        })
      : opts.team
  const agents = opts.agents === undefined ? { list: () => [{ id: 'session-lead' }] } : opts.agents
  const ctx = {
    fs: fs,
    sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
    get(key) {
      if (key === 'agents') return agents
      if (key === 'agentTeams') return team
      if (key === 'subagents') return { list: () => ['spawn'] }
      return undefined
    },
  }
  return { fs: fs, team: team, ctx: ctx, manager: createRoleManager(ctx) }
}

function roleTask(overrides) {
  const stamp = new Date().toISOString()
  return Object.assign(
    {
      id: 'T-1',
      title: 'Role task',
      status: 'reviewing',
      priority: 0,
      dependsOn: [],
      writeFiles: ['scripts/a.gd'],
      base: 'base-sha',
      target: 'feat/task-center-v2',
      branch: 'task/T-1-1',
      worktree: join(PROJECT, '.worktrees', 'T-1'),
      commit: 'head-sha',
      actualFiles: ['scripts/a.gd'],
      requiredRole: null,
      merge: null,
      assignee: { name: 'work-T-1-1', session: 'session-work-T-1-1' },
      attempts: 1,
      maxAttempts: 3,
      review: { status: 'pending', by: '@work', at: stamp, reasons: null, attempt: 1 },
      test: null,
      dispatch: null,
      leaseUntil: null,
      createdBy: '@me',
      createdAt: stamp,
      updatedAt: stamp,
      spec: 'Do the thing',
      acceptance: 'The thing works',
      evidence: '',
      history: [],
    },
    overrides === undefined ? {} : overrides,
  )
}

{
  const config = defaultRoleConfig()
  check(
    'the built-in registry has worker/reviewer/tester',
    config.profiles.worker !== undefined && config.profiles.reviewer !== undefined && config.profiles.tester !== undefined,
    Object.keys(config.profiles).join(','),
  )
  check('each default role has one instance', config.profiles.worker.instances === 1 && config.profiles.reviewer.instances === 1 && config.profiles.tester.instances === 1)
  check(
    'stages bind implement to worker, review to reviewer, test to tester',
    config.stages.implement === 'worker' && config.stages.review === 'reviewer' && config.stages.test === 'tester',
    JSON.stringify(config.stages),
  )
  check('the default profile is worker', config.defaultProfile === 'worker', config.defaultProfile)
  const partial = normaliseRoleConfig({ defaultProfile: 'tester', profiles: { reviewer: { instances: 3, skills: ['dsh-plugin-workflow', 'dsh-plugin-workflow', ''] } } })
  check(
    'a partial config repairs around the defaults',
    partial.profiles.worker.instances === 1 && partial.profiles.reviewer.instances === 3 && partial.profiles.tester.stage === 'test',
    JSON.stringify(partial.profiles),
  )
  check('skill lists are deduplicated and trimmed', partial.profiles.reviewer.skills.join(',') === 'dsh-plugin-workflow', JSON.stringify(partial.profiles.reviewer.skills))
  check('instances are clamped to the limit', normaliseRoleConfig({ profiles: { worker: { instances: 99 } } }).profiles.worker.instances === 8)
  check('the default profile accepts a known role only', partial.defaultProfile === 'tester' && normaliseRoleConfig({ defaultProfile: 'nobody' }).defaultProfile === 'worker')
}

{
  check('role slot names map to kinds', roleKindOf('reviewer-1') === 'reviewer' && roleKindOf('tester-12') === 'tester' && roleKindOf('worker-2') === 'worker')
  check('feature workers and the merger are not role slots', isRoleName('work-T-1-1') === false && isRoleName('merger') === false && isRoleName('reviewer') === false)
  const task = roleTask()
  const config = normaliseRoleConfig({ profiles: { reviewer: { skills: ['dsh-plugin-workflow'] } } })
  const reviewer = roleBriefFor('reviewer', task, config, { projectPath: PROJECT, leadName: 'lead' })
  check('the reviewer brief names the role and stage', reviewer.indexOf('Task center role: reviewer') >= 0 && reviewer.indexOf('Stage: review') >= 0, reviewer)
  check(
    'the reviewer brief carries spec, acceptance, worktree and branch',
    reviewer.indexOf('Do the thing') >= 0 && reviewer.indexOf('The thing works') >= 0 && reviewer.indexOf(join(PROJECT, '.worktrees', 'T-1')) >= 0 && reviewer.indexOf('task/T-1-1') >= 0,
    reviewer,
  )
  check(
    'the reviewer brief states the read-only boundary',
    reviewer.indexOf('READ-ONLY') >= 0 && reviewer.indexOf('do NOT edit files') >= 0 && reviewer.indexOf('do NOT commit') >= 0,
    reviewer,
  )
  check(
    'the reviewer brief carries the verdict schema',
    reviewer.indexOf('approveReview') >= 0 && reviewer.indexOf('requestChanges') >= 0 && reviewer.indexOf('reasons') >= 0,
    reviewer,
  )
  check('the reviewer brief requires a fresh independent context', reviewer.indexOf('FRESH') >= 0 && reviewer.indexOf('independent') >= 0, reviewer)
  check('the reviewer brief references the configured skill', reviewer.indexOf('dsh-plugin-workflow') >= 0, reviewer)
  const tester = roleBriefFor('tester', task, config, {})
  check('the tester brief carries the test verdict schema', tester.indexOf('passTest') >= 0 && tester.indexOf('failTest') >= 0 && tester.indexOf('evidence') >= 0, tester)
  const worker = roleBriefFor('worker', roleTask({ status: 'running', review: { status: 'changes-requested', by: 'reviewer-1', at: new Date().toISOString(), reasons: 'rename it', attempt: 1 } }), config, {})
  check('the worker brief forbids self-review', worker.indexOf('must NOT approve') >= 0, worker)
  check('a rework brief keeps the same worktree/context', worker.indexOf('REWORK') >= 0 && worker.indexOf('SAME worktree') >= 0 && worker.indexOf('SAME context') >= 0, worker)
}

// ── role prompt templates: variable substitution and fixed sections ────────
{
  const templated = 'Handle {{TASK_ID}} "{{TASK_TITLE}}".\nSpec: {{SPEC}}\nDone: {{COMPLETIONS_DEF}}\nGit: {{GIT_INFO}}\n{{PROJECT}} · {{LEAD}} · {{ROLE}}/{{STAGE}}\nObject: {{TEMPLATE_COPY_ATTEMPT}}'
  const config = normaliseRoleConfig({ profiles: { reviewer: { prompt: templated } } })
  const task = roleTask({
    spec: 'Implement X',
    acceptance: 'X works',
    branch: 'task/T-1-1',
    worktree: join(PROJECT, '.worktrees', 'T-1'),
    commit: 'abc1234',
    base: 'base-sha',
  })
  const brief = roleBriefFor('reviewer', task, config, { projectPath: PROJECT, leadName: 'lead' })
  check(
    'template variables resolve to the real task values',
    brief.indexOf('Handle T-1 "Role task".') >= 0 && brief.indexOf('Spec: Implement X') >= 0 && brief.indexOf('Done: X works') >= 0,
    brief.slice(0, 700),
  )
  check(
    'GIT_INFO carries branch, worktree, base and commit',
    brief.indexOf('branch task/T-1-1') >= 0 && brief.indexOf('commit abc1234') >= 0 && brief.indexOf('base base-sha') >= 0 && brief.indexOf(join(PROJECT, '.worktrees', 'T-1')) >= 0,
    brief.slice(0, 700),
  )
  check('PROJECT, LEAD, ROLE and STAGE resolve', brief.indexOf(PROJECT + ' · lead · reviewer/review') >= 0, brief.slice(0, 700))
  check('the template output sits under the profile instructions section', brief.indexOf('Profile instructions:') >= 0, brief.slice(0, 700))
  check('an unknown variable stays literal at dispatch time (a legacy file keeps working)', brief.indexOf('{{TEMPLATE_COPY_ATTEMPT}}') >= 0, brief.slice(0, 900))
  check(
    'the fixed sections still come from the host brief',
    brief.indexOf('Task center role: reviewer') >= 0 &&
      brief.indexOf('Permission boundary (hard):') >= 0 &&
      brief.indexOf('READ-ONLY') >= 0 &&
      brief.indexOf('Verdict schema:') >= 0 &&
      brief.indexOf('FRESH') >= 0,
    brief,
  )
  check(
    'a custom template never adds or rewrites a host Duties paragraph',
    roleBriefSections('reviewer', task, config, { projectPath: PROJECT, leadName: 'lead' }).fixed.indexOf('Duties:') < 0 &&
      brief.indexOf('Permission boundary (hard):') >= 0 &&
      brief.indexOf('Verdict schema:') >= 0,
    brief.slice(0, 400),
  )
  // The reviewer/tester working instructions moved out of the host-fixed part and
  // into the built-in profile prompt, so the panel can read and fork them.
  const builtinReviewer = roleBriefSections('reviewer', roleTask(), defaultRoleConfig(), { projectPath: PROJECT, leadName: 'lead' })
  check(
    'the built-in reviewer prompt carries the duties while the fixed part keeps only boundary and verdict',
    builtinReviewer.template === DEFAULT_ROLE_PROMPTS.reviewer &&
      builtinReviewer.templateRendered.indexOf('review the submitted tree') >= 0 &&
      builtinReviewer.fixed.indexOf('Duties:') < 0 &&
      builtinReviewer.fixed.indexOf('Permission boundary (hard):') >= 0 &&
      builtinReviewer.fixed.indexOf('Verdict schema:') >= 0,
    JSON.stringify({ fixed: builtinReviewer.fixed.slice(0, 120), template: builtinReviewer.template.slice(0, 60) }),
  )
  const builtinTester = roleBriefSections('tester', roleTask(), defaultRoleConfig(), { projectPath: PROJECT, leadName: 'lead' })
  check(
    'the built-in tester prompt carries the duties while the fixed part keeps only boundary and verdict',
    builtinTester.template === DEFAULT_ROLE_PROMPTS.tester &&
      builtinTester.templateRendered.indexOf('independently test the candidate tree') >= 0 &&
      builtinTester.fixed.indexOf('Duties:') < 0 &&
      builtinTester.fixed.indexOf('Permission boundary (hard):') >= 0 &&
      builtinTester.fixed.indexOf('Verdict schema:') >= 0,
    JSON.stringify({ fixed: builtinTester.fixed.slice(0, 120), template: builtinTester.template.slice(0, 60) }),
  )
  check(
    'the worker fixed duties are untouched (the implement stage is wired separately)',
    roleBriefSections('worker', roleTask(), defaultRoleConfig(), {}).fixed.indexOf('Duties: implement the task') >= 0,
  )
  const values = roleTemplateValuesFor('reviewer', task, config, { projectPath: PROJECT, leadName: 'lead' })
  check(
    'the value map exposes every catalog variable',
    ROLE_TEMPLATE_VARIABLE_NAMES.every((name) => Object.prototype.hasOwnProperty.call(values, name)) && values.ROLE === 'reviewer' && values.STAGE === 'review',
    JSON.stringify(values),
  )
  check('without a task the task variables render empty', roleTemplateValuesFor('reviewer', null, config, { projectPath: PROJECT }).TASK_ID === '')
  const bare = roleBriefFor('reviewer', task, normaliseRoleConfig({}), { projectPath: PROJECT, leadName: 'lead' })
  check(
    'an empty config carries the readable built-in reviewer prompt in the brief',
    bare.indexOf('Profile instructions:') >= 0 && bare.indexOf(DEFAULT_ROLE_PROMPTS.reviewer) >= 0 && bare.indexOf('Task center role: reviewer') >= 0,
    bare.slice(0, 300),
  )
  const order = ['Task center role: reviewer', 'Profile instructions:', 'Task T-1:', 'Permission boundary (hard):', 'Skills:'].map((needle) => bare.indexOf(needle))
  check('the brief keeps header → prompt → task data → fixed → skills order', order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1])), JSON.stringify(order))
  const sections = roleBriefSections('reviewer', task, config, { projectPath: PROJECT, leadName: 'lead' })
  check(
    'the split sections give the panel fixed parts and the raw template',
    sections.template === templated &&
      sections.templateRendered.indexOf('Handle T-1') >= 0 &&
      sections.header.indexOf('Task center role: reviewer') >= 0 &&
      sections.meta === '' &&
      sections.taskData.indexOf('Acceptance:') >= 0 &&
      sections.fixed.indexOf('READ-ONLY') >= 0 &&
      sections.skills.indexOf('Skills:') >= 0,
    JSON.stringify({ template: sections.template, header: sections.header, fixed: sections.fixed.slice(0, 80) }),
  )
  const preview = roleContextPreview(config, 'reviewer', { projectPath: PROJECT, profileName: 'reviewer' })
  const byKey = {}
  preview.blocks.forEach((entry) => {
    byKey[entry.key] = entry
  })
  check(
    'the preview exposes the variable catalog the editor renders',
    preview.variableCatalog.length === ROLE_TEMPLATE_VARIABLE_NAMES.length &&
      preview.variableCatalog.every((entry) => typeof entry.description === 'string' && typeof entry.sample === 'string'),
    JSON.stringify(preview.variableCatalog),
  )
  check(
    'the preview separates fixed, template and task blocks',
    preview.blocks.map((entry) => entry.type).join(',') === 'fixed,fixed,template,task,fixed,fixed' &&
      preview.blocks.filter((entry) => entry.editable === true).length === 1 &&
      byKey.template.editable === true,
    JSON.stringify(preview.blocks.map((entry) => [entry.key, entry.type, entry.editable])),
  )
  check('the template block keeps the literal {{VAR}} injection points', byKey.template.text === templated, byKey.template.text)
  check('the preview marks the variables the template uses', preview.templateVariables.join(',') === 'TASK_ID,TASK_TITLE,SPEC,COMPLETIONS_DEF,GIT_INFO,PROJECT,LEAD,ROLE,STAGE,TEMPLATE_COPY_ATTEMPT', JSON.stringify(preview.templateVariables))
  check(
    'the fixed blocks are real brief text, not panel copy',
    byKey.header.text.indexOf('Task center role: reviewer') >= 0 && byKey.duties.text.indexOf('Permission boundary (hard):') >= 0 && byKey.duties.text.indexOf('Verdict schema:') >= 0,
    JSON.stringify({ header: byKey.header.text, duties: byKey.duties.text.slice(0, 120) }),
  )
  check('the rendered brief and the entry share one generation path', preview.entries[0].text.indexOf('Handle T-? "Example task (placeholder)".') >= 0, preview.entries[0].text.slice(0, 400))
  const skilled = roleBriefFor('reviewer', task, normaliseRoleConfig({ profiles: { reviewer: { skills: ['skill-a'] } } }), {})
  check('the skills injection is unchanged', skilled.indexOf('Load these project skills with the skill tool before acting: skill-a') >= 0, skilled.slice(-200))
  const unskilled = roleBriefFor('reviewer', task, normaliseRoleConfig({}), {})
  check('without skills the brief still asks for project skills', unskilled.indexOf('Load any project-specific skills with the skill tool before acting.') >= 0, unskilled.slice(-200))
}

// ── the implementer brief carries the worker role prompt and skills ────────
{
  const config = normaliseRoleConfig({ profiles: { worker: { skills: ['dsh-plugin-workflow'], prompt: 'Implement {{TASK_ID}} in {{PROJECT}} for {{LEAD}}.' } } })
  const task = roleTask({ status: 'running', dependsOn: ['T-0'] })
  const brief = briefFor(task, PROJECT, 'lead', config)
  check(
    'a worker brief renders the profile prompt with the real values, no literal token left',
    brief.indexOf('Profile instructions:') >= 0 &&
      brief.indexOf('Implement T-1 in ' + PROJECT + ' for lead.') >= 0 &&
      brief.indexOf('{{') < 0,
    brief.slice(0, 700),
  )
  check(
    'a worker brief injects the profile skills with the shared wording',
    brief.indexOf('Load these project skills with the skill tool before acting: dsh-plugin-workflow') >= 0,
    brief.slice(-400),
  )
  const parts = briefPartsFor(task, PROJECT, 'lead', config)
  check(
    'the prompt sits before the worktree and task data; skills come last',
    parts.map((part) => part.key).join(',') === 'header,project,template,worktree,spec,acceptance,prerequisites,locks,report,skills',
    JSON.stringify(parts.map((part) => part.key)),
  )
  check('briefFor is the join of those parts', brief === parts.map((part) => part.text).join('\n\n'))
}
{
  // Backward compatibility: without a role config the brief is byte-identical to
  // the pre-role-prompt generation. This oracle is the old implementation.
  function legacyBriefFor(task, projectPath) {
    const lines = []
    lines.push('Task ' + task.id + ': ' + task.title)
    lines.push('')
    lines.push('Project: ' + projectPath)
    lines.push('You have been assigned this task. Do the work in that project.')
    if (typeof task.worktree === 'string' && task.worktree.length > 0) {
      lines.push(
        '',
        'Work in the git worktree created for this task:',
        '  worktree: ' + task.worktree,
        '  branch:   ' + String(task.branch === null || task.branch === undefined ? '' : task.branch),
        '  base:     ' + String(task.base === null || task.base === undefined ? '' : task.base),
        'Change files ONLY inside that worktree, and run the tests there.',
        'The task board still lives in the main project — point task_center at',
        'the main project ("' + projectPath + '"), not at the worktree.',
      )
    }
    if (task.spec !== '') lines.push('', 'What it involves:', task.spec)
    if (task.acceptance !== '') lines.push('', 'How it will be judged:', task.acceptance)
    if (task.dependsOn.length > 0) lines.push('', 'Completed prerequisites: ' + task.dependsOn.join(', '))
    if (task.writeFiles.length > 0) lines.push('', 'The scheduler holds these file locks for you:', task.writeFiles.join(', '))
    lines.push(
      '',
      'Report with the task_center tool:',
      '  task_center { action: "get", id: "' + task.id + '" }',
      '  task_center { action: "submit", id: "' + task.id + '", evidence: "what you changed and how you checked it" }',
      '',
      'submit is the last step of THIS round: it moves the task to REVIEW, then',
      'TESTING. A review that requests changes or a failed test returns the task to',
      'running — keep working in the same worktree and submit again. The merge',
      'request only becomes mergeable once the TEST phase passes; the host then',
      'merges it automatically. Do not commit after a passing test.',
      'Your merge request records the head submit committed, and a merge is refused',
      'while the branch has moved past it (head-drift). If you must repair the',
      'request explicitly, use:',
      '  task_center { action: "refreshMerge", id: "' + task.id + '" }',
      'That re-points the merge request and starts a fresh review round — it never',
      'commits, merges or pushes.',
      '',
      'Before writing any file that is not in the locked list, call:',
      '  task_center { action: "lock", paths: ["path/to/file"] }',
      'and unlock it when you are done. Any task_center call renews your lease; a long task should call get periodically.',
      '',
      'Do NOT dispatch anything yourself. You are the assignee, not the scheduler.',
    )
    return lines.join('\n')
  }
  const full = roleTask({ status: 'running', dependsOn: ['T-0'], spec: 'Do it', acceptance: 'Done', writeFiles: ['scripts/a.gd', 'scripts/b.gd'] })
  const minimal = roleTask({ status: 'running', spec: '', acceptance: '', dependsOn: [], writeFiles: [], worktree: null, branch: null, base: null, commit: null })
  check('without a role config briefFor is byte-identical to the legacy brief', briefFor(full, PROJECT, 'lead') === legacyBriefFor(full, PROJECT), briefFor(full, PROJECT, 'lead').slice(0, 300))
  check('the minimal legacy brief is byte-identical too', briefFor(minimal, PROJECT, 'lead') === legacyBriefFor(minimal, PROJECT), briefFor(minimal, PROJECT, 'lead').slice(0, 300))
  check(
    'without a role config there is no prompt or skills section',
    briefFor(full, PROJECT, 'lead').indexOf('Profile instructions:') < 0 && briefFor(full, PROJECT, 'lead').indexOf('Skills:') < 0,
  )
}
{
  // Delivery covers BOTH handover paths: a spawned WorkAgent and a reused idle
  // teammate sent the task by sendMessage.
  const spawnRig = createRig({ team: createTeam({ roster: [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }] }), teamOptions: { spawnedStatus: 'running' } })
  await createTask(spawnRig, { title: 'spawned task' })
  await spawnRig.action('settings', { maxConcurrent: 1, maxWorkAgents: 2 })
  await spawnRig.action('start')
  await spawnRig.settle()
  const spawnCall = spawnRig.team.calls.filter((call) => call.kind === 'spawn')[0]
  check(
    'a spawned implementer receives the worker default prompt and the skills section',
    spawnCall !== undefined && spawnCall.text.indexOf(DEFAULT_ROLE_PROMPTS.worker) >= 0 && spawnCall.text.indexOf('Skills:') >= 0,
    spawnCall === undefined ? 'no spawn call: ' + JSON.stringify(spawnRig.team.calls) : spawnCall.text.slice(0, 300),
  )
  spawnRig.scheduler.dispose()

  const reuseRig = createRig({ allowSpawn: false, teamOptions: { markRunningOnSend: true } })
  await createTask(reuseRig, { title: 'reused task' })
  await reuseRig.action('settings', { maxConcurrent: 1 })
  await reuseRig.action('start')
  await reuseRig.settle()
  const sendCall = reuseRig.team.calls.filter((call) => call.kind === 'send').pop()
  check(
    'a reused teammate receives the same worker prompt and skills, not just a spawn preamble',
    sendCall !== undefined && sendCall.text.indexOf(DEFAULT_ROLE_PROMPTS.worker) >= 0 && sendCall.text.indexOf('Skills:') >= 0,
    sendCall === undefined ? 'no send call: ' + JSON.stringify(reuseRig.team.calls) : sendCall.text.slice(0, 300),
  )
  reuseRig.scheduler.dispose()
}

{
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
        { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
        { id: 'session-idle', name: 'fixer', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const picked = pickTarget(rig.ctx, { spawn: false })
  check('a feature task prefers the ordinary worker over role slots', picked.ok === true && picked.target.name === 'fixer', JSON.stringify(picked))
  const rolesOnly = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
        { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
        { id: 'session-merger', name: 'merger', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const none = pickTarget(rolesOnly.ctx, { spawn: false })
  check('role slots are never feature workers', none.ok === false && none.code === 'no-teammates', JSON.stringify(none))
}

{
  const rig = createRoleRig()
  const config = defaultRoleConfig()
  const task = roleTask()
  const first = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 1000 })
  check('ensureRole spawns the missing reviewer', first.ok === true && first.created.length === 1 && first.created[0].name === 'reviewer-1', JSON.stringify(first))
  const spawnCall = rig.team.calls.filter((call) => call.kind === 'spawn')[0]
  check(
    'the spawn carries the reviewer role brief',
    spawnCall !== undefined && spawnCall.name === 'reviewer-1' && spawnCall.text.indexOf('Task center role: reviewer') >= 0 && spawnCall.text.indexOf('Do the thing') >= 0 && spawnCall.text.indexOf('READ-ONLY') >= 0,
    spawnCall === undefined ? '' : spawnCall.text.slice(0, 500),
  )
  const again = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 2000 })
  check('an existing live reviewer is reused, not respawned', again.ok === true && again.created.length === 0 && again.reused.indexOf('reviewer-1') >= 0, JSON.stringify(again))
  check('and no second spawn happened', rig.team.calls.filter((call) => call.kind === 'spawn').length === 1, JSON.stringify(rig.team.calls.map((call) => call.kind + ':' + call.name)))
  const tester = await rig.manager.ensure('tester', { config: config, projectPath: PROJECT, task: task, now: 2000 })
  check('the tester role is provisioned too', tester.ok === true && tester.created[0].name === 'tester-1', JSON.stringify(tester))
  const viaName = await ensureRole(rig.ctx, 'tester', { config: config, projectPath: PROJECT, task: task, now: 2500 })
  check('ensureRole is exposed as a host function', viaName.ok === true && viaName.created.length === 0 && viaName.reused.indexOf('tester-1') >= 0, JSON.stringify(viaName))
}

{
  const rig = createRoleRig()
  const config = defaultRoleConfig()
  const task = roleTask()
  await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 1000 })
  rig.team.setStatus('reviewer-1', 'failed')
  const replaced = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 2000 })
  check(
    'a failed reviewer is replaced on the next ensure',
    replaced.ok === true && replaced.replaced.some((entry) => entry.name === 'reviewer-1' && entry.reason === 'failed') && replaced.created[0].name === 'reviewer-2',
    JSON.stringify(replaced),
  )
  rig.team.setStatus('reviewer-2', 'provisioning')
  const timedOut = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 2000 + ROLE_PROVISION_TIMEOUT_MS + 1 })
  check(
    'a provisioning timeout is replaced',
    timedOut.ok === true && timedOut.replaced.some((entry) => entry.name === 'reviewer-2' && entry.reason === 'timeout') && timedOut.created[0].name === 'reviewer-3',
    JSON.stringify(timedOut),
  )
}

{
  const rig = createRoleRig()
  const config = defaultRoleConfig()
  const task = roleTask()
  await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 1000 })
  const drained = rig.manager.drain('reviewer-1')
  check('drain marks a slot for replacement', drained.ok === true, JSON.stringify(drained))
  const afterDrain = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 2000 })
  check(
    'a drained reviewer is replaced',
    afterDrain.ok === true && afterDrain.replaced.some((entry) => entry.name === 'reviewer-1' && entry.reason === 'drained') && afterDrain.created[0].name === 'reviewer-2',
    JSON.stringify(afterDrain),
  )
}

{
  const rig = createRoleRig()
  const config = defaultRoleConfig()
  const invalid = await rig.manager.ensure('nobody', { config: config })
  check('an unknown role kind is a readable refusal', invalid.ok === false && invalid.code === 'invalid-role', JSON.stringify(invalid))
  const noTeam = await createRoleRig({ team: null }).manager.ensure('reviewer', { config: config })
  check('a profile without agent-team services refuses readably', noTeam.ok === false && noTeam.code === 'no-team-service', JSON.stringify(noTeam))
  const noLead = await createRoleRig({ agents: { list: () => [] } }).manager.ensure('reviewer', { config: config })
  check('a profile without a Lead refuses readably', noLead.ok === false && noLead.code === 'no-lead', JSON.stringify(noLead))
  const spawnFailed = await createRoleRig({ spawnThrows: true }).manager.ensure('reviewer', { config: config })
  check('a refused spawn is reported, not thrown', spawnFailed.ok === false && spawnFailed.code === 'spawn-failed', JSON.stringify(spawnFailed))
  const two = createRoleRig()
  const config2 = normaliseRoleConfig({ profiles: { reviewer: { instances: 2, skills: ['skill-a'] } } })
  const doubled = await two.manager.ensure('reviewer', { config: config2, projectPath: PROJECT, task: roleTask(), now: 1000 })
  check(
    'configured instances are filled with fixed slot names',
    doubled.ok === true && doubled.created.map((entry) => entry.name).join(',') === 'reviewer-1,reviewer-2',
    JSON.stringify(doubled.created),
  )
  check(
    'each spawned brief carries the configured skill',
    two.team.calls.filter((call) => call.kind === 'spawn').every((call) => call.text.indexOf('skill-a') >= 0),
    JSON.stringify(two.team.calls.map((call) => call.text.slice(0, 120))),
  )
}

{
  const rig = createRoleRig()
  rig.fs.files.set(
    rolesPath(PROJECT),
    { text: JSON.stringify({ defaultProfile: 'tester', profiles: { reviewer: { instances: 2, skills: ['dsh-plugin-workflow'] } } }), version: 'seed' },
  )
  const read = await readRoleConfig({ fs: rig.fs }, { projectPath: PROJECT })
  check(
    'roles.json is read from the project',
    read.source === 'file' && read.config.profiles.reviewer.instances === 2 && read.config.profiles.reviewer.stage === 'review' && read.config.profiles.reviewer.skills.join(',') === 'dsh-plugin-workflow',
    JSON.stringify(read.config),
  )
  check('and its default profile is honoured', read.config.defaultProfile === 'tester', read.config.defaultProfile)
  const absent = createRoleRig()
  const missing = await readRoleConfig({ fs: absent.fs }, { projectPath: PROJECT })
  check('an absent roles.json uses the defaults', missing.source === 'default' && missing.config.defaultProfile === 'worker' && missing.error === null, JSON.stringify(missing))
  absent.fs.files.set(rolesPath(PROJECT), { text: '{ not json', version: 'seed' })
  const broken = await readRoleConfig({ fs: absent.fs }, { projectPath: PROJECT })
  check('a broken roles.json falls back instead of failing dispatch', broken.source === 'default' && String(broken.error).indexOf('not valid JSON') >= 0, JSON.stringify(broken))
}

{
  const rig = createRoleRig()
  const state = createState(rig.ctx)
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [roleTask()] }))
  const scheduler = createDispatcher(rig.ctx, { state: state, projectPath: () => PROJECT, allowSpawn: false, git: null, roles: rig.manager })
  const first = await scheduler.tick(PROJECT)
  check(
    'the tick provisions the reviewer for a reviewing task',
    first.ok === true && rig.team.calls.filter((call) => call.kind === 'spawn' && call.name === 'reviewer-1').length === 1,
    JSON.stringify(first.roles),
  )
  await scheduler.tick(PROJECT)
  check('a second tick reuses the live reviewer', rig.team.calls.filter((call) => call.kind === 'spawn').length === 1, JSON.stringify(rig.team.calls.map((call) => call.name)))
  rig.team.setStatus('reviewer-1', 'failed')
  await scheduler.tick(PROJECT)
  check('a dead reviewer is replaced by the next tick', rig.team.calls.filter((call) => call.kind === 'spawn' && call.name === 'reviewer-2').length === 1, JSON.stringify(rig.team.calls.map((call) => call.name)))
  scheduler.dispose()
}

// ── the per-round review brief and the rework brief ────────────────────────
{
  const task = roleTask({
    status: null,
    review: { status: 'changes-requested', by: 'reviewer-1', at: null, reasons: 'rename the helper in scripts/a.gd:12', attempt: 2 },
    merge: { status: 'open', base: 'base-sha', target: 'feat/task-center-v2', head: 'head-sha', declaredFiles: ['scripts/a.gd'], actualFiles: ['scripts/a.gd', 'scripts/b.gd'], tests: 'npm run verify', reviewer: null, conflict: null, at: null },
    actualFiles: ['scripts/a.gd', 'scripts/b.gd'],
    evidence: 'node scripts/test/run.mjs passed',
  })
  const brief = reviewBriefFor(task, PROJECT)
  check('the review brief names the round and the diff', brief.indexOf('Review round 2') >= 0 && brief.indexOf('base-sha..head-sha') >= 0, brief.slice(0, 400))
  check(
    'the review brief carries spec and acceptance',
    brief.indexOf('Do the thing') >= 0 && brief.indexOf('The thing works') >= 0,
    brief.slice(0, 600),
  )
  check(
    'the review brief compares declared and actual files',
    brief.indexOf('Declared files') >= 0 && brief.indexOf('Changed files from git') >= 0 && brief.indexOf('scripts/b.gd') >= 0 && brief.indexOf('beyond the declaration') >= 0,
    brief.slice(0, 900),
  )
  check('the review brief carries the worker evidence', brief.indexOf('node scripts/test/run.mjs passed') >= 0, brief.slice(0, 900))
  check('the review brief carries the previous reasons', brief.indexOf('rename the helper') >= 0, brief.slice(0, 900))
  check('the review brief carries the conventions and checklist', brief.indexOf('Review checklist') >= 0 && brief.indexOf('Declared vs actual files') >= 0, brief.slice(-1200))
  check('the review brief says the full test run is not needed here', brief.indexOf('do NOT need to run the full test suite') >= 0, brief.slice(-900))
  check(
    'the review brief states the read-only boundary and both verdicts',
    brief.indexOf('READ-ONLY') >= 0 && brief.indexOf('approveReview') >= 0 && brief.indexOf('requestChanges') >= 0,
    brief.slice(-900),
  )

  const rework = reworkBriefFor(task, PROJECT)
  check('the rework brief carries the reviewer reasons', rework.indexOf('rename the helper in scripts/a.gd:12') >= 0, rework.slice(0, 500))
  check('the rework brief keeps the same worktree and branch', rework.indexOf('SAME worktree') >= 0 && rework.indexOf('task/T-1-1') >= 0, rework.slice(0, 700))
  check('the rework brief asks for a resubmission of the next round', rework.indexOf('submit') >= 0 && rework.indexOf('round 3') >= 0, rework.slice(-400))
}

// ── review timeout policy: remind once, then block for triage ──────────────
{
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const state = createState(rig.ctx)
  const stale = roleTask({ review: { status: 'pending', by: 'work-T-1-1', at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), reasons: null, attempt: 1 } })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [stale] }))
  const scheduler = createDispatcher(rig.ctx, { state: state, projectPath: () => PROJECT, allowSpawn: false, git: null, roles: rig.manager, reviewTimeoutMs: 25 })
  await scheduler.tick(PROJECT)
  const reminders = rig.team.calls.filter((call) => call.kind === 'send' && call.target === 'reviewer-1')
  check('a stale review gets one reminder to the reviewer', reminders.length === 1 && reminders[0].text.indexOf('Reminder') >= 0 && reminders[0].text.indexOf('Review round 1') >= 0, JSON.stringify(reminders.map((call) => call.text.slice(0, 80))))
  const firstRead = await state.read(PROJECT)
  check('a reminder does not block the task yet', findTask(firstRead.board, 'T-1').status === 'reviewing', JSON.stringify(findTask(firstRead.board, 'T-1').status))
  await sleep(40)
  await scheduler.tick(PROJECT)
  const secondRead = await state.read(PROJECT)
  const blocked = findTask(secondRead.board, 'T-1')
  check('a second silent timeout blocks the task for triage', blocked.status === 'blocked', blocked.status)
  check('and records why', blocked.history.some((entry) => String(entry.note).indexOf('review timed out') >= 0), JSON.stringify(blocked.history.slice(-2)))
  scheduler.dispose()
}

// ── test timeout policy: remind once, then block; passed/failed untouched ──
{
  const activity = createActivity({ limit: 40 })
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
        { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
      ],
    }),
    agents: { list: () => [{ id: 'session-lead', name: 'lead' }] },
  })
  const state = createState(rig.ctx)
  const reminderAt = new Date(Date.now() - 15 * 1000).toISOString()
  const testingTask = roleTask({
    status: 'testing',
    assignee: { name: 'fixer', session: 'session-fixer' },
    review: { status: 'approved', by: 'reviewer-1', at: reminderAt, reasons: null, attempt: 1 },
    test: { status: 'pending', by: null, at: reminderAt, evidence: null, attempt: 1 },
    merge: {
      status: 'open',
      base: 'base-sha',
      target: 'feat/task-center-v2',
      head: 'head-sha',
      mergeCommit: 'candidate-sha',
      declaredFiles: ['scripts/a.gd'],
      actualFiles: ['scripts/a.gd'],
      tests: 'npm test',
      reviewer: null,
      conflict: null,
      output: null,
      at: reminderAt,
    },
  })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [testingTask] }))
  const scheduler = createDispatcher(rig.ctx, {
    state: state,
    projectPath: () => PROJECT,
    allowSpawn: false,
    git: null,
    roles: rig.manager,
    activity: activity,
    testReminderMs: 10 * 1000,
    testTimeoutMs: 20 * 1000,
    reviewTimeoutMs: 60 * 60 * 1000,
  })
  await scheduler.tick(PROJECT)
  const reminders = rig.team.calls.filter((call) => call.kind === 'send' && call.target === 'tester-1' && call.text.indexOf('Reminder') >= 0)
  check('a pending test round gets one reminder to the tester', reminders.length === 1 && reminders[0].text.indexOf('candidate candidate-sha') >= 0, JSON.stringify(reminders.map((call) => call.text.slice(0, 120))))
  const firstRead = await state.read(PROJECT)
  check('the reminder does not block the task yet', findTask(firstRead.board, 'T-1').status === 'testing', findTask(firstRead.board, 'T-1').status)
  const reminderEvents = activity.list(40).filter((entry) => entry.kind === 'test-reminder')
  check('the reminder is recorded as SYSTEM activity', reminderEvents.length === 1 && reminderEvents[0].actor === 'system' && reminderEvents[0].taskId === 'T-1', JSON.stringify(reminderEvents))
  await scheduler.tick(PROJECT)
  const again = rig.team.calls.filter((call) => call.kind === 'send' && call.target === 'tester-1' && call.text.indexOf('Reminder') >= 0)
  check('the reminder is sent only once', again.length === 1, String(again.length))

  // Hard timeout: move the test round past TEST_TIMEOUT_MS and tick again.
  const hardAt = new Date(Date.now() - 25 * 1000).toISOString()
  await updateBoard(
    { fs: rig.fs },
    {
      projectPath: PROJECT,
      sandboxPolicy: writePolicyFor(PROJECT),
      mutate: (board) => {
        const task = findTask(board, 'T-1')
        task.test.at = hardAt
        return board
      },
    },
  )
  await scheduler.tick(PROJECT)
  const hardRead = await state.read(PROJECT)
  const blocked = findTask(hardRead.board, 'T-1')
  check('a hard test timeout blocks the task for triage', blocked.status === 'blocked', blocked.status)
  check(
    'the block records the tester, elapsed time and candidate state',
    blocked.history.some((entry) => String(entry.note).indexOf('test timeout') >= 0 && String(entry.note).indexOf('tester-1') >= 0 && String(entry.note).indexOf('candidate candidate-sha') >= 0),
    JSON.stringify(blocked.history.slice(-2)),
  )
  const timeoutEvents = activity.list(40).filter((entry) => entry.kind === 'error' && String(entry.detail).indexOf('test timeout') >= 0)
  check('the block is recorded as SYSTEM activity', timeoutEvents.length === 1 && timeoutEvents[0].actor === 'system', JSON.stringify(timeoutEvents))
  const notices = rig.team.calls.filter((call) => call.kind === 'send' && (call.target === 'fixer' || call.target === 'lead') && call.text.indexOf('timed out') >= 0)
  check('the owner and the Lead are told about the blocked test', notices.length >= 2, JSON.stringify(notices.map((call) => call.target)))
  scheduler.dispose()
}

{
  // Passed or failed test rounds are never reminded or blocked.
  for (const status of ['passed', 'failed']) {
    const activity = createActivity({ limit: 20 })
    const rig = createRoleRig({
      team: createTeam({
        roster: [
          { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
          { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
        ],
      }),
    })
    const state = createState(rig.ctx)
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const task = roleTask({
      status: 'testing',
      review: { status: 'approved', by: 'reviewer-1', at: old, reasons: null, attempt: 1 },
      test: { status: status, by: 'tester-1', at: old, evidence: status === 'passed' ? 'PASS' : 'FAIL', attempt: 1 },
      merge: { status: 'open', base: 'base-sha', target: 'feat/task-center-v2', head: 'head-sha', mergeCommit: 'candidate-sha', declaredFiles: [], actualFiles: [], tests: 'npm test', reviewer: null, conflict: null, output: null, at: old },
    })
    seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [task] }))
    const scheduler = createDispatcher(rig.ctx, {
      state: state,
      projectPath: () => PROJECT,
      allowSpawn: false,
      git: null,
      roles: rig.manager,
      activity: activity,
      testReminderMs: 10,
      testTimeoutMs: 20,
      reviewTimeoutMs: 60 * 60 * 1000,
    })
    await scheduler.tick(PROJECT)
    const read = await state.read(PROJECT)
    const current = findTask(read.board, 'T-1')
    const sends = rig.team.calls.filter((call) => call.kind === 'send')
    const testEvents = activity.list(20).filter((entry) => entry.kind === 'test-reminder' || entry.kind === 'error')
    check('a ' + status + ' test round is never reminded or blocked', current.status === 'testing' && sends.length === 0 && testEvents.length === 0, JSON.stringify({ status: current.status, sends: sends.length, events: testEvents.length }))
    scheduler.dispose()
  }
}

{
  // A tester verdict landing between the tick's read and the block write wins:
  // the CAS re-run must re-check the pending round and skip the block.
  const activity = createActivity({ limit: 20 })
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const state = createState(rig.ctx)
  const old = new Date(Date.now() - 60 * 1000).toISOString()
  const task = roleTask({
    status: 'testing',
    review: { status: 'approved', by: 'reviewer-1', at: old, reasons: null, attempt: 1 },
    test: { status: 'pending', by: null, at: old, evidence: null, attempt: 1 },
    merge: { status: 'open', base: 'base-sha', target: 'feat/task-center-v2', head: 'head-sha', mergeCommit: 'candidate-sha', declaredFiles: [], actualFiles: [], tests: 'npm test', reviewer: null, conflict: null, output: null, at: old },
  })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [task] }))
  let injected = false
  rig.fs.hooks.beforeWrite = function (event) {
    if (injected || String(event.key).indexOf('tasks.json') < 0 || String(event.content).indexOf('"status": "blocked"') < 0) return undefined
    injected = true
    const board = JSON.parse(event.content)
    const fresh = findTask(board, 'T-1')
    fresh.status = 'testing'
    fresh.test.status = 'passed'
    fresh.test.by = 'tester-1'
    fresh.test.evidence = 'PASS'
    event.write(JSON.stringify(board, null, 2) + '\n')
    return 'stale'
  }
  const scheduler = createDispatcher(rig.ctx, {
    state: state,
    projectPath: () => PROJECT,
    allowSpawn: false,
    git: null,
    roles: rig.manager,
    activity: activity,
    testReminderMs: 10,
    testTimeoutMs: 20,
    reviewTimeoutMs: 60 * 60 * 1000,
  })
  await scheduler.tick(PROJECT)
  const read = await state.read(PROJECT)
  const current = findTask(read.board, 'T-1')
  check(
    'a passing verdict that lands before the block write is not overwritten',
    injected === true && current.status === 'testing' && current.test.status === 'passed',
    JSON.stringify({ injected: injected, status: current.status, test: current.test.status }),
  )
  check('the skipped block records no timeout activity', activity.list(20).every((entry) => entry.kind !== 'error' && String(entry.detail).indexOf('test timeout') < 0), JSON.stringify(activity.list(20)))
  check('the skipped block sends no notices', rig.team.calls.filter((call) => call.kind === 'send').length === 0, JSON.stringify(rig.team.calls.map((call) => call.target)))
  scheduler.dispose()
}

// ── runtime snapshot sources: workerPool kinds and the activity ring ───────
{
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
        { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
        { id: 'session-merger', name: 'merger', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const board = {
    tasks: [{ id: 'T-1', title: 'Feature', status: 'running', assignee: { name: 'fixer', session: 'session-fixer' } }],
    dispatch: { maxWorkAgents: 4 },
  }
  const report = workerPool(rig.ctx, board, { roleConfig: normaliseRoleConfig({ profiles: { reviewer: { instances: 2 } } }) })
  const byName = {}
  for (const member of report.members) byName[member.name] = member
  check(
    'every teammate has a kind, description, session and currentTask',
    byName['fixer'].kind === 'worker' &&
      byName['fixer'].description === 'feature worker' &&
      byName['fixer'].session === 'session-fixer' &&
      byName['fixer'].currentTask !== null &&
      byName['fixer'].currentTask.id === 'T-1' &&
      byName['reviewer-1'].kind === 'reviewer' &&
      byName['reviewer-1'].description === 'review role' &&
      byName['tester-1'].kind === 'tester' &&
      byName['merger'].kind === 'merger' &&
      byName['merger'].description === 'merge queue operator',
    JSON.stringify(report.members),
  )
  check('kinds are counted', report.kinds.lead === 1 && report.kinds.worker === 1 && report.kinds.reviewer === 1 && report.kinds.tester === 1 && report.kinds.merger === 1, JSON.stringify(report.kinds))
  check('the lead is a separate lead entry, not a teammate', report.leadInfo !== null && report.leadInfo.kind === 'lead' && report.members.filter((member) => member.kind === 'lead').length === 0, JSON.stringify(report.leadInfo))
  check(
    'the role config reports desired/live/missing',
    report.roles !== null &&
      report.roles.desired.reviewer === 2 &&
      report.roles.live.reviewer === 1 &&
      report.roles.missing.reviewer === 1 &&
      report.roles.desired.tester === 1 &&
      report.roles.missing.tester === 0,
    JSON.stringify(report.roles),
  )
  const noTeam = workerPool({ get: () => undefined }, board)
  check('without a Team the pool degrades readably', noTeam.error === 'no-team-service' && noTeam.members.length === 0 && noTeam.kinds.lead === 0, JSON.stringify(noTeam))
}

{
  const activity = createActivity({ limit: 3, now: () => 1000 })
  activity.push({ kind: 'worktree-create', actor: 'host', taskId: 'T-1', detail: 'created' })
  activity.push({ kind: 'merge', actor: 'agent', actorName: '@fixer', taskId: 'T-1', detail: 'merged' })
  activity.push({ kind: 'mystery', actor: 'somebody', taskId: 'T-2' })
  activity.push({ kind: 'role-provision', actor: 'system', detail: 'reviewer-1' })
  const snap = activity.snapshot()
  check('the ring keeps only its limit', snap.count === 3 && snap.pushed === 4 && snap.entries.length === 3, JSON.stringify(snap))
  check('entries are newest first', snap.entries[0].kind === 'role-provision' && snap.entries[2].kind === 'merge', JSON.stringify(snap.entries.map((entry) => entry.kind)))
  check(
    'an unknown actor is system, never an agent',
    activity.list(4)[1].kind === 'mystery' && activity.list(4)[1].actor === 'system' && activity.list(4)[1].actorName === null,
    JSON.stringify(activity.list(4)),
  )
  check('an agent event keeps its name; a system event never has one', snap.entries[2].actor === 'agent' && snap.entries[2].actorName === '@fixer' && snap.entries.filter((entry) => entry.actor !== 'agent').every((entry) => entry.actorName === null), JSON.stringify(snap.entries))
  check('timestamps and actor counts are reported', typeof snap.entries[0].at === 'string' && snap.actors.system >= 1 && snap.actors.host === 0, JSON.stringify(snap.actors))
}

{
  // The dispatcher records host work (worktree create) and System provisioning.
  const activity = createActivity({ limit: 20 })
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const state = createState(rig.ctx)
  const reviewing = roleTask()
  const pending = roleTask({
    id: 'T-2',
    title: 'Pending task',
    status: 'pending',
    assignee: null,
    worktree: null,
    branch: null,
    base: null,
    target: null,
    commit: null,
    actualFiles: [],
    review: null,
    test: null,
    dispatch: null,
    leaseUntil: null,
  })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'running' }, tasks: [reviewing, pending] }))
  const scheduler = createDispatcher(rig.ctx, {
    state: state,
    projectPath: () => PROJECT,
    allowSpawn: false,
    git: createFakeGit(),
    roles: rig.manager,
    activity: activity,
    reviewTimeoutMs: 30,
  })
  await scheduler.tick(PROJECT)
  const entries = activity.list(20)
  const create = entries.filter((entry) => entry.kind === 'worktree-create')[0]
  check('the dispatcher records the worktree it creates as host work', create !== undefined && create.actor === 'host' && create.taskId === 'T-2', JSON.stringify(entries))
  const provision = entries.filter((entry) => entry.kind === 'role-provision')[0]
  check('role provisioning is a system event', provision !== undefined && provision.actor === 'system' && provision.actorName === null, JSON.stringify(entries.filter((entry) => entry.kind === 'role-provision')))
  check('the dispatcher records no agent activity (it is not a model)', entries.every((entry) => entry.actor !== 'agent'), JSON.stringify(entries))
  scheduler.dispose()
}

{
  // A replaced role slot is a SYSTEM activity event ('role-replace'), distinct
  // from a fresh provision.
  const activity = createActivity({ limit: 20 })
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const state = createState(rig.ctx)
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [roleTask()] }))
  const scheduler = createDispatcher(rig.ctx, {
    state: state,
    projectPath: () => PROJECT,
    allowSpawn: false,
    git: createFakeGit(),
    roles: rig.manager,
    activity: activity,
    reviewTimeoutMs: 60 * 60 * 1000,
  })
  await scheduler.tick(PROJECT)
  check('a live reviewer is reused without a provisioning event', activity.list(20).every((entry) => entry.kind !== 'role-provision'), JSON.stringify(activity.list(20)))
  rig.team.setStatus('reviewer-1', 'failed')
  await scheduler.tick(PROJECT)
  const entries = activity.list(20)
  const replace = entries.filter((entry) => entry.kind === 'role-replace')[0]
  check(
    'a replaced role is a system role-replace event with no agent name',
    replace !== undefined && replace.actor === 'system' && replace.actorName === null && String(replace.detail).indexOf('reviewer-1') >= 0,
    JSON.stringify(entries.filter((entry) => entry.kind === 'role-replace' || entry.kind === 'role-provision')),
  )
  check(
    'the replacement slot is provisioned as a system event too',
    entries.some((entry) => entry.kind === 'role-provision' && entry.actor === 'system' && String(entry.detail).indexOf('reviewer-2') >= 0),
    JSON.stringify(entries.filter((entry) => entry.kind === 'role-provision')),
  )
  scheduler.dispose()
}

// ── role profiles: custom fields, stage binding, drain/replace ────────────
{
  const config = normaliseRoleConfig({
    profiles: {
      'godot-reviewer': { role: 'reviewer', stage: 'review', instances: 2, skills: ['dsh-plugin-workflow'], context: 'fork', permissions: ['read-only', 'review'], prompt: 'Pay attention to Godot idioms.' },
    },
    stages: { review: 'godot-reviewer' },
  })
  const reviewer = roleBriefFor('reviewer', roleTask(), config, { projectPath: PROJECT, leadName: 'lead' })
  check(
    'the reviewer brief uses the bound custom profile',
    reviewer.indexOf('Profile permissions: read-only, review') >= 0 &&
      reviewer.indexOf('Pay attention to Godot idioms.') >= 0 &&
      reviewer.indexOf('forked from the Lead') >= 0 &&
      reviewer.indexOf('dsh-plugin-workflow') >= 0,
    reviewer.slice(0, 900),
  )
  const worker = roleBriefFor('worker', roleTask({ status: 'running' }), config, {})
  check('a kind without a bound custom profile keeps its own profile', worker.indexOf('Pay attention to Godot idioms.') < 0, worker.slice(0, 600))
}

{
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const config = normaliseRoleConfig({ profiles: { 'godot-reviewer': { role: 'reviewer', instances: 1 } }, stages: { review: 'godot-reviewer' } })
  const first = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 1000 })
  check('a bound custom profile provisions its instances', first.ok === true && first.created.length === 0 && first.reused.join(',') === 'reviewer-1', JSON.stringify(first))
  const drained = rig.manager.drain('reviewer-1')
  check('draining a live instance is recorded', drained.ok === true && drained.drained && drained.drained.join(',') === 'reviewer-1', JSON.stringify(drained))
  const replaced = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 2000 })
  check(
    'the next ensure drains and replaces the instance through the Lead',
    replaced.ok === true && replaced.replaced.some((entry) => entry.name === 'reviewer-1' && entry.reason === 'drained') && replaced.created.length === 1 && replaced.created[0].name === 'reviewer-2',
    JSON.stringify(replaced),
  )
  const defaults = await rig.manager.ensure('reviewer', { config: defaultRoleConfig(), projectPath: PROJECT, task: roleTask(), now: 3000 })
  check('the default config reuses the live replacement', defaults.ok === true && defaults.created.length === 0 && defaults.reused.indexOf('reviewer-2') >= 0, JSON.stringify(defaults))
}

{
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
        { id: 'session-reviewer-2', name: 'reviewer-2', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const config = normaliseRoleConfig({ profiles: { 'godot-reviewer': { role: 'reviewer', instances: 2 } }, stages: { review: 'godot-reviewer' } })
  const ensured = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 1000 })
  check('a custom instances count is honoured', ensured.ok === true && ensured.reused.length === 2, JSON.stringify(ensured))
  const drained = await rig.manager.drainKind('reviewer')
  check('drainKind drains every instance of the kind', drained.ok === true && drained.drained.length === 2, JSON.stringify(drained))
  const replaced = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 2000 })
  check('every drained slot is replaced', replaced.ok === true && replaced.created.length === 2 && replaced.created.map((entry) => entry.name).join(',') === 'reviewer-3,reviewer-4', JSON.stringify(replaced))
}

{
  // The role manager itself defers a running drained instance: no ensure pass
  // (API, submit provisioning or the scheduler tick) may spawn early.
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'running' },
      ],
    }),
  })
  const config = defaultRoleConfig()
  const drained = rig.manager.drain('reviewer-1', { timeoutMs: 100, now: 1000 })
  check('draining with a timeout records the deadline', drained.ok === true && drained.deadline === 1100, JSON.stringify(drained))
  const early = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 1050 })
  check(
    'a running drained instance is deferred, not replaced early',
    early.ok === true && early.created.length === 0 && early.replaced.length === 0 && early.waiting.length === 1 && early.waiting[0].name === 'reviewer-1',
    JSON.stringify({ created: early.created, replaced: early.replaced, waiting: early.waiting }),
  )
  const stillEarly = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 1099 })
  check('the deferral lasts until the deadline', stillEarly.created.length === 0 && stillEarly.waiting.length === 1, JSON.stringify({ created: stillEarly.created, waiting: stillEarly.waiting }))
  check('the deferred state is visible in the manager status', rig.manager.status().pending.some((entry) => entry.name === 'reviewer-1'), JSON.stringify(rig.manager.status().pending))
  rig.team.setStatus('reviewer-1', 'inactive')
  const idle = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 1060 })
  check('an idle drained instance is replaced before its deadline', idle.created.length === 1 && idle.created[0].name === 'reviewer-2', JSON.stringify({ created: idle.created, waiting: idle.waiting }))
}

{
  // A still-running drained instance is replaced once the deadline passes.
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'running' },
      ],
    }),
  })
  const config = defaultRoleConfig()
  rig.manager.drain('reviewer-1', { timeoutMs: 50, now: 1000 })
  const before = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 1020 })
  check('the instance is still deferred before the deadline', before.created.length === 0 && before.waiting.length === 1, JSON.stringify(before))
  const after = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 1060 })
  check(
    'after the deadline the instance is replaced',
    after.ok === true && after.created.length === 1 && after.created[0].name === 'reviewer-2' && after.replaced.some((entry) => entry.name === 'reviewer-1' && entry.reason === 'drain-timeout'),
    JSON.stringify({ created: after.created, replaced: after.replaced }),
  )
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
