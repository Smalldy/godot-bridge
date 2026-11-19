/**
 * Merge request actions: mergeRequest / rejectMerge / refreshMerge.
 *
 * refreshMerge keeps the branch/diff/reviewer orchestration; it is extracted
 * after the queue/record half so the whole merge domain has one owner.
 *
 * T-201: refreshMerge is a state-machine transition (state-machine.mjs T27), so
 * this action refuses closed cards, accepts only a review/test/merge request or a
 * card blocked by a merge outcome, and returns "no-change" WITHOUT spending a
 * review round when the request is already current.
 */
import { blockedReasonOf, isMergeReason } from '../state-machine.mjs'

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
  const refreshMergeRequest = deps.refreshMergeRequest
  const ownerOf = deps.ownerOf
  const assigneeMatches = deps.assigneeMatches
  const readTargetHead = deps.readTargetHead
  const readBranchHead = deps.readBranchHead
  const git = deps.git
  const messageOf = deps.messageOf
  const stageAgents = deps.stageAgents === undefined ? null : deps.stageAgents
  const markWaiting = deps.markWaiting
  const clearWaiting = deps.clearWaiting
  const reviewBriefFor = deps.reviewBriefFor
  const recordDeliveredTo = deps.recordDeliveredTo
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
        (board) => recordMergeResult(board, id, { status: 'rejected' }, clock(), context.by, writeByName(context), 'user'),
        context,
      )
      if (recorded.ok !== true) return recorded
      emitActivity(context, 'merge', 'rejected', id)
      return ok({ task: recorded.task, events: recorded.events, merge: recorded.task === null ? null : recorded.task.merge })
    })
  }

  async function refreshMerge(source, context, projectPath) {
    const id = String(source.id !== undefined ? source.id : source.taskId === undefined ? '' : source.taskId)
    if (id === '') return failure('missing-id', 'refreshMerge needs a task id')
    // Reads the branch head and the base diff, then rewrites the request in
    // one board write. It never commits, merges or pushes.
    return serialised(async function () {
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      const task = model.findTask(read.board, id)
      if (task === undefined) return failure('unknown-task', 'no task with id ' + id)
      // T-201 T27: closed cards are final until reopen; a blocked card may only
      // be refreshed when it was paused BY a merge outcome (merge-unresolved).
      if (task.status === 'done' || task.status === 'cancelled') {
        return failure('closed', id + ' is ' + task.status + '; a closed card has no open merge request. Reopen it first.')
      }
      if (task.status === 'pending' || task.status === 'running') {
        return failure('not-mergeable-phase', id + ' is ' + task.status + '; only a submitted task has a merge request to refresh')
      }
      const merge = task.merge
      if (merge === null || merge === undefined || typeof merge !== 'object' || Array.isArray(merge)) {
        return failure('no-merge-request', id + ' has no merge request to refresh')
      }
      if (task.status === 'blocked') {
        const reason = blockedReasonOf(task)
        if (reason === null || isMergeReason(reason.code) !== true) {
          return failure('not-mergeable-phase', id + ' is blocked for ' + (reason === null ? 'an unknown reason' : reason.code) + '; only a merge-outcome block is resolved by refreshing the request')
        }
      }
      const owner = ownerOf(context)
      const asUser = context !== undefined && context !== null && context.role === 'user'
      const asOwner = owner !== null && task.assignee !== null && task.assignee !== undefined && assigneeMatches(task, owner)
      if (!asUser && !asOwner) {
        return failure(
          'not-assignee',
          id +
            ' belongs to ' +
            (task.assignee === null || task.assignee === undefined ? 'nobody' : String(task.assignee.name)) +
            '; only its owner or the user may refresh its merge request',
        )
      }
      if (typeof task.branch !== 'string' || task.branch.length === 0) return failure('missing-branch', id + ' has no branch to read')
      // Re-base on the target's CURRENT head, not the commit recorded at
      // submit: when the target advanced (or the branch merged it in while
      // resolving a conflict), diffing from the old base would report
      // upstream files as this task's work. A task with no target branch keeps
      // its recorded base (legacy behaviour).
      let base = typeof merge.base === 'string' && merge.base.length > 0 ? merge.base : null
      if (typeof task.target === 'string' && task.target.length > 0) {
        const targetHead = await readTargetHead(projectPath, task.target)
        if (targetHead.ok !== true) return targetHead
        base = targetHead.head
      } else if (base === null) {
        return failure('missing-base', id + ' has no base commit and no target branch to resolve one from')
      }
      const current = await readBranchHead(projectPath, task)
      if (current.ok !== true) return current
      let diff
      try {
        diff = await git.diffNameOnly(projectPath, base, current.head)
      } catch (error) {
        return failure('diff-failed', 'could not list the files ' + id + ' changed: ' + messageOf(error))
      }
      if (diff === null || diff === undefined || diff.ok !== true) {
        const code = diff !== null && diff !== undefined && diff.code !== undefined && diff.code !== null ? String(diff.code) : 'diff-failed'
        const detail = diff === null || diff === undefined ? 'git returned no result' : String(diff.message)
        return failure(code, 'could not list the files ' + id + ' changed: ' + detail)
      }
      // T-201 T27 idempotency: (base, head, outcome) unchanged is a no-change, not
      // a new review round. Refuse BEFORE any reviewer is provisioned.
      const sameBase = typeof merge.base === 'string' && merge.base === base
      const sameHead = typeof merge.head === 'string' && merge.head === current.head
      if (sameBase && sameHead && merge.status === 'open') {
        return failure('no-change', id + ' is already refreshed on base ' + String(base) + ' and head ' + String(current.head) + '; nothing changed, so no review round was started')
      }
      // A new head/base starts a fresh review round: the previous decisions
      // were taken on a different tree, so refreshMergeRequest resets the
      // phases and the queue waits for review + tests again. Start the reviewer
      // before the write so the scheduler's stage pass cannot race.
      if (stageAgents === null) {
        await markWaiting(projectPath, id, 'agent-runtime-unavailable', 'no subagent runtime to start a reviewer', context)
        return failure('reviewer-unavailable', 'no reviewer could be started for ' + id + ' (agent-runtime-unavailable); the merge request was not refreshed')
      }
      const provisioned = stageAgents === null ? null : await stageAgents.startReviewer(task, reviewBriefFor(task, projectPath))
      if (provisioned !== null && provisioned.ok !== true) {
        await markWaiting(projectPath, id, 'reviewer-unavailable', String(provisioned.message), context)
        return failure('reviewer-unavailable', 'no reviewer could be started for ' + id + ' (' + String(provisioned.message) + '); the merge request was not refreshed')
      }
      const recorded = await writeTask(
        projectPath,
        id,
        (board) =>
          refreshMergeRequest(board, id, base, current.head, Array.isArray(diff.files) ? diff.files : [], clock(), context.by, writeByName(context), context !== undefined && context !== null && context.role === 'user' ? 'user' : 'worker'),
        context,
      )
      if (recorded.ok !== true) return recorded
      await clearWaiting(projectPath, id, context)
      // A refreshed head starts a fresh review round: ensure the reviewer and
      // send it the new brief, exactly like a submit would.
      if (recorded.task !== null && recorded.task !== undefined && recorded.task.status === 'reviewing') {
        const round = recorded.task.review === null || recorded.task.review === undefined ? 1 : recorded.task.review.attempt
        emitActivity(context, 'review-start', 'merge request refreshed; review round ' + String(round), id)
        if (provisioned !== null && provisioned.ok === true) {
          await recordDeliveredTo(projectPath, recorded.task.id, 'reviewer', { name: provisioned.name, id: provisioned.agentId })
        }
        return ok({ task: recorded.task, events: recorded.events, merge: recorded.task.merge, provisioned: provisioned })
      }
      return ok({ task: recorded.task, events: recorded.events, merge: recorded.task === null ? null : recorded.task.merge })
    })
  }

  return { mergeRequest: mergeRequest, rejectMerge: rejectMerge, refreshMerge: refreshMerge }
}
