import assert from 'node:assert/strict'
import { createLifecycleActions } from '../../plugin/task-center/actions/lifecycle.mjs'

const task = { id: 'T-1', status: 'running', kind: 'dev' }
const board = { tasks: [task] }
const state = { memory: { locks: [] } }
const events = { interrupted: [], cleaned: [] }
const model = {
  findTask: (source, id) => source.tasks.filter((candidate) => candidate.id === id)[0],
  cancelTask: () => ({ ok: true, board: board, task: task, events: ['cancel'] }),
  reopenTask: () => ({ ok: true, board: board, task: task, events: ['reopen'] }),
  unblockTask: () => ({ ok: true, board: board, task: task, events: ['unblock'] }),
  retryTask: () => ({ ok: true, board: board, task: task, events: ['retry'] }),
  blockTask: () => ({ ok: true, board: board, task: task, events: ['block'] }),
}
const actions = createLifecycleActions({
  readBoardOrFail: async () => ({ board: board }),
  model: model,
  writeTask: async (project, id, mutator) => mutator(board),
  clock: () => 1000,
  writeByName: () => 'user',
  state: state,
  ctx: {},
  interruptAssignee: async (ctx, prior, options) => {
    events.interrupted.push({ id: prior.id, reason: options.reason })
  },
  cleanupInvestigation: async (project, prior) => {
    events.cleaned.push(prior.id)
  },
  failure: (code, message) => ({ ok: false, code: code, message: message }),
})

const cancelled = await actions.cancel({ id: 'T-1' }, { by: 'user' }, '/project')
assert.equal(cancelled.ok, true)
assert.deepEqual(events.interrupted, [{ id: 'T-1', reason: 'cancelled' }])
assert.deepEqual(events.cleaned, ['T-1'])

assert.equal((await actions.reopen({ id: 'T-1' }, { by: 'user' }, '/project')).ok, true)
assert.equal((await actions.unblock({ id: 'T-1' }, { by: 'user' }, '/project')).ok, true)
assert.equal((await actions.retry({ id: 'T-1' }, { by: 'user' }, '/project')).ok, true)
assert.equal((await actions.block({ id: 'T-1' }, { by: 'user' }, '/project')).ok, true)
assert.equal((await actions.cancel({}, { by: 'user' }, '/project')).code, 'missing-id')
assert.equal((await actions.reopen({}, { by: 'user' }, '/project')).code, 'missing-id')

console.log('PASS  lifecycle actions preserve cancel/block cleanup and transition routing')
