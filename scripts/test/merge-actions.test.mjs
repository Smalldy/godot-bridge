import assert from 'node:assert/strict'
import { createMergeActions } from '../../plugin/task-center/actions/merge.mjs'
// T-223: the refresh path starts its reviewer through the coordinator, so these
// harnesses drive the real one instead of a startReviewer stub.
import { applyStageDelivery, createStageCoordinator } from '../../plugin/task-center/stage-coordinator.mjs'

const ok = (payload) => Object.assign({ ok: true }, payload)
const failure = (code, message) => ({ ok: false, code: code, message: message })
let notified = null
const board = { tasks: [{ id: 'T-1', status: 'testing', merge: { status: 'open' } }] }
const actions = createMergeActions({
  mergeRefusal: () => null,
  mergeQueueKey: async () => 'main',
  serialised: async (work) => work({ aborted: false }),
  mergeOne: async () => ({ ok: true, task: { id: 'T-1' } }),
  notifyMergeOutcome: async (project, task) => {
    notified = { project: project, id: task.id }
  },
  readBoardOrFail: async () => ({ board: board }),
  model: { findTask: (source, id) => source.tasks.filter((task) => task.id === id)[0] },
  writeTask: async (project, id, mutator) => mutator(board),
  recordMergeResult: (source, id, outcome) => ({ ok: true, board: source, task: { id: id, merge: { status: outcome.status } }, events: [] }),
  clock: () => 1000,
  writeByName: () => 'user',
  emitActivity: () => {},
  ok: ok,
  failure: failure,
})

const merged = await actions.mergeRequest({ id: 'T-1' }, { by: 'merger' }, '/project')
assert.equal(merged.ok, true)
assert.deepEqual(notified, { project: '/project', id: 'T-1' })

const rejected = await actions.rejectMerge({ id: 'T-1' }, { by: 'merger' }, '/project')
assert.equal(rejected.ok, true)
assert.equal(rejected.merge.status, 'rejected')

const missing = await actions.mergeRequest({}, { by: 'merger' }, '/project')
assert.equal(missing.code, 'missing-id')

const denied = createMergeActions({
  mergeRefusal: () => failure('not-merger', 'no'),
  mergeQueueKey: async () => 'main',
  serialised: async (work) => work({}),
  mergeOne: async () => ({ ok: true }),
  notifyMergeOutcome: async () => {},
  readBoardOrFail: async () => ({ board: board }),
  model: { findTask: () => board.tasks[0] },
  writeTask: async () => ({ ok: true }),
  recordMergeResult: () => ({ ok: true }),
  clock: () => 1000,
  writeByName: () => 'user',
  emitActivity: () => {},
  ok: ok,
  failure: failure,
})
assert.equal((await denied.mergeRequest({ id: 'T-1' }, {}, '/project')).code, 'not-merger')

// ── T-156: target drift and verify-fingerprint audit ─────────────────────────
{
  const check = (label, condition, detail) => {
    assert.ok(condition, label + (detail === undefined ? '' : ' -> ' + String(detail).slice(0, 600)))
    console.log('PASS  ' + label)
  }
  const { recordCandidate, refreshMergeRequest, fingerprintVerify, verifyScriptPaths } = await import('../../plugin/task-center/merge.mjs')
  const { reviewBriefFor } = await import('../../plugin/task-center/dispatch.mjs')
  const { normaliseMerge } = await import('../../plugin/task-center/schema.mjs')
  const { submitTask } = await import('../../plugin/task-center/service.mjs')
  const now = Date.parse('2026-11-11T00:00:00.000Z')
  const makeTask = (over) =>
    Object.assign(
      {
        id: 'T-9',
        title: 'drift',
        status: 'reviewing',
        kind: 'dev',
        base: 'base-1',
        actualFiles: ['old.gd'],
        verify: { command: 'node scripts/test/a.test.mjs && npm run verify' },
        verifyFingerprint: 'sha256:old',
        merge: { status: 'open', base: 'base-1', head: 'head-1', target: 'main', actualFiles: ['old.gd'], targetDrift: null, verifyChanged: false, verifyFingerprints: null },
        test: null,
        history: [],
        updatedAt: new Date(now).toISOString(),
      },
      over === undefined ? {} : over,
    )
  const boardOf = (task) => ({ version: 2, seq: 1, tasks: [task] })
  const drifted = recordCandidate(boardOf(makeTask()), 'T-9', { base: 'base-2', head: 'head-2', actualFiles: ['new.gd'] }, now, { by: 'reviewer', verifyFingerprint: 'sha256:new' })
  const driftedTask = drifted.ok === true ? drifted.board.tasks[0] : null
  check(
    'T-156 a moved target records targetDrift and refreshes base/actualFiles',
    drifted.ok === true &&
      driftedTask.merge.targetDrift !== null &&
      driftedTask.merge.targetDrift.from === 'base-1' &&
      driftedTask.merge.targetDrift.to === 'base-2' &&
      typeof driftedTask.merge.targetDrift.at === 'string' &&
      driftedTask.base === 'base-2' &&
      JSON.stringify(driftedTask.actualFiles) === JSON.stringify(['new.gd']) &&
      JSON.stringify(driftedTask.merge.actualFiles) === JSON.stringify(['new.gd']),
    JSON.stringify(driftedTask && { base: driftedTask.base, merge: driftedTask.merge, actual: driftedTask.actualFiles }),
  )
  check(
    'T-156 a changed verify declaration records verifyChanged and both fingerprints',
    driftedTask.merge.verifyChanged === true &&
      driftedTask.merge.verifyFingerprints.from === 'sha256:old' &&
      driftedTask.merge.verifyFingerprints.to === 'sha256:new' &&
      driftedTask.verifyFingerprint === 'sha256:new',
    JSON.stringify(driftedTask && { changed: driftedTask.merge.verifyChanged, prints: driftedTask.merge.verifyFingerprints }),
  )
  check(
    'T-156 the candidate history note names the drift and the verify change',
    driftedTask.history.some((row) => row.note.indexOf('target drift base-1 -> base-2') >= 0) && driftedTask.history.some((row) => row.note.indexOf('verify changed') >= 0),
    JSON.stringify(driftedTask.history.map((row) => row.note)),
  )
  const settled = makeTask({
    verifyFingerprint: 'sha256:same',
    merge: { status: 'open', base: 'base-2', head: 'head-2', target: 'main', actualFiles: ['new.gd'], targetDrift: null, verifyChanged: false, verifyFingerprints: null },
  })
  const same = recordCandidate(boardOf(settled), 'T-9', { base: 'base-2', head: 'head-3', actualFiles: ['new.gd'] }, now, { by: 'reviewer', verifyFingerprint: 'sha256:same' })
  const sameTask = same.ok === true ? same.board.tasks[0] : null
  check(
    'T-156 an unchanged target and verify produce no drift/verify noise',
    same.ok === true && sameTask.merge.targetDrift === null && sameTask.merge.verifyChanged === false && sameTask.merge.verifyFingerprints === null,
    JSON.stringify(sameTask && sameTask.merge),
  )
  const paths = verifyScriptPaths({ command: 'node scripts/test/a.test.mjs && npm run verify' })
  const basePrint = fingerprintVerify({ command: 'node scripts/test/a.test.mjs && npm run verify' }, [{ path: 'scripts/test/a.test.mjs', text: 'body-a' }])
  const samePrint = fingerprintVerify({ command: 'node scripts/test/a.test.mjs && npm run verify' }, [{ path: 'scripts/test/a.test.mjs', text: 'body-a' }])
  const editedPrint = fingerprintVerify({ command: 'node scripts/test/a.test.mjs && npm run verify' }, [{ path: 'scripts/test/a.test.mjs', text: 'body-b' }])
  const timeoutPrint = fingerprintVerify({ command: 'node scripts/test/a.test.mjs && npm run verify', timeoutMs: 5 }, [{ path: 'scripts/test/a.test.mjs', text: 'body-a' }])
  check(
    'T-156 the fingerprint is stable for the same command+script and changes with either',
    paths.join(',') === 'scripts/test/a.test.mjs' && basePrint !== null && basePrint === samePrint && basePrint !== editedPrint && basePrint !== timeoutPrint,
    JSON.stringify({ paths: paths, base: basePrint, edited: editedPrint, timeout: timeoutPrint }),
  )
  const brief = reviewBriefFor(driftedTask, '/project')
  check(
    'T-156 the review brief shows the drift and the old/new verify fingerprints',
    brief.indexOf('TARGET DRIFT') >= 0 && brief.indexOf('base-1 -> base-2') >= 0 && brief.indexOf('VERIFY DECLARATION CHANGED') >= 0 && brief.indexOf('sha256:old -> sha256:new') >= 0,
    brief.slice(0, 600),
  )
  const quiet = reviewBriefFor(sameTask, '/project')
  check('T-156 an unchanged round adds no drift/verify warning to the brief', quiet.indexOf('TARGET DRIFT') < 0 && quiet.indexOf('VERIFY DECLARATION CHANGED') < 0, quiet.slice(0, 400))
  const roundTripped = normaliseMerge(driftedTask.merge)
  check(
    'T-156 the merge audit fields survive board normalisation (board/get readable)',
    roundTripped.targetDrift !== null && roundTripped.targetDrift.from === 'base-1' && roundTripped.targetDrift.to === 'base-2' && roundTripped.verifyChanged === true && roundTripped.verifyFingerprints.from === 'sha256:old' && roundTripped.verifyFingerprints.to === 'sha256:new',
    JSON.stringify(roundTripped),
  )
  const running = {
    id: 'T-8',
    title: 'run',
    status: 'running',
    kind: 'dev',
    base: 'base-1',
    dependsOn: [],
    writeFiles: [],
    attempts: 1,
    maxAttempts: 3,
    history: [],
    executors: [],
    verifyFingerprint: 'sha256:old',
    merge: null,
    review: null,
    dispatch: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  }
  const submitted = submitTask({ version: 2, seq: 1, tasks: [running] }, 'T-8', { merge: { status: 'open', base: 'base-2', target: 'main', head: 'head-8' }, targetBase: 'base-2', verifyFingerprint: 'sha256:new' }, now, 'worker', 'worker')
  check(
    'T-156 a submit after the verify changed records the new baseline and verifyChanged',
    submitted.ok === true &&
      submitted.task.targetBase === 'base-2' &&
      submitted.task.verifyFingerprint === 'sha256:new' &&
      submitted.task.merge.verifyChanged === true &&
      submitted.task.merge.verifyFingerprints.from === 'sha256:old' &&
      submitted.task.merge.verifyFingerprints.to === 'sha256:new',
    JSON.stringify(submitted.ok === true ? { targetBase: submitted.task.targetBase, verifyChanged: submitted.task.merge.verifyChanged, prints: submitted.task.merge.verifyFingerprints } : submitted),
  )
  const refreshed = refreshMergeRequest(boardOf(makeTask()), 'T-9', 'base-2', 'head-2', ['new.gd'], now, 'merger')
  const refreshedTask = refreshed.ok === true ? refreshed.board.tasks[0] : null
  const refreshedBrief = refreshedTask === null ? '' : reviewBriefFor(refreshedTask, '/project')
  check(
    'T-156 a refreshed drift moves task.base too, so the brief shows the NEW base in the diff line',
    refreshedTask !== null &&
      refreshedTask.base === 'base-2' &&
      refreshedTask.targetBase === 'base-2' &&
      refreshedTask.merge.base === 'base-2' &&
      refreshedTask.merge.targetDrift.from === 'base-1' &&
      refreshedBrief.indexOf('Diff under review: base-2..head-2') >= 0 &&
      refreshedBrief.indexOf('base-1..head-2') < 0,
    JSON.stringify(refreshedTask === null ? refreshed : { base: refreshedTask.base, mergeBase: refreshedTask.merge.base, brief: refreshedBrief.slice(0, 300) }),
  )
  check(
    'T-156 the drift paragraph is true for a refresh too (re-based, not a candidate-rebuild claim)',
    refreshedBrief.indexOf('re-based on the NEW head') >= 0 && refreshedBrief.indexOf('test candidate was rebuilt') < 0,
    refreshedBrief.slice(0, 700),
  )
  const legacy = normaliseMerge({ status: 'open' })
  check('T-156 a legacy/unchanged merge record has no drift noise', legacy.targetDrift === null && legacy.verifyChanged === false && legacy.verifyFingerprints === null, JSON.stringify(legacy))

  // ── T-201: refreshMerge is a transition with an idempotency key ──
  const unchanged = boardOf(makeTask({ merge: { status: 'open', base: 'base-1', head: 'head-1', target: 'main' } }))
  const sameRefresh = refreshMergeRequest(unchanged, 'T-9', 'base-1', 'head-1', [], now, 'w')
  check('T-201 an unchanged refresh is a typed no-change and does not spend a review round', sameRefresh.ok !== true && sameRefresh.code === 'no-change' && (unchanged.tasks[0].review === null || unchanged.tasks[0].review === undefined), JSON.stringify(sameRefresh))
  const closedTask = makeTask({ status: 'done', merge: { status: 'merged', base: 'base-1', head: 'head-1', target: 'main', mergeCommit: 'merge-1' } })
  const closedBoard = boardOf(closedTask)
  const closedRefresh = refreshMergeRequest(closedBoard, 'T-9', 'base-2', 'head-2', [], now, 'w')
  check('T-201 refreshMerge refuses a closed card and leaves its merge record intact', closedRefresh.ok !== true && closedRefresh.code === 'closed' && closedBoard.tasks[0].merge.status === 'merged', JSON.stringify(closedRefresh))
}


// ── T-201 round 2: a merge-* block clears the claim (INV-blocked) and keeps the
//    implementer as lastAssignee; refreshMerge must accept THAT worker, and only
//    that worker or the user, for a merge-outcome pause ─────────────────────
{
  const check = (label, condition, detail) => {
    assert.ok(condition, label + (detail === undefined ? '' : ' -> ' + String(detail).slice(0, 700)))
    console.log('PASS  ' + label)
  }
  const { refreshMergeRequest: refresh } = await import('../../plugin/task-center/merge.mjs')
  const mergedAt = Date.parse('2026-11-20T00:00:00.000Z')
  const makeBlocked = (over) =>
    Object.assign(
      {
        id: 'T-5',
        title: 'repair',
        kind: 'dev',
        status: 'blocked',
        base: 'base-1',
        target: 'main',
        branch: 'task/T-5',
        worktree: '/wt/T-5',
        merge: { status: 'conflict', base: 'base-1', head: 'head-1', target: 'main' },
        review: { status: 'approved', attempt: 1 },
        test: { status: 'passed', attempt: 1 },
        assignee: null,
        lastAssignee: { name: 'worker-t-5', session: 'agent-w' },
        blockedReason: { code: 'merge-conflict', detail: 'a.gd', from: 'testing', auto: false, at: new Date(mergedAt).toISOString() },
        leaseUntil: null,
        executors: [],
        history: [],
        updatedAt: new Date(mergedAt).toISOString(),
      },
      over === undefined ? {} : over,
    )
  const kernelAssigneeMatches = (task, owner) => {
    if (owner === null) return true
    if (task.assignee === null || task.assignee === undefined) return true
    if (owner.session !== null && owner.session !== undefined && task.assignee.session === owner.session) return true
    if (owner.name !== null && owner.name !== undefined && task.assignee.name === owner.name) return true
    return task.assignee.session === null || task.assignee.session === undefined
  }
  function refreshHarness(task) {
    const board = { tasks: [task] }
    const seen = { started: [], delivered: [] }
    const actions = createMergeActions({
      mergeRefusal: () => null,
      mergeQueueKey: async () => 'main',
      serialised: async (work) => work({ aborted: false }),
      mergeOne: async () => ({ ok: true }),
      notifyMergeOutcome: async () => {},
      readBoardOrFail: async () => ({ board: board }),
      model: { findTask: (source, id) => source.tasks.filter((entry) => entry.id === id)[0] },
      writeTask: async (project, id, mutator) => {
        const applied = mutator(board)
        if (applied.ok !== true) return applied
        return { ok: true, task: applied.board.tasks.filter((entry) => entry.id === id)[0], events: applied.events }
      },
      recordMergeResult: () => ({ ok: true }),
      clock: () => mergedAt,
      writeByName: () => 'worker-t-5',
      emitActivity: () => {},
      refreshMergeRequest: refresh,
      ownerOf: (context) => (context.role === 'user' ? null : { session: context.agent.id, name: context.by }),
      assigneeMatches: kernelAssigneeMatches,
      readTargetHead: async () => ({ ok: true, head: 'base-2' }),
      readBranchHead: async () => ({ ok: true, head: 'head-2' }),
      git: { diffNameOnly: async () => ({ ok: true, files: ['a.gd'] }) },
      messageOf: (error) => String(error && error.message ? error.message : error),
      // T-223: the ONE authority starts the reviewer (the action no longer calls
      // the stage service itself). This stub records the same facts the old
      // startReviewer + recordDeliveredTo pair did.
      stageCoordinator: {
        async ensure(kind, entry) {
          seen.started.push(entry.id)
          const member = { name: 'reviewer-t-5', id: 'reviewer-T-5-2' }
          seen.delivered.push({ id: entry.id, kind: kind, member: member })
          return { ok: true, action: 'spawned', agentId: member.id, name: member.name, taskId: entry.id, kind: kind }
        },
      },
      markWaiting: async () => {},
      clearWaiting: async () => {},
      reviewBriefFor: () => 'review brief',
      ok: (payload) => Object.assign({ ok: true }, payload),
      failure: (code, message) => ({ ok: false, code: code, message: message }),
    })
    return { actions: actions, seen: seen }
  }
  const implementer = { role: 'agent', by: '@worker-t-5', agent: { id: 'agent-w', name: 'worker-t-5' } }
  {
    const rig = refreshHarness(makeBlocked())
    const out = await rig.actions.refreshMerge({ id: 'T-5' }, implementer, '/project')
    check(
      'T27 the implementer kept as lastAssignee reaches refreshMerge after a merge-* block',
      out.ok === true && out.task.status === 'reviewing' && out.task.blockedReason === null && out.task.merge.status === 'open' && out.task.review.attempt === 2,
      JSON.stringify(out.ok === true ? { status: out.task.status, merge: out.task.merge.status, attempt: out.task.review.attempt } : out),
    )
    check(
      'the refreshed round gets a live reviewer and its deliveredTo',
      rig.seen.started.length === 1 && rig.seen.started[0] === 'T-5' && rig.seen.delivered.length === 1 && rig.seen.delivered[0].kind === 'reviewer' && rig.seen.delivered[0].member.id === 'reviewer-T-5-2',
      JSON.stringify(rig.seen),
    )
  }
  {
    const rig = refreshHarness(makeBlocked())
    const stranger = { role: 'agent', by: '@worker-x', agent: { id: 'agent-x', name: 'worker-x' } }
    const out = await rig.actions.refreshMerge({ id: 'T-5' }, stranger, '/project')
    check('another worker still cannot refresh the card', out.ok !== true && out.code === 'not-assignee' && rig.seen.started.length === 0, JSON.stringify(out))
  }
  {
    const rig = refreshHarness(makeBlocked({ blockedReason: { code: 'review-timeout', detail: null, from: 'reviewing', auto: true, at: new Date(mergedAt).toISOString() } }))
    const out = await rig.actions.refreshMerge({ id: 'T-5' }, implementer, '/project')
    check('a NON-merge block is not refreshed away by its implementer either', out.ok !== true && out.code === 'not-mergeable-phase', JSON.stringify(out))
  }
  {
    const rig = refreshHarness(makeBlocked({ assignee: { name: 'worker-live', session: 'agent-live' } }))
    const out = await rig.actions.refreshMerge({ id: 'T-5' }, implementer, '/project')
    check('an open claim wins over lastAssignee when the two disagree', out.ok !== true && out.code === 'not-assignee', JSON.stringify(out))
  }
}

// ── T-204: a refresh REPLACES the round's reviewer; the previous one stops
//    before the next one starts, and a failed write never leaves a child behind
{
  const check = (label, condition, detail) => {
    assert.ok(condition, label + (detail === undefined ? '' : ' -> ' + String(detail).slice(0, 700)))
    console.log('PASS  ' + label)
  }
  const { refreshMergeRequest: refreshRound } = await import('../../plugin/task-center/merge.mjs')
  const at = Date.parse('2026-11-21T00:00:00.000Z')
  function roundTask(over) {
    return Object.assign(
      {
        id: 'T-9',
        title: 'refresh rounds',
        kind: 'dev',
        status: 'reviewing',
        ownerSession: 'root',
        base: 'base-1',
        target: 'main',
        branch: 'task/T-9',
        worktree: '/wt/T-9',
        commit: 'head-1',
        merge: { status: 'open', base: 'base-1', head: 'head-1', target: 'main' },
        review: { status: 'pending', by: '@worker-t-9', at: new Date(at).toISOString(), attempt: 1, deliveredTo: { name: 'reviewer-t-9-old', id: 'reviewer-old' } },
        test: null,
        assignee: { name: 'worker-t-9', session: 'worker-9' },
        lastAssignee: null,
        blockedReason: null,
        leaseUntil: null,
        executors: [],
        history: [],
        updatedAt: new Date(at).toISOString(),
      },
      over === undefined ? {} : over,
    )
  }
  function roundHarness(task) {
    const board = { tasks: [task] }
    const delivered = task.review !== null && task.review !== undefined && task.review.deliveredTo !== null && task.review.deliveredTo !== undefined ? task.review.deliveredTo.id : null
    const live = new Set(delivered === null ? [] : [delivered])
    const calls = []
    const head = { value: 'head-2' }
    const flags = { failWrite: false, keepOldLive: false, throwRelease: false, unresolvedId: null, liveUnreadable: false }
    let sequence = 0
    function recordedIds(entry) {
      const ids = []
      for (const record of [entry.review, entry.test]) {
        if (record === null || record === undefined || record.deliveredTo === null || record.deliveredTo === undefined) continue
        if (typeof record.deliveredTo.id === 'string' && record.deliveredTo.id !== '') ids.push(record.deliveredTo.id)
      }
      return ids
    }
    const stageService = {
      async releaseTask(entry, options) {
        const ids = recordedIds(entry)
        calls.push({ kind: 'releaseTask', ids: ids, roles: options.roles })
        // A teardown that failed must refuse the replacement even when the
        // append-only catalog already reports the child as inactive.
        if (flags.throwRelease) {
          live.clear()
          throw new Error('the stage runtime refused the release')
        }
        if (flags.unresolvedId !== null) {
          live.delete(flags.unresolvedId)
          return { ok: false, released: [], failed: [], unresolved: [{ agentId: flags.unresolvedId }], interrupted: [], kept: [], deferred: [] }
        }
        const released = []
        for (const id of ids) {
          if (flags.keepOldLive) continue
          if (live.delete(id)) released.push({ agentId: id })
        }
        return { ok: true, released: released, failed: [], unresolved: [], interrupted: [], kept: [], deferred: [] }
      },
      async startReviewer() {
        sequence += 1
        const agentId = 'reviewer-new-' + String(sequence)
        calls.push({ kind: 'startReviewer', agentId: agentId })
        live.add(agentId)
        return { ok: true, agentId: agentId, name: 'reviewer-t-9-' + String(sequence) }
      },
      async release(agentId) {
        calls.push({ kind: 'release', agentId: String(agentId) })
        return live.delete(String(agentId))
      },
    }
    // T-223: the real coordinator drives the spawn decision; only its seams are
    // faked (the board write lands in the harness board).
    const stageCoordinator = createStageCoordinator({
      stageService: stageService,
      readBoard: async () => ({ board: board }),
      recordDelivery: async (projectPath, taskId, kind, delivery) => {
        const applied = applyStageDelivery(board, taskId, kind, delivery)
        if (applied.ok !== true) return applied
        board.tasks = applied.board.tasks
        return { ok: true }
      },
      clock: () => at,
    })
    const actions = createMergeActions({
      mergeRefusal: () => null,
      mergeQueueKey: async () => 'main',
      serialised: async (work) => work({ aborted: false }),
      mergeOne: async () => ({ ok: true }),
      notifyMergeOutcome: async () => {},
      readBoardOrFail: async () => ({ board: board }),
      model: { findTask: (source, id) => source.tasks.filter((entry) => entry.id === id)[0] },
      writeTask: async (project, id, mutator) => {
        if (flags.failWrite) return { ok: false, code: 'write-conflict', message: 'the board moved under the refresh' }
        const applied = mutator(board)
        if (applied.ok !== true) return applied
        // The real CAS writes the returned board back; mirror it for the next read.
        board.tasks = applied.board.tasks
        return { ok: true, task: applied.board.tasks.filter((entry) => entry.id === id)[0], events: applied.events }
      },
      recordMergeResult: () => ({ ok: true }),
      clock: () => at,
      writeByName: () => 'worker-t-9',
      emitActivity: () => {},
      refreshMergeRequest: refreshRound,
      ownerOf: () => ({ name: 'worker-t-9', session: 'worker-9' }),
      assigneeMatches: () => true,
      readTargetHead: async () => ({ ok: true, head: 'base-1' }),
      readBranchHead: async () => ({ ok: true, head: head.value }),
      git: { diffNameOnly: async () => ({ ok: true, files: ['a.gd'] }) },
      messageOf: (error) => String(error && error.message ? error.message : error),
      // T-223: release stays with the stage service; STARTS go through the
      // coordinator-only `stageCoordinator` seam below.
      stageAgents: stageService,
      stageCoordinator: stageCoordinator,
      // Running ids only (the DSH catalog keeps disposed children as inactive
      // rows); null models a facade that cannot read the tree at all.
      liveStageIds: async () => (flags.liveUnreadable ? null : new Set(live)),
      markWaiting: async () => {},
      clearWaiting: async () => {},
      reviewBriefFor: () => 'review brief',
      ok: (payload) => Object.assign({ ok: true }, payload),
      failure: (code, message) => ({ ok: false, code: code, message: message }),
    })
    return { actions: actions, board: board, live: live, calls: calls, head: head, flags: flags }
  }
  const worker = { by: '@worker-t-9', role: 'agent', agent: { id: 'worker-9', name: 'worker-t-9' } }

  {
    const rig = roundHarness(roundTask())
    const first = await rig.actions.refreshMerge({ id: 'T-9' }, worker, '/project')
    check(
      'a refresh releases the previous reviewer BEFORE starting the next one',
      first.ok === true && rig.calls.map((call) => call.kind).join(',') === 'releaseTask,startReviewer' && rig.live.size === 1 && rig.live.has('reviewer-new-1'),
      JSON.stringify({ calls: rig.calls, live: Array.from(rig.live) }),
    )
    rig.head.value = 'head-3'
    const second = await rig.actions.refreshMerge({ id: 'T-9' }, worker, '/project')
    const secondRelease = rig.calls.filter((call) => call.kind === 'releaseTask').slice(-1)[0]
    check(
      'two consecutive refreshes leave exactly ONE live reviewer (the last one)',
      second.ok === true &&
        rig.calls.map((call) => call.kind).join(',') === 'releaseTask,startReviewer,releaseTask,startReviewer' &&
        rig.live.size === 1 &&
        rig.live.has('reviewer-new-2') &&
        rig.live.has('reviewer-new-1') === false &&
        secondRelease.ids.join(',') === 'reviewer-new-1',
      JSON.stringify({ calls: rig.calls, live: Array.from(rig.live), release: secondRelease }),
    )
    check(
      'the refreshed round records the reviewer it matches its live child',
      rig.board.tasks[0].review.deliveredTo.id === 'reviewer-new-2' && rig.board.tasks[0].merge.head === 'head-3',
      JSON.stringify(rig.board.tasks[0].review),
    )
  }

  {
    const rig = roundHarness(roundTask())
    rig.flags.keepOldLive = true
    const refused = await rig.actions.refreshMerge({ id: 'T-9' }, worker, '/project')
    check(
      'a reviewer that cannot be stopped refuses the refresh instead of starting a second one',
      refused.ok !== true &&
        refused.code === 'stage-child-still-live' &&
        rig.calls.filter((call) => call.kind === 'startReviewer').length === 0 &&
        rig.board.tasks[0].merge.head === 'head-1' &&
        rig.board.tasks[0].review.deliveredTo.id === 'reviewer-old',
      JSON.stringify({ refused: refused, calls: rig.calls }),
    )
  }

  {
    const rig = roundHarness(roundTask())
    rig.flags.failWrite = true
    const failedWrite = await rig.actions.refreshMerge({ id: 'T-9' }, worker, '/project')
    check(
      // T-223: the round is written BEFORE the child starts, so a failed write
      // starts nothing at all (previously a reviewer was started and rolled back).
      'a refresh whose board write fails starts no reviewer at all',
      failedWrite.ok !== true &&
        failedWrite.code === 'write-conflict' &&
        rig.calls.filter((call) => call.kind === 'startReviewer').length === 0 &&
        rig.live.size === 0,
      JSON.stringify({ calls: rig.calls, live: Array.from(rig.live) }),
    )
  }

  {
    const rig = roundHarness(roundTask())
    rig.flags.throwRelease = true
    const refused = await rig.actions.refreshMerge({ id: 'T-9' }, worker, '/project')
    check(
      'a release that throws refuses the refresh instead of starting a second reviewer',
      refused.ok !== true &&
        refused.code === 'stage-child-still-live' &&
        rig.calls.filter((call) => call.kind === 'startReviewer').length === 0 &&
        rig.board.tasks[0].merge.head === 'head-1',
      JSON.stringify({ refused: refused, calls: rig.calls }),
    )
  }

  {
    const rig = roundHarness(roundTask())
    rig.flags.unresolvedId = 'reviewer-old'
    rig.flags.liveUnreadable = true
    const refused = await rig.actions.refreshMerge({ id: 'T-9' }, worker, '/project')
    check(
      'an unresolved release with an unreadable tree refuses the refresh',
      refused.ok !== true &&
        refused.code === 'stage-child-still-live' &&
        String(refused.message).indexOf('reviewer-old') >= 0 &&
        rig.calls.filter((call) => call.kind === 'startReviewer').length === 0,
      JSON.stringify({ refused: refused, calls: rig.calls }),
    )
  }

  {
    const rig = roundHarness(roundTask())
    // The record-only fallback reports an already-gone id as unresolved; the
    // READABLE tree shows it is not running, so the refresh must still start.
    rig.flags.unresolvedId = 'reviewer-old'
    rig.flags.liveUnreadable = false
    const refreshed = await rig.actions.refreshMerge({ id: 'T-9' }, worker, '/project')
    check(
      'an unresolved id the tree proves inactive does not block the replacement',
      refreshed.ok === true && rig.live.has('reviewer-new-1') && rig.calls.filter((call) => call.kind === 'startReviewer').length === 1,
      JSON.stringify({ refreshed: refreshed.ok, calls: rig.calls, live: Array.from(rig.live) }),
    )
  }
}

console.log('PASS  merge actions preserve queue/notify/reject/refusal paths')
