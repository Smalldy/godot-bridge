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
