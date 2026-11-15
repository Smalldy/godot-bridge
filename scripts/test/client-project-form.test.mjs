import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createProjectForm } = require('../../client/src/views/project-form.cjs')
function h(type, props, ...children) { return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) } }
const Modal = (props) => ({ type: 'modal', props: props })
const ProjectForm = createProjectForm({ React: { useRef: () => ({ current: null }), useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] }, h: h, Modal: Modal, projectFormState: { value: null }, store: { switchProject: async () => ({ ok: true }) }, tcErrorMessage: () => 'error' })
const out = ProjectForm({ t: (key) => key, hostProject: '/repo', project: '/repo', onClose: () => {} })
assert.equal(out.type, Modal)
const text = JSON.stringify(out)
assert.ok(text.includes('projectPlaceholder'))
assert.ok(text.includes('useCurrentProject'))
assert.ok(text.includes('openProject'))
console.log('PASS  ProjectForm is an independently testable view module')

// ── T-182: a thrown transport failure is shown, not swapped for the fallback ─
// A rejected fetch (host unreachable) reaches the dialog as result.error, not as
// a payload. The form used to read only result.payload, so ECONNREFUSED became
// the generic "操作失败" and the real reason was invisible.
function createHarness() {
  const states = []
  const harness = {
    cursor: 0,
    React: {
      useRef: function () { return { current: null } },
      useState: function (initial) {
        const index = harness.cursor++
        if (index >= states.length) states.push(typeof initial === 'function' ? initial() : initial)
        return [states[index], function (next) { states[index] = typeof next === 'function' ? next(states[index]) : next }]
      },
    },
  }
  return harness
}
function renderAt(harness, Component, props) {
  harness.cursor = 0
  return Component(props)
}
function collect(node, predicate, found) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, found)
    return
  }
  if (typeof node !== 'object') return
  if (predicate(node)) found.push(node)
  collect(node.props === undefined ? undefined : node.props.children, predicate, found)
}
function primaryButton(tree) {
  const found = []
  collect(tree, (node) => node.props !== undefined && node.props['data-project-primary'] !== undefined, found)
  return found[0]
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

// 1. A rejected fetch surfaces the transport reason in the dialog.
const failureState = { value: '/unreachable', error: '', missing: [] }
const failureHarness = createHarness()
const FailingForm = createProjectForm({
  React: failureHarness.React,
  h: h,
  Modal: Modal,
  projectFormState: failureState,
  store: { switchProject: async () => ({ ok: false, error: new Error('connect ECONNREFUSED 127.0.0.1:9090') }) },
  tcErrorMessage: () => '操作失败',
})
const failureProps = { t: (key) => key, hostProject: null, project: null, onClose: () => {} }
const failureTree = renderAt(failureHarness, FailingForm, failureProps)
assert.ok(primaryButton(failureTree) !== undefined, 'the dialog has a primary open action')
primaryButton(failureTree).props.onClick()
await tick()
const failureJson = JSON.stringify(renderAt(failureHarness, FailingForm, failureProps))
assert.ok(failureJson.includes('connect ECONNREFUSED 127.0.0.1:9090'), 'the dialog shows the thrown transport error')
assert.ok(failureJson.includes('"data-project-error":"true"'), 'the dialog renders its error line')
assert.ok(!failureJson.includes('操作失败'), 'the generic fallback does not replace the real reason')
console.log('PASS  a rejected fetch surfaces its real reason in the project dialog')

// 2. A payload failure still shows its own message (the old path).
const payloadState = { value: '/bad', error: '', missing: [] }
const payloadHarness = createHarness()
const PayloadForm = createProjectForm({
  React: payloadHarness.React,
  h: h,
  Modal: Modal,
  projectFormState: payloadState,
  store: { switchProject: async () => ({ ok: false, payload: { ok: false, code: 'invalid-project', message: 'ENOENT: no such directory' } }) },
  tcErrorMessage: (payload, t) => (payload !== null && payload !== undefined && typeof payload.message === 'string' ? payload.message : t('error')),
})
const payloadProps = { t: (key) => key, hostProject: null, project: null, onClose: () => {} }
primaryButton(renderAt(payloadHarness, PayloadForm, payloadProps)).props.onClick()
await tick()
const payloadJson = JSON.stringify(renderAt(payloadHarness, PayloadForm, payloadProps))
assert.ok(payloadJson.includes('ENOENT: no such directory'), 'a payload failure keeps its own message')
console.log('PASS  a payload failure still shows its own message')
