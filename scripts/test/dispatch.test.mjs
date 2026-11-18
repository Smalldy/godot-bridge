// Scheduler tests (v3): the subagent edge, typed skips, heartbeat, lease
// reaping, the review/test watchdogs and host restart recovery. The legacy Agent
// Teams roster/pool path is DELETED, so nothing here fabricates a team.

import { join } from 'node:path'
import { readRoleConfig } from '../../plugin/task-center/board.mjs'
import { updateBoard } from '../../plugin/task-center/board.mjs'
import { writePolicyFor } from '../../plugin/task-center/state.mjs'
import { findTask } from '../../plugin/task-center/service.mjs'
import { briefFor, createActivity, createDispatcher, probeDispatch, recordStageSlot, stageSlotOf } from '../../plugin/task-center/dispatch.mjs'
import { createApi } from '../../plugin/task-center/api.mjs'
import { createFakeTaskAgents, createRig, createTask, sleep, PROJECT } from './support/fixtures.mjs'

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
  const result = await rig.action('board')
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
  const tick = await rig.scheduler.tick(rig.project)
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
  await rig.scheduler.tick(rig.project)
  let after = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('a live child keeps its lease', Date.parse(after.leaseUntil) > before + 5000, after.leaseUntil)
  // Drop the child from the live tree: the same window now lapses into a handover.
  await rig.action('pause')
  taskAgents.live.delete(agentId)
  await patchTask(rig, task.id, (entry) => {
    entry.leaseUntil = new Date(Date.now() - 1000).toISOString()
  })
  await rig.scheduler.tick(rig.project)
  after = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('a gone child lapses into a requeue', after.status === 'pending' && after.assignee === null, JSON.stringify(after))
  check('the handover disposed the stale child', taskAgents.calls.some((call) => call.kind === 'release' && call.agentId === agentId) || taskAgents.calls.some((call) => call.kind === 'releaseTask'), JSON.stringify(taskAgents.calls))
}

// ── the review watchdog blocks a silent round and disposes the reviewer ────
{
  const taskAgents = createFakeTaskAgents()
  const rig = createRig({ taskAgents: taskAgents })
  const task = await createTask(rig, { title: 'D' })
  await rig.action('start')
  const submitted = await rig.action('submit', { id: task.id, evidence: 'ready' })
  check('submit starts the reviewer child', submitted.ok === true && taskAgents.calls.some((call) => call.kind === 'startReviewer'), JSON.stringify(submitted))
  const snap = await boardOf(rig)
  const reviewing = snap.tasks.filter((entry) => entry.id === task.id)[0]
  check('the card records the reviewer Session id', reviewing.review !== null && reviewing.review.deliveredTo !== null && typeof reviewing.review.deliveredTo.id === 'string', JSON.stringify(reviewing.review))
  const reviewerId = String(reviewing.review.deliveredTo.id)
  await patchTask(rig, task.id, (entry) => {
    entry.review.at = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  })
  await rig.scheduler.tick(rig.project)
  const blocked = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('a silent review is blocked for triage', blocked.status === 'blocked', blocked.status + ' ' + blocked.waitingReason)
  check('the stalled reviewer is disposed', taskAgents.calls.some((call) => call.kind === 'releaseTask' || (call.kind === 'release' && call.agentId === reviewerId)), JSON.stringify(taskAgents.calls))
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
  await rig.scheduler.tick(rig.project)
  const after = (await boardOf(rig)).tasks.filter((entry) => entry.id === task.id)[0]
  check('a claim from another host process is requeued', after.status === 'pending', after.status)
  check('its attempt is refunded', after.attempts <= 1, String(after.attempts))
}

console.log(failures === 0 ? '\nPASS  dispatch (v3 subagent edge)' : '\nFAIL  ' + String(failures) + ' dispatch check(s)')
process.exit(failures === 0 ? 0 : 1)
