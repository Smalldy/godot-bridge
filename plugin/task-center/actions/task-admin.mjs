/**
 * Task administration and dispatch-start actions:
 * create / update / delete / start / approveStart / rejectStart / cancelStartRequest.
 *
 * Extracted from performResolved with the handlers unchanged.
 */
export function createTaskAdminActions(deps) {
  const projectTeamFor = deps.projectTeamFor
  const callerSessionId = deps.callerSessionId
  const taskInput = deps.taskInput
  const checkTarget = deps.checkTarget
  const sessionIdOf = deps.sessionIdOf
  const mutate = deps.mutate
  const model = deps.model
  const clock = deps.clock
  const detailOf = deps.detailOf
  const writeTask = deps.writeTask
  const locks = deps.locks
  const state = deps.state
  const preflightRefusal = deps.preflightRefusal
  const readBoardOrFail = deps.readBoardOrFail
  const worktreeRefusal = deps.worktreeRefusal
  const scheduler = deps.scheduler
  const interruptAssignee = deps.interruptAssignee
  const ctx = deps.ctx
  const ok = deps.ok
  const failure = deps.failure

  async function create(source, context, projectPath) {
    // T-110: no cards before the project has a Team. The refusal carries the
    // instruction, so the calling session can bootstrap it and retry.
    const gate = await projectTeamFor(projectPath, callerSessionId(source, context))
    if (gate.team.available === true && gate.team.ok !== true) {
      return failure(
        'no-team-for-project',
        'This project has no Team (' + String(gate.team.error) + '), so a card cannot be created yet.',
        { team: gate.team, nextStep: gate.nextStep },
      )
    }
    const built = taskInput(projectPath, source)
    if (built.ok !== true) return built
    if (built.input.target !== undefined) {
      const checkedTarget = await checkTarget(projectPath, built.input.target)
      if (checkedTarget.ok !== true) return checkedTarget
      built.input.target = checkedTarget.target
    }
    const owner = sessionIdOf(context)
    const result = await mutate(
      projectPath,
      (board) => {
        const createdBoard = model.createTask(board, built.input, clock(), context.by)
        if (createdBoard.ok !== true || owner === null) return createdBoard
        // T-97: remember WHICH session created the card in the same write, so
        // dispatch only offers it to that session's team.
        const createdId = createdBoard.events.length === 0 ? null : createdBoard.events[0].id
        if (createdId === null) return createdBoard
        const tasks = createdBoard.board.tasks.map((entry) => (String(entry.id) === String(createdId) ? Object.assign({}, entry, { ownerSession: owner }) : entry))
        return { ok: true, board: Object.assign({}, createdBoard.board, { tasks: tasks }), events: createdBoard.events }
      },
      context,
    )
    if (result.ok !== true) return result
    const created = result.events.length === 0 ? null : result.events[0].id
    const task = created === null ? null : model.findTask(result.board, created)
    return ok({ task: task === null ? null : detailOf(result.board, task, clock()), events: result.events })
  }

  async function update(source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', 'update needs a task id')
    const built = taskInput(projectPath, source)
    if (built.ok !== true) return built
    if (built.input.target !== undefined) {
      const checkedTarget = await checkTarget(projectPath, built.input.target)
      if (checkedTarget.ok !== true) return checkedTarget
      built.input.target = checkedTarget.target
    }
    return writeTask(
      projectPath,
      id,
      (board) => model.updateTask(board, id, built.input, clock(), context.by),
      context,
    )
  }

  async function remove(source, context, projectPath) {
    const id = String(source.id === undefined ? '' : source.id)
    if (id === '') return failure('missing-id', 'delete needs a task id')
    const result = await mutate(
      projectPath,
      (board) => model.deleteTask(board, id, clock(), context.by, { force: source.force === true }),
      context,
    )
    if (result.ok !== true) return result
    const released = locks.releaseTask(state.memory.locks, id)
    if (released.ok === true) state.memory.locks = released.locks
    return ok({ deleted: id, events: result.events })
  }

  async function start(source, context, projectPath) {
    {
      const gate = await preflightRefusal(projectPath, { sessionId: callerSessionId(source, context) })
      if (gate !== null) return gate
    }
    if (context !== undefined && context !== null && context.role === 'agent') {
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      if (read.board.dispatch.state === 'running') {
        return ok({ dispatch: read.board.dispatch, alreadyRunning: true })
      }
      if (read.board.dispatch.request !== null) {
        return failure(
          'needs-consent',
          'A start request is already pending. Ask the user to approve it in the task center panel; do not retry.',
          { request: read.board.dispatch.request },
        )
      }
      const unavailable = await worktreeRefusal(projectPath)
      if (unavailable !== null) return unavailable
      const requested = await mutate(
        projectPath,
        (board) => model.requestDispatch(board, { by: context.by, note: source.note }, clock(), context.by),
        context,
      )
      if (requested.ok !== true) return requested
      return failure(
        'needs-consent',
        'Dispatch was requested, not started. Ask the user to approve it in the task center panel; do not retry.',
        { request: requested.board.dispatch.request },
      )
    }
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    if (read.board.dispatch.state !== 'running') {
      const unavailable = await worktreeRefusal(projectPath)
      if (unavailable !== null) return unavailable
    }
    const result = await mutate(
      projectPath,
      (board) => model.approveDispatch(board, clock(), context.by),
      context,
    )
    if (result.ok !== true) return result
    if (scheduler !== null) await scheduler.settle(projectPath)
    return ok({ dispatch: result.board.dispatch, events: result.events })
  }

  async function decideStart(action, source, context, projectPath) {
    if (context === undefined || context === null || context.role !== 'user') {
      return failure('user-only', 'Starting dispatch is the user\'s decision; ask them to approve it in the task center panel.')
    }
    if (action === 'approveStart') {
      {
        const gate = await preflightRefusal(projectPath, { sessionId: callerSessionId(source, context) })
        if (gate !== null) return gate
      }
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      if (read.board.dispatch.state !== 'running') {
        const unavailable = await worktreeRefusal(projectPath)
        if (unavailable !== null) return unavailable
      }
    }
    const result = await mutate(
      projectPath,
      (board) =>
        action === 'approveStart'
          ? model.approveDispatch(board, clock(), context.by)
          : model.clearDispatchRequest(board, clock(), context.by),
      context,
    )
    if (result.ok !== true) return result
    if (action === 'approveStart' && scheduler !== null) await scheduler.settle(projectPath)
    return ok({ dispatch: result.board.dispatch, events: result.events })
  }

  async function cancelStartRequest(source, context, projectPath) {
    const result = await mutate(
      projectPath,
      (board) => model.clearDispatchRequest(board, clock(), context.by),
      context,
    )
    if (result.ok !== true) return result
    // A request normally exists while dispatch is paused, but if anything had
    // already been dispatched, withdrawing the request stops it too.
    for (const task of result.board.tasks) {
      if (task.status !== 'running' || task.assignee === null || task.assignee === undefined) continue
      await interruptAssignee(ctx, task, { reason: 'the dispatch start request was withdrawn' })
    }
    return ok({ dispatch: result.board.dispatch, events: result.events })
  }

  return {
    create: create,
    update: update,
    delete: remove,
    start: start,
    approveStart: (source, context, projectPath) => decideStart('approveStart', source, context, projectPath),
    rejectStart: (source, context, projectPath) => decideStart('rejectStart', source, context, projectPath),
    cancelStartRequest: cancelStartRequest,
  }
}
