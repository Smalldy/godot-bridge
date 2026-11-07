import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createQueueViews } = require('../../client/src/views/queue.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const views = createQueueViews({ h: h })
const t = (key) => key
const queue = [{ id: 'T-1', title: 'Queued', priority: 0, dependsOn: [], writeFiles: [] }]
const waiting = [{ id: 'T-2', title: 'Waiting', status: 'pending', dependency: { state: 'waiting', waitingOn: ['T-1'] } }]
const out = views.QueueView({
  snapshot: { queue: queue, tasks: queue.concat(waiting) },
  t: t,
  onOpen: () => {},
})
assert.equal(out.type, 'div')
const text = JSON.stringify(out)
assert.ok(text.includes('T-1'))
assert.ok(text.includes('T-2'))
assert.ok(text.includes('waitingOn'))

const empty = views.QueueView({ snapshot: { queue: [], tasks: [] }, t: t, onOpen: () => {} })
assert.ok(JSON.stringify(empty).includes('emptyQueue'))

console.log('PASS  QueueView is an independently testable view module')
