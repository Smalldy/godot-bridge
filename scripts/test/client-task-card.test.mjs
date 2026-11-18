import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskCard } = require('../../client/src/views/task-card.cjs')

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

console.log('PASS  TaskCard is an independently testable view module')
