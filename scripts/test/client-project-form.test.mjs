import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createProjectForm } = require('../../client/src/views/project-form.cjs')
function h(type, props, ...children) { return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) } }
const Modal = (props) => ({ type: 'modal', props: props })
const ProjectForm = createProjectForm({ React: { useRef: () => ({ current: null }), useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] }, h: h, Modal: Modal, projectFormState: { value: null }, store: { switchProject: async () => ({ ok: true }) }, tcErrorMessage: () => 'error' })
const out = ProjectForm({ t: (key) => key, hostProject: '/repo', project: '/repo', onClose: () => {} })
assert.equal(out.type, Modal)
const text = JSON.stringify(out)
assert.ok(text.includes('projectPlaceholder'))
assert.ok(text.includes('useCurrentProject'))
assert.ok(text.includes('openProject'))
console.log('PASS  ProjectForm is an independently testable view module')
