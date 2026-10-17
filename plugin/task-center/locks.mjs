/**
 * File locks — in-memory, project-relative, atomic.
 *
 * The point is to keep two workers from writing the same file at the same time.
 * A lock is therefore owned by a TASK while it runs, and released the moment the
 * task stops running (done / blocked / cancelled / lease expired).
 * Agents may also lock extra files from their tool calls; those are owned by the
 * same task id, so finishing the task releases them too.
 *
 * Keys are canonical project-relative POSIX paths. Paths are validated against
 * the project root, so a lock cannot be conjured for ../../etc/passwd, and a
 * lock on a directory conflicts with every path inside it (segment-aware, not a
 * raw string prefix: scripts/core must not conflict with scripts/core2).
 *
 * There is no wait queue. The scheduler re-checks every tick, and an agent that
 * cannot get a file is told who holds it. A queue would only add a way to wait
 * forever behind a dead worker.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Nothing locked. */
export function emptyLocks() {
  return {}
}

/** Windows filesystems are case-insensitive; lock identity must match. */
const CASE_FOLD = process.platform === 'win32'

function compareKey(path) {
  return CASE_FOLD ? path.toLowerCase() : path
}

function ownerKeyOf(lock) {
  if (lock.taskId !== null && lock.taskId !== undefined) return 'task:' + String(lock.taskId)
  return 'agent:' + String(lock.agent === undefined || lock.agent === null ? '' : lock.agent)
}

/** Canonical project-relative path, or a thrown error the caller can surface. */
export function canonicalLockPath(projectPath, input) {
  const raw = String(input === undefined || input === null ? '' : input).trim()
  if (raw === '') throw new Error('a lock needs a path')
  if (raw.indexOf('\u0000') >= 0) throw new Error('a lock path cannot contain a null byte')
  const absolute = resolve(projectPath, raw)
  const rel = relative(projectPath, absolute)
  if (rel === '' || rel === '.' || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../')) {
    throw new Error('lock path is outside the project: ' + raw)
  }
  return rel.split(sep).join('/')
}

/** Canonicalise a list, de-duplicating while preserving order. Throws on the
 * first invalid path. */
export function canonicalList(projectPath, inputs) {
  if (!Array.isArray(inputs)) return []
  const seen = new Set()
  const out = []
  for (const input of inputs) {
    const path = canonicalLockPath(projectPath, input)
    const key = compareKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

/** True when two canonical paths are the same file, or one is a directory that
 * contains the other. */
export function pathsConflict(left, right) {
  const a = compareKey(left)
  const b = compareKey(right)
  if (a === b) return true
  return a.startsWith(b + '/') || b.startsWith(a + '/')
}

/** Held paths that conflict with the requested ones, ignoring the owner itself. */
export function conflictsFor(locks, paths, ownerKey) {
  const out = []
  const seen = new Set()
  for (const heldPath of Object.keys(locks)) {
    const lock = locks[heldPath]
    if (ownerKey !== undefined && ownerKeyOf(lock) === ownerKey) continue
    for (const requested of paths) {
      if (!pathsConflict(requested, heldPath)) continue
      const key = heldPath + '|' + String(lock.taskId) + '|' + String(lock.agent)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        path: heldPath,
        taskId: lock.taskId === undefined ? null : lock.taskId,
        agent: lock.agent === undefined ? null : lock.agent,
        requested: requested,
      })
    }
  }
  return out
}

/** Acquire every requested path or none of them. Re-acquiring a path the same
 * owner already holds renews its lease. */
export function acquire(locks, paths, owner, now, leaseMs) {
  const list = Array.isArray(paths) ? paths.filter((path) => typeof path === 'string' && path !== '') : []
  if (list.length === 0) return { ok: false, code: 'no-path', message: 'a lock needs at least one path' }
  const ownerKey = owner.taskId !== null && owner.taskId !== undefined ? 'task:' + String(owner.taskId) : 'agent:' + String(owner.agent)
  const conflicts = conflictsFor(locks, list, ownerKey)
  if (conflicts.length > 0) return { ok: true, granted: false, conflicts: conflicts }
  const next = JSON.parse(JSON.stringify(locks))
  for (const path of list) {
    next[path] = {
      path: path,
      taskId: owner.taskId === undefined ? null : owner.taskId,
      agent: owner.agent === undefined || owner.agent === null ? null : String(owner.agent),
      since: typeof now === 'number' ? new Date(now).toISOString() : String(now),
      leaseUntil: new Date((typeof now === 'number' ? now : Date.now()) + leaseMs).toISOString(),
    }
  }
  return { ok: true, granted: true, locks: next, paths: list }
}

/** Release paths held by one owner. Returns what was actually released. */
export function release(locks, paths, owner) {
  const ownerKey = owner.taskId !== null && owner.taskId !== undefined ? 'task:' + String(owner.taskId) : 'agent:' + String(owner.agent)
  const next = JSON.parse(JSON.stringify(locks))
  const released = []
  const requested = Array.isArray(paths) ? paths : []
  if (requested.length === 0) {
    // No paths means "everything this owner holds".
    for (const path of Object.keys(next)) {
      if (ownerKeyOf(next[path]) !== ownerKey) continue
      delete next[path]
      released.push(path)
    }
  } else {
    for (const path of requested) {
      const lock = next[path]
      if (lock === undefined) continue
      if (ownerKeyOf(lock) !== ownerKey) continue
      delete next[path]
      released.push(path)
    }
  }
  if (released.length === 0) return { ok: false, code: 'not-held', message: 'none of those paths is held by this owner' }
  return { ok: true, locks: next, released: released }
}

/** Everything a task holds. Used when a task stops running. */
export function releaseTask(locks, taskId) {
  if (taskId === null || taskId === undefined) return { ok: true, locks: locks, released: [] }
  const next = JSON.parse(JSON.stringify(locks))
  const released = []
  for (const path of Object.keys(next)) {
    if (String(next[path].taskId) !== String(taskId)) continue
    delete next[path]
    released.push(path)
  }
  return { ok: true, locks: next, released: released }
}

/** The user's override: free these paths regardless of owner. */
export function forceRelease(locks, paths) {
  const next = JSON.parse(JSON.stringify(locks))
  const released = []
  for (const path of Array.isArray(paths) ? paths : []) {
    if (next[path] === undefined) continue
    delete next[path]
    released.push(path)
  }
  if (released.length === 0) return { ok: false, code: 'not-held', message: 'none of those paths is held' }
  return { ok: true, locks: next, released: released }
}

/** Drop expired locks. A lease that runs out means the owner stopped calling,
 * which for a task also means the scheduler will reap the claim on its next
 * pass; freeing the file here keeps other work moving in the meantime. */
export function expire(locks, now) {
  const next = JSON.parse(JSON.stringify(locks))
  const expired = []
  for (const path of Object.keys(next)) {
    const lock = next[path]
    if (lock.leaseUntil === null || lock.leaseUntil === undefined) continue
    if (Date.parse(lock.leaseUntil) > now) continue
    delete next[path]
    expired.push({ path: path, taskId: lock.taskId, agent: lock.agent })
  }
  return { ok: true, locks: next, expired: expired }
}

/** Renew every lock a task holds (called when a worker heartbeats). */
export function renewTask(locks, taskId, now, leaseMs) {
  const next = JSON.parse(JSON.stringify(locks))
  let renewed = 0
  for (const path of Object.keys(next)) {
    if (String(next[path].taskId) !== String(taskId)) continue
    next[path].leaseUntil = new Date(now + leaseMs).toISOString()
    renewed += 1
  }
  return { ok: true, locks: renewed === 0 ? locks : next, renewed: renewed }
}

/** What the API/panel shows: every held path with the task title when known. */
export function view(locks, board, now) {
  const byId = new Map((board === undefined || board === null ? [] : board.tasks).map((task) => [task.id, task]))
  return Object.keys(locks)
    .sort()
    .map((path) => {
      const lock = locks[path]
      const task = lock.taskId === null || lock.taskId === undefined ? undefined : byId.get(lock.taskId)
      return {
        path: path,
        taskId: lock.taskId === undefined ? null : lock.taskId,
        taskTitle: task === undefined ? null : task.title,
        agent: lock.agent === undefined ? null : lock.agent,
        since: lock.since,
        leaseUntil: lock.leaseUntil,
        expired: lock.leaseUntil !== null && Date.parse(lock.leaseUntil) <= now,
      }
    })
}