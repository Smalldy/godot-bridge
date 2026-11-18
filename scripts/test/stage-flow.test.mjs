// Stage flow v4: submit -> review (structured record) -> approve -> tester brief
// (artifact + review scope, never the verdict) -> test (structured TestRecord),
// plus hostCheck reuse on an unchanged candidate fingerprint.

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createFakeTaskAgents, createRig, createTask, PROJECT } from './support/fixtures.mjs'

const require = createRequire(import.meta.url)
const { createTaskCard } = require('../../client/src/views/task-card.cjs')

const checks = []
function check(name, fn) {
  try {
    fn()
    checks.push({ name, ok: true })
  } catch (error) {
    checks.push({ name, ok: false, error })
  }
}

const taskAgents = createFakeTaskAgents()
let candidateHead = 'candidate-sha-1'
const merger = {
  async createCandidate(task, projectPath) {
    return { ok: true, path: projectPath + '\\.worktrees\\test-' + String(task.id), base: 'base-sha', head: candidateHead, target: 'main', actualFiles: [] }
  },
  async mergeCandidate(task) {
    return { ok: true, status: 'merged', mergeCommit: 'merged-' + String(task.id), candidateRemoved: false, taskWorktreeRemoved: false }
  },
  async discardCandidate() {
    return { ok: true }
  },
}
const rig = createRig({ taskAgents, merger })
// The host check runs through the unconfined subprocess service; the rig has
// none, so provide one and count the suites it actually executed.
const subprocess = {
  calls: [],
  spawn(input) {
    subprocess.calls.push(input)
    return {
      collected: {
        stdout: { readFrom: () => ({ text: 'PASS 67/67\n' }) },
        stderr: { readFrom: () => ({ text: '' }) },
      },
      done: Promise.resolve({ exitCode: 0 }),
    }
  },
}
const baseGet = rig.ctx.get
rig.ctx.get = (key) => (key === 'subprocess' ? subprocess : baseGet.call(rig.ctx, key))

/** A stage child's context: the contract's hard rules bind these roles, not the user. */
function performAs(agentId, name, action, payload) {
  return rig.api.perform(action, payload, { projectPath: rig.project, by: '@' + name, role: 'agent', agent: { id: agentId, name: name } })
}

async function boardTask(id) {
  const snap = await rig.action('board')
  assert.equal(snap.ok, true, JSON.stringify(snap).slice(0, 400))
  return snap.tasks.filter((entry) => entry.id === id)[0]
}

async function startCard(title, verification) {
  const input = {
    title: title,
    writeFiles: [],
    acceptance: '- the contract suite passes\n- every declared probe ran',
    verify: { command: 'npm test', timeoutMs: 5000 },
  }
  // T-192: a NEW dev card must declare an executable probe. A caller that does
  // not care which probe the card carries gets the rig's default one instead of
  // an empty (now refused) list.
  if (Array.isArray(verification) && verification.length > 0) input.verification = { probes: verification }
  const created = await createTask(rig, input)
  const started = await rig.action('start')
  assert.equal(started.ok, true, JSON.stringify(started).slice(0, 400))
  await rig.settle()
  const running = await boardTask(created.id)
  assert.equal(running.status, 'running')
  const submitted = await rig.action('submit', { id: created.id, evidence: 'implemented' })
  assert.equal(submitted.ok, true, JSON.stringify(submitted).slice(0, 500))
  return { id: created.id, card: submitted.task }
}

const REVIEWED = {
  checked: [
    { criterion: 'the contract suite covers the new field', method: 'read the test diff', result: 'pass' },
    { criterion: 'declared vs actual files match', method: 'board vs git', result: 'pass' },
  ],
  findings: [{ severity: 'non-blocking', file: 'plugin/a.mjs', line: 4, text: 'the helper name is vague' }],
  residualRisks: ['the bootstrap assertion may be vacuous'],
}

const PROBE_SUITE = [{ id: 'probe-a', command: 'node --test scripts/a.test.mjs', timeoutMs: 120000 }]
const PASS_RECORD = {
  probes: [{ id: 'probe-a', command: 'node --test scripts/a.test.mjs', exitCode: 0, tail: 'PASS 12/12' }],
  adversarial: [{ id: 'grep-legacy', command: 'rg agentTeams', exitCode: 1, tail: '' }],
  notes: 'host baseline reused; adversarial grep is empty',
}

// ── submit -> reviewer brief carries the CandidateArtifact ─────────────────
const main = await startCard('contract flow', PROBE_SUITE)
check('submit starts a reviewer with the stage contract section', () => {
  const call = taskAgents.calls.filter((entry) => entry.kind === 'startReviewer' && entry.taskId === main.id).pop()
  assert.ok(call, 'no reviewer was started')
  assert.match(call.text, /Stage contract \(v4\) — structured hand-off/)
  assert.match(call.text, /Candidate artifact \(sha256:/)
  assert.match(call.text, /\[probe-a\] node --test scripts\/a\.test\.mjs/)
  assert.match(call.text, /approveReview refuses an empty checked list/)
  assert.match(call.text, /requestChanges refuses a record without at least one blocking finding/)
})

// ── the reviewer cannot fall back to free text ─────────────────────────────
const reviewerId = (await boardTask(main.id)).review.deliveredTo.id
const refusedEmpty = await performAs(reviewerId, 'reviewer-x', 'approveReview', { id: main.id })
check('approveReview without checked is refused and keeps the round open', () => {
  assert.equal(refusedEmpty.ok, false)
  assert.equal(refusedEmpty.code, 'missing-checked')
})

const refusedNoBlocking = await performAs(reviewerId, 'reviewer-x', 'requestChanges', { id: main.id, reasons: 'rename it', checked: [] })
check('requestChanges without a blocking finding is refused', () => {
  assert.equal(refusedNoBlocking.ok, false)
  assert.equal(refusedNoBlocking.code, 'missing-blocking-finding')
})

// ── approve -> ReviewRecord + CandidateArtifact + host check ───────────────
const approved = await performAs(reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: main.id }, REVIEWED))
check('approveReview persists the structured ReviewRecord', () => {
  assert.equal(approved.ok, true, JSON.stringify(approved).slice(0, 900))
  const record = approved.task.review.record
  assert.equal(record.verdict, 'approved')
  assert.equal(record.checked.length, 2)
  assert.equal(record.residualRisks.length, 1)
  assert.equal(approved.task.status, 'testing')
})

const afterApprove = await boardTask(main.id)
check('the board keeps the artifact summary and the host check fingerprint', () => {
  assert.ok(afterApprove.merge.artifact !== null && afterApprove.merge.artifact !== undefined)
  assert.match(afterApprove.merge.artifact.hash, /^sha256:/)
  assert.equal(afterApprove.test.hostCheck.fingerprint, afterApprove.merge.artifact.hash)
  assert.equal(subprocess.calls.length, 1, 'the first approval runs the host check exactly once')
})

// ── tester brief: artifact + review scope + host check, NO verdict ─────────
check('the tester brief hands over scope and baseline but not the review verdict', () => {
  const call = taskAgents.calls.filter((entry) => entry.kind === 'startTester' && entry.taskId === main.id).pop()
  assert.ok(call, 'no tester was started')
  assert.match(call.text, /Candidate artifact \(sha256:/)
  assert.match(call.text, /Review scope handed over/)
  assert.match(call.text, /the contract suite covers the new field/)
  assert.match(call.text, /the bootstrap assertion may be vacuous/)
  assert.match(call.text, /host mechanical baseline: npm test -> exit 0/)
  assert.match(call.text, /\[probe-a\] node --test scripts\/a\.test\.mjs/)
  assert.match(call.text, /NOT your verdict/)
  assert.match(call.text, /passTest/)
  assert.equal(call.text.indexOf('changes-requested'), -1, 'the review verdict leaked into the tester brief')
  assert.equal(call.text.indexOf('review verdict:'), -1, 'the review verdict leaked into the tester brief')
})

// ── the tester cannot submit an empty or partial probe list ────────────────
const testerId = (await boardTask(main.id)).test.deliveredTo.id
const refusedNoProbes = await performAs(testerId, 'tester-x', 'passTest', { id: main.id })
check('passTest without a probe list is refused', () => {
  assert.equal(refusedNoProbes.ok, false)
  assert.equal(refusedNoProbes.code, 'missing-probes')
})

const refusedEmptyProbes = await performAs(testerId, 'tester-x', 'failTest', { id: main.id, probes: [] })
check('failTest with an empty probe list is refused', () => {
  assert.equal(refusedEmptyProbes.ok, false)
  assert.equal(refusedEmptyProbes.code, 'empty-probes')
})

const refusedPartial = await performAs(testerId, 'tester-x', 'passTest', { id: main.id, probes: [{ id: 'other-probe', command: 'node --test scripts/b.test.mjs', exitCode: 0 }] })
check('a verdict that skips a declared probe is refused', () => {
  assert.equal(refusedPartial.ok, false)
  assert.equal(refusedPartial.code, 'missing-probe-execution')
  assert.match(refusedPartial.message, /probe-a/)
})

// ── a failed test returns to running; an unchanged candidate reuses hostCheck ─
const failedFirst = await performAs(testerId, 'tester-x', 'failTest', Object.assign({ id: main.id }, { probes: PASS_RECORD.probes }))
check('failTest persists the TestRecord and returns the card to running', () => {
  assert.equal(failedFirst.ok, true, JSON.stringify(failedFirst).slice(0, 900))
  assert.equal(failedFirst.task.status, 'running')
  assert.equal(failedFirst.task.test.record.verdict, 'failed')
  assert.equal(failedFirst.task.test.record.probes.length, 1)
})

const resubmitted = await rig.action('submit', { id: main.id, evidence: 'fixed in the same worktree' })
check('re-submit reopens the review round', () => {
  assert.equal(resubmitted.ok, true, JSON.stringify(resubmitted).slice(0, 500))
  assert.equal(resubmitted.task.status, 'reviewing')
})

const reviewerTwo = (await boardTask(main.id)).review.deliveredTo.id
const approvedAgain = await performAs(reviewerTwo, 'reviewer-y', 'approveReview', Object.assign({ id: main.id, checked: REVIEWED.checked }))
const afterReuse = await boardTask(main.id)
check('an unchanged candidate fingerprint reuses the host baseline', () => {
  assert.equal(approvedAgain.ok, true, JSON.stringify(approvedAgain).slice(0, 900))
  assert.equal(subprocess.calls.length, 1, 'the host ran the suite again for the same candidate fingerprint')
  assert.equal(afterReuse.test.hostCheck.fingerprint, afterReuse.merge.artifact.hash)
})

// ── a moved candidate head must run the host check again ───────────────────
candidateHead = 'candidate-sha-2'
const testerTwo = (await boardTask(main.id)).test.deliveredTo.id
const failedAgain = await performAs(testerTwo, 'tester-y', 'failTest', Object.assign({ id: main.id }, { probes: PASS_RECORD.probes }))
assert.equal(failedAgain.ok, true, JSON.stringify(failedAgain).slice(0, 1400))
await rig.action('submit', { id: main.id, evidence: 'second repair' })
const reviewerThree = (await boardTask(main.id)).review.deliveredTo.id
const approvedMoved = await performAs(reviewerThree, 'reviewer-z', 'approveReview', Object.assign({ id: main.id, checked: REVIEWED.checked }))
const afterMoved = await boardTask(main.id)
check('a changed candidate head runs the host baseline again', () => {
  assert.equal(approvedMoved.ok, true, JSON.stringify(approvedMoved).slice(0, 900))
  assert.equal(subprocess.calls.length, 2, 'the moved candidate reused a stale host check')
  assert.equal(afterMoved.test.hostCheck.fingerprint, afterMoved.merge.artifact.hash)
})

// ── pass -> TestRecord persisted, review scope not required in the record ──
const testerThree = (await boardTask(main.id)).test.deliveredTo.id
const passed = await performAs(testerThree, 'tester-z', 'passTest', Object.assign({ id: main.id }, PASS_RECORD))
check('passTest persists the structured TestRecord', () => {
  assert.equal(passed.ok, true, JSON.stringify(passed).slice(0, 900))
  const record = passed.task.test.record
  assert.equal(record.verdict, 'passed')
  assert.equal(record.probes[0].id, 'probe-a')
  assert.equal(record.hostCheckRef, null)
})

// ── requestChanges: findings become the rework brief ───────────────────────
const changesCard = await startCard('changes flow', [])
const changes = await rig.action('requestChanges', {
  id: changesCard.id,
  checked: [{ criterion: 'the diff was read', method: 'read', result: 'fail' }],
  findings: [{ severity: 'blocking', file: 'plugin/a.mjs', line: 9, text: 'drop the silent catch' }],
  residualRisks: ['the error path is untested'],
})
const afterChanges = await boardTask(changesCard.id)
check('requestChanges persists the record and renders the reasons from findings', () => {
  assert.equal(changes.ok, true, JSON.stringify(changes).slice(0, 900))
  assert.equal(afterChanges.status, 'running')
  assert.equal(afterChanges.review.record.findings[0].severity, 'blocking')
  assert.match(afterChanges.review.reasons, /a\.mjs:9/)
  assert.match(afterChanges.review.reasons, /drop the silent catch/)
})

check('the worker rework brief carries the blocking finding', () => {
  const call = taskAgents.calls.filter((entry) => entry.kind === 'send' && String(entry.text).indexOf(changesCard.id) >= 0).pop()
  assert.ok(call, 'the worker was never sent the rework brief')
  assert.match(call.text, /drop the silent catch/)
})

// ── the PANEL payload: the exact object the card sends must be accepted ────
// The task card is the T-113 human override. These checks render the real view
// module, click the real buttons and feed the EXACT payload it emits into the
// API as the user, so a client/action contract drift fails here.
const reactBridge = { useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}] }
const h = (type, props, ...children) => ({ type, props: Object.assign({}, props, children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) })
const selectors = {
  tcBaseName: (value) => String(value).split('/').pop(),
  tcIsInvestigation: (task) => task.kind === 'investigate',
  tcKindOf: (task) => (task.kind === 'investigate' ? 'investigate' : 'dev'),
  tcLease: () => null,
  tcMergeLabel: () => 'merge',
  tcMergeOf: () => null,
  tcMergeTone: () => 'running',
  tcPhaseLabel: () => 'Running',
  tcPhaseTone: () => 'running',
  tcReviewLabel: () => 'review',
  tcReviewOf: () => null,
  tcReviewTone: () => 'waiting',
  tcRound: () => 1,
  tcStageQueued: () => false,
  tcTestLabel: () => 'test',
  tcTestOf: () => null,
  tcTestTone: () => 'waiting',
}
const TaskCard = createTaskCard(Object.assign({ React: { useState: (initial) => reactBridge.useState(initial) }, h, toneForDependency: () => 'waiting', waitingChip: () => null }, selectors))

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  visit(node)
  const children = node.props === undefined ? undefined : node.props.children
  if (children === undefined) return
  if (Array.isArray(children)) {
    for (const child of children) walk(child, visit)
  } else {
    walk(children, visit)
  }
}

/** Render the real card and drive it like a user; returns the captured verdict calls. */
function renderCard(task) {
  const state = []
  let index = 0
  let vnode = null
  const calls = []
  reactBridge.useState = function (initial) {
    const at = index++
    if (!Object.prototype.hasOwnProperty.call(state, at)) state[at] = typeof initial === 'function' ? initial() : initial
    return [
      state[at],
      function (next) {
        state[at] = typeof next === 'function' ? next(state[at]) : next
        render()
      },
    ]
  }
  function render() {
    index = 0
    vnode = TaskCard({ task: task, t: (key) => key, now: 1000, selected: false, onOpen: () => {}, onVerdict: (action, id, payload) => calls.push({ action, id, payload }) })
  }
  render()
  const click = (action) => {
    let found = null
    walk(vnode, (node) => {
      if (node.props !== undefined && node.props['data-verdict-action'] === action) found = node
    })
    assert.ok(found, 'no panel button for ' + action)
    found.props.onClick({ stopPropagation() {} })
  }
  const typeReason = (text) => {
    let textarea = null
    walk(vnode, (node) => {
      if (node.props !== undefined && node.props['data-verdict-reason'] !== undefined) textarea = node
    })
    assert.ok(textarea, 'the blocking verdict has no reason field')
    textarea.props.onInput({ target: { value: text } })
  }
  const submit = () => {
    let button = null
    walk(vnode, (node) => {
      if (node.props !== undefined && node.props['data-verdict-submit'] === 'true') button = node
    })
    assert.ok(button, 'the blocking verdict has no submit button')
    button.props.onClick({ stopPropagation() {} })
  }
  return { calls, click, typeReason, submit }
}

// Review pass: the panel emits the user-attributed ReviewRecord.
const panelCard = await startCard('panel approve', [])
const reviewRender = renderCard(await boardTask(panelCard.id))
reviewRender.click('approveReview')
const reviewCall = reviewRender.calls[0]
const panelApproved = await rig.action(reviewCall.action, Object.assign({ id: reviewCall.id }, reviewCall.payload))
check('the panel approveReview payload is accepted as the human override', () => {
  assert.equal(reviewCall.action, 'approveReview')
  assert.equal(reviewCall.payload.checked[0].method, 'user review')
  assert.equal(panelApproved.ok, true, JSON.stringify(panelApproved).slice(0, 900))
  assert.equal(panelApproved.task.review.record.checked[0].criterion, 'human override from the task center panel')
  assert.equal(panelApproved.task.status, 'testing')
})

// Test pass: the panel emits the user-attributed TestRecord.
const testRender = renderCard(await boardTask(panelCard.id))
testRender.click('passTest')
const passCall = testRender.calls[0]
const panelPassed = await rig.action(passCall.action, Object.assign({ id: passCall.id }, passCall.payload))
check('the panel passTest payload is accepted as the human override', () => {
  assert.equal(passCall.action, 'passTest')
  assert.equal(passCall.payload.probes[0].id, 'human-override')
  assert.equal(panelPassed.ok, true, JSON.stringify(panelPassed).slice(0, 900))
  assert.equal(panelPassed.task.test.record.probes[0].id, 'human-override')
})

// Review reject: the panel's reason becomes the blocking finding.
const panelChangesCard = await startCard('panel request changes', [])
const changesRender = renderCard(await boardTask(panelChangesCard.id))
changesRender.click('requestChanges')
changesRender.typeReason('the panel wants a rename')
changesRender.submit()
const changesCall = changesRender.calls[0]
const panelChanges = await rig.action(changesCall.action, Object.assign({ id: changesCall.id }, changesCall.payload))
check('the panel requestChanges payload is accepted and renders its reasons', () => {
  assert.equal(changesCall.action, 'requestChanges')
  assert.equal(changesCall.payload.findings[0].severity, 'blocking')
  assert.equal(panelChanges.ok, true, JSON.stringify(panelChanges).slice(0, 900))
  assert.equal(panelChanges.task.status, 'running')
  assert.match(panelChanges.task.review.reasons, /the panel wants a rename/)
})

// Test fail: the panel's reason becomes the failing probe tail.
await rig.action('submit', { id: panelChangesCard.id, evidence: 'second attempt' })
const failRender = renderCard(await boardTask(panelChangesCard.id))
failRender.click('approveReview')
const approveAgainCall = failRender.calls[0]
await rig.action(approveAgainCall.action, Object.assign({ id: approveAgainCall.id }, approveAgainCall.payload))
const failTestRender = renderCard(await boardTask(panelChangesCard.id))
failTestRender.click('failTest')
failTestRender.typeReason('the panel reproduced a crash')
failTestRender.submit()
const failCall = failTestRender.calls[0]
const panelFailed = await rig.action(failCall.action, Object.assign({ id: failCall.id }, failCall.payload))
check('the panel failTest payload is accepted and returns the card to running', () => {
  assert.equal(failCall.action, 'failTest')
  assert.equal(failCall.payload.probes[0].exitCode, 1)
  assert.equal(panelFailed.ok, true, JSON.stringify(panelFailed).slice(0, 900))
  assert.equal(panelFailed.task.status, 'running')
  assert.match(panelFailed.task.test.record.probes[0].tail, /reproduced a crash/)
})

// An older bundle that only sends {id} must still work: the ACTION attributes
// the explicit human override instead of refusing it.
const legacyCard = await startCard('legacy panel payload', [])
const legacyApproved = await rig.action('approveReview', { id: legacyCard.id })
check('a bare legacy panel approveReview is still attributed as the human override', () => {
  assert.equal(legacyApproved.ok, true, JSON.stringify(legacyApproved).slice(0, 900))
  assert.equal(legacyApproved.task.review.record.checked[0].criterion, 'human override from the task center panel')
})

const failedChecks = checks.filter((row) => !row.ok)
for (const row of checks) {
  console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
}
console.log(String(checks.length - failedChecks.length) + '/' + String(checks.length) + ' checks passed')
rig.scheduler.dispose()
process.exit(failedChecks.length === 0 ? 0 : 1)
