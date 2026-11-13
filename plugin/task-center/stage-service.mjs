/**
 * Stage delivery for the v3 workflow: reviewer/tester are temporary children
 * of the root, not persistent Team slots. This service only starts/sends; the
 * action layer owns the board records and the brief text.
 */

export function createStageService(options) {
  const opts = options === undefined || options === null ? {} : options
  const agents = opts.taskAgents
  if (agents === null || agents === undefined) {
    return {
      available: false,
      async startReviewer() { return { ok: false, code: 'agent-runtime-unavailable', message: 'no task-agent runtime' } },
      async startTester() { return { ok: false, code: 'agent-runtime-unavailable', message: 'no task-agent runtime' } },
      async sendAssignee() { return { ok: false, code: 'agent-runtime-unavailable', message: 'no task-agent runtime' } },
    }
  }
  async function start(kind, task, brief) {
    try {
      const started = kind === 'reviewer'
        ? await agents.startReviewer(task, brief)
        : await agents.startTester(task, brief)
      return {
        ok: true,
        agentId: started.agentId,
        name: started.name,
        target: { name: started.name, id: started.agentId },
        created: [{ name: started.name, id: started.agentId, kind: kind }],
        reused: [],
        refused: [],
        kind: kind,
      }
    } catch (error) {
      return { ok: false, code: 'spawn-failed', message: String((error && error.message) || error) }
    }
  }
  return {
    available: true,
    startReviewer(task, brief) { return start('reviewer', task, brief) },
    startTester(task, brief) { return start('tester', task, brief) },
    async release(agentId) {
      if (typeof agentId !== 'string' || agentId === '') return false
      try {
        return await agents.release(agentId)
      } catch (error) {
        return false
      }
    },
    async sendAssignee(task, text) {
      const id = task !== null && task !== undefined && task.assignee !== null && task.assignee !== undefined ? task.assignee.session : null
      if (typeof id !== 'string' || id === '') return { ok: false, code: 'no-assignee', message: 'task has no assignee Session id' }
      try {
        await agents.send(id, text, { rootId: task.ownerSession })
        return { ok: true, agentId: id }
      } catch (error) {
        return { ok: false, code: 'send-failed', message: String((error && error.message) || error) }
      }
    },
  }
}
