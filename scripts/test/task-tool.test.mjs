// Task tool tests: the model-facing binding of the same action API.

import { register } from 'node:module'
register('./stubs/hooks.mjs', import.meta.url)

const { registerTaskTool, agentLabel, projectPathOf } = await import('../../plugin/task-center/tool.mjs')
const { SKILL_NAME, buildSkillContent } = await import('../../plugin/task-center/skill.mjs')
const { ACTIONS, AGENT_ACTIONS, READ_ACTIONS, USER_ONLY_ACTIONS } = await import('../../plugin/task-center/api.mjs')
const { ONBOARD_NEXT_CODES } = await import('../../plugin/task-center/onboard.mjs')
const { createRig, createTask, seedBoard } = await import('./support/fixtures.mjs')
const { rememberMemberProject } = await import('../../plugin/task-center/dispatch.mjs')
const { join } = await import('node:path')

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

const rig = createRig({ allowSpawn: false })
// T-120: an agent session resolves its own team through roster membership.
rig.team.roster.push({ id: 'session-abcdef12', name: 'agent', role: 'teammate', status: 'running' })
// T-127: the agent is working on another project, not merely a non-idle process.
rememberMemberProject(rig.ctx, 'agent', join(rig.project, '..', 'other-project'))
rig.ctx.tools = {
  register(tool) {
    rig.tool = tool
    return tool
  },
}
const disposer = registerTaskTool(rig.ctx, { api: rig.api })
check('the tool registers', rig.tool !== undefined && rig.tool.name === 'task_center', String(rig.tool && rig.tool.name))

const agent = { id: 'session-abcdef12' }
const other = { id: 'session-other' }
async function call(args, who) {
  return rig.tool.execute(args, { agent: who === undefined ? agent : who })
}

// identity helpers
check('agentLabel is stable', agentLabel(agent) === '@abcdef12', agentLabel(agent))
check('an unnamed agent still has a label', agentLabel(undefined) === '@unknown')
check('projectPathOf resolves the workspace', projectPathOf(rig.ctx, agent) === rig.project, projectPathOf(rig.ctx, agent))

// the action vocabulary is the API's, not a hand-maintained second list
const actions = rig.tool.parameters.action.enum
check('the tool exposes onboard (T-129)', actions.indexOf('onboard') >= 0, actions.join(','))
check('the tool exposes start and pause', actions.indexOf('start') >= 0 && actions.indexOf('pause') >= 0, actions.join(','))
check('the tool exposes create and submit', actions.indexOf('create') >= 0 && actions.indexOf('submit') >= 0)
check(
  'the tool exposes the merge queue and its refresh',
  actions.indexOf('mergeRequest') >= 0 && actions.indexOf('rejectMerge') >= 0 && actions.indexOf('refreshMerge') >= 0,
  actions.join(','),
)
{
  const description = String(rig.tool.description === undefined ? '' : rig.tool.description)
  check('the tool description routes the model to the skill first', description.indexOf(SKILL_NAME) >= 0, description.slice(0, 240))
  check(
    'the tool description still enumerates every agent action',
    AGENT_ACTIONS.every((action) => description.indexOf(action) >= 0),
    AGENT_ACTIONS.filter((action) => description.indexOf(action) < 0).join(','),
  )
  check('the tool description is a router, not the manual', description.length <= 1400, String(description.length))
  check(
    'the role/harness/template prose left the description',
    ['provisions a missing role', 'godot_run_headless', '{{TASK_ID}}', 'per-round brief', 'skillsCatalog', 'merger-only'].every((needle) => description.indexOf(needle) < 0),
    ['provisions a missing role', 'godot_run_headless', '{{TASK_ID}}', 'per-round brief', 'skillsCatalog', 'merger-only'].filter((needle) => description.indexOf(needle) >= 0).join(','),
  )
  check('the tool says dependencies must be merged, not just done', description.indexOf('done and merged') >= 0, description.slice(0, 300))
  check('the tool routes the FIRST move to onboard (T-129)', description.indexOf('Start with action onboard') >= 0 && description.indexOf('one next step') >= 0, description.slice(0, 320))
  check('the tool description keeps the start-consent routing', description.indexOf('needs-consent') >= 0 && description.indexOf('panel') >= 0, description.slice(-260))
  check('requestChanges carries explicit reasons', rig.tool.parameters.reasons !== undefined, JSON.stringify(rig.tool.parameters.reasons))
  check('the tool no longer describes a host verification gate', description.indexOf('after verification') < 0, description.slice(0, 1400))
  check('the enum is the registry, not a second list', actions.join(',') === AGENT_ACTIONS.join(','), actions.join(','))
}

// ── the skill body is generated from the same registry ─────────────────────
{
  const content = buildSkillContent({ actions: ACTIONS, agentActions: AGENT_ACTIONS, readActions: READ_ACTIONS, userOnlyActions: USER_ONLY_ACTIONS })
  check(
    'the skill body names every agent action',
    AGENT_ACTIONS.every((action) => content.indexOf('`' + action + '`') >= 0),
    AGENT_ACTIONS.filter((action) => content.indexOf('`' + action + '`') < 0).join(','),
  )
  check(
    'the skill body carries every read action',
    READ_ACTIONS.filter((action) => USER_ONLY_ACTIONS.indexOf(action) < 0).every((action) => content.indexOf('`' + action + '`') >= 0),
    READ_ACTIONS.filter((action) => content.indexOf('`' + action + '`') < 0).join(','),
  )
  {
    const userLine = content.split('\n').filter((line) => line.indexOf('仅用户') >= 0)[0] || ''
    const tokens = (userLine.match(/`([^`]+)`/g) || []).map((token) => token.slice(1, -1)).filter((token) => token !== 'user-only')
    check('the skill user-only section lists every user action', USER_ONLY_ACTIONS.every((action) => tokens.indexOf(action) >= 0), tokens.join(','))
    check('the skill user-only section lists nothing but user actions', tokens.length > 0 && tokens.every((token) => USER_ONLY_ACTIONS.indexOf(token) >= 0), tokens.join(','))
  }
  check(
    'the skill body carries the narrative the description gave up',
    ['候选', 'godot_run_headless', 'merger-only', 'head-drift', 'queuePosition', 'target-not-advanced', 'ref 真的前进了'].every((needle) => content.indexOf(needle) >= 0),
    ['候选', 'godot_run_headless', 'merger-only', 'head-drift', 'queuePosition', 'target-not-advanced', 'ref 真的前进了'].filter((needle) => content.indexOf(needle) < 0).join(','),
  )
  check('the description no longer duplicates the manual', String(rig.tool.description).indexOf('候选 worktree') < 0)
}
check('the old setStatus vocabulary is gone', actions.indexOf('setStatus') < 0, actions.join(','))
check(
  'the tool no longer exposes the manual lock actions, but keeps the read-only locks diagnostic',
  ['lock', 'unlock', 'forceUnlock'].every((action) => actions.indexOf(action) < 0) && actions.indexOf('locks') >= 0,
  actions.join(','),
)
check(
  'user-only role administration is hidden from the tool',
  ['rolesList', 'rolesCreate', 'rolesUpdate', 'rolesDelete', 'rolesBind', 'rolesDrain', 'rolesReplace', 'rolesReset', 'skillsCatalog'].every((action) => actions.indexOf(action) < 0),
  actions.join(','),
)
{
  const content = buildSkillContent({ actions: ACTIONS, agentActions: AGENT_ACTIONS, readActions: READ_ACTIONS, userOnlyActions: USER_ONLY_ACTIONS })
  check(
    'the skill defines the Lead role and the onboard entrance (T-129)',
    content.indexOf('你是谁：Lead') >= 0 && content.indexOf('接入（onboard）') >= 0 && content.indexOf('onboard') >= 0 && content.indexOf('停下来问') >= 0,
    content.slice(0, 400),
  )
  check('the old 进入流程 entrance is gone from the skill', content.indexOf('进入流程') < 0, content.slice(content.indexOf('接入'), content.indexOf('接入') + 80))
  check(
    'the skill table covers every onboarding next code (T-129)',
    ONBOARD_NEXT_CODES.every((code) => content.indexOf('`' + code + '`') >= 0),
    ONBOARD_NEXT_CODES.filter((code) => content.indexOf('`' + code + '`') < 0).join(','),
  )
  check('the skill forbids guard exemptions', content.indexOf('不给自己的提交开守卫豁免') >= 0, content.slice(-600))
  check('the skill keeps user-only panel actions hidden from the tool', content.indexOf('工具不暴露') >= 0, content.slice(-600))
}
check(
  'the tool exposes the isolated DSH harness',
  ['harnessStart', 'harnessStop', 'harnessRestart', 'harnessStatus', 'harnessSmoke'].every((action) => actions.indexOf(action) >= 0),
  actions.join(','),
)
check('user-owned approval and settings are hidden from the tool', actions.indexOf('approveStart') < 0 && actions.indexOf('rejectStart') < 0 && actions.indexOf('settings') < 0, actions.join(','))
check('the removed review actions are gone', actions.indexOf('accept') < 0 && actions.indexOf('reject') < 0, actions.join(','))

// create + board
{
  const result = await call({ action: 'create', title: 'from the model', dependsOn: [], writeFiles: ['scripts/a.gd'] })
  check('the tool creates a task', result.ok === true && result.task.title === 'from the model', JSON.stringify(result))
  check('a created task is pending', result.task.status === 'pending')
  const board = await call({ action: 'board' })
  check('the tool reads the board', board.ok === true && board.tasks.length === 1 && board.counts.pending === 1, JSON.stringify(board.counts))
  const bad = await call({ action: 'create', title: 'bad dependency', dependsOn: ['T-99'] })
  check('a refused create is a readable error', bad.error !== undefined && bad.code === 'unknown-dependency', JSON.stringify(bad))
}

// ── T-129: one-call onboarding through the tool ─────────────────────────────
{
  const onboarded = await call({ action: 'onboard' })
  check(
    'the tool onboards in one call (brief + one next step)',
    onboarded.ok === true &&
      onboarded.onboard !== undefined &&
      typeof onboarded.onboard.brief === 'string' &&
      onboarded.onboard.brief.indexOf('下一步') >= 0 &&
      typeof onboarded.onboard.next.code === 'string',
    JSON.stringify(onboarded).slice(0, 400),
  )
  check(
    'the tool onboarding answer carries no board tasks or previews',
    onboarded.tasks === undefined && onboarded.rolePreviews === undefined && onboarded.worktrees === undefined,
    Object.keys(onboarded).join(','),
  )
}

// start / dispatch / submit ownership
{
  const created = await call({ action: 'create', title: 'pool work', priority: 99 })
  const id = created.task.id
  const requested = await call({ action: 'start' })
  check('an agent start is a request, not a start', requested.error !== undefined && requested.code === 'needs-consent' && requested.request !== null, JSON.stringify(requested))
  let board = await call({ action: 'board' })
  check('the request leaves dispatch paused', board.dispatch.state === 'paused', JSON.stringify(board.dispatch))
  const cancelled = await call({ action: 'cancelStartRequest' })
  check('the agent can withdraw its request', cancelled.ok === true && cancelled.dispatch.request === null, JSON.stringify(cancelled))
  await rig.api.perform('start', {}, rig.user)
  board = await call({ action: 'board' })
  const task = board.tasks.filter((entry) => entry.id === id)[0]
  check('the user start dispatches the task', task.status === 'running' && task.assignee.name === 'fixer', JSON.stringify(task && task.assignee))
  const wrong = await call({ action: 'submit', id: id, evidence: 'mine' }, other)
  check('a different agent cannot submit it', wrong.error !== undefined && wrong.code === 'not-assignee', JSON.stringify(wrong))
  const submitted = await call({ action: 'submit', id: id, evidence: 'tests pass' }, { id: 'session-idle' })
  check('the assignee can submit it', submitted.ok === true && submitted.task.status === 'reviewing', JSON.stringify(submitted))
  check('the submission opens the first review round', submitted.task.review !== null && submitted.task.review.status === 'pending' && submitted.task.review.attempt === 1, JSON.stringify(submitted.task.review))
  check('and the evidence is stored', submitted.task.evidence === 'tests pass')
  const paused = await call({ action: 'pause' })
  check('the tool pauses dispatch', paused.dispatch.state === 'paused')
}

// automatic locks only: dispatch locks writeFiles, submit releases them, the
// manual lock/unlock/forceUnlock actions are refusals now.
{
  const created = await call({ action: 'create', title: 'auto locked work', writeFiles: ['scripts/auto.gd'] })
  const id = created.task.id
  rig.team.setStatus('fixer', 'inactive')
  await rig.api.perform('start', {}, rig.user)
  const board = await call({ action: 'board' })
  const runningTask = board.tasks.filter((task) => task.status === 'running')[0]
  const listed = await call({ action: 'locks' })
  check(
    'dispatch locks the running task files automatically',
    listed.ok === true && runningTask !== undefined && listed.locks.some((lock) => lock.taskId === runningTask.id && runningTask.writeFiles.indexOf(lock.path) >= 0),
    JSON.stringify({ locks: listed.locks, running: runningTask && runningTask.id }),
  )
  const manualLock = await call({ action: 'lock', paths: ['scripts/extra.gd'] }, { id: 'session-idle' })
  check('the lock action is a readable unknown-action refusal', manualLock.error !== undefined && manualLock.code === 'unknown-action', JSON.stringify(manualLock))
  const unlock = await call({ action: 'unlock', paths: ['scripts/extra.gd'] }, { id: 'session-idle' })
  check('the unlock action is refused too', unlock.error !== undefined && unlock.code === 'unknown-action', JSON.stringify(unlock))
  const forced = await call({ action: 'forceUnlock', paths: ['scripts/extra.gd'] }, rig.user)
  check('forceUnlock is refused for the user as well', forced.error !== undefined && forced.code === 'unknown-action', JSON.stringify(forced))
  await call({ action: 'submit', id: runningTask.id, evidence: 'done' }, { id: 'session-idle' })
  const released = await call({ action: 'locks' })
  check('submit released the automatic lock of that task', released.locks.every((lock) => lock.taskId !== runningTask.id), JSON.stringify(released.locks))
  await call({ action: 'pause' })
  void id
}

// read-only actions may run concurrently
check('board is concurrency safe', rig.tool.isConcurrencySafe({ action: 'board' }) === true)
check('create is not concurrency safe', rig.tool.isConcurrencySafe({ action: 'create' }) === false)

// ── the merger role at the tool boundary ───────────────────────────────────
{
  const mergeRig = createRig({
    allowSpawn: false,
    teamOptions: {
      roster: [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-merger', name: 'merger', role: 'teammate', status: 'inactive' },
        { id: 'session-fixer', name: 'fixer', role: 'teammate', status: 'inactive' },
      ],
    },
  })
  mergeRig.ctx.tools = {
    register(tool) {
      mergeRig.tool = tool
      return tool
    },
  }
  registerTaskTool(mergeRig.ctx, { api: mergeRig.api })
  const toolCall = (args, who) => mergeRig.tool.execute(args, { agent: who === undefined ? { id: 'session-lead' } : who })
  const created = await toolCall({ action: 'create', title: 'tool MR' })
  const id = created.task.id
  await mergeRig.action('start')
  await mergeRig.settle()
  const submitted = await toolCall({ action: 'submit', id: id, evidence: 'done' }, { id: 'session-fixer' })
  check(
    'the assignee submits into an open merge request',
    submitted.ok === true && submitted.task.merge !== null && submitted.task.merge.status === 'open',
    JSON.stringify(submitted),
  )
  const sends = mergeRig.team.calls.filter((call) => call.kind === 'send')
  check('the submit notified the merger', sends.some((call) => call.target === 'merger' && call.text.indexOf(id) >= 0), JSON.stringify(sends))
  const other = await toolCall({ action: 'mergeRequest', id: id }, { id: 'session-fixer' })
  check('another agent cannot merge from the tool', other.error !== undefined && other.code === 'merger-only', JSON.stringify(other))
  const otherReject = await toolCall({ action: 'rejectMerge', id: id }, { id: 'session-fixer' })
  check('and cannot reject either', otherReject.error !== undefined && otherReject.code === 'merger-only', JSON.stringify(otherReject))
  const merger = await toolCall({ action: 'mergeRequest', id: id }, { id: 'session-merger' })
  check('the merger passes the gate', merger.code !== 'merger-only', JSON.stringify(merger))
  check('and reaches the merge queue', merger.error !== undefined && merger.code === 'no-merge-service', JSON.stringify(merger))
  const refreshed = await toolCall({ action: 'refreshMerge', id: id }, { id: 'session-fixer' })
  check(
    'the owner can refresh the merge request from the tool',
    refreshed.ok === true &&
      refreshed.task.merge.status === 'open' &&
      refreshed.task.merge.head === 'base-sha' &&
      refreshed.task.merge.base === 'base-sha' &&
      refreshed.task.commit === 'base-sha',
    JSON.stringify(refreshed),
  )
  const strangerRefresh = await toolCall({ action: 'refreshMerge', id: id }, { id: 'session-other' })
  check('another agent cannot refresh it', strangerRefresh.error !== undefined && strangerRefresh.code === 'not-assignee', JSON.stringify(strangerRefresh))
  check('a refresh starts a new review round', refreshed.task.status === 'reviewing' && refreshed.task.review.attempt === 2, JSON.stringify(refreshed.task.review))
  const approved = await toolCall({ action: 'approveReview', id: id }, { id: 'session-fixer' })
  check(
    'the tool approves a review into testing',
    approved.ok === true && approved.task.status === 'testing' && approved.task.review.status === 'approved',
    JSON.stringify(approved),
  )
  const passed = await toolCall({ action: 'passTest', id: id }, { id: 'session-merger' })
  check(
    'the tool passes the test phase',
    passed.ok === true && passed.task.status === 'testing' && passed.task.test.status === 'passed',
    JSON.stringify(passed),
  )
  const refusedMerge = await toolCall({ action: 'mergeRequest', id: id }, { id: 'session-merger' })
  check('a passed test still needs the merge queue', refusedMerge.error !== undefined && refusedMerge.code === 'no-merge-service', JSON.stringify(refusedMerge))
  mergeRig.scheduler.dispose()
}

// ── the host mechanical verification is declarable through the tool ─────────
{
  const declared = rig.tool.parameters.verify
  check(
    'the tool exposes the verify parameter',
    declared !== undefined && Array.isArray(declared.oneOf) && declared.oneOf.length === 2,
    JSON.stringify(declared === undefined ? 'missing' : Object.keys(declared)),
  )
  const objectBranch = declared === undefined ? undefined : declared.oneOf.filter((branch) => branch.type === 'object')[0]
  check(
    'the verify parameter names a command and an optional timeout',
    objectBranch !== undefined && objectBranch.properties.command.type === 'string' && objectBranch.properties.timeoutMs.type === 'number',
    JSON.stringify(objectBranch === undefined ? 'missing object branch' : Object.keys(objectBranch.properties)),
  )
  check(
    'the verify parameter can be cleared with null',
    declared !== undefined && declared.oneOf.some((branch) => branch.type === 'null'),
    JSON.stringify(declared === undefined ? 'missing' : declared.oneOf.map((branch) => branch.type)),
  )
  check(
    'the verify description says the HOST runs the command',
    String(declared === undefined ? '' : declared.description).indexOf('HOST executes the command') >= 0,
    String(declared === undefined ? '' : declared.description).slice(0, 200),
  )
}

{
  const created = await call({ action: 'create', title: 'verify card', verify: { command: 'npm run verify && npm run e2e', timeoutMs: 120000 } })
  check(
    'create carries the verify declaration through the tool',
    created.ok === true &&
      created.task.verify !== null &&
      created.task.verify.command === 'npm run verify && npm run e2e' &&
      created.task.verify.timeoutMs === 120000,
    JSON.stringify(created),
  )
  const cleared = await call({ action: 'update', id: created.task.id, verify: null })
  check('update clears the verify declaration through the tool', cleared.ok === true && cleared.task.verify === null, JSON.stringify(cleared))
}


// ── T-131: investigation cards through the tool ────────────────────────────
{
  // The fixture starts with the agent remembered on another project; this block
  // works on the rig's project, so move the memory first (submit/report check it).
  rememberMemberProject(rig.ctx, 'agent', rig.project)
  const card = await call({ action: 'create', title: 'Why is the loader slow?', kind: 'investigate' })
  check('T-131 the tool creates an investigation', card.ok === true && card.task.kind === 'investigate', JSON.stringify(card.ok === true ? card.task.kind : card.code))
  const plain = await call({ action: 'create', title: 'Plain dev card' })
  check('T-131 create defaults to dev', plain.ok === true && plain.task.kind === 'dev', JSON.stringify(plain.ok === true ? plain.task.kind : plain.code))
  const changed = await call({ action: 'update', id: card.task.id, kind: 'dev' })
  check('T-131 the tool refuses a kind change', changed.ok !== true && changed.code === 'kind-immutable', JSON.stringify(changed.code))
  const submitted = await call({ action: 'submit', id: card.task.id, evidence: 'x' })
  check('T-131 the tool routes submit on an investigation to its refusal', submitted.ok !== true && submitted.code === 'investigation-report-only', JSON.stringify(submitted.code))
  check(
    'T-131 the tool exposes report and the kind parameter',
    rig.tool.parameters.report !== undefined || actions.indexOf('report') >= 0,
    actions.join(','),
  )
  const kindParam = rig.tool.parameters.kind
  check(
    'T-131 the kind parameter is an enum of dev/investigate',
    kindParam !== undefined && Array.isArray(kindParam.enum) && kindParam.enum.join(',') === 'dev,investigate',
    JSON.stringify(kindParam === undefined ? null : kindParam.enum),
  )
  check('T-131 report carries summary and body parameters', rig.tool.parameters.summary !== undefined && rig.tool.parameters.body !== undefined)
  const evidenceParam = rig.tool.parameters.evidence
  check(
    'T-131 evidence accepts report rows as well as submit text',
    evidenceParam !== undefined && Array.isArray(evidenceParam.oneOf) && evidenceParam.oneOf.some((branch) => branch.type === 'array') && evidenceParam.oneOf.some((branch) => branch.type === 'string'),
    JSON.stringify(evidenceParam === undefined ? null : evidenceParam.oneOf.map((branch) => branch.type)),
  )
  const description = String(rig.tool.description === undefined ? '' : rig.tool.description)
  check('T-131 the description names investigations and report', description.indexOf('investigate') >= 0 && description.indexOf('report') >= 0, description.slice(-300))
}

// ── T-131: a running investigation reports through the tool ────────────────
{
  seedBoard(
    rig.fs,
    rig.project,
    JSON.stringify({
      version: 2,
      seq: 12,
      tasks: [
        {
          id: 'T-11',
          title: 'Seeded investigation',
          status: 'running',
          kind: 'investigate',
          attempts: 1,
          assignee: { name: 'agent', session: 'session-abcdef12' },
          base: 'base-sha',
          target: null,
          worktree: null,
          history: [{ at: '2026-01-01T00:00:00.000Z', by: 'scheduler', from: 'pending', to: 'running', note: 'dispatched' }],
        },
      ],
    }),
  )
  const reported = await call({
    action: 'report',
    id: 'T-11',
    summary: 'The loader waits on the config read.',
    body: 'Full findings.',
    evidence: [{ command: 'node loader.mjs', exitCode: 0, outputTail: '1200ms' }],
  })
  check('T-131 the tool reports and completes the card', reported.ok === true && reported.task.status === 'done', JSON.stringify(reported.ok === true ? reported.task.status : reported.code))
  check(
    'T-131 the report keeps summary, body and evidence',
    reported.report !== null && reported.report.summary === 'The loader waits on the config read.' && reported.report.body === 'Full findings.' && reported.report.evidence.length === 1,
    JSON.stringify(reported.report),
  )
  const get = await call({ action: 'get', id: 'T-11' })
  check('T-131 get returns the full report', get.ok === true && get.task.report !== null && get.task.report.summary === 'The loader waits on the config read.')
  const listed = await call({ action: 'list' })
  const summaryRow = (listed.tasks === undefined ? [] : listed.tasks).filter((task) => task.id === 'T-11')[0]
  check(
    'T-131 list carries kind and the report headline',
    summaryRow !== undefined && summaryRow.kind === 'investigate' && summaryRow.reportSummary !== null && summaryRow.reportSummary.summary === 'The loader waits on the config read.',
    JSON.stringify(summaryRow),
  )
}

if (typeof disposer === 'function') disposer()
rig.scheduler.dispose()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)