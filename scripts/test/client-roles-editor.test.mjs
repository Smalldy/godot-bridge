import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRolesEditor } = require('../../client/src/views/roles-editor.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const React = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial === undefined ? null : initial }),
  useReducer: (reducer, initial) => [initial, () => {}],
}
const state = {
  kind: 'worker',
  draft: null,
  saved: null,
  selected: 'worker',
  preview: null,
  previewTaskId: '',
  previewPending: false,
  previewKey: null,
  previewError: null,
  skills: [],
  notice: null,
  applySkipped: false,
  pickVersion: 0,
  used: new Set(),
}
const RolesEditor = createRolesEditor({
  React: React,
  h: h,
  roleResultBanner: () => null,
  tableWrap: (key, table) => table,
  roleBoundProfile: () => 'worker',
  roleSelectableProfiles: () => ['worker'],
  roleProfileCopy: (profile) => profile,
  AgentRow: () => null,
  RoleCreateForm: () => null,
  roleErrorText: () => '',
  workerStatusLabel: (status) => status,
  roleKindLabel: (kind) => kind,
  actorLabel: () => '',
  tcSplitList: () => [],
  roleEditorState: state,
  ROLE_EDITOR_KINDS: ['worker', 'reviewer', 'tester'],
  ROLE_EDITOR_STAGES: { worker: 'implement', reviewer: 'review', tester: 'test' },
  copyToClipboard: async () => true,
})
const snapshot = {
  roles: { profiles: { worker: { role: 'worker', stage: 'implement', skills: [], context: 'fresh', permissions: ['read-only'], prompt: '' } }, stages: { implement: 'worker', review: 'reviewer', test: 'tester' } },
  team: null,
  agents: null,
}
const out = RolesEditor({ t: (key) => key, snapshot: snapshot, store: {}, instances: [], bump: () => {} })
assert.equal(out.type, 'div')
assert.equal(out.props.className, 'gbt-roleeditor')
const text = JSON.stringify(out)
assert.ok(text.includes('roleEditorTabsLabel'))

console.log('PASS  RolesEditor is an independently testable view module')
