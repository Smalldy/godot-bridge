import assert from 'node:assert/strict'
import { createReadActions } from '../../plugin/task-center/actions/read.mjs'

const board = {
  tasks: [
    { id: 'T-1', status: 'pending', title: 'one' },
    { id: 'T-2', status: 'done', title: 'two' },
  ],
}
const state = { memory: { locks: [] }, sweepLocks() { this.swept = true } }
const model = {
  summary: (source, task) => ({ id: task.id, status: task.status }),
  counts: () => ({ pending: 1, done: 1 }),
  findTask: (source, id) => source.tasks.filter((task) => task.id === id)[0],
}
const locks = { view: () => [{ taskId: 'T-1', path: 'a.js' }] }
// T-230: list asks the API's read model for its page — ONE builder for /state,
// /list and the tool list. The fake here IS the seam: it must receive the
// project, the board, the clock and the FILTERED rows.
const summaryCalls = []
const readActions = createReadActions({
  snapshot: async (project, options) => ({ ok: true, project: project, sessionId: options.sessionId }),
  readBoardOrFail: async () => ({ board: board }),
  state: state,
  locks: locks,
  model: model,
  archivedTask: async (project, id) => (id === 'OLD' ? { id: 'OLD', status: 'done' } : null),
  detailOf: (source, task) => ({ id: task.id, detail: true }),
  candidateOf: () => true,
  boardSummaryOf: (project, source, now, rows) => {
    summaryCalls.push({ project: project, now: now, ids: rows.map((task) => task.id) })
    return { counts: model.counts(source), tasks: rows.map((task) => model.summary(source, task)) }
  },
  callerSessionId: () => 'session-1',
  ok: (payload) => Object.assign({ ok: true }, payload),
  failure: (code, message) => ({ ok: false, code: code, message: message }),
})

const boardResult = await readActions.board({}, {}, '/project')
assert.equal(boardResult.ok, true)
assert.equal(boardResult.sessionId, 'session-1')

const listResult = await readActions.list({ status: 'pending' }, {}, '/project', 1000)
assert.deepEqual(listResult.tasks, [{ id: 'T-1', status: 'pending' }])
assert.deepEqual(listResult.counts, { pending: 1, done: 1 })
assert.equal(summaryCalls.length, 1, 'list projects its page through the shared read model')
assert.equal(summaryCalls[0].project, '/project')
assert.equal(summaryCalls[0].now, 1000)
assert.deepEqual(summaryCalls[0].ids, ['T-1'], 'the status filter happens BEFORE the read model projects the page')

const getResult = await readActions.get({ id: 'T-1' }, {}, '/project', 1000)
assert.equal(getResult.task.candidate, true)
assert.equal(getResult.locks.length, 1)

const archived = await readActions.get({ id: 'OLD' }, {}, '/project', 1000)
assert.equal(archived.task.id, 'OLD')
assert.deepEqual(archived.locks, [])

const missing = await readActions.get({ id: 'NOPE' }, {}, '/project', 1000)
assert.equal(missing.code, 'unknown-task')

const lockResult = await readActions.locks({}, {}, '/project', 1000)
assert.equal(lockResult.ok, true)
assert.equal(state.swept, true)
assert.equal(lockResult.locks[0].taskId, 'T-1')

console.log('PASS  read actions preserve board/list/get/locks semantics')
