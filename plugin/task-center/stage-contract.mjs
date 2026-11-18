/**
 * Stage contract v4: the structured hand-off between implement, review and test.
 *
 * This module is PURE. It never reads a file, never calls git, never spawns an
 * agent: the host hands in the facts it already collected from git, and these
 * functions only shape, fingerprint, validate and render them.
 *
 *   buildCandidateArtifact(task, candidate, hostCheck)  CandidateArtifact
 *   summariseArtifact(artifact)                         board-sized summary
 *   validateReviewRecord(input, options)                ReviewRecord | typed refusal
 *   validateTestRecord(input, options)                  TestRecord | typed refusal
 *   renderReviewBrief(task, artifact, options)          reviewer hand-off section
 *   renderTesterBrief(task, artifact, review, ...)      tester hand-off section
 *
 * Every validator returns { ok: true, record } or { ok: false, code, message };
 * nothing here throws on bad input.
 */
import { createHash } from 'node:crypto'

/** A ReviewRecord larger than this is refused: the card must be split. */
export const REVIEW_RECORD_MAX_BYTES = 16 * 1024
/** A TestRecord larger than this is refused: the card must be split. */
export const TEST_RECORD_MAX_BYTES = 24 * 1024

export const ARTIFACT_CHANGED_FILES_MAX = 200
export const ARTIFACT_KEY_HUNKS_MAX = 24
export const ARTIFACT_ACCEPTANCE_MAX = 20
export const ARTIFACT_PROBES_MAX = 8
export const REVIEW_CHECKED_MAX = 50
export const REVIEW_FINDINGS_MAX = 100
export const REVIEW_RESIDUAL_RISKS_MAX = 50
export const TEST_PROBES_MAX = 40
export const PROBE_TAIL_MAX = 2 * 1024
export const RECORD_TEXT_MAX = 2000

const REVIEW_VERDICTS = ['approved', 'changes-requested']
const TEST_VERDICTS = ['passed', 'failed']
const FINDING_SEVERITIES = ['blocking', 'non-blocking']

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function limitedText(value, max) {
  const text = textOf(value)
  return text.length > max ? text.slice(0, max) : text
}

function refusal(code, message) {
  return { ok: false, code: code, message: message }
}

function byteLengthOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Deduplicated, trimmed, capped path list (git uses forward slashes). */
function pathList(value, max) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(value)) return out
  for (const entry of value) {
    const path = String(entry === undefined || entry === null ? '' : entry).trim().replace(/\\/g, '/')
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    out.push(path)
    if (out.length >= max) break
  }
  return out
}

function normaliseDiffstat(raw) {
  if (isObject(raw) === false) return null
  const files = Number.isFinite(raw.files) ? Math.max(0, Math.floor(raw.files)) : null
  const insertions = Number.isFinite(raw.insertions) ? Math.max(0, Math.floor(raw.insertions)) : null
  const deletions = Number.isFinite(raw.deletions) ? Math.max(0, Math.floor(raw.deletions)) : null
  if (files === null && insertions === null && deletions === null) return null
  return { files: files === null ? 0 : files, insertions: insertions === null ? 0 : insertions, deletions: deletions === null ? 0 : deletions }
}

function normaliseKeyHunks(raw) {
  const out = []
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (isObject(entry) === false) continue
    const file = limitedText(entry.file, 400).replace(/\\/g, '/')
    if (file === '') continue
    out.push({ file: file, hunk: limitedText(entry.hunk, 300), summary: limitedText(entry.summary, 200) })
    if (out.length >= ARTIFACT_KEY_HUNKS_MAX) break
  }
  return out
}

function normaliseVerifyShape(raw) {
  if (isObject(raw) === false) return null
  const command = limitedText(raw.command, 1000)
  if (command === '') return null
  const out = { command: command }
  if (Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) out.timeoutMs = Math.floor(raw.timeoutMs)
  return out
}

function normaliseHostCheckShape(raw) {
  if (isObject(raw) === false) return null
  const command = limitedText(raw.command, 1000)
  if (command === '') return null
  return {
    command: command,
    exitCode: Number.isFinite(raw.exitCode) ? Math.floor(raw.exitCode) : null,
    timedOut: raw.timedOut === true,
    durationMs: Number.isFinite(raw.durationMs) ? Math.max(0, Math.floor(raw.durationMs)) : null,
    tail: typeof raw.tail === 'string' ? raw.tail : '',
    at: typeof raw.at === 'string' ? raw.at : null,
    fingerprint: typeof raw.fingerprint === 'string' && raw.fingerprint !== '' ? raw.fingerprint : null,
  }
}
/**
 * The acceptance criteria as a list. The card stores one text block; the
 * artifact needs items a reviewer can tick one by one.
 */
export function acceptanceItemsOf(task) {
  const source = isObject(task) ? task : {}
  const text = typeof source.acceptance === 'string' ? source.acceptance : ''
  const items = []
  for (const line of text.split(/\r?\n/)) {
    const item = line
      .trim()
      .replace(/^[-*•]\s+/, '')
      .replace(/^\d+[.)]\s*/, '')
      .trim()
    if (item === '') continue
    items.push(item.length > 500 ? item.slice(0, 500) : item)
    if (items.length >= ARTIFACT_ACCEPTANCE_MAX) break
  }
  return items
}

/** The executable probes the TASK declares (task.verification.probes). */
export function probesOf(task) {
  const source = isObject(task) ? task : {}
  const verification = isObject(source.verification) ? source.verification : {}
  const raw = Array.isArray(verification.probes) ? verification.probes : Array.isArray(source.probes) ? source.probes : []
  const probes = []
  const seen = new Set()
  for (const entry of raw) {
    if (isObject(entry) === false) continue
    const command = limitedText(entry.command, 1000)
    if (command === '') continue
    let id = limitedText(entry.id, 80)
    if (id === '') id = 'probe-' + String(probes.length + 1)
    if (seen.has(id)) continue
    seen.add(id)
    const probe = { id: id, command: command }
    if (Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0) probe.timeoutMs = Math.floor(entry.timeoutMs)
    probes.push(probe)
    if (probes.length >= ARTIFACT_PROBES_MAX) break
  }
  return probes
}

/** Parse "git diff --numstat" output into the artifact's diffstat, or null. */
export function parseNumstat(text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const stat = { files: 0, insertions: 0, deletions: 0 }
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const insertions = Number.parseInt(parts[0], 10)
    const deletions = Number.parseInt(parts[1], 10)
    stat.files += 1
    if (Number.isFinite(insertions)) stat.insertions += insertions
    if (Number.isFinite(deletions)) stat.deletions += deletions
  }
  return stat.files === 0 ? null : stat
}

/**
 * The first hunk header of every changed file, plus its first changed line as a
 * factual one-line summary. A summary of the design intent is the reviewer's
 * job; this is only a pointer so a reviewer can find the payload without
 * reading the full diff first.
 */
export function parseKeyHunks(diffText, limit) {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : ARTIFACT_KEY_HUNKS_MAX
  const hunks = []
  if (typeof diffText !== 'string' || diffText === '' || max === 0) return hunks
  let file = null
  let current = null
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = null
      current = null
      continue
    }
    if (line.startsWith('+++ ')) {
      const value = line.slice(4).trim()
      file = value === '/dev/null' ? null : value.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('@@')) {
      if (file === null) continue
      current = { file: file, hunk: line.trim(), summary: '' }
      hunks.push(current)
      if (hunks.length >= max) break
      continue
    }
    if (current !== null && current.summary === '' && (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')) {
      const body = line.slice(1).trim()
      if (body !== '') current.summary = body.slice(0, 200)
    }
  }
  return hunks
}

function artifactHash(facts) {
  const canonical = JSON.stringify({
    base: facts.base,
    head: facts.head,
    changedFiles: facts.changedFiles,
    acceptance: facts.acceptance,
    probes: facts.probes,
    verify: facts.verify,
  })
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * The host-derived candidate. The host passes the git facts (base, head,
 * changed files, optional diffstat/keyHunks); this function only shapes them.
 * The hash covers base..head plus the task's acceptance/probes/verify, so an
 * unchanged candidate keeps the same fingerprint across review rounds.
 */
export function buildCandidateArtifact(task, candidate, hostCheck) {
  const source = isObject(task) ? task : {}
  const facts = isObject(candidate) ? candidate : {}
  const declaredFiles = pathList(source.writeFiles, ARTIFACT_CHANGED_FILES_MAX)
  const changedFiles = pathList(
    facts.changedFiles !== undefined ? facts.changedFiles : facts.actualFiles !== undefined ? facts.actualFiles : source.actualFiles,
    ARTIFACT_CHANGED_FILES_MAX,
  )
  const extras = changedFiles.filter(function (path) {
    return declaredFiles.indexOf(path) < 0
  })
  const acceptance = acceptanceItemsOf(source)
  const probes = probesOf(source)
  const verify = normaliseVerifyShape(source.verify)
  const artifact = {
    taskId: typeof source.id === 'string' ? source.id : null,
    base: textOf(facts.base) || (typeof source.base === 'string' ? source.base : null),
    head: textOf(facts.head) || textOf(facts.commit) || (typeof source.commit === 'string' ? source.commit : null),
    changedFiles: changedFiles,
    declaredFiles: declaredFiles,
    extras: extras,
    diffstat: normaliseDiffstat(facts.diffstat),
    keyHunks: normaliseKeyHunks(facts.keyHunks),
    acceptance: acceptance,
    probes: probes,
    verify: verify,
    hostCheck: normaliseHostCheckShape(hostCheck === undefined || hostCheck === null ? facts.hostCheck : hostCheck),
  }
  artifact.hash = artifactHash(artifact)
  return artifact
}

/** The compact copy the board keeps (merge.artifact): never the artifact body. */
export function summariseArtifact(artifact) {
  const source = isObject(artifact) ? artifact : {}
  const probeIds = Array.isArray(source.probes)
    ? source.probes.map(function (probe) {
        return typeof probe.id === 'string' ? probe.id : null
      }).filter(function (id) {
        return id !== null
      })
    : []
  return {
    hash: typeof source.hash === 'string' ? source.hash : null,
    base: typeof source.base === 'string' ? source.base : null,
    head: typeof source.head === 'string' ? source.head : null,
    changedFiles: Array.isArray(source.changedFiles) ? source.changedFiles.slice(0, ARTIFACT_CHANGED_FILES_MAX) : [],
    diffstat: normaliseDiffstat(source.diffstat),
    probeIds: probeIds,
    hostCheckFingerprint:
      isObject(source.hostCheck) && typeof source.hostCheck.fingerprint === 'string' ? source.hostCheck.fingerprint : null,
  }
}
/** The record source: a nested "record", or the flat input itself. */
function recordSourceOf(input) {
  if (isObject(input) === false) return {}
  if (isObject(input.record)) return input.record
  return input
}

function normalisedChecked(raw) {
  const out = []
  if (!Array.isArray(raw)) return null
  for (const entry of raw) {
    if (isObject(entry) === false) return null
    const criterion = limitedText(entry.criterion, RECORD_TEXT_MAX)
    const method = limitedText(entry.method, RECORD_TEXT_MAX)
    const result = limitedText(entry.result, RECORD_TEXT_MAX)
    if (criterion === '' || method === '' || result === '') return null
    out.push({ criterion: criterion, method: method, result: result })
    if (out.length > REVIEW_CHECKED_MAX) return null
  }
  return out
}

function normalisedFindings(raw) {
  const out = []
  if (raw === undefined || raw === null) return out
  if (!Array.isArray(raw)) return null
  for (const entry of raw) {
    if (isObject(entry) === false) return null
    const severity = FINDING_SEVERITIES.indexOf(entry.severity) >= 0 ? entry.severity : null
    const text = limitedText(entry.text, RECORD_TEXT_MAX)
    if (severity === null || text === '') return null
    out.push({
      severity: severity,
      file: typeof entry.file === 'string' && entry.file.trim() !== '' ? entry.file.trim() : null,
      line: Number.isFinite(entry.line) && entry.line > 0 ? Math.floor(entry.line) : null,
      text: text,
    })
    if (out.length > REVIEW_FINDINGS_MAX) return null
  }
  return out
}

function normalisedRisks(raw) {
  const out = []
  if (raw === undefined || raw === null) return out
  if (!Array.isArray(raw)) return null
  for (const entry of raw) {
    if (typeof entry !== 'string') return null
    const text = entry.trim()
    if (text === '') continue
    out.push(text)
    if (out.length > REVIEW_RESIDUAL_RISKS_MAX) return null
  }
  return out
}

/** Lenient read-side normaliser: garbage becomes null, never a throw. */
export function normaliseReviewRecord(raw) {
  if (isObject(raw) === false) return null
  if (REVIEW_VERDICTS.indexOf(raw.verdict) < 0) return null
  const checked = normalisedChecked(raw.checked)
  const findings = normalisedFindings(raw.findings)
  const residualRisks = normalisedRisks(raw.residualRisks)
  if (checked === null || findings === null || residualRisks === null) return null
  const record = { verdict: raw.verdict, checked: checked, findings: findings, residualRisks: residualRisks }
  return byteLengthOf(record) > REVIEW_RECORD_MAX_BYTES ? null : record
}

/**
 * Validate the reviewer's structured hand-off.
 *
 * @param input  { checked, findings, residualRisks, verdict? } or { record, verdict? }
 * @param options { verdict: 'approved' | 'changes-requested' }
 */
export function validateReviewRecord(input, options) {
  const opts = isObject(options) ? options : {}
  const source = recordSourceOf(input)
  const expected = REVIEW_VERDICTS.indexOf(opts.verdict) >= 0 ? opts.verdict : null
  const declared = REVIEW_VERDICTS.indexOf(source.verdict) >= 0 ? source.verdict : null
  if (expected === null && declared === null) {
    return refusal('invalid-review-verdict', 'a review verdict must be "approved" or "changes-requested"')
  }
  if (expected !== null && declared !== null && expected !== declared) {
    return refusal('review-verdict-mismatch', 'the review record says "' + declared + '" but the action records "' + expected + '"')
  }
  const verdict = expected === null ? declared : expected
  // An approved round must say WHAT it verified. A changes request is driven by
  // its blocking findings; an empty checked list there is honest (nothing was
  // confirmed) and is not a second reason string.
  if ((source.checked === undefined || source.checked === null) && verdict === 'approved') {
    return refusal(
      'missing-checked',
      'a review verdict needs checked: [{ criterion, method, result }] — the checks YOU actually ran, not a copy of the worker evidence',
    )
  }
  const checked = source.checked === undefined || source.checked === null ? [] : normalisedChecked(source.checked)
  if (checked === null) {
    return refusal('invalid-checked', 'every checked entry needs a non-empty criterion, method and result (at most ' + String(REVIEW_CHECKED_MAX) + ' entries)')
  }
  const findings = normalisedFindings(source.findings)
  if (findings === null) {
    return refusal('invalid-findings', 'every finding needs severity "blocking" or "non-blocking" and a non-empty text')
  }
  const residualRisks = normalisedRisks(source.residualRisks)
  if (residualRisks === null) {
    return refusal('invalid-residual-risks', 'residualRisks must be a list of non-empty strings (at most ' + String(REVIEW_RESIDUAL_RISKS_MAX) + ')')
  }
  if (verdict === 'approved' && checked.length === 0) {
    return refusal(
      'empty-checked',
      'approveReview needs at least one entry in checked: record what you actually verified (criterion, method, result) instead of an empty list',
    )
  }
  if (verdict === 'changes-requested') {
    const blocking = findings.filter(function (finding) {
      return finding.severity === 'blocking'
    })
    if (blocking.length === 0) {
      return refusal(
        'missing-blocking-finding',
        'requestChanges needs at least one finding with severity "blocking": the worker acts on those, and the reasons are rendered from them',
      )
    }
  }
  const record = { verdict: verdict, checked: checked, findings: findings, residualRisks: residualRisks }
  if (byteLengthOf(record) > REVIEW_RECORD_MAX_BYTES) {
    return refusal(
      'review-record-too-large',
      'the ReviewRecord is larger than ' + String(REVIEW_RECORD_MAX_BYTES / 1024) + ' KB; summarise the findings or split the card instead of pasting logs',
    )
  }
  return { ok: true, record: record }
}
function normalisedProbes(raw) {
  const out = []
  if (raw === undefined || raw === null) return out
  if (!Array.isArray(raw)) return null
  for (const entry of raw) {
    if (isObject(entry) === false) return null
    const command = limitedText(entry.command, 1000)
    if (command === '') return null
    const probe = {
      id: limitedText(entry.id, 80) || 'probe-' + String(out.length + 1),
      command: command,
      exitCode: Number.isFinite(entry.exitCode) ? Math.floor(entry.exitCode) : null,
      timedOut: entry.timedOut === true,
      tail: typeof entry.tail === 'string' ? entry.tail.slice(0, PROBE_TAIL_MAX) : '',
    }
    if (probe.exitCode === null && probe.timedOut !== true) {
      // A probe is evidence that something RAN: either it exited or it timed out.
      return null
    }
    out.push(probe)
    if (out.length > TEST_PROBES_MAX) return null
  }
  return out
}

/** Lenient read-side normaliser for a stored TestRecord. */
export function normaliseTestRecord(raw) {
  if (isObject(raw) === false) return null
  if (TEST_VERDICTS.indexOf(raw.verdict) < 0) return null
  const probes = normalisedProbes(raw.probes)
  const adversarial = normalisedProbes(raw.adversarial)
  if (probes === null || adversarial === null || probes.length === 0) return null
  const record = {
    verdict: raw.verdict,
    probes: probes,
    adversarial: adversarial,
    hostCheckRef: typeof raw.hostCheckRef === 'string' && raw.hostCheckRef !== '' ? raw.hostCheckRef : null,
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, RECORD_TEXT_MAX * 2) : '',
  }
  return byteLengthOf(record) > TEST_RECORD_MAX_BYTES ? null : record
}

/**
 * Validate the tester's structured hand-off. The tester must have EXECUTED every
 * probe the task declares, so a record that silently skips one is refused.
 *
 * @param input  { probes, adversarial?, notes?, hostCheckRef?, record? }
 * @param options { verdict: 'passed' | 'failed', requiredProbes: [{ id, command }] }
 */
export function validateTestRecord(input, options) {
  const opts = isObject(options) ? options : {}
  const source = recordSourceOf(input)
  const expected = TEST_VERDICTS.indexOf(opts.verdict) >= 0 ? opts.verdict : null
  const declared = TEST_VERDICTS.indexOf(source.verdict) >= 0 ? source.verdict : null
  if (expected === null && declared === null) {
    return refusal('invalid-test-verdict', 'a test verdict must be "passed" or "failed"')
  }
  if (expected !== null && declared !== null && expected !== declared) {
    return refusal('test-verdict-mismatch', 'the test record says "' + declared + '" but the action records "' + expected + '"')
  }
  const verdict = expected === null ? declared : expected
  if (source.probes === undefined || source.probes === null) {
    return refusal(
      'missing-probes',
      'a test verdict needs probes: [{ id, command, exitCode, tail }] — the commands YOU ran in the candidate, not a summary',
    )
  }
  const probes = normalisedProbes(source.probes)
  if (probes === null) {
    return refusal(
      'invalid-probes',
      'every probe needs a non-empty command and an exitCode (or timedOut: true) — a probe records a command that actually ran (at most ' +
        String(TEST_PROBES_MAX) +
        ' entries)',
    )
  }
  if (probes.length === 0) {
    return refusal('empty-probes', 'passTest/failTest need at least one executed probe; an empty evidence list is not a verdict')
  }
  const adversarial = normalisedProbes(source.adversarial)
  if (adversarial === null) {
    return refusal('invalid-adversarial', 'adversarial probes have the same shape as probes: { id, command, exitCode, tail }')
  }
  const required = Array.isArray(opts.requiredProbes) ? opts.requiredProbes : []
  const missing = []
  for (const requiredProbe of required) {
    if (isObject(requiredProbe) === false) continue
    const wantedId = limitedText(requiredProbe.id, 80)
    const wantedCommand = limitedText(requiredProbe.command, 1000)
    const found = probes.some(function (probe) {
      if (wantedId !== '' && probe.id === wantedId) return true
      return wantedCommand !== '' && probe.command === wantedCommand
    })
    if (!found) missing.push(wantedId || wantedCommand)
  }
  if (missing.length > 0) {
    return refusal(
      'missing-probe-execution',
      'the tester must execute every probe declared by the task artifact; missing: ' + missing.join(', '),
    )
  }
  const record = {
    verdict: verdict,
    probes: probes,
    adversarial: adversarial,
    hostCheckRef: typeof source.hostCheckRef === 'string' && source.hostCheckRef !== '' ? source.hostCheckRef : null,
    notes: typeof source.notes === 'string' ? source.notes.slice(0, RECORD_TEXT_MAX * 2) : '',
  }
  if (byteLengthOf(record) > TEST_RECORD_MAX_BYTES) {
    return refusal(
      'test-record-too-large',
      'the TestRecord is larger than ' + String(TEST_RECORD_MAX_BYTES / 1024) + ' KB; keep the tail that explains the result and split the card',
    )
  }
  return { ok: true, record: record }
}
function diffstatLine(diffstat) {
  if (diffstat === null) return '- diffstat: not collected by the host'
  return '- diffstat: ' + String(diffstat.files) + ' file(s), +' + String(diffstat.insertions) + ' -' + String(diffstat.deletions)
}

/**
 * The ONE copy of the host baseline in a brief: command, exit code, duration,
 * candidate fingerprint and the output tail. Both the reviewer and the tester
 * briefs show this line through the artifact section; neither prints it again.
 */
function hostCheckLines(hostCheck) {
  if (hostCheck === null) return ['- host mechanical baseline: none for this candidate yet']
  const state = hostCheck.timedOut === true ? 'timed out' : 'exit ' + String(hostCheck.exitCode === null ? 'none' : hostCheck.exitCode)
  const lines = [
    '- host mechanical baseline: ' +
      String(hostCheck.command) +
      ' -> ' +
      state +
      (Number.isFinite(hostCheck.durationMs) ? ' in ' + String(Math.round(hostCheck.durationMs / 1000)) + 's' : '') +
      (hostCheck.fingerprint === null ? '' : ' (candidate fingerprint ' + String(hostCheck.fingerprint) + ')'),
  ]
  if (typeof hostCheck.tail === 'string' && hostCheck.tail.trim() !== '') {
    lines.push('  output tail:')
    for (const line of hostCheck.tail.split('\n')) lines.push('    ' + line)
  }
  return lines
}

/** The artifact section shared by the reviewer and tester briefs. */
export function renderCandidateArtifact(artifact) {
  const source = isObject(artifact) ? artifact : {}
  const changedFiles = Array.isArray(source.changedFiles) ? source.changedFiles : []
  const declaredFiles = Array.isArray(source.declaredFiles) ? source.declaredFiles : []
  const extras = Array.isArray(source.extras) ? source.extras : []
  const acceptance = Array.isArray(source.acceptance) ? source.acceptance : []
  const probes = Array.isArray(source.probes) ? source.probes : []
  const keyHunks = Array.isArray(source.keyHunks) ? source.keyHunks : []
  const lines = []
  const fingerprint = source.hash === undefined || source.hash === null ? 'no fingerprint' : String(source.hash)
  const base = source.base === null || source.base === undefined ? '(unknown base)' : String(source.base)
  const head = source.head === null || source.head === undefined ? '(unknown head)' : String(source.head)
  lines.push('Candidate artifact (' + fingerprint + '):')
  lines.push('- diff: ' + base + '..' + head)
  lines.push('- changed files (' + String(changedFiles.length) + '): ' + (changedFiles.length === 0 ? '(none recorded)' : changedFiles.join(', ')))
  lines.push('- declared files (' + String(declaredFiles.length) + '): ' + (declaredFiles.length === 0 ? '(none)' : declaredFiles.join(', ')))
  lines.push(
    extras.length === 0
      ? '- every changed file was declared'
      : '- files changed beyond the declaration (' + String(extras.length) + '): ' + extras.join(', '),
  )
  lines.push(diffstatLine(normaliseDiffstat(source.diffstat)))
  if (keyHunks.length > 0) {
    lines.push('- key hunks (pointers, not the whole diff):')
    for (const hunk of keyHunks) {
      lines.push('    ' + String(hunk.file) + ': ' + String(hunk.hunk) + (hunk.summary === '' ? '' : ' — ' + String(hunk.summary)))
    }
  }
  if (acceptance.length > 0) {
    lines.push('- acceptance criteria to judge (' + String(acceptance.length) + '):')
    for (let index = 0; index < acceptance.length; index += 1) lines.push('    ' + String(index + 1) + '. ' + String(acceptance[index]))
  }
  if (probes.length === 0) {
    lines.push('- task probes: none declared; the tester must still record its own executed probes')
  } else {
    lines.push('- executable probes declared by the task (' + String(probes.length) + '):')
    for (const probe of probes) {
      lines.push('    [' + String(probe.id) + '] ' + String(probe.command) + (Number.isFinite(probe.timeoutMs) ? ' (timeout ' + String(probe.timeoutMs) + 'ms)' : ''))
    }
  }
  lines.push(...hostCheckLines(normaliseHostCheckShape(source.hostCheck)))
  return lines
}

/**
 * The scope the reviewer already covered, for the tester. The review VERDICT is
 * deliberately not printed: the tester must reach its own conclusion.
 */
export function renderReviewScope(record) {
  const source = normaliseReviewRecord(record)
  const lines = []
  lines.push('Review scope handed over (this is what the reviewer checked — it is NOT your verdict):')
  if (source === null || source.checked.length === 0) {
    lines.push('- the reviewer recorded no checked entries; build your own scope from the acceptance criteria')
    return lines
  }
  for (const entry of source.checked) {
    lines.push('- ' + String(entry.criterion) + ' (' + String(entry.method) + '): ' + String(entry.result))
  }
  if (source.residualRisks.length > 0) {
    lines.push('- residual risks the reviewer could not close:')
    for (const risk of source.residualRisks) lines.push('    - ' + String(risk))
  }
  const nonBlocking = source.findings.filter(function (finding) {
    return finding.severity === 'non-blocking'
  })
  if (nonBlocking.length > 0) {
    lines.push('- non-blocking findings worth probing:')
    for (const finding of nonBlocking) {
      const where = finding.file === null ? '' : String(finding.file) + (finding.line === null ? '' : ':' + String(finding.line)) + ' — '
      lines.push('    - ' + where + String(finding.text))
    }
  }
  return lines
}

/** Reasons rendered from a changes-requested ReviewRecord (the worker acts on these). */
export function renderReviewReasons(record) {
  const source = normaliseReviewRecord(record)
  if (source === null) return ''
  const lines = []
  for (const finding of source.findings) {
    const where = finding.file === null ? '' : String(finding.file) + (finding.line === null ? '' : ':' + String(finding.line)) + ' — '
    lines.push('- [' + String(finding.severity) + '] ' + where + String(finding.text))
  }
  if (source.residualRisks.length > 0) {
    lines.push('Residual risks:')
    for (const risk of source.residualRisks) lines.push('- ' + String(risk))
  }
  return lines.join('\n')
}

/** A readable summary of an executed TestRecord, for the board's evidence column. */
export function renderTestRecordEvidence(record) {
  const source = normaliseTestRecord(record)
  if (source === null) return ''
  const lines = []
  const describe = function (probe, prefix) {
    const state = probe.timedOut === true ? 'timed out' : 'exit ' + String(probe.exitCode)
    lines.push('- ' + prefix + '[' + String(probe.id) + '] ' + String(probe.command) + ' -> ' + state)
  }
  for (const probe of source.probes) describe(probe, '')
  for (const probe of source.adversarial) describe(probe, 'adversarial ')
  if (source.notes !== '') lines.push('Notes: ' + String(source.notes))
  return lines.join('\n')
}

/**
 * The reviewer's contract section: the artifact plus the EXACT record shape the
 * verdict actions accept. A free-text verdict is refused, so this is not
 * optional advice.
 */
export function renderReviewBrief(task, artifact, options) {
  const opts = isObject(options) ? options : {}
  const source = isObject(task) ? task : {}
  const id = String(source.id === undefined || source.id === null ? 'T-?' : source.id)
  const lines = []
  lines.push('', 'Stage contract (v4) — structured hand-off')
  lines.push(...renderCandidateArtifact(artifact))
  lines.push(
    '',
    'Your verdict must be a structured ReviewRecord; free-text reasons alone are refused:',
    '  task_center { action: "approveReview", id: "' + id + '", checked: [{ criterion, method, result }], findings: [{ severity, file, line, text }], residualRisks: [text] }',
    '  task_center { action: "requestChanges", id: "' + id + '", findings: [{ severity: "blocking", file, line, text }], checked: [...], residualRisks: [...] }',
    'Rules:',
    '- approveReview refuses an empty checked list: record the checks YOU ran, not the worker evidence.',
    '- requestChanges refuses a record without at least one blocking finding; the rework brief is rendered from those findings.',
    '- The record is bounded (16 KB); summarise, do not paste logs. The host runs the baseline suite; you audit the diff against spec/acceptance.',
  )
  if (opts.requiresProbes === true) {
    lines.push('- Judge whether the declared probes actually cover the acceptance criteria; the tester executes them next.')
  }
  return lines
}

/**
 * The tester's contract section: artifact + review scope + host baseline + the
 * exact TestRecord the verdict actions accept. The review verdict is never
 * included: a scope hand-off is not a conclusion.
 */
export function renderTesterBrief(task, artifact, reviewRecord, hostCheck, options) {
  const opts = isObject(options) ? options : {}
  const source = isObject(task) ? task : {}
  const id = String(source.id === undefined || source.id === null ? 'T-?' : source.id)
  const check =
    hostCheck !== undefined && hostCheck !== null
      ? normaliseHostCheckShape(hostCheck)
      : isObject(artifact)
        ? normaliseHostCheckShape(artifact.hostCheck)
        : null
  const lines = []
  lines.push('', 'Stage contract (v4) — structured hand-off')
  lines.push(...renderCandidateArtifact(artifact))
  lines.push(...renderReviewScope(reviewRecord))
  if (check !== null) {
    const reused = opts.hostCheckReused === true
    lines.push(
      '',
      reused
        ? 'The host baseline line above already PASSED for this exact candidate fingerprint, so it is reused: do NOT re-run the full suite just to confirm it.'
        : 'The host baseline line above is the floor, not your verdict.',
      'It is stated once, above; re-run it yourself only when you suspect flakiness or an environment difference, and say why in notes.',
    )
  } else {
    lines.push('', 'No host baseline check exists for this candidate; run what the acceptance needs and record it.')
  }
  lines.push(
    '',
    'Execute the task probes above YOURSELF in the candidate checkout. The record must contain every probe id;',
    'a verdict that silently skips one is refused.',
    '',
    'Your verdict must be a structured TestRecord; an empty probe list is refused:',
    '  task_center { action: "passTest", id: "' + id + '", probes: [{ id, command, exitCode, tail }], adversarial: [{ id, command, exitCode, tail }], hostCheckRef, notes }',
    '  task_center { action: "failTest", id: "' + id + '", probes: [ ...the same shape... ] }',
    'Rules:',
    '- probes/adversarial record what YOU ran: command, exit code (or timedOut), and the output tail that explains the result.',
    '- Add at least one adversarial probe per acceptance criterion the suite does not encode.',
    '- The record is bounded (24 KB); keep the tail that explains the result.',
    '- The review scope above is a hand-off, not a conclusion: your verdict must come from your own execution.',
  )
  return lines
}



