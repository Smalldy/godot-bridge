import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createBoard } = require('../../client/src/views/board.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const TaskCard = (props) => ({ type: 'task-card', props: props })
const Column = (props) => ({ type: 'column', props: props })
const boardUiState = { kind: 'all' }
const Board = createBoard({
  React: { useRef: () => ({ current: null }), useEffect: () => {} },
  h: h,
  TaskCard: TaskCard,
  Column: Column,
  tcTime: () => 0,
  tcKindOf: (task) => (task.kind === 'investigate' ? 'investigate' : 'dev'),
  tcFirstNonEmptyColumn: () => 'dispatch',
  tcColumnCollapsed: () => false,
  tcWriteColumnCollapsed: () => {},
  DONE_COLUMN_PREVIEW: 5,
  boardUiState: boardUiState,
})
const t = (key) => key
const tasks = [
  { id: 'T-1', status: 'pending', dependency: { state: 'ready' } },
  { id: 'T-2', status: 'running' },
  { id: 'T-3', status: 'done' },
]
const out = Board({ snapshot: { tasks: tasks, counts: { done: 1 } }, t: t, now: 1000, kind: 'all', selectedId: null, onOpen: () => {}, onVerdict: () => {}, onKindFilterChange: () => {}, onOpenDoneAll: () => {}, onColumnToggle: () => {} })
// T-159: the six lanes are always emitted, even when five of them are empty, so
// the wide board can distribute the full width instead of leaving a gap.
const sparse = Board({ snapshot: { tasks: [{ id: 'T-9', status: 'running' }], counts: { done: 0 } }, t: t, now: 1000, kind: 'all', selectedId: null, onOpen: () => {}, onVerdict: () => {}, onKindFilterChange: () => {}, onOpenDoneAll: () => {}, onColumnToggle: () => {} })
const sparseLanes = sparse.props.children.props.children
assert.deepEqual(sparseLanes.map((lane) => lane.props.group.key), ['dispatch', 'running', 'reviewing', 'testing', 'done', 'blocked'], 'all six lanes survive an empty board')
assert.deepEqual(sparseLanes[0].props.subcounts, { ready: 0, waiting: 0 }, 'the dispatch rail still carries both counts')
assert.equal(sparseLanes[4].props.summary, null, 'an empty done lane has no archive summary')
assert.equal(sparseLanes[1].props.collapsed, false, 'an active lane is not collapsed just because it is empty')
assert.equal(out.type, 'div')
assert.equal(out.props.className, 'gbt-boardwrap')
assert.equal(out.props['data-board-kind'], 'all')
const text = JSON.stringify(out)
// T-158: the kind filter moved to the panel toolbar (it is not part of the board).
assert.ok(!text.includes('gbt-kindfilter'), 'the toolbar owns the kind filter')
const lanes = out.props.children.props.children
assert.deepEqual(lanes.map((lane) => lane.props.group.key), ['dispatch', 'running', 'reviewing', 'testing', 'done', 'blocked'])
const dispatchLane = lanes[0].props
assert.deepEqual(dispatchLane.subcounts, { ready: 1, waiting: 0 }, 'the dispatch lane carries both counts')
assert.deepEqual(dispatchLane.group.tasks.map((task) => task.id), ['T-1'], 'pending cards share the dispatch lane')
assert.equal(lanes[4].props.summary !== undefined && lanes[4].props.summary !== null, true, 'the done lane carries the archive summary')
assert.ok(text.includes('T-1') && text.includes('T-2') && text.includes('T-3'))
assert.equal(boardUiState.kind, 'all')

console.log('PASS  Board is an independently testable view module (six lanes)')
