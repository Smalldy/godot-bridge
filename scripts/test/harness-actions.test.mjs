import assert from 'node:assert/strict'
import { createHarnessActions } from '../../plugin/task-center/actions/harness.mjs'

const ok = (payload) => Object.assign({ ok: true }, payload)
const failure = (code, message) => ({ ok: false, code: code, message: message })
const harness = {
  status: () => ({ port: 1234, url: 'http://127.0.0.1:1234/', cookie: true }),
  logs: () => ['line'],
  start: async (project) => ({ ok: true, started: project }),
  stop: async () => ({ ok: true, stopped: true }),
  restart: async (project) => ({ ok: true, restarted: project }),
  smoke: async (project) => ({ ok: true, smoke: project }),
}
const actions = createHarnessActions({ harnessRefusal: () => null, harness: harness, ok: ok, failure: failure })

const status = await actions.harnessStatus({}, {}, '/project')
assert.equal(status.ok, true)
assert.equal(status.port, 1234)
assert.equal(status.cookie, true)
assert.deepEqual(status.logs, ['line'])

assert.deepEqual(await actions.harnessStart({}, {}, '/project'), { ok: true, started: '/project' })
assert.deepEqual(await actions.harnessStop({}, {}, '/project'), { ok: true, stopped: true })
assert.deepEqual(await actions.harnessRestart({}, {}, '/project'), { ok: true, restarted: '/project' })
assert.deepEqual(await actions.harnessSmoke({}, {}, '/project'), { ok: true, smoke: '/project' })

const denied = createHarnessActions({ harnessRefusal: () => failure('denied', 'no'), harness: harness, ok: ok, failure: failure })
assert.equal((await denied.harnessStart({}, {}, '/project')).code, 'denied')

const unavailable = createHarnessActions({ harnessRefusal: () => null, harness: null, ok: ok, failure: failure })
assert.equal((await unavailable.harnessStatus({}, {}, '/project')).code, 'harness-unavailable')

console.log('PASS  harness actions preserve status/start/stop/restart/smoke and refusal paths')
