/**
 * The task_center tool — the model's binding of the action API.
 *
 * It decides exactly three things: who is calling, where the project is, and
 * how a refusal is rendered. Every rule lives in api.mjs / service.mjs, shared
 * with the HTTP route, so the two surfaces cannot drift.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { AGENT_ACTIONS, READ_ACTIONS } from './api.mjs'
import { SKILL_NAME } from './skill.mjs'

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

// The description is a ROUTER, not the manual: what this is, the action enum,
// and where to read the rest. The workflow, the role matrix, the pipeline
// details and the refusal codes live in the runtime skill (skill.mjs), whose
// body is generated from this very action registry — one source, no drift —
// while the enum below stays because the model routes on it before loading
// anything.
const DESCRIPTION =
  'Project task board with dependency-driven dispatch, file locks and a review/test/merge pipeline; every task runs in its own git worktree. ' +
  'Read the skill "' + SKILL_NAME + '" first (skill tool): it carries the workflow, the action matrix, the write-card rules and the refusal codes. ' +
  'Actions: ' + AGENT_ACTIONS.join(', ') + '. ' +
  'start only records a dispatch request until the user approves it in the task center panel (needs-consent is not a failure). ' +
  'Dependencies: B.dependsOn=[A] means A must be done and merged before B runs.'

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
      evidence: { type: 'string', description: 'What was done and how it was checked (submit); the failing evidence (failTest).' },
      reasons: { type: 'string', description: 'What must change before the review can pass (requestChanges).' },
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
      verify: {
        description:
          'Host-run mechanical verification (create, update). The HOST executes the command in the test candidate right after the review is approved, before any tester is involved; a non-zero exit (or a timeout) records a failed test by the host and returns the task to running with the command, exit code and output tail. ' +
          'Omitting it (or null) keeps the legacy flow where the tester runs the suite itself.',
        oneOf: [
          {
            type: 'object',
            additionalProperties: true,
            properties: {
              command: {
                type: 'string',
                description: 'The shell command to run, e.g. "npm run verify" (it may chain: "npm run verify && npm run e2e").',
              },
              timeoutMs: {
                type: 'number',
                description: 'Upper bound in milliseconds; defaults to 600000 (10 minutes).',
              },
            },
          },
          { type: 'null', description: 'Clear a previously declared verification.' },
        ],
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