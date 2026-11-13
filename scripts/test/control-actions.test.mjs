import assert from 'node:assert/strict'
import { createControlActions } from '../../plugin/task-center/actions/control.mjs'

const ok = (payload) => Object.assign({ ok: true }, payload)
const failure = (code, message) => ({ ok: false, code: code, message: message })
let patches = []
let kicked = false
const model = {
  setDispatch: (board, patch) => {
    patches.push(patch)
    return { ok: true, board: { dispatch: Object.assign({}, board.dispatch, patch) }, events: ['dispatch'] }
  },
}
const mutate = async (project, mutateBoard, context) => mutateBoard({ dispatch: { state: 'running' } })
const scheduler = {
  settle: async () => ({ ok: true, settled: true }),
  kick: () => {
    kicked = true
  },
}
const maybeArchive = async () => ({ archived: 0 })
const actions = createControlActions({
  mutate: mutate,
  model: model,
  clock: () => 1000,
  scheduler: scheduler,
  maybeArchive: maybeArchive,
  ok: ok,
  failure: failure,
})

const paused = await actions.pause({}, { by: 'user' }, '/project')
assert.equal(paused.ok, true)
assert.equal(paused.dispatch.state, 'paused')
assert.deepEqual(paused.events, ['dispatch'])
// T-169: control.pause opens a pause episode with the bare state only; the
// service layer owns attribution and must not inherit an old error as reason.
assert.deepEqual(patches[0], { state: 'paused' })

const configured = await actions.settings({ maxConcurrent: 3 }, { role: 'user', by: 'user' }, '/project')
assert.equal(configured.ok, true)
assert.deepEqual(patches[patches.length - 1], { maxConcurrent: 3 })
assert.equal(kicked, true)

// v3: dispatch has one capacity knob (maxConcurrent) plus retry/spawn flags.
const explicit = await actions.settings(
  { maxConcurrent: 6, maxAttempts: 4, allowSpawn: false },
  { role: 'user', by: 'user' },
  '/project',
)
assert.equal(explicit.ok, true)
assert.deepEqual(patches[patches.length - 1], { maxConcurrent: 6, maxAttempts: 4, allowSpawn: false })
const concurrencyOnly = await actions.settings({ maxConcurrent: 5 }, { role: 'user', by: 'user' }, '/project')
assert.equal(concurrencyOnly.ok, true)
assert.deepEqual(patches[patches.length - 1], { maxConcurrent: 5 })

const denied = await actions.settings({}, { role: 'agent' }, '/project')
assert.equal(denied.code, 'user-only')
const noChange = await actions.settings({}, { role: 'user' }, '/project')
assert.equal(noChange.code, 'no-change')

const ticked = await actions.tick({}, { role: 'user' }, '/project')
assert.equal(ticked.ok, true)
assert.equal(ticked.tick.settled, true)
assert.deepEqual(ticked.archive, { archived: 0 })

const noScheduler = createControlActions({
  mutate: mutate,
  model: model,
  clock: () => 1000,
  scheduler: null,
  maybeArchive: maybeArchive,
  ok: ok,
  failure: failure,
})
assert.equal((await noScheduler.tick({}, { role: 'user' }, '/project')).code, 'no-scheduler')

console.log('PASS  control actions preserve pause/settings/tick and user-only gates')
