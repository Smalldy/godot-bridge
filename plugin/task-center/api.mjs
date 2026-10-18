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
import {
  ROLE_KINDS,
  ROLE_STAGE,
  TASK_LEASE_MS,
  WORKFLOW_STAGES,
  defaultRoleConfig,
  normaliseRoleConfig,
  validateRoleBinding,
  validateRoleProfile,
} from './schema.mjs'
import * as model from './service.mjs'
import * as locks from './locks.mjs'
import {
  MERGER_NAME,
  REVIEW_MAX_ROUNDS,
  probeWorktree,
  resolveLead,
  reviewBriefFor,
  reworkBriefFor,
  roleKindOf,
  servicesFor,
  testFailureBriefFor,
  testerBriefFor,
  workerPool,
} from './dispatch.mjs'
import { readRoleConfig, writeRoleConfig } from './board.mjs'
import { mergeEligible, recordCandidate, recordMergeResult, refreshMergeRequest, testCandidateFor } from './merge.mjs'
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
  'approveReview',
  'requestChanges',
  'passTest',
  'failTest',
  'mergeRequest',
  'refreshMerge',
  'rejectMerge',
  'harnessStart',
  'harnessStop',
  'harnessRestart',
  'harnessStatus',
  'harnessSmoke',
  'rolesList',
  'rolesCreate',
  'rolesUpdate',
  'rolesDelete',
  'rolesBind',
  'rolesDrain',
  'rolesReplace',
  'rolesReset',
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
export const USER_ONLY_ACTIONS = [
  'approveStart',
  'rejectStart',
  'settings',
  'rolesList',
  'rolesCreate',
  'rolesUpdate',
  'rolesDelete',
  'rolesBind',
  'rolesDrain',
  'rolesReplace',
  'rolesReset',
]

/** The tool's vocabulary: everything except the user-owned actions. */
export const AGENT_ACTIONS = ACTIONS.filter((action) => USER_ONLY_ACTIONS.indexOf(action) < 0)

/** Read-only actions; the tool may run them concurrently. */
export const READ_ACTIONS = ['board', 'list', 'get', 'locks', 'harnessStatus']

const STATUS_RANK = { pending: 0, running: 1, reviewing: 2, testing: 3, blocked: 4, done: 5, cancelled: 6 }

function failure(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
}

function ok(payload) {
  return Object.assign({ ok: true }, payload === undefined ? {} : payload)
}

function messageOf(error) {
  return String((error && error.message) || error)
}

/** Normalise a filesystem path for comparing worktree entries. */
function normalizePath(path) {
  return String(path === undefined || path === null ? '' : path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The task whose id is encoded in a worktree directory name, or undefined. */
function taskByWorktreeSuffix(base, board) {
  const name = String(base)
  const candidates = []
  if (name.startsWith('merge-')) candidates.push(name.slice('merge-'.length))
  if (name.startsWith('verify-')) candidates.push(name.slice('verify-'.length))
  if (name.startsWith('test-')) candidates.push(name.slice('test-'.length))
  const taskMatch = /^(T-\d+)/.exec(name)
  if (taskMatch !== null) candidates.push(taskMatch[1])
  for (const id of candidates) {
    const task = board.tasks.filter((entry) => entry.id === id)[0]
    if (task !== undefined) return task
  }
  return undefined
}

/** True when a task currently occupies its worktree. */
function worktreeTaskActive(task) {
  return task !== undefined && task !== null && (task.status === 'running' || task.status === 'reviewing' || task.status === 'testing')
}

function emptyWorktrees(error) {
  return {
    available: false,
    error: error === undefined ? null : error,
    total: 0,
    active: 0,
    counts: { main: 0, task: 0, verify: 0, test: 0, merge: 0, other: 0 },
    worktrees: [],
  }
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
 * @param options.roles - the role registry/provisioner (createRoleManager). When
 *   present, review/test verdicts are role-gated and stage transitions provision
 *   the reviewer/tester role; absent keeps the legacy permissive surface used by
 *   direct API callers.
 * @param options.autoMerge - true enables the host-driven merge sweep
 *   (autoMergePending): a ready open request is merged without any model
 *   action. Off by default so direct API users stay explicit.
 * @param options.godotPath - engine path shown in the tester brief. Omitted means
 *   "the godot-bridge godotPath setting, or godot on PATH".
 * @param options.harness - the isolated DSH test instance manager (harness.mjs).
 *   When present, the tester (or the user) can start/stop/restart it and run the
 *   smoke checks; absent refuses readably.
 * @param options.activity - the host activity ring (createActivity). The snapshot
 *   exposes its recent entries; absent means the panel simply has no history.
 * @param options.now - clock, for tests.
 */
export function createApi(ctx, options) {
  const opts = options === undefined ? {} : options
  const state = opts.state
  const scheduler = opts.scheduler === undefined ? null : opts.scheduler
  const git = opts.git === undefined ? null : opts.git
  const merger = opts.merger === undefined ? null : opts.merger
  const roles = opts.roles === undefined ? null : opts.roles
  const autoMerge = opts.autoMerge === true
  // The independent tester workflow (candidate checkout + host auto-merge) is
  // active when the production row wires the role registry and merge queue.
  const candidateWorkflow = roles !== null && merger !== null && typeof merger.createCandidate === 'function'
  const godotPath = typeof opts.godotPath === 'string' && opts.godotPath.length > 0 ? opts.godotPath : null
  const harness = opts.harness === undefined ? null : opts.harness
  const activity = opts.activity === undefined || opts.activity === null ? null : opts.activity
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

  /** The caller's Team membership and role kind, when the registry is active. */
  function callerRole(context) {
    const member = callerMemberOf(context)
    if (member === null) return null
    return { member: member, kind: roleKindOf(member.name) }
  }

  function isAssignee(task, member) {
    if (task === null || task === undefined || task.assignee === null || task.assignee === undefined || member === null) return false
    const sessionMatch = member.id !== undefined && member.id !== null && task.assignee.session !== null && task.assignee.session !== undefined && String(member.id) === String(task.assignee.session)
    const nameMatch = member.name !== undefined && member.name !== null && task.assignee.name === member.name
    return sessionMatch || nameMatch
  }

  /**
   * A review/test verdict belongs to the corresponding role (or the user).
   * This is the role gate: a worker cannot approve its own work, a reviewer
   * cannot pass tests, and a tester cannot review. Only active when the role
   * registry is wired in (the production row always does).
   */
  function verdictRefusal(context, task, kind) {
    if (roles === null) return null
    if (context !== undefined && context !== null && context.role === 'user') return null
    const caller = callerRole(context)
    if (caller === null) {
      return failure('role-required', 'Only a ' + kind + ' role member or the user can record this verdict.')
    }
    if (isAssignee(task, caller.member)) {
      return failure(
        kind === 'reviewer' ? 'worker-cannot-self-review' : 'worker-cannot-self-test',
        'The assignee cannot record its own ' + (kind === 'reviewer' ? 'review' : 'test') + ' verdict; an independent ' + kind + ' must.',
      )
    }
    if (caller.kind !== kind) {
      return failure('wrong-role', 'Only a ' + kind + ' role member or the user can record this verdict; ' + String(caller.member.name === undefined || caller.member.name === null ? 'this agent' : caller.member.name) + ' is not one.')
    }
    return null
  }

  /** The dispatch worktree root of one board. */
  function worktreeRootOf(board) {
    const settings = board === undefined || board === null || board.dispatch === undefined || board.dispatch === null ? null : board.dispatch.worktree
    return settings !== null && settings !== undefined && typeof settings.root === 'string' && settings.root.length > 0 ? settings.root : '.worktrees'
  }

  /** The candidate checkout of a task in testing, for the panel and the brief. */
  function candidateOf(projectPath, board, task) {
    if (task === null || task === undefined || task.status !== 'testing') return null
    const merge = task.merge
    if (merge === null || merge === undefined || typeof merge !== 'object' || typeof merge.mergeCommit !== 'string' || merge.mergeCommit.length === 0) return null
    const candidate = testCandidateFor(projectPath, worktreeRootOf(board), task.id)
    return { path: candidate.path, branch: candidate.branch, base: typeof task.base === 'string' ? task.base : null, head: merge.mergeCommit }
  }

  /** Is the project (or its candidate checkout) a Godot project? Used by the tester brief. */
  async function godotInfoFor(projectPath, candidatePath) {
    const files = []
    if (typeof candidatePath === 'string' && candidatePath.length > 0) files.push(join(candidatePath, 'project.godot'))
    if (typeof projectPath === 'string' && projectPath.length > 0) files.push(join(projectPath, 'project.godot'))
    if (ctx === undefined || ctx === null || ctx.fs === undefined || ctx.fs === null) return { project: false }
    for (const file of files) {
      try {
        const target = await ctx.fs.resolve(file, { cwd: projectPath })
        const info = await ctx.fs.stat(target)
        if (info !== undefined) return { project: true, projectFile: file, enginePath: godotPath }
      } catch (error) {
        // Not there; try the next location.
      }
    }
    return { project: false }
  }

  /**
   * Merge the tester-accepted candidate. On a moved target the verdict is
   * invalidated: the old candidate is discarded, a new one is built from the
   * current target head, the test round resets and the tester is asked to retest.
   */
  async function mergeTestedCandidate(projectPath, id, by, context) {
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const task = model.findTask(read.board, id)
    if (task === undefined) return failure('unknown-task', 'no task with id ' + id)
    const root = worktreeRootOf(read.board)
    const outcome = await serialised(() => merger.mergeCandidate(task, projectPath, { worktreeRoot: root }))
    if (outcome === null || outcome === undefined || outcome.ok !== true) {
      return failure(
        outcome === null || outcome === undefined ? 'merge-failed' : String(outcome.code),
        outcome === null || outcome === undefined ? 'the merge queue returned no result' : String(outcome.message),
      )
    }
    if (outcome.status === 'merged') {
      const recorded = await writeTask(
        projectPath,
        id,
        (board) => recordMergeResult(board, id, { status: 'merged', mergeCommit: outcome.mergeCommit, conflict: null, output: null }, clock(), by),
        context,
      )
      if (recorded.ok !== true) return recorded
      await notifyMergeOutcome(projectPath, recorded.task)
      emitActivity(context, 'merge', 'merged as ' + String(outcome.mergeCommit) + ' (tested candidate)', id)
      if (outcome.candidateRemoved === true) emitActivity(null, 'worktree-remove', 'test candidate removed after merge', id, 'host')
      if (outcome.taskWorktreeRemoved === true) emitActivity(null, 'worktree-remove', 'task worktree removed after merge', id, 'host')
      recorded.merged = true
      recorded.retest = false
      return recorded
    }
    if (outcome.status === 'stale') {
      await serialised(() => merger.discardCandidate(task, projectPath, { worktreeRoot: root }))
      emitActivity(null, 'worktree-remove', 'stale test candidate discarded', id, 'system')
      const rebuilt = await serialised(() => merger.createCandidate(task, projectPath, { worktreeRoot: root }))
      if (rebuilt !== null && rebuilt !== undefined && rebuilt.ok === true) {
        emitActivity(null, 'worktree-create', 'rebuilt test candidate', id, 'system')
        emitActivity(null, 'test-start', 'target moved; retest required', id, 'host')
      }
      if (rebuilt === null || rebuilt === undefined || rebuilt.ok !== true) {
        return failure(
          rebuilt === null || rebuilt === undefined ? 'candidate-failed' : String(rebuilt.code),
          rebuilt === null || rebuilt === undefined ? 'could not rebuild the test candidate' : String(rebuilt.message),
        )
      }
      const recorded = await writeTask(
        projectPath,
        id,
        (board) => recordCandidate(board, id, rebuilt, clock(), { retest: true, by: by }),
        context,
      )
      if (recorded.ok !== true) return recorded
      recorded.merged = false
      recorded.retest = true
      recorded.candidate = rebuilt
      const provisioned = await provisionRole('tester', projectPath, recorded.task)
      if (provisioned !== null) recorded.provisioned = provisioned
      const tester = roleSlotNameOf('tester')
      if (tester !== null) {
        await notifyMember(tester, testerBriefFor(recorded.task, projectPath, rebuilt, { godot: await godotInfoFor(projectPath, rebuilt.path) }))
      }
      return recorded
    }
    return failure('merge-failed', 'the candidate merge returned an unexpected status ' + String(outcome.status))
  }

  /** Read the project role config (defaults if absent/broken). */
  async function roleConfigFor(projectPath) {
    try {
      const read = await readRoleConfig({ fs: ctx.fs }, { projectPath: projectPath })
      return read.config
    } catch (error) {
      return null
    }
  }

  /** Best-effort host provisioning for one stage role. Never blocks the action. */
  async function provisionRole(kind, projectPath, task) {
    if (roles === null || typeof roles.ensure !== 'function') return null
    const config = await roleConfigFor(projectPath)
    try {
      const ensured = await roles.ensure(kind, { config: config === null ? undefined : config, projectPath: projectPath, task: task, now: clock() })
      emitRoleProvision(ensured)
      return ensured
    } catch (error) {
      return { ok: false, code: 'role-ensure-failed', message: messageOf(error) }
    }
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
   * The isolated DSH harness belongs to the tester (or the user). No other agent
   * can start, stop or probe it; without a role registry only the user may.
   */
  function harnessRefusal(context) {
    if (context !== undefined && context !== null && context.role === 'user') return null
    if (roles === null) {
      return failure('tester-only', 'The isolated DSH harness is driven by the tester role (or the user); this profile has no role registry.')
    }
    const caller = callerRole(context)
    if (caller === null) return failure('role-required', 'Only a tester role member or the user can drive the isolated DSH harness.')
    if (caller.kind !== 'tester') {
      const name = caller.member.name === undefined || caller.member.name === null ? 'this agent' : String(caller.member.name)
      return failure('tester-only', 'Only a tester role member or the user can drive the isolated DSH harness; ' + name + ' is not one.')
    }
    return null
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
      'Merge request ' + task.id + ' (' + task.title + ') is open and entering review.',
      '  branch: ' + String(task.branch === null || task.branch === undefined ? '' : task.branch),
      '  target: ' + String(merge.target === null || merge.target === undefined ? '' : merge.target),
      '  project: ' + String(projectPath),
      '  owner: ' + owner,
      '',
      'Track it with task_center { action: "board" } or { action: "get", id: "' + task.id + '" }.',
      'It becomes mergeable once its review is approved and its test phase passes; the host merges it automatically.',
      'mergeRequest stays available as a manual entry (merger-only) and rejectMerge can close the request.',
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

  /** The live member of a role kind (reviewer, tester, worker), or null. */
  function roleSlotNameOf(kind) {
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
    const member = members.filter(
      (entry) => entry !== null && typeof entry === 'object' && roleKindOf(entry.name) === kind && entry.status !== 'failed',
    )[0]
    return member === undefined ? null : String(member.name)
  }

  /**
   * Host policy: a task that keeps coming back from review is blocked for
   * triage instead of looping forever. Returns the blocked task detail or null
   * when the task is within the round budget.
   */
  async function enforceReviewRoundLimit(projectPath, task) {
    if (task === null || task === undefined || task.review === null || task.review === undefined) return null
    if (!(task.review.attempt > REVIEW_MAX_ROUNDS)) return null
    const systemContext = { projectPath: projectPath, by: 'system', role: 'user', agent: null }
    const blocked = await writeTask(
      projectPath,
      task.id,
      (board) =>
        model.blockTask(board, task.id, clock(), 'system', 'review round limit reached (' + String(REVIEW_MAX_ROUNDS) + '); blocked for triage'),
      systemContext,
    )
    if (blocked.ok !== true) return null
    emitActivity(null, 'error', 'review round limit reached; task blocked', task.id, 'system')
    const owner =
      task.assignee === null || task.assignee === undefined || typeof task.assignee.name !== 'string' || task.assignee.name === ''
        ? null
        : task.assignee.name
    if (owner !== null) {
      await notifyMember(
        owner,
        'Task ' + task.id + ' was blocked after ' + String(REVIEW_MAX_ROUNDS) + ' review rounds without approval. Read the review reasons on the board and ask the Lead for triage.',
      )
    }
    return blocked
  }

  /** Release the locks of a submitted task; called after any stage change. */
  function releaseTaskLocks(taskId) {
    const released = locks.releaseTask(state.memory.locks, taskId)
    if (released.ok === true) state.memory.locks = released.locks
  }

  /**
   * Record one host activity entry. Actors stay explicit: 'system' for host
   * automation (sweeps, timeouts), 'host' for scheduler/host work, 'agent' for a
   * model-driven action (with the agent's name). Never dresses System up as Agent.
   */
  function emitActivity(context, kind, detail, taskId, override) {
    if (activity === null || typeof activity.push !== 'function') return
    let actor = 'host'
    if (override === 'system' || override === 'host' || override === 'agent') actor = override
    else if (context !== undefined && context !== null && context.role === 'agent') actor = 'agent'
    const agentName = context !== undefined && context !== null && typeof context.by === 'string' && context.by !== '' ? context.by : null
    activity.push({
      kind: kind,
      actor: actor,
      actorName: actor === 'agent' ? agentName : null,
      taskId: typeof taskId === 'string' && taskId !== '' ? taskId : null,
      detail: typeof detail === 'string' ? detail : null,
    })
  }

  /** Role provisioning is a SYSTEM event. */
  function emitRoleProvision(result) {
    if (result === null || result === undefined) return
    const created = Array.isArray(result.created) ? result.created.map((entry) => entry.name) : []
    const replaced = Array.isArray(result.replaced) ? result.replaced.map((entry) => String(entry.name) + (entry.reason === undefined ? '' : ' (' + String(entry.reason) + ')')) : []
    if (created.length > 0) emitActivity(null, 'role-provision', String(result.kind) + ' ' + created.join(', '), null, 'system')
    if (replaced.length > 0) emitActivity(null, 'role-replace', String(result.kind) + ' ' + replaced.join(', '), null, 'system')
  }

  /**
   * The git worktree inventory for the status panel, classified as
   * main/task/verify/test/merge/other with branch/head and whether a task is
   * currently occupying it. Degrades readably without a git facade.
   */
  async function worktreeSnapshot(projectPath, board) {
    if (git === null || typeof git.worktreeList !== 'function') return emptyWorktrees('no-git-service')
    let result = null
    try {
      result = await git.worktreeList(projectPath)
    } catch (error) {
      return emptyWorktrees('git-failed')
    }
    if (result === null || result === undefined || result.ok !== true) {
      return emptyWorktrees(result !== null && result !== undefined && typeof result.code === 'string' ? result.code : 'worktree-list-failed')
    }
    const entries = Array.isArray(result.worktrees) ? result.worktrees : []
    const main = normalizePath(projectPath)
    const byPath = new Map()
    for (const task of board.tasks) {
      if (typeof task.worktree === 'string' && task.worktree !== '') byPath.set(normalizePath(task.worktree), task)
    }
    const worktrees = entries.map((entry) => {
      const raw = typeof entry.path === 'string' ? entry.path : ''
      const normalized = normalizePath(raw)
      // Keep the basename's original case: task ids are case-sensitive.
      const base = String(raw).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || ''
      const lowerBase = base.toLowerCase()
      const byWorktree = byPath.get(normalized)
      const task = byWorktree === undefined ? taskByWorktreeSuffix(base, board) : byWorktree
      let type = 'other'
      if (normalized === main) type = 'main'
      else if (byWorktree !== undefined) type = 'task'
      else if (lowerBase.startsWith('merge-')) type = 'merge'
      else if (lowerBase.startsWith('verify-')) type = 'verify'
      else if (lowerBase.startsWith('test-')) type = 'test'
      else if (/^T-\d+(-\d+)?$/.test(base)) type = 'task'
      return {
        path: raw,
        type: type,
        branch: typeof entry.branch === 'string' && entry.branch !== '' ? entry.branch : null,
        head: typeof entry.head === 'string' && entry.head !== '' ? entry.head : null,
        taskId: task === undefined ? null : task.id,
        active: type === 'main' ? true : worktreeTaskActive(task),
      }
    })
    const counts = { main: 0, task: 0, verify: 0, test: 0, merge: 0, other: 0 }
    let active = 0
    for (const worktree of worktrees) {
      counts[worktree.type] = (counts[worktree.type] === undefined ? 1 : counts[worktree.type] + 1)
      if (worktree.active === true) active += 1
    }
    return { available: true, error: null, total: worktrees.length, active: active, counts: counts, worktrees: worktrees }
  }

  /** The in-memory activity ring for the snapshot (newest first). */
  function activitySnapshot() {
    if (activity === null || typeof activity.snapshot !== 'function') {
      return { available: false, limit: 0, count: 0, pushed: 0, actors: { system: 0, host: 0, agent: 0 }, entries: [] }
    }
    return Object.assign({ available: true }, activity.snapshot())
  }

  /** Live role-slot instances (worker-N/reviewer-N/tester-N) for the role panel. */
  function roleInstanceList() {
    const { agentTeams } = servicesFor(ctx)
    if (agentTeams === undefined || agentTeams === null) return { available: false, error: 'no-team-service', instances: [], manager: null }
    const lead = resolveLead(ctx)
    if (lead === null) return { available: false, error: 'no-lead', instances: [], manager: null }
    let roster = []
    try {
      roster = agentTeams.listMembers(lead)
    } catch (error) {
      return { available: false, error: 'roster-unreadable', instances: [], manager: null }
    }
    const instances = (Array.isArray(roster) ? roster : [])
      .filter((member) => member !== null && typeof member === 'object' && typeof member.name === 'string' && roleKindOf(member.name) !== null)
      .map((member) => ({
        name: String(member.name),
        kind: roleKindOf(member.name),
        id: member.id === undefined || member.id === null ? null : String(member.id),
        status: String(member.status === undefined || member.status === null ? 'unknown' : member.status),
        description: typeof member.description === 'string' ? member.description : null,
      }))
    return { available: true, error: null, instances: instances, manager: roles === null ? null : roles.status() }
  }

  function roleAdminRefusal(context) {
    if (context !== undefined && context !== null && context.role === 'user') return null
    return failure('user-only', 'Role profiles belong to the user; manage them from the task center panel.')
  }

  async function persistRoles(projectPath, config) {
    const written = await writeRoleConfig({ fs: ctx.fs }, { projectPath: projectPath, config: config })
    return written
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
    // Reconcile the in-memory locks against THIS board read before doing any
    // further await: a long git/fs read in between could let the dispatcher claim
    // a pending task, and the stale board would then drop its locks.
    state.sweepLocks()
    reconcileLocks(board)
    const roleRead = await readRoleConfig({ fs: ctx.fs }, { projectPath: projectPath })
    const workers = workerPool(ctx, board, { roleConfig: roleRead.config })
    const worktrees = await worktreeSnapshot(projectPath, board)
    const tasks = board.tasks
      .slice()
      .sort((left, right) => {
        const rank = STATUS_RANK[left.status] - STATUS_RANK[right.status]
        return rank !== 0 ? rank : left.id.localeCompare(right.id)
      })
      .map((task) => Object.assign(detailOf(board, task, now), { candidate: candidateOf(projectPath, board, task) }))
    return ok({
      project: projectPath,
      version: board.version,
      seq: board.seq,
      updatedAt: board.updatedAt,
      dispatch: board.dispatch,
      roles: roleRead.config,
      workers: workers,
      // Agents are the live Team members (lead + teammates), with their kind,
      // session and current task. System/host work is NOT listed here.
      agents: {
        lead: workers.leadInfo,
        members: workers.members,
        kinds: workers.kinds,
        roles: workers.roles,
      },
      worktrees: worktrees,
      activity: activitySnapshot(),
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
  async function prepareMergeRequest(task, source, now) {
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
        },
      },
    }
  }

  /**
   * One merge pipeline: re-read, validate, gate on the review/test phases,
   * run the queue, record the outcome. Shared by the explicit mergeRequest
   * action and the host-driven sweep, so both follow exactly the same rules.
   */
  async function mergeOne(projectPath, id, by, context, actorOverride) {
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const task = model.findTask(read.board, id)
    if (task === undefined) return failure('unknown-task', 'no task with id ' + id)
    const merge = task.merge
    if (merge === null || merge === undefined || typeof merge !== 'object' || merge.status !== 'open') {
      return failure('no-open-merge', id + ' has no open merge request')
    }
    if (merger === null || (typeof merger.mergeRequest !== 'function' && typeof merger.mergeCandidate !== 'function')) {
      return failure('no-merge-service', 'the merge queue is not available in this profile')
    }
    // Tester workflow: the candidate was built at review approval and tested
    // independently; a passed test now merges that exact tree (no verify).
    if (candidateWorkflow && mergeEligible(task) && typeof merge.mergeCommit === 'string' && merge.mergeCommit.length > 0) {
      return mergeTestedCandidate(projectPath, id, by, context)
    }
    // The phase machine is the merge gate: only a task in TESTING whose test
    // phase passed may reach the queue. A submission under review, or a failed
    // test, refuses here before any git read — no integration worktree, no
    // verification, no main change.
    if (!mergeEligible(task)) {
      if (task.status === 'reviewing') {
        return failure('review-required', id + ' is still in review; approve the review and pass its tests before merging.')
      }
      if (task.status === 'testing') {
        const review = task.review
        if (review === null || review === undefined || review.status !== 'approved') {
          return failure('review-required', id + ' is testing but its review was not approved; approve the review before merging.')
        }
        const test = task.test
        const status = test === null || test === undefined ? 'pending' : String(test.status)
        if (status === 'failed') {
          const evidence = typeof test.evidence === 'string' && test.evidence !== '' ? ' Reported evidence: ' + test.evidence : ''
          return failure('test-failed', id + ' failed its test phase; fix the branch and submit it again.' + evidence)
        }
        return failure('test-required', id + ' needs a passing test phase before it can be merged (test: ' + status + ').')
      }
      return failure('not-mergeable-phase', id + ' is ' + task.status + '; only a task in testing with a passed test can be merged.')
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
    const settings = read.board.dispatch === undefined || read.board.dispatch === null ? null : read.board.dispatch.worktree
    const worktreeRoot = settings !== null && settings !== undefined && typeof settings.root === 'string' ? settings.root : '.worktrees'
    const outcome = await merger.mergeRequest(task, projectPath, { worktreeRoot: worktreeRoot })
    if (outcome === null || outcome === undefined || outcome.ok !== true) {
      emitActivity(context, 'error', 'merge failed: ' + (outcome === null || outcome === undefined ? 'no result' : String(outcome.message)), id, actorOverride)
      return failure(
        outcome === null || outcome === undefined ? 'merge-failed' : String(outcome.code),
        outcome === null || outcome === undefined ? 'the merge queue returned no result' : String(outcome.message),
      )
    }
    // Only a queue outcome that actually created the integration checkout reports
    // worktree activity; preconditions that refuse before creating it report none.
    const integration = outcome.integration !== undefined && outcome.integration !== null ? outcome.integration : null
    if (integration !== null && integration.created === true) {
      emitActivity(context, 'worktree-create', 'merge worktree ' + String(integration.path), id, actorOverride)
      emitActivity(context, 'worktree-remove', 'merge worktree cleaned', id, actorOverride)
    }
    const recorded = await writeTask(projectPath, id, (board) => recordMergeResult(board, id, outcome, clock(), by), context)
    if (recorded.ok !== true) return recorded
    emitActivity(context, 'merge', String(outcome.status) + (outcome.mergeCommit !== undefined && outcome.mergeCommit !== null ? ' as ' + String(outcome.mergeCommit) : ''), id, actorOverride)
    if (outcome.status === 'merged' && outcome.taskWorktreeRemoved === true) {
      emitActivity(null, 'worktree-remove', 'task worktree removed after merge', id, 'host')
    }
    return ok({ task: recorded.task, events: recorded.events, merge: recorded.task === null ? null : recorded.task.merge })
  }
  /**
   * The host-driven merge sweep: merge every request that is ready RIGHT NOW.
   * State-driven and idempotent — it re-reads the board, so an already merged
   * (or no longer open, or not yet through review/testing) request simply drops
   * out. The index row calls this on a timer, which is what lets a passed test
   * integrate without any model action.
   */
  async function autoMergePending(projectPath) {
    if (autoMerge !== true) return ok({ merged: [], skipped: [], disabled: true })
    if (merger === null) return ok({ merged: [], skipped: [], disabled: true })
    const read = await readBoardOrFail(projectPath)
    if (read.failed !== undefined) return read.failed
    const candidates = read.board.tasks
      .filter((task) => mergeEligible(task))
      .map((task) => task.id)
      .sort()
    const merged = []
    const skipped = []
    const systemContext = { projectPath: projectPath, by: 'system', role: 'user', agent: null }
    for (const id of candidates) {
      let result = null
      try {
        result = await serialised(() => mergeOne(projectPath, id, 'system', systemContext, 'system'))
      } catch (error) {
        result = failure('merge-error', messageOf(error))
      }
      if (result.ok === true && result.merged === false) {
        skipped.push({ id: id, code: result.retest === true ? 'retest' : 'merge-pending' })
        continue
      }
      if (result.ok === true) {
        merged.push(id)
        if (result.task !== null && result.task !== undefined) await notifyMergeOutcome(projectPath, result.task)
      } else {
        skipped.push({ id: id, code: result.code === undefined || result.code === null ? 'merge-refused' : String(result.code) })
      }
    }
    emitActivity(null, 'sweep', 'merge sweep: merged ' + (merged.length === 0 ? 'none' : merged.join(',')) + '; skipped ' + String(skipped.length), null, 'system')
    return ok({ merged: merged, skipped: skipped })
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

    if (action.indexOf('roles') === 0 && USER_ONLY_ACTIONS.indexOf(action) >= 0) {
      const denied = roleAdminRefusal(context)
      if (denied !== null) return denied
      const read = await readRoleConfig({ fs: ctx.fs }, { projectPath: projectPath })
      const current = read.config
      if (action === 'rolesList') {
        return ok({
          source: read.source,
          error: read.error,
          config: current,
          stages: current.stages,
          defaults: defaultRoleConfig(),
          instances: roleInstanceList(),
        })
      }
      if (action === 'rolesCreate' || action === 'rolesUpdate') {
        const name = String(source.name === undefined ? '' : source.name)
        const profileInput = source.profile !== undefined && source.profile !== null && typeof source.profile === 'object' && !Array.isArray(source.profile) ? source.profile : {}
        let merged = null
        if (action === 'rolesCreate') {
          if (name === '') return failure('missing-name', 'rolesCreate needs a profile name')
          if (current.profiles[name] !== undefined) return failure('role-exists', name + ' already exists; use rolesUpdate to edit it')
          merged = Object.assign({}, profileInput)
          if (merged.role === undefined && merged.kind === undefined && ROLE_KINDS.indexOf(name) >= 0) merged.role = name
        } else {
          if (current.profiles[name] === undefined) return failure('unknown-role-profile', 'no role profile named ' + name)
          const existing = current.profiles[name]
          merged = Object.assign(
            {
              role: existing.role,
              stage: existing.stage,
              instances: existing.instances,
              skills: existing.skills,
              context: existing.context,
              permissions: existing.permissions,
              prompt: existing.prompt,
            },
            profileInput,
          )
        }
        const validated = validateRoleProfile(name, merged)
        if (validated.ok !== true) return validated
        const config = normaliseRoleConfig(
          Object.assign({}, current, { profiles: Object.assign({}, current.profiles, { [name]: validated.profile }) }),
        )
        const written = await persistRoles(projectPath, config)
        if (written.ok !== true) return written
        emitActivity(context, 'role-config', action + ' ' + name, null)
        return ok({ config: written.config, profile: written.config.profiles[name], source: 'file' })
      }
      if (action === 'rolesDelete') {
        const name = String(source.name === undefined ? '' : source.name)
        if (current.profiles[name] === undefined) return failure('unknown-role-profile', 'no role profile named ' + name)
        if (ROLE_KINDS.indexOf(name) >= 0) {
          return failure('default-profile', 'the built-in ' + name + ' profile cannot be deleted; update it or reset the defaults')
        }
        const profiles = Object.assign({}, current.profiles)
        delete profiles[name]
        const stages = Object.assign({}, current.stages)
        for (const stage of WORKFLOW_STAGES) {
          if (stages[stage] === name) stages[stage] = { implement: 'worker', review: 'reviewer', test: 'tester' }[stage]
        }
        const config = normaliseRoleConfig(Object.assign({}, current, { profiles: profiles, stages: stages }))
        const written = await persistRoles(projectPath, config)
        if (written.ok !== true) return written
        emitActivity(context, 'role-config', 'deleted profile ' + name, null)
        return ok({ config: written.config, deleted: name, source: 'file' })
      }
      if (action === 'rolesBind') {
        const stage = String(source.stage === undefined ? '' : source.stage)
        const name = String(source.profile !== undefined ? source.profile : source.name === undefined ? '' : source.name)
        const validated = validateRoleBinding(current, stage, name)
        if (validated.ok !== true) return validated
        const config = normaliseRoleConfig(Object.assign({}, current, { stages: Object.assign({}, current.stages, { [stage]: name }) }))
        const written = await persistRoles(projectPath, config)
        if (written.ok !== true) return written
        emitActivity(context, 'role-config', 'bound ' + stage + ' to ' + name, null)
        return ok({ config: written.config, bound: { stage: stage, profile: name }, source: 'file' })
      }
      if (action === 'rolesDrain' || action === 'rolesReplace') {
        if (roles === null || typeof roles.drain !== 'function') {
          return failure('roles-unavailable', 'the role manager is not available in this profile')
        }
        const requested = String(source.name === undefined ? '' : source.name)
        let kind = roleKindOf(requested)
        let drained = []
        if (kind !== null) {
          const result = roles.drain(requested)
          if (result.ok !== true) return result
          drained = Array.isArray(result.drained) ? result.drained : [requested]
        } else if (action === 'rolesReplace' && ROLE_KINDS.indexOf(requested) >= 0) {
          kind = requested
          if (typeof roles.drainKind === 'function') {
            const result = await roles.drainKind(requested)
            if (result.ok !== true) return result
            drained = Array.isArray(result.drained) ? result.drained : []
          }
        } else {
          return failure('invalid-role-instance', 'name a role instance (worker-1/reviewer-2/tester-3) or, for replace, a role kind')
        }
        if (action === 'rolesDrain') {
          emitActivity(context, 'role-config', 'drained ' + requested, null)
          return ok({ drained: drained, kind: kind, status: roles.status(), instances: roleInstanceList() })
        }
        const ensured = await roles.ensure(kind, { config: current, projectPath: projectPath, task: null, now: clock() })
        emitRoleProvision(ensured)
        if (ensured.ok !== true) return Object.assign({}, ensured, { drained: drained })
        emitActivity(context, 'role-config', 'replaced ' + kind + ' instance(s)', null)
        return ok({
          kind: kind,
          drained: drained,
          created: ensured.created,
          reused: ensured.reused,
          replaced: ensured.replaced,
          status: roles.status(),
          instances: roleInstanceList(),
        })
      }
      if (action === 'rolesReset') {
        const config = defaultRoleConfig()
        const written = await persistRoles(projectPath, config)
        if (written.ok !== true) return written
        emitActivity(context, 'role-config', 'reset role profiles to the defaults', null)
        const ensured = []
        if (roles !== null && typeof roles.ensure === 'function') {
          for (const kind of ROLE_KINDS) {
            const result = await roles.ensure(kind, { config: config, projectPath: projectPath, task: null, now: clock() })
            emitRoleProvision(result)
            ensured.push({ kind: kind, result: result })
          }
        }
        return ok({ config: written.config, source: 'default', ensured: ensured, instances: roleInstanceList() })
      }
      return failure('unknown-action', 'unknown role action ' + String(action))
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
        task: Object.assign(detailOf(read.board, task, now), { candidate: candidateOf(projectPath, read.board, task) }),
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
      for (const key of ['maxConcurrent', 'allowSpawn', 'maxWorkAgents', 'maxAttempts']) {
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
      const result = await serialised(() => mergeOne(projectPath, id, context.by, context))
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
        if (task.status === 'pending' || task.status === 'running' || task.status === 'blocked' || task.status === 'cancelled') {
          return failure('not-mergeable-phase', id + ' is ' + task.status + '; only a submitted task has a merge request')
        }
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
        emitActivity(context, 'merge', 'rejected', id)
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
        if (task.status === 'pending' || task.status === 'running' || task.status === 'blocked' || task.status === 'cancelled') {
          return failure('not-mergeable-phase', id + ' is ' + task.status + '; only a submitted task has a merge request to refresh')
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
        // A new head/base starts a fresh review round: the previous decisions
        // were taken on a different tree, so refreshMergeRequest resets the
        // phases and the queue waits for review + tests again. Ensure the
        // reviewer before the write so the scheduler's stage pass cannot race.
        const provisioned = await provisionRole('reviewer', projectPath, task)
        const recorded = await writeTask(
          projectPath,
          id,
          (board) => refreshMergeRequest(board, id, base, current.head, Array.isArray(diff.files) ? diff.files : [], clock(), context.by),
          context,
        )
        if (recorded.ok !== true) return recorded
        // A refreshed head starts a fresh review round: ensure the reviewer and
        // send it the new brief, exactly like a submit would.
        if (recorded.task !== null && recorded.task !== undefined && recorded.task.status === 'reviewing') {
          const round = recorded.task.review === null || recorded.task.review === undefined ? 1 : recorded.task.review.attempt
          emitActivity(context, 'review-start', 'merge request refreshed; review round ' + String(round), id)
          const reviewer = roleSlotNameOf('reviewer')
          if (reviewer !== null) await notifyMember(reviewer, reviewBriefFor(recorded.task, projectPath))
          return ok({ task: recorded.task, events: recorded.events, merge: recorded.task.merge, provisioned: provisioned })
        }
        return ok({ task: recorded.task, events: recorded.events, merge: recorded.task === null ? null : recorded.task.merge })
      })
    }
    if (action === 'submit') {
      const id = String(source.id === undefined ? '' : source.id)
      if (id === '') return failure('missing-id', 'submit needs a task id')
      if (roles !== null) {
        const caller = callerRole(context)
        if (caller !== null && (caller.kind === 'reviewer' || caller.kind === 'tester')) {
          return failure('role-cannot-implement', 'A ' + caller.kind + ' role cannot submit implementation work; only the task\'s worker may submit.')
        }
      }
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      const checked = taskForContext(read.board, id, context)
      if (checked.ok !== true) return checked
      // Only a running task has a worktree worth committing; any other status
      // must reach submitTask's own refusal without touching git.
      const submittedAt = clock()
      const prepared = checked.task.status === 'running' ? await prepareMergeRequest(checked.task, source, submittedAt) : { ok: true, mr: null }
      if (prepared.ok !== true) return prepared
      // Ensure the reviewer BEFORE the stage write: the write kicks the scheduler,
      // whose stage-role pass would otherwise race this provisioning and report
      // "reused" to a caller that expects "created".
      const willReview = checked.task.status === 'running'
      const nextReviewAttempt =
        checked.task.review === null || checked.task.review === undefined ? 1 : checked.task.review.attempt + 1
      let provisioned = null
      if (willReview && nextReviewAttempt <= REVIEW_MAX_ROUNDS) {
        provisioned = await provisionRole('reviewer', projectPath, checked.task)
      }
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
      // The request is now in review: a task that exhausted its review rounds is
      // blocked for triage, otherwise the host provisions the reviewer and hands
      // it this round's brief. Notifications never change the answer.
      if (result.ok === true && result.task !== null && result.task !== undefined) {
        await notifyMergerOpened(projectPath, result.task)
        if (result.task.status === 'reviewing') {
          const overLimit = await enforceReviewRoundLimit(projectPath, result.task)
          if (overLimit !== null && overLimit.ok === true) {
            releaseTaskLocks(id)
            return overLimit
          }
          const round = result.task.review === null || result.task.review === undefined ? 1 : result.task.review.attempt
          emitActivity(context, 'review-start', 'submitted for review round ' + String(round), id)
          const reviewer = roleSlotNameOf('reviewer')
          if (reviewer !== null) await notifyMember(reviewer, reviewBriefFor(result.task, projectPath))
          if (provisioned !== null) result.provisioned = provisioned
        }
      }
      return result
    }
    if (action === 'approveReview' || action === 'requestChanges') {
      const id = String(source.id === undefined ? '' : source.id)
      if (id === '') return failure('missing-id', action + ' needs a task id')
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      const reviewTask = model.findTask(read.board, id)
      if (reviewTask === undefined) return failure('unknown-task', 'no task with id ' + id)
      const reviewRefused = verdictRefusal(context, reviewTask, 'reviewer')
      if (reviewRefused !== null) return reviewRefused
      // Build the independent test candidate BEFORE the phase moves: a conflict
      // is a readable refusal and the task stays in review for a changes request.
      let candidate = null
      if (action === 'approveReview' && candidateWorkflow) {
        candidate = await serialised(() => merger.createCandidate(reviewTask, projectPath, { worktreeRoot: worktreeRootOf(read.board) }))
        if (candidate === null || candidate === undefined || candidate.ok !== true) {
          return failure(
            candidate === null || candidate === undefined || candidate.code === undefined ? 'candidate-failed' : String(candidate.code),
            candidate === null || candidate === undefined || candidate.message === undefined ? 'could not build the test candidate' : String(candidate.message),
            candidate !== null && candidate !== undefined && candidate.conflict ? { conflict: candidate.conflict } : undefined,
          )
        }
      }
      const result = await writeTask(
        projectPath,
        id,
        (board) => {
          const transitioned =
            action === 'approveReview'
              ? model.approveReview(board, id, clock(), context.by)
              : model.requestChanges(board, id, source.reasons, clock(), context.by)
          if (transitioned.ok !== true) return transitioned
          if (candidate !== null) return recordCandidate(transitioned.board, id, candidate, clock(), { by: context.by })
          return transitioned
        },
        context,
      )
      if (result.ok !== true) return result
      if (action === 'requestChanges') {
        emitActivity(context, 'review-end', 'changes requested: ' + String(source.reasons || '').slice(0, 200), id)
      }
      if (action === 'requestChanges' && result.task !== null && result.task !== undefined && result.task.status === 'running') {
        // Tell the worker what to fix and that it continues in its own worktree.
        const owner =
          result.task.assignee === null || result.task.assignee === undefined || typeof result.task.assignee.name !== 'string'
            ? null
            : result.task.assignee.name
        if (owner !== null) await notifyMember(owner, reworkBriefFor(result.task, projectPath))
      }
      if (action === 'approveReview' && result.task !== null && result.task !== undefined && result.task.status === 'testing') {
        emitActivity(context, 'review-end', 'approved', id)
        emitActivity(null, 'test-start', 'test candidate stage started', id, 'host')
        if (candidate !== null) emitActivity(null, 'worktree-create', 'test candidate ' + String(candidate.path), id, 'host')
        const provisioned = await provisionRole('tester', projectPath, result.task)
        if (provisioned !== null) result.provisioned = provisioned
        if (candidate !== null) {
          result.candidate = candidate
          const tester = roleSlotNameOf('tester')
          if (tester !== null) {
            await notifyMember(tester, testerBriefFor(result.task, projectPath, candidate, { godot: await godotInfoFor(projectPath, candidate.path) }))
          }
        }
      }
      return ok({ task: result.task, events: result.events, provisioned: result.provisioned, candidate: result.candidate })
    }
    if (action === 'passTest' || action === 'failTest') {
      const id = String(source.id === undefined ? '' : source.id)
      if (id === '') return failure('missing-id', action + ' needs a task id')
      const read = await readBoardOrFail(projectPath)
      if (read.failed !== undefined) return read.failed
      const testTask = model.findTask(read.board, id)
      if (testTask === undefined) return failure('unknown-task', 'no task with id ' + id)
      const testRefused = verdictRefusal(context, testTask, 'tester')
      if (testRefused !== null) return testRefused
      const result = await writeTask(
        projectPath,
        id,
        (board) => {
          const decided =
            action === 'passTest'
              ? model.passTest(board, id, clock(), context.by)
              : model.failTest(board, id, source.evidence, clock(), context.by)
          if (decided.ok !== true) return decided
          if (action === 'passTest' && source.evidence !== undefined && source.evidence !== null) {
            const text = String(source.evidence).trim()
            const task = model.findTask(decided.board, id)
            if (task !== null && task !== undefined && task.test !== null && task.test !== undefined && text !== '') {
              task.test.evidence = text
            }
          }
          return decided
        },
        context,
      )
      if (result.ok !== true) return result
      const hasCandidate =
        result.task !== null &&
        result.task !== undefined &&
        result.task.merge !== null &&
        result.task.merge !== undefined &&
        typeof result.task.merge.mergeCommit === 'string' &&
        result.task.merge.mergeCommit.length > 0
      if (action === 'passTest') emitActivity(context, 'test-end', 'passed', id)
      if (action === 'failTest') emitActivity(context, 'test-end', 'failed', id)
      if (action === 'passTest' && candidateWorkflow && hasCandidate) {
        // The tester accepted the candidate: the host merges that exact tree now
        // (no separate verify). A moved target comes back as a retest.
        const merged = await mergeTestedCandidate(projectPath, id, context.by, context)
        if (merged.ok === true) return merged
        // The pass is recorded; a transient merge failure is retried by the sweep.
        return ok({ task: result.task, events: result.events, mergeError: merged })
      }
      if (action === 'failTest' && candidateWorkflow && hasCandidate) {
        await serialised(() => merger.discardCandidate(result.task, projectPath, { worktreeRoot: worktreeRootOf(read.board) }))
        emitActivity(null, 'worktree-remove', 'test candidate discarded after a failed test', id, 'host')
        const owner =
          result.task.assignee === null || result.task.assignee === undefined || typeof result.task.assignee.name !== 'string'
            ? null
            : result.task.assignee.name
        if (owner !== null) await notifyMember(owner, testFailureBriefFor(result.task, projectPath))
      }
      return ok({ task: result.task, events: result.events })
    }
    if (
      action === 'harnessStart' ||
      action === 'harnessStop' ||
      action === 'harnessRestart' ||
      action === 'harnessStatus' ||
      action === 'harnessSmoke'
    ) {
      const denied = harnessRefusal(context)
      if (denied !== null) return denied
      if (harness === null || typeof harness.start !== 'function') {
        return failure('harness-unavailable', 'the isolated DSH harness is not available in this profile')
      }
      if (action === 'harnessStatus') return ok({ harness: harness.status(), logs: harness.logs() })
      if (action === 'harnessStop') return harness.stop()
      if (action === 'harnessStart') return harness.start(projectPath)
      if (action === 'harnessRestart') return harness.restart(projectPath)
      return harness.smoke(projectPath)
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

  return { perform: perform, snapshot: snapshot, autoMergePending: autoMergePending, actions: ACTIONS, readActions: READ_ACTIONS }
}