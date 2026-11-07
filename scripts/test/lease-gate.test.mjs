import assert from 'node:assert/strict'
import { createLeaseGate } from '../../plugin/task-center/lease-gate.mjs'

let claims = 0
let releases = 0
const registry = {
  claim: async (project, owner) => {
    claims += 1
    return { ok: true, action: 'claimed', lease: { owner: owner, expiresAt: 2000 } }
  },
  release: async () => {
    releases += 1
    return { ok: true, action: 'released' }
  },
  holder: () => ({ ok: true, lease: { owner: 'host-a' }, expired: false }),
}

let created = 0
const gate = createLeaseGate({
  owner: 'host-a',
  leases: (project) => {
    created += 1
    return registry
  },
})

const first = await gate.claim('/project')
assert.equal(first.leader, true)
assert.equal(first.lease.owner, 'host-a')
const second = await gate.claim('/project')
assert.equal(second.leader, true)
assert.equal(created, 1, 'one registry per project')
assert.equal(claims, 2)
assert.equal(gate.status('/project').isOwner, true)

await gate.releaseAll()
assert.equal(releases, 1, 'releaseAll releases the claimed project')
assert.equal(gate.status('/project').isOwner, true, 'the fake holder still reports its owner')

const denied = createLeaseGate({
  owner: 'host-b',
  leases: {
    claim: async () => ({ ok: false, code: 'lease-held', message: 'host-a owns it' }),
    release: async () => ({ ok: true }),
    holder: () => ({ ok: true, lease: { owner: 'host-a' }, expired: false }),
  },
})
const refused = await denied.claim('/project')
assert.equal(refused.leader, false)
assert.equal(refused.code, 'lease-held')
assert.equal(denied.status('/project').isOwner, false)

const noLease = createLeaseGate({ owner: 'host-c' })
assert.equal((await noLease.claim('/project')).leader, true)
assert.equal(noLease.status('/project'), null)

console.log('PASS  lease gate claims once, caches the registry and skips a held project')
console.log('PASS  no lease keeps the single-host behaviour')
