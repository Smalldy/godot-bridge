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

const skeleton = Column({
  group: { key: 'running', label: 'Running', tasks: [] },
  allTasks: [],
  t: t,
  now: 1000,
  selectedId: null,
  onOpen: () => {},
  onVerdict: () => {},
  onToggle: () => {},
  skeleton: true,
})
assert.equal(skeleton.props['data-loading'], 'true')
assert.equal(JSON.stringify(skeleton).includes('data-card-skeleton'), true)
assert.equal(JSON.stringify(skeleton).includes('noTasks'), false)

// T-194: 已取消 is a terminal rail like 阻塞 — an empty cancelled lane narrows
// instead of stretching, while an empty active lane keeps its full share.
function emptyLane(key) {
  return Column({
    group: { key: key, label: key, tasks: [] },
    allTasks: [],
    t: t,
    now: 1000,
    selectedId: null,
    onOpen: () => {},
    onVerdict: () => {},
    onToggle: () => {},
  })
}
const emptyCancelled = emptyLane('cancelled')
assert.equal(emptyCancelled.props['data-empty'], 'true', 'an empty cancelled lane narrows like blocked')
const emptyBlocked = emptyLane('blocked')
assert.equal(emptyBlocked.props['data-empty'], 'true', 'an empty blocked lane still narrows')
const emptyRunning = emptyLane('running')
assert.equal(emptyRunning.props['data-empty'], 'false', 'an empty active lane keeps its full share')
const cancelledWithCard = Column({
  group: { key: 'cancelled', label: 'cancelledCol', tasks: [{ id: 'T-30' }] },
  allTasks: [{ id: 'T-30' }],
  t: t,
  now: 1000,
  selectedId: null,
  onOpen: () => {},
  onVerdict: () => {},
  onToggle: () => {},
})
assert.equal(cancelledWithCard.props['data-empty'], 'false', 'a populated cancelled lane takes its full share')
assert.equal(JSON.stringify(cancelledWithCard).includes('T-30'), true, 'the terminal card is rendered, not hidden')

console.log('PASS  Column is an independently testable view module')
