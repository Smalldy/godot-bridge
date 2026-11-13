import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSettingsForm } = require('../../client/src/views/settings-form.cjs')
function h(type, props, ...children) { return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) } }
const Modal = (props) => ({ type: 'modal', props: props })
const posts = []
const SettingsForm = createSettingsForm({ React: { useRef: () => ({ current: null }), useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] }, h: h, Modal: Modal, store: { send: async (action, body) => { posts.push({ action: action, body: body }); return { ok: true } } } })
const out = SettingsForm({ t: (key) => key, dispatch: { maxConcurrent: 3, maxWorkAgents: 4, defaultTarget: '' }, onClose: () => {} })
assert.equal(out.type, Modal)
const text = JSON.stringify(out)
assert.ok(text.includes('maxConcurrent'))
assert.ok(text.includes('defaultTargetLabel'))
assert.ok(text.includes('concurrencyHint'))
assert.ok(!text.includes('maxWorkAgents'))
assert.ok(!text.includes('max-work-agents'))
assert.ok(!text.includes('settingsWorkerGroup'))
assert.ok(!text.includes('settingsCapacity'))
assert.ok(!text.includes('allow-spawn'))
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
  else walk(children, visit)
}
let apply = null
walk(out, (node) => { if (node.type === 'button' && node.props && node.props['data-variant'] === 'primary') apply = node })
assert.ok(apply !== null)
apply.props.onClick()
await Promise.resolve()
await Promise.resolve()
assert.equal(posts.length, 1)
assert.equal(posts[0].action, 'settings')
assert.equal(posts[0].body.maxConcurrent, 3)
assert.equal(posts[0].body.maxAttempts, 3)
assert.equal(posts[0].body.defaultTarget, '')
assert.equal(Object.hasOwn(posts[0].body, 'maxWorkAgents'), false)
assert.equal(Object.hasOwn(posts[0].body, 'allowSpawn'), false)
console.log('PASS  SettingsForm exposes only maxConcurrent and never sends maxWorkAgents')
