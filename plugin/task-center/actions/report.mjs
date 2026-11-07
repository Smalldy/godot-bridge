/**
 * Investigation report action.
 *
 * Extracted from performResolved. It keeps the same writeTask/report-file/
 * cleanup/warnings semantics; only the routing moved.
 */
export function createReportAction(deps) {
  const wrongProjectRefusal = deps.wrongProjectRefusal
  const readBoardOrFail = deps.readBoardOrFail
  const taskForContext = deps.taskForContext
  const probeCommitsOf = deps.probeCommitsOf
  const writeTask = deps.writeTask
  const model = deps.model
  const clock = deps.clock
  const writeByName = deps.writeByName
  const locks = deps.locks
  const state = deps.state
  const writeReportFile = deps.writeReportFile
  const cleanupInvestigation = deps.cleanupInvestigation
  const emitActivity = deps.emitActivity
  const ok = deps.ok
  const failure = deps.failure

  async function report(source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', 'report needs a task id')
    const wrongProject = wrongProjectRefusal(context, projectPath)
    if (wrongProject !== null) return wrongProject
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const checked = taskForContext(read.board, id, context)
    if (checked.ok !== true) return checked
    const task = checked.task
    if (task.kind !== 'investigate') {
      return failure('not-an-investigation', id + ' is a dev card; finish it with submit so it can be reviewed, tested and merged')
    }
    if (task.status !== 'running') return failure('not-running', id + ' is ' + task.status + ', not running')
    // An accidental commit in the detached scratch cannot reach the target, but
    // it is recorded before the checkout is force-removed.
    const probeCommits = await probeCommitsOf(task)
    const reportInput = { summary: source.summary, body: source.body, evidence: source.evidence, artifacts: source.artifacts, probeCommits: probeCommits }
    const result = await writeTask(
      projectPath,
      id,
      (board) => model.reportTask(board, id, reportInput, clock(), context.by, writeByName(context)),
      context,
    )
    if (result.ok !== true) return result
    const released = locks.releaseTask(state.memory.locks, id)
    if (released.ok === true) state.memory.locks = released.locks
    // The full markdown keeps the UNTRUNCATED body the caller sent; the board
    // keeps the bounded copy.
    const written = await writeReportFile(projectPath, task, {
      summary: result.task.report.summary,
      body: typeof source.body === 'string' ? source.body : '',
      evidence: result.task.report.evidence,
      artifacts: result.task.report.artifacts,
      probeCommits: result.task.report.probeCommits,
      reportedAt: result.task.report.createdAt,
      by: result.task.report.by,
      byName: result.task.report.byName,
    })
    const cleanup = await cleanupInvestigation(projectPath, task)
    emitActivity(context, 'report', 'received', id)
    const warnings = []
    if (written.ok !== true && written.warning !== null) warnings.push(written.warning)
    if (cleanup !== null && cleanup.failed.length > 0) {
      warnings.push('some scratch checkouts could not be removed: ' + cleanup.failed.map((entry) => entry.path).join(', '))
    }
    return ok({
      task: result.task,
      events: result.events,
      report: result.task === null ? null : result.task.report,
      reportFile: written.path,
      cleanup: cleanup,
      warnings: warnings,
    })
  }

  return { report: report }
}
