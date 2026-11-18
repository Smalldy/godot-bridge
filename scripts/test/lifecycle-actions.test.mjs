import assert from 'node:assert/strict'
import { createLifecycleActions } from '../../plugin/task-center/actions/lifecycle.mjs'
import { createRig, createFakeTaskAgents } from './support/fixtures.mjs'

const task = { id: 'T-1', status: 'running', kind: 'dev' }
const board = { tasks: [task] }
const state = { memory: { locks: [] } }
const events = { released: [], cleaned: [] }
const model = {
  findTask: (source, id) => source.tasks.filter((candidate) => candidate.id === id)[0],
  cancelTask: () => ({ ok: true, board: board, task: task, events: ['cancel'] }),
  reopenTask: () => ({ ok: true, board: board, task: task, events: ['reopen'] }),
  unblockTask: () => ({ ok: true, board: board, task: task, events: ['unblock'] }),
  retryTask: () => ({ ok: true, board: board, task: task, events: ['retry'] }),
  blockTask: () => ({ ok: true, board: board, task: task, events: ['block'] }),
}
const actions = createLifecycleActions({
  readBoardOrFail: async () => ({ board: board }),
  model: model,
  writeTask: async (project, id, mutator) => mutator(board),
  clock: () => 1000,
  writeByName: () => 'user',
  state: state,
  ctx: {},
  stageAgents: {
    async releaseTask(prior, options) {
      events.released.push({ id: prior.id, roles: options.roles })
      return { ok: true, released: [] }
    },
  },
  cleanupInvestigation: async (project, prior) => {
    events.cleaned.push(prior.id)
  },
  failure: (code, message) => ({ ok: false, code: code, message: message }),
})

const cancelled = await actions.cancel({ id: 'T-1' }, { by: 'user' }, '/project')
assert.equal(cancelled.ok, true)
assert.deepEqual(events.released[0], { id: 'T-1', roles: ['worker', 'reviewer', 'tester'] })
assert.deepEqual(events.cleaned, ['T-1'])

assert.equal((await actions.reopen({ id: 'T-1' }, { by: 'user' }, '/project')).ok, true)
assert.equal((await actions.unblock({ id: 'T-1' }, { by: 'user' }, '/project')).ok, true)
assert.equal((await actions.retry({ id: 'T-1' }, { by: 'user' }, '/project')).ok, true)
assert.equal((await actions.block({ id: 'T-1' }, { by: 'user' }, '/project')).ok, true)
assert.equal((await actions.cancel({}, { by: 'user' }, '/project')).code, 'missing-id')
assert.equal((await actions.reopen({}, { by: 'user' }, '/project')).code, 'missing-id')

// ── T-196: reopen/cancel/delete ask first and the answer executes them ─────
//
// The lifecycle handlers themselves stay unchanged; the API's decision gate is
// what turns an Agent's call into a pending question, and the panel's answer is
// what performs the transition. This proves the whole path (not just routing).
{
  const agents = createFakeTaskAgents()
  const rig = createRig({ taskAgents: agents })
  const asAgent = { projectPath: rig.project, by: '@worker-x', role: 'agent', agent: { id: 'session-worker-x', name: 'worker-x' } }
  const created = await rig.action('create', { title: 'Lifecycle card', verification: { probes: [{ id: 'suite', command: 'npm test' }] } })
  assert.equal(created.ok, true)
  const id = created.task.id

  // An impossible reopen (the card is still pending) refuses BEFORE asking.
  const impossible = await rig.api.perform('reopen', { id: id }, asAgent)
  assert.equal(impossible.code, 'not-closed')
  assert.equal(impossible.decision, undefined)

  // Cancel asks; the answer stops the card.
  const cancelAsked = await rig.api.perform('cancel', { id: id }, asAgent)
  assert.equal(cancelAsked.code, 'needs-decision')
  assert.equal(cancelAsked.decision.eventKey, 'cancel')
  assert.equal((await rig.action('get', { id: id })).task.status, 'pending')
  const confirmed = await rig.action('decisionAnswer', { decisionId: cancelAsked.decision.id, option: 'confirm' })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.applied.summary.status, 'cancelled')
  assert.equal((await rig.action('get', { id: id })).task.status, 'cancelled')

  // Reopen asks; the answer restores the todo card with no review/test left.
  const reopenAsked = await rig.api.perform('reopen', { id: id }, asAgent)
  assert.equal(reopenAsked.code, 'needs-decision')
  assert.equal(reopenAsked.decision.eventKey, 'reopen')
  const reopened = await rig.action('decisionAnswer', { decisionId: reopenAsked.decision.id, option: 'reopen' })
  assert.equal(reopened.applied.summary.status, 'pending')
  const open = await rig.action('get', { id: id })
  assert.equal(open.task.status, 'pending')
  assert.equal(open.task.review, null)
  assert.equal(open.task.test, null)

  // Delete asks; 保留 executes nothing, then 删除 removes the card.
  const deleteAsked = await rig.api.perform('delete', { id: id }, asAgent)
  assert.equal(deleteAsked.code, 'needs-decision')
  assert.equal(deleteAsked.decision.eventKey, 'delete')
  const kept = await rig.action('decisionAnswer', { decisionId: deleteAsked.decision.id, option: 'keep' })
  assert.equal(kept.applied.executed, false)
  assert.equal((await rig.action('get', { id: id })).ok, true)
  const deleteAgain = await rig.api.perform('delete', { id: id }, asAgent)
  const deleted = await rig.action('decisionAnswer', { decisionId: deleteAgain.decision.id, option: 'delete' })
  assert.equal(deleted.applied.executed, true)
  assert.equal((await rig.action('get', { id: id })).code, 'unknown-task')

  // Every outcome was delivered to the asking Session.
  const sent = agents.calls.filter((call) => call.kind === 'send')
  assert.ok(sent.length >= 3)
  assert.ok(sent.some((call) => call.text.indexOf('is cancelled') >= 0))
  assert.ok(sent.some((call) => call.text.indexOf('back in the todo queue') >= 0))
  assert.ok(sent.some((call) => call.text.indexOf('was removed from the board') >= 0))
  console.log('PASS  the decision answers execute reopen/cancel/delete and message the Agent')
}

console.log('PASS  lifecycle actions preserve cancel/block cleanup and transition routing')
