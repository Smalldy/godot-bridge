/**
 * Root-scoped task-agent registry.
 *
 * A DSH plugin row does not receive a root Agent at activation. The root is
 * resolved from the live Agent registry for a Session id (the card's
 * ownerSession, or the panel session for the tree view), then the subagent
 * service validates it. One runtime/task-agent set is cached per root.
 */

import { createAgentRuntime } from './agent-runtime.mjs'
import { createTaskAgents } from './task-agents.mjs'

function serviceOf(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const direct = ctx[name]
    if (direct !== undefined && direct !== null) return direct
  } catch (error) {}
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined && viaGet !== null) return viaGet
    }
  } catch (error) {}
  return undefined
}

function codeError(message) {
  const error = new Error(message)
  error.code = 'agent-runtime-unavailable'
  return error
}

export function createAgentRegistry(ctx) {
  const rootAgents = new Map()
  const taskAgentsByRoot = new Map()
  function services() {
    return { agents: serviceOf(ctx, 'agents'), subagents: serviceOf(ctx, 'subagents') }
  }

  function rootAgentOf(rootId) {
    const { agents, subagents } = services()
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return null
    if (subagents === undefined || subagents === null || typeof subagents.rootOf !== 'function') return null
    if (typeof rootId !== 'string' || rootId === '') return null
    try {
      let caller = agents.get(rootId)
      if ((caller === undefined || caller === null) && typeof agents.list === 'function') {
        const rows = agents.list()
        const list = Array.isArray(rows) ? rows : []
        caller = list.filter((entry) => entry !== null && entry !== undefined && (entry.id === rootId || (entry.session !== null && entry.session !== undefined && (entry.session.id === rootId || entry.session === rootId))))[0]
      }
      if (caller === undefined || caller === null) return null
      const root = subagents.rootOf(caller)
      if (root === undefined || root === null) return null
      if (typeof root === 'string') return agents.get(root) || null
      return root
    } catch (error) {
      return null
    }
  }

  function taskAgentsFor(rootId) {
    if (typeof rootId !== 'string' || rootId === '') return null
    if (taskAgentsByRoot.has(rootId)) return taskAgentsByRoot.get(rootId)
    const root = rootAgentOf(rootId)
    if (root === null) return null
    const { subagents } = services()
    const runtime = createAgentRuntime({ agent: root, subagents: subagents }, { root: root })
    if (runtime.available !== true) return null
    const taskAgents = createTaskAgents({ runtime: runtime })
    rootAgents.set(rootId, root)
    taskAgentsByRoot.set(rootId, taskAgents)
    return taskAgents
  }

  function forTask(task) {
    const rootId = task !== null && task !== undefined && typeof task.ownerSession === 'string' ? task.ownerSession : null
    return taskAgentsFor(rootId)
  }

  function requireForTask(task) {
    const taskAgents = forTask(task)
    if (taskAgents === null) throw codeError('no live root Agent for task owner ' + String(task === null || task === undefined ? '' : task.ownerSession))
    return taskAgents
  }

  async function listFor(rootId) {
    const taskAgents = taskAgentsFor(rootId)
    if (taskAgents === null) return []
    return taskAgents.runtime.list()
  }

  async function release(agentId) {
    let released = false
    for (const taskAgents of taskAgentsByRoot.values()) {
      try {
        if (await taskAgents.release(agentId)) released = true
      } catch (error) {}
    }
    return released
  }

  return {
    get available() {
      const { agents, subagents } = services()
      return subagents !== undefined && subagents !== null && agents !== undefined && agents !== null
    },
    rootAgentOf: rootAgentOf,
    rootFor: rootAgentOf,
    taskAgentsFor: taskAgentsFor,
    forTask: forTask,
    requireForTask: requireForTask,
    listFor: listFor,
    release: release,
    roots() { return Array.from(rootAgents.keys()) },
  }
}
