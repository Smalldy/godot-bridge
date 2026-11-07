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

console.log('PASS  RoleCreateForm is an independently testable view module')
