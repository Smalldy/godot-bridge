/**
 * Caller identifier helpers (kernel seam).
 *
 * A caller is the Agent the tool layer hands over. Its role kind comes from the
 * spawned child's name (worker-/reviewer-/tester-), never from a Team roster.
 */
export function createCallerHelpers(deps) {
  const roleKindOfAgentName = deps.roleKindOfAgentName

  function callerIdentifiers(context) {
    const agent = context !== undefined && context !== null && context.agent !== undefined && context.agent !== null ? context.agent : null
    const by = context !== undefined && context !== null && typeof context.by === 'string' && context.by.length > 0 ? context.by : null
    const ids = []
    const names = []
    if (agent !== null) {
      if (agent.id !== undefined && agent.id !== null && String(agent.id) !== '') ids.push(String(agent.id))
      if (agent.session !== undefined && agent.session !== null && String(agent.session) !== '') ids.push(String(agent.session))
      if (agent.name !== undefined && agent.name !== null && String(agent.name) !== '') names.push(String(agent.name))
    }
    if (by !== null) {
      names.push(by)
      if (by.charAt(0) === '@') names.push(by.slice(1))
    }
    return { ids: ids, names: names, by: by }
  }

  function callerRoleKindOf(value) {
    if (typeof value !== 'string' || value === '') return null
    const trimmed = value.charAt(0) === '@' ? value.slice(1) : value
    return roleKindOfAgentName(trimmed)
  }

  function isAssignee(task, member) {
    if (task === null || task === undefined || task.assignee === null || task.assignee === undefined || member === null) return false
    const sessionMatch = member.id !== undefined && member.id !== null && task.assignee.session !== null && task.assignee.session !== undefined && String(member.id) === String(task.assignee.session)
    const nameMatch = member.name !== undefined && member.name !== null && task.assignee.name === member.name
    return sessionMatch || nameMatch
  }

  return {
    callerIdentifiers: callerIdentifiers,
    callerRoleKindOf: callerRoleKindOf,
    isAssignee: isAssignee,
  }
}
