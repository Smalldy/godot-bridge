/**
 * Read-only workspace doctor for the task center.
 *
 * The doctor never repairs anything. It reports what a human or the host needs
 * to decide: is this a git repository, is there an index.lock/MERGE_HEAD, how
 * old is the lock, what does the worktree list look like, and what is the merge
 * queue doing. In particular, a stale .git/index.lock is the failure mode that
 * made two tested tasks sit in "open" while every merge unit failed.
 */
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000

function check(id, status, detail, extra) {
  return Object.assign({ id: id, status: status, detail: detail }, extra === undefined ? {} : extra)
}

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

export function createDoctor(options) {
  const opts = options === undefined || options === null ? {} : options
  const git = opts.git === undefined ? null : opts.git
  const fs = opts.fs === undefined ? { existsSync: existsSync, statSync: statSync } : opts.fs
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const staleLockMs = Number.isFinite(opts.staleLockMs) ? Math.max(1, Math.floor(opts.staleLockMs)) : DEFAULT_STALE_LOCK_MS
  const merger = opts.merger === undefined ? null : opts.merger

  async function pathOf(project, name) {
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

  async function inspect(projectPath) {
    const project = String(projectPath === undefined || projectPath === null ? '' : projectPath).trim()
    const result = {
      ok: true,
      project: project === '' ? null : resolve(project),
      checkedAt: new Date(now()).toISOString(),
      git: null,
      locks: {},
      worktrees: null,
      merge: null,
      checks: [],
    }
    if (project === '') {
      result.ok = false
      result.checks.push(check('project', 'fail', 'no project path was supplied'))
      return result
    }
    if (git === null) {
      result.checks.push(check('git-service', 'fail', 'no git facade is available'))
      return result
    }

    const repo = await git.isRepo(project)
    const branch = await git.currentBranch(project)
    const head = await git.head(project)
    const clean = await git.isClean(project)
    result.git = {
      repo: repo !== null && repo !== undefined && repo.ok === true && repo.repo === true,
      branch: branch !== null && branch !== undefined && branch.ok === true ? branch.branch : null,
      head: head !== null && head !== undefined && head.ok === true ? head.hash : null,
      clean: clean !== null && clean !== undefined && clean.ok === true ? clean.clean === true : null,
    }
    if (result.git.repo !== true) {
      result.checks.push(check('git-repo', 'fail', 'the project is not a readable git worktree'))
    } else {
      result.checks.push(check('git-repo', 'ok', 'git worktree readable'))
    }

    for (const name of ['index.lock', 'MERGE_HEAD', 'rebase-merge', 'rebase-apply']) {
      const located = await pathOf(project, name)
      const state = located.ok === true ? fileState(located.path, fs, now()) : { path: null, exists: false, error: located.error }
      if (name === 'index.lock') {
        state.suspectedStale = state.exists === true && state.ageMs !== null && state.ageMs >= staleLockMs
        state.staleAfterMs = staleLockMs
      }
      result.locks[name] = state
    }

    const index = result.locks['index.lock']
    if (index.error !== null && index.error !== undefined) {
      result.checks.push(check('index-lock', 'warn', 'could not inspect index.lock: ' + index.error))
    } else if (index.exists !== true) {
      result.checks.push(check('index-lock', 'ok', 'no index.lock'))
    } else {
      result.checks.push(
        check('index-lock', 'warn', 'index.lock exists for ' + String(index.ageMs) + 'ms' + (index.suspectedStale === true ? ' (suspected stale)' : ' (a git process may be writing)'), {
          ageMs: index.ageMs,
          suspectedStale: index.suspectedStale === true,
        }),
      )
    }

    const mergeHead = result.locks['MERGE_HEAD']
    const rebaseMerge = result.locks['rebase-merge']
    const rebaseApply = result.locks['rebase-apply']
    const inMerge = mergeHead.exists === true || rebaseMerge.exists === true || rebaseApply.exists === true
    result.checks.push(inMerge ? check('merge-state', 'warn', 'a merge/rebase is in progress (MERGE_HEAD or rebase state present)') : check('merge-state', 'ok', 'no merge/rebase state'))

    const worktrees = await git.worktreeList(project)
    if (worktrees === null || worktrees === undefined || worktrees.ok !== true) {
      result.worktrees = { ok: false, error: worktrees === null || worktrees === undefined ? 'worktree list returned no result' : String(worktrees.message || 'worktree list failed') }
      result.checks.push(check('worktrees', 'warn', 'worktree list failed: ' + result.worktrees.error))
    } else {
      const entries = Array.isArray(worktrees.worktrees) ? worktrees.worktrees : []
      result.worktrees = {
        ok: true,
        count: entries.length,
        entries: entries.map(function (entry) {
          return { path: entry.path, branch: entry.branch === undefined ? null : entry.branch, head: entry.head === undefined ? null : entry.head }
        }),
      }
      result.checks.push(check('worktrees', 'ok', String(entries.length) + ' worktree(s) registered'))
    }

    if (clean !== null && clean !== undefined && clean.ok === true) {
      result.checks.push(clean.clean === true ? check('working-tree', 'ok', 'working tree clean') : check('working-tree', 'warn', 'working tree has uncommitted changes'))
    } else {
      result.checks.push(check('working-tree', 'warn', 'working tree state could not be read'))
    }

    if (merger !== null && typeof merger.status === 'function') {
      try {
        result.merge = merger.status()
      } catch (error) {
        result.merge = { error: String((error && error.message) || error) }
      }
      const last = result.merge === null || result.merge === undefined ? null : result.merge.last
      if (last !== null && last !== undefined && last.ok === false) {
        result.checks.push(check('merge-queue', 'warn', 'the last merge unit failed: ' + String(last.code || 'unknown') + ' — ' + String(last.message || ''), { last: last }))
      } else {
        result.checks.push(check('merge-queue', 'ok', 'merge queue has no recorded failure'))
      }
    }

    result.status = result.checks.some((entry) => entry.status === 'fail') ? 'fail' : result.checks.some((entry) => entry.status === 'warn') ? 'warn' : 'ok'
    return result
  }

  return { inspect: inspect, staleLockMs: staleLockMs }
}
