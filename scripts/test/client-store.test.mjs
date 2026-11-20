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

// ── T-208: the conversation overlay polls ONLY the decision queue ───────────
{
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url: url, body: JSON.parse(options.body) })
    return { json: async () => ({ ok: true, decisions: [{ id: 'DEC-1', status: 'pending', remainingMs: 9000 }], counts: { pending: 1 } }) }
  }
  const boardBefore = store.getSnapshot().tasks.length
  const projectBefore = store.getSnapshot().project
  const loaded = await store.loadDecisions()
  assert.equal(loaded.ok, true)
  assert.equal(requests.length, 1, 'one lightweight request')
  assert.equal(requests[0].url, '/action')
  assert.equal(requests[0].body.action, 'decisionList', 'the poll asks only for decisions')
  assert.equal(requests[0].body.decisionStatus, 'pending')
  assert.equal(store.getSnapshot().decisions.length, 1, 'the queue lands on the shared snapshot')
  assert.equal(store.getSnapshot().decisions[0].id, 'DEC-1')
  assert.ok(Number.isFinite(store.getSnapshot().receivedAt), 'the receipt time feeds the countdown')
  assert.equal(store.getSnapshot().tasks.length, boardBefore, 'the board is untouched')
  assert.equal(store.getSnapshot().project, projectBefore, 'the project is untouched')
  assert.equal(store.getSnapshot().busy, null, 'a background poll never takes the action busy channel')
}
console.log('PASS  loadDecisions polls only the pending queue and leaves the board snapshot alone')

// ── T-208: one decision answer, never two ───────────────────────────────────
{
  // Seed a queue the way the panel's /state poll would.
  globalThis.fetch = async () => ({
    json: async () => ({
      ok: true,
      full: true,
      project: '/p',
      tasks: [],
      counts: {},
      decisions: [{ id: 'DEC-9', status: 'pending' }, { id: 'DEC-10', status: 'pending' }],
    }),
  })
  await store.load()
  assert.deepEqual(store.getSnapshot().decisions.map((entry) => entry.id), ['DEC-9', 'DEC-10'])

  let posts = 0
  let release = null
  globalThis.fetch = () => {
    posts += 1
    return new Promise((resolve) => {
      release = () => resolve({ json: async () => ({ ok: true, decision: { id: 'DEC-9' }, applied: null }) })
    })
  }
  const first = store.send('decisionAnswer', { decisionId: 'DEC-9', option: 'go' })
  const second = await store.send('decisionAnswer', { decisionId: 'DEC-9', option: 'go' })
  assert.equal(second.ok, false)
  assert.equal(second.duplicate, true, 'the second surface is told it is a duplicate')
  assert.equal(posts, 1, 'the second surface never reaches the network')
  release()
  const landed = await first
  assert.equal(landed.ok, true)
  assert.deepEqual(store.getSnapshot().decisions.map((entry) => entry.id), ['DEC-10'], 'the answered request leaves the queue at once')
  assert.equal(store.getSnapshot().busy, null, 'the answer releases the busy channel')
  const third = await store.send('decisionAnswer', { decisionId: 'DEC-9', option: 'go' })
  assert.equal(third.duplicate, true, 'an answered id is refused even after the response')
  assert.equal(posts, 1, 'still exactly one POST')

  // A transport failure must NOT burn the id: the user can retry.
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('offline')
    return { json: async () => ({ ok: true, decision: { id: 'DEC-11' }, applied: null }) }
  }
  const failed = await store.send('decisionAnswer', { decisionId: 'DEC-11', option: 'go' })
  assert.equal(failed.ok, false)
  const retried = await store.send('decisionAnswer', { decisionId: 'DEC-11', option: 'go' })
  assert.equal(retried.ok, true, 'a failed answer is retryable')
  assert.equal(attempts, 2)
}
console.log('PASS  one shared store serializes decision answers (panel modal + shell overlay)')

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
