// T-202: a needs-rebase wait must never be a silent board-field write.
//
// The approveReview candidate-conflict path and the auto-merge rebuild path share
// markWaiting's 'needs a person' announcement: an activity entry, a notice to the
// implementer AND to the owning root Session / Lead, the T-198 merge-conflict
// event, and an onboard attention item. The owner notice is exercised through a
// FACADE-FAITHFUL fake: plugin/task-center/index.mjs refuses a send without
// options.rootId, and the DSH subagent service refuses a message whose target is
// the sender itself - so a plain 'it recorded a call' fake would have hidden the
// T-202 defect. An automatically rebuilt candidate-stale stays silent.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createState } from '../../plugin/task-center/state.mjs'
import { createActivity, createDispatcher } from '../../plugin/task-center/dispatch.mjs'
import { createApi } from '../../plugin/task-center/api.mjs'
import { createFakeFs, createFakeGit, createFakeTaskAgents, createStrictCtx, PROJECT, seedBoard } from './support/fixtures.mjs'

const checks = []
function check(name, fn) {
  try {
    fn()
    checks.push({ name: name, ok: true })
  } catch (error) {
    checks.push({ name: name, ok: false, error: error })
  }
}
function checkEqual(actual, expected, label) {
  assert.equal(actual, expected, label + ' -> ' + String(actual))
}

const STAMP = '2026-11-20T00:00:00.000Z'
const ROOT = 'session-lead'
const HEX = (char) => char.repeat(40)
/**
 * The production Agent facade, reduced to its two hard rules:
 *   - plugin/task-center/index.mjs:217-221 requires options.rootId, otherwise it
 *     throws agent-runtime-unavailable before the service is reached;
 *   - the DSH subagent service refuses sender.id === targetId
 *     ('send_message requires another agent in the subagent tree'), and the plugin
 *     always sends AS the card owner's root.
 * Every delivery attempt is recorded, so a test can prove the attempt carried the
 * owning root scope even when the service then refuses the self-target.
 */
function createFacadeFaithfulAgents() {
  const agents = createFakeTaskAgents()
  const attempts = []
  const deliverableRoots = new Set([ROOT])
  agents.attempts = attempts
  agents.send = async function (agentId, text, sendOptions) {
    const rootId = sendOptions !== undefined && sendOptions !== null && typeof sendOptions.rootId === 'string' ? sendOptions.rootId : null
    attempts.push({ agentId: String(agentId), rootId: rootId, text: text })
    if (rootId === null || deliverableRoots.has(rootId) !== true) {
      throw Object.assign(new Error('no root Agent for send target ' + String(agentId)), { code: 'agent-runtime-unavailable' })
    }
    if (String(agentId) === rootId) {
      throw Object.assign(new Error('send_message requires another agent in the subagent tree'), { code: 'UNAUTHORIZED' })
    }
    agents.calls.push({ kind: 'send', agentId: String(agentId), text: text })
    return { ok: true }
  }
  return agents
}

function createRig(options) {
  const opts = options === undefined ? {} : options
  const project = PROJECT
  const fs = createFakeFs()
  fs.dirs.add(project)
  fs.dirs.add(join(project, '.git'))
  fs.dirs.add(join(project, '.agents'))
  fs.dirs.add(join(project, '.worktrees'))
  const taskAgents = opts.taskAgents === undefined ? createFacadeFaithfulAgents() : opts.taskAgents
  const git = opts.git === undefined ? createFakeGit() : opts.git
  const activity = createActivity({})
  const ctx = createStrictCtx(
    {
      fs: fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: project }) },
      get(key) {
        if (key === 'agents') return { list: () => [{ id: ROOT }] }
        if (key === 'subagents') return { list: () => ['spawn'] }
        return undefined
      },
    },
    ['fs', 'sandboxPolicy', 'tools', 'webServer'],
  )
  const state = createState(ctx, { sessionLookup: null })
  state.setSessionRoot(ROOT, project)
  const scheduler = createDispatcher(ctx, {
    state: state,
    projectPath: () => project,
    allowSpawn: true,
    git: git,
    taskAgents: taskAgents,
    activity: activity,
  })
  const api = createApi(ctx, {
    state: state,
    scheduler: scheduler,
    git: git,
    merger: opts.merger,
    taskAgents: taskAgents,
    activity: activity,
    autoMerge: opts.autoMerge === true,
  })
  const rig = {
    project: project,
    fs: fs,
    taskAgents: taskAgents,
    git: git,
    activity: activity,
    state: state,
    scheduler: scheduler,
    api: api,
    user: { projectPath: project, by: '@user', role: 'user', agent: null, sessionId: ROOT },
    action(name, body) {
      return api.perform(name, body === undefined ? {} : body, rig.user)
    },
    settle() {
      return scheduler.settle(project)
    },
    boardTask(id) {
      return rig.action('board', { view: 'full' }).then((snap) => {
        assert.equal(snap.ok, true, JSON.stringify(snap).slice(0, 400))
        return snap.tasks.filter((entry) => entry.id === id)[0]
      })
    },
    pendingDecisions() {
      return api.decisions.pending(project).then((pending) => (pending.ok === true ? pending.pending : []))
    },
  }
  if (opts.board !== undefined && opts.board !== null) seedBoard(fs, project, JSON.stringify(opts.board))
  return rig
}

function performAs(rig, agentId, name, action, payload) {
  return rig.api.perform(action, payload, { projectPath: rig.project, by: '@' + name, role: 'agent', agent: { id: agentId, name: name } })
}

function activityEntries(rig) {
  return rig.activity.snapshot().entries
}

function hasActivity(rig, kind, taskId) {
  return activityEntries(rig).some((entry) => entry.kind === kind && entry.taskId === taskId)
}

function ownerAttempts(rig) {
  const attempts = Array.isArray(rig.taskAgents.attempts) ? rig.taskAgents.attempts : []
  return attempts.filter((entry) => entry.agentId === ROOT)
}

function implementerSends(rig, sessionId) {
  return rig.taskAgents.calls.filter((call) => call.kind === 'send' && call.agentId === sessionId)
}

/** The review record an approving reviewer hands over (T-191). */
function reviewRecord() {
  return {
    checked: [{ criterion: 'the branch is rebased on the target head', method: 'read the diff', result: 'pass' }],
    findings: [],
    residualRisks: [],
  }
}

/** A task whose stage is started, submitted and waiting for its reviewer. */
async function reviewReadyCard(rig, title) {
  const created = await rig.action('create', {
    title: title,
    writeFiles: [],
    acceptance: '- the candidate is reviewed',
    verification: { probes: [{ id: 'probe-a', command: 'node --test scripts/a.test.mjs' }] },
  })
  assert.equal(created.ok, true, JSON.stringify(created).slice(0, 600))
  const id = created.task.id
  const started = await rig.action('start')
  assert.equal(started.ok, true, JSON.stringify(started).slice(0, 400))
  await rig.settle()
  const submitted = await rig.action('submit', { id: id, evidence: 'ready for review' })
  assert.equal(submitted.ok, true, JSON.stringify(submitted).slice(0, 600))
  const card = await rig.boardTask(id)
  const reviewerId = card.review.deliveredTo.id
  return { id: id, card: card, reviewerId: reviewerId }
}

/** A merger that always reports a candidate conflict (the needs-rebase trigger). */
function conflictMerger() {
  return {
    async createCandidate() {
      return { ok: false, code: 'candidate-conflict', message: 'conflict while rebuilding', conflict: 'a.gd' }
    },
    async discardCandidate() {
      return { ok: true }
    },
  }
}

// 1. approveReview: candidate conflict on a branch behind the target
{
  const taskAgents = createFacadeFaithfulAgents()
  const git = createFakeGit()
  // The branch does NOT contain the target head: an automatic rebuild can never
  // succeed, so the host must say 'rebase' on the FIRST conflict.
  git.isAncestor = async () => ({ ok: true, ancestor: false })
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: conflictMerger() })
  const ready = await reviewReadyCard(rig, 'needs rebase')
  const approved = await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  const card = await rig.boardTask(ready.id)
  const pending = await rig.pendingDecisions()
  const ownerQuestion = pending.filter((decision) => decision.eventKey === 'needs-rebase' && decision.taskId === ready.id)[0]

  check('approveReview refuses needs-rebase instead of approving a behind branch', () => {
    checkEqual(approved.ok, false, 'approveReview outcome')
    checkEqual(approved.code, 'needs-rebase', 'failure code')
    checkEqual(card.status, 'reviewing', 'the card stays in review')
    checkEqual(card.waitingReason, 'needs-rebase', 'waitingReason')
    assert.match(String(approved.message), /rebase/, 'the refusal names the rebase')
  })

  check('the owner/root attempt carries the owning root scope the facade requires', () => {
    const attempts = ownerAttempts(rig)
    assert.ok(attempts.length >= 1, 'no send to the owning root Session was attempted')
    checkEqual(attempts[attempts.length - 1].rootId, ROOT, 'the owner send carried rootId')
  })

  check('the owning root Session/Lead receives a real needs-rebase question', () => {
    assert.ok(ownerQuestion !== undefined, 'no needs-rebase decision was queued: ' + JSON.stringify(pending.map((decision) => decision.eventKey)))
    assert.match(ownerQuestion.id, /^waiting-/)
    checkEqual(ownerQuestion.taskId, ready.id)
    checkEqual(ownerQuestion.status, 'pending')
    // No deadline: a human wait must never resolve itself after 120s.
    checkEqual(ownerQuestion.timeoutAt, null, 'the owner question auto-resolves')
    assert.deepEqual(ownerQuestion.options.map((option) => option.id), ['ack', 'block'])
    assert.match(ownerQuestion.body, new RegExp(ready.id))
    assert.match(ownerQuestion.body, /needs-rebase/)
    assert.match(ownerQuestion.body, /refreshMerge/)
  })

  check('the implementer that owns the branch is told to rebase', () => {
    const worker = card.assignee
    assert.ok(worker !== null && worker !== undefined && typeof worker.session === 'string', 'the reviewing card lost its implementer')
    const notices = implementerSends(rig, worker.session)
    assert.ok(notices.length >= 1, 'the implementer was never told to rebase')
    assert.match(notices[notices.length - 1].text, /refreshMerge/)
  })

  check('the wait is recorded on the activity stream', () => {
    assert.ok(hasActivity(rig, 'needs-human', ready.id), JSON.stringify(activityEntries(rig).filter((entry) => entry.taskId === ready.id)))
  })

  // The panel owns the answer path: acknowledging keeps the card parked exactly
  // as it was (the rebase is a human action, never an automatic transition).
  const answered = await rig.action('decisionAnswer', { decisionId: ownerQuestion.id, option: 'ack' })
  const afterAnswer = await rig.boardTask(ready.id)
  check('answering the owner question acknowledges the wait without moving the card', () => {
    assert.equal(answered.ok, true, JSON.stringify(answered).slice(0, 600))
    checkEqual(answered.applied.action, 'needs-rebase')
    checkEqual(answered.applied.executed, false, 'ack executed a transition')
    checkEqual(afterAnswer.status, 'reviewing', 'the card status')
    checkEqual(afterAnswer.waitingReason, 'needs-rebase', 'waitingReason after ack')
  })

  const onboard = await rig.api.perform('onboard', {}, { projectPath: rig.project, by: '@' + ROOT, role: 'agent', agent: { id: ROOT } })
  check('onboard surfaces the needs-rebase card as attention (not blocked)', () => {
    assert.equal(onboard.ok, true, JSON.stringify(onboard).slice(0, 800))
    const attention = Array.isArray(onboard.onboard.attention) ? onboard.onboard.attention : []
    const entry = attention.filter((item) => item.taskId === ready.id && item.code === 'needs-rebase')[0]
    assert.ok(entry !== undefined, JSON.stringify(attention))
    assert.match(entry.message, /needs-rebase/)
    checkEqual(onboard.onboard.stage, 'attention', 'onboard stage')
  })
  rig.scheduler.dispose()
}

// 2. the T-198 ask policy already owns the queue: no second question
{
  const taskAgents = createFacadeFaithfulAgents()
  const git = createFakeGit()
  git.isAncestor = async () => ({ ok: true, ancestor: false })
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: conflictMerger() })
  const ready = await reviewReadyCard(rig, 'policy ask')
  const policy = await rig.action('decisionPolicy', { scope: 'project', events: { 'merge-conflict': { mode: 'ask' } } })
  assert.equal(policy.ok, true, JSON.stringify(policy).slice(0, 500))
  await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  const pending = await rig.pendingDecisions()
  const conflicts = pending.filter((decision) => decision.eventKey === 'merge-conflict' && decision.taskId === ready.id)
  const duplicate = pending.filter((decision) => decision.eventKey === 'needs-rebase' && decision.taskId === ready.id)
  check('T-198 ask creates the merge-conflict question and no duplicate owner question', () => {
    checkEqual(conflicts.length, 1, 'merge-conflict questions')
    checkEqual(duplicate.length, 0, 'duplicate needs-rebase questions')
  })
  rig.scheduler.dispose()
}

// 3. a silent project policy keeps the owner queue quiet (audit + attention remain)
{
  const taskAgents = createFacadeFaithfulAgents()
  const git = createFakeGit()
  git.isAncestor = async () => ({ ok: true, ancestor: false })
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: conflictMerger() })
  const ready = await reviewReadyCard(rig, 'policy silent')
  await rig.action('decisionPolicy', { scope: 'project', events: { 'merge-conflict': { mode: 'silent' } } })
  await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  const pending = await rig.pendingDecisions()
  check('a silent policy opens no owner question but still records the wait', () => {
    checkEqual(pending.filter((decision) => decision.taskId === ready.id).length, 0, 'questions for the card')
    assert.ok(hasActivity(rig, 'needs-human', ready.id), 'the needs-human activity entry is missing')
  })
  rig.scheduler.dispose()
}

// 4. approveReview: an automatic candidate-stale rebuild stays silent
{
  const taskAgents = createFacadeFaithfulAgents()
  const git = createFakeGit()
  // The branch DOES contain the target head, so the conflict is only stale-base.
  git.isAncestor = async () => ({ ok: true, ancestor: true })
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: conflictMerger() })
  const ready = await reviewReadyCard(rig, 'auto stale')
  const approved = await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  const card = await rig.boardTask(ready.id)
  const pending = await rig.pendingDecisions()

  check('a stale candidate on an up-to-date branch is recorded as candidate-stale', () => {
    checkEqual(approved.ok, false, 'approveReview outcome')
    checkEqual(approved.code, 'candidate-stale', 'failure code')
    checkEqual(card.waitingReason, 'candidate-stale', 'waitingReason')
    checkEqual(card.merge.rebuildAttempts, 1, 'the rebuild attempt is counted')
  })

  check('an automatic candidate-stale rebuild pages nobody', () => {
    checkEqual(ownerAttempts(rig).length, 0, 'owner send attempts')
    checkEqual(pending.filter((decision) => decision.taskId === ready.id).length, 0, 'owner questions')
    assert.equal(hasActivity(rig, 'needs-human', ready.id), false, JSON.stringify(activityEntries(rig).filter((entry) => entry.taskId === ready.id)))
  })

  const onboard = await rig.api.perform('onboard', {}, { projectPath: rig.project, by: '@' + ROOT, role: 'agent', agent: { id: ROOT } })
  check('a candidate-stale card is not a needs-rebase attention item', () => {
    assert.equal(onboard.ok, true, JSON.stringify(onboard).slice(0, 600))
    const attention = Array.isArray(onboard.onboard.attention) ? onboard.onboard.attention : []
    assert.equal(attention.some((item) => item.code === 'needs-rebase'), false, JSON.stringify(attention))
  })
  rig.scheduler.dispose()
}

// 5. the auto-merge rebuild path uses the SAME owner channel
{
  const worktree = join(PROJECT, '.worktrees', 'T-9-1')
  const board = {
    version: 2,
    seq: 2,
    dispatch: { state: 'running' },
    tasks: [
      {
        id: 'T-9',
        title: 'stale merge request',
        status: 'testing',
        kind: 'dev',
        target: 'main',
        base: HEX('a'),
        branch: 'task/T-9-1',
        commit: HEX('b'),
        worktree: worktree,
        ownerSession: ROOT,
        writeFiles: [],
        verification: { probes: [{ id: 'probe-a', command: 'node --test scripts/a.test.mjs' }] },
        review: { status: 'approved', attempt: 1, deliveredTo: null },
        test: { status: 'passed', attempt: 1 },
        merge: { status: 'open', base: HEX('a'), head: HEX('b'), target: 'main', mergeCommit: HEX('b'), actualFiles: [] },
        history: [],
        createdAt: STAMP,
        updatedAt: STAMP,
      },
    ],
  }
  const taskAgents = createFacadeFaithfulAgents()
  const git = createFakeGit({ base: HEX('b') })
  // The target moved (hex base -> new hex head) and the branch is behind.
  git.revParse = async () => ({ ok: true, hash: HEX('c') })
  git.isAncestor = async () => ({ ok: true, ancestor: false })
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: conflictMerger(), autoMerge: true })
  seedBoard(rig.fs, rig.project, JSON.stringify(board))
  const swept = await rig.api.autoMergePending(rig.project)
  const card = await rig.boardTask('T-9')
  const pending = await rig.pendingDecisions()

  check('the auto-merge rebuild records needs-rebase on a behind branch', () => {
    assert.equal(swept.ok, true, JSON.stringify(swept).slice(0, 800))
    checkEqual(card.waitingReason, 'needs-rebase', 'waitingReason')
  })

  check('the auto-merge rebuild opens the same owner question and activity', () => {
    const question = pending.filter((decision) => decision.eventKey === 'needs-rebase' && decision.taskId === 'T-9')[0]
    assert.ok(question !== undefined, JSON.stringify(pending.map((decision) => decision.eventKey)))
    assert.match(question.body, /T-9/)
    assert.match(question.body, /refreshMerge/)
    assert.ok(hasActivity(rig, 'needs-human', 'T-9'), JSON.stringify(activityEntries(rig).filter((entry) => entry.taskId === 'T-9')))
    const attempts = ownerAttempts(rig)
    assert.ok(attempts.length >= 1 && attempts[attempts.length - 1].rootId === ROOT, JSON.stringify(attempts))
  })
  rig.scheduler.dispose()
}

// 6. the same item is announced once, not on every repeated action
{
  const taskAgents = createFacadeFaithfulAgents()
  const git = createFakeGit()
  git.isAncestor = async () => ({ ok: true, ancestor: false })
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: conflictMerger() })
  const ready = await reviewReadyCard(rig, 'repeat rebase')
  await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  const attemptsAfterFirst = ownerAttempts(rig).length
  await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  const pending = await rig.pendingDecisions()
  check('a repeated needs-rebase neither re-pages the owner nor stacks questions', () => {
    checkEqual(ownerAttempts(rig).length, attemptsAfterFirst, 'owner send attempts after the second attempt')
    checkEqual(pending.filter((decision) => decision.taskId === ready.id).length, 1, 'owner questions after the second attempt')
  })
  rig.scheduler.dispose()
}

const failed = checks.filter((row) => row.ok !== true)
for (const row of checks) {
  console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
}
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
