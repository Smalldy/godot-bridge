// Task tool tests: the model-facing binding of the same action API.

import { register } from 'node:module'
register('./stubs/hooks.mjs', import.meta.url)

const { registerTaskTool, agentLabel, projectPathOf, lossless } = await import('../../plugin/task-center/tool.mjs')
const { SKILL_NAME, buildSkillContent } = await import('../../plugin/task-center/skill.mjs')
const { ACTIONS, AGENT_ACTIONS, READ_ACTIONS, USER_ONLY_ACTIONS } = await import('../../plugin/task-center/api.mjs')
const { ONBOARD_NEXT_CODES } = await import('../../plugin/task-center/onboard.mjs')
const { createRig, createTask, createFakeTaskAgents, seedBoard } = await import('./support/fixtures.mjs')

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

const rig = createRig({ allowSpawn: false, taskAgents: createFakeTaskAgents() })
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
// T-192: every NEW dev card declares an executable probe; these tool tests are
// about the tool surface, so they state one shared probe.
const PROBES = { probes: [{ id: 'suite', command: 'npm test' }] }
async function call(args, who) {
  return rig.tool.execute(args, { agent: who === undefined ? agent : who })
}
function callOn(rigRef, args, who) {
  return rigRef.tool.execute(args, { agent: who === undefined ? agent : who })
}
/** T-196: the panel (role user) answers a pending decision. */
async function answerAsPanel(rigRef, decision, option, extra) {
  return rigRef.action('decisionAnswer', Object.assign({ decisionId: decision.id, option: option }, extra === undefined ? {} : extra))
}
/**
 * T-196: an Agent create asks the human first, so a test that wants a card
 * answers the question through the same panel path the user takes and then
 * reads the created card back.
 */
async function createThroughDecision(rigRef, args, who) {
  const first = await callOn(rigRef, Object.assign({ action: 'create' }, args), who)
  if (first.ok === true) return first
  if (first.code !== 'needs-decision' || first.decision === null || first.decision === undefined) return first
  const answered = await answerAsPanel(rigRef, first.decision, 'create')
  const taskId = answered.ok === true && answered.applied !== null && answered.applied.summary !== null ? answered.applied.summary.taskId : null
  if (taskId === null || taskId === undefined) return { ok: false, code: answered.ok === true ? 'apply-failed' : answered.code, answer: answered }
  return await callOn(rigRef, { action: 'get', id: taskId }, who)
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
  check(
    'the structured verdict parameters are exposed',
    rig.tool.parameters.checked !== undefined && rig.tool.parameters.findings !== undefined && rig.tool.parameters.residualRisks !== undefined && rig.tool.parameters.probes !== undefined,
    JSON.stringify(Object.keys(rig.tool.parameters)),
  )
  check('the free-text reasons parameter is gone', rig.tool.parameters.reasons === undefined)
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
    ['候选', 'godot_run_headless', 'user-only', 'head-drift', 'queuePosition', 'target-not-advanced', 'ref 真的前进了'].every((needle) => content.indexOf(needle) >= 0),
    ['候选', 'godot_run_headless', 'user-only', 'head-drift', 'queuePosition', 'target-not-advanced', 'ref 真的前进了'].filter((needle) => content.indexOf(needle) < 0).join(','),
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
  ['rolesList', 'rolesCreate', 'rolesUpdate', 'rolesDelete', 'rolesBind', 'rolesReset', 'skillsCatalog'].every((action) => actions.indexOf(action) < 0),
  actions.join(','),
)
{
  const content = buildSkillContent({ actions: ACTIONS, agentActions: AGENT_ACTIONS, readActions: READ_ACTIONS, userOnlyActions: USER_ONLY_ACTIONS })
  check(
    'the skill defines the Lead role and the onboard entrance (T-129)',
    content.indexOf('你是谁：根 Agent') >= 0 && content.indexOf('接入（onboard）') >= 0 && content.indexOf('onboard') >= 0 && content.indexOf('停下来问') >= 0,
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
  const result = await createThroughDecision(rig, { title: 'from the model', dependsOn: [], writeFiles: ['scripts/a.gd'], verification: PROBES })
  check('the tool creates a task', result.ok === true && result.task.title === 'from the model', JSON.stringify(result))
  check('a created task is pending', result.task.status === 'pending')
  const board = await call({ action: 'board' })
  check('the tool reads the board', board.ok === true && board.tasks.length === 1 && board.counts.pending === 1, JSON.stringify(board.counts))
  const bad = await call({ action: 'create', title: 'bad dependency', dependsOn: ['T-99'], verification: PROBES })
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
  const created = await createThroughDecision(rig, { title: 'pool work', priority: 99, verification: PROBES })
  const id = created.task.id
  const requested = await call({ action: 'start' })
  check(
    'an agent start is a request, not a start',
    requested.error !== undefined && requested.code === 'needs-consent' && requested.request !== null && requested.decision !== null && requested.decision.eventKey === 'dispatch',
    JSON.stringify(requested),
  )
  let board = await call({ action: 'board' })
  check('the request leaves dispatch paused', board.dispatch.state === 'paused', JSON.stringify(board.dispatch))
  const held = await answerAsPanel(rig, requested.decision, 'hold')
  check('暂不派发 keeps dispatch paused and dispatches nothing', held.ok === true && held.applied.executed === false && held.applied.code === null, JSON.stringify(held.applied))
  const withdrawn = await call({ action: 'cancelStartRequest' })
  check('the agent can still withdraw a legacy start request', withdrawn.ok === true && withdrawn.dispatch.request === null, JSON.stringify(withdrawn))
  const again = await call({ action: 'start' })
  check('a second agent start asks again', again.code === 'needs-consent' && again.decision !== null && again.decision.id !== requested.decision.id, JSON.stringify({ code: again.code, id: again.decision && again.decision.id }))
  const approved = await answerAsPanel(rig, again.decision, 'approve')
  check('批准派发 starts dispatch', approved.ok === true && approved.applied.summary.dispatch === 'running', JSON.stringify(approved.applied))
  board = await call({ action: 'board' })
  const task = board.tasks.filter((entry) => entry.id === id)[0]
  check('the approved start dispatches the task', task.status === 'running' && task.assignee !== null && typeof task.assignee.session === 'string', JSON.stringify(task && task.assignee))
  const wrong = await call({ action: 'submit', id: id, evidence: 'mine' }, other)
  check('a different agent cannot submit it', wrong.error !== undefined && wrong.code === 'not-assignee', JSON.stringify(wrong))
  const submitted = await call({ action: 'submit', id: id, evidence: 'tests pass' }, { id: task.assignee.session })
  check('the assignee can submit it', submitted.ok === true && submitted.task.status === 'reviewing', JSON.stringify(submitted))
  check('the submission opens the first review round', submitted.task.review !== null && submitted.task.review.status === 'pending' && submitted.task.review.attempt === 1, JSON.stringify(submitted.task.review))
  check('and the evidence is stored', submitted.task.evidence === 'tests pass')
  const paused = await call({ action: 'pause' })
  check('the tool pauses dispatch', paused.dispatch.state === 'paused')
}

// automatic locks only: dispatch locks writeFiles, submit releases them, the
// manual lock/unlock/forceUnlock actions are refusals now.
{
  const created = await createThroughDecision(rig, { title: 'auto locked work', writeFiles: ['scripts/auto.gd'], verification: PROBES })
  const id = created.task.id
  await rig.api.perform('start', {}, rig.user)
  const board = await call({ action: 'board' })
  const runningTask = board.tasks.filter((task) => task.status === 'running')[0]
  // T-231: the board is a summary page — the declared files are detail-class, so
  // the one card this check needs is fetched through get (the detail read).
  const runningDetail = await call({ action: 'get', id: runningTask === undefined ? '' : runningTask.id })
  const declaredFiles = runningDetail.ok === true && Array.isArray(runningDetail.task.writeFiles) ? runningDetail.task.writeFiles : []
  check(
    'T-231 a board card carries the file COUNT, not the declared list',
    runningTask !== undefined && runningTask.writeFileCount === 1 && runningTask.writeFiles === undefined,
    JSON.stringify(runningTask),
  )
  const listed = await call({ action: 'locks' })
  check(
    'dispatch locks the running task files automatically',
    listed.ok === true && runningTask !== undefined && listed.locks.some((lock) => lock.taskId === runningTask.id && declaredFiles.indexOf(lock.path) >= 0),
    JSON.stringify({ locks: listed.locks, running: runningTask && runningTask.id, declared: declaredFiles }),
  )
  const manualLock = await call({ action: 'lock', paths: ['scripts/extra.gd'] }, { id: 'session-idle' })
  check('the lock action is a readable unknown-action refusal', manualLock.error !== undefined && manualLock.code === 'unknown-action', JSON.stringify(manualLock))
  const unlock = await call({ action: 'unlock', paths: ['scripts/extra.gd'] }, { id: 'session-idle' })
  check('the unlock action is refused too', unlock.error !== undefined && unlock.code === 'unknown-action', JSON.stringify(unlock))
  const forced = await call({ action: 'forceUnlock', paths: ['scripts/extra.gd'] }, rig.user)
  check('forceUnlock is refused for the user as well', forced.error !== undefined && forced.code === 'unknown-action', JSON.stringify(forced))
  await call({ action: 'submit', id: runningTask.id, evidence: 'done' }, { id: runningTask.assignee.session })
  const released = await call({ action: 'locks' })
  check('submit released the automatic lock of that task', released.locks.every((lock) => lock.taskId !== runningTask.id), JSON.stringify(released.locks))
  await call({ action: 'pause' })
  void id
}

// read-only actions may run concurrently
check('board is concurrency safe', rig.tool.isConcurrencySafe({ action: 'board' }) === true)
check('create is not concurrency safe', rig.tool.isConcurrencySafe({ action: 'create' }) === false)

// ── the merge/verdict boundaries at the tool level (v3) ─────────────────────
{
  const mergeRig = createRig({ allowSpawn: false, taskAgents: createFakeTaskAgents() })
  mergeRig.ctx.tools = {
    register(tool) {
      mergeRig.tool = tool
      return tool
    },
  }
  registerTaskTool(mergeRig.ctx, { api: mergeRig.api })
  const toolCall = (args, who) => mergeRig.tool.execute(args, { agent: who === undefined ? { id: 'session-lead' } : who })
  const created = await createThroughDecision(mergeRig, { title: 'tool MR', verification: PROBES })
  const id = created.task.id
  await mergeRig.action('start')
  const board = await mergeRig.action('board')
  const runningTask = board.tasks.filter((task) => task.id === id)[0]
  check('the worker child is the card assignee', runningTask.status === 'running' && runningTask.assignee !== null && typeof runningTask.assignee.session === 'string', JSON.stringify(runningTask))
  const worker = { id: runningTask.assignee.session }
  const submitted = await toolCall({ action: 'submit', id: id, evidence: 'done' }, worker)
  check(
    'the assignee submits into an open merge request',
    submitted.ok === true && submitted.task.merge !== null && submitted.task.merge.status === 'open',
    JSON.stringify(submitted),
  )
  const reviewTask = (await mergeRig.action('board')).tasks.filter((task) => task.id === id)[0]
  check('submit started a reviewer child and recorded it', reviewTask.review !== null && reviewTask.review.deliveredTo !== null && typeof reviewTask.review.deliveredTo.id === 'string', JSON.stringify(reviewTask.review))
  const other = await toolCall({ action: 'mergeRequest', id: id }, { id: 'session-fixer' })
  check('an agent cannot merge from the tool (user-only)', other.error !== undefined && other.code === 'user-only', JSON.stringify(other))
  const selfReview = await toolCall({ action: 'approveReview', id: id }, worker)
  check('the card worker cannot review its own card', selfReview.error !== undefined && selfReview.code === 'worker-cannot-self-review', JSON.stringify(selfReview))
  const strangerReview = await toolCall({ action: 'approveReview', id: id }, { id: 'session-other' })
  check('a stranger cannot decide the review round', strangerReview.error !== undefined && strangerReview.code === 'role-required', JSON.stringify(strangerReview))
  const reviewer = { id: reviewTask.review.deliveredTo.id }
  const approved = await toolCall({ action: 'approveReview', id: id, checked: [{ criterion: 'stage moves', method: 'read result', result: 'pass' }] }, reviewer)
  check(
    'the delivered reviewer approves into testing',
    approved.ok === true && approved.task.status === 'testing' && approved.task.review.status === 'approved',
    JSON.stringify(approved),
  )
  const passed = await mergeRig.action('passTest', { id: id, probes: [{ id: 'suite', command: 'node --test', exitCode: 0, tail: 'PASS' }] })
  check('the user passes the test phase', passed.ok === true && passed.task.test.status === 'passed', JSON.stringify(passed))
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
  const created = await createThroughDecision(rig, { title: 'verify card', verify: { command: 'npm run verify && npm run e2e', timeoutMs: 120000 }, verification: PROBES })
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
  const card = await createThroughDecision(rig, { title: 'Why is the loader slow?', kind: 'investigate' })
  check('T-131 the tool creates an investigation', card.ok === true && card.task.kind === 'investigate', JSON.stringify(card.ok === true ? card.task.kind : card.code))
  const plain = await createThroughDecision(rig, { title: 'Plain dev card', verification: PROBES })
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
  const artifactsParam = rig.tool.parameters.artifacts
  check(
    'T-131 report carries an artifacts array of paths',
    artifactsParam !== undefined && artifactsParam.type === 'array' && artifactsParam.items !== undefined && artifactsParam.items.type === 'string',
    JSON.stringify(artifactsParam),
  )
  const evidenceParam = rig.tool.parameters.evidence
  check(
    'T-131 evidence accepts report rows as well as submit text',
    evidenceParam !== undefined && Array.isArray(evidenceParam.oneOf) && evidenceParam.oneOf.some((branch) => branch.type === 'array') && evidenceParam.oneOf.some((branch) => branch.type === 'string'),
    JSON.stringify(evidenceParam === undefined ? null : evidenceParam.oneOf.map((branch) => branch.type)),
  )
  const description = String(rig.tool.description === undefined ? '' : rig.tool.description)
  check('T-131 the description names investigations and report', description.indexOf('investigate') >= 0 && description.indexOf('report') >= 0, description.slice(-300))
}


// ── T-132: the tool router and the runtime skill agree on investigations ────
{
  const description = String(rig.tool.description === undefined ? '' : rig.tool.description)
  check(
    'T-132 the tool description says investigations deliver a report and skip review/test/merge',
    description.indexOf('kind investigate') >= 0 && description.indexOf('delivers a report') >= 0 && description.indexOf('submit/review/test/merge refuse it') >= 0,
    description.slice(0, 420),
  )
  const content = buildSkillContent({ actions: ACTIONS, agentActions: AGENT_ACTIONS, readActions: READ_ACTIONS, userOnlyActions: USER_ONLY_ACTIONS })
  check(
    'T-132 the runtime skill and the tool share the investigation vocabulary',
    content.indexOf('调查卡（investigate）') >= 0 && content.indexOf('`report`') >= 0 && description.indexOf('report') >= 0,
    JSON.stringify({ skill: content.indexOf('调查卡（investigate）'), tool: description.indexOf('report') }),
  )
  check('T-132 the tool keeps its router budget after the investigation wording', description.length <= 1400, String(description.length))
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
    artifacts: ['.worktrees/probe-T-11-a', '.worktrees/probe-T-11-b'],
  })
  check('T-131 the tool reports and completes the card', reported.ok === true && reported.task.status === 'done', JSON.stringify(reported.ok === true ? reported.task.status : reported.code))
  check(
    'T-131 the report keeps summary, body and evidence',
    reported.report !== null && reported.report.summary === 'The loader waits on the config read.' && reported.report.body === 'Full findings.' && reported.report.evidence.length === 1,
    JSON.stringify(reported.report),
  )
  check(
    'T-131 report records the artifacts the investigator listed',
    reported.report !== null && reported.report.artifacts.join(',') === '.worktrees/probe-T-11-a,.worktrees/probe-T-11-b',
    JSON.stringify(reported.report === null ? null : reported.report.artifacts),
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

// ── T-207: the needs-decision contract survives the tool envelope ──────────
{
  const contractRig = createRig({ allowSpawn: false, taskAgents: createFakeTaskAgents() })
  contractRig.ctx.tools = {
    register(tool) {
      contractRig.tool = tool
      return tool
    },
  }
  registerTaskTool(contractRig.ctx, { api: contractRig.api })
  const who = { id: 'session-contract' }
  const body = {
    action: 'create',
    title: 'Contract tool card',
    kind: 'dev',
    dependsOn: [],
    writeFiles: ['scripts/contract.gd'],
    acceptance: 'npm test is green',
    verification: PROBES,
  }
  const asked = await contractRig.tool.execute(body, { agent: who })
  check(
    'T-207 a gated tool create answers the explicit wait contract',
    asked.error !== undefined &&
      asked.code === 'needs-decision' &&
      asked.status === 'needs-decision' &&
      asked.waitForUser === true &&
      asked.retryable === false &&
      typeof asked.decisionId === 'string' &&
      asked.decision !== null &&
      asked.decision !== undefined &&
      asked.decisionId === String(asked.decision.id) &&
      asked.next !== null &&
      asked.next !== undefined &&
      asked.next.code === 'await-decision' &&
      asked.next.decisionId === asked.decisionId,
    JSON.stringify(asked).slice(0, 600),
  )
  check(
    'T-207 the tool wait answer is never an empty object',
    Object.keys(asked).length > 8 && JSON.stringify(asked) !== '{}' && typeof asked.error === 'string' && asked.error !== '',
    JSON.stringify(asked).slice(0, 300),
  )
  const repeated = await contractRig.tool.execute(body, { agent: who })
  check('T-207 a repeated tool create reuses the SAME decision id', repeated.decisionId === asked.decisionId && repeated.next.decisionId === asked.decisionId, JSON.stringify({ first: asked.decisionId, repeated: repeated.decisionId }))
  const pending = await contractRig.api.decisions.pending(contractRig.project)
  check('T-207 the repeat queued no second decision', pending.ok === true && pending.pending.length === 1, JSON.stringify(pending.pending.map((decision) => decision.id)))
  const boardBefore = await contractRig.action('board')
  check('T-207 the repeat wrote no card', boardBefore.tasks.length === 0, JSON.stringify(boardBefore.tasks.map((task) => task.id)))
  const startAsked = await contractRig.tool.execute({ action: 'start' }, { agent: who })
  check(
    'T-207 a gated tool start keeps needs-consent and the same wait contract',
    startAsked.code === 'needs-consent' &&
      startAsked.status === 'needs-decision' &&
      startAsked.waitForUser === true &&
      startAsked.retryable === false &&
      typeof startAsked.decisionId === 'string' &&
      startAsked.decision !== null &&
      startAsked.next !== null &&
      startAsked.next.code === 'await-decision',
    JSON.stringify(startAsked).slice(0, 500),
  )
  const answered = await contractRig.action('decisionAnswer', { decisionId: asked.decisionId, option: 'create' })
  const boardAfter = await contractRig.action('board')
  check(
    'T-207 the answered create makes exactly one card',
    answered.ok === true && answered.applied.executed === true && boardAfter.tasks.filter((task) => task.title === 'Contract tool card').length === 1,
    JSON.stringify(boardAfter.tasks.map((task) => task.title)),
  )
  const plain = await contractRig.tool.execute({ action: 'no-such-action' }, { agent: who })
  check(
    'T-207 a plain refusal is not dressed as a wait',
    plain.code === 'unknown-action' && plain.waitForUser === false && plain.retryable === false && plain.decisionId === null && plain.next === null,
    JSON.stringify(plain),
  )

  // Empty-object regression: an api that answers nothing must produce a typed
  // refusal, never `{}` — a caller must not read `{}` as "maybe it worked".
  const emptyRig = createRig({ allowSpawn: false, taskAgents: createFakeTaskAgents() })
  emptyRig.ctx.tools = {
    register(tool) {
      emptyRig.tool = tool
      return tool
    },
  }
  registerTaskTool(emptyRig.ctx, { api: { perform: async () => ({}) } })
  const empty = await emptyRig.tool.execute({ action: 'create', title: 'x' }, { agent: who })
  check(
    'T-207 an empty api result is a typed refusal, not an empty object',
    Object.keys(empty).length > 8 && JSON.stringify(empty) !== '{}' && empty.code === 'empty-result' && empty.waitForUser === false && empty.retryable === false && empty.decisionId === null,
    JSON.stringify(empty),
  )
  contractRig.scheduler.dispose()
  emptyRig.scheduler.dispose()
}

// ── T-220: the tool answer is lossless JSON ────────────────────────────────
// The host walks the value a tool RETURNS before output.render's JSON.stringify
// and refuses the whole call on the first undefined / non-finite / -0 / hole /
// Date / BigInt. The real snapshot carried `timings: undefined`, so openProject
// and board failed while get/list were fine. These checks pin the walker AND
// the funnel every answer now leaves through.
{
  /** Mirrors the host's strict walker: plain JSON data only, no holes. */
  function losslessShape(value) {
    if (value === null) return true
    const type = typeof value
    if (type === 'string' || type === 'boolean') return true
    if (type === 'number') return Number.isFinite(value) && !Object.is(value, -0)
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false
      for (let index = 0; index < value.length; index++) {
        if (!(index in value)) return false
        if (!losslessShape(value[index])) return false
      }
      return true
    }
    if (type === 'object') {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) return false
      return Object.keys(value).every((key) => losslessShape(value[key]))
    }
    return false
  }
  const roundTrip = (value) => {
    try {
      return JSON.parse(JSON.stringify(value))
    } catch (error) {
      return null
    }
  }
  const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

  // The walker, on a payload shaped like the T-218 failure.
  const nested = {
    ok: true,
    project: '/fake/project',
    timings: undefined,
    preflight: { ok: false, detail: undefined, checkedAt: new Date('2026-01-02T03:04:05.000Z') },
    tasks: [{ id: 'T-1', title: 'card', assignee: undefined, attempts: NaN, tags: [undefined, 'a', , 'b'] }],
    counts: { pending: 1, running: Infinity, cancelled: -0 },
  }
  const cleaned = lossless(nested)
  check(
    'T-220 lossless drops undefined object properties (like JSON.stringify)',
    !has(cleaned, 'timings') && !has(cleaned.preflight, 'detail') && !has(cleaned.tasks[0], 'assignee'),
    JSON.stringify(cleaned).slice(0, 260),
  )
  check(
    'T-220 lossless maps NaN/Infinity to null and -0 to 0',
    cleaned.tasks[0].attempts === null && cleaned.counts.running === null && Object.is(cleaned.counts.cancelled, 0) && cleaned.counts.pending === 1,
    JSON.stringify(cleaned.counts) + ' attempts=' + String(cleaned.tasks[0].attempts),
  )
  check(
    'T-220 lossless keeps array length and fills undefined/holes with null',
    cleaned.tasks[0].tags.length === 4 && cleaned.tasks[0].tags[0] === null && cleaned.tasks[0].tags[1] === 'a' && cleaned.tasks[0].tags[2] === null && cleaned.tasks[0].tags[3] === 'b',
    JSON.stringify(cleaned.tasks[0].tags),
  )
  check(
    'T-220 lossless writes a Date as ISO and a BigInt as a decimal string',
    cleaned.preflight.checkedAt === '2026-01-02T03:04:05.000Z' && lossless(12n) === '12' && lossless(undefined) === null,
    String(cleaned.preflight.checkedAt) + ' / ' + String(lossless(12n)),
  )
  const expectedCleaned = {
    ok: true,
    project: '/fake/project',
    preflight: { ok: false, checkedAt: '2026-01-02T03:04:05.000Z' },
    tasks: [{ id: 'T-1', title: 'card', attempts: null, tags: [null, 'a', null, 'b'] }],
    counts: { pending: 1, running: null, cancelled: 0 },
  }
  check(
    'T-220 the cleaned answer is strictly lossless and round-trips',
    losslessShape(cleaned) && JSON.stringify(roundTrip(cleaned)) === JSON.stringify(expectedCleaned),
    JSON.stringify(roundTrip(cleaned)),
  )
  check(
    'T-220 lossless leaves the api result untouched',
    has(nested, 'timings') && nested.tasks[0].assignee === undefined && Number.isNaN(nested.tasks[0].attempts) && nested.preflight.checkedAt instanceof Date,
    Object.keys(nested).join(','),
  )
  check(
    'T-220 an already-lossless answer comes back unchanged',
    JSON.stringify(lossless({ ok: true, project: '/p', tasks: [{ id: 'T-1', attempts: 1, tags: ['a', null] }] })) ===
      JSON.stringify({ ok: true, project: '/p', tasks: [{ id: 'T-1', attempts: 1, tags: ['a', null] }] }),
  )
  const hostile = JSON.parse('{"ok":true,"__proto__":{"polluted":true}}')
  const sanitizedHostile = lossless(hostile)
  check(
    'T-220 a literal __proto__ key stays data and cannot pollute prototypes',
    Object.getPrototypeOf(sanitizedHostile) === Object.prototype &&
      has(sanitizedHostile, '__proto__') &&
      {}.polluted === undefined &&
      JSON.stringify(sanitizedHostile) === '{"ok":true,"__proto__":{"polluted":true}}',
    JSON.stringify(sanitizedHostile),
  )
  const circular = { ok: true }
  circular.self = circular
  check('T-220 a circular value cannot throw or hang', lossless(circular).self === null && roundTrip(lossless(circular)) !== null, 'self=' + String(lossless(circular).self))

  // The tool funnel: openProject and board both answer a snapshot-shaped
  // payload (the real one carries `timings: undefined`).
  const snapshotPayload = () => ({
    ok: true,
    project: '/fake/project',
    seq: NaN,
    timings: undefined,
    tasks: [{ id: 'T-9', title: 'card', assignee: undefined, attempts: Infinity, tags: [undefined, 'a', , 'b'] }],
    counts: { pending: 1, running: 0 },
    boardSize: { percent: NaN, level: 'ok' },
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const fakeApi = {
    perform: async (action) => {
      if (action === 'openProject') return Object.assign(snapshotPayload(), { preflight: { ok: true, openOk: true, openFailed: [], checkedAt: new Date('2026-01-02T03:04:05.000Z') } })
      if (action === 'board') return snapshotPayload()
      if (action === 'get') return { ok: true, task: { id: 'T-1', title: 'clean' }, locks: [] }
      return { ok: false, code: 'unknown-action', message: 'no such action' }
    },
  }
  const fakeTool = registerTaskTool(
    { tools: { register: (tool) => tool }, sandboxPolicy: { resolve: () => ({ workspaceRoot: '/fake/project' }) } },
    { api: fakeApi },
  )
  const opened = await fakeTool.execute({ action: 'openProject', path: '/fake/project' }, { agent })
  check(
    'T-220 the openProject answer is lossless and round-trips',
    opened.ok === true && losslessShape(opened) && roundTrip(opened) !== null && roundTrip(opened).project === '/fake/project',
    JSON.stringify(opened).slice(0, 320),
  )
  check('T-220 the openProject answer drops the undefined timings field', !has(opened, 'timings'), Object.keys(opened).join(','))
  check(
    'T-220 the openProject answer keeps every real field',
    opened.tasks[0].title === 'card' && opened.tasks[0].tags[2] === null && opened.preflight.checkedAt === '2026-01-02T03:04:05.000Z' && opened.boardSize.percent === null && opened.seq === null,
    JSON.stringify(opened.tasks[0]) + ' seq=' + String(opened.seq),
  )
  const boardAnswer = await fakeTool.execute({ action: 'board' }, { agent })
  check(
    'T-220 the board answer is lossless and round-trips',
    boardAnswer.ok === true && losslessShape(boardAnswer) && roundTrip(boardAnswer) !== null && !has(boardAnswer, 'timings') && boardAnswer.tasks[0].attempts === null,
    JSON.stringify(boardAnswer).slice(0, 320),
  )
  const clean = { ok: true, task: { id: 'T-1', title: 'clean' }, locks: [] }
  const got = await fakeTool.execute({ action: 'get', id: 'T-1' }, { agent })
  check('T-220 a normal answer passes through unchanged', JSON.stringify(got) === JSON.stringify(clean), JSON.stringify(got))
  check('T-220 the tool answer does not alias the api result', got !== clean && got.task !== clean.task, got === clean ? 'same object' : 'copy')
  const refused = await fakeTool.execute({ action: 'delete', id: 'T-1' }, { agent })
  check(
    'T-220 a refusal is lossless too',
    refused.ok !== true && losslessShape(refused) && roundTrip(refused) !== null && refused.error === 'no such action' && refused.code === 'unknown-action',
    JSON.stringify(refused).slice(0, 260),
  )

  // The production path: the REAL snapshot still builds `timings: undefined`,
  // and board must now answer it without the host rejecting the call.
  const liveBoard = await call({ action: 'board' })
  check(
    'T-220 the real board snapshot answers lossless JSON',
    liveBoard.ok === true && !has(liveBoard, 'timings') && losslessShape(liveBoard) && roundTrip(liveBoard) !== null,
    JSON.stringify(Object.keys(liveBoard).slice(0, 12)),
  )
}


// ── T-231: ONE read contract — board is a summary page, list is /list, and a
// write answers what changed (seq/affected/changed), never the board ─────────
// T-229 measured the tool board at 4.85 MB and the tool list at 2.64 MB for the
// same project the panel reads as a light first paint. The tool now reads the
// SAME TaskSummary page the panel/list read; 'view:"full"' stays as the explicit
// diagnostic escape hatch.
{
  /** A board the size of the reported one: 200 cards with detail-class payloads. */
  function bigBoardText(count) {
    const tasks = []
    for (let index = 1; index <= count; index += 1) {
      const status = index <= count - 20 ? 'pending' : 'done'
      tasks.push({
        id: 'T-' + String(index),
        title: 'Card ' + String(index) + ' ' + 'the work is done and proven; '.repeat(4),
        kind: 'dev',
        status: status,
        priority: 30,
        dependsOn: [],
        writeFiles: ['plugin/task-center/api.mjs'],
        verification: { probes: [{ id: 'suite', command: 'npm test' }] },
        spec: 'spec text '.repeat(60),
        acceptance: 'acceptance text '.repeat(40),
        evidence: 'evidence '.repeat(30),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-0' + String((index % 9) + 1) + 'T00:00:00.000Z',
        history: [
          { at: '2026-01-02T00:00:00.000Z', from: null, to: 'pending', note: 'created ' + 'note text '.repeat(30) },
          { at: '2026-01-03T00:00:00.000Z', from: 'pending', to: 'running', note: 'dispatched ' + 'note text '.repeat(30) },
          { at: '2026-01-04T00:00:00.000Z', from: 'running', to: status, note: 'final ' + 'note text '.repeat(30) },
        ],
      })
    }
    return JSON.stringify({ version: 1, tasks: tasks })
  }

  const pageRig = createRig({ allowSpawn: false, taskAgents: createFakeTaskAgents() })
  pageRig.ctx.tools = {
    register(tool) {
      pageRig.tool = tool
      return tool
    },
  }
  registerTaskTool(pageRig.ctx, { api: pageRig.api })
  const pageBoardText = bigBoardText(200)
  seedBoard(pageRig.fs, pageRig.project, pageBoardText)
  const pageCall = (args) => pageRig.tool.execute(args, { agent: agent })

  const first = await pageCall({ action: 'board' })
  check(
    'T-231 the tool board answers a summary PAGE by default',
    first.ok === true && first.view === 'summary' && first.counts.total === 200 && first.total === 200 && first.tasks.length === 50 && first.count === 50 && typeof first.nextCursor === 'string',
    JSON.stringify({ view: first.view, count: first.count, total: first.total, next: first.nextCursor }).slice(0, 300),
  )
  check(
    'T-231 a board card is the frozen TaskSummary (no detail-class fields)',
    first.tasks.every((card) => card.writeFileCount === 1 && card.writeFiles === undefined && card.spec === undefined && card.acceptance === undefined && card.evidence === undefined && card.history === undefined && card.events.length === 2),
    JSON.stringify(first.tasks[0]).slice(0, 300),
  )
  check(
    'T-231 the default board answer is under 200 KB on a 200-card board',
    JSON.stringify(first).length < 200000,
    String(JSON.stringify(first).length) + 'B (board file ' + String(pageBoardText.length) + 'B)',
  )
  check(
    'T-231 the board page keeps the board facts a reader routes on',
    first.dispatch !== undefined && Array.isArray(first.locks) && Number.isFinite(first.seq) && first.counts.pending === 180 && first.counts.done === 20,
    JSON.stringify({ seq: first.seq, counts: first.counts, dispatch: first.dispatch === undefined ? null : first.dispatch.state }).slice(0, 300),
  )
  {
    const ids = new Set()
    let cursor = first.nextCursor
    let current = first
    let pages = 1
    ids.add(current.tasks[0].id)
    for (const card of current.tasks) ids.add(card.id)
    while (cursor !== null && pages < 10) {
      current = await pageCall({ action: 'board', cursor: cursor })
      if (current.ok !== true) break
      for (const card of current.tasks) ids.add(card.id)
      cursor = current.nextCursor
      pages += 1
    }
    check(
      'T-231 the board cursor pages through every card exactly once',
      pages === 4 && ids.size === 200 && cursor === null,
      JSON.stringify({ pages: pages, ids: ids.size, cursor: cursor }).slice(0, 300),
    )
  }
  {
    const full = await pageCall({ action: 'board', view: 'full' })
    check(
      'T-231 view:"full" is the explicit diagnostic escape hatch',
      full.ok === true && full.view === undefined && full.tasks.length === 200 && typeof full.tasks[0].spec === 'string' && full.agentTree !== undefined && JSON.stringify(full).length > JSON.stringify(first).length * 5,
      JSON.stringify({ tasks: full.tasks.length, spec: typeof full.tasks[0].spec, bytes: JSON.stringify(full).length }).slice(0, 300),
    )
  }
  {
    const listed = await pageCall({ action: 'list', limit: 5 })
    const routePage = await pageRig.api.taskList(pageRig.project, { limit: 5 })
    check(
      'T-231 the tool list answers the SAME {tasks,nextCursor,count} shape as /list',
      listed.ok === true && Array.isArray(listed.tasks) && listed.tasks.length === 5 && typeof listed.nextCursor === 'string' && listed.count === 5 && Object.keys(listed).sort().join(',') === 'count,nextCursor,ok,tasks',
      JSON.stringify(Object.keys(listed)).slice(0, 240),
    )
    check(
      'T-231 the tool list is byte-identical to the /list handler for the same page',
      JSON.stringify(listed.tasks) === JSON.stringify(routePage.tasks) && listed.nextCursor === routePage.nextCursor,
      JSON.stringify({ tool: listed.tasks.length, route: routePage.tasks.length }),
    )
    const second = await pageCall({ action: 'list', limit: 5, cursor: listed.nextCursor })
    check(
      'T-231 the tool list cursor moves to the next page',
      second.ok === true && second.tasks.length === 5 && second.tasks[0].id !== listed.tasks[0].id,
      JSON.stringify({ first: listed.tasks[0].id, second: second.tasks === undefined ? null : second.tasks[0].id }),
    )
    const searched = await pageCall({ action: 'list', q: 'Card 123 ', limit: 10 })
    check(
      'T-231 the tool list searches like /list (q)',
      searched.ok === true && searched.tasks.length === 1 && searched.tasks[0].id === 'T-123',
      JSON.stringify(searched.tasks === undefined ? null : searched.tasks.map((task) => task.id)),
    )
    const doneRows = await pageCall({ action: 'list', status: 'done', limit: 200 })
    check(
      'T-231 the tool list filters by status and caps the page at the /list limit',
      doneRows.ok === true && doneRows.tasks.length === 20 && doneRows.tasks.every((task) => task.status === 'done'),
      JSON.stringify({ count: doneRows.tasks === undefined ? null : doneRows.tasks.length }),
    )
    const archived = await pageCall({ action: 'list', archived: true })
    check(
      'T-231 archived:true reads the archive instead of the live board',
      archived.ok === true && archived.tasks.length === 0 && archived.archived === true,
      JSON.stringify(archived).slice(0, 240),
    )
  }
  {
    const paused = await pageCall({ action: 'pause' })
    check(
      'T-231 a write answer carries seq + affected + changed and NO board',
      paused.ok === true && Number.isFinite(paused.seq) && paused.affected !== undefined && Array.isArray(paused.affected.ids) && paused.affected.count === paused.affected.ids.length && paused.changed.join(',') === 'board' && paused.board === undefined && paused.snapshot === undefined,
      JSON.stringify({ seq: paused.seq, affected: paused.affected, changed: paused.changed, board: paused.board === undefined, snapshot: paused.snapshot === undefined }).slice(0, 300),
    )
    const updated = await pageCall({ action: 'update', id: 'T-1', priority: 31 })
    check(
      'T-231 a one-card write names the card in affected and adds the detail domain',
      updated.ok === true && updated.affected.ids.indexOf('T-1') >= 0 && updated.affected.count === 1 && updated.changed.join(',') === 'board,detail' && Number.isFinite(updated.seq),
      JSON.stringify({ seq: updated.seq, affected: updated.affected, changed: updated.changed }).slice(0, 300),
    )
  }
  {
    const opened = await pageCall({ action: 'openProject', path: pageRig.project })
    const fullSnapshot = await pageRig.api.snapshot(pageRig.project, { sessionId: 'session-lead' })
    check(
      'T-231 the tool openProject answers a summary page + binding facts, not the full board',
      opened.ok === true && opened.view === 'summary' && opened.tasks.length === 50 && opened.counts.total === 200 && opened.preflight !== undefined && typeof opened.preflight.ok === 'boolean' && opened.registry !== undefined && opened.tasks[0].spec === undefined && opened.agentTree === undefined && opened.worktrees === undefined,
      JSON.stringify({ view: opened.view, tasks: opened.tasks === undefined ? null : opened.tasks.length, heavy: Object.keys(opened).filter((key) => ['agentTree', 'worktrees', 'environment', 'roles', 'activityEvents'].indexOf(key) >= 0) }).slice(0, 300),
    )
    check(
      'T-231 the tool openProject answer is a fraction of the full snapshot',
      JSON.stringify(opened).length * 5 < JSON.stringify(fullSnapshot).length,
      'openProject=' + String(JSON.stringify(opened).length) + 'B full=' + String(JSON.stringify(fullSnapshot).length) + 'B',
    )
  }
  pageRig.scheduler.dispose()
}

if (typeof disposer === 'function') disposer()
rig.scheduler.dispose()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)