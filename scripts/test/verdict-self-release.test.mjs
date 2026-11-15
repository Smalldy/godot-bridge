// T-185 regression: a verdict action must never dispose the reviewer/tester
// that called it.
//
// The verdict runs inside its caller's own turn. Disposing that activation
// before the tool result is delivered froze T-181's reviewer at
// tool/ptc-dispatch-start forever. These checks drive all four verdict paths
// through the real API + stage service + task-agent runtime and prove:
//
//   - the caller is NOT disposed while the action is still running;
//   - the action returns a normal result (the board semantics are unchanged);
//   - the caller stays running after the result until its turn ends;
//   - the reconciler then retires it, so no running zombie is left.

import assert from 'node:assert/strict'
import { createRig, createTask, PROJECT } from './support/fixtures.mjs'
import { createAgentRuntime } from '../../plugin/task-center/agent-runtime.mjs'
import {
  createTaskAgents,
  deferredReleaseIds,
  forgetDeferredRelease,
  reapDeferredReleases,
} from '../../plugin/task-center/task-agents.mjs'

const checks = []
async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error })
  }
}

const ROOT = { id: 'session-lead', name: 'lead' }
// The fake subagent service keeps the live tree and each child's turn state, so
// the test can say exactly when the caller's turn has ended.
const state = { seq: 0, live: new Map(), activity: new Map(), disposed: [], interrupted: [] }
const subagents = {
  async startActivation(spec) {
    state.seq += 1
    const id = 'agent-' + String(state.seq)
    state.live.set(id, spec.name)
    state.activity.set(id, 'running')
    return {
      childId: id,
      name: spec.name,
      result: Promise.resolve({ output: [] }),
      dispose: async () => {
        state.disposed.push(id)
        state.live.delete(id)
      },
    }
  },
  async sendMessage() {
    return 'message'
  },
  interrupt(id) {
    state.interrupted.push(String(id))
  },
  async listDescendants() {
    return Array.from(state.live.entries()).map(([id, name]) => ({
      kind: 'child',
      id,
      name,
      parentId: ROOT.id,
      depth: 1,
      activity: state.activity.get(id) === 'running' ? 'running' : 'inactive',
      mode: 'continuable',
    }))
  },
  rootOf() {
    return ROOT
  },
  namesOf() {
    return { self: 'lead' }
  },
}

const runtime = createAgentRuntime({ agent: ROOT, get: (name) => (name === 'subagents' ? subagents : undefined) })
const agents = createTaskAgents({ runtime })
const taskAgents = {
  available: true,
  root: ROOT,
  rootId: ROOT.id,
  runtime,
  startWorker(task, prompt, extra) { return agents.startWorker(task, prompt, extra) },
  startReviewer(task, prompt, extra) { return agents.startReviewer(task, prompt, extra) },
  startTester(task, prompt, extra) { return agents.startTester(task, prompt, extra) },
  send(agentId, text, options) { return agents.send(agentId, text, options) },
  release(agentId, options) { return agents.release(agentId, options) },
  releaseTask(task, options) { return agents.releaseTask(task, options) },
  taskAgentsFor() { return agents },
  listFor() { return runtime.list() },
}
// The candidate workflow is active (roles + merger), so approveReview really
// builds a candidate and starts a tester — the paths that used to self-release.
const merger = {
  async createCandidate(task, projectPath) {
    return {
      ok: true,
      path: projectPath + '\\.worktrees\\candidate-' + String(task.id),
      base: 'base-sha',
      head: 'candidate-' + String(task.id),
      target: 'main',
    }
  },
  async mergeCandidate(task) {
    return { ok: true, status: 'merged', mergeCommit: 'merged-' + String(task.id), candidateRemoved: false, taskWorktreeRemoved: false }
  },
  async discardCandidate() {
    return { ok: true }
  },
}
const rig = createRig({ taskAgents, roles: {}, merger, allowSpawn: true })
let dispatchStarted = false

function callerContext(agentId, name) {
  return { projectPath: PROJECT, by: '@' + String(name), role: 'agent', agent: { id: agentId, name: name } }
}

function taskById(id) {
  return rig.state.read(PROJECT).then((read) => read.board.tasks.filter((task) => task.id === id)[0])
}

async function makeCard(title) {
  const created = await createTask(rig, { title: title, writeFiles: [] })
  if (dispatchStarted !== true) {
    const started = await rig.action('start', {})
    assert.equal(started.ok, true, 'start: ' + JSON.stringify(started).slice(0, 500))
    dispatchStarted = true
  }
  await rig.settle()
  const card = await taskById(created.id)
  assert.ok(card !== undefined, 'card exists')
  assert.equal(card.status, 'running', 'the card is dispatched: ' + JSON.stringify(card.status))
  assert.equal(typeof card.assignee.session, 'string')
  return card
}

async function submitCard(card) {
  const submitted = await rig.action('submit', { id: card.id, evidence: 'implemented' })
  assert.equal(submitted.ok, true, 'submit: ' + JSON.stringify(submitted).slice(0, 700))
  const reading = await taskById(card.id)
  assert.equal(reading.status, 'reviewing')
  assert.equal(typeof reading.review.deliveredTo.id, 'string', 'the reviewer delivery is recorded by id')
  return reading
}

/** Assert the caller survived the action, is queued, and is retired after its turn. */
async function assertDeferredThenRetired(callerId, label) {
  assert.equal(
    state.disposed.indexOf(callerId),
    -1,
    label + ' disposed its own caller before the tool result could be delivered',
  )
  assert.equal(state.live.has(callerId), true, label + ' killed its caller')
  assert.equal(state.activity.get(callerId), 'running', label + ' ended the caller turn itself')
  assert.ok(deferredReleaseIds().indexOf(callerId) >= 0, label + ' did not queue the self-release')
  // Still running: the reconciler must wait, never dispose an active activation.
  await reapDeferredReleases()
  assert.equal(state.live.has(callerId), true, label + ' disposed an in-flight caller')
  assert.equal(state.disposed.indexOf(callerId), -1)
  // The tool result was delivered; the caller finishes its turn.
  state.activity.set(callerId, 'inactive')
  await reapDeferredReleases()
  assert.equal(state.live.has(callerId), false, label + ' left a running zombie')
  assert.ok(state.disposed.indexOf(callerId) >= 0, label + ' never disposed the finished caller')
  assert.equal(deferredReleaseIds().indexOf(callerId), -1)
}

// ── approveReview (reviewer is the caller) → passTest (tester is the caller) ─
const passCard = {}
await check('approveReview returns to its reviewer before the reconciler retires it', async () => {
  const card = await makeCard('approve me')
  const reading = await submitCard(card)
  const reviewerId = reading.review.deliveredTo.id
  state.activity.set(reviewerId, 'running')
  const verdict = await rig.api.perform('approveReview', { id: card.id }, callerContext(reviewerId, reading.review.deliveredTo.name))
  assert.equal(verdict.ok, true, 'approveReview: ' + JSON.stringify(verdict).slice(0, 900))
  assert.equal(verdict.task.status, 'testing', 'the board still moves to testing')
  const after = await taskById(card.id)
  assert.equal(after.status, 'testing')
  assert.equal(typeof after.test.deliveredTo.id, 'string', 'the tester delivery is unchanged')
  passCard.id = card.id
  passCard.testerId = after.test.deliveredTo.id
  await assertDeferredThenRetired(reviewerId, 'approveReview')
})

await check('passTest returns to its tester before the reconciler retires it', async () => {
  const testerId = passCard.testerId
  state.activity.set(testerId, 'running')
  const verdict = await rig.api.perform('passTest', { id: passCard.id, evidence: 'checks pass' }, callerContext(testerId, 'tester-1'))
  assert.equal(verdict.ok, true, 'passTest: ' + JSON.stringify(verdict).slice(0, 900))
  const after = await taskById(passCard.id)
  assert.equal(after.test.status, 'passed', 'the tester verdict is still recorded')
  assert.equal(after.merge.status, 'merged', 'the accepted candidate is still merged')
  await assertDeferredThenRetired(testerId, 'passTest')
})

// ── requestChanges (reviewer is the caller) ─────────────────────────────────
await check('requestChanges returns to its reviewer before the reconciler retires it', async () => {
  const card = await makeCard('change me')
  const reading = await submitCard(card)
  const reviewerId = reading.review.deliveredTo.id
  state.activity.set(reviewerId, 'running')
  const verdict = await rig.api.perform(
    'requestChanges',
    { id: card.id, reasons: 'rename the helper in scripts/a.gd:12' },
    callerContext(reviewerId, reading.review.deliveredTo.name),
  )
  assert.equal(verdict.ok, true, 'requestChanges: ' + JSON.stringify(verdict).slice(0, 900))
  assert.equal(verdict.task.status, 'running', 'the board still returns to running')
  const after = await taskById(card.id)
  assert.equal(after.review.status, 'changes-requested', 'the changes request is still recorded')
  await assertDeferredThenRetired(reviewerId, 'requestChanges')
  // Free the dispatch slot for the next card.
  await rig.action('block', { id: card.id, note: 'test cleanup' })
})

// ── failTest (tester is the caller) ─────────────────────────────────────────
await check('failTest returns to its tester before the reconciler retires it', async () => {
  const card = await makeCard('fail me')
  await submitCard(card)
  const approved = await rig.action('approveReview', { id: card.id })
  assert.equal(approved.ok, true, 'approveReview as user: ' + JSON.stringify(approved).slice(0, 700))
  const testing = await taskById(card.id)
  assert.equal(testing.status, 'testing')
  const testerId = testing.test.deliveredTo.id
  state.activity.set(testerId, 'running')
  const verdict = await rig.api.perform('failTest', { id: card.id, evidence: 'FAIL  npm test' }, callerContext(testerId, 'tester-2'))
  assert.equal(verdict.ok, true, 'failTest: ' + JSON.stringify(verdict).slice(0, 900))
  assert.equal(verdict.task.status, 'running', 'the board still returns to running')
  const after = await taskById(card.id)
  assert.equal(after.test.status, 'failed', 'the failed test is still recorded')
  await assertDeferredThenRetired(testerId, 'failTest')
  await rig.action('block', { id: card.id, note: 'test cleanup' })
})

// ── nothing is left running ─────────────────────────────────────────────────
await check('no reviewer/tester is left running after the stage ended', async () => {
  for (const id of deferredReleaseIds()) forgetDeferredRelease(id)
  const reviewers = Array.from(state.live.entries()).filter(([, name]) => /^reviewer-/.test(String(name)))
  const testers = Array.from(state.live.entries()).filter(([, name]) => /^tester-/.test(String(name)))
  assert.deepEqual(reviewers, [], 'a finished reviewer is still running: ' + JSON.stringify(reviewers))
  assert.deepEqual(testers, [], 'a finished tester is still running: ' + JSON.stringify(testers))
})

const failed = checks.filter((row) => !row.ok)
for (const row of checks) {
  console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
}
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
rig.scheduler.dispose()
process.exit(failed.length === 0 ? 0 : 1)
