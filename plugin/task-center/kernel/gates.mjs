/**
 * Role/permission gates (kernel seam).
 *
 * The Team roster is gone; a caller is judged by its own Agent identity.
 */
export function createGates(deps) {
  const callerRole = deps.callerRole
  const failure = deps.failure

  function roleAdminRefusal(context, message) {
    if (context !== undefined && context !== null && context.role === 'user') return null
    return failure('user-only', message === undefined ? 'Role profiles belong to the user; manage them from the task center panel.' : message)
  }

  function mergeRefusal(context) {
    // v3: merge belongs to the user (or the host's auto-merge sweep). No Agent
    // role is a merger, and a worker cannot integrate its own task.
    if (context !== undefined && context !== null && context.role === 'user') return null
    return failure('user-only', 'Merge and reject belong to the user (or the host auto-merge). Report done from the worker; the host integrates the tested candidate.')
  }

  function harnessRefusal(context) {
    if (context !== undefined && context !== null && context.role === 'user') return null
    const caller = callerRole(context)
    if (caller === null) return failure('role-required', 'Only a tester child or the user can drive the isolated DSH harness.')
    if (caller.kind !== 'tester') {
      const name = caller.member.name === undefined || caller.member.name === null ? 'this agent' : String(caller.member.name)
      return failure('tester-only', 'Only a tester child or the user can drive the isolated DSH harness; ' + name + ' is not one.')
    }
    return null
  }

  return {
    roleAdminRefusal: roleAdminRefusal,
    mergeRefusal: mergeRefusal,
    harnessRefusal: harnessRefusal,
  }
}
