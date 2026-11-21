// HTTP route tests (v3): the GUI contract, transport hardening, and the fact
// that /state carries NO legacy Team snapshot. The retired fields (workers /
// teams / agents / team) must not come back; the panel reads agentTree + scope.

import { registerTaskRoutes, STATE_PATH, META_PATH, ACTION_PATH, TASK_PATH, LIST_PATH, WORKTREES_PATH, DIAGNOSTICS_PATH } from '../../plugin/task-center/routes.mjs'
import { createFakeTaskAgents, createRig, createTask, PROJECT, seedBoard } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

function install(rig) {
  const specs = []
  const webCtx = Object.assign({}, rig.ctx, {
    webServer: {
      register(spec) {
        specs.push(spec)
        return () => {}
      },
    },
  })
  const dispose = registerTaskRoutes(webCtx, { state: rig.state, api: rig.api, scheduler: rig.scheduler })
  const byPath = new Map(specs.map((spec) => [spec.path, spec]))
  return { specs, byPath, dispose }
}

function request(url, options) {
  const opts = options === undefined ? {} : options
  const chunks = opts.body === undefined ? [] : [Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))]
  return {
    method: opts.method === undefined ? 'GET' : opts.method,
    url: url,
    headers: opts.headers === undefined ? {} : opts.headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response() {
  return {
    status: 0,
    headers: null,
    text: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.text = String(text === undefined ? '' : text)
    },
    json() {
      return JSON.parse(this.text)
    },
  }
}

const TEST_SESSION = 'session-lead'

async function call(surface, url, options) {
  const res = response()
  const withSession = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'session=' + encodeURIComponent(TEST_SESSION)
  await surface.byPath.get(url.split('?')[0]).handler(request(withSession, options), res)
  return res
}

/** A request that carries NO session at all (the plugin home page case). */
async function callRaw(surface, url, options) {
  const res = response()
  await surface.byPath.get(url.split('?')[0]).handler(request(url, options), res)
  return res
}
const post = (body, headers) =>
  call(surface, ACTION_PATH, { method: 'POST', body: body, headers: Object.assign({ 'content-type': 'application/json' }, headers) })

const routeAgents = createFakeTaskAgents()
const rig = createRig({ taskAgents: routeAgents })
const surface = install(rig)
check('registers state, meta, action, task, list, worktrees and diagnostics', surface.specs.length === 7, String(surface.specs.length))
check(
  'the registered paths are the documented ones',
  [STATE_PATH, META_PATH, ACTION_PATH, TASK_PATH, LIST_PATH, WORKTREES_PATH, DIAGNOSTICS_PATH].every((path) => surface.byPath.has(path)),
)

// no project yet
{
  rig.state.setSessionRoot(TEST_SESSION, null)
  const res = await call(surface, STATE_PATH, {})
  rig.state.setSessionRoot(TEST_SESSION, PROJECT)
  check('state without a bound project says so', res.status === 200 && res.json().ok === false && res.json().code === 'no-project-bound', res.text)
  check('the UI-facing answer is a code plus params', res.json().message === undefined && typeof res.json().params === 'object', res.text)
}

// a project in the query is adopted and the snapshot has no legacy Team block
{
  const url = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  const res = await call(surface, url, {})
  const payload = res.json()
  check('state with a project answers', payload.ok === true && payload.project === PROJECT, res.text)
  check('and reports the dispatch state', payload.dispatch.state === 'paused')
  check('and remembers the project', rig.state.memory.projectHint === PROJECT)
  check('the snapshot exposes the live agent tree', payload.agentTree !== null && typeof payload.agentTree === 'object' && payload.agentTree.available === true, JSON.stringify(payload.agentTree))
  check('the snapshot exposes the project/session scope', payload.scope !== null && typeof payload.scope === 'object' && payload.scope.boardProject !== undefined)
  for (const legacy of ['workers', 'teams', 'agents', 'team']) {
    check('the snapshot has no legacy "' + legacy + '" field', payload[legacy] === undefined, 'present: ' + String(payload[legacy]))
  }
}

// first paint: core=1 defers metadata but keeps the board
{
  const res = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT) + '&core=1', {})
  const payload = res.json()
  check('core keeps the board and counts', payload.ok === true && Array.isArray(payload.tasks) && typeof payload.counts === 'object')
  check('core defers the agent tree', payload.agentTree.available === false && payload.agentTree.error === 'deferred')
  check('core still has no legacy team fields', payload.workers === undefined && payload.teams === undefined && payload.agents === undefined && payload.team === undefined)
}

// create, start, pause, get, board through the action route
{
  let res = await post({ action: 'create', title: 'A', dependsOn: [], verification: { probes: [{ id: 'suite', command: 'npm test' }] } })
  let payload = res.json()
  check('the route creates a task', payload.ok === true && payload.task.title === 'A', res.text)
  check('the response carries the board snapshot', payload.snapshot !== undefined && payload.snapshot.tasks.length === 1)
  const id = payload.task.id
  res = await post({ action: 'start' })
  payload = res.json()
  check('the route starts dispatch', payload.ok === true && payload.dispatch.state === 'running', res.text)
  res = await post({ action: 'pause' })
  check('the route pauses dispatch', res.json().dispatch.state === 'paused', res.text)
  res = await post({ action: 'start', taskId: id })
  check('start refuses a task id', res.json().ok === false && res.json().code === 'start-is-dispatch-only', res.text)
  res = await post({ action: 'get', id: id })
  check('the route reads one task', res.json().ok === true && res.json().task.id === id, res.text)
  res = await post({ action: 'board' })
  check('the route returns the board', res.json().ok === true && res.json().tasks.length === 1)
  res = await post({ action: 'no-such-action' })
  check('an unknown action is a typed refusal', res.json().ok === false && res.json().code === 'unknown-action', res.text)
}

// transport hardening
{
  let res = await call(surface, ACTION_PATH, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } })
  check('malformed JSON is refused, not crashed', res.status === 400, res.status + ' ' + res.text)
  res = await call(surface, ACTION_PATH, { method: 'POST', body: { action: 'board' }, headers: { 'content-type': 'text/plain' } })
  check('a non-JSON content type is refused', res.status === 400 || res.json().ok === false, res.status + ' ' + res.text)
}

// task detail
{
  const created = await createTask(rig, { title: 'B' })
  const res = await call(surface, TASK_PATH + '?id=' + encodeURIComponent(created.id), {})
  check('the task route returns one detail', res.json().ok === true && res.json().task.id === created.id, res.text)
  const missing = await call(surface, TASK_PATH + '?id=T-404', {})
  check('an unknown task is a typed refusal', missing.json().ok === false && missing.json().code === 'unknown-task', missing.text)
  const noId = await call(surface, TASK_PATH, {})
  check('a missing id is a 400', noId.status === 400 && noId.json().code === 'missing-id', String(noId.status))
}

// list: paging and filtering
{
  const res = await call(surface, LIST_PATH + '?limit=1', {})
  const payload = res.json()
  check('the list route pages', payload.ok === true && Array.isArray(payload.tasks) && payload.tasks.length <= 1, res.text)
  const filtered = await call(surface, LIST_PATH + '?status=pending', {})
  check('the list route filters by status', filtered.json().ok === true && filtered.json().tasks.every((task) => task.status === 'pending'))
}

// worktrees
{
  const res = await call(surface, WORKTREES_PATH, {})
  check('the worktrees route answers', res.json().ok === true && Array.isArray(res.json().worktrees), res.text)
}

// diagnostics: the dispatch probe reports the subagent edge, never a roster
{
  const res = await call(surface, DIAGNOSTICS_PATH, {})
  const payload = res.json()
  check('diagnostics answers', payload.ok === true && payload.project === PROJECT, res.text)
  check('diagnostics carries the scheduler block', payload.scheduler !== null && typeof payload.scheduler === 'object' && typeof payload.scheduler.ticks === 'number')
  check('the dispatch probe has no roster fields', payload.dispatch !== undefined && payload.dispatch.members === undefined && payload.dispatch.membersReadable === undefined && payload.dispatch.hasAgentTeams === undefined, JSON.stringify(payload.dispatch))
  check('the dispatch probe reports the subagent service', payload.dispatch.available === true && Array.isArray(payload.dispatch.subagentProviders))
}

// ── T-192: the card model is enforced through the SAME route ───────────────
{
  const probe = { probes: [{ id: 'suite', command: 'npm test' }] }
  let res = await post({ action: 'create', title: 'no probes' })
  check('a new dev card without probes is a typed refusal', res.json().ok === false && res.json().code === 'missing-probes', res.text)
  res = await post({ action: 'create', title: 'six files', verification: probe, writeFiles: ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs', 'f.mjs'] })
  check('more than five production files is a typed refusal', res.json().ok === false && res.json().code === 'too-many-files', res.text)
  res = await post({
    action: 'create',
    title: 'generated bundle does not count',
    verification: probe,
    writeFiles: ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs', 'client/client.js', 'scripts/test/extra.test.mjs'],
  })
  const generatedCard = res.json()
  check('the generated bundle and test files are outside the file budget', generatedCard.ok === true, res.text)
  res = await post({ action: 'create', title: 'seven criteria', verification: probe, acceptance: '1 a\n2 b\n3 c\n4 d\n5 e\n6 f\n7 g' })
  check('more than six acceptance criteria is a typed refusal', res.json().ok === false && res.json().code === 'too-many-acceptance', res.text)
  res = await post({ action: 'create', title: 'nine probes', verification: { probes: Array.from({ length: 9 }, (_, index) => ({ id: 'p' + String(index), command: 'npm test' })) } })
  check('more than eight probes is a typed refusal', res.json().ok === false && res.json().code === 'too-many-probes', res.text)
  res = await post({ action: 'create', title: 'an investigation needs no probe', kind: 'investigate' })
  check('an investigation card is exempt from the card model', res.json().ok === true && res.json().task.kind === 'investigate', res.text)
  res = await post({ action: 'update', id: generatedCard.ok === true ? generatedCard.task.id : 'T-1', verification: null })
  check('a dev card cannot be updated back to no probes', res.json().ok === false && res.json().code === 'missing-probes', res.text)
  res = await post({ action: 'update', id: generatedCard.ok === true ? generatedCard.task.id : 'T-1', acceptance: 'a\nb\nc\nd\ne\nf\ng' })
  check('an update cannot grow a card past six criteria', res.json().ok === false && res.json().code === 'too-many-acceptance', res.text)
}

// T-195: host decisions ride the ordinary action route (role user)
{
  const created = await rig.api.decisions.request(
    PROJECT,
    {
      id: 'DEC-1',
      eventKey: 'dispatch',
      taskId: 'T-1',
      eventLabel: '派发批准',
      title: '派发 T-1？',
      body: '任务已就绪，等待批准。',
      options: [
        { id: 'approve', label: '批准派发' },
        { id: 'hold', label: '暂不派发', default: true },
      ],
      defaultOption: 'hold',
      timeoutMs: 300000,
    },
    { by: '@user' },
  )
  check('a decision request persists beside the board', created.ok === true && created.created === true, JSON.stringify(created))
  let res = await post({ action: 'decisionList' })
  let payload = res.json()
  check('the route lists pending decisions', payload.ok === true && Array.isArray(payload.decisions) && payload.decisions.length === 1 && payload.decisions[0].id === 'DEC-1', res.text.substring(0, 400))
  check('the route answer carries the board snapshot for the panel', payload.snapshot !== undefined && Array.isArray(payload.snapshot.tasks))
  res = await post({ action: 'decisionAnswer', decisionId: 'DEC-1', option: 'approve' })
  payload = res.json()
  check('the route answers a decision once', payload.ok === true && payload.decision.status === 'answered' && payload.decision.resolution.option === 'approve', res.text.substring(0, 400))
  res = await post({ action: 'decisionAnswer', decisionId: 'DEC-1', option: 'hold' })
  payload = res.json()
  check('the route refuses a second answer by typed code', payload.ok === false && payload.code === 'already-answered', res.text.substring(0, 400))
}

// T-196: an Agent action is a pending decision; /state shows it and the route's
// answer is what executes it (the panel role is the human).
{
  const asAgent = { projectPath: rig.project, by: '@router', role: 'agent', agent: { id: 'session-router', name: 'router' } }
  const asked = await rig.api.perform('create', { title: 'Routed card', kind: 'dev', verification: { probes: [{ id: 'suite', command: 'npm test' }] } }, asAgent)
  check('T-196 an agent create is a pending decision, not a card', asked.ok === false && asked.code === 'needs-decision' && typeof asked.decision.id === 'string', JSON.stringify(asked).substring(0, 400))
  let res = await call(surface, STATE_PATH, {})
  let payload = res.json()
  const pending = (payload.decisions === undefined || payload.decisions === null ? [] : payload.decisions).filter((decision) => decision.id === asked.decision.id)[0]
  check(
    'T-196 /state carries the pending action decision and its timeout policy',
    pending !== undefined && pending.eventKey === 'create' && pending.autoRunAllowed === true && pending.remainingMs > 0,
    JSON.stringify(payload.decisions),
  )
  check('T-196 the board is untouched while the question is pending', payload.tasks.filter((task) => task.title === 'Routed card').length === 0, JSON.stringify(payload.tasks.map((task) => task.title)))
  res = await post({ action: 'decisionAnswer', decisionId: asked.decision.id, option: 'create' })
  payload = res.json()
  check('T-196 the route answer executes the stored create', payload.ok === true && payload.applied !== null && payload.applied.executed === true && typeof payload.applied.summary.taskId === 'string', res.text.substring(0, 600))
  const taskId = payload.applied.summary.taskId
  check('T-196 the answer carries the refreshed board', payload.snapshot !== undefined && payload.snapshot.tasks.some((task) => task.id === taskId), res.text.substring(0, 300))
  res = await post({ action: 'decisionAnswer', decisionId: asked.decision.id, option: 'cancel' })
  check('T-196 a second answer is refused by the same typed code', res.json().ok === false && res.json().code === 'already-answered', res.text.substring(0, 300))

  // start: the agent asks, hold keeps the queue waiting, approve dispatches.
  const startAsked = await rig.api.perform('start', {}, asAgent)
  check('T-196 an agent start is a route-visible decision', startAsked.code === 'needs-consent' && startAsked.decision !== undefined, JSON.stringify(startAsked).substring(0, 400))
  res = await post({ action: 'decisionAnswer', decisionId: startAsked.decision.id, option: 'hold' })
  payload = res.json()
  check('T-196 暂不派发 leaves dispatch paused through the route', payload.ok === true && payload.snapshot.dispatch.state === 'paused', res.text.substring(0, 400))
  const startAgain = await rig.api.perform('start', {}, asAgent)
  res = await post({ action: 'decisionAnswer', decisionId: startAgain.decision.id, option: 'approve' })
  payload = res.json()
  check('T-196 批准派发 starts dispatch through the route', payload.ok === true && payload.snapshot.dispatch.state === 'running', res.text.substring(0, 400))
  check('T-196 the asking Session received the outcome as a message', routeAgents.calls.some((entry) => entry.kind === 'send' && entry.text.indexOf('created ' + String(taskId)) >= 0), JSON.stringify(routeAgents.calls.filter((entry) => entry.kind === 'send')))
  await rig.action('pause')
}


// T-198: the decision policy is edited through the same user route, and /state
// carries the resolved policy so the settings page never guesses.
{
  let res = await post({ action: 'decisionPolicy', scope: 'project', events: { 'dev-timeout': { timeoutSeconds: 240 } } })
  let payload = res.json()
  check(
    'T-198 the route saves a project policy override',
    payload.ok === true && payload.saved.scope === 'project' && payload.saved.location === 'project' && payload.decisionPolicy.project['dev-timeout'].timeoutSeconds === 240,
    res.text.substring(0, 600),
  )
  res = await call(surface, STATE_PATH, {})
  payload = res.json()
  check(
    'T-198 /state carries the resolved decision policy and the sparse overrides',
    payload.decisionPolicy !== null &&
      payload.decisionPolicy.project['dev-timeout'].timeoutSeconds === 240 &&
      payload.decisionPolicy.overrides.project['dev-timeout'].timeoutSeconds === 240 &&
      payload.decisionPolicy.guards.timeoutNeverDeletes === true,
    JSON.stringify(payload.decisionPolicy === null ? null : payload.decisionPolicy.overrides),
  )
  res = await post({ action: 'decisionPolicy', scope: 'project', events: { delete: { mode: 'notify' } } })
  payload = res.json()
  check(
    'T-198 the delete guard survives the route',
    payload.ok === true && payload.decisionPolicy.project['delete'].mode === 'ask',
    res.text.substring(0, 400),
  )
  res = await post({ action: 'decisionPolicy', scope: 'project', reset: true })
  payload = res.json()
  check('T-198 reset=true clears the scope', payload.ok === true && Object.keys(payload.decisionPolicy.overrides.project).length === 0, JSON.stringify(payload.decisionPolicy.overrides.project))
  res = await post({ action: 'decisionPolicy', scope: 'nope', events: {} })
  check('T-198 a bad scope is refused by code through the route', res.json().ok === false && res.json().code === 'invalid-policy-scope', res.text.substring(0, 300))
}

// ── T-203: the foreground never resolves "the project that was active last" ──
// The plugin home page has no chat session. It used to fall back to the single
// project the host drove last, so a `todo` board could appear under a
// `godot-bridge` conversation. A foreground request now reads "nothing bound"
// (the setup state) unless the caller pins a project itself; the last-active
// fallback survives for the background (scheduler/startup) only.
{
  const LAST_ACTIVE = PROJECT + '-last-active'
  // A REAL board project: the old fallback WOULD have resolved it, so the checks
  // below prove the fallback is gone rather than merely unreachable.
  seedBoard(rig.fs, LAST_ACTIVE, JSON.stringify({ version: 1, tasks: [] }))
  rig.state.touchProject(LAST_ACTIVE, null)

  let res = await callRaw(surface, STATE_PATH, {})
  let payload = res.json()
  check(
    'T-203 no session => nothing is bound (never the last-active project)',
    res.status === 200 && payload.ok === false && payload.code === 'no-project-bound' && payload.project === undefined && payload.tasks === undefined,
    res.text,
  )
  check('T-203 the unbound answer names its source', payload.resolvedFrom === 'unbound', JSON.stringify(payload))

  res = await callRaw(surface, STATE_PATH + '?session=' + encodeURIComponent('web-unknown-session'), {})
  payload = res.json()
  check(
    'T-203 an unknown session id is no session context either',
    payload.ok === false && payload.code === 'no-project-bound' && payload.resolvedFrom === 'unbound',
    res.text,
  )

  // A foreground caller cannot opt into the fallback; the background still can.
  const foreground = await rig.state.resolveProject({ allowLastActive: true })
  check('T-203 allowLastActive is refused to a foreground caller', foreground.ok === false && foreground.resolvedFrom === 'unbound', JSON.stringify(foreground))
  const background = await rig.state.resolveProject({ allowLastActive: true, background: true })
  check(
    'T-203 the background may still resolve the last-active project',
    background.ok === true && background.resolvedFrom === 'last-active' && background.project.root === LAST_ACTIVE,
    JSON.stringify(background),
  )

  // The same request WITH this session's id answers this session's workspace.
  res = await call(surface, STATE_PATH, {})
  payload = res.json()
  check(
    'T-203 a godot-bridge session resolves its own board',
    payload.ok === true && payload.project === PROJECT && payload.projectRoot === PROJECT && payload.resolvedFrom === 'session',
    res.text.substring(0, 300),
  )
  check(
    'T-203 board and chat workspace agree for that session',
    payload.sessionProject === PROJECT && payload.scope !== null && payload.scope.currentSessionProject === PROJECT && payload.projectWarning === null,
    JSON.stringify({ sessionProject: payload.sessionProject, current: payload.scope === null ? null : payload.scope.currentSessionProject, warning: payload.projectWarning }),
  )

  // An explicit pin is the ONE way a panel may leave the session's workspace,
  // and the answer names it (panel) plus the mismatch it creates.
  res = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(LAST_ACTIVE), {})
  payload = res.json()
  check(
    'T-203 an explicit pin is named as the panel source',
    payload.ok === true && payload.project === LAST_ACTIVE && payload.resolvedFrom === 'panel',
    res.text.substring(0, 300),
  )
  check(
    'T-203 the pin keeps the session project visible as the mismatch',
    payload.sessionProject === PROJECT && payload.projectWarning !== null,
    JSON.stringify({ sessionProject: payload.sessionProject, warning: payload.projectWarning }),
  )
  res = await post({ action: 'openProject', path: LAST_ACTIVE })
  payload = res.json()
  check('T-203 an openProject through the route reports the panel source', payload.ok === true && payload.resolvedFrom === 'panel', res.text.substring(0, 300))
}

// ── T-210: the LIGHT first paint and the independent /meta half ────────────
// /state?light=1 answers with the board + counts + the LIGHT session scope and
// never touches a host inventory (agent tree / worktrees / environment /
// activity / roles / archive). /meta answers those on its own request, with a
// short TTL cache, a single build, per-segment timings and per-segment
// degradation — a slow or broken inventory can never block the cards or the
// header.
let listForCalls = 0
const countingAgents = createFakeTaskAgents()
const baseListFor = countingAgents.listFor
countingAgents.listFor = async (rootId) => {
  listForCalls += 1
  return baseListFor(rootId)
}
const lightRig = createRig({ taskAgents: countingAgents })
const lightSurface = install(lightRig)
{
  await createTask(lightRig, { title: 'light card' })
  listForCalls = 0
  let res = await call(lightSurface, STATE_PATH + '?light=1&timings=1', {})
  let payload = res.json()
  check('T-210 the light first paint answers', payload.ok === true && payload.project === PROJECT, res.text.substring(0, 300))
  check('T-210 the light first paint carries the board', Array.isArray(payload.tasks) && payload.tasks.length === 1 && payload.counts.total === 1, JSON.stringify(payload.counts))
  check('T-210 the light first paint carries the LIGHT session scope', payload.scope !== null && payload.scope.light === true && Array.isArray(payload.scope.sessionSummaries), JSON.stringify(payload.scope === null ? null : Object.keys(payload.scope)))
  check('T-210 the light scope derives liveness from the registry, not the host', payload.scope.livenessSource === 'registry' && payload.scope.handoff.partial === true && payload.scope.handoff.eligibility === null, JSON.stringify(payload.scope.handoff).substring(0, 300))
  check('T-210 the light first paint defers the agent tree', payload.agentTree.available === false && payload.agentTree.error === 'deferred', JSON.stringify(payload.agentTree))
  check('T-210 the light first paint defers worktrees/environment/activity/roles', payload.worktrees.error === 'deferred' && payload.environment === null && payload.activityEvents === null && payload.roles === null, JSON.stringify({ worktrees: payload.worktrees.error, environment: payload.environment, events: payload.activityEvents, roles: payload.roles }))
  check('T-210 the light first paint makes NO host inventory call', listForCalls === 0, String(listForCalls))
  check('T-210 the answer advertises the split for the panel', payload.metadata.split === true && payload.metadata.light === true && payload.metadata.deferred.indexOf('agentTree') >= 0, JSON.stringify(payload.metadata))
  check('T-210 the light answer reports per-segment timings on request', payload.timings !== undefined && typeof payload.timings.segments.scope === 'number' && typeof payload.timings.totalMs === 'number', JSON.stringify(payload.timings))
  check('T-210 an unrequested answer carries no timings', (await call(lightSurface, STATE_PATH + '?light=1', {})).json().timings === undefined)
  console.log('PASS  T-210 the light first paint is the board plus the light scope, with no host inventory')

  listForCalls = 0
  const metaStarted = Date.now()
  res = await call(lightSurface, META_PATH + '?timings=1&refresh=1', {})
  const metaMs = Date.now() - metaStarted
  payload = res.json()
  check('T-210 /meta answers the deferred half', payload.ok === true && payload.project === PROJECT && typeof payload.meta === 'object', res.text.substring(0, 300))
  check('T-210 /meta carries the FULL scope with eligibility', payload.meta.scope !== null && payload.meta.scope.light === false && payload.meta.scope.handoff.eligibility !== null, JSON.stringify(payload.meta.scope === null ? null : payload.meta.scope.handoff).substring(0, 300))
  check('T-210 /meta carries the agent tree, worktrees, environment and roles', payload.meta.agentTree !== undefined && payload.meta.worktrees !== undefined && payload.meta.environment !== undefined && payload.meta.roles !== null, JSON.stringify(Object.keys(payload.meta)))
  check('T-210 /meta carries the activity timeline and the decision policy', payload.meta.activityEvents !== null && Array.isArray(payload.meta.activityEvents.entries) && payload.meta.decisionPolicy !== null, JSON.stringify({ entries: payload.meta.activityEvents === null ? null : payload.meta.activityEvents.count, policy: payload.meta.decisionPolicy !== null }))
  check('T-210 /meta read the host agent tree once', listForCalls >= 1, String(listForCalls))
  check('T-210 /meta reports the named segment timings', payload.timings !== undefined && ['scope', 'agentTree', 'worktreeSnapshot', 'environmentSnapshot', 'roles', 'activity'].every((name) => typeof payload.timings.segments[name] === 'number'), JSON.stringify(payload.timings === undefined ? null : payload.timings.segments))
  check('T-210 /meta counts the host calls it made', payload.timings.counts !== undefined && typeof payload.timings.counts.agentList === 'number', JSON.stringify(payload.timings === undefined ? null : payload.timings.counts))
  check('T-210 /meta answers on its own budget', metaMs < 2000, String(metaMs))

  const warmStarted = Date.now()
  const warm = (await call(lightSurface, META_PATH, {})).json()
  const warmMs = Date.now() - warmStarted
  check('T-210 a second /meta inside the window is served from the cache', warm.cache === 'hit', warm.cache)
  check('T-210 the warm /meta answer is the same inventory', warm.meta.scope !== null && warm.meta.agentTree !== undefined, JSON.stringify(Object.keys(warm.meta || {})))
  check('T-210 the warm /meta answer is fast', warmMs < 2000, String(warmMs))
  const refreshed = (await call(lightSurface, META_PATH + '?refresh=1', {})).json()
  check('T-210 refresh=1 forces a rebuild', refreshed.cache === 'miss', refreshed.cache)
  console.log('PASS  T-210 /meta loads the deferred half independently, cached and timed')

  // T-203 applies to the metadata half too: no session means NOTHING is bound,
  // never the project another session drove last.
  const unboundMeta = await callRaw(lightSurface, META_PATH, {})
  check('T-210 /meta without a session is unbound, never a last-active project', unboundMeta.json().ok === false && unboundMeta.json().code === 'no-project-bound' && unboundMeta.json().resolvedFrom === 'unbound', unboundMeta.text)
  const unknownSession = await callRaw(lightSurface, META_PATH + '?session=' + encodeURIComponent('web-unknown-session'), {})
  check('T-210 /meta with an unknown session is unbound too', unknownSession.json().code === 'no-project-bound' && unknownSession.json().resolvedFrom === 'unbound', unknownSession.text)
  console.log('PASS  T-210 the metadata half keeps the T-203 rule (no session, no fallback)')
}

// ── T-210: a broken deferred segment degrades ONLY itself ───────────────────
// The host inventory is the one segment that can be slow or broken for reasons
// the board does not share. `metadata()` must still answer the rest (scope,
// agent tree, worktrees, activity), name the failed segment in `errors`, and
// leave the light /state path untouched.
function seedManyCards(rig, count) {
  const tasks = []
  for (let index = 1; index <= count; index += 1) {
    const status = index <= count - 40 ? 'done' : index <= count - 20 ? 'pending' : 'blocked'
    tasks.push({
      id: 'T-' + String(index),
      title: 'Card ' + String(index),
      kind: 'dev',
      status: status,
      priority: 30,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-' + String((index % 9) + 1).padStart(2, '0') + 'T00:00:00.000Z',
      history: [
        { at: '2026-01-02T00:00:00.000Z', from: null, to: 'pending', note: 'created' },
        { at: '2026-01-03T00:00:00.000Z', from: 'pending', to: status, note: 'moved by the host' },
      ],
      acceptance: 'the card is checked',
      spec: 'do the work and prove it',
    })
  }
  seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 1, tasks }))
}
{
  const brokenRig = createRig({ taskAgents: createFakeTaskAgents() })
  seedManyCards(brokenRig, 200)
  // The dispatcher's environment probe is the host inventory that can hang or
  // throw; the rest of the metadata shares nothing with it.
  brokenRig.scheduler.status = () => { throw new Error('host inventory exploded') }
  const degraded = await brokenRig.api.metadata(brokenRig.project, { sessionId: 'session-lead' })
  check('T-210 a failed metadata segment still answers the metadata', degraded.ok === true, JSON.stringify(degraded).substring(0, 300))
  check('T-210 the failed segment is NAMED', typeof degraded.errors.environmentSnapshot === 'string' && degraded.errors.environmentSnapshot.indexOf('exploded') >= 0, JSON.stringify(degraded.errors))
  check('T-210 the other segments still answer', degraded.meta.scope !== null && degraded.meta.agentTree !== undefined && degraded.meta.worktrees !== undefined, JSON.stringify(Object.keys(degraded.meta || {})))
  check('T-210 the degraded segment answers its fallback', degraded.meta.environment === null, JSON.stringify(degraded.meta.environment))
  const degradedLight = await brokenRig.api.snapshot(brokenRig.project, { full: false, light: true, sessionId: 'session-lead' })
  check('T-210 the light first paint never reads the broken segment', degradedLight.ok === true && degradedLight.environment === null && degradedLight.agentTree.error === 'deferred', JSON.stringify(degradedLight.metadata))
  console.log('PASS  T-210 a failed deferred segment degrades alone and never blocks the board')
}

// ── T-210: the 200-card performance budget ──────────────────────────────────
// Budget: the light core answer under 200 ms, the WARM metadata under 2 s, on a
// 200-card board. Both are measured through the real route handlers.
{
  const perfRig = createRig({ taskAgents: createFakeTaskAgents() })
  seedManyCards(perfRig, 200)
  const perfSurface = install(perfRig)
  const coreStarted = Date.now()
  const coreRes = await call(perfSurface, STATE_PATH + '?light=1&timings=1', {})
  const coreMs = Date.now() - coreStarted
  const corePayload = coreRes.json()
  check('T-210 the 200-card light answer is complete', corePayload.ok === true && corePayload.counts.total === 200, JSON.stringify(corePayload.counts))
  check('T-210 the 200-card core answer is under 200 ms', coreMs < 200, String(coreMs) + 'ms  segments=' + JSON.stringify(corePayload.timings === undefined ? null : corePayload.timings.segments))
  // Cold metadata first (the cache is per project+session, the previous blocks
  // used another project), then the WARM answer the 2.5 s poll sees.
  await call(perfSurface, META_PATH, {})
  const warmStarted = Date.now()
  const warmRes = await call(perfSurface, META_PATH + '?timings=1', {})
  const warmMs = Date.now() - warmStarted
  const warmPayload = warmRes.json()
  check('T-210 the warm 200-card metadata is a cache hit', warmPayload.ok === true && warmPayload.cache === 'hit', warmPayload.cache)
  check('T-210 the warm 200-card metadata is under 2 s', warmMs < 2000, String(warmMs) + 'ms  segments=' + JSON.stringify(warmPayload.timings === undefined ? null : warmPayload.timings.segments))
  console.log('PASS  T-210 200 cards: core ' + String(coreMs) + 'ms (<200), warm metadata ' + String(warmMs) + 'ms (<2000)')
}

console.log(failures === 0 ? '\nPASS  task routes (v3 snapshot)' : '\nFAIL  ' + String(failures) + ' route check(s)')
process.exit(failures === 0 ? 0 : 1)
