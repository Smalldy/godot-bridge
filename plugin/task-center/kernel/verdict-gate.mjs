/**
 * Review/test verdict role gate (kernel seam).
 *
 * Moved out of api.mjs with the predicate unchanged. It still uses the
 * callerLookup roster/registry fallback and the deliveredTo authority.
 */
export function createVerdictGate(deps) {
  const roles = deps.roles
  const callerLookup = deps.callerLookup
  const callerIdentifiers = deps.callerIdentifiers
  const roleKindOf = deps.roleKindOf
  const callerRoleKindOf = deps.callerRoleKindOf
  const agentSessionOf = deps.agentSessionOf
  const isAssignee = deps.isAssignee
  const rosterSummary = deps.rosterSummary
  const failure = deps.failure

  function verdictRefusal(context, task, kind) {
    if (roles === null) return null
    if (context !== undefined && context !== null && context.role === 'user') return null
    const found = callerLookup(context)
    const { ids, names } = callerIdentifiers(context)
    // T-116 (b): the member the HOST handed this stage to is authoritative even
    // when it has since left the Lead's roster (drain/replace).
    const stageRecord = task === null || task === undefined ? null : kind === 'reviewer' ? task.review : task.test
    const delivered = stageRecord === null || stageRecord === undefined || stageRecord.deliveredTo === undefined || stageRecord.deliveredTo === null ? null : stageRecord.deliveredTo
    const deliveredMatch =
      delivered !== null &&
      ((delivered.id !== null && delivered.id !== undefined && ids.indexOf(String(delivered.id)) >= 0) ||
        (delivered.name !== null && delivered.name !== undefined && names.indexOf(String(delivered.name)) >= 0))
    if (deliveredMatch) return null
    if (found.member === null || found.member === undefined) {
      const registry = found.registry === undefined || found.registry === null ? null : found.registry
      const registryText =
        registry === null
          ? 'registry: 不可用'
          : 'registry: ' +
            (registry.found === null ? 'not found' : 'role ' + String(registry.role) + (registry.name === null ? '' : ' name ' + String(registry.name))) +
            '（已尝试 ' + registry.tried.join(', ') + '）'
      return failure(
        'role-required',
        '你在 ' + rosterSummary(found.rosters, found.rosterErrors, found.leads) + ' 里没有 ' + kind + ' 角色；' + registryText +
          '；已尝试 agent 注册表与 ' + String(Array.isArray(found.leads) ? found.leads.length : 0) + ' 个 Lead roster。只有该角色的成员、这张卡当前阶段的交付对象或用户能记录此裁决。',
      )
    }
    const caller = { member: found.member, kind: roleKindOf(found.member.name) === null ? callerRoleKindOf(found.member.name) : roleKindOf(found.member.name) }
    // T-112: a verdict belongs to the team of the session that OWNS the card.
    // A tester from another Lead's roster must not decide this card.
    const cardSession = task !== null && task !== undefined && typeof task.ownerSession === 'string' && task.ownerSession !== '' ? task.ownerSession : null
    const leadSession = found.lead === null || found.lead === undefined ? null : agentSessionOf(found.lead)
    // Only a KNOWN Lead session can own a card: worker/tool sessions are not
    // teams, so a worker's own session id never blocks its reviewer/tester.
    const ownerLead = cardSession === null ? null : (found.leads || []).filter((lead) => agentSessionOf(lead) === cardSession)[0]
    if (caller !== null && caller.kind !== null && ownerLead !== undefined && ownerLead !== null && leadSession !== null && cardSession !== leadSession) {
      return failure(
        'wrong-session',
        '这张卡属于会话 ' + cardSession + '，而你的裁决来自 Lead ' + String(found.lead.name === undefined ? found.lead.id : found.lead.name) + ' 的会话 ' + leadSession + '；跨会话裁决已被拒绝，请在卡片所属会话里裁决。',
      )
    }
    if (isAssignee(task, caller.member)) {
      return failure(
        kind === 'reviewer' ? 'worker-cannot-self-review' : 'worker-cannot-self-test',
        'The assignee cannot record its own ' + (kind === 'reviewer' ? 'review' : 'test') + ' verdict; an independent ' + kind + ' must.',
      )
    }
    if (caller.kind !== kind) {
      return failure('wrong-role', 'Only a ' + kind + ' role member or the user can record this verdict; ' + String(caller.member.name === undefined || caller.member.name === null ? 'this agent' : caller.member.name) + ' is not one.')
    }
    return null
  }

  return { verdictRefusal: verdictRefusal }
}
