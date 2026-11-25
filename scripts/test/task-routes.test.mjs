// HTTP route tests (v3): the GUI contract, transport hardening, and the fact
// that /state carries NO legacy Team snapshot. The retired fields (workers /
// teams / agents / team) must not come back; the panel reads agentTree + scope.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTaskRoutes, STATE_PATH, META_PATH, ACTION_PATH, TASK_PATH, LIST_PATH, WORKTREES_PATH, ACTIVITY_PATH, DIAGNOSTICS_PATH } from '../../plugin/task-center/routes.mjs'
import { pruneBoundedCache } from '../../plugin/task-center/api.mjs'
import { boardCacheStats, boardPath } from '../../plugin/task-center/board.mjs'
import { tasksArchivePath } from '../../plugin/task-center/archive.mjs'
import { createSessionArchive } from '../../plugin/task-center/state.mjs'
import { TASK_LEASE_MS } from '../../plugin/task-center/schema.mjs'
import { createFakeTaskAgents, createRig, createTask, PROJECT, seedBoard, sleep } from './support/fixtures.mjs'

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
check('registers state, meta, activity, action, task, list, worktrees and diagnostics', surface.specs.length === 8, String(surface.specs.length))
check(
  'the registered paths are the documented ones',
  [STATE_PATH, META_PATH, ACTIVITY_PATH, ACTION_PATH, TASK_PATH, LIST_PATH, WORKTREES_PATH, DIAGNOSTICS_PATH].every((path) => surface.byPath.has(path)),
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
  const payload = res.json()
  check('the worktrees route answers', payload.ok === true && Array.isArray(payload.worktrees), res.text)
  // T-236: the probe answer is the WHOLE worktrees block now (inventory numbers
  // included), so the status card reads one answer instead of combining /meta's
  // inventory with this route's probes.
  check(
    'T-236 the worktrees answer carries the inventory numbers',
    payload.available === true && Number.isFinite(payload.total) && Number.isFinite(payload.active) && payload.counts !== undefined && payload.counts !== null,
    JSON.stringify({ total: payload.total, active: payload.active, counts: payload.counts }),
  )
  check('T-236 ...and names the paths it probed', payload.requested === null, JSON.stringify(payload.requested))
}

// ── T-236: the activity timeline has its OWN cursored endpoint ──────────────
{
  let res = await call(surface, ACTIVITY_PATH, {})
  let payload = res.json()
  check('the activity route answers', payload.ok === true && Array.isArray(payload.entries) && payload.source === 'board', res.text)
  check(
    'the activity answer carries a cursor and the board revision it was derived from',
    typeof payload.nextCursor === 'string' && payload.nextCursor === payload.cursor && Number.isFinite(payload.revision),
    JSON.stringify({ cursor: payload.cursor, nextCursor: payload.nextCursor, revision: payload.revision }),
  )
  const cursor = payload.nextCursor
  check('the unfiltered page is newest first and bounded', payload.count >= 1 && payload.count <= payload.limit && typeof payload.entries[0].key === 'string', JSON.stringify({ count: payload.count, limit: payload.limit }))

  // The cursor makes the read INCREMENTAL: nothing new since it, so nothing is
  // re-delivered and the cursor stays where the client already is.
  res = await call(surface, ACTIVITY_PATH + '?cursor=' + encodeURIComponent(cursor), {})
  payload = res.json()
  check(
    'a cursored activity read delivers only NEW events',
    payload.ok === true && payload.count === 0 && payload.entries.length === 0 && payload.nextCursor === cursor,
    JSON.stringify({ count: payload.count, nextCursor: payload.nextCursor }),
  )

  // A write moves the timeline: the SAME cursor now yields exactly that event.
  const created = await post({ action: 'create', title: 'T-236 activity card', verification: { probes: [{ id: 'suite', command: 'npm test' }] } })
  check('the write that moves the timeline lands', created.json().ok === true, created.text)
  res = await call(surface, ACTIVITY_PATH + '?cursor=' + encodeURIComponent(cursor), {})
  payload = res.json()
  check(
    'the cursor delivers exactly the new event',
    payload.ok === true && payload.count === 1 && payload.entries[0].kind === 'create' && payload.entries[0].taskId === created.json().task.id,
    JSON.stringify(payload.entries),
  )
  check('the next cursor moves past the delivered event', typeof payload.nextCursor === 'string' && payload.nextCursor !== cursor, String(payload.nextCursor))

  // ?since= is the same cursor under its older spelling; ?limit= bounds the page.
  res = await call(surface, ACTIVITY_PATH + '?since=' + encodeURIComponent(cursor) + '&limit=1', {})
  payload = res.json()
  check('since= is accepted as the cursor and limit bounds the page', payload.ok === true && payload.count === 1 && payload.limit === 1, JSON.stringify({ count: payload.count, limit: payload.limit }))

  // No project bound is the same SETUP answer every other read gives.
  rig.state.setSessionRoot(TEST_SESSION, null)
  res = await call(surface, ACTIVITY_PATH, {})
  check('activity without a bound project answers no-project-bound', res.json().ok === false && res.json().code === 'no-project-bound', res.text)
  rig.state.setSessionRoot(TEST_SESSION, PROJECT)
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
    // T-239: the executor tree is read only for owners of cards still IN PROGRESS
    // (this board's only card is pending, so there is nothing to judge for a
    // takeover). The host-read proof is the SCOPE's own session evidence: the
    // answer read the hot working set it was asked for.
    const afterOpen = (await call(lightSurface, META_PATH + '?refresh=1', {})).json()
    check(
      'T-210 the deferred half is ONE /meta request away after opening',
      afterOpen.ok === true && afterOpen.meta.agentTree.available === true && afterOpen.meta.agentTree.root.id === TEST_SESSION && afterOpen.meta.scope !== null && afterOpen.meta.scope.processed >= 1,
      JSON.stringify({ ok: afterOpen.ok, tree: afterOpen.meta.agentTree === undefined ? null : afterOpen.meta.agentTree.available, scope: afterOpen.meta.scope === null || afterOpen.meta.scope === undefined ? null : afterOpen.meta.scope.processed }),
    )
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

// ── T-238: a FRESH lease is not a board write; a due one is ONE write ──────
// Every agent tool call used to run a heartbeat that rewrote the whole board
// (read the file, clone it, pretty-print it, write it), serialised on the board
// path. A board lease is an hour, so a call inside its first half has nothing to
// renew: it answers off the parsed-board memo and never touches the file. Of the
// cards one caller owns, only the ones inside the window move — in ONE CAS write —
// and simultaneous calls of the same owner share that write (single flight).
{
  const TTL_MS = TASK_LEASE_MS
  const clock = { at: Date.parse('2026-03-01T00:00:00.000Z') }
  const beatRig = createRig({ taskAgents: createFakeTaskAgents(), now: () => clock.at })
  const WORKER = 'session-worker-t-238'
  const isoAt = (at) => new Date(at).toISOString()
  const boardFile = boardPath(PROJECT)
  const runningCard = (id, leaseMs, session) => ({
    id: id,
    title: 'card ' + id,
    kind: 'dev',
    status: 'running',
    assignee: { name: 'worker-t-238', session: session === undefined ? WORKER : session },
    leaseUntil: isoAt(clock.at + leaseMs),
    updatedAt: isoAt(clock.at),
    history: [{ at: isoAt(clock.at), by: 'scheduler', from: null, to: 'running', note: 'dispatched' }],
  })
  let seeded = 0
  const seedTasks = (tasks) => {
    seeded += 1
    beatRig.fs.files.set(boardFile, { text: JSON.stringify({ version: 2, seq: 20 + seeded, tasks: tasks }), version: 'seed-' + String(seeded) })
  }
  // The fake fs bumps its version on every write — the identity the real facade
  // reports as mtime — so "the file did not move" is provable without a clock.
  const fileText = () => String(beatRig.fs.files.get(boardFile).text)
  const fileVersion = () => String(beatRig.fs.files.get(boardFile).version)
  const fileJson = () => JSON.parse(fileText())
  let boardWrites = 0
  const realWriteText = beatRig.fs.writeText
  beatRig.fs.writeText = async function (...args) {
    if (String(args[0].targetKey) === boardFile) boardWrites += 1
    return realWriteText.apply(beatRig.fs, args)
  }
  // Counted at the state seam: a skipped heartbeat must not even ATTEMPT a write.
  let applies = 0
  const realApply = beatRig.state.apply
  beatRig.state.apply = async function (...args) {
    applies += 1
    return realApply.apply(beatRig.state, args)
  }
  const worker = { projectPath: PROJECT, by: '@worker-t-238', role: 'agent', agent: { id: WORKER, name: 'worker-t-238' } }
  const beat = (id) => beatRig.api.perform('get', { id: id === undefined ? 'T-1' : id }, worker)

  // Fresh lease (55 of 60 minutes left): 20 calls write nothing, change nothing.
  seedTasks([runningCard('T-1', TTL_MS - 5 * 60 * 1000)])
  await beatRig.state.read(PROJECT) // decode once, so the calls below are measured on a warm memo
  const freshText = fileText()
  const freshVersion = fileVersion()
  const freshParses = boardCacheStats(beatRig.fs).parses
  for (let index = 0; index < 20; index += 1) await beat()
  check(
    'T-238 20 tool calls on a fresh lease write the board ZERO times',
    boardWrites === 0 && applies === 0 && fileText() === freshText && fileVersion() === freshVersion,
    JSON.stringify({ writes: boardWrites, applies: applies, sameText: fileText() === freshText, version: fileVersion() }),
  )
  check(
    'T-238 the fresh-lease calls do not move the board identity and decode nothing',
    fileVersion() === freshVersion && boardCacheStats(beatRig.fs).parses === freshParses,
    JSON.stringify({ version: fileVersion(), parses: boardCacheStats(beatRig.fs).parses - freshParses }),
  )
  await Promise.all(Array.from({ length: 60 }, () => beat()))
  check(
    'T-238 60 concurrent fresh-lease calls still write the board ZERO times',
    boardWrites === 0 && applies === 0 && fileText() === freshText && fileVersion() === freshVersion,
    JSON.stringify({ writes: boardWrites, applies: applies, sameText: fileText() === freshText }),
  )

  // Skipping the board write must not let a FILE lock lapse: locks live in host
  // memory, so they stay renewed even when the board is not touched.
  beatRig.state.memory.locks = { 'scripts/a.gd': { path: 'scripts/a.gd', taskId: 'T-1', agent: 'worker-t-238', since: isoAt(clock.at - 1000), leaseUntil: isoAt(clock.at + 1000) } }
  await beat()
  const keptLock = beatRig.state.memory.locks['scripts/a.gd']
  check(
    'T-238 a skipped board write still renews the in-memory file lock',
    boardWrites === 0 && applies === 0 && keptLock !== undefined && Date.parse(keptLock.leaseUntil) === clock.at + TTL_MS,
    JSON.stringify({ writes: boardWrites, lease: keptLock === undefined ? null : keptLock.leaseUntil, expected: isoAt(clock.at + TTL_MS) }),
  )
  beatRig.state.memory.locks = {}

  // Inside the window: exactly one write, the full TTL, the activity stamp.
  clock.at += 30 * 60 * 1000 // 25 minutes left now
  const dueVersion = fileVersion()
  await beat()
  const renewed = fileJson()
  check('T-238 a call inside the renewal window writes the board exactly ONCE', boardWrites === 1 && applies === 1, JSON.stringify({ writes: boardWrites, applies: applies }))
  check(
    'T-238 the renewal extends the full TTL, stamps the activity time and keeps the card running',
    renewed.tasks.length === 1 &&
      renewed.tasks[0].leaseUntil === isoAt(clock.at + TTL_MS) &&
      renewed.tasks[0].updatedAt === isoAt(clock.at) &&
      renewed.tasks[0].status === 'running' &&
      fileVersion() !== dueVersion,
    JSON.stringify({ lease: renewed.tasks[0].leaseUntil, expected: isoAt(clock.at + TTL_MS), updatedAt: renewed.tasks[0].updatedAt, status: renewed.tasks[0].status }),
  )
  const parsesAfterRenewal = boardCacheStats(beatRig.fs).parses
  const afterRenewal = await beatRig.state.read(PROJECT)
  check(
    'T-238 the read right after a renewal is the memo of what was WRITTEN (no decode, new lease)',
    afterRenewal.cached === true && afterRenewal.board.tasks[0].leaseUntil === isoAt(clock.at + TTL_MS) && boardCacheStats(beatRig.fs).parses === parsesAfterRenewal,
    JSON.stringify({ cached: afterRenewal.cached, lease: afterRenewal.board.tasks[0].leaseUntil, parses: boardCacheStats(beatRig.fs).parses - parsesAfterRenewal }),
  )

  // The write is bounded by the window: quiet for the rest of TTL, one per window.
  await Promise.all(Array.from({ length: 5 }, () => beat()))
  clock.at += 29 * 60 * 1000 // 31 minutes left
  await beat()
  check('T-238 a renewed lease stays quiet for the rest of its window', boardWrites === 1 && applies === 1, JSON.stringify({ writes: boardWrites, applies: applies }))
  clock.at += 2 * 60 * 1000 // 29 minutes left -> inside the window again
  await beat()
  check('T-238 the next window costs exactly one more write', boardWrites === 2 && applies === 2, JSON.stringify({ writes: boardWrites, applies: applies }))

  // A lapsed lease is still revived by the worker's own call (one write).
  clock.at += 3 * TTL_MS
  await beat()
  check(
    'T-238 a lapsed lease is revived by exactly one write while the worker keeps calling',
    boardWrites === 3 && applies === 3 && Date.parse(fileJson().tasks[0].leaseUntil) === clock.at + TTL_MS,
    JSON.stringify({ writes: boardWrites, lease: fileJson().tasks[0].leaseUntil }),
  )

  // Two cards of the same owner: only the due one moves; the fresh one is untouched.
  clock.at += 5 * 60 * 1000
  const freshCard = runningCard('T-2', 40 * 60 * 1000)
  seedTasks([runningCard('T-1', 1000), freshCard])
  await beat()
  const two = fileJson()
  const mine = two.tasks.filter((task) => task.id === 'T-1')[0]
  const other = two.tasks.filter((task) => task.id === 'T-2')[0]
  check(
    'T-238 a due card is renewed without touching a fresh card of the same owner',
    boardWrites === 4 &&
      applies === 4 &&
      two.tasks.length === 2 &&
      mine.leaseUntil === isoAt(clock.at + TTL_MS) &&
      other.leaseUntil === freshCard.leaseUntil &&
      other.updatedAt === freshCard.updatedAt,
    JSON.stringify({ writes: boardWrites, mine: mine.leaseUntil, other: other.leaseUntil, expected: freshCard.leaseUntil }),
  )

  // Ten simultaneous calls inside the window share ONE renewal write. The first
  // renewal's board read is held for one macrotask: every other call was started
  // in the same tick, so it reaches the heartbeat and joins the flight before the
  // write can land — the test proves the coalescing instead of racing for it.
  seedTasks([runningCard('T-1', 1000)])
  await beatRig.state.read(PROJECT) // warm the memo before arming the gate
  const concurrentWrites = boardWrites
  const concurrentApplies = applies
  const realStateRead = beatRig.state.read
  let gate = true
  beatRig.state.read = async function (...args) {
    if (gate === true) {
      gate = false
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return realStateRead.apply(beatRig.state, args)
  }
  try {
    await Promise.all(Array.from({ length: 10 }, () => beat()))
  } finally {
    beatRig.state.read = realStateRead
  }
  check(
    'T-238 ten simultaneous calls inside the window share ONE renewal write',
    boardWrites === concurrentWrites + 1 && applies === concurrentApplies + 1,
    JSON.stringify({ writes: boardWrites - concurrentWrites, applies: applies - concurrentApplies }),
  )

  // Lost CAS: another writer lands a card of its own first. The renewal must
  // re-read the file, keep that card and still renew ours.
  seedTasks([runningCard('T-1', 1000)])
  const foreignCard = runningCard('T-9', 50 * 60 * 1000, 'session-other-worker')
  foreignCard.assignee = { name: 'other-worker', session: 'session-other-worker' }
  let interfered = false
  beatRig.fs.hooks.beforeWrite = function (intercept) {
    // The fs hook sees every write (the session registry included): only the
    // board write races here.
    if (String(intercept.key) !== boardFile || interfered === true) return undefined
    interfered = true
    const current = JSON.parse(fileText())
    current.tasks.push(foreignCard)
    intercept.write(JSON.stringify(current))
    return 'stale'
  }
  const casWrites = boardWrites
  try {
    await beat()
  } finally {
    beatRig.fs.hooks.beforeWrite = null
  }
  const merged = fileJson()
  const mergedMine = merged.tasks.filter((task) => task.id === 'T-1')[0]
  const mergedOther = merged.tasks.filter((task) => task.id === 'T-9')[0]
  check(
    'T-238 a lost CAS re-reads the file, keeps the other card and still renews ours',
    interfered === true &&
      boardWrites === casWrites + 2 && // one stale attempt, then the landing write
      merged.tasks.length === 2 &&
      mergedOther !== undefined &&
      mergedOther.leaseUntil === foreignCard.leaseUntil &&
      mergedOther.updatedAt === foreignCard.updatedAt &&
      mergedMine.leaseUntil === isoAt(clock.at + TTL_MS),
    JSON.stringify({ writes: boardWrites - casWrites, ids: merged.tasks.map((task) => task.id), mine: mergedMine === undefined ? null : mergedMine.leaseUntil, other: mergedOther === undefined ? null : mergedOther.leaseUntil }),
  )
  console.log('PASS  T-238 a fresh lease writes nothing; a due lease writes once and concurrent calls share it')
}

// ── T-239: /meta answers a HOT scope, pages the rest, and builds it ONCE ────
// A project with 66 participating sessions used to make a cold /meta read EVERY
// session's evidence (its DSH directory and its workspace): 14.1 s at 66, linear
// growth after that, and parallelising it only hid the trend. The default answer
// is now the hot working set (the asking session + the newest `limit`), the rest
// is paged on a keyset cursor, and the scope build is cached and single-flighted
// per PROJECT with a short TTL — two panels on one project share ONE read.
{
  // The liveness read must never walk the developer's real ~/.dsh/sessions: a
  // fixture path makes the count deterministic (and fast) on any host.
  const savedSessionsDir = process.env.GODOT_BRIDGE_SESSIONS_DIR
  process.env.GODOT_BRIDGE_SESSIONS_DIR = join(PROJECT, 'fixture-sessions')
  try {
    const NUMBERED = 65
    const sessionIds = []
    for (let index = 0; index < NUMBERED; index += 1) sessionIds.push('session-' + String(index).padStart(2, '0'))
    // The asking session sorts LAST on the lightweight index when nothing has
    // stamped it (no lastSeenAt), so "it leads the page" cannot be recency.
    sessionIds.push('session-lead')
    const total = sessionIds.length
    const longBoard = () => {
      const tasks = sessionIds.map((sessionId, index) => ({
        id: 'T-' + String(index + 1),
        title: 'card of ' + sessionId,
        kind: 'dev',
        status: 'done',
        ownerSession: sessionId,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }))
      return JSON.stringify({ version: 2, seq: 5, tasks: tasks })
    }
    // One card still IN PROGRESS, owned by a session that is NOT on the hot page.
    const inFlight = (tasks) => {
      tasks.push({
        id: 'T-99',
        title: 'in flight',
        kind: 'dev',
        status: 'running',
        ownerSession: 'session-70',
        assignee: { name: 'worker-70', session: 'session-70' },
        leaseUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
      })
      return tasks
    }
    const metaCall = async (surface, query) => {
      const res = response()
      await surface.byPath.get(META_PATH).handler(request(META_PATH + '?' + query), res)
      return res.json()
    }
    const queryOf = (sessionId, extra) =>
      'project=' + encodeURIComponent(PROJECT) + '&session=' + encodeURIComponent(sessionId) + (extra === undefined ? '' : '&' + extra)

    // 1) The default answer: hot 20 of 66, total 66, truncated, current first.
    {
      const rig = createRig({ taskAgents: createFakeTaskAgents() })
      seedBoard(rig.fs, PROJECT, longBoard())
      const surface = install(rig)
      const hot = await metaCall(surface, queryOf(TEST_SESSION, 'timings=1'))
      const hotScope = hot.ok === true && hot.meta !== null && typeof hot.meta === 'object' ? hot.meta.scope : null
      check('T-239 the default /meta answers', hot.ok === true && hotScope !== null, JSON.stringify({ ok: hot.ok }).substring(0, 300))
      check('T-239 the default scope carries the WHOLE project total', hotScope !== null && hotScope.total === total, JSON.stringify({ total: hotScope === null ? null : hotScope.total }))
      check(
        'T-239 the default scope is the hot working set only',
        hotScope !== null && hotScope.sessions.length === 20 && hotScope.summaries.length === 20 && hotScope.limit === 20 && hotScope.mode === 'hot',
        JSON.stringify({ sessions: hotScope === null ? null : hotScope.sessions.length, limit: hotScope === null ? null : hotScope.limit }),
      )
      check('T-239 the hot answer is TRUNCATED and carries a cursor', hotScope !== null && hotScope.truncated === true && typeof hotScope.nextCursor === 'string' && hotScope.nextCursor !== '', JSON.stringify({ truncated: hotScope === null ? null : hotScope.truncated }))
      check('T-239 the asking session leads the hot page', hotScope !== null && hotScope.sessions[0].sessionId === TEST_SESSION && hotScope.summaries[0].sessionId === TEST_SESSION, JSON.stringify(hotScope === null ? null : hotScope.sessions.slice(0, 2)))
      check(
        'T-239 the cold scope PROCESSED only the hot page',
        hotScope !== null && hotScope.processed === 20 && hot.timings.counts.scopeBuild === 1 && hot.timings.counts.scopeSessions === 20,
        JSON.stringify({ processed: hotScope === null ? null : hotScope.processed, counts: hot.timings === undefined ? null : hot.timings.counts }),
      )
      check(
        'T-239 the cold scope read ONE liveness sample per hot session',
        hot.timings.counts.sessionActivity === 20 && hot.timings.counts.sessionActivityCached === 0,
        JSON.stringify(hot.timings.counts),
      )
      check(
        'T-239 the old scope fields describe the SAME page',
        hotScope !== null &&
          Array.isArray(hotScope.projectSessions) &&
          hotScope.projectSessions.length === 20 &&
          hotScope.projectSessions[0].sessionId === TEST_SESSION &&
          Array.isArray(hotScope.sessionSummaries) &&
          hotScope.sessionSummaries.length === 20,
        JSON.stringify({ sessions: hotScope === null ? null : hotScope.projectSessions === undefined ? null : hotScope.projectSessions.length }),
      )
      check(
        'T-239 the old metadata blocks still answer',
        hot.meta.agentTree !== undefined && hot.meta.worktrees !== undefined && hot.meta.environment !== undefined && hot.meta.decisionPolicy !== null && hot.meta.scope.handoff !== null,
        JSON.stringify(Object.keys(hot.meta === null ? {} : hot.meta)),
      )

      // 2) The cursor walks the remaining 46 exactly once, light on every page.
      const seen = hotScope.sessions.map((row) => row.sessionId)
      const pages = [hotScope]
      let cursor = hotScope.nextCursor
      let historyHostReads = 0
      while (cursor !== null && pages.length < 6) {
        const page = await metaCall(surface, queryOf(TEST_SESSION, 'scope=history&limit=20&cursor=' + encodeURIComponent(cursor) + '&timings=1'))
        const pageScope = page.ok === true && page.meta !== null && typeof page.meta === 'object' ? page.meta.scope : null
        if (pageScope === null) {
          check('T-239 a history page answers', false, JSON.stringify(page).substring(0, 200))
          break
        }
        pages.push(pageScope)
        historyHostReads += page.timings.counts.sessionActivity + page.timings.counts.agentList
        seen.push.apply(seen, pageScope.sessions.map((row) => row.sessionId))
        cursor = pageScope.nextCursor
      }
      check(
        'T-239 the cursor pages the whole project EXACTLY once',
        pages.length === 4 && seen.length === total && new Set(seen).size === total,
        JSON.stringify({ pages: pages.length, seen: seen.length, unique: new Set(seen).size }),
      )
      check('T-239 every page reports the project total', pages.every((page) => page.total === total), JSON.stringify(pages.map((page) => page.total)))
      check(
        'T-239 the last page ends the history',
        pages[pages.length - 1].nextCursor === null && pages[pages.length - 1].truncated === false && pages[pages.length - 1].sessions.length === total - 60,
        JSON.stringify({ last: pages[pages.length - 1].sessions.length, next: pages[pages.length - 1].nextCursor }),
      )
      check(
        'T-239 a history page is LIGHTWEIGHT: index rows only, summaries deferred',
        pages[1].summaries.length === 0 && pages[1].summariesDeferred === true && pages[1].mode === 'history' && pages[1].cache === 'hit' && historyHostReads === 0,
        JSON.stringify({ summaries: pages[1].summaries.length, cache: pages[1].cache, reads: historyHostReads }),
      )

      // 2b) `limit` is honoured as a page size (default 20), and the cursor still
      // covers the whole history.
      const small = await metaCall(surface, queryOf(TEST_SESSION, 'limit=5'))
      check(
        'T-239 limit sets the page size',
        small.ok === true && small.meta.scope.limit === 5 && small.meta.scope.sessions.length === 5 && small.meta.scope.truncated === true && small.meta.scope.sessions[0].sessionId === TEST_SESSION,
        JSON.stringify({ limit: small.meta.scope === null ? null : small.meta.scope.limit, sessions: small.meta.scope === null ? null : small.meta.scope.sessions.length }),
      )
      const smallNext = await metaCall(surface, queryOf(TEST_SESSION, 'scope=history&limit=5&cursor=' + encodeURIComponent(small.meta.scope.nextCursor)))
      check(
        'T-239 the smaller page continues without repeating a row',
        smallNext.ok === true &&
          smallNext.meta.scope.sessions.length === 5 &&
          smallNext.meta.scope.sessions.every((row) => small.meta.scope.sessions.every((seen) => seen.sessionId !== row.sessionId)),
        JSON.stringify(smallNext.meta.scope === null ? null : smallNext.meta.scope.sessions.map((row) => row.sessionId)),
      )

      // 3) A second panel session on the SAME project pays nothing.
      const second = await metaCall(surface, queryOf('session-04', 'timings=1'))
      check(
        'T-239 a second session on the same project reuses ONE scope build',
        second.ok === true &&
          second.meta.scope.cache === 'hit' &&
          second.meta.scope.processed === 20 &&
          second.timings.counts.scopeBuild === 0 &&
          second.timings.counts.scopeBuildCached === 1 &&
          second.timings.counts.sessionActivity === 0 &&
          second.timings.counts.sessionActivityCached === 0,
        JSON.stringify({ cache: second.meta.scope === null ? null : second.meta.scope.cache, counts: second.timings === undefined ? null : second.timings.counts }),
      )
      check('T-239 the second session leads ITS answer', second.meta.scope.sessions[0].sessionId === 'session-04', JSON.stringify(second.meta.scope.sessions.slice(0, 2)))
      console.log('PASS  T-239 /meta answers hot 20 of 66, pages the rest on a cursor, and shares the build')
    }

    // 4) The pin, on the API: nothing has stamped session-lead, so it sorts LAST
    // on the lightweight index — and must still lead the page. The overlay is the
    // ONE row the shared build did not read.
    {
      const pinRig = createRig({ taskAgents: createFakeTaskAgents() })
      seedBoard(pinRig.fs, PROJECT, longBoard())
      const pinned = await pinRig.api.metadata(PROJECT, { sessionId: TEST_SESSION, timings: true })
      const pinScope = pinned.meta.scope
      check(
        'T-239 the current session leads the page even when it is the OLDEST participant',
        pinned.ok === true && pinScope.sessions[0].sessionId === TEST_SESSION && pinScope.summaries[0].sessionId === TEST_SESSION,
        JSON.stringify({ first: pinScope.sessions.slice(0, 2).map((row) => row.sessionId) }),
      )
      check(
        'T-239 the page stays at the limit; the pinned row displaces the tail',
        pinScope.sessions.length === 20 && pinScope.sessions[1].sessionId === 'session-00' && pinScope.sessions.every((row) => row.sessionId !== 'session-19'),
        JSON.stringify(pinScope.sessions.map((row) => row.sessionId)),
      )
      check(
        'T-239 the overlay reads ONLY the current session outside the shared page',
        pinScope.processed === 21 && pinned.timings.counts.scopeSessions === 20 && pinned.timings.counts.sessionActivity === 21,
        JSON.stringify({ processed: pinScope.processed, counts: pinned.timings.counts }),
      )
      const next = await pinRig.api.metadata(PROJECT, { sessionId: TEST_SESSION, scopeMode: 'history', scopeCursor: pinScope.nextCursor })
      check(
        'T-239 the pinned page continues on a cursor without repeating a row',
        next.ok === true && next.meta.scope.sessions[0].sessionId === 'session-19' && next.meta.scope.sessions.every((row) => row.sessionId !== TEST_SESSION),
        JSON.stringify(next.meta.scope === null ? null : next.meta.scope.sessions.slice(0, 2)),
      )
    }

    // 5) Two panels asking AT ONCE share one in-flight build instead of starting
    // two read sequences.
    {
      const flightRig = createRig({ taskAgents: createFakeTaskAgents() })
      seedBoard(flightRig.fs, PROJECT, longBoard())
      let release = null
      const gate = new Promise((resolveGate) => {
        release = resolveGate
      })
      let lookups = 0
      flightRig.state.lookupSessionRoot = async function (sessionId) {
        lookups += 1
        if (lookups === 1) await gate
        return { ok: false, code: 'no-session', message: 'fixture: no workspace' }
      }
      const first = flightRig.api.metadata(PROJECT, { sessionId: TEST_SESSION, timings: true })
      // Wait until the shared build is parked inside its first workspace read.
      while (lookups === 0) await sleep(1)
      const second = flightRig.api.metadata(PROJECT, { sessionId: 'session-04', timings: true })
      await sleep(10)
      release()
      const results = await Promise.all([first, second])
      check(
        'T-239 two panels on one project share ONE in-flight scope build',
        results[0].meta.scope.cache === 'miss' && results[1].meta.scope.cache === 'shared' && results[0].meta.scope.total === total && results[1].meta.scope.total === total,
        JSON.stringify({ a: results[0].meta.scope === null ? null : results[0].meta.scope.cache, b: results[1].meta.scope === null ? null : results[1].meta.scope.cache }),
      )
      check('T-239 the shared build reads the page once, not once per panel', lookups >= 20 && lookups <= 25, JSON.stringify({ lookups: lookups }))
      console.log('PASS  T-239 the current session is pinned and two panels share one build')
    }

    // 6) The TTL: a cached project scope is REUSED inside its window and rebuilt
    // after it. The window is overridden to 1 ms here (per API instance).
    {
      const savedTtl = process.env.GODOT_BRIDGE_SCOPE_TTL_MS
      process.env.GODOT_BRIDGE_SCOPE_TTL_MS = '1'
      try {
        const ttlRig = createRig({ taskAgents: createFakeTaskAgents() })
        seedBoard(ttlRig.fs, PROJECT, longBoard())
        const ttlSurface = install(ttlRig)
        const first = await metaCall(ttlSurface, queryOf(TEST_SESSION, 'timings=1'))
        await sleep(5)
        const again = await metaCall(ttlSurface, queryOf('session-04', 'timings=1'))
        check(
          'T-239 the project scope lives for a short TTL and is rebuilt after it',
          first.meta.scope.cache === 'miss' &&
            again.meta.scope.cache === 'miss' &&
            again.timings.counts.scopeBuild === 1 &&
            again.timings.counts.scopeSessions === 20,
          JSON.stringify({ first: first.meta.scope === null ? null : first.meta.scope.cache, again: again.meta.scope === null ? null : again.meta.scope.cache, counts: again.timings === undefined ? null : again.timings.counts }),
        )
      } finally {
        if (savedTtl === undefined) delete process.env.GODOT_BRIDGE_SCOPE_TTL_MS
        else process.env.GODOT_BRIDGE_SCOPE_TTL_MS = savedTtl
      }
    }

    // 8) A card still IN PROGRESS keeps its owner's liveness readable even when
    // that owner is OUTSIDE the hot page: a live owner must still block takeover.
    {
      const sessionsDir = mkdtempSync(join(tmpdir(), 'gb-t239-'))
      const savedDir = process.env.GODOT_BRIDGE_SESSIONS_DIR
      try {
        mkdirSync(join(sessionsDir, '--fixture-project--'))
        writeFileSync(join(sessionsDir, '--fixture-project--', 'session-session-70'), 'x')
        process.env.GODOT_BRIDGE_SESSIONS_DIR = sessionsDir
        const activeRig = createRig({ taskAgents: createFakeTaskAgents() })
        const tasks = JSON.parse(longBoard()).tasks.slice(0, 30)
        inFlight(tasks)
        seedBoard(activeRig.fs, PROJECT, JSON.stringify({ version: 2, seq: 6, tasks: tasks }))
        const out = await activeRig.api.metadata(PROJECT, { sessionId: TEST_SESSION })
        const scope = out.meta.scope
        check(
          'T-239 a LIVE owner outside the hot page still blocks takeover',
          out.ok === true &&
            scope.handoff.cards.length === 1 &&
            scope.handoff.cards[0].ownerSession === 'session-70' &&
            scope.handoff.cards[0].ownerStatus === 'live' &&
            scope.handoff.eligibility.takeover.ok === false &&
            scope.handoff.eligibility.takeover.blockedBy.some((entry) => entry.reason === 'owning-session-live'),
          JSON.stringify({ cards: scope === null ? null : scope.handoff.cards.length, card: scope === null ? null : scope.handoff.cards[0], ok: scope === null ? null : scope.handoff.eligibility.takeover.ok }),
        )
        check(
          'T-239 ... while the hot page itself stays bounded',
          scope.sessions.length === 20 && scope.total === 31 && scope.processed === 21,
          JSON.stringify({ sessions: scope.sessions.length, total: scope.total, processed: scope.processed }),
        )
      } finally {
        if (savedDir === undefined) delete process.env.GODOT_BRIDGE_SESSIONS_DIR
        else process.env.GODOT_BRIDGE_SESSIONS_DIR = savedDir
        rmSync(sessionsDir, { recursive: true, force: true })
      }
    }

    // 7) An OLD client sends no paging parameters at all: it gets the hot page and
    // the truncated flag, and every field it already reads stays where it was.
    {
      const oldRig = createRig({ taskAgents: createFakeTaskAgents() })
      seedBoard(oldRig.fs, PROJECT, longBoard())
      const oldSurface = install(oldRig)
      const unpaged = await metaCall(oldSurface, queryOf(TEST_SESSION))
      const scope = unpaged.meta.scope
      check(
        'T-239 an unpaged client keeps every field it reads, now covering the hot page',
        unpaged.ok === true &&
          scope.panelSession === TEST_SESSION &&
          scope.panelSessionParticipates === true &&
          typeof scope.currentSessionProject === 'string' &&
          Array.isArray(scope.sessionSummaries) &&
          scope.sessionSummaries.length === 20 &&
          Array.isArray(scope.projectSessions) &&
          scope.projectSessions.length === 20 &&
          scope.light === false &&
          scope.livenessSource === 'host',
        JSON.stringify({ sessions: scope === null ? null : scope.projectSessions.length }),
      )
    }
  } finally {
    if (savedSessionsDir === undefined) delete process.env.GODOT_BRIDGE_SESSIONS_DIR
    else process.env.GODOT_BRIDGE_SESSIONS_DIR = savedSessionsDir
  }
}

// ── T-240: hot scope drops ARCHIVED sessions, history still reaches them ────
// The host's ARCHIVE state is the only source: <home>/.dsh/storages/workspace.json
// → global.archivedSessionIds. A DSH session directory that still exists proves
// the session was SEEN, not that it is active, so it is never the archive source.
// The hot working set is the active sessions (the asking session stays pinned
// even when archived), the history page keeps the archive unless
// includeArchived=false, and the counts describe the whole project.
{
  const sessionsDir = mkdtempSync(join(tmpdir(), 'gb-t240-sessions-'))
  const storageDirs = []
  const savedSessionsDir = process.env.GODOT_BRIDGE_SESSIONS_DIR
  const savedStorage = process.env.GODOT_BRIDGE_WORKSPACE_STORAGE
  try {
    const NUMBERED = 29
    const sessionIds = []
    for (let index = 0; index < NUMBERED; index += 1) sessionIds.push('session-' + String(index).padStart(2, '0'))
    sessionIds.push(TEST_SESSION)
    const total = sessionIds.length
    const ARCHIVED = ['session-02', 'session-05', 'session-09', 'session-13']
    // Liveness fixture: EVERY participant has a session directory, INCLUDING the
    // archived ones. Presence on disk is not archive state.
    mkdirSync(join(sessionsDir, '--fixture-project--'))
    for (const sessionId of sessionIds) writeFileSync(join(sessionsDir, '--fixture-project--', 'session-' + sessionId), 'x')
    process.env.GODOT_BRIDGE_SESSIONS_DIR = sessionsDir
    const storageFor = (archivedIds) => {
      const dir = mkdtempSync(join(tmpdir(), 'gb-t240-store-'))
      storageDirs.push(dir)
      const path = join(dir, 'workspace.json')
      writeFileSync(path, JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: archivedIds }, tables: {} }))
      return path
    }
    const boardOf = () =>
      JSON.stringify({
        version: 2,
        seq: 7,
        tasks: sessionIds.map((sessionId, index) => ({
          id: 'T-' + String(index + 1),
          title: 'card of ' + sessionId,
          kind: 'dev',
          status: 'done',
          ownerSession: sessionId,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        })),
      })
    const metaCall = async (surface, query) => {
      const res = response()
      await surface.byPath.get(META_PATH).handler(request(META_PATH + '?' + query), res)
      return res.json()
    }
    const queryOf = (sessionId, extra) =>
      'project=' + encodeURIComponent(PROJECT) + '&session=' + encodeURIComponent(sessionId) + (extra === undefined ? '' : '&' + extra)
    // Walk one history sequence to its end and collect the rows (and pages).
    const walkScope = async (surface, sessionId, limit, extra) => {
      const pages = []
      const rows = []
      let query = 'scope=history&limit=' + String(limit) + (extra === undefined ? '' : '&' + extra)
      for (let step = 0; step < 10; step += 1) {
        const answer = await metaCall(surface, queryOf(sessionId, query))
        const scope = answer.ok === true && answer.meta !== null && typeof answer.meta === 'object' ? answer.meta.scope : null
        if (scope === null) return { ok: false, pages: pages, rows: rows }
        pages.push(scope)
        for (const row of scope.sessions) rows.push(row)
        if (scope.nextCursor === null || scope.nextCursor === undefined) return { ok: true, pages: pages, rows: rows }
        query = 'scope=history&limit=' + String(limit) + '&cursor=' + encodeURIComponent(scope.nextCursor) + (extra === undefined ? '' : '&' + extra)
      }
      return { ok: false, pages: pages, rows: rows }
    }

    // 0) The reader itself: host store in, nothing guessed from the tree.
    {
      const storagePath = storageFor(ARCHIVED.concat(['session-99']))
      const reader = createSessionArchive({ storagePath: storagePath })
      check('T-240 the host store is the archive source', reader.isArchived('session-02') === true && reader.isArchived('session-99') === true)
      check(
        'T-240 a session that merely HAS a directory is not archived',
        reader.isArchived('session-00') === false && reader.isArchived(TEST_SESSION) === false && reader.archivedSessionIds().size === 5,
      )
      check('T-240 both id spellings name the same session', reader.isArchived('02') === true && reader.isArchived('session-02') === true)
      const missing = createSessionArchive({ storagePath: join(sessionsDir, 'no-such-workspace.json') })
      check('T-240 a host without the store archives NOTHING', missing.archivedSessionIds().size === 0 && missing.isArchived('session-02') === false)
      const brokenPath = join(storageDirs[0], 'broken.json')
      writeFileSync(brokenPath, '{not json')
      const broken = createSessionArchive({ storagePath: brokenPath })
      check('T-240 an unreadable store archives NOTHING (never a guess)', broken.archivedSessionIds().size === 0)
    }

    // 1) The default /meta: active sessions only, exact counts, current first.
    process.env.GODOT_BRIDGE_WORKSPACE_STORAGE = storageFor(ARCHIVED.concat(['session-99']))
    const rig = createRig({ taskAgents: createFakeTaskAgents() })
    seedBoard(rig.fs, PROJECT, boardOf())
    const surface = install(rig)
    const hot = await metaCall(surface, queryOf(TEST_SESSION, 'timings=1'))
    const hotScope = hot.ok === true && hot.meta !== null && typeof hot.meta === 'object' ? hot.meta.scope : null
    check('T-240 the default /meta answers', hot.ok === true && hotScope !== null, JSON.stringify({ ok: hot.ok }).substring(0, 300))
    check(
      'T-240 hot excludes EVERY archived session',
      hotScope !== null && hotScope.sessions.every((row) => row.archived === false) && ARCHIVED.every((id) => hotScope.sessions.every((row) => row.sessionId !== id)),
      JSON.stringify(hotScope === null ? null : hotScope.sessions.map((row) => row.sessionId)),
    )
    check('T-240 hot reports the WHOLE project archive count', hotScope !== null && hotScope.archivedTotal === ARCHIVED.length, JSON.stringify({ archivedTotal: hotScope === null ? null : hotScope.archivedTotal }))
    check('T-240 hot contains no archived row', hotScope !== null && hotScope.archivedInPage === 0)
    check('T-240 the total still counts every participant (archived included)', hotScope !== null && hotScope.total === total, JSON.stringify({ total: hotScope === null ? null : hotScope.total }))
    check(
      'T-240 the hot page is still the working set',
      hotScope !== null && hotScope.sessions.length === 20 && hotScope.summaries.length === 20 && hotScope.limit === 20 && hotScope.mode === 'hot' && hotScope.includeArchived === false,
      JSON.stringify({ sessions: hotScope === null ? null : hotScope.sessions.length, mode: hotScope === null ? null : hotScope.mode }),
    )
    check('T-240 the asking session still leads the hot page', hotScope !== null && hotScope.sessions[0].sessionId === TEST_SESSION && hotScope.summaries[0].sessionId === TEST_SESSION)
    check('T-240 the scope names the host as the archive source', hotScope !== null && hotScope.archivedSource === 'host')
    check(
      'T-240 the old scope fields describe the SAME page, now with archive markers',
      hotScope !== null &&
        Array.isArray(hotScope.projectSessions) &&
        hotScope.projectSessions.length === 20 &&
        hotScope.projectSessions[0].sessionId === TEST_SESSION &&
        typeof hotScope.projectSessions[0].archived === 'boolean' &&
        Array.isArray(hotScope.sessionSummaries) &&
        hotScope.sessionSummaries.length === 20,
      JSON.stringify({ sessions: hotScope === null ? null : hotScope.projectSessions.length }),
    )
    check(
      'T-240 the hot cursor still describes the ACTIVE working set',
      hotScope !== null && hotScope.truncated === true && typeof hotScope.nextCursor === 'string' && hotScope.nextCursor !== '',
      JSON.stringify({ truncated: hotScope === null ? null : hotScope.truncated }),
    )
    // The archive is advertised by archivedTotal, never by a hot "more" that the
    // cursor could not deliver: a page holding every ACTIVE session is complete
    // even while the project has an archive, and its nextCursor is null.
    const wide = await metaCall(surface, queryOf(TEST_SESSION, 'limit=200'))
    const wideScope = wide.ok === true && wide.meta !== null && typeof wide.meta === 'object' ? wide.meta.scope : null
    check(
      'T-240 a hot page holding every ACTIVE session is complete, archive or not',
      wideScope !== null &&
        wideScope.sessions.length === total - ARCHIVED.length &&
        wideScope.sessions.every((row) => row.archived === false) &&
        wideScope.truncated === false &&
        wideScope.nextCursor === null &&
        wideScope.archivedTotal === ARCHIVED.length,
      JSON.stringify({ sessions: wideScope === null ? null : wideScope.sessions.length, truncated: wideScope === null ? null : wideScope.truncated, archivedTotal: wideScope === null ? null : wideScope.archivedTotal }),
    )

    // 2) History: the archived sessions are INCLUDED by default.
    const history = await walkScope(surface, TEST_SESSION, 10)
    check('T-240 history reaches the archived sessions', history.ok && ARCHIVED.every((id) => history.rows.some((row) => row.sessionId === id)), JSON.stringify(history.rows.map((row) => row.sessionId)))
    check(
      'T-240 the history cursor walks EVERY participant exactly once',
      history.ok && history.rows.length === total && new Set(history.rows.map((row) => row.sessionId)).size === total,
      JSON.stringify({ rows: history.rows.length, pages: history.pages.length }),
    )
    check(
      'T-240 history marks its archived rows and keeps the project count',
      history.ok && history.pages.every((scope) => scope.archivedTotal === ARCHIVED.length && scope.includeArchived === true) && history.pages.some((scope) => scope.sessions.some((row) => row.archived === true)),
      JSON.stringify({ pages: history.pages.map((scope) => scope.archivedTotal) }),
    )

    // 3) includeArchived=false is the ACTIVE history only.
    const activeHistory = await walkScope(surface, TEST_SESSION, 10, 'includeArchived=false')
    check(
      'T-240 includeArchived=false hides the archived sessions from history',
      activeHistory.ok && activeHistory.rows.length === total - ARCHIVED.length && activeHistory.rows.every((row) => row.archived === false) && ARCHIVED.every((id) => activeHistory.rows.every((row) => row.sessionId !== id)),
      JSON.stringify({ rows: activeHistory.rows.length, ids: activeHistory.rows.map((row) => row.sessionId) }),
    )
    check(
      'T-240 includeArchived=false still counts the archive and walks the active set once',
      activeHistory.ok && activeHistory.pages.every((scope) => scope.archivedTotal === ARCHIVED.length && scope.archivedInPage === 0 && scope.includeArchived === false) && new Set(activeHistory.rows.map((row) => row.sessionId)).size === total - ARCHIVED.length,
    )
    const activeOnePage = await metaCall(surface, queryOf(TEST_SESSION, 'scope=history&limit=200&includeArchived=false'))
    check(
      'T-240 the route accepts includeArchived=0 as well',
      activeOnePage.ok === true && activeOnePage.meta.scope.sessions.length === total - ARCHIVED.length && activeOnePage.meta.scope.nextCursor === null,
      JSON.stringify({ sessions: activeOnePage.meta === null ? null : activeOnePage.meta.scope.sessions.length }),
    )

    // 4) Following the hot cursor never repeats a row.
    const fromHot = await walkScope(surface, TEST_SESSION, 20, 'cursor=' + encodeURIComponent(hotScope.nextCursor))
    const seenIds = hotScope.sessions.map((row) => row.sessionId).concat(fromHot.rows.map((row) => row.sessionId))
    check(
      'T-240 following the hot cursor never repeats a session',
      fromHot.ok && seenIds.length === new Set(seenIds).size && fromHot.rows.every((row) => hotScope.sessions.every((seen) => seen.sessionId !== row.sessionId)),
      JSON.stringify({ hot: hotScope.sessions.length, rest: fromHot.rows.length, unique: new Set(seenIds).size }),
    )

    // 5) The CURRENT session stays pinned on hot even when the host archived it.
    process.env.GODOT_BRIDGE_WORKSPACE_STORAGE = storageFor([TEST_SESSION, 'session-02'])
    const leadRig = createRig({ taskAgents: createFakeTaskAgents() })
    seedBoard(leadRig.fs, PROJECT, boardOf())
    const leadSurface = install(leadRig)
    const leadHot = await metaCall(leadSurface, queryOf(TEST_SESSION, 'timings=1'))
    const leadScope = leadHot.ok === true && leadHot.meta !== null && typeof leadHot.meta === 'object' ? leadHot.meta.scope : null
    check(
      'T-240 the archived CURRENT session still leads the hot page',
      leadScope !== null && leadScope.sessions[0].sessionId === TEST_SESSION && leadScope.sessions[0].archived === true,
      JSON.stringify(leadScope === null ? null : leadScope.sessions.slice(0, 2)),
    )
    check(
      'T-240 ... and its summary is built for the page it leads',
      leadScope !== null && leadScope.summaries[0].sessionId === TEST_SESSION && leadScope.summaries[0].archived === true,
      JSON.stringify(leadScope === null ? null : leadScope.summaries.slice(0, 1)),
    )
    check(
      'T-240 hot still hides every OTHER archived session',
      leadScope !== null &&
        leadScope.sessions.length === 20 &&
        leadScope.sessions.slice(1).every((row) => row.archived === false) &&
        leadScope.sessions.every((row) => row.sessionId !== 'session-02') &&
        leadScope.archivedInPage === 1 &&
        leadScope.archivedTotal === 2,
      JSON.stringify({ sessions: leadScope === null ? null : leadScope.sessions.map((row) => row.sessionId), archivedInPage: leadScope === null ? null : leadScope.archivedInPage }),
    )
    check(
      'T-240 the pinned archived row displaces the tail of the working set',
      leadScope !== null && leadScope.sessions[1].sessionId === 'session-00' && leadScope.sessions.every((row) => row.sessionId !== 'session-23'),
      JSON.stringify(leadScope === null ? null : leadScope.sessions.map((row) => row.sessionId)),
    )
    console.log('PASS  T-240 hot drops archived sessions, history keeps (or filters) them, the current session stays pinned')
  } finally {
    if (savedSessionsDir === undefined) delete process.env.GODOT_BRIDGE_SESSIONS_DIR
    else process.env.GODOT_BRIDGE_SESSIONS_DIR = savedSessionsDir
    if (savedStorage === undefined) delete process.env.GODOT_BRIDGE_WORKSPACE_STORAGE
    else process.env.GODOT_BRIDGE_WORKSPACE_STORAGE = savedStorage
    rmSync(sessionsDir, { recursive: true, force: true })
    for (const dir of storageDirs) rmSync(dir, { recursive: true, force: true })
  }
}

// ── T-241: the agent tree is ACTIVE-ONLY, history keeps its entry points ───
// The DSH agent catalog is append-only: every reviewer/tester a long-lived host
// ever started stays a row, so a project with ~275 agents made the hot tree (and
// the header/status page that renders it) grow with the project's age. The /meta
// agentTree now lists ACTIVE agents only — a RUNNING child, or a session a LIVE
// card's stage claims — and counts the rest in agentTotal/agentTruncated instead
// of listing it. History stays reachable: /task detail keeps the card's own
// review/test deliveredTo, and /meta?scope=history answers an agentHistory
// summary (the board is the only archive there is; no host archive API is faked).
{
  const sessionsDir = mkdtempSync(join(tmpdir(), 'gb-t241-sessions-'))
  const storageDir = mkdtempSync(join(tmpdir(), 'gb-t241-store-'))
  const savedSessionsDir = process.env.GODOT_BRIDGE_SESSIONS_DIR
  const savedStorage = process.env.GODOT_BRIDGE_WORKSPACE_STORAGE
  try {
    mkdirSync(join(sessionsDir, '--fixture-project--'))
    writeFileSync(join(sessionsDir, '--fixture-project--', 'session-' + TEST_SESSION), 'x')
    process.env.GODOT_BRIDGE_SESSIONS_DIR = sessionsDir
    const storagePath = join(storageDir, 'workspace.json')
    writeFileSync(storagePath, JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: [] }, tables: {} }))
    process.env.GODOT_BRIDGE_WORKSPACE_STORAGE = storagePath

    // 272 catalog rows of finished reviewer/tester history + the few rows that
    // matter: a live card's three stage sessions (inactive in the host catalog,
    // their turn is over, but the card still OWNS those stages), one genuinely
    // RUNNING child no card claims, and a DONE card's reviewer (pure history).
    const HISTORY = 272
    const rows = []
    for (let index = 0; index < HISTORY; index += 1) {
      rows.push({ kind: 'child', id: 'session-history-' + String(index), name: 'worker-t-old-' + String(index), activity: 'inactive' })
    }
    // A live stage row may have NO usable host name or role: the board's own
    // delivery record fills both. The worker name deliberately does not match the
    // worker- prefix, so the role can only come from the claim.
    rows.push({ kind: 'child', id: 'session-live-worker', name: 'alpha-worker', activity: 'inactive' })
    rows.push({ kind: 'child', id: 'session-live-reviewer', name: 'reviewer-t-live', activity: 'inactive' })
    rows.push({ kind: 'child', id: 'session-live-tester', activity: 'inactive' })
    rows.push({ kind: 'child', id: 'session-running-extra', name: 'worker-t-extra', activity: 'running' })
    rows.push({ kind: 'child', id: 'session-history-reviewer', name: 'reviewer-t-done', activity: 'inactive' })
    // The host has not retired the DONE card's tester yet (the catalog still says
    // running): the BOARD already records it on an ended card, so it is history.
    rows.push({ kind: 'child', id: 'session-zombie-tester', name: 'tester-t-done', activity: 'running' })
    const agentTotal = rows.length
    const liveCard = {
      id: 'T-901',
      title: 'live card',
      kind: 'dev',
      status: 'reviewing',
      ownerSession: TEST_SESSION,
      assignee: { name: 'worker-t-live', session: 'session-live-worker' },
      review: { status: 'pending', attempt: 1, deliveredTo: { name: 'reviewer-t-live', id: 'session-live-reviewer' } },
      test: { status: 'pending', attempt: 1, deliveredTo: { name: 'tester-t-live', id: 'session-live-tester' } },
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T02:00:00.000Z',
    }
    const doneCard = {
      id: 'T-902',
      title: 'done card',
      kind: 'dev',
      status: 'done',
      ownerSession: TEST_SESSION,
      assignee: { name: 'worker-t-done', session: 'session-done-worker' },
      review: { status: 'approved', attempt: 1, deliveredTo: { name: 'reviewer-t-done', id: 'session-history-reviewer' } },
      test: { status: 'passed', attempt: 1, deliveredTo: { name: 'tester-t-done', id: 'session-zombie-tester' } },
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T03:00:00.000Z',
    }
    // A DONE card that reused a session the live card still owns: the session is
    // ACTIVE, so it must never be counted as history.
    const reuseCard = {
      id: 'T-903',
      title: 'done card reusing a live session',
      kind: 'dev',
      status: 'done',
      ownerSession: TEST_SESSION,
      review: { status: 'approved', attempt: 1, deliveredTo: { name: 'reviewer-t-live', id: 'session-live-reviewer' } },
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T04:00:00.000Z',
    }
    const facade = {
      available: true,
      rootId: TEST_SESSION,
      rootFor(rootId) {
        return rootId === TEST_SESSION ? { id: TEST_SESSION, name: 'lead' } : null
      },
      async listFor(rootId) {
        return rootId === TEST_SESSION ? rows : []
      },
    }
    const rig = createRig({ taskAgents: facade })
    seedBoard(rig.fs, PROJECT, JSON.stringify({ version: 2, seq: 9, tasks: [liveCard, doneCard, reuseCard] }))
    const surface = install(rig)
    const metaCall = async (query) => {
      const res = response()
      await surface.byPath.get(META_PATH).handler(request(META_PATH + '?' + query), res)
      return res.json()
    }
    const queryOf = (extra) => 'project=' + encodeURIComponent(PROJECT) + '&session=' + encodeURIComponent(TEST_SESSION) + (extra === undefined ? '' : '&' + extra)
    const treeOf = (payload) => (payload !== null && payload !== undefined && payload.meta !== null && typeof payload.meta === 'object' ? payload.meta.agentTree : null)

    // 1) The HOT answer: active-only members, the whole catalog counted.
    const hot = await metaCall(queryOf())
    const hotTree = treeOf(hot)
    const hotIds = hotTree === null || Array.isArray(hotTree.members) !== true ? [] : hotTree.members.map((member) => member.id)
    check('T-241 the hot /meta answers the agent tree', hot.ok === true && hotTree !== null && hotTree.available === true && hotTree.root.id === TEST_SESSION, JSON.stringify(hot.meta === undefined ? null : hot.meta.agentTree).substring(0, 300))
    check(
      'T-241 the hot tree is explicitly ACTIVE-ONLY',
      hotTree !== null && hotTree.activeOnly === true && hotTree.count === hotTree.members.length && hotTree.members.length === 4,
      JSON.stringify({ activeOnly: hotTree === null ? null : hotTree.activeOnly, members: hotIds }),
    )
    check(
      'T-241 only ACTIVE children and CURRENT card stage agents are members',
      hotIds.indexOf('session-running-extra') >= 0 &&
        hotIds.indexOf('session-live-worker') >= 0 &&
        hotIds.indexOf('session-live-reviewer') >= 0 &&
        hotIds.indexOf('session-live-tester') >= 0,
      JSON.stringify(hotIds),
    )
    check(
      'T-241 HISTORICAL agents never enter the hot tree',
      hotIds.indexOf('session-history-reviewer') < 0 && hotIds.every((id) => id.indexOf('session-history-') < 0) && hotIds.length === 4,
      JSON.stringify(hotIds),
    )
    check(
      'T-241 a RUNNING child of an ENDED card is history too, not a member',
      hotIds.indexOf('session-zombie-tester') < 0 && rows.some((entry) => entry.id === 'session-zombie-tester' && entry.activity === 'running'),
      JSON.stringify(hotIds),
    )
    const memberOf = (tree, id) => (tree === null || Array.isArray(tree.members) !== true ? null : tree.members.filter((member) => member.id === id)[0] || null)
    const liveReviewer = memberOf(hotTree, 'session-live-reviewer')
    check(
      'T-241 a current card stage agent keeps its task, role and name',
      liveReviewer !== null && liveReviewer.taskId === 'T-901' && liveReviewer.role === 'reviewer' && liveReviewer.name === 'reviewer-t-live',
      JSON.stringify(liveReviewer),
    )
    const runningExtra = memberOf(hotTree, 'session-running-extra')
    check(
      'T-241 a running child no card claims is still an active member',
      runningExtra !== null && runningExtra.status === 'running' && runningExtra.taskId === null,
      JSON.stringify(runningExtra),
    )
    const liveWorker = memberOf(hotTree, 'session-live-worker')
    const liveTester = memberOf(hotTree, 'session-live-tester')
    check(
      'T-241 a claimed stage row takes its role from the board it claimed',
      liveWorker !== null && liveWorker.role === 'worker' && liveWorker.name === 'alpha-worker',
      JSON.stringify(liveWorker),
    )
    check(
      'T-241 a claimed stage row without a host name gets the recorded delivery name',
      liveTester !== null && liveTester.name === 'tester-t-live' && liveTester.role === 'tester' && liveTester.taskId === 'T-901',
      JSON.stringify(liveTester),
    )
    check(
      'T-241 agentTotal counts the WHOLE catalog and the tree is truncated',
      hotTree !== null && hotTree.agentTotal === agentTotal && hotTree.agentTruncated === true && agentTotal === 278,
      JSON.stringify({ agentTotal: hotTree === null ? null : hotTree.agentTotal, expected: agentTotal }),
    )

    // 2) The SAME active-only tree is what /state carries: the header and the
    // status page read that snapshot, so it cannot drift from /meta.
    const state = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT))
    const stateTree = state.json().ok === true ? state.json().agentTree : null
    const stateIds = stateTree === null || Array.isArray(stateTree.members) !== true ? [] : stateTree.members.map((member) => member.id)
    check(
      'T-241 /state carries the SAME active-only tree with the catalog total',
      state.json().ok === true && stateTree !== null && stateTree.available === true && stateTree.activeOnly === true && stateTree.agentTotal === agentTotal && stateIds.indexOf('session-history-reviewer') < 0 && stateIds.length === 4,
      JSON.stringify({ ok: state.json().ok, ids: stateIds, agentTotal: stateTree === null ? null : stateTree.agentTotal }),
    )
    const light = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT) + '&core=1')
    const lightTree = light.json().agentTree
    check(
      'T-241 the deferred tree shape carries the new fields too',
      lightTree !== null && lightTree.available === false && lightTree.error === 'deferred' && lightTree.agentTotal === 0 && lightTree.agentTruncated === false && lightTree.activeOnly === true,
      JSON.stringify(lightTree),
    )
    check(
      'T-241 the split advertises agentHistory as a /meta segment',
      Array.isArray(light.json().metadata.deferred) && light.json().metadata.deferred.indexOf('agentHistory') >= 0,
      JSON.stringify(light.json().metadata === undefined ? null : light.json().metadata.deferred),
    )

    // 3) A historical card still resolves its reviewer/tester from its DETAIL.
    const detail = await call(surface, TASK_PATH + '?id=T-902')
    const detailTask = detail.json().ok === true ? detail.json().task : null
    check(
      'T-241 a historical card keeps its review/test deliveredTo in the detail',
      detailTask !== null && detailTask.review.deliveredTo.id === 'session-history-reviewer' && detailTask.review.deliveredTo.name === 'reviewer-t-done' && detailTask.test.deliveredTo.id === 'session-zombie-tester' && detailTask.test.deliveredTo.name === 'tester-t-done',
      JSON.stringify(detailTask === null ? null : { review: detailTask.review.deliveredTo, test: detailTask.test.deliveredTo }),
    )

    // 4) The history ENTRY POINT: /meta?scope=history summarizes the agents the
    // hot tree left out, straight from the board's own delivery records.
    const history = await metaCall(queryOf('scope=history'))
    const historyBlock = history.ok === true && history.meta !== null && typeof history.meta === 'object' ? history.meta.agentHistory : null
    const historyEntries = historyBlock === null || Array.isArray(historyBlock.entries) !== true ? [] : historyBlock.entries
    const historyIds = historyEntries.map((entry) => entry.session)
    check(
      'T-241 /meta?scope=history answers the agentHistory summary',
      history.ok === true && historyBlock !== null && historyBlock.available === true && historyBlock.source === 'board',
      JSON.stringify(historyBlock).substring(0, 300),
    )
    check(
      'T-241 the history summary names the recorded historical agents',
      historyIds.length === 3 && historyIds.indexOf('session-history-reviewer') >= 0 && historyIds.indexOf('session-zombie-tester') >= 0 && historyIds.indexOf('session-done-worker') >= 0,
      JSON.stringify(historyEntries),
    )
    check(
      'T-241 the history entries keep role, stage, task and name',
      historyEntries.every((entry) => entry.taskId === 'T-902' && entry.taskStatus === 'done') &&
        historyEntries.some((entry) => entry.session === 'session-history-reviewer' && entry.role === 'reviewer' && entry.stage === 'review' && entry.name === 'reviewer-t-done') &&
        historyEntries.some((entry) => entry.session === 'session-zombie-tester' && entry.role === 'tester' && entry.stage === 'test' && entry.name === 'tester-t-done'),
      JSON.stringify(historyEntries),
    )
    check(
      'T-241 a session a live card still owns is not history',
      historyIds.indexOf('session-live-reviewer') < 0 && historyIds.indexOf('session-live-worker') < 0,
      JSON.stringify(historyIds),
    )
    check(
      'T-241 the history summary is bounded, counts its active set and is complete here',
      historyBlock.total === 3 && historyBlock.count === 3 && historyBlock.active === 3 && historyBlock.truncated === false && historyBlock.limit === 200,
      JSON.stringify({ total: historyBlock === null ? null : historyBlock.total, count: historyBlock === null ? null : historyBlock.count, active: historyBlock === null ? null : historyBlock.active }),
    )
    check(
      'T-241 a history page still DEFERS the hot tree (history never rides it)',
      history.meta.agentTree.available === false && history.meta.agentTree.error === 'deferred' && Array.isArray(history.metadata.deferred) && history.metadata.deferred.indexOf('agentHistory') < 0,
      JSON.stringify({ tree: history.meta.agentTree === undefined ? null : history.meta.agentTree.error, deferred: history.metadata === undefined ? null : history.metadata.deferred }),
    )

    // 5) No agent runtime: the new fields describe 'nothing', never a fabricated
    // membership, and the same shape reaches the unavailable answer.
    const noAgentsRig = createRig({})
    seedBoard(noAgentsRig.fs, PROJECT, JSON.stringify({ version: 2, seq: 1, tasks: [] }))
    const noTree = await noAgentsRig.api.metadata(PROJECT, { sessionId: TEST_SESSION })
    const noTreeTree = noTree.ok === true ? noTree.meta.agentTree : null
    check(
      'T-241 the unavailable tree keeps the active-only contract fields',
      noTreeTree !== null && noTreeTree.available === false && noTreeTree.members.length === 0 && noTreeTree.agentTotal === 0 && noTreeTree.agentTruncated === false && noTreeTree.activeOnly === true,
      JSON.stringify(noTreeTree),
    )
    console.log('PASS  T-241 the agent tree is active-only (272 history rows stay out of hot, the live card stage agents stay in, agentTotal/agentTruncated prove it), a historical card still resolves reviewer/tester from its detail, and /meta?scope=history summarizes the rest')
  } finally {
    if (savedSessionsDir === undefined) delete process.env.GODOT_BRIDGE_SESSIONS_DIR
    else process.env.GODOT_BRIDGE_SESSIONS_DIR = savedSessionsDir
    if (savedStorage === undefined) delete process.env.GODOT_BRIDGE_WORKSPACE_STORAGE
    else process.env.GODOT_BRIDGE_WORKSPACE_STORAGE = savedStorage
    rmSync(sessionsDir, { recursive: true, force: true })
    rmSync(storageDir, { recursive: true, force: true })
  }
}
// ── T-242: the cold done-card archive ───────────────────────────────────────
// The board is working state, and a 5.6 MB board (226 finished cards) was paid
// for on every heartbeat. Finished cards now move to .agents/tasks-archive.json.
// These checks drive the REAL routes: the settings save (valid, invalid, flat),
// a disabled sweep, the age/keepDone sweep, archived reads, paging, dependency
// satisfaction, and two concurrent ticks that must not lose a card.
const ARCHIVE_NOW = Date.parse('2026-11-26T00:00:00.000Z')
const ARCHIVE_DAY = 24 * 60 * 60 * 1000
function archiveSeedBoard() {
  const tasks = []
  for (let index = 0; index < 60; index += 1) {
    const at = new Date(ARCHIVE_NOW - (20 + index) * ARCHIVE_DAY).toISOString()
    tasks.push({
      id: 'T-' + String(100 + index),
      title: 'done card ' + String(index),
      status: 'done',
      kind: 'dev',
      updatedAt: at,
      history: [
        { at: at, by: 'worker', from: 'running', to: 'done', note: 'done' },
        { at: new Date(ARCHIVE_NOW - 1 * ARCHIVE_DAY).toISOString(), by: 'tester', from: 'testing', to: 'done', note: 'passed' },
      ],
    })
  }
  const nowIso = new Date(ARCHIVE_NOW).toISOString()
  tasks.push({ id: 'T-1', title: 'pending dependent', status: 'pending', dependsOn: ['T-159'], updatedAt: nowIso })
  tasks.push({ id: 'T-2', title: 'running card', status: 'running', assignee: { name: 'w', session: 's' }, leaseUntil: new Date(ARCHIVE_NOW + 3600000).toISOString(), updatedAt: nowIso })
  tasks.push({ id: 'T-3', title: 'blocked card', status: 'blocked', updatedAt: nowIso })
  tasks.push({ id: 'T-4', title: 'reviewing card', status: 'reviewing', updatedAt: nowIso })
  tasks.push({ id: 'T-5', title: 'testing card', status: 'testing', updatedAt: nowIso })
  return JSON.stringify({ version: 2, seq: 500, tasks: tasks, dispatch: { state: 'paused' } })
}

function archiveHarness() {
  const archiveRig = createRig({ taskAgents: createFakeTaskAgents() })
  seedBoard(archiveRig.fs, archiveRig.project, archiveSeedBoard())
  const archiveSurface = install(archiveRig)
  const callArchive = (url, options) => call(archiveSurface, url, options)
  const postArchive = async (body) => {
    const res = response()
    await archiveSurface.byPath.get(ACTION_PATH).handler(
      request(ACTION_PATH + '?session=' + encodeURIComponent(TEST_SESSION), { method: 'POST', body: body, headers: { 'content-type': 'application/json' } }),
      res,
    )
    return res
  }
  const boardFile = () => archiveRig.fs.files.get(boardPath(archiveRig.project))
  const boardJson = () => JSON.parse(boardFile().text)
  const archiveFile = () => archiveRig.fs.files.get(tasksArchivePath(archiveRig.project))
  return { rig: archiveRig, surface: archiveSurface, call: callArchive, post: postArchive, boardFile: boardFile, boardJson: boardJson, archiveFile: archiveFile }
}

// ── the settings save: valid, refused (old value kept), flat spelling ────────
{
  const h = archiveHarness()
  let res = await h.call(STATE_PATH + '?core=1', {})
  let payload = res.json()
  check(
    'T-242 /state carries the archive settings and an empty index on a legacy board',
    payload.ok === true && payload.archiveSettings.enabled === true && payload.archiveSettings.doneAfterDays === 14 && payload.archiveSettings.keepDone === 50 && payload.archiveSettings.maxBoardBytes === 2 * 1024 * 1024 && payload.archivedIndexCount === 0,
    JSON.stringify(payload.archiveSettings),
  )
  res = await h.post({ action: 'settings', archive: { doneAfterDays: 0 } })
  payload = res.json()
  check('T-242 an out-of-range archive setting is refused through the route and names the field', payload.ok === false && payload.code === 'invalid-archive-setting' && payload.field === 'doneAfterDays', res.text.substring(0, 400))
  res = await h.call(STATE_PATH + '?core=1', {})
  check('T-242 a refused save KEEPS the old value (nothing was written)', res.json().archiveSettings.doneAfterDays === 14, JSON.stringify(res.json().archiveSettings))
  res = await h.post({ action: 'settings', archive: { doneAfterDays: 7, keepDone: 5, maxBoardBytes: 1024 * 1024 } })
  payload = res.json()
  check('T-242 a valid archive save is accepted and answered', payload.ok === true && payload.archive.keepDone === 5 && payload.archive.doneAfterDays === 7, res.text.substring(0, 400))
  res = await h.post({ action: 'settings', archiveKeepDone: 3 })
  payload = res.json()
  check('T-242 the flat archive* spelling is accepted too', payload.ok === true && payload.archive.keepDone === 3, res.text.substring(0, 300))
  check(
    'T-242 the stored settings survive into the next /state read',
    (await h.call(STATE_PATH + '?core=1', {})).json().archiveSettings.maxBoardBytes === 1024 * 1024,
  )
  // Restore keepDone 5 for the sweep below.
  await h.post({ action: 'settings', archive: { keepDone: 5 } })
  console.log('PASS  T-242 the archive settings are saved/refused through the settings action, old values kept')
}

// ── disabled => no sweep; enabled => the cold cards move, nothing is lost ───
{
  const h = archiveHarness()
  await h.post({ action: 'settings', archive: { enabled: false, keepDone: 5, doneAfterDays: 7 } })
  const beforeSeq = h.boardJson().seq
  const beforeTasks = h.boardJson().tasks.map((task) => task.id).sort().join(',')
  let res = await h.post({ action: 'tick' })
  let payload = res.json()
  check(
    'T-242 a disabled archive never sweeps: no archive file, no card leaves the board',
    payload.ok === true &&
      payload.archive.archived === 0 &&
      payload.archive.skipped === 'disabled' &&
      h.boardJson().tasks.length === 65 &&
      h.boardJson().tasks.map((task) => task.id).sort().join(',') === beforeTasks &&
      h.boardJson().seq === beforeSeq &&
      h.archiveFile() === undefined,
    res.text.substring(0, 300),
  )
  const beforeBytes = h.boardFile().text.length
  await h.post({ action: 'settings', archive: { enabled: true } })
  res = await h.post({ action: 'tick' })
  payload = res.json()
  const keptDone = h.boardJson().tasks.filter((task) => task.status === 'done').map((task) => task.id).sort()
  const hotIds = h.boardJson().tasks.map((task) => task.id)
  const archivedIds = JSON.parse(h.archiveFile().text).tasks.map((task) => task.id).sort()
  check(
    'T-242 an enabled sweep archives every cold done card and reports it',
    payload.ok === true && payload.archive.ok === true && payload.archive.archived === 55 && payload.archive.ids.length === 55,
    res.text.substring(0, 400),
  )
  check(
    'T-242 the hot board keeps the newest keepDone done cards and EVERY active card',
    keptDone.join(',') === 'T-100,T-101,T-102,T-103,T-104' && ['T-1', 'T-2', 'T-3', 'T-4', 'T-5'].every((id) => hotIds.indexOf(id) >= 0) && hotIds.length === 10,
    JSON.stringify({ keptDone: keptDone, hot: hotIds }),
  )
  check(
    'T-242 only DONE cards move: running/reviewing/testing/blocked/pending stay on the hot board',
    ['T-2', 'T-3', 'T-4', 'T-5'].every((id) => archivedIds.indexOf(id) < 0),
    JSON.stringify(archivedIds.filter((id) => ['T-2', 'T-3', 'T-4', 'T-5'].indexOf(id) >= 0)),
  )
  check('T-242 the archive holds exactly the 55 cold cards, newest first', archivedIds.length === 55 && archivedIds[0] === 'T-105' && archivedIds[54] === 'T-159', JSON.stringify(archivedIds.slice(0, 3)) + ' / ' + JSON.stringify(archivedIds.slice(-2)))
  check('T-242 the hot board FILE got smaller', h.boardFile().text.length < beforeBytes && h.boardJson().tasks.length === 10, JSON.stringify({ before: beforeBytes, after: h.boardFile().text.length }))
  check(
    'T-242 the board records the archived-card index (the dependency evidence)',
    h.boardJson().archivedDone.length === 55 && h.boardJson().archivedDone.every((row) => row.status === 'done' && row.id !== undefined),
    JSON.stringify(h.boardJson().archivedDone.slice(0, 2)),
  )
  check(
    'T-242 the sweep records when it ran and how many cards it moved',
    h.boardJson().archive.lastSweepAt !== null && h.boardJson().archive.lastSweep.archived === 55,
    JSON.stringify(h.boardJson().archive),
  )
  console.log('PASS  T-242 the sweep is disabled on demand, then moves exactly the cold done cards and shrinks the board')
}

// ── archived reads, paging, /state and the dependency graph ─────────────────
{
  const h = archiveHarness()
  await h.post({ action: 'settings', archive: { keepDone: 5, doneAfterDays: 7 } })
  await h.post({ action: 'tick' })
  let res = await h.call(TASK_PATH + '?id=T-159', {})
  let payload = res.json()
  check(
    'T-242 /task reads an archived card in full (status, history, archived marker)',
    payload.ok === true && payload.task.id === 'T-159' && payload.task.status === 'done' && payload.task.archived === true && payload.task.history.length === 2,
    res.text.substring(0, 500),
  )
  res = await h.post({ action: 'get', id: 'T-159' })
  payload = res.json()
  check('T-242 the tool get also reads the archive', payload.ok === true && payload.task.id === 'T-159' && payload.task.archived === true, res.text.substring(0, 400))
  res = await h.call(LIST_PATH + '?archived=1&limit=10', {})
  payload = res.json()
  const firstPage = payload.tasks.map((task) => task.id)
  check(
    'T-242 /list?archived=1 pages the archive (summary shape, cursor)',
    payload.ok === true && payload.archived === true && payload.count === 10 && payload.nextCursor !== null && payload.tasks.every((task) => task.status === 'done'),
    res.text.substring(0, 400),
  )
  res = await h.call(LIST_PATH + '?archived=1&limit=10&cursor=' + encodeURIComponent(payload.nextCursor), {})
  payload = res.json()
  const secondPage = payload.tasks.map((task) => task.id)
  const overlap = secondPage.filter((id) => firstPage.indexOf(id) >= 0)
  check('T-242 the archive cursor never repeats a card across pages', secondPage.length === 10 && overlap.length === 0, JSON.stringify({ first: firstPage.slice(0, 2), second: secondPage.slice(0, 2), overlap: overlap }))
  res = await h.call(LIST_PATH + '?archived=1&limit=200', {})
  payload = res.json()
  check('T-242 the archive list answers the whole cold set', payload.count === 55 && payload.nextCursor === null, JSON.stringify({ count: payload.count, cursor: payload.nextCursor }))
  res = await h.call(STATE_PATH + '?core=1', {})
  payload = res.json()
  const hotIds = payload.tasks.map((task) => task.id)
  check(
    'T-242 the hot /state never carries an archived card and counts only the hot ones',
    hotIds.indexOf('T-159') < 0 && hotIds.length === 10 && payload.counts.done === 5 && payload.archivedIndexCount === 55,
    JSON.stringify({ tasks: hotIds.length, done: payload.counts.done, index: payload.archivedIndexCount }),
  )
  check('T-242 the pending dependent still sees its archived prerequisite as ready', payload.queue.some((task) => task.id === 'T-1') && payload.counts.ready >= 1, JSON.stringify({ ready: payload.counts.ready, queue: payload.queue.map((task) => task.id) }))
  res = await h.post({ action: 'get', id: 'T-1' })
  payload = res.json()
  check(
    'T-242 the dependency verdict on the dependent is ready (archived done == done)',
    payload.ok === true && payload.task.dependency.state === 'ready' && payload.task.dependency.brokenOn.length === 0,
    JSON.stringify(payload.task === undefined ? payload : payload.task.dependency),
  )
  res = await h.call(META_PATH + '?refresh=1', {})
  payload = res.json()
  check(
    'T-242 /meta counts the archived cards from the archive file',
    payload.ok === true && payload.meta.archivedCount === 55 && payload.meta.archiveRange !== null,
    JSON.stringify({ count: payload.meta.archivedCount, range: payload.meta.archiveRange }),
  )
  res = await h.call(TASK_PATH + '?id=T-999', {})
  check('T-242 an unknown id is still a readable unknown-task refusal', res.json().ok === false && res.json().code === 'unknown-task', res.text.substring(0, 200))
  console.log('PASS  T-242 archived cards are readable by id and pageable, and dependencies on them still resolve')
}

// ── two concurrent ticks never lose (or duplicate) a card ───────────────────
{
  const h = archiveHarness()
  await h.post({ action: 'settings', archive: { keepDone: 5, doneAfterDays: 7 } })
  const [first, second] = await Promise.all([h.post({ action: 'tick' }), h.post({ action: 'tick' })])
  const archiveTasks = JSON.parse(h.archiveFile().text).tasks.map((task) => task.id)
  const hotTasks = h.boardJson().tasks.map((task) => task.id)
  const seen = new Set(archiveTasks)
  const duplicated = archiveTasks.filter((id, index) => archiveTasks.indexOf(id) !== index)
  const lost = []
  for (let index = 0; index < 60; index += 1) {
    const id = 'T-' + String(100 + index)
    if (!seen.has(id) && hotTasks.indexOf(id) < 0) lost.push(id)
  }
  check(
    'T-242 two concurrent ticks neither lose nor duplicate a card',
    first.json().ok === true && second.json().ok === true && lost.length === 0 && duplicated.length === 0 && archiveTasks.length === 55 && hotTasks.length === 10,
    JSON.stringify({ archive: archiveTasks.length, hot: hotTasks.length, lost: lost, duplicated: duplicated }),
  )
  const index = h.boardJson().archivedDone
  check('T-242 the surviving index has exactly one row per archived card', index.length === 55 && new Set(index.map((row) => row.id)).size === 55, JSON.stringify(index.length))
  console.log('PASS  T-242 concurrent sweeps are serialised: one card, one place, one index row')
}

// ── a failed archive write keeps every card on the board ────────────────────
{
  const h = archiveHarness()
  await h.post({ action: 'settings', archive: { keepDone: 5, doneAfterDays: 7 } })
  const before = h.boardJson().tasks.length
  const realWrite = h.rig.fs.writeText
  h.rig.fs.writeText = async function (target, content, expected, signal, policy) {
    if (String(target.targetKey) === tasksArchivePath(h.rig.project)) throw new Error('disk full')
    return realWrite.call(this, target, content, expected, signal, policy)
  }
  const res = await h.post({ action: 'tick' })
  const payload = res.json()
  h.rig.fs.writeText = realWrite
  check(
    'T-242 a failed archive write loses NO card: the sweep answers its failure and the board is untouched',
    payload.ok === true && payload.archive.ok === false && payload.archive.code === 'archive-unwritable' && h.boardJson().tasks.length === before,
    res.text.substring(0, 400),
  )
  console.log('PASS  T-242 the archiving is two-phase: the board only loses a card after the archive has it')
}

console.log(failures === 0 ? '\nPASS  task routes (v3 snapshot)' : '\nFAIL  ' + String(failures) + ' route check(s)')
process.exit(failures === 0 ? 0 : 1)
