/**
 * The task center's runtime skill — the model-facing entry point.
 *
 * Only this entry is registered in the host skill catalog. The detailed
 * chapters live next to it as resource files under ./skills/ and are read on
 * demand; they are not skills, so they never pollute an unrelated session's
 * catalog. The action matrix in reference.md is generated from the live action
 * registry, so the guide cannot drift from the API.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** The single skill the host catalog advertises. */
export const SKILL_NAME = 'godot-bridge-task-center-init'

/** One sentence, for routing: the catalog shows this before the body is read. */
export const SKILL_DESCRIPTION =
  '任务中心入口：项目任务板、依赖派发、文件锁与评审/测试/合并流水线；先读本技能，再按需读取细节资源。'

/** When a session should load this skill. */
export const SKILL_WHEN_TO_USE =
  '要给工作排期或并行、需要独立评审与测试门禁、或多个工作者同时改同一仓库时；第一次调用 task_center 之前读它。'

/** The directory exposed as resourceBase; the detailed chapters are plain Markdown. */
export const SKILL_RESOURCE_DIR = fileURLToPath(new URL('./skills/', import.meta.url))

/** The resources a model may read after loading the init skill. */
export const SKILL_RESOURCE_FILES = ['cards.md', 'run.md', 'gates.md', 'reference.md']

/** The always-on hard rules: five of them, and nothing else. */
export const SYSTEM_RULES_NAME = 'godot-bridge:task-center-rules'

export const SYSTEM_RULES_TEXT = [
  'TASK CENTER (godot-bridge) - 5 条硬规则，任何时候都不能忘：',
  '1) 用任务中心的第一动作用 `onboard`（action: "onboard"）：它解析并绑定项目、返回 brief 和一个 next；不要自己用 openProject+board 拼接入。任务中心不再有 Team，缺团队不是拒绝码。',
  '2) create/start/reopen/delete/cancel 先问用户：返回 needs-decision（start 用 needs-consent，带 waitForUser:true、retryable:false、decisionId）不是失败：必须停下等面板答复，绝不能重试 create，也不要自己开派发。',
  '3) 评审/测试结论只能由对应阶段的 agent 给出：approveReview/requestChanges 归 reviewer，passTest/failTest 归 tester。合并与拒绝合并是用户/宿主动作，没有 merger agent。',
  '4) 任务工作只在该任务自己的 git worktree 里做，绝不直接 commit/push 到 target。',
  '5) 不要手改 .agents/tasks.json：所有改动走 task_center 动作（或面板）。',
  '需要工作流、动作矩阵和拒绝码时，先用 skill 工具加载 ' + SKILL_NAME + '。',
].join(' ')

// Role gates, not an action list: every name is filtered against the registry
// passed to buildReferenceContent, so an action removed from api.mjs cannot linger.
const REVIEW_ACTIONS = ['approveReview', 'requestChanges']
const TEST_ACTIONS = ['passTest', 'failTest']
const HARNESS_ACTIONS = ['harnessStart', 'harnessStop', 'harnessRestart', 'harnessStatus', 'harnessSmoke']
const MERGE_ACTIONS = ['mergeRequest', 'rejectMerge']
const OWNER_ACTIONS = ['submit', 'refreshMerge']

function listOf(value) {
  return Array.isArray(value) ? value.map(String) : []
}

/** Action names as inline code, so a test can find them without guessing. */
function names(list) {
  return list.map((name) => '`' + name + '`').join('、')
}

/** T-125: the task line of the brief. ONE counting text, reused by the status
 * brief and by the onboarding brief (T-129) so the two can never disagree. */
export function renderTaskLine(input) {
  const f = input === undefined || input === null ? {} : input
  const count = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)
  const parts = [
    [count(f.pending), '待办'],
    [count(f.running), '进行'],
    [count(f.reviewing), '待评审'],
    [count(f.testing), '待测试'],
    [count(f.done), '完成'],
  ]
    .filter((entry) => entry[0] > 0)
    .map((entry) => String(entry[0]) + ' ' + entry[1])
  let task = parts.length === 0 ? '无卡' : parts.join(' · ')
  const blocked = typeof f.blocked === 'string' && f.blocked.trim() !== '' ? f.blocked.trim() : null
  if (blocked !== null) task += ' · 卡住：' + blocked
  return '任务  ' + task
}

/** T-125: the status brief is exactly two lines. The blocker rides the task
 * line as a suffix and is omitted when nothing is blocked. */
export function renderStatusBrief(input) {
  const f = input === undefined || input === null ? {} : input
  const path = typeof f.path === 'string' && f.path !== '' ? f.path : '<path>'
  const branch = typeof f.branch === 'string' && f.branch !== '' ? f.branch : '<branch>'
  const head = typeof f.head === 'string' && f.head !== '' ? f.head : '<head>'
  return '项目  ' + path + ' · ' + branch + ' @ ' + head + '\n' + renderTaskLine(f)
}

/**
 * The small, always-loaded entry point. It explains who the root Agent is, the
 * first move (onboard), the next-code table, the minimal workflow, the
 * pre-split checklist, and which chapter to read before which action.
 * Everything else is deliberately out of this body.
 */
export function buildInitContent(options) {
  const opts = options === undefined || options === null ? {} : options
  const actions = listOf(opts.actions)
  const readActions = listOf(opts.readActions)
  const userOnlyActions = listOf(opts.userOnlyActions)
  const agentActions = listOf(opts.agentActions)
  const readOnly = readActions.filter((action) => userOnlyActions.indexOf(action) < 0)
  const writable = agentActions.filter((action) => readActions.indexOf(action) < 0)

  return [
    '# 任务中心入口（godot-bridge）',
    '',
    '动作只通过 `task_center` 工具发起（面板同一套 API）。',
    '',
    '## 你是谁：根 Agent',
    '',
    '拆卡/写卡、申请派发、追踪、triage 与证据都由你做；**不做**：替 worker 写实现、替 reviewer/tester 下结论、自己合并（越权报 `wrong-role` / `user-only`）。卡住先查事实（看板 / 分支 / ref / 合并记录），再 reopen / retry / 打回。',
    '',
    '执行者是根 Agent 的临时子代理；项目 board 是项目级的，每张卡由 `ownerSession` 的根 Agent spawn；`create`/`start` 不需要 Team，无常驻槽位或 merger agent。',
    '',
    '## 接入（onboard）',
    '',
    '用任务中心时先调**一次** `task_center { action: "onboard" }`：宿主解析项目根、绑定看板，返回 brief + next。',
    '',
    '1. 把 `onboard.brief` **原样**给用户：不改写、不加“我是 Lead”。',
    '2. 按 `onboard.next.code` 只做一件事：',
    '',
    '| next.code | 你做什么 |',
    '|---|---|',
    '| `choose-project` | 停下来问用户要项目路径，不要猜 |',
    '| `git-init` | 有 project.godot 但没 git：先问用户，再 `git init` |',
    '| `not-a-project` | git 仓库但没有 `.agents`/`project.godot`：征得用户同意可建空 `.agents/`，或换项目 |',
    '| `fix-host` | 按 brief 的缺项修宿主，不建卡 |',
    '| `open-owning-session` | 让用户从当前项目会话接入，不借别的会话的绑定 |',
    '| `resume-owning-session` | 回原会话继续，不建第二个根 Agent |',
    '| `takeover-active-tasks` | 用户确认后接管这些卡 |',
    '| `join-project-read-only` | 只读加入，旧卡不派发 |',
    '| `approve-start` | 请用户去面板 → 队列 批准派发 |',
    '| `triage-blocked` | 点名卡 id + 原因，请用户在面板看板处理 |',
    '| `fix-environment` | 主检出环境有问题：请用户决定保留还是清理 |',
    '| `prune-board` | 看板快满：提示归档已完成卡 |',
    '| `start-dispatch` | 有单待办但派发暂停：你申请派发，用户批准 |',
    '| `create-task` | 问用户要做什么；只建卡，不派发 |',
    '| `none` | 不需要用户动作 |',
    '',
    '3. 不要用 `openProject`+`board` 拼接入；onboard 幂等不重复调用；`choose-project` 必须**停下来问**，不擅自建卡或派发。',
    '',
    '**会话归属**：别会话的卡先做 `onboard{handoff}` 决定，决定前不建卡、不派发。',
    '',
    'brief 固定两行：',
    '',
    '```',
    '项目  <path> · <branch> @ <head>',
    '任务  3 待办 · 2 待评审 · 1 完成[ · 卡住：<原因>]（只列非零，全 0 写“无卡”）',
    '```',
    '',
    '## 最小工作流',
    '',
    '1. `create` —— title 必填；写清 spec/acceptance/writeFiles/dependsOn/priority，能机械验证的声明 `verify`。',
    '2. `start` —— 只是申请派发：等用户批准，不要自己开派发。',
    '3. `board`/`get` —— 看阶段、轮次、证据、waitingReason。',
    '4. `submit` —— 本地验证通过并提交后带 evidence。',
    '5. 宿主接管：reviewer 评审 → 候选跑 `verify` → tester 测试 → 通过且 target 未动即自动合并；打回在同一 worktree 修完再 submit。',
    '',
    '**动作前置决策**：`create`/`start`/`reopen`/`delete`/`cancel` 先问用户，回 `needs-decision`（`start` 码 `needs-consent`，带 `waitForUser`、`retryable:false`、`decisionId`）：**收到就停，别重试 create**，等面板答复。',
    '',
    '## 写卡：spec 自包含',
    '',
    'worker 看不到讨论，只看卡面：spec 至少写清要解决的问题、已确认结论、方案边界（含不做什么）、验收；不写“按商定/如上/之前说的”。模板与反例见 `cards.md`。',
    '',
    '## 拆卡前检查',
    '',
    '1. 一张卡只交付**一个独立可验收的产物**；不塞“实现 + 集成 + E2E + 迁移”。',
    '2. **按不变量/契约拆**，不按文件数或阶段切；一张卡一组 `writeFiles`。',
    '3. **拆完至少两张子卡能并行**；不能并行就先考虑合并。',
    '4. `dependsOn` 只表示逻辑前序，不用于解决文件重叠；重叠交给 `writeFiles` 锁串行。',
    '5. **纯模块卡 + 集成卡**：同文件重叠大时，模块卡先并行，集成卡（接线/E2E）后接；集成卡不重做子卡。',
    '6. acceptance/probes 在该卡 worktree 内跑得完；无独立集成产物不建 dev 总卡。',
    '',
    '## 触发表：先读再动手',
    '',
    '资源在 resourceBase，用 read 读：',
    '',
    '- 写卡/拆卡前必须先读 `cards.md` 的「卡片模板」与「拆卡与并行」',
    '- 派发/worktree 读 `run.md`',
    '- 评审/测试/合并/drift 读 `gates.md`',
    '- 动作/拒绝码读 `reference.md`',
    '',
    '当前可写动作：' + names(writable) + '。',
    '只读动作：' + names(readOnly) + '。',
  ].join('\n')
}

/**
 * The generated reference chapter. It is a resource file, not a skill; the
 * action matrix is derived from the live registry so it cannot drift.
 */
export function buildReferenceContent(options) {
  const opts = options === undefined || options === null ? {} : options
  const actions = listOf(opts.actions)
  const agentActions = listOf(opts.agentActions)
  const readActions = listOf(opts.readActions)
  const userOnlyActions = listOf(opts.userOnlyActions)
  const known = (wanted) => actions.filter((action) => wanted.indexOf(action) >= 0)

  const userOnly = known(userOnlyActions)
  const readOnly = readActions.filter((action) => userOnlyActions.indexOf(action) < 0)
  const writable = agentActions.filter((action) => readActions.indexOf(action) < 0)
  const review = known(REVIEW_ACTIONS)
  const tester = known(TEST_ACTIONS).concat(known(HARNESS_ACTIONS))
  const merger = known(MERGE_ACTIONS)
  const owner = known(OWNER_ACTIONS)

  return [
    '# 任务中心参考',
    '',
    '## 动作矩阵',
    '',
    '**只读（并发安全）**：' + names(readOnly) + '。',
    '**可写（模型侧）**：' + names(writable) + '。',
    '',
    '- `pause` 暂停/恢复**派发器**（同面板开关），不是单张卡；`start` 是申请。`tick` 立即跑一轮 settle，排查“为什么没派发”。',
    '- 归属：`submit`、`refreshMerge` 仅 assignee / 用户。',
    '- 仅评审：' + (review.length === 0 ? '（无）' : names(review)) + '；仅测试：' + (tester.length === 0 ? '（无）' : names(tester)) + '。',
    '- 仅用户（工具不暴露，agent 调用报 `user-only`）：' + names(userOnly) + '。',
    '',
    '## 读模型（一次读一个契约）',
    '',
    '- `board`：默认 **TaskSummary 分页** —— `limit`（默认 50、最大 200）+ `cursor`（上一页的 `nextCursor`），一页只有摘要卡；`view:"full"` 是诊断逃生口（detail 卡 + 宿主清单），不要拿来浏览。',
    '- `list`：与 `/list` 同形 `{ tasks, nextCursor, count }`，支持 `q`、`status`、`cursor`、`limit`、`archived`。',
    '- `get`：唯一的 detail 入口（spec/acceptance/evidence/history/writeFiles、完整 review/test/merge 记录）。',
    '- 写动作成功回 `ok`、`seq`、`affected:{ ids, count }`、`changed:[board|detail|meta|decisions]`，不再附带整块看板快照；要刷新看板就自己读 `board`（或面板的 `/state`）。',
    '',
    '## 拒绝码（可读失败，不是崩溃）',
    '',
    '- `unknown-project` / `missing-project` / `missing-path`：项目没绑定或路径不对 —— 先 `openProject`。',
    '- `needs-consent`：start 只是申请 —— 等用户批准，别重试、别自己开派发。',
    '- `needs-decision` / `status: "needs-decision"`：create/start/reopen/delete/cancel 先问用户。响应带 `waitForUser:true`、`retryable:false`、`decisionId`、`decision`、`next`（`start` 的 code 仍是 `needs-consent`，`status` 相同）：**必须停下等用户**，面板答复后宿主执行，别重试或绕行 —— 尤其绝不能重试 create，重复调用只会拿回同一个 pending decision，不会多建一张卡。',
    '- `wrong-role` / `role-required` / `worker-cannot-self-review` / `worker-cannot-self-test`：结论只属于对应角色 —— 交独立 reviewer / tester。',
    '- `user-only`：合并、拒绝合并与面板动作不属于 agent —— 报告现状。',
    '- `head-drift`：分支越过请求的 head —— `refreshMerge` 对齐。',
    '- `test-required`/`review-required`/`not-mergeable-phase`：还到不了合并，按阶段走；`target-not-advanced`：合并没推进（ref 未动），查 git 报错。',
    '- `worktree-*` / `invalid-verify`：worktree 没建好或 verify 声明不合法。',
    '- `task-cancelled` / `task-blocked`：卡已取消/阻塞 —— 立即停止。',
    '- `not-assignee` / `unknown-task`：不是你的卡或 id 不对 —— `board` 核对。',
    '',
    '## 禁区',
    '',
    '- 不手改 `.agents/tasks.json`（破坏并发保护与事件记录）。',
    '- 不直接 commit / push 到 target：只在任务 worktree 里提交自己的分支。',
    '- 不给自己的提交开守卫豁免、不改检查脚本让结果“变绿”——那是绕过评审。',
    '- 不自己发起派发（批准权在用户）；不杀用户 / 编辑器进程；不手工建删 worktree。',
    '- 不替 reviewer/tester 写结论、不伪造 evidence；任务离开 running 后宿主会中断执行者。',
    '',
    '## Godot 专属',
    '',
    '只用 `godot_*` 工具（`godot_run_headless` / `godot_run_project`）跑游戏；绝不走 pwsh/bash 跑 `godot --headless`（沙箱拦 user:// 写入，signal 11 崩）。`diagnosis:"sandbox-crash"` 是启动通道问题，用 godot_* 重跑。',
    '',
    '## 面板',
    '',
    '任务页 5 页签：`看板`、`队列`、`执行者`、`状态`、`角色`。只有用户能：批/拒派发、开关派发、改设置、管角色、代替 reviewer/tester 下结论——agent 写成“请用户操作”。',
    '',
    '## 角色分组',
    '',
    '评审 ' + names(review) + '；测试 ' + names(tester) + '；归属 ' + names(owner) + '。',
  ].join('\n')
}

/** Read one of the resource files (tests and the full guide use this). */
export function readSkillResource(name) {
  return readFileSync(join(SKILL_RESOURCE_DIR, name), 'utf8').trim()
}

/**
 * The full guide: init + all resource chapters. Production registers only
 * buildInitContent(); this combined form is for tests, docs and debugging.
 */
export function buildSkillContent(options) {
  const opts = options === undefined || options === null ? {} : options
  return [
    buildInitContent(opts),
    readSkillResource('cards.md'),
    readSkillResource('run.md'),
    readSkillResource('gates.md'),
    buildReferenceContent(opts),
  ].join('\n\n---\n\n')
}
