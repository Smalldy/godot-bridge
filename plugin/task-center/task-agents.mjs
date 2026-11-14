/**
 * Task workflow's role/agent lifecycle.
 *
 * A task's executor is not a team member and has no persistent slot. A worker
 * is started with the task, a reviewer/tester is started for one stage, and
 * every handle is released when the stage ends. Agent ids are the only routing
 * identity; the name is a readable label for the UI.
 *
 * T-183: DSH reserves a child name for a whole root tree, even after that child
 * went inactive. A fixed name (worker-<taskId>[-attempt]) therefore poisoned
 * every later dispatch of the same card: reopen/unblock reset attempts to 1 and
 * the new worker reused the old name, which DSH refused with
 * DUPLICATE_AGENT_NAME. Every spawn now carries a generation suffix that is
 * unique for that spawn while the readable role-<taskId> prefix stays.
 *
 * Bindings are also no longer memory-only. The activation receipt is retained in
 * a process-wide registry, so a release that happens after the plugin reloaded
 * (and the per-root handle map went away) can still dispose the exact child by
 * id or by the name the agent tree reports. Without a receipt the child cannot
 * be disposed (disposal is a capability of the receipt), so the best possible
 * fallback is an interrupt, reported honestly as "interrupted" and never as
 * released.
 */

export const TASK_ROLES = Object.freeze(['worker', 'reviewer', 'tester'])

const NAME_MAX = 32
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const NAME_TOKEN_MAX = 12
const AUTO_TOKEN_LENGTH = 8
const DUPLICATE_NAME_RETRIES = 4

/** Process-local salt: a reloaded module must not restart the suffix series. */
const PROCESS_SALT = (function salt() {
  const text = Math.random().toString(36).replace(/[^a-z0-9]+/g, '')
  return text.slice(-2).padEnd(2, '0')
})()

/** Monotonic per-process spawn counter, so two spawns never share a token. */
let generationSequence = 0

function nextGeneration() {
  generationSequence += 1
  // The counter is the uniqueness guarantee; the clock keeps a reloaded module
  // from walking into the same series and the salt covers a fresh process.
  const clock = Date.now().toString(36).slice(-3)
  const sequence = generationSequence.toString(36)
  return (clock + sequence + PROCESS_SALT).slice(-AUTO_TOKEN_LENGTH).padStart(AUTO_TOKEN_LENGTH, '0')
}

function nameToken(value) {
  const text = String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, NAME_TOKEN_MAX)
  return text === '' ? nextGeneration() : text
}

function slug(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18)
}

/**
 * A DSH subagent name: lower-case letters/digits/hyphens, at most 32 chars.
 *
 * The generation suffix is what makes a re-dispatch possible; the readable
 * worker/reviewer/tester-<taskId> prefix is kept. Passing an explicit generation
 * keeps the function pure for a caller that already chose one; omitting it mints
 * a fresh token.
 */
export function agentNameFor(role, taskId, generation) {
  const kind = TASK_ROLES.indexOf(role) >= 0 ? role : 'worker'
  const token = generation === undefined || generation === null || generation === '' ? nextGeneration() : nameToken(generation)
  const suffix = '-' + token
  const budget = Math.max(1, NAME_MAX - kind.length - 1 - suffix.length)
  const slugged = slug(taskId)
  let id = (slugged === '' ? 'task' : slugged).slice(0, budget).replace(/-+$/g, '')
  if (id === '') id = 'task'.slice(0, budget)
  let name = kind + '-' + id + suffix
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).replace(/-+$/g, '')
  if (NAME_PATTERN.test(name)) return name
  // Defensive: a token made of something exotic must never yield an invalid or
  // non-unique name.
  const fallback = kind + '-task-' + nextGeneration()
  return NAME_PATTERN.test(fallback) ? fallback : 'worker-task'
}

function normaliseRoles(roles) {
  const list = Array.isArray(roles) ? roles : TASK_ROLES
  const out = []
  for (const role of list) {
    if (TASK_ROLES.indexOf(role) >= 0 && out.indexOf(role) < 0) out.push(role)
  }
  return out.length === 0 ? TASK_ROLES.slice() : out
}

/**
 * Does an agent name belong to this task in this role?
 *
 * The id part inside a generated name is the task slug TRIMMED to that name's
 * generation length, so the only safe test is to rebuild the name with the token
 * parsed out of it. Comparing raw prefixes would let task T-1 claim the agents
 * of T-1-extra.
 */
function taskRoleOfAgentName(name, roles, taskId) {
  if (typeof name !== 'string' || name === '') return null
  const slugged = slug(taskId)
  const plain = slugged === '' ? 'task' : slugged
  for (const role of roles) {
    if (name.indexOf(role + '-') !== 0) continue
    const rest = name.slice(role.length + 1)
    // A pre-generation name (worker-t-1) is still recognised for the same task.
    if (rest === plain) return role
    const cut = rest.lastIndexOf('-')
    if (cut <= 0) continue
    const token = rest.slice(cut + 1)
    if (token === '') continue
    if (agentNameFor(role, taskId, token) === name) return role
  }
  return null
}

/** A duplicate-name refusal as thrown by the DSH subagent manager. */
function isDuplicateNameError(error) {
  let current = error
  for (let depth = 0; current !== null && current !== undefined && typeof current === 'object' && depth < 6; depth += 1) {
    const code = typeof current.code === 'string' ? current.code : ''
    if (code === 'DUPLICATE_AGENT_NAME' || code === 'AGENT_NAME_DUPLICATE') return true
    const message = typeof current.message === 'string' ? current.message : ''
    if (/DUPLICATE_AGENT_NAME|already used by another subagent|name already used|is already used/i.test(message)) return true
    current = current.cause
  }
  return false
}

/**
 * Process-wide activation receipts, keyed by child Session id.
 *
 * Deliberately module scope, not per createTaskAgents() instance: the plugin row
 * can be reloaded (new registry/runtime objects) while the child Agents stay
 * alive, and disposal must still reach them.
 */
const activations = new Map()

async function disposeReceipt(agentId) {
  const id = String(agentId)
  const record = activations.get(id)
  if (record === undefined) return 'missing'
  try {
    await record.dispose()
    activations.delete(id)
    return 'released'
  } catch (error) {
    return 'error'
  }
}

/**
 * Release one activation by its Session id without needing the per-root handle
 * map. Used by the stage service as the last resort after a plugin reload.
 */
export async function releaseAgent(agentId) {
  if (typeof agentId !== 'string' || agentId === '') return false
  return (await disposeReceipt(agentId)) === 'released'
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
    let generation = nextGeneration()
    let name = agentNameFor(role, taskId, generation)
    let attempt = 0
    let handle = null
    while (handle === null) {
      try {
        handle = await runtime.spawn({
          role: role,
          taskId: taskId,
          name: name,
          label: role + ' ' + String(taskId),
          prompt: prompt,
          signal: input.signal,
        })
      } catch (error) {
        attempt += 1
        // A name the host already reserved for this root (an older inactive
        // child, another plugin instance, a reload) is recoverable: mint a new
        // generation and try again. Any other failure is real.
        if (attempt >= DUPLICATE_NAME_RETRIES || isDuplicateNameError(error) !== true) throw error
        generation = nextGeneration()
        name = agentNameFor(role, taskId, generation)
      }
    }
    const agentId = String(handle.agentId)
    handles.set(agentId, handle)
    activations.set(agentId, {
      agentId: agentId,
      name: typeof handle.name === 'string' && handle.name !== '' ? handle.name : name,
      role: role,
      taskId: String(taskId),
      // Task ids are project-scoped: two projects in one host can both own a
      // "T-1". The root keeps a release from reaching the other project's child.
      rootId: runtime.rootId === undefined ? null : runtime.rootId,
      generation: generation,
      dispose: function () {
        return handle.dispose()
      },
    })
    return { agentId: agentId, name: handle.name === null ? name : handle.name, role: role, handle: handle, generation: generation }
  }

  async function send(agentId, text, options) {
    return runtime.send(agentId, text, options)
  }

  /** Dispose one child and report whether it was really released. */
  async function disposeById(agentId) {
    const id = String(agentId)
    const handle = handles.get(id)
    const receipt = activations.get(id)
    if (handle === undefined && receipt === undefined) return 'missing'
    const dispose = receipt !== undefined
      ? function () { return receipt.dispose() }
      : handle !== undefined && typeof handle.dispose === 'function'
        ? function () { return handle.dispose() }
        : null
    if (dispose === null) {
      handles.delete(id)
      return 'missing'
    }
    try {
      await dispose()
      handles.delete(id)
      activations.delete(id)
      return 'released'
    } catch (error) {
      // Keep both registrations: a later release/sweep must be able to retry.
      return 'error'
    }
  }

  async function release(agentId) {
    if (agentId === undefined || agentId === null || String(agentId) === '') return false
    return (await disposeById(String(agentId))) === 'released'
  }

  function interruptQuietly(agentId) {
    if (typeof runtime.interrupt !== 'function') return false
    try {
      runtime.interrupt(String(agentId))
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Release every executor this card still has, by role/name, even when this
   * instance's handle map was lost (plugin reload / after a block).
   *
   * Sources are merged: recorded board ids (assignee, review/test delivery), the
   * process-wide receipts for the task, and the live agent tree's names. A child
   * found only in the tree has no disposal capability left; it is interrupted and
   * reported as "interrupted", never as released.
   */
  async function releaseTask(task, options) {
    const input = typeof task === 'string' ? { id: task } : task === undefined || task === null ? {} : task
    const taskId = input.id === undefined || input.id === null ? 'task' : String(input.id)
    const releaseOptions = options === undefined || options === null ? {} : options
    const roles = normaliseRoles(releaseOptions.roles)
    const found = new Map()
    const add = function (agentId, name, role, source) {
      const id = String(agentId === undefined || agentId === null ? '' : agentId)
      if (id === '') return
      const existing = found.get(id)
      if (existing !== undefined) {
        if (existing.sources.indexOf(source) < 0) existing.sources.push(source)
        if ((existing.role === null || existing.role === undefined) && role !== null && role !== undefined) existing.role = role
        if ((existing.name === null || existing.name === undefined) && name !== null && name !== undefined) existing.name = name
        return
      }
      found.set(id, { agentId: id, name: name === undefined ? null : name, role: role === undefined ? null : role, sources: [source] })
    }

    // 1) The board's own delivery records: exact ids, no name guessing.
    const assignee = input.assignee
    const review = input.review
    const test = input.test
    const recorded = {
      worker: assignee !== null && assignee !== undefined ? assignee.session : null,
      reviewer: review !== null && review !== undefined && review.deliveredTo !== null && review.deliveredTo !== undefined ? review.deliveredTo.id : null,
      tester: test !== null && test !== undefined && test.deliveredTo !== null && test.deliveredTo !== undefined ? test.deliveredTo.id : null,
    }
    for (const role of roles) {
      if (typeof recorded[role] === 'string' && recorded[role] !== '') add(recorded[role], null, role, 'record')
    }

    // 2) Disposal capabilities retained by this process for that exact card.
    //    When the caller names the card's root, receipts of another project's
    //    same-numbered card are not touched.
    const ownerSession = typeof input.ownerSession === 'string' && input.ownerSession !== '' ? input.ownerSession : null
    for (const receipt of activations.values()) {
      if (receipt.taskId !== taskId) continue
      if (ownerSession !== null && receipt.rootId !== null && receipt.rootId !== ownerSession) continue
      if (roles.indexOf(receipt.role) < 0) continue
      add(receipt.agentId, receipt.name, receipt.role, 'registry')
    }

    // 3) The live agent tree, which can also see children started before this
    //    module was loaded (they have a name but no receipt here).
    let rows = []
    try {
      rows = await runtime.list(releaseOptions.signal)
    } catch (error) {
      rows = []
    }
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row === null || row === undefined) continue
      const id = row.id !== undefined ? row.id : row.sessionId
      if (id === undefined || id === null || String(id) === '') continue
      const path = typeof row.path === 'string' && row.path !== '' ? row.path.split('/').pop() : null
      const name = typeof row.name === 'string' && row.name !== '' ? row.name : path
      const role = taskRoleOfAgentName(name, roles, taskId)
      if (role !== null) add(id, name, role, 'tree')
    }

    const released = []
    const interrupted = []
    const unresolved = []
    const failed = []
    for (const entry of found.values()) {
      if (roles.indexOf(entry.role) < 0 && entry.role !== null) continue
      const outcome = await disposeById(entry.agentId)
      if (outcome === 'released') {
        released.push(entry)
        continue
      }
      if (outcome === 'error') {
        failed.push(entry)
        continue
      }
      // No receipt and no handle in this process: disposal is not possible
      // anymore, so stop the running turn instead and say so.
      if (interruptQuietly(entry.agentId)) interrupted.push(entry)
      else unresolved.push(entry)
    }
    return {
      ok: failed.length === 0 && unresolved.length === 0,
      taskId: taskId,
      roles: roles,
      released: released,
      interrupted: interrupted,
      unresolved: unresolved,
      failed: failed,
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
    releaseTask: releaseTask,
    handleFor(agentId) { return handles.get(String(agentId)) || null },
    handles() { return Array.from(handles.keys()) },
  }
}
