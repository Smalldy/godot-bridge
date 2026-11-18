// T-196 — action preflight decisions (create / start / reopen / delete / cancel).
//
// The requirement packet says the HOST asks, not the Agent: an Agent call of a
// gated action writes a pending DecisionRequest and answers needs-decision (start
// keeps needs-consent), the panel answers it, and the host executes the stored
// action in one step and messages the asking Session. The panel's own calls
// (role 'user') are the human's action and run straight through.
//
// Covered here:
//   S1  create asks for every kind and cancelling never writes the board
//   S2  the create timeout default (创建) auto-creates after 120s
//   S3  start shows concurrency/ready cards; hold/withdraw never dispatch,
//       approve dispatches, the 300s default is hold
//   S4  reopen shows the state and clears review/test
//   S5  delete shows the recursive downstream tree, needs DELETE when it has
//       dependents, then gates the destructive purge behind the second panel
//   S6  cancel shows the downstream impact and the 120s default is 返回
//   S7  one pending question per (action, target); the panel stays direct
//   S8  the result reaches the asking Agent as a message and invalid calls refuse

import assert from 'node:assert/strict'
import { createRig, createFakeTaskAgents, PROJECT } from './support/fixtures.mjs'
import { decisionsPath } from '../../plugin/task-center/decisions.mjs'

const START = Date.parse('2026-11-19T00:00:00.000Z')
let clockNow = START
const now = () => clockNow

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

function freshRig(options) {
  clockNow = START
  const agents = createFakeTaskAgents()
  const rig = createRig(Object.assign({ now: now, taskAgents: agents, allowSpawn: false }, options === undefined ? {} : options))
  return { rig: rig, agents: agents }
}

function agentContext(rig, name) {
  const who = name === undefined ? 'agent' : name
  return { projectPath: rig.project, by: '@' + who, role: 'agent', agent: { id: 'session-' + who, name: who } }
}

async function userCreate(rig, input) {
  const result = await rig.action('create', input)
  if (result.ok !== true) throw new Error('user create failed: ' + JSON.stringify(result))
  return result.task
}

async function userCancel(rig, id) {
  const result = await rig.action('cancel', { id: id })
  if (result.ok !== true) throw new Error('user cancel failed: ' + JSON.stringify(result))
  return result.task
}

const messages = (agents) => agents.calls.filter((call) => call.kind === 'send').map((call) => call.text)

// ── S1: every create asks first; cancelling never writes the board ──────────
{
  const { rig, agents } = freshRig()
  let expectedId = 1
  for (const kind of ['dev', 'investigate']) {
    const asked = await rig.api.perform(
      'create',
      { title: 'Card ' + kind, kind: kind, dependsOn: [], writeFiles: ['scripts/' + kind + '.gd'], acceptance: 'npm test is green' },
      agentContext(rig, kind),
    )
    check('S1 ' + kind + ' create answers needs-decision instead of writing', asked.ok === false && asked.code === 'needs-decision' && asked.decision !== undefined, JSON.stringify(asked))
    const decision = asked.decision
    check('S1 the question carries the aligned create copy', decision.title === '创建任务 T-' + String(expectedId) + '？', decision.title)
    check(
      'S1 the body lists title/kind/target/deps/files/acceptance',
      ['任务：Card ' + kind, '类型：' + kind, '目标：默认', '依赖：无', '写入文件：scripts/' + kind + '.gd', '验收：npm test is green'].every((needle) => decision.body.indexOf(needle) >= 0),
      decision.body,
    )
    check('S1 the options are 创建任务 (default) and 取消创建', decision.options.map((option) => option.label).join(',') === '创建任务,取消创建' && decision.defaultOption === 'create' && decision.options[0].default === true, JSON.stringify(decision.options))
    check('S1 the create default timeout is 120s', decision.remainingMs === 120000 && decision.timeoutAt === '2026-11-19T00:02:00.000Z', JSON.stringify({ remaining: decision.remainingMs, at: decision.timeoutAt }))
    check('S1 the server marks the create default as auto-runnable', decision.autoRunAllowed === true)
    expectedId += 1
  }
  const board = await rig.action('board')
  check('S1 pending questions never write the board', board.tasks.length === 0, JSON.stringify(board.tasks.map((task) => task.id)))
  // The Agent cannot answer its own question: that would defeat the gate.
  const selfAnswer = await rig.api.perform('decisionAnswer', { decisionId: 'DEC-1', option: 'create' }, agentContext(rig, 'dev'))
  check('S1 an Agent cannot answer its own action decision', selfAnswer.ok === false && selfAnswer.code === 'user-only' && (await rig.action('board')).tasks.length === 0, JSON.stringify(selfAnswer))
  const stillPending = await rig.action('decisionList', {})
  check('S1 the refused self-answer leaves the question pending', stillPending.decisions.some((decision) => decision.id === 'DEC-1'), JSON.stringify(stillPending.decisions.map((decision) => decision.id)))

  // A retry of the identical request is the SAME question, not a second one.
  const first = await rig.api.perform('create', { title: 'Card dev', kind: 'dev', dependsOn: [], writeFiles: ['scripts/dev.gd'], acceptance: 'npm test is green' }, agentContext(rig, 'dev'))
  check('S1 a retried create returns the SAME pending question', first.decision.id === 'DEC-1', JSON.stringify({ asked: first.decision.id }))
  const queued = await rig.action('decisionList', {})
  check(
    'S1 only one dev question is queued (the investigate one is separate)',
    queued.decisions.filter((decision) => decision.payload !== null && decision.payload !== undefined && decision.payload.input !== null && decision.payload.input !== undefined && decision.payload.input.title === 'Card dev').length === 1,
    JSON.stringify(queued.decisions.map((decision) => decision.title)),
  )

  // Cancel with a revision note: the board stays empty, the Agent is told why.
  const cancelled = await rig.action('decisionAnswer', { decisionId: 'DEC-1', option: 'cancel', text: 'split the file first' })
  check('S1 cancelling is decision-rejected with the note', cancelled.ok === true && cancelled.applied.code === 'decision-rejected' && cancelled.applied.message.indexOf('split the file first') >= 0, JSON.stringify(cancelled.applied))
  const after = await rig.action('board')
  check('S1 the cancelled create wrote nothing', after.tasks.length === 0, JSON.stringify(after.tasks.map((task) => task.id)))
  check('S1 the Agent receives the rejection as a message', messages(agents).some((text) => text.indexOf('decision-rejected') >= 0 && text.indexOf('split the file first') >= 0), JSON.stringify(messages(agents)))

  // Approving writes the card the question described (a fresh question after the cancel).
  const second = await rig.api.perform('create', { title: 'Card dev', kind: 'dev', dependsOn: [], writeFiles: ['scripts/dev.gd'], acceptance: 'npm test is green' }, agentContext(rig, 'dev'))
  check('S1 a create after the cancellation is a NEW question', second.decision.id !== 'DEC-1' && second.decision.status === 'pending', JSON.stringify({ id: second.decision.id }))
  const approved = await rig.action('decisionAnswer', { decisionId: second.decision.id, option: 'create' })
  check('S1 answering 创建任务 writes the card once', approved.ok === true && approved.applied.executed === true && typeof approved.applied.summary.taskId === 'string', JSON.stringify(approved.applied))
  const created = await rig.action('get', { id: approved.applied.summary.taskId })
  check(
    'S1 the created card keeps the fields the human approved',
    created.ok === true && created.task.title === 'Card dev' && created.task.kind === 'dev' && created.task.target === null && created.task.acceptance === 'npm test is green' && created.task.writeFiles.join(',') === 'scripts/dev.gd',
    JSON.stringify(created.task),
  )
  check('S1 the card belongs to the asking Session', created.task.ownerSession === 'session-dev', String(created.task.ownerSession))
  check('S1 the Agent receives the created id as a message', messages(agents).some((text) => text.indexOf('created ' + String(created.task.id)) >= 0), JSON.stringify(messages(agents)))
  const stored = JSON.parse(rig.fs.files.get(decisionsPath(PROJECT)).text)
  check('S1 the decision store records both answers', stored.requests.filter((record) => record.status === 'answered').length === 2, JSON.stringify(stored.requests.map((record) => record.status)))
}

// ── S2: the create timeout default creates after 120s ──────────────────────
{
  const { rig, agents } = freshRig()
  const asked = await rig.api.perform('create', { title: 'Timed card', kind: 'dev' }, agentContext(rig, 'timer'))
  check('S2 a timed create starts pending', asked.code === 'needs-decision' && asked.decision.autoRunAllowed === true)
  clockNow = START + 121000
  await rig.api.snapshot(PROJECT, { full: false })
  const board = await rig.action('board')
  check('S2 the 120s default applies through the snapshot sweep', board.tasks.length === 1 && board.tasks[0].title === 'Timed card', JSON.stringify(board.tasks.map((task) => task.title)))
  check('S2 the Agent is told the default was applied', messages(agents).some((text) => text.indexOf('timed out') >= 0 && text.indexOf('created') >= 0), JSON.stringify(messages(agents)))
  const listed = await rig.action('decisionList', { decisionStatus: 'all' })
  check('S2 the expired record names its default resolution', listed.decisions[0].status === 'expired' && listed.decisions[0].resolution.option === 'create' && listed.decisions[0].resolution.via === 'timeout', JSON.stringify(listed.decisions[0]))
}

// ── S3: start shows concurrency and ready cards; hold/timeout never dispatch ─
{
  const { rig } = freshRig()
  await userCreate(rig, { title: 'Ready one' })
  await userCreate(rig, { title: 'Ready two' })
  const asked = await rig.api.perform('start', {}, agentContext(rig, 'starter'))
  check('S3 start keeps its historical needs-consent code and carries the decision', asked.ok === false && asked.code === 'needs-consent' && asked.decision !== undefined && asked.request !== null, JSON.stringify(asked))
  const decision = asked.decision
  check('S3 the question shows the current concurrency', decision.body.indexOf('当前并发：0/3') >= 0, decision.body)
  check('S3 the question lists the ready cards', decision.body.indexOf('待执行：T-1, T-2') >= 0, decision.body)
  check('S3 the options are 批准派发 / 暂不派发 (default) / 取消申请', decision.options.map((option) => option.label).join(',') === '批准派发,暂不派发,取消申请' && decision.defaultOption === 'hold', JSON.stringify(decision.options))
  check('S3 the start default timeout is 300s', decision.remainingMs === 300000, String(decision.remainingMs))
  const board = await rig.action('board')
  check('S3 asking never starts dispatch', board.dispatch.state === 'paused')

  const held = await rig.action('decisionAnswer', { decisionId: decision.id, option: 'hold' })
  check('S3 暂不派发 keeps dispatch paused', held.ok === true && held.applied.executed === false && held.applied.code === null, JSON.stringify(held.applied))
  const stillPaused = await rig.action('board')
  check('S3 and no card moved', stillPaused.dispatch.state === 'paused' && stillPaused.tasks.every((task) => task.status === 'pending'), JSON.stringify(stillPaused.dispatch))

  // The 300s default is hold: the sweep records it and never dispatches.
  const timed = await rig.api.perform('start', {}, agentContext(rig, 'starter'))
  clockNow = START + 301000
  await rig.api.snapshot(PROJECT, { full: false })
  const afterTimeout = await rig.action('board')
  check('S3 the start timeout leaves dispatch paused', afterTimeout.dispatch.state === 'paused', JSON.stringify(afterTimeout.dispatch))
  const listed = await rig.action('decisionList', { decisionStatus: 'all' })
  const expiredStart = listed.decisions.filter((record) => record.id === timed.decision.id)[0]
  check('S3 the expired start resolution is 暂不派发', expiredStart.status === 'expired' && expiredStart.resolution.option === 'hold' && expiredStart.resolution.via === 'timeout', JSON.stringify(expiredStart.resolution))

  // Approving dispatches.
  const again = await rig.api.perform('start', {}, agentContext(rig, 'starter'))
  const approved = await rig.action('decisionAnswer', { decisionId: again.decision.id, option: 'approve' })
  check('S3 批准派发 starts dispatch', approved.ok === true && approved.applied.summary.dispatch === 'running', JSON.stringify(approved.applied))
  const running = await rig.action('board')
  check('S3 and the dispatcher is running', running.dispatch.state === 'running', JSON.stringify(running.dispatch))
}

// ── S4: reopen asks, announces the state and clears review/test ────────────
{
  const { rig, agents } = freshRig()
  const card = await userCreate(rig, { title: 'Closed card' })
  await userCancel(rig, card.id)
  const asked = await rig.api.perform('reopen', { id: card.id }, agentContext(rig, 'reopener'))
  check('S4 reopen asks with the current state', asked.ok === false && asked.code === 'needs-decision' && asked.decision.body.indexOf('当前状态：cancelled') >= 0, JSON.stringify(asked))
  check('S4 the reopen options are 重新打开 (default) / 保持关闭', asked.decision.options.map((option) => option.label).join(',') === '重新打开,保持关闭' && asked.decision.defaultOption === 'reopen', JSON.stringify(asked.decision.options))
  check('S4 the body names the cleared review/test', asked.decision.body.indexOf('清空 review/test') >= 0, asked.decision.body)
  const kept = await rig.action('decisionAnswer', { decisionId: asked.decision.id, option: 'keep' })
  check('S4 保持关闭 changes nothing', kept.ok === true && (await rig.action('get', { id: card.id })).task.status === 'cancelled', JSON.stringify(kept.applied))
  const again = await rig.api.perform('reopen', { id: card.id }, agentContext(rig, 'reopener'))
  const reopened = await rig.action('decisionAnswer', { decisionId: again.decision.id, option: 'reopen' })
  check('S4 重新打开 puts the card back in the queue', reopened.ok === true && reopened.applied.summary.status === 'pending', JSON.stringify(reopened.applied))
  const open = await rig.action('get', { id: card.id })
  check('S4 the reopened card has no review/test left', open.task.status === 'pending' && open.task.review === null && open.task.test === null, JSON.stringify(open.task))
  check('S4 the Agent is messaged', messages(agents).some((text) => text.indexOf('back in the todo queue') >= 0), JSON.stringify(messages(agents)))
}

// ── S5: delete shows the recursive tree and the purge needs DELETE twice ────
{
  const { rig, agents } = freshRig()
  const root = await userCreate(rig, { title: 'Root' })
  const child = await userCreate(rig, { title: 'Child', dependsOn: [root.id] })
  const grandchild = await userCreate(rig, { title: 'Grandchild', dependsOn: [child.id] })
  const outside = await userCreate(rig, { title: 'Outside' })

  const asked = await rig.api.perform('delete', { id: root.id }, agentContext(rig, 'deleter'))
  check('S5 delete asks first', asked.ok === false && asked.code === 'needs-decision' && asked.decision !== undefined, JSON.stringify(asked))
  const decision = asked.decision
  check('S5 the body reports the dependent count', decision.body.indexOf('被依赖：2 张卡') >= 0, decision.body)
  check('S5 the body renders the recursive tree', decision.body.indexOf('└─ ' + child.id) >= 0 && decision.body.indexOf(grandchild.id) >= 0 && decision.body.indexOf('   └─ ' + grandchild.id) >= 0, decision.body)
  check('S5 保留 is the default and 删除 is dangerous with dependents', decision.defaultOption === 'keep' && decision.highRisk === true && decision.options.filter((option) => option.id === 'delete')[0].danger === true, JSON.stringify(decision.options))
  check('S5 the safe default never points at the danger option', decision.autoRunAllowed === true && decision.options.filter((option) => option.default === true)[0].id === 'keep')

  const noWord = await rig.action('decisionAnswer', { decisionId: decision.id, option: 'delete' })
  check('S5 删除 without DELETE is refused', noWord.ok === false && noWord.code === 'confirmation-required', JSON.stringify(noWord))
  const stillThere = await rig.action('board')
  check('S5 the refused answer deleted nothing', stillThere.tasks.length === 4, String(stillThere.tasks.length))

  const chooseDelete = await rig.action('decisionAnswer', { decisionId: decision.id, option: 'delete', confirm: 'DELETE' })
  check('S5 删除 opens the high-risk dependency-tree confirmation', chooseDelete.ok === true && chooseDelete.applied.next !== null && chooseDelete.applied.next.eventKey === 'delete-tree', JSON.stringify(chooseDelete.applied))
  const second = chooseDelete.applied.next
  check('S5 the high-risk panel has the aligned title and count', second.title === '确认删除依赖树？' && second.body.indexOf('共 3 张') >= 0 && second.body.indexOf(outside.id) < 0, second.body)
  check('S5 the high-risk primary button names the count and is dangerous', second.options.filter((option) => option.id === 'purge')[0].label === '永久删除 3 张卡' && second.options.filter((option) => option.id === 'purge')[0].danger === true, JSON.stringify(second.options))
  check('S5 the high-risk default is 返回', second.defaultOption === 'return' && second.autoRunAllowed === true && second.options.filter((option) => option.default === true)[0].id === 'return')
  const purgeWithoutWord = await rig.action('decisionAnswer', { decisionId: second.id, option: 'purge' })
  check('S5 the purge needs the DELETE word too', purgeWithoutWord.ok === false && purgeWithoutWord.code === 'confirmation-required', JSON.stringify(purgeWithoutWord))
  const purged = await rig.action('decisionAnswer', { decisionId: second.id, option: 'purge', confirm: 'DELETE' })
  check('S5 the purge deletes the whole chain', purged.ok === true && purged.applied.executed === true && purged.applied.summary.deleted.join(',') === [grandchild.id, child.id, root.id].join(','), JSON.stringify(purged.applied.summary))
  const after = await rig.action('board')
  check('S5 only the unrelated card survives', after.tasks.length === 1 && after.tasks[0].id === outside.id, JSON.stringify(after.tasks.map((task) => task.id)))
  check('S5 the Agent is told what was permanently deleted', messages(agents).some((text) => text.indexOf('permanently deleted 3 card(s)') >= 0), JSON.stringify(messages(agents)))
}

// ── S6: cancel shows the impact; the 120s default is 返回 ───────────────────
{
  const { rig } = freshRig()
  const root = await userCreate(rig, { title: 'Running-ish root' })
  const child = await userCreate(rig, { title: 'Dependent', dependsOn: [root.id] })
  const asked = await rig.api.perform('cancel', { id: root.id }, agentContext(rig, 'canceller'))
  const decision = asked.decision
  check('S6 cancel asks with the state and the downstream impact', asked.ok === false && asked.code === 'needs-decision' && decision.body.indexOf('当前状态：pending') >= 0 && decision.body.indexOf('下游 1 张卡') >= 0, decision.body)
  check('S6 the downstream tree is rendered', decision.body.indexOf(child.id) >= 0, decision.body)
  check('S6 the options are 返回 (default) / 确认取消', decision.options.map((option) => option.label).join(',') === '返回,确认取消' && decision.defaultOption === 'return', JSON.stringify(decision.options))
  check('S6 the timeout default never auto-cancels', decision.autoRunAllowed === true && decision.options.filter((option) => option.default === true)[0].id === 'return')

  // The timeout keeps the card open.
  clockNow = START + 121000
  await rig.api.snapshot(PROJECT, { full: false })
  const untouched = await rig.action('get', { id: root.id })
  check('S6 the 120s default is 返回 and cancels nothing', untouched.task.status === 'pending', String(untouched.task.status))

  // A fresh request (the old one expired) can be confirmed.
  const again = await rig.api.perform('cancel', { id: root.id }, agentContext(rig, 'canceller'))
  const confirmed = await rig.action('decisionAnswer', { decisionId: again.decision.id, option: 'confirm' })
  check('S6 确认取消 cancels the card', confirmed.ok === true && confirmed.applied.summary.status === 'cancelled', JSON.stringify(confirmed.applied))
  const cancelled = await rig.action('get', { id: root.id })
  check('S6 the card is cancelled and the dependent was not deleted', cancelled.task.status === 'cancelled' && (await rig.action('get', { id: child.id })).task.status === 'pending', String(cancelled.task.status))
}

// ── S7: the panel role is the human: its own calls run straight through ────
{
  const { rig } = freshRig()
  const created = await rig.action('create', { title: 'Direct panel card' })
  check('S7 a role=user create writes immediately', created.ok === true && created.task !== null, JSON.stringify(created))
  const decisions = await rig.api.decisions.pending(PROJECT)
  check('S7 and asks no question', decisions.ok === true && decisions.pending.length === 0, JSON.stringify(decisions))
  const started = await rig.action('start', {})
  check('S7 a role=user start starts dispatch', started.ok === true && started.dispatch.state === 'running', JSON.stringify(started.dispatch))
}

// ── S8: validation comes BEFORE the question ───────────────────────────────
{
  const { rig } = freshRig()
  await userCreate(rig, { title: 'Existing' })
  const bad = await rig.api.perform('create', { title: 'Bad dependency', dependsOn: ['T-99'] }, agentContext(rig, 'bad'))
  check('S8 an invalid create refuses instead of asking', bad.ok === false && bad.code === 'unknown-dependency' && bad.decision === undefined, JSON.stringify(bad))
  const badReopen = await rig.api.perform('reopen', { id: 'T-404' }, agentContext(rig, 'bad'))
  check('S8 an unknown reopen target refuses instead of asking', badReopen.ok === false && badReopen.code === 'unknown-task', JSON.stringify(badReopen))
}

// ── S9: the destructive panels never delete on timeout ─────────────────────
{
  const { rig } = freshRig()
  const root = await userCreate(rig, { title: 'Timeout root' })
  await userCreate(rig, { title: 'Timeout child', dependsOn: [root.id] })
  const asked = await rig.api.perform('delete', { id: root.id }, agentContext(rig, 'timer-delete'))
  clockNow = START + 121000
  await rig.api.snapshot(PROJECT, { full: false })
  const board = await rig.action('board')
  check('S9 the delete timeout keeps the card and its dependents', board.tasks.length === 2, JSON.stringify(board.tasks.map((task) => task.id)))
  const listed = await rig.action('decisionList', { decisionStatus: 'all' })
  const expired = listed.decisions.filter((decision) => decision.id === asked.decision.id)[0]
  check('S9 the expired delete resolution is 保留', expired.status === 'expired' && expired.resolution.option === 'keep' && expired.resolution.via === 'timeout', JSON.stringify(expired.resolution))

  // The high-risk dependency-tree panel follows the same rule.
  const again = await rig.api.perform('delete', { id: root.id }, agentContext(rig, 'timer-delete'))
  const choose = await rig.action('decisionAnswer', { decisionId: again.decision.id, option: 'delete', confirm: 'DELETE' })
  check('S9 删除 opens the second stage', choose.ok === true && choose.applied.next !== null, JSON.stringify(choose.applied))
  clockNow = START + 400000
  await rig.api.snapshot(PROJECT, { full: false })
  const after = await rig.action('board')
  check('S9 the dependency-tree timeout never deletes', after.tasks.length === 2, JSON.stringify(after.tasks.map((task) => task.id)))
  const all = await rig.action('decisionList', { decisionStatus: 'all' })
  const tree = all.decisions.filter((decision) => decision.id === choose.applied.next.id)[0]
  check('S9 the expired tree resolution is 返回', tree.status === 'expired' && tree.resolution.option === 'return' && tree.resolution.via === 'timeout', JSON.stringify(tree.resolution))
}

console.log(failures === 0 ? '\nPASS  every gated action asks the human, executes once, and messages the Agent' : '\nFAIL  ' + String(failures) + ' action-decision check(s)')
process.exit(failures === 0 ? 0 : 1)
