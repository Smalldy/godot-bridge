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

/** The production runner: one git process per call, never a shell. */
function runGit(args, cwd) {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd: cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
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
 * @param options.run - the injected runner (`args, cwd -> { code, stdout, stderr }`,
 *   sync or async). Omitted, a real `git` process is used.
 */
export function createGit(options) {
  const opts = options === undefined ? {} : options
  const run = typeof opts.run === 'function' ? opts.run : runGit

  /** One git call, normalised. A runner that throws is a failed command, not an
   * exception the caller has to catch. */
  async function exec(args, cwd) {
    let raw
    try {
      raw = await run(args, cwd)
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
    const result = await exec(args, base.path)
    if (result.code !== 0) return failed(result, 'worktree-add-failed', 'git worktree add failed')
    return ok({ path: target.path, branch: branch.name, base: from })
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

  return {
    isRepo: isRepo,
    head: head,
    currentBranch: currentBranch,
    isClean: isClean,
    branchExists: branchExists,
    revParse: revParse,
    worktreeAdd: worktreeAdd,
    worktreeRemove: worktreeRemove,
    worktreeList: worktreeList,
    commitAll: commitAll,
    diffNameOnly: diffNameOnly,
    mergeNoFf: mergeNoFf,
    mergeAbort: mergeAbort,
    rebaseOnto: rebaseOnto,
  }
}
