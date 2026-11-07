import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskForm } = require('../../client/src/views/task-form.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const Modal = (props) => ({ type: 'modal', props: props })
const TaskForm = createTaskForm({
  React: { useRef: () => ({ current: null }), useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] },
  h: h,
  Modal: Modal,
  tcParseList: (value) => String(value).split(',').map((part) => part.trim()).filter(Boolean),
  tcParseFiles: (value) => String(value).split('\n').map((part) => part.trim()).filter(Boolean),
  tcErrorMessage: () => 'error',
  store: { send: async () => ({ ok: true }) },
})
const out = TaskForm({ t: (key) => key, task: null, snapshot: { tasks: [] }, onClose: () => {}, onSaved: () => {} })
assert.equal(out.type, Modal)
const text = JSON.stringify(out)
assert.ok(text.includes('taskTitle'))
assert.ok(text.includes('acceptance'))
assert.ok(text.includes('targetBranch'))
assert.ok(text.includes('create'))

console.log('PASS  TaskForm is an independently testable view module')
