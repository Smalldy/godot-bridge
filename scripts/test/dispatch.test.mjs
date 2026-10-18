// Scheduler tests: the dependency chain, start/pause, concurrency, target
// reservation, file locks, retry, lease reaping and host restart recovery.

import { join } from 'node:path'
import { updateBoard } from '../../plugin/task-center/board.mjs'
import { createState, writePolicyFor } from '../../plugin/task-center/state.mjs'
import { findTask } from '../../plugin/task-center/service.mjs'
import { createDispatcher, gitFor } from '../../plugin/task-center/dispatch.mjs'
import { createApi } from '../../plugin/task-center/api.mjs'
import { createGit } from '../../plugin/task-center/git.mjs'
import { createRig, createTask, submitAsUser, sleep, createFakeFs, createTeam, createFakeGit, PROJECT } from './support/fixtures.mjs'

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
  check('a completed task keeps its worktree for the merge request', claimed.status === 'done' && claimed.worktree === path, JSON.stringify({ status: claimed.status, worktree: claimed.worktree }))
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
    attempted.length === 2 && attempted[0].path === firstPath && attempted[1].path === firstPath && retried.branch === 'task/' + task.id + '-1',
    JSON.stringify(attempted.map((entry) => entry.path)),
  )
  check('and records the attempt-1 directory', retried.worktree === firstPath, String(retried.worktree))
  check('the failure reason is cleared on the new attempt', retried.worktreeError === null, String(retried.worktreeError))
  rig.scheduler.dispose()
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

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
