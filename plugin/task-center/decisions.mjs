/**
 * T-195 鈥?the durable DecisionRequest store.
 *
 * A DecisionRequest is how the HOST asks a human a question without blocking:
 * it writes a pending request with a deadline (and usually a default option),
 * the panel answers it exactly once, and the timeout sweep records the default
 * when the deadline passes. Nothing here knows what an event MEANS 鈥?the
 * create/timeout/lifecycle callers pass the generic payload, options, default
 * and timeout, and the store only enforces the transport rules:
 *
 *   - persisted at <project>/.agents/decisions.json through the fs facade's
 *     version CAS (atomic replace), so a restart recovers pending requests;
 *   - request(id) is idempotent: replaying the same content returns the stored
 *     request, different content under the same id is a typed conflict;
 *   - answer(id) is ONE-SHOT: a second answer is 'already-answered', an answer
 *     after the deadline is 'decision-expired' (never silently accepted);
 *   - a timeout records the default option unless it is marked dangerous 鈥? *     destructive options never auto-run;
 *   - answered/expired/cancelled records are trimmed, pending are never lost.
 *
 * The store is pure IO + rules. The action layer (actions/decisions.mjs) maps it
 * onto decisionList/decisionAnswer; the API exposes the same primitives to the
 * lifecycle code that will create requests (T-196/T-197).
 */

import { join } from 'node:path'
import {
  BOARD_DIRECTORY,
  DECISION_ANSWERED,
  DECISION_CANCELLED,
  DECISION_CONFIRM_WORD,
  DECISION_DEFAULT_TIMEOUT_MS,
  DECISION_EXPIRED,
  DECISION_FILENAME,
  DECISION_MAX_TIMEOUT_MS,
  DECISION_MIN_TIMEOUT_MS,
  DECISION_PENDING,
  DECISION_STATUSES,
  DECISION_TEXT_OPTION,
  DECISION_VERSION,
  MAX_DECISIONS,
  MAX_DECISION_BODY,
  MAX_DECISION_PAYLOAD_BYTES,
  MAX_DECISION_STORE_BYTES,
  MAX_DECISION_TEXT,
  MAX_DECISION_TITLE,
  MAX_RESOLVED_DECISIONS,
  normaliseDecisionOptions,
} from './schema.mjs'

/** Where one project's decision store lives. */
export function decisionsPath(projectPath) {
  return join(projectPath, BOARD_DIRECTORY, DECISION_FILENAME)
}

function failure(code, message, extra) {
  return Object.assign({ ok: false, code: code, message: message }, extra === undefined ? {} : extra)
}

function describe(error) {
  return error === null || error === undefined ? 'unknown error' : String((error && error.message) || error)
}

function iso(now) {
  return new Date(now).toISOString()
}

function isIso(value) {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value))
}

function isStale(error) {
  if (error === null || error === undefined) return false
  if (typeof error.code === 'string' && error.code === 'FS_STALE_VERSION') return true
  return /FS_STALE_VERSION/.test(String(error.message || ''))
}

/** Deterministic JSON, so a replayed request fingerprints identically. */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}

export function emptyDecisionStore(now) {
  return { version: DECISION_VERSION, requests: [], updatedAt: iso(typeof now === 'number' ? now : Date.now()) }
}

/** Coerce a stored record; undefined when it cannot be trusted at all. */
function normaliseRecord(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return undefined
  const status = DECISION_STATUSES.indexOf(raw.status) >= 0 ? raw.status : undefined
  if (status === undefined) return undefined
  const options = normaliseDecisionOptions(raw.options)
  if (options === null) return undefined
  const timeoutAt = isIso(raw.timeoutAt) ? raw.timeoutAt : null
  const createdAt = isIso(raw.createdAt) ? raw.createdAt : null
  if (createdAt === null) return undefined
  const defaultOption = typeof raw.defaultOption === 'string' && raw.defaultOption !== '' ? raw.defaultOption : null
  const resolution =
    raw.resolution !== null && raw.resolution !== undefined && typeof raw.resolution === 'object'
      ? {
          option: typeof raw.resolution.option === 'string' ? raw.resolution.option : null,
          text: typeof raw.resolution.text === 'string' && raw.resolution.text !== '' ? raw.resolution.text : null,
          by: typeof raw.resolution.by === 'string' ? raw.resolution.by : null,
          via: typeof raw.resolution.via === 'string' ? raw.resolution.via : 'user',
          at: isIso(raw.resolution.at) ? raw.resolution.at : null,
        }
      : null
  return {
    id: id,
    eventKey: typeof raw.eventKey === 'string' ? raw.eventKey : 'generic',
    taskId: typeof raw.taskId === 'string' && raw.taskId !== '' ? raw.taskId : null,
    eventLabel: typeof raw.eventLabel === 'string' ? raw.eventLabel : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    body: typeof raw.body === 'string' ? raw.body : '',
    options: options,
    defaultOption: defaultOption,
    highRisk: raw.highRisk === true,
    requiresText: raw.requiresText === true,
    payload: raw.payload !== null && raw.payload !== undefined && typeof raw.payload === 'object' ? raw.payload : null,
    status: status,
    timeoutAt: timeoutAt,
    createdAt: createdAt,
    updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : createdAt,
    resolvedAt: isIso(raw.resolvedAt) ? raw.resolvedAt : null,
    resolution: resolution,
    outcome: typeof raw.outcome === 'string' ? raw.outcome : null,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    answeredBy: typeof raw.answeredBy === 'string' ? raw.answeredBy : null,
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
  }
}

/** Keep every pending request; trim resolved ones to the newest cap. */
function pruneRequests(requests) {
  const pending = []
  const resolved = []
  for (const record of requests) {
    if (record.status === DECISION_PENDING) pending.push(record)
    else resolved.push(record)
  }
  resolved.sort((left, right) => String(right.resolvedAt || right.updatedAt).localeCompare(String(left.resolvedAt || left.updatedAt)))
  return pending.concat(resolved.slice(0, MAX_RESOLVED_DECISIONS))
}

export function normaliseDecisionStore(parsed, now) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('unrecognisable', 'the decisions file is not a JSON object')
  }
  if (Number.isFinite(parsed.version) && parsed.version > DECISION_VERSION) {
    return failure('unsupported-version', 'the decisions file version ' + String(parsed.version) + ' is newer than this host understands')
  }
  const requests = []
  const seen = new Set()
  for (const raw of Array.isArray(parsed.requests) ? parsed.requests : []) {
    const record = normaliseRecord(raw)
    if (record === undefined) continue
    if (seen.has(record.id)) continue
    seen.add(record.id)
    requests.push(record)
  }
  return {
    ok: true,
    store: {
      version: DECISION_VERSION,
      requests: pruneRequests(requests),
      updatedAt: isIso(parsed.updatedAt) ? parsed.updatedAt : iso(typeof now === 'number' ? now : Date.now()),
    },
  }
}

export async function readDecisionStore(io, options) {
  const projectPath = options.projectPath
  const signal = options.signal
  try {
    const target = await io.fs.resolve(decisionsPath(projectPath), { cwd: projectPath, signal: signal })
    const info = await io.fs.stat(target, signal)
    if (info === undefined) return { ok: true, store: emptyDecisionStore(options.now), version: null, existed: false }
    if (Number.isFinite(info.size) && info.size > MAX_DECISION_STORE_BYTES) {
      return failure('too-large', 'the decisions file is ' + String(info.size) + ' bytes; refusing to load more than ' + String(MAX_DECISION_STORE_BYTES))
    }
    const text = await io.fs.readText(target, signal)
    if (Buffer.byteLength(text, 'utf8') > MAX_DECISION_STORE_BYTES) {
      return failure('too-large', 'the decisions file is larger than ' + String(MAX_DECISION_STORE_BYTES) + ' bytes')
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return failure('unparseable', 'the decisions file is not valid JSON, so it is left untouched: ' + describe(error))
    }
    const normalised = normaliseDecisionStore(parsed, options.now)
    if (normalised.ok !== true) return normalised
    return { ok: true, store: normalised.store, version: info.version, existed: true }
  } catch (error) {
    return failure('unreadable', describe(error))
  }
}

async function ensureDirFor(io, projectPath, options) {
  if (typeof options.ensureDir !== 'function') return
  try {
    await Promise.resolve(options.ensureDir(join(projectPath, BOARD_DIRECTORY)))
  } catch (error) {
    // A missing creator is not fatal here: the write below reports the real error.
  }
}

async function writeStore(io, options, store, version) {
  try {
    const target = await io.fs.resolve(decisionsPath(options.projectPath), { cwd: options.projectPath, signal: options.signal })
    const expected = version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: version }
    const outcome = await io.fs.writeText(
      target,
      JSON.stringify(store, null, 2) + '\n',
      expected,
      options.signal,
      options.sandboxPolicy,
    )
    return { ok: true, version: outcome.version }
  } catch (error) {
    return failure(isStale(error) ? 'stale' : 'unwritable', describe(error))
  }
}

/** Writes to one path run one at a time; a rejection never poisons the queue. */
const chains = new Map()
function serialise(key, operation) {
  const previous = chains.get(key) || Promise.resolve()
  const run = previous.then(operation, operation)
  chains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * Apply a mutation under the store's version CAS.
 *
 * mutate(store, attempt) returns the next store (may be the same object when the
 * caller only recorded an outcome), or null to abort. The caller reads its own
 * typed result from a closure, exactly like the answer path below.
 */
async function updateDecisionStore(io, options, mutate) {
  const limit = Number.isFinite(options.attempts) && options.attempts >= 1 ? Math.floor(options.attempts) : 3
  return serialise(decisionsPath(options.projectPath), async () => {
    let attempts = 0
    for (;;) {
      attempts += 1
      const current = await readDecisionStore(io, options)
      if (current.ok !== true) return current
      const next = mutate(current.store, attempts)
      if (next === undefined || next === null) return failure('aborted', 'the mutator declined the change')
      const payload = { version: DECISION_VERSION, requests: pruneRequests(next.requests), updatedAt: iso(options.now) }
      await ensureDirFor(io, options.projectPath, options)
      const written = await writeStore(io, options, payload, current.existed === true ? current.version : null)
      if (written.ok === true) return { ok: true, store: payload, version: written.version, attempts: attempts }
      if (written.code !== 'stale' || attempts >= limit) return Object.assign({}, written, { attempts: attempts })
    }
  })
}

/** One request's panel-facing shape. remainingMs comes from the SERVER clock
 * so a countdown never depends on the browser's own deadline arithmetic. */
export function decisionView(record, now) {
  const timeoutAt = record.timeoutAt
  const remainingMs =
    record.status === DECISION_PENDING && timeoutAt !== null ? Math.max(0, Date.parse(timeoutAt) - now) : null
  return {
    id: record.id,
    status: record.status,
    eventKey: record.eventKey,
    taskId: record.taskId,
    eventLabel: record.eventLabel,
    title: record.title,
    body: record.body,
    options: record.options,
    defaultOption: record.defaultOption,
    highRisk: record.highRisk,
    requiresText: record.requiresText,
    payload: record.payload,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    timeoutAt: timeoutAt,
    remainingMs: remainingMs,
    resolvedAt: record.resolvedAt,
    resolution: record.resolution,
    outcome: record.outcome,
    answeredBy: record.answeredBy,
  }
}

function isDue(record, now) {
  return record.status === DECISION_PENDING && record.timeoutAt !== null && Date.parse(record.timeoutAt) <= now
}

/**
 * The timeout rule: record the default option when it is SAFE; a dangerous
 * option never auto-runs, so the request expires unresolved and must be handled
 * by a human. An answered request is never touched.
 */
function applyTimeout(record, at) {
  const chosen = record.options.filter((option) => option.id === record.defaultOption)[0]
  const safe = chosen !== undefined && chosen.danger !== true ? chosen.id : null
  record.status = DECISION_EXPIRED
  record.resolvedAt = at
  record.updatedAt = at
  record.outcome = safe === null ? 'requires-manual' : 'default'
  record.resolution = safe === null ? null : { option: safe, text: null, by: 'timeout', via: 'timeout', at: at }
  return record
}

function normaliseTimeout(raw) {
  if (raw === null || raw === undefined) return { ok: true, timeoutMs: DECISION_DEFAULT_TIMEOUT_MS }
  if (raw === 0 || raw === false) return { ok: true, timeoutMs: 0 }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { ok: false, code: 'invalid-timeout', message: 'timeoutMs must be a number' }
  const ms = Math.floor(raw)
  if (ms <= 0) return { ok: true, timeoutMs: 0 }
  if (ms < DECISION_MIN_TIMEOUT_MS) return { ok: true, timeoutMs: DECISION_MIN_TIMEOUT_MS }
  if (ms > DECISION_MAX_TIMEOUT_MS) return { ok: true, timeoutMs: DECISION_MAX_TIMEOUT_MS }
  return { ok: true, timeoutMs: ms }
}

function textOf(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : ''
}

/** The next free DEC-<n> id, scanning the store (never reuses a stored id). */
function nextDecisionId(store) {
  let highest = 0
  for (const record of store.requests) {
    const match = /^DEC-(\d+)$/.exec(record.id)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return 'DEC-' + String(highest + 1)
}

/**
 * Validate one request input into a record. Returns { ok, record } or a typed
 * failure; id and createdAt are resolved by the caller.
 */
function buildRecord(input, nowIso, id, by) {
  const eventKey = textOf(input.eventKey === undefined ? input.kind : input.eventKey, 64) || 'generic'
  const taskId = textOf(input.taskId, 64) || null
  const eventLabel = textOf(input.eventLabel, 200)
  const title = textOf(input.title, MAX_DECISION_TITLE)
  const body = textOf(input.body, MAX_DECISION_BODY)
  if (title === '' && body === '') return failure('invalid-request', 'a decision needs a title or a body')
  const options = normaliseDecisionOptions(input.options)
  if (options === null) return failure('invalid-request', 'options must be unique objects with an id and a label')
  const payload = input.payload === undefined || input.payload === null ? null : input.payload
  if (payload !== null && typeof payload !== 'object') return failure('invalid-request', 'payload must be an object')
  if (payload !== null && Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_DECISION_PAYLOAD_BYTES) {
    return failure('invalid-request', 'payload exceeds ' + String(MAX_DECISION_PAYLOAD_BYTES) + ' bytes')
  }
  const defaultOption = textOf(input.defaultOption, 64) || null
  if (defaultOption !== null && options.filter((option) => option.id === defaultOption).length === 0) {
    return failure('invalid-request', 'defaultOption "' + defaultOption + '" is not one of the options')
  }
  const highRisk = input.highRisk === true
  const requiresText = input.requiresText === true || options.length === 0
  const timeout = normaliseTimeout(input.timeoutMs)
  if (timeout.ok !== true) return timeout
  // Mark the default option so the panel can render the badge without a second source.
  const marked = options.map((option) => Object.assign({}, option, { default: option.id === defaultOption }))
  const fingerprint = stableStringify({
    eventKey: eventKey,
    taskId: taskId,
    eventLabel: eventLabel,
    title: title,
    body: body,
    options: marked,
    defaultOption: defaultOption,
    highRisk: highRisk,
    requiresText: requiresText,
    timeoutMs: timeout.timeoutMs,
    payload: payload,
  })
  return {
    ok: true,
    record: {
      id: id,
      eventKey: eventKey,
      taskId: taskId,
      eventLabel: eventLabel,
      title: title,
      body: body,
      options: marked,
      defaultOption: defaultOption,
      highRisk: highRisk,
      requiresText: requiresText,
      payload: payload,
      status: DECISION_PENDING,
      timeoutAt: timeout.timeoutMs > 0 ? iso(Date.parse(nowIso) + timeout.timeoutMs) : null,
      createdAt: nowIso,
      updatedAt: nowIso,
      resolvedAt: null,
      resolution: null,
      outcome: null,
      createdBy: by,
      answeredBy: null,
      fingerprint: fingerprint,
    },
  }
}

/** One pending request's panel view list, oldest first (the queue order). */
async function pendingViews(io, options) {
  const read = await readDecisionStore(io, options)
  if (read.ok !== true) return read
  const pending = read.store.requests
    .filter((record) => record.status === DECISION_PENDING)
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .map((record) => decisionView(record, options.now))
  return { ok: true, pending: pending, store: read.store }
}

/**
 * The public store: one instance per API row, bound to the fs facade.
 *
 * options.now               clock injection (tests)
 * options.ensureDir         the row's directory creator (the fs facade never creates one)
 * options.sandboxPolicyFor  the write policy for a project (workspace-write)
 */
export function createDecisionStore(io, options) {
  const opts = options === undefined || options === null ? {} : options
  const clock = typeof opts.now === 'function' ? opts.now : Date.now
  const ensureDir = typeof opts.ensureDir === 'function' ? opts.ensureDir : null
  const sandboxPolicyFor =
    typeof opts.sandboxPolicyFor === 'function'
      ? opts.sandboxPolicyFor
      : function () {
          return undefined
        }

  function base(projectPath, extra) {
    const now = extra !== undefined && Number.isFinite(extra.now) ? extra.now : clock()
    return {
      projectPath: projectPath,
      now: now,
      ensureDir: ensureDir,
      sandboxPolicy: sandboxPolicyFor(projectPath),
      signal: extra === undefined ? undefined : extra.signal,
    }
  }

  /** Create one request; an explicit id makes the call idempotent. */
  async function request(projectPath, input, context) {
    const source = input === undefined || input === null ? {} : input
    const by = context !== undefined && context !== null && typeof context.by === 'string' && context.by !== '' ? context.by : '@unknown'
    const optionsNow = base(projectPath)
    const read = await readDecisionStore(io, optionsNow)
    if (read.ok !== true) return read
    const explicitId = textOf(source.id, 64)
    if (explicitId !== '' && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(explicitId)) {
      return failure('invalid-request', 'decision ids are letters, digits, dot, underscore or dash')
    }
    const now = optionsNow.now
    const nowIso = iso(now)
    const id = explicitId !== '' ? explicitId : nextDecisionId(read.store)
    const existing = read.store.requests.filter((record) => record.id === id)[0]
    if (existing !== undefined) {
      const drafted = buildRecord(source, nowIso, id, by)
      if (drafted.ok !== true) return drafted
      if (drafted.record.fingerprint !== existing.fingerprint) {
        return failure('decision-conflict', 'decision ' + id + ' already exists with different content')
      }
      return { ok: true, decision: decisionView(existing, now), created: false, duplicate: true }
    }
    if (read.store.requests.filter((record) => record.status === DECISION_PENDING).length >= MAX_DECISIONS) {
      return failure('decision-capacity', 'there are already ' + String(MAX_DECISIONS) + ' pending decisions; resolve some first')
    }
    const drafted = buildRecord(source, nowIso, id, by)
    if (drafted.ok !== true) return drafted
    let outcome = null
    const written = await updateDecisionStore(io, optionsNow, function (store) {
      const raced = store.requests.filter((record) => record.id === id)[0]
      if (raced !== undefined) {
        outcome = { ok: true, decision: decisionView(raced, now), created: false, duplicate: true }
        return store
      }
      store.requests.push(drafted.record)
      outcome = { ok: true, decision: decisionView(drafted.record, now), created: true, duplicate: false }
      return store
    })
    if (outcome !== null) return outcome
    return written
  }

  /** Resolve one pending request. Exactly one answer ever lands. */
  async function answer(projectPath, input, context) {
    const source = input === undefined || input === null ? {} : input
    const id = textOf(source.id === undefined ? source.decisionId : source.id, 64)
    if (id === '') return failure('invalid-decision-id', 'a decision id is required')
    const by = context !== undefined && context !== null && typeof context.by === 'string' && context.by !== '' ? context.by : '@unknown'
    const optionsNow = base(projectPath)
    const now = optionsNow.now
    const nowIso = iso(now)
    let outcome = null
    const written = await updateDecisionStore(io, optionsNow, function (store) {
      const record = store.requests.filter((candidate) => candidate.id === id)[0]
      if (record === undefined) {
        outcome = failure('unknown-decision', 'no decision with id ' + id)
        return null
      }
      if (record.status === DECISION_ANSWERED) {
        outcome = failure('already-answered', 'decision ' + id + ' was already answered')
        return null
      }
      if (record.status === DECISION_EXPIRED) {
        outcome = failure('decision-expired', 'decision ' + id + ' expired at ' + String(record.timeoutAt))
        return null
      }
      if (record.status === DECISION_CANCELLED) {
        outcome = failure('decision-cancelled', 'decision ' + id + ' was cancelled')
        return null
      }
      // A request whose deadline passed while the answer was in flight expires
      // instead of accepting the late answer: the browser countdown is advisory.
      if (isDue(record, now)) {
        applyTimeout(record, nowIso)
        outcome = failure('decision-expired', 'decision ' + id + ' reached its deadline')
        return store
      }
      const option = textOf(source.option, 64)
      const text = textOf(source.text, MAX_DECISION_TEXT)
      if (option === '') {
        if (text === '') {
          outcome = failure('invalid-answer', 'choose an option or enter some text')
          return null
        }
      } else if (record.options.filter((candidate) => candidate.id === option).length === 0) {
        outcome = failure('invalid-option', 'option "' + option + '" is not offered by decision ' + id)
        return null
      }
      const chosen = option === '' ? null : record.options.filter((candidate) => candidate.id === option)[0]
      if (chosen !== null && chosen.danger === true && source.confirm !== DECISION_CONFIRM_WORD) {
        outcome = failure('confirmation-required', 'type ' + DECISION_CONFIRM_WORD + ' to confirm the destructive option')
        return null
      }
      record.status = DECISION_ANSWERED
      record.answeredBy = by
      record.resolvedAt = nowIso
      record.updatedAt = nowIso
      record.outcome = 'answered'
      record.resolution = {
        option: option === '' ? DECISION_TEXT_OPTION : option,
        text: text === '' ? null : text,
        by: by,
        via: 'user',
        at: nowIso,
      }
      outcome = { ok: true, decision: decisionView(record, now) }
      return store
    })
    if (outcome !== null) return outcome
    return written
  }

  /** Cancel a pending request from the host/lifecycle side (never an answer). */
  async function cancel(projectPath, input, context) {
    const source = input === undefined || input === null ? {} : input
    const id = textOf(source.id, 64)
    if (id === '') return failure('invalid-decision-id', 'a decision id is required')
    const by = context !== undefined && context !== null && typeof context.by === 'string' && context.by !== '' ? context.by : '@unknown'
    const optionsNow = base(projectPath)
    const now = optionsNow.now
    const nowIso = iso(now)
    let outcome = null
    const written = await updateDecisionStore(io, optionsNow, function (store) {
      const record = store.requests.filter((candidate) => candidate.id === id)[0]
      if (record === undefined) {
        outcome = failure('unknown-decision', 'no decision with id ' + id)
        return null
      }
      if (record.status !== DECISION_PENDING) {
        outcome = failure('already-resolved', 'decision ' + id + ' is ' + record.status)
        return null
      }
      record.status = DECISION_CANCELLED
      record.resolvedAt = nowIso
      record.updatedAt = nowIso
      record.outcome = 'cancelled'
      record.resolution = { option: null, text: textOf(source.note, MAX_DECISION_TEXT) || null, by: by, via: 'cancel', at: nowIso }
      outcome = { ok: true, decision: decisionView(record, now) }
      return store
    })
    if (outcome !== null) return outcome
    return written
  }

  /**
   * The timeout sweep. Reads first and writes ONLY when a deadline actually
   * passed, so a polling panel does not rewrite the file every two seconds.
   */
  async function sweep(projectPath, extra) {
    const optionsNow = base(projectPath, extra)
    const now = optionsNow.now
    const read = await readDecisionStore(io, optionsNow)
    if (read.ok !== true) return read
    const due = read.store.requests.filter((record) => isDue(record, now))
    if (due.length === 0) {
      const pending = read.store.requests
        .filter((record) => record.status === DECISION_PENDING)
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
        .map((record) => decisionView(record, now))
      return { ok: true, pending: pending, expired: [], wrote: false }
    }
    const at = iso(now)
    let expired = []
    const written = await updateDecisionStore(io, optionsNow, function (store) {
      expired = []
      for (const record of store.requests) {
        if (!isDue(record, now)) continue
        applyTimeout(record, at)
        expired.push(record)
      }
      return store
    })
    if (written.ok !== true) return written
    const pending = written.store.requests
      .filter((record) => record.status === DECISION_PENDING)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map((record) => decisionView(record, now))
    return { ok: true, pending: pending, expired: expired.map((record) => decisionView(record, now)), wrote: true }
  }

  /** Read-only pending queue (no sweep) for callers that already swept. */
  async function pending(projectPath, extra) {
    const result = await pendingViews(io, base(projectPath, extra))
    if (result.ok !== true) return result
    return { ok: true, pending: result.pending }
  }

  /** Paged list for decisionList: pending first (queue order), then resolved. */
  async function list(projectPath, query) {
    const q = query === undefined || query === null ? {} : query
    const optionsNow = base(projectPath)
    const now = optionsNow.now
    const read = await readDecisionStore(io, optionsNow)
    if (read.ok !== true) return read
    const status = typeof q.status === 'string' && q.status !== '' ? q.status : DECISION_PENDING
    const limit = Number.isFinite(q.limit) ? Math.max(1, Math.min(200, Math.floor(q.limit))) : 50
    const counts = { pending: 0, answered: 0, expired: 0, cancelled: 0, total: read.store.requests.length }
    for (const record of read.store.requests) counts[record.status] = (counts[record.status] || 0) + 1
    const selected = read.store.requests
      .filter((record) => status === 'all' || record.status === status)
      .sort((left, right) => {
        if (left.status === DECISION_PENDING && right.status === DECISION_PENDING) return String(left.createdAt).localeCompare(String(right.createdAt))
        if (left.status === DECISION_PENDING) return -1
        if (right.status === DECISION_PENDING) return 1
        return String(right.resolvedAt || right.updatedAt).localeCompare(String(left.resolvedAt || left.updatedAt))
      })
      .slice(0, limit)
      .map((record) => decisionView(record, now))
    return { ok: true, decisions: selected, counts: counts }
  }

  return {
    pathOf: decisionsPath,
    read: function (projectPath, extra) {
      return readDecisionStore(io, base(projectPath, extra))
    },
    request: request,
    answer: answer,
    cancel: cancel,
    sweep: sweep,
    pending: pending,
    list: list,
  }
}
