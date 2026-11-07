#!/usr/bin/env node
/**
 * Zero-dependency line coverage report for the plugin/client sources.
 *
 * Runs the normal suite once with NODE_V8_COVERAGE, then maps the V8 ranges
 * back to source lines. This is a report, not a replacement for the structural
 * view-test gate; set GBT_COVERAGE_MIN to turn it into a threshold.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const coverageDir = mkdtempSync(join(tmpdir(), 'gbt-coverage-'))
const env = { ...process.env, NODE_V8_COVERAGE: coverageDir }
const run = spawnSync(process.execPath, [join(root, 'scripts', 'test', 'run.mjs')], { cwd: root, env, stdio: 'inherit' })
if (run.status !== 0) process.exit(run.status === null ? 1 : run.status)

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) out.push(...walk(path))
    else if (name.endsWith('.json')) out.push(path)
  }
  return out
}

function sourcePath(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null
  let path = fileURLToPath(url)
  if (process.platform === 'win32' && path.startsWith('/')) path = path.slice(1)
  return path
}

const rangesByFile = new Map()
for (const file of walk(coverageDir)) {
  let payload = null
  try { payload = JSON.parse(readFileSync(file, 'utf8')) } catch (_error) { continue }
  for (const entry of payload.result || []) {
    const path = sourcePath(entry.url)
    if (path === null) continue
    const relativePath = relative(root, path).split(sep).join('/')
    if (!(relativePath.startsWith('plugin/') || relativePath.startsWith('client/src/'))) continue
    if (!rangesByFile.has(path)) rangesByFile.set(path, [])
    for (const fn of entry.functions || []) {
      for (const range of fn.ranges || []) {
        if (range.count > 0) rangesByFile.get(path).push([range.startOffset, range.endOffset])
      }
    }
  }
}

let coveredLines = 0
let totalLines = 0
const rows = []
for (const [path, ranges] of [...rangesByFile].sort()) {
  const source = readFileSync(path, 'utf8')
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
  const covered = new Set()
  for (const [start, end] of ranges) {
    for (let line = 0; line < starts.length; line++) {
      const lineStart = starts[line]
      const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : source.length
      if (start < lineEnd && end > lineStart) covered.add(line)
    }
  }
  const total = starts.length
  coveredLines += covered.size
  totalLines += total
  rows.push({ file: relative(root, path).split(sep).join('/'), covered: covered.size, total })
}
rmSync(coverageDir, { recursive: true, force: true })
for (const row of rows) console.log(row.file + '  ' + row.covered + '/' + row.total + '  ' + (row.total === 0 ? 0 : Math.round((row.covered / row.total) * 100)) + '%')
const percent = totalLines === 0 ? 0 : (coveredLines / totalLines) * 100
console.log('\ncoverage: ' + coveredLines + '/' + totalLines + ' lines (' + percent.toFixed(1) + '%)')
const minimum = Number(process.env.GBT_COVERAGE_MIN || 0)
if (Number.isFinite(minimum) && percent < minimum) {
  console.error('coverage below GBT_COVERAGE_MIN=' + minimum)
  process.exit(1)
}
