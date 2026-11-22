// The frozen TaskSummary / TaskDetail read model contract (T-230).
//
// T-229 found one card leaving the server in four shapes: /state.tasks and /list
// used api.summaryOf, /state.queue and the tool list used service.summary, and
// every tool board / full /state answer used api.detailOf. The field sets, the
// types and even the nullability disagreed, so a field could silently vanish
// (T-225's review.deliveredTo) and every new reader had to guess which
// vocabulary it held (T-228's writeFiles vs writeFileCount).
//
// This suite pins the contract that ends that:
//
//   1. /state.tasks, /state.queue, /list and the tool list carry the SAME
//      TaskSummary for the same card — same field set, same types, same VALUES;
//   2. the summary keeps the facts that were already lost once (deliveredTo,
//      writeFileCount, the newest events) and never carries a detail-class
//      field (spec/acceptance/evidence/history/writeFiles);
//   3. TaskDetail is a STRICT superset: every summary field survives, the
//      detail-only fields appear, and the nested stage/merge records keep the
//      compact facts next to the full ones;
//   4. no builder ever emits an own field whose value is `undefined`;
//   5. on a 200-card board the summary response stays under 10% of the full one.

import assert from 'node:assert/strict'
import {
  LIST_PATH,
  STATE_PATH,
  TASK_PATH,
  registerTaskRoutes,
} from '../../plugin/task-center/routes.mjs'
import { TASK_DETAIL_ONLY_FIELDS, TASK_SUMMARY_FIELDS, buildTaskSummary } from '../../plugin/task-center/read-model.mjs'
import { PROJECT, createFakeTaskAgents, createRig, seedBoard } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

// ── the route harness (the panel's own transport) ──────────────────────────
const TEST_SESSION = 'session-lead'

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
  registerTaskRoutes(webCtx, { state: rig.state, api: rig.api, scheduler: rig.scheduler })
  return { byPath: new Map(specs.map((spec) => [spec.path, spec])) }
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

async function call(surface, url, options) {
  const res = response()
  const withSession = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'session=' + encodeURIComponent(TEST_SESSION)
  await surface.byPath.get(url.split('?')[0]).handler(request(withSession, options), res)
  return res
}

// ── fixtures: one pending (ready) card and one done card, both carrying the
// detail-class payload a real board holds, so the summary/detail split is
// measured on content and not on an artificially thin card.
const AT = '2026-11-22T09:00:00.000Z'
const BIG = 'detail-class text that must stay behind /task; '
const REASONS = 'the review found the acceptance covered; '.repeat(20)
const EVIDENCE = 'the tester ran the suite in the candidate; '.repeat(20)

function historyRows(to) {
  return [
    { at: '2026-11-20T00:00:00.000Z', by: '@planner', byName: null, from: null, to: 'pending', note: 'created' },
    { at: '2026-11-20T01:00:00.000Z', by: 'scheduler', byName: 'worker-t-1', from: 'pending', to: 'running', note: 'dispatched to worker-t-1 for the demo project' },
    { at: '2026-11-20T02:00:00.000Z', by: '@worker', byName: 'worker-t-1', from: 'running', to: 'reviewing', note: 'submitted for review with the suite green' },
    { at: '2026-11-20T03:00:00.000Z', by: '@reviewer', byName: 'reviewer-t-1', from: 'reviewing', to: 'testing', note: 'approved: every criterion checked' },
    { at: '2026-11-20T04:00:00.000Z', by: '@tester', byName: 'tester-t-1', from: 'testing', to: 'done', note: 'passed on the candidate checkout' },
    { at: '2026-11-20T05:00:00.000Z', by: '@user', byName: null, from: 'done', to: to, note: 'final ' + BIG.repeat(2) },
  ]
}

function pendingCard() {
  return {
    id: 'T-1',
    title: 'pending card',
    kind: 'dev',
    status: 'pending',
    priority: 40,
    spec: BIG.repeat(20),
    acceptance: BIG.repeat(10),
    dependsOn: [],
    writeFiles: ['plugin/task-center/api.mjs', 'plugin/task-center/read-model.mjs'],
    verification: { probes: [{ id: 'suite', command: 'npm test', timeoutMs: 60000 }] },
    createdBy: '@planner',
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: AT,
    history: historyRows('pending'),
    // No lease and no stage slot: the four surfaces must agree on a card whose
    // time-derived facts are null, so a per-request clock cannot mask a drift.
    leaseUntil: null,
  }
}

function doneCard() {
  return {
    id: 'T-2',
    title: 'done card',
    kind: 'dev',
    status: 'done',
    priority: 30,
    spec: BIG.repeat(20),
    acceptance: BIG.repeat(10),
    evidence: EVIDENCE,
    dependsOn: [],
    writeFiles: ['plugin/task-center/service.mjs'],
    verification: { probes: [{ id: 'suite', command: 'npm test' }] },
    createdBy: '@planner',
    base: 'base-sha',
    targetBase: 'base-sha',
    target: 'feat/task-center-v2',
    branch: 'task/T-2-1',
    worktree: 'J:/demo/.worktrees/T-2-1',
    commit: 'head-sha',
    actualFiles: ['plugin/task-center/service.mjs'],
    assignee: null,
    attempts: 1,
    maxAttempts: 3,
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: AT,
    leaseUntil: null,
    history: historyRows('done'),
    review: {
      status: 'approved',
      by: '@reviewer',
      byName: 'reviewer-t-1',
      at: '2026-11-20T03:00:00.000Z',
      attempt: 1,
      reasons: REASONS,
      record: { verdict: 'approved', checked: [{ criterion: 'suite', method: 'npm test', result: 'pass' }], findings: [], residualRisks: [] },
      deliveredTo: { name: 'reviewer-t-1', id: 'session-reviewer-1', at: '2026-11-20T02:10:00.000Z', generation: 3 },
    },
    test: {
      status: 'passed',
      by: '@tester',
      byName: 'tester-t-1',
      at: '2026-11-20T04:00:00.000Z',
      attempt: 1,
      evidence: EVIDENCE,
      record: { verdict: 'passed', probes: [{ id: 'suite', command: 'npm test', exitCode: 0, tail: 'ok' }], adversarial: [], notes: 'checked' },
      deliveredTo: { name: 'tester-t-1', id: 'session-tester-1', at: '2026-11-20T03:10:00.000Z', generation: 2 },
    },
    merge: {
      status: 'merged',
      base: 'base-sha',
      target: 'feat/task-center-v2',
      head: 'head-sha',
      mergeCommit: 'merge-sha',
      declaredFiles: ['plugin/task-center/service.mjs'],
      actualFiles: ['plugin/task-center/service.mjs'],
      output: 'merged cleanly',
      tests: 'npm test',
      reviewer: '@reviewer',
      conflict: null,
      at: '2026-11-20T05:00:00.000Z',
    },
  }
}

const rig = createRig({ taskAgents: createFakeTaskAgents() })
const boardText = JSON.stringify({ version: 1, tasks: [pendingCard(), doneCard()] })
seedBoard(rig.fs, PROJECT, boardText)
const surface = install(rig)

// ── 1. ONE builder: the same card on four different surfaces ───────────────
// /state?light=1 is the panel's poll: tasks[] carries every card, queue[] the
// dispatchable ones. /list is the paged drawer. list is the tool's read.
const stateRes = await call(surface, STATE_PATH + '?light=1', {})
const statePayload = stateRes.json()
check('the light /state answer is the panel summary', statePayload.ok === true && statePayload.metadata.light === true, stateRes.text.substring(0, 240))

const listRes = await call(surface, LIST_PATH + '?status=pending', {})
const listPayload = listRes.json()
check('the /list answer is a summary page', listPayload.ok === true && Array.isArray(listPayload.tasks), listRes.text.substring(0, 240))

const toolPending = await rig.action('list', { status: 'pending' })
const toolDone = await rig.action('list', { status: 'done' })
check('the tool list answers a summary page', toolPending.ok === true && Array.isArray(toolPending.tasks), JSON.stringify(toolPending).substring(0, 240))

const byId = (rows, id) => (Array.isArray(rows) ? rows.filter((row) => row.id === id)[0] : undefined)
const pendingFromTasks = byId(statePayload.tasks, 'T-1')
const pendingFromQueue = byId(statePayload.queue, 'T-1')
const pendingFromList = byId(listPayload.tasks, 'T-1')
const pendingFromTool = byId(toolPending.tasks, 'T-1')

check(
  'the same pending card reaches all four summary surfaces',
  pendingFromTasks !== undefined && pendingFromQueue !== undefined && pendingFromList !== undefined && pendingFromTool !== undefined,
  JSON.stringify({
    tasks: statePayload.tasks.length,
    queue: statePayload.queue.length,
    list: listPayload.tasks.length,
    tool: toolPending.tasks.length,
  }),
)

const surfaces = [
  ['/state.tasks', pendingFromTasks],
  ['/state.queue', pendingFromQueue],
  ['/list', pendingFromList],
  ['tool list', pendingFromTool],
]
for (const [name, card] of surfaces) {
  const reference = JSON.stringify(pendingFromTasks)
  check(name + ' carries the frozen TaskSummary field set', card !== undefined && Object.keys(card).sort().join(',') === TASK_SUMMARY_FIELDS.slice().sort().join(','), card === undefined ? 'missing' : Object.keys(card).sort().join(','))
  check(name + ' is byte-identical to /state.tasks for the same card', JSON.stringify(card) === reference)
}
console.log('PASS  one builder: /state.tasks, /state.queue, /list and the tool list agree on the card')

const doneFromTasks = byId(statePayload.tasks, 'T-2')
const doneFromList = byId((await call(surface, LIST_PATH + '?status=done', {})).json().tasks, 'T-2')
const doneFromTool = byId(toolDone.tasks, 'T-2')
check(
  'a DONE card agrees across /state.tasks, /list and the tool list too',
  doneFromTasks !== undefined && JSON.stringify(doneFromTasks) === JSON.stringify(doneFromList) && JSON.stringify(doneFromTasks) === JSON.stringify(doneFromTool),
  JSON.stringify({ state: doneFromTasks === undefined, list: doneFromList === undefined, tool: doneFromTool === undefined }),
)

// ── 2. the facts that were lost once are back, on EVERY surface ────────────
for (const [name, card] of [
  ['/state.tasks', doneFromTasks],
  ['/list', doneFromList],
  ['tool list', doneFromTool],
]) {
  check(
    name + ' keeps review.deliveredTo as {name,id} (T-225)',
    card !== undefined && card.review.deliveredTo !== null && card.review.deliveredTo.id === 'session-reviewer-1' && Object.keys(card.review.deliveredTo).sort().join(',') === 'id,name',
    JSON.stringify(card === undefined ? null : card.review),
  )
  check(
    name + ' keeps test.deliveredTo as {name,id} (T-225)',
    card !== undefined && card.test.deliveredTo !== null && card.test.deliveredTo.id === 'session-tester-1' && Object.keys(card.test.deliveredTo).sort().join(',') === 'id,name',
    JSON.stringify(card === undefined ? null : card.test),
  )
  check(
    name + ' keeps writeFileCount and drops the writeFiles array (T-228)',
    card !== undefined && card.writeFileCount === 1 && card.writeFiles === undefined,
    JSON.stringify(card === undefined ? null : { count: card.writeFileCount, files: card.writeFiles }),
  )
  check(
    name + ' names the probe COUNT, not the probe list',
    card !== undefined && card.verification.probeCount === 1 && card.verification.probes === undefined,
    JSON.stringify(card === undefined ? null : card.verification),
  )
  check(
    name + ' keeps the newest two history rows as events',
    card !== undefined && card.events.length === 2 && card.events[0].to === 'done' && card.events[1].to === 'done' && card.events[1].note.indexOf('detail-class') >= 0 && card.history === undefined,
    JSON.stringify(card === undefined ? null : card.events),
  )
  check(
    name + ' keeps no detail-class review/test payload',
    card !== undefined && card.review.record === undefined && card.review.reasons === undefined && card.test.record === undefined && card.test.evidence === undefined && card.test.evidenceLength === EVIDENCE.length,
    JSON.stringify(card === undefined ? null : { review: Object.keys(card.review), test: Object.keys(card.test) }),
  )
  check(
    name + ' carries the compact merge facts and their class',
    card !== undefined && card.merge.status === 'merged' && card.merge.declaredCount === 1 && card.merge.actualCount === 1 && card.merge.outputLength === 'merged cleanly'.length && card.merge.declaredFiles === undefined && card.merge.output === undefined,
    JSON.stringify(card === undefined ? null : card.merge),
  )
  check(
    name + ' carries the handoff/report fields the panel renders',
    card !== undefined && card.kind === 'dev' && card.reportSummary === null && card.ownerSession === null && card.dependency.state === 'ready',
    JSON.stringify(card === undefined ? null : { kind: card.kind, dependency: card.dependency }),
  )
}
const pendingTool = pendingFromTool
check(
  'a PENDING ready card is in queue[] AND tasks[] with the same dependency verdict',
  pendingFromQueue !== undefined && pendingFromQueue.dependency.state === 'ready' && pendingTool.dependency.state === 'ready',
  JSON.stringify(pendingFromQueue === undefined ? null : pendingFromQueue.dependency),
)

// ── 3. no own field is ever undefined (the tool walker must not have to fix it) ──
function undefinedPaths(value, path, out) {
  if (value === undefined) {
    out.push(path)
    return out
  }
  if (value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    value.forEach((entry, index) => undefinedPaths(entry, path + '[' + String(index) + ']', out))
    return out
  }
  for (const key of Object.keys(value)) undefinedPaths(value[key], path + '.' + key, out)
  return out
}
for (const [name, card] of surfaces.concat([['/list done', doneFromList], ['tool list done', doneFromTool]])) {
  const bad = undefinedPaths(card, name, [])
  check(name + ' emits no undefined own field', bad.length === 0, JSON.stringify(bad).substring(0, 300))
}

// ── 4. TaskDetail is a STRICT superset of TaskSummary ─────────────────────
/** Detail must contain every key of the summary, with the same scalar value;
 *  an object/array that the detail extends is compared key by key, recursively. */
function supersetProblems(summary, detail, path, out) {
  if (summary === null || typeof summary !== 'object') {
    if (detail !== summary) out.push(path + ': ' + JSON.stringify(summary) + ' != ' + JSON.stringify(detail).substring(0, 80))
    return out
  }
  if (detail === null || typeof detail !== 'object') {
    out.push(path + ': detail is not an object')
    return out
  }
  if (Array.isArray(summary)) {
    if (!Array.isArray(detail) || detail.length !== summary.length) {
      out.push(path + ': array length differs')
      return out
    }
    summary.forEach((entry, index) => supersetProblems(entry, detail[index], path + '[' + String(index) + ']', out))
    return out
  }
  for (const key of Object.keys(summary)) {
    if (!Object.prototype.hasOwnProperty.call(detail, key)) {
      out.push(path + '.' + key + ': missing from detail')
      continue
    }
    supersetProblems(summary[key], detail[key], path + '.' + key, out)
  }
  return out
}

const taskRes = await call(surface, TASK_PATH + '?id=T-2', {})
const detail = taskRes.json().task
check('/task answers the done card detail', taskRes.json().ok === true && detail !== undefined && detail.id === 'T-2', taskRes.text.substring(0, 240))
check(
  '/task carries every TaskSummary field',
  detail !== undefined && TASK_SUMMARY_FIELDS.every((key) => Object.prototype.hasOwnProperty.call(detail, key)),
  JSON.stringify(TASK_SUMMARY_FIELDS.filter((key) => detail === undefined || !Object.prototype.hasOwnProperty.call(detail, key))),
)
check(
  '/task carries every detail-only field',
  detail !== undefined && TASK_DETAIL_ONLY_FIELDS.every((key) => Object.prototype.hasOwnProperty.call(detail, key)),
  JSON.stringify(TASK_DETAIL_ONLY_FIELDS.filter((key) => detail === undefined || !Object.prototype.hasOwnProperty.call(detail, key))),
)
const leaked = TASK_DETAIL_ONLY_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(doneFromTasks, key))
check('the summary carries NO detail-only field', leaked.length === 0, JSON.stringify(leaked))
check(
  'the detail is a strict superset of the summary (nested records included)',
  supersetProblems(doneFromTasks, detail, 'task', []).length === 0,
  JSON.stringify(supersetProblems(doneFromTasks, detail, 'task', [])).substring(0, 600),
)
check(
  'the detail keeps the full stage payload the summary dropped',
  detail !== undefined && detail.review.reasons === REASONS && detail.test.evidence === EVIDENCE && detail.review.record !== null && detail.test.record !== null,
  JSON.stringify(detail === undefined ? null : { reasons: String(detail.review.reasons).length, evidence: String(detail.test.evidence).length }),
)
check(
  'the detail keeps the full deliveredTo (at + generation) the summary compacted',
  detail !== undefined && detail.review.deliveredTo.at === '2026-11-20T02:10:00.000Z' && detail.review.deliveredTo.generation === 3 && detail.test.deliveredTo.generation === 2,
  JSON.stringify(detail === undefined ? null : [detail.review.deliveredTo, detail.test.deliveredTo]),
)
check(
  'the detail keeps the merge strings/files the summary counted',
  detail !== undefined && detail.merge.output === 'merged cleanly' && detail.merge.declaredFiles.join(',') === 'plugin/task-center/service.mjs' && detail.merge.declaredCount === 1,
  JSON.stringify(detail === undefined ? null : detail.merge),
)
check(
  'the detail keeps the write lists the summary counted',
  detail !== undefined && detail.writeFiles.join(',') === 'plugin/task-center/service.mjs' && detail.actualFiles.length === 1 && detail.writeFileCount === 1,
  JSON.stringify(detail === undefined ? null : { files: detail.writeFiles, actual: detail.actualFiles }),
)
const getRes = await rig.action('get', { id: 'T-2' })
check('the tool get answers the SAME detail as /task', getRes.ok === true && JSON.stringify(getRes.task) === JSON.stringify(detail))
// The tool board / full /state answer is the SAME detail the drawer fetches:
// one card, one detail, whichever surface asked for it.
const fullSnapshot = await rig.api.snapshot(rig.project, { sessionId: TEST_SESSION })
const fullCard = byId(fullSnapshot.tasks, 'T-2')
check(
  'the full /state answer (the tool board read) carries the SAME detail as /task',
  fullCard !== undefined && JSON.stringify(fullCard) === JSON.stringify(detail),
  JSON.stringify(fullCard === undefined ? null : { keys: Object.keys(fullCard).length, hasEvents: fullCard.events !== undefined }),
)
const pendingDetail = (await call(surface, TASK_PATH + '?id=T-1', {})).json().task
check(
  'the pending card detail is a superset of its summary too',
  supersetProblems(pendingFromTasks, pendingDetail, 'task', []).length === 0 && Object.keys(pendingDetail).sort().join(',') === TASK_SUMMARY_FIELDS.concat(TASK_DETAIL_ONLY_FIELDS).sort().join(','),
  JSON.stringify(supersetProblems(pendingFromTasks, pendingDetail, 'task', [])).substring(0, 500),
)
for (const [name, value] of [['/task detail', detail], ['/task pending detail', pendingDetail], ['the full /state card', fullCard]]) {
  const bad = undefinedPaths(value, name, [])
  check(name + ' emits no undefined own field', bad.length === 0, JSON.stringify(bad).substring(0, 300))
}

// ── 5. the VIEW facts: only the current stage slot may describe a wait ─────
// The summary carries process facts the board cannot hold (the stage slot the
// dispatcher queued, the testing candidate, the in-memory lock table). They are
// injected through `view`, so this block pins the rules WITHOUT a rig.
{
  const queueBoard = { tasks: [], dispatch: { state: 'running', maxConcurrent: 3 } }
  const testing = { id: 'T-9', title: 'testing card', status: 'testing', dependsOn: [], review: { status: 'approved', attempt: 1 }, test: { status: 'pending', attempt: 1 } }
  const queuedView = { stageSlot: (task, kind) => (kind === 'tester' ? { at: null, position: 2 } : null) }
  const queued = buildTaskSummary(queueBoard, testing, 1000, queuedView)
  check('a QUEUED testing card names its queue position', queued.queuePosition === 2 && queued.test.deliveredAt === null, JSON.stringify({ position: queued.queuePosition, deliveredAt: queued.test.deliveredAt }))
  const deliveredView = { stageSlot: (task, kind) => (kind === 'tester' ? { at: 5000, position: null } : { at: 4000, position: null }) }
  const delivered = buildTaskSummary(queueBoard, testing, 1000, deliveredView)
  check(
    'a DELIVERED stage slot becomes deliveredAt and never a position',
    delivered.queuePosition === null && delivered.test.deliveredAt === '1970-01-01T00:00:05.000Z' && delivered.review.deliveredAt === '1970-01-01T00:00:04.000Z',
    JSON.stringify({ position: delivered.queuePosition, test: delivered.test.deliveredAt, review: delivered.review.deliveredAt }),
  )
  const reviewing = { id: 'T-9', title: 'reviewing card', status: 'reviewing', dependsOn: [], review: { status: 'pending', attempt: 1 } }
  check('only the CURRENT stage slot can describe a wait', buildTaskSummary(queueBoard, reviewing, 1000, queuedView).queuePosition === null)
  const candidateView = { candidate: () => ({ path: '/c/test-T-9', branch: 'test/T-9', base: 'base-sha', head: 'head-sha' }) }
  const withCandidate = buildTaskSummary(queueBoard, testing, 1000, candidateView)
  check('the testing candidate rides the summary as a small object', withCandidate.candidate.path === '/c/test-T-9' && withCandidate.candidate.head === 'head-sha')
  check('no candidate view means candidate:null, never undefined', withCandidate.candidate !== null && buildTaskSummary(queueBoard, testing, 1000).candidate === null)
  const lockBoard = { tasks: [], dispatch: { state: 'running', maxConcurrent: 3 } }
  const blockedByLock = { id: 'T-8', title: 'locked card', status: 'pending', dependsOn: [], writeFiles: ['plugin/a.mjs'] }
  const locks = { 'plugin/a.mjs': { path: 'plugin/a.mjs', taskId: 'T-OTHER', agent: null } }
  check('a held file is the file-lock wait reason', buildTaskSummary(lockBoard, blockedByLock, 1000, { locks: locks }).waitingReason === 'file-lock')
  check('an unrelated held file is no reason to wait', buildTaskSummary(lockBoard, blockedByLock, 1000, { locks: { 'plugin/b.mjs': { path: 'plugin/b.mjs', taskId: 'T-OTHER', agent: null } } }).waitingReason === null)
  check('a paused dispatcher is the dispatch-paused wait reason', buildTaskSummary({ tasks: [], dispatch: { state: 'paused' } }, blockedByLock, 1000).waitingReason === 'dispatch-paused')
}

// ── 6. the summary stays a fraction of the full answer (200-card board) ────
// One board the size of a real long-lived project: every card carries the
// detail-class payload (spec/acceptance/evidence, a long history, stage
// records), which is exactly what a summary must NOT resend on a 2.5 s poll.
function manyCards(count) {
  const tasks = []
  for (let index = 1; index <= count; index += 1) {
    const stamp = '2026-11-' + String(10 + (index % 9)).padStart(2, '0') + 'T00:00:00.000Z'
    tasks.push({
      id: 'T-' + String(index),
      title: 'Card ' + String(index) + ' keeps the read model honest',
      kind: 'dev',
      status: index % 5 === 0 ? 'pending' : 'done',
      priority: 30,
      // The local long-lived board measured ~23.7 KB per card (T-229 §0); the
      // detail payload here is that shape: a long spec/acceptance, a long
      // history and the stage records.
      spec: BIG.repeat(140),
      acceptance: BIG.repeat(80),
      evidence: EVIDENCE.repeat(8),
      dependsOn: [],
      writeFiles: ['plugin/task-center/api.mjs', 'plugin/task-center/service.mjs'],
      verification: { probes: [{ id: 'suite', command: 'npm test' }] },
      createdBy: '@planner',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: stamp,
      leaseUntil: null,
      history: [
        { at: '2026-11-02T00:00:00.000Z', by: '@planner', from: null, to: 'pending', note: 'created ' + BIG.repeat(8) },
        { at: '2026-11-03T00:00:00.000Z', by: 'scheduler', from: 'pending', to: 'running', note: 'dispatched ' + BIG.repeat(8) },
        { at: '2026-11-04T00:00:00.000Z', by: '@worker', from: 'running', to: 'reviewing', note: 'submitted ' + BIG.repeat(8) },
        { at: '2026-11-05T00:00:00.000Z', by: '@reviewer', from: 'reviewing', to: 'testing', note: 'approved ' + BIG.repeat(8) },
        { at: '2026-11-06T00:00:00.000Z', by: '@tester', from: 'testing', to: 'done', note: 'passed ' + BIG.repeat(8) },
      ],
      review: {
        status: 'approved',
        by: '@reviewer',
        at: '2026-11-05T00:00:00.000Z',
        attempt: 1,
        reasons: REASONS.repeat(2),
        record: { verdict: 'approved', checked: [], findings: [], residualRisks: [] },
        deliveredTo: { name: 'reviewer-' + String(index), id: 'session-reviewer-' + String(index), at: '2026-11-04T12:00:00.000Z', generation: 1 },
      },
      test: {
        status: 'passed',
        by: '@tester',
        at: '2026-11-06T00:00:00.000Z',
        attempt: 1,
        evidence: EVIDENCE.repeat(2),
        record: { verdict: 'passed', probes: [], adversarial: [], notes: 'ok' },
        deliveredTo: { name: 'tester-' + String(index), id: 'session-tester-' + String(index), at: '2026-11-05T12:00:00.000Z', generation: 1 },
      },
    })
  }
  return JSON.stringify({ version: 1, tasks: tasks })
}

{
  const bigRig = createRig({ taskAgents: createFakeTaskAgents() })
  const bigText = manyCards(200)
  seedBoard(bigRig.fs, PROJECT, bigText)
  const bigSurface = install(bigRig)
  const lightRes = await call(bigSurface, STATE_PATH + '?light=1', {})
  const lightPayload = lightRes.json()
  check(
    'the 200-card summary answer is complete (the panel poll trims the done tail)',
    lightPayload.ok === true && lightPayload.tasks.length >= 40 && lightPayload.tasks.length < 200,
    JSON.stringify({ count: lightPayload.tasks === undefined ? null : lightPayload.tasks.length }),
  )
  // Same endpoint, same board, same flags minus the route's doneLimit: both sides
  // carry the light/full metadata so the comparison is the CARD projection.
  const summaryPayload = await bigRig.api.snapshot(bigRig.project, { full: false, light: true, sessionId: TEST_SESSION })
  check('the summary side carries every card of the board', summaryPayload.ok === true && summaryPayload.tasks.length === 200, JSON.stringify({ count: summaryPayload.tasks === undefined ? null : summaryPayload.tasks.length }))
  const summaryBytes = JSON.stringify(summaryPayload).length
  const fullPayload = await bigRig.api.snapshot(bigRig.project, { sessionId: TEST_SESSION })
  const fullBytes = JSON.stringify(fullPayload).length
  check('the full side is the detail answer for the same board', fullPayload.ok === true && fullPayload.tasks.length === 200 && fullPayload.tasks[0].spec !== undefined, JSON.stringify({ count: fullPayload.tasks === undefined ? null : fullPayload.tasks.length }))
  check(
    'the 200-card summary response stays under 10% of the full response',
    summaryBytes * 10 < fullBytes,
    'summary=' + String(summaryBytes) + 'B full=' + String(fullBytes) + 'B ratio=' + (Math.round((summaryBytes / fullBytes) * 1000) / 10) + '% board=' + String(bigText.length) + 'B',
  )
  console.log('PASS  the summary is a fraction of the full answer: ' + String(summaryBytes) + 'B vs ' + String(fullBytes) + 'B')
}

console.log(failures === 0 ? '\nPASS  the TaskSummary/TaskDetail read model contract' : '\nFAIL  ' + String(failures) + ' contract check(s)')
process.exit(failures === 0 ? 0 : 1)
