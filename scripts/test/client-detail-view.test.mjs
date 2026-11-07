import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDetailView } = require('../../client/src/views/detail-view.cjs')

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

console.log('PASS  DetailView is an independently testable view module')
