import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskCenter } = require('../../client/src/views/task-center.cjs')
const { createTaskStore } = require('../../client/src/store.cjs')
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
  // T-205: the settings entry mounts this page (never a modal form).
  SettingsPage: view('settings-page'),
  engineScopeOf: () => null,
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
    scope: { panelSession: null, sessionSummaries: [] },
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

// ── T-210: the header is ready from the LIGHT state, not from the inventory ──
// The light /state carries the session scope while the agent tree is deferred to
// /meta. The header must render (and the sessions pill must be usable) with the
// cards; only the deferred agent pill may still say 'loading'. A FAILED
// metadata request says so instead of spinning forever, and never blocks the
// board or the header.
{
  const lightSnapshot = Object.assign({}, deps.useSnapshot(), {
    agentTree: { available: false, root: null, members: [], count: 0, error: 'deferred' },
    scope: { panelSession: 'session-test', currentSessionProject: '/repo', light: true, sessionSummaries: [{ sessionId: 'session-test', status: 'live', cards: { owned: 1, active: 0 } }] },
    environment: null,
    worktrees: { available: false, error: 'deferred', total: null, active: null, counts: null, worktrees: [] },
    metadata: { status: 'loading', errors: {} },
  })
  const lightJson = JSON.stringify(createTaskCenter(Object.assign({}, deps, { useSnapshot: () => lightSnapshot }))({}))
  assert.ok(lightJson.includes('"data-header-ready":"true"'), 'the header is ready before the inventory')
  assert.ok(lightJson.includes('"data-metadata-state":"loading"'), 'the deferred blocks report their own state')
  assert.ok(lightJson.includes('"data-sessions-count":"1"'), 'the sessions pill is usable from the light scope')
  assert.ok(lightJson.includes('"data-sessions-pill":"true"') && !lightJson.includes('"data-sessions-count":"loading"'), 'the sessions pill is NOT waiting for the inventory')
  assert.ok(lightJson.includes('"data-agent-pill":"loading"'), 'the deferred agent pill is the only thing loading')
  assert.ok(lightJson.includes('gbt-tabs'), 'the board shell renders while the metadata is still out')
  console.log('PASS  T-210 the header renders from the light state while the agent tree is deferred')

  const degradedSnapshot = Object.assign({}, lightSnapshot, { metadata: { status: 'degraded', errors: { agentTree: 'host unavailable' } } })
  const degradedJson = JSON.stringify(createTaskCenter(Object.assign({}, deps, { useSnapshot: () => degradedSnapshot }))({}))
  assert.ok(degradedJson.includes('"data-header-ready":"true"'), 'a failed metadata request still leaves the header ready')
  assert.ok(degradedJson.includes('"data-agent-degraded":"true"'), 'the failed deferred block is named as degraded')
  assert.ok(degradedJson.includes('"data-agent-pill":"none"'), 'a degraded agent pill never reports a fake live count')
  assert.ok(!degradedJson.includes('"data-agent-pill":"loading"'), 'a degraded agent pill stops spinning')
  console.log('PASS  T-210 a failed metadata request degrades the agent pill instead of blocking the header')
}

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

// ── T-182: no-project-bound is a SETUP state, not a failed operation ───────
// The host answers { ok: false, code: 'no-project-bound' } before any project is
// opened. The panel used to turn that into a generic "操作失败" banner that then
// outlived the binding. It must read as "no project selected yet", carry the
// open-project entry, and never raise the alarm banner.
const unboundSnapshot = Object.assign({}, deps.useSnapshot(), {
  source: 'setup',
  project: null,
  projectRoot: null,
  sessionProject: null,
  message: '',
  tasks: [],
  counts: {},
})
const unboundHarness = createHookHarness()
const UnboundTaskCenter = createTaskCenter(Object.assign({}, deps, {
  React: unboundHarness.React,
  useSnapshot: () => unboundSnapshot,
}))
const unboundTree = renderAt(unboundHarness, UnboundTaskCenter, {})
const unboundJson = JSON.stringify(unboundTree)
assert.equal(unboundJson.includes('gbt-banner'), false, 'an unbound session must not raise a banner')
assert.ok(unboundJson.includes('"data-unbound":"true"'), 'the empty state marks itself as unbound')
assert.ok(unboundJson.includes('projectUnknown'), 'the empty state says no project has been selected')
assert.ok(!unboundJson.includes('notActivatedTitle'), 'the unbound copy replaces the generic not-activated title')
assert.ok(unboundJson.includes('"data-action":"open-project"'), 'the header open-project tab survives')
assert.equal(openProjectEntryButtons(unboundTree).length, 1, 'the setup state keeps its manual open-project entry')
assert.equal(projectDialogs(unboundTree).length, 0, 'the setup state still does not auto-mount the dialog')
openProjectEntryButtons(unboundTree)[0].props.onClick()
assert.equal(projectDialogs(renderAt(unboundHarness, UnboundTaskCenter, {})).length, 1, 'the setup entry still opens the project dialog')
console.log('PASS  an unbound session renders its setup state, never a failure banner')

// A setup snapshot is silent only while it has nothing to report: a real
// action failure in the setup state (a bind that could not reach the host)
// must surface its reason instead of hiding it — the setup wording stays.
const failedSetupSnapshot = Object.assign({}, unboundSnapshot, { message: 'connect ECONNREFUSED 127.0.0.1:9090' })
const failedSetupJson = JSON.stringify(createTaskCenter(Object.assign({}, deps, { useSnapshot: () => failedSetupSnapshot }))({}))
assert.ok(failedSetupJson.includes('gbt-banner'), 'a setup snapshot with a real failure keeps a banner')
assert.ok(failedSetupJson.includes('ECONNREFUSED'), 'the real reason is surfaced, not suppressed')
assert.ok(failedSetupJson.includes('"data-unbound":"true"'), 'the empty state still asks for a project')
console.log('PASS  a setup snapshot with a real failure surfaces its reason')

// A real failure keeps reporting itself: the banner and its reason are still there.
const failedSnapshot = Object.assign({}, deps.useSnapshot(), {
  source: 'error',
  project: null,
  projectRoot: null,
  sessionProject: null,
  message: 'connect ECONNREFUSED 127.0.0.1:9090',
  tasks: [],
  counts: {},
})
const failedJson = JSON.stringify(createTaskCenter(Object.assign({}, deps, { useSnapshot: () => failedSnapshot }))({}))
assert.ok(failedJson.includes('gbt-banner'), 'a real failure keeps its banner')
assert.ok(failedJson.includes('ECONNREFUSED'), 'a real failure keeps its reason')
console.log('PASS  setup is silent while a real failure still reports its reason')

// The store side: the same code must become a setup snapshot, and the next good
// /state (or a successful binding) must clear whatever text was left behind.
function storeSnapshot(payload, source, message) {
  return {
    ok: payload.ok !== false,
    source: source,
    message: message === undefined ? '' : message,
    project: typeof payload.project === 'string' ? payload.project : null,
    projectRoot: typeof payload.project === 'string' ? payload.project : null,
    // T-203: where the Host said the project came from (session / panel /
    // explicit / unbound). The setup snapshot must carry it too.
    resolvedFrom: typeof payload.resolvedFrom === 'string' ? payload.resolvedFrom : null,
    sessionProject: typeof payload.sessionProject === 'string' ? payload.sessionProject : null,
    tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
    counts: payload.counts === undefined ? {} : payload.counts,
    details: {},
    seq: null,
    activityEvents: null,
    actionResult: null,
    actionError: null,
  }
}
const storeDeps = {
  TC_STATE_URL: '/state',
  TC_WORKTREES_URL: '/worktrees',
  TC_TASK_URL: '/task',
  TC_LIST_URL: '/list',
  TC_ACTION_URL: '/action',
  tcSnapshot: storeSnapshot,
  tcPinnedProject: () => null,
  tcMergeSnapshot: (previous, payload) => Object.assign({}, previous, storeSnapshot(payload, 'host', '')),
  tcErrorMessage: (payload, t) => {
    const code = payload !== null && payload !== undefined && typeof payload.code === 'string' ? payload.code : ''
    if (code === 'no-project-bound') return t('err_no_project_bound')
    if (payload !== null && payload !== undefined && typeof payload.message === 'string' && payload.message !== '') return payload.message
    return t('error')
  },
  tcWithSession: (url) => url,
  tcSessionId: () => 'session-test',
  tcPinProject: () => {},
}
const answers = []
// A queued Error simulates a rejected fetch (the failed-bind regression below).
globalThis.fetch = async () => {
  const next = answers.shift()
  if (next instanceof Error) throw next
  return { json: async () => next }
}
const boundStore = createTaskStore((key) => key, storeDeps)

answers.push({ ok: false, code: 'no-project-bound', params: {} })
await boundStore.load()
assert.equal(boundStore.getSnapshot().source, 'setup', 'no-project-bound is a setup state')
assert.equal(boundStore.getSnapshot().project, null, 'the setup snapshot has no project')
assert.equal(boundStore.getSnapshot().message, '', 'the setup snapshot carries no failure text')
// T-203: "nothing is bound" NAMES its source, even when an older Host omits it.
assert.equal(boundStore.getSnapshot().resolvedFrom, 'unbound', 'the setup snapshot names its source as unbound')
assert.equal(boundStore.getSnapshot().sessionProject, null, 'the setup snapshot never inherits a session project')
console.log('PASS  the store maps no-project-bound to the setup state, not to an error')

answers.push({ ok: true, full: true, project: '/repo', tasks: [], counts: {} })
await boundStore.load()
assert.equal(boundStore.getSnapshot().source, 'host')
assert.equal(boundStore.getSnapshot().project, '/repo')
assert.equal(boundStore.getSnapshot().message, '')

// A real /state failure is reported, and the next good answer clears it.
answers.push({ ok: false, code: 'failed', message: 'board read failed' })
await boundStore.load()
assert.equal(boundStore.getSnapshot().source, 'error')
assert.equal(boundStore.getSnapshot().message, 'board read failed')
answers.push({ ok: true, full: true, project: '/repo', tasks: [], counts: {} })
await boundStore.load()
assert.equal(boundStore.getSnapshot().message, '', 'a successful /state clears the stale failure')
console.log('PASS  a real /state failure reports its reason and the next good answer clears it')

// An ACTION's own outcome is not wiped by a routine poll.
answers.push({ ok: false, code: 'blocked', message: 'start refused' })
const refused = await boundStore.send('start', {})
assert.equal(refused.ok, false)
assert.equal(boundStore.getSnapshot().message, 'start refused')
answers.push({ ok: true, full: true, project: '/repo', tasks: [], counts: {} })
await boundStore.load()
assert.equal(boundStore.getSnapshot().message, 'start refused', 'a routine poll keeps the action outcome')
// ...and an AUTOMATIC workspace follow (quiet) must not clear it either.
answers.push({ ok: true, project: '/followed', projectRoot: '/followed', tasks: [], counts: {} })
await boundStore.switchProject('/followed', { quiet: true })
assert.equal(boundStore.getSnapshot().message, 'start refused', 'a quiet follow keeps the action outcome')
console.log('PASS  an action outcome survives a routine poll and a quiet follow')

// Binding a project ends the setup state and takes the banner with it.
const bindingStore = createTaskStore((key) => key, storeDeps)
answers.push({ ok: false, code: 'no-project-bound', params: {} })
await bindingStore.load()
assert.equal(bindingStore.getSnapshot().source, 'setup')
answers.push({ ok: true, project: '/opened', projectRoot: '/opened', tasks: [], counts: {} })
const opened = await bindingStore.switchProject('/opened')
assert.equal(opened.ok, true)
assert.equal(bindingStore.getSnapshot().project, '/opened')
assert.equal(bindingStore.getSnapshot().source, 'host')
assert.equal(bindingStore.getSnapshot().message, '')
console.log('PASS  binding a project leaves the setup state and clears the banner')

// A bind the host cannot answer (rejected fetch) keeps the REAL reason in the
// snapshot: the dialog reads result.error and the panel banner surfaces
// store.message. The setup state stays, so the empty state keeps asking for a
// project; a later successful bind clears the failure.
const unreachableStore = createTaskStore((key) => key, storeDeps)
answers.push({ ok: false, code: 'no-project-bound', params: {} })
await unreachableStore.load()
assert.equal(unreachableStore.getSnapshot().source, 'setup')
answers.push(new Error('connect ECONNREFUSED 127.0.0.1:9090'))
const failedBind = await unreachableStore.switchProject('/unreachable')
assert.equal(failedBind.ok, false)
assert.ok(String(failedBind.error && failedBind.error.message).includes('ECONNREFUSED'), 'the dialog receives the thrown error')
assert.equal(unreachableStore.getSnapshot().source, 'setup', 'the setup state survives a failed bind')
assert.ok(unreachableStore.getSnapshot().message.includes('ECONNREFUSED'), 'the store keeps the real reason for the banner')
answers.push({ ok: true, project: '/opened', projectRoot: '/opened', tasks: [], counts: {} })
const recovered = await unreachableStore.switchProject('/opened')
assert.equal(recovered.ok, true)
assert.equal(unreachableStore.getSnapshot().source, 'host')
assert.equal(unreachableStore.getSnapshot().message, '')
console.log('PASS  a failed bind keeps its real reason and a later bind clears it')

// A bad path is still a real, readable failure.
answers.push({ ok: false, code: 'invalid-project', message: 'ENOENT: no such directory' })
const badPath = await bindingStore.switchProject('/does-not-exist')
assert.equal(badPath.ok, false)
assert.equal(bindingStore.getSnapshot().message, 'ENOENT: no such directory')
console.log('PASS  a bad project path still fails with its own reason')

// The fallback copy exists in both locales (a code with no dictionary entry would
// fall back to the generic "操作失败" everywhere it is used).
const zhStart = headSource.indexOf('zh: {')
const enStart = headSource.indexOf('en: {')
assert.ok(zhStart >= 0 && enStart > zhStart, 'both locale blocks exist')
const zhBlock = headSource.slice(zhStart, enStart)
const enBlock = headSource.slice(enStart)
assert.ok(zhBlock.includes("err_no_project_bound: '尚未选择项目"), 'the zh copy names the missing project')
assert.ok(enBlock.includes('err_no_project_bound:'), 'the en copy exists')
console.log('PASS  no-project-bound has explicit copy in both locales')

// ── T-203: the foreground carries its session and NAMES the project source ──
// (1) Every foreground request carries the session the panel acts as. A request
// without one is what let the Host fall back to "some project that was active
// last" and paint that board under a different conversation.
{
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      body:
        options !== undefined && options !== null && typeof options.body === 'string'
          ? JSON.parse(options.body)
          : null,
    })
    return { json: async () => ({ ok: true, full: true, project: '/repo', projectRoot: '/repo', resolvedFrom: 'session', sessionProject: '/repo', tasks: [], counts: {} }) }
  }
  const sessionDeps = Object.assign({}, storeDeps, {
    tcWithSession: (url) => url + (url.indexOf('?') >= 0 ? '&' : '?') + 'session=session-test',
  })
  const sessionStore = createTaskStore((key) => key, sessionDeps)
  await sessionStore.load()
  assert.ok(calls[0].url.indexOf('/state') === 0 && calls[0].url.indexOf('session=session-test') > 0, 'the /state request carries the session: ' + calls[0].url)
  await sessionStore.send('pause', {})
  assert.equal(calls[1].url, '/action?session=session-test', 'the action URL carries the session')
  assert.equal(calls[1].body.session, 'session-test', 'the action body carries the session')
  await sessionStore.listTasks({ status: 'done' })
  assert.ok(calls[2].url.indexOf('/list') === 0 && calls[2].url.indexOf('session=session-test') > 0, 'the list request carries the session')
  await sessionStore.loadWorktrees(['/repo/.worktrees/T-1-1'])
  assert.ok(calls[3].url.indexOf('/worktrees') === 0 && calls[3].url.indexOf('session=session-test') > 0, 'the worktrees request carries the session')
  console.log('PASS  T-203 every foreground request carries its session id')
}

// (2) The panel SHOWS where the project came from.
{
  // The DSH session-directory lookup IS this session's own workspace: it has to
  // read as the session source (the legacy map only knew 'session').
  const lookupSnapshot = Object.assign({}, deps.useSnapshot(), {
    resolvedFrom: 'session-lookup',
    project: '/repo',
    projectRoot: '/repo',
    sessionProject: '/repo',
  })
  const lookupJson = JSON.stringify(createTaskCenter(Object.assign({}, deps, { useSnapshot: () => lookupSnapshot }))({}))
  assert.ok(lookupJson.includes('"data-project-source":"session"'), 'a session-directory lookup shows the session source')
  assert.ok(lookupJson.includes('projectSourceSession'), 'and its localized label')

  // A Host that still names the next-to-useless 'last-active' source must not be
  // painted as this session's workspace source.
  const legacyJson = JSON.stringify(
    createTaskCenter(Object.assign({}, deps, { useSnapshot: () => Object.assign({}, lookupSnapshot, { resolvedFrom: 'last-active' }) }))({}),
  )
  assert.ok(!legacyJson.includes('"data-project-source":"last-active"'), 'a last-active source is never displayed as a source')
  assert.ok(!legacyJson.includes('"data-workspace-source":"last-active"'), 'and the scope bar never repeats it')

  // A panel pin against another session project: the scope bar names the PIN and
  // the mismatch instead of pretending the two workspaces are the same.
  const pinSnapshot = Object.assign({}, deps.useSnapshot(), {
    resolvedFrom: 'panel',
    project: '/pinned',
    projectRoot: '/pinned',
    sessionProject: '/session',
  })
  const pinJson = JSON.stringify(
    createTaskCenter(Object.assign({}, deps, { useSnapshot: () => pinSnapshot, projectMismatchOf: () => '/session' }))({}),
  )
  assert.ok(pinJson.includes('"data-workspace-scope":"true"'), 'the pin opens the workspace scope bar')
  assert.ok(pinJson.includes('"data-workspace-state":"switching"'), 'the bar reports the mismatch it is following')
  assert.ok(pinJson.includes('"data-workspace-source":"panel"'), 'the bar names the panel as the source')
  assert.ok(pinJson.includes('projectSourceManual'), 'the bar shows the pin label')

  // An unbound setup snapshot says plainly that the source is unbound.
  const setupJson = JSON.stringify(
    createTaskCenter(Object.assign({}, deps, { useSnapshot: () => Object.assign({}, unboundSnapshot, { resolvedFrom: 'unbound' }) }))({}),
  )
  assert.ok(setupJson.includes('"data-project-source":"unbound"'), 'the empty state names its source as unbound')
  assert.ok(setupJson.includes('"data-unbound":"true"'), 'and stays the setup state')
  assert.ok(!setupJson.includes('last-active'), 'the empty state never names a last-active project')
  console.log('PASS  T-203 the panel names session / panel / unbound instead of guessing')
}

// ── T-205: the settings entry opens a PAGE, not the dispatch-settings modal ──
// The old flow mounted a tall modal over the board. The entry now replaces the
// board with the shared SettingsPage (the same component the plugin bundle card
// mounts); cancel/back returns to the board. No modal element is involved.
{
  function firstOf(tree, predicate) {
    const found = []
    collect(tree, predicate, found)
    return found.length === 0 ? null : found[0]
  }

  const settingsHarness = createHookHarness()
  const settingsPageView = view('settings-page')
  const settingsDeps = Object.assign({}, deps, {
    React: settingsHarness.React,
    SettingsPage: settingsPageView,
    engineScopeOf: () => 'config-scope',
  })
  const SettingsTaskCenter = createTaskCenter(settingsDeps)

  let tree = renderAt(settingsHarness, SettingsTaskCenter, {})
  assert.equal(firstOf(tree, (node) => node.props !== undefined && node.props['data-settings-open'] !== undefined), null, 'the board is the default, not the settings page')
  assert.equal(firstOf(tree, (node) => node.type === settingsPageView), null, 'the settings page is not mounted up front')

  const settingsEntry = firstOf(tree, (node) => node.type === 'button' && node.props !== undefined && node.props['data-action'] === 'settings')
  assert.ok(settingsEntry !== null, 'the task center keeps its settings entry')
  settingsEntry.props.onClick()
  tree = renderAt(settingsHarness, SettingsTaskCenter, {})

  const root = tree
  assert.equal(root.props['data-settings-open'], 'true', 'the panel switches to the settings page')
  const pageElement = firstOf(tree, (node) => node.type === settingsPageView)
  assert.ok(pageElement !== null, 'the shared SettingsPage is mounted')
  assert.equal(pageElement.props.mode, 'panel')
  assert.equal(typeof pageElement.props.t, 'function')
  assert.equal(pageElement.props.t('settingsPageTitle'), 'settingsPageTitle', 'the page speaks the task center locale')
  assert.equal(pageElement.props.snapshot.project, '/repo', 'the page reads the current task-center project')
  assert.equal(pageElement.props.engineScope, 'config-scope', 'the engine section receives the config scope')
  assert.equal(pageElement.props.store, settingsDeps.store, 'the page saves through the panel store')
  assert.equal(typeof pageElement.props.onClose, 'function', 'the page can return to the board')
  assert.ok(!JSON.stringify(tree).includes('gbt-overlay'), 'no modal overlay is mounted')
  assert.ok(!JSON.stringify(tree).includes('gbt-modal'), 'no modal shell is mounted over the board')

  pageElement.props.onClose()
  tree = renderAt(settingsHarness, SettingsTaskCenter, {})
  assert.equal(firstOf(tree, (node) => node.type === settingsPageView), null, 'closing the page unmounts it')
  assert.ok(JSON.stringify(tree).includes('gbt-tabs'), 'closing the page returns to the task center board')
  console.log('PASS  T-205 the settings entry opens the shared page, cancel returns to the board')

  // Rendering tests can also land directly on the page (the production slot
  // passes no props; this is the documented seam, not a hidden default).
  const directHarness = createHookHarness()
  const DirectTaskCenter = createTaskCenter(Object.assign({}, deps, { React: directHarness.React, SettingsPage: settingsPageView, engineScopeOf: () => null }))
  const directTree = renderAt(directHarness, DirectTaskCenter, { initialSettingsOpen: true })
  const directPage = firstOf(directTree, (node) => node.type === settingsPageView)
  assert.ok(directPage !== null, 'initialSettingsOpen lands on the page')
  assert.equal(directPage.props.engineScope, null, 'a runtime without a config form passes null, not a guessed scope')
  console.log('PASS  T-205 the settings page is reachable directly (and honestly unbound to a scope)')
}

