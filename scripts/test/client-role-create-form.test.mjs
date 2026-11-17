import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRoleCreateForm } = require('../../client/src/views/role-create-form.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const RoleCreateForm = createRoleCreateForm({
  React: { useRef: () => ({ current: null }) },
  h: h,
  tcSplitList: (value) => String(value).split(',').map((part) => part.trim()).filter(Boolean),
  roleKindLabel: (kind) => kind,
})
const out = RoleCreateForm({ t: (key) => key, onCreate: () => {}, onInvalid: () => {} })
assert.equal(out.type, 'div')
assert.equal(out.props['data-form'], 'role-create')
const text = JSON.stringify(out)
assert.ok(text.includes('roleName'))
assert.ok(text.includes('roleKind'))
assert.ok(text.includes('roleCreate'))

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
  else walk(children, visit)
}
function roleSelectOf(tree) {
  const found = []
  walk(tree, (node) => { if (node.props && node.props['data-field'] === 'role') found.push(node) })
  return found[0]
}

// The form is rendered inside the stage rail, so it defaults to that stage's
// kind. A fixed reviewer default created the wrong kind from the 01/03 rail and
// the immediate rolesBind was refused with stage-mismatch.
assert.equal(roleSelectOf(out).props.defaultValue, 'reviewer', 'no defaultRole keeps the historical reviewer default')
for (const [kind, stage] of [['worker', 'implement'], ['reviewer', 'review'], ['tester', 'test']]) {
  const staged = RoleCreateForm({ t: (key) => key, defaultRole: kind, onCreate: () => {}, onInvalid: () => {} })
  assert.equal(roleSelectOf(staged).props.defaultValue, kind, kind + ' is the default kind for the ' + stage + ' rail entry')
}
const fallback = RoleCreateForm({ t: (key) => key, defaultRole: 'not-a-kind', onCreate: () => {}, onInvalid: () => {} })
assert.equal(roleSelectOf(fallback).props.defaultValue, 'reviewer', 'an unknown defaultRole falls back safely')

console.log('PASS  RoleCreateForm is an independently testable view module')
