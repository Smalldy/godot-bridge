// T-195 — durable DecisionRequests.
//
// Covers the acceptance surface: persistence across a "restart" (a second store
// over the same filesystem), CAS/idempotent creation, one-shot answers, timeout
// defaults that never overwrite an answer, destructive defaults that never
// auto-run, resolved-record trimming, and the decisionList/decisionAnswer
// actions routed through the ordinary action API and the panel snapshot.

import assert from 'node:assert/strict'
import { createRig, PROJECT } from './support/fixtures.mjs'
import { createDecisionStore, decisionsPath } from '../../plugin/task-center/decisions.mjs'
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

console.log(failures === 0 ? '\nPASS  decision requests persist, answer once, and honour the timeout rules' : '\nFAIL  ' + String(failures) + ' decision check(s)')
process.exit(failures === 0 ? 0 : 1)
