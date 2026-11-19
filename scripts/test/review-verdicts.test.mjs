// T-202: a needs-rebase wait must never be a silent board-field write.
//
// The approveReview candidate-conflict path and the auto-merge rebuild path
// share markWaiting's "needs a person" announcement: an activity entry, a short
// notice to the implementer and the owning root Session (task id, reason, detail,
// next step), the T-198 merge-conflict event (ask -> a real DecisionRequest) and
// an onboard attention item. An automatically rebuilt candidate-stale stays
// silent: it is recovered by the host sweep and must not page a person.

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
 * One session on one project, with the activity ring and the merge sweep the
 * shared fixtures rig does not expose. Everything else mirrors createRig.
 */
function createRig(options) {
  const opts = options === undefined ? {} : options
  const project = PROJECT
  const fs = createFakeFs()
  fs.dirs.add(project)
  fs.dirs.add(join(project, '.git'))
  fs.dirs.add(join(project, '.agents'))
  fs.dirs.add(join(project, '.worktrees'))
  const taskAgents = opts.taskAgents === undefined ? createFakeTaskAgents() : opts.taskAgents
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
      return rig.action('board').then((snap) => {
        assert.equal(snap.ok, true, JSON.stringify(snap).slice(0, 400))
        return snap.tasks.filter((entry) => entry.id === id)[0]
      })
    },
  }
  if (opts.board !== undefined && opts.board !== null) seedBoard(fs, project, JSON.stringify(opts.board))
  return rig
}

function performAs(rig, agentId, name, action, payload) {
  return rig.api.perform(action, payload, { projectPath: rig.project, by: '@' + name, role: 'agent', agent: { id: agentId, name: name } })
}

function sendsTo(rig, agentId) {
  return rig.taskAgents.calls.filter((call) => call.kind === 'send' && call.agentId === agentId)
}

function activityEntries(rig) {
  return rig.activity.snapshot().entries
}

function hasActivity(rig, kind, taskId) {
  return activityEntries(rig).some((entry) => entry.kind === kind && entry.taskId === taskId)
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

// ── 1. approveReview: candidate conflict on a branch behind the target ──────
{
  const taskAgents = createFakeTaskAgents()
  const git = createFakeGit()
  // The branch does NOT contain the target head: an automatic rebuild can never
  // succeed, so the host must say "rebase" on the FIRST conflict.
  git.isAncestor = async () => ({ ok: true, ancestor: false })
  const merger = {
    async createCandidate() {
      return { ok: false, code: 'candidate-conflict', message: 'conflict while rebuilding', conflict: 'a.gd' }
    },
    async discardCandidate() {
      return { ok: true }
    },
  }
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: merger })
  const ready = await reviewReadyCard(rig, 'needs rebase')
  // T-198: this project wants a real question for a merge conflict.
  const policy = await rig.action('decisionPolicy', { scope: 'project', events: { 'merge-conflict': { mode: 'ask' } } })
  assert.equal(policy.ok, true, JSON.stringify(policy).slice(0, 500))
  const approved = await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  const card = await rig.boardTask(ready.id)

  check('approveReview refuses needs-rebase instead of approving a behind branch', () => {
    checkEqual(approved.ok, false, 'approveReview outcome')
    checkEqual(approved.code, 'needs-rebase', 'failure code')
    checkEqual(card.status, 'reviewing', 'the card stays in review')
    checkEqual(card.waitingReason, 'needs-rebase', 'waitingReason')
    assert.match(String(approved.message), /rebase/, 'the refusal names the rebase')
  })

  check('the owner/root Session receives the needs-rebase notice (id, reason, detail, next step)', () => {
    const notices = sendsTo(rig, ROOT)
    assert.ok(notices.length >= 1, 'no message reached the owning root Session')
    const text = notices[notices.length - 1].text
    assert.ok(text.indexOf(ready.id) >= 0, 'the notice does not name the task id: ' + text)
    assert.match(text, /needs-rebase/)
    assert.match(text, /a\.gd/, 'the notice does not carry the conflict detail')
    assert.match(text, /refreshMerge/, 'the notice does not carry the next step')
  })

  check('the implementer that owns the branch is told the same thing', () => {
    const worker = card.assignee
    assert.ok(worker !== null && worker !== undefined && typeof worker.session === 'string', 'the reviewing card lost its implementer')
    const notices = sendsTo(rig, worker.session)
    assert.ok(notices.length >= 1, 'the implementer was never told to rebase')
    assert.match(notices[notices.length - 1].text, /refreshMerge/)
  })

  check('the wait is recorded on the activity stream', () => {
    assert.ok(hasActivity(rig, 'needs-human', ready.id), JSON.stringify(activityEntries(rig).filter((entry) => entry.taskId === ready.id)))
  })

  const pending = await rig.api.decisions.pending(PROJECT)
  check('the merge-conflict question is persisted in the decision queue', () => {
    assert.equal(pending.ok, true, JSON.stringify(pending).slice(0, 600))
    const question = pending.pending.filter((decision) => decision.eventKey === 'merge-conflict' && decision.taskId === ready.id)[0]
    assert.ok(question !== undefined, JSON.stringify(pending.pending.map((decision) => decision.eventKey)))
  })

  // Onboard: a needs-rebase card is an attention item even though it is not blocked.
  const onboard = await rig.api.perform(
    'onboard',
    {},
    { projectPath: rig.project, by: '@' + ROOT, role: 'agent', agent: { id: ROOT } },
  )
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

// ── 2. approveReview: an automatic candidate-stale rebuild stays silent ─────
{
  const taskAgents = createFakeTaskAgents()
  const git = createFakeGit()
  // The branch DOES contain the target head, so the conflict is only stale-base.
  git.isAncestor = async () => ({ ok: true, ancestor: true })
  const merger = {
    async createCandidate() {
      return { ok: false, code: 'candidate-conflict', message: 'conflict while rebuilding', conflict: 'a.gd' }
    },
    async discardCandidate() {
      return { ok: true }
    },
  }
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: merger })
  const ready = await reviewReadyCard(rig, 'auto stale')
  const approved = await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  const card = await rig.boardTask(ready.id)

  check('a stale candidate on an up-to-date branch is recorded as candidate-stale', () => {
    checkEqual(approved.ok, false, 'approveReview outcome')
    checkEqual(approved.code, 'candidate-stale', 'failure code')
    checkEqual(card.waitingReason, 'candidate-stale', 'waitingReason')
    checkEqual(card.merge.rebuildAttempts, 1, 'the rebuild attempt is counted')
  })

  check('an automatic candidate-stale rebuild does NOT page the owner/root', () => {
    assert.equal(sendsTo(rig, ROOT).length, 0, JSON.stringify(sendsTo(rig, ROOT)))
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

// ── 3. the auto-merge rebuild path uses the SAME announcement ──────────────
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
  const taskAgents = createFakeTaskAgents()
  const git = createFakeGit({ base: HEX('b') })
  // The target moved (hex base -> new hex head) and the branch is behind.
  git.revParse = async () => ({ ok: true, hash: HEX('c') })
  git.isAncestor = async () => ({ ok: true, ancestor: false })
  const merger = {
    async createCandidate() {
      return { ok: false, code: 'candidate-conflict', message: 'conflict while rebuilding', conflict: 'b.gd' }
    },
    async discardCandidate() {
      return { ok: true }
    },
  }
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: merger, autoMerge: true, board: undefined })
  seedBoard(rig.fs, rig.project, JSON.stringify(board))
  const swept = await rig.api.autoMergePending(rig.project)
  const card = await rig.boardTask('T-9')

  check('the auto-merge rebuild records needs-rebase on a behind branch', () => {
    assert.equal(swept.ok, true, JSON.stringify(swept).slice(0, 800))
    checkEqual(card.waitingReason, 'needs-rebase', 'waitingReason')
  })

  check('the auto-merge rebuild announces the same owner notice and activity', () => {
    const notices = sendsTo(rig, ROOT)
    assert.ok(notices.length >= 1, 'the rebuild path notified nobody')
    const text = notices[notices.length - 1].text
    assert.ok(text.indexOf('T-9') >= 0, 'the notice does not name the task id: ' + text)
    assert.match(text, /needs-rebase/)
    assert.match(text, /refreshMerge/)
    assert.ok(hasActivity(rig, 'needs-human', 'T-9'), JSON.stringify(activityEntries(rig).filter((entry) => entry.taskId === 'T-9')))
  })
  rig.scheduler.dispose()
}

// ── 4. the same item is announced once, not on every repeated action ───────
{
  const taskAgents = createFakeTaskAgents()
  const git = createFakeGit()
  git.isAncestor = async () => ({ ok: true, ancestor: false })
  const merger = {
    async createCandidate() {
      return { ok: false, code: 'candidate-conflict', message: 'conflict while rebuilding', conflict: 'a.gd' }
    },
    async discardCandidate() {
      return { ok: true }
    },
  }
  const rig = createRig({ taskAgents: taskAgents, git: git, merger: merger })
  const ready = await reviewReadyCard(rig, 'repeat rebase')
  await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  const before = sendsTo(rig, ROOT).length
  await performAs(rig, ready.reviewerId, 'reviewer-x', 'approveReview', Object.assign({ id: ready.id }, reviewRecord()))
  check('a repeated needs-rebase does not page the owner twice with the same sentence', () => {
    checkEqual(sendsTo(rig, ROOT).length, before, 'owner notices after the second attempt')
  })
  rig.scheduler.dispose()
}

const failed = checks.filter((row) => row.ok !== true)
for (const row of checks) {
  console.log((row.ok ? 'PASS' : 'FAIL') + '  ' + row.name + (row.ok ? '' : '\n  ' + String(row.error && row.error.stack ? row.error.stack : row.error)))
}
console.log(String(checks.length - failed.length) + '/' + String(checks.length) + ' checks passed')
process.exit(failed.length === 0 ? 0 : 1)
