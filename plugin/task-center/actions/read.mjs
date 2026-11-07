/**
 * Read-side actions (board/list/get/locks).
 *
 * Extracted from the performResolved if-chain. The factory receives the API's
 * helpers, so the handlers keep the exact same board/read/lock semantics while
 * the action table can route to them by name.
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
  const callerSessionId = deps.callerSessionId
  const ok = deps.ok
  const failure = deps.failure

  async function board(source, context, projectPath) {
    return snapshot(projectPath, { sessionId: callerSessionId(source, context) })
  }

  async function locksAction(source, context, projectPath, now) {
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    state.sweepLocks()
    return ok({ locks: locks.view(state.memory.locks, read.board, now) })
  }

  async function list(source, context, projectPath, now) {
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const status = typeof source.status === 'string' ? source.status : null
    const tasks = read.board.tasks
      .filter((task) => status === null || task.status === status)
      .map((task) => model.summary(read.board, task, now))
    return ok({ tasks: tasks, counts: model.counts(read.board) })
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
