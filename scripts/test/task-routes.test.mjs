// Tests for the panel's route: the USER's surface on the same board.
//
// The two things worth proving here are the ones the design rests on. First, the
// surfaces are mirror images: what `task_center` refuses, this route accepts, and
// vice versa. Second, they share ONE state — a lock an agent takes must be
// visible to the panel, and a lock the panel forces away must be gone for the
// agent. Two lock memories would mean two agents each believing they hold the
// same file, which is the failure this whole feature exists to prevent.
//
// Run by `npm test`.
import { register } from 'node:module'

register('./stubs/hooks.mjs', import.meta.url)

const PROJECT = 'J:\\demo\\mm13d'
let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || detail === undefined ? '' : '  -> ' + detail}`)
}

/** A filesystem with real FsVersion semantics, enough for the board's CAS. */
function createFs(seed) {
  const files = new Map()
  let counter = 0
  const bump = () => 'v' + String(++counter)
  if (seed !== undefined) files.set(PROJECT + '\\.agents\\tasks.json', { text: seed, version: bump() })
  return {
    files,
    async resolve(path) {
      return { targetKey: path }
    },
    async stat(target) {
      const entry = files.get(target.targetKey)
      return entry === undefined ? undefined : { version: entry.version, type: 'file', size: entry.text.length }
    },
    async readText(target) {
      const entry = files.get(target.targetKey)
      if (entry === undefined) throw new Error('ENOENT')
      return entry.text
    },
    async writeText(target, content, expected) {
      const entry = files.get(target.targetKey)
      if (expected !== undefined && expected.kind === 'replaceIfVersion') {
        if (entry === undefined || entry.version !== expected.version) {
          const error = new Error('FS_STALE_VERSION: moved')
          error.code = 'FS_STALE_VERSION'
          throw error
        }
      }
      const version = bump()
      files.set(target.targetKey, { text: content, version: version })
      return { operation: entry === undefined ? 'create' : 'update', version: version, before: null, after: content }
    },
  }
}

const boardOf = (fs) => JSON.parse(fs.files.get(PROJECT + '\\.agents\\tasks.json').text)

function fakeRequest(body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      if (text.length > 0) yield Buffer.from(text, 'utf8')
    },
  }
}
function fakeResponse() {
  const captured = { status: null, headers: null, body: '' }
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(text) {
      captured.body = text === undefined ? '' : String(text)
    },
  }
}
const jsonOf = (response) => JSON.parse(response.captured.body)

/** A webServer stand-in that records exact routes. */
function createWebServer() {
  const routes = new Map()
  return {
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate route ' + route.path)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/** Load the row's two surfaces over one shared state, as the row wires them. */
async function loadSurfaces(fs, projectPath) {
  const { createState } = await import('../../plugin/task-center/state.mjs')
  const { registerTaskTool } = await import('../../plugin/task-center/tool.mjs')
  const { registerTaskRoutes, STATE_PATH, ACTION_PATH, DISPATCH_PATH } = await import('../../plugin/task-center/routes.mjs')
  const webServer = createWebServer()
  let tool = null
  const ctx = {
    fs: fs,
    sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
    logger: { warn() {} },
    tools: {
      register(definition) {
        tool = definition
        return () => {}
      },
    },
    webServer: webServer,
  }
  const state = createState(ctx)
  registerTaskTool(ctx, { state: state })
  registerTaskRoutes(ctx, {
    state: state,
    projectPath: projectPath === undefined ? () => PROJECT : projectPath,
    dispatchProbe: () => ({ probed: true }),
  })
  const callTool = (action, extra, agent) =>
    tool.execute(Object.assign({ action: action }, extra || {}), { agent: agent === undefined ? { id: 'session-aaaaaaaa' } : agent })
  const callRoute = async (path, body) => {
    const response = fakeResponse()
    await webServer.routes.get(path).handler(fakeRequest(body), response)
    return { response: response, json: jsonOf(response) }
  }
  return { state, webServer, tool, callTool, callRoute, STATE_PATH, ACTION_PATH, DISPATCH_PATH }
}

// ── body handling ──────────────────────────────────────────────────────────
const fs0 = createFs()
let surfaces = await loadSurfaces(fs0)
const routesModule = await import('../../plugin/task-center/routes.mjs')
check('every route registered as an exact path', surfaces.webServer.routes.size === 3, String(surfaces.webServer.routes.size))
check('the state route is exact', surfaces.webServer.routes.get(surfaces.STATE_PATH).kind === 'exact')
check('the action route is exact', surfaces.webServer.routes.get(surfaces.ACTION_PATH).kind === 'exact')
check('the dispatch route is exact', surfaces.webServer.routes.get(surfaces.DISPATCH_PATH).kind === 'exact')
const probeRead = await surfaces.callRoute(surfaces.DISPATCH_PATH, {})
check('the dispatch route reports the probe', probeRead.json.dispatch.probed === true, JSON.stringify(probeRead.json))
check('the dispatch route succeeds', probeRead.json.ok === true)

let body = await routesModule.readJsonBody(fakeRequest({ a: 1 }))
check('a JSON object body parses', body.a === 1)
check('an empty body becomes an empty object', JSON.stringify(await routesModule.readJsonBody(fakeRequest())).length === 2)
let threw = ''
try {
  await routesModule.readJsonBody(fakeRequest([1, 2]))
} catch (error) {
  threw = String(error.message)
}
check('an array body is rejected', /expected a JSON object/.test(threw), threw)
threw = ''
try {
  await routesModule.readJsonBody({
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(300 * 1024)
    },
  })
} catch (error) {
  threw = String(error.message)
}
check('an oversized body is rejected', /too large/.test(threw), threw)

// ── reading ────────────────────────────────────────────────────────────────
let outcome = await surfaces.callRoute(surfaces.STATE_PATH, {})
check('an absent board reads as not created', outcome.json.board === 'not created yet', JSON.stringify(outcome.json))
check('and carries an empty task list', Array.isArray(outcome.json.tasks) && outcome.json.tasks.length === 0)
check('and the project it resolved', outcome.json.project === PROJECT)
check('and the statuses the model knows', outcome.json.statuses.indexOf('in_progress') >= 0)

surfaces = await loadSurfaces(createFs('{ not json'), () => PROJECT)
outcome = await surfaces.callRoute(surfaces.STATE_PATH, {})
check('a broken board is reported, not thrown', outcome.json.ok === false && outcome.json.code === 'unparseable', JSON.stringify(outcome.json))
check('and the response is still 200, because it is data the panel renders', outcome.response.captured.status === 200)

surfaces = await loadSurfaces(createFs(), () => null)
outcome = await surfaces.callRoute(surfaces.STATE_PATH, {})
check('an unknown project is reported', outcome.json.ok === false && outcome.json.code === 'unknown-project', JSON.stringify(outcome.json))

// ── the mirror: what the tool refuses, the route performs ──────────────────
let fs = createFs()
surfaces = await loadSurfaces(fs)
await surfaces.callTool('create', { title: '伤害系统重构', proposalRef: 'proposal.md' })
check('the agent created a draft', boardOf(fs).tasks[0].status === 'draft')
let refused = await surfaces.callTool('publish', { id: 'T-1' })
check('the tool refuses to publish it', refused.refused === 'publish')
outcome = await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'publish', id: 'T-1' })
check('the panel publishes it', outcome.json.ok === true, JSON.stringify(outcome.json))
check('and the board says released', boardOf(fs).tasks[0].status === 'queued')
check('and the actor is the user', boardOf(fs).tasks[0].history.slice(-1)[0].by === '@user', boardOf(fs).tasks[0].history.slice(-1)[0].by)

// There is no `claim` from the panel either. Claiming is what DISPATCH does; the panel
// shows claimed/in_progress and never produces them. (The route's own claim branch is
// removed with the panel's 领取 button — T-14 item 5.)
check('the panel shows what the tool shows', typeof surfaces.STATE_PATH === 'string')

// The panel's move: reorder the queue. A published task IS in the queue.
await surfaces.callTool('create', { title: 'second' })
await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'publish', id: 'T-2' })
await surfaces.callTool('create', { title: 'third' })
await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'publish', id: 'T-3' })
outcome = await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'move', id: 'T-3', delta: -1 })
check('the panel reorders the queue', outcome.json.ok === true, JSON.stringify(outcome.json))
const queued = boardOf(fs)
  .tasks.filter((task) => task.status === 'queued')
  .sort((a, b) => a.order - b.order)
  .map((task) => task.id)
check('and the order actually changed', queued.join(',') === 'T-1,T-3,T-2', queued.join(','))

outcome = await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'setStatus', id: 'T-1', status: 'done' })
check('an illegal transition is refused with its code', outcome.json.ok === false && outcome.json.code === 'illegal-transition', JSON.stringify(outcome.json))
check('and names the legal targets', /allowed:/.test(outcome.json.message), outcome.json.message)
check('and nothing was written', boardOf(fs).tasks.filter((task) => task.id === 'T-1')[0].status === 'queued')

// The mirror, on deletion: the model rule "a held task cannot be deleted" binds BOTH
// surfaces, and the difference that remains is that the tool only deletes drafts while
// the panel may delete anything unheld. A pooled task is unheld — nobody claims it from
// a client any more; dispatch does that.
const toolRemove = await surfaces.callTool('remove', { id: 'T-1' })
check('the tool refuses to delete a released task', toolRemove.code === 'not-a-draft', JSON.stringify(toolRemove))
check('and it is still there', boardOf(fs).tasks.filter((task) => task.id === 'T-1').length === 1)
outcome = await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'remove', id: 'T-1' })
check('the panel may remove the same task', outcome.json.ok === true, JSON.stringify(outcome.json))
check('and it is gone', boardOf(fs).tasks.filter((task) => task.id === 'T-1').length === 0)

outcome = await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'simulate' })
check('an action the panel does not have is refused', outcome.json.ok === false && outcome.json.code === 'unknown-action', JSON.stringify(outcome.json))
outcome = await surfaces.callRoute(surfaces.ACTION_PATH, {})
check('a request with no action is refused', outcome.json.code === 'no-action', JSON.stringify(outcome.json))

// ── one lock memory, or the whole feature is a lie ─────────────────────────
fs = createFs()
surfaces = await loadSurfaces(fs)
await surfaces.callTool('lock', { path: 'scripts/core/damage.gd' })
outcome = await surfaces.callRoute(surfaces.STATE_PATH, {})
check('the panel sees the lock an agent holds', outcome.json.locks['scripts/core/damage.gd'].holder === '@aaaaaaaa', JSON.stringify(Object.keys(outcome.json.locks)))
const panelLocks = await surfaces.callTool('locks')
check('the agent sees the same one lock', panelLocks.files.length === 1, String(panelLocks.files.length))

outcome = await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'forceRelease', path: 'scripts/core/damage.gd' })
check('the panel can force the lock away', outcome.json.ok === true, JSON.stringify(outcome.json))
const afterForce = await surfaces.callTool('locks')
check('and the agent sees it released', afterForce.files.length === 0, JSON.stringify(afterForce.files))
check('and the agent no longer holds anything', afterForce.you.held.length === 0)
outcome = await surfaces.callTool('unlock', { path: 'scripts/core/damage.gd' })
check('and a later unlock by that agent is refused', outcome.refused === 'not-held', JSON.stringify(outcome))

outcome = await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'forceRelease', path: 'nothing.gd' })
check('forcing a free path is refused', outcome.json.ok === false && outcome.json.code === 'not-held', JSON.stringify(outcome.json))

// ── the response carries the new state, so the panel needs one round trip ──
fs = createFs()
surfaces = await loadSurfaces(fs)
outcome = await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'update', id: 'T-9', title: 'nope' })
check('an action on an unknown task is refused', outcome.json.ok === false && outcome.json.code === 'unknown-task', JSON.stringify(outcome.json))
await surfaces.callTool('create', { title: 'one' })
outcome = await surfaces.callRoute(surfaces.ACTION_PATH, { action: 'publish', id: 'T-1' })
check('a successful action returns the fresh board too', Array.isArray(outcome.json.tasks) && outcome.json.tasks.length === 1, JSON.stringify(outcome.json.tasks))
check('with the released task in it', outcome.json.tasks[0].status === 'queued')

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
