/**
 * Dispatch — turning the ready list into work, and keeping the pool alive.
 *
 * Two independent things live here:
 *
 *   1. The target edge. A task is handed to a fresh worker subagent of the
 *      card's own root Agent (the subagent tree). The subagent service is
 *      optional: a profile without it leaves tasks pending and says so, instead
 *      of failing the plugin.
 *
 *   2. The scheduler. It runs when dispatch is started, after every board write,
 *      on agent status events and on a timer. One pass reaps dead leases, then
 *      dispatches ready tasks up to the concurrency budget, acquiring the task's
 *      declared file locks first. A task is claimed BEFORE anything leaves the
 *      process: the claim is the mutex that makes a second dispatch impossible.
 *
 * Worktrees are the execution model, not an option: every attempt runs in its
 * own checkout on a task branch, and the brief says so. Dispatch therefore
 * REQUIRES a usable worktree environment — a git service, a git repository and
 * a clean working tree. When any of that is missing, or a checkout cannot be
 * created, nothing is claimed: start refuses up front, and a claim-time failure
 * releases the task's file locks, pauses dispatch and records why, so the
 * five-second timer does not hammer a broken project. Fix the environment, then
 * start dispatch again.
 */

import { join } from 'node:path'
import { serialiseWorktreeCreate } from './git.mjs'
import { randomUUID } from 'node:crypto'
import { fingerprintVerify, verifyScriptPaths } from './merge.mjs'
import { boardPath, projectIdOf, readRoleConfig } from './board.mjs'
import { createSessionLookup } from './session-lookup.mjs'
import { writePolicyFor } from './state.mjs'
import {
  ROLE_STAGE,
  ROLE_TEMPLATE_VARIABLES,
  TASK_HEARTBEAT_MS,
  TASK_LEASE_CAP_ERROR,
  TASK_LEASE_EXTENSION_MAX_MS,
  TASK_LEASE_MS,
  TEST_REMINDER_MS,
  TEST_TIMEOUT_MS,
  PHASE_BLOCK_GRACE_MS,
  VERIFY_COLLECT_BYTES,
  VERIFY_DEFAULT_TIMEOUT_MS,
  VERIFY_TAIL_BYTES,
  normaliseVerify,
  profileForKind,
  renderRoleTemplate,
  roleTemplateVariables,
} from './schema.mjs'
import * as model from './service.mjs'
import { buildCandidateArtifact, renderReviewBrief, renderTesterBrief } from './stage-contract.mjs'
import * as locks from './locks.mjs'
import { DEFAULT_WORKTREE_TIMEOUT_MS, createGit } from './git.mjs'
import { createLeaseGate } from './lease-gate.mjs'
import { SKILL_NAME } from './skill.mjs'

export const DEFAULT_MAX_WORK_AGENTS = 4
export const DEFAULT_MAX_ATTEMPTS = 3

/** How many host activity entries the in-memory ring keeps by default. */
export const ACTIVITY_LIMIT = 100

/**
 * The host's activity ring: recent events for the status panel. It is pure
 * in-memory state (no board writes) and separates its actors explicitly:
 * 'system' is host automation, 'host' is scheduler/host work on a task, and
 * 'agent' is a model-driven action (with the agent's name). No System event is
 * ever reported as an Agent event.
 */
export function createActivity(options) {
  const opts = options === undefined || options === null ? {} : options
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : ACTIVITY_LIMIT
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  let entries = []
  let pushed = 0
  function push(entry) {
    const source = entry === undefined || entry === null ? {} : entry
    const actor = source.actor === 'agent' || source.actor === 'host' ? source.actor : 'system'
    const record = {
      at: typeof source.at === 'string' && source.at !== '' ? source.at : new Date(clock()).toISOString(),
      kind: typeof source.kind === 'string' && source.kind !== '' ? source.kind : 'event',
      actor: actor,
      actorName: actor === 'agent' && typeof source.actorName === 'string' && source.actorName !== '' ? source.actorName : null,
      taskId: typeof source.taskId === 'string' && source.taskId !== '' ? source.taskId : null,
      detail: typeof source.detail === 'string' && source.detail !== '' ? source.detail : null,
    }
    entries.push(record)
    pushed += 1
    if (entries.length > limit) entries = entries.slice(entries.length - limit)
    return record
  }
  function list(amount) {
    const wanted = Number.isFinite(amount) ? Math.max(1, Math.min(limit, Math.floor(amount))) : limit
    return entries.slice(Math.max(0, entries.length - wanted))
  }
  function snapshot(amount) {
    const recent = list(amount)
    const actors = { system: 0, host: 0, agent: 0 }
    for (const entry of recent) actors[entry.actor] += 1
    return {
      limit: limit,
      count: entries.length,
      pushed: pushed,
      actors: actors,
      // Newest first is what a panel shows.
      entries: recent.slice().reverse(),
    }
  }
  function clear() {
    entries = []
  }
  return { push: push, list: list, snapshot: snapshot, clear: clear, limit: limit }
}

/** Review policy: a review that sits undecided for this long is reminded once.
 * Since T-197 a silent round asks the human instead of blocking directly, so a
 * slow-but-working reviewer can never strand or lose a card. */
export const REVIEW_TIMEOUT_MS = 10 * 60 * 1000

// ── T-197: stage events, budgets and notify-by-default recovery ─────────────
// The stage safety net is measured in SILENCE, not in elapsed time: a role that
// keeps producing identifiable activity is working, and the watchdog must never
// mistake one long probe for a stuck stage.
export const STAGE_BUDGET_MS = 20 * 60 * 1000
/** One "continue" buys exactly one more slice of the SAME stage. */
export const STAGE_CONTINUE_MS = 20 * 60 * 1000
/** Three CONSECUTIVE default-continues auto-block the card; it is not asked again. */
export const STAGE_CONTINUE_LIMIT = 3
/** Failed auto-recoveries of ONE event before it escalates from notify to ask. */
export const STAGE_RECOVERY_LIMIT = 2
/** The panel deadline on a stage question (requirement packet §5). */
export const STAGE_DECISION_TIMEOUT_MS = 120 * 1000
/** The timeout question's default option (packet §5). */
export const STAGE_DEFAULT_OPTION = 'continue'
/** Downstream cards listed in a dev-timeout question before it is summarised. */
export const STAGE_DOWNSTREAM_LINES = 8

/** Every event the stage engine can raise (event 10's five keys included). */
export const STAGE_EVENTS = Object.freeze({
  devTimeout: 'dev-timeout',
  reviewTimeout: 'review-timeout',
  testTimeout: 'test-timeout',
  hostVerifyFail: 'host-verify-fail',
  mergeConflict: 'merge-conflict',
  workerLost: 'worker-lost',
  targetDrift: 'target-drift',
  reviewRounds: 'review-rounds-exhausted',
})

/** The panel's event labels (packet §3.1–§3.10 copy). */
export const STAGE_EVENT_LABELS = Object.freeze({
  'dev-timeout': '开发超时',
  'review-timeout': '评审超时',
  'test-timeout': '测试超时',
  'host-verify-fail': 'Host 验证失败',
  'merge-conflict': '合并冲突',
  'worker-lost': '执行者丢失',
  'target-drift': 'Target drift',
  'review-rounds-exhausted': '评审轮次用尽',
})

/** Event 10's automatic action, in the packet's words. */
export const STAGE_EVENT_ACTIONS = Object.freeze({
  'host-verify-fail': '退回开发并附上验证证据',
  'merge-conflict': '退回开发并附上冲突文件',
  'worker-lost': '重新派发',
  'target-drift': '重建候选并重测',
  'review-rounds-exhausted': '阻塞任务并通知 Lead',
})

/** The stage an event/round belongs to, or null. */
export function stageOfTask(task) {
  if (task === null || task === undefined) return null
  // A card waiting for an executor/environment is not silent: it is waiting on
  // the host, so its stage clock is paused exactly like the old watchdogs did.
  if (typeof task.waitingReason === 'string' && task.waitingReason !== '') return null
  if (task.status === 'running') return 'dev'
  if (task.status === 'reviewing' && task.review !== null && task.review !== undefined && task.review.status === 'pending') return 'review'
  if (task.status === 'testing' && task.test !== null && task.test !== undefined && task.test.status === 'pending') return 'test'
  return null
}

/** The decision id of ONE timeout question: stable per round AND per slice. */
export function stageDecisionId(taskId, event, roundAt, continues) {
  const round = Number.isFinite(roundAt) ? String(Math.floor(roundAt)) : '0'
  return 'stage-' + String(taskId) + '-' + String(event) + '-' + round + '-' + String(Math.max(0, Math.floor(continues)))
}

/** The panel options of a stage timeout question (packet §3.3–§3.5). */
export function stageTimeoutOptions(stage) {
  if (stage === 'dev') {
    return [
      { id: STAGE_DEFAULT_OPTION, label: '继续等待 20 分钟', description: '保留当前工作树，只延长本轮开发；不重启 worker', default: true },
      { id: 'retry-dev', label: '重试开发', description: '丢弃当前未提交修改，从目标分支重新开始（输入 DELETE 确认）', danger: true },
      { id: 'cancel', label: '取消任务', description: '停止开发；下游卡片进入阻塞/需重新评估' },
      { id: 'cancel-tree', label: '取消并删除依赖树', description: '删除本卡与全部链式下游，不可恢复', danger: true },
    ]
  }
  const role = stage === 'review' ? 'reviewer' : 'tester'
  const label = stage === 'review' ? '评审' : '测试'
  return [
    { id: STAGE_DEFAULT_OPTION, label: '继续' + label + ' 20 分钟', description: '只延长当前阶段预算；不重启 worker，保留 worktree 与候选', default: true },
    { id: 'replace', label: '更换 ' + role, description: '先释放当前 ' + role + '，再另起一轮独立' + label },
    { id: 'block', label: '阻塞任务', description: '保留工作树与候选，等待人工处理' },
    { id: 'cancel', label: '取消任务', description: '下游卡片需重新评估' },
  ]
}

/**
 * Every LIVE card that depends on `id`, depth-first: the packet's "递归展示下游"
 * (a cancel leaves those cards blocked / needing re-evaluation). Closed cards are
 * not "affected" and are never listed.
 */
export function stageDownstreamOf(board, id) {
  const rows = []
  const closed = ['done', 'cancelled']
  const tasks = Array.isArray(board === null || board === undefined ? null : board.tasks) ? board.tasks : []
  const seen = new Set([String(id)])
  const childrenOf = (parentId) =>
    tasks.filter((task) => {
      if (task === null || task === undefined) return false
      if (closed.indexOf(task.status) >= 0) return false
      if (Array.isArray(task.dependsOn) === false) return false
      if (seen.has(String(task.id))) return false
      return task.dependsOn.map(String).indexOf(String(parentId)) >= 0
    })
  const walk = (parentId, prefix, depth) => {
    const children = childrenOf(parentId)
    children.forEach((task, index) => {
      const last = index === children.length - 1
      seen.add(String(task.id))
      rows.push({
        id: String(task.id),
        title: typeof task.title === 'string' ? task.title : '',
        status: String(task.status),
        depth: depth,
        line: prefix + (last ? '└─ ' : '├─ ') + String(task.id),
      })
      walk(task.id, prefix + (last ? '   ' : '│  '), depth + 1)
    })
  }
  walk(String(id), '', 0)
  return rows
}

/** The timeout question's body (packet §3.3–§3.5), one fact per line. */
export function stageTimeoutBody(input) {
  const row = input === undefined || input === null ? {} : input
  const stage = row.stage === 'review' ? '评审' : row.stage === 'test' ? '测试' : '开发'
  const minutes = (value) => String(Math.max(0, Math.round(Number(value) / 60000)))
  // T-198: the consecutive limit is configurable per event, so the body shows the
  // configured one instead of the built-in constant.
  const limit = Number.isFinite(row.limit) && row.limit >= 0 ? Math.floor(row.limit) : STAGE_CONTINUE_LIMIT
  const lines = [
    '当前阶段：' + stage,
    '已等待：' + minutes(row.waitedMs) + ' 分钟无活动',
    '最后活动：' + (typeof row.lastActivity === 'string' && row.lastActivity !== '' ? row.lastActivity : '未知'),
    '连续超时：' + String(Number.isFinite(row.defaults) ? row.defaults : 0) + '/' + String(limit),
  ]
  if (typeof row.worktree === 'string' && row.worktree !== '') lines.push('工作树：' + row.worktree)
  if (typeof row.candidate === 'string' && row.candidate !== '') lines.push('候选：' + row.candidate)
  if (typeof row.executor === 'string' && row.executor !== '') lines.push('执行者：' + row.executor)
  const downstream = Array.isArray(row.downstream) ? row.downstream : []
  if (downstream.length > 0) {
    lines.push('下游：' + String(downstream.length) + ' 张卡需要重新评估')
    for (const entry of downstream.slice(0, STAGE_DOWNSTREAM_LINES)) lines.push(entry.line)
    if (downstream.length > STAGE_DOWNSTREAM_LINES) lines.push('…（还有 ' + String(downstream.length - STAGE_DOWNSTREAM_LINES) + ' 张）')
  }
  return lines.join('\n')
}

/**
 * One-line reminder / grace notice (T-197 requirement 9).
 *
 * `untilMs` is the time LEFT in this budget slice. Deliberately NARROW: id,
 * title, stage, waited, the verdict it needs and the deadline. The full brief is NEVER appended — a reminder is not a second
 * prompt, and a message that already reached an Agent inbox cannot be recalled
 * (a delivery-time revoke would be a DSH inbox API, investigated separately).
 * The text says so, so a verdict delivered in the meantime is simply ignored.
 */
export function stageReminderText(input) {
  const row = input === undefined || input === null ? {} : input
  const id = typeof row.taskId === 'string' && row.taskId !== '' ? row.taskId : 'task'
  const title = typeof row.title === 'string' && row.title !== '' ? ' "' + row.title + '"' : ''
  const stage = row.stage === 'test' ? 'test' : 'review'
  const need = stage === 'test' ? 'passTest or failTest' : 'approveReview or requestChanges'
  const waited = String(Math.max(1, Math.round(Number(row.waitedMs) / 60000)))
  const left = String(Math.max(0, Math.round(Number(row.untilMs) / 60000)))
  const tail = ' Non-authoritative: if you already delivered this verdict, ignore this message.'
  if (row.grace === true) {
    return id + title + ' ' + stage + ': ' + waited + 'm without a verdict; still need ' + need + ' — the host asks the human in ' + left + 'm.' + tail
  }
  return id + title + ' ' + stage + ': ' + waited + 'm without a verdict; still need ' + need + ' within ' + left + 'm.' + tail
}


// ── phase activity clock ───────────────────────────────────────────────────
// Silence is measured from the LAST identifiable activity of the role working
// the round, not from the phase start. The API records every task_center call
// here (keyed by ctx, so several hosts in one test stay apart); the watchdog
// only reads. Memory-only: activity never writes the board.
const PHASE_ACTIVITY = new WeakMap()
const PHASE_ACTIVITY_FALLBACK = new Map()

// ── role-slot queue ────────────────────────────────────────────────────────
// One role slot (reviewer-N / tester-N) works one task at a time. The host keeps
// the delivery/queue state in memory, keyed by ctx like the phase clock:
// { at: epoch ms of delivery | null, position: 1-based queue position | null }.
const STAGE_SLOT = new WeakMap()
const STAGE_SLOT_FALLBACK = new Map()

function slotBucket(ctx, create) {
  const key = ctx !== null && typeof ctx === 'object' ? ctx : null
  if (key === null) return STAGE_SLOT_FALLBACK
  let bucket = STAGE_SLOT.get(key)
  if (bucket === undefined && create === true) {
    bucket = new Map()
    STAGE_SLOT.set(key, bucket)
  }
  return bucket
}

function slotKey(taskId, kind) {
  return String(taskId) + '@' + String(kind === 'tester' ? 'tester' : 'reviewer')
}

/** Record one stage's slot state: delivered (at set) or queued (position set).
 *
 * A delivered slot NEVER keeps a position. The card has started the stage, so a
 * caller that still holds a stale position cannot leave `{ at, position }` behind
 * — that residue is exactly what kept the "queued" chip on a reviewing card.
 */
export function recordStageSlot(ctx, taskId, kind, at, position) {
  if (typeof taskId !== 'string' || taskId === '') return
  try {
    const bucket = slotBucket(ctx, true)
    const key = slotKey(taskId, kind)
    const deliveredAt = Number.isFinite(at) ? at : null
    const queued = deliveredAt === null && Number.isFinite(position) ? position : null
    if (deliveredAt === null && queued === null) bucket.delete(key)
    else bucket.set(key, { at: deliveredAt, position: queued })
  } catch (error) {}
}

/** One stage's slot state for a task, or null when it was never queued/delivered. */
export function stageSlotOf(ctx, taskId, kind) {
  if (typeof taskId !== 'string' || taskId === '') return null
  try {
    const bucket = slotBucket(ctx, false)
    if (bucket === undefined) return null
    const entry = bucket.get(slotKey(taskId, kind))
    return entry === undefined ? null : entry
  } catch (error) {
    return null
  }
}



function activityBucket(ctx, create) {
  const key = ctx !== null && typeof ctx === 'object' ? ctx : null
  if (key === null) return PHASE_ACTIVITY_FALLBACK
  let bucket = PHASE_ACTIVITY.get(key)
  if (bucket === undefined && create === true) {
    bucket = new Map()
    PHASE_ACTIVITY.set(key, bucket)
  }
  return bucket
}

/** Record that `by` (name) / `session` touched task `taskId` at `at` (ms). Never throws. */
export function recordPhaseActivity(ctx, taskId, by, at, session) {
  if (typeof taskId !== 'string' || taskId === '') return
  if (!Number.isFinite(at)) return
  try {
    const bucket = activityBucket(ctx, true)
    let entry = bucket.get(taskId)
    if (entry === undefined) {
      entry = { at: 0, times: new Map() }
      bucket.set(taskId, entry)
    }
    if (at > entry.at) entry.at = at
    // Keep the latest activity PER identity: a worker's call must not overwrite
    // the tester's own last-call timestamp.
    const key = (typeof by === 'string' ? by : '') + '|' + (typeof session === 'string' ? session : '')
    const previous = entry.times.get(key)
    if (previous === undefined || at > previous) entry.times.set(key, at)
    if (entry.times.size > 64) {
      const oldest = entry.times.keys().next()
      if (oldest !== undefined && oldest.done !== true) entry.times.delete(oldest.value)
    }
  } catch (error) {}
}

/** The last recorded activity on `taskId` (ms), or 0 when none exists. With
 * `roles` (slot names plus member ids/sessions), only the identities that belong
 * to those roles count, so a worker/user call never renews a role's clock. */
export function phaseActivityAt(ctx, taskId, roles) {
  if (typeof taskId !== 'string' || taskId === '') return 0
  try {
    const bucket = activityBucket(ctx, false)
    const entry = bucket === undefined ? undefined : bucket.get(taskId)
    if (entry === undefined) return 0
    if (!Array.isArray(roles) || roles.length === 0) return Number.isFinite(entry.at) ? entry.at : 0
    let latest = 0
    for (const [key, at] of entry.times) {
      if (!Number.isFinite(at)) continue
      const parts = key.split('|')
      if (roles.indexOf(parts[0]) >= 0 || roles.indexOf(parts[1]) >= 0) {
        if (at > latest) latest = at
      }
    }
    return latest
  } catch (error) {
    return 0
  }
}
/** Review rounds a task may go through before the host blocks it for triage. */
export const REVIEW_MAX_ROUNDS = 3

const RERUN_DELAY_MS = 250



/** A process-stable boot id. globalThis survives a plugin reload in the same
 * process, so a reload does not mistake live workers for dead ones; a real host
 * restart changes it, and the scheduler requeues their tasks. */
const BOOT_KEY = Symbol.for('godot-bridge.task-center.boot')
export function bootId() {
  if (globalThis[BOOT_KEY] === undefined) globalThis[BOOT_KEY] = randomUUID()
  return globalThis[BOOT_KEY]
}


/**
 * Read an OPTIONAL context property without tripping Cordis' activation guard.
 * A property that was not declared in `inject` THROWS on read; that must never
 * take the whole row down, so every optional identity read goes through here
 * (or through ctx.get(name), which is guarded the same way).
 */
function optionalContextValue(ctx, name) {
  if (ctx === undefined || ctx === null) return undefined
  try {
    const direct = ctx[name]
    if (direct !== undefined && direct !== null) return direct
  } catch (error) {
    // Not injected: fall through to the service lookup.
  }
  try {
    if (typeof ctx.get === 'function') {
      const viaGet = ctx.get(name)
      if (viaGet !== undefined && viaGet !== null) return viaGet
    }
  } catch (error) {
    // A profile without the service simply has no value.
  }
  return undefined
}

/** The session this profile belongs to, if the host can name it. Optional by design. */
export function sessionIdOfContext(ctx) {
  const agent = optionalContextValue(ctx, 'agent')
  const candidates = [
    agent !== null && agent !== undefined ? agent.id : null,
    agent !== null && agent !== undefined ? agent.session : null,
    optionalContextValue(ctx, 'sessionId'),
    optionalContextValue(ctx, 'session'),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

/** The session an agent descriptor belongs to (its id IS the session id). */
export function agentSessionOf(agent) {
  if (agent === null || agent === undefined) return null
  if (typeof agent.id === 'string' && agent.id !== '') return agent.id
  return typeof agent.session === 'string' && agent.session !== '' ? agent.session : null
}




let leadActivityLookup = null
let leadActivityLookupDir = null
function sessionActivityLookup() {
  // The sessions directory is re-read on every call: tests and alternative DSH
  // homes point GODOT_BRIDGE_SESSIONS_DIR at a fixture, and a stale lookup must
  // never keep answering from the previous root.
  const override = typeof process.env.GODOT_BRIDGE_SESSIONS_DIR === 'string' && process.env.GODOT_BRIDGE_SESSIONS_DIR !== '' ? process.env.GODOT_BRIDGE_SESSIONS_DIR : null
  if (leadActivityLookup === null || leadActivityLookupDir !== override) {
    leadActivityLookup = createSessionLookup({
      homeDir: typeof process.env.GODOT_BRIDGE_HOME === 'string' && process.env.GODOT_BRIDGE_HOME !== '' ? process.env.GODOT_BRIDGE_HOME : undefined,
      sessionsDir: override === null ? undefined : override,
    })
    leadActivityLookupDir = override
  }
  return leadActivityLookup
}


/**
 * T-153: last activity of ANY session (not only a Lead), from the DSH sessions
 * directory. Returns an epoch-ms number or null when this host cannot see the
 * session. The STALENESS THRESHOLD is deliberately NOT decided here: LEAD_STALE_MS
 * (6h) is about a Team Lead, a session handoff is decided on minutes (see
 * handoff.mjs SESSION_STALE_MS). One source, two very different questions.
 */
export function sessionLastActiveAt(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  try {
    const read = sessionActivityLookup().lastActiveOf(sessionId)
    if (read !== null && read !== undefined && read.ok === true && Number.isFinite(read.at)) return read.at
  } catch (error) {}
  return null
}


/**
 * The workspace a session actually runs in: what the resolver recorded (panel,
 * tool call, task binding), else its DSH sessions-tree directory. A dispatcher
 * MUST judge cross-project reachability by THIS, not by the row's sandbox policy:
 * the policy covers every project the plugin knows, the session covers one.
 */
export async function sessionWorkspaceOf(state, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '' || state === null || state === undefined) return null
  try {
    const recorded = typeof state.sessionRootOf === 'function' ? state.sessionRootOf(sessionId) : null
    if (typeof recorded === 'string' && recorded !== '') return recorded
  } catch (error) {}
  if (typeof state.lookupSessionRoot === 'function') {
    try {
      const looked = await state.lookupSessionRoot(sessionId)
      if (looked !== null && looked !== undefined && looked.ok === true && typeof looked.path === 'string' && looked.path !== '') return looked.path
    } catch (error) {}
  }
  return null
}

/** Does this session run in the card's project? null = the session is unknown. */
export async function sessionOwnsProject(state, sessionId, project) {
  const workspace = await sessionWorkspaceOf(state, sessionId)
  if (workspace === null) return null
  return projectIdOf(workspace) === projectIdOf(project)
}


/** The SUBAGENT provider registry is not the LLM provider registry; asking it is
 * the only way to avoid the "no subagent provider registered" failure. */
export function subagentProviderFor(ctx, preferred) {
  const fallback = typeof preferred === 'string' && preferred.length > 0 ? preferred : 'spawn'
  let subagents = null
  try {
    subagents = ctx.get('subagents')
  } catch (error) {
    return fallback
  }
  if (subagents === undefined || subagents === null || typeof subagents.list !== 'function') return fallback
  let names = []
  try {
    names = subagents.list()
  } catch (error) {
    return fallback
  }
  if (!Array.isArray(names) || names.length === 0) return fallback
  return names.indexOf(fallback) >= 0 ? fallback : String(names[0])
}


/** The unconfined subprocess service as a createGit runner: one process per
 * call, stdio collected through the service. */
function runnerFromSubprocess(subprocess, options) {
  const settings = options === undefined || options === null ? {} : options
  const defaultTimeoutMs = Number.isFinite(settings.timeoutMs) ? Math.max(1, Math.floor(settings.timeoutMs)) : 60 * 1000
  return async function runGit(args, cwd, callOptions) {
    // A caller may bring its own budget (worktree add does); everything else
    // keeps the short default so one stuck read cannot pin the merge queue.
    const requested = callOptions === undefined || callOptions === null ? undefined : callOptions.timeoutMs
    const timeoutMs = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : defaultTimeoutMs
    let executable = 'git'
    if (typeof subprocess.resolveExecutable === 'function') {
      try {
        const resolved = await subprocess.resolveExecutable('git')
        if (typeof resolved === 'string' && resolved.length > 0) executable = resolved
      } catch (error) {
        executable = 'git'
      }
    }
    let handle
    try {
      handle = subprocess.spawn({
        argv: [executable].concat(args),
        cwd: cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: 8 * 1024 * 1024 } },
          stderr: { collect: { maxBytes: 8 * 1024 * 1024 } },
        },
        graceMs: 3000,
      })
    } catch (error) {
      return { code: 1, stdout: '', stderr: String((error && error.message) || error) }
    }
    // A git process must never pin the shared merge queue forever. A dropped
    // handle or an unobservable process range would otherwise make every later
    // action wait on this one. done is bounded by the caller's budget; a
    // timed-out handle is terminated and its managed range is awaited before
    // reporting failure.
    const exitGraceMs = 5 * 1000
    let outcome = null
    let timer
    try {
      outcome = await Promise.race([
        handle.done,
        new Promise((resolveTimeout) => {
          timer = setTimeout(() => resolveTimeout(null), timeoutMs)
        }),
      ])
    } catch (error) {
      return { code: 1, stdout: '', stderr: String((error && error.message) || error) }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (outcome === null) {
      try {
        handle.terminate()
      } catch (error) {}
      try {
        if (typeof handle.waitForExit === 'function') await handle.waitForExit(AbortSignal.timeout(exitGraceMs))
      } catch (error) {}
      return { code: 1, stdout: '', stderr: 'git ' + args.join(' ') + ' timed out after ' + String(timeoutMs) + 'ms' }
    }
    try {
      if (typeof handle.waitForExit === 'function') await handle.waitForExit(AbortSignal.timeout(exitGraceMs))
    } catch (error) {}
    let stdout = ''
    let stderr = ''
    try {
      if (handle.collected && handle.collected.stdout && typeof handle.collected.stdout.readFrom === 'function') {
        stdout = handle.collected.stdout.readFrom(0).text || ''
      }
      if (handle.collected && handle.collected.stderr && typeof handle.collected.stderr.readFrom === 'function') {
        stderr = handle.collected.stderr.readFrom(0).text || ''
      }
    } catch (error) {}
    const code = outcome !== null && outcome !== undefined && Number.isFinite(outcome.exitCode) ? outcome.exitCode : 1
    return { code: code, stdout: stdout, stderr: stderr }
  }
}

/**
 * The Git facade this scheduler and the API commit through, or null when the
 * profile has no subprocess service. Null means worktrees cannot be made, and
 * therefore that dispatch cannot start. An explicit `options.git` (a createGit
 * result, or null to stand in for a host without git) always wins, which is how
 * a test drives this without starting a git process.
 */
export function gitFor(ctx, options) {
  const opts = options === undefined ? {} : options
  if (opts.git !== undefined) return opts.git
  let subprocess = null
  try {
    subprocess = ctx.get('subprocess')
  } catch (error) {
    return null
  }
  if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') return null
  // The worktree budget is configured once here: worktree add asks for it per
  // call, every other git command keeps the short default.
  return createGit({ run: runnerFromSubprocess(subprocess), worktreeTimeoutMs: opts.worktreeTimeoutMs })
}

/**
 * How many consecutive TRANSIENT environment failures one card may collect before
 * it asks for a human. The merge pipeline works in the main checkout, so "the main
 * tree is clean" is briefly false while it runs; a card that hits that window must
 * not be turned into an alarm on the first try.
 */
export const ENVIRONMENT_RETRY_LIMIT = 5
/** …or this long, whichever comes first (a slower timer still escalates). */
export const ENVIRONMENT_RETRY_WINDOW_MS = 30 * 1000

/** Environment codes that are expected to fix themselves (a merge is running). */
const TRANSIENT_ENVIRONMENT_CODES = ['dirty-worktree', 'status-unreadable']

/** Is this failure something the next pass can plausibly fix on its own? */
export function isTransientEnvironmentCode(code) {
  return TRANSIENT_ENVIRONMENT_CODES.indexOf(String(code === undefined || code === null ? '' : code)) >= 0
}

/** The descriptor a task records when no worktree could be made. The code travels
 * separately so the caller can tell a self-healing window from a broken setup. */
function worktreeFallback(code, message) {
  const name = typeof code === 'string' && code !== '' ? code : 'worktree-unavailable'
  const text = typeof message === 'string' && message !== '' ? message : name
  return { base: null, target: null, branch: null, path: null, keep: false, error: name + ': ' + text, code: name, message: text }
}

/**
 * Can this project host task worktrees right now?
 *
 * The one check behind both the start/approve preflight and claim-time
 * preparation: a git facade and a repository, plus — by default — a clean working
 * tree. `requireClean: false` skips ONLY the clean gate: an investigation reads in
 * a detached scratch and never merges, so a dirty main checkout is irrelevant to
 * it (the repository and base checks always apply). It never throws and answers
 * `{ ok: true }` or `{ ok: false, code, message }`.
 */
export async function probeWorktree(git, projectPath, options) {
  const opts = options === undefined || options === null ? {} : options
  // T-131: an investigation reads code in a detached scratch and never merges, so
  // a dirty MAIN checkout is irrelevant to it; the repository must still be real.
  const requireClean = opts.requireClean !== false
  if (git === undefined || git === null || typeof git.isRepo !== 'function') {
    return {
      ok: false,
      code: 'no-git-service',
      message: 'this profile has no git runner, so a task worktree cannot be created',
    }
  }
  try {
    const repo = await git.isRepo(projectPath)
    if (repo.ok !== true) {
      return { ok: false, code: 'git-unavailable', message: 'git could not be asked whether ' + projectPath + ' is a repository: ' + String(repo.message) }
    }
    if (repo.repo !== true) return { ok: false, code: 'not-a-git-repository', message: projectPath + ' is not a git repository' }
    if (requireClean !== true) return { ok: true }
    const clean = await git.isClean(projectPath)
    if (clean.ok !== true) {
      // A failed READ is not proof of a broken environment: the merge pipeline
      // holds index.lock in the main checkout for a moment. Treat it like the
      // dirty window — skip the card, retry next pass.
      return { ok: false, code: 'status-unreadable', message: 'git status failed in ' + projectPath + ': ' + String(clean.message) }
    }
    if (clean.clean !== true) {
      return {
        ok: false,
        code: 'dirty-worktree',
        message: 'the working tree of ' + projectPath + ' has uncommitted changes; commit or stash them so a task worktree starts from a known commit',
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, code: 'git-unavailable', message: String((error && error.message) || error) }
  }
}

/**
 * The scheduler's own bound on ONE worktree creation. The git facade already
 * asks the runner for DEFAULT_WORKTREE_TIMEOUT_MS; this adds a grace margin and
 * is the belt-and-braces bound (a runner that ignores its timeout, or a promise
 * that never settles, must not hang a scheduler pass forever). Past it the
 * attempt is rolled back and retried like any other failure.
 */
export const WORKTREE_CREATE_DEADLINE_MS = DEFAULT_WORKTREE_TIMEOUT_MS + 15 * 1000

/** A sentinel for "the work did not settle before its deadline". */
const WORKTREE_DEADLINE_HIT = Object.freeze({ ok: false, code: 'worktree-add-timeout', message: null })

/** Run one piece of work with a hard deadline. Never rejects for the timeout: a
 * late finish is simply ignored, which is what the caller wants. */
async function withinWorktreeDeadline(work, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => work()),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(WORKTREE_DEADLINE_HIT), Math.max(1, Math.floor(timeoutMs)))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * One worktree add per repository at a time. A scheduler pass is serialised, but
 * the API, a role repair and a second dispatcher instance in the same profile can
 * all create a checkout for one repository at the same moment; git then contends
 * for index.lock and a slow add can be killed half-way (T-41 left a registered,
 * locked checkout exactly that way). A per-project promise chain keeps the adds
 * ordered without blocking unrelated repositories.
 */
// The gate lives in git.mjs so the merge pipeline shares it; re-exported here for
// the scheduler and the existing tests.
export { serialiseWorktreeCreate }

/**
 * Prepare this attempt's worktree. It is the only execution mode: no worktree
 * means no claim, never a shared checkout.
 *
 * Returns `{ base, target, branch, path, keep, error }`; `error` is set when
 * preparation refused and `path` is then null. It never throws, and a failed
 * add is force-removed so no half worktree is left behind.
 */
/** The checkout path for one attempt: <root>/<id>-<n>, where <root> defaults to
 * .worktrees and may be absolute (a shared worktree root). Shared by the task
 * checkout and the detached investigation scratch of T-131. */
function checkoutPathFor(projectPath, task, attempt, dispatch) {
  const settings = dispatch === undefined || dispatch === null ? null : dispatch.worktree
  const root = String(settings === null || settings === undefined || settings.root === undefined || settings.root === null ? '' : settings.root).trim()
  const checkoutRoot = root === '' ? '.worktrees' : root
  return /^([a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(checkoutRoot)
    ? join(checkoutRoot, String(task.id) + '-' + String(attempt))
    : join(projectPath, checkoutRoot, String(task.id) + '-' + String(attempt))
}

/** The last path segment of a worktree path (either separator). */
function worktreeBaseName(path) {
  const text = String(path === undefined || path === null ? '' : path).replace(/[\\/]+$/, '')
  const at = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return at < 0 ? text : text.slice(at + 1)
}

/**
 * Remove every registered checkout an investigation leaves behind: the current
 * scratch, its earlier attempts (<id>-1, <id>-2 …) and probe-<id>-* siblings. A
 * host restart REFUNDS the attempt, so the next slot can follow a still-registered
 * scratch; nothing from a previous attempt is ever adopted. The ONE removal path:
 * the dispatcher calls it before adding a new scratch, and the API calls it when
 * the card leaves running (report/cancel/block/reopen/retry). A listing failure
 * simply means no stale path is known here; a refused removal is reported, never
 * fatal (the card is already done).
 */
export async function cleanupInvestigationCheckouts(git, projectPath, task) {
  const removed = []
  const failed = []
  if (task === null || task === undefined || task.kind !== 'investigate') return null
  if (git === null || git === undefined || typeof git.worktreeList !== 'function') return { removed: removed, failed: failed }
  let entries = []
  try {
    const listed = await git.worktreeList(projectPath)
    entries = listed !== null && listed !== undefined && listed.ok === true && Array.isArray(listed.worktrees) ? listed.worktrees : []
  } catch (error) {
    entries = []
  }
  const attemptPrefix = String(task.id) + '-'
  const probePrefix = 'probe-' + String(task.id) + '-'
  const targets = []
  if (typeof task.worktree === 'string' && task.worktree !== '') targets.push(task.worktree)
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') continue
    if (targets.indexOf(entry.path) >= 0) continue
    const name = worktreeBaseName(entry.path)
    if (name.indexOf(attemptPrefix) === 0 || name.indexOf(probePrefix) === 0) targets.push(entry.path)
  }
  if (typeof git.worktreeRemove !== 'function') return { removed: removed, failed: failed }
  for (const path of targets) {
    try {
      const gone = await git.worktreeRemove(projectPath, path, { force: true })
      if (gone !== null && gone !== undefined && gone.ok === true) removed.push(path)
      else failed.push({ path: path, message: gone === undefined || gone === null || gone.message === undefined ? null : String(gone.message) })
    } catch (error) {
      failed.push({ path: path, message: String((error && error.message) || error) })
    }
  }
  return { removed: removed, failed: failed }
}

async function prepareWorktree(git, projectPath, task, dispatch, attempt, deadlineMs) {
  // An investigation may run while the main checkout is dirty: it works in a
  // detached scratch and never merges, so only the repository check applies.
  const probe = await probeWorktree(git, projectPath, task.kind === 'investigate' ? { requireClean: false } : {})
  if (probe.ok !== true) return worktreeFallback(probe.code, probe.message)
  const headNow = await git.head(projectPath)
  if (headNow.ok !== true) return worktreeFallback('base-unreadable', String(headNow.message))
  const current = await git.currentBranch(projectPath)
  const defaultBranch = current.ok === true && typeof current.branch === 'string' ? current.branch : null
  // The task's own target wins; otherwise the project's configured default target
  // (board dispatch.defaultTarget) applies, and only when THAT is unset does the
  // main checkout's branch act as the fallback default.
  const taskTarget = typeof task.target === 'string' && task.target.trim() !== '' ? task.target.trim() : null
  const dispatchSettings = dispatch === undefined || dispatch === null ? null : dispatch
  const configuredDefault = dispatchSettings !== null && typeof dispatchSettings.defaultTarget === 'string' && dispatchSettings.defaultTarget.trim() !== '' ? dispatchSettings.defaultTarget.trim() : null
  const targetBranch = taskTarget === null ? (configuredDefault === null ? defaultBranch : configuredDefault) : taskTarget
  const mustResolveRef = taskTarget !== null || (configuredDefault !== null && configuredDefault !== defaultBranch)
  let base = headNow
  if (mustResolveRef) {
    // An explicit target pins the base to THAT branch's head even when the main
    // checkout sits elsewhere; a legacy task keeps the old current-HEAD base.
    const resolved = await git.revParse(projectPath, 'refs/heads/' + targetBranch)
    if (resolved.ok !== true) {
      return worktreeFallback('target-unreadable', targetBranch + ' could not be resolved (' + String(resolved.message) + ')')
    }
    base = resolved
  }
  // T-131: an investigation gets a DETACHED SCRATCH checkout from the target head.
  // No branch means a commit cannot survive: whatever the investigator does is
  // discarded when the card reports (or is cancelled/blocked). Dirty is expected
  // here, so this path never inspects cleanliness and never adopts an old attempt.
  if (task.kind === 'investigate') {
    // The target head is the scratch base. A detached main checkout has no branch
    // name, and then the checkout HEAD is the only base available (same fallback
    // the mergeable path uses for a legacy task).
    let scratchBase = headNow
    if (typeof targetBranch === 'string' && targetBranch !== '') {
      const resolved = await git.revParse(projectPath, 'refs/heads/' + targetBranch)
      if (resolved.ok !== true) {
        return worktreeFallback('target-unreadable', targetBranch + ' could not be resolved for the scratch checkout (' + String(resolved.message) + ')')
      }
      scratchBase = resolved
    }
    const scratchPath = checkoutPathFor(projectPath, task, attempt, dispatch)
    // An earlier attempt may still be registered under <id>-<n> (a host restart
    // refunds the attempt, so slot 2 can follow attempt 1). An investigation never
    // adopts old state: clear those checkouts before adding this one.
    await cleanupInvestigationCheckouts(git, projectPath, task)
    const startedAt = Date.now()
    const budget = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.floor(deadlineMs) : WORKTREE_CREATE_DEADLINE_MS
    const attemptAdd = async () => {
      const added = await serialiseWorktreeCreate(projectPath, () =>
        withinWorktreeDeadline(() => git.worktreeAdd(projectPath, { path: scratchPath, base: scratchBase.hash, detach: true }), budget),
      )
      if (added === WORKTREE_DEADLINE_HIT) {
        return { ok: false, code: 'worktree-add-timeout', message: 'git worktree add did not finish within ' + String(budget) + 'ms' }
      }
      return added
    }
    const first = await attemptAdd()
    if (first.ok === true) {
      return {
        base: scratchBase.hash,
        target: targetBranch,
        branch: null,
        path: first.path === undefined || first.path === null ? scratchPath : first.path,
        keep: true,
        detached: true,
        error: null,
        retried: false,
        cleanup: null,
        elapsedMs: Date.now() - startedAt,
      }
    }
    const cleanup = await rollbackWorktree(git, projectPath, { path: scratchPath, branch: null })
    const second = await attemptAdd()
    if (second.ok === true) {
      return {
        base: scratchBase.hash,
        target: targetBranch,
        branch: null,
        path: second.path === undefined || second.path === null ? scratchPath : second.path,
        keep: true,
        detached: true,
        error: null,
        retried: true,
        cleanup: cleanup,
        elapsedMs: Date.now() - startedAt,
      }
    }
    const lastCleanup = await rollbackWorktree(git, projectPath, { path: scratchPath, branch: null })
    const cleanupNote = cleanup.summary === lastCleanup.summary ? lastCleanup.summary : cleanup.summary + ' | retry: ' + lastCleanup.summary
    return worktreeFallback(
      'worktree-add-failed',
      'scratch worktree add failed after 2 attempts: ' +
        String(second.message) +
        ' (path ' + scratchPath + ', detached, ' + String(Date.now() - startedAt) + 'ms; cleanup: ' + cleanupNote + ')',
    )
  }
  // Handover adoption: a previous attempt that left a COMMIT keeps its checkout,
  // so the next attempt continues that work instead of restarting from the
  // target. The branch must still resolve; anything else falls through to a
  // fresh add, so adoption can never strand a task on a checkout git lost.
  const adopted = await adoptionCandidate(git, projectPath, task, attempt)
  if (adopted !== null) {
    return {
      base: typeof task.base === 'string' && task.base !== '' ? task.base : base.hash,
      target: targetBranch,
      branch: adopted.branch,
      path: adopted.path,
      keep: true,
      error: null,
      adopted: true,
      fromAttempt: adopted.fromAttempt,
      head: adopted.head,
    }
  }
  const branch = 'task/' + String(task.id) + '-' + String(attempt)
  // The checkout directory carries the attempt number: a failed attempt keeps
  // its worktree for inspection, so a retry must not try to re-add the same
  // path. The branch already carries the attempt, so the two stay in step.
  const path = checkoutPathFor(projectPath, task, attempt, dispatch)
  const startedAt = Date.now()
  const budget = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Math.floor(deadlineMs) : WORKTREE_CREATE_DEADLINE_MS
  // Serialised per repository, with its own (wider) budget and a hard deadline:
  // see DEFAULT_WORKTREE_TIMEOUT_MS in git.mjs and serialiseWorktreeCreate above.
  const attemptAdd = async () => {
    const added = await serialiseWorktreeCreate(projectPath, () =>
      withinWorktreeDeadline(() => git.worktreeAdd(projectPath, { path: path, branch: branch, base: base.hash }), budget),
    )
    if (added === WORKTREE_DEADLINE_HIT) {
      return { ok: false, code: 'worktree-add-timeout', message: 'git worktree add did not finish within ' + String(budget) + 'ms' }
    }
    return added
  }
  const first = await attemptAdd()
  if (first.ok === true) {
    return {
      base: base.hash,
      target: targetBranch,
      branch: branch,
      path: first.path === undefined || first.path === null ? path : first.path,
      keep: true,
      error: null,
      retried: false,
      cleanup: null,
      elapsedMs: Date.now() - startedAt,
    }
  }
  // A refused or timed-out add can register a LOCKED worktree and leave the
  // directory behind. Roll the whole attempt back before trying once more, so
  // the retry starts from a clean repository instead of tripping over its own
  // leftovers (the half-built, locked checkout T-41 was paused on).
  const cleanup = await rollbackWorktree(git, projectPath, { path: path, branch: branch })
  const second = await attemptAdd()
  const elapsedMs = Date.now() - startedAt
  if (second.ok === true) {
    return {
      base: base.hash,
      target: targetBranch,
      branch: branch,
      path: second.path === undefined || second.path === null ? path : second.path,
      keep: true,
      error: null,
      retried: true,
      cleanup: cleanup,
      elapsedMs: elapsedMs,
    }
  }
  // The retry failed too: roll its own half-built checkout back as well, so a
  // paused dispatch never inherits a locked worktree from either attempt.
  const lastCleanup = await rollbackWorktree(git, projectPath, { path: path, branch: branch })
  const cleanupNote = cleanup.summary === lastCleanup.summary ? lastCleanup.summary : cleanup.summary + ' | retry: ' + lastCleanup.summary
  return worktreeFallback(
    'worktree-add-failed',
    'worktree add failed after 2 attempts: ' +
      String(second.message) +
      ' (path ' + path + ', branch ' + branch + ', ' + String(elapsedMs) + 'ms; cleanup: ' + cleanupNote + ')',
  )
}

/** A path compared the way git reports it, for the worktree-list check. */
function sameWorktreePath(left, right) {
  const normalize = (value) => String(value === undefined || value === null ? '' : value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

/**
 * Is this checkout still registered with the repository? Returns 'yes', 'no', or
 * 'unknown' when the facade cannot list worktrees (an empty list means "this
 * facade does not report worktrees", so only a non-empty list can prove a path is
 * gone). Never throws: a listing failure is not proof the checkout is gone.
 */
async function worktreeRegistered(git, projectPath, path) {
  if (git === null || git === undefined || typeof git.worktreeList !== 'function') return 'unknown'
  try {
    const listed = await git.worktreeList(projectPath)
    if (listed === null || listed === undefined || listed.ok !== true) return 'unknown'
    const entries = Array.isArray(listed.worktrees) ? listed.worktrees : []
    if (entries.length === 0) return 'unknown'
    return entries.some((entry) => entry !== null && typeof entry === 'object' && sameWorktreePath(entry.path, path)) ? 'yes' : 'no'
  } catch (error) {
    return 'unknown'
  }
}

/**
 * The checkout a handover may reuse. Two cases:
 *
 *   - the previous attempt left a COMMIT: continue that work (the branch must
 *     still resolve, so adoption can never strand a task on a checkout git lost);
 *   - the previous attempt left a CLEAN checkout with nothing committed (the
 *     host was restarted before the worker produced anything): reuse it instead
 *     of adding a second worktree for the same card. A dirty checkout is never
 *     adopted — a half-finished edit must not be silently inherited.
 *
 * Returns null when there is nothing safe to adopt, which is the signal to
 * prepare a fresh worktree.
 */
async function adoptionCandidate(git, projectPath, task, attempt) {
  if (Number.isFinite(attempt) && attempt <= 1) return null
  if (typeof task.branch !== 'string' || task.branch === '') return null
  if (typeof task.worktree !== 'string' || task.worktree === '') return null
  if (git === null || git === undefined) return null
  let resolved = null
  try {
    resolved = typeof git.revParse === 'function' ? await git.revParse(projectPath, task.branch) : null
  } catch (error) {
    return null
  }
  if (resolved === null || resolved === undefined || resolved.ok !== true) return null
  if ((await worktreeRegistered(git, projectPath, task.worktree)) === 'no') return null
  const committed = typeof task.commit === 'string' && task.commit !== ''
  if (committed) return { branch: task.branch, path: task.worktree, fromAttempt: task.attempts, head: task.commit }
  if (typeof git.isClean !== 'function') return null
  let clean = null
  try {
    clean = await git.isClean(task.worktree)
  } catch (error) {
    return null
  }
  if (clean === null || clean === undefined || clean.ok !== true || clean.clean !== true) return null
  return { branch: task.branch, path: task.worktree, fromAttempt: task.attempts, head: null, reuseClean: true }
}

/** Force-remove one worktree, ignoring every failure: a cleanup path must never
 * fail a dispatch. Creation-time rollback is `rollbackWorktree` below. */
async function removeWorktree(git, projectPath, path) {
  if (git === undefined || git === null || typeof path !== 'string' || path === '') return false
  if (typeof git.worktreeRemove !== 'function') return false
  try {
    const outcome = await git.worktreeRemove(projectPath, path, { force: true })
    // A refusal is reported, never thrown: callers use it for their note only.
    return outcome === undefined || outcome === null ? true : outcome.ok !== false
  } catch (error) {
    return false
  }
}

/**
 * Best-effort rollback of a failed worktree attempt, in the order that actually
 * works: unlock (git registers a checkout as locked when an add is interrupted)
 * -> force-remove the directory -> delete the attempt branch -> prune the
 * administrative entry. Every step is optional and a failure is RECORDED, never
 * thrown: the caller needs a report it can put in the note, not a crash. The
 * leftover check is what proves the half-built checkout is really gone.
 */
async function rollbackWorktree(git, projectPath, options) {
  const path = String(options.path)
  // A detached scratch checkout (T-131) has no branch: there is nothing to
  // delete, and String(null) would become the literal branch name "null".
  const branch = typeof options.branch === 'string' && options.branch !== '' ? options.branch : null
  const steps = []
  const step = (name, ok, detail) => {
    steps.push({ name: name, ok: ok === true, detail: detail === undefined || detail === null ? null : String(detail) })
  }

  if (typeof git.worktreeUnlock === 'function') {
    try {
      const unlocked = await git.worktreeUnlock(projectPath, path)
      // "not locked" is a success for a rollback, not a failure.
      step('unlock', unlocked !== null && unlocked !== undefined && (unlocked.ok === true || unlocked.unlocked === false), unlocked === undefined ? null : unlocked.message)
    } catch (error) {
      step('unlock', false, (error && error.message) || error)
    }
  }
  if (typeof git.worktreeRemove === 'function') {
    try {
      const removed = await git.worktreeRemove(projectPath, path, { force: true })
      step('remove', removed !== null && removed !== undefined && removed.ok === true, removed === undefined ? null : removed.message)
    } catch (error) {
      step('remove', false, (error && error.message) || error)
    }
  }
  if (branch !== null && typeof git.deleteBranch === 'function') {
    try {
      const deleted = await git.deleteBranch(projectPath, branch, { force: true })
      step('branch-delete', deleted !== null && deleted !== undefined && deleted.ok === true, deleted === undefined ? null : deleted.message)
    } catch (error) {
      step('branch-delete', false, (error && error.message) || error)
    }
  }
  if (typeof git.worktreePrune === 'function') {
    try {
      const pruned = await git.worktreePrune(projectPath)
      step('prune', pruned !== null && pruned !== undefined && pruned.ok === true, pruned === undefined ? null : pruned.message)
    } catch (error) {
      step('prune', false, (error && error.message) || error)
    }
  }

  // Did anything survive? Reported in the note so "cleaned up" is verifiable.
  let leftovers = 'unchecked'
  if (typeof git.worktreeList === 'function') {
    try {
      const listed = await git.worktreeList(projectPath)
      if (listed !== null && listed !== undefined && listed.ok === true && Array.isArray(listed.worktrees)) {
        const surviving = listed.worktrees.filter((entry) => entry !== null && typeof entry === 'object' && sameWorktreePath(entry.path, path))
        leftovers = surviving.length === 0 ? 'none' : surviving.map((entry) => String(entry.path)).join(', ')
      }
    } catch (error) {
      leftovers = 'unknown'
    }
  }
  const summary =
    steps.length === 0 ? 'no cleanup command available; leftovers: ' + leftovers : steps.map((entry) => entry.name + '=' + (entry.ok ? 'ok' : 'failed')).join(' ') + '; leftovers: ' + leftovers
  return { ok: leftovers === 'none', steps: steps, leftovers: leftovers, summary: summary }
}

export function spawnPreamble(name, leadName) {
  return [
    '<system-reminder>',
    'You are teammate "' + name + '".',
    'Your Team Lead is named "' + (leadName === undefined || leadName === null ? 'lead' : leadName) + '".',
    'Use list_agents({}) to find your teammates and their names.',
    'To message your Team Lead, use send_message({ target: "' + (leadName === undefined || leadName === null ? 'lead' : leadName) + '", message: "..." }).',
    '</system-reminder>',
    '',
  ].join('\n')
}

/**
 * The host-fixed RULES, shared by the role brief and the per-task worker brief.
 * These are constraints/instructions, NOT skills: they must not be presented as
 * skill names in the panel (T-148).
 */
function roleRulesSection(hasSkills) {
  const lines = ['Rules:', '- task_center is your only interface to the board.']
  // T-149: the load instruction only makes sense when a Skills block follows it.
  if (hasSkills === true) lines.push('- Use the skill tool to load the skills listed below before acting.')
  return lines.join('\n')
}

/**
 * The SKILLS injection: real skill names only, one per line. T-149: the host
 * runtime skill is the LEAD's guide (its body starts with 「你是谁：Lead」), so only
 * the lead kind lists it. Worker/reviewer/tester list their profile's project
 * skills only; with none, the whole Skills block is empty (no fake bullet).
 *
 * Listing a skill is NOT loading it: the body arrives only when the agent calls
 * the skill tool, and only if the host catalog exposes it. Selecting a skill in
 * a profile is a prompt recommendation, NOT an authorization ("勾选 ≠ 授权"):
 * the hard boundaries are host catalog/tool availability and the task_center
 * action role gate — never this skills list.
 */
function roleSkillsSection(profile, kind) {
  const names = []
  const add = function (name) {
    const value = typeof name === 'string' ? name.trim() : ''
    if (value !== '' && names.indexOf(value) < 0) names.push(value)
  }
  if (kind === 'lead') add(SKILL_NAME)
  const listed = profile !== null && profile !== undefined && Array.isArray(profile.skills) ? profile.skills : []
  listed.forEach(add)
  if (names.length === 0) return ''
  return ['Skills:'].concat(names.map(function (name) { return '- ' + name })).join('\n')
}

/**
 * The assignee brief split into the parts the agent reads, generated in ONE
 * place. briefFor joins the parts; the panel previews the same parts, so the
 * text a worker actually wakes with and the text the panel shows can never
 * disagree. Groups let the panel label a part as task data or host-fixed copy.
 *
 * roleConfig is optional: passing it injects the worker profile's rendered prompt
 * (variables substituted) and its skills section, which is what the implement
 * stage now really sends. Omitting it keeps the legacy brief byte-identical.
 */
export function briefPartsFor(task, projectPath, leadName, roleConfig) {
  const config = roleConfig === undefined || roleConfig === null ? null : roleConfig
  const profile = config === null ? null : profileForKind(config, 'worker')
  const parts = []
  if (config === null) {
    // Legacy brief (no role config): byte-identical to the pre-role generation.
    parts.push({ key: 'header', group: 'role', text: 'Task ' + task.id + ': ' + task.title })
    parts.push({
      key: 'project',
      group: 'role',
      text: 'Project: ' + projectPath + '\nYou have been assigned this task. Do the work in that project.',
    })
  } else {
    // The role identity header must not carry the task title: it belongs to the
    // task data, together with the project/assignment lines.
    parts.push({ key: 'header', group: 'role', text: 'Task center role: worker\nStage: implement (this role owns the implement stage)' })
  }
  if (profile !== null && profile !== undefined && typeof profile.prompt === 'string' && profile.prompt !== '') {
    const rendered = renderRoleTemplate(profile.prompt, roleTemplateValuesFor('worker', task, config, { projectPath: projectPath, leadName: leadName }))
    if (rendered !== '') parts.push({ key: 'template', group: 'template', text: 'Profile instructions:\n' + rendered })
  }
  if (config !== null) {
    parts.push({
      key: 'task',
      group: 'task',
      text:
        'Task ' + task.id + ': ' + task.title + '\n\nProject: ' + projectPath +
        '\nYou have been assigned this task. Do the work in that project.' +
        '\nFirst call task_center { action: "openProject", path: "' + projectPath + '" } so the board and the dispatch settings belong to that project.',
    })
  }
  if (typeof task.worktree === 'string' && task.worktree.length > 0) {
    parts.push({
      key: 'worktree',
      group: 'task',
      text: [
        'Work in the git worktree created for this task:',
        '  worktree: ' + task.worktree,
        '  branch:   ' + String(task.branch === null || task.branch === undefined ? '' : task.branch),
        '  base:     ' + String(task.base === null || task.base === undefined ? '' : task.base),
        'Change files ONLY inside that worktree, and run the tests there.',
        'The task board still lives in the main project — point task_center at',
        'the main project ("' + projectPath + '"), not at the worktree.',
      ].join('\n'),
    })
  }
  if (task.spec !== '') parts.push({ key: 'spec', group: 'task', text: 'What it involves:\n' + task.spec })
  if (task.acceptance !== '') parts.push({ key: 'acceptance', group: 'task', text: 'How it will be judged:\n' + task.acceptance })
  if (task.dependsOn.length > 0) parts.push({ key: 'prerequisites', group: 'task', text: 'Completed prerequisites: ' + task.dependsOn.join(', ') })
  if (task.writeFiles.length > 0) {
    parts.push({ key: 'locks', group: 'task', text: 'The scheduler holds these file locks for you:\n' + task.writeFiles.join(', ') })
  }
  parts.push({
    key: 'report',
    group: 'fixed',
    text: [
      'Report with the task_center tool:',
      '  task_center { action: "get", id: "' + task.id + '" }',
      '  task_center { action: "submit", id: "' + task.id + '", evidence: "what you changed and how you checked it" }',
      '',
      'submit is the last step of THIS round: it moves the task to REVIEW, then',
      'TESTING. A review that requests changes or a failed test returns the task to',
      'running — keep working in the same worktree and submit again. The merge',
      'request only becomes mergeable once the TEST phase passes; the host then',
      'merges it automatically. Do not commit after a passing test.',
      'Your merge request records the head submit committed, and a merge is refused',
      'while the branch has moved past it (head-drift). If you must repair the',
      'request explicitly, use:',
      '  task_center { action: "refreshMerge", id: "' + task.id + '" }',
      'That re-points the merge request and starts a fresh review round — it never',
      'commits, merges or pushes.',
      '',
      'Before writing any file that is not in the locked list, call:',
      '  task_center { action: "lock", paths: ["path/to/file"] }',
      'and unlock it when you are done. Any task_center call renews your lease; a long task should call get periodically.',
      '',
      'Do NOT dispatch anything yourself. You are the assignee, not the scheduler.',
    ].join('\n'),
  })
  if (config !== null) {
    // T-148/T-149: rules and skills are separate parts, rules first. A worker
    // brief lists only the profile's project skills; the lead guide stays with
    // the Lead. Skills is omitted entirely when empty.
    const skills = roleSkillsSection(profile, 'worker')
    parts.push({ key: 'rules', group: 'rules', text: roleRulesSection(skills !== '') })
    if (skills !== '') parts.push({ key: 'skills', group: 'skills', text: skills })
  }
  return parts
}

/** What the assignee is told. It has to stand alone: the agent wakes with no
 * context beyond this message. roleConfig is optional and backward compatible:
 * omitting it returns exactly the pre-role-prompt brief. */
export function briefFor(task, projectPath, leadName, roleConfig) {
  return briefPartsFor(task, projectPath, leadName, roleConfig).map((part) => part.text).join('\n\n')
}

/**
 * The host-fixed brief for an investigation card (T-131). It is NOT generated
 * from a role template: the boundaries below are the contract, and a profile
 * cannot turn an investigation into "commit and submit".
 */
export function investigationBriefFor(task, projectPath, worktree) {
  const info = worktree === undefined || worktree === null ? {} : worktree
  const scratch =
    typeof info.path === 'string' && info.path !== ''
      ? info.path
      : typeof task.worktree === 'string' && task.worktree !== ''
        ? task.worktree
        : '(the host creates .worktrees/' + String(task.id) + '-<attempt> before you start)'
  const base = typeof info.base === 'string' && info.base !== '' ? info.base : typeof task.base === 'string' && task.base !== '' ? task.base : '(the target head)'
  const target =
    typeof info.target === 'string' && info.target !== '' ? info.target : typeof task.target === 'string' && task.target !== '' ? task.target : '(the project default target)'
  const root = /[\\/]/.test(scratch) ? scratch.replace(/[\\/][^\\/]*$/, '') : '.'
  const parts = []
  parts.push('Task center — investigation card ' + String(task.id))
  parts.push('Title: ' + String(task.title))
  parts.push('Project: ' + String(projectPath))
  parts.push('Scratch checkout: ' + scratch + ' (detached at ' + base + ', target ' + target + ')')
  parts.push('')
  parts.push('## What this card is')
  parts.push('- You are investigating, not implementing: the deliverable is a REPORT, not a branch.')
  parts.push('- Do NOT commit. Do NOT submit. Do NOT ask for a merge. This card has no review, no test and no merge phase.')
  parts.push('')
  parts.push('## Where to work')
  parts.push('- Only inside the scratch checkout above. It is DETACHED: a commit there cannot reach a branch and is discarded at the end.')
  parts.push('- Running commands, editing code and creating scratch subdirectories inside it is expected; the checkout may be dirty.')
  parts.push('- If you need a second clean checkout, create it ONLY at ' + root + '/probe-' + String(task.id) + '-* (git worktree add --detach …) and list every such path in the report artifacts.')
  parts.push('')
  parts.push('## The question')
  if (typeof task.spec === 'string' && task.spec.trim() !== '') parts.push(task.spec.trim())
  if (typeof task.acceptance === 'string' && task.acceptance.trim() !== '') {
    parts.push('')
    parts.push('What "answered" means: ' + task.acceptance.trim())
  }
  parts.push('')
  parts.push('## Deliver the report')
  parts.push('task_center { action: "report", id: "' + String(task.id) + '", summary: "…", body: "…", evidence: [{ command, exitCode, outputTail }], artifacts: ["…"] }')
  parts.push('- summary: the answer, at most 4 KB. body: the full write-up (the host stores it in .agents/reports/' + String(task.id) + '.md).')
  parts.push('- evidence: up to 20 rows { command, exitCode, outputTail } — the commands you actually ran.')
  parts.push('- artifacts: paths you created (probe checkouts, saved outputs).')
  parts.push(
    '- When the report lands the host force-removes the scratch checkout and every probe-' +
      String(task.id) +
      '-*; anything committed in the scratch is recorded as a probeCommits warning and discarded.',
  )
  return parts.join('\n')
}


/**
 * The values a role prompt template's {{VARIABLES}} resolve to for one task. The
 * brief substitutes them; the panel's template block keeps the literal {{NAME}}
 * so the injection points stay visible. A value the task does not carry resolves
 * to an empty string instead of a token the host cannot fill.
 */
export function roleTemplateValuesFor(kind, task, config, options) {
  const opts = options === undefined || options === null ? {} : options
  const profile = config !== null && config !== undefined ? (kind === 'lead' ? null : profileForKind(config, kind)) : null
  const stage = profile !== null && profile !== undefined && typeof profile.stage === 'string' ? profile.stage : kind === 'lead' ? 'lead' : ROLE_STAGE[kind] === undefined ? 'implement' : ROLE_STAGE[kind]
  const source = task === null || task === undefined ? null : task
  const text = (value) => (typeof value === 'string' ? value : '')
  return {
    TASK_ID: source === null ? '' : text(source.id),
    TASK_TITLE: source === null ? '' : text(source.title),
    SPEC: source === null ? '' : text(source.spec),
    COMPLETIONS_DEF: source === null ? '' : text(source.acceptance),
    GIT_INFO: gitInfoFor(source),
    PROJECT: text(opts.projectPath),
    LEAD: text(opts.leadName),
    ROLE: String(kind),
    STAGE: stage,
  }
}

/** One line of task-checkout facts for {{GIT_INFO}}, or '' without a task. */
function gitInfoFor(task) {
  if (task === null || task === undefined) return ''
  const value = (entry) => (typeof entry === 'string' && entry !== '' ? entry : '(none)')
  return 'branch ' + value(task.branch) + ' · worktree ' + value(task.worktree) + ' · base ' + value(task.base) + ' · commit ' + value(task.commit)
}

/**
 * The brief split into named parts, generated in ONE place so the model's brief
 * and the panel's context editor can never disagree. The order is fixed:
 *
 *   header (role/stage/project/lead) → profile meta (permissions, fork note)
 *   → the editable profile template (variables substituted)
 *   → the task data → the host-fixed permission boundary / verdict schema
 *   → the host-fixed skills injection.
 *
 * Only 'template' is editable. Every other part is host copy: the panel renders
 * those blocks read-only, and a template can never overwrite them. The reviewer
 * and tester working instructions are NOT host copy anymore: they are the
 * built-in profile prompt (see schema.DEFAULT_ROLE_PROMPTS), so the user can
 * read, fork and edit them. The worker's fixed duties stay here until the
 * implement stage is wired to the role system.
 */
export function roleBriefSections(kind, task, config, options) {
  const opts = options === undefined || options === null ? {} : options
  // T-149: 'lead' is not a provisioned role profile (ROLE_KINDS is worker/
  // reviewer/tester), but the same section builder can describe the Lead: no
  // editable profile, stage 'lead', and the host runtime skill in Skills.
  const profile =
    config !== null && config !== undefined
      ? kind === 'lead'
        ? config.profiles !== null && config.profiles !== undefined && config.profiles.lead !== undefined
          ? config.profiles.lead
          : null
        : profileForKind(config, kind)
      : null
  const stage = profile !== null && profile !== undefined && typeof profile.stage === 'string' ? profile.stage : kind === 'lead' ? 'lead' : ROLE_STAGE[kind] === undefined ? 'implement' : ROLE_STAGE[kind]
  const header = []
  header.push('Task center role: ' + String(kind))
  header.push('Stage: ' + stage + ' (this role owns the ' + stage + ' stage; role profiles replace manual Lead spawns).')
  if (typeof opts.projectPath === 'string' && opts.projectPath.length > 0) {
    header.push('Project: ' + opts.projectPath)
    header.push('First action: task_center { action: "openProject", path: "' + opts.projectPath + '" } so the board you act on is this project.')
  }
  if (typeof opts.leadName === 'string' && opts.leadName.length > 0) header.push('Team Lead: ' + opts.leadName)
  const meta = []
  if (profile !== null && profile !== undefined && Array.isArray(profile.permissions) && profile.permissions.length > 0) {
    meta.push('Profile permissions: ' + profile.permissions.join(', '))
  }
  if (profile !== null && profile !== undefined && profile.context === 'fork') {
    meta.push('Profile context: forked from the Lead (not a fresh context).')
  }
  const template = profile !== null && profile !== undefined && typeof profile.prompt === 'string' ? profile.prompt : ''
  const templateRendered = renderRoleTemplate(template, roleTemplateValuesFor(kind, task, config, opts))
  const taskData = []
  if (task === null || task === undefined) {
    // A role child can wake with NO card. It must
    // stand by instead of hunting for work (and must never be handed a fake card
    // id to pretend it has one).
    taskData.push('Stand by: this role slot is ready and there is no card yet.')
    taskData.push('')
    taskData.push('Do NOT look for a card, do NOT call submit, do NOT edit files, and do not create work: the Lead dispatches a card when one exists. Wait for the dispatch message from the Lead.')
  } else {
    taskData.push('Task ' + String(task.id) + ': ' + String(task.title))
    if (typeof task.spec === 'string' && task.spec !== '') taskData.push('', 'What it involves:', task.spec)
    if (typeof task.acceptance === 'string' && task.acceptance !== '') taskData.push('', 'Acceptance:', task.acceptance)
    if (typeof task.worktree === 'string' && task.worktree !== '') {
      taskData.push('', 'Worktree: ' + task.worktree)
      taskData.push('Branch: ' + String(task.branch === null || task.branch === undefined ? '' : task.branch))
      taskData.push('Commit: ' + String(task.commit === null || task.commit === undefined ? '' : task.commit))
    }
    const rework =
      (task.review !== null && task.review !== undefined && task.review.status === 'changes-requested') ||
      (task.test !== null && task.test !== undefined && task.test.status === 'failed')
    if (rework) {
      taskData.push('', 'This is REWORK: continue in the SAME worktree and the SAME context you used before; do not create a new branch or start from a fresh checkout.')
    }
  }
  const fixed = []
  if (kind === 'worker' && (task === null || task === undefined)) {
    // A bootstrapped worker has no card: the per-task duties and verdict schema
    // below would point at a task id that does not exist, so this slot gets the
    // standby boundary instead.
    fixed.push(
      'Duties: stand by. This slot is ready; there is no card for it yet.',
      '',
      'Do not look for a card, do not call submit, do not edit files, and do not create work: the Lead sends a dispatch message with a task id when one exists. When the card arrives, its brief carries the worktree, the locked files, the permission boundary and the verdict schema.',
    )
  } else if (kind === 'worker') {
    fixed.push(
      'Duties: implement the task in its worktree, run the project tests there, and report with task_center submit.',
      '',
      'Permission boundary (hard):',
      '- You may edit files and commit only inside the task worktree.',
      '- You must NOT approve or reject the review or test verdict for your own task; a separate reviewer and tester decide those.',
      '- A reviewer or tester never asks you to write their verdict, and you must not write it for them.',
      '',
      'Verdict schema (your report):',
      '  task_center { action: "submit", id: "<task>", evidence: "what changed and how you checked it" }',
    )
  } else if (kind === 'reviewer') {
    // The working instructions live in the built-in profile prompt (and in every
    // fork of it); the host-fixed part keeps only what a template must not
    // rewrite: the hard boundary and the verdict schema.
    fixed.push(
      'Permission boundary (hard):',
      '- READ-ONLY on implementation: do NOT edit files, do NOT commit, do NOT merge or push, do NOT change the task branch.',
      '- The only task actions you may call are approveReview and requestChanges.',
      '- A worker can never review its own task; you are the independent reviewer.',
      '',
      'Verdict schema (structured ReviewRecord; free-text-only verdicts are refused):',
      '  task_center { action: "approveReview", id: "<task>", checked: [{ criterion, method, result }], findings: [{ severity: "non-blocking", file, line, text }], residualRisks: [text] }',
      '  task_center { action: "requestChanges", id: "<task>", findings: [{ severity: "blocking", file, line, text }], checked: [], residualRisks: [text] }',
    )
  } else if (kind === 'tester') {
    fixed.push(
      'Permission boundary (hard):',
      '- READ-ONLY on implementation: do NOT edit files, do NOT commit, do NOT merge or push, do NOT change the task branch.',
      '- The only task actions you may call are passTest and failTest.',
      '- A worker can never test its own task; you are the independent tester.',
      '',
      'Verdict schema (structured TestRecord; an empty probe list is refused):',
      '  task_center { action: "passTest", id: "<task>", probes: [{ id, command, exitCode, tail }], adversarial: [{ id, command, exitCode, tail }], hostCheckRef, notes }',
      '  task_center { action: "failTest", id: "<task>", probes: [{ id, command, exitCode, tail }] }',
      'Every probe id the CandidateArtifact declares must appear in probes: the tester executes them in the candidate checkout.',
    )
  } else {
    fixed.push('Duties: follow the task center board for this role.')
  }
  return {
    kind: String(kind),
    stage: stage,
    profileName: profile !== null && profile !== undefined && typeof profile.name === 'string' ? profile.name : String(kind),
    header: header.join('\n'),
    meta: meta.join('\n'),
    template: template,
    templateRendered: templateRendered,
    taskData: taskData.join('\n'),
    fixed: fixed.join('\n'),
    rules: roleRulesSection(roleSkillsSection(profile, kind) !== ''),
    skills: roleSkillsSection(profile, kind),
  }
}

/**
 * The brief a role teammate wakes with. It is self-contained: the role, the
 * stage it owns, the task it is being handed (when there is one), the hard
 * permission boundary, the exact verdict schema and the skills to load.
 *
 * The parts come from roleBriefSections in a fixed order: the host header and
 * profile meta first, then the editable template with its variables substituted,
 * then the task data, then the host-fixed duties/permission boundary/verdict and
 * the skills injection. Only the template is user-editable.
 *
 * Reviewer and tester briefs explicitly demand a FRESH independent context.
 * A worker brief on rework says to continue in the SAME worktree/context.
 */
export function roleBriefFor(kind, task, config, options) {
  return roleBriefPartsFor(kind, task, config, options).map((part) => part.text).join('\n\n')
}

/**
 * The role brief split into its ordered parts. roleBriefFor joins them, so the
 * text the role teammate wakes with and the text the panel previews are the
 * same generation path. Only the template part is user copy; the groups let the
 * panel label a part as the user's own text, task data or host-fixed copy.
 */
export function roleBriefPartsFor(kind, task, config, options) {
  const sections = roleBriefSections(kind, task, config, options)
  // The group is the section's meaning, not its position: the header/assignment
  // is the role itself, the prompt is the user's template, task data is filled
  // per task, the boundary/verdict is host-fixed and skills are host-injected.
  const parts = [{ key: 'header', group: 'role', text: sections.header }]
  if (sections.meta !== '') parts.push({ key: 'meta', group: 'role', text: sections.meta })
  // The fresh-context note belongs to the ROLE block, not after the skills
  // injection: keeping every 'role' part contiguous is what lets the panel show
  // one 角色与阶段 label for the whole block.
  if (kind === 'reviewer' || kind === 'tester') {
    parts.push({
      key: 'fresh-context',
      group: 'role',
      text: 'You are an independent, FRESH context: do not assume the worker conversation, and do not reuse its unstated context.',
    })
  }
  if (sections.template !== '') parts.push({ key: 'template', group: 'template', text: 'Profile instructions:\n' + sections.templateRendered })
  if (sections.taskData !== '') parts.push({ key: 'task', group: 'task', text: sections.taskData })
  parts.push({ key: 'duties', group: 'fixed', text: sections.fixed })
  parts.push({ key: 'rules', group: 'rules', text: sections.rules })
  if (sections.skills !== '') parts.push({ key: 'skills', group: 'skills', text: sections.skills })
  return parts
}

/**
 * The task a preview falls back to when the board has no task at all. It is a
 * REALISTIC card on purpose: every field a brief reads is filled with concrete
 * values, so the injected text shows its true shape instead of angle-bracket
 * placeholders. It is never a board task and never dispatched; the API marks it
 * real:false / sample:true so the panel can say it is an example.
 */
export const ROLE_SAMPLE_TASK = {
  id: 'T-42',
  title: 'Enemy patrol chases the player',
  status: 'running',
  priority: 5,
  dependsOn: ['T-39'],
  spec: 'Add a patrol state to the enemy controller: walk between two waypoints, notice the player within 6 m, and chase for 3 s before returning to patrol.',
  acceptance: 'npm run verify passes. In the demo scene the enemy walks both waypoints, chases the player when it gets close, and never leaves the navmesh.',
  writeFiles: ['scripts/enemy/patrol.gd', 'scripts/enemy/enemy.gd', 'scenes/demo.tscn'],
  actualFiles: ['scripts/enemy/patrol.gd', 'scripts/enemy/enemy.gd'],
  branch: 'task/T-42-1',
  worktree: 'C:/projects/godot-demo/.worktrees/T-42',
  commit: '4f3a9c2e7b1d8a6c5e0f9b7d3a1c8e2f6b4d0a95',
  base: '9c1d7ab3e5f24c8d0a6b3f9e7c2d1a8b5e4f0c36',
  target: 'feat/patrol-ai',
  evidence: 'npm run verify: 26 test files pass, 0 failures. Manual check in demo.tscn: patrol and chase work, navmesh untouched.',
  review: { status: 'pending', by: null, at: null, reasons: null, attempt: 1 },
  test: { status: 'pending', by: null, at: null, evidence: null, attempt: 1 },
  merge: {
    status: 'open',
    base: '9c1d7ab3e5f24c8d0a6b3f9e7c2d1a8b5e4f0c36',
    target: 'feat/patrol-ai',
    head: '4f3a9c2e7b1d8a6c5e0f9b7d3a1c8e2f6b4d0a95',
    mergeCommit: null,
    declaredFiles: ['scripts/enemy/patrol.gd', 'scripts/enemy/enemy.gd', 'scenes/demo.tscn'],
    actualFiles: ['scripts/enemy/patrol.gd', 'scripts/enemy/enemy.gd'],
    tests: 'npm run verify',
    reviewer: null,
    conflict: null,
    output: null,
    at: '2026-10-19T09:20:00.000Z',
  },
  assignee: { name: 'work-t42-1', session: 'session-t42-1' },
  attempts: 1,
  maxAttempts: 3,
  leaseUntil: '2026-10-19T09:50:00.000Z',
  dispatch: { status: 'claimed', at: '2026-10-19T09:00:00.000Z', target: 'work-t42-1', targetId: 'session-t42-1', via: 'spawn', error: null, host: 'host-1' },
  createdAt: '2026-10-19T08:55:00.000Z',
  updatedAt: '2026-10-19T09:20:00.000Z',
  createdBy: '@lead',
  history: [
    { at: '2026-10-19T08:55:00.000Z', by: '@lead', from: null, to: 'pending', note: 'created' },
    { at: '2026-10-19T09:00:00.000Z', by: 'scheduler', from: 'pending', to: 'running', note: 'dispatched to work-t42-1' },
  ],
}


/**
 * Read-only preview of the context the host actually injects for a role profile.
 * It calls the real brief builders with a clearly-marked placeholder task, so
 * the panel can show what the agent receives instead of an empty profile prompt.
 *
 * It also returns the same brief split into blocks — fixed host copy, the
 * editable template and the task data — plus the variable catalog, which is what
 * the context editor renders. The template block keeps its literal {{NAME}}
 * tokens: the panel must show the injection points, and every fixed block is
 * real host brief text rather than a hand-written copy of it.
 */
export function roleContextPreview(config, kind, options) {
  const opts = options === undefined || options === null ? {} : options
  const named =
    typeof opts.profileName === 'string' && config !== null && config !== undefined && config.profiles !== null && config.profiles !== undefined && config.profiles[opts.profileName] !== undefined
      ? config.profiles[opts.profileName]
      : null
  let profile =
    config !== null && config !== undefined
      ? kind === 'lead'
        ? (config.profiles !== null && config.profiles !== undefined && config.profiles.lead !== undefined ? config.profiles.lead : null)
        : profileForKind(config, kind)
      : null
  let scoped = config
  if (named !== null) {
    profile = named
    const stage = typeof profile.stage === 'string' ? profile.stage : kind === 'lead' ? 'lead' : ROLE_STAGE[kind] === undefined ? 'implement' : ROLE_STAGE[kind]
    scoped = Object.assign({}, config, { stages: Object.assign({}, config.stages, { [stage]: opts.profileName }) })
  }
  const placeholder = {
    id: 'T-?',
    title: 'Example task (placeholder)',
    status: 'running',
    priority: 0,
    spec: '<example spec: what this task involves>',
    acceptance: '<example acceptance: how completion is judged>',
    writeFiles: ['scripts/example.gd'],
    actualFiles: ['scripts/example.gd'],
    branch: 'task/T-?-1',
    worktree: '<task worktree>',
    commit: '<commit>',
    base: '<base>',
    target: 'main',
    evidence: '<worker evidence would appear here>',
    review: { status: 'pending', attempt: 1 },
    merge: { status: 'open', base: '<base>', target: 'main', head: '<head>', mergeCommit: null },
    test: { status: 'pending', attempt: 1 },
  }
  const briefOptions = { projectPath: opts.projectPath }
  const sections = roleBriefSections(kind, placeholder, scoped, briefOptions)
  const entries = [
    {
      key: 'role',
      label: 'Role brief (provisioning)',
      text: roleBriefFor(kind, placeholder, scoped, briefOptions),
    },
  ]
  if (kind === 'reviewer') {
    entries.push({ key: 'stage', label: 'Review round brief', text: reviewBriefFor(placeholder, opts.projectPath) })
  }
  if (kind === 'tester') {
    entries.push({
      key: 'stage',
      label: 'Test round brief',
      text: testerBriefFor(placeholder, opts.projectPath, { path: '<test candidate worktree>', branch: 'test/T-?', base: '<base>', head: '<candidate head>' }, {}),
    })
  }
  const variableCatalog = ROLE_TEMPLATE_VARIABLES.map((entry) => ({ name: entry.name, description: entry.description, sample: entry.sample }))
  const blocks = [
    { key: 'header', type: 'fixed', title: 'Fixed header (host: role, stage, project, lead)', text: sections.header, editable: false },
    { key: 'meta', type: 'fixed', title: 'Fixed profile meta (host: permissions, context)', text: sections.meta, editable: false },
    { key: 'template', type: 'template', title: 'Editable template (profile.prompt)', text: sections.template, editable: true },
    { key: 'task', type: 'task', title: 'Task data (host: spec, acceptance, worktree)', text: sections.taskData, editable: false },
    { key: 'duties', type: 'fixed', title: 'Fixed duties / permission boundary / verdict (host)', text: sections.fixed, editable: false },
    { key: 'rules', type: 'fixed', title: 'Fixed rules (host: board interface, skill loading)', text: sections.rules, editable: false },
  ]
  // T-149: no profile skills means no Skills block at all (no empty section).
  if (sections.skills !== '') blocks.push({ key: 'skills', type: 'fixed', title: 'Fixed skills injection (host: real skill names)', text: sections.skills, editable: false })
  return {
    name: named !== null ? String(opts.profileName) : profile !== null && profile !== undefined && typeof profile.name === 'string' ? profile.name : String(kind),
    kind: String(kind),
    stage: profile !== null && profile !== undefined && typeof profile.stage === 'string' ? profile.stage : null,
    placeholderTask: { id: placeholder.id, title: placeholder.title },
    profilePrompt: sections.template,
    variableCatalog: variableCatalog,
    templateVariables: roleTemplateVariables(sections.template),
    blocks: blocks,
    placeholder: true,
    entries: entries,
  }
}

/**
 * The per-round REVIEW brief the host sends the reviewer when a task enters
 * review (submit, or a refreshed head/base). It is self-contained: what the
 * task asked for, the tree under review, the worker's evidence, the project
 * conventions and a checklist — no full test run is expected at this stage.
 */
// ── mechanical verification (the host's own check) ──────────────────────────

/** The last `maxBytes` of `text`, cut on a line boundary when possible. */
function verifyTailOf(text, maxBytes) {
  const trimmed = String(text === undefined || text === null ? '' : text).replace(/[ \t]+$/gm, '').replace(/\s+$/, '')
  if (trimmed === '') return ''
  if (Buffer.byteLength(trimmed, 'utf8') <= maxBytes) return trimmed
  const lines = trimmed.split('\n')
  const kept = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(lines[index], 'utf8') + 1
    if (kept.length > 0 && used + size > maxBytes) break
    kept.unshift(lines[index])
    used += size
    if (used >= maxBytes) break
  }
  const text_ = kept.join('\n')
  if (text_ !== '' && Buffer.byteLength(text_, 'utf8') <= maxBytes) return text_
  // A single line longer than the budget: keep its LAST bytes (the failure line).
  const buffer = Buffer.from(trimmed, 'utf8')
  let start = Math.max(0, buffer.length - maxBytes)
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

/** Read whatever the collected streams hold; a missing collector loses output,
 * never the exit code. */
function readCollected(handle) {
  const out = { stdout: '', stderr: '' }
  try {
    if (handle !== null && handle !== undefined && handle.collected) {
      if (handle.collected.stdout && typeof handle.collected.stdout.readFrom === 'function') out.stdout = handle.collected.stdout.readFrom(0).text || ''
      if (handle.collected.stderr && typeof handle.collected.stderr.readFrom === 'function') out.stderr = handle.collected.stderr.readFrom(0).text || ''
    }
  } catch (error) {
    // Output is diagnostic only; the exit code is the verdict.
  }
  return out
}

/**
 * Run one task's declared mechanical verification inside its test candidate.
 *
 * This is a HOST action, not a model decision: the command is a shell string
 * (it may chain, e.g. "npm run verify && npm run e2e") executed through the
 * unconfined subprocess service, exactly as declared. The result is recorded on
 * the task (test.hostCheck) so neither the tester nor the reviewer has to spend
 * a round re-running it.
 *
 * @returns { ok: true, check } with the record, or { ok: false, code, message }
 *   when the check could not run at all (no subprocess service, no candidate).
 */
/**
 * T-156: the stable fingerprint of a verify declaration, including the contents
 * of the script files it names (when those exist). One definition shared by
 * dispatch, submit and the candidate/rebuild audit, so the baseline and the
 * comparison can never drift apart.
 */
export async function verifyFingerprintFor(ctx, projectPath, verify) {
  const spec = normaliseVerify(verify)
  if (spec === null) return null
  const fs = ctx === undefined || ctx === null ? undefined : ctx.fs
  const scripts = []
  if (fs !== undefined && fs !== null && typeof fs.resolve === 'function' && typeof fs.readText === 'function') {
    for (const path of verifyScriptPaths(spec)) {
      try {
        const target = await fs.resolve(path, { cwd: projectPath })
        const text = await fs.readText(target)
        scripts.push({ path: path, text: String(text) })
      } catch (error) {
        // A named script that does not exist is not part of the fingerprint; the
        // command string itself still is, so an edit to the name is visible.
      }
    }
  }
  return fingerprintVerify(spec, scripts)
}

export async function runHostCheck(ctx, options) {
  const opts = options === undefined || options === null ? {} : options
  const verify = normaliseVerify(opts.verify)
  const cwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : ''
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  if (verify === null) return { ok: false, code: 'no-verify', message: 'this task declares no mechanical verification to run' }
  if (cwd === '') return { ok: false, code: 'no-candidate', message: 'the mechanical verification needs the test candidate checkout to run in' }
  let subprocess = null
  try {
    subprocess = ctx.get('subprocess')
  } catch (error) {
    subprocess = null
  }
  if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
    return {
      ok: false,
      code: 'no-subprocess-service',
      message: 'the task declares verify: "' + verify.command + '", but this profile has no subprocess service to run it with',
    }
  }
  const timeoutMs = Number.isFinite(verify.timeoutMs) ? Math.max(1, Math.floor(verify.timeoutMs)) : VERIFY_DEFAULT_TIMEOUT_MS
  // The setting is a shell command; npm on Windows is a .cmd shim, so one
  // explicit shell owns the line — never an implicit one.
  const argv = process.platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', verify.command] : ['/bin/sh', '-c', verify.command]
  // The bound is OUR timer, not AbortSignal.timeout(): that helper's timer is
  // unref'd, so a test (or an idle host) could drain the event loop before it
  // fires and the await would never settle. One ref'd timer aborts the child
  // and is always cleared.
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  if (controller !== null) {
    timer = setTimeout(function () {
      try {
        controller.abort()
      } catch (error) {}
    }, timeoutMs)
  }
  const signal = controller === null ? undefined : controller.signal
  const startedAt = clock()
  let handle = null
  let outcome = null
  let failure = null
  try {
    try {
      handle = subprocess.spawn({
        argv: argv,
        cwd: cwd,
        stdio: {
          stdin: 'ignore',
          stdout: { collect: { maxBytes: VERIFY_COLLECT_BYTES } },
          stderr: { collect: { maxBytes: VERIFY_COLLECT_BYTES } },
        },
        graceMs: Math.min(120000, Math.max(1, timeoutMs)),
        ...(signal === undefined ? {} : { signal: signal }),
      })
    } catch (error) {
      handle = null
      failure = String((error && error.message) || error)
    }
    if (handle !== null) {
      try {
        outcome = await handle.done
      } catch (error) {
        failure = String((error && error.message) || error)
      }
    }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
  const durationMs = Math.max(0, clock() - startedAt)
  const timedOut = controller !== null && controller.signal.aborted === true
  const output = readCollected(handle)
  const stdout = typeof output.stdout === 'string' ? output.stdout : ''
  const stderr = typeof output.stderr === 'string' ? output.stderr : ''
  const body = stderr === '' ? stdout : stdout === '' ? stderr : stdout + '\n' + stderr
  const tailText = failure === null ? body : body === '' ? failure : body + '\n' + failure
  const exitCode = outcome !== null && outcome !== undefined && Number.isFinite(outcome.exitCode) ? Math.floor(outcome.exitCode) : null
  return {
    ok: true,
    check: {
      command: verify.command,
      exitCode: exitCode,
      timedOut: timedOut,
      durationMs: durationMs,
      tail: verifyTailOf(tailText, VERIFY_TAIL_BYTES),
      at: new Date(clock()).toISOString(),
    },
  }
}

/** The evidence a failed host check records on the task. */
export function hostCheckEvidence(check) {
  const lines = []
  lines.push('Mechanical verification failed on the host (not a tester verdict).')
  lines.push('  command:  ' + String(check.command))
  lines.push('  exit code: ' + String(check.exitCode === null ? 'none' : check.exitCode) + (check.timedOut === true ? ' (timed out)' : ''))
  if (Number.isFinite(check.durationMs)) lines.push('  duration:  ' + String(Math.round(check.durationMs / 1000)) + 's')
  if (typeof check.tail === 'string' && check.tail !== '') lines.push('  output tail:', check.tail)
  lines.push('Fix it in the SAME worktree, then submit again.')
  return lines.join('\n')
}

/** A readable summary of one host check, for the tester/reviewer briefs. */
function hostCheckSummaryLines(check) {
  const lines = []
  lines.push('  command:   ' + String(check.command))
  lines.push('  exit code: ' + String(check.exitCode === null ? 'none' : check.exitCode) + (check.timedOut === true ? ' (timed out)' : ''))
  if (Number.isFinite(check.durationMs)) lines.push('  duration:  ' + String(Math.round(check.durationMs / 1000)) + 's')
  if (typeof check.at === 'string') lines.push('  ran at:    ' + check.at)
  if (typeof check.tail === 'string' && check.tail !== '') {
    lines.push('  output tail:')
    for (const line of check.tail.split('\n')) lines.push('    ' + line)
  }
  return lines
}

/**
 * T-191: the board's own view of the candidate, for a brief that has no live
 * artifact in hand (recovery/re-delivery). The full artifact is built by the
 * host from git at submit and at review approval; this is the same shape with
 * whatever the board recorded.
 */
export function boardArtifactFor(task, hostCheck) {
  const merge = task.merge === null || task.merge === undefined ? {} : task.merge
  return buildCandidateArtifact(
    task,
    {
      base: typeof task.base === 'string' && task.base !== '' ? task.base : merge.base,
      head: typeof merge.head === 'string' && merge.head !== '' ? merge.head : task.commit,
      actualFiles: Array.isArray(task.actualFiles) ? task.actualFiles : [],
    },
    hostCheck === undefined ? (task.test === null || task.test === undefined ? null : task.test.hostCheck) : hostCheck,
  )
}

export function reviewBriefFor(task, projectPath, artifact) {
  const review = task.review === null || task.review === undefined ? {} : task.review
  const merge = task.merge === null || task.merge === undefined ? {} : task.merge
  const declared = Array.isArray(task.writeFiles) ? task.writeFiles : []
  const actual = Array.isArray(task.actualFiles) ? task.actualFiles : []
  const extras = actual.filter((path) => declared.indexOf(path) < 0)
  const lines = []
  lines.push('Review round ' + String(Number.isFinite(review.attempt) ? review.attempt : 1) + ' for ' + String(task.id) + ': ' + String(task.title))
  if (typeof projectPath === 'string' && projectPath.length > 0) lines.push('Project: ' + projectPath)
  lines.push('Branch: ' + String(task.branch === null || task.branch === undefined ? '' : task.branch))
  if (typeof task.worktree === 'string' && task.worktree.length > 0) lines.push('Worktree: ' + task.worktree)
  lines.push(
    'Diff under review: ' +
      String(task.base === null || task.base === undefined ? '(unknown base)' : task.base) +
      '..' +
      String(merge.head === null || merge.head === undefined ? (task.commit === null || task.commit === undefined ? '(unknown head)' : task.commit) : merge.head),
  )
  if (typeof task.spec === 'string' && task.spec !== '') lines.push('', 'What it involves:', task.spec)
  if (typeof task.acceptance === 'string' && task.acceptance !== '') lines.push('', 'Acceptance:', task.acceptance)
  lines.push('', 'Declared files (' + String(declared.length) + '): ' + (declared.length === 0 ? '(none)' : declared.join(', ')))
  lines.push('Changed files from git (' + String(actual.length) + '): ' + (actual.length === 0 ? '(none recorded)' : actual.join(', ')))
  if (extras.length > 0) {
    lines.push('Files changed beyond the declaration (ask why, or request changes): ' + extras.join(', '))
  } else if (actual.length > 0) {
    lines.push('Every changed file was declared.')
  }
  // T-156: two first-class audit signals. Both MUST be in the brief: a reviewer
  // who only reads the diff cannot know the target moved or the command changed.
  const drift = merge.targetDrift === null || merge.targetDrift === undefined ? null : merge.targetDrift
  if (drift !== null) {
    lines.push(
      '',
      'TARGET DRIFT: ' + String(task.target === null || task.target === undefined ? 'the target' : task.target) + ' moved while this card was in flight (' + String(drift.from) + ' -> ' + String(drift.to) + (drift.at === null || drift.at === undefined ? '' : ' at ' + String(drift.at)) + ').',
      'The request (or the test candidate) was re-based on the NEW head and the changed-file list above was recomputed from it. Review the CURRENT base shown above, not the one in the submission note.',
    )
  }
  if (merge.verifyChanged === true) {
    const prints = merge.verifyFingerprints === null || merge.verifyFingerprints === undefined ? null : merge.verifyFingerprints
    lines.push(
      '',
      'VERIFY DECLARATION CHANGED while this card was in flight' + (prints === null ? '' : ' (fingerprint ' + String(prints.from) + ' -> ' + String(prints.to) + ')') + '.',
      'The acceptance above must hold under the NEW verify command; the old one was not what this round was dispatched with.',
    )
  }
  lines.push('', 'Worker self-test evidence:', typeof task.evidence === 'string' && task.evidence !== '' ? task.evidence : '(none recorded)')
  // The host already recorded the mechanical side of the checklist (the diff's
  // file lists, and the declared command's result on the last approved round).
  // The reviewer judges; it must not spend the round re-running the suite.
  const hostCheck = task.test !== null && task.test !== undefined && task.test.hostCheck !== null && task.test.hostCheck !== undefined ? task.test.hostCheck : null
  lines.push(
    '',
    'Mechanical evidence collected by the HOST (do NOT re-run the suite to check this list):',
    '- Declared vs actual files above are the host\'s own git record of this diff.',
  )
  if (hostCheck === null) {
    lines.push('- No mechanical verification has run for this task yet; the test stage runs the declared command in the candidate.')
  } else {
    lines.push('- The last mechanical verification run by the host for this task:')
    lines.push(...hostCheckSummaryLines(hostCheck))
  }
  if (typeof review.reasons === 'string' && review.reasons !== '') lines.push('', 'Previous review reasons:', review.reasons)
  // T-191: the structured hand-off. The artifact is built by the host from git;
  // a recovery/re-delivery path falls back to the board's summary facts.
  const contractArtifact = artifact === undefined || artifact === null ? boardArtifactFor(task) : artifact
  lines.push(...renderReviewBrief(task, contractArtifact, { requiresProbes: true }))
  lines.push(
    '',
    'Review against the project conventions: keep the change consistent with the surrounding code and architecture, avoid unrelated rewrites and never restyle files the task did not touch.',
    '',
    'Review checklist:',
    '- The diff matches the spec and the acceptance criteria, and nothing unrelated changed.',
    '- Declared vs actual files match (or the extras are justified).',
    '- No secrets, debug leftovers, dead code or commented-out blocks.',
    '- The evidence plausibly matches the change (you do NOT need to run the full test suite; the test stage does that).',
    '- Error handling and naming follow the code around it.',
    '',
    'You are READ-ONLY on implementation: do not edit files, commit, merge or push.',
    'Record the verdict with task_center (the structured shapes above; free-text reasons are refused):',
    '  { action: "approveReview", id: "' + task.id + '", checked: [...], findings: [...], residualRisks: [...] }',
    '  { action: "requestChanges", id: "' + task.id + '", findings: [{ severity: "blocking", file, line, text }], checked: [...], residualRisks: [...] }',
  )
  return lines.join('\n')
}

/** The rework brief the host sends the worker when its review requested
 * changes: fix in the SAME worktree and submit again for the next round. */
export function reworkBriefFor(task, projectPath) {
  const review = task.review === null || task.review === undefined ? {} : task.review
  const lines = []
  lines.push('Review round ' + String(Number.isFinite(review.attempt) ? review.attempt : 1) + ' requested CHANGES on ' + String(task.id) + ': ' + String(task.title))
  if (typeof projectPath === 'string' && projectPath.length > 0) lines.push('Project: ' + projectPath)
  lines.push('', 'Reviewer reasons:')
  lines.push(typeof review.reasons === 'string' && review.reasons !== '' ? review.reasons : '(the reviewer did not write reasons; ask the Lead)')
  lines.push('')
  lines.push('Fix it in the SAME worktree and branch you already used:')
  lines.push('  worktree: ' + String(task.worktree === null || task.worktree === undefined ? '(unknown)' : task.worktree))
  lines.push('  branch:   ' + String(task.branch === null || task.branch === undefined ? '(unknown)' : task.branch))
  lines.push('Do not create a new branch or a fresh checkout; the task branch still holds your commit.')
  lines.push('Run the tests there, then report again with task_center { action: "submit", id: "' + task.id + '", evidence: "what you fixed and how you checked it" }.')
  lines.push('That opens review round ' + String((Number.isFinite(review.attempt) ? review.attempt : 1) + 1) + '.')
  return lines.join('\n')
}

/**
 * The per-round TEST brief the host sends the tester once the review is approved
 * and the candidate checkout exists. It carries the acceptance criteria, the
 * candidate path/branch, a test plan/runbook (including how to launch a Godot
 * project from the candidate), the evidence format and the read-only boundary.
 */
export function testerBriefFor(task, projectPath, candidate, options) {
  const opts = options === undefined || options === null ? {} : options
  const test = task.test === null || task.test === undefined ? {} : task.test
  const godot = opts.godot === undefined || opts.godot === null ? null : opts.godot
  const hostCheck =
    opts.hostCheck !== undefined && opts.hostCheck !== null
      ? opts.hostCheck
      : test.hostCheck !== null && test.hostCheck !== undefined
        ? test.hostCheck
        : null
  const lines = []
  lines.push('Independent TEST round ' + String(Number.isFinite(test.attempt) ? test.attempt : 1) + ' for ' + String(task.id) + ': ' + String(task.title))
  if (typeof projectPath === 'string' && projectPath.length > 0) lines.push('Project: ' + projectPath)
  lines.push('', 'Candidate worktree: ' + String(candidate.path))
  lines.push('Candidate branch: ' + String(candidate.branch))
  lines.push('Candidate base: ' + String(candidate.base) + ' (the ' + String(task.target) + ' head when the candidate was built)')
  lines.push('Candidate head: ' + String(candidate.head))
  lines.push('Task branch merged into it: ' + String(task.branch === null || task.branch === undefined ? '' : task.branch))
  if (typeof task.spec === 'string' && task.spec !== '') lines.push('', 'What it involves:', task.spec)
  if (typeof task.acceptance === 'string' && task.acceptance !== '') lines.push('', 'Acceptance:', task.acceptance)
  lines.push('', 'Worker self-test evidence (do NOT just repeat it — test independently):', typeof task.evidence === 'string' && task.evidence !== '' ? task.evidence : '(none recorded)')
  // T-191: the host baseline is stated ONCE, in the contract section below (the
  // artifact line carries its command, exit code and output tail). Do not repeat
  // it here: the whole point of the hand-off is not re-reading the same context.
  if (hostCheck === null && normaliseVerify(task.verify) !== null) {
    // A retest after the target moved rebuilds the candidate; the host has no
    // check for the new tree, so the tester runs the declared command this round.
    lines.push('', 'This task declares verify: "' + String(normaliseVerify(task.verify).command) + '" but the host has no check for this round (the candidate was rebuilt); run that command yourself before judging.')
  }
  // T-191: the structured hand-off. The tester receives the CandidateArtifact,
  // the scope the REVIEWER already covered and the host baseline — never the
  // review verdict (a scope hand-off is not a conclusion).
  const contractArtifact =
    opts.artifact !== undefined && opts.artifact !== null
      ? opts.artifact
      : buildCandidateArtifact(
          task,
          {
            base: candidate === null || candidate === undefined ? null : candidate.base,
            head: candidate === null || candidate === undefined ? null : candidate.head,
            actualFiles:
              candidate !== null && candidate !== undefined && Array.isArray(candidate.actualFiles)
                ? candidate.actualFiles
                : Array.isArray(task.actualFiles)
                  ? task.actualFiles
                  : [],
          },
          hostCheck,
        )
  const reviewRecord = task.review === null || task.review === undefined ? null : task.review.record
  lines.push(...renderTesterBrief(task, contractArtifact, reviewRecord, hostCheck, { hostCheckReused: opts.hostCheckReused === true }))
  lines.push(
    '',
    'Test plan / runbook:',
    '- Work ONLY inside the candidate worktree above. Do not edit implementation files, commit, merge or push.',
    '- Run the project test commands there from the candidate checkout and record the exact command and exit code.',
    '- Exercise the acceptance criteria directly; a green unit suite is not a substitute for the acceptance check.',
  )
  if (godot !== null && godot !== undefined && godot.project === true) {
    const mainScene = typeof godot.mainScene === 'string' && godot.mainScene.trim() !== '' ? godot.mainScene.trim() : null
    const hasMainScene = godot.hasMainScene === true && mainScene !== null
    if (hasMainScene) {
      lines.push(
        '- This is a Godot project (' + String(godot.projectFile) + ').',
        '  Main scene ([application] run/main_scene): ' + mainScene,
        '  Engine path: ' + String(godot.enginePath === undefined || godot.enginePath === null || godot.enginePath === '' ? 'the godot-bridge godotPath setting (Godot engine path card) or the godot command on PATH' : godot.enginePath) + '.',
        '  Headless smoke test from the candidate:',
        '    godot_run_headless({ project_path: "' + String(candidate.path) + '", quit_after: 120 })',
        '  Interactive smoke test from the candidate:',
        '    godot_run_project({ project_path: "' + String(candidate.path) + '" })',
        '  Never launch Godot through pwsh/bash (the file sandbox kills it). Stop with godot_stop_project and read godot_get_debug_output for logs.',
      )
    } else {
      lines.push(
        '- This is a Godot project (' + String(godot.projectFile) + '), but its project.godot declares NO [application] run/main_scene.',
        '  Do NOT start the project: Godot would only raise its native error "Can not run project: no main scene defined", which can leave the run hanging and is not a candidate failure.',
        '  Run a concrete scene or script instead, and only when the task names one (spec, acceptance or worker evidence):',
        '    godot_run_headless({ project_path: "' + String(candidate.path) + '", scene: "<the task scene, e.g. res://scenes/main.tscn>" })',
        '    godot_run_headless({ project_path: "' + String(candidate.path) + '", script: "<the task script, e.g. res://scripts/test/smoke.gd>" })',
        '  If the task names no concrete scene/script, skip the Godot launch and prove the change with the commands the task declares.',
        '  Record the real output of whatever you run: keep Godot errors visible instead of swallowing them into a passing verdict.',
        '  Never launch Godot through pwsh/bash (the file sandbox kills it). Stop with godot_stop_project and read godot_get_debug_output for logs.',
      )
    }
  } else {
    lines.push(
      '- If this is a Godot project: read its project.godot [application] run/main_scene first, and start the project (godot_run_project / project-level godot_run_headless) only when a main scene is declared. With no main scene, run only a concrete scene/script named by the task (godot_run_headless with scene: or script:), otherwise skip the Godot launch. Never through pwsh/bash.',
    )
  }
  lines.push(
    '',
    'Evidence format (required for the verdict):',
    '- commands run and their exit codes;',
    '- the failing output tail (not the head of the log) for a failure;',
    '- screenshot paths for visual checks;',
    '- relevant Godot output (startup errors, scene load, crash lines).',
    '',
    'Permission boundary (hard): the candidate is READ-ONLY implementation; you may only record the verdict in the structured TestRecord shape above:',
    '  task_center { action: "passTest", id: "' + task.id + '", probes: [{ id, command, exitCode, tail }], adversarial: [...], hostCheckRef, notes }',
    '  task_center { action: "failTest", id: "' + task.id + '", probes: [ ...the same shape... ] }',
    '',
    'You are an independent, FRESH context: the worker self-test does not count as your verdict.',
  )
  return lines.join('\n')
}

/** Tell the worker a test failed, with the evidence, and that it continues in its own worktree. */
export function testFailureBriefFor(task, projectPath) {
  const test = task.test === null || task.test === undefined ? {} : task.test
  const lines = []
  lines.push('Test round ' + String(Number.isFinite(test.attempt) ? test.attempt : 1) + ' FAILED for ' + String(task.id) + ': ' + String(task.title))
  if (typeof projectPath === 'string' && projectPath.length > 0) lines.push('Project: ' + projectPath)
  lines.push('', 'Tester evidence:')
  lines.push(typeof test.evidence === 'string' && test.evidence !== '' ? test.evidence : '(the tester did not write evidence; ask the Lead)')
  lines.push('', 'Fix it in the SAME worktree and branch you already used:')
  lines.push('  worktree: ' + String(task.worktree === null || task.worktree === undefined ? '(unknown)' : task.worktree))
  lines.push('  branch:   ' + String(task.branch === null || task.branch === undefined ? '(unknown)' : task.branch))
  lines.push('Do not create a new branch or a fresh checkout.')
  lines.push('Run the tests there, then submit again with task_center { action: "submit", id: "' + task.id + '", evidence: "what you fixed and how you checked it" }.')
  return lines.join('\n')
}


/**
 * The scheduler. One per row; one pass at a time.
 *
 * A pass:
 *   1. reaps tasks claimed by a previous process (host restart);
 *   2. reaps expired leases;
 *   3. if dispatch is running, hands ready tasks to workers until the
 *      concurrency budget is full, acquiring declared file locks first.
 */
export function createDispatcher(ctx, options) {
  const opts = options === undefined ? {} : options
  const state = opts.state
  // T-130 audit: the default project source is "the last project the host drove",
  // a DRIVING fallback only. Team/lead/liveness resolution always uses the card's
  // ownerSession (or the project's sessions), never this hint.
  const projectOf = typeof opts.projectPath === 'function' ? opts.projectPath : () => state.memory.projectHint
  const boot = bootId()
  // Cross-process leader gate. No lease configured (direct tests/users) keeps the
  // old single-host behaviour; the production row injects a per-project registry.
  const leaseGate = createLeaseGate({ leases: opts.leases === undefined ? null : opts.leases, owner: boot })
  // Startup/periodic merge-journal reconciliation. Injected so direct dispatcher
  // users/tests do not need a journal; the production row wires it before a tick.
  const reconcile = typeof opts.reconcile === 'function' ? opts.reconcile : null
  // T-97: cards carry the session that owns them; this dispatcher only hands work
  // to its own session's team. Without an identity it refuses to borrow.
  const selfSessionId = typeof opts.sessionId === 'string' && opts.sessionId.length > 0 ? opts.sessionId : sessionIdOfContext(ctx)
  // The subagent runtime: the ONLY execution edge. Every dispatch starts a fresh
  // worker child under the card's own root Agent; a profile without it leaves
  // tasks pending with a typed 'agent-runtime-unavailable' skip.
  const taskAgents = opts.taskAgents === undefined || opts.taskAgents === null ? null : opts.taskAgents
  // The in-memory activity ring the snapshot exposes. Null is a normal setup
  // (direct dispatcher users) and simply records nothing.
  const activity = opts.activity === undefined || opts.activity === null ? null : opts.activity
  // The host heartbeat window: how close to lapsing a running task's lease must
  // be before the scheduler extends it. Tests shorten it; production uses the
  // schema default. Deliberately independent of TASK_LEASE_MS.
  const heartbeatMs = Number.isFinite(opts.heartbeatMs) ? Math.max(1, Math.floor(opts.heartbeatMs)) : TASK_HEARTBEAT_MS
  // How long ONE worktree creation may take before this scheduler gives up on the
  // attempt (the git facade has its own runner budget; this is the outer bound).
  const worktreeDeadlineMs = Number.isFinite(opts.worktreeDeadlineMs) ? Math.max(1, Math.floor(opts.worktreeDeadlineMs)) : WORKTREE_CREATE_DEADLINE_MS
  // Tests shorten the review/test timeouts; production uses the schema defaults.
  const reviewTimeoutMs = Number.isFinite(opts.reviewTimeoutMs) ? opts.reviewTimeoutMs : REVIEW_TIMEOUT_MS
  const testReminderMs = Number.isFinite(opts.testReminderMs) ? Math.max(1, Math.floor(opts.testReminderMs)) : TEST_REMINDER_MS
  const testTimeoutMs = Number.isFinite(opts.testTimeoutMs) ? Math.max(1, Math.floor(opts.testTimeoutMs)) : TEST_TIMEOUT_MS
  // The boundary grace before a silent round is actually blocked (see
  // PHASE_BLOCK_GRACE_MS); tests shorten it.
  const phaseGraceMs = Number.isFinite(opts.phaseGraceMs) ? Math.max(0, Math.floor(opts.phaseGraceMs)) : PHASE_BLOCK_GRACE_MS

  /** Push one host activity entry; never throws and never touches the board. */
  function emit(kind, actor, fields) {
    if (activity === null || typeof activity.push !== 'function') return
    try {
      activity.push(Object.assign({ kind: kind, actor: actor }, fields === undefined ? {} : fields))
    } catch (error) {}
  }

  const memory = {
    sweeping: false,
    rerun: null,
    timer: null,
    lastTickAt: null,
    lastError: null,
    lastResults: [],
    lastCapacity: null,
    ticks: 0,
    // T-197: one reminder and one grace notice per stage budget slice. The key is
    // "<id>@<stage>@<round>@<continues>", so a new round (or a continue) allows a
    // fresh nudge while a replayed tick can never send a second one.
    stageReminders: new Map(),
    stageGrace: new Map(),
    // The last environment probe (is the main tree clean, when was it checked) and
    // the per-card streak of TRANSIENT failures, so a momentary dirty window skips
    // one card instead of pausing the project (T-108).
    environment: null,
    environmentDirty: new Map(),
    // T-197: per card+stage timeout state, keyed "<taskId>@<stage>" and reset by
    // the stage ROUND (a new review/test round starts with a full budget).
    // { round, continues, defaults, decisionId, decisionAt }
    stageEvents: new Map(),
    // T-197 event 10: consecutive failed auto-recoveries per card+event, keyed
    // "<taskId>@<event>". The entry carries the incident epoch it was counted
    // against, so a card that made progress in between starts a new streak.
    stageRecoveries: new Map(),
  }
  // undefined means "ask the context"; null means "this host has no git runner",
  // which now means dispatch cannot start at all. Resolved lazily and cached for
  // the dispatcher's life.
  const injectedGit = opts.git
  let gitCache

  function gitFacade() {
    if (injectedGit !== undefined) return injectedGit
    if (gitCache === undefined) gitCache = gitFor(ctx, opts)
    return gitCache
  }

  /** The transient-failure picture the panel renders (never the board write). */
  function environmentStatus(projectPath) {
    // T-130: streaks and the last probe are PER PROJECT. A filtered read (the API
    // asks for its own project) must never show another project's dirty state.
    const project = typeof projectPath === 'string' && projectPath !== '' ? projectIdOf(projectPath) : null
    const dirty = []
    memory.environmentDirty.forEach((entry) => {
      if (project !== null && entry.project !== project) return
      dirty.push({
        id: String(entry.taskId),
        retries: entry.count,
        since: new Date(entry.firstAt).toISOString(),
        escalated: entry.escalated === true,
      })
    })
    const untrusted = memory.environment === null || (project !== null && memory.environment.project !== project)
    const probe = untrusted ? { project: null, clean: null, code: null, message: null, checkedAt: null } : memory.environment
    return Object.assign({}, probe, {
      retrying: dirty.filter((entry) => entry.escalated !== true),
      escalated: dirty.filter((entry) => entry.escalated === true).map((entry) => entry.id),
      // Every streak with its count, so the panel (and a test) can say "3rd retry"
      // instead of only "somewhere between fine and alarming".
      dirty: dirty,
    })
  }


  function status(projectPath) {
    return {
      boot: boot,
      busy: memory.sweeping,
      lastTickAt: memory.lastTickAt,
      lastError: memory.lastError,
      lastResults: memory.lastResults,
      lastCapacity: memory.lastCapacity,
      ticks: memory.ticks,
      // T-130: the environment reading is scoped to one project when the caller
      // names it (the API passes its project); diagnostics can still ask for all.
      environment: environmentStatus(projectPath),
      leader: leaseGate.status(typeof projectPath === 'string' && projectPath !== '' ? projectPath : null),
    }
  }

  function releaseTaskLocks(taskId) {
    const result = locks.releaseTask(state.memory.locks, taskId)
    if (result.ok === true) state.memory.locks = result.locks
  }

  function scheduleRerun(projectPath) {
    if (memory.timer !== null) return
    const timer = setTimeout(function () {
      memory.timer = null
      void kick(projectPath)
    }, RERUN_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    memory.timer = timer
  }

  /** Ask for a pass. Safe to call from a write hook or an event listener: it
   * never overlaps a pass and never throws. */
  function kick(projectPath) {
    const project = typeof projectPath === 'string' && projectPath.length > 0 ? projectPath : projectOf()
    if (typeof project !== 'string' || project.length === 0) {
      return Promise.resolve({ ok: true, skipped: 'unknown-project' })
    }
    if (memory.sweeping) {
      memory.rerun = project
      return Promise.resolve({ ok: true, skipped: 'already-sweeping' })
    }
    return tick(project)
  }

  async function applyReap(projectPath, mutate) {
    const applied = await state.apply(
      projectPath,
      (board) => {
        const next = mutate(board)
        if (next === undefined || next === null) return { ok: false, code: 'no-change', message: 'nothing to reap' }
        return { ok: true, board: next, events: [] }
      },
      writePolicyFor(projectPath),
    )
    if (applied.failed !== null) {
      memory.lastError = applied.failed.message
      return null
    }
    return applied.board
  }

  /**
   * The host heartbeat: one board write that extends every running task whose
   * lease is inside the heartbeat window, renewing its file locks with it. It
   * runs before the reap so a task that is still inside its lease is never
   * mistaken for a dead one just because its worker is silent for a long tool
   * run. It renews ONLY a holder the root's live subagent tree still lists and
   * only while the attempt is inside the extension cap, so a dead holder (or one
   * past the cap) lapses into the handover path on schedule instead of being
   * kept alive forever. A lease that already lapsed is never revived here.
   */
  /** The live children of each card root on this board, by Session id. A root
   * this host cannot read maps to null ("cannot tell"). */
  async function liveAgentSets(board) {
    const byRoot = new Map()
    if (taskAgents === null) return byRoot
    const roots = new Set()
    for (const task of board !== null && board !== undefined && Array.isArray(board.tasks) ? board.tasks : []) {
      if (typeof task.ownerSession === 'string' && task.ownerSession !== '') roots.add(task.ownerSession)
    }
    for (const rootId of roots) {
      let rows = null
      try {
        if (typeof taskAgents.listAgentsFor === 'function') rows = await taskAgents.listAgentsFor(rootId)
        else if (taskAgents.runtime !== null && taskAgents.runtime !== undefined && typeof taskAgents.runtime.list === 'function') rows = await taskAgents.runtime.list()
      } catch (error) {
        rows = null
      }
      if (!Array.isArray(rows)) {
        byRoot.set(rootId, null)
        continue
      }
      const ids = new Set()
      for (const row of rows) {
        if (row === null || row === undefined || row.kind !== 'child') continue
        ids.add(String(row.id))
      }
      byRoot.set(rootId, ids)
    }
    return byRoot
  }
  /** The dispatcher's liveness rule: a card's holder is alive iff the LIVE
   * subagent tree of THAT card's root still lists its Session id. An inactive
   * child is between turns and stays alive; a root we cannot read is unknown. */
  function holderLiveness(task, byRoot) {
    const holder = task === null || task === undefined || task.assignee === null ? null : task.assignee
    const name = holder === null || holder.name === undefined || holder.name === null ? null : String(holder.name)
    const session = holder === null || holder.session === undefined || holder.session === null ? null : String(holder.session)
    const rootId = task !== null && task !== undefined && typeof task.ownerSession === 'string' ? task.ownerSession : null
    const ids = byRoot instanceof Map && rootId !== null ? byRoot.get(rootId) : null
    if (ids === null || ids === undefined) return { known: false, alive: false, status: null, name: name, session: session }
    if (session === null) return { known: true, alive: false, status: 'gone', name: name, session: null }
    return ids.has(session)
      ? { known: true, alive: true, status: 'running', name: name, session: session }
      : { known: true, alive: false, status: 'gone', name: name, session: session }
  }
  /** Stop one stage/worker child by its durable Session id. Best effort. */
  async function stopAgent(agentId) {
    if (taskAgents === null || typeof taskAgents.release !== 'function') return false
    if (typeof agentId !== 'string' || agentId === '') return false
    try {
      return (await taskAgents.release(agentId)) === true
    } catch (error) {
      return false
    }
  }

  async function applyHeartbeat(projectPath, board, now) {
    const aliveSets = await liveAgentSets(board)
    const plan = { windowMs: heartbeatMs, maxExtensionMs: TASK_LEASE_EXTENSION_MAX_MS, allow: (task) => holderLiveness(task, aliveSets).alive === true }
    const planned = model.renewRunningLeases(board, now, plan)
    if (planned.ok !== true || planned.renewed.length === 0) return board
    const next = await applyReap(projectPath, (value) => {
      const result = model.renewRunningLeases(value, now, plan)
      return result.ok === true && result.renewed.length > 0 ? result.board : null
    })
    if (next === null) return board
    for (const id of planned.renewed) {
      const renewed = locks.renewTask(state.memory.locks, id, now, TASK_LEASE_MS)
      if (renewed.ok === true) state.memory.locks = renewed.locks
    }
    return next
  }

  /**
   * Count one TRANSIENT environment failure for a card (T-108). The card is
   * skipped for this pass; the streak decides when it stops being "a merge is
   * running" and becomes "someone must look at this checkout".
   */
  function noteEnvironmentFailure(projectPath, taskId, code, message, now) {
    // T-130: the streak key carries the PROJECT, so two projects with the same
    // card id never share a streak.
    const project = projectIdOf(projectPath)
    const key = project + '@' + String(taskId)
    const previous = memory.environmentDirty.get(key)
    const entry = previous === undefined ? { project: project, taskId: String(taskId), count: 0, firstAt: now, lastAt: now, code: null, message: null, escalated: false } : previous
    entry.count += 1
    entry.lastAt = now
    entry.code = String(code === undefined || code === null ? '' : code)
    entry.message = String(message === undefined || message === null ? '' : message)
    entry.escalated = entry.count >= ENVIRONMENT_RETRY_LIMIT || now - entry.firstAt >= ENVIRONMENT_RETRY_WINDOW_MS
    memory.environmentDirty.set(key, entry)
    return entry
  }

  /** The card made it through the window: forget its streak. */
  function clearEnvironmentFailure(projectPath, taskId) {
    if (memory.environmentDirty.size === 0) return
    memory.environmentDirty.delete(projectIdOf(projectPath) + '@' + String(taskId))
  }

  /** Record the pass-level probe: what the panel shows as "is the main tree clean". */
  async function probeEnvironment(projectPath, now) {
    let probe
    try {
      probe = await probeWorktree(gitFacade(), projectPath)
    } catch (error) {
      probe = { ok: false, code: 'git-unavailable', message: String((error && error.message) || error) }
    }
    memory.environment = {
      // T-130: the probe names its project, so the API can refuse a reading that
      // belongs to a different tree (the old single slot was last-tick-wins).
      project: projectIdOf(projectPath),
      clean: probe.ok === true,
      code: probe.ok === true ? null : String(probe.code === undefined || probe.code === null ? 'git-unavailable' : probe.code),
      message: probe.ok === true ? null : String(probe.message === undefined || probe.message === null ? '' : probe.message),
      checkedAt: new Date(now).toISOString(),
    }
    if (probe.ok !== true) return { environment: memory.environment, board: null }
    // The window closed for THIS project: its streaks and its "waiting for the
    // tree" markers are obsolete. Another project's streaks are untouched.
    const projectKey = projectIdOf(projectPath)
    for (const key of Array.from(memory.environmentDirty.keys())) {
      const entry = memory.environmentDirty.get(key)
      if (entry !== undefined && entry.project === projectKey) memory.environmentDirty.delete(key)
    }
    const cleared = await clearEnvironmentWaiting(projectPath, null)
    return { environment: memory.environment, board: cleared }
  }

  /** Put the "waiting for a clean main tree" marker on one card (panel-visible). */
  async function markEnvironmentWaiting(projectPath, taskId, detail) {
    const applied = await state.apply(
      projectPath,
      (board) => {
        const task = model.findTask(board, taskId)
        if (task === undefined) return null
        if (task.waitingReason === 'dirty-worktree' && task.waitingDetail === detail) return null
        const tasks = board.tasks.map((entry) =>
          String(entry.id) === String(taskId) ? Object.assign({}, entry, { waitingReason: 'dirty-worktree', waitingDetail: detail }) : entry,
        )
        return { ok: true, board: Object.assign({}, board, { tasks: tasks }), events: [] }
      },
      writePolicyFor(projectPath),
    )
    return applied.failed === null ? applied.board : null
  }

  /** Drop the marker (one card when `onlyId` is set, otherwise every card). */
  async function clearEnvironmentWaiting(projectPath, onlyId) {
    const applied = await state.apply(
      projectPath,
      (board) => {
        const targets = board.tasks.filter(
          (task) => task.waitingReason === 'dirty-worktree' && (onlyId === null || String(task.id) === String(onlyId)),
        )
        if (targets.length === 0) return null
        const ids = new Set(targets.map((task) => String(task.id)))
        const tasks = board.tasks.map((task) => (ids.has(String(task.id)) ? Object.assign({}, task, { waitingReason: null, waitingDetail: null }) : task))
        return { ok: true, board: Object.assign({}, board, { tasks: tasks }), events: [] }
      },
      writePolicyFor(projectPath),
    )
    return applied.failed === null ? applied.board : null
  }

  /**
   * A worktree could not be prepared for this attempt and the cause is NOT
   * transient: pause dispatch, record the reason on the task for the panel, and
   * leave the task pending. Pausing is the backoff — a paused dispatcher is not
   * retried by the timer, so a broken git environment cannot turn into a
   * five-second retry storm. A dirty window is NOT this path (T-108).
   */
  async function pauseForWorktree(projectPath, taskId, reason, message) {
    memory.lastError = message
    const applied = await state.apply(
      projectPath,
      (board) => {
        const next = model.setDispatch(
          board,
          { state: 'paused', pauseSource: 'worktree', pauseReason: message, error: message },
          state.clock(),
          'scheduler',
        )
        if (next.ok !== true) return next
        const task = model.findTask(next.board, taskId)
        if (task !== undefined) task.worktreeError = reason
        return { ok: true, board: next.board, events: next.events }
      },
      writePolicyFor(projectPath),
    )
    if (applied.failed !== null) memory.lastError = applied.failed.message
    return applied
  }

  /** Restore the in-memory lock table from running tasks after a plugin reload
   * in the same process. Without this, a reload would silently drop the locks a
   * still-running worker believes it owns, and the next task could take them. */
  function restoreLocks(board) {
    for (const task of board.tasks) {
      if (task.status !== 'running' || task.writeFiles.length === 0) continue
      // T-131: an investigation only READS in a disposable detached scratch; it
      // never writes the declared files, so it must not hold — or regain after a
      // reload — a writeFiles lock that would block a real dev card (files-busy).
      if (task.kind === 'investigate') continue
      if (task.dispatch === null || task.dispatch.host !== boot) continue
      const missing = task.writeFiles.filter((path) => {
        const held = state.memory.locks[path]
        return held === undefined || String(held.taskId) !== String(task.id)
      })
      if (missing.length === 0) continue
      const acquired = locks.acquire(
        state.memory.locks,
        task.writeFiles,
        { taskId: task.id, agent: task.assignee === null ? null : task.assignee.name },
        state.clock(),
        TASK_LEASE_MS,
      )
      if (acquired.ok === true && acquired.granted === true) state.memory.locks = acquired.locks
    }
  }

  async function reap(projectPath, board, now) {
    let current = board
    const limit = current.dispatch.maxAttempts
    // 1. Tasks claimed by another process. A plugin reload in the same process
    // keeps the boot id, so their live workers are not disturbed.
    const stale = current.tasks.filter(
      (task) => task.status === 'running' && (task.dispatch === null || task.dispatch.host !== boot),
    )
    if (stale.length > 0) {
      // A claim made by a DIFFERENT host process is an infrastructure event, not a
      // worker failure: the worker never had a chance to work. interruptDispatch
      // refunds the attempt and counts the interruption instead, so a development
      // host that reloads repeatedly cannot block a healthy task (T-85).
      const next = await applyReap(projectPath, (value) => {
        let mutated = value
        for (const task of stale) {
          const result = model.interruptDispatch(mutated, task.id, 'worker lost (host restart)', now, {
            maxInterruptions: model.INTERRUPTION_LIMIT,
          })
          if (result.ok === true) mutated = result.board
        }
        return mutated
      })
      if (next !== null) {
        current = next
        for (const task of stale) {
          releaseTaskLocks(task.id)
          const after = model.findTask(current, task.id)
          if (after === undefined) continue
          emit('interrupted', 'host', {
            taskId: task.id,
            detail:
              'host restart interrupted the attempt; attempt refunded (attempts ' + String(after.attempts) +
              '/' + String(after.maxAttempts) + ', interruptions ' + String(after.interruptions) + '/' + String(model.INTERRUPTION_LIMIT) + ')',
          })
          // T-197 event 10: worker lost / host restart is NOTIFY by default. The
          // requeue above IS the automatic recovery, so this only records it.
          // T-198: the bridge applies the event policy (notify/silent/ask + the
          // consecutive auto-recovery limit); a direct dispatcher user keeps the
          // built-in notify path.
          if (after.status === 'pending') {
            if (stageHost !== null && typeof stageHost.recover === 'function') {
              try {
                await stageHost.recover(projectPath, {
                  taskId: after.id,
                  event: STAGE_EVENTS.workerLost,
                  detail: 'host restart requeued the attempt (attempt refunded)',
                })
              } catch (error) {}
            } else {
              const notified = await notifyStageEvent(projectPath, {
                taskId: after.id,
                event: STAGE_EVENTS.workerLost,
                detail: 'host restart requeued the attempt (attempt refunded)',
              })
              if (notified.ok === true && notified.escalate === true) {
                await requestStageRecoveryAsk(projectPath, after, STAGE_EVENTS.workerLost, notified.count)
              }
            }
          }
          if (after.status === 'blocked') {
            emit('error', 'system', {
              taskId: task.id,
              detail: 'interrupted-too-often: ' + String(after.interruptions) + ' interruptions and no submission; blocked for triage',
            })
          }
        }
      }
    }
    // 2. Lapsed leases, even while dispatch is paused. A lapsed lease is NOT
    // proof the worker is gone, so liveness decides first: a holder that is
    // still alive keeps the task (lease extended, bounded by the hard cap) and no
    // second agent is ever dispatched for it. Only a gone/failed holder, or one
    // past the cap, is handed over: the old agent is interrupted, the task is
    // requeued with its claim identity kept, and the next attempt adopts this
    // attempt checkout instead of starting over from the target.
    const lapsed = current.tasks.filter(
      (task) => task.status === 'running' && (task.leaseUntil === null || Date.parse(task.leaseUntil) <= now),
    )
    const handover = []
    const lapsedAlive = await liveAgentSets(current)
    for (const task of lapsed) {
      const holder = task.assignee === null ? null : { name: task.assignee.name, session: task.assignee.session }
      const live = holderLiveness(task, lapsedAlive)
      const startedAt = model.attemptStartedAt(task)
      const capped = startedAt !== null && now - startedAt >= TASK_LEASE_EXTENSION_MAX_MS
      if (live.alive === true && capped !== true) {
        const extended = await applyReap(projectPath, (value) => {
          const result = model.extendLease(value, task.id, now, {
            reason: 'assignee ' + String(live.name) + ' is still ' + String(live.status) + '; no second agent',
          })
          return result.ok === true ? result.board : null
        })
        if (extended !== null) {
          current = extended
          emit('lease-extended', 'system', {
            taskId: task.id,
            detail: 'assignee ' + String(live.name) + ' still ' + String(live.status) + '; lease extended instead of a second agent',
          })
        }
        continue
      }
      handover.push({ id: task.id, holder: holder, live: live, capped: capped === true })
    }
    if (handover.length > 0) {
      const next = await applyReap(projectPath, (value) => {
        let mutated = value
        for (const entry of handover) {
          const result = model.expireLeases(mutated, now, limit, {
            id: entry.id,
            error: entry.capped === true ? TASK_LEASE_CAP_ERROR : 'lease expired',
            reason:
              entry.capped === true
                ? 'alive but past the liveness cap'
                : entry.live.known === true
                  ? 'assignee ' + String(entry.live.status)
                  : 'assignee liveness unknown',
          })
          if (result.ok === true) mutated = result.board
        }
        return mutated
      })
      if (next !== null) {
        current = next
        for (const entry of handover) {
          releaseTaskLocks(entry.id)
          const stopped = entry.holder === null || entry.holder.session === undefined || entry.holder.session === null ? false : await stopAgent(String(entry.holder.session))
          emit('lease-handover', 'host', {
            taskId: entry.id,
            detail:
              (entry.capped === true ? 'liveness cap reached' : 'assignee ' + String(entry.live.status)) +
              '; requeued for a fresh attempt (' + (stopped === true ? 'old agent disposed' : 'old agent already gone') + ')',
          })
        }
      }
    }
    return current
  }


  /**
   * T-183: a system block (review/test timeout) is still a block. Dispose the
   * card's spawned stage children instead of leaving them running behind a card
   * that the panel already shows as blocked. Best-effort: the block itself has
   * already been recorded.
   */
  async function releaseBlockedStageChildren(task, reason) {
    if (taskAgents === null || taskAgents === undefined || task === null || task === undefined) return null
    if (typeof taskAgents.releaseTask !== 'function') return null
    try {
      return await taskAgents.releaseTask(task, { roles: ['worker', 'reviewer', 'tester'], reason: reason })
    } catch (error) {
      return null
    }
  }

  /** The child a card's current review/test stage was delivered to, or null. */
  function stageExecutorOf(task, stage) {
    const record = stage === 'review' ? task.review : task.test
    const delivered = record === null || record === undefined || record.deliveredTo === undefined || record.deliveredTo === null ? null : record.deliveredTo
    if (delivered === null) return null
    const id = typeof delivered.id === 'string' && delivered.id !== '' ? delivered.id : null
    const name = typeof delivered.name === 'string' && delivered.name !== '' ? delivered.name : null
    return id === null && name === null ? null : { id: id, name: name }
  }

  /** Send one notice to an executor by its durable Session id. */
  async function sendToAgent(rootId, agentId, text) {
    if (taskAgents === null || typeof taskAgents.send !== 'function') return false
    if (typeof agentId !== 'string' || agentId === '') return false
    try {
      await taskAgents.send(agentId, text, rootId === null || rootId === undefined ? undefined : { rootId: String(rootId) })
      return true
    } catch (error) {
      return false
    }
  }

  // ── T-197: the stage engine ────────────────────────────────────────────────
  // Silence, not elapsed time, is what times a stage out: a role that keeps
  // producing identifiable activity is working. A timeout ASKS the human before
  // anything stops, and a continue only extends the budget of the SAME stage —
  // the worker is never restarted and the worktree/candidate stay untouched.
  let stageHost = null

  /** Attach the API's decision/notification bridge (idempotent). */
  function attachStageHost(host) {
    if (host === null || host === undefined || typeof host.request !== 'function') return false
    stageHost = host
    return true
  }

  /** The executor of the OPEN stage round: a worker by assignee, a child by record. */
  function stageExecutorOfRun(task, stage) {
    if (stage === 'dev') {
      const holder = task.assignee
      if (holder === null || holder === undefined) return null
      const id = typeof holder.session === 'string' && holder.session !== '' ? holder.session : null
      const name = typeof holder.name === 'string' && holder.name !== '' ? holder.name : null
      return id === null && name === null ? null : { id: id, name: name }
    }
    return stageExecutorOf(task, stage)
  }

  /** When the CURRENT stage round started (ms), or null when the stage is closed. */
  function stageRoundAt(task, stage) {
    if (stage === 'dev') return model.attemptStartedAt(task)
    const record = stage === 'review' ? task.review : task.test
    if (record === null || record === undefined || typeof record.at !== 'string') return null
    const at = Date.parse(record.at)
    return Number.isFinite(at) ? at : null
  }

  /** The timeout state of one card+stage. A NEW round resets every counter. */
  function stageStateOf(task, stage, roundAt) {
    const key = String(task.id) + '@' + String(stage)
    const existing = memory.stageEvents.get(key)
    if (existing !== undefined && existing.round === roundAt) return existing
    // `since` is the floor of the CURRENT budget slice: a continue restarts the
    // slice clock at the moment it is applied, so extending a stage that is
    // already hours late does not immediately ask again.
    const fresh = { round: roundAt, continues: 0, defaults: 0, since: 0, decisionId: null, decisionAt: 0 }
    memory.stageEvents.set(key, fresh)
    return fresh
  }

  /**
   * How much silence one budget slice may reach before it is a timeout. A slice
   * is always STAGE_BUDGET_MS long and a continue starts a NEW slice at the
   * moment it is applied (budget.since), which is what "extend by 20 minutes"
   * means for a stage that was already late.
   */
  function stageUntilOf() {
    return STAGE_BUDGET_MS
  }

  function stageIdentitiesOf(executor) {
    const ids = []
    if (executor === null || executor === undefined) return ids
    if (typeof executor.id === 'string' && executor.id !== '') ids.push(executor.id)
    if (typeof executor.name === 'string' && executor.name !== '') ids.push(executor.name)
    return ids
  }

  /**
   * T-197 requirement 7: ANY identifiable stage activity renews the watchdog, not
   * only a task_center call. The host's subagent tree reports which children are
   * EXECUTING a turn, so a tester inside one long pwsh/read/probe sequence is
   * renewed here instead of being judged silent.
   */
  async function renewStageActivityFromTree(board, now) {
    if (taskAgents === null || taskAgents === undefined || typeof taskAgents.listAgentsFor !== 'function') return 0
    if (board === null || board === undefined || Array.isArray(board.tasks) === false) return 0
    const byRoot = new Map()
    for (const task of board.tasks) {
      const stage = stageOfTask(task)
      if (stage === null) continue
      const rootId = typeof task.ownerSession === 'string' && task.ownerSession !== '' ? task.ownerSession : null
      if (rootId === null) continue
      if (byRoot.has(rootId) === false) byRoot.set(rootId, [])
      byRoot.get(rootId).push(task)
    }
    let renewed = 0
    for (const [rootId, tasks] of byRoot) {
      let rows = null
      try {
        rows = await taskAgents.listAgentsFor(rootId)
      } catch (error) {
        rows = null
      }
      if (Array.isArray(rows) === false) continue
      const running = new Set()
      for (const row of rows) {
        if (row === null || row === undefined || row.kind !== 'child') continue
        if (row.activity !== 'running') continue
        running.add(String(row.id))
      }
      if (running.size === 0) continue
      for (const task of tasks) {
        const stage = stageOfTask(task)
        if (stage === null) continue
        const executor = stageExecutorOfRun(task, stage)
        if (executor === null || executor.id === null || running.has(executor.id) === false) continue
        recordPhaseActivity(ctx, String(task.id), executor.id, now, executor.id)
        renewed += 1
      }
    }
    return renewed
  }

  /** A durable one-line history row on the card. Never throws. */
  async function appendStageHistory(projectPath, taskId, note) {
    try {
      const applied = await state.apply(
        projectPath,
        (board) => {
          const task = model.findTask(board, taskId)
          if (task === undefined || task === null) return null
          const at = new Date(state.clock()).toISOString()
          const tasks = board.tasks.map((row) => {
            if (String(row.id) !== String(taskId)) return row
            const history = Array.isArray(row.history) ? row.history : []
            return Object.assign({}, row, {
              history: history.concat([{ at: at, by: 'system', byName: null, from: row.status, to: row.status, note: String(note) }]),
            })
          })
          return { ok: true, board: Object.assign({}, board, { tasks: tasks }), events: [] }
        },
        writePolicyFor(projectPath),
      )
      return applied !== null && applied !== undefined && applied.failed === undefined
    } catch (error) {
      return false
    }
  }

  /** The live children of one root, or null when this host cannot tell. */
  async function liveStageChildIds(rootId) {
    if (taskAgents === null || taskAgents === undefined) return null
    let rows = null
    try {
      rows = typeof taskAgents.listAgentsFor === 'function' ? await taskAgents.listAgentsFor(rootId) : null
    } catch (error) {
      rows = null
    }
    if (Array.isArray(rows) === false) return null
    const ids = new Set()
    for (const row of rows) {
      if (row === null || row === undefined || row.kind !== 'child') continue
      ids.add(String(row.id))
    }
    return ids
  }

  /** Send one line to the child that owns an OPEN stage (never to the root). */
  async function messageStageChild(task, stage, text) {
    const executor = stageExecutorOfRun(task, stage)
    if (executor === null || executor.id === null) return false
    return await sendToAgent(task.ownerSession, executor.id, text)
  }

  /** The full question of one stage timeout (packet §3.3–§3.5). */
  function stageQuestionOf(task, stage, budget, waitedMs, now, executor, downstream, policy) {
    const event = stage === 'dev' ? STAGE_EVENTS.devTimeout : stage === 'review' ? STAGE_EVENTS.reviewTimeout : STAGE_EVENTS.testTimeout
    const label = STAGE_EVENT_LABELS[event]
    const candidate =
      task.merge !== null && task.merge !== undefined && typeof task.merge.mergeCommit === 'string' && task.merge.mergeCommit !== ''
        ? 'candidate ' + String(task.merge.mergeCommit)
        : null
    // T-198: the configured default option and answer deadline replace the
    // built-in ones — only when they name an option this question really offers.
    const options = stageTimeoutOptions(stage)
    const configured = policy === null || policy === undefined ? null : policy
    const defaultOption =
      configured !== null && typeof configured.defaultOption === 'string' && options.some((option) => option.id === configured.defaultOption)
        ? configured.defaultOption
        : STAGE_DEFAULT_OPTION
    const timeoutMs =
      configured !== null && Number.isFinite(configured.timeoutSeconds) ? configured.timeoutSeconds * 1000 : STAGE_DECISION_TIMEOUT_MS
    const limit = configured !== null && Number.isFinite(configured.limit) && configured.limit >= 0 ? Math.floor(configured.limit) : STAGE_CONTINUE_LIMIT
    return {
      id: stageDecisionId(task.id, event, budget.round, budget.continues),
      eventKey: event,
      taskId: String(task.id),
      eventLabel: label,
      title: String(task.id) + ' ' + label,
      body: stageTimeoutBody({
        stage: stage,
        waitedMs: waitedMs,
        lastActivity: new Date(Math.max(0, now - waitedMs)).toISOString(),
        worktree: typeof task.worktree === 'string' && task.worktree !== '' ? task.worktree : null,
        candidate: candidate,
        defaults: budget.defaults,
        limit: limit,
        executor: stage === 'dev' ? null : String(stage === 'review' ? 'reviewer' : 'tester'),
        // Only a dev timeout lists the dependency tree: review/test cards have
        // no say over their downstream, and the tree belongs to the cancel option.
        downstream: stage === 'dev' ? downstream : null,
      }),
      options: options,
      defaultOption: defaultOption,
      timeoutMs: timeoutMs,
      payload: {
        action: 'stage-timeout',
        stage: stage,
        taskId: String(task.id),
        round: budget.round,
        continues: budget.continues,
        // A dev retry destroys uncommitted work: the panel asks for the word.
        confirmOption: stage === 'dev' ? 'retry-dev' : null,
        // T-198: the consecutive limit this question was asked UNDER. An expired
        // question applies this limit, so the automatic default agrees with the
        // modal body (a question showing 连续超时 0/5 must not block at 3).
        policyLimit: limit,
      },
    }
  }

  /**
   * Ask ONE timeout question for this round slice. The id is stable per round and
   * slice, so a tick that sees the same stage again re-reads the SAME question
   * instead of stacking a second modal.
   */
  async function requestStageTimeout(projectPath, task, stage, budget, now, waitedMs, executor, downstream, policy) {
    if (stageHost === null || typeof stageHost.request !== 'function') {
      // A direct dispatcher user has no decision store. Never block silently:
      // the card keeps its budget and the tick reports the same state.
      return null
    }
    let requested = null
    try {
      requested = await stageHost.request(projectPath, stageQuestionOf(task, stage, budget, waitedMs, now, executor, downstream, policy))
    } catch (error) {
      requested = { ok: false, code: 'request-failed', message: String((error && error.message) || error) }
    }
    if (requested === null || requested === undefined || requested.ok !== true) {
      emit('stage-timeout-unasked', 'host', {
        taskId: task.id,
        detail: 'could not record the stage question: ' + String(requested === null || requested === undefined ? 'no-result' : requested.code || requested.message),
      })
      return null
    }
    const decision = requested.decision === null || requested.decision === undefined ? null : requested.decision
    if (decision !== null && decision.status === 'pending') {
      budget.decisionId = decision.id
      budget.decisionAt = now
      emit('stage-timeout-asked', 'host', {
        taskId: task.id,
        detail:
          stage +
          ' timed out; asked the human (decision ' +
          String(decision.id) +
          ', default ' +
          String(decision.defaultOption) +
          ' in ' +
          String(Math.round((Number.isFinite(decision.remainingMs) ? decision.remainingMs : 0) / 60000)) +
          'm)',
      })
    }
    return decision
  }

  /**
   * Apply a "continue" to the budget of the stage round it belongs to. It never
   * restarts the worker, never touches the worktree or the candidate: it buys one
   * more slice of the SAME stage. The third CONSECUTIVE default-continue stops
   * asking and blocks the card (packet §3.3).
   */
  async function applyStageContinue(projectPath, input) {
    const row = input === undefined || input === null ? {} : input
    const taskId = row.taskId === undefined || row.taskId === null ? '' : String(row.taskId)
    const stage = row.stage === 'review' ? 'review' : row.stage === 'test' ? 'test' : 'dev'
    // T-198: the policy owns the consecutive limit and the announcement.
    const continueLimit = Number.isFinite(row.limit) && row.limit >= 0 ? Math.floor(row.limit) : STAGE_CONTINUE_LIMIT
    const silent = row.silent === true
    const policyApplied = row.source === 'policy'
    if (taskId === '') return { ok: false, code: 'invalid-stage', message: 'a stage budget needs a task id' }
    const read = await state.read(projectPath)
    if (read.failed !== null) return { ok: false, code: read.failed.code === undefined ? 'board-unreadable' : String(read.failed.code), message: String(read.failed.message || 'the board could not be read') }
    const task = model.findTask(read.board, taskId)
    if (task === undefined || task === null) return { ok: false, code: 'unknown-task', message: 'no task with id ' + taskId }
    if (stageOfTask(task) !== stage) return { ok: false, code: 'stage-closed', message: taskId + ' is no longer in its ' + stage + ' stage; nothing was extended' }
    const roundAt = stageRoundAt(task, stage)
    if (roundAt === null) return { ok: false, code: 'stage-closed', message: taskId + ' has no open ' + stage + ' round' }
    const budget = stageStateOf(task, stage, roundAt)
    const viaTimeout = row.viaTimeout === true
    budget.decisionId = null
    budget.decisionAt = 0
    if (viaTimeout === true && budget.defaults + 1 >= continueLimit) {
      budget.defaults += 1
      const blocked = await applyReap(projectPath, (board) => {
        const live = model.findTask(board, taskId)
        if (live === undefined || live === null || stageOfTask(live) !== stage) return null
        const result = model.blockTask(board, taskId, state.clock(), 'system', continueLimit + ' consecutive default-continues on the ' + stage + ' stage; blocked for triage')
        return result.ok === true ? result.board : null
      })
      await appendStageHistory(projectPath, taskId, '连续 ' + continueLimit + ' 次阶段超时默认继续，已自动阻塞；不再提问（运行中的 stage agent 未被强制终止，由其自行结束本轮）')
      if (silent !== true) {
        emit('stage-timeout-blocked', 'system', { taskId: taskId, detail: 'continuous default-continues reached ' + String(continueLimit) + '; card blocked without another question' })
      }
      return { ok: blocked !== null, blocked: blocked !== null, count: budget.defaults, continues: budget.continues, limit: continueLimit, extendedMs: 0 }
    }
    budget.continues += 1
    budget.since = state.clock()
    if (viaTimeout === true) budget.defaults += 1
    else budget.defaults = 0
    const minutes = String(Math.round(STAGE_CONTINUE_MS / 60000))
    const note =
      viaTimeout === true
        ? policyApplied === true
          ? '阶段超时按策略自动继续（' + String(row.mode === 'silent' ? 'silent' : 'notify') + '）：' + stage + ' 预算延长 ' + minutes + ' 分钟（连续默认继续 ' + String(budget.defaults) + '/' + String(continueLimit) + '）'
          : '阶段超时未回答，默认继续：' + stage + ' 预算延长 ' + minutes + ' 分钟（连续默认继续 ' + String(budget.defaults) + '/' + String(continueLimit) + '）'
        : '人工选择继续：' + stage + ' 预算延长 ' + minutes + ' 分钟（连续默认继续计数清零）'
    await appendStageHistory(projectPath, taskId, note)
    if (silent !== true) emit('stage-timeout-continued', 'host', { taskId: taskId, detail: note })
    if (silent !== true) await messageStageChild(task, stage, taskId + ' ' + stage + ': the host extended this stage by ' + minutes + 'm after a timeout decision. Keep going in the same worktree; nothing was restarted.')
    return { ok: true, blocked: false, continues: budget.continues, defaults: budget.defaults, limit: continueLimit, extendedMs: STAGE_CONTINUE_MS }
  }

  /** A new stage round starts with a full budget (after a replace/retry). */
  function resetStageBudget(taskId, stage) {
    memory.stageEvents.delete(String(taskId) + '@' + String(stage))
    return true
  }

  /**
   * "Retry development" (packet §3.3): the uncommitted work in the attempt
   * worktree is DISCARDED, the worker is stopped, and the card goes back to the
   * queue so the next attempt is created from the target branch again.
   */
  async function retryDevelopment(projectPath, taskId) {
    const read = await state.read(projectPath)
    if (read.failed !== null) return { ok: false, code: 'board-unreadable', message: String(read.failed.message || 'the board could not be read') }
    const task = model.findTask(read.board, String(taskId))
    if (task === undefined || task === null) return { ok: false, code: 'unknown-task', message: 'no task with id ' + String(taskId) }
    if (task.status !== 'running') return { ok: false, code: 'not-running', message: String(taskId) + ' is ' + task.status + ', not running' }
    const holder = task.assignee === null || task.assignee === undefined ? null : task.assignee.session
    const stopped = typeof holder === 'string' && holder !== '' ? await stopAgent(holder) : false
    const worktree = typeof task.worktree === 'string' && task.worktree !== '' ? task.worktree : null
    const removed = worktree !== null ? await removeWorktree(gitFacade(), projectPath, worktree) : null
    releaseTaskLocks(String(taskId))
    // state.apply's mutator contract is a { ok, board, events } ENVELOPE (unlike
    // applyReap, which takes a bare board). The CAS re-check inside the write is
    // what keeps a card that already left running (a submit landed while the
    // worker was being stopped) from being overwritten with pending.
    const applied = await state.apply(
      projectPath,
      (board) => {
        const live = model.findTask(board, String(taskId))
        if (live === undefined || live === null) {
          return { ok: false, code: 'unknown-task', message: 'no task with id ' + String(taskId) }
        }
        if (live.status !== 'running') {
          return { ok: false, code: 'not-running', message: String(taskId) + ' is ' + live.status + ' now; the retry was not applied' }
        }
        const at = new Date(state.clock()).toISOString()
        const note =
          worktree === null
            ? 'dev timeout: retry development requeued the card; the next attempt starts from the target branch'
            : removed === true
              ? 'dev timeout: retry development discarded the uncommitted work and removed ' + worktree + '; the next attempt starts from the target branch'
              : 'dev timeout: retry development stopped the worker but the worktree ' + worktree + ' could not be removed; its uncommitted changes were not discarded and the next attempt reuses or recreates it'
        const tasks = board.tasks.map((row) => {
          if (String(row.id) !== String(taskId)) return row
          const history = Array.isArray(row.history) ? row.history : []
          return Object.assign({}, row, {
            status: 'pending',
            assignee: null,
            leaseUntil: null,
            attempts: 0,
            interruptions: 0,
            dispatch: null,
            history: history.concat([
              { at: at, by: 'system', byName: null, from: 'running', to: 'pending', note: note },
            ]),
          })
        })
        return { ok: true, board: Object.assign({}, board, { tasks: tasks }), events: [] }
      },
      writePolicyFor(projectPath),
    )
    if (applied.failed !== null) return applied.failed
    memory.stageEvents.delete(String(taskId) + '@dev')
    emit('dev-retry', 'host', {
      taskId: String(taskId),
      detail:
        worktree !== null && removed !== true
          ? 'worker stopped; worktree removal failed, card requeued for a fresh attempt'
          : 'uncommitted work discarded; card requeued for a fresh attempt',
    })
    return { ok: true, stopped: stopped, worktree: worktree, removed: removed }
  }

  /**
   * Event 10 (packet §3.10): a host event that is NOTIFY by default. It writes
   * the activity stream and a task history row, and messages the card's live
   * Agent; it never opens a modal. The SAME event failing STAGE_RECOVERY_LIMIT
   * times in a row escalates to an ask, decided by the caller (the API).
   */
  async function notifyStageEvent(projectPath, input) {
    const row = input === undefined || input === null ? {} : input
    const taskId = typeof row.taskId === 'string' && row.taskId !== '' ? row.taskId : null
    const event = typeof row.event === 'string' && row.event !== '' ? row.event : null
    if (taskId === null || event === null) return { ok: false, code: 'invalid-event', message: 'a stage event needs a task id and an event key' }
    const key = taskId + '@' + event
    // T-197 review fix: "consecutive" means the same INCIDENT, not the card's
    // whole lifetime. The epoch is the card's current stage round (or status for
    // a card with no open stage), so a card that made progress in between starts
    // a fresh streak instead of escalating on the third unrelated incident.
    const read = await state.read(projectPath)
    const current = read.failed === null ? model.findTask(read.board, taskId) : null
    const currentStage = current === undefined || current === null ? null : stageOfTask(current)
    const currentRoundAt = currentStage === null ? null : stageRoundAt(current, currentStage)
    const epoch =
      (current === undefined || current === null ? 'missing' : String(current.status)) + '@' + String(currentStage) + '@' + String(currentRoundAt)
    const previous = memory.stageRecoveries.get(key)
    const count = (previous !== undefined && previous.epoch === epoch ? previous.count : 0) + 1
    memory.stageRecoveries.set(key, { count: count, at: state.clock(), epoch: epoch })
    const action = STAGE_EVENT_ACTIONS[event] === undefined ? '自动处置' : STAGE_EVENT_ACTIONS[event]
    const detail = event + ' 已自动处置：' + action + '（连续 ' + String(count) + ' 次）' + (typeof row.detail === 'string' && row.detail !== '' ? ' — ' + row.detail : '')
    // T-198: the event policy decides whether the user is TOLD and how many
    // consecutive auto-recoveries may fail before the ask.
    const silent = row.silent === true
    const limit = row.limit === null ? null : Number.isFinite(row.limit) ? Math.max(0, Math.floor(row.limit)) : STAGE_RECOVERY_LIMIT
    if (silent !== true) emit('stage-event', 'host', { taskId: taskId, detail: detail })
    // The card history is the AUDIT record: it is written in every mode. A
    // silent event says so, so the audit trail states the host told nobody.
    await appendStageHistory(projectPath, taskId, silent === true ? detail + '（silent：仅审计，未通知）' : detail)
    // The owner Agent reads it on its next turn; a silent event never messages.
    if (silent !== true && current !== undefined && current !== null && currentStage !== null) {
      await messageStageChild(current, currentStage, taskId + ': ' + detail + '. The host acted automatically; no answer is needed unless a decision appears.')
    }
    const escalate = silent !== true && limit !== null && count > limit
    if (escalate === true) {
      emit('stage-event-escalated', 'host', { taskId: taskId, detail: event + ': ' + String(count) + ' consecutive failed auto-recoveries; escalating to an ask' })
      await appendStageHistory(projectPath, taskId, event + ' 连续 ' + String(count) + ' 次自动恢复失败，升级为询问')
    }
    return { ok: true, count: count, escalate: escalate, action: action, limit: limit, silent: silent }
  }

  /**
   * The ask an event escalates to after STAGE_RECOVERY_LIMIT failed
   * auto-recoveries (packet §3.10). It is a normal DecisionRequest: the panel
   * shows it, the 120s default keeps recovering, and only the human can stop it.
   */
  async function requestStageRecoveryAsk(projectPath, task, event, count, options) {
    if (stageHost === null || typeof stageHost.request !== 'function') return null
    const label = STAGE_EVENT_LABELS[event] === undefined ? String(event) : STAGE_EVENT_LABELS[event]
    const action = STAGE_EVENT_ACTIONS[event] === undefined ? '自动处置' : STAGE_EVENT_ACTIONS[event]
    // T-198: the event policy's default ('block'/'cancel' map to their own
    // option; anything else means "keep auto-recovering") and answer deadline.
    // A finite 0 is a real value: NO deadline (the same meaning stage timeouts
    // give it). Only an absent/null deadline falls back to the built-in 120s.
    const configured = options === undefined || options === null ? {} : options
    const defaultOption = configured.defaultOption === 'block' ? 'block' : configured.defaultOption === 'cancel' ? 'cancel' : 'continue'
    const timeoutMs = Number.isFinite(configured.timeoutMs) ? Math.floor(configured.timeoutMs) : STAGE_DECISION_TIMEOUT_MS
    const input = {
      id: 'stage-ask-' + String(task.id) + '-' + String(event) + '-' + String(Math.floor(state.clock())),
      eventKey: String(event),
      taskId: String(task.id),
      eventLabel: label,
      title: String(task.id) + ' ' + label + '（连续自动恢复失败）',
      body: '自动恢复已连续失败 ' + String(count) + ' 次（' + action + '），' + (defaultOption === 'continue' ? '已升级为询问。' : '按策略询问是否停止自动恢复。'),
      options: [
        { id: 'continue', label: '继续自动恢复', description: '再自动处置一次', default: defaultOption === 'continue' },
        { id: 'block', label: '阻塞任务', description: '保留现场，等待人工处理', default: defaultOption === 'block' },
        { id: 'cancel', label: '取消任务', description: '下游卡片需重新评估', default: defaultOption === 'cancel' },
      ],
      defaultOption: defaultOption,
      timeoutMs: timeoutMs,
      payload: { action: 'stage-event-ask', event: String(event), taskId: String(task.id) },
    }
    let requested = null
    try {
      requested = await stageHost.request(projectPath, input)
    } catch (error) {
      requested = null
    }
    if (requested === null || requested === undefined || requested.ok !== true) return null
    emit('stage-event-ask', 'host', { taskId: task.id, detail: String(event) + ': ' + String(count) + ' failed auto-recoveries; asked the human' })
    return requested.decision === null || requested.decision === undefined ? null : requested.decision
  }

  /** Re-read the card right before a nudge: a landed verdict makes it obsolete. */
  async function freshStageRound(projectPath, taskId, stage, roundAt) {
    try {
      const read = await state.read(projectPath)
      if (read.failed !== null) return null
      const task = model.findTask(read.board, String(taskId))
      if (task === undefined || task === null) return null
      if (stageOfTask(task) !== stage) return null
      if (stageRoundAt(task, stage) !== roundAt) return null
      return task
    } catch (error) {
      return null
    }
  }

  /**
   * One-line reminder / grace notice for an open review/test round. The board is
   * re-read IMMEDIATELY before the send: a verdict (or a phase change) that landed
   * since the snapshot means the nudge is not sent at all. The host cannot recall
   * a message that already reached the Agent inbox — that needs a delivery-time
   * inbox API (a separate DSH dependency, not implemented here) — so the text
   * itself says it is non-authoritative.
   */
  async function sendStageNudge(projectPath, task, stage, budget, waitedMs, untilMs, grace) {
    const executor = stageExecutorOfRun(task, stage)
    if (executor === null || executor.id === null) return false
    const fresh = await freshStageRound(projectPath, task.id, stage, budget.round)
    if (fresh === null) return false
    const freshExecutor = stageExecutorOfRun(fresh, stage)
    if (freshExecutor === null || freshExecutor.id === null) return false
    const remainingMs = Math.max(0, untilMs - waitedMs)
    const text = stageReminderText({ taskId: String(fresh.id), title: typeof fresh.title === 'string' ? fresh.title : '', stage: stage, waitedMs: waitedMs, untilMs: remainingMs, grace: grace === true })
    return await sendToAgent(fresh.ownerSession, freshExecutor.id, text)
  }

  /** Reminder and grace inside one budget slice; both are one line and idempotent. */
  async function nudgeStage(projectPath, task, stage, budget, now, waitedMs, untilMs) {
    if (stage === 'dev') return { reminded: false }
    const roundKey = String(task.id) + '@' + stage + '@' + String(budget.round) + '@' + String(budget.continues)
    const reminderAt = Math.max(1, Math.round(untilMs / 2))
    const graceAt = Math.max(reminderAt + 1, untilMs - phaseGraceMs)
    if (waitedMs >= graceAt && memory.stageGrace.has(roundKey) === false) {
      const sent = await sendStageNudge(projectPath, task, stage, budget, waitedMs, untilMs, true)
      if (sent === true) {
        memory.stageGrace.set(roundKey, now)
        emit('stage-grace', 'system', { taskId: task.id, detail: stage + ' about to time out; one-line grace notice sent' })
      }
      return { reminded: false, grace: sent === true }
    }
    if (waitedMs >= reminderAt && memory.stageReminders.has(roundKey) === false) {
      const sent = await sendStageNudge(projectPath, task, stage, budget, waitedMs, untilMs, false)
      if (sent === true) {
        memory.stageReminders.set(roundKey, now)
        emit('stage-reminder', 'system', { taskId: task.id, detail: stage + ' still pending; one-line reminder sent' })
        return { reminded: true }
      }
    }
    return { reminded: false }
  }

  /**
   * The STAGE sweep, driven by the host tick: dev/review/test timeouts ask the
   * human instead of blocking, and a continue extends the same stage's budget.
   * The store's 120s deadline is swept here too, so the default applies even with
   * no panel polling. Nothing in this path stops a live agent.
   */
  async function sweepStageTimeouts(projectPath, board, now) {
    const result = { decisions: [], reminded: [], renewed: 0, autoApplied: [] }
    if (stageHost !== null && typeof stageHost.sweep === 'function') {
      try {
        await stageHost.sweep(projectPath)
      } catch (error) {}
    }
    // T-198: ONE policy read per tick feeds every stage event. Without a policy
    // host (a direct dispatcher user) the built-in ask behaviour stays.
    let stagePolicy = null
    if (stageHost !== null && typeof stageHost.policyFor === 'function') {
      try {
        stagePolicy = await stageHost.policyFor(projectPath)
      } catch (error) {
        stagePolicy = null
      }
    }
    result.renewed = await renewStageActivityFromTree(board, now)
    const liveEvents = new Set()
    const liveNudges = new Set()
    for (const task of Array.isArray(board.tasks) ? board.tasks : []) {
      const stage = stageOfTask(task)
      if (stage === null) continue
      const roundAt = stageRoundAt(task, stage)
      if (roundAt === null) continue
      const budget = stageStateOf(task, stage, roundAt)
      liveEvents.add(String(task.id) + '@' + stage)
      liveNudges.add(String(task.id) + '@' + stage + '@' + String(budget.round) + '@' + String(budget.continues))
      const executor = stageExecutorOfRun(task, stage)
      const lastAt = Math.max(roundAt, Number.isFinite(budget.since) ? budget.since : 0, phaseActivityAt(ctx, task.id, stageIdentitiesOf(executor)))
      const waitedMs = Math.max(0, now - lastAt)
      const untilMs = stageUntilOf()
      if (waitedMs < untilMs) {
        const nudged = await nudgeStage(projectPath, task, stage, budget, now, waitedMs, untilMs)
        if (nudged.reminded === true) result.reminded.push(task.id)
        continue
      }
      if (budget.decisionId !== null) continue
      const event = stage === 'dev' ? STAGE_EVENTS.devTimeout : stage === 'review' ? STAGE_EVENTS.reviewTimeout : STAGE_EVENTS.testTimeout
      const policy = stagePolicy === null || stagePolicy[event] === undefined ? null : stagePolicy[event]
      // T-198 notify/silent: no modal. The configured default option is applied
      // and the continue counts against the configured consecutive limit.
      if (policy !== null && policy.mode !== 'ask') {
        const applied =
          stageHost !== null && typeof stageHost.applyOption === 'function'
            ? await stageHost.applyOption(projectPath, {
                taskId: task.id,
                stage: stage,
                option: policy.defaultOption,
                limit: policy.limit,
                silent: policy.mode === 'silent',
                mode: policy.mode,
              })
            : null
        if (applied !== null && applied !== undefined) {
          result.autoApplied.push({ taskId: String(task.id), stage: stage, option: String(policy.defaultOption), mode: policy.mode, ok: applied.ok === true })
          if (applied.ok === true) continue
        }
        emit('stage-timeout-unasked', 'host', {
          taskId: task.id,
          detail: 'the ' + event + ' policy could not apply ' + String(policy.defaultOption) + '; no question was opened',
        })
        continue
      }
      const downstream = stage === 'dev' ? stageDownstreamOf(board, task.id) : null
      const decision = await requestStageTimeout(projectPath, task, stage, budget, now, waitedMs, executor, downstream, policy)
      if (decision !== null && decision.status === 'pending') result.decisions.push(task.id)
    }
    for (const key of Array.from(memory.stageEvents.keys())) {
      if (liveEvents.has(key) === false) memory.stageEvents.delete(key)
    }
    for (const key of Array.from(memory.stageReminders.keys())) {
      if (liveNudges.has(key) === false) memory.stageReminders.delete(key)
    }
    for (const key of Array.from(memory.stageGrace.keys())) {
      if (liveNudges.has(key) === false) memory.stageGrace.delete(key)
    }
    // T-197 review fix: a closed card closes its recovery streak; a worker-lost
    // streak whose card has since reached review/test counts as a SUCCESSFUL
    // recovery, so a later incident starts over instead of escalating.
    for (const key of Array.from(memory.stageRecoveries.keys())) {
      const at = key.lastIndexOf('@')
      const taskId = at < 0 ? key : key.slice(0, at)
      const event = at < 0 ? '' : key.slice(at + 1)
      const task = model.findTask(board, taskId)
      // A task that is not on THIS board may live in another project: this sweep
      // may not judge (or clear) that streak.
      if (task === undefined || task === null) continue
      const closed = task.status === 'done' || task.status === 'cancelled'
      const workerProgressed =
        event === STAGE_EVENTS.workerLost &&
        task.status !== 'running' &&
        task.status !== 'pending' &&
        task.status !== 'blocked'
      if (closed || workerProgressed) memory.stageRecoveries.delete(key)
    }
    return result
  }

  /** Record why a card could not be handed to its own team, without borrowing. */
  async function markExecutorMissing(project, taskId, reason, detail) {
    try {
      const applied = await state.apply(
        project,
        (board) => {
          const tasks = board.tasks.map((entry) =>
            String(entry.id) === String(taskId)
              ? Object.assign({}, entry, { waitingReason: reason, waitingDetail: detail === undefined ? null : String(detail) })
              : entry,
          )
          return { ok: true, board: Object.assign({}, board, { tasks: tasks }), events: [] }
        },
        writePolicyFor(project),
      )
      return applied
    } catch (error) {
      return null
    }
  }

  /**
   * The v3 dispatch path: one task, one worker spawned under the exact root
   * Agent. No idle-member scan, no worker pool, no team-name routing.
   */
  async function dispatchWithAgent(task, project, dispatch, reserved, workerConfig) {
    if (taskAgents === null || taskAgents.available !== true) return { id: task.id, skipped: 'agent-runtime-unavailable', message: 'the root Agent subagent runtime is not ready' }
    const cardSession = typeof task.ownerSession === 'string' && task.ownerSession !== '' ? task.ownerSession : taskAgents.rootId !== null ? taskAgents.rootId : selfSessionId
    if (cardSession === null) return { id: task.id, skipped: 'no-root-session', message: 'the task has no root Session to be owned by' }
    if (task.writeFiles.length > 0) {
      const conflicts = locks.conflictsFor(state.memory.locks, task.writeFiles, 'task:' + task.id)
      if (conflicts.length > 0) return { id: task.id, skipped: 'files-busy', conflicts: conflicts }
    }
    let lockPaths = []
    if (task.kind !== 'investigate' && task.writeFiles.length > 0) {
      const acquired = locks.acquire(
        state.memory.locks,
        task.writeFiles,
        { taskId: task.id, agent: 'worker-' + String(task.id) },
        state.clock(),
        TASK_LEASE_MS,
      )
      if (acquired.ok !== true || acquired.granted !== true) {
        return { id: task.id, skipped: 'files-busy', conflicts: acquired.conflicts === undefined ? [] : acquired.conflicts }
      }
      state.memory.locks = acquired.locks
      lockPaths = acquired.paths
    }
    let worktree
    try {
      worktree = await prepareWorktree(gitFacade(), project, task, dispatch, model.attemptSlot(task), worktreeDeadlineMs)
    } catch (error) {
      worktree = worktreeFallback('worktree-error', String((error && error.message) || error))
    }
    if (worktree.error !== null) {
      releaseTaskLocks(task.id)
      return {
        id: task.id,
        skipped: isTransientEnvironmentCode(worktree.code) ? 'environment-dirty' : 'worktree-unavailable',
        reason: String(worktree.code),
        detail: String(worktree.message),
      }
    }
    const brief = task.kind === 'investigate'
      ? investigationBriefFor(task, project, { path: worktree.path, base: worktree.base, target: worktree.target })
      : briefFor(task, project, taskAgents.root === null ? 'lead' : String(taskAgents.root.name || 'lead'), workerConfig)
    let spawned
    try {
      spawned = await taskAgents.startWorker(task, brief)
    } catch (error) {
      releaseTaskLocks(task.id)
      await removeWorktree(gitFacade(), project, worktree.path)
      return { id: task.id, skipped: 'spawn-failed', message: String((error && error.message) || error) }
    }
    let claimed = null
    try {
      claimed = await state.apply(
        project,
        (board) => model.claimTask(board, task.id, {
          name: spawned.name,
          session: spawned.agentId,
          via: 'spawn',
          host: boot,
          lead: taskAgents.root === null ? null : String(taskAgents.root.name || 'lead'),
          leadSession: taskAgents.rootId,
          cardSession: cardSession,
          project: project,
          worktree: worktree,
          targetBase: typeof worktree.base === 'string' ? worktree.base : null,
          ownerCompat: false,
          compat: false,
          compatDetail: null,
        }, state.clock()),
        writePolicyFor(project),
      )
    } catch (error) {
      claimed = { failed: { message: String((error && error.message) || error) } }
    }
    if (claimed === null || claimed.failed !== undefined) {
      const message = claimed === null ? 'claim failed' : String(claimed.failed.message || 'claim failed')
      releaseTaskLocks(task.id)
      await taskAgents.release(spawned.agentId)
      await removeWorktree(gitFacade(), project, worktree.path)
      return { id: task.id, error: message, skipped: 'claim-failed' }
    }
    const recorded = await state.apply(
      project,
      (board) => model.recordDispatch(board, task.id, { status: 'sent', at: new Date(state.clock()).toISOString() }, state.clock()),
      writePolicyFor(project),
    )
    if (recorded.failed !== undefined) {
      // The worker was already started; leave it alive and let the normal
      // reconciliation path settle the card. The result still names the agent.
    }
    return {
      id: task.id,
      ok: true,
      target: spawned.name,
      agentId: spawned.agentId,
      spawned: true,
      files: lockPaths,
      worktree: worktree.path,
      worktreeError: null,
    }
  }

  async function tick(projectPath) {
    const project = typeof projectPath === 'string' && projectPath.length > 0 ? projectPath : projectOf()
    if (typeof project !== 'string' || project.length === 0) return { ok: true, skipped: 'unknown-project' }
    if (memory.sweeping) {
      memory.rerun = project
      return { ok: true, skipped: 'already-sweeping' }
    }
    memory.sweeping = true
    const now = state.clock()
    const results = []
    let paused = false
    try {
      // One project has one leader. A refused claim means another live host owns
      // this project; do not read/reap/claim its cards from here.
      const leadership = await leaseGate.claim(project)
      if (leadership.leader !== true) {
        memory.lastError = String(leadership.message || 'another host holds the project lease')
        return {
          ok: true,
          skipped: 'not-leader',
          code: leadership.code === undefined ? 'not-leader' : leadership.code,
          message: memory.lastError,
        }
      }
      if (reconcile !== null) {
        try {
          const reconciled = await reconcile(project)
          if (reconciled !== null && reconciled !== undefined && reconciled.ok === false) {
            memory.lastError = 'merge reconcile failed: ' + String(reconciled.message || reconciled.code || 'unknown')
          }
        } catch (error) {
          memory.lastError = 'merge reconcile failed: ' + String((error && error.message) || error)
        }
      }
      state.sweepLocks()
      const read = await state.read(project)
      if (read.failed !== null) {
        memory.lastError = read.failed.message
        return { ok: false, code: read.failed.code, message: read.failed.message }
      }
      restoreLocks(read.board)
      // The host heartbeat runs FIRST: a task still inside its lease must not be
      // reaped merely because its worker produced no tool calls for a while.
      let current = await applyHeartbeat(project, read.board, now)
      current = await reap(project, current, now)
      // T-197: dev/review/test timeouts ASK before anything stops. A question is
      // never a block, a continue never restarts the worker, and no path here
      // disposes a live stage child.
      const stageSweep = await sweepStageTimeouts(project, current, now)
      for (const id of stageSweep.reminded) results.push({ id: id, stage: 'reminded' })
      for (const id of stageSweep.decisions) results.push({ id: id, stage: 'asked' })
      const dispatch = current.dispatch
      if (dispatch.state !== 'running') {
        return { ok: true, state: 'paused', tasks: current.tasks.length, results: results }
      }
      // One environment probe per pass: what the panel shows (clean? checked when?)
      // and, when the window has closed, the sweep that clears stale markers.
      const probed = await probeEnvironment(project, now)
      if (probed.board !== null) current = probed.board
      const running = current.tasks.filter((task) => task.status === 'running').length
      let slots = dispatch.maxConcurrent - running
      if (slots <= 0) return { ok: true, state: 'running', slots: 0, results: results }

      // The worker prompt and skills belong to the handover itself, so resolve the
      // project role config once per dispatch pass. A missing/broken file falls
      // back to the schema defaults, exactly like every other role read.
      let workerConfig = null
      try {
        const fs = ctx.fs
        if (fs !== undefined && fs !== null) workerConfig = (await readRoleConfig({ fs: fs }, { projectPath: project })).config
      } catch (error) {
        workerConfig = null
      }

      const ready = model.readyTasks(current)
      const reserved = new Set()
      for (const candidate of ready) {
        if (slots <= 0) break
        const task = model.findTask(current, candidate.id)
        if (task === undefined || task.status !== 'pending') continue
        // One task, one live agent: a task requeued after a handover must not be
        // dispatched while the previous holder is still alive, no matter which
        // pass requeued it. A liveness-capped handover is the single exception —
        // that holder was explicitly told to stop.
        // T-97: a card belongs to the session that created it. This dispatcher
        // serves ONE session; anything else is refused, never handed to its team.
        const ownerSession = typeof task.ownerSession === 'string' && task.ownerSession !== '' ? task.ownerSession : null
        // With no session identity (legacy profile) the dispatcher keeps serving
        // every card; with one, it serves strictly its own.
        if (ownerSession !== null && selfSessionId !== null && ownerSession !== selfSessionId) {
          // Not ours: leave the card untouched for the dispatcher that owns it.
          const detail = 'task belongs to session ' + ownerSession + (selfSessionId === null ? '; this dispatcher has no session identity' : '; this dispatcher serves ' + selfSessionId)
          results.push({ id: task.id, skipped: 'other-session', message: detail })
          continue
        }
        if (taskAgents === null || taskAgents.available !== true) {
          results.push({ id: task.id, skipped: 'agent-runtime-unavailable', message: 'the root Agent subagent runtime is not available; the task stays pending' })
          continue
        }
        const outcome = await dispatchWithAgent(task, project, dispatch, reserved, workerConfig)
        results.push(outcome)
        if (outcome.ok === true) slots -= 1
      }
      return {
        ok: true,
        state: paused ? 'paused' : 'running',
        paused: paused === true,
        dispatched: results.filter((entry) => entry.ok === true).length,
        results: results,
      }
    } catch (error) {
      memory.lastError = String((error && error.message) || error)
      return { ok: false, code: 'tick-failed', message: memory.lastError }
    } finally {
      memory.sweeping = false
      memory.lastTickAt = state.clock()
      memory.ticks += 1
      memory.lastResults = results
      if (memory.rerun !== null) {
        const project = memory.rerun
        memory.rerun = null
        scheduleRerun(project)
      }
    }
  }

  /** Wait for any pass already in flight, then run one. The API uses this so
   * "start" and "tick" answer after the work they asked for has been attempted. */
  async function settle(projectPath) {
    const deadline = Date.now() + 10000
    while (memory.sweeping && Date.now() < deadline) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 10)
      })
    }
    return tick(projectPath)
  }

  function dispose() {
    if (memory.timer !== null) {
      clearTimeout(memory.timer)
      memory.timer = null
    }
    void leaseGate.releaseAll()
  }

  return {
    kick: kick,
    tick: tick,
    settle: settle,
    status: status,
    dispose: dispose,
    memory: memory,
    boot: boot,
    // T-197: the stage engine's seams. The API attaches its decision store here
    // and applies the answers through these methods; nothing else reaches in.
    attachStageHost: attachStageHost,
    applyStageContinue: applyStageContinue,
    resetStageBudget: resetStageBudget,
    retryDevelopment: retryDevelopment,
    notifyStageEvent: notifyStageEvent,
    requestStageRecoveryAsk: requestStageRecoveryAsk,
  }
}
/** What the execution edge looks like right now. Read-only. */
export function probeDispatch(ctx) {
  let subagents = undefined
  try {
    subagents = ctx.get('subagents')
  } catch (error) {
    subagents = undefined
  }
  const report = { available: subagents !== undefined && subagents !== null, subagentProviders: [], error: null }
  if (report.available !== true) {
    report.error = 'no-subagent-service'
    return report
  }
  try {
    const names = typeof subagents.list === 'function' ? subagents.list() : []
    report.subagentProviders = Array.isArray(names) ? names.map((name) => String(name)) : []
  } catch (error) {
    report.error = String((error && error.message) || error)
  }
  return report
}
