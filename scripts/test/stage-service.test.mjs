import assert from 'node:assert/strict'
import { createStageService } from '../../plugin/task-center/stage-service.mjs'

const calls = []
const taskAgents = {
  async startReviewer(task, brief) { calls.push({ kind: 'reviewer', id: task.id, brief }); return { agentId: 'r-1', name: 'reviewer-t-1', handle: {} } },
  async startTester(task, brief) { calls.push({ kind: 'tester', id: task.id, brief }); return { agentId: 't-1', name: 'tester-t-1', handle: {} } },
  async send(id, text) { calls.push({ kind: 'send', id, text }); return 'm-1' },
}
const service = createStageService({ taskAgents })
const reviewer = await service.startReviewer({ id: 'T-1' }, 'review brief')
const tester = await service.startTester({ id: 'T-1' }, 'test brief')
const sent = await service.sendAssignee({ id: 'T-1', assignee: { session: 'w-1' } }, 'fix this')

assert.equal(service.available, true)
assert.equal(reviewer.ok, true)
assert.equal(reviewer.agentId, 'r-1')
assert.equal(reviewer.name, 'reviewer-t-1')
assert.equal(reviewer.created[0].id, 'r-1')
assert.equal(tester.agentId, 't-1')
assert.equal(sent.ok, true)
assert.deepEqual(calls.map((entry) => entry.kind), ['reviewer', 'tester', 'send'])
assert.equal(calls[2].id, 'w-1')
assert.equal(calls[2].text, 'fix this')

const missing = createStageService({})
assert.equal(missing.available, false)
assert.equal((await missing.startTester({ id: 'T' }, 'x')).code, 'agent-runtime-unavailable')
console.log('PASS  3/3 checks passed')
