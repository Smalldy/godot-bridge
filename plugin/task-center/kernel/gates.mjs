/**
 * Role/permission gates (kernel seam).
 *
 * Moved out of api.mjs with the predicates unchanged. verdictRefusal still
 * lives in api.mjs (it needs the roster/registry fallback and is the largest
 * gate); these four are the small, self-contained ones.
 */
export function createGates(deps) {
  const callerMemberOf = deps.callerMemberOf
  const callerRole = deps.callerRole
  const roles = deps.roles
  const MERGER_NAME = deps.MERGER_NAME
  const memberProjectOf = deps.memberProjectOf
  const roleSlotOf = deps.roleSlotOf
  const projectSlotKey = deps.projectSlotKey
  const projectIdOf = deps.projectIdOf
  const ctx = deps.ctx
  const failure = deps.failure

  function roleAdminRefusal(context, message) {
    if (context !== undefined && context !== null && context.role === 'user') return null
    return failure('user-only', message === undefined ? 'Role profiles belong to the user; manage them from the task center panel.' : message)
  }

  function mergeRefusal(context) {
    if (context !== undefined && context !== null && context.role === 'user') return null
    const member = callerMemberOf(context)
    if (member !== null && member.name === MERGER_NAME) return null
    return failure(
      'merger-only',
      'Only the user or the Team member named "' +
        MERGER_NAME +
        '" can merge or reject merge requests; everyone else reports done and lets the merger integrate.',
    )
  }

  function harnessRefusal(context) {
    if (context !== undefined && context !== null && context.role === 'user') return null
    if (roles === null) {
      return failure('tester-only', 'The isolated DSH harness is driven by the tester role (or the user); this profile has no role registry.')
    }
    const caller = callerRole(context)
    if (caller === null) return failure('role-required', 'Only a tester role member or the user can drive the isolated DSH harness.')
    if (caller.kind !== 'tester') {
      const name = caller.member.name === undefined || caller.member.name === null ? 'this agent' : String(caller.member.name)
      return failure('tester-only', 'Only a tester role member or the user can drive the isolated DSH harness; ' + name + ' is not one.')
    }
    return null
  }

  function wrongProjectRefusal(context, projectPath) {
    const member = callerMemberOf(context)
    if (member === null) return null
    const known = memberProjectOf(ctx, member.name)
    const slot = roleSlotOf(member.name)
    const callerKey = known !== null ? known.key : slot === null ? null : slot.project
    if (callerKey === null || callerKey === undefined || callerKey === '') return null
    if (callerKey === projectSlotKey(projectPath)) return null
    return failure(
      'wrong-project',
      'you were dispatched for another project (' + (known !== null ? known.root : 'slot ' + String(callerKey)) + '); this card belongs to ' + projectPath +
        '. Do not submit another project\'s card; a worker is only accepted by the board it was dispatched for.',
      { project: projectIdOf(projectPath), dispatchedFor: known === null ? callerKey : known.root },
    )
  }

  return {
    roleAdminRefusal: roleAdminRefusal,
    mergeRefusal: mergeRefusal,
    harnessRefusal: harnessRefusal,
    wrongProjectRefusal: wrongProjectRefusal,
  }
}
