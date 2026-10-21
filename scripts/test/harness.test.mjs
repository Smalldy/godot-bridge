// Harness tests: an isolated DSH instance driven entirely through fakes (no
// real process, no real port, no real HTTP). The fakes mirror the REAL host
// subprocess contract — terminate() + waitForExit(signal) — so a harness that
// used a made-up kill() would fail here. The real smoke is an optional
// integration check, not part of npm test.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HARNESS_CONFIG_FILE,
  compareVersions,
  createHarness,
  defaultProductionVersion,
  dshArgv,
  readAsarEntry,
  resolveHarnessConfig,
  sourceVersionOf,
  tokenFromLogs,
  tokenUrl,
} from '../../plugin/task-center/harness.mjs'
import { createApi } from '../../plugin/task-center/api.mjs'
import { createRoleManager } from '../../plugin/task-center/dispatch.mjs'
import { createRig, createTeam } from './support/fixtures.mjs'

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
const commandOf = (call) => call.argv.join(' ')

function fakeFs() {
  const files = new Map()
  const calls = { mkdtemp: [], mkdir: [], cp: [], rm: [], readFile: [] }
  let sequence = 0
  return {
    async mkdtemp(prefix) {
      sequence += 1
      const path = String(prefix) + String(sequence)
      calls.mkdtemp.push(path)
      return path
    },
    async mkdir(path) {
      calls.mkdir.push(String(path))
    },
    async cp(from, to, options) {
      calls.cp.push({ from: String(from), to: String(to), options: options })
    },
    async rm(path) {
      calls.rm.push(String(path))
    },
    async readFile(path) {
      calls.readFile.push(String(path))
      const key = norm(path)
      if (!files.has(key)) throw new Error('ENOENT ' + path)
      return files.get(key)
    },
    setFile(path, text) {
      files.set(norm(path), String(text))
    },
    calls: calls,
  }
}

/**
 * A fake host subprocess service whose handles implement the REAL contract:
 * terminate(): void and waitForExit(signal): Promise<boolean>. There is no
 * kill(), so the harness cannot pass these tests with an invented API.
 */
function fakeProcess(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  const handles = []
  let pid = 1000
  const spawn = (request) => {
    const command = request.argv.join(' ')
    const isWeb = command.indexOf('--no-open') >= 0
    calls.push({
      command: command,
      argv: request.argv.slice(),
      cwd: request.cwd,
      env: Object.assign({}, request.env),
      graceMs: request.graceMs,
      web: isWeb,
    })
    pid += 1
    let finish = null
    const done = new Promise((resolveDone) => {
      finish = resolveDone
    })
    const collector = {
      text: isWeb ? opts.webOutput || 'dsh web ready\n' : 'plugin installed\n',
      readFrom: function () {
        return { text: this.text }
      },
    }
    const handle = {
      pid: pid,
      done: done,
      web: isWeb,
      terminated: false,
      waitCalls: 0,
      collected: { stdout: collector, stderr: { readFrom: () => ({ text: '' }) } },
      terminate() {
        handle.terminated = true
        if (opts.noExit === true) return
        finish({ exitCode: 0 })
      },
      waitForExit() {
        handle.waitCalls += 1
        if (opts.noExit === true) return new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5))
        return done.then(() => true)
      },
    }
    handles.push(handle)
    if (isWeb === false) {
      if (opts.installHangs !== true) finish({ exitCode: opts.installExit === undefined ? 0 : opts.installExit })
    } else if (opts.webExits === true) {
      finish({ exitCode: 1 })
    }
    return handle
  }
  return { calls: calls, handles: handles, spawn: spawn, subprocess: { spawn: spawn } }
}

function fakeHttp(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  const COOKIE = 'dsh_auth=fixture-token'
  const respond = async (method, url, body, requestOptions) => {
    const cookie = requestOptions === undefined ? undefined : requestOptions.cookie
    calls.push({ method: method, url: url, body: body, cookie: cookie })
    const custom = method === 'post' ? opts.post : opts.get
    if (typeof custom === 'function') return custom(url, body)
    if (opts.failAll === true) throw new Error('connection refused')
    if (method === 'get' && url.indexOf('/godot-bridge/task-center/state') >= 0) {
      if (opts.stateFails === true) return { status: 500, ok: false, body: 'error' }
      return { status: 200, ok: true, body: JSON.stringify({ ok: true, tasks: [] }) }
    }
    if (opts.auth === true && method === 'get') {
      // The real server: `/?token=` answers 303 + Set-Cookie, `/` answers 401
      // without that cookie and 200 with it. Node's fetch keeps no cookie jar.
      if (url.indexOf('token=fixture-token') >= 0) return { status: 303, ok: false, body: '' }
      if (cookie === COOKIE) return { status: 200, ok: true, body: '<html><body>DSH</body></html>' }
      return { status: 401, ok: false, body: 'unauthorized' }
    }
    if (method === 'get') return { status: 200, ok: true, body: '<html><body>DSH</body></html>' }
    return { status: 200, ok: true, body: JSON.stringify({ ok: true }) }
  }
  const http = {
    get: (url, requestOptions) => respond('get', url, undefined, requestOptions),
    post: (url, body, requestOptions) => respond('post', url, body, requestOptions),
  }
  if (opts.auth === true) {
    http.exchangeToken = async (url) => {
      calls.push({ method: 'exchange', url: url })
      return url.indexOf('token=fixture-token') >= 0 ? { status: 303, cookie: COOKIE } : { status: 401, cookie: null }
    }
  }
  return { calls: calls, http: http }
}

function baseOptions(extra) {
  const opts = extra === undefined ? {} : extra
  const fs = fakeFs()
  const proc = fakeProcess(opts.process)
  const http = fakeHttp(opts.http)
  fs.setFile(join(SOURCE, 'package.json'), JSON.stringify({ version: opts.sourceVersion === undefined ? '1.2.3' : opts.sourceVersion }))
  fs.setFile(
    join(PROJECT, HARNESS_CONFIG_FILE),
    JSON.stringify(
      Object.assign(
        {
          dshSource: SOURCE,
          candidatePlugin: CANDIDATE,
          dshCommand: 'dsh',
          profile: 'web',
          portBase: 39000,
          portRange: 5,
          healthTimeoutMs: 30,
          healthIntervalMs: 5,
          installTimeoutMs: 50,
          stopTimeoutMs: 20,
        },
        opts.config === undefined ? {} : opts.config,
      ),
    ),
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
    JSON.stringify({ dshSource: '/cfg/source', candidatePlugin: '/cfg/candidate', portBase: 41000, profile: 'test-web', healthPath: '/health' }),
  )
  const config = await resolveHarnessConfig({
    projectPath: PROJECT,
    fsOps: fs,
    env: { DSH_TEST_HARNESS_SOURCE: '/env/source', DSH_TEST_HARNESS_PORT_BASE: '42000', DSH_TEST_HARNESS_PROFILE: 'env-profile', DSH_TEST_HARNESS_HEALTH_PATH: '/ready' },
  })
  check(
    'the environment overrides the project file for strings',
    config.dshSource === '/env/source' && config.profile === 'env-profile' && config.healthPath === '/ready',
    JSON.stringify({ source: config.dshSource, profile: config.profile, health: config.healthPath }),
  )
  check('the environment overrides the project file for numbers', config.portBase === 42000, String(config.portBase))
  check('unset fields keep the project file value', config.candidatePlugin === '/cfg/candidate', config.candidatePlugin)
  const fallback = await resolveHarnessConfig({ projectPath: '/none', fsOps: fs, env: {} })
  check('a project without config uses the DSH source default', fallback.dshSource === 'J:\\workspace\\HARNESS\\deepseek-harness', fallback.dshSource)
  check('the candidate defaults to this plugin package', fallback.candidatePlugin.length > 0 && fallback.candidatePlugin.indexOf('godot-bridge') > 0, fallback.candidatePlugin)
  check('install and stop timeouts have defaults', fallback.installTimeoutMs === 120000 && fallback.stopTimeoutMs === 5000, JSON.stringify({ install: fallback.installTimeoutMs, stop: fallback.stopTimeoutMs }))
}

// ── CLI prefix args and extra environment (source CLIs, space-containing exe paths) ──
{
  const fs = fakeFs()
  fs.setFile(
    join(PROJECT, HARNESS_CONFIG_FILE),
    JSON.stringify({
      dshSource: SOURCE,
      dshCommand: 'C:\\Program Files\\nodejs\\node.exe',
      dshArgs: ['--import', '/x/tsx.mjs', '/x/apps/cli/src/bin.ts'],
      dshEnv: { TSX_TSCONFIG_PATH: '/x/tsconfig.base.json' },
    }),
  )
  const config = await resolveHarnessConfig({ projectPath: PROJECT, fsOps: fs, env: {} })
  check('the CLI prefix args come from the project file', config.dshArgs.join(' ') === '--import /x/tsx.mjs /x/apps/cli/src/bin.ts', JSON.stringify(config.dshArgs))
  check('argv[0] may contain spaces because no shell is involved', config.dshCommand === 'C:\\Program Files\\nodejs\\node.exe', config.dshCommand)
  check('extra CLI environment comes from the project file', config.dshEnv.TSX_TSCONFIG_PATH === '/x/tsconfig.base.json', JSON.stringify(config.dshEnv))
  const overridden = await resolveHarnessConfig({
    projectPath: PROJECT,
    fsOps: fs,
    env: {
      DSH_TEST_HARNESS_DSH: 'node',
      DSH_TEST_HARNESS_DSH_ARGS: '["--import", "/y/loader.mjs", "/y/bin.ts"]',
      DSH_TEST_HARNESS_DSH_ENV: '{"ELECTRON_RUN_AS_NODE":"1"}',
    },
  })
  check('a JSON env list keeps prefix args intact', overridden.dshArgs.join(' ') === '--import /y/loader.mjs /y/bin.ts', JSON.stringify(overridden.dshArgs))
  check('a JSON env map supplies CLI environment', overridden.dshEnv.ELECTRON_RUN_AS_NODE === '1', JSON.stringify(overridden.dshEnv))
  const fallback = await resolveHarnessConfig({ projectPath: '/none', fsOps: fs, env: {} })
  check('cli args and env default to empty', fallback.dshArgs.length === 0 && Object.keys(fallback.dshEnv).length === 0, JSON.stringify({ args: fallback.dshArgs, env: fallback.dshEnv }))
}

// ── the printed process token and the browser cookie ─────────────────────
{
  check('the process token is read from the launcher line', tokenFromLogs('dsh web: http://127.0.0.1:39000/?token=abc_DEF-123\n') === 'abc_DEF-123')
  check('the last printed token wins', tokenFromLogs('?token=first\n?token=second\n') === 'second')
  check('a log without a token yields null', tokenFromLogs('dsh web ready\n') === null)
  check('the token is appended to a bare URL', tokenUrl('http://127.0.0.1:1/', 'abc') === 'http://127.0.0.1:1/?token=abc', tokenUrl('http://127.0.0.1:1/', 'abc'))
  check('an existing token is not duplicated', tokenUrl('http://127.0.0.1:1/?token=x', 'abc') === 'http://127.0.0.1:1/?token=x')
}

// ── the packaged production version, read through app.asar ───────────────
function syntheticAsar(entries) {
  const files = {}
  const bodies = []
  let cursor = 0
  for (const path of Object.keys(entries)) {
    const text = Buffer.from(entries[path])
    const parts = path.split('/')
    let node = files
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (node[parts[index]] === undefined) node[parts[index]] = { files: {} }
      node = node[parts[index]].files
    }
    node[parts[parts.length - 1]] = { offset: String(cursor), size: text.length }
    bodies.push(text)
    cursor += text.length
  }
  const header = Buffer.from(JSON.stringify({ files: files }))
  const headerSize = (8 + header.length + 3) & ~3
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(headerSize, 4)
  head.writeUInt32LE(headerSize - 4, 8)
  head.writeUInt32LE(header.length, 12)
  const padding = Buffer.alloc(8 + headerSize - 16 - header.length)
  return Buffer.concat([head, header, padding, ...bodies])
}
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-harness-asar-'))
  try {
    const archive = join(root, 'resources', 'app.asar')
    const cliManifest = JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.8.7' })
    const runtimeManifest = JSON.stringify({ version: '9.8.6' })
    mkdirSync(join(root, 'resources'), { recursive: true })
    writeFileSync(archive, syntheticAsar({ 'dsh/node_modules/@deepseek-ai/dsh/package.json': cliManifest, 'dsh/package.json': runtimeManifest }))
    check('an asar entry reads as its file text', readAsarEntry(archive, 'dsh/package.json') === runtimeManifest, String(readAsarEntry(archive, 'dsh/package.json')))
    check('a missing asar entry is null', readAsarEntry(archive, 'nope/package.json') === null)
    check('a malformed archive is null, not a throw', readAsarEntry(join(root, 'nope.asar'), 'dsh/package.json') === null)
    const execPath = join(root, 'DeepSeek Harness.exe')
    check('the packaged dsh version comes from inside app.asar', defaultProductionVersion(null, { execPath: execPath, env: {} }) === '9.8.7', String(defaultProductionVersion(null, { execPath: execPath, env: {} })))
    check('the explicit version wins over the packaged one', defaultProductionVersion('1.0.0', { execPath: execPath, env: {} }) === '1.0.0')
    check('DSH_VERSION wins over the packaged one', defaultProductionVersion(null, { execPath: execPath, env: { DSH_VERSION: '2.0.0' } }) === '2.0.0')
    const plain = join(root, 'plain')
    mkdirSync(join(plain, 'resources', 'app'), { recursive: true })
    writeFileSync(join(plain, 'resources', 'app', 'package.json'), JSON.stringify({ version: '3.2.1' }))
    check('an unpacked install manifest is read too', defaultProductionVersion(null, { execPath: join(plain, 'x.exe'), env: {} }) === '3.2.1')
    check('an install with no manifest is unknown, never a made-up match', defaultProductionVersion(null, { execPath: join(root, 'empty', 'x.exe'), env: {} }) === null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
check(
  'the CLI argv carries the command, its prefix args and the call args in order',
  dshArgv({ dshCommand: 'node', dshArgs: ['--import', '/x/tsx.mjs'] }, ['--profile', 'web']).join(' ') === 'node --import /x/tsx.mjs --profile web',
  dshArgv({ dshCommand: 'node', dshArgs: ['--import'] }, []).join(' '),
)

// ── start: isolated home/profile/port, candidate plugin, real argv ────────
{
  const rig = baseOptions()
  const started = await rig.harness.start(PROJECT)
  check('start reports running on a free port', started.ok === true && started.status === 'running' && started.port >= 39000 && started.port < 39005, JSON.stringify(started))
  check(
    'without a printed token the url is the bare origin and cookie is false',
    /^http:\/\/127\.0\.0\.1:\d+\/$/.test(String(started.url)) && started.cookie === false && started.url.indexOf('token=') < 0,
    JSON.stringify({ url: started.url, cookie: started.cookie }),
  )
  check('the instance home is under the temp root, not the production home', norm(started.home).indexOf(norm(TMP) + '/godot-bridge-harness-') === 0, started.home)
  check('the project is an independent copy', norm(started.projectCopy).indexOf(norm(TMP)) === 0 && norm(started.projectCopy) !== norm(PROJECT), started.projectCopy)
  check('the temp root was created and the project copied', rig.fs.calls.mkdtemp.length === 1 && rig.fs.calls.cp.length === 1 && rig.fs.calls.cp[0].from === PROJECT, JSON.stringify(rig.fs.calls.cp))
  const install = rig.proc.calls.filter((call) => call.command.indexOf(' plugin ') >= 0)[0]
  const web = rig.proc.calls.filter((call) => call.web === true)[0]
  check(
    'the candidate plugin is installed into the isolated profile',
    install !== undefined && install.command.indexOf('dsh plugin --profile web add ' + CANDIDATE) >= 0,
    JSON.stringify(install && install.command),
  )
  check(
    'the web profile is selected on the launcher, before the app args',
    web !== undefined && web.command.indexOf('dsh --profile web --host 127.0.0.1 --port ' + String(started.port) + ' --no-open') === 0,
    JSON.stringify(web && web.command),
  )
  check(
    'the child gets only the isolated DSH_HOME/DSH_PROFILE override',
    web !== undefined &&
      Object.keys(web.env).sort().join(',') === 'DSH_HOME,DSH_PROFILE' &&
      web.env.DSH_HOME === started.home &&
      web.env.DSH_PROFILE === 'web',
    JSON.stringify(web && web.env),
  )
  check('the versions match', started.sourceVersion === '1.2.3' && started.productionVersion === '1.2.3' && started.versionStatus === 'match' && started.versionMismatch === false, JSON.stringify(started))
  check('logs capture the process output', rig.harness.logs().logs.indexOf('dsh web ready') >= 0, rig.harness.logs().logs)
  await rig.harness.stop()
}

// ── prefix args and CLI environment reach both children ──────────────────
{
  const rig = baseOptions({
    config: {
      dshCommand: 'C:\\Program Files\\nodejs\\node.exe',
      dshArgs: ['--import', '/x/tsx.mjs', '/x/bin.ts'],
      dshEnv: { TSX_TSCONFIG_PATH: '/x/tsconfig.base.json' },
    },
  })
  const started = await rig.harness.start(PROJECT)
  const install = rig.proc.calls.filter((call) => call.command.indexOf(' plugin ') >= 0)[0]
  const web = rig.proc.calls.filter((call) => call.web === true)[0]
  const prefix = 'C:\\Program Files\\nodejs\\node.exe --import /x/tsx.mjs /x/bin.ts'
  check(
    'the install command carries the configured CLI and its prefix args',
    started.ok === true && install !== undefined && install.command.indexOf(prefix + ' plugin --profile web add ') === 0,
    JSON.stringify(install && install.command),
  )
  check(
    'the web command carries the same prefix args',
    web !== undefined && web.command.indexOf(prefix + ' --profile web --host 127.0.0.1 --port ') === 0,
    JSON.stringify(web && web.command),
  )
  check(
    'the configured CLI environment reaches the child',
    web !== undefined && web.env.TSX_TSCONFIG_PATH === '/x/tsconfig.base.json' && web.env.DSH_HOME === started.home,
    JSON.stringify(web && web.env),
  )
  await rig.harness.stop()
}
{
  // a non-default profile must reach the launcher, not just the plugin install
  const rig = baseOptions({ config: { profile: 'test-web' } })
  const started = await rig.harness.start(PROJECT)
  const web = rig.proc.calls.filter((call) => call.web === true)[0]
  check(
    'a custom profile is carried by the web command',
    started.ok === true && web !== undefined && web.command.indexOf('dsh --profile test-web --host 127.0.0.1 --port ') === 0,
    JSON.stringify(web && web.command),
  )
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
  const rig = baseOptions({ config: { productionPort: 39000 } })
  const started = await rig.harness.start(PROJECT)
  check('the production port is never a candidate', started.ok === true && started.port === 39001, String(started.port))
  await rig.harness.stop()
}

// ── install failure and install timeout: terminated, cleaned, logs kept ────
{
  const rig = baseOptions({ process: { installExit: 1 } })
  const started = await rig.harness.start(PROJECT)
  check('a failed plugin install refuses the start', started.ok === false && started.code === 'plugin-install-failed', JSON.stringify(started))
  check('the temp root is cleaned after a failed install', rig.fs.calls.rm.length === 1, JSON.stringify(rig.fs.calls.rm))
  check('no instance is reported', rig.harness.status().running === false, JSON.stringify(rig.harness.status()))
}
{
  const rig = baseOptions({ process: { installHangs: true }, config: { installTimeoutMs: 15 } })
  const started = await rig.harness.start(PROJECT)
  check('a hung install times out instead of hanging the start', started.ok === false && started.code === 'install-timeout', JSON.stringify(started))
  const handle = rig.proc.handles.filter((entry) => entry.web === false)[0]
  check('the hung install is terminated and waited on', handle !== undefined && handle.terminated === true && handle.waitCalls >= 1, JSON.stringify(handle && { terminated: handle.terminated, waits: handle.waitCalls }))
  check('and the temp root is cleaned', rig.fs.calls.rm.length === 1, JSON.stringify(rig.fs.calls.rm))
}

// ── web exits immediately and health timeout: terminated and cleaned ──────
{
  const rig = baseOptions({ process: { webExits: true } })
  const started = await rig.harness.start(PROJECT)
  check('a web process that exits is a failed start', started.ok === false && started.code === 'server-exited', JSON.stringify(started))
  check('and its temp root is cleaned', rig.fs.calls.rm.length === 1, JSON.stringify(rig.fs.calls.rm))
}
{
  const rig = baseOptions({ http: { failAll: true } })
  const started = await rig.harness.start(PROJECT)
  check('an unhealthy instance refuses the start', started.ok === false && started.code === 'health-timeout', JSON.stringify(started))
  const web = rig.proc.handles.filter((entry) => entry.web === true)[0]
  check('the failed web process is terminated and waited on', web !== undefined && web.terminated === true && web.waitCalls >= 1, JSON.stringify(web && { terminated: web.terminated, waits: web.waitCalls }))
  check('and the temp root is removed', rig.fs.calls.rm.length === 1, JSON.stringify(rig.fs.calls.rm))
  check('the failure keeps the process logs for diagnosis', String(started.lastLogs).indexOf('dsh web ready') >= 0, String(started.lastLogs))
  check('and status exposes the last logs after the instance is gone', rig.harness.status().lastLogs.indexOf('dsh web ready') >= 0, rig.harness.status().lastLogs)
}

// ── restart: stop, clean, start again on a new port ──────────────────────
{
  const busy = new Set()
  const rig = baseOptions({ probePort: async (port) => busy.has(port) === false })
  const started = await rig.harness.start(PROJECT)
  check('the first start runs', started.ok === true, JSON.stringify(started))
  const firstHome = started.home
  const firstWeb = rig.proc.handles.filter((entry) => entry.web === true)[0]
  busy.add(started.port)
  const restarted = await rig.harness.restart(PROJECT)
  check('restart reports a running instance on a new port', restarted.ok === true && restarted.status === 'running' && restarted.port !== started.port, JSON.stringify(restarted))
  check('restart terminates the old process before starting again', firstWeb !== undefined && firstWeb.terminated === true && firstWeb.waitCalls >= 1, JSON.stringify(firstWeb && { terminated: firstWeb.terminated, waits: firstWeb.waitCalls }))
  check('restart counts the restart', rig.harness.status().restarts === 1, JSON.stringify(rig.harness.status()))
  check(
    'the old temp root was removed',
    rig.fs.calls.rm.some((path) => norm(path).endsWith(norm(firstHome).replace(/\/home$/, ''))),
    JSON.stringify({ firstHome: firstHome, rm: rig.fs.calls.rm }),
  )
  await rig.harness.stop()
}

// ── stop: terminate + waitForExit, clean, idempotent ─────────────────────
{
  const rig = baseOptions()
  const started = await rig.harness.start(PROJECT)
  const web = rig.proc.handles.filter((entry) => entry.web === true)[0]
  const stopped = await rig.harness.stop()
  check('stop reports the instance stopped', stopped.ok === true && stopped.stopped === true, JSON.stringify(stopped))
  check('stop terminates and waits for the process', web !== undefined && web.terminated === true && web.waitCalls >= 1, JSON.stringify(web && { terminated: web.terminated, waits: web.waitCalls }))
  check('the temp root is removed on stop', rig.fs.calls.rm.length === 1, JSON.stringify(rig.fs.calls.rm))
  check('status is stopped', rig.harness.status().status === 'stopped' && rig.harness.status().running === false, JSON.stringify(rig.harness.status()))
  const again = await rig.harness.stop()
  check('stopping twice is harmless', again.ok === true && again.alreadyStopped === true, JSON.stringify(again))
  check('the first home was under the temp root', norm(started.home).indexOf(norm(TMP)) === 0, started.home)
}

// ── a process that refuses to exit is reported, root kept ─────────────────
{
  const rig = baseOptions({ process: { noExit: true } })
  await rig.harness.start(PROJECT)
  const web = rig.proc.handles.filter((entry) => entry.web === true)[0]
  const stopped = await rig.harness.stop()
  check('a process that will not exit refuses the stop', stopped.ok === false && stopped.code === 'stop-timeout', JSON.stringify(stopped))
  check('termination was requested and waited on', web !== undefined && web.terminated === true && web.waitCalls >= 1, JSON.stringify(web && { terminated: web.terminated, waits: web.waitCalls }))
  check('the still-live process keeps its temp root and port', rig.fs.calls.rm.length === 0 && rig.harness.status().running === true, JSON.stringify({ rm: rig.fs.calls.rm, status: rig.harness.status() }))
}

// ── smoke: page, health, plugin row and the task-center API ──────────────
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

// ── the real web auth handshake: token -> 303 + cookie -> 200 ────────────
{
  const rig = baseOptions({ process: { webOutput: 'dsh web: http://127.0.0.1:39000/?token=fixture-token\n' }, http: { auth: true } })
  const started = await rig.harness.start(PROJECT)
  check('the printed process token is captured at start', started.ok === true && started.token === 'fixture-token', JSON.stringify({ ok: started.ok, token: started.token, code: started.code }))
  check('the 303 exchange was kept as a cookie and the token leaves the health URL', started.ok === true && started.cookie === true && started.healthUrl === 'http://127.0.0.1:39000/', JSON.stringify({ cookie: started.cookie, healthUrl: started.healthUrl }))
  check(
    'start returns the token-carrying url and the cookie flag',
    started.ok === true && started.url === 'http://127.0.0.1:39000/?token=fixture-token' && started.cookie === true,
    JSON.stringify({ url: started.url, cookie: started.cookie }),
  )
  const authStatus = rig.harness.status()
  check(
    'status exposes the same token url, cookie flag, port and token',
    authStatus.url === 'http://127.0.0.1:39000/?token=fixture-token' && authStatus.cookie === true && authStatus.port === 39000 && authStatus.token === 'fixture-token',
    JSON.stringify({ url: authStatus.url, cookie: authStatus.cookie, port: authStatus.port }),
  )
  const exchange = rig.http.calls.filter((call) => call.method === 'exchange')[0]
  check('the one-shot token is exchanged once', exchange !== undefined && exchange.url.indexOf('token=fixture-token') > 0, JSON.stringify(exchange && exchange.url))
  check(
    'health is polled with the cookie, never the one-shot token',
    rig.http.calls.every((call) => call.method === 'exchange' || call.url.indexOf('token=') < 0),
    JSON.stringify(rig.http.calls.map((call) => call.url)),
  )
  const smoke = await rig.harness.smoke(PROJECT)
  check('smoke passes through the cookie-authenticated page', smoke.ok === true && smoke.checks.page.status === 200 && smoke.checks.page.cookie === true, JSON.stringify(smoke))
  const page = rig.http.calls.filter((call) => call.method === 'get' && call.url === 'http://127.0.0.1:39000/')[0]
  check('the page request carries the exchanged cookie', page !== undefined && page.cookie === 'dsh_auth=fixture-token', JSON.stringify(page))
  check('the plugin routes stay reachable without the cookie', rig.http.calls.some((call) => call.url.indexOf('/godot-bridge/task-center/state') >= 0), JSON.stringify(rig.http.calls.map((call) => call.url)))
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

// ── no subprocess service: readable refusal, nothing created ─────────────
{
  const rg = baseOptions()
  const harness = createHarness({ ctx: { get: () => undefined }, fsOps: rg.fs, http: rg.http.http, tmpdir: () => TMP, platform: 'linux', env: {} })
  const started = await harness.start(PROJECT)
  check('without the subprocess service the start refuses', started.ok === false && started.code === 'no-subprocess-service', JSON.stringify(started))
  check('and nothing was copied or spawned', rg.fs.calls.cp.length === 0 && rg.proc.calls.length === 0, JSON.stringify({ cp: rg.fs.calls.cp.length, spawn: rg.proc.calls.length }))
}

// ── host actions: only the tester (or the user) drives the harness ────────
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
      return { ok: true, status: 'running', port: 39000, token: 'fixture-token', url: 'http://127.0.0.1:39000/?token=fixture-token', cookie: true }
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
      return { ok: true, status: 'running', port: 39000, token: 'fixture-token', url: 'http://127.0.0.1:39000/?token=fixture-token', cookie: true }
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
  check('harnessStart returns the token url and cookie flag', started.url === 'http://127.0.0.1:39000/?token=fixture-token' && started.cookie === true, JSON.stringify({ url: started.url, cookie: started.cookie }))
  check('the project is passed to the harness', rg.calls.length === 1 && rg.calls[0].action === 'start' && rg.calls[0].project === rg.rig.project, JSON.stringify(rg.calls))
  const status = await rg.api.perform('harnessStatus', {}, rg.tester)
  check('the tester can read the harness status and logs', status.ok === true && status.harness.status === 'running' && status.logs.logs === 'harness log tail', JSON.stringify(status))
  check(
    'harnessStatus mirrors url/cookie/port/token at the top level',
    status.url === 'http://127.0.0.1:39000/?token=fixture-token' && status.cookie === true && status.port === 39000 && status.token === 'fixture-token',
    JSON.stringify({ url: status.url, cookie: status.cookie, port: status.port, token: status.token }),
  )
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
