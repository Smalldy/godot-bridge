// Activation test: the task-center row must wire its tool, routes, timer, event
// listener, runtime skill and always-on rules without a live host. This is the
// seam unit tests skip.

import { register } from 'node:module'
register('./stubs/hooks.mjs', import.meta.url)

const { apply, recordActivationError, reportLoadFailure } = await import('../../plugin/task-center/index.mjs')
const { readFileSync, rmSync } = await import('node:fs')
const { join } = await import('node:path')
const { createFakeFs, createStrictCtx, PROJECT } = await import('./support/fixtures.mjs')
const { SKILL_NAME, buildSkillContent, renderStatusBrief } = await import('../../plugin/task-center/skill.mjs')
const { ACTIONS, AGENT_ACTIONS, READ_ACTIONS, USER_ONLY_ACTIONS } = await import('../../plugin/task-center/api.mjs')

/**
 * The runtime skill body is meant to stay SCANNABLE, so this is a soft size
 * budget, not a byte-exact line: the upper bound catches runaway growth (the
 * body is injected into the model context on every use) without turning a
 * useful sentence into a failure, and the lower bound rejects an empty shell.
 */
const SKILL_BODY_MIN_BYTES = 6000
const SKILL_BODY_MAX_BYTES = 10000

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
const skillRegistrations = []
const skillDisposals = []
const promptSections = []
const requestedServices = []
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
  inject(deps, callback) {
    requestedServices.push(deps.join(','))
    if (deps.indexOf('skills') >= 0) {
      callback({
        skills: {
          register(spec) {
            skillRegistrations.push(spec)
            return function () { skillDisposals.push(String(spec === undefined || spec === null ? '' : spec.name)) }
          },
        },
      })
    }
    if (deps.indexOf('systemPrompt') >= 0) {
      callback({
        systemPrompt: {
          section(spec) {
            promptSections.push(spec)
            return function () {}
          },
        },
      })
    }
  },
  get(key) {
    if (key === 'agents') return { list: () => [] }
    if (key === 'agentTeams') return null
    if (key === 'subagents') return { list: () => ['spawn'] }
    return undefined
  },
}

let activationError = null
// T-104: Cordis-shaped strict context - an undeclared service read throws.
const strictCtx = createStrictCtx(ctx, ['fs', 'sandboxPolicy', 'tools', 'webServer'])
try {
  apply(strictCtx)
} catch (error) {
  activationError = error
}
check('the row activates without a host', activationError === null, activationError && activationError.stack)
check(
  'T-104 a strict Cordis ctx throws on an undeclared service read',
  (() => {
    try {
      void strictCtx.agent
      return false
    } catch (error) {
      return String(error && error.message).indexOf('cannot get property "agent" without inject') >= 0
    }
  })(),
)
check(
  'T-104 a bare undeclared read would fail activation (the guard is real)',
  (() => {
    try {
      (function badApply(badCtx) {
        void badCtx.agent
      })(strictCtx)
      return false
    } catch (error) {
      return String(error && error.message).indexOf('without inject') >= 0
    }
  })(),
)
check('the tool is registered', tools.length === 1 && tools[0].name === 'task_center', String(tools.length))
check('five routes are registered', routes.length === 5, routes.map((route) => route.path).join(','))
check(
  'the routes include state, action, task, list and diagnostics',
  ['/state', '/action', '/task', '/list', '/diagnostics'].every((path) => routes.some((route) => route.path === '/godot-bridge/task-center' + path)),
  routes.map((route) => route.path).join(','),
)
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

// ── the runtime skill: registered from the live action registry ─────────────
{
  const generated = buildSkillContent({
    actions: ACTIONS,
    agentActions: AGENT_ACTIONS,
    readActions: READ_ACTIONS,
    userOnlyActions: USER_ONLY_ACTIONS,
  })
  const registered = skillRegistrations[0] === undefined ? {} : skillRegistrations[0]
  check('the row registers exactly one runtime skill', skillRegistrations.length === 1, String(skillRegistrations.length))
  check('the skill is named ' + SKILL_NAME, registered.name === SKILL_NAME && SKILL_NAME === 'godot-bridge-task-center', String(registered.name))
  check('the skill carries a routing description', typeof registered.description === 'string' && registered.description.length > 10, String(registered.description))
  check('the skill carries a whenToUse hint', typeof registered.whenToUse === 'string' && registered.whenToUse.length > 10, String(registered.whenToUse))
  check('the skill body is not empty', typeof registered.content === 'string' && registered.content.length > 2000, String(registered.content === undefined ? 'undefined' : registered.content.length))
  check(
    'the skill is invocable by the model and by the user',
    registered.invocation !== undefined && registered.invocation !== null && registered.invocation.modelInvocable === true && registered.invocation.userInvocable === true,
    JSON.stringify(registered.invocation),
  )
  // The registry validates `source` only when the skill is LOADED (get() ->
  // validateDefinition), so a registration without it appears in the catalog and
  // then fails with 'loaded skill "<name>" source must be a string'. Assert the
  // load-time shape here so that defect cannot come back.
  check(
    'the registration carries the source string the registry validates on load',
    typeof registered.source === 'string' && registered.source.length > 0,
    String(registered.source),
  )
  check(
    'the registration satisfies the load-time shape (name/description/source/content/invocation)',
    typeof registered.name === 'string' &&
      /^[a-z][a-z0-9-]*$/.test(registered.name) &&
      typeof registered.description === 'string' &&
      registered.description.length > 0 &&
      typeof registered.source === 'string' &&
      registered.source.length > 0 &&
      typeof registered.content === 'string' &&
      registered.content.length > 0 &&
      registered.invocation !== undefined &&
      registered.invocation.modelInvocable === true &&
      registered.invocation.userInvocable === true,
    JSON.stringify({ name: registered.name, source: registered.source, contentLength: registered.content === undefined ? 0 : registered.content.length }),
  )
  check('the registered body is the generated body, not a hand-written copy', registered.content === generated)
  {
    const bytes = Buffer.byteLength(generated, 'utf8')
    check('the body stays inside its scannable size budget', bytes >= SKILL_BODY_MIN_BYTES && bytes <= SKILL_BODY_MAX_BYTES, String(bytes) + ' bytes')
  }
  {
    // T-125: exactly two lines - project and tasks; the blocker rides the task
    // line and is omitted when nothing is blocked.
    const blockStart = generated.indexOf('项目  ')
    const block = blockStart < 0 ? '' : generated.slice(blockStart, generated.indexOf('```', blockStart))
    const lines = block.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    check('T-125 the brief template is exactly two lines', lines.length === 2 && lines[0].indexOf('项目') === 0 && lines[1].indexOf('任务') === 0, JSON.stringify(lines))
    check('T-125 the brief has no identity, team, dispatch, in-flight or next-step line', block.indexOf('身份') < 0 && block.indexOf('你是') < 0 && block.indexOf('团队') < 0 && block.indexOf('派发') < 0 && block.indexOf('在途') < 0 && block.indexOf('下一步') < 0, block)
    check(
      'T-125 the brief never leaks internal field names',
      !/maxConcurrent|allowSpawn|maxAttempts|liveExecutors|\bpending\b|waitingReason|ownerSession/.test(block),
      block,
    )
    const clean = renderStatusBrief({ path: 'J:\\workspace\\component_tool', branch: 'master', head: 'b6d4e5d', pending: 3, running: 0, reviewing: 0, testing: 0, done: 0 })
    const cleanLines = clean.split('\n')
    check(
      'T-125 the rendered brief is exactly two lines and has no blocker suffix when nothing is blocked',
      cleanLines.length === 2 && cleanLines[0] === '项目  J:\\workspace\\component_tool · master @ b6d4e5d' && cleanLines[1] === '任务  3 待办 · 0 进行 · 0 待评审 · 0 待测试 · 0 完成' && clean.indexOf('卡住') < 0,
      clean,
    )
    const blocked = renderStatusBrief({ path: 'J:\\workspace\\component_tool', branch: 'master', head: 'b6d4e5d', pending: 3, running: 0, reviewing: 0, testing: 0, done: 0, blocked: '工作区有 53 个未跟踪文件' })
    const blockedLines = blocked.split('\n')
    check(
      'T-125 the rendered brief folds the blocker into the task line as a suffix',
      blockedLines.length === 2 && blockedLines[1] === '任务  3 待办 · 0 进行 · 0 待评审 · 0 待测试 · 0 完成 · 卡住：工作区有 53 个未跟踪文件',
      blocked,
    )
    check('T-125 the rendered brief uses Chinese counters only', blocked.indexOf('待办') >= 0 && blocked.indexOf('进行') >= 0 && blocked.indexOf('完成') >= 0, blocked)
    const active = renderStatusBrief({ path: 'J:\\ws\\component_tool', branch: 'master', head: 'b6d4e5d', pending: 0, running: 0, reviewing: 3, testing: 1, done: 2 })
    const activeLines = active.split('\n')
    check(
      'T-125 the task line reports review and test counts (active board is not misreported)',
      activeLines.length === 2 && activeLines[1] === '任务  0 待办 · 0 进行 · 3 待评审 · 1 待测试 · 2 完成',
      active,
    )
  }
  check(
    'the body names every agent action',
    AGENT_ACTIONS.every((action) => generated.indexOf('`' + action + '`') >= 0),
    AGENT_ACTIONS.filter((action) => generated.indexOf('`' + action + '`') < 0).join(','),
  )
  {
    const userLine = generated.split('\n').filter((line) => line.indexOf('仅用户') >= 0)[0] || ''
    const tokens = (userLine.match(/`([^`]+)`/g) || []).map((token) => token.slice(1, -1)).filter((token) => token !== 'user-only')
    check('the user-only section lists every user action', USER_ONLY_ACTIONS.every((action) => tokens.indexOf(action) >= 0), tokens.join(','))
    check('the user-only section lists nothing but user actions', tokens.length > 0 && tokens.every((token) => USER_ONLY_ACTIONS.indexOf(token) >= 0), tokens.join(','))
  }
  check(
    'the body defines the Lead role and the entry flow',
    ['你是谁：Lead', '进入流程', 'openProject', '拆卡', '不替 reviewer', '不要**自动', '停下来问'].every((needle) => generated.indexOf(needle) >= 0),
    ['你是谁：Lead', '进入流程', 'openProject', '拆卡', '不替 reviewer', '不要**自动', '停下来问'].filter((needle) => generated.indexOf(needle) < 0).join(','),
  )
  check(
    'the body carries the workflow, the slot/merge/target rules and the corrections',
    ['worker', 'reviewer', 'provision', '候选', 'godot_run_headless', '自动合并', 'queuePosition', 'target-not-advanced', 'ref 真的前进了', '一个 reviewer / tester 槽位'].every(
      (needle) => generated.indexOf(needle) >= 0,
    ),
    ['worker', 'reviewer', 'provision', '候选', 'godot_run_headless', '自动合并', 'queuePosition', 'target-not-advanced', 'ref 真的前进了', '一个 reviewer / tester 槽位'].filter((needle) => generated.indexOf(needle) < 0).join(','),
  )
  check('the outdated "small changes can be committed directly" advice is gone', generated.indexOf('一次性小改动直接改') < 0)
  check('pause is documented as the dispatcher switch, not a single card', generated.indexOf('暂停/恢复**派发器**') >= 0 && generated.indexOf('tick') >= 0 && generated.indexOf('立即跑一轮 settle') >= 0)
  check(
    'the body carries the verdict gates and the refusal codes',
    ['worker-cannot-self-review', 'worker-cannot-self-test', 'merger-only', 'user-only', 'head-drift', 'needs-consent', 'worktree-*', 'test-required'].every(
      (needle) => generated.indexOf(needle) >= 0,
    ),
    ['worker-cannot-self-review', 'worker-cannot-self-test', 'merger-only', 'user-only', 'head-drift', 'needs-consent', 'worktree-*', 'test-required'].filter((needle) => generated.indexOf(needle) < 0).join(','),
  )
  check('the body keeps the guard-exemption prohibition', generated.indexOf('不给自己的提交开守卫豁免') >= 0)
  check('the body keeps the Godot launch rule', generated.indexOf('pwsh') >= 0 && generated.indexOf('sandbox-crash') >= 0)
}

// ── the always-on rules: four lines, namespaced, ordered after the main row ──
{
  const section = promptSections[0] === undefined ? {} : promptSections[0]
  check('the row adds exactly one always-on section', promptSections.length === 1, String(promptSections.length))
  check('the section name is namespaced to this plugin', typeof section.name === 'string' && section.name.indexOf('godot-bridge:') === 0, String(section.name))
  check('the section sits after the main row sections', section.order === 155, String(section.order))
  const text = typeof section.text === 'string' ? section.text : ''
  check(
    'the rules cover the four things an agent must never get wrong',
    ['start', 'needs-consent', 'reviewer', 'tester', 'worktree', 'target', '.agents/tasks.json'].every((needle) => text.indexOf(needle) >= 0),
    text,
  )
  check('the rules point at the skill', text.indexOf(SKILL_NAME) >= 0, text)
  check('the rules stay short', text.length < 900, String(text.length))
}

// ── the tool description is a router, not the manual ────────────────────────
{
  const description = String(tools[0].description === undefined ? '' : tools[0].description)
  check('the tool description sends the model to the skill', description.indexOf(SKILL_NAME) >= 0, description.slice(0, 200))
  check(
    'the tool description still enumerates every agent action',
    AGENT_ACTIONS.every((action) => description.indexOf(action) >= 0),
    AGENT_ACTIONS.filter((action) => description.indexOf(action) < 0).join(','),
  )
  check('the tool description stays short', description.length <= 1400, String(description.length))
  check(
    'the long role/harness/template narrative moved out of the description',
    ['provisions a missing role', 'godot_run_headless', '{{TASK_ID}}', 'per-round brief', 'rolesList'].every((needle) => description.indexOf(needle) < 0),
    ['provisions a missing role', 'godot_run_headless', '{{TASK_ID}}', 'per-round brief', 'rolesList'].filter((needle) => description.indexOf(needle) >= 0).join(','),
  )
  check('the description keeps the start-consent routing', description.indexOf('needs-consent') >= 0 && description.indexOf('panel') >= 0, description.slice(-300))
  check('the description still says dependencies must be merged', description.indexOf('done and merged') >= 0)
}

{
  const { MERGER_NAME, createRoleManager, roleKindOf } = await import('../../plugin/task-center/dispatch.mjs')
  check('the merger is a fixed role name', MERGER_NAME === 'merger', String(MERGER_NAME))
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
check('teardown disposes the skill registration', skillDisposals.length === 1 && skillDisposals[0] === SKILL_NAME, JSON.stringify(skillDisposals))

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
    apply(createStrictCtx(secondCtx, ['fs', 'sandboxPolicy', 'tools', 'webServer']))
  } catch (error) {
    secondError = error
  }
  check('the row activates with a subprocess service present', secondError === null, secondError && secondError.stack)
  check('the tool and routes still wire up', secondTools.length === 1 && secondRoutes.length === 5, String(secondTools.length) + '/' + String(secondRoutes.length))
  check('activation spawns no git process', spawned.length === 0, JSON.stringify(spawned))
}

// ── a host WITHOUT the skills/systemPrompt services still loads the row ──────
{
  const thirdTools = []
  const thirdRoutes = []
  const requested = []
  const thirdCtx = {
    fs: createFakeFs(),
    sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
    logger: { warn() {} },
    tools: {
      register(tool) {
        thirdTools.push(tool)
        return () => {}
      },
    },
    webServer: {
      register(spec) {
        thirdRoutes.push(spec)
        return () => {}
      },
    },
    on() { return () => {} },
    effect(callback) { return callback() },
    // The inject seam exists, but the services do not: the callback receives a
    // context with neither property.
    inject(deps, callback) {
      requested.push(deps.join(','))
      callback({})
    },
    get() { return undefined },
  }
  let thirdError = null
  try {
    apply(createStrictCtx(thirdCtx, ['fs', 'sandboxPolicy', 'tools', 'webServer']))
  } catch (error) {
    thirdError = error
  }
  check('a host without the skills/systemPrompt services still activates', thirdError === null, thirdError && thirdError.stack)
  check('the tool and routes still wire up without the guide services', thirdTools.length === 1 && thirdRoutes.length === 5, String(thirdTools.length) + '/' + String(thirdRoutes.length))
  check(
    'both optional services are requested through inject',
    requested.indexOf('skills') >= 0 && requested.indexOf('systemPrompt') >= 0,
    requested.join('|'),
  )
}

// ── T-104: activation failures are persisted and reported, never silent ──
{
  const logPath = join(process.cwd(), '.tmp-activation-' + String(Date.now()) + '.log')
  const saved = process.env.GODOT_BRIDGE_ACTIVATION_LOG
  process.env.GODOT_BRIDGE_ACTIVATION_LOG = logPath
  const reported = []
  const loggerCtx = { logger: { error(message) { reported.push(String(message)) } } }
  const written = recordActivationError('apply', new Error('simulated activation failure'), loggerCtx)
  reportLoadFailure(new Error('simulated import failure'), loggerCtx)
  let logged = ''
  try {
    logged = readFileSync(logPath, 'utf8')
  } catch (error) {
    logged = ''
  }
  check(
    'T-104 an apply failure is written to the activation log with its stage and error',
    written.path === logPath && logged.indexOf('apply FAILED') >= 0 && logged.indexOf('simulated activation failure') >= 0,
    logged.slice(0, 200),
  )
  check(
    'T-104 a module-load failure is written too (load stage)',
    logged.indexOf('load FAILED') >= 0 && logged.indexOf('simulated import failure') >= 0,
    logged.slice(0, 300),
  )
  check(
    'T-104 the failure is reported through ctx.logger.error as well',
    reported.length === 2 && reported[0].indexOf('apply') >= 0 && reported[1].indexOf('load') >= 0,
    JSON.stringify(reported),
  )
  // The real wrapper: apply(null) cannot activate, so it must throw AND log.
  let threw = false
  try {
    apply(null)
  } catch (error) {
    threw = true
  }
  let wrapped = ''
  try {
    wrapped = readFileSync(logPath, 'utf8')
  } catch (error) {
    wrapped = ''
  }
  check(
    'T-104 a throwing apply is wrapped: it still throws, but only after logging',
    threw && wrapped.indexOf('apply FAILED') >= 0 && wrapped !== logged,
    String(wrapped.length),
  )
  if (saved === undefined) delete process.env.GODOT_BRIDGE_ACTIVATION_LOG
  else process.env.GODOT_BRIDGE_ACTIVATION_LOG = saved
  try {
    rmSync(logPath, { force: true })
  } catch (error) {}
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
