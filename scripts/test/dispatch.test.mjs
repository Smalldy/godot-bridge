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
const {
  servicesFor,
  resolveLead,
  probeDispatch,
  watchAgentStatus,
  dispatchableTasks,
  unmetDependencies,
  pickTarget,
  briefFor,
  dispatchOne,
} = await import('../../plugin/task-center/dispatch.mjs')
const { emptyBoard } = await import('../../plugin/task-center/board.mjs')
const { createTask, findTask, publishTask, setTaskStatus, claimTask } = await import('../../plugin/task-center/service.mjs')

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

// ── dispatching: the invariants that keep work from being handed out twice ──
//
// These are the checks that matter most in the whole feature. A dispatch that runs
// twice does not fail loudly — it quietly puts two agents on one task — so the tests
// below are mostly about what must NOT happen.

const NOW = Date.parse('2026-01-15T12:00:00.000Z')
const PROJECT = 'J:\\demo\\mm13d'

/** The board the dispatcher writes, plus a counter, so "no write happened" is
 * assertable rather than assumed. */
function makeState(seed) {
  const holder = { board: seed, writes: 0 }
  return {
    holder,
    async read() {
      return { failed: null, board: holder.board, existed: true }
    },
    async apply(_projectPath, mutate) {
      const outcome = mutate(holder.board, 1)
      if (outcome === undefined) {
        return { failed: { ok: false, code: 'abandoned', message: 'mutator abandoned the write' } }
      }
      if (outcome.ok !== true) return { failed: outcome }
      holder.board = outcome.board
      holder.writes++
      return { failed: null, board: holder.board, version: 'v', attempts: 1, events: outcome.events || [] }
    },
  }
}

/** A board built through the real model, so dispatch is tested against real tasks. */
function boardWith(specs) {
  let board = emptyBoard()
  const ids = []
  for (const spec of specs) {
    const created = createTask(board, spec, NOW, 'me')
    board = created.board
    ids.push(created.task.id)
    if (spec.released !== false) board = publishTask(board, created.task.id, NOW, 'user').board
  }
  return { board: board, ids: ids }
}

/** A roster with one idle teammate, one busy teammate, and the Lead. */
function teamWith(overrides) {
  const opts = overrides || {}
  const calls = []
  const roster = opts.roster === undefined
    ? [
        { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
        { id: 'session-idle', name: 'fixer', role: 'teammate', status: 'inactive' },
        { id: 'session-busy', name: 'tester', role: 'teammate', status: 'running' },
      ]
    : opts.roster
  const teams = {
    calls,
    tryMembership: (candidate) => ({ role: candidate.id === 'session-lead' ? 'lead' : 'teammate', name: candidate.id }),
    listMembers: () => roster,
    async sendMessage(caller, request) {
      calls.push({ caller: caller.id, target: request.target, text: request.content[0].text })
      if (opts.sendThrows === true) throw new Error('mailbox full')
      return { messageId: 'msg-1', status: opts.delivery === undefined ? 'accepted' : opts.delivery }
    },
  }
  const ctx = {
    get(key) {
      if (key === 'agents') return { list: () => [agent('session-lead')] }
      if (key === 'agentTeams') return opts.noTeamService === true ? undefined : teams
      return undefined
    },
  }
  return { ctx: ctx, teams: teams, calls: calls }
}

const optionsFor = (state) => ({ state: state, projectPath: PROJECT, now: NOW })

// dependency arithmetic
const pair = boardWith([
  { title: 'first', spec: '' },
  { title: 'second', spec: '', blockedBy: ['T-1'] },
])
check('a task waiting on an unfinished dependency is not dispatchable', dispatchableTasks(pair.board).length === 1, String(dispatchableTasks(pair.board).length))
check('the one that is dispatchable is the prerequisite', dispatchableTasks(pair.board)[0].id === 'T-1')
check('its dependency is reported as unmet', unmetDependencies(pair.board, findTask(pair.board, 'T-2')).length === 1)
const finished = claimTask(pair.board, 'T-1', { name: 'someone' }, NOW).board
const done = setTaskStatus(finished, 'T-1', 'review', NOW, 'someone').board
const accepted = setTaskStatus(done, 'T-1', 'done', NOW, 'user').board
check('with the dependency done it becomes dispatchable', unmetDependencies(accepted, findTask(accepted, 'T-2')).length === 0)
check('queued to claimed is refused by the status table, so only claiming can do it', setTaskStatus(pair.board, 'T-1', 'claimed', NOW, 'x').code === 'illegal-transition')

const missing = { tasks: [{ id: 'T-9', title: 'x', status: 'queued', blockedBy: ['T-404'] }] }
check('a dependency that no longer exists counts as unmet', unmetDependencies(missing, missing.tasks[0]).length === 1)

// choosing who
const noTeam = pickTarget({ get: () => undefined })
check('without the team services there is nobody to pick', noTeam.code === 'no-team-service')
const leadOnly = teamWith({ roster: [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }] })
check('a roster with only the Lead has no WorkAgent', pickTarget(leadOnly.ctx).code === 'no-teammates')
check('and the Lead is never the answer', pickTarget(leadOnly.ctx).ok === false)
const allBusy = teamWith({ roster: [
  { id: 'session-lead', name: 'lead', role: 'lead', status: 'running' },
  { id: 'session-busy', name: 'tester', role: 'teammate', status: 'running' },
] })
check('a busy teammate is not dispatched to', pickTarget(allBusy.ctx).code === 'no-idle-member')
const idlePick = pickTarget(teamWith({}).ctx)
check('an idle teammate is picked', idlePick.ok === true && idlePick.target.name === 'fixer', JSON.stringify(idlePick.target))
check('and it is not the Lead', idlePick.target.role === 'teammate')

// the brief stands alone
const briefTask = { id: 'T-7', title: 'do the thing', spec: 'the spec', acceptance: 'the criteria', blockedBy: ['T-5'] }
const brief = briefFor(briefTask, PROJECT + '\\.agents\\tasks.json')
check('the brief names the task', brief.includes('T-7') && brief.includes('do the thing'))
check('the brief carries the spec and the criteria', brief.includes('the spec') && brief.includes('the criteria'))
check('the brief says where the board is', brief.includes('tasks.json'))
check('the brief says how to report', brief.includes('task_center') && brief.includes('evidence'))
check('the brief forbids the assignee from dispatching', brief.includes('Do NOT dispatch'))

// dispatch: the refusals must not write anything
let refused = await dispatchOne(teamWith({}).ctx, { state: makeState(boardWith([{ title: 'x' }]).board), projectPath: null, now: () => NOW }, 'T-1')
check('an unknown project is refused', refused.code === 'unknown-project')

const draftBoard = boardWith([{ title: 'x', released: false }])
const draftState = makeState(draftBoard.board)
refused = await dispatchOne(teamWith({}).ctx, optionsFor(draftState), 'T-1')
check('a draft is not dispatched', refused.code === 'not-pooled', refused.code)
check('and nothing was written', draftState.holder.writes === 0, String(draftState.holder.writes))

refused = await dispatchOne(teamWith({}).ctx, optionsFor(makeState(pair.board)), 'T-2')
check('a task whose dependency is unfinished is refused', refused.code === 'dependency-unmet')
check('and it says what it is waiting for', Array.isArray(refused.waiting) && refused.waiting[0] === 'T-1')
const waitingState = makeState(pair.board)
await dispatchOne(teamWith({}).ctx, optionsFor(waitingState), 'T-2')
check('a refused dispatch writes nothing', waitingState.holder.writes === 0)

const noAgentState = makeState(boardWith([{ title: 'x' }]).board)
refused = await dispatchOne(leadOnly.ctx, optionsFor(noAgentState), 'T-1')
check('with no WorkAgent the dispatch is refused', refused.code === 'no-teammates')
check('and the task is left in the pool', noAgentState.holder.writes === 0 && findTask(noAgentState.holder.board, 'T-1').status === 'queued')

// dispatch: the success path
const successBoard = boardWith([{ title: 'panel cleanup', spec: 'shrink it', acceptance: 'it is smaller' }])
const successState = makeState(successBoard.board)
const team = teamWith({})
const result = await dispatchOne(team.ctx, optionsFor(successState), 'T-1')
check('a dispatch reports success', result.ok === true, JSON.stringify(result))
check('and names the assignee', result.target === 'fixer')
check('and the message identity', result.messageId === 'msg-1')
const dispatchedTask = findTask(successState.holder.board, 'T-1')
check('the task is now claimed', dispatchedTask.status === 'claimed', dispatchedTask.status)
check('and assigned to the target', dispatchedTask.assignee.name === 'fixer')
check('and carries a lease', dispatchedTask.leaseUntil !== null)
check('the dispatch is recorded with the delivery status', dispatchedTask.dispatch.status === 'accepted')
check('the first attempt is numbered one', dispatchedTask.dispatch.attempts === 1)
check('the message went to the idle teammate', team.calls.length === 1 && team.calls[0].target === 'fixer')
check('the message carries the brief', team.calls[0].text.includes('Task T-1') && team.calls[0].text.includes('shrink it'))
check('the sender credential is the Lead', team.calls[0].caller === 'session-lead')

// the same task again: this is the failure the whole design guards
const second = await dispatchOne(team.ctx, optionsFor(successState), 'T-1')
check('a second dispatch of the same task is refused', second.ok === false && second.code === 'not-pooled', JSON.stringify(second))
check('and NO second message is sent', team.calls.length === 1, String(team.calls.length))

// a queued delivery is a success, and must not be retried
const queuedTeam = teamWith({ delivery: 'queued' })
const queuedState = makeState(boardWith([{ title: 'x' }]).board)
const queuedResult = await dispatchOne(queuedTeam.ctx, optionsFor(queuedState), 'T-1')
check('a queued delivery counts as dispatched', queuedResult.ok === true && queuedResult.delivery === 'queued')
check('and is recorded as queued, not retried', findTask(queuedState.holder.board, 'T-1').dispatch.status === 'queued')

// a failed send must not leave a task looking assigned
const failingTeam = teamWith({ sendThrows: true })
const failingState = makeState(boardWith([{ title: 'x' }]).board)
const failed = await dispatchOne(failingTeam.ctx, optionsFor(failingState), 'T-1')
check('a failing send is reported', failed.ok === false && failed.code === 'send-failed', JSON.stringify(failed))
check('the failure names the reason', String(failed.message).includes('mailbox full'))
check('the claim was rolled back', failed.rolledBack === true)
const afterFailure = findTask(failingState.holder.board, 'T-1')
check('the task is back in the pool', afterFailure.status === 'queued', afterFailure.status)
check('with no assignee left behind', afterFailure.assignee === null)
check('and the failed attempt is on the record', afterFailure.dispatch.status === 'failed')
check('the attempt was counted', afterFailure.dispatch.attempts === 1)

// a retry is allowed after a failure, and only after one
const retryTeam = teamWith({})
const retried = await dispatchOne(retryTeam.ctx, optionsFor(failingState), 'T-1')
check('a task whose send failed can be dispatched again', retried.ok === true, JSON.stringify(retried))
check('and the attempt count grows', findTask(failingState.holder.board, 'T-1').dispatch.attempts === 2)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
