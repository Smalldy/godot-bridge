// Browser bundle assembly checks.
//
// The old Team/worker-pool render harness was retired with the Team API. The
// per-view behaviour now lives in the focused client-*.test.mjs suites; this
// file keeps the bundle-level contract: one module registration, the agent-tree
// vocabulary, and no dead Team/worker-pool language in the shipped artifact.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../client/client.js', import.meta.url))
const SOURCE = fileURLToPath(new URL('../../client/src/00-head.part', import.meta.url))
const bundle = readFileSync(SRC, 'utf8')
const source = readFileSync(SOURCE, 'utf8')

assert.ok(bundle.length > 100000, 'the built bundle is non-trivial')
assert.ok(bundle.includes('godot-bridge'), 'the bundle names the module')
assert.ok(bundle.includes('agentTree'), 'the bundle reads snapshot.agentTree')
assert.ok(bundle.includes('tcAgentTreeOf'), 'the bundle has the agent-tree selector')
assert.ok(bundle.includes('agentsTitle'), 'the bundle carries the agent-tree copy')
assert.ok(bundle.includes('data-agent-tree-view'), 'the bundle renders the agent-tree view hook')
assert.ok(bundle.includes('data-agent-table'), 'the bundle renders the agent table')

for (const dead of ['gbt-teampill', 'gbt-teampopover', 'data-team-pill', 'bootstrapTeam', 'workerCap', 'maxWorkAgents', 'Team Lead']) {
  assert.equal(bundle.includes(dead), false, 'dead Team/worker-pool language survives: ' + dead)
}
assert.equal(source.includes("agentsTab2: 'x'"), false, 'no stray locale keys')
// Regression: cards must fit their lane (border-box) and the done lane is not
// allowed to grow past the shared lane cap.
assert.ok(source.includes('.gbt-card{box-sizing:border-box'), 'cards use border-box sizing')
assert.ok(source.includes('.gbt-col[data-group="done"]{max-width:420px'), 'the done lane shares the lane cap')

// Locale key parity is part of the shippable artifact: a missing key would show
// a raw i18n token in one language only.
const zhStart = source.indexOf('zh: {')
const enStart = source.indexOf('en: {')
assert.ok(zhStart >= 0 && enStart > zhStart, 'both locale blocks exist')
const zh = source.slice(zhStart, enStart)
const en = source.slice(enStart)
const keysOf = (text) => {
  const keys = new Set()
  const lines = text.split(/\r?\n/)
  let inTestObject = false
  for (const line of lines) {
    if (/\bconst\s+\w+\s*=\s*\{/.test(line)) inTestObject = true
    if (inTestObject) {
      if (line.trim() === '}' || line.trim() === '},') inTestObject = false
      continue
    }
    const match = line.match(/^\s{2,}([A-Za-z][A-Za-z0-9_]*):\s/)
    if (match !== null) keys.add(match[1])
  }
  return keys
}
const zhKeys = keysOf(zh)
const enKeys = keysOf(en)
const missingEn = Array.from(zhKeys).filter((key) => !enKeys.has(key))
const missingZh = Array.from(enKeys).filter((key) => !zhKeys.has(key))
assert.deepEqual(missingEn, [], 'missing en keys: ' + missingEn.join(','))
assert.deepEqual(missingZh, [], 'missing zh keys: ' + missingZh.join(','))

console.log('PASS  client bundle assembles with agent-tree vocabulary and no Team/worker-pool residue')
