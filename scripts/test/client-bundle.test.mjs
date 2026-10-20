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
    if (typeof type === 'function') {
    const out = withHooks(type, merged)
    if (merged.key !== undefined && out !== null && typeof out === 'object') out.__testKey = merged.key
    return out
  }
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
// The injected-text preview is a Host action: the panel must render exactly what
// the Host answers, so the fake Host builds the same shape an agent receives
// (text + labelled sections + variable values) instead of panel copy.
const PREVIEW_VARIABLES = ['TASK_ID', 'TASK_TITLE', 'SPEC', 'COMPLETIONS_DEF', 'GIT_INFO', 'PROJECT', 'LEAD', 'ROLE', 'STAGE']
const PREVIEW_CALLS = []
let previewSampleNext = false
const SAMPLE_TASK_TITLE = 'Enemy patrol chases the player'
function taskNamed(id) {
  return TASKS.filter(function (task) { return task.id === id })[0]
}
function rolePreviewReply(body) {
  const kind = typeof body.kind === 'string' && body.kind !== '' ? body.kind : 'worker'
  const requested =
    typeof body.taskId === 'string' && body.taskId !== ''
      ? taskNamed(body.taskId)
      : TASKS.filter(function (task) { return ['running', 'reviewing', 'testing'].indexOf(task.status) >= 0 })[0] || TASKS[0]
  const sample = previewSampleNext
  previewSampleNext = false
  const task = sample ? { id: 'T-42', title: SAMPLE_TASK_TITLE } : { id: requested.id, title: requested.title }
  PREVIEW_CALLS.push({ kind: kind, profile: body.profile === undefined ? null : body.profile, taskId: body.taskId === undefined ? null : body.taskId })
  const sections = [
    { key: 'header', group: 'fixed', text: 'Task center role: ' + kind + '\nProject: ' + PROJECT },
    { key: 'task', group: 'task', text: 'Task ' + task.id + ': ' + task.title },
    { key: 'fixed', group: 'fixed', text: 'Duties: permission boundary.\nVerdict schema: task_center submit.' },
  ]
  sections.splice(1, 0, { key: 'template', group: 'template', text: 'Profile instructions:\n' + (typeof body.profile === 'string' && body.profile !== '' ? body.profile : kind) })
  return {
    ok: true,
    kind: kind,
    stage: kind === 'worker' ? 'implement' : kind === 'reviewer' ? 'review' : 'test',
    profile: body.profile === undefined ? kind : String(body.profile),
    task: { id: task.id, title: task.title, real: task.id !== 'T-42', sample: task.id === 'T-42' },
    text: sections.map(function (section) { return section.text }).join('\n\n'),
    tokens: PREVIEW_VARIABLES.map(function (name) {
      return {
        name: name,
        value: name === 'TASK_ID' ? task.id : name === 'TASK_TITLE' ? task.title : name === 'PROJECT' ? PROJECT : name === 'ROLE' ? kind : '',
      }
    }),
    sections: sections,
    // The real route attaches the board snapshot to every successful action.
    snapshot: HOST,
  }
}
// The host now normalises the built-in reviewer/tester prompts; the panel shows
// them read-only. The worker prompt stays empty until the implement stage is wired.
const WORKER_DEFAULT_PROMPT = 'Implement the task in its worktree and prove it there.'
const REVIEWER_DEFAULT_PROMPT = 'Review the submitted tree; approve it or request concrete changes.'
const TESTER_DEFAULT_PROMPT = 'Test the candidate against the acceptance criteria; record pass or fail with evidence.'
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
  agents: {
    lead: { id: 'session-lead', name: 'lead', kind: 'lead', description: 'Team lead', session: 'session-lead', status: 'running', currentTask: null },
    members: [
      { id: 'session-fixer', name: 'fixer', kind: 'worker', description: 'feature worker', session: 'session-fixer', status: 'running', currentTask: { id: 'T-1', title: 'Build damage system' } },
      { id: 'session-reviewer-1', name: 'reviewer-1', kind: 'reviewer', description: 'review role', session: 'session-reviewer-1', status: 'inactive', currentTask: null },
      { id: 'session-tester-1', name: 'tester-1', kind: 'tester', description: 'test role', session: 'session-tester-1', status: 'idle', currentTask: null },
    ],
    kinds: { lead: 1, worker: 1, reviewer: 1, tester: 1, merger: 0 },
    roles: {
      desired: { worker: 1, reviewer: 2, tester: 1 },
      live: { worker: 1, reviewer: 1, tester: 1 },
      missing: { worker: 0, reviewer: 1, tester: 0 },
      bound: { worker: 'worker', reviewer: 'godot-reviewer', tester: 'tester' },
      profiles: {},
      stages: { implement: 'worker', review: 'godot-reviewer', test: 'tester' },
    },
  },
  worktrees: {
    available: true,
    error: null,
    total: 4,
    active: 2,
    counts: { main: 1, task: 1, verify: 0, test: 1, merge: 0, other: 1 },
    worktrees: [
      { path: PROJECT, branch: 'feat/task-center-v2', head: 'abcdef1234', type: 'main', taskId: null, active: false },
      { path: PROJECT + '\\.worktrees\\T-1', branch: 'task/T-1-1', head: '1234567890', type: 'task', taskId: 'T-1', active: true },
      { path: PROJECT + '\\.worktrees\\test-T-4', branch: 'test/T-4', head: 'aaaabbbbcc', type: 'test', taskId: 'T-4', active: true },
      { path: PROJECT + '\\.worktrees\\scratch', branch: 'scratch', head: 'ffff000011', type: 'other', taskId: null, active: false },
    ],
  },
  activity: {
    available: true,
    limit: 100,
    count: 3,
    pushed: 3,
    actors: { system: 1, host: 1, agent: 1 },
    entries: [
      { kind: 'test-reminder', actor: 'system', actorName: null, taskId: 'T-1', detail: 'test phase still pending; reminded tester-1', at: new Date(now - 3000).toISOString() },
      { kind: 'merge', actor: 'agent', actorName: 'reviewer-1', taskId: 'T-3', detail: 'merged as fedcba0987654321', at: new Date(now - 5000).toISOString() },
      { kind: 'worktree-create', actor: 'host', actorName: null, taskId: 'T-4', detail: 'test candidate', at: new Date(now - 7000).toISOString() },
    ],
  },
  roles: {
    version: 1,
    defaultProfile: 'worker',
    stages: { implement: 'worker', review: 'godot-reviewer', test: 'tester' },
    profiles: {
      worker: { name: 'worker', role: 'worker', stage: 'implement', instances: 1, skills: [], context: 'fresh', permissions: [], prompt: WORKER_DEFAULT_PROMPT },
      reviewer: { name: 'reviewer', role: 'reviewer', stage: 'review', instances: 1, skills: [], context: 'fresh', permissions: [], prompt: REVIEWER_DEFAULT_PROMPT },
      tester: { name: 'tester', role: 'tester', stage: 'test', instances: 1, skills: [], context: 'fresh', permissions: [], prompt: TESTER_DEFAULT_PROMPT },
      'godot-reviewer': { name: 'godot-reviewer', role: 'reviewer', stage: 'review', instances: 2, skills: ['dsh-plugin-workflow'], context: 'fork', permissions: ['read-only', 'review'], prompt: 'Check Godot idioms.' },
    },
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
let postReply = null
const posts = []
globalThis.fetch = async function (url, options) {
  if (options !== undefined && options.method === 'POST') {
    const body = JSON.parse(options.body)
    posts.push(body)
    if (postGate !== null) await postGate
    if (postReply !== null) {
      const reply = postReply
      postReply = null
      return { json: async () => reply }
    }
    if (body.action === 'rolesPreview') return { json: async () => rolePreviewReply(body) }
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

// ── Roles / Status views: agents, worktrees, activity and role admin ──────
{
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let copied = null
  try {
    Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async function (value) { copied = value } } }, configurable: true })
  } catch (_error) {}

  let statusTree = withHooks(panel, { initialView: 'status' })
  await flush()
  statusTree = withHooks(panel, { initialView: 'status' })
  const statusText = textOf(statusTree)
  check('the status tab is offered alongside the existing views', findButton(statusTree, '状态') !== undefined && findButton(statusTree, '角色') !== undefined, statusText.slice(0, 200))
  check('the status view separates agents, worktrees and activity sections', ['执行代理', '工作树', '活动'].every((label) => statusText.indexOf(label) >= 0), statusText)
  const agentRows = findAll(statusTree, (node) => node.type === 'tr' && node.props && node.props['data-agent'] !== undefined)
  check('the agents table lists the lead and every teammate once', agentRows.length === 4, String(agentRows.length))
  const leadRow = agentRows.filter((row) => row.props['data-agent'] === 'lead')[0]
  const fixerRow = agentRows.filter((row) => row.props['data-agent'] === 'fixer')[0]
  const reviewerRow = agentRows.filter((row) => row.props['data-agent'] === 'reviewer-1')[0]
  const testerAgentRow = agentRows.filter((row) => row.props['data-agent'] === 'tester-1')[0]
  check('the lead is a single row with the lead kind', leadRow !== undefined && leadRow.props['data-kind'] === 'lead' && textOf(leadRow).indexOf('Team Lead') >= 0, leadRow && textOf(leadRow))
  check('teammate rows carry their kind, description and current task', fixerRow !== undefined && fixerRow.props['data-kind'] === 'worker' && textOf(fixerRow).indexOf('feature worker') >= 0 && textOf(fixerRow).indexOf('T-1 · Build damage system') >= 0, fixerRow && textOf(fixerRow))
  check('reviewer and tester kinds are visible', reviewerRow !== undefined && textOf(reviewerRow).indexOf('评审') >= 0 && testerAgentRow !== undefined && textOf(testerAgentRow).indexOf('测试') >= 0, (reviewerRow && textOf(reviewerRow)) + ' | ' + (testerAgentRow && textOf(testerAgentRow)))
  const kindCounts = findAll(statusTree, (node) => node.props && node.props['data-kind'] !== undefined && node.type === 'span')
  check('kind counts are rendered for every role kind', ['lead', 'worker', 'reviewer', 'tester', 'merger'].every(function (kind) { return kindCounts.some(function (node) { return node.props['data-kind'] === kind }) }), String(kindCounts.length))
  const roleKindStrip = findAll(statusTree, (node) => node.props && node.props['data-role-kind'] !== undefined)
  check('desired/live/missing and the bound profile are shown', roleKindStrip.some(function (node) { return node.props['data-role-kind'] === 'reviewer' && textOf(node).indexOf('1/2') >= 0 && textOf(node).indexOf('godot-reviewer') >= 0 }), roleKindStrip.map(textOf).join(' | '))
  check('session ids are shown with a copy control', textOf(fixerRow).indexOf('session-fixer') >= 0 && findAll(fixerRow, (node) => node.props && node.props['data-action'] === 'copy-session').length === 1, fixerRow && textOf(fixerRow))
  check(
    'no fake jump-to-session control is rendered (the hint acknowledges there is no API)',
    findButton(statusTree, '查看会话') === undefined &&
      findAll(statusTree, (node) => node.props && node.props['data-action'] === 'open-session').length === 0 &&
      statusText.indexOf('会话跳转 API') >= 0,
    statusText,
  )
  check('the session hint says to copy or open from the Team list', statusText.indexOf('复制') >= 0 && statusText.indexOf('Team 列表') >= 0, statusText)
  const copyButton = findAll(fixerRow, (node) => node.props && node.props['data-action'] === 'copy-session')[0]
  copyButton.props.onClick()
  await flush()
  check('copying puts the session id on the clipboard', copied === 'session-fixer', String(copied))

  const worktreeRows = findAll(statusTree, (node) => node.type === 'tr' && node.props && node.props['data-worktree'] !== undefined)
  check('the worktrees table lists every checkout', worktreeRows.length === 4, String(worktreeRows.length))
  const taskWorktreeRow = worktreeRows.filter((row) => String(row.props['data-worktree']).indexOf('T-1') >= 0)[0]
  check('a task checkout shows type, branch, head, task and active state', taskWorktreeRow !== undefined && taskWorktreeRow.props['data-type'] === 'task' && taskWorktreeRow.props['data-active'] === 'true' && textOf(taskWorktreeRow).indexOf('task/T-1-1') >= 0 && textOf(taskWorktreeRow).indexOf('T-1') >= 0, taskWorktreeRow && textOf(taskWorktreeRow))
  const typeCounts = findAll(statusTree, (node) => node.props && node.props['data-wt-type'] !== undefined)
  check('per-type worktree counts are rendered', typeCounts.length === 6 && typeCounts.some(function (node) { return node.props['data-wt-type'] === 'test' && textOf(node).indexOf('1') >= 0 }), typeCounts.map(textOf).join(' | '))
  const activityRows = findAll(statusTree, (node) => node.type === 'tr' && node.props && node.props['data-activity'] !== undefined)
  check('the activity table renders every entry', activityRows.length === 3, String(activityRows.length))
  const actorCell = function (row) {
    return findAll(row, (node) => node.props && node.props['data-col'] === 'activity-actor')[0]
  }
  const systemRow = activityRows.filter((row) => row.props['data-actor'] === 'system')[0]
  const agentRow = activityRows.filter((row) => row.props['data-actor'] === 'agent')[0]
  const hostRow = activityRows.filter((row) => row.props['data-actor'] === 'host')[0]
  check('a system event is labelled system, not an agent', systemRow !== undefined && textOf(actorCell(systemRow)) === '系统' && textOf(systemRow).indexOf('reviewer-1') < 0, systemRow && textOf(systemRow))
  check('an agent event carries the agent name', agentRow !== undefined && textOf(actorCell(agentRow)) === 'reviewer-1', agentRow && textOf(agentRow))
  check('a host event is labelled host', hostRow !== undefined && textOf(actorCell(hostRow)) === '宿主', hostRow && textOf(hostRow))
  check('the actor column has a neutral header, not an agent header', findAll(statusTree, (node) => node.type === 'th' && textOf(node) === '主体').length === 1 && findAll(statusTree, (node) => node.type === 'th' && textOf(node) === '代理').length === 0, statusText)
  check('the activity limit and count are visible', statusText.indexOf('上限') >= 0 && statusText.indexOf('100') >= 0 && statusText.indexOf('条数') >= 0, statusText)
  const activityAtCell = findAll(activityRows[0], (node) => node.props && node.props['data-col'] === 'activity-at')[0]
  check('activity times are rendered', activityAtCell !== undefined && textOf(activityAtCell) !== '—' && textOf(activityAtCell) !== '', activityAtCell && textOf(activityAtCell))

  const savedWorktrees = HOST.worktrees
  HOST.worktrees = { available: false, error: 'no-git-service', total: 0, active: 0, counts: {}, worktrees: [] }
  findButton(statusTree, '刷新').props.onClick()
  await flush()
  const noGitTree = withHooks(panel, { initialView: 'status' })
  check('a host without git says no-git-service instead of showing a blank table', textOf(noGitTree).indexOf('no-git-service') >= 0, textOf(noGitTree))
  HOST.worktrees = { available: true, error: null, total: 0, active: 0, counts: {}, worktrees: [] }
  findButton(noGitTree, '刷新').props.onClick()
  await flush()
  const emptyWorktreesTree = withHooks(panel, { initialView: 'status' })
  check('an available but empty worktree inventory says so', textOf(emptyWorktreesTree).indexOf('没有工作树') >= 0, textOf(emptyWorktreesTree))
  HOST.worktrees = savedWorktrees
  findButton(emptyWorktreesTree, '刷新').props.onClick()
  await flush()
  if (savedNavigator === undefined) delete globalThis.navigator
  else Object.defineProperty(globalThis, 'navigator', savedNavigator)
}

// ── Roles tab: ONE editor card, identity binding, in-card instances ────────
{
  let rolesTree = withHooks(panel, { initialView: 'roles' })
  await flush()
  rolesTree = withHooks(panel, { initialView: 'roles' })
  const rolesText = textOf(rolesTree)
  check('the editor names the built-in profile it is editing', rolesText.indexOf('worker') >= 0, rolesText)
  check('the three role kinds are one click away', rolesText.indexOf('实现') >= 0 && rolesText.indexOf('测试') >= 0 && rolesText.indexOf('评审') >= 0, rolesText)
  // The automatic injected-preview fetch must never become "your last action":
  // no fabricated banner on mount, and no actionResult written by the preview.
  check(
    'the roles page shows no fabricated action banner on mount',
    findAll(rolesTree, (node) => node.props && node.props['data-role-result'] !== undefined).length === 0 && rolesText.indexOf('保存 ✓') < 0,
    rolesText.slice(0, 300),
  )
  const mountResult = captured.getSnapshot().actionResult
  check(
    'the automatic preview never becomes the recorded action result',
    mountResult === null || mountResult.kind === undefined,
    JSON.stringify(mountResult === null ? null : { kind: mountResult.kind, keys: Object.keys(mountResult) }),
  )

  // ONE card: the context editor. Every stand-alone management card is gone.
  const cards = findAll(rolesTree, (node) => node.props && typeof node.props.className === 'string' && node.props.className.indexOf('gbt-rcard') >= 0)
  check('the roles tab is ONE card: the context editor', cards.length === 1 && cards[0].props['data-card'] === 'editor', JSON.stringify(cards.map((card) => card.props['data-card'])))
  check(
    'the old stand-alone cards are gone',
    ['source', 'stages', 'profiles', 'previews', 'create', 'instances', 'actionbar'].every((id) => cards.every((card) => card.props['data-card'] !== id)) &&
      findAll(rolesTree, (node) => node.props && node.props.className === 'gbt-actionbar').length === 0,
    JSON.stringify(cards.map((card) => card.props['data-card'])),
  )
  check('the old preview blocks are gone', findAll(rolesTree, (node) => node.props && node.props['data-role-preview'] !== undefined).length === 0)
  check('the old profile table is gone', findAll(rolesTree, (node) => node.type === 'tr' && node.props && node.props['data-role-profile'] !== undefined).length === 0)
  check('the old stage table is gone', findAll(rolesTree, (node) => node.type === 'tr' && node.props && node.props['data-stage'] !== undefined).length === 0)
  check('every card has exactly one title row', cards.every((card) => findAll(card, (node) => node.props && node.props.className === 'gbt-rtitle').length === 1))

  let editor = findAll(cards[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  check('the card holds the context editor', editor !== undefined && editor.props['data-kind'] === 'worker', editor === undefined ? 'missing' : editor.props['data-kind'])

  // Segmented tabs: real, focusable buttons with an aria selection state.
  const tabs = findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind')
  check(
    'the editor offers 实现/测试/评审 tabs as real buttons',
    tabs.length === 3 && tabs.every((tab) => tab.type === 'button' && tab.props.role === 'tab') && tabs.map((tab) => tab.props['data-kind']).join(',') === 'worker,tester,reviewer',
    JSON.stringify(tabs.map((tab) => [tab.type, tab.props.role, tab.props['data-kind']])),
  )
  check('the tabs are labelled 实现/测试/评审', tabs.map(textOf).join(',') === '实现,测试,评审', tabs.map(textOf).join(','))
  check('the tabs sit in a labelled tablist', findAll(editor, (node) => node.props && node.props.role === 'tablist').length === 1)
  check(
    'the selected tab carries aria-selected=true and the others false',
    tabs[0].props['aria-selected'] === 'true' && tabs[1].props['aria-selected'] === 'false' && tabs[2].props['aria-selected'] === 'false',
    JSON.stringify(tabs.map((tab) => tab.props['aria-selected'])),
  )
  check('exactly one tab is marked active', findAll(editor, (node) => node.props && node.props.className === 'gbt-seg' && node.props['data-active'] === 'true').length === 1)

  // Identity row: kind + bound profile read-only, plus the profile selector/bind.
  let identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check(
    'the identity row names the kind and the bound profile',
    identity.props['data-kind'] === 'worker' && identity.props['data-profile'] === 'worker' && identity.props['data-bound'] === 'worker',
    JSON.stringify(identity.props),
  )
  check('the identity has no free-text control', findAll(identity, (node) => node.type === 'input' || node.type === 'textarea').length === 0)
  let identitySelect = findAll(identity, (node) => node.type === 'select' && node.props['data-stage-select'] !== undefined)[0]
  check(
    'the identity selector offers the stage\'s profiles',
    identitySelect !== undefined && identitySelect.props.defaultValue === 'worker' && identitySelect.props.children.length === 1,
    identitySelect === undefined ? 'missing' : JSON.stringify(identitySelect.props.children.map((option) => option.props.value)),
  )
  const refresh = findAll(rolesTree, (node) => node.props && node.props['data-action'] === 'rolesList')[0]
  check('reloading the profiles moved into the card header', refresh !== undefined && findAll(cards[0], (node) => node.props && node.props.className === 'gbt-rhead' && findAll(node, (child) => child === refresh).length === 1).length === 1)
  refresh.props.onClick()
  await flush()
  check('reloading the role profiles sends rolesList', posts[posts.length - 1].action === 'rolesList', JSON.stringify(posts[posts.length - 1]))

  // Switch to the reviewer tab: its bound custom profile, and its stage owners.
  // The switch triggers an automatic preview request; it must not touch the
  // action-result channel (neither set nor clear the user's last outcome).
  const previewResultBefore = captured.getSnapshot().actionResult
  const previewErrorBefore = captured.getSnapshot().actionError
  tabs[2].props.onClick()
  rolesTree = withHooks(panel, { initialView: 'roles' })
  await flush()
  rolesTree = withHooks(panel, { initialView: 'roles' })
  check(
    'an automatic preview never writes snapshot.actionResult/actionError',
    captured.getSnapshot().actionResult === previewResultBefore && captured.getSnapshot().actionError === previewErrorBefore,
    JSON.stringify({ before: previewResultBefore === null ? null : Object.keys(previewResultBefore), after: captured.getSnapshot().actionResult === null ? null : Object.keys(captured.getSnapshot().actionResult), error: captured.getSnapshot().actionError }),
  )
  editor = findAll(findAll(rolesTree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check(
    'switching a tab shows that kind\'s bound profile',
    identity.props['data-kind'] === 'reviewer' && identity.props['data-profile'] === 'godot-reviewer' && identity.props['data-bound'] === 'godot-reviewer',
    JSON.stringify(identity.props),
  )
  check('the active tab follows the switch', findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['aria-selected'] === 'true').map((tab) => tab.props['data-kind']).join(',') === 'reviewer')
  identitySelect = findAll(identity, (node) => node.type === 'select' && node.props['data-stage-select'] !== undefined)[0]
  check(
    'the selector lists every profile owning the stage, from profile.stage',
    identitySelect.props.children.map((option) => option.props.value).join(',') === 'reviewer,godot-reviewer',
    JSON.stringify(identitySelect.props.children.map((option) => option.props.value)),
  )

  // A custom profile can be deleted; a built-in cannot.
  check('a custom profile offers delete', findAll(identity, (node) => node.props && node.props['data-action'] === 'rolesDelete').length === 1)

  // Bind the chosen profile to the stage from the identity row. A real action
  // still shows its result banner (the payload is the host's, not a preview).
  postReply = { ok: true, config: HOST.roles, bound: { stage: 'review', profile: 'reviewer' }, source: 'file', snapshot: HOST }
  identitySelect.props.ref.current = { value: 'reviewer' }
  findAll(identity, (node) => node.props && node.props['data-action'] === 'rolesBind')[0].props.onClick()
  await flush()
  const bindPost = posts[posts.length - 1]
  check('binding from the identity row sends rolesBind with the chosen profile', bindPost.action === 'rolesBind' && bindPost.stage === 'review' && bindPost.profile === 'reviewer', JSON.stringify(bindPost))
  const afterBind = withHooks(panel, { initialView: 'roles' })
  const bindBanner = findAll(afterBind, (node) => node.props && node.props['data-role-result'] === 'ok')[0]
  check('a real bind still shows its result banner', bindBanner !== undefined && textOf(bindBanner).indexOf('来源') >= 0, bindBanner && textOf(bindBanner))

  // Picking another profile in the selector retargets the editor.
  identitySelect.props.onChange()
  rolesTree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(rolesTree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check('picking a profile retargets the editor', identity.props['data-profile'] === 'reviewer' && identity.props['data-bound'] === 'godot-reviewer', JSON.stringify(identity.props))
  check('a built-in profile offers no delete', findAll(identity, (node) => node.props && node.props['data-action'] === 'rolesDelete').length === 0)

  // The kind's instances live in a compact block inside the same card.
  identitySelect.props.ref.current = { value: 'godot-reviewer' }
  identitySelect.props.onChange()
  rolesTree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(rolesTree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const instanceBlock = findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-instances')[0]
  check('the editor carries the instances block', instanceBlock !== undefined)
  const instanceRows = findAll(editor, (node) => node.type === 'tr' && node.props && node.props['data-role-instance'] !== undefined)
  check(
    'only the current kind\'s instances are listed',
    instanceRows.length === 1 && instanceRows[0].props['data-role-instance'] === 'reviewer-1',
    JSON.stringify({ rows: instanceRows.map((row) => row.props['data-role-instance']), kind: editor.props['data-kind'] }),
  )
  findAll(instanceRows[0], (node) => node.props && node.props['data-action'] === 'rolesDrain')[0].props.onClick()
  await flush()
  check('draining an instance sends rolesDrain', posts[posts.length - 1].action === 'rolesDrain' && posts[posts.length - 1].name === 'reviewer-1', JSON.stringify(posts[posts.length - 1]))
  findAll(instanceRows[0], (node) => node.props && node.props['data-action'] === 'rolesReplace')[0].props.onClick()
  await flush()
  check('replacing an instance sends rolesReplace', posts[posts.length - 1].action === 'rolesReplace' && posts[posts.length - 1].name === 'reviewer-1', JSON.stringify(posts[posts.length - 1]))

  // A replace reports its wait status; it is not assumed to finish instantly.
  postReply = {
    ok: true,
    kind: 'reviewer',
    drained: ['reviewer-1'],
    created: [{ name: 'reviewer-2' }],
    reused: ['reviewer-3'],
    replaced: [{ name: 'reviewer-1', reason: 'drained' }],
    waited: { waitedMs: 120, timedOut: true, waiting: [{ name: 'reviewer-1' }] },
    snapshot: HOST,
  }
  findAll(instanceRows[0], (node) => node.props && node.props['data-action'] === 'rolesReplace')[0].props.onClick()
  await flush()
  const waitedText = textOf(withHooks(panel, { initialView: 'roles' }))
  check('a replace shows drained/created and the waited/timedOut/waiting status', waitedText.indexOf('已排空') >= 0 && waitedText.indexOf('reviewer-2') >= 0 && waitedText.indexOf('120') >= 0 && waitedText.indexOf('等待超时') >= 0 && waitedText.indexOf('等待中') >= 0, waitedText)
  check('a replace also reports the replaced and reused instances', waitedText.indexOf('已替换: reviewer-1') >= 0 && waitedText.indexOf('复用: reviewer-3') >= 0, waitedText)

  // Batch actions moved next to the editor actions: replace the current kind, reset.
  rolesTree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(rolesTree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'rolesReplace-kind' && node.props['data-kind'] === 'reviewer')[0].props.onClick()
  await flush()
  check('replacing the current kind sends rolesReplace with the kind name', posts[posts.length - 1].action === 'rolesReplace' && posts[posts.length - 1].name === 'reviewer', JSON.stringify(posts[posts.length - 1]))
  findAll(editor, (node) => node.props && node.props['data-action'] === 'rolesReset')[0].props.onClick()
  await flush()
  check('resetting sends rolesReset', posts[posts.length - 1].action === 'rolesReset', JSON.stringify(posts[posts.length - 1]))

  // A reset that hits a host timeout is shown inside the result banner. The real
  // API shape is ensured = [{ kind, result }]: only result carries ok/code/message.
  postReply = { ok: true, ensured: [{ kind: 'reviewer', result: { ok: false, code: 'action-timeout', message: 'role reviewer provisioning timed out' } }], snapshot: HOST }
  findAll(editor, (node) => node.props && node.props['data-action'] === 'rolesReset')[0].props.onClick()
  await flush()
  const ensuredText = textOf(withHooks(panel, { initialView: 'roles' }))
  check(
    'a reset with a failed ensure reports the kind and readable reason (real ensured shape)',
    ensuredText.indexOf('宿主操作超时') >= 0 && ensuredText.indexOf('reviewer') >= 0 && ensuredText.indexOf('role reviewer provisioning timed out') >= 0,
    ensuredText,
  )

  // All three ensures succeeded: the banner must not invent a failure.
  postReply = {
    ok: true,
    ensured: [
      { kind: 'worker', result: { ok: true } },
      { kind: 'reviewer', result: { ok: true } },
      { kind: 'tester', result: { ok: true } },
    ],
    snapshot: HOST,
  }
  findAll(editor, (node) => node.props && node.props['data-action'] === 'rolesReset')[0].props.onClick()
  await flush()
  const ensuredOkText = textOf(withHooks(panel, { initialView: 'roles' }))
  check('a fully successful reset shows no false failure', ensuredOkText.indexOf('已创建: 3') >= 0 && ensuredOkText.indexOf('操作失败') < 0, ensuredOkText)

  // Server-side validation errors are readable in the panel, and a COMPLETED
  // poll (the refresh button calls store.load) does not wipe them.
  postReply = { ok: false, code: 'invalid-role-instances', message: 'instances must be an integer from 1 to 8' }
  const errorTree0 = withHooks(panel, { initialView: 'roles' })
  const blankCreate = findAll(errorTree0, (node) => node.props && node.props['data-section'] === 'role-create-blank')[0]
  check('the blank-create form is the editor\'s secondary entry', blankCreate !== undefined && findAll(blankCreate, (node) => node.props && node.props['data-form'] === 'role-create').length === 1)
  const errorForm = findAll(blankCreate, (node) => node.props && node.props['data-form'] === 'role-create')[0]
  findAll(errorForm, (node) => node.props && node.props['data-field'] === 'name')[0].props.ref.current = { value: 'bad-reviewer' }
  findAll(errorForm, (node) => node.props && node.props['data-action'] === 'rolesCreate')[0].props.onClick()
  await flush()
  check('the refused action is recorded in the store', captured.getSnapshot().actionError !== null && captured.getSnapshot().actionError.code === 'invalid-role-instances', JSON.stringify(captured.getSnapshot().actionError))
  const loadsBeforePoll = loads
  findButton(withHooks(panel, { initialView: 'roles' }), '刷新').props.onClick()
  let pollGuard = 0
  while (loads === loadsBeforePoll && pollGuard < 20) {
    await flush()
    pollGuard += 1
  }
  check('the poll really completed before the assertion', loads > loadsBeforePoll, String(loads - loadsBeforePoll))
  const errorText = textOf(withHooks(panel, { initialView: 'roles' }))
  check(
    'a validation error stays readable after a completed poll and maps to a readable message',
    captured.getSnapshot().actionError !== null && errorText.indexOf('实例数必须是 1–8 的整数') >= 0 && errorText.indexOf('instances must be an integer from 1 to 8') >= 0,
    errorText,
  )
  postReply = null
}

// ── Roles layout: one card, segmented tabs, the blank-create fold ──────────
{
  const rolesTree = withHooks(panel, { initialView: 'roles' })
  await flush()
  const css = styleTags.map((tag) => String(tag.textContent || '')).join('\n')
  check(
    'CSS styles the segmented tabs: selected, hover and focus-visible',
    css.indexOf('.gbt-segmented') >= 0 &&
      css.indexOf('.gbt-seg[aria-selected="true"]') >= 0 &&
      css.indexOf('.gbt-seg[aria-selected="false"]') >= 0 &&
      css.indexOf('.gbt-seg:hover') >= 0 &&
      css.indexOf('.gbt-seg:focus-visible') >= 0 &&
      css.indexOf('cursor:pointer') >= 0 &&
      css.indexOf('border-bottom-color') >= 0,
    css.slice(0, 160),
  )
  check(
    'CSS gives the blank-create fold, the identity selector and the instances block a layout',
    css.indexOf('.gbt-createblank') >= 0 && css.indexOf('.gbt-editor-select') >= 0 && css.indexOf('.gbt-editorinstances') >= 0,
    css.slice(0, 160),
  )
  const editor = findAll(rolesTree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  const instancesBlock = findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-instances')[0]
  check(
    'the instances block holds the only role-instance table',
    instancesBlock !== undefined &&
      findAll(rolesTree, (node) => node.type === 'table' && node.props && node.props['data-section'] === 'role-instances').length === 1 &&
      findAll(instancesBlock, (node) => node.props && node.props.className === 'gbt-tablewrap').length === 1,
    String(findAll(rolesTree, (node) => node.type === 'table' && node.props && node.props['data-section'] === 'role-instances').length),
  )
  const form = findAll(rolesTree, (node) => node.props && node.props['data-form'] === 'role-create')[0]
  check('the blank-create form uses the responsive grid class', form !== undefined && form.props.className === 'gbt-formgrid', form && form.props.className)
  const formLabels = findAll(form, (node) => node.type === 'label')
  check('the blank-create form has a multi-field grid', formLabels.length === 7, String(formLabels.length))
  const promptLabel = formLabels.filter((label) => label.props.className === 'gbt-formwide')[0]
  check('the prompt field spans the full grid row', promptLabel !== undefined && findAll(promptLabel, (node) => node.type === 'textarea' && node.props['data-field'] === 'prompt').length === 1)
  const formActions = findAll(form, (node) => node.props && node.props.className === 'gbt-formactions')[0]
  check('the create button sits in a right-aligned action row', formActions !== undefined && findAll(formActions, (node) => node.props && node.props['data-action'] === 'rolesCreate').length === 1)
}

// ── Prompt area: two columns, raw prompt left, exact injected text right ───
{
  let tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  let editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  // The editor is the only surface now, so pin the kind explicitly: module state
  // survives between blocks.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]

  const promptArea = findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-prompts')[0]
  check('the editor has ONE prompt area in the same split shape as review/test', promptArea !== undefined && promptArea.props['data-role-layout'] === 'split', promptArea && promptArea.props.className)
  const workerRaw = findAll(promptArea, (node) => node.props && node.props['data-role-prompt'] === 'raw')[0]
  const injectedCol = findAll(promptArea, (node) => node.props && node.props['data-role-prompt'] === 'injected')[0]
  check(
    'the implement page is two columns: raw prompt and injected text',
    promptArea.props.className === 'gbt-promptcols' && workerRaw !== undefined && injectedCol !== undefined,
    JSON.stringify(promptArea.props),
  )
  check(
    'the old six-block renderer is gone',
    findAll(editor, (node) => node.props && node.props['data-block-type'] !== undefined).length === 0 &&
      findAll(editor, (node) => node.props && node.props['data-editor-block'] !== undefined).length === 0,
  )
  check(
    'the built-in worker prompt is shown read-only, not as an empty panel',
    workerRaw.props['data-role-raw-readonly'] === 'true' &&
      workerRaw.props['data-role-raw-reason'] === 'builtin' &&
      workerRaw.props['data-role-default-prompt'] === 'true' &&
      findAll(workerRaw, (node) => node.type === 'textarea').length === 0,
    JSON.stringify(workerRaw.props),
  )
  const workerPromptText = findAll(workerRaw, (node) => node.props && node.props['data-role-default-prompt-text'] === 'true')[0]
  check(
    'the worker default prompt is rendered literally',
    workerPromptText !== undefined && textOf(workerPromptText) === WORKER_DEFAULT_PROMPT && findAll(workerPromptText, (node) => node.type === 'input' || node.type === 'textarea').length === 0,
    workerPromptText && textOf(workerPromptText),
  )
  const workerCopy = findAll(workerRaw, (node) => node.props && node.props['data-role-empty-fork'] === 'true')[0]
  check(
    'the worker prompt keeps the not-editable note and the existing Fork action',
    workerCopy !== undefined && workerCopy.props['data-action'] === 'role-editor-fork' && textOf(workerCopy) === '复制一份来改' && textOf(workerRaw).indexOf('默认角色不可修改') >= 0,
    workerRaw && textOf(workerRaw),
  )

  // The right column is what the host really injects, not panel copy.
  const source = findAll(injectedCol, (node) => node.props && node.props['data-role-task-source'] !== undefined)[0]
  check(
    'the right column names a real task as the source',
    source !== undefined && source.props['data-role-task-source'] === 'real' && textOf(source).indexOf('T-1 · Build damage system') >= 0,
    source && textOf(source),
  )
  const previewText = findAll(injectedCol, (node) => node.props && node.props['data-role-preview-text'] === 'true')[0]
  check(
    'the right column renders the host text verbatim',
    previewText !== undefined && textOf(previewText).indexOf('Task center role: worker') >= 0 && textOf(previewText).indexOf('Duties: permission boundary.') >= 0,
    previewText && textOf(previewText).slice(0, 200),
  )
  const sectionNodes = findAll(injectedCol, (node) => node.type === 'div' && node.props && node.props['data-role-section-group'] !== undefined)
  check(
    'the right column separates task data from host copy with readable labels',
    sectionNodes.map((node) => node.props['data-role-section-group']).join(',') === 'fixed,template,task,fixed' &&
      findAll(sectionNodes[1], (node) => node.type === 'span').some((node) => textOf(node) === '内置默认提示词') &&
      findAll(sectionNodes[2], (node) => node.type === 'span').some((node) => textOf(node) === '任务数据') &&
      findAll(sectionNodes[3], (node) => node.type === 'span').some((node) => textOf(node) === '宿主固定'),
    sectionNodes.map((node) => textOf(node)).join(' | '),
  )
  check('the sample label is not shown for a real task', textOf(injectedCol).indexOf('示例任务（非真实') < 0)
  check('the task selector offers every host task by id and title', findAll(injectedCol, (node) => node.type === 'option').length === TASKS.length + 1)

  // A built-in profile other than the implement stage is read-only with its own note.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'tester')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  const testerArea = findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-prompts')[0]
  const testerRaw = findAll(testerArea, (node) => node.props && node.props['data-role-prompt'] === 'raw')[0]
  const testerInjected = findAll(testerArea, (node) => node.props && node.props['data-role-prompt'] === 'injected')[0]
  check(
    'a built-in profile keeps two columns and shows its readable default prompt, not an empty panel',
    testerArea.props['data-role-layout'] === 'split' &&
      testerRaw !== undefined &&
      testerInjected !== undefined &&
      testerRaw.props['data-role-raw-readonly'] === 'true' &&
      testerRaw.props['data-role-raw-reason'] === 'builtin' &&
      testerRaw.props['data-role-default-prompt'] === 'true' &&
      findAll(testerRaw, (node) => node.type === 'textarea').length === 0,
    testerRaw && JSON.stringify(testerRaw.props),
  )
  const defaultPromptText = findAll(testerRaw, (node) => node.props && node.props['data-role-default-prompt-text'] === 'true')[0]
  check(
    'the built-in default prompt is rendered read-only and literal',
    defaultPromptText !== undefined && textOf(defaultPromptText) === TESTER_DEFAULT_PROMPT && findAll(defaultPromptText, (node) => node.type === 'input' || node.type === 'textarea').length === 0,
    defaultPromptText && textOf(defaultPromptText),
  )
  const emptyCopy = findAll(testerRaw, (node) => node.props && node.props['data-role-empty-fork'] === 'true')[0]
  check(
    'the built-in prompt keeps the not-editable note and the existing Fork action',
    emptyCopy !== undefined &&
      emptyCopy.props['data-action'] === 'role-editor-fork' &&
      textOf(emptyCopy) === '复制一份来改' &&
      textOf(testerRaw).indexOf('默认角色不可修改') >= 0,
    testerRaw && textOf(testerRaw),
  )
  const testerTemplate = findAll(testerInjected, (node) => node.props && node.props['data-role-section-group'] === 'template')[0]
  check(
    'the injected template section is labelled as the built-in default prompt',
    testerTemplate !== undefined && findAll(testerTemplate, (node) => node.type === 'span').some((node) => textOf(node) === '内置默认提示词'),
    testerTemplate && textOf(testerTemplate),
  )

  // Forking copies the default prompt into an editable two-column view.
  emptyCopy.props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  const forkedArea = findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-prompts')[0]
  const forkedRaw = findAll(forkedArea, (node) => node.props && node.props['data-role-prompt'] === 'raw')[0]
  const forkedAreaField = findAll(forkedRaw, (node) => node.type === 'textarea' && node.props['data-field'] === 'template')[0]
  check(
    'a forked copy is two columns, editable, and starts from the default prompt',
    forkedArea.props['data-role-layout'] === 'split' &&
      forkedRaw !== undefined &&
      forkedRaw.props['data-role-raw-readonly'] === 'false' &&
      forkedAreaField !== undefined &&
      forkedAreaField.props.defaultValue === TESTER_DEFAULT_PROMPT,
    forkedAreaField && String(forkedAreaField.props.defaultValue),
  )

  // The implement page forks into an editable two-column view like the others.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  const workerArea = findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-prompts')[0]
  const workerRawCol = findAll(workerArea, (node) => node.props && node.props['data-role-prompt'] === 'raw')[0]
  const workerFork = findAll(workerRawCol, (node) => node.props && node.props['data-role-empty-fork'] === 'true')[0]
  check(
    'the implement page offers the same default-prompt empty state',
    workerFork !== undefined && textOf(workerRawCol).indexOf(WORKER_DEFAULT_PROMPT) >= 0,
    workerRawCol && textOf(workerRawCol),
  )
  workerFork.props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  const forkedWorkerArea = findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-prompts')[0]
  const forkedWorkerField = findAll(forkedWorkerArea, (node) => node.type === 'textarea' && node.props['data-field'] === 'template')[0]
  check(
    'forking the implement page makes it editable and starts from the worker default prompt',
    forkedWorkerArea.props['data-role-layout'] === 'split' &&
      forkedWorkerField !== undefined &&
      forkedWorkerField.props.defaultValue === WORKER_DEFAULT_PROMPT,
    forkedWorkerField && String(forkedWorkerField.props.defaultValue),
  )

  // Leave the editor without a draft so the next block starts on the bound profile.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'tester')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
}

// ── Fork/save: a failed save keeps the draft, a success retargets at once ──
{
  let tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  let editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  // Start on the reviewer tab, bound to the custom profile.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'reviewer')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  let identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  const draftName = identity.props['data-profile']
  check('Fork turns the bound profile into an unsaved draft', identity.props['data-draft'] === 'true' && draftName.indexOf('godot-reviewer-fork') === 0, JSON.stringify(identity.props))

  // A failed save keeps the draft (and the banner is readable).
  postReply = { ok: false, code: 'invalid-role-instances', message: 'instances must be an integer from 1 to 8' }
  const updatesBefore = posts.filter((post) => post.action === 'rolesUpdate').length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check('a failed save keeps the draft for a retry', identity.props['data-draft'] === 'true' && identity.props['data-profile'] === draftName, JSON.stringify(identity.props))
  check('a failed save is readable in the editor', textOf(editor).indexOf('实例数必须是 1–8 的整数') >= 0, textOf(editor).slice(0, 300))
  check('a failed draft save never writes the source profile', posts.filter((post) => post.action === 'rolesUpdate').length === updatesBefore)

  // A successful save creates the fork and retargets the editor IMMEDIATELY:
  // no snapshot refresh (no poll) happens between the save and Apply.
  postReply = null
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  const created = posts[posts.length - 1]
  check(
    'saving the draft creates the forked profile with the copied fields',
    created.action === 'rolesCreate' && created.name === draftName && created.profile.role === 'reviewer' && created.profile.instances === 2 && created.profile.context === 'fork' && created.profile.prompt === 'Check Godot idioms.',
    JSON.stringify(created),
  )
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check('a successful save clears the draft and retargets the new profile without a poll', identity.props['data-draft'] === 'false' && identity.props['data-profile'] === draftName, JSON.stringify(identity.props))
  // No board/snapshot refresh happens between this render and Apply: the editor
  // targets the just-created profile from its own state, not from a poll.
  const loadsBeforeApply = loads
  const beforeApply = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-apply')[0].props.onClick()
  for (let tick = 0; tick < 4; tick += 1) await flush()
  const applyPosts = posts.slice(beforeApply)
  check(
    'Apply binds and replaces for the freshly saved profile, with no poll in between',
    loads === loadsBeforeApply &&
      applyPosts.length === 2 &&
      applyPosts[0].action === 'rolesBind' &&
      applyPosts[0].stage === 'review' &&
      applyPosts[0].profile === draftName &&
      applyPosts[1].action === 'rolesReplace' &&
      applyPosts[1].name === 'reviewer',
    JSON.stringify({ loads: loads - loadsBeforeApply, applyPosts: applyPosts }),
  )

  // Saving a built-in profile in place is refused locally, with no request.
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const beforeRefusal = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  const refusalEditor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  check('saving a built-in profile is refused with no request', posts.length === beforeRefusal, JSON.stringify(posts.slice(beforeRefusal)))
  check('the refusal is readable in the editor', textOf(refusalEditor).indexOf('内置 profile 不能直接修改，请先 Fork 再保存') >= 0, textOf(refusalEditor).slice(0, 400))

  // Applying a draft is refused: it must be saved first.
  findAll(refusalEditor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'reviewer')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const beforeDraftApply = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-apply')[0].props.onClick()
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  const draftApplyEditor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  check('Apply refuses an unsaved draft', posts.length === beforeDraftApply && textOf(draftApplyEditor).indexOf('请先保存这个 Fork 草稿，再应用') >= 0, JSON.stringify(posts.slice(beforeDraftApply)))

  // Worker has no live instance in this fixture: Apply binds and says so.
  findAll(draftApplyEditor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const beforeWorkerApply = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-apply')[0].props.onClick()
  for (let tick = 0; tick < 4; tick += 1) await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  check(
    'Apply without a live instance only binds the stage and explains why',
    posts.slice(beforeWorkerApply).length === 1 && posts[posts.length - 1].action === 'rolesBind' && posts[posts.length - 1].stage === 'implement' && textOf(editor).indexOf('没有在跑实例，只更新了阶段绑定。') >= 0,
    JSON.stringify(posts.slice(beforeWorkerApply)),
  )
}

// ── an in-flight save must not clear a newer Fork draft ────────────────────
{
  let releasePost = null
  postGate = new Promise(function (resolveGate) { releasePost = resolveGate })
  let tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  let editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'reviewer')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  // While that save is in flight, fork again: the newer draft must survive it.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  const forkEditor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const forkedIdentity = findAll(forkEditor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  const forkedName = forkedIdentity.props['data-profile']
  check('a fork while a save is in flight is shown immediately', forkedIdentity.props['data-draft'] === 'true' && forkedName.indexOf('godot-reviewer-fork') === 0, JSON.stringify(forkedIdentity.props))
  releasePost()
  postGate = null
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  const settledEditor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const settledIdentity = findAll(settledEditor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check(
    'the completed save does not clear the newer fork draft',
    settledIdentity.props['data-draft'] === 'true' && settledIdentity.props['data-profile'] === forkedName,
    JSON.stringify(settledIdentity.props),
  )
  postReply = null
}

// ── role context editor: kind tabs, editable raw prompt, injected preview, skills ─
{
  HOST.roles = Object.assign({}, HOST.roles, {
    stages: { implement: 'worker', review: 'godot-reviewer', test: 'tester' },
    profiles: Object.assign({}, HOST.roles.profiles, {
      'godot-reviewer': Object.assign({}, HOST.roles.profiles['godot-reviewer'], { prompt: 'Review {{SPEC}} carefully.' }),
    }),
  })
  let tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  const editorCard = findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0]
  check('the roles view has a role context editor card', editorCard !== undefined && textOf(editorCard).indexOf('角色上下文编辑器') >= 0)
  let editor = findAll(editorCard, (node) => node.props && node.props['data-editor'] === 'true')[0]
  // Pin the kind: the editor's module state survives the earlier blocks.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const kindTabs = findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind')
  check('the editor offers worker/tester/reviewer tabs', kindTabs.map((tab) => tab.props['data-kind']).join(',') === 'worker,tester,reviewer', JSON.stringify(kindTabs.map((tab) => tab.props['data-kind'])))
  let identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check('the worker tab shows its bound profile', identity.props['data-kind'] === 'worker' && identity.props['data-profile'] === 'worker' && identity.props['data-draft'] === 'false', JSON.stringify(identity.props))
  check('the identity has no free-text control', findAll(identity, (node) => node.type === 'input' || node.type === 'textarea').length === 0)

  // The reviewer stage is bound to the custom profile: its raw prompt is editable.
  kindTabs.filter((tab) => tab.props['data-kind'] === 'reviewer')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check('switching tabs shows that kind’s bound profile', identity.props['data-profile'] === 'godot-reviewer' && identity.props['data-bound'] === 'godot-reviewer', JSON.stringify(identity.props))
  const rawCol = findAll(editor, (node) => node.props && node.props['data-role-prompt'] === 'raw')[0]
  const injectedCol = findAll(editor, (node) => node.props && node.props['data-role-prompt'] === 'injected')[0]
  const templateArea = findAll(rawCol, (node) => node.type === 'textarea' && node.props['data-field'] === 'template')[0]
  check(
    'a custom profile makes the raw prompt editable and keeps its literal tokens',
    rawCol.props['data-role-raw-readonly'] === 'false' && templateArea !== undefined && templateArea.props.defaultValue === 'Review {{SPEC}} carefully.',
    templateArea && String(templateArea.props.defaultValue),
  )
  check(
    'the left column lists every variable with its current value on one line',
    findAll(rawCol, (node) => node.props && node.props['data-role-tokens'] !== undefined).length === 1 && textOf(rawCol).indexOf('{{TASK_ID}} → T-1') >= 0 && textOf(rawCol).indexOf('{{SPEC}} → （空）') >= 0,
    textOf(rawCol),
  )
  check(
    'the old variable chips and catalog are gone',
    findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-insert').length === 0 &&
      findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-varlist').length === 0 &&
      findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-varchips').length === 0,
  )
  const reviewerText = findAll(injectedCol, (node) => node.props && node.props['data-role-preview-text'] === 'true')[0]
  const reviewerSections = findAll(injectedCol, (node) => node.type === 'div' && node.props && node.props['data-role-section-group'] !== undefined)
  check(
    'the right column shows the injected reply with a section for the user’s own text',
    reviewerText !== undefined &&
      reviewerSections.map((node) => node.props['data-role-section-group']).join(',') === 'fixed,template,task,fixed' &&
      textOf(reviewerText).indexOf('Profile instructions:\ngodot-reviewer') >= 0,
    reviewerSections.map((node) => node.props['data-role-section-group']).join(','),
  )
  check(
    'the section labels use user language, not implementation names',
    findAll(reviewerSections[1], (node) => node.type === 'span').some((node) => textOf(node) === '你的原文') &&
      findAll(reviewerSections[2], (node) => node.type === 'span').some((node) => textOf(node) === '任务数据') &&
      findAll(reviewerSections[3], (node) => node.type === 'span').some((node) => textOf(node) === '宿主固定'),
    reviewerSections.map((node) => textOf(node)).join(' | '),
  )

  // Save a custom profile: the template and skills go through rolesUpdate.
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.type === 'textarea' && node.props['data-field'] === 'template')[0].props.ref.current = { value: 'Review {{SPEC}} and {{SPEC}}.' }
  findAll(editor, (node) => node.props && node.props['data-field'] === 'skills')[0].props.ref.current = { value: 'dsh-plugin-workflow' }
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  const editorSave = posts[posts.length - 1]
  check(
    'saving a custom profile sends rolesUpdate with the template and skills',
    editorSave.action === 'rolesUpdate' && editorSave.name === 'godot-reviewer' && editorSave.profile.prompt === 'Review {{SPEC}} and {{SPEC}}.' && editorSave.profile.skills.join(',') === 'dsh-plugin-workflow',
    JSON.stringify(editorSave),
  )

  // Fork the bound profile, edit the draft, save it with rolesCreate. The count is
  // taken here: the fork must not add a rolesUpdate of its own.
  const sourceUpdatesBefore = posts.filter((post) => post.action === 'rolesUpdate' && post.name === 'godot-reviewer').length
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  const forkedDraft = identity.props['data-profile']
  check(
    'Fork turns the current profile into an unsaved draft',
    identity.props['data-draft'] === 'true' && forkedDraft.indexOf('godot-reviewer-fork') === 0 && textOf(editor).indexOf('草稿（Fork，未保存）') >= 0,
    JSON.stringify(identity.props),
  )
  const forkArea = findAll(editor, (node) => node.type === 'textarea' && node.props['data-field'] === 'template')[0]
  check('the fork starts from the source template', forkArea.props.defaultValue === 'Review {{SPEC}} carefully.', String(forkArea.props.defaultValue))
  forkArea.props.ref.current = { value: 'Forked {{TASK_ID}}.' }
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  const editorFork = posts[posts.length - 1]
  check(
    'saving the draft creates the forked profile and copies the profile fields',
    editorFork.action === 'rolesCreate' &&
      editorFork.name === forkedDraft &&
      editorFork.profile.role === 'reviewer' &&
      editorFork.profile.prompt === 'Forked {{TASK_ID}}.' &&
      editorFork.profile.instances === 2 &&
      editorFork.profile.context === 'fork' &&
      editorFork.profile.skills.join(',') === 'dsh-plugin-workflow',
    JSON.stringify(editorFork),
  )
  check('the fork never edits the source profile', posts.filter((post) => post.action === 'rolesUpdate' && post.name === 'godot-reviewer').length === sourceUpdatesBefore, String(posts.filter((post) => post.action === 'rolesUpdate').length))

  // The host snapshot now carries the created profile: the editor targets it.
  HOST.roles = Object.assign({}, HOST.roles, {
    profiles: Object.assign({}, HOST.roles.profiles, { [forkedDraft]: Object.assign({ name: forkedDraft }, editorFork.profile) }),
  })
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check('a successful draft save clears the draft and targets the new profile', identity.props['data-draft'] === 'false' && identity.props['data-profile'] === forkedDraft, JSON.stringify(identity.props))
  check(
    'a saved custom profile keeps its editable raw prompt and the host preview',
    findAll(editor, (node) => node.props && node.props['data-editor-nopreview'] !== undefined).length === 0 &&
      findAll(editor, (node) => node.type === 'textarea' && node.props['data-field'] === 'template').length === 1 &&
      findAll(editor, (node) => node.props && node.props['data-role-prompt'] === 'injected').length === 1,
  )

  // Apply: bind the stage, then replace the running instances of the kind.
  const beforeApply = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-apply')[0].props.onClick()
  for (let tick = 0; tick < 4; tick += 1) await flush()
  const applyPosts = posts.slice(beforeApply)
  check(
    'Apply binds the stage and then replaces the running instance',
    applyPosts.length === 2 &&
      applyPosts[0].action === 'rolesBind' &&
      applyPosts[0].stage === 'review' &&
      applyPosts[0].profile === forkedDraft &&
      applyPosts[1].action === 'rolesReplace' &&
      applyPosts[1].name === 'reviewer',
    JSON.stringify(applyPosts),
  )

  // A built-in profile cannot be edited in place: the refusal is readable and
  // no request is sent.
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const beforeRefusal = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  check('saving a built-in profile is refused with no request', posts.length === beforeRefusal, JSON.stringify(posts.slice(beforeRefusal)))
  tree = withHooks(panel, { initialView: 'roles' })
  const refusalEditor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  check('the refusal is readable in the editor', textOf(refusalEditor).indexOf('内置 profile 不能直接修改，请先 Fork 再保存') >= 0, textOf(refusalEditor).slice(0, 400))

  // Worker has no live instance in this fixture: Apply binds and says so.
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const beforeWorkerApply = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-apply')[0].props.onClick()
  for (let tick = 0; tick < 4; tick += 1) await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  check(
    'Apply without a live instance only binds the stage and explains why',
    posts.slice(beforeWorkerApply).length === 1 && posts[posts.length - 1].action === 'rolesBind' && posts[posts.length - 1].stage === 'implement' && textOf(editor).indexOf('没有在跑实例，只更新了阶段绑定。') >= 0,
    JSON.stringify(posts.slice(beforeWorkerApply)),
  )

  // Skills dialog: the catalog comes from the host, the selection is written
  // into profile.skills on the next save.
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  // Back to the reviewer tab, whose profile already uses dsh-plugin-workflow: the
  // dialog seeds its selection from profile.skills. Render the tab first so the
  // preview request it triggers consumes no mock reply meant for the dialog.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'reviewer')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  postReply = {
    ok: true,
    skills: [
      { name: 'dsh-plugin-workflow', description: 'Plugin flow', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'find-skills', description: 'Find skills', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'user-only-skill', description: 'User only', invocation: { modelInvocable: false, userInvocable: true } },
    ],
    snapshot: HOST,
  }
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-skills-manage')[0].props.onClick()
  await flush()
  check('managing skills asks the host for its catalog', posts[posts.length - 1].action === 'skillsCatalog', JSON.stringify(posts[posts.length - 1]))
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const modal = findAll(tree, (node) => node.props && node.props['data-modal'] === 'role-skills')[0]
  check('the skills dialog lists the host catalog', modal !== undefined && textOf(modal).indexOf('dsh-plugin-workflow') >= 0 && textOf(modal).indexOf('find-skills') >= 0, modal && textOf(modal))
  check(
    'a skill the model cannot invoke is marked from its invocation policy',
    findAll(modal, (node) => node.props && node.props['data-skill-user-only'] === 'user-only-skill').length === 1 &&
      textOf(modal).indexOf('仅限用户调用') >= 0 &&
      findAll(modal, (node) => node.props && node.props['data-skill-user-only'] === 'find-skills').length === 0,
    modal && textOf(modal),
  )
  const findSkillsBox = findAll(modal, (node) => node.type === 'input' && node.props['data-skill'] === 'find-skills')[0]
  check('a catalog skill the profile does not use is unchecked', findSkillsBox.props.checked === false, JSON.stringify(findSkillsBox.props))
  findSkillsBox.props.onChange()
  tree = withHooks(panel, { initialView: 'roles' })
  const modalAfter = findAll(tree, (node) => node.props && node.props['data-modal'] === 'role-skills')[0]
  check('checking a skill marks it', findAll(modalAfter, (node) => node.type === 'input' && node.props['data-skill'] === 'find-skills')[0].props.checked === true)
  const editorInModalPass = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const skillsField = findAll(editorInModalPass, (node) => node.props && node.props['data-field'] === 'skills')[0]
  // The fake React never attaches a DOM node to a ref; a real one holds the input.
  skillsField.props.ref.current = { value: 'dsh-plugin-workflow' }
  findAll(modalAfter, (node) => node.props && node.props['data-action'] === 'role-skills-save')[0].props.onClick()
  check(
    'saving the dialog writes the checked skills into the field',
    skillsField.props.ref.current !== null && skillsField.props.ref.current !== undefined && String(skillsField.props.ref.current.value).indexOf('find-skills') >= 0 && String(skillsField.props.ref.current.value).indexOf('dsh-plugin-workflow') >= 0,
    String(skillsField.props.ref.current && skillsField.props.ref.current.value),
  )
  tree = withHooks(panel, { initialView: 'roles' })
  check('the dialog closes after saving', findAll(tree, (node) => node.props && node.props['data-modal'] === 'role-skills').length === 0)

  // A host without a skills service degrades readably.
  postReply = { ok: false, code: 'skills-unavailable', message: 'no skill registry' }
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-skills-manage')[0].props.onClick()
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  const unavailableModal = findAll(tree, (node) => node.props && node.props['data-modal'] === 'role-skills')[0]
  check('an unavailable skill service is readable in the dialog', unavailableModal !== undefined && textOf(unavailableModal).indexOf('技能服务不可用（skills-unavailable）') >= 0 && textOf(unavailableModal).indexOf('no skill registry') >= 0, unavailableModal && textOf(unavailableModal))
  findAll(unavailableModal, (node) => node.props && node.props['data-action'] === 'role-skills-close')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  check('the dialog can be closed', findAll(tree, (node) => node.props && node.props['data-modal'] === 'role-skills').length === 0)
}

// ── injected preview: the chosen task drives the request, samples are marked ─
{
  let tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  let editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  const select = findAll(editor, (node) => node.type === 'select' && node.props['data-field'] === 'preview-task')[0]
  check(
    'the task dropdown offers auto plus every host task',
    select !== undefined && findAll(select, (node) => node.type === 'option').length === TASKS.length + 1 && textOf(select).indexOf('自动（最近活跃任务）') >= 0,
    select && textOf(select),
  )
  const callsBefore = PREVIEW_CALLS.length
  select.props.onChange({ target: { value: 'T-3' } })
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  check(
    'switching the task asks the host for a new preview',
    PREVIEW_CALLS.length === callsBefore + 1 && PREVIEW_CALLS[PREVIEW_CALLS.length - 1].taskId === 'T-3',
    JSON.stringify(PREVIEW_CALLS.slice(callsBefore)),
  )
  let injectedCol = findAll(editor, (node) => node.props && node.props['data-role-prompt'] === 'injected')[0]
  let source = findAll(injectedCol, (node) => node.props && node.props['data-role-task-source'] !== undefined)[0]
  check('the right column follows the chosen task', source !== undefined && source.props['data-role-task-source'] === 'real' && source.props['data-task-id'] === 'T-3' && textOf(source).indexOf('T-3 · Tail output feature') >= 0, source && textOf(source))

  // The host may answer with its built-in sample task: it must never look real.
  previewSampleNext = true
  const selectAgain = findAll(injectedCol, (node) => node.type === 'select' && node.props['data-field'] === 'preview-task')[0]
  selectAgain.props.onChange({ target: { value: 'T-4' } })
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  injectedCol = findAll(editor, (node) => node.props && node.props['data-role-prompt'] === 'injected')[0]
  source = findAll(injectedCol, (node) => node.props && node.props['data-role-task-source'] !== undefined)[0]
  check(
    'a sample task is labelled as not real',
    source !== undefined && source.props['data-role-task-source'] === 'sample' && source.props['data-task-id'] === 'T-42' && textOf(injectedCol).indexOf('示例任务（非真实，仅用于验证注入形态）') >= 0,
    source && textOf(source),
  )

  // Reset to auto so later blocks see the default identity.
  const reset = findAll(injectedCol, (node) => node.type === 'select' && node.props['data-field'] === 'preview-task')[0]
  reset.props.onChange({ target: { value: '' } })
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
}

// ── T-37 lease observability on the task card ─────────────────────────────
{
  const before = HOST.tasks
  const withLease = function (patch) {
    HOST.tasks = before.map(function (task) { return task.id === 'T-1' ? Object.assign({}, task, patch) : task })
  }
  const cardFor = function (tree) {
    return findAll(tree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card').filter((card) => textOf(card).indexOf('Build damage system') >= 0)[0]
  }
  // Inside the host reminder window: the chip warns before anything expires.
  withLease({ leaseRemaining: 8 * 60 * 1000, leaseReminder: true, leaseExpired: false })
  let tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  let chip = findAll(cardFor(tree), (node) => node.props && node.props['data-lease'] !== undefined)[0]
  check(
    'a lease close to lapsing is marked as a reminder',
    chip !== undefined && chip.props['data-lease'] === 'reminder' && chip.props['data-tone'] === 'blocked' && textOf(chip).indexOf('剩余') >= 0,
    chip && JSON.stringify({ state: chip.props['data-lease'], text: textOf(chip) }),
  )
  // A lapsed lease is visibly expired rather than silently long.
  withLease({ leaseRemaining: 0, leaseReminder: false, leaseExpired: true })
  tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  chip = findAll(cardFor(tree), (node) => node.props && node.props['data-lease'] !== undefined)[0]
  check('a lapsed lease is marked expired', chip !== undefined && chip.props['data-lease'] === 'expired' && textOf(chip).indexOf('已过期') >= 0, chip && textOf(chip))
  // A healthy lease keeps the neutral tone.
  withLease({ leaseRemaining: 55 * 60 * 1000, leaseReminder: false, leaseExpired: false })
  tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  chip = findAll(cardFor(tree), (node) => node.props && node.props['data-lease'] !== undefined)[0]
  check('a healthy lease stays neutral', chip !== undefined && chip.props['data-lease'] === 'ok' && chip.props['data-tone'] === 'waiting', chip && JSON.stringify(chip.props))
  HOST.tasks = before
}

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

// ── uncontrolled-control reuse: a reconciler-faithful harness ──────────────
// The stub above cannot see THIS class of bug: it hands a fresh ref object to
// every render and always reports defaultValue, so a stale uncontrolled control
// is invisible. This second harness models what React really does — a host node
// is REUSED while its (type, key) identity at the same position is unchanged, so
// a defaultValue is applied only on MOUNT and a user-typed value survives a
// plain re-render — and it drives a second, independent instance of the same
// bundle through a second factory call.
{
  function createReuseReact() {
    const hooks = new Map()
    const dom = new Map()
    let slot = '@'
    const seenHooks = new Set()
    const seenDom = new Set()
    const pending = []

    function childSlotOf(parentSlot, child, index) {
      const key = child !== null && typeof child === 'object' && child.props !== undefined ? child.props.key : undefined
      return parentSlot + '/' + (key === undefined || key === null ? '#' + String(index) : 'k:' + String(key))
    }

    function mountDom(nodeSlot, props) {
      seenDom.add(nodeSlot)
      const nextDefault = props.defaultValue === undefined || props.defaultValue === null ? '' : String(props.defaultValue)
      let node = dom.get(nodeSlot)
      if (node === undefined) {
        let value = nextDefault
        node = { dirty: false, checked: props.checked === true }
        Object.defineProperty(node, 'value', {
          get() { return value },
          set(updated) { value = String(updated); node.dirty = true },
          enumerable: true,
          configurable: true,
        })
        node.setClean = function (updated) { value = String(updated) }
        dom.set(nodeSlot, node)
        return node
      }
      // A matched node keeps its typed value; React only re-applies defaultValue
      // while the control is still pristine. A remount (changed key) is what
      // resets it, which is exactly the contract the editor relies on.
      if (node.dirty !== true && String(node.value) !== nextDefault) node.setClean(nextDefault)
      return node
    }

    function hookCell(init) {
      let entry = hooks.get(slot)
      if (entry === undefined) {
        entry = { list: [], index: 0 }
        hooks.set(slot, entry)
      }
      const index = entry.index
      entry.index += 1
      if (entry.list.length <= index) entry.list[index] = init()
      return { entry: entry, index: index, value: entry.list[index] }
    }

    const React = {
      createElement(type, props) {
        const merged = Object.assign({}, props)
        const children = Array.prototype.slice.call(arguments, 2)
        if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
        return { type: type, props: merged }
      },
      useState(initial) {
        const cell = hookCell(function () { return typeof initial === 'function' ? initial() : initial })
        return [cell.value, function (updated) {
          cell.entry.list[cell.index] = typeof updated === 'function' ? updated(cell.entry.list[cell.index]) : updated
        }]
      },
      useReducer(reducer, initial) {
        const cell = hookCell(function () { return initial })
        return [cell.value, function (action) {
          cell.entry.list[cell.index] = reducer(cell.entry.list[cell.index], action)
        }]
      },
      useRef(initial) { return hookCell(function () { return { current: initial } }).value },
      useEffect(fn) { hookCell(function () { return {} }); pending.push(fn) },
      useMemo(factory) { return factory() },
      useCallback(fn) { return fn },
      useSyncExternalStore(subscribe, getSnapshot) { hookCell(function () { return true }); return getSnapshot() },
      Fragment: Symbol('Fragment'),
    }

    function renderNode(node, parentSlot, index) {
      if (node === null || node === undefined || typeof node !== 'object') return node
      if (Array.isArray(node)) return node.map(function (child, childIndex) { return renderNode(child, parentSlot, childIndex) })
      if (node.type === undefined) return node
      const nodeSlot = childSlotOf(parentSlot, node, index)
      if (typeof node.type === 'function') {
        const saved = slot
        slot = nodeSlot
        seenHooks.add(nodeSlot)
        let entry = hooks.get(nodeSlot)
        if (entry === undefined) {
          entry = { list: [], index: 0 }
          hooks.set(nodeSlot, entry)
        }
        entry.index = 0
        const out = node.type(node.props)
        slot = saved
        return renderNode(out, nodeSlot, 0)
      }
      const element = { type: node.type, props: Object.assign({}, node.props) }
      if (node.type === 'input' || node.type === 'textarea' || node.type === 'select') {
        const domNode = mountDom(nodeSlot, node.props)
        if (node.props.ref !== null && node.props.ref !== undefined && typeof node.props.ref === 'object') node.props.ref.current = domNode
      }
      element.props.children = renderNode(node.props.children, nodeSlot, 0)
      return element
    }

    return {
      React: React,
      /** One render pass: reconcile, run effects, then drop unmounted state. */
      render(component, props) {
        seenHooks.clear()
        seenDom.clear()
        pending.length = 0
        slot = '@'
        const tree = renderNode({ type: component, props: props === undefined ? {} : props }, '@root', 0)
        Array.from(hooks.keys()).forEach(function (key) { if (!seenHooks.has(key)) hooks.delete(key) })
        Array.from(dom.keys()).forEach(function (key) { if (!seenDom.has(key)) dom.delete(key) })
        pending.slice().forEach(function (fn) { fn() })
        return tree
      },
    }
  }

  postReply = null
  // Deterministic profiles for this harness.
  HOST.roles = Object.assign({}, HOST.roles, {
    stages: { implement: 'worker', review: 'godot-reviewer', test: 'tester' },
    profiles: Object.assign({}, HOST.roles.profiles, {
      'godot-reviewer': Object.assign({}, HOST.roles.profiles['godot-reviewer'], { prompt: 'Reviewer template body.', skills: ['dsh-plugin-workflow'] }),
    }),
  })
  const dicts2 = {}
  const registrations2 = []
  const disposers2 = []
  const ctx2 = {
    locale: {
      register(ns, table) { dicts2[ns] = table; return function () {} },
      bind(ns) {
        const table = dicts2[ns]
        return function (key) { return table !== undefined && table.zh !== undefined && table.zh[key] !== undefined ? table.zh[key] : key }
      },
      subscribe() { return function () {} },
      getSnapshot() { return { id: 'zh' } },
    },
    slots: {
      inject(slotName, callback) { const disposer = callback(); return typeof disposer === 'function' ? disposer : function () {} },
      register(meta, component) { registrations2.push({ meta: meta, component: component }); return function () {} },
    },
    effect(callback) { const disposer = callback(); if (typeof disposer === 'function') disposers2.push(disposer); return typeof disposer === 'function' ? disposer : function () {} },
    inject() { return function () {} },
  }
  const reuse = createReuseReact()
  const plugin2 = registration.factory(function (specifier) {
    if (specifier === 'react') return reuse.React
    throw new Error('unexpected require: ' + specifier)
  })
  plugin2.apply(ctx2)
  const panel2 = registrations2.filter(function (entry) { return entry.meta.name === 'main' })[0].component

  function editorOf(tree) {
    const card = findAll(tree, function (node) { return node.props && node.props['data-card'] === 'editor' })[0]
    return card === undefined ? undefined : findAll(card, function (node) { return node.props && node.props['data-editor'] === 'true' })[0]
  }
  function fieldOf(tree, field) {
    const editor = editorOf(tree)
    return editor === undefined ? undefined : findAll(editor, function (node) { return node.props && node.props['data-field'] === field })[0]
  }
  function valueOf(node) {
    const ref = node === undefined ? undefined : node.props.ref
    return ref === null || ref === undefined || ref.current === null || ref.current === undefined ? null : String(ref.current.value)
  }
  function dirtyOf(node) {
    return node !== undefined && node.props.ref !== null && node.props.ref !== undefined && node.props.ref.current !== null && node.props.ref.current !== undefined
      ? node.props.ref.current.dirty === true
      : null
  }
  function clickAction(tree, action, attr, value) {
    const editor = editorOf(tree)
    const node = findAll(editor, function (candidate) {
      return candidate.props && candidate.props['data-action'] === action && (attr === undefined || candidate.props[attr] === value)
    })[0]
    node.props.onClick()
  }

  let rtree = reuse.render(panel2, { initialView: 'roles' })
  await flush()
  rtree = reuse.render(panel2, { initialView: 'roles' })
  check('the reuse harness renders a second, independent editor', editorOf(rtree) !== undefined)
  check(
    'the reuse harness starts on the bound worker profile with a read-only default prompt',
    editorOf(rtree).props['data-kind'] === 'worker' &&
      fieldOf(rtree, 'template') === undefined &&
      textOf(editorOf(rtree)).indexOf(WORKER_DEFAULT_PROMPT) >= 0 &&
      textOf(editorOf(rtree)).indexOf('默认角色不可修改') >= 0,
    JSON.stringify({ kind: editorOf(rtree).props['data-kind'], hasField: fieldOf(rtree, 'template') !== undefined }),
  )

  // The editable control lives on the custom reviewer profile; switching identity
  // must remount it with that profile's own text, never a stale typed value.
  clickAction(rtree, 'role-editor-kind', 'data-kind', 'reviewer')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  let area = fieldOf(rtree, 'template')
  check(
    'the reviewer profile supplies the editable raw prompt',
    area !== undefined && valueOf(area) === 'Reviewer template body.' && dirtyOf(area) === false,
    JSON.stringify({ value: valueOf(area), dirty: dirtyOf(area) }),
  )
  area.props.ref.current.value = 'stale reviewer text'
  fieldOf(rtree, 'skills').props.ref.current.value = 'stale-skills'
  check('typing marks the reused control dirty', dirtyOf(area) === true)
  clickAction(rtree, 'role-editor-kind', 'data-kind', 'tester')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  clickAction(rtree, 'role-editor-kind', 'data-kind', 'reviewer')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  area = fieldOf(rtree, 'template')
  check('the typed text never leaks onto the reviewer profile', valueOf(area) !== 'stale reviewer text', String(valueOf(area)))
  check(
    'switching back remounts the template control on the reviewer template',
    valueOf(area) === 'Reviewer template body.' && dirtyOf(area) === false,
    JSON.stringify({ value: valueOf(area), dirty: dirtyOf(area) }),
  )
  check('switching kind remounts the skills control on the reviewer skills', valueOf(fieldOf(rtree, 'skills')) === 'dsh-plugin-workflow', String(valueOf(fieldOf(rtree, 'skills'))))

  // Fork: the draft is a copy of the reviewer profile, so the control must come
  // back on the SOURCE template, not on the text just typed.
  area.props.ref.current.value = 'edited before fork'
  clickAction(rtree, 'role-editor-fork')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  area = fieldOf(rtree, 'template')
  check(
    'Fork remounts the template control on the source template',
    valueOf(area) === 'Reviewer template body.' && dirtyOf(area) === false,
    JSON.stringify({ value: valueOf(area), dirty: dirtyOf(area) }),
  )

  // Save the draft, then let the host report the created profile: a stale value
  // from before the save must not survive it.
  area.props.ref.current.value = 'forked body'
  postReply = { ok: true, config: HOST.roles, source: 'file', snapshot: HOST }
  clickAction(rtree, 'role-editor-save')
  await flush()
  const created = posts[posts.length - 1]
  check('the reuse harness saved the draft as a create', created.action === 'rolesCreate' && created.name.indexOf('godot-reviewer-fork') === 0 && created.profile.prompt === 'forked body', JSON.stringify(created))
  HOST.roles = Object.assign({}, HOST.roles, {
    profiles: Object.assign({}, HOST.roles.profiles, {
      [created.name]: { name: created.name, role: 'reviewer', stage: 'review', instances: 2, skills: ['dsh-plugin-workflow'], context: 'fork', permissions: ['read-only', 'review'], prompt: 'forked body' },
    }),
  })
  rtree = reuse.render(panel2, { initialView: 'roles' })
  await flush()
  rtree = reuse.render(panel2, { initialView: 'roles' })
  area = fieldOf(rtree, 'template')
  const reuseIdentity = findAll(editorOf(rtree), function (node) { return node.props && node.props['data-editor-identity'] === 'true' })[0]
  check('a successful draft save retargets the editor at the created profile', reuseIdentity.props['data-profile'] === created.name && reuseIdentity.props['data-draft'] === 'false', JSON.stringify(reuseIdentity.props))
  check(
    'the template control shows the saved profile after the save',
    valueOf(area) === 'forked body' && dirtyOf(area) === false,
    JSON.stringify({ value: valueOf(area), dirty: dirtyOf(area) }),
  )

  // The editor-local banner belongs to one identity: a kind switch clears it.
  const savedBanner = findAll(editorOf(rtree), function (node) { return node.props && node.props['data-role-result'] === 'ok' })[0]
  check('the real saved outcome is shown inside the editor', savedBanner !== undefined && textOf(savedBanner).indexOf('来源') >= 0, savedBanner && textOf(savedBanner))
  clickAction(rtree, 'role-editor-kind', 'data-kind', 'tester')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  check(
    'switching kind clears the previous identity banner',
    findAll(editorOf(rtree), function (node) { return node.props && node.props['data-role-result'] !== undefined }).length === 0,
    textOf(editorOf(rtree)).slice(0, 200),
  )

  // A FAILED save keeps the draft AND the values typed into it: the identity does
  // not change, so the control is not remounted and its typed text survives.
  clickAction(rtree, 'role-editor-kind', 'data-kind', 'reviewer')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  clickAction(rtree, 'role-editor-fork')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  area = fieldOf(rtree, 'template')
  area.props.ref.current.value = 'draft body kept'
  postReply = { ok: false, code: 'invalid-role-instances', message: 'instances must be an integer from 1 to 8' }
  clickAction(rtree, 'role-editor-save')
  await flush()
  rtree = reuse.render(panel2, { initialView: 'roles' })
  area = fieldOf(rtree, 'template')
  const failedIdentity = findAll(editorOf(rtree), function (node) { return node.props && node.props['data-editor-identity'] === 'true' })[0]
  check(
    'a failed save keeps the draft and its edited values',
    failedIdentity.props['data-draft'] === 'true' && valueOf(area) === 'draft body kept' && dirtyOf(area) === true,
    JSON.stringify({ draft: failedIdentity.props['data-draft'], value: valueOf(area), dirty: dirtyOf(area) }),
  )
  check('a failed save is readable in the editor', textOf(editorOf(rtree)).indexOf('实例数必须是 1–8 的整数') >= 0, textOf(editorOf(rtree)).slice(0, 240))
  postReply = null

  disposers2.slice().reverse().forEach(function (disposer) { disposer() })
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