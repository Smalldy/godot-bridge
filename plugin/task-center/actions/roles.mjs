/**
 * Role administration actions (user-only).
 *
 * Extracted from performResolved. The handlers keep the same roleAdminRefusal
 * gate, readRoleConfig source, panel-session scoping, persistence and
 * ensure/drain semantics; only the routing moved.
 */
import {
  ROLE_KINDS,
  WORKFLOW_STAGES,
  defaultRoleConfig,
  legacyRoleFields,
  normaliseRoleConfig,
  validateRoleBinding,
  validateRoleProfile,
} from '../schema.mjs'

const ROLE_ACTIONS = [
  'rolesList',
  'rolesPreview',
  'rolesCreate',
  'rolesUpdate',
  'rolesDelete',
  'rolesBind',
  'rolesPrune',
  'rolesDrain',
  'rolesReplace',
  'rolesReset',
]

export function createRoleActions(deps) {
  const roleAdminRefusal = deps.roleAdminRefusal
  const readRoleConfig = deps.readRoleConfig
  const fs = deps.fs
  const callerSessionId = deps.callerSessionId
  const roleInstanceList = deps.roleInstanceList
  const rolePreviewFor = deps.rolePreviewFor
  const persistRoles = deps.persistRoles
  const emitActivity = deps.emitActivity
  const roles = deps.roles
  const sessionIdOf = deps.sessionIdOf
  const roleKindOf = deps.roleKindOf
  const roleMemberNamed = deps.roleMemberNamed
  const liveRoleNames = deps.liveRoleNames
  const ensureRoleBounded = deps.ensureRoleBounded
  const emitRoleProvision = deps.emitRoleProvision
  const clock = deps.clock
  const sleep = deps.sleep
  const drainTimeoutMs = deps.drainTimeoutMs
  const drainIntervalMs = deps.drainIntervalMs
  const ok = deps.ok
  const failure = deps.failure

  async function run(action, source, context, projectPath) {
    const denied = roleAdminRefusal(context)
    if (denied !== null) return denied
    const read = await readRoleConfig({ fs: fs }, { projectPath: projectPath })
    const current = read.config
    // T-130: role administration follows the PANEL session. The panel can never
    // list, drain, replace or reset another session's team.
    const roleSessionId = callerSessionId(source, context)
    if (action === 'rolesList') {
      return ok({
        source: read.source,
        error: read.error,
        config: current,
        stages: current.stages,
        defaults: defaultRoleConfig(),
        sessionId: roleSessionId,
        instances: roleInstanceList({ sessionId: roleSessionId }),
      })
    }
    if (action === 'rolesPreview') {
      return rolePreviewFor(projectPath, current, source)
    }
    if (action === 'rolesCreate' || action === 'rolesUpdate') {
      const name = String(source.name === undefined ? '' : source.name)
      const profileInput = source.profile !== undefined && source.profile !== null && typeof source.profile === 'object' && !Array.isArray(source.profile) ? source.profile : {}
      let merged = null
      if (action === 'rolesCreate') {
        if (name === '') return failure('missing-name', 'rolesCreate needs a profile name')
        if (current.profiles[name] !== undefined) return failure('role-exists', name + ' already exists; use rolesUpdate to edit it')
        merged = Object.assign({}, profileInput)
        if (merged.role === undefined && merged.kind === undefined && ROLE_KINDS.indexOf(name) >= 0) merged.role = name
      } else {
        if (current.profiles[name] === undefined) return failure('unknown-role-profile', 'no role profile named ' + name)
        // The three built-in profiles are host defaults, not editable documents:
        // the UI forks a copy, and the API enforces the same rule for every caller.
        if (ROLE_KINDS.indexOf(name) >= 0) {
          return failure('builtin-profile-immutable', 'the built-in ' + name + ' profile cannot be edited; fork a copy instead')
        }
        const existing = current.profiles[name]
        // T-138: `instances`/`concurrency` are NOT profile fields any more; a
        // legacy client sending them is ignored (reported to the caller below).
        merged = Object.assign(
          {
            role: existing.role,
            stage: existing.stage,
            skills: existing.skills,
            context: existing.context,
            permissions: existing.permissions,
            prompt: existing.prompt,
          },
          profileInput,
        )
      }
      const validated = validateRoleProfile(name, merged)
      if (validated.ok !== true) return validated
      const config = normaliseRoleConfig(
        Object.assign({}, current, { profiles: Object.assign({}, current.profiles, { [name]: validated.profile }) }),
      )
      const written = await persistRoles(projectPath, config)
      if (written.ok !== true) return written
      emitActivity(context, 'role-config', action + ' ' + name, null)
      const payload = { config: written.config, profile: written.config.profiles[name], source: 'file' }
      // T-138: tell an old client where the field went instead of storing it.
      if (legacyRoleFields(profileInput).length > 0) {
        payload.deprecated = { instances: 'ignored', movedTo: 'dispatch.maxConcurrent / dispatch.maxWorkAgents' }
      }
      return ok(payload)
    }
    if (action === 'rolesDelete') {
      const name = String(source.name === undefined ? '' : source.name)
      if (current.profiles[name] === undefined) return failure('unknown-role-profile', 'no role profile named ' + name)
      if (ROLE_KINDS.indexOf(name) >= 0) {
        return failure('default-profile', 'the built-in ' + name + ' profile cannot be deleted; update it or reset the defaults')
      }
      const profiles = Object.assign({}, current.profiles)
      delete profiles[name]
      const stages = Object.assign({}, current.stages)
      for (const stage of WORKFLOW_STAGES) {
        if (stages[stage] === name) stages[stage] = { implement: 'worker', review: 'reviewer', test: 'tester' }[stage]
      }
      const config = normaliseRoleConfig(Object.assign({}, current, { profiles: profiles, stages: stages }))
      const written = await persistRoles(projectPath, config)
      if (written.ok !== true) return written
      emitActivity(context, 'role-config', 'deleted profile ' + name, null)
      return ok({ config: written.config, deleted: name, source: 'file' })
    }
    if (action === 'rolesBind') {
      const stage = String(source.stage === undefined ? '' : source.stage)
      const name = String(source.profile !== undefined ? source.profile : source.name === undefined ? '' : source.name)
      const validated = validateRoleBinding(current, stage, name)
      if (validated.ok !== true) return validated
      const config = normaliseRoleConfig(Object.assign({}, current, { stages: Object.assign({}, current.stages, { [stage]: name }) }))
      const written = await persistRoles(projectPath, config)
      if (written.ok !== true) return written
      emitActivity(context, 'role-config', 'bound ' + stage + ' to ' + name, null)
      return ok({ config: written.config, bound: { stage: stage, profile: name }, source: 'file' })
    }
    if (action === 'rolesPrune') {
      // T-118: drop role instances whose slot belongs to ANOTHER project. They
      // only exist because an older build spawned them into the wrong team.
      if (roles === null || typeof roles.prune !== 'function') {
        return failure('roles-unavailable', 'the role manager is not available in this profile')
      }
      const pruned = await roles.prune({ projectPath: projectPath, sessionId: sessionIdOf(context) })
      if (pruned.ok !== true) return failure(pruned.code === undefined ? 'roles-prune-failed' : pruned.code, pruned.message === undefined ? 'could not prune role instances' : pruned.message)
      emitActivity(context, 'role-prune', 'pruned ' + String(pruned.pruned.length) + ' foreign role instance(s) in ' + String(pruned.lead), null)
      return ok({
        pruned: pruned.pruned,
        kept: pruned.kept,
        failed: pruned.failed,
        lead: pruned.lead,
        project: pruned.project,
        instances: roleInstanceList({ sessionId: roleSessionId }),
      })
    }
    if (action === 'rolesDrain' || action === 'rolesReplace') {
      if (roles === null || typeof roles.drain !== 'function') {
        return failure('roles-unavailable', 'the role manager is not available in this profile')
      }
      const requested = String(source.name === undefined ? '' : source.name)
      let kind = roleKindOf(requested)
      let targets = []
      if (kind !== null) {
        const member = roleMemberNamed(requested, { allowFailed: action === 'rolesReplace', sessionId: roleSessionId })
        if (member.ok !== true) return member
        // A failed instance is already replaced by ensure (failed slot), so a
        // replace skips the drain; a live one is drained with the wait deadline.
        targets = String(member.member.status) === 'failed' && action === 'rolesReplace' ? [] : [String(member.member.name)]
      } else if (action === 'rolesReplace' && ROLE_KINDS.indexOf(requested) >= 0) {
        kind = requested
        const live = liveRoleNames(kind, { sessionId: roleSessionId })
        if (live.ok !== true) return live
        if (live.names.length === 0) return failure('not-live', 'there is no live ' + kind + ' instance to replace')
        targets = live.names
      } else {
        return failure('invalid-role-instance', 'name a role instance (worker-1/reviewer-2/tester-3) or, for replace, a role kind')
      }
      const drained = []
      for (const name of targets) {
        const result = roles.drain(name, { timeoutMs: action === 'rolesReplace' ? drainTimeoutMs : undefined, now: clock() })
        if (result.ok !== true) return result
        drained.push(name)
      }
      if (action === 'rolesDrain') {
        emitActivity(context, 'role-config', 'drained ' + drained.join(', '), null)
        return ok({ drained: drained, kind: kind, status: roles.status(), sessionId: roleSessionId, instances: roleInstanceList({ sessionId: roleSessionId }) })
      }
      // "Drain first, then spawn": the role manager defers a running drained
      // instance until it is idle or its deadline passes, so no ensure pass
      // (including the scheduler tick) spawns a replacement early. We poll the
      // manager's ensure until it no longer reports a deferred instance.
      const startedAt = Date.now()
      let ensured = null
      let waiting = []
      while (true) {
        ensured = await ensureRoleBounded(kind, { config: current, projectPath: projectPath, task: null, now: clock(), sessionId: roleSessionId })
        if (ensured.ok !== true) break
        waiting = Array.isArray(ensured.waiting) ? ensured.waiting : []
        if (waiting.length === 0) break
        const elapsed = Date.now() - startedAt
        if (elapsed >= drainTimeoutMs) break
        await sleep(Math.min(drainIntervalMs, Math.max(1, drainTimeoutMs - elapsed)))
      }
      const waitedMs = Date.now() - startedAt
      // Timed out when the wait consumed the full budget before the old instance
      // went idle; the replacement was then spawned by the manager anyway.
      const waited = { waitedMs: waitedMs, timedOut: waitedMs >= drainTimeoutMs, waiting: waiting }
      // T-138: the wait budget can expire a hair before the drained instance's
      // own deadline, which would return "drained but not replaced". One final
      // pass applies the timeout replacement deterministically (and the test
      // for a stuck instance then cannot lose that race).
      if (waited.timedOut === true && waiting.length > 0) {
        try {
          const finalPass = await ensureRoleBounded(kind, { config: current, projectPath: projectPath, task: null, now: clock(), sessionId: roleSessionId })
          if (finalPass !== null && finalPass !== undefined) {
            ensured = finalPass
            waiting = Array.isArray(finalPass.waiting) ? finalPass.waiting : []
          }
        } catch (error) {}
      }
      emitRoleProvision(ensured)
      if (ensured === null || ensured.ok !== true) return Object.assign({}, ensured, { drained: drained, waited: waited })
      emitActivity(context, 'role-config', 'replaced ' + kind + ' instance(s)' + (waited.timedOut === true ? ' (wait timed out)' : ''), null)
      return ok({
        kind: kind,
        drained: drained,
        waited: waited,
        created: ensured.created,
        reused: ensured.reused,
        replaced: ensured.replaced,
        waiting: ensured.waiting,
        status: roles.status(),
        sessionId: roleSessionId,
        instances: roleInstanceList({ sessionId: roleSessionId }),
      })
    }
    if (action === 'rolesReset') {
      // A reset restores the three BUILT-IN profiles only. Custom copies are
      // the user's work, so they survive; stage bindings to them stay as they
      // are, and bindings to a built-in stay on that built-in.
      const defaults = defaultRoleConfig()
      const profiles = Object.assign({}, current.profiles, defaults.profiles)
      const config = normaliseRoleConfig(Object.assign({}, current, { profiles: profiles }))
      const written = await persistRoles(projectPath, config)
      if (written.ok !== true) return written
      emitActivity(context, 'role-config', 'reset the built-in role profiles to the defaults', null)
      const ensured = []
      if (roles !== null && typeof roles.ensure === 'function') {
        for (const kind of ROLE_KINDS) {
          // T-130: a reset only touches the PANEL session's team.
          // T-138: each built-in role starts at one instance; worker growth is
          // the dispatcher's job (count = live + 1, bounded by the dispatch cap).
          const result = await ensureRoleBounded(kind, { config: config, projectPath: projectPath, task: null, now: clock(), sessionId: roleSessionId, count: 1 })
          emitRoleProvision(result)
          ensured.push({ kind: kind, result: result })
        }
      }
      return ok({ config: written.config, source: 'default', sessionId: roleSessionId, ensured: ensured, instances: roleInstanceList({ sessionId: roleSessionId }) })
    }
    return failure('unknown-action', 'unknown role action ' + String(action))
  }

  const map = {}
  for (const name of ROLE_ACTIONS) map[name] = (source, context, projectPath) => run(name, source, context, projectPath)
  return map
}
