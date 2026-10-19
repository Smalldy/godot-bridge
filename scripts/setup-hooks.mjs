#!/usr/bin/env node
/**
 * Install the local pre-commit guard for the task-center target branch.
 *
 * `node scripts/setup-hooks.mjs [--target <branch>] [--cwd <dir>] [--dry-run]`
 *
 * It writes .githooks/pre-commit and points this repository at it
 * (core.hooksPath=.githooks). The hook refuses a direct commit on the protected
 * target so work goes through a task/<id>-<n> branch and the task center's merge;
 * TASK_CENTER_MERGE=1 is the explicit emergency escape hatch, and using it means
 * recording the commit in CHANGELOG plus an exception in
 * scripts/check-target-history.mjs.
 *
 * The hook is a POSIX sh script (git runs hooks with its own shell on every
 * platform, including Windows). hookDecision() is the same policy as pure code so
 * it can be tested without a shell.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_TARGET, runGit } from './check-target-history.mjs'

export const HOOK_DIRECTORY = '.githooks'
export const HOOK_PATH = '.githooks/pre-commit'

/**
 * The policy, as data: { blocked, reason }.
 *   not-on-target      — any branch other than the protected one commits freely
 *   explicit-merge     — TASK_CENTER_MERGE=1 bypasses the guard (emergency)
 *   direct-target-commit — refused
 * A detached HEAD cannot be attributed to the target, so it is allowed.
 */
export function hookDecision(options = {}) {
  const branch = typeof options.branch === 'string' ? options.branch : ''
  const target = typeof options.target === 'string' && options.target !== '' ? options.target : DEFAULT_TARGET
  if (branch !== target) return { blocked: false, reason: 'not-on-target' }
  if (options.merge === true) return { blocked: false, reason: 'explicit-merge' }
  return { blocked: true, reason: 'direct-target-commit' }
}

/** The hook text. Kept as a function so the target can be parameterised. */
export function hookScript(options = {}) {
  const target = typeof options.target === 'string' && options.target !== '' ? options.target : DEFAULT_TARGET
  return [
    '#!/bin/sh',
    '# Installed by scripts/setup-hooks.mjs — refuses direct commits on the protected',
    '# target branch. Normal work commits on task/<id>-<n> and the task center merges',
    '# it. An emergency hotfix may set TASK_CENTER_MERGE=1, and must then be recorded',
    '# in CHANGELOG.md plus an exception in scripts/check-target-history.mjs.',
    'target="${TASK_CENTER_TARGET:-' + target + '}"',
    'branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)',
    'if [ "$branch" = "$target" ] && [ "${TASK_CENTER_MERGE:-}" != "1" ]; then',
    '  echo "task-center: direct commits on $target are disabled." >&2',
    '  echo "Commit on a task/<id>-<n> branch and let the task center merge it," >&2',
    '  echo "or set TASK_CENTER_MERGE=1 for an emergency hotfix" >&2',
    '  echo "(record it in CHANGELOG and as an exception in scripts/check-target-history.mjs)." >&2',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n')
}

/** Write the hook and configure the repository to use it. Returns { file, target }. */
export function installHooks(options = {}) {
  const cwd = options.cwd === undefined ? process.cwd() : options.cwd
  const target = options.target === undefined ? DEFAULT_TARGET : options.target
  const script = hookScript({ target })
  mkdirSync(join(cwd, HOOK_DIRECTORY), { recursive: true })
  const file = join(cwd, HOOK_PATH)
  writeFileSync(file, script, 'utf8')
  try {
    chmodSync(file, 0o755)
  } catch (error) {
    /* the executable bit is meaningless on some filesystems; git still runs it */
  }
  runGit(cwd, ['config', 'core.hooksPath', HOOK_DIRECTORY])
  return { file, target }
}

function parseArgs(argv) {
  const options = { cwd: process.cwd(), target: DEFAULT_TARGET, dryRun: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === '--target') {
      options.target = next
      index += 1
    } else if (arg === '--cwd') {
      options.cwd = next
      index += 1
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    }
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('usage: node scripts/setup-hooks.mjs [--target <branch>] [--cwd <dir>] [--dry-run]')
    return 0
  }
  if (options.dryRun === true) {
    console.log(hookScript({ target: options.target }))
    return 0
  }
  const installed = installHooks({ cwd: options.cwd, target: options.target })
  console.log('✔ installed ' + installed.file + ' (core.hooksPath=.githooks, target ' + installed.target + ')')
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === new URL('file:///' + process.argv[1].replace(/\\/g, '/')).href
if (invokedDirectly) {
  process.exit(main())
}
