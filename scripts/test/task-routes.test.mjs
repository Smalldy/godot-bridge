// HTTP route tests (v3): the GUI contract, transport hardening, and the fact
// that /state carries NO legacy Team snapshot. The retired fields (workers /
// teams / agents / team) must not come back; the panel reads agentTree + scope.

import { registerTaskRoutes, STATE_PATH, ACTION_PATH, TASK_PATH, LIST_PATH, WORKTREES_PATH, DIAGNOSTICS_PATH } from '../../plugin/task-center/routes.mjs'
import { createFakeTaskAgents, createRig, createTask, PROJECT } from './support/fixtures.mjs'

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
  const chunks = opts.body === undefined ? [] : [Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))]
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

const TEST_SESSION = 'session-lead'

async function call(surface, url, options) {
  const res = response()
  const withSession = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'session=' + encodeURIComponent(TEST_SESSION)
  await surface.byPath.get(url.split('?')[0]).handler(request(withSession, options), res)
  return res
}
const post = (body, headers) =>
  call(surface, ACTION_PATH, { method: 'POST', body: body, headers: Object.assign({ 'content-type': 'application/json' }, headers) })

const rig = createRig({ taskAgents: createFakeTaskAgents() })
const surface = install(rig)
check('registers state, action, task, list, worktrees and diagnostics', surface.specs.length === 6, String(surface.specs.length))
check(
  'the registered paths are the documented ones',
  [STATE_PATH, ACTION_PATH, TASK_PATH, LIST_PATH, WORKTREES_PATH, DIAGNOSTICS_PATH].every((path) => surface.byPath.has(path)),
)

// no project yet
{
  rig.state.setSessionRoot(TEST_SESSION, null)
  const res = await call(surface, STATE_PATH, {})
  rig.state.setSessionRoot(TEST_SESSION, PROJECT)
  check('state without a bound project says so', res.status === 200 && res.json().ok === false && res.json().code === 'no-project-bound', res.text)
  check('the UI-facing answer is a code plus params', res.json().message === undefined && typeof res.json().params === 'object', res.text)
}

// a project in the query is adopted and the snapshot has no legacy Team block
{
  const url = STATE_PATH + '?project=' + encodeURIComponent(PROJECT)
  const res = await call(surface, url, {})
  const payload = res.json()
  check('state with a project answers', payload.ok === true && payload.project === PROJECT, res.text)
  check('and reports the dispatch state', payload.dispatch.state === 'paused')
  check('and remembers the project', rig.state.memory.projectHint === PROJECT)
  check('the snapshot exposes the live agent tree', payload.agentTree !== null && typeof payload.agentTree === 'object' && payload.agentTree.available === true, JSON.stringify(payload.agentTree))
  check('the snapshot exposes the project/session scope', payload.scope !== null && typeof payload.scope === 'object' && payload.scope.boardProject !== undefined)
  for (const legacy of ['workers', 'teams', 'agents', 'team']) {
    check('the snapshot has no legacy "' + legacy + '" field', payload[legacy] === undefined, 'present: ' + String(payload[legacy]))
  }
}

// first paint: core=1 defers metadata but keeps the board
{
  const res = await call(surface, STATE_PATH + '?project=' + encodeURIComponent(PROJECT) + '&core=1', {})
  const payload = res.json()
  check('core keeps the board and counts', payload.ok === true && Array.isArray(payload.tasks) && typeof payload.counts === 'object')
  check('core defers the agent tree', payload.agentTree.available === false && payload.agentTree.error === 'deferred')
  check('core still has no legacy team fields', payload.workers === undefined && payload.teams === undefined && payload.agents === undefined && payload.team === undefined)
}

// create, start, pause, get, board through the action route
{
  let res = await post({ action: 'create', title: 'A', dependsOn: [], verification: { probes: [{ id: 'suite', command: 'npm test' }] } })
  let payload = res.json()
  check('the route creates a task', payload.ok === true && payload.task.title === 'A', res.text)
  check('the response carries the board snapshot', payload.snapshot !== undefined && payload.snapshot.tasks.length === 1)
  const id = payload.task.id
  res = await post({ action: 'start' })
  payload = res.json()
  check('the route starts dispatch', payload.ok === true && payload.dispatch.state === 'running', res.text)
  res = await post({ action: 'pause' })
  check('the route pauses dispatch', res.json().dispatch.state === 'paused', res.text)
  res = await post({ action: 'start', taskId: id })
  check('start refuses a task id', res.json().ok === false && res.json().code === 'start-is-dispatch-only', res.text)
  res = await post({ action: 'get', id: id })
  check('the route reads one task', res.json().ok === true && res.json().task.id === id, res.text)
  res = await post({ action: 'board' })
  check('the route returns the board', res.json().ok === true && res.json().tasks.length === 1)
  res = await post({ action: 'no-such-action' })
  check('an unknown action is a typed refusal', res.json().ok === false && res.json().code === 'unknown-action', res.text)
}

// transport hardening
{
  let res = await call(surface, ACTION_PATH, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } })
  check('malformed JSON is refused, not crashed', res.status === 400, res.status + ' ' + res.text)
  res = await call(surface, ACTION_PATH, { method: 'POST', body: { action: 'board' }, headers: { 'content-type': 'text/plain' } })
  check('a non-JSON content type is refused', res.status === 400 || res.json().ok === false, res.status + ' ' + res.text)
}

// task detail
{
  const created = await createTask(rig, { title: 'B' })
  const res = await call(surface, TASK_PATH + '?id=' + encodeURIComponent(created.id), {})
  check('the task route returns one detail', res.json().ok === true && res.json().task.id === created.id, res.text)
  const missing = await call(surface, TASK_PATH + '?id=T-404', {})
  check('an unknown task is a typed refusal', missing.json().ok === false && missing.json().code === 'unknown-task', missing.text)
  const noId = await call(surface, TASK_PATH, {})
  check('a missing id is a 400', noId.status === 400 && noId.json().code === 'missing-id', String(noId.status))
}

// list: paging and filtering
{
  const res = await call(surface, LIST_PATH + '?limit=1', {})
  const payload = res.json()
  check('the list route pages', payload.ok === true && Array.isArray(payload.tasks) && payload.tasks.length <= 1, res.text)
  const filtered = await call(surface, LIST_PATH + '?status=pending', {})
  check('the list route filters by status', filtered.json().ok === true && filtered.json().tasks.every((task) => task.status === 'pending'))
}

// worktrees
{
  const res = await call(surface, WORKTREES_PATH, {})
  check('the worktrees route answers', res.json().ok === true && Array.isArray(res.json().worktrees), res.text)
}

// diagnostics: the dispatch probe reports the subagent edge, never a roster
{
  const res = await call(surface, DIAGNOSTICS_PATH, {})
  const payload = res.json()
  check('diagnostics answers', payload.ok === true && payload.project === PROJECT, res.text)
  check('diagnostics carries the scheduler block', payload.scheduler !== null && typeof payload.scheduler === 'object' && typeof payload.scheduler.ticks === 'number')
  check('the dispatch probe has no roster fields', payload.dispatch !== undefined && payload.dispatch.members === undefined && payload.dispatch.membersReadable === undefined && payload.dispatch.hasAgentTeams === undefined, JSON.stringify(payload.dispatch))
  check('the dispatch probe reports the subagent service', payload.dispatch.available === true && Array.isArray(payload.dispatch.subagentProviders))
}

// ── T-192: the card model is enforced through the SAME route ───────────────
{
  const probe = { probes: [{ id: 'suite', command: 'npm test' }] }
  let res = await post({ action: 'create', title: 'no probes' })
  check('a new dev card without probes is a typed refusal', res.json().ok === false && res.json().code === 'missing-probes', res.text)
  res = await post({ action: 'create', title: 'six files', verification: probe, writeFiles: ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs', 'f.mjs'] })
  check('more than five production files is a typed refusal', res.json().ok === false && res.json().code === 'too-many-files', res.text)
  res = await post({
    action: 'create',
    title: 'generated bundle does not count',
    verification: probe,
    writeFiles: ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs', 'client/client.js', 'scripts/test/extra.test.mjs'],
  })
  const generatedCard = res.json()
  check('the generated bundle and test files are outside the file budget', generatedCard.ok === true, res.text)
  res = await post({ action: 'create', title: 'seven criteria', verification: probe, acceptance: '1 a\n2 b\n3 c\n4 d\n5 e\n6 f\n7 g' })
  check('more than six acceptance criteria is a typed refusal', res.json().ok === false && res.json().code === 'too-many-acceptance', res.text)
  res = await post({ action: 'create', title: 'nine probes', verification: { probes: Array.from({ length: 9 }, (_, index) => ({ id: 'p' + String(index), command: 'npm test' })) } })
  check('more than eight probes is a typed refusal', res.json().ok === false && res.json().code === 'too-many-probes', res.text)
  res = await post({ action: 'create', title: 'an investigation needs no probe', kind: 'investigate' })
  check('an investigation card is exempt from the card model', res.json().ok === true && res.json().task.kind === 'investigate', res.text)
  res = await post({ action: 'update', id: generatedCard.ok === true ? generatedCard.task.id : 'T-1', verification: null })
  check('a dev card cannot be updated back to no probes', res.json().ok === false && res.json().code === 'missing-probes', res.text)
  res = await post({ action: 'update', id: generatedCard.ok === true ? generatedCard.task.id : 'T-1', acceptance: 'a\nb\nc\nd\ne\nf\ng' })
  check('an update cannot grow a card past six criteria', res.json().ok === false && res.json().code === 'too-many-acceptance', res.text)
}

// T-195: host decisions ride the ordinary action route (role user)
{
  const created = await rig.api.decisions.request(
    PROJECT,
    {
      id: 'DEC-1',
      eventKey: 'dispatch',
      taskId: 'T-1',
      eventLabel: '派发批准',
      title: '派发 T-1？',
      body: '任务已就绪，等待批准。',
      options: [
        { id: 'approve', label: '批准派发' },
        { id: 'hold', label: '暂不派发', default: true },
      ],
      defaultOption: 'hold',
      timeoutMs: 300000,
    },
    { by: '@user' },
  )
  check('a decision request persists beside the board', created.ok === true && created.created === true, JSON.stringify(created))
  let res = await post({ action: 'decisionList' })
  let payload = res.json()
  check('the route lists pending decisions', payload.ok === true && Array.isArray(payload.decisions) && payload.decisions.length === 1 && payload.decisions[0].id === 'DEC-1', res.text.substring(0, 400))
  check('the route answer carries the board snapshot for the panel', payload.snapshot !== undefined && Array.isArray(payload.snapshot.tasks))
  res = await post({ action: 'decisionAnswer', decisionId: 'DEC-1', option: 'approve' })
  payload = res.json()
  check('the route answers a decision once', payload.ok === true && payload.decision.status === 'answered' && payload.decision.resolution.option === 'approve', res.text.substring(0, 400))
  res = await post({ action: 'decisionAnswer', decisionId: 'DEC-1', option: 'hold' })
  payload = res.json()
  check('the route refuses a second answer by typed code', payload.ok === false && payload.code === 'already-answered', res.text.substring(0, 400))
}

console.log(failures === 0 ? '\nPASS  task routes (v3 snapshot)' : '\nFAIL  ' + String(failures) + ' route check(s)')
process.exit(failures === 0 ? 0 : 1)
