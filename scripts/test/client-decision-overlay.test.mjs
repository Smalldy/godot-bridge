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
const { createTaskStore } = require('../../client/src/store.cjs')
const { createTaskCenter } = require('../../client/src/views/task-center.cjs')
const { tcAgentTreeOf, tcAgentStatusKey } = require('../../client/src/selectors.cjs')

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

// ── T-211: empty -> pending -> answered -> a LATER pending stays visible ───
{
  const Later = makeOverlay(store)
  Later.state.open = false
  currentSnapshot = snapshotOf([])
  assert.equal(Later({}), null, 'an empty queue renders nothing at all')
  currentSnapshot = snapshotOf([decision({ id: 'DEC-L1' })])
  const firstPending = Later({})
  assert.equal(firstPending.props['data-decision-overlay'], 'dock', 'the overlay exposes its visibility marker')
  assert.equal(firstPending.props['data-decision-pending'], '1', 'the marker carries the pending count')
  assert.ok(textOf(firstPending).includes('待决策 1'))
  // The user answers; the Host drops the request and the entry disappears.
  currentSnapshot = snapshotOf([])
  assert.equal(Later({}), null, 'answering the last decision removes the entry again')
  // A LATER decision arrives and must be visible again, collapsed by default.
  currentSnapshot = snapshotOf([decision({ id: 'DEC-L2', taskId: 'T-2', title: '创建任务 T-2？' })])
  const laterPending = Later({})
  assert.equal(laterPending.props['data-decision-overlay'], 'dock')
  assert.equal(laterPending.props['data-decision-pending'], '1')
  assert.equal(find(laterPending, (node) => node.props && node.props['data-decision-dock-panel'] === 'true'), null, 'a later decision does not pop the card open by itself')
  // Two pendings in a row: the count follows the host queue, still collapsed.
  currentSnapshot = snapshotOf([decision({ id: 'DEC-L2', taskId: 'T-2' }), decision({ id: 'DEC-L3', taskId: 'T-3' })])
  const twoPending = Later({})
  assert.equal(twoPending.props['data-decision-pending'], '2')
  assert.equal(find(twoPending, (node) => node.props && node.props['data-decision-dock-panel'] === 'true'), null)
  assert.ok(textOf(twoPending).includes('待决策 2'))
}
console.log('PASS  T-211 empty -> pending -> answer -> later pending keeps the entry visible and collapsed')

// ── T-211: a 637px-high window keeps the chip and the card on screen ───────
{
  function node(attrs, rect, parent) {
    return {
      parentElement: parent === undefined ? null : parent,
      getAttribute: (name) => (attrs[name] === undefined ? null : attrs[name]),
      getBoundingClientRect: () => rect,
      children: [],
      closest: () => null,
      querySelector: () => null,
    }
  }
  const layerRect = { left: 0, top: 64, right: 1200, bottom: 700, width: 1200, height: 636 }
  const frame = node({}, layerRect)
  const layer = node({ 'data-shell-overlay': '' }, layerRect)
  layer.parentElement = frame
  const sidebar = node({}, { left: 0, top: 64, right: 260, bottom: 700, width: 260, height: 636 })
  const center = node({}, { left: 260, top: 64, right: 1200, bottom: 700, width: 940, height: 636 })
  const composer = node({ 'data-composer-card': '' }, { left: 300, top: 520, right: 1160, bottom: 636, width: 860, height: 116 })
  composer.closest = () => ({ getAttribute: () => 'hero' })
  center.querySelector = () => composer
  frame.children = [sidebar, center]
  const outlet = node({}, layerRect)
  outlet.parentElement = layer
  const root = node({}, { left: 1200, top: 640, right: 1200, bottom: 670, width: 0, height: 30 })
  root.parentElement = outlet
  globalThis.window = { innerWidth: 1200, innerHeight: 637 }
  try {
    // The layer starts below the shell header and runs past the window bottom:
    // the old layer-only math anchored the 16px chip at y=684, i.e. off-screen.
    const hero = Overlay.computePlacement(root)
    assert.ok(hero !== null, 'the entry has a placement in the short window')
    const heroChipBottom = layerRect.bottom - hero.bottom
    assert.ok(heroChipBottom <= 637 - 12, 'the chip stays inside the visual viewport, not below it (' + heroChipBottom + ')')
    const heroCardTop = heroChipBottom - Overlay.CHIP_HEIGHT - 8 - hero.maxHeight
    assert.ok(heroCardTop >= 64 + 12, 'the measured max-height keeps the card top inside the visible layer (' + heroCardTop + ')')
    assert.ok(hero.maxHeight >= 160 && hero.maxHeight <= Overlay.PANEL_MAX)
    // Docked composer: the entry is lifted above the input AND still fits.
    composer.closest = () => ({ getAttribute: () => 'active' })
    const docked = Overlay.computePlacement(root)
    const dockedChipBottom = layerRect.bottom - docked.bottom
    assert.ok(docked.bottom > hero.bottom, 'a docked composer lifts the entry above the input')
    assert.ok(dockedChipBottom <= 520 - 12, 'the chip sits above the docked composer (' + dockedChipBottom + ')')
    const dockedCardTop = dockedChipBottom - Overlay.CHIP_HEIGHT - 8 - docked.maxHeight
    assert.ok(dockedCardTop >= 64 + 12, 'the docked card still fits inside the visible layer (' + dockedCardTop + ')')
    assert.ok(docked.maxHeight >= 160)
  } finally {
    delete globalThis.window
  }
}
console.log('PASS  T-211 a 637px-high window keeps the chip and the whole card on screen (hero + docked)')

// ── T-211: one-shot attention for a NEW pending decision ───────────────────
{
  const mode = Overlay.attentionModeFor
  assert.equal(mode(0, 1, { plays: 0 }), 'play')
  assert.equal(mode(1, 2, { plays: 0 }), 'play', 'any increase is a new arrival')
  assert.equal(mode(null, 1, { plays: 0 }), null, 'a first paint with a queue is not an arrival')
  assert.equal(mode(3, 2, { plays: 0 }), null, 'answering a decision never animates')
  assert.equal(mode(0, 1, { plays: 1 }), 'play')
  assert.equal(mode(0, 1, { plays: Overlay.ATTENTION_LIMIT }), null, 'at most two pulses')
  assert.equal(mode(0, 1, { open: true }), 'static', 'an open card gets the static highlight only')
  assert.equal(mode(0, 1, { reducedMotion: true }), 'static', 'reduced motion gets the static highlight only')
  assert.equal(mode(0, 1, { hidden: true }), null, 'a hidden tab never triggers')
  assert.equal(Overlay.ATTENTION_MS, 600)

  const plainStore = { loadDecisions: async () => ({ ok: true, decisions: [] }), send: async () => ({ ok: true }) }
  const Attn = makeOverlay(plainStore)
  Attn.state.open = false
  Attn.state.seenCount = null
  Attn.state.attention = null
  Attn.state.attentionPlays = 0
  delete globalThis.window
  currentSnapshot = snapshotOf([])
  assert.equal(Attn({}), null)
  currentSnapshot = snapshotOf([decision({ id: 'DEC-A1' })])
  const arrival = Attn({})
  assert.equal(arrival.props['data-decision-attention'], 'play', 'a new pending decision pulses the chip')
  assert.equal(Attn.state.attentionPlays, 1)
  const chip = find(arrival, (node) => node.props && node.props['data-decision-chip'] === 'true')
  assert.equal(chip.props['data-decision-attention'], 'play', 'the chip carries the marker too')
  // A poll re-render at the same count must not replay.
  const repeated = Attn({})
  assert.equal(repeated.props['data-decision-attention'], 'play')
  assert.equal(Attn.state.attentionPlays, 1, 'a re-render is not a new arrival')
  // The queue grows: the second and LAST pulse.
  currentSnapshot = snapshotOf([decision({ id: 'DEC-A1' }), decision({ id: 'DEC-A2', taskId: 'T-2' })])
  const grown = Attn({})
  assert.equal(grown.props['data-decision-attention'], 'play')
  assert.equal(Attn.state.attentionPlays, 2)
  // A third arrival is silent: the budget is spent.
  Attn.clearAttention()
  currentSnapshot = snapshotOf([decision({ id: 'DEC-A2', taskId: 'T-2' })])
  Attn({})
  Attn.clearAttention()
  currentSnapshot = snapshotOf([])
  Attn({})
  currentSnapshot = snapshotOf([decision({ id: 'DEC-A3', taskId: 'T-3' })])
  const third = Attn({})
  assert.equal(third.props['data-decision-attention'], undefined, 'a third arrival never pulses again')
  assert.equal(Attn.state.attentionPlays, 2)
}
console.log('PASS  T-211 a new pending decision pulses exactly once, at most twice')

// ── T-211: reduced motion / open card / hidden tab never animate ───────────
{
  const plainStore = { loadDecisions: async () => ({ ok: true, decisions: [] }), send: async () => ({ ok: true }) }
  function fresh(theOverlay) {
    theOverlay.state.open = false
    theOverlay.state.seenCount = null
    theOverlay.state.attention = null
    theOverlay.state.attentionPlays = 0
  }
  const reduced = makeOverlay(plainStore)
  fresh(reduced)
  currentSnapshot = snapshotOf([])
  reduced({})
  globalThis.window = { matchMedia: (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' }) }
  try {
    currentSnapshot = snapshotOf([decision({ id: 'DEC-R1' })])
    const out = reduced({})
    assert.equal(out.props['data-decision-attention'], 'static', 'reduced motion keeps only the static highlight')
    assert.equal(reduced.state.attentionPlays, 1)
  } finally {
    delete globalThis.window
  }
  const opened = makeOverlay(plainStore)
  fresh(opened)
  opened.state.open = true
  currentSnapshot = snapshotOf([])
  opened({})
  currentSnapshot = snapshotOf([decision({ id: 'DEC-O1' })])
  assert.equal(opened({}).props['data-decision-attention'], 'static', 'an open card only highlights')
  const hidden = makeOverlay(plainStore)
  fresh(hidden)
  currentSnapshot = snapshotOf([])
  hidden({})
  globalThis.document = { visibilityState: 'hidden' }
  try {
    currentSnapshot = snapshotOf([decision({ id: 'DEC-H1' })])
    const out = hidden({})
    assert.equal(out.props['data-decision-attention'], undefined, 'a hidden tab is not pulsed')
    assert.equal(hidden.state.attentionPlays, 0, 'a hidden tab does not spend the budget')
  } finally {
    delete globalThis.document
  }
}
console.log('PASS  T-211 reduced motion / open card use the static highlight and a hidden tab never triggers')

// ── T-211: a REAL decisionList payload becomes a visible entry end to end ──
{
  function snapshot(payload, source, message) {
    return {
      ok: payload.ok === true,
      project: null,
      source: source,
      message: message,
      tasks: [],
      counts: {},
      details: {},
      seq: null,
      activityEvents: null,
      actionResult: null,
      actionError: null,
    }
  }
  const storeDeps = {
    TC_STATE_URL: '/state',
    TC_WORKTREES_URL: '/worktrees',
    TC_TASK_URL: '/task',
    TC_LIST_URL: '/list',
    TC_ACTION_URL: '/action',
    tcSnapshot: snapshot,
    tcPinnedProject: () => null,
    tcMergeSnapshot: (previous, payload) => Object.assign({}, previous, payload, { source: 'host' }),
    tcErrorMessage: (payload, translate) => 'error:' + translate('x'),
    tcWithSession: (url) => url,
    tcSessionId: () => 'session-real',
    tcPinProject: () => {},
  }
  const realStore = createTaskStore((key) => key, storeDeps)
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.action, 'decisionList', 'the poll asks the Host for the pending list')
    assert.equal(body.decisionStatus, 'pending')
    return { json: async () => ({ ok: true, decisions: [decision({ id: 'DEC-REAL', taskId: 'T-REAL', title: '创建任务 T-REAL？' })], counts: { pending: 1 } }) }
  }
  const RealOverlay = createDecisionOverlay({
    React: React,
    h: h,
    DecisionModal: DecisionModal,
    store: realStore,
    useTranslate: () => t,
    useSnapshot: () => realStore.getSnapshot(),
    tcErrorMessage: () => 'error',
  })
  RealOverlay.state.open = false
  const loaded = await realStore.loadDecisions()
  assert.equal(loaded.ok, true, 'the Host answers the lightweight decision poll')
  assert.equal(realStore.getSnapshot().decisions.length, 1)
  const visible = RealOverlay({})
  assert.ok(visible !== null, 'the real pending decision renders the floating entry')
  assert.equal(visible.props['data-decision-overlay'], 'dock')
  assert.equal(visible.props['data-decision-pending'], '1')
  assert.ok(textOf(visible).includes('待决策 1'))
  RealOverlay.state.open = true
  const opened = RealOverlay({})
  const card = find(opened, (node) => node.type === DecisionModal.DecisionCard)
  assert.ok(card !== null, 'opening shows the real decision, not a stand-in')
  assert.equal(card.props.decision.id, 'DEC-REAL')
  assert.ok(textOf(card.type(card.props)).includes('创建任务 T-REAL？'))
}
console.log('PASS  T-211 a Host decisionList answer is visible in the conversation entry end to end')

// ── T-211: the panel header falls back when shell.overlay is absent ────────
{
  const stubView = (name) => (props) => ({ type: name, props: props })
  function panelSnapshot(queue) {
    return {
      source: 'host',
      project: '/repo',
      projectRoot: '/repo',
      sessionProject: '/repo',
      message: '',
      dispatch: { state: 'paused', maxConcurrent: 3, defaultTarget: '' },
      counts: {},
      tasks: [],
      queue: [],
      details: {},
      locks: [],
      agentTree: { available: true, root: { id: 'session-root', name: 'root', role: 'lead' }, members: [], count: 0, error: null },
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
      decisions: queue,
      busy: null,
      receivedAt: Date.now(),
    }
  }
  function panelDeps(snap, storeExtras) {
    return {
      React: {
        useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect: () => {},
      },
      h: h,
      Board: stubView('board'),
      QueueView: stubView('queue'),
      WorkersView: stubView('workers'),
      StatusView: stubView('status'),
      RolesView: stubView('roles'),
      DetailView: stubView('detail'),
      DoneAllDrawer: stubView('done-all'),
      TaskForm: stubView('task-form'),
      SettingsPage: stubView('settings-page'),
      engineScopeOf: () => null,
      ProjectForm: stubView('project-form'),
      useTranslate: () => t,
      useSnapshot: () => snap,
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
      store: Object.assign(
        {
          send: async () => ({ ok: true }),
          startPolling: () => {},
          stopPolling: () => {},
          switchProject: async () => ({ ok: true }),
          loadDetail: async () => ({ ok: true }),
        },
        storeExtras,
      ),
    }
  }
  const fallbackOf = (tree) => find(tree, (node) => node.props && node.props['data-decision-header-fallback'] === 'true')
  const pending = [decision({ id: 'DEC-P1' }), decision({ id: 'DEC-P2', taskId: 'T-2' })]
  const withoutOverlay = createTaskCenter(panelDeps(panelSnapshot(pending), {}))({})
  const fallback = fallbackOf(withoutOverlay)
  assert.ok(fallback !== null, 'without the shell overlay the panel header keeps the queue reachable')
  assert.equal(fallback.props.type, 'button', 'the fallback is a real clickable control')
  assert.equal(fallback.props['data-decision-fallback-count'], '2')
  assert.ok(textOf(fallback).includes('待决策 2'))
  fallback.props.onClick()
  const withOverlay = createTaskCenter(panelDeps(panelSnapshot(pending), { decisionOverlayAvailable: () => true }))({})
  assert.equal(fallbackOf(withOverlay), null, 'no duplicate entry while the shell overlay is mounted')
  const emptyPanel = createTaskCenter(panelDeps(panelSnapshot([]), {}))({})
  assert.equal(fallbackOf(emptyPanel), null, 'no fallback without a pending decision')
}
console.log('PASS  T-211 the panel header falls back to a clickable entry only when shell.overlay is absent')

// ── T-211: the card scrolls, the pulse is one-shot (CSS + bundle lock) ─────
{
  const HEAD = readFileSync(new URL('../../client/src/00-head.part', import.meta.url), 'utf8')
  const bundle = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
  assert.ok(/\.gbt-decisiondockpanel\{[^}]*max-height:[^}]*overflow-y:auto/.test(HEAD), 'the docked card caps its height and scrolls inside')
  assert.ok(HEAD.includes('data-decision-attention="play"'), 'the play marker is styled')
  assert.ok(HEAD.includes('data-decision-attention="static"'), 'the reduced-motion/open static highlight is styled')
  assert.ok(HEAD.includes('@keyframes gbt-decisionattn'), 'the pulse has its own keyframes')
  assert.ok(/animation:gbt-decisionattn 600ms[^;}]*\b1\b/.test(HEAD), 'the pulse runs exactly one iteration')
  assert.equal(/gbt-decisionattn[^;}]*infinite/.test(HEAD), false, 'the pulse never loops')
  assert.ok(/prefers-reduced-motion: reduce\)\{[^}]*gbt-decisiondock/.test(HEAD), 'reduced motion disables the pulse')
  assert.ok(bundle.includes('data-decision-overlay'), 'the shipped bundle carries the visibility marker')
  assert.ok(bundle.includes('data-decision-attention'), 'the shipped bundle carries the attention marker')
  assert.ok(bundle.includes('data-decision-header-fallback'), 'the shipped bundle carries the header fallback')
  assert.ok(bundle.includes('markDecisionOverlayMounted'), 'the shipped bundle reports overlay availability to the store')
}
console.log('PASS  T-211 the docked card scrolls and the attention pulse is one-shot')

// ── T-215: a long unbroken writeFiles path wraps inside the 368px dock ─────
{
  const LONG_PATH =
    'C:\\Users\\74368\\AppData\\Local\\Programs\\DeepSeekHarness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\index.js'
  const body = '决策浮层横向裁切：写入文件\nclient/src/00-head.part\nclient/src/views/decision-modal.cjs\n' + LONG_PATH
  const card = DecisionModal.DecisionCard({
    decision: decision({ body: body }),
    queueLeft: 2,
    receivedAt: Date.now(),
    t: t,
    busy: false,
    error: '',
    onAnswer: () => {},
    onDismiss: () => {},
  })
  const cardNode = find(card, (node) => node.props && node.props['data-decision-card'] === 'true')
  assert.ok(cardNode !== null, 'the dock card still renders the foreground decision')
  assert.equal(cardNode.props.className, 'gbt-decision gbt-decisioncompact', 'the compact card keeps its class hook')
  assert.equal(cardNode.props.role, 'dialog')

  const bodyNode = find(card, (node) => node.props && node.props['data-decision-body'] === 'true')
  assert.ok(bodyNode !== null, 'the body is its own node')
  assert.equal(bodyNode.type, 'p')
  assert.equal(bodyNode.props.className, 'gbt-decisionbody')
  assert.equal(bodyNode.props.children, body, 'the body reaches the DOM verbatim, newlines included')
  assert.ok(LONG_PATH.length > 120 && LONG_PATH.indexOf(' ') === -1, 'the fixture is one long token with no break opportunity')
  assert.equal(findAll(card, (node) => node.props && node.props['data-decision-option'] !== undefined).length, 2, 'both options still render next to the long body')

  const HEAD = readFileSync(new URL('../../client/src/00-head.part', import.meta.url), 'utf8')
  const bundle = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
  const ruleOf = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = HEAD.match(new RegExp(escaped + '\\{[^}]*\\}'))
    assert.ok(match !== null, 'the shipped sheet carries ' + selector)
    return match[0]
  }

  const bodyRule = ruleOf('.gbt-decisionbody')
  assert.ok(bodyRule.includes('white-space:pre-wrap'), 'the body still preserves the host line breaks')
  assert.ok(bodyRule.includes('overflow-wrap:anywhere'), 'a token with no spaces may wrap anywhere')
  assert.ok(bodyRule.includes('word-break:break-word'))
  assert.ok(bodyRule.includes('max-width:100%'))
  assert.ok(bodyRule.includes('min-width:0'))

  const compactRule = ruleOf('.gbt-decision.gbt-decisioncompact')
  assert.ok(compactRule.includes('box-sizing:border-box'), 'the card width now includes its 14px padding')
  assert.ok(compactRule.includes('max-width:100%'))
  assert.ok(compactRule.includes('min-width:0'))
  assert.ok(compactRule.includes('overflow-wrap:anywhere'))

  const panelRule = ruleOf('.gbt-decisiondockpanel')
  assert.ok(panelRule.includes('box-sizing:border-box'))
  assert.ok(panelRule.includes('min-width:0'))
  assert.ok(panelRule.includes('overflow-wrap:anywhere'))
  assert.ok(panelRule.includes('max-width:calc(100vw - 24px)'), 'the panel is viewport-capped instead of clipped')
  assert.equal(panelRule.includes('overflow-x:hidden'), false, 'no silent horizontal clipping is used as the fix')
  for (const selector of ['.gbt-decisionoptionbody', '.gbt-decisionoptionlabel', '.gbt-decisionoptiondesc']) {
    assert.ok(ruleOf(selector).includes('overflow-wrap:anywhere'), selector + ' lets a long token wrap')
  }
  assert.ok(/\.gbt-decisiondockpanel\{[^}]*max-height:[^}]*overflow-y:auto/.test(HEAD), 'the T-211 vertical cap still holds')
  assert.ok(bundle.includes('overflow-wrap:anywhere'), 'the rebuilt bundle ships the wrap rule')
  assert.ok(bundle.includes('gbt-decisioncompact{box-sizing:border-box'), 'the rebuilt bundle ships the border-box fix')
}
console.log('PASS  T-215 a long unbroken writeFiles path wraps inside the 368px dock')

console.log('\nPASS  the conversation page answers pending decisions without opening the panel')
