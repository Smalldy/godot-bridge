import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createWorkersView } = require('../../client/src/views/workers.cjs')
const { tcAgentTreeOf } = require('../../client/src/selectors.cjs')

function h(type, props, ...children) {
  const nextProps = Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children })
  if (typeof type === 'function') return type(nextProps)
  return { type, props: nextProps }
}
function AgentRow(props) {
  return { type: 'tr', props: { 'data-agent': props.member.name, 'data-agent-root': props.isRoot === true ? 'true' : undefined, member: props.member } }
}
const WorkersView = createWorkersView({
  React: { useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] },
  h: h,
  tcBaseName: (value) => String(value).split('/').pop(),
  tcAgentTreeOf: tcAgentTreeOf,
  AgentRow: AgentRow,
  copyToClipboard: async () => true,
})
const t = (key) => key
const tree = {
  available: true,
  root: { id: 'session-root', name: 'root', role: 'lead' },
  members: [
    { id: 'session-w1', name: 'worker-1', role: 'worker', status: 'running', taskId: 'T-1' },
    { id: 'session-r1', name: 'reviewer-1', role: 'reviewer', status: 'inactive', taskId: null },
  ],
  count: 2,
  error: null,
}
const out = WorkersView({ snapshot: { source: 'host', project: '/repo', agentTree: tree }, t: t })
assert.equal(out.type, 'div')
assert.equal(out.props.className, 'gbt-workersview')
assert.equal(out.props['data-agent-tree-view'], 'true')
const text = JSON.stringify(out)
assert.ok(text.includes('agentsTitle'))
assert.ok(text.includes('agentsHint'))
assert.ok(text.includes('data-agent-table'))
assert.ok(text.includes('session-root'))
assert.ok(text.includes('worker-1'))
assert.ok(text.includes('reviewer-1'))
const rows = []
function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (node.type === 'tr' && node.props && (node.props['data-agent'] !== undefined || node.props['data-agent-root'] !== undefined)) rows.push(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) children.forEach(walk)
  else walk(children)
}
walk(out)
assert.equal(rows.length, 3)
assert.equal(rows[0].props['data-agent-root'], 'true')
assert.deepEqual(rows.slice(1).map((row) => row.props['data-agent']), ['worker-1', 'reviewer-1'])

const noTree = WorkersView({ snapshot: { source: 'host', project: '/repo' }, t: t })
const noTreeText = JSON.stringify(noTree)
assert.ok(noTreeText.includes('agentsUnavailable'))
assert.ok(noTreeText.indexOf('"type":"tr"') < 0, 'no invented member rows without an agent tree')

const noRoot = WorkersView({ snapshot: { source: 'host', project: '/repo', agentTree: { available: true, root: null, members: [], count: 0, error: null } }, t: t })
assert.ok(JSON.stringify(noRoot).includes('agentsNoRoot'))

const noChildren = WorkersView({ snapshot: { source: 'host', project: '/repo', agentTree: { available: true, root: tree.root, members: [], count: 0, error: null } }, t: t })
const noChildrenText = JSON.stringify(noChildren)
assert.ok(noChildrenText.includes('agentsNoChildren'))
assert.ok(noChildrenText.includes('session-root'))

console.log('PASS  WorkersView renders the live agent tree and neutral empty states')
