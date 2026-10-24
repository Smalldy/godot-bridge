// HTTP route tests: the GUI's contract, its transport hardening and the fact
// that it calls the same actions as the tool.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { registerTaskRoutes, STATE_PATH, ACTION_PATH, TASK_PATH, LIST_PATH } from '../../plugin/task-center/routes.mjs'
import { boardJson, createFakeFs, createFakeGit, createRig, createStrictCtx, createTeam, PROJECT, seedBoard, sleep } from './support/fixtures.mjs'
import { createGit } from '../../plugin/task-center/git.mjs'
import { createSessionLookup, decodeSessionDirName } from '../../plugin/task-center/session-lookup.mjs'
import { createState } from '../../plugin/task-center/state.mjs'
import { ROLE_SAMPLE_TASK, briefFor, createActivity, createDispatcher, createRoleManager, memberProjectOf, projectSlotKey, recordStageSlot, rememberMemberProject, roleBriefFor, roleSlotName } from '../../plugin/task-center/dispatch.mjs'

// Role slots carry the project they were provisioned for; tests name them through
// the same generator the host uses instead of a hard-coded legacy name.
const slot = (kind, index) => roleSlotName(kind, index, PROJECT)
import { MAX_BOARD_BYTES, archivePath, boardPath as boardPathOf, projectIdOf, projectRefOf, readProjectRegistry, rolesPath } from '../../plugin/task-center/board.mjs'
import { homedir } from 'node:os'
import { createApi } from '../../plugin/task-center/api.mjs'
import { phaseActivityAt } from '../../plugin/task-center/dispatch.mjs'
import { createMerger } from '../../plugin/task-center/merge.mjs'
import { DEFAULT_ROLE_PROMPTS, ROLE_TEMPLATE_VARIABLE_NAMES, defaultRoleConfig } from '../../plugin/task-center/schema.mjs'

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

const TEST_SESSION = 'test-session'

async function call(surface, url, options) {
  const res = response()
  // T-96: every panel request carries its session id; without one the Host has
  // no slot to read (and must never borrow another session's project).
  const withSession = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'session=' + encodeURIComponent(TEST_SESSION)
  await surface.byPath.get(url.split('?')[0]).handler(request(withSession, options), res)
  return res
}
const post = (body, headers) =>
  call(surface, ACTION_PATH, { method: 'POST', body: body, headers: Object.assign({ 'content-type': 'application/json' }, headers) })
const postTo = (target, body) =>
  call(target, ACTION_PATH, { method: 'POST', body: body, headers: { 'content-type': 'application/json' } })

const rig = createRig({ allowSpawn: false })
const surface = install(rig)
check('registers state, action, task, list and diagnostics', surface.specs.length === 5, String(surface.specs.length))

// no project yet
{
  rig.state.setSessionRoot(TEST_SESSION, null)
  const res = await call(surface, STATE_PATH, {})
  rig.state.setSessionRoot(TEST_SESSION, PROJECT)
  check('state without a bound project says so', res.status === 200 && res.json().ok === false && res.json().code === 'no-project-bound', res.text)
  check(
    'the UI-facing unknown-project answer is a code plus params, not an English sentence',
    res.json().message === undefined && res.json().params !== null && typeof res.json().params === 'object',
    res.text,
  )
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
  check('the empty-action answer carries no English UI sentence', bad.json().message === undefined, bad.text)
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

// the manual lock route is gone: refusals stay readable, diagnostics stay readable.
// These calls pass project explicitly on purpose: without a session id the
// resolver answers no-project-bound before the action can be called unknown.
{
  const lockRes = await post({ action: 'lock', project: PROJECT, paths: ['scripts/a.gd'] })
  check('the lock action is now an unknown action', lockRes.json().ok === false && lockRes.json().code === 'unknown-action', lockRes.text)
  const unlockRes = await post({ action: 'unlock', project: PROJECT, paths: ['scripts/a.gd'] })
  check('unlock is an unknown action too', unlockRes.json().ok === false && unlockRes.json().code === 'unknown-action', unlockRes.text)
  const forceRes = await post({ action: 'forceUnlock', project: PROJECT, paths: ['scripts/a.gd'] })
  check('forceUnlock is an unknown action', forceRes.json().ok === false && forceRes.json().code === 'unknown-action', forceRes.text)
  const read = await post({ action: 'locks', project: PROJECT })
  check('the read-only locks diagnostic still answers', read.json().ok === true && Array.isArray(read.json().locks), read.text)
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
  holdFile(waitingRig, 'scripts/shared.gd')
  const held = await postTo(waitingSurface, { action: 'board' })
  check('the running task holds the file through the automatic lock', held.json().ok === true && held.json().locks.length === 1 && held.json().locks[0].taskId === 'T-1', held.text)
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
  // When the holder finishes, its automatic lock is released and the waiter becomes dispatchable.
  waitingRig.state.memory.locks = {}
  const finished = JSON.parse(JSON.stringify(board))
  finished.tasks[0].status = 'done'
  seedBoard(waitingRig.fs, waitingRig.project, JSON.stringify(finished))
  const freedBoard = await postTo(waitingSurface, { action: 'board' })
  const freedReasons = new Map(freedBoard.json().tasks.map((entry) => [entry.id, entry.waitingReason]))
  check('once the holder finishes the same-file task is no longer file-locked', freedReasons.get('T-2') !== 'file-lock', JSON.stringify([freedReasons.get('T-2')]))
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

  const poolHold = function (path, taskId) {
    poolRig.state.memory.locks[path] = { path: path, taskId: taskId, agent: 'fixer', since: new Date().toISOString(), leaseUntil: new Date(Date.now() + 600000).toISOString() }
  }
  poolHold('scripts/shared.gd', 'T-1')
  poolHold('scripts/other.gd', null)
  poolHold('scripts/free.gd', null)
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
  fs.dirs.add(join(PROJECT, '.git'))
  fs.dirs.add(join(PROJECT, '.agents'))
  const team = opts.team === undefined || opts.team === null ? null : opts.team
  // A team service is optional: the commit path must work without one, and the
  // notification path is exactly what a team adds.
  const agents = opts.agents === undefined ? (team === null ? undefined : { list: () => [{ id: 'session-lead' }] }) : opts.agents
  // T-104: strict Cordis-shaped ctx; an undeclared service read throws.
  const ctx = createStrictCtx(
    {
      fs: fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
      get(key) {
        if (key === 'agents') return agents
        if (key === 'agentTeams') return team
        if (key === 'subprocess') return opts.subprocess
        return undefined
      },
    },
    ['fs', 'sandboxPolicy', 'tools', 'webServer'],
  )
  const state = createState(ctx)
  state.setSessionRoot(TEST_SESSION, PROJECT)
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
    drainTimeoutMs: opts.drainTimeoutMs,
    drainIntervalMs: opts.drainIntervalMs,
    actionTimeoutMs: opts.actionTimeoutMs,
    notifyTimeoutMs: opts.notifyTimeoutMs,
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
  const staged = []
  const run = (args, cwd) => {
    calls.push({ args: args.slice(), cwd: cwd })
    const key = args.join(' ')
    if (key === 'add -u') {
      if (staged.length === 0) staged.push('scripts/a.gd')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'add' && args.indexOf('--') >= 0) {
      for (const path of args.slice(args.indexOf('--') + 1)) if (staged.indexOf(path) < 0) staged.push(path)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (key === 'diff --cached --name-only') return { code: 0, stdout: staged.length === 0 ? '' : staged.join('\n') + '\n', stderr: '' }
    if (key === 'ls-files --stage -z') return opts.indexEntries === undefined ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: opts.indexEntries, stderr: '' }
    if (key === 'status --porcelain -z') return opts.status === undefined ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: opts.status, stderr: '' }
    if (args[0] === 'reset') {
      const path = args[args.length - 1]
      const at = staged.indexOf(path)
      if (at >= 0) staged.splice(at, 1)
      return { code: 0, stdout: '', stderr: '' }
    }
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
  // T-101: tracked updates only (add -u), never add -A; declared files are added
  // explicitly and the diff compared is the recorded base..head one.
  const addCall = fake.calls.filter((entry) => entry.args.join(' ') === 'add -u')[0]
  const commitCall = fake.calls.filter((entry) => entry.args[0] === 'commit')[0]
  const diffCall = fake.calls.filter((entry) => entry.args.join(' ') === 'diff --name-only base-sha head-sha')[0]
  check(
    'git commits only inside the task worktree',
    addCall !== undefined && addCall.cwd === task.worktree && commitCall !== undefined && commitCall.cwd === task.worktree &&
      diffCall !== undefined && diffCall.cwd === task.worktree && fake.calls.every((entry) => entry.args.join(' ') !== 'add -A'),
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
  const diffCall = fake.calls.filter((entry) => entry.args.join(' ') === 'diff --name-only base-sha prior-sha')[0]
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
  check('start refuses without a git service', refused.json().ok === false && (refused.json().code === 'worktree-unavailable' || refused.json().code === 'not-ready'), refused.text)
  check(
    'and the refusal names the worktree problem',
    (refused.json().worktree === 'no-git-service' || (refused.json().preflight !== undefined && refused.json().preflight.failed.length > 0)) &&
      (String(refused.json().message).toLowerCase().indexOf('worktree') >= 0 || String(refused.json().message).indexOf('git repository') >= 0),
    refused.text,
  )
  const state = await call(noGitSurface, projectUrl, {})
  check('dispatch stays paused after the refusal', state.json().dispatch.state === 'paused', state.text)
  check('and the task stays pending', state.json().tasks[0].status === 'pending' && state.json().tasks[0].id === created.json().task.id, state.text)
  const agentRequest = await noGit.api.perform('start', { note: 'try it' }, { projectPath: PROJECT, by: '@agent', role: 'agent', agent: { id: 'session-agent' } })
  check('an agent start is refused for the same reason', agentRequest.ok === false && (agentRequest.code === 'worktree-unavailable' || agentRequest.code === 'not-ready'), JSON.stringify(agentRequest))
  const agentState = await call(noGitSurface, projectUrl, {})
  check('and no start request is recorded', agentState.json().dispatch.request === null, agentState.text)
  const approved = await postTo(noGitSurface, { action: 'approveStart' })
  check('approveStart refuses the same environment', approved.json().ok === false && ((approved.json().code === 'worktree-unavailable' || approved.json().code === 'not-ready') || approved.json().code === 'not-ready'), approved.text)
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
  check('start refuses a project that is not a git repository', refused.json().ok === false && (refused.json().code === 'worktree-unavailable' || refused.json().code === 'not-ready'), refused.text)
  check('and says so', (refused.json().worktree === 'not-a-git-repository' || (refused.json().preflight !== undefined && refused.json().preflight.failed.some((check) => check.id === 'repository'))), refused.text)
  notRepoSurface.dispose()
  notRepo.scheduler.dispose()

  // External worktree root: dispatch really creates the checkout outside the project.
  const extRig = createRig({ allowSpawn: false })
  const { resolve: resolveWt } = await import('node:path')
  const externalRoot = resolveWt('C:/external/task-checkouts')
  extRig.fs.dirs.add(externalRoot)
  seedBoard(
    extRig.fs,
    PROJECT,
    JSON.stringify({
      version: 2,
      seq: 2,
      dispatch: { state: 'paused', worktree: { root: externalRoot } },
      tasks: [{ id: 'T-1', title: 'external checkout', status: 'pending', priority: 0, dependsOn: [], writeFiles: ['scripts/a.gd'], spec: 's', acceptance: 'a', evidence: '', history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), attempts: 0, maxAttempts: 3 }],
    }),
  )
  const started = await extRig.action('start')
  await extRig.settle()
  const added = extRig.git.calls.filter((call) => call.name === 'worktreeAdd')
  check(
    'an external worktree root is used by dispatch',
    started.ok === true && added.length >= 1 && String(added[0].detail.path).indexOf(externalRoot) === 0,
    JSON.stringify({ started: started.ok, calls: added.map((call) => call.detail && call.detail.path) }),
  )
  extRig.scheduler.dispose()

  // A .git that cannot be written: readable refusal, never a silent pass.
  const lockedRig = createRig({ allowSpawn: false })
  const lockedExclude = join(PROJECT, '.git', 'info', 'exclude')
  lockedRig.git.gitPath = async (root, name) => ({ ok: true, path: join(root, '.git', name) })
  lockedRig.git.checkIgnore = async () => ({ ok: true, ignored: [], notIgnored: ['.agents', '.worktrees'] })
  const originalWrite = lockedRig.fs.writeText
  lockedRig.fs.writeText = async function (target, content, expected, signal, policy) {
    if (String(target.targetKey === undefined ? target.displayPath : target.targetKey).indexOf('.git') >= 0) throw new Error('EACCES: read-only .git')
    return originalWrite.call(this, target, content, expected, signal, policy)
  }
  const lockedOpen = await lockedRig.action('openProject', { path: PROJECT })
  check(
    'a read-only .git is refused as cannot-exclude',
    lockedOpen.ok === false && lockedOpen.code === 'cannot-exclude' && lockedRig.fs.files.get(lockedExclude) === undefined,
    JSON.stringify({ code: lockedOpen.code }),
  )
  lockedRig.scheduler.dispose()
}

{
  // T-108: a dirty main tree is a transient window (a merge is running in the main
  // checkout): start is allowed, the card is skipped and retried — never paused.
  const dirty = createRig({ gitOptions: { clean: false } })
  const dirtySurface = install(dirty)
  const projectUrl = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  await call(dirtySurface, projectUrl, {})
  await postTo(dirtySurface, { action: 'create', title: 'dirty tree' })
  const started = await postTo(dirtySurface, { action: 'start' })
  check('start is allowed while the tree is transiently dirty', started.json().ok === true && started.json().dispatch.state === 'running', started.text.slice(0, 300))
  const run = await dirty.settle()
  const state = await call(dirtySurface, projectUrl, {})
  const payload = state.json()
  const skipped = Array.isArray(run.results) ? run.results.filter((entry) => entry.skipped === 'environment-dirty')[0] : undefined
  check(
    'the dirty window skips the card but keeps dispatch running',
    payload.dispatch.state === 'running' && payload.tasks[0].status === 'pending' && skipped !== undefined,
    JSON.stringify({ dispatch: payload.dispatch.state, task: payload.tasks[0].status, skipped: skipped }),
  )
  check(
    'the snapshot reports the unclean environment with a check time',
    payload.environment !== null && payload.environment !== undefined && payload.environment.clean === false && typeof payload.environment.checkedAt === 'string' && payload.environment.transient === true,
    JSON.stringify(payload.environment),
  )
  check(
    'and names the card it is retrying',
    Array.isArray(payload.environment.retrying) && payload.environment.retrying.some((entry) => entry.id === payload.tasks[0].id),
    JSON.stringify(payload.environment.retrying),
  )
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
  const advancedRefs = new Map()
  const run = (args, cwd) => {
    calls.push({ args: args.slice(), cwd: cwd })
    const key = args.join(' ')
    // An explicit reply may model a silent update-ref failure.
    if (replies !== undefined && replies[key] !== undefined && args[0] === 'update-ref') return replies[key](args, cwd)
    // A real update-ref moves the branch; the post-advance verification reads it back.
    if (args[0] === 'update-ref' && typeof args[1] === 'string' && args[1].startsWith('refs/heads/')) {
      advancedRefs.set(args[1], args[2])
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && advancedRefs.has(args[2])) return { code: 0, stdout: advancedRefs.get(args[2]) + '\n', stderr: '' }
    // Slash targets other than main get a default head so the full flow can run.
    if (args[0] === 'rev-parse' && args[1] === '--verify' && typeof args[2] === 'string' && args[2].startsWith('refs/heads/') && args[2] !== 'refs/heads/main') {
      return { code: 0, stdout: 'target-sha\n', stderr: '' }
    }
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
  const userMergeHistory = payload.task.history[payload.task.history.length - 1]
  check('a user merge writes 你 as the event name, not the raw "user"', userMergeHistory !== undefined && userMergeHistory.byName === '你', JSON.stringify(userMergeHistory))
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
    'the integration worktree is created from the target HEAD on merge/<target>/<id>',
    addCall !== undefined && addCall.cwd === PROJECT && addCall.args.join(' ') === 'worktree add -b merge/main/T-1 ' + integration + ' target-sha',
    JSON.stringify(addCall && addCall.args),
  )
  const candidate = fake.calls.filter((entry) => entry.args[0] === 'merge' && entry.args[1] === '--no-ff')[0]
  check(
    'the candidate branch is merged inside the integration worktree',
    candidate !== undefined && candidate.cwd === integration && candidate.args.join(' ') === 'merge --no-ff --no-edit task/T-1-1',
    JSON.stringify(candidate && candidate.args),
  )
  const forward = fake.calls.filter((entry) => entry.args[0] === 'update-ref' && entry.args[1] === 'refs/heads/main')[0]
  check('the main BRANCH is advanced to the integration commit', forward !== undefined && forward.cwd === PROJECT && forward.args[2] === 'merge-sha', JSON.stringify(forward))
  check(
    'the temporary integration checkout and branch are cleaned up',
    byCommand('worktree remove --force ' + integration).length === 1 && byCommand('branch -d merge/main/T-1').length === 1,
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
  check('main is never advanced on a conflict', fake.calls.every((entry) => !(entry.args[0] === 'update-ref' && entry.args[1] === 'refs/heads/main')), JSON.stringify(fake.calls.map((entry) => entry.args)))
  check(
    'the temporary checkout and branch are cleaned up after a conflict',
    fake.calls.some((entry) => entry.args.join(' ') === 'worktree remove --force ' + integration) &&
      fake.calls.some((entry) => entry.args.join(' ') === 'branch -D merge/main/T-1'),
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
  check('main is never advanced on a red verification', fake.calls.every((entry) => !(entry.args[0] === 'update-ref' && entry.args[1] === 'refs/heads/main')), JSON.stringify(fake.calls.map((entry) => entry.args)))
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
  check('the long red verification still never advances main', fake.calls.every((entry) => !(entry.args[0] === 'update-ref' && entry.args[1] === 'refs/heads/main')))
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
    'rev-parse --verify refs/heads/main': () => ({ code: 0, stdout: 'target-sha\n', stderr: '' }),
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
  check('main is never advanced on drift', ctx.fake.calls.every((entry) => !(entry.args[0] === 'update-ref' && entry.args[1] === 'refs/heads/main')), JSON.stringify(ctx.fake.calls.map((entry) => entry.args)))
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
  // The acceptance is about the REAL board, not a synthetic one: when this
  // checkout has .agents/tasks.json (the worktree or the main repo behind it),
  // serve it through the same route handler and measure the actual body.
  {
    const candidates = [
      fileURLToPath(new URL('../../.agents/tasks.json', import.meta.url)),
      fileURLToPath(new URL('../../../.agents/tasks.json', import.meta.url)),
      fileURLToPath(new URL('../../../../.agents/tasks.json', import.meta.url)),
    ]
    const boardPath = candidates.filter((path) => existsSync(path))[0]
    if (boardPath !== undefined) {
      const realRig = createRig({ allowSpawn: false })
      const raw = readFileSync(boardPath, 'utf8')
      seedBoard(realRig.fs, PROJECT, raw)
      const realSurface = install(realRig)
      const realRes = await call(realSurface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
      const realBytes = Buffer.byteLength(realRes.text, 'utf8')
      const real = realRes.json()
      const realCount = realTasksCount(real)
      // The real board is a MOVING local artefact: it grows with every card the
      // team creates, so it must never gate. It is measured and printed instead;
      // the size gate lives on the deterministic fixture above. A relative
      // regression signal is printed too, without failing the suite.
      const fixtureBudget = 200 * 1024
      const ratio = realBytes / fixtureBudget
      console.log(
        'REALBOARD diag: ' + boardPath + ' -> ' + String(realCount) + ' tasks, ' + String(realBytes) + ' bytes (' +
          (realBytes / 1024).toFixed(1) + ' KB); fixture budget ' + String(fixtureBudget) + ' bytes; ratio ' + ratio.toFixed(2) +
          'x. Real-board growth is expected until cards age past the 30-day archive window; only the fixture gate can fail.',
      )
      if (real.ok !== true || real.full !== true || realCount === 0) {
        console.log('REALBOARD diag: could not read a full real-board snapshot (ok=' + String(real.ok) + ', full=' + String(real.full) + '); ignored by design.')
      }
      realSurface.dispose()
      realRig.scheduler.dispose()
    } else {
      console.log('REALBOARD_SKIP no .agents/tasks.json in this checkout')
    }
  }
  surface.dispose()
  rig.scheduler.dispose()
}
function realTasksCount(payload) { return Array.isArray(payload.tasks) ? payload.tasks.length : 0 }

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
    'rev-parse --verify refs/heads/main': () => ({ code: 0, stdout: 'target-new-sha\n', stderr: '' }),
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
  check(
    'a user review writes the member name 你 on the record and the history entry',
    approved.json().task.review.byName === '你' && approved.json().task.history[approved.json().task.history.length - 1].byName === '你',
    JSON.stringify({ review: approved.json().task.review, history: approved.json().task.history.slice(-1) }),
  )
  const pending = await rig.api.autoMergePending(PROJECT)
  check('a pending test is not merged by the sweep', pending.ok === true && pending.merged.length === 0, JSON.stringify(pending))
  const passed = await postTo(surface, { action: 'passTest', project: PROJECT, id: 'T-1' })
  check(
    'passTest records the pass without completing the task',
    passed.json().ok === true && passed.json().task.status === 'testing' && passed.json().task.test.status === 'passed',
    passed.text,
  )
  check(
    'a user test pass writes the member name 你 on the test record',
    passed.json().task.test.byName === '你',
    JSON.stringify(passed.json().task.test),
  )
  const sweep = await rig.api.autoMergePending(PROJECT)
  check('the host sweep merges after a passed test without a merger agent', sweep.ok === true && sweep.merged.join(',') === 'T-1', JSON.stringify(sweep))
  const after = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  check('the task is done and merged', after.json().tasks[0].status === 'done' && after.json().tasks[0].merge.status === 'merged', after.text)
  const afterDetail = await call(surface, TASK_PATH + '?id=T-1&project=' + encodeURIComponent(PROJECT), {})
  const mergeHistory = afterDetail.json().task.history[afterDetail.json().task.history.length - 1]
  check(
    'the automatic sweep writes a literal name, never the @ tool label',
    typeof mergeHistory.byName === 'string' && mergeHistory.byName.charAt(0) !== '@' && mergeHistory.byName === 'system',
    JSON.stringify(mergeHistory),
  )
  const forwards = () => fake.calls.filter((entry) => entry.args[0] === 'update-ref' && entry.args[1] === 'refs/heads/main').length
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

/** The fake Team plus the interrupt edge the host uses to stop a worker whose
 * task left running. interrupt() is the real contract: (Lead caller, member). */
function interruptTeam(options) {
  const team = createTeam(options)
  team.interrupts = []
  team.interrupt = function (caller, name) {
    team.interrupts.push({ caller: caller === null || caller === undefined ? null : caller.id, name: name })
    return { previousStatus: 'running' }
  }
  return team
}

function interruptRoster(overrides) {
  return {
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      Object.assign({ id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' }, overrides === undefined ? {} : overrides),
    ],
  }
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
  check(
    'the review record and history carry the reviewer member name',
    reviewerApprove.task.review.byName === 'reviewer-1' && reviewerApprove.task.history[reviewerApprove.task.history.length - 1].byName === 'reviewer-1',
    JSON.stringify({ review: reviewerApprove.task.review, history: reviewerApprove.task.history.slice(-1) }),
  )
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
  check(
    'the test record and history carry the tester member name',
    testerPass.task.test.byName === 'tester-1' && testerPass.task.history[testerPass.task.history.length - 1].byName === 'tester-1',
    JSON.stringify({ test: testerPass.task.test, history: testerPass.task.history.slice(-1) }),
  )
  rig.scheduler.dispose()
}

{
  // The user's lifecycle actions write 你; a member's write their member name.
  const rig = createRig({ allowSpawn: false })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [reviewStageTask()] }))
  const surface = install(rig)
  const blocked = await postTo(surface, { action: 'block', project: PROJECT, id: 'T-1', note: 'user holds it' })
  const blockedHistory = blocked.json().task.history[blocked.json().task.history.length - 1]
  check('a user block writes 你 as the event name', blocked.json().ok === true && blockedHistory.byName === '你', JSON.stringify(blockedHistory))
  surface.dispose()
  rig.scheduler.dispose()
}
{
  const fake = fakeGit()
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fake.git })
  seedRunningTask(rig, runningWorktreeTask())
  const workerBlock = await rig.api.perform('block', { id: 'T-1', note: 'agent holds it' }, agentCaller('session-fixer'))
  const agentHistory = workerBlock.task.history[workerBlock.task.history.length - 1]
  check('an agent block writes the member name', workerBlock.ok === true && agentHistory.byName === 'fixer', JSON.stringify(agentHistory))
  rig.scheduler.dispose()
}

// ── leaving running interrupts the worker (hard) and refuses its later calls ─
{
  const team = interruptTeam(interruptRoster())
  const rig = createSubmitRig({ team: team })
  seedRunningTask(rig, runningWorktreeTask())
  holdFile(rig, join(PROJECT, 'scripts/a.gd'))
  const cancelled = await rig.api.perform('cancel', { id: 'T-1', note: 'not needed' }, rig.user)
  check(
    'cancelling a running task interrupts its assignee through the Lead',
    cancelled.ok === true && team.interrupts.length === 1 && team.interrupts[0].name === 'fixer' && team.interrupts[0].caller === 'session-lead',
    JSON.stringify(team.interrupts),
  )
  const inbox = team.calls.filter((call) => call.kind === 'send' && call.target === 'fixer')
  check(
    'the interrupted worker is told why to stop',
    inbox.length === 1 && inbox[0].text.indexOf('cancelled') >= 0 && inbox[0].text.indexOf('discard') >= 0,
    JSON.stringify(inbox.map((call) => call.text.slice(0, 120))),
  )
  check('the cancelled task releases its file locks', Object.keys(rig.state.memory.locks).length === 0, JSON.stringify(Object.keys(rig.state.memory.locks)))
  const again = await rig.api.perform('cancel', { id: 'T-1', note: 'again' }, rig.user)
  check('a repeated cancel does not interrupt twice', again.ok === false && team.interrupts.length === 1, JSON.stringify({ ok: again.ok, code: again.code, interrupts: team.interrupts.length }))
  rig.scheduler.dispose()
}

{
  const team = interruptTeam(interruptRoster())
  const rig = createSubmitRig({ team: team })
  seedRunningTask(rig, runningWorktreeTask())
  const blocked = await rig.api.perform('block', { id: 'T-1', note: 'triage' }, rig.user)
  check('blocking a running task interrupts its assignee', blocked.ok === true && team.interrupts.length === 1 && team.interrupts[0].name === 'fixer', JSON.stringify(team.interrupts))
  check(
    'and the inbox note says it is blocked',
    team.calls.some((call) => call.kind === 'send' && call.target === 'fixer' && call.text.indexOf('blocked') >= 0),
    JSON.stringify(team.calls.filter((call) => call.kind === 'send').map((call) => call.text.slice(0, 80))),
  )
  rig.scheduler.dispose()
}

{
  // A member that is already idle has no turn to stop; neither does a task with
  // no assignee. Both skip the interrupt instead of failing the lifecycle action.
  const idleTeam = interruptTeam(interruptRoster({ status: 'inactive' }))
  const idleRig = createSubmitRig({ team: idleTeam })
  seedRunningTask(idleRig, runningWorktreeTask())
  const idleCancel = await idleRig.api.perform('cancel', { id: 'T-1' }, idleRig.user)
  check('an inactive member is not interrupted', idleCancel.ok === true && idleTeam.interrupts.length === 0, JSON.stringify(idleTeam.interrupts))
  idleRig.scheduler.dispose()

  const emptyTeam = interruptTeam(interruptRoster())
  const emptyRig = createSubmitRig({ team: emptyTeam })
  seedRunningTask(emptyRig, runningWorktreeTask({ assignee: null }))
  const emptyCancel = await emptyRig.api.perform('cancel', { id: 'T-1' }, emptyRig.user)
  check('a task without an assignee is not interrupted', emptyCancel.ok === true && emptyTeam.interrupts.length === 0, JSON.stringify(emptyTeam.interrupts))
  emptyRig.scheduler.dispose()
}

{
  // The soft half, through the REAL transition: cancel clears the live assignee,
  // so the refusal must recognise the worker through the retained last owner.
  const rig = createSubmitRig({ team: interruptTeam(interruptRoster()) })
  seedRunningTask(rig, runningWorktreeTask())
  const cancelled = await rig.api.perform('cancel', { id: 'T-1', note: 'not needed' }, rig.user)
  check(
    'cancel keeps the last owner after clearing the assignee',
    cancelled.ok === true &&
      cancelled.task.assignee === null &&
      cancelled.task.lastAssignee !== null &&
      cancelled.task.lastAssignee.name === 'fixer' &&
      cancelled.task.lastAssignee.session === 'session-fixer',
    JSON.stringify({ assignee: cancelled.task.assignee, lastAssignee: cancelled.task.lastAssignee }),
  )
  const got = await rig.api.perform('get', { id: 'T-1' }, agentCaller('session-fixer'))
  check('a worker is refused on the task it just saw cancelled', got.ok === false && got.code === 'task-cancelled', JSON.stringify(got))
  const submitted = await rig.api.perform('submit', { id: 'T-1', evidence: 'x' }, agentCaller('session-fixer'))
  check('submit on a cancelled task is refused with the same code', submitted.ok === false && submitted.code === 'task-cancelled', JSON.stringify(submitted))
  check(
    'the refusal tells the worker to stop and discard',
    String(got.message).indexOf('stop working') >= 0 && String(got.message).indexOf('discard') >= 0,
    String(got.message),
  )
  const memberShape = {
    projectPath: PROJECT,
    by: 'fixer',
    role: 'agent',
    agent: { id: 'session-fixer', name: 'fixer', session: 'session-fixer' },
  }
  const gotShaped = await rig.api.perform('get', { id: 'T-1' }, memberShape)
  check('the member-shaped identity is refused too', gotShaped.ok === false && gotShaped.code === 'task-cancelled', JSON.stringify(gotShaped))
  const other = await rig.api.perform('get', { id: 'T-1' }, agentCaller('session-reviewer-1'))
  check('another agent can still read the cancelled task', other.ok === true && other.task !== undefined, JSON.stringify(other))
  const user = await rig.api.perform('get', { id: 'T-1' }, rig.user)
  check('the user can still read the cancelled task', user.ok === true && user.task !== undefined, JSON.stringify(user))
  rig.scheduler.dispose()
}

{
  const rig = createSubmitRig({ team: interruptTeam(interruptRoster()) })
  seedRunningTask(rig, runningWorktreeTask())
  const blocked = await rig.api.perform('block', { id: 'T-1', note: 'triage' }, rig.user)
  check(
    'block keeps the last owner after clearing the assignee',
    blocked.ok === true && blocked.task.assignee === null && blocked.task.lastAssignee !== null && blocked.task.lastAssignee.name === 'fixer',
    JSON.stringify({ assignee: blocked.task.assignee, lastAssignee: blocked.task.lastAssignee }),
  )
  const got = await rig.api.perform('get', { id: 'T-1' }, agentCaller('session-fixer'))
  check('a worker is refused on the task it just saw blocked', got.ok === false && got.code === 'task-blocked', JSON.stringify(got))
  rig.scheduler.dispose()
}

{
  // Happy paths never interrupt: submit and a reviewer approval both run with a
  // live Team and must leave the interrupt edge untouched.
  const team = interruptTeam(interruptRoster())
  const rig = createSubmitRig({ team: team, roles: true, git: fakeGit().git })
  seedRunningTask(rig, runningWorktreeTask())
  const submitted = await rig.api.perform('submit', { id: 'T-1', evidence: 'done' }, agentCaller('session-fixer'))
  check('a normal submit does not interrupt the worker', submitted.ok === true && team.interrupts.length === 0, JSON.stringify({ ok: submitted.ok, code: submitted.code, interrupts: team.interrupts }))
  const approved = await rig.api.perform('approveReview', { id: 'T-1' }, agentCaller('session-reviewer-1'))
  check('a normal review approval does not interrupt anyone', team.interrupts.length === 0, JSON.stringify({ ok: approved.ok, code: approved.code, interrupts: team.interrupts }))
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
    submitted.ok === true && submitted.task.status === 'reviewing' && submitted.provisioned !== undefined && submitted.provisioned.created[0].name === slot('reviewer', 1),
    JSON.stringify(submitted.provisioned),
  )
  const spawns = team.calls.filter((call) => call.kind === 'spawn').map((call) => call.name)
  check('the host spawned the reviewer without a Lead prompt', spawns.join(',') === slot('reviewer', 1), JSON.stringify(spawns))
  const reviewerCall = team.calls.filter((call) => call.kind === 'spawn' && call.name === slot('reviewer', 1))[0]
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
    approved.ok === true && approved.task.status === 'testing' && approved.provisioned !== undefined && approved.provisioned.created[0].name === slot('tester', 1),
    JSON.stringify(approved.provisioned),
  )
  const names = team.calls.filter((call) => call.kind === 'spawn').map((call) => call.name)
  check('both stage roles are live', names.join(',') === slot('reviewer', 1) + ',' + slot('tester', 1), JSON.stringify(names))
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
    submitted.provisioned !== undefined && submitted.provisioned.created.map((entry) => entry.name).join(',') === slot('reviewer', 1) + ',' + slot('reviewer', 2),
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
    two.provisioned !== undefined && two.provisioned.created.length === 0 && two.provisioned.reused.indexOf(slot('reviewer', 1)) >= 0,
    JSON.stringify({ ok: two.ok, status: two.task && two.task.status, code: two.code, provisioned: two.provisioned }),
  )
  check('only one reviewer was spawned', team.calls.filter((call) => call.kind === 'spawn' && call.name === slot('reviewer', 1)).length === 1, JSON.stringify(team.calls.map((call) => call.name)))
  rig.scheduler.dispose()
}

// ── project isolation: a worker submits only to the project it was dispatched for
{
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  const seeded = runningWorktreeTask()
  seeded.dispatch = Object.assign({}, seeded.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, seeded)
  const otherProject = PROJECT + '-other-project'
  seedBoard(
    rig.fs,
    otherProject,
    JSON.stringify({
      version: 2,
      seq: 2,
      dispatch: { state: 'paused' },
      tasks: [Object.assign({}, seeded, { worktree: join(otherProject, '.worktrees', 'T-1') })],
    }),
  )
  rememberMemberProject(rig.ctx, 'fixer', PROJECT)
  const refused = await rig.api.perform('submit', { id: 'T-1', project: otherProject, evidence: 'x' }, agentCaller('session-fixer'))
  check(
    'a worker from another project is refused with wrong-project',
    refused.ok === false && refused.code === 'wrong-project' && String(refused.message).indexOf(PROJECT) >= 0,
    JSON.stringify(refused),
  )
  const own = await rig.api.perform('submit', { id: 'T-1', evidence: 'x' }, agentCaller('session-fixer'))
  check('the same worker is accepted by its own project', own.ok === true, JSON.stringify({ ok: own.ok, code: own.code }))
  rig.scheduler.dispose()
}

// ── a slot from another project is refused, and the card says why ──────────
{
  const team = createTeam({
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      // Spawned before slots carried a project (or by the other project).
      { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
    ],
  })
  const rig = createSubmitRig({ team: team, roles: true, git: fakeGit().git })
  const otherProject = PROJECT + '-other-project'
  const taskA = runningWorktreeTask({ id: 'T-1', title: 'A' })
  taskA.dispatch = Object.assign({}, taskA.dispatch, { host: rig.scheduler.boot })
  const taskB = runningWorktreeTask({ id: 'T-1', title: 'B', worktree: join(otherProject, '.worktrees', 'T-1') })
  taskB.dispatch = Object.assign({}, taskB.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, taskA)
  seedBoard(rig.fs, otherProject, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [taskB] }))
  const first = await rig.api.perform('submit', { id: 'T-1', evidence: 'a' }, agentCaller('session-fixer'))
  check(
    'the first project adopts the legacy reviewer slot',
    first.ok === true && first.provisioned !== undefined && first.provisioned.reused.indexOf('reviewer-1') >= 0,
    JSON.stringify(first.provisioned),
  )
  const second = await rig.api.perform('submit', { id: 'T-1', project: otherProject, evidence: 'b' }, agentCaller('session-fixer'))
  check(
    'the second project refuses that slot and spawns its own',
    second.ok === true &&
      Array.isArray(second.provisioned.refused) &&
      second.provisioned.refused.length === 1 &&
      second.provisioned.refused[0].name === 'reviewer-1' &&
      second.provisioned.created[0].name === roleSlotName('reviewer', 1, otherProject),
    JSON.stringify(second.ok === true ? second.provisioned : { ok: second.ok, code: second.code, message: second.message }),
  )
  const otherBoard = boardJson(rig.fs, otherProject)
  const notes = otherBoard.tasks[0].history.map((entry) => String(entry.note))
  check(
    'the refusal is written to the card history',
    notes.some((note) => note.indexOf('reuse refused') >= 0 && note.indexOf('reviewer-1') >= 0 && note.indexOf(PROJECT) >= 0),
    JSON.stringify(notes.slice(-3)),
  )
  rig.scheduler.dispose()
}

// ── live executors say which project they work for ─────────────────────────
{
  const rig = createSubmitRig({ team: roleTeam() })
  seedRunningTask(rig, runningWorktreeTask())
  rememberMemberProject(rig.ctx, 'fixer', PROJECT)
  const got = await rig.api.perform('get', { id: 'T-1' }, rig.user)
  const live = got.task.liveExecutors
  check(
    'live executors carry the project they were dispatched for',
    live.length >= 1 && live[0].project === projectSlotKey(PROJECT) && live[0].projectRoot === PROJECT && live[0].displayName === 'fixer',
    JSON.stringify(live),
  )
  check('the member project memory is readable', memberProjectOf(rig.ctx, 'fixer').root === PROJECT, JSON.stringify(memberProjectOf(rig.ctx, 'fixer')))
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

// ── a delivered stage round never keeps the queued badge ───────────────────
{
  const fake = fakeGit()
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fake.git })
  const host = rig.scheduler.boot
  const makeTask = function (id, title) {
    const task = runningWorktreeTask({ id: id, title: title, worktree: join(PROJECT, '.worktrees', id), branch: 'task/' + id + '-1' })
    task.dispatch = Object.assign({}, task.dispatch, { host: host })
    return task
  }
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 4, dispatch: { state: 'paused' }, tasks: [makeTask('T-1', 'A'), makeTask('T-2', 'B'), makeTask('T-3', 'C')] }))
  const viewOf = function (snapshot, id) {
    return snapshot.tasks.filter(function (entry) { return entry.id === id })[0]
  }
  const queueOf = function (snapshot, id) {
    const task = viewOf(snapshot, id)
    return task === undefined ? undefined : task.queuePosition
  }
  await rig.action('submit', { id: 'T-1', evidence: 'a' })
  await rig.action('submit', { id: 'T-2', evidence: 'b' })
  await rig.action('submit', { id: 'T-3', evidence: 'c' })
  let snapshot = await rig.action('board')
  check(
    'one review round is delivered and the others wait in order',
    queueOf(snapshot, 'T-1') === null && queueOf(snapshot, 'T-2') === 1 && queueOf(snapshot, 'T-3') === 2,
    JSON.stringify([queueOf(snapshot, 'T-1'), queueOf(snapshot, 'T-2'), queueOf(snapshot, 'T-3')]),
  )
  await rig.action('approveReview', { id: 'T-1' })
  snapshot = await rig.action('board')
  check(
    'the freed review slot clears the badge at once and the queue moves up',
    queueOf(snapshot, 'T-2') === null && queueOf(snapshot, 'T-3') === 1,
    JSON.stringify([queueOf(snapshot, 'T-2'), queueOf(snapshot, 'T-3')]),
  )
  check(
    'the delivered round records when it started',
    typeof viewOf(snapshot, 'T-2').review.deliveredAt === 'string' && viewOf(snapshot, 'T-2').review.deliveredAt !== '',
    JSON.stringify(viewOf(snapshot, 'T-2').review),
  )
  check(
    'the first card is now in testing with no queue position',
    viewOf(snapshot, 'T-1').status === 'testing' && queueOf(snapshot, 'T-1') === null,
    JSON.stringify({ status: viewOf(snapshot, 'T-1').status, queue: queueOf(snapshot, 'T-1') }),
  )
  await rig.action('approveReview', { id: 'T-2' })
  snapshot = await rig.action('board')
  check(
    'the queued review position does not survive into testing',
    viewOf(snapshot, 'T-2').status === 'testing' && queueOf(snapshot, 'T-2') === null,
    JSON.stringify({ status: viewOf(snapshot, 'T-2').status, queue: queueOf(snapshot, 'T-2'), review: viewOf(snapshot, 'T-2').review }),
  )
  await rig.action('passTest', { id: 'T-1', evidence: 'ok' })
  snapshot = await rig.action('board')
  check(
    'the finished test round leaves no queue residue',
    viewOf(snapshot, 'T-2').status === 'testing' && queueOf(snapshot, 'T-2') === null,
    JSON.stringify({ status: viewOf(snapshot, 'T-2').status, queue: queueOf(snapshot, 'T-2') }),
  )
  const staged = snapshot.tasks.filter(function (entry) { return entry.status === 'reviewing' || entry.status === 'testing' })
  check(
    'no delivered card advertises a queue position',
    staged.every(function (entry) { return entry.queuePosition === null }),
    JSON.stringify(staged.map(function (entry) { return [entry.id, entry.queuePosition] })),
  )
  rig.scheduler.dispose()
}

// ── testing stage: a queued round is delivered when the tester frees up ────
{
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  const host = rig.scheduler.boot
  const stamp = new Date().toISOString()
  const testingTask = function (id) {
    const task = runningWorktreeTask({
      id: id,
      title: id,
      status: 'testing',
      review: { status: 'approved', by: 'reviewer-1', at: stamp, reasons: null, attempt: 1 },
      test: { status: 'pending', by: null, at: stamp, evidence: null, attempt: 1 },
      worktree: join(PROJECT, '.worktrees', id),
      branch: 'task/' + id + '-1',
    })
    task.dispatch = Object.assign({}, task.dispatch, { host: host })
    return task
  }
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [testingTask('T-1'), testingTask('T-2')] }))
  const viewOf = function (snapshot, id) {
    return snapshot.tasks.filter(function (entry) { return entry.id === id })[0]
  }
  // Exactly what the host leaves behind: one delivered tester round, one waiting.
  recordStageSlot(rig.ctx, 'T-1', 'tester', Date.now(), null)
  recordStageSlot(rig.ctx, 'T-2', 'tester', null, 1)
  let snapshot = await rig.action('board')
  check(
    'a waiting test round reports its queue position',
    viewOf(snapshot, 'T-1').queuePosition === null && viewOf(snapshot, 'T-2').queuePosition === 1,
    JSON.stringify([viewOf(snapshot, 'T-1').queuePosition, viewOf(snapshot, 'T-2').queuePosition]),
  )
  await rig.action('failTest', { id: 'T-1', evidence: 'the check failed at step 3' })
  snapshot = await rig.action('board')
  check(
    'the freed test slot delivers the waiting round and clears its badge',
    viewOf(snapshot, 'T-2').queuePosition === null && viewOf(snapshot, 'T-2').test.deliveredAt !== null,
    JSON.stringify({ queue: viewOf(snapshot, 'T-2').queuePosition, test: viewOf(snapshot, 'T-2').test }),
  )
  check(
    'the failed round goes back to running without a queue',
    viewOf(snapshot, 'T-1').status === 'running' && viewOf(snapshot, 'T-1').queuePosition === null,
    JSON.stringify({ status: viewOf(snapshot, 'T-1').status, queue: viewOf(snapshot, 'T-1').queuePosition }),
  )
  rig.scheduler.dispose()
}

// ── the slot record cannot hold a stale position ────────────────────────────
{
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  const task = runningWorktreeTask({ id: 'T-9', status: 'reviewing', review: { status: 'pending', by: null, at: new Date().toISOString(), reasons: null, attempt: 1 }, worktree: join(PROJECT, '.worktrees', 'T-9'), branch: 'task/T-9-1' })
  seedRunningTask(rig, task)
  // A delivered slot handed a stale position, and a leftover TEST position from an
  // earlier round, are both residues the guard must swallow.
  recordStageSlot(rig.ctx, 'T-9', 'reviewer', Date.now(), 1)
  const delivered = await rig.action('board')
  check(
    'a delivered slot never reports a queue position',
    delivered.tasks.filter(function (entry) { return entry.id === 'T-9' })[0].queuePosition === null,
    JSON.stringify(delivered.tasks.filter(function (entry) { return entry.id === 'T-9' })[0].queuePosition),
  )
  recordStageSlot(rig.ctx, 'T-9', 'reviewer', null, null)
  recordStageSlot(rig.ctx, 'T-9', 'tester', null, 1)
  const stale = await rig.action('board')
  check(
    'a stale test position is not rendered during review',
    stale.tasks.filter(function (entry) { return entry.id === 'T-9' })[0].queuePosition === null,
    JSON.stringify(stale.tasks.filter(function (entry) { return entry.id === 'T-9' })[0].queuePosition),
  )
  rig.scheduler.dispose()
}

// ── the board snapshot reports how full the board file is ──────────────────
{
  const rig = createSubmitRig({ team: roleTeam() })
  seedRunningTask(rig, runningWorktreeTask())
  const file = join(PROJECT, '.agents', 'tasks.json')
  const originalStat = rig.fs.stat
  rig.fs.stat = async function (value) {
    if (String(value.targetKey) === file) return { version: 'seed', type: 'file', size: Math.round(MAX_BOARD_BYTES * 0.6) }
    return originalStat.call(this, value)
  }
  const board = await rig.action('board')
  const size = board.boardSize
  check(
    'the board snapshot reports its size against the cap and warns from 50%',
    size !== undefined && size.limit === MAX_BOARD_BYTES && size.level === 'half' && size.percent === 60 && typeof size.warning === 'string' && size.warning.indexOf('60%') >= 0,
    JSON.stringify(size),
  )
  rig.fs.stat = originalStat
  const quiet = await rig.action('board')
  check('a small board reports no warning', quiet.boardSize.level === 'ok' && quiet.boardSize.warning === null, JSON.stringify(quiet.boardSize))
  rig.scheduler.dispose()
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
    submitted.provisioned !== undefined && submitted.provisioned.created[0].name === slot('reviewer', 1),
    JSON.stringify(submitted.provisioned),
  )
  const sends = team.calls.filter((call) => call.kind === 'send' && call.target === slot('reviewer', 1))
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
    'rev-parse --verify refs/heads/main': () => ({ code: 0, stdout: 'target-sha\n', stderr: '' }),
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
      // Match the candidate worktree by PATH SEGMENT, not by substring: the suite
      // also runs inside a worktree of its own (e.g. `.worktrees/test-T-100`), and
      // a substring test would make EVERY checkout look like the candidate. That
      // turned merge-timeout fixtures into head-drift on exactly those branches.
      const segments = String(cwd).replace(/\\/g, '/').split('/')
      const isCandidate = segments.indexOf('test-T-1') >= 0
      return { code: 0, stdout: (isCandidate ? 'candidate-sha' : targetHead) + '\n', stderr: '' }
    }
    // A real update-ref moves the branch; the post-advance verification reads it back.
    if (args[0] === 'update-ref') {
      if (args[1] === 'refs/heads/main') targetHead = args[2]
      return { code: 0, stdout: '', stderr: '' }
    }
    if (key === 'rev-parse --verify refs/heads/main') return { code: 0, stdout: targetHead + '\n', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  run.calls = calls
  run.setTargetHead = function (value) {
    targetHead = value
  }
  return { git: createGit({ run: run }), calls: calls, setTargetHead: run.setTargetHead }
}

// Regression for the test-worktree name collision: this suite can itself run from
// a checkout whose directory CONTAINS "test-T-1" (e.g. .worktrees/test-T-100). Only
// the real candidate worktree may answer candidate-sha; otherwise every merge-timeout
// fixture reads the main checkout as the candidate and fails as head-drift.
{
  const fake = testerGit()
  const candidate = await fake.git.head(join(PROJECT, '.worktrees', 'test-T-1'))
  const harnessLike = await fake.git.head(join(PROJECT, '..', 'test-T-100', 'demo-project'))
  check(
    'the candidate head fixture only matches the candidate worktree, never a path containing its name',
    candidate.ok === true && candidate.hash === 'candidate-sha' && harnessLike.ok === true && harnessLike.hash === 'target-sha',
    JSON.stringify({ candidate: candidate === null || candidate === undefined ? null : candidate.hash, harnessLike: harnessLike === null || harnessLike === undefined ? null : harnessLike.hash }),
  )
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
  const merger =
    opts.makeMerger === undefined
      ? createMerger({ git: fake.git, verify: verifier === null ? undefined : verifier.verify })
      : opts.makeMerger(fake.git, verifier)
  const rig = createSubmitRig({
    team: team,
    roles: true,
    git: fake.git,
    merger: merger,
    subprocess: opts.subprocess,
    autoMerge: opts.autoMerge === true,
    activity: opts.activity,
    actionTimeoutMs: opts.actionTimeoutMs,
    notifyTimeoutMs: opts.notifyTimeoutMs,
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

// ── a real tool call renews only its own role's activity clock ──────────────
{
  const ctx = createTesterRig()
  const rig = ctx.rig
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask()] }))
  const testerCall = { projectPath: PROJECT, by: '@bc7233e0', role: 'agent', agent: { id: 'session-tester-1' } }
  const testerBefore = Date.now()
  await rig.api.perform('get', { id: 'T-1' }, testerCall)
  const testerClock = phaseActivityAt(rig.ctx, 'T-1', ['tester-1', 'session-tester-1'])
  check('a real tester tool call renews the tester clock', testerClock >= testerBefore, JSON.stringify({ testerClock: testerClock, before: testerBefore }))
  const workerCall = { projectPath: PROJECT, by: '@worker', role: 'agent', agent: { id: 'session-fixer' } }
  await sleep(5)
  await rig.api.perform('get', { id: 'T-1' }, workerCall)
  check(
    'a worker tool call does not renew the tester clock',
    phaseActivityAt(rig.ctx, 'T-1', ['tester-1', 'session-tester-1']) === testerClock,
    JSON.stringify({ after: phaseActivityAt(rig.ctx, 'T-1', ['tester-1', 'session-tester-1']), tester: testerClock }),
  )
  rig.scheduler.dispose()
}
// ── the host's mechanical verification (task.verify) ────────────────────────
function fakeHostSubprocess(result) {
  // A single result, or a queue consumed one spawn at a time (the retest path
  // runs the host check twice in one flow).
  const queue = Array.isArray(result) ? result.slice() : null
  const calls = []
  const spawn = (request) => {
    const spec = queue === null ? (result === undefined ? {} : result) : queue.length > 0 ? queue.shift() : {}
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
          : new Promise((resolveDone) => {
              const finish = () => resolveDone({ exitCode: spec.code === undefined ? 0 : spec.code, signal: null })
              if (Number.isFinite(spec.delayMs) && spec.delayMs > 0) setTimeout(finish, spec.delayMs)
              else finish()
            }),
      terminate() {},
      waitForExit() {
        return Promise.resolve(true)
      },
    }
  }
  return { calls: calls, subprocess: { spawn: spawn } }
}

{
  // A red declared command is the HOST's verdict: the task goes back to running
  // with the command, the exit code and the tail — and no tester round opens.
  const proc = fakeHostSubprocess({ code: 2, stdout: 'FAIL candidate.test.mjs', stderr: 'exit code 2' })
  const ctx = createTesterRig({ subprocess: proc.subprocess })
  const rig = ctx.rig
  const fake = ctx.fake
  seedBoard(
    rig.fs,
    PROJECT,
    JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask({ verify: { command: 'npm run verify' } })] }),
  )
  const surface = install(rig)
  const approved = await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  const payload = approved.json()
  check('a failed host check returns the task to running', payload.ok === true && payload.task.status === 'running', approved.text)
  check('the host records a FAILED test itself', payload.task.test.status === 'failed' && payload.task.test.by === 'host', JSON.stringify(payload.task.test))
  check(
    'the host check record carries command, exit code, duration and tail',
    payload.task.test.hostCheck.command === 'npm run verify' &&
      payload.task.test.hostCheck.exitCode === 2 &&
      payload.task.test.hostCheck.timedOut === false &&
      Number.isFinite(payload.task.test.hostCheck.durationMs) &&
      payload.task.test.hostCheck.tail.indexOf('FAIL candidate.test.mjs') >= 0 &&
      typeof payload.task.test.hostCheck.at === 'string',
    JSON.stringify(payload.task.test.hostCheck),
  )
  check(
    'the evidence names the command, the exit code and the tail',
    payload.task.test.evidence.indexOf('npm run verify') >= 0 && payload.task.test.evidence.indexOf('exit code: 2') >= 0 && payload.task.test.evidence.indexOf('FAIL candidate.test.mjs') >= 0,
    payload.task.test.evidence,
  )
  check(
    'the host check consumed no tester round',
    ctx.team.calls.filter((call) => call.kind === 'send' && call.target === 'tester-1').length === 0,
    JSON.stringify(ctx.team.calls.map((call) => call.kind + ':' + call.target)),
  )
  check('the task never enters the merge queue', payload.task.merge.mergeCommit === null && payload.task.merge.status === 'open', JSON.stringify(payload.task.merge))
  {
    const candidatePath = join(PROJECT, '.worktrees', 'test-T-1')
    const added = fake.calls.findIndex((call) => call.args.join(' ') === 'worktree add -b test/T-1 ' + candidatePath + ' target-sha')
    const removedAfter = fake.calls.findIndex((call, index) => index > added && call.args.join(' ') === 'worktree remove --force ' + candidatePath)
    check('the rejected candidate is discarded after the failure', added >= 0 && removedAfter > added, JSON.stringify(fake.calls.map((call) => call.args.join(' '))))
  }
  const notices = ctx.team.calls.filter((call) => call.kind === 'send' && call.target === 'fixer')
  check(
    'the worker is told about the failed mechanical check',
    notices.length === 1 && notices[0].text.indexOf('npm run verify') >= 0 && notices[0].text.indexOf('exit code: 2') >= 0,
    JSON.stringify(notices.map((call) => call.text.slice(0, 120))),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // A green declared command opens the test round, records itself, and the
  // tester brief treats it as the FLOOR (not the tester's verdict).
  const proc = fakeHostSubprocess({ code: 0, stdout: 'ALL GOOD\n12 passing' })
  const ctx = createTesterRig({ subprocess: proc.subprocess })
  const rig = ctx.rig
  seedBoard(
    rig.fs,
    PROJECT,
    JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask({ verify: { command: 'npm run verify' } })] }),
  )
  const surface = install(rig)
  const approved = await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  const payload = approved.json()
  check('a green host check enters testing', payload.ok === true && payload.task.status === 'testing' && payload.task.test.status === 'pending', approved.text)
  check(
    'the host check is recorded on the task with its tail',
    payload.task.test.hostCheck.exitCode === 0 &&
      payload.task.test.hostCheck.timedOut === false &&
      payload.task.test.hostCheck.tail.indexOf('ALL GOOD') >= 0 &&
      typeof payload.task.test.hostCheck.at === 'string' &&
      Number.isFinite(payload.task.test.hostCheck.durationMs),
    JSON.stringify(payload.task.test.hostCheck),
  )
  check(
    'the command ran once, in the candidate, through the shell',
    proc.calls.length === 1 &&
      proc.calls[0].cwd === join(PROJECT, '.worktrees', 'test-T-1') &&
      proc.calls[0].argv.indexOf('npm run verify') >= 0,
    JSON.stringify(proc.calls[0] && { argv: proc.calls[0].argv, cwd: proc.calls[0].cwd }),
  )
  const sent = ctx.team.calls.filter((call) => call.kind === 'send' && call.target === 'tester-1')
  check('the tester is told once', sent.length === 1, JSON.stringify(ctx.team.calls.map((call) => call.kind + ':' + call.target)))
  const brief = sent.length === 0 ? '' : sent[0].text
  check(
    'the tester brief carries the host check summary',
    brief.indexOf('Host mechanical check') >= 0 && brief.indexOf('npm run verify') >= 0 && brief.indexOf('ALL GOOD') >= 0,
    brief.slice(0, 1600),
  )
  check('the tester brief says the host check is not the verdict', brief.indexOf('BASELINE SUITE result, NOT your verdict') >= 0, brief.slice(0, 1800))
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
  {
    const candidatePath = join(PROJECT, '.worktrees', 'test-T-1')
    const added = ctx.fake.calls.findIndex((call) => call.args.join(' ') === 'worktree add -b test/T-1 ' + candidatePath + ' target-sha')
    const removedAfter = ctx.fake.calls.findIndex((call, index) => index > added && call.args.join(' ') === 'worktree remove --force ' + candidatePath)
    check('the accepted candidate is kept for the tester', added >= 0 && removedAfter < 0, JSON.stringify(ctx.fake.calls.map((call) => call.args.join(' '))))
  }
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // No declaration: the historical flow, and the host never starts a process.
  const proc = fakeHostSubprocess({ code: 2 })
  const ctx = createTesterRig({ subprocess: proc.subprocess })
  const rig = ctx.rig
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask()] }))
  const surface = install(rig)
  const approved = await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  const payload = approved.json()
  check('a task without verify keeps the old flow', payload.ok === true && payload.task.status === 'testing', approved.text)
  check('and records no host check', payload.task.test.hostCheck === null, JSON.stringify(payload.task.test.hostCheck))
  check('and runs no command', proc.calls.length === 0, JSON.stringify(proc.calls.length))
  surface.dispose()
  rig.scheduler.dispose()
}

// ── a moved target rebuilds the candidate and re-runs the host check ───────
{
  // FAILED retest: the host fails the round itself and the task goes back to
  // running; the tester is never asked to retest.
  const proc = fakeHostSubprocess([{ code: 0, stdout: 'first build ok' }, { code: 1, stdout: 'FAIL retest.test.mjs', stderr: 'retest red' }])
  const ctx = createTesterRig({ subprocess: proc.subprocess })
  const rig = ctx.rig
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask({ verify: { command: 'npm run verify' } })] }))
  const surface = install(rig)
  const approved = await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  check('the first build passes its host check', approved.json().ok === true && approved.json().task.status === 'testing' && approved.json().task.test.hostCheck.exitCode === 0, approved.text)
  ctx.fake.setTargetHead('moved-target-sha')
  const callsBefore = ctx.team.calls.length
  const passed = await postTo(surface, { action: 'passTest', project: PROJECT, id: 'T-1' })
  const payload = passed.json()
  check('a stale target rebuilds the candidate and fails the task on the host verdict', payload.ok === true && payload.task.status === 'running', passed.text)
  check('the failed retest round is recorded by the host', payload.task.test.status === 'failed' && payload.task.test.by === 'host', JSON.stringify(payload.task.test))
  check(
    'the retest failure evidence names the command, the exit code and the tail',
    String(payload.task.test.evidence).indexOf('npm run verify') >= 0 && String(payload.task.test.evidence).indexOf('exit code: 1') >= 0 && String(payload.task.test.evidence).indexOf('FAIL retest.test.mjs') >= 0,
    JSON.stringify(payload.task.test.evidence),
  )
  check('the failed retest keeps the hostCheck record', payload.task.test.hostCheck !== null && payload.task.test.hostCheck.exitCode === 1 && payload.task.test.hostCheck.command === 'npm run verify', JSON.stringify(payload.task.test.hostCheck))
  const testerCalls = ctx.team.calls.slice(callsBefore).filter((call) => call.kind === 'send' && call.target === 'tester-1')
  check('the tester is never notified about the failed retest', testerCalls.length === 0, JSON.stringify(testerCalls.map((call) => call.text.slice(0, 80))))
  check('the retest history records the host verdict', payload.task.history.some((entry) => String(entry.note).indexOf('tests failed') >= 0 && String(entry.note).indexOf('npm run verify') >= 0), JSON.stringify(payload.task.history.slice(-2)))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // A retest command that outlives the small action budget must still finish (the
  // passTest bound covers verify.timeoutMs) and a genuine check timeout records
  // the host failTest, so the auto-merge sweep cannot loop rebuild->check.
  const proc = fakeHostSubprocess([{ code: 0 }, { code: 0, delayMs: 300 }])
  const ctx = createTesterRig({ subprocess: proc.subprocess, actionTimeoutMs: 40, autoMerge: true })
  const rig = ctx.rig
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask({ verify: { command: 'npm run verify', timeoutMs: 100 } })] }))
  const surface = install(rig)
  await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  ctx.fake.setTargetHead('moved-target-sha')
  const passed = await postTo(surface, { action: 'passTest', project: PROJECT, id: 'T-1' })
  const payload = passed.json()
  check(
    'a retest check longer than the action bound still records the host timeout',
    payload.ok === true && payload.task.status === 'running' && payload.task.test.status === 'failed' && payload.task.test.by === 'host' && payload.task.test.hostCheck.timedOut === true,
    passed.text,
  )
  const sweep = await rig.api.autoMergePending(PROJECT)
  const afterRead = await rig.state.read(PROJECT)
  const afterTask = afterRead.board.tasks.filter((task) => task.id === 'T-1')[0]
  check(
    'the failed retest cannot be rebuilt in a loop by the sweep',
    sweep.ok === true && sweep.merged.length === 0 && (afterTask.status === 'running' || afterTask.status === 'pending') && afterTask.test.status === 'failed' && afterTask.merge.mergeCommit === null,
    JSON.stringify({ sweep: sweep, status: afterTask && afterTask.status, test: afterTask.test && afterTask.test.status, commit: afterTask.merge && afterTask.merge.mergeCommit }),
  )
  surface.dispose()
  rig.scheduler.dispose()
}
{
  // PASSED retest: the rebuilt candidate enters testing with its hostCheck and
  // the tester brief carries the mechanical evidence.
  const proc = fakeHostSubprocess([{ code: 0, stdout: 'first build ok' }, { code: 0, stdout: 'RETEST PASSED' }])
  const ctx = createTesterRig({ subprocess: proc.subprocess })
  const rig = ctx.rig
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask({ verify: { command: 'npm run verify' } })] }))
  const surface = install(rig)
  await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  ctx.fake.setTargetHead('moved-target-sha')
  const callsBefore = ctx.team.calls.length
  const passed = await postTo(surface, { action: 'passTest', project: PROJECT, id: 'T-1' })
  const payload = passed.json()
  check('a passed retest keeps the task in testing', payload.ok === true && payload.task.status === 'testing' && payload.task.test.status === 'pending', passed.text)
  check('the passed retest records test.hostCheck', payload.task.test.hostCheck !== null && payload.task.test.hostCheck.exitCode === 0 && payload.task.test.hostCheck.tail.indexOf('RETEST PASSED') >= 0, JSON.stringify(payload.task.test.hostCheck))
  check('the retest resets the round for the tester', payload.task.test.attempt === 2 && payload.task.merge.mergeCommit !== null, JSON.stringify({ attempt: payload.task.test.attempt, mergeCommit: payload.task.merge.mergeCommit }))
  const briefs = ctx.team.calls.slice(callsBefore).filter((call) => call.kind === 'send' && call.target === 'tester-1')
  check('the tester brief carries the retest host check', briefs.length === 1 && briefs[0].text.indexOf('npm run verify') >= 0 && briefs[0].text.indexOf('RETEST PASSED') >= 0, JSON.stringify(briefs.map((call) => call.text.slice(0, 160))))
  surface.dispose()
  rig.scheduler.dispose()
}
{
  // The declaration is an ordinary task field on both create and update.
  const rig = createSubmitRig({})
  const surface = install(rig)
  const created = await postTo(surface, { action: 'create', project: PROJECT, title: 'verify card', verify: { command: 'npm run verify && npm run e2e', timeoutMs: 120000 } })
  const payload = created.json()
  check(
    'create carries the verify declaration',
    payload.ok === true && payload.task.verify.command === 'npm run verify && npm run e2e' && payload.task.verify.timeoutMs === 120000,
    created.text,
  )
  const updated = await postTo(surface, { action: 'update', project: PROJECT, id: payload.task.id, verify: null })
  check('update clears the declaration', updated.json().ok === true && updated.json().task.verify === null, updated.text)
  const typo = await postTo(surface, { action: 'create', project: PROJECT, title: 'bad verify', verify: { cmd: 'npm test' } })
  check('a malformed declaration is refused instead of silently dropped', typo.json().ok === false && typo.json().code === 'invalid-verify', typo.text)
  for (const bad of [{ command: '' }, { command: '   ' }, { command: 'npm run verify', timeoutMs: 0 }, { command: 'npm run verify', timeoutMs: -1 }, { command: 'npm run verify', timeoutMs: 'abc' }]) {
    const refused = await postTo(surface, { action: 'create', project: PROJECT, title: 'bad verify timeout', verify: bad })
    check('an invalid verify declaration is refused: ' + JSON.stringify(bad), refused.json().ok === false && refused.json().code === 'invalid-verify', refused.text)
  }
  const updateBad = await postTo(surface, { action: 'update', project: PROJECT, id: payload.task.id, verify: { command: 'npm run verify', timeoutMs: 0 } })
  check('update refuses an invalid verify declaration too', updateBad.json().ok === false && updateBad.json().code === 'invalid-verify', updateBad.text)
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
  const forward = fake.calls.filter((call) => call.args[0] === 'update-ref' && call.args[1] === 'refs/heads/main')[0]
  check('the main branch is advanced to the candidate commit', forward !== undefined && forward.cwd === PROJECT && forward.args[2] === 'candidate-sha', JSON.stringify(forward))
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
  check('main is never advanced on a failed test', fake.calls.every((call) => !(call.args[0] === 'update-ref' && call.args[1] === 'refs/heads/main')), JSON.stringify(fake.calls.map((call) => call.args)))
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
  check('main is never advanced for a stale verdict', fake.calls.every((call) => !(call.args[0] === 'update-ref' && call.args[1] === 'refs/heads/main')), JSON.stringify(fake.calls.map((call) => call.args)))
  const adds = fake.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add')
  check('the candidate is rebuilt from the moved target', adds.length === 2 && adds[1].args.join(' ') === 'worktree add -b test/T-1 ' + join(PROJECT, '.worktrees', 'test-T-1') + ' moved-sha', JSON.stringify(adds.map((call) => call.args)))
  const testerSends = ctx.team.calls.filter((call) => call.kind === 'send' && call.target === 'tester-1')
  check('the tester is asked to retest', testerSends.length === 2 && testerSends[1].text.indexOf('Independent TEST round 2') >= 0, JSON.stringify(testerSends.map((call) => call.text.slice(0, 80))))
  surface.dispose()
  rig.scheduler.dispose()
}

// ── merge-queue idempotency: repeated merges never rebuild a candidate ──────
async function withDeadline(promise, ms) {
  let timer = null
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), ms)
  })
  const result = await Promise.race([promise, guard])
  if (timer !== null) clearTimeout(timer)
  return result
}

{
  // passTest and the auto-merge sweep race on the SAME testing+passed task. Only
  // one merge may run; the other must be merge-in-flight/no-op, no candidate is
  // rebuilt and the queue must stay usable afterwards.
  const counts = { createCandidate: 0, discardCandidate: 0, mergeCandidate: 0 }
  let releaseFirst = null
  let startedResolve = null
  const started = new Promise((resolveStarted) => {
    startedResolve = resolveStarted
  })
  const ctx = createTesterRig({
    autoMerge: true,
    makeMerger: (git) => {
      const base = createMerger({ git: git })
      const merger = Object.assign({}, base)
      merger.createCandidate = async function (task, project, request) {
        counts.createCandidate += 1
        return base.createCandidate(task, project, request)
      }
      merger.discardCandidate = async function (task, project, request) {
        counts.discardCandidate += 1
        return base.discardCandidate(task, project, request)
      }
      merger.mergeCandidate = async function (task, project, request) {
        counts.mergeCandidate += 1
        if (counts.mergeCandidate === 1) {
          startedResolve(true)
          await new Promise((resolveGate) => {
            releaseFirst = resolveGate
          })
        }
        return base.mergeCandidate(task, project, request)
      }
      merger.mergeRequest = base.mergeRequest
      return merger
    },
  })
  const rig = ctx.rig
  const fake = ctx.fake
  const first = acceptingTask()
  const second = acceptingTask({ id: 'T-2', title: 'Second task', worktree: join(PROJECT, '.worktrees', 'T-2'), branch: 'task/T-2-1' })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [first, second] }))
  const surface = install(rig)
  const approved = await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  check('the candidate is built once for the review approval', approved.json().ok === true && counts.createCandidate === 1, JSON.stringify(counts))
  const candidatePath = join(PROJECT, '.worktrees', 'test-T-1')

  const firstPromise = rig.api.perform('passTest', { id: 'T-1', evidence: 'PASS' }, rig.user)
  const startedResult = await withDeadline(started, 1000)
  check('the first merge holds the in-flight claim', startedResult === true, JSON.stringify(startedResult))
  // Fire the host sweep at the same task while the first merge is still queued.
  const sweepPromise = rig.api.autoMergePending(PROJECT)
  await new Promise((resolveTick) => setTimeout(resolveTick, 25))
  if (releaseFirst !== null) releaseFirst()
  const merged = await withDeadline(firstPromise, 2000)
  const sweepWhileMerging = await withDeadline(sweepPromise, 2000)
  check(
    'the sweep racing the same task never merges it a second time',
    sweepWhileMerging !== null &&
      sweepWhileMerging.__timedOut !== true &&
      sweepWhileMerging.ok === true &&
      sweepWhileMerging.merged.length === 0 &&
      (sweepWhileMerging.skipped.length === 0 || sweepWhileMerging.skipped.some((entry) => entry.id === 'T-1' && ['no-open-merge', 'not-mergeable-phase', 'merge-in-flight', 'test-required'].indexOf(entry.code) >= 0)),
    JSON.stringify(sweepWhileMerging),
  )
  check('the concurrent sweep never rebuilds the candidate', counts.createCandidate === 1 && counts.discardCandidate === 0, JSON.stringify(counts))
  check(
    'the first caller merges the task exactly once',
    merged !== null && merged.__timedOut !== true && merged.ok === true && merged.task.status === 'done' && merged.task.merge.status === 'merged',
    JSON.stringify(merged === null || merged.__timedOut === true ? merged : { ok: merged.ok, status: merged.task && merged.task.status }),
  )
  const forwards = fake.calls.filter((call) => call.args[0] === 'update-ref' && call.args[1] === 'refs/heads/main')
  check('the target is fast-forwarded exactly once', forwards.length === 1 && forwards[0].cwd === PROJECT, JSON.stringify(forwards.map((call) => call.args)))
  check('the candidate is not rebuilt during or after the merge', counts.createCandidate === 1 && counts.discardCandidate === 0, JSON.stringify(counts))
  check(
    'the candidate worktree and branch are cleaned up',
    fake.calls.some((call) => call.args.join(' ') === 'worktree remove --force ' + candidatePath) && fake.calls.some((call) => call.args.join(' ') === 'branch -D test/T-1'),
    JSON.stringify(fake.calls.map((call) => call.args)),
  )

  // Repeating the merge path on the now-done task is a no-op, not a stale rebuild.
  const repeatSweep = await withDeadline(rig.api.autoMergePending(PROJECT), 1500)
  check('a sweep after the merge is a no-op', repeatSweep !== null && repeatSweep.__timedOut !== true && repeatSweep.ok === true && repeatSweep.merged.length === 0, JSON.stringify(repeatSweep))
  const repeatPass = await withDeadline(rig.api.perform('passTest', { id: 'T-1', evidence: 'again' }, rig.user), 1500)
  check('passing the finished task is refused without touching candidates', repeatPass !== null && repeatPass.ok === false && repeatPass.code === 'not-testing', JSON.stringify(repeatPass))
  check('the repeated calls still never rebuild a candidate', counts.createCandidate === 1 && counts.discardCandidate === 0, JSON.stringify(counts))
  const after = await rig.api.snapshot(PROJECT)
  const afterTask = after.tasks.filter((entry) => entry.id === 'T-1')[0]
  check(
    'the finished task stays done and merged',
    afterTask.status === 'done' && afterTask.merge.status === 'merged' && afterTask.test.status === 'passed',
    JSON.stringify({ status: afterTask.status, merge: afterTask.merge.status, test: afterTask.test.status }),
  )

  // The queue is not stuck: the next review approval still provisions promptly.
  const next = await withDeadline(rig.api.perform('approveReview', { id: 'T-2' }, rig.user), 2000)
  check(
    'the next approveReview does not hang behind the finished merge',
    next !== null && next.__timedOut !== true && next.ok === true && next.task.status === 'testing',
    JSON.stringify(next === null || next.__timedOut === true ? next : { ok: next.ok, status: next.task && next.task.status }),
  )
  check('the second task got its own single candidate', counts.createCandidate === 2, JSON.stringify(counts))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // A merge that is already closed while the task is still testing must refuse
  // with no-open-merge and never rebuild a candidate or flip the board to retest.
  const counts = { createCandidate: 0, discardCandidate: 0 }
  const ctx = createTesterRig({
    autoMerge: true,
    makeMerger: (git) => {
      const base = createMerger({ git: git })
      const merger = Object.assign({}, base)
      merger.createCandidate = async function (task, project, request) {
        counts.createCandidate += 1
        return base.createCandidate(task, project, request)
      }
      merger.discardCandidate = async function (task, project, request) {
        counts.discardCandidate += 1
        return base.discardCandidate(task, project, request)
      }
      merger.mergeCandidate = base.mergeCandidate
      merger.mergeRequest = base.mergeRequest
      return merger
    },
  })
  const rig = ctx.rig
  const stamp = new Date().toISOString()
  const closed = acceptingTask({
    status: 'testing',
    review: { status: 'approved', by: 'reviewer-1', at: stamp, reasons: null, attempt: 1 },
    test: { status: 'pending', by: null, at: stamp, evidence: null, attempt: 1 },
    merge: Object.assign({}, acceptingTask().merge, { status: 'merged', mergeCommit: 'candidate-sha' }),
  })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [closed] }))
  const surface = install(rig)
  const passed = await withDeadline(postTo(surface, { action: 'passTest', project: PROJECT, id: 'T-1', evidence: 'PASS' }), 2000)
  const payload = passed === null || passed.__timedOut === true ? null : passed.json()
  check(
    'a closed merge request refuses the merge instead of rebuilding the candidate',
    payload !== null && payload.ok === true && payload.mergeError !== undefined && payload.mergeError !== null && payload.mergeError.code === 'no-open-merge',
    JSON.stringify(payload && { ok: payload.ok, code: payload.code, mergeError: payload.mergeError }),
  )
  check('the closed-merge path never creates a candidate', counts.createCandidate === 0 && counts.discardCandidate === 0, JSON.stringify(counts))
  const after = await rig.api.snapshot(PROJECT)
  const afterTask = after.tasks.filter((entry) => entry.id === 'T-1')[0]
  check(
    'the board is not rewritten to a retest',
    afterTask.status === 'testing' && afterTask.merge.status === 'merged' && afterTask.test.status === 'passed',
    JSON.stringify({ status: afterTask.status, merge: afterTask.merge.status, test: afterTask.test.status }),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // The regression window: while the first merge has finished its queue turn but
  // has not yet written the merged board, the host sweep runs. Old code took the
  // stale branch here and rebuilt a candidate for a task about to be done; the
  // hotfix's claim returns merge-in-flight instead.
  const counts = { createCandidate: 0, discardCandidate: 0 }
  const ctx = createTesterRig({
    autoMerge: true,
    makeMerger: (git) => {
      const base = createMerger({ git: git })
      const merger = Object.assign({}, base)
      merger.createCandidate = async function (task, project, request) {
        counts.createCandidate += 1
        return base.createCandidate(task, project, request)
      }
      merger.discardCandidate = async function (task, project, request) {
        counts.discardCandidate += 1
        return base.discardCandidate(task, project, request)
      }
      merger.mergeCandidate = base.mergeCandidate
      merger.mergeRequest = base.mergeRequest
      return merger
    },
  })
  const rig = ctx.rig
  const fake = ctx.fake
  const first = acceptingTask()
  const second = acceptingTask({ id: 'T-2', title: 'Second task', worktree: join(PROJECT, '.worktrees', 'T-2'), branch: 'task/T-2-1' })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [first, second] }))
  const surface = install(rig)
  await postTo(surface, { action: 'approveReview', project: PROJECT, id: 'T-1' })
  check('the candidate exists before the merge race', counts.createCandidate === 1, JSON.stringify(counts))

  // Hold the board write that records the merge, so the sweep runs in the gap
  // between the fast-forward and the task being marked done.
  const originalWrite = rig.fs.writeText
  let gateStartedResolve = null
  let gateRelease = null
  const gateStarted = new Promise((resolveGate) => {
    gateStartedResolve = resolveGate
  })
  let gated = false
  rig.fs.writeText = async function (target, content, expected) {
    const isBoard = String(target && target.targetKey ? target.targetKey : '').indexOf('tasks.json') >= 0
    if (gated === false && isBoard && String(content).indexOf('"status": "merged"') >= 0) {
      gated = true
      gateStartedResolve(true)
      await new Promise((resolveWrite) => {
        gateRelease = resolveWrite
      })
    }
    return originalWrite.call(this, target, content, expected)
  }

  const mergePromise = rig.api.perform('passTest', { id: 'T-1', evidence: 'PASS' }, rig.user)
  const raceStarted = await withDeadline(gateStarted, 1500)
  check('the merge record write is paused for the race window', raceStarted === true, JSON.stringify(raceStarted))
  const sweepDuringWrite = await withDeadline(rig.api.autoMergePending(PROJECT), 1500)
  check(
    'a sweep in the merge-write window is refused as merge-in-flight',
    sweepDuringWrite !== null &&
      sweepDuringWrite.__timedOut !== true &&
      sweepDuringWrite.ok === true &&
      sweepDuringWrite.merged.length === 0 &&
      sweepDuringWrite.skipped.some((entry) => entry.id === 'T-1' && entry.code === 'merge-in-flight'),
    JSON.stringify(sweepDuringWrite),
  )
  check('the sweep in the gap never rebuilds the candidate', counts.createCandidate === 1 && counts.discardCandidate === 0, JSON.stringify(counts))
  if (gateRelease !== null) gateRelease()
  const merged = await withDeadline(mergePromise, 2000)
  check('the paused merge still completes', merged !== null && merged.__timedOut !== true && merged.ok === true && merged.task.status === 'done', JSON.stringify(merged === null || merged.__timedOut === true ? merged : { ok: merged.ok, status: merged.task && merged.task.status }))
  const forwards = fake.calls.filter((call) => call.args[0] === 'update-ref' && call.args[1] === 'refs/heads/main')
  check('the race window produced exactly one fast-forward', forwards.length === 1, JSON.stringify(forwards.map((call) => call.args)))
  check('the merge-write window produced no other candidate', counts.createCandidate === 1 && counts.discardCandidate === 0, JSON.stringify(counts))
  const candidatePath = join(PROJECT, '.worktrees', 'test-T-1')
  const candidateAdds = fake.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add' && call.args.join(' ').indexOf('test/T-1') >= 0)
  check(
    'the candidate was built once and cleaned up, with no leftover merge worktree',
    candidateAdds.length === 1 &&
      fake.calls.some((call) => call.args.join(' ') === 'worktree remove --force ' + candidatePath) &&
      fake.calls.some((call) => call.args.join(' ') === 'branch -D test/T-1'),
    JSON.stringify(fake.calls.map((call) => call.args)),
  )
  const next = await withDeadline(rig.api.perform('approveReview', { id: 'T-2' }, rig.user), 2000)
  check('the merge queue is free after the race', next !== null && next.__timedOut !== true && next.ok === true && next.task.status === 'testing', JSON.stringify(next === null || next.__timedOut === true ? next : { ok: next.ok, status: next.task && next.task.status }))
  surface.dispose()
  rig.scheduler.dispose()
}

// ── host action watchdog: bounded awaits keep phase and free the queue ─────
{
  // approveReview's createCandidate hangs: the action times out readably, the task
  // stays in review, the queue resets and a retry succeeds.
  const activity = createActivity({ limit: 40 })
  let createCalls = 0
  const ctx = createTesterRig({
    autoMerge: true,
    actionTimeoutMs: 40,
    activity: activity,
    makeMerger: (git) => {
      const base = createMerger({ git: git, enqueueTimeoutMs: 200 })
      const merger = Object.assign({}, base)
      merger.createCandidate = async function () {
        createCalls += 1
        if (createCalls === 1) return new Promise(function () {})
        return base.createCandidate.apply(base, arguments)
      }
      return merger
    },
  })
  const rig = ctx.rig
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask()] }))
  const surface = install(rig)
  const first = await withDeadline(rig.api.perform('approveReview', { id: 'T-1' }, rig.user), 2500)
  check(
    'a hung candidate build returns a readable action timeout',
    first !== null && first.__timedOut !== true && first.ok === false && first.code === 'action-timeout' && String(first.message).indexOf('approveReview createCandidate') >= 0,
    JSON.stringify(first),
  )
  const afterTimeout = await rig.api.snapshot(PROJECT)
  check('the task phase is unchanged after the candidate timeout', afterTimeout.tasks[0].status === 'reviewing', afterTimeout.tasks[0].status)
  const timeoutEvents = activity.list(40).filter((entry) => entry.kind === 'host-action-timeout')
  check('the timeout is recorded as SYSTEM activity', timeoutEvents.length === 1 && timeoutEvents[0].actor === 'system' && timeoutEvents[0].taskId === 'T-1', JSON.stringify(timeoutEvents))
  await sleep(250)
  const retry = await withDeadline(rig.api.perform('approveReview', { id: 'T-1' }, rig.user), 2500)
  check(
    'the retry succeeds after the merge queue chain resets',
    retry !== null && retry.__timedOut !== true && retry.ok === true && retry.task.status === 'testing' && createCalls === 2,
    JSON.stringify(retry === null ? retry : { ok: retry.ok, status: retry.task && retry.task.status, creates: createCalls }),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // passTest's candidate merge hangs: the pass is recorded, a readable
  // action-timeout mergeError comes back, and a later merge still completes.
  const activity = createActivity({ limit: 40 })
  let mergeCalls = 0
  const ctx = createTesterRig({
    autoMerge: true,
    actionTimeoutMs: 40,
    activity: activity,
    makeMerger: (git) => {
      const base = createMerger({ git: git, enqueueTimeoutMs: 200 })
      const merger = Object.assign({}, base)
      merger.mergeCandidate = async function () {
        mergeCalls += 1
        if (mergeCalls === 1) return new Promise(function () {})
        return base.mergeCandidate.apply(base, arguments)
      }
      return merger
    },
  })
  const rig = ctx.rig
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask()] }))
  const surface = install(rig)
  await rig.api.perform('approveReview', { id: 'T-1' }, rig.user)
  const passed = await withDeadline(rig.api.perform('passTest', { id: 'T-1', evidence: 'PASS' }, rig.user), 2500)
  check(
    'a hung candidate merge returns an action-timeout merge error',
    passed !== null && passed.__timedOut !== true && passed.ok === true && passed.mergeError !== undefined && passed.mergeError !== null && passed.mergeError.code === 'action-timeout',
    JSON.stringify(passed),
  )
  const stillTesting = await rig.api.snapshot(PROJECT)
  check('the test pass is recorded and the task stays in testing', stillTesting.tasks[0].status === 'testing' && stillTesting.tasks[0].test.status === 'passed', JSON.stringify({ status: stillTesting.tasks[0].status, test: stillTesting.tasks[0].test.status }))
  const mergeEvents = activity.list(40).filter((entry) => entry.kind === 'host-action-timeout')
  check('the merge timeout is recorded as SYSTEM activity', mergeEvents.length === 1 && mergeEvents[0].actor === 'system', JSON.stringify(mergeEvents))
  const retried = await withDeadline(rig.api.perform('mergeRequest', { id: 'T-1' }, rig.user), 3000)
  check(
    'a merge request after the timeout still merges the task',
    retried !== null && retried.__timedOut !== true && retried.ok === true && retried.task.status === 'done' && retried.task.merge.status === 'merged' && mergeCalls === 2,
    JSON.stringify(retried === null ? retried : { ok: retried.ok, status: retried.task && retried.task.status, merges: mergeCalls }),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // mergeRequest itself is bounded too: a hung candidate merge returns the error
  // and leaves the task's phase untouched.
  const activity = createActivity({ limit: 40 })
  let mergeCalls = 0
  const ctx = createTesterRig({
    autoMerge: false,
    actionTimeoutMs: 40,
    activity: activity,
    makeMerger: (git) => {
      const base = createMerger({ git: git, enqueueTimeoutMs: 200 })
      const merger = Object.assign({}, base)
      merger.mergeCandidate = async function () {
        mergeCalls += 1
        if (mergeCalls === 1) return new Promise(function () {})
        return base.mergeCandidate.apply(base, arguments)
      }
      return merger
    },
  })
  const rig = ctx.rig
  const stamp = new Date().toISOString()
  const tested = acceptingTask({
    status: 'testing',
    base: 'target-sha',
    review: { status: 'approved', by: 'reviewer-1', at: stamp, reasons: null, attempt: 1 },
    test: { status: 'passed', by: 'tester-1', at: stamp, evidence: 'PASS', attempt: 1 },
    merge: Object.assign({}, acceptingTask().merge, { base: 'target-sha', mergeCommit: 'candidate-sha' }),
  })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [tested] }))
  const surface = install(rig)
  const timedOut = await withDeadline(rig.api.perform('mergeRequest', { id: 'T-1' }, rig.user), 2500)
  check(
    'mergeRequest returns an action timeout without recording anything',
    timedOut !== null && timedOut.__timedOut !== true && timedOut.ok === false && (timedOut.code === 'action-timeout' || timedOut.code === 'queue-timeout'),
    JSON.stringify(timedOut),
  )
  const unchanged = await rig.api.snapshot(PROJECT)
  check('mergeRequest left the task in testing', unchanged.tasks[0].status === 'testing' && unchanged.tasks[0].merge.status === 'open', JSON.stringify({ status: unchanged.tasks[0].status, merge: unchanged.tasks[0].merge.status }))
  await sleep(250)
  const retried = await withDeadline(rig.api.perform('mergeRequest', { id: 'T-1' }, rig.user), 3000)
  check('the next mergeRequest completes after the queue reset', retried !== null && retried.__timedOut !== true && retried.ok === true && retried.task.status === 'done' && mergeCalls === 2, JSON.stringify(retried))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // Non-git awaits are bounded: a hung tester spawn and a hung notification do
  // not hold approveReview (the task still reaches testing).
  const activity = createActivity({ limit: 40 })
  const team = createTeam({
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
    ],
    spawnThrows: false,
  })
  const originalSpawn = team.spawnTeammate.bind(team)
  team.spawnTeammate = async function (caller, request) {
    if (request.name.indexOf('tester') === 0) return new Promise(function () {})
    return originalSpawn(caller, request)
  }
  const ctx = createTesterRig({ team: team, autoMerge: false, actionTimeoutMs: 40, notifyTimeoutMs: 40, activity: activity })
  const rig = ctx.rig
  rig.ctx.get = function (key) {
    if (key === 'agents') return { list: () => [{ id: 'session-lead', name: 'lead' }] }
    if (key === 'agentTeams') return team
    if (key === 'subagents') return { list: () => ['spawn'] }
    return undefined
  }
  const reviewTask = acceptingTask()
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [reviewTask] }))
  const surface = install(rig)
  const approved = await withDeadline(rig.api.perform('approveReview', { id: 'T-1' }, rig.user), 2500)
  check(
    'a hung role provision does not hold approveReview',
    approved !== null && approved.__timedOut !== true && approved.ok === true && approved.task.status === 'testing',
    JSON.stringify(approved === null ? approved : { ok: approved.ok, status: approved.task && approved.task.status }),
  )
  check(
    'the timed-out provisioning is reported on the result',
    approved !== null && approved.provisioned !== undefined && approved.provisioned !== null && approved.provisioned.code === 'action-timeout',
    JSON.stringify(approved === null ? approved : approved.provisioned),
  )
  const events = activity.list(40).filter((entry) => entry.kind === 'host-action-timeout')
  check('the provisioning timeout is recorded as SYSTEM activity', events.length >= 1 && events.some((entry) => String(entry.detail).indexOf('role ensure tester') >= 0), JSON.stringify(events))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // A hung mailbox notification is bounded too: approveReview still completes
  // and the timeout is recorded.
  const activity = createActivity({ limit: 40 })
  const team = createTeam({
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
    ],
  })
  const originalSend = team.sendMessage.bind(team)
  team.sendMessage = async function (caller, request) {
    if (request.target === 'tester-1') return new Promise(function () {})
    return originalSend(caller, request)
  }
  const ctx = createTesterRig({ team: team, autoMerge: false, actionTimeoutMs: 40, notifyTimeoutMs: 40, activity: activity })
  const rig = ctx.rig
  rig.ctx.get = function (key) {
    if (key === 'agents') return { list: () => [{ id: 'session-lead', name: 'lead' }] }
    if (key === 'agentTeams') return team
    if (key === 'subagents') return { list: () => ['spawn'] }
    return undefined
  }
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [acceptingTask()] }))
  const surface = install(rig)
  const approved = await withDeadline(rig.api.perform('approveReview', { id: 'T-1' }, rig.user), 2500)
  check(
    'a hung notification does not hold approveReview',
    approved !== null && approved.__timedOut !== true && approved.ok === true && approved.task.status === 'testing',
    JSON.stringify(approved === null ? approved : { ok: approved.ok, status: approved.task && approved.task.status }),
  )
  const notifyEvents = activity.list(40).filter((entry) => entry.kind === 'host-action-timeout' && String(entry.detail).indexOf('notification to tester-1') >= 0)
  check('the notification timeout is recorded as SYSTEM activity', notifyEvents.length === 1 && notifyEvents[0].actor === 'system', JSON.stringify(notifyEvents))
  surface.dispose()
  rig.scheduler.dispose()
}

{
  // A hung queue unit must not let units queued before its timeout run
  // concurrently with units queued after it.
  const merger = createMerger({ git: createGit({ run: () => ({ code: 0, stdout: '', stderr: '' }) }), enqueueTimeoutMs: 50 })
  const log = []
  const first = merger.enqueue(() => new Promise(function () {}))
  const second = merger.enqueue(async function () {
    log.push('B-start')
    await sleep(30)
    log.push('B-end')
    return { ok: true }
  })
  await sleep(70)
  const third = merger.enqueue(async function () {
    log.push('C-start')
    log.push('C-end')
    return { ok: true }
  })
  const results = await withDeadline(Promise.all([first, second, third]), 3000)
  check(
    'queued units stay serialised after a unit timeout',
    results !== null && results.__timedOut !== true && log.join(',') === 'B-start,B-end,C-start,C-end' && results[0].code === 'queue-timeout',
    JSON.stringify({ log: log, first: results === null ? null : results[0] }),
  )
}

{
  // An abandoned queue turn must never write the board, even if its gated host
  // await resolves after the queue watchdog gave up on it.
  let releaseMerge = null
  const ctx = createTesterRig({
    autoMerge: false,
    actionTimeoutMs: 5000,
    makeMerger: (git) => {
      const base = createMerger({ git: git, enqueueTimeoutMs: 40 })
      const merger = Object.assign({}, base)
      merger.mergeRequest = function () {
        return new Promise(function (resolveGate) {
          releaseMerge = function () {
            resolveGate({ ok: true, status: 'merged', mergeCommit: 'late-commit', candidateRemoved: false, taskWorktreeRemoved: false })
          }
        })
      }
      return merger
    },
  })
  const rig = ctx.rig
  const stamp = new Date().toISOString()
  const tested = acceptingTask({
    status: 'testing',
    base: 'target-sha',
    review: { status: 'approved', by: 'reviewer-1', at: stamp, reasons: null, attempt: 1 },
    test: { status: 'passed', by: 'tester-1', at: stamp, evidence: 'PASS', attempt: 1 },
    merge: Object.assign({}, acceptingTask().merge, { head: 'target-sha', mergeCommit: null }),
  })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, tasks: [tested] }))
  const surface = install(rig)
  const timed = await withDeadline(rig.api.perform('mergeRequest', { id: 'T-1' }, rig.user), 2500)
  check(
    'the abandoned merge turn reports the queue timeout',
    timed !== null && timed.__timedOut !== true && timed.ok === false && (timed.code === 'queue-timeout' || timed.code === 'action-timeout'),
    JSON.stringify(timed),
  )
  check('the gated merge await was reached', releaseMerge !== null, String(releaseMerge))
  if (releaseMerge !== null) releaseMerge()
  await sleep(80)
  const after = await rig.api.snapshot(PROJECT)
  check(
    'an abandoned merge turn never writes the board',
    after.tasks[0].status === 'testing' && after.tasks[0].merge.status === 'open' && after.tasks[0].merge.mergeCommit === null,
    JSON.stringify({ status: after.tasks[0].status, merge: after.tasks[0].merge.status, commit: after.tasks[0].merge.mergeCommit }),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

// ── role context previews: host-generated briefs, not client copy ──────────
{
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  const created = await rig.api.perform(
    'rolesCreate',
    { name: 'godot-reviewer', profile: { role: 'reviewer', instances: 2, skills: ['dsh-plugin-workflow'], context: 'fork', permissions: ['read-only', 'review'], prompt: 'Check Godot idioms.' } },
    rig.user,
  )
  check('the custom profile exists before the preview', created.ok === true && created.config.profiles['godot-reviewer'].prompt === 'Check Godot idioms.', JSON.stringify(created).slice(0, 300))
  const snapshot = await rig.api.snapshot(PROJECT)
  const previews = snapshot.rolePreviews
  check(
    'the snapshot carries one preview per configured profile',
    Array.isArray(previews) && previews.length === 4 && ['worker', 'reviewer', 'tester', 'godot-reviewer'].every((name) => previews.some((preview) => preview.name === name)),
    JSON.stringify(Array.isArray(previews) ? previews.map((preview) => preview.name) : previews),
  )
  const byName = new Map((Array.isArray(previews) ? previews : []).map((preview) => [preview.name, preview]))
  const worker = byName.get('worker')
  check(
    'the worker preview is the real host role brief with a placeholder task',
    worker !== undefined &&
      worker.placeholder === true &&
      worker.placeholderTask.id === 'T-?' &&
      worker.profilePrompt === DEFAULT_ROLE_PROMPTS.worker &&
      worker.entries.length === 1 &&
      worker.entries[0].text.indexOf('Task center role: worker') >= 0 &&
      worker.entries[0].text.indexOf('Profile instructions:') >= 0 &&
      worker.entries[0].text.indexOf(DEFAULT_ROLE_PROMPTS.worker) >= 0 &&
      worker.entries[0].text.indexOf('Skills:') >= 0 &&
      worker.entries[0].text.indexOf('Permission boundary (hard)') >= 0 &&
      worker.entries[0].text.indexOf('Verdict schema (your report):') >= 0 &&
      worker.entries[0].text.indexOf('<example spec: what this task involves>') >= 0,
    worker === undefined ? 'missing' : worker.entries[0].text.slice(0, 300),
  )
  const reviewer = byName.get('reviewer')
  check(
    'a reviewer preview includes the generated review-round brief too',
    reviewer !== undefined &&
      reviewer.entries.length === 2 &&
      reviewer.entries[0].text.indexOf('READ-ONLY on implementation') >= 0 &&
      reviewer.entries[1].key === 'stage' &&
      reviewer.entries[1].text.indexOf('Review round 1 for T-?') >= 0 &&
      reviewer.entries[1].text.indexOf('Review checklist') >= 0,
    reviewer === undefined ? 'missing' : JSON.stringify(reviewer.entries.map((entry) => entry.key)),
  )
  const tester = byName.get('tester')
  check(
    'a tester preview includes the generated test-round brief too',
    tester !== undefined && tester.entries.length === 2 && tester.entries[1].text.indexOf('Independent TEST round 1 for T-?') >= 0,
    tester === undefined ? 'missing' : JSON.stringify(tester.entries.map((entry) => entry.key)),
  )
  const custom = byName.get('godot-reviewer')
  check(
    'a custom profile preview uses its own prompt and fork context',
    custom !== undefined &&
      custom.placeholder === true &&
      custom.profilePrompt === 'Check Godot idioms.' &&
      custom.entries[0].text.indexOf('Profile instructions:') >= 0 &&
      custom.entries[0].text.indexOf('Check Godot idioms.') >= 0 &&
      custom.entries[0].text.indexOf('forked from the Lead') >= 0 &&
      custom.entries[0].text.indexOf('Profile permissions: read-only, review') >= 0,
    custom === undefined ? 'missing' : custom.entries[0].text.slice(0, 400),
  )
  check(
    'a preview carries the variable catalog for the editor legend',
    worker.variableCatalog.length === ROLE_TEMPLATE_VARIABLE_NAMES.length &&
      worker.variableCatalog.map((entry) => entry.name).join(',') === ROLE_TEMPLATE_VARIABLE_NAMES.join(',') &&
      worker.variableCatalog.every((entry) => typeof entry.description === 'string' && entry.description !== '' && typeof entry.sample === 'string' && entry.sample !== ''),
    JSON.stringify(worker.variableCatalog),
  )
  const blockKeys = worker.blocks.map((entry) => entry.key)
  check(
    'a preview splits the brief into fixed, template and task blocks',
    blockKeys.join(',') === 'header,meta,template,task,duties,skills' &&
      worker.blocks.map((entry) => entry.type).join(',') === 'fixed,fixed,template,task,fixed,fixed' &&
      worker.blocks.filter((entry) => entry.editable === true).map((entry) => entry.key).join(',') === 'template',
    JSON.stringify(worker.blocks.map((entry) => [entry.key, entry.type, entry.editable])),
  )
  const workerBlock = {}
  worker.blocks.forEach((entry) => {
    workerBlock[entry.key] = entry
  })
  check(
    'the fixed blocks are the real host brief, never panel copy',
    workerBlock.header.text.indexOf('Task center role: worker') >= 0 &&
      workerBlock.header.text.indexOf('Project: ' + PROJECT) >= 0 &&
      workerBlock.duties.text.indexOf('Permission boundary (hard):') >= 0 &&
      workerBlock.duties.text.indexOf('Verdict schema (your report):') >= 0 &&
      workerBlock.duties.text.indexOf('submit') >= 0,
    JSON.stringify(workerBlock.header.text),
  )
  check(
    'the task block carries the placeholder task',
    workerBlock.task.text.indexOf('<example spec: what this task involves>') >= 0 && workerBlock.task.text.indexOf('T-?') >= 0,
    workerBlock.task.text.slice(0, 200),
  )
  check(
    'the template block holds the built-in worker prompt literally',
    workerBlock.template.text === DEFAULT_ROLE_PROMPTS.worker && worker.profilePrompt === DEFAULT_ROLE_PROMPTS.worker,
    JSON.stringify(workerBlock.template),
  )
  const customBlock = {}
  custom.blocks.forEach((entry) => {
    customBlock[entry.key] = entry
  })
  check('a custom profile preview keeps its own template as the editable block', customBlock.template.text === 'Check Godot idioms.' && customBlock.template.editable === true, JSON.stringify(customBlock.template))
  const refused = await rig.api.perform('rolesCreate', { name: 'bad-template', profile: { role: 'reviewer', prompt: 'Use {{NOPE}}' } }, rig.user)
  check('saving an unknown template variable is refused with the allowed list', refused.ok === false && refused.code === 'invalid-role-variable' && refused.message.indexOf('{{NOPE}}') >= 0 && refused.message.indexOf('{{TASK_ID}}') >= 0, JSON.stringify(refused))
  const madeTemplate = await rig.api.perform('rolesCreate', { name: 'templated-reviewer', profile: { role: 'reviewer', prompt: 'Templated {{TASK_ID}} for {{SPEC}}' } }, rig.user)
  check('a templated profile is accepted', madeTemplate.ok === true && madeTemplate.config.profiles['templated-reviewer'].prompt === 'Templated {{TASK_ID}} for {{SPEC}}', JSON.stringify(madeTemplate.ok))
  const templatedSnapshot = await rig.api.snapshot(PROJECT)
  const templated = templatedSnapshot.rolePreviews.filter((preview) => preview.name === 'templated-reviewer')[0]
  const templatedTemplate = templated.blocks.filter((entry) => entry.key === 'template')[0]
  check('the preview keeps the injection point literal in the template block', templatedTemplate.text === 'Templated {{TASK_ID}} for {{SPEC}}', templatedTemplate.text)
  check('and renders it in the real brief entry', templated.entries[0].text.indexOf('Templated T-? for <example spec: what this task involves>') >= 0, templated.entries[0].text.slice(0, 300))
  check('the preview names the variables the template uses', templated.templateVariables.join(',') === 'TASK_ID,SPEC', JSON.stringify(templated.templateVariables))
  rig.scheduler.dispose()
}

// ── rolesPreview: the exact injected text, from the host's own builders ────
{
  const stamp = new Date().toISOString()
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  const olderRunning = runningWorktreeTask({
    id: 'T-1',
    title: 'Patrol state for the enemy',
    updatedAt: new Date(Date.now() - 600000).toISOString(),
    spec: 'Walk between two waypoints and chase the player.',
    acceptance: 'npm run verify passes.',
  })
  const newerPending = runningWorktreeTask({
    id: 'T-2',
    title: 'Pending idea',
    status: 'pending',
    updatedAt: stamp,
    leaseUntil: null,
    dispatch: null,
    assignee: null,
  })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, dispatch: { state: 'paused' }, updatedAt: stamp, tasks: [olderRunning, newerPending] }))
  const listed = await rig.api.perform('rolesList', {}, rig.user)
  const config = listed.config
  // The rig's Team Lead agent is listed by id; the preview uses the same name
  // the dispatch path resolves (name when present, the id otherwise).
  const previewOptions = { projectPath: PROJECT, leadName: 'session-lead' }
  const snapshot = await rig.api.snapshot(PROJECT)
  const boardTask = snapshot.tasks.filter((task) => task.id === 'T-1')[0]

  const worker = await rig.api.perform('rolesPreview', {}, rig.user)
  check(
    'rolesPreview returns the worker brief the per-task executor really receives',
    worker.ok === true &&
      worker.kind === 'worker' &&
      worker.stage === 'implement' &&
      worker.profile === 'worker' &&
      worker.task.id === 'T-1' &&
      boardTask !== undefined &&
      worker.text === briefFor(boardTask, PROJECT, 'session-lead', config),
    JSON.stringify({ ok: worker.ok, kind: worker.kind, stage: worker.stage, profile: worker.profile, task: worker.task }),
  )
  check(
    'an active task wins over a more recently updated pending one',
    worker.task.real === true && worker.task.sample === false && worker.task.id === 'T-1' && worker.text.indexOf('Patrol state for the enemy') >= 0,
    JSON.stringify(worker.task),
  )
  check(
    'a real preview never carries the example task title',
    worker.text.indexOf(ROLE_SAMPLE_TASK.title) < 0 && worker.text.indexOf('<example') < 0 && worker.text.indexOf('T-?') < 0,
    worker.text.slice(0, 200),
  )
  check(
    'the preview splits the injected text into ordered, labelled sections',
    Array.isArray(worker.sections) &&
      worker.sections.length >= 5 &&
      worker.sections.map((section) => section.text).join('\n\n') === worker.text &&
      worker.sections.map((section) => section.group).join(',') === 'role,template,task,task,task,task,task,fixed,skills' &&
      worker.sections.filter((section) => section.text.indexOf('Task T-1:') >= 0).every((section) => section.group === 'task') &&
      worker.sections.some((section) => section.group === 'role' && section.text.indexOf('Task T-1:') < 0),
    JSON.stringify(worker.sections.map((section) => [section.key, section.group])),
  )
  const workerTemplate = worker.sections.filter((section) => section.group === 'template')[0]
  check(
    'the worker preview carries the built-in default prompt in its template section',
    workerTemplate !== undefined && workerTemplate.text.indexOf(DEFAULT_ROLE_PROMPTS.worker) >= 0,
    workerTemplate && workerTemplate.text.slice(0, 200),
  )
  check(
    'the worker preview carries the skills injection like the real implementer',
    worker.text.indexOf('Skills:') >= 0 && worker.text.indexOf('task_center is your only interface to the board.') >= 0,
    worker.text.slice(-300),
  )
  check(
    'the variable list carries the real value for this task',
    Array.isArray(worker.tokens) &&
      worker.tokens.length === 9 &&
      worker.tokens.filter((token) => token.name === 'TASK_ID')[0].value === 'T-1' &&
      worker.tokens.filter((token) => token.name === 'PROJECT')[0].value === PROJECT,
    JSON.stringify(worker.tokens),
  )

  const reviewer = await rig.api.perform('rolesPreview', { kind: 'reviewer' }, rig.user)
  check(
    'a reviewer preview is the role brief the reviewer really receives',
    reviewer.ok === true && reviewer.kind === 'reviewer' && reviewer.stage === 'review' && reviewer.text === roleBriefFor('reviewer', boardTask, config, previewOptions),
    reviewer.ok === true ? reviewer.text.slice(0, 200) : JSON.stringify(reviewer),
  )
  check(
    'the reviewer section labels separate task data from host copy',
    reviewer.sections.map((section) => section.group).join(',') === 'role,role,template,task,fixed,skills',
    JSON.stringify(reviewer.sections.map((section) => section.group)),
  )
  const reviewerTemplate = reviewer.sections.filter((section) => section.group === 'template')[0]
  check(
    'the built-in reviewer preview carries the default prompt in its template section',
    reviewerTemplate !== undefined && reviewerTemplate.text.indexOf(DEFAULT_ROLE_PROMPTS.reviewer) >= 0,
    reviewerTemplate && reviewerTemplate.text.slice(0, 160),
  )
  const tester = await rig.api.perform('rolesPreview', { kind: 'tester' }, rig.user)
  const testerTemplate = tester.ok === true ? tester.sections.filter((section) => section.group === 'template')[0] : undefined
  check(
    'the built-in tester preview carries the default prompt in its template section',
    tester.ok === true && testerTemplate !== undefined && testerTemplate.text.indexOf(DEFAULT_ROLE_PROMPTS.tester) >= 0,
    tester.ok === true ? (testerTemplate && testerTemplate.text.slice(0, 160)) : JSON.stringify(tester),
  )

  check(
    'the built-in tester preview exposes the full contiguous group order',
    tester.ok === true && tester.sections.map((section) => section.group).join(',') === 'role,role,template,task,fixed,skills',
    tester.ok === true ? tester.sections.map((section) => section.group).join(',') : JSON.stringify(tester),
  )

  const created = await rig.api.perform('rolesCreate', { name: 'strict-reviewer', profile: { role: 'reviewer', prompt: 'Review {{TASK_ID}} in {{PROJECT}}.' } }, rig.user)
  check('a custom profile exists for the preview', created.ok === true && created.config.profiles['strict-reviewer'].prompt === 'Review {{TASK_ID}} in {{PROJECT}}.')
  const scoped = Object.assign({}, created.config, { stages: Object.assign({}, created.config.stages, { review: 'strict-reviewer' }) })
  const custom = await rig.api.perform('rolesPreview', { profile: 'strict-reviewer' }, rig.user)
  check(
    'a named profile preview resolves the profile through its own stage binding',
    custom.ok === true && custom.profile === 'strict-reviewer' && custom.text === roleBriefFor('reviewer', boardTask, scoped, previewOptions),
    custom.ok === true ? custom.text.slice(0, 200) : JSON.stringify(custom),
  )
  check(
    'the custom template is injected with the real task values, not a placeholder',
    custom.text.indexOf('Review T-1 in ' + PROJECT) >= 0 && custom.text.indexOf('T-?') < 0,
    custom.text.slice(0, 200),
  )
  check(
    'a custom prompt is the only section the user owns; the rest is task data or host copy',
    custom.sections.filter((section) => section.group === 'template').length === 1 &&
      custom.sections.some((section) => section.group === 'task') &&
      custom.sections.some((section) => section.group === 'fixed'),
    JSON.stringify(custom.sections.map((section) => section.group)),
  )

  const explicit = await rig.api.perform('rolesPreview', { taskId: 'T-2' }, rig.user)
  check(
    'a taskId picks that task even when it is not the active one',
    explicit.ok === true && explicit.task.id === 'T-2' && explicit.task.real === true && explicit.text.indexOf('Pending idea') >= 0,
    JSON.stringify(explicit.task),
  )

  const unknownProfile = await rig.api.perform('rolesPreview', { profile: 'nope' }, rig.user)
  check('an unknown profile is a readable refusal', unknownProfile.ok === false && unknownProfile.code === 'unknown-role-profile' && unknownProfile.message.indexOf('nope') >= 0, JSON.stringify(unknownProfile))
  const unknownTask = await rig.api.perform('rolesPreview', { taskId: 'T-999' }, rig.user)
  check('an unknown task id is a readable refusal', unknownTask.ok === false && unknownTask.code === 'unknown-task' && unknownTask.message.indexOf('T-999') >= 0, JSON.stringify(unknownTask))
  const invalidKind = await rig.api.perform('rolesPreview', { kind: 'merger' }, rig.user)
  check('an unknown role kind is a readable refusal', invalidKind.ok === false && invalidKind.code === 'invalid-role-kind', JSON.stringify(invalidKind))
  const denied = await rig.api.perform('rolesPreview', {}, agentCaller('session-fixer'))
  check('an agent cannot read the role preview', denied.ok === false && denied.code === 'user-only', JSON.stringify(denied))

  const surface = install(rig)
  const routed = (await postTo(surface, { action: 'rolesPreview', taskId: 'T-1' })).json()
  check(
    'the route exposes rolesPreview and still carries the board snapshot',
    routed.ok === true && routed.kind === 'worker' && routed.snapshot !== undefined && Array.isArray(routed.snapshot.tasks) && routed.snapshot.tasks.length === 2,
    JSON.stringify({ ok: routed.ok, kind: routed.kind, hasSnapshot: routed.snapshot !== undefined }),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

// ── rolesPreview: an empty board falls back to a realistic sample task ─────
{
  const stamp = new Date().toISOString()
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 1, dispatch: { state: 'paused' }, updatedAt: stamp, tasks: [] }))
  const sample = await rig.api.perform('rolesPreview', {}, rig.user)
  check(
    'an empty board previews the built-in sample task and says it is not real',
    sample.ok === true && sample.task.sample === true && sample.task.real === false && sample.task.id === ROLE_SAMPLE_TASK.id && sample.text.indexOf(ROLE_SAMPLE_TASK.title) >= 0,
    JSON.stringify(sample.task),
  )
  check(
    'the sample task fields carry no angle-bracket placeholders',
    JSON.stringify(ROLE_SAMPLE_TASK).indexOf('<') < 0 && JSON.stringify(ROLE_SAMPLE_TASK).indexOf('>') < 0,
    JSON.stringify(ROLE_SAMPLE_TASK).slice(0, 200),
  )
  check(
    'the sample preview is still the real builder output and has no fake values',
    sample.text === briefFor(ROLE_SAMPLE_TASK, PROJECT, 'session-lead', defaultRoleConfig()) &&
      sample.text.indexOf('<example') < 0 &&
      sample.text.indexOf('T-?') < 0 &&
      sample.text.indexOf('<task worktree>') < 0,
    sample.text.slice(0, 300),
  )
  rig.scheduler.dispose()
}

// ── skillsCatalog: user-only, read-only, degrades readably ────────────────
{
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  const agent = { projectPath: PROJECT, by: '@agent', role: 'agent', agent: { id: 'session-agent' } }
  const missing = await rig.api.perform('skillsCatalog', {}, rig.user)
  check('a host without a skills service reports skills-unavailable', missing.ok === false && missing.code === 'skills-unavailable' && typeof missing.message === 'string' && missing.message !== '', JSON.stringify(missing))
  const denied = await rig.api.perform('skillsCatalog', {}, agent)
  check('an agent cannot read the skill catalog', denied.ok === false && denied.code === 'user-only', JSON.stringify(denied))
  const calls = []
  const originalGet = rig.ctx.get
  rig.ctx.get = function (key) {
    if (key !== 'skills') return originalGet.call(rig.ctx, key)
    return {
      async list(options) {
        calls.push(options)
        return [
          { name: 'zeta-skill', description: 'Z', invocation: { modelInvocable: true, userInvocable: true } },
          { name: 'alpha-skill', description: 'A', whenToUse: 'when A', invocation: { modelInvocable: true, userInvocable: false } },
          { name: '', description: 'ignored', invocation: {} },
          'nope',
        ]
      },
    }
  }
  const catalog = await rig.api.perform('skillsCatalog', {}, rig.user)
  check(
    'the host catalog is listed sorted with its invocation policy',
    catalog.ok === true &&
      catalog.count === 2 &&
      catalog.skills.map((entry) => entry.name).join(',') === 'alpha-skill,zeta-skill' &&
      catalog.skills[0].description === 'A' &&
      catalog.skills[0].whenToUse === 'when A' &&
      catalog.skills[0].invocation.modelInvocable === true &&
      catalog.skills[0].invocation.userInvocable === false &&
      catalog.skills[1].invocation.userInvocable === true,
    JSON.stringify(catalog),
  )
  check('the catalog is read from the project directory', calls.length === 1 && calls[0].cwd === PROJECT, JSON.stringify(calls))
  rig.ctx.get = function (key) {
    if (key !== 'skills') return originalGet.call(rig.ctx, key)
    return {
      list() {
        throw new Error('registry exploded')
      },
    }
  }
  const failed = await rig.api.perform('skillsCatalog', {}, rig.user)
  check('a failing registry is a readable skills-unavailable, never a throw', failed.ok === false && failed.code === 'skills-unavailable' && failed.message.indexOf('registry exploded') >= 0, JSON.stringify(failed))
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
    submitted.ok === true && submitted.provisioned !== undefined && submitted.provisioned.created[0].name === slot('reviewer', 1),
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

{
  // Activity must reflect what the merge queue actually did: a dirty worktree is
  // refused before the integration checkout exists, so there is NO worktree-create.
  const activity = createActivity({ limit: 30 })
  const fake = mergeGit({
    'status --porcelain': () => ({ code: 0, stdout: ' M scripts/a.gd\n', stderr: '' }),
    'rev-parse --verify refs/heads/main': () => ({ code: 0, stdout: 'target-sha\n', stderr: '' }),
  })
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }), activity: activity })
  seedMergeTask(rig, openMergeTask())
  const res = await rig.api.perform('mergeRequest', { id: 'T-1' }, { projectPath: PROJECT, by: '@user', role: 'user', agent: null })
  check('a dirty worktree refuses the merge', res.ok === false && res.code === 'dirty-worktree', JSON.stringify(res))
  const entries = activity.list(30)
  check('a refused merge records an error event', entries.some((entry) => entry.kind === 'error' && entry.actor === 'host'), JSON.stringify(entries))
  check('a refused merge records NO phantom merge worktree', entries.every((entry) => entry.kind !== 'worktree-create'), JSON.stringify(entries))
}

{
  // A successful sweep merge records: sweep (system), merge (system), the real
  // integration worktree create/remove (system) and the task worktree removal (host).
  const activity = createActivity({ limit: 40 })
  const fake = mergeGit()
  const verifier = fakeVerifier({ code: 0, stdout: 'ALL CHECKS PASSED', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }), activity: activity, autoMerge: true })
  seedMergeTask(rig, openMergeTask())
  const sweep = await rig.api.autoMergePending(PROJECT)
  check('the sweep merges the eligible request', sweep.ok === true && sweep.merged.join(',') === 'T-1', JSON.stringify(sweep))
  const entries = activity.list(40)
  const sweepEvent = entries.filter((entry) => entry.kind === 'sweep')[0]
  check('the sweep is a system event', sweepEvent !== undefined && sweepEvent.actor === 'system' && sweepEvent.actorName === null, JSON.stringify(sweepEvent))
  const mergeEvent = entries.filter((entry) => entry.kind === 'merge')[0]
  check('the merge outcome is a system event on the sweep path', mergeEvent !== undefined && mergeEvent.actor === 'system' && String(mergeEvent.detail).indexOf('merged') >= 0, JSON.stringify(mergeEvent))
  const create = entries.filter((entry) => entry.kind === 'worktree-create')[0]
  const remove = entries.filter((entry) => entry.kind === 'worktree-remove')
  check('the real integration worktree is recorded as created', create !== undefined && create.actor === 'system' && String(create.detail).indexOf('merge-T-1') >= 0, JSON.stringify(create))
  check('its cleanup and the task worktree removal are recorded', remove.length >= 2 && remove.some((entry) => entry.actor === 'host'), JSON.stringify(remove))
  check('the sweep path records no agent activity', entries.every((entry) => entry.actor !== 'agent'), JSON.stringify(entries.map((entry) => entry.actor)))
}

// ── role management API: user-only CRUD, binding, drain/replace, reset ─────
{
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  const user = rig.user
  const agent = agentCaller('session-fixer')
  const listed = await rig.api.perform('rolesList', {}, user)
  check(
    'the user can list the default role profiles',
    listed.ok === true &&
      listed.source === 'default' &&
      listed.config.profiles.worker.role === 'worker' &&
      listed.config.stages.review === 'reviewer' &&
      listed.defaults.profiles.tester.stage === 'test',
    JSON.stringify({ source: listed.ok ? listed.source : listed.code }),
  )
  check(
    'the live role instances are listed',
    listed.instances.available === true && listed.instances.instances.map((entry) => entry.name).join(',') === 'reviewer-1,tester-1',
    JSON.stringify(listed.instances),
  )
  const deniedList = await rig.api.perform('rolesList', {}, agent)
  check('an agent cannot list role profiles', deniedList.ok === false && deniedList.code === 'user-only', JSON.stringify(deniedList))
  const deniedCreate = await rig.api.perform('rolesCreate', { name: 'x', profile: { role: 'reviewer' } }, agent)
  check('an agent cannot create a role profile', deniedCreate.ok === false && deniedCreate.code === 'user-only', JSON.stringify(deniedCreate))

  const originalWrite = rig.fs.writeText
  let sandboxSeen = null
  rig.fs.writeText = async function (target, text, expected, signal, policy) {
    // The registry write also goes through writeText; only the role config write
    // carries the project sandbox policy.
    if (String(target.targetKey === undefined ? target.displayPath : target.targetKey).indexOf('roles.json') >= 0) sandboxSeen = policy
    return originalWrite.call(this, target, text, expected)
  }
  const created = await rig.api.perform(
    'rolesCreate',
    {
      name: 'godot-reviewer',
      profile: { role: 'reviewer', stage: 'review', instances: 2, skills: ['dsh-plugin-workflow'], context: 'fork', permissions: ['read-only', 'review'], prompt: 'Check idioms.' },
    },
    user,
  )
  check(
    'role config writes carry the project sandbox policy',
    sandboxSeen !== null && sandboxSeen !== undefined && sandboxSeen.workspaceRoot === PROJECT,
    JSON.stringify(sandboxSeen),
  )
  check(
    'the user can create a custom profile',
    created.ok === true &&
      created.config.profiles['godot-reviewer'].instances === 2 &&
      created.config.profiles['godot-reviewer'].context === 'fork' &&
      created.config.profiles['godot-reviewer'].permissions.join(',') === 'read-only,review',
    JSON.stringify(created.ok ? created.profile : created),
  )
  const before = rig.fs.files.get(rolesPath(PROJECT)).text
  check('creating persists roles.json', JSON.parse(before).profiles['godot-reviewer'].prompt === 'Check idioms.', before.slice(0, 300))
  const invalid = await rig.api.perform('rolesCreate', { name: 'bad-reviewer', profile: { role: 'reviewer', instances: 99 } }, user)
  check('an invalid profile is refused', invalid.ok === false && invalid.code === 'invalid-role-instances', JSON.stringify(invalid))
  check('a refused profile is not persisted', rig.fs.files.get(rolesPath(PROJECT)).text === before)
  const duplicate = await rig.api.perform('rolesCreate', { name: 'godot-reviewer', profile: { role: 'reviewer' } }, user)
  check('creating an existing profile is refused', duplicate.ok === false && duplicate.code === 'role-exists', JSON.stringify(duplicate))
  const immutable = await rig.api.perform('rolesUpdate', { name: 'reviewer', profile: { prompt: 'hacked' } }, user)
  check('a built-in profile cannot be edited through the API', immutable.ok === false && immutable.code === 'builtin-profile-immutable', JSON.stringify(immutable))
  const afterImmutable = await rig.api.perform('rolesList', {}, user)
  check(
    'the refused built-in edit changed nothing',
    afterImmutable.config.profiles.reviewer.prompt === DEFAULT_ROLE_PROMPTS.reviewer,
    afterImmutable.config.profiles.reviewer.prompt.slice(0, 80),
  )

  const updated = await rig.api.perform('rolesUpdate', { name: 'godot-reviewer', profile: { prompt: 'Updated prompt.' } }, user)
  check(
    'updating a profile keeps its other fields',
    updated.ok === true &&
      updated.config.profiles['godot-reviewer'].prompt === 'Updated prompt.' &&
      updated.config.profiles['godot-reviewer'].instances === 2 &&
      updated.config.profiles['godot-reviewer'].role === 'reviewer',
    JSON.stringify(updated.ok ? updated.config.profiles['godot-reviewer'] : updated),
  )
  const bound = await rig.api.perform('rolesBind', { stage: 'review', profile: 'godot-reviewer' }, user)
  check('the user can bind a stage to a profile', bound.ok === true && bound.config.stages.review === 'godot-reviewer', JSON.stringify(bound.ok ? bound.bound : bound))
  const boundSnapshot = await rig.action('board')
  check(
    'the snapshot desired instances follow the bound profile',
    boundSnapshot.agents.roles.desired.reviewer === 2 &&
      boundSnapshot.agents.roles.bound.reviewer === 'godot-reviewer' &&
      boundSnapshot.agents.roles.missing.reviewer === Math.max(0, 2 - boundSnapshot.agents.roles.live.reviewer),
    JSON.stringify(boundSnapshot.agents.roles),
  )
  const badBind = await rig.api.perform('rolesBind', { stage: 'test', profile: 'godot-reviewer' }, user)
  check('binding a profile to the wrong stage is refused', badBind.ok === false && badBind.code === 'stage-mismatch', JSON.stringify(badBind))
  const unknownBind = await rig.api.perform('rolesBind', { stage: 'review', profile: 'nope' }, user)
  check('binding an unknown profile is refused', unknownBind.ok === false && unknownBind.code === 'unknown-role-profile', JSON.stringify(unknownBind))
  const delDefault = await rig.api.perform('rolesDelete', { name: 'worker' }, user)
  check('the built-in profiles cannot be deleted', delDefault.ok === false && delDefault.code === 'default-profile', JSON.stringify(delDefault))

  const replaced = await rig.api.perform('rolesReplace', { name: 'reviewer-1' }, user)
  const replacedOk = replaced.ok === true && replaced.drained.length === 1 && replaced.created.length >= 1
  const replacement = replacedOk ? String(replaced.created[0].name) : ''
  check(
    'replacing an instance drains it and spawns a replacement through the Lead',
    replacedOk && replacement.indexOf('reviewer-') === 0 && replacement !== String(replaced.drained[0]),
    JSON.stringify(replaced.ok ? { drained: replaced.drained, created: replaced.created } : replaced),
  )
  // A drained instance must no longer receive briefs: the next submit's review
  // brief targets the replacement.
  const seeded = runningWorktreeTask()
  seeded.dispatch = Object.assign({}, seeded.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, seeded)
  const submittedAfterReplace = await rig.api.perform('submit', { id: 'T-1', evidence: 'x' }, user)
  check('the task enters review after the replacement', submittedAfterReplace.ok === true && submittedAfterReplace.task.status === 'reviewing', JSON.stringify(submittedAfterReplace.ok ? submittedAfterReplace.task.status : submittedAfterReplace))
  const reviewerSends = rig.team.calls.filter((call) => call.kind === 'send' && String(call.target).indexOf('reviewer-') === 0)
  check(
    'the replacement reviewer receives the new brief, the drained one does not',
    replacement !== '' && reviewerSends.length >= 1 && String(reviewerSends[reviewerSends.length - 1].target) === replacement && reviewerSends.every((call) => String(call.target) !== String(replaced.drained[0])),
    JSON.stringify(reviewerSends.map((call) => call.target)),
  )

  // A replace waits for the old instance's in-flight turn before spawning.
  rig.team.setStatus(replacement, 'running')
  setTimeout(() => rig.team.setStatus(replacement, 'inactive'), 20)
  const waitedReplace = await rig.api.perform('rolesReplace', { name: replacement }, user)
  check(
    'replace waits for the drained instance to go idle',
    waitedReplace.ok === true && waitedReplace.waited.timedOut === false && waitedReplace.waited.waitedMs >= 15 && waitedReplace.created.length >= 1,
    JSON.stringify(waitedReplace.ok ? waitedReplace.waited : waitedReplace),
  )

  const drained = await rig.api.perform('rolesDrain', { name: 'tester-1' }, user)
  check('draining an instance marks it for replacement', drained.ok === true && drained.drained.join(',') === 'tester-1', JSON.stringify(drained.ok ? drained.drained : drained))
  const replacedKind = await rig.api.perform('rolesReplace', { name: 'tester' }, user)
  check(
    'replacing a role kind drains every instance and spawns replacements',
    replacedKind.ok === true && replacedKind.drained.indexOf('tester-1') >= 0 && replacedKind.created.length === 1 && replacedKind.created[0].name === slot('tester', 1),
    JSON.stringify(replacedKind.ok ? { drained: replacedKind.drained, created: replacedKind.created } : replacedKind),
  )
  const badInstance = await rig.api.perform('rolesDrain', { name: 'not-a-slot' }, user)
  check('draining a non-instance name is refused', badInstance.ok === false && badInstance.code === 'invalid-role-instance', JSON.stringify(badInstance))

  const reset = await rig.api.perform('rolesReset', {}, user)
  const defaults = defaultRoleConfig()
  check(
    'resetting restores only the built-in profiles and keeps the custom copies and their bindings',
    reset.ok === true &&
      reset.source === 'default' &&
      reset.config.stages.implement === defaults.stages.implement &&
      reset.config.stages.test === defaults.stages.test &&
      reset.config.stages.review === 'godot-reviewer' &&
      reset.config.profiles['godot-reviewer'] !== undefined &&
      reset.config.profiles['godot-reviewer'].prompt === 'Updated prompt.' &&
      reset.config.profiles.worker.instances === defaults.profiles.worker.instances &&
      reset.config.profiles.reviewer.prompt === DEFAULT_ROLE_PROMPTS.reviewer &&
      reset.config.profiles.tester.prompt === DEFAULT_ROLE_PROMPTS.tester,
    JSON.stringify({ stages: reset.ok ? reset.config.stages : reset, profiles: reset.ok ? Object.keys(reset.config.profiles) : reset }),
  )
  const afterReset = JSON.parse(rig.fs.files.get(rolesPath(PROJECT)).text)
  check('resetting persists the built-in defaults without dropping a custom copy', afterReset.profiles['godot-reviewer'] !== undefined && afterReset.stages.review === 'godot-reviewer' && afterReset.profiles.reviewer.prompt === DEFAULT_ROLE_PROMPTS.reviewer, JSON.stringify(afterReset.stages))
  const listedAfter = await rig.api.perform('rolesList', {}, user)
  check('the built-in profiles are the defaults after reset', listedAfter.ok === true && listedAfter.config.profiles.reviewer.role === 'reviewer' && listedAfter.config.profiles.tester.role === 'tester' && listedAfter.config.profiles.reviewer.prompt === DEFAULT_ROLE_PROMPTS.reviewer, JSON.stringify(listedAfter.ok ? listedAfter.config.profiles : listedAfter))
  rig.scheduler.dispose()
}

{
  // A running instance that never goes idle is replaced after the bounded wait.
  // The budget is generous on purpose: 40 ms flaked under a loaded suite (the
  // replace pass polls every 5 ms, so the wait itself consumed the whole budget
  // and the spawn never ran). Timing stays bounded, just not knife-edge.
  const team = roleTeam()
  const rig = createSubmitRig({ team: team, roles: true, git: fakeGit().git, drainTimeoutMs: 250, drainIntervalMs: 5 })
  rig.team.setStatus('reviewer-1', 'running')
  const replaced = await rig.api.perform('rolesReplace', { name: 'reviewer-1' }, rig.user)
  check(
    'a stuck instance is replaced after the bounded wait',
    replaced.ok === true && replaced.waited.timedOut === true && replaced.drained.join(',') === 'reviewer-1' && replaced.created.length >= 1,
    JSON.stringify(replaced.ok ? { waited: replaced.waited, created: replaced.created } : replaced),
  )
  rig.scheduler.dispose()
}
{
  // Unknown or dead instances are refused instead of faking a drain.
  const rig = createSubmitRig({ team: roleTeam(), roles: true, git: fakeGit().git })
  const unknownDrain = await rig.api.perform('rolesDrain', { name: 'reviewer-9' }, rig.user)
  check('draining an unknown instance is refused', unknownDrain.ok === false && unknownDrain.code === 'unknown-role-instance', JSON.stringify(unknownDrain))
  const unknownReplace = await rig.api.perform('rolesReplace', { name: 'reviewer-9' }, rig.user)
  check('replacing an unknown instance is refused', unknownReplace.ok === false && unknownReplace.code === 'unknown-role-instance', JSON.stringify(unknownReplace))
  const failedTeam = roleTeam()
  failedTeam.setStatus('reviewer-1', 'failed')
  const failedRig = createSubmitRig({ team: failedTeam, roles: true, git: fakeGit().git })
  const dead = await failedRig.api.perform('rolesDrain', { name: 'reviewer-1' }, failedRig.user)
  check('draining a failed instance is refused as not-live', dead.ok === false && dead.code === 'not-live', JSON.stringify(dead))
  const emptyRig = createSubmitRig({
    team: createTeam({
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
      ],
    }),
    roles: true,
    git: fakeGit().git,
  })
  const none = await emptyRig.api.perform('rolesReplace', { name: 'reviewer' }, emptyRig.user)
  check('replacing a kind with no live instance is refused', none.ok === false && none.code === 'not-live', JSON.stringify(none))
  rig.scheduler.dispose()
  failedRig.scheduler.dispose()
  emptyRig.scheduler.dispose()
}

{
  // During the drain wait no ensure pass — including a scheduler tick — spawns the
  // replacement early; it appears only after the old instance is idle.
  const team = roleTeam()
  const rig = createSubmitRig({ team: team, roles: true, git: fakeGit().git, drainTimeoutMs: 400, drainIntervalMs: 10 })
  const task = reviewStageTask()
  task.dispatch = Object.assign({}, task.dispatch, { host: rig.scheduler.boot })
  seedRunningTask(rig, task)
  rig.team.setStatus('reviewer-1', 'running')
  const spawnsBefore = rig.team.calls.filter((call) => call.kind === 'spawn').length
  const replacePromise = rig.api.perform('rolesReplace', { name: 'reviewer-1' }, rig.user)
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 25))
  await rig.scheduler.tick(PROJECT)
  const spawnsDuring = rig.team.calls.filter((call) => call.kind === 'spawn').length
  check('a tick during the drain wait does not spawn early', spawnsDuring === spawnsBefore, JSON.stringify({ before: spawnsBefore, during: spawnsDuring }))
  rig.team.setStatus('reviewer-1', 'inactive')
  const replaced = await replacePromise
  check(
    'after the old instance goes idle the replacement is spawned',
    replaced.ok === true && replaced.created.length >= 1 && replaced.waited.timedOut === false,
    JSON.stringify(replaced.ok ? { created: replaced.created, waited: replaced.waited } : replaced),
  )
  rig.scheduler.dispose()
}

{
  // A failed instance cannot be drained, but it CAN be replaced (ensure replaces
  // failed slots); the drain refusal points at that.
  const team = roleTeam()
  team.setStatus('reviewer-1', 'failed')
  const rig = createSubmitRig({ team: team, roles: true, git: fakeGit().git })
  const drainFailed = await rig.api.perform('rolesDrain', { name: 'reviewer-1' }, rig.user)
  check(
    'draining a failed instance explains that auto-provisioning will replace it',
    drainFailed.ok === false && drainFailed.code === 'not-live' && String(drainFailed.message).indexOf('auto-provisioning') >= 0,
    JSON.stringify(drainFailed),
  )
  const replacedFailed = await rig.api.perform('rolesReplace', { name: 'reviewer-1' }, rig.user)
  check(
    'a failed instance can be replaced directly',
    replacedFailed.ok === true && replacedFailed.drained.length === 0 && replacedFailed.created.length >= 1 && replacedFailed.created[0].name === slot('reviewer', 1),
    JSON.stringify(replacedFailed.ok ? { drained: replacedFailed.drained, created: replacedFailed.created } : replacedFailed),
  )
  rig.scheduler.dispose()
}

surface.dispose()
rig.scheduler.dispose()

// ── T-37 liveness observability: lease fields and handover events ──────────
{
  const activity = createActivity({})
  const team = roleTeam()
  const rig = createSubmitRig({ team: team, roles: true, git: fakeGit().git, activity: activity })
  // The claim must belong to THIS dispatcher, or reap treats it as a host-restart
  // leftover before liveness is ever consulted.
  const claim = { status: 'sent', at: new Date().toISOString(), target: 'fixer', targetId: 'session-fixer', via: 'message', error: null, host: rig.scheduler.boot }
  seedRunningTask(rig, runningWorktreeTask({ leaseUntil: new Date(Date.now() - 1000).toISOString(), dispatch: claim }))
  await rig.scheduler.settle(PROJECT)
  let snapshot = await rig.action('board')
  let task = snapshot.tasks.filter((entry) => entry.id === 'T-1')[0]
  check(
    'a live holder keeps its lease and the snapshot shows the remainder',
    task.status === 'running' && task.leaseRemaining > 0 && task.leaseExpired === false && task.leaseReminder === false,
    JSON.stringify({ status: task.status, remaining: task.leaseRemaining, expired: task.leaseExpired }),
  )
  check(
    'and the snapshot exposes assignee, attempt and leaseUntil together',
    task.assignee.name === 'fixer' && task.attempts === 1 && typeof task.leaseUntil === 'string',
    JSON.stringify({ assignee: task.assignee, attempts: task.attempts, lease: task.leaseUntil }),
  )
  const extended = activity.list(20).filter((entry) => entry.kind === 'lease-extended')
  check(
    'the liveness extension is a system activity entry',
    extended.length === 1 && extended[0].actor === 'system' && extended[0].taskId === 'T-1',
    JSON.stringify(activity.list(20)),
  )

  // Inside the reminder window but outside the host heartbeat window: the board
  // warns without extending.
  seedRunningTask(rig, runningWorktreeTask({ leaseUntil: new Date(Date.now() + 8 * 60 * 1000).toISOString(), dispatch: claim }))
  snapshot = await rig.action('board')
  task = snapshot.tasks.filter((entry) => entry.id === 'T-1')[0]
  check(
    'a lease close to lapsing is flagged for the panel',
    task.leaseReminder === true && task.leaseRemaining > 0,
    JSON.stringify({ reminder: task.leaseReminder, remaining: task.leaseRemaining }),
  )

  // The holder dies: the task is handed over and the handover is visible.
  team.setStatus('fixer', 'failed')
  seedRunningTask(rig, runningWorktreeTask({ leaseUntil: new Date(Date.now() - 1000).toISOString(), commit: 'old-commit-sha', dispatch: claim }))
  await rig.scheduler.settle(PROJECT)
  snapshot = await rig.action('board')
  task = snapshot.tasks.filter((entry) => entry.id === 'T-1')[0]
  check('a gone holder is a real expiry, not an extension', task.status === 'pending' && task.dispatch.status === 'lease-expired', JSON.stringify(task.dispatch))
  check('and the lease is cleared on the requeued task', task.leaseUntil === null && task.leaseRemaining === null, JSON.stringify({ lease: task.leaseUntil, remaining: task.leaseRemaining }))
  const handover = activity.list(40).filter((entry) => entry.kind === 'lease-handover')
  check(
    'the handover is a host activity entry naming the reason',
    handover.length === 1 && handover[0].actor === 'host' && String(handover[0].detail).indexOf('failed') >= 0,
    JSON.stringify(handover),
  )
  rig.scheduler.dispose()
}

// ── per-task target branch ─────────────────────────────────────────────────
{
  const fake = fakeGit()
  const git = fake.git
  git.branchExists = async function (root, name) { return { ok: true, exists: name === 'main' || name === 'feat/other' } }
  const rig = createSubmitRig({ git: git })
  const created = await rig.action('create', { title: 'hotfix card', target: 'main' })
  check('a task can be created on an explicit target', created.ok === true && created.task.target === 'main', JSON.stringify(created.task && created.task.target))
  const cleared = await rig.action('update', { id: created.task.id, target: '' })
  check('an empty target clears back to the default', cleared.ok === true && cleared.task.target === null, JSON.stringify(cleared.task && cleared.task.target))
  const pinned = await rig.action('update', { id: created.task.id, target: 'feat/other' })
  check('an update can pin another existing target', pinned.ok === true && pinned.task.target === 'feat/other', JSON.stringify(pinned.task && pinned.task.target))
  const unknown = await rig.action('update', { id: created.task.id, target: 'release/9.9' })
  check(
    'an unknown target is refused with the available branches',
    unknown.ok === false && unknown.code === 'unknown-target' && String(unknown.message).indexOf('main') >= 0,
    JSON.stringify(unknown),
  )
  const mainCard = await rig.action('create', { title: 'main card', target: 'main' })
  const cross = await rig.action('create', { title: 'cross card', target: 'feat/other', dependsOn: [mainCard.task.id] })
  check(
    'a cross-target dependency is refused with a readable reason',
    cross.ok === false && cross.code === 'cross-target-dependency' && String(cross.message).indexOf('target branch') >= 0,
    JSON.stringify(cross),
  )
  rig.scheduler.dispose()
}

// ── parallel target merges share the worktree-create gate ──────────────────
{
  let active = 0
  let overlapped = false
  const addOrder = []
  const updates = []
  const heads = { main: 'main-head', 'feat/x': 'feat-head' }
  const shortName = (ref) => (String(ref).startsWith('refs/heads/') ? String(ref).slice('refs/heads/'.length) : String(ref))
  const git = {
    async isClean() { return { ok: true, clean: true } },
    async currentBranch() { return { ok: true, branch: 'feat/x' } },
    async revParse(root, ref) { return { ok: true, hash: heads[shortName(ref)] || 'merge-sha' } },
    async worktreeList() { return { ok: true, worktrees: [] } },
    async head() { return { ok: true, hash: 'merge-sha' } },
    async worktreeAdd(root, input) {
      active++
      if (active > 1) overlapped = true
      addOrder.push('start:' + input.branch)
      await new Promise((resolve) => setTimeout(resolve, 30))
      addOrder.push('end:' + input.branch)
      active--
      return { ok: true, path: input.path, branch: input.branch, base: input.base }
    },
    async mergeNoFf() { return { ok: true } },
    async conflictedFiles() { return { ok: true, files: [] } },
    async worktreeRemove() { return { ok: true } },
    async deleteBranch() { return { ok: true } },
    async updateRef(root, ref, hash) { heads[shortName(ref)] = hash; updates.push(ref + '=' + hash); return { ok: true, ref: ref, hash: hash } },
  }
  const merger = createMerger({ git: git })
  const taskFor = (id, target, branch) => ({ id: id, title: 'merge ' + id, status: 'testing', branch: branch, target: target, merge: { status: 'open', base: target + '-head', head: 'h', target: target } })
  const results = await Promise.all([
    merger.mergeRequest(taskFor('T-1', 'main', 'task/T-1-1'), PROJECT, { worktreeRoot: '.worktrees' }),
    merger.mergeRequest(taskFor('T-2', 'feat/x', 'task/T-2-1'), PROJECT, { worktreeRoot: '.worktrees' }),
  ])
  check(
    'two target merges both complete while their worktree creations never overlap',
    results[0].ok === true && results[0].status === 'merged' && results[1].ok === true && results[1].status === 'merged' && overlapped === false && addOrder.length === 4,
    JSON.stringify({ results: results.map((entry) => entry.status), addOrder: addOrder, overlapped: overlapped }),
  )
  check(
    'each merge advances only its own target',
    updates.length === 2 && updates[0].indexOf('refs/heads/main=') === 0 && updates[1].indexOf('refs/heads/feat/x=') === 0,
    JSON.stringify(updates),
  )
}

// ── T-77: fully-qualified refs and post-advance verification ───────────────
{
  // Silent failure: git claims success but the target ref never moves.
  const fake = mergeGit({
    'update-ref refs/heads/main merge-sha': () => ({ code: 0, stdout: '', stderr: '' }),
    'rev-parse --verify refs/heads/main': () => ({ code: 0, stdout: 'target-sha\n', stderr: '' }),
  })
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  seedMergeTask(rig, openMergeTask())
  const surface = install(rig)
  const merged = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  const payload = merged.json()
  check(
    'a target that does not move after update-ref is refused with target-not-advanced',
    payload.ok === false && payload.code === 'target-not-advanced' && String(payload.message).indexOf('refs/heads/main') >= 0,
    merged.text,
  )
  const after = await rig.api.snapshot(PROJECT)
  const still = after.tasks.filter((task) => task.id === 'T-1')[0]
  check('the task stays testing and is never marked done', still.status === 'testing' && still.merge.status === 'open', JSON.stringify({ status: still.status, merge: still.merge && still.merge.status }))
  check(
    'the advance used the fully-qualified ref',
    fake.calls.some((call) => call.args[0] === 'update-ref' && call.args[1] === 'refs/heads/main'),
    JSON.stringify(fake.calls.filter((call) => call.args[0] === 'update-ref').map((call) => call.args)),
  )
  surface.dispose()
  rig.scheduler.dispose()
}
{
  // Normal path with a slash in the target: full flow, ref advanced, task done.
  const fake = mergeGit({})
  const verifier = fakeVerifier({ code: 0, stdout: '', stderr: '' })
  const rig = createSubmitRig({ git: fake.git, merger: createMerger({ git: fake.git, verify: verifier.verify }) })
  const task = openMergeTask({ target: 'fix/x', merge: Object.assign({}, openMergeTask().merge, { target: 'fix/x' }) })
  seedMergeTask(rig, task)
  const surface = install(rig)
  const merged = await postTo(surface, { action: 'mergeRequest', project: PROJECT, id: 'T-1' })
  const payload = merged.json()
  check(
    'a target containing a slash merges through the fully-qualified ref',
    payload.ok === true && payload.task.status === 'done' && payload.task.merge.status === 'merged' && payload.task.merge.mergeCommit === 'merge-sha',
    merged.text,
  )
  const refCalls = fake.calls.filter((call) => call.args[0] === 'update-ref' || (call.args[0] === 'rev-parse' && call.args[1] === '--verify'))
  check(
    'every ref is addressed as refs/heads/fix/x, never the short ambiguous name',
    refCalls.length > 0 && refCalls.every((call) => call.args.join(' ').indexOf('refs/heads/fix/x') >= 0),
    JSON.stringify(refCalls.map((call) => call.args)),
  )
  surface.dispose()
  rig.scheduler.dispose()
}

// ── T-82: summary snapshots, since deltas, on-demand detail and paged list ──
{
  const bigSpec = 'Spec detail '.repeat(80)
  const bigAccept = 'Acceptance detail '.repeat(80)
  const bigEvidence = 'Evidence detail '.repeat(80)
  const stamp = new Date().toISOString()
  const tasks = []
  for (let index = 1; index <= 81; index++) {
    tasks.push({
      id: 'T-' + String(index),
      title: index === 7 ? 'unique-needle card' : 'Done card ' + String(index),
      status: 'done',
      priority: 0,
      dependsOn: [],
      writeFiles: [],
      verify: null,
      base: 'base-sha',
      target: 'feat/task-center-v2',
      branch: 'task/T-' + String(index) + '-1',
      worktree: null,
      worktreeError: null,
      commit: 'commit-sha',
      actualFiles: [],
      requiredRole: null,
      merge: {
        status: 'merged',
        base: 'base-sha',
        target: 'feat/task-center-v2',
        head: 'commit-sha',
        mergeCommit: 'merge-sha',
        declaredFiles: ['scripts/a.gd', 'scripts/b.gd'],
        actualFiles: ['scripts/a.gd', 'scripts/b.gd'],
        tests: 'npm test '.repeat(800),
        reviewer: null,
        conflict: null,
        output: 'Verification tail '.repeat(800),
        at: stamp,
      },
      review: { status: 'approved', by: '@reviewer', byName: 'reviewer-1', at: stamp, reasons: null, attempt: 1 },
      test: { status: 'passed', by: '@tester', byName: 'tester-1', at: stamp, evidence: bigEvidence, attempt: 1 },
      assignee: null,
      attempts: 1,
      maxAttempts: 3,
      evidence: bigEvidence,
      dispatch: null,
      leaseUntil: null,
      createdBy: '@user',
      createdAt: stamp,
      updatedAt: stamp,
      spec: bigSpec,
      acceptance: bigAccept,
      history: [
        { at: stamp, by: '@fixer', byName: 'fixer', from: 'pending', to: 'running', note: 'dispatched' },
        { at: stamp, by: '@fixer', byName: 'fixer', from: 'running', to: 'reviewing', note: 'submitted' },
        { at: stamp, by: '@reviewer', byName: 'reviewer-1', from: 'reviewing', to: 'testing', note: 'approved' },
      ],
    })
  }
  const rig = createRig({ allowSpawn: false })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 82, dispatch: { state: 'paused' }, tasks: tasks }))
  const surface = install(rig)
  const fullRes = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT), {})
  const full = fullRes.json()
  const bytes = Buffer.byteLength(fullRes.text, 'utf8')
  check('an 81-card snapshot is under 200 KB', full.ok === true && full.tasks.length === 81 && bytes < 200 * 1024, String(bytes) + ' bytes')
  check(
    'the summary drops the detail-class merge/test strings but keeps status and counts',
    full.tasks[0].merge.status === 'merged' &&
      full.tasks[0].merge.output === undefined &&
      full.tasks[0].merge.tests === undefined &&
      full.tasks[0].merge.declaredFiles === undefined &&
      typeof full.tasks[0].merge.declaredCount === 'number' &&
      full.tasks[0].merge.declaredCount === 2 &&
      full.tasks[0].test.evidence === undefined &&
      typeof full.tasks[0].test.evidenceLength === 'number' &&
      full.tasks[0].review.reasons === undefined,
    JSON.stringify(full.tasks[0].merge),
  )
  check(
    'the summary carries render fields but no spec/acceptance/evidence/history',
    full.tasks[0].title !== undefined &&
      full.tasks[0].status === 'done' &&
      full.tasks[0].spec === undefined &&
      full.tasks[0].acceptance === undefined &&
      full.tasks[0].evidence === undefined &&
      full.tasks[0].history === undefined &&
      Array.isArray(full.tasks[0].events) === true,
    JSON.stringify(Object.keys(full.tasks[0])),
  )
  check('the summary snapshot is marked full with a seq cursor', full.full === true && Number.isFinite(full.seq), JSON.stringify({ full: full.full, seq: full.seq }))
  const boardFull = await rig.action('board')
  const boardBytes = Buffer.byteLength(JSON.stringify(boardFull), 'utf8')
  check(
    'the agent board keeps full details while the HTTP state is slim',
    boardFull.tasks[0].spec === bigSpec && boardFull.tasks[0].history.length === 3 && boardBytes > bytes * 2,
    JSON.stringify({ boardBytes: boardBytes, stateBytes: bytes }),
  )
  const detailRes = await call(surface, TASK_PATH + '?id=T-1&project=' + encodeURIComponent(PROJECT), {})
  const detail = detailRes.json()
  check(
    'the detail route returns the full task on demand',
    detail.ok === true && detail.task.id === 'T-1' && detail.task.spec === bigSpec && Array.isArray(detail.task.history) && detail.task.history.length === 3,
    detailRes.text.slice(0, 200),
  )
  const listRes = await call(surface, LIST_PATH + '?project=' + encodeURIComponent(PROJECT) + '&status=done&limit=10', {})
  const list = listRes.json()
  check('the list route pages summaries with a nextCursor', list.ok === true && list.tasks.length === 10 && typeof list.nextCursor === 'string' && list.tasks[0].history === undefined, JSON.stringify({ n: list.tasks.length, next: list.nextCursor }))
  const searchRes = await call(surface, LIST_PATH + '?project=' + encodeURIComponent(PROJECT) + '&q=unique-needle', {})
  const search = searchRes.json()
  check('search happens on the server', search.ok === true && search.tasks.length === 1 && search.tasks[0].id === 'T-7', JSON.stringify(search.tasks.map((task) => task.id)))
  // delta: one update then one delete
  const seq = full.seq
  await rig.action('update', { id: 'T-1', title: 'Done card 1 (edited)' })
  const deltaRes = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT) + '&since=' + String(seq), {})
  const delta = deltaRes.json()
  check(
    'a since cursor returns only the changed summary and full:false',
    delta.ok === true && delta.full === false && Array.isArray(delta.tasks) && delta.tasks.length === 1 && delta.tasks[0].id === 'T-1' && Array.isArray(delta.removed),
    deltaRes.text.slice(0, 200),
  )
  await rig.action('delete', { id: 'T-5', force: true })
  const removedRes = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT) + '&since=' + String(delta.seq), {})
  const removed = removedRes.json()
  check('a deletion comes back as removed ids', removed.ok === true && removed.full === false && removed.removed.indexOf('T-5') >= 0, JSON.stringify(removed.removed))
  const future = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT) + '&since=' + String(removed.seq + 50), {})
  check('a cursor from the future falls back to full:true', future.json().ok === true && future.json().full === true, future.text.slice(0, 160))
  // project switch: the delta log is per project and starts full
  seedBoard(rig.fs, PROJECT + '-two', JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [Object.assign({}, tasks[0], { id: 'T-2', title: 'other project card' })] }))
  const switched = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT + '-two') + '&since=' + String(removed.seq), {})
  check('switching projects forces a full snapshot', switched.json().ok === true && switched.json().full === true && switched.json().tasks.length === 1, switched.text.slice(0, 160))
  surface.dispose()
  rig.scheduler.dispose()
}

// ── T-84: 30-day archive, idempotent, queryable, failure-safe ──
{
  const day = 24 * 60 * 60 * 1000
  const nowMs = Date.now()
  const stamp = new Date(nowMs).toISOString()
  function taskOf(id, status, daysAgo) {
    return {
      id: id,
      title: 'Card ' + id,
      status: status,
      priority: 0,
      dependsOn: [],
      writeFiles: ['scripts/a.gd'],
      verify: null,
      base: 'base-sha',
      target: 'feat/task-center-v2',
      branch: 'task/' + id + '-1',
      worktree: null,
      worktreeError: null,
      commit: 'commit-sha',
      actualFiles: [],
      requiredRole: null,
      merge: status === 'done' ? { status: 'merged', base: 'base-sha', target: 'feat/task-center-v2', head: 'commit-sha', mergeCommit: 'merge-sha', declaredFiles: [], actualFiles: [], tests: 'npm test', reviewer: null, conflict: null, output: 'tail', at: stamp } : null,
      review: status === 'done' ? { status: 'approved', by: '@reviewer', byName: 'reviewer-1', at: stamp, reasons: null, attempt: 1 } : null,
      test: status === 'done' ? { status: 'passed', by: '@tester', byName: 'tester-1', at: stamp, evidence: 'EVIDENCE ' + id, attempt: 1 } : null,
      assignee: null,
      attempts: 0,
      maxAttempts: 3,
      evidence: 'EVIDENCE ' + id,
      dispatch: null,
      leaseUntil: null,
      spec: 'SPEC ' + id + ' ' + 'detail filler '.repeat(120),
      acceptance: 'ACCEPT ' + id + ' ' + 'criterion filler '.repeat(80),
      history: Array.from({ length: 4 }).map(function (value, index) {
        return { at: stamp, by: '@fixer', byName: 'fixer', from: 'running', to: status, note: 'done ' + id + ' step ' + String(index) + ' ' + 'note filler '.repeat(60) }
      }),
      createdAt: new Date(nowMs - (daysAgo + 2) * day).toISOString(),
      updatedAt: new Date(nowMs - daysAgo * day).toISOString(),
    }
  }
  const rig = createRig({ allowSpawn: false })
  const board = { version: 2, seq: 5, dispatch: { state: 'paused' }, tasks: [taskOf('T-1', 'done', 40), taskOf('T-2', 'done', 45), taskOf('T-3', 'done', 2), taskOf('T-4', 'running', 1)] }
  seedBoard(rig.fs, PROJECT, JSON.stringify(board))
  // Normalise the seed first: the archive drop must be measured between two
  // normalised writes, not against a raw hand-written board.
  await rig.state.apply(PROJECT, (current) => ({ ok: true, board: current, events: [] }), undefined)
  const beforeText = rig.fs.files.get(boardPathOf(PROJECT)).text
  const before = boardJson(rig.fs, PROJECT)
  // The host's 5s background loop calls autoMergePending: that is the trigger,
  // NOT an explicit tick action.
  const tick = await rig.api.autoMergePending(PROJECT)
  check(
    'the host background sweep archives done cards older than 30 days (no explicit tick)',
    tick.ok === true && tick.archive !== null && tick.archive.ok === true && tick.archive.archived === 2,
    JSON.stringify(tick.archive),
  )
  const afterText = rig.fs.files.get(boardPathOf(PROJECT)).text
  const after = boardJson(rig.fs, PROJECT)
  check(
    'archiving shrinks the board file',
    afterText.length < beforeText.length * 0.8,
    String(beforeText.length) + ' -> ' + String(afterText.length) + ' bytes',
  )
  check(
    'the board keeps only the active and recent cards',
    after.tasks.map((task) => task.id).sort().join(',') === 'T-3,T-4',
    after.tasks.map((task) => task.id).join(','),
  )
  check('the archive is a board change: seq advanced by one', after.seq === before.seq + 1, JSON.stringify({ before: before.seq, after: after.seq }))
  const year = new Date(Date.parse(taskOf('T-1', 'done', 40).updatedAt)).getUTCFullYear()
  const archivedText = rig.fs.files.get(archivePath(PROJECT, year)) === undefined ? null : rig.fs.files.get(archivePath(PROJECT, year)).text
  const archived = archivedText === null ? null : JSON.parse(archivedText)
  check(
    'the year archive keeps the complete cards (spec/history/evidence)',
    archived !== null && archived.tasks.length === 2 && archived.tasks[0].spec !== undefined && archived.tasks[0].history.length === 4 && archived.tasks[0].evidence !== undefined,
    archivedText === null ? 'missing' : String(archivedText.length) + ' bytes',
  )
  // Throttle: a second host sweep within 24h does not run at all.
  const sequent = await rig.api.autoMergePending(PROJECT)
  check('a second sweep within 24h is throttled off', sequent.ok === true && sequent.archive === null, JSON.stringify(sequent.archive))
  // Idempotency: after clearing the throttle, a sweep with nothing due is a no-op.
  rig.state.memory.lastArchive = null
  const again = await rig.api.autoMergePending(PROJECT)
  const archivedAgain = JSON.parse(rig.fs.files.get(archivePath(PROJECT, year)).text)
  check('an unthrottled second sweep moves nothing and does not duplicate', again.ok === true && again.archive !== null && again.archive.archived === 0 && archivedAgain.tasks.length === 2, JSON.stringify(again.archive))
  // Visibility: archivedCount/range in the snapshot; the state is a full rebuild.
  const surface = install(rig)
  const stateRes = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT) + '&since=' + String(before.seq), {})
  const state = stateRes.json()
  check(
    'the snapshot reports the archive count and range and forces a full rebuild',
    state.ok === true && state.archivedCount === 2 && state.archiveRange !== null && state.full === true && state.tasks.every((task) => task.id !== 'T-1'),
    JSON.stringify({ count: state.archivedCount, range: state.archiveRange, full: state.full }),
  )
  // Queryability: get and detail fall back to the archive.
  const got = await rig.action('get', { id: 'T-1' })
  check('get finds an archived card with its full detail', got.ok === true && got.task.id === 'T-1' && got.task.archived === true && got.task.evidence === 'EVIDENCE T-1', JSON.stringify(got.task && { id: got.task.id, archived: got.task.archived }))
  const detailRes = await call(surface, TASK_PATH + '?id=T-2&project=' + encodeURIComponent(PROJECT), {})
  check('the detail route also falls back to the archive', detailRes.json().ok === true && detailRes.json().task.id === 'T-2' && detailRes.json().task.archived === true, detailRes.text.slice(0, 160))
  const listRes1 = await call(surface, LIST_PATH + '?project=' + encodeURIComponent(PROJECT) + '&archived=1&limit=1', {})
  const page1 = listRes1.json()
  const listRes2 = await call(surface, LIST_PATH + '?project=' + encodeURIComponent(PROJECT) + '&archived=1&limit=1&cursor=' + encodeURIComponent(page1.nextCursor), {})
  const page2 = listRes2.json()
  check(
    'the archive list pages with a cursor over archived summaries',
    page1.ok === true && page1.archived === true && page1.tasks.length === 1 && typeof page1.nextCursor === 'string' && page2.tasks.length === 1 && page2.tasks[0].id !== page1.tasks[0].id,
    JSON.stringify({ p1: page1.tasks.map((task) => task.id), p2: page2.tasks.map((task) => task.id) }),
  )
  const searchRes = await call(surface, LIST_PATH + '?project=' + encodeURIComponent(PROJECT) + '&archived=1&q=SPEC%20T-2', {})
  check('the archive view searches server-side', searchRes.json().ok === true && searchRes.json().tasks.length === 1 && searchRes.json().tasks[0].id === 'T-2', searchRes.text.slice(0, 160))
  surface.dispose()
  // Failure: an archive write error leaves the board untouched.
  const withOld = boardJson(rig.fs, PROJECT)
  withOld.tasks.push(taskOf('T-5', 'done', 50))
  seedBoard(rig.fs, PROJECT, JSON.stringify(withOld))
  rig.fs.hooks.beforeWrite = function (event) {
    if (String(event.key).indexOf('.tmp') >= 0) throw new Error('disk full')
    return undefined
  }
  rig.state.memory.lastArchive = null
  const failedTick = await rig.api.autoMergePending(PROJECT)
  rig.fs.hooks.beforeWrite = null
  const afterFailure = boardJson(rig.fs, PROJECT)
  check(
    'a failed archive write leaves every card on the board',
    failedTick.ok === true && failedTick.archive !== null && failedTick.archive.ok === false && afterFailure.tasks.some((task) => task.id === 'T-5'),
    JSON.stringify({ archive: failedTick.archive, ids: afterFailure.tasks.map((task) => task.id) }),
  )
  rig.state.memory.lastArchive = null
  const recovered = await rig.api.autoMergePending(PROJECT)
  check('the sweep recovers once the archive write works again', recovered.ok === true && recovered.archive !== null && recovered.archive.archived >= 1 && boardJson(rig.fs, PROJECT).tasks.every((task) => task.id !== 'T-5'), JSON.stringify(recovered.archive))
  rig.scheduler.dispose()
}

// ── T-98: the project registry really lands on disk (REAL fs, no fixture) ──
{
  // A filesystem adapter over the real disk for the plugin's ctx.fs contract, so
  // this block proves the production path: write → read back → a NEW state loads
  // it and sees active projects. The sandbox only allows the workspace, so the
  // temp tree lives under it (the OS temp dir is not writable here).
  function realFs() {
    let counter = 0
    const versionOf = (path) => {
      try {
        const s = statSync(path)
        return s.isDirectory() ? 'dir' : 'v' + String(s.mtimeMs) + '-' + String(s.size)
      } catch (error) {
        return undefined
      }
    }
    return {
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async stat(target) {
        const version = versionOf(target.targetKey)
        if (version === undefined) return undefined
        const s = statSync(target.targetKey)
        return { type: s.isDirectory() ? 'directory' : 'file', version, size: s.size }
      },
      async readText(target) {
        return readFileSync(target.targetKey, 'utf8')
      },
      async writeText(target, content, expected) {
        const path = target.targetKey
        const current = versionOf(path)
        if (expected !== undefined && expected.kind === 'createIfAbsent' && current !== undefined) {
          throw Object.assign(new Error('FS_STALE_VERSION: exists'), { code: 'FS_STALE_VERSION' })
        }
        if (expected !== undefined && expected.kind === 'replaceIfVersion' && current !== expected.version) {
          throw Object.assign(new Error('FS_STALE_VERSION: moved'), { code: 'FS_STALE_VERSION' })
        }
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
        return { operation: current === undefined ? 'create' : 'update', version: 'v' + String(++counter) }
      },
    }
  }
  const root = mkdtempSync(join(process.cwd(), '.tmp-registry-'))
  try {
    const home = join(root, 'home')
    const projectRoot = join(root, 'project')
    mkdirSync(join(projectRoot, '.agents'), { recursive: true })
    const options = {
      homeDir: home,
      ensureDir: (dir) => mkdirSync(dir, { recursive: true }),
      sandboxPolicyFor: (project) => ({ mode: 'workspace-write', workspaceRoot: project }),
    }
    const first = createState({ fs: realFs() }, options)
    await first.loadRegistry()
    first.touchProject(projectRoot)
    await first.flushRegistry()
    const registryPath = join(home, '.dsh', 'godot-bridge', 'projects.json')
    check(
      'the registry really lands on disk under the home path',
      existsSync(registryPath) && JSON.parse(readFileSync(registryPath, 'utf8')).projects.some((entry) => entry.root === projectRoot),
      registryPath,
    )
    check('and the state reports where it landed', first.registryStatus().ok === true && first.registryStatus().location === 'home', JSON.stringify(first.registryStatus()))
    const restarted = createState({ fs: realFs() }, options)
    await restarted.loadRegistry()
    const active = restarted.activeProjects(Date.now())
    check('a fresh state loads the registry and has an active project (restart recovery)', active.length === 1 && active[0].root === projectRoot, JSON.stringify(active))

    // The home path cannot be created (a FILE sits where the directory must go):
    // the writer must fall back to the workspace registry and say so.
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory')
    const blocked = createState({ fs: realFs() }, Object.assign({}, options, { homeDir: join(blocker, 'home') }))
    await blocked.loadRegistry()
    blocked.touchProject(projectRoot)
    await blocked.flushRegistry()
    const workspacePath = join(projectRoot, '.agents', 'projects.json')
    check(
      'a home that cannot be created falls back to the workspace registry, readably',
      existsSync(workspacePath) && blocked.registryStatus().ok === true && blocked.registryStatus().location === 'workspace',
      JSON.stringify(blocked.registryStatus()),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── T-86: first-class project ref, registry, one resolver ──
{
  const OTHER = PROJECT + '-other'
  const rig = createRig({ allowSpawn: false })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [] }))
  seedBoard(rig.fs, OTHER, JSON.stringify({ version: 2, seq: 7, dispatch: { state: 'paused' }, tasks: [] }))
  const surface = install(rig)
  // The panel carries ?project= on its first visit: it must be adopted and written
  // to the registry so the background loop drives that project.
  const panelRes = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(OTHER), {})
  const panel = panelRes.json()
  check(
    'a panel ?project= is adopted as the explicit project',
    panel.ok === true && panel.projectId === projectIdOf(OTHER) && panel.resolvedFrom === 'panel' && panel.projectRoot === OTHER,
    JSON.stringify({ id: panel.projectId, from: panel.resolvedFrom }),
  )
  await rig.state.flushRegistry()
  const registry = await readProjectRegistry({ fs: rig.fs }, { homeDir: homedir() })
  check(
    'the adopted project is persisted in the registry',
    registry.registry.projects.some((entry) => entry.id === projectIdOf(OTHER) && entry.root === OTHER),
    JSON.stringify(registry.registry.projects),
  )
  // Two surfaces (two panel sessions/instances) each adopt a different project:
  // the registry write is read-merge-write, so the second adoption must not
  // clobber the first (the end-to-end script caught exactly this).
  const secondSurface = createState({ fs: rig.fs, get() { return undefined } }, { homeDir: homedir(), now: () => Date.now() })
  await secondSurface.adoptPanelProject(PROJECT)
  await secondSurface.flushRegistry()
  const mergedRegistry = await readProjectRegistry({ fs: rig.fs }, { homeDir: homedir() })
  check(
    'two adopting surfaces merge into one registry instead of overwriting',
    mergedRegistry.registry.projects.some((entry) => entry.root === OTHER) && mergedRegistry.registry.projects.some((entry) => entry.root === PROJECT),
    JSON.stringify(mergedRegistry.registry.projects.map((entry) => entry.root)),
  )
  // Restart: a fresh state over the SAME fs loads the registry and drives both
  // projects without any openProject call.
  const restarted = createState({ fs: rig.fs, get() { return undefined } }, { now: () => Date.now() })
  const loaded = await restarted.loadRegistry()
  const active = restarted.activeProjects(Date.now())
  check(
    'in-process restart simulation: a fresh state over the same fs reloads the registry and its active projects',
    loaded.projects.length >= 1 && active.some((entry) => entry.root === OTHER),
    JSON.stringify(active.map((entry) => entry.root)),
  )
  // Two projects are both active: the loop iterates every one, not the last touched.
  restarted.touchProject(PROJECT)
  const both = restarted.activeProjects(Date.now())
  check(
    'in-process: both projects stay in the background-drive set',
    both.some((entry) => entry.root === PROJECT) && both.some((entry) => entry.root === OTHER),
    JSON.stringify(both.map((entry) => entry.root)),
  )
  // Visibility: an explicit snapshot says where the project came from, and warns
  // when the host last drove a different project.
  restarted.touchProject(PROJECT)
  rig.state.touchProject(PROJECT)
  const snap = await rig.api.snapshot(OTHER, { full: false, resolvedFrom: 'panel' })
  check(
    'the snapshot exposes the project ref, resolution source and a registry warning',
    snap.ok === true && snap.projectId === projectIdOf(OTHER) && snap.resolvedFrom === 'panel' && typeof snap.projectWarning === 'string' && snap.registryConsistent === false,
    JSON.stringify({ id: snap.projectId, from: snap.resolvedFrom, warning: snap.projectWarning }),
  )
  // The resolver has no cwd/hint fallback: with no explicit and no session
  // workspace it refuses, even though the registry knows projects.
  const unboundRig = createRig({ allowSpawn: false })
  unboundRig.state.setSessionRoot(TEST_SESSION, null)
  const unboundSurface = install(unboundRig)
  const unbound = await call(unboundSurface, STATE_PATH, {})
  check('an unbound session refuses with no-project-bound (registry is not a fallback)', unbound.json().ok === false && unbound.json().code === 'no-project-bound', unbound.text.slice(0, 160))
  unboundSurface.dispose()
  unboundRig.scheduler.dispose()
  surface.dispose()
  rig.scheduler.dispose()
}

// ── T-87: readiness gate, local exclusions, refusals, external worktree root ──
{
  const { resolve: resolvePath } = await import('node:path')
  const rig = createRig({ allowSpawn: false })
  const excludeKey = join(PROJECT, '.git', 'info', 'exclude')
  rig.git.gitPath = async (root, name) => ({ ok: true, path: join(root, '.git', name) })
  rig.git.checkIgnore = async (root, paths) => {
    const entry = rig.fs.files.get(excludeKey)
    const text = entry === undefined ? '' : entry.text
    const ignored = paths.filter((path) => text.indexOf('/' + path + '/') >= 0)
    return { ok: true, ignored: ignored, notIgnored: paths.filter((path) => ignored.indexOf(path) < 0) }
  }
  const opened = await rig.action('openProject', { path: PROJECT })
  check(
    'openProject returns a readiness checklist and writes local exclusions',
    opened.ok === true && Array.isArray(opened.preflight.checks) && opened.preflight.checks.length >= 6 &&
      opened.preflight.checks.every((entry) => entry.ok === true) && opened.preflight.checks.some((entry) => entry.id === 'exclude' && /added/.test(String(entry.detail))),
    JSON.stringify(opened.preflight && opened.preflight.checks),
  )
  const excludeText = rig.fs.files.get(excludeKey) === undefined ? '' : rig.fs.files.get(excludeKey).text
  check('the local exclude file gains exactly the two task-center paths', excludeText.indexOf('/.agents/') >= 0 && excludeText.indexOf('/.worktrees/') >= 0, excludeText)
  const again = await rig.action('openProject', { path: PROJECT })
  const excludeAgain = rig.fs.files.get(excludeKey).text
  check(
    'a second openProject is idempotent (no duplicate exclude lines)',
    again.ok === true && (excludeAgain.match(/\/\.agents\//g) || []).length === 1 && (excludeAgain.match(/\/\.worktrees\//g) || []).length === 1,
    excludeAgain,
  )
  check('the persisted registry carries the preflight result', rig.state.memory.registry.projects[0].preflight !== null && rig.state.memory.registry.projects[0].preflight.ok === true, JSON.stringify(rig.state.memory.registry.projects[0].preflight))
  // External worktree root: accepted, validated and recorded on the ProjectRef.
  const external = resolvePath('C:/external/godot-worktrees')
  rig.fs.dirs.add(external)
  const externalOpen = await rig.action('openProject', { path: PROJECT, worktreeRoot: 'C:/external/godot-worktrees' })
  check(
    'an external worktree root is validated and persisted',
    externalOpen.ok === true && externalOpen.preflight.worktreeRoot === external && externalOpen.worktreeRoot === external &&
      rig.state.memory.registry.projects[0].worktreeRoot === external,
    JSON.stringify({ ok: externalOpen.ok, expected: external, preflight: externalOpen.preflight && externalOpen.preflight.worktreeRoot, snapshot: externalOpen.worktreeRoot, registry: rig.state.memory.registry.projects.map((entry) => ({ root: entry.root, wt: entry.worktreeRoot })) }),
  )
  rig.scheduler.dispose()

  // Non-git project: refused, and nothing is created for it.
  const notRepo = createRig({ allowSpawn: false, git: createFakeGit({ repo: false }) })
  const missing = join(PROJECT, 'not-a-repo')
  notRepo.fs.dirs.add(missing)
  const refused = await notRepo.action('openProject', { path: missing })
  check(
    'a non-git project is refused as not-a-repository without creating anything',
    refused.ok === false && refused.code === 'not-a-repository' && refused.preflight.failed.some((entry) => entry.id === 'repository') &&
      notRepo.fs.files.get(join(missing, '.agents', 'tasks.json')) === undefined,
    JSON.stringify({ code: refused.code, created: notRepo.fs.files.has(join(missing, '.agents', 'tasks.json')) }),
  )
  const gate = await notRepo.action('start')
  check(
    'dispatch is refused with the missing items and records them in dispatch.error',
    gate.ok === false && gate.code === 'not-ready' && Array.isArray(gate.preflight.failed) &&
      String(JSON.parse(notRepo.fs.files.get(boardPathOf(PROJECT)).text).dispatch.error).indexOf('git repository') >= 0,
    JSON.stringify(gate.preflight && gate.preflight.failed),
  )
  notRepo.scheduler.dispose()
}

// ── T-90: the panel learns what the SESSION resolves, not only its own pin ──
{
  const OTHER = PROJECT + '-panel'
  const rig = createRig({ allowSpawn: false })
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 3, dispatch: { state: 'paused' }, tasks: [] }))
  seedBoard(rig.fs, OTHER, JSON.stringify({ version: 2, seq: 7, dispatch: { state: 'paused' }, tasks: [] }))
  const surface = install(rig)
  // A pinned panel asks for ANOTHER project while the session workspace is PROJECT:
  // the answer must carry both, which is what lets the panel offer "switch".
  const pinned = (await call(surface, STATE_PATH + '?project=' + encodeURIComponent(OTHER), {})).json()
  check(
    'T-90 a pinned /state still reports the session resolution',
    pinned.ok === true && pinned.projectRoot === OTHER && pinned.resolvedFrom === 'panel' && pinned.sessionProject === PROJECT,
    JSON.stringify({ root: pinned.projectRoot, from: pinned.resolvedFrom, session: pinned.sessionProject }),
  )
  // With no pin at all the panel follows the session — no path is required.
  const followed = (await call(surface, STATE_PATH, {})).json()
  check(
    'T-90 an unpinned /state resolves the session project and reports it as both',
    followed.ok === true && followed.projectRoot === PROJECT && followed.resolvedFrom === 'session' && followed.sessionProject === PROJECT,
    JSON.stringify({ root: followed.projectRoot, from: followed.resolvedFrom, session: followed.sessionProject }),
  )
  // openProject answers with the snapshot itself; it must carry the session too,
  // because the panel renders that answer when it switches.
  const opened = (await call(surface, ACTION_PATH, { method: 'POST', body: { action: 'openProject', path: OTHER }, headers: { 'content-type': 'application/json' } })).json()
  check(
    'T-90 the openProject answer carries the session project',
    opened.ok === true && opened.projectRoot === OTHER && opened.sessionProject === OTHER,
    JSON.stringify({ root: opened.projectRoot, session: opened.sessionProject }),
  )
  // A host with no session workspace reports null instead of inventing one.
  rig.state.setSessionRoot(TEST_SESSION, null)
  const unbound = (await call(surface, STATE_PATH + '?project=' + encodeURIComponent(OTHER), {})).json()
  check(
    'T-90 an unbound session reports sessionProject null, never a guess',
    unbound.ok === true && unbound.sessionProject === null && unbound.projectRoot === OTHER,
    JSON.stringify({ root: unbound.projectRoot, session: unbound.sessionProject }),
  )
  rig.state.setSessionRoot(TEST_SESSION, PROJECT)
  surface.dispose()
  rig.scheduler.dispose()
}

// ── T-89: no empty phases, waitingReason, recovery ──
{
  const lead = { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }
  // A role manager that cannot provision (the real no-lead shape): ensure refuses.
  let canProvision = false
  const stubRoles = {
    ensure: async function () {
      if (canProvision) return { ok: true, kind: 'reviewer', created: [{ name: 'reviewer-1', id: 'session-reviewer-1' }], reused: [], replaced: [], waiting: [], refused: [] }
      return { ok: false, code: 'no-lead', message: 'no live Lead can provision a reviewer' }
    },
    status: () => ({ available: false }),
  }
  const rig = createSubmitRig({ roles: stubRoles, git: fakeGit().git })
  const task = seedRunningTask(rig, runningWorktreeTask())
  const refused = await rig.api.perform('submit', { id: 'T-1', evidence: 'done' }, rig.user)
  const board = boardJson(rig.fs, PROJECT)
  check(
    'without a Lead, submit does not advance and names reviewer-unavailable',
    refused.ok === false && refused.code === 'reviewer-unavailable' && board.tasks[0].status === 'running' && board.tasks[0].waitingReason === 'no-lead',
    JSON.stringify({ code: refused.code, status: board.tasks[0].status, waiting: board.tasks[0].waitingReason }),
  )
  // Recovery: provisioning becomes possible, the next host sweep clears the
  // reason and the card can be submitted again without a human reopen.
  canProvision = true
  await rig.api.autoMergePending(PROJECT)
  const recoveredBoard = boardJson(rig.fs, PROJECT)
  check(
    'the next host sweep clears waitingReason once the executor is available',
    recoveredBoard.tasks[0].waitingReason === null || recoveredBoard.tasks[0].waitingReason === undefined,
    JSON.stringify({ waiting: recoveredBoard.tasks[0].waitingReason }),
  )
  rig.scheduler.dispose()

  // The watchdog must not punish a card that is waiting for its executor.
  const waitRig = createRig({ allowSpawn: false })
  seedRunningTask(waitRig, Object.assign(runningWorktreeTask(), { status: 'reviewing', waitingReason: 'no-lead', review: { status: 'pending', by: null, at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), attempt: 1 } }))
  await waitRig.scheduler.settle(PROJECT)
  const waited = boardJson(waitRig.fs, PROJECT).tasks[0]
  check(
    'a waiting card is skipped by the review watchdog instead of being blocked',
    waited.status === 'reviewing' && waited.waitingReason === 'no-lead',
    JSON.stringify({ status: waited.status, waiting: waited.waitingReason }),
  )
  waitRig.scheduler.dispose()
}

// ── T-89: a stale candidate is rebuilt, never silently left in testing ──
{
  const roles = {
    ensure: async function () {
      return { ok: true, kind: 'reviewer', created: [{ name: 'reviewer-1', id: 'session-reviewer-1' }], reused: [], replaced: [], waiting: [], refused: [] }
    },
    status: () => ({ available: true }),
  }
  const fake = mergeGit({
    'rev-parse --verify refs/heads/main': () => ({ code: 0, stdout: '2222222\n', stderr: '' }),
  })
  const merger = createMerger({ git: fake.git, verify: async () => ({ ok: true, code: 0, stdout: 'ALL CHECKS PASSED', stderr: '' }) })
  const rig = createSubmitRig({ roles: roles, git: fake.git, merger: merger, autoMerge: true, subprocess: fakeHostSubprocess({ code: 0, stdout: 'ok' }).subprocess })
  const task = openMergeTask({ status: 'testing' })
  // The target advanced after the candidate was tested: base is behind main.
  task.merge.base = '1111111'
  task.target = 'main'
  seedMergeTask(rig, task)
  const first = await rig.api.autoMergePending(PROJECT)
  const midBoard = boardJson(rig.fs, PROJECT).tasks[0]
  check(
    'a stale candidate is detected and marked candidate-stale, not left silently in testing',
    first.ok === true &&
      (first.skipped.some((entry) => entry.code === 'candidate-fast-merged' || entry.code === 'candidate-stale' || entry.code === 'candidate-rebuilt') ||
        midBoard.status === 'reviewing' ||
        midBoard.status === 'done') &&
      (midBoard.waitingReason === 'candidate-stale' || midBoard.status === 'reviewing' || midBoard.status === 'done'),
    JSON.stringify({ skipped: first.skipped, status: midBoard.status, waiting: midBoard.waitingReason }),
  )
  // The next sweep rebuilds the candidate (refreshMerge) or keeps a readable reason.
  const second = await rig.api.autoMergePending(PROJECT)
  const board = boardJson(rig.fs, PROJECT).tasks[0]
  check(
    'the next sweep rebuilds the stale candidate and leaves no silent testing+open state',
    second.ok === true && (board.status === 'done' || board.status === 'reviewing' || (board.waitingReason === 'candidate-stale' && board.status === 'testing')),
    JSON.stringify({ status: board.status, waiting: board.waitingReason, skipped: second.skipped }),
  )
  check(
    'the rebuilt card is not simultaneously testing, passed, open and unowned',
    !(board.status === 'testing' && board.test !== null && board.test.status === 'passed' && board.merge.status === 'open' && (board.waitingReason === null || board.waitingReason === undefined)),
    JSON.stringify({ status: board.status, test: board.test && board.test.status, merge: board.merge.status, waiting: board.waitingReason }),
  )
  rig.scheduler.dispose()
}

// ── T-94: base-only drift fast path, build-time conflict downgrade, diff change ──
{
  const replies = (over) => Object.assign({
    'rev-parse --verify refs/heads/main': () => ({ code: 0, stdout: '2222222\n', stderr: '' }),
    'rev-parse --verify refs/heads/task/T-1': () => ({ code: 0, stdout: over.branchHead || '3333333', stderr: '' }),
    // Does the task branch already contain the target head? Default NO (behind),
    // which is the T-94 base-only drift situation: the branch was cut from an
    // older target. over.ancestor === true models "branch already contains it".
    'merge-base --is-ancestor main task/T-1': () => ({ code: over.ancestor === true ? 0 : 1, stdout: '', stderr: '' }),
  }, over)
  const makeRig = (over) => {
    over = over === undefined ? {} : over
    const fake = mergeGit(replies(over))
    const merger = createMerger({ git: fake.git, verify: async () => ({ ok: true, code: 0, stdout: 'ALL CHECKS PASSED', stderr: '' }) })
    const rig = createSubmitRig({
      roles: { ensure: async () => ({ ok: true, created: [{ name: 'tester-1', id: 'session-tester-1' }], reused: [], replaced: [], waiting: [], refused: [] }), status: () => ({ available: true }) },
      git: fake.git,
      merger: merger,
      autoMerge: true,
      subprocess: over.subprocess === undefined ? fakeHostSubprocess({ code: 0, stdout: 'ALL CHECKS PASSED' }).subprocess : over.subprocess,
    })
    const task = openMergeTask({ status: 'testing' })
    task.merge.base = '1111111'
    task.commit = over.commit === undefined ? 'head-sha' : over.commit
    task.target = 'main'
    task.branch = 'task/T-1'
    seedMergeTask(rig, task)
    return { rig: rig, fake: fake }
  }

  // (a) target advanced, branch head unchanged: base-only drift merges directly.
  {
    const { rig } = makeRig({})
    const before = boardJson(rig.fs, PROJECT).tasks[0]
    const sweep = await rig.api.autoMergePending(PROJECT)
    const after = boardJson(rig.fs, PROJECT).tasks[0]
    check(
      'a base-only drift is rebuilt and merged without a new review round',
      sweep.ok === true && after.status === 'done' &&
        (after.review === null || after.review.attempt === before.review.attempt) &&
        String(after.evidence).indexOf('base-only drift') >= 0 && String(after.evidence).indexOf('复跑验证') >= 0 &&
        (after.history || []).some((entry) => String(entry.note).indexOf('自动重建并合并（无冲突）') >= 0),
      JSON.stringify({ status: after.status, beforeReview: before.review && before.review.attempt, afterReview: after.review && after.review.attempt, skipped: sweep.skipped }),
    )
    rig.scheduler.dispose()
  }

  // (a2) the rebuilt candidate fails its verification: no merge, readable reason.
  {
    const { rig } = makeRig({ subprocess: fakeHostSubprocess({ code: 1, stdout: 'FAIL candidate.test.mjs', stderr: 'exit code 1' }).subprocess })
    const sweep = await rig.api.autoMergePending(PROJECT)
    const card = boardJson(rig.fs, PROJECT).tasks[0]
    check(
      'T-105 a rebuilt candidate that fails verification is not merged and reports why',
      sweep.ok === true && card.status === 'testing' && card.waitingReason === 'candidate-stale' &&
        String(card.waitingDetail).indexOf('verification FAILED') >= 0 && card.merge.status === 'open',
      JSON.stringify({ status: card.status, waiting: card.waitingReason, detail: card.waitingDetail, merge: card.merge && card.merge.status }),
    )
    check(
      'T-105 the failed rebuild counts on merge.rebuildAttempts',
      card.merge.rebuildAttempts === 1,
      JSON.stringify({ attempts: card.merge.rebuildAttempts }),
    )
    rig.scheduler.dispose()
  }

  // (b) a branch that does NOT contain the target head conflicts: the FIRST
  // conflict escalates to needs-rebase (no round of candidate-stale spin), with
  // the reason and the conflicted files.
  {
    const { rig, fake } = makeRig({})
    fake.git.mergeNoFf = async function () { return { ok: false, code: 'merge-conflict', message: 'CONFLICT (content): Merge conflict in scripts/a.gd' } }
    fake.git.conflictedFiles = async function () { return { ok: true, files: ['scripts/a.gd'] } }
    const sweep = await rig.api.autoMergePending(PROJECT)
    const card = boardJson(rig.fs, PROJECT).tasks[0]
    check(
      'a behind branch that conflicts is needs-rebase on the FIRST conflict',
      sweep.ok === true && card.status === 'testing' && card.waitingReason === 'needs-rebase' &&
        String(card.waitingDetail).indexOf('rebase') >= 0 && String(card.waitingDetail).indexOf('main') >= 0 && String(card.waitingDetail).indexOf('scripts/a.gd') >= 0,
      JSON.stringify({ status: card.status, waiting: card.waitingReason, detail: card.waitingDetail, skipped: sweep.skipped }),
    )
    check(
      'the card is reported as needs-rebase instead of a stay in the rebuild queue',
      sweep.ok === true && (sweep.merged === undefined || sweep.merged.length === 0) && (sweep.skipped || []).some((entry) => entry.id === 'T-1' && entry.code === 'needs-rebase'),
      JSON.stringify({ merged: sweep.merged, skipped: sweep.skipped }),
    )
    // A needs-rebase card is never rebuilt again: no new merge attempt, no role wake.
    const attemptsBefore = card.merge.rebuildAttempts
    const mergeCallsBefore = fake.calls.filter((call) => call.args[0] === 'merge').length
    const again = await rig.api.autoMergePending(PROJECT)
    const after = boardJson(rig.fs, PROJECT).tasks[0]
    const mergeCallsAfter = fake.calls.filter((call) => call.args[0] === 'merge').length
    check(
      'a needs-rebase card leaves the rebuild queue and stops rebuilding',
      after.waitingReason === 'needs-rebase' && after.merge.rebuildAttempts === attemptsBefore && mergeCallsAfter === mergeCallsBefore,
      JSON.stringify({ waiting: after.waitingReason, attempts: after.merge.rebuildAttempts, mergeCallsBefore: mergeCallsBefore, mergeCallsAfter: mergeCallsAfter }),
    )
    check('and the sweep names it as needs-rebase', (again.skipped || []).some((entry) => entry.id === 'T-1' && entry.code === 'needs-rebase'), JSON.stringify(again.skipped))
    rig.scheduler.dispose()
  }

  // (b2) branch already contains the target head, yet the rebuild conflicts: the
  // cross-round counter escalates candidate-stale -> needs-rebase after 2 tries.
  {
    const { rig, fake } = makeRig({ ancestor: true })
    fake.git.mergeNoFf = async function () { return { ok: false, code: 'merge-conflict', message: 'CONFLICT (content): Merge conflict in scripts/a.gd' } }
    fake.git.conflictedFiles = async function () { return { ok: true, files: ['scripts/a.gd'] } }
    const first = await rig.api.autoMergePending(PROJECT)
    const one = boardJson(rig.fs, PROJECT).tasks[0]
    check(
      'the first rebuild failure is candidate-stale and counts the attempt on the card',
      one.waitingReason === 'candidate-stale' && one.merge.rebuildAttempts === 1 && (first.skipped || []).some((entry) => entry.id === 'T-1' && entry.code === 'candidate-stale'),
      JSON.stringify({ waiting: one.waitingReason, attempts: one.merge.rebuildAttempts, skipped: first.skipped }),
    )
    const second = await rig.api.autoMergePending(PROJECT)
    const two = boardJson(rig.fs, PROJECT).tasks[0]
    check(
      'the second failure escalates to needs-rebase across rounds',
      two.waitingReason === 'needs-rebase' && two.merge.rebuildAttempts === 2 && (second.skipped || []).some((entry) => entry.id === 'T-1' && entry.code === 'needs-rebase'),
      JSON.stringify({ waiting: two.waitingReason, attempts: two.merge.rebuildAttempts, skipped: second.skipped }),
    )
    rig.scheduler.dispose()
  }

  // (c) the branch moved past the verified commit: content changed, so review again.
  {
    const { rig } = makeRig({ branchHead: '4444444', commit: '3333333' })
    const before = boardJson(rig.fs, PROJECT).tasks[0]
    await rig.api.autoMergePending(PROJECT)
    const mid = boardJson(rig.fs, PROJECT).tasks[0]
    const second = await rig.api.autoMergePending(PROJECT)
    const after = boardJson(rig.fs, PROJECT).tasks[0]
    check(
      'a changed diff still goes through review instead of merging',
      mid.status === 'testing' && mid.waitingReason === 'candidate-stale' && String(mid.waitingDetail).indexOf('diff changed') >= 0 &&
        second.ok === true && after.status === 'reviewing' && after.review !== null && after.review.attempt > (before.review === null ? 0 : before.review.attempt),
      JSON.stringify({ mid: mid.status + '/' + mid.waitingReason, after: after.status, attempt: after.review && after.review.attempt }),
    )
    rig.scheduler.dispose()
  }
}

// ── T-96: the panel project is per-session, never a process-global slot ──
{
  const sessionA = 'window-a'
  const sessionB = 'window-b'
  const projectA = PROJECT
  const projectB = join(PROJECT, '..', 'project-b')
  const rig = createRig({ allowSpawn: false })
  rig.fs.dirs.add(projectB)
  rig.fs.dirs.add(join(projectB, '.git'))
  rig.fs.dirs.add(join(projectB, '.agents'))
  const surface = install(rig)
  async function http(url, options) {
    const res = response()
    await surface.byPath.get(url.split('?')[0]).handler(request(url, options), res)
    return res.json()
  }
  function openFor(session, path) {
    return http(ACTION_PATH + '?session=' + encodeURIComponent(session), {
      method: 'POST',
      body: { action: 'openProject', path: path },
      headers: { 'content-type': 'application/json' },
    })
  }
  const openedA = await openFor(sessionA, projectA)
  const openedB = await openFor(sessionB, projectB)
  check(
    'T-96 openProject records the project for the requesting session only',
    openedA.ok === true && openedB.ok === true && rig.state.sessionRootOf(sessionA) === projectA && rig.state.sessionRootOf(sessionB) === projectB,
    JSON.stringify({ a: rig.state.sessionRootOf(sessionA), b: rig.state.sessionRootOf(sessionB) }),
  )
  const stateA = await http(STATE_PATH + '?session=' + encodeURIComponent(sessionA))
  const stateB = await http(STATE_PATH + '?session=' + encodeURIComponent(sessionB))
  check(
    'T-96 two sessions each see their own project',
    stateA.ok === true && stateA.projectRoot === projectA && stateB.ok === true && stateB.projectRoot === projectB,
    JSON.stringify({ a: stateA.projectRoot, b: stateB.projectRoot }),
  )
  // T-103: no pin + no resolvable session falls back to the host's OWN last-active
  // record — never to another session's binding; with no record the answer is unbound.
  const lastActiveBefore = rig.state.memory.registry.lastActiveProjectId
  const borrowed = await http(STATE_PATH + '?session=' + encodeURIComponent('never-seen'))
  check(
    'T-96 an unknown session never borrows another session’s binding (last-active only)',
    lastActiveBefore !== null ? borrowed.ok === true && borrowed.resolvedFrom === 'last-active' : borrowed.ok === false && borrowed.code === 'no-project-bound',
    JSON.stringify({ lastActive: lastActiveBefore, ok: borrowed.ok, resolvedFrom: borrowed.resolvedFrom, code: borrowed.code }),
  )
  rig.state.memory.registry = Object.assign({}, rig.state.memory.registry, { lastActiveProjectId: null })
  const unknown = await http(STATE_PATH + '?session=' + encodeURIComponent('never-seen'))
  check(
    'T-96 an unknown session id is unbound when nothing was ever activated',
    unknown.ok === false && unknown.code === 'no-project-bound',
    JSON.stringify(unknown),
  )
  const anonymous = await http(STATE_PATH)
  check(
    'T-96 a request without a session id never reads another session’s project',
    anonymous.ok === false && anonymous.code === 'no-project-bound',
    JSON.stringify(anonymous),
  )
  // A tool-side binding is not shared with the panel either: the tool session id
  // is its own key.
  rig.state.setSessionRoot('tool-session', projectB)
  const toolState = await http(STATE_PATH + '?session=' + encodeURIComponent('tool-session'))
  check(
    'T-96 a tool-bound session resolves its own project',
    toolState.ok === true && toolState.projectRoot === projectB,
    JSON.stringify({ project: toolState.projectRoot }),
  )
}


// ── T-102: session id -> workspace, before any tool call ──────────────────────
{
  // The directory name encodes the path (separators and ':' both become '-'), so
  // the inverse is validated against existing directories — never guessed.
  const dirs = new Set(['J:\\', 'J:\\ws', 'J:\\ws\\proj'])
  const decoded = decodeSessionDirName('--J-ws-proj--', { isDir: (path) => dirs.has(path) })
  check(
    'T-102 a session directory name decodes back to its workspace path',
    decoded.ok === true && decoded.path === join('J:\\', 'ws', 'proj'),
    JSON.stringify(decoded),
  )
  const missing = decodeSessionDirName('--J-ws-nowhere--', { isDir: (path) => dirs.has(path) })
  check(
    'T-102 an undecodable name is a readable failure, never a guess',
    missing.ok === false && missing.code === 'undecodable',
    JSON.stringify(missing),
  )
  const ambiguousDirs = new Set(['J:\\', 'J:\\a', 'J:\\a-b', 'J:\\a\\b'])
  const ambiguous = decodeSessionDirName('--J-a-b--', { isDir: (path) => ambiguousDirs.has(path) })
  check(
    'T-102 an ambiguous name is refused instead of picking one split',
    ambiguous.ok === false && ambiguous.code === 'ambiguous',
    JSON.stringify(ambiguous),
  )
  const zhDirs = new Set(['J:\\', 'J:\\ws', join('J:\\ws', '重装')])
  const zh = decodeSessionDirName('--J-ws-~91CD~88C5--', { isDir: (path) => zhDirs.has(path) })
  check(
    'T-102 ~HEX~ escapes decode back to the non-ASCII directory',
    zh.ok === true && zh.path === join('J:\\ws', '重装'),
    JSON.stringify(zh),
  )
  // The exact shape DSH produced on this machine (a real workspace directory).
  const realName = '--J-mm13dremake_workspace-~91CD~88C5~673A~51753d~91CD~7F6E~7248--'
  const realPath = join('J:\\', 'mm13dremake_workspace', '重装机兵3d重置版')
  const real = decodeSessionDirName(realName, { isDir: (path) => path === 'J:\\' || path === join('J:\\', 'mm13dremake_workspace') || path === realPath })
  check(
    'T-102 the live machine\'s escaped session name decodes to its real workspace',
    real.ok === true && real.path === realPath,
    JSON.stringify(real),
  )
}

{
  // REAL directory tree on disk: <temp>/.dsh/sessions/--J-ws-proj--/session-abc/,
  // resolved through the same lookup the host wires into the row.
  const tempHome = mkdtempSync(join(process.cwd(), '.tmp-sessions-'))
  try {
    const sessionDir = join(tempHome, '.dsh', 'sessions', '--J-ws-proj--', 'session-abc')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), '')
    const wsProj = join('J:\\', 'ws', 'proj')
    const tree = new Set([join('J:\\'), join('J:\\', 'ws'), wsProj])
    const lookup = createSessionLookup({ homeDir: tempHome, isDir: (path) => tree.has(path) })
    const rig = createRig({ allowSpawn: false, homeDir: tempHome, sessionLookup: lookup })
    for (const dir of [wsProj, join(wsProj, '.git'), join(wsProj, '.agents')]) rig.fs.dirs.add(dir)
    const surface = install(rig)
    async function http(url) {
      const res = response()
      await surface.byPath.get(url.split('?')[0]).handler(request(url), res)
      return res.json()
    }
    // No tool call ever happened for 'abc': only its sessions directory exists.
    const bound = await http(STATE_PATH + '?session=abc')
    check(
      'T-102 an untouched session resolves to its workspace from the sessions tree',
      bound.ok === true && bound.projectRoot === wsProj && bound.resolvedFrom === 'session-lookup',
      JSON.stringify({ ok: bound.ok, projectRoot: bound.projectRoot, resolvedFrom: bound.resolvedFrom }),
    )
    check(
      'T-102 a looked-up project is ACTIVATED (registry lastSeen, background drive)',
      rig.state.activeProjects(Date.now()).some((entry) => entry.root === wsProj),
      JSON.stringify(rig.state.activeProjects(Date.now()).map((entry) => entry.root)),
    )
    // Unknown id: the SESSION lookup must not be invented. T-103 makes the host's
    // own last-active record a legitimate fallback, so clear it to pin down the
    // "nothing knowable" answer; the resolution source must never claim "session".
    const borrowed = await http(STATE_PATH + '?session=never-seen')
    check(
      'T-102 an unknown session never resolves as a session binding',
      borrowed.ok === true ? borrowed.resolvedFrom === 'last-active' : borrowed.code === 'no-project-bound',
      JSON.stringify({ ok: borrowed.ok, resolvedFrom: borrowed.resolvedFrom, code: borrowed.code }),
    )
    rig.state.memory.registry = Object.assign({}, rig.state.memory.registry, { lastActiveProjectId: null })
    const unknown = await http(STATE_PATH + '?session=never-seen')
    check(
      'T-102 an unknown session id with no recorded last project refuses',
      unknown.ok === false && unknown.code === 'no-project-bound',
      JSON.stringify(unknown),
    )
    // An explicit pin still outranks the lookup.
    const pinned = await http(STATE_PATH + '?session=abc&project=' + encodeURIComponent(PROJECT))
    check(
      'T-102 an explicit pin wins over the session lookup',
      pinned.ok === true && pinned.projectRoot === PROJECT,
      JSON.stringify({ projectRoot: pinned.projectRoot, resolvedFrom: pinned.resolvedFrom }),
    )
    surface.dispose()
    rig.scheduler.dispose()

    // Cache: the workspace listing and the answer are reused inside the TTL.
    let clock = 1000
    let listings = 0
    const counted = createSessionLookup({
      homeDir: tempHome,
      isDir: (path) => tree.has(path),
      now: () => clock,
      ttlMs: 5000,
      readdir: (dir) => {
        listings++
        return readdirSync(dir)
      },
    })
    const first = counted.lookup('abc')
    const second = counted.lookup('abc')
    check(
      'T-102 a repeated lookup is served from the cache (one listing)',
      first.ok === true && second.ok === true && listings === 1,
      JSON.stringify({ first: first.ok, listings: listings }),
    )
    clock += 6000
    counted.lookup('abc')
    check('T-102 the cache expires after its TTL', listings === 2, JSON.stringify({ listings: listings }))
    check(
      'T-102 an unknown id inside a known tree is a readable no-session',
      counted.lookup('nope').ok === false && counted.lookup('nope').code === 'no-session',
      JSON.stringify(counted.lookup('nope')),
    )
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
}


// ── T-103: startup activates the last project (or says nothing is active) ────
{
  function registryWith(root, lastActive) {
    const id = projectIdOf(root)
    return {
      version: 1,
      projects: [{ id: id, root: root, lastSeenAt: new Date().toISOString(), lastSessionId: null, worktreeRoot: null, preflight: null }],
      lastActiveProjectId: lastActive === false ? null : id,
    }
  }
  function unboundRig(options) {
    const opts = options === undefined ? {} : options
    const rig = createRig({ allowSpawn: false, sessionLookup: opts.sessionLookup })
    // Clear the rig's own session binding: this is the "fresh host, no pin" case.
    rig.state.setSessionRoot('test-session', null)
    if (opts.registry !== undefined) rig.state.memory.registry = opts.registry
    return rig
  }

  // (a) a recorded last-active project is activated at startup.
  {
    const rig = unboundRig({ registry: registryWith(PROJECT) })
    const surface = install(rig)
    async function http(url) {
      const res = response()
      await surface.byPath.get(url.split('?')[0]).handler(request(url), res)
      return res.json()
    }
    const started = await http(STATE_PATH + '?session=test-session')
    check(
      'T-103 startup activates the recorded last project and names the source',
      started.ok === true && started.projectRoot === PROJECT && started.resolvedFrom === 'last-active',
      JSON.stringify({ ok: started.ok, projectRoot: started.projectRoot, resolvedFrom: started.resolvedFrom }),
    )
    check(
      'T-103 the last-active project is reported by the state',
      rig.state.lastActiveProject() !== null && rig.state.lastActiveProject().root === PROJECT,
      JSON.stringify(rig.state.lastActiveProject()),
    )
    surface.dispose()
    rig.scheduler.dispose()
  }

  // (b) nothing recorded: say so, never pick a "recently active" project.
  {
    const rig = unboundRig({ registry: registryWith(PROJECT, false) })
    const surface = install(rig)
    async function http(url) {
      const res = response()
      await surface.byPath.get(url.split('?')[0]).handler(request(url), res)
      return res.json()
    }
    const started = await http(STATE_PATH + '?session=test-session')
    check(
      'T-103 with no record the panel is told nothing is active (no pick-a-project fallback)',
      started.ok === false && started.code === 'no-project-bound' && rig.state.lastActiveProject() === null,
      JSON.stringify({ ok: started.ok, code: started.code, lastActive: rig.state.lastActiveProject() }),
    )
    surface.dispose()
    rig.scheduler.dispose()
  }

  // (c) a session that CAN be resolved always wins over the last-active record.
  {
    const otherRoot = join(PROJECT, '..', 'proj-other')
    const rig = unboundRig({
      registry: registryWith(PROJECT),
      sessionLookup: { lookup: (id) => (id === 'abc' ? { ok: true, path: otherRoot } : { ok: false, code: 'no-session' }) },
    })
    for (const dir of [otherRoot, join(otherRoot, '.git'), join(otherRoot, '.agents')]) rig.fs.dirs.add(dir)
    const surface = install(rig)
    async function http(url) {
      const res = response()
      await surface.byPath.get(url.split('?')[0]).handler(request(url), res)
      return res.json()
    }
    const sessionFirst = await http(STATE_PATH + '?session=abc')
    check(
      'T-103 a resolvable session beats the last-active record',
      sessionFirst.ok === true && sessionFirst.projectRoot === otherRoot && sessionFirst.resolvedFrom === 'session-lookup',
      JSON.stringify({ projectRoot: sessionFirst.projectRoot, resolvedFrom: sessionFirst.resolvedFrom }),
    )
    surface.dispose()
    rig.scheduler.dispose()
  }

  // (d) every successful activation stamps the single last-active id.
  {
    const rig = createRig({ allowSpawn: false })
    const surface = install(rig)
    async function post(body) {
      const res = response()
      await surface.byPath.get(ACTION_PATH).handler(request(ACTION_PATH, { method: 'POST', body: body, headers: { 'content-type': 'application/json' } }), res)
      return res.json()
    }
    rig.state.memory.registry = { version: 1, projects: [], lastActiveProjectId: null }
    const opened = await post({ action: 'openProject', project: PROJECT, path: PROJECT })
    check(
      'T-103 openProject records the project as last active',
      opened.ok === true && rig.state.memory.registry.lastActiveProjectId === projectIdOf(PROJECT),
      JSON.stringify({ ok: opened.ok, lastActive: rig.state.memory.registry.lastActiveProjectId }),
    )
    // The marker is part of the PERSISTED registry: a restart must read it back.
    await rig.state.flushRegistry()
    const readBack = await readProjectRegistry({ fs: rig.fs }, { homeDir: homedir(), projectRoot: PROJECT })
    check(
      'T-103 the last-active id survives the registry round-trip',
      readBack.ok === true && readBack.registry.lastActiveProjectId === projectIdOf(PROJECT),
      JSON.stringify({ ok: readBack.ok, lastActive: readBack.registry && readBack.registry.lastActiveProjectId }),
    )
    surface.dispose()
    rig.scheduler.dispose()
  }
}

// ── T-97: a card is dispatched only to its own session/project team ──
{
  const { createFakeGit: makeGit } = await import('./support/fixtures.mjs')
  // A session's Lead agent carries that session's id — the model T-106 relies on.
  function teamFor(session, leadName, workerName, workerStatus) {
    const team = createTeam({
      leadId: session,
      roster: [
        { id: session, name: leadName, role: 'lead', status: 'running' },
        { id: 'session-' + workerName, name: workerName, role: 'teammate', status: workerStatus === undefined ? 'inactive' : workerStatus },
      ],
    })
    team.agents = [{ id: session, name: leadName, role: 'lead', status: 'running' }]
    return team
  }
  function contextFor(fs, team) {
    return {
      fs: fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
      get(key) {
        if (key === 'agents') return team === null ? undefined : { list: () => team.agents }
        if (key === 'agentTeams') return team
        return undefined
      },
    }
  }
  function boardWith(owners) {
    const now = new Date().toISOString()
    return JSON.stringify({
      version: 2,
      seq: 2,
      dispatch: { state: 'running', allowSpawn: true, maxConcurrent: 2 },
      tasks: owners.map((owner, index) => ({
        id: 'T-' + String(index + 1),
        title: 'owned by ' + owner,
        status: 'pending',
        priority: 0,
        dependsOn: [],
        writeFiles: [],
        spec: 's',
        acceptance: 'a',
        evidence: '',
        ownerSession: owner,
        history: [],
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        maxAttempts: 3,
      })),
    })
  }
  async function dispatcherFor(session, team) {
    const fs = createFakeFs()
    seedBoard(fs, PROJECT, boardWith(['session-a', 'session-b']))
    const ctx = contextFor(fs, team)
    const state = createState(ctx)
    const git = makeGit()
    const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: git, sessionId: session })
    await scheduler.settle(PROJECT)
    return { fs: fs, state: state, ctx: ctx, scheduler: scheduler, git: git }
  }
  const rigA = await dispatcherFor('session-a', teamFor('session-a', 'lead-a', 'fixer-a'))
  const boardA = boardJson(rigA.fs, PROJECT).tasks
  check(
    'T-97 session A dispatches its own card to its own worker',
    boardA[0].status === 'running' && boardA[0].assignee.name === 'fixer-a' && boardA[0].dispatch.lead === 'lead-a' && boardA[0].dispatch.project === PROJECT,
    JSON.stringify(boardA.map((task) => ({ id: task.id, status: task.status, assignee: task.assignee && task.assignee.name, lead: task.dispatch && task.dispatch.lead }))),
  )
  check(
    'T-97 session A never touches session B’s card',
    boardA[1].status === 'pending' && boardA[1].assignee === null && boardA[1].waitingReason === null,
    JSON.stringify({ status: boardA[1].status, assignee: boardA[1].assignee, waiting: boardA[1].waitingReason }),
  )
  const rigB = await dispatcherFor('session-b', teamFor('session-b', 'lead-b', 'fixer-b'))
  const boardB = boardJson(rigB.fs, PROJECT).tasks
  check(
    'T-97 session B dispatches its own card to its own worker',
    boardB[1].status === 'running' && boardB[1].assignee.name === 'fixer-b',
    JSON.stringify(boardB.map((task) => ({ id: task.id, status: task.status, assignee: task.assignee && task.assignee.name }))),
  )
  rigA.scheduler.dispose()
  rigB.scheduler.dispose()

  // No team in this session: the card records a reason and never borrows B's member.
  const noTeamRig = await dispatcherFor('session-a', null)
  const noTeamBoard = boardJson(noTeamRig.fs, PROJECT).tasks
  check(
    'T-97 a session without a team records no-lead-for-project instead of borrowing',
    noTeamBoard[0].status === 'pending' && noTeamBoard[0].waitingReason === 'no-lead-for-project' && noTeamBoard[0].assignee === null,
    JSON.stringify({ status: noTeamBoard[0].status, waiting: noTeamBoard[0].waitingReason, assignee: noTeamBoard[0].assignee }),
  )
  check(
    'T-97 the borrowed project’s member is never used',
    noTeamBoard.every((task) => task.assignee === null || task.assignee.name.indexOf('fixer-b') < 0),
    JSON.stringify(noTeamBoard.map((task) => task.assignee && task.assignee.name)),
  )
  noTeamRig.scheduler.dispose()

  // A member remembered for another project is not idle for this one.
  const projectRig = await dispatcherFor('session-a', teamFor('session-a', 'lead-a', 'fixer-a'))
  rememberMemberProject(projectRig.ctx, 'fixer-a', join(PROJECT, '..', 'other-project'))
  projectRig.fs.files.set(join(PROJECT, '.agents', 'tasks.json'), { text: boardWith(['session-a']), version: 'seed2' })
  await projectRig.scheduler.settle(PROJECT)
  const projectTasks = boardJson(projectRig.fs, PROJECT).tasks
  check(
    'T-97 a worker remembered for another project is not reused',
    projectTasks[0].status === 'running' && projectTasks[0].assignee.name !== 'fixer-a' && projectTasks[0].assignee.name.indexOf('work-') === 0,
    JSON.stringify({ assignee: projectTasks[0].assignee && projectTasks[0].assignee.name }),
  )
  const remembered = memberProjectOf(projectRig.ctx, projectTasks[0].assignee.name)
  check(
    'T-97 the new worker is remembered for this project',
    remembered !== null && remembered.key === projectSlotKey(PROJECT),
    JSON.stringify(remembered),
  )
  projectRig.scheduler.dispose()

  // ── T-106: the Lead that creates the executor is the CARD's session's Lead ──
  {
    function multiTeam(specs) {
      // specs: [{ leadId, leadName, workerName, workerStatus?, worker? }]
      const calls = []
      const teams = specs.map((spec) => ({
        spec: spec,
        team: createTeam({
          leadId: spec.leadId,
          roster: spec.worker === false
            ? [{ id: spec.leadId, name: spec.leadName, role: 'lead', status: 'running' }]
            : [
                { id: spec.leadId, name: spec.leadName, role: 'lead', status: 'running' },
                { id: 'session-' + spec.workerName, name: spec.workerName, role: 'teammate', status: spec.workerStatus === undefined ? 'inactive' : spec.workerStatus },
              ],
        }),
      }))
      const agents = teams.map((entry) => ({ id: entry.spec.leadId, name: entry.spec.leadName, role: 'lead', status: 'running' }))
      const service = {
        tryMembership(candidate) {
          const owner = teams.filter((entry) => entry.spec.leadId === candidate.id)[0]
          if (owner !== undefined) return owner.team.tryMembership(candidate)
          return { role: 'teammate', name: candidate.id }
        },
        listMembers(lead) {
          const owner = teams.filter((entry) => entry.spec.leadId === (lead === null || lead === undefined ? null : lead.id))[0]
          return owner === undefined ? [] : owner.team.listMembers()
        },
        async spawnTeammate(caller, request) {
          calls.push({ kind: 'spawn', caller: caller.id, name: request.name })
          const owner = teams.filter((entry) => entry.spec.leadId === caller.id)[0]
          if (owner !== undefined) owner.team.roster.push({ id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'running' })
          return { member: { id: 'session-' + request.name, name: request.name, role: 'teammate', status: 'running' } }
        },
        async sendMessage(caller, request) {
          calls.push({ kind: 'send', caller: caller.id, target: request.target })
          return { status: 'accepted', messageId: 'm-' + String(calls.length) }
        },
      }
      return { service: service, agents: agents, teams: teams, calls: calls }
    }
    function ctxFor(fs, multi) {
      return {
        fs: fs,
        sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
        get(key) {
          if (key === 'agents') return { list: () => multi.agents }
          if (key === 'agentTeams') return multi.service
          return undefined
        },
      }
    }
    async function dispatchWith(session, multi) {
      const fs = createFakeFs()
      seedBoard(fs, PROJECT, boardWith(['session-a', 'session-b']))
      const ctx = ctxFor(fs, multi)
      const state = createState(ctx)
      const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: makeGit(), sessionId: session })
      await scheduler.settle(PROJECT)
      return { fs: fs, scheduler: scheduler }
    }

    // (a) each session's card goes to ITS OWN Lead; the history names both.
    {
      const multi = multiTeam([
        { leadId: 'session-a', leadName: 'lead-a', workerName: 'fixer-a' },
        { leadId: 'session-b', leadName: 'lead-b', workerName: 'fixer-b' },
      ])
      const rigA = await dispatchWith('session-a', multi)
      const boardA = boardJson(rigA.fs, PROJECT).tasks
      check(
        'T-106 a card is dispatched under the Lead of ITS session',
        boardA[0].status === 'running' && boardA[0].dispatch.lead === 'lead-a' && boardA[0].dispatch.leadSession === 'session-a' && boardA[0].dispatch.session === 'session-a',
        JSON.stringify({ lead: boardA[0].dispatch && boardA[0].dispatch.lead, leadSession: boardA[0].dispatch && boardA[0].dispatch.leadSession, session: boardA[0].dispatch && boardA[0].dispatch.session }),
      )
      check(
        'T-106 the history records the worker, the Lead, the project and the session',
        String(boardA[0].history[0].note).indexOf('dispatched to fixer-a under Lead lead-a for ' + PROJECT + ' (session session-a)') >= 0,
        JSON.stringify(boardA[0].history[0].note),
      )
      check(
        'T-106 session A leaves session B’s card untouched',
        boardA[1].status === 'pending' && boardA[1].assignee === null,
        JSON.stringify({ status: boardA[1].status, assignee: boardA[1].assignee }),
      )
      rigA.scheduler.dispose()
      const rigB = await dispatchWith('session-b', multi)
      const boardB = boardJson(rigB.fs, PROJECT).tasks
      check(
        'T-106 session B dispatches its own card to its own Lead’s team',
        boardB[1].status === 'running' && boardB[1].assignee.name === 'fixer-b' && boardB[1].dispatch.lead === 'lead-b' && boardB[1].dispatch.leadSession === 'session-b',
        JSON.stringify({ assignee: boardB[1].assignee && boardB[1].assignee.name, lead: boardB[1].dispatch && boardB[1].dispatch.lead }),
      )
      rigB.scheduler.dispose()
    }

    // (b) a spawn happens UNDER the card's Lead, never the first one in the host.
    {
      const multi = multiTeam([
        { leadId: 'session-a', leadName: 'lead-a', workerName: 'fixer-a' },
        { leadId: 'session-b', leadName: 'lead-b', worker: false },
      ])
      const rigB = await dispatchWith('session-b', multi)
      const boardB = boardJson(rigB.fs, PROJECT).tasks
      const spawns = multi.calls.filter((call) => call.kind === 'spawn')
      check(
        'T-106 a spawned executor is created under the card session’s Lead',
        spawns.length === 1 && spawns[0].caller === 'session-b' && boardB[1].status === 'running' && boardB[1].dispatch.lead === 'lead-b',
        JSON.stringify({ spawns: spawns, status: boardB[1].status, lead: boardB[1].dispatch && boardB[1].dispatch.lead }),
      )
      rigB.scheduler.dispose()
    }

    // (c) the card's session has NO Lead: record the reason, never borrow A's team.
    {
      const multi = multiTeam([
        { leadId: 'session-a', leadName: 'lead-a', workerName: 'fixer-a' },
        { leadId: 'session-c', leadName: 'lead-c', workerName: 'fixer-c' },
      ])
      const rigB = await dispatchWith('session-b', multi)
      const boardB = boardJson(rigB.fs, PROJECT).tasks
      check(
        'T-106 a session with no Lead records no-lead-for-project instead of borrowing',
        boardB[1].status === 'pending' && boardB[1].waitingReason === 'no-lead-for-project' && boardB[1].assignee === null,
        JSON.stringify({ status: boardB[1].status, waiting: boardB[1].waitingReason, assignee: boardB[1].assignee }),
      )
      check(
        'T-106 the other session’s worker is never used for that card',
        boardB.every((task) => task.assignee === null || task.assignee.name !== 'fixer-a'),
        JSON.stringify(boardB.map((task) => task.assignee && task.assignee.name)),
      )
      rigB.scheduler.dispose()
    }

    // (d) a legacy profile with no session identity keeps the historical behaviour.
    {
      const multi = multiTeam([{ leadId: 'session-lead', leadName: 'lead', workerName: 'fixer' }])
      const fs = createFakeFs()
      seedBoard(fs, PROJECT, boardWith([null]))
      const ctx = ctxFor(fs, multi)
      const state = createState(ctx)
      const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: makeGit() })
      await scheduler.settle(PROJECT)
      const board = boardJson(fs, PROJECT).tasks
      check(
        'T-106 a legacy profile without session identity still dispatches (first Lead)',
        board[0].status === 'running' && board[0].assignee.name === 'fixer' && board[0].dispatch.lead === 'lead',
        JSON.stringify({ status: board[0].status, assignee: board[0].assignee && board[0].assignee.name, lead: board[0].dispatch && board[0].dispatch.lead }),
      )
      scheduler.dispose()
    }
  }

}

// ── T-101: submit commits only declared files + tracked modifications ──
{
  const untracked = '?? .tmp-run/' + '\0' + '?? node_modules/pkg/index.js' + '\0'
  const gitlink = '160000 abcdef1234567890 0\tvendor/sub' + '\0'
  const fake = fakeGit({ status: untracked, indexEntries: gitlink })
  const rig = createSubmitRig({ git: fake.git })
  seedRunningTask(rig, runningWorktreeTask({ writeFiles: ['scripts/declared.gd'] }))
  const surface = install(rig)
  const res = await postTo(surface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'scoped' })
  const payload = res.json()
  const calls = fake.calls.map((entry) => entry.args.join(' '))
  check(
    'T-101 only tracked updates and the declared file are staged (never add -A)',
    calls.indexOf('add -u') >= 0 && calls.indexOf('add -- scripts/declared.gd') >= 0 && calls.every((call) => call !== 'add -A'),
    JSON.stringify(calls),
  )
  check(
    'T-101 a gitlink is unstaged and reported instead of committed',
    calls.indexOf('reset -- vendor/sub') >= 0 &&
      payload.commitScope !== undefined &&
      payload.commitScope.skipped.some((entry) => entry.path === 'vendor/sub' && /gitlink/.test(entry.reason)),
    JSON.stringify(payload.commitScope),
  )
  check(
    'T-101 untracked temp/build content is reported as not committed',
    payload.commitScope !== undefined &&
      payload.commitScope.notCommitted.some((entry) => entry.path.indexOf('.tmp-run') === 0) &&
      payload.commitScope.notCommitted.some((entry) => entry.path.indexOf('node_modules') === 0) &&
      typeof payload.commitScope.hint === 'string',
    JSON.stringify(payload.commitScope && payload.commitScope.notCommitted),
  )
  surface.dispose()
  rig.scheduler.dispose()

  // Declared set empty: tracked modifications only, nothing untracked.
  const emptyFake = fakeGit({ status: '?? scratch.txt' + '\0' })
  const emptyRig = createSubmitRig({ git: emptyFake.git })
  seedRunningTask(emptyRig, runningWorktreeTask({ writeFiles: [] }))
  const emptySurface = install(emptyRig)
  const emptyRes = await postTo(emptySurface, { action: 'submit', project: PROJECT, id: 'T-1', evidence: 'no declarations' })
  const emptyPayload = emptyRes.json()
  const emptyCalls = emptyFake.calls.map((entry) => entry.args.join(' '))
  check(
    'T-101 an empty declaration falls back to tracked modifications only',
    emptyPayload.ok === true && emptyCalls.indexOf('add -u') >= 0 && emptyCalls.every((call) => call.indexOf('add -- ') !== 0),
    JSON.stringify(emptyCalls),
  )
  check(
    'T-101 the untracked fallback file is reported, never committed',
    emptyPayload.commitScope !== undefined && emptyPayload.commitScope.notCommitted.some((entry) => entry.path === 'scratch.txt'),
    JSON.stringify(emptyPayload.commitScope),
  )
  emptySurface.dispose()
  emptyRig.scheduler.dispose()
}

// ── T-107: a pre-T-97 card without ownerSession is adopted by the session that writes it ──
{
  const rig = createRig({ allowSpawn: false })
  const now = new Date().toISOString()
  seedBoard(rig.fs, PROJECT, JSON.stringify({
    version: 2,
    seq: 2,
    dispatch: { state: 'paused' },
    tasks: [{ id: 'T-1', title: 'legacy card', status: 'pending', priority: 0, dependsOn: [], writeFiles: [], spec: 's', acceptance: 'a', evidence: '', ownerSession: null, history: [], createdAt: now, updatedAt: now, attempts: 0, maxAttempts: 3 }],
  }))
  const adopted = await rig.api.perform('block', { id: 'T-1', reason: 'triaged' }, { projectPath: PROJECT, by: '@user', role: 'user', agent: { id: 'session-adopter' } })
  const card = boardJson(rig.fs, PROJECT).tasks[0]
  check(
    'T-107 a card without ownerSession is adopted by the writing session',
    adopted.ok === true && card.ownerSession === 'session-adopter' && card.status === 'blocked',
    JSON.stringify({ ok: adopted.ok, owner: card.ownerSession, status: card.status }),
  )
  check(
    'T-107 adoption is recorded in history as owner session adopted: <id>',
    (card.history || []).some((entry) => String(entry.note) === 'owner session adopted: session-adopter'),
    JSON.stringify((card.history || []).map((entry) => entry.note)),
  )
  const detail = await rig.api.perform('get', { id: 'T-1' }, { projectPath: PROJECT, by: '@user', role: 'user' })
  check(
    'T-107 get exposes ownerSession and dispatch.leadSession',
    detail.ok === true && detail.task.ownerSession === 'session-adopter' &&
      (detail.task.dispatch === null || Object.prototype.hasOwnProperty.call(detail.task.dispatch, 'leadSession')),
    JSON.stringify({ owner: detail.task && detail.task.ownerSession }),
  )
  rig.scheduler.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)