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
check('the old setStatus vocabulary is gone', actions.indexOf('setStatus') < 0, actions.join(','))
check('the tool exposes lock and forceUnlock', actions.indexOf('lock') >= 0 && actions.indexOf('forceUnlock') >= 0)

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
  const started = await call({ action: 'start' })
  check('the tool starts dispatch', started.ok === true && started.dispatch.state === 'running', JSON.stringify(started))
  const board = await call({ action: 'board' })
  const task = board.tasks.filter((entry) => entry.id === id)[0]
  check('the task is dispatched to the idle teammate', task.status === 'running' && task.assignee.name === 'fixer', JSON.stringify(task && task.assignee))
  const wrong = await call({ action: 'submit', id: id, evidence: 'mine' }, other)
  check('a different agent cannot submit it', wrong.error !== undefined && wrong.code === 'not-assignee', JSON.stringify(wrong))
  const submitted = await call({ action: 'submit', id: id, evidence: 'tests pass' }, { id: 'session-idle' })
  check('the assignee can submit it', submitted.ok === true && submitted.task.status === 'done', JSON.stringify(submitted))
  check('and the evidence is stored', submitted.task.evidence === 'tests pass')
  const paused = await call({ action: 'pause' })
  check('the tool pauses dispatch', paused.dispatch.state === 'paused')
}

// locks owned by the running task
{
  const created = await call({ action: 'create', title: 'locked work', writeFiles: [] })
  const id = created.task.id
  rig.team.setStatus('fixer', 'inactive')
  await call({ action: 'start' })
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

if (typeof disposer === 'function') disposer()
rig.scheduler.dispose()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)