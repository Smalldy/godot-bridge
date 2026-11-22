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
// T-231: the read actions are the ONE read contract per action, so this fake
// seam pins what each one delegates to:
//   board   boardPage(project, {limit,cursor}) by default; the snapshot for
//           view:'full' (the explicit diagnostic escape hatch)
//   list    taskList(project, query) — literally the /list handler
const pageCalls = []
const listCalls = []
const readActions = createReadActions({
  snapshot: async (project, options) => ({ ok: true, project: project, sessionId: options.sessionId }),
  readBoardOrFail: async () => ({ board: board }),
  state: state,
  locks: locks,
  model: model,
  archivedTask: async (project, id) => (id === 'OLD' ? { id: 'OLD', status: 'done' } : null),
  detailOf: (source, task) => ({ id: task.id, detail: true }),
  candidateOf: () => true,
  boardSummaryOf: () => {
    throw new Error('T-231: list must ask /list (taskList), not build its own page')
  },
  taskList: async (project, query) => {
    listCalls.push({ project: project, query: query })
    return { ok: true, tasks: [{ id: 'T-1', status: 'pending' }], nextCursor: null, count: 1 }
  },
  boardPage: async (project, options) => {
    pageCalls.push({ project: project, options: options })
    return { ok: true, view: 'summary', project: project, tasks: [{ id: 'T-1' }], counts: model.counts(board) }
  },
  callerSessionId: () => 'session-1',
  ok: (payload) => Object.assign({ ok: true }, payload),
  failure: (code, message) => ({ ok: false, code: code, message: message }),
})

// board: a summary PAGE by default (limit/cursor forwarded, no detail snapshot).
const boardResult = await readActions.board({ limit: 7, cursor: '0|T-0' }, {}, '/project')
assert.equal(boardResult.ok, true)
assert.equal(boardResult.view, 'summary')
assert.equal(pageCalls.length, 1)
assert.equal(pageCalls[0].project, '/project')
assert.deepEqual(pageCalls[0].options, { limit: 7, cursor: '0|T-0' })

// board: view:'full' is the explicit escape hatch back to the diagnostic snapshot.
const boardFull = await readActions.board({ view: 'full' }, {}, '/project')
assert.equal(boardFull.ok, true)
assert.equal(boardFull.sessionId, 'session-1')
assert.equal(pageCalls.length, 1, 'view:full must not build a summary page')

// list: the /list handler, with q/cursor/limit/archived forwarded verbatim.
const listResult = await readActions.list({ status: 'pending', limit: 5, cursor: 'c1', q: 'two', archived: true }, {}, '/project', 1000)
assert.deepEqual(listResult.tasks, [{ id: 'T-1', status: 'pending' }])
assert.equal(listResult.count, 1)
assert.equal(listCalls.length, 1, 'list delegates to the /list handler')
assert.equal(listCalls[0].project, '/project')
assert.equal(listCalls[0].query.status, 'pending')
assert.equal(listCalls[0].query.limit, 5)
assert.equal(listCalls[0].query.cursor, 'c1')
assert.equal(listCalls[0].query.q, 'two')
assert.equal(listCalls[0].query.archived, true)

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
