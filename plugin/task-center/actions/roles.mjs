/**
 * Role administration actions (user-only).
 *
 * A role profile is prompt/skills CONFIGURATION only: it names a role, its
 * stage, skills, context, permissions and prompt template. It never provisions an
 * instance, so there is nothing to ensure, drain, replace or prune.
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
  'rolesReset',
]

export function createRoleActions(deps) {
  const roleAdminRefusal = deps.roleAdminRefusal
  const readRoleConfig = deps.readRoleConfig
  const fs = deps.fs
  const callerSessionId = deps.callerSessionId
  const rolePreviewFor = deps.rolePreviewFor
  const persistRoles = deps.persistRoles
  const emitActivity = deps.emitActivity
  const ok = deps.ok
  const failure = deps.failure

  async function run(action, source, context, projectPath) {
    const denied = roleAdminRefusal(context)
    if (denied !== null) return denied
    const read = await readRoleConfig({ fs: fs }, { projectPath: projectPath })
    const current = read.config
    // T-130: role administration follows the PANEL session.
    const roleSessionId = callerSessionId(source, context)
    if (action === 'rolesList') {
      return ok({
        source: read.source,
        error: read.error,
        config: current,
        stages: current.stages,
        defaults: defaultRoleConfig(),
        sessionId: roleSessionId,
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
        payload.deprecated = { instances: 'ignored', movedTo: 'dispatch.maxConcurrent' }
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
      return ok({ config: written.config, source: 'default', sessionId: roleSessionId })
    }
    return failure('unknown-action', 'unknown role action ' + String(action))
  }

  const map = {}
  for (const name of ROLE_ACTIONS) map[name] = (source, context, projectPath) => run(name, source, context, projectPath)
  return map
}
