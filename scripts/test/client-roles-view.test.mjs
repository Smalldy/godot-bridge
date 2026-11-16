import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRolesView } = require('../../client/src/views/roles-view.cjs')
const { tcAgentTreeOf } = require('../../client/src/selectors.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const RolesEditor = (props) => ({ type: 'roles-editor', props: props })
const RolesView = createRolesView({ React: { useReducer: () => [0, () => {}] }, h: h, RolesEditor: RolesEditor, tcAgentTreeOf: tcAgentTreeOf })
const t = (key) => key

const unavailable = RolesView({ t: t, snapshot: { roles: null }, store: {} })
assert.ok(JSON.stringify(unavailable).includes('rolesUnavailable'))

const available = RolesView({ t: t, snapshot: {
  roles: { profiles: {} },
  agentTree: {
    available: true,
    root: { id: 'session-root', name: 'root', role: 'lead' },
    members: [
      { id: 'session-w1', name: 'worker-1', role: 'worker', status: 'running', taskId: 'T-1' },
      { id: 'session-r1', name: 'reviewer-1', role: 'reviewer', status: 'inactive', taskId: null },
      { id: 'session-x', name: 'helper', role: null, status: 'running', taskId: null },
    ],
    count: 3,
    error: null,
  },
}, store: {} })
assert.equal(available.props.className, 'gbt-rolesview')
assert.equal(available.props['data-roles-deck'], 'true')
// A direction: the view adds NO header/card of its own — the editor's own page
// head is the only heading, so there is one title and one navigation layer.
assert.equal(JSON.stringify(available).includes('gbt-rolesview-card'), false)
assert.equal(JSON.stringify(available).includes('roleEditor'), false)
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
  else walk(children, visit)
}
const editors = []
walk(available, (node) => { if (node.type === RolesEditor) editors.push(node) })
assert.equal(editors.length, 1)
assert.deepEqual(editors[0].props.instances.map((entry) => entry.kind), ['worker', 'reviewer'])
assert.deepEqual(editors[0].props.instances.map((entry) => entry.name), ['worker-1', 'reviewer-1'])
const text = JSON.stringify(available)
assert.ok(!text.includes('data-roles-sessions'))
assert.ok(!text.includes('dispatchReady'))
assert.ok(!text.includes('missingRoles'))
assert.ok(!text.includes('Team'))
assert.ok(!text.includes('data-role-stage-strip'))
assert.ok(!text.includes('data-role-tabs'))

console.log('PASS  RolesView mounts the single stage-rail editor and counts live tree members by role')
