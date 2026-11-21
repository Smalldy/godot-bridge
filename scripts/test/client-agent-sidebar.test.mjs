// T-209/T-212: the right-sidebar agent tab.
//
// The bundled view is required directly (like the other client-*.test.mjs
// suites) and mounted against a fake host, so the test proves the real
// registration contract: one custom tab kind, body/title slots keyed by the
// tab id, sidebar.openTabIn(sessionId, kind, { params: { taskId } }),
// uiWorkspace.openSession(sessionId) for the overview's conversation switch,
// the card's own session order, the role of the stage behind it, exact taskId
// resolution, and no throw when the optional host services are missing.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sidebar = require('../../client/src/views/agent-sidebar.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}

const React = {
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useEffect() {},
  useReducer(reducer, initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot() },
}

const copy = {
  openInSidebar: '在侧边栏打开',
  openInSidebarHint: '在右侧栏打开这个任务的 Agent',
  agentTabTitle: '代理',
  agentTabHint: '在右侧栏跟随任务卡上的执行 Agent',
  agentRole: '角色',
  agentTask: '任务',
  agentTabStage: '阶段',
  agentTabActivity: '最近活动',
  agentTabNoSession: '没有可显示的会话',
  agentTabNoTask: '没有关联任务',
  agentTabNoActivity: '没有活动记录',
  agentTabOpenSession: '打开子代理会话',
  agentTabOpenSessionHint: '在主页打开这个子代理的会话',
  agentStatusRunning: '运行中',
  agentStatusIdle: '空闲',
  agentStatusFailed: '失败',
  agentStatusUnknown: '状态未知',
  agentRootRole: '根代理',
  roleKindWorker: '实现',
  roleKindReviewer: '评审',
  roleKindTester: '测试',
  'evtLabel-submit': '提交',
  'evtLabel-dispatch': '派发',
  runningCol: '实现中',
}
const t = (key) => (copy[key] === undefined ? key : copy[key])
const locale = {
  bind() { return t },
  subscribe() { return () => {} },
}

const phase = { pending: '等待', running: '实现中', reviewing: '评审中', testing: '测试中', blocked: '阻塞', cancelled: '已取消', done: '完成' }
const helpers = {
  tcAgentTreeOf: (snapshot) => (snapshot === null || snapshot === undefined ? null : snapshot.agentTree),
  tcPhaseLabel: (task) => (task === null || task === undefined ? '—' : phase[task.status] === undefined ? task.status : phase[task.status]),
  tcAgo: () => '3m',
  tcAgentStatusKey: (status) => (status === 'running' ? 'agentStatusRunning' : status === 'failed' ? 'agentStatusFailed' : status === 'idle' ? 'agentStatusIdle' : 'agentStatusUnknown'),
}

// ── one card that names all four agent sessions ─────────────────────────────
const task = {
  id: 'T-212',
  title: 'Agent sidebar',
  status: 'running',
  assignee: { name: 'worker-t-212', session: 'session-w212' },
  lastAssignee: { name: 'worker-prev-212', session: 'session-prev212' },
  review: { status: 'pending', deliveredTo: { id: 'session-rev212', name: 'reviewer-t-212' } },
  test: { status: 'pending', deliveredTo: { id: 'session-test212', name: 'tester-t-212' } },
  ownerSession: 'session-root',
  updatedAt: '2026-11-21T06:00:00.000Z',
  history: [],
}
const agentTree = {
  available: true,
  root: { id: 'session-root', name: 'lead', role: 'lead', status: 'running', taskId: null },
  members: [
    { id: 'session-w212', name: 'worker-t-212', role: 'worker', status: 'running', taskId: 'T-212' },
    { id: 'session-rev212', name: 'reviewer-t-212', role: 'reviewer', status: 'idle', taskId: 'T-212' },
    { id: 'session-test212', name: 'tester-t-212', role: 'tester', status: 'idle', taskId: 'T-212' },
  ],
  count: 3,
  error: null,
}
const snapshot = {
  tasks: [task],
  agentTree: agentTree,
  activityEvents: {
    available: true,
    entries: [{ key: 'evt-1', taskId: 'T-212', kind: 'submit', at: '2026-11-21T06:01:00.000Z', detail: '@abc1234' }],
  },
}
// The mounted store the tab reads; the exact-card block swaps the board for a
// two-card snapshot so the body resolves through the same production path.
let storeSnapshot = snapshot
const store = {
  subscribe() { return () => {} },
  getSnapshot() { return storeSnapshot },
}

function createHost(options) {
  const opts = options === undefined ? {} : options
  const calls = { tabs: [], openTabIn: [], sessions: [], slots: [], slotDisposals: 0, tabDisposals: 0 }
  const registered = []
  const services = {}
  if (opts.sidebar !== false) {
    services.sidebarRight = {
      openTabIn(sessionId, kind, options) {
        calls.openTabIn.push(arguments.length >= 3 ? [sessionId, kind, options] : [sessionId, kind])
        if (opts.openThrows === true) throw new Error('sidebar unavailable')
      },
    }
  }
  if (opts.tabs !== false) {
    services.sidebarRightTabs = {
      register(spec) {
        calls.tabs.push(spec)
        if (opts.tabsThrow === true) throw new Error('tab rejected')
        return function () { calls.tabDisposals += 1 }
      },
    }
  }
  if (opts.workspace !== false) {
    services.uiWorkspace = {
      openSession(sessionId) {
        calls.sessions.push(sessionId)
        if (opts.workspaceThrows === true) throw new Error('workspace unavailable')
      },
    }
  }
  const host = {
    get(name) { return services[name] === undefined ? null : services[name] },
    slots: opts.slots === false ? undefined : {
      inject(name, callback) {
        calls.slots.push('inject:' + name)
        if (opts.injectThrows === true) throw new Error('slot unavailable')
        return callback()
      },
      register(spec, component) {
        registered.push({ spec: spec, component: component })
        return function () { calls.slotDisposals += 1 }
      },
    },
  }
  return { host: host, calls: calls, registered: registered }
}

function createView() {
  return sidebar.createAgentSidebar({
    React: React,
    h: h,
    tcAgentTreeOf: helpers.tcAgentTreeOf,
    tcPhaseLabel: helpers.tcPhaseLabel,
    tcAgo: helpers.tcAgo,
    tcAgentStatusKey: helpers.tcAgentStatusKey,
  })
}

/** Depth-first search of the fake vnode tree for a node whose props match. */
function findNode(node, predicate) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (predicate(node) === true) return node
  return findNode(node.props === undefined ? undefined : node.props.children, predicate)
}

function openButtonOf(body) {
  return findNode(body, (node) => node.props !== undefined && node.props['data-agent-action'] === 'open-session')
}

/** A host tab-info hook as the slot framework hands it to a body: navigation.params. */
function tabInfoWith(taskId) {
  return () => ({ tab: { navigation: { params: taskId === null ? {} : { taskId: taskId } } } })
}

// ── the session helper: the card's own order, never a minted id ─────────────
const fullCard = {
  assignee: { name: 'w', session: 'session-assignee' },
  lastAssignee: { name: 'p', session: 'session-last' },
  review: { deliveredTo: { id: 'session-review', name: 'r' } },
  test: { deliveredTo: { id: 'session-test', name: 't' } },
  ownerSession: 'session-owner',
}
assert.equal(sidebar.agentSessionOf({ id: 'T-1' }), null, 'a card without a recorded session has no entry')
assert.equal(sidebar.agentSessionOf(fullCard), 'session-assignee', 'the current executor wins')
assert.equal(sidebar.agentSessionOf(Object.assign({}, fullCard, { assignee: null })), 'session-last', 'the previous executor is the next fallback')
assert.equal(sidebar.agentSessionOf(Object.assign({}, fullCard, { assignee: null, lastAssignee: null })), 'session-review', 'the review deliverer is the next fallback')
assert.equal(sidebar.agentSessionOf(Object.assign({}, fullCard, { assignee: null, lastAssignee: null, review: null })), 'session-test', 'the test deliverer is the next fallback')
assert.equal(sidebar.agentSessionOf(Object.assign({}, fullCard, { assignee: null, lastAssignee: null, review: null, test: null })), 'session-owner', 'the owning session is the last fallback')
assert.equal(sidebar.agentSessionOf({ assignee: { session: '   ' }, lastAssignee: { session: '' }, review: null, test: null, ownerSession: '  ' }), null, 'blank ids are not sessions')
assert.deepEqual(
  Object.keys(sidebar.AGENT_TAB_COPY.zh).sort(),
  Object.keys(sidebar.AGENT_TAB_COPY.en).sort(),
  'the tab ships the same keys in both locales',
)
assert.ok(sidebar.AGENT_TAB_COPY.zh.agentTabOpenSession !== undefined, 'the conversation switch is localized')
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttab'), 'the tab ships its own token-only styles')
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttabopen'), 'the conversation switch has its own style')
assert.equal(sidebar.available(), false, 'nothing is available before a mount')
assert.equal(sidebar.openIn('session-w212'), false, 'openIn without a host is a quiet false')

// ── registration + openTabIn(params) + the tab body/title ───────────────────
const api = createView()
const mounted = createHost()
const dispose = api.mount(mounted.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(sidebar.available(), true, 'a successful mount makes the entry available')
assert.equal(api.hasWorkspace(), true, 'the mounted host provides uiWorkspace')
assert.equal(sidebar.label('openInSidebar'), '在侧边栏打开', 'the shared label helper resolves the entry copy')
assert.equal(api.label('agentTabTitle'), '代理', 'the overview tab is still the agent tab')
assert.equal(api.label('agentTabOpenSession'), '打开子代理会话', 'the conversation switch is labeled')
assert.equal(mounted.calls.tabs.length, 1, 'exactly one tab is registered')
const spec = mounted.calls.tabs[0]
assert.equal(spec.id, 'godot-bridge/agent', 'the tab has OUR id (not a DSH private agent kind)')
assert.equal(spec.kind, 'godot-bridge-agent', 'the tab has OUR kind')
assert.equal(typeof spec.title, 'function')
assert.equal(spec.title(), '代理', 'the tab title is localized through the plugin locale')
assert.deepEqual(mounted.calls.slots, ['inject:sidebar.right.pane.tab', 'inject:sidebar.right.pane.tab.title'], 'body and title slots are waited for')
assert.equal(mounted.registered.length, 2, 'body and title components are registered')
const bodySpec = mounted.registered.filter((entry) => entry.spec.name === 'sidebar.right.pane.tab')[0]
const titleSpec = mounted.registered.filter((entry) => entry.spec.name === 'sidebar.right.pane.tab.title')[0]
assert.ok(bodySpec !== undefined, 'the body slot is registered')
assert.ok(titleSpec !== undefined, 'the title slot is registered')
assert.equal(bodySpec.spec.key, 'godot-bridge/agent', 'the body is keyed by the tab id')
assert.equal(titleSpec.spec.key, 'godot-bridge/agent', 'the title is keyed by the tab id')
assert.equal(typeof bodySpec.component, 'function')
assert.equal(typeof titleSpec.component, 'function')
assert.equal(spec.guide.length, 1, 'the overview stays a guide entry too')
assert.equal(spec.guide[0].title(), '代理')
assert.equal(spec.guide[0].description(), '在右侧栏跟随任务卡上的执行 Agent')
assert.equal(typeof spec.guide[0].icon, 'function')

// The card entry hands over only the session; the tab resolves the card once
// and carries its id in the navigation params so the body shows THAT card.
assert.equal(sidebar.openIn('session-w212'), true, 'openIn forwards to the host')
assert.deepEqual(mounted.calls.openTabIn, [['session-w212', 'godot-bridge-agent', { params: { taskId: 'T-212' } }]], 'openTabIn gets the REAL session, OUR kind and the exact card')
assert.equal(api.openIn('session-rev212', 'T-EXPLICIT'), true, 'an explicit taskId is forwarded verbatim')
assert.deepEqual(mounted.calls.openTabIn[1], ['session-rev212', 'godot-bridge-agent', { params: { taskId: 'T-EXPLICIT' } }], 'the explicit card travels in the params')
assert.equal(sidebar.openIn('session-unknown'), true, 'a session with no card still opens the overview')
assert.deepEqual(mounted.calls.openTabIn[2], ['session-unknown', 'godot-bridge-agent'], 'without a card the open carries no params')
assert.equal(sidebar.openIn(''), false, 'an empty session is refused')
assert.equal(sidebar.openIn(null), false, 'a missing session is refused')
assert.equal(sidebar.openIn(42), false, 'a non-string session is refused')

// ── the four sessions of one card resolve their own role and name ───────────
const workerInfo = api.infoOf(snapshot, 'session-w212', t, 1000)
assert.equal(workerInfo.name, 'worker-t-212')
assert.equal(workerInfo.role, 'worker')
assert.equal(workerInfo.roleLabel, '实现')
assert.equal(workerInfo.status, 'running')
assert.equal(workerInfo.statusLabelKey, 'agentStatusRunning')
assert.equal(workerInfo.taskId, 'T-212')
assert.equal(workerInfo.stage, '实现中')
assert.equal(workerInfo.activity.labelKey, 'evtLabel-submit')

const reviewerInfo = api.infoOf(snapshot, 'session-rev212', t, 1000)
assert.equal(reviewerInfo.name, 'reviewer-t-212', 'the review deliverer is named from the card')
assert.equal(reviewerInfo.role, 'reviewer')
assert.equal(reviewerInfo.roleLabel, '评审')
assert.equal(reviewerInfo.taskId, 'T-212')

const testerInfo = api.infoOf(snapshot, 'session-test212', t, 1000)
assert.equal(testerInfo.name, 'tester-t-212', 'the test deliverer is named from the card')
assert.equal(testerInfo.role, 'tester')
assert.equal(testerInfo.roleLabel, '测试')
assert.equal(testerInfo.taskId, 'T-212')

const rootInfo = api.infoOf(snapshot, 'session-root', t, 1000)
assert.equal(rootInfo.role, 'root', 'the owning session is the root Agent')
assert.equal(rootInfo.roleLabel, '根代理')
assert.equal(rootInfo.name, 'lead', 'the root Agent is named from the live tree')
assert.equal(rootInfo.taskId, 'T-212')

// A session that is the card's executor AND its owner stays the worker: the
// forbidden pairing (worker name + root Agent role) never comes back.
const ownedByRoot = Object.assign({}, task, {
  assignee: { name: 'worker-on-root', session: 'session-root' },
  lastAssignee: null,
  review: null,
  test: null,
})
const ownedSnapshot = { tasks: [ownedByRoot], agentTree: agentTree, activityEvents: null }
const ownedInfo = api.infoOf(ownedSnapshot, 'session-root', t, 1000)
assert.equal(ownedInfo.role, 'worker', 'the executor role wins over the owner role')
assert.equal(ownedInfo.roleLabel, '实现', 'a worker name is never paired with the root Agent role')
assert.equal(ownedInfo.name, 'worker-on-root', 'the root tree name does not leak onto the worker row')

// The previous executor is still a worker session.
const previousOnly = Object.assign({}, task, { status: 'blocked', assignee: null })
const previousSnapshot = { tasks: [previousOnly], agentTree: agentTree, activityEvents: null }
const previousInfo = api.infoOf(previousSnapshot, 'session-prev212', t, 1000)
assert.equal(previousInfo.role, 'worker', 'lastAssignee is the worker fallback')
assert.equal(previousInfo.name, 'worker-prev-212')

// ── the overview renders the switch and calls uiWorkspace.openSession ───────
const workerBody = api.Body({ sessionId: 'session-w212', useTabInfo: tabInfoWith('T-212') })
const workerBodyText = JSON.stringify(workerBody)
assert.ok(workerBodyText.includes('worker-t-212'), 'the body shows the agent name')
assert.ok(workerBodyText.includes('实现'), 'the body shows the role')
assert.ok(workerBodyText.includes('运行中'), 'the body shows the status')
assert.ok(workerBodyText.includes('T-212'), 'the body shows the task id')
assert.ok(workerBodyText.includes('实现中'), 'the body shows the stage')
assert.ok(workerBodyText.includes('最近活动'), 'the body shows the activity section')
assert.ok(workerBodyText.includes('提交'), 'the body shows the latest activity')
assert.ok(workerBodyText.includes('打开子代理会话'), 'the overview carries the conversation switch')
assert.equal(workerBody.props['data-agent-session'], 'session-w212')
assert.equal(workerBody.props['data-agent-task'], 'T-212')
assert.equal(workerBody.props['data-agent-role'], 'worker')

// A host that hands no tab info (older shell) falls back to the session card.
const legacyBody = api.Body({ sessionId: 'session-w212' })
assert.equal(legacyBody.props['data-agent-task'], 'T-212', 'without tab info the body falls back to the session card')
assert.equal(legacyBody.props['data-agent-role'], 'worker')

const openButton = openButtonOf(workerBody)
assert.ok(openButton !== null, 'the switch is a real button')
assert.equal(openButton.props['data-agent-session'], 'session-w212')
assert.equal(typeof openButton.props.onClick, 'function')
assert.doesNotThrow(() => openButton.props.onClick({}), 'clicking the switch never throws')
assert.deepEqual(mounted.calls.sessions, ['session-w212'], 'clicking the switch asks uiWorkspace to open THAT session')

// A root session is not a subagent: the overview has nothing to switch to.
const rootBody = api.Body({ sessionId: 'session-root', useTabInfo: tabInfoWith('T-212') })
assert.equal(openButtonOf(rootBody), null, 'the switch is omitted on the root Agent')

const title = api.Title({ sessionId: 'session-w212', useTabInfo: tabInfoWith('T-212') })
assert.ok(JSON.stringify(title).includes('worker-t-212'), 'the title names the agent')
const reviewerTitle = api.Title({ sessionId: 'session-rev212', useTabInfo: tabInfoWith('T-212') })
assert.ok(JSON.stringify(reviewerTitle).includes('reviewer-t-212'), 'the title resolves the exact card too')
const emptyBody = api.Body({ sessionId: '' })
assert.ok(JSON.stringify(emptyBody).includes('没有可显示的会话'), 'an empty tab says it has no session')

const openConversation = api.openConversation('session-rev212')
assert.equal(openConversation, true, 'openConversation forwards to uiWorkspace')
assert.deepEqual(mounted.calls.sessions, ['session-w212', 'session-rev212'])
assert.equal(api.openConversation(''), false, 'an empty session is not opened')
assert.equal(api.openConversation(null), false, 'a missing session is not opened')

// ── exact taskId resolution beats the session fallback ──────────────────────
const exactPrimary = { id: 'T-A', title: 'primary', status: 'running', assignee: { name: 'worker-a', session: 'session-s' }, lastAssignee: null, review: null, test: null, ownerSession: 'session-owner', updatedAt: '2026-11-21T06:05:00.000Z', history: [] }
const exactReview = { id: 'T-B', title: 'review card', status: 'reviewing', assignee: null, lastAssignee: null, review: { status: 'pending', deliveredTo: { id: 'session-s', name: 'reviewer-b' } }, test: null, ownerSession: 'session-owner', updatedAt: '2026-11-21T06:06:00.000Z', history: [] }
const exactSnapshot = { tasks: [exactPrimary, exactReview], agentTree: agentTree, activityEvents: null }
const bySession = api.infoOf(exactSnapshot, 'session-s', t, 1000)
assert.equal(bySession.taskId, 'T-A', 'without a param the executor card wins over the review card')
const exactInfo = api.infoOf(exactSnapshot, 'session-s', t, 1000, 'T-B')
assert.equal(exactInfo.taskId, 'T-B', 'an explicit taskId resolves THAT card')
assert.equal(exactInfo.role, 'reviewer', 'the role follows the resolved card')
assert.equal(exactInfo.name, 'reviewer-b', 'the name follows the resolved card')
assert.equal(exactInfo.stage, '评审中')
storeSnapshot = exactSnapshot
try {
  const exactBody = api.Body({ sessionId: 'session-s', useTabInfo: tabInfoWith('T-B') })
  assert.equal(exactBody.props['data-agent-task'], 'T-B', 'the body reads the exact card from the navigation params')
  assert.equal(exactBody.props['data-agent-role'], 'reviewer')
  assert.ok(JSON.stringify(exactBody).includes('reviewer-b'), 'the body names the resolved card session')
  const exactByProp = api.Body({ sessionId: 'session-s', taskId: 'T-B' })
  assert.equal(exactByProp.props['data-agent-task'], 'T-B', 'an explicit taskId prop is honoured too')
} finally {
  storeSnapshot = snapshot
}
const goneInfo = api.infoOf(exactSnapshot, 'session-s', t, 1000, 'T-GONE')
assert.equal(goneInfo.taskId, 'T-GONE', 'a card that left the board keeps its id instead of borrowing another card')
assert.equal(goneInfo.stage, '没有关联任务', 'a gone card shows no fake stage')
assert.equal(goneInfo.activity, null, 'a gone card shows no borrowed activity')

dispose()
assert.equal(sidebar.available(), false, 'dispose removes the entry')
assert.equal(sidebar.openIn('session-w212'), false, 'openIn is a quiet false after dispose')
assert.equal(api.openConversation('session-w212'), false, 'openConversation is a quiet false after dispose')
assert.equal(mounted.calls.tabDisposals, 1, 'the tab registration is released')
assert.equal(mounted.calls.slotDisposals, 2, 'both slot registrations are released')

// ── no uiWorkspace: the overview mounts, the switch is hidden ───────────────
const withoutWorkspace = createHost({ workspace: false })
const withoutWorkspaceView = createView()
const withoutWorkspaceDispose = withoutWorkspaceView.mount(withoutWorkspace.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(withoutWorkspaceView.isMounted(), true, 'the overview mounts without uiWorkspace')
assert.equal(withoutWorkspaceView.hasWorkspace(), false, 'no uiWorkspace means no switch')
assert.equal(withoutWorkspaceView.openConversation('session-w212'), false, 'openConversation degrades to false')
assert.doesNotThrow(() => withoutWorkspaceView.openConversation('session-w212'), 'a missing uiWorkspace never throws')
const workspaceLessBody = withoutWorkspaceView.Body({ sessionId: 'session-w212', useTabInfo: tabInfoWith('T-212') })
assert.equal(openButtonOf(workspaceLessBody), null, 'the switch is hidden without uiWorkspace')
assert.ok(JSON.stringify(workspaceLessBody).includes('worker-t-212'), 'the rest of the overview still renders')
assert.equal(withoutWorkspaceView.openIn('session-w212'), true, 'opening the tab still works without uiWorkspace')
withoutWorkspaceDispose()

// ── missing sidebar services: hide, never throw ─────────────────────────────
for (const variant of [
  { sidebar: false },
  { tabs: false },
  { slots: false },
  { tabsThrow: true },
  { injectThrows: true },
]) {
  const off = createHost(variant)
  const view = createView()
  let disposal = null
  assert.doesNotThrow(() => {
    disposal = view.mount(off.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
  }, 'a missing/rejecting sidebar service must not throw')
  assert.equal(typeof disposal, 'function', 'mount always returns a disposer')
  assert.equal(view.isMounted(), false, 'a failed mount stays unavailable')
  assert.equal(sidebar.available(), false, 'the card/detail entry stays hidden')
  assert.equal(sidebar.openIn('session-w212'), false, 'openIn degrades to false')
  assert.equal(view.openConversation('session-w212'), false, 'openConversation degrades to false')
  assert.doesNotThrow(() => disposal(), 'the disposer is safe after a failed mount')
}

// ── a throwing openTabIn / openSession must not escape ─────────────────────
const throwing = createHost({ openThrows: true, workspaceThrows: true })
const throwingView = createView()
const throwingDispose = throwingView.mount(throwing.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(sidebar.available(), true)
assert.equal(sidebar.openIn('session-w212'), false, 'openTabIn errors are reported as false, not thrown')
assert.equal(throwingView.openConversation('session-w212'), false, 'openSession errors are reported as false, not thrown')
const throwingBody = throwingView.Body({ sessionId: 'session-w212', useTabInfo: tabInfoWith('T-212') })
const throwingButton = openButtonOf(throwingBody)
assert.ok(throwingButton !== null, 'the switch is rendered when uiWorkspace exists')
assert.doesNotThrow(() => throwingButton.props.onClick({}), 'a throwing openSession does not escape the click')
throwingDispose()

// ── 40-tail / shipped bundle carry the same wiring ──────────────────────────
const TAIL = readFileSync(new URL('../../client/src/40-tail.part', import.meta.url), 'utf8')
const BUNDLE = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
assert.ok(TAIL.includes("ctx.inject(['sidebarRight', 'sidebarRightTabs', 'uiWorkspace']"), 'the sidebar injection also waits for uiWorkspace')
assert.ok(TAIL.includes('uiWorkspace: scoped === null || scoped === undefined ? null : scoped.uiWorkspace'), 'the mount receives the uiWorkspace service')
assert.ok(TAIL.includes('return tab.mount(scoped, {'), 'the tab still mounts on the scoped services')
assert.ok(BUNDLE.includes("ctx.inject(['sidebarRight', 'sidebarRightTabs', 'uiWorkspace']"), 'the shipped bundle carries the same sidebar injection')
assert.ok(BUNDLE.includes('agentTabOpenSession'), 'the shipped bundle carries the conversation switch')

console.log('PASS  agent sidebar registers its own tab kind, opens real sessions with their card, switches to the subagent conversation and degrades safely')
