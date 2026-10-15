/**
 * The state the task center's two surfaces share.
 *
 * There are two callers — the `task_center` tool (the agent) and the panel's HTTP
 * route (the user) — and they MUST agree, in two specific ways:
 *
 * 1. The lock memory is one instance. Locks live in host memory and never on disk,
 *    so two copies would mean an agent and the user each seeing half the truth,
 *    with two agents both believing they hold the same file.
 * 2. The board is reached the same way: the same CAS discipline, the same
 *    "a refusal aborts the write" convention, the same sandbox policy.
 *
 * Both surfaces build on this object, so the only thing that differs between them
 * is which actions they are willing to accept — which belongs to the surface, not
 * here.
 */

import { readBoard, updateBoard } from './board.mjs'
import { emptyLocks, expireLocks } from './service.mjs'

/**
 * @param ctx - the row's context; needs `fs`.
 * @param options.now - clock injection, for tests.
 */
export function createState(ctx, options) {
  const clock = options !== undefined && typeof options.now === 'function' ? options.now : Date.now
  const memory = { locks: emptyLocks(), projectHint: null }
  /** Told AFTER a board write lands, so the pool can react to it. Publishing a task
   * is a board write, and that write is the event that should start the work — which
   * is why this hook lives here rather than in whichever route happened to publish. */
  const afterWrite = options !== undefined && typeof options.afterWrite === 'function' ? options.afterWrite : null

  /**
   * Remember which project the agents are working on.
   *
   * The panel is not session-bound (its slot receives no Session binding) but the
   * board is per-project, so the route has to learn the project from somewhere.
   * Whoever resolves one — the tool on a call, the digest on `/task` — records it
   * here, which makes the panel follow the work instead of asking to be told.
   */
  function noteProject(projectPath) {
    if (typeof projectPath === 'string' && projectPath.length > 0) memory.projectHint = projectPath
  }

  /** Read the board; `{ failed }` carries the model's own refusal shape. */
  async function read(projectPath) {
    const result = await readBoard({ fs: ctx.fs }, { projectPath: projectPath })
    if (result.ok === false) return { failed: result }
    return { failed: null, board: result.board, existed: result.existed }
  }

  /**
   * Apply a model function under the board's CAS.
   *
   * A refusal from the model aborts the write by returning `undefined` — the board
   * module's own "abandon this update" convention — so a refused action never
   * touches the file. On a lost version race the function runs again against
   * freshly read content, which is why the outcome is reassigned rather than
   * captured once.
   */
  async function apply(projectPath, mutate, sandboxPolicy) {
    let outcome = null
    const written = await updateBoard(
      { fs: ctx.fs },
      {
        projectPath: projectPath,
        sandboxPolicy: sandboxPolicy,
        mutate: function (board, attempt) {
          const result = mutate(board, attempt)
          outcome = result
          return result !== null && result.ok === true ? result.board : undefined
        },
      },
    )
    if (outcome !== null && outcome.ok === false) return { failed: outcome }
    if (written.ok === false) return { failed: { ok: false, code: written.code, message: written.message } }
    if (afterWrite !== null) {
      // Deliberately NOT awaited. The write has landed; whoever asked for it should
      // get their answer, and a dispatch that fails must not fail their publish.
      try {
        const pending = afterWrite({ projectPath: projectPath, board: written.board })
        if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(function () {})
      } catch (error) {}
    }
    return {
      failed: null,
      board: written.board,
      version: written.version,
      attempts: written.attempts,
      events: outcome === null ? [] : outcome.events,
    }
  }

  /**
   * Reap what is due and report it. Targeted notification to a holder is task 8:
   * this can only tell whoever's call triggered the sweep.
   *
   * `alive` is left out deliberately — there is no liveness oracle here yet, so the
   * lease is the only thing that frees a lock.
   */
  function sweep() {
    const result = expireLocks(memory.locks, clock(), null)
    memory.locks = result.locks
    return result.events
  }

  return { clock: clock, memory: memory, read: read, apply: apply, sweep: sweep, noteProject: noteProject }
}

/** The sandbox policy a board write needs: the board sits inside the project,
 * which may lie outside the session workspace. Built by the caller from the
 * resolved project path so the widening is visible at the call site. */
export function writePolicyFor(projectPath) {
  return { mode: 'workspace-write', workspaceRoot: projectPath }
}
