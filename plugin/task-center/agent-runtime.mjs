/**
 * Task Center's only edge to the DSH agent runtime.
 *
 * There is no roster layer: a task's executors are ephemeral subagents in the
 * root agent's tree. They are started for a role/stage, addressed by durable
 * Session id, and disposed when the stage no longer needs them.
 *
 * This module is the single place that knows the subagent API. Dispatch, the
 * API, the board and the UI must consume this module instead of reaching into
 * the host's services directly.
 */

/** Stable failure codes callers can branch on without matching messages. */
export const AGENT_RUNTIME_CODES = Object.freeze({
  unavailable: 'subagent-service-unavailable',
  noRoot: 'subagent-root-unavailable',
  invalidName: 'subagent-name-invalid',
  startFailed: 'subagent-start-failed',
  sendFailed: 'subagent-send-failed',
  listFailed: 'subagent-list-failed',
  interruptFailed: 'subagent-interrupt-failed',
})

const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/

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

function codeError(code, message, cause) {
  const error = new Error(message)
  error.code = code
  if (cause !== undefined) error.cause = cause
  return error
}

function textBlocks(input) {
  if (Array.isArray(input)) return input
  if (typeof input === 'string') return [{ type: 'text', text: input }]
  if (input !== null && input !== undefined && typeof input === 'object' && typeof input.text === 'string') return [{ type: 'text', text: input.text }]
  return []
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => {
    if (row === null || typeof row !== 'object') return null
    if (row.kind === 'diagnostic') {
      return {
        kind: 'diagnostic',
        id: String(row.id),
        parentId: row.parentId === undefined ? null : String(row.parentId),
        depth: Number.isFinite(row.depth) ? row.depth : null,
        reason: typeof row.reason === 'string' ? row.reason : 'unavailable',
      }
    }
    if (row.kind !== 'child') return null
    return {
      kind: 'child',
      id: String(row.id),
      name: typeof row.name === 'string' ? row.name : null,
      path: typeof row.path === 'string' ? row.path : typeof row.name === 'string' ? row.name : null,
      parentId: row.parentId === undefined ? null : String(row.parentId),
      depth: Number.isFinite(row.depth) ? row.depth : null,
      activity: row.activity === 'running' ? 'running' : 'inactive',
      mode: typeof row.mode === 'string' ? row.mode : null,
      hasChildren: row.hasChildren === true,
    }
  }).filter((row) => row !== null)
}

/**
 * @param {object} ctx exact plugin context carrying the root Agent and subagents service
 * @param {object} [options]
 * @param {object} [options.root] explicit root Agent (defaults to ctx.agent)
 * @param {string} [options.provider] subagent provider name (default 'spawn')
 * @param {AbortSignal} [options.signal] optional root cancellation signal
 */
export function createAgentRuntime(ctx, options) {
  const opts = options === undefined || options === null ? {} : options
  const subagents = serviceOf(ctx, 'subagents')
  const root = opts.root !== undefined && opts.root !== null ? opts.root : serviceOf(ctx, 'agent')
  const provider = typeof opts.provider === 'string' && opts.provider !== '' ? opts.provider : 'spawn'
  const unavailable =
    subagents === undefined ||
    subagents === null ||
    typeof subagents.startActivation !== 'function' ||
    typeof subagents.sendMessage !== 'function' ||
    typeof subagents.listDescendants !== 'function' ||
    typeof subagents.rootOf !== 'function'
  const noRoot = root === null || root === undefined || typeof root.id !== 'string' || root.id === ''

  const runtime = {
    available: unavailable !== true && noRoot !== true,
    root: noRoot ? null : root,
    rootId: noRoot ? null : String(root.id),
    provider: provider,
    /**
     * List every live descendant of the root tree. The root itself is not a
     * member; the list is the only membership source in the new design.
     */
    async list(signal) {
      if (unavailable) throw codeError(AGENT_RUNTIME_CODES.unavailable, 'the DSH subagents service is not available')
      if (noRoot) throw codeError(AGENT_RUNTIME_CODES.noRoot, 'the task center needs an exact live root Agent')
      try {
        const rows = await subagents.listDescendants(String(root.id), signal === undefined ? opts.signal : signal)
        return normalizeRows(rows)
      } catch (error) {
        throw codeError(AGENT_RUNTIME_CODES.listFailed, 'could not list subagent descendants: ' + String((error && error.message) || error), error)
      }
    },
    /**
     * Start an ephemeral child for one task/stage. The caller owns the returned
     * handle and must dispose it when the stage is over.
     */
    async spawn(request) {
      if (unavailable) throw codeError(AGENT_RUNTIME_CODES.unavailable, 'the DSH subagents service is not available')
      if (noRoot) throw codeError(AGENT_RUNTIME_CODES.noRoot, 'the task center needs an exact live root Agent')
      const input = request === undefined || request === null ? {} : request
      const name = input.name === undefined || input.name === null || input.name === '' ? undefined : String(input.name)
      if (name !== undefined && !AGENT_NAME.test(name)) {
        throw codeError(AGENT_RUNTIME_CODES.invalidName, 'subagent name must match ' + String(AGENT_NAME))
      }
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const signal = input.signal !== undefined && input.signal !== null ? input.signal : controller === null ? opts.signal : controller.signal
      const spec = {
        provider: typeof input.provider === 'string' && input.provider !== '' ? input.provider : provider,
        parent: root,
        label: typeof input.label === 'string' && input.label !== '' ? input.label : String(input.role || 'worker') + ' ' + String(input.taskId || 'task'),
        prompt: textBlocks(input.prompt),
        delivery: input.delivery === 'parent' ? 'parent' : 'caller',
        signal: signal,
      }
      if (name !== undefined) spec.name = name
      if (typeof input.cwd === 'string' && input.cwd !== '') spec.cwd = input.cwd
      if (Number.isFinite(input.maxDepth)) spec.maxDepth = input.maxDepth
      try {
        const activation = await subagents.startActivation(spec)
        return {
          agentId: String(activation.childId),
          name: typeof activation.name === 'string' ? activation.name : name === undefined ? null : name,
          result: activation.result,
          dispose: function () {
            return activation.dispose()
          },
        }
      } catch (error) {
        throw codeError(AGENT_RUNTIME_CODES.startFailed, 'could not start subagent: ' + String((error && error.message) || error), error)
      }
    },
    /**
     * Deliver one message to a child by durable Session id. The root is the
     * sender; the child never needs to know a caller name.
     */
    async send(agentId, content, options) {
      if (unavailable) throw codeError(AGENT_RUNTIME_CODES.unavailable, 'the DSH subagents service is not available')
      if (noRoot) throw codeError(AGENT_RUNTIME_CODES.noRoot, 'the task center needs an exact live root Agent')
      if (typeof agentId !== 'string' || agentId === '') throw codeError(AGENT_RUNTIME_CODES.sendFailed, 'send needs a target Session id')
      const sendOptions = options === undefined || options === null ? {} : options
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const signal = sendOptions.signal !== undefined && sendOptions.signal !== null ? sendOptions.signal : controller === null ? opts.signal : controller.signal
      try {
        return await subagents.sendMessage(root, agentId, textBlocks(content), { signal: signal })
      } catch (error) {
        throw codeError(AGENT_RUNTIME_CODES.sendFailed, 'could not send to subagent ' + agentId + ': ' + String((error && error.message) || error), error)
      }
    },
    /** Interrupt a child as the root ancestor; never as a name lookup. */
    interrupt(agentId) {
      if (unavailable) throw codeError(AGENT_RUNTIME_CODES.unavailable, 'the DSH subagents service is not available')
      if (noRoot) throw codeError(AGENT_RUNTIME_CODES.noRoot, 'the task center needs an exact live root Agent')
      try {
        subagents.interrupt(agentId, { kind: 'ancestor', agent: root })
      } catch (error) {
        throw codeError(AGENT_RUNTIME_CODES.interruptFailed, 'could not interrupt subagent ' + agentId + ': ' + String((error && error.message) || error), error)
      }
    },
    /** Resolve the root of any live Agent; useful for tool-call authorization. */
    rootOf(agent) {
      if (unavailable) throw codeError(AGENT_RUNTIME_CODES.unavailable, 'the DSH subagents service is not available')
      return subagents.rootOf(agent)
    },
    /** Model-facing path/name for a live member. */
    namesOf(agent) {
      if (unavailable) throw codeError(AGENT_RUNTIME_CODES.unavailable, 'the DSH subagents service is not available')
      return subagents.namesOf(agent)
    },
  }
  return runtime
}
