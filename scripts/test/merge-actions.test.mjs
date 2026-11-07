import assert from 'node:assert/strict'
import { createMergeActions } from '../../plugin/task-center/actions/merge.mjs'

const ok = (payload) => Object.assign({ ok: true }, payload)
const failure = (code, message) => ({ ok: false, code: code, message: message })
let notified = null
const board = { tasks: [{ id: 'T-1', status: 'testing', merge: { status: 'open' } }] }
const actions = createMergeActions({
  mergeRefusal: () => null,
  mergeQueueKey: async () => 'main',
  serialised: async (work) => work({ aborted: false }),
  mergeOne: async () => ({ ok: true, task: { id: 'T-1' } }),
  notifyMergeOutcome: async (project, task) => {
    notified = { project: project, id: task.id }
  },
  readBoardOrFail: async () => ({ board: board }),
  model: { findTask: (source, id) => source.tasks.filter((task) => task.id === id)[0] },
  writeTask: async (project, id, mutator) => mutator(board),
  recordMergeResult: (source, id, outcome) => ({ ok: true, board: source, task: { id: id, merge: { status: outcome.status } }, events: [] }),
  clock: () => 1000,
  writeByName: () => 'user',
  emitActivity: () => {},
  ok: ok,
  failure: failure,
})

const merged = await actions.mergeRequest({ id: 'T-1' }, { by: 'merger' }, '/project')
assert.equal(merged.ok, true)
assert.deepEqual(notified, { project: '/project', id: 'T-1' })

const rejected = await actions.rejectMerge({ id: 'T-1' }, { by: 'merger' }, '/project')
assert.equal(rejected.ok, true)
assert.equal(rejected.merge.status, 'rejected')

const missing = await actions.mergeRequest({}, { by: 'merger' }, '/project')
assert.equal(missing.code, 'missing-id')

const denied = createMergeActions({
  mergeRefusal: () => failure('not-merger', 'no'),
  mergeQueueKey: async () => 'main',
  serialised: async (work) => work({}),
  mergeOne: async () => ({ ok: true }),
  notifyMergeOutcome: async () => {},
  readBoardOrFail: async () => ({ board: board }),
  model: { findTask: () => board.tasks[0] },
  writeTask: async () => ({ ok: true }),
  recordMergeResult: () => ({ ok: true }),
  clock: () => 1000,
  writeByName: () => 'user',
  emitActivity: () => {},
  ok: ok,
  failure: failure,
})
assert.equal((await denied.mergeRequest({ id: 'T-1' }, {}, '/project')).code, 'not-merger')

console.log('PASS  merge actions preserve queue/notify/reject/refusal paths')
