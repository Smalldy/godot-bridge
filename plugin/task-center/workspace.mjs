/**
 * Workspace reconciliation for the task center.
 *
 * The first production incident was a stale .git/index.lock: every merge unit
 * failed, the sweep only counted a skip, and the requests stayed open. The
 * doctor reports that state; this module turns it into an explicit, safe plan.
 *
 * It is deliberately conservative:
 *   - it never deletes anything;
 *   - it only renames a lock when the lock is older than the threshold, no
 *     merge/rebase state exists, AND an injected process checker says no git
 *     process is running;
 *   - an unknown process state is reported as manual-check, not auto-recovered.
 *
 * The process checker is injected because the task center must not guess at OS
 * process ownership. A host that can inspect processes supplies the checker; a
 * host that cannot leaves it null and a human decides.
 */
import { renameSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

export const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000

function fileState(path, fs, now) {
  const state = { path: path, exists: false, size: null, mtimeMs: null, ageMs: null, error: null }
  try {
    const stat = fs.statSync(path)
    state.exists = true
    state.size = stat.size
    state.mtimeMs = stat.mtimeMs
    state.ageMs = Math.max(0, now - stat.mtimeMs)
  } catch (error) {
    if (error !== null && error !== undefined && error.code !== 'ENOENT') state.error = String(error.message || error)
  }
  return state
}

export function createWorkspaceReconciler(options) {
  const opts = options === undefined || options === null ? {} : options
  const git = opts.git === undefined ? null : opts.git
  const fs = opts.fs === undefined ? { statSync: statSync, renameSync: renameSync } : opts.fs
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const staleLockMs = Number.isFinite(opts.staleLockMs) ? Math.max(1, Math.floor(opts.staleLockMs)) : DEFAULT_STALE_LOCK_MS
  const processChecker = typeof opts.processChecker === 'function' ? opts.processChecker : null

  async function locate(project, name) {
    if (git === null || typeof git.gitPath !== 'function') return { ok: false, path: null, error: 'the git service does not provide gitPath' }
    try {
      const result = await git.gitPath(project, name)
      if (result === null || result === undefined || result.ok !== true) {
        return { ok: false, path: null, error: result === null || result === undefined ? 'gitPath returned no result' : String(result.message || 'gitPath failed') }
      }
      return { ok: true, path: resolve(project, String(result.path)), error: null }
    } catch (error) {
      return { ok: false, path: null, error: String((error && error.message) || error) }
    }
  }

  async function processState() {
    if (processChecker === null) return { running: null, detail: 'no process checker is configured' }
    try {
      const value = await processChecker()
      if (value === true || value === false) return { running: value, detail: null }
      if (value !== null && value !== undefined && typeof value === 'object') {
        return { running: value.running === true ? true : value.running === false ? false : null, detail: value.detail === undefined ? null : String(value.detail) }
      }
      return { running: null, detail: 'the process checker returned an unknown value' }
    } catch (error) {
      return { running: null, detail: String((error && error.message) || error) }
    }
  }

  async function mergeState(project) {
    const names = ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']
    const states = {}
    for (const name of names) {
      const located = await locate(project, name)
      states[name] = located.ok === true ? fileState(located.path, fs, now()) : { path: null, exists: false, error: located.error }
    }
    return {
      inProgress: states.MERGE_HEAD.exists === true || states['rebase-merge'].exists === true || states['rebase-apply'].exists === true,
      entries: states,
    }
  }

  async function plan(projectPath) {
    const project = String(projectPath === undefined || projectPath === null ? '' : projectPath).trim()
    const result = {
      ok: true,
      project: project === '' ? null : resolve(project),
      checkedAt: new Date(now()).toISOString(),
      staleLockMs: staleLockMs,
      lock: null,
      merge: null,
      process: null,
      action: 'none',
      reasons: [],
    }
    if (project === '') {
      result.ok = false
      result.action = 'blocked'
      result.reasons.push('no project path was supplied')
      return result
    }
    const located = await locate(project, 'index.lock')
    if (located.ok !== true) {
      result.ok = false
      result.action = 'blocked'
      result.reasons.push('could not locate index.lock: ' + located.error)
      return result
    }
    result.lock = fileState(located.path, fs, now())
    result.lock.suspectedStale = result.lock.exists === true && result.lock.ageMs !== null && result.lock.ageMs >= staleLockMs
    result.merge = await mergeState(project)
    result.process = await processState()

    if (result.lock.exists !== true) {
      result.action = 'none'
      return result
    }
    if (result.merge.inProgress === true) {
      result.action = 'blocked'
      result.reasons.push('a merge/rebase is in progress; do not touch the lock')
      return result
    }
    if (result.lock.ageMs !== null && result.lock.ageMs < staleLockMs) {
      result.action = 'inspect'
      result.reasons.push('the lock is younger than ' + String(staleLockMs) + 'ms; a git process may still be writing')
      return result
    }
    if (result.process.running !== false) {
      result.action = 'manual-check'
      result.reasons.push(result.process.running === true ? 'a git process may hold the lock' : 'the process state is unknown: ' + String(result.process.detail || 'no checker'))
      return result
    }
    result.action = 'remove-stale-index-lock'
    result.reasons.push('the lock is stale, no merge/rebase is active, and the process checker reports no git process')
    return result
  }

  async function apply(planValue) {
    const plan = planValue === null || planValue === undefined ? null : planValue
    if (plan === null || plan === undefined || plan.ok !== true) return { ok: false, code: 'invalid-plan', message: 'a successful plan is required' }
    if (plan.action === 'none') return { ok: true, action: 'none' }
    if (plan.action !== 'remove-stale-index-lock') {
      return { ok: false, code: 'not-recoverable', message: 'action ' + String(plan.action) + ' is not auto-recoverable' }
    }
    if (plan.project === null || plan.lock === null || plan.lock.path === null) return { ok: false, code: 'invalid-plan', message: 'the plan has no project/lock path' }

    // Re-read before acting: a fresh git process may have started after plan().
    const current = fileState(plan.lock.path, fs, now())
    if (current.exists !== true) return { ok: true, action: 'already-gone' }
    if (current.ageMs !== null && current.ageMs < staleLockMs) return { ok: false, code: 'lock-fresh', message: 'the lock became fresh; refusing to rename it' }
    const merge = await mergeState(plan.project)
    if (merge.inProgress === true) return { ok: false, code: 'merge-in-progress', message: 'a merge/rebase is now in progress; refusing to rename the lock' }
    const process = await processState()
    if (process.running !== false) return { ok: false, code: 'process-may-hold-lock', message: process.running === true ? 'a git process may hold the lock' : 'the process state is unknown' }

    const target = plan.lock.path + '.stale-' + String(now())
    try {
      fs.renameSync(plan.lock.path, target)
    } catch (error) {
      return { ok: false, code: 'rename-failed', message: String((error && error.message) || error) }
    }
    return { ok: true, action: 'renamed', from: plan.lock.path, to: target }
  }

  return { plan: plan, apply: apply, staleLockMs: staleLockMs }
}
