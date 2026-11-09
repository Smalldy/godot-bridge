/**
 * One-call project onboarding (T-129).
 *
 * The task center used to be entered by a sequence the model had to invent:
 * openProject, then board, then read the team/blocked/approval state and guess
 * what to do. Every step had its own refusal, and a new project (a project.godot
 * before git init) or a stale project (a blocked card nobody remembers) produced
 * a different puzzle each time.
 *
 * `onboard` collapses that into ONE call: the host resolves the project root,
 * checks the git/Godot markers, binds the project, reads the board, bootstraps
 * the Team when it is missing, and answers a SHORT brief plus ONE machine
 * readable next step. The model only forwards the brief and performs the next
 * step.
 *
 * This module is the pure half: root resolution over an injected fs, the stage
 * decision, the next-step choice and the brief renderer. api.mjs orchestrates
 * them with state/teams/roles so the action and this module share one vocabulary
 * and the tests can exercise every decision without a live host.
 */

import { basename, dirname, join, resolve } from 'node:path'
import { resolveProjectRoot } from './board.mjs'
import * as model from './service.mjs'
// T-153: the handoff inventory decides the next step; the pure module owns the
// rule so /state, create/start and onboard cannot drift apart.
import { handoffNextCode } from './handoff.mjs'

/** The onboarding contract version. Bump only when the answer changes shape.
 * v2 (T-153): adds the handoff stage/codes and the handoff block. */
export const ONBOARD_VERSION = 2

/**
 * Every next.code `onboard` can answer, in PRIORITY order (the first matching
 * condition wins). The skill's table must cover exactly this list.
 */
export const ONBOARD_NEXT_CODES = [
  'choose-project',
  'git-init',
  'not-a-project',
  'fix-host',
  'open-owning-session',
  // T-153: another session still owns in-progress cards. The user picks ONE of
  // these before this session may create anything (resume > takeover > read-only).
  'resume-owning-session',
  'takeover-active-tasks',
  'join-project-read-only',
  'bootstrap-team',
  'approve-start',
  'triage-blocked',
  'fix-environment',
  'prune-board',
  'start-dispatch',
  'create-task',
  'none',
]

/** The 2-6 Chinese character label every next step carries. */
const NEXT_LABELS = {
  'choose-project': '选项目',
  'git-init': '初始化仓库',
  'not-a-project': '换项目',
  'fix-host': '修宿主',
  'open-owning-session': '换会话',
  'resume-owning-session': '回原会话',
  'takeover-active-tasks': '接管进行中',
  'join-project-read-only': '只读加入',
  'bootstrap-team': '建团队',
  'approve-start': '批派发',
  'triage-blocked': '处理卡住',
  'fix-environment': '清工作区',
  'prune-board': '归档旧卡',
  'start-dispatch': '开派发',
  'create-task': '写卡',
  none: '无需操作',
}

/** The one command a next step may carry (only git-init asks for one). */
const NEXT_COMMANDS = {
  'git-init': 'git init',
}

/** Human wording for the preflight check ids, so a fix-host brief stays Chinese. */
const CHECK_TEXT = {
  repository: '不是 git 仓库',
  exclude: '写不了 .git/info/exclude（.agents/ 与 .worktrees/ 需要被忽略）',
  ignored: '.agents/ 与 .worktrees/ 没有被忽略',
  worktree: '工作副本目录不可用',
  lead: '没有活着的 Team Lead',
  roles: 'reviewer/tester 角色不可用',
  team: '这个会话还没有团队',
  board: '看板文件读不出来',
}

const STATUS_TEXT = { running: '进行', reviewing: '待评审', testing: '待测试' }

function stringOf(value) {
  return typeof value === 'string' ? value : ''
}

function listOf(value) {
  return Array.isArray(value) ? value : []
}

/** Shorten one line to a fixed budget; the brief must stay scannable. */
export function shorten(value, limit) {
  const text = String(value === undefined || value === null ? '' : value)
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 24
  return text.length <= cap ? text : text.slice(0, cap) + '…'
}

function projectKindOf(flags) {
  if (flags.git === true && (flags.godot === true || flags.agents === true)) return 'root'
  if (flags.git === true) return 'git-only'
  if (flags.godot === true) return 'gitless'
  return 'plain'
}

/**
 * Resolve the project root for the onboarding, over an injected fs.
 *
 * The order is the product contract:
 *   1. an explicit `path` (must be an existing directory) is taken as the root;
 *   2. otherwise walk the session workspace UP to the nearest git root carrying
 *      .agents/ or project.godot (the SAME rule as resolveProjectRoot, called
 *      first so the two can never disagree);
 *   3. a .git FILE is a repository root too (a git worktree's marker), which the
 *      standard resolver does not accept, so the walk allows it;
 *   4. a directory with project.godot but no .git is answered as `gitless`
 *      (stage unusable, next git-init) — onboarding never runs git init itself;
 *   5. nothing found -> `none` (stage choose, next choose-project).
 *
 * @returns { kind, path, checked, git, godot, agents, error }
 *   kind: root | gitless | git-only | plain | none | invalid
 */
export async function resolveOnboardRoot(io, options) {
  const opts = options === undefined || options === null ? {} : options
  const fs = opts.fs === undefined ? io.fs : opts.fs
  const cwd = typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : undefined
  const checked = []

  async function statOf(path) {
    try {
      const target = await fs.resolve(path, { cwd: cwd })
      return await fs.stat(target)
    } catch (error) {
      return undefined
    }
  }
  async function isDir(path) {
    const info = await statOf(path)
    return info !== undefined && info.type === 'directory'
  }
  async function isFile(path) {
    const info = await statOf(path)
    return info !== undefined && info.type === 'file'
  }
  async function markers(path) {
    const dotGit = await statOf(join(path, '.git'))
    return {
      git: dotGit !== undefined && (dotGit.type === 'file' || dotGit.type === 'directory'),
      godot: await isFile(join(path, 'project.godot')),
      agents: await isDir(join(path, '.agents')),
    }
  }
  function answer(kind, path, flags, extra) {
    return Object.assign(
      { kind: kind, path: path, checked: checked, git: flags.git === true, godot: flags.godot === true, agents: flags.agents === true },
      extra === undefined ? {} : extra,
    )
  }

  const explicit = stringOf(opts.explicit).trim()
  if (explicit !== '') {
    const absolute = cwd === undefined ? resolve(explicit) : resolve(cwd, explicit)
    checked.push(absolute)
    const info = await statOf(absolute)
    if (info === undefined || (info.type !== undefined && info.type !== 'directory')) {
      return answer('invalid', absolute, {}, { error: 'not-a-directory' })
    }
    const flags = await markers(absolute)
    return answer(projectKindOf(flags), absolute, flags)
  }

  const start = stringOf(opts.workspace).trim()
  if (start === '') return answer('none', null, {})
  const startIsDir = await isDir(start)
  checked.push(start)
  if (!startIsDir) return answer('none', start, {})

  // The canonical rule first: nearest git DIRECTORY carrying .agents/ or
  // project.godot. Reusing it keeps onboarding and the rest of the plugin on one
  // definition of "a project".
  const viaResolver = await resolveProjectRoot({ fs: fs }, { explicit: null, sessionRoot: start })
  if (viaResolver.ok === true && typeof viaResolver.root === 'string' && viaResolver.root !== '') {
    // resolveProjectRoot only succeeds on a real git DIRECTORY carrying a marker,
    // so this is a root by definition; the walk below only exists for the
    // worktree case (.git FILE), which that resolver does not accept.
    if (!agrees(viaResolver.root, start)) checked.push(viaResolver.root)
    return answer('root', viaResolver.root, await markers(viaResolver.root))
  }

  // The walk proper: accepts a .git FILE (git worktree marker) and remembers the
  // nearest "git only" and "Godot only" directories as the fallbacks below.
  let current = resolve(start)
  let depth = 0
  let gitOnly = null
  let gitless = null
  for (;;) {
    // checked already carries the workspace; add up to five ancestors (the brief
    // lists them when no project is found).
    if (depth >= 1 && depth <= 5) checked.push(current)
    const flags = await markers(current)
    if (flags.git && (flags.godot || flags.agents)) return answer('root', current, flags)
    if (flags.git && gitOnly === null) gitOnly = { path: current, flags: flags, depth: depth }
    if (!flags.git && flags.godot && gitless === null) gitless = { path: current, flags: flags, depth: depth }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
    depth += 1
    if (depth > 40) break
  }
  if (gitless !== null && (gitOnly === null || gitless.depth <= gitOnly.depth)) {
    return answer('gitless', gitless.path, gitless.flags)
  }
  if (gitOnly !== null) return answer('git-only', gitOnly.path, gitOnly.flags)
  if (gitless !== null) return answer('gitless', gitless.path, gitless.flags)
  return answer('none', start, {})
}

function agrees(left, right) {
  return String(left).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(right).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The compact board facts the stage/next/brief functions consume. */
export function summariseBoard(board) {
  const tasks = listOf(board === undefined || board === null ? null : board.tasks)
  const counts = model.counts(board)
  const blocked = tasks
    .filter((task) => task.status === 'blocked')
    .slice(0, 3)
    .map((task) => ({ id: stringOf(task.id), title: stringOf(task.title), reason: blockedReasonOf(task) }))
  const active = tasks
    .filter((task) => task.status === 'running' || task.status === 'reviewing' || task.status === 'testing')
    .slice(0, 3)
    .map((task) => ({ id: stringOf(task.id), title: stringOf(task.title), status: stringOf(task.status) }))
  const dispatch = board === undefined || board === null ? null : board.dispatch
  const activeTotal = tasks.filter((task) => task.status === 'running' || task.status === 'reviewing' || task.status === 'testing').length
  return {
    counts: counts,
    ready: model.readyTasks(board).length,
    blocked: blocked,
    active: active,
    activeTotal: activeTotal,
    dispatch: dispatch === undefined || dispatch === null ? null : dispatch,
  }
}

/** The last non-empty history note of a blocked card, or the literal 'blocked'. */
export function blockedReasonOf(task) {
  const history = listOf(task === undefined || task === null ? null : task.history)
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index]
    const note = entry !== null && typeof entry === 'object' ? stringOf(entry.note).trim() : ''
    if (note !== '') return shorten(note, 40)
  }
  return 'blocked'
}

/**
 * The onboarding stage, strictly in the contract order:
 * unusable, choose, handoff, setup, attention, active, empty, idle.
 *
 * T-153: 'handoff' outranks setup/attention. While another session's in-progress
 * cards are unresolved, the new session must NOT bootstrap a team or start work:
 * the user first chooses resume / read-only / takeover.
 *
 * @param facts - every field is optional so the function is unit-testable.
 */
export function decideOnboardStage(facts) {
  const f = facts === undefined || facts === null ? {} : facts
  if (f.kind === 'none') return 'choose'
  if (f.kind !== 'root') return 'unusable'
  if (f.preflightOk !== true) return 'unusable'
  const handoff = handoffFactsOf(f)
  if (handoff.required === true && (handoff.decision === null || handoff.decision === undefined)) return 'handoff'
  if (f.teamFailed === true) return 'setup'
  const counts = f.counts === undefined || f.counts === null ? {} : f.counts
  const activeCount = Number.isFinite(f.activeCount)
    ? f.activeCount
    : Number(counts.running === undefined ? 0 : counts.running) + Number(counts.reviewing === undefined ? 0 : counts.reviewing) + Number(counts.testing === undefined ? 0 : counts.testing)
  const readyCount = Number.isFinite(f.readyCount) ? f.readyCount : Number(counts.ready === undefined ? 0 : counts.ready)
  if (Number(counts.blocked) > 0 || f.request !== null && f.request !== undefined) return 'attention'
  if (f.hardDirty === true) return 'attention'
  if (f.boardWarning !== null && f.boardWarning !== undefined) return 'attention'
  if (Number(activeCount) > 0) return 'active'
  if (Number(readyCount) > 0 && f.dispatchState === 'running') return 'active'
  if (Number(counts.total) === 0) return 'empty'
  return 'idle'
}

/** The handoff block of the facts with every field present (never null). */
export function handoffFactsOf(f) {
  const source = f !== null && f !== undefined && f.handoff !== null && typeof f.handoff === 'object' ? f.handoff : {}
  const eligibility = source.eligibility !== null && typeof source.eligibility === 'object' ? source.eligibility : {}
  const takeover = eligibility.takeover !== null && typeof eligibility.takeover === 'object' ? eligibility.takeover : {}
  return {
    required: source.required === true,
    reason: source.reason === undefined ? null : source.reason,
    decision: source.decision === undefined ? null : source.decision,
    sessions: listOf(source.sessions),
    cards: listOf(source.cards),
    eligibility: { takeover: { ok: takeover.ok === true, blockedBy: listOf(takeover.blockedBy) } },
  }
}

function detailFor(code, f) {
  const root = stringOf(f.root)
  switch (code) {
    case 'choose-project': {
      const checked = listOf(f.checked).filter((entry) => stringOf(entry) !== '')
      const where = checked.length === 0 ? '' : '我检查了 ' + checked.map((entry) => shorten(entry, 120)).join('、') + '，都没有 project.godot 或 .agents/。'
      return where + '请给我一个项目路径（path），我不会猜。'
    }
    case 'git-init':
      return shorten(root, 120) + ' 里有 project.godot，但还不是 git 仓库；我不会自己跑 git init。确认要初始化吗？命令：git init'
    case 'not-a-project':
      return f.git === true
        ? shorten(root, 120) + ' 是 git 仓库，但还没有看板标记 .agents/。任务中心不要求 Godot：空 .agents/ 就够；需要我建一个空看板吗？（.agents/、.worktrees/ 会写入 .git/info/exclude）也可以给我另一个项目路径。'
        : shorten(root, 120) + ' 既不是 git 仓库，也没有 .agents/ 或 project.godot；先 git init（需要你确认）或给我一个项目路径。'
    case 'fix-host': {
      const missing = listOf(f.preflightMissing)
      return '宿主环境还差 ' + String(missing.length) + ' 项：' + (missing.length === 0 ? '未知缺项' : missing.join('、')) + '；修好后再接入，我不会建卡。'
    }
    case 'open-owning-session':
      return '这个会话不属于 ' + shorten(root, 120) + '；请从拥有它的会话里接入，或给我一个属于本会话的项目路径。团队不会借用别的项目。'
    case 'resume-owning-session': {
      const handoff = handoffFactsOf(f)
      const live = handoff.sessions.filter((session) => session.status === 'live' && session.cards !== undefined && Number(session.cards.active) > 0)
      const listed = live.length === 0 ? '' : live.map((session) => session.sessionId + '（' + String(session.cards.active) + ' 张进行中）').join('、')
      return '进行中的卡属于' + (listed === '' ? '另一个会话' : '仍在活动的会话 ' + listed) + '；请回到那个会话继续，或明确告诉我只读加入 / 接管这些卡（旧执行者还活着时不能抢锁）。'
    }
    case 'takeover-active-tasks': {
      const handoff = handoffFactsOf(f)
      const ids = listOf(handoff.cards).map((card) => card.id).filter((id) => stringOf(id) !== '')
      return '旧会话已静默且旧执行者已停止：' + (ids.length === 0 ? '进行中的卡' : ids.join('、')) + ' 可以接管。这是不可逆的归属变更，需要你确认：我只会释放过期租约/锁、复用原工作副本、并给接管会话重新排队评审/测试，attempts 不变。'
    }
    case 'join-project-read-only': {
      const handoff = handoffFactsOf(f)
      const blocked = handoff.eligibility.takeover.blockedBy
      const why = blocked.length === 0 ? '旧会话或旧执行者不能确认已停止' : '有执行者仍存活（' + blocked.slice(0, 2).map((entry) => entry.taskId + ' ' + String(entry.reason)).join('、') + '）'
      return '我没法安全接管：' + why + '。可以只读加入（看板可读、不能派发旧卡），或在旧会话里继续；接管需要先显式中断旧执行者。'
    }
    case 'bootstrap-team': {
      const why = stringOf(f.teamError) === '' ? '团队仍然没有就绪' : f.teamError
      const missing = listOf(f.missingRoles)
      const suffix = missing.length === 0 ? '' : '（缺 ' + missing.join('、') + '）'
      return '团队自动建不起来' + suffix + '：' + shorten(why, 120) + '；不用你手工建，先修宿主或换拥有该项目的会话。'
    }
    case 'approve-start': {
      const request = f.request !== null && typeof f.request === 'object' ? f.request : {}
      const by = stringOf(request.by)
      return '队列里有 1 个派发申请' + (by === '' ? '' : '（' + by + ' 提交）') + '；去面板 → 队列 批准或拒绝。'
    }
    case 'triage-blocked': {
      const blocked = listOf(f.blocked)
      return '卡住的卡：' + (blocked.length === 0 ? '（无）' : blocked.map((task) => task.id + '（' + task.reason + '）').join('、')) + '；在面板的看板里处理（改卡、重开或催办）。'
    }
    case 'fix-environment': {
      const environment = f.environment !== null && typeof f.environment === 'object' ? f.environment : {}
      const dirty = listOf(environment.dirty).length
      const why = stringOf(environment.message)
      return '主检出的环境有问题' + (dirty === 0 ? '' : '（' + String(dirty) + ' 个未提交改动）') + (why === '' ? '' : '：' + shorten(why, 120)) + '；保留还是清理需要你确认。'
    }
    case 'prune-board': {
      const size = f.boardSize !== null && typeof f.boardSize === 'object' ? f.boardSize : {}
      const percent = Number.isFinite(size.percent) ? String(size.percent) : '?'
      return '看板已经用到 ' + percent + '%；把已完成的卡归档后再继续，否则看板会读不出来。'
    }
    case 'start-dispatch': {
      const pending = Number(f.counts === undefined || f.counts === null ? 0 : f.counts.pending)
      return '有 ' + String(Number.isFinite(pending) ? pending : 0) + ' 张待办，但派发是暂停的；要跑就由我申请派发，你在面板里批准。'
    }
    case 'create-task':
      return '现在没有要做的事；告诉我你要做什么，我只建卡，不派发。'
    case 'none':
      return '不需要你做什么；有新目标直接说。'
    default:
      return '不需要你做什么；有新目标直接说。'
  }
}

/** Build one next step object; every code carries a label, detail and (maybe) a command. */
export function nextStepOf(code, facts) {
  const key = ONBOARD_NEXT_CODES.indexOf(code) >= 0 ? code : 'none'
  const next = { code: key, label: NEXT_LABELS[key], detail: detailFor(key, facts === undefined || facts === null ? {} : facts) }
  const command = NEXT_COMMANDS[key]
  if (command !== undefined) next.command = command
  return next
}

/**
 * The ONE suggested next action, in the contract's priority order:
 * choose-project > git-init > not-a-project > fix-host > open-owning-session >
 * bootstrap-team > approve-start > triage-blocked > fix-environment >
 * prune-board > start-dispatch > create-task > none.
 */
export function selectOnboardNext(facts) {
  const f = facts === undefined || facts === null ? {} : facts
  if (f.kind === 'none') return nextStepOf('choose-project', f)
  if (f.kind === 'gitless') return nextStepOf('git-init', f)
  if (f.kind !== 'root') return nextStepOf('not-a-project', f)
  if (f.preflightOk !== true) return nextStepOf('fix-host', f)
  // T-153: an unresolved handoff outranks Team bootstrap. The user decides first.
  // The RAW handoff is used (not the display projection) so liveness-based
  // eligibility — resume vs takeover vs read-only — is exactly the host's.
  {
    const code = handoffNextCode(f.handoff !== null && typeof f.handoff === 'object' ? f.handoff : null)
    if (code !== null) return nextStepOf(code, f)
  }
  if (f.teamFailureCode === 'project-mismatch' || f.teamFailureCode === 'no-session-context' || f.teamFailureCode === 'no-session') {
    return nextStepOf('open-owning-session', f)
  }
  if (f.teamFailureCode === 'no-role-manager') return nextStepOf('fix-host', f)
  if (f.teamFailed === true) return nextStepOf('bootstrap-team', f)
  if (f.request !== null && f.request !== undefined) return nextStepOf('approve-start', f)
  const counts = f.counts === undefined || f.counts === null ? {} : f.counts
  if (Number(counts.blocked) > 0) return nextStepOf('triage-blocked', f)
  if (f.hardDirty === true) return nextStepOf('fix-environment', f)
  if (f.boardWarning !== null && f.boardWarning !== undefined) return nextStepOf('prune-board', f)
  if (f.dispatchState === 'paused' && Number(counts.pending) > 0 && (f.request === null || f.request === undefined)) {
    return nextStepOf('start-dispatch', f)
  }
  if (Number(counts.total) === 0) return nextStepOf('create-task', f)
  if (f.stage === 'idle') return nextStepOf('create-task', f)
  return nextStepOf('none', f)
}

/** The task line, reused from the T-125 renderer so there is ONE counting text. */
const TASK_LINE_PREFIX = '任务  '

/**
 * Render the onboarding brief: at most 8 non-empty lines, no internal field
 * names, no English status vocabulary. A project that could not be bound gets
 * the short 3-line form (项目 / 问题 / 下一步).
 *
 * @param input.stage - one of the onboarding stages.
 * @param input.projectLine - the rendered `项目  ...` line.
 * @param input.taskLine - the rendered `任务  ...` line (already prefixed).
 * @param input.problem - why the project could not be used (unusable/choose).
 * @param input.team - { label }
 * @param input.dispatchState, input.queue
 * @param input.active - [{id,title,status}]
 * @param input.needsUser / input.attention / input.warnings
 * @param input.next - the chosen next step
 */
export function renderOnboardBrief(input) {
  const f = input === undefined || input === null ? {} : input
  const next = f.next === undefined || f.next === null ? nextStepOf('none', f) : f.next
  const projectLine = stringOf(f.projectLine) === '' ? '项目  （未找到项目） · 未接入' : f.projectLine
  const lines = [projectLine]
  if (f.stage === 'choose' || f.stage === 'unusable') {
    if (stringOf(f.problem) !== '') lines.push('问题  ' + f.problem)
    lines.push('下一步  ' + next.detail)
    return lines.join('\n')
  }
  if (stringOf(f.taskLine) === '') lines.push(TASK_LINE_PREFIX + '无卡')
  else lines.push(f.taskLine)
  // T-153: another session still owns in-flight cards. Name them BEFORE the team
  // line, because the user must choose (resume / read-only / takeover) before this
  // session may bootstrap a team or create a card.
  const handoff = f.handoff === null || f.handoff === undefined ? null : handoffFactsOf(f)
  if (handoff !== null && handoff.required === true) {
    const statusText = { live: '在线', stale: '已静默', unknown: '未知' }
    const owning = handoff.sessions.filter((session) => session !== null && session.cards !== undefined && Number(session.cards.active) > 0)
    const shown = (owning.length === 0 ? handoff.sessions : owning).slice(0, 3).map((session) => (statusText[session.status] === undefined ? String(session.status) : statusText[session.status]) + ' ' + shorten(session.sessionId, 24))
    const ids = handoff.cards.map((card) => stringOf(card.id)).filter((id) => id !== '').slice(0, 4)
    lines.push('交接  ' + (shown.length === 0 ? '（无参与会话）' : shown.join('、')) + (ids.length === 0 ? '' : ' · 进行中 ' + ids.join('、')))
  }
  // Team + dispatch + queue on one line, so "is there a team" and "is dispatch
  // running" are answerable without a second read.
  if (f.team !== null && f.team !== undefined) {
    const parts = [stringOf(f.team.label) === '' ? '未就绪' : f.team.label]
    if (f.dispatchState === 'running') parts.push('派发运行中')
    else if (f.dispatchState === 'paused') parts.push('派发已暂停')
    if (Number(f.queue) > 0) parts.push('队列 ' + String(Math.floor(Number(f.queue))))
    lines.push('团队  ' + parts.join(' · '))
  }
  const active = listOf(f.active)
  if (active.length > 0) {
    const total = Number.isFinite(f.activeTotal) ? Math.max(active.length, Math.floor(f.activeTotal)) : active.length
    const shown = active.slice(0, 3).map((task) => task.id + ' ' + shorten(task.title, 24) + '（' + (STATUS_TEXT[task.status] === undefined ? task.status : STATUS_TEXT[task.status]) + '）')
    const more = total > 3 ? ' 等 ' + String(total) + ' 张' : ''
    lines.push('在跑  ' + shown.join(' · ') + more)
  }
  const needsUser = listOf(f.needsUser).map((entry) => stringOf(entry.message)).filter((text) => text !== '')
  if (needsUser.length > 0) lines.push('需要你  ' + needsUser.join('；'))
  const notes = []
  for (const entry of listOf(f.attention)) {
    if (entry === null || typeof entry !== 'object' || entry.code === 'blocked') continue
    if (stringOf(entry.message) !== '') notes.push(entry.message)
  }
  for (const warning of listOf(f.warnings)) if (stringOf(warning) !== '') notes.push(String(warning))
  if (notes.length > 0) lines.push('注意  ' + notes.join('；'))
  lines.push('下一步  ' + next.detail)
  return lines.join('\n')
}

/** The project line for a bound project: `项目  <path> · <branch> @ <head>`. */
export function renderProjectLine(input) {
  const f = input === undefined || input === null ? {} : input
  const path = stringOf(f.path) === '' ? '（未找到项目）' : f.path
  if (f.kind === 'none') return '项目  ' + path + ' · 未接入'
  if (f.kind === 'gitless') return '项目  ' + path + ' · 未初始化'
  if (f.kind !== 'root') return '项目  ' + path + ' · 未接入'
  const branch = stringOf(f.branch) === '' ? '未知分支' : f.branch
  const head = stringOf(f.head) === '' ? '未知提交' : f.head
  return '项目  ' + path + ' · ' + branch + ' @ ' + head
}


/** The human wording of one preflight check, for a fix-host brief. */
export function checkTextOf(check) {
  const id = stringOf(check === undefined || check === null ? '' : check.id)
  if (CHECK_TEXT[id] !== undefined) return CHECK_TEXT[id]
  const label = stringOf(check === undefined || check === null ? '' : check.label)
  return label === '' ? String(id) : label
}

/** The team label on the brief's 团队 line: 已就绪 / 未就绪 / 无团队服务. */
export function teamLabelOf(team) {
  const t = team === undefined || team === null ? {} : team
  if (t.available === false) return '无团队服务'
  if (t.ok === true) return '已就绪'
  const missing = listOf(t.missingRoles)
  return missing.length === 0 ? '未就绪' : '未就绪（缺 ' + missing.join('、') + '）'
}

/** The blocked suffix of the brief's task line (T-125 folds it in there). */
export function blockedSuffixOf(blocked, count) {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : listOf(blocked).length
  if (total === 0) return null
  const ids = listOf(blocked).slice(0, 3).map((task) => stringOf(task === undefined || task === null ? '' : task.id)).filter((id) => id !== '')
  if (ids.length === 0) return String(total) + ' 张'
  if (total > 3) return ids.slice(0, 2).join('、') + ' 等 ' + String(total) + ' 张'
  return ids.join('、')
}

/**
 * The things ONLY the user can do, derived from the chosen next step. The brief
 * never asks the user to do an agent's job (create a team, create a card, write
 * a spec): those are next steps, not needsUser entries.
 */
export function needsUserFor(next, facts) {
  const code = next !== null && next !== undefined && typeof next.code === 'string' ? next.code : 'none'
  const out = []
  const add = (message, where) => out.push({ code: code, message: message, where: where })
  if (code === 'choose-project') add('给我一个项目路径', 'session')
  else if (code === 'git-init') add('确认是否要在这个目录跑 git init', 'session')
  else if (code === 'open-owning-session') add('从拥有该项目的会话里接入，或给我一个属于本会话的项目路径', 'session')
  else if (code === 'resume-owning-session') add('回到进行中卡片所属的会话继续；或明确告诉我只读加入 / 接管这些卡', 'session')
  else if (code === 'takeover-active-tasks') add('确认接管这些进行中的卡（旧会话已静默、旧执行者已停止）', 'session')
  else if (code === 'join-project-read-only') add('选择只读加入，或回到旧会话继续', 'session')
  else if (code === 'fix-host') add('修好宿主缺项（见上）', 'host')
  else if (code === 'approve-start') add('在面板 → 队列 批准或拒绝派发申请', 'panel')
  else if (code === 'triage-blocked') add('在面板的看板里处理卡住的卡', 'panel')
  else if (code === 'fix-environment') add('决定保留还是清理主检出的未提交改动', 'host')
  else if (code === 'prune-board') add('归档已完成的卡，给看板腾空间', 'panel')
  else if (code === 'start-dispatch') add('在面板里批准我发起的派发', 'panel')
  return out
}

/** `basename` without depending on the host path flavour. */
export function projectNameOf(root) {
  const value = stringOf(root)
  if (value === '') return null
  const name = basename(value.replace(/[\\\\/]+$/, ''))
  return name === '' ? null : name
}
