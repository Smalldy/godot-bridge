import assert from 'node:assert/strict'
import { createAgentRuntime, AGENT_RUNTIME_CODES } from '../../plugin/task-center/agent-runtime.mjs'

const checks = []
async function check(name, fn) { try { await fn(); checks.push({ name, ok: true }) } catch (error) { checks.push({ name, ok: false, error }) } }

const root = { id: 'root-session', name: 'lead' }
const child = { kind: 'child', id: 'child-session', name: 'worker-t-1', path: 'worker-t-1', parentId: 'root-session', depth: 1, activity: 'running', mode: 'continuable', hasChildren: false }
let spawnSpec = null
let sendArgs = null
let interruptArgs = null
const subagents = {
  async startActivation(spec) { spawnSpec = spec; return { childId: 'child-session', name: 'worker-t-1', result: Promise.resolve({ output: [] }), dispose: async () => {} } },
  async sendMessage(sender, target, content, options) { sendArgs = { sender, target, content, options }; return 'message-1' },
  interrupt(target, authority) { interruptArgs = { target, authority } },
  async listDescendants(rootId) { assert.equal(rootId, 'root-session'); return [child, { kind: 'diagnostic', id: 'bad-session', parentId: 'root-session', depth: 1, reason: 'corrupt' }] },
  rootOf(agent) { return root },
  namesOf(agent) { return { self: 'worker-t-1', parent: 'lead' } },
}
const ctx = { agent: root, get(name) { return name === 'subagents' ? subagents : undefined } }
const runtime = createAgentRuntime(ctx)

await check('runtime is available and keeps the exact root', () => {
  assert.equal(runtime.available, true)
  assert.equal(runtime.rootId, 'root-session')
  assert.equal(runtime.root, root)
})

await check('list returns normalized children and diagnostics', async () => {
  const rows = await runtime.list()
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { kind: 'child', id: 'child-session', name: 'worker-t-1', path: 'worker-t-1', parentId: 'root-session', depth: 1, activity: 'running', mode: 'continuable', hasChildren: false })
  assert.equal(rows[1].kind, 'diagnostic')
  assert.equal(rows[1].reason, 'corrupt')
})

await check('spawn uses the root parent, a text prompt, caller delivery, and a stable name', async () => {
  const handle = await runtime.spawn({ role: 'worker', taskId: 'T-1', name: 'worker-t-1', prompt: 'do it', label: 'worker T-1' })
  assert.equal(handle.agentId, 'child-session')
  assert.equal(handle.name, 'worker-t-1')
  assert.equal(spawnSpec.parent, root)
  assert.equal(spawnSpec.provider, 'spawn')
  assert.equal(spawnSpec.delivery, 'caller')
  assert.equal(spawnSpec.name, 'worker-t-1')
  assert.deepEqual(spawnSpec.prompt, [{ type: 'text', text: 'do it' }])
})

await check('send addresses the child Session id, never a name', async () => {
  const id = await runtime.send('child-session', 'continue')
  assert.equal(id, 'message-1')
  assert.equal(sendArgs.sender, root)
  assert.equal(sendArgs.target, 'child-session')
  assert.deepEqual(sendArgs.content, [{ type: 'text', text: 'continue' }])
})

await check('interrupt is rooted in the exact ancestor Agent', () => {
  runtime.interrupt('child-session')
  assert.equal(interruptArgs.target, 'child-session')
  assert.deepEqual(interruptArgs.authority, { kind: 'ancestor', agent: root })
})

await check('invalid subagent names are refused before the host call', async () => {
  await assert.rejects(runtime.spawn({ name: 'T-1', prompt: 'x' }), (error) => error.code === AGENT_RUNTIME_CODES.invalidName)
})

await check('a missing subagent service is explicit, not silently degraded', async () => {
  const missing = createAgentRuntime({ agent: root })
  assert.equal(missing.available, false)
  await assert.rejects(missing.list(), (error) => error.code === AGENT_RUNTIME_CODES.unavailable)
})

await check('a missing root is explicit', async () => {
  const missing = createAgentRuntime({ get(name) { return name === 'subagents' ? subagents : undefined } })
  assert.equal(missing.available, false)
  await assert.rejects(missing.list(), (error) => error.code === AGENT_RUNTIME_CODES.noRoot)
})

const failed = checks.filter((row) => !row.ok)
for (const row of checks) console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
