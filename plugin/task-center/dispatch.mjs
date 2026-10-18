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
import { randomUUID } from 'node:crypto'
import { boardPath, readRoleConfig } from './board.mjs'
import { writePolicyFor } from './state.mjs'
import { ROLE_KINDS, ROLE_PROVISION_TIMEOUT_MS, ROLE_STAGE, TASK_LEASE_MS, defaultRoleConfig, profileForKind } from './schema.mjs'
import * as model from './service.mjs'
import * as locks from './locks.mjs'
import { createGit } from './git.mjs'

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
/** Review rounds a task may go through before the host blocks it for triage. */
export const REVIEW_MAX_ROUNDS = 3

const RERUN_DELAY_MS = 250

/** Role slot names are fixed per kind and index: worker-1, reviewer-1, tester-1. */
export function roleSlotName(kind, index) {
  return String(kind) + '-' + String(index)
}

/** The role kind of a teammate name, or null. Feature workers are work-<task>-<n>,
 * so they never match; role slots are worker-<n>/reviewer-<n>/tester-<n>. */
export function roleKindOf(name) {
  if (typeof name !== 'string') return null
  const match = /^(worker|reviewer|tester)-(\d+)$/.exec(name)
  return match === null ? null : match[1]
}

export function isRoleName(name) {
  return roleKindOf(name) !== null
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

/** The Lead of the team this profile belongs to. tryMembership answers undefined
 * for a non-Team agent instead of throwing, which is a normal outcome. */
export function resolveLead(ctx) {
  const { agents, agentTeams } = servicesFor(ctx)
  if (agents === undefined || agents === null || agentTeams === undefined || agentTeams === null) return null
  let all = []
  try {
    all = agents.list()
  } catch (error) {
    return null
  }
  for (const candidate of all) {
    try {
      const membership = agentTeams.tryMembership(candidate)
      if (membership !== undefined && membership !== null && membership.role === 'lead') return candidate
    } catch (error) {}
  }
  return null
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
  const lead = resolveLead(ctx)
  if (lead === null) {
    return {
      ok: false,
      code: 'no-lead',
      message: 'no live Team root, so there is nobody to hand pooled work to; tasks stay pending',
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
  const idle = teammates.filter((member) => member.status === 'inactive' && !reserved.has(member.name))
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
    report.members.push({
      id: String(member.id),
      name: name,
      kind: kind,
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
function runnerFromSubprocess(subprocess) {
  return async function runGit(args, cwd) {
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
    let outcome = null
    try {
      outcome = await handle.done
    } catch (error) {
      return { code: 1, stdout: '', stderr: String((error && error.message) || error) }
    }
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
  return createGit({ run: runnerFromSubprocess(subprocess) })
}

/** The descriptor a task records when no worktree could be made. */
function worktreeFallback(error) {
  return { base: null, target: null, branch: null, path: null, keep: false, error: error }
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
      return { ok: false, code: 'git-unavailable', message: 'git status failed in ' + projectPath + ': ' + String(clean.message) }
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
 * Prepare this attempt's worktree. It is the only execution mode: no worktree
 * means no claim, never a shared checkout.
 *
 * Returns `{ base, target, branch, path, keep, error }`; `error` is set when
 * preparation refused and `path` is then null. It never throws, and a failed
 * add is force-removed so no half worktree is left behind.
 */
async function prepareWorktree(git, projectPath, task, dispatch, attempt) {
  const probe = await probeWorktree(git, projectPath)
  if (probe.ok !== true) return worktreeFallback(probe.code + ': ' + probe.message)
  const base = await git.head(projectPath)
  if (base.ok !== true) return worktreeFallback('base-unreadable: ' + String(base.message))
  const current = await git.currentBranch(projectPath)
  const branch = 'task/' + String(task.id) + '-' + String(attempt)
  const settings = dispatch === undefined || dispatch === null ? null : dispatch.worktree
  const root = String(settings === null || settings === undefined || settings.root === undefined || settings.root === null ? '' : settings.root).trim()
  // The checkout directory carries the attempt number: a failed attempt keeps
  // its worktree for inspection, so a retry must not try to re-add the same
  // path. The branch already carries the attempt, so the two stay in step.
  const path = join(projectPath, root === '' ? '.worktrees' : root, String(task.id) + '-' + String(attempt))
  const added = await git.worktreeAdd(projectPath, { path: path, branch: branch, base: base.hash })
  if (added.ok !== true) {
    // A refused add can still leave a directory or a registered worktree; force
    // it away so the next pass does not inherit a broken one.
    await removeWorktree(git, projectPath, path)
    return worktreeFallback('worktree-add-failed: ' + String(added.message))
  }
  return {
    base: base.hash,
    target: current.ok === true && typeof current.branch === 'string' ? current.branch : null,
    branch: branch,
    path: added.path,
    keep: true,
    error: null,
  }
}

/** Force-remove one worktree, ignoring every failure: cleanup must never fail a
 * dispatch. */
async function removeWorktree(git, projectPath, path) {
  if (git === undefined || git === null || typeof path !== 'string' || path === '') return
  if (typeof git.worktreeRemove !== 'function') return
  try {
    await git.worktreeRemove(projectPath, path, { force: true })
  } catch (error) {}
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

/** What the assignee is told. It has to stand alone: the agent wakes with no
 * context beyond this message. */
export function briefFor(task, projectPath, leadName) {
  const lines = []
  lines.push('Task ' + task.id + ': ' + task.title)
  lines.push('')
  lines.push('Project: ' + projectPath)
  lines.push('You have been assigned this task. Do the work in that project.')
  if (typeof task.worktree === 'string' && task.worktree.length > 0) {
    lines.push(
      '',
      'Work in the git worktree created for this task:',
      '  worktree: ' + task.worktree,
      '  branch:   ' + String(task.branch === null || task.branch === undefined ? '' : task.branch),
      '  base:     ' + String(task.base === null || task.base === undefined ? '' : task.base),
      'Change files ONLY inside that worktree, and run the tests there.',
      'The task board still lives in the main project — point task_center at',
      'the main project ("' + projectPath + '"), not at the worktree.',
    )
  }
  if (task.spec !== '') lines.push('', 'What it involves:', task.spec)
  if (task.acceptance !== '') lines.push('', 'How it will be judged:', task.acceptance)
  if (task.dependsOn.length > 0) lines.push('', 'Completed prerequisites: ' + task.dependsOn.join(', '))
  if (task.writeFiles.length > 0) {
    lines.push('', 'The scheduler holds these file locks for you:', task.writeFiles.join(', '))
  }
  lines.push(
    '',
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
  )
  return lines.join('\n')
}

/**
 * The brief a role teammate wakes with. It is self-contained: the role, the
 * stage it owns, the task it is being handed (when there is one), the hard
 * permission boundary, the exact verdict schema and the skills to load.
 *
 * Reviewer and tester briefs explicitly demand a FRESH independent context.
 * A worker brief on rework says to continue in the SAME worktree/context.
 */
export function roleBriefFor(kind, task, config, options) {
  const opts = options === undefined || options === null ? {} : options
  const profile = config !== null && config !== undefined ? profileForKind(config, kind) : null
  const stage = profile !== null && profile !== undefined && typeof profile.stage === 'string' ? profile.stage : ROLE_STAGE[kind] === undefined ? 'implement' : ROLE_STAGE[kind]
  const lines = []
  lines.push('Task center role: ' + String(kind))
  lines.push('Stage: ' + stage + ' (this role owns the ' + stage + ' stage; role profiles replace manual Lead spawns).')
  if (typeof opts.projectPath === 'string' && opts.projectPath.length > 0) lines.push('Project: ' + opts.projectPath)
  if (typeof opts.leadName === 'string' && opts.leadName.length > 0) lines.push('Team Lead: ' + opts.leadName)
  const rework =
    task !== null &&
    task !== undefined &&
    ((task.review !== null && task.review !== undefined && task.review.status === 'changes-requested') ||
      (task.test !== null && task.test !== undefined && task.test.status === 'failed'))
  if (profile !== null && profile !== undefined && Array.isArray(profile.permissions) && profile.permissions.length > 0) {
    lines.push('', 'Profile permissions: ' + profile.permissions.join(', '))
  }
  if (profile !== null && profile !== undefined && typeof profile.prompt === 'string' && profile.prompt !== '') {
    lines.push('', 'Profile instructions:', profile.prompt)
  }
  if (profile !== null && profile !== undefined && profile.context === 'fork') {
    lines.push('', 'Profile context: forked from the Lead (not a fresh context).')
  }
  if (task !== null && task !== undefined) {
    lines.push('', 'Task ' + String(task.id) + ': ' + String(task.title))
    if (typeof task.spec === 'string' && task.spec !== '') lines.push('', 'What it involves:', task.spec)
    if (typeof task.acceptance === 'string' && task.acceptance !== '') lines.push('', 'Acceptance:', task.acceptance)
    if (typeof task.worktree === 'string' && task.worktree !== '') {
      lines.push('', 'Worktree: ' + task.worktree)
      lines.push('Branch: ' + String(task.branch === null || task.branch === undefined ? '' : task.branch))
      lines.push('Commit: ' + String(task.commit === null || task.commit === undefined ? '' : task.commit))
    }
    if (rework) {
      lines.push('', 'This is REWORK: continue in the SAME worktree and the SAME context you used before; do not create a new branch or start from a fresh checkout.')
    }
  }
  if (kind === 'worker') {
    lines.push(
      '',
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
    lines.push(
      '',
      'Duties: review the submitted tree (the diff from its base to its head, the declared vs actual files, and the worker evidence). Approve it or request concrete changes.',
      '',
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
    lines.push(
      '',
      'Duties: independently test the candidate tree for the task and record a pass or a failure with evidence.',
      '',
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
    lines.push('', 'Duties: follow the task center board for this role.')
  }
  const skills = profile !== null && profile !== undefined && Array.isArray(profile.skills) ? profile.skills : []
  lines.push('', 'Skills:')
  lines.push('- task_center is your only interface to the board.')
  if (skills.length > 0) lines.push('- Load these project skills with the skill tool before acting: ' + skills.join(', '))
  else lines.push('- Load any project-specific skills with the skill tool before acting.')
  if (kind === 'reviewer' || kind === 'tester') {
    lines.push('', 'You are an independent, FRESH context: do not assume the worker conversation, and do not reuse its unstated context.')
  }
  return lines.join('\n')
}


/**
 * The per-round REVIEW brief the host sends the reviewer when a task enters
 * review (submit, or a refreshed head/base). It is self-contained: what the
 * task asked for, the tree under review, the worker's evidence, the project
 * conventions and a checklist — no full test run is expected at this stage.
 */
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

  function nextSlotName(kind, roster) {
    const used = new Set(memory.pending)
    for (const member of roster) {
      if (member !== null && typeof member === 'object' && typeof member.name === 'string') used.add(member.name)
    }
    for (let index = 1; index <= 999; index += 1) {
      const name = roleSlotName(kind, index)
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
    const lead = req.lead === undefined || req.lead === null ? resolveLead(ctx) : req.lead
    if (lead === null) return { ok: false, code: 'no-lead', message: 'no live Team root, so the ' + String(kind) + ' role cannot be provisioned' }
    let roster = []
    try {
      roster = agentTeams.listMembers(lead)
    } catch (error) {
      return { ok: false, code: 'roster-unreadable', message: String((error && error.message) || error) }
    }
    if (!Array.isArray(roster)) roster = []
    const now = Number.isFinite(req.now) ? req.now : clock()
    const reused = []
    const replaced = []
    const waiting = []
    for (const member of roster) {
      if (member === null || typeof member !== 'object' || member.role !== 'teammate') continue
      if (roleKindOf(member.name) !== kind) continue
      const name = String(member.name)
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
        const name = nextSlotName(kind, roster)
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
    const lead = resolveLead(ctx)
    if (lead === null) return { ok: false, code: 'no-lead', message: 'no live Team root' }
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
  const spawnAllowed = opts.allowSpawn !== false
  // The host-side role provisioner. Null means this caller did not opt into
  // role provisioning (older tests / direct API users); dispatch still works.
  const roles = opts.roles === undefined ? null : opts.roles
  // The in-memory activity ring the snapshot exposes. Null is a normal setup
  // (direct dispatcher users) and simply records nothing.
  const activity = opts.activity === undefined || opts.activity === null ? null : opts.activity
  // Tests shorten the review timeout; production uses REVIEW_TIMEOUT_MS.
  const reviewTimeoutMs = Number.isFinite(opts.reviewTimeoutMs) ? opts.reviewTimeoutMs : REVIEW_TIMEOUT_MS

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

  function status() {
    return {
      boot: boot,
      busy: memory.sweeping,
      lastTickAt: memory.lastTickAt,
      lastError: memory.lastError,
      lastResults: memory.lastResults,
      ticks: memory.ticks,
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
   * A worktree could not be prepared for this attempt: pause dispatch, record the
   * reason on the task for the panel, and leave the task pending. Pausing is the
   * backoff — a paused dispatcher is not retried by the timer, so a broken git
   * environment cannot turn into a five-second retry storm.
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

  async function reap(projectPath, board, now) {
    let current = board
    const limit = current.dispatch.maxAttempts
    // 1. Tasks claimed by another process. A plugin reload in the same process
    // keeps the boot id, so their live workers are not disturbed.
    const stale = current.tasks.filter(
      (task) => task.status === 'running' && (task.dispatch === null || task.dispatch.host !== boot),
    )
    if (stale.length > 0) {
      const next = await applyReap(projectPath, (value) => {
        let mutated = value
        for (const task of stale) {
          const result = model.failDispatch(mutated, task.id, 'worker lost (host restart)', now, limit)
          if (result.ok === true) mutated = result.board
        }
        return mutated
      })
      if (next !== null) {
        current = next
        for (const task of stale) releaseTaskLocks(task.id)
      }
    }
    // 2. Expired leases, even while dispatch is paused: a dead worker must not
    // hold a task forever.
    const expired = current.tasks.filter(
      (task) => task.status === 'running' && (task.leaseUntil === null || Date.parse(task.leaseUntil) <= now),
    )
    if (expired.length > 0) {
      const next = await applyReap(projectPath, (value) => {
        const result = model.expireLeases(value, now, limit)
        return result.ok === true ? result.board : value
      })
      if (next !== null) {
        current = next
        for (const task of expired) releaseTaskLocks(task.id)
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

  /**
   * The review timeout policy, driven by the host tick: a review that stays
   * undecided past REVIEW_TIMEOUT_MS gets one reminder to the reviewer; if it is
   * still undecided a full timeout later, the task is blocked for triage (and
   * the owner plus the Lead are told). Never blocks a dispatch pass.
   */
  async function sweepReviewTimeouts(projectPath, board, now) {
    const pending = board.tasks.filter(
      (task) =>
        task.status === 'reviewing' &&
        task.review !== null &&
        task.review !== undefined &&
        task.review.status === 'pending' &&
        typeof task.review.at === 'string',
    )
    if (pending.length === 0) return { reminded: [], blocked: [], board: null }
    const due = pending.filter((task) => now - Date.parse(task.review.at) >= reviewTimeoutMs)
    if (due.length === 0) return { reminded: [], blocked: [], board: null }
    const lead = resolveLead(ctx)
    const names = reviewerNames()
    const reminded = []
    const blocked = []
    let nextBoard = null
    const pendingKeys = new Set(pending.map((task) => String(task.id) + '@' + String(task.review.at)))
    for (const task of due) {
      const key = String(task.id) + '@' + String(task.review.at)
      const remindedAt = memory.reviewReminders.get(key)
      if (!Number.isFinite(remindedAt)) {
        if (names.length === 0 || lead === null) continue
        const sent = await sendMemberMessage(lead, names[0], 'Reminder — review is still waiting.\n\n' + reviewBriefFor(task, projectPath))
        if (sent === true) {
          memory.reviewReminders.set(key, now)
          reminded.push(task.id)
          emit('review-reminder', 'system', { taskId: task.id, detail: 'review still pending; reminded ' + names[0] })
        }
        continue
      }
      if (now - remindedAt < reviewTimeoutMs) continue
      const applied = await applyReap(projectPath, (value) => {
        const blocked = model.blockTask(value, task.id, now, 'system', 'review timed out: no reviewer verdict after two reminders')
        return blocked.ok === true ? blocked.board : value
      })
      if (applied === null) continue
      nextBoard = applied
      memory.reviewReminders.delete(key)
      blocked.push(task.id)
      emit('error', 'system', { taskId: task.id, detail: 'review timed out; task blocked for triage' })
      const owner = task.assignee === null || task.assignee === undefined ? null : task.assignee.name
      const notice =
        'Review for ' + String(task.id) + ' (' + String(task.title) + ') timed out with no verdict; the task is blocked for triage.\n' +
        '  project: ' + String(projectPath) + '\n' +
        '  branch: ' + String(task.branch === null || task.branch === undefined ? '' : task.branch) + '\n' +
        '  worktree: ' + String(task.worktree === null || task.worktree === undefined ? '' : task.worktree)
      if (typeof owner === 'string' && owner !== '') await sendMemberMessage(lead, owner, notice)
      if (lead !== null && typeof lead.name === 'string' && lead.name !== '') await sendMemberMessage(lead, lead.name, notice)
    }
    // Forget reminders for reviews that were decided (or whose round moved on).
    for (const key of Array.from(memory.reviewReminders.keys())) {
      if (!pendingKeys.has(key)) memory.reviewReminders.delete(key)
    }
    return { reminded: reminded, blocked: blocked, board: nextBoard }
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
      let current = await reap(project, read.board, now)
      // Roles are kept for tasks already in a review/test stage even while
      // dispatch is paused: a dead reviewer/tester must not strand a task.
      const roleResults = await ensureStageRoles(project, current, now)
      const reviewSweep = await sweepReviewTimeouts(project, current, now)
      if (reviewSweep.board !== null) current = reviewSweep.board
      for (const id of reviewSweep.reminded) results.push({ id: id, review: 'reminded' })
      for (const id of reviewSweep.blocked) results.push({ id: id, review: 'timed-out' })
      const dispatch = current.dispatch
      if (dispatch.state !== 'running') {
        return { ok: true, state: 'paused', tasks: current.tasks.length, results: results }
      }
      const running = current.tasks.filter((task) => task.status === 'running').length
      let slots = dispatch.maxConcurrent - running
      if (slots <= 0) return { ok: true, state: 'running', slots: 0, results: results }

      const ready = model.readyTasks(current)
      const reserved = new Set()
      for (const candidate of ready) {
        if (slots <= 0) break
        const task = model.findTask(current, candidate.id)
        if (task === undefined || task.status !== 'pending') continue
        if (task.writeFiles.length > 0) {
          const conflicts = locks.conflictsFor(state.memory.locks, task.writeFiles, 'task:' + task.id)
          if (conflicts.length > 0) {
            results.push({ id: task.id, skipped: 'files-busy', conflicts: conflicts })
            continue
          }
        }
        const picked = pickTarget(ctx, {
          reserved: reserved,
          spawn: dispatch.allowSpawn === true && spawnAllowed,
          maxWorkAgents: dispatch.maxWorkAgents,
          name: workAgentName(task.id, task.attempts + 1),
        })
        if (picked.ok !== true) {
          results.push({ id: task.id, skipped: picked.code, message: picked.message })
          break
        }
        reserved.add(picked.target.name)
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
          worktree = await prepareWorktree(gitFacade(), project, task, dispatch, task.attempts + 1)
        } catch (error) {
          worktree = worktreeFallback('worktree-error: ' + String((error && error.message) || error))
        }
        if (worktree.error !== null) {
          // Release what this attempt reserved, put the task back in the pool
          // and stop the pass: pausing dispatch is what prevents the five-second
          // timer from retrying a broken project forever. The user fixes the
          // environment and starts dispatch again.
          releaseTaskLocks(task.id)
          const message = 'worktree refused for ' + task.id + ' (' + worktree.error + '); dispatch paused until the environment is fixed'
          emit('error', 'system', { taskId: task.id, detail: 'worktree refused: ' + String(worktree.error) })
          await pauseForWorktree(project, task.id, worktree.error, message)
          results.push({ id: task.id, error: message, code: 'worktree-unavailable' })
          paused = true
          break
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
                worktree: worktree,
              },
              state.clock(),
            ),
          writePolicyFor(project),
        )
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
        emit('worktree-create', 'host', { taskId: task.id, detail: 'task worktree ' + String(worktree.path) })
        const claimedTask = model.findTask(current, task.id)
        const brief = briefFor(claimedTask, project)
        const leadName = picked.lead !== undefined && picked.lead !== null && picked.lead.name !== undefined ? picked.lead.name : 'lead'
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