import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskCenter } = require('../../client/src/views/task-center.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const view = (name) => (props) => ({ type: name, props: props })
const TaskCenter = createTaskCenter({
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
    team: null,
    agents: null,
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
  tcLeadText: () => 'lead',
  copyToClipboard: async () => true,
  store: { send: async () => ({ ok: true }), startPolling: () => {}, stopPolling: () => {}, switchProject: async () => ({ ok: true }), loadDetail: async () => ({ ok: true }) },
})
const out = TaskCenter({})
assert.equal(out.type, 'div')
assert.equal(out.props.className, 'gbt-root')
assert.equal(out.props['data-panel'], 'task-center')
assert.ok(JSON.stringify(out).includes('gbt-tabs'))
console.log('PASS  TaskCenter is an independently testable view module')
