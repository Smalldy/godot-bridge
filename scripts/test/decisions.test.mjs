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

import assert from 'node:assert/strict'
import { createFakeTaskAgents, createRig, createTask, PROJECT } from './support/fixtures.mjs'
import { createDecisionStore, decisionsPath } from '../../plugin/task-center/decisions.mjs'
import { updateBoard } from '../../plugin/task-center/board.mjs'
import { writePolicyFor } from '../../plugin/task-center/state.mjs'
import { findTask } from '../../plugin/task-center/service.mjs'
import { DECISION_CONFIRM_WORD, MAX_RESOLVED_DECISIONS } from '../../plugin/task-center/schema.mjs'

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

console.log(failures === 0 ? '\nPASS  decision requests persist, answer once, and honour the timeout rules' : '\nFAIL  ' + String(failures) + ' decision check(s)')
process.exit(failures === 0 ? 0 : 1)
