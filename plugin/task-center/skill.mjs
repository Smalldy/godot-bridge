/**
 * The task center's runtime skill — the model-facing "what this board is, when
 * to use it, how to use it" guide. The plugin registers it with the host skill
 * catalog, so a session loads it on demand instead of every task_center tool
 * call carrying kilobytes of narrative prose.
 *
 * The body is generated from the action registry (api.mjs) it is handed: no
 * action list is copied by hand here. A new action lands in the writable list
 * automatically, a removed one disappears. That is the point of this module —
 * the guide and the API cannot drift apart.
 */

/** The skill's identity in the host catalog (and the name the tool points at). */
export const SKILL_NAME = 'godot-bridge-task-center'

/** One sentence, for routing: the catalog shows this before the body is read. */
export const SKILL_DESCRIPTION =
  '任务中心使用指南：项目任务板、依赖派发、文件锁与评审/测试/合并流水线的工作流、动作矩阵、写卡规范与拒绝码。'

/** When a session should load this skill. */
export const SKILL_WHEN_TO_USE =
  '要给工作排期或并行、需要独立评审与测试门禁、或多个工作者同时改同一仓库时；第一次调用 task_center 之前读它。'

/** The always-on hard rules: four of them, and nothing else. */
export const SYSTEM_RULES_NAME = 'godot-bridge:task-center-rules'

export const SYSTEM_RULES_TEXT = [
  'TASK CENTER (godot-bridge) - 5 条硬规则，任何时候都不能忘：',
  '1) 用任务中心的第一动作用 `onboard`（action: "onboard"）：它解析并绑定项目、缺团队自动补，返回 brief 和一个 next；不要自己用 openProject+board 拼接入。`create`/`start` 返回 no-team-for-project 时照 nextStep.instruction 做（bootstrapTeam），不要建卡、不要借别的项目的团队、也不要叫别的会话来建。',
  '2) task_center 的 start 只是申请派发，返回 needs-consent 不是失败：必须等用户在任务中心面板批准，不要重试、不要自己开派发。',
  '3) 评审/测试结论只能由对应角色的 agent 给出：approveReview/requestChanges 归 reviewer，passTest/failTest 归 tester，mergeRequest/rejectMerge 归 merger 或用户。',
  '4) 任务工作只在该任务自己的 git worktree 里做，绝不直接 commit/push 到 target。',
  '5) 不要手改 .agents/tasks.json：所有改动走 task_center 动作（或面板）。',
  '需要工作流、动作矩阵和拒绝码时，先用 skill 工具加载 ' + SKILL_NAME + '。',
].join(' ')

// Role gates, not an action list: every name is filtered against the registry
// passed to buildSkillContent, so an action removed from api.mjs cannot linger.
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
  return list.map((name) => '\`' + name + '\`').join('、')
}

/**
 * Build the skill body from the live action registry.
 *
 * @param options.actions - every action the API exposes (api.mjs ACTIONS).
 * @param options.agentActions - what the tool exposes (ACTIONS minus USER_ONLY).
 * @param options.readActions - the concurrency-safe reads.
 * @param options.userOnlyActions - the actions only the person at the GUI owns.
 * @returns the markdown body the skill tool hands to the model.
 */
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

export function buildSkillContent(options) {
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

  const lines = [
    '# 任务中心（godot-bridge）',
    '',
    '动作只通过 `task_center` 工具发起（面板同一套 API）。',
    '',
    '## 你是谁：Lead',
    '',
    '本会话里你扮演 **Lead**，不是 worker / reviewer / tester 中的任何一个。',
    '',
    '- **你做**：拆卡/写卡、申请派发、追踪、triage、给证据。**不做**：替 worker 写实现、替 reviewer/tester 下结论、合并。越权会被 `wrong-role` / `merger-only` / `tester-only` / `user-only` 拒绝——那是分权。',
    '- **卡住先查事实**：看板、分支、ref、合并记录，再决定 reopen / retry / 打回。',
    '',
    '还有 worker/reviewer/tester/merger/用户（用户专属：批派发、改设置、管角色、下结论）；角色缺失由宿主经活的 Lead 自动 provision。',
    '',
    '## 先有团队，再建卡',
    '',
    '- `onboard` 默认补团队（Lead + worker）；reviewer/tester 到阶段再补。失败按 next 报告，不借别的项目团队。`create`/`start` 缺团队仍拒 `no-team-for-project`。',
    '',
    '## 接入（onboard）',
    '',
    '用任务中心时先调**一次** `task_center { action: "onboard" }`：宿主解析项目根、查 git/Godot 标记、绑定看板，缺团队自动补，返回 brief + next。',
    '',
    '1. 把 `onboard.brief` **原样**给用户：不改写、不加“我是 Lead”。',
    '2. 按 `onboard.next.code` 只做一件事：',
    '',
    '| next.code | 你做什么 |',
    '|---|---|',
    '| `choose-project` | 停下来问用户要项目路径，不要猜 |',
    '| `git-init` | 有 project.godot 但没 git：先问用户，再 `git init` |',
    '| `not-a-project` | git 仓库但没有 project.godot/.agents：要 path，不建板 |',
    '| `fix-host` | 按 brief 的缺项修宿主，不建卡 |',
    '| `open-owning-session` | 让用户从拥有该项目的会话接入，不借别的团队 |',
    '| `bootstrap-team` | 团队自动建失败：按 brief 报告，不要求用户手工建 |',
    '| `approve-start` | 请用户去面板 → 队列 批准派发 |',
    '| `triage-blocked` | 点名卡 id + 原因，请用户在面板看板处理 |',
    '| `fix-environment` | 主检出环境有问题：请用户决定保留还是清理 |',
    '| `prune-board` | 看板快满：提示归档已完成卡 |',
    '| `start-dispatch` | 有单待办但派发暂停：你申请派发，用户批准 |',
    '| `create-task` | 问用户要做什么；只建卡，不派发 |',
    '| `none` | 不需要用户动作 |',
    '',
    '3. 不要用 `openProject`+`board` 自己拼接入；onboard 幂等，路径与任务没变时不重复调用。`choose-project` 必须**停下来问**，不要猜；其余 next 照做，不擅自建卡或派发。',
    '',
    'brief 的前两行固定为项目与任务（onboard 已生成完整 brief，直接用它）：',
    '',
    '```',
    '项目  <path> · <branch> @ <head>',
    '任务  3 待办 · 2 待评审 · 1 完成[ · 卡住：<原因>]（只列非零，全 0 写“无卡”）',
    '```',
    '',
    '## 何时用 / 不用',
    '',
    '- 用：并行/排期、独立评审 + 测试门禁、多会话文件锁、留痕；只看现状用 `board` / `get` / `locks`。短活也走卡，应急 hotfix 在 `scripts/check-target-history.mjs` 登记例外。',
    '',
    '## 最小工作流',
    '',
    '1. `create` —— title 必填；写清 spec/acceptance/writeFiles/dependsOn/priority，能机械验证的声明 `verify`。',
    '2. `start` —— 只是申请：needs-consent + request，等用户批准，不要重试或绕行。',
    '3. `board`/`get` —— 看阶段、轮次、证据、waitingReason。4. `submit` —— 本地验证通过并提交后带 evidence。',
    '5. 宿主接管：reviewer 评审 → 候选跑 `verify` → tester 测试 → 通过且 target 未动即自动合并；被打回在同一 worktree 修完再 submit。',
    '   - 漂移：只换 base（head 没动）→ 宿主重建候选直接合并，不新增轮次；内容变了重走评审+测试。',
    '   - 冲突：候选与 target 冲突自动重建；再次冲突升级 needs-rebase，等 worker/Lead。判定只认真实 hex base。',
    '',
    '## 调查卡（investigate）',
    '',
    '- 什么时候用：只要答案/定位/对比，不交付可合并代码（要改产品开 dev 卡），`create` 带 `kind: "investigate"`（writeFiles 只是提示不拿锁，verify 不设门禁、不跑 hostCheck）；生命周期 待办→进行→完成，**没有评审/测试/合并**，`submit` 拒 `investigation-report-only`、评审/测试/合并动作拒 `not-a-dev-task`。',
    '- 执行：派发到 detached scratch（无分支）；可跑命令、改代码，但**不 commit、不 submit、不 merge**；需要第二份 checkout 只用 `probe-<id>-*`，宿主会清掉。',
    '- 交付：`task_center { action: "report", id, summary, body, evidence? }`。summary 是结论（≤4 KB）；body 是给人看的完整报告（≤64 KB，全文 `.agents/reports/<id>.md`）；evidence 是 `{ command, exitCode, outputTail }` 数组（≤20 条）；artifacts 列探测 checkout 的路径。',
    '- 写法：结论以证据为准（命令、exit code、输出尾部、复现步骤），没有 `report` 不算完成；面板看板有「调查」标记/类型筛选/「调查中 N」，详情只有「执行 → 交付」+ 报告。',
    '',
    '## 动作矩阵',
    '',
    '**只读（并发安全）**：' + names(readOnly) + '。',
    '**可写（模型侧）**：' + names(writable) + '。',
    '',
    '- `pause` 暂停/恢复**派发器**（同面板开关），不是单张卡；`start` 是申请。`tick` 立即跑一轮 settle，排查“为什么没派发”。',
    '- 归属：`submit`、`refreshMerge` 仅 assignee / 用户 / merger。',
    '- 仅评审：' + (review.length === 0 ? '（无）' : names(review)) + '；仅测试：' + (tester.length === 0 ? '（无）' : names(tester)) + '；仅合并：' + (merger.length === 0 ? '（无）' : names(merger)) + '。',
    '- 仅用户（工具不暴露，agent 调用报 `user-only`）：' + names(userOnly) + '。',
    '',
    '## 写卡规范',
    '',
    '- spec 自包含（目标/背景代码/要求/测试方法/验收），acceptance 可判定；writeFiles 就是锁：派发前原子加锁，漏写互踩、多写白等。',
    '- `verify` 可选：宿主在候选里跑声明的 shell，结果记 test.hostCheck；失败回 running，不占 tester 轮次。',
    '- `dependsOn` 前序完成且已合并；`priority` 只在 ready 间比较；`maxAttempts` 用尽 blocked；每卡可带 `target`（跨 target 依赖会被拒）；改卡用 `update`。',
    '',
    '## 派发与中断',
    '',
    '- **重启不消耗尝试**：收回 running 卡时 attempt **退还**，只累加 `interruptions`；连续 5 次中断且没提交才 blocked（`interrupted-too-often`）。',
    '- **一卡一个活执行者**：重派发先中断旧执行者，停不下来就拒（`already-dispatched`），`liveExecutors` 正常 0/1；优先复用上次干净未提交的 worktree。',
    '',
    '## 机械验证与测试证据',
    '',
    '- `verify` 由卡声明，评审通过后宿主在候选里跑；失败/超时 = 宿主记 failTest，回 running、候选丢弃。',
    '- tester 证据分【宿主基线】【我的探针】——基线是下限；reviewer 不必重跑（declared vs actual 与 hostCheck 已在 brief 里）。面板活动流显示成员名，测试行是摘要「通过/失败 · exit N · Ns」。',
    '',
    '## 串联规则',
    '',
    '- **槽位串行**：一个 reviewer / tester 槽位一次一张卡，其余 `queuePosition` 排队，不计沉默；`merged` = ref 真的前进了（`target-not-advanced` 就停在 testing）。',
    '- **target 动了结论失效**：用 `refreshMerge` 重开一轮。',
    '',
    '## 拒绝码（可读失败，不是崩溃）',
    '',
    '- `unknown-project` / `missing-project` / `missing-path`：项目没绑定或路径不对 —— 先 `openProject`。',
    '- `needs-consent`：start 只是申请 —— 等用户批准，别重试。',
    '- `role-cannot-implement`：reviewer / tester 不能 submit 实现 —— 交回 worker。',
    '- `wrong-role` / `role-required` / `worker-cannot-self-review` / `worker-cannot-self-test`：结论只属于对应角色 —— 交独立 reviewer / tester。',
    '- `merger-only` / `user-only`：合并与面板动作不属于你 —— 报告现状。',
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
    '- 不给自己的提交开守卫豁免、不改检查脚本让结果"变绿"——那是绕过评审。',
    '- 不自己发起派发（批准权在用户）；不杀用户 / 编辑器进程；不手工建删 worktree。',
    '- 不替 reviewer/tester 写结论、不伪造 evidence；任务离开 running 后宿主会中断执行者。',
    '',
    '## Godot 专属',
    '',
    '只用 `godot_*` 工具（`godot_run_headless` / `godot_run_project`）跑游戏；绝不走 pwsh/bash 跑 `godot --headless`（沙箱拦 user:// 写入，signal 11 崩）。`diagnosis:"sandbox-crash"` 是启动通道问题，改用 godot_* 重跑。',
    '',
    '## 面板',
    '',
    '任务页 5 个页签：`看板`、`队列`、`执行者`、`状态`、`角色`（内置只读，Fork 可改）。只有用户能：批/拒派发、开关派发、改设置、管角色、代替 reviewer/tester/merger 下结论——agent 写成“请用户操作”。',
  ]

  return lines.join('\n')
}