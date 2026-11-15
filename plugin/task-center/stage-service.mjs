/**
 * Stage delivery for the v3 workflow: reviewer/tester are temporary children
 * of the root, not persistent Team slots. This service only starts/sends; the
 * action layer owns the board records and the brief text.
 *
 * T-183: release is not memory-only anymore. A stage end must be able to dispose
 * the child from the task/role/name recorded on the board and in the live agent
 * tree even when this process lost the handle (plugin reload, block, retry).
 */

import { deferReleaseAgent, markDeferredReleaseReturned, reapDeferredReleases, releaseAgent } from './task-agents.mjs'

const ALL_ROLES = Object.freeze(['worker', 'reviewer', 'tester'])

function callerAgentIdOf(options) {
  const requested = options === undefined || options === null ? {} : options
  return typeof requested.callerAgentId === 'string' && requested.callerAgentId !== '' ? requested.callerAgentId : null
}

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
        return Object.assign(await unavailable(), { taskId: task === null || task === undefined ? null : task.id, released: [], interrupted: [], unresolved: [], failed: [], deferred: [] })
      },
      async drainDeferredReleases() { return [] },
      markCallerReturned() { return false },
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
    async release(agentId, options) {
      if (typeof agentId !== 'string' || agentId === '') return false
      const releaseOptions = options === undefined || options === null ? {} : options
      // T-185: the caller of a verdict action is in flight; queue its retirement
      // instead of disposing the activation its tool result is still owed to.
      if (typeof releaseOptions.callerAgentId === 'string' && releaseOptions.callerAgentId !== '' && releaseOptions.callerAgentId === agentId) {
        deferReleaseAgent(agentId, { taskId: releaseOptions.taskId, reason: releaseOptions.reason })
        return false
      }
      try {
        if (await agents.release(agentId, releaseOptions)) return true
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
      // T-185: a verdict action runs inside its caller's turn; the caller must
      // never be disposed before the tool result reaches it.
      const callerAgentId = callerAgentIdOf(releaseOptions)
      const instance = instanceFor(task)
      if (instance !== null && typeof instance.releaseTask === 'function') {
        try {
          const result = await instance.releaseTask(task, { roles: roles, reason: releaseOptions.reason, signal: releaseOptions.signal, callerAgentId: callerAgentId })
          if (result !== null && result !== undefined && typeof result === 'object') {
            const released = Array.isArray(result.released) ? result.released : []
            const failed = Array.isArray(result.failed) ? result.failed : []
            const unresolved = Array.isArray(result.unresolved) ? result.unresolved : []
            const deferred = Array.isArray(result.deferred) ? result.deferred : []
            if (result.ok === true || released.length > 0 || failed.length > 0 || unresolved.length > 0 || deferred.length > 0) {
              return Object.assign({}, result, { deferred: deferred })
            }
          }
        } catch (error) {}
      }
      // Fallback: only the ids the board itself recorded. This is the path for
      // a facade that cannot resolve the root (or an older task-agent set).
      const released = []
      const unresolved = []
      const deferred = []
      for (const id of recordedIdsOf(task, roles)) {
        if (callerAgentId !== null && id === callerAgentId) {
          // Queue the self-release; the process-wide reconciler retires it after
          // the caller's turn ends. Never disposed from inside the action.
          const entry = deferReleaseAgent(id, {
            taskId: taskId,
            rootId: task === null || task === undefined || typeof task.ownerSession !== 'string' ? null : task.ownerSession,
            reason: releaseOptions.reason,
          })
          deferred.push({ agentId: id, name: null, role: null, sources: ['record'], queued: entry !== null })
          continue
        }
        let ok = false
        try {
          ok = await agents.release(id, { callerAgentId: callerAgentId })
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
      return { ok: unresolved.length === 0, taskId: taskId, roles: roles, released: released, interrupted: [], unresolved: unresolved, failed: [], deferred: deferred }
    },
    /**
     * T-185: the verdict action has computed its result. Only now may the
     * reconciler start the bounded wait of the caller's deferred self-release.
     */
    markCallerReturned(agentId) {
      return markDeferredReleaseReturned(agentId)
    },
    /** T-185: retire queued self-releases whose turn has ended. */
    async drainDeferredReleases(options) {
      try {
        return await reapDeferredReleases(options)
      } catch (error) {
        return []
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
