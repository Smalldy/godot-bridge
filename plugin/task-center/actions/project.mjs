/**
 * Project binding: openProject / resolveIncoming.
 *
 * Extracted from api.mjs. Keeps the same path resolution, preflight, registry
 * flush, session binding and resolvedFrom semantics.
 */
import { resolve } from 'node:path'

export function createProjectActions(deps) {
  const state = deps.state
  const fs = deps.fs
  const sessionIdOf = deps.sessionIdOf
  const preflightProject = deps.preflightProject
  const projectTeamFor = deps.projectTeamFor
  const remember = deps.remember
  const snapshot = deps.snapshot
  const resolveProjectRoot = deps.resolveProjectRoot
  const messageOf = deps.messageOf
  const failure = deps.failure

  async function openProject(input, context) {
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    if (path === '') return failure('missing-path', 'openProject needs a path')
    // T-130 audit: the remembered project is only the BASE for a relative path.
    const base = state.memory.projectHint === null ? process.cwd() : state.memory.projectHint
    const absolute = resolve(base, path)
    try {
      const target = await fs.resolve(absolute, { cwd: base })
      const info = await fs.stat(target)
      if (info === undefined || (info.type !== undefined && info.type !== 'directory')) {
        return failure('not-a-directory', 'not a directory: ' + path)
      }
    } catch (error) {
      return failure('invalid-project', messageOf(error))
    }
    const sessionId = sessionIdOf(context)
    const preflight = await preflightProject(absolute, { worktreeRoot: input.worktreeRoot, sessionId: sessionId })
    // A missing Team is reported in `preflight` (and blocks start), but it never
    // closes the project: the panel must open it to show how to initialize.
    const openFailed = Array.isArray(preflight.openFailed) ? preflight.openFailed : preflight.failed
    if (openFailed.length > 0) {
      const first = openFailed[0]
      const code = first === undefined ? 'not-ready' : first.id === 'repository' ? 'not-a-repository' : first.id === 'exclude' ? 'cannot-exclude' : 'not-ready'
      const refused = failure(code, 'project is not ready: ' + openFailed.map((check) => check.label + (check.detail === null ? '' : ' (' + check.detail + ')')).join('; '))
      refused.preflight = preflight
      const teamMissing = preflight.failed.filter((check) => check.id === 'team').length > 0
      if (teamMissing) {
        const teamRead = await projectTeamFor(absolute, sessionId)
        refused.team = teamRead.team
        refused.nextStep = teamRead.nextStep
      }
      return refused
    }
    remember(absolute)
    state.touchProject(absolute, undefined, { worktreeRoot: preflight.worktreeRoot, preflight: preflight })
    // Bind the opened project to the session that asked (tool call); the HTTP
    // route binds its own session after this answer.
    if (state !== null && typeof state.setSessionRoot === 'function') {
      const sessionId = sessionIdOf(context)
      if (sessionId !== null) state.setSessionRoot(sessionId, absolute)
    }
    // The registry write is asynchronous by design; openProject is a user action,
    // so wait for it and report where it landed — or why it did not persist.
    if (typeof state.flushRegistry === 'function') await state.flushRegistry()
    const registryStatus = typeof state.registryStatus === 'function' ? state.registryStatus() : null
    return Object.assign({}, await snapshot(absolute, { worktreeRoot: preflight.worktreeRoot, sessionId: sessionId }), {
      preflight: preflight,
      registry: registryStatus,
      // A flat string for callers that only want "did it persist, and why not".
      registryError: registryStatus !== null && registryStatus.ok !== true ? String(registryStatus.error) : null,
    })
  }

  async function resolveIncoming(source, context) {
    const explicit = typeof source.project === 'string' && source.project.trim().length > 0 ? source.project.trim() : ''
    if (explicit !== '') return { ok: true, root: resolve(explicit), resolvedFrom: 'explicit' }
    // T-102: the session's DSH directory names its workspace, so a tool call made
    // before openProject still lands on the right project. Unknown id => skip.
    if (state !== null && typeof state.lookupSessionRoot === 'function') {
      const lookedId = sessionIdOf(context)
      if (lookedId !== null) {
        const looked = await state.lookupSessionRoot(lookedId)
        if (looked.ok === true) {
          const viaLookup = await resolveProjectRoot({ fs: fs }, { explicit: null, sessionRoot: looked.path })
          if (viaLookup.ok === true) return { ok: true, root: viaLookup.root, resolvedFrom: 'session-lookup' }
        }
      }
    }
    const sessionRoot = context === undefined || context === null ? null : typeof context.sessionRoot === 'string' ? context.sessionRoot : typeof context.projectPath === 'string' ? context.projectPath : null
    if (sessionRoot === null) {
      return failure('no-project-bound', 'No project is bound to this session. Pass project, or open a project from the panel.')
    }
    if (state !== null && typeof state.setSessionRoot === 'function') {
      const sessionId = sessionIdOf(context)
      if (sessionId !== null) state.setSessionRoot(sessionId, sessionRoot)
    }
    const resolved = await resolveProjectRoot({ fs: fs }, { explicit: null, sessionRoot: sessionRoot })
    if (resolved.ok !== true) return resolved
    return { ok: true, root: resolved.root, resolvedFrom: resolved.resolvedFrom }
  }

  return { openProject: openProject, resolveIncoming: resolveIncoming }
}
