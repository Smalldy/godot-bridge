/**
 * The action API — one registry, three surfaces.
 *
 * Every action the tool, the HTTP route and the panel can perform is a handler
 * in this module. The surfaces differ only in who is calling and where the
 * project comes from; the actions themselves, their validation and their
 * responses are the same. That is what stops the tool and the panel from
 * drifting into two vocabularies again.
 *
 * A success is { ok: true, ... }. A refusal is { ok: false, code, message } and
 * never throws; the caller turns it into a tool error or an HTTP body.
 */

import { join, resolve } from 'node:path'
import { TASK_LEASE_MS } from './schema.mjs'
import * as model from './service.mjs'
import * as locks from './locks.mjs'
import { MERGER_NAME, probeWorktree, resolveLead, servicesFor, workerPool } from './dispatch.mjs'
import { DEFAULT_VERIFY_COMMAND, formatVerificationOutput, recordMergeResult, recordVerdict, refreshMergeRequest } from './merge.mjs'
import { writePolicyFor } from './state.mjs'

/** Every action this API exposes. The tool enum and the route allowlist are
 * generated from this list, so they cannot disagree. */
export const ACTIONS = [
  'board',
  'list',
  'get',
  'create',
  'update',
  'delete',
  'start',
  'pause',
  'settings',
  'tick',
  'submit',
  'mergeRequest',
  'refreshMerge',
  'rejectMerge',
  'approveStart',
  'rejectStart',
  'cancelStartRequest',
  'cancel',
  'reopen',
  'block',
  'unblock',
  'retry',
  'lock',
  'unlock',
  'locks',
  'forceUnlock',
  'openProject',
]

/** Actions that belong to the person at the GUI. The tool binding hides them,
 * and perform() refuses them for an agent even if one is called directly. */
export const USER_ONLY_ACTIONS = ['approveStart', 'rejectStart', 'settings']

/** The tool's vocabulary: everything except the user-owned actions. */
export const AGENT_ACTIONS = ACTIONS.filter((action) => USER_ONLY_ACTIONS.indexOf(action) < 0)

/** Read-only actions; the tool may run them concurrently. */
export const READ_ACTIONS = ['board', 'list', 'get', 'locks']

const STATUS_RANK = { pending: 0, running: 1, blocked: 2, done: 3, cancelled: 4 }

function failure(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
}

function ok(payload) {
  return Object.assign({ ok: true }, payload === undefined ? {} : payload)
}

function messageOf(error) {
  return String((error && error.message) || error)
}

/**
 * Build the API over one state + scheduler.
 *
 * @param ctx - the row context; needs fs for openProject.
 * @param options.state - the shared state.
 * @param options.scheduler - the dispatcher (optional; tick/start still work).
 * @param options.git - the createGit facade shared with the dispatcher. Worktrees
 *   are the execution model, so a null/omitted facade means dispatch cannot
 *   start (start/approveStart refuse readably), and submit refuses a task whose
 *   worktree cannot be committed.
 * @param options.merger - the merge queue (merge.mjs). Merge actions refuse
 *   readably when it is absent; nothing else depends on it.
 * @param options.verify - async ({ cwd, command, task }) -> { code, stdout, stderr }.
 *   The HOST-side verifier for independent testing. Null/omitted means this
 *   profile cannot verify, and independent requests simply stay pending.
 * @param options.verifyCommand - the verification command; defaults to
 *   `npm run verify`.
 * @param options.now - clock, for tests.
 */
export function createApi(ctx, options) {
  const opts = options === undefined ? {} : options
  const state = opts.state
  const scheduler = opts.scheduler === undefined ? null : opts.scheduler
  const git = opts.git === undefined ? null : opts.git
  const merger = opts.merger === undefined ? null : opts.merger
  const verify = typeof opts.verify === 'function' ? opts.verify : null
  const verifyCommand =
    typeof opts.verifyCommand === 'string' && opts.verifyCommand.trim() !== '' ? opts.verifyCommand : DEFAULT_VERIFY_COMMAND
  const clock = typeof opts.now === 'function' ? opts.now : () => state.clock()

  /** Merge actions are one-at-a-time: the queue serialises the whole read+git+write. */
  function serialised(work) {
    if (merger !== null && typeof merger.enqueue === 'function') return merger.enqueue(work)
    return work()
  }

  /**
   * The Team member this call comes from, or null. Resolution starts from the
   * agent id the tool layer hands over, then falls back to the display label, so
   * an older caller that only sends a name still resolves.
   */
  function callerMemberOf(context) {
    if (context === undefined || context === null) return null
    const agent = context.agent === undefined || context.agent === null ? null : context.agent
    const by = typeof context.by === 'string' && context.by.length > 0 ? context.by : null
    if (agent === null && by === null) return null
    const { agentTeams } = servicesFor(ctx)
    if (agentTeams === undefined || agentTeams === null) return null
    const lead = resolveLead(ctx)
    if (lead === null) return null
    let members = []
    try {
      members = agentTeams.listMembers(lead)
    } catch (error) {
      return null
    }
    if (!Array.isArray(members)) return null
    if (agent !== null && agent.id !== undefined && agent.id !== null) {
      const match = members.filter(
        (member) =>
          member !== null && typeof member === 'object' && member.id !== undefined && member.id !== null && String(member.id) === String(agent.id),
      )[0]
      if (match !== undefined) return match
    }
    if (by !== null) {
      const match = members.filter((member) => member !== null && typeof member === 'object' && member.name === by)[0]
      if (match !== undefined) return match
    }
    return null
  }

  /**
   * Merge actions belong to the user, or to the Team member named exactly
   * "merger" — a fixed role the Lead spawns, not a permission switch. Every
   * other agent is refused before the queue is touched.
   */
  function mergeRefusal(context) {
    if (context !== undefined && context !== null && context.role === 'user') return null
    const member = callerMemberOf(context)
    if (member !== null && member.name === MERGER_NAME) return null
    return failure(
      'merger-only',
      'Only the user or the Team member named "' +
        MERGER_NAME +
        '" can merge or reject merge requests; everyone else reports done and lets the merger integrate.',
    )
  }

  /**
   * The task branch's CURRENT head, independent of what the merge request
   * recorded. The task worktree is authoritative when it still exists (that is
   * where the agent committed); otherwise the branch is resolved in the main
   * checkout. Never throws; a missing branch or git is a readable failure.
   */
  async function readBranchHead(projectPath, task) {
    if (git === null) {
      return failure('no-git-service', 'this profile has no git service, so the branch head of ' + task.id + ' cannot be read')
    }
    const worktree = typeof task.worktree === 'string' && task.worktree.length > 0 ? task.worktree : ''
    if (worktree !== '') {
      try {
        const viaWorktree = await git.head(worktree)
        if (viaWorktree !== null && viaWorktree !== undefined && viaWorktree.ok === true && typeof viaWorktree.hash === 'string' && viaWorktree.hash.length > 0) {
          return ok({ head: String(viaWorktree.hash) })
        }
      } catch (error) {
        // The worktree may already be gone; fall through to the branch.
      }
    }
    if (typeof task.branch !== 'string' || task.branch.length === 0) {
      return failure('missing-branch', task.id + ' has no branch, so its head cannot be read')
    }
    try {
      const viaBranch = await git.revParse(projectPath, task.branch)
      if (viaBranch !== null && viaBranch !== undefined && viaBranch.ok === true && typeof viaBranch.hash === 'string' && viaBranch.hash.length > 0) {
        return ok({ head: String(viaBranch.hash) })
      }
      const detail = viaBranch !== null && viaBranch !== undefined && typeof viaBranch.message === 'string' ? viaBranch.message : 'git returned no hash'
      return failure('head-unreadable', 'could not read the head of ' + task.branch + ': ' + detail)
    } catch (error) {
      return failure('head-unreadable', 'could not read the head of ' + task.branch + ': ' + messageOf(error))
    }
  }

  /**
   * The head of the merge TARGET branch, resolved in the main checkout. A
   * refresh re-bases a request on this commit, so its failure is a readable
   * refusal (never a silent no-op). Never throws.
   */
  async function readTargetHead(projectPath, ref) {
    if (git === null) {
      return failure('no-git-service', 'this profile has no git service, so the target branch ' + ref + ' cannot be read')
    }
    try {
      const resolved = await git.revParse(projectPath, ref)
      if (resolved !== null && resolved !== undefined && resolved.ok === true && typeof resolved.hash === 'string' && resolved.hash.length > 0) {
        return ok({ head: String(resolved.hash) })
      }
      const detail = resolved !== null && resolved !== undefined && typeof resolved.message === 'string' ? resolved.message : 'git returned no hash'
      return failure('target-unreadable', 'could not read the head of the target branch ' + ref + ': ' + detail)
    } catch (error) {
      return failure('target-unreadable', 'could not read the head of the target branch ' + ref + ': ' + messageOf(error))
    }
  }

  /**
   * Best-effort message to one Team member by name. Every failure — no team
   * service, no lead, no such member, a refused mailbox — is swallowed: a
   * notification must never fail a submit or a merge.
   */
  async function notifyMember(target, text) {
    const name = typeof target === 'string' ? target.trim() : ''
    if (name === '' || typeof text !== 'string' || text === '') return null
    try {
      const { agentTeams } = servicesFor(ctx)
      if (agentTeams === undefined || agentTeams === null) return null
      const lead = resolveLead(ctx)
      if (lead === null) return null
      let members = []
      try {
        members = agentTeams.listMembers(lead)
      } catch (error) {
        return null
      }
      if (!Array.isArray(members)) return null
      const member = members.filter((entry) => entry !== null && typeof entry === 'object' && entry.name === name)[0]
      if (member === undefined) return null
      const request = { target: name, content: [{ type: 'text', text: text }] }
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        request.signal = AbortSignal.timeout(15000)
      }
      await agentTeams.sendMessage(lead, request)
      return member
    } catch (error) {
      return null
    }
  }

  /** Tell the merger a merge request is open. No merger is a normal outcome. */
  async function notifyMergerOpened(projectPath, task) {
    if (task === null || task === undefined) return
    const merge = task.merge
    if (merge === null || merge === undefined || typeof merge !== 'object' || merge.status !== 'open') return
    const owner =
      task.assignee === null || task.assignee === undefined || task.assignee.name === null || task.assignee.name === undefined
        ? 'the task owner'
        : String(task.assignee.name)
    const lines = [
      'Merge request ' + task.id + ' (' + task.title + ') is open.',
      '  branch: ' + String(task.branch === null || task.branch === undefined ? '' : task.branch),
      '  target: ' + String(merge.target === null || merge.target === undefined ? '' : merge.target),
      '  project: ' + String(projectPath),
      '  owner: ' + owner,
      '',
      'Review it with task_center { action: "board" } or { action: "get", id: "' + task.id + '" },',
      'then integrate it with task_center { action: "mergeRequest", id: "' + task.id + '" } (or rejectMerge).',
      'Do not push. If it conflicts or verification fails, leave the repair to the task owner.',
    ]
    await notifyMember(MERGER_NAME, lines.join('\n'))
  }

  /** Tell the owner what a merge outcome needs from them; skipped without an owner or a team. */
  async function notifyMergeOutcome(projectPath, task) {
    if (task === null || task === undefined) return
    const merge = task.merge
    if (merge === null || merge === undefined || typeof merge !== 'object') return
    const status = merge.status
    const owner =
      task.assignee === null || task.assignee === undefined || typeof task.assignee.name !== 'string' || task.assignee.name === ''
        ? null
        : task.assignee.name
    if (status === 'merged') {
      if (owner === null) return
      const commit = merge.mergeCommit === null || merge.mergeCommit === undefined ? '' : ' as ' + String(merge.mergeCommit)
      const target = merge.target === null || merge.target === undefined ? '' : String(merge.target)
      await notifyMember(owner, 'Merge request ' + task.id + ' (' + task.title + ') was merged into ' + target + commit + '.')
      return
    }
    if ((status !== 'conflict' && status !== 'failed') || owner === null) return
    const detail =
      status === 'conflict'
        ? 'conflict: ' + String(merge.conflict === null || merge.conflict === undefined ? 'unknown conflicted files' : merge.conflict)
        : 'verification output:\n' + String(merge.output === null || merge.output === undefined ? '' : merge.output)
    await notifyMember(
      owner,
      'Merge request ' + task.id + ' (' + task.title + ') needs repair (' + status + ').\n' +
        '  project: ' + String(projectPath) + '\n' +
        '  branch: ' + String(task.branch === null || task.branch === undefined ? '' : task.branch) + '\n' +
        '  ' + detail + '\n' +
        'Fix it in your task worktree (' +
        String(task.worktree === null || task.worktree === undefined ? '' : task.worktree) +
        '), then refresh the merge request with task_center { action: "refreshMerge", id: "' +
        task.id +
        '" } and tell the Lead so it can be retried.',
    )
  }

  /** The temporary-checkout root from a board's settings. */
  function worktreeRootOf(board) {
    const settings =
      board === undefined || board === null || board.dispatch === undefined || board.dispatch === null ? null : board.dispatch.worktree
    return settings !== null && settings !== undefined && typeof settings.root === 'string' && settings.root.trim() !== ''
      ? settings.root.trim()
      : '.worktrees'
  }

  /**
   * Run the project's verification in a THROWAWAY checkout of the task branch,
   * then record the result as a system verdict.
   *
   * The pass/fail decision is the process EXIT CODE — no model is involved. The
   * checkout (<root>/verify-<id>, branch verify/<id>) is always removed
   * afterwards, and a checkout that cannot be made is a failed verdict rather
   * than a silently open gate.
   *
   * Returns the refreshed task detail, or null when this profile has no
   * verification runner (the request then simply stays pending).
   */
  async function verifyOnHost(projectPath, task, worktreeRoot) {
    if (verify === null) return null
    if (git === null) {
      return recordVerifiedVerdict(projectPath, task, {
        status: 'failed',
        output: 'this profile has no git service, so the branch could not be checked out for verification',
      })
    }
    if (typeof task.branch !== 'string' || task.branch.length === 0) {
      return recordVerifiedVerdict(projectPath, task, { status: 'failed', output: 'the task has no branch to verify' })
    }
    const root = typeof worktreeRoot === 'string' && worktreeRoot.trim() !== '' ? worktreeRoot.trim() : '.worktrees'
    const path = join(projectPath, root, 'verify-' + task.id)
    const branch = 'verify/' + task.id
    let added = null
    try {
      added = await git.worktreeAdd(projectPath, { path: path, branch: branch, base: task.branch })
    } catch (error) {
      added = null
    }
    if (added === null || added === undefined || added.ok !== true) {
      const detail = added === null || added === undefined ? 'the git service returned no result' : String(added.message)
      return recordVerifiedVerdict(projectPath, task, { status: 'failed', output: 'could not create the verification worktree: ' + detail })
    }
    let result = null
    try {
      result = await verify({ cwd: path, command: verifyCommand, task: task })
    } catch (error) {
      result = { code: 1, stdout: '', stderr: messageOf(error) }
    }
    // The checkout is temporary: remove it and its branch whatever happened.
    try {
      await git.worktreeRemove(projectPath, path, { force: true })
    } catch (error) {}
    if (typeof git.deleteBranch === 'function') {
      try {
        await git.deleteBranch(projectPath, branch, { force: true })
      } catch (error) {}
    }
    const code = Number.isFinite(result === null || result === undefined ? NaN : result.code) ? result.code : 1
    const output = formatVerificationOutput(verifyCommand, code, result)
    return recordVerifiedVerdict(projectPath, task, { status: code === 0 ? 'passed' : 'failed', output: output })
  }

  /** Apply a host verdict, then tell the merger (pass) or the owner (fail). */
  async function recordVerifiedVerdict(projectPath, task, verdict) {
    const systemContext = { projectPath: projectPath, by: 'system', role: 'user', agent: null }
    const recorded = await writeTask(projectPath, task.id, (board) => recordVerdict(board, task.id, verdict, clock()), systemContext)
    if (recorded.ok !== true) return null
    const verified = recorded.task
    if (verified === null || verified === undefined) return null
    const merge = verified.merge
    if (verdict.status === 'passed') {
      const lines = [
        'Independent verification PASSED for ' + verified.id + ' (' + verified.title + ').',
        '  branch: ' + String(verified.branch === null || verified.branch === undefined ? '' : verified.branch),
        '  target: ' + String(merge !== null && merge !== undefined && merge.target !== null && merge.target !== undefined ? merge.target : ''),
        '  project: ' + String(projectPath),
        '  verdict: passed',
        'The merge request is ready for the merge queue; do not push.',
      ]
      await notifyMember(MERGER_NAME, lines.join('\n'))
    } else {
      const owner =
        verified.assignee === null || verified.assignee === undefined || typeof verified.assignee.name !== 'string' || verified.assignee.name === ''
          ? null
          : verified.assignee.name
      if (owner !== null) {
        await notifyMember(
          owner,
          'Independent verification FAILED for ' + verified.id + ' (' + verified.title + ').\n' +
            '  project: ' + String(projectPath) + '\n' +
            '  branch: ' + String(verified.branch === null || verified.branch === undefined ? '' : verified.branch) + '\n' +
            '  output:\n' +
            String(verdict.output === null || verdict.output === undefined ? '' : verdict.output) + '\n' +
            'Fix it in your task worktree (' +
            String(verified.worktree === null || verified.worktree === undefined ? '' : verified.worktree) +
            '), then refresh the merge request with task_center { action: "refreshMerge", id: "' +
            verified.id +
            '" } to re-run verification.',
        )
      }
    }
    return verified
  }

  function projectFrom(input, context) {
    const candidate =
      input !== undefined && input !== null && typeof input.project === 'string' && input.project.length > 0
        ? input.project
        : context !== undefined && typeof context.projectPath === 'string' && context.projectPath.length > 0
          ? context.projectPath
          : state.memory.projectHint
    if (typeof candidate !== 'string' || candidate.length === 0) return null
    return resolve(state.memory.projectHint === null ? process.cwd() : state.memory.projectHint, candidate)
  }

  /** The scheduler follows the project whose board was last touched. */
  function remember(projectPath) {
    state.noteProject(projectPath)
  }

  async function readBoardOrFail(projectPath) {
    const read = await state.read(projectPath)
    if (read.failed !== null) return { failed: read.failed }
    return { board: read.board }
  }

  /** Release locks whose task is gone or no longer running. */
  function reconcileLocks(board) {
    let next = state.memory.locks
    let changed = false
    for (const path of Object.keys(next)) {
      const taskId = next[path].taskId
      if (taskId === null || taskId === undefined) continue
      const task = model.findTask(board, taskId)
      if (task !== undefined && task.status === 'running') continue
      delete next[path]
      changed = true
    }
    if (changed) state.memory.locks = next
  }

  /**
   * Why a pending task has not been dispatched yet. This is a REPORT: it mirrors
   * the checks the scheduler makes (dispatch paused, dependency not ready, a
   * file another owner holds, a full concurrency budget). Dispatch never reads
   * it back, so it cannot change what runs — only explain what did not.
   */
  function waitingReasonOf(board, task) {
    if (task.status !== 'pending') return null
    const dispatch = board.dispatch === undefined || board.dispatch === null ? {} : board.dispatch
    if (dispatch.state !== 'running') return 'dispatch-paused'
    const dependency = model.dependencyInfo(board, task)
    if (dependency.state === 'broken') return 'dependency-broken'
    if (dependency.state === 'waiting') return 'dependency'
    const files = Array.isArray(task.writeFiles) ? task.writeFiles : []
    if (files.length > 0 && locks.conflictsFor(state.memory.locks, files, 'task:' + task.id).length > 0) return 'file-lock'
    const running = board.tasks.filter((other) => other.status === 'running').length
    const limit = Number.isFinite(dispatch.maxConcurrent) ? dispatch.maxConcurrent : 1
    if (running >= limit) return 'concurrency'
    return null
  }

  /** model.detail plus the one report field this API adds on top of it. */
  function detailOf(board, task, now) {
    return Object.assign(model.detail(board, task, now), { waitingReason: waitingReasonOf(board, task) })
  }

  /**
   * Which tasks would wait on one held file right now: pending, dependency
   * ready, declaring a conflicting path, and not the holder itself. The
   * scheduler has no FIFO lock queue, so this is a picture of contention, never
   * an ordered promise — nothing reads it back.
   */
  function lockWaiters(board, lock) {
    const out = []
    for (const task of board.tasks) {
      if (task.status !== 'pending') continue
      if (lock.taskId !== null && lock.taskId !== undefined && String(task.id) === String(lock.taskId)) continue
      const files = Array.isArray(task.writeFiles) ? task.writeFiles : []
      if (files.length === 0) continue
      if (model.dependencyInfo(board, task).state !== 'ready') continue
      if (!files.some((path) => locks.pathsConflict(path, lock.path))) continue
      out.push({ id: task.id, title: task.title })
    }
    out.sort((left, right) => left.id.localeCompare(right.id))
    return out
  }

  /**
   * Refuse to enter running dispatch when the worktree environment cannot host
   * it. Returns null when starting is allowed, or a readable refusal otherwise.
   * Worktrees are the execution model, so this is a precondition of starting —
   * not a per-task fallback.
   */
  async function worktreeRefusal(projectPath) {
    const probe = await probeWorktree(git, projectPath)
    if (probe.ok === true) return null
    return failure(
      'worktree-unavailable',
      'Cannot start dispatch: every task runs in its own git worktree, and this project cannot host one right now — ' +
        probe.message +
        '. Fix the git environment (install/enable the subprocess service, initialise the repository, commit or stash the working tree), then start dispatch again.',
      { worktree: probe.code },
    )
  }

  async function snapshot(projectPath) {
    projectPath = resolve(projectPath)
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const board = read.board
    const now = clock()
    state.sweepLocks()
    reconcileLocks(board)
    const tasks = board.tasks
      .slice()
      .sort((left, right) => {
        const rank = STATUS_RANK[left.status] - STATUS_RANK[right.status]
        return rank !== 0 ? rank : left.id.localeCompare(right.id)
      })
      .map((task) => detailOf(board, task, now))
    return ok({
      project: projectPath,
      version: board.version,
      seq: board.seq,
      updatedAt: board.updatedAt,
      dispatch: board.dispatch,
      workers: workerPool(ctx, board),
      counts: model.counts(board),
      queue: model.readyTasks(board).map((task) => model.summary(board, task, now)),
      tasks: tasks,
      locks: locks.view(state.memory.locks, board, now).map((lock) =>
        Object.assign({}, lock, { waiters: lockWaiters(board, lock) }),
      ),
      scheduler: scheduler === null ? null : scheduler.status(),
      serverTime: new Date(now).toISOString(),
    })
  }

  /** Renew the lease of the caller's running tasks when it is half spent. A
   * tool call is a heartbeat; there is no separate timer. */
  async function heartbeat(projectPath, owner) {
    if (owner === null || owner === undefined) return
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return
    const now = clock()
    const owned = read.board.tasks.filter((task) => {
      if (task.status !== 'running' || task.assignee === null) return false
      const sessionMatch = owner.session !== null && owner.session !== undefined && task.assignee.session === owner.session
      const nameMatch = owner.name !== null && owner.name !== undefined && task.assignee.name === owner.name
      return (sessionMatch || nameMatch) && task.leaseUntil !== null && Date.parse(task.leaseUntil) - now < TASK_LEASE_MS / 2
    })
    if (owned.length === 0) return
    const applied = await state.apply(
      projectPath,
      (board) => model.renewLeases(board, owner, clock()),
      writePolicyFor(projectPath),
    )
    if (applied.failed === null) {
      for (const task of owned) {
        const renewed = locks.renewTask(state.memory.locks, task.id, clock(), TASK_LEASE_MS)
        if (renewed.ok === true) state.memory.locks = renewed.locks
      }
    }
  }

  function ownerOf(context) {
    if (context === undefined || context === null) return null
    if (context.role === 'user') return null
    return { session: context.agent === undefined ? null : context.agent.id, name: context.by }
  }

  function assigneeMatches(task, owner) {
    if (owner === null) return true
    if (task.assignee === null) return true
    if (owner.session !== null && owner.session !== undefined && task.assignee.session === owner.session) return true
    if (owner.name !== null && owner.name !== undefined && task.assignee.name === owner.name) return true
    // A claim with no session cannot be verified; refusing would strand the
    // task on an identity the tool layer cannot see.
    return task.assignee.session === null || task.assignee.session === undefined
  }

  async function mutate(projectPath, mutator, context) {
    const owner = ownerOf(context)
    if (owner !== null) await heartbeat(projectPath, owner)
    const applied = await state.apply(projectPath, mutator, writePolicyFor(projectPath))
    if (applied.failed !== null) return applied.failed
    reconcileLocks(applied.board)
    if (scheduler !== null) void scheduler.kick(projectPath)
    return ok({ board: applied.board, events: applied.events })
  }

  async function writeTask(projectPath, id, mutator, context) {
    const result = await mutate(projectPath, mutator, context)
    if (result.ok !== true) return result
    const task = model.findTask(result.board, id)
    return ok({
      task: task === undefined ? null : detailOf(result.board, task, clock()),
      events: result.events,
    })
  }

  function canonicalFiles(projectPath, input) {
    if (input === undefined || input === null || !Array.isArray(input)) return { ok: true, files: undefined }
    try {
      return { ok: true, files: locks.canonicalList(projectPath, input) }
    } catch (error) {
      return failure('invalid-path', messageOf(error))
    }
  }

  /** Build the input for create/update with canonical file paths. */
  function taskInput(projectPath, input) {
    const source = input === undefined ? {} : input
    const files = canonicalFiles(projectPath, source.writeFiles)
    if (files.ok !== true) return files
    const result = {}
    for (const key of ['title', 'spec', 'acceptance', 'priority', 'maxAttempts', 'dependsOn', 'note']) {
      if (source[key] !== undefined) result[key] = source[key]
    }
    if (files.files !== undefined) result.writeFiles = files.files
    return { ok: true, input: result }
  }

  function taskForContext(board, id, context) {
    const task = model.findTask(board, id)
    if (task === undefined) return failure('unknown-task', 'no task with id ' + String(id))
    const owner = ownerOf(context)
    if (!assigneeMatches(task, owner)) {
      return failure('not-assignee', task.id + ' is assigned to ' + String(task.assignee === null ? 'someone else' : task.assignee.name))
    }
    return { ok: true, task: task }
  }

  /**
   * Commit a task's worktree and describe its merge request.
   *
   * A task without a worktree returns `{ ok: true, mr: null }`, which keeps the
   * old submit behavior byte for byte. A task WITH one must commit first; any git
   * refusal is returned as-is and nothing is written, so the task stays running,
   * keeps its lease and keeps its file locks for a retry.
   */
  async function prepareMergeRequest(task, source, now, testing) {
    if (typeof task.worktree !== 'string' || task.worktree.length === 0) return { ok: true, mr: null }
    if (git === null) {
      return failure('no-git-service', task.id + ' has a worktree at ' + task.worktree + ' but this profile has no git service; submit it where git is available')
    }
    const base = typeof task.base === 'string' && task.base.length > 0 ? task.base : null
    if (base === null) {
      return failure('missing-base', task.id + ' has a worktree but no base commit, so its changes cannot be described')
    }
    let committed
    try {
      committed = await git.commitAll(task.worktree, 'task-center: ' + task.id + ' ' + task.title)
    } catch (error) {
      return failure('commit-failed', 'could not commit ' + task.id + ' in ' + task.worktree + ': ' + messageOf(error))
    }
    let head
    if (committed !== null && committed !== undefined && committed.ok === true) {
      head = String(committed.hash)
    } else if (committed !== null && committed !== undefined && committed.code === 'nothing-to-commit') {
      // A previous submit may have committed and then failed to write the board
      // (CAS/lost race) or the process died. The worktree branch already carries
      // the work; reuse its HEAD instead of dead-locking every later submit on
      // "nothing to commit".
      let current = null
      try {
        current = typeof git.head === 'function' ? await git.head(task.worktree) : null
      } catch (error) {
        current = null
      }
      if (current === null || current === undefined || current.ok !== true || String(current.hash) === base) {
        return failure('nothing-to-commit', 'there were no changes to commit for ' + task.id)
      }
      head = String(current.hash)
    } else {
      const code = String(committed === null || committed === undefined || committed.code === undefined || committed.code === null ? 'commit-failed' : committed.code)
      const detail = committed === null || committed === undefined ? 'git returned no result' : String(committed.message)
      return failure(code, 'could not commit ' + task.id + ' in ' + task.worktree + ': ' + detail)
    }
    let diff
    try {
      diff = await git.diffNameOnly(task.worktree, base, head)
    } catch (error) {
      return failure('diff-failed', 'could not list the files ' + task.id + ' changed: ' + messageOf(error))
    }
    if (diff === null || diff === undefined || diff.ok !== true) {
      const code = String(diff === null || diff === undefined || diff.code === undefined || diff.code === null ? 'diff-failed' : diff.code)
      const detail = diff === null || diff === undefined ? 'git returned no result' : String(diff.message)
      return failure(code, 'could not list the files ' + task.id + ' changed: ' + detail)
    }
    const actualFiles = Array.isArray(diff.files) ? diff.files : []
    const evidence = source.evidence === undefined || source.evidence === null ? '' : String(source.evidence)
    const note = source.note === undefined || source.note === null ? '' : String(source.note)
    return {
      ok: true,
      mr: {
        commit: head,
        actualFiles: actualFiles,
        merge: {
          status: 'open',
          base: base,
          target: typeof task.target === 'string' ? task.target : null,
          head: head,
          declaredFiles: Array.isArray(task.writeFiles) ? task.writeFiles.slice() : [],
          actualFiles: actualFiles,
          tests: evidence !== '' ? evidence : note !== '' ? note : null,
          reviewer: null,
          conflict: null,
          at: new Date(now).toISOString(),
          // Independent testing starts every request as "pending": a separate
          // tester must record a passing verdict before the merge gate opens.
          verdict: testing === 'independent' ? { status: 'pending', by: null, at: new Date(now).toISOString(), output: null } : null,
        },
      },
    }
  }

  // ── actions ──────────────────────────────────────────────────────────────

  async function perform(action, input, context) {
    const source = input === undefined || input === null ? {} : input
    const projectPath = projectFrom(source, context)
    if (action === 'openProject') {
      return openProject(source)
    }
    if (projectPath === null) {
      return failure('unknown-project', 'no project is known yet; call openProject or run a task tool in a session first')
    }
    remember(projectPath)
    const now = clock()
    if (READ_ACTIONS.indexOf(action) >= 0) {
      const reader = ownerOf(context)
      if (reader !== null) await heartbeat(projectPath, reader)
    }

    if (action === 'board') return snapshot(projectPath)
    if (action === 'locks') {
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      state.sweepLocks()
      return ok({ locks: locks.view(state.memory.locks, read.board, now) })
    }
    if (action === 'list') {
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      const status = typeof source.status === 'string' ? source.status : null
      const tasks = read.board.tasks
        .filter((task) => status === null || task.status === status)
        .map((task) => model.summary(read.board, task, now))
      return ok({ tasks: tasks, counts: model.counts(read.board) })
    }
    if (action === 'get') {
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      const task = model.findTask(read.board, String(source.id === undefined ? '' : source.id))
      if (task === undefined) return failure('unknown-task', 'no task with id ' + String(source.id))
      return ok({
        task: detailOf(read.board, task, now),
        locks: locks.view(state.memory.locks, read.board, now).filter((lock) => lock.taskId === task.id),
      })
    }
    if (action === 'create') {
      const built = taskInput(projectPath, source)
      if (built.ok !== true) return built
      const result = await mutate(
        projectPath,
        (board) => model.createTask(board, built.input, clock(), context.by),
        context,
      )
      if (result.ok !== true) return result
      const created = result.events.length === 0 ? null : result.events[0].id
      const task = created === null ? null : model.findTask(result.board, created)
      return ok({ task: task === null ? null : detailOf(result.board, task, clock()), events: result.events })
    }
    if (action === 'update') {
      const id = String(source.id === undefined ? '' : source.id)
      if (id === '') return failure('missing-id', 'update needs a task id')
      const built = taskInput(projectPath, source)
      if (built.ok !== true) return built
      return writeTask(
        projectPath,
        id,
        (board) => model.updateTask(board, id, built.input, clock(), context.by),
        context,
      )
    }
    if (action === 'delete') {
      const id = String(source.id === undefined ? '' : source.id)
      if (id === '') return failure('missing-id', 'delete needs a task id')
      const result = await mutate(
        projectPath,
        (board) => model.deleteTask(board, id, clock(), context.by, { force: source.force === true }),
        context,
      )
      if (result.ok !== true) return result
      const released = locks.releaseTask(state.memory.locks, id)
      if (released.ok === true) state.memory.locks = released.locks
      return ok({ deleted: id, events: result.events })
    }
    if (action === 'start') {
      if (context !== undefined && context !== null && context.role === 'agent') {
        const read = await readBoardOrFail(projectPath)
        if (read.failed !== undefined) return read.failed
        if (read.board.dispatch.state === 'running') {
          return ok({ dispatch: read.board.dispatch, alreadyRunning: true })
        }
        if (read.board.dispatch.request !== null) {
          return failure(
            'needs-consent',
            'A start request is already pending. Ask the user to approve it in the task center panel; do not retry.',
            { request: read.board.dispatch.request },
          )
        }
        const unavailable = await worktreeRefusal(projectPath)
        if (unavailable !== null) return unavailable
        const requested = await mutate(
          projectPath,
          (board) => model.requestDispatch(board, { by: context.by, note: source.note }, clock(), context.by),
          context,
        )
        if (requested.ok !== true) return requested
        return failure(
          'needs-consent',
          'Dispatch was requested, not started. Ask the user to approve it in the task center panel; do not retry.',
          { request: requested.board.dispatch.request },
        )
      }
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      if (read.board.dispatch.state !== 'running') {
        const unavailable = await worktreeRefusal(projectPath)
        if (unavailable !== null) return unavailable
      }
      const result = await mutate(
        projectPath,
        (board) => model.approveDispatch(board, clock(), context.by),
        context,
      )
      if (result.ok !== true) return result
      if (scheduler !== null) await scheduler.settle(projectPath)
      return ok({ dispatch: result.board.dispatch, events: result.events })
    }
    if (action === 'pause') {
      const result = await mutate(
        projectPath,
        (board) => model.setDispatch(board, { state: 'paused' }, clock(), context.by),
        context,
      )
      if (result.ok !== true) return result
      return ok({ dispatch: result.board.dispatch, events: result.events })
    }
    if (action === 'approveStart' || action === 'rejectStart') {
      if (context === undefined || context === null || context.role !== 'user') {
        return failure('user-only', 'Starting dispatch is the user\'s decision; ask them to approve it in the task center panel.')
      }
      if (action === 'approveStart') {
        const read = await readBoardOrFail(projectPath)
        if (read.failed !== undefined) return read.failed
        if (read.board.dispatch.state !== 'running') {
          const unavailable = await worktreeRefusal(projectPath)
          if (unavailable !== null) return unavailable
        }
      }
      const result = await mutate(
        projectPath,
        (board) =>
          action === 'approveStart'
            ? model.approveDispatch(board, clock(), context.by)
            : model.clearDispatchRequest(board, clock(), context.by),
        context,
      )
      if (result.ok !== true) return result
      if (action === 'approveStart' && scheduler !== null) await scheduler.settle(projectPath)
      return ok({ dispatch: result.board.dispatch, events: result.events })
    }
    if (action === 'cancelStartRequest') {
      const result = await mutate(
        projectPath,
        (board) => model.clearDispatchRequest(board, clock(), context.by),
        context,
      )
      if (result.ok !== true) return result
      return ok({ dispatch: result.board.dispatch, events: result.events })
    }
    if (action === 'settings') {
      if (context === undefined || context === null || context.role !== 'user') {
        return failure('user-only', 'Dispatch settings belong to the user; ask them to change it in the task center panel.')
      }
      const patch = {}
      for (const key of ['maxConcurrent', 'allowSpawn', 'maxWorkAgents', 'maxAttempts', 'testing']) {
        if (source[key] !== undefined) patch[key] = source[key]
      }
      // The GUI exposes a single number: maximum concurrency. The worker cap
      // and spawning policy are derived so a user does not have to reason about
      // two capacity knobs. An explicit advanced value still wins.
      if (source.maxConcurrent !== undefined) {
        const concurrency = Number(source.maxConcurrent)
        if (Number.isFinite(concurrency)) patch.maxConcurrent = Math.floor(concurrency)
        if (source.maxWorkAgents === undefined && Number.isFinite(concurrency)) {
          patch.maxWorkAgents = Math.min(12, Math.max(1, Math.floor(concurrency) + 1))
        }
        if (source.allowSpawn === undefined) patch.allowSpawn = true
        if (source.maxAttempts === undefined) patch.maxAttempts = 3
      }
      if (Object.keys(patch).length === 0) return failure('no-change', 'no dispatch setting was supplied')
      const result = await mutate(
        projectPath,
        (board) => model.setDispatch(board, patch, clock(), context.by),
        context,
      )
      if (result.ok !== true) return result
      if (scheduler !== null) void scheduler.kick(projectPath)
      return ok({ dispatch: result.board.dispatch, events: result.events })
    }
    if (action === 'tick') {
      if (scheduler === null) return failure('no-scheduler', 'the dispatcher is not available in this profile')
      return ok({ tick: await scheduler.settle(projectPath) })
    }
    if (action === 'mergeRequest') {
      const denied = mergeRefusal(context)
      if (denied !== null) return denied
      const id = String(source.id !== undefined ? source.id : source.taskId === undefined ? '' : source.taskId)
      if (id === '') return failure('missing-id', 'mergeRequest needs a task id')
      // The whole pipeline (re-read, integrate, verify, record) runs inside the
      // queue so a second request sees the first one's result, never its state.
      const result = await serialised(async function () {
        const read = await readBoardOrFail(projectPath)
        if (read.failed !== undefined) return read.failed
        const task = model.findTask(read.board, id)
        if (task === undefined) return failure('unknown-task', 'no task with id ' + id)
        if (task.status !== 'done') return failure('not-done', id + ' is ' + task.status + '; only a done task has a merge request')
        const merge = task.merge
        if (merge === null || merge === undefined || typeof merge !== 'object' || merge.status !== 'open') {
          return failure('no-open-merge', id + ' has no open merge request')
        }
        if (merger === null || typeof merger.mergeRequest !== 'function') {
          return failure('no-merge-service', 'the merge queue is not available in this profile')
        }
        // The request records the head it was submitted at. If the branch moved
        // after that submit, the merger would verify a tree nobody reviewed:
        // refuse, touch nothing, and tell the owner to refresh explicitly.
        const currentHead = await readBranchHead(projectPath, task)
        if (currentHead.ok !== true) return currentHead
        const recordedHead = typeof merge.head === 'string' ? merge.head : null
        if (String(currentHead.head) !== String(recordedHead)) {
          return failure(
            'head-drift',
            task.id +
              "'s branch " +
              String(task.branch) +
              ' is now at ' +
              String(currentHead.head) +
              ', but its merge request records ' +
              String(recordedHead) +
              '; run task_center { action: "refreshMerge", id: "' +
              task.id +
              '" } to refresh the request, then retry the merge',
          )
        }
        // Independent testing is a merge gate: without a passing verdict the
        // request does not reach the queue at all — no integration worktree, no
        // verification run, no change to main.
        const testing = read.board.dispatch === undefined || read.board.dispatch === null ? 'self' : read.board.dispatch.testing
        if (testing === 'independent') {
          const verdict = merge.verdict === null || merge.verdict === undefined ? null : merge.verdict
          const status = verdict === null ? 'pending' : String(verdict.status)
          if (status === 'failed') {
            const output = verdict !== null && typeof verdict.output === 'string' && verdict.output !== '' ? ' Reported output: ' + verdict.output : ''
            return failure(
              'test-failed',
              id + ' failed independent testing; fix the branch and record a passing verdict before merging.' + output,
            )
          }
          if (status !== 'passed') {
            return failure(
              'test-required',
              id + ' needs a passing independent test verdict before it can be merged (current verdict: ' + status + ').',
            )
          }
        }
        const settings = read.board.dispatch === undefined || read.board.dispatch === null ? null : read.board.dispatch.worktree
        const worktreeRoot = settings !== null && settings !== undefined && typeof settings.root === 'string' ? settings.root : '.worktrees'
        const outcome = await merger.mergeRequest(task, projectPath, { worktreeRoot: worktreeRoot })
        if (outcome === null || outcome === undefined || outcome.ok !== true) {
          return failure(
            outcome === null || outcome === undefined ? 'merge-failed' : String(outcome.code),
            outcome === null || outcome === undefined ? 'the merge queue returned no result' : String(outcome.message),
          )
        }
        const recorded = await writeTask(
          projectPath,
          id,
          (board) => recordMergeResult(board, id, outcome, clock(), context.by),
          context,
        )
        if (recorded.ok !== true) return recorded
        return ok({ task: recorded.task, events: recorded.events, merge: recorded.task === null ? null : recorded.task.merge })
      })
      // Notifications happen after the queue releases, and never change the answer.
      if (result.ok === true && result.task !== null && result.task !== undefined) {
        await notifyMergeOutcome(projectPath, result.task)
      }
      return result
    }
    if (action === 'rejectMerge') {
      const denied = mergeRefusal(context)
      if (denied !== null) return denied
      const id = String(source.id !== undefined ? source.id : source.taskId === undefined ? '' : source.taskId)
      if (id === '') return failure('missing-id', 'rejectMerge needs a task id')
      return serialised(async function () {
        const read = await readBoardOrFail(projectPath)
        if (read.failed !== undefined) return read.failed
        const task = model.findTask(read.board, id)
        if (task === undefined) return failure('unknown-task', 'no task with id ' + id)
        if (task.status !== 'done') return failure('not-done', id + ' is ' + task.status + '; only a done task has a merge request')
        const merge = task.merge
        if (merge === null || merge === undefined || typeof merge !== 'object' || merge.status !== 'open') {
          return failure('no-open-merge', id + ' has no open merge request to reject')
        }
        const recorded = await writeTask(
          projectPath,
          id,
          (board) => recordMergeResult(board, id, { status: 'rejected' }, clock(), context.by),
          context,
        )
        if (recorded.ok !== true) return recorded
        return ok({ task: recorded.task, events: recorded.events, merge: recorded.task === null ? null : recorded.task.merge })
      })
    }
    if (action === 'refreshMerge') {
      const id = String(source.id !== undefined ? source.id : source.taskId === undefined ? '' : source.taskId)
      if (id === '') return failure('missing-id', 'refreshMerge needs a task id')
      // Reads the branch head and the base diff, then rewrites the request in
      // one board write. It never commits, merges or pushes.
      return serialised(async function () {
        const read = await readBoardOrFail(projectPath)
        if (read.failed !== undefined) return read.failed
        const task = model.findTask(read.board, id)
        if (task === undefined) return failure('unknown-task', 'no task with id ' + id)
        if (task.status !== 'done') {
          return failure('not-done', id + ' is ' + task.status + '; only a done task has a merge request to refresh')
        }
        const merge = task.merge
        if (merge === null || merge === undefined || typeof merge !== 'object' || Array.isArray(merge)) {
          return failure('no-merge-request', id + ' has no merge request to refresh')
        }
        const owner = ownerOf(context)
        const asUser = context !== undefined && context !== null && context.role === 'user'
        const asOwner = owner !== null && task.assignee !== null && task.assignee !== undefined && assigneeMatches(task, owner)
        const member = asUser || asOwner ? null : callerMemberOf(context)
        if (!asUser && !asOwner && (member === null || member.name !== MERGER_NAME)) {
          return failure(
            'not-assignee',
            id +
              ' belongs to ' +
              (task.assignee === null || task.assignee === undefined ? 'nobody' : String(task.assignee.name)) +
              '; only its owner, the user or the merger may refresh its merge request',
          )
        }
        if (typeof task.branch !== 'string' || task.branch.length === 0) return failure('missing-branch', id + ' has no branch to read')
        // Re-base on the target's CURRENT head, not the commit recorded at
        // submit: when the target advanced (or the branch merged it in while
        // resolving a conflict), diffing from the old base would report
        // upstream files as this task's work. A task with no target branch keeps
        // its recorded base (legacy behaviour).
        let base = typeof merge.base === 'string' && merge.base.length > 0 ? merge.base : null
        if (typeof task.target === 'string' && task.target.length > 0) {
          const targetHead = await readTargetHead(projectPath, task.target)
          if (targetHead.ok !== true) return targetHead
          base = targetHead.head
        } else if (base === null) {
          return failure('missing-base', id + ' has no base commit and no target branch to resolve one from')
        }
        const current = await readBranchHead(projectPath, task)
        if (current.ok !== true) return current
        let diff
        try {
          diff = await git.diffNameOnly(projectPath, base, current.head)
        } catch (error) {
          return failure('diff-failed', 'could not list the files ' + id + ' changed: ' + messageOf(error))
        }
        if (diff === null || diff === undefined || diff.ok !== true) {
          const code = diff !== null && diff !== undefined && diff.code !== undefined && diff.code !== null ? String(diff.code) : 'diff-failed'
          const detail = diff === null || diff === undefined ? 'git returned no result' : String(diff.message)
          return failure(code, 'could not list the files ' + id + ' changed: ' + detail)
        }
        // A moved head invalidates any earlier independent-test verdict: put it
        // back to pending so the merge gate demands a fresh pass.
        const testing = read.board.dispatch === undefined || read.board.dispatch === null ? 'self' : read.board.dispatch.testing
        const verdict =
          testing === 'independent' ? { status: 'pending', by: null, at: new Date(clock()).toISOString(), output: null } : null
        const recorded = await writeTask(
          projectPath,
          id,
          (board) => refreshMergeRequest(board, id, base, current.head, Array.isArray(diff.files) ? diff.files : [], verdict, clock(), context.by),
          context,
        )
        if (recorded.ok !== true) return recorded
        // Independent testing re-runs on the refreshed head/base: the pending
        // verdict above is temporary, replaced by the host's fresh result.
        if (testing === 'independent') {
          const verified = await verifyOnHost(projectPath, recorded.task, worktreeRootOf(read.board))
          if (verified !== null) return ok({ task: verified, events: recorded.events, merge: verified.merge })
        }
        return ok({ task: recorded.task, events: recorded.events, merge: recorded.task === null ? null : recorded.task.merge })
      })
    }
    if (action === 'submit') {
      const id = String(source.id === undefined ? '' : source.id)
      if (id === '') return failure('missing-id', 'submit needs a task id')
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      const checked = taskForContext(read.board, id, context)
      if (checked.ok !== true) return checked
      // Only a running task has a worktree worth committing; any other status
      // must reach submitTask's own refusal without touching git.
      const submittedAt = clock()
      const testing = read.board.dispatch === undefined || read.board.dispatch === null ? 'self' : read.board.dispatch.testing
      const prepared =
        checked.task.status === 'running' ? await prepareMergeRequest(checked.task, source, submittedAt, testing) : { ok: true, mr: null }
      if (prepared.ok !== true) return prepared
      const input = { evidence: source.evidence, note: source.note }
      if (prepared.mr !== null) {
        input.commit = prepared.mr.commit
        input.actualFiles = prepared.mr.actualFiles
        input.merge = prepared.mr.merge
      }
      const result = await writeTask(
        projectPath,
        id,
        (board) => model.submitTask(board, id, input, clock(), context.by),
        context,
      )
      if (result.ok === true && result.task !== null && result.task.status !== 'running') {
        const released = locks.releaseTask(state.memory.locks, id)
        if (released.ok === true) state.memory.locks = released.locks
      }
      // Independent testing: the HOST verifies the branch in a throwaway
      // checkout and records the verdict; the merger hears about it only once it
      // passes. Self mode keeps the old "MR is open" notification.
      if (result.ok === true && result.task !== null && result.task !== undefined) {
        if (testing === 'independent') {
          const verified = await verifyOnHost(projectPath, result.task, worktreeRootOf(read.board))
          if (verified !== null) return Object.assign({}, result, { task: verified, merge: verified.merge })
        } else {
          await notifyMergerOpened(projectPath, result.task)
        }
      }
      return result
    }
    if (action === 'cancel') {
      const id = String(source.id === undefined ? '' : source.id)
      if (id === '') return failure('missing-id', 'cancel needs a task id')
      const result = await writeTask(
        projectPath,
        id,
        (board) => model.cancelTask(board, id, clock(), context.by, source.note),
        context,
      )
      if (result.ok === true) {
        const released = locks.releaseTask(state.memory.locks, id)
        if (released.ok === true) state.memory.locks = released.locks
      }
      return result
    }
    if (action === 'reopen' || action === 'unblock' || action === 'retry') {
      const id = String(source.id === undefined ? '' : source.id)
      if (id === '') return failure('missing-id', action + ' needs a task id')
      return writeTask(
        projectPath,
        id,
        (board) => {
          if (action === 'reopen') return model.reopenTask(board, id, clock(), context.by, source.note)
          if (action === 'unblock') return model.unblockTask(board, id, clock(), context.by, source.note)
          return model.retryTask(board, id, clock(), context.by, source.note)
        },
        context,
      )
    }
    if (action === 'block') {
      const id = String(source.id === undefined ? '' : source.id)
      if (id === '') return failure('missing-id', 'block needs a task id')
      const result = await writeTask(
        projectPath,
        id,
        (board) => model.blockTask(board, id, clock(), context.by, source.note),
        context,
      )
      if (result.ok === true) {
        const released = locks.releaseTask(state.memory.locks, id)
        if (released.ok === true) state.memory.locks = released.locks
      }
      return result
    }
    if (action === 'lock') {
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      let taskId = null
      if (source.taskId !== undefined && source.taskId !== null) taskId = String(source.taskId)
      else if (source.id !== undefined && source.id !== null) taskId = String(source.id)
      else if (ownerOf(context) !== null) {
        const owner = ownerOf(context)
        const owned = read.board.tasks.filter(
          (task) =>
            task.status === 'running' &&
            task.assignee !== null &&
            ((owner.session !== null && task.assignee.session === owner.session) ||
              (owner.name !== null && task.assignee.name === owner.name)),
        )[0]
        if (owned !== undefined) taskId = owned.id
      }
      let paths
      try {
        paths = locks.canonicalList(projectPath, source.paths === undefined ? [] : source.paths)
      } catch (error) {
        return failure('invalid-path', messageOf(error))
      }
      if (paths.length === 0) return failure('no-path', 'lock needs paths: [ ... ]')
      const owner = ownerOf(context)
      const acquired = locks.acquire(
        state.memory.locks,
        paths,
        { taskId: taskId, agent: context.by },
        clock(),
        TASK_LEASE_MS,
      )
      if (acquired.ok !== true) return acquired
      if (acquired.granted === true) state.memory.locks = acquired.locks
      const held = locks.view(state.memory.locks, read.board, clock()).filter((lock) => paths.indexOf(lock.path) >= 0)
      return ok({
        granted: acquired.granted === true,
        paths: paths,
        taskId: taskId,
        conflicts: acquired.conflicts === undefined ? [] : acquired.conflicts,
        locks: held,
        owner: owner,
      })
    }
    if (action === 'unlock') {
      let paths
      try {
        paths = locks.canonicalList(projectPath, source.paths === undefined ? [] : source.paths)
      } catch (error) {
        return failure('invalid-path', messageOf(error))
      }
      let taskId = source.taskId === undefined || source.taskId === null ? null : String(source.taskId)
      const owner = ownerOf(context)
      if (taskId === null && owner !== null) {
        const read = await readBoardOrFail(projectPath)
        if (read.failed === undefined) {
          const owned = read.board.tasks.filter(
            (task) =>
              task.status === 'running' &&
              task.assignee !== null &&
              ((owner.session !== null && task.assignee.session === owner.session) ||
                (owner.name !== null && task.assignee.name === owner.name)),
          )[0]
          if (owned !== undefined) taskId = owned.id
        }
      }
      const released = locks.release(state.memory.locks, paths, { taskId: taskId, agent: context.by })
      if (released.ok !== true) return released
      state.memory.locks = released.locks
      return ok({ released: released.released })
    }
    if (action === 'forceUnlock') {
      let paths
      try {
        paths = locks.canonicalList(projectPath, source.paths === undefined ? [] : source.paths)
      } catch (error) {
        return failure('invalid-path', messageOf(error))
      }
      const released = locks.forceRelease(state.memory.locks, paths)
      if (released.ok !== true) return released
      state.memory.locks = released.locks
      return ok({ released: released.released })
    }
    return failure('unknown-action', 'unknown action ' + String(action))
  }

  /** Set the project the panel and scheduler follow, after proving it is a
   * directory. This is the only place a caller can point the task center at a
   * new tree, and it is a user action on the route. */
  async function openProject(input) {
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    if (path === '') return failure('missing-path', 'openProject needs a path')
    const base = state.memory.projectHint === null ? process.cwd() : state.memory.projectHint
    const absolute = resolve(base, path)
    try {
      const target = await ctx.fs.resolve(absolute, { cwd: base })
      const info = await ctx.fs.stat(target)
      if (info === undefined || (info.type !== undefined && info.type !== 'directory')) {
        return failure('not-a-directory', 'not a directory: ' + path)
      }
    } catch (error) {
      return failure('invalid-project', messageOf(error))
    }
    remember(absolute)
    return snapshot(absolute)
  }

  return { perform: perform, snapshot: snapshot, actions: ACTIONS, readActions: READ_ACTIONS }
}