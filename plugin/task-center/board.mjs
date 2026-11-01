/**
 * The project task board — one JSON file per project, written under FsVersion CAS.
 *
 * The file is working state, not a document: it lives at
 * <project>/.agents/tasks.json, is expected to be gitignored, and stays readable
 * after the plugin is uninstalled. Its schema is validated on every read:
 *
 *   - a future version is REFUSED, never silently downgraded;
 *   - duplicate or malformed task ids are refused;
 *   - every task is normalised (defaults for a hand-written board);
 *   - seq can never point at an existing id, so create cannot collide;
 *   - history is capped, so a long-lived board does not grow without bound.
 *
 * Concurrency is three layers: an in-process promise chain per path,
 * replaceIfVersion across processes, and re-applying the MUTATION (not its
 * previous result) on a lost race.
 */

import { dirname, join, resolve } from 'node:path'
import {
  BOARD_DIRECTORY,
  BOARD_FILENAME,
  BOARD_VERSION,
  BOARD_WARN_FRACTIONS,
  DISPATCH_DEFAULTS,
  MAX_BOARD_BYTES,
  MAX_HISTORY,
  ROLE_CONFIG_FILENAME,
  STATUSES,
  TASK_KINDS,
  defaultRoleConfig,
  normaliseDispatch,
  normaliseKind,
  normaliseMerge,
  normaliseReport,
  normaliseReview,
  normaliseRoleConfig,
  normaliseTest,
  normaliseVerify,
} from './schema.mjs'

export { BOARD_DIRECTORY, BOARD_FILENAME, BOARD_VERSION, MAX_BOARD_BYTES, MAX_HISTORY, ROLE_CONFIG_FILENAME }

/** Absolute path of the board inside one project. */
export function boardPath(projectPath) {
  return join(projectPath, BOARD_DIRECTORY, BOARD_FILENAME)
}

/** Refuse a role config large enough to be a mistake. */
export const MAX_ROLE_CONFIG_BYTES = 256 * 1024

/** How long a project stays in the background-drive set after its last touch. */
export const PROJECT_ACTIVE_MS = 24 * 60 * 60 * 1000

/** Canonical project id: case-folded, slash-normalized, no trailing separator. */
export function projectIdOf(root) {
  const normalized = String(root).replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

/**
 * The first-class project. Everything the task center stores or dispatches is
 * keyed by this ref, so one project can never be confused with another.
 */
export function projectRefOf(root) {
  const projectRoot = String(root)
  return {
    id: projectIdOf(projectRoot),
    root: projectRoot,
    boardPath: boardPath(projectRoot),
    worktreeRoot: join(projectRoot, '.worktrees'),
  }
}

/** Where the host remembers projects across process restarts (user-wide). */
export function projectRegistryPath(homeDir) {
  return join(homeDir, '.dsh', 'godot-bridge', 'projects.json')
}

/**
 * The WORKSPACE fallback for the same registry. The user-wide path needs a
 * writable home (and a policy that allows it); a workspace-write sandbox denies
 * that, which is how the registry silently never persisted. Inside the project
 * the board already lives in `.agents/`, so the fallback needs no new directory.
 */
export function workspaceRegistryPath(projectRoot) {
  return join(projectRoot, BOARD_DIRECTORY, 'projects.json')
}

/** The registry locations to try, in order: user-wide first, workspace second. */
export function registryTargets(options) {
  const targets = []
  const homeDir = options === undefined || options === null ? null : options.homeDir
  if (typeof homeDir === 'string' && homeDir.length > 0) {
    targets.push({ location: 'home', path: projectRegistryPath(homeDir), cwd: homeDir, sandboxPolicy: options.homePolicy })
  }
  const projectRoot = options === undefined || options === null ? null : options.projectRoot
  if (typeof projectRoot === 'string' && projectRoot.length > 0) {
    targets.push({ location: 'workspace', path: workspaceRegistryPath(projectRoot), cwd: projectRoot, sandboxPolicy: options.sandboxPolicy })
  }
  return targets
}

export function normaliseProjectRegistry(value) {
  const projects = []
  if (value !== null && typeof value === 'object' && value.projects !== undefined) {
    const source = value.projects
    if (Array.isArray(source)) {
      for (const entry of source) {
        if (entry === null || typeof entry !== 'object') continue
        if (typeof entry.root !== 'string' || entry.root.length === 0) continue
        projects.push({
          id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : projectIdOf(entry.root),
          root: entry.root,
          lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : new Date(0).toISOString(),
          lastSessionId: typeof entry.lastSessionId === 'string' ? entry.lastSessionId : null,
          worktreeRoot: typeof entry.worktreeRoot === 'string' && entry.worktreeRoot.length > 0 ? entry.worktreeRoot : null,
          preflight: entry.preflight !== undefined && entry.preflight !== null && typeof entry.preflight === 'object' ? entry.preflight : null,
        })
      }
    }
  }
  // T-103: the ONE project to re-activate at startup. It is a separate field (not
  // "the most recently seen project") so startup never guesses: no field means
  // "nothing was ever activated", which the panel renders as such.
  const lastActiveProjectId =
    value !== null && typeof value === 'object' && typeof value.lastActiveProjectId === 'string' && value.lastActiveProjectId.length > 0
      ? value.lastActiveProjectId
      : null
  return { version: 1, projects: projects, lastActiveProjectId: lastActiveProjectId }
}

/** One registry file, or an empty registry when it is absent/unreadable. */
async function readRegistryAt(io, target, signal) {
  try {
    const resolved = await io.fs.resolve(target.path, { cwd: target.cwd, signal: signal })
    const info = await io.fs.stat(resolved, signal)
    if (info === undefined) return { ok: true, registry: normaliseProjectRegistry(null), found: false }
    const text = await io.fs.readText(resolved, signal)
    return { ok: true, registry: normaliseProjectRegistry(JSON.parse(text)), found: true }
  } catch (error) {
    return { ok: true, registry: normaliseProjectRegistry(null), found: false, error: describe(error) }
  }
}

/** Merge two registries by project id, the newer lastSeenAt winning. */
function mergeProjectRegistries(left, right) {
  const byId = new Map()
  for (const entry of left.projects.concat(right.projects)) {
    const current = byId.get(entry.id)
    if (current === undefined || String(entry.lastSeenAt).localeCompare(String(current.lastSeenAt)) >= 0) byId.set(entry.id, entry)
  }
  // The last-active id follows the newer of the two copies (the copy that was
  // written last wins); an id whose project is gone is dropped rather than kept
  // as a dangling activation.
  let lastActiveProjectId = null
  let best = null
  for (const candidate of [left.lastActiveProjectId, right.lastActiveProjectId]) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const entry = byId.get(candidate)
    if (entry === undefined) continue
    if (best === null || String(entry.lastSeenAt).localeCompare(best) > 0) {
      best = entry.lastSeenAt
      lastActiveProjectId = candidate
    }
  }
  return { version: 1, projects: Array.from(byId.values()), lastActiveProjectId: lastActiveProjectId }
}

/**
 * Read the registry from EVERY candidate location and merge them. A home registry
 * is optional (a sandbox may deny it); the workspace copy is authoritative for
 * that project. A missing/unreadable file is an empty registry, never an error:
 * losing the registry must not break the board.
 */
export async function readProjectRegistry(io, options) {
  const targets = registryTargets(options)
  if (targets.length === 0) return { ok: true, registry: normaliseProjectRegistry(null), locations: [] }
  let registry = normaliseProjectRegistry(null)
  const locations = []
  for (const target of targets) {
    const read = await readRegistryAt(io, target, options.signal)
    if (read.found === true) {
      locations.push(target.location)
      registry = mergeProjectRegistries(registry, read.registry)
    }
  }
  return { ok: true, registry: registry, locations: locations }
}

/**
 * Persist the registry to the first WRITABLE candidate, creating its directory
 * first. The home path is preferred (one registry for the whole user); a sandbox
 * that denies it falls back to the workspace copy, which the board's own policy
 * allows. Every failure is RETURNED — never swallowed — so the caller can show
 * "not persisted" instead of pretending it worked.
 */
export async function writeProjectRegistry(io, options, registry) {
  const targets = registryTargets(options)
  if (targets.length === 0) return { ok: true, skipped: true, location: null, attempts: [] }
  const text = JSON.stringify(normaliseProjectRegistry(registry), null, 2) + '\n'
  const attempts = []
  for (const target of targets) {
    try {
      if (typeof options.ensureDir === 'function') await options.ensureDir(dirname(target.path))
      const resolved = await io.fs.resolve(target.path, { cwd: target.cwd, signal: options.signal })
      const info = await io.fs.stat(resolved, options.signal)
      const expected = info === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: info.version }
      const written = await io.fs.writeText(resolved, text, expected, options.signal, target.sandboxPolicy)
      return { ok: true, version: written.version, location: target.location, path: target.path, attempts: attempts }
    } catch (error) {
      attempts.push({ location: target.location, path: target.path, message: describe(error) })
    }
  }
  return {
    ok: false,
    code: 'registry-unwritable',
    message:
      'could not persist the project registry to any location (' +
      attempts.map((entry) => entry.location + ': ' + entry.message).join('; ') +
      '); multi-project driving and restart recovery will not survive a restart',
    attempts: attempts,
  }
}

async function isDir(io, path, options) {
  try {
    const target = await io.fs.resolve(path, { cwd: options.cwd, signal: options.signal })
    const info = await io.fs.stat(target, options.signal)
    return info !== undefined && info.type === 'directory'
  } catch (error) {
    return false
  }
}

async function isFile(io, path, options) {
  try {
    const target = await io.fs.resolve(path, { cwd: options.cwd, signal: options.signal })
    const info = await io.fs.stat(target, options.signal)
    return info !== undefined && info.type === 'file'
  } catch (error) {
    return false
  }
}

/**
 * The ONE project-resolution rule: an explicit path wins; otherwise walk the
 * session workspace upwards to the nearest git root that carries .agents/ or
 * project.godot; otherwise refuse with no-project-bound. There is deliberately
 * no process.cwd() or global-hint fallback.
 */
export async function resolveProjectRoot(io, options) {
  const opts = options === undefined ? {} : options
  const explicit = typeof opts.explicit === 'string' ? opts.explicit.trim() : ''
  if (explicit.length > 0) {
    return { ok: true, root: resolve(explicit), resolvedFrom: opts.explicitSource === 'panel' ? 'panel' : 'explicit' }
  }
  const start = typeof opts.sessionRoot === 'string' ? opts.sessionRoot.trim() : ''
  if (start.length === 0) {
    return failure('no-project-bound', 'No project is bound to this session. Pass project, or open a project from the panel.')
  }
  let current = resolve(start)
  for (;;) {
    if (await isDir(io, join(current, '.git'), opts) && ((await isDir(io, join(current, '.agents'), opts)) || (await isFile(io, join(current, 'project.godot'), opts)))) {
      return { ok: true, root: current, resolvedFrom: 'session' }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return failure('no-project-bound', 'No git project with .agents/ or project.godot was found above the session workspace (' + start + '). Pass project explicitly or open one from the panel.')
}

/** Archive of done tasks that have aged out of the board (one file per year). */
export const ARCHIVE_VERSION = 1
export const ARCHIVE_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function archiveDir(projectPath) {
  return join(projectPath, '.agents', 'archive')
}

export function archivePath(projectPath, year) {
  return join(archiveDir(projectPath), String(year) + '.json')
}

export function archiveIndexPath(projectPath) {
  return join(archiveDir(projectPath), 'index.json')
}

/** A done card older than 30 days is archived; everything else stays. */
export function isArchivable(task, nowMs) {
  if (task === null || task === undefined || task.status !== 'done') return false
  const at = Date.parse(String(task.updatedAt === undefined || task.updatedAt === null ? '' : task.updatedAt))
  return Number.isFinite(at) && at < nowMs - ARCHIVE_AGE_MS
}

export function archiveYearOf(task, nowMs) {
  const at = Date.parse(String(task.updatedAt === undefined || task.updatedAt === null ? '' : task.updatedAt))
  return new Date(Number.isFinite(at) ? at : nowMs).getUTCFullYear()
}

async function readJsonFile(io, path, options) {
  const target = await io.fs.resolve(path, { cwd: options.projectPath, signal: options.signal })
  const info = await io.fs.stat(target, options.signal)
  if (info === undefined) return { ok: true, value: null, version: null }
  const text = await io.fs.readText(target, options.signal)
  try {
    return { ok: true, value: JSON.parse(text), version: info.version }
  } catch (error) {
    return { ok: false, code: 'archive-unparseable', message: 'archive file ' + path + ' is not valid JSON: ' + describe(error) }
  }
}

/** One archive file: { version, year, tasks, updatedAt }. */
export async function readArchive(io, options, year) {
  const read = await readJsonFile(io, archivePath(options.projectPath, year), options)
  if (read.ok !== true) return read
  if (read.value === null) return { ok: true, tasks: [], version: null }
  const tasks = Array.isArray(read.value.tasks) ? read.value.tasks : []
  return { ok: true, tasks: tasks, version: read.version }
}

export async function readArchiveIndex(io, options) {
  const read = await readJsonFile(io, archiveIndexPath(options.projectPath), options)
  if (read.ok !== true) return { ok: true, years: [] }
  const years = read.value !== null && Array.isArray(read.value.years) ? read.value.years.filter((year) => Number.isFinite(year)) : []
  return { ok: true, years: years, version: read.version }
}

/** The archived years, falling back to a scan when the index is missing/old. */
export async function archiveYears(io, options) {
  const index = await readArchiveIndex(io, options)
  if (index.years.length > 0) return index.years
  const nowYear = new Date(typeof options.now === 'number' ? options.now : Date.now()).getUTCFullYear()
  const years = []
  for (let year = nowYear; year >= nowYear - 8; year--) {
    const read = await readArchive(io, options, year)
    if (read.ok === true && read.tasks.length > 0) years.push(year)
  }
  return years
}

/**
 * Write one archive file. A temp file is written and read back first (the fs
 * service has no rename), so a truncated write never replaces the real archive;
 * only after that succeeds is the year file promoted.
 */
export async function writeArchive(io, options, year, tasks, version) {
  const payload = { version: ARCHIVE_VERSION, year: year, updatedAt: iso(Date.now()), tasks: tasks }
  const text = JSON.stringify(payload, null, 2) + '\n'
  const tempPath = archivePath(options.projectPath, year) + '.tmp'
  try {
    const temp = await io.fs.resolve(tempPath, { cwd: options.projectPath, signal: options.signal })
    const tempInfo = await io.fs.stat(temp, options.signal)
    await io.fs.writeText(temp, text, tempInfo === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: tempInfo.version }, options.signal, options.sandboxPolicy)
    const check = await io.fs.readText(temp, options.signal)
    JSON.parse(check)
    const target = await io.fs.resolve(archivePath(options.projectPath, year), { cwd: options.projectPath, signal: options.signal })
    const expected = version === null || version === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: version }
    const written = await io.fs.writeText(target, text, expected, options.signal, options.sandboxPolicy)
    return { ok: true, version: written.version }
  } catch (error) {
    return failure('archive-unwritable', 'could not write the archive file: ' + describe(error))
  }
}

export async function writeArchiveIndex(io, options, years, version) {
  const payload = { version: ARCHIVE_VERSION, years: years }
  const text = JSON.stringify(payload, null, 2) + '\n'
  try {
    const target = await io.fs.resolve(archiveIndexPath(options.projectPath), { cwd: options.projectPath, signal: options.signal })
    const expected = version === null || version === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: version }
    const written = await io.fs.writeText(target, text, expected, options.signal, options.sandboxPolicy)
    return { ok: true, version: written.version }
  } catch (error) {
    return failure('archive-unwritable', 'could not write the archive index: ' + describe(error))
  }
}

/** Absolute path of the optional project role profile file. */
export function rolesPath(projectPath) {
  return join(projectPath, BOARD_DIRECTORY, ROLE_CONFIG_FILENAME)
}

/**
 * Read and normalise `<project>/.agents/roles.json`.
 *
 * The file is optional configuration, not working state: absent, unreadable or
 * malformed input falls back to the built-in default profiles and reports why,
 * instead of blocking dispatch. A partial file is repaired member by member by
 * normaliseRoleConfig.
 */
export async function readRoleConfig(io, options) {
  const fallback = defaultRoleConfig()
  const projectPath = options.projectPath
  try {
    const target = await io.fs.resolve(rolesPath(projectPath), { cwd: projectPath, signal: options.signal })
    const info = await io.fs.stat(target, options.signal)
    if (info === undefined) return { ok: true, config: fallback, source: 'default', error: null }
    if (Number.isFinite(info.size) && info.size > MAX_ROLE_CONFIG_BYTES) {
      return { ok: true, config: fallback, source: 'default', error: 'roles.json is larger than ' + String(MAX_ROLE_CONFIG_BYTES) + ' bytes; using the default role profiles' }
    }
    const text = await io.fs.readText(target, options.signal)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return { ok: true, config: fallback, source: 'default', error: 'roles.json is not valid JSON, so the default role profiles apply: ' + describe(error) }
    }
    return { ok: true, config: normaliseRoleConfig(parsed), source: 'file', error: null }
  } catch (error) {
    return { ok: true, config: fallback, source: 'default', error: describe(error) }
  }
}

/** Persist a normalised project role config to .agents/roles.json. */
export async function writeRoleConfig(io, options) {
  const config = normaliseRoleConfig(options.config)
  try {
    const target = await io.fs.resolve(rolesPath(options.projectPath), { cwd: options.projectPath, signal: options.signal })
    const text = JSON.stringify(config, null, 2) + '\n'
    const outcome = await io.fs.writeText(target, text, options.expected, options.signal, options.sandboxPolicy)
    return { ok: true, config: config, path: rolesPath(options.projectPath), version: outcome === undefined || outcome === null ? null : outcome.version }
  } catch (error) {
    return { ok: false, code: 'role-config-write-failed', message: describe(error) }
  }
}

/** A fresh, empty board. */
export function emptyBoard(now) {
  const at = new Date(typeof now === 'number' ? now : Date.now()).toISOString()
  return {
    version: BOARD_VERSION,
    seq: 1,
    tasks: [],
    dispatch: normaliseDispatch(DISPATCH_DEFAULTS),
    updatedAt: at,
  }
}

function failure(code, message) {
  return { ok: false, code: code, message: message }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function iso(now) {
  return new Date(typeof now === 'number' ? now : Date.now()).toISOString()
}

function isIso(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function stringOf(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function highestTaskNumber(tasks) {
  return tasks.reduce((highest, task) => {
    const match = task !== null && typeof task === 'object' && typeof task.id === 'string' ? /^T-(\d+)$/.exec(task.id) : null
    return match === null ? highest : Math.max(highest, Number(match[1]))
  }, 0)
}

/** How many handover identities a task remembers. Enough to diagnose a stampede
 * ("three executors alive at once"), small enough that a long-lived card does not
 * grow without bound. */
export const MAX_EXECUTORS = 8

/**
 * The executors a task has been handed to, oldest first. An entry is retired when
 * the dispatcher replaces that executor (handover, host restart, re-dispatch), so
 * "how many executors are live" is answerable from the board alone — the panel and
 * `get` do not need the Team roster for it. A hand-written board may omit the
 * list entirely.
 */
function normaliseExecutors(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name === '') continue
    out.push({
      name: name,
      session: typeof entry.session === 'string' ? entry.session : null,
      at: isIso(entry.at) ? entry.at : null,
      retiredAt: isIso(entry.retiredAt) ? entry.retiredAt : null,
      retiredReason: typeof entry.retiredReason === 'string' ? entry.retiredReason : null,
    })
  }
  return out.length > MAX_EXECUTORS ? out.slice(out.length - MAX_EXECUTORS) : out
}

/** Fill in the fields a hand-written board may omit, and reject what cannot be
 * repaired. Missing fields get defaults; a bad id is fatal because everything
 * else addresses tasks by it. */
function normaliseTask(raw, index, now) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return failure('invalid-task', 'task #' + String(index) + ' is not an object')
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!/^T-\d+$/.test(id)) {
    return failure('invalid-task', 'task #' + String(index) + ' has no valid id (expected T-<number>, got ' + JSON.stringify(raw.id) + ')')
  }
  // T-131: a card is either mergeable work ('dev', the historical default) or an
  // investigation that delivers a report. An UNKNOWN kind is refused rather than
  // silently treated as dev: the phase machine it implies would be wrong.
  const kind = normaliseKind(raw.kind)
  if (kind === null) {
    return failure('invalid-kind', 'task ' + JSON.stringify(id) + ' has kind ' + JSON.stringify(raw.kind) + '; expected one of ' + TASK_KINDS.join(', '))
  }
  const status = STATUSES.indexOf(raw.status) >= 0 ? raw.status : raw.status === 'review' ? 'done' : 'pending'
  const dispatch =
    raw.dispatch !== null && typeof raw.dispatch === 'object' && !Array.isArray(raw.dispatch)
      ? {
          status: typeof raw.dispatch.status === 'string' ? raw.dispatch.status : null,
          at: isIso(raw.dispatch.at) ? raw.dispatch.at : null,
          target: typeof raw.dispatch.target === 'string' ? raw.dispatch.target : null,
          targetId: typeof raw.dispatch.targetId === 'string' ? raw.dispatch.targetId : null,
          via: typeof raw.dispatch.via === 'string' ? raw.dispatch.via : null,
          error: typeof raw.dispatch.error === 'string' ? raw.dispatch.error : null,
          host: typeof raw.dispatch.host === 'string' ? raw.dispatch.host : null,
          lead: typeof raw.dispatch.lead === 'string' ? raw.dispatch.lead : null,
          // T-106: the Lead's session and the card's session are part of the
          // record, so the panel/history can prove dispatch never crossed sessions.
          leadSession: typeof raw.dispatch.leadSession === 'string' ? raw.dispatch.leadSession : null,
          session: typeof raw.dispatch.session === 'string' ? raw.dispatch.session : null,
          ownerCompat: raw.dispatch.ownerCompat === true,
          compat: raw.dispatch.compat === true,
          compatDetail: typeof raw.dispatch.compatDetail === 'string' ? raw.dispatch.compatDetail : null,
          project: typeof raw.dispatch.project === 'string' ? raw.dispatch.project : null,
          keep: raw.dispatch.keep === true,
        }
      : null
  const dependsOn = stringList(raw.dependsOn).filter((dep) => dep !== id)
  const writeFiles = stringList(raw.writeFiles)
  const assignee =
    raw.assignee !== null && typeof raw.assignee === 'object' && !Array.isArray(raw.assignee)
      ? {
          name: stringOf(raw.assignee.name, ''),
          session: typeof raw.assignee.session === 'string' ? raw.assignee.session : null,
        }
      : null
  // The worker that held the task before it left 'running'. cancel/block clear
  // `assignee`, but the soft refusal still has to recognise that worker, so the
  // last owner is kept as history (typed like the assignee).
  const lastAssignee =
    raw.lastAssignee !== null && typeof raw.lastAssignee === 'object' && !Array.isArray(raw.lastAssignee)
      ? {
          name: stringOf(raw.lastAssignee.name, ''),
          session: typeof raw.lastAssignee.session === 'string' ? raw.lastAssignee.session : null,
        }
      : null
  const history = []
  if (Array.isArray(raw.history)) {
    for (const entry of raw.history) {
      if (entry === null || typeof entry !== 'object') continue
      history.push({
        at: isIso(entry.at) ? entry.at : iso(now),
        by: typeof entry.by === 'string' ? entry.by : 'unknown',
        byName: typeof entry.byName === 'string' && entry.byName !== '' ? entry.byName : null,
        from: typeof entry.from === 'string' ? entry.from : null,
        to: typeof entry.to === 'string' ? entry.to : null,
        note: typeof entry.note === 'string' ? entry.note : '',
      })
    }
  }
  // Keep the creation entry plus the newest entries. The creation entry is how a
  // reader answers "where did this come from" after a long life.
  const capped =
    history.length > MAX_HISTORY ? [history[0]].concat(history.slice(history.length - (MAX_HISTORY - 1))) : history
  const attempts = Number.isFinite(raw.attempts) ? Math.max(0, Math.floor(raw.attempts)) : 0
  const maxAttempts = Number.isFinite(raw.maxAttempts) ? Math.min(10, Math.max(1, Math.floor(raw.maxAttempts))) : 3
  // Infrastructure interruptions (host restart, plugin reload) are counted
  // SEPARATELY from attempts: they refund the attempt, so a development host that
  // reloads five times does not block a healthy task. See interruptDispatch.
  const interruptions = Number.isFinite(raw.interruptions) ? Math.max(0, Math.floor(raw.interruptions)) : 0
  const executors = normaliseExecutors(raw.executors)
  // Worktree / merge-request fields are written by the HOST (claim, submit,
  // merge), never by a normal update; here they are only typed and defaulted so
  // an older or hand-written board stays readable.
  const actualFiles = stringList(raw.actualFiles)
  const requiredRole = typeof raw.requiredRole === 'string' ? raw.requiredRole : null
  const merge = normaliseMerge(raw.merge)
  const review = normaliseReview(raw.review)
  const test = normaliseTest(raw.test)
  return {
    ok: true,
    task: {
      id: id,
      title: stringOf(raw.title, '') || 'Untitled task',
      spec: stringOf(raw.spec, ''),
      acceptance: stringOf(raw.acceptance, ''),
      status: status,
      // Missing on old boards (and therefore 'dev'); never undefined in memory.
      kind: kind,
      // Investigation output (T-131). Dev cards never carry one.
      report: normaliseReport(raw.report),
      priority: Number.isFinite(raw.priority) ? Math.floor(raw.priority) : 0,
      dependsOn: dependsOn,
      writeFiles: writeFiles,
      // The optional mechanical-verification declaration. Absent (null) keeps the
      // historical flow where the tester runs the suite itself.
      verify: normaliseVerify(raw.verify),
      base: typeof raw.base === 'string' ? raw.base : null,
      target: typeof raw.target === 'string' ? raw.target : null,
      branch: typeof raw.branch === 'string' ? raw.branch : null,
      worktree: typeof raw.worktree === 'string' ? raw.worktree : null,
      worktreeError: typeof raw.worktreeError === 'string' ? raw.worktreeError : null,
      commit: typeof raw.commit === 'string' ? raw.commit : null,
      actualFiles: actualFiles,
      requiredRole: requiredRole,
      merge: merge,
      review: review,
      test: test,
      assignee: assignee,
      lastAssignee: lastAssignee,
      attempts: attempts,
      maxAttempts: maxAttempts,
      interruptions: interruptions,
      executors: executors,
      evidence: stringOf(raw.evidence, ''),
      dispatch: dispatch,
      // Set by the stage gate when the target phase has no executor yet; the
      // watchdog skips such a task and the next host tick clears it once the
      // executor can be provisioned.
      // T-97: the session that created (and therefore owns) this card. Dispatch
      // only hands it to that session's team.
      ownerSession: typeof raw.ownerSession === 'string' && raw.ownerSession !== '' ? raw.ownerSession : null,
      waitingReason: typeof raw.waitingReason === 'string' && raw.waitingReason !== '' ? raw.waitingReason : null,
      waitingDetail: typeof raw.waitingDetail === 'string' && raw.waitingDetail !== '' ? raw.waitingDetail : null,
      leaseUntil: isIso(raw.leaseUntil) ? raw.leaseUntil : null,
      createdBy: stringOf(raw.createdBy, 'unknown'),
      createdAt: isIso(raw.createdAt) ? raw.createdAt : iso(now),
      updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : iso(now),
      history: capped,
    },
  }
}

/** v1 -> v2: old statuses collapse into pending/running/done, blockedBy becomes
 * dependsOn, and a claim is released because the process that held it is not the
 * process doing this migration. */
function migrateV1(parsed, now) {
  const statusOf = {
    draft: 'pending',
    queued: 'pending',
    claimed: 'pending',
    in_progress: 'pending',
    blocked: 'blocked',
    review: 'done',
    done: 'done',
    cancelled: 'cancelled',
  }
  const tasks = Array.isArray(parsed.tasks)
    ? parsed.tasks.map((raw) => {
        if (raw === null || typeof raw !== 'object') return raw
        const next = Object.assign({}, raw)
        const before = raw.status
        next.status = statusOf[raw.status] === undefined ? 'pending' : statusOf[raw.status]
        next.dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn : Array.isArray(raw.blockedBy) ? raw.blockedBy : []
        next.writeFiles = Array.isArray(raw.writeFiles) ? raw.writeFiles : []
        next.attempts =
          raw.dispatch !== null && typeof raw.dispatch === 'object' && Number.isFinite(raw.dispatch.attempts)
            ? raw.dispatch.attempts
            : 0
        next.assignee = null
        next.leaseUntil = null
        const history = Array.isArray(raw.history) ? raw.history.slice() : []
        if (before !== next.status) {
          history.push({ at: iso(now), by: 'migration', from: before, to: next.status, note: 'board upgraded from version 1' })
        }
        next.history = history
        delete next.blockedBy
        delete next.order
        delete next.leaseExpired
        return next
      })
    : []
  return {
    version: BOARD_VERSION,
    seq: parsed.seq,
    tasks: tasks,
    dispatch: normaliseDispatch(DISPATCH_DEFAULTS),
    updatedAt: parsed.updatedAt,
  }
}

function normaliseBoard(parsed, now) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.tasks)) {
    return failure('unrecognisable', 'the board file carries no tasks array, so it is left untouched')
  }
  const version = Number.isFinite(parsed.version) ? Math.floor(parsed.version) : 1
  if (version > BOARD_VERSION) {
    return failure(
      'unsupported-version',
      'the board is version ' + String(version) + ' but this plugin understands at most ' + String(BOARD_VERSION) + '; refusing to rewrite it',
    )
  }
  const source = version < BOARD_VERSION ? migrateV1(parsed, now) : parsed
  const tasks = []
  const seen = new Set()
  for (let index = 0; index < source.tasks.length; index++) {
    const normalised = normaliseTask(source.tasks[index], index, now)
    if (normalised.ok !== true) return normalised
    if (seen.has(normalised.task.id)) {
      return failure('duplicate-task', 'task id ' + normalised.task.id + ' appears more than once; refusing to guess which one is real')
    }
    seen.add(normalised.task.id)
    tasks.push(normalised.task)
  }
  const highest = highestTaskNumber(tasks)
  const seq = Number.isFinite(source.seq) && source.seq > 0 ? Math.max(Math.floor(source.seq), highest + 1) : highest + 1
  return {
    ok: true,
    board: {
      version: BOARD_VERSION,
      seq: seq,
      tasks: tasks,
      dispatch: normaliseDispatch(source.dispatch),
      updatedAt: isIso(source.updatedAt) ? source.updatedAt : iso(now),
    },
  }
}

function isStale(error) {
  if (error === null || error === undefined) return false
  if (typeof error.code === 'string' && error.code === 'FS_STALE_VERSION') return true
  return /FS_STALE_VERSION/.test(String(error.message || ''))
}

async function writeOnce(io, options, board, version) {
  try {
    const target = await io.fs.resolve(boardPath(options.projectPath), {
      cwd: options.projectPath,
      signal: options.signal,
    })
    const expected = version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: version }
    const outcome = await io.fs.writeText(
      target,
      JSON.stringify(board, null, 2) + '\n',
      expected,
      options.signal,
      options.sandboxPolicy,
    )
    return { ok: true, version: outcome.version }
  } catch (error) {
    return failure(isStale(error) ? 'stale' : 'unwritable', describe(error))
  }
}

/** Average bytes per task on this board, or null for an empty one. */
function bytesPerTask(bytes, tasks) {
  return Number.isFinite(bytes) && tasks > 0 ? Math.round(bytes / tasks) : null
}

/**
 * How full the board file is, relative to MAX_BOARD_BYTES, for the panel and the
 * API. Pure so the thresholds are testable without a 16 MB fixture.
 *
 * @returns { bytes, limit, percent, level ('ok'|'half'|'three-quarters'), cards,
 *   bytesPerCard, headroomCards, warning }
 *   headroomCards is how many more cards of TODAY'S average size fit before the
 *   limit — the number that turns "the board is big" into "you have N cards left".
 */
export function boardSizeReport(bytes, cards, limit) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_BOARD_BYTES
  const size = Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : 0
  const count = Number.isFinite(cards) && cards > 0 ? Math.floor(cards) : 0
  const ratio = cap === 0 ? 0 : size / cap
  const percent = Math.min(100, Math.round(ratio * 1000) / 10)
  const level = ratio >= BOARD_WARN_FRACTIONS[1] ? 'three-quarters' : ratio >= BOARD_WARN_FRACTIONS[0] ? 'half' : 'ok'
  const perCard = bytesPerTask(size, count)
  const headroomCards = perCard === null || perCard === 0 ? null : Math.max(0, Math.floor((cap - size) / perCard))
  const megabytes = (value) => Math.round((value / (1024 * 1024)) * 10) / 10
  const warning =
    level === 'ok'
      ? null
      : 'the task board is ' + String(megabytes(size)) + ' MB of its ' + String(megabytes(cap)) + ' MB limit (' + String(percent) + '%)' +
        (headroomCards === null ? '' : '; at today\'s ~' + String(Math.round(perCard / 1024)) + ' KB per card about ' + String(headroomCards) + ' more cards fit') +
        '. Archive finished cards or split the board before it stops loading.'
  return {
    bytes: size,
    limit: cap,
    percent: percent,
    level: level,
    cards: count,
    bytesPerCard: perCard,
    headroomCards: headroomCards,
    warning: warning,
  }
}

/**
 * Read and validate the board.
 *
 * @returns { ok: true, board, version, existed, size, limit } or { ok: false, code, message }
 *   with code too-large, unparseable, unrecognisable, unsupported-version,
 *   invalid-task, duplicate-task or unreadable.
 */
export async function readBoard(io, options) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  try {
    const target = await io.fs.resolve(boardPath(options.projectPath), {
      cwd: options.projectPath,
      signal: options.signal,
    })
    const info = await io.fs.stat(target, options.signal)
    if (info === undefined) return { ok: true, board: emptyBoard(now), version: null, existed: false, size: 0, limit: MAX_BOARD_BYTES }
    if (Number.isFinite(info.size) && info.size > MAX_BOARD_BYTES) {
      return failure('too-large', 'the board file is ' + String(info.size) + ' bytes; refusing to load more than ' + String(MAX_BOARD_BYTES))
    }
    const text = await io.fs.readText(target, options.signal)
    if (Buffer.byteLength(text, 'utf8') > MAX_BOARD_BYTES) {
      return failure('too-large', 'the board file is larger than ' + String(MAX_BOARD_BYTES) + ' bytes; refusing to load it')
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return failure('unparseable', 'the board file is not valid JSON, so it is left untouched: ' + describe(error))
    }
    const normalised = normaliseBoard(parsed, now)
    if (normalised.ok !== true) return normalised
    return { ok: true, board: normalised.board, version: info.version, existed: true, size: Buffer.byteLength(text, 'utf8'), limit: MAX_BOARD_BYTES }
  } catch (error) {
    return failure('unreadable', describe(error))
  }
}

/** Writes to one path run one at a time; a rejection never poisons the queue. */
const chains = new Map()
function serialise(key, operation) {
  const previous = chains.get(key) || Promise.resolve()
  const run = previous.then(operation, operation)
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * Apply a mutation under the board's CAS.
 *
 * mutate(board, attempt) must be a pure function of the board it is handed; on
 * a lost version race it runs again against freshly read content. Returning
 * undefined or null abandons the update.
 */
export async function updateBoard(io, options) {
  const limit = Number.isFinite(options.attempts) && options.attempts >= 1 ? Math.floor(options.attempts) : 3
  const now = typeof options.now === 'number' ? options.now : Date.now()
  return serialise(boardPath(options.projectPath), async () => {
    let attempts = 0
    for (;;) {
      attempts += 1
      const current = await readBoard(io, Object.assign({}, options, { now: now }))
      if (!current.ok) return current
      const next = options.mutate(current.board, attempts)
      if (next === undefined || next === null) return failure('aborted', 'the mutator declined the change')
      const validated = normaliseBoard(next, now)
      if (validated.ok !== true) return validated
      const payload = Object.assign({}, validated.board, { version: BOARD_VERSION, updatedAt: iso(now) })
      const written = await writeOnce(io, options, payload, current.version)
      if (written.ok) return { ok: true, board: payload, version: written.version, attempts: attempts }
      if (written.code !== 'stale' || attempts >= limit) return Object.assign({}, written, { attempts: attempts })
    }
  })
}
