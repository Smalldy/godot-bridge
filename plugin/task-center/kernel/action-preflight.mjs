/**
 * Per-action preflight (kernel seam).
 *
 * Extracted from performResolved: lease heartbeat, stopped-card refusal, phase
 * activity, and the investigation/dev-only guard. Returns a refusal result or
 * null. The API keeps remember()/clock() and the handler routing.
 */
export function createActionPreflight(deps) {
  const ownerOf = deps.ownerOf
  const heartbeat = deps.heartbeat
  const stoppedTaskRefusal = deps.stoppedTaskRefusal
  const recordPhaseActivity = deps.recordPhaseActivity
  const ctx = deps.ctx
  const DEV_ONLY_ACTIONS = deps.DEV_ONLY_ACTIONS
  const readBoardOrFail = deps.readBoardOrFail
  const model = deps.model
  const failure = deps.failure

  async function run(action, source, context, projectPath, now) {
    // Any activity by the assignee renews its lease and file locks, so the
    // heartbeat runs ONCE here, before the action, for every action an agent can
    // call. Routing it through one place is what keeps 'lock' and 'unlock' (which
    // never write the board and used to bypass mutate()) from silently drifting
    // into expiry, and it stops an action from renewing twice.
    const owner = ownerOf(context)
    if (owner !== null) await heartbeat(projectPath, owner)
    const stopped = await stoppedTaskRefusal(projectPath, action, source, context, owner)
    if (stopped !== null) return stopped
    // Any task-scoped call by a role renews that round's silence clock. The
    // watchdog measures silence from this, so a tester that keeps calling
    // get/passTest is never mistaken for a stuck one.
    if (typeof source.id === 'string' && source.id !== '') {
      const activityBy = typeof owner === 'string' ? owner : owner !== null && owner !== undefined && typeof owner.name === 'string' ? owner.name : null
      const activitySession = owner !== null && owner !== undefined && typeof owner === 'object' && typeof owner.session === 'string' ? owner.session : null
      recordPhaseActivity(ctx, source.id, activityBy, now, activitySession)
    }

    // T-131: refuse a dev-only phase action on an investigation BEFORE it reaches
    // a handler that would provision a reviewer or build a test candidate.
    if (DEV_ONLY_ACTIONS.indexOf(action) >= 0) {
      const guardId = String(source.id !== undefined ? source.id : source.taskId === undefined ? '' : source.taskId)
      if (guardId !== '') {
        const read = await readBoardOrFail(projectPath)
        if (read.failed !== undefined) return read.failed
        const guardTask = model.findTask(read.board, guardId)
        if (guardTask !== undefined && guardTask.kind === 'investigate') {
          return failure('not-a-dev-task', guardId + ' is an investigation card; it has no ' + String(action) + ' phase — finish it with task_center { action: "report" }')
        }
      }
    }
    return null
  }

  return { run: run }
}
