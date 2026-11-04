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
  boardText,
  createFakeFs,
  createFakeGit,
  createStrictCtx,
  createTeam,
} from './support/fixtures.mjs'
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
  const agents = { list: () => [{ id: 'session-lead' }] }
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
  check('1 the call succeeds and answers the onboarding envelope', result.ok === true && o !== undefined && o.version === 1, JSON.stringify(result).slice(0, 300))
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

// ── pure decisions: the contract order and the next-code vocabulary ───────
{
  check('the next-code vocabulary is complete', ONBOARD_NEXT_CODES.length === 13 && ONBOARD_NEXT_CODES.indexOf('choose-project') === 0 && ONBOARD_NEXT_CODES.indexOf('none') === 12, ONBOARD_NEXT_CODES.join(','))
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
