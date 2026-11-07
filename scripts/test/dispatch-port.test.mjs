import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const apiPath = fileURLToPath(new URL('../../plugin/task-center/api.mjs', import.meta.url))
const api = readFileSync(apiPath, 'utf8')
assert.equal(api.includes("from './dispatch.mjs'"), false, 'the API no longer imports the dispatcher directly')
assert.equal(api.includes("from './dispatch-port.mjs'"), true, 'the API imports through the port')
assert.equal(api.includes('import { dispatchPort }'), true, 'the API receives one explicit port object')

const port = (await import('../../plugin/task-center/dispatch-port.mjs')).dispatchPort
for (const name of [
  'briefFor',
  'projectTeamState',
  'resolveLead',
  'roleBriefFor',
  'runHostCheck',
  'recordPhaseActivity',
  'servicesFor',
  'workerPool',
]) {
  assert.ok(port[name] !== undefined, 'the port exports ' + name)
}
console.log('PASS  the API depends on the dispatcher through a named port')
