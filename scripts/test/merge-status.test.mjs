import assert from 'node:assert/strict'
import { createMerger } from '../../plugin/task-center/merge.mjs'

const merger = createMerger({ now: () => 1000 })
assert.deepEqual(merger.status(), { active: 0, queued: 0, chains: 0, last: null })

const pending = merger.enqueue(async () => ({ ok: true, code: null }), 'target')
const immediate = merger.status()
assert.equal(immediate.queued, 1, 'the unit is queued synchronously')
assert.equal(immediate.active, 0, 'it has not started yet')

const result = await pending
assert.equal(result.ok, true)
const after = merger.status()
assert.equal(after.active, 0)
assert.equal(after.queued, 0)
assert.equal(after.chains, 1)
assert.equal(after.last.ok, true)
assert.equal(after.last.key, 'target')
assert.equal(after.last.code, null)

const slow = createMerger({ now: () => 0, enqueueTimeoutMs: 10 })
const timeout = await slow.enqueue(() => new Promise(() => {}), 'slow')
assert.equal(timeout.ok, false)
assert.equal(timeout.code, 'queue-timeout')
const timed = slow.status()
assert.equal(timed.active, 0)
assert.equal(timed.queued, 0)
assert.equal(timed.last.code, 'queue-timeout')

console.log('PASS  merge queue status exposes queued, active and last outcome')
console.log('PASS  merge queue status records a timeout without leaking active')
