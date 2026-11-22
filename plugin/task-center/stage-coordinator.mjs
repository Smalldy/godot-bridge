/**
 * StageCoordinator — the ONE authority that starts a reviewer/tester child.
 *
 * T-223: the incident this replaces. Reviewer/tester starts used to live in six
 * independent call sites (submit, approveReview, refreshMerge, the merge retest,
 * recoverWaiting, takeover/replace), and each one followed the same two steps:
 * "read the board → start a child → record deliveredTo". Two of them could run
 * inside the same sweep (or the same merge-queue turn): both read a pending round
 * with no deliveredTo, both spawned, and the last write overwrote the first
 * child. The card ended up with TWO live testers and only one of them recorded.
 *
 * A mutex around "start + record" would not have been enough. The round has to be
 * re-read INSIDE the serialised section (the state another turn already wrote is
 * the only truth), an existing delivery has to be REUSED instead of replaced, and
 * the delivery has to be recorded BEFORE the section releases, or the next writer
 * repeats the same race. That is what this module owns:
 *
 *   ensure(kind, task, brief, extra)     the ONLY public entry
 *
 * Semantics of ensure (all of it inside one per-root/task/kind queue turn):
 *   1. Re-read the authoritative board and the card.
 *   2. No open round / verdict already landed (passed/approved/changes-requested/
 *      failed) → skip; never spawn for a closed round.
 *   3. The round is pending and already names a deliveredTo child that this
 *      process can confirm (its own in-process registration, or a live local
 *      handle) → reuse it; never dispose and never spawn a second one.
 *   4. The round is pending and names a deliveredTo this process cannot confirm
 *      (plugin reload, a delivery from another process) → needs-reconciliation.
 *      No spawn: an unprovable child is not a reason to race a second one. The
 *      caller that CAN prove the round has no usable child (takeover/unblock/a
 *      stage replacement) resets the round first and calls ensure again.
 *   5. The round is pending with no deliveredTo → the caller that waits here
 *      really owns the spawn. stage-service.start() releases a leaked prior child
 *      of the same role first (T-204); the new delivery is then written with a
 *      generation BEFORE the queue releases. A write that lost the round (the
 *      round moved, a verdict landed, a newer generation was recorded) is
 *      refused; the child this turn started is disposed instead of left running
 *      unrecorded.
 *
 * Liveness never reads the agent tree. The tree is O(host) and was the T-221
 * incident; here "live" means a handle this process registered for THIS delivery
 * (or a live local handle the host facade can name). Nothing else is treated as
 * proof, so a card can wait but can never be double-spawned.
 */

export const STAGE_KINDS = Object.freeze(['reviewer', 'tester'])

const STAGE_STATUS = Object.freeze({ reviewer: 'reviewing', tester: 'testing' })
const RECORD_KEY = Object.freeze({ reviewer: 'review', tester: 'test' })

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error) {
  return error === null || error === undefined ? 'unknown error' : String((error && error.message) || error)
}

/** The board key a stage round lives under ("review" | "test"), or null. */
export function stageRecordKeyOf(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(RECORD_KEY, kind) ? RECORD_KEY[kind] : null
}

/** The card's round record for a stage kind, or null. */
export function stageRecordOf(task, kind) {
  const key = stageRecordKeyOf(kind)
  if (key === null || isObject(task) === false) return null
  const record = task[key]
  return isObject(record) ? record : null
}

/** The delivered child a round records, normalised, or null. */
export function deliveredOf(record) {
  if (isObject(record) === false) return null
  const delivered = record.deliveredTo
  if (isObject(delivered) === false) return null
  if (typeof delivered.id !== 'string' || delivered.id === '') return null
  return {
    id: delivered.id,
    name: typeof delivered.name === 'string' && delivered.name !== '' ? delivered.name : null,
    generation: Number.isFinite(delivered.generation) ? Math.floor(delivered.generation) : null,
    at: typeof delivered.at === 'string' && delivered.at !== '' ? delivered.at : null,
  }
}

/**
 * Why a delivery write may NOT land, or null when it may. PURE, so the exact
 * rule can be unit-tested without a board.
 *
 * The generation is the round's delivery counter: a write from a turn that is no
 * longer the current one must never overwrite the newer generation. `delivery`
 * carries the round stamp the spawn was decided on (`roundAt`), so a round that
 * was replaced while the child was starting is refused too.
 */
export function deliveryRefusal(record, delivery) {
  if (isObject(record) === false) {
    return { code: 'stage-round-closed', message: 'the card has no stage round to deliver to' }
  }
  if (record.status !== 'pending') {
    return { code: 'stage-round-closed', message: 'the stage round already has a verdict (' + String(record.status) + '); a late child must not land on it' }
  }
  const roundAt = isObject(delivery) && typeof delivery.roundAt === 'string' && delivery.roundAt !== '' ? delivery.roundAt : null
  if (roundAt !== null && typeof record.at === 'string' && record.at !== '' && record.at !== roundAt) {
    return { code: 'stale-round', message: 'the stage round was replaced while the child was starting (round ' + String(record.at) + ' != ' + roundAt + ')' }
  }
  const existing = deliveredOf(record)
  if (existing === null) return null
  if (isObject(delivery) === false || typeof delivery.id !== 'string' || delivery.id === '') {
    return { code: 'invalid-delivery', message: 'a stage delivery needs the child id it records' }
  }
  // The same child re-recorded is idempotent (a retried write, not a replacement).
  if (existing.id === delivery.id) return null
  const mine = Number.isFinite(delivery.generation) ? Math.floor(delivery.generation) : null
  if (existing.generation === null) {
    // A legacy delivery has no generation, so no turn can prove it is newer.
    return { code: 'delivery-conflict', message: 'the round already delivers to ' + existing.id + '; a different child must not overwrite it' }
  }
  if (mine === null || existing.generation > mine) {
    return { code: 'stale-generation', message: 'a newer generation (' + String(existing.generation) + ') owns this round; generation ' + String(mine === null ? '(none)' : mine) + ' must not overwrite it' }
  }
  if (existing.generation === mine) {
    return { code: 'delivery-conflict', message: 'generation ' + String(mine) + ' already delivered to ' + existing.id + '; it cannot also deliver to ' + delivery.id }
  }
  return null
}

/**
 * Apply a stage delivery to a board snapshot. PURE: returns the next board or a
 * typed refusal, so state.apply can CAS it and a unit test can drive the exact
 * rule. Used by the API's delivery write (the coordinator's recordDelivery hook).
 */
export function applyStageDelivery(board, taskId, kind, delivery) {
  const key = stageRecordKeyOf(kind)
  if (key === null) return { ok: false, code: 'invalid-stage-kind', message: 'a stage kind must be one of ' + STAGE_KINDS.join(', ') }
  if (isObject(board) === false || Array.isArray(board.tasks) === false) {
    return { ok: false, code: 'invalid-board', message: 'a delivery needs a board with tasks' }
  }
  if (isObject(delivery) === false || typeof delivery.id !== 'string' || delivery.id === '') {
    return { ok: false, code: 'invalid-delivery', message: 'a stage delivery needs the child id it records' }
  }
  let found = false
  let refusal = null
  const tasks = board.tasks.map(function (task) {
    if (isObject(task) === false || String(task.id) !== String(taskId)) return task
    found = true
    const record = stageRecordOf(task, kind)
    refusal = deliveryRefusal(record, delivery)
    if (refusal !== null) return task
    const delivered = {
      name: typeof delivery.name === 'string' && delivery.name !== '' ? delivery.name : null,
      id: delivery.id,
      at: typeof delivery.at === 'string' && delivery.at !== '' ? delivery.at : null,
      generation: Number.isFinite(delivery.generation) ? Math.floor(delivery.generation) : null,
    }
    return Object.assign({}, task, { [key]: Object.assign({}, record, { deliveredTo: delivered }) })
  })
  if (found === false) return { ok: false, code: 'unknown-task', message: 'no task with id ' + String(taskId) }
  if (refusal !== null) return { ok: false, code: refusal.code, message: refusal.message }
  return { ok: true, board: Object.assign({}, board, { tasks: tasks }), events: [] }
}

/**
 * @param options - injected seams, so this module owns the decision and the host
 *   owns storage/agents:
 *   { stageService, readBoard, recordDelivery, localHandle?, releaseChild?, clock? }
 *
 *   stageService    createStageService() result (startX/release/available)
 *   readBoard       async (projectPath) => { board } | { failure: {code,message} }
 *   recordDelivery  async (projectPath, taskId, kind, delivery) => { ok } | { ok:false, code, message }
 *   localHandle     (rootId, agentId) => true | false | null   (null = cannot tell)
 *   releaseChild    async (agentId) => boolean                 (rollback of our own spawn)
 *   clock           () => ms
 */
export function createStageCoordinator(options) {
  const opts = isObject(options) ? options : {}
  const stageService = opts.stageService === undefined ? null : opts.stageService
  const readBoard = typeof opts.readBoard === 'function' ? opts.readBoard : null
  const recordDelivery = typeof opts.recordDelivery === 'function' ? opts.recordDelivery : null
  const localHandle = typeof opts.localHandle === 'function' ? opts.localHandle : function () { return null }
  const clock = typeof opts.clock === 'function' ? opts.clock : function () { return Date.now() }
  const releaseChild =
    typeof opts.releaseChild === 'function'
      ? opts.releaseChild
      : stageService !== null && typeof stageService.release === 'function'
        ? function (agentId) {
            return stageService.release(agentId)
          }
        : async function () {
            return false
          }
  // One queue and one generation counter per rootId + taskId + kind.
  const queues = new Map()
  const generations = new Map()
  // Children THIS process started and still owns. Deliberately ignorant of the
  // agent tree: "registered here" is the only liveness a spawn decision may use.
  const registry = new Map()

  function unavailable() {
    return { ok: false, code: 'agent-runtime-unavailable', message: 'no reviewer/tester runtime is attached' }
  }

  function queueKeyOf(task, kind) {
    const rootId = isObject(task) && typeof task.ownerSession === 'string' && task.ownerSession !== '' ? task.ownerSession : ''
    const taskId = isObject(task) && task.id !== undefined && task.id !== null ? String(task.id) : ''
    return rootId + '|' + taskId + '|' + kind
  }

  /**
   * Serialise one key. The returned promise is the work's own result; the queue
   * only chains the NEXT turn behind it (a failure does not poison the chain).
   */
  function serialise(key, work) {
    const previous = queues.get(key)
    const run = previous === undefined ? Promise.resolve().then(work) : previous.then(work, work)
    const settled = run.then(
      function () {},
      function () {},
    )
    queues.set(key, settled)
    settled.then(function () {
      if (queues.get(key) === settled) queues.delete(key)
    })
    return run
  }

  function registeredLive(agentId) {
    const entry = registry.get(String(agentId))
    return entry !== undefined && entry.released !== true
  }

  function handleConfirmed(rootId, agentId) {
    try {
      return localHandle(rootId, agentId) === true
    } catch (error) {
      return false
    }
  }

  function findTask(board, taskId) {
    if (isObject(board) === false || Array.isArray(board.tasks) === false) return null
    const found = board.tasks.filter(function (task) {
      return isObject(task) && String(task.id) === String(taskId)
    })[0]
    return found === undefined ? null : found
  }

  /**
   * One queue turn. Everything below runs under the key's serialisation and the
   * delivery write is awaited before this returns (the queue releases after it).
   */
  async function ensureNow(key, kind, task, brief, requested, projectPath, taskId) {
    if (stageService === null) return unavailable()
    if (stageService.available === false) return unavailable()
    const read = await readBoard(projectPath)
    if (read === null || read === undefined || read.failure !== undefined) {
      const failed = read === null || read === undefined ? null : read.failure
      return {
        ok: false,
        code: failed !== null && failed !== undefined && typeof failed.code === 'string' ? failed.code : 'board-unreadable',
        message: 'the board could not be read for ' + taskId + ': ' + String(failed !== null && failed !== undefined ? failed.message : 'no answer'),
      }
    }
    const current = findTask(read.board, taskId)
    if (current === null) {
      return { ok: true, action: 'skipped', code: 'unknown-task', taskId: taskId, kind: kind, message: 'no task with id ' + taskId }
    }
    const openStatus = STAGE_STATUS[kind]
    if (current.status !== openStatus) {
      return { ok: true, action: 'skipped', code: 'not-in-stage', taskId: taskId, kind: kind, status: current.status, message: taskId + ' is ' + String(current.status) + ', not ' + openStatus }
    }
    const record = stageRecordOf(current, kind)
    if (record === null) {
      return { ok: true, action: 'skipped', code: 'no-round', taskId: taskId, kind: kind, message: taskId + ' has no ' + kind + ' round' }
    }
    if (record.status !== 'pending') {
      // "This generation already passed/approved" is exactly a closed record: a
      // verdict is never re-run and never re-spawned.
      return { ok: true, action: 'skipped', code: 'round-resolved', taskId: taskId, kind: kind, status: record.status, message: 'the ' + kind + ' round is already ' + String(record.status) }
    }
    const delivered = deliveredOf(record)
    if (delivered !== null) {
      if (delivered.generation !== null) {
        const known = generations.get(key) === undefined ? 0 : generations.get(key)
        if (delivered.generation > known) generations.set(key, delivered.generation)
      }
      const rootId = typeof current.ownerSession === 'string' ? current.ownerSession : ''
      if (registeredLive(delivered.id) || handleConfirmed(rootId, delivered.id)) {
        if (registry.has(delivered.id) === false) {
          registry.set(delivered.id, {
            agentId: delivered.id,
            rootId: rootId,
            taskId: taskId,
            kind: kind,
            generation: delivered.generation,
            registeredAt: clock(),
            released: false,
          })
        }
        return {
          ok: true,
          action: 'reused',
          agentId: delivered.id,
          name: delivered.name,
          generation: delivered.generation,
          taskId: taskId,
          kind: kind,
          message: 'the round already owns a live ' + kind + ' (' + delivered.id + '); reusing it',
        }
      }
      return {
        ok: true,
        action: 'needs-reconciliation',
        agentId: delivered.id,
        name: delivered.name,
        generation: delivered.generation,
        taskId: taskId,
        kind: kind,
        message:
          'the round records ' +
          delivered.id +
          ' as its ' +
          kind +
          ', but this process cannot confirm that child (no local handle). Nothing was started: a second ' +
          kind +
          ' must not race an unconfirmed one.',
      }
    }
    // No delivered child in the authoritative round: this turn owns the spawn.
    const knownGeneration = generations.get(key) === undefined ? 0 : generations.get(key)
    const generation = knownGeneration + 1
    generations.set(key, generation)
    const startedAt = clock()
    const spawnExtra =
      isObject(requested) && typeof requested.cwd === 'string' && requested.cwd.trim() !== '' ? { cwd: requested.cwd.trim() } : undefined
    let started = null
    try {
      started =
        kind === 'reviewer' ? await stageService.startReviewer(current, brief, spawnExtra) : await stageService.startTester(current, brief, spawnExtra)
    } catch (error) {
      return {
        ok: false,
        code: typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'spawn-failed',
        message: 'could not start a ' + kind + ' for ' + taskId + ': ' + messageOf(error),
        taskId: taskId,
        kind: kind,
      }
    }
    if (started === null || started === undefined || started.ok !== true) {
      return {
        ok: false,
        code: started !== null && started !== undefined && typeof started.code === 'string' ? started.code : 'spawn-failed',
        message: 'could not start a ' + kind + ' for ' + taskId + ': ' + String(started !== null && started !== undefined && started.message !== undefined ? started.message : 'no child was started'),
        taskId: taskId,
        kind: kind,
      }
    }
    const agentId = started.agentId === undefined || started.agentId === null ? '' : String(started.agentId)
    if (agentId === '') {
      // A spawn that cannot name its child cannot be recorded or disposed: it is
      // not a start the round can own, so it must not be treated as one.
      return { ok: false, code: 'spawn-failed', message: 'the ' + kind + ' service answered ok without a child id for ' + taskId, taskId: taskId, kind: kind }
    }
    const name = typeof started.name === 'string' && started.name !== '' ? started.name : null
    registry.set(agentId, {
      agentId: agentId,
      rootId: typeof current.ownerSession === 'string' ? current.ownerSession : '',
      taskId: taskId,
      kind: kind,
      generation: generation,
      registeredAt: startedAt,
      released: false,
    })
    const delivery = {
      id: agentId,
      name: name,
      at: new Date(clock()).toISOString(),
      generation: generation,
      // The round identity this spawn was decided on. A round replaced while the
      // child was starting refuses the write.
      roundAt: typeof record.at === 'string' && record.at !== '' ? record.at : null,
    }
    let written = null
    try {
      written = await recordDelivery(projectPath, taskId, kind, delivery)
    } catch (error) {
      written = { ok: false, code: 'delivery-write-failed', message: messageOf(error) }
    }
    if (written === null || written === undefined || written.ok !== true) {
      // Never leave an unrecorded child running behind a round that refused it.
      registry.delete(agentId)
      let released = false
      try {
        released = (await releaseChild(agentId)) === true
      } catch (error) {
        released = false
      }
      const reason = written !== null && written !== undefined && typeof written.code === 'string' ? written.code : 'delivery-write-failed'
      return {
        ok: false,
        code: reason,
        message:
          'the ' +
          kind +
          ' (' +
          agentId +
          ') was started but its delivery was refused (' +
          reason +
          '); ' +
          (released ? 'the child was disposed and the round keeps waiting' : 'the child could not be disposed, so it needs reconciliation'),
        taskId: taskId,
        kind: kind,
        agentId: agentId,
        generation: generation,
        released: released,
      }
    }
    return {
      ok: true,
      action: 'spawned',
      agentId: agentId,
      name: name,
      generation: generation,
      deliveredAt: delivery.at,
      taskId: taskId,
      kind: kind,
      message: 'started ' + kind + ' ' + agentId + ' for ' + taskId,
    }
  }

  /**
   * The only public entry. See the module comment for the full contract.
   *
   * @param kind    'reviewer' | 'tester'
   * @param task    the card the caller believes it is acting on (its id + root
   *                key the queue; the AUTHORITATIVE card is re-read inside)
   * @param brief   the text handed to the child
   * @param extra   { projectPath, cwd?, ... } — projectPath is required
   */
  async function ensure(kind, task, brief, extra) {
    if (STAGE_KINDS.indexOf(kind) < 0) {
      return { ok: false, code: 'invalid-stage-kind', message: 'ensure needs a stage kind: ' + STAGE_KINDS.join(', ') }
    }
    const requested = isObject(extra) ? extra : {}
    const projectPath = typeof requested.projectPath === 'string' && requested.projectPath !== '' ? requested.projectPath : null
    const taskId = isObject(task) && task.id !== undefined && task.id !== null && String(task.id) !== '' ? String(task.id) : null
    if (projectPath === null) return { ok: false, code: 'missing-project', message: 'ensure needs extra.projectPath to read the authoritative board' }
    if (taskId === null) return { ok: false, code: 'missing-task-id', message: 'ensure needs a task with an id' }
    if (readBoard === null || recordDelivery === null) {
      return { ok: false, code: 'coordinator-unwired', message: 'the stage coordinator needs readBoard and recordDelivery' }
    }
    const key = queueKeyOf(task, kind)
    return serialise(key, function () {
      return ensureNow(key, kind, task, brief, requested, projectPath, taskId)
    })
  }

  return { ensure: ensure }
}
