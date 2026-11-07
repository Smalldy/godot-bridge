/**
 * Test verdict actions: passTest / failTest.
 *
 * Extracted from performResolved. Keeps the same verdict gate, candidate
 * merge/discard, tester delivery, timeout and test-stage cleanup semantics.
 */
export function createTestVerdictActions(deps) {
  const verdictRefusal = deps.verdictRefusal
  const readBoardOrFail = deps.readBoardOrFail
  const model = deps.model
  const writeTask = deps.writeTask
  const clock = deps.clock
  const writeByName = deps.writeByName
  const promoteStageSlots = deps.promoteStageSlots
  const roleSlotNameOf = deps.roleSlotNameOf
  const state = deps.state
  const testerBriefFor = deps.testerBriefFor
  const godotInfoFor = deps.godotInfoFor
  const notifyMember = deps.notifyMember
  const recordDeliveredTo = deps.recordDeliveredTo
  const emitActivity = deps.emitActivity
  const recordStageSlot = deps.recordStageSlot
  const ctx = deps.ctx
  const candidateWorkflow = deps.candidateWorkflow
  const normaliseVerify = deps.normaliseVerify
  const VERIFY_DEFAULT_TIMEOUT_MS = deps.VERIFY_DEFAULT_TIMEOUT_MS
  const boundedAwait = deps.boundedAwait
  const mergeTestedCandidate = deps.mergeTestedCandidate
  const actionTimeoutMs = deps.actionTimeoutMs
  const actionTimeoutFailure = deps.actionTimeoutFailure
  const merger = deps.merger
  const worktreeRootOf = deps.worktreeRootOf
  const serialised = deps.serialised
  const testFailureBriefFor = deps.testFailureBriefFor
  const ok = deps.ok
  const failure = deps.failure

  async function run(action, source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', action + ' needs a task id')
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const testTask = model.findTask(read.board, id)
    if (testTask === undefined) return failure('unknown-task', 'no task with id ' + id)
    const testRefused = verdictRefusal(context, testTask, 'tester')
    if (testRefused !== null) return testRefused
    const result = await writeTask(
      projectPath,
      id,
      (board) => {
        const decided =
          action === 'passTest'
            ? model.passTest(board, id, clock(), context.by, writeByName(context))
            : model.failTest(board, id, source.evidence, clock(), context.by, writeByName(context))
        if (decided.ok !== true) return decided
        if (action === 'passTest' && source.evidence !== undefined && source.evidence !== null) {
          const text = String(source.evidence).trim()
          const task = model.findTask(decided.board, id)
          if (task !== null && task !== undefined && task.test !== null && task.test !== undefined && text !== '') {
            task.test.evidence = text
          }
        }
        return decided
      },
      context,
    )
    if (result.ok !== true) return result
    const hasCandidate =
      result.task !== null &&
      result.task !== undefined &&
      result.task.merge !== null &&
      result.task.merge !== undefined &&
      typeof result.task.merge.mergeCommit === 'string' &&
      result.task.merge.mergeCommit.length > 0
    // Keep the tester delivery timestamp for the finished round's duration.
    const promotedTest = await promoteStageSlots(projectPath, 'tester')
    if (promotedTest.length > 0) {
      const testerSlot = roleSlotNameOf('tester', result.task.ownerSession)
      if (testerSlot !== null) {
        for (const promoted of promotedTest) {
          const stored = state.memory.testCandidates === undefined || state.memory.testCandidates === null ? null : state.memory.testCandidates[promoted.id]
          const storedCandidate = stored !== null && stored !== undefined && stored.candidate !== undefined ? stored.candidate : null
          const storedHostCheck = stored !== null && stored !== undefined && stored.hostCheck !== undefined ? stored.hostCheck : null
          const fallbackPath = stored !== null && stored !== undefined && typeof stored === 'string' ? stored : null
          const candidateForBrief = storedCandidate !== null ? storedCandidate : fallbackPath === null ? null : { path: fallbackPath }
          if (candidateForBrief === null || typeof candidateForBrief.path !== 'string' || candidateForBrief.path === '') continue
          const sentTo = await notifyMember(
            testerSlot,
            testerBriefFor(promoted, projectPath, candidateForBrief, {
              godot: await godotInfoFor(projectPath, candidateForBrief.path),
              hostCheck: storedHostCheck,
            }),
            promoted.ownerSession,
            projectPath,
          )
          await recordDeliveredTo(projectPath, promoted.id, 'tester', sentTo)
        }
      }
    }
    if (action === 'passTest') emitActivity(context, 'test-end', 'passed', id)
    if (action === 'failTest') emitActivity(context, 'test-end', 'failed', id)
    // failTest returns the card to running and passTest ends the stage: the
    // test queue record is spent either way and must not leak to the next round.
    if (action === 'failTest' || action === 'passTest') recordStageSlot(ctx, id, 'tester', null, null)
    if (action === 'passTest' && candidateWorkflow && hasCandidate) {
      // The tester accepted the candidate: the host merges that exact tree now
      // (no separate verify). A moved target comes back as a retest. The merge
      // itself is bounded: a stuck queue must not hold this action forever.
      const mergeStarted = Date.now()
      const passVerify = normaliseVerify(result.task === null || result.task === undefined ? null : result.task.verify)
      const passVerifyBudget = passVerify !== null && Number.isFinite(passVerify.timeoutMs) ? passVerify.timeoutMs : VERIFY_DEFAULT_TIMEOUT_MS
      const boundedMerge = await boundedAwait(
        () => mergeTestedCandidate(projectPath, id, context.by, context),
        actionTimeoutMs + passVerifyBudget + 60 * 1000,
      )
      if (boundedMerge.timedOut === true) {
        const timedOutFailure = actionTimeoutFailure('passTest merge candidate', id, mergeStarted)
        return ok({ task: result.task, events: result.events, mergeError: timedOutFailure })
      }
      const merged = boundedMerge.value
      if (merged.ok === true) return merged
      // The pass is recorded; a transient merge failure is retried by the sweep.
      return ok({ task: result.task, events: result.events, mergeError: merged })
    }
    if (action === 'failTest' && candidateWorkflow && hasCandidate) {
      const discardStarted = Date.now()
      const boundedDiscard = await boundedAwait(
        () => serialised(() => merger.discardCandidate(result.task, projectPath, { worktreeRoot: worktreeRootOf(read.board) })),
        actionTimeoutMs,
      )
      if (boundedDiscard.timedOut === true) actionTimeoutFailure('failTest discard candidate', id, discardStarted)
      emitActivity(null, 'worktree-remove', 'test candidate discarded after a failed test', id, 'host')
      const owner =
        result.task.assignee === null || result.task.assignee === undefined || typeof result.task.assignee.name !== 'string'
          ? null
          : result.task.assignee.name
      if (owner !== null) await notifyMember(owner, testFailureBriefFor(result.task, projectPath), result.task.ownerSession, projectPath)
    }
    return ok({ task: result.task, events: result.events })
  }

  return {
    passTest: (source, context, projectPath) => run('passTest', source, context, projectPath),
    failTest: (source, context, projectPath) => run('failTest', source, context, projectPath),
  }
}
