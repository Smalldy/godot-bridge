/**
 * Startup/periodic reconciliation between the durable merge journal and the
 * board. This is the missing half of "git advanced but the board did not":
 *
 *   - read pending intents;
 *   - resolve each intent's target head;
 *   - ask git whether the intent head is contained;
 *   - mark-merged only after the board write succeeds (then finish the journal);
 *   - abandoned/stale only close the journal, leaving the board for autoMerge.
 *
 * It never deletes a branch/worktree and never merges. A failed board write
 * leaves the journal pending, so the next tick retries.
 */
import * as model from './service.mjs'
import { recordMergeResult } from './merge.mjs'
import { writePolicyFor } from './state.mjs'

export function createMergeReconciler(options) {
  const opts = options === undefined || options === null ? {} : options
  const journalFor = typeof opts.journalFor === 'function' ? opts.journalFor : null
  const git = opts.git === undefined ? null : opts.git
  const state = opts.state === undefined ? null : opts.state
  const now = typeof opts.now === 'function' ? opts.now : Date.now

  async function reconcileProject(project) {
    if (journalFor === null || git === null || state === null) return { ok: true, skipped: 'no-journal' }
    let journal
    try {
      journal = journalFor(project)
    } catch (error) {
      return { ok: false, code: 'journal-unavailable', message: String((error && error.message) || error) }
    }
    if (journal === null || journal === undefined || typeof journal.pending !== 'function') return { ok: true, skipped: 'no-journal' }
    const pending = await journal.pending()
    if (pending === null || pending === undefined || pending.ok !== true) {
      return { ok: false, code: 'journal-unreadable', message: pending === null || pending === undefined ? 'pending returned no result' : String(pending.message || 'pending failed') }
    }
    const results = []
    for (const intent of pending.entries) {
      const target = await git.revParse(project, 'refs/heads/' + String(intent.target))
      if (target === null || target === undefined || target.ok !== true || typeof target.hash !== 'string') {
        results.push({ key: intent.key, action: 'unreadable', ok: false, code: 'target-unreadable' })
        continue
      }
      const ancestor = await git.isAncestor(project, intent.head, target.hash)
      if (ancestor === null || ancestor === undefined || ancestor.ok !== true) {
        results.push({ key: intent.key, action: 'unreadable', ok: false, code: 'ancestor-unreadable' })
        continue
      }
      const plan = journal.planReconcile({
        targetHead: target.hash,
        isAncestor: function (head, descendant) {
          return head === descendant || ancestor.ancestor === true
        },
      })
      if (plan === null || plan === undefined || plan.ok !== true) {
        results.push({ key: intent.key, action: 'unreadable', ok: false, code: 'plan-unreadable' })
        continue
      }
      for (const action of plan.actions) {
        if (action.action === 'mark-merged') {
          const applied = await state.apply(
            project,
            (board) => {
              const task = model.findTask(board, intent.id)
              if (task === undefined) return { ok: false, code: 'unknown-task', message: 'no task with id ' + String(intent.id) }
              if (task.merge !== null && task.merge !== undefined && task.merge.status === 'merged') {
                return { ok: false, code: 'already-merged', message: 'the board already records this merge' }
              }
              const recorded = recordMergeResult(board, intent.id, { status: 'merged', mergeCommit: action.mergeCommit }, now(), 'system', 'system')
              if (recorded.ok !== true) return recorded
              return { ok: true, board: recorded.board, events: recorded.events }
            },
            writePolicyFor(project),
          )
          const failed = applied === null || applied === undefined ? { code: 'apply-failed', message: 'state.apply returned no result' } : applied.failed
          if (failed !== null && failed !== undefined && failed.code !== 'already-merged') {
            results.push({ key: intent.key, action: 'mark-merged', ok: false, code: failed.code === undefined ? 'apply-failed' : failed.code, message: failed.message })
            continue
          }
          const finished = await journal.finish(action.key, { status: 'merged', mergeCommit: action.mergeCommit })
          results.push({ key: intent.key, action: 'mark-merged', ok: finished !== null && finished !== undefined && finished.ok === true })
          continue
        }
        if (action.action === 'mark-abandoned' || action.action === 'mark-stale') {
          const finished = await journal.finish(action.key, {
            status: action.action === 'mark-abandoned' ? 'abandoned' : 'stale',
            currentHead: action.currentHead === undefined ? null : action.currentHead,
          })
          results.push({ key: intent.key, action: action.action, ok: finished !== null && finished !== undefined && finished.ok === true })
          continue
        }
        results.push({ key: intent.key, action: action.action, ok: false, code: 'manual' })
      }
    }
    return { ok: true, results: results }
  }

  return { reconcileProject: reconcileProject }
}
