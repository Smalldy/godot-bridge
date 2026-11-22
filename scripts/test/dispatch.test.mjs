// Scheduler tests (v3): the subagent edge, typed skips, heartbeat, lease
// reaping, the review/test watchdogs and host restart recovery. The legacy Agent
// Teams roster/pool path is DELETED, so nothing here fabricates a team.

import { join } from 'node:path'
import { readRoleConfig } from '../../plugin/task-center/board.mjs'
import { updateBoard } from '../../plugin/task-center/board.mjs'
import { writePolicyFor } from '../../plugin/task-center/state.mjs'
import { findTask } from '../../plugin/task-center/service.mjs'
import {
  STAGE_BUDGET_MS,
  STAGE_CONTINUE_LIMIT,
  STAGE_EVENTS,
  briefFor,
  createActivity,
  createDispatcher,
  probeDispatch,
  recordStageSlot,
  stageDecisionId,
  stageReminderText,
  stageSlotOf,
  stageTimeoutOptions,
  testerBriefFor,
} from '../../plugin/task-center/dispatch.mjs'
import { createApi, readGodotProjectInfo } from '../../plugin/task-center/api.mjs'
import { createFakeFs, createFakeGit, createFakeTaskAgents, createRig, createTask, sleep, PROJECT } from './support/fixtures.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

async function patchTask(rig, id, change) {
  return updateBoard(
    { fs: rig.fs },
    {
      projectPath: rig.project,
      mutate: (board) => {
        const task = findTask(board, id)
        change(task, board)
        return board
      },
      sandboxPolicy: writePolicyFor(rig.project),
    },
  )
}

async function boardOf(rig) {
  const result = await rig.action('board', { view: 'full' })
  if (result.ok !== true) throw new Error('board failed: ' + JSON.stringify(result))
  return result
}

// ── the subagent edge is the only dispatch path ────────────────────────────
{
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'A' })
  const started = await rig.action('start')
  check('start runs dispatch', started.ok === true && started.dispatch.state === 'running', JSON.stringify(started))
  const snap = await boardOf(rig)
  const claimed = snap.tasks.filter((entry) => entry.id === task.id)[0]
  check('the ready card is claimed by a fresh worker child', claimed.status === 'running' && claimed.assignee !== null && typeof claimed.assignee.session === 'string', JSON.stringify(claimed))
  check('the claim records the runtime Session id', String(claimed.assignee.session).indexOf('worker-') === 0, String(claimed.assignee.session))
  check('the worker was started with a brief that names its worktree', taskAgents.calls.some((call) => call.kind === 'startWorker' && String(call.text).indexOf('worktree') >= 0), JSON.stringify(taskAgents.calls))
  check('the attempt is recorded on the card', claimed.dispatch !== null && claimed.dispatch !== undefined && claimed.dispatch.targetId === claimed.assignee.session)
}

// ── no runtime is a typed skip, never a fabricated team ────────────────────
{
  const rig = createRig()
  const task = await createTask(rig, { title: 'B' })
  await rig.action('start')
  const snap = await boardOf(rig)
  const pending = snap.tasks.filter((entry) => entry.id === task.id)[0]
  check('without the subagent runtime the card stays pending', pending.status === 'pending', pending.status)
  const tick = await rig.settle()
  check('and the tick says why, with a typed code', Array.isArray(tick.results) && tick.results.some((entry) => entry.skipped === 'agent-runtime-unavailable'), JSON.stringify(tick.results))
}

// ── heartbeat renews only a holder the live child tree still lists ─────────
{
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'C' })
  await rig.action('start')
  const snap = await boardOf(rig)
  const claimed = snap.tasks.filter((entry) => entry.id === task.id)[0]
  const agentId = String(claimed.assignee.session)
  // Put the lease inside the heartbeat window, then tick: the live child renews it.
  const before = Date.now()
  await patchTask(rig, task.id, (entry) => {
    entry.leaseUntil = new Date(before + 1000).toISOString()
  })
  await rig.settle()
  let after = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('a live child keeps its lease', Date.parse(after.leaseUntil) > before + 5000, after.leaseUntil)
  // Drop the child from the live tree: the same window now lapses into a handover.
  await rig.action('pause')
  taskAgents.live.delete(agentId)
  await patchTask(rig, task.id, (entry) => {
    entry.leaseUntil = new Date(Date.now() - 1000).toISOString()
  })
  await rig.settle()
  after = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('a gone child lapses into a requeue', after.status === 'pending' && after.assignee === null, JSON.stringify(after))
  check('the handover disposed the stale child', taskAgents.calls.some((call) => call.kind === 'release' && call.agentId === agentId) || taskAgents.calls.some((call) => call.kind === 'releaseTask'), JSON.stringify(taskAgents.calls))
}

// ── T-197: a silent review ASKS the human; nothing is blocked or killed ──────
{
  let clockNow = Date.parse('2026-11-19T00:00:00.000Z')
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ taskAgents: taskAgents, now: () => clockNow })
  const task = await createTask(rig, { title: 'D' })
  await rig.action('start')
  const submitted = await rig.action('submit', { id: task.id, evidence: 'ready' })
  check('submit starts the reviewer child', submitted.ok === true && taskAgents.calls.some((call) => call.kind === 'startReviewer'), JSON.stringify(submitted))
  const reviewing = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  const reviewerId = String(reviewing.review.deliveredTo.id)
  const workersStarted = () => taskAgents.calls.filter((call) => call.kind === 'startWorker').length

  // The reviewer is still EXECUTING a turn (a long pwsh/read/probe run): the
  // tree says "running", so the clock is renewed and an old round timestamp is
  // never mistaken for silence (T-197 requirement 7 — not only task_center calls).
  clockNow += 60 * 60 * 1000
  await rig.settle()
  let pending = await rig.api.decisions.pending(rig.project)
  check('a reviewer that is executing a turn renews the watchdog clock', pending.ok === true && pending.pending.length === 0, JSON.stringify(pending.pending))

  // The turn ended (the child is inactive) and the round has been silent since.
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  await patchTask(rig, task.id, (entry) => {
    entry.review.at = new Date(clockNow - 25 * 60 * 1000).toISOString()
  })
  const roundAt = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0].review.at
  clockNow += 26 * 60 * 1000
  await rig.settle()
  pending = await rig.api.decisions.pending(rig.project)
  const asked = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === STAGE_EVENTS.reviewTimeout)[0] : undefined
  check('a silent review asks the human instead of blocking', asked !== undefined && asked.status === 'pending', JSON.stringify(pending.pending))
  check('the question defaults to continue', asked !== undefined && asked.defaultOption === 'continue', JSON.stringify(asked === undefined ? null : asked.defaultOption))
  check('the question offers continue/replace/block/cancel', asked !== undefined && asked.options.map((option) => option.id).join(',') === 'continue,replace,block,cancel', JSON.stringify(asked === undefined ? null : asked.options.map((option) => option.id)))
  const afterAsk = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('the card stays in review while the question is pending', afterAsk.status === 'reviewing', String(afterAsk.status))
  check('the timeout never disposes the live reviewer', taskAgents.calls.every((call) => !(call.kind === 'releaseTask' || call.kind === 'release') || String(call.agentId === undefined ? '' : call.agentId) !== reviewerId), JSON.stringify(taskAgents.calls.filter((call) => call.kind === 'release' || call.kind === 'releaseTask')))
  await rig.settle()
  const again = await rig.api.decisions.pending(rig.project)
  check('a second tick never stacks a second question', again.ok === true && again.pending.filter((decision) => decision.eventKey === STAGE_EVENTS.reviewTimeout).length === 1)

  // The 120s deadline applies the safe default on the HOST TICK alone: no panel
  // has to be polling for the timeout to default to continue.
  clockNow += 121 * 1000
  await rig.settle()
  const resolved = await rig.api.decisions.list(rig.project, { status: 'all' })
  const expired = resolved.ok === true ? resolved.decisions.filter((decision) => decision.eventKey === STAGE_EVENTS.reviewTimeout && decision.status === 'expired')[0] : undefined
  check('the host tick expires the question through its default', expired !== undefined && expired.resolution.option === 'continue', JSON.stringify(resolved.decisions.map((decision) => ({ event: decision.eventKey, status: decision.status }))))
  const afterContinue = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('continue keeps the card in the same review round', afterContinue.status === 'reviewing' && afterContinue.review.at === roundAt, JSON.stringify({ status: afterContinue.status, at: afterContinue.review.at }))
  check('continue keeps the worktree and never restarts the worker', afterContinue.worktree === reviewing.worktree && workersStarted() === 1, JSON.stringify({ worktree: afterContinue.worktree, workers: workersStarted() }))
  check('the continue is written to the task history', afterContinue.history.some((row) => String(row.note).indexOf('默认继续') >= 0), JSON.stringify(afterContinue.history.map((row) => row.note)))
  await rig.settle()
  const immediate = await rig.api.decisions.pending(rig.project)
  check('the extended slice waits for FRESH silence, not the old total', immediate.ok === true && immediate.pending.filter((decision) => decision.eventKey === STAGE_EVENTS.reviewTimeout).length === 0, JSON.stringify(immediate.pending.map((decision) => decision.eventKey)))
  clockNow += 21 * 60 * 1000
  await rig.settle()
  const second = await rig.api.decisions.pending(rig.project)
  check('the next slice asks again after 20 more silent minutes', second.ok === true && second.pending.filter((decision) => decision.eventKey === STAGE_EVENTS.reviewTimeout).length === 1)
}

// ── T-197: three consecutive DEFAULT continues auto-block, and never re-ask ──
{
  let clockNow = Date.parse('2026-11-19T02:00:00.000Z')
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ taskAgents: taskAgents, now: () => clockNow })
  const task = await createTask(rig, { title: 'L' })
  await rig.action('start')
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  // Let one full slice of silence pass from the last recorded activity.
  clockNow += 26 * 60 * 1000
  const blockedNotes = []
  for (let round = 1; round <= STAGE_CONTINUE_LIMIT; round += 1) {
    await rig.settle()
    const asked = await rig.api.decisions.pending(rig.project)
    const question = asked.ok === true ? asked.pending.filter((decision) => decision.eventKey === STAGE_EVENTS.devTimeout)[0] : undefined
    check('round ' + String(round) + ': the dev timeout asks instead of blocking', question !== undefined && question.options.map((option) => option.id).join(',') === 'continue,retry-dev,cancel,cancel-tree', JSON.stringify(asked.pending.map((decision) => decision.eventKey)))
    clockNow += 121 * 1000
    const listed = await rig.action('decisionList', {})
    check('round ' + String(round) + ': the unanswered question defaults to continue', listed.ok === true && listed.expired.length === 1, JSON.stringify(listed.expired))
    const row = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
    if (round < STAGE_CONTINUE_LIMIT) {
      check('round ' + String(round) + ': the card keeps running with the same worker', row.status === 'running' && row.assignee !== null && taskAgents.calls.filter((call) => call.kind === 'startWorker').length === 1, String(row.status))
      clockNow += 21 * 60 * 1000
    } else {
      blockedNotes.push(...row.history.map((entry) => String(entry.note)))
    }
  }
  const finalRow = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('the third consecutive default continue auto-blocks the card', finalRow.status === 'blocked', String(finalRow.status))
  // T-201: the block is a typed state-machine entry, not a bare status.
  check(
    'the auto-block carries the T-201 typed reason',
    finalRow.blockedReason !== null && finalRow.blockedReason !== undefined && finalRow.blockedReason.code === 'stage-continue-limit' && finalRow.blockedReason.from === 'running' && finalRow.blockedReason.auto === false,
    JSON.stringify(finalRow.blockedReason),
  )
  check('the auto-block is written to the history', blockedNotes.some((note) => note.indexOf('连续 ' + String(STAGE_CONTINUE_LIMIT) + ' 次') >= 0), JSON.stringify(blockedNotes))
  await rig.settle()
  const afterBlock = await rig.api.decisions.pending(rig.project)
  check('a blocked card is not asked again', afterBlock.ok === true && afterBlock.pending.filter((decision) => decision.eventKey === STAGE_EVENTS.devTimeout).length === 0, JSON.stringify(afterBlock.pending.map((decision) => decision.eventKey)))
}

// ── T-197: reminder/grace are one line and re-read the board before sending ──
{
  let clockNow = Date.parse('2026-11-19T04:00:00.000Z')
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ taskAgents: taskAgents, now: () => clockNow })
  const task = await createTask(rig, { title: 'E' })
  await rig.action('start')
  await rig.action('submit', { id: task.id, evidence: 'ready' })
  taskAgents.listAgentsFor = async () => Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  const reviewAt = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0].review.at
  clockNow = Date.parse(reviewAt) + 11 * 60 * 1000
  await rig.settle()
  const sends = taskAgents.calls.filter((call) => call.kind === 'send')
  check('eleven silent minutes sends exactly one reminder', sends.length === 1, JSON.stringify(sends))
  const text = sends.length === 0 ? '' : String(sends[0].text)
  check('the reminder is ONE line', text.indexOf('\n') < 0, JSON.stringify(text))
  check('the reminder names id/title/stage/waited/verdict/deadline', text.indexOf(task.id) >= 0 && text.indexOf('E') >= 0 && text.indexOf('review') >= 0 && text.indexOf('11m') >= 0 && text.indexOf('approveReview or requestChanges') >= 0 && text.indexOf('9m') >= 0, text)
  check('the reminder is explicitly non-authoritative', text.indexOf('Non-authoritative') >= 0 && text.indexOf('ignore this message') >= 0, text)
  check('the reminder never carries the reviewer brief', text.indexOf('Stage contract') < 0 && text.indexOf('Candidate artifact') < 0 && text.indexOf('Review round') < 0 && text.length < 400, text)

  // A verdict lands between the sweep's snapshot and the send: the host re-reads
  // the board and sends nothing at all.
  const before = taskAgents.calls.filter((call) => call.kind === 'send').length
  taskAgents.listAgentsFor = async () => {
    await updateBoard(
      { fs: rig.fs },
      {
        projectPath: rig.project,
        mutate: (board) => {
          const row = findTask(board, task.id)
          if (row.status === 'reviewing' && row.review !== null && row.review.status === 'pending') {
            row.status = 'testing'
            row.review = Object.assign({}, row.review, { status: 'approved' })
            row.test = { status: 'pending', by: null, byName: null, at: new Date(clockNow).toISOString(), evidence: null, attempt: 1 }
          }
          return board
        },
        sandboxPolicy: writePolicyFor(rig.project),
      },
    )
    return Array.from(taskAgents.live).map((id) => ({ kind: 'child', id: id, name: id, activity: 'inactive' }))
  }
  clockNow += 7 * 60 * 1000
  await rig.settle()
  check('a verdict that landed before the send suppresses the nudge', taskAgents.calls.filter((call) => call.kind === 'send').length === before, JSON.stringify(taskAgents.calls.filter((call) => call.kind === 'send')))
}

// ── T-197 event 10: worker lost is notify-only, then escalates to an ask ─────
{
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'G' })
  const loseWorker = async () => {
    await rig.action('start')
    await patchTask(rig, task.id, (entry) => {
      entry.dispatch = Object.assign({}, entry.dispatch, { host: 'another-boot' })
    })
    await rig.settle()
  }
  await loseWorker()
  let row = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  let pending = await rig.api.decisions.pending(rig.project)
  check('a host restart is re-dispatched WITHOUT a modal', row.status === 'running' && pending.pending.length === 0, JSON.stringify({ status: row.status, pending: pending.pending.map((decision) => decision.eventKey) }))
  check('the automatic recovery is written to the task history', row.history.some((entry) => String(entry.note).indexOf('已自动处置') >= 0), JSON.stringify(row.history.map((entry) => entry.note)))
  check('the recovery names the event it auto-handled', row.history.some((entry) => String(entry.note).indexOf('worker-lost') >= 0), JSON.stringify(row.history.map((entry) => entry.note)))
  await loseWorker()
  row = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  pending = await rig.api.decisions.pending(rig.project)
  check('the second recovery is still notify-only', row.status === 'running' && pending.pending.length === 0, JSON.stringify(pending.pending.map((decision) => decision.eventKey)))
  await loseWorker()
  pending = await rig.api.decisions.pending(rig.project)
  const escalated = pending.ok === true ? pending.pending.filter((decision) => decision.eventKey === STAGE_EVENTS.workerLost)[0] : undefined
  check('a third failed auto-recovery escalates to an ask', escalated !== undefined, JSON.stringify(pending.pending.map((decision) => decision.eventKey)))
  check('the escalation asks the human with a safe default', escalated !== undefined && escalated.defaultOption === 'continue', JSON.stringify(escalated === undefined ? null : escalated.defaultOption))
}

// ── T-197: the pure copy helpers stay one line and bounded ──────────────────
{
  const reminder = stageReminderText({ taskId: 'T-9', title: 'copy', stage: 'test', waitedMs: 12 * 60 * 1000, untilMs: 8 * 60 * 1000, grace: false })
  check('the reminder text is a single bounded line', reminder.indexOf('\n') < 0 && reminder.length < 400, reminder)
  check('the reminder names the test verdict it needs', reminder.indexOf('passTest or failTest') >= 0 && reminder.indexOf('Non-authoritative') >= 0, reminder)
  const grace = stageReminderText({ taskId: 'T-9', title: 'copy', stage: 'review', waitedMs: 18 * 60 * 1000, untilMs: 2 * 60 * 1000, grace: true })
  check('the grace text asks for a verdict before the deadline', grace.indexOf('host asks the human in 2m') >= 0, grace)
  const devOptions = stageTimeoutOptions('dev')
  check('the dev question marks the retry as destructive', devOptions.filter((option) => option.id === 'retry-dev')[0].danger === true)
  check('the review question defaults to continue', stageTimeoutOptions('review').filter((option) => option.default === true)[0].id === 'continue')
  check('the decision id is stable per round and slice', stageDecisionId('T-9', STAGE_EVENTS.testTimeout, 1000, 2) === 'stage-T-9-test-timeout-1000-2')
  check('the stage budget is the packet 20 minutes', STAGE_BUDGET_MS === 20 * 60 * 1000)
}

// ── stage slots and briefs remain pure bookkeeping ────────────────────────
{
  const slotCtx = {}
  recordStageSlot(slotCtx, 'T-1', 'reviewer', 100, null)
  check('stage slot bookkeeping is keyed by card and role', stageSlotOf(slotCtx, 'T-1', 'reviewer') !== null)
  recordStageSlot(slotCtx, 'T-1', 'reviewer', null, null)
  check('a cleared slot is forgotten', stageSlotOf(slotCtx, 'T-1', 'reviewer') === null)
  const brief = briefFor(
    { id: 'T-1', title: 'brief', spec: 's', acceptance: 'a', writeFiles: [], dependsOn: [], kind: 'dev', status: 'pending', priority: 0, target: null },
    PROJECT,
    'lead',
    null,
  )
  check('the implement brief still renders', typeof brief === 'string' && brief.length > 0)
}

// ── the diagnostics probe reports the subagent edge, not a roster ──────────
{
  const report = probeDispatch({ get: () => undefined })
  check('probeDispatch reports the absent subagent service by code', report.available === false && report.error === 'no-subagent-service', JSON.stringify(report))
  const present = probeDispatch({ get: (key) => (key === 'subagents' ? { list: () => ['spawn'] } : undefined) })
  check('probeDispatch lists the registered subagent providers', present.available === true && present.subagentProviders[0] === 'spawn', JSON.stringify(present))
}

// ── host restart: a claim from another boot is requeued, not lost ─────────
{
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'F' })
  await rig.action('start')
  await rig.action('pause')
  await patchTask(rig, task.id, (entry) => {
    entry.dispatch = Object.assign({}, entry.dispatch, { host: 'another-boot' })
  })
  await rig.settle()
  const after = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('a claim from another host process is requeued', after.status === 'pending', after.status)
  check('its attempt is refunded', after.attempts <= 1, String(after.attempts))
}

// ── T-199: a project without a main scene is never launched by the tester ───
{
  const task = {
    id: 'T-199',
    title: 'brief shapes',
    status: 'testing',
    target: 'main',
    spec: 'the tester brief must respect the Godot main scene',
    acceptance: 'no project launch without a main scene',
    evidence: 'worker evidence',
    writeFiles: ['plugin/a.mjs'],
    actualFiles: ['plugin/a.mjs'],
    branch: 'task/T-199-1',
    worktree: join(PROJECT, '.worktrees', 'T-199-1'),
    base: 'base-sha',
    commit: 'head-sha',
    review: null,
    test: { status: 'pending', attempt: 1 },
    merge: { status: 'open', base: 'base-sha', target: 'main', mergeCommit: 'head-sha', artifact: null },
    verify: null,
  }
  const candidate = { path: join(PROJECT, '.worktrees', 'test-T-199'), branch: 'test/T-199', base: 'base-sha', head: 'head-sha' }

  // The repo-root project.godot shape: an [application] section without run/main_scene.
  const noSceneText = [
    '; Minimal project so the headless guard test can be run.',
    'config_version=5',
    '',
    '[application]',
    '',
    'config/name="godot-bridge tests"',
    'config/features=PackedStringArray("4.4")',
    '',
  ].join('\n')
  const noSceneFs = createFakeFs()
  noSceneFs.files.set(join(PROJECT, 'project.godot'), { text: noSceneText, version: 'seed' })
  const noScene = await readGodotProjectInfo(noSceneFs, null, PROJECT, null)
  check(
    'godotInfoFor detects a Godot project without a main scene',
    noScene.project === true && noScene.hasMainScene === false && noScene.mainScene === null,
    JSON.stringify(noScene),
  )
  const noSceneBrief = testerBriefFor(task, PROJECT, candidate, { godot: noScene })
  check('a no-main-scene brief never offers godot_run_project', noSceneBrief.indexOf('godot_run_project') < 0, noSceneBrief)
  check('a no-main-scene brief never offers a project-level headless run', noSceneBrief.indexOf('quit_after: 120') < 0, noSceneBrief)
  check(
    'a no-main-scene brief says not to start the project and names the native error',
    noSceneBrief.indexOf('Do NOT start the project') >= 0 && noSceneBrief.indexOf('Can not run project: no main scene defined') >= 0,
    noSceneBrief,
  )
  check(
    'a no-main-scene brief tells the tester how to supply a concrete scene/script',
    noSceneBrief.indexOf('scene: "<the task scene') >= 0 && noSceneBrief.indexOf('script: "<the task script') >= 0,
    noSceneBrief,
  )
  check(
    'a no-main-scene brief still keeps Godot errors visible and forbids the pwsh/bash channel',
    noSceneBrief.indexOf('keep Godot errors visible') >= 0 && noSceneBrief.indexOf('Never launch Godot through pwsh/bash') >= 0,
    noSceneBrief,
  )

  // A project.godot WITH a main scene keeps the project-level launch guidance.
  const sceneText = '[application]\n\nconfig/name="game"\nrun/main_scene="res://scenes/main.tscn"\n'
  const sceneFs = createFakeFs()
  sceneFs.files.set(join(PROJECT, 'project.godot'), { text: sceneText, version: 'seed' })
  const withScene = await readGodotProjectInfo(sceneFs, null, PROJECT, null)
  check(
    'godotInfoFor reads the declared main scene',
    withScene.project === true && withScene.hasMainScene === true && withScene.mainScene === 'res://scenes/main.tscn',
    JSON.stringify(withScene),
  )
  const withSceneBrief = testerBriefFor(task, PROJECT, candidate, { godot: withScene })
  check(
    'a main-scene brief keeps godot_run_project for the candidate',
    withSceneBrief.indexOf('godot_run_project({ project_path: "' + candidate.path + '" })') >= 0,
    withSceneBrief,
  )
  check(
    'a main-scene brief keeps the project-level headless run',
    withSceneBrief.indexOf('godot_run_headless({ project_path: "' + candidate.path + '", quit_after: 120 })') >= 0,
    withSceneBrief,
  )
  check(
    'a main-scene brief names the main scene it will run',
    withSceneBrief.indexOf('Main scene ([application] run/main_scene): res://scenes/main.tscn') >= 0,
    withSceneBrief,
  )

  // The CANDIDATE checkout is the source of truth for the brief it feeds.
  const bothFs = createFakeFs()
  bothFs.files.set(join(PROJECT, 'project.godot'), { text: sceneText, version: 'seed' })
  bothFs.files.set(join(candidate.path, 'project.godot'), { text: noSceneText, version: 'seed' })
  const both = await readGodotProjectInfo(bothFs, null, PROJECT, candidate.path)
  check(
    'the candidate project.godot wins over the project root',
    both.projectFile === join(candidate.path, 'project.godot') && both.hasMainScene === false,
    JSON.stringify(both),
  )
}
// ── T-204: a card has at most ONE live reviewer and ONE live tester ─────────
// The fake task-agent facade above is memory-only; these checks need the REAL
// task-agents lifecycle (records + receipts + the live tree), so they run a
// production-shaped facade over a fake subagent service.
{
  const { agentNameFor, createTaskAgents } = await import('../../plugin/task-center/task-agents.mjs')
  const { createAgentRuntime } = await import('../../plugin/task-center/agent-runtime.mjs')
  function createLiveTaskAgents() {
    // The card's ownerSession is the rig's panel session, so the root Agent id
    // is that session id — exactly how the production registry resolves it.
    const root = { id: 'session-lead', name: 'lead' }
    // T-204 review: DSH's subagent catalog is APPEND-ONLY — a disposed child stays
    // a kind:'child' row with activity:'inactive'. The fake models that, so a test
    // can never mistake catalog membership for a running child.
    const world = { catalog: new Map(), running: new Set(), inactive: new Set(), disposed: [], interrupted: [], spawns: [] }
    let sequence = 0
    const subagents = {
      async startActivation(spec) {
        sequence += 1
        const id = 'child-' + String(sequence)
        world.spawns.push(spec)
        world.catalog.set(id, spec.name)
        world.running.add(id)
        return {
          childId: id,
          name: spec.name,
          result: Promise.resolve({ output: [] }),
          dispose: async () => {
            world.disposed.push(id)
            world.running.delete(id)
            world.inactive.add(id)
          },
        }
      },
      async sendMessage() {
        return 'message'
      },
      interrupt(id) {
        const key = String(id)
        world.interrupted.push(key)
        world.running.delete(key)
        world.inactive.add(key)
      },
      async listDescendants() {
        return Array.from(world.catalog.entries()).map(([id, name]) => ({
          kind: 'child',
          id: id,
          name: name,
          parentId: root.id,
          depth: 1,
          activity: world.running.has(id) ? 'running' : 'inactive',
          mode: 'continuable',
        }))
      },
      rootOf() {
        return root
      },
      namesOf() {
        return { self: 'lead' }
      },
    }
    const runtime = createAgentRuntime({ agent: root, get(name) { return name === 'subagents' ? subagents : undefined } })
    const agents = createTaskAgents({ runtime: runtime })
    return {
      available: true,
      root: root,
      rootId: root.id,
      runtime: runtime,
      world: world,
      startWorker(task, prompt) {
        return agents.startWorker(task, prompt)
      },
      startReviewer(task, prompt) {
        return agents.startReviewer(task, prompt)
      },
      startTester(task, prompt) {
        return agents.startTester(task, prompt)
      },
      send(id, text) {
        return agents.send(id, text)
      },
      release(id) {
        return agents.release(id)
      },
      releaseTask(task, options) {
        return agents.releaseTask(task, options)
      },
      listFor() {
        return runtime.list()
      },
      listAgentsFor() {
        return runtime.list()
      },
      taskAgentsFor() {
        return agents
      },
      rootFor() {
        return root
      },
    }
  }
  const isRunning = (world, id) => world.running.has(String(id))
  const runningReviewers = (world) =>
    Array.from(world.catalog.entries()).filter(([id, name]) => String(name).indexOf('reviewer-') === 0 && world.running.has(id))

  {
    const liveAgents = createLiveTaskAgents()
    const heads = {}
    const git = createFakeGit({ heads: heads })
    const rig = createRig({ git: git, taskAgents: liveAgents })
    const card = await createTask(rig, { title: 'two refreshes' })
    await rig.action('start')
    await rig.settle()
    const submitted = await rig.action('submit', { id: card.id, evidence: 'ready for review' })
    const snapshot = async () => {
      const snap = await rig.action('board', { view: 'full' })
      return snap.tasks.filter((entry) => entry.id === card.id)[0]
    }
    const afterSubmit = await snapshot()
    const firstReviewer = String(afterSubmit.review.deliveredTo.id)
    check(
      'T-204 the reviewer started by submit is live',
      submitted.ok === true && isRunning(liveAgents.world, firstReviewer),
      JSON.stringify({ ok: submitted.ok, running: Array.from(liveAgents.world.running) }),
    )
    heads[afterSubmit.worktree] = 'head-2'
    const once = await rig.action('refreshMerge', { id: card.id })
    const afterFirst = await snapshot()
    const secondReviewer = String(afterFirst.review.deliveredTo.id)
    heads[afterFirst.worktree] = 'head-3'
    const twice = await rig.action('refreshMerge', { id: card.id })
    const afterSecond = await snapshot()
    const lastReviewer = String(afterSecond.review.deliveredTo.id)
    const running = runningReviewers(liveAgents.world)
    check(
      'T-204 two consecutive refreshMerge calls leave exactly ONE running reviewer',
      once.ok === true && twice.ok === true && lastReviewer !== firstReviewer && lastReviewer !== secondReviewer && running.length === 1 && running[0][0] === lastReviewer,
      JSON.stringify({ once: once.ok, twice: twice.ok, running: running, last: lastReviewer, first: firstReviewer, second: secondReviewer }),
    )
    // The append-only catalog keeps every disposed child as an inactive row: the
    // refresh must not read that residue as "still running" (the round-1 bug).
    check(
      'T-204 the disposed reviewers stay catalog rows but are NOT running',
      liveAgents.world.catalog.has(firstReviewer) &&
        liveAgents.world.catalog.has(secondReviewer) &&
        liveAgents.world.inactive.has(firstReviewer) &&
        liveAgents.world.inactive.has(secondReviewer) &&
        isRunning(liveAgents.world, firstReviewer) === false &&
        isRunning(liveAgents.world, secondReviewer) === false,
      JSON.stringify({ disposed: liveAgents.world.disposed, interrupted: liveAgents.world.interrupted, catalog: Array.from(liveAgents.world.catalog.keys()) }),
    )
    // The old reviewer's late verdict is still refused by the role gate, even
    // though its child has been stopped.
    const stale = await rig.api.perform(
      'approveReview',
      { id: card.id, checked: [{ criterion: 'the diff is right', method: 'read it', result: 'pass' }], findings: [], residualRisks: [] },
      { projectPath: rig.project, by: '@reviewer-old', role: 'agent', agent: { id: firstReviewer, name: 'reviewer-old' } },
    )
    check(
      'T-204 a replaced reviewer\'s late verdict is still refused as role-required',
      stale.ok === false && stale.code === 'role-required',
      JSON.stringify(stale).slice(0, 300),
    )
    rig.scheduler.dispose()
  }

  {
    const liveAgents = createLiveTaskAgents()
    const git = createFakeGit({})
    const rig = createRig({ git: git, taskAgents: liveAgents })
    const card = await createTask(rig, { title: 'reopen releases the roster' })
    await rig.action('start')
    await rig.settle()
    await rig.action('submit', { id: card.id, evidence: 'ready for review' })
    const snapshot = async () => {
      const snap = await rig.action('board', { view: 'full' })
      return snap.tasks.filter((entry) => entry.id === card.id)[0]
    }
    const row = await snapshot()
    const recorded = String(row.review.deliveredTo.id)
    // The T-201 leak: a second reviewer runs while the board record only names
    // the newest one, so the roster has no id left to release it by.
    const strayName = agentNameFor('reviewer', card.id, 'abc12345')
    const stray = await liveAgents.runtime.spawn({ role: 'reviewer', taskId: card.id, name: strayName, prompt: 'stray review' })
    check(
      'T-204 the leaked reviewer is running before the reopen',
      isRunning(liveAgents.world, recorded) && isRunning(liveAgents.world, stray.agentId) && runningReviewers(liveAgents.world).length === 2,
      JSON.stringify({ running: Array.from(liveAgents.world.running), catalog: Array.from(liveAgents.world.catalog.keys()) }),
    )
    await patchTask(rig, card.id, (entry) => {
      entry.status = 'done'
    })
    const reopened = await rig.action('reopen', { id: card.id })
    const after = await snapshot()
    const stillRunning = runningReviewers(liveAgents.world)
    check(
      'T-204 a reopen stops the old reviewer AND a leaked reviewer the record never named',
      reopened.ok === true &&
        liveAgents.world.disposed.indexOf(recorded) >= 0 &&
        liveAgents.world.interrupted.indexOf(String(stray.agentId)) >= 0 &&
        stillRunning.length === 0 &&
        liveAgents.world.catalog.has(recorded) &&
        liveAgents.world.catalog.has(String(stray.agentId)) &&
        after.status === 'pending',
      JSON.stringify({ reopened: reopened.ok, disposed: liveAgents.world.disposed, interrupted: liveAgents.world.interrupted, stillRunning: stillRunning, status: after.status }),
    )
    rig.scheduler.dispose()
  }
}

console.log(failures === 0 ? '\nPASS  dispatch (v3 subagent edge)' : '\nFAIL  ' + String(failures) + ' dispatch check(s)')
process.exit(failures === 0 ? 0 : 1)
