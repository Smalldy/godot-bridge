// SettingsForm: the sectioned settings-page body (dispatch, retry, decision
// policy and the engine path). T-205 moved the form out of the modal: the page
// owns the title/nav/footer, the form owns the fields, the drafts, the save
// action and the engine config scope.
//
// The tests drive the component with a stub React (no DOM): the module keeps its
// policy drafts in the factory closure and the page footer drives
// SettingsForm.actions.save, so a manual re-render after an onChange behaves
// like a real render. Each block uses its own factory so one block's unsaved
// edit cannot leak into the next.

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

// Every harness is one form INSTANCE for React.useId(): a new harness means a
// new mounted page, and its drafts must not be shared with a previous one.
let harnessSeq = 0

/** The smallest hook harness that survives manual re-renders (useState only). */
function createHarness() {
  const states = []
  const harness = {
    id: 'form-instance-' + String(++harnessSeq),
    cursor: 0,
    React: {
      useId: function () {
        return harness.id
      },
      useEffect: function () {},
      useRef: function () {
        return { current: null }
      },
      useState: function (initial) {
        const index = harness.cursor++
        if (index >= states.length) states.push(typeof initial === 'function' ? initial() : initial)
        return [
          states[index],
          function (next) {
            states[index] = typeof next === 'function' ? next(states[index]) : next
          },
        ]
      },
      useMemo: function (factory) {
        return factory()
      },
      useSyncExternalStore: function (subscribe, read) {
        return read()
      },
    },
  }
  return harness
}

const posts = []
let sendOverride = null
function createStore() {
  return {
    send: async (action, body) => {
      if (typeof sendOverride === 'function') return sendOverride(action, body)
      posts.push({ action: action, body: body })
      return { ok: true, payload: { ok: true } }
    },
  }
}

function newForm(harness) {
  const stub = harness === undefined ? createHarness() : harness
  return {
    harness: stub,
    form: createSettingsForm({ React: stub.React, h: h, store: createStore() }),
  }
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
const engineScope = {
  calls: [],
  snapshot: { status: 'ready', revision: 1, value: { godotPath: 'C:\\Godot\\godot.exe' }, user: { godotPath: 'C:\\Godot\\godot.exe' }, writable: true },
  getSnapshot: function () {
    return engineScope.snapshot
  },
  subscribe: function () {
    return function () {}
  },
  set: function (field, value) {
    engineScope.calls.push(['set', field, value])
    return Promise.resolve(true)
  },
  unset: function (field) {
    engineScope.calls.push(['unset', field])
    return Promise.resolve(true)
  },
}

function propsFor(extra) {
  return Object.assign({ t: t, dispatch: dispatch, policy: policy, theme: 'dsh', section: 'general', engineScope: engineScope, onThemeChange: function () {} }, extra === undefined ? {} : extra)
}

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

function findAll(root, predicate) {
  const found = []
  walk(root, (node) => {
    if (predicate(node)) found.push(node)
  })
  return found
}

function sectionOf(tree, key) {
  return find(tree, (node) => node.props && node.props['data-settings-section'] === key)
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

function fieldByData(tree, name) {
  return find(tree, (node) => node.props && node.props['data-field'] === name)
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

// ── the modal shell is gone; all five themes are sections ──────────────────
const main = newForm()
let tree = main.form(propsFor())
assert.equal(tree.type, 'div')
const treeJson = JSON.stringify(tree)
assert.ok(!treeJson.includes('gbt-overlay'), 'the form no longer draws a modal overlay')
assert.ok(!treeJson.includes('gbt-modal'), 'the form no longer draws the modal shell')
assert.ok(treeJson.includes('"data-settings-sections":"true"'))
for (const key of ['general', 'dispatch', 'retry', 'decisions', 'engine']) {
  assert.ok(sectionOf(tree, key) !== null && sectionOf(tree, key) !== undefined, key + ' has a section')
}
// Only the selected theme is visible; the others stay mounted (drafts survive).
for (const [key, section] of [['general', sectionOf(tree, 'general')], ['dispatch', sectionOf(tree, 'dispatch')], ['retry', sectionOf(tree, 'retry')], ['decisions', sectionOf(tree, 'decisions')], ['engine', sectionOf(tree, 'engine')]]) {
  if (key === 'general') assert.notEqual(section.props.hidden, true, 'the selected theme is visible')
  else assert.equal(section.props.hidden, true, key + ' is hidden while general is selected')
}
tree = main.form(propsFor({ section: 'decisions' }))
assert.equal(sectionOf(tree, 'decisions').props.hidden, undefined, 'the selected theme is shown')
assert.equal(sectionOf(tree, 'general').props.hidden, true, 'the previous theme is hidden')
console.log('PASS  the settings body renders one section per theme, hidden not unmounted')

// ── every old control is still there ──────────────────────────────────────
const text = JSON.stringify(tree)
assert.ok(text.includes('maxConcurrent'))
assert.ok(text.includes('defaultTargetLabel'))
assert.ok(text.includes('concurrencyHint'))
assert.ok(text.includes('settingsThemeGroup'))
assert.ok(text.includes('settingsRetryGroup'))
assert.ok(!text.includes('maxWorkAgents'))
assert.ok(!text.includes('max-work-agents'))
assert.ok(!text.includes('settingsWorkerGroup'))
assert.ok(!text.includes('settingsCapacity'))
assert.ok(!text.includes('allow-spawn'))
console.log('PASS  dispatch/retry/theme controls kept, no worker-pool fields')

// ── the decision policy editor is present ──────────────────────────────────
assert.ok(text.includes('decisionSettingsTitle'), 'the aligned page title is rendered')
assert.ok(text.includes('decisionScopeGlobal') && text.includes('decisionScopeProject'), 'both scopes are offered')
assert.ok(text.includes('decisionModeLabel') && text.includes('decisionDefaultLabel'), 'the mode/default columns exist')
assert.ok(text.includes('decisionTimeoutLabel') && text.includes('decisionLimitLabel') && text.includes('decisionAutoRecoverLabel'), 'the numeric columns exist')
assert.ok(text.includes('decisionResetAll'), 'reset-all exists')

// The event catalog is the server's, in order, with the same option ids.
assert.ok(Array.isArray(main.form.decisionEvents), 'the component exposes its event catalog for the drift test')
assert.deepEqual(main.form.decisionEvents.map((entry) => entry.key), DECISION_EVENT_CATALOG.map((entry) => entry.key), 'the panel lists every catalog event in order')
for (const entry of DECISION_EVENT_CATALOG) {
  const view = main.form.decisionEvents.filter((candidate) => candidate.key === entry.key)[0]
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
console.log('PASS  decision policy table, scopes and fixed guards are intact')

// ── the values are the scope's resolved policy ─────────────────────────────
assert.equal(fieldOf(table.get('dev-timeout'), 'timeout').props.value, '400', 'the project scope shows the effective timeout')
assert.equal(fieldOf(table.get('dev-timeout'), 'mode').props.value, 'notify', 'the project override mode is shown')
assert.equal(fieldOf(table.get('create'), 'mode').props.value, 'ask', 'an unconfigured event shows the built-in mode')
// A notify event has no deadline (packet §5 "—"): the field is EMPTY, never a fake 120.
assert.equal(fieldOf(table.get('worker-lost'), 'timeout').props.value, '', 'a notify event shows the built-in fallback as empty')
console.log('PASS  the fields show the resolved policy per scope')

// ── saving with no policy edit sends only the dispatch settings ────────────
{
  posts.length = 0
  const pending = main.form.actions.save()
  const outcome = await pending
  assert.equal(outcome.ok, true)
  assert.equal(posts.length, 1, 'an untouched policy is not posted')
  assert.equal(posts[0].action, 'settings')
  assert.equal(posts[0].body.maxConcurrent, 3)
  assert.equal(posts[0].body.maxAttempts, 2)
  assert.equal(posts[0].body.defaultTarget, '')
  assert.equal(Object.hasOwn(posts[0].body, 'maxWorkAgents'), false)
  assert.equal(Object.hasOwn(posts[0].body, 'allowSpawn'), false)
}
console.log('PASS  save sends the dispatch settings (and nothing else)')

// ── the DOM refs are what is written (the page's inputs) ──────────────────
{
  const block = newForm()
  let view = block.form(propsFor({ section: 'dispatch' }))
  const concurrentInput = fieldByData(view, 'max-concurrent')
  const targetInput = fieldByData(view, 'default-target')
  assert.ok(concurrentInput !== null && targetInput !== null, 'the dispatch inputs exist')
  concurrentInput.props.ref.current = { value: '5' }
  targetInput.props.ref.current = { value: ' origin/main ' }
  posts.length = 0
  await block.form.actions.save()
  assert.equal(posts[0].body.maxConcurrent, 5, 'the typed concurrency is saved')
  assert.equal(posts[0].body.defaultTarget, 'origin/main', 'the typed default target is trimmed and saved')
}
console.log('PASS  the inputs the user sees are the values that are written')

// ── editing a field is sent as the decisionPolicy patch ────────────────────
{
  const block = newForm()
  let view = block.form(propsFor({ section: 'decisions' }))
  fieldOf(rows(view).get('reopen'), 'mode').props.onChange({ target: { value: 'silent' } })
  // 0 is a real answer deadline (no deadline at all): it is sent as 0, not null.
  fieldOf(rows(view).get('worker-lost'), 'timeout').props.onChange({ target: { value: '0' } })
  view = block.form(propsFor({ section: 'decisions' }))
  assert.equal(fieldOf(rows(view).get('reopen'), 'mode').props.value, 'silent', 'the edit survives a re-render')
  assert.equal(fieldOf(rows(view).get('worker-lost'), 'timeout').props.value, '0', 'an explicit 0 stays distinguishable from the empty fallback')
  posts.length = 0
  const outcome = await block.form.actions.save()
  assert.equal(outcome.ok, true)
  assert.equal(posts.length, 2, 'save saves the dispatch settings and then the policy')
  assert.equal(posts[0].action, 'settings')
  assert.equal(posts[1].action, 'decisionPolicy')
  assert.equal(posts[1].body.scope, 'project')
  assert.deepEqual(posts[1].body.events, { reopen: { mode: 'silent' }, 'worker-lost': { timeoutSeconds: 0 } })
  assert.deepEqual(posts[1].body.reset, [])
}
console.log('PASS  a policy edit is saved as a sparse decisionPolicy patch, page stays open')

// ── reset clears the override in the current scope ────────────────────────
{
  const block = newForm()
  let view = block.form(propsFor({ section: 'decisions' }))
  const resetButton = find(rows(view).get('dev-timeout'), (node) => node.type === 'button' && node.props && node.props['data-policy-reset'] === 'dev-timeout')
  assert.ok(resetButton !== null && resetButton !== undefined, 'the row has a reset button')
  assert.equal(resetButton.props.disabled, false, 'a stored override can be reset')
  resetButton.props.onClick()
  view = block.form(propsFor({ section: 'decisions' }))
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'timeout').props.value, '400', 'resetting shows what the scope inherits (global 400s)')
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'mode').props.value, 'ask', 'the project mode inherits the global/built-in ask')
  posts.length = 0
  await block.form.actions.save()
  assert.equal(posts.length, 2)
  assert.equal(posts[1].action, 'decisionPolicy')
  assert.deepEqual(posts[1].body.reset, ['dev-timeout'])
  assert.deepEqual(posts[1].body.events, {}, 'a pure reset sends no patch')
}
console.log('PASS  reset clears the override and sends reset without a patch')

// ── the global scope shows the global default ─────────────────────────────
{
  const block = newForm()
  let view = block.form(propsFor({ section: 'decisions' }))
  const globalTab = find(view, (node) => node.props && node.props['data-policy-scope'] === 'global')
  assert.ok(globalTab !== null && globalTab !== undefined)
  globalTab.props.onClick()
  view = block.form(propsFor({ section: 'decisions' }))
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'timeout').props.value, '400', 'the global scope shows the global override')
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'mode').props.value, 'ask', 'the global scope does not see the project override')
  const projectTab = find(view, (node) => node.props && node.props['data-policy-scope'] === 'project')
  projectTab.props.onClick()
  view = block.form(propsFor({ section: 'decisions' }))
  assert.equal(fieldOf(rows(view).get('dev-timeout'), 'mode').props.value, 'notify', 'switching back restores the project scope')
}
console.log('PASS  the decision scope tabs switch the resolved rows')

// ── a validation refusal is returned, not swallowed ───────────────────────
{
  sendOverride = async (action) => ({ ok: action === 'settings', payload: { ok: false, code: 'invalid-policy-option' } })
  const block = newForm()
  let view = block.form(propsFor({ section: 'decisions' }))
  fieldOf(rows(view).get('create'), 'mode').props.onChange({ target: { value: 'notify' } })
  view = block.form(propsFor({ section: 'decisions' }))
  const outcome = await block.form.actions.save()
  sendOverride = null
  assert.equal(outcome.ok, false, 'the refusal is reported to the page')
  assert.ok(outcome.error.indexOf('err_invalid_policy_option') >= 0, 'the refusal code is localized: ' + outcome.error)
}
console.log('PASS  a refused decision policy is surfaced to the page footer')

// ── a project theme is disabled while nothing is bound ────────────────────
{
  posts.length = 0
  const block = newForm()
  const view = block.form(propsFor({ section: 'dispatch', unbound: true }))
  const concurrentInput = fieldByData(view, 'max-concurrent')
  const targetInput = fieldByData(view, 'default-target')
  assert.equal(concurrentInput.props.disabled, true, 'concurrency is disabled without a project')
  assert.equal(targetInput.props.disabled, true, 'default target is disabled without a project')
  const decisionRow = rows(view).get('delete')
  assert.equal(fieldOf(decisionRow, 'mode').props.disabled, true)
  const outcome = await block.form.actions.save()
  assert.equal(outcome.ok, false, 'a project save cannot succeed unbound')
  assert.equal(posts.length, 0, 'nothing was written')
  const themeView = block.form(propsFor({ unbound: true }))
  assert.equal(fieldByData(themeView, 'ui-theme').props.disabled, undefined, 'the browser theme stays editable without a project')
}
console.log('PASS  project-level controls are disabled while nothing is bound')

// ── the engine path still reads and writes the config scope ───────────────
// The engine section is a child component (like in the browser); the stub
// harness has to invoke it so its own hooks are exercised.
function engineElementOf(view) {
  return find(view, (node) => typeof node.type === 'function')
}
{
  const block = newForm()
  const view = block.form(propsFor({ section: 'engine' }))
  const engineElement = engineElementOf(view)
  assert.ok(engineElement !== null && engineElement !== undefined, 'the engine section component is mounted')
  const formStateCount = block.harness.cursor
  block.harness.cursor = formStateCount
  let engineView = engineElement.type(engineElement.props)
  assert.ok(JSON.stringify(engineView).includes('settingsEngineLabel'), 'the engine section is rendered')
  const input = find(engineView, (node) => node.props && node.props['data-settings-engine-input'] === 'true')
  assert.ok(input !== null && input !== undefined, 'the engine path input exists')
  assert.equal(input.props.defaultValue, 'C:\\Godot\\godot.exe', 'the stored value is shown')
  const saveButton = find(engineView, (node) => node.props && node.props['data-settings-engine-save'] === 'true')
  assert.equal(saveButton.props.disabled, true, 'an untouched path is not saved')
  input.props.onInput({})
  block.harness.cursor = formStateCount
  engineView = engineElement.type(engineElement.props)
  const enabled = find(engineView, (node) => node.props && node.props['data-settings-engine-save'] === 'true')
  assert.equal(enabled.props.disabled, false, 'editing enables the engine save')
  // The re-render mounts a fresh (uncontrolled) input: the browser would carry
  // the typed text over, so the test writes it into the current ref.
  const currentInput = find(engineView, (node) => node.props && node.props['data-settings-engine-input'] === 'true')
  currentInput.props.ref.current = { value: 'D:\\Godot\\godot.exe' }
  enabled.props.onClick()
  await flush()
  assert.deepEqual(engineScope.calls[engineScope.calls.length - 1], ['set', 'godotPath', 'D:\\Godot\\godot.exe'], 'the config scope is written')
}
console.log('PASS  the engine path section reads and writes the config scope')

// ── the engine section is honest when the runtime has no config form ──────
{
  const block = newForm()
  const view = block.form(propsFor({ section: 'engine', engineScope: null }))
  const engineElement = engineElementOf(view)
  const engineView = engineElement.type(engineElement.props)
  const unavailable = find(engineView, (node) => node.props && node.props['data-settings-engine'] === 'unavailable')
  assert.ok(unavailable !== null && unavailable !== undefined, 'a missing config service says so')
  assert.ok(JSON.stringify(engineView).includes('settingsEngineUnavailable'))
}
console.log('PASS  the engine section explains a runtime without a config form')

// ── two mounted pages cannot share drafts or DOM ids ──────────────────────
{
  const first = newForm()
  const second = newForm()
  let firstView = first.form(propsFor({ section: 'decisions' }))
  fieldOf(rows(firstView).get('reopen'), 'mode').props.onChange({ target: { value: 'silent' } })
  firstView = first.form(propsFor({ section: 'decisions' }))
  assert.equal(fieldOf(rows(firstView).get('reopen'), 'mode').props.value, 'silent', 'the first page keeps its own draft')
  const secondView = second.form(propsFor({ section: 'decisions' }))
  assert.equal(fieldOf(rows(secondView).get('reopen'), 'mode').props.value, 'ask', 'a second page does not inherit the first page draft')

  function engineInputOf(block) {
    const view = block.form(propsFor({ section: 'engine' }))
    const element = find(view, (node) => typeof node.type === 'function')
    block.harness.cursor = block.harness.cursor
    const engineView = element.type(element.props)
    const input = find(engineView, (node) => node.props && node.props['data-settings-engine-input'] === 'true')
    const label = find(engineView, (node) => node.type === 'label' && node.props && typeof node.props.htmlFor === 'string')
    return { input: input, label: label }
  }
  const firstInput = engineInputOf(first).input
  const secondInput = engineInputOf(second).input
  assert.ok(typeof firstInput.props.id === 'string' && firstInput.props.id.length > 0, 'the engine input has an id')
  assert.notEqual(firstInput.props.id, secondInput.props.id, 'two mounted forms cannot duplicate the engine input id')
  const labelled = engineInputOf(first)
  assert.equal(labelled.label.props.htmlFor, labelled.input.props.id, 'the label points at this instance\'s input')
}
console.log('PASS  two mounted settings pages keep separate drafts and engine input ids')

// ── theme switching is handed to the owner immediately ────────────────────
{
  const seen = []
  const block = newForm()
  const view = block.form(propsFor({ onThemeChange: (next) => seen.push(next) }))
  const themeSelect = fieldByData(view, 'ui-theme')
  assert.ok(themeSelect !== null && themeSelect !== undefined, 'the theme select exists')
  assert.equal(themeSelect.props.value, 'dsh')
  themeSelect.props.onChange({ target: { value: 'console' } })
  assert.deepEqual(seen, ['console'], 'the theme change is applied at once, not on save')
}
console.log('PASS  the theme select applies immediately through its owner')

// ── the new page copy exists in both locales ──────────────────────────────
for (const key of ['settingsPageTitle', 'settingsNavGeneral', 'settingsNavDispatch', 'settingsNavRetry', 'settingsNavDecisions', 'settingsNavEngine', 'settingsUnbound', 'settingsUnboundHint', 'settingsSaved', 'settingsEngineLabel', 'settingsEngineHint', 'settingsEngineReset']) {
  const matches = [...HEAD.matchAll(new RegExp('^\\s*' + key + ':', 'gm'))]
  assert.equal(matches.length, 2, key + ' is present in both locales')
}
console.log('PASS  the settings page copy exists in zh and en')

console.log('PASS  SettingsForm is the sectioned page body; the page owns the chrome')
