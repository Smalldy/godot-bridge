import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAgentRow } = require('../../client/src/views/agent-row.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const AgentRow = createAgentRow({
  React: { useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] },
  h: h,
  roleKindLabel: (kind) => kind,
  copyToClipboard: async () => true,
})
const out = AgentRow({
  t: (key) => key,
  member: { id: 'session-1', name: 'worker-1', kind: 'worker', status: 'running', currentTask: { id: 'T-1', title: 'Work' } },
  isLead: false,
})
assert.equal(out.type, 'tr')
assert.equal(out.props['data-agent'], 'worker-1')
assert.equal(out.props['data-kind'], 'worker')
const text = JSON.stringify(out)
assert.ok(text.includes('worker-1'))
assert.ok(text.includes('T-1'))

const lead = AgentRow({ t: (key) => key, member: { id: 'session-2', name: 'lead', status: 'running' }, isLead: true })
assert.ok(JSON.stringify(lead).includes('statusLead'))

console.log('PASS  AgentRow is an independently testable view module')
