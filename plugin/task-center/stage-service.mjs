/**
 * Stage delivery for the v3 workflow: reviewer/tester are temporary children
 * of the root, not persistent Team slots. This service only starts/sends; the
 * action layer owns the board records and the brief text.
 *
 * T-183: release is not memory-only anymore. A stage end must be able to dispose
 * the child from the task/role/name recorded on the board and in the live agent
 * tree even when this process lost the handle (plugin reload, block, retry).
 */

import { releaseAgent } from './task-agents.mjs'

const ALL_ROLES = Object.freeze(['worker', 'reviewer', 'tester'])

function rolesOf(options) {
  const requested = options !== undefined && options !== null && Array.isArray(options.roles) ? options.roles : ALL_ROLES
  const roles = []
  for (const role of requested) {
    if (ALL_ROLES.indexOf(role) >= 0 && roles.indexOf(role) < 0) roles.push(role)
  }
  return roles.length === 0 ? ALL_ROLES.slice() : roles
}

function recordedIdsOf(task, roles) {
  const ids = []
  const push = function (id) {
    if (typeof id === 'string' && id !== '' && ids.indexOf(id) < 0) ids.push(id)
  }
  if (task !== null && task !== undefined) {
    if (roles.indexOf('worker') >= 0) push(task.assignee === null || task.assignee === undefined ? null : task.assignee.session)
    if (roles.indexOf('reviewer') >= 0) {
      push(task.review === null || task.review === undefined || task.review.deliveredTo === null || task.review.deliveredTo === undefined ? null : task.review.deliveredTo.id)
    }
    if (roles.indexOf('tester') >= 0) {
      push(task.test === null || task.test === undefined || task.test.deliveredTo === null || task.test.deliveredTo === undefined ? null : task.test.deliveredTo.id)
    }
  }
  return ids
}

export function createStageService(options) {
  const opts = options === undefined || options === null ? {} : options
  const agents = opts.taskAgents
  if (agents === null || agents === undefined) {
    const unavailable = async function () {
      return { ok: false, code: 'agent-runtime-unavailable', message: 'no task-agent runtime' }
    }
    return {
      available: false,
      async startReviewer() { return unavailable() },
      async startTester() { return unavailable() },
      async sendAssignee() { return unavailable() },
      async release() { return false },
      async releaseTask(task) {
        return Object.assign(await unavailable(), { taskId: task === null || task === undefined ? null : task.id, released: [], interrupted: [], unresolved: [], failed: [] })
      },
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

  /** The per-root task-agent set, when the facade can still resolve it. */
  function instanceFor(task) {
    if (typeof agents.taskAgentsFor !== 'function') return null
    const rootId = task !== null && task !== undefined && typeof task.ownerSession === 'string' ? task.ownerSession : null
    if (rootId === null || rootId === '') return null
    try {
      return agents.taskAgentsFor(rootId)
    } catch (error) {
      return null
    }
  }

  return {
    available: true,
    startReviewer(task, brief) { return start('reviewer', task, brief) },
    startTester(task, brief) { return start('tester', task, brief) },
    async release(agentId) {
      if (typeof agentId !== 'string' || agentId === '') return false
      try {
        if (await agents.release(agentId)) return true
      } catch (error) {}
      // The per-root handle map can be gone (plugin reloaded) while the child is
      // still alive: the process-wide activation receipt is the last capability.
      try {
        return await releaseAgent(agentId)
      } catch (error) {
        return false
      }
    },
    /**
     * Release every stage child of one card by role, including children whose
     * handle map was lost. Prefers the root's task-agent set (which can also scan
     * the live agent tree by name); falls back to the ids the board recorded.
     */
    async releaseTask(task, options) {
      const releaseOptions = options === undefined || options === null ? {} : options
      const roles = rolesOf(releaseOptions)
      const taskId = task !== null && task !== undefined && task.id !== undefined ? String(task.id) : null
      const instance = instanceFor(task)
      if (instance !== null && typeof instance.releaseTask === 'function') {
        try {
          const result = await instance.releaseTask(task, { roles: roles, reason: releaseOptions.reason, signal: releaseOptions.signal })
          if (result !== null && result !== undefined && typeof result === 'object') {
            const released = Array.isArray(result.released) ? result.released : []
            const failed = Array.isArray(result.failed) ? result.failed : []
            const unresolved = Array.isArray(result.unresolved) ? result.unresolved : []
            if (result.ok === true || released.length > 0 || failed.length > 0 || unresolved.length > 0) return result
          }
        } catch (error) {}
      }
      // Fallback: only the ids the board itself recorded. This is the path for
      // a facade that cannot resolve the root (or an older task-agent set).
      const released = []
      const unresolved = []
      for (const id of recordedIdsOf(task, roles)) {
        let ok = false
        try {
          ok = await agents.release(id)
        } catch (error) {
          ok = false
        }
        if (!ok) {
          // The root may no longer resolve at all; the process-wide receipt is
          // still enough to dispose this exact child after a reload.
          try {
            ok = await releaseAgent(id)
          } catch (error) {
            ok = false
          }
        }
        if (ok) released.push({ agentId: id, name: null, role: null, sources: ['record'] })
        else unresolved.push({ agentId: id, name: null, role: null, sources: ['record'] })
      }
      return { ok: unresolved.length === 0, taskId: taskId, roles: roles, released: released, interrupted: [], unresolved: unresolved, failed: [] }
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
