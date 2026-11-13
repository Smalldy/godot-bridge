import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStatusView } = require('../../client/src/views/status-view.cjs')
const { tcAgentTreeOf, tcAgentStatusKey } = require('../../client/src/selectors.cjs')

function h(type, props, ...children) {
  const nextProps = Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children })
  if (typeof type === 'function') return type(nextProps)
  return { type, props: nextProps }
}
const StatusView = createStatusView({
  React: { useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {} },
  h: h,
  statusUiState: { showAll: false, session: null, copied: null },
  worktreeCleanupUi: { probe: null, probeState: 'idle', probedSignature: null, preflight: null, pending: false, executing: false, result: null, forceConfirm: null, selected: {} },
  actorDisplay: (value) => value,
  mergeActorOf: () => null,
  roleKindLabel: (kind) => kind,
  testSummaryText: () => '',
  tcAgentTreeOf: tcAgentTreeOf,
  tcAgentStatusKey: tcAgentStatusKey,
  tcAgo: () => 'now',
  tcMergeOf: () => null,
  tcSessionIdInfo: () => ({ id: 'session-1', source: 'host' }),
  tcStageQueued: () => false,
  copyToClipboard: async () => true,
})
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  visit(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
  else walk(children, visit)
}
const tree = {
  available: true,
  root: { id: 'session-root', name: 'root', role: 'lead' },
  members: [{ id: 'session-w1', name: 'worker-1', role: 'worker', status: 'running', taskId: 'T-1' }],
  count: 1,
  error: null,
}
const snapshot = {
  source: 'host',
  project: '/repo',
  dispatch: { state: 'running', maxConcurrent: 3 },
  counts: { ready: 1, blocked: 0 },
  archivedCount: 0,
  archiveRange: null,
  boardSize: null,
  tasks: [],
  queue: [],
  scheduler: null,
  worktrees: null,
  activity: { entries: [] },
  lastSweep: null,
  agentTree: tree,
  roles: null,
}
const out = StatusView({ t: (key) => key, snapshot: snapshot, now: 1000, store: { listTasks: async () => ({ ok: true, tasks: [] }) } })
assert.equal(out.type, 'div')
assert.ok(JSON.stringify(out).includes('gbt-status'))
const agentRows = []
walk(out, (node) => { if (node.props && node.props['data-status-agent'] !== undefined) agentRows.push(node) })
assert.equal(agentRows.length, 2)
assert.equal(agentRows[0].props['data-status-agent'], 'root')
assert.equal(agentRows[0].props['data-status-agent-role'], 'root')
assert.equal(agentRows[1].props['data-status-agent'], 'worker-1')
assert.equal(agentRows[1].props['data-status-agent-status'], 'running')
assert.equal(agentRows[1].props['data-status-agent-task'], 'T-1')
const text = JSON.stringify(out)
assert.ok(text.includes('statusCardAgents'))
assert.ok(text.includes('worker-1'))

const noTree = StatusView({ t: (key) => key, snapshot: Object.assign({}, snapshot, { agentTree: null }), now: 1000, store: { listTasks: async () => ({ ok: true, tasks: [] }) } })
const noTreeText = JSON.stringify(noTree)
assert.ok(noTreeText.includes('statusAgentsUnavailable'))
assert.ok(noTreeText.indexOf('"data-status-agent":"') < 0)

const noChildren = StatusView({ t: (key) => key, snapshot: Object.assign({}, snapshot, { agentTree: { available: true, root: tree.root, members: [], count: 0, error: null } }), now: 1000, store: { listTasks: async () => ({ ok: true, tasks: [] }) } })
assert.ok(JSON.stringify(noChildren).includes('statusAgentsNoChildren'))

console.log('PASS  StatusView renders the root Agent and live members from snapshot.agentTree')
