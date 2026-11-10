/**
 * Submit action (worker hands a running card to review).
 *
 * Extracted from performResolved. Keeps the same prepareMergeRequest,
 * reviewer provisioning, submitTask, lock release, review-round limit and
 * reviewer delivery semantics.
 */
export function createSubmitAction(deps) {
  const wrongProjectRefusal = deps.wrongProjectRefusal
  const roles = deps.roles
  const callerRole = deps.callerRole
  const readBoardOrFail = deps.readBoardOrFail
  const taskForContext = deps.taskForContext
  const model = deps.model
  const clock = deps.clock
  const prepareMergeRequest = deps.prepareMergeRequest
  const REVIEW_MAX_ROUNDS = deps.REVIEW_MAX_ROUNDS
  const provisionRole = deps.provisionRole
  const provisionFailedHard = deps.provisionFailedHard
  const provisionReasonOf = deps.provisionReasonOf
  const markWaiting = deps.markWaiting
  const writeTask = deps.writeTask
  const writeByName = deps.writeByName
  const clearWaiting = deps.clearWaiting
  const recordStageSlot = deps.recordStageSlot
  const ctx = deps.ctx
  const locks = deps.locks
  const state = deps.state
  const notifyMergerOpened = deps.notifyMergerOpened
  const enforceReviewRoundLimit = deps.enforceReviewRoundLimit
  const releaseTaskLocks = deps.releaseTaskLocks
  const emitActivity = deps.emitActivity
  const roleSlotNameOf = deps.roleSlotNameOf
  const assignStageSlot = deps.assignStageSlot
  const notifyMember = deps.notifyMember
  const reviewBriefFor = deps.reviewBriefFor
  const recordDeliveredTo = deps.recordDeliveredTo
  const ok = deps.ok
  const failure = deps.failure

  async function submit(source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', 'submit needs a task id')
    const wrongProject = wrongProjectRefusal(context, projectPath)
    if (wrongProject !== null) return wrongProject
    if (roles !== null) {
      const caller = callerRole(context)
      if (caller !== null && (caller.kind === 'reviewer' || caller.kind === 'tester')) {
        return failure('role-cannot-implement', 'A ' + caller.kind + ' role cannot submit implementation work; only the task\'s worker may submit.')
      }
    }
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
    // Ensure the reviewer BEFORE the stage write: the write kicks the scheduler,
    // whose stage-role pass would otherwise race this provisioning and report
    // "reused" to a caller that expects "created".
    const willReview = checked.task.status === 'running'
    const nextReviewAttempt =
      checked.task.review === null || checked.task.review === undefined ? 1 : checked.task.review.attempt + 1
    let provisioned = null
    if (willReview && nextReviewAttempt <= REVIEW_MAX_ROUNDS) {
      provisioned = await provisionRole('reviewer', projectPath, checked.task)
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
    if (willReview && provisionFailedHard(provisioned)) {
      // No reviewer: do NOT advance into an empty phase. The card stays running
      // with a waiting reason; the next host tick retries provisioning.
      const reason = provisionReasonOf(provisioned)
      await markWaiting(projectPath, id, reason, provisioned.message, context)
      return failure('reviewer-unavailable', 'no reviewer could be provisioned for ' + id + ' (' + reason + '); the task stays running and will be retried by the host')
    }
    const result = await writeTask(
      projectPath,
      id,
      (board) => model.submitTask(board, id, input, clock(), context.by, writeByName(context)),
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
    // blocked for triage, otherwise the host provisions the reviewer and hands
    // it this round's brief. Notifications never change the answer.
    if (result.ok === true && result.task !== null && result.task !== undefined) {
      await notifyMergerOpened(projectPath, result.task)
      if (result.task.status === 'reviewing') {
        const overLimit = await enforceReviewRoundLimit(projectPath, result.task)
        if (overLimit !== null && overLimit.ok === true) {
          releaseTaskLocks(id)
          return overLimit
        }
        const round = result.task.review === null || result.task.review === undefined ? 1 : result.task.review.attempt
        emitActivity(context, 'review-start', 'submitted for review round ' + String(round), id)
        const reviewer = roleSlotNameOf('reviewer', result.task.ownerSession)
        const slot = await assignStageSlot(projectPath, result.task, 'reviewer')
        result.queuePosition = slot.position
        if (slot.delivered === true && reviewer !== null) {
          const sentTo = await notifyMember(reviewer, reviewBriefFor(result.task, projectPath), result.task.ownerSession, projectPath)
          await recordDeliveredTo(projectPath, result.task.id, 'reviewer', sentTo)
        }
        if (provisioned !== null) result.provisioned = provisioned
      }
    }
    return result
  }

  return { submit: submit }
}
