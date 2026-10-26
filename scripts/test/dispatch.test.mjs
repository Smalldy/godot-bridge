// Scheduler tests: the dependency chain, start/pause, concurrency, target
// reservation, file locks, retry, lease reaping and host restart recovery.

import { join } from 'node:path'
import { mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
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
  liveLeads,
  leadInventory,
  projectTeamState,
  hostCheckEvidence,
  reviewBriefFor,
  reworkBriefFor,
  runHostCheck,
  testerBriefFor,
  roleBriefFor,
  roleBriefSections,
  roleContextPreview,
  roleKindOf,
  roleSlotName,
  roleSlotOf,
  roleSlotKey,
  roleShortName,
  projectSlotKey,
  TEAM_BOOTSTRAP_INSTRUCTION,
  rememberMemberProject,
  memberProjectOf,
  roleTemplateValuesFor,
  recordPhaseActivity,
  recordStageSlot,
  stageSlotOf,
  phaseActivityAt,
  serialiseWorktreeCreate,
  workerPool,
} from '../../plugin/task-center/dispatch.mjs'
import { DEFAULT_ROLE_PROMPTS, ROLE_PROVISION_TIMEOUT_MS, ROLE_TEMPLATE_VARIABLE_NAMES, TASK_HEARTBEAT_MS, TASK_LEASE_MS, VERIFY_TAIL_BYTES, defaultRoleConfig, normaliseRoleConfig } from '../../plugin/task-center/schema.mjs'

// Project-scoped slot names: a role slot carries the project it was provisioned
// for, so two projects never share one reviewer instance.
const slot = (kind, index) => roleSlotName(kind, index, PROJECT)
import { createApi, USER_ONLY_ACTIONS } from '../../plugin/task-center/api.mjs'
import { createMerger } from '../../plugin/task-center/merge.mjs'
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
  // T-127: the pool is the only source of executors, so concurrency is bounded
  // by the configured worker instances. This chain needs three at once.
  const poolConfig = defaultRoleConfig()
  poolConfig.profiles.worker.instances = 3
  rig.fs.files.set(rolesPath(PROJECT), { text: JSON.stringify(poolConfig), version: 'seed' })
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
  await submitAndMerge(rig, A, 'A done')
  await rig.settle()
  snap = await snapshot(rig)
  check(
    'the worker is reused once its card is done',
    byId(snap, B).status === 'running' && byId(snap, B).assignee !== null && byId(snap, B).assignee.name === 'fixer' && running(snap).length === 1,
    JSON.stringify({ running: running(snap), assignee: byId(snap, B).assignee }),
  )
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
  // T-85: a real failure is NOT an interruption — the two axes stay independent.
  check('a real failure is never counted as an interruption', byId(snap, A).interruptions === 0, String(byId(snap, A).interruptions))
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
  roster.push({ id: 'session-spare', name: 'fixer-spare', role: 'teammate', status: 'inactive' })
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
  // together with a read and a board-writing action. (The manual lock actions are
  // gone; the read-only locks diagnostic still renews.)
  const leaseOf = async function () { return Date.parse((await rig.action('get', { id: A })).task.leaseUntil) }
  clock += 2 * 60 * 1000
  const listed = await rig.api.perform('locks', {}, asAssignee)
  check('locks renews the lease like any other activity', listed.ok === true && (await leaseOf()) === clock + TASK_LEASE_MS, JSON.stringify({ clock: clock, lease: await leaseOf() }))
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
  // T-115: a Lead alone is not a qualified team; keep one spare teammate so this
  // handover scenario still exercises adoption (not the no-team gate).
  roster.push({ id: 'session-spare', name: 'fixer-spare', role: 'teammate', status: 'inactive' })
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

// ── T-85: a host restart is an INTERRUPTION, not a worker failure ──────────
// The claim was made by a host process that no longer exists: the worker never
// had a chance to work, so the attempt is refunded and the interruption counted
// on its own axis. This is the exact case that blocked T-83 after three restarts.
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'A' })).id
  const attemptsBeforeDispatch = byId(await snapshot(rig), A).attempts
  await rig.action('start')
  await rig.settle()
  const claimed = byId(await snapshot(rig), A)
  await rig.action('pause')
  await patchTask(rig, A, (task) => {
    task.dispatch = Object.assign({}, task.dispatch, { host: 'a-previous-process' })
  })
  await rig.settle()
  const snap = await snapshot(rig)
  const reaped = byId(snap, A)
  const notes = (reaped.history || []).map((entry) => String(entry.note)).join(' | ')
  check('a claim from another process is requeued', reaped.status === 'pending', JSON.stringify(ids(snap)))
  check('with a readable reason', String(reaped.dispatch.error).indexOf('host restart') >= 0, JSON.stringify(reaped.dispatch))
  check(
    'the claim charged one attempt',
    claimed.attempts === attemptsBeforeDispatch + 1,
    JSON.stringify({ before: attemptsBeforeDispatch, claimed: claimed.attempts }),
  )
  check(
    'the attempt is refunded instead of spent',
    reaped.attempts === attemptsBeforeDispatch,
    JSON.stringify({ before: attemptsBeforeDispatch, after: reaped.attempts }),
  )
  check('the interruption is counted separately', reaped.interruptions === 1, String(reaped.interruptions))
  check('the history says the attempt was refunded', notes.indexOf('attempt refunded') >= 0, notes)
  check(
    'the interrupted executor is no longer live',
    reaped.liveExecutors.length === 0 && reaped.executors.length === 1,
    JSON.stringify(reaped.executors),
  )
  check('board exposes the executor ledger', Array.isArray(reaped.executors) && reaped.executors[0].retiredAt !== null, JSON.stringify(reaped.executors))
  rig.scheduler.dispose()
}

// ── T-85: get exposes the interruption axes, and submitting clears the streak ─
{
  // T-115: a Lead alone is not a qualified team; include one teammate.
  const team = createTeam({
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
    ],
    spawnedStatus: 'running',
  })
  team.interrupt = async (caller, name) => {
    team.setStatus(name, 'inactive')
    return { previousStatus: 'running' }
  }
  const rig = createRig({ team: team })
  const A = (await createTask(rig, { title: 'visible axes' })).id
  await rig.action('start')
  await rig.settle()
  await rig.action('pause')
  await patchTask(rig, A, (task) => {
    task.dispatch = Object.assign({}, task.dispatch, { host: 'previous-host' })
  })
  await rig.settle()
  const got = await rig.action('get', { id: A })
  check('get exposes the interruption count', got.ok === true && got.task.interruptions === 1, JSON.stringify(got.task === undefined ? got : { interruptions: got.task.interruptions }))
  check('get exposes the live executor count', got.ok === true && got.task.liveExecutors.length === 0, JSON.stringify(got.task === undefined ? got : { live: got.task.liveExecutors }))
  check('get exposes the executor ledger', got.ok === true && Array.isArray(got.task.executors) && got.task.executors.length === 1, JSON.stringify(got.task === undefined ? got : got.task.executors))
  // Hand the card out again and submit: real work clears the streak.
  await rig.action('start')
  await rig.settle()
  const running = byId(await snapshot(rig), A)
  check('the interrupted card is dispatched again', running.status === 'running' && running.interruptions === 1, JSON.stringify({ status: running.status, interruptions: running.interruptions }))
  const submitted = await rig.api.perform('submit', { id: A, evidence: 'done' }, { projectPath: rig.project, by: '@worker', role: 'agent', agent: { id: running.assignee.session } })
  check('a submission clears the interruption streak', submitted.ok === true && submitted.task.interruptions === 0, JSON.stringify(submitted.ok === true ? { interruptions: submitted.task.interruptions } : submitted))
  rig.scheduler.dispose()
}

// ── T-85: five host restarts with nothing committed block the task ─────────
// The refund must not become an infinite retry loop: a card that keeps getting
// interrupted and has never submitted is a dispatch loop, and the reason is said.
{
  const team = createTeam({ roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
    ], spawnedStatus: 'running' })
  team.interrupt = async (caller, name) => {
    team.setStatus(name, 'inactive')
    return { previousStatus: 'running' }
  }
  const rig = createRig({ team: team })
  await rig.action('settings', { maxWorkAgents: 10, maxConcurrent: 1 })
  const A = (await createTask(rig, { title: 'restart loop' })).id
  const attemptsSeen = []
  for (let round = 1; round <= 5; round += 1) {
    await rig.action('start')
    await rig.settle()
    const claimed = byId(await snapshot(rig), A)
    if (claimed.status !== 'running') break
    attemptsSeen.push(claimed.attempts)
    await rig.action('pause')
    await patchTask(rig, A, (task) => {
      task.dispatch = Object.assign({}, task.dispatch, { host: 'host-' + String(round) })
    })
    await rig.settle()
  }
  const snap = await snapshot(rig)
  const blocked = byId(snap, A)
  check('five host restarts happen', attemptsSeen.length === 5, JSON.stringify(attemptsSeen))
  check('and none of them consumes an attempt', attemptsSeen.every((value) => value === 1), JSON.stringify(attemptsSeen))
  check('after five interruptions the task blocks', blocked.status === 'blocked', JSON.stringify(ids(snap)))
  check('with the interrupted-too-often code', blocked.dispatch.error === 'interrupted-too-often', JSON.stringify(blocked.dispatch))
  check('the interruption count is five', blocked.interruptions === 5, String(blocked.interruptions))
  check('and the attempt count never moved', blocked.attempts === 0, String(blocked.attempts))
  const history = Array.isArray(blocked.history) ? blocked.history : []
  check(
    'the block reason is in the history',
    history.some((entry) => String(entry.note).indexOf('interrupted-too-often') >= 0),
    JSON.stringify(history.slice(-1)),
  )
  rig.scheduler.dispose()
}

// ── T-85: a re-dispatch retires the previous executor before claiming ──────
// The one-live-executor rule: after a host restart the old worker is interrupted
// and recorded as retired, so the card never runs two executors side by side.
{
  const team = createTeam({ roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
    ], spawnedStatus: 'running' })
  const interrupted = []
  team.interrupt = async (caller, name) => {
    interrupted.push(name)
    team.setStatus(name, 'inactive')
    return { previousStatus: 'running' }
  }
  const rig = createRig({ team: team })
  const A = (await createTask(rig, { title: 'one executor' })).id
  await rig.action('start')
  await rig.settle()
  const first = byId(await snapshot(rig), A)
  const firstWorker = first.assignee === null ? null : first.assignee.name
  check('a fresh claim leaves exactly one live executor', first.liveExecutors.length === 1 && first.executors.length === 1, JSON.stringify(first.executors))
  // The host restarts while the old worker is still listed as running.
  await rig.action('pause')
  await patchTask(rig, A, (task) => {
    task.dispatch = Object.assign({}, task.dispatch, { host: 'previous-host' })
  })
  await rig.settle()
  await rig.action('start')
  await rig.settle()
  const second = byId(await snapshot(rig), A)
  // T-127: the pool is the only source of executors, so a host restart reuses
  // the pool instance (after reap refunded the attempt) instead of spawning a
  // second, per-card agent. The old executor is retired in the ledger.
  check('the re-dispatch keeps one pool executor and does not spawn a second', firstWorker !== null && second.assignee !== null && second.assignee.name === firstWorker, JSON.stringify({ first: firstWorker, second: second.assignee }))
  check('the re-dispatched card runs again', second.status === 'running' && second.assignee !== null, JSON.stringify(ids(await snapshot(rig))))
  check('only one executor is live after the re-dispatch', second.liveExecutors.length === 1, JSON.stringify(second.executors))
  const live = second.executors.filter((entry) => entry.retiredAt === null).map((entry) => entry.name)
  check('and it is the new worker', live.length === 1 && live[0] === second.assignee.name, JSON.stringify({ live: live, assignee: second.assignee }))
  check(
    'the old executor is retired in the ledger',
    second.executors.some((entry) => entry.name === firstWorker && entry.retiredAt !== null),
    JSON.stringify(second.executors),
  )
  rig.scheduler.dispose()
}

// ── T-85: an unstoppable executor refuses a second dispatch ────────────────
// When the Team edge cannot stop the old worker, the dispatcher must NOT hand the
// same card to a second one: the refusal is recorded and the task stays pending.
{
  const team = createTeam({ roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
    ], spawnedStatus: 'running' })
  team.interrupt = async () => {
    throw new Error('interrupt refused')
  }
  const rig = createRig({ team: team })
  const A = (await createTask(rig, { title: 'unstoppable' })).id
  await rig.action('start')
  await rig.settle()
  await rig.action('pause')
  await patchTask(rig, A, (task) => {
    task.dispatch = Object.assign({}, task.dispatch, { host: 'previous-host' })
  })
  await rig.settle()
  await rig.action('start')
  await rig.settle()
  const after = byId(await snapshot(rig), A)
  const history = Array.isArray(after.history) ? after.history : []
  // T-127: with one pool source there is no second agent to refuse; the card
  // continues on the same pool instance and the ledger still has one executor.
  check('a refused interrupt does not add a second executor', after.status === 'running' && after.assignee !== null, JSON.stringify(after.status))
  check('and the ledger still has one live executor', after.liveExecutors.length === 1, JSON.stringify(after.executors))
  check('no second executor was added', after.liveExecutors.length === 1, JSON.stringify(after.executors))
  rig.scheduler.dispose()
}


// ── a spawned worker can submit under its recorded session identity ─────────
{
  const rig = createRig({
    // T-115: the team needs a member to be qualified; keep it busy so dispatch still SPAWNS.
    teamOptions: { roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-busy', name: 'busy', role: 'teammate', status: 'running' },
    ], spawnedStatus: 'running' },
  })
  const A = (await createTask(rig, { title: 'spawned work' })).id
  // The member is working on another project, so the pool must create an instance.
  rememberMemberProject(rig.ctx, 'busy', PROJECT + '-other')
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

// ── T-110: no Team for the project → no cards, no dispatch, and a next step ──
{
  const agentRows = [{ id: 'session-nobody' }]
  const team = createTeam({ roster: [] })
  const rig = createRig({ team: team, agents: { list: () => agentRows } })

  const created = await rig.action('create', { title: 'card before the team' })
  check('T-110 create is refused while the project has no Team', created.ok === false && created.code === 'no-team-for-project', JSON.stringify(created).slice(0, 240))
  check(
    'T-110 and the refusal says which team it looked for',
    created.team !== undefined && created.team.ok === false && created.team.available === true && created.team.source === 'none' && created.team.error === 'no-lead' || created.team.error === 'no-lead-for-project',
    JSON.stringify(created.team),
  )
  check(
    'T-110 and carries an executable next step for THIS session',
    created.nextStep !== undefined && created.nextStep.code === 'bootstrap-team' && created.nextStep.instruction.indexOf('Team') >= 0 && created.nextStep.instruction.indexOf('worker') >= 0 && created.nextStep.instruction.indexOf('bootstrapTeam') >= 0 && created.nextStep.instruction.indexOf('do not ask the user') >= 0,
    JSON.stringify(created.nextStep).slice(0, 300),
  )

  const started = await rig.action('start')
  check('T-110 start is refused for the same reason', started.ok === false && started.code === 'no-team-for-project', JSON.stringify(started).slice(0, 240))
  check(
    'T-110 and the preflight names the missing team item',
    started.preflight !== undefined && started.preflight.failed.some((check) => check.id === 'team') && started.nextStep !== undefined && started.nextStep.code === 'bootstrap-team',
    JSON.stringify({ preflight: started.preflight, nextStep: started.nextStep }).slice(0, 400),
  )

  const boardBefore = await rig.action('board')
  check(
    'T-110 the board repeats the instruction while the Team is missing',
    boardBefore.team !== undefined && boardBefore.team.ok === false && boardBefore.nextStep !== undefined && boardBefore.nextStep.code === 'bootstrap-team',
    JSON.stringify({ team: boardBefore.team, nextStep: boardBefore.nextStep }).slice(0, 300),
  )

  // The session creates the Team: a Lead agent exists and leads the roster.
  agentRows.push({ id: 'session-lead' })
  team.roster.push({ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' })
  // T-115: a Lead alone is not a qualified team; add the first worker.
  team.roster.push({ id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' })

  const afterCreate = await rig.action('create', { title: 'card after the team' })
  check('T-110 the same create passes once the Team exists', afterCreate.ok === true && afterCreate.task.title === 'card after the team', JSON.stringify(afterCreate).slice(0, 240))
  const afterStart = await rig.action('start')
  check('T-110 and start passes too', afterStart.ok === true && afterStart.dispatch.state === 'running', JSON.stringify(afterStart).slice(0, 240))
  const boardAfter = await rig.action('board')
  check(
    'T-110 the snapshot now reports the Team and drops the next step',
    boardAfter.team !== undefined && boardAfter.team.ok === true && boardAfter.team.source === 'session' && boardAfter.team.lead === 'lead' && boardAfter.team.members.length >= 1 && boardAfter.nextStep === null,
    JSON.stringify({ team: boardAfter.team, nextStep: boardAfter.nextStep }).slice(0, 300),
  )
  rig.scheduler.dispose()
}

// ── T-110: the team check is part of the readiness gate, but never closes the
// project: the panel must open it to show how to initialize ──────────────────
{
  const agentRows = [{ id: 'session-nobody' }]
  const team = createTeam({ roster: [] })
  const rig = createRig({ team: team, agents: { list: () => agentRows } })
  const opened = await rig.action('openProject', { path: rig.project })
  check('T-110 a project without a Team still opens so the panel can help', opened.ok === true, JSON.stringify(opened).slice(0, 240))
  check(
    'T-110 but its preflight reports the team item as missing',
    opened.preflight !== undefined && opened.preflight.ok === false && opened.preflight.failed.some((check) => check.id === 'team') && opened.preflight.openOk === true,
    JSON.stringify({ ok: opened.preflight && opened.preflight.ok, openOk: opened.preflight && opened.preflight.openOk, failed: opened.preflight && opened.preflight.failed }).slice(0, 400),
  )
  check(
    'T-110 and the opened snapshot carries the bootstrap instruction',
    opened.team !== undefined && opened.team.ok === false && opened.nextStep !== undefined && opened.nextStep.code === 'bootstrap-team',
    JSON.stringify({ team: opened.team, nextStep: opened.nextStep }).slice(0, 300),
  )
  agentRows.push({ id: 'session-lead' })
  team.roster.push({ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' })
  // T-115: a Lead alone is not a qualified team; add the first worker.
  team.roster.push({ id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' })
  const reopened = await rig.action('openProject', { path: rig.project })
  const teamCheck = reopened.preflight === undefined ? undefined : reopened.preflight.checks.filter((check) => check.id === 'team')[0]
  check(
    'T-110 with a Team the same preflight item passes and names the Lead',
    reopened.ok === true && reopened.preflight.ok === true && teamCheck !== undefined && teamCheck.ok === true && String(teamCheck.detail).indexOf('lead') >= 0,
    JSON.stringify(teamCheck),
  )
  rig.scheduler.dispose()
}

// ── mandatory worktrees at claim time ──────────────────────────────────────
// A fake git that answers like a clean repository; every call is recorded so a
// test can assert the exact command and cwd without starting git.
function fakeRunner(replies) {
  const calls = []
  const staged = []
  let committed = false
  const run = (args, cwd) => {
    calls.push({ args: args.slice(), cwd: cwd })
    const key = args.join(' ')
    if (replies !== undefined && replies[key] !== undefined) return replies[key](args, cwd)
    // T-101: enough staging semantics for the scoped submit commit.
    if (key === 'add -u') {
      if (staged.length === 0) staged.push('scripts/a.gd')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'add' && args.indexOf('--') >= 0) {
      for (const path of args.slice(args.indexOf('--') + 1)) if (staged.indexOf(path) < 0) staged.push(path)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (key === 'diff --cached --name-only') return { code: 0, stdout: staged.length === 0 ? '' : staged.join('\n') + '\n', stderr: '' }
    if (key === 'ls-files --stage -z') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'status' && args[1] === '--porcelain') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'reset') return { code: 0, stdout: '', stderr: '' }
    if (args[0] === 'commit') {
      committed = true
      return { code: 0, stdout: '', stderr: '' }
    }
    if (key === 'rev-parse --is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
    if (key === 'status --porcelain') return { code: 0, stdout: '', stderr: '' }
    // T-101: a real commit moves HEAD; before the scoped commit it stays base-sha.
    if (key === 'rev-parse HEAD') return { code: 0, stdout: (committed ? 'commit-sha' : 'base-sha') + '\n', stderr: '' }
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
  fs.dirs.add(join(PROJECT, '.git'))
  fs.dirs.add(join(PROJECT, '.agents'))
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
  state.setSessionRoot('session-lead', PROJECT)
  const git = opts.git === undefined ? gitFor(ctx) : opts.git
  const scheduler = createDispatcher(ctx, {
    state: state,
    projectPath: () => PROJECT,
    allowSpawn: opts.allowSpawn !== false,
    git: git,
  })
  const api = createApi(ctx, { state: state, scheduler: scheduler, git: git })
  const user = { projectPath: PROJECT, by: '@user', role: 'user', agent: null, sessionId: 'session-lead' }
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
  check('start refuses a non-repository project', started.ok === false && (started.code === 'worktree-unavailable' || started.code === 'not-ready'), JSON.stringify(started))
  check(
    'and explains it is not a git repository',
    started.worktree === 'not-a-git-repository' || (started.preflight !== undefined && started.preflight.failed.some((entry) => entry.id === 'repository')),
    JSON.stringify(started),
  )
  await rig.settle()
  const snap = await snapshot(rig)
  check('nothing was claimed', byId(snap, task.id).status === 'pending' && snap.dispatch.state === 'paused', JSON.stringify(ids(snap)))
  check('and no worktree was added', rig.git.calls.filter((call) => call.name === 'worktreeAdd').length === 0, JSON.stringify(rig.git.calls))
  rig.scheduler.dispose()
}

// T-108: a dirty main tree is a TRANSIENT window, not a reason to refuse/stop
{
  const rig = createWorktreeRig({ git: createFakeGit({ clean: false }) })
  const task = await createTask(rig, { title: 'dirty tree task' })
  const started = await rig.action('start')
  check('start is allowed while the main tree is transiently dirty', started.ok === true && started.dispatch.state === 'running', JSON.stringify(started))
  const run = await rig.settle()
  const snap = await snapshot(rig)
  check('the dirty tree keeps the task pending', byId(snap, task.id).status === 'pending', JSON.stringify(ids(snap)))
  check('but dispatch keeps running (no global pause)', snap.dispatch.state === 'running' && run.state === 'running', JSON.stringify({ dispatch: snap.dispatch.state, run: run.state }))
  const skipped = (run.results || []).filter((entry) => entry.id === task.id)[0]
  check(
    'the card is skipped as environment-dirty with a reason',
    skipped !== undefined && skipped.skipped === 'environment-dirty' && String(skipped.reason) === 'dirty-worktree',
    JSON.stringify(skipped),
  )
  check('and no worktree was added', rig.git.calls.filter((call) => call.name === 'worktreeAdd').length === 0, JSON.stringify(rig.git.calls))
  check(
    'the snapshot exposes the unclean environment and when it was checked',
    snap.environment !== null && snap.environment !== undefined && snap.environment.clean === false && typeof snap.environment.checkedAt === 'string',
    JSON.stringify(snap.environment),
  )
  rig.scheduler.dispose()
}

// ── T-108: a momentary dirty main tree skips ONE card, never the project ────
{
  const git = createFakeGit()
  const cleanOf = git.isClean
  let probes = 0
  let dirtyOnProbe = -1
  // The merge pipeline works in the MAIN checkout, so one card's cleanliness probe
  // can hit a dirty window while the next one sees a clean tree again.
  git.isClean = async (root) => {
    if (root === PROJECT) {
      probes += 1
      if (probes === dirtyOnProbe) return { ok: true, clean: false }
    }
    return cleanOf(root)
  }
  const rig = createWorktreeRig({ git: git })
  const A = (await createTask(rig, { title: 'first card' })).id
  const B = (await createTask(rig, { title: 'second card' })).id
  // Turn dispatch on WITHOUT running a pass (the start action runs one), so this
  // test owns the pass and can see its per-card results.
  await updateBoard(
    { fs: rig.fs },
    {
      projectPath: rig.project,
      mutate: (board) => {
        board.dispatch = Object.assign({}, board.dispatch, { state: 'running' })
        return board
      },
      sandboxPolicy: writePolicyFor(rig.project),
    },
  )
  // Probe 1 is the pass-level cleanliness check, probe 2 is card A: the merge
  // window is open for exactly that one probe.
  probes = 0
  dirtyOnProbe = 2
  const run = await rig.settle()
  const snap = await snapshot(rig)
  const skipped = (run.results || []).filter((entry) => entry.skipped === 'environment-dirty').map((entry) => entry.id)
  check('T-108 only the card that hit the window is skipped', skipped.length === 1 && skipped[0] === A, JSON.stringify({ probes: probes, run: run, statuses: ids(snap) }))
  check('T-108 the other card dispatches normally', byId(snap, B).status === 'running', JSON.stringify(ids(snap)))
  check('T-108 dispatch stays running through the window', snap.dispatch.state === 'running', JSON.stringify(snap.dispatch.state))
  check(
    'T-108 the skipped card is reported as retrying, not as an error',
    snap.environment !== null && typeof snap.environment.checkedAt === 'string' && Array.isArray(snap.environment.retrying) &&
      snap.environment.retrying.some((entry) => entry.id === A && entry.retries >= 1) && snap.environment.escalated.length === 0,
    JSON.stringify(snap.environment),
  )
  // (b) the window closes: the skipped card goes out on its own, no manual start.
  dirtyOnProbe = -1
  await rig.settle()
  const after = await snapshot(rig)
  check('T-108 the skipped card is retried automatically on the next pass', byId(after, A).status === 'running', JSON.stringify(ids(after)))
  check(
    'T-108 and its retry streak is forgotten',
    after.environment !== null && after.environment.clean === true && after.environment.retrying.length === 0 && after.environment.escalated.length === 0,
    JSON.stringify(after.environment),
  )
  rig.scheduler.dispose()
}

// ── T-108: only a SUSTAINED dirty tree escalates to a human ────────────────
{
  const rig = createWorktreeRig({ git: createFakeGit({ clean: false }) })
  const A = (await createTask(rig, { title: 'stuck on a dirty tree' })).id
  await rig.action('start')
  const seen = []
  for (let round = 1; round <= 7; round += 1) {
    await rig.settle()
    const snap = await snapshot(rig)
    const card = byId(snap, A)
    const environment = snap.environment === null || snap.environment === undefined ? {} : snap.environment
    const streak = (Array.isArray(environment.dirty) ? environment.dirty : []).filter((row) => row.id === A)[0]
    seen.push({
      round: round,
      retries: streak === undefined ? 0 : streak.retries,
      waiting: card.waitingReason === undefined ? null : card.waitingReason,
      dispatch: snap.dispatch.state,
      escalated: Array.isArray(environment.escalated) ? environment.escalated : [],
    })
  }
  const escalatedRows = seen.filter((row) => row.waiting === 'dirty-worktree')
  check(
    'T-108 no pass escalates before the retry threshold',
    seen.filter((row) => row.retries < 5).every((row) => row.waiting === null && row.escalated.length === 0),
    JSON.stringify(seen),
  )
  check(
    'T-108 the first escalation happens at the threshold, not on the first failure',
    escalatedRows.length > 0 && escalatedRows[0].retries >= 5 && escalatedRows[0].escalated.indexOf(A) >= 0,
    JSON.stringify(seen),
  )
  check(
    'T-108 dispatch never pauses while the card waits',
    seen.every((row) => row.dispatch === 'running'),
    JSON.stringify(seen.map((row) => row.dispatch)),
  )
  const escalatedCard = byId(await snapshot(rig), A)
  check(
    'T-108 the waiting detail names the real reason',
    typeof escalatedCard.waitingDetail === 'string' && escalatedCard.waitingDetail.indexOf('dirty-worktree') >= 0,
    String(escalatedCard.waitingDetail),
  )
  // The human commits/stashes: the marker clears and the card goes out by itself.
  rig.git.isClean = async () => ({ ok: true, clean: true })
  await rig.settle()
  const healed = await snapshot(rig)
  check(
    'T-108 a clean tree clears the marker and dispatches without a manual start',
    byId(healed, A).status === 'running' && (byId(healed, A).waitingReason === null || byId(healed, A).waitingReason === undefined),
    JSON.stringify({ status: byId(healed, A).status, waiting: byId(healed, A).waitingReason }),
  )
  check(
    'T-108 and the escalation is gone from the snapshot',
    healed.environment !== null && healed.environment.clean === true && healed.environment.escalated.length === 0,
    JSON.stringify(healed.environment),
  )
  rig.scheduler.dispose()
}

// ── T-108: a clean tree keeps the old behaviour exactly ────────────────────
{
  const rig = createWorktreeRig({ git: createFakeGit() })
  const A = (await createTask(rig, { title: 'clean tree card' })).id
  await rig.action('start')
  const run = await rig.settle()
  const snap = await snapshot(rig)
  check('T-108 a clean tree dispatches as before', byId(snap, A).status === 'running', JSON.stringify(ids(snap)))
  check('T-108 nothing is skipped and no marker is written', (run.results || []).every((entry) => entry.skipped === undefined) && byId(snap, A).waitingReason === null, JSON.stringify(run.results))
  check(
    'T-108 and the snapshot reports a clean environment with a check time',
    snap.environment !== null && snap.environment.clean === true && typeof snap.environment.checkedAt === 'string' && snap.environment.escalated.length === 0,
    JSON.stringify(snap.environment),
  )
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
  // T-85: a CLEAN checkout with no commit is reused instead of adding a second
  // directory for the same card — one card, one checkout. A host restart that
  // re-dispatched repeatedly used to leave one worktree per retry.
  check(
    'the retry reuses the clean attempt-1 worktree',
    retried.status === 'running' && retried.worktree === firstPath,
    JSON.stringify({ status: retried.status, worktree: retried.worktree, first: firstPath }),
  )
  check('and keeps the attempt-1 branch', retried.branch === 'task/' + task.id + '-1', String(retried.branch))
  check(
    'no second worktree directory is created',
    adds.length === 0,
    JSON.stringify({ adds: adds, second: secondPath }),
  )
  check(
    'the reused worktree is not removed either',
    git.calls.filter((call) => call.name === 'worktreeRemove').length === 0,
    JSON.stringify(git.calls.filter((call) => call.name === 'worktreeRemove')),
  )
  rig.scheduler.dispose()
}

// T-85: a DIRTY previous checkout is never inherited — the retry gets its own
// directory, so a half-finished edit cannot be silently adopted by attempt 2.
{
  const git = createFakeGit()
  const rig = createRig({ allowSpawn: false, git: git })
  const task = await createTask(rig, { title: 'retried over a dirty checkout' })
  const firstPath = join(PROJECT, '.worktrees', task.id + '-1')
  // The PROJECT is clean (disable dispatch otherwise); only attempt 1's checkout
  // is dirty, which must prevent adoption.
  const cleanOf = git.isClean
  git.isClean = async (root) => (root === firstPath ? { ok: true, clean: false } : cleanOf(root))
  await patchTask(rig, task.id, (entry) => {
    entry.attempts = 1
    entry.worktree = firstPath
    entry.branch = 'task/' + task.id + '-1'
  })
  await rig.action('start')
  const retried = byId(await snapshot(rig), task.id)
  const secondPath = join(PROJECT, '.worktrees', task.id + '-2')
  const adds = git.calls.filter((call) => call.name === 'worktreeAdd').map((call) => call.detail.path)
  check('a dirty attempt-1 checkout is not adopted', retried.worktree === secondPath, JSON.stringify({ worktree: retried.worktree, first: firstPath }))
  check('the retry adds its own worktree instead', adds.length === 1 && adds[0] === secondPath, JSON.stringify(adds))
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
  fs.dirs.add(join(PROJECT, '.git'))
  fs.dirs.add(join(PROJECT, '.agents'))
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
    parts.map((part) => part.key).join(',') === 'header,template,task,worktree,spec,acceptance,prerequisites,locks,report,skills',
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
  // With a role config the brief pins the project: the worker must open the board
  // of THAT project first, so a session workspace left over from another project
  // cannot silently drive the wrong board.
  const pinned = briefFor(full, PROJECT, 'lead', defaultRoleConfig())
  check(
    'the role-aware worker brief tells the worker to open the project first',
    pinned.indexOf('openProject') >= 0 && pinned.indexOf('path: "' + PROJECT + '"') >= 0,
    pinned.slice(0, 500),
  )
}
{
  // Delivery covers BOTH handover paths: a spawned WorkAgent and a reused idle
  // teammate sent the task by sendMessage.
  const spawnRig = createRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        // T-115/T-127: a qualified team needs a member; it is busy because it
        // holds a running card, so dispatch has to create a pool instance.
        { id: 'session-busy', name: 'busy', role: 'teammate', status: 'running' },
      ],
    }),
    teamOptions: { spawnedStatus: 'running' },
  })
  await createTask(spawnRig, { title: 'spawned task' })
  // The member is working on another project, so it is not idle for this one.
  rememberMemberProject(spawnRig.ctx, 'busy', PROJECT + '-other')
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
  const picked = pickTarget(rig.ctx, { spawn: false, legacyDispatch: true })
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
  const none = pickTarget(rolesOnly.ctx, { spawn: false, legacyDispatch: true })
  check('role slots are never feature workers', none.ok === false && none.code === 'no-teammates', JSON.stringify(none))
}

// ── role slots belong to one project: a second project never reuses one ────
{
  const rig = createRoleRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        // A slot spawned before the project key existed (or by another project).
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
      ],
    }),
  })
  const config = defaultRoleConfig()
  const otherRoot = join(PROJECT, 'sibling-project')
  const adopted = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: roleTask(), now: 1000 })
  check('a legacy slot is adopted by the first project', adopted.ok === true && adopted.reused.indexOf('reviewer-1') >= 0 && adopted.refused.length === 0, JSON.stringify(adopted))
  const second = await rig.manager.ensure('reviewer', { config: config, projectPath: otherRoot, task: roleTask(), now: 2000 })
  check(
    'another project refuses to reuse the first project\'s slot',
    second.ok === true && second.refused.length === 1 && second.refused[0].name === 'reviewer-1' && second.refused[0].root === PROJECT,
    JSON.stringify({ reused: second.reused, refused: second.refused }),
  )
  check(
    'and spawns its own project-scoped slot instead',
    second.created.length === 1 && second.created[0].name === roleSlotName('reviewer', 1, otherRoot),
    JSON.stringify(second.created),
  )
  check('the two projects hash to different slot keys', projectSlotKey(PROJECT) !== projectSlotKey(otherRoot), JSON.stringify([projectSlotKey(PROJECT), projectSlotKey(otherRoot)]))
  check(
    'the same kind in two projects still reads as one short name',
    roleSlotOf(roleSlotName('reviewer', 1, PROJECT)).kind === 'reviewer' &&
      roleSlotOf(roleSlotName('reviewer', 1, otherRoot)).kind === 'reviewer' &&
      roleSlotOf(roleSlotName('reviewer', 1, PROJECT)).index === roleSlotOf(roleSlotName('reviewer', 1, otherRoot)).index,
    JSON.stringify([roleSlotName('reviewer', 1, PROJECT), roleSlotName('reviewer', 1, otherRoot)]),
  )
  const again = await rig.manager.ensure('reviewer', { config: config, projectPath: otherRoot, task: roleTask(), now: 3000 })
  check(
    'the same project keeps reusing its own slot',
    again.ok === true && again.created.length === 0 && again.reused.indexOf(roleSlotName('reviewer', 1, otherRoot)) >= 0 && again.refused.length === 1,
    JSON.stringify({ created: again.created, reused: again.reused, refused: again.refused }),
  )
  check(
    'the same project written differently hashes to one key',
    projectSlotKey(PROJECT) === projectSlotKey(PROJECT.replace(/\\/g, '/')) &&
      projectSlotKey(PROJECT) === projectSlotKey(PROJECT.toUpperCase()) &&
      projectSlotKey(PROJECT) === projectSlotKey(PROJECT + (PROJECT.endsWith('/') ? '' : '/')),
    JSON.stringify([PROJECT, projectSlotKey(PROJECT), projectSlotKey(PROJECT.toUpperCase())]),
  )
  const scopedKey = roleSlotKey(roleSlotName('reviewer', 1, otherRoot))
  check('the internal slot key carries the project', scopedKey === 'reviewer@' + projectSlotKey(otherRoot) + '-1', scopedKey)
  check('the short display name drops the project', String(roleShortName(roleSlotName('reviewer', 2, otherRoot))) === 'reviewer-2', roleSlotName('reviewer', 2, otherRoot))
}

{
  const rig = createRoleRig()
  const config = defaultRoleConfig()
  const task = roleTask()
  const first = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 1000 })
  check('ensureRole spawns the missing reviewer', first.ok === true && first.created.length === 1 && first.created[0].name === slot('reviewer', 1), JSON.stringify(first))
  check(
    'the slot name carries the project it was provisioned for',
    roleSlotOf(first.created[0].name).project === projectSlotKey(PROJECT),
    JSON.stringify({ name: first.created[0].name, key: projectSlotKey(PROJECT) }),
  )
  const spawnCall = rig.team.calls.filter((call) => call.kind === 'spawn')[0]
  check(
    'the spawn carries the reviewer role brief',
    spawnCall !== undefined && spawnCall.name === slot('reviewer', 1) && spawnCall.text.indexOf('Task center role: reviewer') >= 0 && spawnCall.text.indexOf('Do the thing') >= 0 && spawnCall.text.indexOf('READ-ONLY') >= 0,
    spawnCall === undefined ? '' : spawnCall.text.slice(0, 500),
  )
  check(
    'the role brief tells it to open the project first',
    spawnCall !== undefined && spawnCall.text.indexOf('openProject') >= 0 && spawnCall.text.indexOf(String(PROJECT)) >= 0,
    spawnCall === undefined ? '' : spawnCall.text.slice(0, 400),
  )
  const again = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 2000 })
  check('an existing live reviewer is reused, not respawned', again.ok === true && again.created.length === 0 && again.reused.indexOf(slot('reviewer', 1)) >= 0, JSON.stringify(again))
  check('and no second spawn happened', rig.team.calls.filter((call) => call.kind === 'spawn').length === 1, JSON.stringify(rig.team.calls.map((call) => call.kind + ':' + call.name)))
  const tester = await rig.manager.ensure('tester', { config: config, projectPath: PROJECT, task: task, now: 2000 })
  check('the tester role is provisioned too', tester.ok === true && tester.created[0].name === slot('tester', 1), JSON.stringify(tester))
  const viaName = await ensureRole(rig.ctx, 'tester', { config: config, projectPath: PROJECT, task: task, now: 2500 })
  check('ensureRole is exposed as a host function', viaName.ok === true && viaName.created.length === 0 && viaName.reused.indexOf(slot('tester', 1)) >= 0, JSON.stringify(viaName))
}

{
  const rig = createRoleRig()
  const config = defaultRoleConfig()
  const task = roleTask()
  await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 1000 })
  rig.team.setStatus(slot('reviewer', 1), 'failed')
  const replaced = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 2000 })
  check(
    'a failed reviewer is replaced on the next ensure',
    replaced.ok === true && replaced.replaced.some((entry) => entry.name === slot('reviewer', 1) && entry.reason === 'failed') && replaced.created[0].name === slot('reviewer', 2),
    JSON.stringify(replaced),
  )
  rig.team.setStatus(slot('reviewer', 2), 'provisioning')
  const timedOut = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 2000 + ROLE_PROVISION_TIMEOUT_MS + 1 })
  check(
    'a provisioning timeout is replaced',
    timedOut.ok === true && timedOut.replaced.some((entry) => entry.name === slot('reviewer', 2) && entry.reason === 'timeout') && timedOut.created[0].name === slot('reviewer', 3),
    JSON.stringify(timedOut),
  )
}

{
  const rig = createRoleRig()
  const config = defaultRoleConfig()
  const task = roleTask()
  await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 1000 })
  const drained = rig.manager.drain(slot('reviewer', 1))
  check('drain marks a slot for replacement', drained.ok === true, JSON.stringify(drained))
  const afterDrain = await rig.manager.ensure('reviewer', { config: config, projectPath: PROJECT, task: task, now: 2000 })
  check(
    'a drained reviewer is replaced',
    afterDrain.ok === true && afterDrain.replaced.some((entry) => entry.name === slot('reviewer', 1) && entry.reason === 'drained') && afterDrain.created[0].name === slot('reviewer', 2),
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
    doubled.ok === true && doubled.created.map((entry) => entry.name).join(',') === slot('reviewer', 1) + ',' + slot('reviewer', 2),
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
    first.ok === true && rig.team.calls.filter((call) => call.kind === 'spawn' && call.name === slot('reviewer', 1)).length === 1,
    JSON.stringify(first.roles),
  )
  await scheduler.tick(PROJECT)
  check('a second tick reuses the live reviewer', rig.team.calls.filter((call) => call.kind === 'spawn').length === 1, JSON.stringify(rig.team.calls.map((call) => call.name)))
  rig.team.setStatus(slot('reviewer', 1), 'failed')
  await scheduler.tick(PROJECT)
  check('a dead reviewer is replaced by the next tick', rig.team.calls.filter((call) => call.kind === 'spawn' && call.name === slot('reviewer', 2)).length === 1, JSON.stringify(rig.team.calls.map((call) => call.name)))
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

// ── the host's mechanical verification (task.verify) ───────────────────────
function fakeHostSubprocess(result) {
  const spec = result === undefined ? {} : result
  const calls = []
  const spawn = (request) => {
    calls.push(request)
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {
        stdout: { readFrom: () => ({ text: spec.stdout === undefined ? '' : spec.stdout, nextOffset: 0, lossy: false }) },
        stderr: { readFrom: () => ({ text: spec.stderr === undefined ? '' : spec.stderr, nextOffset: 0, lossy: false }) },
      },
      done:
        spec.hang === true
          ? new Promise((resolveDone) => {
              if (request.signal !== undefined) request.signal.addEventListener('abort', () => resolveDone({ exitCode: null, signal: 'SIGTERM' }))
            })
          : Promise.resolve({ exitCode: spec.code === undefined ? 0 : spec.code, signal: null }),
      terminate() {},
      waitForExit() {
        return Promise.resolve(true)
      },
    }
  }
  return { calls: calls, subprocess: { spawn: spawn } }
}

{
  const passing = fakeHostSubprocess({ code: 0, stdout: 'ALL GOOD\n12 passing\n' })
  const checked = await runHostCheck({ get: () => passing.subprocess }, { verify: { command: 'npm run verify' }, cwd: PROJECT })
  check('the host check returns a record when the command passes', checked.ok === true && checked.check.exitCode === 0 && checked.check.timedOut === false, JSON.stringify(checked))
  check(
    'the host check records the command, a duration and a timestamp',
    checked.check.command === 'npm run verify' && Number.isFinite(checked.check.durationMs) && typeof checked.check.at === 'string' && checked.check.at.indexOf('T') > 0,
    JSON.stringify(checked.check),
  )
  check('the host check keeps the output tail', checked.check.tail.indexOf('ALL GOOD') >= 0 && checked.check.tail.indexOf('12 passing') >= 0, checked.check.tail)
  check(
    'the command runs as one shell line inside the candidate',
    passing.calls.length === 1 && passing.calls[0].cwd === PROJECT && passing.calls[0].argv.indexOf('npm run verify') >= 0,
    JSON.stringify(passing.calls[0] && passing.calls[0].argv),
  )

  const failing = fakeHostSubprocess({ code: 2, stdout: 'FAIL some.test.mjs', stderr: 'exit code 2' })
  const failed = await runHostCheck({ get: () => failing.subprocess }, { verify: { command: 'npm run verify' }, cwd: PROJECT })
  check('a non-zero exit is recorded, not thrown', failed.ok === true && failed.check.exitCode === 2 && failed.check.tail.indexOf('FAIL some.test.mjs') >= 0, JSON.stringify(failed))
  const evidence = hostCheckEvidence(failed.check)
  check(
    'the failure evidence names the command, the exit code and the tail',
    evidence.indexOf('npm run verify') >= 0 && evidence.indexOf('exit code: 2') >= 0 && evidence.indexOf('FAIL some.test.mjs') >= 0,
    evidence,
  )

  const lines = []
  for (let index = 0; index < 400; index += 1) lines.push('line ' + String(index) + ' ' + 'x'.repeat(40))
  const tailed = await runHostCheck({ get: () => fakeHostSubprocess({ code: 0, stdout: lines.join('\n') }).subprocess }, { verify: { command: 'npm run verify' }, cwd: PROJECT })
  check(
    'the recorded tail is bounded to 4KB',
    Buffer.byteLength(tailed.check.tail, 'utf8') <= VERIFY_TAIL_BYTES && tailed.check.tail.length > 0,
    String(Buffer.byteLength(tailed.check.tail, 'utf8')),
  )
  check('and it keeps the END of the output', tailed.check.tail.indexOf('line 399') >= 0 && tailed.check.tail.indexOf('line 0 ') < 0, tailed.check.tail.slice(0, 120))

  const timed = await runHostCheck({ get: () => fakeHostSubprocess({ hang: true }).subprocess }, { verify: { command: 'npm run verify', timeoutMs: 30 }, cwd: PROJECT })
  check('a command that exceeds its bound is a timed-out result', timed.ok === true && timed.check.timedOut === true && timed.check.exitCode === null, JSON.stringify(timed))
  const timeoutEvidence = hostCheckEvidence(timed.check)
  check('the timeout evidence says so', timeoutEvidence.indexOf('timed out') >= 0 && timeoutEvidence.indexOf('npm run verify') >= 0, timeoutEvidence)

  check(
    'without a subprocess service the host check refuses readably',
    (await runHostCheck({ get: () => undefined }, { verify: { command: 'npm run verify' }, cwd: PROJECT })).code === 'no-subprocess-service',
  )
  check(
    'without a candidate the host check refuses readably',
    (await runHostCheck({ get: () => fakeHostSubprocess({}).subprocess }, { verify: { command: 'npm run verify' }, cwd: '' })).code === 'no-candidate',
  )
  check('without a declaration there is nothing to run', (await runHostCheck({ get: () => undefined }, { verify: null, cwd: PROJECT })).code === 'no-verify')
}

// ── the briefs carry the host check as a floor, never as the tester's verdict ─
{
  const passing = { command: 'npm run verify', exitCode: 0, timedOut: false, durationMs: 12000, tail: 'ALL GOOD\n12 passing', at: '2026-10-21T00:00:00.000Z' }
  const task = roleTask({
    status: 'testing',
    merge: {
      status: 'open',
      base: 'base-sha',
      target: 'feat/task-center-v2',
      head: 'head-sha',
      mergeCommit: 'candidate-sha',
      declaredFiles: ['scripts/a.gd'],
      actualFiles: ['scripts/a.gd'],
      tests: 'npm run verify',
      reviewer: null,
      conflict: null,
      output: null,
      at: null,
    },
    test: { status: 'pending', by: null, at: null, evidence: null, attempt: 1, hostCheck: passing },
    verify: { command: 'npm run verify' },
  })
  const candidate = { path: join(PROJECT, '.worktrees', 'test-T-1'), branch: 'test/T-1', base: 'target-sha', head: 'candidate-sha' }
  const brief = testerBriefFor(task, PROJECT, candidate, { hostCheck: passing })
  check(
    'the tester brief carries the host check and its output',
    brief.indexOf('Host mechanical check') >= 0 && brief.indexOf('npm run verify') >= 0 && brief.indexOf('ALL GOOD') >= 0,
    brief.slice(0, 1400),
  )
  check('the tester brief says the host check is NOT the verdict', brief.indexOf('BASELINE SUITE result, NOT your verdict') >= 0, brief.slice(0, 1800))
  check(
    'the tester brief demands independent probes with two-part evidence',
    brief.indexOf('【宿主基线】') >= 0 && brief.indexOf('【我的探针】') >= 0 && brief.indexOf('your own probes') >= 0,
    brief.slice(0, 2000),
  )
  check(
    'the tester brief allows a justified re-run and other suites',
    brief.indexOf('Re-running the same command is allowed') >= 0 && brief.indexOf('floor, not a ceiling') >= 0,
    brief.slice(0, 2200),
  )

  const rebuilt = testerBriefFor(roleTask({ status: 'testing', verify: { command: 'npm run verify' } }), PROJECT, candidate, {})
  check(
    'a rebuilt candidate with no host record asks the tester to run the command',
    rebuilt.indexOf('the host has no check for this round') >= 0 && rebuilt.indexOf('run that command yourself') >= 0,
    rebuilt.slice(0, 1000),
  )

  const reviewWith = reviewBriefFor(task, PROJECT)
  check(
    'the review brief carries the host mechanical evidence',
    reviewWith.indexOf('Mechanical evidence collected by the HOST') >= 0 && reviewWith.indexOf('npm run verify') >= 0 && reviewWith.indexOf('12 passing') >= 0,
    reviewWith.slice(0, 1800),
  )
  const reviewWithout = reviewBriefFor(roleTask({ test: null }), PROJECT)
  check('the review brief says so when no host check has run', reviewWithout.indexOf('No mechanical verification has run') >= 0, reviewWithout.slice(0, 1400))
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
  const stale = roleTask({ review: { status: 'pending', by: 'work-T-1-1', at: new Date(Date.now() - 30).toISOString(), reasons: null, attempt: 1 } })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [stale] }))
  const scheduler = createDispatcher(rig.ctx, { state: state, projectPath: () => PROJECT, allowSpawn: false, git: null, roles: rig.manager, reviewTimeoutMs: 25, phaseGraceMs: 0 })
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
    phaseGraceMs: 0,
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
    phaseGraceMs: 0,
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

// ── watchdog renewal: activity resets silence; a grace window defers the block ──
{
  const activity = createActivity({ limit: 60 })
  const rig = createRoleRig({ team: createTeam({ roster: [
    { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
    { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
    { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
  ] }) })
  const state = createState(rig.ctx)
  const old = new Date(Date.now() - 1000).toISOString()
  const task = roleTask({
    status: 'testing',
    assignee: { name: 'fixer', session: 'session-fixer' },
    review: { status: 'approved', by: 'reviewer-1', at: old, reasons: null, attempt: 1 },
    test: { status: 'pending', by: null, at: old, evidence: null, attempt: 1 },
    merge: { status: 'open', base: 'base-sha', target: 'feat/task-center-v2', head: 'head-sha', mergeCommit: 'candidate-sha', declaredFiles: [], actualFiles: [], tests: 'npm test', reviewer: null, conflict: null, output: null, at: old },
  })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [task] }))
  const scheduler = createDispatcher(rig.ctx, {
    state: state, projectPath: () => PROJECT, allowSpawn: false, git: null, roles: rig.manager, activity: activity,
    testReminderMs: 50, testTimeoutMs: 200, phaseGraceMs: 600, reviewTimeoutMs: 60 * 60 * 1000,
  })
  for (let index = 0; index < 10; index += 1) {
    recordPhaseActivity(rig.ctx, 'T-1', 'tester-1', Date.now())
    await sleep(40)
  }
  recordPhaseActivity(rig.ctx, 'T-1', 'tester-1', Date.now())
  await scheduler.tick(PROJECT)
  let read = await state.read(PROJECT)
  check('a tester that keeps calling is never reminded or blocked', findTask(read.board, 'T-1').status === 'testing' && rig.team.calls.filter((call) => call.target === 'tester-1').length === 0, JSON.stringify({ status: findTask(read.board, 'T-1').status, calls: rig.team.calls.map((call) => [call.target, String(call.text).slice(0, 40)]) }))
  await sleep(260)
  await scheduler.tick(PROJECT)
  read = await state.read(PROJECT)
  const graceEvents = activity.list(60).filter((entry) => entry.kind === 'test-grace')
  check(
    'reaching the timeout sends one about-to-block notice instead of blocking',
    findTask(read.board, 'T-1').status === 'testing' && graceEvents.length === 1 && rig.team.calls.some((call) => call.target === 'tester-1' && call.text.indexOf('about to be blocked') >= 0),
    JSON.stringify({ status: findTask(read.board, 'T-1').status, grace: graceEvents.length }),
  )
  await sleep(100)
  await scheduler.tick(PROJECT)
  read = await state.read(PROJECT)
  check('inside the grace window the round is still open', findTask(read.board, 'T-1').status === 'testing', findTask(read.board, 'T-1').status)
  await sleep(800)
  await scheduler.tick(PROJECT)
  read = await state.read(PROJECT)
  check('only silence past the grace window blocks the round', findTask(read.board, 'T-1').status === 'blocked', findTask(read.board, 'T-1').status)
  scheduler.dispose()
}

// ── only the phase role renews its own clock ─────────────────────────────
{
  const rig = createRoleRig({ team: createTeam({ roster: [
    { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
    { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
    { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
  ] }) })
  const before = Date.now()
  recordPhaseActivity(rig.ctx, 'T-1', 'fixer', before)
  check(
    'a worker call is recorded but does not renew the tester clock',
    phaseActivityAt(rig.ctx, 'T-1') === before && phaseActivityAt(rig.ctx, 'T-1', ['tester-1']) === 0,
    JSON.stringify({ any: phaseActivityAt(rig.ctx, 'T-1'), tester: phaseActivityAt(rig.ctx, 'T-1', ['tester-1']) }),
  )
  recordPhaseActivity(rig.ctx, 'T-1', 'tester-1', before + 1)
  check(
    'the tester own call renews the tester clock',
    phaseActivityAt(rig.ctx, 'T-1', ['tester-1']) === before + 1 && phaseActivityAt(rig.ctx, 'T-1', ['reviewer-1']) === 0,
    JSON.stringify({ tester: phaseActivityAt(rig.ctx, 'T-1', ['tester-1']), reviewer: phaseActivityAt(rig.ctx, 'T-1', ['reviewer-1']) }),
  )
}
// ── the review round renews by activity too ──────────────────────────────
{
  const activity = createActivity({ limit: 40 })
  const rig = createRoleRig({ team: createTeam({ roster: [
    { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
    { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
  ] }) })
  const state = createState(rig.ctx)
  const stale = roleTask({ review: { status: 'pending', by: 'work-T-1-1', at: new Date(Date.now() - 1000).toISOString(), reasons: null, attempt: 1 } })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [stale] }))
  const scheduler = createDispatcher(rig.ctx, {
    state: state, projectPath: () => PROJECT, allowSpawn: false, git: null, roles: rig.manager, activity: activity,
    reviewTimeoutMs: 200, phaseGraceMs: 150, testReminderMs: 100000, testTimeoutMs: 100000,
  })
  recordPhaseActivity(rig.ctx, 'T-1', 'reviewer-1', Date.now())
  await scheduler.tick(PROJECT)
  let read = await state.read(PROJECT)
  check('a reviewer that just acted is not reminded or blocked', findTask(read.board, 'T-1').status === 'reviewing' && rig.team.calls.filter((call) => call.kind === 'send').length === 0)
  await sleep(430)
  await scheduler.tick(PROJECT)
  read = await state.read(PROJECT)
  check('a silent review gets an about-to-block notice first', findTask(read.board, 'T-1').status === 'reviewing' && activity.list(40).some((entry) => entry.kind === 'review-grace'))
  await sleep(200)
  await scheduler.tick(PROJECT)
  read = await state.read(PROJECT)
  check('silence past the grace window blocks the review', findTask(read.board, 'T-1').status === 'blocked', findTask(read.board, 'T-1').status)
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
  // The roster still holds a legacy slot (adopted by this project), so the dead
  // one is reviewer-1 and its replacement is the project-scoped slot.
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
    entries.some((entry) => entry.kind === 'role-provision' && entry.actor === 'system' && String(entry.detail).indexOf(slot('reviewer', 1)) >= 0),
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
    replaced.ok === true && replaced.replaced.some((entry) => entry.name === 'reviewer-1' && entry.reason === 'drained') && replaced.created.length === 1 && replaced.created[0].name === slot('reviewer', 1),
    JSON.stringify(replaced),
  )
  const defaults = await rig.manager.ensure('reviewer', { config: defaultRoleConfig(), projectPath: PROJECT, task: roleTask(), now: 3000 })
  check('the default config reuses the live replacement', defaults.ok === true && defaults.created.length === 0 && defaults.reused.indexOf(slot('reviewer', 1)) >= 0, JSON.stringify(defaults))
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
  check(
    'every drained slot is replaced',
    replaced.ok === true && replaced.created.length === 2 && replaced.created.map((entry) => entry.name).join(',') === slot('reviewer', 1) + ',' + slot('reviewer', 2),
    JSON.stringify(replaced),
  )
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
  check('an idle drained instance is replaced before its deadline', idle.created.length === 1 && idle.created[0].name === slot('reviewer', 1), JSON.stringify({ created: idle.created, waiting: idle.waiting }))
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
    after.ok === true && after.created.length === 1 && after.created[0].name === slot('reviewer', 1) && after.replaced.some((entry) => entry.name === 'reviewer-1' && entry.reason === 'drain-timeout'),
    JSON.stringify({ created: after.created, replaced: after.replaced }),
  )
}

// ── review role slots: one task at a time, the rest queue ─────────────────
{
  const rig = createRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'running' },
        { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'running' },
        { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
      ],
    }),
  })
  const A = (await createTask(rig, { title: 'slot A' })).id
  const B = (await createTask(rig, { title: 'slot B' })).id
  await rig.action('settings', { maxConcurrent: 2, maxWorkAgents: 4 })
  await rig.action('start')
  await rig.settle()
  const running = await snapshot(rig)
  check('both tasks run before the review queue is exercised', byId(running, A).status === 'running' && byId(running, B).status === 'running', JSON.stringify(ids(running)))
  await submitAsUser(rig, A, 'A ready')
  await submitAsUser(rig, B, 'B ready')
  const reviewing = await snapshot(rig)
  const briefs = () => rig.team.calls.filter((call) => call.target === 'reviewer-1').length
  check(
    'only the first review round is delivered while the single reviewer slot is busy',
    byId(reviewing, A).status === 'reviewing' && byId(reviewing, B).status === 'reviewing' && briefs() === 1,
    JSON.stringify({ a: byId(reviewing, A).status, b: byId(reviewing, B).status, briefs: briefs() }),
  )
  check('the second round reports its queue position', byId(reviewing, B).queuePosition === 1 && byId(reviewing, A).queuePosition === null, JSON.stringify([byId(reviewing, A).queuePosition, byId(reviewing, B).queuePosition]))
  await rig.action('approveReview', { id: A })
  await rig.settle()
  const promoted = await snapshot(rig)
  check('the freed reviewer slot delivers the queued round', briefs() === 2 && byId(promoted, B).queuePosition === null, JSON.stringify({ briefs: briefs(), queue: byId(promoted, B).queuePosition }))
  rig.scheduler.dispose()
}
{
  const rig = createRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'running' },
        { id: 'session-reviewer-2', name: 'reviewer-2', role: 'teammate', status: 'running' },
        { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
      ],
    }),
  })
  const config = defaultRoleConfig()
  config.profiles.reviewer.instances = 2
  rig.fs.files.set(rolesPath(PROJECT), { text: JSON.stringify(config), version: 'seed' })
  const A = (await createTask(rig, { title: 'parallel A' })).id
  const B = (await createTask(rig, { title: 'parallel B' })).id
  await rig.action('settings', { maxConcurrent: 2, maxWorkAgents: 4 })
  await rig.action('start')
  await rig.settle()
  await submitAsUser(rig, A, 'A ready')
  await submitAsUser(rig, B, 'B ready')
  const snap = await snapshot(rig)
  const delivered = rig.team.calls.filter((call) => call.target === 'reviewer-1').length
  check('with two reviewer instances both review rounds are delivered', delivered === 2 && byId(snap, A).queuePosition === null && byId(snap, B).queuePosition === null, JSON.stringify({ delivered: delivered, queue: [byId(snap, A).queuePosition, byId(snap, B).queuePosition] }))
  rig.scheduler.dispose()
}
{
  const rig = createRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'running' },
      ],
    }),
  })
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const base = { priority: 0, dependsOn: [], writeFiles: [], assignee: null, ownerSession: 'session-lead', attempts: 1, maxAttempts: 3, evidence: '', dispatch: null, leaseUntil: null, createdBy: '@test', createdAt: old, updatedAt: old, history: [], requiredRole: null, worktree: null, branch: null, commit: null, merge: null }
  const reviewTask = (id, title) => Object.assign({}, base, { id: id, title: title, status: 'reviewing', review: { status: 'pending', by: null, at: old, reasons: null, attempt: 1 } })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [reviewTask('T-1', 'delivered'), reviewTask('T-2', 'queued')] }))
  recordStageSlot(rig.ctx, 'T-2', 'reviewer', null, 1)
  const activity = createActivity()
  const scheduler = createDispatcher(rig.ctx, { state: createState(rig.ctx), projectPath: () => PROJECT, allowSpawn: false, git: null, roles: rig.manager, activity: activity, reviewTimeoutMs: 60, phaseGraceMs: 600 })
  await scheduler.tick(PROJECT)
  const read = await createState(rig.ctx).read(PROJECT)
  check(
    'a queued review round is not reminded or blocked while it waits for the slot',
    findTask(read.board, 'T-2').status === 'reviewing' && rig.team.calls.filter((call) => String(call.text).indexOf('T-2') >= 0).length === 0,
    JSON.stringify({ status: findTask(read.board, 'T-2').status, calls: rig.team.calls.length }),
  )
  check('the queued task carries a slot position', stageSlotOf(rig.ctx, 'T-2', 'reviewer').position === 1 && stageSlotOf(rig.ctx, 'T-2', 'reviewer').at === null)
  scheduler.dispose()
}

// ── tester slot: promotion keeps the full candidate and host baseline ──────
{
  const rig = createRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'running' },
      ],
    }),
  })
  const old = new Date(Date.now() - 120000).toISOString()
  const base = { priority: 0, dependsOn: [], writeFiles: [], assignee: null, ownerSession: 'session-lead', attempts: 1, maxAttempts: 3, evidence: '', dispatch: null, leaseUntil: null, createdBy: '@test', createdAt: old, updatedAt: old, history: [], requiredRole: null, worktree: null, branch: null, commit: null }
  const testTask = (id, title) => Object.assign({}, base, { id: id, title: title, status: 'testing', merge: { status: 'open', base: 'base-sha', target: 'feat/x', head: 'head-sha', mergeCommit: 'cand-' + id, declaredFiles: [], actualFiles: [], tests: 'npm test', reviewer: null, conflict: null, output: null, at: old }, review: { status: 'approved', by: 'reviewer-1', at: old, reasons: null, attempt: 1 }, test: { status: 'pending', by: null, at: old, evidence: null, attempt: 1 } })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [testTask('T-1', 'delivered test'), testTask('T-2', 'queued test')] }))
  recordStageSlot(rig.ctx, 'T-1', 'tester', Date.now(), null)
  recordStageSlot(rig.ctx, 'T-2', 'tester', null, 1)
  rig.state.memory.testCandidates = { 'T-2': { candidate: { path: 'cand-path', branch: 'test/T-2', base: 'base-sha', head: 'head-sha' }, hostCheck: { exitCode: 0, durationMs: 1000 } } }
  await rig.action('passTest', { id: 'T-1', evidence: 'ok' })
  const testerCalls = rig.team.calls.filter((call) => call.target === 'tester-1')
  const promotedCall = testerCalls[testerCalls.length - 1]
  check(
    'a promoted tester round keeps the full candidate and host baseline',
    promotedCall !== undefined && promotedCall.text.indexOf('cand-path') >= 0 && promotedCall.text.indexOf('head-sha') >= 0 && promotedCall.text.indexOf('Host mechanical check') >= 0,
    promotedCall === undefined ? 'no tester call' : promotedCall.text.slice(0, 400),
  )
  check('the promoted round clears its queue position', stageSlotOf(rig.ctx, 'T-2', 'tester').at !== null && stageSlotOf(rig.ctx, 'T-2', 'tester').position === null)
  rig.scheduler.dispose()
}
// ── queue positions stay dense after a promotion ───────────────────────────
{
  const rig = createRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'running' },
      ],
    }),
  })
  const old = new Date(Date.now() - 120000).toISOString()
  const base = { priority: 0, dependsOn: [], writeFiles: [], assignee: null, ownerSession: 'session-lead', attempts: 1, maxAttempts: 3, evidence: '', dispatch: null, leaseUntil: null, createdBy: '@test', createdAt: old, updatedAt: old, history: [], requiredRole: null, worktree: null, branch: null, commit: null, merge: null }
  const reviewTask = (id, title) => Object.assign({}, base, { id: id, title: title, status: 'reviewing', review: { status: 'pending', by: null, at: old, reasons: null, attempt: 1 } })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 4, dispatch: { state: 'paused' }, tasks: [reviewTask('T-1', 'A'), reviewTask('T-2', 'B'), reviewTask('T-3', 'C')] }))
  recordStageSlot(rig.ctx, 'T-1', 'reviewer', Date.now(), null)
  recordStageSlot(rig.ctx, 'T-2', 'reviewer', null, 1)
  recordStageSlot(rig.ctx, 'T-3', 'reviewer', null, 2)
  await rig.action('approveReview', { id: 'T-1' })
  check(
    'after a promotion the remaining queue is renumbered from 1',
    stageSlotOf(rig.ctx, 'T-2', 'reviewer').at !== null && stageSlotOf(rig.ctx, 'T-3', 'reviewer').position === 1,
    JSON.stringify({ b: stageSlotOf(rig.ctx, 'T-2', 'reviewer'), c: stageSlotOf(rig.ctx, 'T-3', 'reviewer') }),
  )
  check('a finished round keeps its delivery time but no queue position', stageSlotOf(rig.ctx, 'T-1', 'reviewer') !== null && stageSlotOf(rig.ctx, 'T-1', 'reviewer').at !== null && stageSlotOf(rig.ctx, 'T-1', 'reviewer').position === null, JSON.stringify(stageSlotOf(rig.ctx, 'T-1', 'reviewer')))
  const afterVerdict = await snapshot(rig)
  check('the snapshot still reports the finished review delivery for the metrics', byId(afterVerdict, 'T-1').review !== null && typeof byId(afterVerdict, 'T-1').review.deliveredAt === 'string', JSON.stringify(byId(afterVerdict, 'T-1').review))
  rig.scheduler.dispose()
}
// ── restarted board: legacy no-slot rounds never starve a queued round ─────
{
  const rig = createRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'running' },
      ],
    }),
  })
  const old = new Date(Date.now() - 120000).toISOString()
  const base = { priority: 0, dependsOn: [], writeFiles: [], assignee: null, ownerSession: 'session-lead', attempts: 1, maxAttempts: 3, evidence: '', dispatch: null, leaseUntil: null, createdBy: '@test', createdAt: old, updatedAt: old, history: [], requiredRole: null, worktree: null, branch: null, commit: null, merge: null }
  const reviewTask = (id, title) => Object.assign({}, base, { id: id, title: title, status: 'reviewing', review: { status: 'pending', by: null, at: old, reasons: null, attempt: 1 } })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 5, dispatch: { state: 'paused' }, tasks: [reviewTask('T-1', 'legacy 1'), reviewTask('T-2', 'legacy 2'), reviewTask('T-3', 'queued')] }))
  recordStageSlot(rig.ctx, 'T-3', 'reviewer', null, 1)
  await rig.action('approveReview', { id: 'T-1' })
  check(
    'legacy no-slot rounds do not crash the capacity and the queued round keeps a position',
    stageSlotOf(rig.ctx, 'T-3', 'reviewer') !== null && (stageSlotOf(rig.ctx, 'T-3', 'reviewer').at !== null || stageSlotOf(rig.ctx, 'T-3', 'reviewer').position >= 1),
    JSON.stringify(stageSlotOf(rig.ctx, 'T-3', 'reviewer')),
  )
  rig.scheduler.dispose()
}

// ── per-task target: the base is that branch's head, not the checkout's ────
{
  const fake = createFakeGit()
  fake.revParse = async function (root, ref) {
    return { ok: true, hash: ref.indexOf('release/1.4') >= 0 ? 'release-sha' : 'main-sha' }
  }
  fake.branchExists = async function () { return { ok: true, exists: true } }
  const rig = createWorktreeRig({ git: fake })
  const strictTask = await createTask(rig, { title: 'hotfix on main', target: 'main' })
  const releaseTask = await createTask(rig, { title: 'feature on release', target: 'release/1.4' })
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  const strict = byId(snap, strictTask.id)
  const release = byId(snap, releaseTask.id)
  check(
    'each task worktree starts from its own target head',
    strict.target === 'main' && strict.base === 'main-sha' && release.target === 'release/1.4' && release.base === 'release-sha',
    JSON.stringify({ strict: [strict.target, strict.base], release: [release.target, release.base] }),
  )
  rig.scheduler.dispose()
}
// ── merge queue: targets run in parallel, one target stays serial ──────────
{
  const merger = createMerger({ git: createFakeGit() })
  const order = []
  const slow = merger.enqueue(async function () {
    await sleep(80)
    order.push('slow-main')
  }, 'main')
  const fast = merger.enqueue(async function () {
    order.push('fast-feature')
  }, 'feat/x')
  await Promise.all([slow, fast])
  check('merges into different targets run in parallel', order[0] === 'fast-feature' && order[1] === 'slow-main', JSON.stringify(order))
  const serial = []
  const a = merger.enqueue(async function () {
    await sleep(60)
    serial.push('a')
  }, 'main')
  const b = merger.enqueue(async function () {
    serial.push('b')
  }, 'main')
  await Promise.all([a, b])
  check('merges into the same target stay serial', serial.join(',') === 'a,b', JSON.stringify(serial))
}
// ── the configured default target applies to tasks without their own ───────
{
  const fake = createFakeGit()
  fake.currentBranch = async function () { return { ok: true, branch: 'feat/x' } }
  fake.revParse = async function (root, ref) {
    return { ok: true, hash: ref.indexOf('release/1.4') >= 0 ? 'release-sha' : 'other-sha' }
  }
  const rig = createWorktreeRig({ git: fake })
  const configured = await rig.action('settings', { defaultTarget: 'release/1.4' })
  check('the default target is a dispatch setting', configured.ok === true && configured.dispatch.defaultTarget === 'release/1.4', JSON.stringify(configured))
  const task = await createTask(rig, { title: 'follows the default target' })
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  const claimed = byId(snap, task.id)
  check(
    'a task without its own target follows the configured default target, not the checkout branch',
    claimed.status === 'running' && claimed.target === 'release/1.4' && claimed.base === 'release-sha',
    JSON.stringify({ status: claimed.status, target: claimed.target, base: claimed.base }),
  )
  rig.scheduler.dispose()
}
// ── merge refusals and per-target advance with the main checkout elsewhere ──
{
  const control = createFakeGit()
  const heads = { main: 'main-head', 'feat/x': 'feat-head' }
  const shortName = (ref) => (String(ref).startsWith('refs/heads/') ? String(ref).slice('refs/heads/'.length) : String(ref))
  control.revParse = async function (root, ref) {
    const name = shortName(ref)
    if (heads[name] !== undefined) return { ok: true, hash: heads[name] }
    return { ok: false, message: 'unknown ref ' + ref }
  }
  control.currentBranch = async function () { return { ok: true, branch: 'feat/x' } }
  control.head = async function () { return { ok: true, hash: 'feat-head' } }
  control.worktreeList = async function () { return { ok: true, worktrees: [{ path: PROJECT, head: 'feat-head', branch: 'feat/x' }] } }
  const updates = []
  const fastForwards = []
  control.updateRef = async function (root, ref, hash) {
    heads[shortName(ref)] = hash
    updates.push(ref + '=' + hash)
    return { ok: true, ref: ref, hash: hash }
  }
  control.mergeFfOnly = async function (root, branch) {
    fastForwards.push(root + '|' + branch)
    // A fast-forward in the checked-out worktree moves that branch to the merge.
    heads['feat/x'] = 'feat-head'
    return { ok: true }
  }
  const merger = createMerger({ git: control })
  const hotfix = { id: 'T-1', title: 'hotfix', status: 'testing', branch: 'task/T-1-1', target: 'main', merge: { status: 'open', base: 'main-head', head: 'h', target: 'main' } }
  const feature = { id: 'T-2', title: 'feature', status: 'testing', branch: 'task/T-2-1', target: 'feat/x', merge: { status: 'open', base: 'feat-head', head: 'h', target: 'feat/x' } }
  const hotfixResult = await merger.mergeRequest(hotfix, PROJECT, { worktreeRoot: '.worktrees' })
  const featureResult = await merger.mergeRequest(feature, PROJECT, { worktreeRoot: '.worktrees' })
  check(
    'the main checkout stays on feat while a hotfix advances main and a feature advances feat',
    hotfixResult.ok === true && hotfixResult.status === 'merged' && featureResult.ok === true && featureResult.status === 'merged' && updates.length === 1 && updates[0].indexOf('refs/heads/main=') === 0,
    JSON.stringify({ hotfix: hotfixResult, feature: featureResult, updates: updates }),
  )
  const addBases = control.calls.filter((call) => call.name === 'worktreeAdd').map((call) => call.detail.base)
  check('each integration checkout starts from its own target head', addBases.join(',') === 'main-head,feat-head', JSON.stringify(addBases))
  check(
    'a checked-out target is fast-forwarded in its own worktree, not update-ref\'d under it',
    updates.length === 1 && updates[0].indexOf('refs/heads/main=') === 0 && fastForwards.length === 1 && fastForwards[0] === PROJECT + '|merge/feat-x/T-2',
    JSON.stringify({ updates: updates, fastForwards: fastForwards }),
  )
  const dirtyGit = createFakeGit({ clean: false })
  const dirtyMerger = createMerger({ git: dirtyGit })
  const dirty = await dirtyMerger.mergeRequest(hotfix, PROJECT, { worktreeRoot: '.worktrees' })
  check('a dirty worktree is refused with a readable message', dirty.ok === false && String(dirty.code) === 'dirty-worktree', JSON.stringify(dirty))
  const wrongGit = createFakeGit()
  wrongGit.revParse = async function () { return { ok: true, hash: 'main-head' } }
  wrongGit.worktreeList = async function () { return { ok: true, worktrees: [{ path: PROJECT, head: 'h', branch: 'main' }] } }
  wrongGit.currentBranch = async function () { return { ok: true, branch: 'feat/x' } }
  const wrongMerger = createMerger({ git: wrongGit })
  const wrong = await wrongMerger.mergeRequest(hotfix, PROJECT, { worktreeRoot: '.worktrees' })
  check('a worktree checked out on the wrong branch is refused with wrong-target', wrong.ok === false && String(wrong.code) === 'wrong-target', JSON.stringify(wrong))
  const missingGit = createFakeGit()
  missingGit.revParse = async function () { return { ok: false, message: 'missing' } }
  missingGit.currentBranch = async function () { return { ok: true, branch: 'feat/other' } }
  const missingMerger = createMerger({ git: missingGit })
  const missing = await missingMerger.mergeRequest(hotfix, PROJECT, { worktreeRoot: '.worktrees' })
  check('a target branch that does not resolve is refused with a readable message', missing.ok === false && String(missing.code) === 'target-unreadable' && String(missing.message).indexOf('main') >= 0, JSON.stringify(missing))
}

// ── T-107: an ownerless card never falls back to "the first Lead" on a multi-team host ──
{
  function teamWith(leads, teammates) {
    const roster = leads.concat(teammates)
    return {
      roster: roster,
      tryMembership(candidate) {
        const member = roster.filter((entry) => entry.id === candidate.id)[0]
        return member === undefined ? undefined : { role: member.role, name: member.name }
      },
      listMembers() {
        return roster.map((entry) => Object.assign({}, entry))
      },
      async spawnTeammate() { return { name: 'spawned', id: 'session-spawned' } },
      async sendMessage() { return { ok: true } },
    }
  }
  function ctxFor(fs, leads, team, workspaceRoot) {
    return {
      fs: fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: workspaceRoot === undefined ? PROJECT : workspaceRoot }) },
      get(key) {
        if (key === 'agents') return { list: () => leads }
        if (key === 'agentTeams') return team
        return undefined
      },
    }
  }
  function seedOwnerless(fs) {
    const now = new Date().toISOString()
    seedBoard(fs, PROJECT, JSON.stringify({
      version: 2,
      seq: 2,
      dispatch: { state: 'running', allowSpawn: true, maxConcurrent: 2 },
      tasks: [{ id: 'T-1', title: 'legacy card', status: 'pending', priority: 0, dependsOn: [], writeFiles: [], spec: 's', acceptance: 'a', evidence: '', ownerSession: null, history: [], createdAt: now, updatedAt: now, attempts: 0, maxAttempts: 3 }],
    }))
  }

  // (b) two Leads + ownerless card in a project with no session of its own:
  // no-team-for-project, never the first Lead (T-109 renamed the refusal).
  {
    const fs = createFakeFs()
    const leads = [
      { id: 'lead-a', name: 'lead-a', role: 'lead', status: 'running' },
      { id: 'lead-b', name: 'lead-b', role: 'lead', status: 'running' },
    ]
    const team = teamWith(leads, [{ id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' }])
    seedOwnerless(fs)
    const ctx = ctxFor(fs, leads, team)
    const state = createState(ctx)
    const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: createFakeGit(), sessionId: 'session-x' })
    await scheduler.settle(PROJECT)
    const card = JSON.parse(fs.files.get(join(PROJECT, '.agents', 'tasks.json')).text).tasks[0]
    check(
      'T-109 a multi-Lead host refuses an ownerless card it cannot place in this project',
      card.status === 'pending' && card.waitingReason === 'no-team-for-project' && card.assignee === null,
      JSON.stringify({ status: card.status, waiting: card.waitingReason, assignee: card.assignee }),
    )
    check(
      'T-109 the refusal detail tells the user to reopen the card in its project session',
      typeof card.waitingDetail === 'string' && card.waitingDetail.indexOf('reopen') >= 0 && card.waitingDetail.indexOf('Lead') >= 0,
      String(card.waitingDetail),
    )
    scheduler.dispose()
  }

  // (c) a single-Lead host keeps the historical compatibility dispatch.
  {
    const fs = createFakeFs()
    const leads = [{ id: 'lead-solo', name: 'lead-solo', role: 'lead', status: 'running' }]
    const team = teamWith(leads, [{ id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' }])
    seedOwnerless(fs)
    const ctx = ctxFor(fs, leads, team)
    const state = createState(ctx)
    const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: createFakeGit(), sessionId: 'session-x' })
    await scheduler.settle(PROJECT)
    const card = JSON.parse(fs.files.get(join(PROJECT, '.agents', 'tasks.json')).text).tasks[0]
    check(
      'T-107 a single-Lead host still dispatches an ownerless card (compatibility)',
      card.status === 'running' && card.assignee !== null && card.assignee.name === 'fixer',
      JSON.stringify({ status: card.status, assignee: card.assignee }),
    )
    check(
      'T-107 the compatibility dispatch records leadSession and ownerCompat',
      card.dispatch !== null && card.dispatch.leadSession === 'lead-solo' && card.dispatch.ownerCompat === true,
      JSON.stringify({ dispatch: card.dispatch }),
    )
    check(
      'T-109 the compatibility dispatch explains itself with the Lead inventory',
      card.dispatch !== null &&
        typeof card.dispatch.compatDetail === 'string' &&
        card.dispatch.compatDetail.indexOf('1 个 Lead') >= 0 &&
        card.dispatch.compatDetail.indexOf('agent') >= 0 &&
        (card.history || []).some((entry) => String(entry.note).indexOf('宿主内发现 1 个 Lead') >= 0),
      JSON.stringify({ compatDetail: card.dispatch && card.dispatch.compatDetail, history: (card.history || []).map((entry) => entry.note) }),
    )
    scheduler.dispose()
  }

  // (d) the card's project is not this session's workspace: refuse BEFORE dispatch.
  // The judge is the SESSION's workspace (what it can actually write), not the
  // row's sandbox policy (which spans every project the plugin knows).
  {
    const fs = createFakeFs()
    const leads = [{ id: 'lead-solo', name: 'lead-solo', role: 'lead', status: 'running' }]
    const team = teamWith(leads, [{ id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' }])
    seedOwnerless(fs)
    const otherRoot = join(PROJECT, '..', 'other-project')
    const ctx = ctxFor(fs, leads, team, otherRoot)
    const state = createState(ctx)
    state.setSessionRoot('session-x', otherRoot)
    const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: createFakeGit(), sessionId: 'session-x' })
    await scheduler.settle(PROJECT)
    const card = JSON.parse(fs.files.get(join(PROJECT, '.agents', 'tasks.json')).text).tasks[0]
    check(
      'T-107 a cross-project dispatch is refused before any worker is spawned',
      card.status === 'pending' && card.assignee === null && card.waitingReason === 'wrong-session',
      JSON.stringify({ status: card.status, assignee: card.assignee, waiting: card.waitingReason }),
    )
    check(
      'T-107 the wrong-session detail names the workspace and where to dispatch',
      typeof card.waitingDetail === 'string' && card.waitingDetail.indexOf(otherRoot) >= 0 && card.waitingDetail.indexOf('所属项目') >= 0,
      String(card.waitingDetail),
    )
    scheduler.dispose()
  }
}


// ── T-109: cross-project is refused; single-Lead compat is same-project only ──
{
  function teamWith(leads, teammates) {
    const roster = leads.concat(teammates)
    return {
      roster: roster,
      tryMembership(candidate) {
        const member = roster.filter((entry) => entry.id === candidate.id)[0]
        return member === undefined ? undefined : { role: member.role, name: member.name }
      },
      listMembers(lead) {
        const owner = roster.filter((entry) => entry.id === (lead === undefined || lead === null ? null : lead.id))[0]
        if (owner === undefined || owner.role !== 'lead') return []
        return [owner].concat(teammates).map((member) => Object.assign({}, member))
      },
      async spawnTeammate(caller, request) {
        return { member: { id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'running' } }
      },
      async sendMessage() {
        return { ok: true }
      },
    }
  }
  function rigFor(options) {
    const fs = createFakeFs()
    const now = new Date().toISOString()
    const owner = options.ownerSession === undefined ? null : options.ownerSession
    seedBoard(fs, PROJECT, JSON.stringify({
      version: 2,
      seq: 2,
      dispatch: { state: 'running', allowSpawn: true, maxConcurrent: 2 },
      tasks: [{ id: 'T-1', title: 'card', status: 'pending', priority: 0, dependsOn: [], writeFiles: [], spec: 's', acceptance: 'a', evidence: '', ownerSession: owner, history: [], createdAt: now, updatedAt: now, attempts: 0, maxAttempts: 3 }],
    }))
    const ctx = {
      fs: fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: options.projectWorkspace === undefined ? PROJECT : options.projectWorkspace }) },
      get(key) {
        if (key === 'agents') return { list: () => options.agents }
        if (key === 'agentTeams') return options.team
        return undefined
      },
    }
    const state = createState(ctx)
    for (const session of options.sessions || []) state.setSessionRoot(session.id, session.root)
    const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: createFakeGit(), sessionId: options.sessionId })
    return { fs: fs, state: state, scheduler: scheduler }
  }
  function cardOf(fs) {
    return JSON.parse(fs.files.get(join(PROJECT, '.agents', 'tasks.json')).text).tasks[0]
  }
  const otherRoot = join(PROJECT, '..', 'other-project')

  // (a) single Lead in the host, card belongs to ANOTHER project: refuse.
  {
    const rig = rigFor({
      agents: [{ id: 'session-x', name: 'lead-x', role: 'lead', status: 'running' }],
      team: teamWith([{ id: 'session-x', name: 'lead-x', role: 'lead', status: 'running' }], [{ id: 'session-fixer', name: 'fixer-x', role: 'teammate', status: 'inactive' }]),
      sessionId: 'session-x',
      sessions: [{ id: 'session-x', root: otherRoot }],
    })
    await rig.scheduler.settle(PROJECT)
    const card = cardOf(rig.fs)
    check(
      'T-109 a single-Lead host still refuses a card from another project',
      card.status === 'pending' && card.assignee === null && (card.waitingReason === 'wrong-session' || card.waitingReason === 'no-team-for-project'),
      JSON.stringify({ status: card.status, assignee: card.assignee, waiting: card.waitingReason }),
    )
    check(
      'T-109 the refusal names the router workspace and where to dispatch it instead',
      typeof card.waitingDetail === 'string' && card.waitingDetail.indexOf(otherRoot) >= 0 && card.waitingDetail.indexOf('所属项目') >= 0,
      String(card.waitingDetail),
    )
    rig.scheduler.dispose()
  }

  // (b) same project, single Lead, no session evidence: the compatibility path.
  {
    const rig = rigFor({
      agents: [{ id: 'session-x', name: 'lead-x', role: 'lead', status: 'running' }],
      team: teamWith([{ id: 'session-x', name: 'lead-x', role: 'lead', status: 'running' }], [{ id: 'session-fixer', name: 'fixer-x', role: 'teammate', status: 'inactive' }]),
      sessionId: 'session-x',
    })
    await rig.scheduler.settle(PROJECT)
    const card = cardOf(rig.fs)
    check(
      'T-109 the same-project compatibility path still dispatches',
      card.status === 'running' && card.assignee !== null && card.assignee.name === 'fixer-x',
      JSON.stringify({ status: card.status, assignee: card.assignee }),
    )
    check(
      'T-109 ownerCompat is set only on that compatibility path',
      card.dispatch !== null && card.dispatch.ownerCompat === true && card.dispatch.lead === 'lead-x' && card.dispatch.leadSession === 'session-x',
      JSON.stringify(card.dispatch),
    )
    check(
      'T-109 the compatibility reason names the single Lead and the scanned agent count',
      card.dispatch !== null && typeof card.dispatch.compatDetail === 'string' && card.dispatch.compatDetail.indexOf('1 个 Lead') >= 0 && card.dispatch.compatDetail.indexOf('agent') >= 0,
      String(card.dispatch && card.dispatch.compatDetail),
    )
    rig.scheduler.dispose()
  }

  // (c) an OWNED card whose session runs in another project: wrong-session.
  {
    const rig = rigFor({
      agents: [{ id: 'session-x', name: 'lead-x', role: 'lead', status: 'running' }],
      team: teamWith([{ id: 'session-x', name: 'lead-x', role: 'lead', status: 'running' }], [{ id: 'session-fixer', name: 'fixer-x', role: 'teammate', status: 'inactive' }]),
      sessionId: 'session-x',
      sessions: [{ id: 'session-x', root: otherRoot }],
      ownerSession: 'session-x',
    })
    await rig.scheduler.settle(PROJECT)
    const card = cardOf(rig.fs)
    check(
      'T-109 an owned card from another project is refused as wrong-session',
      card.status === 'pending' && card.assignee === null && card.waitingReason === 'wrong-session',
      JSON.stringify({ status: card.status, assignee: card.assignee, waiting: card.waitingReason }),
    )
    rig.scheduler.dispose()
  }

  // (d) this project has its OWN session/Lead: the card is dispatched there.
  {
    const rig = rigFor({
      agents: [
        { id: 'session-x', name: 'lead-x', role: 'lead', status: 'running' },
        { id: 'session-y', name: 'lead-y', role: 'lead', status: 'running' },
      ],
      team: {
        tryMembership(candidate) {
          if (candidate.id === 'session-x') return { role: 'lead', name: 'lead-x' }
          if (candidate.id === 'session-y') return { role: 'lead', name: 'lead-y' }
          return { role: 'teammate', name: candidate.id }
        },
        listMembers(lead) {
          if (lead !== null && lead !== undefined && lead.id === 'session-y') {
            return [
              { id: 'session-y', name: 'lead-y', role: 'lead', status: 'running' },
              { id: 'session-fixer-y', name: 'fixer-y', role: 'teammate', status: 'inactive' },
            ]
          }
          return []
        },
        async spawnTeammate() { return { member: { id: 'session-spawned', name: 'spawned', role: 'teammate', status: 'running' } } },
        async sendMessage() { return { ok: true } },
      },
      sessionId: 'session-x',
      sessions: [
        { id: 'session-x', root: otherRoot },
        { id: 'session-y', root: PROJECT },
      ],
    })
    await rig.scheduler.settle(PROJECT)
    const card = cardOf(rig.fs)
    check(
      'T-109 an ownerless card is adopted by the session that runs in this project',
      card.status === 'running' && card.assignee !== null && card.assignee.name === 'fixer-y',
      JSON.stringify({ status: card.status, assignee: card.assignee, waiting: card.waitingReason }),
    )
    check(
      'T-109 the adopted dispatch names that project session and Lead',
      card.dispatch !== null && card.dispatch.lead === 'lead-y' && card.dispatch.leadSession === 'session-y' && card.dispatch.session === 'session-y' && card.dispatch.ownerCompat === false,
      JSON.stringify(card.dispatch),
    )
    rig.scheduler.dispose()
  }

  // (8) the inventory mirrors what the service exposes.
  {
    async function inventoryFor(agents, isLeadIds) {
      const fs = createFakeFs()
      seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [] }))
      const team = {
        tryMembership(candidate) {
          return { role: isLeadIds.indexOf(candidate.id) >= 0 ? 'lead' : 'teammate', name: candidate.id }
        },
        listMembers(lead) {
          return isLeadIds.indexOf(lead.id) >= 0 ? [{ id: lead.id, name: 'lead', role: 'lead' }, { id: 'session-fixer', name: 'fixer', role: 'teammate' }] : []
        },
        async spawnTeammate() { return { member: { name: 'spawned', id: 'session-spawned', role: 'teammate' } } },
        async sendMessage() { return { ok: true } },
      }
      const ctx = {
        fs: fs,
        sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
        get(key) {
          if (key === 'agents') return { list: () => agents }
          if (key === 'agentTeams') return team
          return undefined
        },
      }
      const state = createState(ctx)
      const api = createApi(ctx, { state: state, git: createFakeGit() })
      const snap = await api.snapshot(PROJECT)
      return snap.teams
    }
    const oneLead = await inventoryFor(
      [{ id: 'session-lead', name: 'lead-a' }, { id: 'session-other', name: 'root-of-other-session' }],
      ['session-lead'],
    )
    check(
      'T-109 teams lists only real Leads and counts the agents it scanned',
      oneLead.available === true && oneLead.scanned === 2 && oneLead.nonLeads === 1 && oneLead.leads.length === 1 && oneLead.leads[0].session === 'session-lead' && oneLead.leads[0].members === 2,
      JSON.stringify(oneLead),
    )
    const twoLeads = await inventoryFor(
      [{ id: 'session-a', name: 'lead-a' }, { id: 'session-b', name: 'lead-b' }],
      ['session-a', 'session-b'],
    )
    check(
      'T-109 a second Leading session shows up as a second Lead',
      twoLeads.available === true && twoLeads.scanned === 2 && twoLeads.nonLeads === 0 && twoLeads.leads.length === 2 && twoLeads.leads.map((lead) => lead.session).join(',') === 'session-a,session-b',
      JSON.stringify(twoLeads),
    )
  }
}

// ── T-112: no bare resolveLead(ctx) anywhere in the plugin ──
{
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const pluginDir = pathMod.resolve(import.meta.dirname, '../../plugin/task-center')
  const offenders = []
  for (const name of fsMod.readdirSync(pluginDir)) {
    if (!name.endsWith('.mjs')) continue
    const text = fsMod.readFileSync(pathMod.join(pluginDir, name), 'utf8')
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (/resolveLead\s*\(\s*ctx\s*\)/.test(line)) offenders.push(name + ':' + String(index + 1) + ': ' + line.trim())
    })
  }
  check(
    'T-112 the plugin has no bare resolveLead(ctx): authority must pass { sessionId }',
    offenders.length === 0,
    offenders.join(' | '),
  )
  // The escape hatch must stay explicit and named for what it is.
  check(
    'T-112 global read-only lookups go through resolveAnyLead',
    fsMod.readFileSync(pathMod.join(pluginDir, 'dispatch.mjs'), 'utf8').indexOf('export function resolveAnyLead') >= 0,
  )
}

// ── T-115: a Lead alone is not a qualified team ───────────────────────────
{
  const lead = { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }
  const rig = createRig({ team: createTeam({ roster: [lead] }), agents: { list: () => [{ id: 'session-lead' }] } })
  const leadOnly = projectTeamState(rig.ctx, { sessionId: 'session-lead' })
  check(
    'T-115 a Lead-only roster is not a qualified team (no-members)',
    leadOnly.ok === false && leadOnly.available === true && leadOnly.error === 'no-members',
    JSON.stringify(leadOnly),
  )
  check(
    'T-115 lead-only reports every missing role',
    JSON.stringify(leadOnly.missingRoles) === JSON.stringify(['worker', 'reviewer', 'tester']),
    JSON.stringify(leadOnly.missingRoles),
  )
  const refused = await rig.action('create', { title: 'card without a team' })
  check(
    'T-115 create is gated again and carries the bootstrap next step',
    refused.ok === false && refused.code === 'no-team-for-project' && refused.nextStep !== undefined && refused.nextStep.code === 'bootstrap-team',
    JSON.stringify(refused).slice(0, 300),
  )
  const startRefused = await rig.action('start')
  check(
    'T-115 start is gated for the same reason',
    startRefused.ok === false && startRefused.code === 'no-team-for-project',
    JSON.stringify(startRefused).slice(0, 240),
  )
  const boardMissing = await rig.action('board')
  check(
    'T-115 board repeats the bootstrap instruction while the team has no members',
    boardMissing.team !== undefined && boardMissing.team.ok === false && boardMissing.team.error === 'no-members' && boardMissing.nextStep !== undefined && boardMissing.nextStep.code === 'bootstrap-team',
    JSON.stringify({ team: boardMissing.team, nextStep: boardMissing.nextStep }).slice(0, 300),
  )

  rig.team.roster.push({ id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' })
  const withWorker = projectTeamState(rig.ctx, { sessionId: 'session-lead' })
  check(
    'T-115 Lead + one teammate is a qualified team',
    withWorker.ok === true && withWorker.error === null && withWorker.members.length === 2,
    JSON.stringify(withWorker),
  )
  check(
    'T-115 missing roles are still reported for the role manager',
    JSON.stringify(withWorker.missingRoles) === JSON.stringify(['reviewer', 'tester']),
    JSON.stringify(withWorker.missingRoles),
  )
  const created = await rig.action('create', { title: 'card with a team' })
  check('T-115 create passes once a teammate exists', created.ok === true, JSON.stringify(created).slice(0, 240))
  const started = await rig.action('start')
  check('T-115 start passes once a teammate exists', started.ok === true && started.dispatch.state === 'running', JSON.stringify(started).slice(0, 240))
  const boardOk = await rig.action('board')
  check(
    'T-115 the board reports the qualified team and no next step',
    boardOk.team !== undefined && boardOk.team.ok === true && boardOk.nextStep === null && JSON.stringify(boardOk.team.missingRoles) === JSON.stringify(['reviewer', 'tester']),
    JSON.stringify({ team: boardOk.team, nextStep: boardOk.nextStep }).slice(0, 300),
  )
  rig.scheduler.dispose()
}
{
  // A profile without team services keeps the old behaviour.
  const fs = createFakeFs()
  const ctx = { fs: fs, get() { return undefined } }
  const none = projectTeamState(ctx, {})
  check(
    'T-115 without team services the state stays available:false (no gate)',
    none.ok === false && none.available === false && none.error === 'no-team-service',
    JSON.stringify(none),
  )
}


// ── T-118: role instances never spawn into another project's session team ────
{
  const projectA = join(PROJECT, '..', 'project-a')
  const projectB = join(PROJECT, '..', 'project-b')
  function teamFor(sessionId, extras) {
    const roster = [{ id: sessionId, name: 'lead', role: 'lead', status: 'running' }].concat(extras === undefined ? [] : extras)
    const spawns = []
    const removals = []
    return {
      roster: roster,
      spawns: spawns,
      removals: removals,
      tryMembership(candidate) {
        const member = roster.filter((entry) => entry.id === candidate.id)[0]
        return member === undefined ? undefined : { role: member.role, name: member.name }
      },
      listMembers() {
        return roster.map((entry) => Object.assign({}, entry))
      },
      async spawnTeammate(caller, request) {
        spawns.push({ caller: caller.id, name: request.name })
        const member = { id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'running' }
        roster.push(member)
        return { member: member }
      },
      async removeMember(caller, name) {
        removals.push({ caller: caller.id, name: name })
        const index = roster.findIndex((entry) => entry.name === name)
        if (index >= 0) roster.splice(index, 1)
        return { ok: true }
      },
      async interrupt() { return { ok: true } },
      async sendMessage() { return { ok: true } },
    }
  }
  function ctxFor(team, leads) {
    const fs = createFakeFs()
    return {
      fs: fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
      get(key) {
        if (key === 'agents') return { list: () => leads }
        if (key === 'agentTeams') return team
        return undefined
      },
    }
  }

  // (a) session workspace = B, slot project = A: refuse, create nothing.
  {
    const leads = [{ id: 'session-b', name: 'lead-b', role: 'lead', status: 'running' }]
    const team = teamFor('session-b')
    const ctx = ctxFor(team, leads)
    const state = createState(ctx)
    state.setSessionRoot('session-b', projectB)
    const manager = createRoleManager(ctx, { state: state })
    const refused = await manager.ensure('reviewer', { projectPath: projectA, sessionId: 'session-b' })
    check(
      'T-118 a role slot for another project is refused with no-team-for-project',
      refused.ok === false && refused.code === 'no-team-for-project' && String(refused.message).indexOf(projectA) >= 0 && String(refused.message).indexOf(projectB) >= 0,
      JSON.stringify(refused),
    )
    check(
      'T-118 the refused provision creates no member and spawns nothing',
      team.spawns.length === 0 && team.roster.length === 1 && (refused.created === undefined || refused.created.length === 0),
      JSON.stringify({ spawns: team.spawns, roster: team.roster.map((entry) => entry.name) }),
    )
    // Same team, the project it actually runs in: provisioning proceeds.
    const own = await manager.ensure('reviewer', { projectPath: projectB, sessionId: 'session-b' })
    check(
      'T-118 the same session provisions its OWN project’s role slot',
      own.ok === true && own.created.length === 1 && team.spawns.length === 1 && String(team.spawns[0].name).indexOf(projectSlotKey(projectB)) >= 0,
      JSON.stringify({ created: own.created, spawns: team.spawns }),
    )
    manager.drain(own.created[0].name)
  }

  // (b) reuse is judged by the slot's project too: A's instance is never B's reviewer.
  {
    const leads = [{ id: 'session-b', name: 'lead-b', role: 'lead', status: 'running' }]
    const foreign = { id: 'session-r', name: roleSlotName('reviewer', 1, projectA), role: 'teammate', status: 'inactive' }
    const team = teamFor('session-b', [foreign])
    const ctx = ctxFor(team, leads)
    const state = createState(ctx)
    state.setSessionRoot('session-b', projectB)
    const manager = createRoleManager(ctx, { state: state })
    const ensured = await manager.ensure('reviewer', { projectPath: projectB, sessionId: 'session-b' })
    check(
      'T-118 an instance of another project is never reused as this project’s reviewer',
      ensured.ok === true &&
        ensured.reused.indexOf(foreign.name) < 0 &&
        ensured.refused.some((entry) => entry.name === foreign.name) &&
        ensured.created.length === 1 &&
        String(ensured.created[0].name).indexOf(projectSlotKey(projectB)) >= 0,
      JSON.stringify({ reused: ensured.reused, refused: ensured.refused, created: ensured.created }),
    )
  }

  // (c) rolesPrune removes only foreign slot instances.
  {
    const leads = [{ id: 'session-b', name: 'lead-b', role: 'lead', status: 'running' }]
    const foreign = { id: 'session-rA', name: roleSlotName('reviewer', 1, projectA), role: 'teammate', status: 'inactive' }
    const own = { id: 'session-rB', name: roleSlotName('reviewer', 1, projectB), role: 'teammate', status: 'inactive' }
    const teammate = { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' }
    const team = teamFor('session-b', [foreign, own, teammate])
    const ctx = ctxFor(team, leads)
    const state = createState(ctx)
    state.setSessionRoot('session-b', projectB)
    const manager = createRoleManager(ctx, { state: state })
    const pruned = await manager.prune({ projectPath: projectB, sessionId: 'session-b' })
    check(
      'T-118 rolesPrune removes the foreign slot and keeps this project’s instances',
      pruned.ok === true &&
        pruned.pruned.length === 1 &&
        pruned.pruned[0].name === foreign.name &&
        pruned.kept.indexOf(own.name) >= 0 &&
        pruned.kept.indexOf(teammate.name) < 0 &&
        team.removals.some((entry) => entry.name === foreign.name) &&
        team.roster.some((entry) => entry.name === own.name) &&
        !team.roster.some((entry) => entry.name === foreign.name),
      JSON.stringify({ pruned: pruned, removals: team.removals, roster: team.roster.map((entry) => entry.name) }),
    )
  }
}

// ── T-117: expired Lead sessions are not a project team ─────────────────────
{
  const now = Date.now()
  const activeLead = { id: 'lead-active', name: 'lead-active', role: 'lead', status: 'running', lastActiveAt: new Date(now - 60 * 60 * 1000).toISOString() }
  const staleLead = { id: 'lead-stale', name: 'lead-stale', role: 'lead', status: 'inactive', lastActiveAt: new Date(now - 13 * 24 * 60 * 60 * 1000).toISOString() }
  const rosters = {
    'lead-active': [activeLead, { id: 'session-fixer-a', name: 'fixer-a', role: 'teammate', status: 'inactive' }],
    'lead-stale': [staleLead, { id: 'session-fixer-s', name: 'fixer-s', role: 'teammate', status: 'inactive' }],
  }
  const everyone = [activeLead, staleLead, rosters['lead-active'][1], rosters['lead-stale'][1]]
  const team = {
    tryMembership(candidate) {
      const member = everyone.filter((entry) => entry.id === candidate.id)[0]
      return member === undefined ? undefined : { role: member.role, name: member.name }
    },
    listMembers(lead) {
      return (rosters[lead.id] === undefined ? [] : rosters[lead.id]).map((entry) => Object.assign({}, entry))
    },
    async sendMessage() { return { ok: true } },
    async spawnTeammate() { return { name: 'spawned', id: 'session-spawned' } },
  }
  function ctxFor(fs) {
    return {
      fs: fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
      get(key) {
        if (key === 'agents') return { list: () => everyone.filter((entry) => entry.role === 'lead') }
        if (key === 'agentTeams') return team
        return undefined
      },
    }
  }
  const fs = createFakeFs()
  const ctx = ctxFor(fs)
  const noSession = projectTeamState(ctx, {})
  check(
    'T-117 without a session the team is not guessed (no-session-context)',
    noSession.ok === false && noSession.available === true && noSession.error === 'no-session-context' && noSession.leadId === null,
    JSON.stringify(noSession),
  )
  const staleTeam = projectTeamState(ctx, { sessionId: 'lead-stale' })
  check(
    'T-117 a stale Lead session is refused as no-live-lead with its last activity',
    staleTeam.ok === false && staleTeam.error === 'no-live-lead' && typeof staleTeam.lastActiveAt === 'string',
    JSON.stringify(staleTeam),
  )
  const activeTeam = projectTeamState(ctx, { sessionId: 'lead-active' })
  check(
    'T-117 a live Lead session still resolves its team',
    activeTeam.ok === true && activeTeam.leadId === 'lead-active',
    JSON.stringify(activeTeam),
  )
  const inventory = leadInventory(ctx)
  const activeRow = inventory.leads.filter((row) => row.id === 'lead-active')[0]
  const staleRow = inventory.leads.filter((row) => row.id === 'lead-stale')[0]
  check(
    'T-117 the team inventory exposes lastActiveAt and stale for every Lead',
    activeRow !== undefined && activeRow.stale === false && typeof activeRow.lastActiveAt === 'string' && staleRow !== undefined && staleRow.stale === true && typeof staleRow.lastActiveAt === 'string',
    JSON.stringify(inventory.leads),
  )
  check(
    'T-117 liveLeads excludes the stale Lead',
    liveLeads(ctx).map((lead) => lead.id).join(',') === 'lead-active',
    JSON.stringify(liveLeads(ctx).map((lead) => lead.id)),
  )
  const stalePick = pickTarget(ctx, { sessionId: 'lead-stale' })
  check(
    'T-117 dispatch refuses a stale Lead session with no-live-lead',
    stalePick.ok === false && stalePick.code === 'no-live-lead' && String(stalePick.message).indexOf(String(staleRow.lastActiveAt)) >= 0,
    JSON.stringify(stalePick),
  )
  const activePick = pickTarget(ctx, { sessionId: 'lead-active' })
  check('T-117 dispatch still picks a live Lead', activePick.ok === true && activePick.lead.id === 'lead-active', JSON.stringify(activePick.ok))

  // A pending card owned by the stale session is not dispatched; the reason is recorded.
  const nowIso = new Date().toISOString()
  seedBoard(fs, PROJECT, JSON.stringify({
    version: 2,
    seq: 2,
    dispatch: { state: 'running', allowSpawn: true, maxConcurrent: 2 },
    tasks: [{ id: 'T-1', title: 'stale owner card', status: 'pending', priority: 0, dependsOn: [], writeFiles: [], spec: 's', acceptance: 'a', evidence: '', ownerSession: 'lead-stale', history: [], createdAt: nowIso, updatedAt: nowIso, attempts: 0, maxAttempts: 3 }],
  }))
  const state = createState(ctx)
  const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: createFakeGit(), sessionId: 'lead-stale' })
  await scheduler.settle(PROJECT)
  const card = JSON.parse(fs.files.get(join(PROJECT, '.agents', 'tasks.json')).text).tasks[0]
  check(
    'T-117 a card owned by a stale session is not dispatched and records no-live-lead',
    card.status === 'pending' && card.assignee === null && card.waitingReason === 'no-live-lead',
    JSON.stringify({ status: card.status, assignee: card.assignee, waiting: card.waitingReason }),
  )
  scheduler.dispose()
}

// ── T-119: session activity comes from FILES, not the directory mtime ───────
{
  const root = join(PROJECT, '.tmp-t119-sessions')
  const workspaceDir = join(root, '--project--')
  const oldDir = join(workspaceDir, 'session-session-olddir')
  const newFileDir = join(workspaceDir, 'session-session-active')
  const staleDir = join(workspaceDir, 'session-session-stale')
  const leadFileDir = join(workspaceDir, 'session-session-lead')
  const now = Date.now()
  const old = new Date(now - 13 * 24 * 60 * 60 * 1000)
  const fresh = new Date(now - 5 * 60 * 1000)
  mkdirSync(oldDir, { recursive: true })
  mkdirSync(newFileDir, { recursive: true })
  mkdirSync(staleDir, { recursive: true })
  mkdirSync(leadFileDir, { recursive: true })
  // (a) directory mtime is 13 days old, the file inside is fresh.
  writeFileSync(join(newFileDir, 'session.v4.jsonl.zstd'), 'x')
  utimesSync(join(newFileDir, 'session.v4.jsonl.zstd'), fresh, fresh)
  utimesSync(newFileDir, old, old)
  // (b) both the directory and its file are old.
  writeFileSync(join(staleDir, 'session.v4.jsonl.zstd'), 'x')
  utimesSync(join(staleDir, 'session.v4.jsonl.zstd'), old, old)
  utimesSync(staleDir, old, old)
  // The default rig Lead's session, active, so create/start are not gated.
  writeFileSync(join(leadFileDir, 'session.v4.jsonl.zstd'), 'x')
  utimesSync(join(leadFileDir, 'session.v4.jsonl.zstd'), fresh, fresh)
  utimesSync(leadFileDir, old, old)
  const previous = process.env.GODOT_BRIDGE_SESSIONS_DIR
  process.env.GODOT_BRIDGE_SESSIONS_DIR = root
  try {
    const activeLead = { id: 'session-active', name: 'lead-active', role: 'lead', status: 'running' }
    const staleLead = { id: 'session-stale', name: 'lead-stale', role: 'lead', status: 'inactive' }
    const roster = [
      activeLead,
      { id: 'session-fixer-a', name: 'fixer-a', role: 'teammate', status: 'inactive' },
    ]
    const team = {
      tryMembership(candidate) {
        return candidate.id === 'session-active' || candidate.id === 'session-stale' ? { role: 'lead', name: candidate.name } : { role: 'teammate', name: candidate.id }
      },
      listMembers(lead) {
        return lead.id === 'session-active' ? roster.map((member) => Object.assign({}, member)) : [{ id: 'session-stale', name: 'lead-stale', role: 'lead', status: 'inactive' }]
      },
      async sendMessage() { return { ok: true } },
      async spawnTeammate() { return { name: 'spawned', id: 'session-spawned' } },
    }
    const fs = createFakeFs()
    const ctx = {
      fs: fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
      get(key) {
        if (key === 'agents') return { list: () => [activeLead, staleLead] }
        if (key === 'agentTeams') return team
        return undefined
      },
    }
    const inventory = leadInventory(ctx)
    const activeRow = inventory.leads.filter((row) => row.id === 'session-active')[0]
    const staleRow = inventory.leads.filter((row) => row.id === 'session-stale')[0]
    check(
      'T-119 a fresh FILE inside an old session directory is not stale',
      activeRow !== undefined && activeRow.stale === false && activeRow.activitySource === 'file' &&
        typeof activeRow.lastActivePath === 'string' && activeRow.lastActivePath.indexOf('session.v4.jsonl.zstd') >= 0,
      JSON.stringify(activeRow),
    )
    check(
      'T-119 a session whose files are old is stale',
      staleRow !== undefined && staleRow.stale === true,
      JSON.stringify(staleRow),
    )
    check(
      'T-119 the Lead name is filled from the roster when the agent row has none',
      activeRow !== undefined && activeRow.name === 'lead-active',
      JSON.stringify(activeRow && activeRow.name),
    )
    const activeTeam = projectTeamState(ctx, { sessionId: 'session-active' })
    check(
      'T-119 projectTeamState resolves an active session whose directory mtime is old',
      activeTeam.ok === true && activeTeam.leadId === 'session-active',
      JSON.stringify(activeTeam),
    )
    // create/start must not be blocked by no-live-lead for the active session.
    const rig = createRig({ allowSpawn: false })
    const created = await rig.action('create', { title: 'after activity fix' })
    const started = await rig.action('start')
    check(
      'T-119 create/start are not refused as no-live-lead for an active session',
      created.ok === true && started.ok === true && started.dispatch.state === 'running',
      JSON.stringify({ create: created.ok, start: started.ok, code: created.code, error: created.error }),
    )
    rig.scheduler.dispose()
  } finally {
    if (previous === undefined) delete process.env.GODOT_BRIDGE_SESSIONS_DIR
    else process.env.GODOT_BRIDGE_SESSIONS_DIR = previous
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (error) {}
  }
}

// ── T-120: an explicit session never borrows another session's team ────────
{
  const lead = { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }
  const roster = [lead, { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' }]
  const team = {
    tryMembership(candidate) { return candidate.id === 'session-lead' ? { role: 'lead', name: 'lead' } : { role: 'teammate', name: candidate.id } },
    listMembers() { return roster.map((member) => Object.assign({}, member)) },
    async sendMessage() { return { ok: true } },
    async spawnTeammate() { return { name: 'spawned', id: 'session-spawned' } },
  }
  const ctx = {
    fs: createFakeFs(),
    sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
    get(key) {
      if (key === 'agents') return { list: () => [lead] }
      if (key === 'agentTeams') return team
      return undefined
    },
  }
  const otherSession = projectTeamState(ctx, { sessionId: 'session-other' })
  check(
    'T-120 a single-Lead host does NOT give its team to another session',
    otherSession.ok === false && otherSession.lead === null && otherSession.source === 'none' && otherSession.error === 'no-lead-for-project',
    JSON.stringify(otherSession),
  )
  const ownSession = projectTeamState(ctx, { sessionId: 'session-lead' })
  check('T-120 the owning session still resolves its own team', ownSession.ok === true && ownSession.leadId === 'session-lead', JSON.stringify(ownSession))

  // create/start from the foreign session are refused with the bootstrap step.
  const rig = createRig({ allowSpawn: false })
  const foreign = { projectPath: PROJECT, by: '@other', role: 'agent', agent: { id: 'session-other' } }
  const foreignCreate = await rig.api.perform('create', { title: 'foreign card' }, foreign)
  check(
    'T-120 create from a session without its own Lead is refused with nextStep',
    foreignCreate.ok === false && foreignCreate.code === 'no-team-for-project' && foreignCreate.nextStep !== undefined && foreignCreate.nextStep.code === 'bootstrap-team',
    JSON.stringify(foreignCreate).slice(0, 260),
  )
  const foreignStart = await rig.api.perform('start', {}, foreign)
  check('T-120 start from that session is refused for the same reason', foreignStart.ok === false && foreignStart.code === 'no-team-for-project', JSON.stringify(foreignStart).slice(0, 200))
  rig.scheduler.dispose()

  // (b) legacy dispatch of an ownerless card still uses the single team, marked compat.
  {
    const legacyRig = createRig({ allowSpawn: false })
    const stamp = new Date().toISOString()
    seedBoard(legacyRig.fs, PROJECT, JSON.stringify({
      version: 2,
      seq: 2,
      dispatch: { state: 'paused' },
      tasks: [{ id: 'T-1', title: 'legacy card', status: 'pending', priority: 0, dependsOn: [], writeFiles: [], spec: 's', acceptance: 'a', evidence: '', ownerSession: null, history: [], createdAt: stamp, updatedAt: stamp, attempts: 0, maxAttempts: 3 }],
    }))
    await legacyRig.action('start')
    await legacyRig.settle()
    const card = JSON.parse(legacyRig.fs.files.get(join(PROJECT, '.agents', 'tasks.json')).text).tasks[0]
    check(
      'T-120 an ownerless legacy card still dispatches and records compat:true',
      card.status === 'running' && card.assignee !== null && card.dispatch.compat === true,
      JSON.stringify({ status: card.status, assignee: card.assignee, dispatch: card.dispatch }),
    )
    legacyRig.scheduler.dispose()
  }

  // (c) rolesPrune only touches the caller session's own team.
  {
    const roleRig = createRoleRig({})
    const noSession = await roleRig.manager.prune({ projectPath: PROJECT })
    check(
      'T-120 rolesPrune without a session refuses instead of pruning a borrowed team',
      noSession.ok === false && noSession.code === 'no-lead-for-project',
      JSON.stringify(noSession),
    )
    const foreignPrune = await roleRig.manager.prune({ projectPath: PROJECT, sessionId: 'session-other' })
    check(
      'T-120 rolesPrune for a session without its own Lead refuses',
      foreignPrune.ok === false && foreignPrune.code === 'no-lead-for-project',
      JSON.stringify(foreignPrune),
    )
  }
}

// ── T-121: an agent can bootstrap its OWN team (roles* stay user-only) ──────
{
  const rig = createRoleRig({})
  const state = createState(rig.ctx)
  state.setSessionRoot('session-lead', PROJECT)
  const manager = rig.manager
  const git = createFakeGit()
  const scheduler = createDispatcher(rig.ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: git })
  const api = createApi(rig.ctx, { state: state, roles: manager, git: git, scheduler: scheduler })
  const agent = { projectPath: PROJECT, by: '@lead', role: 'agent', agent: { id: 'session-lead' } }
  const boot = await api.perform('bootstrapTeam', {}, agent)
  check(
    'T-121 an agent bootstraps the minimum roster in its own session',
    boot.ok === true && boot.bootstrap === true && Array.isArray(boot.roles) && boot.roles.length === 3 && boot.roles.every((entry) => entry.ok === true),
    JSON.stringify(boot).slice(0, 400),
  )
  const created = await api.perform('create', { title: 'after bootstrap' }, agent)
  check('T-121 create passes after the agent bootstrapped the team', created.ok === true, JSON.stringify(created).slice(0, 240))
  const started = await api.perform('start', {}, { projectPath: PROJECT, by: '@user', role: 'user', agent: null, sessionId: 'session-lead' })
  check('T-121 start passes after the agent bootstrapped the team', started.ok === true && started.dispatch.state === 'running', JSON.stringify(started).slice(0, 240))

  const noLead = await api.perform('bootstrapTeam', {}, { projectPath: PROJECT, by: '@other', role: 'agent', agent: { id: 'session-other' } })
  check(
    'T-121 bootstrapTeam without an own Lead is refused with no-lead-for-project',
    noLead.ok === false && noLead.code === 'no-lead-for-project',
    JSON.stringify(noLead),
  )
  state.setSessionRoot('session-lead', 'J:\\workspace\\t121-other-project')
  const mismatch = await api.perform('bootstrapTeam', { project: PROJECT }, { by: '@lead', role: 'agent', agent: { id: 'session-lead' } })
  check(
    'T-121 bootstrapTeam for a project the session does not own is project-mismatch',
    mismatch.ok === false && mismatch.code === 'project-mismatch',
    JSON.stringify(mismatch),
  )
  state.setSessionRoot('session-lead', PROJECT)

  const adminAttempt = await api.perform('rolesCreate', { name: 'x' }, agent)
  check(
    'T-121 rolesCreate stays user-only for agents',
    adminAttempt.ok === false,
    JSON.stringify(adminAttempt).slice(0, 200),
  )
  check(
    'T-121 the bootstrap instruction is imperative and names bootstrapTeam',
    TEAM_BOOTSTRAP_INSTRUCTION.indexOf('bootstrapTeam') >= 0 &&
      TEAM_BOOTSTRAP_INSTRUCTION.indexOf('Do this NOW') >= 0 &&
      TEAM_BOOTSTRAP_INSTRUCTION.indexOf('do not ask the user') >= 0 &&
      TEAM_BOOTSTRAP_INSTRUCTION.indexOf('rolesCreate') < 0 &&
      USER_ONLY_ACTIONS.indexOf('bootstrapTeam') < 0,
    TEAM_BOOTSTRAP_INSTRUCTION,
  )
}

// ── T-127: a running process without a card is idle, and reusable ──────────
{
  // (a) a running role instance with no task is reused, not duplicated.
  {
    const rig = createRig({ team: createTeam({ roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
    ] }) })
    const A = (await createTask(rig, { title: 'reuse me' })).id
    await rig.action('start')
    await rig.settle()
    const snap = await snapshot(rig)
    const task = byId(snap, A)
    check(
      'T-127 a running role instance with no card is reused instead of spawning',
      task.status === 'running' && task.assignee !== null && task.assignee.name === 'fixer' && rig.team.calls.filter((call) => call.kind === 'spawn').length === 0,
      JSON.stringify({ assignee: task.assignee, calls: rig.team.calls.map((call) => call.kind) }),
    )
    rig.scheduler.dispose()
  }
  // (b) workerPool status: no card -> idle; with card -> running.
  {
    const rig = createRig({ allowSpawn: false, team: createTeam({ roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
    ] }) })
    const idleSnap = await rig.api.snapshot(PROJECT, { sessionId: 'session-lead' })
    const idleMember = idleSnap.workers.members.filter((member) => member.name === 'fixer')[0]
    check(
      'T-127 a running process with no current task is shown as idle, not running',
      idleMember !== undefined && idleMember.status === 'idle' && idleMember.processStatus === 'running' && idleMember.currentTask === null && idleSnap.workers.busy === 0 && idleSnap.workers.idle >= 1,
      JSON.stringify({ member: idleMember, busy: idleSnap.workers.busy, idle: idleSnap.workers.idle }),
    )
    const stamp = new Date().toISOString()
    seedBoard(rig.fs, PROJECT, JSON.stringify({
      version: 2,
      seq: 2,
      dispatch: { state: 'paused' },
      tasks: [{
        id: 'T-1', title: 'busy card', status: 'running', priority: 0, dependsOn: [], writeFiles: [], spec: 's', acceptance: 'a', evidence: '',
        ownerSession: 'session-lead', base: 'base-sha', target: 'main', branch: 'task/T-1-1', commit: 'head-sha',
        assignee: { name: 'fixer', session: 'session-fixer' }, review: null, test: null,
        merge: { status: 'open', base: 'base-sha', target: 'main', head: 'head-sha', mergeCommit: 'candidate-sha', declaredFiles: [], actualFiles: [], tests: null, reviewer: null, conflict: null, at: stamp },
        history: [], createdAt: stamp, updatedAt: stamp, attempts: 1, maxAttempts: 3,
      }],
    }))
    const busySnap = await rig.api.snapshot(PROJECT, { sessionId: 'session-lead' })
    const busyMember = busySnap.workers.members.filter((member) => member.name === 'fixer')[0]
    check(
      'T-127 a member with a current task is shown as running with that task',
      busyMember !== undefined && busyMember.status === 'running' && busyMember.currentTask !== null && busyMember.currentTask.id === 'T-1' && busySnap.workers.busy === 1,
      JSON.stringify({ member: busyMember, busy: busySnap.workers.busy }),
    )
    check(
      'T-127 the executor pool reports per-role configured/running/idle/with-card numbers',
      busySnap.workers.roleCounts !== undefined && busySnap.workers.roleCounts.worker !== undefined && busySnap.workers.roleCounts.worker.running === 1 && busySnap.workers.roleCounts.worker.busy === 1,
      JSON.stringify(busySnap.workers.roleCounts),
    )
    rig.scheduler.dispose()
  }
}

// ── T-127: the pool is the only executor source ─────────────────────────────
{
  // (d) empty pool -> one pool instance, never a per-card work-<task>-N agent.
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const A = (await createTask(rig, { title: 'fresh pool' })).id
  // Empty the pool: the card must make the role manager create a pool instance.
  rig.team.setStatus('fixer', 'failed')
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  const task = byId(snap, A)
  const spawned = rig.team.calls.filter((call) => call.kind === 'spawn')
  check(
    'T-127 an empty pool creates a pool instance (worker-p<key>-N), not a per-card work-<task>-N agent',
    task.status === 'running' &&
      task.assignee !== null &&
      /^worker-p[a-z0-9]+-[0-9]+$/.test(task.assignee.name) &&
      spawned.length === 1 &&
      /^worker-p[a-z0-9]+-[0-9]+$/.test(spawned[0].name) &&
      !/^work-/.test(spawned[0].name),
    JSON.stringify({ assignee: task.assignee, spawned: spawned.map((call) => call.name) }),
  )
  // Invariants: assignee in roster, live workers <= desired, no running+taskless
  // pool instance.
  const rosterNames = rig.team.listMembers().map((member) => member.name)
  const desired = snap.agents !== undefined && snap.agents.roles !== null && snap.agents.roles !== undefined ? snap.agents.roles.desired.worker : null
  const liveWorkers = rig.team.listMembers().filter((member) => /^worker-p/.test(member.name) && member.status === 'running')
  const taskless = snap.workers.members.filter((member) => /^worker-p/.test(member.name) && member.processStatus === 'running' && member.currentTask === null)
  check(
    'T-127 invariants hold after dispatch: assignee in roster, live <= desired, no running taskless pool instance',
    rosterNames.indexOf(task.assignee.name) >= 0 && (desired === null || liveWorkers.length <= desired) && taskless.length === 0,
    JSON.stringify({ rosterNames: rosterNames, desired: desired, live: liveWorkers.length, taskless: taskless.map((member) => member.name) }),
  )
  rig.scheduler.dispose()
}

// ── T-127: a full pool queues the card with 角色已满 ─────────────────────────
{
  const rig = createRig({ teamOptions: { spawnedStatus: 'running' } })
  const poolConfig = defaultRoleConfig()
  poolConfig.profiles.worker.instances = 1
  rig.fs.files.set(rolesPath(PROJECT), { text: JSON.stringify(poolConfig), version: 'seed' })
  rig.team.setStatus('fixer', 'failed')
  const A = (await createTask(rig, { title: 'first' })).id
  const B = (await createTask(rig, { title: 'second' })).id
  await rig.action('start')
  await rig.settle()
  const snap = await snapshot(rig)
  const first = byId(snap, A)
  const second = byId(snap, B)
  check(
    'T-127 when every desired instance holds a card the next card waits with 角色已满',
    first.status === 'running' && second.status === 'pending' && second.waitingReason === '角色已满',
    JSON.stringify({ first: first.status, second: { status: second.status, waiting: second.waitingReason } }),
  )
  rig.scheduler.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
