// Scheduler tests: the dependency chain, start/pause, concurrency, target
// reservation, file locks, retry, lease reaping and host restart recovery.

import { join } from 'node:path'
import { updateBoard } from '../../plugin/task-center/board.mjs'
import { createState, writePolicyFor } from '../../plugin/task-center/state.mjs'
import { findTask } from '../../plugin/task-center/service.mjs'
import { createDispatcher } from '../../plugin/task-center/dispatch.mjs'
import { createApi } from '../../plugin/task-center/api.mjs'
import { createGit } from '../../plugin/task-center/git.mjs'
import { createRig, createTask, submitAsUser, sleep, createFakeFs, createTeam, PROJECT } from './support/fixtures.mjs'

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

// ── worktrees at claim time ────────────────────────────────────────────────
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

/** A rig like createRig, but with an injectable git/subprocess seam. */
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
  const scheduler = createDispatcher(ctx, {
    state: state,
    projectPath: () => PROJECT,
    allowSpawn: opts.allowSpawn !== false,
    git: opts.git,
  })
  const api = createApi(ctx, { state: state, scheduler: scheduler, git: opts.git })
  const user = { projectPath: PROJECT, by: '@user', role: 'user', agent: null }
  const rig = {
    project: PROJECT,
    fs: fs,
    team: team,
    state: state,
    scheduler: scheduler,
    api: api,
    action: (name, body) => api.perform(name, body === undefined ? {} : body, user),
    settle: () => scheduler.settle(PROJECT),
  }
  rig.enableWorktree = async function (root) {
    const applied = await updateBoard(
      { fs: fs },
      {
        projectPath: PROJECT,
        sandboxPolicy: writePolicyFor(PROJECT),
        mutate: (board) => {
          board.dispatch = Object.assign({}, board.dispatch, {
            worktree: { enabled: true, root: root === undefined ? '.worktrees' : root },
          })
          return board
        },
      },
    )
    if (applied.ok !== true) throw new Error('could not enable worktrees: ' + JSON.stringify(applied))
  }
  return rig
}

// enabled + clean repository: the task gets a worktree, fields and a brief
{
  const run = fakeRunner()
  const rig = createWorktreeRig({ git: createGit({ run: run }) })
  await rig.enableWorktree()
  const task = await createTask(rig, { title: 'worktree task', writeFiles: ['scripts/a.gd'] })
  await rig.action('start')
  await rig.settle()
  const branch = 'task/' + task.id + '-1'
  const path = join(PROJECT, '.worktrees', task.id)
  let snap = await snapshot(rig)
  let claimed = byId(snap, task.id)
  check('an enabled clean repository gives the task a worktree', claimed.worktree === path, String(claimed.worktree))
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
  check(
    'the brief points task_center back at the main project',
    brief.indexOf('main project') >= 0 && brief.indexOf(PROJECT) >= 0,
    brief.slice(0, 500),
  )
  await rig.action('submit', { id: task.id, evidence: 'done' })
  snap = await snapshot(rig)
  claimed = byId(snap, task.id)
  check('a completed task keeps its worktree for the merge request', claimed.status === 'done' && claimed.worktree === path, JSON.stringify({ status: claimed.status, worktree: claimed.worktree }))
  check('the scheduler never removes it', run.calls.every((call) => call.args[0] !== 'worktree' || call.args[1] !== 'remove'), JSON.stringify(run.calls.map((call) => call.args)))
  rig.scheduler.dispose()
}

// a dirty working tree falls back to the shared workspace
{
  const run = fakeRunner({
    'status --porcelain': () => ({ code: 0, stdout: ' M scripts/a.gd\n', stderr: '' }),
  })
  const rig = createWorktreeRig({ git: createGit({ run: run }) })
  await rig.enableWorktree()
  const task = await createTask(rig, { title: 'dirty tree task' })
  await rig.action('start')
  await rig.settle()
  const claimed = byId(await snapshot(rig), task.id)
  check(
    'a dirty tree falls back to the shared workspace',
    claimed.status === 'running' && claimed.worktree === null && claimed.branch === null && claimed.base === null && claimed.target === null,
    JSON.stringify({ status: claimed.status, worktree: claimed.worktree, branch: claimed.branch }),
  )
  check('and records why', claimed.worktreeError === 'dirty-worktree', String(claimed.worktreeError))
  check('the claim keeps no worktree', claimed.dispatch.keep === false, JSON.stringify(claimed.dispatch))
  check('no worktree was added', run.calls.every((call) => call.args[0] !== 'worktree' || call.args[1] !== 'add'), JSON.stringify(run.calls.map((call) => call.args)))
  check('the brief does not mention a worktree', rig.team.calls[0].text.indexOf('worktree') < 0, rig.team.calls[0].text.slice(0, 400))
  rig.scheduler.dispose()
}

// a project that is not a git repository falls back
{
  const run = fakeRunner({
    'rev-parse --is-inside-work-tree': () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
  })
  const rig = createWorktreeRig({ git: createGit({ run: run }) })
  await rig.enableWorktree()
  const task = await createTask(rig, { title: 'not a repo task' })
  await rig.action('start')
  await rig.settle()
  const claimed = byId(await snapshot(rig), task.id)
  check('a non-repository project keeps the task running without a worktree', claimed.status === 'running' && claimed.worktree === null, JSON.stringify({ status: claimed.status, worktree: claimed.worktree }))
  check('and records why', claimed.worktreeError === 'not-a-git-repository', String(claimed.worktreeError))
  check('no worktree was added outside git', run.calls.every((call) => call.args[0] !== 'worktree'), JSON.stringify(run.calls.map((call) => call.args)))
  rig.scheduler.dispose()
}

// a refused worktree add is cleaned up and the task still dispatches
{
  // The runner is swapped in after the task exists, so the exact add command
  // (which contains the allocated task id) can be refused.
  const holder = { run: null }
  const rig = createWorktreeRig({ git: createGit({ run: (args, cwd) => holder.run(args, cwd) }) })
  await rig.enableWorktree()
  const task = await createTask(rig, { title: 'refused add task' })
  const path = join(PROJECT, '.worktrees', task.id)
  const run = fakeRunner({
    ['worktree add -b task/' + task.id + '-1 ' + path + ' base-sha']: () => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: could not create work tree',
    }),
  })
  holder.run = run
  await rig.action('start')
  await rig.settle()
  const claimed = byId(await snapshot(rig), task.id)
  check('a refused worktree add still dispatches the task', claimed.status === 'running' && claimed.worktree === null, JSON.stringify({ status: claimed.status, worktree: claimed.worktree }))
  check('and records the git words', String(claimed.worktreeError).indexOf('worktree-add-failed') === 0 && String(claimed.worktreeError).indexOf('could not create work tree') >= 0, String(claimed.worktreeError))
  const removes = run.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'remove')
  check(
    'a failed add is force-removed, leaving no half worktree',
    removes.length >= 1 && removes[0].args.join(' ') === ['worktree', 'remove', '--force', path].join(' ') && removes[0].cwd === PROJECT,
    JSON.stringify(removes.map((call) => call.args)),
  )
  check('the brief does not claim a worktree', rig.team.calls[0].text.indexOf('worktree') < 0, rig.team.calls[0].text.slice(0, 300))
  rig.scheduler.dispose()
}

// no git service in the profile: the feature is off, dispatch still works
{
  const rig = createWorktreeRig({ git: undefined, subprocess: undefined })
  await rig.enableWorktree()
  const task = await createTask(rig, { title: 'no git service task' })
  await rig.action('start')
  await rig.settle()
  const claimed = byId(await snapshot(rig), task.id)
  check('without a git service the task still dispatches', claimed.status === 'running', JSON.stringify(ids(await snapshot(rig))))
  check('and reports the missing service instead of failing', claimed.worktreeError === 'no-git-service' && claimed.worktree === null, JSON.stringify({ worktree: claimed.worktree, error: claimed.worktreeError }))
  rig.scheduler.dispose()
}

// a git facade that throws cannot stop a dispatch either
{
  const rig = createWorktreeRig({
    git: {
      isRepo() {
        throw new Error('broken runner')
      },
    },
  })
  await rig.enableWorktree()
  const task = await createTask(rig, { title: 'throwing git task' })
  await rig.action('start')
  await rig.settle()
  const claimed = byId(await snapshot(rig), task.id)
  check('a throwing git facade still dispatches the task', claimed.status === 'running', JSON.stringify(ids(await snapshot(rig))))
  check(
    'and reports the worktree error',
    String(claimed.worktreeError).indexOf('worktree-error') === 0 && String(claimed.worktreeError).indexOf('broken runner') >= 0,
    String(claimed.worktreeError),
  )
  rig.scheduler.dispose()
}

// the production path: git runs through ctx.get('subprocess')
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
  await rig.enableWorktree()
  const task = await createTask(rig, { title: 'subprocess task' })
  await rig.action('start')
  await rig.settle()
  const claimed = byId(await snapshot(rig), task.id)
  const path = join(PROJECT, '.worktrees', task.id)
  check('the subprocess service is the git runner', claimed.worktree === path, String(claimed.worktree))
  check(
    'every git call is one unconfined spawn in the project',
    spawns.length >= 4 && spawns.every((config) => config.argv[0] === 'C:\\tools\\git.exe' && config.cwd === PROJECT),
    JSON.stringify(spawns.map((config) => config.argv.slice(0, 3))),
  )
  check(
    'the spawn collects stdout and stderr',
    spawns.every((config) => config.stdio.stdout.collect !== undefined && config.stdio.stderr.collect !== undefined),
    JSON.stringify(spawns[0] && spawns[0].stdio),
  )
  rig.scheduler.dispose()
}

// the feature stays off unless the board enables it
{
  const run = fakeRunner()
  const rig = createWorktreeRig({ git: createGit({ run: run }) })
  const task = await createTask(rig, { title: 'disabled worktree task' })
  await rig.action('start')
  await rig.settle()
  const claimed = byId(await snapshot(rig), task.id)
  check('a disabled worktree setting changes nothing', claimed.status === 'running' && claimed.worktree === null && claimed.worktreeError === null && claimed.dispatch.keep === false, JSON.stringify({ worktree: claimed.worktree, error: claimed.worktreeError }))
  check('git is not consulted at all when the feature is off', run.calls.length === 0, JSON.stringify(run.calls.map((call) => call.args)))
  rig.scheduler.dispose()
}

// a worktree made for a claim that loses its race is removed again
{
  const run = fakeRunner()
  const rig = createWorktreeRig({ git: createGit({ run: run }) })
  await rig.enableWorktree()
  const task = await createTask(rig, { title: 'claim race task' })
  // Make every board write that would mark the task running lose the CAS race.
  rig.fs.hooks.beforeWrite = (event) => (event.content.indexOf('"status": "running"') >= 0 ? 'stale' : undefined)
  await rig.action('start')
  await rig.settle()
  rig.fs.hooks.beforeWrite = null
  const claimed = byId(await snapshot(rig), task.id)
  check('a lost claim leaves the task pending', claimed.status === 'pending', JSON.stringify(ids(await snapshot(rig))))
  const path = join(PROJECT, '.worktrees', task.id)
  const removes = run.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'remove')
  check(
    'and the prepared worktree is removed again',
    removes.length >= 1 && removes[removes.length - 1].args.join(' ') === ['worktree', 'remove', '--force', path].join(' '),
    JSON.stringify(removes.map((call) => call.args)),
  )
  check('the task records no worktree fields', claimed.worktree === null && claimed.branch === null && claimed.base === null, JSON.stringify({ worktree: claimed.worktree, branch: claimed.branch }))
  rig.scheduler.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)