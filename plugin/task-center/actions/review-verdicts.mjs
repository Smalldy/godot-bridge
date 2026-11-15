/**
 * Review verdict actions: approveReview / requestChanges.
 *
 * Extracted from performResolved. Keeps the same reviewer gate, candidate
 * build/conflict/rebuild, host mechanical check, tester delivery, stage-slot
 * promotion and rework-brief semantics.
 */
export function createReviewVerdictActions(deps) {
  const verdictRefusal = deps.verdictRefusal
  const readBoardOrFail = deps.readBoardOrFail
  const model = deps.model
  const writeTask = deps.writeTask
  const clock = deps.clock
  const writeByName = deps.writeByName
  const candidateWorkflow = deps.candidateWorkflow
  const boundedAwait = deps.boundedAwait
  const serialised = deps.serialised
  const merger = deps.merger
  const worktreeRootOf = deps.worktreeRootOf
  const actionTimeoutMs = deps.actionTimeoutMs
  const actionTimeoutFailure = deps.actionTimeoutFailure
  const branchBehind = deps.branchBehind
  const rebaseDetail = deps.rebaseDetail
  const markWaiting = deps.markWaiting
  const setRebuildAttempts = deps.setRebuildAttempts
  const normaliseVerify = deps.normaliseVerify
  const runHostCheck = deps.runHostCheck
  // T-156: the verify fingerprint of THIS round, recorded with the candidate.
  const verifyFingerprintFor = deps.verifyFingerprintFor
  const ctx = deps.ctx
  const hostCheckEvidence = deps.hostCheckEvidence
  const recordCandidate = deps.recordCandidate
  const emitActivity = deps.emitActivity
  const clearStageSlots = deps.clearStageSlots
  const notifyMember = deps.notifyMember
  const reworkBriefFor = deps.reworkBriefFor
  const provisionRole = deps.provisionRole
  const stageAgents = deps.stageAgents === undefined ? null : deps.stageAgents
  const provisionFailedHard = deps.provisionFailedHard
  const provisionReasonOf = deps.provisionReasonOf
  const state = deps.state
  const roleSlotNameOf = deps.roleSlotNameOf
  const assignStageSlot = deps.assignStageSlot
  const testerBriefFor = deps.testerBriefFor
  const godotInfoFor = deps.godotInfoFor
  const recordDeliveredTo = deps.recordDeliveredTo
  const promoteStageSlots = deps.promoteStageSlots
  const reviewBriefFor = deps.reviewBriefFor
  const ok = deps.ok
  const failure = deps.failure

  /** T-185: the Agent id that is waiting for this action's tool result. */
  function callerAgentIdOf(context) {
    if (context === undefined || context === null) return null
    if (typeof context.callerAgentId === 'string' && context.callerAgentId !== '') return context.callerAgentId
    const agent = context.agent
    if (agent !== null && agent !== undefined) {
      if (typeof agent.id === 'string' && agent.id !== '') return agent.id
      if (typeof agent.session === 'string' && agent.session !== '') return agent.session
    }
    return typeof context.sessionId === 'string' && context.sessionId !== '' ? context.sessionId : null
  }

  /**
   * T-183: release a stage child by the card's record AND by the name the live
   * agent tree reports, so a verdict still disposes the reviewer after a plugin
   * reload (the per-root handle map is gone but the child is not).
   *
   * T-185: the caller is excluded from the immediate release. A verdict runs
   * inside the reviewer's own turn; disposing that activation here would kill the
   * turn before its tool result is delivered and leave a running zombie. The
   * stage service queues the caller for the reconciler instead.
   */
  async function releaseStageRoster(task, roles, context) {
    if (stageAgents === null || task === null || task === undefined) return null
    if (typeof stageAgents.releaseTask !== 'function') return null
    try {
      return await stageAgents.releaseTask(task, { roles: roles, callerAgentId: callerAgentIdOf(context) })
    } catch (error) {
      return null
    }
  }

  async function run(action, source, context, projectPath) {
    try {
      return await execute(action, source, context, projectPath)
    } finally {
      // T-185 review round 1: the bounded wait of a queued self-release starts
      // only here. Until the action has returned, the reviewer that called it is
      // still in flight and must never be interrupted or disposed.
      try {
        if (stageAgents !== null && typeof stageAgents.markCallerReturned === 'function') {
          stageAgents.markCallerReturned(callerAgentIdOf(context))
        }
      } catch (error) {}
    }
  }

  async function execute(action, source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', action + ' needs a task id')
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const reviewTask = model.findTask(read.board, id)
    if (reviewTask === undefined) return failure('unknown-task', 'no task with id ' + id)
    const reviewRefused = verdictRefusal(context, reviewTask, 'reviewer')
    if (reviewRefused !== null) return reviewRefused
    // Build the independent test candidate BEFORE the phase moves: a conflict
    // is a readable refusal and the task stays in review for a changes request.
    let candidate = null
    if (action === 'approveReview' && candidateWorkflow) {
      const candidateStarted = Date.now()
      const boundedCandidate = await boundedAwait(
        () => serialised(() => merger.createCandidate(reviewTask, projectPath, { worktreeRoot: worktreeRootOf(read.board) })),
        actionTimeoutMs,
      )
      if (boundedCandidate.timedOut === true) {
        // No board write happened, so the task stays in review and the action
        // can simply be retried (the orphan candidate, if any, is discardable).
        return actionTimeoutFailure('approveReview createCandidate', id, candidateStarted)
      }
      candidate = boundedCandidate.value
      if (candidate === null || candidate === undefined || candidate.ok !== true) {
        if (candidate !== null && candidate !== undefined && candidate.code === 'candidate-conflict') {
          // A behind branch can never rebuild cleanly: say "rebase" on the FIRST
          // conflict. Otherwise downgrade to candidate-stale with the conflicted
          // files and let the sweep rebuild (counting the attempt on the card).
          const files = typeof candidate.conflict === 'string' && candidate.conflict !== '' ? candidate.conflict : String(candidate.message)
          const ancestry = await branchBehind(projectPath, reviewTask)
          if (ancestry.behind === true) {
            const detail = rebaseDetail(reviewTask, ancestry, files)
            await markWaiting(projectPath, id, 'needs-rebase', detail, context)
            return failure('needs-rebase', detail)
          }
          const prior = reviewTask.merge !== null && reviewTask.merge !== undefined && Number.isFinite(reviewTask.merge.rebuildAttempts) ? reviewTask.merge.rebuildAttempts : 0
          await setRebuildAttempts(projectPath, id, Math.min(10, prior + 1), context)
          await markWaiting(projectPath, id, 'candidate-stale', files, context)
          return failure('candidate-stale', 'the test candidate conflicts with the target (' + files + '); the card is marked candidate-stale and will be rebuilt automatically')
        }
        return failure(
          candidate === null || candidate === undefined || candidate.code === undefined ? 'candidate-failed' : String(candidate.code),
          candidate === null || candidate === undefined || candidate.message === undefined ? 'could not build the test candidate' : String(candidate.message),
          candidate !== null && candidate !== undefined && candidate.conflict ? { conflict: candidate.conflict } : undefined,
        )
      }
    }
    // The declared mechanical verification is a HOST action: it runs in the
    // candidate the review just built, BEFORE any tester exists. A command
    // that exits non-zero is not a judgement call, so it must not consume a
    // tester round (or its watchdog).
    let hostCheck = null
    let hostCheckFailed = false
    const declaredVerify = normaliseVerify(reviewTask.verify)
    if (action === 'approveReview' && declaredVerify !== null) {
      if (candidate === null) {
        emitActivity(null, 'host-check', 'skipped: no test candidate in this profile', id, 'host')
      } else {
        const checked = await runHostCheck(ctx, { verify: declaredVerify, cwd: candidate.path, now: () => clock() })
        if (checked.ok !== true) {
          // The declaration cannot be honoured: refuse readably instead of
          // pretending it passed. Nothing is written, so the review stays open.
          return failure(checked.code, checked.message)
        }
        hostCheck = checked.check
        hostCheckFailed = hostCheck.timedOut === true || hostCheck.exitCode !== 0
      }
    }
    // T-156: the candidate was just built from the target's CURRENT head and the
    // declaration may have changed since dispatch/submit. Compute the fingerprint
    // even when there is no candidate: the reviewer still deserves the truth.
    const reviewVerifyPrint = await verifyFingerprintFor(ctx, projectPath, reviewTask.verify)
    const result = await writeTask(
      projectPath,
      id,
      (board) => {
        const transitioned =
          action === 'approveReview'
            ? model.approveReview(board, id, clock(), context.by, writeByName(context))
            : model.requestChanges(board, id, source.reasons, clock(), context.by, writeByName(context))
        if (transitioned.ok !== true) return transitioned
        let next = transitioned
        if (hostCheckFailed) {
          // The host records a FAILED test itself (by = host): the task goes
          // straight back to running with the command, the exit code and the
          // output tail, and no tester round is opened.
          const failed = model.failTest(transitioned.board, id, hostCheckEvidence(hostCheck), clock(), 'host', 'host')
          if (failed.ok !== true) return failed
          next = failed
        } else if (candidate !== null) {
          const recorded = recordCandidate(transitioned.board, id, candidate, clock(), { by: context.by, verifyFingerprint: reviewVerifyPrint })
          if (recorded.ok !== true) return recorded
          next = recorded
        }
        if (hostCheck !== null) {
          const checkedTask = model.findTask(next.board, id)
          if (checkedTask !== null && checkedTask !== undefined && checkedTask.test !== null && checkedTask.test !== undefined) {
            checkedTask.test.hostCheck = hostCheck
          }
        }
        return next
      },
      context,
    )
    if (result.ok !== true) return result
    if (action === 'requestChanges') {
      emitActivity(context, 'review-end', 'changes requested: ' + String(source.reasons || '').slice(0, 200), id)
    }
    if (action === 'approveReview' && hostCheckFailed) {
      // The review round is over even though the card returns to running: the
      // reviewer must be disposed here too (the generic release below is skipped
      // by this early return). It is the caller of this action, so the stage
      // service queues it instead of disposing it in flight (T-185).
      await releaseStageRoster(result.task, ['reviewer'], context)
      emitActivity(context, 'review-end', 'approved', id)
      emitActivity(
        null,
        'host-check',
        'mechanical verification failed (' + String(hostCheck.timedOut === true ? 'timed out' : 'exit ' + String(hostCheck.exitCode)) + '); back to running',
        id,
        'host',
      )
      // The candidate proved nothing: drop it so the next approval rebuilds
      // from the (possibly moved) target head. A failure here is not fatal.
      if (candidate !== null && candidateWorkflow) {
        const discardStarted = Date.now()
        await boundedAwait(
          () => serialised(() => merger.discardCandidate(result.task, projectPath, { worktreeRoot: worktreeRootOf(read.board) })),
          actionTimeoutMs,
        )
        if (Date.now() - discardStarted > actionTimeoutMs) actionTimeoutFailure('approveReview discard candidate', id, discardStarted)
      }
      // The worker owns the fix and may be idle, so it is told directly (the
      // board carries the same evidence).
      const ownerName =
        result.task !== null &&
        result.task !== undefined &&
        result.task.assignee !== null &&
        result.task.assignee !== undefined &&
        typeof result.task.assignee.name === 'string' &&
        result.task.assignee.name !== ''
          ? result.task.assignee.name
          : null
      if (ownerName !== null) {
        await notifyMember(
          ownerName,
          'Host mechanical verification FAILED for ' + id + ' (' + String(result.task.title) + ').\n\n' + hostCheckEvidence(hostCheck),
          result.task.ownerSession,
          projectPath,
        )
      }
      return ok({ task: result.task, events: result.events, hostCheck: hostCheck })
    }
    if (action === 'requestChanges' && result.task !== null && result.task !== undefined && result.task.status === 'running') {
      clearStageSlots(id)
      // Tell the worker what to fix and that it continues in its own worktree.
      const owner =
        result.task.assignee === null || result.task.assignee === undefined || typeof result.task.assignee.name !== 'string'
          ? null
          : result.task.assignee.name
      if (stageAgents !== null) {
        await stageAgents.sendAssignee(result.task, reworkBriefFor(result.task, projectPath))
      } else if (owner !== null) {
        await notifyMember(owner, reworkBriefFor(result.task, projectPath), result.task.ownerSession, projectPath)
      }
    }
    if (action === 'approveReview' && result.task !== null && result.task !== undefined && result.task.status === 'testing') {
      emitActivity(context, 'review-end', 'approved', id)
      emitActivity(null, 'test-start', 'test candidate stage started', id, 'host')
      if (candidate !== null) emitActivity(null, 'worktree-create', 'test candidate ' + String(candidate.path), id, 'host')
      if (stageAgents === null) {
        const provisioned = await provisionRole('tester', projectPath, result.task)
        if (provisioned !== null) result.provisioned = provisioned
        if (provisionFailedHard(provisioned)) {
          const reason = provisionReasonOf(provisioned)
          await markWaiting(projectPath, id, reason, provisioned.message, context)
          return failure('tester-unavailable', 'no tester could be provisioned for ' + id + ' (' + reason + '); the task waits in testing with that reason and will be retried by the host')
        }
      }
      if (candidate !== null) {
        result.candidate = candidate
        if (state.memory.testCandidates === undefined || state.memory.testCandidates === null) state.memory.testCandidates = {}
        state.memory.testCandidates[result.task.id] = { candidate: candidate, hostCheck: hostCheck }
        if (stageAgents !== null) {
          const started = await stageAgents.startTester(
            result.task,
            testerBriefFor(result.task, projectPath, candidate, {
              godot: await godotInfoFor(projectPath, candidate.path),
              hostCheck: hostCheck,
            }),
          )
          if (!stageAgents.available || started.ok !== true) {
            // The review round is over; do not leave its reviewer running behind
            // a card that waits for a tester (T-183). The reviewer is this
            // action's caller, so it is queued, not disposed in flight (T-185).
            await releaseStageRoster(result.task, ['reviewer'], context)
            await markWaiting(projectPath, id, 'tester-unavailable', started.message, context)
            return failure('tester-unavailable', 'no tester could be started for ' + id + ' (' + String(started.message) + '); the task waits in testing')
          }
          result.provisioned = started
          await recordDeliveredTo(projectPath, result.task.id, 'tester', { name: started.name, id: started.agentId })
        } else {
          const tester = roleSlotNameOf('tester', result.task.ownerSession)
          const testSlot = await assignStageSlot(projectPath, result.task, 'tester')
          result.queuePosition = testSlot.position
          if (testSlot.delivered === true && tester !== null) {
            const sentTo = await notifyMember(
              tester,
              testerBriefFor(result.task, projectPath, candidate, {
                godot: await godotInfoFor(projectPath, candidate.path),
                hostCheck: hostCheck,
              }),
              result.task.ownerSession,
              projectPath,
            )
            await recordDeliveredTo(projectPath, result.task.id, 'tester', sentTo)
          }
        }
      }
    }
    if (stageAgents !== null && (action === 'approveReview' || action === 'requestChanges')) {
      // T-183: a request-changes verdict has no tester of this round, so any
      // tester still alive under the card is a leftover and is disposed with the
      // reviewer. An approval has just started the tester and must not touch it.
      // T-185: the caller of this verdict is only queued; only the other stage
      // children are disposed immediately.
      await releaseStageRoster(result.task, action === 'requestChanges' ? ['reviewer', 'tester'] : ['reviewer'], context)
    }
    // The delivery timestamp is KEPT on the stage slot so the snapshot can still
    // report the finished round's duration; the verdict already means the task no
    // longer occupies capacity (stageQueueState only counts pending rounds).
    // The verdict frees this reviewer slot: hand it to the next queued round.
    const promotedReview = await promoteStageSlots(projectPath, 'reviewer')
    if (promotedReview.length > 0) {
      const reviewerSlot = roleSlotNameOf('reviewer', result.task.ownerSession)
      if (reviewerSlot !== null) {
        for (const promoted of promotedReview) {
          const sentTo = await notifyMember(reviewerSlot, reviewBriefFor(promoted, projectPath), promoted.ownerSession, projectPath)
          await recordDeliveredTo(projectPath, promoted.id, 'reviewer', sentTo)
        }
      }
    }
    return ok({ task: result.task, events: result.events, provisioned: result.provisioned, candidate: result.candidate, hostCheck: hostCheck })
  }

  return {
    approveReview: (source, context, projectPath) => run('approveReview', source, context, projectPath),
    requestChanges: (source, context, projectPath) => run('requestChanges', source, context, projectPath),
  }
}
