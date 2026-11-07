import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const selectors = require('../../client/src/selectors.cjs')

assert.equal(typeof selectors.tcTime, 'function')
assert.equal(selectors.tcStatusKey('running'), 'statusRunning')
assert.equal(selectors.tcKindOf({ kind: 'investigate' }), 'investigate')
assert.equal(selectors.tcKindOf({}), 'dev')
assert.equal(selectors.tcPhaseOf({ status: 'pending', dependency: { state: 'ready' } }), 'ready')
assert.equal(selectors.tcPhaseOf({ status: 'pending', dependency: { state: 'waiting' } }), 'waiting')
assert.equal(selectors.tcPhaseOf({ status: 'testing' }), 'testing')
assert.equal(selectors.tcBaseName('a/b/c.js'), 'c.js')
assert.deepEqual(selectors.tcTail('abcdef', 3), { text: 'def', truncated: true })
assert.deepEqual(selectors.tcTail('ab', 3), { text: 'ab', truncated: false })
assert.equal(selectors.tcRound({ attempt: 2 }), 2)

console.log('PASS  client selectors are an independently testable module')
