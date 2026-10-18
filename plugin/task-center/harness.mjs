// An ISOLATED DeepSeek Harness test instance: a throwaway DSH_HOME/profile,
// its own free port and its own copy of the project, started through the host
// subprocess service. It is what a tester uses to prove that the candidate
// plugin loads and that the task-center route/API answer — without touching the
// production profile, session or port.
//
// Nothing here starts Godot; Godot is a separate tester step. This module never
// imports the production profile: every path it writes lives under one temp
// root that stop()/cleanup() removes.

import { createServer } from 'node:net'
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where the DSH source checkout lives by default (overridable by the project
 * config or the environment). */
export const DEFAULT_DSH_SOURCE = 'J:\\workspace\\HARNESS\\deepseek-harness'

/** The candidate plugin is this package unless configured otherwise. */
export const DEFAULT_CANDIDATE_PLUGIN = fileURLToPath(new URL('../../', import.meta.url))

export const HARNESS_DEFAULTS = {
  dshSource: DEFAULT_DSH_SOURCE,
  candidatePlugin: DEFAULT_CANDIDATE_PLUGIN,
  dshCommand: 'dsh',
  profile: 'web',
  portBase: 39000,
  portRange: 100,
  healthPath: '/',
  healthTimeoutMs: 30000,
  healthIntervalMs: 250,
  testTimeoutMs: 10 * 60 * 1000,
}

/** Project config file (overridable per project, never required). */
export const HARNESS_CONFIG_FILE = '.agents/test-harness.json'

const MAX_LOG_BYTES = 1024 * 1024
const MAX_LOG_TAIL_BYTES = 64 * 1024
const SKIP_COPY = new Set(['.git', '.worktrees', 'node_modules', 'dist', 'coverage'])

const sleepFor = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

/** Read one JSON file; null when missing or malformed. */
async function readJson(fsOps, path) {
  try {
    const text = await fsOps.readFile(path)
    return JSON.parse(String(text).replace(/^\uFEFF/, ''))
  } catch (error) {
    return null
  }
}

/**
 * Resolve the harness configuration: defaults < project .agents/test-harness.json
 * < environment. Every field is optional, so a project that configures nothing
 * still gets an isolated instance.
 */
export async function resolveHarnessConfig(options) {
  const opts = options === undefined ? {} : options
  const projectPath = typeof opts.projectPath === 'string' && opts.projectPath.length > 0 ? opts.projectPath : null
  const fsOps = opts.fsOps === undefined ? defaultFsOps() : opts.fsOps
  const env = opts.env === undefined ? process.env : opts.env
  const defaults = Object.assign({}, HARNESS_DEFAULTS, opts.defaults === undefined ? {} : opts.defaults)
  let file = null
  if (projectPath !== null) file = await readJson(fsOps, join(projectPath, HARNESS_CONFIG_FILE))
  const source = file !== null && typeof file === 'object' && !Array.isArray(file) ? file : {}
  const pick = (fileKey, envKey, fallback) => {
    if (typeof source[fileKey] === 'string' && source[fileKey].trim() !== '') return source[fileKey].trim()
    if (typeof env[envKey] === 'string' && env[envKey].trim() !== '') return env[envKey].trim()
    return fallback
  }
  const number = (fileKey, envKey, fallback) => {
    const envValue = env[envKey]
    if (typeof envValue === 'number' && Number.isFinite(envValue)) return Math.floor(envValue)
    if (typeof envValue === 'string' && envValue.trim() !== '') {
      const fromEnv = Number(envValue)
      if (Number.isFinite(fromEnv)) return Math.floor(fromEnv)
    }
    const fileValue = source[fileKey]
    if (typeof fileValue === 'number' && Number.isFinite(fileValue)) return Math.floor(fileValue)
    if (typeof fileValue === 'string' && fileValue.trim() !== '') {
      const fromFile = Number(fileValue)
      if (Number.isFinite(fromFile)) return Math.floor(fromFile)
    }
    return fallback
  }
  const config = {
    projectPath: projectPath,
    dshSource: pick('dshSource', 'DSH_TEST_HARNESS_SOURCE', defaults.dshSource),
    candidatePlugin: pick('candidatePlugin', 'DSH_TEST_HARNESS_CANDIDATE', defaults.candidatePlugin),
    dshCommand: pick('dshCommand', 'DSH_TEST_HARNESS_DSH', defaults.dshCommand),
    profile: pick('profile', 'DSH_TEST_HARNESS_PROFILE', defaults.profile),
    portBase: number('portBase', 'DSH_TEST_HARNESS_PORT_BASE', defaults.portBase),
    portRange: number('portRange', 'DSH_TEST_HARNESS_PORT_RANGE', defaults.portRange),
    healthPath: pick('healthPath', 'DSH_TEST_HARNESS_HEALTH_PATH', defaults.healthPath),
    healthTimeoutMs: number('healthTimeoutMs', 'DSH_TEST_HARNESS_HEALTH_TIMEOUT_MS', defaults.healthTimeoutMs),
    healthIntervalMs: number('healthIntervalMs', 'DSH_TEST_HARNESS_HEALTH_INTERVAL_MS', defaults.healthIntervalMs),
    // A production port is never a candidate even when it looks free.
    productionPort: number('productionPort', 'DSH_TEST_HARNESS_PRODUCTION_PORT', null),
    productionVersion: pick('productionVersion', 'DSH_TEST_HARNESS_PRODUCTION_VERSION', null),
  }
  config.portRange = Math.max(1, Math.min(1000, config.portRange))
  return config
}

/** The version of the DSH source checkout, or null. */
export async function sourceVersionOf(fsOps, dshSource) {
  const manifest = await readJson(fsOps, join(dshSource, 'package.json'))
  if (manifest === null || typeof manifest.version !== 'string' || manifest.version.trim() === '') return null
  return manifest.version.trim()
}

/** The production DSH version: explicit config first, then the running install. */
export function defaultProductionVersion(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  if (typeof process.env.DSH_VERSION === 'string' && process.env.DSH_VERSION.trim() !== '') return process.env.DSH_VERSION.trim()
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'package.json'), 'utf8'))
    if (typeof manifest.version === 'string' && manifest.version !== '') return manifest.version
  } catch (error) {}
  return null
}

/** 'match' when both sides are known and equal, 'mismatch' when they differ, and
 * 'unknown' when one side could not be read — never quietly a pass. */
export function compareVersions(sourceVersion, productionVersion) {
  if (typeof sourceVersion !== 'string' || sourceVersion === '' || typeof productionVersion !== 'string' || productionVersion === '') return 'unknown'
  return sourceVersion === productionVersion ? 'match' : 'mismatch'
}

/** Windows-safe shell quoting for one argument. */
function quoteArg(value) {
  const text = String(value)
  if (text === '') return '""'
  return /[\s"&|<>^]/.test(text) ? '"' + text.replace(/"/g, '\\"') + '"' : text
}

/** Build one shell command string for the host subprocess service. */
export function shellCommand(parts, platform) {
  const list = parts.map(quoteArg).join(' ')
  return platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', list] : ['/bin/sh', '-c', list]
}

function defaultFsOps() {
  return {
    mkdtemp,
    mkdir,
    rm,
    cp,
    readFile,
    tmpdir,
  }
}

function defaultHttp() {
  return {
    async get(url) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
      return { status: response.status, ok: response.ok === true, body: await response.text() }
    },
    async post(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      return { status: response.status, ok: response.ok === true, body: await response.text() }
    },
  }
}

/** True when the port can be bound on 127.0.0.1 right now. */
export function defaultProbePort(port) {
  return new Promise((resolveProbe) => {
    const server = createServer()
    let settled = false
    const finish = (free) => {
      if (settled) return
      settled = true
      resolveProbe(free)
    }
    server.once('error', () => finish(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => finish(true))
    })
  })
}

/**
 * The isolated instance manager. One instance at a time; every start allocates
 * a fresh temp root and free port.
 */
export function createHarness(options) {
  const opts = options === undefined ? {} : options
  const ctx = opts.ctx
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform
  const env = opts.env === undefined ? process.env : opts.env
  const fsOps = opts.fsOps === undefined ? defaultFsOps() : opts.fsOps
  const http = opts.http === undefined ? defaultHttp() : opts.http
  const probePort = typeof opts.probePort === 'function' ? opts.probePort : defaultProbePort
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : sleepFor
  const resolveConfig = typeof opts.resolveConfig === 'function' ? opts.resolveConfig : resolveHarnessConfig
  const readProductionVersion = typeof opts.productionVersion === 'function' ? opts.productionVersion : defaultProductionVersion
  const tmpBase = typeof opts.tmpdir === 'function' ? opts.tmpdir() : tmpdir()
  const subprocess =
    opts.subprocess !== undefined
      ? opts.subprocess
      : (() => {
          try {
            return ctx.get('subprocess')
          } catch (error) {
            return null
          }
        })()

  const state = {
    status: 'stopped',
    instance: null,
    lastError: null,
    restarts: 0,
    startedAt: null,
  }

  function failure(code, message, extra) {
    return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
  }

  function snapshot() {
    const instance = state.instance
    if (instance === null) {
      return {
        ok: true,
        status: state.status,
        running: false,
        lastError: state.lastError,
        restarts: state.restarts,
      }
    }
    return {
      ok: true,
      status: state.status,
      running: state.status === 'running',
      port: instance.port,
      home: instance.home,
      profile: instance.profile,
      projectCopy: instance.projectCopy,
      dshSource: instance.dshSource,
      candidatePlugin: instance.candidatePlugin,
      sourceVersion: instance.sourceVersion,
      productionVersion: instance.productionVersion,
      versionStatus: instance.versionStatus,
      versionMismatch: instance.versionStatus !== 'match',
      restarts: state.restarts,
      startedAt: instance.startedAt,
      pluginInstalled: instance.pluginInstalled,
      lastError: state.lastError,
    }
  }

  function logs() {
    const instance = state.instance
    if (instance === null || instance.process === null) return { ok: true, logs: '' }
    const handle = instance.process
    let text = ''
    try {
      if (handle.collected && handle.collected.stdout && typeof handle.collected.stdout.readFrom === 'function') {
        text = String(handle.collected.stdout.readFrom(0).text || '')
      }
    } catch (error) {}
    try {
      if (handle.collected && handle.collected.stderr && typeof handle.collected.stderr.readFrom === 'function') {
        text += String(handle.collected.stderr.readFrom(0).text || '')
      }
    } catch (error) {}
    return { ok: true, logs: text.length > MAX_LOG_TAIL_BYTES ? text.slice(text.length - MAX_LOG_TAIL_BYTES) : text }
  }

  async function allocatePort(config) {
    if (Number.isFinite(config.productionPort) && config.productionPort > 0) {
      // The production port is not a candidate; probing would skip it anyway,
      // but a closed production instance must not be borrowed either.
    }
    const first = Number.isFinite(config.portBase) ? config.portBase : HARNESS_DEFAULTS.portBase
    const range = Number.isFinite(config.portRange) ? config.portRange : HARNESS_DEFAULTS.portRange
    for (let offset = 0; offset < range; offset += 1) {
      const port = first + offset
      if (Number.isFinite(config.productionPort) && port === config.productionPort) continue
      let free = false
      try {
        free = (await probePort(port)) === true
      } catch (error) {
        free = false
      }
      if (free === true) return port
    }
    return null
  }

  function readJsonText(path) {
    return readJson(fsOps, path)
  }

  function spawnProcess(parts, cwd, extraEnv) {
    const argv = shellCommand(parts, platform)
    try {
      const handle = subprocess.spawn({
        argv: argv,
        cwd: cwd,
        env: Object.assign({}, env, extraEnv === undefined ? {} : extraEnv),
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: MAX_LOG_BYTES } },
          stderr: { collect: { maxBytes: MAX_LOG_BYTES } },
        },
        graceMs: HARNESS_DEFAULTS.testTimeoutMs,
      })
      return { ok: true, handle: handle }
    } catch (error) {
      return { ok: false, code: 'spawn-failed', message: String((error && error.message) || error) }
    }
  }

  async function runCommand(parts, cwd, extraEnv) {
    const spawned = spawnProcess(parts, cwd, extraEnv)
    if (spawned.ok !== true) return spawned
    const handle = spawned.handle
    let outcome = null
    try {
      outcome = await handle.done
    } catch (error) {
      return { ok: false, code: 'spawn-failed', message: String((error && error.message) || error), handle: handle }
    }
    const exitCode = outcome !== null && outcome !== undefined && Number.isFinite(outcome.exitCode) ? outcome.exitCode : 1
    let stdout = ''
    let stderr = ''
    try {
      if (handle.collected && handle.collected.stdout && typeof handle.collected.stdout.readFrom === 'function') {
        stdout = String(handle.collected.stdout.readFrom(0).text || '')
      }
      if (handle.collected && handle.collected.stderr && typeof handle.collected.stderr.readFrom === 'function') {
        stderr = String(handle.collected.stderr.readFrom(0).text || '')
      }
    } catch (error) {}
    return { ok: exitCode === 0, code: exitCode === 0 ? null : 'command-failed', exitCode: exitCode, stdout: stdout, stderr: stderr, handle: handle }
  }

  async function killProcess(handle) {
    if (handle === null || handle === undefined) return
    try {
      if (typeof handle.kill === 'function') {
        await handle.kill({ graceMs: 5000 })
        return
      }
      if (subprocess !== null && subprocess !== undefined && typeof subprocess.kill === 'function') {
        await subprocess.kill(handle, { graceMs: 5000 })
        return
      }
    } catch (error) {}
    // The handle's done promise is the remaining signal; never throw here.
    try {
      await Promise.race([handle.done, sleep(5000)])
    } catch (error) {}
  }

  async function cleanRoot(root) {
    if (typeof root !== 'string' || root === '') return
    const base = resolve(tmpBase)
    const target = resolve(root)
    if (target !== base && !target.startsWith(base + sep)) {
      // Never rm anything outside the temp base, even with a corrupted state.
      return
    }
    try {
      await fsOps.rm(target, { recursive: true, force: true })
    } catch (error) {}
  }

  async function waitHealth(instance, exitedOf) {
    const config = instance.config
    const url = 'http://127.0.0.1:' + String(instance.port) + config.healthPath
    const attempts = Math.max(1, Math.ceil(config.healthTimeoutMs / Math.max(1, config.healthIntervalMs)))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const exited = typeof exitedOf === 'function' ? exitedOf() : null
      if (exited !== null && exited !== undefined) return false
      try {
        const response = await http.get(url)
        if (response !== null && response !== undefined && response.status >= 200 && response.status < 400) {
          return (typeof exitedOf === 'function' ? exitedOf() : null) === null
        }
      } catch (error) {}
      await sleep(config.healthIntervalMs)
    }
    return false
  }

  async function startInternal(projectPath) {
    if (state.instance !== null) {
      const stopped = await stopInternal()
      if (stopped.ok !== true) return stopped
    }
    if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
      return failure('no-subprocess-service', 'the host subprocess service is not available, so an isolated DSH cannot be started')
    }
    if (projectPath === null) return failure('missing-project', 'the harness needs a project directory')
    const config = await resolveConfig({ projectPath: projectPath, fsOps: fsOps, env: env })
    if (typeof config.dshSource !== 'string' || config.dshSource === '') return failure('missing-source', 'no DSH source path is configured')
    const sourceVersion = await sourceVersionOf(fsOps, config.dshSource)
    const productionVersion = readProductionVersion(config.productionVersion)
    const versionStatus = compareVersions(sourceVersion, productionVersion)
    const port = await allocatePort(config)
    if (port === null) return failure('no-free-port', 'no free port in ' + String(config.portBase) + '..' + String(config.portBase + config.portRange - 1))
    let root = null
    try {
      root = await fsOps.mkdtemp(join(tmpBase, 'godot-bridge-harness-'))
    } catch (error) {
      return failure('temp-failed', 'could not create a temp root: ' + String((error && error.message) || error))
    }
    const home = join(root, 'home')
    const projectCopy = join(root, 'project')
    const instance = {
      root: root,
      home: home,
      projectCopy: projectCopy,
      profile: config.profile,
      port: port,
      dshSource: config.dshSource,
      candidatePlugin: config.candidatePlugin,
      sourceVersion: sourceVersion,
      productionVersion: productionVersion,
      versionStatus: versionStatus,
      pluginInstalled: false,
      process: null,
      config: config,
      startedAt: new Date(clock()).toISOString(),
      logs: '',
    }
    state.instance = instance
    state.status = 'starting'
    state.lastError = null
    state.startedAt = instance.startedAt
    const fail = async (code, message) => {
      state.status = 'failed'
      state.lastError = message
      await killProcess(instance.process)
      await cleanRoot(root)
      state.instance = null
      return failure(code, message)
    }
    try {
      await fsOps.mkdir(home, { recursive: true })
      await fsOps.mkdir(projectCopy, { recursive: true })
      // The project copy keeps the run away from the production board/state.
      await fsOps.cp(projectPath, projectCopy, {
        recursive: true,
        force: true,
        filter: (source) => {
          const name = String(source).replace(/\\/g, '/').split('/').pop()
          return !SKIP_COPY.has(name)
        },
      })
    } catch (error) {
      state.instance = null
      await cleanRoot(root)
      state.status = 'failed'
      state.lastError = String((error && error.message) || error)
      return failure('copy-failed', state.lastError)
    }
    const install = await runCommand(
      [config.dshCommand, 'plugin', '--profile', config.profile, 'add', config.candidatePlugin],
      projectCopy,
      { DSH_HOME: home, DSH_PROFILE: config.profile },
    )
    if (install.ok !== true) {
      return fail('plugin-install-failed', 'could not install the candidate plugin: ' + String(install.stderr || install.stdout || install.message || 'exit ' + String(install.exitCode)))
    }
    instance.pluginInstalled = true
    const web = spawnProcess(
      [config.dshCommand, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'],
      projectCopy,
      { DSH_HOME: home, DSH_PROFILE: config.profile },
    )
    if (web.ok !== true) {
      return fail(web.code, web.message)
    }
    instance.process = web.handle
    let exited = null
    try {
      web.handle.done.then(
        (outcome) => {
          exited = outcome === undefined || outcome === null ? { exitCode: null } : outcome
        },
        () => {
          exited = { exitCode: null }
        },
      )
    } catch (error) {}
    const healthy = await waitHealth(instance, () => exited)
    if (exited !== null) {
      return fail('server-exited', 'the DSH web process exited before it became healthy (exit ' + String(exited.exitCode) + ')')
    }
    if (healthy !== true) {
      return fail('health-timeout', 'the isolated DSH did not answer ' + config.healthPath + ' on port ' + String(port) + ' within ' + String(config.healthTimeoutMs) + 'ms')
    }
    state.status = 'running'
    return Object.assign(snapshot(), { ok: true, versionMismatch: versionStatus !== 'match' })
  }

  async function start(projectPath) {
    try {
      return await startInternal(typeof projectPath === 'string' && projectPath.length > 0 ? projectPath : null)
    } catch (error) {
      state.status = 'failed'
      state.lastError = String((error && error.message) || error)
      return failure('harness-error', state.lastError)
    }
  }

  async function health() {
    const instance = state.instance
    if (instance === null || state.status !== 'running') return { ok: false, code: 'not-running', message: 'no isolated DSH is running' }
    const url = 'http://127.0.0.1:' + String(instance.port) + instance.config.healthPath
    try {
      const response = await http.get(url)
      const ok = response !== null && response !== undefined && response.status >= 200 && response.status < 400
      return { ok: ok, status: response === undefined ? null : response.status, url: url }
    } catch (error) {
      return { ok: false, code: 'health-failed', message: String((error && error.message) || error) }
    }
  }

  async function stopInternal() {
    const instance = state.instance
    if (instance === null) {
      state.status = 'stopped'
      return { ok: true, stopped: true, alreadyStopped: true }
    }
    state.status = 'stopping'
    await killProcess(instance.process)
    await cleanRoot(instance.root)
    state.instance = null
    state.status = 'stopped'
    return { ok: true, stopped: true }
  }

  async function stop() {
    try {
      return await stopInternal()
    } catch (error) {
      state.status = 'failed'
      state.lastError = String((error && error.message) || error)
      return failure('harness-error', state.lastError)
    }
  }

  async function restart(projectPath) {
    const stopped = await stopInternal()
    if (stopped.ok !== true) return stopped
    state.restarts += 1
    return start(projectPath)
  }

  async function smoke(projectPath) {
    const instance = state.instance
    if (instance === null || state.status !== 'running') return failure('not-running', 'no isolated DSH is running')
    const port = instance.port
    const origin = 'http://127.0.0.1:' + String(port)
    const checks = {}
    const page = await http.get(origin + '/')
    checks.page = { ok: page.ok === true && page.status === 200, status: page.status, html: typeof page.body === 'string' && page.body.indexOf('<') >= 0 }
    const healthResponse = await http.get(origin + instance.config.healthPath)
    checks.health = { ok: healthResponse.ok === true && healthResponse.status >= 200 && healthResponse.status < 400, status: healthResponse.status }
    const stateUrl = origin + '/godot-bridge/task-center/state?project=' + encodeURIComponent(instance.projectCopy)
    const stateResponse = await http.get(stateUrl)
    let stateBody = null
    try {
      stateBody = JSON.parse(String(stateResponse.body))
    } catch (error) {
      stateBody = null
    }
    checks.pluginRow = { ok: stateResponse.ok === true && stateBody !== null && stateBody.ok === true, status: stateResponse.status }
    const action = await http.post(origin + '/godot-bridge/task-center/action', { action: 'board', project: instance.projectCopy })
    let actionBody = null
    try {
      actionBody = JSON.parse(String(action.body))
    } catch (error) {
      actionBody = null
    }
    checks.taskCenterAction = { ok: action.ok === true && actionBody !== null && actionBody.ok === true, status: action.status }
    const versionOk = instance.versionStatus === 'match'
    if (versionOk !== true) {
      return failure('version-mismatch', 'the DSH source version (' + String(instance.sourceVersion) + ') does not match the production version (' + String(instance.productionVersion) + ')', {
        checks: checks,
        sourceVersion: instance.sourceVersion,
        productionVersion: instance.productionVersion,
        versionStatus: instance.versionStatus,
      })
    }
    const failed = Object.keys(checks).filter((key) => checks[key].ok !== true)
    if (failed.length > 0) {
      return failure('smoke-failed', 'smoke checks failed: ' + failed.join(', '), { checks: checks })
    }
    return { ok: true, checks: checks, sourceVersion: instance.sourceVersion, productionVersion: instance.productionVersion, versionStatus: instance.versionStatus }
  }

  return {
    resolveConfig: (projectPath) => resolveConfig({ projectPath: projectPath, fsOps: fsOps, env: env }),
    start: start,
    stop: stop,
    restart: restart,
    health: health,
    smoke: smoke,
    status: snapshot,
    logs: logs,
    state: state,
  }
}
