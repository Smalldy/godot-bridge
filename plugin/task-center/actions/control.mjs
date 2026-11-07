/**
 * Control actions: pause / settings / tick.
 *
 * These are the small dispatcher-control handlers that used to sit inline in
 * performResolved. They receive the API's mutate/model/scheduler helpers, so the
 * board CAS, clock and scheduling semantics are unchanged.
 */
export function createControlActions(deps) {
  const mutate = deps.mutate
  const model = deps.model
  const clock = deps.clock
  const scheduler = deps.scheduler
  const maybeArchive = deps.maybeArchive
  const ok = deps.ok
  const failure = deps.failure

  async function pause(source, context, projectPath) {
    const result = await mutate(
      projectPath,
      (board) => model.setDispatch(board, { state: 'paused' }, clock(), context.by),
      context,
    )
    if (result.ok !== true) return result
    return ok({ dispatch: result.board.dispatch, events: result.events })
  }

  async function settings(source, context, projectPath) {
    if (context === undefined || context === null || context.role !== 'user') {
      return failure('user-only', 'Dispatch settings belong to the user; ask them to change it in the task center panel.')
    }
    const patch = {}
    for (const key of ['maxConcurrent', 'allowSpawn', 'maxWorkAgents', 'maxAttempts', 'defaultTarget']) {
      if (source[key] !== undefined) patch[key] = source[key]
    }
    // The GUI exposes a single number: maximum concurrency. The worker cap and
    // spawning policy are derived so a user does not have to reason about two
    // capacity knobs. An explicit advanced value still wins.
    if (source.maxConcurrent !== undefined) {
      const concurrency = Number(source.maxConcurrent)
      if (Number.isFinite(concurrency)) patch.maxConcurrent = Math.floor(concurrency)
      if (source.maxWorkAgents === undefined && Number.isFinite(concurrency)) {
        patch.maxWorkAgents = Math.min(12, Math.max(1, Math.floor(concurrency) + 1))
      }
      if (source.allowSpawn === undefined) patch.allowSpawn = true
      if (source.maxAttempts === undefined) patch.maxAttempts = 3
    }
    if (Object.keys(patch).length === 0) return failure('no-change', 'no dispatch setting was supplied')
    const result = await mutate(
      projectPath,
      (board) => model.setDispatch(board, patch, clock(), context.by),
      context,
    )
    if (result.ok !== true) return result
    if (scheduler !== null) void scheduler.kick(projectPath)
    return ok({ dispatch: result.board.dispatch, events: result.events })
  }

  async function tick(source, context, projectPath) {
    if (scheduler === null) return failure('no-scheduler', 'the dispatcher is not available in this profile')
    const archiveResult = await maybeArchive(projectPath)
    return ok({ tick: await scheduler.settle(projectPath), archive: archiveResult })
  }

  return { pause: pause, settings: settings, tick: tick }
}
