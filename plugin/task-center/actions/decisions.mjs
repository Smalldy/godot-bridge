/**
 * decisionList / decisionAnswer handlers (T-195, extended by T-196).
 *
 * The two actions are transport only: decisionList sweeps the deadlines and
 * returns the queue, decisionAnswer forwards ONE answer (option or free text)
 * and returns the stored request. Every rule — one-shot answers, destructive
 * confirmation, timeout defaults, CAS — lives in decisions.mjs, so the tool,
 * the route and the panel cannot drift.
 *
 * T-196 adds two Server-side seams, both injected by api.mjs:
 *   - decorate(decision) attaches the timeout policy (autoRunAllowed) so the
 *     panel never promises an automatic choice the host would refuse;
 *   - applyAnswered / applyExpired execute the ACTION a decision stood for
 *     (create/start/reopen/delete/cancel) once, right after the answer or after
 *     the deadline applied a safe default, and message the asking Agent.
 */
export function createDecisionActions(deps) {
  const decisions = deps.decisions
  const ok = deps.ok
  const failure = deps.failure
  const byOf = deps.byOf
  const decorate = typeof deps.decorate === 'function' ? deps.decorate : function (decision) { return decision }
  const applyAnswered = typeof deps.applyAnswered === 'function' ? deps.applyAnswered : null
  const applyExpired = typeof deps.applyExpired === 'function' ? deps.applyExpired : null

  /** The pending queue (or one status / all), with the typed counts. */
  async function decisionList(source, context, projectPath, now) {
    const input = source === undefined || source === null ? {} : source
    const swept = await decisions.sweep(projectPath, { now: now })
    if (swept.ok !== true) return swept
    // A poll is also the host tick: a deadline that passed applies its safe
    // default exactly once (the sweep only reports the records it just expired).
    let applied = []
    if (applyExpired !== null && Array.isArray(swept.expired) && swept.expired.length > 0) {
      applied = await applyExpired(projectPath, swept.expired)
    }
    const status = typeof input.decisionStatus === 'string' && input.decisionStatus !== '' ? input.decisionStatus : 'pending'
    const listed = await decisions.list(projectPath, { status: status, limit: input.limit })
    if (listed.ok !== true) return listed
    return ok({
      decisions: listed.decisions.map(decorate),
      counts: listed.counts,
      expired: (Array.isArray(swept.expired) ? swept.expired : []).map(decorate),
      applied: applied,
      serverTime: new Date(now).toISOString(),
    })
  }

  /**
   * Is this pending request an ACTION question (create/start/reopen/delete/
   * cancel/delete-tree)? Only the human may answer one: an Agent answering its
   * own request would turn the pre-action gate into a no-op.
   */
  async function isActionDecision(projectPath, id) {
    const listed = await decisions.list(projectPath, { status: 'pending', limit: 200 })
    if (listed.ok !== true) return false
    const record = listed.decisions.filter((decision) => decision.id === id)[0]
    if (record === undefined) return false
    return record.payload !== null && record.payload !== undefined && typeof record.payload.action === 'string'
  }

  /** Resolve exactly one pending request. A second answer is refused by code. */
  async function decisionAnswer(source, context, projectPath, now) {
    const input = source === undefined || source === null ? {} : source
    const id = input.decisionId === undefined ? input.id : input.decisionId
    if (typeof id !== 'string' || id.trim() === '') return failure('invalid-decision-id', 'a decision id is required')
    const role = context === undefined || context === null ? null : context.role
    if (role !== 'user' && (await isActionDecision(projectPath, id.trim()))) {
      return failure('user-only', 'decision ' + id.trim() + ' runs an Agent action; only the user can answer it in the task center panel.')
    }
    const result = await decisions.answer(
      projectPath,
      { id: id.trim(), option: input.option, text: input.text, confirm: input.confirm },
      { by: byOf(context) },
    )
    if (result.ok !== true) return result
    // The answer is stored; NOW the host performs what it stood for. A failure
    // here is reported in 'applied' but never un-answers the request: a second
    // attempt would be a second execution.
    let applied = null
    if (applyAnswered !== null) {
      applied = await applyAnswered(projectPath, result.decision)
    }
    return ok({ decision: decorate(result.decision), applied: applied, serverTime: new Date(now).toISOString() })
  }

  return { decisionList: decisionList, decisionAnswer: decisionAnswer }
}
