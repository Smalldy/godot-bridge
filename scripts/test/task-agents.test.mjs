import assert from 'node:assert/strict'
import { agentNameFor, createTaskAgents } from '../../plugin/task-center/task-agents.mjs'
import { createAgentRuntime } from '../../plugin/task-center/agent-runtime.mjs'

const checks = []
async function check(name, fn) { try { await fn(); checks.push({ name, ok: true }) } catch (error) { checks.push({ name, ok: false, error }) } }

// T-183: one generation per spawn. The readable role-<taskId> prefix stays, but
// DSH reserves names for the whole root tree, so a repeated name poisons a
// reopen/re-dispatch even when the old child is inactive.
await check('names keep the readable prefix and add a unique generation suffix', () => {
  assert.equal(agentNameFor('worker', 'T-1', 1), 'worker-t-1-1')
  assert.equal(agentNameFor('reviewer', 'T-1', 2), 'reviewer-t-1-2')
  assert.equal(agentNameFor('tester', 'Project / weird id!', 1), 'tester-project-weird-id-1')
  assert.equal(agentNameFor('nope', '', 1), 'worker-task-1')
  assert.equal(agentNameFor('worker', 'T-1', 7), agentNameFor('worker', 'T-1', 7), 'an explicit generation is stable')
  assert.notEqual(agentNameFor('worker', 'T-1', 1), agentNameFor('worker', 'T-1', 2))
  const autoOne = agentNameFor('worker', 'T-1')
  const autoTwo = agentNameFor('worker', 'T-1')
  assert.notEqual(autoOne, autoTwo, 'an omitted generation mints a fresh token')
  assert.match(autoOne, /^worker-t-1-[a-z0-9]+$/)
  for (const role of ['worker', 'reviewer', 'tester']) {
    const name = agentNameFor(role, 'T-'.repeat(30), 9)
    assert.match(name, /^[a-z][a-z0-9-]{0,31}$/)
    assert.ok(name.length <= 32)
  }
})

const root = { id: 'root', name: 'lead' }
let sequence = 0
const state = {
  spawns: [],
  disposed: [],
  interrupted: [],
  live: new Map(),
  taken: new Set(),
  rejectNextNames: 0,
  listFails: false,
  disposeFailuresLeft: 0,
}
const subagents = {
  async startActivation(spec) {
    const reject = function () {
      const error = new Error('agent name "' + String(spec.name) + '" is already used by another subagent you created; choose another name')
      error.code = 'DUPLICATE_AGENT_NAME'
      return error
    }
    if (state.rejectNextNames > 0) {
      state.rejectNextNames -= 1
      state.spawns.push(spec)
      throw reject()
    }
    if (spec.name !== undefined && state.taken.has(spec.name)) {
      state.spawns.push(spec)
      throw reject()
    }
    sequence += 1
    const id = 'child-' + String(sequence)
    state.spawns.push(spec)
    state.live.set(id, spec.name)
    return {
      childId: id,
      name: spec.name,
      result: Promise.resolve({ output: [] }),
      dispose: async () => {
        if (state.disposeFailuresLeft > 0) {
          state.disposeFailuresLeft -= 1
          throw new Error('teardown failed')
        }
        state.disposed.push(id)
        state.live.delete(id)
      },
    }
  },
  async sendMessage() { return 'message' },
  interrupt(id) { state.interrupted.push(String(id)) },
  async listDescendants() {
    if (state.listFails) throw new Error('catalog unreadable')
    return Array.from(state.live.entries()).map((entry) => ({
      kind: 'child',
      id: entry[0],
      name: entry[1],
      parentId: 'root',
      depth: 1,
      activity: 'running',
      mode: 'continuable',
    }))
  },
  rootOf() { return root },
  namesOf() { return { self: 'lead' } },
}
const runtime = createAgentRuntime({ agent: root, get(name) { return name === 'subagents' ? subagents : undefined } })
const agents = createTaskAgents({ runtime })

await check('worker/reviewer/tester starts carry distinct generations', async () => {
  const worker = await agents.startWorker({ id: 'T-1', attempts: 1 }, 'implement')
  const reviewer = await agents.startReviewer({ id: 'T-1', attempts: 1 }, 'review')
  const tester = await agents.startTester({ id: 'T-1', attempts: 1 }, 'test')
  assert.equal(worker.agentId, 'child-1')
  assert.equal(reviewer.agentId, 'child-2')
  assert.equal(tester.agentId, 'child-3')
  assert.match(worker.name, /^worker-t-1-[a-z0-9]+$/)
  assert.match(reviewer.name, /^reviewer-t-1-[a-z0-9]+$/)
  assert.match(tester.name, /^tester-t-1-[a-z0-9]+$/)
  assert.notEqual(worker.name, reviewer.name)
  assert.notEqual(worker.generation, reviewer.generation)
  assert.deepEqual(agents.handles(), ['child-1', 'child-2', 'child-3'])
  assert.equal(state.spawns[0].parent, root)
  assert.equal(state.spawns[0].delivery, 'caller')
  assert.deepEqual(state.spawns[1].prompt, [{ type: 'text', text: 'review' }])
  // Everything this card started is disposed by task, without handing over ids.
  const released = await agents.releaseTask({ id: 'T-1' }, {})
  assert.equal(released.ok, true)
  assert.deepEqual(released.released.map((entry) => entry.agentId).sort(), ['child-1', 'child-2', 'child-3'])
  assert.deepEqual(agents.handles(), [])
})

await check('send uses the child id; release disposes exactly that handle', async () => {
  const worker = await agents.startWorker({ id: 'T-2' }, 'implement')
  await agents.send(worker.agentId, 'continue')
  assert.equal(await agents.release(worker.agentId), true)
  assert.equal(await agents.release(worker.agentId), false)
  assert.deepEqual(state.disposed.slice(-1), [worker.agentId])
})

await check('a reopen mints a new name and the spawn succeeds', async () => {
  const first = await agents.startWorker({ id: 'T-3', attempts: 1 }, 'implement')
  // reopen/unblock reset attempts to 1 in the board model: the old code produced
  // the SAME name here and DSH refused it because the inactive child keeps it.
  const reopened = await agents.startWorker({ id: 'T-3', attempts: 1 }, 'implement again')
  assert.notEqual(reopened.name, first.name)
  assert.match(reopened.name, /^worker-t-3-[a-z0-9]+$/)
  assert.equal(state.live.get(reopened.agentId), reopened.name)
  await agents.releaseTask({ id: 'T-3' })
})

await check('an already-used name is retried with a fresh generation instead of failing the dispatch', async () => {
  state.rejectNextNames = 1
  const before = state.spawns.length
  const started = await agents.startWorker({ id: 'T-4' }, 'implement')
  const attempts = state.spawns.slice(before)
  assert.equal(attempts.length, 2, 'one duplicate-name refusal then one successful start')
  assert.notEqual(attempts[0].name, attempts[1].name)
  assert.equal(started.name, attempts[1].name)
  assert.equal(state.live.get(started.agentId), started.name)
  await agents.release(started.agentId)
})

await check('release still works after the per-root handle map is lost', async () => {
  const firstInstance = createTaskAgents({ runtime })
  const reviewer = await firstInstance.startReviewer({ id: 'T-5' }, 'review')
  // Simulate a plugin reload: a new task-agent set has no handles at all.
  const reloaded = createTaskAgents({ runtime })
  assert.deepEqual(reloaded.handles(), [])
  assert.equal(await reloaded.release(reviewer.agentId), true)
  assert.ok(state.disposed.indexOf(reviewer.agentId) >= 0)
  assert.equal(state.live.has(reviewer.agentId), false)
})

await check('releaseTask finds a child by name in the agent tree when the handle is gone', async () => {
  const firstInstance = createTaskAgents({ runtime })
  const tester = await firstInstance.startTester({ id: 'T-6' }, 'test')
  const reloaded = createTaskAgents({ runtime })
  // The board record passed here has no deliveredTo id: discovery must come from
  // the tree row name, disposal from the retained activation receipt.
  const result = await reloaded.releaseTask({ id: 'T-6', ownerSession: 'root' }, { roles: ['tester'] })
  assert.equal(result.ok, true)
  assert.equal(result.released.length, 1)
  assert.equal(result.released[0].agentId, tester.agentId)
  assert.ok(result.released[0].sources.indexOf('tree') >= 0)
  assert.ok(result.released[0].sources.indexOf('registry') >= 0)
  assert.equal(state.live.has(tester.agentId), false)
})

await check('a tree-only orphan with no receipt is interrupted, never reported released', async () => {
  state.live.set('orphan-77', 'reviewer-t-77-abc123')
  const freshInstance = createTaskAgents({ runtime })
  const result = await freshInstance.releaseTask({ id: 'T-77' }, { roles: ['reviewer'] })
  assert.equal(result.released.length, 0)
  assert.equal(result.interrupted.length, 1)
  assert.equal(result.interrupted[0].agentId, 'orphan-77')
  assert.ok(state.interrupted.indexOf('orphan-77') >= 0)
  // And it does not claim the neighbouring card's children.
  assert.equal(result.interrupted.some((entry) => entry.agentId === 'child-1'), false)
  state.live.delete('orphan-77')
})

await check('releaseTask uses recorded board ids even when the tree cannot be read', async () => {
  const worker = await agents.startWorker({ id: 'T-7' }, 'implement')
  state.listFails = true
  const result = await agents.releaseTask({ id: 'T-7', assignee: { session: worker.agentId, name: worker.name } })
  state.listFails = false
  assert.equal(result.ok, true)
  assert.equal(result.released.length, 1)
  assert.equal(result.released[0].agentId, worker.agentId)
  assert.ok(result.released[0].sources.indexOf('record') >= 0)
})

await check('releaseTask only touches the named card', async () => {
  const one = await agents.startWorker({ id: 'T-8' }, 'implement')
  const two = await agents.startWorker({ id: 'T-9' }, 'implement')
  const result = await agents.releaseTask({ id: 'T-8' })
  assert.equal(result.released.length, 1)
  assert.equal(result.released[0].agentId, one.agentId)
  assert.equal(state.live.has(two.agentId), true)
  await agents.release(two.agentId)
})

await check('a failed dispose is reported and can be retried', async () => {
  const worker = await agents.startWorker({ id: 'T-10' }, 'implement')
  state.disposeFailuresLeft = 1
  const failed = await agents.releaseTask({ id: 'T-10' })
  assert.equal(failed.ok, false)
  assert.equal(failed.failed.length, 1)
  const retried = await agents.release(worker.agentId)
  assert.equal(retried, true)
})

await check('the same task id in another project keeps its own agents', async () => {
  const rootA = { id: 'root-a', name: 'lead-a' }
  const rootB = { id: 'root-b', name: 'lead-b' }
  function runtimeFor(root, tag) {
    const live = new Map()
    const disposed = []
    let localSequence = 0
    const svc = {
      async startActivation(spec) {
        localSequence += 1
        const id = tag + '-child-' + String(localSequence)
        live.set(id, spec.name)
        return { childId: id, name: spec.name, result: Promise.resolve({ output: [] }), dispose: async () => { disposed.push(id); live.delete(id) } }
      },
      async sendMessage() { return 'm' },
      interrupt() {},
      async listDescendants() {
        return Array.from(live.entries()).map((entry) => ({ kind: 'child', id: entry[0], name: entry[1], parentId: root.id, depth: 1, activity: 'running', mode: 'continuable' }))
      },
      rootOf() { return root },
      namesOf() { return { self: 'lead' } },
    }
    return { runtime: createAgentRuntime({ agent: root, get(name) { return name === 'subagents' ? svc : undefined } }), live: live, disposed: disposed }
  }
  const projectA = runtimeFor(rootA, 'a')
  const projectB = runtimeFor(rootB, 'b')
  const agentsA = createTaskAgents({ runtime: projectA.runtime })
  const agentsB = createTaskAgents({ runtime: projectB.runtime })
  const workerA = await agentsA.startWorker({ id: 'T-1', ownerSession: rootA.id }, 'a')
  const workerB = await agentsB.startWorker({ id: 'T-1', ownerSession: rootB.id }, 'b')
  const result = await agentsA.releaseTask({ id: 'T-1', ownerSession: rootA.id })
  assert.equal(result.released.length, 1)
  assert.equal(result.released[0].agentId, workerA.agentId)
  assert.equal(projectA.live.has(workerA.agentId), false)
  assert.equal(projectB.live.has(workerB.agentId), true, "the other project's card keeps its worker")
  assert.deepEqual(projectB.disposed, [])
  await agentsB.release(workerB.agentId)
})

await check('an unavailable runtime refuses task agents instead of degrading', () => {
  assert.throws(() => createTaskAgents({ runtime: { available: false } }), (error) => error.code === 'agent-runtime-unavailable')
})

const failed = checks.filter((row) => !row.ok)
for (const row of checks) console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
