import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRolesEditor } = require('../../client/src/views/roles-editor.cjs')
const { createRolesView } = require('../../client/src/views/roles-view.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
  else walk(children, visit)
}
function findAll(root, predicate) {
  const out = []
  walk(root, (node) => { if (node.props && predicate(node)) out.push(node) })
  return out
}
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node.props) return ''
  const children = node.props.children
  return Array.isArray(children) ? children.map(textOf).join('') : textOf(children)
}

const ROLE_EDITOR_KINDS = ['worker', 'tester', 'reviewer']
const ROLE_EDITOR_STAGES = { worker: 'implement', reviewer: 'review', tester: 'test' }
const kindLabel = { worker: '实现', reviewer: '评审', tester: '测试', merger: '合并' }
const config = {
  stages: { implement: 'worker', review: 'godot-reviewer', test: 'tester' },
  profiles: {
    worker: { name: 'worker', role: 'worker', stage: 'implement', context: 'fresh', skills: [], prompt: 'worker prompt' },
    reviewer: { name: 'reviewer', role: 'reviewer', stage: 'review', context: 'fresh', skills: [], prompt: 'reviewer prompt' },
    tester: { name: 'tester', role: 'tester', stage: 'test', context: 'fresh', skills: [], prompt: 'tester prompt' },
    'godot-reviewer': { name: 'godot-reviewer', role: 'reviewer', stage: 'review', context: 'fork', skills: ['dsh-plugin-workflow'], prompt: 'Check Godot idioms.' },
  },
}
const snapshot = {
  roles: config,
  team: { members: [] },
  agents: { lead: null, members: [] },
  tasks: [],
  scope: { panelSession: 'session-a', sessionSummaries: [
    { sessionId: 'session-a', status: 'live', dispatchReady: true, stageReady: { review: true, test: false }, cards: { owned: 3 }, team: { lead: 'lead-a' } },
    { sessionId: 'session-b', status: 'stale', dispatchReady: false, stageReady: { review: false, test: false }, cards: { owned: 0 }, team: { lead: 'lead-b' } },
  ] },
}
const state = {
  kind: 'reviewer', selected: 'godot-reviewer', draft: null, saved: null, preview: null, previewKey: null, previewPending: false, previewError: null,
  notice: null, applySkipped: false, pickVersion: 0, skills: [], skillsOpen: false, skillsError: null, skillsSelected: new Set(), skillsFailed: false,
}
function roleBoundProfile(cfg, kind) {
  const stage = ROLE_EDITOR_STAGES[kind]
  const name = cfg.stages[stage]
  return name && cfg.profiles[name] ? { name, profile: cfg.profiles[name] } : null
}
const deps = {
  React: { useState: (init) => [typeof init === 'function' ? init() : init, () => {}], useEffect: () => {}, useRef: (init) => ({ current: init === undefined ? null : init }), useReducer: (reducer, init) => [init, () => {}] },
  h,
  roleResultBanner: (payload) => h('div', { 'data-role-result': 'error' }, String(payload && payload.code)),
  tableWrap: (children) => h('div', null, children),
  roleBoundProfile,
  roleSelectableProfiles: (cfg, kind) => Object.keys(cfg.profiles).filter((name) => cfg.profiles[name].role === kind),
  roleProfileCopy: (profile) => Object.assign({}, profile),
  AgentRow: () => null,
  RoleCreateForm: () => h('div', { 'data-form': 'role-create' }),
  roleErrorText: (payload) => String(payload && payload.code),
  workerStatusLabel: (status) => String(status),
  roleKindLabel: (kind) => kindLabel[kind] || String(kind),
  actorLabel: (value) => String(value),
  tcSplitList: () => [],
  roleEditorState: state,
  ROLE_EDITOR_KINDS,
  ROLE_EDITOR_STAGES,
  copyToClipboard: async () => true,
}
const RolesEditor = createRolesEditor(deps)
const editor = RolesEditor({ t: (key) => key, snapshot, store: {}, instances: [
  { name: 'worker-1', kind: 'worker', status: 'running' },
  { name: 'reviewer-1', kind: 'reviewer', status: 'running' },
  { name: 'tester-1', kind: 'tester', status: 'idle' },
], bump: () => {} })

const stages = findAll(editor, (node) => node.props['data-stage-slot'] !== undefined)
assert.equal(stages.length, 3)
assert.deepEqual(stages.map((node) => node.props['data-bound-profile']), ['worker', 'godot-reviewer', 'tester'])
assert.deepEqual(stages.map((node) => node.props['data-live']), ['1', '1', '1'])
assert.deepEqual(stages.map((node) => node.props['data-ready']), ['true', 'true', 'true'])
const roster = findAll(editor, (node) => node.props['data-role-profile'] !== undefined)
const rosterNames = roster.map((node) => node.props['data-role-profile'])
assert.ok(rosterNames.indexOf('worker') >= 0 && rosterNames.indexOf('reviewer') >= 0 && rosterNames.indexOf('tester') >= 0)
assert.ok(rosterNames.indexOf('merger') >= 0 && rosterNames.indexOf('godot-reviewer') >= 0)
assert.equal(roster.filter((node) => node.props['data-role-selected'] === 'true')[0].props['data-role-profile'], 'godot-reviewer')
const mergerRow = roster.filter((node) => node.props['data-role-profile'] === 'merger')[0]
assert.equal(mergerRow.props.disabled, false)
mergerRow.props.onClick()
assert.equal(deps.roleEditorState.kind, 'merger')
assert.equal(deps.roleEditorState.selected, 'merger')
const sections = findAll(editor, (node) => node.props['data-role-section'] !== undefined).map((node) => node.props['data-role-section'])
assert.deepEqual(sections.filter((value, index) => sections.indexOf(value) === index), ['identity', 'behavior', 'application'])
assert.equal(findAll(editor, (node) => node.props['data-roles-pane'] === 'raw').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-roles-pane'] === 'injected').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-role-card'] === 'raw').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-role-card'] === 'injected').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-chain'] === 'current-use' || node.props['data-role-use-select'] === 'true').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-action'] === 'role-editor-save').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-action'] === 'role-editor-fork').length, 0)
assert.ok(textOf(editor).indexOf('Check Godot idioms.') >= 0 || textOf(editor).indexOf('godot-reviewer') >= 0)

const draftState = Object.assign({}, state, { draft: { name: 'copy', source: 'godot-reviewer', profile: config.profiles['godot-reviewer'] }, selected: 'copy' })
deps.roleEditorState = draftState
const draftEditor = createRolesEditor(deps)({ t: (key) => key, snapshot, store: {}, instances: [], bump: () => {} })
assert.ok(findAll(draftEditor, (node) => node.props['data-role-draft-hint'] === 'true').length === 1)
assert.equal(draftEditor.props['data-draft'], 'true')
assert.equal(findAll(draftEditor, (node) => node.props['data-action'] === 'role-editor-discard').length, 1)

const RolesEditorStub = (props) => h('div', { 'data-editor-stub': 'true', 'data-kind': props.instances.length })
const RolesView = createRolesView({ React: deps.React, h, RolesEditor: RolesEditorStub })
const view = RolesView({ t: (key) => key, snapshot, store: {} })
assert.equal(view.props.className, 'gbt-rolesview')
assert.equal(view.props['data-roles-deck'], 'true')
assert.equal(findAll(view, (node) => node.props['data-roles-sessions'] === 'true').length, 1)
assert.equal(findAll(view, (node) => node.props['data-session-filter'] === 'true').length, 1)
assert.equal(findAll(view, (node) => node.props['data-session'] !== undefined).length, 2)
assert.equal(findAll(view, (node) => node.type === 'table').length, 0)

const css = readFileSync(new URL('../../client/src/00-head.part', import.meta.url), 'utf8')
assert.ok(css.indexOf('grid-template-columns:300px minmax(0,1fr)') >= 0)
assert.ok(css.indexOf('grid-template-columns:minmax(0,1fr) 360px') >= 0)
assert.ok(css.indexOf('@media (max-width:900px){.gbt-rolesview[data-roles-deck]') >= 0)
assert.ok(css.indexOf('zoom:') < 0 && css.indexOf('transform:scale') < 0)
console.log('PASS  T-172 roles Shift Deck: stage strip, roster, three-column editor, preview, compact readiness, CSS')
