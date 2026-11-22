// T-223 StageCoordinator: one authoritative spawn per round, idempotent ensure,
// delivery-before-unlock, stale-generation rejection and the safe "cannot tell"
// answer that never turns into a second live child.

import assert from 'node:assert/strict'
import { applyStageDelivery, createStageCoordinator, deliveredOf, deliveryRefusal } from '../../plugin/task-center/stage-coordinator.mjs'
import { normaliseDeliveredTo } from '../../plugin/task-center/schema.mjs'

const AT = Date.parse('2026-11-22T00:00:00.000Z')
const ROUND_AT = new Date(AT).toISOString()
const checks = []
async function check(name, fn) {
  try {
    await fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error })
  }
}

function boardWith(overrides) {
  return {
    version: 2,
    tasks: [
      Object.assign(
        {
          id: 'T-1',
          title: 'stage card',
          status: 'reviewing',
          ownerSession: 'root-session',
          review: { status: 'pending', attempt: 1, at: ROUND_AT, deliveredTo: null },
          test: null,
        },
        overrides === undefined ? {} : overrides,
      ),
    ],
  }
}

function testerBoard(overrides) {
  return boardWith(
    Object.assign(
      {
        status: 'testing',
        review: { status: 'approved', attempt: 1, at: ROUND_AT },
        test: { status: 'pending', attempt: 1, at: ROUND_AT, deliveredTo: null },
      },
      overrides === undefined ? {} : overrides,
    ),
  )
}

function taskOf(board) {
  return board.tasks[0]
}

/** A fake stage service: records starts, keeps a live set, can run a hook mid-spawn. */
function createStageService(options) {
  const opts = options === undefined ? {} : options
  const calls = []
  const live = new Set()
  let counter = 0
  const events = opts.events === undefined ? null : opts.events
  function nextId(kind) {
    counter += 1
    return kind + '-' + String(counter)
  }
  async function start(kind, task, brief, extra) {
    const method = kind === 'reviewer' ? 'startReviewer' : 'startTester'
    calls.push({ kind: method, taskId: String(task.id), brief: brief, extra: extra })
    if (events !== null) events.push('start:' + kind)
    if (opts.startThrows === true) throw Object.assign(new Error('the spawn was refused'), { code: 'spawn-refused' })
    if (typeof opts.duringSpawn === 'function') await opts.duringSpawn({ kind, task })
    const agentId = nextId(kind === 'reviewer' ? 'reviewer' : 'tester')
    live.add(agentId)
    return { ok: true, agentId, name: kind + '-t-' + String(task.id) }
  }
  return {
    available: opts.available !== false,
    calls,
    live,
    events,
    startReviewer(task, brief, extra) {
      return start('reviewer', task, brief, extra)
    },
    startTester(task, brief, extra) {
      return start('tester', task, brief, extra)
    },
    async release(agentId) {
      calls.push({ kind: 'release', agentId: agentId })
      return live.delete(String(agentId))
    },
  }
}

function createRig(options) {
  const opts = options === undefined ? {} : options
  const board = opts.board === undefined ? boardWith() : opts.board
  const service = opts.service === undefined ? createStageService(opts.events === undefined ? {} : { events: opts.events }) : opts.service
  const deliveries = []
  const events = opts.events === undefined ? null : opts.events
  const coordinator = createStageCoordinator({
    stageService: service,
    readBoard: async function () {
      if (events !== null) events.push('read')
      return { board }
    },
    recordDelivery: async function (projectPath, taskId, kind, delivery) {
      if (events !== null) events.push('deliver')
      deliveries.push({ projectPath, taskId, kind, delivery })
      const applied = applyStageDelivery(board, taskId, kind, delivery)
      if (applied.ok !== true) return applied
      board.tasks = applied.board.tasks
      return { ok: true }
    },
    localHandle: opts.localHandle === undefined ? function () { return null } : opts.localHandle,
    clock: function () {
      return AT
    },
  })
  return { coordinator, board, service, deliveries }
}

function startCount(service) {
  return service.calls.filter(function (call) {
    return call.kind === 'startReviewer' || call.kind === 'startTester'
  }).length
}

const ensureOpts = { projectPath: '/demo-project' }

// ── the pure delivery guard: a late generation can never overwrite a newer one ──
await check('a pending round with no delivery may be delivered', () => {
  assert.equal(deliveryRefusal({ status: 'pending', deliveredTo: null }, { id: 'a', generation: 1 }), null)
})

await check('a round that already has a verdict refuses every delivery', () => {
  for (const status of ['approved', 'passed', 'failed', 'changes-requested']) {
    const refusal = deliveryRefusal({ status: status, at: ROUND_AT, deliveredTo: null }, { id: 'a', generation: 1, roundAt: ROUND_AT })
    assert.equal(refusal === null ? null : refusal.code, 'stage-round-closed', status)
  }
})

await check('an older generation is refused even with a different child', () => {
  const refusal = deliveryRefusal(
    { status: 'pending', at: ROUND_AT, deliveredTo: { id: 'newer', generation: 3 } },
    { id: 'older', generation: 2, roundAt: ROUND_AT },
  )
  assert.ok(refusal !== null)
  assert.equal(refusal.code, 'stale-generation')
})

await check('the same generation cannot deliver a different child', () => {
  const refusal = deliveryRefusal(
    { status: 'pending', at: ROUND_AT, deliveredTo: { id: 'a', generation: 4 } },
    { id: 'b', generation: 4, roundAt: ROUND_AT },
  )
  assert.ok(refusal !== null)
  assert.equal(refusal.code, 'delivery-conflict')
})

await check('a newer generation replaces an older delivery; the same child is idempotent', () => {
  const round = { status: 'pending', at: ROUND_AT, deliveredTo: { id: 'old', generation: 2 } }
  assert.equal(deliveryRefusal(round, { id: 'new', generation: 3, roundAt: ROUND_AT }), null)
  assert.equal(deliveryRefusal(round, { id: 'old', generation: 3, roundAt: ROUND_AT }), null)
})

await check('a replaced round refuses the delivery of the round it replaced', () => {
  const refusal = deliveryRefusal(
    { status: 'pending', at: '2026-11-22T01:00:00.000Z', deliveredTo: null },
    { id: 'late', generation: 1, roundAt: ROUND_AT },
  )
  assert.ok(refusal !== null)
  assert.equal(refusal.code, 'stale-round')
})

await check('applyStageDelivery is pure: it returns the next board and never mutates the old one', () => {
  const board = boardWith()
  const before = JSON.stringify(board)
  const applied = applyStageDelivery(board, 'T-1', 'reviewer', { id: 'reviewer-1', name: 'reviewer-t-T-1', at: ROUND_AT, generation: 1, roundAt: ROUND_AT })
  assert.equal(applied.ok, true)
  assert.equal(JSON.stringify(board), before, 'the input board was mutated')
  assert.equal(deliveredOf(applied.board.tasks[0].review).id, 'reviewer-1')
  assert.equal(deliveredOf(applied.board.tasks[0].review).generation, 1)
  const refused = applyStageDelivery(applied.board, 'T-1', 'reviewer', { id: 'reviewer-2', generation: 1, roundAt: ROUND_AT })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'delivery-conflict')
})

await check('the delivery generation survives the board normaliser (durable across reads)', () => {
  const normalised = normaliseDeliveredTo({ name: 'reviewer-t-T-1', id: 'reviewer-1', at: ROUND_AT, generation: 3 })
  assert.equal(normalised.generation, 3)
  // A legacy delivery keeps its shape; no invented generation.
  assert.equal(Object.prototype.hasOwnProperty.call(normaliseDeliveredTo({ name: 'legacy', id: 'agent-old', at: ROUND_AT }), 'generation'), false)
})

// ── concurrent ensure: ONE spawn, the second reuses it ──────────────────────
await check('two concurrent ensures spawn exactly one reviewer; the second reuses it', async () => {
  const rig = createRig({})
  const first = rig.coordinator.ensure('reviewer', taskOf(rig.board), 'review brief', ensureOpts)
  const second = rig.coordinator.ensure('reviewer', taskOf(rig.board), 'review brief', ensureOpts)
  const results = await Promise.all([first, second])
  assert.equal(results.every(function (result) { return result.ok === true }), true, JSON.stringify(results))
  assert.equal(startCount(rig.service), 1, 'starts: ' + JSON.stringify(rig.service.calls))
  assert.equal(results[0].action, 'spawned')
  assert.equal(results[1].action, 'reused')
  assert.equal(results[1].agentId, results[0].agentId)
  assert.equal(deliveredOf(taskOf(rig.board).review).id, results[0].agentId)
  assert.equal(rig.deliveries.length, 1)
})

await check('deliveredTo is written BEFORE the queue releases the next ensure', async () => {
  const events = []
  const rig = createRig({ events })
  const first = rig.coordinator.ensure('reviewer', taskOf(rig.board), 'review brief', ensureOpts)
  const second = rig.coordinator.ensure('reviewer', taskOf(rig.board), 'review brief', ensureOpts)
  const results = await Promise.all([first, second])
  assert.deepEqual(events, ['read', 'start:reviewer', 'deliver', 'read'], JSON.stringify(events))
  assert.equal(results[1].action, 'reused')
  assert.equal(rig.deliveries.length, 1)
})

await check('a pending test round + a retest in the same moment produce ONE tester', async () => {
  const rig = createRig({ board: testerBoard() })
  const retest = rig.coordinator.ensure('tester', taskOf(rig.board), 'retest brief', ensureOpts)
  const recovery = rig.coordinator.ensure('tester', taskOf(rig.board), 'recovery brief', ensureOpts)
  const results = await Promise.all([retest, recovery])
  assert.equal(results.every(function (result) { return result.ok === true }), true, JSON.stringify(results))
  assert.equal(startCount(rig.service), 1, 'testers started: ' + JSON.stringify(rig.service.calls))
  const delivered = deliveredOf(taskOf(rig.board).test)
  assert.ok(delivered !== null)
  assert.equal(delivered.id, results[0].agentId)
  assert.equal(rig.service.live.size, 1)
  assert.equal(rig.service.live.has(delivered.id), true)
})

await check('a sequential second ensure reuses the registered child without touching it', async () => {
  const rig = createRig({})
  const first = await rig.coordinator.ensure('reviewer', taskOf(rig.board), 'review brief', ensureOpts)
  const second = await rig.coordinator.ensure('reviewer', taskOf(rig.board), 'review brief', ensureOpts)
  assert.equal(first.action, 'spawned')
  assert.equal(second.action, 'reused')
  assert.equal(startCount(rig.service), 1)
  assert.equal(rig.service.calls.filter(function (call) { return call.kind === 'release' }).length, 0, 'reuse disposed a child')
})

// ── a verdict/closed round never spawns ─────────────────────────────────────
await check('an approved review round never starts a reviewer', async () => {
  const board = boardWith({ review: { status: 'approved', attempt: 1, at: ROUND_AT } })
  const rig = createRig({ board })
  const result = await rig.coordinator.ensure('reviewer', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'skipped')
  assert.equal(result.code, 'round-resolved')
  assert.equal(startCount(rig.service), 0)
})

await check('a passed test round never starts a tester', async () => {
  const board = testerBoard({ test: { status: 'passed', attempt: 1, at: ROUND_AT, deliveredTo: { id: 'tester-done', name: 'tester-t-T-1' } } })
  const rig = createRig({ board })
  const result = await rig.coordinator.ensure('tester', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(result.action, 'skipped')
  assert.equal(result.code, 'round-resolved')
  assert.equal(startCount(rig.service), 0)
})

await check('a card that left its stage never starts a child', async () => {
  const board = boardWith({ status: 'running' })
  const rig = createRig({ board })
  const result = await rig.coordinator.ensure('reviewer', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(result.action, 'skipped')
  assert.equal(result.code, 'not-in-stage')
  assert.equal(startCount(rig.service), 0)
})

// ── restart/pending without a live handle: wait, never a second child ───────
await check('a pending round with a delivery this process cannot confirm is NOT raced', async () => {
  const board = testerBoard({ test: { status: 'pending', attempt: 1, at: ROUND_AT, deliveredTo: { id: 'tester-old', name: 'tester-t-T-1' } } })
  const rig = createRig({ board })
  const result = await rig.coordinator.ensure('tester', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(result.ok, true)
  assert.equal(result.action, 'needs-reconciliation')
  assert.equal(result.agentId, 'tester-old')
  assert.equal(startCount(rig.service), 0, 'a second tester was started behind an unconfirmed one')
  assert.equal(rig.service.calls.filter(function (call) { return call.kind === 'release' }).length, 0, 'the unconfirmed child was disposed')
  assert.equal(deliveredOf(taskOf(rig.board).test).id, 'tester-old', 'the recorded delivery was overwritten')
})

await check('a pending round whose delivery has a local handle is reused, not replaced', async () => {
  const board = testerBoard({ test: { status: 'pending', attempt: 1, at: ROUND_AT, deliveredTo: { id: 'tester-live', name: 'tester-t-T-1' } } })
  const rig = createRig({
    board,
    localHandle: function (rootId, agentId) {
      return rootId === 'root-session' && agentId === 'tester-live' ? true : null
    },
  })
  const result = await rig.coordinator.ensure('tester', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(result.action, 'reused')
  assert.equal(result.agentId, 'tester-live')
  assert.equal(startCount(rig.service), 0)
  assert.equal(rig.service.calls.filter(function (call) { return call.kind === 'release' }).length, 0)
})

// ── late-generation writes are rejected and the child is disposed ───────────
await check('a delivery from an older generation is refused and its child disposed', async () => {
  const board = boardWith()
  const rigOptions = {}
  const service = createStageService({
    duringSpawn: async function () {
      // Another writer delivered a NEWER generation while this child started.
      board.tasks[0].review = Object.assign({}, board.tasks[0].review, { deliveredTo: { name: 'newer', id: 'reviewer-newer', at: ROUND_AT, generation: 99 } })
      service.live.add('reviewer-newer')
    },
  })
  const rig = createRig(Object.assign({ board, service }, rigOptions))
  const result = await rig.coordinator.ensure('reviewer', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.code, 'stale-generation')
  assert.equal(result.released, true)
  assert.equal(deliveredOf(taskOf(rig.board).review).id, 'reviewer-newer', 'the newer generation was overwritten')
  assert.equal(rig.service.live.has(result.agentId), false, 'the rejected child is still live')
  assert.equal(rig.deliveries.length, 1, 'the delivery write was retried behind the newer one')
})

await check('a round that closes while the child starts refuses the delivery and disposes the child', async () => {
  const board = boardWith()
  const service = createStageService({
    duringSpawn: async function () {
      board.tasks[0].status = 'testing'
      board.tasks[0].review = Object.assign({}, board.tasks[0].review, { status: 'approved' })
    },
  })
  const rig = createRig({ board, service })
  const result = await rig.coordinator.ensure('reviewer', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'stage-round-closed')
  assert.equal(result.released, true)
  assert.equal(rig.service.live.has(result.agentId), false)
  assert.equal(deliveredOf(taskOf(rig.board).review), null)
})

// ── safe degradation ───────────────────────────────────────────────────────
await check('no stage service answers agent-runtime-unavailable', async () => {
  const coordinator = createStageCoordinator({
    stageService: null,
    readBoard: async function () {
      return { board: boardWith() }
    },
    recordDelivery: async function () {
      return { ok: true }
    },
  })
  const result = await coordinator.ensure('reviewer', boardWith().tasks[0], 'brief', ensureOpts)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'agent-runtime-unavailable')
})

await check('an unavailable stage service answers agent-runtime-unavailable', async () => {
  const rig = createRig({ service: createStageService({ available: false }) })
  const result = await rig.coordinator.ensure('reviewer', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'agent-runtime-unavailable')
  assert.equal(startCount(rig.service), 0)
})

await check('a refused spawn is a typed failure and never writes a delivery', async () => {
  const rig = createRig({ service: createStageService({ startThrows: true }) })
  const result = await rig.coordinator.ensure('reviewer', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'spawn-refused')
  assert.equal(rig.deliveries.length, 0)
  assert.equal(deliveredOf(taskOf(rig.board).review), null)
})

await check('ensure refuses an unusable request instead of guessing', async () => {
  const rig = createRig({})
  const noProject = await rig.coordinator.ensure('reviewer', taskOf(rig.board), 'brief', {})
  assert.equal(noProject.code, 'missing-project')
  const badKind = await rig.coordinator.ensure('worker', taskOf(rig.board), 'brief', ensureOpts)
  assert.equal(badKind.code, 'invalid-stage-kind')
  assert.equal(startCount(rig.service), 0)
})

const failed = checks.filter(function (row) { return !row.ok })
for (const row of checks) {
  console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
}
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
