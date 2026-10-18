// HTTP route tests: the GUI's contract, its transport hardening and the fact
// that it calls the same actions as the tool.

import { join } from 'node:path'
import { registerTaskRoutes, STATE_PATH, ACTION_PATH } from '../../plugin/task-center/routes.mjs'
import { createFakeFs, createRig, PROJECT, seedBoard } from './support/fixtures.mjs'
import { createGit } from '../../plugin/task-center/git.mjs'
import { createState } from '../../plugin/task-center/state.mjs'
import { createDispatcher } from '../../plugin/task-center/dispatch.mjs'
import { createApi } from '../../plugin/task-center/api.mjs'

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
  const ctx = {
    fs: fs,
    sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
    get() {
      return undefined
    },
  }
  const state = createState(ctx)
  const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: false, git: opts.git })
  const api = createApi(ctx, { state: state, scheduler: scheduler, git: opts.git })
  return { project: PROJECT, fs: fs, ctx: ctx, state: state, scheduler: scheduler, api: api }
}

/** A fake git for commit/diff; every call is recorded, no process is started. */
function fakeGit(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  const run = (args, cwd) => {
    calls.push({ args: args.slice(), cwd: cwd })
    const key = args.join(' ')
    if (key === 'rev-parse HEAD') return { code: 0, stdout: String(opts.head === undefined ? 'head-sha' : opts.head) + '\n', stderr: '' }
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
  check('submit succeeds in the task worktree without any Team service', payload.ok === true && payload.task.status === 'done', res.text)
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
  check('a task without a worktree submits without a merge request', payload.ok === true && payload.task.status === 'done', res.text)
  check(
    'and records no commit, actual files or merge',
    payload.task.commit === null && payload.task.merge === null && payload.task.actualFiles.length === 0,
    JSON.stringify({ commit: payload.task.commit, merge: payload.task.merge, actualFiles: payload.task.actualFiles }),
  )
  check('and git is never consulted', fake.calls.length === 0, JSON.stringify(fake.calls))
  submitSurface.dispose()
  submitRig.scheduler.dispose()
}

surface.dispose()
rig.scheduler.dispose()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)