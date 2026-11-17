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
  used: new Set(),
}
const RoleCreateFormStub = (props) => ({ type: 'role-create-form', props: props })
const workerProfile = { name: 'worker', role: 'worker', stage: 'implement', skills: [], context: 'fresh', permissions: ['read-only'], prompt: '' }
const RolesEditor = createRolesEditor({
  React: React,
  h: h,
  roleResultBanner: () => null,
  tableWrap: (key, table) => table,
  roleBoundProfile: () => ({ name: 'worker', profile: workerProfile }),
  roleSelectableProfiles: () => ['worker'],
  roleProfileCopy: (profile) => profile,
  AgentRow: () => null,
  RoleCreateForm: RoleCreateFormStub,
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
  roles: { profiles: { worker: workerProfile }, stages: { implement: 'worker', review: 'reviewer', test: 'tester' } },
  team: null,
  agents: null,
  tasks: [],
}
const out = RolesEditor({ t: (key) => key, snapshot: snapshot, store: {}, instances: [], bump: () => {} })

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const children = node.props && node.props.children
  if (Array.isArray(children)) children.forEach((child) => walk(child, visit))
  else walk(children, visit)
}
const found = []
walk(out, (node) => found.push(node))
const stages = found.filter((node) => node.props && node.props['data-stage-slot'] !== undefined)
const sections = found.filter((node) => node.props && node.props['data-role-section'] !== undefined).map((node) => node.props['data-role-section'])
const text = JSON.stringify(out)

// The A-direction skeleton: ONE stage navigator (the left rail), no top strip.
assert.equal(out.type, 'div')
assert.equal(out.props.className, 'gbt-roleeditor')
assert.equal(out.props['data-role-deck'], 'true')
assert.equal(found.filter((node) => node.props && node.props['data-role-stage-rail'] === 'true').length, 1)
assert.equal(found.filter((node) => node.props && node.props['data-role-stage-strip'] !== undefined).length, 0)
assert.equal(found.filter((node) => node.props && node.props['data-role-tabs'] !== undefined).length, 0)
assert.equal(found.filter((node) => node.props && node.props.role === 'tablist').length, 0)
assert.equal(text.includes('"roleEditorTabsLabel"'), false)

// 01 / 02 / 03 stages with role, stage, state, bound profile and live count.
assert.equal(stages.length, 3)
assert.deepEqual(stages.map((node) => node.props['data-stage-slot']), ['implement', 'review', 'test'])
assert.deepEqual(stages.map((node) => node.props['data-roles-stage']), ['worker', 'reviewer', 'tester'])
assert.deepEqual(stages.map((node) => node.props['data-active']), ['true', 'false', 'false'])
assert.deepEqual(stages.map((node) => node.props['data-bound-profile']), ['worker', '', ''])
assert.ok(text.includes('roleStageCurrent'))
assert.ok(text.includes('roleStageEnabled'))
assert.ok(text.includes('roleStagesHint'))

// The profile picker replaces the roster column; blank create stays reachable.
const pickers = found.filter((node) => node.props && node.props['data-role-profile-select'] === 'true')
assert.equal(pickers.length, 1)
assert.equal(pickers[0].props['data-stage'], 'implement')
// Controlled: the value always comes from the editor state, so a refused switch
// cannot leave a value on screen that is not being edited (and nothing remounts).
assert.equal(pickers[0].props.value, 'worker')
assert.equal(pickers[0].props.defaultValue, undefined)
const useSelects = found.filter((node) => node.props && node.props['data-role-use-select'] === 'true')
assert.equal(useSelects.length, 1)
assert.equal(useSelects[0].props.value, 'worker')
assert.equal(useSelects[0].props.defaultValue, undefined)
assert.equal(found.filter((node) => node.props && node.props['data-role-profile'] !== undefined).length, 0)
const createEntry = found.filter((node) => node.props && node.props['data-role-create-entry'] === 'true')[0]
assert.ok(createEntry !== undefined)
const createForms = found.filter((node) => node.type === RoleCreateFormStub)
assert.equal(createForms.length, 1)
// The stage-scoped entry creates a profile of the stage being edited.
assert.equal(createForms[0].props.defaultRole, 'worker')

// The editor keeps IDENTITY / BEHAVIOR / APPLICATION and the injected preview.
assert.deepEqual(sections.filter((value, index) => sections.indexOf(value) === index), ['identity', 'behavior', 'application'])
assert.equal(found.filter((node) => node.props && node.props['data-roles-pane'] === 'raw').length, 1)
assert.equal(found.filter((node) => node.props && node.props['data-roles-pane'] === 'injected').length, 1)
assert.equal(found.filter((node) => node.props && node.props['data-role-card'] === 'raw').length, 1)
assert.equal(found.filter((node) => node.props && node.props['data-role-card'] === 'injected').length, 1)
assert.equal(found.filter((node) => node.props && node.props['data-role-use-select'] === 'true').length, 1)
assert.equal(found.filter((node) => node.props && node.props['data-editor-identity'] === 'true').length, 1)
// A built-in default is read-only here: copy (fork) is the offered action.
assert.equal(found.filter((node) => node.props && node.props['data-action'] === 'role-editor-fork').length, 1)
assert.equal(found.filter((node) => node.props && node.props['data-action'] === 'role-editor-save').length, 0)

// ── Refused switch with a draft open (the silent-data-loss regression) ────
// The profile and current-use selectors are controlled and NOT keyed by a
// version counter: a refusal must leave the typed draft prompt/skills controls
// mounted and untouched, not remount them on the saved defaults.
const draftState = {
  kind: 'worker',
  draft: { source: 'worker', name: 'worker-fork', profile: Object.assign({}, workerProfile, { prompt: 'typed draft prompt' }) },
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
  used: new Set(),
}
const draftDeps = Object.assign({}, {
  React: React,
  h: h,
  roleResultBanner: () => null,
  tableWrap: (key, table) => table,
  roleBoundProfile: () => ({ name: 'worker', profile: workerProfile }),
  roleSelectableProfiles: () => ['worker'],
  roleProfileCopy: (profile) => profile,
  RoleCreateForm: RoleCreateFormStub,
  roleErrorText: () => '',
  roleKindLabel: (kind) => kind,
  tcSplitList: () => [],
  roleEditorState: draftState,
  ROLE_EDITOR_KINDS: ['worker', 'reviewer', 'tester'],
  ROLE_EDITOR_STAGES: { worker: 'implement', reviewer: 'review', tester: 'test' },
  copyToClipboard: async () => true,
}, {})
const draftEditor = createRolesEditor(draftDeps)
const draftOut = draftEditor({ t: (key) => key, snapshot: snapshot, store: {}, instances: [], bump: () => {} })
function collect(tree) {
  const nodes = []
  walk(tree, (node) => nodes.push(node))
  return nodes
}
const draftNodes = collect(draftOut)
const draftPicker = draftNodes.filter((node) => node.props && node.props['data-role-profile-select'] === 'true')[0]
const draftUse = draftNodes.filter((node) => node.props && node.props['data-role-use-select'] === 'true')[0]
const draftPrompt = draftNodes.filter((node) => node.props && node.props['data-field'] === 'template')[0]
assert.ok(draftPicker !== undefined && draftUse !== undefined && draftPrompt !== undefined)
// While a draft is open both selectors show the draft's SOURCE profile.
assert.equal(draftPicker.props.value, 'worker')
assert.equal(draftUse.props.value, 'worker')
const promptKeyBefore = draftPrompt.props.key
const notices = []
draftState.notice = null
draftPicker.props.onChange({ target: { value: 'worker' } })
assert.equal(draftState.selected, 'worker', 'a refused pick never changes the edited profile')
assert.equal(draftState.draft.name, 'worker-fork', 'the draft stays open after a refused pick')
assert.equal(draftState.notice.payload.code, 'role-unsaved', 'the refusal is reported as role-unsaved')
notices.push(draftState.notice)
draftState.notice = null
draftUse.props.onChange({ target: { value: 'worker' } })
assert.equal(draftState.notice.payload.code, 'role-unsaved', 'the current-use switch refuses the same way')
assert.equal(draftState.selected, 'worker')
// The draft controls keep their identity (no remount => typed text is kept).
const draftOutAgain = draftEditor({ t: (key) => key, snapshot: snapshot, store: {}, instances: [], bump: () => {} })
const promptAgain = collect(draftOutAgain).filter((node) => node.props && node.props['data-field'] === 'template')[0]
assert.equal(promptAgain.props.key, promptKeyBefore, 'a refused switch does not remount the prompt textarea')
const pickerAgain = collect(draftOutAgain).filter((node) => node.props && node.props['data-role-profile-select'] === 'true')[0]
assert.equal(pickerAgain.props.value, 'worker', 'the controlled picker still shows the real value')

console.log('PASS  RolesEditor renders the single stage rail, profile picker and three-column editor (A direction)')
