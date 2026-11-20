// T-195 — the DecisionRequest modal view.
//
// The modal is generic: event-specific copy arrives as eventLabel/title/body.
// These checks lock the requirement packet's COMMON modal: title, task/event
// subtitle, server countdown, queue count, default badge, custom text, the
// high-risk DELETE input, and the one-shot answer callback.

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDecisionModal } = require('../../client/src/views/decision-modal.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const React = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}
const COPY = {
  decisionTitle: '关键决策',
  decisionSubtitleFallback: '关键事件',
  decisionCountdown: '{seconds}s 后自动选择「{defaultLabel}」',
  decisionNoCountdown: '不会自动选择',
  decisionCountdownProtected: '{seconds}s 后超时，不会自动执行「{defaultLabel}」（该选项需人工确认）',
  decisionCountdownProtectedNoDefault: '{seconds}s 后超时，不会自动选择',
  decisionCreateTextPlaceholder: '修改建议（可选）',
  decisionQueue: '还有 {n} 个待决策',
  decisionDefaultBadge: '默认',
  decisionTextLabel: '自定义文本',
  decisionTextPlaceholder: '可补充说明（可选）',
  decisionConfirm: '确认',
  decisionAnswering: '正在提交…',
  decisionHighRiskLabel: '输入 DELETE 确认',
  decisionHighRiskHint: '此操作不可恢复；输入 DELETE 后才能确认。',
  decisionOpenTask: '查看卡片详情',
}
const t = (key) => (COPY[key] === undefined ? key : COPY[key])
const DecisionModal = createDecisionModal({ React: React, h: h })

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit))
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.props ? node.props.children : null, visit)
}
function find(node, predicate) {
  let found = null
  walk(node, (entry) => {
    if (found === null && predicate(entry)) found = entry
  })
  return found
}
function findAll(node, predicate) {
  const found = []
  walk(node, (entry) => {
    if (predicate(entry)) found.push(entry)
  })
  return found
}
function textOf(node) {
  return JSON.stringify(node)
}

function decision(overrides) {
  return Object.assign(
    {
      id: 'DEC-1',
      status: 'pending',
      eventKey: 'create',
      taskId: 'T-184',
      eventLabel: '创建任务',
      title: '创建任务 T-184？',
      body: '任务：Third card',
      options: [
        { id: 'create', label: '创建任务', description: '写入任务板并加入待办队列', danger: false, default: true },
        { id: 'cancel', label: '取消创建', description: '', danger: false, default: false },
      ],
      defaultOption: 'create',
      highRisk: false,
      requiresText: false,
      remainingMs: 120000,
      timeoutAt: '2026-11-19T00:02:00.000Z',
      resolution: null,
    },
    overrides === undefined ? {} : overrides,
  )
}

// ── common modal copy: title, subtitle, countdown, queue, default ────────────
{
  const queue = [
    decision({ id: 'DEC-1' }),
    decision({ id: 'DEC-2', taskId: 'T-185', eventLabel: '评审超时', title: 'T-185 评审超时' }),
    decision({ id: 'DEC-3', taskId: 'T-186', eventLabel: '取消任务', title: '取消 T-186？' }),
  ]
  const out = DecisionModal({ t: t, queue: queue, receivedAt: Date.now(), onAnswer: () => {}, onOpenTask: () => {} })
  const text = textOf(out)
  assert.equal(out.props['data-decision-overlay'], 'true')
  assert.equal(out.props.children.props['data-decision-id'], 'DEC-1')
  assert.ok(text.includes('关键决策'), 'the common title is 关键决策')
  assert.ok(text.includes('T-184 · 创建任务'), 'the subtitle is taskId · eventLabel')
  assert.ok(/\d+s 后自动选择「创建任务」/.test(text), 'the countdown names the default option')
  assert.ok(text.includes('还有 2 个待决策'), 'the queue shows the remaining count')
  assert.ok(text.includes('查看卡片详情'), 'the card entry is present for a task-bound decision')
  assert.ok(text.includes('默认'), 'the default option is visibly marked')
  assert.ok(text.includes('创建任务 T-184？'), 'the event headline is rendered')
  assert.ok(text.includes('任务：Third card'), 'the event body is rendered')
  assert.equal(findAll(out, (node) => node.props && node.props['data-decision-option'] !== undefined).length, 2)
  const selected = find(out, (node) => node.props && node.props['data-decision-option'] === 'create')
  assert.equal(selected.props['data-selected'], 'true', 'the default option starts selected')
  assert.equal(find(out, (node) => node.props && node.props['data-decision-text'] !== undefined).props.placeholder, '修改建议（可选）', 'the create panel asks for a revision note')
  console.log('PASS  the generic modal renders the common copy (title, subtitle, countdown, queue, default, card entry, text)')
}

// ── one-shot answer callback carries the chosen option ──────────────────────
{
  const answers = []
  const opened = []
  const out = DecisionModal({
    t: t,
    queue: [decision()],
    receivedAt: Date.now(),
    onAnswer: (entry, answer) => answers.push({ id: entry.id, answer: answer }),
    onOpenTask: (id) => opened.push(id),
  })
  const confirm = find(out, (node) => node.props && node.props['data-decision-confirm-submit'] === 'true')
  assert.equal(confirm.props.disabled, false, 'a safe default may be confirmed immediately')
  confirm.props.onClick()
  assert.deepEqual(answers, [{ id: 'DEC-1', answer: { option: 'create', text: '', confirm: '' } }])
  const open = find(out, (node) => node.props && node.props['data-decision-open-task'] === 'true')
  assert.equal(open.props.onClick !== undefined, true, 'the card entry is clickable')
  open.props.onClick()
  assert.deepEqual(opened, ['T-184'], 'the card entry opens the card')
  console.log('PASS  confirming answers once with the selected option')
}

// ── countdown comes from the server remainingMs ─────────────────────────────
{
  assert.equal(DecisionModal.decisionRemainingSeconds(decision({ remainingMs: 120000 }), 1000, 1000), 120)
  assert.equal(DecisionModal.decisionRemainingSeconds(decision({ remainingMs: 120000 }), 1000, 61000), 60)
  assert.equal(DecisionModal.decisionRemainingSeconds(decision({ remainingMs: 500 }), 1000, 8000), 0, 'an elapsed deadline clamps at zero')
  assert.equal(DecisionModal.decisionRemainingSeconds(decision({ remainingMs: null }), 1000, 2000), null)
  const noTimeout = textOf(DecisionModal({ t: t, queue: [decision({ remainingMs: null, timeoutAt: null })], receivedAt: Date.now() }))
  assert.ok(noTimeout.includes('不会自动选择'), 'no deadline renders the no-auto-choice sentence')
  assert.ok(DecisionModal.decisionCountdownText(decision({ remainingMs: 120000 }), 1000, 1000, t).includes('120s'), 'exact seconds')
  assert.equal(DecisionModal.decisionSubtitle(decision(), t), 'T-184 · 创建任务')
  assert.equal(DecisionModal.decisionSubtitle(decision({ taskId: null, eventLabel: '' }), t), '关键事件')
  console.log('PASS  the countdown is computed from the server deadline and the receipt time')
}

// ── T-196: the countdown never promises an auto-run the server refuses ─────
{
  const dangerDefault = decision({
    id: 'DEC-12',
    eventKey: 'delete',
    title: '删除 T-184？',
    options: [
      { id: 'keep', label: '保留', danger: false, default: false },
      { id: 'delete', label: '删除', danger: true, default: true },
    ],
    defaultOption: 'delete',
    highRisk: true,
    remainingMs: 120000,
    autoRunAllowed: false,
  })
  const text = textOf(DecisionModal({ t: t, queue: [dangerDefault], receivedAt: Date.now(), onAnswer: () => {} }))
  assert.ok(text.includes('不会自动执行「删除」'), 'a protected danger default is named as not auto-run')
  assert.equal(/\d+s 后自动选择「删除」/.test(text), false, 'the modal never promises the danger auto-selection')
  assert.equal(DecisionModal.decisionAutoRunAllowed(dangerDefault), false)
  assert.ok(DecisionModal.decisionCountdownText(dangerDefault, Date.now(), Date.now(), t).includes('不会自动执行「删除」'), 'the protected sentence replaces the promise')
  // The server policy is authoritative even when the option itself looks safe.
  const held = decision({
    id: 'DEC-13',
    eventKey: 'dispatch',
    defaultOption: 'hold',
    remainingMs: 300000,
    autoRunAllowed: false,
    options: [
      { id: 'approve', label: '批准派发' },
      { id: 'hold', label: '暂不派发', default: true },
    ],
  })
  assert.equal(DecisionModal.decisionAutoRunAllowed(held), false)
  assert.ok(DecisionModal.decisionCountdownText(held, 1000, 1000, t).includes('不会自动执行「暂不派发」'))
  // No server field: judge from the decision itself.
  assert.equal(DecisionModal.decisionAutoRunAllowed(decision({ timeoutAt: '2026-11-19T00:02:00.000Z' })), true)
  assert.equal(DecisionModal.decisionAutoRunAllowed(decision({ remainingMs: null, timeoutAt: null })), false)
  const noDeadline = textOf(DecisionModal({ t: t, queue: [decision({ remainingMs: null, timeoutAt: null })], receivedAt: Date.now() }))
  assert.ok(noDeadline.includes('不会自动选择'))
  // A deadline with no default at all: the protected sentence without a label.
  const noDefault = decision({ id: 'DEC-14', defaultOption: null, options: [{ id: 'a', label: 'A' }], remainingMs: 60000, autoRunAllowed: false })
  assert.ok(DecisionModal.decisionCountdownText(noDefault, 1000, 1000, t).includes('不会自动选择'))
  console.log('PASS  the countdown follows the server auto-run policy and never promises a protected option')
}

// ── T-196: only the create panel asks for a revision note ──────────────────
{
  const cancelDecision = decision({ id: 'DEC-15', eventKey: 'cancel', title: '取消 T-184？' })
  const out = DecisionModal({ t: t, queue: [cancelDecision], receivedAt: Date.now() })
  assert.equal(find(out, (node) => node.props && node.props['data-decision-text'] !== undefined).props.placeholder, '可补充说明（可选）')
  console.log('PASS  only the create panel uses the revision-note placeholder')
}

// ── high-risk action requires the exact DELETE word ─────────────────────────
{
  const dangerous = decision({
    id: 'DEC-9',
    eventKey: 'delete-tree',
    title: '确认删除依赖树？',
    highRisk: true,
    options: [
      { id: 'purge', label: '永久删除 3 张卡', description: '不可恢复', danger: true, default: true },
      { id: 'return', label: '返回', description: '', danger: false, default: false },
    ],
    defaultOption: 'purge',
  })
  const out = DecisionModal({ t: t, queue: [dangerous], receivedAt: Date.now(), onAnswer: () => {} })
  const text = textOf(out)
  assert.ok(find(out, (node) => node.props && node.props['data-decision-highrisk'] === 'true') !== null, 'the high-risk block renders for a destructive selection')
  assert.ok(text.includes('输入 DELETE 确认'))
  assert.ok(text.includes('此操作不可恢复；输入 DELETE 后才能确认。'))
  const confirm = find(out, (node) => node.props && node.props['data-decision-confirm-submit'] === 'true')
  assert.equal(confirm.props.disabled, true, 'the destructive action starts disabled')
  assert.equal(confirm.props['data-decision-can-confirm'], 'false')
  assert.equal(DecisionModal.decisionCanConfirm(dangerous, 'purge', '', ''), false)
  assert.equal(DecisionModal.decisionCanConfirm(dangerous, 'purge', '', 'delete'), false, 'the word is case-sensitive')
  assert.equal(DecisionModal.decisionCanConfirm(dangerous, 'purge', '', 'DELETE'), true)
  assert.equal(DecisionModal.decisionCanConfirm(dangerous, 'return', '', ''), true, 'a safe option needs no word')
  assert.equal(DecisionModal.CONFIRM_WORD, 'DELETE')
  console.log('PASS  the high-risk option stays disabled until DELETE is typed')
}

// ── text-only decisions and disabled submit ─────────────────────────────────
{
  const textOnly = decision({ id: 'DEC-11', options: [], defaultOption: null, requiresText: true })
  const out = DecisionModal({ t: t, queue: [textOnly], receivedAt: Date.now(), onAnswer: () => {} })
  const confirm = find(out, (node) => node.props && node.props['data-decision-confirm-submit'] === 'true')
  assert.equal(confirm.props.disabled, true, 'a text-only question cannot be confirmed empty')
  assert.equal(DecisionModal.decisionInitialOption(textOnly), null)
  assert.equal(DecisionModal.decisionCanConfirm(textOnly, null, '   ', ''), false)
  assert.equal(DecisionModal.decisionCanConfirm(textOnly, null, 'move it to Friday', ''), true)
  const empty = DecisionModal({ t: t, queue: [], receivedAt: Date.now() })
  assert.equal(empty, null, 'an empty queue renders nothing')
  console.log('PASS  a text-only decision needs text before confirming')
}


// ── T-208: the compact shell-overlay card is the SAME form ──────────────────
{
  assert.equal(typeof DecisionModal.DecisionCard, 'function', 'the compact card is exposed for the shell overlay')
  const answers = []
  const dismissals = []
  const compact = DecisionModal.DecisionCard({
    t: t,
    decision: decision({ id: 'DEC-20', taskId: 'T-200', title: '创建任务 T-200？' }),
    queueLeft: 2,
    receivedAt: Date.now(),
    onAnswer: (entry, answer) => answers.push({ id: entry.id, answer: answer }),
    onDismiss: () => dismissals.push(1),
  })
  const text = textOf(compact)
  assert.equal(compact.props['data-decision-card'], 'true')
  assert.equal(compact.props['data-decision-id'], 'DEC-20')
  assert.ok(text.includes('关键决策'), 'the card carries the common title')
  assert.ok(text.includes('T-200 · 创建任务'), 'the card carries the task/event subtitle')
  assert.ok(/\d+s 后自动选择「创建任务」/.test(text), 'the card carries the server countdown')
  assert.ok(text.includes('还有 2 个待决策'), 'the card carries the queue count')
  assert.ok(text.includes('创建任务 T-200？'), 'the card carries the headline')
  assert.ok(text.includes('任务：Third card'), 'the card carries the body')
  assert.equal(findAll(compact, (node) => node.props && node.props['data-decision-option'] !== undefined).length, 2)
  assert.ok(text.includes('默认'), 'the default option is marked')
  assert.equal(find(compact, (node) => node.props && node.props['data-decision-open-task'] !== undefined), null, 'the compact card does not push the user to the panel')
  const collapse = find(compact, (node) => node.props && node.props['data-decision-collapse'] === 'true')
  assert.ok(collapse !== null, 'the card can be put away without answering')
  collapse.props.onClick()
  assert.deepEqual(dismissals, [1])
  const confirm = find(compact, (node) => node.props && node.props['data-decision-confirm-submit'] === 'true')
  assert.equal(confirm.props.disabled, false)
  confirm.props.onClick()
  assert.deepEqual(answers, [{ id: 'DEC-20', answer: { option: 'create', text: '', confirm: '' } }])
  const errorCard = DecisionModal.DecisionCard({ t: t, decision: decision(), onAnswer: () => {}, error: '网络错误' })
  assert.ok(textOf(errorCard).includes('网络错误'), 'a failed answer is visible inside the card')
  assert.ok(find(errorCard, (node) => node.props && node.props['data-decision-error'] === 'true') !== null)
  const busyCard = DecisionModal.DecisionCard({ t: t, decision: decision(), onAnswer: () => {}, busy: true })
  const busyConfirm = find(busyCard, (node) => node.props && node.props['data-decision-confirm-submit'] === 'true')
  assert.equal(busyConfirm.props.disabled, true, 'a submission in flight cannot be repeated')
  assert.ok(textOf(busyCard).includes('正在提交…'))
  assert.equal(DecisionModal.DecisionCard({ t: t, decision: null }), null, 'no decision renders nothing')
}
console.log('PASS  the compact card reuses the modal form, answers once and can be collapsed')

// ── T-208: the shared answer body ───────────────────────────────────────────
{
  assert.deepEqual(
    DecisionModal.decisionAnswerPayload(decision({ id: 'DEC-30' }), { option: 'create', text: '', confirm: '' }),
    { decisionId: 'DEC-30', option: 'create' },
    'empty text/confirm fields are not posted',
  )
  assert.deepEqual(
    DecisionModal.decisionAnswerPayload(decision({ id: 'DEC-31' }), { option: 'purge', text: 'why', confirm: 'DELETE' }),
    { decisionId: 'DEC-31', option: 'purge', text: 'why', confirm: 'DELETE' },
  )
  assert.deepEqual(DecisionModal.decisionAnswerPayload(decision({ id: 'DEC-32' }), { option: null, text: 'do it' }), { decisionId: 'DEC-32', option: null, text: 'do it' }, 'a text-only answer keeps the null option')
}
console.log('PASS  the panel modal and the shell overlay post the same answer body')

// ── the panel shell mounts the queue (integration) ──────────────────────────
{
  const { createTaskCenter } = require('../../client/src/views/task-center.cjs')
  const { tcAgentTreeOf, tcAgentStatusKey } = require('../../client/src/selectors.cjs')
  const view = (name) => (props) => ({ type: name, props: props })
  const snapshot = {
    source: 'host',
    project: '/repo',
    projectRoot: '/repo',
    sessionProject: '/repo',
    message: '',
    dispatch: { state: 'paused', maxConcurrent: 3, defaultTarget: '' },
    counts: { pending: 0 },
    tasks: [],
    queue: [],
    details: {},
    locks: [],
    agentTree: { available: false, root: null, members: [], count: 0, error: null },
    scope: { panelSession: null, sessionSummaries: [] },
    roles: null,
    worktrees: null,
    environment: null,
    boardSize: null,
    archivedCount: 0,
    archiveRange: null,
    scheduler: null,
    activity: { entries: [] },
    lastSweep: null,
    // T-196: a real host action decision has the create panel copy and a safe
    // auto-run policy; the shell must render it as-is.
    decisions: [
      decision({
        id: 'DEC-7',
        taskId: 'T-190',
        eventKey: 'create',
        eventLabel: '创建任务',
        title: '创建任务 T-190？',
        body: '任务：Third card\n类型：dev\n目标：默认\n依赖：无\n写入文件：无\n验收：npm test',
        autoRunAllowed: true,
        remainingMs: 120000,
      }),
    ],
    receivedAt: Date.now(),
  }
  const TaskCenter = createTaskCenter({
    React: React,
    h: h,
    Board: view('board'),
    QueueView: view('queue'),
    WorkersView: view('workers'),
    StatusView: view('status'),
    RolesView: view('roles'),
    DetailView: view('detail'),
    DoneAllDrawer: view('done-all'),
    TaskForm: view('task-form'),
    SettingsForm: view('settings-form'),
    ProjectForm: view('project-form'),
    DecisionModal: DecisionModal,
    useTranslate: () => t,
    useSnapshot: () => snapshot,
    useNow: () => 1000,
    panelState: { view: 'board', selectedId: null, doneAllOpen: false, doneAllArchived: false },
    projectFormState: { value: null },
    doneAllReset: () => {},
    projectMismatchOf: () => null,
    projectSourceKey: () => 'session',
    projectSourceLabel: () => 'session',
    tcAgo: () => 'now',
    tcAgentTreeOf: tcAgentTreeOf,
    tcAgentStatusKey: tcAgentStatusKey,
    roleKindLabel: (kind) => kind,
    copyToClipboard: async () => true,
    store: { send: async () => ({ ok: true }), startPolling: () => {}, stopPolling: () => {}, switchProject: async () => ({ ok: true }), loadDetail: async () => ({ ok: true }) },
  })
  const shell = TaskCenter({})
  const kids = Array.isArray(shell.props.children) ? shell.props.children : [shell.props.children]
  const mounted = kids.filter((child) => child !== null && child !== undefined && child.type === DecisionModal)[0]
  assert.ok(mounted !== undefined, 'the panel shell mounts the decision modal when a decision is pending')
  assert.equal(mounted.props.queue[0].id, 'DEC-7', 'the foregrounded decision is the oldest pending one')
  assert.equal(typeof mounted.props.onAnswer, 'function', 'the shell wires the answer callback')
  assert.equal(typeof mounted.props.onOpenTask, 'function', 'the shell wires the card entry')
  const modal = DecisionModal(mounted.props)
  const modalText = textOf(modal)
  assert.ok(modalText.includes('data-decision-overlay'))
  assert.ok(modalText.includes('关键决策'))
  assert.ok(modalText.includes('T-190 · 创建任务'))
  assert.ok(modalText.includes('查看卡片详情'))
  assert.ok(modalText.includes('创建任务 T-190？'), 'the create question headline is rendered')
  assert.ok(modalText.includes('任务：Third card') && modalText.includes('验收：npm test'), 'the create field list is rendered')
  assert.ok(modalText.includes('修改建议（可选）'), 'the create panel asks for the revision note')
  assert.ok(/\d+s 后自动选择「创建任务」/.test(modalText), 'the safe create default is announced as auto-run')
  console.log('PASS  the task-center shell mounts the decision queue modal with the T-196 create panel')
}

console.log('\nPASS  the decision modal renders the packet common copy and one-shot answer flow')
