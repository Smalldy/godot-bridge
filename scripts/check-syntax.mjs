#!/usr/bin/env node
// Syntax guard for the refactor branch.
//
// The repository has no lint/typecheck yet. This is the smallest portable
// guard: parse every hand-written JS/MJS source file with Node itself. It uses
// stdio: 'inherit' for the child, because the DSH file sandbox blocks piped
// child stdio in some confined environments (the test runner documents the same
// constraint).
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const SOURCE_DIRS = ['plugin', 'client', 'scripts']
const EXTENSIONS = new Set(['.mjs', '.js'])

function collect(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.worktrees') continue
      collect(full, files)
    } else if (entry.isFile() && EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      files.push(full)
    }
  }
}

function checkOne(file) {
  const run = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  return run.status === 0
}

const args = process.argv.slice(2)
let files = []
if (args[0] === '--file') {
  if (args[1] === undefined) {
    console.error('usage: node scripts/check-syntax.mjs [--file <path>]')
    process.exit(2)
  }
  files = [resolve(args[1])]
} else if (args.length > 0) {
  console.error('usage: node scripts/check-syntax.mjs [--file <path>]')
  process.exit(2)
} else {
  for (const dir of SOURCE_DIRS) {
    const full = join(ROOT, dir)
    if (!statSync(full, { throwIfNoEntry: false })) continue
    collect(full, files)
  }
}

let failed = 0
for (const file of files) {
  if (!checkOne(file)) {
    failed += 1
    console.error('SYNTAX FAIL  ' + relative(ROOT, file))
  }
}
if (failed > 0) {
  console.error('check:syntax: ' + String(failed) + '/' + String(files.length) + ' file(s) failed')
  process.exit(1)
}
console.log('check:syntax: ' + String(files.length) + ' file(s) passed')
