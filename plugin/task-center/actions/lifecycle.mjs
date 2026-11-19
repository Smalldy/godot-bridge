/**
 * Lifecycle actions: cancel / reopen / unblock / retry / block.
 *
 * Extracted from performResolved. The handlers still go through the API's
 * writeTask/mutate seam and release locks/interrupt/cleanup exactly as before;
 * only their routing moved.
 *
 * T-183: leaving a running/reviewing/testing state must also DISPOSE the card's
 * stage children. Interrupting the worker alone left reviewer/tester children
 * alive (their handle map can be gone after a reload), which is exactly how a
 * card became pending/blocked while its reviewer kept running for hours.
 */
import * as locks from '../locks.mjs'

const ALL_ROLES = Object.freeze(['worker', 'reviewer', 'tester'])

export function createLifecycleActions(deps) {
  const readBoardOrFail = deps.readBoardOrFail
  const model = deps.model
  const writeTask = deps.writeTask
  const clock = deps.clock
  const writeByName = deps.writeByName
  const state = deps.state
  const ctx = deps.ctx
  const cleanupInvestigation = deps.cleanupInvestigation
  const failure = deps.failure
  const stageAgents = deps.stageAgents === undefined ? null : deps.stageAgents
  // T-201: the takeover's stage provisioning, reused to resume an unblocked
  // reviewing/testing card. Optional so a unit harness can omit it.
  const redeliverStage = deps.redeliverStage === undefined ? null : deps.redeliverStage

  /**
   * Dispose every worker/reviewer/tester the card still owns, by board record and
   * by the name the agent tree reports. Best-effort on purpose: a missing agent
   * runtime must never turn a lifecycle transition into a failure.
   */
  /** T-201: the actor the state machine proves for a lifecycle transition. */
  function actorOf(context) {
    return context !== undefined && context !== null && context.role === 'user' ? 'user' : 'worker'
  }

  async function releaseStageRoster(task, reason) {
    if (stageAgents === null || task === null || task === undefined) return null
    if (typeof stageAgents.releaseTask !== 'function') return null
    try {
      return await stageAgents.releaseTask(task, { roles: ALL_ROLES, reason: reason })
    } catch (error) {
      return null
    }
  }

  async function cancel(source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', 'cancel needs a task id')
    // The pre-transition record still names the worker and its state: that is
    // what the interrupt and stage release need after the board has moved on.
    const before = await readBoardOrFail(projectPath)
    const priorTask = before.failed === undefined ? model.findTask(before.board, id) : undefined
    const result = await writeTask(
      projectPath,
      id,
      (board) => model.cancelTask(board, id, clock(), context.by, source.note, writeByName(context), { actor: actorOf(context) }),
      context,
    )
    if (result.ok === true) {
      const released = locks.releaseTask(state.memory.locks, id)
      if (released.ok === true) state.memory.locks = released.locks
      // T-183: dispose the worker/reviewer/tester of the card as one set.
      await releaseStageRoster(priorTask, 'cancelled')
      // T-131: a cancelled investigation's scratch checkout and probes are
      // disposable — remove them with the card.
      if (priorTask !== undefined && priorTask !== null) await cleanupInvestigation(projectPath, priorTask)
    }
    return result
  }

  /**
   * T-201 T28: a stage-paused card resumes the round it paused in. block already
   * disposed the old reviewer/tester and T28 clears the claim, so without a
   * fresh delivery the restored round has a pending record and no executor —
   * no agent could ever deliver its verdict. Provision it exactly like a
   * takeover re-delivers an open round (the structured record is untouched).
   */
  async function reprovisionRestoredStage(id, projectPath, outcome) {
    if (redeliverStage === null || outcome.task === null || outcome.task === undefined) return null
    const kind = outcome.task.status === 'reviewing' ? 'reviewer' : outcome.task.status === 'testing' ? 'tester' : null
    if (kind === null) return null
    const after = await readBoardOrFail(projectPath)
    if (after.failed !== undefined) return null
    const task = model.findTask(after.board, id)
    if (task === undefined || task === null) return null
    const stage = await redeliverStage(kind, projectPath, after.board, task)
    if (stage !== null && stage !== undefined) outcome.stage = stage
    return stage
  }

  async function transition(action, source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', action + ' needs a task id')
    // reopen/unblock/retry clears review/test/assignee on the board, so the
    // pre-transition record is the only place the stage children are named.
    const before = await readBoardOrFail(projectPath)
    const priorTask = before.failed === undefined ? model.findTask(before.board, id) : undefined
    const outcome = await writeTask(
      projectPath,
      id,
      (board) => {
        if (action === 'reopen') return model.reopenTask(board, id, clock(), context.by, source.note, writeByName(context), { actor: actorOf(context) })
        if (action === 'unblock') return model.unblockTask(board, id, clock(), context.by, source.note, writeByName(context), { actor: actorOf(context) })
        return model.retryTask(board, id, clock(), context.by, source.note, writeByName(context), { actor: actorOf(context) })
      },
      context,
    )
    if (outcome.ok === true) {
      // T-183: a reopen/retry starts a new generation; the previous worker,
      // reviewer and tester must not survive into it.
      await releaseStageRoster(priorTask, action === 'reopen' ? 'reopened' : action === 'unblock' ? 'unblocked' : 'retried')
      // T-201: unblock resumes the paused round, so it must be handed to a live
      // reviewer/tester again (reopen/retry go back to the pool and do not).
      if (action === 'unblock') await reprovisionRestoredStage(id, projectPath, outcome)
      // T-131: reopening/retrying an investigation starts over; its old scratch
      // checkout and probe-<id>-* siblings are discarded with the old report.
      if (outcome.task !== null && outcome.task !== undefined && outcome.task.kind === 'investigate') {
        await cleanupInvestigation(projectPath, outcome.task)
      }
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
      (board) =>
        model.blockTask(board, id, clock(), context.by, source.note, writeByName(context), {
          actor: actorOf(context),
          reason: source.reason === undefined ? null : source.reason,
        }),
      context,
    )
    if (result.ok === true) {
      const released = locks.releaseTask(state.memory.locks, id)
      if (released.ok === true) state.memory.locks = released.locks
      // T-183: block can interrupt a card in reviewing/testing too; dispose every
      // stage child so no reviewer/tester keeps running behind a blocked card.
      await releaseStageRoster(priorTask, 'blocked')
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
