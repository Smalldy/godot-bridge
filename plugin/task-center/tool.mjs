/**
 * The task_center tool — the model's binding of the action API.
 *
 * It decides exactly three things: who is calling, where the project is, and
 * how a refusal is rendered. Every rule lives in api.mjs / service.mjs, shared
 * with the HTTP route, so the two surfaces cannot drift.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { AGENT_ACTIONS, READ_ACTIONS } from './api.mjs'

/** A stable display label from the only identity the tool layer exposes. */
export function agentLabel(agent) {
  const raw = agent === undefined || agent === null ? '' : String(agent.id === undefined ? agent.session : agent.id)
  const short = raw.replace(/^session-/, '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)
  return short === '' ? '@unknown' : '@' + short
}

/** The project directory from the sandbox policy's session workspace. */
export function projectPathOf(ctx, agent) {
  const policy = ctx === undefined || ctx === null ? undefined : ctx.sandboxPolicy
  if (policy === undefined || policy === null) return null
  const candidates = []
  if (agent !== undefined && agent !== null && agent.id !== undefined) candidates.push({ session: agent.id })
  if (agent !== undefined && agent !== null && agent.session !== undefined) candidates.push({ session: agent.session })
  candidates.push(undefined)
  for (const candidate of candidates) {
    try {
      const resolved = candidate === undefined ? policy.resolve() : policy.resolve(candidate)
      if (resolved && typeof resolved.workspaceRoot === 'string' && resolved.workspaceRoot.length > 0) {
        return resolved.workspaceRoot
      }
    } catch (error) {}
  }
  return null
}

const DESCRIPTION = [
  'Project task board with dependency-driven dispatch and file locks.',
  'Actions: board (overview), list, get, create, update, delete,',
  'pause (immediate), tick (one scheduler pass), submit (an assignee reports done),',
  'mergeRequest (integrate an open MR into its target branch after verification) and rejectMerge —',
  'mergeRequest/rejectMerge are reserved for the user or the Team member named "merger" (every other agent gets merger-only);',
  'mergeRequest refuses with head-drift when the task branch has moved past the head the merge request recorded,',
  'and refreshMerge (its owner, the user or the merger) re-points an open request at the branch head and re-bases it on the target branch\'s current head, refreshing its commit and changed files, without committing, merging or pushing;',
  'when a submit opens a merge request the merger is notified directly,',
  'cancel, reopen, block, unblock, retry, cancelStartRequest,',
  'lock / unlock / locks / forceUnlock, openProject.',
  'start does not start dispatch for an agent: it records a request, and the user approves it in the task center panel.',
  'Dependencies: B.dependsOn=[A] means A must be done and merged (when A has a merge request) before B runs.',
  'A task only runs while dispatch is started; the scheduler acquires its writeFiles locks first.',
].join(' ')

export function registerTaskTool(ctx, options) {
  const opts = options === undefined ? {} : options
  const api = opts.api

  const tool = defineTool({
    name: 'task_center',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'What to do.',
        enum: AGENT_ACTIONS,
      },
      id: { type: 'string', description: 'Task id, e.g. T-12.' },
      title: { type: 'string', description: 'Task title (create, update).' },
      spec: { type: 'string', description: 'What the task involves (create, update).' },
      acceptance: { type: 'string', description: 'How completion is judged (create, update).' },
      evidence: { type: 'string', description: 'What was done and how it was checked (submit).' },
      note: { type: 'string', description: 'A line for the task history.' },
      dependsOn: {
        type: 'array',
        description: 'Task ids this task waits for (create, update). An empty array clears them.',
        items: { type: 'string' },
      },
      writeFiles: {
        type: 'array',
        description: 'Project-relative files this task will write; the scheduler locks them before dispatch.',
        items: { type: 'string' },
      },
      paths: {
        type: 'array',
        description: 'Project-relative paths for lock, unlock and forceUnlock.',
        items: { type: 'string' },
      },
      priority: { type: 'number', description: 'Higher runs first among ready tasks.' },
      maxAttempts: { type: 'number', description: 'Dispatch attempts before the task blocks.' },
      maxConcurrent: { type: 'number', description: 'Concurrent running tasks (settings).' },
      allowSpawn: { type: 'boolean', description: 'Whether the scheduler may spawn a WorkAgent (settings).' },
      maxWorkAgents: { type: 'number', description: 'Maximum WorkAgents (settings).' },
      status: { type: 'string', description: 'Filter for list.' },
      taskId: { type: 'string', description: 'Owning task for a lock.' },
      project: { type: 'string', description: 'Project directory; defaults to the session workspace.' },
      force: { type: 'boolean', description: 'Delete a referenced task and detach its dependents.' },
      path: { type: 'string', description: 'Project directory for openProject.' },
    },
    isConcurrencySafe: (args) => READ_ACTIONS.indexOf(args !== null && args !== undefined ? args.action : undefined) >= 0,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async function (args, exec) {
      const action = String(args.action || '')
      if (api === undefined || api === null) return { error: 'the task center API is not available' }
      const agent = exec === undefined ? undefined : exec.agent
      const me = agentLabel(agent)
      const projectPath = projectPathOf(ctx, agent)
      const context = { projectPath: projectPath, by: me, role: 'agent', agent: agent }
      const input = Object.assign({}, args)
      const result = await api.perform(action, input, context)
      if (result.ok !== true) {
        return {
          error: result.message,
          code: result.code,
          request: result.request === undefined ? null : result.request,
        }
      }
      if (result.board !== undefined) delete result.board
      return result
    },
  })

  return ctx.tools.register(tool)
}