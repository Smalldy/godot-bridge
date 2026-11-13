import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskCenter } = require('../../client/src/views/task-center.cjs')
const { tcAgentTreeOf, tcAgentStatusKey } = require('../../client/src/selectors.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const view = (name) => (props) => ({ type: name, props: props })
const agentTree = {
  available: true,
  root: { id: 'session-root', name: 'root', role: 'lead' },
  members: [{ id: 'session-w1', name: 'worker-1', role: 'worker', status: 'running', taskId: 'T-1' }],
  count: 1,
  error: null,
}
const deps = {
  React: { useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect: () => {} },
  h: h,
  Board: view('board'),
  QueueView: view('queue'),
  WorkersView: view('workers'),
  StatusView: view('status'),
  RolesView: view('roles'),
  DetailView: view('detail'),
  DoneAllDrawer: view('done-all'),
  TaskForm: view('task-form'),
  SettingsForm: view('settings-form'),
  ProjectForm: view('project-form'),
  useTranslate: () => (key) => key,
  useSnapshot: () => ({
    source: 'host',
    project: '/repo',
    projectRoot: '/repo',
    sessionProject: '/repo',
    message: '',
    dispatch: { state: 'paused', maxConcurrent: 3, defaultTarget: '' },
    counts: {},
    tasks: [],
    queue: [],
    details: {},
    locks: [],
    agentTree: agentTree,
    roles: null,
    worktrees: null,
    environment: null,
    boardSize: null,
    archivedCount: 0,
    archiveRange: null,
    scheduler: null,
    activity: { entries: [] },
    lastSweep: null,
  }),
  useNow: () => 1000,
  panelState: { view: 'board', selectedId: null, doneAllOpen: false, doneAllArchived: false },
  projectFormState: { value: null },
  doneAllReset: () => {},
  projectMismatchOf: () => null,
  projectSourceKey: () => 'session',
  projectSourceLabel: () => 'session',
  tcAgo: () => 'now',
  tcAgentTreeOf: tcAgentTreeOf,
  tcAgentStatusKey: tcAgentStatusKey,
  roleKindLabel: (kind) => kind,
  copyToClipboard: async () => true,
  store: { send: async () => ({ ok: true }), startPolling: () => {}, stopPolling: () => {}, switchProject: async () => ({ ok: true }), loadDetail: async () => ({ ok: true }) },
}
const TaskCenter = createTaskCenter(deps)
const out = TaskCenter({})
assert.equal(out.type, 'div')
assert.equal(out.props.className, 'gbt-root')
assert.equal(out.props['data-panel'], 'task-center')
const text = JSON.stringify(out)
assert.ok(text.includes('gbt-tabs'))
assert.ok(text.includes('agentsTab'))
assert.ok(text.includes('data-agent-pill'))
assert.ok(text.includes('"data-agent-pill":"ready"'))
assert.ok(text.includes('data-agent-popover'))
assert.ok(text.includes('agentsPopoverTitle'))
assert.ok(text.includes('worker-1'))
assert.ok(!text.includes('data-team-pill'))
assert.ok(!text.includes('data-team-popover'))
assert.ok(!text.includes('bootstrapTeam'))
assert.ok(!text.includes('teamPill'))
assert.ok(!text.includes('workersTab'))
console.log('PASS  TaskCenter renders the agent-tree pill and popover, never a team')

// T-155: there is exactly ONE workspace switch — the scope bar.
const mismatchSnapshot = Object.assign({}, deps.useSnapshot(), {
  project: '/repo',
  projectRoot: '/repo',
  sessionProject: '/session',
})
const mismatchView = createTaskCenter(Object.assign({}, deps, {
  useSnapshot: () => mismatchSnapshot,
  projectMismatchOf: () => '/session',
}))
const mismatchOut = mismatchView({})
const mismatchJson = JSON.stringify(mismatchOut)
assert.ok(mismatchJson.includes('data-workspace-scope'))
assert.ok(mismatchJson.includes('"data-workspace-state":"switching"'))
assert.ok(mismatchJson.includes('workspaceFollowing'))
assert.ok(!mismatchJson.includes('switch-to-session-project'))
assert.ok(!mismatchJson.includes('switch-team-project'))
assert.ok(!mismatchJson.includes('projectTeamOpenSession'))
assert.ok(mismatchJson.includes('copy-session-id'))
assert.ok(mismatchJson.includes('copySessionId'))
console.log('PASS  one workspace scope bar, no per-project switch duplicates')
