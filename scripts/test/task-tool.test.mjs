// Task tool tests: the model-facing binding of the same action API.

import { register } from 'node:module'
register('./stubs/hooks.mjs', import.meta.url)

const { registerTaskTool, agentLabel, projectPathOf } = await import('../../plugin/task-center/tool.mjs')
const { createRig, createTask } = await import('./support/fixtures.mjs')

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

const rig = createRig({ allowSpawn: false })
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
check('the tool exposes start and pause', actions.indexOf('start') >= 0 && actions.indexOf('pause') >= 0, actions.join(','))
check('the tool exposes create and submit', actions.indexOf('create') >= 0 && actions.indexOf('submit') >= 0)
check(
  'the tool exposes the merge queue and its refresh',
  actions.indexOf('mergeRequest') >= 0 && actions.indexOf('rejectMerge') >= 0 && actions.indexOf('refreshMerge') >= 0,
  actions.join(','),
)
{
  const description = String(rig.tool.description === undefined ? '' : rig.tool.description)
  check('the tool says dependencies must be merged, not just done', description.indexOf('done and merged') >= 0, description.slice(0, 300))
  check('the tool says refreshMerge re-bases on the target head', description.indexOf('re-bases it on the target') >= 0, description.slice(0, 300))
  check(
    'the tool describes the reviewer hand-off',
    description.indexOf('per-round brief') >= 0 && description.indexOf('read-only') >= 0,
    description.slice(0, 600),
  )
  check('requestChanges carries explicit reasons', rig.tool.parameters.reasons !== undefined, JSON.stringify(rig.tool.parameters.reasons))
  check(
    'the tool describes the candidate tester workflow and Godot launches',
    description.indexOf('test candidate') >= 0 && description.indexOf('godot_run_headless') >= 0 && description.indexOf('passTest') >= 0,
    description.slice(0, 1400),
  )
  check('the tool no longer describes a host verification gate', description.indexOf('after verification') < 0, description.slice(0, 1400))
}
check('the old setStatus vocabulary is gone', actions.indexOf('setStatus') < 0, actions.join(','))
check('the tool exposes lock and forceUnlock', actions.indexOf('lock') >= 0 && actions.indexOf('forceUnlock') >= 0)
check(
  'user-only role administration is hidden from the tool',
  ['rolesList', 'rolesCreate', 'rolesUpdate', 'rolesDelete', 'rolesBind', 'rolesDrain', 'rolesReplace', 'rolesReset'].every((action) => actions.indexOf(action) < 0),
  actions.join(','),
)
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

// locks owned by the running task
{
  const created = await call({ action: 'create', title: 'locked work', writeFiles: [] })
  const id = created.task.id
  rig.team.setStatus('fixer', 'inactive')
  await rig.api.perform('start', {}, rig.user)
  const locks = await call({ action: 'lock', paths: ['scripts/extra.gd'] }, { id: 'session-idle' })
  check('the assignee can lock an extra file', locks.ok === true && locks.granted === true, JSON.stringify(locks))
  check('the lock is attached to the running task', typeof locks.taskId === 'string' && locks.taskId.length > 0, String(locks.taskId))
  const listed = await call({ action: 'locks' })
  check('locks lists the file', listed.locks.some((lock) => lock.path === 'scripts/extra.gd'), JSON.stringify(listed.locks))
  const unlocked = await call({ action: 'unlock', paths: ['scripts/extra.gd'] }, { id: 'session-idle' })
  check('the assignee can unlock it', unlocked.ok === true && unlocked.released.join(',') === 'scripts/extra.gd', JSON.stringify(unlocked))
  await call({ action: 'submit', id: id, evidence: 'done' }, { id: 'session-idle' })
  await call({ action: 'pause' })
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
  const toolCall = (args, who) => mergeRig.tool.execute(args, { agent: who })
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

if (typeof disposer === 'function') disposer()
rig.scheduler.dispose()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)