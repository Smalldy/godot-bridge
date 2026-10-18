// Browser-half tests: registration, the Host-backed store contract, and the
// fact that the panel renders what the Host returned instead of inventing data.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../client/client.js', import.meta.url))
let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

const PROJECT = 'J:\\demo\\mm13d'
const STORAGE = new Map()
STORAGE.set('godotBridge.taskCenter.project', PROJECT)
const styleTags = []
let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
  localStorage: {
    getItem(key) { return STORAGE.has(key) ? STORAGE.get(key) : null },
    setItem(key, value) { STORAGE.set(key, value) },
  },
}
globalThis.document = {
  head: { appendChild(node) { styleTags.push(node) } },
  createElement() {
    return {
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value },
      remove() { this.removed = true },
    }
  },
}
globalThis.setInterval = function () { return 0 }
globalThis.clearInterval = function () {}

new Function(readFileSync(SRC, 'utf8'))()
check('bundle registers a module factory', registration !== null)
check('module id is the package name', registration.id === 'godot-bridge', registration.id)

// minimal React
let depth = 0
let hookIndex = 0
const captured = {}
const effects = []
function withHooks(fn, props) {
  depth++
  const saved = hookIndex
  hookIndex = 0
  const out = fn(props)
  hookIndex = saved
  depth--
  return out
}
const React = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props)
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
    if (typeof type === 'function') return withHooks(type, merged)
    return { type, props: merged }
  },
  useState(initial) { hookIndex++; return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useReducer(_reducer, initial) { hookIndex++; return [initial, () => {}] },
  useEffect(fn) { hookIndex++; if (typeof fn === 'function') { const cleanup = fn(); if (typeof cleanup === 'function') effects.push(cleanup) } },
  useMemo(factory) { return factory() },
  useCallback(fn) { return fn },
  useRef(value) { hookIndex++; return { current: value } },
  useSyncExternalStore(subscribe, getSnapshot) { hookIndex++; captured.getSnapshot = getSnapshot; return getSnapshot() },
  Fragment: Symbol('Fragment'),
}

// Host stubs
const dicts = {}
let locale = 'zh'
const registrations = []
const injected = []
const disposers = []
let slotWithdrawals = 0
const ctx = {
  locale: {
    register(ns, table) { dicts[ns] = table; return () => {} },
    bind(ns) {
      const table = dicts[ns]
      return (key) => (table && table[locale] && table[locale][key] !== undefined ? table[locale][key] : key)
    },
    subscribe() { return () => {} },
    getSnapshot() { return { id: locale } },
  },
  slots: {
    inject(slot, callback) { injected.push(slot); const disposer = callback(); return typeof disposer === 'function' ? disposer : () => {} },
    register(meta, component) {
      registrations.push({ meta, component })
      return () => { slotWithdrawals++ }
    },
  },
  effect(callback, label) {
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push({ label, disposer })
    return typeof disposer === 'function' ? disposer : () => {}
  },
  inject() { return () => {} },
}

const plugin = registration.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error('unexpected require: ' + specifier)
})
check('factory requires react only', true)
check('factory exports apply', typeof plugin.apply === 'function')
check('the old test fixture seam is gone', plugin.__fixture === undefined)
plugin.apply(ctx)

check('registers one sidebar entry', registrations.filter((entry) => entry.meta.name === 'sidebar.panellist').length === 1)
check('registers one main panel', registrations.filter((entry) => entry.meta.name === 'main').length === 1)
check('panel key is task-center', registrations.filter((entry) => entry.meta.name === 'main')[0].meta.key === 'task-center')
const glyph = registrations.filter((entry) => entry.meta.name === 'sidebar.panellist')[0]
check('label follows the locale', glyph.meta.label() === '任务', glyph.meta.label())
locale = 'en'
check('label follows an English switch', glyph.meta.label() === 'Tasks', glyph.meta.label())
locale = 'zh'
check('both slots are injected', injected.indexOf('sidebar.panellist') >= 0 && injected.indexOf('main') >= 0, injected.join(','))
check('two style tags are installed', styleTags.length === 2, String(styleTags.length))
check('task center CSS is tagged', styleTags.some((tag) => (tag.attributes || {})['data-plugin-css'] === 'godot-bridge/task-center.css'))
const table = dicts.godotBridgeTaskCenter
check('locale dictionary registered', table !== undefined)
check('zh/en key sets match', Object.keys(table.zh).sort().join('|') === Object.keys(table.en).sort().join('|'))
check(
  'merge, review and test copy covers every state',
  [
    'mergeOpen',
    'mergeMerged',
    'mergeConflict',
    'mergeFailed',
    'mergeRejected',
    'reviewPending',
    'reviewApproved',
    'reviewChanges',
    'testPending',
    'testPassed',
    'testFailed',
  ].every((key) => table.zh[key] !== undefined && table.en[key] !== undefined),
  Object.keys(table.zh).filter((key) => key.indexOf('merge') === 0 || key.indexOf('review') === 0 || key.indexOf('test') === 0).join(','),
)

// Host payload
const now = Date.now()
const LONG_TEST_EVIDENCE = 'P'.repeat(2600) + '\nFAIL  scripts/test/deep-tail.test.mjs\nError: deep stderr tail marker\n'
const REVIEW_AT = new Date(now - 7000).toISOString()
const TEST_AT = new Date(now - 5000).toISOString()
const TASKS = [
  {
    id: 'T-1',
    title: 'Build damage system',
    status: 'running',
    priority: 5,
    dependsOn: [],
    dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
    writeFiles: ['scripts/damage.gd'],
    assignee: { name: 'fixer', session: 'session-idle' },
    requiredRole: 'implementer',
    attempts: 2,
    maxAttempts: 3,
    leaseUntil: new Date(now + 600000).toISOString(),
    waitingReason: null,
    dispatch: { status: 'changes-requested', target: 'fixer', error: null },
    base: 'base-sha',
    target: 'feat/task-center-v2',
    branch: 'task/T-1-1',
    worktree: PROJECT + '\\.worktrees\\T-1',
    commit: '1234567890abcdef',
    review: { status: 'changes-requested', by: '@reviewer', at: REVIEW_AT, reasons: 'please cover the edge case', attempt: 1 },
    test: { status: 'failed', by: '@tester', at: TEST_AT, evidence: LONG_TEST_EVIDENCE, attempt: 1 },
    createdAt: new Date(now - 60000).toISOString(),
    updatedAt: new Date(now - 1000).toISOString(),
    spec: '',
    acceptance: '',
    evidence: '',
    history: [],
  },
  {
    id: 'T-2',
    title: 'Enemy AI',
    status: 'pending',
    priority: 0,
    dependsOn: ['T-1'],
    dependency: { state: 'waiting', waitingOn: ['T-1'], brokenOn: [] },
    writeFiles: [],
    assignee: null,
    attempts: 0,
    maxAttempts: 3,
    leaseUntil: null,
    waitingReason: 'dependency',
    dispatch: null,
    createdAt: new Date(now - 30000).toISOString(),
    updatedAt: new Date(now - 30000).toISOString(),
    spec: '',
    acceptance: '',
    evidence: '',
    history: [],
  },
  {
    id: 'T-3',
    title: 'Tail output feature',
    status: 'done',
    priority: 0,
    dependsOn: [],
    dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
    writeFiles: ['scripts/a.gd'],
    assignee: { name: 'fixer', session: 'session-fixer' },
    attempts: 1,
    maxAttempts: 3,
    leaseUntil: null,
    waitingReason: null,
    dispatch: { status: 'submitted', target: 'fixer', error: null },
    base: 'base-sha',
    target: 'feat/task-center-v2',
    branch: 'task/T-3-1',
    worktree: PROJECT + '\\.worktrees\\T-3',
    commit: 'abcdef1234567890',
    actualFiles: ['scripts/a.gd'],
    requiredRole: null,
    merge: {
      status: 'merged',
      base: 'base-sha',
      target: 'feat/task-center-v2',
      head: 'abcdef1234567890',
      mergeCommit: 'fedcba0987654321',
      declaredFiles: ['scripts/a.gd'],
      actualFiles: ['scripts/a.gd'],
      tests: 'npm run verify',
      reviewer: '@user',
      conflict: null,
      output: '$ npm run verify  (exit 0)\nPASS board.test.mjs',
      at: new Date(now - 1000).toISOString(),
    },
    review: { status: 'approved', by: '@reviewer', at: REVIEW_AT, reasons: null, attempt: 1 },
    test: { status: 'passed', by: '@tester', at: TEST_AT, evidence: 'npm run verify: PASS', attempt: 1 },
    createdAt: new Date(now - 120000).toISOString(),
    updatedAt: new Date(now - 1000).toISOString(),
    spec: '',
    acceptance: '',
    evidence: 'npm run verify',
    history: [],
  },
  {
    id: 'T-4',
    title: 'Review the crate API',
    status: 'reviewing',
    priority: 0,
    dependsOn: [],
    dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
    writeFiles: ['scripts/crate.gd'],
    assignee: { name: 'fixer', session: 'session-fixer' },
    requiredRole: 'reviewer',
    attempts: 1,
    maxAttempts: 3,
    leaseUntil: null,
    waitingReason: null,
    dispatch: { status: 'submitted', target: 'fixer', error: null },
    base: 'base-sha',
    target: 'feat/task-center-v2',
    branch: 'task/T-4-1',
    worktree: PROJECT + '\\.worktrees\\T-4',
    commit: '1111222233334444',
    actualFiles: ['scripts/crate.gd'],
    merge: { status: 'open', base: 'base-sha', target: 'feat/task-center-v2', head: '1111222233334444', mergeCommit: null, declaredFiles: ['scripts/crate.gd'], actualFiles: ['scripts/crate.gd'], tests: null, reviewer: null, conflict: null, output: null, at: REVIEW_AT },
    review: { status: 'pending', by: 'fixer', at: REVIEW_AT, reasons: null, attempt: 1 },
    test: null,
    createdAt: new Date(now - 50000).toISOString(),
    updatedAt: new Date(now - 2000).toISOString(),
    spec: '',
    acceptance: '',
    evidence: 'ready for review',
    history: [],
  },
  {
    id: 'T-5',
    title: 'Test the crate API',
    status: 'testing',
    priority: 0,
    dependsOn: [],
    dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
    writeFiles: ['scripts/crate.gd'],
    assignee: { name: 'fixer', session: 'session-fixer' },
    requiredRole: 'tester',
    attempts: 1,
    maxAttempts: 3,
    leaseUntil: null,
    waitingReason: null,
    dispatch: { status: 'submitted', target: 'fixer', error: null },
    base: 'base-sha',
    target: 'feat/task-center-v2',
    branch: 'task/T-5-1',
    worktree: PROJECT + '\\.worktrees\\T-5',
    commit: 'aaaabbbbccccdddd',
    actualFiles: ['scripts/crate.gd'],
    merge: { status: 'open', base: 'base-sha', target: 'feat/task-center-v2', head: 'aaaabbbbccccdddd', mergeCommit: null, declaredFiles: ['scripts/crate.gd'], actualFiles: ['scripts/crate.gd'], tests: 'npm run verify', reviewer: null, conflict: null, output: null, at: TEST_AT },
    review: { status: 'approved', by: '@reviewer', at: REVIEW_AT, reasons: null, attempt: 1 },
    test: { status: 'pending', by: null, at: TEST_AT, evidence: null, attempt: 1 },
    createdAt: new Date(now - 40000).toISOString(),
    updatedAt: new Date(now - 3000).toISOString(),
    spec: '',
    acceptance: '',
    evidence: 'review approved',
    history: [],
  },
  {
    id: 'T-6',
    title: 'Dropped idea',
    status: 'cancelled',
    priority: 0,
    dependsOn: [],
    dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
    writeFiles: [],
    assignee: null,
    requiredRole: null,
    attempts: 0,
    maxAttempts: 3,
    leaseUntil: null,
    waitingReason: null,
    dispatch: null,
    base: null,
    target: null,
    branch: null,
    worktree: null,
    commit: null,
    review: null,
    test: null,
    createdAt: new Date(now - 20000).toISOString(),
    updatedAt: new Date(now - 4000).toISOString(),
    spec: '',
    acceptance: '',
    evidence: '',
    history: [],
  },
  {
    id: 'T-7',
    title: 'Stuck task',
    status: 'blocked',
    priority: 0,
    dependsOn: [],
    dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
    writeFiles: [],
    assignee: null,
    requiredRole: null,
    attempts: 3,
    maxAttempts: 3,
    leaseUntil: null,
    waitingReason: null,
    dispatch: { status: 'exhausted', target: null, error: 'lease expired' },
    base: null,
    target: null,
    branch: null,
    worktree: null,
    commit: null,
    review: null,
    test: null,
    createdAt: new Date(now - 20000).toISOString(),
    updatedAt: new Date(now - 6000).toISOString(),
    spec: '',
    acceptance: '',
    evidence: '',
    history: [],
  },
  {
    id: 'T-8',
    title: 'Ready task',
    status: 'pending',
    priority: 1,
    dependsOn: [],
    dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
    writeFiles: [],
    assignee: null,
    requiredRole: null,
    attempts: 0,
    maxAttempts: 3,
    leaseUntil: null,
    waitingReason: null,
    dispatch: null,
    base: null,
    target: null,
    branch: null,
    worktree: null,
    commit: null,
    review: null,
    test: null,
    createdAt: new Date(now - 15000).toISOString(),
    updatedAt: new Date(now - 15000).toISOString(),
    spec: '',
    acceptance: '',
    evidence: '',
    history: [],
  },
]
const HOST = {
  ok: true,
  project: PROJECT,
  version: 2,
  seq: 8,
  updatedAt: new Date(now).toISOString(),
  dispatch: { state: 'paused', maxConcurrent: 3, allowSpawn: true, maxWorkAgents: 4, maxAttempts: 3, request: { id: 'R-1', by: '@lead', at: new Date(now - 30000).toISOString(), note: 'deps are ready' } },
  counts: { total: 8, pending: 2, ready: 1, running: 1, reviewing: 1, testing: 1, done: 1, blocked: 1, cancelled: 1 },
  queue: [],
  tasks: TASKS,
  workers: {
    lead: 'lead',
    members: [
      { id: 'session-fixer', name: 'fixer', status: 'running', currentTask: { id: 'T-1', title: 'Build damage system' } },
      { id: 'session-tester', name: 'tester', status: 'inactive', currentTask: null },
      { id: 'session-builder', name: 'builder', status: 'provisioning', currentTask: null },
      { id: 'session-ghost', name: 'ghost', status: 'failed', currentTask: null },
    ],
    busy: 1,
    idle: 1,
    provisioning: 1,
    failed: 1,
    cap: 4,
    error: null,
  },
  locks: [
    {
      path: 'scripts/damage.gd',
      taskId: 'T-1',
      taskTitle: 'Build damage system',
      agent: 'fixer',
      since: new Date(now - 5000).toISOString(),
      leaseUntil: new Date(now + 540000).toISOString(),
      waiters: [{ id: 'T-2', title: 'Enemy AI' }],
    },
    {
      path: 'scenes/main.tscn',
      taskId: null,
      taskTitle: null,
      agent: 'lead',
      since: new Date(now - 1000).toISOString(),
      leaseUntil: new Date(now + 600000).toISOString(),
      waiters: [],
    },
  ],
  scheduler: { lastTickAt: now, lastError: null },
  serverTime: new Date(now).toISOString(),
}
let loads = 0
let postGate = null
const posts = []
globalThis.fetch = async function (url, options) {
  if (options !== undefined && options.method === 'POST') {
    posts.push(JSON.parse(options.body))
    if (postGate !== null) await postGate
    return { json: async () => ({ ok: true, snapshot: HOST }) }
  }
  loads += 1
  return { json: async () => HOST }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// element helpers
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  if (node.type !== undefined) visit(node)
  if (node.props) walk(node.props.children, visit)
}
function findAll(root, predicate) {
  const out = []
  walk(root, (node) => { if (predicate(node)) out.push(node) })
  return out
}
function textOf(node) {
  let text = ''
  walk(node, (child) => {
    const children = child.props && child.props.children
    if (typeof children === 'string') text += children
  })
  return text
}
function findButton(root, label) {
  return findAll(root, (node) => node.type === 'button' && typeof node.props.children !== 'object' && String(textOf(node)).indexOf(label) >= 0)[0]
}

const panel = registrations.filter((entry) => entry.meta.name === 'main')[0].component
let tree = withHooks(panel, {})
await flush()
tree = withHooks(panel, {})
check('the panel asked the Host for its board', loads >= 1, String(loads))
check('the panel renders', tree !== null && tree !== undefined)
check('the header names the panel', textOf(tree).indexOf('任务中心') >= 0, textOf(tree).slice(0, 120))
check('the project path is shown', textOf(tree).indexOf(PROJECT) >= 0)
check('the Host task title is rendered', textOf(tree).indexOf('Build damage system') >= 0)
check('the waiting task is rendered', textOf(tree).indexOf('Enemy AI') >= 0)
const COLUMN_KEYS = ['ready', 'waiting', 'running', 'reviewing', 'testing', 'done', 'blocked']
const boardColumns = findAll(tree, (node) => node.props && node.props.className === 'gbt-col')
check('the board has seven columns', boardColumns.length === 7, String(boardColumns.length))
check(
  'the columns are ready / waiting / implementing / reviewing / testing / done / blocked',
  boardColumns.map((column) => column.props['data-group']).join(',') === COLUMN_KEYS.join(','),
  boardColumns.map((column) => column.props['data-group']).join(','),
)
function columnCards(key) {
  const column = findAll(tree, (node) => node.props && node.props.className === 'gbt-col' && node.props['data-group'] === key)[0]
  return column === undefined ? [] : findAll(column, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card')
}
function columnText(key) {
  return columnCards(key).map(textOf).join(' | ')
}
check('all eight cards are rendered', findAll(tree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card').length === 8)
check('a ready task sits in the ready column', columnText('ready').indexOf('Ready task') >= 0, columnText('ready'))
check('a waiting task sits in the waiting column', columnText('waiting').indexOf('Enemy AI') >= 0, columnText('waiting'))
check('an implementing task sits in the implementing column', columnText('running').indexOf('Build damage system') >= 0, columnText('running'))
check('a reviewing task sits in the reviewing column', columnText('reviewing').indexOf('Review the crate API') >= 0, columnText('reviewing'))
check('a testing task sits in the testing column', columnText('testing').indexOf('Test the crate API') >= 0, columnText('testing'))
check('a done task sits in the done column', columnText('done').indexOf('Tail output feature') >= 0, columnText('done'))
check(
  'blocked and cancelled tasks share the blocked column',
  columnText('blocked').indexOf('Stuck task') >= 0 && columnText('blocked').indexOf('Dropped idea') >= 0,
  columnText('blocked'),
)
check('the dependency chip is rendered', textOf(tree).indexOf('T-1') >= 0)
check('a pending task renders the reason it is waiting', textOf(tree).indexOf('等待依赖') >= 0, textOf(tree))
check('a running task renders no waiting reason', textOf(tree).indexOf('派发已暂停') < 0 && textOf(tree).indexOf('并发已满') < 0, textOf(tree))

// Card level: phase, review/test status, rounds, reviewer/tester and role.
{
  const cards = findAll(tree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card')
  const runningCard = cards.filter((card) => textOf(card).indexOf('Build damage system') >= 0)[0]
  const runningText = textOf(runningCard)
  check('the card shows its current phase', runningText.indexOf('实现中') >= 0, runningText)
  check('the card shows the review status', runningText.indexOf('已打回') >= 0, runningText)
  check('the card shows the review round and the reviewer', runningText.indexOf('#1') >= 0 && runningText.indexOf('@reviewer') >= 0, runningText)
  check('the card shows the test verdict and the tester', runningText.indexOf('测试未通过') >= 0 && runningText.indexOf('@tester') >= 0, runningText)
  check('the card shows the attempt budget and the required role', runningText.indexOf('↻ 2/3') >= 0 && runningText.indexOf('implementer') >= 0, runningText)
  const reviewingCard = cards.filter((card) => textOf(card).indexOf('Review the crate API') >= 0)[0]
  check(
    'a reviewing card shows the pending review round',
    textOf(reviewingCard).indexOf('待评审') >= 0 && textOf(reviewingCard).indexOf('评审中') >= 0,
    textOf(reviewingCard),
  )
  const testingCard = cards.filter((card) => textOf(card).indexOf('Test the crate API') >= 0)[0]
  check(
    'a testing card shows the pending test and its required role',
    textOf(testingCard).indexOf('待测试') >= 0 && textOf(testingCard).indexOf('tester') >= 0,
    textOf(testingCard),
  )
  const doneCard = cards.filter((card) => textOf(card).indexOf('Tail output feature') >= 0)[0]
  check(
    'a done card shows the approved review and the passed test',
    textOf(doneCard).indexOf('评审通过') >= 0 && textOf(doneCard).indexOf('测试通过') >= 0,
    textOf(doneCard),
  )
}

// A phase transition moves the card between columns: the panel follows the
// Host's status instead of caching one grouping.
{
  const moving = TASKS.filter((entry) => entry.id === 'T-4')[0]
  const before = { status: moving.status, review: moving.review, test: moving.test }
  moving.status = 'testing'
  moving.review = { status: 'approved', by: '@reviewer', at: REVIEW_AT, reasons: null, attempt: 1 }
  moving.test = { status: 'pending', by: null, at: TEST_AT, evidence: null, attempt: 2 }
  findButton(tree, '刷新').props.onClick()
  await flush()
  tree = withHooks(panel, {})
  check(
    'a review approval moves the card from reviewing to testing',
    columnText('testing').indexOf('Review the crate API') >= 0 && columnText('reviewing').indexOf('Review the crate API') < 0,
    columnText('testing') + ' || ' + columnText('reviewing'),
  )
  check('the moved card shows its new test round', columnText('testing').indexOf('待测试') >= 0 && columnText('testing').indexOf('#2') >= 0, columnText('testing'))
  Object.assign(moving, before)
  findButton(tree, '刷新').props.onClick()
  await flush()
  tree = withHooks(panel, {})
}

// The done column is newest-first; a reader looks for the latest completion.
{
  const savedTasks = TASKS.slice()
  const savedCounts = HOST.counts
  const now2 = Date.now()
  const doneTask = function (id, title, ageMs) {
    return Object.assign({}, TASKS[2], {
      id: id,
      title: title,
      status: 'done',
      merge: null,
      waitingReason: null,
      createdAt: new Date(now2 - 120000).toISOString(),
      updatedAt: new Date(now2 - ageMs).toISOString(),
    })
  }
  TASKS.push(doneTask('T-9', 'Newest done', 100), doneTask('T-10', 'Older done', 5000))
  HOST.counts = Object.assign({}, savedCounts, { total: 10, done: 3 })
  findButton(tree, '刷新').props.onClick()
  await flush()
  tree = withHooks(panel, {})
  const doneCol = findAll(tree, (node) => node.props && node.props.className === 'gbt-col' && node.props['data-group'] === 'done')[0]
  const doneCards = findAll(doneCol, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card')
  const doneText = doneCards.map(textOf).join(' | ')
  check(
    'done cards are newest-first',
    doneCards.length === 3 && doneText.indexOf('Newest done') < doneText.indexOf('Tail output feature') && doneText.indexOf('Tail output feature') < doneText.indexOf('Older done'),
    doneText,
  )
  TASKS.length = 0
  savedTasks.forEach((task) => TASKS.push(task))
  HOST.counts = savedCounts
  findButton(tree, '刷新').props.onClick()
  await flush()
  tree = withHooks(panel, {})
}

const startButton = findButton(tree, '开始派发')
check('a start button is offered while paused', startButton !== undefined)
check('a pending start request is shown', textOf(tree).indexOf('请求开始派发') >= 0 && textOf(tree).indexOf('deps are ready') >= 0)
const approveButton = findButton(tree, '批准并开始')
check('the request offers an approve action', approveButton !== undefined)
startButton.props.onClick()
await flush()
check('start sends the start action', posts.length === 1 && posts[0].action === 'start', JSON.stringify(posts))
check('and carries the project', posts[0].project === PROJECT, JSON.stringify(posts[0]))
approveButton.props.onClick()
await flush()
check('approving sends approveStart', posts.length === 2 && posts[1].action === 'approveStart', JSON.stringify(posts))
check('and carries the request id', posts[1].requestId === 'R-1', JSON.stringify(posts[1]))
const loadsBeforeRefresh = loads
findButton(tree, '刷新').props.onClick()
await flush()
check('refresh asks the Host again', loads > loadsBeforeRefresh, String(loads))


// A slow action must show a working indicator instead of appearing frozen.
{
  let releasePost = null
  postGate = new Promise(function (resolve) { releasePost = resolve })
  const before = withHooks(panel, {})
  await flush()
  const startNow = findButton(before, '开始派发')
  check('the slow-action start button is available', startNow !== undefined)
  startNow.props.onClick()
  const pending = withHooks(panel, {})
  check('a slow action renders a working indicator', textOf(pending).indexOf('启动中') >= 0, textOf(pending).slice(0, 200))
  check('the action button reports busy', findAll(pending, (node) => node.type === 'button' && node.props && node.props['data-busy'] === 'true').length >= 1)
  releasePost()
  postGate = null
  await flush()
  await flush()
  const settled = withHooks(panel, {})
  check('the working indicator clears when the action answers', textOf(settled).indexOf('启动中') < 0, textOf(settled).slice(0, 200))
}
// Worker pool view. initialView is a render-test seam; the production slot passes no props.
const workersTree = withHooks(panel, { initialView: 'workers' })
await flush()
const workersText = textOf(workersTree)
check('the workers tab is offered', findButton(workersTree, '执行者') !== undefined)
check('the workers view names the Team lead', workersText.indexOf('lead') >= 0, workersText)
check('the workers view shows the cap', workersText.indexOf('上限') >= 0, workersText)
check(
  'the workers view shows busy/idle/starting/failed counters',
  ['执行中', '空闲', '启动中', '失败'].every((label) => workersText.indexOf(label) >= 0),
  workersText,
)
const workerRows = findAll(workersTree, (node) => node.type === 'tr' && node.props && node.props['data-worker'] !== undefined)
check('the workers view renders one row per member', workerRows.length === 4, String(workerRows.length))
const fixerRow = workerRows.filter((row) => row.props['data-worker'] === 'fixer')[0]
const testerRow = workerRows.filter((row) => row.props['data-worker'] === 'tester')[0]
const builderRow = workerRows.filter((row) => row.props['data-worker'] === 'builder')[0]
const ghostRow = workerRows.filter((row) => row.props['data-worker'] === 'ghost')[0]
check(
  'a busy member shows its current task as id + title',
  fixerRow !== undefined && textOf(fixerRow).indexOf('T-1 · Build damage system') >= 0,
  fixerRow && textOf(fixerRow),
)
check('an idle member renders as idle', testerRow !== undefined && textOf(testerRow).indexOf('空闲') >= 0, testerRow && textOf(testerRow))
check('a starting member is labelled', builderRow !== undefined && textOf(builderRow).indexOf('启动中') >= 0, builderRow && textOf(builderRow))
check('a failed member is labelled', ghostRow !== undefined && textOf(ghostRow).indexOf('失败') >= 0, ghostRow && textOf(ghostRow))

// Empty states must be explicit and must not invent a pool.
const savedWorkers = HOST.workers
HOST.workers = null
findButton(workersTree, '刷新').props.onClick()
await flush()
const noPoolTree = withHooks(panel, { initialView: 'workers' })
const noPoolText = textOf(noPoolTree)
check('a host without a worker pool says so', noPoolText.indexOf('宿主没有提供执行者池信息') >= 0, noPoolText)
check(
  'the missing-pool state invents no member rows',
  findAll(noPoolTree, (node) => node.type === 'tr' && node.props && node.props['data-worker'] !== undefined).length === 0,
)

HOST.workers = { lead: null, members: [], busy: 0, idle: 0, provisioning: 0, failed: 0, cap: 4, error: 'no-lead' }
findButton(noPoolTree, '刷新').props.onClick()
await flush()
const noTeamTree = withHooks(panel, { initialView: 'workers' })
const noTeamText = textOf(noTeamTree)
check('a pool without a lead explains the empty state', noTeamText.indexOf('没有可用的 Team Lead') >= 0, noTeamText)
check('a known pool error code is explained, not dumped', noTeamText.indexOf('执行者池不可读: 没有活着的 Team Lead (no-lead)') >= 0, noTeamText)
check('an empty team says it has no WorkAgent', noTeamText.indexOf('Team 里还没有 WorkAgent') >= 0, noTeamText)

HOST.workers = { lead: null, members: [], busy: 0, idle: 0, provisioning: 0, failed: 0, cap: 0, error: 'agent-team services unavailable' }
findButton(noTeamTree, '刷新').props.onClick()
await flush()
const poolErrorTree = withHooks(panel, { initialView: 'workers' })
check(
  'a pool error is shown verbatim',
  textOf(poolErrorTree).indexOf('执行者池不可读: agent-team services unavailable') >= 0,
  textOf(poolErrorTree),
)
HOST.workers = savedWorkers
findButton(poolErrorTree, '刷新').props.onClick()
await flush()

// File-lock view: waiters are advisory, not a queue.
const locksTree = withHooks(panel, { initialView: 'locks' })
await flush()
const locksText = textOf(locksTree)
check('the locks view has a waiters column', locksText.indexOf('等待者') >= 0, locksText)
check('the locks view renders a waiter as T-x · title', locksText.indexOf('T-2 · Enemy AI') >= 0, locksText)
check('the locks view says waiters are not a FIFO queue', locksText.indexOf('不是 FIFO 队列') >= 0, locksText)
const waiterCells = findAll(locksTree, (node) => node.type === 'td' && node.props && node.props['data-col'] === 'waiters')
check('the locks view renders one waiters cell per lock', waiterCells.length === 2, String(waiterCells.length))
check(
  'a waiter chip names the waiting task',
  waiterCells[0] !== undefined && textOf(waiterCells[0]).indexOf('T-2 · Enemy AI') >= 0,
  waiterCells[0] && textOf(waiterCells[0]),
)
check('a lock without waiters shows a dash', waiterCells[1] !== undefined && textOf(waiterCells[1]) === '—', waiterCells[1] && textOf(waiterCells[1]))
const postsBeforeRelease = posts.length
findButton(locksTree, '释放').props.onClick()
await flush()
check(
  'the release button still sends forceUnlock',
  posts.length === postsBeforeRelease + 1 && posts[posts.length - 1].action === 'forceUnlock',
  JSON.stringify(posts[posts.length - 1]),
)

// The main slot unmounts when the user switches to the chat panel. The view
// and the selected task must survive that remount instead of resetting to board.
{
  const boardTree = withHooks(panel, { initialView: 'board' })
  await flush()
  const queueTab = findButton(boardTree, '队列')
  check('the queue tab is available for the remount test', queueTab !== undefined)
  queueTab.props.onClick()
  const afterSwitch = withHooks(panel, {})
  await flush()
  check(
    'the selected view survives a remount',
    textOf(afterSwitch).indexOf('派发从这个顺序取任务') >= 0,
    textOf(afterSwitch).slice(0, 200),
  )

  const boardAgain = withHooks(panel, { initialView: 'board' })
  await flush()
  const card = findAll(boardAgain, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card')[0]
  check('a task card is available for the selection test', card !== undefined)
  card.props.onClick()
  const afterSelection = withHooks(panel, { initialView: 'board' })
  await flush()
  check(
    'the selected task survives a remount',
    findAll(afterSelection, (node) => node.props && node.props.className === 'gbt-drawer').length === 1,
  )
}

// Settings: the phase machine owns review/test, so the old self/independent
// testing switch is gone and a save carries the concurrency only.
{
  const settingsTree = withHooks(panel, { initialView: 'board', initialSettingsOpen: true })
  await flush()
  const settingsText = textOf(settingsTree)
  check('the settings form no longer offers a testing choice', findAll(settingsTree, (node) => node.type === 'select').length === 0)
  check(
    'the retired self/independent testing copy is gone',
    ['独立测试', '自测', '系统验证', '仅用户可修改'].every((label) => settingsText.indexOf(label) < 0),
    settingsText,
  )
  check('the settings form keeps the concurrency field', settingsText.indexOf('最大并发') >= 0, settingsText)
  const input = findAll(settingsTree, (node) => node.type === 'input' && node.props && node.props.type === 'number')[0]
  check('the concurrency field is the settings control', input !== undefined)
  input.props.ref.current = { value: '5' }
  findButton(settingsTree, '应用').props.onClick()
  await flush()
  const settingsPost = posts[posts.length - 1]
  check(
    'applying settings sends only maxConcurrent',
    settingsPost.action === 'settings' && settingsPost.maxConcurrent === 5 && settingsPost.testing === undefined,
    JSON.stringify(settingsPost),
  )
  check('the settings save carries the project', settingsPost.project === PROJECT, JSON.stringify(settingsPost))
}

// Merge request + review/test phase state is visible on the card and in the drawer.
{
  const boardTree = withHooks(panel, { initialView: 'board' })
  await flush()
  const cards = findAll(boardTree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card')
  const mergeCard = cards.filter((card) => textOf(card).indexOf('Tail output feature') >= 0)[0]
  check('the merge-request task card is rendered', mergeCard !== undefined)
  const cardText = textOf(mergeCard)
  check('the card shows the merge status', cardText.indexOf('已合并') >= 0, cardText)
  check('the card shows the test verdict', cardText.indexOf('测试通过') >= 0, cardText)
  check('the card shows the branch and commit', cardText.indexOf('task/T-3-1') >= 0 && cardText.indexOf('abcdef1234') >= 0, cardText)
  check('the card names the task worktree', cardText.indexOf('T-3') >= 0, cardText)

  mergeCard.props.onClick()
  const detailTree = withHooks(panel, { initialView: 'board' })
  await flush()
  const drawer = findAll(detailTree, (node) => node.props && node.props.className === 'gbt-drawer')[0]
  check('clicking the card opens its detail drawer', drawer !== undefined)
  const detailText = textOf(drawer)
  check('the detail shows the merge request section', detailText.indexOf('合并请求') >= 0 && detailText.indexOf('合并状态') >= 0, detailText.slice(0, 300))
  check('the detail shows the merge status', detailText.indexOf('已合并') >= 0, detailText)
  check(
    'the detail shows worktree, branch and commit',
    detailText.indexOf('J:\\demo\\mm13d\\.worktrees\\T-3') >= 0 && detailText.indexOf('task/T-3-1') >= 0 && detailText.indexOf('abcdef1234567890') >= 0,
    detailText,
  )
  check('the detail shows the phase machine', detailText.indexOf('阶段') >= 0 && detailText.indexOf('当前阶段') >= 0, detailText)
  check(
    'the detail shows the approved review and its reviewer',
    detailText.indexOf('评审状态') >= 0 && detailText.indexOf('评审通过') >= 0 && detailText.indexOf('@reviewer') >= 0,
    detailText,
  )
  check(
    'the detail shows the passed test and its tester',
    detailText.indexOf('测试状态') >= 0 && detailText.indexOf('测试通过') >= 0 && detailText.indexOf('@tester') >= 0,
    detailText,
  )
  check(
    'the detail shows the merge verification output',
    detailText.indexOf('合并验证输出') >= 0 && detailText.indexOf('PASS board.test.mjs') >= 0,
    detailText,
  )
}

// A task back from review and testing shows both records, their rounds, and the
// candidate worktree's evidence tail.
{
  const boardTree = withHooks(panel, { initialView: 'board' })
  await flush()
  const cards = findAll(boardTree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card')
  const phaseCard = cards.filter((card) => textOf(card).indexOf('Build damage system') >= 0)[0]
  check('the phase-machine task card is rendered', phaseCard !== undefined)
  phaseCard.props.onClick()
  const detailTree = withHooks(panel, { initialView: 'board' })
  await flush()
  const drawer = findAll(detailTree, (node) => node.props && node.props.className === 'gbt-drawer')[0]
  const detailText = textOf(drawer)
  check(
    'the detail shows the current phase and the attempt budget',
    detailText.indexOf('当前阶段') >= 0 && detailText.indexOf('实现中') >= 0 && detailText.indexOf('2 / 3') >= 0,
    detailText,
  )
  check(
    'the detail shows the review status and its round',
    detailText.indexOf('评审状态') >= 0 && detailText.indexOf('已打回') >= 0 && detailText.indexOf('评审轮次') >= 0,
    detailText,
  )
  check('the detail names the reviewer', detailText.indexOf('评审者') >= 0 && detailText.indexOf('@reviewer') >= 0, detailText)
  check(
    'the detail keeps the review reasons',
    detailText.indexOf('打回原因') >= 0 && detailText.indexOf('please cover the edge case') >= 0,
    detailText,
  )
  check(
    'the detail shows the test verdict and its round',
    detailText.indexOf('测试状态') >= 0 && detailText.indexOf('测试未通过') >= 0 && detailText.indexOf('测试轮次') >= 0,
    detailText,
  )
  check('the detail names the tester', detailText.indexOf('测试者') >= 0 && detailText.indexOf('@tester') >= 0, detailText)
  check(
    'the detail shows the candidate worktree',
    detailText.indexOf('候选工作树') >= 0 && detailText.indexOf('J:\\demo\\mm13d\\.worktrees\\T-1') >= 0,
    detailText,
  )
  check(
    'the detail shows the test evidence tail',
    detailText.indexOf('FAIL  scripts/test/deep-tail.test.mjs') >= 0 && detailText.indexOf('Error: deep stderr tail marker') >= 0,
    detailText.slice(-600),
  )
  check('the evidence head is truncated', detailText.indexOf('P'.repeat(1300)) < 0)
  check('a tail hint marks the truncated evidence', detailText.indexOf('仅显示输出尾部') >= 0)
}

// A running task has a worktree/branch before any merge request exists.
{
  const boardTree = withHooks(panel, { initialView: 'board' })
  await flush()
  const cards = findAll(boardTree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card')
  const runningCard = cards.filter((card) => textOf(card).indexOf('Build damage system') >= 0)[0]
  check('the running task card is available', runningCard !== undefined)
  const cardText = textOf(runningCard)
  check('the running card shows its branch', cardText.indexOf('task/T-1-1') >= 0, cardText)
  runningCard.props.onClick()
  const detailTree = withHooks(panel, { initialView: 'board' })
  await flush()
  const drawer = findAll(detailTree, (node) => node.props && node.props.className === 'gbt-drawer')[0]
  const detailText = textOf(drawer)
  check('the checkout section appears without a merge request', detailText.indexOf('执行工作树') >= 0, detailText)
  check('and names the worktree and branch', detailText.indexOf('J:\\demo\\mm13d\\.worktrees\\T-1') >= 0 && detailText.indexOf('task/T-1-1') >= 0, detailText)
  check('a task with no merge request has no merge section', detailText.indexOf('合并请求') < 0, detailText)
}

// teardown
let teardownError = null
try {
  disposers.slice().reverse().forEach((entry) => entry.disposer())
} catch (error) {
  teardownError = error
}
check('teardown runs without throwing', teardownError === null, teardownError && teardownError.message)
check('teardown withdraws both slots', slotWithdrawals === 2, String(slotWithdrawals))
check('teardown removes the styles', styleTags.every((tag) => tag.removed === true))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)