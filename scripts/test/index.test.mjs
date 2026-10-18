// Activation test: the task-center row must wire its tool, routes, timer and
// event listener without a live host. This is the seam unit tests skip.

import { register } from 'node:module'
register('./stubs/hooks.mjs', import.meta.url)

const { apply } = await import('../../plugin/task-center/index.mjs')
const { createFakeFs, PROJECT } = await import('./support/fixtures.mjs')

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

globalThis.setInterval = function () { return 0 }
globalThis.clearInterval = function () {}

const tools = []
const routes = []
const effects = []
const disposers = []
const listeners = []
const ctx = {
  fs: createFakeFs(),
  sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
  logger: { warn() {} },
  tools: {
    register(tool) {
      tools.push(tool)
      return () => { tools.length = 0 }
    },
  },
  webServer: {
    register(spec) {
      routes.push(spec)
      return () => {}
    },
  },
  on(event, handler) {
    listeners.push({ event, handler })
    return () => {}
  },
  effect(callback, label) {
    effects.push(label)
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push({ label, disposer })
    return disposer
  },
  get(key) {
    if (key === 'agents') return { list: () => [] }
    if (key === 'agentTeams') return null
    if (key === 'subagents') return { list: () => ['spawn'] }
    return undefined
  },
}

let activationError = null
try {
  apply(ctx)
} catch (error) {
  activationError = error
}
check('the row activates without a host', activationError === null, activationError && activationError.stack)
check('the tool is registered', tools.length === 1 && tools[0].name === 'task_center', String(tools.length))
check('three routes are registered', routes.length === 3, routes.map((route) => route.path).join(','))
check('the routes include state, action and diagnostics', routes.map((route) => route.path).join(',').indexOf('/state') >= 0 && routes.map((route) => route.path).join(',').indexOf('/action') >= 0)
check('an agent status listener is installed', listeners.some((entry) => entry.event === 'agent/status'))
check('the effects are labelled', effects.some((label) => label.indexOf('task center') >= 0) && effects.some((label) => label.indexOf('task_center') >= 0), effects.join(' | '))
check('a host-driven auto-merge sweep is installed', effects.some((label) => label.indexOf('auto-merge') >= 0), effects.join(' | '))
check('the tool action enum includes start and pause', tools[0].parameters.action.enum.indexOf('start') >= 0 && tools[0].parameters.action.enum.indexOf('pause') >= 0)
check('the tool action enum no longer includes setStatus', tools[0].parameters.action.enum.indexOf('setStatus') < 0)
check(
  'the tool action enum includes the isolated DSH harness',
  ['harnessStart', 'harnessStop', 'harnessRestart', 'harnessStatus', 'harnessSmoke'].every((action) => tools[0].parameters.action.enum.indexOf(action) >= 0),
  tools[0].parameters.action.enum.join(','),
)
check(
  'the tool action enum includes the merge queue',
  tools[0].parameters.action.enum.indexOf('mergeRequest') >= 0 && tools[0].parameters.action.enum.indexOf('rejectMerge') >= 0,
  tools[0].parameters.action.enum.join(','),
)
{
  const { MERGER_NAME, createRoleManager, roleKindOf } = await import('../../plugin/task-center/dispatch.mjs')
  check('the merger is a fixed role name', MERGER_NAME === 'merger', String(MERGER_NAME))
  const description = String(tools[0].description === undefined ? '' : tools[0].description)
  check(
    'the tool description tells agents the merge actions are merger-only',
    description.indexOf('merger') >= 0 && description.indexOf('merger-only') >= 0,
    description.slice(0, 200),
  )
  check(
    'the tool description explains the worker/reviewer/tester profiles',
    description.indexOf('worker/reviewer/tester') >= 0 && description.indexOf('implement/review/test') >= 0,
    description.slice(-700),
  )
  check(
    'the tool description says the host provisions roles, not the Lead',
    description.indexOf('provisions a missing role') >= 0 && description.indexOf('no manual spawn') >= 0,
    description.slice(-700),
  )
  check('the tool description names the project role file', description.indexOf('.agents/roles.json') >= 0, description.slice(-700))
  check(
    'the tool description explains the tester candidate workflow',
    description.indexOf('test candidate') >= 0 && description.indexOf('godot_run_headless') >= 0 && description.indexOf('host merges the accepted candidate') >= 0,
    description.slice(0, 1400),
  )
  check('the tool description no longer claims a host verification gate', description.indexOf('after verification') < 0, description.slice(0, 1400))
  check('the tool description states the hard verdict gates', description.indexOf('worker must never review or test its own task') >= 0, description.slice(-700))
  check('role names map to kinds', roleKindOf('reviewer-1') === 'reviewer' && roleKindOf('tester-12') === 'tester' && roleKindOf('work-T-1-1') === null)
  const noService = createRoleManager({ get: () => undefined })
  const refused = await noService.ensure('reviewer', {})
  check('the role manager refuses readably without agent-team services', refused.ok === false && refused.code === 'no-team-service', JSON.stringify(refused))
}

{
  // The state route is the panel's snapshot: it must expose the runtime views the
  // row wired (agents, worktrees, activity) and degrade without services.
  const { STATE_PATH } = await import('../../plugin/task-center/routes.mjs')
  const stateRoute = routes.filter((route) => route.path === STATE_PATH)[0]
  let payload = null
  const res = {
    writeHead() {},
    end(body) {
      payload = JSON.parse(String(body))
    },
  }
  await stateRoute.handler({ url: STATE_PATH + '?project=' + encodeURIComponent(PROJECT), headers: {} }, res)
  check(
    'the state route exposes agents, worktrees and activity',
    payload !== null && payload.ok === true && payload.agents !== undefined && payload.worktrees !== undefined && payload.activity !== undefined,
    JSON.stringify(payload && Object.keys(payload)),
  )
  check('without a Team the agents view degrades readably', payload.agents.lead === null && payload.agents.members.length === 0, JSON.stringify(payload.agents))
  check('without git the worktree view degrades readably', payload.worktrees.available === false && payload.worktrees.error === 'no-git-service', JSON.stringify(payload.worktrees))
  check(
    'the row wired one activity ring into the snapshot',
    payload.activity.available === true && payload.activity.entries.length === 0 && payload.activity.limit > 0,
    JSON.stringify(payload.activity),
  )
}

let listenerError = null
try {
  listeners.filter((entry) => entry.event === 'agent/status').forEach((entry) => entry.handler())
} catch (error) {
  listenerError = error
}
check('a status event with no project is harmless', listenerError === null, listenerError && listenerError.message)

let teardownError = null
try {
  disposers.slice().reverse().forEach((entry) => entry.disposer())
} catch (error) {
  teardownError = error
}
check('teardown runs without throwing', teardownError === null, teardownError && teardownError.message)

// ── git wiring: required for dispatch, lazy, never a reason to fail activation ─
{
  const { gitFor, probeWorktree } = await import('../../plugin/task-center/dispatch.mjs')
  const { createMerger } = await import('../../plugin/task-center/merge.mjs')
  check('gitFor answers null when the profile has no subprocess service', gitFor({ get: () => undefined }, {}) === null)
  const fake = { isRepo: () => ({ ok: true, repo: true }) }
  check('an injected git facade wins over the service', gitFor({ get: () => undefined }, { git: fake }) === fake)
  const service = { spawn() { throw new Error('unexpected spawn') } }
  check('gitFor builds a facade from the subprocess service', gitFor({ get: (key) => (key === 'subprocess' ? service : undefined) }, {}) !== null)
  const missing = await probeWorktree(null, PROJECT)
  check(
    'probeWorktree reports a profile without git as a worktree problem',
    missing.ok === false && missing.code === 'no-git-service',
    JSON.stringify(missing),
  )
  const noGitMerger = createMerger({ git: null })
  check(
    'the merge queue exposes the tester candidate workflow',
    typeof noGitMerger.createCandidate === 'function' && typeof noGitMerger.mergeCandidate === 'function' && typeof noGitMerger.discardCandidate === 'function',
    Object.keys(noGitMerger).join(','),
  )
  const refusedCandidate = await noGitMerger.createCandidate({ id: 'T-1', branch: 'task/T-1', target: 'main' }, PROJECT, {})
  check('candidate creation refuses readably without git', refusedCandidate.ok === false && refusedCandidate.code === 'no-git-service', JSON.stringify(refusedCandidate))
  const refusedMerge = await noGitMerger.mergeRequest({ id: 'T-1', branch: 'task/T-1', target: 'main' }, PROJECT, {})
  check('the merge queue refuses readably without git', refusedMerge.ok === false && refusedMerge.code === 'no-git-service', JSON.stringify(refusedMerge))
}

// ── a host WITH a subprocess service still activates without spawning git ───
{
  const spawned = []
  const secondTools = []
  const secondRoutes = []
  const subprocess = {
    async resolveExecutable(name) { return name },
    spawn(config) {
      spawned.push(config)
      throw new Error('activation must not spawn git')
    },
  }
  const secondCtx = {
    fs: createFakeFs(),
    sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
    logger: { warn() {} },
    tools: {
      register(tool) {
        secondTools.push(tool)
        return () => {}
      },
    },
    webServer: {
      register(spec) {
        secondRoutes.push(spec)
        return () => {}
      },
    },
    on() { return () => {} },
    effect(callback) { return callback() },
    get(key) {
      if (key === 'agents') return { list: () => [] }
      if (key === 'agentTeams') return null
      if (key === 'subagents') return { list: () => ['spawn'] }
      if (key === 'subprocess') return subprocess
      return undefined
    },
  }
  let secondError = null
  try {
    apply(secondCtx)
  } catch (error) {
    secondError = error
  }
  check('the row activates with a subprocess service present', secondError === null, secondError && secondError.stack)
  check('the tool and routes still wire up', secondTools.length === 1 && secondRoutes.length === 3, String(secondTools.length) + '/' + String(secondRoutes.length))
  check('activation spawns no git process', spawned.length === 0, JSON.stringify(spawned))
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
