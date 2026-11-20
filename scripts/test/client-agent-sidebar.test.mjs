// T-209: the right-sidebar agent tab.
//
// The bundled view is required directly (like the other client-*.test.mjs
// suites) and mounted against a fake host, so the test proves the real
// registration contract: one custom tab kind, body/title slots keyed by the
// tab id, sidebar.openTabIn(sessionId, kind), and no throw when the optional
// host services are missing.

import assert from 'node:assert/strict'
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

const task = {
  id: 'T-209',
  title: 'Open the agent in the sidebar',
  status: 'running',
  assignee: { name: 'worker-t-209', session: 'session-w1' },
  ownerSession: 'session-owner',
  updatedAt: '2026-11-20T20:00:00.000Z',
  review: null,
  test: null,
  history: [],
}
const snapshot = {
  tasks: [task],
  agentTree: {
    available: true,
    root: { id: 'session-owner', name: 'lead', role: 'lead', status: 'running', taskId: null },
    members: [{ id: 'session-w1', name: 'worker-t-209', role: 'worker', status: 'running', taskId: 'T-209' }],
    count: 1,
    error: null,
  },
  activityEvents: {
    available: true,
    entries: [{ key: 'evt-1', taskId: 'T-209', kind: 'submit', at: '2026-11-20T20:01:00.000Z', detail: '@abc1234' }],
  },
}
const store = {
  snapshot: snapshot,
  subscribe() { return () => {} },
  getSnapshot() { return snapshot },
}

function createHost(options) {
  const opts = options === undefined ? {} : options
  const calls = { tabs: [], openTabIn: [], slots: [], slotDisposals: 0, tabDisposals: 0 }
  const registered = []
  const services = {}
  if (opts.sidebar !== false) {
    services.sidebarRight = {
      openTabIn(sessionId, kind) {
        calls.openTabIn.push([sessionId, kind])
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

// ── the session helper never mints an id ────────────────────────────────────
assert.equal(sidebar.agentSessionOf({ id: 'T-1' }), null, 'a card without a recorded session has no entry')
assert.equal(sidebar.agentSessionOf({ assignee: { name: 'w', session: 'session-w1' }, ownerSession: 'session-owner' }), 'session-w1', 'the executor session wins')
assert.equal(sidebar.agentSessionOf({ assignee: null, ownerSession: 'session-owner' }), 'session-owner', 'the owning session is the fallback')
assert.equal(sidebar.agentSessionOf({ assignee: { session: '   ' }, ownerSession: '  ' }), null, 'blank ids are not sessions')
assert.deepEqual(
  Object.keys(sidebar.AGENT_TAB_COPY.zh).sort(),
  Object.keys(sidebar.AGENT_TAB_COPY.en).sort(),
  'the tab ships the same keys in both locales',
)
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttab'), 'the tab ships its own token-only styles')
assert.equal(sidebar.available(), false, 'nothing is available before a mount')
assert.equal(sidebar.openIn('session-w1'), false, 'openIn without a host is a quiet false')

// ── registration + openTabIn + the tab body/title ───────────────────────────
const api = createView()
const mounted = createHost()
const dispose = api.mount(mounted.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(sidebar.available(), true, 'a successful mount makes the entry available')
assert.equal(sidebar.label('openInSidebar'), '在侧边栏打开', 'the shared label helper resolves the entry copy')
assert.equal(api.label('agentTabTitle'), '代理')
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
assert.equal(spec.guide.length, 1, 'the guide has one entry')
assert.equal(spec.guide[0].title(), '代理')
assert.equal(spec.guide[0].description(), '在右侧栏跟随任务卡上的执行 Agent')
assert.equal(typeof spec.guide[0].icon, 'function')

assert.equal(sidebar.openIn('session-w1'), true, 'openIn forwards to the host')
assert.deepEqual(mounted.calls.openTabIn, [['session-w1', 'godot-bridge-agent']], 'openTabIn gets the REAL session and OUR kind')
assert.equal(sidebar.openIn(''), false, 'an empty session is refused')
assert.equal(sidebar.openIn(null), false, 'a missing session is refused')
assert.equal(sidebar.openIn(42), false, 'a non-string session is refused')

const info = api.infoOf(snapshot, 'session-w1', t, 1000)
assert.equal(info.name, 'worker-t-209')
assert.equal(info.role, 'worker')
assert.equal(info.roleLabel, '实现')
assert.equal(info.status, 'running')
assert.equal(info.statusLabelKey, 'agentStatusRunning')
assert.equal(info.taskId, 'T-209')
assert.equal(info.stage, '实现中')
assert.equal(info.activity.labelKey, 'evtLabel-submit')

const body = api.Body({ sessionId: 'session-w1' })
const bodyText = JSON.stringify(body)
assert.ok(bodyText.includes('worker-t-209'), 'the body shows the agent name')
assert.ok(bodyText.includes('实现'), 'the body shows the role')
assert.ok(bodyText.includes('运行中'), 'the body shows the status')
assert.ok(bodyText.includes('T-209'), 'the body shows the task id')
assert.ok(bodyText.includes('实现中'), 'the body shows the stage')
assert.ok(bodyText.includes('最近活动'), 'the body shows the activity section')
assert.ok(bodyText.includes('提交'), 'the body shows the latest activity')
assert.equal(body.props['data-agent-session'], 'session-w1')
assert.equal(body.props['data-agent-task'], 'T-209')

const title = api.Title({ sessionId: 'session-w1' })
assert.ok(JSON.stringify(title).includes('worker-t-209'), 'the title names the agent')
const emptyBody = api.Body({ sessionId: '' })
assert.ok(JSON.stringify(emptyBody).includes('没有可显示的会话'), 'an empty tab says it has no session')

dispose()
assert.equal(sidebar.available(), false, 'dispose removes the entry')
assert.equal(sidebar.openIn('session-w1'), false, 'openIn is a quiet false after dispose')
assert.equal(mounted.calls.tabDisposals, 1, 'the tab registration is released')
assert.equal(mounted.calls.slotDisposals, 2, 'both slot registrations are released')

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
  assert.equal(sidebar.openIn('session-w1'), false, 'openIn degrades to false')
  assert.doesNotThrow(() => disposal(), 'the disposer is safe after a failed mount')
}

// ── a throwing openTabIn must not escape ────────────────────────────────────
const throwing = createHost({ openThrows: true })
const throwingView = createView()
const throwingDispose = throwingView.mount(throwing.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(sidebar.available(), true)
assert.equal(sidebar.openIn('session-w1'), false, 'openTabIn errors are reported as false, not thrown')
throwingDispose()

console.log('PASS  agent sidebar registers its own tab kind, opens real sessions and degrades safely')
