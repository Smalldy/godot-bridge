import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { notifyRetestFailure } from '../../plugin/task-center/api.mjs'

const calls = []
const stageAgents = {
  async sendAssignee(task, text) {
    calls.push({ taskId: task.id, session: task.assignee.session, text })
    return { ok: true, agentId: task.assignee.session }
  },
}
const task = { id: 'T-9', assignee: { session: 'session-worker' } }
const check = { command: 'npm test', exitCode: 1, timedOut: false, tail: 'FAIL retest' }
const sent = await notifyRetestFailure(stageAgents, task, 'T-9', check)
assert.equal(sent.ok, true)
assert.equal(calls.length, 1)
assert.equal(calls[0].session, 'session-worker')
assert.ok(calls[0].text.includes('Host mechanical verification FAILED'))
assert.ok(calls[0].text.includes('FAIL retest'))

const missing = await notifyRetestFailure(null, task, 'T-9', check)
assert.equal(missing.ok, false)
assert.equal(missing.code, 'agent-runtime-unavailable')

// The branch must use the worker notification, never the merge-outcome mailbox:
// task.merge.status is still open on a host retest failure.
const source = readFileSync(new URL('../../plugin/task-center/api.mjs', import.meta.url), 'utf8')
const start = source.indexOf('if (retestFailed) {')
const end = source.indexOf('recorded.candidate = rebuilt', start)
assert.ok(start >= 0 && end > start, 'retest branch exists')
const block = source.slice(start, end)
assert.ok(block.includes('notifyRetestFailure'), 'retest failure notifies the assignee')
assert.ok(!block.includes('notifyMergeOutcome'), 'retest failure is not routed to merge outcome')

console.log('PASS  host retest failure notifies the live worker session, not the merge mailbox')
