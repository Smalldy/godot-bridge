// T-209/T-212/T-216/T-218: the right-sidebar agent tab.
//
// The bundled view is required directly (like the other client-*.test.mjs
// suites) and mounted against a fake host, so the test proves the real
// registration contract: one custom tab type registered as multiple (T-218:
// each open mints its own tab instead of navigating the previous one), body/
// title slots keyed by the tab id, the tab opened in the HOST's current session
// (T-216) with { params: { taskId, agentSession } }, sidebarRight.tabsIn() used
// to verify the placement by the strip DELTA (a host no-op or a host that still
// reuses one page is false, never a fake success), uiWorkspace.openSession(host)
// after a verified open so the plugin page actually leaves for the conversation
// that shows the sidebar, uiWorkspace.openSession(subagent) for the overview's
// conversation switch, the card's own session order, the role of the stage
// behind it, exact taskId resolution, and no throw when the optional host
// services are missing.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sidebar = require('../../client/src/views/agent-sidebar.cjs')
const { createTaskCard } = require('../../client/src/views/task-card.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}

// T-227: the tab body owns a refresh timer, so the fake React must be able to
// MOUNT a component: hooks persist per instance, effects run after the render,
// and a store notification re-renders the instance through its
// useSyncExternalStore subscription. A direct `api.Body(...)` call (every other
// block in this file) still renders statelessly: effects are not queued outside
// a mount, which keeps the historical single-render assertions unchanged.
let renderInstance = null
let renderHookIndex = 0

function sameDeps(left, right) {
  if (Array.isArray(left) !== true || Array.isArray(right) !== true) return false
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (Object.is(left[index], right[index]) !== true) return false
  }
  return true
}

function useHookSlot(create) {
  const index = renderHookIndex
  renderHookIndex += 1
  const hooks = renderInstance.hooks
  if (hooks[index] === undefined) hooks[index] = create()
  return hooks[index]
}

const React = {
  useState(initial) {
    const pair = [typeof initial === 'function' ? initial() : initial, () => {}]
    if (renderInstance === null) return pair
    return useHookSlot(() => pair)
  },
  useEffect(effect, deps) {
    if (renderInstance === null) return
    const index = renderHookIndex
    renderHookIndex += 1
    const hooks = renderInstance.hooks
    const previous = hooks[index]
    if (previous !== undefined) {
      // The tab's effects all use []; a re-render must not re-run them (that
      // would double the timers and the loads this task asserts).
      if (sameDeps(previous.deps, deps)) return
      if (typeof previous.cleanup === 'function') previous.cleanup()
    }
    const slot = { deps: deps === undefined ? null : deps, effect: effect, cleanup: null }
    hooks[index] = slot
    renderInstance.pending.push(slot)
  },
  useReducer(reducer, initial) {
    const pair = [typeof initial === 'function' ? initial() : initial, () => {}]
    if (renderInstance === null) return pair
    return useHookSlot(() => pair)
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    if (renderInstance === null) return getSnapshot()
    const instance = renderInstance
    useHookSlot(() => {
      let unsubscribe = null
      if (typeof subscribe === 'function') {
        try {
          unsubscribe = subscribe(function () { instance.rerender() })
        } catch (error) {
          unsubscribe = null
        }
      }
      return { unsubscribe: unsubscribe }
    })
    return getSnapshot()
  },
}

/** Mount one tab body, run its effects, and keep its node current on store pushes. */
function mountBody(component, props) {
  const instance = {
    hooks: [],
    pending: [],
    node: null,
    rendering: false,
    render() {
      if (this.rendering === true) return this.node
      this.rendering = true
      const previousInstance = renderInstance
      const previousIndex = renderHookIndex
      renderInstance = this
      renderHookIndex = 0
      try {
        this.node = component(props)
      } finally {
        renderInstance = previousInstance
        renderHookIndex = previousIndex
        this.rendering = false
      }
      const pending = this.pending
      this.pending = []
      for (const slot of pending) {
        if (slot.cleanup !== null) continue
        const cleanup = slot.effect()
        slot.cleanup = typeof cleanup === 'function' ? cleanup : null
      }
      return this.node
    },
    rerender() {
      this.render()
    },
    unmount() {
      for (const hook of this.hooks) {
        if (hook === null || hook === undefined || typeof hook !== 'object') continue
        if (typeof hook.cleanup === 'function') hook.cleanup()
        if (typeof hook.unsubscribe === 'function') hook.unsubscribe()
        hook.cleanup = null
        hook.unsubscribe = null
      }
      this.hooks = []
      this.pending = []
    },
  }
  instance.render()
  return instance
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
  agentStagesTitle: '阶段会话',
  agentStageDevelop: '开发',
  agentStageReview: '评审',
  agentStageTest: '测试',
  agentStageOpen: '打开对话',
  agentStageOpenHint: '在主页打开这个阶段的子代理对话；主会话会切到子代理，右侧栏属于新会话',
  agentStageNoSession: '未分配',
  agentStageNoSessionHint: '这个阶段还没有会话',
  agentStageUnavailable: '不可用',
  agentStageNoWorkspace: '当前宿主没有切换会话的服务，三行阶段入口都不可用',
  agentTabSwitchNote: '切到子代理后，右侧栏属于子代理会话，本会话的标签不会跟随',
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

// ── one card exactly as /state summarizes it ────────────────────────────────
// T-225: the sidebar renders the /state SUMMARY, never /task. This fixture is
// the shape summaryOf emits: no history / spec / acceptance / evidence, each
// stage record reduced to status/by/byName/at/attempt/deliveredAt and the
// compact deliveredTo ({ name, id }) the three stage rows resolve a real
// reviewer/tester session from. Building the suite on THIS shape (the T-219
// fixture used to be the detail shape) is what proves the sidebar reads what
// the server really sends.
const SUMMARY_TASK_KEYS = [
  'id', 'title', 'status', 'state', 'phase', 'blockedReason', 'kind', 'reportSummary',
  'ownerSession', 'priority', 'dependsOn', 'dependency', 'writeFileCount', 'target', 'base',
  'targetBase', 'verifyFingerprint', 'branch', 'worktree', 'worktreeError', 'commit',
  'requiredRole', 'merge', 'review', 'test', 'assignee', 'attempts', 'maxAttempts',
  'interruptions', 'executors', 'liveExecutors', 'leaseUntil', 'leaseRemaining',
  'leaseExpired', 'leaseReminder', 'dispatch', 'waitingReason', 'candidate', 'queuePosition',
  'createdAt', 'updatedAt', 'events',
]
const task = {
  id: 'T-212',
  title: 'Agent sidebar',
  status: 'running',
  state: 'running',
  phase: 'implement',
  blockedReason: null,
  kind: 'dev',
  reportSummary: null,
  ownerSession: 'session-root',
  priority: 40,
  dependsOn: [],
  dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
  writeFileCount: 1,
  target: 'feat/task-center-v2',
  base: 'base-sha',
  targetBase: 'base-sha',
  verifyFingerprint: null,
  branch: 'task/T-212-1',
  worktree: 'D:/worktrees/T-212-1',
  worktreeError: null,
  commit: null,
  requiredRole: null,
  merge: null,
  review: {
    status: 'pending',
    by: null,
    byName: null,
    at: null,
    attempt: 1,
    deliveredAt: null,
    deliveredTo: { name: 'reviewer-t-212', id: 'session-rev212' },
  },
  test: {
    status: 'pending',
    by: null,
    byName: null,
    at: null,
    attempt: 1,
    deliveredAt: null,
    evidenceLength: 0,
    deliveredTo: { name: 'tester-t-212', id: 'session-test212' },
  },
  assignee: { name: 'worker-t-212', session: 'session-w212' },
  attempts: 1,
  maxAttempts: 3,
  interruptions: 0,
  executors: [],
  liveExecutors: [],
  leaseUntil: null,
  leaseRemaining: null,
  leaseExpired: false,
  leaseReminder: false,
  dispatch: null,
  waitingReason: null,
  candidate: null,
  queuePosition: null,
  createdAt: '2026-11-21T05:59:00.000Z',
  updatedAt: '2026-11-21T06:00:00.000Z',
  events: [],
}
assert.deepEqual(Object.keys(task).sort(), SUMMARY_TASK_KEYS.slice().sort(), 'the fixture is exactly the /state summary contract')
assert.equal(task.history, undefined, 'the summary carries no history (events only)')
assert.equal(task.spec, undefined, 'the summary carries no spec')
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
        const definition = calls.tabs.filter((spec) => spec.kind === kind)[0]
        // T-218: like the real host, a type registered as multiple gets a fresh
        // content address (sidebar://<kind>/<n>) per open, so each call plants a
        // new tab. A host that does not honour multiple keeps ONE page per kind
        // and NAVIGATES it into the new params — the regression this task fixes.
        const multiple = definition !== undefined && definition.multiple === true && opts.ignoreMultiple !== true
        let tab = multiple === true ? undefined : list.filter((entry) => entry.kind === kind)[0]
        if (tab === undefined) {
          planted += 1
          tab = {
            id: 'tab-' + String(planted),
            kind: kind,
            contentId: 'sidebar://' + kind + (multiple === true ? '/' + String(planted) : ''),
          }
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
    services.uiWorkspace = {}
    if (opts.openSession !== false) {
      services.uiWorkspace.openSession = function (sessionId) {
        calls.sessions.push(sessionId)
        if (opts.workspaceThrows === true) throw new Error('workspace unavailable')
      }
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

/** Every stage row in a rendered body, in pipeline order. */
function stageRowNodes(body) {
  const rows = []
  const visit = (node) => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (typeof node !== 'object') return
    if (node.props !== undefined && node.props.className === 'gbt-agenttabstage' && node.props['data-agent-stage'] !== undefined) rows.push(node)
    visit(node.props === undefined ? undefined : node.props.children)
  }
  visit(body)
  return rows
}

function stageRowOf(body, stage) {
  return stageRowNodes(body).filter((row) => row.props['data-agent-stage'] === stage)[0] || null
}

function stageButtonOf(body, stage) {
  const row = stageRowOf(body, stage)
  return row === null ? null : findNode(row, (node) => node.props !== undefined && node.props['data-agent-action'] === 'open-stage-session')
}

function noWorkspaceNoteOf(body) {
  return findNode(body, (node) => node.props !== undefined && node.props['data-agent-note'] === 'no-workspace')
}

function scopeNoteOf(body) {
  return findNode(body, (node) => node.props !== undefined && node.props['data-agent-note'] === 'sidebar-scope')
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

function tabInfoWithParams(params) {
  const captured = Object.assign({}, params)
  return () => ({ tab: { navigation: { params: captured } } })
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

// ── T-219: one row per stage, read from the card's own fields ───────────────
const fullStages = sidebar.stageSessionsOf(task)
assert.deepEqual(fullStages.map((row) => row.stage), ['develop', 'review', 'test'], 'the rows are in pipeline order')
assert.deepEqual(fullStages.map((row) => row.labelKey), ['agentStageDevelop', 'agentStageReview', 'agentStageTest'], 'each row names its stage')
assert.deepEqual(fullStages.map((row) => row.session), ['session-w212', 'session-rev212', 'session-test212'], 'each row takes its own stage session')
assert.deepEqual(
  sidebar.stageSessionsOf({ id: 'T-P', assignee: { session: 'session-only-dev' } }).map((row) => row.session),
  ['session-only-dev', null, null],
  'a missing stage keeps its row with no session',
)
assert.deepEqual(
  sidebar.stageSessionsOf({ review: { deliveredTo: { id: 'session-only-review' } } }).map((row) => row.session),
  [null, 'session-only-review', null],
  'the review row reads review.deliveredTo.id',
)
assert.deepEqual(
  sidebar.stageSessionsOf({ test: { deliveredTo: { id: 'session-only-test' } } }).map((row) => row.session),
  [null, null, 'session-only-test'],
  'the test row reads test.deliveredTo.id',
)
assert.deepEqual(
  sidebar.stageSessionsOf({ assignee: { session: '   ' }, review: { deliveredTo: { id: '' } }, test: null }).map((row) => row.session),
  [null, null, null],
  'blank stage ids are not sessions',
)
const reusedStages = sidebar.stageSessionsOf({
  assignee: { session: 'session-same' },
  review: { deliveredTo: { id: 'session-same' } },
  test: { deliveredTo: { id: 'session-same' } },
})
assert.deepEqual(reusedStages.map((row) => row.session), ['session-same', 'session-same', 'session-same'], 'one session may back several stage rows')
assert.equal(sidebar.stageSessionsOf(null).every((row) => row.session === null), true, 'no card means no sessions')
assert.equal(sidebar.stageSessionsOf(undefined).every((row) => row.session === null), true, 'an absent card mints no session')

// T-225: the SUMMARY is all the sidebar ever receives, and it must carry the
// delivery identity for both open rounds (the reported bug: a done card showed
// 评审/测试 as 未分配 because summaryOf dropped deliveredTo).
assert.deepEqual(task.review.deliveredTo, { name: 'reviewer-t-212', id: 'session-rev212' }, 'the summary review keeps deliveredTo')
assert.deepEqual(task.test.deliveredTo, { name: 'tester-t-212', id: 'session-test212' }, 'the summary test keeps deliveredTo')
assert.deepEqual(Object.keys(task.review.deliveredTo).sort(), ['id', 'name'], 'the summary adds only name + id, never the record')
assert.deepEqual(Object.keys(task.test.deliveredTo).sort(), ['id', 'name'], 'the summary adds only name + id, never the evidence')
assert.deepEqual(
  sidebar.stageSessionsOf(task).map((row) => row.session),
  ['session-w212', 'session-rev212', 'session-test212'],
  'the three rows resolve real sessions from the summary shape',
)
const doneSummary = Object.assign({}, task, {
  status: 'done',
  state: 'done',
  phase: null,
  // A done card: the rounds are CLOSED and their deliveredTo is what is left.
  review: Object.assign({}, task.review, { status: 'approved', by: '@worker-t-212', byName: 'worker-t-212', at: '2026-11-21T06:10:00.000Z' }),
  test: Object.assign({}, task.test, { status: 'passed', by: '@tester-t-212', at: '2026-11-21T06:20:00.000Z', evidenceLength: 42 }),
})
assert.deepEqual(
  sidebar.stageSessionsOf(doneSummary).map((row) => row.session),
  ['session-w212', 'session-rev212', 'session-test212'],
  'a DONE summary card still names its reviewer/tester instead of 未分配',
)
assert.equal(doneSummary.test.evidence, undefined, 'the summary carries no test evidence, only evidenceLength')
assert.equal(doneSummary.review.record, undefined, 'the summary carries no review record')
assert.deepEqual(
  Object.keys(sidebar.AGENT_TAB_COPY.zh).sort(),
  Object.keys(sidebar.AGENT_TAB_COPY.en).sort(),
  'the tab ships the same keys in both locales',
)
assert.equal(sidebar.AGENT_TAB_COPY.zh.agentStageDevelop, '开发', 'the develop row is labeled')
assert.equal(sidebar.AGENT_TAB_COPY.zh.agentStageReview, '评审', 'the review row is labeled')
assert.equal(sidebar.AGENT_TAB_COPY.zh.agentStageTest, '测试', 'the test row is labeled')
assert.ok(sidebar.AGENT_TAB_COPY.zh.agentStageOpen !== undefined, 'the per-stage conversation switch is localized')
assert.ok(sidebar.AGENT_TAB_COPY.zh.agentTabSwitchNote !== undefined, 'the session-scope note is localized')
assert.ok(sidebar.AGENT_TAB_COPY.zh.agentStageOpenHint.includes('右侧栏属于新会话'), 'the switch hint names the session change instead of promising the tab follows')
assert.ok(sidebar.AGENT_TAB_COPY.en.agentStageOpenHint.includes('sidebar belongs to the new session'), 'the English hint says the same')
assert.ok(sidebar.AGENT_TAB_COPY.zh.agentStageNoWorkspace.includes('没有切换会话的服务'), 'the no-workspace note explains the disabled rows')
assert.ok(sidebar.AGENT_TAB_COPY.zh.agentStageNoSession !== undefined, 'a missing stage has its own copy')
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttab'), 'the tab ships its own token-only styles')
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttabstages'), 'the three stage rows have their own container style')
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttabstagebtn'), 'each stage row action has its own style')
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttabstagename'), 'the row name is styled for ellipsis')
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttabstage[data-agent-stage-has-session="false"]'), 'a missing stage row is visually distinct')
assert.ok(
  sidebar.AGENT_TAB_CSS.includes('.gbt-agenttabstagename{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'),
  'a long agent name ellipsizes instead of widening the tab',
)
assert.ok(
  sidebar.AGENT_TAB_CSS.includes('.gbt-agenttabstage{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden'),
  'a stage row clips instead of widening the tab',
)
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttabstagebtn:disabled'), 'a disabled stage action reads as disabled')
assert.ok(sidebar.AGENT_TAB_CSS.includes('.gbt-agenttabnote'), 'the session-scope note has its own style')
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
assert.equal(api.label('agentStageOpen'), '打开对话', 'the per-stage conversation switch is labeled')
assert.equal(mounted.calls.tabs.length, 1, 'exactly one tab is registered')
const spec = mounted.calls.tabs[0]
assert.equal(spec.id, 'godot-bridge/agent', 'the tab has OUR id (not a DSH private agent kind)')
assert.equal(spec.kind, 'godot-bridge-agent', 'the tab has OUR kind')
assert.equal(spec.multiple, true, 'T-218: the tab type is registered as multiple so every open is its own tab')
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
// T-218: the verified open then switches the main view to that host session, so
// clicking "open in sidebar" really leaves the plugin page for the sidebar.
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
assert.deepEqual(mounted.calls.sessions, [HOST_SESSION], 'a verified open switches the main view to the HOST conversation, not to the agent')
assert.deepEqual(
  mounted.strips.get(HOST_SESSION),
  [{ id: 'tab-1', kind: 'godot-bridge-agent', contentId: 'sidebar://godot-bridge-agent/1', params: { taskId: 'T-212', agentSession: 'session-w212' } }],
  'the tab really landed in the host session strip',
)
assert.equal(mounted.strips.has('session-w212'), false, 'the agent session owns no tab strip')

assert.equal(api.openIn('session-rev212', 'T-EXPLICIT'), true, 'an explicit taskId is forwarded verbatim')
assert.deepEqual(mounted.calls.openTabIn[1], [HOST_SESSION, 'godot-bridge-agent', { params: { taskId: 'T-EXPLICIT', agentSession: 'session-rev212' } }], 'the explicit card travels in the params next to the agent session')
assert.equal(sidebar.openIn('session-unknown'), true, 'a session with no card still opens the overview')
assert.deepEqual(mounted.calls.openTabIn[2], [HOST_SESSION, 'godot-bridge-agent', { params: { agentSession: 'session-unknown' } }], 'without a card the params still name the agent session')
assert.equal(mounted.calls.openTabIn.length, 3, 'every open went to the host session')
// T-218: three opens, three tabs; the first one was never navigated.
assert.deepEqual(
  mounted.strips.get(HOST_SESSION).map((entry) => entry.params),
  [
    { taskId: 'T-212', agentSession: 'session-w212' },
    { taskId: 'T-EXPLICIT', agentSession: 'session-rev212' },
    { agentSession: 'session-unknown' },
  ],
  'each open keeps its own navigation params instead of rewriting the open tab',
)
assert.equal(new Set(mounted.strips.get(HOST_SESSION).map((entry) => entry.id)).size, 3, 'three distinct tab records')
assert.equal(new Set(mounted.strips.get(HOST_SESSION).map((entry) => entry.contentId)).size, 3, 'three distinct content addresses')
assert.deepEqual(mounted.calls.sessions, [HOST_SESSION, HOST_SESSION, HOST_SESSION], 'every verified open switched to the host conversation')
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
  review: null,
  test: null,
})
const ownedSnapshot = { tasks: [ownedByRoot], agentTree: agentTree, activityEvents: null }
const ownedInfo = api.infoOf(ownedSnapshot, 'session-root', t, 1000)
assert.equal(ownedInfo.role, 'worker', 'the executor role wins over the owner role')
assert.equal(ownedInfo.roleLabel, '实现', 'a worker name is never paired with the root Agent role')
assert.equal(ownedInfo.name, 'worker-on-root', 'the root tree name does not leak onto the worker row')

// The previous executor is still a worker session. `lastAssignee` is a DETAIL
// field (/state does not carry it), so the summary fixture has none: the case
// is stated on the card here, and the reader stays robust when it is present.
const previousOnly = Object.assign({}, task, {
  status: 'blocked',
  assignee: null,
  lastAssignee: { name: 'worker-prev-212', session: 'session-prev212' },
})
const previousSnapshot = { tasks: [previousOnly], agentTree: agentTree, activityEvents: null }
const previousInfo = api.infoOf(previousSnapshot, 'session-prev212', t, 1000)
assert.equal(previousInfo.role, 'worker', 'lastAssignee is the worker fallback')
assert.equal(previousInfo.name, 'worker-prev-212')

// ── T-219: the body renders the three stage rows and opens each session ────
const workerBody = api.Body({ sessionId: 'session-w212', useTabInfo: tabInfoWith('T-212') })
const workerBodyText = JSON.stringify(workerBody)
assert.ok(workerBodyText.includes('worker-t-212'), 'the body shows the agent name')
assert.ok(workerBodyText.includes('实现'), 'the body shows the role')
assert.ok(workerBodyText.includes('运行中'), 'the body shows the status')
assert.ok(workerBodyText.includes('T-212'), 'the body shows the task id')
assert.ok(workerBodyText.includes('实现中'), 'the body shows the stage')
assert.ok(workerBodyText.includes('最近活动'), 'the body shows the activity section')
assert.ok(workerBodyText.includes('提交'), 'the body shows the latest activity')
assert.ok(workerBodyText.includes('阶段会话'), 'the body carries the stage-session section')
assert.ok(workerBodyText.includes('打开对话'), 'every stage row carries its own conversation action')
assert.equal(workerBody.props['data-agent-session'], 'session-w212')
assert.equal(workerBody.props['data-agent-task'], 'T-212')
assert.equal(workerBody.props['data-agent-role'], 'worker')

// A host that hands no tab info (older shell) falls back to the session card.
const legacyBody = api.Body({ sessionId: 'session-w212' })
assert.equal(legacyBody.props['data-agent-task'], 'T-212', 'without tab info the body falls back to the session card')
assert.equal(legacyBody.props['data-agent-role'], 'worker')

const workerRows = stageRowNodes(workerBody)
assert.equal(workerRows.length, 3, 'the body renders all three stage rows')
assert.deepEqual(workerRows.map((row) => row.props['data-agent-stage']), ['develop', 'review', 'test'], 'the rows are the three stages')
assert.deepEqual(workerRows.map((row) => row.props['data-agent-stage-session']), ['session-w212', 'session-rev212', 'session-test212'], 'each row carries its own stage session')
assert.deepEqual(workerRows.map((row) => row.props['data-agent-stage-has-session']), ['true', 'true', 'true'], 'every recorded stage is available')
assert.ok(JSON.stringify(workerRows[0]).includes('worker-t-212'), 'the develop row names its agent')
assert.ok(JSON.stringify(workerRows[1]).includes('reviewer-t-212'), 'the review row names its agent')
assert.ok(JSON.stringify(workerRows[2]).includes('tester-t-212'), 'the test row names its agent')
const expectedWorkerSessions = ['session-w212', 'session-rev212', 'session-test212']
for (const [index, stage] of ['develop', 'review', 'test'].entries()) {
  const button = stageButtonOf(workerBody, stage)
  assert.ok(button !== null, 'the ' + stage + ' row has a real button')
  assert.equal(button.props.disabled, false, 'the ' + stage + ' row is clickable with uiWorkspace')
  assert.equal(button.props['data-agent-session'], expectedWorkerSessions[index], 'the ' + stage + ' button names ITS session')
  assert.equal(typeof button.props.onClick, 'function')
  assert.doesNotThrow(() => button.props.onClick({}), 'clicking the ' + stage + ' row never throws')
}
assert.deepEqual(
  mounted.calls.sessions,
  [HOST_SESSION, HOST_SESSION, HOST_SESSION, 'session-w212', 'session-rev212', 'session-test212'],
  'each row asks uiWorkspace to open exactly its own stage session',
)

// T-218/T-219: a stage switch moves the MAIN session to the subagent, and the
// right sidebar then belongs to that new session — the body says so.
const scopeNote = scopeNoteOf(workerBody)
assert.ok(scopeNote !== null, 'the stage rows carry a visible session-scope note')
assert.ok(JSON.stringify(scopeNote).includes('本会话的标签不会跟随'), 'the note says this session tabs do not follow')

// The three rows belong to the CARD, not to the agent the tab is centered on:
// a root-centered card tab still offers all three stage entries.
const rootBody = api.Body({ sessionId: 'session-root', useTabInfo: tabInfoWith('T-212') })
assert.equal(stageRowNodes(rootBody).length, 3, 'the card rows are shown even when the top agent is the root')
assert.equal(stageButtonOf(rootBody, 'review').props.disabled, false, 'the review row is still actionable')

// Without a taskId (the guide overview) there is no card, and therefore no rows.
const guideNoTaskBody = api.Body({ sessionId: HOST_SESSION })
assert.equal(stageRowNodes(guideNoTaskBody).length, 0, 'the guide overview has no stage rows')
assert.equal(noWorkspaceNoteOf(guideNoTaskBody), null, 'nothing to explain without rows')
assert.equal(scopeNoteOf(guideNoTaskBody), null, 'nothing to switch, no scope note')

const title = api.Title({ sessionId: 'session-w212', useTabInfo: tabInfoWith('T-212') })
assert.ok(JSON.stringify(title).includes('worker-t-212'), 'the title names the agent')
const reviewerTitle = api.Title({ sessionId: 'session-rev212', useTabInfo: tabInfoWith('T-212') })
assert.ok(JSON.stringify(reviewerTitle).includes('reviewer-t-212'), 'the title resolves the exact card too')
const emptyBody = api.Body({ sessionId: '' })
assert.ok(JSON.stringify(emptyBody).includes('没有可显示的会话'), 'an empty tab says it has no session')

const openConversation = api.openConversation('session-rev212')
assert.equal(openConversation, true, 'openConversation forwards to uiWorkspace')
assert.deepEqual(
  mounted.calls.sessions,
  [HOST_SESSION, HOST_SESSION, HOST_SESSION, 'session-w212', 'session-rev212', 'session-test212', 'session-rev212'],
  'the direct call opens the requested subagent session on top of the three row clicks',
)
assert.equal(api.openConversation(''), false, 'an empty session is not opened')
assert.equal(api.openConversation(null), false, 'a missing session is not opened')

// ── exact taskId resolution beats the session fallback ──────────────────────
const exactPrimary = Object.assign({}, task, {
  id: 'T-A',
  title: 'primary',
  status: 'running',
  assignee: { name: 'worker-a', session: 'session-s' },
  review: null,
  test: null,
  ownerSession: 'session-owner',
  updatedAt: '2026-11-21T06:05:00.000Z',
})
const exactReview = Object.assign({}, task, {
  id: 'T-B',
  title: 'review card',
  status: 'reviewing',
  phase: 'review',
  assignee: null,
  review: Object.assign({}, task.review, { deliveredTo: { name: 'reviewer-b', id: 'session-s' } }),
  test: null,
  ownerSession: 'session-owner',
  updatedAt: '2026-11-21T06:06:00.000Z',
})
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
assert.equal(stageRowNodes(workspaceLessBody).length, 3, 'the stage rows still render without uiWorkspace')
assert.ok(JSON.stringify(workspaceLessBody).includes('worker-t-212'), 'the rest of the overview still renders')
for (const stage of ['develop', 'review', 'test']) {
  const button = stageButtonOf(workspaceLessBody, stage)
  assert.ok(button !== null, 'the ' + stage + ' row still renders its action')
  assert.equal(button.props.disabled, true, 'the ' + stage + ' row is disabled without uiWorkspace')
  assert.doesNotThrow(() => button.props.onClick({}), 'a disabled row never throws when clicked')
}
assert.ok(noWorkspaceNoteOf(workspaceLessBody) !== null, 'the disabled rows explain why')
assert.ok(JSON.stringify(workspaceLessBody).includes('当前宿主没有切换会话的服务'), 'the note names the missing service')
assert.equal(scopeNoteOf(workspaceLessBody), null, 'no switch is possible, so no scope note')
// T-216: without uiWorkspace there is no host session to open in. Falling back
// to the agent session would be the silent host no-op this task removes.
assert.equal(withoutWorkspaceView.openIn('session-w212'), false, 'without a host session the open is refused, not silently redirected')
assert.equal(withoutWorkspace.calls.openTabIn.length, 0, 'no openTabIn is attempted without a host session')
assert.equal(withoutWorkspace.calls.sessions.length, 0, 'nothing claims to have switched the main view')
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
const throwingButton = stageButtonOf(throwingBody, 'develop')
assert.ok(throwingButton !== null, 'the stage action is rendered when uiWorkspace exists')
assert.equal(throwingButton.props.disabled, false, 'a throwing service does not pre-disable the rows')
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
assert.equal(noopOpen.calls.sessions.length, 0, 'no page switch is claimed for a tab that was never placed')
noopOpenDispose()

// The agent session is never the opening session, even if it were the only
// session the host had a surface for.
const agentSurface = createHost({ surfaces: ['session-w212'] })
const agentSurfaceView = createView()
const agentSurfaceDispose = agentSurfaceView.mount(agentSurface.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
assert.equal(agentSurfaceView.openIn('session-w212'), false, 'the agent session is not opened in and does not fall back')
assert.deepEqual(agentSurface.calls.openTabIn, [[HOST_SESSION, 'godot-bridge-agent', { params: { taskId: 'T-212', agentSession: 'session-w212' } }]], 'the open still names the host session')
assert.equal(agentSurface.calls.sessions.length, 0, 'an unplaced tab never switches the main view')
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
  assert.equal(off.calls.sessions.length, 0, 'no page switch is attempted (' + JSON.stringify(variant) + ')')
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
const paramButton = stageButtonOf(paramBody, 'develop')
assert.ok(paramButton !== null, 'the develop row still renders in the host session')
assert.equal(paramButton.props['data-agent-session'], 'session-w212')
assert.doesNotThrow(() => paramButton.props.onClick({}), 'the stage action still never throws')
assert.deepEqual(paramHost.calls.sessions, ['session-w212'], 'the develop row opens the SUBAGENT conversation')
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

// ── T-216 regression: the REAL card click path on a shared session ──────────
// Every card carries the creating session as ownerSession, so several cards
// commonly share one session. The tab must open for the card the user clicked,
// not for the session-derived "best" card.
{
  const sharedTask = (id, status, at) => Object.assign({}, task, {
    id: id,
    title: id,
    status: status,
    assignee: null,
    review: null,
    test: null,
    ownerSession: 'session-root',
    updatedAt: at,
  })
  const previous = storeSnapshot
  storeSnapshot = {
    tasks: [sharedTask('T-PEND', 'pending', '2026-11-21T05:00:00.000Z'), sharedTask('T-RUN', 'running', '2026-11-21T06:00:00.000Z')],
    agentTree: agentTree,
    activityEvents: null,
  }
  try {
    const clickView = createView()
    const clickHost = createHost()
    const clickDispose = clickView.mount(clickHost.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
    // The card receives the module-level facade, exactly like client.js wires it.
    const handle = { sessionOf: sidebar.agentSessionOf, available: sidebar.available, open: sidebar.openIn, label: sidebar.label }
    const Card = createTaskCard(Object.assign({
      React: React,
      h: h,
      tcBaseName: (value) => String(value).split('/').pop(),
      tcIsInvestigation: (entry) => entry.kind === 'investigate',
      tcKindOf: (entry) => (entry.kind === 'investigate' ? 'investigate' : 'dev'),
      tcLease: () => null,
      tcMergeLabel: () => 'merge',
      tcMergeOf: () => null,
      tcMergeTone: () => 'running',
      tcPhaseLabel: helpers.tcPhaseLabel,
      tcPhaseTone: () => 'running',
      tcReviewLabel: () => 'review',
      tcReviewOf: () => null,
      tcReviewTone: () => 'waiting',
      tcRound: () => 1,
      tcStageQueued: () => false,
      tcTestLabel: () => 'test',
      tcTestOf: () => null,
      tcTestTone: () => 'waiting',
      toneForDependency: () => 'waiting',
      waitingChip: () => null,
      agentSidebar: handle,
    }))
    const pendingCard = Card({ task: storeSnapshot.tasks[0], t: t, now: 1000, selected: false, onOpen: () => {}, onVerdict: () => {} })
    const pendingEntry = findNode(pendingCard, (node) => node.props !== undefined && node.props['data-action'] === 'open-agent-sidebar')
    assert.ok(pendingEntry !== null, 'the pending card renders its sidebar entry')
    assert.equal(pendingEntry.props['data-sidebar-session'], 'session-root', 'the entry targets the shared owner session')
    pendingEntry.props.onClick({ stopPropagation: () => {} })
    assert.deepEqual(
      clickHost.calls.openTabIn[0],
      [HOST_SESSION, 'godot-bridge-agent', { params: { taskId: 'T-PEND', agentSession: 'session-root' } }],
      'the click opens for the CLICKED card, not for the session-derived best card',
    )
    assert.deepEqual(clickHost.calls.sessions, [HOST_SESSION], 'the click leaves the plugin page for the host conversation')
    const placed = (clickHost.strips.get(HOST_SESSION) || [])[0]
    assert.ok(placed !== undefined, 'the tab really landed in the host strip')
    const clickedBody = clickView.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithParams(placed.params) })
    assert.equal(clickedBody.props['data-agent-task'], 'T-PEND', 'the tab body shows the clicked card')
    clickDispose()
  } finally {
    storeSnapshot = previous
  }
}

// ── T-218: two cards, two independent tabs, each showing its own agent ──────
{
  const previous = storeSnapshot
  const cardA = Object.assign({}, task, {
    id: 'T-215',
    title: 'decision overlay',
    assignee: { name: 'worker-t-215', session: 'session-w215' },
    review: null,
    test: null,
    ownerSession: 'session-root',
    updatedAt: '2026-11-21T07:00:00.000Z',
  })
  const cardB = Object.assign({}, task, {
    id: 'T-217',
    title: 'merge loop',
    assignee: { name: 'worker-t-217', session: 'session-w217' },
    review: null,
    test: null,
    ownerSession: 'session-root',
    updatedAt: '2026-11-21T07:05:00.000Z',
  })
  storeSnapshot = { tasks: [cardA, cardB], agentTree: agentTree, activityEvents: null }
  try {
    const view = createView()
    const host = createHost()
    const disposal = view.mount(host.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })

    // First card: a tab of its own, and the plugin page leaves for the host
    // conversation that shows the sidebar.
    assert.equal(view.openIn('session-w215', 'T-215'), true, 'the first card opens a tab')
    assert.deepEqual(host.calls.openTabIn[0], [HOST_SESSION, 'godot-bridge-agent', { params: { taskId: 'T-215', agentSession: 'session-w215' } }])
    assert.deepEqual(host.calls.sessions, [HOST_SESSION], 'the first open switches to the host conversation')
    const firstStrip = host.strips.get(HOST_SESSION)
    assert.equal(firstStrip.length, 1, 'one tab after the first open')
    const firstTab = firstStrip[0]
    const firstParams = Object.assign({}, firstTab.params)

    // Second card: a SECOND tab. The first tab keeps its own params — this is
    // the regression: it used to be navigated from T-215 to T-217.
    assert.equal(view.openIn('session-w217', 'T-217'), true, 'the second card opens its own tab')
    assert.deepEqual(host.calls.openTabIn[1], [HOST_SESSION, 'godot-bridge-agent', { params: { taskId: 'T-217', agentSession: 'session-w217' } }])
    const strip = host.strips.get(HOST_SESSION)
    assert.equal(strip.length, 2, 'two independent tabs')
    assert.notEqual(strip[0].id, strip[1].id, 'the two tabs have different layout ids')
    assert.notEqual(strip[0].contentId, strip[1].contentId, 'the two opens minted different content addresses')
    assert.deepEqual(strip[0].params, firstParams, 'the first tab was not navigated by the second open')
    assert.deepEqual(strip[0].params, { taskId: 'T-215', agentSession: 'session-w215' })
    assert.deepEqual(strip[1].params, { taskId: 'T-217', agentSession: 'session-w217' })
    assert.deepEqual(host.calls.sessions, [HOST_SESSION, HOST_SESSION], 'each verified open switches the main view to the host conversation')

    // Each tab body/title resolves ITS OWN navigation params: the first tab still
    // shows T-215 / session-w215 after T-217 was opened.
    const bodyA = view.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithParams(strip[0].params) })
    const bodyB = view.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithParams(strip[1].params) })
    assert.equal(bodyA.props['data-agent-task'], 'T-215')
    assert.equal(bodyA.props['data-agent-session'], 'session-w215')
    assert.equal(bodyB.props['data-agent-task'], 'T-217')
    assert.equal(bodyB.props['data-agent-session'], 'session-w217')
    assert.ok(JSON.stringify(bodyA).includes('worker-t-215'), 'the first tab shows its own agent')
    assert.ok(!JSON.stringify(bodyA).includes('worker-t-217'), 'the first tab never shows the second tab agent')
    assert.ok(JSON.stringify(bodyB).includes('worker-t-217'), 'the second tab shows its own agent')
    const titleA = view.Title({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithParams(strip[0].params) })
    const titleB = view.Title({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithParams(strip[1].params) })
    assert.ok(JSON.stringify(titleA).includes('worker-t-215'), 'the first tab title names its own agent')
    assert.ok(JSON.stringify(titleB).includes('worker-t-217'), 'the second tab title names its own agent')

    // A third open for the same card still mints a new tab (each open is its own
    // instance); the previous two keep their params.
    assert.equal(view.openIn('session-w215', 'T-215'), true, 'a repeated card open still creates a tab')
    const threeStrip = host.strips.get(HOST_SESSION)
    assert.equal(threeStrip.length, 3, 'the strip grew by one each open')
    assert.deepEqual(threeStrip.slice(0, 2).map((entry) => entry.params), [strip[0].params, strip[1].params], 'the earlier tabs were never navigated')
    disposal()
  } finally {
    storeSnapshot = previous
  }
}

// T-218: a host that still keeps one page per kind NAVIGATES the open tab. The
// entry must report false instead of calling that a new tab (no fake success).
{
  const previous = storeSnapshot
  const cardA = Object.assign({}, task, { id: 'T-215', assignee: { name: 'worker-t-215', session: 'session-w215' }, review: null, test: null, ownerSession: 'session-root' })
  const cardB = Object.assign({}, task, { id: 'T-217', assignee: { name: 'worker-t-217', session: 'session-w217' }, review: null, test: null, ownerSession: 'session-root' })
  storeSnapshot = { tasks: [cardA, cardB], agentTree: agentTree, activityEvents: null }
  try {
    const host = createHost({ ignoreMultiple: true })
    const view = createView()
    const disposal = view.mount(host.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
    assert.equal(view.openIn('session-w215', 'T-215'), true, 'the first open still plants the one tab')
    assert.deepEqual(host.calls.sessions, [HOST_SESSION])
    assert.equal(view.openIn('session-w217', 'T-217'), false, 'a strip that did not grow is not a new tab')
    const strip = host.strips.get(HOST_SESSION)
    assert.equal(strip.length, 1, 'the host reused its single page')
    assert.deepEqual(strip[0].params, { taskId: 'T-217', agentSession: 'session-w217' }, 'the host navigated the open tab (the bug the new contract detects)')
    assert.deepEqual(host.calls.sessions, [HOST_SESSION], 'a failed open never claims a page switch')
    disposal()
  } finally {
    storeSnapshot = previous
  }
}

// T-218: no openSession (but a host session still selectable): the tab is
// KEPT, yet the entry does not pretend the page moved.
{
  const host = createHost({ openSession: false })
  const view = createView()
  const disposal = view.mount(host.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
  assert.equal(view.hasWorkspace(), false, 'a workspace without openSession cannot switch the main view')
  assert.equal(view.openIn('session-w212', 'T-212'), false, 'the unswitched open is not reported as a completed entry')
  assert.equal(host.calls.openTabIn.length, 1, 'the tab was still placed')
  const strip = host.strips.get(HOST_SESSION)
  assert.equal(strip.length, 1, 'the placed tab stays in the strip')
  assert.deepEqual(strip[0].params, { taskId: 'T-212', agentSession: 'session-w212' }, 'the kept tab still carries its card and agent')
  assert.equal(host.calls.sessions.length, 0, 'no page switch was claimed or attempted')
  const noteBody = view.Body({ sessionId: 'session-w212', useTabInfo: tabInfoWith('T-212') })
  assert.equal(stageButtonOf(noteBody, 'develop').props.disabled, true, 'the stage actions are disabled without openSession')
  assert.ok(noWorkspaceNoteOf(noteBody) !== null, 'the disabled rows explain why')
  disposal()
}

// ── T-219: partial stages, a reused session, and no cross-card leakage ─────
{
  const previous = storeSnapshot
  const partialCard = {
    id: 'T-PART',
    title: 'partial stages',
    status: 'reviewing',
    assignee: null,
    review: { status: 'running', deliveredTo: { id: 'session-review-only', name: 'reviewer-part' } },
    test: null,
    ownerSession: 'session-root',
    updatedAt: '2026-11-21T08:00:00.000Z',
  }
  const reusedCard = {
    id: 'T-REUSE',
    title: 'reused session',
    status: 'testing',
    assignee: { name: 'worker-reuse', session: 'session-reuse' },
    review: { status: 'passed', deliveredTo: { id: 'session-reuse', name: 'worker-reuse' } },
    test: { status: 'running', deliveredTo: { id: 'session-reuse', name: 'worker-reuse' } },
    ownerSession: 'session-root',
    updatedAt: '2026-11-21T08:05:00.000Z',
  }
  storeSnapshot = { tasks: [partialCard, reusedCard], agentTree: { available: true, root: null, members: [], count: 0, error: null }, activityEvents: null }
  try {
    const view = createView()
    const host = createHost()
    const disposal = view.mount(host.host, { store: store, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })

    // Partial: only the review stage was recorded. The missing rows stay
    // visible, say "not assigned", and carry NO fabricated session id.
    const partialBody = view.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-PART', 'session-review-only') })
    const partialRows = stageRowNodes(partialBody)
    assert.equal(partialRows.length, 3, 'a partial card still renders three stage rows')
    assert.deepEqual(partialRows.map((row) => row.props['data-agent-stage-has-session']), ['false', 'true', 'false'], 'only the recorded review stage is available')
    assert.deepEqual(partialRows.map((row) => row.props['data-agent-stage-session']), ['', 'session-review-only', ''], 'no session is invented for a missing stage')
    assert.ok(JSON.stringify(partialRows[0]).includes('未分配'), 'a missing stage says it is not assigned')
    assert.ok(JSON.stringify(partialRows[2]).includes('未分配'), 'both missing stages say it')
    assert.ok(JSON.stringify(partialRows[0]).includes('不可用'), 'a missing stage shows an unavailable status')
    assert.ok(JSON.stringify(partialRows[2]).includes('不可用'), 'both missing stages show it')
    assert.ok(JSON.stringify(partialRows[1]).includes('reviewer-part'), 'the recorded stage names its agent')
    for (const stage of ['develop', 'test']) {
      const button = stageButtonOf(partialBody, stage)
      assert.equal(button.props.disabled, true, 'the missing ' + stage + ' stage is not clickable')
      assert.equal(button.props['data-agent-session'], '', 'the missing ' + stage + ' stage carries no session id')
      assert.doesNotThrow(() => button.props.onClick({}), 'clicking a missing ' + stage + ' stage never throws')
    }
    assert.equal(stageButtonOf(partialBody, 'review').props.disabled, false, 'the recorded review stage is actionable')
    assert.equal(stageButtonOf(partialBody, 'review').props['data-agent-session'], 'session-review-only')
    assert.deepEqual(host.calls.sessions, [], 'rendering disabled rows never switches the main view')
    stageButtonOf(partialBody, 'review').props.onClick({})
    assert.deepEqual(host.calls.sessions, ['session-review-only'], 'the review row opens ITS session')

    // Reused session: three rows, ONE session id; each row still opens it.
    const reusedBody = view.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-REUSE', 'session-reuse') })
    const reusedRows = stageRowNodes(reusedBody)
    assert.deepEqual(reusedRows.map((row) => row.props['data-agent-stage-session']), ['session-reuse', 'session-reuse', 'session-reuse'], 'one session may back three rows')
    for (const stage of ['develop', 'review', 'test']) {
      assert.equal(stageButtonOf(reusedBody, stage).props['data-agent-session'], 'session-reuse', 'the ' + stage + ' row opens the reused session')
    }
    assert.deepEqual(host.calls.sessions, ['session-review-only'], 'rendering reused rows does not open anything')
    stageButtonOf(reusedBody, 'test').props.onClick({})
    assert.deepEqual(host.calls.sessions, ['session-review-only', 'session-reuse'], 'the reused session opens once per click')

    // Cross-card: each tab reads ITS card even though both tabs are centered
    // on the same host session.
    const crossBody = view.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-REUSE', 'session-review-only') })
    assert.deepEqual(stageRowNodes(crossBody).map((row) => row.props['data-agent-stage-session']), ['session-reuse', 'session-reuse', 'session-reuse'], 'a tab never borrows another card sessions')
    assert.deepEqual(stageRowNodes(partialBody).map((row) => row.props['data-agent-stage-session']), ['', 'session-review-only', ''], 'the first tab keeps its own card rows')
    disposal()
  } finally {
    storeSnapshot = previous
  }
}

// ── T-227: the tab syncs the shared snapshot itself ─────────────────────────
// Before T-227 the body only subscribed to the store, so a tab opened before a
// reviewer was delivered kept saying "not assigned" until another surface
// polled. A mounted body now loads at mount and every 5 s while visible; hidden
// pauses, unmount clears only its own timer (never store.stopPolling), and a
// refreshed review.deliveredTo reaches the stage rows without reopening the
// tab. Both REAL store failure shapes are driven after a good snapshot — the
// offline/catch copy (project kept) and the payload branch (project null, from
// the host error body) — and both must keep the last good card; neither may
// replay it after a project switch.
{
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document')
  const realDocument = hadDocument ? globalThis.document : undefined
  const intervals = new Map()
  let nextInterval = 1
  globalThis.setInterval = (callback, ms) => {
    const id = nextInterval
    nextInterval += 1
    intervals.set(id, { callback, ms })
    return id
  }
  globalThis.clearInterval = (id) => { intervals.delete(id) }
  const tick = () => {
    for (const entry of Array.from(intervals.values())) entry.callback()
  }

  const visibilityListeners = new Set()
  let visibility = 'visible'
  globalThis.document = {
    get visibilityState() { return visibility },
    addEventListener(type, listener) {
      if (type === 'visibilitychange') visibilityListeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'visibilitychange') visibilityListeners.delete(listener)
    },
  }
  const setVisibility = (next) => {
    visibility = next
    for (const listener of Array.from(visibilityListeners)) listener()
  }

  function createSyncStore(initial) {
    let current = initial
    const subscribers = new Set()
    const sync = { loads: 0, startPolling: 0, stopPolling: 0 }
    return {
      sync,
      load() {
        sync.loads += 1
        return Promise.resolve({ ok: true })
      },
      getSnapshot() { return current },
      subscribe(listener) {
        subscribers.add(listener)
        return () => { subscribers.delete(listener) }
      },
      startPolling() { sync.startPolling += 1 },
      stopPolling() { sync.stopPolling += 1 },
      push(next) {
        current = next
        for (const listener of Array.from(subscribers)) listener()
      },
    }
  }

  // A settled /state answer: source 'host', a project and a receipt time, exactly
  // the fields tcSnapshot/withDecisions write (client/src/15-client-state.part).
  const goodSnapshot = (deliveredTo, project, receivedAt) => Object.assign({}, snapshot, {
    source: 'host',
    project: project,
    receivedAt: receivedAt,
    tasks: [Object.assign({}, task, { review: Object.assign({}, task.review, { deliveredTo }) })],
  })
  // The store's OFFLINE/CATCH failure branch (client/src/store.cjs): a copy of
  // the last snapshot, so project and receivedAt are kept, tasks cleared.
  const failureOf = (good, project) => Object.assign({}, good, {
    ok: false,
    source: 'error',
    message: 'offline',
    project: project,
    tasks: [],
  })
  // The store's PAYLOAD failure branch (client/src/store.cjs): tcSnapshot is
  // built from the host error body, which carries no project (routes.mjs), and
  // tcSnapshot only keeps a STRING project — so this snapshot has project: null
  // while receivedAt stays the failed answer's.
  const payloadFailureOf = (good) => ({
    ok: false,
    source: 'error',
    code: 'failed',
    message: 'failed',
    project: null,
    projectRoot: null,
    tasks: [],
    agentTree: null,
    activityEvents: null,
    receivedAt: good.receivedAt,
  })
  const cardWithReviewer = (deliveredTo) => goodSnapshot(deliveredTo, 'D:/project-godot', 1000)
  const tabProps = { sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-212', 'session-w212') }
  const mountSync = (syncStore) => {
    const host = createHost()
    const view = createView()
    const disposal = view.mount(host.host, { store: syncStore, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
    return { host, view, disposal, body: mountBody(view.Body, tabProps) }
  }

  try {
    // A visible tab refreshes once at mount and again on its 5 s timer; it never
    // starts or stops the panel's own poll.
    const visibleStore = createSyncStore(cardWithReviewer(null))
    const visible = mountSync(visibleStore)
    assert.equal(visibleStore.sync.loads, 1, 'mounting a visible tab loads the snapshot immediately')
    assert.equal(visibleStore.sync.startPolling, 0, 'the tab does not start a global poll')
    assert.equal(visibleStore.sync.stopPolling, 0, 'mounting never stops the panel poll')
    tick()
    assert.equal(visibleStore.sync.loads, 2, 'the visible tab refreshes again on the 5 s tick')

    // The review row starts unassigned; a refreshed snapshot that carries
    // review.deliveredTo re-renders the mounted body into the reviewer row.
    const beforeRows = stageRowNodes(visible.body.node)
    assert.equal(beforeRows[1].props['data-agent-stage-has-session'], 'false', 'the review row starts unassigned')
    assert.ok(JSON.stringify(beforeRows[1]).includes('未分配'), 'the unassigned review row says so')
    visibleStore.push(goodSnapshot({ name: 'reviewer-t-212', id: 'session-rev212' }, 'D:/project-godot', 2000))
    const afterRows = stageRowNodes(visible.body.node)
    assert.equal(afterRows[1].props['data-agent-stage-session'], 'session-rev212', 'a delivered reviewer reaches the review row without reopening the tab')
    assert.equal(afterRows[1].props['data-agent-stage-has-session'], 'true', 'the review row becomes actionable')
    assert.ok(JSON.stringify(afterRows[1]).includes('reviewer-t-212'), 'the review row names the delivered reviewer')
    assert.equal(stageButtonOf(visible.body.node, 'review').props.disabled, false, 'the delivered review row can open its conversation')

    // Unmount clears the tab's own timer and listener, and touches no poller.
    visible.body.unmount()
    visible.disposal()
    tick()
    assert.equal(visibleStore.sync.loads, 2, 'an unmounted tab never refreshes again')
    assert.equal(visibleStore.sync.stopPolling, 0, 'unmount never stops the panel poll')
    assert.equal(visibleStore.sync.startPolling, 0, 'unmount never starts another poll')
    assert.equal(intervals.size, 0, 'unmount clears every timer the tab created')
    assert.equal(visibilityListeners.size, 0, 'unmount removes the visibility listener')

    // A hidden tab pauses: no load at mount, no load on the tick. Becoming
    // visible catches up at once and resumes the 5 s interval.
    visibility = 'hidden'
    const hiddenStore = createSyncStore(cardWithReviewer(null))
    const hidden = mountSync(hiddenStore)
    assert.equal(hiddenStore.sync.loads, 0, 'a hidden tab does not load at mount')
    tick()
    assert.equal(hiddenStore.sync.loads, 0, 'a hidden tab does not load on the tick')
    setVisibility('visible')
    assert.equal(hiddenStore.sync.loads, 1, 'becoming visible refreshes immediately')
    tick()
    assert.equal(hiddenStore.sync.loads, 2, 'the resumed interval refreshes again')
    setVisibility('hidden')
    tick()
    assert.equal(hiddenStore.sync.loads, 2, 'hiding the document pauses the tab again')
    hidden.body.unmount()
    hidden.disposal()
    assert.equal(intervals.size, 0, 'the hidden tab also releases its timer on unmount')

    // The store's OFFLINE/CATCH failure shape must not blank the tab: a failed
    // poll after a good one keeps the card, the reviewer and all three rows.
    visibility = 'visible'
    const deliveredSnapshot = goodSnapshot({ name: 'reviewer-t-212', id: 'session-rev212' }, 'D:/project-godot', 1000)
    const failureStore = createSyncStore(deliveredSnapshot)
    const failureTab = mountSync(failureStore)
    const goodRows = stageRowNodes(failureTab.body.node)
    assert.equal(goodRows.length, 3, 'the good snapshot renders the three stage rows')
    assert.equal(goodRows[1].props['data-agent-stage-session'], 'session-rev212', 'the good snapshot names the reviewer')
    failureStore.push(failureOf(deliveredSnapshot, 'D:/project-godot'))
    assert.equal(failureTab.body.node.props['data-agent-task'], 'T-212', 'a failed poll keeps the tab card id')
    assert.equal(failureTab.body.node.props['data-agent-role'], 'worker', 'a failed poll keeps the tab role')
    const keptRows = stageRowNodes(failureTab.body.node)
    assert.equal(keptRows.length, 3, 'a failed poll keeps all three stage rows')
    assert.equal(keptRows[1].props['data-agent-stage-session'], 'session-rev212', 'a failed poll keeps the delivered reviewer')
    assert.ok(JSON.stringify(failureTab.body.node).includes('reviewer-t-212'), 'a failed poll keeps the reviewer name')
    assert.equal(stageButtonOf(failureTab.body.node, 'review').props.disabled, false, 'a failed poll keeps the review conversation actionable')

    // A failure for a DIFFERENT project must not replay the cached card: the
    // project switch guard (the previous project's rows may never come back).
    failureStore.push(failureOf(deliveredSnapshot, 'D:/another-project'))
    assert.equal(stageRowNodes(failureTab.body.node).length, 0, 'a different project never falls back to the old project card')
    assert.ok(JSON.stringify(failureTab.body.node).includes('没有关联任务'), 'the switched project shows no borrowed card')

    // A switch-shaped snapshot (new project id, old board kept, unchanged
    // receivedAt) must invalidate the cached card, or a later PROJECT-LESS
    // payload failure for the new project would replay the previous project's
    // card through the "unknown project may fall back" path.
    failureStore.push(Object.assign({}, deliveredSnapshot, { project: 'D:/third-project' }))
    assert.equal(stageRowNodes(failureTab.body.node).length, 3, 'the store switch transient still renders its board')
    failureStore.push(payloadFailureOf(deliveredSnapshot))
    assert.equal(stageRowNodes(failureTab.body.node).length, 0, 'a switch transient cannot seed the last-good cache')
    failureTab.body.unmount()
    failureTab.disposal()

    // The OTHER real failure branch: the /state PAYLOAD failure. The host error
    // body has no project and tcSnapshot keeps only a string project, so this
    // snapshot has project: null (receivedAt unchanged, tasks cleared). The last
    // good card must survive this shape as well.
    const payloadFailure = payloadFailureOf(deliveredSnapshot)
    assert.equal(payloadFailure.source, 'error')
    assert.equal(payloadFailure.project, null, 'the payload failure snapshot has no project')
    assert.equal(payloadFailure.tasks.length, 0)
    assert.equal(payloadFailure.receivedAt, deliveredSnapshot.receivedAt, 'the payload failure keeps the previous receipt time')
    const payloadStore = createSyncStore(deliveredSnapshot)
    const payloadTab = mountSync(payloadStore)
    payloadStore.push(payloadFailure)
    assert.equal(payloadTab.body.node.props['data-agent-task'], 'T-212', 'a payload-branch failure keeps the tab card id')
    assert.equal(payloadTab.body.node.props['data-agent-role'], 'worker', 'a payload-branch failure keeps the tab role')
    const payloadRows = stageRowNodes(payloadTab.body.node)
    assert.equal(payloadRows.length, 3, 'a payload-branch failure keeps all three stage rows')
    assert.equal(payloadRows[1].props['data-agent-stage-session'], 'session-rev212', 'a payload-branch failure keeps the delivered reviewer')
    assert.ok(JSON.stringify(payloadTab.body.node).includes('reviewer-t-212'), 'a payload-branch failure keeps the reviewer name')
    assert.equal(stageButtonOf(payloadTab.body.node, 'review').props.disabled, false, 'a payload-branch failure keeps the review conversation actionable')
    payloadTab.body.unmount()
    payloadTab.disposal()

    // The load call itself never escapes: a throwing load is caught and a
    // rejected load never becomes an unhandled rejection. These stores keep a
    // good snapshot, so this proves error containment, not snapshot retention
    // (retention is proven above with the real failure shape).
    const throwingStore = {
      load() { throw new Error('offline') },
      getSnapshot() { return deliveredSnapshot },
      subscribe() { return () => {} },
    }
    const throwing = mountSync(throwingStore)
    assert.doesNotThrow(() => tick(), 'a throwing refresh never escapes the timer')
    assert.equal(stageRowNodes(throwing.body.node).length, 3, 'a throwing load leaves the rendered snapshot intact')
    throwing.body.unmount()
    throwing.disposal()

    let rejectedLoads = 0
    const rejectingStore = {
      load() {
        rejectedLoads += 1
        return Promise.reject(new Error('offline'))
      },
      getSnapshot() { return deliveredSnapshot },
      subscribe() { return () => {} },
    }
    const rejecting = mountSync(rejectingStore)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(rejectedLoads, 1, 'the rejecting load was attempted')
    assert.equal(stageRowNodes(rejecting.body.node).length, 3, 'a rejected load leaves the rendered snapshot intact')
    rejecting.body.unmount()
    rejecting.disposal()
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    if (hadDocument === true) globalThis.document = realDocument
    else delete globalThis.document
  }
}

// ── 40-tail / shipped bundle carry the same wiring ──────────────────────────
const TAIL = readFileSync(new URL('../../client/src/40-tail.part', import.meta.url), 'utf8')
const BUNDLE = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
assert.ok(TAIL.includes("ctx.inject(['sidebarRight', 'sidebarRightTabs', 'uiWorkspace']"), 'the sidebar injection also waits for uiWorkspace')
assert.ok(TAIL.includes('uiWorkspace: scoped === null || scoped === undefined ? null : scoped.uiWorkspace'), 'the mount receives the uiWorkspace service')
assert.ok(TAIL.includes('return tab.mount(scoped, {'), 'the tab still mounts on the scoped services')
assert.ok(BUNDLE.includes("ctx.inject(['sidebarRight', 'sidebarRightTabs', 'uiWorkspace']"), 'the shipped bundle carries the same sidebar injection')
assert.ok(BUNDLE.includes('agentStageOpen'), 'the shipped bundle carries the per-stage conversation switch')
assert.ok(BUNDLE.includes('stageSessionsOf'), 'the shipped bundle carries the three-stage resolver')
assert.ok(BUNDLE.includes('open-stage-session'), 'the shipped bundle carries the stage-row action')
assert.ok(BUNDLE.includes('gbt-agenttabstagebtn'), 'the shipped bundle carries the stage-row styles')
assert.ok(BUNDLE.includes('agentTabSwitchNote'), 'the shipped bundle carries the session-scope note')
assert.ok(BUNDLE.includes("AGENT_TAB_SESSION_PARAM = 'agentSession'"), 'the shipped bundle carries the agent-session navigation param')
assert.ok(BUNDLE.includes('multiple: true'), 'the shipped bundle registers the tab type as multiple')
assert.ok(BUNDLE.includes('sidebar.tabsIn'), 'the shipped bundle verifies the placement through the tab strip')
assert.ok(BUNDLE.includes('hostSessionOf'), 'the shipped bundle resolves the host session')
assert.ok(BUNDLE.includes('switchToHost(hostSession)'), 'the shipped bundle switches the main view after a verified open')
assert.ok(BUNDLE.includes('createdTabOf(before, after)'), 'the shipped bundle verifies a NEW tab, not just the kind')
assert.ok(BUNDLE.includes('AGENT_TAB_SYNC_MS = 5000'), 'the shipped bundle carries the tab 5 s sync interval')
assert.ok(BUNDLE.includes('useTabSync'), 'the shipped bundle refreshes the tab snapshot itself')
assert.ok(BUNDLE.includes('visibilitychange'), 'the shipped bundle follows the document visibility')
assert.ok(BUNDLE.includes('useStableSnapshot'), 'the shipped bundle keeps the last good snapshot through a failed poll')
assert.ok(BUNDLE.includes('failedSnapshotOf'), 'the shipped bundle recognises the store failure shape')
assert.ok(BUNDLE.includes('cache.receivedAt = snapshot.receivedAt'), 'the shipped bundle tracks the snapshot generation for the fallback')

// T-227: the tab owns only its refresh timer; the panel's poll is not its to
// start or stop, and the sidebar module never calls either method.
const AGENT_SIDEBAR_SOURCE = readFileSync(new URL('../../client/src/views/agent-sidebar.cjs', import.meta.url), 'utf8')
assert.equal(AGENT_SIDEBAR_SOURCE.includes('.stopPolling('), false, 'the agent tab never CALLS stopPolling')
assert.equal(AGENT_SIDEBAR_SOURCE.includes('.startPolling('), false, 'the agent tab never CALLS startPolling')
assert.ok(AGENT_SIDEBAR_SOURCE.includes('store.load'), 'the agent tab refreshes through the shared store load')

console.log('PASS  agent sidebar registers a multiple tab type, opens one independent tab per card in the host session, verifies the strip delta, lists the develop/review/test stage sessions (exact-card only, reused sessions allowed, missing stages disabled, no-workspace disabled with a note), refreshes the shared snapshot on mount and every 5 s while visible without touching the panel poll (hidden pauses, unmount clears, a delivered reviewer reaches the stage rows, and both real failed-poll shapes (offline copy and project-less payload) keep the last good card while a project switch never replays it), switches to the host conversation (and says the subagent switch takes the sidebar with it), and degrades safely')
