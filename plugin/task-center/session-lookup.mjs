import { homedir } from 'node:os'
import { join } from 'node:path'
import { readdirSync, statSync } from 'node:fs'

/** How long the workspace-directory listing and one session's answer are cached. */
export const SESSION_LOOKUP_TTL_MS = 30 * 1000

/** Names a DSH session workspace directory carries: `--<encoded path>--`. */
export function isSessionDirName(name) {
  return typeof name === 'string' && name.length >= 4 && name.startsWith('--') && name.endsWith('--')
}

/**
 * Undo the `~HEX~` escaping DSH applies to every non-ASCII code point. A
 * malformed escape is NOT guessed around: the whole name becomes undecodable.
 */
export function unescapeSessionName(inner) {
  // DSH writes a non-ASCII UTF-16 code unit as `~` + FOUR uppercase hex digits,
  // with no closing tilde (e.g. `~91CD` = 重). A '~' that is not followed by four
  // hex digits is a literal tilde, so ordinary names round-trip unchanged.
  let out = ''
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]
    if (char !== '~') {
      out = out + char
      continue
    }
    const hex = inner.slice(index + 1, index + 5)
    if (/^[0-9a-fA-F]{4}$/.test(hex) !== true) {
      out = out + char
      continue
    }
    out = out + String.fromCharCode(parseInt(hex, 16))
    index = index + 4
  }
  return { ok: true, text: out }
}

/**
 * Turn a session workspace directory name back into a real path.
 *
 * The encoding collapses the path separators AND ':' into '-', so the inner
 * slug alone is ambiguous ("godot-bridge" could be one directory or two). The
 * inverse is therefore validated against the filesystem: every '-'-joined
 * segment is only accepted when that directory EXISTS, and exactly one complete
 * path may remains. Zero matches is `undecodable`; more than one is
 * `ambiguous` — both are readable failures, never a guess.
 */
export function decodeSessionDirName(name, options) {
  const opts = options === undefined || options === null ? {} : options
  const isDir = typeof opts.isDir === 'function' ? opts.isDir : (path) => {
    try {
      return statSync(path).isDirectory()
    } catch (error) {
      return false
    }
  }
  if (isSessionDirName(name) !== true) {
    return { ok: false, code: 'not-encoded', message: '"' + String(name) + '" is not a --...-- session directory name' }
  }
  const unescaped = unescapeSessionName(name.slice(2, -2))
  if (unescaped.ok !== true) return { ok: false, code: 'undecodable', message: unescaped.message }
  const parts = unescaped.text.split('-')
  if (parts.length === 0 || parts[0] === '') {
    return { ok: false, code: 'undecodable', message: '"' + unescaped.text + '" has no first segment' }
  }
  // Windows drive letters are a single ASCII letter; anything else is treated as
  // a POSIX root (the leading '/' is part of the encoding's own '-' prefix).
  const windowsDrive = /^[A-Za-z]$/.test(parts[0])
  const base = windowsDrive ? parts[0] + ':\\' : '/'
  const rest = windowsDrive ? parts.slice(1) : parts
  const matches = []
  const walk = (prefix, index) => {
    if (index >= rest.length) {
      matches.push(prefix)
      return
    }
    for (let end = index + 1; end <= rest.length; end++) {
      const candidate = join(prefix, rest.slice(index, end).join('-'))
      if (isDir(candidate) === true) walk(candidate, end)
    }
  }
  walk(base, 0)
  if (matches.length === 1) return { ok: true, path: matches[0] }
  if (matches.length === 0) {
    return { ok: false, code: 'undecodable', message: 'no existing directory matches "' + unescaped.text + '"' }
  }
  return { ok: false, code: 'ambiguous', message: '"' + unescaped.text + '" matches ' + String(matches.length) + ' directories: ' + matches.join(', ') }
}

/**
 * Session id -> workspace path, by LOOKING the sessions tree up (never by
 * guessing): DSH stores one directory per workspace under
 * `<home>/.dsh/sessions/`, each holding `session-<id>` (or plain `<id>`).
 *
 * Performance: the workspace listing is cached for `ttlMs`, and each session
 * answer is cached too, so a panel that reads /state on a timer costs one stat
 * per workspace directory at most.
 */
export function createSessionLookup(options) {
  const opts = options === undefined || options === null ? {} : options
  const homeDir = typeof opts.homeDir === 'string' && opts.homeDir.length > 0 ? opts.homeDir : homedir()
  const sessionsDir = typeof opts.sessionsDir === 'string' && opts.sessionsDir.length > 0 ? opts.sessionsDir : join(homeDir, '.dsh', 'sessions')
  const readdir = typeof opts.readdir === 'function' ? opts.readdir : (dir) => {
    try {
      return readdirSync(dir)
    } catch (error) {
      return null
    }
  }
  const exists = typeof opts.exists === 'function' ? opts.exists : (path) => {
    try {
      statSync(path)
      return true
    } catch (error) {
      return false
    }
  }
  const ttlMs = Number.isFinite(opts.ttlMs) ? Math.max(0, opts.ttlMs) : SESSION_LOOKUP_TTL_MS
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const decoded = new Map()
  const answers = new Map()
  let listing = { at: 0, dirs: null }

  function workspaceDirs() {
    const at = now()
    if (listing.dirs !== null && at - listing.at < ttlMs) return listing.dirs
    const names = readdir(sessionsDir)
    const dirs = Array.isArray(names) ? names.filter(isSessionDirName).sort() : []
    listing = { at: at, dirs: dirs }
    return dirs
  }

  function decode(name) {
    if (decoded.has(name)) return decoded.get(name)
    const result = decodeSessionDirName(name, { isDir: opts.isDir })
    decoded.set(name, result)
    return result
  }

  /** The workspace of one session, or a readable reason it cannot be known. */
  function lookup(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '' || sessionId.indexOf('/') >= 0 || sessionId.indexOf('\\') >= 0) {
      return { ok: false, code: 'bad-session-id', message: 'a session id is a non-empty name without path separators' }
    }
    const id = sessionId.trim()
    const at = now()
    const cached = answers.get(id)
    if (cached !== undefined && at - cached.at < ttlMs) return cached.result
    const hits = []
    for (const dir of workspaceDirs()) {
      const root = join(sessionsDir, dir)
      const variants = ['session-' + id, id]
      for (const variant of variants) {
        if (exists(join(root, variant)) === true) {
          hits.push(dir)
          break
        }
      }
    }
    let result
    if (hits.length === 0) {
      result = { ok: false, code: 'no-session', message: 'no DSH session directory holds session "' + id + '" under ' + sessionsDir }
    } else {
      const outcomes = hits.map((dir) => decode(dir))
      const good = outcomes.filter((entry) => entry.ok === true)
      const paths = Array.from(new Set(good.map((entry) => entry.path)))
      if (paths.length === 1) {
        result = { ok: true, path: paths[0], dir: hits[outcomes.findIndex((entry) => entry.ok === true)] }
      } else if (good.length === 0) {
        result = { ok: false, code: outcomes[0].code === 'ambiguous' ? 'ambiguous' : 'undecodable', message: outcomes[0].message }
      } else {
        result = { ok: false, code: 'ambiguous', message: 'session "' + id + '" matches several workspaces: ' + paths.join(', ') }
      }
    }
    answers.set(id, { at: at, result: result })
    return result
  }

  return { sessionsDir: sessionsDir, lookup: lookup, decode: decode, workspaceDirs: workspaceDirs, clear: function () { answers.clear(); listing = { at: 0, dirs: null } } }
}
