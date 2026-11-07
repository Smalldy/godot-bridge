/**
 * Merge request actions: mergeRequest / rejectMerge.
 *
 * refreshMerge still lives in api.mjs (it has the branch/diff/reviewer
 * orchestration); these two are the queue/record half and are extracted first.
 */
export function createMergeActions(deps) {
  const mergeRefusal = deps.mergeRefusal
  const mergeQueueKey = deps.mergeQueueKey
  const serialised = deps.serialised
  const mergeOne = deps.mergeOne
  const notifyMergeOutcome = deps.notifyMergeOutcome
  const readBoardOrFail = deps.readBoardOrFail
  const model = deps.model
  const writeTask = deps.writeTask
  const recordMergeResult = deps.recordMergeResult
  const clock = deps.clock
  const writeByName = deps.writeByName
  const emitActivity = deps.emitActivity
  const ok = deps.ok
  const failure = deps.failure

  async function mergeRequest(source, context, projectPath) {
    const denied = mergeRefusal(context)
    if (denied !== null) return denied
    const id = String(source.id !== undefined ? source.id : source.taskId === undefined ? '' : source.taskId)
    if (id === '') return failure('missing-id', 'mergeRequest needs a task id')
    // The whole pipeline (re-read, integrate, verify, record) runs inside the
    // queue so a second request sees the first one's result, never its state.
    const queueKey = await mergeQueueKey(projectPath, id)
    const result = await serialised((token) => mergeOne(projectPath, id, context.by, context, undefined, token), queueKey)
    // Notifications happen after the queue releases, and never change the answer.
    if (result.ok === true && result.task !== null && result.task !== undefined) {
      await notifyMergeOutcome(projectPath, result.task)
    }
    return result
  }

  async function rejectMerge(source, context, projectPath) {
    const denied = mergeRefusal(context)
    if (denied !== null) return denied
    const id = String(source.id !== undefined ? source.id : source.taskId === undefined ? '' : source.taskId)
    if (id === '') return failure('missing-id', 'rejectMerge needs a task id')
    return serialised(async function () {
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      const task = model.findTask(read.board, id)
      if (task === undefined) return failure('unknown-task', 'no task with id ' + id)
      if (task.status === 'pending' || task.status === 'running' || task.status === 'blocked' || task.status === 'cancelled') {
        return failure('not-mergeable-phase', id + ' is ' + task.status + '; only a submitted task has a merge request')
      }
      const merge = task.merge
      if (merge === null || merge === undefined || typeof merge !== 'object' || merge.status !== 'open') {
        return failure('no-open-merge', id + ' has no open merge request to reject')
      }
      const recorded = await writeTask(
        projectPath,
        id,
        (board) => recordMergeResult(board, id, { status: 'rejected' }, clock(), context.by, writeByName(context)),
        context,
      )
      if (recorded.ok !== true) return recorded
      emitActivity(context, 'merge', 'rejected', id)
      return ok({ task: recorded.task, events: recorded.events, merge: recorded.task === null ? null : recorded.task.merge })
    })
  }

  return { mergeRequest: mergeRequest, rejectMerge: rejectMerge }
}
