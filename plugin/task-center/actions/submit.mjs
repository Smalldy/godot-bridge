/**
 * Submit action (worker hands a running card to review).
 *
 * The reviewer is a fresh child of the card's root Agent; the host starts it and
 * records its Session id on the card (review.deliveredTo). A profile without the
 * subagent runtime refuses with a typed reviewer-unavailable code instead of
 * looking for a removed Team slot.
 */
export function createSubmitAction(deps) {
  // T-223: reviewer/tester starts have ONE authority. The action never calls the
  // stage service's start* itself.
  const stageCoordinator = deps.stageCoordinator === undefined ? null : deps.stageCoordinator
  const readBoardOrFail = deps.readBoardOrFail
  const taskForContext = deps.taskForContext
  const model = deps.model
  const clock = deps.clock
  const prepareMergeRequest = deps.prepareMergeRequest
  const REVIEW_MAX_ROUNDS = deps.REVIEW_MAX_ROUNDS
  const markWaiting = deps.markWaiting
  const writeTask = deps.writeTask
  const writeByName = deps.writeByName
  const clearWaiting = deps.clearWaiting
  const recordStageSlot = deps.recordStageSlot
  const ctx = deps.ctx
  const locks = deps.locks
  const state = deps.state
  const enforceReviewRoundLimit = deps.enforceReviewRoundLimit
  const releaseTaskLocks = deps.releaseTaskLocks
  const emitActivity = deps.emitActivity
  const reviewBriefFor = deps.reviewBriefFor
  const ok = deps.ok
  const failure = deps.failure

  async function submit(source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', 'submit needs a task id')
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const checked = taskForContext(read.board, id, context)
    if (checked.ok !== true) return checked
    // T-131: an investigation never commits; refuse BEFORE prepareMergeRequest
    // so the detached scratch is not touched at all.
    if (checked.task.kind === 'investigate') {
      return failure('investigation-report-only', id + ' is an investigation card: finish it with task_center { action: "report", id, summary, body, evidence? }, not submit')
    }
    // Only a running task has a worktree worth committing; any other status
    // must reach submitTask's own refusal without touching git.
    const submittedAt = clock()
    const prepared = checked.task.status === 'running' ? await prepareMergeRequest(checked.task, source, submittedAt, projectPath) : { ok: true, mr: null }
    if (prepared.ok !== true) return prepared
    // T-191: the host built the CandidateArtifact from git while preparing the
    // merge request; the reviewer brief carries it. It is NOT written to the
    // board in full — merge.artifact keeps the summary.
    const candidateArtifact = prepared.mr === null || prepared.mr === undefined ? null : prepared.mr.artifact
    const willReview = checked.task.status === 'running'
    const nextReviewAttempt =
      checked.task.review === null || checked.task.review === undefined ? 1 : checked.task.review.attempt + 1
    // The stage needs a runtime BEFORE the card leaves running: a card parked in
    // review with nobody able to read it is worse than a card that waits.
    if (willReview && nextReviewAttempt <= REVIEW_MAX_ROUNDS && stageCoordinator === null) {
      await markWaiting(projectPath, id, 'agent-runtime-unavailable', 'no subagent runtime to start a reviewer', context)
      return failure('reviewer-unavailable', 'no reviewer could be started for ' + id + ' (agent-runtime-unavailable); the task stays running and will be retried by the host')
    }
    const input = { evidence: source.evidence, note: source.note }
    if (prepared.mr !== null) {
      input.commit = prepared.mr.commit
      input.actualFiles = prepared.mr.actualFiles
      input.merge = prepared.mr.merge
      // T-156 audit baseline at submit: the target head this request was opened
      // against and the verify declaration's fingerprint.
      input.targetBase = prepared.mr.targetBase
      input.verifyFingerprint = prepared.mr.verifyFingerprint
    }
    const result = await writeTask(
      projectPath,
      id,
      (board) =>
        model.submitTask(board, id, input, clock(), context.by, writeByName(context), context !== undefined && context !== null && context.role === 'user' ? 'user' : 'worker'),
      context,
    )
    if (result.ok === true && prepared.mr !== null && prepared.mr !== undefined && prepared.mr.commitScope !== undefined) {
      // T-101: tell the worker exactly what was skipped and what stayed out.
      result.commitScope = prepared.mr.commitScope
    }
    if (result.ok === true) await clearWaiting(projectPath, id, context)
    if (result.ok === true && result.task !== null && result.task.status !== 'running') {
      // A stale test slot from an earlier round must not describe this one.
      recordStageSlot(ctx, id, 'tester', null, null)
      const released = locks.releaseTask(state.memory.locks, id)
      if (released.ok === true) state.memory.locks = released.locks
    }
    // The request is now in review: a task that exhausted its review rounds is
    // blocked for triage, otherwise the host starts the reviewer and hands it
    // this round's brief.
    if (result.ok === true && result.task !== null && result.task !== undefined) {
      if (result.task.status === 'reviewing') {
        const overLimit = await enforceReviewRoundLimit(projectPath, result.task)
        if (overLimit !== null && overLimit.ok === true) {
          releaseTaskLocks(id)
          return overLimit
        }
        const round = result.task.review === null || result.task.review === undefined ? 1 : result.task.review.attempt
        emitActivity(context, 'review-start', 'submitted for review round ' + String(round), id)
        // v3: start the reviewer only after the board says reviewing, so its
        // first turn always sees the stage it is reviewing.
        // T-223: the reviewer starts through the ONE authority. It re-reads the
        // reviewing round this write just opened, reuses a reviewer another path
        // already delivered, and records the delivery before its queue releases.
        const ensured = await stageCoordinator.ensure('reviewer', result.task, reviewBriefFor(result.task, projectPath, candidateArtifact), { projectPath: projectPath })
        if (ensured.ok !== true) {
          await markWaiting(projectPath, id, 'reviewer-unavailable', String(ensured.message), context)
          return failure('reviewer-unavailable', 'no reviewer could be started for ' + id + ' (' + String(ensured.message) + '); the task waits in review')
        }
        result.stage = ensured
        if (ensured.action === 'spawned' || ensured.action === 'reused') result.provisioned = ensured
      }
    }
    return result
  }

  return { submit: submit }
}
