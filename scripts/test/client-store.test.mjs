import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTaskStore } = require('../../client/src/store.cjs')

function snapshot(payload, source, message) {
  return {
    ok: payload.ok === true,
    project: payload.project === undefined ? null : payload.project,
    source: source,
    message: message,
    tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
    counts: payload.counts === undefined ? {} : payload.counts,
    details: {},
    seq: null,
    activityEvents: null,
    actionResult: null,
    actionError: null,
  }
}
const deps = {
  TC_STATE_URL: '/state',
  TC_WORKTREES_URL: '/worktrees',
  TC_TASK_URL: '/task',
  TC_LIST_URL: '/list',
  TC_ACTION_URL: '/action',
  tcSnapshot: snapshot,
  tcPinnedProject: () => null,
  tcMergeSnapshot: (previous, payload) => Object.assign({}, previous, payload, { source: 'host' }),
  tcErrorMessage: (payload, t) => 'error:' + t('x'),
  tcWithSession: (url) => url,
  tcSessionId: () => 'session-test',
  tcPinProject: () => {},
}

let fetched = []
const store = createTaskStore((key) => key, deps)
assert.equal(store.getSnapshot().source, 'loading')

globalThis.fetch = async (url) => {
  fetched.push(url)
  return { json: async () => ({ ok: true, full: true, project: '/p', tasks: [], counts: {} }) }
}
await store.load()
assert.equal(fetched[0], '/state')
assert.equal(store.getSnapshot().project, '/p')
assert.equal(store.getSnapshot().source, 'host')

fetched = []
globalThis.fetch = async (url) => {
  fetched.push(url)
  return { json: async () => ({ ok: true, snapshot: { ok: true, full: true, tasks: [], counts: {} } }) }
}
const sent = await store.send('create', { title: 'x' })
assert.equal(sent.ok, true)
assert.equal(fetched[0], '/action')
assert.equal(store.getSnapshot().source, 'host')

// T-196: an answer whose host action FAILED must raise the normal action banner,
// because the decision modal disappears with the answered request.
{
  globalThis.fetch = async () => ({
    json: async () => ({
      ok: true,
      decision: { id: 'DEC-1', status: 'answered' },
      applied: {
        ok: false,
        executed: false,
        code: 'running',
        action: 'delete',
        message: 'Decision DEC-1 answered, but T-1 started running; cancel it first. Nothing was deleted.',
      },
      snapshot: { ok: true, full: true, tasks: [], counts: {} },
    }),
  })
  const answered = await store.send('decisionAnswer', { decisionId: 'DEC-1', option: 'delete' })
  assert.equal(answered.ok, true, 'the answer itself landed')
  assert.equal(store.getSnapshot().message.indexOf('started running') >= 0, true, 'the failure reaches the banner')
  assert.equal(store.getSnapshot().actionError.code, 'running')
  // An intentional 取消创建 is not a failure.
  globalThis.fetch = async () => ({
    json: async () => ({
      ok: true,
      applied: { ok: false, executed: false, code: 'decision-rejected', action: 'create', message: 'decision-rejected: the user cancelled the create request' },
      snapshot: { ok: true, full: true, tasks: [], counts: {} },
    }),
  })
  await store.send('decisionAnswer', { decisionId: 'DEC-2', option: 'cancel' })
  assert.equal(store.getSnapshot().message, '', 'an intentional rejection is not an error banner')
}

const poll = globalThis.setInterval
let polls = 0
globalThis.setInterval = (fn, ms) => {
  polls++
  return 1
}
store.startPolling(1000)
store.stopPolling()
assert.equal(polls, 1)
globalThis.setInterval = poll

console.log('PASS  the Host-backed store is an independently testable module')
