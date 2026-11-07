import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStatusView } = require('../../client/src/views/status-view.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
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
  tcAgo: () => 'now',
  tcMergeOf: () => null,
  tcSessionIdInfo: () => ({ id: 'session-1', source: 'host' }),
  tcStageQueued: () => false,
  copyToClipboard: async () => true,
})
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
  agents: null,
  team: null,
  teams: null,
  roles: null,
}
const out = StatusView({ t: (key) => key, snapshot: snapshot, now: 1000, store: { listTasks: async () => ({ ok: true, tasks: [] }) } })
assert.equal(out.type, 'div')
const text = JSON.stringify(out)
assert.ok(text.includes('status'))
assert.ok(text.includes('gbt-status'))

console.log('PASS  StatusView is an independently testable view module')
