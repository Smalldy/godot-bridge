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
 *
 * The only background work is a five-second tick. Board writes, agent status
 * events and the tick all call the same scheduler, which never overlaps itself.
 */

import { createState } from './state.mjs'
import { createDispatcher, createRoleManager, gitFor } from './dispatch.mjs'
import { createMerger, verifyFor } from './merge.mjs'
import { createApi } from './api.mjs'
import { registerTaskTool } from './tool.mjs'
import { registerTaskRoutes } from './routes.mjs'

export const inject = ['fs', 'sandboxPolicy', 'tools', 'webServer']

const TICK_MS = 5000

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
  scheduler = createDispatcher(ctx, {
    state: state,
    projectPath: function () {
      return state.memory.projectHint
    },
    allowSpawn: true,
    git: git,
    roles: roles,
  })
  // The merge queue runs the project's verification through the unconfined
  // subprocess service before fast-forwarding. Lazy — activation spawns nothing;
  // a merge is the only thing that runs it.
  const verify = verifyFor(ctx)
  const merger = createMerger({ git: git, verify: verify })
  // autoMerge turns on the host-driven merge sweep below: a task that passed its
  // review and test phases must not wait for a merger model.
  const api = createApi(ctx, {
    state: state,
    scheduler: scheduler,
    git: git,
    merger: merger,
    roles: roles,
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
}
