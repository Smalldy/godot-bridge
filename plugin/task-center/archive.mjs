/**
 * T-242 — the COLD done-card archive (.agents/tasks-archive.json).
 *
 * The board is working state: a heartbeat, a panel poll and the dispatch sweep
 * all read it, and several of them rewrite it. With 226 finished cards on a
 * 5.6 MB board that cost was paid on every one of those operations, so finished
 * work moves OUT of the hot board into one archive file:
 *
 *   .agents/tasks.json          active cards + the newest keepDone done cards
 *   .agents/tasks-archive.json  every older done card (the full card record)
 *
 * Nothing is ever deleted. An archived card keeps its whole record — spec,
 * acceptance, evidence, history, merge/review/test — and stays readable through
 * task_center get / the panel's /task; /list?archived=1 pages the archive.
 *
 * THE MOVE IS A TWO-FILE TRANSACTION, ordered so a crash can never lose a card:
 *
 *   1. the archive file is written first: a temp file is written and READ BACK
 *      (the fs facade has no rename, so this is the only proof the payload is
 *      complete), the previous archive is copied to '.bak', and only then is the
 *      new payload promoted under CAS;
 *   2. only after that does ONE board CAS mutation drop those cards, recording a
 *      tiny 'archivedDone' index row per card.
 *
 * A failure between the two steps leaves a DUPLICATE (the card is on the board
 * AND in the archive), never a loss: the next sweep dedupes by id and removes
 * the board copy idempotently.
 *
 * 'archivedDone' is what keeps the dependency graph honest. A pending card may
 * depend on a done card that is no longer hot, so the board carries one small
 * row per archived card — { id, status, kind, mergeStatus, at } — and
 * read-model's dependencyInfo() treats that row as the dependency evidence. It
 * is a handful of bytes per archived card (226 rows are ~15 KB) and it costs NO
 * file read, so the hot path stays a single stat.
 *
 * SAFETY RULES baked into the selection:
 *   - only 'done' cards are ever archived (running/reviewing/testing/blocked are
 *     never cold);
 *   - the newest keepDone done cards never leave the board;
 *   - a card only becomes cold after doneAfterDays;
 *   - maxBoardBytes is a size trigger that archives OLD cold cards early, but it
 *     still never touches the newest keepDone.
 *
 * Settings live on the board (board.archive) so they survive a restart, are
 * CAS-written, and are readable from the board the sweep already has.
 */

import { join } from 'node:path'

/** Archive file schema. Independent of the board's: a newer board must not make
 * an old archive unreadable, and a future archive format is refused rather than
 * silently rewritten. */
export const ARCHIVE_VERSION = 1
export const ARCHIVE_DIRECTORY = '.agents'
export const ARCHIVE_FILENAME = 'tasks-archive.json'
/** The staged payload a promote reads back before it can replace the archive. */
export const ARCHIVE_TEMP_SUFFIX = '.tmp'
/** The previous archive, kept next to it so a bad promote is always restorable. */
export const ARCHIVE_BACKUP_SUFFIX = '.bak'
/** Refuse to load (or write) an archive larger than this: a wrong path must never
 * be parsed, and a runaway write must never land. */
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
export const DAY_MS = 24 * 60 * 60 * 1000

/** The four archive knobs, with the defaults the panel starts from. */
export const ARCHIVE_DEFAULTS = Object.freeze({
  // Archiving is ON by default: a board that keeps every finished card grows
  // without bound, and 5.6 MB of it was done cards nobody re-reads.
  enabled: true,
  doneAfterDays: 14,
  keepDone: 50,
  maxBoardBytes: 2 * 1024 * 1024,
})

/**
 * The accepted range of every numeric knob. normaliseArchiveSettings CLAMPS a
 * stored value (a hand-edited board must stay readable); the settings action
 * REFUSES an out-of-range save and keeps the old value.
 */
export const ARCHIVE_LIMITS = Object.freeze({
  doneAfterDays: { min: 1, max: 3650 },
  keepDone: { min: 0, max: 2000 },
  maxBoardBytes: { min: 64 * 1024, max: 32 * 1024 * 1024 },
})

export const ARCHIVE_SETTING_KEYS = Object.freeze(['enabled', 'doneAfterDays', 'keepDone', 'maxBoardBytes'])

/** Absolute path of this project's done-card archive. */
export function tasksArchivePath(projectPath) {
  return join(projectPath, ARCHIVE_DIRECTORY, ARCHIVE_FILENAME)
}

export function tasksArchiveTempPath(projectPath) {
  return tasksArchivePath(projectPath) + ARCHIVE_TEMP_SUFFIX
}

export function tasksArchiveBackupPath(projectPath) {
  return tasksArchivePath(projectPath) + ARCHIVE_BACKUP_SUFFIX
}

function failure(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTaskId(value) {
  return typeof value === 'string' && /^T-\d+$/.test(value.trim())
}

function clampInt(value, limit, fallback) {
  if (!Number.isFinite(value)) return fallback
  const number = Math.floor(value)
  return Math.min(limit.max, Math.max(limit.min, number))
}

/**
 * T-242: the per-card signature the sweep compares across reads.
 *
 * The sweep plans from one board read, appends the cards to the archive, then
 * removes them in one board CAS whose mutation re-reads the file. BOTH sides are
 * normalised by board.mjs, and normaliseTask FILLS MISSING BOOKKEEPING FROM THE
 * READ CLOCK: a card whose file row has no createdAt/updatedAt gets `iso(now)`,
 * and a history row without a valid `at` gets the same. Two reads of the SAME
 * unmodified file can therefore disagree on those values by a few milliseconds.
 *
 * Comparing the raw JSON would read that as "someone edited the card": on a
 * legacy board (or a board seeded by another writer) whose cards never persisted
 * those fields, the sweep would keep every card hot on every tick — and because a
 * deferral writes nothing, nothing would ever normalise the file, so the sweep
 * would never archive again. This signature ignores exactly those three read-clock
 * defaults and nothing else: every other field (status, title, spec, evidence,
 * history rows' body, owner, lease, dispatch, merge/review/test, ...) is compared
 * byte-for-byte. No action rewrites a card's timestamps WITHOUT changing another
 * field, so a concurrent reopen or edit is still detected and kept hot.
 */
export function cardContentSignature(task) {
  if (!isRecord(task)) return JSON.stringify(task)
  const copy = Object.assign({}, task)
  delete copy.createdAt
  delete copy.updatedAt
  if (Array.isArray(copy.history)) {
    copy.history = copy.history.map((row) => {
      if (!isRecord(row)) return row
      const entry = Object.assign({}, row)
      delete entry.at
      return entry
    })
  }
  return JSON.stringify(copy)
}

/** When a done card finished (its last write), as ms; NaN when unreadable. */
export function doneAtOf(task) {
  if (!isRecord(task)) return Number.NaN
  const value = task.updatedAt === undefined || task.updatedAt === null ? '' : task.updatedAt
  return Date.parse(String(value))
}

/** Oldest first: the order the size trigger archives in. */
function compareOldestFirst(left, right) {
  const leftAt = doneAtOf(left)
  const rightAt = doneAtOf(right)
  const leftTime = Number.isFinite(leftAt) ? leftAt : 0
  const rightTime = Number.isFinite(rightAt) ? rightAt : 0
  if (leftTime !== rightTime) return leftTime - rightTime
  return String(left === null || left === undefined ? '' : left.id).localeCompare(String(right === null || right === undefined ? '' : right.id))
}

/** Newest first: the order the archive file is stored and paged in. */
function compareNewestFirst(left, right) {
  return compareOldestFirst(right, left)
}

/**
 * The board's stored archive settings, always complete and always in range.
 * lastSweepAt / lastSweep are DIAGNOSTICS, not settings: the panel shows
 * "20 cards moved 5 minutes ago" without a second read.
 */
export function normaliseArchiveSettings(raw) {
  const source = isRecord(raw) ? raw : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : ARCHIVE_DEFAULTS.enabled,
    doneAfterDays: clampInt(source.doneAfterDays, ARCHIVE_LIMITS.doneAfterDays, ARCHIVE_DEFAULTS.doneAfterDays),
    keepDone: clampInt(source.keepDone, ARCHIVE_LIMITS.keepDone, ARCHIVE_DEFAULTS.keepDone),
    maxBoardBytes: clampInt(source.maxBoardBytes, ARCHIVE_LIMITS.maxBoardBytes, ARCHIVE_DEFAULTS.maxBoardBytes),
    lastSweepAt: isIso(source.lastSweepAt) ? source.lastSweepAt : null,
    lastSweep: normaliseLastSweep(source.lastSweep),
  }
}

function normaliseLastSweep(raw) {
  if (!isRecord(raw)) return null
  return {
    at: isIso(raw.at) ? raw.at : null,
    archived: Number.isFinite(raw.archived) ? Math.max(0, Math.floor(raw.archived)) : 0,
    boardBytes: Number.isFinite(raw.boardBytes) ? Math.max(0, Math.floor(raw.boardBytes)) : null,
  }
}

/**
 * Validate ONE settings save. A caller may send any subset of the four keys; a
 * key that is present must be inside its range, and an unknown key is a refusal
 * (a typo must never look like "saved"). The old value is kept by never writing
 * a refused patch.
 *
 * @returns { ok: true, patch } or { ok: false, code: 'invalid-archive-setting',
 *   field, message }
 */
export function validateArchiveSettingsPatch(raw) {
  if (!isRecord(raw)) {
    return failure('invalid-archive-setting', 'archive settings must be an object with any of ' + ARCHIVE_SETTING_KEYS.join(', '), { field: null })
  }
  const provided = Object.keys(raw)
  const unknown = provided.filter((key) => ARCHIVE_SETTING_KEYS.indexOf(key) < 0)
  if (unknown.length > 0) {
    return failure('invalid-archive-setting', 'unknown archive setting ' + JSON.stringify(unknown[0]) + '; expected one of ' + ARCHIVE_SETTING_KEYS.join(', '), { field: unknown[0] })
  }
  if (provided.length === 0) {
    return failure('invalid-archive-setting', 'no archive setting was supplied', { field: null })
  }
  const patch = {}
  if (Object.hasOwn(raw, 'enabled')) {
    if (typeof raw.enabled !== 'boolean') {
      return failure('invalid-archive-setting', 'archiveEnabled must be true or false', { field: 'enabled' })
    }
    patch.enabled = raw.enabled
  }
  for (const key of ['doneAfterDays', 'keepDone', 'maxBoardBytes']) {
    if (!Object.hasOwn(raw, key)) continue
    const value = raw[key]
    const limit = ARCHIVE_LIMITS[key]
    if (!Number.isInteger(value) || value < limit.min || value > limit.max) {
      return failure(
        'invalid-archive-setting',
        key + ' must be a whole number between ' + String(limit.min) + ' and ' + String(limit.max) + ' (got ' + JSON.stringify(value) + ')',
        { field: key },
      )
    }
    patch[key] = value
  }
  return { ok: true, patch: patch }
}

/** Merge one validated patch into the stored settings, keeping the diagnostics. */
export function applyArchiveSettings(current, patch) {
  const base = normaliseArchiveSettings(current)
  const source = Object.assign({}, base, isRecord(patch) ? patch : {})
  return normaliseArchiveSettings(source)
}

/**
 * The board's 'archivedDone' index, normalised. It is DERIVED data: a malformed
 * row is dropped instead of refusing the board, and a duplicate id keeps the
 * first row.
 */
export function normaliseArchivedIndex(raw) {
  const rows = []
  const seen = new Set()
  if (!Array.isArray(raw)) return rows
  for (const entry of raw) {
    if (!isRecord(entry) || !isTaskId(entry.id)) continue
    const id = String(entry.id).trim()
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({
      id: id,
      // An archived card is always finished work; anything else is kept as
      // written so a hand-edited index cannot silently satisfy a dependency.
      status: typeof entry.status === 'string' && entry.status !== '' ? entry.status : 'done',
      kind: entry.kind === 'investigate' ? 'investigate' : 'dev',
      // The merge state decides whether a DEPENDENT may start. null keeps the
      // legacy "done is enough" rule (a card with no merge request).
      mergeStatus: typeof entry.mergeStatus === 'string' && entry.mergeStatus !== '' ? entry.mergeStatus : null,
      at: isIso(entry.at) ? entry.at : null,
    })
  }
  return rows
}

/** The index rows for a set of archived cards (the dependency evidence). */
export function archivedIndexRows(tasks, now) {
  const rows = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isRecord(task) || !isTaskId(task.id)) continue
    rows.push({
      id: String(task.id).trim(),
      status: typeof task.status === 'string' && task.status !== '' ? task.status : 'done',
      kind: task.kind === 'investigate' ? 'investigate' : 'dev',
      mergeStatus: isRecord(task.merge) && typeof task.merge.status === 'string' ? task.merge.status : null,
      at: isIso(task.updatedAt) ? task.updatedAt : iso(now),
    })
  }
  return rows
}

/** Union two index lists by id. The newer row wins; the result is newest first. */
export function mergeArchivedIndex(current, additions) {
  const byId = new Map()
  for (const row of normaliseArchivedIndex(current)) byId.set(row.id, row)
  for (const row of normaliseArchivedIndex(additions)) {
    const existing = byId.get(row.id)
    const existingAt = existing === undefined || existing.at === null ? '' : String(existing.at)
    const rowAt = row.at === null ? '' : String(row.at)
    if (existing === undefined || rowAt.localeCompare(existingAt) >= 0) byId.set(row.id, row)
  }
  return Array.from(byId.values()).sort((left, right) => {
    const byTime = String(right.at === null ? '' : right.at).localeCompare(String(left.at === null ? '' : left.at))
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id)
  })
}

/**
 * What the sweep WOULD move right now — pure, so the thresholds are testable
 * without a sweep and the sweep can answer "nothing to do" without any IO.
 *
 * @param board       the hot board ({ tasks })
 * @param settings    board.archive (any stored shape; normalised here)
 * @param now         ms clock
 * @param boardBytes  the size of the board FILE (0 when unknown)
 * @returns { enabled, doneCount, keepDone, keptCount, beyondCount, coldCount,
 *   overBytes, boardBytes, maxBoardBytes, due ('age'|'size'|null), candidates }
 *   candidates is oldest-first and is EXACTLY what would be archived.
 */
export function archivePlanOf(board, settings, now, boardBytes) {
  const config = normaliseArchiveSettings(settings)
  const at = Number.isFinite(now) ? now : Date.now()
  const tasks = isRecord(board) && Array.isArray(board.tasks) ? board.tasks : []
  const bytes = Number.isFinite(boardBytes) && boardBytes >= 0 ? Math.floor(boardBytes) : 0
  const done = tasks.filter((task) => isRecord(task) && task.status === 'done')
  const oldestFirst = done.slice().sort(compareOldestFirst)
  // The newest keepDone done cards never leave the hot board: they are the ones
  // the panel's done column and a human's "what just finished" read need.
  const keptCount = Math.max(0, Math.min(oldestFirst.length, config.keepDone))
  // beyond = the OLDEST (length - keepDone) cards. Slicing from the FRONT keeps
  // the newest keepDone on the board — slicing from the back would archive the
  // newest, which is the opposite of what "keep the recent ones" means.
  const beyond = oldestFirst.slice(0, Math.max(0, oldestFirst.length - keptCount))
  const cutoff = at - config.doneAfterDays * DAY_MS
  const cold = beyond.filter((task) => {
    const doneAt = doneAtOf(task)
    return Number.isFinite(doneAt) && doneAt <= cutoff
  })
  const overBytes = config.enabled === true && bytes > config.maxBoardBytes
  let candidates = []
  let due = null
  if (config.enabled === true) {
    if (overBytes) {
      // The size trigger outranks the age rule: archive the OLDEST cards beyond
      // keepDone until the board is projected under the limit again. Best effort
      // — the next pass continues if the estimate was short. One archived card
      // costs ~80 bytes of index row on the board, so the NET saving is a card
      // minus its row, never the card alone.
      const perCard = tasks.length > 0 ? Math.max(1, bytes / tasks.length - 80) : 0
      const need = perCard > 0 ? Math.max(1, Math.ceil((bytes - config.maxBoardBytes) / perCard)) : beyond.length
      candidates = beyond.slice(0, Math.max(0, Math.min(beyond.length, need)))
      if (candidates.length > 0) due = 'size'
    } else if (cold.length > 0) {
      candidates = cold.slice()
      due = 'age'
    }
  }
  return {
    enabled: config.enabled,
    doneCount: done.length,
    keepDone: config.keepDone,
    keptCount: keptCount,
    beyondCount: beyond.length,
    coldCount: cold.length,
    overBytes: overBytes,
    boardBytes: bytes,
    maxBoardBytes: config.maxBoardBytes,
    due: due,
    candidates: candidates,
  }
}

/** The archive payload, exactly as it is written (pretty, so it stays readable). */
export function archiveTextOf(tasks, now) {
  const list = Array.isArray(tasks) ? tasks : []
  return JSON.stringify({ version: ARCHIVE_VERSION, updatedAt: iso(now), count: list.length, tasks: list }, null, 2) + '\n'
}

/**
 * Take STALE copies back out of the archive.
 *
 * The sweep archives the plan's cards BEFORE it removes them from the board, so
 * a crash can never lose one. A card a concurrent action reopened or edited in
 * that window must STAY on the board, and its already-appended copy must come
 * back out — a hot card may never also be archived.
 *
 * Removal is CONTENT-MATCHED, never by id alone: another sweep may have archived
 * a NEWER version of the same card in the meantime, and that copy is not ours to
 * delete. The read-merge-write loop makes the removal safe against a concurrent
 * editor of the same archive, and an id that does not match is simply left alone.
 *
 * @returns { ok: true, removed, tasks, version, attempts } or a readable failure.
 */
export async function removeFromTaskArchive(io, options, stale) {
  const opts = options === undefined || options === null ? {} : options
  const wanted = new Map()
  for (const task of Array.isArray(stale) ? stale : []) {
    if (!isRecord(task) || !isTaskId(task.id)) continue
    wanted.set(String(task.id).trim(), JSON.stringify(task))
  }
  if (wanted.size === 0) return { ok: true, removed: [], tasks: null, version: null, attempts: 0 }
  const attempts = Number.isInteger(opts.attempts) && opts.attempts > 0 ? opts.attempts : 3
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const read = await readTaskArchive(io, opts)
    if (read.ok !== true) return read
    const kept = []
    const removed = []
    for (const task of read.tasks) {
      const serialized = wanted.get(String(task.id))
      if (serialized !== undefined && JSON.stringify(task) === serialized) {
        removed.push(String(task.id))
        continue
      }
      kept.push(task)
    }
    if (removed.length === 0) return { ok: true, removed: [], tasks: read.tasks, version: read.version, attempts: attempt }
    const expectation = read.version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: read.version }
    const written = await writeTaskArchive(io, opts, kept, expectation)
    if (written.ok === true) return { ok: true, removed: removed, tasks: kept, version: written.version, attempts: attempt }
    if (written.code !== 'stale') return written
  }
  return failure('archive-busy', 'could not take stale archive copies back out after ' + String(attempts) + ' attempts; they are duplicates of cards still on the board, never a loss')
}

/**
 * Read .agents/tasks-archive.json.
 *
 * @returns { ok: true, tasks, version, bytes, existed, updatedAt } or
 *   { ok: false, code: 'archive-unreadable'|'archive-unparseable'|
 *   'archive-too-large'|'archive-unsupported-version', message }
 *   A MISSING file is an empty archive, never an error.
 */
export async function readTaskArchive(io, options) {
  const opts = options === undefined || options === null ? {} : options
  try {
    const target = await io.fs.resolve(tasksArchivePath(opts.projectPath), { cwd: opts.projectPath, signal: opts.signal })
    const info = await io.fs.stat(target, opts.signal)
    if (info === undefined) return { ok: true, tasks: [], version: null, bytes: 0, existed: false, updatedAt: null }
    if (Number.isFinite(info.size) && info.size > MAX_ARCHIVE_BYTES) {
      return failure('archive-too-large', 'the archive file is larger than ' + String(MAX_ARCHIVE_BYTES) + ' bytes; refusing to load it')
    }
    const text = await io.fs.readText(target, opts.signal)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_ARCHIVE_BYTES) {
      return failure('archive-too-large', 'the archive file is larger than ' + String(MAX_ARCHIVE_BYTES) + ' bytes; refusing to load it')
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return failure('archive-unparseable', 'the archive file is not valid JSON, so it is left untouched: ' + describe(error))
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
      return failure('archive-unparseable', 'the archive file carries no tasks array, so it is left untouched')
    }
    if (Number.isFinite(parsed.version) && parsed.version > ARCHIVE_VERSION) {
      return failure(
        'archive-unsupported-version',
        'the archive is version ' + String(parsed.version) + ' but this plugin understands at most ' + String(ARCHIVE_VERSION) + '; refusing to rewrite it',
      )
    }
    const tasks = []
    const seen = new Set()
    for (const entry of parsed.tasks) {
      if (!isRecord(entry) || !isTaskId(entry.id)) continue
      const id = String(entry.id).trim()
      if (seen.has(id)) continue
      seen.add(id)
      tasks.push(entry)
    }
    tasks.sort(compareNewestFirst)
    return {
      ok: true,
      tasks: tasks,
      version: info.version,
      bytes: bytes,
      existed: true,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch (error) {
    return failure('archive-unreadable', 'could not read the archive file: ' + describe(error))
  }
}

/**
 * Stage + verify + back up + promote one archive payload.
 *
 * The temp write is READ BACK before anything is promoted, and the current
 * archive is copied to '.bak' before it can be replaced — a backup that cannot
 * be written aborts the promote rather than replacing what cannot be restored.
 * 'expected' is the CAS expectation for the real path (createIfAbsent or
 * replaceIfVersion); a lost race answers { ok: false, code: 'stale' } and
 * appendToTaskArchive() retries against the fresh file.
 */
export async function writeTaskArchive(io, options, tasks, expected) {
  const opts = options === undefined || options === null ? {} : options
  const projectPath = opts.projectPath
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const list = Array.isArray(tasks) ? tasks : []
  const text = archiveTextOf(list, now)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_ARCHIVE_BYTES) {
    return failure('archive-too-large', 'the archive payload is larger than ' + String(MAX_ARCHIVE_BYTES) + ' bytes; nothing was written')
  }
  try {
    if (typeof opts.ensureDir === 'function') await Promise.resolve(opts.ensureDir(join(projectPath, ARCHIVE_DIRECTORY)))
    // 1. stage, then read the staged payload back
    const tempTarget = await io.fs.resolve(tasksArchiveTempPath(projectPath), { cwd: projectPath, signal: opts.signal })
    const tempInfo = await io.fs.stat(tempTarget, opts.signal)
    await io.fs.writeText(tempTarget, text, tempInfo === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: tempInfo.version }, opts.signal, opts.sandboxPolicy)
    const staged = await io.fs.readText(tempTarget, opts.signal)
    let verified
    try {
      verified = JSON.parse(staged)
    } catch (error) {
      return failure('archive-unwritable', 'the staged archive did not read back as JSON: ' + describe(error))
    }
    if (!isRecord(verified) || !Array.isArray(verified.tasks) || verified.tasks.length !== list.length) {
      return failure('archive-unwritable', 'the staged archive did not read back intact (' + String(list.length) + ' cards expected); nothing was promoted')
    }
    // 2. back up what is there now, so a bad promote is reversible
    const target = await io.fs.resolve(tasksArchivePath(projectPath), { cwd: projectPath, signal: opts.signal })
    const current = await io.fs.stat(target, opts.signal)
    if (current !== undefined) {
      const previous = await io.fs.readText(target, opts.signal)
      const backupTarget = await io.fs.resolve(tasksArchiveBackupPath(projectPath), { cwd: projectPath, signal: opts.signal })
      const backupInfo = await io.fs.stat(backupTarget, opts.signal)
      await io.fs.writeText(backupTarget, previous, backupInfo === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: backupInfo.version }, opts.signal, opts.sandboxPolicy)
    }
    // 3. promote under CAS
    const expectation = isRecord(expected) ? expected : current === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: current.version }
    const promoted = await io.fs.writeText(target, text, expectation, opts.signal, opts.sandboxPolicy)
    return { ok: true, version: promoted.version, bytes: bytes }
  } catch (error) {
    const stale = error !== null && error !== undefined && (error.code === 'FS_STALE_VERSION' || /FS_STALE_VERSION/.test(String(error.message || '')))
    return failure(stale ? 'stale' : 'archive-unwritable', 'could not write the archive file: ' + describe(error))
  }
}

/**
 * Append cards to the archive under a read-merge-write loop.
 *
 * This is the ONLY writer the sweep uses: two hosts sweeping the same project
 * both stage a payload, one wins the CAS, the other re-reads and retries, so the
 * archive can never lose a card another sweep just wrote. A card that is already
 * archived is skipped, which also makes the removal step idempotent.
 *
 * @returns { ok: true, added, tasks, version, bytes, attempts } or
 *   { ok: false, code, message }
 */
export async function appendToTaskArchive(io, options, additions) {
  const opts = options === undefined || options === null ? {} : options
  const extra = Array.isArray(additions) ? additions.filter((task) => isRecord(task) && isTaskId(task.id)) : []
  const attempts = Number.isInteger(opts.attempts) && opts.attempts > 0 ? opts.attempts : 3
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const read = await readTaskArchive(io, opts)
    if (read.ok !== true) return read
    const seen = new Set(read.tasks.map((task) => String(task.id)))
    const fresh = extra.filter((task) => !seen.has(String(task.id)))
    if (fresh.length === 0) {
      return { ok: true, added: [], tasks: read.tasks, version: read.version, bytes: read.bytes, attempts: attempt }
    }
    const merged = read.tasks.concat(fresh).sort(compareNewestFirst)
    const expectation = read.version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: read.version }
    const written = await writeTaskArchive(io, opts, merged, expectation)
    if (written.ok === true) {
      return { ok: true, added: fresh.map((task) => String(task.id)), tasks: merged, version: written.version, bytes: written.bytes, attempts: attempt }
    }
    if (written.code !== 'stale') return written
  }
  return failure(
    'archive-busy',
    'the archive was rewritten by another process ' + String(attempts) + ' times; nothing was lost — the cards are still on the board and the next sweep retries',
  )
}
