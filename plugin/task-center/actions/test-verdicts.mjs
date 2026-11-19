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
  const stageAgents = deps.stageAgents === undefined ? null : deps.stageAgents
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
  // T-191: the structured test contract.
  const validateTestRecord = deps.validateTestRecord
  const buildCandidateArtifact = deps.buildCandidateArtifact
  const renderTestRecordEvidence = deps.renderTestRecordEvidence
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

  async function run(action, source, context, projectPath) {
    try {
      return await execute(action, source, context, projectPath)
    } finally {
      // T-185 review round 1: passTest can spend the whole merge/verify budget
      // after queuing the tester's self-release. The bounded wait starts only
      // once this action has returned, never while it is still in flight.
      try {
        if (stageAgents !== null && typeof stageAgents.markCallerReturned === 'function') {
          stageAgents.markCallerReturned(callerAgentIdOf(context))
        }
      } catch (error) {}
    }
  }

  /**
   * The explicit record the panel's human override stands for (T-113 + T-191).
   * The contract's probe-execution rules bind the TESTER; a human decision is
   * recorded as a human decision (by/role on the board), not as fake probe
   * output masquerading as a tester run.
   */
  function userOverrideTestRecord(action, source) {
    const text = typeof source.evidence === 'string' ? source.evidence.trim() : ''
    const fallback =
      action === 'passTest'
        ? 'the user accepted the candidate in the task center panel'
        : 'the user rejected the candidate in the task center panel'
    return {
      verdict: action === 'passTest' ? 'passed' : 'failed',
      probes: [
        {
          id: 'human-override',
          command: 'human verdict from the task center panel',
          exitCode: action === 'passTest' ? 0 : 1,
          tail: text === '' ? fallback : text,
        },
      ],
      adversarial: [],
      notes: text === '' ? fallback : text,
    }
  }

  async function execute(action, source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', action + ' needs a task id')
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const testTask = model.findTask(read.board, id)
    if (testTask === undefined) return failure('unknown-task', 'no task with id ' + id)
    const testRefused = verdictRefusal(context, testTask, 'tester')
    if (testRefused !== null) return testRefused
    // T-191: which candidate is this verdict about? The board records the test
    // candidate's base/head, so the artifact (and its probes) is derivable here
    // without trusting anything the tester pasted.
    const merge = testTask.merge === null || testTask.merge === undefined ? {} : testTask.merge
    const artifact = buildCandidateArtifact(
      testTask,
      {
        base: typeof merge.base === 'string' && merge.base !== '' ? merge.base : testTask.base,
        head:
          typeof merge.mergeCommit === 'string' && merge.mergeCommit !== ''
            ? merge.mergeCommit
            : typeof merge.head === 'string' && merge.head !== ''
              ? merge.head
              : testTask.commit,
        actualFiles: Array.isArray(testTask.actualFiles) ? testTask.actualFiles : [],
      },
      testTask.test === null || testTask.test === undefined ? null : testTask.test.hostCheck,
    )
    // The record is validated BEFORE the board moves: a refusal leaves the test
    // round open, exactly like a malformed review verdict. The USER's panel
    // verdict is the explicit human override: a structured record from the panel
    // is accepted, a bare {id, evidence} from an older bundle is attributed here
    // (and is not held to the TESTER's probe-execution rule).
    const userCaller = context !== undefined && context !== null && context.role === 'user'
    const structuredTest = Array.isArray(source.probes) || (source.record !== undefined && source.record !== null)
    const testInput = userCaller && !structuredTest ? userOverrideTestRecord(action, source) : source
    const checkedRecord = validateTestRecord(testInput, {
      verdict: action === 'passTest' ? 'passed' : 'failed',
      requiredProbes: userCaller ? [] : artifact.probes,
    })
    if (checkedRecord.ok !== true) return failure(checkedRecord.code, checkedRecord.message)
    const testRecord = checkedRecord.record
    const explicitEvidence = source.evidence === undefined || source.evidence === null ? '' : String(source.evidence).trim()
    const recordEvidence = renderTestRecordEvidence(testRecord)
    const evidence = explicitEvidence !== '' ? explicitEvidence + (recordEvidence === '' ? '' : '\n' + recordEvidence) : recordEvidence
    const result = await writeTask(
      projectPath,
      id,
      (board) => {
        // T-201: the verdict's actor is the delivery role (or the user override).
        const actor = context !== undefined && context !== null && context.role === 'user' ? 'user' : 'tester'
        const decided =
          action === 'passTest'
            ? model.passTest(board, id, clock(), context.by, writeByName(context), testRecord, actor)
            : model.failTest(board, id, evidence, clock(), context.by, writeByName(context), testRecord, { actor: actor })
        if (decided.ok !== true) return decided
        if (action === 'passTest' && evidence !== '') {
          const task = model.findTask(decided.board, id)
          if (task !== null && task !== undefined && task.test !== null && task.test !== undefined) {
            task.test.evidence = evidence
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
    if (stageAgents !== null) {
      // T-185: the tester that records this verdict is usually the CALLER; the
      // release must queue it for the reconciler instead of disposing the
      // activation whose tool result is still in flight (that was the T-181
      // zombie). Only a tester that is not this caller is disposed now.
      const callerAgentId = callerAgentIdOf(context)
      if (typeof stageAgents.releaseTask === 'function') {
        await stageAgents.releaseTask(result.task, { roles: ['tester'], callerAgentId: callerAgentId, reason: 'test verdict' })
      } else {
        const testerId = result.task !== null && result.task !== undefined && result.task.test !== null && result.task.test !== undefined && result.task.test.deliveredTo !== null && result.task.test.deliveredTo !== undefined
          ? result.task.test.deliveredTo.id
          : null
        if (typeof testerId === 'string' && testerId !== '') await stageAgents.release(testerId, { callerAgentId: callerAgentId })
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
      if (stageAgents !== null) await stageAgents.sendAssignee(result.task, testFailureBriefFor(result.task, projectPath))
    }
    return ok({ task: result.task, events: result.events })
  }

  return {
    passTest: (source, context, projectPath) => run('passTest', source, context, projectPath),
    failTest: (source, context, projectPath) => run('failTest', source, context, projectPath),
  }
}
