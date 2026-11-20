import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskCard } = require('../../client/src/views/task-card.cjs')
const { agentSessionOf } = require('../../client/src/views/agent-sidebar.cjs')

const React = {
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
}
function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const selectors = {
  tcBaseName: (value) => String(value).split('/').pop(),
  tcIsInvestigation: (task) => task.kind === 'investigate',
  tcKindOf: (task) => (task.kind === 'investigate' ? 'investigate' : 'dev'),
  tcLease: () => null,
  tcMergeLabel: () => 'merge',
  tcMergeOf: () => null,
  tcMergeTone: () => 'running',
  tcPhaseLabel: () => 'Running',
  tcPhaseTone: () => 'running',
  tcReviewLabel: () => 'review',
  tcReviewOf: () => null,
  tcReviewTone: () => 'waiting',
  tcRound: () => 1,
  tcStageQueued: () => false,
  tcTestLabel: () => 'test',
  tcTestOf: () => null,
  tcTestTone: () => 'waiting',
}
const TaskCard = createTaskCard(Object.assign({ React, h, toneForDependency: () => 'waiting', waitingChip: () => null }, selectors))
const t = (key) => key
const card = TaskCard({
  task: { id: 'T-1', title: 'Fix the thing', status: 'running', priority: 0, attempts: 0, maxAttempts: 3, dependsOn: [], writeFiles: [], leaseUntil: null },
  t: t,
  now: 1000,
  selected: false,
  onOpen: () => {},
  onVerdict: () => {},
})
assert.equal(card.type, 'article')
assert.equal(card.props.className, 'gbt-card')
const text = JSON.stringify(card)
assert.ok(text.includes('T-1'))
assert.ok(text.includes('Fix the thing'))
assert.ok(text.includes('Running'))

const investigation = TaskCard({
  task: { id: 'T-2', title: 'Investigate', kind: 'investigate', status: 'running', priority: 0, attempts: 0, maxAttempts: 3, dependsOn: [], writeFiles: [], leaseUntil: null },
  t: t,
  now: 1000,
  selected: false,
  onOpen: () => {},
  onVerdict: () => {},
})
const investigationText = JSON.stringify(investigation)
assert.ok(investigationText.includes('kindInvestigate'))

// T-194: a cancelled card is terminal, not "blocked". Its state row must name
// the cancelled state (neutral tertiary) and never borrow the red blocked one.
// Blocked cards keep their own red blocked state.
function cardOf(task) {
  return TaskCard({
    task: Object.assign({ priority: 0, attempts: 0, maxAttempts: 3, dependsOn: [], writeFiles: [], leaseUntil: null }, task),
    t: t,
    now: 1000,
    selected: false,
    onOpen: () => {},
    onVerdict: () => {},
  })
}
const cancelledText = JSON.stringify(cardOf({ id: 'T-3', title: 'Dropped plan', status: 'cancelled' }))
assert.ok(cancelledText.includes('"data-state":"cancelled"'), 'a cancelled card carries the cancelled state')
assert.ok(cancelledText.includes('stateCancelled'), 'the cancelled card names the cancelled state label')
assert.ok(!cancelledText.includes('"data-state":"blocked"'), 'a cancelled card never renders the blocked state')
assert.ok(!cancelledText.includes('stateBlocked'), 'a cancelled card never renders the blocked label')
const blockedText = JSON.stringify(cardOf({ id: 'T-4', title: 'Stuck card', status: 'blocked' }))
assert.ok(blockedText.includes('"data-state":"blocked"'), 'a blocked card keeps its blocked state')
assert.ok(blockedText.includes('stateBlocked'), 'a blocked card keeps the blocked label')
assert.ok(!blockedText.includes('stateCancelled'), 'a blocked card is never labelled cancelled')

// T-209: the card's "open in sidebar" entry.
const sidebarLabels = { openInSidebar: '在侧边栏打开', openInSidebarHint: '在右侧栏打开这个任务的 Agent' }
const sidebarT = (key) => (sidebarLabels[key] === undefined ? key : sidebarLabels[key])
const opened = []
const withSidebar = createTaskCard(Object.assign({ React, h, toneForDependency: () => 'waiting', waitingChip: () => null }, selectors, {
  agentSidebar: {
    sessionOf: agentSessionOf,
    available: () => true,
    open: (sessionId) => { opened.push(sessionId); return true },
    label: (key) => (sidebarLabels[key] === undefined ? key : sidebarLabels[key]),
  },
}))
const agentTask = {
  id: 'T-9',
  title: 'Open the agent',
  status: 'running',
  priority: 0,
  attempts: 0,
  maxAttempts: 3,
  dependsOn: [],
  writeFiles: [],
  leaseUntil: null,
  assignee: { name: 'worker-t-9', session: 'session-t9' },
  ownerSession: 'session-owner',
  updatedAt: '2026-11-08T00:00:00Z',
}
function renderCard(Card, task) {
  return Card({ task: task, t: sidebarT, now: 1000, selected: false, onOpen: () => {}, onVerdict: () => {} })
}
function findEntry(node) {
  if (node === null || node === undefined) return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findEntry(item)
      if (hit !== null) return hit
    }
    return null
  }
  if (typeof node !== 'object') return null
  if (node.props !== undefined && node.props['data-action'] === 'open-agent-sidebar') return node
  return findEntry(node.props === undefined ? undefined : node.props.children)
}

const cardWithEntry = renderCard(withSidebar, agentTask)
const entryText = JSON.stringify(cardWithEntry)
assert.ok(entryText.includes('open-agent-sidebar'), 'a card with a real session renders the sidebar entry')
assert.ok(entryText.includes('在侧边栏打开'), 'the entry carries the localized label')
assert.ok(entryText.includes('session-t9'), 'the entry targets the REAL executor session')
const entry = findEntry(cardWithEntry)
assert.ok(entry !== null, 'the entry is a button')
assert.equal(entry.type, 'button')
let stopped = 0
entry.props.onClick({ stopPropagation: () => { stopped += 1 } })
assert.deepEqual(opened, ['session-t9'], 'clicking opens the agent tab for that session')
assert.equal(stopped, 1, 'the card must not also open its detail drawer')

const anonymous = renderCard(withSidebar, Object.assign({}, agentTask, { id: 'T-10', assignee: null, ownerSession: null }))
assert.equal(JSON.stringify(anonymous).includes('open-agent-sidebar'), false, 'a card without a session hides the entry')

const withoutService = createTaskCard(Object.assign({ React, h, toneForDependency: () => 'waiting', waitingChip: () => null }, selectors, {
  agentSidebar: { sessionOf: agentSessionOf, available: () => false, open: () => { throw new Error('must not be called') } },
}))
const hidden = renderCard(withoutService, agentTask)
assert.equal(JSON.stringify(hidden).includes('open-agent-sidebar'), false, 'a shell without the sidebar hides the entry')
assert.equal(JSON.stringify(renderCard(TaskCard, agentTask)).includes('open-agent-sidebar'), false, 'no sidebar dep keeps the card unchanged')

console.log('PASS  TaskCard is an independently testable view module')
