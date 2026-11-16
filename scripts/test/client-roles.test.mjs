import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createRolesEditor } = require('../../client/src/views/roles-editor.cjs')
const { createRolesView } = require('../../client/src/views/roles-view.cjs')
const { tcAgentTreeOf } = require('../../client/src/selectors.cjs')

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
const kindLabel = { worker: '实现', reviewer: '评审', tester: '测试' }
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
  agentTree: {
    available: true,
    root: { id: 'session-root', name: 'root', role: 'lead' },
    members: [
      { id: 'session-w1', name: 'worker-1', role: 'worker', status: 'running', taskId: 'T-1' },
      { id: 'session-r1', name: 'reviewer-1', role: 'reviewer', status: 'running', taskId: 'T-2' },
      { id: 'session-t1', name: 'tester-1', role: 'tester', status: 'inactive', taskId: null },
    ],
    count: 3,
    error: null,
  },
  tasks: [],
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
const RoleCreateFormStub = (props) => ({ type: 'role-create-form', props: props })
const deps = {
  React: { useState: (init) => [typeof init === 'function' ? init() : init, () => {}], useEffect: () => {}, useRef: (init) => ({ current: init === undefined ? null : init }), useReducer: (reducer, init) => [init, () => {}] },
  h,
  roleResultBanner: (payload) => h('div', { 'data-role-result': 'error' }, String(payload && payload.code)),
  tableWrap: (children) => h('div', null, children),
  roleBoundProfile,
  roleSelectableProfiles: (cfg, kind) => Object.keys(cfg.profiles).filter((name) => cfg.profiles[name].role === kind),
  roleProfileCopy: (profile) => Object.assign({}, profile),
  RoleCreateForm: RoleCreateFormStub,
  roleErrorText: (payload) => String(payload && payload.code),
  roleKindLabel: (kind) => kindLabel[kind] || String(kind),
  tcSplitList: () => [],
  roleEditorState: state,
  ROLE_EDITOR_KINDS,
  ROLE_EDITOR_STAGES,
  copyToClipboard: async () => true,
}
const instances = [
  { name: 'worker-1', kind: 'worker', status: 'running' },
  { name: 'reviewer-1', kind: 'reviewer', status: 'running' },
  { name: 'tester-1', kind: 'tester', status: 'idle' },
]
const RolesEditor = createRolesEditor(deps)
const editor = RolesEditor({ t: (key) => key, snapshot, store: {}, instances, bump: () => {} })

// ── One stage navigator: the left rail. No top strip, no roster column. ──
assert.equal(findAll(editor, (node) => node.props['data-role-stage-rail'] === 'true').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-role-stage-strip'] !== undefined).length, 0)
assert.equal(findAll(editor, (node) => node.props['data-role-tabs'] !== undefined).length, 0)
assert.equal(findAll(editor, (node) => node.props['data-role-list'] !== undefined).length, 0)
assert.equal(findAll(editor, (node) => node.props['data-role-profile'] !== undefined).length, 0)
assert.equal(findAll(editor, (node) => node.props.role === 'tablist').length, 0)
assert.equal(findAll(editor, (node) => node.props['data-role-stage-list'] === 'true').length, 1)

// 01 / 02 / 03, stage + role + state + bound profile + live count per row.
const stages = findAll(editor, (node) => node.props['data-stage-slot'] !== undefined)
assert.equal(stages.length, 3)
assert.deepEqual(stages.map((node) => node.props['data-stage-slot']), ['implement', 'review', 'test'])
assert.deepEqual(stages.map((node) => node.props['data-roles-stage']), ['worker', 'reviewer', 'tester'])
assert.deepEqual(stages.map((node) => node.props['data-active']), ['false', 'true', 'false'])
assert.deepEqual(stages.map((node) => node.props['data-bound-profile']), ['worker', 'godot-reviewer', 'tester'])
assert.deepEqual(stages.map((node) => node.props['data-live']), ['1', '1', '1'])
assert.deepEqual(stages.map((node) => node.props['data-ready']), ['true', 'true', 'true'])
const stageText = stages.map(textOf).join(' | ')
assert.ok(stageText.indexOf('01') >= 0 && stageText.indexOf('02') >= 0 && stageText.indexOf('03') >= 0)
assert.ok(stageText.indexOf('roleStageEditing') >= 0, 'the edited stage is marked as being edited')
assert.ok(stageText.indexOf('roleStageEnabled') >= 0, 'the other stages report their enabled state')
assert.ok(stageText.indexOf('godot-reviewer') >= 0, 'the bound profile is visible on the stage row')

// The profile picker at the rail top carries the custom copies (no roster).
const pickers = findAll(editor, (node) => node.props['data-role-profile-select'] === 'true')
assert.equal(pickers.length, 1)
assert.equal(pickers[0].props['data-stage'], 'review')
assert.equal(pickers[0].props.defaultValue, 'godot-reviewer')
const pickerOptions = findAll(pickers[0], (node) => node.type === 'option').map((node) => node.props.value)
assert.deepEqual(pickerOptions, ['reviewer', 'godot-reviewer'])

// Blank creation stays reachable from the rail; it is not in APPLICATION.
const createEntry = findAll(editor, (node) => node.props['data-role-create-entry'] === 'true')[0]
assert.ok(createEntry !== undefined)
assert.equal(createEntry.props.open, undefined)
assert.ok(textOf(findAll(createEntry, (node) => node.props['data-role-create-summary'] === 'true')[0]).indexOf('roleEditorCreateBlank') >= 0)
assert.equal(findAll(findAll(editor, (node) => node.props['data-role-stage-rail'] === 'true')[0], (node) => node.type === RoleCreateFormStub).length, 1)
assert.equal(findAll(editor, (node) => node.props['data-role-section'] === 'application' && node.type === 'section').filter((node) => findAll(node, (child) => child.type === RoleCreateFormStub).length > 0).length, 0)

// ── The editor keeps IDENTITY / BEHAVIOR / APPLICATION and the preview. ──
const sections = findAll(editor, (node) => node.props['data-role-section'] !== undefined).map((node) => node.props['data-role-section'])
assert.deepEqual(sections.filter((value, index) => sections.indexOf(value) === index), ['identity', 'behavior', 'application'])
assert.equal(findAll(editor, (node) => node.props['data-roles-pane'] === 'raw').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-roles-pane'] === 'injected').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-role-card'] === 'raw').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-role-card'] === 'injected').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-role-use-select'] === 'true').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-editor-identity'] === 'true').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-action'] === 'role-editor-save').length, 1)
assert.equal(findAll(editor, (node) => node.props['data-action'] === 'role-editor-fork').length, 0)
assert.ok(textOf(editor).indexOf('Check Godot idioms.') >= 0 || textOf(editor).indexOf('godot-reviewer') >= 0)
assert.ok(textOf(editor).indexOf('merger') < 0 && textOf(editor).indexOf('合并') < 0)

const draftState = Object.assign({}, state, { draft: { name: 'copy', source: 'godot-reviewer', profile: config.profiles['godot-reviewer'] }, selected: 'copy' })
deps.roleEditorState = draftState
const draftEditor = createRolesEditor(deps)({ t: (key) => key, snapshot, store: {}, instances: [], bump: () => {} })
assert.ok(findAll(draftEditor, (node) => node.props['data-role-draft-hint'] === 'true').length === 1)
assert.equal(draftEditor.props['data-draft'], 'true')
assert.equal(findAll(draftEditor, (node) => node.props['data-action'] === 'role-editor-discard').length, 1)
assert.ok(textOf(draftEditor).indexOf('roleEditorDraft') >= 0, 'the rail marks the stage as a draft while one is open')
assert.equal(findAll(draftEditor, (node) => node.props['data-role-profile-select'] === 'true')[0].props.defaultValue, 'godot-reviewer')

const RolesEditorStub = (props) => h('div', { 'data-editor-stub': 'true', 'data-kind': props.instances.length })
const RolesView = createRolesView({ React: deps.React, h, RolesEditor: RolesEditorStub, tcAgentTreeOf })
const view = RolesView({ t: (key) => key, snapshot, store: {} })
assert.equal(view.props.className, 'gbt-rolesview')
assert.equal(view.props['data-roles-deck'], 'true')
assert.equal(findAll(view, (node) => node.props['data-roles-sessions'] === 'true').length, 0)
assert.equal(findAll(view, (node) => node.props['data-session-filter'] === 'true').length, 0)
assert.equal(findAll(view, (node) => node.type === RolesEditorStub)[0].props.instances.length, 3)

const css = readFileSync(new URL('../../client/src/00-head.part', import.meta.url), 'utf8')
assert.ok(css.indexOf('grid-template-columns:252px minmax(0,1fr)') >= 0, 'the stage rail is the left column')
assert.ok(css.indexOf('grid-template-columns:minmax(0,1fr) 360px') >= 0, 'the injected preview keeps its own column')
assert.ok(css.indexOf('@media (max-width:900px){.gbt-rolesview[data-roles-deck]') >= 0)
assert.equal(css.indexOf('.gbt-rolesstages'), -1, 'the retired top stage strip has no CSS left')
assert.equal(css.indexOf('.gbt-roleslist'), -1, 'the retired roster column has no CSS left')
assert.ok(css.indexOf('zoom:') < 0 && css.indexOf('transform:scale') < 0)
assert.ok(css.indexOf('roleKindMerger') < 0 && css.indexOf('gbt-teampill') < 0)
console.log('PASS  T-186 roles A direction: ONE stage rail, profile picker, no top strip/roster, three-column editor with injected preview')
