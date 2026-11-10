import assert from 'node:assert/strict'
import { createMergeActions } from '../../plugin/task-center/actions/merge.mjs'

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
  const { recordCandidate, fingerprintVerify, verifyScriptPaths } = await import('../../plugin/task-center/merge.mjs')
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
  const legacy = normaliseMerge({ status: 'open' })
  check('T-156 a legacy/unchanged merge record has no drift noise', legacy.targetDrift === null && legacy.verifyChanged === false && legacy.verifyFingerprints === null, JSON.stringify(legacy))
}

console.log('PASS  merge actions preserve queue/notify/reject/refusal paths')