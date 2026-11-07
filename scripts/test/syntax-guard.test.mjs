import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../check-syntax.mjs', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'gbt-syntax-'))
const good = join(directory, 'good.mjs')
const bad = join(directory, 'bad.mjs')
writeFileSync(good, 'export const value = 1\n')
writeFileSync(bad, 'export const = 1\n')

function run(file) {
  return spawnSync(process.execPath, [script, '--file', file], { stdio: 'inherit' }).status
}

try {
  assert.equal(run(good), 0, 'a valid file passes')
  assert.equal(run(bad), 1, 'a syntax error fails')
  console.log('PASS  syntax guard accepts valid files and rejects broken ones')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
