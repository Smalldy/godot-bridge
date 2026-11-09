// T-129: the one-call onboarding.
//
// Eleven contract scenarios over a fake fs / fake team: an empty board, a board
// waiting for the user (request + blocked), blocked only, a project without git,
// a workspace without any project, a missing team that must bootstrap exactly
// once, a project the session does not own, a profile without team services, a
// hard-broken checkout, the brief's forbidden vocabulary, and the response size.

import { join } from 'node:path'
import {
  PROJECT,
  boardJson,
  boardText,
  createFakeFs,
  createFakeGit,
  createStrictCtx,
  createTeam,
} from './support/fixtures.mjs'
import { acquire as acquireLocks, emptyLocks } from '../../plugin/task-center/locks.mjs'
import { sessionLivenessFrom, staleMsOf } from '../../plugin/task-center/handoff.mjs'
import { createState } from '../../plugin/task-center/state.mjs'
import { createApi, ACTIONS, AGENT_ACTIONS, READ_ACTIONS, USER_ONLY_ACTIONS } from '../../plugin/task-center/api.mjs'
import { buildSkillContent } from '../../plugin/task-center/skill.mjs'
import { createRoleManager } from '../../plugin/task-center/dispatch.mjs'
import { boardPath, projectIdOf } from '../../plugin/task-center/board.mjs'
import {
  ONBOARD_NEXT_CODES,
  decideOnboardStage,
  nextStepOf,
  resolveOnboardRoot,
  selectOnboardNext,
} from '../../plugin/task-center/onboard.mjs'

let failures = 0
function check(label, condition, detail) {
  if (!condition) failures++
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + label + (condition || detail === undefined ? '' : '  -> ' + detail))
}

const STAMP = '2026-10-28T12:00:00.000Z'

function taskOf(overrides) {
  return Object.assign(
    {
      id: 'T-1',
      title: 'Task',
      status: 'pending',
      priority: 0,
      dependsOn: [],
      writeFiles: [],
      evidence: '',
      ownerSession: 'session-lead',
      history: [],
      createdAt: STAMP,
      updatedAt: STAMP,
      attempts: 0,
      maxAttempts: 3,
    },
    overrides === undefined ? {} : overrides,
  )
}

function boardOf(options) {
  const opts = options === undefined ? {} : options
  return {
    version: 2,
    seq: 2,
    updatedAt: STAMP,
    dispatch: Object.assign({ state: 'paused' }, opts.dispatch === undefined ? {} : opts.dispatch),
    tasks: opts.tasks === undefined ? [] : opts.tasks,
  }
}

/** Register a fake project directory with the markers a caller asks for. */
function addProject(fs, root, options) {
  const opts = options === undefined ? {} : options
  fs.dirs.add(root)
  if (opts.git !== false) fs.dirs.add(join(root, '.git'))
  if (opts.agents !== false) fs.dirs.add(join(root, '.agents'))
  if (opts.godot === true) fs.files.set(join(root, 'project.godot'), { text: 'config_version=5\n', version: 'seed' })
  return root
}

/** A scheduler stub: onboarding only reads its environment reading.
 * T-130 tagged every dispatcher reading with its project and `environmentSnapshot`
 * now only trusts a reading whose project matches the request. The stub echoes
 * the requested project exactly like the real dispatcher, so the dirty fixtures
 * exercise the trusted path (an untagged reading would be ignored). */
function stubScheduler(environment) {
  return {
    status: (projectPath) => ({
      state: 'running',
      lastPassAt: null,
      environment:
        environment === undefined || environment === null
          ? null
          : Object.assign({}, environment, { project: typeof projectPath === 'string' ? projectIdOf(projectPath) : environment.project }),
    }),
    kick: () => Promise.resolve(),
    dispose: () => {},
  }
}

function onboardRig(options) {
  const opts = options === undefined ? {} : options
  const project = opts.project === undefined ? PROJECT : opts.project
  const fs = createFakeFs()
  addProject(fs, project, opts.markers === undefined ? {} : opts.markers)
  if (opts.board !== undefined && opts.board !== null) {
    fs.files.set(boardPath(project), { text: JSON.stringify(opts.board), version: 'seed' })
  }
  if (opts.files !== undefined) {
    for (const entry of opts.files) fs.files.set(entry.path, { text: entry.text, version: 'seed' })
  }
  fs.dirs.add(join(project, '..', 'fake-home'))
  const team = opts.team === undefined ? createTeam() : opts.team
  // T-153: a handoff test needs a second session in the host's agent list.
  const agents = opts.agents === undefined ? { list: () => [{ id: 'session-lead' }] } : opts.agents
  const ctx = createStrictCtx(
    {
      fs,
      sandboxPolicy: { resolve: () => ({ workspaceRoot: project }) },
      get(key) {
        if (key === 'agents') return agents
        if (key === 'agentTeams') return opts.teamService === false ? null : team
        if (key === 'subagents') return { list: () => ['spawn'] }
        return undefined
      },
    },
    ['fs', 'sandboxPolicy', 'tools', 'webServer'],
  )
  const now = opts.now === undefined ? Date.parse(STAMP) : opts.now
  const state = createState(ctx, { now: () => now, homeDir: join(project, '..', 'fake-home'), sessionLookup: null })
  const sessionId = opts.sessionId === undefined ? 'session-lead' : opts.sessionId
  state.setSessionRoot(sessionId, opts.sessionRoot === undefined ? project : opts.sessionRoot)
  const git = opts.git === undefined ? createFakeGit(Object.assign({ project: project, fs: fs }, opts.gitOptions === undefined ? {} : opts.gitOptions)) : opts.git
  const scheduler = opts.scheduler === undefined ? stubScheduler(opts.environment) : opts.scheduler
  let roles = opts.roles === undefined ? null : opts.roles
  if (roles === 'auto') roles = createRoleManager(ctx, { state: state })
  const api = createApi(ctx, { state: state, scheduler: scheduler, git: git, roles: roles })
  const context = {
    projectPath: opts.contextProject === undefined ? project : opts.contextProject,
    by: '@lead',
    role: 'agent',
    agent: { id: sessionId },
  }
  async function onboard(body) {
    return api.perform('onboard', body === undefined ? {} : body, context)
  }
  return { project: project, fs: fs, team: team, ctx: ctx, state: state, git: git, scheduler: scheduler, roles: roles, api: api, onboard: onboard, sessionId: sessionId, context: context }
}

function stageLineCount(brief) {
  return String(brief)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '').length
}

function spawnCalls(team) {
  return team.calls.filter((call) => call.kind === 'spawn')
}

// ── 1) empty board + a healthy team -> empty / create-task ─────────────────
{
  const rig = onboardRig({ board: boardOf({}) })
  const result = await rig.onboard()
  const o = result.onboard
  check('1 onboard is in the action registry (agent-callable)', ACTIONS.indexOf('onboard') >= 0 && AGENT_ACTIONS.indexOf('onboard') >= 0, ACTIONS.join(','))
  check('1 the call succeeds and answers the onboarding envelope', result.ok === true && o !== undefined && o.version === 2, JSON.stringify(result).slice(0, 300))
  check('1 an empty board is the empty stage', o.stage === 'empty', o.stage)
  check('1 the next step is create-task', o.next.code === 'create-task' && o.next.label.length >= 2 && o.next.detail.length > 10, JSON.stringify(o.next))
  check('1 the brief carries the T-125 task line for an empty board', o.brief.indexOf('任务  无卡') >= 0, o.brief)
  check('1 the brief starts with the project line and ends with the next step', o.brief.split('\n')[0].indexOf('项目  ' + rig.project + ' · main @ ') === 0 && o.brief.indexOf('下一步  ') >= 0, o.brief)
  check('1 the brief stays under eight lines', stageLineCount(o.brief) <= 8, o.brief)
  check('1 the team is reported ready and no bootstrap ran', o.team.ok === true && o.team.bootstrapped === false && o.team.lead === 'lead', JSON.stringify(o.team))
  check('1 setup records the bind and the ready team', o.setup.did.some((step) => step.step === 'project-bound' && step.ok === true) && o.setup.did.some((step) => step.step === 'team-ready'), JSON.stringify(o.setup))
  check('1 a healthy first onboard provisions nothing', spawnCalls(rig.team).length === 0, JSON.stringify(rig.team.calls))
}

// ── 2) empty board + a pending dispatch request and a blocked card -> approve-start
{
  const rig = onboardRig({
    board: boardOf({
      dispatch: { state: 'paused', request: { id: 'R-1', by: '@lead', at: STAMP, note: 'start the pool' } },
      tasks: [taskOf({ id: 'T-2', title: 'Blocked card', status: 'blocked', history: [{ at: STAMP, by: '@user', note: '等用户确认再继续' }] })],
    }),
  })
  const o = (await rig.onboard()).onboard
  check('2 a dispatch request is the attention stage', o.stage === 'attention', o.stage)
  check('2 approval wins over the blocked card', o.next.code === 'approve-start', JSON.stringify(o.next))
  check('2 the brief names the blocked card', o.brief.indexOf('T-2') >= 0, o.brief)
  check('2 the next step points at the panel queue', o.next.detail.indexOf('面板') >= 0 && o.next.detail.indexOf('队列') >= 0, o.next.detail)
  check('2 the user is asked to approve in the panel', o.needsUser.some((entry) => entry.code === 'approve-start' && entry.where === 'panel'), JSON.stringify(o.needsUser))
  check('2 the dispatch request is reported in the dispatch block', o.dispatch.state === 'paused' && o.dispatch.request !== null && o.dispatch.request.id === 'R-1', JSON.stringify(o.dispatch))
  check('2 the approval is also an attention entry', o.attention.some((entry) => entry.code === 'approval'), JSON.stringify(o.attention))
}

// ── 3) only blocked cards -> triage-blocked ────────────────────────────────
{
  const rig = onboardRig({
    board: boardOf({
      tasks: [
        taskOf({ id: 'T-3', title: 'Only blocked', status: 'blocked', history: [{ at: STAMP, by: '@user', note: '等设计稿' }] }),
        taskOf({ id: 'T-4', title: 'Done card', status: 'done' }),
      ],
    }),
  })
  const o = (await rig.onboard()).onboard
  check('3 a blocked-only board is still attention', o.stage === 'attention', o.stage)
  check('3 the next step is triage-blocked', o.next.code === 'triage-blocked', JSON.stringify(o.next))
  check('3 the detail names the card and its reason', o.next.detail.indexOf('T-3') >= 0 && o.next.detail.indexOf('等设计稿') >= 0, o.next.detail)
  check('3 the blocked card is in project.blocked with its reason', o.project.blocked.length === 1 && o.project.blocked[0].reason === '等设计稿', JSON.stringify(o.project.blocked))
  check('3 the task line folds the blocker id in', o.brief.indexOf('卡住：T-3') >= 0, o.brief)
  check('3 the user is asked to triage in the panel', o.needsUser.some((entry) => entry.code === 'triage-blocked' && entry.where === 'panel'), JSON.stringify(o.needsUser))
}

// ── 4) project.godot but no .git -> unusable / git-init, and NO writes ─────
{
  const project = join(PROJECT, '..', 'onboard-godot-only')
  const rig = onboardRig({ project: project, markers: { git: false, agents: false, godot: true }, board: null })
  const before = Array.from(rig.fs.files.keys()).sort().join('|')
  const beforeVersions = Array.from(rig.fs.files.entries()).map(([key, value]) => key + '=' + value.version).join('|')
  const o = (await rig.onboard()).onboard
  const after = Array.from(rig.fs.files.keys()).sort().join('|')
  const afterVersions = Array.from(rig.fs.files.entries()).map(([key, value]) => key + '=' + value.version).join('|')
  check('4 a Godot folder without git is unusable', o.stage === 'unusable', o.stage)
  check('4 the next step is git-init with the command', o.next.code === 'git-init' && o.next.command === 'git init', JSON.stringify(o.next))
  check('4 the brief says the project is not initialized', o.brief.indexOf('未初始化') >= 0, o.brief)
  check('4 the project markers are reported honestly', o.project.git === false && o.project.godot === true, JSON.stringify(o.project))
  check('4 onboarding never runs git init itself', o.setup.did.length === 0 && o.setup.failed.length === 0, JSON.stringify(o.setup))
  check('4 onboarding writes no files for an unusable project', before === after && beforeVersions === afterVersions, before + ' -> ' + after)
  check('4 the user is asked to confirm git init', o.needsUser.some((entry) => entry.code === 'git-init'), JSON.stringify(o.needsUser))
}

// ── 5) no project anywhere -> choose / choose-project (never guess) ────────
{
  const loose = join(PROJECT, '..', 'onboard-loose', 'sub')
  const rig = onboardRig({ project: join(PROJECT, '..', 'onboard-nowhere'), markers: { git: false, agents: false }, board: null, contextProject: loose })
  rig.fs.dirs.add(join(PROJECT, '..', 'onboard-loose'))
  rig.fs.dirs.add(loose)
  // The route injects a project; onboarding must ignore it and use its contract.
  const o = (await rig.onboard({ project: PROJECT })).onboard
  check('5 no project found is the choose stage', o.stage === 'choose', o.stage)
  check('5 the next step asks the user for a path', o.next.code === 'choose-project' && o.next.detail.indexOf('path') >= 0, JSON.stringify(o.next))
  check('5 the brief lists the checked workspace and no project lines', o.brief.indexOf('未接入') >= 0 && o.brief.indexOf(loose) >= 0 && stageLineCount(o.brief) <= 4, o.brief)
  check('5 the injected project argument is ignored', o.project.root === null && o.project.path === loose, JSON.stringify(o.project))
  check('5 choosing never writes a board', rig.fs.files.size === 0, Array.from(rig.fs.files.keys()).join(','))
}

// ── 6) a missing team is bootstrapped exactly once ────────────────────────
{
  const leadOnly = createTeam({ roster: [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }] })
  const rig = onboardRig({ board: boardOf({}), team: leadOnly, roles: 'auto' })
  const first = (await rig.onboard()).onboard
  const afterFirst = spawnCalls(rig.team).length
  check('6 a lead-only team triggers the automatic bootstrap', first.team.bootstrapped === true && first.team.ok === true, JSON.stringify(first.team))
  check('6 the bootstrap spawns the worker slot only (T-129 §14)', afterFirst === 1 && /^worker-/.test(String(spawnCalls(rig.team)[0].name)), JSON.stringify(spawnCalls(rig.team).map((call) => call.name)))
  check(
    '6 reviewer/tester are deferred to their stages and not in the roster',
    first.team.roles !== null &&
      first.team.roles.length === 1 &&
      first.team.roles[0].kind === 'worker' &&
      first.team.members.every((name) => !/^reviewer-/.test(name) && !/^tester-/.test(name)) &&
      first.team.missingRoles.join(',') === 'reviewer,tester',
    JSON.stringify({ members: first.team.members, missing: first.team.missingRoles }),
  )
  check('6 the bootstrap is recorded in setup.did', first.setup.did.some((step) => step.step === 'team-bootstrap' && step.ok === true), JSON.stringify(first.setup))
  const boardBefore = boardText(rig.fs, rig.project)
  const second = (await rig.onboard()).onboard
  check('6 a second onboard provisions nothing', spawnCalls(rig.team).length === afterFirst, JSON.stringify(rig.team.calls))
  check('6 the second onboard reports the team as reused, not bootstrapped', second.team.bootstrapped === false && second.team.ok === true && !second.setup.did.some((step) => step.step === 'team-bootstrap'), JSON.stringify(second.setup))
  check('6 neither onboard creates a card', boardText(rig.fs, rig.project) === boardBefore, 'board changed')
}

// ── 7) a session that does not own the project gets no team ───────────────
{
  const other = join(PROJECT, '..', 'onboard-other-project')
  const leadOnly = createTeam({ roster: [{ id: 'session-lead', name: 'lead', role: 'lead', status: 'running' }] })
  const rig = onboardRig({ board: boardOf({}), team: leadOnly, roles: 'auto', sessionRoot: other })
  const o = (await rig.onboard()).onboard
  check('7 a foreign project is not bootstrapped', spawnCalls(rig.team).length === 0, JSON.stringify(rig.team.calls))
  check('7 the project mismatch is recorded as a failed step', o.setup.failed.length === 1 && o.setup.failed[0].code === 'project-mismatch', JSON.stringify(o.setup))
  check('7 the stage is setup', o.stage === 'setup', o.stage)
  check('7 the next step sends the user to the owning session', o.next.code === 'open-owning-session', JSON.stringify(o.next))
  check('7 the team block explains the mismatch', o.team.bootstrapped === false && o.team.ok === false && o.warnings.length >= 0, JSON.stringify(o.team))
}

// ── 8) a profile without team services stays usable ───────────────────────
{
  const rig = onboardRig({ board: boardOf({}), teamService: false })
  const o = (await rig.onboard()).onboard
  check('8 no team services is not the setup stage', o.stage !== 'setup', o.stage)
  check('8 the degradation is a warning, not a failure', o.warnings.some((warning) => warning.indexOf('无团队服务') >= 0 || warning.indexOf('没有团队服务') >= 0), JSON.stringify(o.warnings))
  check('8 the empty board still suggests create-task', o.next.code === 'create-task', JSON.stringify(o.next))
  check('8 the team block reports the missing service', o.team.available === false && o.setup.failed.length === 0, JSON.stringify(o.team))
}

// ── 9) a hard-broken main checkout -> fix-environment, approval still wins ─
{
  const dirty = { clean: false, code: 'not-a-git-repository', message: 'not a git repository', checkedAt: STAMP, transient: false, dirty: [], retrying: [], escalated: [] }
  const rig = onboardRig({ board: boardOf({ dispatch: { state: 'running' } }), scheduler: stubScheduler(dirty) })
  const o = (await rig.onboard()).onboard
  check('9 a hard-dirty environment is attention', o.stage === 'attention', o.stage)
  check('9 the next step is fix-environment', o.next.code === 'fix-environment', JSON.stringify(o.next))
  check('9 the environment block carries the reading', o.environment !== null && o.environment.clean === false && o.environment.transient === false, JSON.stringify(o.environment))
  check('9 the user decides what to keep', o.needsUser.some((entry) => entry.code === 'fix-environment'), JSON.stringify(o.needsUser))

  const approved = onboardRig({
    board: boardOf({ dispatch: { state: 'running', request: { id: 'R-9', by: '@lead', at: STAMP, note: '' } } }),
    scheduler: stubScheduler(dirty),
  })
  const o2 = (await approved.onboard()).onboard
  check('9 an approval request outranks fix-environment', o2.next.code === 'approve-start', JSON.stringify(o2.next))
}

// ── 10) the brief speaks Chinese, without internal names or status words ──
{
  const rich = onboardRig({
    board: boardOf({
      dispatch: { state: 'running', request: null },
      tasks: [
        taskOf({ id: 'T-10', title: 'Blocked card', status: 'blocked', history: [{ at: STAMP, by: '@user', note: '等用户确认' }] }),
        taskOf({ id: 'T-11', title: 'Active card', status: 'running' }),
        taskOf({ id: 'T-12', title: 'Waiting card', status: 'reviewing' }),
      ],
    }),
    environment: { clean: true, code: null, message: null, checkedAt: STAMP, transient: false, dirty: [], retrying: [], escalated: [] },
  })
  const o = (await rich.onboard()).onboard
  const brief = String(o.brief)
  const forbidden = /maxConcurrent|waitingReason|liveExecutors|ownerSession|nextStep|rolePreviews|dispatch\.request|\bpending\b|\brunning\b|\breviewing\b|\btesting\b|\bdone\b|\bblocked\b/
  check('10 the brief never leaks internal field names or English statuses', !forbidden.test(brief), brief)
  check('10 the brief uses the Chinese counters', /[0-9]+ (待办|进行|待评审|待测试|完成)/.test(brief), brief)
  check('10 the brief states the running cards in Chinese', brief.indexOf('在跑') >= 0 && brief.indexOf('进行') >= 0, brief)
  check('10 the brief stays scannable at eight lines or fewer', stageLineCount(brief) <= 8, brief)
  check('10 the brief never tells the user to create a team or a card', brief.indexOf('建团队') < 0 && brief.indexOf('请你建') < 0, brief)
}

// ── 10b) at most three running cards are named, with the total after them ──
{
  const rig = onboardRig({
    board: boardOf({
      dispatch: { state: 'running' },
      tasks: [
        taskOf({ id: 'T-30', title: 'Running one', status: 'running' }),
        taskOf({ id: 'T-31', title: 'Running two', status: 'running' }),
        taskOf({ id: 'T-32', title: 'Running three', status: 'running' }),
        taskOf({ id: 'T-33', title: 'Running four', status: 'running' }),
      ],
    }),
  })
  const o = (await rig.onboard()).onboard
  check('10b the project lists at most three active cards', o.project.active.length === 3 && o.stage === 'active', JSON.stringify({ active: o.project.active.length, stage: o.stage }))
  check('10b the brief states the remaining count', o.brief.indexOf('等 4 张') >= 0, o.brief)
}

// ── 11) the answer is compact and carries no board arrays ─────────────────
{
  const rig = onboardRig({
    board: boardOf({ tasks: [taskOf({ id: 'T-20', title: 'One card' }), taskOf({ id: 'T-21', title: 'Two cards', status: 'done' })] }),
  })
  const result = await rig.onboard()
  const text = JSON.stringify(result)
  check('11 the answer stays under 20 KB', Buffer.byteLength(text, 'utf8') < 20 * 1024, String(Buffer.byteLength(text, 'utf8')))
  check('11 the answer carries no tasks array', !('tasks' in result) && result.onboard.project !== undefined && result.onboard.project.tasks === undefined, Object.keys(result).join(','))
  check('11 the answer carries no rolePreviews or worktrees', !('rolePreviews' in result) && !('worktrees' in result), Object.keys(result).join(','))
  check('11 a non-empty board is summarised, not dumped', result.onboard.project.counts.total === 2 && result.onboard.project.counts.done === 1, JSON.stringify(result.onboard.project.counts))
  check('11 every documented onboard field is present', ['version', 'stage', 'brief', 'project', 'team', 'dispatch', 'environment', 'setup', 'attention', 'needsUser', 'warnings', 'next', 'checkedAt'].every((key) => key in result.onboard), Object.keys(result.onboard).join(','))
}

// ── T-153: session lifecycle + in-progress task handoff ───────────────────
{
  const OLD = 'session-old'
  const NEW = 'session-lead'
  const NOW_MS = Date.parse(STAMP)
  const OLD_LIVE = new Date(NOW_MS).toISOString()
  const OLD_STALE = new Date(NOW_MS - 30 * 60 * 1000).toISOString()

  /** A multi-session host: each Lead keeps its own roster (T-106 style). */
  function twoSessionTeam() {
    const calls = []
    const rosters = new Map([
      [NEW, [{ id: NEW, name: 'lead', role: 'lead', status: 'running' }]],
      [OLD, [{ id: OLD, name: 'lead-old', role: 'lead', status: 'running' }, { id: 'session-old-worker', name: 'old-worker', role: 'teammate', status: 'running' }]],
    ])
    function keyOf(caller) {
      if (caller === null || caller === undefined) return 'unknown'
      if (typeof caller === 'string') return caller
      return String(caller.id)
    }
    return {
      calls,
      tryMembership(candidate) {
        if (candidate === null || candidate === undefined) return null
        const id = String(candidate.id === undefined ? candidate : candidate.id)
        return { role: rosters.has(id) ? 'lead' : 'teammate', name: String(candidate.name === undefined ? id : candidate.name) }
      },
      listMembers(lead) {
        const roster = rosters.get(keyOf(lead))
        return (roster === undefined ? [] : roster).map((member) => Object.assign({}, member))
      },
      async spawnTeammate(caller, request) {
        const key = keyOf(caller)
        const name = String(request === undefined || request === null || request.name === undefined ? 'spawned' : request.name)
        calls.push({ kind: 'spawn', caller: key, name: name })
        const member = { id: 'session-' + name, name: name, role: 'teammate', status: 'running' }
        const roster = rosters.get(key) || []
        roster.push(member)
        rosters.set(key, roster)
        return { member: member }
      },
      async sendMessage(caller, request) {
        calls.push({ kind: 'send', caller: keyOf(caller), target: request === undefined || request === null ? null : request.target })
        const target = request === undefined || request === null ? null : String(request.target)
        for (const roster of rosters.values()) {
          const member = roster.filter((entry) => entry.name === target)[0]
          if (member !== undefined) member.status = 'running'
        }
        return { status: 'accepted' }
      },
      async interrupt() {
        calls.push({ kind: 'interrupt' })
        return { previousStatus: 'running' }
      },
    }
  }

  const bothAgents = { list: () => [{ id: NEW, name: 'lead' }, { id: OLD, name: 'lead-old' }] }

  /** Seed the project registry with ONE session's last-seen timestamp. */
  function markSession(rig, sessionId, isoAt) {
    const id = projectIdOf(rig.project)
    rig.state.memory.registry = {
      version: 1,
      lastActiveProjectId: id,
      projects: [
        { id: id, root: rig.project, lastSeenAt: isoAt, lastSessionId: sessionId, worktreeRoot: null, preflight: null, sessions: [{ sessionId: sessionId, firstSeenAt: isoAt, lastSeenAt: isoAt }] },
      ],
    }
    rig.state.memory.registryLoaded = true
  }

  function leadOnlyTeam() {
    return createTeam({ roster: [{ id: NEW, name: 'lead', role: 'lead', status: 'running' }] })
  }

  function runningCard(overrides) {
    return taskOf(Object.assign({
      id: 'T-6',
      title: 'In-flight card',
      status: 'running',
      ownerSession: OLD,
      attempts: 2,
      writeFiles: ['scripts/live.gd'],
      assignee: { name: 'old-worker', session: 'session-old-worker' },
      // The attempt lapsed long ago: no lease evidence inside the handoff window,
      // which is what makes the owning session stale rather than live.
      leaseUntil: new Date(NOW_MS - 30 * 60 * 1000).toISOString(),
      worktree: 'C:/ws/.worktrees/T-6-2',
      branch: 'task/T-6-2',
      base: 'base-sha',
      commit: 'head-6',
      actualFiles: ['scripts/live.gd'],
    }, overrides === undefined ? {} : overrides))
  }

  // 1) LIVE owner + running card: handoff, no second team, create refused.
  {
    const rig = onboardRig({ board: boardOf({ tasks: [runningCard()] }), team: leadOnlyTeam(), roles: 'auto' })
    markSession(rig, OLD, OLD_LIVE)
    const o = (await rig.onboard()).onboard
    check('T-153 a live owning session puts onboarding in the handoff stage', o.stage === 'handoff' && o.next.code === 'resume-owning-session' && o.handoff.required === true && o.handoff.reason === 'foreign-active-tasks', JSON.stringify({ stage: o.stage, next: o.next && o.next.code, handoff: o.handoff && { required: o.handoff.required, reason: o.handoff.reason } }))
    const row = (o.handoff.sessions || []).filter((entry) => entry.sessionId === OLD)[0]
    check('T-153 handoff payload names sessions, liveness, cards and eligibility', row !== undefined && row.status === 'live' && row.cards.active === 1 && o.handoff.cards.length === 1 && o.handoff.cards[0].id === 'T-6' && o.handoff.cards[0].ownerSession === OLD && Array.isArray(o.handoff.cards[0].liveExecutors) && o.handoff.cards[0].lease.until !== null && o.handoff.eligibility.takeover.ok === false && o.handoff.eligibility.resume.ok === true, JSON.stringify({ row: row, cards: o.handoff.cards }))
    check('T-153 a live owner is never taken over and no second team is built', spawnCalls(rig.team).length === 0 && o.team.ok !== true, JSON.stringify({ spawns: spawnCalls(rig.team).length, team: o.team }))
    const created = await rig.api.perform('create', { title: 'new work' }, rig.context)
    check('T-153 create is refused with the handoff next step (never bootstrap-team)', created.ok === false && created.code === 'handoff-required' && created.nextStep !== null && created.nextStep.code === 'resume-owning-session' && created.nextStep.code !== 'bootstrap-team' && Array.isArray(created.handoff.cards) && created.handoff.cards[0].id === 'T-6', JSON.stringify({ code: created.code, next: created.nextStep && created.nextStep.code }))
    const started = await rig.api.perform('start', {}, rig.context)
    check('T-153 start is refused with the same handoff next step', started.ok === false && started.code === 'handoff-required' && started.nextStep !== null && started.nextStep.code === 'resume-owning-session', JSON.stringify({ code: started.code, next: started.nextStep && started.nextStep.code }))
    const unchanged = boardJson(rig.fs, rig.project).tasks[0]
    check('T-153 nothing is auto-reowned while the decision is open', unchanged.ownerSession === OLD && unchanged.status === 'running', JSON.stringify({ owner: unchanged.ownerSession, status: unchanged.status }))
  }

  // 2) STALE owner + DEAD executor: user-confirmed takeover of a running card.
  {
    const rig = onboardRig({ board: boardOf({ tasks: [runningCard()] }), roles: 'auto' })
    markSession(rig, OLD, OLD_STALE)
    const seededLock = acquireLocks(emptyLocks(), ['scripts/live.gd'], { taskId: 'T-6' }, NOW_MS, 60 * 60 * 1000)
    rig.state.memory.locks = seededLock.locks
    const first = (await rig.onboard()).onboard
    check('T-153 a stale owning session with a dead executor offers takeover', first.stage === 'handoff' && first.next.code === 'takeover-active-tasks' && first.handoff.eligibility.takeover.ok === true && first.handoff.sessions.filter((entry) => entry.sessionId === OLD)[0].status === 'stale', JSON.stringify({ next: first.next && first.next.code, eligibility: first.handoff && first.handoff.eligibility })
    )
    const unconfirmed = await rig.api.perform('onboard', { handoff: { decision: 'takeover', taskIds: ['T-6'] } }, rig.context)
    check('T-153 takeover needs an explicit user confirmation', unconfirmed.ok === false && unconfirmed.code === 'handoff-confirmation-required', JSON.stringify({ code: unconfirmed.code }))
    const taken = await rig.api.perform('onboard', { handoff: { decision: 'takeover', taskIds: ['T-6'], confirm: true, reason: 'old session gone' } }, rig.context)
    const board = boardJson(rig.fs, rig.project)
    const after = board.tasks.filter((task) => task.id === 'T-6')[0]
    check('T-153 takeover re-owns the running card, releases the stale claim and keeps attempts/worktree/commit', taken.ok === true && after.ownerSession === NEW && after.status === 'pending' && after.assignee === null && after.leaseUntil === null && after.attempts === 2 && after.worktree === 'C:/ws/.worktrees/T-6-2' && after.branch === 'task/T-6-2' && after.commit === 'head-6', JSON.stringify({ owner: after.ownerSession, status: after.status, attempts: after.attempts, worktree: after.worktree, commit: after.commit }))
    const held = Object.values(rig.state.memory.locks).filter((lock) => String(lock.taskId) === 'T-6')
    check('T-153 takeover releases the stale write locks', held.length === 0, JSON.stringify(rig.state.memory.locks))
    check('T-153 the takeover reports exactly the lock paths it released', taken.onboard.takeover !== null && taken.onboard.takeover.releasedLocks.indexOf('scripts/live.gd') >= 0, JSON.stringify(taken.onboard.takeover && taken.onboard.takeover.releasedLocks))
    const audit = (after.history || []).filter((row) => row.fromSession === OLD && row.toSession === NEW)[0]
    check('T-153 takeover writes an audit row (sessions, reason, executor/lock actions)', audit !== undefined && audit.reason === 'old session gone' && audit.by === '@lead' && typeof audit.executorAction === 'string' && audit.executorAction.indexOf('retired') >= 0 && typeof audit.lockAction === 'string', JSON.stringify(audit))
    const takeoverHandoff = taken.onboard === undefined || taken.onboard === null ? null : taken.onboard.handoff
    check('T-153 the takeover decision is recorded and the handoff is resolved', taken.ok === true && takeoverHandoff !== null && takeoverHandoff.required === false && takeoverHandoff.decision !== null && takeoverHandoff.decision.mode === 'takeover' && taken.onboard.stage !== 'handoff' && taken.onboard.setup.did.some((step) => step.step === 'handoff-takeover'), JSON.stringify({ code: taken.ok === true ? null : taken.code, handoff: takeoverHandoff && { required: takeoverHandoff.required, decision: takeoverHandoff.decision && takeoverHandoff.decision.mode }, stage: taken.onboard && taken.onboard.stage }))
  }

  // 3) STALE owner + ALIVE executor: no lock stealing; read-only fallback.
  {
    const team = twoSessionTeam()
    const rig = onboardRig({ board: boardOf({ tasks: [runningCard()] }), team: team, agents: bothAgents, roles: 'auto' })
    markSession(rig, OLD, OLD_STALE)
    const seededLock = acquireLocks(emptyLocks(), ['scripts/live.gd'], { taskId: 'T-6' }, NOW_MS, 60 * 60 * 1000)
    rig.state.memory.locks = seededLock.locks
    const first = (await rig.onboard()).onboard
    check('T-153 a live executor blocks takeover and onboarding answers read-only join', first.stage === 'handoff' && first.next.code === 'join-project-read-only' && first.handoff.eligibility.takeover.ok === false && first.handoff.eligibility.takeover.blockedBy.some((entry) => entry.taskId === 'T-6' && entry.reason === 'executor-alive'), JSON.stringify({ next: first.next && first.next.code, blocked: first.handoff && first.handoff.eligibility }))
    const refused = await rig.api.perform('onboard', { handoff: { decision: 'takeover', confirm: true } }, rig.context)
    check('T-153 takeover is refused while the old executor is alive', refused.ok === false && refused.code === 'executor-alive' && refused.nextStep !== null && refused.nextStep.code !== 'bootstrap-team', JSON.stringify({ code: refused.code, next: refused.nextStep && refused.nextStep.code }))
    const interruptRefused = await rig.api.perform('onboard', { handoff: { decision: 'takeover', confirm: true, interrupt: true } }, rig.context)
    const interrupts = team.calls.filter((call) => call.kind === 'interrupt').length
    const after = boardJson(rig.fs, rig.project).tasks.filter((task) => task.id === 'T-6')[0]
    const held = Object.values(rig.state.memory.locks).filter((lock) => String(lock.taskId) === 'T-6')
    check('T-153 an explicit interrupt is attempted, but a still-live executor keeps the card and its lock', interruptRefused.ok === false && interrupts >= 1 && after.ownerSession === OLD && after.status === 'running' && held.length === 1, JSON.stringify({ code: interruptRefused.code, interrupts: interrupts, owner: after.ownerSession, locks: held.length }))
  }

  // 4) REVIEWING/TESTING takeover: live stage records kept, roles re-provisioned.
  {
    const reviewing = taskOf({ id: 'T-7', title: 'Waiting review', status: 'reviewing', ownerSession: OLD, attempts: 1, writeFiles: [], review: { status: 'pending', by: 'worker', at: new Date(NOW_MS - 20 * 60 * 1000).toISOString(), reasons: null, attempt: 2, deliveredTo: { name: 'old-reviewer', id: 'session-old-reviewer', at: new Date(NOW_MS - 20 * 60 * 1000).toISOString() } }, merge: { status: 'open', base: 'base-sha', target: 'main', head: 'head-7', mergeCommit: null } })
    const testing = taskOf({ id: 'T-8', title: 'Testing card', status: 'testing', ownerSession: OLD, attempts: 1, writeFiles: [], test: { status: 'passed', by: 'tester', at: new Date(NOW_MS - 20 * 60 * 1000).toISOString(), evidence: 'suite green', attempt: 1, deliveredTo: { name: 'old-tester', id: 'session-old-tester', at: new Date(NOW_MS - 20 * 60 * 1000).toISOString() } }, merge: { status: 'open', base: 'base-sha', target: 'main', head: 'head-8', mergeCommit: 'candidate-8' } })
    const team = twoSessionTeam()
    const rig = onboardRig({ board: boardOf({ tasks: [reviewing, testing] }), team: team, agents: bothAgents, roles: 'auto' })
    markSession(rig, OLD, OLD_STALE)
    const taken = await rig.api.perform('onboard', { handoff: { decision: 'takeover', confirm: true } }, rig.context)
    const tasks = boardJson(rig.fs, rig.project).tasks
    const reviewed = tasks.filter((task) => task.id === 'T-7')[0]
    const tested = tasks.filter((task) => task.id === 'T-8')[0]
    const spawns = team.calls.filter((call) => call.kind === 'spawn')
    check('T-153 stage cards hold no write lock, so the takeover reports none released', taken.ok === true && taken.onboard.takeover !== null && taken.onboard.takeover.releasedLocks.length === 0, JSON.stringify(taken.onboard && taken.onboard.takeover && taken.onboard.takeover.releasedLocks))
    check('T-153 reviewing takeover keeps the round + an approved record and re-queues the reviewer', taken.ok === true && reviewed.ownerSession === NEW && reviewed.status === 'reviewing' && reviewed.review.attempt === 2 && reviewed.review.status === 'pending' && reviewed.review.deliveredTo !== null && String(reviewed.review.deliveredTo.name).indexOf('reviewer') === 0 && reviewed.merge !== null && reviewed.merge.status === 'open', JSON.stringify({ owner: reviewed.ownerSession, status: reviewed.status, review: reviewed.review }))
    check('T-153 testing takeover keeps the candidate + passed test and does not re-run a passed round', tested.ownerSession === NEW && tested.status === 'testing' && tested.test.status === 'passed' && tested.test.evidence === 'suite green' && tested.merge !== null && tested.merge.mergeCommit === 'candidate-8' && tested.test.deliveredTo !== null && tested.test.deliveredTo.id === 'session-old-tester', JSON.stringify({ owner: tested.ownerSession, test: tested.test, merge: tested.merge }))
    check('T-153 the takeover session re-provisions a reviewer and a tester for the moved cards', spawns.some((call) => call.caller === NEW && String(call.name).indexOf('reviewer') === 0) && spawns.some((call) => call.caller === NEW && String(call.name).indexOf('tester') === 0), JSON.stringify(spawns))
    check(
      'T-153 the takeover audit records the per-phase executor action (re-queue vs kept verdict)',
      [reviewed, tested].every((task) =>
        (task.history || []).some(
          (row) =>
            row.fromSession === OLD &&
            row.toSession === NEW &&
            typeof row.executorAction === 'string' &&
            (row.executorAction.indexOf('re-queued') >= 0 || row.executorAction.indexOf('kept') >= 0) &&
            typeof row.lockAction === 'string',
        ),
      ),
      JSON.stringify(tasks.map((task) => (task.history || []).map((row) => row.executorAction))),
    )
    // The old session comes back: the taken-over cards are READ-ONLY to it. It is
    // offered 'resume the owning session', never an automatic steal-back.
    const oldBack = await rig.api.perform('onboard', { path: rig.project }, { projectPath: rig.project, by: '@lead', role: 'agent', agent: { id: OLD } })
    const backTasks = boardJson(rig.fs, rig.project).tasks
    check(
      'T-153 an old session coming back never auto-steals a taken-over card',
      oldBack.ok === true &&
        backTasks.filter((task) => task.id === 'T-7' || task.id === 'T-8').every((task) => task.ownerSession === NEW) &&
        oldBack.onboard.handoff.required === true &&
        oldBack.onboard.handoff.eligibility.takeover.ok === false &&
        oldBack.onboard.handoff.eligibility.resume.ok === true &&
        oldBack.onboard.next.code === 'resume-owning-session' &&
        oldBack.onboard.stage === 'handoff',
      JSON.stringify({ code: oldBack.code, owners: backTasks.map((task) => [task.id, task.ownerSession]), next: oldBack.onboard && oldBack.onboard.next && oldBack.onboard.next.code, eligibility: oldBack.onboard && oldBack.onboard.handoff && oldBack.onboard.handoff.eligibility }),
    )
  }

  // 5) join read-only: old cards stay put; the decision unblocks create.
  {
    const rig = onboardRig({ board: boardOf({ tasks: [runningCard()] }), team: leadOnlyTeam(), roles: 'auto' })
    markSession(rig, OLD, OLD_STALE)
    const blocked = await rig.api.perform('create', { title: 'blocked card' }, rig.context)
    check('T-153 create stays refused before the handoff decision', blocked.ok === false && blocked.code === 'handoff-required', JSON.stringify({ code: blocked.code }))
    const joined = await rig.api.perform('onboard', { handoff: { decision: 'join-read-only' } }, rig.context)
    const after = boardJson(rig.fs, rig.project).tasks.filter((task) => task.id === 'T-6')[0]
    check('T-153 join read-only records the decision and leaves the old card with its owner', joined.ok === true && joined.onboard.handoff.decision !== null && joined.onboard.handoff.decision.mode === 'join-read-only' && after.ownerSession === OLD && after.status === 'running' && joined.onboard.setup.did.some((step) => step.step === 'handoff-join'), JSON.stringify({ decision: joined.onboard.handoff && joined.onboard.handoff.decision, owner: after.ownerSession }))
    const created = await rig.api.perform('create', { title: 'own card now' }, rig.context)
    check('T-153 after joining read-only the session may create its OWN cards', created.ok === true && created.task.ownerSession === NEW, JSON.stringify({ ok: created.ok, code: created.code }))
  }

  // 6) A decision made when the board is already at the cap must SURVIVE the
  //    write/read round-trip (review round 1 blocker: the cap kept the oldest).
  {
    const SEED = 32
    const decisions = {}
    for (let index = 0; index < SEED; index += 1) {
      decisions['session-history-' + String(index)] = {
        mode: 'join-read-only',
        // index 0 is the newest seed, index 31 the oldest one (the cap should drop it)
        at: new Date(NOW_MS - (index + 2) * 60 * 1000).toISOString(),
        by: '@user',
        byName: null,
        reason: null,
        taskIds: [],
      }
    }
    const seeded = Object.assign(boardOf({ tasks: [runningCard()] }), { handoff: { version: 1, sessions: decisions } })
    const rig = onboardRig({ board: seeded, team: leadOnlyTeam(), roles: 'auto' })
    markSession(rig, OLD, OLD_STALE)
    const joined = await rig.api.perform('onboard', { handoff: { decision: 'join-read-only' } }, rig.context)
    const persisted = boardJson(rig.fs, rig.project).handoff
    const persistedSessions = persisted === null || persisted === undefined || persisted.sessions === null || persisted.sessions === undefined ? {} : persisted.sessions
    const keys = Object.keys(persistedSessions)
    check(
      'T-153 a decision made at the handoff cap survives the write/read round-trip (newest wins)',
      joined.ok === true &&
        persistedSessions[NEW] !== undefined &&
        persistedSessions[NEW].mode === 'join-read-only' &&
        keys.length === SEED &&
        keys.indexOf('session-history-' + String(SEED - 1)) < 0 &&
        joined.onboard.handoff.decision !== null &&
        joined.onboard.handoff.decision.mode === 'join-read-only',
      JSON.stringify({ code: joined.code, keys: keys.length, decision: persistedSessions[NEW], oldestSeedKept: keys.indexOf('session-history-' + String(SEED - 1)) }),
    )
    const created = await rig.api.perform('create', { title: 'after cap join' }, rig.context)
    check('T-153 the persisted decision still unblocks create', created.ok === true, JSON.stringify({ ok: created.ok, code: created.code }))
  }
}

// ── pure decisions: the contract order and the next-code vocabulary ───────
{
  check(
    'the next-code vocabulary is complete (T-153 adds the three handoff codes)',
    ONBOARD_NEXT_CODES.length === 16 && ONBOARD_NEXT_CODES.indexOf('choose-project') === 0 && ONBOARD_NEXT_CODES.indexOf('none') === 15 &&
      ONBOARD_NEXT_CODES.indexOf('resume-owning-session') === 5 && ONBOARD_NEXT_CODES.indexOf('takeover-active-tasks') === 6 && ONBOARD_NEXT_CODES.indexOf('join-project-read-only') === 7,
    ONBOARD_NEXT_CODES.join(','),
  )
  check(
    'the stage order is unusable > choose > setup > attention > active > empty > idle',
    decideOnboardStage({ kind: 'none' }) === 'choose' &&
      decideOnboardStage({ kind: 'gitless' }) === 'unusable' &&
      decideOnboardStage({ kind: 'root', preflightOk: false }) === 'unusable' &&
      decideOnboardStage({ kind: 'root', preflightOk: true, teamFailed: true }) === 'setup' &&
      decideOnboardStage({ kind: 'root', preflightOk: true, counts: { blocked: 1 } }) === 'attention' &&
      decideOnboardStage({ kind: 'root', preflightOk: true, counts: { total: 1, running: 1 } }) === 'active' &&
      decideOnboardStage({ kind: 'root', preflightOk: true, counts: { total: 0 } }) === 'empty' &&
      decideOnboardStage({ kind: 'root', preflightOk: true, counts: { total: 2, done: 2 } }) === 'idle',
  )
  check(
    'the next order matches the priority table',
    selectOnboardNext({ kind: 'none' }).code === 'choose-project' &&
      selectOnboardNext({ kind: 'gitless' }).code === 'git-init' &&
      selectOnboardNext({ kind: 'git-only' }).code === 'not-a-project' &&
      selectOnboardNext({ kind: 'root', preflightOk: false }).code === 'fix-host' &&
      selectOnboardNext({ kind: 'root', preflightOk: true, teamFailureCode: 'project-mismatch' }).code === 'open-owning-session' &&
      selectOnboardNext({ kind: 'root', preflightOk: true, teamFailed: true, teamFailureCode: 'no-members' }).code === 'bootstrap-team' &&
      selectOnboardNext({ kind: 'root', preflightOk: true, counts: { pending: 1 }, dispatchState: 'paused' }).code === 'start-dispatch' &&
      selectOnboardNext({ kind: 'root', preflightOk: true, counts: { total: 0 } }).code === 'create-task' &&
      selectOnboardNext({ kind: 'root', preflightOk: true, counts: { total: 1, running: 1 }, stage: 'active' }).code === 'none',
  )
  // T-151: a git repo without markers is NOT "give me a Godot project path".
  const gitOnly = nextStepOf('not-a-project', { root: PROJECT, git: true })
  const gitless = nextStepOf('not-a-project', { root: PROJECT, git: false })
  check(
    'T-151 not-a-project explains that an empty .agents is enough and never demands a Godot path',
    gitOnly.detail.indexOf('.agents') >= 0 &&
      gitOnly.detail.indexOf('不要求 Godot') >= 0 &&
      gitOnly.detail.indexOf('空 .agents') >= 0 &&
      gitOnly.detail.indexOf('.git/info/exclude') >= 0 &&
      gitOnly.detail.indexOf('另一个项目路径') >= 0 &&
      gitOnly.detail.indexOf('Godot 项目路径') < 0 &&
      gitless.detail.indexOf('git init') >= 0 &&
      gitless.detail.indexOf('Godot 项目路径') < 0,
    JSON.stringify({ gitOnly: gitOnly.detail, gitless: gitless.detail }),
  )

  // T-151: the runtime skill teaches the same non-Godot / no-.agents boundary.
  const skillText = buildSkillContent({ actions: ACTIONS, agentActions: AGENT_ACTIONS, readActions: READ_ACTIONS, userOnlyActions: USER_ONLY_ACTIONS })
  check(
    'T-151 the skill explains non-Godot onboarding, exclude, explicit project and verify caution',
    skillText.indexOf('非 Godot / 无 `.agents`') >= 0 &&
      skillText.indexOf('空 `.agents/` 就够') >= 0 &&
      skillText.indexOf('.git/info/exclude') >= 0 &&
      skillText.indexOf('显式 `project` 参数') >= 0 &&
      skillText.indexOf('npm run verify') >= 0 &&
      skillText.indexOf('verify:blender') >= 0 &&
      skillText.indexOf('Godot 项目路径') < 0,
    skillText.slice(skillText.indexOf('非 Godot'), skillText.indexOf('非 Godot') + 420),
  )
}

// ── root resolution over the injected fs ─────────────────────────────────
{
  const fs = createFakeFs()
  const home = join(PROJECT, '..', 'onboard-resolver')
  addProject(fs, home, { godot: true })
  const explicit = await resolveOnboardRoot({ fs: fs }, { explicit: home })
  check('the resolver takes an explicit directory as the root', explicit.kind === 'root' && explicit.path === home && explicit.godot === true, JSON.stringify(explicit))
  const missing = await resolveOnboardRoot({ fs: fs }, { explicit: join(home, 'missing') })
  check('the resolver refuses a missing explicit path', missing.kind === 'invalid' && missing.error === 'not-a-directory', JSON.stringify(missing))
  const nested = join(home, 'src')
  fs.dirs.add(join(home, 'src'))
  const walked = await resolveOnboardRoot({ fs: fs }, { workspace: nested })
  check('the resolver walks up to the project root', walked.kind === 'root' && walked.path === home, JSON.stringify(walked))
  // A worktree's .git is a FILE, not a directory: that is still a repository root.
  const worktree = join(PROJECT, '..', 'onboard-worktree')
  fs.dirs.add(worktree)
  fs.files.set(join(worktree, '.git'), { text: 'gitdir: elsewhere\n', version: 'seed' })
  fs.dirs.add(join(worktree, '.agents'))
  const viaFile = await resolveOnboardRoot({ fs: fs }, { workspace: worktree })
  check('the resolver accepts a .git FILE as a repository root', viaFile.kind === 'root' && viaFile.path === worktree, JSON.stringify(viaFile))
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + String(failures) + ' CHECK(S) FAILED')
process.exit(failures === 0 ? 0 : 1)
