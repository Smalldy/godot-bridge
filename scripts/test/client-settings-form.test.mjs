// SettingsForm: dispatch settings + the T-198 decision policy editor.
//
// The tests drive the component with a stub React (no DOM): the module keeps its
// drafts in the factory closure, so calling the component again after an onChange
// renders the edited value, exactly like a real re-render would. Each block uses
// its own factory so one block's unsaved edit cannot leak into the next.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DECISION_EVENT_CATALOG, resolveDecisionPolicy } from '../../plugin/task-center/schema.mjs'

const require = createRequire(import.meta.url)
const { createSettingsForm } = require('../../client/src/views/settings-form.cjs')

const HEAD = readFileSync(new URL('../../client/src/00-head.part', import.meta.url), 'utf8')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const Modal = (props) => ({ type: 'modal', props: props })
const posts = []
const store = {
  send: async (action, body) => {
    posts.push({ action: action, body: body })
    return { ok: true, payload: { ok: true } }
  },
}
const react = {
  useRef: () => ({ current: null }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

function newForm(sendOverride) {
  return createSettingsForm({ React: react, h: h, Modal: Modal, store: sendOverride === undefined ? store : { send: sendOverride } })
}

// A dictionary-shaped translate: unknown keys fall back to the key (like the
// real t), error keys resolve so the localized failure text is observable.
const t = (key) => (String(key).indexOf('err_') === 0 ? 'ERR:' + key : key)
const defaults = resolveDecisionPolicy({}, {})
const globalView = resolveDecisionPolicy({ 'dev-timeout': { timeoutSeconds: 400 } }, {})
const projectView = resolveDecisionPolicy({ 'dev-timeout': { timeoutSeconds: 400 } }, { 'dev-timeout': { mode: 'notify' } })
const policy = {
  version: 1,
  mode: 'effective',
  defaults: defaults,
  global: globalView,
  project: projectView,
  overrides: { global: { 'dev-timeout': { timeoutSeconds: 400 } }, project: { 'dev-timeout': { mode: 'notify' } } },
  storage: { global: 'home', globalPath: '/home/.dsh/godot-bridge/decision-policy.json', projectPath: '/p/.agents/decision-policy.json' },
  guards: { deleteDependencyTreeRequiresWord: true, timeoutNeverDeletes: true },
  errors: [],
}
const dispatch = { maxConcurrent: 3, maxAttempts: 2, defaultTarget: '' }
let closed = 0
const props = { t: t, dispatch: dispatch, policy: policy, theme: 'dsh', onClose: () => { closed += 1 } }

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
  else walk(children, visit)
}

function find(root, predicate) {
  let found = null
  walk(root, (node) => {
    if (found === null && predicate(node)) found = node
  })
  return found
}

function rows(tree) {
  const byEvent = new Map()
  walk(tree, (node) => {
    const key = node.props && node.props['data-policy-event']
    if (typeof key !== 'string' || node.type !== 'tr') return
    byEvent.set(key, node)
  })
  return byEvent
}

function fieldOf(row, name) {
  return find(row, (node) => node.props && node.props['data-policy-field'] === name)
}

function applyButton(tree) {
  return find(tree, (node) => node.type === 'button' && node.props && node.props['data-variant'] === 'primary')
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

// ── the dispatch settings contract is unchanged ─────────────────────────────
const main = newForm()
let tree = main(props)
assert.equal(tree.type, Modal)
const text = JSON.stringify(tree)
assert.ok(text.includes('maxConcurrent'))
assert.ok(text.includes('defaultTargetLabel'))
assert.ok(text.includes('concurrencyHint'))
assert.ok(!text.includes('maxWorkAgents'))
assert.ok(!text.includes('max-work-agents'))
assert.ok(!text.includes('settingsWorkerGroup'))
assert.ok(!text.includes('settingsCapacity'))
assert.ok(!text.includes('allow-spawn'))

// ── the decision policy editor is present ──────────────────────────────────
assert.ok(text.includes('decisionSettingsTitle'), 'the aligned page title is rendered')
assert.ok(text.includes('decisionScopeGlobal') && text.includes('decisionScopeProject'), 'both scopes are offered')
assert.ok(text.includes('decisionModeLabel') && text.includes('decisionDefaultLabel'), 'the mode/default columns exist')
assert.ok(text.includes('decisionTimeoutLabel') && text.includes('decisionLimitLabel') && text.includes('decisionAutoRecoverLabel'), 'the numeric columns exist')
assert.ok(text.includes('decisionResetAll'), 'reset-all exists')

// The event catalog is the server's, in order, with the same option ids.
assert.ok(Array.isArray(main.decisionEvents), 'the component exposes its event catalog for the drift test')
assert.deepEqual(main.decisionEvents.map((entry) => entry.key), DECISION_EVENT_CATALOG.map((entry) => entry.key), 'the panel lists every catalog event in order')
for (const entry of DECISION_EVENT_CATALOG) {
  const view = main.decisionEvents.filter((candidate) => candidate.key === entry.key)[0]
  assert.deepEqual(view.options.map((option) => option.id), entry.options.map((option) => option.id), entry.key + ' keeps the server option ids')
  assert.ok(HEAD.includes('decisionEvent_' + entry.key.replace(/-/g, '_') + ':'), entry.key + ' has an i18n event label')
  for (const option of entry.options) {
    assert.ok(HEAD.includes('decisionOpt_' + entry.key.replace(/-/g, '_') + '_' + option.id.replace(/-/g, '_') + ':'), entry.key + '/' + option.id + ' has an i18n option label')
  }
}
const table = rows(tree)
assert.equal(table.size, DECISION_EVENT_CATALOG.length, 'one row per event')
assert.ok(table.has('dev-timeout') && table.has('delete') && table.has('review-rounds-exhausted'), 'the named events are rows')

// The fixed guards are shown, checked and disabled.
const guards = find(tree, (node) => node.props && node.props['data-policy-guards'] === 'true')
assert.ok(guards !== null && guards !== undefined, 'the fixed guards block is rendered')
const guardInputs = []
walk(guards, (node) => {
  if (node.type === 'input' && node.props && typeof node.props['data-policy-guard'] === 'string') guardInputs.push(node)
})
assert.deepEqual(guardInputs.map((node) => node.props['data-policy-guard']), ['delete-word', 'timeout-no-delete'])
for (const input of guardInputs) {
  assert.equal(input.props.checked, true, 'the guard is checked')
  assert.equal(input.props.disabled, true, 'the guard cannot be turned off')
}

// The delete row's mode is fixed to ask (the server would force it anyway).
const deleteMode = fieldOf(table.get('delete'), 'mode')
assert.equal(deleteMode.props.value, 'ask')
assert.equal(deleteMode.props.disabled, true, 'the delete mode cannot be switched away from ask')

// ── the values are the scope's resolved policy ─────────────────────────────
assert.equal(fieldOf(table.get('dev-timeout'), 'timeout').props.value, '400', 'the project scope shows the effective timeout')
assert.equal(fieldOf(table.get('dev-timeout'), 'mode').props.value, 'notify', 'the project override mode is shown')
assert.equal(fieldOf(table.get('create'), 'mode').props.value, 'ask', 'an unconfigured event shows the built-in mode')
// A notify event has no deadline (packet §5 "—"): the field is EMPTY, never a fake 120.
assert.equal(fieldOf(table.get('worker-lost'), 'timeout').props.value, '', 'a notify event shows the built-in fallback as empty')

// ── applying with no policy edit sends only the dispatch settings ──────────
{
  posts.length = 0
  applyButton(tree).props.onClick()
  await flush()
  assert.equal(posts.length, 1, 'an untouched policy is not posted')
  assert.equal(posts[0].action, 'settings')
  assert.equal(posts[0].body.maxConcurrent, 3)
  assert.equal(posts[0].body.maxAttempts, 2)
  assert.equal(posts[0].body.defaultTarget, '')
  assert.equal(Object.hasOwn(posts[0].body, 'maxWorkAgents'), false)
  assert.equal(Object.hasOwn(posts[0].body, 'allowSpawn'), false)
}

// ── editing a field is sent as the decisionPolicy patch ────────────────────
{
  const form = newForm()
  let view = form(props)
  fieldOf(rows(view).get('reopen'), 'mode').props.onChange({ target: { value: 'silent' } })
  // 0 is a real answer deadline (no deadline at all): it is sent as 0, not null.
  fieldOf(rows(view).get('worker-lost'), 'timeout').props.onChange({ target: { value: '0' } })
  view = form(props)
  assert.equal(fieldOf(rows(view).get('reopen'), 'mode').props.value, 'silent', 'the edit survives a re-render')
  assert.equal(fieldOf(rows(view).get('worker-lost'), 'timeout').props.value, '0', 'an explicit 0 stays distinguishable from the empty fallback')
  posts.length = 0
  closed = 0
  applyButton(view).props.onClick()
  await flush()
  assert.equal(posts.length, 2, 'apply saves the dispatch settings and then the policy')
  assert.equal(posts[0].action, 'settings')
  assert.equal(posts[1].action, 'decisionPolicy')
  assert.equal(posts[1].body.scope, 'project')
  assert.deepEqual(posts[1].body.events, { reopen: { mode: 'silent' }, 'worker-lost': { timeoutSeconds: 0 } })
  assert.deepEqual(posts[1].body.reset, [])
  assert.equal(closed, 1, 'the modal closes once the policy is saved')
}

// ── reset clears the override in the current scope ────────────────────────
{
  const form = newForm()
  let view = form(props)
  const resetButton = find(rows(view).get('dev-timeout'), (node) => node.type === 'button' && node.props && node.props['data-policy-reset'] === 'dev-timeout')
  assert.ok(resetButton !== null && resetButton !== undefined, 'the row has a reset button')
  assert.equal(resetButton.props.disabled, false, 'a stored override can be reset')
  resetButton.props.onClick()
  view = form(props)
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'timeout').props.value, '400', 'resetting shows what the scope inherits (global 400s)')
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'mode').props.value, 'ask', 'the project mode inherits the global/built-in ask')
  posts.length = 0
  applyButton(view).props.onClick()
  await flush()
  assert.equal(posts.length, 2)
  assert.equal(posts[1].action, 'decisionPolicy')
  assert.deepEqual(posts[1].body.reset, ['dev-timeout'])
  assert.deepEqual(posts[1].body.events, {}, 'a pure reset sends no patch')
}

// ── the global scope shows the global default ─────────────────────────────
{
  const form = newForm()
  let view = form(props)
  const globalTab = find(view, (node) => node.props && node.props['data-policy-scope'] === 'global')
  assert.ok(globalTab !== null && globalTab !== undefined)
  globalTab.props.onClick()
  view = form(props)
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'timeout').props.value, '400', 'the global scope shows the global override')
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'mode').props.value, 'ask', 'the global scope does not see the project override')
  const projectTab = find(view, (node) => node.props && node.props['data-policy-scope'] === 'project')
  projectTab.props.onClick()
  view = form(props)
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'mode').props.value, 'notify', 'switching back restores the project scope')
}

// ── a validation refusal is shown, not swallowed ──────────────────────────
{
  const form = newForm(async (action) => ({ ok: action === 'settings', payload: { ok: false, code: 'invalid-policy-option' } }))
  let view = form(props)
  fieldOf(rows(view).get('create'), 'mode').props.onChange({ target: { value: 'notify' } })
  view = form(props)
  applyButton(view).props.onClick()
  await flush()
  view = form(props)
  const shown = find(view, (node) => node.type === 'p' && typeof node.props.children === 'string' && node.props.children.indexOf('err_invalid_policy_option') >= 0)
  assert.ok(shown !== null && shown !== undefined, 'the refusal code is localized into the form')
}

console.log('PASS  SettingsForm edits the decision policy per scope and keeps the high-risk guards fixed')
