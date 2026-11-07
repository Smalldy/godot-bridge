/**
 * godot-bridge — the task-center row (godot-bridge/task-center).
 *
 * A second Loader row of the same package. The host half is split by job:
 *
 *   schema.mjs     constants, status vocabulary, dispatch defaults
 *   board.mjs      one JSON file per project, CAS, validation, migration
 *   service.mjs    the pure model (tasks, dependencies, transitions, leases)
 *   locks.mjs      canonical project paths and atomic file locks
 *   dispatch.mjs   the scheduler and the Agent Teams edge
 *   merge.mjs      the serial merge queue (integration worktree + verification)
 *   api.mjs        one action registry shared by the tool and the route
 *   state.mjs      the board + lock memory both surfaces share
 *   tool.mjs       the model's binding
 *   routes.mjs     the GUI's binding
 *   skill.mjs      the runtime skill (its body is generated from api.mjs)
 *
 * The only background work is a five-second tick. Board writes, agent status
 * events and the tick all call the same scheduler, which never overlaps itself.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import { createSessionLookup } from './session-lookup.mjs'
import { createState } from './state.mjs'
import { createActivity, createDispatcher, createRoleManager, gitFor } from './dispatch.mjs'
import { createMerger } from './merge.mjs'
import { createDoctor } from './doctor.mjs'
import { createWorkspaceReconciler } from './workspace.mjs'
import { createHarness } from './harness.mjs'
import { ACTIONS, AGENT_ACTIONS, READ_ACTIONS, USER_ONLY_ACTIONS, createApi } from './api.mjs'
import { registerTaskTool } from './tool.mjs'
import { registerTaskRoutes } from './routes.mjs'
import {
  SKILL_DESCRIPTION,
  SKILL_NAME,
  SKILL_WHEN_TO_USE,
  SYSTEM_RULES_NAME,
  SYSTEM_RULES_TEXT,
  buildSkillContent,
} from './skill.mjs'

export const inject = ['fs', 'sandboxPolicy', 'tools', 'webServer']

/**
 * Where activation failures are written. The file lives next to the project
 * registry so a dead row is diagnosable without a live host; tests override the
 * path through GODOT_BRIDGE_ACTIVATION_LOG.
 */
export function activationLogPath() {
  const override = typeof process.env.GODOT_BRIDGE_ACTIVATION_LOG === 'string' ? process.env.GODOT_BRIDGE_ACTIVATION_LOG.trim() : ''
  if (override !== '') return override
  return homedir() + '/.dsh/godot-bridge/activation-error.log'
}

/**
 * Persist one activation failure (module load or apply) and report it through
 * the host logger. Never throws: a broken logger/file must not hide the failure
 * it is trying to report.
 */
export function recordActivationError(stage, error, ctx) {
  const at = new Date().toISOString()
  const detail = error === null || error === undefined ? 'unknown error' : String(error && error.stack ? error.stack : error)
  const line = '[' + at + '] ' + String(stage) + ' FAILED\n' + detail + '\n'
  let path = null
  try {
    path = activationLogPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line)
  } catch (writeError) {
    path = null
  }
  try {
    const logger = ctx === undefined || ctx === null ? undefined : ctx.logger
    if (logger !== undefined && logger !== null && typeof logger.error === 'function') {
      logger.error('[godot-bridge] task center ' + String(stage) + ' failed: ' + detail)
    }
  } catch (logError) {}
  return { at: at, stage: String(stage), path: path, line: line }
}

/** The host loader cannot call into a module that failed to import: this is the entry point it can use when it catches that failure. */
export function reportLoadFailure(error, ctx) {
  return recordActivationError('load', error, ctx)
}

const TICK_MS = 5000
// After the main row's always-on sections (150-152) and before later guidance.
const SYSTEM_RULES_ORDER = 155

/** Read one service from an injected context (property first, then get()). */
function serviceOf(injected, name) {
  if (injected === undefined || injected === null) return undefined
  // Cordis throws when a non-injected property is read; the service callback may
  // still be a strict context, so even this read stays guarded.
  try {
    const direct = injected[name]
    if (direct !== undefined && direct !== null) return direct
  } catch (error) {
    /* fall through to get() */
  }
  try {
    if (typeof injected.get === 'function') return injected.get(name)
  } catch (error) {
    return undefined
  }
  return undefined
}

/** A skipped optional registration is logged, never thrown at the host. */
function warnSkipped(ctx, what, error) {
  try {
    if (ctx !== undefined && ctx !== null && ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn('[godot-bridge] task center ' + what + ' skipped: ' + String((error && error.message) || error))
    }
  } catch (ignored) {}
}

/**
 * Run `use` once the named OPTIONAL service exists. A host without the service
 * — or without the inject seam itself — simply never calls back, so the task
 * center still loads its tool and its panel.
 */
function optionalService(ctx, name, use) {
  if (ctx === undefined || ctx === null || typeof ctx.inject !== 'function') return
  try {
    ctx.inject([name], function (injected) {
      try {
        const service = serviceOf(injected, name)
        if (service === undefined) return
        use(service)
      } catch (error) {
        warnSkipped(ctx, name, error)
      }
    })
  } catch (error) {
    warnSkipped(ctx, name, error)
  }
}

/** Keep a registration's disposer inside the row's effect scope. */
function holdDisposer(ctx, disposer, label) {
  const release = typeof disposer === 'function' ? disposer : function () {}
  if (ctx === undefined || ctx === null || typeof ctx.effect !== 'function') return release
  ctx.effect(function () {
    return release
  }, label)
  return release
}

export function apply(ctx) {
  try {
    return applyRow(ctx)
  } catch (error) {
    // A row that cannot activate must leave a trace: silently dying is the bug
    // this guard exists to prevent.
    recordActivationError('apply', error, ctx)
    throw error
  }
}

function applyRow(ctx) {
  let scheduler = null
  // The fs facade never creates parent directories, so the row supplies the one
  // creator for every nested write it owns: the project registry and the
  // investigation reports under .agents/reports.
  const ensureDir = function (dir) {
    mkdirSync(dir, { recursive: true })
  }
  const state = createState(ctx, {
    afterWrite: function (event) {
      return scheduler === null ? undefined : scheduler.kick(event.projectPath)
    },
    // The registry lives outside the workspace (`~/.dsh/godot-bridge`), whose
    // parent directory may not exist yet: create it before the write.
    ensureDir: ensureDir,
    // A workspace-write policy denies the home path, so the writer falls back to
    // `<project>/.agents/projects.json`; the workspace candidate uses THIS policy.
    sandboxPolicyFor: function (projectRoot) {
      return { mode: 'workspace-write', workspaceRoot: projectRoot }
    },
    onRegistryError: function (status) {
      warnSkipped(ctx, 'project registry', new Error(String(status.error === null ? 'unwritable' : status.error)))
    },
    // T-102: reverse-look a session id up in the host's DSH sessions tree, so the
    // panel knows its project before any tool call has recorded one.
    sessionLookup: createSessionLookup({ homeDir: homedir() }),
  })
  // Git comes from the host's unconfined subprocess service. It is REQUIRED now:
  // tasks run in git worktrees, so without a facade start/approveStart refuse
  // with a readable worktree error instead of running tasks in the shared tree.
  // One facade is shared so the dispatcher (claim), the API (start preflight and
  // submit) and the merge-request record all use the same runner.
  const git = gitFor(ctx)
  // The host-side role registry: worker/reviewer/tester profiles, one instance
  // each by default, bound to implement/review/test. It provisions a missing
  // reviewer/tester through the live Lead and replaces a dead or timed-out one,
  // so no Lead prompt is required.
  // T-118: the manager gets the shared state so it can judge whether the team's
  // session actually runs in the slot's project before spawning a role instance.
  const roles = createRoleManager(ctx, { state: state })
  // The in-memory activity ring the status snapshot shows. One ring is shared by
  // the dispatcher and the API; it is pure memory and never writes the board.
  const activity = createActivity({})
  scheduler = createDispatcher(ctx, {
    state: state,
    projectPath: function () {
      return state.memory.projectHint
    },
    allowSpawn: true,
    git: git,
    roles: roles,
    activity: activity,
  })
  // The merge queue only integrates a candidate the independent tester already
  // accepted; the host no longer runs a third full verify of its own.
  const merger = createMerger({ git: git })
  // Read-only workspace doctor for /diagnostics: stale index.lock, merge state,
  // worktrees, and the merge queue's in-memory last unit. It never repairs.
  const doctor = createDoctor({ git: git, merger: merger })
  // Read-only reconciliation plan for the workspace (stale index.lock, merge
  // state). Applying a plan is a separate, explicit operation.
  const workspace = createWorkspaceReconciler({ git: git })
  // The isolated DSH test instance the tester drives (harness.mjs): a throwaway
  // DSH_HOME/profile, its own free port and its own project copy. Constructing
  // it starts nothing; only a harnessStart action does.
  const harness = createHarness({ ctx: ctx })
  // autoMerge turns on the host-driven merge sweep below: a task that passed its
  // review and test phases must not wait for a merger model.
  const api = createApi(ctx, {
    state: state,
    scheduler: scheduler,
    git: git,
    merger: merger,
    roles: roles,
    harness: harness,
    activity: activity,
    autoMerge: true,
    // T-131: report files live in .agents/reports/<id>.md and need the directory.
    ensureDir: ensureDir,
  })

  // The project registry is what makes restarts seamless: load it once, before
  // the timers below can ask which projects to drive.
  void state.loadRegistry()

  // One in-flight promise per project for the merge sweep, so a slow project
  // never blocks another and a tick never stacks duplicate work.
  const mergeInFlight = new Map()
  function driveProjects() {
    for (const entry of state.activeProjects()) {
      if (mergeInFlight.has(entry.id)) continue
      let pending
      try {
        pending = api.autoMergePending(entry.root)
      } catch (error) {
        continue
      }
      if (pending === undefined || pending === null || typeof pending.then !== 'function') continue
      mergeInFlight.set(entry.id, true)
      pending
        .catch(function () {})
        .then(function () {
          mergeInFlight.delete(entry.id)
        })
    }
  }

  // An idle WorkAgent is a chance to hand out more work. A reload must not
  // accumulate listeners, so the subscription is an effect.
  ctx.effect(function () {
    if (typeof ctx.on !== 'function') return function () {}
    const off = ctx.on('agent/status', function () {
      for (const entry of state.activeProjects()) {
        try {
          const pending = scheduler.kick(entry.root)
          if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(function () {})
        } catch (error) {}
      }
    })
    return function () {
      if (typeof off === 'function') off()
      scheduler.dispose()
    }
  }, 'godot-bridge: dispatch on agent status')

  // The timer is what reaps expired leases while nothing is writing to the
  // board, and what restarts queued work after a host restart.
  ctx.effect(function () {
    const timer = setInterval(function () {
      for (const entry of state.activeProjects()) {
        try {
          const pending = scheduler.kick(entry.root)
          if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(function () {})
        } catch (error) {}
      }
      driveProjects()
    }, TICK_MS)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
    return function () {
      clearInterval(timer)
      scheduler.dispose()
    }
  }, 'godot-bridge: task center tick + auto-merge sweep')

  // The merge queue is host-driven: every tick, a request whose review was
  // approved and whose test phase passed is merged through the same serial queue
  // the manual action uses. Nothing here depends on a model acting; a failure
  // leaves the request in its recorded state.
  // The write end: the model's tool. Guarded so a registration failure costs the
  // tool, not the whole row.
  ctx.effect(function () {
    try {
      return registerTaskTool(ctx, { api: api })
    } catch (error) {
      try {
        ctx.logger.warn('[godot-bridge] task_center tool registration skipped: ' + String((error && error.message) || error))
      } catch (error2) {}
      return function () {}
    }
  }, 'godot-bridge: task_center tool')

  // The GUI's routes. Same API, same state, human role.
  ctx.effect(function () {
    try {
      return registerTaskRoutes(ctx, { state: state, api: api, scheduler: scheduler, merger: merger, doctor: doctor, workspace: workspace })
    } catch (error) {
      try {
        ctx.logger.warn('[godot-bridge] task center routes skipped: ' + String((error && error.message) || error))
      } catch (error2) {}
      return function () {}
    }
  }, 'godot-bridge: task center routes')

  // ── the model-facing guide ────────────────────────────────────────────────
  // Until now the task center explained itself only through the tool description
  // and the dispatch briefs (which reach nobody who was never dispatched). Two
  // additions tell any session what this board is and how to use it:
  //   1. a runtime skill the model loads on demand, its body GENERATED from the
  //      action registry so it cannot drift from api.mjs;
  //   2. five always-on rules for the things an agent must never get wrong.
  // Both services are optional, and a registration failure costs the guide, not
  // the row: activation keeps its tool, its routes and its scheduler.
  optionalService(ctx, 'skills', function (skills) {
    if (typeof skills.register !== 'function') return
    const registered = skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
      // `source` is REQUIRED by the registry's LOAD-time validation: register()
      // itself only checks name/description/invocation, but loading the skill
      // fails with 'loaded skill "<name>" source must be a string' without it.
      source: 'runtime',
      content: buildSkillContent({
        actions: ACTIONS,
        agentActions: AGENT_ACTIONS,
        readActions: READ_ACTIONS,
        userOnlyActions: USER_ONLY_ACTIONS,
      }),
      invocation: { modelInvocable: true, userInvocable: true },
    })
    // Held by an effect: unloading the row removes the skill from the catalog.
    holdDisposer(ctx, registered, 'godot-bridge: task-center skill')
  })

  optionalService(ctx, 'systemPrompt', function (systemPrompt) {
    if (typeof systemPrompt.section !== 'function') return
    ctx.effect(function () {
      return systemPrompt.section({ name: SYSTEM_RULES_NAME, order: SYSTEM_RULES_ORDER, text: SYSTEM_RULES_TEXT })
    }, 'godot-bridge: task-center rules')
  })
}
