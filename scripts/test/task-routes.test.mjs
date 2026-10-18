// HTTP route tests: the GUI's contract, its transport hardening and the fact
// that it calls the same actions as the tool.

import { join } from 'node:path'
import { registerTaskRoutes, STATE_PATH, ACTION_PATH } from '../../plugin/task-center/routes.mjs'
import { createFakeFs, createRig, createTeam, PROJECT, seedBoard } from './support/fixtures.mjs'
import { createGit } from '../../plugin/task-center/git.mjs'
import { createState } from '../../plugin/task-center/state.mjs'
import { createActivity, createDispatcher, createRoleManager } from '../../plugin/task-center/dispatch.mjs'
import { rolesPath } from '../../plugin/task-center/board.mjs'
import { createApi } from '../../plugin/task-center/api.mjs'
import { createMerger } from '../../plugin/task-center/merge.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

function install(rig) {
  const specs = []
  const webCtx = Object.assign({}, rig.ctx, {
    webServer: {
      register(spec) {
        specs.push(spec)
        return () => {}
      },
    },
  })
  const dispose = registerTaskRoutes(webCtx, { state: rig.state, api: rig.api, scheduler: rig.scheduler })
  const byPath = new Map(specs.map((spec) => [spec.path, spec]))
  return { specs, byPath, dispose }
}

function request(url, options) {
  const opts = options === undefined ? {} : options
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  return {
    method: opts.method === undefined ? 'GET' : opts.method,
    url: url,
    headers: opts.headers === undefined ? {} : opts.headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response() {
  return {
    status: 0,
    headers: null,
    text: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.text = String(text === undefined ? '' : text)
    },
    json() {
      return JSON.parse(this.text)
    },
  }
}

async function call(surface, url, options) {
  const res = response()
  await surface.byPath.get(url.split('?')[0]).handler(request(url, options), res)
  return res
}
const post = (body, headers) =>
  call(surface, ACTION_PATH, { method: 'POST', body: body, headers: Object.assign({ 'content-type': 'application/json' }, headers) })
const postTo = (target, body) =>
  call(target, ACTION_PATH, { method: 'POST', body: body, headers: { 'content-type': 'application/json' } })

const rig = createRig({ allowSpawn: false })
const surface = install(rig)
check('registers state, action and diagnostics', surface.specs.length === 3, String(surface.specs.length))

// no project yet
{
  const res = await call(surface, STATE_PATH, {})
  check('state without a project says so', res.status === 200 && res.json().ok === false && res.json().code === 'unknown-project', res.text)
}

// a project in the query is adopted
{
  const url = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  const res = await call(surface, url, {})
  const payload = res.json()
  check('state with a project answers', payload.ok === true && payload.project === PROJECT, res.text)
  check('and reports the dispatch state', payload.dispatch.state === 'paused')
  check('and remembers the project', rig.state.memory.projectHint === PROJECT)
}

// create, start, pause through the action route
{
  let res = await post({ action: 'create', title: 'A', dependsOn: [] })
  let payload = res.json()
  check('the route creates a task', payload.ok === true && payload.task.title === 'A', res.text)
  check('the response carries the board snapshot', payload.snapshot !== undefined && payload.snapshot.tasks.length === 1)
  const id = payload.task.id
  res = await post({ action: 'start' })
  payload = res.json()
  check('the route starts dispatch', payload.ok === true && payload.dispatch.state === 'running', res.text)
  res = await post({ action: 'pause' })
  check('the route pauses dispatch', res.json().dispatch.state === 'paused', res.text)
  res = await post({ action: 'get', id: id })
  check('the route reads one task', res.json().ok === true && res.json().task.id === id, res.text)
  res = await post({ action: 'board' })
  check('the route returns the board', res.json().ok === true && res.json().tasks.length === 1)
}

// one public setting: concurrency; the worker cap is derived
{
  const res = await post({ action: 'settings', maxConcurrent: 5 })
  const payload = res.json()
  check('settings accepts a single concurrency value', payload.ok === true && payload.dispatch.maxConcurrent === 5, res.text)
  check('the worker cap derives as concurrency + 1', payload.dispatch.maxWorkAgents === 6, JSON.stringify(payload.dispatch))
  check('spawning stays enabled by the same setting', payload.dispatch.allowSpawn === true, JSON.stringify(payload.dispatch))
}

// consent: an agent can request dispatch, but only the user starts it
{
  await post({ action: 'pause' })
  const agent = { projectPath: PROJECT, by: '@agent', role: 'agent', agent: { id: 'session-agent' } }
  const requested = await rig.api.perform('start', { note: 'deps are ready' }, agent)
  check('an agent start returns needs-consent', requested.ok === false && requested.code === 'needs-consent', JSON.stringify(requested))
  check('and records a request', requested.request !== null && requested.request.by === '@agent', JSON.stringify(requested.request))
  const state = await call(surface, STATE_PATH, {})
  check('the panel snapshot exposes the request', state.json().dispatch.request !== null && state.json().dispatch.request.note === 'deps are ready', state.text)
  const approved = await post({ action: 'approveStart' })
  check('the user can approve the request', approved.json().ok === true && approved.json().dispatch.state === 'running', approved.text)
  check('approving clears the request', approved.json().dispatch.request === null, approved.text)
  await post({ action: 'pause' })
  await rig.api.perform('start', {}, agent)
  const rejected = await post({ action: 'rejectStart' })
  check('the user can reject the request', rejected.json().ok === true && rejected.json().dispatch.state === 'paused', rejected.text)
  check('rejecting clears the request', rejected.json().dispatch.request === null, rejected.text)
  const denied = await rig.api.perform('settings', { maxConcurrent: 2 }, agent)
  check('an agent cannot change dispatch settings', denied.ok === false && denied.code === 'user-only', JSON.stringify(denied))
}

// transport hardening
{
  const res = await post({ action: 'board' }, { 'content-type': 'text/plain' })
  check('a non-JSON body is refused', res.status === 415 && res.json().code === 'content-type', res.text)
  const evil = await post({ action: 'board' }, { origin: 'https://evil.example', host: 'localhost:1234' })
  check('a cross-origin action is refused', evil.status === 403 && evil.json().code === 'origin', evil.text)
  const same = await post({ action: 'board' }, { origin: 'http://localhost:1234', host: 'localhost:1234' })
  check('a same-origin action is allowed', same.status === 200 && same.json().ok === true)
  const bad = await call(surface, ACTION_PATH, { method: 'POST', headers: { 'content-type': 'application/json' } })
  check('an empty action is refused', bad.status === 400 && bad.json().code === 'no-action', bad.text)
  const unknown = await post({ action: 'launchRockets' })
  check('an unknown action is a refusal, not a crash', unknown.status === 200 && unknown.json().ok === false && unknown.json().code === 'unknown-action', unknown.text)
}

// openProject moves the panel, after checking the directory exists
{
  const other = join(PROJECT, '..', 'second-project')
  rig.fs.dirs.add(other)
  const res = await post({ action: 'openProject', path: other })
  const payload = res.json()
  check('openProject switches the project', payload.ok === true && payload.project === other, res.text)
  check('and the hint moved', rig.state.memory.projectHint === other)
  const missing = await post({ action: 'openProject', path: join(other, 'missing') })
  check('a missing directory is refused', missing.json().ok === false && missing.json().code === 'not-a-directory', missing.text)
}

// locks through the route
{
  const res = await post({ action: 'lock', paths: ['scripts/a.gd'] })
  const payload = res.json()
  check('the route can take a user lock', payload.ok === true && payload.granted === true, res.text)
  check('the lock is visible in the snapshot', payload.snapshot.locks.some((lock) => lock.path === 'scripts/a.gd'))
  const forced = await post({ action: 'forceUnlock', paths: ['scripts/a.gd'] })
  check('the route can force a lock away', forced.json().ok === true && forced.json().released.join(',') === 'scripts/a.gd', forced.text)
}

// waiting reasons: why a pending task has not been dispatched (report only)
{
  const stamp = new Date().toISOString()
  const lease = new Date(Date.now() + 600000).toISOString()
  const shared = {
    priority: 0,
    dependsOn: [],
    writeFiles: [],
    assignee: null,
    attempts: 0,
    maxAttempts: 3,
    evidence: '',
    dispatch: null,
    leaseUntil: null,
    createdBy: '@test',
    createdAt: stamp,
    updatedAt: stamp,
    history: [],
  }
  const task = (id, title, status, extra) => Object.assign({ id: id, title: title, status: status }, shared, extra)
  const waitingRig = createRig({
    allowSpawn: false,
    teamOptions: { roster: [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }] },
  })
  // maxConcurrent is 1 and one task is already running, so T-3 sits behind a
  // full budget while T-2 sits behind T-1's file lock.
  const board = {
    version: 2,
    seq: 7,
    dispatch: { state: 'running', maxConcurrent: 1, allowSpawn: false, maxWorkAgents: 1, maxAttempts: 3, request: null },
    updatedAt: stamp,
    tasks: [
      task('T-1', 'Running holder', 'running', {
        writeFiles: ['scripts/shared.gd'],
        assignee: { name: 'owner', session: 'session-owner' },
        attempts: 1,
        leaseUntil: lease,
        dispatch: {
          status: 'claimed',
          at: stamp,
          target: 'owner',
          targetId: 'session-owner',
          via: 'spawn',
          error: null,
          host: waitingRig.scheduler.boot,
        },
      }),
      task('T-2', 'Blocked by a held file', 'pending', { writeFiles: ['scripts/shared.gd'] }),
      task('T-3', 'Ready but the budget is full', 'pending'),
      task('T-4', 'Missing dependency', 'pending', { dependsOn: ['T-99'] }),
      task('T-5', 'Waiting on a running task', 'pending', { dependsOn: ['T-1'] }),
      task('T-6', 'Already done', 'done'),
    ],
  }
  seedBoard(waitingRig.fs, waitingRig.project, JSON.stringify(board))
  const waitingSurface = install(waitingRig)
  const projectUrl = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  const loaded = await call(waitingSurface, projectUrl, {})
  check('a seeded board is read back', loaded.json().ok === true && loaded.json().tasks.length === 6, loaded.text)
  const held = await postTo(waitingSurface, { action: 'lock', paths: ['scripts/shared.gd'], taskId: 'T-1' })
  check('one task can hold the file another task declares', held.json().ok === true && held.json().granted === true, held.text)
  const runningBoard = await postTo(waitingSurface, { action: 'board' })
  const reasons = new Map(runningBoard.json().tasks.map((entry) => [entry.id, entry.waitingReason]))
  check('a file lock another task holds reports file-lock', reasons.get('T-2') === 'file-lock', String(reasons.get('T-2')))
  check('a full concurrency budget reports concurrency', reasons.get('T-3') === 'concurrency', String(reasons.get('T-3')))
  check('a missing dependency reports dependency-broken', reasons.get('T-4') === 'dependency-broken', String(reasons.get('T-4')))
  check('an unfinished dependency reports dependency', reasons.get('T-5') === 'dependency', String(reasons.get('T-5')))
  check(
    'a task that is not pending has no waiting reason',
    reasons.get('T-1') === null && reasons.get('T-6') === null,
    JSON.stringify([reasons.get('T-1'), reasons.get('T-6')]),
  )
  const detail = await postTo(waitingSurface, { action: 'get', id: 'T-2' })
  check('the detail action carries the same reason', detail.json().task.waitingReason === 'file-lock', detail.text)
  const roomy = await postTo(waitingSurface, { action: 'settings', maxConcurrent: 2 })
  check('the concurrency budget can be raised', roomy.json().ok === true && roomy.json().dispatch.maxConcurrent === 2, roomy.text)
  const roomyBoard = await postTo(waitingSurface, { action: 'board' })
  const roomyReasons = new Map(roomyBoard.json().tasks.map((entry) => [entry.id, entry.waitingReason]))
  check('a ready task with a free slot has no waiting reason', roomyReasons.get('T-3') === null, String(roomyReasons.get('T-3')))
  check('a file lock still outranks a free slot', roomyReasons.get('T-2') === 'file-lock', String(roomyReasons.get('T-2')))
  const paused = await postTo(waitingSurface, { action: 'pause' })
  check('dispatch can be paused over this board', paused.json().ok === true && paused.json().dispatch.state === 'paused', paused.text)
  const pausedBoard = await postTo(waitingSurface, { action: 'board' })
  const pausedReasons = new Map(pausedBoard.json().tasks.map((entry) => [entry.id, entry.waitingReason]))
  check(
    'a paused dispatch outranks every other reason',
    pausedReasons.get('T-2') === 'dispatch-paused' && pausedReasons.get('T-3') === 'dispatch-paused',
    JSON.stringify([pausedReasons.get('T-2'), pausedReasons.get('T-3')]),
  )
  check('pausing adds no reason to a running task', pausedReasons.get('T-1') === null, String(pausedReasons.get('T-1')))
  waitingSurface.dispose()
  waitingRig.scheduler.dispose()
}

// the worker pool and the tasks waiting on a held file (report only)
{
  const stamp = new Date().toISOString()
  const lease = new Date(Date.now() + 600000).toISOString()
  const shared = {
    priority: 0,
    dependsOn: [],
    writeFiles: [],
    assignee: null,
    attempts: 0,
    maxAttempts: 3,
    evidence: '',
    dispatch: null,
    leaseUntil: null,
    createdBy: '@test',
    createdAt: stamp,
    updatedAt: stamp,
    history: [],
  }
  const task = (id, title, status, extra) => Object.assign({ id: id, title: title, status: status }, shared, extra)
  const poolRig = createRig({
    allowSpawn: false,
    agents: { list: () => [{ id: 'session-lead', name: 'lead' }] },
    teamOptions: {
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
        { id: 'session-idler', name: 'idler', role: 'teammate', status: 'inactive' },
        { id: 'session-starter', name: 'starter', role: 'teammate', status: 'provisioning' },
        { id: 'session-dead', name: 'dead', role: 'teammate', status: 'failed' },
        { id: 'session-helper', name: 'helper', role: 'assistant', status: 'running' },
      ],
    },
  })
  const poolBoard = {
    version: 2,
    seq: 6,
    dispatch: { state: 'running', maxConcurrent: 2, allowSpawn: true, maxWorkAgents: 4, maxAttempts: 3, request: null },
    updatedAt: stamp,
    tasks: [
      task('T-1', 'Holds the shared file', 'running', {
        writeFiles: ['scripts/shared.gd'],
        assignee: { name: 'fixer', session: 'session-fixer' },
        attempts: 1,
        leaseUntil: lease,
        dispatch: {
          status: 'claimed',
          at: stamp,
          target: 'fixer',
          targetId: 'session-fixer',
          via: 'spawn',
          error: null,
          host: poolRig.scheduler.boot,
        },
      }),
      task('T-2', 'Waits for the shared file', 'pending', { writeFiles: ['scripts/shared.gd'] }),
      task('T-3', 'Waits on T-1 first', 'pending', { dependsOn: ['T-1'], writeFiles: ['scripts/shared.gd'] }),
      task('T-4', 'Declares another file', 'pending', { writeFiles: ['scripts/other.gd'] }),
      task('T-5', 'Already done', 'done'),
    ],
  }
  seedBoard(poolRig.fs, poolRig.project, JSON.stringify(poolBoard))
  const poolSurface = install(poolRig)
  const projectUrl = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  const poolState = await call(poolSurface, projectUrl, {})
  const workers = poolState.json().workers
  check('the snapshot reports a worker pool', workers !== undefined && workers !== null, poolState.text)
  check('the pool names its lead', workers.lead === 'lead', String(workers.lead))
  check(
    'only teammates are listed',
    workers.members.map((member) => member.id).join(',') === 'session-fixer,session-idler,session-starter,session-dead',
    JSON.stringify(workers.members.map((member) => member.id)),
  )
  check(
    'the pool counts busy, idle, provisioning and failed workers',
    workers.busy === 1 && workers.idle === 1 && workers.provisioning === 1 && workers.failed === 1,
    JSON.stringify([workers.busy, workers.idle, workers.provisioning, workers.failed]),
  )
  check('the pool reports the spawn cap from the board', workers.cap === 4, String(workers.cap))
  check('a complete pool reports no error', workers.error === null, String(workers.error))
  check(
    'a busy teammate names the task it runs',
    JSON.stringify(workers.members[0].currentTask) === JSON.stringify({ id: 'T-1', title: 'Holds the shared file' }),
    JSON.stringify(workers.members[0].currentTask),
  )
  check('an idle teammate owns no task', workers.members[1].currentTask === null, JSON.stringify(workers.members[1].currentTask))

  const poolLock = await postTo(poolSurface, { action: 'lock', paths: ['scripts/shared.gd'], taskId: 'T-1' })
  check('the running task holds its file', poolLock.json().ok === true && poolLock.json().granted === true, poolLock.text)
  await postTo(poolSurface, { action: 'lock', paths: ['scripts/other.gd'] })
  await postTo(poolSurface, { action: 'lock', paths: ['scripts/free.gd'] })
  const lockedBoard = await postTo(poolSurface, { action: 'board' })
  const lockRows = lockedBoard.json().locks
  const sharedRow = lockRows.filter((row) => row.path === 'scripts/shared.gd')[0]
  check('a held file lists the ready tasks that would wait for it', sharedRow !== undefined && sharedRow.waiters.map((waiter) => waiter.id).join(',') === 'T-2', JSON.stringify(sharedRow === undefined ? null : sharedRow.waiters))
  check('a waiter carries the task title', sharedRow.waiters[0].title === 'Waits for the shared file', JSON.stringify(sharedRow.waiters[0]))
  check('the holder is not its own waiter', sharedRow.waiters.some((waiter) => waiter.id === 'T-1') === false)
  check('a task whose dependency is unfinished does not wait yet', sharedRow.waiters.some((waiter) => waiter.id === 'T-3') === false)
  const otherRow = lockRows.filter((row) => row.path === 'scripts/other.gd')[0]
  check('a runner-up file names the task that declares it', otherRow !== undefined && otherRow.waiters.map((waiter) => waiter.id).join(',') === 'T-4', JSON.stringify(otherRow === undefined ? null : otherRow.waiters))
  const freeRow = lockRows.filter((row) => row.path === 'scripts/free.gd')[0]
  check('a lock nobody declares has no waiters', freeRow !== undefined && freeRow.waiters.length === 0, JSON.stringify(freeRow === undefined ? null : freeRow.waiters))
  poolSurface.dispose()
  poolRig.scheduler.dispose()
}

// the pool degrades to a report when the team services are absent
{
  const noTeamRig = createRig({ allowSpawn: false, team: null })
  const noTeamSurface = install(noTeamRig)
  const projectUrl = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  const noTeamState = await call(noTeamSurface, projectUrl, {})
  const workers = noTeamState.json().workers
  check('a profile without team services still answers', noTeamState.json().ok === true && workers !== undefined, noTeamState.text)
  check('and reports no members', workers.members.length === 0 && workers.busy === 0 && workers.idle === 0, JSON.stringify(workers.members))
  check('and names the missing service', workers.error === 'no-team-service', String(workers.error))
  check('and still reports the cap from the board', workers.cap === 4, String(workers.cap))
  noTeamSurface.dispose()
  noTeamRig.scheduler.dispose()

  const leadlessRig = createRig({ allowSpawn: false, agents: { list: () => [] } })
  const leadlessSurface = install(leadlessRig)
  const leadlessState = await call(leadlessSurface, projectUrl, {})
  const leadless = leadlessState.json().workers
  check('a team with no live lead reports no-lead', leadless.error === 'no-lead' && leadless.lead === null && leadless.members.length === 0, JSON.stringify(leadless))
  leadlessSurface.dispose()
  leadlessRig.scheduler.dispose()
}

// ── submit commits a task worktree and opens a merge request ───────────────
// The submit rig has an injectable git and NO Agent Teams service: producing a
// merge request must not depend on a Lead.
function createSubmitRig(options) {
  const opts = options === undefined ? {} : options
  const fs = createFakeFs()
  fs.dirs.add(PROJECT)
  const team = opts.team === undefined || opts.team === null ? null : opts.team
  // A team service is optional: the commit path must work without one, and the
  // notification path is exactly what a team adds.
  const agents = opts.agents === undefined ? (team === null ? undefined : { list: () => [{ id: 'session-lead' }] }) : opts.agents
  const ctx = {
    fs: fs,
    sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
    get(key) {
      if (key === 'agents') return agents
      if (key === 'agentTeams') return team
      return undefined
    },
  }
  const state = createState(ctx)
  const roles = opts.roles === true ? createRoleManager(ctx) : opts.roles === undefined ? null : opts.roles
  const activity = opts.activity === undefined ? null : opts.activity
  const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: false, git: opts.git, roles: roles, activity: activity })
  const api = createApi(ctx, {
    state: state,
    scheduler: scheduler,
    git: opts.git,
    merger: opts.merger,
    verify: opts.verify,
    verifyCommand: opts.verifyCommand,
    autoMerge: opts.autoMerge,
    roles: roles,
    godotPath: opts.godotPath,
    activity: activity,
  })
  const user = { projectPath: PROJECT, by: '@user', role: 'user', agent: null }
  async function action(name, body) {
    return api.perform(name, body === undefined ? {} : body, user)
  }
  return { project: PROJECT, fs: fs, ctx: ctx, state: state, scheduler: scheduler, api: api, team: team, user: user, action: action }
}

/** A fake git for commit/diff; every call is recorded, no process is started. */
function fakeGit(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  const run = (args, cwd) => {
    calls.push({ args: args.slice(), cwd: cwd })
    const key = args.join(' ')
    if (key === 'rev-parse HEAD') return { code: 0, stdout: String(opts.head === undefined ? 'head-sha' : opts.head) + '\n', stderr: '' }
    if (key === 'worktree list --porcelain' && opts.worktrees !== undefined) {
      const blocks = opts.worktrees.map(
        (entry) =>
          'worktree ' + entry.path + '\nHEAD ' + (entry.head === undefined ? 'head-sha' : entry.head) + '\n' + (entry.branch === undefined || entry.branch === null ? 'detached\n' : 'branch refs/heads/' + entry.branch + '\n'),
      )
      return { code: 0, stdout: blocks.join('\n'), stderr: '' }
    }
    if (key.indexOf('diff --name-only ') === 0) {
      return opts.diff === undefined ? { code: 0, stdout: 'scripts/a.gd\nscripts/b.gd\n', stderr: '' } : opts.diff(args)
    }
    if (key.indexOf('commit -m ') === 0 && opts.commit !== undefined) return opts.commit
    return { code: 0, stdout: '', stderr: '' }
  }
  return { git: createGit({ run: run }), calls: calls }
}

function runningWorktreeTask(overrides) {
  const now = Date.now()
  return Object.assign(
    {
      id: 'T-1',
      title: 'MR task',
      status: 'running',
      priority: 0,
      dependsOn: [],
      writeFiles: ['scripts/a.gd'],
      base: 'base-sha',
      target: 'main',
      branch: 'task/T-1-1',
      worktree: join(PROJECT, '.worktrees', 'T-1'),
      assignee: { name: 'fixer', session: 'session-fixer' },
      attempts: 1,
      maxAttempts: 3,
      leaseUntil: new Date(now + 600000).toISOString(),
      dispatch: { status: 'sent', at: new Date(now).toISOString(), target: 'fixer', targetId: 'session-fixer', via: 'message', error: null, host: 'test' },
      createdAt: new Date(now - 60000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      spec: '',
      acceptance: '',
      evidence: '',
      history: [],
    },
    overrides === undefined ? {} : overrides,
  )
}

function seedRunningTask(rig, task) {
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [task] }))
}

function holdFile(rig, path) {
  rig.state.memory.locks = {
    [path]: {
      path: path,
      taskId: 'T-1',
      agent: 'fixer',
      since: new Date().toISOString(),
      leaseUntil: new Date(Date.now() + 600000).toISOString(),
    },
  }
}

{
  const fake = fakeGit()
  const submitRig = createSubmitRig({ git: fake.git })
  const task = runningWorktreeTask()
  seedRunningTask(submitRig, task)
  holdFile(submitRig, 'scripts/a.gd')
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'npm run verify', note: 'MR ready' })
  const payload = res.json()
  check('submit succeeds in the task worktree without any Team service', payload.ok === true && payload.task.status === 'reviewing', res.text)
  check('submit records the commit hash', payload.task.commit === 'head-sha', JSON.stringify(payload.task))
  check(
    'submit records actual files beyond the declared list',
    payload.task.actualFiles.join(',') === 'scripts/a.gd,scripts/b.gd',
    JSON.stringify(payload.task.actualFiles),
  )
  const merge = payload.task.merge
  check(
    'submit opens a merge request against the recorded base and target',
    merge !== null && merge.status === 'open' && merge.base === 'base-sha' && merge.target === 'main' && merge.head === 'head-sha',
    JSON.stringify(merge),
  )
  check(
    'the merge keeps declared and actual files separately',
    merge.declaredFiles.join(',') === 'scripts/a.gd' && merge.actualFiles.join(',') === 'scripts/a.gd,scripts/b.gd',
    JSON.stringify(merge),
  )
  check(
    'the merge carries the evidence as tests and clears reviewer/conflict',
    merge.tests === 'npm run verify' && merge.reviewer === null && merge.conflict === null && typeof merge.at === 'string',
    JSON.stringify(merge),
  )
  check('submit opens the first review round', payload.task.review !== null && payload.task.review.status === 'pending' && payload.task.review.attempt === 1, JSON.stringify(payload.task.review))
  check('and records no verdict on the merge', merge.verdict === undefined, JSON.stringify(merge.verdict))
  check('submit keeps the worktree for the merge request', payload.task.worktree === task.worktree, String(payload.task.worktree))
  const addCall = fake.calls.filter((entry) => entry.args.join(' ') === 'add -A')[0]
  const commitCall = fake.calls.filter((entry) => entry.args[0] === 'commit')[0]
  const diffCall = fake.calls.filter((entry) => entry.args[0] === 'diff')[0]
  check(
    'git commits only inside the task worktree',
    addCall !== undefined && addCall.cwd === task.worktree && commitCall !== undefined && commitCall.cwd === task.worktree && diffCall !== undefined && diffCall.cwd === task.worktree,
    JSON.stringify(fake.calls),
  )
  check(
    'the commit message names the task',
    commitCall !== undefined && commitCall.args.join(' ') === 'commit -m task-center: T-1 MR task',
    JSON.stringify(commitCall && commitCall.args),
  )
  check(
    'the diff spans the recorded base and the new head',
    diffCall !== undefined && diffCall.args.join(' ') === 'diff --name-only base-sha head-sha',
    JSON.stringify(diffCall && diffCall.args),
  )
  check('submit releases the task file locks', submitRig.state.memory.locks['scripts/a.gd'] === undefined, JSON.stringify(Object.keys(submitRig.state.memory.locks)))
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}

{
  // no changes to commit: readable error, task still running, locks untouched
  const fake = fakeGit({ commit: { code: 1, stdout: 'nothing to commit, working tree clean\n', stderr: '' }, head: 'base-sha' })
  const submitRig = createSubmitRig({ git: fake.git })
  seedRunningTask(submitRig, runningWorktreeTask())
  holdFile(submitRig, 'scripts/a.gd')
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'done' })
  const payload = res.json()
  check('a worktree with no changes refuses submit', payload.ok === false && payload.code === 'nothing-to-commit', res.text)
  const after = await call(submitSurface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  const still = after.json().tasks.filter((item) => item.id === 'T-1')[0]
  check('the task stays running', still !== undefined && still.status === 'running', after.text)
  check('and no merge request is written', still.commit === null && still.merge === null, JSON.stringify({ commit: still.commit, merge: still.merge }))
  check('and its file lock is still held', submitRig.state.memory.locks['scripts/a.gd'] !== undefined, JSON.stringify(Object.keys(submitRig.state.memory.locks)))
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}

{
  // git refuses the commit: the refusal stays readable and the task stays running
  const fake = fakeGit({ commit: { code: 128, stdout: '', stderr: 'fatal: unable to write commit\n' } })
  const submitRig = createSubmitRig({ git: fake.git })
  seedRunningTask(submitRig, runningWorktreeTask())
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'done' })
  const payload = res.json()
  check(
    'a git failure refuses submit with a readable error',
    payload.ok === false && payload.code === 'commit-failed' && payload.message.indexOf('unable to write commit') >= 0,
    res.text,
  )
  const after = await call(submitSurface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  check('the task is still running after a git failure', after.json().tasks[0].status === 'running', after.text)
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}

{
  // submit on a task that is not running must not touch its worktree
  const fake = fakeGit()
  const submitRig = createSubmitRig({ git: fake.git })
  seedRunningTask(submitRig, runningWorktreeTask({ status: 'done' }))
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'again' })
  const payload = res.json()
  check('submit refuses a task that is not running', payload.ok === false && payload.code === 'not-running', res.text)
  check('and never commits or diffs its worktree', fake.calls.length === 0, JSON.stringify(fake.calls))
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}


{
  // a prior submit committed the branch but the board write failed: reuse HEAD
  const fake = fakeGit({ commit: { code: 1, stdout: 'nothing to commit, working tree clean\n', stderr: '' }, head: 'prior-sha' })
  const submitRig = createSubmitRig({ git: fake.git })
  seedRunningTask(submitRig, runningWorktreeTask())
  holdFile(submitRig, 'scripts/a.gd')
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'retry' })
  const payload = res.json()
  check('a retry reuses an already committed worktree', payload.ok === true && payload.task.commit === 'prior-sha', res.text)
  const diffCall = fake.calls.filter((entry) => entry.args[0] === 'diff')[0]
  check(
    'the retry diffs the recorded base against the existing head',
    diffCall !== undefined && diffCall.args.join(' ') === 'diff --name-only base-sha prior-sha',
    JSON.stringify(diffCall && diffCall.args),
  )
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}
{
  // a throwing git facade becomes a readable refusal, not an unhandled error
  const submitRig = createSubmitRig({
    git: {
      commitAll() {
        throw new Error('runner exploded')
      },
      diffNameOnly() {
        throw new Error('must not be reached')
      },
    },
  })
  seedRunningTask(submitRig, runningWorktreeTask())
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'done' })
  const payload = res.json()
  check(
    'a thrown git error refuses submit readably',
    res.status === 200 && payload.ok === false && payload.code === 'commit-failed' && payload.message.indexOf('runner exploded') >= 0,
    res.text,
  )
  const after = await call(submitSurface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  check('the task stays running after a thrown git error', after.json().tasks[0].status === 'running', after.text)
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}

{
  // a task without a worktree keeps the old submit behavior and never calls git
  const fake = fakeGit()
  const submitRig = createSubmitRig({ git: fake.git })
  seedRunningTask(submitRig, runningWorktreeTask({ base: null, target: null, branch: null, worktree: null }))
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'plain done' })
  const payload = res.json()
  check('a task without a worktree submits without a merge request', payload.ok === true && payload.task.status === 'reviewing', res.text)
  check(
    'and records no commit, actual files or merge',
    payload.task.commit === null && payload.task.merge === null && payload.task.actualFiles.length === 0,
    JSON.stringify({ commit: payload.task.commit, merge: payload.task.merge, actualFiles: payload.task.actualFiles }),
  )
  check(
    'and git is never consulted for the commit',
    fake.calls.every((entry) => entry.args.join(' ') === 'worktree list --porcelain'),
    JSON.stringify(fake.calls),
  )
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}

// worktrees are the execution model: start refuses an unusable environment
{
  const noGit = createRig({ git: null })
  const noGitSurface = install(noGit)
  const projectUrl = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  await call(noGitSurface, projectUrl, {})
  const created = await postTo(noGitSurface, { action: 'create', title: 'needs a worktree' })
  const refused = await postTo(noGitSurface, { action: 'start' })
  check('start refuses without a git service', refused.json().ok === false && refused.json().code === 'worktree-unavailable', refused.text)
  check(
    'and the refusal names the worktree problem',
    refused.json().worktree === 'no-git-service' && String(refused.json().message).indexOf('worktree') >= 0,
    refused.text,
  )
  const state = await call(noGitSurface, projectUrl, {})
  check('dispatch stays paused after the refusal', state.json().dispatch.state === 'paused', state.text)
  check('and the task stays pending', state.json().tasks[0].status === 'pending' && state.json().tasks[0].id === created.json().task.id, state.text)
  const agentRequest = await noGit.api.perform('start', { note: 'try it' }, { projectPath: PROJECT, by: '@agent', role: 'agent', agent: { id: 'session-agent' } })
  check('an agent start is refused for the same reason', agentRequest.ok === false && agentRequest.code === 'worktree-unavailable', JSON.stringify(agentRequest))
  const agentState = await call(noGitSurface, projectUrl, {})
  check('and no start request is recorded', agentState.json().dispatch.request === null, agentState.text)
  const approved = await postTo(noGitSurface, { action: 'approveStart' })
  check('approveStart refuses the same environment', approved.json().ok === false && approved.json().code === 'worktree-unavailable', approved.text)
  check('and dispatch never enters running', approved.json().dispatch === undefined && (await call(noGitSurface, projectUrl, {})).json().dispatch.state === 'paused', approved.text)
  noGitSurface.dispose()
  noGit.scheduler.dispose()
}

{
  const notRepo = createRig({ gitOptions: { repo: false } })
  const notRepoSurface = install(notRepo)
  const projectUrl = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  await call(notRepoSurface, projectUrl, {})
  await postTo(notRepoSurface, { action: 'create', title: 'not a repo' })
  const refused = await postTo(notRepoSurface, { action: 'start' })
  check('start refuses a project that is not a git repository', refused.json().ok === false && refused.json().code === 'worktree-unavailable', refused.text)
  check('and says so', refused.json().worktree === 'not-a-git-repository', refused.text)
  notRepoSurface.dispose()
  notRepo.scheduler.dispose()
}

{
  const dirty = createRig({ gitOptions: { clean: false } })
  const dirtySurface = install(dirty)
  const projectUrl = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  await call(dirtySurface, projectUrl, {})
  await postTo(dirtySurface, { action: 'create', title: 'dirty tree' })
  const refused = await postTo(dirtySurface, { action: 'start' })
  check('start refuses a dirty working tree', refused.json().ok === false && refused.json().code === 'worktree-unavailable', refused.text)
  check('and says the tree is dirty', refused.json().worktree === 'dirty-worktree', refused.text)
  const state = await call(dirtySurface, projectUrl, {})
  check('a dirty tree keeps the board pending and paused', state.json().dispatch.state === 'paused' && state.json().tasks[0].status === 'pending', state.text)
  dirtySurface.dispose()
  dirty.scheduler.dispose()
}

{
  const broken = createRig({ gitOptions: { addFails: true } })
  const brokenSurface = install(broken)
  const projectUrl = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  await call(brokenSurface, projectUrl, {})
  await postTo(brokenSurface, { action: 'create', title: 'refused add', writeFiles: ['scripts/a.gd'] })
  const started = await postTo(brokenSurface, { action: 'start' })
  const payload = started.json()
  check('start accepts a clean repository', payload.ok === true, started.text)
  check('a claim-time worktree refusal pauses dispatch', payload.snapshot !== undefined && payload.snapshot.dispatch.state === 'paused', started.text)
  check('the task stays pending', payload.snapshot.tasks[0].status === 'pending', started.text)
  check('and records the worktree failure', String(payload.snapshot.tasks[0].worktreeError).indexOf('worktree-add-failed') === 0, String(payload.snapshot.tasks[0].worktreeError))
  check('the scheduler explains the pause', String(payload.snapshot.scheduler && payload.snapshot.scheduler.lastError).indexOf('worktree refused') >= 0, JSON.stringify(payload.snapshot && payload.snapshot.scheduler))
  check('the attempt released its file locks', payload.snapshot.locks.length === 0, JSON.stringify(payload.snapshot.locks))
  brokenSurface.dispose()
  broken.scheduler.dispose()
}

// ── the merge queue: integration worktree, verification, fast-forward ────────
/**
 * A fake git for the merge pipeline; unmatched commands succeed silently.
 *
 * The integration checkout is recognised by its EXACT path. Matching a substring
 * of the current directory looked equivalent, but the merger runs this suite
 * inside its own merge-<taskId> worktree, so the harness path itself contains
 * "merge-T-1" for task ids T-1, T-10, T-11, T-12... and the fake then reported
 * the integration HEAD for the main checkout too.
 */
function mergeGit(replies) {
  const integration = join(PROJECT, '.worktrees', 'merge-T-1')
  const taskWorktree = join(PROJECT, '.worktrees', 'T-1')
  const calls = []
  const run = (args, cwd) => {
    calls.push({ args: args.slice(), cwd: cwd })
    const key = args.join(' ')
    if (replies !== undefined && replies[key] !== undefined) return replies[key](args, cwd)
    if (key === 'branch --show-current') return { code: 0, stdout: 'main\n', stderr: '' }
    if (key === 'status --porcelain') return { code: 0, stdout: '', stderr: '' }
    if (key === 'rev-parse HEAD') {
      // Each checkout has its own HEAD: the task worktree carries the submitted
      // commit, the integration checkout its merge commit, the main tree the
      // target's head.
      const hash = cwd === integration ? 'merge-sha' : cwd === taskWorktree ? 'head-sha' : 'target-sha'
      return { code: 0, stdout: hash + '\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { git: createGit({ run: run }), calls: calls }
}

function fakeVerifier(result) {
  const calls = []
  return {
    calls: calls,
    verify: async function verify(request) {
      calls.push(request)
      return result
    },
  }
}

function openMergeTask(overrides) {
  const stamp = new Date().toISOString()
  return Object.assign(
    {
      id: 'T-1',
      title: 'MR task',
      status: 'testing',
      review: { status: 'approved', by: 'reviewer', at: stamp, reasons: null, attempt: 1 },
      test: { status: 'passed', by: 'tester', at: stamp, evidence: 'npm run verify', attempt: 1 },
      priority: 0,
      dependsOn: [],
      writeFiles: ['scripts/a.gd'],
      base: 'base-sha',
      target: 'main',
      branch: 'task/T-1-1',
      worktree: join(PROJECT, '.worktrees', 'T-1'),
      worktreeError: null,
      commit: 'head-sha',
      actualFiles: ['scripts/a.gd'],
      requiredRole: null,
      merge: {
        status: 'open',
        base: 'base-sha',
        target: 'main',
        head: 'head-sha',
        mergeCommit: null,
        declaredFiles: ['scripts/a.gd'],
        actualFiles: ['scripts/a.gd'],
        tests: 'npm run verify',
        reviewer: null,
        conflict: null,
        output: null,
        at: stamp,
      },
      assignee: null,
      attempts: 1,
      maxAttempts: 3,
      evidence: '',
      dispatch: null,
      leaseUntil: null,
      createdBy: '@me',
      createdAt: stamp,
      updatedAt: stamp,
      history: [],
    },
    overrides === undefined ? {} : overrides,
  )
}

function seedMergeTask(rig, task) {
  seedBoard(
    rig.fs,
    PROJECT,
    JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused', worktree: { root: '.worktrees' } }, tasks: [task] }),
  )
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: 'ALL CHECKS PASSED', stderr: '' })
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(mergeRig, openMergeTask())
  const mergeSurface = install(mergeRig)
  const integration = join(PROJECT, '.worktrees', 'merge-T-1')
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  const payload = res.json()
  check('mergeRequest merges an open request', payload.ok === true && payload.task.merge.status === 'merged', res.text)
  check(
    'the merged record names the merge commit, reviewer and time',
    payload.task.merge.mergeCommit === 'merge-sha' && payload.task.merge.reviewer === '@user' && typeof payload.task.merge.at === 'string',
    JSON.stringify(payload.task.merge),
  )
  check('the merged record keeps the verification output', String(payload.task.merge.output).indexOf('ALL CHECKS PASSED') >= 0, JSON.stringify(payload.task.merge.output))
  check(
    'verification runs inside the integration worktree with the default command',
    verifier.calls.length === 1 && verifier.calls[0].cwd === integration && verifier.calls[0].command === 'npm run verify',
    JSON.stringify(verifier.calls),
  )
  const byCommand = (label) => fake.calls.filter((entry) => entry.args.join(' ') === label)
  const addCall = fake.calls.filter((entry) => entry.args[0] === 'worktree' && entry.args[1] === 'add')[0]
  check(
    'the integration worktree is created from the target HEAD on merge/<id>',
    addCall !== undefined && addCall.cwd === PROJECT && addCall.args.join(' ') === 'worktree add -b merge/T-1 ' + integration + ' target-sha',
    JSON.stringify(addCall && addCall.args),
  )
  const candidate = fake.calls.filter((entry) => entry.args[0] === 'merge' && entry.args[1] === '--no-ff')[0]
  check(
    'the candidate branch is merged inside the integration worktree',
    candidate !== undefined && candidate.cwd === integration && candidate.args.join(' ') === 'merge --no-ff --no-edit task/T-1-1',
    JSON.stringify(candidate && candidate.args),
  )
  const forward = byCommand('merge --ff-only merge/T-1')[0]
  check('main is fast-forwarded to the integration branch', forward !== undefined && forward.cwd === PROJECT, JSON.stringify(forward))
  check(
    'the temporary integration checkout and branch are cleaned up',
    byCommand('worktree remove --force ' + integration).length === 1 && byCommand('branch -d merge/T-1').length === 1,
    JSON.stringify(fake.calls.map((entry) => entry.args)),
  )
  check(
    'the task worktree is deleted after a successful merge',
    byCommand('worktree remove --force ' + join(PROJECT, '.worktrees', 'T-1')).length === 1,
    JSON.stringify(fake.calls.map((entry) => entry.args)),
  )
  check(
    'no git command pushes or rewrites the main checkout',
    fake.calls.every((entry) => entry.args[0] !== 'push' && !(entry.args[0] === 'reset' && entry.cwd === PROJECT)),
    JSON.stringify(fake.calls.map((entry) => entry.args)),
  )
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

{
  const integration = join(PROJECT, '.worktrees', 'merge-T-1')
  const fake = mergeGit({
    'merge --no-ff --no-edit task/T-1-1': () => ({
      code: 1,
      stdout: 'CONFLICT (content): Merge conflict in scripts/a.gd\nAutomatic merge failed; fix conflicts and then commit the result.',
      stderr: '',
    }),
    'diff --name-only --diff-filter=U': () => ({ code: 0, stdout: 'scripts/a.gd\n', stderr: '' }),
  })
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(mergeRig, openMergeTask())
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  const payload = res.json()
  check('a conflicted merge is recorded as conflict', payload.ok === true && payload.task.merge.status === 'conflict', res.text)
  check('the conflict names the unmerged files', String(payload.task.merge.conflict).indexOf('scripts/a.gd') >= 0, JSON.stringify(payload.task.merge.conflict))
  const abort = fake.calls.filter((entry) => entry.args[0] === 'merge' && entry.args[1] === '--abort')[0]
  check('the integration merge is aborted', abort !== undefined && abort.cwd === integration, JSON.stringify(abort))
  check('main is never fast-forwarded on a conflict', fake.calls.every((entry) => entry.args.join(' ') !== 'merge --ff-only merge/T-1'), JSON.stringify(fake.calls.map((entry) => entry.args)))
  check(
    'the temporary checkout and branch are cleaned up after a conflict',
    fake.calls.some((entry) => entry.args.join(' ') === 'worktree remove --force ' + integration) &&
      fake.calls.some((entry) => entry.args.join(' ') === 'branch -D merge/T-1'),
    JSON.stringify(fake.calls.map((entry) => entry.args)),
  )
  check(
    'the task worktree is kept for the owner',
    fake.calls.every((entry) => entry.args.join(' ') !== 'worktree remove --force ' + join(PROJECT, '.worktrees', 'T-1')),
    JSON.stringify(fake.calls.map((entry) => entry.args)),
  )
  check('verification does not run on a conflicted merge', verifier.calls.length === 0, JSON.stringify(verifier.calls))
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

{
  const integration = join(PROJECT, '.worktrees', 'merge-T-1')
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 1, stdout: 'FAIL board.test.mjs', stderr: 'stderr detail' })
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(mergeRig, openMergeTask())
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  const payload = res.json()
  check('a red verification marks the merge failed', payload.ok === true && payload.task.merge.status === 'failed', res.text)
  check('the failure keeps the verification output', String(payload.task.merge.output).indexOf('FAIL board.test.mjs') >= 0, JSON.stringify(payload.task.merge.output))
  check('the failed merge records no merge commit', payload.task.merge.mergeCommit === null, JSON.stringify(payload.task.merge))
  const reset = fake.calls.filter((entry) => entry.args[0] === 'reset')[0]
  check('the integration checkout is reset', reset !== undefined && reset.cwd === integration && reset.args.join(' ') === 'reset --hard HEAD', JSON.stringify(reset))
  check('main is never fast-forwarded on a red verification', fake.calls.every((entry) => entry.args.join(' ') !== 'merge --ff-only merge/T-1'), JSON.stringify(fake.calls.map((entry) => entry.args)))
  check(
    'the task worktree is kept for repair',
    fake.calls.every((entry) => entry.args.join(' ') !== 'worktree remove --force ' + join(PROJECT, '.worktrees', 'T-1')),
    JSON.stringify(fake.calls.map((entry) => entry.args)),
  )
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(mergeRig, openMergeTask())
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'rejectMerge', project: PROJECT, id: 'T-1' })
  const payload = res.json()
  check('rejectMerge closes an open request', payload.ok === true && payload.task.merge.status === 'rejected', res.text)
  check('rejection records the reviewer and time', payload.task.merge.reviewer === '@user' && typeof payload.task.merge.at === 'string', JSON.stringify(payload.task.merge))
  check(
    'rejection touches no git checkout',
    fake.calls.every((entry) => entry.args.join(' ') === 'worktree list --porcelain'),
    JSON.stringify(fake.calls.map((entry) => entry.args)),
  )
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  const closed = openMergeTask()
  closed.merge = Object.assign({}, closed.merge, { status: 'merged' })
  seedMergeTask(mergeRig, closed)
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('only an open merge request can be merged', res.json().ok === false && res.json().code === 'no-open-merge', res.text)
  check('and git is not consulted for a closed request', fake.calls.length === 0, JSON.stringify(fake.calls))
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(mergeRig, openMergeTask({ status: 'running' }))
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a running task cannot be merged', res.json().ok === false && res.json().code === 'not-mergeable-phase', res.text)
  check('and its worktree is left alone', fake.calls.length === 0, JSON.stringify(fake.calls))
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

{
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const mergeRig = createSubmitRig({ git: null, merger: createMerger({ git: null, verify: verifier.verify }) })
  seedMergeTask(mergeRig, openMergeTask())
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('without git the merge refuses readably', res.json().ok === false && res.json().code === 'no-git-service', res.text)
  const after = await call(mergeSurface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  check('the request stays open when git is unavailable', after.json().tasks[0].merge.status === 'open', after.text)
  check('and no verification starts', verifier.calls.length === 0, JSON.stringify(verifier.calls))
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(mergeRig, openMergeTask())
  const mergeSurface = install(mergeRig)
  const [first, second] = await Promise.all([
    postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' }),
    postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' }),
  ])
  const results = [first.json(), second.json()]
  const successful = results.filter((entry) => entry.ok === true)
  const refused = results.filter((entry) => entry.ok === false)[0]
  check(
    'the merge queue handles one request at a time',
    successful.length === 1 && refused !== undefined && refused.code === 'no-open-merge',
    JSON.stringify(results),
  )
  check('and verification runs exactly once', verifier.calls.length === 1, String(verifier.calls.length))
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

// ── the dedicated merger role ──────────────────────────────────────────────
// A Team with the fixed merger teammate plus an ordinary worker and its owner.
function mergerTeam(options) {
  const opts = options === undefined ? {} : options
  return createTeam({
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-merger', name: 'merger', role: 'teammate', status: 'inactive' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
    ],
    sendThrows: opts.sendThrows === true,
  })
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const team = mergerTeam()
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }), team: team })
  seedMergeTask(mergeRig, openMergeTask({ assignee: { name: 'fixer', session: 'session-fixer' } }))
  const asAgent = (id) => ({ projectPath: PROJECT, by: '@' + id, role: 'agent', agent: { id: id } })
  const other = await mergeRig.api.perform('mergeRequest', { id: 'T-1' }, asAgent('session-fixer'))
  check('another agent cannot merge', other.ok === false && other.code === 'merger-only', JSON.stringify(other))
  check('and git is not consulted for a refused caller', fake.calls.length === 0, JSON.stringify(fake.calls))
  const otherReject = await mergeRig.api.perform('rejectMerge', { id: 'T-1' }, asAgent('session-fixer'))
  check('another agent cannot reject either', otherReject.ok === false && otherReject.code === 'merger-only', JSON.stringify(otherReject))
  const asUser = await mergeRig.api.perform('mergeRequest', { id: 'T-1' }, { projectPath: PROJECT, by: '@user', role: 'user', agent: null })
  check('the user can still merge', asUser.ok === true && asUser.task.merge.status === 'merged', JSON.stringify(asUser))
  mergeRig.scheduler.dispose()
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const team = mergerTeam()
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }), team: team })
  seedMergeTask(mergeRig, openMergeTask())
  const asMerger = await mergeRig.api.perform('mergeRequest', { id: 'T-1' }, { projectPath: PROJECT, by: '@merger', role: 'agent', agent: { id: 'session-merger' } })
  check('the merger can merge', asMerger.ok === true && asMerger.task.merge.status === 'merged', JSON.stringify(asMerger))
  mergeRig.scheduler.dispose()
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const team = mergerTeam()
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }), team: team })
  seedMergeTask(mergeRig, openMergeTask())
  const asMerger = await mergeRig.api.perform('rejectMerge', { id: 'T-1' }, { projectPath: PROJECT, by: '@merger', role: 'agent', agent: { id: 'session-merger' } })
  check('the merger can reject', asMerger.ok === true && asMerger.task.merge.status === 'rejected', JSON.stringify(asMerger))
  mergeRig.scheduler.dispose()
}

// submit opens an MR and tells the merger about it
{
  const fake = fakeGit()
  const team = mergerTeam()
  const submitRig = createSubmitRig({ git: fake.git, team: team })
  seedRunningTask(submitRig, runningWorktreeTask())
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'npm run verify' })
  const payload = res.json()
  check('submit still succeeds with a merger in the team', payload.ok === true && payload.task.status === 'reviewing' && payload.task.merge.status === 'open', res.text)
  const sent = team.calls.filter((call) => call.kind === 'send')
  check('the merger is notified about the open request', sent.length === 1 && sent[0].target === 'merger', JSON.stringify(sent))
  const text = sent.length === 0 ? '' : sent[0].text
  check(
    'the notice names the task, branch, target and main project',
    text.indexOf('T-1') >= 0 && text.indexOf('task/T-1-1') >= 0 && text.indexOf('main') >= 0 && text.indexOf(PROJECT) >= 0,
    text,
  )
  check('and tells the merger to use task_center and not to push', text.indexOf('mergeRequest') >= 0 && text.indexOf('Do not push') >= 0, text)
  check('and leaves conflicts to the task owner', text.indexOf('owner') >= 0, text)
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const team = createTeam()
  const submitRig = createSubmitRig({ git: fake.git, team: team })
  seedRunningTask(submitRig, runningWorktreeTask())
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'done' })
  check('submit works when the team has no merger', res.json().ok === true && res.json().task.merge.status === 'open', res.text)
  check('and nobody is messaged', team.calls.length === 0, JSON.stringify(team.calls))
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const team = mergerTeam({ sendThrows: true })
  const submitRig = createSubmitRig({ git: fake.git, team: team })
  seedRunningTask(submitRig, runningWorktreeTask())
  const submitSurface = install(submitRig)
  const res = await postTo(submitSurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'done' })
  check(
    'a refused merger notification does not fail the submit',
    res.json().ok === true && res.json().task.status === 'reviewing' && res.json().task.merge.status === 'open',
    res.text,
  )
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}

// a conflict or a red verification is reported back to the task owner
{
  const fake = mergeGit({
    'merge --no-ff --no-edit task/T-1-1': () => ({ code: 1, stdout: 'CONFLICT (content): Merge conflict in scripts/a.gd', stderr: '' }),
    'diff --name-only --diff-filter=U': () => ({ code: 0, stdout: 'scripts/a.gd\n', stderr: '' }),
  })
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const team = mergerTeam()
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }), team: team })
  seedMergeTask(mergeRig, openMergeTask({ assignee: { name: 'fixer', session: 'session-fixer' } }))
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a conflicted merge is still recorded', res.json().ok === true && res.json().task.merge.status === 'conflict', res.text)
  const sent = team.calls.filter((call) => call.kind === 'send')
  check('the owner is told about the conflict', sent.length === 1 && sent[0].target === 'fixer', JSON.stringify(sent))
  const text = sent.length === 0 ? '' : sent[0].text
  check('and the notice names the conflicted files', text.indexOf('scripts/a.gd') >= 0 && text.indexOf('conflict') >= 0, text)
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 1, stdout: 'FAIL board.test.mjs', stderr: '' })
  const team = mergerTeam()
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }), team: team })
  seedMergeTask(mergeRig, openMergeTask({ assignee: { name: 'fixer', session: 'session-fixer' } }))
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a red verification is recorded as failed', res.json().ok === true && res.json().task.merge.status === 'failed', res.text)
  const sent = team.calls.filter((call) => call.kind === 'send')
  check('the owner is told about the failure', sent.length === 1 && sent[0].target === 'fixer', JSON.stringify(sent))
  check('and the notice carries the verification output', sent.length > 0 && sent[0].text.indexOf('FAIL board.test.mjs') >= 0, sent.length === 0 ? '' : sent[0].text)
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

{
  const fake = mergeGit({
    'merge --no-ff --no-edit task/T-1-1': () => ({ code: 1, stdout: 'CONFLICT (content): Merge conflict in scripts/a.gd', stderr: '' }),
    'diff --name-only --diff-filter=U': () => ({ code: 0, stdout: 'scripts/a.gd\n', stderr: '' }),
  })
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const team = mergerTeam()
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }), team: team })
  seedMergeTask(mergeRig, openMergeTask())
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a request without an owner still conflicts', res.json().ok === true && res.json().task.merge.status === 'conflict', res.text)
  check('and no owner notification is attempted', team.calls.length === 0, JSON.stringify(team.calls))
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}

// ── a long failed verification keeps its tail, not the opening PASS wall ────
{
  const fake = mergeGit()
  const headLines = []
  for (let index = 0; index < 200; index++) headLines.push('PASS  head check ' + String(index) + ' ' + 'x'.repeat(40))
  // 'A' shifts the byte grid so the stdout tail boundary lands INSIDE a 4-byte
  // emoji instead of exactly on a character boundary.
  const stdout = headLines.join('\n') + '\nA' + '😀'.repeat(3000) + '\nFAIL  scripts/test/deep-tail.test.mjs\n'
  const stderr = 'stderr head ' + 'y'.repeat(9000) + '\nError: deep stderr tail marker\n'
  const verifier = fakeVerifier({ code: 1, stdout: stdout, stderr: stderr })
  const mergeRig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(mergeRig, openMergeTask())
  const mergeSurface = install(mergeRig)
  const res = await postTo(mergeSurface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  const payload = res.json()
  const output = String(payload.task.merge.output)
  check('a long red verification is still judged failed', payload.ok === true && payload.task.merge.status === 'failed', res.text)
  check(
    'the output keeps the verify command and exit code header',
    output.indexOf('$ npm run verify') === 0 && output.indexOf('(exit 1)') >= 0,
    output.slice(0, 160),
  )
  check('the output keeps the tail FAIL line', output.indexOf('FAIL  scripts/test/deep-tail.test.mjs') >= 0, output.slice(-400))
  check('the output keeps the stderr tail', output.indexOf('Error: deep stderr tail marker') >= 0, output.slice(-400))
  check('the output does not dump the opening PASS wall', output.indexOf('PASS  head check 0 ') < 0, output.slice(0, 400))
  check('the output stays capped near 8 KiB', Buffer.byteLength(output, 'utf8') <= 8 * 1024, String(Buffer.byteLength(output, 'utf8')))
  check('the truncated output never splits a UTF-8 character', output.indexOf('\uFFFD') < 0, output.slice(-400))
  check('the long red verification still never fast-forwards main', fake.calls.every((entry) => entry.args.join(' ') !== 'merge --ff-only merge/T-1'))
  mergeSurface.dispose()
  mergeRig.scheduler.dispose()
}


// ── MR head drift: explicit refreshMerge and a pre-merge check ─────────────
/** A merge rig whose task-worktree HEAD can be made to drift from the MR. */
function driftRig(options) {
  const opts = options === undefined ? {} : options
  const worktreeHead = opts.head === undefined ? 'new-head-sha' : opts.head
  const worktree = join(PROJECT, '.worktrees', 'T-1')
  const integration = join(PROJECT, '.worktrees', 'merge-T-1')
  const fake = mergeGit({
    'rev-parse HEAD': (args, cwd) => ({
      code: 0,
      stdout: (cwd === integration ? 'merge-sha' : cwd === worktree ? worktreeHead : 'target-sha') + '\n',
      stderr: '',
    }),
    // A refresh re-bases on the target's current head, then diffs from it.
    'rev-parse --verify main': () => ({ code: 0, stdout: 'target-sha\n', stderr: '' }),
    ['diff --name-only target-sha ' + worktreeHead]: () => ({ code: 0, stdout: 'scripts/a.gd\nscripts/b.gd\n', stderr: '' }),
    ['diff --name-only base-sha ' + worktreeHead]: () => ({ code: 0, stdout: 'scripts/a.gd\nscripts/b.gd\n', stderr: '' }),
  })
  const verifier = fakeVerifier({ code: 0, stdout: 'ALL CHECKS PASSED', stderr: '' })
  const rig = createSubmitRig({
    git: fake.git,
    merger: opts.merger === undefined ? createMerger({ git: fake.git, verify: verifier.verify }) : opts.merger,
    team: opts.team,
  })
  seedMergeTask(rig, opts.task === undefined ? openMergeTask({ assignee: { name: 'fixer', session: 'session-fixer' } }) : opts.task)
  const surface = install(rig)
  return { rig: rig, surface: surface, fake: fake, verifier: verifier, worktree: worktree, integration: integration }
}

// the brief makes submit the last step and points at refreshMerge
{
  const rig = createRig({ allowSpawn: false })
  await rig.action('create', { title: 'brief check' })
  await rig.action('start')
  await rig.settle()
  const sent = rig.team.calls.filter((call) => call.kind === 'send')[0]
  const text = sent === undefined ? '' : sent.text
  check('the brief says submit is the last step of the round', /submit is the last step/i.test(text), text.slice(0, 400))
  check('and names the review and test phases after it', /REVIEW/i.test(text) && /TESTING/i.test(text), text.slice(0, 400))
  check('and warns against committing after a passing test', /Do not commit after a passing test/i.test(text), text.slice(0, 400))
  check('and points at refreshMerge for a late commit', text.indexOf('refreshMerge') >= 0, text.slice(0, 400))
  rig.scheduler.dispose()
}

// a branch that moved past the recorded head refuses the merge and touches nothing
{
  const ctx = driftRig({ head: 'new-head-sha' })
  const res = await postTo(ctx.surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  const payload = res.json()
  check('a moved branch is refused as head-drift', payload.ok === false && payload.code === 'head-drift', res.text)
  check(
    'the refusal names both heads and the refresh action',
    String(payload.message).indexOf('new-head-sha') >= 0 &&
      String(payload.message).indexOf('head-sha') >= 0 &&
      String(payload.message).indexOf('refreshMerge') >= 0,
    res.text,
  )
  check('no integration worktree is created on drift', ctx.fake.calls.every((entry) => !(entry.args[0] === 'worktree' && entry.args[1] === 'add')), JSON.stringify(ctx.fake.calls.map((entry) => entry.args)))
  check('main is never fast-forwarded on drift', ctx.fake.calls.every((entry) => entry.args.join(' ') !== 'merge --ff-only merge/T-1'), JSON.stringify(ctx.fake.calls.map((entry) => entry.args)))
  check('no verification starts on drift', ctx.verifier.calls.length === 0, String(ctx.verifier.calls.length))
  const after = await call(ctx.surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  check(
    'the request stays open at its recorded head',
    after.json().tasks[0].merge.status === 'open' && after.json().tasks[0].merge.head === 'head-sha',
    JSON.stringify(after.json().tasks[0].merge),
  )
  ctx.surface.dispose()
  ctx.rig.scheduler.dispose()
}

// refreshMerge re-points the request at the branch head and re-opens it
{
  const seedTask = openMergeTask({ assignee: { name: 'fixer', session: 'session-fixer' } })
  seedTask.commit = 'old-commit'
  seedTask.actualFiles = ['scripts/a.gd']
  seedTask.merge = Object.assign({}, seedTask.merge, {
    status: 'failed',
    reviewer: '@user',
    output: 'old failure output',
    conflict: null,
    mergeCommit: null,
  })
  const ctx = driftRig({ head: 'new-head-sha', task: seedTask })
  const res = await postTo(ctx.surface, { action: 'refreshMerge', project: PROJECT, id: 'T-1' })
  const payload = res.json()
  check('refreshMerge succeeds for the user', payload.ok === true, res.text)
  check('it re-points the request at the branch head', payload.task !== undefined && payload.task.merge.head === 'new-head-sha' && payload.task.commit === 'new-head-sha', JSON.stringify(payload.task && { head: payload.task.merge.head, commit: payload.task.commit }))
  check(
    'and re-bases it on the target head',
    payload.task !== undefined && payload.task.merge.base === 'target-sha',
    JSON.stringify(payload.task && { base: payload.task.merge.base }),
  )
  check(
    'it refreshes the changed files on both records',
    payload.task !== undefined &&
      payload.task.actualFiles.join(',') === 'scripts/a.gd,scripts/b.gd' &&
      payload.task.merge.actualFiles.join(',') === 'scripts/a.gd,scripts/b.gd',
    JSON.stringify(payload.task && { actualFiles: payload.task.actualFiles, mergeFiles: payload.task.merge.actualFiles }),
  )
  check(
    'it re-opens the request and clears the old outcome',
    payload.task !== undefined &&
      payload.task.merge.status === 'open' &&
      payload.task.merge.mergeCommit === null &&
      payload.task.merge.conflict === null &&
      payload.task.merge.output === null &&
      payload.task.merge.reviewer === null,
    JSON.stringify(payload.task && payload.task.merge),
  )
  check(
    'it writes a history entry',
    payload.task !== undefined && payload.task.history.some((entry) => String(entry.note).indexOf('merge request refreshed') >= 0),
    JSON.stringify(payload.task && payload.task.history.slice(-2)),
  )
  check(
    'refresh only reads: no commit, merge or push',
    ctx.fake.calls.every((entry) => entry.args[0] === 'rev-parse' || entry.args[0] === 'diff' || entry.args.join(' ') === 'worktree list --porcelain'),
    JSON.stringify(ctx.fake.calls.map((entry) => entry.args)),
  )
  check(
    'the refresh starts a new review round',
    payload.task.status === 'reviewing' && payload.task.review.attempt === 2 && payload.task.test === null,
    JSON.stringify({ status: payload.task.status, review: payload.task.review }),
  )
  // The refreshed head is now mergeable once the phases pass again.
  const refusedAgain = await postTo(ctx.surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a refreshed head cannot merge before review', refusedAgain.json().ok === false && refusedAgain.json().code === 'review-required', refusedAgain.text)
  await postTo(ctx.surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  await postTo(ctx.surface, { action: 'passTest', project: PROJECT, id: 'T-1' })
  const merged = await postTo(ctx.surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('after a refresh and a fresh pass the merge succeeds', merged.json().ok === true && merged.json().task.merge.status === 'merged', merged.text)
  ctx.surface.dispose()
  ctx.rig.scheduler.dispose()
}

// refreshMerge is for the owner, the user and the merger
{
  const ownerCall = await (async () => {
    const ctx = driftRig({ team: mergerTeam() })
    const result = await ctx.rig.api.perform('refreshMerge', { id: 'T-1' }, { projectPath: PROJECT, by: '@fixer', role: 'agent', agent: { id: 'session-fixer' } })
    ctx.surface.dispose()
    ctx.rig.scheduler.dispose()
    return result
  })()
  check('the task owner can refresh its request', ownerCall.ok === true && ownerCall.task.merge.head === 'new-head-sha', JSON.stringify(ownerCall.ok && ownerCall.task && ownerCall.task.merge.head))
  const mergerCall = await (async () => {
    const ctx = driftRig({ team: mergerTeam() })
    const result = await ctx.rig.api.perform('refreshMerge', { id: 'T-1' }, { projectPath: PROJECT, by: '@merger', role: 'agent', agent: { id: 'session-merger' } })
    ctx.surface.dispose()
    ctx.rig.scheduler.dispose()
    return result
  })()
  check('the merger can refresh a request', mergerCall.ok === true, JSON.stringify(mergerCall))
  const strangerCtx = driftRig({ team: mergerTeam() })
  const stranger = await strangerCtx.rig.api.perform('refreshMerge', { id: 'T-1' }, { projectPath: PROJECT, by: '@other', role: 'agent', agent: { id: 'session-other' } })
  check('another agent cannot refresh', stranger.ok === false && stranger.code === 'not-assignee', JSON.stringify(stranger))
  strangerCtx.surface.dispose()
  strangerCtx.rig.scheduler.dispose()
}

// refreshMerge refuses readably when there is nothing to refresh
{
  const noMerge = driftRig({ task: openMergeTask({ merge: null }) })
  const refused = await postTo(noMerge.surface, { action: 'refreshMerge', project: PROJECT, id: 'T-1' })
  check('a task without a merge request cannot be refreshed', refused.json().ok === false && refused.json().code === 'no-merge-request', refused.text)
  noMerge.surface.dispose()
  noMerge.rig.scheduler.dispose()

  const running = driftRig({ task: openMergeTask({ status: 'running' }) })
  const notDone = await postTo(running.surface, { action: 'refreshMerge', project: PROJECT, id: 'T-1' })
  check('a running task has no submitted request to refresh', notDone.json().ok === false && notDone.json().code === 'not-mergeable-phase', notDone.text)
  running.surface.dispose()
  running.rig.scheduler.dispose()

  const noGit = driftRig({ merger: null, task: openMergeTask() })
  const noGitRig = createSubmitRig({ git: null, merger: null })
  seedMergeTask(noGitRig, openMergeTask())
  const noGitSurface = install(noGitRig)
  const noService = await postTo(noGitSurface, { action: 'refreshMerge', project: PROJECT, id: 'T-1' })
  check('without git the refresh refuses readably', noService.json().ok === false && noService.json().code === 'no-git-service', noService.text)
  noGitSurface.dispose()
  noGitRig.scheduler.dispose()
  noGit.surface.dispose()
  noGit.rig.scheduler.dispose()

  const noBranch = driftRig({ task: openMergeTask({ branch: null }) })
  const missing = await postTo(noBranch.surface, { action: 'refreshMerge', project: PROJECT, id: 'T-1' })
  check('a task without a branch refuses readably', missing.json().ok === false && missing.json().code === 'missing-branch', missing.text)
  noBranch.surface.dispose()
  noBranch.rig.scheduler.dispose()
}

// without a task worktree the branch head is resolved in the main checkout
{
  const seedTask = openMergeTask({ worktree: null, branch: 'task/T-1-1' })
  seedTask.merge = Object.assign({}, seedTask.merge, { head: 'branch-sha' })
  const fake = mergeGit({
    'rev-parse --verify task/T-1-1': () => ({ code: 0, stdout: 'branch-sha\n', stderr: '' }),
  })
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(rig, seedTask)
  const surface = install(rig)
  const res = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a missing worktree falls back to the branch head', res.json().ok === true && res.json().task.merge.status === 'merged', res.text)
  check(
    'the fallback resolves the branch in the main checkout',
    fake.calls.some((entry) => entry.cwd === PROJECT && entry.args.join(' ') === 'rev-parse --verify task/T-1-1'),
    JSON.stringify(fake.calls.filter((entry) => entry.args[0] === 'rev-parse').map((entry) => ({ cwd: entry.cwd, args: entry.args }))),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

// ── refreshMerge re-bases the request on the target's current head ─────────
{
  // The branch merged the target in while resolving a conflict: diffing from
  // the OLD base would count upstream files as this task's work.
  const seedTask = openMergeTask({ assignee: { name: 'fixer', session: 'session-fixer' } })
  seedTask.commit = 'old-head-sha'
  seedTask.actualFiles = ['scripts/a.gd', 'dependency/file.gd']
  seedTask.merge = Object.assign({}, seedTask.merge, {
    status: 'open',
    base: 'old-base-sha',
    head: 'old-head-sha',
    actualFiles: ['scripts/a.gd', 'dependency/file.gd'],
  })
  const worktree = join(PROJECT, '.worktrees', 'T-1')
  const integration = join(PROJECT, '.worktrees', 'merge-T-1')
  const fake = mergeGit({
    'rev-parse HEAD': (args, cwd) => ({
      code: 0,
      stdout: (cwd === integration ? 'merge-sha' : cwd === worktree ? 'branch-new-sha' : 'target-sha') + '\n',
      stderr: '',
    }),
    'rev-parse --verify main': () => ({ code: 0, stdout: 'target-new-sha\n', stderr: '' }),
    'diff --name-only target-new-sha branch-new-sha': () => ({ code: 0, stdout: 'scripts/a.gd\n', stderr: '' }),
    'diff --name-only old-base-sha branch-new-sha': () => ({ code: 0, stdout: 'scripts/a.gd\ndependency/file.gd\n', stderr: '' }),
  })
  const verifier = fakeVerifier({ code: 0, stdout: 'ALL CHECKS PASSED', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(rig, seedTask)
  const surface = install(rig)
  const res = await postTo(surface, { action: 'refreshMerge', project: PROJECT, id: 'T-1' })
  const payload = res.json()
  check('a refresh after a target merge succeeds', payload.ok === true, res.text)
  check(
    'the base moves to the target head',
    payload.task !== undefined && payload.task.merge.base === 'target-new-sha',
    JSON.stringify(payload.task && { base: payload.task.merge.base }),
  )
  check(
    'the head and commit move to the branch head',
    payload.task !== undefined && payload.task.merge.head === 'branch-new-sha' && payload.task.commit === 'branch-new-sha',
    JSON.stringify(payload.task && { head: payload.task.merge.head, commit: payload.task.commit }),
  )
  check(
    'actualFiles only contain this task effects, not upstream files',
    payload.task !== undefined &&
      payload.task.actualFiles.join(',') === 'scripts/a.gd' &&
      payload.task.merge.actualFiles.join(',') === 'scripts/a.gd',
    JSON.stringify(payload.task && { task: payload.task.actualFiles, merge: payload.task.merge.actualFiles }),
  )
  check(
    'the refresh never diffs from the stale base',
    fake.calls.every((entry) => !(entry.args[0] === 'diff' && entry.args[2] === 'old-base-sha')),
    JSON.stringify(fake.calls.filter((entry) => entry.args[0] === 'diff').map((entry) => entry.args)),
  )
  check(
    'the history records both base and head moves',
    payload.task !== undefined &&
      payload.task.history.some(
        (entry) =>
          String(entry.note).indexOf('base old-base-sha -> target-new-sha') >= 0 &&
          String(entry.note).indexOf('head old-head-sha -> branch-new-sha') >= 0,
      ),
    JSON.stringify(payload.task && payload.task.history.slice(-2)),
  )
  await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  await postTo(surface, { action: 'passTest', project: PROJECT, id: 'T-1' })
  const merged = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('the refreshed request merges after a fresh pass', merged.json().ok === true && merged.json().task.merge.status === 'merged', merged.text)
  surface.dispose()
  rig.scheduler.dispose()
}

// an unreadable target refuses the refresh and rewrites nothing
{
  const seedTask = openMergeTask({ assignee: { name: 'fixer', session: 'session-fixer' } })
  const worktree = join(PROJECT, '.worktrees', 'T-1')
  const fake = mergeGit({
    'rev-parse HEAD': (args, cwd) => ({ code: 0, stdout: (cwd === worktree ? 'new-head-sha' : 'target-sha') + '\n', stderr: '' }),
  })
  const rig = createSubmitRig({ git: fake.git, merger: null })
  seedMergeTask(rig, seedTask)
  const surface = install(rig)
  const res = await postTo(surface, { action: 'refreshMerge', project: PROJECT, id: 'T-1' })
  check('an unreadable target refuses the refresh', res.json().ok === false && res.json().code === 'target-unreadable', res.text)
  const after = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  const task = after.json().tasks[0]
  check(
    'and nothing is rewritten',
    task.merge.base === 'base-sha' && task.merge.head === 'head-sha' && task.merge.status === 'open' && task.commit === 'head-sha',
    JSON.stringify({ base: task.merge.base, head: task.merge.head, status: task.merge.status, commit: task.commit }),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

// a legacy request with no target keeps its recorded base
{
  const seedTask = openMergeTask({ target: null, assignee: { name: 'fixer', session: 'session-fixer' } })
  seedTask.merge = Object.assign({}, seedTask.merge, { target: null, base: 'base-sha', head: 'head-sha' })
  const fake = mergeGit({
    'diff --name-only base-sha head-sha': () => ({ code: 0, stdout: 'scripts/a.gd\n', stderr: '' }),
  })
  const rig = createSubmitRig({ git: fake.git, merger: null })
  seedMergeTask(rig, seedTask)
  const surface = install(rig)
  const res = await postTo(surface, { action: 'refreshMerge', project: PROJECT, id: 'T-1' })
  const payload = res.json()
  check('a request without a target still refreshes', payload.ok === true, res.text)
  check(
    'and keeps its recorded base',
    payload.task !== undefined && payload.task.merge.base === 'base-sha' && payload.task.actualFiles.join(',') === 'scripts/a.gd',
    JSON.stringify(payload.task && { base: payload.task.merge.base, files: payload.task.actualFiles }),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

// ── the phase machine is the merge gate: review -> testing -> done ─────────
{
  // a request still in review is refused, and neither git nor verification runs
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  const task = openMergeTask({ status: 'reviewing' })
  task.test = null
  task.review = { status: 'pending', by: 'worker', at: new Date().toISOString(), reasons: null, attempt: 1 }
  seedMergeTask(rig, task)
  const surface = install(rig)
  const res = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a request under review cannot merge', res.json().ok === false && res.json().code === 'review-required', res.text)
  check('and no git runs for it', fake.calls.length === 0, JSON.stringify(fake.calls.map((entry) => entry.args)))
  check('and verification does not run', verifier.calls.length === 0, JSON.stringify(verifier.calls))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // testing with a pending test is refused
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  const task = openMergeTask({ status: 'testing' })
  task.test = { status: 'pending', by: null, at: new Date().toISOString(), evidence: null, attempt: 1 }
  seedMergeTask(rig, task)
  const surface = install(rig)
  const res = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a pending test is not mergeable', res.json().ok === false && res.json().code === 'test-required', res.text)
  check('and a pending test never reaches git', fake.calls.length === 0, JSON.stringify(fake.calls.map((entry) => entry.args)))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // a hand-written board with a failed test reports the evidence
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  const task = openMergeTask({ status: 'testing' })
  task.test = { status: 'failed', by: 'tester', at: new Date().toISOString(), evidence: 'FAIL board.test.mjs', attempt: 1 }
  seedMergeTask(rig, task)
  const surface = install(rig)
  const res = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a failed test refuses with test-failed', res.json().ok === false && res.json().code === 'test-failed', res.text)
  check('and the refusal carries the evidence', String(res.json().message).indexOf('FAIL board.test.mjs') >= 0, res.text)
  check('and a failed test never reaches git', fake.calls.length === 0, JSON.stringify(fake.calls.map((entry) => entry.args)))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // a passed test merges, and the merge is what completes the task
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: 'ALL CHECKS PASSED', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(rig, openMergeTask())
  const surface = install(rig)
  const res = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a passed test merges', res.json().ok === true && res.json().task.merge.status === 'merged', res.text)
  check('and the merge completes the task', res.json().task.status === 'done', res.text)
  check(
    'the history records testing -> done',
    res.json().task.history.some((entry) => entry.from === 'testing' && entry.to === 'done'),
    JSON.stringify(res.json().task.history.slice(-2)),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

// ── the phase actions drive the machine, then the host sweep merges ────────
{
  // no Team service at all: submit -> review -> approve -> test -> sweep -> done
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: 'ALL CHECKS PASSED', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }), autoMerge: true })
  check('the sweep rig has no Team service', rig.team === null)
  seedRunningTask(rig, runningWorktreeTask())
  const surface = install(rig)
  const submitted = await postTo(surface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'verify' })
  check(
    'submit enters review with an open request',
    submitted.json().ok === true &&
      submitted.json().task.status === 'reviewing' &&
      submitted.json().task.merge.status === 'open' &&
      submitted.json().task.review.attempt === 1,
    submitted.text,
  )
  const sweepBeforeReview = await rig.api.autoMergePending(PROJECT)
  check('a request under review is not merged by the sweep', sweepBeforeReview.ok === true && sweepBeforeReview.merged.length === 0, JSON.stringify(sweepBeforeReview))
  const approved = await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  check(
    'approveReview moves to testing and opens the test round',
    approved.json().ok === true &&
      approved.json().task.status === 'testing' &&
      approved.json().task.review.status === 'approved' &&
      approved.json().task.test.attempt === 1,
    approved.text,
  )
  const pending = await rig.api.autoMergePending(PROJECT)
  check('a pending test is not merged by the sweep', pending.ok === true && pending.merged.length === 0, JSON.stringify(pending))
  const passed = await postTo(surface, { action: 'passTest', project: PROJECT, id: 'T-1' })
  check(
    'passTest records the pass without completing the task',
    passed.json().ok === true && passed.json().task.status === 'testing' && passed.json().task.test.status === 'passed',
    passed.text,
  )
  const sweep = await rig.api.autoMergePending(PROJECT)
  check('the host sweep merges after a passed test without a merger agent', sweep.ok === true && sweep.merged.join(',') === 'T-1', JSON.stringify(sweep))
  const after = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  check('the task is done and merged', after.json().tasks[0].status === 'done' && after.json().tasks[0].merge.status === 'merged', after.text)
  const forwards = () => fake.calls.filter((entry) => entry.args.join(' ') === 'merge --ff-only merge/T-1').length
  check('main is fast-forwarded exactly once', forwards() === 1, String(forwards()))
  const again = await rig.api.autoMergePending(PROJECT)
  check('a second sweep is a no-op', again.ok === true && again.merged.length === 0, JSON.stringify(again))
  const manual = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('the explicit action then sees no open request', manual.json().ok === false && manual.json().code === 'no-open-merge', manual.text)
  check('and main was still fast-forwarded only once', forwards() === 1, String(forwards()))
  surface.dispose()
  rig.scheduler.dispose()
}

// ── rework: changes-requested and a failed test return to running ──────────
{
  const fake = fakeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  const seeded = runningWorktreeTask()
  seeded.dispatch = Object.assign({}, seeded.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, seeded)
  const surface = install(rig)
  const submitted = await postTo(surface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'v1' })
  check('the first submission opens review round one', submitted.json().task.review.attempt === 1, submitted.text)
  const changes = await postTo(surface, { action: 'requestChanges', project: PROJECT, id: 'T-1', reasons: 'rename the helper' })
  check('requestChanges returns the task to running', changes.json().ok === true && changes.json().task.status === 'running', changes.text)
  check(
    'and keeps the reasons',
    changes.json().task.review.status === 'changes-requested' && changes.json().task.review.reasons === 'rename the helper',
    changes.text,
  )
  const resubmitted = await postTo(surface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'v2' })
  check('the resubmission opens review round two', resubmitted.json().ok === true && resubmitted.json().task.review.attempt === 2, resubmitted.text)
  const approved = await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  const failed = await postTo(surface, { action: 'failTest', project: PROJECT, id: 'T-1', evidence: 'FAIL board.test.mjs' })
  check(
    'failTest returns the task to running with evidence',
    failed.json().ok === true && failed.json().task.status === 'running' && failed.json().task.test.status === 'failed' && failed.json().task.test.evidence === 'FAIL board.test.mjs',
    failed.text,
  )
  const refused = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a reworked task is not mergeable', refused.json().ok === false && refused.json().code === 'not-mergeable-phase', refused.text)
  const again = await postTo(surface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'v3' })
  check('the next submission opens round three', again.json().ok === true && again.json().task.review.attempt === 3, again.text)
  const approvedAgain = await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  check('and the test round follows the review round', approvedAgain.json().ok === true && approvedAgain.json().task.test.attempt === 2, approvedAgain.text)
  surface.dispose()
  rig.scheduler.dispose()
}

// ── the sweep is opt-in: a direct API consumer stays explicit ──────────────
{
  const fake = fakeGit()
  const rig = createSubmitRig({ git: fake.git })
  seedRunningTask(rig, runningWorktreeTask())
  const surface = install(rig)
  await postTo(surface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'verify' })
  const sweep = await rig.api.autoMergePending(PROJECT)
  check('the sweep is off unless the host enables it', sweep.ok === true && sweep.disabled === true && sweep.merged.length === 0, JSON.stringify(sweep))
  const after = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  check('and the request remains open', after.json().tasks[0].merge.status === 'open', after.text)
  surface.dispose()
  rig.scheduler.dispose()
}

// ── seven-column board: counts and phase order ────────────────────────────
{
  const rig = createSubmitRig({ git: fakeGit().git })
  const stamp = new Date().toISOString()
  const tasks = ['done', 'testing', 'cancelled', 'pending', 'blocked', 'reviewing', 'running'].map((status, index) => ({
    id: 'T-' + String(index + 1),
    title: status,
    status: status,
    priority: 0,
    dependsOn: [],
    writeFiles: [],
    base: null,
    target: null,
    branch: null,
    worktree: null,
    worktreeError: null,
    commit: null,
    actualFiles: [],
    requiredRole: null,
    merge: null,
    assignee: null,
    attempts: 0,
    maxAttempts: 3,
    evidence: '',
    dispatch: null,
    leaseUntil: null,
    createdBy: '@me',
    createdAt: stamp,
    updatedAt: stamp,
    history: [],
  }))
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 8, dispatch: { state: 'paused' }, tasks: tasks }))
  const surface2 = install(rig)
  const res = await call(surface2, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  check(
    'the board lists the seven phases in rank order',
    res.json().tasks.map((task) => task.status).join(',') === 'pending,running,reviewing,testing,blocked,done,cancelled',
    res.json().tasks.map((task) => task.status).join(','),
  )
  check(
    'counts expose all seven columns',
    ['pending', 'running', 'reviewing', 'testing', 'blocked', 'done', 'cancelled'].every((key) => res.json().counts[key] === 1) && res.json().counts.total === 7,
    JSON.stringify(res.json().counts),
  )
  surface2.dispose()
  rig.scheduler.dispose()
}

// ── role permission gates and host provisioning ───────────────────────────
function roleTeam() {
  return createTeam({
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
      { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
    ],
  })
}

function agentCaller(id) {
  return { projectPath: PROJECT, by: '@' + id, role: 'agent', agent: { id: id } }
}

function reviewStageTask(overrides) {
  const stamp = new Date().toISOString()
  return runningWorktreeTask(
    Object.assign(
      {
        status: 'reviewing',
        leaseUntil: null,
        review: { status: 'pending', by: '@fixer', at: stamp, reasons: null, attempt: 1 },
        test: null,
      },
      overrides === undefined ? {} : overrides,
    ),
  )
}

function testStageTask(overrides) {
  const stamp = new Date().toISOString()
  return reviewStageTask(
    Object.assign(
      {
        status: 'testing',
        review: { status: 'approved', by: 'reviewer-1', at: stamp, reasons: null, attempt: 1 },
        test: { status: 'pending', by: null, at: stamp, evidence: null, attempt: 1 },
      },
      overrides === undefined ? {} : overrides,
    ),
  )
}

{
  const fake = fakeGit()
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fake.git })
  seedRunningTask(rig, reviewStageTask())
  const workerReview = await rig.api.perform('approveReview', { id: 'T-1' }, agentCaller('session-fixer'))
  check('a worker cannot review its own task', workerReview.ok === false && workerReview.code === 'worker-cannot-self-review', JSON.stringify(workerReview))
  const testerReview = await rig.api.perform('approveReview', { id: 'T-1' }, agentCaller('session-tester-1'))
  check('a tester cannot approve a review', testerReview.ok === false && testerReview.code === 'wrong-role', JSON.stringify(testerReview))
  const reviewerApprove = await rig.api.perform('approveReview', { id: 'T-1' }, agentCaller('session-reviewer-1'))
  check('a reviewer approves the review', reviewerApprove.ok === true && reviewerApprove.task.status === 'testing', JSON.stringify(reviewerApprove))
  rig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fake.git })
  seedRunningTask(rig, testStageTask())
  const reviewerPass = await rig.api.perform('passTest', { id: 'T-1', evidence: 'ok' }, agentCaller('session-reviewer-1'))
  check('a reviewer cannot pass tests', reviewerPass.ok === false && reviewerPass.code === 'wrong-role', JSON.stringify(reviewerPass))
  const workerPass = await rig.api.perform('passTest', { id: 'T-1', evidence: 'ok' }, agentCaller('session-fixer'))
  check('a worker cannot test its own task', workerPass.ok === false && workerPass.code === 'worker-cannot-self-test', JSON.stringify(workerPass))
  const testerPass = await rig.api.perform('passTest', { id: 'T-1', evidence: 'ok' }, agentCaller('session-tester-1'))
  check('a tester passes the test phase', testerPass.ok === true && testerPass.task.test.status === 'passed', JSON.stringify(testerPass))
  rig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fake.git })
  seedRunningTask(rig, runningWorktreeTask())
  const reviewerSubmit = await rig.api.perform('submit', { id: 'T-1', evidence: 'x' }, agentCaller('session-reviewer-1'))
  check('a reviewer cannot submit implementation work', reviewerSubmit.ok === false && reviewerSubmit.code === 'role-cannot-implement', JSON.stringify(reviewerSubmit))
  const testerSubmit = await rig.api.perform('submit', { id: 'T-1', evidence: 'x' }, agentCaller('session-tester-1'))
  check('a tester cannot submit implementation work', testerSubmit.ok === false && testerSubmit.code === 'role-cannot-implement', JSON.stringify(testerSubmit))
  check('a refused role submit never touches git', fake.calls.length === 0, JSON.stringify(fake.calls))
  rig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const team = createTeam({ roster: [
    { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
    { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
  ] })
  const rig = createSubmitRig({ team: team, roles: true, git: fake.git })
  seedRunningTask(rig, runningWorktreeTask({ title: 'Auto role task', spec: 'Implement X', acceptance: 'X works' }))
  const submitted = await rig.action('submit', { id: 'T-1', evidence: 'unit tests' })
  check(
    'submit enters review and provisions a reviewer',
    submitted.ok === true && submitted.task.status === 'reviewing' && submitted.provisioned !== undefined && submitted.provisioned.created[0].name === 'reviewer-1',
    JSON.stringify(submitted.provisioned),
  )
  const spawns = team.calls.filter((call) => call.kind === 'spawn').map((call) => call.name)
  check('the host spawned the reviewer without a Lead prompt', spawns.join(',') === 'reviewer-1', JSON.stringify(spawns))
  const reviewerCall = team.calls.filter((call) => call.kind === 'spawn' && call.name === 'reviewer-1')[0]
  check(
    'the spawned reviewer brief carries the task and the boundary',
    reviewerCall !== undefined &&
      reviewerCall.text.indexOf('Auto role task') >= 0 &&
      reviewerCall.text.indexOf('Implement X') >= 0 &&
      reviewerCall.text.indexOf('X works') >= 0 &&
      reviewerCall.text.indexOf('READ-ONLY') >= 0 &&
      reviewerCall.text.indexOf('approveReview') >= 0,
    reviewerCall === undefined ? '' : reviewerCall.text.slice(0, 600),
  )
  const approved = await rig.action('approveReview', { id: 'T-1' })
  check(
    'approving the review provisions a tester',
    approved.ok === true && approved.task.status === 'testing' && approved.provisioned !== undefined && approved.provisioned.created[0].name === 'tester-1',
    JSON.stringify(approved.provisioned),
  )
  const names = team.calls.filter((call) => call.kind === 'spawn').map((call) => call.name)
  check('both stage roles are live', names.join(',') === 'reviewer-1,tester-1', JSON.stringify(names))
  rig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const team = createTeam({ roster: [
    { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
    { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
  ] })
  const rig = createSubmitRig({ team: team, roles: true, git: fake.git })
  rig.fs.files.set(
    rolesPath(PROJECT),
    { text: JSON.stringify({ defaultProfile: 'worker', profiles: { reviewer: { instances: 2, skills: ['dsh-plugin-workflow'] } } }), version: 'seed' },
  )
  seedRunningTask(rig, runningWorktreeTask({ spec: 'Config task' }))
  const submitted = await rig.action('submit', { id: 'T-1', evidence: 'x' })
  check(
    'the project role config fills two reviewer instances',
    submitted.provisioned !== undefined && submitted.provisioned.created.map((entry) => entry.name).join(',') === 'reviewer-1,reviewer-2',
    JSON.stringify(submitted.provisioned && submitted.provisioned.created),
  )
  const reviewerCalls = team.calls.filter((call) => call.kind === 'spawn' && call.name.indexOf('reviewer-') === 0)
  check(
    'the configured skill is referenced in every reviewer brief',
    reviewerCalls.length === 2 && reviewerCalls.every((call) => call.text.indexOf('dsh-plugin-workflow') >= 0),
    JSON.stringify(reviewerCalls.map((call) => call.name)),
  )
  const snapshot = await rig.api.snapshot(PROJECT)
  check(
    'the snapshot exposes the project role config',
    snapshot.roles !== undefined && snapshot.roles.profiles.reviewer.instances === 2 && snapshot.roles.profiles.reviewer.stage === 'review' && snapshot.roles.stages.review === 'reviewer',
    JSON.stringify(snapshot.roles),
  )
  rig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const team = createTeam({ roster: [
    { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
    { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
  ] })
  const rig = createSubmitRig({ team: team, roles: true, git: fake.git })
  const host = rig.scheduler.boot
  const first = runningWorktreeTask({ id: 'T-1', title: 'First' })
  first.dispatch = Object.assign({}, first.dispatch, { host: host })
  const second = runningWorktreeTask({ id: 'T-2', title: 'Second', worktree: join(PROJECT, '.worktrees', 'T-2'), branch: 'task/T-2-1' })
  second.dispatch = Object.assign({}, second.dispatch, { host: host })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [first, second] }))
  const one = await rig.action('submit', { id: 'T-1', evidence: 'x' })
  check('the first submit spawns one reviewer', one.provisioned !== undefined && one.provisioned.created.length === 1, JSON.stringify(one.provisioned))
  const two = await rig.action('submit', { id: 'T-2', evidence: 'y' })
  check(
    'the second submit reuses the live reviewer',
    two.provisioned !== undefined && two.provisioned.created.length === 0 && two.provisioned.reused.indexOf('reviewer-1') >= 0,
    JSON.stringify({ ok: two.ok, status: two.task && two.task.status, code: two.code, provisioned: two.provisioned }),
  )
  check('only one reviewer was spawned', team.calls.filter((call) => call.kind === 'spawn' && call.name === 'reviewer-1').length === 1, JSON.stringify(team.calls.map((call) => call.name)))
  rig.scheduler.dispose()
}

{
  const plain = createRig({ allowSpawn: false })
  const snapshot = await plain.api.snapshot(PROJECT)
  check(
    'a project without roles.json exposes the default profiles',
    snapshot.roles !== undefined && snapshot.roles.defaultProfile === 'worker' && snapshot.roles.stages.implement === 'worker' && snapshot.roles.profiles.tester.instances === 1,
    JSON.stringify(snapshot.roles),
  )
  plain.scheduler.dispose()
}

// ── reviewer workflow: brief, hand-back and the round policy ───────────────
{
  const fake = fakeGit()
  const team = roleTeam()
  const rig = createSubmitRig({ team: team, roles: true, git: fake.git })
  const seeded = runningWorktreeTask({ spec: 'Add a guard', acceptance: 'the guard holds', writeFiles: ['scripts/a.gd'] })
  seeded.dispatch = Object.assign({}, seeded.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, seeded)
  const submitted = await rig.action('submit', { id: 'T-1', evidence: 'unit tests passed' })
  check('submit enters review with a live reviewer', submitted.ok === true && submitted.task.status === 'reviewing', JSON.stringify(submitted))
  const sends = team.calls.filter((call) => call.kind === 'send' && call.target === 'reviewer-1')
  check('the host sends the reviewer the round brief', sends.length >= 1, JSON.stringify(team.calls.map((call) => call.kind + ':' + call.target)))
  const text = sends.length === 0 ? '' : sends[0].text
  check('the brief names the round and the diff', text.indexOf('Review round 1') >= 0 && text.indexOf('base-sha..head-sha') >= 0, text.slice(0, 500))
  check(
    'the brief carries spec, acceptance, files and evidence',
    text.indexOf('Add a guard') >= 0 && text.indexOf('the guard holds') >= 0 && text.indexOf('scripts/a.gd') >= 0 && text.indexOf('unit tests passed') >= 0,
    text.slice(0, 900),
  )
  check(
    'the brief carries the checklist and the no-full-test note',
    text.indexOf('Review checklist') >= 0 && text.indexOf('do NOT need to run the full test suite') >= 0,
    text.slice(-700),
  )
  rig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const team = createTeam({
    roster: [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }],
  })
  const rig = createSubmitRig({ team: team, roles: true, git: fake.git })
  const seeded = runningWorktreeTask()
  seeded.dispatch = Object.assign({}, seeded.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, seeded)
  const submitted = await rig.action('submit', { id: 'T-1', evidence: 'checked' })
  check(
    'the host provisions a reviewer when the roster has none',
    submitted.provisioned !== undefined && submitted.provisioned.created[0].name === 'reviewer-1',
    JSON.stringify(submitted.provisioned),
  )
  const sends = team.calls.filter((call) => call.kind === 'send' && call.target === 'reviewer-1')
  check('the new reviewer receives the round brief', sends.length >= 1 && sends[0].text.indexOf('Review round 1') >= 0, JSON.stringify(sends.map((call) => call.text.slice(0, 60))))
  rig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const team = roleTeam()
  const rig = createSubmitRig({ team: team, roles: true, git: fake.git })
  const seeded = reviewStageTask()
  seeded.dispatch = Object.assign({}, seeded.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, seeded)
  const changed = await rig.api.perform('requestChanges', { id: 'T-1', reasons: 'rename the helper in scripts/a.gd:12' }, agentCaller('session-reviewer-1'))
  check('the reviewer sends the task back to running', changed.ok === true && changed.task.status === 'running', JSON.stringify(changed))
  const workerSends = team.calls.filter((call) => call.kind === 'send' && call.target === 'fixer')
  check(
    'the worker is told the reasons and keeps its worktree',
    workerSends.some(
      (call) => call.text.indexOf('rename the helper in scripts/a.gd:12') >= 0 && call.text.indexOf('SAME worktree') >= 0 && call.text.indexOf(join(PROJECT, '.worktrees', 'T-1')) >= 0,
    ),
    JSON.stringify(workerSends.map((call) => call.text.slice(0, 120))),
  )
  const resubmitted = await rig.api.perform('submit', { id: 'T-1', evidence: 'renamed and retested' }, agentCaller('session-fixer'))
  check('the worker resubmits for the next round', resubmitted.ok === true && resubmitted.task.review.attempt === 2, JSON.stringify(resubmitted.ok ? resubmitted.task.review : resubmitted))
  const reviewerSends = team.calls.filter((call) => call.kind === 'send' && call.target === 'reviewer-1')
  check('round two sends the reviewer a fresh brief', reviewerSends.some((call) => call.text.indexOf('Review round 2') >= 0), JSON.stringify(reviewerSends.map((call) => call.text.slice(0, 80))))
  rig.scheduler.dispose()
}

{
  const fake = mergeGit({
    'rev-parse --verify main': () => ({ code: 0, stdout: 'target-sha\n', stderr: '' }),
  })
  const team = roleTeam()
  const rig = createSubmitRig({ team: team, roles: true, git: fake.git })
  const seedTask = reviewStageTask({
    merge: {
      status: 'open',
      base: 'base-sha',
      target: 'main',
      head: 'head-sha',
      mergeCommit: null,
      declaredFiles: ['scripts/a.gd'],
      actualFiles: ['scripts/a.gd'],
      tests: 'npm run verify',
      reviewer: null,
      conflict: null,
      output: null,
      at: new Date().toISOString(),
    },
  })
  seedMergeTask(rig, seedTask)
  const surface2 = install(rig)
  const res = await postTo(surface2, { action: 'refreshMerge', project: PROJECT, id: 'T-1' })
  check('a refresh re-enters review', res.json().ok === true && res.json().task.status === 'reviewing' && res.json().task.review.attempt === 2, res.text)
  const sends = team.calls.filter((call) => call.kind === 'send' && call.target === 'reviewer-1')
  check('the refreshed round gets a new review brief', sends.some((call) => call.text.indexOf('Review round 2') >= 0), JSON.stringify(sends.map((call) => call.text.slice(0, 80))))
  surface2.dispose()
  rig.scheduler.dispose()
}

{
  const fake = fakeGit()
  const team = roleTeam()
  const rig = createSubmitRig({ team: team, roles: true, git: fake.git })
  const stamp = new Date().toISOString()
  const seeded = runningWorktreeTask()
  seeded.review = { status: 'changes-requested', by: 'reviewer-1', at: stamp, reasons: 'again', attempt: 3 }
  seeded.dispatch = Object.assign({}, seeded.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, seeded)
  const submitted = await rig.action('submit', { id: 'T-1', evidence: 'fourth round' })
  check('a fourth review round is blocked for triage', submitted.ok === true && submitted.task.status === 'blocked', JSON.stringify(submitted.ok ? submitted.task.status : submitted))
  check(
    'and the block records the round policy',
    submitted.task.history.some((entry) => String(entry.note).indexOf('review round limit') >= 0),
    JSON.stringify(submitted.task.history.slice(-2)),
  )
  rig.scheduler.dispose()
}

{
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const team = roleTeam()
  const rig = createSubmitRig({ team: team, roles: true, git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(rig, openMergeTask())
  const refused = await rig.api.perform('mergeRequest', { id: 'T-1' }, agentCaller('session-reviewer-1'))
  check('a reviewer cannot merge', refused.ok === false && refused.code === 'merger-only', JSON.stringify(refused))
  check('and the review slot never touched git', fake.calls.length === 0, JSON.stringify(fake.calls.map((entry) => entry.args)))
  rig.scheduler.dispose()
}

{
  // hand-written board: testing with a passed test but no approved review
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  const stamp = new Date().toISOString()
  const task = openMergeTask({ status: 'testing' })
  task.review = { status: 'pending', by: null, at: stamp, reasons: null, attempt: 1 }
  task.test = { status: 'passed', by: 'tester-1', at: stamp, evidence: 'ok', attempt: 1 }
  seedMergeTask(rig, task)
  const surface2 = install(rig)
  const res = await postTo(surface2, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('a testing task without an approved review cannot merge', res.json().ok === false && res.json().code === 'review-required', res.text)
  check('and the merge gate reads no git', fake.calls.length === 0, JSON.stringify(fake.calls.map((entry) => entry.args)))
  surface2.dispose()
  rig.scheduler.dispose()
}

// ── tester workflow: candidate checkout, Godot brief, pass/fail/auto-merge ─
function testerGit(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  let targetHead = opts.targetHead === undefined ? 'target-sha' : opts.targetHead
  const run = (args, cwd) => {
    calls.push({ args: args.slice(), cwd: cwd })
    const key = args.join(' ')
    if (key === 'branch --show-current') return { code: 0, stdout: 'main\n', stderr: '' }
    if (key === 'status --porcelain') return { code: 0, stdout: '', stderr: '' }
    if (key === 'rev-parse HEAD') {
      return { code: 0, stdout: (String(cwd).indexOf('test-T-1') >= 0 ? 'candidate-sha' : targetHead) + '\n', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  run.calls = calls
  run.setTargetHead = function (value) {
    targetHead = value
  }
  return { git: createGit({ run: run }), calls: calls, setTargetHead: run.setTargetHead }
}

function testerTeam() {
  return createTeam({
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
    ],
  })
}

function createTesterRig(options) {
  const opts = options === undefined ? {} : options
  const fake = testerGit(opts)
  const team = testerTeam()
  const verifier = opts.verifier === undefined ? null : opts.verifier
  const rig = createSubmitRig({
    team: team,
    roles: true,
    git: fake.git,
    merger: createMerger({ git: fake.git, verify: verifier === null ? undefined : verifier.verify }),
    godotPath: 'C:/fake/godot.exe',
  })
  // A Godot marker so the tester brief carries the launch/runbook section.
  rig.fs.files.set(join(PROJECT, 'project.godot'), { text: 'config_version=5', version: 'seed' })
  return { rig: rig, fake: fake, team: team, verifier: verifier }
}

function acceptingTask(overrides) {
  const stamp = new Date().toISOString()
  return reviewStageTask(
    Object.assign(
      {
        title: 'Tester task',
        spec: 'Implement the tester feature',
        acceptance: 'The feature works end to end',
        merge: {
          status: 'open',
          base: 'base-sha',
          target: 'main',
          head: 'head-sha',
          mergeCommit: null,
          declaredFiles: ['scripts/a.gd'],
          actualFiles: ['scripts/a.gd'],
          tests: 'npm test',
          reviewer: null,
          conflict: null,
          output: null,
          at: stamp,
        },
      },
      overrides === undefined ? {} : overrides,
    ),
  )
}

{
  const ctx = createTesterRig()
  const rig = ctx.rig
  const fake = ctx.fake
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask()] }))
  const surface = install(rig)
  const approved = await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  const payload = approved.json()
  check('approveReview builds the test candidate', payload.ok === true && payload.task.status === 'testing', approved.text)
  check(
    'the candidate base is the target head and its head is the merge commit',
    payload.task !== undefined && payload.task.base === 'target-sha' && payload.task.merge.mergeCommit === 'candidate-sha',
    JSON.stringify(payload.task && { base: payload.task.base, merge: payload.task.merge }),
  )
  const addCall = fake.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add')[0]
  const candidatePath = join(PROJECT, '.worktrees', 'test-T-1')
  check(
    'the candidate is created from the target head on test/<id>',
    addCall !== undefined && addCall.args.join(' ') === 'worktree add -b test/T-1 ' + candidatePath + ' target-sha' && addCall.cwd === PROJECT,
    JSON.stringify(addCall && addCall.args),
  )
  const mergeCall = fake.calls.filter((call) => call.args[0] === 'merge' && call.args[1] === '--no-ff')[0]
  check(
    'the task branch is merged inside the candidate',
    mergeCall !== undefined && mergeCall.cwd === candidatePath && mergeCall.args.join(' ') === 'merge --no-ff --no-edit task/T-1-1',
    JSON.stringify(mergeCall && mergeCall.args),
  )
  const sent = ctx.team.calls.filter((call) => call.kind === 'send' && call.target === 'tester-1')
  check('the tester receives the test brief', sent.length === 1, JSON.stringify(ctx.team.calls.map((call) => call.target)))
  const brief = sent.length === 0 ? '' : sent[0].text
  check('the tester brief carries the candidate path and branch', brief.indexOf(candidatePath) >= 0 && brief.indexOf('test/T-1') >= 0, brief.slice(0, 600))
  check('the tester brief carries acceptance and the test plan', brief.indexOf('The feature works end to end') >= 0 && brief.indexOf('Test plan / runbook') >= 0, brief.slice(0, 800))
  check('the Godot brief names the fake engine path and launch calls', brief.indexOf('C:/fake/godot.exe') >= 0 && brief.indexOf('godot_run_headless') >= 0 && brief.indexOf('godot_run_project') >= 0, brief.slice(0, 1200))
  check('the Godot brief forbids launching through a shell', brief.indexOf('pwsh/bash') >= 0, brief.slice(0, 1200))
  check('the tester brief carries the evidence format and both verdict actions', brief.indexOf('Evidence format') >= 0 && brief.indexOf('passTest') >= 0 && brief.indexOf('failTest') >= 0, brief.slice(-600))
  const snapshot = await rig.api.snapshot(PROJECT)
  check(
    'the snapshot exposes the active test candidate',
    snapshot.tasks[0].candidate !== null && snapshot.tasks[0].candidate.path === candidatePath && snapshot.tasks[0].candidate.branch === 'test/T-1' && snapshot.tasks[0].candidate.head === 'candidate-sha',
    JSON.stringify(snapshot.tasks[0].candidate),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

{
  const verifier = fakeVerifier({ code: 0, stdout: 'HOST VERIFY SHOULD NOT RUN', stderr: '' })
  const ctx = createTesterRig({ verifier: verifier })
  const rig = ctx.rig
  const fake = ctx.fake
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask()] }))
  const surface = install(rig)
  await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  const passed = await postTo(surface, { action: 'passTest', project: PROJECT, id: 'T-1', evidence: 'npm test: PASS' })
  const payload = passed.json()
  check('a passed test merges the candidate automatically', payload.ok === true && payload.task.status === 'done' && payload.task.merge.status === 'merged', passed.text)
  check('the passed verdict keeps the tester evidence', payload.task.test.status === 'passed' && payload.task.test.evidence === 'npm test: PASS', JSON.stringify(payload.task.test))
  check('the merged record names the candidate commit', payload.task.merge.mergeCommit === 'candidate-sha', JSON.stringify(payload.task.merge))
  const candidatePath = join(PROJECT, '.worktrees', 'test-T-1')
  const forward = fake.calls.filter((call) => call.args.join(' ') === 'merge --ff-only test/T-1')[0]
  check('main is fast-forwarded to the candidate', forward !== undefined && forward.cwd === PROJECT, JSON.stringify(forward))
  check(
    'the candidate checkout and branch are cleaned up',
    fake.calls.some((call) => call.args.join(' ') === 'worktree remove --force ' + candidatePath) && fake.calls.some((call) => call.args.join(' ') === 'branch -D test/T-1'),
    JSON.stringify(fake.calls.map((call) => call.args)),
  )
  check('the task worktree is removed after the merge', fake.calls.some((call) => call.args.join(' ') === 'worktree remove --force ' + join(PROJECT, '.worktrees', 'T-1')))
  const after = await rig.api.snapshot(PROJECT)
  check('no candidate remains after the merge', after.tasks[0].candidate === null, JSON.stringify(after.tasks[0].candidate))
  check('the host does not run a third full verify before merging', verifier.calls.length === 0, JSON.stringify(verifier.calls))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  const ctx = createTesterRig()
  const rig = ctx.rig
  const fake = ctx.fake
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask()] }))
  const surface = install(rig)
  await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  const failed = await postTo(surface, { action: 'failTest', project: PROJECT, id: 'T-1', evidence: 'FAIL scripts/test/game.test.mjs: boss room does not load' })
  const payload = failed.json()
  check('a failed test returns the task to running with evidence', payload.ok === true && payload.task.status === 'running' && payload.task.test.status === 'failed' && payload.task.test.evidence.indexOf('boss room') >= 0, failed.text)
  const candidatePath = join(PROJECT, '.worktrees', 'test-T-1')
  check(
    'a failed test cleans up the candidate',
    fake.calls.some((call) => call.args.join(' ') === 'worktree remove --force ' + candidatePath) && fake.calls.some((call) => call.args.join(' ') === 'branch -D test/T-1'),
    JSON.stringify(fake.calls.map((call) => call.args)),
  )
  check('main is never fast-forwarded on a failed test', fake.calls.every((call) => call.args.join(' ') !== 'merge --ff-only test/T-1'), JSON.stringify(fake.calls.map((call) => call.args)))
  const ownerSent = ctx.team.calls.filter((call) => call.kind === 'send' && call.target === 'fixer')
  check('the worker is told what failed, with the evidence', ownerSent.length === 1 && ownerSent[0].text.indexOf('boss room') >= 0, JSON.stringify(ownerSent))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  const ctx = createTesterRig()
  const rig = ctx.rig
  const fake = ctx.fake
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask()] }))
  const surface = install(rig)
  await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  fake.setTargetHead('moved-sha')
  const passed = await postTo(surface, { action: 'passTest', project: PROJECT, id: 'T-1', evidence: 'PASS on the old candidate' })
  const payload = passed.json()
  check('a moved target invalidates the verdict and keeps testing', payload.ok === true && payload.task.status === 'testing' && payload.task.test.status === 'pending', passed.text)
  check('a new test round starts', payload.task.test.attempt === 2, JSON.stringify(payload.task.test))
  check('the stale candidate was replaced from the new target head', payload.task.base === 'moved-sha' && payload.task.merge.mergeCommit === 'candidate-sha', JSON.stringify({ base: payload.task.base, merge: payload.task.merge }))
  check('main is never fast-forwarded for a stale verdict', fake.calls.every((call) => call.args.join(' ') !== 'merge --ff-only test/T-1'), JSON.stringify(fake.calls.map((call) => call.args)))
  const adds = fake.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add')
  check('the candidate is rebuilt from the moved target', adds.length === 2 && adds[1].args.join(' ') === 'worktree add -b test/T-1 ' + join(PROJECT, '.worktrees', 'test-T-1') + ' moved-sha', JSON.stringify(adds.map((call) => call.args)))
  const testerSends = ctx.team.calls.filter((call) => call.kind === 'send' && call.target === 'tester-1')
  check('the tester is asked to retest', testerSends.length === 2 && testerSends[1].text.indexOf('Independent TEST round 2') >= 0, JSON.stringify(testerSends.map((call) => call.text.slice(0, 80))))
  surface.dispose()
  rig.scheduler.dispose()
}

// ── runtime snapshot: agents, worktrees, activity ─────────────────────────
{
  const fake = fakeGit({
    worktrees: [
      { path: PROJECT, branch: 'feat/task-center-v2', head: 'main-sha' },
      { path: join(PROJECT, '.worktrees', 'T-1'), branch: 'task/T-1-1', head: 'head-sha' },
      { path: join(PROJECT, '.worktrees', 'test-T-1'), branch: 'test/T-1', head: 'candidate-sha' },
      { path: join(PROJECT, '.worktrees', 'verify-T-2') },
      { path: join(PROJECT, '.worktrees', 'merge-T-2') },
      { path: '/srv/other-checkout', branch: 'main' },
    ],
  })
  const rig = createSubmitRig({ git: fake.git })
  const running = runningWorktreeTask()
  const done = runningWorktreeTask({ id: 'T-2', title: 'done task', status: 'done', worktree: join(PROJECT, '.worktrees', 'T-2'), branch: 'task/T-2-1' })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [running, done] }))
  const snapshot = await rig.action('board')
  const worktrees = snapshot.worktrees
  check('the worktree inventory is available', worktrees.available === true && worktrees.error === null, JSON.stringify({ available: worktrees.available, error: worktrees.error }))
  const byPath = {}
  for (const entry of worktrees.worktrees) byPath[entry.path] = entry
  check(
    'worktrees are typed main/task/test/verify/merge/other',
    byPath[PROJECT].type === 'main' &&
      byPath[join(PROJECT, '.worktrees', 'T-1')].type === 'task' &&
      byPath[join(PROJECT, '.worktrees', 'test-T-1')].type === 'test' &&
      byPath[join(PROJECT, '.worktrees', 'verify-T-2')].type === 'verify' &&
      byPath[join(PROJECT, '.worktrees', 'merge-T-2')].type === 'merge' &&
      byPath['/srv/other-checkout'].type === 'other',
    JSON.stringify(worktrees.worktrees.map((entry) => entry.type)),
  )
  check(
    'the worktree keeps branch and head',
    byPath[PROJECT].branch === 'feat/task-center-v2' &&
      byPath[PROJECT].head === 'main-sha' &&
      byPath[join(PROJECT, '.worktrees', 'T-1')].branch === 'task/T-1-1',
    JSON.stringify({ main: byPath[PROJECT], task: byPath[join(PROJECT, '.worktrees', 'T-1')] }),
  )
  check(
    'worktrees are associated with their tasks',
    byPath[join(PROJECT, '.worktrees', 'T-1')].taskId === 'T-1' &&
      byPath[join(PROJECT, '.worktrees', 'test-T-1')].taskId === 'T-1' &&
      byPath[join(PROJECT, '.worktrees', 'verify-T-2')].taskId === 'T-2' &&
      byPath[join(PROJECT, '.worktrees', 'merge-T-2')].taskId === 'T-2',
    JSON.stringify(worktrees.worktrees.map((entry) => ({ path: entry.path, task: entry.taskId }))),
  )
  check(
    'active means a task currently occupies it (main always)',
    byPath[PROJECT].active === true &&
      byPath[join(PROJECT, '.worktrees', 'T-1')].active === true &&
      byPath[join(PROJECT, '.worktrees', 'test-T-1')].active === true &&
      byPath[join(PROJECT, '.worktrees', 'verify-T-2')].active === false &&
      byPath[join(PROJECT, '.worktrees', 'merge-T-2')].active === false &&
      byPath['/srv/other-checkout'].active === false,
    JSON.stringify(worktrees.worktrees.map((entry) => ({ path: entry.path, active: entry.active }))),
  )
  check(
    'worktree counts add up',
    worktrees.total === 6 &&
      worktrees.active === 3 &&
      worktrees.counts.main === 1 &&
      worktrees.counts.task === 1 &&
      worktrees.counts.test === 1 &&
      worktrees.counts.verify === 1 &&
      worktrees.counts.merge === 1 &&
      worktrees.counts.other === 1,
    JSON.stringify({ total: worktrees.total, active: worktrees.active, counts: worktrees.counts }),
  )
}

{
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  seedRunningTask(rig, runningWorktreeTask())
  const snapshot = await rig.action('board')
  const agents = snapshot.agents
  check('the lead is reported as the lead kind', agents.lead !== null && agents.lead.kind === 'lead' && agents.lead.description === 'Team lead', JSON.stringify(agents.lead))
  const members = agents.members
  const byName = {}
  for (const member of members) byName[member.name] = member
  check(
    'teammates carry kind, description, session and currentTask',
    byName['fixer'].kind === 'worker' &&
      byName['fixer'].description === 'feature worker' &&
      byName['fixer'].session === 'session-fixer' &&
      byName['fixer'].currentTask !== null &&
      byName['fixer'].currentTask.id === 'T-1' &&
      byName['reviewer-1'].kind === 'reviewer' &&
      byName['reviewer-1'].description === 'review role' &&
      byName['reviewer-1'].currentTask === null &&
      byName['tester-1'].kind === 'tester',
    JSON.stringify(members),
  )
  check('agent kinds are counted', agents.kinds.lead === 1 && agents.kinds.worker === 1 && agents.kinds.reviewer === 1 && agents.kinds.tester === 1 && agents.kinds.merger === 0, JSON.stringify(agents.kinds))
  check(
    'the role config reports desired/live/missing instances',
    agents.roles !== null &&
      agents.roles.desired.worker === 1 &&
      agents.roles.desired.reviewer === 1 &&
      agents.roles.live.reviewer === 1 &&
      agents.roles.missing.reviewer === 0,
    JSON.stringify(agents.roles),
  )
  check('no System pseudo-agent is listed among the members', members.every((member) => member.kind !== 'system'), JSON.stringify(members.map((member) => member.kind)))
}

{
  const activity = createActivity({ limit: 50 })
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git, activity: activity })
  const seeded = runningWorktreeTask()
  seeded.dispatch = Object.assign({}, seeded.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, seeded)
  const submitted = await rig.api.perform('submit', { id: 'T-1', evidence: 'checked' }, agentCaller('session-fixer'))
  check('the submit enters review', submitted.ok === true && submitted.task.status === 'reviewing', JSON.stringify(submitted.ok ? submitted.task.status : submitted))
  const afterSubmit = activity.snapshot()
  const reviewStart = afterSubmit.entries.filter((entry) => entry.kind === 'review-start')[0]
  check(
    'review start is an agent event with its name',
    reviewStart !== undefined && reviewStart.actor === 'agent' && reviewStart.actorName === '@session-fixer' && reviewStart.taskId === 'T-1',
    JSON.stringify(reviewStart),
  )
  const approved = await rig.api.perform('approveReview', { id: 'T-1' }, agentCaller('session-reviewer-1'))
  check('the review is approved into testing', approved.ok === true && approved.task.status === 'testing', JSON.stringify(approved.ok ? approved.task.status : approved))
  const afterApprove = activity.snapshot()
  check(
    'review end is an agent event and test start is a host event',
    afterApprove.entries.some((entry) => entry.kind === 'review-end' && entry.actor === 'agent' && entry.actorName === '@session-reviewer-1') &&
      afterApprove.entries.some((entry) => entry.kind === 'test-start' && entry.actor === 'host'),
    JSON.stringify(afterApprove.entries.slice(0, 6)),
  )
  const tested = await rig.api.perform('passTest', { id: 'T-1', evidence: 'ok' }, agentCaller('session-tester-1'))
  check('the test is passed', tested.ok === true && tested.task.test.status === 'passed', JSON.stringify(tested.ok ? tested.task.test : tested))
  const afterTest = activity.snapshot()
  const testEnd = afterTest.entries.filter((entry) => entry.kind === 'test-end')[0]
  check('test end is an agent event from the tester', testEnd !== undefined && testEnd.actor === 'agent' && testEnd.actorName === '@session-tester-1', JSON.stringify(testEnd))
  check('activity is newest-first', afterTest.entries[0].kind === 'test-end', JSON.stringify(afterTest.entries.slice(0, 3)))
  check('activity counts its actors', afterTest.actors.agent >= 3 && afterTest.actors.host >= 1, JSON.stringify(afterTest.actors))
  check(
    'system events never masquerade as agents',
    afterTest.entries.every((entry) => (entry.actor === 'agent' ? typeof entry.actorName === 'string' : entry.actorName === null)),
    JSON.stringify(afterTest.entries.filter((entry) => entry.actor === 'system').slice(0, 3)),
  )
  const snapshot = await rig.action('board')
  check(
    'the snapshot exposes the activity ring',
    snapshot.activity.available === true && snapshot.activity.entries.length >= 4 && snapshot.activity.limit === 50,
    JSON.stringify({ available: snapshot.activity.available, count: snapshot.activity.count }),
  )
}

{
  // A missing reviewer is provisioned by the host: role provisioning is a SYSTEM
  // event, never dressed up as an agent action.
  const team = createTeam({
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
    ],
  })
  const activity = createActivity({})
  const rig = createSubmitRig({ team: team, roles: true, git: fakeGit().git, activity: activity })
  const seeded = runningWorktreeTask()
  seeded.dispatch = Object.assign({}, seeded.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, seeded)
  const submitted = await rig.action('submit', { id: 'T-1', evidence: 'checked' })
  check(
    'a missing reviewer is provisioned on submit',
    submitted.ok === true && submitted.provisioned !== undefined && submitted.provisioned.created[0].name === 'reviewer-1',
    JSON.stringify(submitted.provisioned),
  )
  const provisioned = activity.snapshot()
  const event = provisioned.entries.filter((entry) => entry.kind === 'role-provision')[0]
  check('role provisioning is a system event with no agent name', event !== undefined && event.actor === 'system' && event.actorName === null && provisioned.actors.system >= 1, JSON.stringify(event))
}

{
  const rig = createSubmitRig({ git: null, team: null })
  seedRunningTask(rig, runningWorktreeTask())
  const snapshot = await rig.action('board')
  check('without git the worktree view degrades readably', snapshot.worktrees.available === false && snapshot.worktrees.error === 'no-git-service' && snapshot.worktrees.total === 0, JSON.stringify(snapshot.worktrees))
  check('without a Team the agent view degrades readably', snapshot.workers.error === 'no-team-service' && snapshot.agents.lead === null && snapshot.agents.members.length === 0 && snapshot.agents.kinds.lead === 0, JSON.stringify(snapshot.agents))
  check('without an activity ring the snapshot says so', snapshot.activity.available === false && snapshot.activity.entries.length === 0, JSON.stringify(snapshot.activity))
}

surface.dispose()
rig.scheduler.dispose()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)