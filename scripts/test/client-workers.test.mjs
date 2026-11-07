import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createWorkersView } = require('../../client/src/views/workers.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const WorkersView = createWorkersView({
  React: { useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] },
  h: h,
  tcBaseName: (value) => String(value).split('/').pop(),
  tcSessionShort: (value) => (value === null ? null : String(value).slice(0, 8)),
  tcLeadText: (lead) => (lead === null ? '—' : lead),
  copyToClipboard: async () => true,
  roleKindLabel: (kind) => kind,
  workerStatusLabel: (status) => status,
})
const t = (key) => key
const snapshot = {
  source: 'host',
  project: '/repo',
  dispatch: { maxConcurrent: 3 },
  workers: {
    lead: 'lead',
    session: 'session-123',
    project: '/repo',
    members: [{ id: 'w1', name: 'worker-1', kind: 'worker', status: 'running', queue: 0, currentTask: { id: 'T-1', title: 'Work' } }],
    roleCounts: { worker: { running: 1, idle: 0, busy: 1 } },
    roles: { bound: {} },
    busy: 1,
    idle: 0,
    provisioning: 0,
    failed: 0,
    cap: 4,
  },
}
const out = WorkersView({ snapshot: snapshot, t: t })
assert.equal(out.type, 'div')
assert.equal(out.props.className, 'gbt-workersview')
const text = JSON.stringify(out)
assert.ok(text.includes('worker-1'))
assert.ok(text.includes('gbt-workertable'))
assert.ok(text.includes('workersTab'))

console.log('PASS  WorkersView is an independently testable view module')
