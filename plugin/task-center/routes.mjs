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
// T-210: the deferred metadata of one project (/state has become the LIGHT
// first paint). Agent tree, worktrees, environment, the activity timeline, the
// roles and the decision policy live here, so a slow host inventory can never
// block the cards or the header.
export const META_PATH = ROUTE_PREFIX + '/meta'
export const ACTION_PATH = ROUTE_PREFIX + '/action'
export const DIAGNOSTICS_PATH = ROUTE_PREFIX + '/diagnostics'
/** On-demand single-task detail (summary snapshots leave details out). */
export const TASK_PATH = ROUTE_PREFIX + '/task'
/** Paged/summarized list with server-side status filter and search. */
export const LIST_PATH = ROUTE_PREFIX + '/list'
/** T-146: lazy dirty/merged probe for worktrees (never returns a snapshot). */
export const WORKTREES_PATH = ROUTE_PREFIX + '/worktrees'
// T-236: the activity timeline on its OWN cursor. It is a read, not part of
// /meta: a cursored answer can never be served from a shared build cache, so a
// client asks this endpoint for exactly "what is new since my cursor".
export const ACTIVITY_PATH = ROUTE_PREFIX + '/activity'

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

/** The caller's session id: body first, then ?session=. Anything unreadable is null. */
function sessionFromRequest(req, body) {
  const fromBody = body !== undefined && body !== null && typeof body.session === 'string' ? body.session.trim() : ''
  if (fromBody !== '') return fromBody.slice(0, 128)
  const url = queryOf(req)
  const fromQuery = url === null ? null : url.searchParams.get('session')
  return typeof fromQuery === 'string' && fromQuery.trim() !== '' ? fromQuery.trim().slice(0, 128) : null
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
  const merger = opts.merger === undefined ? null : opts.merger
  const doctor = opts.doctor === undefined ? null : opts.doctor
  const workspace = opts.workspace === undefined ? null : opts.workspace

  /**
   * One resolver for the panel and the tool. An explicit ?project= is adopted
   * (and written to the registry, so the background loop drives it); otherwise
   * only the session workspace can bind a project. Never a global hint.
   */
  async function resolveProject(req, body, sessionId) {
    const explicit = projectFromRequest(req, body)
    const resolved = await state.resolveProject({
      explicit: explicit,
      // T-96: only THIS session's binding may answer; no session means no slot.
      sessionRoot: sessionId === null || sessionId === undefined ? null : state.sessionRootOf(sessionId),
      // T-102: when this session never called a tool, its DSH session directory
      // still names the workspace, so the panel binds before the first tool call.
      sessionId: sessionId === null || sessionId === undefined ? null : sessionId,
      // T-203: this is the FOREGROUND surface (the GUI's own requests). It never
      // asks for the last-active fallback: a request without a session context
      // reads as "nothing is bound yet" (the setup state) instead of inheriting
      // whatever project another session drove last. Only the scheduler/startup
      // path may still resolve background:true with allowLastActive.
      explicitSource: explicit !== null ? 'panel' : undefined,
    })
    if (resolved.ok !== true) return { failed: resolved }
    // A looked-up project is ACTIVATED: it joins the registry (lastSeen) and the
    // background drive exactly like a panel-pinned one. A last-active project is
    // already recorded — re-touching it every /state poll would rewrite the
    // registry on a timer for no gain.
    // T-152: the caller's session joins the project's participating SESSION SET.
    // Never undefined: a request without a session id passes null explicitly.
    if (explicit !== null || resolved.resolvedFrom === 'session-lookup') await state.adoptPanelProject(resolved.project.root, sessionId === undefined ? null : sessionId)
    else if (resolved.resolvedFrom !== 'last-active') state.touchProject(resolved.project.root, sessionId === undefined ? null : sessionId)
    return { root: resolved.project.root, resolvedFrom: resolved.resolvedFrom }
  }

  /**
   * What the SESSION resolves to, independent of any ?project= the panel pins.
   *
   * The panel needs this to show an actionable mismatch ("panel: A · session: B →
   * switch"): without it a hand-pinned path silently splits the GUI from the
   * project the session (and therefore the scheduler) actually drives, which is
   * exactly the confusion this route is meant to end. Never throws: a host with no
   * session workspace simply reports null.
   */
  async function sessionProjectOf(sessionId) {
    try {
      const resolved = await state.resolveProject({
        explicit: null,
        sessionRoot: sessionId === null || sessionId === undefined ? null : state.sessionRootOf(sessionId),
        sessionId: sessionId === null || sessionId === undefined ? null : sessionId,
      })
      if (resolved === null || resolved === undefined || resolved.ok !== true) return null
      return resolved.project.root
    } catch (error) {
      return null
    }
  }

  /** Attach the session resolution to a snapshot-shaped payload. */
  function withSessionProject(payload, sessionProject) {
    if (payload === null || typeof payload !== 'object') return payload
    payload.sessionProject = sessionProject
    return payload
  }

  async function handleState(req, res) {
    try {
      const sessionId = sessionFromRequest(req, null)
      const target = await resolveProject(req, null, sessionId)
      if (target.failed !== undefined) {
        // UI-facing: the panel localizes by code; no English sentence crosses the wire.
        // T-203: the answer names its source — unbound is a SETUP state, never a
        // last-active project wearing the session's name.
        sendJson(res, 200, { ok: false, code: 'no-project-bound', params: {}, resolvedFrom: 'unbound' })
        return
      }
      const project = target.root
      state.noteProject(project, sessionId)
      // T-124: resolving a session's project records it, so later reads (team
      // matchesSession, dispatch ownership) agree with this answer.
      // Only a SESSION-derived answer is the session's project; a panel pin (or
      // last-active fallback) must not rewrite the session binding.
      if (sessionId !== null && typeof project === 'string' && project.length > 0 && (target.resolvedFrom === 'session' || target.resolvedFrom === 'session-lookup')) {
        try {
          state.setSessionRoot(sessionId, project)
        } catch (error) {}
      }
      const url = queryOf(req)
      const sinceRaw = url === null ? null : url.searchParams.get('since')
      const since = sinceRaw === null || sinceRaw === '' ? null : Number(sinceRaw)
      // T-111: the activity timeline is incremental on its OWN cursor (the last
      // derived event key), independent of the board's numeric seq.
      const activitySinceRaw = url === null ? null : url.searchParams.get('activitySince')
      const activitySince = activitySinceRaw === null || activitySinceRaw === '' ? null : String(activitySinceRaw)
      // First paint: board/counts only. The panel asks for the full snapshot next.
      const core = url !== null && url.searchParams.get('core') === '1'
      // T-210: `light=1` is the SPLIT first paint — board + counts + dispatch AND
      // the light project/session scope, while every host inventory (agent tree,
      // worktrees, environment, activity timeline, roles, decision policy,
      // archive) is deferred to /meta. This is what the panel polls.
      const light = url !== null && url.searchParams.get('light') === '1'
      // Opt-in per-segment timings (`&timings=1`): evidence, not a payload.
      const timings = url !== null && url.searchParams.get('timings') === '1'
      // T-110: the Team belongs to the session, so the panel snapshot is resolved
      // for the SAME session the rest of its calls speak as.
      const snapshot = await api.snapshot(project, {
        full: false,
        // Session cards are grouped from board owners; do not resolve every
        // participant's workspace on the hot state path.
        resolveSessionProjects: false,
        doneLimit: 30,
        core: core,
        light: light,
        timings: timings,
        since: Number.isFinite(since) ? since : null,
        activitySince: activitySince,
        resolvedFrom: target.resolvedFrom,
        sessionId: sessionId,
      })
      const sessionProject = target.resolvedFrom === 'session' ? project : await sessionProjectOf(sessionId)
      sendJson(res, 200, withSessionProject(snapshot, sessionProject))
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  /**
   * T-210: the deferred metadata of one project, on its own request. It obeys
   * the SAME project rules as /state (session resolution, explicit pin, and the
   * T-203 rule that a foreground request with no session binds NOTHING), so the
   * two halves can never describe different projects.
   */
  async function handleMeta(req, res) {
    try {
      const sessionId = sessionFromRequest(req, null)
      const target = await resolveProject(req, null, sessionId)
      if (target.failed !== undefined) {
        sendJson(res, 200, { ok: false, code: 'no-project-bound', params: {}, resolvedFrom: 'unbound' })
        return
      }
      const project = target.root
      state.noteProject(project, sessionId)
      if (sessionId !== null && (target.resolvedFrom === 'session' || target.resolvedFrom === 'session-lookup')) {
        try {
          state.setSessionRoot(sessionId, project)
        } catch (error) {}
      }
      const url = queryOf(req)
      const get = (name) => (url === null ? null : url.searchParams.get(name))
      const activitySinceRaw = get('activitySince')
      // T-239: the scope is PAGED. `limit` is the working-set size (default 20),
      // `scope=history` (or a bare `cursor`) asks for the lightweight next page.
      // A client that sends none of these keeps the hot working set and sees
      // `truncated`, so an older panel never breaks.
      const limitRaw = get('limit')
      const cursorRaw = get('cursor')
      const scopeRaw = get('scope')
      const payload = await api.metadata(project, {
        sessionId: sessionId,
        resolvedFrom: target.resolvedFrom,
        // The activity timeline is incremental on its OWN cursor (T-111).
        activitySince: activitySinceRaw === null || activitySinceRaw === '' ? null : String(activitySinceRaw),
        scopeMode: scopeRaw === 'history' ? 'history' : scopeRaw === 'hot' ? 'hot' : null,
        scopeLimit: limitRaw === null || limitRaw === '' ? null : Number(limitRaw),
        scopeCursor: cursorRaw === null || cursorRaw === '' ? null : cursorRaw,
        timings: get('timings') === '1',
        refresh: get('refresh') === '1',
      })
      sendJson(res, 200, payload)
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }
  async function handleAction(req, res) {
    if (!isJson(req)) {
      sendJson(res, 415, { ok: false, code: 'content-type', params: { expected: 'application/json' } })
      return
    }
    if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, code: 'origin', params: {} })
      return
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      // The parse error itself is diagnostic; the panel shows its own sentence for the code.
      sendJson(res, 400, { ok: false, code: 'bad-request', params: {} })
      return
    }
    const action = String(body.action === undefined ? '' : body.action)
    if (action === '') {
      sendJson(res, 400, { ok: false, code: 'no-action', params: {} })
      return
    }
    try {
      const sessionId = sessionFromRequest(req, body)
      const target = await resolveProject(req, body, sessionId)
      // T-129: onboard answers when nothing is bound yet — resolving the
      // session's project is exactly its job, so the resolver may fail here.
      if (action !== 'openProject' && action !== 'onboard' && target.failed !== undefined) {
        sendJson(res, 200, { ok: false, code: 'no-project-bound', params: {}, resolvedFrom: 'unbound' })
        return
      }
      const project = target.failed !== undefined ? null : target.root
      if (project !== null && project !== undefined) state.noteProject(project, sessionId)
      // T-124: every action that resolved this session's project records it.
      if (sessionId !== null && typeof project === 'string' && project.length > 0 && (target.resolvedFrom === 'session' || target.resolvedFrom === 'session-lookup')) {
        try {
          state.setSessionRoot(sessionId, project)
        } catch (error) {}
      }
      const result = await api.perform(action, Object.assign({}, body, project === undefined ? {} : { project: project }), {
        projectPath: project,
        by: '@user',
        role: 'user',
        agent: null,
        // T-117: the panel's session travels into the API, so team/lead resolution
        // is session-scoped instead of falling back to "some Lead".
        sessionId: sessionId,
        resolvedFrom: target.resolvedFrom,
        // T-210 review: the PANEL's openProject answer is the LIGHT snapshot, so
        // opening/switching a project paints the board + header without waiting
        // for the host inventory; /meta supplies the deferred half. The tool path
        // passes no flag and keeps its full answer.
        snapshotDelivery: action === 'openProject' ? 'light' : undefined,
      })
      // T-129: the onboard answer is deliberately small (brief + next); the panel
      // must not be handed a whole board snapshot next to it.
      //
      // T-231: a write answers what changed — { ok, seq, affected, changed } — and
      // NOT the board. The extra light snapshot on every action duplicated the
      // panel's own 2.5 s poll (and made one write cost two board reads). The old
      // attachment survives as an EXPLICIT, versioned escape hatch: a caller that
      // sends includeSnapshot:true gets the light snapshot (carrying its own
      // version/seq) back on the same answer. Default OFF.
      if (result.ok === true && action !== 'openProject' && action !== 'onboard' && project !== null) {
        if (result.board !== undefined) delete result.board
        if (body.includeSnapshot === true) {
          try {
            // T-210: an action's refreshed board is the LIGHT answer too — a user
            // action must not wait for a host inventory the panel already has.
            result.snapshot = await api.snapshot(project, { full: false, light: true, resolvedFrom: target.resolvedFrom, sessionId: sessionId })
          } catch (error) {
            result.snapshotError = String((error && error.message) || error)
          }
        }
      }
      // openProject answers with the snapshot itself; the panel renders that
      // answer, so it needs the session resolution just like /state does.
      let sessionProject = target.resolvedFrom === 'session' ? project : await sessionProjectOf(sessionId)
      if (action === 'openProject' && result.ok === true) {
        // Bind the result to the session that ASKED, never to a process-global slot.
        const opened = typeof result.snapshot !== 'undefined' && result.snapshot !== null ? result.snapshot.project : result.project
        if (sessionId !== null && typeof opened === 'string' && opened.length > 0) {
          state.setSessionRoot(sessionId, opened)
          sessionProject = opened
        }
        // T-203: opening a project through this route IS the panel pinning it (the
        // only way a panel may leave its session's workspace). The answer names
        // that source instead of inheriting the snapshot's generic 'explicit'.
        result.resolvedFrom = 'panel'
      }
      if (result.snapshot !== undefined && result.snapshot !== null) withSessionProject(result.snapshot, sessionProject)
      if (action === 'openProject' && result.ok === true) withSessionProject(result, sessionProject)
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  async function handleTask(req, res) {
    try {
      const sessionId = sessionFromRequest(req, null)
      const target = await resolveProject(req, null, sessionId)
      if (target.failed !== undefined) {
        sendJson(res, 200, { ok: false, code: 'no-project-bound', params: {} })
        return
      }
      const project = target.root
      const url = queryOf(req)
      const id = url === null ? '' : String(url.searchParams.get('id') === null ? '' : url.searchParams.get('id'))
      if (id === '') {
        sendJson(res, 400, { ok: false, code: 'missing-id', params: {} })
        return
      }
      state.noteProject(project, sessionId)
      sendJson(res, 200, await api.taskDetail(project, id))
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  async function handleList(req, res) {
    try {
      const sessionId = sessionFromRequest(req, null)
      const target = await resolveProject(req, null, sessionId)
      if (target.failed !== undefined) {
        sendJson(res, 200, { ok: false, code: 'no-project-bound', params: {} })
        return
      }
      const project = target.root
      const url = queryOf(req)
      state.noteProject(project, sessionId)
      const get = (name) => (url === null ? null : url.searchParams.get(name))
      sendJson(res, 200, await api.taskList(project, {
        status: get('status'),
        cursor: get('cursor'),
        limit: get('limit') === null ? null : Number(get('limit')),
        q: get('q'),
        archived: get('archived') === '1' || get('archived') === 'true',
      }))
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  /**
   * T-236: the activity timeline on its own request.
   *
   * The same project rules as /state and /meta (session resolution, explicit
   * pin), so the timeline can never describe a different project than the board
   * and the inventory do. ?cursor= (or the older ?since= spelling) is the
   * caller's last seen event; ?limit= bounds the page.
   */
  async function handleActivity(req, res) {
    try {
      const sessionId = sessionFromRequest(req, null)
      const target = await resolveProject(req, null, sessionId)
      if (target.failed !== undefined) {
        sendJson(res, 200, { ok: false, code: 'no-project-bound', params: {}, resolvedFrom: 'unbound' })
        return
      }
      const project = target.root
      state.noteProject(project, sessionId)
      const url = queryOf(req)
      const get = (name) => (url === null ? null : url.searchParams.get(name))
      const cursorRaw = get('cursor') === null ? get('since') : get('cursor')
      const limitRaw = get('limit')
      sendJson(res, 200, await api.activity(project, {
        cursor: cursorRaw === null || cursorRaw === '' ? null : String(cursorRaw),
        limit: limitRaw === null || limitRaw === '' || !Number.isFinite(Number(limitRaw)) ? undefined : Number(limitRaw),
      }))
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  async function handleWorktrees(req, res) {
    try {
      const sessionId = sessionFromRequest(req, null)
      const target = await resolveProject(req, null, sessionId)
      if (target.failed !== undefined) {
        sendJson(res, 200, { ok: false, code: 'no-project-bound', params: {} })
        return
      }
      const project = target.root
      state.noteProject(project, sessionId)
      const url = queryOf(req)
      const paths = []
      if (url !== null) {
        for (const value of url.searchParams.getAll('path')) {
          if (typeof value === 'string' && value !== '') paths.push(value)
        }
        for (const value of url.searchParams.getAll('paths')) {
          for (const part of String(value).split(',')) {
            if (part.trim() !== '') paths.push(part.trim())
          }
        }
      }
      // T-146: only the requested checkouts are probed; without paths the call
      // probes every non-main checkout (explicit, not on the /state path).
      sendJson(res, 200, await api.worktrees(project, { paths: paths.length === 0 ? null : paths }))
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  async function handleDiagnostics(req, res) {
    try {
      const sessionId = sessionFromRequest(req, null)
      const target = await resolveProject(req, null, sessionId)
      let project = null
      let health = null
      let workspacePlan = null
      if (target.failed === undefined) {
        project = target.root
        state.noteProject(project, sessionId)
        if (doctor !== null && typeof doctor.inspect === 'function') health = await doctor.inspect(project)
        if (workspace !== null && typeof workspace.plan === 'function') workspacePlan = await workspace.plan(project)
      }
      sendJson(res, 200, {
        ok: true,
        project: project,
        dispatch: probeDispatch(ctx),
        scheduler: scheduler === null ? null : scheduler.status(project === null ? undefined : project),
        merge: merger === null || typeof merger.status !== 'function' ? null : merger.status(),
        doctor: health,
        workspace: workspacePlan,
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'failed', message: String((error && error.message) || error) })
    }
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: STATE_PATH, handler: handleState }),
    ctx.webServer.register({ kind: 'exact', path: META_PATH, handler: handleMeta }),
    ctx.webServer.register({ kind: 'exact', path: ACTION_PATH, handler: handleAction }),
    ctx.webServer.register({ kind: 'exact', path: TASK_PATH, handler: handleTask }),
    ctx.webServer.register({ kind: 'exact', path: LIST_PATH, handler: handleList }),
    ctx.webServer.register({ kind: 'exact', path: ACTIVITY_PATH, handler: handleActivity }),
    ctx.webServer.register({ kind: 'exact', path: WORKTREES_PATH, handler: handleWorktrees }),
    ctx.webServer.register({ kind: 'exact', path: DIAGNOSTICS_PATH, handler: handleDiagnostics }),
  ]
  return function dispose() {
    for (const disposer of disposers) disposer()
  }
}