/**
 * Dispatch: handing a pooled task to a WorkAgent, and the probe that proves it can.
 *
 * This module is the plugin's side of the task-system-to-WorkAgent edge. Its first
 * slice is deliberately a READ-ONLY probe, because three things about that edge are
 * asserted rather than measured, and one of them is only inferred:
 *
 *   1. that a profile-level row can reach the `agentTeams` and `agents` services;
 *   2. that a member's status is readable, which is how "who is idle" is answered;
 *   3. that a profile-level row RECEIVES `agent/status` events. This last one is
 *      inferred from the shipped TeamService doing exactly the same thing, and it is
 *      the only inference in the whole design — so the probe subscribes on two
 *      channels and reports which one delivers, rather than assuming.
 *
 * Everything here goes through `ctx.get(...)` rather than a hard `inject`, on
 * purpose: a composition without the agent-team row must degrade to the alternate
 * dispatch paths, not fail to activate this row.
 *
 * The harness supplies TRANSPORT AND LIVENESS here — who exists, who is idle, how to
 * wake them. The board supplies STATE AND RULES — which task is ready, who owns it,
 * and what prevents a second dispatch. Keeping that line is what avoids mirroring our
 * tasks into the Team's own task list, and with it a whole class of sync bugs.
 */

import { claimTask, findTask, patchTask, releaseClaim } from './service.mjs'
import { writePolicyFor } from './state.mjs'

/** How many observed events to keep for the probe to report. */
const EVENT_LOG_LIMIT = 20

/** The services this edge needs, fetched optionally so their absence degrades. */
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
 * The Lead of the team this agent belongs to.
 *
 * `tryMembership` is used rather than `membership` because it answers `undefined`
 * for a non-Team subagent or a stale identity instead of throwing — the caller is
 * not always a Team member, and that is a normal outcome, not an error.
 */
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

/**
 * Watch `agent/status` on two channels and count what each delivers.
 *
 * Returns a disposer plus the log, so the probe can be read long after the row was
 * applied. Registration failures are recorded rather than thrown: finding out that
 * one channel cannot be used IS the result.
 */
export function watchAgentStatus(ctx) {
  const log = []
  const counts = { ctx: 0, root: 0 }
  const record = (channel) => (payload) => {
    counts[channel] = counts[channel] + 1
    log.push({
      channel: channel,
      at: new Date().toISOString(),
      status: payload === undefined || payload === null ? null : payload.status,
      agent: payload !== undefined && payload !== null && payload.agent !== undefined ? String(payload.agent.id) : null,
    })
    if (log.length > EVENT_LOG_LIMIT) log.shift()
  }
  const disposers = []
  function subscribe(scope, channel) {
    if (scope === undefined || scope === null || typeof scope.on !== 'function') {
      log.push({ channel: channel, error: 'scope has no on()' })
      return
    }
    try {
      const disposer = scope.on('agent/status', record(channel))
      if (typeof disposer === 'function') disposers.push(disposer)
      counts[channel + 'Subscribed'] = true
    } catch (error) {
      log.push({ channel: channel, error: String((error && error.message) || error) })
    }
  }
  subscribe(ctx, 'ctx')
  // `root` is the alternate the design noted: if the row's own scope is a sibling of
  // the agent scopes rather than an ancestor, this is where the events arrive.
  subscribe(ctx === undefined || ctx === null ? undefined : ctx.root, 'root')
  const watcher = {
    counts: counts,
    log: log,
    dispose: function () {
      for (const disposer of disposers) {
        try {
          disposer()
        } catch (error) {}
      }
    },
  }
  if (ctx !== undefined && ctx !== null && typeof ctx.effect === 'function') {
    ctx.effect(function () {
      return watcher.dispose
    }, 'godot-bridge: agent/status probe')
  }
  return watcher
}

/**
 * What the dispatch edge looks like right now: which services are reachable, who the
 * Lead is, who is on the team and how busy, and whether status events are arriving.
 */
export function probeDispatch(ctx, watcher) {
  const { agents, agentTeams } = servicesFor(ctx)
  const report = {
    hasAgents: agents !== undefined && agents !== null,
    hasAgentTeams: agentTeams !== undefined && agentTeams !== null,
    agentCount: null,
    lead: null,
    members: [],
    membersReadable: false,
    events: watcher === undefined ? null : { counts: watcher.counts, log: watcher.log },
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
    report.members = agentTeams.listMembers(lead).map(function (member) {
      return { id: String(member.id), name: member.name, role: member.role, status: member.status }
    })
    report.membersReadable = true
  } catch (error) {
    report.members = ['error: ' + String((error && error.message) || error)]
  }
  return report
}

// ── the ready list ─────────────────────────────────────────────────────────

/** A task is dispatchable when it is POOLED and everything it waits on is done.
 * Neither half is about who is available; that is a separate question, and keeping
 * them apart is what lets the board say "waiting for T-5" instead of going quiet. */
export function dispatchableTasks(board) {
  return board.tasks.filter(function (task) {
    if (task.status !== 'queued') return false
    return unmetDependencies(board, task).length === 0
  })
}

/** The tasks a task is still waiting on: unfinished, or gone entirely. A dependency
 * that no longer exists counts as unmet rather than satisfied — a missing
 * prerequisite is not a completed one. */
export function unmetDependencies(board, task) {
  const ids = Array.isArray(task.blockedBy) ? task.blockedBy : []
  return ids.filter(function (id) {
    const dependency = findTask(board, id)
    if (dependency === undefined) return true
    return dependency.status !== 'done'
  })
}

// ── choosing who ───────────────────────────────────────────────────────────

/**
 * Pick the member to hand a task to: an IDLE teammate.
 *
 * The Lead is never a target. The Lead is the agent the user is talking to, and its
 * work arrives as conversation, not as a queued task; dispatching pool work to it
 * would put a task in the middle of somebody's dialogue.
 *
 * Spawning a teammate when none is idle is deliberately NOT done here. Spawning is a
 * decision about cost and lifetime, and a dispatcher that silently creates agents
 * whenever the pool has work is a dispatcher that can create them without bound.
 */
export function pickTarget(ctx) {
  const { agents, agentTeams } = servicesFor(ctx)
  if (agents === undefined || agents === null || agentTeams === undefined || agentTeams === null) {
    return { ok: false, code: 'no-team-service', message: 'the agent-team services are not present in this profile' }
  }
  const lead = resolveLead(ctx)
  if (lead === null) {
    return { ok: false, code: 'no-lead', message: 'no live Team Lead; the agent team has no roster to dispatch into' }
  }
  let members = []
  try {
    members = agentTeams.listMembers(lead)
  } catch (error) {
    return { ok: false, code: 'roster-unreadable', message: String((error && error.message) || error) }
  }
  const teammates = members.filter((member) => member.role === 'teammate')
  if (teammates.length === 0) {
    return {
      ok: false,
      code: 'no-teammates',
      message: 'the team has no WorkAgent yet; spawning one is a deliberate act, not something dispatch does on its own',
      members: members,
    }
  }
  const idle = teammates.filter((member) => member.status === 'inactive' || member.status === 'provisioning')
  if (idle.length === 0) {
    return {
      ok: false,
      code: 'no-idle-member',
      message: 'every WorkAgent is busy; the next dispatch waits for one to go idle',
      members: members,
    }
  }
  return { ok: true, lead: lead, target: idle[0], members: members }
}

// ── the brief ──────────────────────────────────────────────────────────────

/**
 * What the assignee is told. It has to stand alone: the agent wakes with no context
 * beyond this message, and a task id it cannot resolve is worse than no message.
 *
 * The closing line is not politeness. An assignee that decides to dispatch too would
 * spawn work from work, and the guard belongs in the same payload as the task.
 */
export function briefFor(task, boardPath) {
  const lines = []
  lines.push('Task ' + task.id + ': ' + task.title)
  lines.push('')
  lines.push('You have been assigned this task from the task board. Do the work.')
  if (task.spec !== undefined && task.spec !== '') lines.push('', 'What it involves:', task.spec)
  if (task.acceptance !== undefined && task.acceptance !== '') lines.push('', 'How it will be judged:', task.acceptance)
  if (Array.isArray(task.blockedBy) && task.blockedBy.length > 0) {
    lines.push('', 'It was waiting on: ' + task.blockedBy.join(', ') + ' (now complete).')
  }
  lines.push(
    '',
    'Report progress and outcome with the `task_center` tool, which writes the board at ' + boardPath + ':',
    '  task_center { action: "show", id: "' + task.id + '" }        — the full task, including this assignment',
    '  task_center { action: "setStatus", id: "' + task.id + '", status: "in_progress" }',
    '  task_center { action: "submit", id: "' + task.id + '", evidence: "…" }   — when done, for the user to accept',
  )
  lines.push('', 'Do NOT dispatch anything yourself. You are the assignee, not the dispatcher.')
  return lines.join('\n')
}

// ── dispatch ───────────────────────────────────────────────────────────────

/** The dispatch record with one change merged in.
 *
 * The attempt counter is incremented in ONE place — the claim — and preserved
 * everywhere else. Recomputing it while recording the delivery result would count
 * every dispatch twice, which would spend the retry budget at half its real size. */
function mergeDispatch(board, taskId, change) {
  const task = findTask(board, taskId)
  const previous = task === undefined || task.dispatch === undefined || task.dispatch === null ? {} : task.dispatch
  return Object.assign({}, previous, change)
}

/** The claim IS the mutex. Only `claimTask` can produce `claimed`, so once it has
 * run, a second dispatch attempt finds a task that is no longer `queued` and stops —
 * which is why no separate dispatch lock is needed, and why the status gate below is
 * the double-dispatch protection rather than a formality. */
function claimMutator(board, taskId, target, now, via) {
  const task = findTask(board, taskId)
  if (task === undefined) return { ok: false, code: 'unknown-task', message: 'no task with id ' + String(taskId) }
  if (task.status !== 'queued') {
    return {
      ok: false,
      code: 'not-pooled',
      message: task.id + ' is ' + task.status + ', not queued; only pooled work is dispatched',
    }
  }
  const unmet = unmetDependencies(board, task)
  if (unmet.length > 0) {
    return {
      ok: false,
      code: 'dependency-unmet',
      message: task.id + ' is still waiting on ' + unmet.join(', '),
      waiting: unmet,
    }
  }
  const previous = task.dispatch === undefined || task.dispatch === null ? {} : task.dispatch
  const claimed = claimTask(board, taskId, { name: target.name, session: String(target.id) }, now)
  if (claimed.ok !== true) return claimed
  const recorded = patchTask(
    claimed.board,
    taskId,
    {
      dispatch: mergeDispatch(board, taskId, {
        attempts: (previous.attempts === undefined ? 0 : previous.attempts) + 1,
        at: new Date(now).toISOString(),
        via: via,
        target: target.name,
        targetId: String(target.id),
        status: 'sending',
      }),
    },
    now,
    'dispatcher',
  )
  if (recorded.ok !== true) return recorded
  return Object.assign({}, recorded, { events: claimed.events.concat(recorded.events || []) })
}

/**
 * Hand one pooled task to one WorkAgent, and record that it happened.
 *
 * Order matters and is deliberate: CLAIM FIRST, then send. The claim is what makes a
 * second dispatch impossible, so it has to happen before anything observable leaves
 * this process. If the send then fails, the claim is released and the task returns to
 * the pool with the attempt counted — a failed send must not leave a task looking
 * assigned to somebody who never heard about it.
 *
 * A `queued` delivery result counts as SUCCESS. The message is durable the moment it
 * is accepted, so retrying a `queued` send would duplicate the work.
 */
export async function dispatchOne(ctx, options, taskId, request) {
  const state = options.state
  const now = options.now === undefined ? Date.now() : options.now
  const projectPath = options.projectPath === undefined ? null : options.projectPath
  const signal = request === undefined ? undefined : request.signal
  if (typeof projectPath !== 'string' || projectPath.length === 0) {
    return { ok: false, code: 'unknown-project', message: 'no project is known yet; open the panel or run a tool call first' }
  }
  const read = await state.read(projectPath)
  if (read.failed !== null) return read.failed
  const task = findTask(read.board, taskId)
  if (task === undefined) return { ok: false, code: 'unknown-task', message: 'no task with id ' + String(taskId) }
  // Say WHY it is not dispatchable before asking who could take it: "waiting on T-5"
  // is useful, whereas "no idle member" would be a misleading answer to the same
  // question.
  if (task.status !== 'queued') {
    return { ok: false, code: 'not-pooled', message: task.id + ' is ' + task.status + ', not queued; only pooled work is dispatched' }
  }
  const unmet = unmetDependencies(read.board, task)
  if (unmet.length > 0) {
    return { ok: false, code: 'dependency-unmet', message: task.id + ' is still waiting on ' + unmet.join(', '), waiting: unmet }
  }
  const picked = pickTarget(ctx)
  if (picked.ok !== true) return picked
  const claimed = await state.apply(
    projectPath,
    (board) => claimMutator(board, taskId, picked.target, now, 'agentTeams'),
    writePolicyFor(projectPath),
  )
  if (claimed.failed !== null) return claimed.failed
  const boardPath = projectPath + '\\.agents\\tasks.json'
  let sent = null
  let sendError = null
  try {
    sent = await ctx.get('agentTeams').sendMessage(picked.lead, {
      target: picked.target.name,
      content: [{ type: 'text', text: briefFor(task, boardPath) }],
      signal: signal,
    })
  } catch (error) {
    sendError = String((error && error.message) || error)
  }
  if (sendError !== null || sent === null) {
    // Roll back: nobody should be holding a task they were never told about.
    const rolled = await state.apply(
      projectPath,
      (board) => {
        const released = releaseClaim(board, taskId, now, 'dispatcher')
        if (released.ok !== true) return released
        return patchTask(
          released.board,
          taskId,
          {
            dispatch: mergeDispatch(board, taskId, {
              at: new Date(now).toISOString(),
              via: 'agentTeams',
              target: picked.target.name,
              status: 'failed',
              error: sendError,
            }),
          },
          now,
          'dispatcher',
        )
      },
      writePolicyFor(projectPath),
    )
    return {
      ok: false,
      code: 'send-failed',
      message: sendError === null ? 'the team service returned no result' : sendError,
      target: picked.target.name,
      rolledBack: rolled.failed === null,
    }
  }
  const recorded = await state.apply(
    projectPath,
    (board) =>
      patchTask(
        board,
        taskId,
        {
          dispatch: mergeDispatch(board, taskId, {
            at: new Date(now).toISOString(),
            via: 'agentTeams',
            target: picked.target.name,
            targetId: String(picked.target.id),
            status: sent.status === undefined ? 'accepted' : sent.status,
            messageId: sent.messageId === undefined ? null : String(sent.messageId),
          }),
        },
        now,
        'dispatcher',
      ),
    writePolicyFor(projectPath),
  )
  return {
    ok: true,
    id: taskId,
    target: picked.target.name,
    messageId: sent.messageId === undefined ? null : String(sent.messageId),
    delivery: sent.status === undefined ? 'accepted' : sent.status,
    boardRecorded: recorded.failed === null,
  }
}
