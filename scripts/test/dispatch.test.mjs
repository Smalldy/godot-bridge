// Tests for the dispatch edge's probe.
//
// What matters here is not that the probe reports success when everything is
// present — that is the easy case. It is that the probe DEGRADES: a composition
// without the agent-team row must leave this plugin's row working and reporting
// what it cannot see, rather than failing to activate or throwing during a panel
// read. So most of these checks are about absence, refusal and a service that
// misbehaves, because those are the states this code will actually meet.
//
// The probe is also where the design's ONE inference lives — whether a profile row
// receives `agent/status` — so the watcher is tested for what it records on both
// channels, including the case where a channel cannot be used at all.
//
// Run by `npm test`.
const { servicesFor, resolveLead, probeDispatch, watchAgentStatus } = await import(
  '../../plugin/task-center/dispatch.mjs'
)

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${condition || detail === undefined ? '' : '  -> ' + detail}`)
}

/** An agent handle. Only `id` is read by this module, which is the point: the probe
 * must not depend on the richer interface to identify who it is talking to. */
const agent = (id) => ({ id: id })

/** A Team service whose roster is whatever the test needs it to be. */
function teamService(options) {
  const opts = options || {}
  return {
    tryMembership(candidate) {
      if (opts.throwsFor !== undefined && opts.throwsFor === candidate.id) throw new Error('not a member')
      return opts.membership === undefined ? undefined : opts.membership(candidate)
    },
    listMembers() {
      if (opts.listThrows === true) throw new Error('roster unavailable')
      return opts.roster === undefined ? [] : opts.roster
    },
  }
}

// ── service access never throws, whatever the context does ─────────────────
const hostileCtx = {
  get() {
    throw new Error('service not available')
  },
}
const absent = servicesFor(hostileCtx)
check('a context that throws on get yields no services', absent.agents === undefined && absent.agentTeams === undefined)
check('resolveLead answers null rather than throwing', resolveLead(hostileCtx) === null)
const absentReport = probeDispatch(hostileCtx, undefined)
check('the probe still reports', absentReport.hasAgents === false && absentReport.hasAgentTeams === false)
check('and names no lead', absentReport.lead === null)

const emptyCtx = { get: () => undefined }
check('an empty composition yields no services', servicesFor(emptyCtx).agentTeams === undefined)
check('and no lead', resolveLead(emptyCtx) === null)

// ── finding the lead ───────────────────────────────────────────────────────
const lead = agent('session-lead')
const mate = agent('session-mate')
const contextWithTeam = (opts) => {
  const teams = teamService(opts)
  return {
    get(key) {
      if (key === 'agents') {
        return {
          list() {
            if (opts !== undefined && opts.listAgentsThrows === true) throw new Error('registry unavailable')
            return opts !== undefined && opts.agents !== undefined ? opts.agents : [mate, lead]
          },
        }
      }
      if (key === 'agentTeams') return teams
      return undefined
    },
  }
}

const byRole = contextWithTeam({
  membership: (candidate) => (candidate.id === 'session-lead' ? { role: 'lead', name: 'lead' } : { role: 'teammate', name: 'mate' }),
})
check('the lead is found by role, not by position', resolveLead(byRole) === lead)
check('and not simply the first registry entry', resolveLead(byRole) !== mate)

const teammateOnly = contextWithTeam({ membership: () => ({ role: 'teammate', name: 'mate' }) })
check('a team with no lead yields null', resolveLead(teammateOnly) === null)

const throwingMembership = contextWithTeam({
  throwsFor: 'session-mate',
  membership: (candidate) => (candidate.id === 'session-lead' ? { role: 'lead' } : undefined),
})
check('a candidate whose membership throws is skipped, not fatal', resolveLead(throwingMembership) === lead)

const registryDown = contextWithTeam({ listAgentsThrows: true })
check('a registry that throws yields null', resolveLead(registryDown) === null)

// ── reporting the roster ───────────────────────────────────────────────────
const roster = [
  { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
  { id: 'session-mate', name: 'mate', role: 'teammate', status: 'inactive' },
]
const report = probeDispatch(
  contextWithTeam({
    membership: (candidate) => ({ role: candidate.id === 'session-lead' ? 'lead' : 'teammate' }),
    roster: roster,
  }),
  undefined,
)
check('the probe reports both services present', report.hasAgents === true && report.hasAgentTeams === true)
check('it counts the agents', report.agentCount === 2, String(report.agentCount))
check('it names the lead', report.lead === 'session-lead', String(report.lead))
check('it reports the roster as readable', report.membersReadable === true)
check('it carries every member with a status', report.members.length === 2 && report.members[1].status === 'inactive')
check('member ids are strings', typeof report.members[0].id === 'string')
check('no watcher means no event block', report.events === null)

const rosterDown = probeDispatch(
  contextWithTeam({
    membership: () => ({ role: 'lead' }),
    listThrows: true,
  }),
  undefined,
)
check('an unreadable roster is reported, not thrown', rosterDown.membersReadable === false && String(rosterDown.members[0]).startsWith('error:'))

const agentsDown = probeDispatch(contextWithTeam({ listAgentsThrows: true, membership: () => undefined }), undefined)
check('an unreadable registry is reported', String(agentsDown.agentCount).startsWith('error:'))

// ── the one inferred part: does this row RECEIVE agent/status? ─────────────
function fakeScope() {
  const handlers = []
  return {
    handlers,
    on(name, handler) {
      handlers.push({ name, handler })
      return () => handlers.splice(handlers.indexOf(handler), 1)
    },
  }
}

const scope = fakeScope()
const rootScope = fakeScope()
const watcher = watchAgentStatus({ on: scope.on, root: { on: rootScope.on } })
check('both channels subscribe', scope.handlers.length === 1 && rootScope.handlers.length === 1)
check('both subscriptions are recorded as made', watcher.counts.ctxSubscribed === true && watcher.counts.rootSubscribed === true)

scope.handlers[0].handler({ agent: agent('session-lead'), status: 'idle' })
scope.handlers[0].handler({ agent: agent('session-mate'), status: 'running' })
rootScope.handlers[0].handler({ agent: agent('session-lead'), status: 'running' })
check('the ctx channel counts what it delivers', watcher.counts.ctx === 2, String(watcher.counts.ctx))
check('the root channel counts what it delivers', watcher.counts.root === 1, String(watcher.counts.root))
check('the log records the payload', watcher.log[0].status === 'idle' && watcher.log[0].agent === 'session-lead')
check('the log names the channel', watcher.log[2].channel === 'root')
check('an empty payload does not throw', (() => { scope.handlers[0].handler(undefined); return true })())
check('and is recorded as unknown', watcher.log[watcher.log.length - 1].status === null)

const readBack = probeDispatch(contextWithTeam({ membership: () => ({ role: 'lead' }), roster: roster }), watcher)
check('the probe carries the event counts', readBack.events.counts.ctx === 3, JSON.stringify(readBack.events.counts))

// A scope that cannot subscribe is a RESULT, not a crash: it is how we find out
// this row cannot hear status changes.
const deaf = watchAgentStatus({})
check('a context with no on() is recorded, not fatal', deaf.counts.ctxSubscribed === undefined && deaf.log.length >= 1)
check('and the log says why', String(deaf.log[0].error).includes('no on()'))
check('disposing a deaf watcher is safe', (() => { deaf.dispose(); return true })())

// Disposal must actually unsubscribe, or a reload would accumulate listeners.
const disposable = fakeScope()
let disposed = 0
const liveWatcher = watchAgentStatus({
  on: (name, handler) => {
    disposable.on(name, handler)
    return () => { disposed++ }
  },
})
liveWatcher.dispose()
check('dispose releases the subscriptions', disposed >= 1, String(disposed))

// ── the row's own scope is used for the effect, when it has one ────────────
let effectLabel = null
watchAgentStatus({
  on: () => () => {},
  effect(fn, label) {
    effectLabel = label
    return () => {}
  },
})
check('the subscription is registered as an effect', typeof effectLabel === 'string' && effectLabel.includes('agent/status'))

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
