/**
 * Onboarding action.
 *
 * Moved out of api.mjs with the function body unchanged. It resolves the
 * project, binds it, reuses/bootstraps the Team, reads the board and renders
 * the short brief plus one next step.
 */
export function createOnboardAction(deps) {
  const callerSessionId = deps.callerSessionId
  const clock = deps.clock
  const onboardWorkspaceOf = deps.onboardWorkspaceOf
  const state = deps.state
  const resolveOnboardRoot = deps.resolveOnboardRoot
  const ctx = deps.ctx
  const renderOnboardBrief = deps.renderOnboardBrief
  const renderProjectLine = deps.renderProjectLine
  const ONBOARD_VERSION = deps.ONBOARD_VERSION
  const onboardProjectSummary = deps.onboardProjectSummary
  const onboardTeamSummary = deps.onboardTeamSummary
  const onboardDispatchSummary = deps.onboardDispatchSummary
  const needsUserFor = deps.needsUserFor
  const decideOnboardStage = deps.decideOnboardStage
  const selectOnboardNext = deps.selectOnboardNext
  const preflightProject = deps.preflightProject
  const checkTextOf = deps.checkTextOf
  const resolveProjectRoot = deps.resolveProjectRoot
  const projectIdOf = deps.projectIdOf
  const sessionOwnsProject = deps.sessionOwnsProject
  const remember = deps.remember
  const git = deps.git
  const roles = deps.roles
  const bootstrapTeamFor = deps.bootstrapTeamFor
  const projectTeamFor = deps.projectTeamFor
  const summariseBoard = deps.summariseBoard
  const boardSizeOf = deps.boardSizeOf
  const environmentSnapshot = deps.environmentSnapshot
  const messageOf = deps.messageOf
  const renderTaskLine = deps.renderTaskLine
  const blockedSuffixOf = deps.blockedSuffixOf
  const teamLabelOf = deps.teamLabelOf
  // T-153: the handoff inventory and the two user decisions it offers.
  const handoffFor = deps.handoffFor
  const performTakeover = deps.performTakeover
  const recordJoin = deps.recordJoin
  const ok = deps.ok
  const failure = deps.failure

  async function onboard(input, context) {
    const source = input === undefined || input === null ? {} : input
    // The route injects the panel's resolved project; onboarding deliberately
    // ignores it and follows its own contract (explicit path, then the session
    // workspace) so a last-active panel binding cannot hijack the answer.
    const sessionId = callerSessionId(source, context)
    const now = clock()
    const setup = { did: [], failed: [] }
    const warnings = []
    const attention = []
    const explicit = typeof source.path === 'string' && source.path.trim() !== '' ? source.path.trim() : null
    const workspace = explicit === null ? await onboardWorkspaceOf(context, sessionId) : null
    const base = state.memory.projectHint === null ? process.cwd() : state.memory.projectHint
    const resolved = await resolveOnboardRoot(
      { fs: ctx.fs },
      {
        explicit: explicit,
        workspace: workspace === null ? '' : workspace,
        cwd: explicit === null ? (workspace === null ? base : workspace) : base,
      },
    )
    if (resolved.kind === 'invalid') return failure('not-a-directory', 'not a directory: ' + String(resolved.path))
    const facts = {
      kind: resolved.kind,
      root: resolved.kind === 'none' ? null : resolved.path,
      workspace: workspace,
      checked: resolved.checked,
      git: resolved.git === true,
      godot: resolved.godot === true,
      preflightOk: null,
      preflightMissing: [],
      branch: null,
      head: null,
      counts: null,
      readyCount: 0,
      blocked: [],
      blockedCount: 0,
      active: [],
      activeCount: 0,
      dispatchState: null,
      request: null,
      environment: null,
      hardDirty: false,
      boardSize: null,
      boardWarning: null,
      boardExisted: false,
      team: null,
      teamFailed: false,
      teamFailureCode: null,
      teamError: null,
      missingRoles: [],
      // T-153: other sessions' in-progress cards (see handoff.mjs) and whether
      // this session still has to decide about them.
      handoff: null,
      handoffBlocked: false,
      stage: null,
    }

    /** The short answer for a project that could not be bound: 3 lines at most. */
    function shortOnboard(stage, problem, next, projectPath) {
      const path = projectPath === undefined || projectPath === null ? (typeof facts.root === 'string' && facts.root !== '' ? facts.root : facts.workspace) : projectPath
      const brief = renderOnboardBrief({
        stage: stage,
        projectLine: renderProjectLine({ kind: facts.kind, path: path === undefined || path === null ? '' : String(path), branch: facts.branch, head: facts.head }),
        problem: problem,
        next: next,
      })
      return ok({
        onboard: {
          version: ONBOARD_VERSION,
          stage: stage,
          brief: brief,
          project: onboardProjectSummary(facts),
          team: onboardTeamSummary(null, false, null),
          dispatch: onboardDispatchSummary(null),
          environment: null,
          setup: setup,
          attention: attention,
          needsUser: needsUserFor(next, facts),
          warnings: warnings,
          next: next,
          handoff: facts.handoff === undefined ? null : facts.handoff,
          takeover: null,
          checkedAt: new Date(now).toISOString(),
        },
      })
    }

    // ── markers and root: no git / not a project / nothing found ─────────────
    if (facts.kind !== 'root') {
      const stage = decideOnboardStage(facts)
      const next = selectOnboardNext(facts)
      const checked = Array.isArray(facts.checked) ? facts.checked.filter((entry) => typeof entry === 'string' && entry !== '') : []
      const checkedText = checked.length === 0 ? '会话工作区' : checked.map((entry) => (entry.length > 120 ? entry.slice(0, 120) + '…' : entry)).join('、')
      const problem =
        facts.kind === 'gitless'
          ? '有 project.godot，但还不是 git 仓库；我不会自己跑 git init。'
          : facts.kind === 'git-only'
            ? '是 git 仓库，但没有 project.godot 或 .agents/；我不在这里建板。'
            : facts.kind === 'plain'
              ? '这个目录既不是 git 仓库，也没有 project.godot 或 .agents/。'
              : '从 ' + (workspace === null ? '会话工作区' : String(workspace)) + ' 向上找过 ' + checkedText + '，都没有带 project.godot 或 .agents/ 的 git 仓库；我不会猜。'
      return shortOnboard(stage, problem, next)
    }

    // ── binding (the safe subset of openProject) ────────────────────────────
    const root = String(resolved.path)
    if (git !== null && typeof git.currentBranch === 'function') {
      try {
        const branch = await git.currentBranch(root)
        if (branch !== null && branch !== undefined && branch.ok === true && typeof branch.branch === 'string' && branch.branch !== '') facts.branch = branch.branch
      } catch (error) {}
    }
    if (git !== null && typeof git.head === 'function') {
      try {
        const head = await git.head(root)
        if (head !== null && head !== undefined && head.ok === true && typeof head.hash === 'string' && head.hash !== '') facts.head = head.hash.slice(0, 7)
      } catch (error) {}
    }
    const preflight = await preflightProject(root, { sessionId: sessionId })
    const openFailed = Array.isArray(preflight.openFailed) ? preflight.openFailed : Array.isArray(preflight.failed) ? preflight.failed : []
    facts.preflightOk = preflight.openOk === true
    facts.preflightMissing = openFailed.map((check) => checkTextOf(check))
    if (facts.preflightOk !== true) {
      const problem = '项目还不能用：' + (facts.preflightMissing.length === 0 ? '未知原因' : facts.preflightMissing.join('、')) + '。'
      return shortOnboard('unusable', problem, selectOnboardNext(facts), root)
    }
    // Ownership is judged BEFORE the binding below: onboarding adopts the project
    // for the session, so asking after it would make every session "own" it and
    // the project-mismatch refusal could never fire (T-129 §4.1).
    let ownsProject = null
    if (sessionId !== null) {
      const prior = typeof state.sessionRootOf === 'function' ? state.sessionRootOf(sessionId) : null
      const sessionWorkspace = typeof prior === 'string' && prior !== '' ? prior : workspace
      if (typeof sessionWorkspace === 'string' && sessionWorkspace !== '') {
        const sessionWalk = await resolveProjectRoot({ fs: ctx.fs }, { explicit: null, sessionRoot: sessionWorkspace })
        const sessionProject = sessionWalk.ok === true ? sessionWalk.root : sessionWorkspace
        ownsProject = projectIdOf(sessionProject) === projectIdOf(root)
      } else {
        ownsProject = await sessionOwnsProject(state, sessionId, root)
      }
    }
    remember(root, sessionId)
    // T-152: the onboarding session joins the project's participating-session SET
    // (explicitly null when this caller has no identity), never undefined.
    state.touchProject(root, sessionId, { worktreeRoot: preflight.worktreeRoot, preflight: preflight })
    if (sessionId !== null && state !== null && typeof state.setSessionRoot === 'function') {
      try {
        state.setSessionRoot(sessionId, root)
      } catch (error) {}
    }
    if (typeof state.flushRegistry === 'function') await state.flushRegistry()
    const registry = typeof state.registryStatus === 'function' ? state.registryStatus() : null
    setup.did.push({
      step: 'project-bound',
      ok: true,
      detail: registry === null || registry === undefined ? 'registry-unavailable' : registry.ok === true ? String(registry.location === null ? 'registry-unavailable' : registry.location) : String(registry.error),
    })
    if (registry !== null && registry !== undefined && registry.ok !== true) {
      warnings.push('项目登记表没写进去：' + String(registry.error === null || registry.error === undefined ? '原因未知' : registry.error) + '；重启后可能找不到这个项目。')
    }

    // ── board + handoff inventory BEFORE any Team bootstrap (T-153) ─────────
    // The board is project state; a new session must see who still owns
    // in-flight cards BEFORE the host could bootstrap a second team.
    const read = await state.read(root)
    if (read.failed !== null) {
      facts.preflightOk = false
      facts.preflightMissing = ['看板读不出来：' + String(read.failed.message === undefined ? read.failed.code : read.failed.message)]
      return shortOnboard('unusable', '看板读不出来：' + String(read.failed.message === undefined ? read.failed.code : read.failed.message), selectOnboardNext(facts), root)
    }
    let board = read.board
    let handoff = handoffFor(root, board, sessionId)
    let takeoverResult = null
    const decisionInput = source.handoff !== undefined && source.handoff !== null && typeof source.handoff === 'object' ? source.handoff : null
    if (decisionInput !== null) {
      const decision = typeof decisionInput.decision === 'string' ? decisionInput.decision : ''
      if (decision === 'takeover') {
        const outcome = await performTakeover(root, sessionId, decisionInput, context)
        if (outcome.ok !== true) return outcome
        board = outcome.board
        takeoverResult = outcome.takeover
        setup.did.push({ step: 'handoff-takeover', ok: true, detail: outcome.takeover.taskIds.join('、') })
        handoff = handoffFor(root, board, sessionId)
      } else if (decision === 'join-read-only') {
        const outcome = await recordJoin(root, sessionId, decisionInput, context)
        if (outcome.ok !== true) return outcome
        board = outcome.board
        setup.did.push({ step: 'handoff-join', ok: true, detail: '只读加入' })
        handoff = handoffFor(root, board, sessionId)
      } else {
        return failure('bad-handoff-decision', 'handoff.decision must be "takeover" or "join-read-only"')
      }
    }
    const handoffBlocked = handoff.required === true && (handoff.decision === null || handoff.decision === undefined)
    facts.handoff = handoff
    facts.handoffBlocked = handoffBlocked

    // ── Team: reuse when ok, bootstrap ONCE when missing — but NEVER while
    //    another session's in-progress cards are unresolved (T-153) ─────────
    const teamRead = await projectTeamFor(root, sessionId)
    let team = teamRead.team
    let bootstrapped = false
    let bootstrappedRoles = null
    let teamFailed = false
    let teamFailureCode = null
    let teamError = null
    if (handoffBlocked) {
      // No second team: the handoff decision comes first. The session's own team
      // state is still reported, and nothing is created.
      setup.did.push({ step: 'handoff-pending', ok: true, detail: String(handoff.reason === null || handoff.reason === undefined ? 'handoff' : handoff.reason) })
      if (team.available !== true) warnings.push('本环境没有团队服务（单机模式）：建卡和派发不走团队。')
    } else if (team.available !== true) {
      warnings.push('本环境没有团队服务（单机模式）：建卡和派发不走团队。')
    } else if (team.ok === true) {
      setup.did.push({ step: 'team-ready', ok: true, detail: typeof team.lead === 'string' ? team.lead : '' })
    } else {
      const owns = ownsProject
      if (sessionId === null) {
        teamFailureCode = 'no-session-context'
        teamError = '这个请求没有会话身份，无法建团队'
      } else if (owns !== true) {
        teamFailureCode = 'project-mismatch'
        teamError = '这个会话不属于该项目'
      } else if (roles === null || typeof roles.ensure !== 'function') {
        teamFailureCode = 'no-role-manager'
        teamError = '这个环境没有角色管理器'
      } else {
        const boot = await bootstrapTeamFor(root, sessionId)
        if (boot.ok === true) {
          bootstrapped = true
          bootstrappedRoles = boot.roles
          const created = boot.roles.filter((entry) => entry.ok === true).map((entry) => entry.kind)
          setup.did.push({ step: 'team-bootstrap', ok: true, detail: created.join('、') })
          const reread = await projectTeamFor(root, sessionId)
          team = reread.team
          if (team.ok === true) setup.did.push({ step: 'team-ready', ok: true, detail: typeof team.lead === 'string' ? team.lead : '' })
        } else {
          teamFailureCode = typeof boot.code === 'string' ? boot.code : 'bootstrap-failed'
          teamError = String(boot.message === undefined ? '团队建立失败' : boot.message)
        }
      }
    }
    if (handoffBlocked !== true && team.available !== false && team.ok !== true) {
      // An unresolved handoff is not a Team failure: the session simply may not
      // build a second team yet (T-153), so the stage stays 'handoff'.
      teamFailed = true
      if (teamFailureCode === null) teamFailureCode = typeof team.error === 'string' && team.error !== '' ? team.error : 'no-members'
      if (teamError === null) teamError = team.error === undefined || team.error === null ? '团队仍然不完整' : String(team.error)
      setup.failed.push({ step: 'team-bootstrap', code: teamFailureCode, message: teamError })
    }
    facts.team = team
    facts.teamFailed = teamFailed
    facts.teamFailureCode = teamFailureCode
    facts.teamError = teamError
    facts.missingRoles = team !== null && team !== undefined && Array.isArray(team.missingRoles) ? team.missingRoles : []

    // ── board facts (compact) ───────────────────────────────────────────────
    const summary = summariseBoard(board)
    const dispatch = summary.dispatch
    const dispatchState = dispatch !== null && dispatch !== undefined && typeof dispatch.state === 'string' ? dispatch.state : null
    const request = dispatch !== null && dispatch !== undefined && dispatch.request !== undefined && dispatch.request !== null ? dispatch.request : null
    facts.boardExisted = read.existed === true
    facts.counts = summary.counts
    facts.readyCount = summary.ready
    facts.blocked = summary.blocked
    facts.blockedCount = summary.counts.blocked
    facts.active = summary.active
    facts.activeCount = Number(summary.counts.running) + Number(summary.counts.reviewing) + Number(summary.counts.testing)
    facts.dispatchState = dispatchState
    facts.request = request
    const boardSize = await boardSizeOf(root, board)
    facts.boardSize = boardSize
    facts.boardWarning = boardSize.warning === null || boardSize.warning === undefined ? null : String(boardSize.warning)
    let environment = null
    if (dispatchState === 'running') {
      try {
        const env = await environmentSnapshot(root, now, board)
        environment = {
          clean: env.clean === undefined ? null : env.clean,
          code: env.code === undefined ? null : env.code,
          message: env.message === undefined ? null : env.message,
          transient: env.transient === true,
          dirty: Array.isArray(env.dirty) ? env.dirty : [],
        }
      } catch (error) {
        environment = { clean: null, code: 'environment-unreadable', message: messageOf(error), transient: false, dirty: [] }
      }
    }
    facts.environment = environment
    facts.hardDirty = environment !== null && environment.clean === false && environment.transient !== true

    // ── attention (what the user should see) ────────────────────────────────
    for (const task of summary.blocked) {
      attention.push({ code: 'blocked', level: 'warn', message: task.id + ' 卡住：' + task.reason, taskId: task.id })
    }
    if (request !== null) {
      attention.push({ code: 'approval', level: 'info', message: '有 1 个派发申请等用户批准', requestId: typeof request.id === 'string' ? request.id : null })
    }
    if (facts.hardDirty) {
      attention.push({ code: 'environment', level: 'warn', message: '主检出的环境有问题：' + String(environment.message === null || environment.message === '' ? environment.code : environment.message) })
    }
    if (facts.boardWarning !== null) {
      attention.push({ code: 'board-size', level: 'warn', message: '看板已经用到 ' + String(boardSize.percent) + '%，归档已完成卡能腾出空间', detail: facts.boardWarning })
    }

    // ── stage, ONE next step, brief ─────────────────────────────────────────
    const stage = decideOnboardStage(facts)
    facts.stage = stage
    const next = selectOnboardNext(facts)
    const needsUser = needsUserFor(next, facts)
    const counts = summary.counts
    const taskLine = renderTaskLine({
      pending: counts.pending,
      running: counts.running,
      reviewing: counts.reviewing,
      testing: counts.testing,
      done: counts.done,
      blocked: blockedSuffixOf(summary.blocked, counts.blocked),
    })
    const brief = renderOnboardBrief({
      stage: stage,
      projectLine: renderProjectLine({ kind: 'root', path: root, branch: facts.branch, head: facts.head }),
      taskLine: taskLine,
      team: { label: teamLabelOf(team) },
      dispatchState: dispatchState,
      queue: summary.ready,
      active: summary.active,
      activeTotal: summary.activeTotal,
      needsUser: needsUser,
      attention: attention,
      warnings: warnings,
      next: next,
      handoff: handoff,
    })
    return ok({
      onboard: {
        version: ONBOARD_VERSION,
        stage: stage,
        brief: brief,
        project: onboardProjectSummary(facts),
        team: onboardTeamSummary(team, bootstrapped, bootstrappedRoles),
        dispatch: onboardDispatchSummary(dispatch),
        environment: environment,
        setup: setup,
        attention: attention,
        needsUser: needsUser,
        warnings: warnings,
        next: next,
        // T-153: the structured handoff block (required/reason/sessions/cards/
        // eligibility/decision) and, when a takeover ran in this call, its audit
        // summary. A caller decides from handoff + next, never from the brief text.
        handoff: handoff,
        takeover: takeoverResult,
        checkedAt: new Date(now).toISOString(),
      },
    })
  }


  return { onboard: onboard }
}
