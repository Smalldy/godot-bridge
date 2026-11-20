// SettingsPage: the settings entry as a PAGE (T-205).
//
// The page owns the title, the fixed left theme rail, the independently
// scrolling right column and the save/cancel footer. The task center panel and
// the plugin bundle card mount the SAME component; these tests drive it with a
// stub React and a stub form so the chrome, the theme switching and the
// unbound state are observable without a DOM.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSettingsViews } = require('../../client/src/views/settings-page.cjs')

const HEAD = readFileSync(new URL('../../client/src/00-head.part', import.meta.url), 'utf8')

const t = (key) => key
function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}

function createHarness() {
  const states = []
  const harness = {
    cursor: 0,
    effects: 0,
    React: {
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
      useEffect: function (effect) {
        harness.effects += 1
        effect()
      },
      useReducer: function (reducer, initial) {
        return [initial, function () {}]
      },
      useSyncExternalStore: function (subscribe, read) {
        return read()
      },
    },
  }
  return harness
}

function render(harness, component, props) {
  harness.cursor = 0
  return component(props)
}

/** Render the page and the child form React would render for it. */
function renderPage(harness, component, props) {
  const tree = render(harness, component, props)
  const form = find(tree, (node) => node.type === SettingsForm)
  if (form !== null && form !== undefined) form.type(form.props)
  return tree
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

const posts = []
const store = {
  send: async (action, body) => {
    posts.push({ action: action, body: body })
    return { ok: true, payload: { ok: true } }
  },
}

const dispatch = { state: 'paused', maxConcurrent: 3, maxAttempts: 2, defaultTarget: '' }
const policy = { version: 1, mode: 'effective', defaults: {}, global: {}, project: {}, overrides: { global: {}, project: {} }, storage: null, guards: {}, errors: [] }
const boundSnapshot = { project: '/repo', dispatch: dispatch, decisionPolicy: policy }
const scope = {
  snapshot: { status: 'ready', revision: 1, value: { godotPath: 'C:\\Godot\\godot.exe' }, user: {}, writable: true },
  getSnapshot: function () {
    return scope.snapshot
  },
  subscribe: function () {
    return function () {}
  },
  set: function () {
    return Promise.resolve(true)
  },
  unset: function () {
    return Promise.resolve(true)
  },
}

let saveOutcome = { ok: true }
let saveCalls = 0
let closed = 0
const themeCalls = []
// The real form publishes its save into the page-owned actions object on every
// render; the stub does the same so the footer wiring is exercised for real.
function stubSave() {
  saveCalls += 1
  return Promise.resolve(saveOutcome)
}
function onThemeChange(next) {
  themeCalls.push(next)
}
function onClose() {
  closed += 1
}
const SettingsForm = (props) => {
  props.actions.save = stubSave
  return { type: 'settings-form-stub', props: props }
}

const harness = createHarness()
const views = createSettingsViews({ React: harness.React, h: h, SettingsForm: SettingsForm })
const SettingsPage = views.SettingsPage

function pageProps(extra) {
  return Object.assign(
    {
      t: t,
      mode: 'panel',
      snapshot: boundSnapshot,
      store: store,
      theme: 'dsh',
      onThemeChange: onThemeChange,
      onClose: onClose,
      engineScope: scope,
    },
    extra === undefined ? {} : extra,
  )
}

// ── the entry is a page, never a modal ─────────────────────────────────────
let tree = renderPage(harness, SettingsPage, pageProps())
assert.equal(tree.type, 'div')
assert.equal(tree.props['data-settings-page'], 'true')
assert.equal(tree.props['data-settings-mode'], 'panel')
const pageJson = JSON.stringify(tree)
assert.ok(!pageJson.includes('gbt-overlay'), 'the settings page must not draw a modal overlay')
assert.ok(!pageJson.includes('gbt-modal'), 'the settings page must not draw the modal shell')
assert.equal(tree.props['data-settings-bound'], 'true')
console.log('PASS  the settings entry renders a page, not a modal')

// ── page title + project scope line ───────────────────────────────────────
const title = find(tree, (node) => node.props && node.props['data-settings-title'] === 'true')
assert.ok(title !== null && title !== undefined, 'the page has a title')
assert.equal(title.type, 'h1')
assert.equal(title.props.children, 'settingsPageTitle')
assert.ok(HEAD.includes("settingsPageTitle: '设置'"), 'the zh page title is 设置')
assert.ok(HEAD.includes("settingsPageTitle: 'Settings'"), 'the en page title is Settings')
assert.ok(pageJson.includes('/repo'), 'a bound page names its project')
assert.ok(pageJson.includes('settingsProjectScope'))
assert.ok(pageJson.includes('data-action'), 'an in-panel page offers a back/cancel control')
console.log('PASS  page title 设置 + the current project scope line')

// ── the fixed left theme rail ─────────────────────────────────────────────
const navItems = findAll(tree, (node) => node.type === 'button' && node.props && typeof node.props['data-settings-nav'] === 'string')
assert.deepEqual(navItems.map((node) => node.props['data-settings-nav']), ['general', 'dispatch', 'retry', 'decisions', 'engine'], 'the rail lists the five themes in order')
assert.deepEqual(navItems.map((node) => node.props.children), ['settingsNavGeneral', 'settingsNavDispatch', 'settingsNavRetry', 'settingsNavDecisions', 'settingsNavEngine'])
const nav = find(tree, (node) => node.props && node.props['data-settings-nav'] === 'true')
assert.ok(nav !== null && nav !== undefined, 'the nav landmark exists')
assert.equal(nav.type, 'nav')
assert.equal(nav.props['aria-label'], 'settingsNavLabel')
assert.equal(navItems[0].props['data-active'], 'true', 'general is selected first')
assert.equal(navItems[0].props['aria-current'], 'page')
assert.equal(navItems[3].props['data-active'], 'false')
// The rail is fixed width 200px and the right column scrolls on its own.
assert.ok(HEAD.includes('.gbt-settingsnav{display:flex;flex-direction:column;gap:2px;flex:0 0 200px;width:200px'), 'the rail is a 200px fixed column')
const scroll = find(tree, (node) => node.props && node.props['data-settings-scroll'] === 'true')
assert.ok(scroll !== null && scroll !== undefined, 'the right content has its own scroll container')
assert.equal(scroll.props.className, 'gbt-settingsscroll')
assert.ok(HEAD.includes('.gbt-settingsscroll{flex:1;min-height:0;overflow:auto'), 'the right column scrolls independently')
assert.ok(HEAD.includes('.gbt-settingssections{display:flex;flex-direction:column;gap:14px;width:100%;max-width:880px'), 'the right content is capped near 880px')
console.log('PASS  left theme rail (200px) + right scroll container (max 880px)')

// ── the shared form receives the selected theme ───────────────────────────
let form = find(tree, (node) => node.type === SettingsForm)
assert.ok(form !== null && form !== undefined, 'the page mounts the settings form')
assert.equal(form.props.section, 'general')
assert.equal(form.props.unbound, false)
assert.equal(form.props.engineScope, scope, 'the engine path keeps the config scope')
assert.equal(form.props.dispatch, dispatch)
assert.equal(form.props.policy, policy)
assert.equal(form.props.onThemeChange, onThemeChange, 'theme changes reach the page owner')
// Switching a theme only changes which form section is shown.
const decisionsNav = navItems[3]
decisionsNav.props.onClick()
let switched = renderPage(harness, SettingsPage, pageProps())
assert.equal(switched.props['data-settings-active'], 'decisions')
const switchedNav = findAll(switched, (node) => node.type === 'button' && node.props && typeof node.props['data-settings-nav'] === 'string')
assert.equal(switchedNav[3].props['data-active'], 'true', 'the clicked theme is active')
assert.equal(switchedNav[3].props['aria-current'], 'page')
assert.equal(switchedNav[0].props['data-active'], 'false')
form = find(switched, (node) => node.type === SettingsForm)
assert.equal(form.props.section, 'decisions', 'the form is told which theme to show')
console.log('PASS  the rail switches the form theme without remounting the page')

// ── the footer holds save and cancel ──────────────────────────────────────
const footer = find(switched, (node) => node.props && node.props['data-settings-footer'] === 'true')
assert.ok(footer !== null && footer !== undefined, 'the page has a footer')
assert.equal(footer.type, 'footer')
const saveButton = find(switched, (node) => node.props && node.props['data-settings-save'] === 'true')
const cancelButton = find(switched, (node) => node.props && node.props['data-settings-cancel'] === 'true')
assert.ok(saveButton !== null && saveButton !== undefined, 'save lives in the page footer')
assert.ok(cancelButton !== null && cancelButton !== undefined, 'cancel lives in the page footer')
assert.equal(saveButton.props.children, 'apply', 'the existing save copy is kept')
assert.equal(cancelButton.props.children, 'cancel')
// A successful save stays on the page and reports it.
saveOutcome = { ok: true }
saveCalls = 0
saveButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(saveCalls, 1, 'the footer drives the form save')
let afterSave = renderPage(harness, SettingsPage, pageProps())
const status = find(afterSave, (node) => node.props && typeof node.props['data-settings-status'] === 'string')
assert.ok(status !== null && status !== undefined)
assert.equal(status.props['data-settings-status'], 'saved', 'a successful save says so')
assert.equal(status.props.children, 'settingsSaved')
assert.equal(closed, 0, 'saving does not close the page')
// Cancel returns to whoever opened the page.
cancelButton.props.onClick()
assert.equal(closed, 1, 'cancel closes the page')
// A failed save shows the localized reason in the footer.
saveOutcome = { ok: false, error: 'ERR:invalid_concurrency' }
saveCalls = 0
saveButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(saveCalls, 1)
afterSave = renderPage(harness, SettingsPage, pageProps())
const failed = find(afterSave, (node) => node.props && node.props['data-settings-status'] === 'error')
assert.ok(failed !== null && failed !== undefined, 'a refused save is shown')
assert.equal(failed.props.children, 'ERR:invalid_concurrency')
console.log('PASS  save/cancel live in the footer; save reports, cancel leaves')

// ── an unbound session disables the project themes, never a last project ──
{
  // A fresh page instance: the previously selected theme is not carried over.
  const unboundHarness = createHarness()
  const unboundViews = createSettingsViews({ React: unboundHarness.React, h: h, SettingsForm: SettingsForm })
  const unboundSnapshot = { project: null, lastProject: '/repo-last-active', dispatch: dispatch, decisionPolicy: null }
  const unbound = renderPage(unboundHarness, unboundViews.SettingsPage, pageProps({ snapshot: unboundSnapshot }))
  const unboundJson = JSON.stringify(unbound)
  assert.equal(unbound.props['data-settings-bound'], 'false')
  assert.ok(!unboundJson.includes('/repo-last-active'), 'the page never falls back to a last-active project')
  const banner = find(unbound, (node) => node.props && node.props['data-settings-unbound'] === 'true')
  assert.ok(banner !== null && banner !== undefined, 'the unbound state is shown')
  assert.ok(unboundJson.includes('settingsUnboundHint'))
  const unboundNav = findAll(unbound, (node) => node.type === 'button' && node.props && typeof node.props['data-settings-nav'] === 'string')
  assert.equal(unboundNav[0].props.disabled, false, 'the browser theme stays available')
  assert.equal(unboundNav[4].props.disabled, false, 'the engine path stays available')
  for (const index of [1, 2, 3]) assert.equal(unboundNav[index].props.disabled, true, 'a project theme is disabled without a project')
  const unboundSave = find(unbound, (node) => node.props && node.props['data-settings-save'] === 'true')
  assert.equal(unboundSave.props.disabled, true, 'a project save is disabled without a project')
  // Clicking a disabled project theme must not select it.
  unboundNav[3].props.onClick()
  const stillGeneral = renderPage(unboundHarness, unboundViews.SettingsPage, pageProps({ snapshot: unboundSnapshot }))
  assert.equal(stillGeneral.props['data-settings-active'], 'general')
  // The engine section still receives the config scope.
  const unboundForm = find(stillGeneral, (node) => node.type === SettingsForm)
  assert.equal(unboundForm.props.unbound, true)
  assert.equal(unboundForm.props.engineScope, scope, 'the engine path is still writable unbound')
  saveCalls = 0
  unboundSave.props.onClick()
  assert.equal(saveCalls, 0, 'an unbound save never reaches the host')
  const unboundStatus = renderPage(unboundHarness, unboundViews.SettingsPage, pageProps({ snapshot: unboundSnapshot }))
  const refusal = find(unboundStatus, (node) => node.props && node.props['data-settings-status'] === 'error')
  assert.ok(refusal !== null && refusal !== undefined, 'the refusal is explained')
  assert.equal(refusal.props.children, 'settingsUnboundHint')
}
console.log('PASS  unbound: banner, disabled project themes/save, no last-active fallback')

// ── the plugin bundle card mounts the SAME page (card mode) ───────────────
{
  let loads = 0
  const cardSnapshot = { project: '/repo', dispatch: dispatch, decisionPolicy: policy }
  const cardStore = {
    getSnapshot: function () {
      return cardSnapshot
    },
    subscribe: function () {
      return function () {}
    },
    load: async function () {
      loads += 1
    },
  }
  const locale = {
    subscribe: function () {
      return function () {}
    },
    bind: function (ns) {
      return function (key) {
        return ns + ':' + key
      }
    },
  }
  const cardHarness = createHarness()
  const cardViews = createSettingsViews({ React: cardHarness.React, h: h, SettingsForm: SettingsForm })
  const SettingsCard = cardViews.createSettingsCard({ store: cardStore, engineScope: scope, locale: locale, ns: 'tc' })
  const card = SettingsCard({})
  assert.equal(card.type, cardViews.SettingsPage, 'the card renders the same page component')
  assert.equal(card.props.mode, 'card')
  assert.equal(card.props.snapshot, cardSnapshot, 'the card reads the shared task store')
  assert.equal(card.props.store, cardStore)
  assert.equal(card.props.engineScope, scope, 'the card supplies the config scope')
  assert.equal(card.props.t('settingsPageTitle'), 'tc:settingsPageTitle', 'the card speaks the task center locale')
  assert.equal(loads, 1, 'opening the card asks the store for the current project')
  assert.equal(card.props.project, undefined, 'the page resolves the project from the snapshot')
}
console.log('PASS  plugins.bundle.config mounts the shared settings page in card mode')

// ── narrow screens fold the rail into a top tab row ───────────────────────
{
  const folded = HEAD.indexOf('@media (max-width:900px){.gbt-settingsbody{flex-direction:column}')
  assert.ok(folded >= 0, 'there is a narrow layout rule for the settings page')
  const rule = HEAD.slice(folded, folded + 400)
  assert.ok(rule.includes('.gbt-settingsnav{flex-direction:row'), 'the left rail becomes a horizontal top row')
  assert.ok(rule.includes('overflow-x:auto'), 'the folded tab row scrolls horizontally')
  assert.ok(rule.includes('border-bottom'), 'the folded row keeps the separation line')
  // A class-level display beats the UA [hidden] rule: the page must hide the
  // non-selected sections explicitly or every theme would render at once.
  assert.ok(HEAD.includes('.gbt-settingssection[hidden]{display:none}'), 'hidden sections are really hidden')
}
console.log('PASS  a narrow viewport folds the nav into top tabs');

console.log('PASS  SettingsPage is a page with a left rail, a scrolling right column and a save/cancel footer');
