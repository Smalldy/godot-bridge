/**
 * Git plumbing — the handful of commands the task center needs to give a task
 * its own checkout: is this a repository, which branch is it on, put a worktree
 * on a branch, collect the files a branch changed, merge it back.
 *
 * Everything is written over ONE injected runner, `run(args, cwd)`, returning
 * `{ code, stdout, stderr }` (or a promise of one). Tests pass a fake runner and
 * never start a real git; the default runner is a thin child_process wrapper,
 * which a host that cannot pipe a child's stdio (a process sandbox refuses it)
 * can replace with its own unconfined runner. A git exit status is an expected
 * outcome, not an exception: every function answers `{ ok: true, ... }` or
 * `{ ok: false, code, message }` and none of them throws, so a caller can report
 * a refused command instead of crashing.
 *
 * The module owns no policy beyond path safety. A worktree path must stay
 * inside the repository root (a worktree elsewhere would escape the sandbox the
 * rest of the task center relies on), so an empty or escaping path is refused
 * before git is even asked.
 */

import { execFile } from 'node:child_process'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * The worktree-add budget. Creating a checkout is the one git call this module
 * makes that can legitimately run for minutes (a large repository, an antivirus
 * scan, a slow disk), so it must not share the short budget a read uses: a
 * generic 60 s runner timeout once killed a worktree add half-way and left a
 * registered, locked checkout behind. Callers may override it per call.
 */
export const DEFAULT_WORKTREE_TIMEOUT_MS = 180 * 1000

/** The production runner: one git process per call, never a shell. A per-call
 * `options.timeoutMs` bounds the child; a timed-out child is reported as a
 * failed command, never as an exception. */
function runGit(args, cwd, options) {
  const opts = options === undefined || options === null ? {} : options
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : undefined
  return new Promise((done) => {
    execFile(
      'git',
      args,
      timeoutMs === undefined
        ? { cwd: cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
        : { cwd: cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGTERM' },
      (error, stdout, stderr) => {
        const code = error === null || error === undefined ? 0 : typeof error.code === 'number' ? error.code : 1
        done({
          code: code,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : String(stderr === undefined || stderr === null ? '' : stderr),
        })
      },
    )
  })
}

function failure(code, message) {
  return { ok: false, code: code, message: message }
}

function ok(payload) {
  return Object.assign({ ok: true }, payload === undefined ? {} : payload)
}

function textOf(result) {
  const stderr = String(result.stderr === undefined || result.stderr === null ? '' : result.stderr).trim()
  const stdout = String(result.stdout === undefined || result.stdout === null ? '' : result.stdout).trim()
  return stderr === '' ? stdout : stderr
}

function outputOf(result) {
  const stdout = String(result.stdout === undefined || result.stdout === null ? '' : result.stdout)
  const stderr = String(result.stderr === undefined || result.stderr === null ? '' : result.stderr)
  return (stdout + '\n' + stderr).trim()
}

/** Wrap a failed git call, keeping git's own words in the message when it spoke. */
function failed(result, code, fallback) {
  const detail = textOf(result)
  return failure(code, detail === '' ? fallback : fallback + ': ' + detail)
}

/** A required repository root, resolved to an absolute path. */
function rootOf(root) {
  const raw = String(root === undefined || root === null ? '' : root).trim()
  if (raw === '') return failure('invalid-root', 'a repository root is required')
  return ok({ path: resolve(raw) })
}

/**
 * A path that must name a directory strictly inside the repository root.
 * Refuses empty input, null bytes and anything that resolves outside `rootPath`
 * (including `rootPath` itself, which is not a worktree).
 */
function insideRepo(rootPath, candidate, label) {
  const name = label === undefined ? 'a worktree path' : label
  const raw = String(candidate === undefined || candidate === null ? '' : candidate).trim()
  if (raw === '') return failure('invalid-path', name + ' is required')
  if (raw.indexOf('\u0000') >= 0) return failure('invalid-path', name + ' cannot contain a null byte')
  const absolute = resolve(rootPath, raw)
  const rel = relative(rootPath, absolute)
  if (rel === '' || rel === '.' || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith('../')) {
    return failure('outside-root', name + ' must be a subdirectory of ' + rootPath + ', got ' + raw)
  }
  return ok({ path: absolute })
}

/** A path that must be the root itself or a checkout inside it (a merge target). */
function checkoutOf(rootPath, candidate) {
  const raw = String(candidate === undefined || candidate === null ? '' : candidate).trim()
  if (raw === '') return failure('invalid-path', 'a merge target checkout is required')
  if (resolve(rootPath, raw) === rootPath) return ok({ path: rootPath })
  return insideRepo(rootPath, raw, 'the merge target checkout')
}

/** A branch name, not an empty string and not something git would read as an option. */
function branchName(value, label) {
  const name = label === undefined ? 'a branch' : label
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (raw === '' || raw.startsWith('-') || raw.indexOf('\u0000') >= 0) {
    return failure('invalid-branch', name + ' must be a name, not empty or an option')
  }
  return ok({ name: raw })
}

/** A revision-ish argument (a branch, tag or commit), with the same guards. */
function refName(value, label) {
  const name = label === undefined ? 'a ref' : label
  const raw = String(value === undefined || value === null ? '' : value).trim()
  if (raw === '' || raw.startsWith('-') || raw.indexOf('\u0000') >= 0) {
    return failure('invalid-ref', name + ' must be a ref, not empty or an option')
  }
  return ok({ name: raw })
}

/**
 * One worktree creation per repository at a time. Dispatch and the merge pipeline
 * both create checkouts; git contends for index.lock and a slow add can be killed
 * half-way (T-41 left a registered, locked checkout exactly that way). A
 * per-project promise chain keeps every add ordered without blocking unrelated
 * repositories. Shared here so merge.mjs reuses the SAME gate dispatch uses.
 */
const worktreeGates = new Map()

function noopGate() {
  return undefined
}

/** Run `work` after every earlier worktree creation for the same project. The
 * chain survives a rejection, so one failed add cannot poison the next. */
export function serialiseWorktreeCreate(projectPath, work) {
  const key = String(projectPath === undefined || projectPath === null ? '' : projectPath)
  const previous = worktreeGates.get(key)
  const start = previous === undefined ? Promise.resolve() : previous.then(noopGate, noopGate)
  const run = start.then(() => work())
  worktreeGates.set(key, run.then(noopGate, noopGate))
  return run
}

/**
 * @param options.run - the injected runner (`args, cwd -> { code, stdout, stderr }`,
 *   sync or async). Omitted, a real `git` process is used.
 */
export function createGit(options) {
  const opts = options === undefined ? {} : options
  const run = typeof opts.run === 'function' ? opts.run : runGit
  const worktreeTimeoutMs = Number.isFinite(opts.worktreeTimeoutMs) ? Math.max(1, Math.floor(opts.worktreeTimeoutMs)) : DEFAULT_WORKTREE_TIMEOUT_MS

  /** One git call, normalised. A runner that throws is a failed command, not an
   * exception the caller has to catch. `callOptions` is forwarded to the runner
   * so a slow operation can ask for its own budget. */
  async function exec(args, cwd, callOptions) {
    let raw
    try {
      raw = await run(args, cwd, callOptions)
    } catch (error) {
      return { code: 1, stdout: '', stderr: String((error && error.message) || error) }
    }
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      return { code: 1, stdout: '', stderr: 'the git runner returned no result' }
    }
    return {
      code: Number.isFinite(raw.code) ? Math.floor(raw.code) : 0,
      stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
      stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    }
  }

  /** Is `root` the top of (or inside) a git working tree? */
  async function isRepo(root) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const result = await exec(['rev-parse', '--is-inside-work-tree'], base.path)
    if (result.code !== 0) return ok({ repo: false })
    return ok({ repo: result.stdout.trim() === 'true' })
  }

  /** The commit HEAD points at. */
  async function head(root) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const result = await exec(['rev-parse', 'HEAD'], base.path)
    if (result.code !== 0) return failed(result, 'rev-parse-failed', 'HEAD could not be resolved')
    const hash = result.stdout.trim()
    if (hash === '') return failure('rev-parse-failed', 'HEAD could not be resolved: git printed no hash')
    return ok({ hash: hash })
  }

  /** The checked-out branch, or null when HEAD is detached. */
  async function currentBranch(root) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const result = await exec(['branch', '--show-current'], base.path)
    if (result.code !== 0) return failed(result, 'branch-failed', 'the current branch could not be read')
    const branch = result.stdout.trim()
    return ok({ branch: branch === '' ? null : branch })
  }

  /** True when the working tree has no staged, unstaged or untracked changes. */
  async function isClean(root) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const result = await exec(['status', '--porcelain'], base.path)
    if (result.code !== 0) return failed(result, 'status-failed', 'git status failed')
    return ok({ clean: result.stdout.trim() === '' })
  }

  /** Does a local branch with this name exist? */
  async function branchExists(root, name) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const branch = branchName(name)
    if (branch.ok !== true) return branch
    const result = await exec(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch.name], base.path)
    return ok({ exists: result.code === 0 })
  }

  /** Point an existing ref (e.g. refs/heads/main) at a commit without checking it out. */
  async function updateRef(root, ref, hash) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const target = refName(ref)
    if (target.ok !== true) return target
    const commit = typeof hash === 'string' ? hash.trim() : ''
    if (commit === '') return failure('invalid-commit', 'update-ref needs a commit hash')
    const result = await exec(['update-ref', target.name, commit], base.path)
    if (result.code !== 0) return failed(result, 'update-ref-failed', 'could not move ' + target.name + ' to ' + commit)
    return ok({ ref: target.name, hash: commit })
  }

  /** Resolve a ref to a full commit hash. */
  async function revParse(root, ref) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const target = refName(ref)
    if (target.ok !== true) return target
    const result = await exec(['rev-parse', '--verify', target.name], base.path)
    if (result.code !== 0) return failed(result, 'unknown-ref', target.name + ' is not a ref this repository knows')
    const hash = result.stdout.trim()
    if (hash === '') return failure('unknown-ref', target.name + ' is not a ref this repository knows')
    return ok({ hash: hash })
  }

  /**
   * Add a worktree and ALWAYS create its branch: `-b <branch>` from `base`, or
   * from HEAD when no base is given. It never silently checks out an existing
   * branch, so a caller that wants a fresh checkout cannot accidentally share
   * one. Returns the absolute worktree path.
   */
  async function worktreeAdd(root, input) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const source = input === undefined || input === null ? {} : input
    const target = insideRepo(base.path, source.path)
    if (target.ok !== true) return target
    const branch = branchName(source.branch, 'the worktree branch')
    if (branch.ok !== true) return branch
    const args = ['worktree', 'add', '-b', branch.name, target.path]
    let from = null
    if (source.base !== undefined && source.base !== null && String(source.base).trim() !== '') {
      const ref = refName(source.base, 'the worktree base')
      if (ref.ok !== true) return ref
      from = ref.name
      args.push(from)
    }
    const timeoutMs = Number.isFinite(source.timeoutMs) ? Math.max(1, Math.floor(source.timeoutMs)) : worktreeTimeoutMs
    const result = await exec(args, base.path, { op: 'worktree-add', timeoutMs: timeoutMs })
    if (result.code !== 0) {
      return failed(result, 'worktree-add-failed', 'git worktree add failed (budget ' + String(timeoutMs) + 'ms)')
    }
    return ok({ path: target.path, branch: branch.name, base: from, timeoutMs: timeoutMs })
  }

  /** Remove one worktree; `force` also discards local changes in it. */
  async function worktreeRemove(root, path, options) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const target = insideRepo(base.path, path)
    if (target.ok !== true) return target
    const force = options !== undefined && options !== null && options.force === true
    const args = ['worktree', 'remove']
    if (force) args.push('--force')
    args.push(target.path)
    const result = await exec(args, base.path)
    if (result.code !== 0) return failed(result, 'worktree-remove-failed', 'git worktree remove failed')
    return ok({ path: target.path, force: force })
  }

  /**
   * Unlock one worktree. A rollback has to unlock before it can remove: git
   * registers a worktree as locked when an add was interrupted, and
   * `worktree remove` then refuses ("is locked"). "Not locked" is success for a
   * rollback, so it is reported as `unlocked: false` instead of an error.
   */
  async function worktreeUnlock(root, path) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const target = insideRepo(base.path, path)
    if (target.ok !== true) return target
    const result = await exec(['worktree', 'unlock', target.path], base.path)
    if (result.code !== 0) {
      const detail = outputOf(result)
      if (/not locked/i.test(detail)) return ok({ path: target.path, unlocked: false })
      return failed(result, 'worktree-unlock-failed', 'git worktree unlock failed')
    }
    return ok({ path: target.path, unlocked: true })
  }

  /** Drop stale administrative entries (`.git/worktrees/<name>`) for worktrees
   * whose directory is gone. Never fatal: a prune failure only leaves metadata. */
  async function worktreePrune(root) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const result = await exec(['worktree', 'prune', '-v'], base.path)
    if (result.code !== 0) return failed(result, 'worktree-prune-failed', 'git worktree prune failed')
    const pruned = outputOf(result)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    return ok({ pruned: pruned })
  }

  /** Every worktree git knows about, parsed from `worktree list --porcelain`. */
  async function worktreeList(root) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const result = await exec(['worktree', 'list', '--porcelain'], base.path)
    if (result.code !== 0) return failed(result, 'worktree-list-failed', 'git worktree list failed')
    const worktrees = []
    let entry = null
    const flush = () => {
      if (entry !== null) worktrees.push(entry)
      entry = null
    }
    for (const line of result.stdout.split(/\r?\n/)) {
      if (line.trim() === '') {
        flush()
        continue
      }
      const space = line.indexOf(' ')
      const key = space < 0 ? line : line.slice(0, space)
      const value = space < 0 ? '' : line.slice(space + 1)
      if (key === 'worktree') {
        flush()
        entry = { path: value, head: null, branch: null }
        continue
      }
      if (entry === null) continue
      if (key === 'HEAD') entry.head = value
      else if (key === 'branch') entry.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
      else if (key === 'detached') entry.branch = null
    }
    flush()
    return ok({ worktrees: worktrees })
  }

  /** Stage everything (`add -A`) and commit it, returning the new commit hash. */
  async function commitAll(root, message) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const text = String(message === undefined || message === null ? '' : message).trim()
    if (text === '') return failure('invalid-message', 'a commit message is required')
    const added = await exec(['add', '-A'], base.path)
    if (added.code !== 0) return failed(added, 'add-failed', 'git add -A failed')
    const committed = await exec(['commit', '-m', text], base.path)
    if (committed.code !== 0) {
      if (/nothing to commit|no changes added|working tree clean/i.test(outputOf(committed))) {
        return failure('nothing-to-commit', 'there were no changes to commit')
      }
      return failed(committed, 'commit-failed', 'git commit failed')
    }
    const resolved = await exec(['rev-parse', 'HEAD'], base.path)
    if (resolved.code !== 0) return failed(resolved, 'rev-parse-failed', 'the new commit hash could not be read')
    const hash = resolved.stdout.trim()
    if (hash === '') return failure('rev-parse-failed', 'the new commit hash could not be read')
    return ok({ hash: hash, message: text })
  }

  /** The files that differ between two revisions, as project-relative paths. */
  async function diffNameOnly(root, from, to) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const left = refName(from, 'the diff base')
    if (left.ok !== true) return left
    const right = refName(to, 'the diff head')
    if (right.ok !== true) return right
    const result = await exec(['diff', '--name-only', left.name, right.name], base.path)
    if (result.code !== 0) return failed(result, 'diff-failed', 'git diff failed')
    const files = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    return ok({ files: files })
  }

  /**
   * Merge `branch` into the checkout at `target` with `--no-ff`, so the merge
   * is a real commit even when it could have fast-forwarded. A conflict is
   * reported (`merge-conflict`) and left in place for `mergeAbort`.
   */
  async function mergeNoFf(root, target, branch) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const checkout = checkoutOf(base.path, target)
    if (checkout.ok !== true) return checkout
    const merged = branchName(branch, 'the branch to merge')
    if (merged.ok !== true) return merged
    const result = await exec(['merge', '--no-ff', '--no-edit', merged.name], checkout.path)
    if (result.code !== 0) {
      if (/CONFLICT|Automatic merge failed|fix conflicts/i.test(outputOf(result))) {
        return failure('merge-conflict', 'merging ' + merged.name + ' into ' + checkout.path + ' hit a conflict')
      }
      return failed(result, 'merge-failed', 'git merge failed')
    }
    return ok({ branch: merged.name, target: checkout.path })
  }

  /** Abort the merge currently in progress in `root`. */
  async function mergeAbort(root) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const result = await exec(['merge', '--abort'], base.path)
    if (result.code !== 0) return failed(result, 'merge-abort-failed', 'there was no merge to abort')
    return ok({ aborted: true })
  }

  /**
   * Fast-forward `root` to `branch` (`merge --ff-only`). Used only on the main
   * checkout: it can never rewrite history, and it refuses when the worktree is
   * dirty or the branch has diverged.
   */
  async function mergeFfOnly(root, branch) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const merged = branchName(branch, 'the branch to fast-forward to')
    if (merged.ok !== true) return merged
    const result = await exec(['merge', '--ff-only', merged.name], base.path)
    if (result.code !== 0) return failed(result, 'merge-fast-forward-failed', 'git merge --ff-only failed')
    return ok({ branch: merged.name })
  }

  /** Discard the working-tree state of a THROWAWAY checkout (`reset --hard HEAD`). */
  async function resetHard(root) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const result = await exec(['reset', '--hard', 'HEAD'], base.path)
    if (result.code !== 0) return failed(result, 'reset-failed', 'git reset --hard failed')
    return ok({ reset: true })
  }

  /** Delete one local branch; `force` uses -D (a throwaway integration branch). */
  async function deleteBranch(root, name, options) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const branch = branchName(name, 'the branch to delete')
    if (branch.ok !== true) return branch
    const force = options !== undefined && options !== null && options.force === true
    const result = await exec(['branch', force ? '-D' : '-d', branch.name], base.path)
    if (result.code !== 0) return failed(result, 'branch-delete-failed', 'git branch ' + (force ? '-D' : '-d') + ' failed')
    return ok({ branch: branch.name, force: force })
  }

  /** The files git could not merge automatically in a conflicted checkout. */
  async function conflictedFiles(root) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const result = await exec(['diff', '--name-only', '--diff-filter=U'], base.path)
    if (result.code !== 0) return failed(result, 'conflict-list-failed', 'git could not list conflicted files')
    const files = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    return ok({ files: files })
  }

  /** Rebase the current branch onto `onto`; a conflict is left for the caller. */
  async function rebaseOnto(root, onto) {
    const base = rootOf(root)
    if (base.ok !== true) return base
    const target = refName(onto, 'the rebase target')
    if (target.ok !== true) return target
    const result = await exec(['rebase', target.name], base.path)
    if (result.code !== 0) {
      if (/CONFLICT|could not apply|Resolve all conflicts/i.test(outputOf(result))) {
        return failure('rebase-conflict', 'rebasing onto ' + target.name + ' hit a conflict')
      }
      return failed(result, 'rebase-failed', 'git rebase failed')
    }
    return ok({ onto: target.name })
  }

  /** Run a raw git command in the project (preflight probes use this). */
  async function raw(root, args) {
    const base = await rootOf(root)
    if (base.ok !== true) return { ok: false, code: 'bad-root', message: base.message }
    const result = await exec(args, base.path)
    return { ok: result.code === 0, code: result.code, stdout: result.stdout, stderr: result.stderr }
  }

  /** The path of a git-internal file, resolved by git itself. */
  async function gitPath(root, name) {
    const result = await raw(root, ['rev-parse', '--git-path', name])
    if (result.ok !== true) return failed(result, 'git-path-failed', 'git rev-parse --git-path failed')
    return ok({ path: String(result.stdout).trim() })
  }

  /** Which of the given paths git treats as ignored. */
  async function checkIgnore(root, paths) {
    const list = Array.isArray(paths) ? paths.filter((entry) => typeof entry === 'string' && entry.length > 0) : []
    if (list.length === 0) return ok({ ignored: [], notIgnored: [] })
    const result = await raw(root, ['check-ignore', '--', ...list])
    // Exit 1 means "none ignored"; that is not a failure of the probe.
    if (result.ok !== true && result.code !== 1) return failed(result, 'check-ignore-failed', 'git check-ignore failed')
    const ignored = String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
    return ok({ ignored: ignored, notIgnored: list.filter((entry) => ignored.indexOf(entry) < 0) })
  }

  return {
    isRepo: isRepo,
    raw: raw,
    gitPath: gitPath,
    checkIgnore: checkIgnore,
    head: head,
    currentBranch: currentBranch,
    isClean: isClean,
    branchExists: branchExists,
    revParse: revParse,
    updateRef: updateRef,
    worktreeAdd: worktreeAdd,
    worktreeRemove: worktreeRemove,
    worktreeList: worktreeList,
    worktreeUnlock: worktreeUnlock,
    worktreePrune: worktreePrune,
    commitAll: commitAll,
    diffNameOnly: diffNameOnly,
    mergeNoFf: mergeNoFf,
    mergeAbort: mergeAbort,
    mergeFfOnly: mergeFfOnly,
    resetHard: resetHard,
    deleteBranch: deleteBranch,
    conflictedFiles: conflictedFiles,
    rebaseOnto: rebaseOnto,
  }
}
