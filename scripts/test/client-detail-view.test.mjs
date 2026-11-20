import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDetailView } = require('../../client/src/views/detail-view.cjs')
const { agentSessionOf } = require('../../client/src/views/agent-sidebar.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const DetailView = createDetailView({
  React: { useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) },
  h: h,
  detailUiState: { evidence: false, spec: false },
  actorDisplay: (value) => value,
  mergeActorOf: () => null,
  testSummaryText: () => '',
  toneForDependency: () => 'ready',
  waitingChip: () => null,
  tcAgo: () => 'now',
  tcAgentTreeOf: () => ({ available: false, root: null, members: [], count: 0, error: null }),
  tcIsInvestigation: () => false,
  tcMergeLabel: () => 'merge',
  tcMergeOf: () => null,
  tcPhaseLabel: () => 'Run',
  tcReportBlocks: () => [],
  tcReviewLabel: () => 'review',
  tcReviewOf: () => null,
  tcRound: () => 1,
  tcStatusKey: () => 'running',
  tcTestLabel: () => 'test',
  tcTestOf: () => null,
})
const task = { id: 'T-1', title: 'Fix', status: 'running', priority: 0, attempts: 0, maxAttempts: 3, dependsOn: [], writeFiles: [], actualFiles: [], leaseUntil: null, createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', spec: '', evidence: '', verify: null }
const snapshot = { tasks: [task], locks: [], dispatch: { state: 'running' }, counts: {}, project: '/repo', merge: null, team: null, roles: null, source: 'host' }
const out = DetailView({ task: task, t: (key) => key, now: 1000, snapshot: snapshot, onClose: () => {}, onEdit: () => {}, store: { listTasks: async () => ({ ok: true, tasks: [] }) } })
assert.equal(out.type, 'div')
assert.ok(JSON.stringify(out).includes('T-1'))

// T-209: the drawer's "open in sidebar" entry.
const labels = { openInSidebar: '在侧边栏打开', openInSidebarHint: '在右侧栏打开这个任务的 Agent' }
const sidebarT = (key) => (labels[key] === undefined ? key : labels[key])
const opened = []
const deps = {
  React: { useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {}, useRef: () => ({ current: null }) },
  h: h,
  detailUiState: { evidence: false, spec: false },
  actorDisplay: (value) => value,
  mergeActorOf: () => null,
  testSummaryText: () => '',
  toneForDependency: () => 'ready',
  waitingChip: () => null,
  tcAgo: () => 'now',
  tcAgentTreeOf: () => ({ available: false, root: null, members: [], count: 0, error: null }),
  tcIsInvestigation: () => false,
  tcMergeLabel: () => 'merge',
  tcMergeOf: () => null,
  tcPhaseLabel: () => 'Run',
  tcReportBlocks: () => [],
  tcReviewLabel: () => 'review',
  tcReviewOf: () => null,
  tcRound: () => 1,
  tcStatusKey: () => 'running',
  tcTestLabel: () => 'test',
  tcTestOf: () => null,
}
const DetailViewWithSidebar = createDetailView(Object.assign({}, deps, {
  agentSidebar: {
    sessionOf: agentSessionOf,
    available: () => true,
    open: (sessionId) => { opened.push(sessionId); return true },
    label: (key) => (labels[key] === undefined ? key : labels[key]),
  },
}))
const agentTask = Object.assign({}, task, { assignee: { name: 'worker-t-1', session: 'session-t1' }, ownerSession: 'session-owner' })
function renderDetail(View, value) {
  return View({
    task: value,
    t: sidebarT,
    now: 1000,
    snapshot: Object.assign({}, snapshot, { tasks: [value] }),
    onClose: () => {},
    onEdit: () => {},
    store: { listTasks: async () => ({ ok: true, tasks: [] }) },
  })
}
function findEntry(node) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findEntry(item)
      if (hit !== null) return hit
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (node.props !== undefined && node.props['data-action'] === 'open-agent-sidebar') return node
  return findEntry(node.props === undefined ? undefined : node.props.children)
}

const detailWithEntry = renderDetail(DetailViewWithSidebar, agentTask)
const detailText = JSON.stringify(detailWithEntry)
assert.ok(detailText.includes('open-agent-sidebar'), 'the drawer with a real session renders the sidebar entry')
assert.ok(detailText.includes('在侧边栏打开'), 'the drawer entry carries the localized label')
assert.ok(detailText.includes('session-t1'), 'the drawer entry targets the REAL executor session')
const entry = findEntry(detailWithEntry)
assert.ok(entry !== null, 'the drawer entry is a button')
assert.equal(entry.type, 'button')
entry.props.onClick()
assert.deepEqual(opened, ['session-t1'], 'clicking the drawer entry opens the agent tab for that session')

const anonymous = renderDetail(DetailViewWithSidebar, Object.assign({}, task, { assignee: null, ownerSession: null }))
assert.equal(JSON.stringify(anonymous).includes('open-agent-sidebar'), false, 'a drawer without a session hides the entry')

const DetailViewWithoutSidebar = createDetailView(Object.assign({}, deps, {
  agentSidebar: { sessionOf: agentSessionOf, available: () => false, open: () => { throw new Error('must not be called') } },
}))
assert.equal(JSON.stringify(renderDetail(DetailViewWithoutSidebar, agentTask)).includes('open-agent-sidebar'), false, 'a shell without the sidebar hides the drawer entry')
assert.equal(JSON.stringify(renderDetail(DetailView, agentTask)).includes('open-agent-sidebar'), false, 'no sidebar dep keeps the drawer unchanged')

console.log('PASS  DetailView is an independently testable view module')
