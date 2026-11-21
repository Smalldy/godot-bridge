// T-209/T-212/T-216: the right-sidebar agent tab.
//
// The bundled view is required directly (like the other client-*.test.mjs
// suites) and mounted against a fake host, so the test proves the real
// registration contract: one custom tab kind, body/title slots keyed by the
// tab id, the tab opened in the HOST's current session (T-216) with
// { params: { taskId, agentSession } }, sidebarRight.tabsIn() used to verify
// the placement (a host no-op is false, never a fake success),
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

// The HOST session whose right sidebar has an adopted surface. A subagent
// session never has one, which is exactly why T-216 must not open there.
const HOST_SESSION = 'session-host'

function createHost(options) {
  const opts = options === undefined ? {} : options
  const calls = { tabs: [], openTabIn: [], sessions: [], slots: [], slotDisposals: 0, tabDisposals: 0 }
  const registered = []
  const services = {}
  // Only these sessions have an adopted surface; openTabIn silently no-ops for
  // any other session, like the real host (and returns void either way).
  const surfaces = opts.surfaces === undefined ? [HOST_SESSION] : opts.surfaces
  const strips = new Map()
  let planted = 0
  if (opts.sidebar !== false) {
    services.sidebarRight = {
      tabsIn(sessionId) {
        if (opts.tabsInThrows === true) throw new Error('tab strip unavailable')
        const list = strips.get(sessionId)
        return list === undefined ? [] : list.slice()
      },
      openTabIn(sessionId, kind, options) {
        calls.openTabIn.push(arguments.length >= 3 ? [sessionId, kind, options] : [sessionId, kind])
        if (opts.openThrows === true) throw new Error('sidebar unavailable')
        if (opts.openNoop === true) return
        if (surfaces.indexOf(sessionId) < 0) return
        const list = strips.get(sessionId) === undefined ? [] : strips.get(sessionId)
        // Our tab type is single-instance: the host reveals the open tab.
        let tab = list.filter((entry) => entry.kind === kind)[0]
        if (tab === undefined) {
          planted += 1
          tab = { id: 'tab-' + String(planted), kind: kind }
          list.push(tab)
          strips.set(sessionId, list)
        }
        tab.params = options === undefined || options.params === undefined ? null : options.params
      },
    }
    if (opts.tabsIn === false) delete services.sidebarRight.tabsIn
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
    // The host's current session — the one with a sidebar surface. The tab
    // opens THERE (T-216); the agent session is only a navigation param.
    if (opts.selection !== false) {
      const current = opts.currentSession === undefined ? HOST_SESSION : opts.currentSession
      services.uiWorkspace.selection = {
        getSnapshot() {
          if (opts.selectionThrows === true) throw new Error('selection unavailable')
          return current === null ? {} : { sessionId: current }
        },
      }
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
  return { host: host, calls: calls, registered: registered, strips: strips }
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

/** T-216: the tab runs in the host session, so the agent rides in the params. */
function tabInfoWithAgent(taskId, agentSession) {
  const params = {}
  if (taskId !== null) params.taskId = taskId
  if (agentSession !== null) params.agentSession = agentSession
  return () => ({ tab: { navigation: { params: params } } })
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

// T-216: the card entry hands over the AGENT session; the tab opens in the
// HOST's current session (the only one with a sidebar surface) and carries the
// agent session plus the resolved card in its navigation params.
assert.equal(sidebar.openIn('session-w212'), true, 'openIn forwards to the host')
assert.deepEqual(
  mounted.calls.openTabIn,
  [[HOST_SESSION, 'godot-bridge-agent', { params: { taskId: 'T-212', agentSession: 'session-w212' } }]],
  'openTabIn gets the HOST session, OUR kind and both navigation params',
)
assert.equal(
  mounted.calls.openTabIn.every((call) => call[0] === HOST_SESSION),
  true,
  'the agent session is never the session the tab is opened in',
)
assert.deepEqual(mounted.strips.get(HOST_SESSION), [{ id: 'tab-1', kind: 'godot-bridge-agent', params: { taskId: 'T-212', agentSession: 'session-w212' } }], 'the tab really landed in the host session strip')
assert.equal(mounted.strips.has('session-w212'), false, 'the agent session owns no tab strip')

assert.equal(api.openIn('session-rev212', 'T-EXPLICIT'), true, 'an explicit taskId is forwarded verbatim')
assert.deepEqual(mounted.calls.openTabIn[1], [HOST_SESSION, 'godot-bridge-agent', { params: { taskId: 'T-EXPLICIT', agentSession: 'session-rev212' } }], 'the explicit card travels in the params next to the agent session')
assert.equal(sidebar.openIn('session-unknown'), true, 'a session with no card still opens the overview')
assert.deepEqual(mounted.calls.openTabIn[2], [HOST_SESSION, 'godot-bridge-agent', { params: { agentSession: 'session-unknown' } }], 'without a card the params still name the agent session')
assert.equal(mounted.calls.openTabIn.length, 3, 'every open went to the host session')
assert.equal(sidebar.openIn(''), false, 'an empty session is refused')
assert.equal(sidebar.openIn(null), false, 'a missing session is refused')
assert.equal(sidebar.openIn(42), false, 'a non-string session is refused')
assert.equal(mounted.calls.openTabIn.length, 3, 'a refused call never reaches the host')

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
// T-216: without uiWorkspace there is no host session to open in. Falling back
// to the agent session would be the silent host no-op this task removes.
assert.equal(withoutWorkspaceView.openIn('session-w212'), false, 'without a host session the open is refused, not silently redirected')
assert.equal(withoutWorkspace.calls.openTabIn.length, 0, 'no openTabIn is attempted without a host session')
withoutWorkspaceDispose()

// ── missing sidebar services: hide, never throw ─────────────────────────────
for (const variant of [
  { sidebar: false },
  { tabsIn: false },
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

// ── T-216: the tab opens in the HOST session, verified through tabsIn ───────
// A host that answers openTabIn with void but has no adopted surface silently
// does nothing. The entry must report that as false instead of a fake success.
const noopOpen = createHost({ openNoop: true })
const noopOpenView = createView()
const noopOpenDispose = noopOpenView.mount(noopOpen.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(sidebar.available(), true, 'the entry mounts against a host that accepts the call')
assert.equal(sidebar.openIn('session-w212'), false, 'a silent host no-op is reported as false')
assert.equal(noopOpen.strips.get(HOST_SESSION), undefined, 'the host strip confirms nothing was placed')
assert.equal(noopOpen.calls.openTabIn.length, 1, 'the call was still attempted once')
noopOpenDispose()

// The agent session is never the opening session, even if it were the only
// session the host had a surface for.
const agentSurface = createHost({ surfaces: ['session-w212'] })
const agentSurfaceView = createView()
const agentSurfaceDispose = agentSurfaceView.mount(agentSurface.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(agentSurfaceView.openIn('session-w212'), false, 'the agent session is not opened in and does not fall back')
assert.deepEqual(agentSurface.calls.openTabIn, [[HOST_SESSION, 'godot-bridge-agent', { params: { taskId: 'T-212', agentSession: 'session-w212' } }]], 'the open still names the host session')
agentSurfaceDispose()

// No host session (no selection, an empty snapshot, or a throwing one): refuse
// the open instead of redirecting it to the agent session.
for (const variant of [
  { currentSession: null },
  { selection: false },
  { selectionThrows: true },
]) {
  const off = createHost(variant)
  const view = createView()
  const disposal = view.mount(off.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
  assert.equal(view.isMounted(), true, 'the tab still mounts without a current session')
  assert.equal(view.openIn('session-w212'), false, 'without a current host session the open is refused (' + JSON.stringify(variant) + ')')
  assert.equal(off.calls.openTabIn.length, 0, 'no openTabIn is attempted (' + JSON.stringify(variant) + ')')
  disposal()
}

// A host that cannot report its tab strip leaves the open unverifiable: false.
const stripBlind = createHost({ tabsIn: false })
const stripBlindView = createView()
const stripBlindDispose = stripBlindView.mount(stripBlind.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(stripBlindView.isMounted(), false, 'a host without tabsIn does not offer a dead entry')
stripBlindDispose()
const stripThrows = createHost({ tabsInThrows: true })
const stripThrowsView = createView()
const stripThrowsDispose = stripThrowsView.mount(stripThrows.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(stripThrowsView.isMounted(), true, 'the strip reader may fail after mount')
assert.equal(stripThrowsView.openIn('session-w212'), false, 'an unverifiable placement is false')
assert.equal(stripThrows.calls.openTabIn.length, 0, 'nothing is attempted without a strip inventory')
stripThrowsDispose()

// The body/title run in the HOST session, so the agent they show comes from the
// navigation params; the tab's own session is only the fallback.
const paramView = createView()
const paramHost = createHost()
const paramDispose = paramView.mount(paramHost.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
const paramBody = paramView.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-212', 'session-w212') })
assert.equal(paramBody.props['data-agent-session'], 'session-w212', 'the body shows the agent session from the params, not the host session')
assert.equal(paramBody.props['data-agent-role'], 'worker')
assert.equal(paramBody.props['data-agent-task'], 'T-212')
assert.ok(JSON.stringify(paramBody).includes('worker-t-212'), 'the body names the agent from the params')
const paramButton = openButtonOf(paramBody)
assert.ok(paramButton !== null, 'the conversation switch still renders in the host session')
assert.equal(paramButton.props['data-agent-session'], 'session-w212')
assert.doesNotThrow(() => paramButton.props.onClick({}), 'the switch still never throws')
assert.deepEqual(paramHost.calls.sessions, ['session-w212'], 'the switch opens the SUBAGENT conversation (unchanged)')
const paramTitle = paramView.Title({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-212', 'session-w212') })
assert.ok(JSON.stringify(paramTitle).includes('worker-t-212'), 'the title names the agent from the params')
assert.equal(paramView.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent(null, 'session-w212') }).props['data-agent-task'], 'T-212', 'the agent session alone still resolves its card')
assert.equal(paramView.Body({ sessionId: 'session-w212' }).props['data-agent-session'], 'session-w212', 'without params the navigation session is the fallback')
paramDispose()

// A guide-opened tab (no params) belongs to the host session and shows it.
const guideView = createView()
const guideHost = createHost()
const guideDispose = guideView.mount(guideHost.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
const guideBody = guideView.Body({ sessionId: HOST_SESSION })
assert.equal(guideBody.props['data-agent-session'], HOST_SESSION, 'the guide overview shows the navigation session')
assert.equal(guideBody.props['data-agent-task'], '', 'the host session has no card on this board')
guideDispose()

// ── 40-tail / shipped bundle carry the same wiring ──────────────────────────
const TAIL = readFileSync(new URL('../../client/src/40-tail.part', import.meta.url), 'utf8')
const BUNDLE = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
assert.ok(TAIL.includes("ctx.inject(['sidebarRight', 'sidebarRightTabs', 'uiWorkspace']"), 'the sidebar injection also waits for uiWorkspace')
assert.ok(TAIL.includes('uiWorkspace: scoped === null || scoped === undefined ? null : scoped.uiWorkspace'), 'the mount receives the uiWorkspace service')
assert.ok(TAIL.includes('return tab.mount(scoped, {'), 'the tab still mounts on the scoped services')
assert.ok(BUNDLE.includes("ctx.inject(['sidebarRight', 'sidebarRightTabs', 'uiWorkspace']"), 'the shipped bundle carries the same sidebar injection')
assert.ok(BUNDLE.includes('agentTabOpenSession'), 'the shipped bundle carries the conversation switch')
assert.ok(BUNDLE.includes("AGENT_TAB_SESSION_PARAM = 'agentSession'"), 'the shipped bundle carries the agent-session navigation param')
assert.ok(BUNDLE.includes('sidebar.tabsIn'), 'the shipped bundle verifies the placement through the tab strip')
assert.ok(BUNDLE.includes('hostSessionOf'), 'the shipped bundle resolves the host session')

console.log('PASS  agent sidebar opens its own tab in the host session with the agent and card in the params, verifies the placement through tabsIn, switches to the subagent conversation and degrades safely')
