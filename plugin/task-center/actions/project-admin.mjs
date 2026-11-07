/**
 * Project administration actions:
 * skillsCatalog / worktreesCleanup / bootstrapTeam.
 *
 * Extracted from performResolved with the handlers unchanged.
 */
export function createProjectAdminActions(deps) {
  const roleAdminRefusal = deps.roleAdminRefusal
  const skillsCatalog = deps.skillsCatalog
  const readBoardOrFail = deps.readBoardOrFail
  const worktreesCleanup = deps.worktreesCleanup
  const callerSessionId = deps.callerSessionId
  const bootstrapTeamFor = deps.bootstrapTeamFor
  const teamBootstrapStep = deps.teamBootstrapStep
  const ok = deps.ok

  async function runSkillsCatalog(source, context, projectPath) {
    const denied = roleAdminRefusal(context, 'The skill catalog belongs to the user; open it from the task center panel.')
    if (denied !== null) return denied
    return skillsCatalog(projectPath)
  }

  async function runWorktreesCleanup(source, context, projectPath) {
    // T-142: removing stale checkouts is a user decision. The tool does not
    // expose this action; a direct agent call is refused here as well.
    const denied = roleAdminRefusal(context, 'Worktree cleanup belongs to the user; run it from the task center panel.')
    if (denied !== null) return denied
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    return worktreesCleanup(projectPath, read.board, source)
  }

  async function runBootstrapTeam(source, context, projectPath) {
    // T-121: an agent can bootstrap its OWN team instead of asking the user.
    // T-129: onboarding calls the SAME routine, so a team is only ever built
    // one way (and a second onboard while the team is ok builds nothing).
    const sessionId = callerSessionId(source, context)
    const boot = await bootstrapTeamFor(projectPath, sessionId)
    if (boot.ok !== true) return boot
    return ok({ bootstrap: true, session: boot.session, lead: boot.lead, roles: boot.roles, deferred: boot.deferred, team: boot.team, nextStep: teamBootstrapStep(boot.team) })
  }

  return {
    skillsCatalog: runSkillsCatalog,
    worktreesCleanup: runWorktreesCleanup,
    bootstrapTeam: runBootstrapTeam,
  }
}
