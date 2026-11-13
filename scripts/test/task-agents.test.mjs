import assert from 'node:assert/strict'
import { agentNameFor, createTaskAgents } from '../../plugin/task-center/task-agents.mjs'
import { createAgentRuntime } from '../../plugin/task-center/agent-runtime.mjs'

const checks = []
async function check(name, fn) { try { await fn(); checks.push({ name, ok: true }) } catch (error) { checks.push({ name, ok: false, error }) } }

await check('names are readable, lower-case, stable and within DSH limits', () => {
  assert.equal(agentNameFor('worker', 'T-1', 1), 'worker-t-1')
  assert.equal(agentNameFor('reviewer', 'T-1', 2), 'reviewer-t-1-2')
  assert.equal(agentNameFor('tester', 'Project / weird id!', 1), 'tester-project-weird-id')
  assert.equal(agentNameFor('nope', '', 1), 'worker-task')
  for (const role of ['worker', 'reviewer', 'tester']) {
    const name = agentNameFor(role, 'T-'.repeat(30), 9)
    assert.match(name, /^[a-z][a-z0-9-]{0,31}$/)
    assert.ok(name.length <= 32)
  }
})

const root = { id: 'root', name: 'lead' }
const spawned = []
const disposed = []
const subagents = {
  async startActivation(spec) {
    spawned.push(spec)
    const id = 'child-' + String(spawned.length)
    return { childId: id, name: spec.name, result: Promise.resolve({ output: [] }), dispose: async () => { disposed.push(id) } }
  },
  async sendMessage() { return 'message' },
  interrupt() {},
  async listDescendants() { return [] },
  rootOf() { return root },
  namesOf() { return { self: 'lead' } },
}
const runtime = createAgentRuntime({ agent: root, get(name) { return name === 'subagents' ? subagents : undefined } })
const agents = createTaskAgents({ runtime })

await check('worker/reviewer/tester starts are distinct and recorded', async () => {
  const worker = await agents.startWorker({ id: 'T-1', attempts: 1 }, 'implement')
  const reviewer = await agents.startReviewer({ id: 'T-1', attempts: 1 }, 'review')
  const tester = await agents.startTester({ id: 'T-1', attempts: 1 }, 'test')
  assert.equal(worker.agentId, 'child-1')
  assert.equal(reviewer.agentId, 'child-2')
  assert.equal(tester.agentId, 'child-3')
  assert.equal(worker.name, 'worker-t-1')
  assert.equal(reviewer.name, 'reviewer-t-1')
  assert.equal(tester.name, 'tester-t-1')
  assert.deepEqual(agents.handles(), ['child-1', 'child-2', 'child-3'])
  assert.equal(spawned[0].parent, root)
  assert.equal(spawned[0].delivery, 'caller')
  assert.deepEqual(spawned[1].prompt, [{ type: 'text', text: 'review' }])
})

await check('send uses the child id; release disposes exactly that handle', async () => {
  await agents.send('child-1', 'continue')
  assert.equal(await agents.release('child-1'), true)
  assert.equal(await agents.release('child-1'), false)
  assert.deepEqual(disposed, ['child-1'])
  assert.deepEqual(agents.handles(), ['child-2', 'child-3'])
})

await check('an unavailable runtime refuses task agents instead of degrading', () => {
  assert.throws(() => createTaskAgents({ runtime: { available: false } }), (error) => error.code === 'agent-runtime-unavailable')
})

const failed = checks.filter((row) => !row.ok)
for (const row of checks) console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
