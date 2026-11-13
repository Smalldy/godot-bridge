/**
 * Task workflow's role/agent lifecycle.
 *
 * A task's executor is not a team member and has no persistent slot. A worker
 * is started with the task, a reviewer/tester is started for one stage, and
 * every handle is released when the stage ends. Agent ids are the only routing
 * identity; the name is a readable label for the UI.
 */

export const TASK_ROLES = Object.freeze(['worker', 'reviewer', 'tester'])

function slug(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18)
}

/** A DSH subagent name: lower-case letters/digits/hyphens, at most 32 chars. */
export function agentNameFor(role, taskId, attempt) {
  const kind = TASK_ROLES.indexOf(role) >= 0 ? role : 'worker'
  const id = slug(taskId) === '' ? 'task' : slug(taskId)
  const suffix = Number.isFinite(attempt) && attempt > 1 ? '-' + String(Math.floor(attempt)) : ''
  let name = kind + '-' + id + suffix
  if (name.length > 32) name = name.slice(0, 32).replace(/-+$/g, '')
  return /^[a-z][a-z0-9-]{0,31}$/.test(name) ? name : 'worker-task'
}

/**
 * @param {object} options
 * @param {object} options.runtime createAgentRuntime result
 */
export function createTaskAgents(options) {
  const opts = options === undefined || options === null ? {} : options
  const runtime = opts.runtime
  if (runtime === null || runtime === undefined || runtime.available !== true) {
    const error = new Error('task agents need an available agent runtime')
    error.code = 'agent-runtime-unavailable'
    throw error
  }
  const handles = new Map()

  async function start(role, task, prompt, extra) {
    const input = extra === undefined || extra === null ? {} : extra
    const taskId = task !== null && task !== undefined && task.id !== undefined ? task.id : 'task'
    const attempt = Number.isFinite(task !== null && task !== undefined ? task.attempts : undefined) ? task.attempts : 1
    const name = agentNameFor(role, taskId, attempt)
    const handle = await runtime.spawn({
      role: role,
      taskId: taskId,
      name: name,
      label: role + ' ' + String(taskId),
      prompt: prompt,
      signal: input.signal,
    })
    handles.set(handle.agentId, handle)
    return { agentId: handle.agentId, name: handle.name === null ? name : handle.name, role: role, handle: handle }
  }

  async function send(agentId, text, options) {
    return runtime.send(agentId, text, options)
  }

  async function release(agentId) {
    const handle = handles.get(String(agentId))
    if (handle === undefined) return false
    handles.delete(String(agentId))
    try {
      await handle.dispose()
      return true
    } catch (error) {
      return false
    }
  }

  return {
    runtime: runtime,
    root: runtime.root,
    rootId: runtime.rootId,
    startWorker(task, prompt, extra) { return start('worker', task, prompt, extra) },
    startReviewer(task, prompt, extra) { return start('reviewer', task, prompt, extra) },
    startTester(task, prompt, extra) { return start('tester', task, prompt, extra) },
    send: send,
    release: release,
    handleFor(agentId) { return handles.get(String(agentId)) || null },
    handles() { return Array.from(handles.keys()) },
  }
}
