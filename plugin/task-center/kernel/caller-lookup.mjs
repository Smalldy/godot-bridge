/**
 * Caller lookup + owner/assignee resolution (kernel seam).
 *
 * callerLookup still walks every live Lead roster and the agent registry; it is
 * moved out of api.mjs together with the small owner/assignee helpers.
 */
export function createCallerLookup(deps) {
  const callerIdentifiers = deps.callerIdentifiers
  const callerRoleKindOf = deps.callerRoleKindOf
  const servicesFor = deps.servicesFor
  const ctx = deps.ctx
  const liveLeads = deps.liveLeads
  const resolveAnyLead = deps.resolveAnyLead
  const roleKindOf = deps.roleKindOf

  function callerLookup(context) {
    if (context === undefined || context === null) return { member: null, lead: null, leads: [], rosters: [], rosterErrors: [] }
    const { ids, names, by } = callerIdentifiers(context)
    if (ids.length === 0 && names.length === 0) return { member: null, lead: null, leads: [], rosters: [], rosterErrors: [] }
    const { agents, agentTeams } = servicesFor(ctx)
    if (agentTeams === undefined || agentTeams === null) return { member: null, lead: null, leads: [], rosters: [], rosterErrors: [] }
    // T-116 (review round 2): the AGENT REGISTRY is the first authority. A
    // subagent is a real agent even when no Lead roster lists it.
    const registry = { tried: [], found: null, role: null, name: null, error: null }
    if (agents !== undefined && agents !== null) {
      const candidates = []
      for (const id of ids) {
        registry.tried.push('agents.get(' + id + ')')
        try {
          const got = typeof agents.get === 'function' ? agents.get(id) : undefined
          if (got !== undefined && got !== null && typeof got.then !== 'function') candidates.push(got)
        } catch (error) {
          registry.error = String((error && error.message) || error)
        }
      }
      if (candidates.length === 0) {
        registry.tried.push('agents.list()')
        try {
          const listed = typeof agents.list === 'function' ? agents.list() : []
          for (const candidate of Array.isArray(listed) ? listed : []) {
            const idMatch = candidate !== null && typeof candidate === 'object' && candidate.id !== undefined && candidate.id !== null && ids.indexOf(String(candidate.id)) >= 0
            const nameMatch = candidate !== null && typeof candidate === 'object' && typeof candidate.name === 'string' && names.indexOf(candidate.name) >= 0
            if (idMatch || nameMatch) candidates.push(candidate)
          }
        } catch (error) {
          registry.error = String((error && error.message) || error)
        }
      }
      for (const candidate of candidates) {
        let membership = null
        try {
          membership = agentTeams.tryMembership(candidate)
        } catch (error) {
          membership = null
        }
        if (membership === undefined || membership === null) continue
        const name = typeof candidate.name === 'string' && candidate.name !== '' ? candidate.name : typeof membership.name === 'string' ? membership.name : null
        registry.found = candidate
        registry.role = typeof membership.role === 'string' ? membership.role : null
        registry.name = name
        break
      }
    }
    let leads = liveLeads(ctx)
    if (leads.length === 0) {
      const legacy = resolveAnyLead(ctx)
      if (legacy !== null) leads = [legacy]
    }
    const rosters = []
    // T-116: a roster that cannot be read is a DIAGNOSTIC, never a silent "nobody".
    const rosterErrors = []
    for (const lead of leads) {
      let members = []
      try {
        members = agentTeams.listMembers(lead)
      } catch (error) {
        rosterErrors.push({ lead: lead, error: String((error && error.message) || error) })
        continue
      }
      if (!Array.isArray(members)) {
        rosterErrors.push({ lead: lead, error: 'listMembers returned a non-array' })
        continue
      }
      rosters.push({ lead: lead, members: members })
    }
    // Registry match first: a subagent may be absent from every Lead roster.
    if (registry.found !== null) {
      const row = registry.found
      const rowId = row.id === undefined || row.id === null ? null : String(row.id)
      const rowName = typeof row.name === 'string' && row.name !== '' ? row.name : registry.name
      let ownerLead = null
      for (const entry of rosters) {
        const listed = entry.members.filter(
          (member) =>
            member !== null &&
            typeof member === 'object' &&
            ((rowId !== null && member.id !== undefined && member.id !== null && String(member.id) === rowId) || (rowName !== null && member.name === rowName)),
        )[0]
        if (listed !== undefined) {
          ownerLead = entry.lead
          break
        }
      }
      const member = { id: rowId, name: rowName, role: registry.role }
      return { member: member, lead: ownerLead, leads: leads, rosters: rosters, rosterErrors: rosterErrors, registry: registry, source: 'registry' }
    }
    // 1) exact member id / session.
    for (const entry of rosters) {
      for (const member of entry.members) {
        if (member === null || typeof member !== 'object' || member.id === undefined || member.id === null) continue
        if (ids.indexOf(String(member.id)) >= 0) return { member: member, lead: entry.lead, leads: leads, rosters: rosters, rosterErrors: rosterErrors }
      }
    }
    // 2) exact member name / display label.
    for (const entry of rosters) {
      for (const member of entry.members) {
        if (member === null || typeof member !== 'object' || typeof member.name !== 'string') continue
        if (names.indexOf(member.name) >= 0) return { member: member, lead: entry.lead, leads: leads, rosters: rosters, rosterErrors: rosterErrors }
      }
    }
    // 3) logical role alias: durable tester-1 <-> project slot tester-p<key>-1.
    const wantedKinds = []
    for (const value of names.concat(ids)) {
      const kind = callerRoleKindOf(value)
      if (kind !== null && wantedKinds.indexOf(kind) < 0) wantedKinds.push(kind)
    }
    for (const entry of rosters) {
      for (const member of entry.members) {
        if (member === null || typeof member !== 'object' || typeof member.name !== 'string') continue
        const kind = callerRoleKindOf(member.name)
        if (kind !== null && wantedKinds.indexOf(kind) >= 0) return { member: member, lead: entry.lead, leads: leads, rosters: rosters, rosterErrors: rosterErrors }
      }
    }
    return { member: null, lead: null, leads: leads, rosters: rosters, rosterErrors: rosterErrors, registry: registry, by: by }
  }

  function callerMemberOf(context) {
    const found = callerLookup(context)
    return found.member === undefined ? null : found.member
  }

  function callerRole(context) {
    const member = callerMemberOf(context)
    if (member === null) return null
    return { member: member, kind: roleKindOf(member.name) }
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
