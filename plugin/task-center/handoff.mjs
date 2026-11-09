/**
 * T-153: session handoff — who is still working on this shared board, and what a
 * NEW session may do about it.
 *
 * The project owns the board; a Team (and therefore a worker, a reviewer, a
 * tester) belongs to a SESSION. When a user abandons an old session and starts a
 * new one, the board can still hold cards owned by the old session, some of them
 * in flight. Onboarding must NOT silently bootstrap a second team, re-own those
 * cards or start dispatch. It must first answer "who is still here, with which
 * cards, and is the old executor still alive?", then let the user choose:
 *
 *   resume-owning-session  — the owning session is live; go back to it
 *   join-project-read-only — work alongside, never touch the old cards
 *   takeover-active-tasks  — the owning session is stale AND its executors are
 *                            dead; move exactly those cards, with an audit trail
 *
 * This module is the pure half: liveness classification, the inventory, and the
 * board mutations for a decision. api.mjs injects the live host lookups (DSH
 * session activity, team state, executor liveness) so every rule here is
 * unit-testable without a host.
 */



/** A card in one of these statuses is "in progress" for handoff purposes. */
export const HANDOFF_ACTIVE_STATUSES = ['running', 'reviewing', 'testing']

/** The only decisions the host can act on. An unknown mode would silently unlock
 * create, so it is never accepted. */
export const HANDOFF_DECISIONS = ['join-read-only', 'takeover']

/**
 * How long a participating session counts as LIVE after its last evidence.
 *
 * Deliberately independent of LEAD_STALE_MS (6 hours, about a Team Lead's
 * heartbeat): a user who closed a session 20 minutes ago is not going to come
 * back for the card, while a Lead that is silent for two hours is still the
 * project's Lead. Ten to fifteen minutes is the handoff window; override it with
 * GODOT_BRIDGE_SESSION_STALE_MS (milliseconds) when a host needs another value.
 */
export const SESSION_STALE_MS = positiveNumber(process.env.GODOT_BRIDGE_SESSION_STALE_MS, 15 * 60 * 1000)

function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/** Resolve the staleness window once, with an explicit override allowed. */
export function staleMsOf(value) {
  return positiveNumber(value, SESSION_STALE_MS)
}

function parseAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function iso(now) {
  return new Date(now).toISOString()
}

function stringOf(value) {
  return typeof value === 'string' ? value : ''
}

function ownerSessionOf(task) {
  return task !== null && task !== undefined && typeof task.ownerSession === 'string' && task.ownerSession !== '' ? task.ownerSession : null
}

/**
 * live / stale / unknown for ONE participating session.
 *
 * Evidence, in the order the requirement names it: the registry's lastSeenAt
 * (the session opened/worked on the project), the DSH session directory's newest
 * write (the session actually ran), and the lease of a card it owns (its worker
 * is inside its lease). live = any evidence inside the window; stale = evidence
 * exists but all of it is older; unknown = this host has never seen the session.
 */
export function sessionLivenessFrom(options) {
  const o = options === undefined || options === null ? {} : options
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const staleMs = staleMsOf(o.staleMs)
  const times = []
  const seen = parseAt(o.lastSeenAt)
  if (seen !== null) times.push(seen)
  const active = parseAt(o.lastActiveAt)
  if (active !== null) times.push(active)
  const lease = parseAt(o.leaseAt)
  if (lease !== null) times.push(lease)
  if (times.length === 0) return 'unknown'
  const newest = Math.max.apply(null, times)
  return now - newest <= staleMs ? 'live' : 'stale'
}

/** The compact team a session row carries: enough to answer "can it still run?". */
function teamViewOf(team) {
  const t = team === null || team === undefined ? {} : team
  return {
    available: t.available === true,
    ok: t.ok === true,
    lead: typeof t.lead === 'string' && t.lead !== '' ? t.lead : null,
    leadId: typeof t.leadId === 'string' && t.leadId !== '' ? t.leadId : null,
    leadSession: typeof t.leadSession === 'string' && t.leadSession !== '' ? t.leadSession : null,
    memberCount: Array.isArray(t.members) ? t.members.length : 0,
    missingRoles: Array.isArray(t.missingRoles) ? t.missingRoles.slice() : [],
    error: t.error === undefined || t.error === null ? null : String(t.error),
  }
}

/**
 * Build the handoff inventory for one project and one panel session.
 *
 * @param options.board - the normalised board read from disk.
 * @param options.sessions - the project's participating sessions (a SET, from
 *   state.projectSessionsFor(): { sessionId, firstSeenAt, lastSeenAt }).
 * @param options.sessionId - the panel session asking (null when none).
 * @param options.decisions - board.handoff.sessions (recorded decisions).
 * @param options.sessionActiveAtOf - (sessionId) => epoch-ms|null (DSH directory).
 * @param options.teamOf - (sessionId) => projectTeamState(...) for that team.
 * @param options.executorStatesOf - (task) => [{name, session, alive, status, phase}]
 *   the live executor and stage executor liveness of ONE card.
 *
 * Returns { required, reason, panelSession, decision, sessions, cards, eligibility }.
 * No primary session is chosen anywhere: every participant is listed equally.
 */
export function buildHandoff(options) {
  const o = options === undefined || options === null ? {} : options
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const staleMs = staleMsOf(o.staleMs)
  const panelSession = typeof o.sessionId === 'string' && o.sessionId !== '' ? o.sessionId : null
  const board = o.board !== null && o.board !== undefined ? o.board : { tasks: [] }
  const sessionList = Array.isArray(o.sessions) ? o.sessions.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.sessionId === 'string' && entry.sessionId !== '') : []
  const sessionActiveAtOf = typeof o.sessionActiveAtOf === 'function' ? o.sessionActiveAtOf : () => null
  const teamOf = typeof o.teamOf === 'function' ? o.teamOf : () => null
  const executorStatesOf = typeof o.executorStatesOf === 'function' ? o.executorStatesOf : () => []
  const decisions = o.decisions !== null && typeof o.decisions === 'object' ? o.decisions : {}
  const tasks = Array.isArray(board.tasks) ? board.tasks : []
  const activeTasks = tasks.filter((task) => task !== null && task !== undefined && HANDOFF_ACTIVE_STATUSES.indexOf(task.status) >= 0)
  const bySession = new Map()
  for (const entry of sessionList) bySession.set(entry.sessionId, entry)

  const rows = []
  for (const entry of sessionList) {
    const owned = activeTasks.filter((task) => ownerSessionOf(task) === entry.sessionId)
    const leases = owned
      .map((task) => parseAt(task.leaseUntil))
      .filter((value) => value !== null)
    const leaseAt = leases.length === 0 ? null : Math.max.apply(null, leases)
    const lastActiveAt = sessionActiveAtOf(entry.sessionId)
    const status = sessionLivenessFrom({ lastSeenAt: entry.lastSeenAt, lastActiveAt: lastActiveAt, leaseAt: leaseAt, now: now, staleMs: staleMs })
    const team = teamOf(entry.sessionId)
    const counts = { total: owned.length, active: owned.length, running: 0, reviewing: 0, testing: 0 }
    for (const task of owned) counts[task.status] += 1
    rows.push({
      sessionId: entry.sessionId,
      // live / stale / unknown. There is no ranking and no primary member.
      status: status,
      lastSeen: typeof entry.lastSeenAt === 'string' && entry.lastSeenAt !== '' ? entry.lastSeenAt : null,
      lastSeenAt: typeof entry.lastSeenAt === 'string' && entry.lastSeenAt !== '' ? entry.lastSeenAt : null,
      firstSeenAt: typeof entry.firstSeenAt === 'string' && entry.firstSeenAt !== '' ? entry.firstSeenAt : null,
      lastActiveAt: lastActiveAt === null ? null : iso(lastActiveAt),
      leaseAt: leaseAt === null ? null : iso(leaseAt),
      team: teamViewOf(team),
      cards: counts,
    })
  }
  const bySessionStatus = new Map(rows.map((row) => [row.sessionId, row]))

  // Every in-progress card owned by a DIFFERENT session is foreign. Own cards
  // never trigger a handoff: an old session coming back keeps working its own.
  const foreign = activeTasks.filter((task) => {
    const owner = ownerSessionOf(task)
    return owner !== null && owner !== panelSession
  })
  const cards = []
  for (const task of foreign) {
    const owner = ownerSessionOf(task)
    const executors = (executorStatesOf(task) || []).filter((entry) => entry !== null && typeof entry === 'object')
    const leases = executors.map((entry) => parseAt(entry.at)).filter((value) => value !== null)
    const leaseAt = parseAt(task.leaseUntil)
    cards.push({
      id: String(task.id),
      title: stringOf(task.title),
      status: String(task.status),
      ownerSession: owner,
      ownerStatus: bySessionStatus.has(owner) ? bySessionStatus.get(owner).status : 'unknown',
      liveExecutors: executors,
      // The lease answers "is the old claim still running?"; expiry alone is not
      // proof of death, executor liveness decides that (see eligibility).
      lease: {
        until: typeof task.leaseUntil === 'string' && task.leaseUntil !== '' ? task.leaseUntil : null,
        expired: leaseAt === null ? true : leaseAt <= now,
        remainingMs: leaseAt === null ? 0 : Math.max(0, leaseAt - now),
        executorAt: leases.length === 0 ? null : iso(Math.max.apply(null, leases)),
      },
      mergeOpen: task.merge !== null && task.merge !== undefined && task.merge.status === 'open',
      review: task.review === null || task.review === undefined ? null : { status: task.review.status, attempt: task.review.attempt === undefined ? null : task.review.attempt },
      test: task.test === null || task.test === undefined ? null : { status: task.test.status, attempt: task.test.attempt === undefined ? null : task.test.attempt },
      waitingReason: task.waitingReason === undefined || task.waitingReason === null ? null : String(task.waitingReason),
    })
  }

  // Eligibility is per card and never optimistic: a live owner or a live
  // executor blocks takeover of that card (the host must not steal a lock).
  const blocked = []
  for (const card of cards) {
    if (card.ownerStatus === 'live') blocked.push({ taskId: card.id, reason: 'owning-session-live' })
    const alive = card.liveExecutors.filter((entry) => entry.alive === true)
    for (const entry of alive) blocked.push({ taskId: card.id, reason: 'executor-alive', executor: entry.name === undefined ? null : entry.name, phase: entry.phase === undefined ? null : entry.phase })
  }
  const eligibleIds = cards.filter((card) => blocked.every((entry) => entry.taskId !== card.id)).map((card) => card.id)
  const liveForeignSessions = rows.filter((row) => row.status === 'live' && foreign.some((task) => ownerSessionOf(task) === row.sessionId)).map((row) => row.sessionId)
  const decision = panelSession !== null && decisions[panelSession] !== undefined && decisions[panelSession] !== null ? decisions[panelSession] : null

  return {
    required: cards.length > 0,
    reason: cards.length > 0 ? 'foreign-active-tasks' : null,
    panelSession: panelSession,
    decision: decision,
    sessions: rows,
    cards: cards,
    eligibility: {
      // The ONLY way to move a card: every foreign card's owner is stale/unknown
      // AND none of its executors (worker/reviewer/tester) is alive.
      takeover: { ok: cards.length > 0 && blocked.length === 0, taskIds: eligibleIds, blockedBy: blocked },
      resume: { ok: liveForeignSessions.length > 0, sessions: liveForeignSessions },
      readOnly: { ok: true },
    },
  }
}

/** The single next-step code a handoff inventory implies (priority order). */
export function handoffNextCode(handoff) {
  if (handoff === null || handoff === undefined || handoff.required !== true) return null
  if (handoff.decision !== null && handoff.decision !== undefined) return null
  const eligibility = handoff.eligibility === undefined || handoff.eligibility === null ? {} : handoff.eligibility
  const takeover = eligibility.takeover !== undefined && eligibility.takeover !== null ? eligibility.takeover : {}
  const resume = eligibility.resume !== undefined && eligibility.resume !== null ? eligibility.resume : {}
  if (resume.ok === true) return 'resume-owning-session'
  if (takeover.ok === true) return 'takeover-active-tasks'
  return 'join-project-read-only'
}

/** The cards a takeover would move (explicit ids restricted to the eligible set). */
export function takeoverTargetIds(handoff, requested) {
  const eligibility = handoff !== null && handoff !== undefined && handoff.eligibility !== null && handoff.eligibility !== undefined ? handoff.eligibility.takeover : null
  if (eligibility === null || eligibility === undefined) return []
  const eligible = Array.isArray(eligibility.taskIds) ? eligibility.taskIds : []
  const asked = Array.isArray(requested) ? requested.map((entry) => String(entry)) : []
  if (asked.length === 0) return eligible.slice()
  return asked.filter((id) => eligible.indexOf(id) >= 0)
}

/**
 * Apply a takeover to a board: move exactly the eligible cards to the deciding
 * session, with an audit row naming both sessions and what the host did.
 *
 * Per status (T-153 §4):
 *   running   — release the stale claim (lease/assignee/executors retired), keep
 *               worktree/branch/base/commit/actualFiles for the next attempt,
 *               and NEVER touch attempts (a handoff is not a failure);
 *   reviewing — keep the review record (an approval stays approved), re-queue the
 *               delivered-to slot so the takeover session's reviewer gets it;
 *   testing   — keep the candidate checkout and the passed test record, re-queue
 *               the tester slot;
 *   merge open — the merge record is untouched: the host queue owns it.
 *
 * The board is cloned; the caller writes it through the normal CAS path.
 */
export function applyTakeover(board, options) {
  const o = options === undefined || options === null ? {} : options
  const toSession = typeof o.toSession === 'string' ? o.toSession : ''
  if (toSession === '') return { ok: false, code: 'no-session', message: 'takeover needs the session taking the cards' }
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const by = typeof o.by === 'string' && o.by !== '' ? o.by : 'user'
  const byName = typeof o.byName === 'string' && o.byName !== '' ? o.byName : null
  const reason = typeof o.reason === 'string' && o.reason !== '' ? o.reason : 'user confirmed takeover of stale in-progress cards'
  const requested = Array.isArray(o.taskIds) ? o.taskIds.map((entry) => String(entry)) : []
  const next = JSON.parse(JSON.stringify(board))
  const moved = []
  const released = []
  for (const task of next.tasks) {
    if (requested.length > 0 && requested.indexOf(String(task.id)) < 0) continue
    if (HANDOFF_ACTIVE_STATUSES.indexOf(task.status) < 0) continue
    const fromSession = ownerSessionOf(task)
    if (fromSession === toSession) continue
    const fromStatus = task.status
    let executorAction = null
    let lockAction = null
    if (task.status === 'running') {
      // Release the stale claim completely. The EXECUTOR ledger is retired so a
      // later roster check can never call it live; the worktree fields stay, so
      // the next attempt adopts the same checkout (attempt slot still > 1).
      task.lastAssignee = task.assignee === null || task.assignee === undefined ? task.lastAssignee || null : Object.assign({}, task.assignee)
      task.assignee = null
      task.leaseUntil = null
      task.status = 'pending'
      const executors = Array.isArray(task.executors) ? task.executors : []
      task.executors = executors.map((entry) =>
        entry !== null && typeof entry === 'object' && (entry.retiredAt === null || entry.retiredAt === undefined)
          ? Object.assign({}, entry, { retiredAt: iso(now), retiredReason: 'handoff to ' + toSession })
          : entry,
      )
      task.dispatch = Object.assign({}, task.dispatch === null || task.dispatch === undefined ? {} : task.dispatch, {
        status: 'handoff',
        error: null,
        at: iso(now),
      })
      executorAction = 'released stale lease; retired the old executor; worktree/branch/commit kept for the next attempt'
      lockAction = 'write locks released'
      released.push(String(task.id))
    } else if (task.status === 'reviewing') {
      // An APPROVED round is a verdict, not work: keep it and never re-deliver a
      // second review brief. Only an open round goes back in the queue.
      const pending = task.review !== null && task.review !== undefined && task.review.status === 'pending'
      if (pending) task.review = Object.assign({}, task.review, { deliveredTo: null })
      executorAction = pending
        ? 'open review round re-queued for the takeover session; approved rounds are kept'
        : 'approved review record kept (no second review brief); reviewer re-provisioned for the owner'
      lockAction = 'no write lock held in review'
    } else {
      const pending = task.test !== null && task.test !== undefined && task.test.status === 'pending'
      if (pending) task.test = Object.assign({}, task.test, { deliveredTo: null })
      executorAction = pending
        ? 'open test round re-queued for the takeover session; the candidate checkout is kept'
        : 'passed test record kept (no re-test brief); tester re-provisioned for the owner'
      lockAction = 'no write lock held in testing'
    }
    task.ownerSession = toSession
    task.updatedAt = iso(now)
    const history = Array.isArray(task.history) ? task.history : []
    task.history = history.concat([
      {
        at: iso(now),
        by: by,
        byName: byName,
        from: fromStatus,
        to: task.status,
        note:
          'handoff: ' + String(fromSession) + ' -> ' + toSession + ' (' + reason + ')' +
          (task.merge !== null && task.merge !== undefined && task.merge.status === 'open' ? '; merge request untouched (host queue)' : ''),
        fromSession: fromSession,
        toSession: toSession,
        reason: reason,
        executorAction: executorAction,
        lockAction: lockAction,
      },
    ])
    moved.push({ id: String(task.id), fromStatus: fromStatus, status: task.status, fromSession: fromSession, toSession: toSession })
  }
  if (moved.length === 0) return { ok: false, code: 'no-takeover-targets', message: 'none of the requested cards is an eligible in-progress card owned by another session' }
  const handoff = next.handoff !== null && next.handoff !== undefined && typeof next.handoff === 'object' ? next.handoff : { version: 1, sessions: {} }
  next.handoff = {
    version: 1,
    sessions: Object.assign({}, handoff.sessions === undefined || handoff.sessions === null ? {} : handoff.sessions, {
      [toSession]: { mode: 'takeover', at: iso(now), by: by, byName: byName, reason: reason, taskIds: moved.map((entry) => entry.id) },
    }),
  }
  return { ok: true, board: next, moved: moved, released: released }
}

/** Record a "join read-only" (or any non-mutating) decision for one session. */
export function recordHandoffDecision(board, options) {
  const o = options === undefined || options === null ? {} : options
  const sessionId = typeof o.sessionId === 'string' ? o.sessionId : ''
  const mode = HANDOFF_DECISIONS.indexOf(o.mode) >= 0 ? o.mode : null
  if (sessionId === '' || mode === null) return { ok: false, code: 'invalid-decision', message: 'a handoff decision needs a session and a known mode' }
  const now = Number.isFinite(o.now) ? o.now : Date.now()
  const next = JSON.parse(JSON.stringify(board))
  const handoff = next.handoff !== null && next.handoff !== undefined && typeof next.handoff === 'object' ? next.handoff : { version: 1, sessions: {} }
  next.handoff = {
    version: 1,
    sessions: Object.assign({}, handoff.sessions === undefined || handoff.sessions === null ? {} : handoff.sessions, {
      [sessionId]: {
        mode: mode,
        at: iso(now),
        by: typeof o.by === 'string' && o.by !== '' ? o.by : 'user',
        byName: typeof o.byName === 'string' && o.byName !== '' ? o.byName : null,
        reason: typeof o.reason === 'string' && o.reason !== '' ? o.reason : null,
        taskIds: Array.isArray(o.taskIds) ? o.taskIds.map((entry) => String(entry)) : [],
      },
    }),
  }
  return { ok: true, board: next, decision: next.handoff.sessions[sessionId] }
}

export { ownerSessionOf }
