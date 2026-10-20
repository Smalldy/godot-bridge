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

import { createState } from './state.mjs'
import { createActivity, createDispatcher, createRoleManager, gitFor } from './dispatch.mjs'
import { createMerger } from './merge.mjs'
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

const TICK_MS = 5000
// After the main row's always-on sections (150-152) and before later guidance.
const SYSTEM_RULES_ORDER = 155

/** Read one service from an injected context (property first, then get()). */
function serviceOf(injected, name) {
  if (injected === undefined || injected === null) return undefined
  const direct = injected[name]
  if (direct !== undefined && direct !== null) return direct
  if (typeof injected.get === 'function') return injected.get(name)
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
  let scheduler = null
  const state = createState(ctx, {
    afterWrite: function (event) {
      return scheduler === null ? undefined : scheduler.kick(event.projectPath)
    },
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
  const roles = createRoleManager(ctx)
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
  })

  // An idle WorkAgent is a chance to hand out more work. A reload must not
  // accumulate listeners, so the subscription is an effect.
  ctx.effect(function () {
    if (typeof ctx.on !== 'function') return function () {}
    const off = ctx.on('agent/status', function () {
      try {
        const pending = scheduler.kick()
        if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(function () {})
      } catch (error) {}
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
      try {
        const pending = scheduler.kick()
        if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(function () {})
      } catch (error) {}
    }, TICK_MS)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
    return function () {
      clearInterval(timer)
      scheduler.dispose()
    }
  }, 'godot-bridge: task center tick')

  // The merge queue is host-driven: every tick, a request whose review was
  // approved and whose test phase passed is merged through the same serial queue
  // the manual action uses. Nothing here depends on a model acting; a failure
  // leaves the request in its recorded state.
  ctx.effect(function () {
    const timer = setInterval(function () {
      const project = state.memory.projectHint
      if (typeof project !== 'string' || project.length === 0) return
      try {
        const pending = api.autoMergePending(project)
        if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(function () {})
      } catch (error) {}
    }, TICK_MS)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
    return function () {
      clearInterval(timer)
    }
  }, 'godot-bridge: auto-merge sweep')

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
      return registerTaskRoutes(ctx, { state: state, api: api, scheduler: scheduler })
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
  //   2. four always-on rules for the things an agent must never get wrong.
  // Both services are optional, and a registration failure costs the guide, not
  // the row: activation keeps its tool, its routes and its scheduler.
  optionalService(ctx, 'skills', function (skills) {
    if (typeof skills.register !== 'function') return
    const registered = skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      whenToUse: SKILL_WHEN_TO_USE,
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
