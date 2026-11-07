import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLeaseRegistry } from '../../plugin/task-center/lease-registry.mjs'

const root = mkdtempSync(join(tmpdir(), 'gbt-lease-'))
const file = join(root, '.agents', 'leader-leases.json')
let now = 1000
const clock = () => now

const a = createLeaseRegistry({ file: file, now: clock, ttlMs: 1000, bootId: 'boot-a', pid: 11 })
const b = createLeaseRegistry({ file: file, now: clock, ttlMs: 1000, bootId: 'boot-b', pid: 22 })

try {
  const first = await a.claim('/project', 'host-a')
  assert.equal(first.ok, true)
  assert.equal(first.action, 'claimed')
  assert.equal(first.lease.owner, 'host-a')
  assert.equal(first.lease.bootId, 'boot-a')

  const held = await b.claim('/project', 'host-b')
  assert.equal(held.ok, false)
  assert.equal(held.code, 'lease-held')
  assert.equal(held.holder.owner, 'host-a')

  const beat = await a.heartbeat('/project', 'host-a')
  assert.equal(beat.ok, true)

  const wrongRelease = await b.release('/project', 'host-b')
  assert.equal(wrongRelease.ok, false)
  assert.equal(wrongRelease.code, 'lease-held')

  const released = await a.release('/project', 'host-a')
  assert.equal(released.ok, true)
  assert.equal(released.action, 'released')

  const second = await b.claim('/project', 'host-b')
  assert.equal(second.ok, true)
  assert.equal(second.action, 'claimed')

  now += 1001
  const expired = await a.claim('/project', 'host-a')
  assert.equal(expired.ok, true)
  assert.equal(expired.action, 'claimed')
  const snapshot = a.snapshot()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.leases['/project'].owner, 'host-a')

  console.log('PASS  one project has one leader lease across two registry instances')
  console.log('PASS  heartbeat/release are owner-scoped and expiry allows handover')
} finally {
  rmSync(root, { recursive: true, force: true })
}
