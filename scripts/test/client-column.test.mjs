import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createColumn } = require('../../client/src/views/column.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const TaskCard = (props) => ({ type: 'task-card', props: props })
const Column = createColumn({ h, TaskCard })
const t = (key) => key
const group = { key: 'running', label: 'Running', tasks: [{ id: 'T-1' }] }
const out = Column({
  group: group,
  allTasks: group.tasks,
  t: t,
  now: 1000,
  selectedId: null,
  onOpen: () => {},
  onVerdict: () => {},
  onToggle: () => {},
})
assert.equal(out.type, 'section')
assert.equal(out.props['data-group'], 'running')
assert.equal(out.props['data-collapsed'], 'false')
const text = JSON.stringify(out)
assert.ok(text.includes('T-1'))
assert.ok(text.includes('noTasks') === false)

const collapsed = Column({
  group: group,
  allTasks: group.tasks,
  t: t,
  now: 1000,
  selectedId: null,
  onOpen: () => {},
  onVerdict: () => {},
  onToggle: () => {},
  collapsed: true,
})
assert.equal(collapsed.props['data-collapsed'], 'true')
assert.equal(JSON.stringify(collapsed).includes('T-1'), false)

console.log('PASS  Column is an independently testable view module')
