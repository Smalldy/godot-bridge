// T-195 — durable DecisionRequests; T-197 adds the stage-timeout questions.
//
// Covers the acceptance surface: persistence across a "restart" (a second store
// over the same filesystem), CAS/idempotent creation, one-shot answers, timeout
// defaults that never overwrite an answer, destructive defaults that never
// auto-run, resolved-record trimming, and the decisionList/decisionAnswer
// actions routed through the ordinary action API and the panel snapshot.
//
// T-197 adds the stage questions: a dev/review timeout ASKS first, the expired
// question continues the SAME stage, "replace" releases the old stage child
// before starting exactly one new one, and the escalated event ask can block.
//
// T-198 adds the event POLICY: the 13-event catalog with the aligned defaults,
// global default + project override persistence with per-field fallback, the
// ask/notify/silent split (a modal, an announced auto-default, an audit-only
// action), the configurable limits, and the fixed high-risk guards that no
// stored setting can bypass.

import assert from 'node:assert/strict'
import { createFakeGit, createFakeTaskAgents, createRig, createTask, PROJECT } from './support/fixtures.mjs'
import {
  createDecisionStore,
  decisionPolicyPath,
  decisionPolicyView,
  decisionsPath,
  globalDecisionPolicyPath,
  workspaceGlobalDecisionPolicyPath,
} from '../../plugin/task-center/decisions.mjs'
import { updateBoard } from '../../plugin/task-center/board.mjs'
import { writePolicyFor } from '../../plugin/task-center/state.mjs'
import { findTask } from '../../plugin/task-center/service.mjs'
import {
  DECISION_CONFIRM_WORD,
  DECISION_EVENT_CATALOG,
  DECISION_FIXED_GUARDS,
  MAX_RESOLVED_DECISIONS,
  normaliseDecisionPolicyEvent,
  resolveDecisionPolicy,
} from '../../plugin/task-center/schema.mjs'

const START = Date.parse('2026-11-19T00:00:00.000Z')
let clockNow = START
const now = () => clockNow

function freshRig(options) {
  clockNow = START
  const opts = options === undefined ? {} : options
  return createRig(Object.assign({ now: now, ensureDir: function () {} }, opts))
}

const CREATE_OPTIONS = [
  { id: 'create', label: '创建任务', description: '写入任务板并加入待办队列', default: true },
  { id: 'cancel', label: '取消创建', danger: false },
]

function createInput(overrides) {
  return Object.assign(
    {
      id: 'DEC-1',
      eventKey: 'create',
      taskId: 'T-1',
      eventLabel: '创建任务',
      title: '创建任务 T-1？',
      body: '任务：First card',
      options: CREATE_OPTIONS,
      defaultOption: 'create',
      timeoutMs: 120000,
      payload: { taskId: 'T-1', kind: 'dev' },
    },
    overrides === undefined ? {} : overrides,
  )
}

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

// ── persistence and restart recovery ─────────────────────────────────────────
{
  const rig = freshRig()
  const created = await rig.api.decisions.request(PROJECT, createInput(), { by: '@user' })
  check('requestDecision stores a pending request', created.ok === true && created.created === true && created.decision.id === 'DEC-1', JSON.stringify(created))
  check('the request is marked pending with a server deadline', created.decision.status === 'pending' && created.decision.timeoutAt === '2026-11-19T00:02:00.000Z', String(created.decision.timeoutAt))
  check('the default option is visibly marked in the stored options', created.decision.options.filter((option) => option.default === true).length === 1 && created.decision.options[0].id === 'create')
  check('remainingMs is measured from the server clock', created.decision.remainingMs === 120000, String(created.decision.remainingMs))
  const entry = rig.fs.files.get(decisionsPath(PROJECT))
  check('the store is persisted at .agents/decisions.json', entry !== undefined && JSON.parse(entry.text).requests.length === 1)

  // A new store over the same fs models a host restart: pending must come back.
  const restarted = createDecisionStore({ fs: rig.fs }, { now: now })
  const recovered = await restarted.pending(PROJECT)
  check('a restarted host recovers the pending request', recovered.ok === true && recovered.pending.length === 1 && recovered.pending[0].id === 'DEC-1', JSON.stringify(recovered))
  const listed = await restarted.list(PROJECT, { status: 'all' })
  check('the recovered counters agree', listed.ok === true && listed.counts.pending === 1 && listed.counts.total === 1, JSON.stringify(listed.counts))
}

// ── idempotent creation and typed conflicts ──────────────────────────────────
{
  const rig = freshRig()
  const first = await rig.api.decisions.request(PROJECT, createInput(), {})
  const replay = await rig.api.decisions.request(PROJECT, createInput(), {})
  check('replaying the same id and content is an idempotent success', replay.ok === true && replay.duplicate === true && replay.decision.id === first.decision.id)
  const conflict = await rig.api.decisions.request(PROJECT, createInput({ body: 'different body' }), {})
  check('the same id with different content is a typed conflict', conflict.ok === false && conflict.code === 'decision-conflict', JSON.stringify(conflict))
  const auto = await rig.api.decisions.request(PROJECT, createInput({ id: undefined, title: 'Another question' }), {})
  check('an omitted id gets the next DEC-<n> id', auto.ok === true && auto.decision.id === 'DEC-2', JSON.stringify(auto.decision && auto.decision.id))
}

// ── one-shot answers and option validation ───────────────────────────────────
{
  const rig = freshRig()
  await rig.api.decisions.request(PROJECT, createInput(), {})
  const badOption = await rig.api.decisions.answer(PROJECT, { id: 'DEC-1', option: 'nope' }, { by: '@user' })
  check('an option outside the request is refused', badOption.ok === false && badOption.code === 'invalid-option', JSON.stringify(badOption))
  const noAnswer = await rig.api.decisions.answer(PROJECT, { id: 'DEC-1' }, { by: '@user' })
  check('an answer with no option and no text is refused', noAnswer.ok === false && noAnswer.code === 'invalid-answer', JSON.stringify(noAnswer))
  const answered = await rig.api.decisions.answer(PROJECT, { id: 'DEC-1', option: 'create', text: 'looks good' }, { by: '@user' })
  check('the first answer lands with its resolution', answered.ok === true && answered.decision.status === 'answered' && answered.decision.resolution.option === 'create' && answered.decision.resolution.text === 'looks good', JSON.stringify(answered))
  const again = await rig.api.decisions.answer(PROJECT, { id: 'DEC-1', option: 'cancel' }, { by: '@user' })
  check('a second answer is refused with already-answered', again.ok === false && again.code === 'already-answered', JSON.stringify(again))
  const unknown = await rig.api.decisions.answer(PROJECT, { id: 'DEC-404', option: 'create' }, { by: '@user' })
  check('an unknown decision is a typed refusal', unknown.ok === false && unknown.code === 'unknown-decision', JSON.stringify(unknown))
}

// ── destructive options require DELETE ───────────────────────────────────────
{
  const rig = freshRig()
  await rig.api.decisions.request(
    PROJECT,
    createInput({
      id: 'DEC-2',
      eventKey: 'delete-tree',
      title: '确认删除依赖树？',
      highRisk: true,
      options: [
        { id: 'return', label: '返回', default: true },
        { id: 'purge', label: '永久删除 3 张卡', danger: true },
      ],
      defaultOption: 'return',
    }),
    {},
  )
  const noWord = await rig.api.decisions.answer(PROJECT, { id: 'DEC-2', option: 'purge' }, { by: '@user' })
  check('a destructive option without the word is refused', noWord.ok === false && noWord.code === 'confirmation-required', JSON.stringify(noWord))
  const wrongWord = await rig.api.decisions.answer(PROJECT, { id: 'DEC-2', option: 'purge', confirm: 'delete' }, { by: '@user' })
  check('the confirmation word is case-sensitive', wrongWord.ok === false && wrongWord.code === 'confirmation-required', JSON.stringify(wrongWord))
  const withWord = await rig.api.decisions.answer(PROJECT, { id: 'DEC-2', option: 'purge', confirm: DECISION_CONFIRM_WORD }, { by: '@user' })
  check('the exact DELETE word accepts the destructive option', withWord.ok === true && withWord.decision.resolution.option === 'purge', JSON.stringify(withWord))
}

// ── timeout default, never over an answer ────────────────────────────────────
{
  const rig = freshRig()
  await rig.api.decisions.request(PROJECT, createInput({ id: 'DEC-3', title: '创建任务 T-3？', options: [{ id: 'create', label: '创建任务', default: true }, { id: 'cancel', label: '取消创建' }], defaultOption: 'create', timeoutMs: 1000 }), {})
  await rig.api.decisions.request(PROJECT, createInput({ id: 'DEC-4', title: '创建任务 T-4？', options: [{ id: 'create', label: '创建任务', default: true }, { id: 'cancel', label: '取消创建' }], defaultOption: 'create', timeoutMs: 1000 }), {})
  const answered = await rig.api.decisions.answer(PROJECT, { id: 'DEC-4', option: 'cancel' }, { by: '@user' })
  check('the second request is answered before the deadline', answered.ok === true && answered.decision.status === 'answered')
  clockNow = START + 5000
  const swept = await rig.api.decisions.sweep(PROJECT)
  check('the sweep expires the due request through its default', swept.ok === true && swept.wrote === true && swept.expired.length === 1 && swept.expired[0].id === 'DEC-3', JSON.stringify(swept.expired))
  check('the expired request records the default resolution', swept.expired[0].status === 'expired' && swept.expired[0].resolution.option === 'create' && swept.expired[0].resolution.via === 'timeout')
  const all = await rig.api.decisions.list(PROJECT, { status: 'all' })
  const rowOf = (id) => all.decisions.filter((decision) => decision.id === id)[0]
  check('the answered request is NOT overwritten by the sweep', rowOf('DEC-4').status === 'answered' && rowOf('DEC-4').resolution.option === 'cancel')
  const late = await rig.api.decisions.answer(PROJECT, { id: 'DEC-3', option: 'create' }, { by: '@user' })
  check('a late answer after expiry is ignored with decision-expired', late.ok === false && late.code === 'decision-expired', JSON.stringify(late))
  const idempotentSweep = await rig.api.decisions.sweep(PROJECT)
  check('a second sweep writes nothing', idempotentSweep.ok === true && idempotentSweep.wrote === false && idempotentSweep.expired.length === 0)
}

// ── a dangerous default is never auto-selected ───────────────────────────────
{
  const rig = freshRig()
  await rig.api.decisions.request(
    PROJECT,
    createInput({
      id: 'DEC-5',
      eventKey: 'delete-tree',
      title: '确认删除依赖树？',
      highRisk: true,
      timeoutMs: 1000,
      options: [
        { id: 'return', label: '返回', default: true },
        { id: 'purge', label: '永久删除 3 张卡', danger: true },
      ],
      defaultOption: 'purge',
    }),
    {},
  )
  clockNow = START + 2000
  const swept = await rig.api.decisions.sweep(PROJECT)
  check(
    'a dangerous default expires unresolved instead of auto-running',
    swept.ok === true && swept.expired.length === 1 && swept.expired[0].status === 'expired' && swept.expired[0].resolution === null && swept.expired[0].outcome === 'requires-manual',
    JSON.stringify(swept.expired),
  )
}

// ── resolved-record trimming ─────────────────────────────────────────────────
{
  const rig = freshRig()
  const total = MAX_RESOLVED_DECISIONS + 5
  for (let index = 0; index < total; index += 1) {
    const id = 'DEC-' + String(index + 1)
    await rig.api.decisions.request(PROJECT, createInput({ id: id, title: 'Question ' + String(index + 1), timeoutMs: 0 }), {})
    const answer = await rig.api.decisions.answer(PROJECT, { id: id, option: 'create' }, { by: '@user' })
    if (answer.ok !== true) throw new Error('answer failed: ' + JSON.stringify(answer))
  }
  const stored = JSON.parse(rig.fs.files.get(decisionsPath(PROJECT)).text)
  const resolved = stored.requests.filter((record) => record.status !== 'pending')
  check('resolved records are trimmed to the cap (' + String(MAX_RESOLVED_DECISIONS) + ')', resolved.length === MAX_RESOLVED_DECISIONS, String(resolved.length))
  const listed = await rig.api.decisions.list(PROJECT, { status: 'all', limit: 200 })
  check('the trimmed store still reports its counters', listed.ok === true && listed.counts.answered === MAX_RESOLVED_DECISIONS, JSON.stringify(listed.counts))
}

// ── CAS: a lost write race is retried, not lost ─────────────────────────────
{
  const rig = freshRig()
  let throws = 1
  rig.fs.hooks.beforeWrite = function () {
    if (throws > 0) {
      throws -= 1
      return 'stale'
    }
    return undefined
  }
  const created = await rig.api.decisions.request(PROJECT, createInput(), {})
  check('a stale write is retried under the CAS', created.ok === true && created.created === true, JSON.stringify(created))
  const stored = JSON.parse(rig.fs.files.get(decisionsPath(PROJECT)).text)
  check('exactly one request survives the retry', stored.requests.length === 1, String(stored.requests.length))
}

// ── the ordinary action surface (decisionList / decisionAnswer) ──────────────
{
  const rig = freshRig()
  await rig.api.decisions.request(PROJECT, createInput({ id: 'DEC-9' }), {})
  const listed = await rig.action('decisionList', {})
  check('decisionList routes through the action API', listed.ok === true && Array.isArray(listed.decisions) && listed.decisions.length === 1 && listed.decisions[0].id === 'DEC-9', JSON.stringify(listed))
  check('decisionList answers the typed counts', listed.counts.pending === 1 && listed.counts.total === 1)
  const answered = await rig.action('decisionAnswer', { decisionId: 'DEC-9', option: 'create' })
  check('decisionAnswer routes through the action API', answered.ok === true && answered.decision.status === 'answered', JSON.stringify(answered))
  const denied = await rig.action('decisionAnswer', { decisionId: 'DEC-9', option: 'create' })
  check('the action refuses a second answer by code', denied.ok === false && denied.code === 'already-answered', JSON.stringify(denied))
  const resolved = await rig.action('decisionList', { decisionStatus: 'answered' })
  check('decisionList filters by status', resolved.ok === true && resolved.decisions.length === 1 && resolved.decisions[0].status === 'answered', JSON.stringify(resolved.decisions))
  const snapshot = await rig.api.snapshot(PROJECT, { full: false })
  check('the panel snapshot carries the pending queue field', Array.isArray(snapshot.decisions) && snapshot.decisions.length === 0 && snapshot.decisionsError === null, JSON.stringify(snapshot.decisions))
}

// ── the snapshot sweeps deadlines so a panel poll can trigger the default ────
{
  const rig = freshRig()
  await rig.api.decisions.request(PROJECT, createInput({ id: 'DEC-10', timeoutMs: 1000 }), {})
  clockNow = START + 3000
  const snapshot = await rig.api.snapshot(PROJECT, { full: false })
  check('a snapshot poll expires the due request', Array.isArray(snapshot.decisions) && snapshot.decisions.length === 0, JSON.stringify(snapshot.decisions))
  const stored = JSON.parse(rig.fs.files.get(decisionsPath(PROJECT)).text)
  check('the poll persisted the timeout default', stored.requests[0].status === 'expired' && stored.requests[0].resolution.option === 'create', JSON.stringify(stored.requests[0]))
}


// ── T-197: a dev timeout ASKS first; nothing is blocked or restarted ────────
{
  const stageClock = Date.parse('2026-11-19T06:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'stage dev' })
  const dependent = await createTask(rig, { title: 'stage dev dependent', dependsOn: [task.id] })
  await rig.action('start')
  let row = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check('the dev stage starts on a live worker', row.status === 'running' && row.assignee !== null, String(row.status))
  const workerId = row.assignee.session
  // One full slice of silence, then the host asks.
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  tick = stageClock + 26 * 60 * 1000
  await rig.settle()
  let pending = await rig.api.decisions.pending(PROJECT)
  let question = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'dev-timeout')[0] : undefined
  check('a dev timeout creates a decision instead of blocking', question !== undefined && question.status === 'pending', JSON.stringify(pending.pending.map((decision) => decision.eventKey)))
  check('the dev question defaults to continue', question !== undefined && question.defaultOption === 'continue', JSON.stringify(question === undefined ? null : question.defaultOption))
  check('the dev question offers continue/retry/cancel/cancel-tree', question !== undefined && question.options.map((option) => option.id).join(',') === 'continue,retry-dev,cancel,cancel-tree', JSON.stringify(question === undefined ? null : question.options.map((option) => option.id)))
  check('the destructive retry needs the confirmation word', question !== undefined && question.options.filter((option) => option.id === 'retry-dev')[0].danger === true, JSON.stringify(question === undefined ? null : question.options))
  row = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check('the card keeps running while the question is pending', row.status === 'running', String(row.status))
  check('the question names the card and the stage', question !== undefined && question.taskId === task.id && question.eventLabel === '开发超时' && question.body.indexOf('当前阶段：开发') >= 0, JSON.stringify({ taskId: question === undefined ? null : question.taskId, body: question === undefined ? null : question.body }))
  check('the dev question lists the chained downstream cards', question !== undefined && question.body.indexOf('下游：1 张卡') >= 0 && question.body.indexOf('└─ ' + dependent.id) >= 0, JSON.stringify(question === undefined ? null : question.body))
  check('the dev question counts consecutive timeouts', question !== undefined && question.body.indexOf('连续超时：0/3') >= 0, JSON.stringify(question === undefined ? null : question.body))

  const answered = await rig.action('decisionAnswer', { decisionId: question.id, option: 'continue' })
  check('a human continue is executed once', answered.ok === true && answered.applied !== null && answered.applied.executed === true, JSON.stringify(answered.applied))
  row = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check('continue keeps the worker and the worktree', row.status === 'running' && row.assignee.session === workerId && row.worktree === row.worktree, JSON.stringify({ status: row.status, worker: row.assignee.session }))
  check('the explicit continue is written to the history', row.history.some((entry) => String(entry.note).indexOf('人工选择继续') >= 0), JSON.stringify(row.history.map((entry) => entry.note)))
  const again = await rig.action('decisionAnswer', { decisionId: question.id, option: 'retry-dev' })
  check('a stage question is one-shot', again.ok === false && again.code === 'already-answered', JSON.stringify(again))
  // The fresh slice is a FULL 20 minutes, not the old total.
  tick += 10 * 60 * 1000
  await rig.settle()
  let after = await rig.api.decisions.pending(PROJECT)
  check('ten more silent minutes do not ask again', after.ok === true && after.pending.filter((decision) => decision.eventKey === 'dev-timeout').length === 0, JSON.stringify(after.pending.map((decision) => decision.eventKey)))
  tick += 11 * 60 * 1000
  await rig.settle()
  after = await rig.api.decisions.pending(PROJECT)
  check('a full new slice asks again', after.ok === true && after.pending.filter((decision) => decision.eventKey === 'dev-timeout').length === 1, JSON.stringify(after.pending.map((decision) => decision.eventKey)))
}

// ── T-197: replacing a reviewer releases the old child FIRST ────────────────
{
  const stageClock = Date.parse('2026-11-19T08:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'stage review' })
  await rig.action('start')
  const submitted = await rig.action('submit', { id: task.id, evidence: 'ready' })
  check('submit opens the review round', submitted.ok === true, JSON.stringify(submitted))
  const reviewing = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  const oldReviewer = String(reviewing.review.deliveredTo.id)
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  tick += 26 * 60 * 1000
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const question = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'review-timeout')[0] : undefined
  check('a silent review asks the human', question !== undefined, JSON.stringify(pending.pending.map((decision) => decision.eventKey)))
  const startsBefore = taskAgents.calls.filter((call) => call.kind === 'startReviewer').length
  const answered = await rig.action('decisionAnswer', { decisionId: question.id, option: 'replace' })
  check('replace is executed and names the new child', answered.ok === true && answered.applied.executed === true && typeof answered.applied.summary.agentId === 'string', JSON.stringify(answered.applied))
  // The stage service releases recorded ids through the facade's release(), so
  // either entry kind counts — what matters is that the disposal comes FIRST.
  const releaseIndex = taskAgents.calls.findIndex((call) => (call.kind === 'release' || call.kind === 'releaseTask') && (call.agentId === oldReviewer || call.released !== undefined))
  const startIndex = taskAgents.calls.findIndex((call, index) => call.kind === 'startReviewer' && index > releaseIndex)
  check('the old reviewer is released BEFORE the new one starts', releaseIndex >= 0 && startIndex > releaseIndex, JSON.stringify(taskAgents.calls.map((call) => call.kind + ':' + String(call.agentId === undefined ? call.taskId : call.agentId))))
  check('the old reviewer is gone from the live tree', taskAgents.live.has(oldReviewer) === false, JSON.stringify(Array.from(taskAgents.live)))
  check('exactly one new reviewer was started', taskAgents.calls.filter((call) => call.kind === 'startReviewer').length === startsBefore + 1, String(taskAgents.calls.filter((call) => call.kind === 'startReviewer').length))
  const afterReplace = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check('the card keeps its review phase on a new round', afterReplace.status === 'reviewing' && afterReplace.review.attempt === reviewing.review.attempt + 1, JSON.stringify({ status: afterReplace.status, attempt: afterReplace.review.attempt }))
  check('the new round records the new reviewer', afterReplace.review.deliveredTo !== null && afterReplace.review.deliveredTo.id !== oldReviewer, JSON.stringify(afterReplace.review.deliveredTo))
  check('the replacement is written to the history', afterReplace.history.some((entry) => String(entry.note).indexOf('replaced the reviewer') >= 0), JSON.stringify(afterReplace.history.map((entry) => entry.note)))
}

// ── T-197: a replacement refuses while the old stage agent is still live ────
{
  const stageClock = Date.parse('2026-11-19T10:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  // A facade whose disposal silently does nothing: the old child stays live.
  taskAgents.release = async () => false
  taskAgents.releaseTask = async () => ({ ok: false, released: [], interrupted: [], unresolved: [{ agentId: 'reviewer-T-1' }], failed: [], deferred: [] })
  const rig = createRig({ now: () => tick, taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'stage review live' })
  await rig.action('start')
  await rig.action('submit', { id: task.id, evidence: 'ready' })
  const reviewing = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  const oldReviewer = String(reviewing.review.deliveredTo.id)
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  tick += 26 * 60 * 1000
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const question = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'review-timeout')[0] : undefined
  const startsBefore = taskAgents.calls.filter((call) => call.kind === 'startReviewer').length
  const answered = await rig.action('decisionAnswer', { decisionId: question.id, option: 'replace' })
  check('a still-live old reviewer refuses the replacement', answered.ok === true && answered.applied.executed === false && answered.applied.code === 'stage-agent-still-live', JSON.stringify(answered.applied))
  check('no second reviewer is started while the old one lives', taskAgents.calls.filter((call) => call.kind === 'startReviewer').length === startsBefore, String(taskAgents.calls.filter((call) => call.kind === 'startReviewer').length))
  const after = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check('the refused replacement leaves the card untouched', after.review.deliveredTo.id === oldReviewer && after.review.attempt === reviewing.review.attempt, JSON.stringify(after.review))
  // The real facade can still release it (the test only needed one refused pass).
  check('the old reviewer really is still live in this scenario', taskAgents.live.has(oldReviewer) === true, JSON.stringify(Array.from(taskAgents.live)))
}

// ── T-197 event 10: the escalated ask can block the card ───────────────────
{
  const stageClock = Date.parse('2026-11-19T12:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'stage event ask' })
  await rig.action('start')
  await rig.action('submit', { id: task.id, evidence: 'ready' })
  const requested = await rig.api.decisions.request(
    PROJECT,
    {
      id: 'stage-ask-T-1-merge-conflict',
      eventKey: 'merge-conflict',
      taskId: task.id,
      eventLabel: '合并冲突',
      title: task.id + ' 合并冲突（连续自动恢复失败）',
      body: '自动恢复已连续失败 3 次',
      options: [
        { id: 'continue', label: '继续自动恢复', default: true },
        { id: 'block', label: '阻塞任务' },
        { id: 'cancel', label: '取消任务' },
      ],
      defaultOption: 'continue',
      timeoutMs: 120000,
      payload: { action: 'stage-event-ask', event: 'merge-conflict', taskId: task.id },
    },
    { by: 'host' },
  )
  check('the escalated event ask is a pending decision', requested.ok === true && requested.decision.status === 'pending', JSON.stringify(requested))
  const blocked = await rig.action('decisionAnswer', { decisionId: 'stage-ask-T-1-merge-conflict', option: 'block' })
  check('a human block on the escalation is executed', blocked.ok === true && blocked.applied.executed === true, JSON.stringify(blocked.applied))
  const row = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check('the escalation block puts the card in triage', row.status === 'blocked', String(row.status))
  check('the block reason is on the history', row.history.some((entry) => String(entry.note).indexOf('escalation decision') >= 0), JSON.stringify(row.history.map((entry) => entry.note)))
}


// ── T-197 review fix: retry-dev really requeues the card (state.apply shape) ─
{
  const stageClock = Date.parse('2026-11-19T14:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const git = createFakeGit()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents, git: git })
  const task = await createTask(rig, { title: 'retry-dev executes', writeFiles: [] })
  await rig.action('start')
  const running = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  const workerId = String(running.assignee.session)
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  tick += 26 * 60 * 1000
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const question = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'dev-timeout')[0] : undefined
  check('a dev timeout asks before retry-dev (setup)', question !== undefined, JSON.stringify(pending.pending.map((decision) => decision.eventKey)))
  const answered = await rig.action('decisionAnswer', { decisionId: question.id, option: 'retry-dev', confirm: 'DELETE' })
  const after = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check('retry-dev is executed', answered.ok === true && answered.applied !== null && answered.applied.executed === true && answered.applied.ok !== false, JSON.stringify(answered.applied))
  check('retry-dev puts the card back in the todo queue', after.status === 'pending' && after.assignee === null, JSON.stringify({ status: after.status, assignee: after.assignee }))
  check('retry-dev stops the old worker', taskAgents.live.has(workerId) === false, JSON.stringify(Array.from(taskAgents.live)))
  check('retry-dev removes the attempt worktree', git.calls.some((call) => call.name === 'worktreeRemove' && call.detail === running.worktree), JSON.stringify(git.calls.filter((call) => call.name === 'worktreeRemove')))
  check('retry-dev records the discard in history', after.history.some((entry) => String(entry.note).indexOf('retry development') >= 0), JSON.stringify(after.history.map((entry) => entry.note)))
}

// ── T-197 review fix: a failed worktree removal is reported, never claimed ──
{
  const stageClock = Date.parse('2026-11-19T15:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const git = createFakeGit()
  git.worktreeRemove = async () => ({ ok: false, code: 'worktree-remove-failed', message: 'fatal: cannot remove a locked worktree' })
  const rig = createRig({ now: () => tick, taskAgents: taskAgents, git: git })
  const task = await createTask(rig, { title: 'retry-dev removal fails', writeFiles: [] })
  await rig.action('start')
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  tick += 26 * 60 * 1000
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const question = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'dev-timeout')[0] : undefined
  const answered = await rig.action('decisionAnswer', { decisionId: question.id, option: 'retry-dev', confirm: 'DELETE' })
  const after = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  const message = String(answered.applied === null || answered.applied === undefined ? '' : answered.applied.message)
  check('retry-dev still requeues the card when removal failed', after.status === 'pending' && after.assignee === null, JSON.stringify({ status: after.status, assignee: after.assignee }))
  check('retry-dev reports the retry as executed', answered.ok === true && answered.applied.executed === true, JSON.stringify(answered.applied && answered.applied.executed))
  check('the decision text never claims the work was discarded', message.indexOf('uncommitted work was discarded') < 0, message)
  check('the decision text reports the un-removed worktree', message.indexOf('could not be removed') >= 0, message)
  check('the history records the failed worktree removal', after.history.some((entry) => String(entry.note).indexOf('could not be removed') >= 0), JSON.stringify(after.history.map((entry) => entry.note)))
}

// ── T-197 review fix: a verdict landing during replace is never overwritten ─
{
  const stageClock = Date.parse('2026-11-19T16:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'replace race' })
  await rig.action('start')
  await rig.action('submit', { id: task.id, evidence: 'ready' })
  const reviewing = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  const oldReviewer = String(reviewing.review.deliveredTo.id)
  const startsBefore = taskAgents.calls.filter((call) => call.kind === 'startReviewer').length
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  tick += 26 * 60 * 1000
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const question = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'review-timeout')[0] : undefined
  // Interleave: the old reviewer's verdict lands while the replacement is
  // releasing it — the exact window between the open-state read and the write.
  const realRelease = taskAgents.release
  let verdictLanded = false
  taskAgents.release = async function (agentId) {
    if (String(agentId) === oldReviewer && verdictLanded === false) {
      verdictLanded = true
      await updateBoard(
        { fs: rig.fs },
        {
          projectPath: PROJECT,
          mutate: (board) => {
            const live = board.tasks.filter((entry) => entry.id === task.id)[0]
            const at = new Date(tick).toISOString()
            live.status = 'testing'
            live.review = Object.assign({}, live.review, { status: 'approved', by: '@reviewer', byName: 'reviewer', at: at, reasons: null })
            live.test = { status: 'pending', by: null, byName: null, at: at, evidence: null, attempt: 1, deliveredTo: null }
            return board
          },
          sandboxPolicy: writePolicyFor(PROJECT),
        },
      )
    }
    return await realRelease.call(taskAgents, agentId)
  }
  const answered = await rig.action('decisionAnswer', { decisionId: question.id, option: 'replace' })
  const after = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check('the late verdict really lands in the race window (setup)', verdictLanded === true, JSON.stringify(answered.applied))
  check('replace refuses after the verdict landed (stage-closed)', answered.ok === true && answered.applied.executed === false && answered.applied.code === 'stage-closed', JSON.stringify(answered.applied))
  check('the approved review verdict survives the refused replace', after.review !== null && after.review.status === 'approved', JSON.stringify(after.review))
  check('the card keeps the testing phase the verdict set', after.status === 'testing', after.status)
  check('no new reviewer is started after the verdict', taskAgents.calls.filter((call) => call.kind === 'startReviewer').length === startsBefore, String(taskAgents.calls.filter((call) => call.kind === 'startReviewer').length))
  check('the testing card has no live reviewer', Array.from(taskAgents.live).filter((id) => String(id).indexOf('reviewer-') === 0).length === 0, JSON.stringify(Array.from(taskAgents.live)))
}


// ════════════════════════════════════════════════════════════════════════════
// T-198 — the decision POLICY (ask / notify / silent, global + project scope)
// ════════════════════════════════════════════════════════════════════════════

const PROBES = { probes: [{ id: 'suite', command: 'npm test' }] }

function agentContext(name) {
  return { projectPath: PROJECT, by: '@' + String(name === undefined ? 'agent' : name), role: 'agent', agent: null }
}

async function patchTaskRow(rig, id, mutate) {
  await updateBoard(
    { fs: rig.fs },
    {
      projectPath: PROJECT,
      mutate: (board) => {
        const row = board.tasks.filter((entry) => String(entry.id) === String(id))[0]
        if (row !== undefined) mutate(row)
        return board
      },
      sandboxPolicy: writePolicyFor(PROJECT),
    },
  )
}

// ── T-198: the catalog and the aligned defaults ─────────────────────────────
{
  const expected = [
    ['create', 'ask', 'create', 120, null],
    ['dispatch', 'ask', 'hold', 300, null],
    ['dev-timeout', 'ask', 'continue', 120, 3],
    ['review-timeout', 'ask', 'continue', 120, 3],
    ['test-timeout', 'ask', 'continue', 120, 3],
    ['reopen', 'ask', 'reopen', 120, null],
    ['delete', 'ask', 'keep', 120, null],
    ['cancel', 'ask', 'return', 120, null],
    // Event-10 rows have NO deadline while notify (packet §5 "—"); switching one
    // to ask falls back to the common 120s, which the escalation test asserts.
    ['host-verify-fail', 'notify', 'return-dev', null, null],
    ['merge-conflict', 'notify', 'return-dev', null, null],
    ['worker-lost', 'notify', 'redispatch', null, null],
    ['target-drift', 'notify', 'rebuild-retest', null, null],
    ['review-rounds-exhausted', 'notify', 'block', null, null],
  ]
  check(
    'T-198 the catalog lists the aligned 13 events in order',
    DECISION_EVENT_CATALOG.map((entry) => entry.key).join(',') === expected.map((entry) => entry[0]).join(','),
    DECISION_EVENT_CATALOG.map((entry) => entry.key).join(','),
  )
  const resolved = resolveDecisionPolicy({}, {})
  for (const entry of expected) {
    const [key, mode, defaultOption, timeoutSeconds, limit] = entry
    const row = resolved[key]
    check(
      'T-198 ' + key + ' defaults to ' + mode + '/' + defaultOption + '/' + String(timeoutSeconds) + 's/' + String(limit),
      row.mode === mode && row.defaultOption === defaultOption && row.timeoutSeconds === timeoutSeconds && row.limit === limit,
      JSON.stringify(row),
    )
  }
  check(
    'T-198 event-10 defaults keep the auto-recovery limit of 2 (review rounds: none)',
    resolved['host-verify-fail'].autoRecover === 2 &&
      resolved['merge-conflict'].autoRecover === 2 &&
      resolved['worker-lost'].autoRecover === 2 &&
      resolved['target-drift'].autoRecover === 2 &&
      resolved['review-rounds-exhausted'].autoRecover === null,
    JSON.stringify({
      hv: resolved['host-verify-fail'].autoRecover,
      rr: resolved['review-rounds-exhausted'].autoRecover,
    }),
  )
  check(
    'T-198 the fixed high-risk guards are on',
    DECISION_FIXED_GUARDS.deleteDependencyTreeRequiresWord === true && DECISION_FIXED_GUARDS.timeoutNeverDeletes === true,
  )
  const deleteMode = normaliseDecisionPolicyEvent('delete', { mode: 'notify', defaultOption: 'delete' })
  check('T-198 a destructive default option is refused', deleteMode.ok === false && deleteMode.code === 'invalid-policy-option', JSON.stringify(deleteMode))
  const forced = normaliseDecisionPolicyEvent('delete', { mode: 'notify' })
  check('T-198 the delete event can never leave ask', forced.ok === true && forced.patch.mode === 'ask', JSON.stringify(forced))
}

// ── T-198: persistence, scope fallback, reset, validation ──────────────────
{
  const rig = freshRig()
  const read0 = await rig.api.decisions.readPolicy(PROJECT)
  check(
    'T-198 an empty policy resolves to the built-in defaults',
    read0.ok === true && decisionPolicyView(read0).project['dev-timeout'].timeoutSeconds === 120 && decisionPolicyView(read0).storage.global === null,
    JSON.stringify(read0.ok ? read0.storage : read0),
  )

  const savedProject = await rig.action('decisionPolicy', { scope: 'project', events: { 'dev-timeout': { timeoutSeconds: 400 } } })
  const projectFile = JSON.parse(rig.fs.files.get(decisionPolicyPath(PROJECT)).text)
  check(
    'T-198 a project override persists as a sparse patch',
    savedProject.ok === true && savedProject.saved.location === 'project' && JSON.stringify(projectFile.events) === '{"dev-timeout":{"timeoutSeconds":400}}',
    JSON.stringify(savedProject.saved),
  )

  const savedGlobal = await rig.action('decisionPolicy', { scope: 'global', events: { 'worker-lost': { mode: 'silent' } } })
  check(
    'T-198 the global default persists beside the user-wide registry',
    savedGlobal.ok === true && savedGlobal.saved.location === 'home' && rig.fs.files.has(globalDecisionPolicyPath()) === true,
    JSON.stringify(savedGlobal.saved),
  )

  const view1 = decisionPolicyView(await rig.api.decisions.readPolicy(PROJECT))
  check(
    'T-198 the project fallback applies per FIELD, not per event',
    view1.project['dev-timeout'].timeoutSeconds === 400 &&
      view1.project['dev-timeout'].mode === 'ask' &&
      view1.project['worker-lost'].mode === 'silent' &&
      view1.project['worker-lost'].defaultOption === 'redispatch',
    JSON.stringify({ dev: view1.project['dev-timeout'], lost: view1.project['worker-lost'] }),
  )
  check(
    'T-198 the global scope shows the global values only',
    view1.global['dev-timeout'].timeoutSeconds === 120 && view1.global['worker-lost'].mode === 'silent',
    JSON.stringify(view1.global['dev-timeout']),
  )

  const restarted = createDecisionStore({ fs: rig.fs }, { now: now })
  const view2 = decisionPolicyView(await restarted.readPolicy(PROJECT))
  check(
    'T-198 the policy survives a host restart',
    view2.project['worker-lost'].mode === 'silent' && view2.project['dev-timeout'].timeoutSeconds === 400,
    JSON.stringify(view2.project['worker-lost']),
  )

  const reset = await rig.action('decisionPolicy', { scope: 'project', reset: ['dev-timeout'] })
  const read3 = await rig.api.decisions.readPolicy(PROJECT)
  const view3 = decisionPolicyView(read3)
  check(
    'T-198 reset clears only the current scope, which falls back to global/built-in',
    reset.ok === true && read3.project.events['dev-timeout'] === undefined && view3.project['dev-timeout'].timeoutSeconds === 120 && view3.project['worker-lost'].mode === 'silent',
    JSON.stringify(reset.saved),
  )

  const badScope = await rig.action('decisionPolicy', { scope: 'everyone', events: {} })
  check('T-198 an invalid scope is refused', badScope.ok === false && badScope.code === 'invalid-policy-scope', JSON.stringify(badScope))
  const badEvent = await rig.action('decisionPolicy', { scope: 'project', events: { nope: { mode: 'ask' } } })
  check('T-198 an unknown event is refused', badEvent.ok === false && badEvent.code === 'invalid-policy-event', JSON.stringify(badEvent))
  const badMode = await rig.action('decisionPolicy', { scope: 'project', events: { create: { mode: 'auto' } } })
  check('T-198 an invalid mode is refused', badMode.ok === false && badMode.code === 'invalid-policy-mode', JSON.stringify(badMode))
  const badTimeout = await rig.action('decisionPolicy', { scope: 'project', events: { create: { timeoutSeconds: 99999 } } })
  check('T-198 an out-of-bounds timeout is refused', badTimeout.ok === false && badTimeout.code === 'invalid-policy-timeout', JSON.stringify(badTimeout))
  const badLimit = await rig.action('decisionPolicy', { scope: 'project', events: { 'dev-timeout': { limit: 99 } } })
  check('T-198 an out-of-bounds limit is refused', badLimit.ok === false && badLimit.code === 'invalid-policy-limit', JSON.stringify(badLimit))
  const badRecover = await rig.action('decisionPolicy', { scope: 'project', events: { 'worker-lost': { autoRecover: -1 } } })
  check('T-198 an out-of-bounds auto-recovery limit is refused', badRecover.ok === false && badRecover.code === 'invalid-policy-auto-recover', JSON.stringify(badRecover))
  const destructiveDefault = await rig.action('decisionPolicy', { scope: 'project', events: { 'dev-timeout': { defaultOption: 'retry-dev' } } })
  check('T-198 a destructive stage default is refused', destructiveDefault.ok === false && destructiveDefault.code === 'invalid-policy-option', JSON.stringify(destructiveDefault))

  const agentTry = await rig.api.perform('decisionPolicy', { scope: 'project', events: { create: { mode: 'notify' } } }, agentContext('sneaky'))
  check('T-198 an Agent cannot change the decision policy', agentTry.ok === false && agentTry.code === 'user-only', JSON.stringify(agentTry))

  const deleteFixed = await rig.action('decisionPolicy', { scope: 'project', events: { delete: { mode: 'notify' } } })
  const view4 = decisionPolicyView(await rig.api.decisions.readPolicy(PROJECT))
  check(
    'T-198 the delete event cannot be automated by a stored setting',
    deleteFixed.ok === true && view4.project['delete'].mode === 'ask' && view4.overrides.project['delete'].mode === 'ask',
    JSON.stringify(view4.project['delete']),
  )

  const snapshot = await rig.api.snapshot(PROJECT, { full: false })
  check(
    'T-198 the panel snapshot carries the resolved policy and its overrides',
    snapshot.decisionPolicy !== null &&
      snapshot.decisionPolicy.project['delete'].mode === 'ask' &&
      snapshot.decisionPolicy.overrides.project['delete'].mode === 'ask' &&
      snapshot.decisionPolicy.defaults['create'].timeoutSeconds === 120,
    JSON.stringify(snapshot.decisionPolicy === null ? null : snapshot.decisionPolicy.overrides),
  )
}

// ── T-198: ask / notify / silent on the action gate ────────────────────────
{
  const rig = freshRig()
  await rig.action('decisionPolicy', { scope: 'project', events: { create: { mode: 'notify' } } })
  const created = await rig.api.perform('create', { title: 'auto card', verification: PROBES }, agentContext('auto'))
  const pendingAfterNotify = await rig.api.decisions.pending(PROJECT)
  check(
    'T-198 notify creates the card itself, with NO modal',
    created.ok === true && typeof created.task.id === 'string' && pendingAfterNotify.pending.length === 0,
    JSON.stringify({ ok: created.ok, pending: pendingAfterNotify.pending.length }),
  )

  await rig.action('decisionPolicy', { scope: 'project', events: { create: { defaultOption: 'cancel' } } })
  const before = (await rig.action('board')).tasks.length
  const declined = await rig.api.perform('create', { title: 'declined card', verification: PROBES }, agentContext('auto'))
  const after = (await rig.action('board')).tasks.length
  check(
    'T-198 a notify default of 取消创建 declines the action instead of creating',
    declined.ok === false && declined.code === 'policy-default' && declined.policy.option === 'cancel' && declined.policy.mode === 'notify',
    JSON.stringify(declined),
  )
  check('T-198 the declined create wrote nothing', after === before, String(after - before))

  await rig.action('decisionPolicy', { scope: 'project', events: { create: { mode: 'silent' } } })
  const silentDeclined = await rig.api.perform('create', { title: 'silent card', verification: PROBES }, agentContext('auto'))
  check(
    'T-198 silent applies the same default and names its mode',
    silentDeclined.ok === false && silentDeclined.code === 'policy-default' && silentDeclined.policy.mode === 'silent',
    JSON.stringify(silentDeclined),
  )

  await rig.action('decisionPolicy', { scope: 'project', reset: ['create'] })
  const asked = await rig.api.perform('create', { title: 'asked card', verification: PROBES }, agentContext('auto'))
  check(
    'T-198 the default ask still opens the decision',
    asked.ok === false && asked.code === 'needs-decision' && asked.decision.defaultOption === 'create' && asked.decision.remainingMs === 120000,
    JSON.stringify(asked.decision === undefined ? asked : asked.decision.defaultOption),
  )

  // The policy's default option and deadline replace the plan's own. The plan
  // defaults to 重新打开 (packet §3.6 is the ruling), so an override to 保持关闭
  // proves the policy — not the plan — decides the default.
  const task = await rig.action('create', { title: 'reopen me', verification: PROBES })
  await rig.action('cancel', { id: task.task.id })
  await rig.action('decisionPolicy', { scope: 'project', events: { reopen: { defaultOption: 'keep', timeoutSeconds: 30 } } })
  const reopenAsked = await rig.api.perform('reopen', { id: task.task.id }, agentContext('reopener'))
  check(
    'T-198 the configured default option and deadline drive the question',
    reopenAsked.ok === false && reopenAsked.decision.defaultOption === 'keep' && reopenAsked.decision.remainingMs === 30000,
    JSON.stringify(reopenAsked.decision === undefined ? reopenAsked : { option: reopenAsked.decision.defaultOption, remaining: reopenAsked.decision.remainingMs }),
  )
}

// ── T-198: a stage timeout in notify mode auto-continues without a modal ────
{
  const stageClock = Date.parse('2026-11-19T18:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents, ensureDir: function () {} })
  const task = await createTask(rig, { title: 'policy notify stage' })
  await rig.action('start')
  await rig.action('decisionPolicy', { scope: 'project', events: { 'dev-timeout': { mode: 'notify', limit: 2 } } })
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  tick += 26 * 60 * 1000
  await rig.settle()
  let pending = await rig.api.decisions.pending(PROJECT)
  let row = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check(
    'T-198 notify applies the timeout default without a modal',
    pending.ok === true && pending.pending.filter((decision) => decision.eventKey === 'dev-timeout').length === 0 && row.status === 'running',
    JSON.stringify({ pending: pending.pending.map((decision) => decision.eventKey), status: row.status }),
  )
  check(
    'T-198 the auto-continue is announced as a policy action in the history',
    row.history.some((entry) => String(entry.note).indexOf('按策略自动继续（notify）') >= 0),
    JSON.stringify(row.history.slice(-2).map((entry) => entry.note)),
  )
  const sends = taskAgents.calls.filter((call) => call.kind === 'send')
  check('T-198 notify tells the stage child the budget was extended', sends.length >= 1, JSON.stringify(sends.map((call) => call.text)))
  // The configured limit (2) blocks on the SECOND consecutive default-continue.
  tick += 26 * 60 * 1000
  await rig.settle()
  row = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check(
    'T-198 the configured consecutive limit blocks the card',
    row.status === 'blocked' && row.history.some((entry) => String(entry.note).indexOf('连续 2 次阶段超时默认继续') >= 0),
    JSON.stringify({ status: row.status, notes: row.history.map((entry) => entry.note).slice(-3) }),
  )
}

// ── T-198: silent writes the audit row and tells nobody ────────────────────
{
  const stageClock = Date.parse('2026-11-19T20:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents, ensureDir: function () {} })
  const task = await createTask(rig, { title: 'policy silent stage' })
  await rig.action('start')
  await rig.action('decisionPolicy', { scope: 'project', events: { 'dev-timeout': { mode: 'silent' } } })
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  tick += 26 * 60 * 1000
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const row = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check(
    'T-198 silent applies the default without a modal',
    pending.ok === true && pending.pending.length === 0 && row.status === 'running',
    JSON.stringify({ pending: pending.pending.map((decision) => decision.eventKey), status: row.status }),
  )
  check(
    'T-198 silent records the audit row and marks it',
    row.history.some((entry) => String(entry.note).indexOf('silent') >= 0 && String(entry.note).indexOf('按策略自动继续') >= 0),
    JSON.stringify(row.history.slice(-2).map((entry) => entry.note)),
  )
  check(
    'T-198 silent never messages the stage child',
    taskAgents.calls.filter((call) => call.kind === 'send').length === 0,
    JSON.stringify(taskAgents.calls.filter((call) => call.kind === 'send')),
  )
}

// ── T-198: ask with a 0-second timeout opens a question with no deadline ───
{
  const stageClock = Date.parse('2026-11-19T22:00:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents, ensureDir: function () {} })
  const task = await createTask(rig, { title: 'policy no deadline' })
  await rig.action('start')
  await rig.action('decisionPolicy', { scope: 'project', events: { 'dev-timeout': { timeoutSeconds: 0 } } })
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  tick += 26 * 60 * 1000
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const question = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'dev-timeout')[0] : undefined
  check(
    'T-198 answer-timeout 0 means "no deadline", never an instant default',
    question !== undefined && question.timeoutAt === null && question.remainingMs === null && question.defaultOption === 'continue',
    JSON.stringify(question === undefined ? null : { at: question.timeoutAt, remaining: question.remainingMs }),
  )
}

// ── T-198: event-10 ask asks at the first occurrence; silent only audits ────
{
  const lostClock = Date.parse('2026-11-19T23:00:00.000Z')
  let tick = lostClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents, ensureDir: function () {} })
  const task = await createTask(rig, { title: 'policy worker lost' })
  await rig.action('decisionPolicy', { scope: 'project', events: { 'worker-lost': { mode: 'ask' } } })
  await rig.action('start')
  await patchTaskRow(rig, task.id, (entry) => {
    entry.dispatch = Object.assign({}, entry.dispatch, { host: 'another-boot' })
  })
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const asked = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'worker-lost')[0] : undefined
  check(
    'T-198 an ask-mode event asks at the FIRST occurrence',
    asked !== undefined && asked.options.map((option) => option.id).join(',') === 'continue,block,cancel' && asked.defaultOption === 'continue',
    JSON.stringify(pending.ok ? pending.pending.map((decision) => decision.eventKey) : pending),
  )

}

// Silent: the same incident is audited on the card and never asks.
{
  const lostClock = Date.parse('2026-11-19T23:30:00.000Z')
  let tick = lostClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents, ensureDir: function () {} })
  const task2 = await createTask(rig, { title: 'policy worker lost silent' })
  await rig.action('decisionPolicy', { scope: 'project', events: { 'worker-lost': { mode: 'silent' } } })
  await rig.action('start')
  await patchTaskRow(rig, task2.id, (entry) => {
    entry.dispatch = Object.assign({}, entry.dispatch, { host: 'another-boot' })
  })
  await rig.settle()
  const pending2 = await rig.api.decisions.pending(PROJECT)
  const row2 = (await rig.action('board')).tasks.filter((entry) => entry.id === task2.id)[0]
  check(
    'T-198 a silent event never asks',
    pending2.ok === true && pending2.pending.filter((decision) => decision.eventKey === 'worker-lost' && decision.taskId === task2.id).length === 0,
    JSON.stringify(pending2.pending.map((decision) => decision.eventKey + ':' + String(decision.taskId))),
  )
  check(
    'T-198 a silent event still writes the audit row',
    row2.history.some((entry) => String(entry.note).indexOf('silent：仅审计') >= 0),
    JSON.stringify(row2.history.map((entry) => entry.note).slice(-3)),
  )
}

// ── T-198: the configured auto-recovery limit drives the escalation ─────────
{
  const lostClock = Date.parse('2026-11-19T23:45:00.000Z')
  const rig = createRig({ now: () => lostClock, taskAgents: createFakeTaskAgents(), ensureDir: function () {} })
  const task = await createTask(rig, { title: 'policy auto-recover limit' })
  // notify mode with a limit of 0: the FIRST failed auto-recovery already asks.
  await rig.action('decisionPolicy', { scope: 'project', events: { 'worker-lost': { mode: 'notify', autoRecover: 0 } } })
  await rig.action('start')
  await patchTaskRow(rig, task.id, (entry) => {
    entry.dispatch = Object.assign({}, entry.dispatch, { host: 'another-boot' })
  })
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const escalated = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'worker-lost')[0] : undefined
  check(
    'T-198 a configured auto-recovery limit of 0 escalates at the first incident',
    escalated !== undefined && escalated.defaultOption === 'continue',
    JSON.stringify(pending.ok ? pending.pending.map((decision) => decision.eventKey) : pending),
  )
}

// ── T-198: a deadline never applies a destructive default ──────────────────
{
  const rig = freshRig()
  await rig.api.decisions.request(
    PROJECT,
    {
      id: 'DEC-DEL',
      eventKey: 'delete',
      title: '删除 T-1？',
      timeoutMs: 1000,
      options: [
        { id: 'keep', label: '保留', default: true },
        { id: 'delete', label: '删除', auto: false },
      ],
      defaultOption: 'delete',
    },
    { by: 'host' },
  )
  clockNow = START + 5000
  const swept = await rig.api.decisions.sweep(PROJECT)
  check(
    'T-198 a timeout never applies a destructive default (fixed guard)',
    swept.ok === true &&
      swept.expired.length === 1 &&
      swept.expired[0].resolution === null &&
      swept.expired[0].outcome === 'requires-manual' &&
      swept.expired[0].options.filter((option) => option.id === 'delete')[0].auto === false,
    JSON.stringify(swept.expired),
  )
  const listed = await rig.action('decisionList', { decisionStatus: 'all' })
  const stored = listed.decisions.filter((decision) => decision.id === 'DEC-DEL')[0]
  check(
    'T-198 the panel is told the default is not auto-runnable',
    stored !== undefined && stored.autoRunAllowed === false,
    JSON.stringify(stored === undefined ? null : stored.autoRunAllowed),
  )
}


// ── T-198: an ASK timeout that EXPIRES obeys the configured limit ──────────
// The question body shows 连续超时 0/5; the automatic default that applies when
// it expires must use THAT limit, not the hardcoded 3.
{
  const stageClock = Date.parse('2026-11-20T00:30:00.000Z')
  let tick = stageClock
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ now: () => tick, taskAgents: taskAgents, ensureDir: function () {} })
  const task = await createTask(rig, { title: 'policy ask expiry limit' })
  await rig.action('start')
  await rig.action('decisionPolicy', { scope: 'project', events: { 'dev-timeout': { mode: 'ask', timeoutSeconds: 120, limit: 5 } } })
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  let firstQuestion = null
  for (let round = 0; round < 5; round += 1) {
    tick += 26 * 60 * 1000
    await rig.settle()
    if (firstQuestion === null) {
      const pending = await rig.api.decisions.pending(PROJECT)
      firstQuestion = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'dev-timeout')[0] : undefined
    }
    tick += 121 * 1000
    await rig.settle()
  }
  const row = (await rig.action('board')).tasks.filter((entry) => entry.id === task.id)[0]
  check(
    'T-198 the ask question body shows the configured limit',
    firstQuestion !== undefined && firstQuestion.body.indexOf('连续超时：0/5') >= 0,
    JSON.stringify(firstQuestion === undefined ? null : firstQuestion.body),
  )
  check(
    'T-198 five ask-mode expiries block the card at the configured limit',
    row.status === 'blocked',
    row.status,
  )
  check(
    'T-198 the expired default records the configured limit, not the built-in 3',
    row.history.some((entry) => String(entry.note).indexOf('连续默认继续 4/5') >= 0) &&
      row.history.some((entry) => String(entry.note).indexOf('连续 5 次阶段超时默认继续，已自动阻塞') >= 0) &&
      !row.history.some((entry) => String(entry.note).indexOf('连续 3 次阶段超时默认继续，已自动阻塞') >= 0),
    JSON.stringify(row.history.map((entry) => entry.note).slice(-8)),
  )
}

// ── T-198: a denied home write falls back to the workspace global policy ────
{
  const rig = freshRig()
  const realWrite = rig.fs.writeText.bind(rig.fs)
  rig.fs.writeText = async function (target, content, expected) {
    // The real facade denies ~/.dsh under a workspace-write policy; model that.
    if (/[\\/]\.dsh[\\/]/.test(String(target.targetKey))) {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
    return await realWrite(target, content, expected)
  }
  const saved = await rig.action('decisionPolicy', { scope: 'global', events: { create: { mode: 'silent' } } })
  const read = await rig.api.decisions.readPolicy(PROJECT)
  const view = decisionPolicyView(read)
  check(
    'T-198 a denied home write persists the global default in the workspace fallback',
    saved.ok === true && saved.saved.location === 'workspace' && rig.fs.files.has(workspaceGlobalDecisionPolicyPath(PROJECT)) === true,
    JSON.stringify(saved.saved),
  )
  check(
    'T-198 the workspace fallback is read back as the global default',
    view.global['create'].mode === 'silent' && view.storage.global === 'workspace' && view.project['create'].mode === 'silent',
    JSON.stringify({ global: view.global['create'], storage: view.storage }),
  )
}

// ── T-198: an event-10 ask with timeout 0 has NO deadline ───────────────────
{
  const lostClock = Date.parse('2026-11-20T01:00:00.000Z')
  const rig = createRig({ now: () => lostClock, taskAgents: createFakeTaskAgents(), ensureDir: function () {} })
  const task = await createTask(rig, { title: 'policy event ask no deadline' })
  await rig.action('decisionPolicy', { scope: 'project', events: { 'worker-lost': { mode: 'ask', timeoutSeconds: 0 } } })
  await rig.action('start')
  await patchTaskRow(rig, task.id, (entry) => {
    entry.dispatch = Object.assign({}, entry.dispatch, { host: 'another-boot' })
  })
  await rig.settle()
  const pending = await rig.api.decisions.pending(PROJECT)
  const asked = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === 'worker-lost')[0] : undefined
  check(
    'T-198 an event-10 ask with timeout 0 has no deadline (same 0 semantics)',
    asked !== undefined && asked.timeoutAt === null && asked.remainingMs === null && asked.defaultOption === 'continue',
    JSON.stringify(asked === undefined ? null : { at: asked.timeoutAt, remaining: asked.remainingMs, option: asked.defaultOption }),
  )
  // An event-10 ask with NO configured timeout keeps the built-in 120s fallback.
  const rig2 = createRig({ now: () => lostClock, taskAgents: createFakeTaskAgents(), ensureDir: function () {} })
  const task2 = await createTask(rig2, { title: 'policy event ask fallback' })
  await rig2.action('decisionPolicy', { scope: 'project', events: { 'merge-conflict': { mode: 'ask' } } })
  const fallbackView = decisionPolicyView(await rig2.api.decisions.readPolicy(PROJECT))
  check(
    'T-198 an unset event-10 deadline resolves to null (ask falls back to 120s)',
    fallbackView.project['merge-conflict'].timeoutSeconds === null && fallbackView.defaults['merge-conflict'].timeoutSeconds === null,
    JSON.stringify(fallbackView.project['merge-conflict']),
  )
}

console.log(failures === 0 ? '\nPASS  decision requests persist, answer once, and honour the timeout and policy rules' : '\nFAIL  ' + String(failures) + ' decision check(s)')
process.exit(failures === 0 ? 0 : 1)
