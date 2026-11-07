import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL('../../plugin/task-center/lease-registry.mjs', import.meta.url).href
const root = mkdtempSync(join(tmpdir(), 'gbt-lease-dual-'))
const leaseFile = join(root, '.agents', 'leader-leases.json')
mkdirSync(join(root, '.agents'), { recursive: true })
const child = join(root, 'claim.mjs')
writeFileSync(
  child,
  [
    'import { createLeaseRegistry } from ' + JSON.stringify(moduleUrl),
    "import { writeFileSync } from 'node:fs'",
    'const [file, owner, resultPath] = process.argv.slice(2)',
    'const registry = createLeaseRegistry({ file, ttlMs: 30000, bootId: owner, pid: process.pid })',
    "const result = await registry.claim('/project', owner)",
    'writeFileSync(resultPath, JSON.stringify(result))',
    '',
  ].join('\n'),
)

function claim(owner, resultPath) {
  return new Promise((resolveRun, reject) => {
    const processHandle = spawn(process.execPath, [child, leaseFile, owner, resultPath], { stdio: 'ignore' })
    processHandle.on('error', reject)
    processHandle.on('close', (code) => resolveRun(code))
  })
}

try {
  const resultA = join(root, 'a.json')
  const resultB = join(root, 'b.json')
  const codes = await Promise.all([claim('host-a', resultA), claim('host-b', resultB)])
  assert.deepEqual(codes, [0, 0], 'both worker processes exit cleanly')
  const results = [JSON.parse(readFileSync(resultA, 'utf8')), JSON.parse(readFileSync(resultB, 'utf8'))]
  const claimed = results.filter((result) => result.ok === true)
  const refused = results.filter((result) => result.ok === false)
  assert.equal(claimed.length, 1, 'exactly one process owns the project lease')
  assert.equal(refused.length, 1, 'the other process is refused')
  assert.equal(refused[0].code, 'lease-held')
  assert.equal(refused[0].holder.owner, claimed[0].lease.owner)
  console.log('PASS  two real node processes race for one project lease; exactly one wins')
} finally {
  rmSync(root, { recursive: true, force: true })
}
