#!/usr/bin/env node
/**
 * Target-branch history guard. Run it in CI and before a release:
 * `npm run check:target` (or `node scripts/check-target-history.mjs --target <ref>`).
 *
 * The task center is the only way work reaches the protected target branch. Every
 * non-merge commit there must be explainable by one of:
 *
 *   1. a merge of a task/test/merge branch ("Merge branch 'task/T-36-3' into
 *      test/T-36"), i.e. the commit arrived on the side of that merge;
 *   2. a task in <project>/.agents/tasks.json that is done AND merged, whose
 *      recorded commit is that commit (the board is the second opinion);
 *   3. an explicitly recorded emergency exception (EMERGENCY_EXCEPTIONS) — an
 *      out-of-band hotfix later covered by a retro task card and a CHANGELOG
 *      entry.
 *
 * History before LEGACY_UP_TO predates this policy and is reported as skipped,
 * never silently "fixed": the guard protects every commit AFTER that point.
 *
 * Exit codes: 0 = traceable (or target ref absent), 1 = untraceable commits,
 * 2 = usage error.
 *
 * Note on process spawning: git's output is captured through a temporary file
 * rather than a pipe. A piped child stdio is unavailable in some confined
 * environments (and the file form works everywhere), so the guard does not
 * depend on how the caller is sandboxed.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** The protected target. Overridable with --target or TASK_CENTER_TARGET. */
export const DEFAULT_TARGET = 'feat/task-center-v2'

/** Commits reachable from here predate the merge policy. 49b0909 is the last
 * direct commit that landed on the target before the task/test merge rule; every
 * later commit either arrives through a task/test merge or is an explicit
 * exception. This constant is frozen history, NOT a switch to relax the guard. */
export const LEGACY_UP_TO = '49b09095513b1297649e0743d9aa837e20a9b5f3'

/** Branches whose merges make their side commits traceable. */
const TRACED_BRANCH = /^(task|test|merge)\//

/**
 * Emergency exceptions: out-of-band hotfixes that reached the target without a
 * task/test merge. Each entry names WHY it was allowed and which task cards cover
 * it; CHANGELOG.md records the same hashes. Adding an entry without a retro task
 * card is exactly what this guard exists to prevent.
 */
export const EMERGENCY_EXCEPTIONS = [
  {
    commit: '2c895b4eb95c4435d0df03365205870f006ae07b',
    merge: '1695506688b8650bd10dd4eb09fbc1b392044885',
    branch: 'hotfix/merge-queue',
    reason: 'idempotent candidate merge + bounded git subprocesses (stuck merge queue, unbounded waits)',
    tasks: ['T-30', 'T-38'],
  },
]

/** Run git and return { ok, status, text }. Output goes through a temp FILE, not a
 * pipe, so this works in confined environments too. */
export function captureGit(cwd, args, env) {
  const directory = mkdtempSync(join(tmpdir(), 'target-history-'))
  const output = join(directory, 'out.txt')
  let fd
  try {
    fd = openSync(output, 'w')
    try {
      execFileSync('git', args, {
        cwd,
        stdio: ['ignore', fd, fd],
        env: env === undefined ? process.env : Object.assign({}, process.env, env),
      })
      return { ok: true, status: 0, text: readFileSync(output, 'utf8') }
    } catch (error) {
      const status = typeof error.status === 'number' ? error.status : 1
      return { ok: false, status, text: readFileSync(output, 'utf8') }
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Run git, throwing a readable error on failure. Returns trimmed stdout. */
export function runGit(cwd, args, env) {
  const result = captureGit(cwd, args, env)
  if (result.ok !== true) {
    const error = new Error('git ' + args.join(' ') + ' failed (' + String(result.status) + '): ' + result.text.trim())
    error.status = result.status
    error.stdout = result.text
    throw error
  }
  return result.text.trim()
}

function gitLines(cwd, args) {
  const text = runGit(cwd, args)
  return text === '' ? [] : text.split('\n')
}

function refExists(cwd, ref) {
  return captureGit(cwd, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']).ok === true
}

/** Where the board lives: the MAIN project root, also when run from a worktree. */
export function projectRootOf(cwd) {
  const result = captureGit(cwd, ['rev-parse', '--git-common-dir'])
  if (result.ok !== true) return cwd
  return dirname(resolve(cwd, result.text.trim()))
}

/** The branch named by a merge subject, or null. */
export function mergedBranchOf(subject) {
  const text = String(subject === undefined || subject === null ? '' : subject)
  const branch = /^Merge branch '([^']+)'/.exec(text)
  if (branch !== null) return branch[1]
  const plain = /^Merge ((?:task|test|merge|hotfix)\/[^\s:]+)/.exec(text)
  return plain === null ? null : plain[1]
}

/** Full commit hashes the merged board says are integrated. */
export function boardCommits(project) {
  const file = join(project, '.agents', 'tasks.json')
  if (!existsSync(file)) return []
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return []
  }
  const commits = []
  const tasks = parsed !== null && Array.isArray(parsed.tasks) ? parsed.tasks : []
  for (const task of tasks) {
    if (task === null || typeof task !== 'object') continue
    if (task.status !== 'done') continue
    const merge = task.merge
    if (merge === null || typeof merge !== 'object' || merge.status !== 'merged') continue
    for (const value of [task.commit, merge.head, merge.commit]) {
      if (typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value)) {
        const hash = value.toLowerCase()
        if (commits.indexOf(hash) < 0) commits.push(hash)
      }
    }
  }
  return commits
}

/**
 * The verdict. Returns:
 *   { ok, skipped?, target, project, checked, merges, legacySkipped, exceptions,
 *     declaredExceptions, viaBoard, untraceable: [{ hash, subject }] }
 * A missing target ref is reported as skipped (a shallow CI checkout must not
 * fail), and the repository is never mutated.
 */
export function checkTargetHistory(options = {}) {
  const cwd = options.cwd === undefined ? process.cwd() : options.cwd
  const target = options.target === undefined ? process.env.TASK_CENTER_TARGET || DEFAULT_TARGET : options.target
  const project = options.project === undefined ? projectRootOf(cwd) : options.project
  const legacy = options.legacy === undefined ? LEGACY_UP_TO : options.legacy
  const extra = Array.isArray(options.exceptions) ? options.exceptions : []
  const exceptions = EMERGENCY_EXCEPTIONS.concat(
    extra.map((entry) => ({ commit: String(entry).toLowerCase(), reason: 'declared with --exception', tasks: [] })),
  )

  if (!refExists(cwd, target)) {
    return {
      ok: true,
      skipped: 'unknown-target',
      target,
      project,
      checked: 0,
      merges: [],
      legacySkipped: 0,
      exceptions: 0,
      declaredExceptions: exceptions,
      viaBoard: 0,
      untraceable: [],
    }
  }

  // 1. Every commit a task/test/merge merge brought in is traceable.
  const traceable = new Set()
  const merges = []
  for (const line of gitLines(cwd, ['log', '--merges', '--format=%H%x1f%P%x1f%s', target])) {
    const parts = line.split('\x1f')
    if (parts.length < 3) continue
    const hash = parts[0]
    const parents = parts[1].split(' ').filter((value) => value !== '')
    const subject = parts.slice(2).join('\x1f')
    const branch = mergedBranchOf(subject)
    const traced = branch !== null && TRACED_BRANCH.test(branch) && parents.length >= 2
    if (traced) {
      for (const side of gitLines(cwd, ['rev-list', parents[1], '--not', parents[0]])) traceable.add(side)
    }
    merges.push({ hash, subject, branch, traced })
  }

  // 2. Board-recorded done+merged commits, the frozen legacy range, exceptions.
  const board = boardCommits(project)
  const legacySet = legacy !== null && legacy !== '' && refExists(cwd, legacy) ? new Set(gitLines(cwd, ['rev-list', legacy])) : new Set()
  const exceptionByHash = new Map(exceptions.map((entry) => [entry.commit, entry]))

  let checked = 0
  let legacySkipped = 0
  let viaBoard = 0
  let viaException = 0
  const untraceable = []
  for (const line of gitLines(cwd, ['log', '--no-merges', '--format=%H%x1f%s', target])) {
    const parts = line.split('\x1f')
    if (parts.length < 2) continue
    const hash = parts[0]
    const subject = parts.slice(1).join('\x1f')
    checked += 1
    if (traceable.has(hash)) continue
    if (exceptionByHash.has(hash)) {
      viaException += 1
      continue
    }
    if (board.some((entry) => hash.toLowerCase().startsWith(entry))) {
      viaBoard += 1
      continue
    }
    if (legacySet.has(hash)) {
      legacySkipped += 1
      continue
    }
    untraceable.push({ hash, subject })
  }

  return {
    ok: untraceable.length === 0,
    target,
    project,
    checked,
    merges,
    legacySkipped,
    exceptions: viaException,
    declaredExceptions: exceptions,
    viaBoard,
    untraceable,
  }
}

function parseArgs(argv) {
  const options = { exceptions: [], json: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--target') {
      options.target = next
      index += 1
    } else if (arg === '--project') {
      options.project = next
      index += 1
    } else if (arg === '--cwd') {
      options.cwd = next
      index += 1
    } else if (arg === '--legacy') {
      options.legacy = next
      index += 1
    } else if (arg === '--exception') {
      if (next !== undefined) options.exceptions.push(next)
      index += 1
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      options.unknown = arg
    }
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('usage: node scripts/check-target-history.mjs [--target <ref>] [--project <dir>] [--cwd <dir>] [--legacy <commit>] [--exception <commit>] [--json]')
    return 0
  }
  if (options.unknown !== undefined) {
    console.error('unknown argument: ' + options.unknown)
    return 2
  }
  const result = checkTargetHistory(options)
  if (options.json === true) {
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 1
  }
  if (result.skipped === 'unknown-target') {
    console.log('! target ' + result.target + ' is not present in this repository; nothing to check')
    return 0
  }
  const mergeCount = result.merges.filter((entry) => entry.traced === true).length
  if (result.ok === true) {
    console.log(
      '✔ target history traceable: ' +
        result.target +
        ' — ' +
        String(result.checked) +
        ' commits checked, ' +
        String(mergeCount) +
        ' merge(s) traced, ' +
        String(result.viaBoard) +
        ' via the board, ' +
        String(result.exceptions) +
        ' emergency exception(s), ' +
        String(result.legacySkipped) +
        ' legacy commit(s) skipped',
    )
    return 0
  }
  console.error('✘ ' + String(result.untraceable.length) + ' untraceable commit(s) on ' + result.target + ':')
  for (const entry of result.untraceable) {
    console.error('  ' + entry.hash.slice(0, 9) + '  ' + entry.subject)
  }
  console.error('')
  console.error('Every non-merge commit on the target must arrive through a task/test/merge branch,')
  console.error('be recorded as done+merged in .agents/tasks.json, or be a declared emergency')
  console.error('exception in scripts/check-target-history.mjs with a retro task card and a CHANGELOG entry.')
  return 1
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exit(main())
}
