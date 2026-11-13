import assert from 'node:assert/strict'
import { createAgentRegistry } from '../../plugin/task-center/agent-registry.mjs'

const root = { id: 'root', name: 'lead' }
const agents = {
  get(id) { return id === 'root' ? root : undefined },
  list() { return [root] },
}
const calls = []
const subagents = {
  rootOf(agent) { return agent.id === 'root' ? root : null },
  async startActivation(spec) { calls.push(spec); const childId = 'child-' + String(calls.length); return { childId, name: spec.name, result: Promise.resolve({}), dispose: async () => {} } },
  async sendMessage() { return 'm' },
  interrupt() {},
  async listDescendants() { return [{ kind: 'child', id: 'child-1', name: 'worker-t-1', parentId: 'root', depth: 1, activity: 'inactive', mode: 'continuable' }] },
}
const ctx = { get(name) { if (name === 'agents') return agents; if (name === 'subagents') return subagents; return undefined } }
const registry = createAgentRegistry(ctx)
assert.equal(registry.available, true)
const forTask = registry.taskAgentsFor('root')
assert.ok(forTask !== null)
const task = { id: 'T-1', ownerSession: 'root', attempts: 1 }
const worker = await forTask.startWorker(task, 'brief')
assert.equal(worker.agentId, 'child-1')
assert.equal(worker.name, 'worker-t-1')
assert.equal(calls[0].parent, root)
const listed = await registry.listFor('root')
assert.equal(listed.length, 1)
assert.equal(listed[0].id, 'child-1')
const missing = createAgentRegistry({ get() { return undefined } })
assert.equal(missing.available, false)
assert.equal(missing.taskAgentsFor('root'), null)
console.log('PASS  agent registry resolves the exact root and lists its children')
