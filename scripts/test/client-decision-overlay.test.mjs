// T-208 — the conversation-page shell.overlay entry for pending decisions.
//
// The task center registers a decision MODAL inside its own panel; this suite
// locks the second surface: a "待决策 N" chip in the session column's free
// corner that expands into a compact card over the SAME answer form, appears
// only while the queue is non-empty, advances one decision at a time, and never
// double-submits with the panel.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createDecisionOverlay } = require('../../client/src/views/decision-overlay.cjs')
const { createDecisionModal } = require('../../client/src/views/decision-modal.cjs')

function h(type, props, ...children) {
  return { type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) }
}
const React = {
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
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
  decisionOverlayChip: '待决策 {n}',
  decisionOverlayAria: '待处理的决策',
  decisionOverlayCollapse: '收起待决策卡片',
  error: '操作失败',
}
const t = (key) => (COPY[key] === undefined ? key : COPY[key])
const DecisionModal = createDecisionModal({ React: React, h: h })

function decision(overrides) {
  return Object.assign(
    {
      id: 'DEC-1',
      status: 'pending',
      eventKey: 'create',
      taskId: 'T-1',
      eventLabel: '创建任务',
      title: '创建任务 T-1？',
      body: '任务：Third card',
      options: [
        { id: 'create', label: '创建任务', description: '写入任务板', danger: false, default: true },
        { id: 'cancel', label: '取消创建', description: '', danger: false, default: false },
      ],
      defaultOption: 'create',
      highRisk: false,
      remainingMs: 120000,
      timeoutAt: '2026-11-19T00:02:00.000Z',
      autoRunAllowed: true,
    },
    overrides === undefined ? {} : overrides,
  )
}

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
function snapshotOf(queue) {
  return { decisions: queue, receivedAt: Date.now(), busy: null, source: 'host' }
}

function makeOverlay(store) {
  return createDecisionOverlay({
    React: React,
    h: h,
    DecisionModal: DecisionModal,
    store: store,
    useTranslate: () => t,
    useSnapshot: () => currentSnapshot,
    tcErrorMessage: (payload) => 'error:' + (payload !== null && payload !== undefined && typeof payload.code === 'string' ? payload.code : 'unknown'),
  })
}

let currentSnapshot = snapshotOf([])
let loads = 0
let sends = []
const store = {
  loadDecisions: async () => {
    loads += 1
    return { ok: true, decisions: [] }
  },
  send: async (action, body) => {
    sends.push({ action: action, body: body })
    return { ok: true, payload: { ok: true } }
  },
}
const Overlay = makeOverlay(store)

// ── pending 0: the entry does not exist at all ─────────────────────────────
{
  currentSnapshot = snapshotOf([])
  Overlay.state.open = false
  assert.equal(Overlay({}), null, 'no pending decision renders nothing, not an empty chip')
}
console.log('PASS  no pending decision -> no overlay entry')

// ── pending N: the chip shows the count and stays collapsed ────────────────
{
  currentSnapshot = snapshotOf([decision({ id: 'DEC-1' }), decision({ id: 'DEC-2', taskId: 'T-2' }), decision({ id: 'DEC-3', taskId: 'T-3' })])
  Overlay.state.open = false
  const out = Overlay({})
  assert.equal(out.props['data-decision-dock'], 'true')
  assert.equal(out.props['data-decision-pending'], '3', 'the chip carries the pending count')
  const chip = find(out, (node) => node.props && node.props['data-decision-chip'] === 'true')
  assert.ok(chip !== null, 'the chip is a real control')
  assert.equal(chip.props['aria-expanded'], 'false', 'the card starts collapsed')
  assert.equal(chip.props['aria-haspopup'], 'dialog')
  assert.ok(textOf(chip).includes('待决策 3'), 'the chip reads 待决策 N')
  assert.equal(find(out, (node) => node.props && node.props['data-decision-dock-panel'] === 'true'), null, 'collapsed renders no card')
}
console.log('PASS  pending N -> a 待决策 N chip, collapsed by default')

// ── expanded: one compact card over the shared decision form ───────────────
{
  Overlay.state.open = true
  const out = Overlay({})
  const panel = find(out, (node) => node.props && node.props['data-decision-dock-panel'] === 'true')
  assert.ok(panel !== null, 'expanding renders the docked card')
  assert.equal(panel.props.role, 'dialog')
  const card = find(out, (node) => node.type === DecisionModal.DecisionCard)
  assert.ok(card !== null, 'the card is the decision modal\'s own compact component')
  assert.equal(card.props.decision.id, 'DEC-1', 'the OLDEST pending decision is foregrounded')
  assert.equal(card.props.queueLeft, 2, 'the card knows how many decisions follow')
  assert.ok(Number.isFinite(card.props.receivedAt), 'the server receipt time feeds the countdown')
  const cardNode = card.type(card.props)
  const cardText = textOf(cardNode)
  assert.equal(cardNode.props['data-decision-id'], 'DEC-1')
  assert.ok(cardText.includes('创建任务 T-1？'), 'the headline is in the compact card')
  assert.ok(cardText.includes('任务：Third card'), 'the body is in the compact card')
  assert.ok(/\d+s 后自动选择「创建任务」/.test(cardText), 'the server countdown is in the compact card')
  assert.ok(cardText.includes('还有 2 个待决策'), 'the queue count is in the compact card')
  assert.equal(findAll(cardNode, (node) => node.props && node.props['data-decision-option'] !== undefined).length, 2)
  assert.ok(textOf(find(cardNode, (node) => node.props && node.props['data-decision-text'] !== undefined)).includes('修改建议（可选）'))
  assert.equal(find(cardNode, (node) => node.props && node.props['data-decision-open-task'] !== undefined), null, 'answering here never requires the plugin panel')
  assert.ok(find(cardNode, (node) => node.props && node.props['data-decision-collapse'] === 'true') !== null)
}
console.log('PASS  expanding shows the current decision\'s full form, no panel detour')

// ── the chip toggles the card ──────────────────────────────────────────────
{
  Overlay.state.open = false
  const collapsed = Overlay({})
  find(collapsed, (node) => node.props && node.props['data-decision-chip'] === 'true').props.onClick()
  assert.equal(Overlay.state.open, true, 'clicking the chip expands the card')
  Overlay.state.open = false
}
console.log('PASS  the chip toggles the docked card')

// ── answer -> decisionAnswer -> queue refresh -> next decision ────────────
{
  Overlay.state.open = true
  sends = []
  loads = 0
  currentSnapshot = snapshotOf([decision({ id: 'DEC-1' }), decision({ id: 'DEC-2', taskId: 'T-2', title: '创建任务 T-2？', options: [{ id: 'create', label: '创建任务', default: true }, { id: 'cancel', label: '取消创建' }] })])
  const out = Overlay({})
  const card = find(out, (node) => node.type === DecisionModal.DecisionCard)
  const cardNode = card.type(card.props)
  const confirm = find(cardNode, (node) => node.props && node.props['data-decision-confirm-submit'] === 'true')
  assert.equal(confirm.props.disabled, false)
  confirm.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(sends, [{ action: 'decisionAnswer', body: { decisionId: 'DEC-1', option: 'create' } }], 'the answer goes through the shared store, exactly once')
  assert.equal(loads, 1, 'a successful answer refreshes the queue immediately')
  // The Host drops the answered request; the next render foregrounds DEC-2.
  currentSnapshot = snapshotOf([decision({ id: 'DEC-2', taskId: 'T-2', title: '创建任务 T-2？' })])
  const next = Overlay({})
  const nextCard = find(next, (node) => node.type === DecisionModal.DecisionCard)
  assert.equal(nextCard.props.decision.id, 'DEC-2', 'the next decision is shown automatically')
  assert.equal(nextCard.props.queueLeft, 0)
  assert.ok(textOf(next).includes('待决策 1'), 'the chip count follows the queue')
}
console.log('PASS  answering advances the queue to the next decision')

// ── a duplicate answer (the panel modal got there first) is not an error ──
{
  Overlay.state.open = true
  loads = 0
  const duplicateStore = {
    loadDecisions: async () => {
      loads += 1
      return { ok: true, decisions: [] }
    },
    send: async () => ({ ok: false, duplicate: true, payload: { ok: false, code: 'already-answered' } }),
  }
  const DupOverlay = makeOverlay(duplicateStore)
  DupOverlay.state.open = true
  currentSnapshot = snapshotOf([decision({ id: 'DEC-5' })])
  const out = DupOverlay({})
  const card = find(out, (node) => node.type === DecisionModal.DecisionCard)
  const cardNode = card.type(card.props)
  find(cardNode, (node) => node.props && node.props['data-decision-confirm-submit'] === 'true').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(loads, 1, 'the duplicate still refreshes the queue instead of raising a banner')
}
console.log('PASS  a duplicate submission is absorbed by the shared store')

// ── pending 0 collapses the card again ─────────────────────────────────────
{
  Overlay.state.open = true
  currentSnapshot = snapshotOf([])
  assert.equal(Overlay({}), null)
}
console.log('PASS  an emptied queue hides the whole entry')

// ── placement: the chip is lifted above a docked composer ─────────────────
{
  const FakeOverlay = Overlay.computePlacement
  function node(attrs, rect, parent) {
    const element = {
      parentElement: parent === undefined ? null : parent,
      getAttribute: (name) => (attrs[name] === undefined ? null : attrs[name]),
      getBoundingClientRect: () => rect,
      children: [],
      closest: () => null,
      querySelector: () => null,
    }
    return element
  }
  const layerRect = { left: 0, top: 0, right: 1200, bottom: 900, width: 1200, height: 900 }
  const frame = node({}, layerRect)
  const layer = node({ 'data-shell-overlay': '' }, layerRect)
  layer.parentElement = frame
  const sidebar = node({}, { left: 0, top: 0, right: 260, bottom: 900, width: 260, height: 900 })
  const center = node({}, { left: 260, top: 0, right: 1200, bottom: 900, width: 940, height: 900 })
  const composer = node({ 'data-composer-card': '' }, { left: 300, top: 760, right: 1160, bottom: 884, width: 860, height: 124 })
  composer.closest = () => ({ getAttribute: () => 'active' })
  frame.children = [sidebar, center]
  center.querySelector = () => composer
  const outlet = node({}, layerRect)
  outlet.parentElement = layer
  const root = node({}, { left: 1200, top: 800, right: 1200, bottom: 830, width: 0, height: 30 })
  root.parentElement = outlet
  const placed = FakeOverlay(root)
  assert.equal(placed.right, 12, 'the chip hugs the centre column\'s inline end')
  assert.equal(placed.bottom, 152, 'it sits 12px above the docked composer instead of over the input')
  assert.ok(placed.maxHeight <= 520 && placed.maxHeight > 160, 'the card is capped to the space above the chip')
  // The hero keeps the corner: its composer is centred, not docked.
  composer.closest = () => ({ getAttribute: () => 'hero' })
  assert.equal(FakeOverlay(root).bottom, 16, 'the hero composer is not covered from the corner')
  // No measurable layer (tests / detached mounts) -> no inline placement.
  assert.equal(FakeOverlay(null), null)
}
console.log('PASS  the entry is lifted above a docked composer and keeps the hero corner')

// ── 40-tail registers the shell.overlay list entry ─────────────────────────
{
  const TAIL = readFileSync(new URL('../../client/src/40-tail.part', import.meta.url), 'utf8')
  const SHELL = readFileSync(new URL('../../client/src/36-views-shell.part', import.meta.url), 'utf8')
  const HEAD = readFileSync(new URL('../../client/src/00-head.part', import.meta.url), 'utf8')
  const bundle = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
  assert.ok(TAIL.includes("ctx.slots.inject('shell.overlay'"), 'the overlay is gated on the host offering the slot')
  assert.ok(
    /ctx\.slots\.register\(\s*\{\s*name: 'shell\.overlay',\s*id: 'godot-bridge-decisions',\s*order: 120,\s*locale: TC_NS,?\s*\},\s*views\.DecisionOverlay,?/.test(TAIL),
    'the slot receives the overlay view with its own id, order and the task-center locale',
  )
  assert.ok(TAIL.includes("name: 'main', key: 'task-center'"), 'the task center panel registration is untouched')
  assert.ok(SHELL.includes('DecisionOverlay: DecisionOverlay'), 'the views factory exposes the overlay')
  assert.ok(bundle.includes("name: 'shell.overlay'"), 'the shipped bundle registers the slot')
  assert.ok(bundle.includes("id: 'godot-bridge-decisions'"))
  assert.ok(bundle.includes('views.DecisionOverlay'), 'the shipped bundle mounts the view module')
  assert.ok(bundle.includes('data-decision-chip'), 'the shipped bundle carries the chip')
  assert.ok(bundle.includes('gbt-decisiondock'), 'the shipped bundle carries the placement CSS')
  // Both locale blocks carry the new copy (client-bundle.test enforces parity).
  assert.ok(HEAD.includes("decisionOverlayChip: '待决策 {n}'"))
  assert.ok(HEAD.includes("decisionOverlayChip: '{n} pending'"))
  // The chip is a real themed control, not a hard-coded colour.
  assert.ok(HEAD.includes('.gbt-chipbtn.gbt-decisionchip{border-color:var(--dsw-alias-state-warn-primary)'), 'the chip out-ranks the shared chip button and uses the host tokens')
  assert.ok(bundle.includes('store.loadDecisions'), 'the shipped bundle polls the decision list')
}
console.log('PASS  40-tail + the shipped bundle register the shell.overlay decision entry')

console.log('\nPASS  the conversation page answers pending decisions without opening the panel')
