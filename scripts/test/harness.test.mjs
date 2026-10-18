// Harness tests: an isolated DSH instance driven entirely through fakes (no
// real process, no real port, no real HTTP). The real smoke is an optional
// integration check, not part of npm test.

import { join } from 'node:path'
import {
  HARNESS_CONFIG_FILE,
  compareVersions,
  createHarness,
  resolveHarnessConfig,
  shellCommand,
  sourceVersionOf,
} from '../../plugin/task-center/harness.mjs'
import { createApi } from '../../plugin/task-center/api.mjs'
import { createRoleManager } from '../../plugin/task-center/dispatch.mjs'
import { createRig, createTeam, PROJECT as RIG_PROJECT } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

const TMP = '/tmp/dsh-harness-tests'
const PROJECT = '/work/demo-project'
const SOURCE = '/work/deepseek-harness'
const CANDIDATE = '/work/godot-bridge'
const norm = (path) => String(path).replace(/\\/g, '/')
const commandOf = (call) => String(call.argv[call.argv.length - 1])

function fakeFs(options) {
  const opts = options === undefined ? {} : options
  const files = new Map()
  const dirs = new Set()
  const calls = { mkdtemp: [], mkdir: [], cp: [], rm: [], readFile: [], writeFile: [] }
  let sequence = 0
  const fs = {
    async mkdtemp(prefix) {
      sequence += 1
      const path = String(prefix) + String(sequence)
      dirs.add(path)
      calls.mkdtemp.push(path)
      return path
    },
    async mkdir(path) {
      dirs.add(String(path))
      calls.mkdir.push(String(path))
    },
    async cp(from, to, options) {
      calls.cp.push({ from: String(from), to: String(to), options: options })
    },
    async rm(path) {
      calls.rm.push(String(path))
      for (const key of Array.from(files.keys())) {
        if (key === norm(path) || key.startsWith(norm(path) + '/')) files.delete(key)
      }
    },
    async readFile(path) {
      calls.readFile.push(String(path))
      const key = norm(path)
      if (!files.has(key)) throw new Error('ENOENT ' + path)
      return files.get(key)
    },
    async writeFile(path, text) {
      calls.writeFile.push({ path: String(path), text: String(text) })
      files.set(norm(path), String(text))
    },
    async unlink(path) {
      files.delete(norm(path))
    },
    tmpdir: () => TMP,
    setFile: (path, text) => files.set(norm(path), String(text)),
    files: files,
    calls: calls,
  }
  return fs
}

function fakeProcess(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  let pid = 1000
  const spawn = (request) => {
    calls.push({
      argv: request.argv.slice(),
      cwd: request.cwd,
      env: Object.assign({}, request.env),
      graceMs: request.graceMs,
      stdio: request.stdio,
    })
    const text = request.argv[request.argv.length - 1]
    const isWeb = /^dsh web\b/.test(String(text))
    const log = isWeb ? opts.webOutput || 'dsh web ready\n' : 'plugin installed\n'
    pid += 1
    let finish = null
    const done = new Promise((resolveDone) => {
      finish = resolveDone
    })
    const collector = {
      readFrom() {
        return { text: log }
      },
    }
    const handle = {
      pid: pid,
      done: done,
      collected: { stdout: collector, stderr: { readFrom: () => ({ text: '' }) } },
      killed: false,
      async kill() {
        handle.killed = true
        finish({ exitCode: 0 })
      },
    }
    if (isWeb === false) {
      finish({ exitCode: opts.installExit === undefined ? 0 : opts.installExit })
    } else if (opts.webExits === true) {
      finish({ exitCode: 1 })
    }
    return handle
  }
  return { calls: calls, spawn: spawn, subprocess: { spawn: spawn } }
}

function fakeHttp(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  const respond = async (method, url, body) => {
    calls.push({ method: method, url: url, body: body })
    const custom = method === 'post' ? opts.post : opts.get
    if (typeof custom === 'function') return custom(url, body)
    if (opts.failAll === true) throw new Error('connection refused')
    if (method === 'get' && url.indexOf('/godot-bridge/task-center/state') >= 0) {
      if (opts.stateFails === true) return { status: 500, ok: false, body: 'error' }
      return { status: 200, ok: true, body: JSON.stringify({ ok: true, tasks: [] }) }
    }
    if (method === 'get') return { status: 200, ok: true, body: '<html><body>DSH</body></html>' }
    return { status: 200, ok: true, body: JSON.stringify({ ok: true }) }
  }
  return {
    calls: calls,
    http: {
      get: (url) => respond('get', url),
      post: (url, body) => respond('post', url, body),
    },
  }
}

function baseOptions(extra) {
  const opts = extra === undefined ? {} : extra
  const fs = fakeFs()
  const proc = fakeProcess(opts.process)
  const http = fakeHttp(opts.http)
  fs.setFile(join(SOURCE, 'package.json'), JSON.stringify({ version: opts.sourceVersion === undefined ? '1.2.3' : opts.sourceVersion }))
  fs.setFile(
    join(PROJECT, HARNESS_CONFIG_FILE),
    JSON.stringify({ dshSource: SOURCE, candidatePlugin: CANDIDATE, dshCommand: 'dsh', profile: 'web', portBase: 39000, portRange: 5, healthTimeoutMs: 30, healthIntervalMs: 5 }),
  )
  const harness = createHarness({
    ctx: { get: (key) => (key === 'subprocess' ? proc.subprocess : undefined) },
    fsOps: fs,
    http: http.http,
    probePort: opts.probePort === undefined ? async () => true : opts.probePort,
    sleep: async () => {},
    platform: 'linux',
    env: {},
    tmpdir: () => TMP,
    productionVersion: () => (opts.productionVersion === undefined ? '1.2.3' : opts.productionVersion),
  })
  return { fs: fs, proc: proc, http: http, harness: harness }
}

// ── configuration resolution ───────────────────────────────────────────────
{
  const fs = fakeFs()
  fs.setFile(
    join(PROJECT, HARNESS_CONFIG_FILE),
    JSON.stringify({ dshSource: '/cfg/source', candidatePlugin: '/cfg/candidate', portBase: 41000, profile: 'test-web' }),
  )
  const config = await resolveHarnessConfig({ projectPath: PROJECT, fsOps: fs, env: { DSH_TEST_HARNESS_SOURCE: '/env/source', DSH_TEST_HARNESS_PORT_BASE: '42000' } })
  check('the project file overrides the default source', config.dshSource === '/cfg/source', config.dshSource)
  check('the environment overrides the project file', config.portBase === 42000, String(config.portBase))
  check('unset fields keep the project file value', config.candidatePlugin === '/cfg/candidate' && config.profile === 'test-web', JSON.stringify({ candidate: config.candidatePlugin, profile: config.profile }))
  const fallback = await resolveHarnessConfig({ projectPath: '/none', fsOps: fs, env: {} })
  check('a project without config uses the DSH source default', fallback.dshSource === 'J:\\workspace\\HARNESS\\deepseek-harness', fallback.dshSource)
  check('the candidate defaults to this plugin package', fallback.candidatePlugin.length > 0 && fallback.candidatePlugin.indexOf('godot-bridge') > 0, fallback.candidatePlugin)
}

// ── version comparison ─────────────────────────────────────────────────────
{
  check('equal versions match', compareVersions('1.2.3', '1.2.3') === 'match')
  check('different versions mismatch', compareVersions('1.2.3', '1.3.0') === 'mismatch')
  check('an unknown side is never a match', compareVersions(null, '1.2.3') === 'unknown' && compareVersions('1.2.3', null) === 'unknown')
  const fs = fakeFs()
  fs.setFile(join(SOURCE, 'package.json'), JSON.stringify({ version: '2.0.0' }))
  check('the source version is read from its package.json', (await sourceVersionOf(fs, SOURCE)) === '2.0.0')
}
check('shell commands are quoted for the platform', shellCommand(['dsh', 'web', '--port', '39000'], 'linux').join(' ').indexOf('dsh web --port 39000') > 0)

// ── start: isolated home/profile/port and the candidate plugin ────────────
{
  const rig = baseOptions()
  const started = await rig.harness.start(PROJECT)
  check('start reports running on a free port', started.ok === true && started.status === 'running' && started.port >= 39000 && started.port < 39005, JSON.stringify(started))
  check('the instance home is under the temp root, not the production home', norm(started.home).indexOf(norm(TMP) + '/godot-bridge-harness-') === 0, started.home)
  check('the project is an independent copy', norm(started.projectCopy).indexOf(norm(TMP)) === 0 && norm(started.projectCopy) !== norm(PROJECT), started.projectCopy)
  check('the temp root was created and the project copied', rig.fs.calls.mkdtemp.length === 1 && rig.fs.calls.cp.length === 1 && rig.fs.calls.cp[0].from === PROJECT, JSON.stringify(rig.fs.calls.cp))
  const install = rig.proc.calls.filter((call) => commandOf(call).indexOf(' plugin ') >= 0)[0]
  const web = rig.proc.calls.filter((call) => commandOf(call).indexOf('dsh web ') === 0)[0]
  check(
    'the candidate plugin is installed into the isolated profile',
    install !== undefined && commandOf(install).indexOf('--profile web add ' + CANDIDATE) >= 0 && install.env.DSH_HOME === started.home,
    JSON.stringify(install && install.argv),
  )
  check(
    'the web process starts on the allocated port with --no-open',
    web !== undefined && commandOf(web).indexOf('dsh web --host 127.0.0.1 --port ' + String(started.port) + ' --no-open') >= 0,
    JSON.stringify(web && web.argv),
  )
  check('the web process gets the isolated DSH_HOME', web !== undefined && web.env.DSH_HOME === started.home && web.env.DSH_PROFILE === 'web', JSON.stringify(web && web.env))
  check('the versions match', started.sourceVersion === '1.2.3' && started.productionVersion === '1.2.3' && started.versionStatus === 'match' && started.versionMismatch === false, JSON.stringify(started))
  check('logs capture the process output', rig.harness.logs().logs.indexOf('dsh web ready') >= 0, rig.harness.logs().logs)
  await rig.harness.stop()
}

// ── port selection never borrows a busy or production port ────────────────
{
  const busy = new Set([39000, 39001])
  const rig = baseOptions({ probePort: async (port) => busy.has(port) === false })
  const started = await rig.harness.start(PROJECT)
  check('busy ports are skipped', started.ok === true && started.port === 39002, String(started.port))
  await rig.harness.stop()
}
{
  const rig = baseOptions({ probePort: async () => true })
  // productionPort comes from config; point it at the first candidate.
  rig.fs.setFile(
    join(PROJECT, HARNESS_CONFIG_FILE),
    JSON.stringify({ dshSource: SOURCE, candidatePlugin: CANDIDATE, dshCommand: 'dsh', profile: 'web', portBase: 39000, portRange: 5, productionPort: 39000, healthTimeoutMs: 30, healthIntervalMs: 5 }),
  )
  const started = await rig.harness.start(PROJECT)
  check('the production port is never a candidate', started.ok === true && started.port === 39001, String(started.port))
  await rig.harness.stop()
}

// ── install failure: readable and cleaned up ──────────────────────────────
{
  const rig = baseOptions({ process: { installExit: 1 } })
  const started = await rig.harness.start(PROJECT)
  check('a failed plugin install refuses the start', started.ok === false && started.code === 'plugin-install-failed', JSON.stringify(started))
  check('the temp root is cleaned after a failed install', rig.fs.calls.rm.length === 1, JSON.stringify(rig.fs.calls.rm))
  check('no instance is reported', rig.harness.status().running === false, JSON.stringify(rig.harness.status()))
}

// ── web exits immediately: not a running instance ─────────────────────────
{
  const rig = baseOptions({ process: { webExits: true } })
  const started = await rig.harness.start(PROJECT)
  check('a web process that exits is a failed start', started.ok === false && started.code === 'server-exited', JSON.stringify(started))
  check('and its temp root is cleaned', rig.fs.calls.rm.length === 1, JSON.stringify(rig.fs.calls.rm))
}

// ── health timeout: killed and cleaned ────────────────────────────────────
{
  const rig = baseOptions({ http: { failAll: true } })
  const started = await rig.harness.start(PROJECT)
  check('an unhealthy instance refuses the start', started.ok === false && started.code === 'health-timeout', JSON.stringify(started))
  const webCall = rig.proc.calls.filter((call) => commandOf(call).indexOf('dsh web ') === 0)[0]
  check('the failed process is killed', rig.proc.calls.length >= 2 && rig.harness.state.instance === null, JSON.stringify(rig.proc.calls.length))
  check('and the temp root is removed', rig.fs.calls.rm.length === 1, JSON.stringify(rig.fs.calls.rm))
}

// ── restart: stop, clean, start again, new port ───────────────────────────
{
  const busy = new Set()
  const rig = baseOptions({ probePort: async (port) => busy.has(port) === false })
  const started = await rig.harness.start(PROJECT)
  check('the first start runs', started.ok === true, JSON.stringify(started))
  const firstHome = started.home
  busy.add(started.port)
  const restarted = await rig.harness.restart(PROJECT)
  check('restart reports a running instance on a new port', restarted.ok === true && restarted.status === 'running' && restarted.port !== started.port, JSON.stringify(restarted))
  check('restart counts the restart', rig.harness.status().restarts === 1, JSON.stringify(rig.harness.status()))
  check(
    'the old temp root was removed',
    rig.fs.calls.rm.some((path) => norm(path).endsWith(norm(firstHome).replace(/\/home$/, ''))),
    JSON.stringify({ firstHome: firstHome, rm: rig.fs.calls.rm }),
  )
  await rig.harness.stop()
}

// ── stop: idempotent, kills and removes the temp root ─────────────────────
{
  const rig = baseOptions()
  const started = await rig.harness.start(PROJECT)
  const stopped = await rig.harness.stop()
  check('stop reports the instance stopped', stopped.ok === true && stopped.stopped === true, JSON.stringify(stopped))
  check('the temp root is removed on stop', rig.fs.calls.rm.length === 1, JSON.stringify(rig.fs.calls.rm))
  check('status is stopped', rig.harness.status().status === 'stopped' && rig.harness.status().running === false, JSON.stringify(rig.harness.status()))
  const again = await rig.harness.stop()
  check('stopping twice is harmless', again.ok === true && again.alreadyStopped === true, JSON.stringify(again))
  check('the first home was under the temp root', norm(started.home).indexOf(norm(TMP)) === 0, started.home)
}

// ── smoke: page, plugin row and the task-center API ───────────────────────
{
  const rig = baseOptions()
  await rig.harness.start(PROJECT)
  const smoke = await rig.harness.smoke(PROJECT)
  check(
    'smoke passes when page, health, plugin row and API answer',
    smoke.ok === true && smoke.versionStatus === 'match' && smoke.checks.health.ok === true && smoke.checks.page.ok === true,
    JSON.stringify(smoke),
  )
  check('smoke hits the isolated port', rig.http.calls.every((call) => call.url.indexOf('http://127.0.0.1:' + rig.harness.status().port) === 0), JSON.stringify(rig.http.calls.map((call) => call.url)))
  const stateCall = rig.http.calls.filter((call) => call.url.indexOf('/godot-bridge/task-center/state') >= 0)[0]
  check(
    'the plugin row is proven through the task-center state route',
    stateCall !== undefined && stateCall.url.indexOf(encodeURIComponent(String(rig.harness.status().projectCopy))) >= 0,
    stateCall && stateCall.url,
  )
  const actionCall = rig.http.calls.filter((call) => call.method === 'post')[0]
  check('the task-center action API is exercised', actionCall !== undefined && actionCall.body.action === 'board', JSON.stringify(actionCall && actionCall.body))
  await rig.harness.stop()
}
{
  const rig = baseOptions({ productionVersion: '9.9.9' })
  await rig.harness.start(PROJECT)
  check('start still reports the mismatch', rig.harness.status().versionMismatch === true && rig.harness.status().versionStatus === 'mismatch', JSON.stringify(rig.harness.status()))
  const smoke = await rig.harness.smoke(PROJECT)
  check('smoke refuses a version mismatch instead of passing', smoke.ok === false && smoke.code === 'version-mismatch', JSON.stringify(smoke))
  check('and names both versions', String(smoke.message).indexOf('1.2.3') >= 0 && String(smoke.message).indexOf('9.9.9') >= 0, String(smoke.message))
  await rig.harness.stop()
}
{
  const rig = baseOptions({ productionVersion: null })
  await rig.harness.start(PROJECT)
  const smoke = await rig.harness.smoke(PROJECT)
  check('an unverifiable version is not a pass', smoke.ok === false && smoke.code === 'version-mismatch', JSON.stringify(smoke))
  await rig.harness.stop()
}
{
  const rig = baseOptions({ http: { stateFails: true } })
  await rig.harness.start(PROJECT)
  const smoke = await rig.harness.smoke(PROJECT)
  check('a plugin row that does not answer fails the smoke', smoke.ok === false && smoke.code === 'smoke-failed', JSON.stringify(smoke))
  check('and the failing check is named', smoke.checks.pluginRow.ok === false, JSON.stringify(smoke.checks))
  await rig.harness.stop()
}

// ── no subprocess service: readable refusal, nothing created ──────────────
{
  const rg = baseOptions()
  const harness = createHarness({ ctx: { get: () => undefined }, fsOps: rg.fs, http: rg.http.http, tmpdir: () => TMP, platform: 'linux', env: {} })
  const started = await harness.start(PROJECT)
  check('without the subprocess service the start refuses', started.ok === false && started.code === 'no-subprocess-service', JSON.stringify(started))
  check('and nothing was copied or spawned', rg.fs.calls.cp.length === 0 && rg.proc.calls.length === 0, JSON.stringify({ cp: rg.fs.calls.cp.length, spawn: rg.proc.calls.length }))
}

// ── host actions: only the tester (or the user) drives the harness ─────────
function harnessRig(options) {
  const opts = options === undefined ? {} : options
  const team = createTeam({
    roster: [
      { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
      { id: 'session-tester-1', name: 'tester-1', role: 'teammate', status: 'inactive' },
      { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', status: 'inactive' },
      { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'running' },
    ],
  })
  const rig = createRig({ team })
  const roles = createRoleManager(rig.ctx)
  const calls = []
  const fake = {
    start: async (project) => {
      calls.push({ action: 'start', project: project })
      return { ok: true, status: 'running', port: 39000 }
    },
    stop: async () => {
      calls.push({ action: 'stop' })
      return { ok: true, stopped: true }
    },
    restart: async (project) => {
      calls.push({ action: 'restart', project: project })
      return { ok: true, status: 'running', port: 39001 }
    },
    status: () => {
      calls.push({ action: 'status' })
      return { ok: true, status: 'running', port: 39000 }
    },
    logs: () => ({ ok: true, logs: 'harness log tail' }),
    smoke: async (project) => {
      calls.push({ action: 'smoke', project: project })
      return { ok: true, checks: { page: { ok: true } } }
    },
  }
  const api = createApi(rig.ctx, {
    state: rig.state,
    scheduler: rig.scheduler,
    roles: roles,
    harness: opts.harness === undefined ? fake : opts.harness,
  })
  const tester = { projectPath: rig.project, by: '@tester-1', role: 'agent', agent: { id: 'session-tester-1' } }
  const fixer = { projectPath: rig.project, by: '@fixer', role: 'agent', agent: { id: 'session-fixer' } }
  const reviewer = { projectPath: rig.project, by: '@reviewer-1', role: 'agent', agent: { id: 'session-reviewer-1' } }
  const user = { projectPath: rig.project, by: '@user', role: 'user', agent: null }
  return { rig: rig, api: api, calls: calls, tester: tester, fixer: fixer, reviewer: reviewer, user: user }
}

{
  const rg = harnessRig()
  const started = await rg.api.perform('harnessStart', { project: rg.rig.project }, rg.tester)
  check('the tester can start the isolated instance', started.ok === true && started.status === 'running', JSON.stringify(started))
  check('the project is passed to the harness', rg.calls.length === 1 && rg.calls[0].action === 'start' && rg.calls[0].project === rg.rig.project, JSON.stringify(rg.calls))
  const status = await rg.api.perform('harnessStatus', {}, rg.tester)
  check('the tester can read the harness status and logs', status.ok === true && status.harness.status === 'running' && status.logs.logs === 'harness log tail', JSON.stringify(status))
  const smoke = await rg.api.perform('harnessSmoke', {}, rg.tester)
  check('the tester can run the smoke', smoke.ok === true && smoke.checks.page.ok === true, JSON.stringify(smoke))
  const restarted = await rg.api.perform('harnessRestart', {}, rg.tester)
  check('the tester can restart the instance', restarted.ok === true && restarted.port === 39001, JSON.stringify(restarted))
  const stopped = await rg.api.perform('harnessStop', {}, rg.tester)
  check('the tester can stop the instance', stopped.ok === true && stopped.stopped === true, JSON.stringify(stopped))
  const asUser = await rg.api.perform('harnessStart', {}, rg.user)
  check('the user can drive the harness too', asUser.ok === true, JSON.stringify(asUser))
  rg.rig.scheduler.dispose()
}

{
  const rg = harnessRig()
  const byFixer = await rg.api.perform('harnessStart', {}, rg.fixer)
  check('a worker cannot drive the harness', byFixer.ok === false && byFixer.code === 'tester-only', JSON.stringify(byFixer))
  const byReviewer = await rg.api.perform('harnessStart', {}, rg.reviewer)
  check('a reviewer cannot drive the harness', byReviewer.ok === false && byReviewer.code === 'tester-only', JSON.stringify(byReviewer))
  const agentWithoutMember = await rg.api.perform('harnessStart', {}, { projectPath: rg.rig.project, by: '@nobody', role: 'agent', agent: null })
  check('an unknown agent cannot drive the harness', agentWithoutMember.ok === false, JSON.stringify(agentWithoutMember))
  check('a refused call never touches the harness', rg.calls.length === 0, JSON.stringify(rg.calls))
  rg.rig.scheduler.dispose()
}

{
  const rg = harnessRig({ harness: null })
  const none = await rg.api.perform('harnessStart', {}, rg.user)
  check('without a harness the action refuses readably', none.ok === false && none.code === 'harness-unavailable', JSON.stringify(none))
  rg.rig.scheduler.dispose()
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
