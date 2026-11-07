import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSettingsForm } = require('../../client/src/views/settings-form.cjs')
function h(type, props, ...children) { return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) } }
const Modal = (props) => ({ type: 'modal', props: props })
const SettingsForm = createSettingsForm({ React: { useRef: () => ({ current: null }), useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] }, h: h, Modal: Modal, store: { send: async () => ({ ok: true }) } })
const out = SettingsForm({ t: (key) => key, dispatch: { maxConcurrent: 3, defaultTarget: '' }, onClose: () => {} })
assert.equal(out.type, Modal)
const text = JSON.stringify(out)
assert.ok(text.includes('maxConcurrent'))
assert.ok(text.includes('defaultTargetLabel'))
assert.ok(text.includes('concurrencyHint'))
console.log('PASS  SettingsForm is an independently testable view module')
