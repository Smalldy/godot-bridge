/**
 * The state the task center's surfaces share.
 *
 * One object owns the board (through the CAS storage layer) and the in-memory
 * file locks, so the tool, the HTTP route and the scheduler all see the same
 * truth. The only thing that differs between surfaces is who is calling.
 */

import { homedir } from 'node:os'
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
    registry: { version: 1, projects: [] },
    registryLoaded: false,
    sessionRoot: null,
  }
  const homeDir = typeof opts.homeDir === 'string' && opts.homeDir.length > 0 ? opts.homeDir : homedir()
  const afterWrite = typeof opts.afterWrite === 'function' ? opts.afterWrite : null

  let registryWrite = Promise.resolve()

  /** Merge two registry snapshots by project id, newest lastSeenAt wins. */
  function mergeRegistries(left, right) {
    const byId = new Map()
    for (const entry of left.projects.concat(right.projects)) {
      const current = byId.get(entry.id)
      if (current === undefined || String(entry.lastSeenAt).localeCompare(String(current.lastSeenAt)) >= 0) {
        byId.set(entry.id, entry)
      }
    }
    return { version: 1, projects: Array.from(byId.values()) }
  }

  /** Load the persisted project registry once per process. */
  async function loadRegistry() {
    if (memory.registryLoaded) return memory.registry
    const result = await readProjectRegistry({ fs: ctx.fs }, { homeDir: homeDir })
    memory.registry = result.registry
    memory.registryLoaded = true
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
      for (let attempt = 0; attempt < 3; attempt++) {
        const disk = await readProjectRegistry({ fs: ctx.fs }, { homeDir: homeDir })
        memory.registry = mergeRegistries(memory.registry, disk.registry)
        const written = await writeProjectRegistry({ fs: ctx.fs }, { homeDir: homeDir }, memory.registry)
        if (written.ok !== false) return written
      }
      return { ok: false }
    }
    registryWrite = registryWrite.then(run, run)
    return registryWrite
  }

  /** Wait for any pending registry write (tests and clean shutdown). */
  async function flushRegistry() {
    await registryWrite
  }

  /** Remember a project as active: memory now, disk soon, never blocking the caller. */
  function touchProject(projectPath, sessionId) {
    if (typeof projectPath !== 'string' || projectPath.length === 0) return null
    const ref = projectRefOf(resolve(projectPath))
    const nowIso = new Date(clock()).toISOString()
    const projects = memory.registry.projects.filter((entry) => entry.id !== ref.id)
    projects.unshift({ id: ref.id, root: ref.root, lastSeenAt: nowIso, lastSessionId: typeof sessionId === 'string' ? sessionId : null })
    memory.registry = { version: 1, projects: projects }
    memory.projectHint = ref.root
    persistRegistry()
    return ref
  }

  /** @deprecated use touchProject; kept so existing call sites keep compiling. */
  function noteProject(projectPath, sessionId) {
    touchProject(projectPath, sessionId)
  }

  /**
   * The single resolution rule: explicit wins, then the session workspace walked
   * up to the nearest git project, then a readable no-project-bound refusal.
   */
  async function resolveProject(options) {
    const o = options === undefined || options === null ? {} : options
    const explicit = typeof o.explicit === 'string' && o.explicit.trim().length > 0 ? o.explicit.trim() : ''
    if (explicit !== '') {
      return { ok: true, project: projectRefOf(resolve(explicit)), resolvedFrom: o.explicitSource === 'panel' ? 'panel' : 'explicit' }
    }
    const start = typeof o.sessionRoot === 'string' && o.sessionRoot.length > 0 ? o.sessionRoot : memory.sessionRoot
    const resolved = await resolveProjectRoot({ fs: ctx.fs }, { explicit: null, sessionRoot: start })
    if (resolved.ok !== true) return resolved
    return { ok: true, project: projectRefOf(resolved.root), resolvedFrom: resolved.resolvedFrom }
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
    resolveProject: resolveProject,
    activeProjects: activeProjects,
    adoptPanelProject: adoptPanelProject,
    setSessionRoot: function (root) {
      memory.sessionRoot = typeof root === 'string' && root.length > 0 ? root : null
    },
  }
}

/** The sandbox policy a board write needs: the board sits inside the project,
 * which may lie outside the session workspace. */
export function writePolicyFor(projectPath) {
  return { mode: 'workspace-write', workspaceRoot: projectPath }
}
