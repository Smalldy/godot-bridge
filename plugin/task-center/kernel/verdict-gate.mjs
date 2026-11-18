/**
 * Review/test verdict role gate (kernel seam).
 *
 * The host hands a card's review/test stage to ONE child and records it as
 * review.deliveredTo / test.deliveredTo. That record is the authority: the child
 * it names (by durable Session id) may decide the round, and the user may. The
 * card's own worker may not. No roster is consulted.
 */
export function createVerdictGate(deps) {
  const callerIdentifiers = deps.callerIdentifiers
  const isAssignee = deps.isAssignee
  const failure = deps.failure

  function verdictRefusal(context, task, kind) {
    if (context !== undefined && context !== null && context.role === 'user') return null
    const { ids } = callerIdentifiers(context)
    const stageRecord = task === null || task === undefined ? null : kind === 'reviewer' ? task.review : task.test
    const delivered =
      stageRecord === null || stageRecord === undefined || stageRecord.deliveredTo === undefined || stageRecord.deliveredTo === null
        ? null
        : stageRecord.deliveredTo
    const deliveredId = delivered === null || delivered.id === undefined || delivered.id === null ? null : String(delivered.id)
    if (deliveredId !== null && ids.indexOf(deliveredId) >= 0) return null
    const member = ids.length === 0 ? null : { id: ids[0], name: null }
    if (member !== null && isAssignee(task, member)) {
      return failure(
        kind === 'reviewer' ? 'worker-cannot-self-review' : 'worker-cannot-self-test',
        'The assignee cannot record its own ' + (kind === 'reviewer' ? 'review' : 'test') + ' verdict; an independent ' + kind + ' must.',
      )
    }
    return failure(
      'role-required',
      'Only the ' + kind + ' child this card was handed to, or the user, can record this verdict. Call get first: the card records the exact reviewer/tester Session id it was delivered to.',
    )
  }

  return { verdictRefusal: verdictRefusal }
}
