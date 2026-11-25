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
//
// T-234: the mounted tab reads ONE card, not the board. A real task store backs
// the mount so the requests can be inspected: opening the tab asks /task?id plus
// /meta and NEVER /state, the 5 s tick re-reads the card inside the meta TTL, a
// review/test deliveredTo that lands in the detail reaches the stage rows, a
// failed /task keeps the last good card, and a project switch clears it. A
// hidden tab pauses, unmount clears only its own timer, and the sidebar never
// calls store.load() nor starts/stops the panel's poll.
//
// T-234 review: the deletion and freshness holes are covered too. A delete answer
// (or a /task unknown-task) forgets the card, renders only its id, and stops
// polling it; a detail older than the board summary never drives the rows; a
// recorded /meta failure is not retried by the tab cadence.

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
  // T-241: the agent tab's history status/hint come from the panel dictionary.
  agentStatusHistory: '历史',
  agentHistoryHint: '实时树只含活跃 agent，身份来自任务记录',
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
// T-225: the board fixture is the /state SUMMARY. This is the shape summaryOf
// emits: no history / spec / acceptance / evidence, each stage record reduced to
// status/by/byName/at/attempt/deliveredAt and the compact deliveredTo ({ name,
// id }) the three stage rows resolve a real reviewer/tester session from.
// Building the suite on THIS shape (the T-219 fixture used to be the detail
// shape) is what proves the tab reads what the server really sends.
// T-234: the tab now prefers the card's /task DETAIL when the domain store has
// one, with this summary as the fallback; the detail is derived from this same
// fixture plus the fields only the detail carries (spec/history), so the two
// shapes stay honest.
const SUMMARY_TASK_KEYS = [
  'id', 'title', 'status', 'state', 'phase', 'blockedReason', 'kind', 'reportSummary',
  'ownerSession', 'priority', 'dependsOn', 'dependency', 'writeFileCount', 'verification', 'target', 'base',
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
  // T-230: the frozen summary names the probe COUNT; the probe list is detail-class.
  verification: { probeCount: 1 },
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

// ── T-234: the tab reads its CARD's detail, not the whole board ─────────────
// T-227 made every mounted tab refresh the SHARED board through the store's
// load(): a tab that only renders ONE card's review/test deliveredTo plus the
// live agent tree pulled a /state light answer (and then had to find its taskId
// in it) every 5 s. The tab now asks the domain store for exactly those two
// things — ensureTaskDetail(taskId) and ensureAgents() — and renders from
// getTaskDetail(taskId) / agentsView(). It never loads the board.
{
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document')
  const realDocument = hadDocument ? globalThis.document : undefined
  const realFetch = globalThis.fetch
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
  const flush = async () => {
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
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

  // The board card as /state summarizes it: neither stage record names a
  // deliveredTo, so the tab starts with an unassigned review/test row.
  const boardCard = Object.assign({}, task, {
    review: Object.assign({}, task.review, { deliveredTo: null }),
    test: Object.assign({}, task.test, { deliveredTo: null }),
  })
  const boardOf = (project, receivedAt, tasks) => ({
    tasks: tasks === undefined ? [boardCard] : tasks,
    agentTree: agentTree,
    activityEvents: null,
    source: 'host',
    project: project,
    receivedAt: receivedAt,
  })
  // The card's own /task DETAIL: the same card plus the stage delivery, spec and
  // history fields only the detail carries.
  const detailOf = (review, test) => Object.assign({}, task, {
    spec: 'the detail-only spec',
    history: [{ at: '2026-11-21T06:02:00.000Z', to: 'reviewing', note: 'submitted' }],
    review: Object.assign({}, task.review, { deliveredTo: review === undefined ? null : review }),
    test: Object.assign({}, task.test, { deliveredTo: test === undefined ? null : test }),
  })

  // A domain store: the tab's two requests, the two readers it renders from,
  // and the board surface it must NOT use any more.
  function createDomainStore(initial) {
    let current = initial
    let agents = initial === null || initial === undefined ? null : initial.agentTree
    // One detail PER CARD ID, like the real domain: a detail read for another
    // card must never reach this tab.
    const details = new Map()
    // Cards the host confirmed are gone: never rendered, never polled again.
    const gone = new Set()
    const subscribers = new Set()
    const sync = { details: [], agents: 0, loads: 0, startPolling: 0, stopPolling: 0 }
    function emit() {
      for (const listener of Array.from(subscribers)) listener()
    }
    return {
      sync,
      ensureTaskDetail(id) {
        sync.details.push(id)
        return Promise.resolve({ ok: true })
      },
      ensureAgents() {
        sync.agents += 1
        return Promise.resolve({ ok: true })
      },
      getTaskDetail(id) {
        const entry = details.get(id)
        if (entry === undefined) return null
        // A hidden entry models the real store refusing a detail whose board
        // summary has already moved on: the view must fall back to the summary.
        return { id: id, task: entry.hidden === true ? null : entry.task, status: entry.hidden === true ? 'stale' : entry.status, error: null }
      },
      agentsView() {
        return { agentTree: agents, status: 'ready', error: null, receivedAt: 1 }
      },
      isTaskGone(id) {
        return gone.has(String(id))
      },
      getSnapshot() { return current },
      subscribe(listener) {
        subscribers.add(listener)
        return () => { subscribers.delete(listener) }
      },
      // The shared-store surface the tab must NOT use any more.
      load() {
        sync.loads += 1
        return Promise.resolve({ ok: true })
      },
      startPolling() { sync.startPolling += 1 },
      stopPolling() { sync.stopPolling += 1 },
      // Test drivers.
      push(next) {
        current = next
        emit()
      },
      deliverDetail(nextDetail, status) {
        const id = nextDetail !== null && nextDetail !== undefined && nextDetail.id !== undefined && nextDetail.id !== null ? String(nextDetail.id) : ''
        if (id === '') return
        gone.delete(id)
        details.set(id, { task: nextDetail, status: status === undefined ? 'ready' : status, hidden: false })
        emit()
      },
      failDetail() {
        for (const entry of details.values()) entry.status = 'error'
        emit()
      },
      hideDetail(id) {
        const entry = details.get(String(id))
        if (entry === undefined) return
        entry.hidden = true
        emit()
      },
      clearDetail() {
        details.clear()
        gone.clear()
        emit()
      },
      markGone(id) {
        gone.add(String(id))
        emit()
      },
      setAgents(next) {
        agents = next
        emit()
      },
    }
  }

  const tabProps = { sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-212', 'session-w212') }
  const mountSync = (domainStore) => {
    const host = createHost()
    const view = createView()
    const disposal = view.mount(host.host, { store: domainStore, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
    return { host, view, disposal, body: mountBody(view.Body, tabProps) }
  }

  try {
    // A VISIBLE tab asks for ITS card detail and the agents block at mount and on
    // every 5 s tick; it never loads the board and never touches the panel poll.
    visibility = 'visible'
    const visibleStore = createDomainStore(boardOf('D:/project-godot', 1000))
    const visible = mountSync(visibleStore)
    assert.deepEqual(visibleStore.sync.details, ['T-212'], 'mounting a visible tab asks for THIS card immediately')
    assert.equal(visibleStore.sync.agents, 1, 'mounting also asks the agents domain')
    assert.equal(visibleStore.sync.loads, 0, 'the tab never loads the board')
    assert.equal(visibleStore.sync.startPolling, 0, 'the tab does not start a global poll')
    assert.equal(visibleStore.sync.stopPolling, 0, 'mounting never stops the panel poll')
    tick()
    assert.deepEqual(visibleStore.sync.details, ['T-212', 'T-212'], 'the 5 s tick re-reads exactly this card')
    assert.equal(visibleStore.sync.agents, 2, 'the 5 s tick also re-reads the agents block')
    assert.equal(visibleStore.sync.loads, 0, 'the tick never loads the board either')

    // The board summary names no reviewer; only the DETAIL does. The deliveredTo
    // reaches the review row without reopening the tab.
    const beforeRows = stageRowNodes(visible.body.node)
    assert.equal(beforeRows.length, 3, 'the board summary renders the three stage rows')
    assert.equal(beforeRows[1].props['data-agent-stage-has-session'], 'false', 'the review row starts unassigned')
    assert.ok(JSON.stringify(beforeRows[1]).includes('未分配'), 'the unassigned review row says so')
    assert.equal(beforeRows[2].props['data-agent-stage-has-session'], 'false', 'the test row starts unassigned')
    const detailOnly = { name: 'reviewer-detail-only', id: 'session-review-detail' }
    visibleStore.deliverDetail(detailOf(detailOnly))
    const afterRows = stageRowNodes(visible.body.node)
    assert.equal(afterRows[1].props['data-agent-stage-session'], 'session-review-detail', 'a deliveredTo read from the DETAIL reaches the review row')
    assert.equal(afterRows[1].props['data-agent-stage-has-session'], 'true', 'the review row becomes actionable')
    assert.ok(JSON.stringify(afterRows[1]).includes('reviewer-detail-only'), 'the review row names the delivered reviewer')
    assert.equal(stageButtonOf(visible.body.node, 'review').props.disabled, false, 'the delivered review row can open its conversation')
    assert.equal(visible.body.node.props['data-agent-task'], 'T-212', 'the detail keeps the exact card id')
    assert.ok(JSON.stringify(visible.body.node).includes('提交'), 'the detail history feeds the latest activity')
    // The title resolves the same DETAIL: this session is on no board tree.
    const detailTitle = visible.view.Title({ sessionId: 'session-review-detail', useTabInfo: tabInfoWithAgent('T-212', 'session-review-detail') })
    assert.ok(JSON.stringify(detailTitle).includes('reviewer-detail-only'), 'the title names a session only the DETAIL carries')

    // The same detail reaches the TEST row once it names a tester.
    visibleStore.deliverDetail(detailOf(detailOnly, { name: 'tester-detail-only', id: 'session-test-detail' }))
    assert.equal(stageRowNodes(visible.body.node)[2].props['data-agent-stage-session'], 'session-test-detail', 'the test row reads test.deliveredTo from the detail')
    assert.ok(JSON.stringify(stageRowNodes(visible.body.node)[2]).includes('tester-detail-only'), 'the test row names the delivered tester')

    // A detail the store now considers OLDER than the board summary must not
    // drive the rows: after an action invalidated the card the tab renders the
    // summary again, instead of offering a reviewer the board no longer names.
    visibleStore.hideDetail('T-212')
    const staleRows = stageRowNodes(visible.body.node)
    assert.equal(staleRows[1].props['data-agent-stage-has-session'], 'false', 'an older detail does not drive the stage rows')
    assert.ok(JSON.stringify(staleRows[1]).includes('未分配'), 'the summary is rendered instead of the older detail')
    assert.equal(visible.body.node.props['data-agent-task'], 'T-212', 'the card id still comes from the tab')

    // A detail read for ANOTHER card never reaches this tab (the fake domain is
    // keyed by id, like the real one).
    visibleStore.clearDetail()
    visibleStore.deliverDetail(Object.assign({}, detailOf({ name: 'reviewer-other', id: 'session-other' }), { id: 'T-OTHER' }))
    assert.equal(stageRowNodes(visible.body.node)[1].props['data-agent-stage-has-session'], 'false', 'another card detail is never rendered')
    assert.ok(!JSON.stringify(visible.body.node).includes('reviewer-other'), 'another card reviewer never appears')
    visibleStore.deliverDetail(detailOf(detailOnly, { name: 'tester-detail-only', id: 'session-test-detail' }))
    assert.equal(stageRowNodes(visible.body.node)[1].props['data-agent-stage-session'], 'session-review-detail', 'this card detail drives the rows again')

    // A FAILED detail read keeps the last good card: every row, the delivered
    // reviewer/tester and the task id stay on screen.
    visibleStore.failDetail()
    assert.equal(stageRowNodes(visible.body.node).length, 3, 'a failed detail keeps all three stage rows')
    assert.equal(stageRowNodes(visible.body.node)[1].props['data-agent-stage-session'], 'session-review-detail', 'a failed detail keeps the delivered reviewer')
    assert.equal(stageRowNodes(visible.body.node)[2].props['data-agent-stage-session'], 'session-test-detail', 'a failed detail keeps the delivered tester')
    assert.equal(visible.body.node.props['data-agent-task'], 'T-212', 'a failed detail keeps the card id')

    // The agents domain drives the live status: the board snapshot's tree says
    // running, the domain says idle, and the tab follows the DOMAIN.
    const idleTree = {
      available: true,
      root: agentTree.root,
      members: agentTree.members.map((member) => Object.assign({}, member, { status: member.id === 'session-w212' ? 'idle' : member.status })),
      count: agentTree.count,
      error: null,
    }
    visibleStore.setAgents(idleTree)
    assert.ok(JSON.stringify(visible.body.node).includes('空闲'), 'the agents domain supplies the live status')
    visibleStore.setAgents(agentTree)
    assert.ok(JSON.stringify(visible.body.node).includes('运行中'), 'restoring the tree restores the running status')

    // A project switch clears the domains: no card, no stage rows, and no
    // session is minted for a card that is not there.
    visibleStore.clearDetail()
    visibleStore.push(boardOf('D:/another-project', 2000, []))
    assert.equal(stageRowNodes(visible.body.node).length, 0, 'a switched project drops the previous card rows')
    assert.ok(JSON.stringify(visible.body.node).includes('没有关联任务'), 'the switched project shows no borrowed card')

    // A card the HOST confirmed gone is never re-rendered from a board copy the
    // panel has not refreshed yet: the tab keeps only its id.
    visibleStore.push(boardOf('D:/project-godot', 3000))
    assert.equal(stageRowNodes(visible.body.node).length, 3, 'a board that still lists the card renders its summary')
    visibleStore.markGone('T-212')
    assert.equal(stageRowNodes(visible.body.node).length, 0, 'a confirmed-gone card renders no rows even from a stale board copy')
    assert.ok(JSON.stringify(visible.body.node).includes('没有关联任务'), 'a confirmed-gone card keeps only its id')

    // Unmount clears the tab's timer and listener and touches no poller.
    visible.body.unmount()
    visible.disposal()
    tick()
    assert.deepEqual(visibleStore.sync.details, ['T-212', 'T-212'], 'an unmounted tab never asks for the card again')
    assert.equal(visibleStore.sync.agents, 2, 'an unmounted tab never asks for the agents again')
    assert.equal(visibleStore.sync.stopPolling, 0, 'unmount never stops the panel poll')
    assert.equal(visibleStore.sync.startPolling, 0, 'unmount never starts another poll')
    assert.equal(intervals.size, 0, 'unmount clears every timer the tab created')
    assert.equal(visibilityListeners.size, 0, 'unmount removes the visibility listener')

    // The last good BOARD survives a failed poll in the legacy snapshot path
    // (the tab has no detail yet, e.g. the guide overview): both real store
    // failure shapes keep the card, and another project's failure never replays it.
    const boardSnapshot = boardOf('D:/project-godot', 1000)
    const failureOf = (good, project) => Object.assign({}, good, { ok: false, source: 'error', message: 'offline', project: project, tasks: [] })
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
    const failureStore = createDomainStore(boardSnapshot)
    const failureTab = mountSync(failureStore)
    assert.equal(stageRowNodes(failureTab.body.node).length, 3, 'the good board renders the three stage rows')
    // The offline/catch branch: a copy of the last snapshot, project kept, tasks cleared.
    failureStore.push(failureOf(boardSnapshot, 'D:/project-godot'))
    assert.equal(failureTab.body.node.props['data-agent-task'], 'T-212', 'a failed poll keeps the tab card id')
    assert.equal(stageRowNodes(failureTab.body.node).length, 3, 'a failed poll keeps all three stage rows')
    // A failure for a DIFFERENT project never replays the cached card.
    failureStore.push(failureOf(boardSnapshot, 'D:/another-project'))
    assert.equal(stageRowNodes(failureTab.body.node).length, 0, 'a different project never falls back to the old project card')
    assert.ok(JSON.stringify(failureTab.body.node).includes('没有关联任务'), 'the switched project shows no borrowed card')
    // A switch transient (new project id, old board kept, same receipt time) must
    // invalidate the cached card, or a later PROJECT-LESS payload failure would
    // replay the previous project's card.
    failureStore.push(Object.assign({}, boardSnapshot, { project: 'D:/third-project' }))
    assert.equal(stageRowNodes(failureTab.body.node).length, 3, 'the store switch transient still renders its board')
    failureStore.push(payloadFailureOf(boardSnapshot))
    assert.equal(stageRowNodes(failureTab.body.node).length, 0, 'a switch transient cannot seed the last-good cache')
    failureTab.body.unmount()
    failureTab.disposal()

    // A hidden tab pauses: no request at mount and none on the tick; becoming
    // visible catches up at once and resumes the 5 s interval.
    visibility = 'hidden'
    const hiddenStore = createDomainStore(boardOf('D:/project-godot', 1000))
    const hidden = mountSync(hiddenStore)
    assert.deepEqual(hiddenStore.sync.details, [], 'a hidden tab asks for nothing at mount')
    assert.equal(hiddenStore.sync.agents, 0, 'a hidden tab asks for no agents at mount')
    tick()
    assert.deepEqual(hiddenStore.sync.details, [], 'a hidden tab asks for nothing on the tick')
    assert.equal(hiddenStore.sync.agents, 0, 'a hidden tab asks for no agents on the tick')
    setVisibility('visible')
    assert.deepEqual(hiddenStore.sync.details, ['T-212'], 'becoming visible asks for the card immediately')
    assert.equal(hiddenStore.sync.agents, 1, 'becoming visible asks for the agents immediately')
    tick()
    assert.deepEqual(hiddenStore.sync.details, ['T-212', 'T-212'], 'the resumed interval asks again')
    setVisibility('hidden')
    tick()
    assert.deepEqual(hiddenStore.sync.details, ['T-212', 'T-212'], 'hiding the document pauses the tab again')
    hidden.body.unmount()
    hidden.disposal()
    assert.equal(intervals.size, 0, 'the hidden tab also releases its timer on unmount')

    // A store WITHOUT the domains is never polled through load(): the tab
    // degrades to the snapshot it was handed instead of pulling a board answer.
    visibility = 'visible'
    const legacySync = { loads: 0 }
    const legacy = mountSync({
      getSnapshot() { return boardOf('D:/project-godot', 1000) },
      subscribe() { return () => {} },
      load() {
        legacySync.loads += 1
        return Promise.resolve({ ok: true })
      },
    })
    assert.equal(legacySync.loads, 0, 'a legacy store is not asked to load the board')
    tick()
    assert.equal(legacySync.loads, 0, 'not even on the tick')
    assert.equal(legacy.body.node.props['data-agent-task'], 'T-212', 'the legacy store still renders its snapshot card')
    legacy.body.unmount()
    legacy.disposal()

    // A throwing / rejecting domain call never escapes the timer, and the last
    // rendered card stays on screen.
    const throwing = mountSync({
      ensureTaskDetail() { throw new Error('offline') },
      ensureAgents() { throw new Error('offline') },
      getTaskDetail() { return { id: 'T-212', task: detailOf({ name: 'reviewer-t-212', id: 'session-rev212' }), status: 'ready' } },
      getSnapshot() { return boardOf('D:/project-godot', 1000) },
      subscribe() { return () => {} },
    })
    assert.doesNotThrow(() => tick(), 'a throwing ensure never escapes the timer')
    assert.equal(stageRowNodes(throwing.body.node)[1].props['data-agent-stage-session'], 'session-rev212', 'a throwing ensure leaves the rendered card intact')
    throwing.body.unmount()
    throwing.disposal()

    const rejecting = mountSync({
      ensureTaskDetail() { return Promise.reject(new Error('offline')) },
      ensureAgents() { return Promise.reject(new Error('offline')) },
      getTaskDetail() { return null },
      getSnapshot() { return boardOf('D:/project-godot', 1000) },
      subscribe() { return () => {} },
    })
    await flush()
    assert.equal(stageRowNodes(rejecting.body.node).length, 3, 'a rejected ensure leaves the board summary rows intact')
    rejecting.body.unmount()
    rejecting.disposal()

    // ── the REAL domain store: /task + /meta only, never /state ────────────
    {
      const { createTaskStore } = require('../../client/src/store.cjs')
      const requests = []
      const actions = []
      let now = 1000000
      let project = '/repo'
      let boardTasks = [boardCard]
      let detailCard = detailOf(null)
      let taskFailing = false
      let taskGone = false
      let metaFailing = false
      const deps = {
        TC_STATE_URL: '/state',
        TC_WORKTREES_URL: '/worktrees',
        TC_TASK_URL: '/task',
        TC_LIST_URL: '/list',
        TC_ACTION_URL: '/action',
        tcSnapshot: (payload, source, message) => ({
          ok: payload.ok === true,
          project: payload.project === undefined ? null : payload.project,
          source: source,
          message: message,
          tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
          counts: payload.counts === undefined ? {} : payload.counts,
          details: {},
          seq: null,
          activityEvents: null,
          actionResult: null,
          actionError: null,
        }),
        tcPinnedProject: () => null,
        tcMergeSnapshot: (previous, payload) => Object.assign({}, previous, payload, { source: 'host' }),
        tcErrorMessage: (payload, t) => 'error:' + t('x'),
        tcWithSession: (url) => url,
        tcSessionId: () => 'session-test',
        tcPinProject: () => {},
        tcNow: () => now,
      }
      globalThis.fetch = async (url, options) => {
        const text = String(url)
        requests.push(text)
        if (text.indexOf('/state') === 0) {
          return {
            json: async () => ({
              ok: true,
              full: true,
              project: project,
              projectRoot: project,
              resolvedFrom: 'panel',
              counts: { total: boardTasks.length },
              tasks: boardTasks,
              metadata: { split: true, light: true, deferred: [] },
            }),
          }
        }
        if (text.indexOf('/meta') === 0) {
          if (metaFailing) {
            return { json: async () => ({ ok: false, project: project, errors: { agentTree: 'agent registry unavailable' }, metadata: { split: true, deferred: [] } }) }
          }
          return {
            json: async () => ({
              ok: true,
              project: project,
              meta: { scope: { light: false }, agentTree: agentTree },
              errors: {},
              metadata: { split: true, deferred: [] },
            }),
          }
        }
        if (text.indexOf('/task') === 0) {
          if (taskGone) return { json: async () => ({ ok: false, code: 'unknown-task', message: 'no task with id T-212' }) }
          if (taskFailing) return { json: async () => ({ ok: false, code: 'failed', message: 'detail read failed' }) }
          return { json: async () => ({ ok: true, task: detailCard }) }
        }
        if (text.indexOf('/action') === 0) {
          const body = JSON.parse(options.body)
          actions.push(body.action + ':' + String(body.id === undefined ? (body.taskId === undefined ? body.decisionId : body.taskId) : body.id))
          if (body.action === 'decisionAnswer') {
            // A DELETE-gated dependency-tree purge: its applied summary names EVERY
            // removed id, which is what the store has to forget.
            return { json: async () => ({ ok: true, seq: 11, decision: { id: body.decisionId, status: 'answered' }, applied: { ok: true, executed: true, code: null, action: 'delete-tree', option: 'purge', summary: { deleted: ['T-212', 'T-DEP'] } }, affected: { ids: ['T-212', 'T-DEP'], count: 2 }, changed: ['board', 'detail', 'decisions'] }) }
          }
          return { json: async () => ({ ok: true, seq: 9, affected: { ids: ['T-212'], count: 1 }, changed: ['board', 'detail'] }) }
        }
        throw new Error('unexpected request: ' + text)
      }
      const realStore = createTaskStore((key) => key, deps)
      // The panel's own first paint (the tab is opened from that board).
      await realStore.load()
      await flush()
      assert.equal(realStore.getSnapshot().project, '/repo')

      requests.length = 0
      now += 11000
      const domainHost = createHost()
      const realView = createView()
      const realDispose = realView.mount(domainHost.host, { store: realStore, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
      const realBody = mountBody(realView.Body, tabProps)
      await flush()
      assert.deepEqual(requests.filter((url) => url.indexOf('/state') === 0), [], 'opening the tab requests no /state: ' + JSON.stringify(requests))
      assert.equal(requests.filter((url) => url.indexOf('/task?id=T-212') === 0).length, 1, 'opening the tab reads exactly its card detail: ' + JSON.stringify(requests))
      assert.equal(requests.filter((url) => url.indexOf('/meta') === 0).length, 1, 'opening the tab reads the agents block from /meta: ' + JSON.stringify(requests))
      const realRows = stageRowNodes(realBody.node)
      assert.equal(realRows.length, 3, 'the real detail renders the three stage rows')
      assert.equal(realRows[1].props['data-agent-stage-has-session'], 'false', 'the detail starts with an unassigned review row')
      assert.equal(realBody.node.props['data-agent-role'], 'worker', 'the detail card classifies the agent')

      // A 5 s tick re-reads the card (the delivered reviewer reaches the row) but
      // leaves /meta alone inside its 10 s staleTime.
      detailCard = detailOf({ name: 'reviewer-t-212', id: 'session-rev212' })
      let mark = requests.length
      now += 5000
      tick()
      await flush()
      const ticked = requests.slice(mark)
      assert.equal(ticked.filter((url) => url.indexOf('/state') === 0).length, 0, 'the tick requests no /state: ' + JSON.stringify(ticked))
      assert.equal(ticked.filter((url) => url.indexOf('/task?id=T-212') === 0).length, 1, 'the tick re-reads the card detail: ' + JSON.stringify(ticked))
      assert.equal(ticked.filter((url) => url.indexOf('/meta') === 0).length, 0, 'the tick is answered by the meta domain inside 10 s: ' + JSON.stringify(ticked))
      assert.equal(stageRowNodes(realBody.node)[1].props['data-agent-stage-session'], 'session-rev212', 'the delivered reviewer reaches the row from the real /task answer')

      // A failed /task keeps the last good detail on screen.
      taskFailing = true
      mark = requests.length
      now += 5000
      tick()
      await flush()
      assert.equal(requests.slice(mark).filter((url) => url.indexOf('/task?id=T-212') === 0).length, 1, 'the failed tick still tried the detail')
      assert.equal(stageRowNodes(realBody.node)[1].props['data-agent-stage-session'], 'session-rev212', 'a failed /task keeps the last good reviewer')
      assert.equal(realBody.node.props['data-agent-task'], 'T-212', 'a failed /task keeps the card id')

      // ── a write invalidates the detail: the tab renders the SUMMARY at once ──
      // T-234 review: the domain keeps the old card as lastGood after an action,
      // but its recorded updatedAt no longer matches the summary. The tab must
      // not keep offering the reviewer the summary no longer names: it renders
      // the summary until the next detail read lands.
      taskFailing = false
      boardTasks = [Object.assign({}, boardCard, { updatedAt: '2026-11-21T07:00:00.000Z' })]
      await realStore.send('update', { id: 'T-212' })
      await flush()
      assert.equal(actions[actions.length - 1], 'update:T-212', 'the update went through the real action route')
      const afterAction = realStore.getTaskDetail('T-212')
      assert.ok(afterAction !== null && afterAction.task === null, 'a detail older than the board summary is not handed to the view: ' + JSON.stringify(afterAction))
      assert.equal(stageRowNodes(realBody.node)[1].props['data-agent-stage-has-session'], 'false', 'the rows fall back to the summary right after the action')
      // The next tick re-reads the card and the fresh detail drives the rows again.
      detailCard = detailOf({ name: 'reviewer-t-212', id: 'session-rev212' })
      mark = requests.length
      now += 5000
      tick()
      await flush()
      assert.equal(requests.slice(mark).filter((url) => url.indexOf('/task?id=T-212') === 0).length, 1, 'the tick re-reads the invalidated card')
      assert.equal(stageRowNodes(realBody.node)[1].props['data-agent-stage-session'], 'session-rev212', 'the refreshed detail drives the rows again')

      // ── a recorded /meta failure is not retried by the tab cadence ─────────
      // T-234 review: the tab is a routine poller, so a dead /meta waits for the
      // panel's explicit refresh (same policy as maybeLoadMeta) instead of being
      // re-asked by every open tab.
      metaFailing = true
      now += 11000
      mark = requests.length
      tick()
      await flush()
      assert.equal(requests.slice(mark).filter((url) => url.indexOf('/meta') === 0).length, 1, 'the tab asked the stale agents block once')
      now += 11000
      mark = requests.length
      tick()
      await flush()
      assert.equal(requests.slice(mark).filter((url) => url.indexOf('/meta') === 0).length, 0, 'a recorded /meta failure is not retried by the tab')
      metaFailing = false

      // A real project switch clears the detail and the agents domain: the tab
      // shows no borrowed card.
      project = '/repo-b'
      boardTasks = []
      now += 5000
      await realStore.load()
      await flush()
      assert.equal(realStore.getTaskDetail('T-212'), null, 'the project switch clears the card detail')
      assert.equal(stageRowNodes(realBody.node).length, 0, 'the switched project shows no stage rows')
      assert.ok(JSON.stringify(realBody.node).includes('没有关联任务'), 'the switched project shows no borrowed card')

      // Back on the first project the tab reads its card again...
      project = '/repo'
      boardTasks = [Object.assign({}, boardCard, { updatedAt: '2026-11-21T07:00:00.000Z' })]
      now += 5000
      await realStore.load()
      await flush()
      assert.equal(stageRowNodes(realBody.node).length, 3, 'the card is back on the board (summary rows)')

      // ── a DELETE answer forgets the card for good ─────────────────────────
      // T-234 review: delete is not an invalidate. The removed card must not stay
      // as lastGood (it would be painted back), and its id must stop being polled.
      taskGone = true
      boardTasks = []
      await realStore.send('delete', { id: 'T-212' })
      await flush()
      assert.equal(actions[actions.length - 1], 'delete:T-212', 'the delete went through the real action route')
      assert.equal(realStore.getTaskDetail('T-212'), null, 'a deleted card is dropped from the detail domain')
      assert.equal(stageRowNodes(realBody.node).length, 0, 'a deleted card renders no stage rows')
      assert.ok(JSON.stringify(realBody.node).includes('没有关联任务'), 'a deleted card keeps its id and says it has no task')
      mark = requests.length
      now += 5000
      tick()
      await flush()
      assert.equal(requests.slice(mark).filter((url) => url.indexOf('/task?id=T-212') === 0).length, 0, 'a confirmed-deleted card is not polled again: ' + JSON.stringify(requests.slice(mark)))
      // Even a stale board poll that still lists the card cannot bring it back.
      assert.equal(realStore.isTaskGone('T-212'), true, 'the store remembers the deleted id')
      boardTasks = [boardCard]
      await realStore.load()
      await flush()
      assert.equal(stageRowNodes(realBody.node).length, 0, 'a stale board copy never re-renders a deleted card')
      boardTasks = []
      await realStore.load()
      await flush()

      // A DELETE-gated decision purges a whole dependency tree: every id its
      // applied summary names is forgotten, not only the tab's own card.
      taskGone = false
      detailCard = Object.assign({}, detailOf(null), { id: 'T-DEP' })
      await realStore.ensureTaskDetail('T-DEP')
      await flush()
      assert.ok(realStore.getTaskDetail('T-DEP') !== null, 'the dependency card detail is cached first')
      await realStore.send('decisionAnswer', { decisionId: 'DEC-TREE', option: 'purge' })
      await flush()
      assert.equal(actions[actions.length - 1], 'decisionAnswer:DEC-TREE', 'the purge went through the decision route')
      assert.equal(realStore.getTaskDetail('T-212'), null, 'the purged tree forgets the tab card too')
      assert.equal(realStore.getTaskDetail('T-DEP'), null, 'the purged tree forgets each named id')
      const beforePurgedPoll = requests.length
      await realStore.ensureTaskDetail('T-DEP')
      assert.equal(requests.length, beforePurgedPoll, 'a purged card is not polled either')
      realBody.unmount()
      realDispose()
    }

    // ── a card the host no longer has: /task answers unknown-task ────────────
    // T-234 review: a tab opened for a card that no longer exists must neither
    // paint a cached card nor keep asking for it every 5 s.
    {
      const { createTaskStore } = require('../../client/src/store.cjs')
      const requests = []
      let now = 2000000
      const deps = {
        TC_STATE_URL: '/state',
        TC_WORKTREES_URL: '/worktrees',
        TC_TASK_URL: '/task',
        TC_LIST_URL: '/list',
        TC_ACTION_URL: '/action',
        tcSnapshot: (payload, source, message) => ({
          ok: payload.ok === true,
          project: payload.project === undefined ? null : payload.project,
          source: source,
          message: message,
          tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
          counts: payload.counts === undefined ? {} : payload.counts,
          details: {},
          seq: null,
          activityEvents: null,
          actionResult: null,
          actionError: null,
        }),
        tcPinnedProject: () => null,
        tcMergeSnapshot: (previous, payload) => Object.assign({}, previous, payload, { source: 'host' }),
        tcErrorMessage: () => 'error',
        tcWithSession: (url) => url,
        tcSessionId: () => 'session-test',
        tcPinProject: () => {},
        tcNow: () => now,
      }
      globalThis.fetch = async (url) => {
        const text = String(url)
        requests.push(text)
        if (text.indexOf('/state') === 0) {
          return { json: async () => ({ ok: true, full: true, project: '/repo', projectRoot: '/repo', resolvedFrom: 'panel', counts: { total: 0 }, tasks: [], metadata: { split: true, light: true, deferred: [] } }) }
        }
        if (text.indexOf('/meta') === 0) {
          return { json: async () => ({ ok: true, project: '/repo', meta: { scope: { light: false }, agentTree: agentTree }, errors: {}, metadata: { split: true, deferred: [] } }) }
        }
        if (text.indexOf('/task') === 0) return { json: async () => ({ ok: false, code: 'unknown-task', message: 'no task with id T-212' }) }
        throw new Error('unexpected request: ' + text)
      }
      const goneStore = createTaskStore((key) => key, deps)
      await goneStore.load()
      await flush()
      requests.length = 0
      now += 11000
      const goneHost = createHost()
      const goneView = createView()
      const goneDispose = goneView.mount(goneHost.host, { store: goneStore, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
      const goneBody = mountBody(goneView.Body, tabProps)
      await flush()
      assert.equal(requests.filter((url) => url.indexOf('/task?id=T-212') === 0).length, 1, 'the tab asked for the card it was opened from: ' + JSON.stringify(requests))
      assert.equal(requests.filter((url) => url.indexOf('/state') === 0).length, 0, 'opening a tab for a gone card requests no /state')
      assert.equal(goneStore.getTaskDetail('T-212'), null, 'an unknown-task answer never becomes a lastGood card')
      assert.equal(stageRowNodes(goneBody.node).length, 0, 'a gone card renders no stage rows')
      assert.ok(JSON.stringify(goneBody.node).includes('没有关联任务'), 'a gone card keeps its id and says it has no task')
      const goneMark = requests.length
      now += 5000
      tick()
      await flush()
      assert.equal(requests.slice(goneMark).filter((url) => url.indexOf('/task?id=T-212') === 0).length, 0, 'a confirmed-gone card is not polled again')
      goneBody.unmount()
      goneDispose()
    }
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    if (hadDocument === true) globalThis.document = realDocument
    else delete globalThis.document
    if (realFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = realFetch
  }
}

// ── T-241: the tree is ACTIVE-ONLY; history resolves from the card record ───
// The hot agent tree now lists active agents only, so a DONE card's reviewer/
// tester is no longer a member. Opening that historical card must STILL show
// the reviewer/tester (name, role, session) from the card's own deliveredTo,
// and must say the identity came from the record and that the agent is
// HISTORY — not paint 'unknown' just because the active-only tree omits it.
{
  const historicalTask = Object.assign({}, task, {
    id: 'T-300',
    title: 'historical card',
    status: 'done',
    state: 'done',
    phase: null,
    assignee: { name: 'worker-t-300', session: 'session-w300' },
    review: Object.assign({}, task.review, { status: 'approved', deliveredTo: { name: 'reviewer-t-300', id: 'session-rev300' } }),
    test: Object.assign({}, task.test, { status: 'passed', deliveredTo: { name: 'tester-t-300', id: 'session-test300' } }),
    updatedAt: '2026-11-20T00:00:00.000Z',
  })
  const liveTask = Object.assign({}, task, {
    id: 'T-301',
    title: 'live card',
    status: 'running',
    assignee: { name: 'worker-t-live', session: 'session-live-worker' },
    review: Object.assign({}, task.review, { deliveredTo: null }),
    test: Object.assign({}, task.test, { deliveredTo: null }),
  })
  // The active-only tree /meta now serves: ONE live stage agent, the 274
  // historical children only counted.
  const activeOnlyTree = {
    available: true,
    root: { id: 'session-root', name: 'lead', role: 'lead', status: 'running', taskId: null },
    members: [{ id: 'session-live-worker', name: 'worker-t-live', role: 'worker', status: 'running', taskId: 'T-301' }],
    count: 1,
    agentTotal: 275,
    agentTruncated: true,
    activeOnly: true,
    error: null,
  }
  const historySnapshot = { tasks: [historicalTask, liveTask], agentTree: activeOnlyTree, activityEvents: null }

  // The resolver: role and name come from the card's delivery records, and the
  // status says HISTORY because the active-only tree does not carry the agent.
  const historyReviewer = sidebar.agentInfoOf(historySnapshot, 'session-rev300', t, 1000, helpers, 'T-300')
  assert.equal(historyReviewer.name, 'reviewer-t-300', 'a historical reviewer is still named by the card record')
  assert.equal(historyReviewer.role, 'reviewer', 'the record tells the role')
  assert.equal(historyReviewer.taskId, 'T-300', 'the record tells the card')
  assert.equal(historyReviewer.status, 'history', 'an agent the active-only tree omits is HISTORY, not unknown')
  assert.equal(historyReviewer.stageSource, 'record', 'its identity comes from the card record')
  assert.equal(historyReviewer.statusLabelKey, 'agentStatusHistory', 'the history status has its own label')
  const liveWorker = sidebar.agentInfoOf(historySnapshot, 'session-live-worker', t, 1000, helpers, 'T-301')
  assert.equal(liveWorker.status, 'running', 'a live tree member keeps its live status')
  assert.equal(liveWorker.stageSource, 'tree', 'a live tree member says it came from the tree')

  // The mounted tab: same snapshot, the card the tab was opened from.
  const historyStore = { subscribe() { return () => {} }, getSnapshot() { return historySnapshot } }
  const historyView = createView()
  const historyHost = createHost()
  const historyDispose = historyView.mount(historyHost.host, { store: historyStore, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
  const historyBody = historyView.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-300', 'session-rev300') })
  assert.equal(historyBody.props['data-agent-active-only'], 'true', 'the tab says the tree behind it is active-only')
  assert.equal(historyBody.props['data-agent-status'], 'history', 'the tab body reports the history status')
  const historyRows = stageRowNodes(historyBody)
  assert.equal(historyRows.length, 3, 'a historical card still renders its three stage rows')
  assert.deepEqual(
    historyRows.map((row) => row.props['data-agent-stage-session']),
    ['session-w300', 'session-rev300', 'session-test300'],
    'the historical reviewer/tester still resolve from the detail delivery',
  )
  assert.deepEqual(
    historyRows.map((row) => row.props['data-agent-stage-source']),
    ['record', 'record', 'record'],
    'each of the card rows says its identity came from the record, not the tree',
  )
  assert.ok(JSON.stringify(historyRows[1]).includes('reviewer-t-300'), 'the review row names the historical reviewer')
  assert.ok(JSON.stringify(historyRows[2]).includes('tester-t-300'), 'the test row names the historical tester')
  const historyPill = findNode(historyRows[1], (node) => node.props !== undefined && node.props['data-agent-stage-status'] !== undefined)
  assert.equal(historyPill.props['data-agent-stage-status'], 'history', 'the review row reports history')
  assert.ok(JSON.stringify(historyPill).includes(copy.agentStatusHistory), 'the review row says history in words')
  assert.equal(historyPill.props.title, copy.agentHistoryHint, 'the history pill explains where the identity came from')
  assert.equal(stageButtonOf(historyBody, 'review').props.disabled, false, 'a historical stage is still openable from the card')
  const historyTitle = historyView.Title({ sessionId: 'session-rev300', useTabInfo: tabInfoWithAgent('T-300', 'session-rev300') })
  assert.ok(JSON.stringify(historyTitle).includes('reviewer-t-300'), 'the tab title names the historical reviewer from the record')

  // The live card in the SAME active-only tree: its stage agent is a member, so
  // the row names the tree as its source and keeps the live status.
  const liveBody = historyView.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-301', 'session-live-worker') })
  const liveRows = stageRowNodes(liveBody)
  assert.equal(liveRows[0].props['data-agent-stage-source'], 'tree', 'a live stage agent is a tree member')
  assert.equal(liveRows[0].props['data-agent-stage-has-session'], 'true')
  assert.ok(JSON.stringify(liveRows[0]).includes('worker-t-live'), 'the live row names the tree member')
  const livePill = findNode(liveRows[0], (node) => node.props !== undefined && node.props['data-agent-stage-status'] !== undefined)
  assert.equal(livePill.props['data-agent-stage-status'], 'running', 'the live row keeps the running status from the tree')
  historyDispose()

  // The strongest form of 'history resolves from the DETAIL': the board summary
  // carries NO deliveredTo and the active-only tree carries no member, so the
  // reviewer/tester can only come from the card's own /task detail.
  const boardHistoryCard = Object.assign({}, historicalTask, {
    review: Object.assign({}, historicalTask.review, { deliveredTo: null }),
    test: Object.assign({}, historicalTask.test, { deliveredTo: null }),
  })
  const detailOnlyStore = {
    subscribe() { return () => {} },
    getSnapshot() {
      return { tasks: [boardHistoryCard], agentTree: activeOnlyTree, activityEvents: null }
    },
    getTaskDetail(id) {
      return String(id) === 'T-300' ? { id: 'T-300', task: historicalTask, status: 'ready', error: null } : null
    },
    isTaskGone() { return false },
    agentsView() {
      return { agentTree: activeOnlyTree, status: 'ready', error: null, receivedAt: 1 }
    },
  }
  const detailView = createView()
  const detailHost = createHost()
  const detailDispose = detailView.mount(detailHost.host, { store: detailOnlyStore, locale: locale, ns: 'godotBridgeAgentTab', taskNs: 'godotBridgeTaskCenter' })
  const detailBody = detailView.Body({ sessionId: HOST_SESSION, useTabInfo: tabInfoWithAgent('T-300', 'session-rev300') })
  const detailRows = stageRowNodes(detailBody)
  assert.deepEqual(
    detailRows.map((row) => row.props['data-agent-stage-session']),
    ['session-w300', 'session-rev300', 'session-test300'],
    'a history card resolves its stage sessions from the DETAIL alone',
  )
  assert.ok(JSON.stringify(detailRows[1]).includes('reviewer-t-300'), 'the detail names the historical reviewer')
  assert.ok(JSON.stringify(detailRows[2]).includes('tester-t-300'), 'the detail names the historical tester')
  assert.equal(detailRows[1].props['data-agent-stage-source'], 'record', 'the detail-resolved row says record')
  const detailPill = findNode(detailRows[1], (node) => node.props !== undefined && node.props['data-agent-stage-status'] !== undefined)
  assert.equal(detailPill.props['data-agent-stage-status'], 'history', 'the detail-resolved historical row is history')
  detailDispose()
  // A host whose tree never advertised the flag (an older answer) reads false:
  // the marker reports the CONTRACT, it is never assumed.
  assert.equal(workerBody.props['data-agent-active-only'], 'false', 'a tree without the flag is not claimed as active-only')
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
assert.ok(BUNDLE.includes('useTabSync'), 'the shipped bundle refreshes the tab domains itself')
assert.ok(BUNDLE.includes('visibilitychange'), 'the shipped bundle follows the document visibility')
assert.ok(BUNDLE.includes('useStableSnapshot'), 'the shipped bundle keeps the last good snapshot through a failed poll')
assert.ok(BUNDLE.includes('failedSnapshotOf'), 'the shipped bundle recognises the store failure shape')
assert.ok(BUNDLE.includes('cache.receivedAt = snapshot.receivedAt'), 'the shipped bundle tracks the snapshot generation for the fallback')
assert.ok(BUNDLE.includes('ensureTaskDetail'), 'the shipped bundle carries the per-card detail request')
assert.ok(BUNDLE.includes('getTaskDetail'), 'the shipped bundle carries the per-card detail reader')
assert.ok(BUNDLE.includes('ensureAgents'), 'the shipped bundle carries the agents-domain request')
assert.ok(BUNDLE.includes('agentsView'), 'the shipped bundle carries the agents view')
assert.ok(BUNDLE.includes('isTaskGone'), 'the shipped bundle carries the confirmed-gone card guard')
// T-241: the active-only contract and the record/history markers ship too.
assert.ok(BUNDLE.includes('data-agent-active-only'), 'the shipped bundle marks an active-only tree')
assert.ok(BUNDLE.includes('agentStatusHistory'), 'the shipped bundle carries the history agent status')
assert.ok(BUNDLE.includes('data-agent-stage-source'), 'the shipped bundle says where a stage identity came from')

// T-227/T-234: the tab owns only its own refresh timer; the panel's poll is not
// its to start or stop, and the sidebar module never calls either method.
const AGENT_SIDEBAR_SOURCE = readFileSync(new URL('../../client/src/views/agent-sidebar.cjs', import.meta.url), 'utf8')
assert.equal(AGENT_SIDEBAR_SOURCE.includes('.stopPolling('), false, 'the agent tab never CALLS stopPolling')
assert.equal(AGENT_SIDEBAR_SOURCE.includes('.startPolling('), false, 'the agent tab never CALLS startPolling')
// T-234: the tab polls the domain store for ITS card and the agents block, and
// never pulls the whole board through the store load.
assert.equal(AGENT_SIDEBAR_SOURCE.includes('store.load'), false, 'the agent tab never loads the board')
assert.ok(AGENT_SIDEBAR_SOURCE.includes('ensureTaskDetail'), 'the agent tab asks the detail domain for its card')
assert.ok(AGENT_SIDEBAR_SOURCE.includes('ensureAgents'), 'the agent tab asks the agents domain for the tree')
assert.ok(AGENT_SIDEBAR_SOURCE.includes('getTaskDetail'), 'the agent tab renders its card from the detail domain')
assert.ok(AGENT_SIDEBAR_SOURCE.includes('agentsView'), 'the agent tab renders the agents domain')
// T-241: a tree that only carries ACTIVE agents is still a complete answer: the
// tab marks the tree's scope and resolves a historical stage from the record.
assert.ok(AGENT_SIDEBAR_SOURCE.includes('data-agent-active-only'), 'the agent tab exposes the active-only tree scope')
assert.ok(AGENT_SIDEBAR_SOURCE.includes('data-agent-stage-source'), 'the agent tab says whether a stage identity is live or recorded')
assert.ok(AGENT_SIDEBAR_SOURCE.includes("status === 'history' ? 'agentStatusHistory'"), 'the agent tab labels a recorded, no-longer-live stage as history')

console.log('PASS  agent sidebar registers a multiple tab type, opens one independent tab per card in the host session, verifies the strip delta, lists the develop/review/test stage sessions (exact-card only, reused sessions allowed, missing stages disabled, no-workspace disabled with a note), and reads ONLY its card detail plus the agents domain (a real store serves the open with /task + /meta and no /state, the 5 s tick re-reads the card inside the meta TTL, a deliveredTo reaches the review/test rows, a failed detail keeps the last good card, an action invalidates the detail so the summary renders until the next read, a recorded /meta failure is not retried by the tab, a delete answer or a /task unknown-task forgets the card and stops polling it, a project switch clears it, hidden pauses, unmount clears, and the panel poll is never started or stopped), switches to the host conversation (and says the subagent switch takes the sidebar with it), keeps the last good board through a failed poll in the legacy snapshot path, and degrades safely; T-241: an ACTIVE-ONLY tree still resolves and labels a historical stage agent from the card record')
