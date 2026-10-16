/**
 * The panel's HTTP route: the USER's surface on the same board.
 *
 * The mirror image of the tool. Where `task_center` refuses the actions that
 * belong to the user, this route accepts exactly those — releasing drafts,
 * approving work, reordering the queue, forcing a lock away from an agent — and
 * it accepts them because the caller is the person at the GUI. An agent does not
 * speak HTTP to this route, so "the route is the user" is the trust boundary, and
 * it is the whole boundary: the route adds no policy of its own beyond that, and
 * every rule still comes from `service.mjs`.
 *
 * Its action names are the panel store's method names on purpose, so wiring the
 * client is a data-source swap rather than a translation layer.
 *
 * Both surfaces read and write through the same `state`, so the locks an agent
 * holds are the locks the panel shows.
 */

import { forceReleaseLock, cancelReservation, claimTask, patchTask, publishTask, reorderQueue, removeTask, setTaskStatus, unpublishTask } from './service.mjs'
import { taskMutator } from './tool.mjs'
import { writePolicyFor } from './state.mjs'

/** Exact paths, under one prefix. A prefix here would collide with the SPA
 * fallback and with nothing else; exact keeps that impossible. */
export const ROUTE_PREFIX = '/godot-bridge/task-center'
export const STATE_PATH = ROUTE_PREFIX + '/state'
export const ACTION_PATH = ROUTE_PREFIX + '/action'
/** Read-only: what the dispatch edge can currently see. */
export const DISPATCH_PATH = ROUTE_PREFIX + '/dispatch'

/** The most a request body may be, in bytes. The board is small; a big body is a
 * mistake or an attack, and either way it is not this route's problem. */
const MAX_BODY_BYTES = 256 * 1024

/** Read a JSON request body. */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object')
  return parsed
}

/** Answer with JSON, always 200 unless the REQUEST was malformed: a refused
 * action is a normal outcome the panel has to render, not a transport error. */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * Map one panel action onto a model call.
 *
 * The agent-available actions are delegated to the SAME mutator the tool uses, so
 * a change to a transition rule cannot land on one surface only. The user-only
 * ones are here, because this is the surface allowed to perform them.
 *
 * @returns a mutator returning either a model result or `{ locks }` when the
 *   action touches lock memory instead of the board.
 */
export function panelMutator(action, body, now, by) {
  const id = String(body.id === undefined ? '' : body.id)
  if (action === 'publish') return (board) => publishTask(board, id, now, by)
  if (action === 'unpublish') return (board) => unpublishTask(board, id, now, by)
  if (action === 'complete') return (board) => setTaskStatus(board, id, 'done', now, by, body.note)
  if (action === 'setStatus') return (board) => setTaskStatus(board, id, String(body.status || ''), now, by, body.note)
  if (action === 'move') return (board) => reorderQueue(board, id, Number(body.delta))
  if (action === 'remove') return (board) => removeTask(board, id)
  if (action === 'blocked') {
    return (board) => {
      const marked = patchTask(board, id, { blockedBy: Array.isArray(body.blockedBy) ? body.blockedBy : [] }, now, by)
      if (marked.ok === false) return marked
      return setTaskStatus(marked.board, id, 'blocked', now, by, body.note)
    }
  }
  return taskMutator(action, body, id, by, undefined, now, { allowRemove: true })
}

/** Actions that touch lock memory rather than the board. */
const LOCK_ACTIONS = { forceRelease: forceReleaseLock, cancelReservation: cancelReservation }

/**
 * Register the panel's routes.
 *
 * @param ctx - the row's context; needs `webServer`, `fs`, `sandboxPolicy`.
 * @param options.state - the shared state, so this route and the tool agree.
 * @param options.projectPath - resolves the project to show. The panel is not
 *   session-bound, so the project comes from whoever the agents last worked on,
 *   falling back to the ambient session workspace.
 */
export function registerTaskRoutes(ctx, options) {
  const state = options.state
  const projectOf = options.projectPath
  const by = '@user'

  /** The `?project=` a panel may send: the project it last showed. */
  function projectFromUrl(req) {
    try {
      const url = new URL((req && req.url) || '/', 'http://localhost')
      const value = url.searchParams.get('project')
      return typeof value === 'string' && value.length > 0 ? value : null
    } catch (error) {
      return null
    }
  }

  /**
   * Let the panel name the project it wants, but only within limits.
   *
   * The Host's own hint wins outright: an agent that has just touched a board is
   * better evidence than the browser's memory. Only when NOTHING is known does the
   * panel's remembered project get considered, and then only if a board ALREADY
   * EXISTS there — so a crafted URL cannot aim this route at an arbitrary directory
   * and have it read or write a `.agents/tasks.json` inside.
   *
   * This exists because the Host's hint is memory-only and dies on every restart, at
   * which point the panel used to fall back to fabricated data. Adopting the panel's
   * memory is what lets it come back on its own.
   */
  async function adoptHintedProject(req) {
    const known = projectOf()
    if (typeof known === 'string' && known.length > 0) return
    const hinted = projectFromUrl(req)
    if (hinted === null) return
    const probe = await state.read(hinted)
    if (probe.failed !== null || probe.existed !== true) return
    state.noteProject(hinted)
  }

  async function currentState() {
    const projectPath = projectOf()
    if (projectPath === null || projectPath === undefined) {
      return {
        ok: false,
        code: 'unknown-project',
        message: 'No project is known yet. An agent has to touch the board — or the user type /task — in a project first, so the panel knows which one to show.',
      }
    }
    state.sweep()
    const current = await state.read(projectPath)
    if (current.failed !== null) {
      return { ok: false, code: current.failed.code, message: current.failed.message }
    }
    return {
      ok: true,
      board: current.existed ? '.agents/tasks.json' : 'not created yet',
      project: projectPath,
      version: current.board.version,
      seq: current.board.seq,
      updatedAt: current.board.updatedAt,
      tasks: current.board.tasks,
      locks: state.memory.locks,
      // The panel renders the same statuses the model knows, so a status the
      // model has never heard of cannot be drawn as an empty column.
      statuses: ['draft', 'queued', 'claimed', 'in_progress', 'blocked', 'review', 'done', 'cancelled'],
    }
  }

  async function dispatch(body) {
    const action = String(body.action === undefined ? '' : body.action)
    if (action === '') return { ok: false, code: 'no-action', message: 'An action is required.' }
    const projectPath = projectOf()
    if (projectPath === null || projectPath === undefined) {
      return { ok: false, code: 'unknown-project', message: 'No project is known yet, so there is no board to write.' }
    }
    const now = state.clock()
    state.sweep()

    // The only action here that LEAVES this process: it hands a pooled task to a
    // WorkAgent. Kept as an explicit branch rather than a mutator because it is not a
    // board write with a side note — the side effect IS the point, and it has to be
    // possible to trigger it by hand before it is ever triggered automatically.
    if (action === 'dispatch') {
      if (options.dispatchOne === undefined) {
        return { ok: false, code: 'no-dispatcher', message: 'Dispatch is not available in this profile.' }
      }
      return await options.dispatchOne(String(body.id === undefined ? '' : body.id), body)
    }

    // Force the automatic trigger by hand: the same sweep a board write or a status
    // change runs, for when you want to see what it would find right now.
    if (action === 'sweep') {
      if (options.sweep === undefined) {
        return { ok: false, code: 'no-dispatcher', message: 'Dispatch is not available in this profile.' }
      }
      return await options.sweep()
    }

    // Try the spawn primitive on its own, so learning what the service requires stops
    // costing real tasks their attempts. Nearly read-only: it creates at most one
    // teammate, and only if a candidate request shape actually works.
    if (action === 'probeSpawn') {
      if (options.probeSpawn === undefined) {
        return { ok: false, code: 'no-dispatcher', message: 'Dispatch is not available in this profile.' }
      }
      return await options.probeSpawn()
    }

    if (Object.prototype.hasOwnProperty.call(LOCK_ACTIONS, action)) {
      const path = String(body.path === undefined ? '' : body.path)
      const result =
        action === 'forceRelease' ? forceReleaseLock(state.memory.locks, path, now, by) : cancelReservation(state.memory.locks, path, by)
      if (result.ok === false) return { ok: false, code: result.code, message: result.message }
      state.memory.locks = result.locks
      return { ok: true, action: action, path: path, events: result.events }
    }

    // A claim from the panel is the user taking a task themselves; there is no
    // agent session to attribute it to, and saying so is better than inventing one.
    if (action === 'claim') {
      const applied = await state.apply(projectPath, (board) => claimTask(board, String(body.id || ''), { name: by, session: null }, now), writePolicyFor(projectPath))
      if (applied.failed !== null) return { ok: false, code: applied.failed.code, message: applied.failed.message }
      return { ok: true, action: action, events: applied.events }
    }

    const known = ['unpublish', 'complete', 'setStatus', 'move', 'remove', 'blocked', 'update', 'release', 'start', 'submit', 'unblock', 'reopen', 'publish']
    if (known.indexOf(action) < 0) {
      return { ok: false, code: 'unknown-action', message: 'The panel cannot perform ' + action + '.' }
    }
    const applied = await state.apply(projectPath, panelMutator(action, body, now, by), writePolicyFor(projectPath))
    if (applied.failed !== null) return { ok: false, code: applied.failed.code, message: applied.failed.message }
    return { ok: true, action: action, events: applied.events, attempts: applied.attempts }
  }

  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async function (req, res) {
        try {
          await adoptHintedProject(req)
          sendJson(res, 200, await currentState())
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
        }
      },
    }),
    ctx.webServer.register({
      kind: 'exact',
      path: ACTION_PATH,
      handler: async function (req, res) {
        let body
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { ok: false, code: 'bad-request', message: String((error && error.message) || error) })
          return
        }
        try {
          const outcome = await dispatch(body)
          sendJson(res, 200, outcome.ok === true ? Object.assign({}, outcome, await currentState()) : outcome)
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
        }
      },
    }),
    // Read-only, and deliberately so: it reports what the dispatch edge can SEE
    // (services reachable, who is idle, whether status events arrive) without
    // sending anything to anyone. A GET is safe to poll while that is still unknown.
    ctx.webServer.register({
      kind: 'exact',
      path: DISPATCH_PATH,
      handler: async function (req, res) {
        try {
          const probe = options.dispatchProbe
          sendJson(res, 200, { ok: true, dispatch: probe === undefined ? null : probe() })
        } catch (error) {
          sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
        }
      },
    }),
  ]
  return function dispose() {
    for (const disposer of disposers) disposer()
  }
}
