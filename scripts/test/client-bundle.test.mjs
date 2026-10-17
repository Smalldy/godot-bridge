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

// Host payload
const now = Date.now()
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
    attempts: 1,
    maxAttempts: 3,
    requiresReview: false,
    leaseUntil: new Date(now + 600000).toISOString(),
    dispatch: { status: 'sent', target: 'fixer', error: null },
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
    requiresReview: false,
    leaseUntil: null,
    dispatch: null,
    createdAt: new Date(now - 30000).toISOString(),
    updatedAt: new Date(now - 30000).toISOString(),
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
  seq: 3,
  updatedAt: new Date(now).toISOString(),
  dispatch: { state: 'paused', maxConcurrent: 3, allowSpawn: true, maxWorkAgents: 4, maxAttempts: 3 },
  counts: { total: 2, pending: 1, ready: 0, running: 1, review: 0, done: 0, blocked: 0, cancelled: 0 },
  queue: [],
  tasks: TASKS,
  locks: [],
  scheduler: { lastTickAt: now, lastError: null },
  serverTime: new Date(now).toISOString(),
}
let loads = 0
const posts = []
globalThis.fetch = async function (url, options) {
  if (options !== undefined && options.method === 'POST') {
    posts.push(JSON.parse(options.body))
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
check('the board has six columns', findAll(tree, (node) => node.props && node.props.className === 'gbt-col').length === 6, String(findAll(tree, (node) => node.props && node.props.className === 'gbt-col').length))
check('both cards are rendered', findAll(tree, (node) => node.type === 'article' && node.props && node.props.className === 'gbt-card').length === 2)
check('the dependency chip is rendered', textOf(tree).indexOf('T-1') >= 0)

const startButton = findButton(tree, '开始派发')
check('a start button is offered while paused', startButton !== undefined)
startButton.props.onClick()
await flush()
check('start sends the start action', posts.length === 1 && posts[0].action === 'start', JSON.stringify(posts))
check('and carries the project', posts[0].project === PROJECT, JSON.stringify(posts[0]))
const loadsBeforeRefresh = loads
findButton(tree, '刷新').props.onClick()
await flush()
check('refresh asks the Host again', loads > loadsBeforeRefresh, String(loads))

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