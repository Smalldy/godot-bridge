// HTTP route tests (v3): the GUI contract, transport hardening, and the fact
// that /state carries NO legacy Team snapshot. The retired fields (workers /
// teams / agents / team) must not come back; the panel reads agentTree + scope.

import { registerTaskRoutes, STATE_PATH, META_PATH, ACTION_PATH, TASK_PATH, LIST_PATH, WORKTREES_PATH, DIAGNOSTICS_PATH } from '../../plugin/task-center/routes.mjs'
import { pruneBoundedCache } from '../../plugin/task-center/api.mjs'
import { boardPath } from '../../plugin/task-center/board.mjs'
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
  // T-231: a successful write ANSWERS WHAT CHANGED — { ok, seq, affected,
  // changed } — instead of attaching a second copy of the board the panel
  // already polls every 2.5 s (and the tool answer never attaches one at all).
  check(
    'T-231 a successful write answers seq/affected/changed, not a board snapshot',
    payload.snapshot === undefined &&
      Number.isFinite(payload.seq) &&
      payload.affected !== undefined &&
      payload.affected.ids.indexOf(payload.task.id) >= 0 &&
      payload.affected.count === payload.affected.ids.length &&
      payload.changed.join(',') === 'board,detail',
    res.text.substring(0, 400),
  )
  const id = payload.task.id
  res = await post({ action: 'start' })
  payload = res.json()
  check('the route starts dispatch', payload.ok === true && payload.dispatch.state === 'running', res.text)
  check('T-231 a dispatch write changes the board domain only', payload.changed.join(',') === 'board' && Array.isArray(payload.affected.ids) && payload.affected.ids.length === 0, JSON.stringify({ changed: payload.changed, affected: payload.affected }))
  res = await post({ action: 'pause', includeSnapshot: true })
  payload = res.json()
  check('the route pauses dispatch', payload.dispatch.state === 'paused', res.text)
  check(
    'T-231 includeSnapshot:true is the explicit, versioned delta escape hatch',
    payload.snapshot !== undefined && payload.snapshot.ok === true && Array.isArray(payload.snapshot.tasks) && Number.isFinite(payload.snapshot.seq) && typeof payload.snapshot.version === 'number',
    res.text.substring(0, 400),
  )
  res = await post({ action: 'start', taskId: id })
  check('start refuses a task id', res.json().ok === false && res.json().code === 'start-is-dispatch-only', res.text)
  res = await post({ action: 'get', id: id })
  check('the route reads one task', res.json().ok === true && res.json().task.id === id, res.text)
  res = await post({ action: 'board' })
  payload = res.json()
  check(
    'T-231 the route board is a summary page (counts/dispatch/seq + cards)',
    payload.ok === true && payload.view === 'summary' && payload.tasks.length === 1 && payload.tasks[0].id === id && payload.tasks[0].spec === undefined && payload.counts.total === 1 && Number.isFinite(payload.seq) && payload.dispatch.state === 'paused',
    res.text.substring(0, 400),
  )
  res = await post({ action: 'board', view: 'full' })
  payload = res.json()
  check(
    'T-231 view:"full" keeps the diagnostic detail board as the escape hatch',
    payload.ok === true && payload.view === undefined && payload.tasks.length === 1 && typeof payload.tasks[0].spec === 'string' && payload.agentTree !== undefined,
    res.text.substring(0, 300),
  )
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

// ── T-225: /state keeps the stage delivery (name + id), and nothing bigger ──
// The agent sidebar resolves its develop/review/test rows from the SUMMARY
// cards /state carries, never from /task. summaryOf used to drop deliveredTo, so
// a done card showed 评审/测试 as 未分配 although the board held the delivery.
// This seeds a real board whose rounds also carry detail-class payloads, and
// asserts the summary keeps exactly the identity the rows need while /task
// keeps the record.
{
  const deliveryRig = createRig({ taskAgents: createFakeTaskAgents() })
  const AT = '2026-11-21T09:00:00.000Z'
  const BIG = 'detail-class text that must never ride /state; '.repeat(60)
  const deliveryCard = {
    id: 'T-225',
    title: 'summary keeps the delivery',
    kind: 'dev',
    status: 'done',
    priority: 40,
    base: 'base-sha',
    target: 'feat/task-center-v2',
    branch: 'task/T-225-1',
    writeFiles: ['plugin/task-center/api.mjs'],
    verification: { probes: [{ id: 'suite', command: 'npm test' }] },
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: AT,
    history: [{ at: AT, from: 'testing', to: 'done', note: 'passed' }],
    review: {
      status: 'approved',
      by: '@worker-t-225',
      byName: 'worker-t-225',
      at: AT,
      attempt: 1,
      reasons: BIG,
      record: { verdict: 'approved', checked: [{ criterion: BIG, method: BIG, result: 'pass' }], findings: [], residualRisks: [BIG] },
      deliveredTo: { name: 'reviewer-t-225', id: 'session-reviewer-225', at: AT, generation: 3 },
    },
    test: {
      status: 'passed',
      by: '@tester-t-225',
      at: AT,
      attempt: 1,
      evidence: BIG,
      record: { verdict: 'passed', probes: [{ id: 'suite', command: 'npm test', exitCode: 0, tail: BIG }], adversarial: [], notes: BIG },
      deliveredTo: { name: 'tester-t-225', id: 'session-tester-225', at: AT, generation: 2 },
    },
    merge: { status: 'merged', base: 'base-sha', target: 'feat/task-center-v2', head: 'head-sha', mergeCommit: 'merge-sha' },
  }
  const boardText = JSON.stringify({ version: 1, tasks: [deliveryCard] })
  seedBoard(deliveryRig.fs, PROJECT, boardText)
  const deliverySurface = install(deliveryRig)

  // The panel's own poll is the light first paint: assert on THAT answer.
  const stateRes = await call(deliverySurface, STATE_PATH + '?light=1', {})
  const stateText = stateRes.text
  const payload = stateRes.json()
  const summaryCard = (payload.tasks === undefined ? [] : payload.tasks).filter((task) => task.id === 'T-225')[0]
  check('T-225 the light /state carries the seeded card', payload.ok === true && payload.metadata.light === true && summaryCard !== undefined, stateText.substring(0, 300))
  const reviewDelivery = summaryCard === undefined ? undefined : summaryCard.review.deliveredTo
  const testDelivery = summaryCard === undefined ? undefined : summaryCard.test.deliveredTo
  check(
    'T-225 the summary review keeps the real reviewer session',
    reviewDelivery !== undefined && reviewDelivery !== null && reviewDelivery.name === 'reviewer-t-225' && reviewDelivery.id === 'session-reviewer-225',
    JSON.stringify(summaryCard === undefined ? null : summaryCard.review),
  )
  check(
    'T-225 the summary test keeps the real tester session',
    testDelivery !== undefined && testDelivery !== null && testDelivery.name === 'tester-t-225' && testDelivery.id === 'session-tester-225',
    JSON.stringify(summaryCard === undefined ? null : summaryCard.test),
  )
  check(
    'T-225 the summary adds ONLY name + id (no at / generation)',
    reviewDelivery !== undefined && testDelivery !== undefined && Object.keys(reviewDelivery).sort().join(',') === 'id,name' && Object.keys(testDelivery).sort().join(',') === 'id,name',
    JSON.stringify([reviewDelivery, testDelivery]),
  )
  check(
    'T-225 no detail-class review payload rides the summary',
    summaryCard !== undefined && summaryCard.review.record === undefined && summaryCard.review.reasons === undefined,
    JSON.stringify(summaryCard === undefined ? null : Object.keys(summaryCard.review)),
  )
  check(
    'T-225 no detail-class test payload rides the summary',
    summaryCard !== undefined && summaryCard.test.record === undefined && summaryCard.test.evidence === undefined && summaryCard.test.evidenceLength === BIG.length,
    JSON.stringify(summaryCard === undefined ? null : Object.keys(summaryCard.test)),
  )
  check(
    'T-225 the summary answer stays a fraction of the board',
    stateText.length < boardText.length,
    'summary=' + String(stateText.length) + 'B board=' + String(boardText.length) + 'B',
  )

  // /task still carries the whole record, so the drawer loses nothing.
  const detailRes = await call(deliverySurface, TASK_PATH + '?id=T-225', {})
  const detailCard = detailRes.json().task
  check('T-225 /task still answers the card', detailRes.json().ok === true && detailCard !== undefined, detailRes.text.substring(0, 300))
  check(
    'T-225 /task keeps the full deliveredTo (at + generation)',
    detailCard.review.deliveredTo.at === AT && detailCard.review.deliveredTo.generation === 3 && detailCard.test.deliveredTo.at === AT && detailCard.test.deliveredTo.generation === 2,
    JSON.stringify([detailCard.review.deliveredTo, detailCard.test.deliveredTo]),
  )
  check(
    'T-225 /task keeps the detail-class payload the summary dropped',
    detailCard.review.reasons === BIG && detailCard.test.evidence === BIG && detailCard.review.record !== null && detailCard.test.record !== null,
    JSON.stringify({ reasons: String(detailCard.review.reasons).length, evidence: String(detailCard.test.evidence).length }),
  )
  // The ids the client's stageSessionsOf reads (client-agent-sidebar covers the
  // rows themselves): review.deliveredTo.id / test.deliveredTo.id must be real.
  check(
    'T-225 the summary ids are the sessions the sidebar opens',
    reviewDelivery !== undefined && reviewDelivery.id === 'session-reviewer-225' && testDelivery !== undefined && testDelivery.id === 'session-tester-225',
  )
  console.log('PASS  T-225 /state keeps the stage delivery identity; /task keeps the record')
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
  check(
    'T-231 a READ answer never grows a write envelope or a board snapshot',
    payload.snapshot === undefined && payload.seq === undefined && payload.affected === undefined && payload.changed === undefined,
    Object.keys(payload).join(','),
  )
  res = await post({ action: 'decisionAnswer', decisionId: 'DEC-1', option: 'approve' })
  payload = res.json()
  check('the route answers a decision once', payload.ok === true && payload.decision.status === 'answered' && payload.decision.resolution.option === 'approve', res.text.substring(0, 400))
  check(
    'T-231 a decision answer names the decisions domain and carries no board snapshot',
    payload.snapshot === undefined && payload.changed.join(',') === 'decisions' && payload.affected !== undefined,
    res.text.substring(0, 400),
  )
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
  res = await post({ action: 'decisionAnswer', decisionId: asked.decision.id, option: 'create', includeSnapshot: true })
  payload = res.json()
  check('T-196 the route answer executes the stored create', payload.ok === true && payload.applied !== null && payload.applied.executed === true && typeof payload.applied.summary.taskId === 'string', res.text.substring(0, 600))
  check(
    'T-231 an executed decision names the card it created and changes board+detail+decisions',
    Number.isFinite(payload.seq) && payload.affected.ids.indexOf(payload.applied.summary.taskId) >= 0 && payload.changed.join(',') === 'board,detail,decisions',
    JSON.stringify({ seq: payload.seq, affected: payload.affected, changed: payload.changed }),
  )
  const taskId = payload.applied.summary.taskId
  check('T-196 the answer carries the refreshed board', payload.snapshot !== undefined && payload.snapshot.tasks.some((task) => task.id === taskId), res.text.substring(0, 300))
  res = await post({ action: 'decisionAnswer', decisionId: asked.decision.id, option: 'cancel' })
  check('T-196 a second answer is refused by the same typed code', res.json().ok === false && res.json().code === 'already-answered', res.text.substring(0, 300))

  // start: the agent asks, hold keeps the queue waiting, approve dispatches.
  const startAsked = await rig.api.perform('start', {}, asAgent)
  check('T-196 an agent start is a route-visible decision', startAsked.code === 'needs-consent' && startAsked.decision !== undefined, JSON.stringify(startAsked).substring(0, 400))
  res = await post({ action: 'decisionAnswer', decisionId: startAsked.decision.id, option: 'hold', includeSnapshot: true })
  payload = res.json()
  check('T-196 暂不派发 leaves dispatch paused through the route', payload.ok === true && payload.snapshot.dispatch.state === 'paused', res.text.substring(0, 400))
  const startAgain = await rig.api.perform('start', {}, asAgent)
  res = await post({ action: 'decisionAnswer', decisionId: startAgain.decision.id, option: 'approve', includeSnapshot: true })
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
  // T-210 review: opening/switching a project must paint from the LIGHT answer.
  // The panel's openProject used to carry the full snapshot (agent tree, worktrees,
  // environment, roles...): the new board waited for the host inventory. The
  // route now asks the action for the light delivery; preflight/registry stay.
  {
    const postLight = async (body) => {
      const res = response()
      await lightSurface.byPath.get(ACTION_PATH).handler(
        request(ACTION_PATH + '?session=' + encodeURIComponent(TEST_SESSION), { method: 'POST', body: body, headers: { 'content-type': 'application/json' } }),
        res,
      )
      return res
    }
    listForCalls = 0
    const opened = await postLight({ action: 'openProject', path: lightRig.project })
    const openedPayload = opened.json()
    check('T-210 an openProject through the panel answers', openedPayload.ok === true && openedPayload.project === PROJECT, opened.text.substring(0, 300))
    check(
      'T-210 the openProject answer is the LIGHT snapshot',
      openedPayload.agentTree.available === false && openedPayload.agentTree.error === 'deferred' && openedPayload.worktrees.error === 'deferred' && openedPayload.environment === null,
      JSON.stringify({ agentTree: openedPayload.agentTree, worktrees: openedPayload.worktrees, environment: openedPayload.environment }),
    )
    check('T-210 the openProject answer keeps preflight and the registry', openedPayload.preflight !== null && typeof openedPayload.preflight === 'object' && typeof openedPayload.preflight.ok === 'boolean' && openedPayload.registry !== undefined, JSON.stringify(openedPayload.preflight).substring(0, 200))
    check('T-210 opening a project reads NO host inventory', listForCalls === 0, String(listForCalls))
    check('T-210 the openProject answer still carries the board and the header base', Array.isArray(openedPayload.tasks) && openedPayload.scope !== null && openedPayload.metadata.split === true, JSON.stringify(openedPayload.metadata))
    const afterOpen = (await call(lightSurface, META_PATH + '?refresh=1', {})).json()
    check('T-210 the deferred half is ONE /meta request away after opening', afterOpen.ok === true && afterOpen.meta.agentTree !== undefined && afterOpen.meta.scope !== null && listForCalls >= 1, JSON.stringify({ ok: afterOpen.ok, calls: listForCalls }))
    console.log('PASS  T-210 opening a project paints the light board; /meta supplies the inventory')
  }

  // T-210 review: the memo caches are bounded (a long-lived host cycles projects).
  {
    const cache = new Map()
    cache.set('expired', { at: 1000 })
    cache.set('fresh', { at: 9000 })
    const size = pruneBoundedCache(cache, { ttlMs: 5000, now: 10000, limit: 10 })
    check('T-210 a memo cache drops expired entries', size === 1 && !cache.has('expired') && cache.has('fresh'), JSON.stringify(Array.from(cache.keys())))
    const bounded = new Map()
    for (let index = 0; index < 10; index += 1) bounded.set('k' + String(index), { at: 1000 + index })
    pruneBoundedCache(bounded, { ttlMs: 60000, now: 2000, limit: 4 })
    check(
      'T-210 a memo cache keeps only the newest N entries',
      bounded.size === 4 && bounded.has('k9') && bounded.has('k6') && !bounded.has('k5'),
      JSON.stringify(Array.from(bounded.keys())),
    )
    console.log('PASS  T-210 the new memo caches are bounded')
  }

  console.log('PASS  T-210 the metadata half keeps the T-203 rule (no session, no fallback)')
}

// ── T-210: a broken deferred segment degrades ONLY itself ───────────────────
// The host inventory is the one segment that can be slow or broken for reasons
// the board does not share. `metadata()` must still answer the rest (scope,
// agent tree, worktrees, activity), name the failed segment in `errors`, and
// leave the light /state path untouched.
// A production-shaped 200-card board: full histories and realistic text, so the
// budget below is measured on a board the size of the reported 4 MB one (the
// entry/byte counts are printed so a regression is visible, not just a pass).
function seedManyCards(rig, count) {
  const tasks = []
  const detail = 'the work is done and proven by the suite; '
  for (let index = 1; index <= count; index += 1) {
    const status = index <= count - 40 ? 'done' : index <= count - 20 ? 'pending' : 'blocked'
    const stamp = '2026-01-' + String((index % 9) + 1).padStart(2, '0') + 'T00:00:00.000Z'
    tasks.push({
      id: 'T-' + String(index),
      title: 'Card ' + String(index) + ' ' + detail.repeat(4),
      kind: 'dev',
      status: status,
      priority: 30,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: stamp,
      history: [
        { at: '2026-01-02T00:00:00.000Z', from: null, to: 'pending', note: 'created' },
        { at: '2026-01-03T00:00:00.000Z', from: 'pending', to: 'running', note: 'dispatched to a worker by the host' },
        { at: '2026-01-04T00:00:00.000Z', from: 'running', to: 'reviewing', note: 'submitted with evidence ' + detail.repeat(8) },
        { at: '2026-01-05T00:00:00.000Z', from: 'reviewing', to: 'testing', note: 'approved ' + detail.repeat(8) },
        { at: '2026-01-06T00:00:00.000Z', from: 'testing', to: 'done', note: 'passed ' + detail.repeat(8) },
        { at: '2026-01-07T00:00:00.000Z', from: 'done', to: status, note: 'final ' + detail.repeat(4) },
      ],
      acceptance: 'the card is checked ' + detail.repeat(10),
      spec: 'do the work and prove it ' + detail.repeat(14),
      writeFiles: ['plugin/task-center/api.mjs'],
    })
  }
  const text = JSON.stringify({ version: 1, tasks })
  seedBoard(rig.fs, PROJECT, text)
  return text.length
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
  const boardBytes = seedManyCards(perfRig, 200)
  const perfSurface = install(perfRig)
  const coreStarted = Date.now()
  const coreRes = await call(perfSurface, STATE_PATH + '?light=1&timings=1', {})
  const coreMs = Date.now() - coreStarted
  const corePayload = coreRes.json()
  check('T-210 the 200-card light answer is complete', corePayload.ok === true && corePayload.counts.total === 200, JSON.stringify(corePayload.counts))
  const coreBytes = JSON.stringify(corePayload).length
  check('T-210 the 200-card core answer is under 200 ms', coreMs < 200, String(coreMs) + 'ms  segments=' + JSON.stringify(corePayload.timings === undefined ? null : corePayload.timings.segments))
  check('T-210 the light answer stays a fraction of the board', corePayload.tasks.length <= 200 && coreBytes < boardBytes, 'payload=' + String(coreBytes) + 'B board=' + String(boardBytes) + 'B')
  // Cold metadata first (the cache is per project+session, the previous blocks
  // used another project), then the WARM answer the 2.5 s poll sees.
  await call(perfSurface, META_PATH, {})
  const warmStarted = Date.now()
  const warmRes = await call(perfSurface, META_PATH + '?timings=1', {})
  const warmMs = Date.now() - warmStarted
  const warmPayload = warmRes.json()
  check('T-210 the warm 200-card metadata is a cache hit', warmPayload.ok === true && warmPayload.cache === 'hit', warmPayload.cache)
  check('T-210 the warm 200-card metadata is under 2 s', warmMs < 2000, String(warmMs) + 'ms  segments=' + JSON.stringify(warmPayload.timings === undefined ? null : warmPayload.timings.segments))
  console.log(
    'PASS  T-210 200 cards: core ' + String(coreMs) + 'ms (<200, ' + String(coreBytes) + 'B), warm metadata ' + String(warmMs) + 'ms (<2000, ' + String(JSON.stringify(warmPayload).length) + 'B), board ' + String(boardBytes) + 'B',
  )
}

// ── T-232: ONE board decode per file version, not one per request ──────────
// The 5.24 MB board used to be read + JSON.parse'd by every /state, /meta and
// action answer. The read layer is now stat-validated and cached, so a warm poll
// decodes zero boards and a write never reads through the memo — while the answer
// is still exactly the file the write landed. Counted at the fs boundary, and
// cross-checked with the named timings counters the panel can ask for.
{
  const cacheRig = createRig({ taskAgents: createFakeTaskAgents() })
  seedBoard(cacheRig.fs, PROJECT, JSON.stringify({ version: 2, seq: 2, tasks: [{ id: 'T-1', title: 'first', status: 'pending', kind: 'dev' }] }))
  const cacheSurface = install(cacheRig)
  const boardFile = boardPath(PROJECT)
  let boardReads = 0
  const realReadText = cacheRig.fs.readText
  cacheRig.fs.readText = async function (target, signal) {
    if (String(target.targetKey) === boardFile) boardReads += 1
    return realReadText.call(this, target, signal)
  }
  const poll = async (extra) => {
    const res = await call(cacheSurface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT) + '&light=1&timings=1' + (extra === undefined ? '' : extra), {})
    return res.json()
  }
  // The module-level post() targets the FIRST surface; this rig needs its own.
  const postTo = async (body) => {
    const res = response()
    await cacheSurface.byPath.get(ACTION_PATH).handler(
      request(ACTION_PATH + '?project=' + encodeURIComponent(PROJECT) + '&session=' + encodeURIComponent(TEST_SESSION), { method: 'POST', body: body, headers: { 'content-type': 'application/json' } }),
      res,
    )
    return res
  }
  const cold = await poll()
  check('T-232 the first poll decodes the board once', cold.ok === true && cold.counts.total === 1 && boardReads === 1, JSON.stringify({ ok: cold.ok, boardReads: boardReads }))
  check('T-232 the cold poll names the decode', cold.timings.counts.boardParse === 1 && cold.timings.counts.boardCached === 0, JSON.stringify(cold.timings.counts))
  const warm = await poll()
  check('T-232 a second poll inside one version decodes NOTHING', warm.ok === true && warm.counts.total === 1 && boardReads === 1, JSON.stringify({ boardReads: boardReads }))
  check('T-232 the warm poll proves the hit in its counters', warm.timings.counts.boardParse === 0 && warm.timings.counts.boardCached >= 1, JSON.stringify(warm.timings.counts))
  check('T-232 the warm answer is still the board', Array.isArray(warm.tasks) && warm.tasks.length === 1 && warm.tasks[0].id === 'T-1' && warm.version !== undefined, warm.text === undefined ? '' : JSON.stringify({ tasks: warm.tasks.length }))

  // /meta: a COLD metadata build still must not decode a board it can read from
  // the memo, and a WARM one is the TTL answer plus the cached board.
  const metaCold = (await call(cacheSurface, META_PATH + '?project=' + encodeURIComponent(PROJECT) + '&timings=1', {})).json()
  check('T-232 a cold /meta reads the memo instead of decoding', metaCold.ok === true && metaCold.cache === 'miss' && metaCold.timings.counts.boardParse === 0 && boardReads === 1, JSON.stringify({ cache: metaCold.cache, counts: metaCold.timings === undefined ? null : metaCold.timings.counts, boardReads: boardReads }))
  const metaWarm = (await call(cacheSurface, META_PATH + '?project=' + encodeURIComponent(PROJECT) + '&timings=1', {})).json()
  check('T-232 a warm /meta is the TTL answer and decodes nothing', metaWarm.ok === true && metaWarm.cache === 'hit' && metaWarm.timings.counts.boardParse === 0 && boardReads === 1, JSON.stringify({ cache: metaWarm.cache, counts: metaWarm.timings === undefined ? null : metaWarm.timings.counts, boardReads: boardReads }))

  // A real write: the write path reads the FILE (never the memo), and what it
  // wrote becomes the memo — so the poll right after costs no decode but is new.
  const created = (await postTo({ action: 'create', title: 'second', verification: { probes: [{ id: 'suite', command: 'npm test' }] } })).json()
  check('T-232 the create writes through the file, not the memo', created.ok === true && boardReads === 2, JSON.stringify({ ok: created.ok, boardReads: boardReads }))
  const afterWrite = await poll()
  check('T-232 the poll after a write shows the new card', afterWrite.ok === true && afterWrite.counts.total === 2 && afterWrite.tasks.some((task) => task.id === created.task.id), JSON.stringify({ total: afterWrite.counts === undefined ? null : afterWrite.counts.total }))
  check('T-232 ... and decodes nothing: the write refreshed the memo with what it wrote', afterWrite.timings.counts.boardParse === 0 && afterWrite.timings.counts.boardCached >= 1 && boardReads === 2, JSON.stringify({ counts: afterWrite.timings === undefined ? null : afterWrite.timings.counts, boardReads: boardReads }))

  // The read-only routes share the same read: /list and /task do not re-decode.
  const list = (await call(cacheSurface, LIST_PATH + '?project=' + encodeURIComponent(PROJECT), {})).json()
  const detail = (await call(cacheSurface, TASK_PATH + '?project=' + encodeURIComponent(PROJECT) + '&id=' + encodeURIComponent('T-1'), {})).json()
  check('T-232 the list and detail routes read the same memo', list.ok === true && detail.ok === true && boardReads === 2, JSON.stringify({ list: list.ok, detail: detail.ok, boardReads: boardReads }))

  // openProject is the other hot path named in the task: binding twice must not
  // decode the board again.
  const openedOne = (await postTo({ action: 'openProject', path: PROJECT })).json()
  const openedTwo = (await postTo({ action: 'openProject', path: PROJECT })).json()
  check(
    'T-232 a repeated openProject is answered off the memo, not a re-decode',
    openedOne.ok === true && openedTwo.ok === true && boardReads === 2 && Array.isArray(openedTwo.tasks) && openedTwo.tasks.length === 2,
    JSON.stringify({ ok: openedOne.ok, boardReads: boardReads, tasks: openedTwo.tasks === undefined ? null : openedTwo.tasks.length }),
  )

  // Another process writes the board: the next poll MUST decode the new file and
  // must not answer from anything this host remembered.
  cacheRig.fs.files.set(boardFile, { text: JSON.stringify({ version: 2, seq: 7, tasks: [{ id: 'T-7', title: 'foreign', status: 'pending', kind: 'dev' }] }), version: 'v-foreign' })
  const foreign = await poll()
  check('T-232 a write by another process is seen on the next poll', foreign.ok === true && boardReads === 3 && foreign.counts.total === 1 && foreign.tasks[0].id === 'T-7' && foreign.timings.counts.boardParse === 1, JSON.stringify({ boardReads: boardReads, ids: foreign.tasks === undefined ? null : foreign.tasks.map((task) => task.id), counts: foreign.timings === undefined ? null : foreign.timings.counts }))
  console.log('PASS  T-232 board reads are stat-validated: warm polls decode nothing, writes and foreign edits are never stale')
}

console.log(failures === 0 ? '\nPASS  task routes (v3 snapshot)' : '\nFAIL  ' + String(failures) + ' route check(s)')
process.exit(failures === 0 ? 0 : 1)
