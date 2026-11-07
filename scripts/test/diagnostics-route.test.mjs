import assert from 'node:assert/strict'
import { DIAGNOSTICS_PATH, registerTaskRoutes } from '../../plugin/task-center/routes.mjs'

const handlers = new Map()
const ctx = {
  webServer: {
    register(entry) {
      handlers.set(entry.path, entry.handler)
      return () => {}
    },
  },
  get() {
    return undefined
  },
}

const state = {
  resolveProject: async () => ({ ok: true, project: { root: '/repo' }, resolvedFrom: 'last-active' }),
  noteProject() {},
}

const doctor = {
  inspect: async (project) => ({ ok: true, project: project, status: 'ok', checks: [] }),
}
const merger = { status: () => ({ active: 0, queued: 0, chains: 0, last: null }) }
const scheduler = { status: () => ({ running: false }) }

registerTaskRoutes(ctx, { state: state, api: {}, scheduler: scheduler, merger: merger, doctor: doctor })

const handler = handlers.get(DIAGNOSTICS_PATH)
assert.equal(typeof handler, 'function', 'the diagnostics route is registered')

let status = null
let body = null
const res = {
  writeHead(code) {
    status = code
  },
  end(text) {
    body = text
  },
}
await handler({ headers: {}, url: DIAGNOSTICS_PATH }, res)
assert.equal(status, 200)
const payload = JSON.parse(body)
assert.equal(payload.ok, true)
assert.equal(payload.project, '/repo')
assert.equal(payload.doctor.status, 'ok')
assert.equal(payload.merge.active, 0)
assert.equal(payload.scheduler.running, false)

console.log('PASS  diagnostics route resolves the project and returns doctor + merge + scheduler')
