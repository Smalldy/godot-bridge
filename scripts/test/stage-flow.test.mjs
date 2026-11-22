// Stage flow v4: submit -> review (structured record) -> approve -> tester brief
// (artifact + review scope, never the verdict) -> test (structured TestRecord),
// plus hostCheck reuse on an unchanged candidate fingerprint.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createApi } from '../../plugin/task-center/api.mjs'
import { createDispatcher } from '../../plugin/task-center/dispatch.mjs'
import { createState } from '../../plugin/task-center/state.mjs'
import { boardText, createFakeFs, createFakeGit, createFakeTaskAgents, createRig, createStrictCtx, createTask, PROJECT, seedBoard } from './support/fixtures.mjs'

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
  const snap = await rig.action('board', { view: 'full' })
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
check('the board exposes state + the test phase after the approval', () => {
  assert.equal(afterApprove.status, 'testing')
  assert.equal(afterApprove.state, 'testing')
  assert.equal(afterApprove.phase, 'test')
})
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
  assert.equal(failedFirst.task.state, 'running')
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
  assert.equal(afterChanges.phase, 'implement')
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


// ── T-201 round 2: unblocking a stage-paused card re-provisions its round ────
{
  const reviewCard = await startCard('unblock restores the reviewer', PROBE_SUITE)
  const beforeBlock = await boardTask(reviewCard.id)
  const oldReviewer = beforeBlock.review.deliveredTo.id
  const blocked = await rig.action('block', { id: reviewCard.id })
  const unblocked = await rig.action('unblock', { id: reviewCard.id })
  const restored = await boardTask(reviewCard.id)
  check('unblock re-provisions the restored review round with a live reviewer', () => {
    assert.equal(blocked.ok, true, JSON.stringify(blocked).slice(0, 500))
    assert.equal(unblocked.ok, true, JSON.stringify(unblocked).slice(0, 800))
    assert.equal(restored.status, 'reviewing')
    assert.ok(restored.review.deliveredTo !== null && restored.review.deliveredTo !== undefined, 'no reviewer deliveredTo after unblock')
    assert.notEqual(restored.review.deliveredTo.id, oldReviewer)
    assert.equal(taskAgents.live.has(restored.review.deliveredTo.id), true, 'the re-provisioned reviewer is not live')
    const startedAgain = taskAgents.calls.filter((entry) => entry.kind === 'startReviewer' && entry.taskId === reviewCard.id).pop()
    assert.equal(startedAgain.agentId, restored.review.deliveredTo.id)
  })

  const testCard = await startCard('unblock restores the tester', PROBE_SUITE)
  const approvedTestCard = await rig.action('approveReview', { id: testCard.id })
  assert.equal(approvedTestCard.ok, true, JSON.stringify(approvedTestCard).slice(0, 800))
  const beforeTestBlock = await boardTask(testCard.id)
  const oldTester = beforeTestBlock.test.deliveredTo.id
  const blockedTest = await rig.action('block', { id: testCard.id })
  const unblockedTest = await rig.action('unblock', { id: testCard.id })
  const restoredTest = await boardTask(testCard.id)
  check('unblock re-provisions the restored open test round with a live tester', () => {
    assert.equal(blockedTest.ok, true, JSON.stringify(blockedTest).slice(0, 500))
    assert.equal(unblockedTest.ok, true, JSON.stringify(unblockedTest).slice(0, 800))
    assert.equal(restoredTest.status, 'testing')
    assert.ok(restoredTest.test.deliveredTo !== null && restoredTest.test.deliveredTo !== undefined, 'no tester deliveredTo after unblock')
    assert.notEqual(restoredTest.test.deliveredTo.id, oldTester)
    assert.equal(taskAgents.live.has(restoredTest.test.deliveredTo.id), true, 'the re-provisioned tester is not live')
    const startedAgain = taskAgents.calls.filter((entry) => entry.kind === 'startTester' && entry.taskId === testCard.id).pop()
    assert.equal(startedAgain.agentId, restoredTest.test.deliveredTo.id)
  })
}

// ── T-201 round 2: a merge-* block clears the claim (INV-blocked), the host
//    notifies the implementer, and THAT worker can refresh the request. A
//    non-merge block or a stranger is still refused ───────────────────────────
{
  const conflictAgents = createFakeTaskAgents()
  const conflictHeads = {}
  const conflictGit = createFakeGit({ heads: conflictHeads })
  const conflictRig = createRig({
    git: conflictGit,
    taskAgents: conflictAgents,
    merger: {
      async mergeRequest() {
        return { ok: true, status: 'conflict', conflict: 'a.gd', output: null }
      },
    },
  })
  async function conflictBoardTask(id) {
    const snap = await conflictRig.action('board', { view: 'full' })
    assert.equal(snap.ok, true, JSON.stringify(snap).slice(0, 400))
    return snap.tasks.filter((entry) => entry.id === id)[0]
  }
  function performOn(rigInstance, agentId, name, action, payload) {
    return rigInstance.api.perform(action, payload, { projectPath: rigInstance.project, by: '@' + name, role: 'agent', agent: { id: agentId, name: name } })
  }
  const conflictTask = await createTask(conflictRig, {
    title: 'merge conflict repair',
    writeFiles: [],
    acceptance: '- the conflicted file is repaired',
    verification: { probes: [{ id: 'probe-conflict', command: 'node --test scripts/a.test.mjs' }] },
  })
  const conflictStarted = await conflictRig.action('start')
  assert.equal(conflictStarted.ok, true, JSON.stringify(conflictStarted).slice(0, 500))
  await conflictRig.settle()
  const conflictSubmitted = await conflictRig.action('submit', { id: conflictTask.id, evidence: 'ready for review' })
  assert.equal(conflictSubmitted.ok, true, JSON.stringify(conflictSubmitted).slice(0, 700))
  const afterSubmit = await conflictBoardTask(conflictTask.id)
  const conflictWorker = afterSubmit.assignee
  assert.ok(conflictWorker !== null && typeof conflictWorker.session === 'string', 'the card has no implementer claim')
  const approvedConflict = await conflictRig.action('approveReview', { id: conflictTask.id })
  assert.equal(approvedConflict.ok, true, JSON.stringify(approvedConflict).slice(0, 700))
  const passedConflict = await conflictRig.action('passTest', { id: conflictTask.id })
  assert.equal(passedConflict.ok, true, JSON.stringify(passedConflict).slice(0, 700))
  const readyToMerge = await conflictBoardTask(conflictTask.id)
  assert.equal(readyToMerge.phase, 'merge', JSON.stringify(readyToMerge).slice(0, 400))
  // The queue verifies the exact tested head; the fake branch head is that same
  // commit, and the conflict is reported by the merge service.
  conflictHeads[readyToMerge.worktree] = readyToMerge.merge.head
  const conflicted = await conflictRig.action('mergeRequest', { id: conflictTask.id })
  const blockedCard = await conflictBoardTask(conflictTask.id)
  check('a merge conflict blocks the card and keeps the implementer as lastAssignee only', () => {
    assert.equal(conflicted.ok, true, JSON.stringify(conflicted).slice(0, 900))
    assert.equal(blockedCard.status, 'blocked')
    assert.equal(blockedCard.blockedReason.code, 'merge-conflict')
    assert.equal(blockedCard.assignee, null, 'a blocked card still shows a live claim')
    assert.ok(blockedCard.lastAssignee !== null && blockedCard.lastAssignee !== undefined, 'the implementer identity was discarded')
    assert.equal(blockedCard.lastAssignee.session, conflictWorker.session)
    const notice = conflictAgents.calls.filter((entry) => entry.kind === 'send' && entry.agentId === conflictWorker.session).pop()
    assert.ok(notice, 'the implementer was never told to repair the merge request')
    assert.match(notice.text, /refreshMerge/)
  })
  // The worker repairs the branch and refreshes: T27 accepts the retained
  // implementer even though the blocked card has no live claim.
  conflictHeads[readyToMerge.worktree] = 'repaired-head'
  const refreshedByWorker = await performOn(conflictRig, conflictWorker.session, conflictWorker.name, 'refreshMerge', { id: conflictTask.id })
  const afterRefresh = await conflictBoardTask(conflictTask.id)
  check('the notified implementer can refresh a merge-* block into review', () => {
    assert.equal(refreshedByWorker.ok, true, JSON.stringify(refreshedByWorker).slice(0, 900))
    assert.equal(afterRefresh.status, 'reviewing')
    assert.equal(afterRefresh.blockedReason, null)
    assert.equal(afterRefresh.merge.status, 'open')
    assert.equal(afterRefresh.merge.head, 'repaired-head')
    assert.ok(afterRefresh.review.deliveredTo !== null && afterRefresh.review.deliveredTo !== undefined, 'the refreshed round has no reviewer')
    assert.equal(conflictAgents.live.has(afterRefresh.review.deliveredTo.id), true, 'the refreshed reviewer is not live')
  })
  const stranger = await performOn(conflictRig, 'agent-stranger', 'worker-stranger', 'refreshMerge', { id: conflictTask.id })
  check('a stranger still cannot refresh the card', () => {
    assert.equal(stranger.ok, false)
    assert.equal(stranger.code, 'not-assignee')
  })
  conflictRig.scheduler.dispose()
}

// ── T-201 round 3: a candidate merge conflict/failed is a RECORDED merge
//    outcome (T22/T23), not an opaque failure the sweep retries forever ───────
for (const outcome of ['conflict', 'failed']) {
  const candidateAgents = createFakeTaskAgents()
  const candidateRig = createRig({
    taskAgents: candidateAgents,
    merger: {
      async createCandidate(task) {
        return { ok: true, path: '/demo-project/.worktrees/test-' + task.id, base: 'base-candidate', head: 'candidate-head-1', target: 'main', actualFiles: [] }
      },
      async mergeCandidate() {
        return {
          ok: true,
          status: outcome,
          conflict: outcome === 'conflict' ? 'a.gd' : null,
          output: outcome === 'failed' ? 'the verification command failed' : null,
          mergeCommit: null,
        }
      },
      async discardCandidate() {
        return { ok: true }
      },
    },
  })
  async function candidateBoardTask(id) {
    const snap = await candidateRig.action('board', { view: 'full' })
    assert.equal(snap.ok, true, JSON.stringify(snap).slice(0, 400))
    return snap.tasks.filter((entry) => entry.id === id)[0]
  }
  const candidateCard = await createTask(candidateRig, {
    title: 'candidate merge ' + outcome,
    writeFiles: [],
    acceptance: '- the candidate is accepted',
    verification: { probes: [{ id: 'probe-candidate', command: 'node --test scripts/a.test.mjs' }] },
  })
  const candidateStarted = await candidateRig.action('start')
  assert.equal(candidateStarted.ok, true, JSON.stringify(candidateStarted).slice(0, 500))
  await candidateRig.settle()
  const candidateSubmitted = await candidateRig.action('submit', { id: candidateCard.id, evidence: 'ready' })
  assert.equal(candidateSubmitted.ok, true, JSON.stringify(candidateSubmitted).slice(0, 700))
  const candidateApproved = await candidateRig.action('approveReview', { id: candidateCard.id })
  assert.equal(candidateApproved.ok, true, JSON.stringify(candidateApproved).slice(0, 700))
  const beforePass = await candidateBoardTask(candidateCard.id)
  const candidateImplementer = beforePass.assignee
  assert.ok(candidateImplementer !== null && typeof candidateImplementer.session === 'string', 'the candidate card has no implementer')
  const candidatePassed = await candidateRig.action('passTest', { id: candidateCard.id })
  const candidateBlocked = await candidateBoardTask(candidateCard.id)
  check('a candidate merge ' + outcome + ' is recorded as a merge-* block', () => {
    assert.equal(candidatePassed.ok, true, JSON.stringify(candidatePassed).slice(0, 900))
    assert.equal(candidateBlocked.status, 'blocked')
    assert.equal(candidateBlocked.blockedReason.code, 'merge-' + outcome)
    assert.equal(candidateBlocked.blockedReason.from, 'testing')
    assert.equal(candidateBlocked.blockedReason.phase, 'merge')
    assert.equal(candidateBlocked.assignee, null, 'the blocked card still has a live claim')
    assert.ok(candidateBlocked.lastAssignee !== null && candidateBlocked.lastAssignee !== undefined, 'the implementer identity was discarded')
    assert.equal(candidateBlocked.lastAssignee.session, candidateImplementer.session)
    assert.equal(candidateBlocked.merge.status, outcome)
    assert.equal(candidateBlocked.test.status, 'passed')
    assert.equal(candidateBlocked.phase, null)
  })
  check('the candidate ' + outcome + ' notifies the implementer to repair the request', () => {
    const notice = candidateAgents.calls.filter((entry) => entry.kind === 'send' && entry.agentId === candidateImplementer.session).pop()
    assert.ok(notice, 'the implementer was never told about the merge outcome')
    assert.match(notice.text, /refreshMerge/)
  })
  const retried = await candidateRig.action('mergeRequest', { id: candidateCard.id })
  check('the sweep cannot retry a candidate ' + outcome + ' as if the card were still eligible', () => {
    assert.equal(retried.ok, false)
    assert.equal(retried.code, 'no-open-merge')
  })
  candidateRig.scheduler.dispose()
}

// ── T-217: a PENDING test round is never rebuilt, replaced or merged ────────
//
// The regression: a card in testing + test.pending + waitingReason=candidate-stale
// was rebuilt by the SAME sweep that had just started its tester (the
// provisioning pass wrote the board, the rebuild pass still used the pre-start
// snapshot). The merge then refused with no-open-merge, the card was marked
// candidate-stale again, and the next sweep replaced the tester — the round could
// never finish. Every sweep below is the real autoMergePending.
const HEX = (char) => char.repeat(40)

/** The sweep's host check: the declared verify command always exits 0 here. */
function hostCheckHarness() {
  const calls = []
  return {
    calls: calls,
    spawn(input) {
      calls.push(input)
      return {
        collected: {
          stdout: { readFrom: () => ({ text: 'PASS 67/67\n' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
        done: Promise.resolve({ exitCode: 0 }),
      }
    },
  }
}

/** The merger the sweep drives, with every candidate/merge call recorded. */
function recordingMerger() {
  const calls = []
  return {
    calls: calls,
    async createCandidate(task) {
      calls.push({ kind: 'createCandidate', id: String(task.id) })
      return {
        ok: true,
        path: join(PROJECT, '.worktrees', 'test-' + String(task.id)),
        base: HEX('c'),
        head: 'candidate-head-' + String(task.id),
        target: 'main',
        actualFiles: [],
      }
    },
    async mergeCandidate(task) {
      calls.push({ kind: 'mergeCandidate', id: String(task.id) })
      return { ok: true, status: 'merged', mergeCommit: 'merged-' + String(task.id), candidateRemoved: true, taskWorktreeRemoved: false }
    },
    async discardCandidate(task) {
      calls.push({ kind: 'discardCandidate', id: String(task.id) })
      return { ok: true }
    },
  }
}

/** A testing card whose merge request sits on an OLD target head (base drift). */
function staleCandidateCard(id, overrides) {
  const stamp = '2026-11-20T00:00:00.000Z'
  return Object.assign(
    {
      id: id,
      title: 'stale candidate ' + id,
      status: 'testing',
      kind: 'dev',
      target: 'main',
      base: HEX('a'),
      branch: 'task/' + id + '-1',
      commit: HEX('b'),
      worktree: join(PROJECT, '.worktrees', id + '-1'),
      ownerSession: 'session-lead',
      writeFiles: [],
      verify: { command: 'npm test', timeoutMs: 5000 },
      verification: { probes: [{ id: 'probe-a', command: 'node --test scripts/a.test.mjs' }] },
      review: { status: 'approved', attempt: 1 },
      test: { status: 'pending', attempt: 1, deliveredTo: null },
      merge: { status: 'open', base: HEX('a'), head: HEX('b'), target: 'main', mergeCommit: HEX('b'), actualFiles: [] },
      waitingReason: 'candidate-stale',
      waitingDetail: 'diff changed: the target moved after the test round opened',
      history: [],
      createdAt: stamp,
      updatedAt: stamp,
    },
    overrides === undefined ? {} : overrides,
  )
}

/** One project, one seeded board, the real sweep with autoMerge enabled. */
function createSweepRig(options) {
  const opts = options === undefined ? {} : options
  const fs = createFakeFs()
  fs.dirs.add(PROJECT)
  fs.dirs.add(join(PROJECT, '.git'))
  fs.dirs.add(join(PROJECT, '.agents'))
  fs.dirs.add(join(PROJECT, '.worktrees'))
  const git = createFakeGit({ base: HEX('b'), heads: opts.heads })
  // The target moved past every recorded base: the merge loop sees drift.
  git.revParse = async () => ({ ok: true, hash: HEX('c') })
  git.isAncestor = async () => ({ ok: true, ancestor: true })
  const subprocess = hostCheckHarness()
  const ctx = createStrictCtx(
    {
      fs: fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
      get(key) {
        if (key === 'agents') return { list: () => [{ id: 'session-lead' }] }
        if (key === 'subagents') return { list: () => ['spawn'] }
        if (key === 'subprocess') return subprocess
        return undefined
      },
    },
    ['fs', 'sandboxPolicy', 'tools', 'webServer'],
  )
  const state = createState(ctx, { sessionLookup: null })
  state.setSessionRoot('session-lead', PROJECT)
  const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: true, git: git, taskAgents: opts.taskAgents })
  const api = createApi(ctx, { state: state, scheduler: scheduler, git: git, merger: opts.merger, taskAgents: opts.taskAgents, autoMerge: true })
  seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: opts.cards.length + 1, dispatch: { state: 'running' }, tasks: opts.cards }))
  async function card(id) {
    // T-231: these checks read the DETAIL-class stage records (deliveredTo.generation,
    // merge.artifact), so they ask for the explicit full view.
    const snap = await api.perform('board', { view: 'full' }, { projectPath: PROJECT, by: '@user', role: 'user', agent: null, sessionId: 'session-lead' })
    assert.equal(snap.ok, true, JSON.stringify(snap).slice(0, 600))
    return snap.tasks.filter((entry) => entry.id === id)[0]
  }
  return { fs: fs, state: state, scheduler: scheduler, api: api, git: git, subprocess: subprocess, card: card }
}

// A. pending tester + candidate-stale: no rebuild, no merge, exactly one tester
{
  const taskAgents = createFakeTaskAgents()
  const merger = recordingMerger()
  const rig = createSweepRig({ taskAgents: taskAgents, merger: merger, cards: [staleCandidateCard('T-900')] })
  const sweeps = []
  for (let round = 0; round < 3; round += 1) sweeps.push(await rig.api.autoMergePending(PROJECT))
  const card = await rig.card('T-900')
  const testerStarts = taskAgents.calls.filter((call) => call.kind === 'startTester' && call.taskId === 'T-900')

  check('T-217 a pending test round is never rebuilt into a merge', () => {
    assert.equal(sweeps.every((sweep) => sweep.ok === true), true, JSON.stringify(sweeps))
    assert.equal(merger.calls.filter((call) => call.kind === 'createCandidate').length, 0, 'the sweep rebuilt a candidate under a pending tester: ' + JSON.stringify(merger.calls))
    assert.equal(merger.calls.filter((call) => call.kind === 'mergeCandidate').length, 0, 'the sweep merged a pending test round')
  })

  check('T-217 the waiting card gets exactly one tester, which then owns the round', () => {
    assert.equal(testerStarts.length, 1, 'startTester calls: ' + JSON.stringify(testerStarts.map((call) => call.agentId)))
    assert.equal(taskAgents.live.has(testerStarts[0].agentId), true, 'the started tester is not live')
    assert.equal(card.status, 'testing')
    assert.equal(card.test.status, 'pending')
    assert.equal(card.test.deliveredTo.id, testerStarts[0].agentId, 'the card does not point at the tester it started')
    assert.equal(card.waitingReason, null, 'the card still waits for a stale-candidate rebuild while its tester runs')
  })

  check('T-217 three consecutive sweeps never replace that tester', () => {
    assert.equal(testerStarts.length, 1, 'a later sweep started another tester')
    assert.equal(taskAgents.calls.filter((call) => call.kind === 'releaseTask').length, 0, 'the sweep disposed the running tester')
    assert.equal(card.status, 'testing', 'the card left testing without a verdict')
  })
  rig.scheduler.dispose()
}

// B. no tester service: the card keeps waiting, one attempt per sweep, no rebuild
{
  const taskAgents = createFakeTaskAgents()
  taskAgents.startTester = async function (task, prompt) {
    taskAgents.calls.push({ kind: 'startTester', taskId: String(task.id), agentId: null, text: prompt })
    throw new Error('no tester runtime in this profile')
  }
  const merger = recordingMerger()
  const rig = createSweepRig({ taskAgents: taskAgents, merger: merger, cards: [staleCandidateCard('T-901')] })
  const sweeps = []
  for (let round = 0; round < 3; round += 1) sweeps.push(await rig.api.autoMergePending(PROJECT))
  const card = await rig.card('T-901')
  const attempts = taskAgents.calls.filter((call) => call.kind === 'startTester')

  check('T-217 without a tester the sweep keeps waiting instead of rebuilding', () => {
    assert.equal(sweeps.every((sweep) => sweep.ok === true), true, JSON.stringify(sweeps))
    assert.equal(attempts.length, 3, 'one start attempt per sweep, got ' + String(attempts.length))
    assert.equal(merger.calls.length, 0, 'the sweep reached the candidate/merge service: ' + JSON.stringify(merger.calls))
    assert.equal(card.status, 'testing')
    assert.equal(card.test.status, 'pending')
    assert.equal(card.waitingReason, 'candidate-stale', 'the wait was cleared without a tester')
    assert.equal(card.test.deliveredTo, null, 'a tester was recorded although none started')
  })
  rig.scheduler.dispose()
}

// C. the rebuild gate is the PASSED verdict: same sweep, pending skipped, passed merged
{
  const taskAgents = createFakeTaskAgents()
  const merger = recordingMerger()
  const passedWorktree = join(PROJECT, '.worktrees', 'T-903-1')
  const rig = createSweepRig({
    taskAgents: taskAgents,
    merger: merger,
    heads: { [passedWorktree]: HEX('e') },
    cards: [
      staleCandidateCard('T-902'),
      staleCandidateCard('T-903', {
        base: HEX('d'),
        commit: HEX('e'),
        test: { status: 'passed', attempt: 1 },
        merge: { status: 'open', base: HEX('d'), head: HEX('e'), target: 'main', mergeCommit: HEX('e'), actualFiles: [] },
      }),
    ],
  })
  const sweep = await rig.api.autoMergePending(PROJECT)
  const pendingCard = await rig.card('T-902')
  const passedCard = await rig.card('T-903')
  const builds = merger.calls.filter((call) => call.kind === 'createCandidate')

  check('T-217 only a passed test round is rebuilt and merged, pending is left alone', () => {
    assert.equal(sweep.ok, true, JSON.stringify(sweep).slice(0, 900))
    assert.equal(builds.length, 1, 'candidate builds in one sweep: ' + JSON.stringify(merger.calls))
    assert.equal(builds[0].id, 'T-903')
    assert.equal(merger.calls.filter((call) => call.kind === 'mergeCandidate').length, 1)
    assert.equal(passedCard.status, 'done', JSON.stringify(passedCard).slice(0, 500))
    assert.equal(passedCard.merge.status, 'merged')
    assert.equal(passedCard.waitingReason, null)
    assert.equal(pendingCard.status, 'testing')
    assert.equal(pendingCard.test.status, 'pending')
    assert.equal(taskAgents.calls.filter((call) => call.kind === 'startTester').length, 1, 'only the pending card is given a tester')
    assert.equal(taskAgents.calls.filter((call) => call.kind === 'startTester')[0].taskId, 'T-902')
  })
  rig.scheduler.dispose()
}

// D. a reviewing card waiting for its candidate rebuild gets ONE refresh, not a
//    reviewer start followed by another reviewer from the refresh
{
  const taskAgents = createFakeTaskAgents()
  const merger = recordingMerger()
  const rig = createSweepRig({
    taskAgents: taskAgents,
    merger: merger,
    cards: [
      staleCandidateCard('T-904', {
        status: 'reviewing',
        test: null,
        review: { status: 'pending', attempt: 1, deliveredTo: null },
      }),
    ],
  })
  const sweep = await rig.api.autoMergePending(PROJECT)
  const card = await rig.card('T-904')
  const reviewers = taskAgents.calls.filter((call) => call.kind === 'startReviewer')

  check('T-217 a reviewing stale card is refreshed once, by the pass that owns it', () => {
    assert.equal(sweep.ok, true, JSON.stringify(sweep).slice(0, 900))
    assert.equal(reviewers.length, 1, 'reviewer starts in one sweep: ' + JSON.stringify(reviewers.map((call) => call.agentId)))
    assert.equal(taskAgents.calls.filter((call) => call.kind === 'startTester').length, 0, 'a tester was started for a card with no test round')
    assert.equal(merger.calls.length, 0, 'the refresh must not build a candidate itself: ' + JSON.stringify(merger.calls))
    assert.equal(card.status, 'reviewing')
    assert.equal(card.review.deliveredTo.id, reviewers[0].agentId)
    assert.equal(card.waitingReason, null, 'the refreshed card still waits for a stale-candidate rebuild')
  })
  rig.scheduler.dispose()
}

// ── T-221: a hung agent tree must not hold the merge queue, and an ABANDONED
//    queue turn must never land its refresh ───────────────────────────────────
//
// The incident: refreshMerge ran inside one merge-queue unit; releasing the old
// stage children fell back to a whole-tree catalog read that took minutes; the
// unit was abandoned with 'queue-timeout', the caller moved on, and the refresh
// kept running in the background (it would have written the board minutes later).
{
  /** A rig whose API gets a short agent-list bound, for the hung-catalog case. */
  function createT221Rig(options) {
    const opts = options === undefined ? {} : options
    const fs = createFakeFs()
    fs.dirs.add(PROJECT)
    fs.dirs.add(join(PROJECT, '.git'))
    fs.dirs.add(join(PROJECT, '.agents'))
    fs.dirs.add(join(PROJECT, '.worktrees'))
    const git = createFakeGit({ base: 'base-sha', heads: opts.heads })
    const ctx = createStrictCtx(
      {
        fs: fs,
        sandboxPolicy: { resolve: () => ({ workspaceRoot: PROJECT }) },
        get(key) {
          if (key === 'agents') return { list: () => [{ id: 'session-lead' }] }
          if (key === 'subagents') return { list: () => ['spawn'] }
          return undefined
        },
      },
      ['fs', 'sandboxPolicy', 'tools', 'webServer'],
    )
    const state = createState(ctx, { sessionLookup: null })
    state.setSessionRoot('session-lead', PROJECT)
    const scheduler = createDispatcher(ctx, { state: state, projectPath: () => PROJECT, allowSpawn: false, git: git, taskAgents: opts.taskAgents })
    const api = createApi(ctx, {
      state: state,
      scheduler: scheduler,
      git: git,
      merger: opts.merger,
      taskAgents: opts.taskAgents,
      // The production bound is seconds; a test states it in milliseconds.
      agentListTimeoutMs: opts.agentListTimeoutMs === undefined ? 60 : opts.agentListTimeoutMs,
    })
    seedBoard(fs, PROJECT, JSON.stringify({ version: 2, seq: opts.cards.length + 1, dispatch: { state: 'running' }, tasks: opts.cards }))
    // Read the card from the FILE: a board action may rebuild host metadata, and
    // the point of these checks is that no read of the agent tree happens at all.
    function rawCard(id) {
      const board = JSON.parse(boardText(fs, PROJECT))
      return board.tasks.filter((entry) => entry.id === id)[0]
    }
    return { fs: fs, state: state, scheduler: scheduler, api: api, git: git, rawCard: rawCard }
  }

  function performOn(rigInstance, agentId, name, action, payload) {
    return rigInstance.api.perform(action, payload, { projectPath: PROJECT, by: '@' + name, role: 'agent', agent: { id: agentId, name: name } })
  }

  /** A card blocked by a merge conflict whose stage round is still recorded. */
  function mergeConflictCard(id, worktreeHead) {
    const stamp = '2026-11-20T00:00:00.000Z'
    const worktree = join(PROJECT, '.worktrees', id + '-1')
    return {
      id: id,
      title: 'merge conflict ' + id,
      status: 'blocked',
      kind: 'dev',
      target: 'main',
      base: 'base-sha',
      branch: 'task/' + id + '-1',
      commit: worktreeHead,
      worktree: worktree,
      ownerSession: 'session-lead',
      writeFiles: [],
      verify: { command: 'npm test', timeoutMs: 5000 },
      verification: { probes: [{ id: 'probe-a', command: 'node --test scripts/a.test.mjs' }] },
      review: { status: 'approved', attempt: 1, deliveredTo: { name: 'reviewer-t-' + id, id: 'reviewer-old-' + id, at: stamp } },
      test: { status: 'passed', attempt: 1, deliveredTo: { name: 'tester-t-' + id, id: 'tester-old-' + id, at: stamp } },
      merge: { status: 'conflict', base: 'base-sha', head: 'old-head', target: 'main', conflict: 'a.gd', actualFiles: [] },
      blockedReason: { code: 'merge-conflict', from: 'testing', phase: 'merge', at: stamp },
      lastAssignee: { name: 'worker-t-' + id, session: 'worker-session-' + id, at: stamp },
      assignee: null,
      history: [],
      createdAt: stamp,
      updatedAt: stamp,
    }
  }

  // 1) A catalog that never answers. Before T-221 this held the whole queue unit
  //    until it was abandoned; now every read is bounded and the refresh lands.
  {
    // The recorded round is LIVE: a release the board can prove must not need the
    // (hung) tree to be released.
    const agents = createFakeTaskAgents({ live: ['reviewer-old-T-920', 'tester-old-T-920'] })
    const hang = function () {
      return new Promise(function () {})
    }
    agents.listFor = hang
    agents.listAgentsFor = hang
    const worktree = join(PROJECT, '.worktrees', 'T-920-1')
    const rig = createT221Rig({
      taskAgents: agents,
      merger: recordingMerger(),
      agentListTimeoutMs: 60,
      heads: { [worktree]: 'repaired-head' },
      cards: [mergeConflictCard('T-920', 'repaired-head')],
    })
    const startedAt = Date.now()
    const refreshed = await performOn(rig, 'worker-session-T-920', 'worker-t-T-920', 'refreshMerge', { id: 'T-920' })
    const elapsed = Date.now() - startedAt
    const card = rig.rawCard('T-920')
    check('T-221 a hung agent tree cannot hold refreshMerge', () => {
      assert.ok(elapsed < 2000, 'refreshMerge waited ' + String(elapsed) + 'ms on a hung catalog')
      assert.equal(refreshed.ok, true, JSON.stringify(refreshed).slice(0, 900))
      assert.equal(card.status, 'reviewing')
      assert.equal(card.merge.status, 'open')
      assert.equal(card.merge.head, 'repaired-head')
      assert.equal(card.blockedReason, null)
      assert.ok(card.review.deliveredTo !== null && card.review.deliveredTo !== undefined, 'the refreshed round has no reviewer')
    })
    rig.scheduler.dispose()
  }

  // 2) The queue unit is abandoned WHILE the release is running. The release is
  //    already in flight (nothing can undo it), but the refresh must not write: the
  //    caller was told 'queue-timeout', so a later board write would be a phantom.
  {
    const agents = createFakeTaskAgents({ live: ['reviewer-old-T-921', 'tester-old-T-921'] })
    const baseRelease = agents.release
    let openGate = null
    let markEntered = null
    const gate = new Promise(function (resolve) {
      openGate = resolve
    })
    const entered = new Promise(function (resolve) {
      markEntered = resolve
    })
    agents.release = async function (agentId) {
      markEntered()
      await gate
      return baseRelease.call(agents, agentId)
    }
    const token = { aborted: false }
    const merger = Object.assign(recordingMerger(), {
      enqueue(work) {
        return work(token)
      },
    })
    const worktree = join(PROJECT, '.worktrees', 'T-921-1')
    const rig = createT221Rig({
      taskAgents: agents,
      merger: merger,
      heads: { [worktree]: 'repaired-head' },
      cards: [mergeConflictCard('T-921', 'repaired-head')],
    })
    const before = boardText(rig.fs, PROJECT)
    const pending = performOn(rig, 'worker-session-T-921', 'worker-t-T-921', 'refreshMerge', { id: 'T-921' })
    await entered
    token.aborted = true
    openGate()
    const refreshed = await pending
    const after = rig.rawCard('T-921')
    check('T-221 an abandoned merge turn never lands its refresh', () => {
      assert.equal(refreshed.ok, false, JSON.stringify(refreshed).slice(0, 900))
      assert.equal(refreshed.code, 'action-abandoned', 'the background turn did not report abandonment')
      assert.equal(boardText(rig.fs, PROJECT), before, 'an abandoned queue turn wrote the board')
      assert.equal(after.status, 'blocked')
      assert.equal(after.merge.status, 'conflict')
      assert.equal(after.merge.head, 'old-head')
      assert.equal(after.review.deliveredTo.id, 'reviewer-old-T-921')
    })
    check('T-221 an abandoned turn leaves no unrecorded reviewer behind', () => {
      const reviewers = Array.from(agents.live).filter((id) => String(id).indexOf('reviewer-T-921') === 0)
      assert.deepEqual(reviewers, [], 'the reviewer started by the abandoned turn was not rolled back')
      // T-223: the reviewer now starts AFTER the guarded round write, so an
      // abandoned turn starts nothing at all (it used to start one and roll it
      // back). "Nothing behind" is the invariant; zero starts is the stronger form.
      assert.equal(agents.calls.filter((call) => call.kind === 'startReviewer' && call.taskId === 'T-921').length, 0)
    })
    rig.scheduler.dispose()
  }
}

// ── T-223: the StageCoordinator is the ONE start authority ───────────────────
//
// The T-221 incident: two host paths could each read a pending round with no
// deliveredTo and each start a tester; the second write overwrote the first
// child and the card was worked by two testers. These checks drive the REAL
// sweep concurrently, so the regression is exercised end to end, not through a
// unit seam.

// A. two concurrent sweeps must still produce exactly ONE tester.
{
  const taskAgents = createFakeTaskAgents()
  const merger = recordingMerger()
  const rig = createSweepRig({ taskAgents: taskAgents, merger: merger, cards: [staleCandidateCard('T-930')] })
  const sweeps = await Promise.all([rig.api.autoMergePending(PROJECT), rig.api.autoMergePending(PROJECT)])
  const card = await rig.card('T-930')
  const testerStarts = taskAgents.calls.filter((call) => call.kind === 'startTester' && call.taskId === 'T-930')

  check('T-223 two concurrent sweeps start exactly ONE tester for a pending round', () => {
    assert.equal(sweeps.every((sweep) => sweep.ok === true), true, JSON.stringify(sweeps))
    assert.equal(testerStarts.length, 1, 'startTester calls: ' + JSON.stringify(testerStarts.map((call) => call.agentId)))
    assert.equal(taskAgents.live.has(testerStarts[0].agentId), true, 'the started tester is not live')
    assert.equal(Array.from(taskAgents.live).filter((id) => String(id).indexOf('tester-') === 0).length, 1, JSON.stringify(Array.from(taskAgents.live)))
    assert.equal(card.test.deliveredTo.id, testerStarts[0].agentId, 'the card does not point at the tester it started')
    assert.equal(card.test.deliveredTo.generation, 1, 'the delivery generation is not durable on the board')
    assert.equal(taskAgents.calls.filter((call) => call.kind === 'releaseTask').length, 0, 'the second sweep disposed the first tester instead of reusing it')
  })
  rig.scheduler.dispose()
}

// B. a pending round recorded by a PREVIOUS process (no local handle) is never
//    raced with a second child: the sweep waits for reconciliation.
{
  const taskAgents = createFakeTaskAgents()
  const merger = recordingMerger()
  const stamp = '2026-11-20T00:00:00.000Z'
  const rig = createSweepRig({
    taskAgents: taskAgents,
    merger: merger,
    cards: [
      staleCandidateCard('T-931', {
        test: { status: 'pending', attempt: 1, deliveredTo: { name: 'tester-restart', id: 'tester-restart', at: stamp } },
      }),
    ],
  })
  const sweeps = []
  for (let round = 0; round < 2; round += 1) sweeps.push(await rig.api.autoMergePending(PROJECT))
  const card = await rig.card('T-931')

  check('T-223 a pending round with an unconfirmable delivery is not double-spawned', () => {
    assert.equal(sweeps.every((sweep) => sweep.ok === true), true, JSON.stringify(sweeps))
    assert.equal(taskAgents.calls.filter((call) => call.kind === 'startTester').length, 0, 'a second tester was started behind the recorded one')
    assert.equal(taskAgents.calls.filter((call) => call.kind === 'releaseTask').length, 0, 'the unconfirmable delivery was disposed')
    assert.equal(card.status, 'testing')
    assert.equal(card.test.status, 'pending')
    assert.equal(card.test.deliveredTo.id, 'tester-restart', 'the recorded delivery was overwritten')
    assert.equal(card.waitingReason, 'candidate-stale', 'the wait was cleared although no tester started')
  })
  rig.scheduler.dispose()
}

// C. a baseline retest (the target moved under a passed round) starts its tester
//    through the coordinator AND records it; the recovery pass then reuses it
//    instead of starting the second tester the old code could create.
{
  const taskAgents = createFakeTaskAgents()
  const calls = []
  const merger = {
    calls: calls,
    async createCandidate(task) {
      calls.push({ kind: 'createCandidate', id: String(task.id) })
      return { ok: true, path: join(PROJECT, '.worktrees', 'test-' + String(task.id)), base: HEX('c'), head: 'rebuilt-' + String(task.id), target: 'main', actualFiles: [] }
    },
    async mergeCandidate(task) {
      calls.push({ kind: 'mergeCandidate', id: String(task.id) })
      // The target moved after the tester passed: the candidate is stale.
      return { ok: true, status: 'stale' }
    },
    async discardCandidate(task) {
      calls.push({ kind: 'discardCandidate', id: String(task.id) })
      return { ok: true }
    },
  }
  const rig = createSweepRig({
    taskAgents: taskAgents,
    merger: merger,
    cards: [
      staleCandidateCard('T-940', {
        waitingReason: 'tester-unavailable',
        waitingDetail: 'the previous tester could not be started',
        test: { status: 'passed', attempt: 1 },
        merge: { status: 'open', base: HEX('a'), head: HEX('b'), target: 'main', mergeCommit: HEX('b'), actualFiles: [] },
      }),
    ],
  })
  const merged = await rig.api.perform('mergeRequest', { id: 'T-940' }, { projectPath: PROJECT, by: '@user', role: 'user', agent: null })
  const retested = await rig.card('T-940')
  const starts = taskAgents.calls.filter((call) => call.kind === 'startTester' && call.taskId === 'T-940')
  const sweep = await rig.api.autoMergePending(PROJECT)
  const afterSweep = await rig.card('T-940')

  check('T-223 a baseline retest starts ONE tester through the coordinator and records it', () => {
    assert.equal(merged.ok, true, JSON.stringify(merged).slice(0, 900))
    assert.equal(merged.retest, true, JSON.stringify({ retest: merged.retest, stage: merged.stage }))
    assert.equal(calls.filter((call) => call.kind === 'mergeCandidate').length, 1)
    assert.equal(starts.length, 1, 'startTester calls: ' + JSON.stringify(starts.map((call) => call.agentId)))
    assert.equal(retested.test.status, 'pending')
    assert.equal(retested.test.deliveredTo.id, starts[0].agentId, 'the retest tester is not recorded on the card')
    assert.equal(retested.test.deliveredTo.generation, 1, 'the retest delivery has no generation')
    assert.equal(taskAgents.live.has(starts[0].agentId), true, 'the retest tester is not live')
  })
  check('T-223 a later recovery pass reuses the retest tester instead of spawning a second', () => {
    assert.equal(sweep.ok, true, JSON.stringify(sweep).slice(0, 700))
    assert.equal(taskAgents.calls.filter((call) => call.kind === 'startTester' && call.taskId === 'T-940').length, 1, 'the recovery pass started a second tester')
    assert.equal(Array.from(taskAgents.live).filter((id) => String(id).indexOf('tester-') === 0).length, 1, JSON.stringify(Array.from(taskAgents.live)))
    assert.equal(afterSweep.test.deliveredTo.id, retested.test.deliveredTo.id, 'the recorded tester moved on its own')
  })
  rig.scheduler.dispose()
}

const failedChecks = checks.filter((row) => !row.ok)
for (const row of checks) {
  console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
}
console.log(String(checks.length - failedChecks.length) + '/' + String(checks.length) + ' checks passed')
rig.scheduler.dispose()
process.exit(failedChecks.length === 0 ? 0 : 1)
