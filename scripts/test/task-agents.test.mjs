import assert from 'node:assert/strict'
import {
  agentNameFor,
  AGENT_LIST_TIMEOUT_CODE,
  createTaskAgents,
  DEFERRED_RELEASE_GRACE_MS,
  deferReleaseAgent,
  deferredReleaseIds,
  forgetAgentListCache,
  forgetDeferredRelease,
  markDeferredReleaseReturned,
  reapDeferredReleases,
} from '../../plugin/task-center/task-agents.mjs'
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
  // T-221: how many times the whole tree was read (the calls a release must avoid).
  listCalls: 0,
  hangList: false,
  disposeFailuresLeft: 0,
  // T-185: a child whose turn already ended lists as inactive.
  inactive: new Set(),
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
    state.listCalls += 1
    // A catalog that never answers: the bounded fallback must time out, not wait.
    if (state.hangList === true) return new Promise(function () {})
    if (state.listFails) throw new Error('catalog unreadable')
    return Array.from(state.live.entries()).map((entry) => ({
      kind: 'child',
      id: entry[0],
      name: entry[1],
      parentId: 'root',
      depth: 1,
      activity: state.inactive.has(entry[0]) ? 'inactive' : 'running',
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

// ── T-214: every stage child starts in the directory it may write to ────────
await check('worker/reviewer start in the task worktree; a tester only in an explicit candidate', async () => {
  const worktree = 'C:/project/.worktrees/T-40-1'
  const candidate = 'C:/project/.worktrees/test-T-40'
  const before = state.spawns.length
  const worker = await agents.startWorker({ id: 'T-40', worktree: worktree }, 'implement')
  const reviewer = await agents.startReviewer({ id: 'T-40', worktree: worktree }, 'review')
  const tester = await agents.startTester({ id: 'T-40', worktree: worktree }, 'test')
  const testerWithCandidate = await agents.startTester({ id: 'T-40', worktree: worktree }, 'test again', { cwd: candidate })
  const explicitWorker = await agents.startWorker({ id: 'T-40', worktree: worktree }, 'implement', { cwd: candidate })
  const spawned = state.spawns.slice(before)
  assert.equal(spawned[0].cwd, worktree, 'the worker starts in the card worktree')
  assert.equal(spawned[1].cwd, worktree, 'the reviewer starts in the card worktree')
  assert.equal(spawned[2].cwd, undefined, 'a tester NEVER falls back to the task worktree')
  assert.equal(spawned[3].cwd, candidate, 'a tester starts in the candidate it was given')
  assert.equal(spawned[4].cwd, candidate, 'an explicit cwd wins over the task worktree')
  for (const child of [worker, reviewer, tester, testerWithCandidate, explicitWorker]) await agents.release(child.agentId)
})

await check('a missing stage path passes no cwd instead of guessing the main checkout', async () => {
  const before = state.spawns.length
  const worker = await agents.startWorker({ id: 'T-41' }, 'implement')
  const reviewer = await agents.startReviewer({ id: 'T-41' }, 'review')
  const tester = await agents.startTester({ id: 'T-41' }, 'test', { cwd: '   ' })
  const spawned = state.spawns.slice(before)
  for (const spec of spawned) assert.equal(Object.prototype.hasOwnProperty.call(spec, 'cwd'), false, 'a missing path must not become a cwd')
  for (const child of [worker, reviewer, tester]) await agents.release(child.agentId)
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

await check('a receipted child is released by its exact id without a tree scan', async () => {
  const firstInstance = createTaskAgents({ runtime })
  const tester = await firstInstance.startTester({ id: 'T-6' }, 'test')
  // Simulate a plugin reload: a new task-agent set has no handles at all.
  const reloaded = createTaskAgents({ runtime })
  // T-221: the board record passed here has no deliveredTo id, but the process
  // still holds the activation receipt for that exact child. A receipt IS an
  // exact id, so the O(tree) name scan is not reached at all.
  forgetAgentListCache()
  const before = state.listCalls
  const result = await reloaded.releaseTask({ id: 'T-6', ownerSession: 'root' }, { roles: ['tester'] })
  assert.equal(state.listCalls - before, 0, 'a receipted child triggered a whole-tree scan')
  assert.equal(result.ok, true)
  assert.equal(result.released.length, 1)
  assert.equal(result.released[0].agentId, tester.agentId)
  assert.deepEqual(result.released[0].sources, ['registry'], 'an exact receipt is the discovery source')
  assert.equal(result.agentList, null, 'no fallback tree read was attempted')
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

// ── T-185: a verdict's caller is never self-released in flight ───────────────
await check('releaseTask queues the caller instead of disposing it while its turn runs', async () => {
  const reviewer = await agents.startReviewer({ id: 'T-20' }, 'review')
  state.inactive.delete(reviewer.agentId)
  const disposedBefore = state.disposed.length
  const deferred = await agents.releaseTask(
    { id: 'T-20', review: { deliveredTo: { id: reviewer.agentId } } },
    { roles: ['reviewer'], callerAgentId: reviewer.agentId },
  )
  assert.equal(deferred.released.length, 0, 'the caller is not reported released')
  assert.deepEqual(deferred.deferred.map((entry) => entry.agentId), [reviewer.agentId])
  assert.equal(state.disposed.length, disposedBefore, 'nothing is disposed before the action returns')
  assert.equal(state.live.has(reviewer.agentId), true)
  assert.ok(deferredReleaseIds().indexOf(reviewer.agentId) >= 0, 'the self-release is queued for the reconciler')
  // The action has not returned yet: even an enormous clock jump may not touch it.
  const inFlight = await reapDeferredReleases({ now: Date.now() + 60 * 60 * 1000 })
  assert.ok(inFlight.some((row) => row.agentId === reviewer.agentId && row.outcome === 'in-flight'), JSON.stringify(inFlight))
  assert.equal(state.live.has(reviewer.agentId), true, 'an in-flight caller is never disposed')
  // The action returned; now the wait window starts, but the turn still runs.
  assert.equal(markDeferredReleaseReturned(reviewer.agentId), true)
  const waiting = await reapDeferredReleases()
  assert.ok(waiting.some((row) => row.agentId === reviewer.agentId && row.outcome === 'waiting'), JSON.stringify(waiting))
  assert.equal(state.live.has(reviewer.agentId), true, 'a running caller is never disposed')
  // The tool result was delivered and the turn ended: only now is it retired.
  state.inactive.add(reviewer.agentId)
  const reaped = await reapDeferredReleases()
  assert.ok(reaped.some((row) => row.agentId === reviewer.agentId && row.outcome === 'released'), JSON.stringify(reaped))
  assert.equal(state.live.has(reviewer.agentId), false)
  assert.ok(state.disposed.indexOf(reviewer.agentId) >= 0)
  assert.equal(deferredReleaseIds().indexOf(reviewer.agentId), -1, 'the queue drains; no zombie is left behind')
})

await check('release refuses to dispose its own caller', async () => {
  const tester = await agents.startTester({ id: 'T-21' }, 'test')
  state.inactive.delete(tester.agentId)
  const disposedBefore = state.disposed.length
  assert.equal(await agents.release(tester.agentId, { callerAgentId: tester.agentId }), false)
  assert.equal(state.disposed.length, disposedBefore)
  assert.equal(state.live.has(tester.agentId), true)
  state.inactive.add(tester.agentId)
  markDeferredReleaseReturned(tester.agentId)
  await reapDeferredReleases()
  assert.equal(state.live.has(tester.agentId), false)
})

await check('an overrunning caller is interrupted, given a grace window, then disposed', async () => {
  const worker = await agents.startWorker({ id: 'T-22' }, 'implement')
  state.inactive.delete(worker.agentId)
  await agents.releaseTask({ id: 'T-22' }, { roles: ['worker'], callerAgentId: worker.agentId })
  const t0 = Date.now()
  // The action is still running: a jump past the whole budget must not stop it.
  const stillRunning = await reapDeferredReleases({ now: t0 + 10 * 60 * 1000 })
  assert.ok(stillRunning.some((row) => row.agentId === worker.agentId && row.outcome === 'in-flight'), JSON.stringify(stillRunning))
  assert.equal(state.interrupted.indexOf(worker.agentId), -1)
  // The action returned and its turn overran the wait: interrupt, grace, dispose.
  markDeferredReleaseReturned(worker.agentId)
  const interrupted = await reapDeferredReleases({ now: t0 + 10 * 60 * 1000 })
  assert.ok(interrupted.some((row) => row.agentId === worker.agentId && row.outcome === 'interrupted'), JSON.stringify(interrupted))
  assert.ok(state.interrupted.indexOf(worker.agentId) >= 0, 'the caller turn is interrupted first')
  assert.equal(state.disposed.indexOf(worker.agentId), -1, 'an active activation is never disposed bare')
  const grace = await reapDeferredReleases({ now: t0 + 10 * 60 * 1000 + 1 })
  assert.ok(grace.some((row) => row.agentId === worker.agentId && row.outcome === 'grace'), JSON.stringify(grace))
  assert.equal(state.disposed.indexOf(worker.agentId), -1)
  const retired = await reapDeferredReleases({ now: t0 + 10 * 60 * 1000 + DEFERRED_RELEASE_GRACE_MS + 1 })
  assert.ok(retired.some((row) => row.agentId === worker.agentId && row.outcome === 'released'), JSON.stringify(retired))
  assert.equal(state.live.has(worker.agentId), false)
})

await check('deferring/reaping is idempotent and unknown ids are ignored', async () => {
  const worker = await agents.startWorker({ id: 'T-23' }, 'implement')
  const first = deferReleaseAgent(worker.agentId, { reason: 'test' })
  const second = deferReleaseAgent(worker.agentId, { reason: 'again' })
  assert.equal(first, second, 'the queue keeps one entry per agent')
  assert.equal(deferReleaseAgent('no-such-agent'), null, 'an id without a receipt has no disposal capability')
  forgetDeferredRelease(worker.agentId)
  assert.equal(deferredReleaseIds().indexOf(worker.agentId), -1)
  await agents.release(worker.agentId)
})

// T-185 review round 1: an action can legitimately outrun the whole wait budget
// (passTest merge/verify, approveReview candidate discard). While it is still in
// flight NOTHING may happen to its caller, however far the reaper's clock jumps.
await check('a queued self-release is never reaped before its action returns', async () => {
  const reviewer = await agents.startReviewer({ id: 'T-25' }, 'review')
  state.inactive.delete(reviewer.agentId)
  await agents.releaseTask(
    { id: 'T-25', review: { deliveredTo: { id: reviewer.agentId } } },
    { roles: ['reviewer'], callerAgentId: reviewer.agentId },
  )
  const farFuture = Date.now() + 24 * 60 * 60 * 1000
  const inFlight = await reapDeferredReleases({ now: farFuture })
  assert.ok(inFlight.some((row) => row.agentId === reviewer.agentId && row.outcome === 'in-flight'), JSON.stringify(inFlight))
  assert.equal(state.interrupted.indexOf(reviewer.agentId), -1, 'an in-flight action is never interrupted')
  assert.equal(state.disposed.indexOf(reviewer.agentId), -1, 'an in-flight caller is never disposed')
  // Even a child that files as inactive is kept while its action is in flight.
  state.inactive.add(reviewer.agentId)
  const stillInFlight = await reapDeferredReleases({ now: farFuture })
  assert.ok(stillInFlight.some((row) => row.agentId === reviewer.agentId && row.outcome === 'in-flight'), JSON.stringify(stillInFlight))
  assert.equal(state.disposed.indexOf(reviewer.agentId), -1)
  // Only once the action returns may the reconciler retire the finished turn.
  assert.equal(markDeferredReleaseReturned(reviewer.agentId), true)
  const retired = await reapDeferredReleases({ now: farFuture })
  assert.ok(retired.some((row) => row.agentId === reviewer.agentId && row.outcome === 'released'), JSON.stringify(retired))
  assert.equal(state.live.has(reviewer.agentId), false)
})

// T-185 review round 1: disposeById reports a failed teardown as 'error' instead
// of throwing; the deferred path must not mistake that for a release.
await check('a deferred dispose failure keeps the entry and is retried', async () => {
  const worker = await agents.startWorker({ id: 'T-26' }, 'implement')
  state.inactive.delete(worker.agentId)
  await agents.releaseTask({ id: 'T-26' }, { roles: ['worker'], callerAgentId: worker.agentId })
  markDeferredReleaseReturned(worker.agentId)
  state.inactive.add(worker.agentId)
  state.disposeFailuresLeft = 1
  const first = await reapDeferredReleases()
  assert.ok(first.some((row) => row.agentId === worker.agentId && row.outcome === 'failed'), JSON.stringify(first))
  assert.ok(deferredReleaseIds().indexOf(worker.agentId) >= 0, 'a failed dispose must keep the entry for a retry')
  assert.equal(state.live.has(worker.agentId), true, 'a failed dispose is not a release')
  const retried = await reapDeferredReleases()
  assert.ok(retried.some((row) => row.agentId === worker.agentId && row.outcome === 'released'), JSON.stringify(retried))
  assert.equal(state.live.has(worker.agentId), false)
  assert.equal(deferredReleaseIds().indexOf(worker.agentId), -1)
})

// ── T-204: one live reviewer/tester per card, enforced at the spawn edge ────
await check('a new stage child releases the previous one of the same role first', async () => {
  const first = await agents.startReviewer({ id: 'T-30' }, 'review')
  const second = await agents.startReviewer({ id: 'T-30' }, 'review again')
  assert.notEqual(second.agentId, first.agentId)
  assert.equal(state.live.has(first.agentId), false, 'the previous reviewer is still live during the replacement')
  assert.ok(state.disposed.indexOf(first.agentId) >= 0, 'the previous reviewer was not disposed')
  assert.equal(state.live.has(second.agentId), true)
  const firstTester = await agents.startTester({ id: 'T-30' }, 'test')
  const secondTester = await agents.startTester({ id: 'T-30' }, 'test again')
  assert.equal(state.live.has(firstTester.agentId), false, 'two testers of one card stayed alive')
  assert.equal(state.live.has(secondTester.agentId), true)
  assert.equal(Array.from(state.live.values()).filter((name) => String(name).indexOf('reviewer-t-30-') === 0).length, 1)
  await agents.release(second.agentId)
  await agents.release(secondTester.agentId)
})

await check('a leaked stage child that only the tree names is stopped before the replacement', async () => {
  // A child started outside this registry (an older process, a replaced
  // deliveredTo): no receipt here, but its name still claims the card's role.
  const strayName = agentNameFor('reviewer', 'T-30', 'abc12345')
  state.live.set('stray-30', strayName)
  const started = await agents.startReviewer({ id: 'T-30', ownerSession: 'root' }, 'review')
  assert.ok(state.interrupted.indexOf('stray-30') >= 0, 'the tree-only orphan was never interrupted')
  assert.equal(state.disposed.indexOf('stray-30'), -1, 'without a receipt the child is interrupted, never reported released')
  assert.equal(state.live.has(started.agentId), true, 'the replacement reviewer did not start')
  state.live.delete('stray-30')
  await agents.release(started.agentId)
})

await check('a stage child that cannot be stopped blocks the next spawn', async () => {
  const first = await agents.startReviewer({ id: 'T-31' }, 'review')
  state.disposeFailuresLeft = 1
  await assert.rejects(agents.startReviewer({ id: 'T-31' }, 'again'), (error) => error.code === 'stage-child-still-live' && error.agentIds.indexOf(first.agentId) >= 0)
  const reviewers = Array.from(state.live.values()).filter((name) => String(name).indexOf('reviewer-t-31-') === 0)
  assert.equal(reviewers.length, 1, 'two reviewers of one card were left alive')
  await agents.release(first.agentId)
})

await check('the spawn-edge sweep is limited to the reviewer/tester roles', async () => {
  // The worker slot belongs to the dispatcher's claim/lease machinery; a worker
  // spawn must not start disposing it behind the scheduler's back.
  const first = await agents.startWorker({ id: 'T-32' }, 'implement')
  const second = await agents.startWorker({ id: 'T-32' }, 'implement again')
  assert.equal(state.live.has(first.agentId), true, 'the worker spawn swept a dispatcher-owned slot')
  assert.equal(state.live.has(second.agentId), true)
  const released = await agents.releaseTask({ id: 'T-32' }, { roles: ['worker'] })
  assert.equal(released.ok, true)
  assert.equal(state.live.has(first.agentId), false)
  assert.equal(state.live.has(second.agentId), false)
})

// ── T-221: the tree scan is a bounded LAST resort ───────────────────────────
// A full catalog read is O(tree). On a long-lived host it took minutes and the
// release waiting on it held the merge queue until its unit was abandoned. The
// board's own records and the in-process receipts are exact ids; the scan is only
// reached when they cannot name a child for a requested role, and then it is
// bounded, memoised and single-flighted.
await check('T-221 a fully recorded card is released without any tree scan', async () => {
  forgetAgentListCache()
  const worker = await agents.startWorker({ id: 'T-50' }, 'implement')
  const reviewer = await agents.startReviewer({ id: 'T-50' }, 'review')
  const tester = await agents.startTester({ id: 'T-50' }, 'test')
  const before = state.listCalls
  const result = await agents.releaseTask(
    {
      id: 'T-50',
      assignee: { session: worker.agentId },
      review: { deliveredTo: { id: reviewer.agentId } },
      test: { deliveredTo: { id: tester.agentId } },
    },
    {},
  )
  assert.equal(state.listCalls - before, 0, 'a fully recorded card triggered a whole-tree scan')
  assert.equal(result.agentList, null, 'no fallback read was attempted')
  assert.equal(result.ok, true)
  assert.deepEqual(result.released.map((entry) => entry.agentId).sort(), [worker.agentId, reviewer.agentId, tester.agentId].sort())
  assert.equal(state.live.has(worker.agentId), false)
  assert.equal(state.live.has(reviewer.agentId), false)
  assert.equal(state.live.has(tester.agentId), false)
})

await check('T-221 a missing record and no receipt: exactly ONE bounded fallback read', async () => {
  forgetAgentListCache()
  state.live.set('stray-51', agentNameFor('reviewer', 'T-51', 'abc67890'))
  const freshInstance = createTaskAgents({ runtime })
  const before = state.listCalls
  const result = await freshInstance.releaseTask({ id: 'T-51', ownerSession: 'root' }, { roles: ['reviewer'] })
  assert.equal(state.listCalls - before, 1, 'the fallback must read the tree exactly once')
  assert.ok(result.agentList !== null, 'no fallback read was reported')
  assert.equal(result.agentList.attempted, true)
  assert.equal(result.agentList.timedOut, false)
  assert.equal(result.interrupted.length, 1)
  assert.equal(result.interrupted[0].agentId, 'stray-51')
  assert.ok(state.interrupted.indexOf('stray-51') >= 0, 'the tree-only orphan was never stopped')
  state.live.delete('stray-51')
})

await check('T-221 a hung catalog is bounded and never blocks the release', async () => {
  forgetAgentListCache()
  const worker = await agents.startWorker({ id: 'T-52' }, 'implement')
  state.hangList = true
  // listCacheMs 0: this read must be a real one, not a memoised answer.
  const boundedAgents = createTaskAgents({ runtime, listTimeoutMs: 40, listCacheMs: 0 })
  const startedAt = Date.now()
  const result = await boundedAgents.releaseTask({ id: 'T-52', assignee: { session: worker.agentId }, ownerSession: 'root' })
  const elapsed = Date.now() - startedAt
  state.hangList = false
  assert.ok(elapsed < 2000, 'the release waited ' + String(elapsed) + 'ms on a hung catalog')
  assert.equal(result.ok, true, 'a timed-out tree read must not fail the release')
  assert.equal(result.released.length, 1, 'the recorded worker was not released')
  assert.equal(result.released[0].agentId, worker.agentId)
  assert.equal(state.live.has(worker.agentId), false)
  assert.equal(result.agentList.timedOut, true)
  assert.equal(result.agentList.code, AGENT_LIST_TIMEOUT_CODE, 'a timed-out read must name agent-list-timeout')
})

await check('T-221 consecutive releases share ONE fallback read', async () => {
  forgetAgentListCache()
  state.live.set('stray-53', agentNameFor('reviewer', 'T-53', 'def24680'))
  const freshInstance = createTaskAgents({ runtime })
  const before = state.listCalls
  const first = await freshInstance.releaseTask({ id: 'T-53', ownerSession: 'root' }, { roles: ['reviewer'] })
  const second = await freshInstance.releaseTask({ id: 'T-54', ownerSession: 'root' }, { roles: ['reviewer'] })
  assert.equal(state.listCalls - before, 1, 'a second release repeated the whole-tree scan')
  assert.equal(first.agentList.cached, false)
  assert.equal(second.agentList.cached, true, 'the second release did not reuse the memoised rows')
  assert.ok(state.interrupted.indexOf('stray-53') >= 0, 'the cached read lost the orphan')
  state.live.delete('stray-53')
})

await check('T-221 a spawn invalidates the memoised rows', async () => {
  forgetAgentListCache()
  state.live.set('stray-55', agentNameFor('reviewer', 'T-55', 'aaa11111'))
  const freshInstance = createTaskAgents({ runtime })
  const first = await freshInstance.releaseTask({ id: 'T-55', ownerSession: 'root' }, { roles: ['reviewer'] })
  assert.equal(first.agentList.cached, false)
  const started = await freshInstance.startWorker({ id: 'T-56' }, 'implement')
  const second = await freshInstance.releaseTask({ id: 'T-57', ownerSession: 'root' }, { roles: ['tester'] })
  assert.equal(second.agentList.cached, false, 'a spawn left the tree membership memoised as stale')
  state.live.delete('stray-55')
  await freshInstance.release(started.agentId)
})

const failed = checks.filter((row) => !row.ok)
for (const row of checks) console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
