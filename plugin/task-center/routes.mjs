/**
 * The HTTP surface — the GUI's half of the same API.
 *
 * The route is not a second permission model: it calls the same action handlers
 * as the tool, with role 'user'. What it DOES add is transport hardening, because
 * a localhost port is reachable from any page the browser visits:
 *
 *   - POST requires application/json, which forces a CORS preflight and blocks
 *     the classic text/plain simple-request CSRF;
 *   - an Origin header must match the Host it was sent to (curl and the panel
 *     send no Origin, and are allowed);
 *   - GET /state has no side effects beyond remembering the project, and
 *     action bodies are capped.
 */

import { resolve } from 'node:path'
import { probeDispatch } from './dispatch.mjs'

export const ROUTE_PREFIX = '/godot-bridge/task-center'
export const STATE_PATH = ROUTE_PREFIX + '/state'
export const ACTION_PATH = ROUTE_PREFIX + '/action'
export const DIAGNOSTICS_PATH = ROUTE_PREFIX + '/diagnostics'

const MAX_BODY_BYTES = 256 * 1024

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

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function queryOf(req) {
  try {
    return new URL((req && req.url) || '/', 'http://localhost')
  } catch (error) {
    return null
  }
}

function projectFromRequest(req, body) {
  if (body !== undefined && body !== null && typeof body.project === 'string' && body.project.length > 0) return body.project
  const url = queryOf(req)
  const fromQuery = url === null ? null : url.searchParams.get('project')
  return typeof fromQuery === 'string' && fromQuery.length > 0 ? fromQuery : null
}

/** Same-origin check. No Origin header (curl, same-origin GETs, the panel's
 * fetches in some browsers) is allowed; a mismatching one is not. */
function originAllowed(req) {
  const origin = req === undefined || req === null ? undefined : req.headers === undefined ? undefined : req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch (error) {
    return false
  }
}

function isJson(req) {
  const type = req === undefined || req === null || req.headers === undefined ? undefined : req.headers['content-type']
  return typeof type === 'string' && /^application\/json\b/i.test(type)
}

export function registerTaskRoutes(ctx, options) {
  const opts = options === undefined ? {} : options
  const state = opts.state
  const api = opts.api
  const scheduler = opts.scheduler === undefined ? null : opts.scheduler

  async function resolveProject(req, body) {
    const explicit = projectFromRequest(req, body)
    const hint = state.memory.projectHint
    const project = explicit !== null ? explicit : hint
    if (typeof project !== 'string' || project.length === 0) return null
    return resolve(project)
  }

  async function handleState(req, res) {
    try {
      const project = await resolveProject(req, null)
      if (project === null) {
        sendJson(res, 200, {
          ok: false,
          code: 'unknown-project',
          message: 'No project is known yet. Open one from the panel, or run a task_center call in a session first.',
        })
        return
      }
      state.noteProject(project)
      sendJson(res, 200, await api.snapshot(project))
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  async function handleAction(req, res) {
    if (!isJson(req)) {
      sendJson(res, 415, { ok: false, code: 'content-type', message: 'send application/json' })
      return
    }
    if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, code: 'origin', message: 'cross-origin request refused' })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, code: 'bad-request', message: String((error && error.message) || error) })
      return
    }
    const action = String(body.action === undefined ? '' : body.action)
    if (action === '') {
      sendJson(res, 400, { ok: false, code: 'no-action', message: 'An action is required.' })
      return
    }
    try {
      const project = await resolveProject(req, body)
      if (action !== 'openProject' && project === null) {
        sendJson(res, 200, { ok: false, code: 'unknown-project', message: 'No project is known yet.' })
        return
      }
      if (project !== null) state.noteProject(project)
      const result = await api.perform(action, body, {
        projectPath: project,
        by: '@user',
        role: 'user',
        agent: null,
      })
      if (result.ok === true && action !== 'openProject' && project !== null) {
        if (result.board !== undefined) delete result.board
        try {
          result.snapshot = await api.snapshot(project)
        } catch (error) {
          result.snapshotError = String((error && error.message) || error)
        }
      }
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  function handleDiagnostics(req, res) {
    try {
      sendJson(res, 200, {
        ok: true,
        dispatch: probeDispatch(ctx),
        scheduler: scheduler === null ? null : scheduler.status(),
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: STATE_PATH, handler: handleState }),
    ctx.webServer.register({ kind: 'exact', path: ACTION_PATH, handler: handleAction }),
    ctx.webServer.register({ kind: 'exact', path: DIAGNOSTICS_PATH, handler: handleDiagnostics }),
  ]
  return function dispose() {
    for (const disposer of disposers) disposer()
  }
}