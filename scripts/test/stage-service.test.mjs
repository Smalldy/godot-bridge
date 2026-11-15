import assert from 'node:assert/strict'
import { createStageService } from '../../plugin/task-center/stage-service.mjs'
import { createTaskAgents } from '../../plugin/task-center/task-agents.mjs'
import { createAgentRuntime } from '../../plugin/task-center/agent-runtime.mjs'
import { createLifecycleActions } from '../../plugin/task-center/actions/lifecycle.mjs'

const checks = []
async function check(name, fn) { try { await fn(); checks.push({ name, ok: true }) } catch (error) { checks.push({ name, ok: false, error }) } }

const calls = []
const taskAgents = {
  async startReviewer(task, brief) { calls.push({ kind: 'reviewer', id: task.id, brief }); return { agentId: 'r-1', name: 'reviewer-t-1-g1', handle: {} } },
  async startTester(task, brief) { calls.push({ kind: 'tester', id: task.id, brief }); return { agentId: 't-1', name: 'tester-t-1-g1', handle: {} } },
  async send(id, text) { calls.push({ kind: 'send', id, text }); return 'm-1' },
  async release(id) { calls.push({ kind: 'release', id }); return id === 'r-1' || id === 'r-2' },
  taskAgentsFor(rootId) {
    calls.push({ kind: 'root', rootId })
    if (rootId === 'missing-root') return null
    return {
      async releaseTask(task, options) {
        calls.push({ kind: 'release-task', id: task.id, roles: options.roles, reason: options.reason, callerAgentId: options.callerAgentId })
        return { ok: true, taskId: task.id, roles: options.roles, released: [{ agentId: 'r-1', role: 'reviewer', sources: ['record'] }], interrupted: [], unresolved: [], failed: [], deferred: [] }
      },
    }
  },
}
const service = createStageService({ taskAgents })
const reviewer = await service.startReviewer({ id: 'T-1' }, 'review brief')
const tester = await service.startTester({ id: 'T-1' }, 'test brief')
const sent = await service.sendAssignee({ id: 'T-1', assignee: { session: 'w-1' } }, 'fix this')

await check('stage delivery keeps the reviewer/tester/send semantics', () => {
  assert.equal(service.available, true)
  assert.equal(reviewer.ok, true)
  assert.equal(reviewer.agentId, 'r-1')
  assert.equal(reviewer.name, 'reviewer-t-1-g1')
  assert.equal(reviewer.created[0].id, 'r-1')
  assert.equal(tester.agentId, 't-1')
  assert.equal(sent.ok, true)
  assert.deepEqual(calls.filter((entry) => ['reviewer', 'tester', 'send'].indexOf(entry.kind) >= 0).map((entry) => entry.kind), ['reviewer', 'tester', 'send'])
  assert.equal(calls[2].id, 'w-1')
  assert.equal(calls[2].text, 'fix this')
})

await check('release falls through to the handle/registry when the facade cannot dispose', async () => {
  assert.equal(await service.release('r-1'), true)
  assert.equal(await service.release('not-a-child'), false)
  assert.equal(await service.release(''), false)
})

await check('releaseTask runs through the card root and passes role/reason', async () => {
  const result = await service.releaseTask({ id: 'T-1', ownerSession: 'root' }, { roles: ['worker', 'reviewer', 'tester'], reason: 'blocked' })
  assert.equal(result.ok, true)
  const call = calls.filter((entry) => entry.kind === 'release-task').slice(-1)[0]
  assert.deepEqual(call.roles, ['worker', 'reviewer', 'tester'])
  assert.equal(call.reason, 'blocked')
})

await check('releaseTask falls back to the ids the board recorded', async () => {
  const result = await service.releaseTask({
    id: 'T-2',
    ownerSession: 'missing-root',
    assignee: { session: 'w-2' },
    review: { deliveredTo: { id: 'r-2' } },
    test: { deliveredTo: { id: 't-2' } },
  })
  assert.equal(result.taskId, 'T-2')
  // The fallback releases through the facade release path, which this fake only
  // accepts for r-2; the other two are reported unresolved instead of assumed.
  assert.deepEqual(result.released.map((entry) => entry.agentId), ['r-2'])
  assert.deepEqual(result.unresolved.map((entry) => entry.agentId).sort(), ['t-2', 'w-2'])
})

await check('a plugin-reload release recovers the activation receipt by id', async () => {
  const root = { id: 'root', name: 'lead' }
  const disposed = []
  const subagents = {
    async startActivation(spec) {
      return { childId: 'child-reload', name: spec.name, result: Promise.resolve({ output: [] }), dispose: async () => { disposed.push('child-reload') } }
    },
    async sendMessage() { return 'm' },
    interrupt() {},
    async listDescendants() { return [] },
    rootOf() { return root },
    namesOf() { return { self: 'lead' } },
  }
  const runtime = createAgentRuntime({ agent: root, get(name) { return name === 'subagents' ? subagents : undefined } })
  const agents = createTaskAgents({ runtime })
  const spawned = await agents.startWorker({ id: 'T-9' }, 'implement')
  const reloaded = createStageService({
    taskAgents: {
      available: true,
      async release() { return false },
      async taskAgentsFor() { return null },
      async startReviewer() { throw new Error('unused') },
      async startTester() { throw new Error('unused') },
      async send() { return 'm' },
    },
  })
  assert.equal(await reloaded.release(spawned.agentId), true)
  assert.deepEqual(disposed, ['child-reload'])
})

// ── T-185: a verdict's caller is passed through and never self-released ──────
await check('releaseTask forwards the caller id so a stage can never self-release', async () => {
  const result = await service.releaseTask(
    { id: 'T-3', ownerSession: 'root', review: { deliveredTo: { id: 'r-3' } } },
    { roles: ['reviewer'], callerAgentId: 'r-3', reason: 'review verdict' },
  )
  const call = calls.filter((entry) => entry.kind === 'release-task').slice(-1)[0]
  assert.equal(call.callerAgentId, 'r-3')
  assert.equal(call.reason, 'review verdict')
  assert.deepEqual(result.deferred, [])
})

await check('release never disposes its own caller', async () => {
  const before = calls.filter((entry) => entry.kind === 'release').length
  assert.equal(await service.release('r-1', { callerAgentId: 'r-1' }), false)
  assert.equal(calls.filter((entry) => entry.kind === 'release').length, before)
  assert.equal(await service.release('r-1'), true, 'a non-caller release still goes through')
})

await check('the recorded-id fallback queues the caller instead of disposing it', async () => {
  const before = calls.filter((entry) => entry.kind === 'release').length
  const result = await service.releaseTask(
    { id: 'T-4', ownerSession: 'missing-root', review: { deliveredTo: { id: 'r-4' } } },
    { roles: ['reviewer'], callerAgentId: 'r-4' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.released.length, 0)
  assert.deepEqual(result.deferred.map((entry) => entry.agentId), ['r-4'])
  assert.equal(result.deferred[0].queued, false, 'no receipt in this process means no disposal capability')
  assert.equal(calls.filter((entry) => entry.kind === 'release').length, before)
})

await check('the stage service exposes the arming point and the deferred-release reconciler', async () => {
  const report = await service.drainDeferredReleases()
  assert.ok(Array.isArray(report))
  assert.equal(service.markCallerReturned('no-entry'), false, 'arming an unknown caller is a no-op')
})

const missing = createStageService({})
await check('without a task-agent runtime the service refuses readably', async () => {
  assert.equal(missing.available, false)
  assert.equal((await missing.startTester({ id: 'T' }, 'x')).code, 'agent-runtime-unavailable')
  assert.equal((await missing.releaseTask({ id: 'T' })).code, 'agent-runtime-unavailable')
  assert.equal(await missing.release('agent'), false)
  assert.deepEqual(await missing.drainDeferredReleases(), [])
  assert.equal(missing.markCallerReturned('agent'), false)
})

// ── T-183: lifecycle transitions dispose the card's stage children ───────────
const priorTask = {
  id: 'T-1',
  status: 'testing',
  kind: 'dev',
  ownerSession: 'root',
  assignee: { name: 'worker-t-1-g1', session: 'agent-worker' },
  review: { status: 'approved', deliveredTo: { name: 'reviewer-t-1-g2', id: 'agent-reviewer' } },
  test: { status: 'pending', deliveredTo: { name: 'tester-t-1-g3', id: 'agent-tester' } },
}
const lifecycleBoard = { tasks: [priorTask] }
function lifecycleRig(options) {
  const releases = []
  const stageAgents = {
    async releaseTask(task, releaseOptions) {
      releases.push({ id: task === null || task === undefined ? null : task.id, roles: releaseOptions.roles, reason: releaseOptions.reason })
      if (options !== undefined && options.throwOnRelease === true) throw new Error('release exploded')
      return { ok: true, released: [], interrupted: [], unresolved: [], failed: [] }
    },
  }
  const model = {
    findTask: (board, id) => board.tasks.filter((candidate) => candidate.id === id)[0],
    cancelTask: () => ({ ok: true, board: lifecycleBoard, task: priorTask, events: ['cancel'] }),
    reopenTask: () => ({ ok: true, board: lifecycleBoard, task: priorTask, events: ['reopen'] }),
    unblockTask: () => ({ ok: true, board: lifecycleBoard, task: priorTask, events: ['unblock'] }),
    retryTask: () => ({ ok: true, board: lifecycleBoard, task: priorTask, events: ['retry'] }),
    blockTask: () => ({ ok: true, board: lifecycleBoard, task: priorTask, events: ['block'] }),
  }
  const actions = createLifecycleActions({
    readBoardOrFail: async () => ({ board: lifecycleBoard }),
    model: model,
    writeTask: async (project, id, mutator) => mutator(lifecycleBoard),
    clock: () => 1000,
    writeByName: () => 'user',
    state: { memory: { locks: [] } },
    ctx: {},
    interruptAssignee: async () => {},
    cleanupInvestigation: async () => {},
    failure: (code, message) => ({ ok: false, code: code, message: message }),
    stageAgents: stageAgents,
  })
  return { actions: actions, releases: releases }
}

await check('block/reopen/unblock/retry/cancel dispose every stage child of the card', async () => {
  const rig = lifecycleRig()
  for (const action of ['cancel', 'block', 'reopen', 'unblock', 'retry']) {
    const result = await rig.actions[action]({ id: 'T-1' }, { by: 'user' }, '/project')
    assert.equal(result.ok, true, action + ' should succeed')
  }
  assert.equal(rig.releases.length, 5)
  for (const release of rig.releases) {
    assert.equal(release.id, 'T-1')
    assert.deepEqual(release.roles, ['worker', 'reviewer', 'tester'])
  }
  assert.deepEqual(rig.releases.map((entry) => entry.reason), ['cancelled', 'blocked', 'reopened', 'unblocked', 'retried'])
})

await check('a failing stage release never fails the lifecycle action', async () => {
  const rig = lifecycleRig({ throwOnRelease: true })
  const blocked = await rig.actions.block({ id: 'T-1' }, { by: 'user' }, '/project')
  assert.equal(blocked.ok, true)
  const reopened = await rig.actions.reopen({ id: 'T-1' }, { by: 'user' }, '/project')
  assert.equal(reopened.ok, true)
})

const failed = checks.filter((row) => !row.ok)
for (const row of checks) console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
