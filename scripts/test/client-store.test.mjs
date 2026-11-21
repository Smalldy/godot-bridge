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
assert.equal(fetched[0], '/state?light=1', 'the board poll asks for the LIGHT first paint')
assert.equal(store.getSnapshot().project, '/p')
assert.equal(store.getSnapshot().source, 'host')
assert.equal(store.getSnapshot().metadata.status, 'idle', 'a Host without the split is never asked for /meta')

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
// ── T-211: loadDecisions is single-flight, times out and recovers ──────────
{
  let calls = 0
  let release = null
  globalThis.fetch = () => {
    calls += 1
    return new Promise((resolve) => {
      release = () => resolve({ json: async () => ({ ok: true, decisions: [{ id: 'DEC-LATE', status: 'pending' }] }) })
    })
  }
  const first = store.loadDecisions({ timeoutMs: 40 })
  const second = store.loadDecisions({ timeoutMs: 40 })
  assert.equal(calls, 1, 'two surfaces share ONE in-flight decisionList request')
  const timedOut = await first
  const timedOutAgain = await second
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.timedOut, true, 'a hung request resolves as timedOut instead of wedging the queue')
  assert.equal(timedOutAgain.timedOut, true)
  assert.equal(store.getSnapshot().decisions.some((entry) => entry.id === 'DEC-LATE'), false, 'the late response must not land after the timeout')
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(store.getSnapshot().decisions.some((entry) => entry.id === 'DEC-LATE'), false, 'a response that lost the timeout race is ignored')
  // The guard was released in finally: the next poll is a fresh request.
  globalThis.fetch = async () => {
    calls += 1
    return { json: async () => ({ ok: true, decisions: [{ id: 'DEC-NEXT', status: 'pending' }], counts: { pending: 1 } }) }
  }
  const recovered = await store.loadDecisions()
  assert.equal(recovered.ok, true, 'the next poll recovers without waiting for the hung request')
  assert.equal(calls, 2)
  assert.deepEqual(store.getSnapshot().decisions.map((entry) => entry.id), ['DEC-NEXT'])
  // A transport failure also leaves the guard clean and the queue usable.
  let failures = 0
  globalThis.fetch = async () => {
    failures += 1
    if (failures === 1) throw new Error('offline')
    return { json: async () => ({ ok: true, decisions: [], counts: {} }) }
  }
  const failed = await store.loadDecisions()
  assert.equal(failed.ok, false)
  const retried = await store.loadDecisions()
  assert.equal(retried.ok, true, 'a failed poll is retried on the next tick')
  assert.equal(failures, 2)
  assert.equal(store.DECISION_LOAD_TIMEOUT_MS, 15000, 'the production timeout is bounded')
}
console.log('PASS  T-211 loadDecisions is single-flight, times out and recovers with a clean guard')

// ── T-211: the store reports whether the shell overlay really mounted ──────
{
  assert.equal(store.decisionOverlayAvailable(), false, 'a missing shell.overlay slot never marks itself mounted')
  store.markDecisionOverlayMounted()
  assert.equal(store.decisionOverlayAvailable(), true)
}
console.log('PASS  T-211 the panel header can tell whether the shell overlay mounted')

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

// ── T-210: the deferred metadata never blocks the board or the header ──────
// A split Host answers `light=1` /state with the board + the light session
// scope and advertises the /meta split. The store merges the deferred blocks
// when /meta lands, and DEGRADES them (never the board) when it fails.
{
  const routes = new Map()
  let requests = []
  globalThis.fetch = async (url) => {
    const key = String(url).split('?')[0]
    requests.push(String(url))
    const handler = routes.get(key)
    if (handler === undefined) throw new Error('unexpected request: ' + String(url))
    return { json: async () => (typeof handler === 'function' ? handler(String(url)) : handler) }
  }
  const lightState = (extra) =>
    Object.assign(
      {
        ok: true,
        full: true,
        project: '/repo',
        projectRoot: '/repo',
        resolvedFrom: 'session',
        sessionProject: '/repo',
        counts: { total: 2 },
        tasks: [{ id: 'T-1', status: 'pending', title: 'card' }, { id: 'T-2', status: 'done', title: 'done card' }],
        scope: { boardProject: { id: 'repo', root: '/repo' }, panelSession: 'session-test', sessionSummaries: [{ sessionId: 'session-test', status: 'live' }], currentSessionProject: '/repo', light: true },
        agentTree: { available: false, root: null, members: [], count: 0, error: 'deferred' },
        worktrees: { available: false, error: 'deferred', total: null, active: null, counts: null, worktrees: [] },
        metadata: { split: true, light: true, deferred: ['agentTree', 'worktrees'] },
      },
      extra === undefined ? {} : extra,
    )
  const fullMeta = {
    ok: true,
    project: '/repo',
    cache: 'hit',
    meta: {
      scope: { boardProject: { id: 'repo', root: '/repo' }, panelSession: 'session-test', sessionSummaries: [{ sessionId: 'session-test', status: 'live', cards: { owned: 1, active: 0 } }], currentSessionProject: '/repo', light: false, handoff: { required: false, eligibility: { takeover: { ok: false } } } },
      agentTree: { available: true, root: { id: 'session-test', name: 'lead' }, members: [], count: 0, error: null },
      worktrees: { available: true, error: null, total: 1, active: 0, counts: { main: 1 }, worktrees: [{ path: '/repo', type: 'main' }] },
      environment: { clean: true },
      roles: { version: 1 },
      archivedCount: 3,
      activityEvents: { available: true, source: 'board', cursor: '2024-01-01T00:00:00.000Z|T-1@x', count: 1, entries: [{ key: 'T-1@x', at: '2024-01-01T00:00:00.000Z', kind: 'dispatch', taskId: 'T-1' }] },
      decisionPolicy: { version: 1 },
    },
    errors: {},
    metadata: { split: true, deferred: [] },
  }
  routes.set('/state', lightState())
  routes.set('/meta', fullMeta)
  const splitStore = createTaskStore((key) => key, deps)
  await splitStore.load()
  assert.equal(requests[0], '/state?light=1', 'one light request paints the board')
  assert.equal(requests[1].indexOf('/meta'), 0, 'the deferred metadata is its OWN request: ' + requests[1])
  // The board and the header base are already there while /meta is still out.
  assert.equal(splitStore.getSnapshot().source, 'host', 'the board does not wait for the metadata')
  assert.equal(splitStore.getSnapshot().tasks.length, 2, 'the cards are rendered')
  assert.equal(splitStore.getSnapshot().scope.sessionSummaries.length, 1, 'the light scope carries the header sessions')
  assert.equal(splitStore.getSnapshot().metadata.status, 'loading', 'the deferred metadata is reported as loading, not as missing')
  assert.equal(splitStore.getSnapshot().agentTree.error, 'deferred', 'the agent tree is still deferred before /meta lands')
  const metaResult = await splitStore.loadMeta()
  assert.equal(metaResult.ok, true, 'the deferred metadata lands')
  const merged = splitStore.getSnapshot()
  assert.equal(merged.metadata.status, 'ready')
  assert.equal(merged.agentTree.available, true, 'the agent tree is merged from /meta')
  assert.equal(merged.worktrees.total, 1, 'the worktree inventory is merged from /meta')
  assert.equal(merged.environment.clean, true, 'the environment reading is merged from /meta')
  assert.equal(merged.roles.version, 1, 'the role config is merged from /meta')
  assert.equal(merged.archivedCount, 3, 'the archive count is merged from /meta')
  assert.equal(merged.activityEvents.entries.length, 1, 'the activity timeline is merged from /meta')
  assert.equal(merged.scope.light, false, 'the FULL scope replaces the light one')
  assert.equal(merged.scope.handoff.eligibility.takeover.ok, false, 'the full scope carries takeover eligibility')
  assert.equal(merged.metadata.errors !== undefined, true)
  console.log('PASS  T-210 the deferred metadata loads on its own and merges onto the board')

  // A FAILED /meta degrades the deferred blocks ONLY: the board, the header
  // base and the 'ready' state stay exactly as they were.
  routes.set('/meta', { ok: false, code: 'failed', message: 'inventory unavailable' })
  requests = []
  await splitStore.load()
  await splitStore.loadMeta()
  const degraded = splitStore.getSnapshot()
  assert.equal(degraded.source, 'host', 'a metadata failure is not a board failure')
  assert.equal(degraded.message, '', 'a metadata failure never raises the board banner')
  assert.equal(degraded.tasks.length, 2, 'the cards survive a metadata failure')
  assert.equal(degraded.metadata.status, 'degraded')
  assert.equal(degraded.metadata.errors.message, 'inventory unavailable')
  assert.equal(degraded.agentTree.available, true, 'the last good metadata is kept on failure')

  // A metadata TRANSPORT failure is the same: degraded, board intact.
  routes.set('/meta', () => {
    throw new Error('connect ECONNREFUSED')
  })
  await splitStore.load()
  await splitStore.loadMeta()
  assert.equal(splitStore.getSnapshot().source, 'host')
  assert.equal(splitStore.getSnapshot().tasks.length, 2)
  assert.equal(splitStore.getSnapshot().metadata.status, 'degraded')
  assert.ok(splitStore.getSnapshot().metadata.errors.message.indexOf('ECONNREFUSED') >= 0)
  console.log('PASS  T-210 a failed metadata request degrades only the deferred blocks')

  // The activity cursor rides /meta (not /state), so the timeline stays incremental.
  routes.set('/meta', fullMeta)
  await splitStore.load()
  const lastUrl = requests[requests.length - 1]
  assert.ok(lastUrl.indexOf('/meta') === 0 && lastUrl.indexOf('activitySince=') > 0, 'the activity cursor rides /meta: ' + lastUrl)
  console.log('PASS  T-210 the activity timeline stays incremental on its own endpoint')
}

// ── T-210 review: a project switch must never paint the old project's metadata ──
// openProject answers with the NEW project's light board while the pin (and the
// store's cached metadata) still describe the old one. The deferred blocks must
// belong to the project on screen, and the NEW project's /meta must be requested.
{
  const routes = new Map()
  const requests = []
  globalThis.fetch = async (url) => {
    const text = String(url)
    const key = text.split('?')[0]
    requests.push(text)
    const handler = routes.get(key)
    if (handler === undefined) throw new Error('unexpected request: ' + text)
    return { json: async () => (typeof handler === 'function' ? handler(text) : handler) }
  }
  const light = (project) => ({
    ok: true,
    full: true,
    project: project,
    projectRoot: project,
    resolvedFrom: 'session',
    sessionProject: project,
    counts: { total: 1 },
    tasks: [{ id: 'T-1', status: 'running', title: 'card of ' + project }],
    scope: { boardProject: { id: project, root: project }, panelSession: 'session-test', sessionSummaries: [{ sessionId: 'session-test', status: 'live' }], currentSessionProject: project, light: true },
    agentTree: { available: false, root: null, members: [], count: 0, error: 'deferred' },
    worktrees: { available: false, error: 'deferred', total: null, active: null, counts: null, worktrees: [] },
    metadata: { split: true, light: true, deferred: ['agentTree', 'worktrees'] },
  })
  const metaFor = (project, agent) => ({
    ok: true,
    project: project,
    cache: 'hit',
    meta: {
      scope: { boardProject: { id: project, root: project }, panelSession: 'session-test', sessionSummaries: [], currentSessionProject: project, light: false },
      agentTree: { available: true, root: { id: 'session-test', name: agent }, members: [], count: 0, error: null },
      worktrees: { available: true, error: null, total: 0, active: 0, counts: {}, worktrees: [] },
      environment: { clean: true, project: project },
      roles: { version: 1 },
      archivedCount: 0,
      activityEvents: { available: true, source: 'board', cursor: project + '|c', count: 0, entries: [] },
      decisionPolicy: { version: 1 },
    },
    errors: {},
    metadata: { split: true, deferred: [] },
  })
  function projectOf(url) {
    const match = /[?&]project=([^&]+)/.exec(url)
    return match === null ? null : decodeURIComponent(match[1])
  }
  routes.set('/state', () => light('/repo-a'))
  routes.set('/meta', (url) => {
    const project = projectOf(url)
    return metaFor(project === null ? '/repo-a' : project, project === '/repo-b' ? 'agent-b' : 'agent-a')
  })
  routes.set('/action', () => ({ ok: true, snapshot: light('/repo-b') }))
  const switchStore = createTaskStore((key) => key, deps)
  await switchStore.load()
  await switchStore.loadMeta()
  assert.equal(switchStore.getSnapshot().agentTree.root.name, 'agent-a', 'the first project metadata lands')
  assert.equal(switchStore.getSnapshot().environment.project, '/repo-a')

  const switched = await switchStore.switchProject('/repo-b')
  assert.equal(switched.ok, true)
  const during = switchStore.getSnapshot()
  assert.equal(during.project, '/repo-b', 'the switch shows the new project')
  assert.ok(
    during.agentTree === undefined || during.agentTree === null || during.agentTree.root === null || during.agentTree.root.name !== 'agent-a',
    'project A\'s agent tree is never painted onto project B: ' + JSON.stringify(during.agentTree),
  )
  assert.equal(during.environment === null || during.environment === undefined, true, 'project A\'s environment is never painted onto project B')
  const metaCalls = requests.filter((url) => url.indexOf('/meta') === 0)
  assert.ok(
    metaCalls.some((url) => projectOf(url) === '/repo-b'),
    'the NEW project metadata is requested after the switch: ' + JSON.stringify(metaCalls),
  )
  assert.equal(
    metaCalls.filter((url) => projectOf(url) === '/repo-a').length,
    1,
    'the old project metadata is never re-requested by the switch: ' + JSON.stringify(metaCalls),
  )
  await switchStore.loadMeta()
  const settled = switchStore.getSnapshot()
  assert.equal(settled.agentTree.root.name, 'agent-b', 'the new project\'s agent tree lands')
  assert.equal(settled.environment.project, '/repo-b')
  assert.equal(settled.metadata.status, 'ready')
  assert.equal(JSON.stringify(settled.agentTree).indexOf('agent-a') < 0, true, 'no project A data survives the switch')
  console.log('PASS  T-210 review: a project switch loads the NEW project metadata and never re-paints the old one')

  // An ACTION forces the deferred metadata to be rebuilt (no pre-action 10 s cache).
  requests.length = 0
  routes.set('/action', () => ({ ok: true, snapshot: light('/repo-b') }))
  await switchStore.send('pause', {})
  const afterAction = requests.filter((url) => url.indexOf('/meta') === 0)
  assert.ok(afterAction.length >= 1, 'an action refreshes the deferred metadata')
  assert.ok(afterAction[afterAction.length - 1].indexOf('refresh=1') > 0, 'the action refresh bypasses the host cache: ' + afterAction[afterAction.length - 1])

  // The panel's explicit refresh does the same through load({ refresh: true }).
  requests.length = 0
  await switchStore.load({ refresh: true })
  const afterRefresh = requests.filter((url) => url.indexOf('/meta') === 0)
  assert.ok(afterRefresh.length >= 1 && afterRefresh[afterRefresh.length - 1].indexOf('refresh=1') > 0, 'the explicit refresh forces a rebuild: ' + JSON.stringify(afterRefresh))
  console.log('PASS  T-210 review: action and explicit refresh force a fresh metadata build')
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
