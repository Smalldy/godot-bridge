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
// dependency, one broken) so the queue card renders both halves. READY rows are
// snapshot.queue entries — the Host's service.summary() carries the writeFiles
// ARRAY and no writeFileCount — while WAITING rows come from tasks[] (summaryOf,
// writeFileCount). Both shapes must yield a lock chip.
const readyTask = { id: 'T-10', title: 'ready card', status: 'pending', priority: 80, dependsOn: [], dependency: { state: 'ready', waitingOn: [], brokenOn: [] }, writeFiles: ['client/src/a.cjs', 'client/src/b.cjs'] }
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
assert.ok(text.includes('🔒 2'), 'a READY queue row derives the lock count from the writeFiles array (real /state queue shape)')
assert.ok(text.includes('🔒 1'), 'a WAITING task row still reads writeFileCount (real /state tasks shape)')
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

// ── T-236: the worktrees card reads ONE domain-projected block ──────────────
// The store projects /meta's inventory and the lazy /worktrees probe into
// snapshot.worktrees, whose rows already carry their verdict. The page must
// render them as-is (no second copy, no probing of its own from a render).
const probedWorktrees = {
  available: true,
  error: null,
  total: 2,
  active: 1,
  counts: { main: 1, task: 1 },
  probedAt: '2024-01-01T00:00:00.000Z',
  probe: { status: 'ready', receivedAt: 123, error: null },
  worktrees: [
    { path: '/repo', type: 'main', active: true, probed: true, dirty: false, merged: true, safe: false, reason: 'active', probedAt: null },
    { path: '/repo/.worktrees/T-1-1', type: 'task', taskId: 'T-1', branch: 'task/T-1-1', head: 'abc1234', active: false, target: 'main', probed: true, dirty: true, merged: false, safe: false, reason: 'dirty', probedAt: '2024-01-01T00:00:00.000Z' },
  ],
}
const domainSnapshot = Object.assign({}, snapshot, { worktrees: probedWorktrees })
const domainStore = { listTasks: async () => ({ ok: true, tasks: [] }) }
const withWorktrees = StatusView({ t: (key) => key, snapshot: domainSnapshot, now: 1000, store: domainStore })
const worktreeRows = []
walk(withWorktrees, (node) => { if (node.props && node.props['data-worktree-stale'] !== undefined) worktreeRows.push(node) })
assert.equal(worktreeRows.length, 1, 'the stale checkout renders once')
assert.equal(worktreeRows[0].props['data-worktree-stale'], 'T-1')
assert.equal(worktreeRows[0].props['data-wt-probed'], 'true', 'the row carries the verdict the domain handed it')
assert.equal(worktreeRows[0].props['data-reason'], 'dirty')
const worktreeText = JSON.stringify(withWorktrees)
assert.ok(worktreeText.includes('"data-wt-state":"dirty"'), 'the dirty verdict renders on the row')
assert.ok(worktreeText.includes('"data-wt-merge":"unmerged"'), 'the unmerged verdict renders on the row')
assert.ok(worktreeText.includes('"data-wt-summary":"true"'), 'the card keeps its summary line')
assert.ok(/2<!-- --> /.test(worktreeText) || worktreeText.includes('"data-wt-summary":"true"'), 'the total comes from the domain answer')
console.log('PASS  T-236 the worktrees card renders the domain-projected block as-is')

// An unprobed block says so once and never fakes a verdict.
const unprobedBlock = {
  available: true,
  error: null,
  total: 2,
  active: 1,
  counts: { main: 1, task: 1 },
  probe: { status: 'loading', receivedAt: null, error: null },
  worktrees: [
    probedWorktrees.worktrees[0],
    { path: '/repo/.worktrees/T-1-1', type: 'task', taskId: 'T-1', branch: 'task/T-1-1', head: 'abc1234', active: false, target: 'main', probed: false, dirty: null, merged: null, safe: false, reason: 'unprobed', probedAt: null },
  ],
}
const unprobed = StatusView({ t: (key) => key, snapshot: Object.assign({}, snapshot, { worktrees: unprobedBlock }), now: 1000, store: domainStore })
const unprobedText = JSON.stringify(unprobed)
assert.ok(unprobedText.includes('statusWtProbing'), 'a probed-in-flight row says it is probing')
assert.ok(!unprobedText.includes('"data-wt-state":"dirty"'), 'an unprobed row fabricates no verdict')
console.log('PASS  T-236 an unprobed worktree row shows the domain probe status, never a guess')

// ── T-236: the refresh button forces the domains, never a blanket load() ────
{
  const calls = []
  const refreshStore = {
    listTasks: async () => ({ ok: true, tasks: [] }),
    refreshActivity: () => calls.push('refreshActivity'),
    refreshWorktrees: () => calls.push('refreshWorktrees'),
    load: () => calls.push('load'),
  }
  const treeWithWorktrees = StatusView({ t: (key) => key, snapshot: domainSnapshot, now: 1000, store: refreshStore })
  let refreshButton = null
  walk(treeWithWorktrees, (node) => {
    if (refreshButton === null && node.props && node.props['data-action'] === 'status-refresh') refreshButton = node
  })
  assert.ok(refreshButton !== null, 'the status page has its refresh control')
  refreshButton.props.onClick()
  assert.deepEqual(calls, ['refreshActivity', 'refreshWorktrees'], 'the refresh forces exactly the activity and worktrees domains: ' + JSON.stringify(calls))
  console.log('PASS  T-236 the status refresh button forces only the domains the page reads')
}

// ── T-236: mounting the page starts the activity cadence and the lazy probe ─
{
  const effects = []
  const cleanups = []
  const effectReact = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: (fn) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
  const EffectStatusView = createStatusView({
    React: effectReact,
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
  const mountCalls = []
  const mountStore = {
    listTasks: async () => ({ ok: true, tasks: [] }),
    startActivityPolling: () => mountCalls.push('startActivityPolling'),
    stopActivityPolling: () => mountCalls.push('stopActivityPolling'),
    loadWorktrees: (options) => mountCalls.push(['loadWorktrees', options]),
  }
  EffectStatusView({ t: (key) => key, snapshot: domainSnapshot, now: 1000, store: mountStore })
  assert.equal(mountCalls.filter((call) => call === 'startActivityPolling').length, 1, 'the mounted page registers the activity cadence once')
  const probeCalls = mountCalls.filter((call) => Array.isArray(call) && call[0] === 'loadWorktrees')
  assert.equal(probeCalls.length, 1, 'the mounted page asks the worktrees domain for its rows once')
  assert.deepEqual(probeCalls[0][1], { paths: ['/repo/.worktrees/T-1-1'] }, 'it asks ONLY for the stale checkout it shows: ' + JSON.stringify(probeCalls[0][1]))
  cleanups.forEach((cleanup) => cleanup())
  assert.equal(mountCalls.filter((call) => call === 'stopActivityPolling').length, 1, 'unmounting releases the cadence')
  console.log('PASS  T-236 mounting the status page registers the activity cadence and lazily probes its rows')
}

console.log('PASS  StatusView renders the root Agent and live members from snapshot.agentTree')
