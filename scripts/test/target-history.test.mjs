// Target-branch history guard: traceable vs untraceable fixtures, the board as a
// second source, explicit emergency exceptions, the legacy cut-off, and the hook.

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_TARGET,
  captureGit,
  checkTargetHistory,
  main,
  mergedBranchOf,
  runGit,
} from '../check-target-history.mjs'
import { hookDecision, hookScript, installHooks } from '../setup-hooks.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

/** Run git with the fixture identity, so the tests do not depend on user config. */
const IDENTITY = ['-c', 'user.name=target-history-test', '-c', 'user.email=test@example.com']

function fixtureRepo() {
  const directory = mkdtempSync(join(tmpdir(), 't40-fixture-'))
  runGit(directory, ['init', '-q', '-b', 'main'])
  writeFileSync(join(directory, 'root.txt'), 'root')
  runGit(directory, ['add', '-A'])
  runGit(directory, IDENTITY.concat(['commit', '-q', '-m', 'root commit']))
  return directory
}
function commitAll(directory, message) {
  runGit(directory, ['add', '-A'])
  runGit(directory, IDENTITY.concat(['commit', '-q', '-m', message]))
}
function headOf(directory, ref) {
  return runGit(directory, ['rev-parse', ref === undefined ? 'HEAD' : ref])
}
/** The repository's first commit: the legacy cut-off for a fixture, mirroring the
 * real repository where everything before LEGACY_UP_TO predates the policy. */
function rootOf(directory) {
  return runGit(directory, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0]
}
function mergeInto(directory, branch, message) {
  runGit(directory, IDENTITY.concat(['merge', '--no-ff', '-q', '-m', message, branch]))
}
/** Run node with file-backed stdio (pipes are unavailable in confined sandboxes). */
function captureNode(args) {
  const directory = mkdtempSync(join(tmpdir(), 't40-node-'))
  const output = join(directory, 'out.txt')
  let fd
  try {
    fd = openSync(output, 'w')
    try {
      execFileSync(process.execPath, args, { stdio: ['ignore', fd, fd] })
      return { ok: true, text: readFileSync(output, 'utf8') }
    } catch (error) {
      return { ok: false, text: readFileSync(output, 'utf8') }
    } finally {
      closeSync(fd)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function captureConsole(run) {
  const logs = []
  const errors = []
  const log = console.log
  const error = console.error
  console.log = (...args) => logs.push(args.join(' '))
  console.error = (...args) => errors.push(args.join(' '))
  try {
    return { code: run(), logs: logs, errors: errors }
  } finally {
    console.log = log
    console.error = error
  }
}

// ── traceable history ──────────────────────────────────────────────────────
{
  const directory = fixtureRepo()
  runGit(directory, ['checkout', '-q', '-b', 'task/T-1-1'])
  writeFileSync(join(directory, 'work.txt'), 'work')
  commitAll(directory, 'task work')
  runGit(directory, ['checkout', '-q', 'main'])
  mergeInto(directory, 'task/T-1-1', "Merge branch 'task/T-1-1' into test/T-1")
  const result = checkTargetHistory({ cwd: directory, target: 'main', project: directory, legacy: rootOf(directory) })
  check(
    'a target whose commits arrived through a task merge is traceable',
    result.ok === true && result.checked === 2 && result.untraceable.length === 0 && result.merges.filter((entry) => entry.traced === true).length === 1,
    JSON.stringify({ ok: result.ok, checked: result.checked, untraceable: result.untraceable }),
  )
  const clean = captureConsole(() => main(['--target', 'main', '--cwd', directory, '--project', directory, '--legacy', rootOf(directory)]))
  check('the CLI exits 0 and summarises a traceable history', clean.code === 0 && clean.logs.join('\n').indexOf('target history traceable') >= 0, JSON.stringify(clean.logs))

  // A test/<id> merge is equally valid, and its nested task merge is traced too.
  const nested = fixtureRepo()
  runGit(nested, ['checkout', '-q', '-b', 'task/T-2-1'])
  writeFileSync(join(nested, 'a.txt'), 'a')
  commitAll(nested, 'nested task work')
  runGit(nested, ['checkout', '-q', '-b', 'test/T-2', 'main'])
  mergeInto(nested, 'task/T-2-1', "Merge branch 'task/T-2-1' into test/T-2")
  runGit(nested, ['checkout', '-q', 'main'])
  mergeInto(nested, 'test/T-2', "Merge branch 'test/T-2' into feat/task-center-v2")
  const nestedResult = checkTargetHistory({ cwd: nested, target: 'main', project: nested, legacy: rootOf(nested) })
  check('a test/<id> merge traces the task commits it carries', nestedResult.ok === true && nestedResult.untraceable.length === 0, JSON.stringify(nestedResult.untraceable))

  // ── direct commit: untraceable ───────────────────────────────────────────
  writeFileSync(join(directory, 'hot.txt'), 'hot')
  commitAll(directory, 'direct commit on the target')
  const directHash = headOf(directory)
  const bad = checkTargetHistory({ cwd: directory, target: 'main', project: directory, legacy: rootOf(directory) })
  check(
    'a direct commit on the target is untraceable',
    bad.ok === false && bad.untraceable.length === 1 && bad.untraceable[0].subject === 'direct commit on the target' && bad.untraceable[0].hash === directHash,
    JSON.stringify(bad.untraceable),
  )
  const failing = captureConsole(() => main(['--target', 'main', '--cwd', directory, '--project', directory, '--legacy', rootOf(directory)]))
  check(
    'the CLI exits 1 and lists the offending hash and subject',
    failing.code === 1 && failing.errors.join('\n').indexOf(directHash.slice(0, 9)) >= 0 && failing.errors.join('\n').indexOf('direct commit on the target') >= 0,
    JSON.stringify(failing.errors),
  )

  // ── the board as a second source ─────────────────────────────────────────
  mkdirSync(join(directory, '.agents'), { recursive: true })
  writeFileSync(
    join(directory, '.agents', 'tasks.json'),
    JSON.stringify({ version: 2, tasks: [{ id: 'T-9', status: 'done', commit: directHash, merge: { status: 'merged', head: directHash } }] }),
  )
  const viaBoard = checkTargetHistory({ cwd: directory, target: 'main', project: directory, legacy: rootOf(directory) })
  check('a done+merged board task makes its commit traceable', viaBoard.ok === true && viaBoard.viaBoard === 1, JSON.stringify({ ok: viaBoard.ok, board: viaBoard.viaBoard, untraceable: viaBoard.untraceable }))

  // ── an explicit exception ────────────────────────────────────────────────
  const viaException = checkTargetHistory({ cwd: directory, target: 'main', project: directory, legacy: rootOf(directory), exceptions: [directHash] })
  check('an explicit emergency exception makes the hotfix traceable', viaException.ok === true && viaException.exceptions === 1, JSON.stringify({ ok: viaException.ok, exceptions: viaException.exceptions }))

  // ── the legacy cut-off is history, not a bypass ──────────────────────────
  // Drop the board fixture first, so the legacy assertions test the guard alone.
  rmSync(join(directory, '.agents', 'tasks.json'))
  const legacyUpToDirect = checkTargetHistory({ cwd: directory, target: 'main', project: directory, legacy: directHash })
  check('a commit at the legacy cut-off is skipped, not fixed', legacyUpToDirect.ok === true && legacyUpToDirect.legacySkipped >= 1, JSON.stringify({ legacy: legacyUpToDirect.legacySkipped }))
  const rootHash = runGit(directory, ['rev-list', '--max-parents=0', 'HEAD']).split('\n')[0]
  const afterLegacy = checkTargetHistory({ cwd: directory, target: 'main', project: directory, legacy: rootHash })
  check('a direct commit AFTER the cut-off is still refused', afterLegacy.ok === false && afterLegacy.untraceable.length === 1, JSON.stringify(afterLegacy.untraceable))

  // ── an out-of-band hotfix merge is not automatically traceable ───────────
  const hotfix = fixtureRepo()
  runGit(hotfix, ['checkout', '-q', '-b', 'hotfix/merge-queue'])
  writeFileSync(join(hotfix, 'fix.txt'), 'fix')
  commitAll(hotfix, 'hotfix: bound the merge queue')
  const hotfixCommit = headOf(hotfix)
  runGit(hotfix, ['checkout', '-q', 'main'])
  mergeInto(hotfix, 'hotfix/merge-queue', 'Merge hotfix/merge-queue: bound the merge queue')
  const hotfixResult = checkTargetHistory({ cwd: hotfix, target: 'main', project: hotfix, legacy: rootOf(hotfix) })
  check(
    'a hotfix/ merge is NOT automatically traceable',
    hotfixResult.ok === false && hotfixResult.untraceable.length === 1 && hotfixResult.untraceable[0].hash === hotfixCommit,
    JSON.stringify(hotfixResult.untraceable),
  )
  const hotfixAllowed = checkTargetHistory({ cwd: hotfix, target: 'main', project: hotfix, legacy: rootOf(hotfix), exceptions: [hotfixCommit] })
  check('and it passes once declared as an exception', hotfixAllowed.ok === true, JSON.stringify(hotfixAllowed.untraceable))

  // ── a missing target ref never fails CI ──────────────────────────────────
  const skipped = checkTargetHistory({ cwd: hotfix, target: 'no-such-branch', project: hotfix, legacy: null })
  check('a missing target ref is skipped instead of failing', skipped.ok === true && skipped.skipped === 'unknown-target')
  const skippedCli = captureConsole(() => main(['--target', 'no-such-branch', '--cwd', hotfix, '--project', hotfix, '--legacy', rootOf(hotfix)]))
  check('and the CLI says so with exit 0', skippedCli.code === 0 && skippedCli.logs.join('\n').indexOf('nothing to check') >= 0, JSON.stringify(skippedCli.logs))

  // ── subject parsing ──────────────────────────────────────────────────────
  check(
    'merge subjects name the branch they brought in',
    mergedBranchOf("Merge branch 'task/T-36-3' into test/T-36") === 'task/T-36-3' &&
      mergedBranchOf('Merge hotfix/merge-queue: idempotent candidate merge') === 'hotfix/merge-queue' &&
      mergedBranchOf("Merge branch 'feat/other' into main") === 'feat/other' &&
      mergedBranchOf('a plain commit subject') === null,
    JSON.stringify([mergedBranchOf("Merge branch 'task/T-36-3' into test/T-36"), mergedBranchOf('Merge hotfix/merge-queue: x')]),
  )
}

// ── the hook: policy + a real git commit through it ─────────────────────────
{
  check('a direct commit on the target is blocked', hookDecision({ branch: DEFAULT_TARGET, target: DEFAULT_TARGET }).blocked === true)
  check('TASK_CENTER_MERGE=1 is the explicit escape hatch', hookDecision({ branch: DEFAULT_TARGET, target: DEFAULT_TARGET, merge: true }).blocked === false)
  check('a task branch commits freely', hookDecision({ branch: 'task/T-40-1', target: DEFAULT_TARGET }).blocked === false)
  check('a detached HEAD is not attributed to the target', hookDecision({ branch: '', target: DEFAULT_TARGET }).blocked === false)
  const script = hookScript({ target: 'feat/protected' })
  check(
    'the hook script names the target, the bypass and the refusal',
    script.indexOf('feat/protected') >= 0 && script.indexOf('TASK_CENTER_MERGE') >= 0 && script.indexOf('exit 1') >= 0 && script.indexOf('task/<id>-<n>') >= 0,
  )

  // The installer: a fixture repository, the hook file, and git configured to
  // use it. The hook itself is a POSIX sh script, so the test checks the written
  // policy (hookDecision/hookScript) instead of executing a shell: spawning one
  // is not available in every confined environment this suite runs in.
  const directory = fixtureRepo()
  runGit(directory, ['checkout', '-q', '-b', 'feat/task-center-v2'])
  const installed = installHooks({ cwd: directory, target: 'feat/task-center-v2' })
  const hookFile = join(directory, '.githooks', 'pre-commit')
  check(
    'installHooks writes the hook and points git at it',
    existsSync(hookFile) && readFileSync(hookFile, 'utf8') === hookScript({ target: 'feat/task-center-v2' }) && runGit(directory, ['config', 'core.hooksPath']) === '.githooks',
    String(installed.file),
  )
  const written = readFileSync(hookFile, 'utf8').split('\n')
  check(
    'the written hook guards exactly the branch the policy guards',
    written.some((line) => line.indexOf('branch=$(git symbolic-ref --quiet --short HEAD') >= 0) &&
      written.some((line) => line.indexOf('if [ "$branch" = "$target" ]') >= 0) &&
      written.some((line) => line.indexOf('TASK_CENTER_MERGE:-') >= 0) &&
      written.some((line) => line.trim() === 'exit 1') &&
      written.some((line) => line.trim() === 'exit 0'),
    JSON.stringify(written.slice(0, 6)),
  )
  // The same decisions the hook makes, asserted through the shared policy: on
  // the protected branch a commit is refused unless the bypass is explicit.
  const protectedBranch = runGit(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  check('a fixture checked out on the target exposes the guarded branch name', protectedBranch === 'feat/task-center-v2', protectedBranch)
  check(
    'and the policy refuses a commit there while allowing the bypass',
    hookDecision({ branch: protectedBranch, target: 'feat/task-center-v2' }).blocked === true &&
      hookDecision({ branch: protectedBranch, target: 'feat/task-center-v2', merge: true }).blocked === false,
  )
}

// ── the CLI entry points must actually run ─────────────────────────────────
// These spawn node itself (not git). setup-hooks.mjs once compared a hand-built
// "file:///" URL against import.meta.url, which is equal only on Windows: on
// Linux/macOS `node scripts/setup-hooks.mjs` exited 0 having written nothing.
{
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const script = join(repository, 'scripts', 'setup-hooks.mjs')
  const dry = captureNode([script, '--dry-run'])
  check(
    'the setup-hooks CLI runs on this platform and prints the hook',
    dry.ok === true && dry.text.indexOf('#!/bin/sh') >= 0 && dry.text.indexOf('TASK_CENTER_MERGE') >= 0 && dry.text.indexOf('exit 1') >= 0,
    JSON.stringify(dry.text.slice(0, 160)),
  )
  const directory = fixtureRepo()
  const install = captureNode([script, '--target', 'feat/task-center-v2', '--cwd', directory])
  check(
    'the CLI really installs the hook into --cwd',
    install.ok === true && install.text.indexOf('installed') >= 0 && existsSync(join(directory, '.githooks', 'pre-commit')) && runGit(directory, ['config', 'core.hooksPath']) === '.githooks',
    JSON.stringify(install.text.slice(0, 200)),
  )
  const guard = join(repository, 'scripts', 'check-target-history.mjs')
  const targetDry = captureNode([guard, '--cwd', directory, '--target', 'main', '--legacy', rootOf(directory)])
  check(
    'the check-target-history CLI also runs through its entry point',
    targetDry.ok === true && targetDry.text.indexOf('target history traceable') >= 0,
    JSON.stringify(targetDry.text.slice(0, 200)),
  )
}

// ── the shipped repository passes its own guard ─────────────────────────────
{
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const result = checkTargetHistory({ cwd: repository })
  check(
    'the shipped repository target history is traceable',
    result.ok === true || result.skipped === 'unknown-target',
    JSON.stringify(result.untraceable.slice(0, 3)),
  )
  if (result.skipped !== 'unknown-target') {
    check(
      'every out-of-band hotfix is honored as a declared emergency exception',
      result.exceptions === 3 &&
        [
          '2c895b4eb95c4435d0df03365205870f006ae07b',
          '745c7b0a35c7c2ee3e5d8d4a02fd530f5598c3f9',
          '21459a55043d87ad79045f2e02031b5a6b0976be',
        ].every((hash) => result.declaredExceptions.some((entry) => entry.commit === hash)),
      JSON.stringify({ exceptions: result.exceptions, declared: result.declaredExceptions.map((entry) => entry.commit) }),
    )
    {
      const v021 = result.declaredExceptions.filter(
        (entry) => entry.commit === '745c7b0a35c7c2ee3e5d8d4a02fd530f5598c3f9' || entry.commit === '21459a55043d87ad79045f2e02031b5a6b0976be',
      )
      check(
        'the v0.2.1 hotfix entries carry a reason, the merge and their covering cards',
        v021.length === 2 &&
          v021.every(
            (entry) =>
              typeof entry.reason === 'string' &&
              entry.reason.length > 40 &&
              entry.merge === '90a5427d86d65ad719e12150de276e60c0385aa6' &&
              Array.isArray(entry.tasks) &&
              entry.tasks.indexOf('T-74') >= 0 &&
              entry.tasks.indexOf('T-76') >= 0,
          ),
        JSON.stringify(v021),
      )
    }
    check('and the legacy range is reported rather than hidden', result.legacySkipped > 0, String(result.legacySkipped))
    check('the shipped board path resolves next to the shared git directory', existsSync(join(result.project, '.agents')) || result.project !== repository, result.project)
    check('the guard is wired into the package scripts', readFileSync(join(repository, 'package.json'), 'utf8').indexOf('check:target') >= 0)
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
