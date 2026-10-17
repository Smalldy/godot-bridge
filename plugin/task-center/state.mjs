/**
 * The state the task center's surfaces share.
 *
 * One object owns the board (through the CAS storage layer) and the in-memory
 * file locks, so the tool, the HTTP route and the scheduler all see the same
 * truth. The only thing that differs between surfaces is who is calling.
 */

import { resolve } from 'node:path'
import { readBoard, updateBoard } from './board.mjs'
import { emptyLocks, expire as expireLocks } from './locks.mjs'

/**
 * @param ctx - the row's context; needs fs.
 * @param options.now - clock injection, for tests.
 * @param options.afterWrite - called after a board write lands; its result is
 *   not awaited, because a publish should not wait for a dispatch.
 */
export function createState(ctx, options) {
  const opts = options === undefined ? {} : options
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  const memory = { locks: emptyLocks(), projectHint: null }
  const afterWrite = typeof opts.afterWrite === 'function' ? opts.afterWrite : null

  /** Remember the project the panel and the scheduler should follow. */
  function noteProject(projectPath) {
    if (typeof projectPath === 'string' && projectPath.length > 0) memory.projectHint = resolve(projectPath)
  }

  async function read(projectPath) {
    const result = await readBoard({ fs: ctx.fs }, { projectPath: projectPath, now: clock() })
    if (result.ok === false) return { failed: result }
    return { failed: null, board: result.board, existed: result.existed }
  }

  /**
   * Apply a model function under the board's CAS.
   *
   * A refusal from the model aborts the write, so a refused action never touches
   * the file. On a lost version race the mutation runs again against freshly
   * read content.
   */
  async function apply(projectPath, mutate, sandboxPolicy) {
    let outcome = null
    const written = await updateBoard(
      { fs: ctx.fs },
      {
        projectPath: projectPath,
        sandboxPolicy: sandboxPolicy,
        now: clock(),
        mutate: function (board, attempt) {
          const result = mutate(board, attempt)
          outcome = result
          return result !== null && result !== undefined && result.ok === true ? result.board : undefined
        },
      },
    )
    if (outcome !== null && outcome.ok === false) return { failed: outcome }
    if (written.ok === false) return { failed: { ok: false, code: written.code, message: written.message } }
    if (afterWrite !== null) {
      try {
        const pending = afterWrite({ projectPath: projectPath, board: written.board, events: outcome === null ? [] : outcome.events })
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

  /** Reap expired file locks; returns the events for whoever asked. */
  function sweepLocks() {
    const result = expireLocks(memory.locks, clock())
    memory.locks = result.locks
    return result.expired
  }

  return {
    clock: clock,
    memory: memory,
    read: read,
    apply: apply,
    sweepLocks: sweepLocks,
    noteProject: noteProject,
  }
}

/** The sandbox policy a board write needs: the board sits inside the project,
 * which may lie outside the session workspace. */
export function writePolicyFor(projectPath) {
  return { mode: 'workspace-write', workspaceRoot: projectPath }
}
