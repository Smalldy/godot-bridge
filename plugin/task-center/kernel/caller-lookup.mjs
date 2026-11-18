/**
 * Caller lookup + owner/assignee resolution (kernel seam).
 *
 * v3 has no Team roster: the caller is the exact Agent the tool layer hands over
 * (a child of the card's root). Its role kind is read from the child's name.
 */
export function createCallerLookup(deps) {
  const callerIdentifiers = deps.callerIdentifiers
  const roleKindOfAgentName = deps.roleKindOfAgentName

  function callerLookup(context) {
    const { ids, names, by } = callerIdentifiers(context)
    const agent = context === undefined || context === null || context.agent === undefined || context.agent === null ? null : context.agent
    if (agent === null) return { member: null, ids: ids, names: names, by: by }
    const id = ids.length > 0 ? ids[0] : null
    const name = names.length > 0 ? names[0] : null
    return {
      member: { id: id, name: name, role: roleKindOfAgentName(name === null ? '' : name) },
      ids: ids,
      names: names,
      by: by,
    }
  }

  function callerMemberOf(context) {
    const found = callerLookup(context)
    return found.member === undefined ? null : found.member
  }

  function callerRole(context) {
    const member = callerMemberOf(context)
    if (member === null) return null
    return { member: member, kind: member.role }
  }

  function ownerOf(context) {
    if (context === undefined || context === null) return null
    if (context.role === 'user') return null
    // The unified heartbeat path calls this for EVERY action, so an explicit
    // "no agent" (null) must read as "no owner" instead of throwing.
    const agent = context.agent === undefined || context.agent === null ? null : context.agent
    return { session: agent === null || agent.id === undefined || agent.id === null ? null : agent.id, name: context.by }
  }

  function assigneeMatches(task, owner) {
    if (owner === null) return true
    if (task.assignee === null) return true
    if (owner.session !== null && owner.session !== undefined && task.assignee.session === owner.session) return true
    if (owner.name !== null && owner.name !== undefined && task.assignee.name === owner.name) return true
    // A claim with no session cannot be verified; refusing would strand the
    // task on an identity the tool layer cannot see.
    return task.assignee.session === null || task.assignee.session === undefined
  }

  return {
    callerLookup: callerLookup,
    callerMemberOf: callerMemberOf,
    callerRole: callerRole,
    ownerOf: ownerOf,
    assigneeMatches: assigneeMatches,
  }
}
