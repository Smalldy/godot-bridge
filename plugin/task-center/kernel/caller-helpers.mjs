/**
 * Caller identifier/roster helpers (kernel seam).
 *
 * callerLookup stays in api.mjs (it walks every Lead roster and the agent
 * registry); these four pure helpers are shared by it and the verdict gate.
 */
export function createCallerHelpers(deps) {
  const roleKindOf = deps.roleKindOf

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
    const kind = roleKindOf(trimmed)
    if (kind !== null) return kind
    // A durable member name may be plain 'tester-1' while the project slot is
    // tester-p<key>-1; strip the session prefix to compare logically.
    const short = trimmed.replace(/^session-/, '')
    return roleKindOf(short)
  }

  function rosterSummary(rosters, rosterErrors, leads) {
    const lines = []
    const readable = Array.isArray(rosters) ? rosters : []
    const errors = Array.isArray(rosterErrors) ? rosterErrors : []
    for (const entry of readable) {
      const lead = entry.lead === null || entry.lead === undefined ? null : entry.lead
      const leadName = lead === null ? '?' : String(lead.name === undefined || lead.name === null ? lead.id : lead.name)
      const leadId = lead === null || lead.id === undefined || lead.id === null ? '?' : String(lead.id)
      const roles = entry.members
        .filter((member) => member !== null && typeof member === 'object' && typeof member.name === 'string')
        .map((member) => callerRoleKindOf(member.name) || member.name)
        .filter((value, index, all) => all.indexOf(value) === index)
      lines.push(leadName + ' (' + leadId + ') -> ' + (roles.length === 0 ? '(roster is empty)' : roles.join(', ')))
    }
    for (const entry of errors) {
      const lead = entry.lead === null || entry.lead === undefined ? null : entry.lead
      const leadId = lead === null || lead.id === undefined || lead.id === null ? '?' : String(lead.id)
      const leadName = lead === null || lead.name === undefined || lead.name === null ? leadId : String(lead.name)
      lines.push(leadName + ' (' + leadId + ') -> roster unavailable: ' + String(entry.error))
    }
    if (lines.length === 0) {
      const count = Array.isArray(leads) ? leads.length : 0
      return count === 0 ? 'no live Lead is visible to this host' : 'no Lead roster could be read (' + String(count) + ' Lead(s) listed)'
    }
    return lines.join('; ')
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
    rosterSummary: rosterSummary,
    isAssignee: isAssignee,
  }
}
