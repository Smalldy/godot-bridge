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
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
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
  dshArgs: [],
  dshEnv: {},
  profile: 'web',
  portBase: 39000,
  portRange: 100,
  healthPath: '/',
  healthTimeoutMs: 30000,
  healthIntervalMs: 250,
  installTimeoutMs: 120000,
  stopTimeoutMs: 5000,
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
 * < environment (the environment always wins). Every field is optional, so a
 * project that configures nothing still gets an isolated instance.
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
    const envValue = env[envKey]
    if (typeof envValue === 'string' && envValue.trim() !== '') return envValue.trim()
    const fileValue = source[fileKey]
    if (typeof fileValue === 'string' && fileValue.trim() !== '') return fileValue.trim()
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
  const stringMap = (fileKey, envKey, fallback) => {
    const fromJson = (text) => {
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        const map = {}
        for (const key of Object.keys(parsed)) {
          if (typeof parsed[key] === 'string') map[key] = parsed[key]
        }
        return map
      } catch (error) {
        return null
      }
    }
    const envValue = env[envKey]
    if (typeof envValue === 'string' && envValue.trim() !== '') {
      const parsed = fromJson(envValue)
      if (parsed !== null) return parsed
    }
    const fileValue = source[fileKey]
    if (fileValue !== null && typeof fileValue === 'object' && !Array.isArray(fileValue)) {
      const map = {}
      for (const key of Object.keys(fileValue)) {
        if (typeof fileValue[key] === 'string' && fileValue[key] !== '') map[key] = fileValue[key]
      }
      return map
    }
    return Object.assign({}, fallback)
  }
  const stringList = (fileKey, envKey, fallback) => {
    const envValue = env[envKey]
    if (typeof envValue === 'string' && envValue.trim() !== '') {
      const text = envValue.trim()
      // A JSON array is the lossless form (paths may contain spaces); a plain
      // string is split on whitespace for the common `node --import x y` case.
      if (text.startsWith('[')) {
        try {
          const parsed = JSON.parse(text)
          if (Array.isArray(parsed)) return parsed.filter((value) => typeof value === 'string' && value !== '')
        } catch (error) {}
      }
      return text.split(/\s+/).filter((value) => value !== '')
    }
    const fileValue = source[fileKey]
    if (Array.isArray(fileValue)) return fileValue.filter((value) => typeof value === 'string' && value !== '')
    if (typeof fileValue === 'string' && fileValue.trim() !== '') return fileValue.trim().split(/\s+/).filter((value) => value !== '')
    return Array.isArray(fallback) ? fallback.slice() : []
  }
  const config = {
    projectPath: projectPath,
    dshSource: pick('dshSource', 'DSH_TEST_HARNESS_SOURCE', defaults.dshSource),
    candidatePlugin: pick('candidatePlugin', 'DSH_TEST_HARNESS_CANDIDATE', defaults.candidatePlugin),
    dshCommand: pick('dshCommand', 'DSH_TEST_HARNESS_DSH', defaults.dshCommand),
    dshArgs: stringList('dshArgs', 'DSH_TEST_HARNESS_DSH_ARGS', defaults.dshArgs),
    dshEnv: stringMap('dshEnv', 'DSH_TEST_HARNESS_DSH_ENV', defaults.dshEnv),
    profile: pick('profile', 'DSH_TEST_HARNESS_PROFILE', defaults.profile),
    portBase: number('portBase', 'DSH_TEST_HARNESS_PORT_BASE', defaults.portBase),
    portRange: number('portRange', 'DSH_TEST_HARNESS_PORT_RANGE', defaults.portRange),
    healthPath: pick('healthPath', 'DSH_TEST_HARNESS_HEALTH_PATH', defaults.healthPath),
    healthTimeoutMs: number('healthTimeoutMs', 'DSH_TEST_HARNESS_HEALTH_TIMEOUT_MS', defaults.healthTimeoutMs),
    healthIntervalMs: number('healthIntervalMs', 'DSH_TEST_HARNESS_HEALTH_INTERVAL_MS', defaults.healthIntervalMs),
    installTimeoutMs: number('installTimeoutMs', 'DSH_TEST_HARNESS_INSTALL_TIMEOUT_MS', defaults.installTimeoutMs),
    stopTimeoutMs: number('stopTimeoutMs', 'DSH_TEST_HARNESS_STOP_TIMEOUT_MS', defaults.stopTimeoutMs),
    productionPort: number('productionPort', 'DSH_TEST_HARNESS_PRODUCTION_PORT', null),
    productionVersion: pick('productionVersion', 'DSH_TEST_HARNESS_PRODUCTION_VERSION', null),
  }
  config.portRange = Math.max(1, Math.min(1000, config.portRange))
  config.installTimeoutMs = Math.max(1, config.installTimeoutMs)
  config.stopTimeoutMs = Math.max(1, config.stopTimeoutMs)
  return config
}

/** The version of the DSH source checkout, or null. */
export async function sourceVersionOf(fsOps, dshSource) {
  const manifest = await readJson(fsOps, join(dshSource, 'package.json'))
  if (manifest === null || typeof manifest.version !== 'string' || manifest.version.trim() === '') return null
  return manifest.version.trim()
}

/** Plain manifests inside an Electron install, relative to <install>/resources. */
const PACKAGED_MANIFESTS = [
  ['app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'],
  ['app.asar', 'dsh', 'package.json'],
  ['app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'],
  ['app.asar.unpacked', 'dsh', 'package.json'],
  ['app', 'package.json'],
]

/** Manifest entries inside app.asar, in the order that names the real dsh package first. */
const ASAR_MANIFESTS = ['dsh/node_modules/@deepseek-ai/dsh/package.json', 'dsh/package.json']

/** The `version` of one package.json text, or null. */
function manifestVersion(text) {
  if (typeof text !== 'string') return null
  try {
    const manifest = JSON.parse(text)
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null
  } catch (error) {
    return null
  }
}

/**
 * Read one file out of an Electron asar archive.
 *
 * An asar file is a tiny header (a 16-byte pickle whose last field is the JSON
 * header length, then the JSON tree) followed by the file data; every file
 * entry carries its offset relative to `8 + headerSize`. Plain `fs` cannot
 * follow a path *through* an asar, so a packaged install's version is
 * unreadable by path — this reads the same bytes Electron does.
 */
export function readAsarEntry(archivePath, entry) {
  let fd = null
  try {
    fd = openSync(archivePath, 'r')
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    if (!Number.isFinite(jsonSize) || jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) return null
    const headerBuffer = Buffer.alloc(jsonSize)
    readSync(fd, headerBuffer, 0, jsonSize, 16)
    let node = JSON.parse(headerBuffer.toString('utf8'))
    for (const part of String(entry).split('/')) {
      const files = node === null || typeof node !== 'object' ? null : node.files
      if (files === null || files === undefined || typeof files !== 'object' || files[part] === undefined) return null
      node = files[part]
    }
    if (node === null || typeof node !== 'object' || node.files !== undefined) return null
    const size = Number(node.size)
    const offset = 8 + headerSize + Number(node.offset)
    if (!Number.isFinite(size) || size < 0 || !Number.isFinite(offset) || offset < 0) return null
    const data = Buffer.alloc(size)
    readSync(fd, data, 0, size, offset)
    return data.toString('utf8')
  } catch (error) {
    return null
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch (error) {}
    }
  }
}

/**
 * The production DSH version: explicit config first, the environment second,
 * then the running install. A packaged Electron install keeps its manifests
 * either beside app.asar (unpacked builds) or inside the archive itself, so
 * both are probed; when neither answers the result is null ("unknown", which
 * the smoke reports as a failure, never as a pass).
 */
export function defaultProductionVersion(explicit, options) {
  const opts = options === undefined ? {} : options
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim()
  const env = opts.env === undefined ? process.env : opts.env
  if (env !== null && env !== undefined && typeof env.DSH_VERSION === 'string' && env.DSH_VERSION.trim() !== '') return env.DSH_VERSION.trim()
  const execPath = typeof opts.execPath === 'string' && opts.execPath !== '' ? opts.execPath : process.execPath
  const resources = join(dirname(execPath), 'resources')
  for (const relative of PACKAGED_MANIFESTS) {
    const version = manifestVersion(readTextFile(join(resources, ...relative)))
    if (version !== null) return version
  }
  const archive = join(resources, 'app.asar')
  for (const entry of ASAR_MANIFESTS) {
    const version = manifestVersion(readAsarEntry(archive, entry))
    if (version !== null) return version
  }
  return null
}

/** Read one text file, null when it does not exist or is not a file. */
function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    return null
  }
}

/** 'match' when both sides are known and equal, 'mismatch' when they differ, and
 * 'unknown' when one side could not be read — never quietly a pass. */
export function compareVersions(sourceVersion, productionVersion) {
  if (typeof sourceVersion !== 'string' || sourceVersion === '' || typeof productionVersion !== 'string' || productionVersion === '') return 'unknown'
  return sourceVersion === productionVersion ? 'match' : 'mismatch'
}

/**
 * The full CLI argv: the configured executable, any configured prefix args
 * (`dshArgs`, e.g. `node --import tsx .../src/bin.ts` so a source checkout can
 * be driven without a stale build), then this call's arguments.
 */
export function dshArgv(config, args) {
  const argv = [String(config.dshCommand)]
  const extra = Array.isArray(config.dshArgs) ? config.dshArgs : []
  for (const value of extra) {
    if (typeof value === 'string' && value !== '') argv.push(value)
  }
  return argv.concat(args)
}

/** The web launcher's access token, as printed in its startup line. */
const TOKEN_PATTERN = /[?&]token=([A-Za-z0-9._~-]+)/g

/** Extract the last `?token=` printed in a log tail (null when there is none). */
export function tokenFromLogs(text) {
  const source = typeof text === 'string' ? text : ''
  let token = null
  const pattern = new RegExp(TOKEN_PATTERN.source, 'g')
  let match
  while ((match = pattern.exec(source)) !== null) token = match[1]
  return token
}

/**
 * Append the instance token to a URL that requires it. The web app answers 401
 * at `/` without its token, so the token — which is only ever printed to the
 * launcher's stdout — has to be carried by the health and page probes.
 */
export function tokenUrl(url, token) {
  if (typeof token !== 'string' || token === '') return url
  if (/[?&]token=/.test(url)) return url
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token)
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
  const headersFor = (options) => {
    const opts = options === undefined ? {} : options
    return typeof opts.cookie === 'string' && opts.cookie !== '' ? { cookie: opts.cookie } : undefined
  }
  return {
    async get(url, options) {
      const headers = headersFor(options)
      const response = await fetch(url, headers === undefined ? { signal: AbortSignal.timeout(5000) } : { headers: headers, signal: AbortSignal.timeout(5000) })
      return { status: response.status, ok: response.ok === true, body: await response.text() }
    },
    async post(url, body, options) {
      const headers = Object.assign({ 'content-type': 'application/json' }, headersFor(options))
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      return { status: response.status, ok: response.ok === true, body: await response.text() }
    },
    /**
     * Exchange the printed process token for the browser cookie. The server
     * answers 303 with a Set-Cookie and redirects to the token-free directory;
     * Node's fetch has no cookie jar, so the cookie is captured explicitly.
     */
    async exchangeToken(url) {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      const setCookie = response.headers.get('set-cookie')
      return { status: response.status, cookie: setCookie === null || setCookie === undefined ? null : String(setCookie).split(';')[0] }
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
 *
 * Termination uses the host subprocess handle's real contract:
 * terminate() then waitForExit(AbortSignal) — never a made-up kill().
 */
export function createHarness(options) {
  const opts = options === undefined ? {} : options
  const ctx = opts.ctx
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
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
    lastLogs: '',
    restarts: 0,
  }

  function failure(code, message, extra) {
    return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
  }

  function logsText() {
    const instance = state.instance
    if (instance === null || instance.process === null) return state.lastLogs
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
    return text.length > MAX_LOG_TAIL_BYTES ? text.slice(text.length - MAX_LOG_TAIL_BYTES) : text
  }

  function snapshot() {
    const instance = state.instance
    if (instance === null) {
      return {
        ok: true,
        status: state.status,
        running: false,
        lastError: state.lastError,
        lastLogs: state.lastLogs,
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
      token: instance.token,
      cookie: instance.cookie !== null,
      healthUrl: instanceHealthUrl(instance),
      restarts: state.restarts,
      startedAt: instance.startedAt,
      pluginInstalled: instance.pluginInstalled,
      lastError: state.lastError,
      lastLogs: state.lastLogs,
    }
  }

  function logs() {
    return { ok: true, logs: logsText() }
  }

  async function allocatePort(config) {
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

  function spawnProcess(parts, cwd, extraEnv, graceMs) {
    // The host subprocess service never shell-interprets argv, so the command
    // goes in as an argument vector. Wrapping it in `cmd /c` used to mangle
    // any executable path containing a space (Node escapes quotes for
    // CreateProcess, cmd does not understand those escapes).
    try {
      const handle = subprocess.spawn({
        argv: parts,
        cwd: cwd,
        env: Object.assign({}, extraEnv === undefined ? {} : extraEnv),
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: MAX_LOG_BYTES } },
          stderr: { collect: { maxBytes: MAX_LOG_BYTES } },
        },
        graceMs: graceMs,
      })
      return { ok: true, handle: handle }
    } catch (error) {
      return { ok: false, code: 'spawn-failed', message: String((error && error.message) || error) }
    }
  }

  async function terminateProcess(handle, timeoutMs) {
    if (handle === null || handle === undefined || typeof handle !== 'object') return { exited: true, terminated: false }
    let terminated = false
    try {
      if (typeof handle.terminate === 'function') {
        handle.terminate()
        terminated = true
      }
    } catch (error) {}
    if (typeof handle.waitForExit === 'function') {
      try {
        const exited = await handle.waitForExit(AbortSignal.timeout(timeoutMs))
        return { exited: exited === true, terminated: terminated }
      } catch (error) {
        return { exited: false, terminated: terminated, error: String((error && error.message) || error) }
      }
    }
    try {
      await Promise.race([handle.done, sleep(timeoutMs)])
      return { exited: true, terminated: terminated }
    } catch (error) {
      return { exited: false, terminated: terminated }
    }
  }

  async function runInstall(config, projectPath, home) {
    const spawned = spawnProcess(
      dshArgv(config, ['plugin', '--profile', config.profile, 'add', config.candidatePlugin]),
      projectPath,
      Object.assign({}, config.dshEnv, { DSH_HOME: home, DSH_PROFILE: config.profile }),
      config.stopTimeoutMs,
    )
    if (spawned.ok !== true) return spawned
    const handle = spawned.handle
    let outcome = null
    let timedOut = false
    try {
      outcome = await Promise.race([
        handle.done,
        new Promise((resolveTimeout) => {
          setTimeout(() => {
            timedOut = true
            resolveTimeout({ __timeout: true })
          }, config.installTimeoutMs)
        }),
      ])
    } catch (error) {
      return { ok: false, code: 'install-failed', message: String((error && error.message) || error) }
    }
    if (timedOut === true) {
      await terminateProcess(handle, config.stopTimeoutMs)
      return { ok: false, code: 'install-timeout', message: 'dsh plugin add did not finish within ' + String(config.installTimeoutMs) + 'ms' }
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
    return { ok: exitCode === 0, code: exitCode === 0 ? null : 'plugin-install-failed', exitCode: exitCode, stdout: stdout, stderr: stderr }
  }

  async function cleanRoot(root) {
    if (typeof root !== 'string' || root === '') return
    const base = resolve(tmpBase)
    const target = resolve(root)
    if (target !== base && !target.startsWith(base + sep)) {
      return
    }
    try {
      await fsOps.rm(target, { recursive: true, force: true })
    } catch (error) {}
  }

  /**
   * Refresh the instance credentials from its log tail: the launcher prints a
   * one-shot process token, which the server exchanges for the browser cookie.
   * A stale token resets the cookie, so a restart can never reuse one.
   */
  async function refreshAuth(instance) {
    const token = tokenFromLogs(instance.process === null ? state.lastLogs : logsText())
    if (token !== null && token !== instance.token) {
      instance.token = token
      instance.cookie = null
    }
    if (instance.token === null || instance.cookie !== null) return instance
    if (http === null || http === undefined || typeof http.exchangeToken !== 'function') return instance
    const url = tokenUrl('http://127.0.0.1:' + String(instance.port) + '/', instance.token)
    try {
      const exchanged = await http.exchangeToken(url)
      instance.lastExchange = exchanged
      if (exchanged !== null && exchanged !== undefined && Number.isFinite(exchanged.status) && typeof exchanged.cookie === 'string' && exchanged.cookie !== '') {
        instance.cookie = exchanged.cookie
      }
    } catch (error) {
      instance.lastExchange = { status: null, error: String((error && error.message) || error) }
    }
    return instance
  }

  /** The health/page URL: bare with a cookie, token-carrying before the exchange. */
  function instanceHealthUrl(instance) {
    const path = tokenUrl('http://127.0.0.1:' + String(instance.port) + instance.config.healthPath, instance.token)
    return instance.cookie === null ? path : 'http://127.0.0.1:' + String(instance.port) + instance.config.healthPath
  }

  /** Request options carrying the browser cookie when the exchange produced one. */
  function cookieOptions(instance) {
    return instance.cookie === null ? undefined : { cookie: instance.cookie }
  }

  async function waitHealth(instance, exitedOf) {
    const config = instance.config
    const attempts = Math.max(1, Math.ceil(config.healthTimeoutMs / Math.max(1, config.healthIntervalMs)))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const exited = typeof exitedOf === 'function' ? exitedOf() : null
      if (exited !== null && exited !== undefined) return false
      await refreshAuth(instance)
      const url = instanceHealthUrl(instance)
      try {
        const response = await http.get(url, cookieOptions(instance))
        instance.lastHealth = { url: url, status: response === null || response === undefined ? null : response.status }
        if (response !== null && response !== undefined && response.status >= 200 && response.status < 400) {
          return (typeof exitedOf === 'function' ? exitedOf() : null) === null
        }
      } catch (error) {
        instance.lastHealth = { url: url, status: null, error: String((error && error.message) || error) }
      }
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
      token: null,
      cookie: null,
      process: null,
      config: config,
      startedAt: new Date(clock()).toISOString(),
    }
    state.instance = instance
    state.status = 'starting'
    state.lastError = null
    state.lastLogs = ''
    const fail = async (code, message, extra) => {
      state.status = 'failed'
      state.lastError = message
      state.lastLogs = logsText()
      const kill = await terminateProcess(instance.process, config.stopTimeoutMs)
      if (kill.exited === true) {
        await cleanRoot(root)
        state.instance = null
      }
      return failure(code, message, Object.assign({ lastLogs: state.lastLogs, processExited: kill.exited === true }, extra === undefined ? {} : extra))
    }
    try {
      await fsOps.mkdir(home, { recursive: true })
      await fsOps.mkdir(projectCopy, { recursive: true })
      await fsOps.cp(projectPath, projectCopy, {
        recursive: true,
        force: true,
        filter: (source) => {
          const name = String(source).replace(/\\/g, '/').split('/').pop()
          return !SKIP_COPY.has(name)
        },
      })
    } catch (error) {
      return fail('copy-failed', String((error && error.message) || error))
    }
    const install = await runInstall(config, projectCopy, home)
    if (install.ok !== true) {
      return fail(
        install.code === 'install-timeout' ? 'install-timeout' : 'plugin-install-failed',
        install.code === 'install-timeout' ? install.message : 'could not install the candidate plugin: ' + String(install.stderr || install.stdout || install.message || 'exit ' + String(install.exitCode)),
      )
    }
    instance.pluginInstalled = true
    const web = spawnProcess(
      dshArgv(config, ['--profile', config.profile, '--host', '127.0.0.1', '--port', String(port), '--no-open']),
      projectCopy,
      Object.assign({}, config.dshEnv, { DSH_HOME: home, DSH_PROFILE: config.profile }),
      config.stopTimeoutMs,
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
      return fail(
        'health-timeout',
        'the isolated DSH did not answer ' + config.healthPath + ' on port ' + String(port) + ' within ' + String(config.healthTimeoutMs) + 'ms',
        {
          healthUrl: instanceHealthUrl(instance),
          token: instance.token,
          cookie: instance.cookie !== null,
          lastHealth: instance.lastHealth === undefined ? null : instance.lastHealth,
          lastExchange: instance.lastExchange === undefined ? null : instance.lastExchange,
        },
      )
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
      return failure('harness-error', state.lastError, { lastLogs: state.lastLogs })
    }
  }

  async function health() {
    const instance = state.instance
    if (instance === null || state.status !== 'running') return { ok: false, code: 'not-running', message: 'no isolated DSH is running' }
    await refreshAuth(instance)
    const url = instanceHealthUrl(instance)
    try {
      const response = await http.get(url, cookieOptions(instance))
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
    state.lastLogs = logsText()
    const kill = await terminateProcess(instance.process, instance.config.stopTimeoutMs)
    if (kill.exited !== true) {
      state.status = 'running'
      state.lastError = 'the isolated DSH did not exit within ' + String(instance.config.stopTimeoutMs) + 'ms'
      return failure('stop-timeout', 'the isolated DSH process did not exit within ' + String(instance.config.stopTimeoutMs) + 'ms; it is still running on port ' + String(instance.port), {
        port: instance.port,
        terminated: kill.terminated === true,
        lastLogs: state.lastLogs,
      })
    }
    await cleanRoot(instance.root)
    state.instance = null
    state.status = 'stopped'
    return { ok: true, stopped: true, processExited: true }
  }

  async function stop() {
    try {
      return await stopInternal()
    } catch (error) {
      state.status = 'failed'
      state.lastError = String((error && error.message) || error)
      return failure('harness-error', state.lastError, { lastLogs: state.lastLogs })
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
    // The web app gates the shell behind the launch token printed on stdout;
    // the plugin routes below are not gated, so they stay on the bare origin.
    await refreshAuth(instance)
    const checks = {}
    const pageUrl = instance.cookie === null ? tokenUrl(origin + '/', instance.token) : origin + '/'
    const page = await http.get(pageUrl, cookieOptions(instance))
    checks.page = { ok: page.ok === true && page.status === 200, status: page.status, html: typeof page.body === 'string' && page.body.indexOf('<') >= 0, token: instance.token !== null, cookie: instance.cookie !== null }
    const healthResponse = await http.get(instanceHealthUrl(instance), cookieOptions(instance))
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
