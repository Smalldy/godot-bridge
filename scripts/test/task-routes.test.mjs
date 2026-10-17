// HTTP route tests: the GUI's contract, its transport hardening and the fact
// that it calls the same actions as the tool.

import { join } from 'node:path'
import { registerTaskRoutes, STATE_PATH, ACTION_PATH } from '../../plugin/task-center/routes.mjs'
import { createRig, PROJECT } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

function install(rig) {
  const specs = []
  const webCtx = Object.assign({}, rig.ctx, {
    webServer: {
      register(spec) {
        specs.push(spec)
        return () => {}
      },
    },
  })
  const dispose = registerTaskRoutes(webCtx, { state: rig.state, api: rig.api, scheduler: rig.scheduler })
  const byPath = new Map(specs.map((spec) => [spec.path, spec]))
  return { specs, byPath, dispose }
}

function request(url, options) {
  const opts = options === undefined ? {} : options
  const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  return {
    method: opts.method === undefined ? 'GET' : opts.method,
    url: url,
    headers: opts.headers === undefined ? {} : opts.headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function response() {
  return {
    status: 0,
    headers: null,
    text: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.text = String(text === undefined ? '' : text)
    },
    json() {
      return JSON.parse(this.text)
    },
  }
}

async function call(surface, url, options) {
  const res = response()
  await surface.byPath.get(url.split('?')[0]).handler(request(url, options), res)
  return res
}
const post = (body, headers) =>
  call(surface, ACTION_PATH, { method: 'POST', body: body, headers: Object.assign({ 'content-type': 'application/json' }, headers) })

const rig = createRig({ allowSpawn: false })
const surface = install(rig)
check('registers state, action and diagnostics', surface.specs.length === 3, String(surface.specs.length))

// no project yet
{
  const res = await call(surface, STATE_PATH, {})
  check('state without a project says so', res.status === 200 && res.json().ok === false && res.json().code === 'unknown-project', res.text)
}

// a project in the query is adopted
{
  const url = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  const res = await call(surface, url, {})
  const payload = res.json()
  check('state with a project answers', payload.ok === true && payload.project === PROJECT, res.text)
  check('and reports the dispatch state', payload.dispatch.state === 'paused')
  check('and remembers the project', rig.state.memory.projectHint === PROJECT)
}

// create, start, pause through the action route
{
  let res = await post({ action: 'create', title: 'A', dependsOn: [] })
  let payload = res.json()
  check('the route creates a task', payload.ok === true && payload.task.title === 'A', res.text)
  check('the response carries the board snapshot', payload.snapshot !== undefined && payload.snapshot.tasks.length === 1)
  const id = payload.task.id
  res = await post({ action: 'start' })
  payload = res.json()
  check('the route starts dispatch', payload.ok === true && payload.dispatch.state === 'running', res.text)
  res = await post({ action: 'pause' })
  check('the route pauses dispatch', res.json().dispatch.state === 'paused', res.text)
  res = await post({ action: 'get', id: id })
  check('the route reads one task', res.json().ok === true && res.json().task.id === id, res.text)
  res = await post({ action: 'board' })
  check('the route returns the board', res.json().ok === true && res.json().tasks.length === 1)
}

// one public setting: concurrency; the worker cap is derived
{
  const res = await post({ action: 'settings', maxConcurrent: 5 })
  const payload = res.json()
  check('settings accepts a single concurrency value', payload.ok === true && payload.dispatch.maxConcurrent === 5, res.text)
  check('the worker cap derives as concurrency + 1', payload.dispatch.maxWorkAgents === 6, JSON.stringify(payload.dispatch))
  check('spawning stays enabled by the same setting', payload.dispatch.allowSpawn === true, JSON.stringify(payload.dispatch))
}

// transport hardening
{
  const res = await post({ action: 'board' }, { 'content-type': 'text/plain' })
  check('a non-JSON body is refused', res.status === 415 && res.json().code === 'content-type', res.text)
  const evil = await post({ action: 'board' }, { origin: 'https://evil.example', host: 'localhost:1234' })
  check('a cross-origin action is refused', evil.status === 403 && evil.json().code === 'origin', evil.text)
  const same = await post({ action: 'board' }, { origin: 'http://localhost:1234', host: 'localhost:1234' })
  check('a same-origin action is allowed', same.status === 200 && same.json().ok === true)
  const bad = await call(surface, ACTION_PATH, { method: 'POST', headers: { 'content-type': 'application/json' } })
  check('an empty action is refused', bad.status === 400 && bad.json().code === 'no-action', bad.text)
  const unknown = await post({ action: 'launchRockets' })
  check('an unknown action is a refusal, not a crash', unknown.status === 200 && unknown.json().ok === false && unknown.json().code === 'unknown-action', unknown.text)
}

// openProject moves the panel, after checking the directory exists
{
  const other = join(PROJECT, '..', 'second-project')
  rig.fs.dirs.add(other)
  const res = await post({ action: 'openProject', path: other })
  const payload = res.json()
  check('openProject switches the project', payload.ok === true && payload.project === other, res.text)
  check('and the hint moved', rig.state.memory.projectHint === other)
  const missing = await post({ action: 'openProject', path: join(other, 'missing') })
  check('a missing directory is refused', missing.json().ok === false && missing.json().code === 'not-a-directory', missing.text)
}

// locks through the route
{
  const res = await post({ action: 'lock', paths: ['scripts/a.gd'] })
  const payload = res.json()
  check('the route can take a user lock', payload.ok === true && payload.granted === true, res.text)
  check('the lock is visible in the snapshot', payload.snapshot.locks.some((lock) => lock.path === 'scripts/a.gd'))
  const forced = await post({ action: 'forceUnlock', paths: ['scripts/a.gd'] })
  check('the route can force a lock away', forced.json().ok === true && forced.json().released.join(',') === 'scripts/a.gd', forced.text)
}

surface.dispose()
rig.scheduler.dispose()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)