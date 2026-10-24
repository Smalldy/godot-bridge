/**
 * The state the task center's surfaces share.
 *
 * One object owns the board (through the CAS storage layer) and the in-memory
 * file locks, so the tool, the HTTP route and the scheduler all see the same
 * truth. The only thing that differs between surfaces is who is calling.
 */

import { homedir } from 'node:os'
import { createSessionLookup } from './session-lookup.mjs'
import { resolve } from 'node:path'
import {
  PROJECT_ACTIVE_MS,
  projectRefOf,
  readBoard,
  readProjectRegistry,
  resolveProjectRoot,
  updateBoard,
  writeProjectRegistry,
} from './board.mjs'
import { emptyLocks, expire as expireLocks } from './locks.mjs'

/** A readable message for anything thrown; state must never throw at a caller. */
function messageOf(error) {
  return error === null || error === undefined ? 'unknown error' : String((error && error.message) || error)
}

/**
 * @param ctx - the row's context; needs fs.
 * @param options.now - clock injection, for tests.
 * @param options.afterWrite - called after a board write lands; its result is
 *   not awaited, because a publish should not wait for a dispatch.
 */
export function createState(ctx, options) {
  const opts = options === undefined ? {} : options
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  // projectHint stays for callers that only need "the last project seen", but
  // it is never a resolution fallback; the registry + resolver own that.
  const memory = {
    locks: emptyLocks(),
    projectHint: null,
    registry: { version: 1, projects: [], lastActiveProjectId: null },
    registryLoaded: false,
    // T-96: session id -> { root, at }. The panel and the tool each carry their
    // own session id; no request may read another session's binding. This Map is
    // the ONLY store, and sessionRootOf(id) is the only reader.
    sessionRoots: new Map(),
    // Where the registry actually landed (or why it did not). Surfaced in the
    // snapshot and in openProject so "not persisted" is never silent again.
    registryStatus: { location: null, path: null, error: null, attempts: [], ok: false },
  }
  const SESSION_TTL_MS = 12 * 60 * 60 * 1000
  const SESSION_MAX = 64

  /** Sessions expire and are capped so a long-lived host cannot grow unbounded. */
  function pruneSessions() {
    const nowNow = clock()
    for (const [key, entry] of memory.sessionRoots) {
      if (entry === undefined || nowNow - entry.at > SESSION_TTL_MS) memory.sessionRoots.delete(key)
    }
    while (memory.sessionRoots.size > SESSION_MAX) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [key, entry] of memory.sessionRoots) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      memory.sessionRoots.delete(oldestKey)
    }
  }

  const homeDir = typeof opts.homeDir === 'string' && opts.homeDir.length > 0 ? opts.homeDir : homedir()
  const afterWrite = typeof opts.afterWrite === 'function' ? opts.afterWrite : null
  // The registry needs a directory that may not exist yet (`~/.dsh/godot-bridge`),
  // and a write policy that allows the target. Both come from the row; the
  // defaults degrade to "no directory creation, board policy".
  const ensureDir = typeof opts.ensureDir === 'function' ? opts.ensureDir : null
  const policyFor = typeof opts.sandboxPolicyFor === 'function' ? opts.sandboxPolicyFor : writePolicyFor
  const onRegistryError = typeof opts.onRegistryError === 'function' ? opts.onRegistryError : null
  // Session id -> workspace reverse lookup (T-102). Production injects the real
  // <home>/.dsh/sessions reader; tests inject a fixture so nothing touches disk.
  // undefined = build the real reader (production convenience); null = DISABLED
  // (every test rig opts out, so no test ever reads the developer's ~/.dsh).
  const lookupOption = opts.sessionLookup === undefined ? 'default' : opts.sessionLookup
  let lookupInstance = null
  function sessionLookup() {
    if (lookupOption === null) return null
    if (lookupInstance !== null) return lookupInstance
    lookupInstance = lookupOption === 'default' ? createSessionLookup({ homeDir: homeDir, isDir: opts.isDir }) : lookupOption
    return lookupInstance
  }

  let registryWrite = Promise.resolve()

  /** Merge two registry snapshots by project id, newest lastSeenAt wins. */
  function mergeRegistries(left, right) {
    const byId = new Map()
    for (const entry of left.projects.concat(right.projects)) {
      const current = byId.get(entry.id)
      const newer = current === undefined || String(entry.lastSeenAt).localeCompare(String(current.lastSeenAt)) > 0
      const sameInstant = current !== undefined && String(entry.lastSeenAt) === String(current.lastSeenAt)
      // Two touches in the same millisecond must not drop a worktreeRoot/preflight
      // that only one of them carries.
      const richer = sameInstant && (entry.worktreeRoot !== null || entry.preflight !== null) && (current.worktreeRoot === null && current.preflight === null)
      if (newer || (sameInstant && (richer || current === undefined))) {
        byId.set(entry.id, entry)
      }
    }
    // The last-active marker follows the newer copy, exactly like the file merge in
    // board.mjs — a touch made while this read was in flight must win.
    let lastActiveProjectId = null
    let best = null
    for (const candidate of [left.lastActiveProjectId, right.lastActiveProjectId]) {
      if (typeof candidate !== 'string' || candidate === '') continue
      const entry = byId.get(candidate)
      if (entry === undefined) continue
      if (best === null || String(entry.lastSeenAt).localeCompare(best) > 0) {
        best = entry.lastSeenAt
        lastActiveProjectId = candidate
      }
    }
    return { version: 1, projects: Array.from(byId.values()), lastActiveProjectId: lastActiveProjectId }
  }

  /** Load the persisted project registry once per process. projectRootOverride is
   * the session's workspace (T-96's per-session binding): it lets the workspace
   * fallback registry be merged even when the home copy is sandboxed away. */
  async function loadRegistry(projectRootOverride) {
    if (memory.registryLoaded) return memory.registry
    const projectRoot =
      typeof projectRootOverride === 'string' && projectRootOverride !== '' ? projectRootOverride : memory.projectHint
    const result = await readProjectRegistry({ fs: ctx.fs }, { homeDir: homeDir, projectRoot: projectRoot })
    // The disk is the older source: a project touched while this read was in
    // flight stays (the merge keeps the newer lastSeenAt per id).
    memory.registry = mergeRegistries(memory.registry, result.registry)
    memory.registryLoaded = true
    if (result.locations.length > 0) {
      memory.registryStatus = Object.assign({}, memory.registryStatus, { location: result.locations[0], ok: true, error: null })
    }
    return memory.registry
  }

  /**
   * Persist by READ-MERGE-WRITE: another surface (a second panel session, another
   * plugin instance) can touch its own project between our read and our write,
   * and a last-writer-wins whole-file write would silently drop it. On a CAS
   * loss the merge is retried against the fresh file.
   */
  function persistRegistry() {
    const run = async function () {
      let written = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const projectRoot = memory.projectHint
        const disk = await readProjectRegistry({ fs: ctx.fs }, { homeDir: homeDir, projectRoot: projectRoot })
        // Merge, never replace: a touch may have landed while the read was in
        // flight, and that project must not be dropped by disk's older snapshot.
        memory.registry = mergeRegistries(memory.registry, disk.registry)
        written = await writeProjectRegistry(
          { fs: ctx.fs },
          {
            homeDir: homeDir,
            projectRoot: projectRoot,
            sandboxPolicy: projectRoot === null ? undefined : policyFor(projectRoot),
            ensureDir: ensureDir,
          },
          memory.registry,
        )
        if (written.ok === true) break
      }
      if (written !== null && written.ok === true) {
        memory.registryStatus = { location: written.location, path: written.path, error: null, attempts: written.attempts === undefined ? [] : written.attempts, ok: true }
      } else {
        const failure = written === null ? { message: 'the registry write never ran', attempts: [] } : written
        memory.registryStatus = {
          location: null,
          path: null,
          error: failure.message === undefined ? 'registry-unwritable' : failure.message,
          attempts: failure.attempts === undefined ? [] : failure.attempts,
          ok: false,
        }
        if (onRegistryError !== null) {
          try {
            onRegistryError(memory.registryStatus)
          } catch (error) {}
        }
      }
      return written === null ? { ok: false } : written
    }
    registryWrite = registryWrite.then(run, run)
    return registryWrite
  }

  /** Where the registry was persisted, or the readable reason it was not. */
  function registryStatus() {
    return Object.assign({}, memory.registryStatus)
  }

  /** Wait for any pending registry write (tests and clean shutdown). */
  async function flushRegistry() {
    await registryWrite
  }

  /** Remember a project as active: memory now, disk soon, never blocking the caller. */
  function touchProject(projectPath, sessionId, extra) {
    if (typeof projectPath !== 'string' || projectPath.length === 0) return null
    const ref = projectRefOf(resolve(projectPath))
    const nowIso = new Date(clock()).toISOString()
    const previous = memory.registry.projects.filter((entry) => entry.id === ref.id)[0]
    const projects = memory.registry.projects.filter((entry) => entry.id !== ref.id)
    projects.unshift({
      id: ref.id,
      root: ref.root,
      lastSeenAt: nowIso,
      lastSessionId: typeof sessionId === 'string' ? sessionId : null,
      worktreeRoot: extra !== undefined && extra !== null && typeof extra.worktreeRoot === 'string' ? extra.worktreeRoot : previous === undefined ? null : previous.worktreeRoot,
      preflight: extra !== undefined && extra !== null && extra.preflight !== undefined ? extra.preflight : previous === undefined ? null : previous.preflight,
    })
    // Every successful activation stamps the single "last active" id.
    memory.registry = { version: 1, projects: projects, lastActiveProjectId: ref.id }
    memory.projectHint = ref.root
    persistRegistry()
    return ref
  }

  /** @deprecated use touchProject; kept so existing call sites keep compiling. */
  function noteProject(projectPath, sessionId) {
    touchProject(projectPath, sessionId)
  }

  /**
   * The workspace a session id maps to, by looking its DSH session directory up.
   * Never guessed: an unknown id, an undecodable directory or an ambiguous name is
   * a readable failure, and it does NOT fall back to "the most recent project".
   */
  async function lookupSessionRoot(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') return { ok: false, code: 'bad-session-id', message: 'no session id' }
    let instance
    try {
      instance = sessionLookup()
    } catch (error) {
      return { ok: false, code: 'lookup-unavailable', message: messageOf(error) }
    }
    if (instance === null) return { ok: false, code: 'lookup-unavailable', message: 'session lookup is not configured' }
    const fn = instance !== null && typeof instance === 'object' && typeof instance.lookup === 'function' ? instance.lookup : typeof instance === 'function' ? instance : null
    if (fn === null) return { ok: false, code: 'lookup-unavailable', message: 'no session lookup adapter' }
    try {
      const result = await fn(sessionId)
      if (result === null || result === undefined || result.ok !== true) {
        return { ok: false, code: result !== null && result !== undefined && result.code !== undefined ? result.code : 'no-session', message: result !== null && result !== undefined && result.message !== undefined ? String(result.message) : 'session workspace unknown' }
      }
      return { ok: true, path: String(result.path), dir: result.dir === undefined ? null : result.dir }
    } catch (error) {
      return { ok: false, code: 'lookup-failed', message: messageOf(error) }
    }
  }

  /**
   * The single resolution rule: explicit wins, then the SESSION LOOKUP (so a
   * panel that has not called a tool yet still knows its project), then the
   * workspace this session recorded, then a readable no-project-bound refusal.
   */
  async function resolveProject(options) {
    const o = options === undefined || options === null ? {} : options
    const explicit = typeof o.explicit === 'string' && o.explicit.trim().length > 0 ? o.explicit.trim() : ''
    if (explicit !== '') {
      return { ok: true, project: projectRefOf(resolve(explicit)), resolvedFrom: o.explicitSource === 'panel' ? 'panel' : 'explicit' }
    }
    const sessionId = typeof o.sessionId === 'string' && o.sessionId.trim() !== '' ? o.sessionId.trim() : null
    if (sessionId !== null) {
      const looked = await lookupSessionRoot(sessionId)
      if (looked.ok === true) {
        // Walk the looked-up workspace UP to its nearest git project, exactly like
        // a recorded session workspace: the sessions dir names the workspace, not
        // necessarily the repository root.
        const viaLookup = await resolveProjectRoot({ fs: ctx.fs }, { explicit: null, sessionRoot: looked.path })
        if (viaLookup.ok === true) {
          return { ok: true, project: projectRefOf(viaLookup.root), resolvedFrom: 'session-lookup', sessionWarn: null }
        }
      }
    }
    const start = typeof o.sessionRoot === 'string' && o.sessionRoot.length > 0 ? o.sessionRoot : null
    const resolved = await resolveProjectRoot({ fs: ctx.fs }, { explicit: null, sessionRoot: start })
    if (resolved.ok === true) return { ok: true, project: projectRefOf(resolved.root), resolvedFrom: resolved.resolvedFrom }
    // LAST resort, only for the panel/startup path (o.allowLastActive): the single
    // project the host activated last time. Absent => the readable unbound answer
    // above (never "some recently active project").
    if (o.allowLastActive === true) {
      const lastActive = lastActiveProject()
      if (lastActive !== null) {
        const viaLast = await resolveProjectRoot({ fs: ctx.fs }, { explicit: null, sessionRoot: lastActive.root })
        if (viaLast.ok === true) return { ok: true, project: projectRefOf(viaLast.root), resolvedFrom: 'last-active' }
      }
    }
    return resolved
  }

  /**
   * The project that was active when the host last ran, or null when NOTHING was
   * ever activated. Deliberately NOT "the most recently seen project": startup
   * must be able to say "nothing activated" instead of picking a card.
   */
  function lastActiveProject() {
    const id = memory.registry.lastActiveProjectId
    if (typeof id !== 'string' || id === '') return null
    const entry = memory.registry.projects.filter((candidate) => candidate.id === id)[0]
    return entry === undefined ? null : entry
  }

  /** Projects the background loop should drive right now (seen in the last 24h). */
  function activeProjects(nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : clock()
    return memory.registry.projects
      .filter((entry) => {
        const at = Date.parse(entry.lastSeenAt)
        return Number.isFinite(at) && now - at <= PROJECT_ACTIVE_MS
      })
      .sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))
  }

  /** Adopt the project a panel request carries, and make sure the loop drives it. */
  async function adoptPanelProject(projectPath, sessionId) {
    const ref = touchProject(projectPath, sessionId)
    return ref
  }

  async function read(projectPath) {
    const result = await readBoard({ fs: ctx.fs }, { projectPath: projectPath, now: clock() })
    if (result.ok === false) return { failed: result }
    return { failed: null, board: result.board, existed: result.existed }
  }

  /**
   * Apply a model function under the board's CAS.
   *
   * A refusal from the model aborts the write, so a refused action never touches
   * the file. On a lost version race the mutation runs again against freshly
   * read content.
   */
  async function apply(projectPath, mutate, sandboxPolicy) {
    let outcome = null
    const written = await updateBoard(
      { fs: ctx.fs },
      {
        projectPath: projectPath,
        sandboxPolicy: sandboxPolicy,
        now: clock(),
        mutate: function (board, attempt) {
          const result = mutate(board, attempt)
          outcome = result
          return result !== null && result !== undefined && result.ok === true ? result.board : undefined
        },
      },
    )
    if (outcome !== null && outcome.ok === false) return { failed: outcome }
    if (written.ok === false) return { failed: { ok: false, code: written.code, message: written.message } }
    if (afterWrite !== null) {
      try {
        const pending = afterWrite({ projectPath: projectPath, board: written.board, events: outcome === null ? [] : outcome.events })
        if (pending !== undefined && pending !== null && typeof pending.catch === 'function') pending.catch(function () {})
      } catch (error) {}
    }
    return {
      failed: null,
      board: written.board,
      version: written.version,
      attempts: written.attempts,
      events: outcome === null ? [] : outcome.events,
    }
  }

  /** Reap expired file locks; returns the events for whoever asked. */
  function sweepLocks() {
    const result = expireLocks(memory.locks, clock())
    memory.locks = result.locks
    return result.expired
  }

  return {
    clock: clock,
    memory: memory,
    read: read,
    apply: apply,
    sweepLocks: sweepLocks,
    noteProject: noteProject,
    touchProject: touchProject,
    loadRegistry: loadRegistry,
    flushRegistry: flushRegistry,
    lookupSessionRoot: lookupSessionRoot,
    lastActiveProject: lastActiveProject,
    resolveProject: resolveProject,
    activeProjects: activeProjects,
    adoptPanelProject: adoptPanelProject,
    setSessionRoot: function (sessionId, root) {
      if (typeof sessionId !== 'string' || sessionId === '' || root === undefined) return null
      pruneSessions()
      memory.sessionRoots.set(sessionId, { root: typeof root === 'string' && root.length > 0 ? root : null, at: clock() })
      const entry = memory.sessionRoots.get(sessionId)
      // T-98: a session root is the first chance to merge THAT project's workspace
      // registry (the home copy may be sandboxed away). Only when the registry is
      // still empty, so a concurrent touch cannot be dropped by this read.
      if (memory.registryLoaded !== true && entry.root !== null && memory.registry.projects.length === 0) void loadRegistry(entry.root)
      return entry
    },
    sessionRootOf: function (sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      pruneSessions()
      const entry = memory.sessionRoots.get(sessionId)
      return entry === undefined || entry.root === null ? null : entry.root
    },
    registryStatus: registryStatus,
  }
}

/** The sandbox policy a board write needs: the board sits inside the project,
 * which may lie outside the session workspace. */
export function writePolicyFor(projectPath) {
  return { mode: 'workspace-write', workspaceRoot: projectPath }
}
