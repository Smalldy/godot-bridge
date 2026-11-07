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
  tcFirstNonEmptyColumn: () => 'running',
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
const out = Board({ snapshot: { tasks: tasks, counts: { done: 1 } }, t: t, now: 1000, selectedId: null, onOpen: () => {}, onVerdict: () => {}, onKindFilterChange: () => {}, onOpenDoneAll: () => {}, onColumnToggle: () => {} })
assert.equal(out.type, 'div')
assert.equal(out.props.className, 'gbt-boardwrap')
assert.equal(out.props['data-board-kind'], 'all')
const text = JSON.stringify(out)
assert.ok(text.includes('gbt-kindfilter'))
assert.ok(text.includes('T-1'))
assert.equal(boardUiState.kind, 'all')

console.log('PASS  Board is an independently testable view module')
