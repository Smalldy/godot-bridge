import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskCenter } = require('../../client/src/views/task-center.cjs')
const { tcAgentTreeOf, tcAgentStatusKey } = require('../../client/src/selectors.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const view = (name) => (props) => ({ type: name, props: props })
const projectFormView = view('project-form')
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
  ProjectForm: projectFormView,
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

// ── T-181: the empty project state ───────────────────────────────────────────
// With no project the panel shows the "not activated" guidance and a manual
// entry; the project dialog is mounted ONLY from that entry (or the header
// action), and closing it must return to the guidance instead of re-rendering
// the modal in place. A hook harness keeps state across renders so the open →
// close → reopen cycle is exercised for real.
function createHookHarness() {
  const states = []
  const harness = {
    cursor: 0,
    React: {
      useState: function (initial) {
        const index = harness.cursor++
        if (index >= states.length) states.push(typeof initial === 'function' ? initial() : initial)
        return [
          states[index],
          function (next) {
            states[index] = typeof next === 'function' ? next(states[index]) : next
          },
        ]
      },
      useEffect: function () {},
    },
  }
  return harness
}

function renderAt(harness, Component, props) {
  harness.cursor = 0
  return Component(props)
}

function collect(node, predicate, found) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return
  }
  if (typeof node !== 'object') return
  if (predicate(node)) found.push(node)
  collect(node.props === undefined ? undefined : node.props.children, predicate, found)
}

const emptySnapshot = Object.assign({}, deps.useSnapshot(), {
  source: 'host',
  project: null,
  projectRoot: null,
  sessionProject: null,
  message: '',
})
const emptyHarness = createHookHarness()
const EmptyTaskCenter = createTaskCenter(Object.assign({}, deps, {
  React: emptyHarness.React,
  useSnapshot: () => emptySnapshot,
}))

const projectDialogs = (tree) => {
  const found = []
  collect(tree, (node) => node.type === projectFormView, found)
  return found
}
const openProjectEntryButtons = (tree) => {
  const found = []
  collect(tree, (node) => node.props !== undefined && node.props['data-action'] === 'open-project-empty', found)
  return found
}

// 1. Default empty state: guidance visible, dialog NOT mounted.
const emptyTree = renderAt(emptyHarness, EmptyTaskCenter, {})
const emptyJson = JSON.stringify(emptyTree)
assert.equal(projectDialogs(emptyTree).length, 0, 'the empty project state must not mount the project dialog by default')
assert.ok(emptyJson.includes('"data-not-activated":"true"'), 'the empty state keeps the not-activated guidance')
assert.ok(emptyJson.includes('notActivatedTitle'))
assert.ok(emptyJson.includes('notActivatedStepCall'))
assert.ok(emptyJson.includes('notActivatedStepOpen'))
assert.ok(emptyJson.includes('"data-not-activated-actions":"true"'), 'the empty state keeps a manual open-project entry')
assert.equal(openProjectEntryButtons(emptyTree).length, 1)
console.log('PASS  empty project state: guidance + manual entry, no auto-mounted dialog')

// 2. The manual entry opens the dialog.
openProjectEntryButtons(emptyTree)[0].props.onClick()
const openedTree = renderAt(emptyHarness, EmptyTaskCenter, {})
const openedDialogs = projectDialogs(openedTree)
assert.equal(openedDialogs.length, 1, 'the manual entry mounts exactly one project dialog')
assert.ok(JSON.stringify(openedTree).includes('"data-not-activated":"true"'), 'the guidance stays under the dialog')
console.log('PASS  empty project state: the manual entry opens the project dialog')

// 3. Closing (modal backdrop / cancel both call onClose) unmounts it and
//    returns to the SAME guidance, not straight back into the dialog.
openedDialogs[0].props.onClose()
const closedTree = renderAt(emptyHarness, EmptyTaskCenter, {})
assert.equal(projectDialogs(closedTree).length, 0, 'closing the dialog must unmount it')
assert.ok(JSON.stringify(closedTree).includes('"data-not-activated":"true"'))
const closedJson = JSON.stringify(closedTree)
assert.ok(!closedJson.includes('project-form'))
console.log('PASS  empty project state: closing the dialog returns to the guidance')

// 4. ...and the entry still reopens it afterwards.
const closedEntry = openProjectEntryButtons(closedTree)
assert.equal(closedEntry.length, 1, 'the manual entry survives the close')
closedEntry[0].props.onClick()
assert.equal(projectDialogs(renderAt(emptyHarness, EmptyTaskCenter, {})).length, 1, 'the manual entry reopens the dialog after a close')
console.log('PASS  empty project state: the dialog can be reopened after closing it')

// 5. Both locales route the empty-state first step through the task-center
//    entry skill (/godot-bridge-task-center-init), not just a bare
//    "call task_center" line.
const headSource = readFileSync(new URL('../../client/src/00-head.part', import.meta.url), 'utf8')
const stepCalls = [...headSource.matchAll(/notActivatedStepCall:\s*'([^']*)'/g)].map((match) => match[1])
assert.equal(stepCalls.length, 2, 'the zh and en locales both carry notActivatedStepCall')
for (const copy of stepCalls) assert.ok(copy.includes('/godot-bridge-task-center-init'), 'the empty-state copy names the task-center init skill: ' + copy)
const stepOpens = [...headSource.matchAll(/notActivatedStepOpen:\s*'([^']*)'/g)].map((match) => match[1])
assert.equal(stepOpens.length, 2, 'the zh and en locales both carry notActivatedStepOpen')
assert.ok(stepOpens[0].includes('打开项目'), 'the zh manual step names the visible entry')
assert.ok(stepOpens[1].includes('Open project'), 'the en manual step names the visible entry')
console.log('PASS  empty-state copy points at /godot-bridge-task-center-init in zh and en')
