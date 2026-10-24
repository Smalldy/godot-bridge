/**
 * Dispatch — turning the ready list into work, and keeping the pool alive.
 *
 * Two independent things live here:
 *
 *   1. The target edge. A task is handed to an Agent Teams teammate through
 *      spawnTeammate (no idle member) or sendMessage (idle member). Both are
 *      optional services: a profile without them leaves tasks pending and says
 *      so, instead of failing the plugin.
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
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { boardPath, projectIdOf, readRoleConfig } from './board.mjs'
import { writePolicyFor } from './state.mjs'
import {
  ROLE_KINDS,
  ROLE_PROVISION_TIMEOUT_MS,
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
  defaultRoleConfig,
  normaliseVerify,
  profileForKind,
  renderRoleTemplate,
  roleTemplateVariables,
} from './schema.mjs'
import * as model from './service.mjs'
import * as locks from './locks.mjs'
import { DEFAULT_WORKTREE_TIMEOUT_MS, createGit } from './git.mjs'

export const DEFAULT_MAX_WORK_AGENTS = 4
export const DEFAULT_MAX_ATTEMPTS = 3
export const SEND_TIMEOUT_MS = 60 * 1000

/** The one teammate that merges merge requests. It is a FIXED ROLE, not a
 * switch: the Lead spawns a member with exactly this name, the scheduler never
 * hands it feature work, and the API accepts merge actions only from it (or the
 * user). A Team without one keeps merge requests open for the user to merge. */
export const MERGER_NAME = 'merger'

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

/** Review policy: a review that sits undecided for this long is reminded once,
 * then blocked on the next sweep so a silent reviewer cannot strand a task. */
export const REVIEW_TIMEOUT_MS = 10 * 60 * 1000

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

/** A short, teammate-name-safe handle for one project: the first 10 hex chars
 * of sha1(projectIdOf(root)). A teammate name allows only [a-z0-9-], so a root
 * (which holds ':' and '/') cannot appear verbatim; the digest is the stable,
 * case-folded key used in slot names, the executor ledger and history. */
export function projectSlotKey(root) {
  const id = typeof root === 'string' && root !== '' ? projectIdOf(canonicalRoot(root)) : ''
  return createHash('sha1').update(id).digest('hex').slice(0, 10)
}

/** One absolute root, symlinks resolved when the path exists. projectIdOf then
 * case-folds and normalizes separators, so the same project written in different
 * ways (trailing slash, drive-letter case, a symlinked path) hashes identically. */
function canonicalRoot(root) {
  const text = String(root)
  try {
    return realpathSync.native(text)
  } catch (error) {
    return text
  }
}

/** Role slot names are fixed per kind, project and index. With a known project
 * the name is `reviewer-p<key>-1` (the slot KEY is `reviewer@<key>-1`, see
 * roleSlotKey); without one the legacy `reviewer-1` is kept verbatim, which is
 * also what a profile without a project still spawns. */
export function roleSlotName(kind, index, projectRoot) {
  const key = typeof projectRoot === 'string' && projectRoot !== '' ? projectSlotKey(projectRoot) : null
  return String(kind) + (key === null ? '' : '-p' + key) + '-' + String(index)
}

/** Parse a slot name into { kind, project (key|null), index }, or null. Feature
 * workers are work-<task>-<n>, so they never match. */
export function roleSlotOf(name) {
  if (typeof name !== 'string') return null
  const match = /^(worker|reviewer|tester)(?:-p([0-9a-f]{6,}))?-(\d+)$/.exec(name)
  if (match === null) return null
  return { kind: match[1], project: match[2] === undefined ? null : match[2], index: Number(match[3]) }
}

/** The role kind of a teammate name, or null. */
export function roleKindOf(name) {
  const slot = roleSlotOf(name)
  return slot === null ? null : slot.kind
}

/** The internal slot key: `reviewer@<projectKey>-1` when the slot carries a
 * project, the bare `reviewer-1` for a legacy slot. This is the identifier the
 * panel/ledger use; the teammate NAME is roleSlotName (name-safe form). */
export function roleSlotKey(name) {
  const slot = roleSlotOf(name)
  if (slot === null) return null
  return slot.kind + (slot.project === null ? '' : '@' + slot.project) + '-' + String(slot.index)
}

/** The short, model-facing name the panel shows: reviewer-p<key>-1 -> reviewer-1. */
export function roleShortName(name) {
  const slot = roleSlotOf(name)
  return slot === null ? (typeof name === 'string' ? name : '') : slot.kind + '-' + String(slot.index)
}

export function isRoleName(name) {
  return roleKindOf(name) !== null
}

// ── which project a teammate works for ─────────────────────────────────────
// The roster carries no session workspace, and a teammate spawned while one row
// drove project A keeps A's workspace even when the row now drives B. So the
// host records the project it dispatched a member FOR (role spawn or worker
// brief) and checks that record before reusing the member or accepting its
// submit. A member with no record (a restart, a hand-spawned teammate) is not
// refused: liveness and the project-scoped slot name still keep projects apart.
const MEMBER_PROJECTS = new WeakMap()

function memberProjectsFor(ctx) {
  let map = MEMBER_PROJECTS.get(ctx)
  if (map === undefined) {
    map = new Map()
    MEMBER_PROJECTS.set(ctx, map)
  }
  return map
}

/** Record that `name` was dispatched for `root` (absolute project root). */
export function rememberMemberProject(ctx, name, root) {
  if (ctx === null || ctx === undefined || typeof name !== 'string' || name === '' || typeof root !== 'string' || root === '') return null
  const entry = { key: projectSlotKey(root), root: root }
  memberProjectsFor(ctx).set(name, entry)
  return entry
}

/** The project a member was last dispatched for: { key, root } or null. */
export function memberProjectOf(ctx, name) {
  if (ctx === null || ctx === undefined || typeof name !== 'string') return null
  const entry = memberProjectsFor(ctx).get(name)
  return entry === undefined ? null : entry
}

/** A process-stable boot id. globalThis survives a plugin reload in the same
 * process, so a reload does not mistake live workers for dead ones; a real host
 * restart changes it, and the scheduler requeues their tasks. */
const BOOT_KEY = Symbol.for('godot-bridge.task-center.boot')
export function bootId() {
  if (globalThis[BOOT_KEY] === undefined) globalThis[BOOT_KEY] = randomUUID()
  return globalThis[BOOT_KEY]
}

export function servicesFor(ctx) {
  const get = (key) => {
    try {
      return ctx.get(key)
    } catch (error) {
      return undefined
    }
  }
  return { agents: get('agents'), agentTeams: get('agentTeams') }
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

function membershipOrNull(agentTeams, agent) {
  try {
    const membership = agentTeams.tryMembership(agent)
    return membership !== undefined && membership !== null ? membership : null
  } catch (error) {
    return null
  }
}

/**
 * The Lead of the team this profile belongs to.
 *
 * With `sessionId` this is SESSION-SCOPED and never guesses: only an agent whose
 * own id is that session may answer (it IS the lead), otherwise its membership is
 * followed to the team's lead. A session with no Team root returns null — the
 * caller records `no-lead-for-project` — and it NEVER falls back to "the first
 * lead in the list", which is how every card used to land in one session.
 *
 * Without `sessionId` (a legacy profile with no session identity) the historical
 * behaviour is kept: the first live lead.
 */
export function resolveLead(ctx, options) {
  const opts = options === undefined || options === null ? {} : options
  const { agents, agentTeams } = servicesFor(ctx)
  if (agents === undefined || agents === null || agentTeams === undefined || agentTeams === null) return null
  let all = []
  try {
    const listed = agents.list()
    all = Array.isArray(listed) ? listed : []
  } catch (error) {
    return null
  }
  const sessionId = typeof opts.sessionId === 'string' && opts.sessionId !== '' ? opts.sessionId : null
  if (sessionId === null) {
    for (const candidate of all) {
      const membership = membershipOrNull(agentTeams, candidate)
      if (membership !== null && membership.role === 'lead') return candidate
    }
    return null
  }
  // Only the agents that BELONG to this session are candidates.
  const owned = all.filter((candidate) => agentSessionOf(candidate) === sessionId)
  for (const agent of owned) {
    const membership = membershipOrNull(agentTeams, agent)
    if (membership !== null && membership.role === 'lead') return agent
  }
  for (const agent of owned) {
    const membership = membershipOrNull(agentTeams, agent)
    if (membership === null) continue
    // The membership may name the lead directly (object, or its id/name).
    const direct =
      membership.lead !== undefined && membership.lead !== null
        ? membership.lead
        : membership.leadName !== undefined && membership.leadName !== null
          ? membership.leadName
          : membership.leadId !== undefined && membership.leadId !== null
            ? membership.leadId
            : null
    if (direct !== null) {
      const directId = typeof direct === 'string' ? direct : typeof direct.id === 'string' ? direct.id : null
      const directName = typeof direct === 'object' && direct !== null && typeof direct.name === 'string' ? direct.name : typeof direct === 'string' ? direct : null
      const found = all.filter((candidate) => (directId !== null && agentSessionOf(candidate) === directId) || (directName !== null && candidate.name === directName))[0]
      if (found !== undefined) {
        const foundMembership = membershipOrNull(agentTeams, found)
        if (foundMembership !== null && foundMembership.role === 'lead') return found
      }
    }
    // Otherwise walk the team's members: the one with role 'lead' IS the lead.
    const team = membership.team !== undefined && membership.team !== null ? membership.team : membership.teamId !== undefined && membership.teamId !== null ? membership.teamId : null
    if (team !== null) {
      let members = []
      try {
        const listed = agentTeams.listMembers(team)
        members = Array.isArray(listed) ? listed : []
      } catch (error) {
        members = []
      }
      const leadMember = members.filter((member) => member !== null && typeof member === 'object' && member.role === 'lead')[0]
      if (leadMember !== undefined) {
        const byId = all.filter((candidate) => agentSessionOf(candidate) === agentSessionOf(leadMember))[0]
        return byId !== undefined ? byId : leadMember
      }
    }
  }
  // A host with exactly ONE lead has a single team: there is no other session's
  // team to steal, so the legacy single-team profile keeps working. With two or
  // more leads this is exactly the "first lead in the list" bug and is refused.
  const everyLead = all.filter((candidate) => {
    const membership = membershipOrNull(agentTeams, candidate)
    return membership !== null && membership.role === 'lead'
  })
  if (everyLead.length === 1) return everyLead[0]
  return null
}

/** Every live Lead in this profile. Dispatch uses the COUNT to decide whether an
 * ownerless (pre-T-97) card may fall back to the single team. */
export function liveLeads(ctx) {
  const { agents, agentTeams } = servicesFor(ctx)
  if (agents === undefined || agents === null || agentTeams === undefined || agentTeams === null) return []
  let all = []
  try {
    all = agents.list()
  } catch (error) {
    return []
  }
  const leads = []
  for (const candidate of all) {
    try {
      const membership = agentTeams.tryMembership(candidate)
      if (membership !== undefined && membership !== null && membership.role === 'lead') leads.push(candidate)
    } catch (error) {}
  }
  return leads
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

/**
 * Pick the teammate to hand a task to.
 *
 * Only 'inactive' is idle. A provisioning teammate is still starting and a
 * failed one is gone; treating either as idle is how several tasks land in one
 * mailbox. The caller reserves the chosen name for the rest of the pass, so one
 * worker gets at most one task per tick even though the roster does not update
 * synchronously after sendMessage.
 *
 * The dedicated MERGER_NAME teammate is never a feature worker: it is reserved
 * for merge requests, so it is excluded from idle, from the spawn cap and from
 * the roster this function chooses from.
 */
export function pickTarget(ctx, options) {
  const opts = options === undefined ? {} : options
  const { agents, agentTeams } = servicesFor(ctx)
  if (agents === undefined || agents === null || agentTeams === undefined || agentTeams === null) {
    return { ok: false, code: 'no-team-service', message: 'the agent-team services are not present in this profile' }
  }
  const sessionId = typeof opts.sessionId === 'string' && opts.sessionId !== '' ? opts.sessionId : null
  const lead = resolveLead(ctx, { sessionId: sessionId })
  if (lead === null) {
    return {
      ok: false,
      code: sessionId === null ? 'no-lead' : 'no-lead-for-project',
      message:
        sessionId === null
          ? 'no live Team root, so there is nobody to hand pooled work to; tasks stay pending'
          : 'session ' + sessionId + ' has no live Team root, so this card cannot be dispatched to another session’s team',
    }
  }
  let members = []
  try {
    members = agentTeams.listMembers(lead)
  } catch (error) {
    return { ok: false, code: 'roster-unreadable', message: String((error && error.message) || error) }
  }
  const reserved = opts.reserved instanceof Set ? opts.reserved : new Set()
  const teammates = members.filter(
    (member) => member.role === 'teammate' && member.status !== 'failed' && member.name !== MERGER_NAME && !isRoleName(member.name),
  )
  const projectKey = typeof opts.projectKey === 'string' && opts.projectKey.length > 0 ? opts.projectKey : null
  const idle = teammates.filter((member) => {
    if (member.status !== 'inactive' || reserved.has(member.name)) return false
    if (projectKey === null) return true
    const remembered = memberProjectOf(ctx, member.name)
    // A member created for another project is NOT idle for this one.
    return remembered === null || remembered.key === projectKey
  })
  if (idle.length > 0) {
    return { ok: true, lead: lead, spawn: false, target: { name: idle[0].name, id: idle[0].id, status: idle[0].status }, members: members }
  }
  if (opts.spawn !== true) {
    return {
      ok: false,
      code: teammates.length === 0 ? 'no-teammates' : 'no-idle-member',
      message:
        teammates.length === 0
          ? 'the team has no WorkAgent yet, and spawning is disabled for this dispatch'
          : 'every WorkAgent is busy; the next pass waits for one to go idle',
      members: members,
    }
  }
  const cap = typeof opts.maxWorkAgents === 'number' ? opts.maxWorkAgents : DEFAULT_MAX_WORK_AGENTS
  if (teammates.length >= cap) {
    return {
      ok: false,
      code: 'workagent-budget',
      message: 'already ' + String(teammates.length) + ' WorkAgents, at the cap of ' + String(cap) + '; not spawning another',
      members: members,
    }
  }
  if (typeof opts.name !== 'string' || opts.name.length === 0) {
    return { ok: false, code: 'no-name', message: 'a spawned WorkAgent needs a name before the board can record the dispatch' }
  }
  return {
    ok: true,
    lead: lead,
    spawn: true,
    target: { name: opts.name, id: null, status: 'provisioning' },
    members: members,
  }
}

/**
 * What the worker pool looks like right now, for the panel's executor view.
 *
 * Read-only: it never claims, spawns or messages anyone. It answers "who could
 * take work, who is busy with which task, and how many more may be spawned",
 * so the board can show the pool the scheduler is choosing from. A profile
 * without the agent-team services still gets a report instead of an error.
 *
 * @param ctx - the row context; 'agents' and 'agentTeams' are optional services.
 * @param board - the current board (cap and current tasks).
 * @returns { lead, members, busy, idle, provisioning, failed, cap, error } where
 *   members holds only teammates, each with the running task it owns, and lead
 *   is the lead's name (or its id when the roster gives no name).
 */
export function workerPool(ctx, board, options) {
  const opts = options === undefined || options === null ? {} : options
  const current = board === undefined || board === null ? {} : board
  const dispatch = current.dispatch === undefined || current.dispatch === null ? {} : current.dispatch
  const report = {
    lead: null,
    leadInfo: null,
    members: [],
    busy: 0,
    idle: 0,
    provisioning: 0,
    failed: 0,
    cap: Number.isFinite(dispatch.maxWorkAgents) ? dispatch.maxWorkAgents : DEFAULT_MAX_WORK_AGENTS,
    error: null,
    // Counts per agent kind; 'lead' is reported separately from the members so
    // System work is never dressed up as an agent.
    kinds: { lead: 0, worker: 0, reviewer: 0, tester: 0, merger: 0 },
    // The role manager's desired instances (from the project role config).
    roles: null,
  }
  const { agents, agentTeams } = servicesFor(ctx)
  if (agents === undefined || agents === null || agentTeams === undefined || agentTeams === null) {
    report.error = 'no-team-service'
    return report
  }
  const lead = resolveLead(ctx)
  if (lead === null) {
    report.error = 'no-lead'
    return report
  }
  report.lead = lead.name === undefined || lead.name === null ? String(lead.id) : String(lead.name)
  report.leadInfo = {
    id: String(lead.id),
    name: report.lead,
    kind: 'lead',
    description: 'Team lead',
    session: lead.id === undefined || lead.id === null ? null : String(lead.id),
    status: String(lead.status === undefined || lead.status === null ? 'running' : lead.status),
    currentTask: null,
  }
  report.kinds.lead = 1
  report.session = sessionIdOfContext(ctx)
  let roster = []
  try {
    roster = agentTeams.listMembers(lead)
  } catch (error) {
    report.error = 'roster-unreadable'
    return report
  }
  const roleConfig = opts.roleConfig === undefined || opts.roleConfig === null ? null : opts.roleConfig
  if (roleConfig !== null && typeof roleConfig === 'object' && roleConfig.profiles !== null && typeof roleConfig.profiles === 'object') {
    const desired = { worker: 0, reviewer: 0, tester: 0 }
    const live = { worker: 0, reviewer: 0, tester: 0 }
    const bound = { worker: null, reviewer: null, tester: null }
    for (const kind of ['worker', 'reviewer', 'tester']) {
      const profile = profileForKind(roleConfig, kind)
      desired[kind] = profile !== null && profile !== undefined && Number.isFinite(profile.instances) ? Math.floor(profile.instances) : 0
      bound[kind] = profile !== null && profile !== undefined && typeof profile.name === 'string' ? profile.name : null
    }
    report.roles = {
      desired: desired,
      live: live,
      missing: { worker: 0, reviewer: 0, tester: 0 },
      bound: bound,
      profiles: roleConfig.profiles,
      stages: roleConfig.stages === undefined ? null : roleConfig.stages,
    }
  }
  const descriptions = {
    worker: 'feature worker',
    reviewer: 'review role',
    tester: 'test role',
    merger: 'merge queue operator',
    lead: 'Team lead',
  }
  const tasks = Array.isArray(current.tasks) ? current.tasks : []
  for (const member of roster) {
    if (member === null || typeof member !== 'object' || member.role !== 'teammate') continue
    const status = String(member.status === undefined || member.status === null ? 'unknown' : member.status)
    const kind = roleKindOf(member.name) === null ? (member.name === MERGER_NAME ? 'merger' : 'worker') : roleKindOf(member.name)
    const owned = tasks.filter((task) => {
      if (task.status !== 'running' || task.assignee === null || task.assignee === undefined) return false
      const sessionMatch =
        member.id !== undefined &&
        member.id !== null &&
        task.assignee.session !== undefined &&
        task.assignee.session !== null &&
        String(task.assignee.session) === String(member.id)
      const nameMatch = member.name !== undefined && member.name !== null && task.assignee.name === member.name
      return sessionMatch || nameMatch
    })[0]
    const name = member.name === undefined || member.name === null ? null : String(member.name)
    const remembered = name === null ? null : memberProjectOf(ctx, name)
    report.members.push({
      id: String(member.id),
      name: name,
      kind: kind,
      // T-97: which project (and therefore which session's team) this executor
      // was dispatched for, so the panel can show cross-project borrowing.
      project: remembered === null ? null : remembered.key,
      projectRoot: remembered === null ? null : remembered.root,
      description: typeof member.description === 'string' && member.description !== '' ? member.description : descriptions[kind],
      session: member.id === undefined || member.id === null ? (member.session === undefined ? null : String(member.session)) : String(member.id),
      status: status,
      currentTask: owned === undefined ? null : { id: owned.id, title: owned.title },
    })
    report.kinds[kind] = (report.kinds[kind] === undefined ? 0 : report.kinds[kind]) + 1
    if (report.roles !== null && report.roles.live[kind] !== undefined) report.roles.live[kind] += 1
    if (status === 'running') report.busy += 1
    else if (status === 'inactive') report.idle += 1
    else if (status === 'provisioning') report.provisioning += 1
    else if (status === 'failed') report.failed += 1
  }
  if (report.roles !== null) {
    for (const kind of ['worker', 'reviewer', 'tester']) {
      report.roles.missing[kind] = Math.max(0, report.roles.desired[kind] - report.roles.live[kind])
    }
  }
  return report
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
 * preparation: a git facade, a repository, and a clean working tree. It never
 * throws and answers `{ ok: true }` or `{ ok: false, code, message }`.
 */
export async function probeWorktree(git, projectPath) {
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
async function prepareWorktree(git, projectPath, task, dispatch, attempt, deadlineMs) {
  const probe = await probeWorktree(git, projectPath)
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
  const settings = dispatch === undefined || dispatch === null ? null : dispatch.worktree
  const root = String(settings === null || settings === undefined || settings.root === undefined || settings.root === null ? '' : settings.root).trim()
  // The checkout directory carries the attempt number: a failed attempt keeps
  // its worktree for inspection, so a retry must not try to re-add the same
  // path. The branch already carries the attempt, so the two stay in step.
  const checkoutRoot = root === '' ? '.worktrees' : root
    const path = /^([a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(checkoutRoot) ? join(checkoutRoot, String(task.id) + '-' + String(attempt)) : join(projectPath, checkoutRoot, String(task.id) + '-' + String(attempt))
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
  if (git === undefined || git === null || typeof path !== 'string' || path === '') return
  if (typeof git.worktreeRemove !== 'function') return
  try {
    await git.worktreeRemove(projectPath, path, { force: true })
  } catch (error) {}
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
  const branch = String(options.branch)
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
  if (typeof git.deleteBranch === 'function') {
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

/** A worker name derived from the task and its attempt; names are immutable in
 * the roster, so a retry after a dead worker needs a new one. */
export function workAgentName(taskId, attempt) {
  const slug = String(taskId).toLowerCase().replace(/[^a-z0-9]+/g, '')
  return 'work-' + (slug === '' ? 'task' : slug) + '-' + String(attempt)
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
 * The skills injection, shared by the role brief and the per-task worker brief so
 * a profile's skill list is worded identically on both paths.
 */
function roleSkillsSection(profile) {
  const lines = ['Skills:', '- task_center is your only interface to the board.']
  const listed = profile !== null && profile !== undefined && Array.isArray(profile.skills) ? profile.skills : []
  if (listed.length > 0) lines.push('- Load these project skills with the skill tool before acting: ' + listed.join(', '))
  else lines.push('- Load any project-specific skills with the skill tool before acting.')
  return lines.join('\n')
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
  if (config !== null) parts.push({ key: 'skills', group: 'skills', text: roleSkillsSection(profile) })
  return parts
}

/** What the assignee is told. It has to stand alone: the agent wakes with no
 * context beyond this message. roleConfig is optional and backward compatible:
 * omitting it returns exactly the pre-role-prompt brief. */
export function briefFor(task, projectPath, leadName, roleConfig) {
  return briefPartsFor(task, projectPath, leadName, roleConfig).map((part) => part.text).join('\n\n')
}

/**
 * The values a role prompt template's {{VARIABLES}} resolve to for one task. The
 * brief substitutes them; the panel's template block keeps the literal {{NAME}}
 * so the injection points stay visible. A value the task does not carry resolves
 * to an empty string instead of a token the host cannot fill.
 */
export function roleTemplateValuesFor(kind, task, config, options) {
  const opts = options === undefined || options === null ? {} : options
  const profile = config !== null && config !== undefined ? profileForKind(config, kind) : null
  const stage = profile !== null && profile !== undefined && typeof profile.stage === 'string' ? profile.stage : ROLE_STAGE[kind] === undefined ? 'implement' : ROLE_STAGE[kind]
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
  const profile = config !== null && config !== undefined ? profileForKind(config, kind) : null
  const stage = profile !== null && profile !== undefined && typeof profile.stage === 'string' ? profile.stage : ROLE_STAGE[kind] === undefined ? 'implement' : ROLE_STAGE[kind]
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
  if (task !== null && task !== undefined) {
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
  if (kind === 'worker') {
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
      'Verdict schema:',
      '  task_center { action: "approveReview", id: "<task>" }',
      '  task_center { action: "requestChanges", id: "<task>", reasons: "concrete, actionable reasons (files/lines)" }',
    )
  } else if (kind === 'tester') {
    fixed.push(
      'Permission boundary (hard):',
      '- READ-ONLY on implementation: do NOT edit files, do NOT commit, do NOT merge or push, do NOT change the task branch.',
      '- The only task actions you may call are passTest and failTest.',
      '- A worker can never test its own task; you are the independent tester.',
      '',
      'Verdict schema:',
      '  task_center { action: "passTest", id: "<task>", evidence: "commands/logs that passed" }',
      '  task_center { action: "failTest", id: "<task>", evidence: "the failing command and its tail output" }',
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
    skills: roleSkillsSection(profile),
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
  parts.push({ key: 'skills', group: 'skills', text: sections.skills })
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
  let profile = config !== null && config !== undefined ? profileForKind(config, kind) : null
  let scoped = config
  if (named !== null) {
    profile = named
    const stage = typeof profile.stage === 'string' ? profile.stage : ROLE_STAGE[kind] === undefined ? 'implement' : ROLE_STAGE[kind]
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
    { key: 'skills', type: 'fixed', title: 'Fixed skills injection (host)', text: sections.skills, editable: false },
  ]
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

export function reviewBriefFor(task, projectPath) {
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
    'Record the verdict with task_center:',
    '  { action: "approveReview", id: "' + task.id + '" }',
    '  { action: "requestChanges", id: "' + task.id + '", reasons: "concrete, actionable reasons (files/lines)" }',
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
  if (hostCheck !== null) {
    lines.push(
      '',
      'Host mechanical check (the host ALREADY ran this in the candidate — see task.test.hostCheck):',
      ...hostCheckSummaryLines(hostCheck),
      '',
      'What this means for your verdict:',
      '1) The host check is the BASELINE SUITE result, NOT your verdict. It proves only that the declared command exits 0 in this candidate.',
      '2) You MUST still design and run your own probes for what the suite does not encode: edge cases, actual behaviour, and conformance to the acceptance criteria. Your evidence must separate 【宿主基线】 (what the host ran and returned) from 【我的探针】 (what you ran, what came back, and why it proves the criterion).',
      '3) Re-running the same command is allowed when you suspect flakiness or an environment difference (say why), and you may run any other suite. The host run is a floor, not a ceiling.',
    )
  } else if (normaliseVerify(task.verify) !== null) {
    // A retest after the target moved rebuilds the candidate; the host has no
    // check for the new tree, so the tester runs the declared command this round.
    lines.push('', 'This task declares verify: "' + String(normaliseVerify(task.verify).command) + '" but the host has no check for this round (the candidate was rebuilt); run that command yourself before judging.')
  }
  lines.push(
    '',
    'Test plan / runbook:',
    '- Work ONLY inside the candidate worktree above. Do not edit implementation files, commit, merge or push.',
    '- Run the project test commands there from the candidate checkout and record the exact command and exit code.',
    '- Exercise the acceptance criteria directly; a green unit suite is not a substitute for the acceptance check.',
  )
  if (godot !== null && godot !== undefined && godot.project === true) {
    lines.push(
      '- This is a Godot project (' + String(godot.projectFile) + ').',
      '  Engine path: ' + String(godot.enginePath === undefined || godot.enginePath === null || godot.enginePath === '' ? 'the godot-bridge godotPath setting (Godot engine path card) or the godot command on PATH' : godot.enginePath) + '.',
      '  Headless smoke test from the candidate:',
      '    godot_run_headless({ project_path: "' + String(candidate.path) + '", quit_after: 120 })',
      '  Interactive smoke test from the candidate:',
      '    godot_run_project({ project_path: "' + String(candidate.path) + '" })',
      '  Never launch Godot through pwsh/bash (the file sandbox kills it). Stop with godot_stop_project and read godot_get_debug_output for logs.',
    )
  } else {
    lines.push(
      '- If this is a Godot project, launch the CANDIDATE with godot_run_headless / godot_run_project using project_path="' + String(candidate.path) + '"; never through pwsh/bash.',
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
    'Permission boundary (hard): the candidate is READ-ONLY implementation; you may only record the verdict:',
    '  task_center { action: "passTest", id: "' + task.id + '", evidence: "commands/logs that passed" }',
    '  task_center { action: "failTest", id: "' + task.id + '", evidence: "the failing command and its tail output" }',
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
 * The host-side role registry and provisioner.
 *
 * ensure(kind, { config, task, projectPath, now }) makes the configured number of
 * instances of a role exist in the live Team: it reuses live slots, forgets and
 * replaces failed/timed-out/drained ones, and spawns the missing fixed-named
 * slots through the Lead's spawnTeammate. No model decision is involved.
 *
 * All state is per manager (one per plugin row), so a plugin reload does not
 * mistake another process's fake/failed roster for its own bookkeeping.
 */
export function createRoleManager(ctx, options) {
  const opts = options === undefined || options === null ? {} : options
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  const memory = { spawnedAt: new Map(), drained: new Set(), drainUntil: new Map(), pending: new Set(), last: null }
  // One ensure pass at a time: the API (submit/approveReview) and the scheduler
  // tick can ask for the same role concurrently, and interleaving them would
  // read the same roster twice and over-spawn.
  let chain = Promise.resolve()
  function serialise(work) {
    const run = chain.then(work, work)
    chain = run.then(function () {}, function () {})
    return run
  }

  function nextSlotName(kind, roster, projectPath) {
    const used = new Set(memory.pending)
    for (const member of roster) {
      if (member !== null && typeof member === 'object' && typeof member.name === 'string') used.add(member.name)
    }
    for (let index = 1; index <= 999; index += 1) {
      const name = roleSlotName(kind, index, projectPath)
      if (!used.has(name)) return name
    }
    return null
  }

  async function ensureNow(kind, request) {
    const req = request === undefined || request === null ? {} : request
    if (ROLE_KINDS.indexOf(kind) < 0) return { ok: false, code: 'invalid-role', message: 'unknown role kind ' + String(kind) }
    const config = req.config === undefined || req.config === null ? defaultRoleConfig() : req.config
    const profile = profileForKind(config, kind)
    const desired = profile !== null && profile !== undefined && Number.isFinite(profile.instances) ? Math.floor(profile.instances) : 1
    const { agents, agentTeams } = servicesFor(ctx)
    if (agents === undefined || agents === null || agentTeams === undefined || agentTeams === null) {
      return { ok: false, code: 'no-team-service', message: 'the agent-team services are not present in this profile' }
    }
    // T-106: provision under the Lead that owns THIS session/project — never the
    // first lead in the host, which is how executors ended up in another session.
    const sessionId = req.sessionId === undefined || req.sessionId === null || req.sessionId === '' ? null : String(req.sessionId)
    const lead = req.lead === undefined || req.lead === null ? resolveLead(ctx, { sessionId: sessionId }) : req.lead
    if (lead === null) {
      return {
        ok: false,
        code: sessionId === null ? 'no-lead' : 'no-lead-for-project',
        message:
          sessionId === null
            ? 'no live Team root, so the ' + String(kind) + ' role cannot be provisioned'
            : 'session ' + sessionId + ' has no live Team root, so the ' + String(kind) + ' role stays unprovisioned (no cross-session borrowing)',
      }
    }
    let roster = []
    try {
      roster = agentTeams.listMembers(lead)
    } catch (error) {
      return { ok: false, code: 'roster-unreadable', message: String((error && error.message) || error) }
    }
    if (!Array.isArray(roster)) roster = []
    const now = Number.isFinite(req.now) ? req.now : clock()
    // The project this ensure pass is provisioning for. A slot that belongs to a
    // DIFFERENT project is never reused (its session workspace is that project);
    // a legacy slot (no project in its name) is adopted by the first project that
    // uses it and refuses the next one, which is how a pre-upgrade roster stays
    // usable without letting a second project inherit it.
    const projectPath = typeof req.projectPath === 'string' && req.projectPath !== '' ? req.projectPath : null
    const projectKey = projectPath === null ? null : projectSlotKey(projectPath)
    const reused = []
    const replaced = []
    const waiting = []
    const refused = []
    for (const member of roster) {
      if (member === null || typeof member !== 'object' || member.role !== 'teammate') continue
      const slot = roleSlotOf(member.name)
      if (slot === null || slot.kind !== kind) continue
      const name = String(member.name)
      if (projectKey !== null) {
        if (slot.project === null) {
          const seen = memberProjectOf(ctx, name)
          if (seen !== null && seen.key !== projectKey) {
            refused.push({ name: name, kind: kind, project: seen.key, root: seen.root })
            continue
          }
          rememberMemberProject(ctx, name, projectPath)
        } else if (slot.project !== projectKey) {
          const seen = memberProjectOf(ctx, name)
          refused.push({ name: name, kind: kind, project: slot.project, root: seen === null ? null : seen.root })
          continue
        } else {
          rememberMemberProject(ctx, name, projectPath)
        }
      }
      const status = String(member.status === undefined || member.status === null ? 'unknown' : member.status)
      if (memory.drained.has(name)) {
        const until = memory.drainUntil.get(name)
        // Drain first, then spawn: a running instance with a deadline still in
        // the future is DEFERRED — it keeps its capacity, and no replacement is
        // spawned early (even by the scheduler tick).
        if (until !== undefined && status === 'running' && now < until.deadline) {
          waiting.push({ name: name, deadline: until.deadline })
          continue
        }
        memory.drainUntil.delete(name)
        replaced.push({ name: name, reason: until !== undefined && now >= until.deadline ? 'drain-timeout' : 'drained' })
        continue
      }
      if (status === 'failed') {
        replaced.push({ name: name, reason: 'failed' })
        continue
      }
      if (status === 'provisioning') {
        const spawnedAt = memory.spawnedAt.get(name)
        if (!Number.isFinite(spawnedAt)) {
          // First sighting (e.g. after a plugin reload): start the clock so a
          // permanently provisioning role is eventually replaced.
          memory.spawnedAt.set(name, now)
        } else if (now - spawnedAt > ROLE_PROVISION_TIMEOUT_MS) {
          replaced.push({ name: name, reason: 'timeout' })
          continue
        }
      }
      reused.push(name)
    }
    const missing = Math.max(0, desired - reused.length - waiting.length)
    const created = []
    if (missing > 0) {
      const leadName = lead.name === undefined || lead.name === null ? String(lead.id) : String(lead.name)
      for (let slot = 0; slot < missing; slot += 1) {
        const name = nextSlotName(kind, roster, projectPath)
        if (name === null) {
          return { ok: false, code: 'no-name', message: 'no free ' + String(kind) + ' role slot name', created: created, reused: reused, replaced: replaced }
        }
        memory.pending.add(name)
        let delivered = null
        let spawnError = null
        try {
          delivered = await agentTeams.spawnTeammate(lead, {
            name: name,
            description: 'task-center ' + String(kind) + ' role',
            prompt: [
              { type: 'text', text: spawnPreamble(name, leadName) },
              { type: 'text', text: roleBriefFor(kind, req.task === undefined ? null : req.task, config, { projectPath: req.projectPath, leadName: leadName }) },
            ],
            context: profile !== null && profile !== undefined && profile.context === 'fork' ? 'fork' : 'fresh',
            provider: subagentProviderFor(ctx),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          })
        } catch (error) {
          spawnError = String((error && error.message) || error)
        }
        memory.pending.delete(name)
        if (spawnError !== null || delivered === null || delivered === undefined || delivered.member === undefined || delivered.member === null) {
          return {
            ok: false,
            code: 'spawn-failed',
            message: 'could not provision ' + String(kind) + ' role ' + name + ': ' + (spawnError === null ? 'the team service returned no member' : spawnError),
            created: created,
            reused: reused,
            replaced: replaced,
          }
        }
        memory.spawnedAt.set(name, now)
        memory.drained.delete(name)
        if (projectPath !== null) rememberMemberProject(ctx, name, projectPath)
        created.push({ name: name, id: delivered.member.id === undefined ? null : String(delivered.member.id) })
        roster.push(Object.assign({}, delivered.member))
      }
    }
    const result = {
      ok: true,
      kind: kind,
      profile: profile,
      desired: desired,
      created: created,
      reused: reused,
      replaced: replaced,
      waiting: waiting,
      // Slots skipped because they belong to another project (never reused, never
      // drained: another project's role keeps working). Callers record a history
      // row so the refusal is visible on the card.
      refused: refused,
      ready: reused.length + created.length + waiting.length,
    }
    memory.last = result
    return result
  }

  /** Serialised entry point: every caller queues behind the previous ensure. */
  function ensure(kind, request) {
    return serialise(function () {
      return ensureNow(kind, request)
    })
  }

  /**
   * Mark one role instance for draining. With options.timeoutMs the instance is
   * DEFERRED while its in-flight turn runs (up to the deadline); without it the
   * next ensure replaces the instance immediately (legacy drain).
   */
  function drain(name, options) {
    const opts = options === undefined || options === null ? {} : options
    const text = typeof name === 'string' ? name : ''
    if (roleKindOf(text) === null) return { ok: false, code: 'invalid-role-name', message: 'not a role slot name: ' + text }
    memory.drained.add(text)
    if (Number.isFinite(opts.timeoutMs)) {
      const at = Number.isFinite(opts.now) ? opts.now : clock()
      memory.drainUntil.set(text, { drainedAt: at, deadline: at + Math.max(0, Math.floor(opts.timeoutMs)) })
    } else {
      memory.drainUntil.delete(text)
    }
    const until = memory.drainUntil.get(text)
    return { ok: true, drained: [text], deadline: until === undefined ? null : until.deadline }
  }

  /** Drain every current instance of one kind (replacement happens on ensure). */
  async function drainKind(kind, options) {
    const opts = options === undefined || options === null ? {} : options
    const { agentTeams } = servicesFor(ctx)
    if (agentTeams === undefined || agentTeams === null) return { ok: false, code: 'no-team-service', message: 'the agent-team services are not present in this profile' }
    const sessionId = opts.sessionId === undefined || opts.sessionId === null || opts.sessionId === '' ? null : String(opts.sessionId)
    const lead = resolveLead(ctx, { sessionId: sessionId })
    if (lead === null) return { ok: false, code: sessionId === null ? 'no-lead' : 'no-lead-for-project', message: sessionId === null ? 'no live Team root' : 'session ' + sessionId + ' has no live Team root' }
    let roster = []
    try {
      roster = agentTeams.listMembers(lead)
    } catch (error) {
      return { ok: false, code: 'roster-unreadable', message: String((error && error.message) || error) }
    }
    const names = roster
      .filter((member) => member !== null && typeof member === 'object' && roleKindOf(member.name) === kind)
      .map((member) => String(member.name))
    const deadlines = []
    for (const name of names) {
      const result = drain(name, opts)
      if (result.ok !== true) return result
      deadlines.push({ name: name, deadline: result.deadline })
    }
    return { ok: true, drained: names, deadlines: deadlines }
  }

  function status() {
    const pendingDrains = []
    for (const [name, until] of memory.drainUntil.entries()) {
      pendingDrains.push({ name: name, drainedAt: until.drainedAt, deadline: until.deadline })
    }
    return {
      spawned: Array.from(memory.spawnedAt.keys()),
      drained: Array.from(memory.drained),
      pending: pendingDrains,
      last: memory.last,
    }
  }

  return { ensure: ensure, drain: drain, drainKind: drainKind, status: status, memory: memory }
}

/** One implicit manager per context, so the named host helpers share state. */
const DEFAULT_ROLE_MANAGERS = new WeakMap()

function defaultRoleManager(ctx) {
  if (ctx === null || ctx === undefined || typeof ctx !== 'object') return null
  let manager = DEFAULT_ROLE_MANAGERS.get(ctx)
  if (manager === undefined) {
    manager = createRoleManager(ctx)
    DEFAULT_ROLE_MANAGERS.set(ctx, manager)
  }
  return manager
}

/**
 * Host entry point: ensure the configured instances of one role exist. The row
 * shares a manager (createRoleManager) so the dispatcher and the API serialise
 * together; this named helper is for host code that only has the ctx.
 */
export function ensureRole(ctx, kind, request) {
  const manager = defaultRoleManager(ctx)
  if (manager === null) return Promise.resolve({ ok: false, code: 'no-team-service', message: 'no context to provision roles from' })
  return manager.ensure(kind, request)
}

/** Host entry point: mark a role slot for replacement on the next ensure. */
export function drainRole(ctx, name) {
  const manager = defaultRoleManager(ctx)
  if (manager === null) return { ok: false, code: 'no-team-service', message: 'no context to drain roles from' }
  return manager.drain(name)
}

/** What the dispatch edge looks like right now. Read-only. */
export function probeDispatch(ctx) {
  const { agents, agentTeams } = servicesFor(ctx)
  const report = {
    hasAgents: agents !== undefined && agents !== null,
    hasAgentTeams: agentTeams !== undefined && agentTeams !== null,
    agentCount: null,
    lead: null,
    members: [],
    membersReadable: false,
  }
  if (report.hasAgents) {
    try {
      report.agentCount = agents.list().length
    } catch (error) {
      report.agentCount = 'error: ' + String((error && error.message) || error)
    }
  }
  const lead = resolveLead(ctx)
  if (lead === null) return report
  report.lead = String(lead.id)
  try {
    report.members = agentTeams.listMembers(lead).map((member) => ({
      id: String(member.id),
      name: member.name,
      role: member.role,
      status: member.status,
    }))
    report.membersReadable = true
  } catch (error) {
    report.members = ['error: ' + String((error && error.message) || error)]
  }
  return report
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
  const projectOf = typeof opts.projectPath === 'function' ? opts.projectPath : () => state.memory.projectHint
  const boot = bootId()
  // T-97: cards carry the session that owns them; this dispatcher only hands work
  // to its own session's team. Without an identity it refuses to borrow.
  const selfSessionId = typeof opts.sessionId === 'string' && opts.sessionId.length > 0 ? opts.sessionId : sessionIdOfContext(ctx)
  const spawnAllowed = opts.allowSpawn !== false
  // The host-side role provisioner. Null means this caller did not opt into
  // role provisioning (older tests / direct API users); dispatch still works.
  const roles = opts.roles === undefined ? null : opts.roles
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

  /** Role provisioning is a SYSTEM event, never an agent one. */
  function emitRole(result) {
    if (result === null || result === undefined) return
    const created = Array.isArray(result.created) ? result.created.map((entry) => entry.name) : []
    const replaced = Array.isArray(result.replaced) ? result.replaced.map((entry) => String(entry.name) + (entry.reason === undefined ? '' : ' (' + String(entry.reason) + ')')) : []
    if (created.length > 0) emit('role-provision', 'system', { detail: String(result.kind) + ' ' + created.join(', ') })
    if (replaced.length > 0) emit('role-replace', 'system', { detail: String(result.kind) + ' ' + replaced.join(', ') })
  }
  const memory = {
    sweeping: false,
    rerun: null,
    timer: null,
    lastTickAt: null,
    lastError: null,
    lastResults: [],
    ticks: 0,
    // One reminder per review round: key id@review.at -> when the reminder went out.
    reviewReminders: new Map(),
    // One reminder per test round: key id@test.at -> when the reminder went out.
    testReminders: new Map(),
    // One 'about to block' notice per phase round: key id@phase.at -> sent.
    reviewGrace: new Map(),
    testGrace: new Map(),
    // The last environment probe (is the main tree clean, when was it checked) and
    // the per-card streak of TRANSIENT failures, so a momentary dirty window skips
    // one card instead of pausing the project (T-108).
    environment: null,
    environmentDirty: new Map(),
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
  function environmentStatus() {
    const dirty = []
    memory.environmentDirty.forEach((entry, id) => {
      dirty.push({
        id: String(id),
        retries: entry.count,
        since: new Date(entry.firstAt).toISOString(),
        escalated: entry.escalated === true,
      })
    })
    const probe = memory.environment === null ? { clean: null, code: null, message: null, checkedAt: null } : memory.environment
    return Object.assign({}, probe, {
      retrying: dirty.filter((entry) => entry.escalated !== true),
      escalated: dirty.filter((entry) => entry.escalated === true).map((entry) => entry.id),
      // Every streak with its count, so the panel (and a test) can say "3rd retry"
      // instead of only "somewhere between fine and alarming".
      dirty: dirty,
    })
  }

  function status() {
    return {
      boot: boot,
      busy: memory.sweeping,
      lastTickAt: memory.lastTickAt,
      lastError: memory.lastError,
      lastResults: memory.lastResults,
      ticks: memory.ticks,
      environment: environmentStatus(),
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
   * run. It renews ONLY a holder the Team still lists and only while the attempt
   * is inside the extension cap, so a dead holder (or one past the cap) lapses
   * into the handover path on schedule instead of being kept alive forever. A
   * lease that already lapsed is never revived here.
   */
  async function applyHeartbeat(projectPath, board, now) {
    const plan = { windowMs: heartbeatMs, maxExtensionMs: TASK_LEASE_EXTENSION_MAX_MS, allow: holderIsAlive }
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
  function noteEnvironmentFailure(taskId, code, message, now) {
    const previous = memory.environmentDirty.get(taskId)
    const entry = previous === undefined ? { count: 0, firstAt: now, lastAt: now, code: null, message: null, escalated: false } : previous
    entry.count += 1
    entry.lastAt = now
    entry.code = String(code === undefined || code === null ? '' : code)
    entry.message = String(message === undefined || message === null ? '' : message)
    entry.escalated = entry.count >= ENVIRONMENT_RETRY_LIMIT || now - entry.firstAt >= ENVIRONMENT_RETRY_WINDOW_MS
    memory.environmentDirty.set(taskId, entry)
    return entry
  }

  /** The card made it through the window: forget its streak. */
  function clearEnvironmentFailure(taskId) {
    if (memory.environmentDirty.size > 0) memory.environmentDirty.delete(taskId)
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
      clean: probe.ok === true,
      code: probe.ok === true ? null : String(probe.code === undefined || probe.code === null ? 'git-unavailable' : probe.code),
      message: probe.ok === true ? null : String(probe.message === undefined || probe.message === null ? '' : probe.message),
      checkedAt: new Date(now).toISOString(),
    }
    if (probe.ok !== true) return { environment: memory.environment, board: null }
    // The window closed: every streak and every "waiting for the tree" marker is
    // obsolete, so a recovered project stops asking without a human reopen.
    memory.environmentDirty.clear()
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
        const next = model.setDispatch(board, { state: 'paused' }, state.clock(), 'scheduler')
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

  /**
   * Whether the member recorded for a task is still alive. known:false means
   * this host cannot tell (no Agent Teams edge) and counts as NOT alive, so a
   * lease still lapses instead of living forever. An existing member that is not
   * 'failed' counts as alive — including 'inactive', which is how a teammate
   * between turns looks.
   */
  function memberLiveness(identity) {
    const who = identity === null || identity === undefined ? {} : identity
    const session = typeof who.session === 'string' && who.session !== '' ? who.session : null
    const name = typeof who.name === 'string' && who.name !== '' ? who.name : null
    if (session === null && name === null) return { known: false, alive: false, status: null, name: null }
    const team = ctx.get('agentTeams')
    const lead = resolveLead(ctx)
    if (team === null || team === undefined || typeof team.listMembers !== 'function' || lead === null) {
      return { known: false, alive: false, status: null, name: name }
    }
    let members = []
    try {
      members = team.listMembers(lead)
    } catch (error) {
      return { known: false, alive: false, status: null, name: name }
    }
    if (!Array.isArray(members)) return { known: false, alive: false, status: null, name: name }
    const match = members.filter(
      (member) =>
        member !== null &&
        typeof member === 'object' &&
        ((session !== null && String(member.id) === session) || (name !== null && String(member.name) === name)),
    )[0]
    if (match === undefined) return { known: true, alive: false, status: 'gone', name: name }
    const status = match.status === undefined || match.status === null || match.status === '' ? 'unknown' : String(match.status)
    return { known: true, alive: status !== 'failed', status: status, name: typeof match.name === 'string' ? match.name : name }
  }

  /** The heartbeat gate: only a holder the Team still lists is renewed, so a dead
   * worker's lease lapses into the handover path instead of living forever. */
  function holderIsAlive(task) {
    if (task === null || task === undefined || task.assignee === null) return false
    return memberLiveness({ name: task.assignee.name, session: task.assignee.session }).alive === true
  }

  /**
   * Best-effort interrupt of a member that lost its task. The Agent Teams edge
   * may not expose one: a refusal is reported and recorded, never thrown, because
   * the handover itself must not depend on it (the dispatcher liveness guard is
   * the safety net).
   */
  async function interruptMember(task, identity) {
    const who = identity === null || identity === undefined ? {} : identity
    const name = typeof who.name === 'string' && who.name !== '' ? who.name : null
    if (name === null) return { ok: false, code: 'no-identity' }
    return interruptMemberNamed(ctx, {
      name: name,
      key: String(task === null || task === undefined ? '' : task.id) + '@lease-handover@' + name,
      message:
        'Task ' + String(task === null || task === undefined ? '' : task.id) + ' left your attempt (lease handover); stop working on it now and discard uncommitted changes.',
    })
  }

  /**
   * One task, one live executor (T-85). Before a new worker is handed a card, the
   * executors that card was handed to before are retired: interrupted through the
   * Team service while it still lists them as running, and always recorded in the
   * board's executor ledger plus one history row. A restart that re-dispatched a
   * card while the old worker's inbox still held the brief is exactly how three
   * executors ended up on one card; this is the guard that prevents it.
   *
   * Returns { board, retired, refused }. A non-empty `refused` means an executor
   * is still alive and could not be stopped: the caller must NOT dispatch, keeping
   * the one-live-executor invariant even then.
   */
  async function supersedeExecutors(projectPath, task, target) {
    // The recent ledger, not only the un-retired rows: a host restart records its
    // executor as retired (that attempt is over) while the worker process may
    // still be running with the brief in its inbox. Liveness decides what needs an
    // interrupt; an entry the roster no longer lists is bookkeeping only.
    const ledger = Array.isArray(task.executors) ? task.executors.slice(-4) : []
    const recent = ledger.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string' && entry.name !== target.name)
    const unretired = model.liveExecutors(task).filter((entry) => entry !== null && typeof entry.name === 'string' && entry.name !== target.name)
    const live = unretired.concat(recent.filter((entry) => unretired.every((done) => done.name !== entry.name)))
    if (live.length === 0) return { board: null, retired: [], refused: [] }
    const retired = []
    const refused = []
    for (const entry of live) {
      const liveness = memberLiveness({ name: entry.name, session: entry.session })
      if (liveness.alive !== true) {
        // Already gone: retiring the ledger row is bookkeeping, not an interrupt,
        // and an entry that is retired already needs no second row.
        if (entry.retiredAt === null || entry.retiredAt === undefined) retired.push(entry.name)
        continue
      }
      const stopped = await interruptMemberNamed(ctx, {
        name: entry.name,
        key: String(task.id) + '@supersede@' + entry.name,
        message:
          'Task ' + String(task.id) + ' (' + String(task.title) + ') is being handed to a new executor. Stop working on it now and discard uncommitted changes; do not submit.',
      })
      if (stopped.ok === true) {
        retired.push(entry.name)
        emit('executor-retired', 'host', { taskId: task.id, detail: 'interrupted ' + entry.name + ' before re-dispatching to ' + target.name })
        continue
      }
      if (stopped.code === 'not-running' || stopped.code === 'unknown-member' || stopped.code === 'already-interrupted') {
        // Nothing is actually running: an idle member has no turn to stop, an
        // unknown one is gone, and an already-interrupted one was stopped before.
        if (entry.retiredAt === null || entry.retiredAt === undefined) retired.push(entry.name)
        continue
      }
      if (stopped.code === 'no-interrupt-api' || stopped.code === 'no-team-service' || stopped.code === 'no-lead') {
        // The Team edge cannot stop a turn here. Record the retirement explicitly:
        // a silent second executor is the failure mode this guard exists to avoid.
        retired.push(entry.name)
        emit('executor-retired', 'system', {
          taskId: task.id,
          detail: 'no way to interrupt ' + entry.name + ' (' + String(stopped.code) + '); recorded it as retired before re-dispatching to ' + target.name,
        })
        continue
      }
      // Alive and the interrupt was refused: refuse the second executor instead.
      refused.push(entry.name)
      emit('error', 'system', {
        taskId: task.id,
        detail: 'could not retire ' + entry.name + ' (' + String(stopped.code) + '); refusing a second executor for ' + String(task.id),
      })
    }
    let board = null
    if (retired.length > 0) {
      const applied = await state.apply(
        projectPath,
        (value) => model.retireExecutors(value, task.id, retired, state.clock(), 'superseded by a re-dispatch to ' + target.name),
        writePolicyFor(projectPath),
      )
      if (applied.failed === null) board = applied.board
    }
    return { board: board, retired: retired, refused: refused }
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
    for (const task of lapsed) {
      const holder = task.assignee === null ? null : { name: task.assignee.name, session: task.assignee.session }
      const live = memberLiveness(holder)
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
          const interrupted = await interruptMember(entry, entry.holder)
          emit('lease-handover', 'host', {
            taskId: entry.id,
            detail:
              (entry.capped === true ? 'liveness cap reached' : 'assignee ' + String(entry.live.status)) +
              '; requeued for a fresh attempt (' +
              (interrupted.ok === true ? 'old agent interrupted via ' + String(interrupted.via) : 'interrupt ' + String(interrupted.code)) +
              ')',
          })
        }
      }
    }
    return current
  }

  /**
   * Keep a live instance of every role a current stage needs. This is what
   * replaces a reviewer/tester that died or timed out, without a Lead prompt.
   * Best effort: a provisioning failure never blocks the dispatch pass.
   */
  async function ensureStageRoles(projectPath, board, now) {
    if (roles === null || typeof roles.ensure !== 'function') return []
    const kinds = []
    for (const task of board.tasks) {
      if (task.status === 'reviewing' && kinds.indexOf('reviewer') < 0) kinds.push('reviewer')
      if (task.status === 'testing' && kinds.indexOf('tester') < 0) kinds.push('tester')
    }
    if (kinds.length === 0) return []
    let config = null
    try {
      const fs = ctx.fs
      if (fs !== undefined && fs !== null) config = (await readRoleConfig({ fs: fs }, { projectPath: projectPath })).config
    } catch (error) {
      config = null
    }
    const results = []
    for (const kind of kinds) {
      const task = board.tasks.filter((entry) => (kind === 'reviewer' ? entry.status === 'reviewing' : entry.status === 'testing'))[0]
      try {
        const ensured = await roles.ensure(kind, { config: config === null ? undefined : config, projectPath: projectPath, task: task, now: now })
        results.push(ensured)
        emitRole(ensured)
      } catch (error) {
        const failed = { ok: false, code: 'role-ensure-failed', message: String((error && error.message) || error) }
        results.push(failed)
        emit('error', 'system', { detail: 'role ' + String(kind) + ' ensure failed: ' + failed.message })
      }
    }
    return results
  }

  /** Send one plain message to a Team member; a refusal is not an error. */
  async function sendMemberMessage(lead, name, text) {
    const team = ctx.get('agentTeams')
    if (team === undefined || team === null || lead === null) return false
    try {
      const request = { target: name, content: [{ type: 'text', text: text }] }
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        request.signal = AbortSignal.timeout(SEND_TIMEOUT_MS)
      }
      await team.sendMessage(lead, request)
      return true
    } catch (error) {
      return false
    }
  }

  /** Live reviewer slot names (reviewer-1, reviewer-2, ...). */
  function reviewerNames() {
    const { agentTeams } = servicesFor(ctx)
    if (agentTeams === undefined || agentTeams === null) return []
    const lead = resolveLead(ctx)
    if (lead === null) return []
    let roster = []
    try {
      roster = agentTeams.listMembers(lead)
    } catch (error) {
      return []
    }
    if (!Array.isArray(roster)) return []
    let drained = []
    if (roles !== null && typeof roles.status === 'function') {
      try {
        const status = roles.status()
        drained = Array.isArray(status.drained) ? status.drained.map(String) : []
      } catch (error) {
        drained = []
      }
    }
    return roster
      .filter(
        (member) =>
          member !== null &&
          typeof member === 'object' &&
          roleKindOf(member.name) === 'reviewer' &&
          member.status !== 'failed' &&
          drained.indexOf(String(member.name)) < 0,
      )
      .map((member) => String(member.name))
  }


  /** Live tester slot names (tester-1, tester-2, ...). */
  /** Role slot names plus the member ids/sessions that belong to those slots. */
  function roleIdentities(names) {
    const out = names.slice()
    if (names.length === 0) return out
    const { agentTeams } = servicesFor(ctx)
    const lead = resolveLead(ctx)
    if (agentTeams === undefined || agentTeams === null || lead === null) return out
    try {
      const roster = agentTeams.listMembers(lead)
      if (!Array.isArray(roster)) return out
      for (const member of roster) {
        if (member === null || member === undefined || names.indexOf(String(member.name)) < 0) continue
        if (typeof member.id === 'string' && member.id !== '' && out.indexOf(member.id) < 0) out.push(member.id)
        const session = member.session !== undefined ? member.session : member.sessionId
        if (typeof session === 'string' && session !== '' && out.indexOf(session) < 0) out.push(session)
      }
    } catch (error) {}
    return out
  }

  function testerNames() {
    const { agentTeams } = servicesFor(ctx)
    if (agentTeams === undefined || agentTeams === null) return []
    const lead = resolveLead(ctx)
    if (lead === null) return []
    let roster = []
    try {
      roster = agentTeams.listMembers(lead)
    } catch (error) {
      return []
    }
    if (!Array.isArray(roster)) return []
    let drained = []
    if (roles !== null && typeof roles.status === 'function') {
      try {
        const status = roles.status()
        drained = Array.isArray(status.drained) ? status.drained.map(String) : []
      } catch (error) {
        drained = []
      }
    }
    return roster
      .filter(
        (member) =>
          member !== null &&
          typeof member === 'object' &&
          roleKindOf(member.name) === 'tester' &&
          member.status !== 'failed' &&
          drained.indexOf(String(member.name)) < 0,
      )
      .map((member) => String(member.name))
  }

  /**
   * The review timeout policy, driven by the host tick. Silence is measured from
   * the reviewer's last activity (review.at or a recorded task_center call):
   * REVIEW_TIMEOUT_MS of silence sends one reminder; two full timeouts of
   * silence send one 'about to block' notice; blocking happens only after the
   * PHASE_BLOCK_GRACE_MS grace window, so a slow-but-working reviewer is never
   * judged dead. Never blocks a dispatch pass.
   */
  async function sweepReviewTimeouts(projectPath, board, now) {
    const pending = board.tasks.filter(
      (task) =>
        task.status === 'reviewing' &&
        (task.waitingReason === null || task.waitingReason === undefined || task.waitingReason === '') &&
        task.review !== null &&
        task.review !== undefined &&
        task.review.status === 'pending' &&
        typeof task.review.at === 'string',
    )
    if (pending.length === 0) return { reminded: [], blocked: [], board: null }
    const pendingKeys = new Set(pending.map((task) => String(task.id) + '@' + String(task.review.at)))
    const lead = resolveLead(ctx)
    const names = reviewerNames()
    const reminded = []
    const blocked = []
    let nextBoard = null
    for (const task of pending) {
      const slot = stageSlotOf(ctx, task.id, 'reviewer')
      // A task waiting for its role slot has no delivery time yet: its silence
      // clock is paused so the watchdog cannot remind/block it out of turn.
      if (slot !== null && slot.position !== null) continue
      const startedAt = slot !== null && Number.isFinite(slot.at) ? slot.at : Date.parse(task.review.at)
      if (!Number.isFinite(startedAt)) continue
      const lastAt = Math.max(startedAt, phaseActivityAt(ctx, task.id, roleIdentities(names)))
      const silence = now - lastAt
      const key = String(task.id) + '@' + String(task.review.at)
      if (silence >= reviewTimeoutMs * 2 + phaseGraceMs) {
        const applied = await applyReap(projectPath, (value) => {
          const fresh = model.findTask(value, task.id)
          if (
            fresh === undefined ||
            fresh === null ||
            fresh.status !== 'reviewing' ||
            fresh.review === null ||
            fresh.review === undefined ||
            fresh.review.status !== 'pending' ||
            String(fresh.review.at) !== String(task.review.at)
          ) {
            return value
          }
          const freshSlot = stageSlotOf(ctx, fresh.id, 'reviewer')
          const freshStart = freshSlot !== null && Number.isFinite(freshSlot.at) ? freshSlot.at : Date.parse(fresh.review.at)
          const freshSilence = Math.round((now - Math.max(freshStart, phaseActivityAt(ctx, fresh.id, roleIdentities(names)))) / 60000)
          const result = model.blockTask(value, fresh.id, now, 'system', 'review timed out: no reviewer verdict after ' + String(freshSilence) + 'min of silence')
          return result.ok === true ? result.board : value
        })
        if (applied === null) continue
        nextBoard = applied
        memory.reviewReminders.delete(key)
        memory.reviewGrace.delete(key)
        blocked.push(task.id)
        emit('error', 'system', { taskId: task.id, detail: 'review timed out; task blocked for triage' })
        // The stalled reviewer is interrupted too: the task left reviewing, so
        // its turn must not keep running (interrupt lands at the next boundary).
        if (names.length > 0) {
          await interruptMemberNamed(ctx, {
            name: names[0],
            key: String(task.id) + '@blocked@' + names[0],
            message:
              'Task ' + String(task.id) + ' is blocked (review timed out with no verdict). Stop working on it now and discard uncommitted changes.',
          })
        }
        const owner = task.assignee === null || task.assignee === undefined ? null : task.assignee.name
        const notice =
          'Review for ' + String(task.id) + ' (' + String(task.title) + ') timed out with no verdict; the task is blocked for triage.\n' +
          '  project: ' + String(projectPath) + '\n' +
          '  branch: ' + String(task.branch === null || task.branch === undefined ? '' : task.branch) + '\n' +
          '  worktree: ' + String(task.worktree === null || task.worktree === undefined ? '' : task.worktree)
        if (typeof owner === 'string' && owner !== '') await sendMemberMessage(lead, owner, notice)
        if (lead !== null && typeof lead.name === 'string' && lead.name !== '') await sendMemberMessage(lead, lead.name, notice)
        continue
      }
      if (silence >= reviewTimeoutMs * 2) {
        if (memory.reviewGrace.has(key)) continue
        if (names.length === 0 || lead === null) continue
        const sent = await sendMemberMessage(lead, names[0], 'The review round is about to be blocked for inactivity. Record approveReview or requestChanges now; the task will be blocked after the grace window.\n\n' + reviewBriefFor(task, projectPath))
        if (sent === true) {
          memory.reviewGrace.set(key, now)
          emit('review-grace', 'system', { taskId: task.id, detail: 'review about to be blocked; grace window started' })
        }
        continue
      }
      if (silence >= reviewTimeoutMs && memory.reviewReminders.has(key) === false) {
        if (names.length === 0 || lead === null) continue
        const sent = await sendMemberMessage(lead, names[0], 'Reminder — review is still waiting.\n\n' + reviewBriefFor(task, projectPath))
        if (sent === true) {
          memory.reviewReminders.set(key, now)
          reminded.push(task.id)
          emit('review-reminder', 'system', { taskId: task.id, detail: 'review still pending; reminded ' + names[0] })
        }
      }
    }
    for (const key of Array.from(memory.reviewReminders.keys())) {
      if (!pendingKeys.has(key)) memory.reviewReminders.delete(key)
    }
    for (const key of Array.from(memory.reviewGrace.keys())) {
      if (!pendingKeys.has(key)) memory.reviewGrace.delete(key)
    }
    return { reminded: reminded, blocked: blocked, board: nextBoard }
  }
  /**
   * The TEST phase bounds, driven by the host tick. Silence is measured from
   * test.at or the tester's last recorded task_center call: testReminderMs of
   * silence sends one reminder, testTimeoutMs sends one 'about to block' notice,
   * and only testTimeoutMs + phaseGraceMs of silence blocks the task for triage.
   * A tester that keeps calling get/passTest is never judged dead, and a verdict
   * inside the grace window is still recorded.
   */
  async function sweepTestTimeouts(projectPath, board, now) {
    const pending = board.tasks.filter(
      (task) =>
        task.status === 'testing' &&
        (task.waitingReason === null || task.waitingReason === undefined || task.waitingReason === '') &&
        task.test !== null &&
        task.test !== undefined &&
        task.test.status === 'pending' &&
        typeof task.test.at === 'string',
    )
    if (pending.length === 0) return { reminded: [], blocked: [], board: null }
    const pendingKeys = new Set(pending.map((task) => String(task.id) + '@' + String(task.test.at)))
    const lead = resolveLead(ctx)
    const names = testerNames()
    const reminded = []
    const blocked = []
    let nextBoard = null
    for (const task of pending) {
      const slot = stageSlotOf(ctx, task.id, 'tester')
      if (slot !== null && slot.position !== null) continue
      const startedAt = slot !== null && Number.isFinite(slot.at) ? slot.at : Date.parse(task.test.at)
      if (!Number.isFinite(startedAt)) continue
      const lastAt = Math.max(startedAt, phaseActivityAt(ctx, task.id, roleIdentities(names)))
      const silence = now - lastAt
      const key = String(task.id) + '@' + String(task.test.at)
      const candidate =
        task.merge !== null && task.merge !== undefined && typeof task.merge.mergeCommit === 'string' && task.merge.mergeCommit !== ''
          ? 'candidate ' + String(task.merge.mergeCommit)
          : 'no candidate recorded'
      if (silence >= testTimeoutMs + phaseGraceMs) {
        const tester = names.length > 0 ? names[0] : 'the tester'
        let blockNote = null
        const applied = await applyReap(projectPath, (value) => {
          const fresh = model.findTask(value, task.id)
          if (
            fresh === undefined ||
            fresh === null ||
            fresh.status !== 'testing' ||
            fresh.test === null ||
            fresh.test === undefined ||
            fresh.test.status !== 'pending' ||
            String(fresh.test.at) !== String(task.test.at)
          ) {
            return value
          }
          const freshCandidate =
            fresh.merge !== null && fresh.merge !== undefined && typeof fresh.merge.mergeCommit === 'string' && fresh.merge.mergeCommit !== ''
              ? 'candidate ' + String(fresh.merge.mergeCommit)
              : 'no candidate recorded'
          const freshSlot = stageSlotOf(ctx, fresh.id, 'tester')
          const freshStart = freshSlot !== null && Number.isFinite(freshSlot.at) ? freshSlot.at : Date.parse(fresh.test.at)
          const freshMinutes = Math.round((now - Math.max(freshStart, phaseActivityAt(ctx, fresh.id, names))) / 60000)
          blockNote = 'test timeout: no verdict after ' + String(freshMinutes) + 'min of silence (' + tester + '; ' + freshCandidate + ')'
          const result = model.blockTask(value, fresh.id, now, 'system', blockNote + '; blocked for triage')
          return result.ok === true ? result.board : value
        })
        if (applied === null) continue
        const appliedTask = model.findTask(applied, task.id)
        if (appliedTask === undefined || appliedTask === null || appliedTask.status !== 'blocked') continue
        nextBoard = applied
        memory.testReminders.delete(key)
        memory.testGrace.delete(key)
        blocked.push(task.id)
        emit('error', 'system', { taskId: task.id, detail: (blockNote === null ? 'test timeout' : blockNote) + '; task blocked for triage' })
        // The stalled tester is interrupted for the same reason as the reviewer.
        const stalledTester = typeof tester === 'string' && tester !== '' ? tester : null
        if (stalledTester !== null) {
          await interruptMemberNamed(ctx, {
            name: stalledTester,
            key: String(task.id) + '@blocked@' + stalledTester,
            message:
              'Task ' + String(task.id) + ' is blocked (test timed out with no verdict). Stop working on it now and discard uncommitted changes.',
          })
        }
        const owner = task.assignee === null || task.assignee === undefined || typeof task.assignee.name !== 'string' ? null : task.assignee.name
        const notice =
          'Test for ' + String(task.id) + ' (' + String(task.title) + ') timed out with no verdict; the task is blocked for triage.\n' +
          '  project: ' + String(projectPath) + '\n' +
          '  ' + (blockNote === null ? 'tester: ' + String(tester) : blockNote)
        if (owner !== null && owner !== '') await sendMemberMessage(lead, owner, notice)
        if (lead !== null && typeof lead.name === 'string' && lead.name !== '') await sendMemberMessage(lead, lead.name, notice)
        continue
      }
      if (silence >= testTimeoutMs) {
        if (memory.testGrace.has(key)) continue
        if (names.length === 0 || lead === null) continue
        const tester = names[0]
        const sent = await sendMemberMessage(
          lead,
          tester,
          'The test round is about to be blocked for inactivity.\n' +
            '  task: ' + String(task.id) + ' ' + String(task.title) + '\n' +
            '  ' + candidate + '\n' +
            'Record passTest or failTest now; after the grace window the task is blocked for triage.',
        )
        if (sent === true) {
          memory.testGrace.set(key, now)
          emit('test-grace', 'system', { taskId: task.id, detail: 'test phase about to be blocked; grace window started' })
        }
        continue
      }
      if (silence >= testReminderMs && memory.testReminders.has(key) === false) {
        if (names.length === 0 || lead === null) continue
        const tester = names[0]
        const text =
          'Reminder — the test phase is still waiting for a verdict.\n' +
          '  task: ' + String(task.id) + ' ' + String(task.title) + '\n' +
          '  ' + candidate + '\n' +
          'Record passTest or failTest with task_center; do not leave the round pending.'
        const sent = await sendMemberMessage(lead, tester, text)
        if (sent === true) {
          memory.testReminders.set(key, now)
          reminded.push(task.id)
          emit('test-reminder', 'system', { taskId: task.id, detail: 'test phase still pending; reminded ' + tester })
        }
      }
    }
    for (const key of Array.from(memory.testReminders.keys())) {
      if (!pendingKeys.has(key)) memory.testReminders.delete(key)
    }
    for (const key of Array.from(memory.testGrace.keys())) {
      if (!pendingKeys.has(key)) memory.testGrace.delete(key)
    }
    return { reminded: reminded, blocked: blocked, board: nextBoard }
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
      // Roles are kept for tasks already in a review/test stage even while
      // dispatch is paused: a dead reviewer/tester must not strand a task.
      const roleResults = await ensureStageRoles(project, current, now)
      const reviewSweep = await sweepReviewTimeouts(project, current, now)
      if (reviewSweep.board !== null) current = reviewSweep.board
      for (const id of reviewSweep.reminded) results.push({ id: id, review: 'reminded' })
      for (const id of reviewSweep.blocked) results.push({ id: id, review: 'timed-out' })
      const testSweep = await sweepTestTimeouts(project, current, now)
      if (testSweep.board !== null) current = testSweep.board
      for (const id of testSweep.reminded) results.push({ id: id, test: 'reminded' })
      for (const id of testSweep.blocked) results.push({ id: id, test: 'timed-out' })
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
        // T-107: an ownerless (pre-T-97) card must not fall back to "the first
        // Lead" when this host runs several teams. It waits for a session to
        // adopt it; a single-team host keeps the historical compatibility path.
        let ownerCompat = false
        if (ownerSession === null && selfSessionId !== null) {
          const leads = liveLeads(ctx)
          if (leads.length > 1) {
            const detail =
              '这张卡没有所属会话（ownerSession 为空），本宿主有多个 Team；请在它所属的项目会话里 reopen 一次以认领，宿主不会回退到第一个 Lead'
            await markExecutorMissing(project, task.id, 'owner-unknown', detail)
            results.push({ id: task.id, skipped: 'owner-unknown', message: detail })
            continue
          }
          ownerCompat = true
        }
        // T-107: never dispatch a card whose project is not this session's
        // workspace: the worker could neither write nor run the declared gate.
        if (selfSessionId !== null) {
          let workspaceRoot = null
          try {
            const policy = ctx.sandboxPolicy
            const resolved = policy !== null && policy !== undefined && typeof policy.resolve === 'function' ? policy.resolve() : null
            workspaceRoot = resolved !== null && resolved !== undefined && typeof resolved.workspaceRoot === 'string' ? resolved.workspaceRoot : null
          } catch (error) {
            workspaceRoot = null
          }
          if (workspaceRoot !== null && projectIdOf(workspaceRoot) !== projectIdOf(project)) {
            const detail =
              '这张卡属于项目 ' + project + '，而当前会话的 workspace 是 ' + workspaceRoot + '；跨项目派发会让 worker 无法写入或跑验证，请在卡片所属项目的会话里派发'
            await markExecutorMissing(project, task.id, 'wrong-session', detail)
            results.push({ id: task.id, skipped: 'wrong-session', message: detail })
            continue
          }
        }
        if (task.dispatch !== null && task.dispatch.status === 'lease-expired' && task.dispatch.error !== TASK_LEASE_CAP_ERROR) {
          const previous = memberLiveness({ name: task.dispatch.target, session: task.dispatch.targetId })
          if (previous.alive === true) {
            results.push({ id: task.id, skipped: 'previous-assignee-active', previous: task.dispatch.target })
            continue
          }
        }
        if (task.writeFiles.length > 0) {
          const conflicts = locks.conflictsFor(state.memory.locks, task.writeFiles, 'task:' + task.id)
          if (conflicts.length > 0) {
            results.push({ id: task.id, skipped: 'files-busy', conflicts: conflicts })
            continue
          }
        }
        const projectKey = projectSlotKey(project)
        const picked = pickTarget(ctx, {
          reserved: reserved,
          spawn: dispatch.allowSpawn === true && spawnAllowed,
          maxWorkAgents: dispatch.maxWorkAgents,
          name: workAgentName(task.id, model.attemptSlot(task)),
          projectKey: projectKey,
          // The LEAD that creates the executor is the one this card BELONGS to.
          // An ownerless (legacy) card keeps the historical first-Lead behaviour.
          sessionId: ownerSession,
        })
        if (picked.ok !== true) {
          const reason =
            picked.code === 'no-lead' || picked.code === 'no-lead-for-project' || picked.code === 'no-team-service' || picked.code === 'roster-unreadable'
              ? 'no-lead-for-project'
              : picked.code === 'no-teammates'
                ? 'no-roster'
                : null
          if (reason !== null && ownerSession !== null) {
            // Only a session-owned card records this reason; legacy/ownerless
            // cards keep the historical "stays pending, no waiting reason".
            await markExecutorMissing(project, task.id, reason, picked.message)
            results.push({ id: task.id, skipped: reason, message: picked.message })
            break
          }
          results.push({ id: task.id, skipped: picked.code, message: picked.message })
          break
        }
        reserved.add(picked.target.name)
        // Retire whoever held this card before, THEN claim. A re-dispatch after a
        // host restart must not leave the old worker running beside the new one.
        const superseded = await supersedeExecutors(project, task, picked.target)
        if (superseded.board !== null) current = superseded.board
        if (superseded.refused.length > 0) {
          reserved.delete(picked.target.name)
          const noted = await state.apply(
            project,
            (value) => model.noteDispatchRefused(value, task.id, state.clock(), superseded.refused, 'the previous executor could not be interrupted'),
            writePolicyFor(project),
          )
          if (noted.failed === null) current = noted.board
          results.push({ id: task.id, skipped: 'already-dispatched', alive: superseded.refused })
          continue
        }
        let lockPaths = []
        if (task.writeFiles.length > 0) {
          const acquired = locks.acquire(
            state.memory.locks,
            task.writeFiles,
            { taskId: task.id, agent: picked.target.name },
            state.clock(),
            TASK_LEASE_MS,
          )
          if (acquired.ok !== true || acquired.granted !== true) {
            results.push({ id: task.id, skipped: 'files-busy', conflicts: acquired.conflicts === undefined ? [] : acquired.conflicts })
            continue
          }
          state.memory.locks = acquired.locks
          lockPaths = acquired.paths
        }
        // The worktree is prepared before the claim so the brief can describe
        // it, and so the fields land on the task in the same write that makes it
        // running. There is no shared-tree fallback: a project that cannot host
        // a worktree cannot run the task.
        let worktree
        try {
          worktree = await prepareWorktree(gitFacade(), project, task, dispatch, model.attemptSlot(task), worktreeDeadlineMs)
        } catch (error) {
          worktree = worktreeFallback('worktree-error', String((error && error.message) || error))
        }
        if (worktree.error !== null) {
          // Release what this attempt reserved before deciding what to do with it.
          releaseTaskLocks(task.id)
          reserved.delete(picked.target.name)
          if (isTransientEnvironmentCode(worktree.code)) {
            // The merge pipeline works in the MAIN checkout, so "the main tree is
            // clean" is briefly false while it runs. That is not a broken
            // environment: skip THIS card, keep dispatch running and retry it next
            // pass. Only a sustained streak escalates to a human (T-108).
            const entry = noteEnvironmentFailure(task.id, worktree.code, worktree.message, state.clock())
            const detail = String(worktree.code) + ': ' + String(worktree.message)
            if (entry.escalated === true) {
              const marked = await markEnvironmentWaiting(project, task.id, detail)
              if (marked !== null) current = marked
            }
            emit(entry.escalated === true ? 'environment-dirty-sustained' : 'environment-dirty', entry.escalated === true ? 'system' : 'host', {
              taskId: task.id,
              detail:
                'transient environment failure (' + detail + '); card skipped this pass, dispatch keeps running' +
                (entry.escalated === true
                  ? ' — retried ' + String(entry.count) + ' times, needs a clean main tree (commit or stash)'
                  : ''),
            })
            results.push({
              id: task.id,
              skipped: 'environment-dirty',
              reason: String(worktree.code),
              detail: String(worktree.message),
              retries: entry.count,
              escalated: entry.escalated === true,
            })
            continue
          }
          // A real setup problem (no git runner, not a repository, an add that
          // keeps failing): pausing is the backoff, and the panel says so.
          const message =
            'worktree refused for ' + task.id + ' (' + worktree.error + '); dispatch paused for this project until the git environment can host a task worktree'
          emit('error', 'system', { taskId: task.id, detail: 'worktree refused: ' + String(worktree.error) })
          await pauseForWorktree(project, task.id, worktree.error, message)
          results.push({ id: task.id, error: message, code: 'worktree-unavailable' })
          paused = true
          break
        }
        // The window passed for this card: forget its streak and its marker so the
        // claim cannot inherit a stale "waiting for a clean tree".
        clearEnvironmentFailure(task.id)
        if (task.waitingReason === 'dirty-worktree') {
          const cleared = await clearEnvironmentWaiting(project, task.id)
          if (cleared !== null) current = cleared
        }
        if (worktree.retried === true) {
          // The add failed once, was rolled back and succeeded on the retry in the
          // same tick: worth a panel entry, because it means the git environment is
          // slow or contended even though this attempt recovered.
          const summary = worktree.cleanup === null || worktree.cleanup === undefined ? 'no cleanup' : worktree.cleanup.summary
          emit('worktree-retry', 'host', {
            taskId: task.id,
            detail: 'worktree add for ' + String(worktree.path) + ' succeeded on retry (' + String(worktree.elapsedMs) + 'ms; cleanup: ' + summary + ')',
          })
        }
        const claimed = await state.apply(
          project,
          (board) =>
            model.claimTask(
              board,
              task.id,
              {
                name: picked.target.name,
                session: picked.target.id,
                via: picked.spawn === true ? 'spawn' : 'message',
                host: boot,
                lead: picked.lead !== undefined && picked.lead !== null && picked.lead.name !== undefined ? String(picked.lead.name) : null,
                leadSession: agentSessionOf(picked.lead),
                // NOTE: `session` is the WORKER's identity (assignee.session); the
                // card's own session travels as cardSession.
                cardSession: ownerSession === null ? selfSessionId : ownerSession,
                ownerCompat: ownerCompat,
                project: project,
                worktree: worktree,
                adopt:
                  worktree.adopted === true
                    ? { fromAttempt: worktree.fromAttempt, branch: worktree.branch, head: worktree.head === undefined ? null : worktree.head }
                    : null,
              },
              state.clock(),
            ),
          writePolicyFor(project),
        )
        // Requirement: if the lead we resolved does not belong to the card's own
        // session, say so loudly instead of shipping work into another team.
        const resolvedLeadSession = agentSessionOf(picked.lead)
        const cardSession = ownerSession
        if (cardSession !== null && resolvedLeadSession !== null && resolvedLeadSession !== cardSession) {
          emit('warn', 'host', {
            taskId: task.id,
            detail: 'dispatch used Lead ' + String(picked.lead.name === undefined ? picked.lead.id : picked.lead.name) + ' of session ' + resolvedLeadSession + ' for a card owned by session ' + cardSession,
          })
        }
        if (claimed.failed !== null) {
          releaseTaskLocks(task.id)
          // The claim lost: a worktree made for a task that never started must
          // not be left behind.
          await removeWorktree(gitFacade(), project, worktree.path)
          emit('worktree-remove', 'host', { taskId: task.id, detail: 'worktree removed after a lost claim' })
          results.push({ id: task.id, error: claimed.failed.message, code: claimed.failed.code })
          continue
        }
        current = claimed.board
        rememberMemberProject(ctx, picked.target.name, project)
        // Claimed: the waiting marker (if any) no longer applies.
        const cleared = await state.apply(
          project,
          (board) => {
            const tasks = board.tasks.map((entry) =>
              String(entry.id) === String(task.id) ? Object.assign({}, entry, { waitingReason: null, waitingDetail: null }) : entry,
            )
            return { ok: true, board: Object.assign({}, board, { tasks: tasks }), events: [] }
          },
          writePolicyFor(project),
        )
        if (cleared.failed === null) current = cleared.board
        if (worktree.adopted === true) {
          emit('attempt-adopt', 'host', {
            taskId: task.id,
            detail:
              'adopted ' + String(worktree.branch) + (worktree.head === null || worktree.head === undefined ? '' : ' @ ' + String(worktree.head).slice(0, 10)) +
              ' from attempt ' + String(worktree.fromAttempt) + ' instead of a fresh checkout',
          })
        } else {
          emit('worktree-create', 'host', { taskId: task.id, detail: 'task worktree ' + String(worktree.path) })
        }
        const claimedTask = model.findTask(current, task.id)
        const leadName = picked.lead !== undefined && picked.lead !== null && picked.lead.name !== undefined ? picked.lead.name : 'lead'
        // ONE brief for both delivery paths: a spawned teammate and a reused
        // teammate handed the task by sendMessage receive the same text, prompt
        // and skills included.
        const brief = briefFor(claimedTask, project, leadName, workerConfig)
        let delivered = null
        let sendError = null
        try {
          const signal = AbortSignal.timeout(SEND_TIMEOUT_MS)
          const team = ctx.get('agentTeams')
          if (picked.spawn === true) {
            delivered = await team.spawnTeammate(picked.lead, {
              name: picked.target.name,
              description: claimedTask.title,
              prompt: [
                { type: 'text', text: spawnPreamble(picked.target.name, leadName) },
                { type: 'text', text: brief },
              ],
              context: 'fresh',
              provider: subagentProviderFor(ctx),
              signal: signal,
            })
          } else {
            delivered = await team.sendMessage(picked.lead, {
              target: picked.target.name,
              content: [{ type: 'text', text: brief }],
              signal: signal,
            })
          }
        } catch (error) {
          sendError = String((error && error.message) || error)
        }
        if (sendError !== null || delivered === null) {
          const failed = await state.apply(
            project,
            (board) =>
              model.failDispatch(
                board,
                task.id,
                sendError === null ? 'the team service returned no result' : sendError,
                state.clock(),
                dispatch.maxAttempts,
              ),
            writePolicyFor(project),
          )
          if (failed.failed === null) current = failed.board
          releaseTaskLocks(task.id)
          memory.lastError = sendError === null ? 'the team service returned no result' : sendError
          emit('error', 'system', { taskId: task.id, detail: 'dispatch delivery failed: ' + memory.lastError })
          results.push({ id: task.id, error: memory.lastError })
          continue
        }
        // The member now works for THIS project; a later submit from it is only
        // accepted here (a worker handed another project's card cannot slip in).
        rememberMemberProject(ctx, picked.target.name, project)
        if (picked.spawn === true) {
          const member = delivered.member === undefined || delivered.member === null ? null : delivered.member
          const attached = await state.apply(
            project,
            (board) =>
              model.attachWorker(
                board,
                task.id,
                { session: member === null ? null : member.id, name: member === null ? null : member.name },
                state.clock(),
              ),
            writePolicyFor(project),
          )
          if (attached.failed === null) current = attached.board
        } else {
          const recorded = await state.apply(
            project,
            (board) =>
              model.recordDispatch(
                board,
                task.id,
                {
                  status: delivered.status === 'queued' ? 'queued' : 'sent',
                  at: new Date(state.clock()).toISOString(),
                },
                state.clock(),
              ),
            writePolicyFor(project),
          )
          if (recorded.failed === null) current = recorded.board
        }
        slots -= 1
        results.push({
          id: task.id,
          ok: true,
          target: picked.target.name,
          spawned: picked.spawn === true,
          files: lockPaths,
          worktree: worktree.path,
          worktreeError: worktree.error,
        })
      }
      return {
        ok: true,
        state: paused ? 'paused' : 'running',
        paused: paused === true,
        dispatched: results.filter((entry) => entry.ok === true).length,
        results: results,
        roles: roleResults,
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
  }

  return { kick: kick, tick: tick, settle: settle, status: status, dispose: dispose, memory: memory, boot: boot }
}

// ── host-side interruption of a worker that no longer owns the task ─────────

// One WeakMap per row: the memory dies with the row, so a reload starts clean.
const interruptMemory = new WeakMap()

/**
 * Interrupt one teammate turn because the task it served is no longer running.
 *
 * DSH's interrupt takes effect at the NEXT step boundary: it stops the teammate
 * before it starts another step, so it is "stop as soon as possible", never
 * "stop the current tool call". The call goes through the Team Lead (the Team
 * edge's caller) and one (task, status, member) triple is interrupted at most
 * once per row, so a repeated cancel cannot spam the worker. After the hard
 * interrupt a best-effort inbox note tells the worker why it must stop.
 *
 * @param ctx - the row context (needs the optional agentTeams service).
 * @param options.name - the durable teammate name.
 * @param options.key - idempotency key; defaults to the name.
 * @param options.message - the inbox note; a default is used when absent.
 * @returns { ok: true, previousStatus } or a readable refusal (never throws).
 */
export async function interruptMemberNamed(ctx, options) {
  const opts = options === undefined || options === null ? {} : options
  const name = typeof opts.name === 'string' && opts.name !== '' ? opts.name : null
  if (name === null) return { ok: false, code: 'no-name' }
  const { agentTeams } = servicesFor(ctx)
  if (agentTeams === undefined || agentTeams === null) return { ok: false, code: 'no-team-service' }
  const lead = resolveLead(ctx)
  if (lead === null) return { ok: false, code: 'no-lead' }
  let members = []
  try {
    members = agentTeams.listMembers(lead)
  } catch (error) {
    return { ok: false, code: 'roster-unreadable', message: String((error && error.message) || error) }
  }
  const member = (Array.isArray(members) ? members : []).filter(
    (entry) => entry !== null && typeof entry === 'object' && entry.name === name,
  )[0]
  if (member === undefined) return { ok: false, code: 'unknown-member' }
  // Only a member that is actually running is interrupted: an idle member has
  // no turn to stop, and a fresh inbox entry would become the NEXT step's work.
  if (member.status !== 'running') return { ok: false, code: 'not-running' }
  const key = typeof opts.key === 'string' && opts.key !== '' ? opts.key : name
  let memo = interruptMemory.get(ctx)
  if (memo === undefined) {
    memo = new Set()
    interruptMemory.set(ctx, memo)
  }
  if (memo.has(key)) return { ok: false, code: 'already-interrupted' }
  if (memo.size > 500) memo.clear()
  if (typeof agentTeams.interrupt !== 'function') return { ok: false, code: 'no-interrupt-api' }
  memo.add(key)
  let previousStatus = null
  try {
    const outcome = await agentTeams.interrupt(lead, name)
    if (outcome !== null && outcome !== undefined && typeof outcome === 'object' && typeof outcome.previousStatus === 'string') {
      previousStatus = outcome.previousStatus
    }
  } catch (error) {
    memo.delete(key)
    return { ok: false, code: 'interrupt-failed', message: String((error && error.message) || error) }
  }
  // The inbox note is the soft half: the interrupt lands at a step boundary, so
  // the worker is told why to stop. A refused mailbox never fails the caller.
  const text =
    typeof opts.message === 'string' && opts.message !== ''
      ? opts.message
      : 'Your task is no longer running; stop working on it now and discard uncommitted changes.'
  try {
    const request = { target: name, content: [{ type: 'text', text: text }] }
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      request.signal = AbortSignal.timeout(SEND_TIMEOUT_MS)
    }
    await agentTeams.sendMessage(lead, request)
  } catch (error) {}
  return { ok: true, previousStatus: previousStatus }
}

/**
 * Interrupt the assignee of a task that just left `running` (cancelled, blocked,
 * or a withdrawn start request). The caller passes the task as it was BEFORE the
 * transition: that record still names the worker, and its status is the reason
 * baked into the idempotency key.
 */
export async function interruptAssignee(ctx, task, options) {
  const opts = options === undefined || options === null ? {} : options
  const assignee = task === null || task === undefined ? null : task.assignee
  const name = assignee !== null && assignee !== undefined && typeof assignee.name === 'string' ? assignee.name : null
  if (name === null || name === '') return { ok: false, code: 'no-assignee' }
  const reason = typeof opts.reason === 'string' && opts.reason !== '' ? opts.reason : 'no longer running'
  const state = typeof opts.state === 'string' && opts.state !== '' ? opts.state : String(task.status)
  return interruptMemberNamed(ctx, {
    name: name,
    key: String(task.id) + '@' + state + '@' + name,
    message:
      'Task ' + String(task.id) + ' (' + String(task.title) + ') is ' + reason +
      '. Stop working on it now and discard uncommitted changes; do not submit.',
  })
}