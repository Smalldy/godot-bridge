/**
 * T-195 — decisionList / decisionAnswer handlers.
 *
 * The two actions are transport only: decisionList sweeps the deadlines and
 * returns the queue, decisionAnswer forwards ONE answer (option or free text)
 * and returns the stored request. Every rule — one-shot answers, destructive
 * confirmation, timeout defaults, CAS — lives in decisions.mjs, so the tool,
 * the route and the panel cannot drift.
 *
 * The service is injected (deps.decisions), which lets T-196/T-197 create
 * requests from the create/timeout/lifecycle paths without going through an
 * action.
 */
export function createDecisionActions(deps) {
  const decisions = deps.decisions
  const ok = deps.ok
  const failure = deps.failure
  const byOf = deps.byOf

  /** The pending queue (or one status / all), with the typed counts. */
  async function decisionList(source, context, projectPath, now) {
    const input = source === undefined || source === null ? {} : source
    const swept = await decisions.sweep(projectPath, { now: now })
    if (swept.ok !== true) return swept
    const status = typeof input.decisionStatus === 'string' && input.decisionStatus !== '' ? input.decisionStatus : 'pending'
    const listed = await decisions.list(projectPath, { status: status, limit: input.limit })
    if (listed.ok !== true) return listed
    return ok({
      decisions: listed.decisions,
      counts: listed.counts,
      expired: swept.expired,
      serverTime: new Date(now).toISOString(),
    })
  }

  /** Resolve exactly one pending request. A second answer is refused by code. */
  async function decisionAnswer(source, context, projectPath, now) {
    const input = source === undefined || source === null ? {} : source
    const id = input.decisionId === undefined ? input.id : input.decisionId
    if (typeof id !== 'string' || id.trim() === '') return failure('invalid-decision-id', 'a decision id is required')
    const result = await decisions.answer(
      projectPath,
      { id: id.trim(), option: input.option, text: input.text, confirm: input.confirm },
      { by: byOf(context) },
    )
    if (result.ok !== true) return result
    return ok({ decision: result.decision, serverTime: new Date(now).toISOString() })
  }

  return { decisionList: decisionList, decisionAnswer: decisionAnswer }
}
