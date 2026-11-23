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
  // T-235: the panel's /state answer only BOOTSTRAPS the decisions domain, so a
  // queue that already exists is not reseeded by the board poll. Seed through the
  // decisions domain itself (what the shared cadence does).
  globalThis.fetch = async () => ({
    json: async () => ({
      ok: true,
      decisions: [{ id: 'DEC-9', status: 'pending' }, { id: 'DEC-10', status: 'pending' }],
      counts: { pending: 2 },
    }),
  })
  await store.loadDecisions()
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

  // T-233: the meta domain answers a duplicate request from its own cache inside
  // the 10 s window instead of asking the Host again, and a routine board poll
  // never drags /meta along.
  routes.set('/meta', { ok: false, code: 'failed', message: 'inventory unavailable' })
  requests = []
  await splitStore.load()
  const cachedMeta = await splitStore.loadMeta()
  assert.equal(cachedMeta.cached, true, 'a /meta answered moments ago is answered from the domain')
  assert.equal(requests.filter((url) => url.indexOf('/meta') === 0).length, 0, 'the board poll does not request /meta: ' + JSON.stringify(requests))
  assert.equal(splitStore.getSnapshot().metadata.status, 'ready', 'the cached metadata still reads ready')

  // A FORCED refresh asks the Host again. A FAILED /meta degrades the deferred
  // blocks ONLY: the board, the header base and the 'ready' state stay as they were.
  await splitStore.loadMeta({ refresh: true })
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
  await splitStore.loadMeta({ refresh: true })
  assert.equal(splitStore.getSnapshot().source, 'host')
  assert.equal(splitStore.getSnapshot().tasks.length, 2)
  assert.equal(splitStore.getSnapshot().metadata.status, 'degraded')
  assert.ok(splitStore.getSnapshot().metadata.errors.message.indexOf('ECONNREFUSED') >= 0)
  console.log('PASS  T-210 a failed metadata request degrades only the deferred blocks')

  // The activity cursor rides /meta (not /state), so the timeline stays incremental.
  routes.set('/meta', fullMeta)
  requests = []
  await splitStore.loadMeta({ refresh: true })
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

// ── T-233: board / meta / detail are separate query-cache domains ───────────
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
{
  const calls = []
  const lightAnswer = (project, tasks) => ({
    ok: true,
    full: true,
    project: project,
    projectRoot: project,
    resolvedFrom: 'session',
    sessionProject: project,
    counts: { total: tasks.length },
    tasks: tasks,
    metadata: { split: true, light: true, deferred: [] },
  })
  const metaAnswer = (project) => ({
    ok: true,
    project: project,
    meta: { scope: { light: false }, agentTree: { available: true, root: { id: 'session-test', name: 'lead of ' + project }, members: [], count: 0, error: null } },
    errors: {},
    metadata: { split: true, deferred: [] },
  })
  globalThis.fetch = async (url) => {
    const text = String(url)
    calls.push(text)
    if (text.indexOf('/state') === 0) return { json: async () => lightAnswer('/repo', [{ id: 'T-1', status: 'pending', title: 'card', updatedAt: 'v1' }]) }
    if (text.indexOf('/meta') === 0) {
      const match = /[?&]project=([^&]+)/.exec(text)
      return { json: async () => metaAnswer(match === null ? '/repo' : decodeURIComponent(match[1])) }
    }
    throw new Error('unexpected request: ' + text)
  }
  const domainStore = createTaskStore((key) => key, deps)
  await domainStore.load()
  const metaLanded = await domainStore.loadMeta()
  assert.equal(metaLanded.ok, true, 'the first paint asks for the deferred metadata')
  const boardState = domainStore.domains.board.state()
  const metaState = domainStore.domains.meta.state()
  assert.equal(boardState.status, 'ready')
  assert.equal(boardState.data.tasks[0].id, 'T-1')
  assert.ok(boardState.receivedAt > 0, 'the board domain records its receipt time')
  assert.ok(boardState.generation >= 1, 'the board domain owns a request generation')
  assert.equal(boardState.lastGood, boardState.data, 'the last good answer is the shown one')
  assert.equal(metaState.scope, '/repo', 'the meta domain names the project it describes')
  assert.equal(metaState.status, 'ready')
  assert.equal(metaState.data.agentTree.root.name, 'lead of /repo')
  assert.equal(metaState.staleTime, 10000, 'the meta domain carries the 10 s staleTime')
  assert.equal(domainStore.META_STALE_MS, 10000)
  const compatibility = domainStore.getSnapshot()
  for (const field of ['ok', 'source', 'message', 'project', 'projectRoot', 'tasks', 'counts', 'details', 'seq', 'activityEvents', 'actionResult', 'actionError', 'metadata', 'decisions', 'decisionPolicy', 'receivedAt', 'busy']) {
    assert.ok(Object.prototype.hasOwnProperty.call(compatibility, field), 'the compatibility snapshot keeps ' + field)
  }
  assert.equal(compatibility.domains, undefined, 'the facade never leaks the raw domains into the view shape')
  assert.equal(compatibility.source, 'host')
  assert.equal(compatibility.metadata.status, 'ready')
  assert.equal(compatibility.agentTree.root.name, 'lead of /repo', 'the meta domain is projected into the old shape')
  assert.equal(compatibility.scope.light, false)
  console.log('PASS  T-233 board/meta/detail are separate domains behind one compatible snapshot')
}

// ── T-233: the board poll is single-flight ──────────────────────────────────
{
  let calls = 0
  let release = null
  globalThis.fetch = (url) => {
    const text = String(url)
    if (text.indexOf('/state') === 0) {
      calls += 1
      return new Promise((resolve) => {
        release = () => resolve({ json: async () => ({ ok: true, full: true, project: '/repo', counts: { total: 1 }, tasks: [{ id: 'T-1', status: 'pending', title: 'first', updatedAt: 'v1' }] }) })
      })
    }
    throw new Error('unexpected request: ' + text)
  }
  const singleStore = createTaskStore((key) => key, deps)
  const first = singleStore.load()
  const second = singleStore.load()
  assert.equal(calls, 1, 'two surface polls share ONE in-flight board request')
  release()
  await first
  await second
  assert.equal(singleStore.getSnapshot().tasks[0].title, 'first')
  console.log('PASS  T-233 the 2.5 s board poll is single-flight')
}

// ── T-233: an action invalidates the board; an older answer cannot land ─────
{
  const stateResolvers = []
  const answer = (project, title) => ({ ok: true, full: true, project: project, projectRoot: project, counts: { total: 1 }, tasks: [{ id: 'T-1', status: 'pending', title: title, updatedAt: 'v1' }] })
  globalThis.fetch = (url) => {
    const text = String(url)
    if (text.indexOf('/state') === 0) {
      return new Promise((resolve) => {
        stateResolvers.push((project, title) => resolve({ json: async () => answer(project, title) }))
      })
    }
    if (text.indexOf('/action') === 0) {
      return { json: async () => ({ ok: true, seq: 9, changed: ['board'], affected: { ids: ['T-1'], count: 1 } }) }
    }
    throw new Error('unexpected request: ' + text)
  }
  const invalidationStore = createTaskStore((key) => key, deps)
  const initial = invalidationStore.load()
  stateResolvers[0]('/repo', 'before')
  await initial
  assert.equal(invalidationStore.getSnapshot().tasks[0].title, 'before')

  // A poll is in flight when the write invalidates the board domain.
  const slowPoll = invalidationStore.load()
  assert.equal(stateResolvers.length, 2)
  await invalidationStore.send('pause', {})
  assert.equal(stateResolvers.length, 3, 'the write re-reads the invalidated board once')
  // The post-action answer lands first; the PRE-action answer arrives later and
  // must be discarded instead of repainting the old board.
  stateResolvers[2]('/repo', 'after')
  await tick()
  stateResolvers[1]('/repo', 'stale-before')
  await slowPoll
  await tick()
  assert.equal(invalidationStore.getSnapshot().tasks[0].title, 'after', 'an older board generation never overwrites the newer one')
  console.log('PASS  T-233 an action invalidates the board domain and an older answer cannot land')
}

// ── T-233: a failed board poll keeps the last good board ────────────────────
{
  let failing = false
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.indexOf('/state') === 0) {
      if (failing) return { json: async () => ({ ok: false, code: 'failed', message: 'board read failed' }) }
      return { json: async () => ({ ok: true, full: true, project: '/repo', projectRoot: '/repo', counts: { total: 2 }, tasks: [{ id: 'T-1', status: 'pending', title: 'a', updatedAt: 'v1' }, { id: 'T-2', status: 'done', title: 'b', updatedAt: 'v1' }] }) }
    }
    throw new Error('unexpected request: ' + text)
  }
  const failedStore = createTaskStore((key) => key, deps)
  await failedStore.load()
  assert.equal(failedStore.getSnapshot().tasks.length, 2)
  failing = true
  await failedStore.load()
  const afterFailure = failedStore.getSnapshot()
  assert.equal(afterFailure.source, 'error', 'the failed poll is still reported')
  assert.equal(afterFailure.message, 'error:x', 'the store uses the host error text (this fixture maps codes to error:x)')
  assert.equal(afterFailure.tasks.length, 2, 'a failed poll never blanks the last good board')
  assert.equal(failedStore.domains.board.state().status, 'error')
  assert.equal(failedStore.domains.board.state().lastGood.tasks.length, 2, 'the domain keeps its last good answer')
  failing = false
  await failedStore.load()
  assert.equal(failedStore.getSnapshot().source, 'host', 'the next good answer clears the error state')
  assert.equal(failedStore.getSnapshot().message, '')

  // A TRANSPORT failure behaves the same: error state, last good tasks intact.
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED')
  }
  await failedStore.load()
  assert.equal(failedStore.getSnapshot().source, 'error')
  assert.equal(failedStore.getSnapshot().tasks.length, 2, 'a transport failure keeps the last good tasks too')
  assert.ok(failedStore.getSnapshot().message.indexOf('ECONNREFUSED') >= 0)
  console.log('PASS  T-233 a failed board poll keeps the last good tasks and the next good answer clears it')
}

// ── T-233: the meta domain has a 10 s staleTime and ignores the board poll ──
{
  let now = 1000000
  const metaRequests = []
  const metaPayload = { ok: true, project: '/repo', meta: { agentTree: { available: true, root: { id: 's', name: 'lead' }, members: [], count: 0, error: null } }, errors: {}, metadata: { split: true, deferred: [] } }
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.indexOf('/state') === 0) return { json: async () => ({ ok: true, full: true, project: '/repo', projectRoot: '/repo', counts: { total: 0 }, tasks: [], metadata: { split: true, light: true, deferred: [] } }) }
    if (text.indexOf('/meta') === 0) {
      metaRequests.push(text)
      return { json: async () => metaPayload }
    }
    throw new Error('unexpected request: ' + text)
  }
  const timedDeps = Object.assign({}, deps, { tcNow: () => now })
  const timedStore = createTaskStore((key) => key, timedDeps)
  assert.equal(timedStore.META_STALE_MS, 10000)
  await timedStore.load()
  await timedStore.loadMeta()
  assert.equal(metaRequests.length, 1, 'the first paint asks for /meta exactly once')
  await timedStore.load()
  await timedStore.load()
  await timedStore.load()
  assert.equal(metaRequests.length, 1, 'routine board polls never request /meta again')
  const cached = await timedStore.loadMeta()
  assert.equal(cached.cached, true, 'a /meta younger than 10 s is answered by the meta domain')
  now += 4000
  const stillCached = await timedStore.loadMeta()
  assert.equal(stillCached.cached, true)
  assert.equal(metaRequests.length, 1, 'inside the 10 s window no second request is made')
  now += 7000
  const stale = await timedStore.loadMeta()
  assert.equal(stale.ok, true)
  assert.equal(metaRequests.length, 2, 'past the 10 s staleTime a loadMeta() asks the host again')
  assert.equal(timedStore.getSnapshot().metadata.status, 'ready')
  console.log('PASS  T-233 the meta domain has a 10 s staleTime and is never dragged by the board poll')
}

// ── T-233: a DEGRADED meta is not retried by the board poll ────────────────
{
  const metaRequests = []
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.indexOf('/state') === 0) return { json: async () => ({ ok: true, full: true, project: '/repo', projectRoot: '/repo', counts: { total: 0 }, tasks: [], metadata: { split: true, light: true, deferred: [] } }) }
    if (text.indexOf('/meta') === 0) {
      metaRequests.push(text)
      return { json: async () => ({ ok: false, code: 'failed', message: 'inventory unavailable' }) }
    }
    throw new Error('unexpected request: ' + text)
  }
  const failingMetaStore = createTaskStore((key) => key, deps)
  await failingMetaStore.load()
  await tick()
  assert.equal(metaRequests.length, 1, 'the first paint tried /meta once')
  assert.equal(failingMetaStore.getSnapshot().metadata.status, 'degraded')
  assert.equal(failingMetaStore.getSnapshot().source, 'host', 'a meta failure is not a board failure')
  await failingMetaStore.load()
  await failingMetaStore.load()
  await tick()
  assert.equal(metaRequests.length, 1, 'a degraded meta is not retried on every 2.5 s poll')
  await failingMetaStore.loadMeta({ refresh: true })
  assert.equal(metaRequests.length, 2, 'an explicit refresh retries the degraded metadata')
  console.log('PASS  T-233 a degraded meta is not retried by the board poll')
}

// ── T-233 review: a PINNED first paint still asks for /meta exactly once ───
// The panel is reloaded with a project already pinned, so the FIRST /state
// answer names the SAME project the pin names. The meta domain starts unscoped:
// load()'s project-change branch never runs, and the first paint must still ask
// for the deferred half (agentTree/worktrees/environment/roles/activity), while
// the routine 2.5 s polls must not ask again.
{
  const requests = []
  let pinned = '/repo'
  const pinnedDeps = Object.assign({}, deps, {
    tcPinnedProject: function () { return pinned },
    tcPinProject: function (value) { pinned = typeof value === 'string' && value !== '' ? value : null },
  })
  globalThis.fetch = async (url) => {
    const text = String(url)
    requests.push(text)
    if (text.indexOf('/state') === 0) return { json: async () => ({ ok: true, full: true, project: '/repo', projectRoot: '/repo', resolvedFrom: 'panel', counts: { total: 0 }, tasks: [], metadata: { split: true, light: true, deferred: [] } }) }
    if (text.indexOf('/meta') === 0) return { json: async () => ({ ok: true, project: '/repo', meta: { scope: { light: false }, agentTree: { available: true, root: { id: 's', name: 'lead' }, members: [], count: 0, error: null }, roles: { version: 1 } }, errors: {}, metadata: { split: true, deferred: [] } }) }
    throw new Error('unexpected request: ' + text)
  }
  const pinnedStore = createTaskStore((key) => key, pinnedDeps)
  await pinnedStore.load()
  await pinnedStore.loadMeta()
  const metaCalls = requests.filter((url) => url.indexOf('/meta') === 0)
  assert.equal(metaCalls.length, 1, 'a pinned first paint asks for /meta once: ' + JSON.stringify(requests))
  assert.equal(metaCalls[0].indexOf('project=%2Frepo') > 0 || metaCalls[0].indexOf('project=/repo') > 0, true, 'the request names the pinned project: ' + metaCalls[0])
  assert.equal(pinnedStore.domains.meta.state().scope, '/repo', 'the first paint seeds the meta scope')
  assert.equal(pinnedStore.getSnapshot().metadata.status, 'ready')
  assert.equal(pinnedStore.getSnapshot().agentTree.root.name, 'lead')
  assert.equal(pinnedStore.getSnapshot().roles.version, 1)
  for (let index = 0; index < 3; index += 1) await pinnedStore.load()
  assert.equal(requests.filter((url) => url.indexOf('/meta') === 0).length, 1, 'routine polls still request no /meta: ' + JSON.stringify(requests))
  console.log('PASS  T-233 review: a pinned first paint asks for /meta exactly once')
}

// ── T-233: the detail domain caches per card and refreshes on updatedAt ────
{
  const taskRequests = []
  let boardVersion = 'v1'
  let taskFailing = false
  globalThis.fetch = async (url) => {
    const text = String(url)
    if (text.indexOf('/state') === 0) return { json: async () => ({ ok: true, full: true, project: '/repo', projectRoot: '/repo', counts: { total: 1 }, tasks: [{ id: 'T-1', status: 'pending', title: 'card', updatedAt: boardVersion }], metadata: { split: true, light: true, deferred: [] } }) }
    if (text.indexOf('/meta') === 0) return { json: async () => ({ ok: true, project: '/repo', meta: { agentTree: { available: true, root: { id: 's', name: 'lead' }, members: [], count: 0, error: null } }, errors: {}, metadata: { split: true, deferred: [] } }) }
    if (text.indexOf('/task') === 0) {
      taskRequests.push(text)
      if (taskFailing) return { json: async () => ({ ok: false, code: 'failed', message: 'detail read failed' }) }
      return { json: async () => ({ ok: true, task: { id: 'T-1', title: 'card', spec: 'full ' + boardVersion, updatedAt: boardVersion } }) }
    }
    throw new Error('unexpected request: ' + text)
  }
  const detailStore = createTaskStore((key) => key, deps)
  await detailStore.load()
  await detailStore.loadMeta()
  await detailStore.loadDetail('T-1')
  assert.equal(taskRequests.length, 1, 'opening the card reads /task once')
  assert.equal(detailStore.getSnapshot().details['T-1'].task.spec, 'full v1')
  await detailStore.loadDetail('T-1')
  assert.equal(taskRequests.length, 1, 'an unchanged card is answered from the detail domain')

  // The card changes: the summary updatedAt is the cache key.
  boardVersion = 'v2'
  await detailStore.load()
  await detailStore.loadDetail('T-1')
  assert.equal(taskRequests.length, 2, 'a changed card refreshes its detail')
  assert.equal(detailStore.getSnapshot().details['T-1'].task.spec, 'full v2')

  // A failed /task keeps the last good detail instead of blanking the card.
  boardVersion = 'v3'
  taskFailing = true
  await detailStore.load()
  await detailStore.loadDetail('T-1')
  assert.equal(detailStore.domains.detail.stateOf('T-1').status, 'error')
  assert.equal(detailStore.domains.detail.stateOf('T-1').lastGood.task.spec, 'full v2', 'the last good detail survives a failed read')
  assert.equal(detailStore.getSnapshot().details['T-1'], undefined, 'a detail read for an older card version is not shown over the newer summary')

  // Reopening retries the failed card even though its updatedAt did not move again.
  taskFailing = false
  await detailStore.loadDetail('T-1')
  assert.equal(detailStore.getSnapshot().details['T-1'].task.spec, 'full v3')
  console.log('PASS  T-233 the detail domain caches per card, refreshes on updatedAt and keeps last-good')
}

// ── T-233: a write invalidates exactly the domains it says changed ─────────
{
  const stateRequests = []
  const metaRequests = []
  const actionRequests = []
  globalThis.fetch = async (url, options) => {
    const text = String(url)
    if (text.indexOf('/state') === 0) {
      stateRequests.push(text)
      return { json: async () => ({ ok: true, full: true, project: '/repo', projectRoot: '/repo', counts: { total: 1 }, tasks: [{ id: 'T-1', status: 'pending', title: 'card', updatedAt: 'v2' }], metadata: { split: true, light: true, deferred: [] } }) }
    }
    if (text.indexOf('/meta') === 0) {
      metaRequests.push(text)
      return { json: async () => ({ ok: true, project: '/repo', meta: { agentTree: { available: true, root: { id: 's', name: 'lead' }, members: [], count: 0, error: null } }, errors: {}, metadata: { split: true, deferred: [] } }) }
    }
    if (text.indexOf('/task') === 0) return { json: async () => ({ ok: true, task: { id: 'T-1', title: 'card', spec: 'full', updatedAt: 'v2' } }) }
    if (text.indexOf('/action') === 0) {
      actionRequests.push(JSON.parse(options.body).action)
      return { json: async () => ({ ok: true, seq: 10, changed: ['board', 'detail', 'meta'], affected: { ids: ['T-1'], count: 1 } }) }
    }
    throw new Error('unexpected request: ' + text)
  }
  const preciseStore = createTaskStore((key) => key, deps)
  await preciseStore.load()
  await preciseStore.loadMeta()
  await preciseStore.loadDetail('T-1')
  const beforeBoard = stateRequests.length
  const beforeMeta = metaRequests.length
  await preciseStore.send('update', { id: 'T-1', title: 'renamed' })
  await tick()
  assert.equal(actionRequests[actionRequests.length - 1], 'update')
  assert.equal(stateRequests.length, beforeBoard + 1, 'a changed board is re-read once')
  assert.equal(metaRequests.length, beforeMeta + 1, 'a changed meta is refreshed once')
  assert.ok(metaRequests[metaRequests.length - 1].indexOf('refresh=1') > 0, 'the action refresh bypasses the host cache: ' + metaRequests[metaRequests.length - 1])
  assert.equal(preciseStore.domains.detail.stateOf('T-1').status, 'stale', 'the affected card detail is invalidated')
  await preciseStore.loadDetail('T-1')
  assert.equal(preciseStore.domains.detail.stateOf('T-1').status, 'ready', 'the invalidated card is re-read on the next open')
  console.log('PASS  T-233 a write invalidates exactly the domains it says changed')
}

// ── T-233: 20 project switches never paint an old board or old metadata ─────
{
  const stateResolvers = []
  const metaCalls = []
  const light = (project) => ({ ok: true, full: true, project: project, projectRoot: project, resolvedFrom: 'panel', counts: { total: 1 }, tasks: [{ id: 'T-1', status: 'pending', title: 'card of ' + project, updatedAt: 'v1' }], metadata: { split: true, light: true, deferred: [] } })
  const metaFor = (project) => ({ ok: true, project: project, meta: { scope: { light: false }, agentTree: { available: true, root: { id: 's', name: 'lead of ' + project }, members: [], count: 0, error: null } }, errors: {}, metadata: { split: true, deferred: [] } })
  function projectOf(text) {
    const match = /[?&]project=([^&]+)/.exec(text)
    return match === null ? null : decodeURIComponent(match[1])
  }
  globalThis.fetch = (url, options) => {
    const text = String(url)
    if (text.indexOf('/state') === 0) {
      return new Promise((resolve) => {
        stateResolvers.push((project) => resolve({ json: async () => light(project) }))
      })
    }
    if (text.indexOf('/meta') === 0) {
      metaCalls.push(text)
      return { json: async () => metaFor(projectOf(text)) }
    }
    if (text.indexOf('/action') === 0) {
      const body = JSON.parse(options.body)
      return { json: async () => ({ ok: true, snapshot: light(body.path) }) }
    }
    throw new Error('unexpected request: ' + text)
  }
  let pinned = null
  const pinDeps = Object.assign({}, deps, {
    tcPinnedProject: function () { return pinned },
    tcPinProject: function (value) { pinned = typeof value === 'string' && value !== '' ? value : null },
  })
  const pinStore = createTaskStore((key) => key, pinDeps)
  void pinStore.load()
  for (let index = 0; index < 20; index += 1) {
    await pinStore.switchProject('/p' + String(index))
    void pinStore.load()
  }
  // The delayed answers arrive in REVERSE order: the newest one first, then every
  // older one. Only the newest project may survive.
  for (let index = 19; index >= 0; index -= 1) {
    const resolver = stateResolvers[stateResolvers.length - 1]
    stateResolvers.pop()
    resolver('/p' + String(index))
  }
  stateResolvers.forEach((resolve) => resolve('/stale-session'))
  await tick()
  const settled = pinStore.getSnapshot()
  assert.equal(settled.project, '/p19', 'the newest switch owns the board')
  assert.ok(settled.tasks.every((task) => task.title === 'card of /p19'), 'no old board landed: ' + JSON.stringify(settled.tasks))
  assert.equal(settled.agentTree.root.name, 'lead of /p19', 'no old metadata landed: ' + JSON.stringify(settled.agentTree))
  assert.equal(JSON.stringify(settled).indexOf('/p18'), -1, 'nothing of an earlier project survives')
  assert.equal(pinStore.domains.detail.entries().length, 0)
  assert.ok(metaCalls.length >= 20, 'every switch asked for its own metadata: ' + metaCalls.length)
  console.log('PASS  T-233 20 project switches never paint an old board or old metadata')
}

// ── T-235: decisions are ONE domain with a shared server revision ───────────
//
// Before this card the queue had two independent writers (the 2.5 s /state
// sweep and the overlay's 5 s decisionList), so a slow answer could repaint a
// queue that was already newer. The decisions domain now owns it:
//   - the /state snapshot only BOOTSTRAPS it (a routine poll cannot overwrite);
//   - a list answer lands only when its decisionRevision moved forward;
//   - an answer's new revision drops exactly that request, so an older list
//     answer cannot resurrect it;
//   - a failed poll keeps the last good queue;
//   - a project switch clears it (the ids are project-scoped).
{
  const listCalls = []
  const stateAnswer = (ids, revision) => ({
    ok: true,
    full: true,
    project: '/repo',
    projectRoot: '/repo',
    counts: { total: 0 },
    tasks: [],
    decisions: ids.map((id) => ({ id: id, status: 'pending' })),
    decisionRevision: revision,
    metadata: { split: true, light: true, deferred: [] },
  })
  let statePayload = stateAnswer(['DEC-A'], 5)
  let listPayload = { ok: true, decisions: [{ id: 'DEC-A', status: 'pending' }], counts: { pending: 1 }, decisionRevision: 5 }
  const routedFetch = async (url, options) => {
    const text = String(url)
    if (text.indexOf('/state') === 0) return { json: async () => statePayload }
    if (text.indexOf('/meta') === 0) {
      return { json: async () => ({ ok: true, project: '/repo', meta: { agentTree: { available: true, root: { id: 's', name: 'lead' }, members: [], count: 0, error: null } }, errors: {}, metadata: { split: true, deferred: [] } }) }
    }
    if (text.indexOf('/action') === 0) {
      const body = JSON.parse(options.body)
      if (body.action === 'decisionList') {
        listCalls.push(body)
        return { json: async () => listPayload }
      }
      if (body.action === 'decisionAnswer') {
        // A T-231 write envelope names the new queue generation.
        return { json: async () => ({ ok: true, decision: { id: body.decisionId, status: 'answered' }, applied: null, seq: 1, affected: { ids: [], count: 0 }, changed: ['decisions'], decisionRevision: 8 }) }
      }
      if (body.action === 'openProject') {
        // The answer describes the NEW project, so the decisions domain must reset.
        const switchedSnapshot = Object.assign(stateAnswer(['DEC-B2'], 20), { project: body.path, projectRoot: body.path })
        return { json: async () => ({ ok: true, seq: 2, changed: ['board'], affected: { ids: [], count: 0 }, snapshot: switchedSnapshot }) }
      }
    }
    throw new Error('unexpected request: ' + text)
  }
  globalThis.fetch = routedFetch
  const revisionStore = createTaskStore((key) => key, deps)

  // 1) The /state answer BOOTSTRAPS the queue and records its revision.
  await revisionStore.load()
  assert.deepEqual(revisionStore.getSnapshot().decisions.map((entry) => entry.id), ['DEC-A'])
  assert.equal(revisionStore.getSnapshot().decisionRevision, 5, 'the queue names the server revision it describes')
  assert.equal(revisionStore.domains.decisions.state().status, 'ready')
  // The panel modal and the shell overlay both read this ONE projection, so the
  // two surfaces can never show different queues.
  assert.deepEqual(revisionStore.decisionsView().decisions, revisionStore.getSnapshot().decisions, 'both surfaces read the SAME decisions selector')
  assert.equal(revisionStore.decisionsView().revision, revisionStore.getSnapshot().decisionRevision, 'and the same revision')

  // 2) The panel and the shell overlay register on ONE cadence: two surfaces,
  //    ONE timer, ONE decisionList — and the last one leaving stops it.
  const timers = []
  const cleared = []
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (fn, ms) => {
    timers.push({ fn: fn, ms: ms })
    return { timer: timers.length }
  }
  globalThis.clearInterval = (handle) => { cleared.push(handle) }
  try {
    revisionStore.startDecisionsPolling()
    revisionStore.startDecisionsPolling()
    await tick()
    assert.equal(listCalls.length, 1, 'the panel and the shell overlay share ONE decisionList on mount')
    assert.equal(timers.length, 1, 'two surfaces share ONE cadence timer')
    assert.equal(timers[0].ms, revisionStore.DECISION_POLL_MS, 'the shared cadence is the T-235 one')
    assert.equal(revisionStore.DECISION_POLL_MS, 5000)
    revisionStore.stopDecisionsPolling()
    assert.equal(cleared.length, 0, 'one surface leaving keeps the cadence for the other')
    revisionStore.stopDecisionsPolling()
    assert.equal(cleared.length, 1, 'the LAST surface leaving stops the cadence')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }

  // 3) A routine /state answer NEVER overwrites the domain — not even one that
  //    claims a newer revision. Only the first answer bootstraps the queue.
  statePayload = stateAnswer(['DEC-OLD'], 9)
  await revisionStore.load()
  assert.deepEqual(revisionStore.getSnapshot().decisions.map((entry) => entry.id), ['DEC-A'], 'a routine /state answer cannot repaint the queue')
  assert.equal(revisionStore.getSnapshot().decisionRevision, 5, 'and it cannot move the revision either')

  // 4) A NEWER decisionList revision lands.
  listPayload = { ok: true, decisions: [{ id: 'DEC-B', status: 'pending' }], counts: { pending: 1 }, decisionRevision: 6 }
  const newer = await revisionStore.loadDecisions()
  assert.equal(newer.ok, true)
  assert.deepEqual(revisionStore.getSnapshot().decisions.map((entry) => entry.id), ['DEC-B'])
  assert.equal(revisionStore.getSnapshot().decisionRevision, 6)

  // 5) An OLDER (or equal) revision is discarded instead of overwriting it.
  listPayload = { ok: true, decisions: [{ id: 'DEC-A', status: 'pending' }], counts: { pending: 1 }, decisionRevision: 5 }
  const stale = await revisionStore.loadDecisions()
  assert.equal(stale.ok, false)
  assert.equal(stale.stale, true, 'an older revision never overwrites a newer queue')
  assert.deepEqual(revisionStore.getSnapshot().decisions.map((entry) => entry.id), ['DEC-B'])
  listPayload = { ok: true, decisions: [{ id: 'DEC-A', status: 'pending' }], counts: { pending: 1 }, decisionRevision: 6 }
  await revisionStore.loadDecisions()
  assert.deepEqual(revisionStore.getSnapshot().decisions.map((entry) => entry.id), ['DEC-B'], 'an equal revision describes the queue already on screen')

  // 6) An answer applies its NEW revision and drops exactly that request; it
  //    does NOT re-read the whole queue.
  const listsBefore = listCalls.length
  const answered = await revisionStore.send('decisionAnswer', { decisionId: 'DEC-B', option: 'go' })
  assert.equal(answered.ok, true)
  assert.deepEqual(revisionStore.getSnapshot().decisions, [], 'the answered request left the shared queue')
  assert.equal(revisionStore.getSnapshot().decisionRevision, 8, 'the answer carries the new revision')
  assert.equal(listCalls.length, listsBefore, 'the answer invalidates by revision instead of refreshing the whole queue')

  // 7) A list answer that STARTED before the answer carries the older revision
  //    and must not resurrect the answered request.
  listPayload = { ok: true, decisions: [{ id: 'DEC-B', status: 'pending' }], counts: { pending: 1 }, decisionRevision: 7 }
  const resurrect = await revisionStore.loadDecisions()
  assert.equal(resurrect.stale, true)
  assert.deepEqual(revisionStore.getSnapshot().decisions, [])

  // 8) A failed list keeps the last good queue and reports it degraded.
  listPayload = { ok: true, decisions: [{ id: 'DEC-C', status: 'pending' }], counts: { pending: 1 }, decisionRevision: 9 }
  await revisionStore.loadDecisions()
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED')
  }
  const failed = await revisionStore.loadDecisions()
  assert.equal(failed.ok, false)
  assert.deepEqual(revisionStore.getSnapshot().decisions.map((entry) => entry.id), ['DEC-C'], 'a failed poll never blanks the queue')
  assert.equal(revisionStore.domains.decisions.state().status, 'degraded')
  assert.equal(revisionStore.domains.decisions.state().lastGood.length, 1, 'the domain keeps its last good queue')
  globalThis.fetch = routedFetch

  // 9) A project switch clears the old project's queue: the NEW snapshot seeds
  //    the domain with its own revision instead of the old ids surviving.
  const switched = await revisionStore.switchProject('/repo-b')
  assert.equal(switched.ok, true)
  await tick()
  assert.deepEqual(revisionStore.getSnapshot().decisions.map((entry) => entry.id), ['DEC-B2'], 'the new project seeds its own queue')
  assert.equal(revisionStore.getSnapshot().decisionRevision, 20, 'the new project revision replaces the old one')
  console.log('PASS  T-235 one shared decisions domain keeps the newest revision and drops stale answers')
}

const poll = globalThis.setInterval
let polls = 0
globalThis.setInterval = (fn, ms) => {
  polls++
  return 1
}
store.startPolling(1000)
store.stopPolling()
// T-235: the panel's board poll also registers it on the ONE shared decision
// cadence, so two intervals is the intended minimum (board + decisions).
assert.equal(polls, 2)
globalThis.setInterval = poll

console.log('PASS  the Host-backed store is an independently testable module')
