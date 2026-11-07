/**
 * Durable merge intents.
 *
 * The merge queue can time out or a host can die after git advanced the target
 * but before the board recorded the result. The board alone cannot tell whether
 * the branch moved; this journal is the missing intent/outcome record:
 *
 *   begin  -> { id, target, base, head, state: 'merging' }
 *   finish -> { state: 'merged'|'failed'|'conflict'|'stale'|'abandoned', outcome }
 *
 * On startup a caller can run planReconcile() with the current target head and
 * an isAncestor probe:
 *   - candidate is contained in the target -> mark-merged;
 *   - target is still at base                -> mark-abandoned;
 *   - target moved but candidate is absent   -> mark-stale.
 *
 * The journal is machine-local working state under .agents/, like tasks.json.
 * It is not a second board: it records only what happened to one merge unit.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const MAX_ENTRIES = 200

function failure(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
}

function ok(payload) {
  return Object.assign({ ok: true }, payload === undefined ? {} : payload)
}

export function createMergeJournal(options) {
  const opts = options === undefined || options === null ? {} : options
  const file = resolve(String(opts.file === undefined ? '.agents/merge-journal.json' : opts.file))
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const ensureDir = typeof opts.ensureDir === 'function' ? opts.ensureDir : (dir) => mkdirSync(dir, { recursive: true })
  const fs = opts.fs === undefined ? { existsSync: existsSync, readFileSync: readFileSync, writeFileSync: writeFileSync, renameSync: renameSync, unlinkSync: unlinkSync } : opts.fs

  function read() {
    if (!fs.existsSync(file)) return ok({ entries: [] })
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return failure('journal-corrupt', 'the merge journal is not a JSON object')
      if (!Array.isArray(parsed.entries)) return failure('journal-corrupt', 'the merge journal has no entries array')
      return ok({ entries: parsed.entries })
    } catch (error) {
      return failure('journal-corrupt', 'the merge journal could not be read: ' + String((error && error.message) || error))
    }
  }

  function write(entries) {
    ensureDir(dirname(file))
    const temp = file + '.tmp-' + String(process.pid) + '-' + Math.random().toString(36).slice(2)
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, entries: entries }, null, 2))
      fs.renameSync(temp, file)
      return ok({})
    } catch (error) {
      try {
        fs.unlinkSync(temp)
      } catch (ignored) {}
      return failure('journal-write-failed', String((error && error.message) || error))
    }
  }

  function keyOf(input) {
    return String(input.id) + '@' + String(input.base) + '@' + String(input.head)
  }

  async function begin(input) {
    const value = input === undefined || input === null ? {} : input
    const id = String(value.id === undefined || value.id === null ? '' : value.id).trim()
    const target = String(value.target === undefined || value.target === null ? '' : value.target).trim()
    const base = String(value.base === undefined || value.base === null ? '' : value.base).trim()
    const head = String(value.head === undefined || value.head === null ? '' : value.head).trim()
    if (id === '' || target === '' || base === '' || head === '') return failure('invalid-intent', 'id, target, base and head are required')
    const readResult = read()
    if (readResult.ok !== true) return readResult
    const key = keyOf({ id: id, base: base, head: head })
    const existing = readResult.entries.filter((entry) => entry.key === key)[0]
    if (existing !== undefined) return ok({ action: 'existing', intent: existing })
    const intent = {
      key: key,
      id: id,
      target: target,
      base: base,
      head: head,
      candidate: value.candidate === undefined ? null : value.candidate,
      mergeBranch: value.mergeBranch === undefined ? null : value.mergeBranch,
      integrationPath: value.integrationPath === undefined ? null : value.integrationPath,
      state: 'merging',
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      outcome: null,
    }
    const entries = readResult.entries.concat([intent])
    const finished = entries.filter((entry) => entry.state !== 'merging')
    while (entries.length > MAX_ENTRIES && finished.length > 0) {
      const oldest = finished.shift()
      const index = entries.indexOf(oldest)
      if (index >= 0) entries.splice(index, 1)
    }
    const written = write(entries)
    if (written.ok !== true) return written
    return ok({ action: 'started', intent: intent })
  }

  async function finish(key, outcome) {
    const readResult = read()
    if (readResult.ok !== true) return readResult
    const index = readResult.entries.findIndex((entry) => entry.key === String(key))
    if (index < 0) return failure('unknown-intent', 'no merge intent with key ' + String(key))
    const status = outcome !== null && outcome !== undefined && typeof outcome.status === 'string' ? outcome.status : 'failed'
    const entry = Object.assign({}, readResult.entries[index], {
      state: status,
      finishedAt: new Date(now()).toISOString(),
      outcome: outcome === undefined ? null : outcome,
    })
    const entries = readResult.entries.slice()
    entries[index] = entry
    const written = write(entries)
    if (written.ok !== true) return written
    return ok({ intent: entry })
  }

  function pending() {
    const readResult = read()
    if (readResult.ok !== true) return readResult
    return ok({ entries: readResult.entries.filter((entry) => entry.state === 'merging') })
  }

  function status() {
    const readResult = read()
    if (readResult.ok !== true) return readResult
    const counts = {}
    for (const entry of readResult.entries) counts[entry.state] = (counts[entry.state] || 0) + 1
    return ok({ total: readResult.entries.length, counts: counts, pending: readResult.entries.filter((entry) => entry.state === 'merging').length })
  }

  function planReconcile(input) {
    const value = input === undefined || input === null ? {} : input
    const targetHead = typeof value.targetHead === 'string' && value.targetHead !== '' ? value.targetHead : null
    const isAncestor = typeof value.isAncestor === 'function' ? value.isAncestor : null
    const readResult = read()
    if (readResult.ok !== true) return readResult
    const actions = []
    for (const entry of readResult.entries) {
      if (entry.state !== 'merging') continue
      if (targetHead === null) {
        actions.push({ action: 'unreadable', key: entry.key, id: entry.id })
        continue
      }
      if (entry.head === targetHead || (isAncestor !== null && isAncestor(entry.head, targetHead) === true)) {
        actions.push({ action: 'mark-merged', key: entry.key, id: entry.id, mergeCommit: targetHead })
        continue
      }
      if (targetHead === entry.base) {
        actions.push({ action: 'mark-abandoned', key: entry.key, id: entry.id })
        continue
      }
      actions.push({ action: 'mark-stale', key: entry.key, id: entry.id, currentHead: targetHead })
    }
    return ok({ actions: actions })
  }

  async function applyReconcile(plan) {
    const value = plan === undefined || plan === null ? {} : plan
    const actions = Array.isArray(value.actions) ? value.actions : []
    const results = []
    for (const action of actions) {
      if (action.action === 'mark-merged') {
        results.push(await finish(action.key, { status: 'merged', mergeCommit: action.mergeCommit }))
      } else if (action.action === 'mark-abandoned') {
        results.push(await finish(action.key, { status: 'abandoned' }))
      } else if (action.action === 'mark-stale') {
        results.push(await finish(action.key, { status: 'stale', currentHead: action.currentHead }))
      }
    }
    return ok({ results: results })
  }

  return { begin: begin, finish: finish, pending: pending, status: status, planReconcile: planReconcile, applyReconcile: applyReconcile, file: file }
}
