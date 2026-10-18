// HTTP route tests: the GUI's contract, its transport hardening and the fact
// that it calls the same actions as the tool.

import { join } from 'node:path'
import { registerTaskRoutes, STATE_PATH, ACTION_PATH } from '../../plugin/task-center/routes.mjs'
import { createFakeFs, createRig, createTeam, PROJECT, seedBoard } from './support/fixtures.mjs'
import { createGit } from '../../plugin/task-center/git.mjs'
import { createState } from '../../plugin/task-center/state.mjs'
import { createDispatcher } from '../../plugin/task-center/dispatch.mjs'
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
  const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: false, git: opts.git })
  const api = createApi(ctx, { state: state, scheduler: scheduler, git: opts.git, merger: opts.merger })
  return { project: PROJECT, fs: fs, ctx: ctx, state: state, scheduler: scheduler, api: api, team: team }
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
      status: 'done',
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
  check('rejection touches no git checkout', fake.calls.length === 0, JSON.stringify(fake.calls.map((entry) => entry.args)))
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
  check('a task that is not done cannot be merged', res.json().ok === false && res.json().code === 'not-done', res.text)
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
  check('submit still succeeds with a merger in the team', payload.ok === true && payload.task.status === 'done' && payload.task.merge.status === 'open', res.text)
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
    res.json().ok === true && res.json().task.status === 'done' && res.json().task.merge.status === 'open',
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
  check('the brief says submit is the last step', /submit is your LAST step/i.test(text), text.slice(0, 400))
  check('and warns against committing after it', /do not commit again/i.test(text), text.slice(0, 400))
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
    ctx.fake.calls.every((entry) => entry.args[0] === 'rev-parse' || entry.args[0] === 'diff'),
    JSON.stringify(ctx.fake.calls.map((entry) => entry.args)),
  )
  // The refreshed head is now mergeable.
  const merged = await postTo(ctx.surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('after a refresh the merge succeeds', merged.json().ok === true && merged.json().task.merge.status === 'merged', merged.text)
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
  check('only a done task has a request to refresh', notDone.json().ok === false && notDone.json().code === 'not-done', notDone.text)
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
  const merged = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  check('the refreshed request merges', merged.json().ok === true && merged.json().task.merge.status === 'merged', merged.text)
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

surface.dispose()
rig.scheduler.dispose()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)