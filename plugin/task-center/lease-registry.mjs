/**
 * Project leader leases.
 *
 * The scheduler's bootId is process-local; two DSH processes that share the
 * same project can therefore both believe they own a running card. This module
 * is the durable, cross-process half: one leader lease per project, with an
 * owner, a boot id, a pid, a heartbeat and a TTL.
 *
 * The file lives under <project>/.agents/ (machine-local working state, like
 * tasks.json). Every mutation is serialised by a short-lived .lock file and the
 * data file is replaced atomically (write temp + rename). A missing/corrupt file
 * is reported, never silently treated as "no owner".
 *
 * This module only owns the lease record. Wiring the scheduler's reap/claim to
 * it is a separate step; until then it is a tested primitive, not a claim that
 * the dispatcher is already cross-process safe.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const DEFAULT_LEASE_TTL_MS = 30 * 1000
const LOCK_TIMEOUT_MS = 2000
const LOCK_RETRY_MS = 25

function failure(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
}

function ok(payload) {
  return Object.assign({ ok: true }, payload === undefined ? {} : payload)
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export function createLeaseRegistry(options) {
  const opts = options === undefined || options === null ? {} : options
  const file = resolve(String(opts.file === undefined ? '.agents/leader-leases.json' : opts.file))
  const lockFile = file + '.lock'
  const ttlMs = Number.isFinite(opts.ttlMs) ? Math.max(1, Math.floor(opts.ttlMs)) : DEFAULT_LEASE_TTL_MS
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const ensureDir = typeof opts.ensureDir === 'function' ? opts.ensureDir : (dir) => mkdirSync(dir, { recursive: true })
  const bootId = typeof opts.bootId === 'string' && opts.bootId !== '' ? opts.bootId : null
  const pid = Number.isFinite(opts.pid) ? Math.floor(opts.pid) : null

  function readUnlocked() {
    if (!existsSync(file)) return ok({ data: { version: 1, leases: {} } })
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return failure('lease-corrupt', 'the lease file is not a JSON object')
      if (parsed.leases === null || typeof parsed.leases !== 'object' || Array.isArray(parsed.leases)) return failure('lease-corrupt', 'the lease file has no leases object')
      return ok({ data: { version: 1, leases: parsed.leases } })
    } catch (error) {
      return failure('lease-corrupt', 'the lease file could not be read: ' + String((error && error.message) || error))
    }
  }

  function writeUnlocked(data) {
    ensureDir(dirname(file))
    const temp = file + '.tmp-' + String(process.pid) + '-' + Math.random().toString(36).slice(2)
    try {
      writeFileSync(temp, JSON.stringify(data, null, 2))
      renameSync(temp, file)
      return ok({})
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch (ignored) {}
      return failure('lease-write-failed', String((error && error.message) || error))
    }
  }

  async function withLock(work) {
    const started = now()
    for (;;) {
      let fd = null
      try {
        ensureDir(dirname(file))
        fd = openSync(lockFile, 'wx')
      } catch (error) {
        if (error === null || error === undefined || error.code !== 'EEXIST') {
          return failure('lease-lock-failed', 'could not create ' + lockFile + ': ' + String((error && error.message) || error))
        }
        if (now() - started >= LOCK_TIMEOUT_MS) return failure('lease-busy', 'the lease file stayed locked for ' + String(LOCK_TIMEOUT_MS) + 'ms')
        await sleep(LOCK_RETRY_MS)
        continue
      }
      try {
        return await work()
      } finally {
        try {
          closeSync(fd)
        } catch (ignored) {}
        try {
          unlinkSync(lockFile)
        } catch (ignored) {}
      }
    }
  }

  async function claim(project, owner) {
    const id = String(project === undefined || project === null ? '' : project).trim()
    const who = String(owner === undefined || owner === null ? '' : owner).trim()
    if (id === '' || who === '') return failure('invalid-lease', 'a project and an owner are required')
    return withLock(() => {
      const read = readUnlocked()
      if (read.ok !== true) return read
      const at = now()
      const current = read.data.leases[id]
      if (current !== undefined && current !== null && current.owner !== who && Number(current.expiresAt) > at) {
        return failure('lease-held', 'project ' + id + ' is held by ' + String(current.owner), { holder: current })
      }
      const renewed = current !== undefined && current !== null && current.owner === who
      const lease = {
        owner: who,
        bootId: bootId,
        pid: pid,
        acquiredAt: renewed ? current.acquiredAt : new Date(at).toISOString(),
        heartbeatAt: new Date(at).toISOString(),
        expiresAt: at + ttlMs,
      }
      read.data.leases[id] = lease
      const written = writeUnlocked(read.data)
      if (written.ok !== true) return written
      return ok({ action: renewed ? 'renewed' : 'claimed', lease: lease })
    })
  }

  async function heartbeat(project, owner) {
    const id = String(project === undefined || project === null ? '' : project).trim()
    const who = String(owner === undefined || owner === null ? '' : owner).trim()
    if (id === '' || who === '') return failure('invalid-lease', 'a project and an owner are required')
    return withLock(() => {
      const read = readUnlocked()
      if (read.ok !== true) return read
      const at = now()
      const current = read.data.leases[id]
      if (current === undefined || current === null) return failure('lease-not-held', 'project ' + id + ' has no lease')
      if (current.owner !== who) return failure('lease-held', 'project ' + id + ' is held by ' + String(current.owner), { holder: current })
      if (Number(current.expiresAt) <= at) return failure('lease-expired', 'the lease for ' + id + ' has expired')
      const lease = Object.assign({}, current, { heartbeatAt: new Date(at).toISOString(), expiresAt: at + ttlMs })
      read.data.leases[id] = lease
      const written = writeUnlocked(read.data)
      if (written.ok !== true) return written
      return ok({ lease: lease })
    })
  }

  async function release(project, owner) {
    const id = String(project === undefined || project === null ? '' : project).trim()
    const who = String(owner === undefined || owner === null ? '' : owner).trim()
    if (id === '' || who === '') return failure('invalid-lease', 'a project and an owner are required')
    return withLock(() => {
      const read = readUnlocked()
      if (read.ok !== true) return read
      const current = read.data.leases[id]
      if (current === undefined || current === null) return ok({ action: 'none' })
      if (current.owner !== who) return failure('lease-held', 'project ' + id + ' is held by ' + String(current.owner), { holder: current })
      delete read.data.leases[id]
      const written = writeUnlocked(read.data)
      if (written.ok !== true) return written
      return ok({ action: 'released' })
    })
  }

  function holder(project) {
    const id = String(project === undefined || project === null ? '' : project).trim()
    if (id === '') return failure('invalid-lease', 'a project is required')
    const read = readUnlocked()
    if (read.ok !== true) return read
    const current = read.data.leases[id]
    if (current === undefined || current === null) return ok({ lease: null, expired: false })
    return ok({ lease: current, expired: Number(current.expiresAt) <= now() })
  }

  function snapshot() {
    const read = readUnlocked()
    if (read.ok !== true) return read
    return ok({ leases: read.data.leases, ttlMs: ttlMs })
  }

  return { claim: claim, heartbeat: heartbeat, release: release, holder: holder, snapshot: snapshot, ttlMs: ttlMs, file: file }
}
