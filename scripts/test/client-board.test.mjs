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
// T-194: the board ends with the 已取消 terminal lane after 阻塞.
const LANE_KEYS = ['dispatch', 'running', 'reviewing', 'testing', 'done', 'blocked', 'cancelled']
const tasks = [
  { id: 'T-1', status: 'pending', dependency: { state: 'ready' } },
  { id: 'T-2', status: 'running' },
  { id: 'T-3', status: 'done' },
]
const out = Board({ snapshot: { tasks: tasks, counts: { done: 1 } }, t: t, now: 1000, kind: 'all', selectedId: null, onOpen: () => {}, onVerdict: () => {}, onKindFilterChange: () => {}, onOpenDoneAll: () => {}, onColumnToggle: () => {} })
// T-159: the lanes are always emitted, even when five of them are empty, so
// the wide board can distribute the full width instead of leaving a gap.
const sparse = Board({ snapshot: { tasks: [{ id: 'T-9', status: 'running' }], counts: { done: 0 } }, t: t, now: 1000, kind: 'all', selectedId: null, onOpen: () => {}, onVerdict: () => {}, onKindFilterChange: () => {}, onOpenDoneAll: () => {}, onColumnToggle: () => {} })
const sparseLanes = sparse.props.children.props.children
assert.deepEqual(sparseLanes.map((lane) => lane.props.group.key), LANE_KEYS, 'all seven lanes survive an empty board')
assert.deepEqual(sparseLanes[0].props.subcounts, { ready: 0, waiting: 0 }, 'the dispatch rail still carries both counts')
assert.equal(sparseLanes[4].props.summary, null, 'an empty done lane has no archive summary')
assert.equal(sparseLanes[1].props.collapsed, false, 'an active lane is not collapsed just because it is empty')
assert.equal(sparseLanes[6].props.group.label, 'cancelledCol', 'the terminal lane is labelled through the dedicated cancelledCol key')
// T-160: the same lanes and order are what the narrow media query stacks.
assert.equal(out.props.children.props.className, 'gbt-board', 'the board keeps its own scrollport class')
assert.equal(sparseLanes.length, 7, 'narrow stacking never drops a lane')
assert.equal(out.type, 'div')
assert.equal(out.props.className, 'gbt-boardwrap')
assert.equal(out.props['data-board-kind'], 'all')
const text = JSON.stringify(out)
// T-158: the kind filter moved to the panel toolbar (it is not part of the board).
assert.ok(!text.includes('gbt-kindfilter'), 'the toolbar owns the kind filter')
const lanes = out.props.children.props.children
assert.deepEqual(lanes.map((lane) => lane.props.group.key), LANE_KEYS)
const dispatchLane = lanes[0].props
assert.deepEqual(dispatchLane.subcounts, { ready: 1, waiting: 0 }, 'the dispatch lane carries both counts')
assert.deepEqual(dispatchLane.group.tasks.map((task) => task.id), ['T-1'], 'pending cards share the dispatch lane')
assert.equal(lanes[4].props.summary !== undefined && lanes[4].props.summary !== null, true, 'the done lane carries the archive summary')
assert.ok(text.includes('T-1') && text.includes('T-2') && text.includes('T-3'))
assert.equal(boardUiState.kind, 'all')

// Stable shell: a known project keeps the lanes mounted while loading; the
// lane bodies carry skeletons instead of being replaced by an empty board.
const loading = Board({ snapshot: { tasks: [], counts: {} }, loading: true, t: t, now: 1000, kind: 'all', selectedId: null, onOpen: () => {}, onVerdict: () => {}, onKindFilterChange: () => {}, onOpenDoneAll: () => {}, onColumnToggle: () => {} })
const loadingLanes = loading.props.children.props.children
assert.equal(loadingLanes.length, 7, 'the seven lanes stay mounted while loading')
assert.equal(loadingLanes.every((lane) => lane.props.skeleton === true), true, 'every lane renders skeleton cards while loading')
assert.equal(JSON.stringify(loading).includes('gbt-empty'), false, 'loading does not render the empty-board state')

// T-194: cancelled is a terminal state, not a variety of "blocked". The 阻塞 lane
// holds only genuinely blocked cards; cancelled cards stay VISIBLE in their own
// terminal lane after it (data is never dropped).
const mixed = Board({
  snapshot: {
    tasks: [
      { id: 'T-21', status: 'blocked', updatedAt: 3000 },
      { id: 'T-22', status: 'cancelled', updatedAt: 2000 },
      { id: 'T-23', status: 'running', updatedAt: 1000 },
    ],
    counts: { done: 0, blocked: 1, cancelled: 1 },
  },
  t: t,
  now: 1000,
  kind: 'all',
  selectedId: null,
  onOpen: () => {},
  onVerdict: () => {},
  onKindFilterChange: () => {},
  onOpenDoneAll: () => {},
  onColumnToggle: () => {},
})
const mixedLanes = mixed.props.children.props.children
assert.deepEqual(mixedLanes.map((lane) => lane.props.group.key), LANE_KEYS, 'a cancelled card never disturbs the seven-lane structure')
assert.deepEqual(mixedLanes[5].props.group.tasks.map((task) => task.id), ['T-21'], 'only a genuinely blocked card reaches the 阻塞 lane')
assert.deepEqual(mixedLanes[6].props.group.tasks.map((task) => task.id), ['T-22'], 'a cancelled card is visible in the 已取消 lane')
assert.deepEqual(mixedLanes.slice(0, 6).filter((lane) => lane.props.group.tasks.some((task) => task.id === 'T-22')).map((lane) => lane.props.group.key), [], 'a cancelled card lands in no lane before 已取消')

// The cancelled lane keeps working when cancelled is the ONLY status on the
// board: seven lanes stay mounted and the terminal card is still visible.
const onlyCancelled = Board({
  snapshot: { tasks: [{ id: 'T-24', status: 'cancelled', updatedAt: 500 }], counts: { done: 0, blocked: 0, cancelled: 1 } },
  t: t,
  now: 1000,
  kind: 'all',
  selectedId: null,
  onOpen: () => {},
  onVerdict: () => {},
  onKindFilterChange: () => {},
  onOpenDoneAll: () => {},
  onColumnToggle: () => {},
})
const onlyCancelledLanes = onlyCancelled.props.children.props.children
assert.equal(onlyCancelledLanes.length, 7, 'an all-cancelled board keeps the seven-lane structure')
assert.deepEqual(onlyCancelledLanes[5].props.group.tasks, [], 'the 阻塞 lane stays empty when every card is cancelled')
assert.deepEqual(onlyCancelledLanes[6].props.group.tasks.map((task) => task.id), ['T-24'], 'the 已取消 lane keeps the terminal card visible')

console.log('PASS  Board is an independently testable view module (seven lanes)')
