// Temporary probe: load the browser half under a stub module loader, run the
// plugin's apply() against stub services, then render the task-center views
// once with a minimal createElement/hook shim and drive real store actions by
// invoking the onClick handlers found in the produced element tree.
//
// There is no React on this machine, so this is not a substitute for looking at
// the page: it proves the registration contract, that every view renders
// without throwing, and that the store's actions — the board's transitions and
// the file-lock arbitration rule in particular — mutate state as specified.
//
// Run by `npm test` (see scripts/test/run.mjs); safe to run directly.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// File-relative, not CWD-relative: a test that silently reads the wrong
// file after a `cd` is worse than no test.
const SRC = fileURLToPath(new URL('../../client/client.js', import.meta.url))
let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || detail === undefined ? '' : '  -> ' + detail}`)
}

// ── the bundle's host environment ──────────────────────────────────────────
let registration = null
const styleTags = []
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
}
globalThis.document = {
  head: {
    appendChild(node) {
      styleTags.push(node)
    },
  },
  createElement() {
    return {
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      remove() {
        this.removed = true
      },
    }
  },
}
new Function(readFileSync(SRC, 'utf8'))()
check('bundle registers a module factory', registration !== null)
check('module id is the package name', registration.id === 'godot-bridge', registration.id)

// ── a minimal React ────────────────────────────────────────────────────────
let depth = 0
let hookIndex = 0
let rootHookIndex = 0
let overrides = null

function withHooks(fn, props) {
  depth++
  const isRoot = depth === 1
  if (isRoot) rootHookIndex = 0
  const saved = hookIndex
  hookIndex = 0
  const out = fn(props)
  hookIndex = saved
  depth--
  return out
}
function overridden() {
  if (depth !== 1 || overrides === null) return undefined
  const value = overrides[rootHookIndex]
  rootHookIndex++
  return value
}
const captured = {}
const React = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props)
    if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
    if (typeof type === 'function') return withHooks(type, merged)
    return { type, props: merged }
  },
  useState(initial) {
    const forced = overridden()
    hookIndex++
    if (forced !== undefined) return [forced, () => {}]
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useReducer(_reducer, initial) {
    hookIndex++
    return [initial, () => {}]
  },
  useEffect() {
    hookIndex++
  },
  useMemo(factory) {
    return factory()
  },
  useCallback(fn) {
    return fn
  },
  useRef(value) {
    hookIndex++
    return { current: value }
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    hookIndex++
    captured.getSnapshot = getSnapshot
    return getSnapshot()
  },
  Fragment: Symbol('Fragment'),
}

// ── stub host services ─────────────────────────────────────────────────────
const dicts = {}
let locale = 'zh'
const registrations = []
const injected = []
const effects = []
const disposers = []
let slotWithdrawals = 0
let autoUnsubscribes = 0
const ctx = {
  locale: {
    register(ns, table) {
      dicts[ns] = table
      return () => {}
    },
    bind(ns) {
      const table = dicts[ns]
      return (key) =>
        table && table[locale] && table[locale][key] !== undefined ? table[locale][key] : key
    },
    subscribe() {
      autoUnsubscribes++
      return () => {}
    },
    getSnapshot() {
      return { id: locale }
    },
  },
  slots: {
    inject(slot, callback) {
      injected.push(slot)
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register(meta, component) {
      registrations.push({ meta, component })
      return () => {
        slotWithdrawals++
      }
    },
  },
  effect(callback, label) {
    effects.push(label)
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push({ label, disposer })
    return typeof disposer === 'function' ? disposer : () => {}
  },
  inject() {
    // The configForms path only runs where the settings service exists.
    return () => {}
  },
}

// ── load the plugin half and apply it ──────────────────────────────────────
const required = []
const plugin = registration.factory((specifier) => {
  required.push(specifier)
  if (specifier === 'react') return React
  throw new Error('unexpected require: ' + specifier)
})
check('factory requires react only', required.length === 1 && required[0] === 'react', required.join(','))
check('factory exports apply', typeof plugin.apply === 'function')
check(
  'factory injects slots and locale',
  Array.isArray(plugin.inject) && plugin.inject.indexOf('slots') >= 0 && plugin.inject.indexOf('locale') >= 0,
  JSON.stringify(plugin.inject),
)

plugin.apply(ctx)

const glyph = registrations.filter((entry) => entry.meta.name === 'sidebar.panellist')
const panels = registrations.filter((entry) => entry.meta.name === 'main')
check('registers one sidebar.panellist entry', glyph.length === 1, String(glyph.length))
check('panel id is task-center', glyph[0] && glyph[0].meta.id === 'task-center', glyph[0] && glyph[0].meta.id)
check('panel key matches the rail id', panels[0] && panels[0].meta.key === 'task-center', panels[0] && panels[0].meta.key)
check('label follows the locale', glyph[0] && glyph[0].meta.label() === '任务', glyph[0] && glyph[0].meta.label())
locale = 'en'
check('label follows an English switch', glyph[0] && glyph[0].meta.label() === 'Tasks', glyph[0] && glyph[0].meta.label())
locale = 'zh'
check('injects both slots', injected.indexOf('sidebar.panellist') >= 0 && injected.indexOf('main') >= 0, injected.join(','))
check(
  'task center styles injected alongside the form styles',
  styleTags.length === 2 &&
    styleTags.some((tag) => (tag.attributes || {})['data-plugin-css'] === 'godot-bridge/task-center.css'),
  styleTags.map((tag) => (tag.attributes || {})['data-plugin-css'] || '(form)').join(','),
)
check(
  'task center effects labelled',
  [
    'godot-bridge: task center dictionaries',
    'godot-bridge: task center styles',
    'godot-bridge: task center panel',
  ].every((label) => effects.indexOf(label) >= 0),
  effects.join(' | '),
)
check('locale subscription is released with the component', autoUnsubscribes >= 0)

const table = dicts.godotBridgeTaskCenter
check('locale dictionary registered', table !== undefined)
const zhKeys = Object.keys(table.zh).sort()
const enKeys = Object.keys(table.en).sort()
check('zh/en key sets match', zhKeys.length === enKeys.length && zhKeys.every((k, i) => k === enKeys[i]), `zh=${zhKeys.length} en=${enKeys.length}`)

// ── element-tree helpers ───────────────────────────────────────────────────
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit))
    return
  }
  if (node.type !== undefined) visit(node)
  if (node.props) walk(node.props.children, visit)
}
function findAll(root, predicate) {
  const out = []
  walk(root, (node) => {
    if (predicate(node)) out.push(node)
  })
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
function textIn(root, needle) {
  return findAll(root, (node) => textOf(node).indexOf(needle) >= 0)
}
function buttonLabelled(node, label) {
  return findAll(
    node,
    (child) =>
      child.type === 'button' &&
      typeof child.props.children === 'string' &&
      child.props.children.indexOf(label) >= 0,
  )[0]
}
const className = (name) => (node) => node.type === 'div' && node.props && node.props.className === name

function render(view, selectedId, editing, open, selection) {
  overrides = [undefined, view, selectedId, editing, open, selection]
  const out = withHooks(panels[0].component, {})
  overrides = null
  return out
}
const expanded = { active: true, queued: true, blocked: true, review: true, draft: true, done: true }
function snapshot() {
  return captured.getSnapshot()
}

// ── board: cards in status columns ─────────────────────────────────────────
let tree = render('board')
check('board renders without throwing', tree !== null && tree !== undefined)
check('board renders six status columns', findAll(tree, className('gbt-col')).length === 6, String(findAll(tree, className('gbt-col')).length))
check('board renders cards, not rows', findAll(tree, className('gbt-card')).length === 8, String(findAll(tree, className('gbt-card')).length))
check('board shows no queue rows', findAll(tree, className('gbt-row')).length === 0)
tree = render('board', null, null, expanded)
check('expanding the closed column reveals every card', findAll(tree, className('gbt-card')).length === 10, String(findAll(tree, className('gbt-card')).length))

tree = render('board')
check('a card shows how many files its agent holds', textIn(tree, '🔒 1').length >= 2, String(textIn(tree, '🔒 1').length))
check('a card shows how many files its agent waits for', textIn(tree, '⏳ 1').length >= 1, String(textIn(tree, '⏳ 1').length))

// ── queue and archive ──────────────────────────────────────────────────────
tree = render('queue', null, null, null, new Set(['T-13']))
check('queue renders rows', findAll(tree, className('gbt-row')).length === 3, String(findAll(tree, className('gbt-row')).length))
check('queue lists the draft release control', buttonLabelled(tree, '发布到队列') !== undefined)
check('queue exposes ordering controls', findAll(tree, (n) => n.type === 'button' && n.props.title === '上移').length === 2)
tree = render('archive')
check('archive renders flat, without a collapse header', textIn(tree, '▸ ').length === 0 && textIn(tree, '▾ ').length === 0)
check('archive lists closed tasks', findAll(tree, className('gbt-row')).length === 2, String(findAll(tree, className('gbt-row')).length))

// ── file locks ─────────────────────────────────────────────────────────────
tree = render('files')
const lockRows = findAll(tree, className('gbt-lockrow'))
check('files view lists every locked path', lockRows.length === 5, String(lockRows.length))
check('contended files sort first', textOf(lockRows[0]).indexOf('scripts/core/damage.gd') >= 0, textOf(lockRows[0]))
check(
  'unowned files sort last',
  lockRows.slice(3).every((row) => textOf(row).indexOf('空闲') >= 0),
  lockRows.map((row) => textOf(row).slice(0, 34)).join(' | '),
)
check('the wait list marks the next winner', textOf(lockRows[0]).indexOf('① @fixer') >= 0, textOf(lockRows[0]))
check('free files are labelled free', textOf(lockRows[3]).indexOf('空闲') >= 0, textOf(lockRows[3]))

// ── detail ─────────────────────────────────────────────────────────────────
tree = render('board', 'T-09')
check('detail renders', textIn(tree, '存档系统读写回归').length > 0)
check('detail lists the files the agent holds', textIn(tree, '🔒 scripts/save/save_manager.gd').length > 0)
check('detail lists the file the agent waits for', textIn(tree, '⏳ scripts/core/damage.gd').length > 0)
const openSession = buttonLabelled(tree, '查看会话')
check('detail offers the session jump as a disabled placeholder', openSession !== undefined && openSession.props.disabled === true)
tree = render('board', 'T-11')
check('blocked detail shows its dependency', textIn(tree, 'T-06').length > 0)
tree = render('board', null, 'new')
check('form renders', textIn(tree, '新建任务').length > 0)
check('form requires a title', textIn(tree, '标题不能为空').length > 0)
check('form no longer asks for write scopes', textIn(tree, '写入范围').length === 0)

// ── board transitions ──────────────────────────────────────────────────────
check('read path returns the seeded board', snapshot().tasks.length === 10, String(snapshot().tasks.length))
tree = render('queue', null, null, null, new Set(['T-13']))
buttonLabelled(tree, '发布到队列').props.onClick()
check(
  'publishing moves the draft into the queue',
  snapshot().tasks.filter((t) => t.status === 'draft').length === 0 &&
    snapshot().tasks.filter((t) => t.status === 'queued').length === 3,
  JSON.stringify(snapshot().tasks.map((t) => t.id + ':' + t.status)),
)
check('publishing appends a history entry', snapshot().tasks.filter((t) => t.id === 'T-13')[0].history.length === 2)

const queuedIds = () =>
  snapshot()
    .tasks.filter((t) => t.status === 'queued')
    .sort((a, b) => a.order - b.order)
    .map((t) => t.id)
const before = queuedIds().join(',')
findAll(render('queue'), (n) => n.type === 'button' && n.props.title === '上移' && n.props.disabled === false)[0].props.onClick()
check('reordering swaps two queue positions', queuedIds().join(',') !== before, `${before} -> ${queuedIds().join(',')}`)

buttonLabelled(render('queue'), '领取').props.onClick()
const claimed = snapshot().tasks.filter((t) => t.status === 'in_progress')
check('claiming assigns an owner and a lease', claimed.length === 4 && claimed.every((t) => t.assignee && t.leaseUntil))

buttonLabelled(render('board', 'T-10'), '验收通过').props.onClick()
check('approval closes the task', snapshot().tasks.filter((t) => t.id === 'T-10')[0].status === 'done')
buttonLabelled(render('board', 'T-11'), '解除阻塞').props.onClick()
check('clearing a block returns it to progress', snapshot().tasks.filter((t) => t.id === 'T-11')[0].status === 'in_progress')

// ── the lock arbitration rule ──────────────────────────────────────────────
const path = 'scripts/core/damage.gd'
const lockBefore = snapshot().locks[path]
check('the contended file starts with two waiters', lockBefore.queue.length === 2 && lockBefore.holder === '@combat-2')
const waitedLongest = lockBefore.queue.slice().sort((a, b) => a.since - b.since)[0]
check('@fixer is the longest-waiting reservation', waitedLongest.who === '@fixer', waitedLongest.who)

buttonLabelled(findAll(render('files'), className('gbt-lockrow'))[0], '释放').props.onClick()
const lockAfter = snapshot().locks[path]
check('release hands the file to the longest waiter', lockAfter.holder === '@fixer', String(lockAfter.holder))
check('the shorter waiter stays queued', lockAfter.queue.length === 1 && lockAfter.queue[0].who === '@explore-3', JSON.stringify(lockAfter.queue))
check(
  'release and grant are one commit',
  snapshot().lastEvent.kind === 'granted' && snapshot().lastEvent.who === '@fixer',
  JSON.stringify(snapshot().lastEvent),
)
check('an agent that never reserved gains nothing', lockAfter.holder !== '@combat-2')

const freeRow = findAll(render('files'), className('gbt-lockrow')).filter((row) => textOf(row).indexOf('project.godot') >= 0)[0]
buttonLabelled(freeRow, '模拟 agent 取用').props.onClick()
check('taking a free file grants it outright', snapshot().locks['project.godot'].holder === '@sim-1', String(snapshot().locks['project.godot'].holder))
check('taking a free file queues nobody', snapshot().locks['project.godot'].queue.length === 0)
const takenRow = findAll(render('files'), className('gbt-lockrow')).filter((row) => textOf(row).indexOf('project.godot') >= 0)[0]
buttonLabelled(takenRow, '释放').props.onClick()
check('releasing a free-taken file leaves it unowned', snapshot().locks['project.godot'].holder === null)
check('releasing with an empty queue reports a free file', snapshot().lastEvent.kind === 'freed', JSON.stringify(snapshot().lastEvent))

// ── simulate ───────────────────────────────────────────────────────────────
buttonLabelled(render('board'), '模拟 agent 活动').props.onClick()
check('simulate produced an event', snapshot().lastEvent !== null, JSON.stringify(snapshot().lastEvent))
buttonLabelled(render('board'), '重置演示数据').props.onClick()
check('reset restores the seeded locks', snapshot().locks['scripts/core/damage.gd'].holder === '@combat-2')

// ── teardown: unloading the row must withdraw slots and styles ─────────────
let teardownError = null
try {
  disposers
    .slice()
    .reverse()
    .forEach((entry) => entry.disposer())
} catch (error) {
  teardownError = error
}
check('teardown runs without throwing', teardownError === null, teardownError && teardownError.message)
check('teardown withdraws both slot registrations', slotWithdrawals === 2, String(slotWithdrawals))
check('teardown removes the injected styles', styleTags.every((tag) => tag.removed === true))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
