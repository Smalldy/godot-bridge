/**
 * The `task_center` tool: the agent-facing side of the board.
 *
 * A thin shell. Everything that decides is elsewhere: the rules are in
 * `service.mjs`, the storage discipline in `board.mjs`, and the state both
 * surfaces share in `state.mjs`. This module decides only three things — who is
 * calling, where the project is, and what the caller may do.
 *
 * WHAT THE AGENT MAY NOT DO is the important part of the contract. Two
 * authorisation points belong to the user — typing `/task` and releasing a draft
 * in the panel — and a third action, approval, is how the user accepts work. The
 * tool therefore has no working `publish`, no `complete` and no `set_status`:
 * asking for one is refused with the reason and the next step, rather than
 * quietly working because the model layer would allow it. An agent that could
 * release its own drafts would make the release queue decorative.
 *
 * The same actions ARE available to the user, through the panel's route, which
 * builds on the same state and the same model functions. Two surfaces, each
 * accepting what its caller is allowed to do.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createState, writePolicyFor } from './state.mjs'
import {
  acquireLock,
  agentView,
  blockedPaths,
  cancelReservation,
  claimTask,
  createTask,
  findTask,
  lockAt,
  lockedPaths,
  nextWinner,
  patchTask,
  releaseClaim,
  releaseLock,
  removeTask,
  reserveLock,
  setTaskStatus,
} from './service.mjs'

/** Actions that only read. Everything else is declared exclusive, because a
 * write is a read-modify-write of shared state and only an exact `true` is
 * treated as parallel-safe by the registry. */
export const READ_ACTIONS = ['board', 'show', 'locks', 'mine']

/** Actions the user owns. Each is refused with the reason and where to go.
 * The panel's route is where they actually work. */
export const USER_ONLY = {
  publish: 'Releasing a draft is the user\'s decision — ask them to release it in the task center panel.',
  unpublish: 'Withdrawing a task from the queue is the user\'s decision — ask them in the task center panel.',
  complete: 'Accepting work is the user\'s decision — move the task to review with `submit` and report instead.',
  approve: 'Accepting work is the user\'s decision — move the task to review with `submit` and report instead.',
  set_status: 'Status moves are named actions here (`start`, `submit`, `block`, `unblock`, `reopen`) so the legal ones are the only ones.',
  reorder: 'Queue order belongs to the user — ask them to reorder it in the task center panel.',
  force_unlock: 'Forcing a lock away from another agent is the user\'s call — report the block instead.',
}

/**
 * The agent's display label.
 *
 * The Agent interface exposed by the live `tools` service declares only `id`
 * (`interface Agent { readonly id: SessionId }`), so there is no name to show:
 * `@fixer` in the panel's mock is an Agent Teams name this layer cannot see. A
 * short, stable slice of the session id is the honest substitute, and the panel's
 * assignee field shows it as-is.
 */
export function agentLabel(agent) {
  const raw = agent === undefined || agent === null ? '' : String(agent.id === undefined ? agent.session : agent.id)
  const short = raw.replace(/^session-/, '').replace(/[^0-9a-zA-Z]/g, '').slice(0, 8)
  return short === '' ? '@unknown' : '@' + short
}

/**
 * The project the caller is working in, from the sandbox policy's session
 * workspace — the same source the tool row already uses for project paths.
 *
 * Every candidate is tried rather than one being trusted. The documented field is
 * `Agent.id`, while the earlier live digest test passed `agent.session` and
 * succeeded — but `resolve()` with nothing falls back to the ambient session, so
 * that test does not actually discriminate between the two, and a wrong guess here
 * would silently point the board at the wrong project. Returns `null` rather than
 * throwing so callers can answer with a sentence.
 */
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

/** A compact one-line rendering of a task, for list results. */
export function summaryOf(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee === null ? null : task.assignee.name,
    leaseExpired: task.leaseExpired === true,
    blockedBy: task.blockedBy,
  }
}

/**
 * The task-side actions, as a model mutation.
 *
 * Exported so the panel's route can map its own actions onto the very same model
 * calls, instead of a second copy of the rules drifting away from this one.
 * `by` is whoever is acting, and `allowRemove` decides whether the agent-side
 * restriction on deletion applies.
 */
export function taskMutator(action, args, id, by, agent, now, options) {
  const agentSide = options === undefined || options.allowRemove !== true
  return (board) => {
    if (action === 'update') {
      return patchTask(
        board,
        id,
        { title: args.title, spec: args.spec, acceptance: args.acceptance, evidence: args.evidence, planRef: args.planRef, note: args.note },
        now,
        by,
      )
    }
    if (action === 'claim') return claimTask(board, id, { name: by, session: agent === undefined ? null : String(agent.id) }, now)
    if (action === 'release') return releaseClaim(board, id, now, by)
    if (action === 'start') return setTaskStatus(board, id, 'in_progress', now, by, args.note)
    if (action === 'submit') {
      const withEvidence = args.evidence === undefined ? board : patchTask(board, id, { evidence: args.evidence }, now, by).board || board
      return setTaskStatus(withEvidence, id, 'review', now, by, args.note === undefined ? 'ready for review' : args.note)
    }
    if (action === 'block') return setTaskStatus(board, id, 'blocked', now, by, args.note)
    if (action === 'unblock') return setTaskStatus(board, id, 'in_progress', now, by, args.note)
    if (action === 'reopen') return setTaskStatus(board, id, 'in_progress', now, by, args.note)
    if (action === 'remove') {
      const task = findTask(board, id)
      if (task === undefined) return { ok: false, code: 'unknown-task', message: 'No task with id ' + id }
      if (agentSide && task.status !== 'draft' && task.status !== 'cancelled') {
        return {
          ok: false,
          code: 'not-a-draft',
          message: 'Only drafts and cancelled tasks can be removed by an agent; ask the user to delete ' + id,
        }
      }
      return removeTask(board, id)
    }
    return { ok: false, code: 'unknown-action', message: 'Unknown action ' + action }
  }
}

/**
 * Register the tool. Returns the registry's disposer.
 *
 * @param ctx - the row's context; needs `tools`, `fs`, `sandboxPolicy`.
 * @param options.state - the shared state, so this tool and the panel agree about
 *   the board and the locks. Built here when omitted, which keeps the tool usable
 *   on its own (and is what the tests do).
 */
export function registerTaskTool(ctx, options) {
  const state = options !== undefined && options.state !== undefined ? options.state : createState(ctx, options)
  const locks = () => state.memory.locks

  const tool = defineTool({
    name: 'task_center',
    description:
      'Read and work the project task board (.agents/tasks.json) and its file locks. Actions: `board` (the whole board), `mine` (your tasks and locks), `show` (one task), `locks` (who is writing what), `create` (draft; only the user releases drafts), `update`, `claim`, `release`, `start`, `submit`, `block`, `unblock`, `reopen`, `remove` (drafts only), `lock`, `reserve`, `unlock`, `cancel` (withdraw a reservation). Releasing drafts, approving work and reordering the queue belong to the user and are refused here.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'What to do.',
        enum: READ_ACTIONS.concat([
          'create',
          'update',
          'claim',
          'release',
          'start',
          'submit',
          'block',
          'unblock',
          'reopen',
          'remove',
          'lock',
          'reserve',
          'unlock',
          'cancel',
        ]).concat(Object.keys(USER_ONLY)),
      },
      id: { type: 'string', description: 'Task id, e.g. T-12.' },
      path: { type: 'string', description: 'Project-relative file path, for the lock actions.' },
      title: { type: 'string', description: 'Task title (create, update).' },
      spec: { type: 'string', description: 'What the task involves (create, update).' },
      acceptance: { type: 'string', description: 'How completion will be judged (create, update).' },
      evidence: { type: 'string', description: 'What you did and how you checked it (submit, update).' },
      note: { type: 'string', description: 'A line for the task timeline (update, block, submit).' },
      planRef: { type: 'string', description: 'Path of the task plan document, when one exists.' },
      proposalRef: { type: 'string', description: 'Path of the proposal this task came from (create).' },
      blockedBy: { type: 'array', description: 'Task ids this task waits on (block).', items: { type: 'string' } },
    },
    isConcurrencySafe: (args) => READ_ACTIONS.indexOf(args !== null && args !== undefined ? args.action : undefined) >= 0,
    output: {
      // `output` is required on a ToolDefinition. The result is JSON with no
      // custom card, so it renders as text exactly as the tool row's does.
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async function (args, exec) {
      const action = String(args.action || '')
      const agent = exec === undefined ? undefined : exec.agent
      const me = agentLabel(agent)
      const projectPath = projectPathOf(ctx, agent)
      if (projectPath === null) {
        return { error: 'The project directory is unknown, so the task board cannot be located. Report this to the user.' }
      }
      // The panel is not session-bound, so it learns the project from the calls
      // that do resolve one.
      state.noteProject(projectPath)
      // The board lives inside the project, which may sit outside the session
      // workspace, so the write policy is widened to the project root exactly as
      // the tool row does for project files — and only for this write.
      const sandboxPolicy = writePolicyFor(projectPath)
      if (Object.prototype.hasOwnProperty.call(USER_ONLY, action)) {
        return { refused: action, reason: USER_ONLY[action] }
      }
      const expired = state.sweep()
      const now = state.clock()
      const withExpired = (value) => (expired.length === 0 ? value : Object.assign({}, value, { leasesReaped: expired }))

      if (action === 'board') {
        const current = await state.read(projectPath)
        if (current.failed !== null) return { error: current.failed.message, code: current.failed.code }
        const tasks = current.board.tasks
        const by = (status) => tasks.filter((task) => task.status === status)
        return withExpired({
          board: current.existed ? '.agents/tasks.json' : 'not created yet',
          total: tasks.length,
          counts: {
            draft: by('draft').length,
            queued: by('queued').length,
            claimed: by('claimed').length + by('in_progress').length,
            blocked: by('blocked').length,
            review: by('review').length,
            done: by('done').length,
            cancelled: by('cancelled').length,
          },
          queue: by('queued')
            .sort((a, b) => a.order - b.order)
            .map(summaryOf),
          review: by('review').map(summaryOf),
          yours: tasks.filter((task) => task.assignee !== null && task.assignee.name === me).map(summaryOf),
          locks: agentView(locks(), me),
        })
      }

      if (action === 'show') {
        const current = await state.read(projectPath)
        if (current.failed !== null) return { error: current.failed.message, code: current.failed.code }
        const task = findTask(current.board, String(args.id || ''))
        if (task === undefined) return { error: 'No task with id ' + String(args.id) }
        return withExpired({ task: task })
      }

      if (action === 'locks') {
        const holder = args.path === undefined ? null : lockAt(locks(), String(args.path))
        return withExpired({
          you: agentView(locks(), me),
          blockedPaths: blockedPaths(locks(), me),
          files: lockedPaths(locks()).map((path) => {
            const lock = lockAt(locks(), path)
            const winner = nextWinner(locks(), path)
            return {
              path: path,
              holder: lock.holder,
              taskId: lock.taskId,
              since: lock.since,
              leaseUntil: lock.leaseUntil,
              waiters: lock.queue.map((entry) => entry.who),
              next: winner === null ? null : winner.who,
            }
          }),
          path: holder === null ? null : holder,
        })
      }

      if (action === 'mine') {
        const current = await state.read(projectPath)
        if (current.failed !== null) return { error: current.failed.message, code: current.failed.code }
        return withExpired({
          tasks: current.board.tasks.filter((task) => task.assignee !== null && task.assignee.name === me).map(summaryOf),
          locks: agentView(locks(), me),
        })
      }

      // ── writes ───────────────────────────────────────────────────────────
      if (action === 'create') {
        const applied = await state.apply(
          projectPath,
          (board) =>
            createTask(
              board,
              {
                title: args.title,
                spec: args.spec,
                acceptance: args.acceptance,
                planRef: args.planRef,
                proposalRef: args.proposalRef,
                note: args.note === undefined ? 'created by ' + me : args.note,
              },
              now,
              me,
            ),
          sandboxPolicy,
        )
        if (applied.failed !== null) return { error: applied.failed.message, code: applied.failed.code }
        return withExpired({
          created: summaryOf(applied.board.tasks[applied.board.tasks.length - 1]),
          drafts: applied.board.tasks.filter((task) => task.status === 'draft').length,
          hint: 'Drafts reach the queue only when the user releases them in the task center panel.',
        })
      }

      if (action === 'lock' || action === 'reserve') {
        const path = String(args.path || '')
        if (path === '') return { error: 'A path is required for ' + action }
        const call = action === 'lock' ? acquireLock : reserveLock
        const result = call(locks(), path, me, args.id === undefined ? null : String(args.id), now)
        state.memory.locks = result.locks
        if (result.granted === true) return withExpired({ granted: true, path: path })
        const lock = lockAt(locks(), path)
        const winner = nextWinner(locks(), path)
        return withExpired({
          granted: false,
          path: path,
          holder: lock.holder,
          position: result.position,
          next: winner === null ? null : winner.who,
          hint: 'You do not hold ' + path + '. Do not write it; wait, or pick something else and tell the user.',
        })
      }

      if (action === 'unlock') {
        const path = String(args.path || '')
        const result = releaseLock(locks(), path, me, now)
        if (result.ok === false) return { refused: result.code, reason: result.message }
        state.memory.locks = result.locks
        return withExpired({ released: path, grantedTo: result.grantedTo })
      }

      if (action === 'cancel') {
        const path = String(args.path || '')
        const result = cancelReservation(locks(), path, me)
        if (result.ok === false) return { refused: result.code, reason: result.message }
        state.memory.locks = result.locks
        return withExpired({ withdrawn: path })
      }

      const id = String(args.id || '')
      if (id === '') return { error: 'A task id is required for ' + action }
      const applied = await state.apply(projectPath, taskMutator(action, args, id, me, agent, now), sandboxPolicy)
      if (applied.failed !== null) return { error: applied.failed.message, code: applied.failed.code }
      const task = findTask(applied.board, id)
      return withExpired({
        task: task === undefined ? null : task,
        events: applied.events.map((event) => event.kind),
        boardAttempts: applied.attempts,
      })
    },
  })

  return ctx.tools.register(tool)
}
