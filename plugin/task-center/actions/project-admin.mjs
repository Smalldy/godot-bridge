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

  return {
    skillsCatalog: runSkillsCatalog,
    worktreesCleanup: runWorktreesCleanup,
  }
}
