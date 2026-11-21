/**
 * Task workflow's role/agent lifecycle.
 *
 * A task's executor is not a team member and has no persistent slot. A worker
 * is started with the task, a reviewer/tester is started for one stage, and
 * every handle is released when the stage ends. Agent ids are the only routing
 * identity; the name is a readable label for the UI.
 *
 * T-183: DSH reserves a child name for a whole root tree, even after that child
 * went inactive. A fixed name (worker-<taskId>[-attempt]) therefore poisoned
 * every later dispatch of the same card: reopen/unblock reset attempts to 1 and
 * the new worker reused the old name, which DSH refused with
 * DUPLICATE_AGENT_NAME. Every spawn now carries a generation suffix that is
 * unique for that spawn while the readable role-<taskId> prefix stays.
 *
 * Bindings are also no longer memory-only. The activation receipt is retained in
 * a process-wide registry, so a release that happens after the plugin reloaded
 * (and the per-root handle map went away) can still dispose the exact child by
 * id or by the name the agent tree reports. Without a receipt the child cannot
 * be disposed (disposal is a capability of the receipt), so the best possible
 * fallback is an interrupt, reported honestly as "interrupted" and never as
 * released.
 */

export const TASK_ROLES = Object.freeze(['worker', 'reviewer', 'tester'])

const NAME_MAX = 32
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const NAME_TOKEN_MAX = 12
const AUTO_TOKEN_LENGTH = 8
const DUPLICATE_NAME_RETRIES = 4

/** Process-local salt: a reloaded module must not restart the suffix series. */
const PROCESS_SALT = (function salt() {
  const text = Math.random().toString(36).replace(/[^a-z0-9]+/g, '')
  return text.slice(-2).padEnd(2, '0')
})()

/** Monotonic per-process spawn counter, so two spawns never share a token. */
let generationSequence = 0

function nextGeneration() {
  generationSequence += 1
  // The counter is the uniqueness guarantee; the clock keeps a reloaded module
  // from walking into the same series and the salt covers a fresh process.
  const clock = Date.now().toString(36).slice(-3)
  const sequence = generationSequence.toString(36)
  return (clock + sequence + PROCESS_SALT).slice(-AUTO_TOKEN_LENGTH).padStart(AUTO_TOKEN_LENGTH, '0')
}

function nameToken(value) {
  const text = String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, NAME_TOKEN_MAX)
  return text === '' ? nextGeneration() : text
}

function slug(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18)
}

/**
 * A DSH subagent name: lower-case letters/digits/hyphens, at most 32 chars.
 *
 * The generation suffix is what makes a re-dispatch possible; the readable
 * worker/reviewer/tester-<taskId> prefix is kept. Passing an explicit generation
 * keeps the function pure for a caller that already chose one; omitting it mints
 * a fresh token.
 */
export function agentNameFor(role, taskId, generation) {
  const kind = TASK_ROLES.indexOf(role) >= 0 ? role : 'worker'
  const token = generation === undefined || generation === null || generation === '' ? nextGeneration() : nameToken(generation)
  const suffix = '-' + token
  const budget = Math.max(1, NAME_MAX - kind.length - 1 - suffix.length)
  const slugged = slug(taskId)
  let id = (slugged === '' ? 'task' : slugged).slice(0, budget).replace(/-+$/g, '')
  if (id === '') id = 'task'.slice(0, budget)
  let name = kind + '-' + id + suffix
  if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).replace(/-+$/g, '')
  if (NAME_PATTERN.test(name)) return name
  // Defensive: a token made of something exotic must never yield an invalid or
  // non-unique name.
  const fallback = kind + '-task-' + nextGeneration()
  return NAME_PATTERN.test(fallback) ? fallback : 'worker-task'
}

function normaliseRoles(roles) {
  const list = Array.isArray(roles) ? roles : TASK_ROLES
  const out = []
  for (const role of list) {
    if (TASK_ROLES.indexOf(role) >= 0 && out.indexOf(role) < 0) out.push(role)
  }
  return out.length === 0 ? TASK_ROLES.slice() : out
}

/**
 * Does an agent name belong to this task in this role?
 *
 * The id part inside a generated name is the task slug TRIMMED to that name's
 * generation length, so the only safe test is to rebuild the name with the token
 * parsed out of it. Comparing raw prefixes would let task T-1 claim the agents
 * of T-1-extra.
 */
function taskRoleOfAgentName(name, roles, taskId) {
  if (typeof name !== 'string' || name === '') return null
  const slugged = slug(taskId)
  const plain = slugged === '' ? 'task' : slugged
  for (const role of roles) {
    if (name.indexOf(role + '-') !== 0) continue
    const rest = name.slice(role.length + 1)
    // A pre-generation name (worker-t-1) is still recognised for the same task.
    if (rest === plain) return role
    const cut = rest.lastIndexOf('-')
    if (cut <= 0) continue
    const token = rest.slice(cut + 1)
    if (token === '') continue
    if (agentNameFor(role, taskId, token) === name) return role
  }
  return null
}

/**
 * T-214: the directory a stage child's shell must start in.
 *
 * A worker/reviewer owns the card's worktree, so an explicit `cwd` wins and the
 * task's own `worktree` is the only fallback. A tester has no worktree of its
 * own: its correct directory is the test CANDIDATE the caller built from the
 * target head, so it NEVER falls back to the task worktree (and never to the
 * main checkout). A missing path is not guessed: no `cwd` is passed at all.
 */
function spawnCwdFor(role, task, input) {
  const requested = input === undefined || input === null ? {} : input
  if (typeof requested.cwd === 'string' && requested.cwd.trim() !== '') return requested.cwd.trim()
  if (role === 'tester') return null
  const worktree = task !== null && task !== undefined && typeof task === 'object' ? task.worktree : undefined
  return typeof worktree === 'string' && worktree.trim() !== '' ? worktree.trim() : null
}

/** A duplicate-name refusal as thrown by the DSH subagent manager. */
function isDuplicateNameError(error) {
  let current = error
  for (let depth = 0; current !== null && current !== undefined && typeof current === 'object' && depth < 6; depth += 1) {
    const code = typeof current.code === 'string' ? current.code : ''
    if (code === 'DUPLICATE_AGENT_NAME' || code === 'AGENT_NAME_DUPLICATE') return true
    const message = typeof current.message === 'string' ? current.message : ''
    if (/DUPLICATE_AGENT_NAME|already used by another subagent|name already used|is already used/i.test(message)) return true
    current = current.cause
  }
  return false
}

/**
 * Process-wide activation receipts, keyed by child Session id.
 *
 * Deliberately module scope, not per createTaskAgents() instance: the plugin row
 * can be reloaded (new registry/runtime objects) while the child Agents stay
 * alive, and disposal must still reach them.
 */
const activations = new Map()

async function disposeReceipt(agentId) {
  const id = String(agentId)
  const record = activations.get(id)
  if (record === undefined) return 'missing'
  try {
    await record.dispose()
    activations.delete(id)
    return 'released'
  } catch (error) {
    return 'error'
  }
}

/**
 * Release one activation by its Session id without needing the per-root handle
 * map. Used by the stage service as the last resort after a plugin reload.
 */
export async function releaseAgent(agentId) {
  if (typeof agentId !== 'string' || agentId === '') return false
  return (await disposeReceipt(agentId)) === 'released'
}

/**
 * T-221: the live agent tree is a LAST-RESORT source of ids, and reading it is
 * bounded, memoised and single-flighted.
 *
 * The catalog read is O(tree). On a long-lived host with hundreds of children it
 * took minutes (>120 s, 45 s, 30 s in one incident), and a release that fell back
 * to it held the whole merge queue: refreshMerge ran inside a queue unit, the unit
 * was abandoned with 'queue-timeout', and the release kept waiting on a scan it
 * did not need. A release now uses the EXACT ids the board recorded and the
 * in-process activation receipts, and only reads the tree when those cannot name
 * a child for a requested role — once, bounded, and never past its caller's
 * patience. A timed-out read is reported as AGENT_LIST_TIMEOUT_CODE and never
 * blocks the release itself.
 */
export const AGENT_LIST_TIMEOUT_MS = 2500
export const AGENT_LIST_CACHE_MS = 2500
export const AGENT_LIST_TIMEOUT_CODE = 'agent-list-timeout'
export const AGENT_LIST_FAILED_CODE = 'agent-list-failed'

const LIST_TIMED_OUT = Symbol('agent-list-timeout')

/** rootId -> { at, rows, timedOut, code } — the last answer, reused for one window. */
const agentListCache = new Map()
/** Roots kept memoised. A long-lived host cycles sessions; the map must not grow. */
const AGENT_LIST_CACHE_MAX = 32
/** rootId -> in-flight read, so concurrent releases share ONE host call. */
const agentListFlights = new Map()

/** Process-wide cache control (tests, and a host that wants a fresh read). */
export function forgetAgentListCache(rootId) {
  if (typeof rootId === 'string' && rootId !== '') {
    agentListCache.delete('root:' + rootId)
    return true
  }
  agentListCache.clear()
  return true
}

function listRootKey(runtime) {
  const rootId = runtime !== null && runtime !== undefined && typeof runtime.rootId === 'string' && runtime.rootId !== '' ? runtime.rootId : ''
  return rootId === '' ? 'root:*' : 'root:' + rootId
}

function listBounds(options) {
  const opts = options === undefined || options === null ? {} : options
  return {
    timeoutMs: Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : AGENT_LIST_TIMEOUT_MS,
    cacheMs: Number.isFinite(opts.cacheMs) ? Math.max(0, Math.floor(opts.cacheMs)) : AGENT_LIST_CACHE_MS,
    signal: opts.signal,
    fresh: opts.fresh === true,
  }
}

function listRowId(row) {
  if (row === null || row === undefined) return null
  const id = row.id !== undefined ? row.id : row.sessionId
  return id === undefined || id === null || String(id) === '' ? null : String(id)
}

/** Memoise one answer, dropping the oldest root when the map is at its bound. */
function rememberAgentRows(key, entry) {
  agentListCache.set(key, entry)
  while (agentListCache.size > AGENT_LIST_CACHE_MAX) {
    const oldest = agentListCache.keys().next()
    if (oldest === undefined || oldest.done === true) break
    agentListCache.delete(oldest.value)
  }
}

/** Drop just-released ids from the memoised rows so they cannot be rediscovered. */
function forgetCachedListRows(key, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return
  const cached = agentListCache.get(key)
  if (cached === undefined || Array.isArray(cached.rows) !== true) return
  cached.rows = cached.rows.filter((row) => {
    const id = listRowId(row)
    return id === null || ids.indexOf(id) < 0
  })
}

/**
 * The live tree of one root: cached for one short window, single-flighted while a
 * read is in flight, and bounded — a hung catalog answers { timedOut: true }
 * instead of holding the caller.
 */
function readAgentRows(runtime, options) {
  const bounds = listBounds(options)
  const key = listRootKey(runtime)
  if (bounds.fresh !== true) {
    const cached = agentListCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < bounds.cacheMs) {
      return Promise.resolve({ rows: Array.isArray(cached.rows) ? cached.rows : [], cached: true, timedOut: cached.timedOut === true, code: cached.code })
    }
  }
  const flight = agentListFlights.get(key)
  if (flight !== undefined) return flight
  const promise = (async function () {
    let timer = null
    const timeout = new Promise(function (resolveTimeout) {
      timer = setTimeout(function () {
        resolveTimeout(LIST_TIMED_OUT)
      }, bounds.timeoutMs)
    })
    let value = null
    try {
      value = await Promise.race([
        Promise.resolve().then(function () {
          return runtime.list(bounds.signal)
        }),
        timeout,
      ])
    } catch (error) {
      value = { __listError: error }
    }
    if (timer !== null) clearTimeout(timer)
    if (value === LIST_TIMED_OUT) {
      // A negative cache too: consecutive releases on a hung host must not each
      // wait the full bound for the same unanswered read.
      const previous = agentListCache.get(key)
      const rows = previous !== undefined && Array.isArray(previous.rows) ? previous.rows : []
      rememberAgentRows(key, { at: Date.now(), rows: rows, timedOut: true, code: AGENT_LIST_TIMEOUT_CODE })
      return { rows: rows, cached: false, timedOut: true, code: AGENT_LIST_TIMEOUT_CODE }
    }
    if (value !== null && typeof value === 'object' && value.__listError !== undefined) {
      // An error is NOT memoised: the next fallback may succeed.
      return { rows: [], cached: false, timedOut: false, code: AGENT_LIST_FAILED_CODE }
    }
    const rows = Array.isArray(value) ? value : []
    // A FRESH reader (the deferred-release watcher, which must see a turn end in
    // the same window) never memoises its answer: only a discovery read may reuse
    // one within the window.
    if (bounds.fresh !== true) rememberAgentRows(key, { at: Date.now(), rows: rows, timedOut: false, code: null })
    return { rows: rows, cached: false, timedOut: false, code: null }
  })()
  agentListFlights.set(key, promise)
  const settle = function () {
    if (agentListFlights.get(key) === promise) agentListFlights.delete(key)
  }
  promise.then(settle, settle)
  return promise
}

/**
 * The rows the deferred-release watcher reads: bounded like every other tree read.
 * A read it cannot get throws, which the watcher already treats as "cannot tell"
 * (the child keeps waiting, it is never disposed on a guess).
 */
async function releaseWatchRows(runtime, options) {
  const read = await readAgentRows(runtime, options)
  if (read.timedOut === true) {
    const error = new Error('the live agent tree did not answer in time')
    error.code = AGENT_LIST_TIMEOUT_CODE
    throw error
  }
  return read.rows
}

/**
 * T-185: a self-release is never immediate.
 *
 * A verdict action (approveReview/requestChanges/passTest/failTest) runs inside
 * the reviewer/tester's own turn. Disposing that activation while the action is
 * still in flight kills the turn before its tool result is delivered: the agent
 * never comes back, the card has already moved on and the child stays "running"
 * forever (T-181). Such a release is queued here and retired later, by the host
 * reconciler, only once the turn that owns the call is over:
 *
 *   - while the live tree still reports the child as running, wait;
 *   - an inactive (or gone) child has finished its turn, so dispose it;
 *   - after a bounded wait the child is interrupted first and disposed only
 *     after the grace window — an active activation is never disposed bare.
 */
export const DEFERRED_RELEASE_MAX_WAIT_MS = 120 * 1000
export const DEFERRED_RELEASE_GRACE_MS = 5 * 1000
const deferredReleasesById = new Map()

/**
 * Queue one self-release. The disposal/interrupt/list capabilities come from the
 * caller when it has them (a live task-agent instance) and fall back to the
 * process-wide activation receipt (a release queued across a plugin reload).
 *
 * Returns the entry, or null when this process holds no capability at all — in
 * that case nothing is disposed, which is exactly the required behaviour.
 */
export function deferReleaseAgent(agentId, options) {
  const opts = options === undefined || options === null ? {} : options
  const id = String(agentId === undefined || agentId === null ? '' : agentId)
  if (id === '' || id === 'undefined' || id === 'null') return null
  const existing = deferredReleasesById.get(id)
  if (existing !== undefined) return existing
  const receipt = activations.get(id)
  const dispose =
    typeof opts.dispose === 'function' ? opts.dispose : receipt !== undefined && typeof receipt.dispose === 'function' ? receipt.dispose : null
  if (dispose === null) return null
  const entry = {
    agentId: id,
    taskId: typeof opts.taskId === 'string' && opts.taskId !== '' ? opts.taskId : null,
    rootId: typeof opts.rootId === 'string' && opts.rootId !== '' ? opts.rootId : null,
    reason: typeof opts.reason === 'string' && opts.reason !== '' ? opts.reason : 'self-release',
    since: Number.isFinite(opts.now) ? opts.now : Date.now(),
    // T-185 review round 1: the bounded wait starts only when the verdict action
    // that queued this release has RETURNED. A passTest merge/rebuild or an
    // approveReview candidate discard can legitimately run for minutes; while it
    // is in flight the caller must never be interrupted or disposed.
    returnedAt: null,
    interruptedAt: null,
    attempts: 0,
    dispose: dispose,
    listRows:
      typeof opts.listRows === 'function'
        ? opts.listRows
        : receipt !== undefined && typeof receipt.listRows === 'function'
          ? receipt.listRows
          : null,
    interrupt:
      typeof opts.interrupt === 'function'
        ? opts.interrupt
        : receipt !== undefined && typeof receipt.interrupt === 'function'
          ? receipt.interrupt
          : null,
  }
  deferredReleasesById.set(id, entry)
  return entry
}

/**
 * Arm a queued self-release: the action that queued it calls this from its own
 * `finally`, i.e. only once it is about to return its tool result. Until then
 * the reaper reports the entry as in flight and never touches the caller.
 */
export function markDeferredReleaseReturned(agentId, options) {
  const opts = options === undefined || options === null ? {} : options
  const id = String(agentId === undefined || agentId === null ? '' : agentId)
  if (id === '') return false
  const entry = deferredReleasesById.get(id)
  if (entry === undefined) return false
  if (entry.returnedAt === null) entry.returnedAt = Number.isFinite(opts.now) ? opts.now : Date.now()
  return true
}

/** The ids queued for a deferred self-release (diagnostics and tests). */
export function deferredReleaseIds() {
  return Array.from(deferredReleasesById.keys())
}

/** Drop a queued self-release without disposing (tests, abandoned cards). */
export function forgetDeferredRelease(agentId) {
  return deferredReleasesById.delete(String(agentId))
}

async function activityOfDeferredEntry(entry) {
  if (typeof entry.listRows !== 'function') return 'unknown'
  try {
    const rows = await entry.listRows()
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row === null || row === undefined) continue
      const id = row.id !== undefined ? row.id : row.sessionId
      if (String(id) !== entry.agentId) continue
      return row.activity === 'running' || row.status === 'running' ? 'running' : 'inactive'
    }
    // The catalog keeps inactive children; an id it no longer lists cannot be
    // running any more.
    return 'inactive'
  } catch (error) {
    return 'unknown'
  }
}

async function retireDeferredEntry(entry) {
  // The deferred closures wrap disposeById(), which reports a failed teardown as
  // the string 'error' instead of throwing. A non-throwing call is therefore NOT
  // proof of release (T-185 review round 1): only true/'released'/'missing' end
  // the entry, false/'error'/a throw keeps it queued for a bounded retry.
  let outcome = null
  try {
    outcome = await entry.dispose()
  } catch (error) {
    outcome = 'error'
  }
  if (outcome === false || outcome === 'error') {
    // Keep the entry and retry: a failed teardown is not a release, and dropping
    // the only record of the child would turn it into an untracked zombie.
    entry.attempts += 1
    return 'failed'
  }
  deferredReleasesById.delete(entry.agentId)
  return outcome === 'missing' ? 'missing' : 'released'
}

/**
 * Retire every queued self-release whose turn has ended. Called by the host tick
 * and by the agent/status event; the action that queued an entry never disposes
 * the caller itself.
 */
export async function reapDeferredReleases(options) {
  const opts = options === undefined || options === null ? {} : options
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? Math.max(0, opts.maxWaitMs) : DEFERRED_RELEASE_MAX_WAIT_MS
  const graceMs = Number.isFinite(opts.graceMs) ? Math.max(0, opts.graceMs) : DEFERRED_RELEASE_GRACE_MS
  const report = []
  for (const entry of Array.from(deferredReleasesById.values())) {
    // The owning action is still running: nothing may be interrupted/disposed,
    // however long it takes (a passTest merge can outlive every budget here).
    if (entry.returnedAt === null) {
      report.push({ agentId: entry.agentId, taskId: entry.taskId, activity: null, outcome: 'in-flight' })
      continue
    }
    const activity = await activityOfDeferredEntry(entry)
    if (activity === 'running' || activity === 'unknown') {
      if (now - entry.returnedAt < maxWaitMs) {
        report.push({ agentId: entry.agentId, taskId: entry.taskId, activity: activity, outcome: 'waiting' })
        continue
      }
      // The turn overran its bound: stop it, then give it the grace window
      // before the activation is disposed.
      if (entry.interruptedAt === null) {
        if (typeof entry.interrupt === 'function') {
          try {
            entry.interrupt()
          } catch (error) {}
        }
        entry.interruptedAt = now
        report.push({ agentId: entry.agentId, taskId: entry.taskId, activity: activity, outcome: 'interrupted' })
        continue
      }
      if (now - entry.interruptedAt < graceMs) {
        report.push({ agentId: entry.agentId, taskId: entry.taskId, activity: activity, outcome: 'grace' })
        continue
      }
    }
    report.push({ agentId: entry.agentId, taskId: entry.taskId, activity: activity, outcome: await retireDeferredEntry(entry) })
  }
  return report
}

/**
 * @param {object} options
 * @param {object} options.runtime createAgentRuntime result
 */
export function createTaskAgents(options) {
  const opts = options === undefined || options === null ? {} : options
  const runtime = opts.runtime
  if (runtime === null || runtime === undefined || runtime.available !== true) {
    const error = new Error('task agents need an available agent runtime')
    error.code = 'agent-runtime-unavailable'
    throw error
  }
  const handles = new Map()
  // T-221: bounds of the last-resort tree read. Instance options so a host (and
  // a test) can tighten them; a per-release option still wins.
  const listTimeoutMs = Number.isFinite(opts.listTimeoutMs) ? Math.max(1, Math.floor(opts.listTimeoutMs)) : AGENT_LIST_TIMEOUT_MS
  const listCacheMs = Number.isFinite(opts.listCacheMs) ? Math.max(0, Math.floor(opts.listCacheMs)) : AGENT_LIST_CACHE_MS

  /**
   * T-204: one live child per role and card.
   *
   * Before a new worker/reviewer/tester is spawned for a card, release every
   * child of that role the card still has. The discovery inside releaseTask
   * merges the board's own records with the live agent tree, so a previous
   * reviewer/tester whose deliveredTo was replaced (refreshMerge, a takeover
   * that cleared the record, a re-submit) is still found by its name and stopped
   * instead of running behind the new one. A child that cannot be stopped at all
   * blocks the spawn: doubling up is never the fallback.
   */
  async function releaseRoleBeforeSpawn(role, task, options) {
    // The invariant this module owns is the STAGE roster: one live reviewer and
    // one live tester per card. A worker slot belongs to the dispatcher's
    // claim/lease machinery, so a worker spawn must not sweep it.
    if (role !== 'reviewer' && role !== 'tester') return null
    const spawnOptions = options === undefined || options === null ? {} : options
    const input = typeof task === 'string' ? { id: task } : task === undefined || task === null ? {} : task
    const blocked = []
    let swept = null
    try {
      swept = await releaseTask(input, { roles: [role], reason: 'replacing the previous ' + role, signal: spawnOptions.signal })
    } catch (error) {
      // A sweep that could not run is not proof the previous child is gone:
      // refuse the spawn instead of risking a second live stage child.
      blocked.push('release-failed')
    }
    if (swept !== null) {
      for (const entry of Array.isArray(swept.failed) ? swept.failed : []) blocked.push(String(entry.agentId))
      for (const entry of Array.isArray(swept.unresolved) ? swept.unresolved : []) blocked.push(String(entry.agentId))
    }
    if (blocked.length > 0) {
      const error = new Error('the previous ' + role + ' (' + blocked.join(', ') + ') could not be stopped; refusing to start a second one')
      error.code = 'stage-child-still-live'
      error.agentIds = blocked
      throw error
    }
    return swept
  }

  async function start(role, task, prompt, extra) {
    const input = extra === undefined || extra === null ? {} : extra
    // T-204: the previous child of this role must be gone BEFORE a new one
    // exists, so a card can never have two live reviewers (or testers).
    await releaseRoleBeforeSpawn(role, task, input)
    const taskId = task !== null && task !== undefined && task.id !== undefined ? task.id : 'task'
    // T-214: launch the child in the directory its stage may write to. A missing
    // path passes NO cwd (never the main project root as a guessed fallback).
    const cwd = spawnCwdFor(role, task, input)
    let generation = nextGeneration()
    let name = agentNameFor(role, taskId, generation)
    let attempt = 0
    let handle = null
    while (handle === null) {
      try {
        const request = {
          role: role,
          taskId: taskId,
          name: name,
          label: role + ' ' + String(taskId),
          prompt: prompt,
          signal: input.signal,
        }
        if (cwd !== null) request.cwd = cwd
        handle = await runtime.spawn(request)
      } catch (error) {
        attempt += 1
        // A name the host already reserved for this root (an older inactive
        // child, another plugin instance, a reload) is recoverable: mint a new
        // generation and try again. Any other failure is real.
        if (attempt >= DUPLICATE_NAME_RETRIES || isDuplicateNameError(error) !== true) throw error
        generation = nextGeneration()
        name = agentNameFor(role, taskId, generation)
      }
    }
    const agentId = String(handle.agentId)
    handles.set(agentId, handle)
    // T-221: a spawn changes tree membership; a memoised fallback read from
    // before this child existed must not hide it by name.
    forgetAgentListCache(typeof runtime.rootId === 'string' ? runtime.rootId : null)
    activations.set(agentId, {
      agentId: agentId,
      name: typeof handle.name === 'string' && handle.name !== '' ? handle.name : name,
      role: role,
      taskId: String(taskId),
      // Task ids are project-scoped: two projects in one host can both own a
      // "T-1". The root keeps a release from reaching the other project's child.
      rootId: runtime.rootId === undefined ? null : runtime.rootId,
      generation: generation,
      dispose: function () {
        return handle.dispose()
      },
      // T-185: the deferred self-release reconciler must be able to watch this
      // child's turn and, after the bounded wait, interrupt it before disposing.
      // T-221: that watch is a bounded, fresh tree read; a hung catalog can no
      // longer stall the host reconciler that retires these children.
      listRows: function () {
        return releaseWatchRows(runtime, { timeoutMs: listTimeoutMs, fresh: true })
      },
      interrupt: function () {
        return interruptQuietly(agentId)
      },
    })
    return { agentId: agentId, name: handle.name === null ? name : handle.name, role: role, handle: handle, generation: generation }
  }

  async function send(agentId, text, options) {
    return runtime.send(agentId, text, options)
  }

  /** Dispose one child and report whether it was really released. */
  async function disposeById(agentId) {
    const id = String(agentId)
    const handle = handles.get(id)
    const receipt = activations.get(id)
    if (handle === undefined && receipt === undefined) return 'missing'
    const dispose = receipt !== undefined
      ? function () { return receipt.dispose() }
      : handle !== undefined && typeof handle.dispose === 'function'
        ? function () { return handle.dispose() }
        : null
    if (dispose === null) {
      handles.delete(id)
      return 'missing'
    }
    try {
      await dispose()
      handles.delete(id)
      activations.delete(id)
      return 'released'
    } catch (error) {
      // Keep both registrations: a later release/sweep must be able to retry.
      return 'error'
    }
  }

  async function release(agentId, options) {
    if (agentId === undefined || agentId === null || String(agentId) === '') return false
    const id = String(agentId)
    const releaseOptions = options === undefined || options === null ? {} : options
    const callerAgentId =
      typeof releaseOptions.callerAgentId === 'string' && releaseOptions.callerAgentId !== '' ? releaseOptions.callerAgentId : null
    // T-185: the agent waiting for this very action's tool result is never
    // disposed here; the self-release is queued for the reconciler instead.
    if (callerAgentId !== null && callerAgentId === id) {
      deferReleaseAgent(id, {
        taskId: releaseOptions.taskId,
        rootId: releaseOptions.rootId,
        reason: releaseOptions.reason,
        dispose: function () {
          return disposeById(id)
        },
        listRows: function () {
          return releaseWatchRows(runtime, { timeoutMs: listTimeoutMs, fresh: true, signal: releaseOptions.signal })
        },
        interrupt: function () {
          return interruptQuietly(id)
        },
      })
      return false
    }
    return (await disposeById(id)) === 'released'
  }

  function interruptQuietly(agentId) {
    if (typeof runtime.interrupt !== 'function') return false
    try {
      runtime.interrupt(String(agentId))
      return true
    } catch (error) {
      return false
    }
  }

  /**
   * Release every executor this card still has, by role/name, even when this
   * instance's handle map was lost (plugin reload / after a block).
   *
   * Sources are merged: recorded board ids (assignee, review/test delivery), the
   * process-wide receipts for the task, and the live agent tree's names. A child
   * found only in the tree has no disposal capability left; it is interrupted and
   * reported as "interrupted", never as released.
   */
  async function releaseTask(task, options) {
    const input = typeof task === 'string' ? { id: task } : task === undefined || task === null ? {} : task
    const taskId = input.id === undefined || input.id === null ? 'task' : String(input.id)
    const releaseOptions = options === undefined || options === null ? {} : options
    const roles = normaliseRoles(releaseOptions.roles)
    // T-185: the caller of a verdict action is still waiting for that action's
    // tool result. It must never be disposed from inside the action, only queued
    // for the reconciler once its turn has ended.
    const callerAgentId =
      typeof releaseOptions.callerAgentId === 'string' && releaseOptions.callerAgentId !== '' ? releaseOptions.callerAgentId : null
    const deferred = []
    const found = new Map()
    const add = function (agentId, name, role, source) {
      const id = String(agentId === undefined || agentId === null ? '' : agentId)
      if (id === '') return
      const existing = found.get(id)
      if (existing !== undefined) {
        if (existing.sources.indexOf(source) < 0) existing.sources.push(source)
        if ((existing.role === null || existing.role === undefined) && role !== null && role !== undefined) existing.role = role
        if ((existing.name === null || existing.name === undefined) && name !== null && name !== undefined) existing.name = name
        return
      }
      found.set(id, { agentId: id, name: name === undefined ? null : name, role: role === undefined ? null : role, sources: [source] })
    }

    // 1) The board's own delivery records: exact ids, no name guessing.
    const assignee = input.assignee
    const review = input.review
    const test = input.test
    const recorded = {
      worker: assignee !== null && assignee !== undefined ? assignee.session : null,
      reviewer: review !== null && review !== undefined && review.deliveredTo !== null && review.deliveredTo !== undefined ? review.deliveredTo.id : null,
      tester: test !== null && test !== undefined && test.deliveredTo !== null && test.deliveredTo !== undefined ? test.deliveredTo.id : null,
    }
    // T-221: the roles the board and the receipts already name. A covered role
    // needs no tree scan, because the id IS the routing identity.
    const covered = new Set()
    for (const role of roles) {
      if (typeof recorded[role] === 'string' && recorded[role] !== '') {
        add(recorded[role], null, role, 'record')
        covered.add(role)
      }
    }

    // 2) Disposal capabilities retained by this process for that exact card.
    //    When the caller names the card's root, receipts of another project's
    //    same-numbered card are not touched.
    const ownerSession = typeof input.ownerSession === 'string' && input.ownerSession !== '' ? input.ownerSession : null
    for (const receipt of activations.values()) {
      if (receipt.taskId !== taskId) continue
      if (ownerSession !== null && receipt.rootId !== null && receipt.rootId !== ownerSession) continue
      if (roles.indexOf(receipt.role) < 0) continue
      add(receipt.agentId, receipt.name, receipt.role, 'registry')
      covered.add(receipt.role)
    }

    // 3) The live agent tree is the LAST resort (T-221). It can still see a child
    //    started before this module was loaded (a name but no receipt here), but
    //    reading it is O(tree) and used to hold a released card — and the merge
    //    queue that released it — for minutes. Only a role neither the board nor
    //    a receipt names reaches for it, at most ONE bounded read per call.
    const uncovered = roles.filter(function (role) { return covered.has(role) !== true })
    let agentList = null
    if (uncovered.length > 0) {
      const read = await readAgentRows(runtime, {
        timeoutMs: Number.isFinite(releaseOptions.listTimeoutMs) ? releaseOptions.listTimeoutMs : listTimeoutMs,
        cacheMs: Number.isFinite(releaseOptions.listCacheMs) ? releaseOptions.listCacheMs : listCacheMs,
        signal: releaseOptions.signal,
      })
      agentList = { attempted: true, cached: read.cached === true, timedOut: read.timedOut === true, code: read.code === undefined ? null : read.code }
      for (const row of Array.isArray(read.rows) ? read.rows : []) {
        if (row === null || row === undefined) continue
        // The DSH catalog is append-only: a disposed child stays a row with
        // activity:'inactive'. Only an explicitly inactive row is skipped; a row
        // that cannot tell is kept (never assumed released).
        if (row.activity === 'inactive') continue
        const id = row.id !== undefined ? row.id : row.sessionId
        if (id === undefined || id === null || String(id) === '') continue
        const at = typeof row.path === 'string' && row.path !== '' ? row.path.split('/').pop() : null
        const name = typeof row.name === 'string' && row.name !== '' ? row.name : at
        // Once ONE bounded scan is paid for, it answers for every requested role:
        // a leaked reviewer whose role the board happened to record is exactly the
        // child this read exists to find (T-204), and ignoring it would leave a
        // second live reviewer behind the recorded one. The name ONLY attributes an
        // otherwise unknown row to this card; the id recorded on the board or in a
        // receipt is never re-derived from a name, and every release/interrupt
        // below is issued by exact id.
        const role = taskRoleOfAgentName(name, roles, taskId)
        if (role !== null) add(id, name, role, 'tree')
      }
    }

    const released = []
    const interrupted = []
    const unresolved = []
    const failed = []
    for (const entry of found.values()) {
      if (roles.indexOf(entry.role) < 0 && entry.role !== null) continue
      if (callerAgentId !== null && entry.agentId === callerAgentId) {
        deferReleaseAgent(entry.agentId, {
          taskId: taskId,
          rootId: ownerSession,
          reason: releaseOptions.reason,
          dispose: function () {
            return disposeById(entry.agentId)
          },
          listRows: function () {
            return releaseWatchRows(runtime, { timeoutMs: listTimeoutMs, fresh: true, signal: releaseOptions.signal })
          },
          interrupt: function () {
            return interruptQuietly(entry.agentId)
          },
        })
        deferred.push(entry)
        continue
      }
      const outcome = await disposeById(entry.agentId)
      if (outcome === 'released') {
        released.push(entry)
        continue
      }
      if (outcome === 'error') {
        failed.push(entry)
        continue
      }
      // No receipt and no handle in this process: disposal is not possible
      // anymore, so stop the running turn instead and say so.
      if (interruptQuietly(entry.agentId)) interrupted.push(entry)
      else unresolved.push(entry)
    }
    // T-221: an id this call disposed cannot be rediscovered by name later in the
    // cache window; drop it from the memoised rows instead of invalidating the
    // whole read (consecutive releases then keep sharing ONE scan).
    if (agentList !== null) {
      const touched = released.concat(interrupted, failed, unresolved).map(function (entry) { return entry.agentId })
      forgetCachedListRows(listRootKey(runtime), touched)
    }
    return {
      ok: failed.length === 0 && unresolved.length === 0,
      taskId: taskId,
      roles: roles,
      released: released,
      interrupted: interrupted,
      unresolved: unresolved,
      failed: failed,
      // T-185: queued self-releases. Not a failure: the caller is retired by the
      // reconciler after its turn ends.
      deferred: deferred,
      // T-221: the last-resort tree read. null when the board records and the
      // receipts already named every requested role. A timed-out read says so and
      // still does not block the release of the ids that WERE known.
      agentList: agentList,
    }
  }

  return {
    runtime: runtime,
    root: runtime.root,
    rootId: runtime.rootId,
    startWorker(task, prompt, extra) { return start('worker', task, prompt, extra) },
    startReviewer(task, prompt, extra) { return start('reviewer', task, prompt, extra) },
    startTester(task, prompt, extra) { return start('tester', task, prompt, extra) },
    send: send,
    release: release,
    releaseTask: releaseTask,
    handleFor(agentId) { return handles.get(String(agentId)) || null },
    handles() { return Array.from(handles.keys()) },
  }
}
