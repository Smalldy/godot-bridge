/**
 * Isolated DSH harness actions (start/stop/restart/status/smoke).
 *
 * Extracted from performResolved. The harness is optional: a profile without it
 * returns a readable refusal. The factory receives the refusal predicate and the
 * harness handle so the handlers stay thin and the action table can route by name.
 */
export function createHarnessActions(deps) {
  const harnessRefusal = deps.harnessRefusal
  const harness = deps.harness
  const ok = deps.ok
  const failure = deps.failure

  async function run(action, source, context, projectPath) {
    const denied = harnessRefusal(context)
    if (denied !== null) return denied
    if (harness === null || harness === undefined || typeof harness.start !== 'function') {
      return failure('harness-unavailable', 'the isolated DSH harness is not available in this profile')
    }
    if (action === 'harnessStatus') {
      const status = harness.status()
      return ok({
        harness: status,
        logs: harness.logs(),
        port: status.port === undefined ? null : status.port,
        token: status.token === undefined ? null : status.token,
        url: status.url === undefined ? null : status.url,
        cookie: status.cookie === true,
      })
    }
    if (action === 'harnessStop') return harness.stop()
    if (action === 'harnessStart') return harness.start(projectPath)
    if (action === 'harnessRestart') return harness.restart(projectPath)
    return harness.smoke(projectPath)
  }

  return {
    harnessStart: (source, context, projectPath) => run('harnessStart', source, context, projectPath),
    harnessStop: (source, context, projectPath) => run('harnessStop', source, context, projectPath),
    harnessRestart: (source, context, projectPath) => run('harnessRestart', source, context, projectPath),
    harnessStatus: (source, context, projectPath) => run('harnessStatus', source, context, projectPath),
    harnessSmoke: (source, context, projectPath) => run('harnessSmoke', source, context, projectPath),
  }
}
