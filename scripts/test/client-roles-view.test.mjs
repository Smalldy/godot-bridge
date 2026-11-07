import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRolesView } = require('../../client/src/views/roles-view.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const RolesEditor = (props) => ({ type: 'roles-editor', props: props })
const RolesView = createRolesView({ React: { useReducer: () => [0, () => {}] }, h: h, RolesEditor: RolesEditor })
const t = (key) => key

const unavailable = RolesView({ t: t, snapshot: { roles: null }, store: {} })
assert.ok(JSON.stringify(unavailable).includes('rolesUnavailable'))

const available = RolesView({ t: t, snapshot: { roles: { profiles: {} }, agents: null, team: null }, store: {} })
assert.equal(available.props.className, 'gbt-rolesview')
assert.ok(JSON.stringify(available).includes('roleEditor'))

console.log('PASS  RolesView is an independently testable view module')
