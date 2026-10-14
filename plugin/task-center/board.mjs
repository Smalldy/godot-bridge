/**
 * The project task board — one file per project, written under FsVersion CAS.
 *
 * Why a file rather than a storage domain: a domain is profile-scoped, its
 * change events are visible only inside one process, and it refuses to open once
 * the spec version moves (there is no migration). The board is PROJECT state, so
 * it belongs in the project — git-visible, portable, readable after this plugin
 * is uninstalled, and watchable across processes through `fs.watch`.
 *
 * Concurrency, in three layers:
 *
 *   1. In-process: writes to one path run one at a time on a promise chain, so
 *      two callers inside this host cannot interleave a read-modify-write.
 *   2. Across processes: every write carries the version it read, as
 *      `{ kind: 'replaceIfVersion', version }`. A mismatch fails with
 *      FS_STALE_VERSION instead of clobbering, and the fs provider guarantees
 *      the replacement itself is atomic.
 *   3. On conflict: the MUTATION is re-applied to freshly read content, for a
 *      bounded number of attempts. Re-applying the mutation — never the result
 *      it produced last time — is the whole point: a hand edit or another host
 *      that landed in between is preserved instead of reverted.
 *
 * A board file this module cannot parse is NEVER overwritten. Losing a hand
 * edit is worse than refusing to work, so an unparseable or unrecognisable
 * board reports a failure the caller has to surface.
 *
 * The sandbox is the caller's business: this module passes `options.sandboxPolicy`
 * straight to `fs.writeText` and never widens it on its own, so the policy that
 * governs a board write stays visible at the call site.
 */

import { join } from 'node:path'

/** Directory the board lives in, inside the worked project. */
export const BOARD_DIRECTORY = '.agents'
/** Board file name. */
export const BOARD_FILENAME = 'tasks.json'
/** Schema version, stored so a future migration can refuse politely. */
export const BOARD_VERSION = 1
/** Lease handed to an agent when it claims a task, in milliseconds. */
export const TASK_LEASE_MS = 30 * 60 * 1000
/** Attempts allowed when a write loses its version race. */
export const DEFAULT_ATTEMPTS = 3

/** Absolute path of the board inside one project. */
export function boardPath(projectPath) {
  return join(projectPath, BOARD_DIRECTORY, BOARD_FILENAME)
}

/** A fresh, empty board. File locks are deliberately NOT here: they are live
 * host state, not project state, because a lock outlives nothing. */
export function emptyBoard() {
  return { version: BOARD_VERSION, seq: 1, tasks: [], updatedAt: null }
}

function failure(code, message) {
  return { ok: false, code: code, message: message }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Highest `T-<n>` in a task list, so a hand-written board still allocates ids. */
function highestTaskNumber(tasks) {
  return tasks.reduce((highest, task) => {
    const match = task !== null && typeof task === 'object' && typeof task.id === 'string' ? /^T-(\d+)$/.exec(task.id) : null
    return match === null ? highest : Math.max(highest, Number(match[1]))
  }, 0)
}

/** Fill in the fields a hand-written board may omit. */
function normaliseBoard(parsed) {
  const seq = Number.isFinite(parsed.seq) && parsed.seq > 0 ? Math.floor(parsed.seq) : highestTaskNumber(parsed.tasks) + 1
  const version = Number.isFinite(parsed.version) ? Math.floor(parsed.version) : BOARD_VERSION
  return {
    version: version,
    seq: seq,
    tasks: parsed.tasks,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
  }
}

function isStale(error) {
  if (error === null || error === undefined) return false
  if (typeof error.code === 'string' && error.code === 'FS_STALE_VERSION') return true
  return /FS_STALE_VERSION/.test(String(error.message || ''))
}

/** One write. `version === null` means the file is expected to be absent. */
async function writeOnce(io, options, board, version) {
  try {
    const target = await io.fs.resolve(boardPath(options.projectPath), {
      cwd: options.projectPath,
      signal: options.signal,
    })
    const expected =
      version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: version }
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
 * Read the board.
 *
 * @param io - `{ fs }`, the filesystem service.
 * @param options - `{ projectPath, signal? }`.
 * @returns `{ ok: true, board, version, existed }` where `version` is `null` for
 *   an absent file, or `{ ok: false, code, message }` with `code` one of
 *   `unreadable` (the filesystem failed), `unparseable` (not JSON) or
 *   `unrecognisable` (no `tasks` array). The last two mean the file was left
 *   exactly as it was found.
 */
export async function readBoard(io, options) {
  try {
    const target = await io.fs.resolve(boardPath(options.projectPath), {
      cwd: options.projectPath,
      signal: options.signal,
    })
    const info = await io.fs.stat(target, options.signal)
    if (info === undefined) return { ok: true, board: emptyBoard(), version: null, existed: false }
    const text = await io.fs.readText(target, options.signal)
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return failure('unparseable', 'the board file is not valid JSON, so it is left untouched: ' + describe(error))
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.tasks)) {
      return failure('unrecognisable', 'the board file carries no `tasks` array, so it is left untouched')
    }
    return { ok: true, board: normaliseBoard(parsed), version: info.version, existed: true }
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
 * Apply a mutation to the board, retrying a lost version race.
 *
 * `mutate(board, attempt)` must be a pure function of the board it is handed:
 * on a conflict it runs again against freshly read content. Returning
 * `undefined`/`null` abandons the update.
 *
 * @param io - `{ fs }`, the filesystem service.
 * @param options - `{ projectPath, mutate, attempts?, signal?, sandboxPolicy? }`.
 * @returns `{ ok: true, board, version, attempts }` or `{ ok: false, code, … }`,
 *   where `code: 'stale'` means every attempt lost its race.
 */
export async function updateBoard(io, options) {
  const limit =
    Number.isFinite(options.attempts) && options.attempts >= 1
      ? Math.floor(options.attempts)
      : DEFAULT_ATTEMPTS
  return serialise(boardPath(options.projectPath), async () => {
    let attempts = 0
    for (;;) {
      attempts += 1
      const current = await readBoard(io, options)
      if (!current.ok) return current
      const next = options.mutate(current.board, attempts)
      if (next === undefined || next === null) return failure('no-change', 'the mutator returned nothing')
      if (next === null || typeof next !== 'object' || !Array.isArray(next.tasks)) {
        return failure('invalid-mutation', 'the mutator returned a board without a `tasks` array')
      }
      const payload = Object.assign({}, next, {
        version: BOARD_VERSION,
        updatedAt: new Date().toISOString(),
      })
      const written = await writeOnce(io, options, payload, current.version)
      if (written.ok) return { ok: true, board: payload, version: written.version, attempts: attempts }
      if (written.code !== 'stale' || attempts >= limit) {
        return Object.assign({}, written, { attempts: attempts })
      }
    }
  })
}
