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

console.log('PASS  TaskCard is an independently testable view module')
