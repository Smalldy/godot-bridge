/**
 * Read-side actions (board/list/get/locks).
 *
 * Extracted from the performResolved if-chain. The factory receives the API's
 * helpers, so the handlers keep the exact same board/read/lock semantics while
 * the action table can route to them by name.
 *
 * T-230: `list` no longer builds its own card view from the model. It asks the
 * API's read model, which is the SAME builder and the SAME per-request view
 * /state.tasks, /list and the tool list use — a tool reader and the panel now
 * read one TaskSummary, not two vocabularies.
 *
 * T-231 (Phase 1): one read contract per read action, whatever the caller:
 *
 *   board   a TaskSummary PAGE (`view:'summary'`, the default, with limit/cursor)
 *           plus the board facts (counts/dispatch/locks/seq); `view:'full'` is
 *           the explicit diagnostic escape hatch that keeps the old snapshot.
 *   list    literally the /list handler (taskList): { tasks, nextCursor, count },
 *           so the tool and the drawer page one list with one cursor.
 *   get     unchanged: the ONE detail entry.
 */
export function createReadActions(deps) {
  const snapshot = deps.snapshot
  const readBoardOrFail = deps.readBoardOrFail
  const state = deps.state
  const locks = deps.locks
  const model = deps.model
  const archivedTask = deps.archivedTask
  const detailOf = deps.detailOf
  const candidateOf = deps.candidateOf
  const taskList = deps.taskList
  const boardPage = deps.boardPage
  const callerSessionId = deps.callerSessionId
  const ok = deps.ok
  const failure = deps.failure

  async function board(source, context, projectPath) {
    const input = source === undefined || source === null ? {} : source
    // T-231: the explicit escape hatch keeps the diagnostic snapshot (detail
    // cards + host inventory). It is NOT the default read: the full answer was
    // 4.85 MB on a 221-card board and the model rarely needs it.
    if (input.view === 'full') return snapshot(projectPath, { sessionId: callerSessionId(source, context) })
    // The default read is a page of TaskSummary cards + the board facts.
    return boardPage(projectPath, { limit: input.limit, cursor: input.cursor })
  }

  async function locksAction(source, context, projectPath, now) {
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    state.sweepLocks()
    return ok({ locks: locks.view(state.memory.locks, read.board, now) })
  }

  async function list(source, context, projectPath, now) {
    const input = source === undefined || source === null ? {} : source
    // T-231: the tool list IS /list — q/status/cursor/limit/archived and the
    // { tasks, nextCursor, count } page. Reusing the route's handler is what
    // makes "same shape" true by construction instead of by convention.
    return taskList(projectPath, {
      status: input.status,
      cursor: input.cursor,
      limit: input.limit,
      q: input.q,
      archived: input.archived === true || input.archived === 'true' || input.archived === 1,
    })
  }

  async function get(source, context, projectPath, now) {
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const id = String(source.id === undefined ? '' : source.id)
    const task = model.findTask(read.board, id)
    if (task === undefined) {
      const archived = await archivedTask(projectPath, id, now)
      if (archived !== null) return ok({ task: archived, locks: [] })
      return failure('unknown-task', 'no task with id ' + id)
    }
    return ok({
      task: Object.assign(detailOf(read.board, task, now), { candidate: candidateOf(projectPath, read.board, task) }),
      locks: locks.view(state.memory.locks, read.board, now).filter((lock) => lock.taskId === task.id),
    })
  }

  return { board: board, list: list, get: get, locks: locksAction }
}
