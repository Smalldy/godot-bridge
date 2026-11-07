/**
 * Lifecycle actions: cancel / reopen / unblock / retry / block.
 *
 * Extracted from performResolved. The handlers still go through the API's
 * writeTask/mutate seam and release locks/interrupt/cleanup exactly as before;
 * only their routing moved.
 */
import * as locks from '../locks.mjs'

export function createLifecycleActions(deps) {
  const readBoardOrFail = deps.readBoardOrFail
  const model = deps.model
  const writeTask = deps.writeTask
  const clock = deps.clock
  const writeByName = deps.writeByName
  const state = deps.state
  const ctx = deps.ctx
  const interruptAssignee = deps.interruptAssignee
  const cleanupInvestigation = deps.cleanupInvestigation
  const failure = deps.failure

  async function cancel(source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', 'cancel needs a task id')
    // The pre-transition record still names the worker and its state: that is
    // what the interrupt needs after the board has moved on.
    const before = await readBoardOrFail(projectPath)
    const priorTask = before.failed === undefined ? model.findTask(before.board, id) : undefined
    const result = await writeTask(
      projectPath,
      id,
      (board) => model.cancelTask(board, id, clock(), context.by, source.note, writeByName(context)),
      context,
    )
    if (result.ok === true) {
      const released = locks.releaseTask(state.memory.locks, id)
      if (released.ok === true) state.memory.locks = released.locks
      if (priorTask !== undefined && priorTask !== null && priorTask.status === 'running') {
        // Best-effort: a refusal (no Team, idle member) never fails the cancel.
        await interruptAssignee(ctx, priorTask, { reason: 'cancelled' })
      }
      // T-131: a cancelled investigation's scratch checkout and probes are
      // disposable — remove them with the card.
      if (priorTask !== undefined && priorTask !== null) await cleanupInvestigation(projectPath, priorTask)
    }
    return result
  }

  async function transition(action, source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', action + ' needs a task id')
    const outcome = await writeTask(
      projectPath,
      id,
      (board) => {
        if (action === 'reopen') return model.reopenTask(board, id, clock(), context.by, source.note, writeByName(context))
        if (action === 'unblock') return model.unblockTask(board, id, clock(), context.by, source.note, writeByName(context))
        return model.retryTask(board, id, clock(), context.by, source.note, writeByName(context))
      },
      context,
    )
    // T-131: reopening/retrying an investigation starts over; its old scratch
    // checkout and probe-<id>-* siblings are discarded with the old report.
    if (outcome.ok === true && outcome.task !== null && outcome.task !== undefined && outcome.task.kind === 'investigate') {
      await cleanupInvestigation(projectPath, outcome.task)
    }
    return outcome
  }

  async function block(source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', 'block needs a task id')
    const before = await readBoardOrFail(projectPath)
    const priorTask = before.failed === undefined ? model.findTask(before.board, id) : undefined
    const result = await writeTask(
      projectPath,
      id,
      (board) => model.blockTask(board, id, clock(), context.by, source.note, writeByName(context)),
      context,
    )
    if (result.ok === true) {
      const released = locks.releaseTask(state.memory.locks, id)
      if (released.ok === true) state.memory.locks = released.locks
      if (priorTask !== undefined && priorTask !== null && priorTask.status === 'running') {
        await interruptAssignee(ctx, priorTask, { reason: 'blocked' })
      }
      // T-131: a blocked investigation's scratch checkout is disposable.
      if (priorTask !== undefined && priorTask !== null) await cleanupInvestigation(projectPath, priorTask)
    }
    return result
  }

  return {
    cancel: cancel,
    reopen: (source, context, projectPath) => transition('reopen', source, context, projectPath),
    unblock: (source, context, projectPath) => transition('unblock', source, context, projectPath),
    retry: (source, context, projectPath) => transition('retry', source, context, projectPath),
    block: block,
  }
}
