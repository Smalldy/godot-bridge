import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createAgentRow } = require('../../client/src/views/agent-row.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const AgentRow = createAgentRow({
  h: h,
  roleKindLabel: (kind) => 'role:' + kind,
  tcAgentStatusKey: (status) => (status === 'running' ? 'agentStatusRunning' : 'agentStatusUnknown'),
})
const member = AgentRow({
  t: (key) => key,
  member: { id: 'session-1', name: 'worker-1', role: 'worker', status: 'running', taskId: 'T-1' },
})
assert.equal(member.type, 'tr')
assert.equal(member.props['data-agent'], 'worker-1')
assert.equal(member.props['data-agent-id'], 'session-1')
assert.equal(member.props['data-agent-role'], 'worker')
assert.equal(member.props['data-agent-status'], 'running')
assert.equal(member.props['data-agent-task'], 'T-1')
assert.equal(member.props['data-agent-root'], undefined)
const memberText = JSON.stringify(member)
assert.ok(memberText.includes('worker-1'))
assert.ok(memberText.includes('role:worker'))
assert.ok(memberText.includes('agentStatusRunning'))
assert.ok(memberText.includes('T-1'))
assert.ok(memberText.includes('agent-task'))

const root = AgentRow({ t: (key) => key, member: { id: 'session-root', name: 'root', role: 'lead' }, isRoot: true })
assert.equal(root.props['data-agent-root'], 'true')
assert.equal(root.props['data-agent-role'], 'root')
const rootText = JSON.stringify(root)
assert.ok(rootText.includes('agentRootRole'))
assert.ok(rootText.includes('root'))
assert.ok(rootText.indexOf('Team') < 0 && rootText.indexOf('Lead') < 0, rootText)

console.log('PASS  AgentRow renders one live tree member with role, status and task id')
