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
STORAGE.set('godotBridge.taskCenter.project', 'v2:' + PROJECT)
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
// T-99: the fake Host shell. `hostServices` is what ctx.get(name) answers, so a
// test can decide whether the panel sees the shell's real session or nothing at
// all; `injectCalls` records the optional inject(cb) wiring a live shell runs.
let hostServices = {}
const injectCalls = []
const ctx = {
  get(name) {
    return hostServices[name]
  },
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
  inject(deps, callback) {
    if (typeof callback !== 'function') return () => {}
    const list = Array.isArray(deps) ? deps : []
    injectCalls.push({ deps: list, callback })
    // A live shell runs the callback once its services are mounted, handing it a
    // context where the injected services are properties.
    if (list.every((dep) => hostServices[dep] !== undefined)) runInjected({ deps: list, callback })
    return () => {}
  },
}

/** Run one recorded inject() as the live shell would: deps as ctx properties. */
function runInjected(entry) {
  const scoped = Object.create(ctx)
  entry.deps.forEach((dep) => {
    scoped[dep] = hostServices[dep]
  })
  entry.callback(scoped)
}
/** Replay every recorded inject() whose services the test now provides. */
function replayInjects() {
  injectCalls.forEach((entry) => {
    if (entry.deps.every((dep) => hostServices[dep] !== undefined)) runInjected(entry)
  })
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
check('label follows the locale', glyph.meta.label() === 'GodotBridge 任务中心', glyph.meta.label())
locale = 'en'
check('label follows an English switch', glyph.meta.label() === 'GodotBridge Task Center', glyph.meta.label())
locale = 'zh'
{
  const glyphEntry = registrations.filter((entry) => entry.meta.name === 'sidebar.panellist')[0]
  const glyphTree = glyphEntry !== undefined && typeof glyphEntry.component === 'function' ? glyphEntry.component({ size: 18 }) : null
  check(
    'the sidebar glyph is the locale-independent shot target (data-panel on the glyph)',
    glyphTree !== null &&
      glyphTree.type === 'span' &&
      glyphTree.props['data-panel'] === 'task-center' &&
      findAll(glyphTree, (node) => node.type === 'svg' && node.props && node.props.className === 'gbt-glyph').length === 1,
    glyphTree === null ? 'missing glyph component' : JSON.stringify(glyphTree.props),
  )
}

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
  // The host's real groups: role / template / task / fixed / skills.
  // The real host shape: header+meta+（reviewer/tester 的 fresh-context）all in
  // the ROLE group, then template, task, fixed and skills. The extra role parts
  // must still produce exactly ONE 角色与阶段 label.
  const sections = [
    { key: 'header', group: 'role', text: 'Task center role: ' + kind + '\nProject: ' + PROJECT },
    { key: 'meta', group: 'role', text: 'Profile permissions: read-only, review' },
    { key: 'fresh-context', group: 'role', text: 'You are an independent, FRESH context.' },
    { key: 'template', group: 'template', text: 'Profile instructions:\n' + (typeof body.profile === 'string' && body.profile !== '' ? body.profile : kind) },
    { key: 'task', group: 'task', text: 'Task ' + task.id + ': ' + task.title },
    { key: 'fixed', group: 'fixed', text: 'Duties: permission boundary.\nVerdict schema: task_center submit.' },
    { key: 'skills', group: 'skills', text: 'Load these skills before starting.' },
  ]
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
// The host ships built-in prompts for worker/reviewer/tester; the panel shows
// them read-only and copies them into an editable draft on demand.
const WORKER_DEFAULT_PROMPT = 'Implement the task in its worktree and prove it there.'
const REVIEWER_DEFAULT_PROMPT = 'Review the submitted tree; approve it or request concrete changes.'
const TESTER_DEFAULT_PROMPT = 'Test the candidate against the acceptance criteria; record pass or fail with evidence.'
const HOST = {
  ok: true,
  project: PROJECT,
  // T-90: the Host answers with the project REF and where it came from. The
  // browser fixture pins PROJECT, so the Host reports it as a panel binding.
  projectRoot: PROJECT,
  resolvedFrom: 'panel',
  sessionProject: PROJECT,
  // T-108: the main-checkout cleanliness the panel shows beside dispatch.
  environment: {
    clean: true,
    code: null,
    message: null,
    checkedAt: new Date(now).toISOString(),
    transient: false,
    retrying: [],
    escalated: [],
    dirty: [],
  },
  registryConsistent: true,
  projectWarning: null,
  // T-93: how full the board file is. 'ok' by default; the status page warns at
  // 50%/75% of the cap.
  boardSize: { bytes: 1024 * 1024, limit: 32 * 1024 * 1024, percent: 3.1, level: 'ok', cards: 8, bytesPerCard: 131072, headroomCards: 248, warning: null },
  version: 2,
  seq: 8,
  updatedAt: new Date(now).toISOString(),
  dispatch: { state: 'paused', maxConcurrent: 3, allowSpawn: true, maxWorkAgents: 4, maxAttempts: 3, request: { id: 'R-1', by: '@lead', at: new Date(now - 30000).toISOString(), note: 'deps are ready' } },
  counts: { total: 8, pending: 2, ready: 1, running: 1, reviewing: 1, testing: 1, done: 1, blocked: 1, cancelled: 1 },
  queue: [],
  tasks: TASKS,
  workers: {
    lead: 'lead',
    leadInfo: { id: 'session-eb9ba775-c7e9-4c02-a02c-e207590f5f1c', name: 'session-eb9ba775-c7e9-4c02-a02c-e207590f5f1c', kind: 'lead', session: 'session-eb9ba775-c7e9-4c02-a02c-e207590f5f1c' },
    session: 'session-eb9ba775-c7e9-4c02-a02c-e207590f5f1c',
    project: PROJECT,
    projectMatch: true,
    workerCap: 3,
    members: [
      { id: 'session-fixer', name: 'fixer', kind: 'worker', status: 'running', queue: 1, currentTask: { id: 'T-1', title: 'Build damage system' } },
      { id: 'session-tester', name: 'tester', kind: 'tester', status: 'idle', queue: 0, currentTask: null },
      { id: 'session-builder', name: 'builder', kind: 'worker', status: 'provisioning', queue: 0, currentTask: null },
      { id: 'session-ghost', name: 'ghost', kind: 'worker', status: 'failed', queue: 0, currentTask: null },
      { id: 'session-reviewer-1', name: 'reviewer-1', kind: 'reviewer', status: 'idle', queue: 2, currentTask: null },
    ],
    busy: 1,
    idle: 2,
    provisioning: 1,
    failed: 1,
    cap: 4,
    error: null,
    // T-127: per-role numbers and the running-without-card state.
    roleCounts: {
      worker: { running: 1, idle: 0, busy: 1 },
      reviewer: { running: 0, idle: 1, busy: 0 },
      tester: { running: 0, idle: 1, busy: 0 },
    },
  },
  // T-122: the session's own team is the member-table source.
  team: {
    ok: true,
    available: true,
    // A real host names the lead agent after its session, so the header must
    // never print this value verbatim (H7 / T-137).
    lead: 'session-eb9ba775-c7e9-4c02-a02c-e207590f5f1c',
    leadId: 'session-eb9ba775-c7e9-4c02-a02c-e207590f5f1c',
    members: [
      { id: 'session-fixer', name: 'fixer', role: 'teammate', kind: 'worker', description: 'feature worker', session: 'session-fixer', status: 'running', currentTask: { id: 'T-1', title: 'Build damage system' } },
      { id: 'session-reviewer-1', name: 'reviewer-1', role: 'teammate', kind: 'reviewer', description: 'review role', session: 'session-reviewer-1', status: 'inactive', currentTask: null },
      { id: 'session-tester-1', name: 'tester-1', role: 'teammate', kind: 'tester', description: 'test role', session: 'session-tester-1', status: 'idle', currentTask: null },
    ],
  },
  // Host-wide inventory: one leftover slot from another project/session.
  teams: {
    available: true,
    members: [
      { name: 'foreign-reviewer', role: 'teammate', project: 'deadbeef', projectRoot: 'J:\\workspace\\component_tool', matchesSession: false },
    ],
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
      worker: { name: 'worker', role: 'worker', stage: 'implement', skills: [], context: 'fresh', permissions: [], prompt: WORKER_DEFAULT_PROMPT },
      reviewer: { name: 'reviewer', role: 'reviewer', stage: 'review', skills: [], context: 'fresh', permissions: [], prompt: REVIEWER_DEFAULT_PROMPT },
      tester: { name: 'tester', role: 'tester', stage: 'test', skills: [], context: 'fresh', permissions: [], prompt: TESTER_DEFAULT_PROMPT },
      'godot-reviewer': { name: 'godot-reviewer', role: 'reviewer', stage: 'review', skills: ['dsh-plugin-workflow'], context: 'fork', permissions: ['read-only', 'review'], prompt: 'Check Godot idioms.' },
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
      // A single reply object, or a queue for actions that send more than one
      // request (e.g. save = rolesUpdate + rolesReplace).
      const reply = Array.isArray(postReply) ? postReply.shift() : postReply
      postReply = Array.isArray(postReply) && postReply.length > 0 ? postReply : null
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
check('the workers view renders one row per member', workerRows.length === 5, String(workerRows.length))
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
check('a pool without a lead explains the empty state', noTeamText.indexOf('本会话没有团队') >= 0 && noTeamText.indexOf('bootstrapTeam') >= 0, noTeamText)
check('a known pool error code is explained, not dumped', noTeamText.indexOf('执行者池不可读: 没有活着的 Team Lead (no-lead)') >= 0, noTeamText)
check('an empty team says it has no WorkAgent', noTeamText.indexOf('bootstrapTeam') >= 0 && noTeamText.indexOf('还没有成员') >= 0, noTeamText)

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


// ── T-137: the executors page is three explicit layers ────────────────────
{
  let tree = withHooks(panel, { initialView: 'workers' })
  await flush()
  tree = withHooks(panel, { initialView: 'workers' })
  const text = textOf(tree)
  const head = findAll(tree, (node) => node.props && node.props['data-worker-head'] === 'true')[0]
  const identity = findAll(tree, (node) => node.props && node.props['data-worker-identity'] === 'true')[0]
  check(
    'T-137 the head shows project, session team and a short session id',
    head !== undefined &&
      identity !== undefined &&
      text.indexOf('面板项目') >= 0 &&
      text.indexOf('会话 Team') >= 0 &&
      text.indexOf('Team Lead') >= 0 &&
      text.indexOf('eb9ba775') >= 0,
    text.slice(0, 300),
  )
  check(
    'T-137 the raw session id is never a direct text node (title/copy only)',
    text.indexOf('session-eb9ba775-c7e9') < 0 &&
      findAll(tree, (node) => node.type === 'button' && node.props['data-action'] === 'copy-session' && node.props['data-session'] === 'session-eb9ba775-c7e9-4c02-a02c-e207590f5f1c').length === 1,
    JSON.stringify({ hasFull: text.indexOf('session-eb9ba775-c7e9') >= 0 }),
  )
  const teamLine = findAll(tree, (node) => node.props && node.props['data-project-team'] !== undefined)[0]
  check(
    'T-137 the global project-team header hides the raw session id too (H7)',
    teamLine !== undefined &&
      textOf(teamLine).indexOf('本会话 Lead') >= 0 &&
      textOf(teamLine).indexOf('eb9ba775') >= 0 &&
      textOf(teamLine).indexOf('session-eb9ba775') < 0 &&
      String(teamLine.props.title).indexOf('session-eb9ba775-c7e9-4c02-a02c-e207590f5f1c') >= 0,
    teamLine && textOf(teamLine) + ' | title=' + String(teamLine.props.title),
  )
  const chips = findAll(tree, (node) => node.props && node.props['data-worker-chip'] !== undefined)
  const chipText = (key) => textOf(chips.filter((chip) => chip.props['data-worker-chip'] === key)[0])
  check(
    'T-137 the head chips carry REAL values: 并发 from dispatch.maxConcurrent, 上限 from workers.cap (not the derived workerCap)',
    chips.map((chip) => chip.props['data-worker-chip']).join(',') === 'concurrent,cap,busy,idle,provisioning,failed' &&
      HOST.dispatch.maxConcurrent === 3 &&
      HOST.workers.workerCap === 3 &&
      HOST.workers.cap === 4 &&
      chipText('concurrent') === '并发3' &&
      chipText('cap') === '上限4' &&
      chipText('busy') === '执行中1' &&
      chipText('idle') === '空闲2' &&
      chipText('provisioning') === '启动中1' &&
      chipText('failed') === '失败1',
    JSON.stringify(chips.map((chip) => [chip.props['data-worker-chip'], textOf(chip)])),
  )
  const cards = findAll(tree, (node) => node.props && node.props['data-role-card'] !== undefined)
  check(
    'T-137 the role overview is three compact cards with live numbers only',
    cards.map((card) => card.props['data-role-card']).join(',') === 'worker,reviewer,tester' &&
      cards.every((card) => findAll(card, (node) => node.props && node.props['data-role-metric'] !== undefined).length === 4) &&
      cards.map((card) => textOf(card)).join(' ').indexOf('配置') < 0,
    JSON.stringify(cards.map((card) => textOf(card))),
  )
  check('T-137 role cards no longer say “已配置” or “实例” (size is a dispatch setting)', text.indexOf('已配置') < 0 && text.indexOf('实例') < 0, text.slice(0, 300))
  const table = findAll(tree, (node) => node.props && node.props['data-worker-table'] === 'true')[0]
  const header = findAll(table, (node) => node.type === 'th').map((cell) => textOf(cell))
  check('T-137 the member table is role / member / status / current task / queue', header.join(',') === '角色,成员,状态,当前任务,队列', JSON.stringify(header))
  const rows = findAll(table, (node) => node.type === 'tr' && node.props && node.props['data-worker'] !== undefined)
  check('T-137 members are grouped by role order (worker, reviewer, tester)', rows.map((row) => row.props['data-kind']).join(',') === 'worker,worker,worker,reviewer,tester', JSON.stringify(rows.map((row) => row.props['data-kind'])))
  const rowOf = (name) => rows.filter((row) => row.props['data-worker'] === name)[0]
  const fixer = rowOf('fixer')
  const tester = rowOf('tester')
  const reviewer = rowOf('reviewer-1')
  check(
    'T-137 a member row carries its role badge, name, status, card and queue',
    fixer !== undefined &&
      textOf(fixer).indexOf('实现') >= 0 &&
      textOf(fixer).indexOf('T-1 · Build damage system') >= 0 &&
      textOf(fixer).indexOf('执行中') >= 0 &&
      textOf(findAll(fixer, (node) => node.props && node.props['data-col'] === 'worker-queue')[0]) === '1',
    fixer && textOf(fixer),
  )
  check(
    'T-137 reviewer and tester badges follow member.kind',
    reviewer !== undefined && tester !== undefined && textOf(reviewer).indexOf('评审') >= 0 && textOf(tester).indexOf('测试') >= 0,
    JSON.stringify([reviewer && textOf(reviewer), tester && textOf(tester)]),
  )
  check(
    'T-137 an idle member says 待命 once, not the long process sentence',
    tester !== undefined && textOf(tester).indexOf('待命') >= 0 && text.indexOf('待命（进程在运行，没有分配任务）') < 0,
    tester && textOf(tester),
  )
  check(
    'T-137 the queue column shows the count or an em dash',
    textOf(findAll(reviewer, (node) => node.props && node.props['data-col'] === 'worker-queue')[0]) === '2' &&
      textOf(findAll(tester, (node) => node.props && node.props['data-col'] === 'worker-queue')[0]) === '—',
  )
  // A session-named lead renders as 本会话 Lead instead of the raw id.
  const savedLead = HOST.workers.lead
  HOST.workers.lead = 'session-eb9ba775-c7e9-4c02-a02c-e207590f5f1c'
  let namedTree = withHooks(panel, { initialView: 'workers' })
  await flush()
  namedTree = withHooks(panel, { initialView: 'workers' })
  check('T-137 a session-named lead renders as 本会话 Lead with a short id', textOf(namedTree).indexOf('本会话 Lead') >= 0 && textOf(namedTree).indexOf('eb9ba775') >= 0, textOf(namedTree).slice(0, 200))
  HOST.workers.lead = savedLead
  // Project mismatch is explicit, never silent.
  const savedProject = HOST.workers.project
  HOST.workers.project = PROJECT + '\\beta-project'
  HOST.workers.projectMatch = false
  let mismatchTree = withHooks(panel, { initialView: 'workers' })
  await flush()
  mismatchTree = withHooks(panel, { initialView: 'workers' })
  const mismatch = findAll(mismatchTree, (node) => node.props && node.props['data-worker-mismatch'] === 'true')[0]
  check(
    'T-137 a session team from another project shows a mismatch warning',
    mismatch !== undefined && mismatch.props['data-tone'] === 'warn' && textOf(mismatch).indexOf('不是面板项目') >= 0 && textOf(mismatch).indexOf('beta-project') >= 0,
    mismatch && textOf(mismatch),
  )
  HOST.workers.project = savedProject
  HOST.workers.projectMatch = true
  await flush()
  const css = styleTags.map((tag) => String(tag.textContent || '')).join('\n')
  check(
    'T-137 the layout is responsive and token-only',
    css.indexOf('.gbt-rolecards') >= 0 && css.indexOf('repeat(auto-fit,minmax(') >= 0 && css.indexOf('.gbt-tablewrap') >= 0 && css.indexOf('overflow-x:auto') >= 0 && css.indexOf('.gbt-workertable{min-width:560px}') >= 0 && css.indexOf('.gbt-workercard{') >= 0,
    css.slice(0, 160),
  )
  const workerRules = ['.gbt-workerhead', '.gbt-rolecards', '.gbt-workercard', '.gbt-workertable', '.gbt-workername'].map(function (selector) {
    const match = new RegExp(selector.replace(/\./g, '\\.') + '\\{[^}]*\\}').exec(css)
    return match === null ? null : match[0]
  })
  check(
    'T-137 the new executors styles use only T-133 tokens (no hardcoded colour)',
    workerRules.every(function (body) { return body !== null && body.indexOf('#') < 0 && body.indexOf('rgba(') < 0 }),
    JSON.stringify(workerRules),
  )
  withHooks(panel, { initialView: 'workers' })
}
// ── Status view: one summary line, three cards, a full-width activity card ─
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
  const cardsRoot = findAll(statusTree, (node) => node.props && node.props['data-status'] === 'cards')[0]
  const statusCards = findAll(statusTree, (node) => node.props && node.props['data-status-card'] !== undefined)
  check(
    'the status page is a summary line plus three narrow cards and one full-width activity card',
    cardsRoot !== undefined &&
      statusCards.map((card) => card.props['data-status-card']).join(',') === 'dispatch,worktrees,agents,activity' &&
      findAll(statusTree, (node) => node.props && node.props['data-status-grid'] === 'true').length === 1 &&
      findAll(statusTree, (node) => node.props && node.props['data-status-top'] === 'true').length === 1,
    JSON.stringify(statusCards.map((card) => card.props['data-status-card'])),
  )
  const statusRoot = findAll(statusTree, (node) => node.props && node.props['data-status'] === 'cards')[0]
  check(
    'the page header keeps only the last-activity line and refresh (the panel already has the paused line and start button)',
    statusRoot !== undefined &&
      textOf(statusRoot).indexOf('最近活动') >= 0 &&
      findAll(statusRoot, (node) => node.type === 'button' && textOf(node).indexOf('开始派发') >= 0).length === 0 &&
      findAll(statusRoot, (node) => node.type === 'button' && textOf(node).indexOf('暂停派发') >= 0).length === 0 &&
      findAll(statusRoot, (node) => node.props && node.props['data-action'] === 'status-refresh').length === 1,
    statusRoot && textOf(statusRoot).slice(0, 200),
  )
  check(
    'the old counter strips and bare tables are gone',
    findAll(statusTree, (node) => node.props && ['agents', 'agent-kinds', 'role-instances', 'worktrees', 'activity', 'counters'].indexOf(node.props['data-section']) >= 0).length === 0 &&
      findAll(statusTree, (node) => node.type === 'tr' && node.props && (node.props['data-worktree'] !== undefined || node.props['data-activity'] !== undefined)).length === 0 &&
      statusText.indexOf('会话跳转 API') < 0,
    statusText.slice(0, 300),
  )
  const viewButtons = findAll(statusTree, (node) => node.type === 'button' && node.props && node.props['data-view'] !== undefined)
  check(
    'the five view tabs carry labels only, with no count suffixes',
    viewButtons.length === 5 && viewButtons.every((node) => textOf(node).indexOf(' · ') < 0 && textOf(node).indexOf('·') < 0),
    JSON.stringify(viewButtons.map((node) => textOf(node))),
  )
  const dispatchCard = statusCards.filter((card) => card.props['data-status-card'] === 'dispatch')[0]
  check(
    'the dispatch card shows concurrency, ready and queue plus a why-not-running reason',
    dispatchCard !== undefined &&
      textOf(dispatchCard).indexOf('1/ 3 并发') >= 0 &&
      textOf(dispatchCard).indexOf('1就绪') >= 0 &&
      findAll(dispatchCard, (node) => node.props && node.props['data-status-why'] === 'true').length === 1 &&
      textOf(dispatchCard).indexOf('派发已暂停') >= 0 &&
      textOf(dispatchCard).indexOf('上次扫描') >= 0 &&
      textOf(dispatchCard).indexOf('合并队列') >= 0,
    dispatchCard && textOf(dispatchCard),
  )
  const worktreesCard = statusCards.filter((card) => card.props['data-status-card'] === 'worktrees')[0]
  const activeWtRows = findAll(worktreesCard, (node) => node.props && node.props['data-worktree-row'] !== undefined)
  check(
    'the worktrees card lists the main checkout and the active task worktrees only',
    activeWtRows.length === 3 && activeWtRows[0].props['data-worktree-row'] === 'main' && textOf(worktreesCard).indexOf('T-1') >= 0 && textOf(worktreesCard).indexOf('T-4') >= 0,
    JSON.stringify(activeWtRows.map((row) => row.props['data-worktree-row'])),
  )
  const staleFold = findAll(worktreesCard, (node) => node.props && node.props['data-status-stale'] !== undefined)[0]
  check(
    'stale worktrees are folded into one counted line with no cleanup button',
    staleFold !== undefined && staleFold.props['data-status-stale'] === '1' && textOf(staleFold).indexOf('1 个陈旧工作树') >= 0 && textOf(staleFold).indexOf('清理能力尚未提供') >= 0 && findAll(staleFold, (node) => node.type === 'button').length === 0,
    staleFold && textOf(staleFold),
  )
  const agentsCard = statusCards.filter((card) => card.props['data-status-card'] === 'agents')[0]
  const agentRows = findAll(agentsCard, (node) => node.props && node.props['data-status-agent'] !== undefined)
  check('the agents card lists the lead and every teammate once', agentRows.length === 4, String(agentRows.length))
  const leftoverRow = findAll(agentsCard, (node) => node.props && node.props['data-leftover-role'] !== undefined)[0]
  check(
    'T-122 a foreign role instance renders as a leftover row, independent of the member rows',
    leftoverRow !== undefined && textOf(leftoverRow).indexOf('遗留实例（来自 component_tool）') >= 0,
    leftoverRow === undefined ? 'no leftover row' : textOf(leftoverRow),
  )
  const savedTeamsView = HOST.teams
  HOST.teams = { available: true, members: [{ name: 'null-slot', role: 'teammate', project: 'abc', projectRoot: null, matchesSession: null }] }
  let nullMatchTree = withHooks(panel, { initialView: 'status' })
  findButton(nullMatchTree, '刷新').props.onClick()
  await flush()
  nullMatchTree = withHooks(panel, { initialView: 'status' })
  check(
    'T-124 a null matchesSession does NOT render a leftover row',
    findAll(nullMatchTree, (node) => node.props && node.props['data-leftover-role'] !== undefined).length === 0,
    textOf(nullMatchTree).slice(0, 300),
  )
  HOST.teams = savedTeamsView
  check(
    'T-122 the member table does not list the other team’s member',
    agentRows.every((row) => row.props['data-status-agent'] !== 'foreign-reviewer'),
    JSON.stringify(agentRows.map((row) => row.props['data-status-agent'])),
  )
  const fixerRow = agentRows.filter((row) => row.props['data-status-agent'] === 'fixer')[0]
  check(
    'an agent row carries the name, role and current task',
    fixerRow !== undefined && textOf(fixerRow).indexOf('fixer') >= 0 && textOf(fixerRow).indexOf('实现') >= 0 && textOf(fixerRow).indexOf('T-1') >= 0,
    fixerRow && textOf(fixerRow),
  )
  const leadRow = agentRows.filter((row) => row.props['data-status-agent'] === 'lead')[0]
  check(
    'the lead row shows the description as its last result and no task status',
    leadRow !== undefined && textOf(leadRow).indexOf('Team') >= 0 && textOf(leadRow).indexOf('—') >= 0,
    leadRow && textOf(leadRow),
  )
  const reviewerAgentRow = agentRows.filter((row) => row.props['data-status-agent'] === 'reviewer-1')[0]
  check(
    'an idle agent shows 空闲 with the minutes since its newest activity',
    reviewerAgentRow !== undefined && textOf(reviewerAgentRow).indexOf('空闲') >= 0 && textOf(reviewerAgentRow).indexOf('分钟') >= 0,
    reviewerAgentRow && textOf(reviewerAgentRow),
  )
  check(
    'session ids are not printed in the agent rows until the menu is opened',
    agentRows.every((row) => textOf(row).indexOf('session-') < 0) && textOf(agentsCard).indexOf('session-') < 0,
    textOf(agentsCard),
  )
  const sessionToggle = findAll(fixerRow, (node) => node.props && node.props['data-action'] === 'status-session')[0]
  sessionToggle.props.onClick()
  await flush()
  statusTree = withHooks(panel, { initialView: 'status' })
  const reopenedAgents = findAll(statusTree, (node) => node.props && node.props['data-status-card'] === 'agents')[0]
  const sessionRow = findAll(reopenedAgents, (node) => node.props && node.props['data-status-session'] === 'fixer')[0]
  check(
    'the ⋯ menu reveals the session id with a copy control',
    sessionRow !== undefined && textOf(sessionRow).indexOf('session-fixer') >= 0 && findAll(sessionRow, (node) => node.props && node.props['data-action'] === 'copy-session').length === 1,
    sessionRow && textOf(sessionRow),
  )
  const copyButton = findAll(sessionRow, (node) => node.props && node.props['data-action'] === 'copy-session')[0]
  copyButton.props.onClick()
  await flush()
  check('copying puts the session id on the clipboard', copied === 'session-fixer', String(copied))

  // T-111: the summary tasks carry NO history (the payload that used to show
  // only merges); the Host's derived timeline is what the card renders.
  const savedTasks = HOST.tasks
  const savedTimeline = HOST.activityEvents
  HOST.tasks = HOST.tasks.map((entry) => Object.assign({}, entry, { history: undefined }))
  const timelineTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
  HOST.activityEvents = {
    available: true,
    source: 'board',
    limit: 50,
    perTask: 3,
    since: null,
    count: 3,
    total: 3,
    truncated: false,
    cursor: 'cursor-1',
    entries: [
      { key: 'T-3@2026-01-01T00:00:03.000Z@merge', at: new Date(now - 3000).toISOString(), kind: 'merge', taskId: 'T-3', from: null, to: 'merged', by: null, byName: 'reviewer-1', target: 'feat/task-center-v2', detail: null, eventRound: 1, sha: 'fedcba0' },
      { key: 'T-1@2026-01-01T00:00:05.000Z@review-pass', at: new Date(now - 5000).toISOString(), kind: 'review-pass', taskId: 'T-1', from: 'reviewing', to: 'testing', by: 'reviewer-1', byName: 'reviewer-1', detail: null, eventRound: 1, sha: null },
      { key: 'T-1@2026-01-01T00:00:07.000Z@test-pass', at: new Date(now - 7000).toISOString(), kind: 'test-pass', taskId: 'T-1', from: 'testing', to: 'testing', by: 'tester-1', byName: 'tester-1', detail: 'tests passed; waiting for the merge', eventRound: 1, sha: null },
    ],
  }
  let timelineTree = withHooks(panel, { initialView: 'status' })
  await flush()
  timelineTree = withHooks(panel, { initialView: 'status' })
  const timelineCard = findAll(timelineTree, (node) => node.props && node.props['data-status-card'] === 'activity')[0]
  const timelineKinds = findAll(timelineCard, (node) => node.props && node.props['data-activity-kind'] !== undefined).map((row) => row.props['data-activity-kind'])
  check(
    'T-111 summary tasks without history still render review/test events from the Host timeline',
    timelineTask !== undefined &&
      timelineTask.history === undefined &&
      timelineKinds.length === 3 &&
      timelineKinds.indexOf('review-pass') >= 0 &&
      timelineKinds.indexOf('test-pass') >= 0 &&
      timelineKinds.indexOf('merge') >= 0,
    JSON.stringify(timelineKinds),
  )
  const derivedMergeRow = findAll(timelineCard, (node) => node.props && node.props['data-activity-kind'] === 'merge')[0]
  const derivedMergeText = derivedMergeRow === undefined ? '' : textOf(derivedMergeRow)
  check(
    'T-111 the derived merge row names the subject, the target branch and the merge commit (localized, no raw note)',
    derivedMergeText.indexOf('T-3 · Tail output feature') >= 0 &&
      derivedMergeText.indexOf('feat/task-center-v2') >= 0 &&
      derivedMergeText.indexOf('fedcba0') >= 0 &&
      derivedMergeText.indexOf('merged into') < 0,
    derivedMergeText,
  )
  HOST.tasks = savedTasks
  HOST.activityEvents = savedTimeline

  const activityCard = statusCards.filter((card) => card.props['data-status-card'] === 'activity')[0]
  check('real activity events render as rows', findAll(activityCard, (node) => node.props && node.props['data-activity-kind'] !== undefined).length === 3, textOf(activityCard))

  // T-111: a heartbeat is telemetry, so it can never displace a real event.
  const savedSweep = HOST.lastSweep
  HOST.lastSweep = { at: new Date(now - 1000).toISOString(), merged: 2, skipped: 1 }
  let sweepTree = withHooks(panel, { initialView: 'status' })
  await flush()
  sweepTree = withHooks(panel, { initialView: 'status' })
  const sweepActivity = findAll(sweepTree, (node) => node.props && node.props['data-status-card'] === 'activity')[0]
  const sweepFold = findAll(sweepActivity, (node) => node.props && node.props['data-action'] === 'status-show-all')[0]
  check(
    'T-111 heartbeats are telemetry: folded into one line and never a stream row',
    findAll(sweepActivity, (node) => node.props && node.props['data-activity-kind'] === 'sweep').length === 0 &&
      findAll(sweepActivity, (node) => node.props && node.props['data-activity-kind'] !== undefined).length === 3 &&
      sweepFold !== undefined &&
      textOf(sweepActivity).indexOf('心跳已折叠') >= 0 &&
      textOf(sweepActivity).indexOf('merged 2') >= 0,
    textOf(sweepActivity).slice(0, 300),
  )
  sweepFold.props.onClick()
  await flush()
  sweepTree = withHooks(panel, { initialView: 'status' })
  const shownActivity = findAll(sweepTree, (node) => node.props && node.props['data-status-card'] === 'activity')[0]
  check(
    'the show-all toggle reveals the sweep telemetry row',
    findAll(shownActivity, (node) => node.props && node.props['data-activity-kind'] === 'sweep').length === 1 &&
      findAll(shownActivity, (node) => node.props && node.props['data-activity-kind'] !== undefined).length === 4 &&
      textOf(shownActivity).indexOf('仅真实事件') >= 0 &&
      textOf(shownActivity).indexOf('心跳已显示') >= 0 &&
      textOf(shownActivity).indexOf('心跳已折叠') < 0,
    textOf(shownActivity).slice(0, 300),
  )
  HOST.lastSweep = savedSweep


  // ── T-113: the user records review/test verdicts from the card ─────────────
  {
    const reviewCard = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const testCard = HOST.tasks.filter((entry) => entry.id === 'T-2')[0]
    const savedStatuses = { review: reviewCard.status, test: testCard.status }
    reviewCard.status = 'reviewing'
    testCard.status = 'testing'
    const postCountBefore = posts.length
    let verdictTree = withHooks(panel, { initialView: 'board' })
    await flush()
    verdictTree = withHooks(panel, { initialView: 'board' })
    const bars = findAll(verdictTree, (node) => node.props && node.props['data-verdict-phase'] !== undefined)
    const reviewBar = bars.filter((bar) => bar.props['data-verdict-phase'] === 'review')[0]
    const testBar = bars.filter((bar) => bar.props['data-verdict-phase'] === 'test')[0]
    const verdictTasks = HOST.tasks.filter((entry) => entry.status === 'reviewing' || entry.status === 'testing')
    const verdictCards = verdictTasks.map((entry) => findAll(verdictTree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card' && textOf(node).indexOf(entry.title) >= 0)[0])
    check(
      'T-113 reviewing and testing cards offer the user verdict buttons (and no other card does)',
      bars.length === verdictTasks.length &&
        verdictCards.every((card) => card !== undefined && findAll(card, (node) => node.props && node.props['data-verdict-phase'] !== undefined).length === 1) &&
        reviewBar !== undefined &&
        testBar !== undefined &&
        textOf(reviewBar).indexOf('通过评审') >= 0 &&
        textOf(reviewBar).indexOf('打回评审') >= 0 &&
        textOf(testBar).indexOf('通过测试') >= 0 &&
        textOf(testBar).indexOf('测试失败') >= 0,
      JSON.stringify({ bars: bars.length, review: reviewBar && textOf(reviewBar), test: testBar && textOf(testBar) }),
    )
    const blockingButtons = findAll(reviewBar, (node) => node.props && node.props['data-verdict-needs-reason'] !== undefined).concat(
      findAll(testBar, (node) => node.props && node.props['data-verdict-needs-reason'] !== undefined),
    )
    check(
      'T-113 reject and fail are marked as needing a reason',
      blockingButtons.length === 2 && blockingButtons.every((button) => button.props['data-verdict-needs-reason'] === 'true'),
      JSON.stringify(blockingButtons.map((button) => button.props['data-verdict-action'])),
    )
    // Approving is the direct path: it posts through the same /action route.
    const approve = findAll(reviewBar, (node) => node.props && node.props['data-verdict-action'] === 'approveReview')[0]
    approve.props.onClick()
    await flush()
    check(
      'T-113 approving the review posts approveReview for that task',
      posts.slice(postCountBefore).some((body) => body.action === 'approveReview' && body.id === 'T-1'),
      JSON.stringify(posts.slice(postCountBefore).map((body) => body.action)),
    )
    // Rejecting does NOT post until a reason is provided (the form appears first).
    const reject = findAll(reviewBar, (node) => node.props && node.props['data-verdict-action'] === 'requestChanges')[0]
    reject.props.onClick()
    await flush()
    check(
      'T-113 rejecting never posts without a reason',
      posts.slice(postCountBefore).every((body) => body.action !== 'requestChanges'),
      JSON.stringify(posts.slice(postCountBefore).map((body) => body.action)),
    )
    reviewCard.status = savedStatuses.review
    testCard.status = savedStatuses.test
  }

  // ── activity stream: localized phase events, no raw English notes or @ids ──
  {
    const streamTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const savedStreamHistory = streamTask.history
    streamTask.history = [
      { from: null, to: 'pending', at: new Date(Date.now() - 60000).toISOString(), by: '@session-lead', note: 'created by lead' },
      { from: 'pending', to: 'running', at: new Date(Date.now() - 50000).toISOString(), by: '@session-lead', note: 'dispatched to fixer' },
      { from: 'running', to: 'reviewing', at: new Date(Date.now() - 40000).toISOString(), by: '@session-fixer', note: 'submitted for review round 1 @f158b35c' },
      { from: 'reviewing', to: 'testing', at: new Date(Date.now() - 30000).toISOString(), by: '@session-reviewer-1', note: 'approved by reviewer' },
      { from: 'testing', to: 'testing', at: new Date(Date.now() - 20000).toISOString(), by: '@session-tester-1', note: 'tests passed; waiting for the merge' },
    ]
    let streamTree = withHooks(panel, { initialView: 'status' })
    await flush()
    streamTree = withHooks(panel, { initialView: 'status' })
    const events = findAll(streamTree, (node) => node.props && node.props['data-activity-kind'] !== undefined)
    const kinds = events.map((node) => node.props['data-activity-kind'])
    check(
      'the activity stream renders dispatch and submit as separate localized events',
      kinds.filter((kind) => kind === 'dispatch').length === 1 && kinds.filter((kind) => kind === 'submit').length === 1,
      JSON.stringify(kinds),
    )
    check(
      'the stream covers review, test and merge with localized labels',
      kinds.indexOf('review-pass') >= 0 && kinds.indexOf('test-pass') >= 0 &&
        findAll(streamTree, (node) => node.props && node.props['data-activity-kind'] === 'merge').length >= 1,
      JSON.stringify(kinds),
    )
    const streamText = textOf(streamTree)
    check(
      'the events are localized and show member names, never the @id or the raw English note',
      streamText.indexOf('派发') >= 0 && streamText.indexOf('提交') >= 0 && streamText.indexOf('评审') >= 0 && streamText.indexOf('通过') >= 0 && streamText.indexOf('测试') >= 0 && streamText.indexOf('合并') >= 0 &&
        streamText.indexOf('@session') < 0 && streamText.indexOf('@f158b35c') < 0 && streamText.indexOf('submitted for review round') < 0 && streamText.indexOf('dispatched to fixer') < 0 && streamText.indexOf('created by lead') < 0,
      streamText.slice(0, 400),
    )
    const mergeRow = findAll(streamTree, (node) => node.props && node.props['data-activity-kind'] === 'merge')[0]
    check(
      'the description starts with the subject and never repeats the kind chip verb',
      streamText.indexOf('派发派发') < 0 && streamText.indexOf('提交提交') < 0 && streamText.indexOf('评审评审') < 0 && streamText.indexOf('测试测试') < 0 && streamText.indexOf('合并合并') < 0 &&
        mergeRow !== undefined && textOf(mergeRow).indexOf('T-3 · Tail output feature') >= 0 && textOf(mergeRow).indexOf('feat/task-center-v2') >= 0,
      (mergeRow && textOf(mergeRow)) + ' | ' + streamText.slice(0, 300),
    )
    check(
      'the stream names the assignee rather than an opaque id',
      streamText.indexOf('fixer') >= 0,
      streamText.slice(0, 300),
    )
    check(
      'worktree events are not separate activity rows',
      kinds.indexOf('worktree-create') < 0 && kinds.indexOf('worktree-remove') < 0 && streamText.indexOf('worktree') < 0,
      JSON.stringify(kinds),
    )
    streamTask.history = savedStreamHistory
  }

  // ── per-event round and sha, @user pause, blocked note hidden ──
  {
    const eventTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const savedEventHistory = eventTask.history
    const savedEventCommit = eventTask.commit
    eventTask.commit = '1234567890abcdef'
    eventTask.history = [
      { from: 'running', to: 'reviewing', at: new Date(Date.now() - 50000).toISOString(), by: '@session-fixer', note: 'submitted for review round 1 @aaaaaaa' },
      { from: 'reviewing', to: 'running', at: new Date(Date.now() - 40000).toISOString(), by: '@session-reviewer-1', note: 'changes requested' },
      { from: 'running', to: 'reviewing', at: new Date(Date.now() - 30000).toISOString(), by: '@session-fixer', note: 'submitted for review round 2 @bbbbbbb' },
      { from: 'reviewing', to: 'testing', at: new Date(Date.now() - 20000).toISOString(), by: '@session-reviewer-1', note: 'approved' },
    ]
    let eventTree = withHooks(panel, { initialView: 'status' })
    await flush()
    eventTree = withHooks(panel, { initialView: 'status' })
    const rows = findAll(eventTree, (node) => node.props && node.props['data-activity-kind'] !== undefined)
    const submits = rows.filter((row) => row.props['data-activity-kind'] === 'submit')
    const rejects = rows.filter((row) => row.props['data-activity-kind'] === 'review-reject')
    const passes = rows.filter((row) => row.props['data-activity-kind'] === 'review-pass')
    check(
      'each submit row carries its own commit sha from the note, not the current head',
      submits.length === 2 && submits.map((row) => textOf(row)).join(' | ').indexOf('aaaaaaa') >= 0 && submits.map((row) => textOf(row)).join(' | ').indexOf('bbbbbbb') >= 0 && submits.every((row) => textOf(row).indexOf('1234567') < 0),
      submits.map((row) => textOf(row)).join(' | '),
    )
    check(
      'each review row carries its own round (reject 1, pass 2), not the latest record round',
      rejects.length === 1 && textOf(rejects[0]).indexOf('第 1 轮') >= 0 && passes.length === 1 && textOf(passes[0]).indexOf('第 2 轮') >= 0,
      rejects.concat(passes).map((row) => textOf(row)).join(' | '),
    )
    eventTask.history = savedEventHistory
    eventTask.commit = savedEventCommit
  }
  {
    // A test row must carry the suite summary (evidence first line + host check exit/duration).
    const summaryTask = HOST.tasks.filter((entry) => entry.id === 'T-3')[0]
    const savedSummaryTest = summaryTask.test
    const savedSummaryHistory = summaryTask.history
    summaryTask.history = [{ from: 'testing', to: 'testing', at: new Date(Date.now() - 4000).toISOString(), by: '@session-tester-1', note: 'tests passed; waiting for the merge' }]
    summaryTask.test = Object.assign({}, savedSummaryTest, {
      hostCheck: { command: 'npm run verify', exitCode: 0, timedOut: false, durationMs: 21000 },
      evidence: '11/11 suites passed in 21s',
    })
    let summaryTree = withHooks(panel, { initialView: 'status' })
    await flush()
    summaryTree = withHooks(panel, { initialView: 'status' })
    const testRow = findAll(summaryTree, (node) => node.props && node.props['data-activity-kind'] === 'test-pass' && node.props['data-activity-task'] === 'T-3')[0]
    check(
      'a test row carries the structured summary (status · exit · duration), never the evidence text',
      testRow !== undefined && textOf(testRow).indexOf('通过') >= 0 && textOf(testRow).indexOf('exit 0') >= 0 && textOf(testRow).indexOf('21s') >= 0 && textOf(testRow).indexOf('11/11 suites') < 0,
      testRow && textOf(testRow),
    )
    summaryTask.test = savedSummaryTest
    summaryTask.history = savedSummaryHistory
  }
  {
    // The rejection reason folds into the row title, never the visible text.
    const rejectTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const savedRejectHistory = rejectTask.history
    rejectTask.history = [
      { from: 'running', to: 'reviewing', at: new Date(Date.now() - 30000).toISOString(), by: '@session-fixer', note: 'submitted for review round 1 @ccccccc' },
      { from: 'reviewing', to: 'running', at: new Date(Date.now() - 20000).toISOString(), by: '@session-reviewer-1', note: 'changes requested: the six counters are still rendered' },
    ]
    let rejectTree = withHooks(panel, { initialView: 'status' })
    await flush()
    rejectTree = withHooks(panel, { initialView: 'status' })
    const rejectRow = findAll(rejectTree, (node) => node.props && node.props['data-activity-kind'] === 'review-reject')[0]
    check(
      'a rejection row shows the member name and round, with the reason folded into the title',
      rejectRow !== undefined && textOf(rejectRow).indexOf('reviewer-1') >= 0 && textOf(rejectRow).indexOf('第 1 轮') >= 0 && textOf(rejectRow).indexOf('six counters') < 0 && String(rejectRow.props.title).indexOf('six counters') >= 0,
      rejectRow && (textOf(rejectRow) + ' | title=' + String(rejectRow.props.title)),
    )
    rejectTask.history = savedRejectHistory
  }
  {
    // A bare session id in dispatch.by also resolves through the roster labels.
    const savedPauseBare = HOST.dispatch
    HOST.dispatch = Object.assign({}, savedPauseBare, { by: 'session-reviewer-1' })
    let bareTree = withHooks(panel, { initialView: 'status' })
    await flush()
    bareTree = withHooks(panel, { initialView: 'status' })
    const bareText = textOf(bareTree)
    check(
      'a bare session id in the paused reason resolves to the member name',
      bareText.indexOf('由 reviewer-1 暂停') >= 0 && bareText.indexOf('session-reviewer-1') < 0,
      bareText.slice(0, 300),
    )
    HOST.dispatch = savedPauseBare
  }
  {
    // Only heartbeats: folded line, no "no activity" text.
    const savedSweepTasks = HOST.tasks
    const savedSweepEvents = HOST.activityEvents
    const savedSweepTelemetry = HOST.lastSweep
    HOST.tasks = []
    // T-111: heartbeats are telemetry now — the ring carries no sweep entries and
    // the timeline is empty; only lastSweep says "the host is alive".
    HOST.activityEvents = { available: true, source: 'board', limit: 50, perTask: 3, since: null, count: 0, total: 0, truncated: false, cursor: null, entries: [] }
    HOST.lastSweep = { at: new Date().toISOString(), merged: 0, skipped: 0 }
    let sweepTree2 = withHooks(panel, { initialView: 'status' })
    await flush()
    sweepTree2 = withHooks(panel, { initialView: 'status' })
    const toggle2 = findAll(sweepTree2, (node) => node.props && node.props['data-action'] === 'status-show-all')[0]
    if (toggle2 !== undefined && toggle2.props['data-show-all'] === 'true') {
      toggle2.props.onClick()
      await flush()
      sweepTree2 = withHooks(panel, { initialView: 'status' })
    }
    const sweepCard2 = findAll(sweepTree2, (node) => node.props && node.props['data-status-card'] === 'activity')[0]
    check(
      'with only heartbeats the card shows the folded line and no no-activity text',
      sweepCard2 !== undefined && textOf(sweepCard2).indexOf('心跳已折叠') >= 0 && textOf(sweepCard2).indexOf('没有活动记录') < 0,
      sweepCard2 && textOf(sweepCard2),
    )
    HOST.tasks = savedSweepTasks
    HOST.activityEvents = savedSweepEvents
    HOST.lastSweep = savedSweepTelemetry
  }
  {
    const savedPause = HOST.dispatch
    HOST.dispatch = Object.assign({}, savedPause, { by: '@user' })
    let pauseTree = withHooks(panel, { initialView: 'status' })
    await flush()
    pauseTree = withHooks(panel, { initialView: 'status' })
    const pauseText = textOf(pauseTree)
    check(
      'a @user pause reason reads 你, not the raw id',
      pauseText.indexOf('由 你 暂停') >= 0 && pauseText.indexOf('@user') < 0,
      pauseText.slice(0, 300),
    )
    HOST.dispatch = savedPause
  }
  {
    const blockedTask = HOST.tasks.filter((entry) => entry.id === 'T-7')[0]
    const savedBlockedHistory = blockedTask.history
    blockedTask.history = [{ from: 'running', to: 'blocked', at: new Date(Date.now() - 5000).toISOString(), by: '@scheduler', note: 'lease expired after 30s of silence' }]
    let blockedTree = withHooks(panel, { initialView: 'status' })
    await flush()
    blockedTree = withHooks(panel, { initialView: 'status' })
    const blockedRow = findAll(blockedTree, (node) => node.props && node.props['data-activity-kind'] === 'blocked')[0]
    check(
      'a blocked row keeps the English note out of the text (hover only)',
      blockedRow !== undefined && textOf(blockedRow).indexOf('lease expired') < 0 && String(blockedRow.props.title).indexOf('lease expired') >= 0,
      blockedRow && (textOf(blockedRow) + ' | title=' + String(blockedRow.props.title)),
    )
    blockedTask.history = savedBlockedHistory
  }

  // A fail-then-pass task must keep the failure verdict on the failure row.
  {
    const failTask = HOST.tasks.filter((entry) => entry.id === 'T-3')[0]
    const savedFailHistory = failTask.history
    const savedFailTest = failTask.test
    failTask.test = Object.assign({}, savedFailTest, { status: 'passed' })
    failTask.history = [
      { from: 'reviewing', to: 'testing', at: new Date(Date.now() - 40000).toISOString(), by: '@session-reviewer-1', byName: 'reviewer-1', note: 'approved' },
      { from: 'testing', to: 'running', at: new Date(Date.now() - 30000).toISOString(), by: '@session-tester-1', byName: 'tester-1', note: 'tests failed: boom' },
      { from: 'running', to: 'testing', at: new Date(Date.now() - 20000).toISOString(), by: '@session-fixer', byName: 'fixer', note: 'resubmitted' },
    ]
    let failTree = withHooks(panel, { initialView: 'status' })
    await flush()
    failTree = withHooks(panel, { initialView: 'status' })
    const failRow = findAll(failTree, (node) => node.props && node.props['data-activity-kind'] === 'test-fail' && node.props['data-activity-task'] === 'T-3')[0]
    check(
      'a test-fail row keeps the failure verdict even when the latest test record passed',
      failRow !== undefined && textOf(failRow).indexOf('失败') >= 0 && textOf(failRow).indexOf('通过') < 0,
      failRow && textOf(failRow),
    )
    failTask.history = savedFailHistory
    failTask.test = savedFailTest
  }

  // The header reads the SAME event stream as the activity card.
  {
    const savedHeaderActivity = HOST.activity
    const headerTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const savedHeaderHistory = headerTask.history
    const headerAt = new Date(Date.now() - 120000).toISOString()
    HOST.activity = { available: true, limit: 100, count: 0, entries: [] }
    headerTask.history = [{ from: 'pending', to: 'running', at: headerAt, by: '@session-lead', byName: 'lead', note: 'dispatched' }]
    let headerTree = withHooks(panel, { initialView: 'status' })
    await flush()
    headerTree = withHooks(panel, { initialView: 'status' })
    const headerText = textOf(headerTree)
    const headerTime = new Date(headerAt).toTimeString().slice(0, 5)
    check(
      'with only history and an empty activity ring the header still shows the newest event time',
      headerText.indexOf('最近活动') >= 0 && headerText.indexOf(headerTime) >= 0,
      headerText.slice(0, 260),
    )
    HOST.activity = savedHeaderActivity
    headerTask.history = savedHeaderHistory
  }
  // Old records without byName fall back to the semantic role, never a bare @.
  {
    const savedOldActivity = HOST.activity
    const oldTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const savedOldReview = oldTask.review
    const savedOldTest = oldTask.test
    const savedOldHistory = oldTask.history
    const savedOldRoster = HOST.agents
    HOST.activity = { available: true, limit: 100, count: 0, entries: [] }
    HOST.agents = { lead: null, members: [] }
    oldTask.review = Object.assign({}, savedOldReview, { by: '@7fb24394', byName: null })
    oldTask.test = Object.assign({}, savedOldTest, { by: '@b7cc6c31', byName: null })
    oldTask.history = [
      { from: 'running', to: 'reviewing', at: new Date(Date.now() - 30000).toISOString(), by: '@aaaaaaaa', byName: null, note: 'submitted' },
      { from: 'reviewing', to: 'running', at: new Date(Date.now() - 25000).toISOString(), by: '@aaaaaaaa', byName: null, note: 'changes requested' },
      { from: 'reviewing', to: 'testing', at: new Date(Date.now() - 20000).toISOString(), by: 'system', byName: null, note: 'approved' },
      { from: 'testing', to: 'running', at: new Date(Date.now() - 15000).toISOString(), by: '@bbbbbbbb', byName: null, note: 'tests failed' },
      { from: 'pending', to: 'running', at: new Date(Date.now() - 40000).toISOString(), by: 'system', byName: null, note: 'dispatched' },
    ]
    let oldTree = withHooks(panel, { initialView: 'status' })
    await flush()
    oldTree = withHooks(panel, { initialView: 'status' })
    const oldText = textOf(oldTree)
    const oldReviewRow = findAll(oldTree, (node) => node.props && node.props['data-activity-kind'] === 'review-reject')[0]
    const oldTestRow = findAll(oldTree, (node) => node.props && node.props['data-activity-kind'] === 'test-fail')[0]
    check(
      'old review/test rows without byName show 评审者/测试者 and never a bare @',
      oldReviewRow !== undefined && textOf(oldReviewRow).indexOf('评审者') >= 0 && oldTestRow !== undefined && textOf(oldTestRow).indexOf('测试者') >= 0 && oldText.indexOf('@7fb24394') < 0 && oldText.indexOf('@b7cc6c31') < 0 && oldText.indexOf('@aaaaaaaa') < 0 && oldText.indexOf('@bbbbbbbb') < 0,
      oldText.slice(0, 300),
    )
    const mergeTask = HOST.tasks.filter((entry) => entry.id === 'T-3')[0]
    const savedMergeHistory = mergeTask.history
    mergeTask.history = [{ from: 'testing', to: 'done', at: new Date(now - 60000).toISOString(), by: '@cccccccc', byName: null, note: 'merged as fedcba0987654321' }]
    let mergeTree = withHooks(panel, { initialView: 'status' })
    await flush()
    mergeTree = withHooks(panel, { initialView: 'status' })
    const mergeRow = findAll(mergeTree, (node) => node.props && node.props['data-activity-kind'] === 'merge' && node.props['data-activity-task'] === 'T-3')[0]
    check(
      'an old merge row shows 合并者 for an unresolved merger, never a bare @',
      mergeRow !== undefined && textOf(mergeRow).indexOf('合并者') >= 0 && textOf(mergeRow).indexOf('@cccccccc') < 0,
      mergeRow && textOf(mergeRow),
    )
    mergeTask.history = savedMergeHistory
    mergeTask.history = [{ from: 'testing', to: 'done', at: new Date(now - 59000).toISOString(), by: '@b7cc6c31', byName: '@b7cc6c31', note: 'merged as fedcba0987654321' }]
    let legacyMergeTree = withHooks(panel, { initialView: 'status' })
    await flush()
    legacyMergeTree = withHooks(panel, { initialView: 'status' })
    const legacyMergeRow = findAll(legacyMergeTree, (node) => node.props && node.props['data-activity-kind'] === 'merge' && node.props['data-activity-task'] === 'T-3')[0]
    check(
      'a legacy @label byName on a merge row falls back to 合并者 and never renders the @',
      legacyMergeRow !== undefined && textOf(legacyMergeRow).indexOf('合并者 b7cc6c31') >= 0 && textOf(legacyMergeRow).indexOf('@') < 0,
      legacyMergeRow && textOf(legacyMergeRow),
    )
    mergeTask.history = savedMergeHistory
    mergeTask.history = [{ from: 'testing', to: 'done', at: new Date(now - 58000).toISOString(), by: '@', byName: '@', note: 'merged as fedcba0987654321' }]
    let degenerateTree = withHooks(panel, { initialView: 'status' })
    await flush()
    degenerateTree = withHooks(panel, { initialView: 'status' })
    const degenerateRow = findAll(degenerateTree, (node) => node.props && node.props['data-activity-kind'] === 'merge' && node.props['data-activity-task'] === 'T-3')[0]
    check(
      'a degenerate @ byName renders the role word only, never a bare @',
      degenerateRow !== undefined && textOf(degenerateRow).indexOf('合并者') >= 0 && textOf(degenerateRow).indexOf('@') < 0,
      degenerateRow && textOf(degenerateRow),
    )
    mergeTask.history = savedMergeHistory
    const systemPassRow = findAll(oldTree, (node) => node.props && node.props['data-activity-kind'] === 'review-pass')[0]
    check(
      'a host/system event keeps its literal word instead of a role fallback',
      systemPassRow !== undefined && textOf(systemPassRow).indexOf('system') >= 0 && textOf(systemPassRow).indexOf('评审者') < 0,
      systemPassRow && textOf(systemPassRow),
    )
    HOST.agents = savedOldRoster
    oldTask.review = savedOldReview
    oldTask.test = savedOldTest
    oldTask.history = savedOldHistory
    HOST.activity = savedOldActivity
  }

  // A queued review round is visible on the card, the detail and the status page.
  {
    const queuedTask = HOST.tasks.filter((entry) => entry.id === 'T-4')[0]
    const savedQueue = queuedTask.queuePosition
    queuedTask.queuePosition = 1
    let queueTree = withHooks(panel, { initialView: 'board' })
    await flush()
    queueTree = withHooks(panel, { initialView: 'board' })
    const queuedCard = findAll(queueTree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card' && textOf(node).indexOf('Review the crate API') >= 0)[0]
    check('a queued review round shows its position on the card', queuedCard !== undefined && textOf(queuedCard).indexOf('排队中') >= 0 && textOf(queuedCard).indexOf('前面 1 条') >= 0, queuedCard && textOf(queuedCard))
    let statusQueueTree = withHooks(panel, { initialView: 'status' })
    await flush()
    statusQueueTree = withHooks(panel, { initialView: 'status' })
    const reviewerRow = findAll(statusQueueTree, (node) => node.props && node.props['data-status-agent'] === 'reviewer-1')[0]
    check('the status agents card shows the reviewer queue length', reviewerRow !== undefined && textOf(reviewerRow).indexOf('队列 1') >= 0, reviewerRow && textOf(reviewerRow))
    queuedCard.props.onClick()
    const detailQueueTree = withHooks(panel, { initialView: 'board' })
    await flush()
    const detailQueueDrawer = findAll(detailQueueTree, (node) => node.props && node.props['data-detail-overlay'] === 'true')[0]
    check('the detail page shows the queue position pill', detailQueueDrawer !== undefined && textOf(detailQueueDrawer).indexOf('排队中') >= 0 && textOf(detailQueueDrawer).indexOf('前面 1 条') >= 0, detailQueueDrawer && textOf(detailQueueDrawer).slice(0, 200))
    // A DELIVERED round is already being worked on: even if a stale queuePosition
    // survived, the card, the detail and the status queue count must not show it.
    const savedReview = queuedTask.review
    queuedTask.review = Object.assign({}, savedReview, { deliveredAt: new Date().toISOString() })
    let deliveredTree = withHooks(panel, { initialView: 'board' })
    await flush()
    deliveredTree = withHooks(panel, { initialView: 'board' })
    const deliveredCard = findAll(deliveredTree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card' && textOf(node).indexOf('Review the crate API') >= 0)[0]
    check('a delivered review round shows no queued chip', deliveredCard !== undefined && textOf(deliveredCard).indexOf('排队中') < 0, deliveredCard && textOf(deliveredCard))
    let deliveredStatus = withHooks(panel, { initialView: 'status' })
    await flush()
    deliveredStatus = withHooks(panel, { initialView: 'status' })
    const deliveredReviewerRow = findAll(deliveredStatus, (node) => node.props && node.props['data-status-agent'] === 'reviewer-1')[0]
    check(
      'a delivered round is not counted as queued on the status page',
      deliveredReviewerRow !== undefined && textOf(deliveredReviewerRow).indexOf('队列 1') < 0 && textOf(deliveredReviewerRow).indexOf('队列 2') < 0,
      deliveredReviewerRow && textOf(deliveredReviewerRow),
    )
    // The same guard covers the testing stage.
    const savedStatus = queuedTask.status
    const savedTest = queuedTask.test
    queuedTask.status = 'testing'
    queuedTask.test = { status: 'pending', by: null, at: new Date().toISOString(), deliveredAt: new Date().toISOString(), evidence: null, attempt: 1 }
    let testingTree = withHooks(panel, { initialView: 'board' })
    await flush()
    testingTree = withHooks(panel, { initialView: 'board' })
    const testingCard = findAll(testingTree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card' && textOf(node).indexOf('Review the crate API') >= 0)[0]
    check('a delivered test round shows no queued chip either', testingCard !== undefined && textOf(testingCard).indexOf('排队中') < 0, testingCard && textOf(testingCard))
    queuedTask.status = savedStatus
    queuedTask.test = savedTest
    queuedTask.review = savedReview
    queuedTask.queuePosition = savedQueue
  }

  // T-93: a nearly full board is warned about on the status page, with the size,
  // the cap and how many more cards fit — before the file stops loading.
  {
    const savedBoardSize = HOST.boardSize
    HOST.boardSize = { bytes: 24 * 1024 * 1024, limit: 32 * 1024 * 1024, percent: 75, level: 'three-quarters', cards: 1500, bytesPerCard: 16777, headroomCards: 500, warning: 'the task board is 24 MB of its 32 MB limit (75%)' }
    let sizeTree = withHooks(panel, { initialView: 'status' })
    await flush()
    sizeTree = withHooks(panel, { initialView: 'status' })
    const sizeRow = findAll(sizeTree, (node) => node.props && typeof node.props['data-status-board-size'] === 'string')[0]
    check(
      'a nearly full board is warned about with size, cap and remaining cards',
      sizeRow !== undefined && sizeRow.props['data-status-board-size'] === 'three-quarters' && textOf(sizeRow).indexOf('24 MB') >= 0 && textOf(sizeRow).indexOf('32 MB') >= 0 && textOf(sizeRow).indexOf('75') >= 0 && textOf(sizeRow).indexOf('500') >= 0,
      sizeRow && textOf(sizeRow),
    )
    HOST.boardSize = savedBoardSize
  }

  // The dispatch card names its three KVs and does not repeat the merge queue.
  {
    const savedQueue = HOST.queue
    HOST.queue = [{ id: 'T-1' }, { id: 'T-2' }]
    let kvTree = withHooks(panel, { initialView: 'status' })
    await flush()
    kvTree = withHooks(panel, { initialView: 'status' })
    const dispatchCard = findAll(kvTree, (node) => node.props && node.props['data-status-card'] === 'dispatch')[0]
    const kv = (key) => findAll(dispatchCard, (node) => node.props && node.props['data-kv'] === key)[0]
    const expectedRunning = HOST.tasks.filter((task) => task.status === 'running').length
    check(
      'the dispatch card labels its three KVs 并发 / 就绪 / 合并队列',
      dispatchCard !== undefined && kv('concurrent') !== undefined && kv('ready') !== undefined && kv('merge-queue') !== undefined && textOf(kv('concurrent')).indexOf('并发') >= 0 && textOf(kv('ready')).indexOf('就绪') >= 0 && textOf(kv('merge-queue')).indexOf('合并队列') >= 0,
      dispatchCard && textOf(dispatchCard).slice(0, 200),
    )
    check(
      'the three KVs carry running / ready / snapshot.queue.length',
      String(textOf(kv('concurrent')).replace(/[^0-9/]/g, '')) === String(expectedRunning) + '/' + String(HOST.dispatch.maxConcurrent) && textOf(kv('merge-queue')).indexOf('2') >= 0,
      JSON.stringify({ concurrent: textOf(kv('concurrent')), merge: textOf(kv('merge-queue')) }),
    )
    const scanFooter = findAll(dispatchCard, (node) => node.props && node.props['data-status-scan'] === 'true')[0]
    check(
      'the footer keeps only the last scan and no merge-queue count',
      scanFooter !== undefined && textOf(scanFooter).indexOf('上次扫描') >= 0 && textOf(scanFooter).indexOf('合并队列') < 0 && findAll(scanFooter, (node) => node.props && node.props['data-kv'] !== undefined).length === 0,
      scanFooter && textOf(scanFooter),
    )
    locale = 'en'
    let enTree = withHooks(panel, { initialView: 'status' })
    await flush()
    enTree = withHooks(panel, { initialView: 'status' })
    const enCard = findAll(enTree, (node) => node.props && node.props['data-status-card'] === 'dispatch')[0]
    const enFooter = findAll(enCard, (node) => node.props && node.props['data-status-scan'] === 'true')[0]
    check(
      'the English card says merge queue and the footer does not repeat it',
      textOf(enCard).indexOf('merge queue') >= 0 && textOf(enFooter).indexOf('merge queue') < 0 && textOf(enFooter).indexOf('last scan') >= 0,
      textOf(enCard).slice(0, 200),
    )
    locale = 'zh'
    HOST.queue = savedQueue
  }

  // ── empty states are plain text, not a card inside a card ──
  {
    const savedEmptyAgents = HOST.agents
    const savedEmptyActivity = HOST.activity
    const savedEmptyTasks = HOST.tasks
    HOST.agents = { lead: null, members: [] }
    HOST.activity = { available: true, limit: 100, count: 0, entries: [] }
    HOST.worktrees = { available: true, error: null, total: 0, active: 0, counts: {}, worktrees: [] }
    HOST.tasks = []
    let emptyTree = withHooks(panel, { initialView: 'status' })
    await flush()
    emptyTree = withHooks(panel, { initialView: 'status' })
    const emptyRoot = findAll(emptyTree, (node) => node.props && node.props['data-status'] === 'cards')[0]
    check(
      'the empty states use plain text with no inner dashed box',
      emptyRoot !== undefined && findAll(emptyRoot, (node) => node.props && typeof node.props.className === 'string' && node.props.className.indexOf('gbt-empty') >= 0).length === 0,
      JSON.stringify(findAll(emptyRoot, (node) => node.props && typeof node.props.className === 'string').map((node) => node.props.className).filter((name) => name.indexOf('empty') >= 0)),
    )
    HOST.agents = savedEmptyAgents
    HOST.activity = savedEmptyActivity
    HOST.tasks = savedEmptyTasks
  }

  const savedWorktrees = HOST.worktrees
  HOST.worktrees = { available: false, error: 'no-git-service', total: 0, active: 0, counts: {}, worktrees: [] }
  let noGitTree = withHooks(panel, { initialView: 'status' })
  await flush()
  noGitTree = withHooks(panel, { initialView: 'status' })
  check('a host without git says no-git-service instead of showing a blank table', textOf(noGitTree).indexOf('no-git-service') >= 0, textOf(noGitTree))
  HOST.worktrees = savedWorktrees
  if (savedNavigator === undefined) delete globalThis.navigator
  else Object.defineProperty(globalThis, 'navigator', savedNavigator)
}

// ── Roles tab: ONE editor card, identity binding, no team size (T-138/T-137) ─
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
  const cards = findAll(rolesTree, (node) => node.props && node.props['data-card'] === 'editor')
  check('the roles tab is ONE card: the context editor', cards.length === 1 && cards[0].props['data-card'] === 'editor', JSON.stringify(cards.map((card) => card.props['data-card'])))
  check(
    'the roles page has a single card layer (no outer rcard border)',
    findAll(rolesTree, (node) => node.props && typeof node.props.className === 'string' && node.props.className.indexOf('gbt-rcard') >= 0).length === 0 &&
      findAll(rolesTree, (node) => node.props && node.props.className === 'gbt-rolecard').length === 2,
    JSON.stringify(findAll(rolesTree, (node) => node.props && typeof node.props.className === 'string' && node.props.className.indexOf('gbt-rcard') >= 0).map((node) => node.props.className)),
  )
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
  check(
    'the panel root carries the visual-check marker and every role tab its data-roles-tab',
    findAll(rolesTree, (node) => node.props && node.props['data-panel-root'] === 'task-center').length === 1 &&
      findAll(editor, (node) => node.props && node.props['data-roles-tab'] !== undefined).map((node) => node.props['data-roles-tab']).join(',') === 'worker,tester,reviewer',
    JSON.stringify(findAll(editor, (node) => node.props && node.props['data-roles-tab'] !== undefined).map((node) => node.props['data-roles-tab'])),
  )
  check('the tabs sit in a labelled tablist', findAll(editor, (node) => node.props && node.props.role === 'tablist').length === 1)
  check(
    'the selected tab carries aria-selected=true and the others false',
    tabs[0].props['aria-selected'] === 'true' && tabs[1].props['aria-selected'] === 'false' && tabs[2].props['aria-selected'] === 'false',
    JSON.stringify(tabs.map((tab) => tab.props['aria-selected'])),
  )
  check('exactly one tab is marked active', findAll(editor, (node) => node.props && node.props.className === 'gbt-rolesegitem' && node.props['data-active'] === 'true').length === 1)

  // Identity row: kind + custom/default state + the ONE "current use" picker.
  let identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check(
    'the identity row names the kind and the current profile',
    identity.props['data-kind'] === 'worker' && identity.props['data-profile'] === 'worker' && identity.props['data-bound'] === 'worker',
    JSON.stringify(identity.props),
  )
  check('the identity has no free-text control', findAll(identity, (node) => node.type === 'input' || node.type === 'textarea').length === 0)
  check(
    'the bind/apply/replace-kind/reset controls and the old profile select are gone',
    ['rolesBind', 'role-editor-apply', 'rolesReplace-kind', 'rolesReset'].every((action) => findAll(editor, (node) => node.props && node.props['data-action'] === action).length === 0) &&
      findAll(editor, (node) => node.props && node.props['data-field'] === 'profile-select').length === 0 &&
      textOf(editor).indexOf('选择后点“绑定”') < 0,
  )
  check(
    'the built-in page offers the only Fork entry in the bottom action bar, and no Save',
    findAll(editor, (node) => node.props && node.props['data-roles-actions'] === 'true').length === 1 &&
      findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save').length === 0 &&
      findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork').length === 1 &&
      findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props['data-role-empty-fork'] === 'true',
  )
  check(
    'all five panel navigation buttons carry a stable data-view (the file-lock tab is gone)',
    (function () {
      const buttons = findAll(rolesTree, (node) => node.type === 'button' && node.props && node.props['data-view'] !== undefined)
      return buttons.length === 5 && buttons.map((node) => node.props['data-view']).join(',') === 'board,queue,workers,status,roles' && buttons.every((node) => textOf(node) !== '文件锁')
    })(),
    JSON.stringify(findAll(rolesTree, (node) => node.props && node.props['data-view'] !== undefined).map((node) => node.props['data-view'])),
  )
  check(
    'the page starts with one toolbar: tabs on the left, current use on the right',
    findAll(editor, (node) => node.props && node.props['data-roles-header'] === 'true').length === 1,
  )
  check(
    'there is no anchor row on either pane any more',
    findAll(editor, (node) => node.props && node.props['data-role-anchors'] !== undefined).length === 0 &&
      findAll(editor, (node) => node.props && node.props['data-role-anchor'] !== undefined).length === 0,
  )
  check(
    'the two panes are raw/injected and each is one card',
    findAll(editor, (node) => node.props && node.props['data-roles-pane'] === 'raw').length === 1 &&
      findAll(editor, (node) => node.props && node.props['data-roles-pane'] === 'injected').length === 1 &&
      findAll(editor, (node) => node.props && node.props['data-role-card'] === 'raw').length === 1 &&
      findAll(editor, (node) => node.props && node.props['data-role-card'] === 'injected').length === 1,
  )
  check(
    'the role page tabs are the role-specific segmented control',
    findAll(editor, (node) => node.props && node.props.className === 'gbt-roleseg').length === 1 &&
      findAll(editor, (node) => node.props && node.props['data-role-tabs'] === 'true').length === 1 &&
      findAll(editor, (node) => node.props && node.props.className === 'gbt-rolesegitem').length === 3 &&
      findAll(editor, (node) => node.props && node.props.className === 'gbt-segmented').length === 0 &&
      findAll(editor, (node) => node.props && node.props.className === 'gbt-seg').length === 0,
  )
  check(
    'the left card holds the prompt and skills together, with no instance count',
    (function () {
      const card = findAll(editor, (node) => node.props && node.props['data-role-card'] === 'raw')[0]
      return (
        card !== undefined &&
        findAll(card, (node) => node.props && node.props['data-role-prompt'] === 'raw').length === 1 &&
        findAll(card, (node) => node.type === 'input' && node.props['data-field'] === 'skills').length === 1 &&
        findAll(card, (node) => node.type === 'input' && node.props['data-field'] === 'instances').length === 0 &&
        findAll(card, (node) => node.props && node.props['data-section'] === 'role-editor-instances-field').length === 0 &&
        findAll(card, (node) => node.props && node.props['data-role-card-title'] === 'true').length === 1
      )
    })(),
  )
  check(
    'T-137 the roles page explains that team size comes from the dispatch settings',
    findAll(rolesTree, (node) => node.props && node.props['data-role-scale-note'] === 'true').length === 1 &&
      textOf(findAll(rolesTree, (node) => node.props && node.props['data-role-scale-note'] === 'true')[0]).indexOf('派发设置') >= 0,
    textOf(rolesTree).slice(0, 200),
  )
  check(
    'the injected sections are labelled once, in the semantic order',
    findAll(editor, (node) => node.props && node.props['data-role-section-label'] !== undefined).map((node) => textOf(node)).join(',') === '角色与阶段,内置默认提示词,任务数据,权限边界与结论,技能',
    findAll(editor, (node) => node.props && node.props['data-role-section-label'] !== undefined).map((node) => textOf(node)).join(','),
  )
  check(
    'no refresh button, no repeated guidance sentence and no top banner',
    findAll(rolesTree, (node) => node.props && node.props['data-action'] === 'rolesList').length === 0 &&
      textOf(editor).indexOf('读取角色配置') < 0 &&
      textOf(editor).indexOf('选择角色 →') < 0,
  )
  let useSelect = findAll(editor, (node) => node.type === 'select' && node.props['data-role-use-select'] === 'true')[0]
  check(
    'the current-use picker offers the stage\'s default first',
    useSelect !== undefined && useSelect.props.defaultValue === 'worker' && findAll(useSelect, (node) => node.type === 'option').map((option) => option.props.value).join(',') === 'worker' && textOf(useSelect).indexOf('默认') >= 0,
    useSelect === undefined ? 'missing' : textOf(useSelect),
  )

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
  // A FAILED quiet preview must not write to the action channel either.
  const quietErrorBefore = captured.getSnapshot().actionError
  const quietResultBefore = captured.getSnapshot().actionResult
  const savedPreviewReply = rolePreviewReply
  rolePreviewReply = function () { return { ok: false, code: 'preview-failed', message: 'boom' } }
  const previewTaskSelect = findAll(editor, (node) => node.type === 'select' && node.props['data-field'] === 'preview-task')[0]
  previewTaskSelect.props.onChange({ target: { value: 'T-2' } })
  await flush()
  await flush()
  check(
    'a FAILED quiet preview never writes snapshot.actionError/actionResult',
    captured.getSnapshot().actionError === quietErrorBefore && captured.getSnapshot().actionResult === quietResultBefore,
    JSON.stringify({ error: captured.getSnapshot().actionError, result: captured.getSnapshot().actionResult }),
  )
  rolePreviewReply = savedPreviewReply
  findAll(editor, (node) => node.type === 'select' && node.props['data-field'] === 'preview-task')[0].props.onChange({ target: { value: '' } })
  await flush()
  editor = findAll(findAll(rolesTree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check(
    'switching a tab shows that kind\'s bound profile',
    identity.props['data-kind'] === 'reviewer' && identity.props['data-profile'] === 'godot-reviewer' && identity.props['data-bound'] === 'godot-reviewer',
    JSON.stringify(identity.props),
  )
  check('the active tab follows the switch', findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['aria-selected'] === 'true').map((tab) => tab.props['data-kind']).join(',') === 'reviewer')
  useSelect = findAll(editor, (node) => node.type === 'select' && node.props['data-role-use-select'] === 'true')[0]
  check(
    'the current-use picker lists the built-in default and every custom copy of the stage',
    useSelect !== undefined &&
      useSelect.props.defaultValue === 'godot-reviewer' &&
      findAll(useSelect, (node) => node.type === 'option').map((option) => option.props.value).join(',') === 'reviewer,godot-reviewer' &&
      textOf(useSelect).indexOf('默认') >= 0,
    useSelect === undefined ? 'missing' : textOf(useSelect),
  )

  // A custom copy can be deleted; a built-in cannot.
  check('a custom copy offers delete in the action bar', findAll(editor, (node) => node.props && node.props['data-action'] === 'rolesDelete').length === 1)

  // ONE pick of "current use" is ONE action: bind the stage, then replace the kind.
  // Reflect the fresh binding in the snapshot the bind response returns.
  HOST.roles = Object.assign({}, HOST.roles, { stages: Object.assign({}, HOST.roles.stages, { review: 'reviewer' }) })
  postReply = { ok: true, config: HOST.roles, bound: { stage: 'review', profile: 'reviewer' }, source: 'file', snapshot: HOST }
  const usesBefore = posts.length
  useSelect.props.onChange({ target: { value: 'reviewer' } })
  await flush()
  await flush()
  const usePosts = posts.slice(usesBefore)
  check(
    'picking the default binds and replaces in a single action',
    usePosts.length === 2 && usePosts[0].action === 'rolesBind' && usePosts[0].stage === 'review' && usePosts[0].profile === 'reviewer' && usePosts[1].action === 'rolesReplace' && usePosts[1].name === 'reviewer',
    JSON.stringify(usePosts),
  )

  // Pick the custom copy back: same one-step activation.
  rolesTree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(rolesTree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  useSelect = findAll(editor, (node) => node.type === 'select' && node.props['data-role-use-select'] === 'true')[0]
  check('the picker lists the default and every custom copy of the stage', findAll(useSelect, (node) => node.type === 'option').map((option) => option.props.value).join(',') === 'reviewer,godot-reviewer', textOf(useSelect))
  const copyBefore = posts.length
  useSelect.props.onChange({ target: { value: 'godot-reviewer' } })
  await flush()
  await flush()
  const copyPosts = posts.slice(copyBefore)
  check(
    'picking a copy binds and replaces it in the same action',
    copyPosts.length === 2 && copyPosts[0].action === 'rolesBind' && copyPosts[0].profile === 'godot-reviewer' && copyPosts[1].action === 'rolesReplace' && copyPosts[1].name === 'reviewer',
    JSON.stringify(copyPosts),
  )
  check('a built-in profile offers no delete', findAll(identity, (node) => node.props && node.props['data-action'] === 'rolesDelete').length === 0)
  HOST.roles = Object.assign({}, HOST.roles, { stages: Object.assign({}, HOST.roles.stages, { review: 'godot-reviewer' }) })

  // T-137: the role editor no longer carries a team size at all — size is a
  // dispatch setting, and a role only defines behaviour.
  rolesTree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(rolesTree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const instanceRows = findAll(editor, (node) => node.type === 'tr' && node.props && node.props['data-role-instance'] !== undefined)
  check('the instance table is gone', instanceRows.length === 0 && findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-instances').length === 0)
  check('no drain/replace-per-instance buttons remain', findAll(editor, (node) => node.props && (node.props['data-action'] === 'rolesDrain' || node.props['data-action'] === 'rolesReplace')).length === 0)
  check(
    'T-137 the editor has no instance-count input and no hidden instances field',
    findAll(editor, (node) => node.type === 'input' && node.props['data-field'] === 'instances').length === 0 &&
      findAll(editor, (node) => node.props && node.props['data-section'] === 'role-editor-instances-field').length === 0 &&
      findAll(editor, (node) => node.type === 'input' && node.props['data-field'] === 'number').length === 0,
  )
  const runningRow = findAll(editor, (node) => node.props && node.props['data-role-running'] === 'true')[0]
  check(
    'running instances are one line of status text',
    runningRow !== undefined && textOf(runningRow).indexOf('运行中') >= 0 && textOf(runningRow).indexOf('reviewer-1') >= 0,
    runningRow && textOf(runningRow),
  )

  // Server-side validation errors are readable in the panel, and a COMPLETED
  // poll (the refresh button calls store.load) does not wipe them.
  postReply = { ok: false, code: 'invalid-role-skills', message: 'skills must be a list' }
  const errorTree0 = withHooks(panel, { initialView: 'roles' })
  const blankCreate = findAll(errorTree0, (node) => node.props && node.props['data-section'] === 'role-create-blank')[0]
  check('the blank-create form is the editor\'s secondary entry', blankCreate !== undefined && findAll(blankCreate, (node) => node.props && node.props['data-form'] === 'role-create').length === 1)
  const errorForm = findAll(blankCreate, (node) => node.props && node.props['data-form'] === 'role-create')[0]
  findAll(errorForm, (node) => node.props && node.props['data-field'] === 'name')[0].props.ref.current = { value: 'bad-reviewer' }
  findAll(errorForm, (node) => node.props && node.props['data-action'] === 'rolesCreate')[0].props.onClick()
  await flush()
  check('the refused action is recorded in the store', captured.getSnapshot().actionError !== null && captured.getSnapshot().actionError.code === 'invalid-role-skills', JSON.stringify(captured.getSnapshot().actionError))
  const errorTree = withHooks(panel, { initialView: 'roles' })
  check(
    'a create refusal is recorded without a page-top banner',
    captured.getSnapshot().actionError !== null && captured.getSnapshot().actionError.code === 'invalid-role-skills' && findAll(errorTree, (node) => node.props && node.props['data-role-result'] === 'ok').length === 0,
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
    'CSS gives the 45/55 panes, the action bar and the create fold a layout',
    css.indexOf('.gbt-rolesview .gbt-footnote') >= 0 && css.indexOf('.gbt-rolespanes') >= 0 && css.indexOf('45fr 55fr') >= 0 && css.indexOf('.gbt-rolesactions') >= 0 && css.indexOf('position:sticky') >= 0 && css.indexOf('.gbt-rolescroll') >= 0 && css.indexOf('mask-image') >= 0 && css.indexOf('.gbt-createblank') >= 0 && css.indexOf('.gbt-editor-select') >= 0,
    css.slice(0, 160),
  )
  const editor = findAll(rolesTree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  check(
    'no role-instance table is rendered at all',
    findAll(rolesTree, (node) => node.type === 'table' && node.props && node.props['data-section'] === 'role-instances').length === 0,
  )
  const form = findAll(rolesTree, (node) => node.props && node.props['data-form'] === 'role-create')[0]
  check('the blank-create form uses the responsive grid class', form !== undefined && form.props.className === 'gbt-formgrid', form && form.props.className)
  const formLabels = findAll(form, (node) => node.type === 'label')
  check('the blank-create form has a multi-field grid (no instance field)', formLabels.length === 6 && formLabels.every((label) => findAll(label, (node) => node.props && node.props['data-field'] === 'instances').length === 0), String(formLabels.length))
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

  const promptArea = findAll(editor, (node) => node.props && node.props['data-roles-panes'] === 'true')[0]
  check('the editor has ONE prompt area in the same split shape as review/test', promptArea !== undefined && promptArea.props['data-role-layout'] === 'split', promptArea && promptArea.props.className)
  const workerRaw = findAll(promptArea, (node) => node.props && node.props['data-role-prompt'] === 'raw')[0]
  const injectedCol = findAll(promptArea, (node) => node.props && node.props['data-role-prompt'] === 'injected')[0]
  check(
    'the implement page is two columns: raw prompt and injected text',
    promptArea.props.className === 'gbt-rolespanes' && workerRaw !== undefined && injectedCol !== undefined,
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
  const workerCopy = findAll(editor, (node) => node.props && node.props['data-role-empty-fork'] === 'true')[0]
  check(
    'the worker prompt keeps the not-editable note and the existing Fork action',
    workerCopy !== undefined && workerCopy.props['data-action'] === 'role-editor-fork' && textOf(workerCopy) === '复制一份并启用' && textOf(workerRaw).indexOf('默认角色不可修改') >= 0,
    workerRaw && textOf(workerRaw),
  )

  // The right column is what the host really injects, not panel copy.
  const source = findAll(injectedCol, (node) => node.props && node.props['data-role-task-source'] !== undefined)[0]
  check(
    'the right column names a real task as the source',
    source !== undefined && source.props['data-role-task-source'] === 'real' && textOf(source).indexOf('T-1 · Build damage system') >= 0,
    source && textOf(source),
  )
  const taskRow = findAll(injectedCol, (node) => node.props && node.props['data-role-taskrow'] === 'true')[0]
  check(
    'the right pane top row combines the task select and the real/sample badge',
    taskRow !== undefined && findAll(taskRow, (node) => node.type === 'select' && node.props['data-field'] === 'preview-task').length === 1 && findAll(taskRow, (node) => node.props && node.props['data-role-task-source'] !== undefined).length === 1,
    taskRow && JSON.stringify(taskRow.props),
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
    sectionNodes.map((node) => node.props['data-role-section-group']).join(',') === 'role,role,role,template,task,fixed,skills' &&
      findAll(injectedCol, (node) => node.props && node.props['data-role-section-label'] !== undefined).map((node) => textOf(node)).join(',') === '角色与阶段,内置默认提示词,任务数据,权限边界与结论,技能',
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
  const testerArea = findAll(editor, (node) => node.props && node.props['data-roles-panes'] === 'true')[0]
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
  const emptyCopy = findAll(editor, (node) => node.props && node.props['data-role-empty-fork'] === 'true')[0]
  check(
    'the built-in prompt keeps the not-editable note and the existing Fork action',
    emptyCopy !== undefined &&
      emptyCopy.props['data-action'] === 'role-editor-fork' &&
      textOf(emptyCopy) === '复制一份并启用' &&
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
  const forkedArea = findAll(editor, (node) => node.props && node.props['data-roles-panes'] === 'true')[0]
  const forkedRaw = findAll(forkedArea, (node) => node.props && node.props['data-role-prompt'] === 'raw')[0]
  const forkedAreaField = findAll(forkedRaw, (node) => node.type === 'textarea' && node.props['data-field'] === 'template')[0]
  check(
    'a forked draft switches the template label to 你的提示词',
    findAll(editor, (node) => node.props && node.props['data-role-section-label'] !== undefined).map((node) => textOf(node)).indexOf('你的提示词') >= 0 &&
      findAll(editor, (node) => node.props && node.props['data-role-section-label'] !== undefined).map((node) => textOf(node)).indexOf('内置默认提示词') < 0,
    JSON.stringify(findAll(editor, (node) => node.props && node.props['data-role-section-label'] !== undefined).map((node) => textOf(node))),
  )
  check(
    'a forked copy is two columns, editable, and starts from the default prompt',
    forkedArea.props['data-role-layout'] === 'split' &&
      forkedRaw !== undefined &&
      forkedRaw.props['data-role-raw-readonly'] === 'false' &&
      forkedAreaField !== undefined &&
      forkedAreaField.props.defaultValue === TESTER_DEFAULT_PROMPT,
    JSON.stringify({ layout: forkedArea.props['data-role-layout'], readonly: forkedRaw && forkedRaw.props['data-role-raw-readonly'], hasField: forkedAreaField !== undefined, value: forkedAreaField && String(forkedAreaField.props.defaultValue) }),
  )

  // Saving the draft creates the copy, so the tab switch is allowed.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]

  // The implement page forks into an editable two-column view like the others.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  const workerArea = findAll(editor, (node) => node.props && node.props['data-roles-panes'] === 'true')[0]
  const workerRawCol = findAll(workerArea, (node) => node.props && node.props['data-role-prompt'] === 'raw')[0]
  const workerFork = findAll(editor, (node) => node.props && node.props['data-role-empty-fork'] === 'true')[0]
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
  const forkedWorkerArea = findAll(editor, (node) => node.props && node.props['data-roles-panes'] === 'true')[0]
  const forkedWorkerField = findAll(forkedWorkerArea, (node) => node.type === 'textarea' && node.props['data-field'] === 'template')[0]
  check(
    'forking the implement page makes it editable and starts from the worker default prompt',
    forkedWorkerArea.props['data-role-layout'] === 'split' &&
      forkedWorkerField !== undefined &&
      forkedWorkerField.props.defaultValue === WORKER_DEFAULT_PROMPT,
    JSON.stringify({ layout: forkedWorkerArea.props['data-role-layout'], hasField: forkedWorkerField !== undefined, value: forkedWorkerField && String(forkedWorkerField.props.defaultValue) }),
  )

  // Discard the worker draft, then leave the editor without a draft.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-discard')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'tester')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
}

// ── one role, one action: save applies, fork creates + applies, delete falls back ─
{
  let tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  let editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  // The reviewer stage is bound to the custom copy in this fixture.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'reviewer')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]

  // Saving the profile that is in use applies it in the same click.
  postReply = null
  const saveBefore = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  await flush()
  const savePosts = posts.slice(saveBefore)
  check(
    'T-137 saving the current copy updates it (behaviour only) and replaces the instance in one action',
    savePosts.length === 2 &&
      savePosts[0].action === 'rolesUpdate' &&
      savePosts[0].name === 'godot-reviewer' &&
      savePosts[0].profile.instances === undefined &&
      savePosts[1].action === 'rolesReplace' &&
      savePosts[1].name === 'reviewer',
    JSON.stringify(savePosts),
  )

  // A built-in profile has no Save: only the copy action.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  check('a built-in page exposes the copy action and no Save', findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save').length === 0 && findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork').length === 1)

  // Fork opens a named draft; nothing is written before Save.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  let identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  const draftNameInput = findAll(editor, (node) => node.props && node.props['data-field'] === 'draft-name')[0]
  check(
    'Fork creates a named draft with no request',
    identity.props['data-draft'] === 'true' && draftNameInput !== undefined && String(draftNameInput.props.defaultValue).indexOf('worker-fork') === 0 && textOf(editor).indexOf('草稿未保存') >= 0,
    JSON.stringify({ identity: identity.props, draft: draftNameInput && draftNameInput.props.defaultValue }),
  )
  check('the draft has Save and Discard', findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save').length === 1 && findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-discard').length === 1)

  // Switching kind with the draft open is refused, not silently applied.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'tester')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  check(
    'switching kind with an unsaved draft is refused with a readable notice',
    textOf(findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]).indexOf('还有未保存的修改') >= 0 &&
      findAll(tree, (node) => node.props && node.props['data-kind'] === 'tester' && node.props['aria-selected'] === 'true').length === 0,
  )
  // An invalid name is refused before any request.
  const beforeBadName = posts.length
  draftNameInput.props.onChange({ target: { value: 'Bad Name' } })
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  check('an invalid copy name is refused before any request', posts.length === beforeBadName && textOf(findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]).indexOf('角色名不合法') >= 0)
  // A name that already exists is refused with the host's own code.
  draftNameInput.props.onChange({ target: { value: 'worker' } })
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  check('an already-used copy name is refused before any request', posts.length === beforeBadName && textOf(findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]).indexOf('角色已存在') >= 0)
  // Switching current use with the draft open is refused as well.
  const draftUseSelect = findAll(editor, (node) => node.type === 'select' && node.props['data-role-use-select'] === 'true')[0]
  draftUseSelect.props.onChange({ target: { value: 'worker' } })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  check('switching current use with an unsaved draft is refused', posts.length === beforeBadName && textOf(findAll(tree, (node) => node.props && node.props['data-editor'] === 'true')[0]).indexOf('还有未保存的修改') >= 0)
  // Discard is explicit and clears the draft.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-discard')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  check('Discard clears the draft', findAll(tree, (node) => node.props && node.props['data-editor-identity'] === 'true')[0].props['data-draft'] === 'false')

  // Fork on tester, refuse the create once, then retry: save creates + binds + replaces.
  findAll(tree, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'tester')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  identity = findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  const draftName = identity.props['data-profile']
  postReply = { ok: false, code: 'invalid-role-skills', message: 'skills must be a list' }
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  check('a refused create keeps the draft and reports the host error', findAll(editor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0].props['data-draft'] === 'true' && textOf(editor).indexOf('技能必须是列表') >= 0)

  postReply = null
  const retryBefore = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  await flush()
  const retryPosts = posts.slice(retryBefore).filter((post) => post.action !== 'rolesPreview')
  check(
    'saving the draft creates, binds and replaces it in one flow',
    retryPosts.length === 3 && retryPosts[0].action === 'rolesCreate' && retryPosts[0].name === draftName && retryPosts[1].action === 'rolesBind' && retryPosts[1].stage === 'test' && retryPosts[1].profile === draftName && retryPosts[2].action === 'rolesReplace' && retryPosts[2].name === 'tester',
    JSON.stringify(retryPosts),
  )

  // Delete the existing custom reviewer copy (in use): the default takes over.
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'reviewer')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  postReply = { ok: true, config: HOST.roles, bound: { stage: 'review', profile: 'reviewer' }, source: 'file', snapshot: HOST }
  const deleteBefore = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'rolesDelete')[0].props.onClick()
  await flush()
  await flush()
  const deletePosts = posts.slice(deleteBefore).filter((post) => post.action !== 'rolesPreview')
  check(
    'deleting the copy in use falls back to the built-in default and applies it',
    deletePosts.length === 3 && deletePosts[0].action === 'rolesDelete' && deletePosts[0].name === 'godot-reviewer' && deletePosts[1].action === 'rolesBind' && deletePosts[1].profile === 'reviewer' && deletePosts[2].action === 'rolesReplace' && deletePosts[2].name === 'reviewer',
    JSON.stringify(deletePosts),
  )
  HOST.roles = Object.assign({}, HOST.roles, { stages: Object.assign({}, HOST.roles.stages, { review: 'godot-reviewer' }) })
  postReply = null
}


// ── a create answer never clobbers a newer editor identity ──────────────────
{
  let releasePost = null
  postGate = new Promise(function (resolveGate) { releasePost = resolveGate })
  let tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  let editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props.onClick()
  // The create is still in flight; switch kind, then let the answer land.
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'reviewer')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  releasePost()
  postGate = null
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  const settledEditor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const settledIdentity = findAll(settledEditor, (node) => node.props && node.props['data-editor-identity'] === 'true')[0]
  check(
    'a late create answer does not drag the editor back to the old kind',
    settledIdentity.props['data-kind'] === 'reviewer' && settledIdentity.props['data-draft'] === 'false',
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
      reviewerSections.map((node) => node.props['data-role-section-group']).join(',') === 'role,role,role,template,task,fixed,skills' &&
      textOf(reviewerText).indexOf('Profile instructions:\ngodot-reviewer') >= 0,
    reviewerSections.map((node) => node.props['data-role-section-group']).join(','),
  )
  check(
    'the section labels use user language, not implementation names',
    findAll(injectedCol, (node) => node.props && node.props['data-role-section-label'] !== undefined).map((node) => textOf(node)).join(',') === '角色与阶段,你的提示词,任务数据,权限边界与结论,技能',
    reviewerSections.map((node) => textOf(node)).join(' | '),
  )

  // Save a custom profile: the template and skills go through rolesUpdate, and
  // because this copy is the current use, the running instances are replaced in
  // the SAME click.
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.type === 'textarea' && node.props['data-field'] === 'template')[0].props.ref.current = { value: 'Review {{SPEC}} and {{SPEC}}.' }
  findAll(editor, (node) => node.props && node.props['data-field'] === 'skills')[0].props.ref.current = { value: 'dsh-plugin-workflow' }
  const customSaveBefore = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  await flush()
  const customSavePosts = posts.slice(customSaveBefore).filter((post) => post.action !== 'rolesPreview')
  check(
    'saving the current custom profile updates it and replaces the running instances in one action',
    customSavePosts.length === 2 &&
      customSavePosts[0].action === 'rolesUpdate' &&
      customSavePosts[0].name === 'godot-reviewer' &&
      customSavePosts[0].profile.prompt === 'Review {{SPEC}} and {{SPEC}}.' &&
      customSavePosts[0].profile.skills.join(',') === 'dsh-plugin-workflow' &&
      customSavePosts[1].action === 'rolesReplace' &&
      customSavePosts[1].name === 'reviewer',
    JSON.stringify(customSavePosts),
  )

  // The implement stage has no live instance in this fixture: Fork still creates
  // and binds the copy, and the panel says it takes effect on the next dispatch.
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-kind' && node.props['data-kind'] === 'worker')[0].props.onClick()
  tree = withHooks(panel, { initialView: 'roles' })
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const workerForkBefore = posts.length
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-fork')[0].props.onClick()
  await flush()
  await flush()
  // The fork is a draft; saving it creates the copy and binds it (no live worker).
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  findAll(editor, (node) => node.props && node.props['data-action'] === 'role-editor-save')[0].props.onClick()
  await flush()
  await flush()
  tree = withHooks(panel, { initialView: 'roles' })
  editor = findAll(findAll(tree, (node) => node.props && node.props['data-card'] === 'editor')[0], (node) => node.props && node.props['data-editor'] === 'true')[0]
  const workerForkPosts = posts.slice(workerForkBefore).filter((post) => post.action !== 'rolesPreview')
  check(
    'forking the implement stage creates and binds the copy without a replace, and says it lands next dispatch',
    workerForkPosts.length === 2 &&
      workerForkPosts[0].action === 'rolesCreate' &&
      workerForkPosts[0].name.indexOf('worker-fork') === 0 &&
      workerForkPosts[1].action === 'rolesBind' &&
      workerForkPosts[1].stage === 'implement' &&
      workerForkPosts[1].profile === workerForkPosts[0].name &&
      textOf(editor).indexOf('没有在跑实例，下次派发生效。') >= 0,
    JSON.stringify(workerForkPosts),
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
  // The reviewer profile's current skills seed the dialog.
  const reviewerSkillsField = findAll(editor, (node) => node.props && node.props['data-field'] === 'skills')[0]
  if (reviewerSkillsField !== undefined && reviewerSkillsField.props.ref.current !== null && reviewerSkillsField.props.ref.current !== undefined) reviewerSkillsField.props.ref.current.value = 'dsh-plugin-workflow'
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

// The manual file-lock page is gone: no locks tab, no lock actions left in the UI.
{
  const tree = withHooks(panel, { initialView: 'board' })
  await flush()
  const tabs = findAll(tree, (node) => node.props && node.props['data-view'] !== undefined)
  check('the file-lock tab is removed from the panel', tabs.every((node) => node.props['data-view'] !== 'locks') && tabs.length === 5, JSON.stringify(tabs.map((node) => node.props['data-view'])))
  check('and the old locks page copy is not rendered anywhere', textOf(tree).indexOf('等待者') < 0 && textOf(tree).indexOf('当前没有文件锁') < 0)
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

// Detail page: stage spine, "where it is now" and the summary column.
{
  async function openDetail(title) {
    const boardTree = withHooks(panel, { initialView: 'board' })
    await flush()
    const cards = findAll(boardTree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card')
    const card = cards.filter((entry) => textOf(entry).indexOf(title) >= 0)[0]
    card.props.onClick()
    const tree = withHooks(panel, { initialView: 'board' })
    await flush()
    return findAll(tree, (node) => node.props && node.props['data-detail-overlay'] === 'true')[0]
  }
  function stageOf(drawer, key) {
    return findAll(drawer, (node) => node.props && node.props['data-stage'] === key)[0]
  }

  // ── overlay shell: wide card, mask/×/Esc close, container breakpoints ──
  {
    const originalWidth = Object.getOwnPropertyDescriptor(globalThis.window, 'innerWidth')
    const setWidth = function (value) { Object.defineProperty(globalThis.window, 'innerWidth', { value: value, configurable: true, writable: true }) }
    const restoreWidth = function () {
      if (originalWidth === undefined) delete globalThis.window.innerWidth
      else Object.defineProperty(globalThis.window, 'innerWidth', originalWidth)
    }
    setWidth(1440)
    const wideDrawer = await openDetail('Tail output feature')
    check(
      'the detail opens in a wide overlay (mask + centered panel), not the old 368px drawer',
      wideDrawer !== undefined && wideDrawer.props['data-detail-overlay'] === 'true' && wideDrawer.props['data-detail-width'] === 'wide' &&
        findAll(wideDrawer, (node) => node.props && node.props.className === 'gbt-detailpanel').length === 1 &&
        findAll(wideDrawer, (node) => node.props && node.props['data-detail-mask'] === 'true').length === 1,
      wideDrawer && JSON.stringify(wideDrawer.props['data-detail-width']),
    )
    check(
      'a wide container renders the two-column layout',
      wideDrawer.props['data-detail-layout'] === 'two-column' && findAll(wideDrawer, (node) => node.props && node.props['data-detail-layout'] === 'two-column').length >= 1,
      wideDrawer.props['data-detail-layout'],
    )
    const mask = findAll(wideDrawer, (node) => node.props && node.props['data-detail-mask'] === 'true')[0]
    mask.props.onClick()
    await flush()
    const closedByMask = withHooks(panel, { initialView: 'board' })
    await flush()
    check('clicking the mask closes the overlay', findAll(closedByMask, (node) => node.props && node.props['data-detail-overlay'] === 'true').length === 0)

    setWidth(800)
    const compactDrawer = await openDetail('Tail output feature')
    check(
      'a 800px container uses the compact two-column layout',
      compactDrawer.props['data-detail-width'] === 'narrow' && compactDrawer.props['data-detail-layout'] === 'compact' &&
        findAll(compactDrawer, (node) => node.props && node.props['data-detail-stages'] === 'row').length === 1,
      JSON.stringify({ width: compactDrawer.props['data-detail-width'], layout: compactDrawer.props['data-detail-layout'] }),
    )

    setWidth(420)
    const narrowDrawer = await openDetail('Tail output feature')
    check(
      'a 420px container uses one column with a wrapped stage grid',
      narrowDrawer.props['data-detail-width'] === 'narrow' && narrowDrawer.props['data-detail-layout'] === 'single' &&
        findAll(narrowDrawer, (node) => node.props && node.props['data-detail-stages'] === 'wrap').length === 1 &&
        findAll(narrowDrawer, (node) => node.props && node.props['data-detail-summary'] === 'one-line').length === 1,
      JSON.stringify({ layout: narrowDrawer.props['data-detail-layout'] }),
    )
    check(
      'the narrow layout has no vertical (writing-mode) label column',
      findAll(narrowDrawer, (node) => node.props && node.props.style !== undefined && node.props.style !== null && (node.props.style.writingMode !== undefined || node.props.style.writingMode === 'vertical-rl')).length === 0 &&
        findAll(narrowDrawer, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('vertical') >= 0).length === 0,
      'no vertical nodes expected',
    )
    narrowDrawer.props.onKeyDown({ key: 'Escape' })
    await flush()
    const closedByEsc = withHooks(panel, { initialView: 'board' })
    await flush()
    check('Escape closes the overlay', findAll(closedByEsc, (node) => node.props && node.props['data-detail-overlay'] === 'true').length === 0)

    check(
      'the 420px layout still renders the spec/acceptance summary (collapsed by default)',
      findAll(narrowDrawer, (node) => node.props && node.props['data-detail-spec'] === 'collapsed').length === 1 &&
        findAll(narrowDrawer, (node) => node.props && node.props['data-detail'] === 'summary').length === 2,
      JSON.stringify(findAll(narrowDrawer, (node) => node.props && node.props['data-detail'] === 'summary').map((node) => node.props['data-detail-summary'])),
    )

    check(
      'the single layout does not duplicate elapsed/rounds below the one-line card',
      (function () {
        const oneLine = findAll(narrowDrawer, (node) => node.props && node.props['data-detail-summary'] === 'one-line')[0]
        const details = findAll(narrowDrawer, (node) => node.props && node.props['data-detail-summary'] === 'details')[0]
        return oneLine !== undefined && details !== undefined && textOf(oneLine).indexOf('用时') >= 0 && textOf(details).indexOf('用时') < 0
      })(),
      JSON.stringify(findAll(narrowDrawer, (node) => node.props && node.props['data-detail-summary'] !== undefined).map((node) => textOf(node))),
    )

    setWidth(760)
    const midNarrowDrawer = await openDetail('Tail output feature')
    check(
      'a 760px viewport (full-screen overlay, no padding) is compact, not single',
      midNarrowDrawer.props['data-detail-width'] === 'narrow' && midNarrowDrawer.props['data-detail-layout'] === 'compact',
      JSON.stringify({ width: midNarrowDrawer.props['data-detail-width'], layout: midNarrowDrawer.props['data-detail-layout'] }),
    )

    setWidth(920)
    const boundaryDrawer = await openDetail('Tail output feature')
    check(
      'the breakpoint uses the panel content width (920 viewport -> 824 container -> compact)',
      boundaryDrawer.props['data-detail-width'] === 'narrow' && boundaryDrawer.props['data-detail-layout'] === 'compact',
      JSON.stringify({ width: boundaryDrawer.props['data-detail-width'], layout: boundaryDrawer.props['data-detail-layout'] }),
    )

    const css = styleTags.map((tag) => String(tag.textContent || '')).join('\n')
    check(
      'the detail stat value is 13px in the registered CSS (no oversized number)',
      css.indexOf('.gbt-detailstat b{font-size:13px') >= 0 && css.indexOf('.gbt-detailstat b{font-size:18px') < 0,
      (css.match(/gbt-detailstat b\{[^}]*\}/g) || []).join(' | '),
    )

    restoreWidth()
  }

  const doneDrawer = await openDetail('Tail output feature')
  check('the detail page is a stage spine, an event body and a summary column', doneDrawer !== undefined &&
    findAll(doneDrawer, (node) => node.props && node.props['data-detail'] === 'stages').length === 1 &&
    findAll(doneDrawer, (node) => node.props && node.props['data-detail'] === 'events').length === 1 &&
    findAll(doneDrawer, (node) => node.props && node.props['data-detail'] === 'summary').length === 1,
    doneDrawer && textOf(doneDrawer).slice(0, 200))
  const fiveStages = findAll(doneDrawer, (node) => node.props && node.props['data-stage'] !== undefined)
  check('the spine has the five phases in order', fiveStages.map((node) => node.props['data-stage']).join(',') === 'pending,running,reviewing,testing,done', JSON.stringify(fiveStages.map((node) => node.props['data-stage'])))
  check('a done task shows every phase done, with rounds on review and test', fiveStages.every((node) => node.props['data-state'] === 'done') && stageOf(doneDrawer, 'reviewing').props['data-rounds'] === '1' && stageOf(doneDrawer, 'testing').props['data-rounds'] === '1', JSON.stringify(fiveStages.map((node) => [node.props['data-stage'], node.props['data-state'], node.props['data-rounds']])))
  const doneText = textOf(doneDrawer)
  check('the body lists the submit, review, test and merge conclusions', ['提交', '评审通过', '测试通过', '已合并'].every((label) => doneText.indexOf(label) >= 0), doneText.slice(0, 400))
  const mergeEvent = findAll(doneDrawer, (node) => node.props && node.props['data-detail-event'] === 'merge')[0]
  check(
    'the merge row carries the target branch and the MERGE commit (merge.mergeCommit, not the tested head)',
    mergeEvent !== undefined && textOf(mergeEvent).indexOf('feat/task-center-v2') >= 0 && textOf(mergeEvent).indexOf('fedcba0') >= 0 && textOf(mergeEvent).indexOf('abcdef1') < 0,
    mergeEvent && textOf(mergeEvent),
  )
  check('the summary column shows elapsed time, rounds and attempts', doneText.indexOf('用时') >= 0 && doneText.indexOf('尝试') >= 0 && doneText.indexOf('1 / 3') >= 0, doneText.slice(-400))
  check('the spec/acceptance block is collapsed by default', findAll(doneDrawer, (node) => node.props && node.props['data-detail-spec'] === 'collapsed').length === 1 && findAll(doneDrawer, (node) => node.props && node.props['data-detail-spec'] === 'full').length === 0)
  check('all raw fields stay reachable in the folded field block', doneText.indexOf('全部字段') >= 0 && doneText.indexOf('abcdef1234567890') >= 0, doneText.slice(-400))

  const runningDrawer = await openDetail('Build damage system')
  check('a running task highlights the implement phase', stageOf(runningDrawer, 'running') !== undefined && stageOf(runningDrawer, 'running').props['data-state'] === 'active' && stageOf(runningDrawer, 'pending').props['data-state'] === 'done', JSON.stringify(fiveStages.map((node) => node.props['data-state'])))
  const reasonNodes = findAll(runningDrawer, (node) => node.props && node.props['data-detail-reason'] !== undefined)
  check('the review rejection reason is rendered inline from review.reasons', reasonNodes.length === 1 && textOf(reasonNodes[0]).indexOf('please cover the edge case') >= 0 && reasonNodes[0].props['data-detail-reason'] === 'changes-requested', reasonNodes[0] && textOf(reasonNodes[0]))
  check('the reviewer shows as the member name, not the @id', textOf(runningDrawer).indexOf('reviewer-1') >= 0 && textOf(runningDrawer).indexOf('@reviewer') < 0, textOf(runningDrawer).slice(0, 300))
  check('the tester shows as the member name too', textOf(runningDrawer).indexOf('tester-1') >= 0 && textOf(runningDrawer).indexOf('@tester') < 0, textOf(runningDrawer).slice(0, 300))
  check('the long test evidence is not rendered by default', findAll(runningDrawer, (node) => node.props && node.props['data-detail-evidence'] === 'full').length === 0 && textOf(runningDrawer).indexOf('P'.repeat(200)) < 0, textOf(runningDrawer).slice(0, 300))
  const evidenceButton = findAll(runningDrawer, (node) => node.props && node.props['data-action'] === 'detail-evidence')[0]
  check('a view-full control is offered for the evidence', evidenceButton !== undefined && textOf(evidenceButton).indexOf('查看全文') >= 0)
  evidenceButton.props.onClick()
  await flush()
  const evidenceTree = withHooks(panel, { initialView: 'board' })
  await flush()
  const reopenedRunning = findAll(evidenceTree, (node) => node.props && node.props['data-detail-overlay'] === 'true')[0]
  const evidenceFull = findAll(reopenedRunning, (node) => node.props && node.props['data-detail-evidence'] === 'full')[0]
  check('view full reveals the evidence text', evidenceFull !== undefined && textOf(evidenceFull).indexOf('deep stderr tail marker') >= 0, evidenceFull && textOf(evidenceFull).slice(0, 200))

  const runningTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
  const savedHistory = runningTask.history
  runningTask.history = [
    { from: 'running', to: 'reviewing', at: new Date(Date.now() - 20000).toISOString(), by: '@session-fixer', note: '' },
    { from: 'running', to: 'reviewing', at: new Date(Date.now() - 1000).toISOString(), by: '@session-fixer', note: 'fix after review' },
  ]
  const resubmitDrawer = await openDetail('Build damage system')
  const resubmitRow = findAll(resubmitDrawer, (node) => node.props && node.props['data-detail-event'] === 'resubmit')[0]
  check(
    'a resubmission after a review rejection adds the fix-and-resubmit line',
    resubmitRow !== undefined && textOf(resubmitDrawer).indexOf('修复后重新提交') >= 0,
    resubmitRow && textOf(resubmitRow),
  )
  runningTask.history = savedHistory

  // A realistic tool label ("session-" stripped, non-alphanumerics removed, 8 chars)
  // must resolve too, not just the kind fallback.
  const realTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
  const savedReview = realTask.review
  const savedTest = realTask.test
  realTask.review = Object.assign({}, savedReview, { by: '@reviewer1' })
  realTask.test = Object.assign({}, savedTest, { by: '@tester1' })
  const realisticDrawer = await openDetail('Build damage system')
  check(
    'realistic tool labels (@reviewer1/@tester1) resolve to the member names',
    textOf(realisticDrawer).indexOf('reviewer-1') >= 0 && textOf(realisticDrawer).indexOf('tester-1') >= 0 && textOf(realisticDrawer).indexOf('@reviewer1') < 0 && textOf(realisticDrawer).indexOf('@tester1') < 0,
    textOf(realisticDrawer).slice(0, 300),
  )
  realTask.review = savedReview
  realTask.test = savedTest

  // byName wins even when the roster is empty (the isolated-instance case).
  {
    const byNameTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const savedByReview = byNameTask.review
    const savedByTest = byNameTask.test
    const savedRoster = HOST.agents
    byNameTask.review = Object.assign({}, savedByReview, { by: '@7fb24394', byName: 'reviewer-1' })
    byNameTask.test = Object.assign({}, savedByTest, { by: '@b7cc6c31', byName: 'tester-1' })
    HOST.agents = { lead: null, members: [] }
    const byNameDrawer = await openDetail('Build damage system')
    const byNameText = textOf(byNameDrawer)
    check(
      'with an empty roster the review/test rows still show the written byName, never a bare @id',
      byNameText.indexOf('reviewer-1') >= 0 && byNameText.indexOf('tester-1') >= 0 && byNameText.indexOf('@7fb24394') < 0 && byNameText.indexOf('@b7cc6c31') < 0,
      byNameText.slice(0, 300),
    )
    HOST.agents = savedRoster
    byNameTask.review = savedByReview
    byNameTask.test = savedByTest
  }

  // Old submit history without byName falls back to 执行者 on the detail page.
  {
    const submitFallbackTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const savedSubmitHistory = submitFallbackTask.history
    const savedSubmitRoster = HOST.agents
    submitFallbackTask.history = [{ from: 'running', to: 'reviewing', at: new Date(Date.now() - 8000).toISOString(), by: '@aaaaaaaa', byName: null, note: 'submitted for review round 1' }]
    HOST.agents = { lead: null, members: [] }
    const submitFallbackDrawer = await openDetail('Build damage system')
    check(
      'an old submit row shows 执行者 for an unresolved author, never a bare @',
      textOf(submitFallbackDrawer).indexOf('执行者 aaaaaaaa') >= 0 && textOf(submitFallbackDrawer).indexOf('@aaaaaaaa') < 0,
      textOf(submitFallbackDrawer).slice(0, 300),
    )
    HOST.agents = savedSubmitRoster
    submitFallbackTask.history = savedSubmitHistory
  }

  // Review/test durations come from delivery, and queue wait is separate.
  {
    const metricTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const savedMetricReview = metricTask.review
    const savedMetricTest = metricTask.test
    const savedMetricHistory = metricTask.history
    const nowMs = Date.now()
    metricTask.history = [{ from: 'running', to: 'reviewing', at: new Date(nowMs - 180000).toISOString(), by: '@user', byName: '你', note: 'submitted' }]
    metricTask.review = Object.assign({}, savedMetricReview, { at: new Date(nowMs - 120000).toISOString(), deliveredAt: new Date(nowMs - 60000).toISOString() })
    metricTask.test = Object.assign({}, savedMetricTest, { at: new Date(nowMs - 30000).toISOString(), deliveredAt: new Date(nowMs - 20000).toISOString() })
    const metricDrawer = await openDetail('Build damage system')
    const metricsNode = findAll(metricDrawer, (node) => node.props && node.props['data-detail-metrics'] === 'true')[0]
    check(
      'the detail shows delivery-based review/test durations and the queue wait separately',
      metricsNode !== undefined && textOf(metricsNode).indexOf('评审') >= 0 && textOf(metricsNode).indexOf('测试') >= 0 && textOf(metricsNode).indexOf('排队') >= 0,
      metricsNode && textOf(metricsNode),
    )
    metricTask.review = savedMetricReview
    metricTask.test = savedMetricTest
    metricTask.history = savedMetricHistory
  }

  // Target branch is visible on the card, the detail and the task form.
  {
    const targetTask = HOST.tasks.filter((entry) => entry.id === 'T-1')[0]
    const savedTarget = targetTask.target
    const savedBase = targetTask.base
    targetTask.target = 'main'
    targetTask.base = 'abcdef1234567890'
    let targetTree = withHooks(panel, { initialView: 'board' })
    await flush()
    targetTree = withHooks(panel, { initialView: 'board' })
    const targetCard = findAll(targetTree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card' && textOf(node).indexOf('Build damage system') >= 0)[0]
    check(
      'the task card shows its target branch',
      targetCard !== undefined && findAll(targetCard, (node) => node.props && node.props['data-target-branch'] === 'main').length === 1,
      targetCard && textOf(targetCard),
    )
    const targetDrawer = await openDetail('Build damage system')
    const targetLine = findAll(targetDrawer, (node) => node.props && node.props['data-detail-target'] === 'true')[0]
    check(
      'the detail summary shows base → target',
      targetLine !== undefined && textOf(targetLine).indexOf('目标分支') >= 0 && textOf(targetLine).indexOf('main') >= 0 && textOf(targetLine).indexOf('abcdef1234') >= 0,
      targetLine && textOf(targetLine),
    )
    const clientSource = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
    check(
      'the settings form exposes the default target branch',
      clientSource.indexOf("'data-field': 'default-target'") >= 0 && clientSource.indexOf('defaultTarget') >= 0,
    )
    check(
      'the task form offers an optional target field with a follow-the-default placeholder',
      clientSource.indexOf("'data-field': 'target-branch'") >= 0 && clientSource.indexOf('targetFollowDefault') >= 0 && clientSource.indexOf('target: targetBranch.current') >= 0,
    )
    targetTask.target = savedTarget
    targetTask.base = savedBase
  }

  // Host failures are localized by code; an unknown code falls back to the message.
  {
    const savedFetch = globalThis.fetch
    globalThis.fetch = async () => ({ json: async () => ({ ok: false, code: 'unknown-project', params: {} }) })
    let zhTree = withHooks(panel, { initialView: 'board' })
    await flush()
    zhTree = withHooks(panel, { initialView: 'board' })
    check(
      'the unknown-project banner is Chinese in the zh UI',
      textOf(zhTree).indexOf('这个会话还没有绑定项目') >= 0 && textOf(zhTree).indexOf('This session is not bound') < 0,
      textOf(zhTree).slice(0, 220),
    )
    locale = 'en'
    let enTree = withHooks(panel, { initialView: 'board' })
    await flush()
    enTree = withHooks(panel, { initialView: 'board' })
    check(
      'the same banner is English in the en UI',
      textOf(enTree).indexOf('This session is not bound') >= 0 && textOf(enTree).indexOf('这个会话还没有绑定项目') < 0,
      textOf(enTree).slice(0, 220),
    )
    locale = 'zh'
    globalThis.fetch = async () => ({ json: async () => ({ ok: false, message: 'legacy host says hi' }) })
    let actionTree = withHooks(panel, { initialView: 'board' })
    await flush()
    const refreshButton = findAll(actionTree, (node) => node.type === 'button' && textOf(node).indexOf('刷新') >= 0)[0]
    if (refreshButton !== undefined) refreshButton.props.onClick()
    await flush()
    await flush()
    actionTree = withHooks(panel, { initialView: 'board' })
    check(
      'an unknown code / legacy host falls back to the Host message',
      textOf(actionTree).indexOf('legacy host says hi') >= 0,
      textOf(actionTree).slice(0, 260),
    )
    globalThis.fetch = savedFetch
    const recoveredTree = withHooks(panel, { initialView: 'board' })
    await flush()
    const recoveredRefresh = findAll(recoveredTree, (node) => node.type === 'button' && textOf(node).indexOf('刷新') >= 0)[0]
    if (recoveredRefresh !== undefined) recoveredRefresh.props.onClick()
    await flush()
    await flush()
    withHooks(panel, { initialView: 'board' })
    await flush()
  }

  // Elapsed is the finished span, not the growing age.
  const doneTask = HOST.tasks.filter((entry) => entry.id === 'T-3')[0]
  const elapsedDrawer = await openDetail('Tail output feature')
  check(
    'a finished task reports the created-to-merge span, not its age',
    textOf(elapsedDrawer).indexOf('2 分钟') >= 0,
    textOf(elapsedDrawer).slice(-300),
  )

  // Stage completions: implement ends at review start, review at test start, test/merge at done/merge.at.
  const savedWtHistory = doneTask.history
  const stageTimes = {
    running: new Date(Date.now() - 60000).toISOString(),
    reviewing: new Date(Date.now() - 50000).toISOString(),
    testing: new Date(Date.now() - 40000).toISOString(),
    done: new Date(Date.now() - 30000).toISOString(),
  }
  doneTask.history = [
    { from: 'pending', to: 'running', at: stageTimes.running, by: '@session-fixer', note: '' },
    { from: 'running', to: 'reviewing', at: stageTimes.reviewing, by: '@session-fixer', note: '' },
    { from: 'reviewing', to: 'testing', at: stageTimes.testing, by: '@session-reviewer-1', note: '' },
    { from: 'testing', to: 'done', at: stageTimes.done, by: '@session-tester-1', note: '' },
  ]
  const timesDrawer = await openDetail('Tail output feature')
  check(
    'the spine shows completion times (dispatch ends at running, implement at review start, review at test start)',
    stageOf(timesDrawer, 'pending').props['data-at'] === stageTimes.running &&
      stageOf(timesDrawer, 'running').props['data-at'] === stageTimes.reviewing &&
      stageOf(timesDrawer, 'reviewing').props['data-at'] === stageTimes.testing &&
      stageOf(timesDrawer, 'testing').props['data-at'] === stageTimes.done,
    JSON.stringify(['pending', 'running', 'reviewing', 'testing', 'done'].map((key) => [key, stageOf(timesDrawer, key).props['data-at']])),
  )
  doneTask.history = savedWtHistory

  // Host check record lives on test.hostCheck with exitCode/timedOut, not on task.hostCheck.ok.
  const savedVerify = doneTask.verify
  const savedHostCheck = doneTask.test.hostCheck
  doneTask.verify = { command: 'npm run verify', timeoutMs: 600000 }
  doneTask.test = Object.assign({}, doneTask.test, { hostCheck: { command: 'npm run verify', exitCode: 0, timedOut: false, durationMs: 21000 } })
  const passDrawer = await openDetail('Tail output feature')
  const passNode = findAll(passDrawer, (node) => node.props && node.props['data-detail-hostcheck'] !== undefined)[0]
  check('a host check with exitCode 0 reads as passed', passNode !== undefined && textOf(passDrawer).indexOf('通过') >= 0, passNode && textOf(passNode))
  doneTask.test = Object.assign({}, doneTask.test, { hostCheck: { command: 'npm run verify', exitCode: 1, timedOut: false, durationMs: 21000 } })
  const failDrawer = await openDetail('Tail output feature')
  check('a non-zero host check reads as failed', textOf(failDrawer).indexOf('失败') >= 0, textOf(failDrawer).slice(-200))
  doneTask.verify = savedVerify
  doneTask.test = Object.assign({}, doneTask.test, { hostCheck: savedHostCheck })

  const savedAgents = HOST.agents
  const savedTeamView = HOST.team
  HOST.agents = { lead: null, members: [] }
  HOST.team = { ok: false, members: [] }
  const unmappedDrawer = await openDetail('Build damage system')
  check(
    'an @id with no roster match shows the semantic role fallback, never a bare @',
    textOf(unmappedDrawer).indexOf('评审者 reviewer') >= 0 && textOf(unmappedDrawer).indexOf('@reviewer') < 0,
    textOf(unmappedDrawer).slice(0, 300),
  )
  HOST.agents = savedAgents
  HOST.team = savedTeamView

  const reviewingDrawer = await openDetail('Review the crate API')
  check('a reviewing task highlights the review phase', stageOf(reviewingDrawer, 'reviewing').props['data-state'] === 'active', JSON.stringify(findAll(reviewingDrawer, (node) => node.props && node.props['data-stage'] !== undefined).map((node) => node.props['data-state'])))
  const testingDrawer = await openDetail('Test the crate API')
  check('a testing task highlights the test phase', stageOf(testingDrawer, 'testing').props['data-state'] === 'active', JSON.stringify(findAll(testingDrawer, (node) => node.props && node.props['data-stage'] !== undefined).map((node) => node.props['data-state'])))
  const blockedDrawer = await openDetail('Stuck task')
  check('a blocked task marks the reached phase as interrupted', findAll(blockedDrawer, (node) => node.props && node.props['data-state'] === 'interrupted').length === 1 && findAll(blockedDrawer, (node) => node.props && node.props['data-detail-interrupt'] !== undefined).length === 1, JSON.stringify(findAll(blockedDrawer, (node) => node.props && node.props['data-stage'] !== undefined).map((node) => [node.props['data-stage'], node.props['data-state']])))
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

  // Fork exists only on a built-in page now: switch to tester and use its CTA.
  clickAction(rtree, 'role-editor-kind', 'data-kind', 'tester')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  clickAction(rtree, 'role-editor-fork')
  await flush()
  rtree = reuse.render(panel2, { initialView: 'roles' })
  area = fieldOf(rtree, 'template')
  let reuseIdentity = findAll(editorOf(rtree), function (node) { return node.props && node.props['data-editor-identity'] === 'true' })[0]
  check(
    'Fork opens a named draft with an editable control on the source prompt',
    reuseIdentity !== undefined && reuseIdentity.props['data-draft'] === 'true' && reuseIdentity.props['data-profile'].indexOf('tester-fork') === 0 && valueOf(area) === TESTER_DEFAULT_PROMPT && dirtyOf(area) === false,
    JSON.stringify({ value: valueOf(area), identity: reuseIdentity && reuseIdentity.props }),
  )
  // Saving the draft is what creates + applies it. The bind/replace replies carry
  // the host snapshot with the new copy, so no refresh button is needed.
  const draftName = reuseIdentity.props['data-profile']
  const draftProfile = { name: draftName, role: 'tester', stage: 'test', instances: 1, skills: [], context: 'fresh', permissions: [], prompt: TESTER_DEFAULT_PROMPT }
  HOST.roles = Object.assign({}, HOST.roles, {
    stages: Object.assign({}, HOST.roles.stages, { test: draftName }),
    profiles: Object.assign({}, HOST.roles.profiles, { [draftName]: draftProfile }),
  })
  postReply = [
    { ok: true, config: HOST.roles, profile: draftProfile, source: 'file', snapshot: HOST },
    { ok: true, config: HOST.roles, bound: { stage: 'test', profile: draftName }, source: 'file', snapshot: HOST },
    { ok: true, replaced: [{ name: 'tester-1', reason: 'drained' }], source: 'file', snapshot: HOST },
  ]
  clickAction(rtree, 'role-editor-save')
  await flush()
  await flush()
  rtree = reuse.render(panel2, { initialView: 'roles' })
  reuseIdentity = findAll(editorOf(rtree), function (node) { return node.props && node.props['data-editor-identity'] === 'true' })[0]
  const created = posts.filter(function (post) { return post.action === 'rolesCreate' }).pop()
  check('the Fork is created and applied in one flow', created !== undefined && created.name === reuseIdentity.props['data-profile'] && reuseIdentity.props['data-draft'] === 'false', JSON.stringify({ created: created, identity: reuseIdentity && reuseIdentity.props }))
  area = fieldOf(rtree, 'template')

  // Saving the current copy updates it AND replaces the running instances; the
  // real replace answer (replaced/source) is what the banner shows.
  area.props.ref.current.value = 'forked body'
  postReply = [
    { ok: true, config: HOST.roles, profile: Object.assign({ name: created.name }, created.profile, { prompt: 'forked body' }), source: 'file', snapshot: HOST },
    { ok: true, replaced: [{ name: 'tester-1', reason: 'drained' }], source: 'file', snapshot: HOST },
  ]
  clickAction(rtree, 'role-editor-save')
  await flush()
  await flush()
  const savePost = posts.filter(function (post) { return post.action === 'rolesUpdate' }).pop()
  check('saving the forked copy sends rolesUpdate with the edited prompt', savePost !== undefined && savePost.name === created.name && savePost.profile.prompt === 'forked body', JSON.stringify(savePost))
  HOST.roles = Object.assign({}, HOST.roles, {
    stages: Object.assign({}, HOST.roles.stages, { test: created.name }),
    profiles: Object.assign({}, HOST.roles.profiles, {
      [created.name]: Object.assign({}, HOST.roles.profiles[created.name], { prompt: 'forked body' }),
    }),
  })
  rtree = reuse.render(panel2, { initialView: 'roles' })
  await flush()
  rtree = reuse.render(panel2, { initialView: 'roles' })
  area = fieldOf(rtree, 'template')
  reuseIdentity = findAll(editorOf(rtree), function (node) { return node.props && node.props['data-editor-identity'] === 'true' })[0]
  check(
    'a successful save retargets the editor at the saved copy',
    reuseIdentity.props['data-profile'] === created.name && reuseIdentity.props['data-draft'] === 'false' && valueOf(area) === 'forked body',
    JSON.stringify({ identity: reuseIdentity.props, value: valueOf(area), dirty: dirtyOf(area) }),
  )
  const savedBanner = findAll(editorOf(rtree), function (node) { return node.props && node.props['data-role-result'] === 'ok' })[0]
  check('the real save+replace outcome is shown inside the editor', savedBanner !== undefined && textOf(savedBanner).indexOf('已替换') >= 0 && textOf(savedBanner).indexOf('来源') >= 0, savedBanner && textOf(savedBanner))
  clickAction(rtree, 'role-editor-kind', 'data-kind', 'worker')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  check(
    'switching kind clears the previous identity banner',
    findAll(editorOf(rtree), function (node) { return node.props && node.props['data-role-result'] !== undefined }).length === 0,
    textOf(editorOf(rtree)).slice(0, 200),
  )

  // A FAILED save keeps the typed value on the same control and is readable.
  clickAction(rtree, 'role-editor-kind', 'data-kind', 'tester')
  rtree = reuse.render(panel2, { initialView: 'roles' })
  area = fieldOf(rtree, 'template')
  area.props.ref.current.value = 'draft body kept'
  postReply = { ok: false, code: 'invalid-role-prompt', message: 'invalid prompt' }
  clickAction(rtree, 'role-editor-save')
  await flush()
  rtree = reuse.render(panel2, { initialView: 'roles' })
  area = fieldOf(rtree, 'template')
  const failedIdentity = findAll(editorOf(rtree), function (node) { return node.props && node.props['data-editor-identity'] === 'true' })[0]
  check(
    'a failed save keeps the typed value and creates no draft',
    failedIdentity.props['data-draft'] === 'false' && valueOf(area) === 'draft body kept' && dirtyOf(area) === true,
    JSON.stringify({ identity: failedIdentity.props, value: valueOf(area), dirty: dirtyOf(area) }),
  )
  check('a failed save is readable in the editor', textOf(editorOf(rtree)).indexOf('指令过长或不合法') >= 0, textOf(editorOf(rtree)).slice(0, 240))
  postReply = null


  disposers2.slice().reverse().forEach(function (disposer) { disposer() })
}

// ── the visual-check note uses selectors that really exist ────────────────
{
  const note = readFileSync(fileURLToPath(new URL('../../.agents/notes/design/visual-check.md', import.meta.url)), 'utf8')
  const selectors = [
    '[data-panel="task-center"]',
    '[data-panel-root="task-center"]',
    '[data-view="roles"]',
    '[data-roles-tab="worker"]',
    '[data-roles-tab="tester"]',
    '[data-roles-tab="reviewer"]',
    '[data-roles-pane="raw"]',
    '[data-roles-pane="injected"]',
    'input[placeholder="项目目录的绝对路径"]',
    '[data-project-source="session"]',
    '[data-project-mismatch="true"]',
    '[data-panel-session]',
    'data-session-source="host"',
    'data-session-source="window"',
    '[data-action="use-current-project"]',
    '[data-action="switch-to-session-project"]',
    '打开项目',
    'key Escape',
    'harnessStart',
    'harnessStop',
  ]
  check(
    'the visual-check note documents only real, grep-able selectors',
    selectors.every((selector) => note.indexOf(selector) >= 0) &&
      note.indexOf(':has-text(') < 0 &&
      note.indexOf('.investigate/visual/roles') < 0 &&
      note.indexOf('waitfor') >= 0 &&
      note.indexOf('wait 500') >= 0 &&
      note.indexOf('预览版说明') >= 0 &&
      note.indexOf('继续') >= 0 &&
      ['roles-worker.png', 'roles-tester.png', 'roles-reviewer.png'].every((name) => note.indexOf(name) >= 0) &&
      note.indexOf('click [data-panel="task-center"]') < note.indexOf('fill input[placeholder="项目目录的绝对路径"]') &&
      (function () {
        const blocks = note.split('oil_ui_shoot({').slice(1).map((part) => part.slice(0, part.indexOf('})')))
        return ['roles-worker.png', 'roles-tester.png', 'roles-reviewer.png'].every(function (name) {
          const found = blocks.filter((part) => part.indexOf(name) >= 0)[0]
          const block = found === undefined ? undefined : found.split('\\"').join('"')
          return block !== undefined &&
            block.indexOf('click [data-panel="task-center"]') >= 0 &&
            block.indexOf('click [data-view="roles"]') >= 0 &&
            block.indexOf('[data-roles-tab="' + name.replace('roles-', '').replace('.png', '') + '"]') >= 0
        })
      })(),
    JSON.stringify(selectors.filter((selector) => note.indexOf(selector) < 0)),
  )
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

// ── T-83: done column folds to 5, "view all" drawer pages/searches, state persists ──
{
  const COLUMNS_KEY = 'godotBridge.taskCenter.columns'
  const t83SavedFetch = globalThis.fetch
  STORAGE.delete(COLUMNS_KEY)
  const day = 24 * 60 * 60 * 1000
  const nowMs = Date.now()
  const doneTasks = Array.from({ length: 120 }).map(function (value, index) {
    const id = 'D-' + String(index + 1)
    return Object.assign({}, HOST.tasks[0], {
      id: id,
      title: 'Done card ' + String(index + 1),
      status: 'done',
      updatedAt: new Date(index < 40 ? nowMs - index * 60 * 1000 : index < 80 ? nowMs - day : nowMs - 3 * day).toISOString(),
    })
  })
  const doneHost = Object.assign({}, HOST, { tasks: doneTasks, counts: Object.assign({}, HOST.counts, { done: 120 }) })
  const listCalls = []
  const detailCalls = []
  let listMode = 'ok'
  globalThis.fetch = async function (url, options) {
    if (options !== undefined && options.method === 'POST') return { json: async () => ({ ok: true, snapshot: doneHost }) }
    const text = String(url)
    if (text.indexOf('/list?') >= 0) {
      listCalls.push(text)
      if (listMode === 'error') return { json: async () => ({ ok: false, code: 'failed' }) }
      const query = new URL('http://x' + text).searchParams
      const q = (query.get('q') || '').toLowerCase()
      const cursor = query.get('cursor')
      const filtered = doneTasks.filter(function (task) { return q === '' || task.title.toLowerCase().indexOf(q) >= 0 || task.id.toLowerCase().indexOf(q) >= 0 })
      const start = cursor === null ? 0 : filtered.findIndex(function (task) { return task.updatedAt + '|' + task.id === cursor }) + 1
      const page = filtered.slice(start >= 0 ? start : 0, (start >= 0 ? start : 0) + 50)
      const last = page.length === 0 ? null : page[page.length - 1]
      const more = (start >= 0 ? start : 0) + page.length < filtered.length
      return { json: async () => ({ ok: true, tasks: page, nextCursor: more ? last.updatedAt + '|' + last.id : null }) }
    }
    if (text.indexOf('/task?') >= 0) {
      detailCalls.push(text)
      const wanted = new URL('http://x' + text).searchParams.get('id')
      const base = doneTasks.filter((task) => task.id === wanted)[0] || doneTasks[0]
      return { json: async () => ({ ok: true, task: Object.assign({}, base, { title: 'DETAIL-TITLE-83', spec: 'DONE-DETAIL-SPEC' }) }) }
    }
    return { json: async () => doneHost }
  }
  function cardCount(node) { return findAll(node, (child) => child.props && child.props.className === 'gbt-card').length }
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 40))
    await flush()
    await flush()
  }
  let tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  const doneSection = function (root) { return findAll(root, (node) => node.props && node.props['data-group'] === 'done')[0] }
  const headerOf = function (section) { return findAll(section, (node) => node.props && node.props.className === 'gbt-colhead')[0] }
  check(
    'the done column starts collapsed to five cards and shows the server count',
    doneSection(tree).props['data-collapsed'] === 'true' && cardCount(doneSection(tree)) === 5 && textOf(headerOf(doneSection(tree))).indexOf('120') >= 0,
    JSON.stringify({ collapsed: doneSection(tree).props['data-collapsed'], cards: cardCount(doneSection(tree)), head: textOf(headerOf(doneSection(tree))) }),
  )
  const viewAll = findAll(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'done-all')[0]
  check('the done column offers a view-all entry named after the total', viewAll !== undefined && textOf(viewAll).indexOf('查看全部') >= 0 && textOf(viewAll).indexOf('120') >= 0, viewAll && textOf(viewAll))
  // Expanding the blocked column is remembered (localStorage), done is independent.
  const blockedSection = function (root) { return findAll(root, (node) => node.props && node.props['data-group'] === 'blocked')[0] }
  headerOf(blockedSection(tree)).props.onClick()
  const saved = JSON.parse(STORAGE.get(COLUMNS_KEY) || '{}')
  check('toggling a column writes the collapse state to localStorage', saved.blocked === true && saved.done !== false, JSON.stringify(saved))
  tree = withHooks(panel, { initialView: 'board' })
  check('the remembered state survives a remount', blockedSection(tree).props['data-collapsed'] === 'true', JSON.stringify(blockedSection(tree).props['data-collapsed']))
  STORAGE.delete(COLUMNS_KEY)
  // The drawer: page 1 has 50 rows, scroll/load more appends page 2 without duplicates.
  viewAll.props.onClick()
  tree = withHooks(panel, { initialView: 'board' })
  await settle()
  tree = withHooks(panel, { initialView: 'board' })
  const drawer = function (root) { return findAll(root, (node) => node.props && node.props['data-done-all-overlay'] === 'true')[0] }
  const rowIds = function (node) { return findAll(node, (child) => child.props && child.props['data-done-row'] !== undefined).map((child) => child.props['data-done-row']) }
  check(
    'the view-all drawer loads the first page of 50 summary rows',
    drawer(tree) !== undefined && rowIds(drawer(tree)).length === 50 && textOf(drawer(tree)).indexOf('今天') >= 0,
    JSON.stringify({ rows: rowIds(drawer(tree)).length }),
  )
  const more = findAll(drawer(tree), (node) => node.type === 'button' && node.props && node.props['data-action'] === 'done-more')[0]
  if (more !== undefined) more.props.onClick()
  await settle()
  tree = withHooks(panel, { initialView: 'board' })
  const ids = rowIds(drawer(tree))
  check(
    'load more appends the next page with no duplicate and no gap',
    ids.length === 100 && new Set(ids).size === ids.length && ids[0] === 'D-1' && ids.indexOf('D-50') >= 0,
    JSON.stringify({ count: ids.length, unique: new Set(ids).size }),
  )
  // Search goes to the server (q=) after the debounce.
  const searchInput = findAll(drawer(tree), (node) => node.type === 'input' && node.props && node.props.type === 'search')[0]
  searchInput.props.onChange({ target: { value: 'card 11' } })
  withHooks(panel, { initialView: 'board' })
  await new Promise((resolve) => setTimeout(resolve, 320))
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  const searchCall = listCalls.filter((url) => url.indexOf('q=card%2011') >= 0)[0]
  const searched = rowIds(drawer(tree))
  check(
    'search is debounced and executed by the server (q=)',
    searchCall !== undefined && searched.length > 0 && searched.every((id) => id.indexOf('D-11') === 0 || id === 'D-11'),
    JSON.stringify({ call: searchCall, rows: searched.slice(0, 5) }),
  )
  // A row opens the card's detail by id (one detail request, not 50).
  const row = findAll(drawer(tree), (node) => node.props && node.props['data-done-row'] !== undefined)[0]
  row.props.onClick()
  tree = withHooks(panel, { initialView: 'board' })
  await settle()
  tree = withHooks(panel, { initialView: 'board' })
  const detailOverlay = findAll(tree, (node) => node.props && node.props['data-detail-overlay'] === 'true')[0]
  check(
    'a drawer row opens the detail drawer and fetches exactly that card',
    detailCalls.length === 1 && detailCalls[0].indexOf('id=D-') >= 0 && /[?&]session=[^&]+/.test(detailCalls[0]) && detailOverlay !== undefined && textOf(detailOverlay).indexOf('DETAIL-TITLE-83') >= 0,
    JSON.stringify({ calls: detailCalls.length }),
  )
  // 500 completed cards: the collapsed column must keep the DOM at five cards.
  {
    const savedManyFetch = globalThis.fetch
    const many = Array.from({ length: 500 }).map(function (value, index) {
      return Object.assign({}, doneTasks[0], { id: 'M-' + String(index + 1), title: 'Many ' + String(index + 1) })
    })
    const manyHost = Object.assign({}, doneHost, { tasks: many, counts: Object.assign({}, doneHost.counts, { done: 500 }) })
    globalThis.fetch = async function (url, options) {
      if (options !== undefined && options.method === 'POST') return { json: async () => ({ ok: true, snapshot: manyHost }) }
      return { json: async () => manyHost }
    }
    const started = Date.now()
    let manyTree = withHooks(panel, { initialView: 'board' })
    await flush()
    manyTree = withHooks(panel, { initialView: 'board' })
    const elapsed = Date.now() - started
    const manyDone = findAll(manyTree, (node) => node.props && node.props['data-group'] === 'done')[0]
    check(
      '500 completed cards still render only five cards in the column',
      cardCount(manyDone) === 5 && elapsed < 1500,
      JSON.stringify({ cards: cardCount(manyDone), elapsed: elapsed }),
    )
    globalThis.fetch = savedManyFetch
  }
  // Error state offers a retry; an empty search shows the empty text.
  listMode = 'error'
  const reopen = findAll(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'done-all')[0]
  reopen.props.onClick()
  tree = withHooks(panel, { initialView: 'board' })
  await settle()
  tree = withHooks(panel, { initialView: 'board' })
  check('the drawer has a retryable error state', textOf(drawer(tree)).indexOf('加载失败') >= 0 && findAll(drawer(tree), (node) => node.type === 'button' && textOf(node).indexOf('重试') >= 0).length === 1, textOf(drawer(tree)).slice(0, 200))
  listMode = 'ok'
  const retry = findAll(drawer(tree), (node) => node.type === 'button' && textOf(node).indexOf('重试') >= 0)[0]
  if (retry !== undefined) retry.props.onClick()
  await settle()
  tree = withHooks(panel, { initialView: 'board' })
  check('retry recovers the list', rowIds(drawer(tree)).length > 0, String(rowIds(drawer(tree)).length))
  STORAGE.delete(COLUMNS_KEY)
  globalThis.fetch = t83SavedFetch
}

// ── T-83: the summary snapshot shape (T-82) drives the board/queue/status ──
// The fixture above clones a full-detail task. GET /state after T-82 answers
// SUMMARIES: writeFiles is a count (writeFileCount), history is two events, and
// merge/test/review keep statuses and lengths but never the detail strings.
// The board and the queue must render every fact from those fields alone.
{
  const COLUMNS_KEY = 'godotBridge.taskCenter.columns'
  STORAGE.delete(COLUMNS_KEY)
  // Anchored at local noon: the drawer buckets by CALENDAR DAY, and a fixture built
  // from "now" puts the 1-day-plus-minutes rows on the day before yesterday when
  // the suite runs just after local midnight. Noon keeps the shape deterministic
  // at any hour.
  const nowMs = (function () {
    const anchor = new Date()
    anchor.setHours(12, 0, 0, 0)
    return anchor.getTime()
  })()
  const DAY = 24 * 60 * 60 * 1000
  function summaryTask(id, title, status, ageMs, extra) {
    const at = new Date(nowMs - ageMs).toISOString()
    return Object.assign({
      id: id,
      title: title,
      status: status,
      priority: 0,
      dependsOn: [],
      dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
      writeFileCount: 0,
      target: 'feat/task-center-v2',
      base: 'fe43171',
      branch: null,
      worktree: null,
      worktreeError: null,
      commit: null,
      requiredRole: null,
      merge: null,
      review: null,
      test: null,
      assignee: null,
      attempts: 0,
      maxAttempts: 3,
      queuePosition: null,
      waitingReason: null,
      candidate: null,
      createdAt: at,
      updatedAt: at,
      events: [],
    }, extra === undefined ? {} : extra)
  }
  function doneSummary(index) {
    const ageMs = index < 40 ? (index + 1) * 60000 : index < 80 ? DAY + index * 60000 : 3 * DAY + index * 60000
    const at = new Date(nowMs - ageMs).toISOString()
    return summaryTask('D-' + String(index + 1), 'Done card ' + String(index + 1), 'done', ageMs, {
      writeFileCount: 2,
      merge: { status: 'merged', base: 'fe43171', target: 'feat/task-center-v2', head: 'abc1234', mergeCommit: 'abcdef1234', reviewer: '@reviewer', conflict: null, at: at, declaredCount: 2, actualCount: 2, outputLength: 120, testsLength: 40 },
      review: { status: 'approved', by: '@reviewer', byName: 'reviewer-1', at: at, attempt: 1, deliveredAt: null },
      test: { status: 'passed', by: '@tester', byName: 'tester-1', at: at, attempt: 1, deliveredAt: null, evidenceLength: 900 },
    })
  }
  const doneRows = Array.from({ length: 120 }).map(function (value, index) { return doneSummary(index) })
  const blockedSummary = summaryTask('B-1', 'Blocked by a lock', 'blocked', 3600000, {
    writeFileCount: 2,
    dependency: { state: 'broken', waitingOn: [], brokenOn: ['T-9'] },
  })
  const runningSummary = summaryTask('R-1', 'Running now', 'running', 60000, {
    writeFileCount: 3,
    requiredRole: 'worker',
    assignee: { name: 'work-x' },
    leaseUntil: new Date(nowMs + 600000).toISOString(),
    leaseRemaining: 600000,
  })
  const readySummary = summaryTask('P-1', 'Ready to dispatch', 'pending', 120000, { writeFileCount: 2 })
  function hostOf(tasks, doneCount) {
    return {
      ok: true,
      project: PROJECT,
      dispatch: { state: 'paused', maxConcurrent: 3, request: null },
      counts: { total: tasks.length, pending: 1, ready: 1, running: 1, reviewing: 0, testing: 0, done: doneCount, blocked: 1, cancelled: 0 },
      queue: tasks.filter(function (task) { return task.id === 'P-1' }),
      tasks: tasks,
      locks: [],
      workers: null,
      agents: null,
      worktrees: null,
      activity: null,
      roles: null,
      scheduler: null,
      serverTime: new Date().toISOString(),
    }
  }
  let host = hostOf([readySummary, runningSummary, blockedSummary].concat(doneRows), 120)
  let listRows = doneRows
  let listMode = 'ok'
  const listCalls = []
  const detailCalls = []
  const savedFetch = globalThis.fetch
  globalThis.fetch = async function (url, options) {
    const text = String(url)
    if (options !== undefined && options.method === 'POST') return { json: async () => ({ ok: true, snapshot: host }) }
    if (text.indexOf('/list?') >= 0) {
      listCalls.push(text)
      if (listMode === 'error') return { json: async () => ({ ok: false, code: 'failed' }) }
      const params = new URL('http://x' + text).searchParams
      const needle = String(params.get('q') || '').toLowerCase()
      const filtered = listRows.filter(function (task) {
        return needle === '' || task.id.toLowerCase().indexOf(needle) >= 0 || task.title.toLowerCase().indexOf(needle) >= 0
      })
      const cursor = params.get('cursor')
      let start = 0
      if (cursor !== null) {
        const at = filtered.findIndex(function (task) { return task.updatedAt + '|' + task.id === cursor })
        start = at < 0 ? filtered.length : at + 1
      }
      const limit = Number(params.get('limit') || 50)
      const page = filtered.slice(start, start + limit)
      const last = page[page.length - 1]
      const more = last !== undefined && start + page.length < filtered.length
      return { json: async () => ({ ok: true, tasks: page.slice(), nextCursor: more ? last.updatedAt + '|' + last.id : null }) }
    }
    if (text.indexOf('/task?') >= 0) {
      detailCalls.push(text)
      const id = new URL('http://x' + text).searchParams.get('id')
      const base = listRows.filter(function (task) { return task.id === id })[0] || listRows[0]
      return { json: async () => ({ ok: true, task: Object.assign({}, base, { writeFiles: ['client/client.js'], history: [] }) }) }
    }
    return { json: async () => host }
  }

  function sectionOf(root, key) {
    return findAll(root, function (node) { return node.props && node.props.className === 'gbt-col' && node.props['data-group'] === key })[0]
  }
  function cardsIn(section) {
    return section === undefined ? [] : findAll(section, function (node) { return node.type === 'article' && node.props && node.props.className === 'gbt-card' })
  }
  function drawerOf(root) {
    return findAll(root, function (node) { return node.props && node.props['data-done-all-overlay'] === 'true' })[0]
  }
  function rowsOf(drawer) {
    return drawer === undefined ? [] : findAll(drawer, function (node) { return node.props && node.props['data-done-row'] !== undefined }).map(function (node) { return node.props['data-done-row'] })
  }
  function groupsOf(drawer) {
    return drawer === undefined ? [] : findAll(drawer, function (node) { return node.props && node.props['data-done-group'] !== undefined }).map(function (node) { return node.props['data-done-group'] })
  }
  function searchOf(drawer) {
    return drawer === undefined ? undefined : findAll(drawer, function (node) { return node.type === 'input' && node.props && node.props.type === 'search' })[0]
  }
  async function settleSearch() {
    await new Promise(function (resolve) { setTimeout(resolve, 320) })
    await flush()
    await flush()
  }

  let tree = withHooks(panel, { initialView: 'board' })
  await flush()
  // The previous block left its drawer open; close it so this block starts at the board.
  const leftover = drawerOf(tree)
  if (leftover !== undefined) {
    findAll(leftover, function (node) { return node.type === 'button' && node.props && node.props.className === 'gbt-iconbtn' })[0].props.onClick()
    tree = withHooks(panel, { initialView: 'board' })
  }
  findButton(tree, '刷新').props.onClick()
  await flush()
  await flush()
  tree = withHooks(panel, { initialView: 'board' })

  const doneSection = sectionOf(tree, 'done')
  check(
    'T-83 summary: the done column folds to five summary cards and shows 完成 · 120',
    doneSection !== undefined && doneSection.props['data-collapsed'] === 'true' && cardsIn(doneSection).length === 5 &&
      textOf(doneSection).indexOf('完成') >= 0 && textOf(doneSection).indexOf('120') >= 0,
    JSON.stringify({ collapsed: doneSection && doneSection.props['data-collapsed'], cards: cardsIn(doneSection).length, head: doneSection && textOf(doneSection).slice(0, 40) }),
  )
  const viewAll = findAll(tree, function (node) { return node.type === 'button' && node.props && node.props['data-action'] === 'done-all' })[0]
  check(
    'T-83 summary: the folded column ends with 查看全部 · 120',
    viewAll !== undefined && textOf(viewAll).indexOf('查看全部') >= 0 && textOf(viewAll).indexOf('120') >= 0,
    viewAll && textOf(viewAll),
  )
  const blockedSection = sectionOf(tree, 'blocked')
  check(
    'T-83 summary: the files chip falls back to writeFileCount when writeFiles is absent',
    blockedSection !== undefined && textOf(blockedSection).indexOf('🔒 2') >= 0,
    blockedSection && textOf(blockedSection),
  )
  check(
    'T-83 summary: the done card renders merge/review/test from summary statuses',
    textOf(doneSection).indexOf('⇄ 已合并') >= 0 && textOf(doneSection).indexOf('👁 评审通过') >= 0 && textOf(doneSection).indexOf('🧪 测试通过') >= 0,
    textOf(doneSection).slice(0, 260),
  )
  check(
    'T-83 summary: no summary-shape field leaks as "undefined" into the board',
    textOf(tree).indexOf('undefined') < 0,
    textOf(tree).slice(0, 300),
  )
  {
    const queueTree = withHooks(panel, { initialView: 'queue' })
    // The fake React tolerates h(undefined, ...) and renders nothing for it, so a
    // deleted component was invisible here while a real browser would throw
    // "Element type is invalid". Walk the tree for orphan nodes to pin that.
    function orphansOf(node, out) {
      if (node === null || node === undefined || typeof node !== 'object') return out
      if (Array.isArray(node)) {
        node.forEach(function (child) { orphansOf(child, out) })
        return out
      }
      if (node.type === undefined && node.props !== undefined) out.push(node)
      if (node.props !== undefined && node.props !== null) orphansOf(node.props.children, out)
      return out
    }
    check(
      'T-83 summary: the queue renders a summary row (writeFileCount, no writeFiles array)',
      textOf(queueTree).indexOf('Ready to dispatch') >= 0 && textOf(queueTree).indexOf('🔒 2') >= 0 && textOf(queueTree).indexOf('undefined') < 0,
      textOf(queueTree).slice(0, 240),
    )
    check(
      'T-83 summary: every queue row renders a real component (no orphan h(undefined))',
      orphansOf(queueTree, []).length === 0,
      JSON.stringify(orphansOf(queueTree, []).map(function (node) { return node.props && node.props.className })),
    )
    const statusTree = withHooks(panel, { initialView: 'status' })
    check(
      'T-83 summary: the status view renders a summary snapshot without a history list',
      statusTree !== null && textOf(statusTree).indexOf('最近活动') >= 0 && textOf(statusTree).indexOf('undefined') < 0,
      textOf(statusTree).slice(0, 240),
    )
    tree = withHooks(panel, { initialView: 'board' })
  }

  // No detail fetches for the list: 120 summary rows come from /list alone.
  findAll(tree, function (node) { return node.type === 'button' && node.props && node.props['data-action'] === 'done-all' })[0].props.onClick()
  const skeletonTree = withHooks(panel, { initialView: 'board' })
  const skeleton = drawerOf(skeletonTree)
  check(
    'T-83 summary: the drawer opens on skeleton rows while the first page loads',
    skeleton !== undefined && findAll(skeleton, function (node) { return node.props && node.props.className === 'gbt-skel' }).length === 6 && rowsOf(skeleton).length === 0,
    skeleton === undefined ? 'no drawer' : String(findAll(skeleton, function (node) { return node.props && node.props.className === 'gbt-skel' }).length),
  )
  await flush()
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  let drawer = drawerOf(tree)
  check(
    'T-83 summary: the first page is 50 newest summaries with zero /task requests',
    drawer !== undefined && rowsOf(drawer).length === 50 && rowsOf(drawer)[0] === 'D-1' && rowsOf(drawer)[49] === 'D-50' && detailCalls.length === 0,
    JSON.stringify({ rows: rowsOf(drawer).length, details: detailCalls.length }),
  )
  check(
    'T-83 summary: page one is grouped 今天 / 昨天 and not 更早',
    groupsOf(drawer).join(',') === 'today,yesterday',
    groupsOf(drawer).join(','),
  )
  for (let page = 0; page < 2; page += 1) {
    const more = findAll(drawer, function (node) { return node.type === 'button' && node.props && node.props['data-action'] === 'done-more' })[0]
    if (more === undefined) break
    more.props.onClick()
    await flush()
    await flush()
    tree = withHooks(panel, { initialView: 'board' })
    drawer = drawerOf(tree)
  }
  const pagedIds = rowsOf(drawer)
  const expectedIds = Array.from({ length: 120 }).map(function (value, index) { return 'D-' + String(index + 1) })
  check(
    'T-83 summary: paging the archive is complete and duplicate-free (120 of 120, newest first)',
    pagedIds.length === 120 && new Set(pagedIds).size === 120 && pagedIds.join(',') === expectedIds.join(','),
    JSON.stringify({ rows: pagedIds.length, unique: new Set(pagedIds).size, first: pagedIds[0], last: pagedIds[pagedIds.length - 1] }),
  )
  check(
    'T-83 summary: the last page carries all three day groups and ends the list',
    groupsOf(drawer).join(',') === 'today,yesterday,earlier' &&
      findAll(drawer, function (node) { return node.type === 'button' && node.props && node.props['data-action'] === 'done-more' }).length === 0,
    groupsOf(drawer).join(','),
  )
  check(
    'T-83 summary: the drawer head reports the server total and the loaded count',
    textOf(drawer).indexOf('共 120 张') >= 0 && textOf(drawer).indexOf('已加载 120 张') >= 0,
    textOf(drawer).slice(0, 100),
  )

  // Server-side search after the debounce.
  const callsBefore = listCalls.length
  searchOf(drawer).props.onChange({ target: { value: 'card 42' } })
  tree = withHooks(panel, { initialView: 'board' })
  check(
    'T-83 summary: typing is immediate and the request waits for the debounce',
    searchOf(drawerOf(tree)) !== undefined && searchOf(drawerOf(tree)).props.value === 'card 42' && listCalls.length === callsBefore,
    JSON.stringify({ value: searchOf(drawerOf(tree)) && searchOf(drawerOf(tree)).props.value, calls: listCalls.length - callsBefore }),
  )
  await settleSearch()
  tree = withHooks(panel, { initialView: 'board' })
  drawer = drawerOf(tree)
  check(
    'T-83 summary: the debounced search runs on the Host (q=) and replaces the page',
    listCalls.some(function (url) { return url.indexOf('q=card%2042') >= 0 }) && rowsOf(drawer).join(',') === 'D-42',
    JSON.stringify({ rows: rowsOf(drawer), last: listCalls[listCalls.length - 1] }),
  )

  // Empty state. (The fake harness runs effects inside render, so the debounce
  // starts on the render that follows the change.)
  searchOf(drawer).props.onChange({ target: { value: 'no-such-card' } })
  withHooks(panel, { initialView: 'board' })
  await settleSearch()
  tree = withHooks(panel, { initialView: 'board' })
  drawer = drawerOf(tree)
  check(
    'T-83 summary: a search with no match shows the drawer empty state',
    drawer !== undefined && rowsOf(drawer).length === 0 && textOf(drawer).indexOf('没有匹配的已完成任务') >= 0,
    textOf(drawer).slice(0, 160),
  )

  // Error + retry.
  listMode = 'error'
  searchOf(drawer).props.onChange({ target: { value: 'card 4' } })
  withHooks(panel, { initialView: 'board' })
  await settleSearch()
  tree = withHooks(panel, { initialView: 'board' })
  drawer = drawerOf(tree)
  const retry = findAll(drawer, function (node) { return node.type === 'button' && String(textOf(node)).indexOf('重试') >= 0 })[0]
  check(
    'T-83 summary: a failed page shows the error state with a retry action',
    drawer !== undefined && retry !== undefined && textOf(drawer).indexOf('加载失败') >= 0,
    textOf(drawer).slice(0, 200),
  )
  listMode = 'ok'
  retry.props.onClick()
  await flush()
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  drawer = drawerOf(tree)
  check(
    'T-83 summary: retry recovers the page without a reload',
    rowsOf(drawer).length > 0 && textOf(drawer).indexOf('加载失败') < 0,
    JSON.stringify({ rows: rowsOf(drawer).length }),
  )

  // One row -> exactly one /task detail.
  const rowId = rowsOf(drawer)[0]
  findAll(drawer, function (node) { return node.props && node.props['data-done-row'] === rowId })[0].props.onClick()
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  const detail = findAll(tree, function (node) { return node.props && node.props['data-detail-overlay'] === 'true' })[0]
  check(
    'T-83 summary: one row costs exactly one /task request and opens the detail drawer',
    detailCalls.length === 1 && detailCalls[0].indexOf('id=' + rowId) >= 0 && detail !== undefined && textOf(detail).indexOf('client/client.js') >= 0,
    JSON.stringify({ calls: detailCalls.length }),
  )

  // 500 summary completions: bounded first screen, measured.
  const bigRows = Array.from({ length: 500 }).map(function (value, index) {
    const base = doneSummary(index % 120)
    return Object.assign({}, base, { id: 'B-' + String(index + 1), title: 'Big card ' + String(index + 1) })
  })
  host = hostOf(bigRows, 500)
  listRows = bigRows
  const started = Date.now()
  const bigFirst = withHooks(panel, { initialView: 'board' })
  await flush()
  const bigTree = withHooks(panel, { initialView: 'board' })
  const elapsed = Date.now() - started
  const bigDone = sectionOf(bigTree, 'done')
  const bigCards = findAll(bigTree, function (node) { return node.type === 'article' && node.props && node.props.className === 'gbt-card' })
  check(
    'T-83 summary: 500 completions still render five done cards on the first screen',
    bigFirst !== null && bigDone !== undefined && cardsIn(bigDone).length === 5 && bigCards.length === 5 && textOf(bigDone).indexOf('500') >= 0,
    JSON.stringify({ doneCards: cardsIn(bigDone).length, allCards: bigCards.length }),
  )
  console.log('T-83 metrics: ' + JSON.stringify({ snapshotTasks: 500, boardCards: bigCards.length, doneCards: cardsIn(bigDone).length, renderMs: elapsed }))

  globalThis.fetch = savedFetch
  STORAGE.delete(COLUMNS_KEY)
}

// ── T-83: the remembered fold state survives a real reload ────────────────
// A fresh module instance reads localStorage at render time: this is the same
// thing a browser refresh does (new script evaluation, same storage).
{
  const COLUMNS_KEY = 'godotBridge.taskCenter.columns'
  STORAGE.set(COLUMNS_KEY, JSON.stringify({ done: false, blocked: true }))
  const savedFetch = globalThis.fetch
  const nowMs = Date.now()
  const host = {
    ok: true,
    project: PROJECT,
    dispatch: { state: 'paused', maxConcurrent: 3, request: null },
    counts: { total: 8, pending: 0, ready: 0, running: 0, reviewing: 0, testing: 0, done: 7, blocked: 1, cancelled: 0 },
    queue: [],
    tasks: Array.from({ length: 7 }).map(function (value, index) {
      const at = new Date(nowMs - (index + 1) * 60000).toISOString()
      return {
        id: 'S-' + String(index + 1), title: 'Reload card ' + String(index + 1), status: 'done', priority: 0, dependsOn: [],
        dependency: { state: 'ready', waitingOn: [], brokenOn: [] }, writeFileCount: 1, merge: null, review: null, test: null,
        assignee: null, attempts: 0, maxAttempts: 3, requiredRole: null, queuePosition: null, waitingReason: null,
        createdAt: at, updatedAt: at, events: [],
      }
    }).concat([{
      id: 'SB-1', title: 'Reload blocked', status: 'blocked', priority: 0, dependsOn: [],
      dependency: { state: 'broken', waitingOn: [], brokenOn: ['T-9'] }, writeFileCount: 0, merge: null, review: null, test: null,
      assignee: null, attempts: 0, maxAttempts: 3, requiredRole: null, queuePosition: null, waitingReason: null,
      createdAt: new Date(nowMs - 60000).toISOString(), updatedAt: new Date(nowMs - 60000).toISOString(), events: [],
    }]),
    locks: [], workers: null, agents: null, worktrees: null, activity: null, roles: null, scheduler: null,
    serverTime: new Date().toISOString(),
  }
  globalThis.fetch = async function () { return { json: async () => host } }
  new Function(readFileSync(SRC, 'utf8'))()
  const plugin = registration.factory(function (specifier) {
    if (specifier === 'react') return React
    throw new Error('unexpected require: ' + specifier)
  })
  plugin.apply(ctx)
  const panel2 = registrations.filter(function (entry) { return entry.meta.name === 'main' }).slice(-1)[0].component
  let tree = withHooks(panel2, { initialView: 'board' })
  await flush()
  tree = withHooks(panel2, { initialView: 'board' })
  const doneSection = findAll(tree, function (node) { return node.props && node.props.className === 'gbt-col' && node.props['data-group'] === 'done' })[0]
  const blockedSection = findAll(tree, function (node) { return node.props && node.props.className === 'gbt-col' && node.props['data-group'] === 'blocked' })[0]
  function cardsIn(section) {
    return section === undefined ? [] : findAll(section, function (node) { return node.type === 'article' && node.props && node.props.className === 'gbt-card' })
  }
  check(
    'T-83 reload: the expanded done column is restored from localStorage',
    doneSection !== undefined && doneSection.props['data-collapsed'] === 'false' && cardsIn(doneSection).length === 7,
    JSON.stringify({ collapsed: doneSection && doneSection.props['data-collapsed'], cards: cardsIn(doneSection).length }),
  )
  check(
    'T-83 reload: the folded blocked column is restored from localStorage',
    blockedSection !== undefined && blockedSection.props['data-collapsed'] === 'true' && cardsIn(blockedSection).length === 0,
    JSON.stringify({ collapsed: blockedSection && blockedSection.props['data-collapsed'], cards: cardsIn(blockedSection).length }),
  )
  STORAGE.delete(COLUMNS_KEY)
  globalThis.fetch = savedFetch
}

// ── T-84: the archived view is reachable from the status page ──
{
  const savedFetch = globalThis.fetch
  const savedArchived = HOST.archivedCount
  const savedRange = HOST.archiveRange
  const listCalls = []
  HOST.archivedCount = 3
  HOST.archiveRange = { from: '2025-01-01T00:00:00.000Z', to: '2025-06-01T00:00:00.000Z' }
  globalThis.fetch = async function (url, options) {
    const text = String(url)
    if (text.indexOf('/list?') >= 0) {
      listCalls.push(text)
      return { json: async () => ({ ok: true, tasks: [{ id: 'A-1', title: 'Old done', status: 'done', updatedAt: '2025-01-02T00:00:00.000Z' }, { id: 'A-2', title: 'Older', status: 'done', updatedAt: '2025-01-01T00:00:00.000Z' }], nextCursor: null }) }
    }
    if (text.indexOf('/state') >= 0) return { json: async () => Object.assign({}, HOST, { archivedCount: 3, archiveRange: { from: '2025-01-01T00:00:00.000Z', to: '2025-06-01T00:00:00.000Z' } }) }
    return savedFetch(url, options)
  }
  let tree = withHooks(panel, { initialView: 'status' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  await flush()
  tree = withHooks(panel, { initialView: 'status' })
  const archiveNode = findAll(tree, (node) => node.props && node.props['data-status-archive'] !== undefined)[0]
  const archiveChildren = archiveNode === undefined ? [] : Array.isArray(archiveNode.props.children) ? archiveNode.props.children : [archiveNode.props.children]
  const archiveHead = archiveChildren.filter((child) => typeof child === 'string').join('')
  const archiveButton = findAll(tree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'archive-open')[0]
  check('the status page shows the archive line with a link', archiveButton !== undefined && archiveHead.indexOf('已归档 3 张') >= 0, JSON.stringify({ head: archiveHead, button: archiveButton !== undefined }))
  archiveButton.props.onClick()
  tree = withHooks(panel, { initialView: 'status' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  await flush()
  await flush()
  tree = withHooks(panel, { initialView: 'status' })
  const overlay = findAll(tree, (node) => node.props && node.props['data-done-all-overlay'] === 'true')[0]
  check(
    'the archived view pages through /list?archived=1 and renders rows',
    overlay !== undefined && listCalls.some((url) => url.indexOf('archived=1') >= 0) && listCalls.every((url) => /[?&]session=[^&]+/.test(url)) && textOf(overlay).indexOf('Old done') >= 0 && textOf(overlay).indexOf('已归档任务') >= 0,
    JSON.stringify({ calls: listCalls.length, text: overlay && textOf(overlay).slice(0, 120) }),
  )
  const mask = overlay === undefined ? undefined : findAll(overlay, (node) => node.props && node.props.className === 'gbt-detailmask')[0]
  if (mask !== undefined) mask.props.onClick()
  withHooks(panel, { initialView: 'status' })
  HOST.archivedCount = savedArchived
  HOST.archiveRange = savedRange
  globalThis.fetch = savedFetch
}

// ── T-90: the panel follows the session project; switching binds the Host ──
// The browser pin is gone, so the panel asks the Host with no project at all and
// renders what the session resolved. A pin that differs from the session gets an
// actionable bar; switching writes both the pin and the Host binding.
{
  const savedFetch = globalThis.fetch
  const sessionRoot = 'J:\\demo\\session-project'
  const pinnedOther = 'J:\\demo\\pinned-other'
  const stateUrls = []
  let postsBefore = posts.length
  function hostFor(shown, from) {
    return Object.assign({}, HOST, {
      project: shown,
      projectRoot: shown,
      resolvedFrom: from,
      sessionProject: sessionRoot,
      registryConsistent: from !== 'panel',
    })
  }
  globalThis.fetch = async function (url, options) {
    const text = String(url)
    if (options !== undefined && options.method === 'POST') {
      const body = JSON.parse(options.body)
      posts.push(body)
      return { json: async () => ({ ok: true, snapshot: hostFor(body.path === undefined ? pinnedOther : body.path, 'panel') }) }
    }
    if (text.indexOf('/state') >= 0) {
      stateUrls.push(text)
      const match = /[?&]project=([^&]*)/.exec(text)
      return { json: async () => (match === null ? hostFor(sessionRoot, 'session') : hostFor(decodeURIComponent(match[1]), 'panel')) }
    }
    return savedFetch(url, options)
  }

  // 1. No pin: no path is typed, and the Host's session project is rendered.
  STORAGE.delete('godotBridge.taskCenter.project')
  let t90 = withHooks(panel, { initialView: 'board' })
  await flush()
  t90 = withHooks(panel, { initialView: 'board' })
  await flush()
  t90 = withHooks(panel, { initialView: 'board' })
  check(
    'T-90 an empty localStorage sends no project to /state',
    stateUrls.length > 0 && stateUrls.every((url) => url.indexOf('project=') < 0),
    JSON.stringify(stateUrls.slice(-3)),
  )
  check(
    'T-90 the panel renders the session-resolved project without a typed path',
    captured.getSnapshot().project === sessionRoot && textOf(t90).indexOf(sessionRoot) >= 0,
    JSON.stringify({ project: captured.getSnapshot().project, text: textOf(t90).slice(0, 160) }),
  )
  const sessionBadge = findAll(t90, (node) => node.props && node.props['data-project-source'] === 'session')[0]
  check('T-90 the source beside the title reads as the session', sessionBadge !== undefined && textOf(sessionBadge) === '会话', sessionBadge && textOf(sessionBadge))
  check('T-90 loading alone never writes a pin', STORAGE.has('godotBridge.taskCenter.project') === false, String(STORAGE.get('godotBridge.taskCenter.project')))
  check('T-90 no mismatch bar is shown when the two agree', findAll(t90, (node) => node.props && node.props['data-project-mismatch'] === 'true').length === 0)

  // 2. A pin that differs from the session: actionable mismatch bar.
  STORAGE.set('godotBridge.taskCenter.project', 'v2:' + pinnedOther)
  let t90b = withHooks(panel, { initialView: 'board' })
  await flush()
  t90b = withHooks(panel, { initialView: 'board' })
  await flush()
  t90b = withHooks(panel, { initialView: 'board' })
  const manualBadge = findAll(t90b, (node) => node.props && node.props['data-project-source'] === 'manual')[0]
  check('T-90 a pinned project is labelled as manual', manualBadge !== undefined && textOf(manualBadge) === '手动', manualBadge && textOf(manualBadge))
  const mismatch = findAll(t90b, (node) => node.props && node.props['data-project-mismatch'] === 'true')[0]
  check(
    'T-90 a pinned panel that differs from the session shows the mismatch bar',
    mismatch !== undefined && textOf(mismatch).indexOf(pinnedOther) >= 0 && textOf(mismatch).indexOf(sessionRoot) >= 0,
    mismatch && textOf(mismatch),
  )
  const switchButton = mismatch === undefined ? undefined : findAll(mismatch, (node) => node.type === 'button' && node.props['data-action'] === 'switch-to-session-project')[0]
  check('T-90 the bar carries one switch action', switchButton !== undefined, mismatch && mismatch.props.children === undefined)

  // 3. Clicking it: openProject on the Host, then the pin follows.
  postsBefore = posts.length
  if (switchButton !== undefined) switchButton.props.onClick()
  await flush()
  await flush()
  const switchPost = posts.slice(postsBefore).filter((post) => post.action === 'openProject')[0]
  check('T-90 switching sends openProject to the Host (write = bind)', switchPost !== undefined && switchPost.path === sessionRoot, JSON.stringify(posts.slice(postsBefore)))
  check('T-90 and pins the session project in the browser', STORAGE.get('godotBridge.taskCenter.project') === 'v2:' + sessionRoot, String(STORAGE.get('godotBridge.taskCenter.project')))
  t90b = withHooks(panel, { initialView: 'board' })
  await flush()
  t90b = withHooks(panel, { initialView: 'board' })
  check('T-90 after the switch the mismatch bar is gone', findAll(t90b, (node) => node.props && node.props['data-project-mismatch'] === 'true').length === 0, textOf(t90b).slice(0, 200))

  // 4. The project dialog offers the Host-resolved path instead of hand typing.
  STORAGE.set('godotBridge.taskCenter.project', 'v2:' + pinnedOther)
  let formTree = withHooks(panel, { initialView: 'board', initialProjectOpen: true })
  await flush()
  formTree = withHooks(panel, { initialView: 'board', initialProjectOpen: true })
  await flush()
  formTree = withHooks(panel, { initialView: 'board', initialProjectOpen: true })
  const projectInput = findAll(formTree, (node) => node.type === 'input' && node.props && node.props['data-project-input'] === 'true')[0]
  check(
    'T-90 the dialog starts on the pinned path',
    projectInput !== undefined && projectInput.props.defaultValue === pinnedOther,
    JSON.stringify({ input: projectInput && projectInput.props.defaultValue, snapshotProject: captured.getSnapshot().project, pinned: STORAGE.get('godotBridge.taskCenter.project'), urls: stateUrls.slice(-2) }),
  )
  const useCurrentButton = findAll(formTree, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'use-current-project')[0]
  check('T-90 the dialog offers "use current project"', useCurrentButton !== undefined && textOf(useCurrentButton).indexOf('使用当前项目') >= 0, useCurrentButton && textOf(useCurrentButton))
  if (useCurrentButton !== undefined) useCurrentButton.props.onClick()
  formTree = withHooks(panel, { initialView: 'board', initialProjectOpen: true })
  const filledInput = findAll(formTree, (node) => node.type === 'input' && node.props && node.props['data-project-input'] === 'true')[0]
  check(
    'T-90 clicking it fills the Host-resolved path, no typing needed',
    filledInput !== undefined && filledInput.props.defaultValue === sessionRoot,
    JSON.stringify(filledInput && filledInput.props.defaultValue),
  )

  // 5. Opening from the dialog goes through the Host too (not a pure UI value).
  postsBefore = posts.length
  const openButton = findAll(formTree, (node) => node.type === 'button' && textOf(node).indexOf('打开项目') >= 0)[0]
  if (openButton !== undefined) openButton.props.onClick()
  await flush()
  await flush()
  const openPost = posts.slice(postsBefore).filter((post) => post.action === 'openProject')[0]
  check('T-90 the dialog opens through openProject, so the scheduler follows', openPost !== undefined && openPost.path === sessionRoot, JSON.stringify(posts.slice(postsBefore)))

  // restore
  STORAGE.set('godotBridge.taskCenter.project', 'v2:' + PROJECT)
  globalThis.fetch = savedFetch
  withHooks(panel, { initialView: 'board' })
  await flush()
  await flush()
  withHooks(panel, { initialView: 'board' })
}

// ── T-95: pre-T-90 auto-recorded project values migrate to "follow the session" ──
{
  const savedFetch = globalThis.fetch
  const sessionRoot = 'J:\\demo\\session-project'
  const legacy = 'J:\\demo\\legacy-auto'
  const explicit = 'J:\\demo\\explicit'
  const urls = []
  function hostFor(shown, from) {
    return Object.assign({}, HOST, { project: shown, projectRoot: shown, resolvedFrom: from, sessionProject: sessionRoot, registryConsistent: from !== 'panel' })
  }
  globalThis.fetch = async function (url, options) {
    const text = String(url)
    if (options !== undefined && options.method === 'POST') {
      const body = JSON.parse(options.body)
      return { json: async () => ({ ok: true, snapshot: hostFor(body.path === undefined ? sessionRoot : body.path, 'panel') }) }
    }
    if (text.indexOf('/state') >= 0) {
      urls.push(text)
      const match = /[?&]project=([^&]*)/.exec(text)
      return { json: async () => (match === null ? hostFor(sessionRoot, 'session') : hostFor(decodeURIComponent(match[1]), 'panel')) }
    }
    return savedFetch(url, options)
  }

  // 1. A legacy (pre-T-90) value is NOT a pin: the panel follows the session.
  STORAGE.set('godotBridge.taskCenter.project', legacy)
  urls.length = 0
  let tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  const legacyBadge = findAll(tree, (node) => node.props && node.props['data-project-source'] === 'session')[0]
  check(
    'T-95 a legacy auto-recorded project is treated as unpinned (session badge, no ?project)',
    legacyBadge !== undefined && urls.length > 0 && urls.every((url) => url.indexOf('project=') < 0),
    JSON.stringify({ badge: legacyBadge && textOf(legacyBadge), urls: urls.slice(-3), stored: STORAGE.get('godotBridge.taskCenter.project') }),
  )
  check(
    'T-95 the migrated legacy value is no longer readable as a pin',
    STORAGE.get('godotBridge.taskCenter.project') === '' || STORAGE.has('godotBridge.taskCenter.project') === false,
    JSON.stringify({ stored: STORAGE.get('godotBridge.taskCenter.project') }),
  )
  check('T-95 the migration is recorded once for the panel notice', STORAGE.get('godotBridge.taskCenter.projectMigrated') === '1', String(STORAGE.get('godotBridge.taskCenter.projectMigrated')))

  // 2. A second render after migration stays on the session (no re-read of the old value).
  urls.length = 0
  tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  check(
    'T-95 after migration the panel keeps following the session',
    urls.length > 0 && urls.every((url) => url.indexOf('project=') < 0),
    JSON.stringify(urls.slice(-2)),
  )

  // 3. An explicit v2 pin still means manual and is honoured.
  STORAGE.set('godotBridge.taskCenter.project', 'v2:' + explicit)
  urls.length = 0
  tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  await flush()
  const manualBadge = findAll(tree, (node) => node.props && node.props['data-project-source'] === 'manual')[0]
  check(
    'T-95 an explicit v2 pin is manual and still sent to /state',
    manualBadge !== undefined && urls.some((url) => url.indexOf('project=' + encodeURIComponent(explicit)) >= 0),
    JSON.stringify({ badge: manualBadge && textOf(manualBadge), urls: urls.slice(-2) }),
  )
  globalThis.fetch = savedFetch
}

// ── T-99: the panel speaks as the host's real session, never a guess ───────
// DSH's shell owns the shown session (uiWorkspace.selection, persisted as
// dsh.sessions.current). When it is readable the panel uses that id everywhere —
// /state, /list, /task and action bodies — so the panel and the tool path share
// one binding with no URL parameter. When it is not readable the panel keeps the
// per-window fallback and never borrows another session.
{
  const savedFetch = globalThis.fetch
  const stateUrls = []
  const subscribers = []
  let hostSession = 'host-session-A'
  hostServices = {
    uiWorkspace: {
      selection: {
        getSnapshot: () => ({ sessionId: hostSession }),
        subscribe: (listener) => { subscribers.push(listener); return () => {} },
      },
    },
  }
  // A live shell mounts the workspace service AFTER apply(): replay that wiring.
  replayInjects()
  globalThis.fetch = async function (url, options) {
    if (options !== undefined && options.method === 'POST') {
      const body = JSON.parse(options.body)
      posts.push(body)
      return { json: async () => ({ ok: true, snapshot: HOST }) }
    }
    stateUrls.push(String(url))
    return { json: async () => HOST }
  }
  STORAGE.delete('godotBridge.taskCenter.session')
  let t99 = withHooks(panel, { initialView: 'board' })
  await flush()
  t99 = withHooks(panel, { initialView: 'board' })
  await flush()
  t99 = withHooks(panel, { initialView: 'board' })
  check(
    'T-99 /state is asked as the host session, not a minted one',
    stateUrls.length > 0 && stateUrls.every((url) => url.indexOf('session=host-session-A') >= 0),
    JSON.stringify(stateUrls.slice(-2)),
  )
  const startButton = findAll(t99, (node) => node.type === 'button' && textOf(node).indexOf('开始派发') >= 0)[0]
  const postsBefore = posts.length
  if (startButton !== undefined) startButton.props.onClick()
  await flush()
  await flush()
  const startPost = posts.slice(postsBefore).filter((post) => post.action === 'start')[0]
  check('T-99 an action carries the host session too', startPost !== undefined && startPost.session === 'host-session-A', JSON.stringify(startPost))

  // The host switches the shown session: the panel follows without a reload.
  hostSession = 'host-session-B'
  const stateBeforeSwitch = stateUrls.length
  subscribers.slice(-1).forEach((listener) => listener())
  await flush()
  await flush()
  check(
    'T-99 switching the host session reloads as the new session',
    stateUrls.length > stateBeforeSwitch && stateUrls[stateUrls.length - 1].indexOf('session=host-session-B') >= 0,
    JSON.stringify(stateUrls.slice(-2)),
  )

  // The status page names the identity and its source (the visible half of the story).
  const statusTree = withHooks(panel, { initialView: 'status' })
  const sessionRow = findAll(statusTree, (node) => node.props && node.props['data-panel-session'] !== undefined)[0]
  check(
    'T-99 the status page shows the panel session and that the host provided it',
    sessionRow !== undefined && sessionRow.props['data-panel-session'] === 'host-session-B' && sessionRow.props['data-session-source'] === 'host' && textOf(sessionRow).indexOf('宿主提供的当前会话') >= 0,
    sessionRow && JSON.stringify({ id: sessionRow.props['data-panel-session'], source: sessionRow.props['data-session-source'], text: textOf(sessionRow) }),
  )

  // uiSession.current is the second host source (a shell that has no workspace store).
  hostServices = { uiSession: { current: { getSnapshot: () => ({ key: 'host-session-C' }) } } }
  withHooks(panel, { initialView: 'board' })
  await flush()
  withHooks(panel, { initialView: 'board' })
  await flush()
  check(
    'T-99 uiSession.current is used when the workspace store is silent',
    stateUrls[stateUrls.length - 1].indexOf('session=host-session-C') >= 0,
    JSON.stringify(stateUrls.slice(-1)),
  )

  // No host identity at all: the per-window fallback, still nothing borrowed.
  hostServices = {}
  STORAGE.delete('godotBridge.taskCenter.session')
  withHooks(panel, { initialView: 'board' })
  await flush()
  withHooks(panel, { initialView: 'board' })
  await flush()
  const fallbackUrl = stateUrls[stateUrls.length - 1]
  check(
    'T-99 without any host session the panel falls back to its own window id',
    fallbackUrl.indexOf('session=web-') >= 0,
    JSON.stringify(fallbackUrl),
  )
  check('T-99 and it writes that fallback for this window only', String(STORAGE.get('godotBridge.taskCenter.session')).indexOf('web-') === 0, String(STORAGE.get('godotBridge.taskCenter.session')))

  // An EMPTY host selection is not a hint: no "most recent session" fallback.
  hostServices = { uiWorkspace: { selection: { getSnapshot: () => ({}), subscribe: () => () => {} } } }
  withHooks(panel, { initialView: 'board' })
  await flush()
  withHooks(panel, { initialView: 'board' })
  await flush()
  check(
    'T-99 an empty host selection is never guessed into some other session',
    stateUrls[stateUrls.length - 1].indexOf('session=web-') >= 0,
    JSON.stringify(stateUrls.slice(-1)),
  )

  hostServices = {}
  globalThis.fetch = savedFetch
  withHooks(panel, { initialView: 'board' })
  await flush()
  await flush()
}

// ── T-108: the panel tells a self-healing dirty window from an alarm ───────
{
  const savedFetch = globalThis.fetch
  const savedEnvironment = HOST.environment
  const savedWaiting = HOST.tasks.map((task) => task.waitingReason)
  globalThis.fetch = async function () {
    return { json: async () => HOST }
  }
  const environmentBar = (tree) => findAll(tree, (node) => node.props && node.props['data-environment'] !== undefined)[0]

  // A momentarily dirty tree: an INFO line that says it retries by itself.
  HOST.environment = Object.assign({}, savedEnvironment, {
    clean: false,
    code: 'dirty-worktree',
    transient: true,
    checkedAt: new Date(Date.now() - 4000).toISOString(),
    retrying: [{ id: 'T-1', retries: 2, since: new Date(Date.now() - 8000).toISOString(), escalated: false }],
    escalated: [],
  })
  let tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  let bar = environmentBar(tree)
  check(
    'T-108 a transient dirty window is an info line, not an alarm',
    bar !== undefined && bar.props['data-environment'] === 'dirty-transient' && bar.props['data-tone'] === 'info',
    bar && JSON.stringify(bar.props),
  )
  check(
    'T-108 and it says the cards will be retried, never "paused until fixed"',
    bar !== undefined && textOf(bar).indexOf('自动重试') >= 0 && textOf(bar).indexOf('paused until') < 0 && textOf(bar).indexOf('暂停') < 0,
    bar && textOf(bar),
  )

  // A sustained streak: a warning that still names the cards and how it heals.
  HOST.environment = Object.assign({}, savedEnvironment, {
    clean: false,
    code: 'dirty-worktree',
    transient: true,
    checkedAt: new Date(Date.now() - 4000).toISOString(),
    retrying: [],
    escalated: ['T-1'],
    dirty: [{ id: 'T-1', retries: 6, since: new Date(Date.now() - 40000).toISOString(), escalated: true }],
  })
  let alarmed = withHooks(panel, { initialView: 'board' })
  await flush()
  alarmed = withHooks(panel, { initialView: 'board' })
  bar = environmentBar(alarmed)
  check(
    'T-108 a sustained dirty tree escalates to a warning',
    bar !== undefined && bar.props['data-environment'] === 'dirty-sustained' && bar.props['data-tone'] === 'warn',
    bar && JSON.stringify(bar.props),
  )
  check(
    'T-108 the warning names the card and how it recovers',
    bar !== undefined && textOf(bar).indexOf('T-1') >= 0 && textOf(bar).indexOf('提交或暂存') >= 0,
    bar && textOf(bar),
  )

  // The card itself shows the wait chip (amber), not a broken/red chip.
  HOST.tasks[0].waitingReason = 'dirty-worktree'
  HOST.environment = savedEnvironment
  let cleanTree = withHooks(panel, { initialView: 'board' })
  await flush()
  cleanTree = withHooks(panel, { initialView: 'board' })
  const chip = findAll(cleanTree, (node) => node.props && node.props['data-waiting'] === 'dirty-worktree')[0]
  check(
    'T-108 the waiting card carries an amber "waiting for a clean tree" chip',
    chip !== undefined && chip.props['data-tone'] === 'waiting' && textOf(chip).indexOf('等待主树干净') >= 0,
    chip && JSON.stringify({ tone: chip.props['data-tone'], text: textOf(chip) }),
  )
  check('T-108 a clean tree shows no environment line at all', environmentBar(cleanTree) === undefined)

  HOST.environment = savedEnvironment
  HOST.tasks.forEach((task, index) => {
    task.waitingReason = savedWaiting[index]
  })
  globalThis.fetch = savedFetch
  withHooks(panel, { initialView: 'board' })
  await flush()
}

// ── T-110: the panel names the project's Team and the way to create it ─────
{
  const savedFetch = globalThis.fetch
  const savedTeam = HOST.team
  const savedNextStep = HOST.nextStep
  globalThis.fetch = async function () {
    return { json: async () => HOST }
  }
  const teamLine = (tree) => findAll(tree, (node) => node.props && node.props['data-project-team'] !== undefined)[0]

  HOST.team = { ok: false, available: true, source: 'none', sessionScoped: true, session: 'host-session-A', lead: null, leadId: null, leadSession: null, members: [], error: 'no-lead-for-project' }
  HOST.nextStep = { code: 'bootstrap-team', instruction: 'Create the Team in this session: a Lead for this project plus worker/reviewer/tester.' }
  let tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  let line = teamLine(tree)
  check(
    'T-110 the header says the project has no Team',
    line !== undefined && line.props['data-project-team'] === 'missing' && textOf(line).indexOf('该项目团队') >= 0 && textOf(line).indexOf('请在该会话中初始化') >= 0,
    line && textOf(line),
  )
  let statusTree = withHooks(panel, { initialView: 'status' })
  await flush()
  statusTree = withHooks(panel, { initialView: 'status' })
  const guidance = findAll(statusTree, (node) => node.props && node.props['data-status-team'] === 'missing')[0]
  check(
    'T-110 and the panel repeats the executable next step',
    guidance !== undefined && guidance.props['data-status-next-step'] === 'bootstrap-team' && textOf(guidance).indexOf('Lead for this project') >= 0,
    guidance && textOf(guidance),
  )

  HOST.team = {
    ok: true,
    available: true,
    source: 'session',
    sessionScoped: true,
    session: 'host-session-A',
    lead: 'lead',
    leadId: 'session-lead',
    leadSession: 'session-lead',
    members: [
      { name: 'lead', role: 'lead', status: 'running' },
      { name: 'worker-1', role: 'teammate', status: 'running' },
    ],
    error: null,
  }
  HOST.nextStep = null
  let withTeam = withHooks(panel, { initialView: 'board' })
  await flush()
  withTeam = withHooks(panel, { initialView: 'board' })
  line = teamLine(withTeam)
  check(
    'T-110 once the Team exists the line names the Lead and the roster size',
    line !== undefined && line.props['data-project-team'] === 'ok' && line.props['data-team-lead'] === 'lead' && textOf(line).indexOf('2 名成员') >= 0,
    line && textOf(line),
  )
  const healedStatus = withHooks(panel, { initialView: 'status' })
  check('T-110 and the next-step guidance is gone', findAll(healedStatus, (node) => node.props && node.props['data-status-team'] !== undefined).length === 0)

  HOST.team = null
  HOST.nextStep = null
  let legacy = withHooks(panel, { initialView: 'board' })
  await flush()
  legacy = withHooks(panel, { initialView: 'board' })
  check('T-110 an older host without team data renders no line at all', teamLine(legacy) === undefined)

  HOST.team = savedTeam
  HOST.nextStep = savedNextStep
  globalThis.fetch = savedFetch
  withHooks(panel, { initialView: 'board' })
  await flush()
}


// ── T-132: investigation cards in the board and the detail ──────────────────
{
  const nowIso = new Date(now).toISOString()
  const INV = {
    id: 'T-9',
    title: 'Why is the loader slow?',
    status: 'running',
    kind: 'investigate',
    spec: 'Measure the startup loader.',
    acceptance: 'A cause with a measurement.',
    priority: 0,
    dependsOn: [],
    writeFiles: ['plugin/loader.mjs'],
    writeFileCount: 1,
    verify: null,
    base: 'base-sha',
    target: null,
    branch: null,
    worktree: PROJECT + '\\.worktrees\\T-9-1',
    commit: null,
    actualFiles: [],
    requiredRole: null,
    merge: null,
    review: null,
    test: null,
    assignee: { name: 'fixer', session: 'session-fixer' },
    lastAssignee: null,
    attempts: 1,
    maxAttempts: 3,
    interruptions: 0,
    executors: [],
    liveExecutors: 1,
    leaseUntil: new Date(now + 600000).toISOString(),
    dispatch: { status: 'sent', host: 'boot', error: null, leadSession: 'session-lead' },
    ownerSession: 'session-lead',
    createdAt: nowIso,
    updatedAt: nowIso,
    history: [{ at: nowIso, by: 'scheduler', byName: null, from: 'pending', to: 'running', note: 'dispatched' }],
    dependency: { state: 'ready', waitingOn: [], brokenOn: [] },
    queuePosition: 0,
  }
  const REPORT = {
    summary: 'The loader blocks on the config read.',
    body: '# Findings\n\nIt waits for the config file before the first frame.',
    evidence: [{ command: 'node --cpu-prof loader.mjs', exitCode: 1, outputTail: 'total 1200ms' }],
    artifacts: ['.worktrees/probe-T-9-a'],
    probeCommits: ['abc123def'],
    createdAt: nowIso,
    by: '@fixer',
    byName: 'fixer',
  }
  const INV_DONE = Object.assign({}, INV, {
    id: 'T-10',
    title: 'Answered without a report',
    status: 'done',
    report: null,
    leaseUntil: null,
    assignee: null,
    dispatch: null,
    updatedAt: nowIso,
  })

  const savedTasks = HOST.tasks
  const savedCounts = HOST.counts
  const savedFetch = globalThis.fetch
  const investigationCards = function (root) {
    return findAll(root, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card')
  }
  function renderedBoard() {
    let out = withHooks(panel, { initialView: 'board' })
    return out
  }

  HOST.tasks = savedTasks.concat([INV, INV_DONE])
  HOST.counts = Object.assign({}, savedCounts, { total: savedCounts.total + 2, running: savedCounts.running + 1, done: savedCounts.done + 1, investigating: 1 })
  globalThis.fetch = async function (url, options) {
    if (String(url).indexOf('/task?') >= 0) {
      const match = /[?&]id=([^&]+)/.exec(String(url))
      const id = match === null ? '' : decodeURIComponent(match[1])
      if (id === 'T-9') return { json: async () => ({ ok: true, task: Object.assign({}, INV, { report: REPORT }) }) }
      if (id === 'T-10') return { json: async () => ({ ok: true, task: INV_DONE }) }
    }
    return savedFetch(url, options)
  }
  let boardTree = renderedBoard()
  await flush()
  boardTree = renderedBoard()
  const invCard = investigationCards(boardTree).filter((card) => textOf(card).indexOf(INV.title) >= 0)[0]
  check('T-132 an investigation card carries a kind badge', invCard !== undefined && invCard.props['data-kind'] === 'investigate' && textOf(invCard).indexOf('调查') >= 0, invCard && textOf(invCard).slice(0, 160))
  const runningCol = findAll(boardTree, (node) => node.props && node.props.className === 'gbt-col' && node.props['data-group'] === 'running')[0]
  const runningNote = runningCol === undefined ? undefined : findAll(runningCol, (node) => node.props && node.props['data-col-note'] === 'investigating')[0]
  check('T-132 the running column counts the investigations', runningNote !== undefined && textOf(runningNote).indexOf('调查中 1') >= 0, runningNote && textOf(runningNote))
  const filterButtons = findAll(boardTree, (node) => node.type === 'button' && node.props && node.props['data-kind-filter'] !== undefined)
  check('T-132 the board offers a kind filter', filterButtons.map((node) => node.props['data-kind-filter']).join(',') === 'all,dev,investigate', filterButtons.map((node) => node.props['data-kind-filter']).join(','))
  const investFilter = filterButtons.filter((node) => node.props['data-kind-filter'] === 'investigate')[0]
  investFilter.props.onClick()
  await flush()
  boardTree = renderedBoard()
  const filteredCards = investigationCards(boardTree)
  check(
    'T-132 the investigation filter narrows the board to investigation cards',
    filteredCards.length === 2 && filteredCards.every((card) => card.props['data-kind'] === 'investigate'),
    JSON.stringify(filteredCards.map((card) => textOf(card).slice(0, 40))),
  )
  const filteredDoneCol = findAll(boardTree, (node) => node.props && node.props.className === 'gbt-col' && node.props['data-group'] === 'done')[0]
  const filteredDoneCount = filteredDoneCol === undefined ? undefined : findAll(filteredDoneCol, (node) => node.props && node.props.className === 'gbt-colcount')[0]
  check('T-132 the done column count follows the kind filter', filteredDoneCount !== undefined && textOf(filteredDoneCount) === '1', filteredDoneCount && textOf(filteredDoneCount))
  const filteredDoneFoot = filteredDoneCol === undefined ? undefined : findAll(filteredDoneCol, (node) => node.type === 'button' && node.props && node.props['data-action'] === 'done-all')[0]
  check('T-132 the done footer labels the filtered count', filteredDoneFoot !== undefined && textOf(filteredDoneFoot).indexOf('查看全部 · 1') >= 0, filteredDoneFoot && textOf(filteredDoneFoot))
  // The Dev filter hides every investigation: the running note and the done count
  // must follow it instead of advertising cards the column does not show.
  const devFilterButton = findAll(boardTree, (node) => node.type === 'button' && node.props && node.props['data-kind-filter'] === 'dev')[0]
  devFilterButton.props.onClick()
  await flush()
  boardTree = renderedBoard()
  const devRunningCol = findAll(boardTree, (node) => node.props && node.props.className === 'gbt-col' && node.props['data-group'] === 'running')[0]
  const devRunningNote = devRunningCol === undefined ? undefined : findAll(devRunningCol, (node) => node.props && node.props['data-col-note'] === 'investigating')[0]
  check('T-132 the dev filter does not advertise hidden investigations', devRunningNote === undefined, devRunningNote && textOf(devRunningNote))
  const devDoneCol = findAll(boardTree, (node) => node.props && node.props.className === 'gbt-col' && node.props['data-group'] === 'done')[0]
  const devDoneCount = devDoneCol === undefined ? undefined : findAll(devDoneCol, (node) => node.props && node.props.className === 'gbt-colcount')[0]
  check('T-132 the dev filter counts only dev done cards', devDoneCount !== undefined && textOf(devDoneCount) === '1', devDoneCount && textOf(devDoneCount))
  const allFilter = findAll(boardTree, (node) => node.type === 'button' && node.props && node.props['data-kind-filter'] === 'all')[0]
  allFilter.props.onClick()
  await flush()
  boardTree = renderedBoard()
  check('T-132 the all filter restores every card', investigationCards(boardTree).length === savedTasks.length + 2, String(investigationCards(boardTree).length))

  const statusTree = withHooks(panel, { initialView: 'status' })
  await flush()
  const statusRender = withHooks(panel, { initialView: 'status' })
  const invStatus = findAll(statusRender, (node) => node.props && node.props['data-kv'] === 'investigating')[0]
  check('T-132 the status page shows the investigating count', invStatus !== undefined && textOf(invStatus).indexOf('调查中') >= 0, invStatus && textOf(invStatus))

  // Detail: only the Run -> Deliver spine, the report, and no submit box.
  let detailBoard = renderedBoard()
  await flush()
  const openCard = investigationCards(detailBoard).filter((card) => textOf(card).indexOf(INV.title) >= 0)[0]
  openCard.props.onClick()
  await flush()
  await flush()
  const detailTree = withHooks(panel, { initialView: 'board' })
  const drawer = findAll(detailTree, (node) => node.props && node.props['data-detail-overlay'] === 'true')[0]
  const stagesNode = drawer === undefined ? undefined : findAll(drawer, (node) => node.props && node.props['data-detail-kind'] === 'investigate')[0]
  const stageKeys = stagesNode === undefined ? [] : findAll(stagesNode, (node) => node.props && node.props['data-stage'] !== undefined).map((node) => node.props['data-stage'])
  check('T-132 the investigation detail spine is Run -> Deliver only', stageKeys.join(',') === 'run,deliver', JSON.stringify(stageKeys))
  check('T-132 no review/test/merge stage is rendered', stageKeys.indexOf('reviewing') < 0 && stageKeys.indexOf('testing') < 0 && stageKeys.indexOf('done') < 0, JSON.stringify(stageKeys))
  const reportCard = findAll(drawer, (node) => node.props && node.props['data-detail-report-card'] === 'delivered')[0]
  check('T-132 the delivered report is rendered', reportCard !== undefined, reportCard === undefined)
  const reportSummary = findAll(drawer, (node) => node.props && node.props['data-detail-report'] === 'summary')[0]
  check('T-132 the report summary is shown', reportSummary !== undefined && textOf(reportSummary).indexOf(REPORT.summary) >= 0, reportSummary && textOf(reportSummary))
  const reportBody = findAll(drawer, (node) => node.props && node.props['data-detail-report'] === 'body')[0]
  check('T-132 the report body is shown', reportBody !== undefined && textOf(reportBody).indexOf('It waits for the config file') >= 0, reportBody && textOf(reportBody).slice(0, 120))
  const evidenceRows = findAll(drawer, (node) => node.props && node.props['data-evidence-row'] !== undefined)
  check(
    'T-132 the evidence table shows command, exit code and output tail',
    evidenceRows.length === 1 && textOf(evidenceRows[0]).indexOf('--cpu-prof') >= 0 && textOf(evidenceRows[0]).indexOf('total 1200ms') >= 0,
    JSON.stringify(evidenceRows.map((row) => textOf(row))),
  )
  const evidenceExit = findAll(drawer, (node) => node.props && node.props['data-evidence-exit'] === 'true')[0]
  check('T-132 the evidence row carries its exit code', evidenceExit !== undefined && textOf(evidenceExit) === '1', evidenceExit && textOf(evidenceExit))
  const artifacts = findAll(drawer, (node) => node.props && node.props['data-detail-report'] === 'artifacts')[0]
  check('T-132 the report artifacts are listed', artifacts !== undefined && textOf(artifacts).indexOf('.worktrees/probe-T-9-a') >= 0, artifacts && textOf(artifacts))
  const probeWarning = findAll(drawer, (node) => node.props && node.props['data-detail-report'] === 'probe-commits')[0]
  check('T-132 a scratch commit is reported as a warning', probeWarning !== undefined && textOf(probeWarning).indexOf('abc123def') >= 0, probeWarning && textOf(probeWarning))
  check('T-132 a delivered investigation shows a report event', findAll(drawer, (node) => node.props && node.props['data-detail-event'] === 'report').length === 1)
  const submitButton = findAll(drawer, (node) => node.type === 'button' && String(textOf(node)).trim() === '提交')[0]
  check('T-132 a running investigation has no submit box', submitButton === undefined, submitButton && textOf(submitButton))
  check('T-132 the investigation detail shows no target/merge progress line', findAll(drawer, (node) => node.props && node.props['data-detail-target'] !== undefined).length === 0)
  const devCard = investigationCards(renderedBoard()).filter((card) => textOf(card).indexOf('Tail output feature') >= 0)[0]
  devCard.props.onClick()
  await flush()
  await flush()
  const devDetail = withHooks(panel, { initialView: 'board' })
  const devDrawer = findAll(devDetail, (node) => node.props && node.props['data-detail-overlay'] === 'true')[0]
  const devStageKeys = devDrawer === undefined ? [] : findAll(devDrawer, (node) => node.props && node.props['data-stage'] !== undefined).map((node) => node.props['data-stage'])
  check('T-132 the dev card keeps its five-stage spine', devStageKeys.length === 5, JSON.stringify(devStageKeys))

  // Missing report: a done investigation without one says so.
  const missingCard = investigationCards(renderedBoard()).filter((card) => textOf(card).indexOf(INV_DONE.title) >= 0)[0]
  missingCard.props.onClick()
  await flush()
  await flush()
  const missingDetail = withHooks(panel, { initialView: 'board' })
  const missingDrawer = findAll(missingDetail, (node) => node.props && node.props['data-detail-overlay'] === 'true')[0]
  const missingCardNode = findAll(missingDrawer, (node) => node.props && node.props['data-detail-report-card'] === 'missing')[0]
  check('T-132 an investigation without a report says it is missing', missingCardNode !== undefined && textOf(missingCardNode).indexOf('报告未交付') >= 0, missingCardNode && textOf(missingCardNode).slice(0, 160))

  HOST.tasks = savedTasks
  HOST.counts = savedCounts
  globalThis.fetch = savedFetch
  withHooks(panel, { initialView: 'board' })
  await flush()
}


// ── T-133: the panel palette uses only tokens the DSH theme defines ─────────
{
  const cssText = styleTags.map((tag) => String(tag.textContent || '')).join('\n')
  const forbidden = [
    '--dsw-alias-bg-layout',
    '--dsw-alias-bg-layer-4',
    '--dsw-alias-label-error',
    '--dsw-alias-state-warning-primary',
    '#f4f5f7',
    '#0d6b5c',
    'rgba(20,140,120',
    'rgba(79,124,255',
    'rgba(47,179,68',
    'rgba(245,159,0',
    'rgba(229,72,77',
    'rgba(121,80,242',
    'rgba(62,207,142',
    '#2f9e44',
    '#b7791f',
    '#3b5bdb',
    '#7048e8',
    '#8a8f98',
    '#2fb344',
    '#3ecf8e',
    '#e5645c',
    '#c92a2a',
    '#b26a00',
    '#d33',
  ]
  check(
    'T-133 the bundle carries no invented DSH token and no hardcoded theme colour',
    forbidden.every((needle) => cssText.indexOf(needle) < 0),
    forbidden.filter((needle) => cssText.indexOf(needle) >= 0).join(','),
  )
  const kindRule = /\.gbt-kindfilter\{[^}]*\}/.exec(cssText)
  check(
    'T-133 the kind filter is not a light band any more',
    kindRule !== null && kindRule[0].indexOf('background:transparent') >= 0 && kindRule[0].indexOf('#f4f5f7') < 0,
    kindRule && kindRule[0],
  )
  const activeRule = /\.gbt-kindfilterbtn\[data-active="true"\]\{[^}]*\}/.exec(cssText)
  check(
    'T-133 the selected filter pill uses bg-module-platform + label-primary without a bright fallback',
    activeRule !== null &&
      activeRule[0].indexOf('var(--dsw-alias-bg-module-platform)') >= 0 &&
      activeRule[0].indexOf('var(--dsw-alias-label-primary)') >= 0 &&
      activeRule[0].indexOf('#fff') < 0 &&
      activeRule[0].indexOf('box-shadow') < 0,
    activeRule && activeRule[0],
  )
  const hoverRule = /\.gbt-kindfilterbtn:hover\{[^}]*\}/.exec(cssText)
  check(
    'T-133 the filter hover uses interactive-bg-hover',
    hoverRule !== null && hoverRule[0].indexOf('var(--dsw-alias-interactive-bg-hover)') >= 0,
    hoverRule && hoverRule[0],
  )
  check(
    'T-133 tabs use module/hover tokens',
    /\.gbt-tab\[data-active="true"\]\{[^}]*bg-module-platform/.test(cssText) && /\.gbt-tab:hover\{[^}]*interactive-bg-hover/.test(cssText),
  )
  check(
    'T-133 chips and pills sit on neutral module/layer backgrounds',
    /\.gbt-chip\{[^}]*var\(--dsw-alias-bg-layer-2\)/.test(cssText) && /\.gbt-pill\{[^}]*var\(--dsw-alias-bg-layer-2\)/.test(cssText),
  )
  check(
    'T-133 the investigation accent is the brand token, not teal',
    /\.gbt-chip\[data-kind="investigate"\][^}]*state-business-primary/.test(cssText) &&
      /\.gbt-colnote\{[^}]*state-business-primary/.test(cssText) &&
      /\.gbt-reportcard\{[^}]*state-business-primary/.test(cssText),
  )
  check(
    'T-133 status chips use the DSH state tokens',
    /\.gbt-chip\[data-tone="done"\]\{[^}]*state-success-primary/.test(cssText) &&
      /\.gbt-chip\[data-tone="blocked"\]\{[^}]*state-error-primary/.test(cssText) &&
      /\.gbt-chip\[data-tone="testing"\]\{[^}]*state-warn-label/.test(cssText) &&
      /\.gbt-chip\[data-tone="running"\]\{[^}]*state-success-primary/.test(cssText),
  )
  check(
    'T-133 the running dot and the hover border are tokens',
    /\.gbt-dot\[data-running="true"\]\{[^}]*state-success-primary/.test(cssText) && /\.gbt-card:hover\{[^}]*state-business-primary/.test(cssText),
  )
  check(
    'T-133 the pill status tones are token-mapped',
    /\.gbt-pill\[data-status="done"\]\{[^}]*state-success-primary/.test(cssText) &&
      /\.gbt-pill\[data-status="testing"\]\{[^}]*state-warn-label/.test(cssText) &&
      /\.gbt-pill\[data-status="blocked"\]\{[^}]*state-error-primary/.test(cssText),
  )
}


// ── T-135: the board is its own bounded horizontal scrollport ──────────────
{
  const cssText = styleTags.map((tag) => String(tag.textContent || '')).join('\n')
  const wrapRule = /\.gbt-boardwrap\{[^}]*\}/.exec(cssText)
  check(
    'T-135 the board wrap is a bounded flex column',
    wrapRule !== null && /display:flex/.test(wrapRule[0]) && /flex-direction:column/.test(wrapRule[0]) && /height:100%/.test(wrapRule[0]) && /min-height:0/.test(wrapRule[0]),
    wrapRule && wrapRule[0],
  )
  const boardRule = /\.gbt-board\{[^}]*\}/.exec(cssText)
  check(
    'T-135 the board scrolls its own overflow',
    boardRule !== null && /flex:1 1 auto/.test(boardRule[0]) && /min-height:0/.test(boardRule[0]) && /overflow:auto/.test(boardRule[0]) && boardRule[0].indexOf('min-height:100%') < 0,
    boardRule && boardRule[0],
  )
  const cardsRule = /\.gbt-cards\{[^}]*\}/.exec(cssText)
  check(
    'T-135 the card list can shrink and scroll inside its column',
    cardsRule !== null && /flex:1 1 auto/.test(cardsRule[0]) && /min-height:0/.test(cardsRule[0]) && /overflow:auto/.test(cardsRule[0]),
    cardsRule && cardsRule[0],
  )
  check('T-135 the board advertises a thin scrollbar', /\.gbt-board\{[^}]*scrollbar-width:thin/.test(cssText))

  const savedTasks = HOST.tasks
  const savedCounts = HOST.counts
  function renderBoard() {
    return withHooks(panel, { initialView: 'board' })
  }
  function scrollTargetOf(tree) {
    const boardNode = findAll(tree, (node) => node.props && node.props.className === 'gbt-board')[0]
    return boardNode === undefined ? undefined : boardNode.props['data-scroll-target']
  }
  function kindFilterInsideBoard(tree) {
    const boardNode = findAll(tree, (node) => node.props && node.props.className === 'gbt-board')[0]
    return boardNode === undefined ? -1 : findAll(boardNode, (node) => node.props && node.props.className === 'gbt-kindfilter').length
  }

  let tree = renderBoard()
  await flush()
  tree = renderBoard()
  check('T-135 a mixed board points at the first non-empty column', scrollTargetOf(tree) === 'ready', String(scrollTargetOf(tree)))
  check('T-135 the kind filter stays outside the board scrollport', kindFilterInsideBoard(tree) === 0)

  HOST.tasks = savedTasks.map(function (task) {
    return Object.assign({}, task, { status: 'done', dependency: { state: 'ready', waitingOn: [], brokenOn: [] } })
  })
  HOST.counts = Object.assign({}, savedCounts, { total: savedTasks.length, pending: 0, ready: 0, waiting: 0, running: 0, reviewing: 0, testing: 0, done: savedTasks.length, blocked: 0, cancelled: 0 })
  await flush()
  tree = renderBoard()
  check('T-135 an all-done board points at the done column', scrollTargetOf(tree) === 'done', String(scrollTargetOf(tree)))

  HOST.tasks = [Object.assign({}, savedTasks[0], { id: 'T-99', status: 'archived', dependency: { state: 'ready', waitingOn: [], brokenOn: [] } })]
  HOST.counts = Object.assign({}, savedCounts, { total: 1 })
  await flush()
  tree = renderBoard()
  check('T-135 a board with no visible card has an empty scroll target', scrollTargetOf(tree) === '', JSON.stringify(scrollTargetOf(tree)))
  check('T-135 the seven columns survive the empty per-column case', findAll(tree, (node) => node.props && node.props.className === 'gbt-col').length === 7)

  HOST.tasks = savedTasks
  HOST.counts = savedCounts
  await flush()
  renderBoard()
}


// ── T-140: the card verdict area reads as part of the card ─────────────────
{
  const cssText = styleTags.map((tag) => String(tag.textContent || '')).join('\n')
  const rule = (selector) => {
    const match = new RegExp(selector + '\\{[^}]*\\}').exec(cssText)
    return match === null ? null : match[0]
  }
  const verdict = rule('\\.gbt-cardverdict')
  check(
    'T-140 the verdict area is separated from the card body',
    verdict !== null &&
      /display:flex/.test(verdict) &&
      /flex-direction:column/.test(verdict) &&
      /gap:8px/.test(verdict) &&
      /margin-top:2px/.test(verdict) &&
      /padding-top:10px/.test(verdict) &&
      /border-top:0\.5px solid var\(--dsw-alias-border-l4\)/.test(verdict),
    verdict,
  )
  const head = rule('\\.gbt-cardverdicthead')
  check(
    'T-140 the verdict heading is a quiet 11px label',
    head !== null && /font-size:11px/.test(head) && /line-height:1\.4/.test(head) && /font-weight:500/.test(head) && /var\(--dsw-alias-label-tertiary\)/.test(head) && /letter-spacing:\.02em/.test(head),
    head,
  )
  const actions = rule('\\.gbt-cardverdictactions')
  check(
    'T-140 the verdict buttons share one row with an 8px gap',
    actions !== null && /display:flex/.test(actions) && /align-items:center/.test(actions) && /gap:8px/.test(actions) && /flex-wrap:wrap/.test(actions),
    actions,
  )
  const buttons = rule('\\.gbt-cardverdict \\.gbt-btn')
  check(
    'T-140 the two verdict buttons are equal halves at 30px',
    buttons !== null && /flex:1 1 0/.test(buttons) && /min-width:0/.test(buttons) && /height:30px/.test(buttons) && /padding:0 10px/.test(buttons),
    buttons,
  )
  const form = rule('\\.gbt-cardverdictform')
  check('T-140 the reason form stacks its label, textarea and buttons', form !== null && /display:flex/.test(form) && /flex-direction:column/.test(form) && /gap:6px/.test(form), form)
  const label = rule('\\.gbt-cardverdictform label')
  check('T-140 the reason label is a small secondary label', label !== null && /font-size:11px/.test(label) && /var\(--dsw-alias-label-secondary\)/.test(label) && /margin:0/.test(label), label)
  const textarea = rule('\\.gbt-cardverdictform textarea')
  check(
    'T-140 the reason textarea is a full-width token-styled field',
    textarea !== null &&
      /width:100%/.test(textarea) &&
      /min-height:64px/.test(textarea) &&
      /padding:7px 9px/.test(textarea) &&
      /border:0\.5px solid var\(--dsw-alias-border-l4\)/.test(textarea) &&
      /border-radius:8px/.test(textarea) &&
      /background:var\(--dsw-alias-bg-layer-3\)/.test(textarea) &&
      /color:var\(--dsw-alias-label-primary\)/.test(textarea) &&
      /font:inherit/.test(textarea) &&
      /font-size:12px/.test(textarea) &&
      /resize:vertical/.test(textarea),
    textarea,
  )
  const card = rule('\\.gbt-card')
  check('T-140 the card itself gets the extra 10/11 padding and 7px rhythm', card !== null && /padding:10px 11px/.test(card) && /gap:7px/.test(card), card)
  const newRules = [verdict, head, actions, buttons, form, label, textarea].filter((body) => body !== null).join('\n')
  check('T-140 the new rules use only DSH tokens, no hardcoded colour', newRules.indexOf('#') < 0 && newRules.indexOf('rgba(') < 0, newRules.slice(0, 200))

  const savedReview = HOST.tasks.filter((entry) => entry.id === 'T-1')[0].status
  const savedTest = HOST.tasks.filter((entry) => entry.id === 'T-2')[0].status
  HOST.tasks.filter((entry) => entry.id === 'T-1')[0].status = 'reviewing'
  HOST.tasks.filter((entry) => entry.id === 'T-2')[0].status = 'testing'
  let tree = withHooks(panel, { initialView: 'board' })
  await flush()
  tree = withHooks(panel, { initialView: 'board' })
  const bars = findAll(tree, (node) => node.props && node.props['data-verdict-phase'] !== undefined)
  const reviewBar = bars.filter((bar) => bar.props['data-verdict-phase'] === 'review')[0]
  const testBar = bars.filter((bar) => bar.props['data-verdict-phase'] === 'test')[0]
  const variantOf = (bar, action) => {
    const button = findAll(bar, (node) => node.props && node.props['data-verdict-action'] === action)[0]
    return button === undefined ? undefined : button.props['data-variant']
  }
  check(
    'T-140 passing is the primary action, blocking stays a danger outline',
    variantOf(reviewBar, 'approveReview') === 'primary' &&
      variantOf(reviewBar, 'requestChanges') === 'danger' &&
      variantOf(testBar, 'passTest') === 'primary' &&
      variantOf(testBar, 'failTest') === 'danger',
    JSON.stringify({ review: [variantOf(reviewBar, 'approveReview'), variantOf(reviewBar, 'requestChanges')], test: [variantOf(testBar, 'passTest'), variantOf(testBar, 'failTest')] }),
  )
  const reviewActions = findAll(reviewBar, (node) => node.props && node.props.className === 'gbt-cardverdictactions')[0]
  const reviewButtons = reviewActions === undefined ? [] : findAll(reviewActions, (node) => node.type === 'button')
  check(
    'T-140 both verdict buttons sit in one actions row as plain gbt-btn',
    reviewButtons.length === 2 && reviewButtons.every((button) => button.props.className === 'gbt-btn'),
    JSON.stringify(reviewButtons.map((button) => button.props['data-verdict-action'])),
  )
  check('T-140 the verdict area keeps its head, actions and phase marker', reviewBar !== undefined && findAll(reviewBar, (node) => node.props && node.props.className === 'gbt-cardverdicthead').length === 1)
  HOST.tasks.filter((entry) => entry.id === 'T-1')[0].status = savedReview
  HOST.tasks.filter((entry) => entry.id === 'T-2')[0].status = savedTest
  await flush()
  withHooks(panel, { initialView: 'board' })
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)