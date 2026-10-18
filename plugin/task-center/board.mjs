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

import { join } from 'node:path'
import {
  BOARD_DIRECTORY,
  BOARD_FILENAME,
  BOARD_VERSION,
  DISPATCH_DEFAULTS,
  MAX_BOARD_BYTES,
  MAX_HISTORY,
  ROLE_CONFIG_FILENAME,
  STATUSES,
  defaultRoleConfig,
  normaliseDispatch,
  normaliseMerge,
  normaliseReview,
  normaliseRoleConfig,
  normaliseTest,
} from './schema.mjs'

export { BOARD_DIRECTORY, BOARD_FILENAME, BOARD_VERSION, MAX_BOARD_BYTES, MAX_HISTORY, ROLE_CONFIG_FILENAME }

/** Absolute path of the board inside one project. */
export function boardPath(projectPath) {
  return join(projectPath, BOARD_DIRECTORY, BOARD_FILENAME)
}

/** Refuse a role config large enough to be a mistake. */
export const MAX_ROLE_CONFIG_BYTES = 256 * 1024

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
  const history = []
  if (Array.isArray(raw.history)) {
    for (const entry of raw.history) {
      if (entry === null || typeof entry !== 'object') continue
      history.push({
        at: isIso(entry.at) ? entry.at : iso(now),
        by: typeof entry.by === 'string' ? entry.by : 'unknown',
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
      priority: Number.isFinite(raw.priority) ? Math.floor(raw.priority) : 0,
      dependsOn: dependsOn,
      writeFiles: writeFiles,
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
      attempts: attempts,
      maxAttempts: maxAttempts,
      evidence: stringOf(raw.evidence, ''),
      dispatch: dispatch,
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

/**
 * Read and validate the board.
 *
 * @returns { ok: true, board, version, existed } or { ok: false, code, message }
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
    if (info === undefined) return { ok: true, board: emptyBoard(now), version: null, existed: false }
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
    return { ok: true, board: normalised.board, version: info.version, existed: true }
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
