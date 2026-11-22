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
// T-228 fixtures: one READY card and two WAITING cards (one waiting on a
// dependency, one broken) so the queue card renders both halves.
const readyTask = { id: 'T-10', title: 'ready card', status: 'pending', priority: 80, dependsOn: [], dependency: { state: 'ready', waitingOn: [], brokenOn: [] }, writeFileCount: 2 }
const waitingTask = { id: 'T-11', title: 'waiting card', status: 'pending', priority: 50, dependsOn: [], dependency: { state: 'waiting', waitingOn: ['T-10'], brokenOn: [] }, writeFileCount: 0 }
const brokenTask = { id: 'T-12', title: 'broken card', status: 'pending', priority: 70, dependsOn: [], dependency: { state: 'broken', waitingOn: [], brokenOn: ['T-9'] }, writeFileCount: 1 }
const snapshot = {
  source: 'host',
  project: '/repo',
  dispatch: { state: 'running', maxConcurrent: 3 },
  counts: { ready: 1, blocked: 0 },
  archivedCount: 0,
  archiveRange: null,
  boardSize: null,
  tasks: [readyTask, waitingTask, brokenTask],
  queue: [readyTask],
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

// ── T-228: the status page owns the queue and the agent table ──────────────
// Exactly one queue card and one agents card: the retired queue/workers pages
// must not be re-created as duplicates here.
const cards = []
walk(out, (node) => { if (node.props && node.props['data-status-card'] !== undefined) cards.push(node.props['data-status-card']) })
assert.equal(cards.filter((name) => name === 'queue').length, 1, 'one queue card')
assert.equal(cards.filter((name) => name === 'agents').length, 1, 'one agents card')
assert.ok(text.includes('statusCardQueue'), 'the queue card has a title')

// READY rows come from snapshot.queue; WAITING rows are pending cards whose
// dependency is not ready (waiting or broken).
const queueRows = []
walk(out, (node) => { if (node.props && node.props['data-queue-row'] !== undefined) queueRows.push(node) })
assert.deepEqual(
  queueRows.map((row) => [row.props['data-queue-row'], row.props['data-queue-state']]),
  [
    ['T-10', 'ready'],
    ['T-11', 'waiting'],
    ['T-12', 'waiting'],
  ],
  'both queue halves render, ready first',
)
assert.ok(queueRows[0].props['data-queue-dependency'] === 'ready', 'a ready row names its ready dependency state')
assert.ok(queueRows[1].props['data-queue-dependency'] === 'waiting', 'a waiting row is marked waiting')
assert.ok(queueRows[2].props['data-queue-dependency'] === 'blocked', 'a broken dependency is marked blocked')
assert.ok(text.includes('P80'), 'the row shows the priority')
assert.ok(JSON.stringify(queueRows[1]).includes('T-10'), 'the waiting row names what it waits on')
assert.ok(JSON.stringify(queueRows[2]).includes('T-9'), 'the broken row names what is broken')
assert.ok(text.includes('🔒 2'), 'the row shows the file-lock count')
assert.ok(text.includes('"data-queue-summary":"true"'), 'the queue head summarises ready / waiting')

// Clicking a queue row opens the same task detail a board card opens.
const opened = []
const interactive = StatusView({
  t: (key) => key,
  snapshot: snapshot,
  now: 1000,
  store: { listTasks: async () => ({ ok: true, tasks: [] }) },
  onOpen: (id) => { opened.push(id) },
})
let secondRow = null
walk(interactive, (node) => {
  if (secondRow === null && node.props && node.props['data-queue-row'] === 'T-11') secondRow = node
})
assert.ok(secondRow !== null, 'the waiting row is rendered')
secondRow.props.onClick()
assert.deepEqual(opened, ['T-11'], 'the queue row opens the task detail')

// The agent card is a four-column table (角色 / 名称 / 状态 / 任务) and the root
// Agent shares the same row shape as its children.
assert.ok(text.includes('gbt-deckagenthead'), 'the agent card has a column header')
assert.ok(text.includes('"data-agent-columns":"true"'))
assert.ok(text.includes('gbt-deckagentrole') && text.includes('gbt-deckagentstatus') && text.includes('gbt-deckagenttask'), 'the agent rows carry the four cells')
assert.equal(agentRows[0].props['data-status-agent-role'], 'root', 'the root Agent has a role cell')
assert.equal(agentRows[1].props['data-status-agent-task'], 'T-1', 'a child Agent has a task cell')

// The dispatch card no longer repeats the ready detail; that belongs to the
// queue card now.
assert.ok(!text.includes('"data-kv":"ready"'), 'the dispatch card drops the duplicated ready metric')

const emptyQueue = StatusView({ t: (key) => key, snapshot: Object.assign({}, snapshot, { queue: [], tasks: [] }), now: 1000, store: { listTasks: async () => ({ ok: true, tasks: [] }) } })
assert.ok(JSON.stringify(emptyQueue).includes('statusQueueEmpty'), 'an empty queue says so once')
console.log('PASS  T-228 the status page renders ready/waiting queue rows and a four-column agent table')

const noTree = StatusView({ t: (key) => key, snapshot: Object.assign({}, snapshot, { agentTree: null }), now: 1000, store: { listTasks: async () => ({ ok: true, tasks: [] }) } })
const noTreeText = JSON.stringify(noTree)
assert.ok(noTreeText.includes('statusAgentsUnavailable'))
assert.ok(noTreeText.indexOf('"data-status-agent":"') < 0)

const noChildren = StatusView({ t: (key) => key, snapshot: Object.assign({}, snapshot, { agentTree: { available: true, root: tree.root, members: [], count: 0, error: null } }), now: 1000, store: { listTasks: async () => ({ ok: true, tasks: [] }) } })
assert.ok(JSON.stringify(noChildren).includes('statusAgentsNoChildren'))

console.log('PASS  StatusView renders the root Agent and live members from snapshot.agentTree')
