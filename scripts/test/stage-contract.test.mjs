// Stage contract v4 unit tests: CandidateArtifact shaping/fingerprint, the
// ReviewRecord/TestRecord validators and the rendered hand-off. Pure module, so
// every check here is a plain function call with no board or git.

import assert from 'node:assert/strict'
import {
  ARTIFACT_KEY_HUNKS_MAX,
  REVIEW_RECORD_MAX_BYTES,
  TEST_RECORD_MAX_BYTES,
  buildCandidateArtifact,
  normaliseReviewRecord,
  normaliseTestRecord,
  parseKeyHunks,
  parseNumstat,
  renderCandidateArtifact,
  renderReviewBrief,
  renderReviewReasons,
  renderReviewScope,
  renderTestRecordEvidence,
  renderTesterBrief,
  summariseArtifact,
  validateReviewRecord,
  validateTestRecord,
} from '../../plugin/task-center/stage-contract.mjs'

const checks = []
function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error })
  }
}

const TASK = {
  id: 'T-7',
  title: 'contract card',
  acceptance: '- the suite passes\n- the hand-off is structured\n* no free text',
  writeFiles: ['plugin/a.mjs'],
  verification: { probes: [{ id: 'suite', command: 'node --test scripts/a.test.mjs', timeoutMs: 120000 }] },
  verify: { command: 'npm test' },
  base: 'base-sha',
  commit: 'head-sha',
  actualFiles: ['plugin/a.mjs', 'plugin/b.mjs'],
}
const HOST_CHECK = { command: 'npm test', exitCode: 0, timedOut: false, durationMs: 45531, tail: 'PASS 67/67', at: '2026-01-01T00:00:00.000Z', fingerprint: 'sha256:abc' }

// ── CandidateArtifact ──────────────────────────────────────────────────────
check('the artifact carries the git range, files, extras and contract inputs', () => {
  const artifact = buildCandidateArtifact(TASK, { base: 'base-sha', head: 'head-sha', changedFiles: ['plugin/a.mjs', 'plugin/b.mjs'] }, null)
  assert.equal(artifact.base, 'base-sha')
  assert.equal(artifact.head, 'head-sha')
  assert.deepEqual(artifact.changedFiles, ['plugin/a.mjs', 'plugin/b.mjs'])
  assert.deepEqual(artifact.declaredFiles, ['plugin/a.mjs'])
  assert.deepEqual(artifact.extras, ['plugin/b.mjs'])
  assert.equal(artifact.acceptance.length, 3)
  assert.equal(artifact.acceptance[2], 'no free text')
  assert.equal(artifact.probes.length, 1)
  assert.equal(artifact.probes[0].id, 'suite')
  assert.equal(artifact.verify.command, 'npm test')
  assert.equal(artifact.hostCheck, null)
})

check('the artifact hash is stable for the same candidate and contract', () => {
  const first = buildCandidateArtifact(TASK, { base: 'base-sha', head: 'head-sha' }, null)
  const second = buildCandidateArtifact(TASK, { base: 'base-sha', head: 'head-sha' }, HOST_CHECK)
  assert.equal(first.hash, second.hash, 'the host check must not change the fingerprint')
  assert.match(first.hash, /^sha256:[0-9a-f]{64}$/)
})

check('a different head, probe or verify declaration changes the hash', () => {
  const base = buildCandidateArtifact(TASK, { base: 'b', head: 'h1' }, null)
  const otherHead = buildCandidateArtifact(TASK, { base: 'b', head: 'h2' }, null)
  const otherProbe = buildCandidateArtifact(Object.assign({}, TASK, { verification: { probes: [{ id: 'suite', command: 'node --test scripts/other.test.mjs' }] } }), { base: 'b', head: 'h1' }, null)
  const otherVerify = buildCandidateArtifact(Object.assign({}, TASK, { verify: { command: 'npm run verify' } }), { base: 'b', head: 'h1' }, null)
  assert.notEqual(base.hash, otherHead.hash)
  assert.notEqual(base.hash, otherProbe.hash)
  assert.notEqual(base.hash, otherVerify.hash)
})

check('the artifact never invents probes from the verify declaration', () => {
  const artifact = buildCandidateArtifact(Object.assign({}, TASK, { verification: { probes: [] } }), { base: 'b', head: 'h' }, null)
  assert.deepEqual(artifact.probes, [])
})

check('parseNumstat sums files and changed lines', () => {
  assert.deepEqual(parseNumstat('12\t3\ta.mjs\n0\t1\tb.mjs\n'), { files: 2, insertions: 12, deletions: 4 })
  assert.deepEqual(parseNumstat('-\t-\tbinary.png'), { files: 1, insertions: 0, deletions: 0 })
  assert.equal(parseNumstat(''), null)
})

check('parseKeyHunks keeps the first hunk per file, capped', () => {
  const diff = [
    'diff --git a/a.mjs b/a.mjs',
    '--- a/a.mjs',
    '+++ b/a.mjs',
    '@@ -1,2 +1,3 @@',
    '-old line',
    '+new line',
    'diff --git a/b.mjs b/b.mjs',
    '+++ b/b.mjs',
    '@@ -10 +10,2 @@',
    '+added',
  ].join('\n')
  const hunks = parseKeyHunks(diff)
  assert.equal(hunks.length, 2)
  assert.equal(hunks[0].file, 'a.mjs')
  assert.equal(hunks[0].summary, 'old line')
  assert.equal(hunks[1].hunk, '@@ -10 +10,2 @@')
  assert.equal(parseKeyHunks(diff, 1).length, 1)
  assert.ok(ARTIFACT_KEY_HUNKS_MAX >= 2)
})

check('summariseArtifact keeps only board-sized fields', () => {
  const artifact = buildCandidateArtifact(TASK, { base: 'b', head: 'h', diffstat: { files: 2, insertions: 5, deletions: 1 } }, HOST_CHECK)
  const summary = summariseArtifact(artifact)
  assert.equal(summary.hash, artifact.hash)
  assert.deepEqual(summary.changedFiles, ['plugin/a.mjs', 'plugin/b.mjs'])
  assert.deepEqual(summary.probeIds, ['suite'])
  assert.equal(summary.hostCheckFingerprint, 'sha256:abc')
  assert.equal(summary.keyHunks, undefined)
  assert.equal(summary.acceptance, undefined)
})

// ── ReviewRecord ───────────────────────────────────────────────────────────
const APPROVED = {
  verdict: 'approved',
  checked: [{ criterion: 'no removed API is called', method: 'rg + unit test', result: 'pass' }],
  findings: [],
  residualRisks: [],
}

check('a complete approved record is accepted and normalised', () => {
  const result = validateReviewRecord(APPROVED)
  assert.equal(result.ok, true)
  assert.deepEqual(result.record, APPROVED)
})

check('approveReview refuses a missing checked list', () => {
  assert.equal(validateReviewRecord({ verdict: 'approved' }).code, 'missing-checked')
})

check('approveReview refuses an empty checked list', () => {
  assert.equal(validateReviewRecord({ verdict: 'approved', checked: [] }).code, 'empty-checked')
})

check('checked entries need criterion, method and result', () => {
  assert.equal(validateReviewRecord({ verdict: 'approved', checked: [{ criterion: 'x', method: '', result: 'pass' }] }).code, 'invalid-checked')
})

check('requestChanges refuses a record without a blocking finding', () => {
  const result = validateReviewRecord({
    verdict: 'changes-requested',
    checked: [{ criterion: 'reviewed the diff', method: 'read', result: 'fail' }],
    findings: [{ severity: 'non-blocking', text: 'a nit' }],
  })
  assert.equal(result.code, 'missing-blocking-finding')
})

check('requestChanges accepts checked-free records with a blocking finding', () => {
  const result = validateReviewRecord({
    verdict: 'changes-requested',
    findings: [{ severity: 'blocking', file: 'a.mjs', line: 12, text: 'rename the helper' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.record.findings[0].severity, 'blocking')
  assert.equal(result.record.checked.length, 0)
})

check('the action verdict wins and a mismatched record verdict is refused', () => {
  assert.equal(validateReviewRecord(APPROVED, { verdict: 'approved' }).ok, true)
  assert.equal(validateReviewRecord(APPROVED, { verdict: 'changes-requested' }).code, 'review-verdict-mismatch')
})

check('invalid findings and residual risks are typed refusals', () => {
  assert.equal(validateReviewRecord(Object.assign({}, APPROVED, { findings: [{ severity: 'blocking' }] })).code, 'invalid-findings')
  assert.equal(validateReviewRecord(Object.assign({}, APPROVED, { residualRisks: [42] })).code, 'invalid-residual-risks')
})

check('an oversized ReviewRecord is refused', () => {
  const checked = []
  for (let index = 0; index < 50; index += 1) {
    checked.push({ criterion: 'c'.repeat(2000), method: 'm'.repeat(2000), result: 'r'.repeat(2000) })
  }
  const result = validateReviewRecord({ verdict: 'approved', checked: checked })
  assert.equal(result.code, 'review-record-too-large')
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < REVIEW_RECORD_MAX_BYTES)
})

check('a malformed stored record reads back as null, never a throw', () => {
  assert.equal(normaliseReviewRecord({ verdict: 'approved', checked: 'nope' }), null)
  assert.equal(normaliseReviewRecord({ verdict: 'whatever', checked: [] }), null)
  assert.equal(normaliseReviewRecord(null), null)
  assert.deepEqual(normaliseReviewRecord(APPROVED), APPROVED)
})

// ── TestRecord ─────────────────────────────────────────────────────────────
const PASSED = {
  verdict: 'passed',
  probes: [{ id: 'suite', command: 'node --test scripts/a.test.mjs', exitCode: 0, tail: 'PASS 12/12' }],
  adversarial: [{ id: 'no-legacy-team', command: 'rg agentTeams', exitCode: 1, tail: '' }],
  hostCheckRef: 'sha256:abc',
  notes: 'host baseline reused',
}

check('a complete passed record is accepted', () => {
  const result = validateTestRecord(PASSED)
  assert.equal(result.ok, true)
  assert.equal(result.record.probes[0].exitCode, 0)
  assert.equal(result.record.adversarial[0].id, 'no-legacy-team')
  assert.equal(result.record.hostCheckRef, 'sha256:abc')
})

check('passTest/failTest refuse a missing or empty probe list', () => {
  assert.equal(validateTestRecord({ verdict: 'passed' }).code, 'missing-probes')
  assert.equal(validateTestRecord({ verdict: 'passed', probes: [] }).code, 'empty-probes')
  assert.equal(validateTestRecord({ verdict: 'failed', probes: [] }).code, 'empty-probes')
})

check('a probe that never ran cannot be evidence', () => {
  assert.equal(validateTestRecord({ verdict: 'passed', probes: [{ command: 'x' }] }).code, 'invalid-probes')
  assert.equal(validateTestRecord({ verdict: 'passed', probes: [{ command: '' , exitCode: 0 }] }).code, 'invalid-probes')
  assert.equal(validateTestRecord({ verdict: 'passed', probes: [{ command: 'x', timedOut: true }] }).ok, true)
})

check('the tester must execute every probe the artifact declares', () => {
  const result = validateTestRecord(PASSED, { requiredProbes: [{ id: 'suite', command: 'node --test scripts/a.test.mjs' }, { id: 'other', command: 'node --test scripts/b.test.mjs' }] })
  assert.equal(result.code, 'missing-probe-execution')
  assert.match(result.message, /other/)
  assert.equal(validateTestRecord(PASSED, { requiredProbes: [{ id: 'suite', command: 'node --test scripts/a.test.mjs' }] }).ok, true)
})

check('an oversized TestRecord is refused', () => {
  const probes = []
  for (let index = 0; index < 40; index += 1) {
    probes.push({ id: 'probe-' + String(index), command: 'c'.repeat(1000), exitCode: 0, tail: 't'.repeat(2000) })
  }
  const result = validateTestRecord({ verdict: 'passed', probes: probes })
  assert.equal(result.code, 'test-record-too-large')
  assert.ok(TEST_RECORD_MAX_BYTES < Buffer.byteLength(JSON.stringify({ probes: probes }), 'utf8'))
})

check('a malformed stored test record reads back as null', () => {
  assert.equal(normaliseTestRecord({ verdict: 'passed', probes: [] }), null)
  assert.equal(normaliseTestRecord({ verdict: 'passed', probes: [{ command: 'x' }] }), null)
  assert.equal(normaliseTestRecord(null), null)
  assert.equal(normaliseTestRecord(PASSED).probes[0].id, 'suite')
})

// ── rendered hand-off ──────────────────────────────────────────────────────
const reviewRecord = validateReviewRecord({
  verdict: 'approved',
  checked: [
    { criterion: 'the suite covers the new contract', method: 'read the test diff', result: 'pass' },
    { criterion: 'declared files match the diff', method: 'board vs git', result: 'pass' },
  ],
  findings: [{ severity: 'non-blocking', file: 'plugin/a.mjs', line: 4, text: 'the helper name is vague' }],
  residualRisks: ['bootstrapTeam assertion may be vacuous'],
}).record

check('the artifact rendering carries the range, files, probes and host baseline', () => {
  const artifact = buildCandidateArtifact(TASK, { base: 'b', head: 'h', diffstat: { files: 2, insertions: 5, deletions: 1 } }, HOST_CHECK)
  const text = renderCandidateArtifact(artifact).join('\n')
  assert.match(text, /Candidate artifact \(sha256:/)
  assert.match(text, /diff: b\.\.h/)
  assert.match(text, /plugin\/b\.mjs/)
  assert.match(text, /\[suite\] node --test/)
  assert.match(text, /host mechanical baseline: npm test -> exit 0/)
  assert.match(text, /acceptance criteria to judge \(3\)/)
})

check('the review scope shows checked + residual risks and never the verdict', () => {
  const text = renderReviewScope(reviewRecord).join('\n')
  assert.match(text, /the suite covers the new contract/)
  assert.match(text, /bootstrapTeam assertion may be vacuous/)
  assert.match(text, /NOT your verdict/)
  assert.equal(text.indexOf('approved'), -1, 'the review verdict leaked into the tester scope')
})

check('the review brief states the exact structured verdict shape', () => {
  const text = renderReviewBrief(TASK, buildCandidateArtifact(TASK, { base: 'b', head: 'h' }, null)).join('\n')
  assert.match(text, /approveReview/)
  assert.match(text, /checked/)
  assert.match(text, /requestChanges/)
  assert.match(text, /blocking finding/)
})

check('the tester brief carries artifact + scope + host baseline and no verdict', () => {
  const artifact = buildCandidateArtifact(TASK, { base: 'b', head: 'h' }, HOST_CHECK)
  const text = renderTesterBrief(TASK, artifact, reviewRecord, HOST_CHECK, { hostCheckReused: true }).join('\n')
  assert.match(text, /Candidate artifact/)
  assert.match(text, /Review scope handed over/)
  assert.match(text, /the suite covers the new contract/)
  assert.match(text, /residual risks the reviewer could not close/)
  assert.match(text, /host baseline check already PASSED/)
  assert.match(text, /every probe id/)
  assert.match(text, /TestRecord/)
  assert.equal(text.indexOf('changes-requested'), -1)
  assert.equal(text.indexOf('"verdict"'), -1)
})

check('review reasons are rendered from the blocking findings', () => {
  const changes = validateReviewRecord({
    verdict: 'changes-requested',
    checked: [],
    findings: [
      { severity: 'blocking', file: 'a.mjs', line: 9, text: 'drop the silent catch' },
      { severity: 'non-blocking', text: 'rename the helper' },
    ],
  }).record
  const text = renderReviewReasons(changes)
  assert.match(text, /\[blocking\] a\.mjs:9 — drop the silent catch/)
  assert.match(text, /\[non-blocking\] rename the helper/)
})

check('test evidence is rendered from the probes, not the notes alone', () => {
  const text = renderTestRecordEvidence(PASSED)
  assert.match(text, /\[suite\] node --test scripts\/a\.test\.mjs -> exit 0/)
  assert.match(text, /adversarial \[no-legacy-team\]/)
})

const failed = checks.filter((row) => !row.ok)
for (const row of checks) {
  console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
}
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
