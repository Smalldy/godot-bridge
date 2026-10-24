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
  'TASK CENTER (godot-bridge) - 4 条硬规则，任何时候都不能忘：',
  '1) task_center 的 start 只是申请派发，返回 needs-consent 不是失败：必须等用户在任务中心面板批准，不要重试、不要自己开派发。',
  '2) 评审/测试结论只能由对应角色的 agent 给出：approveReview/requestChanges 归 reviewer，passTest/failTest 归 tester，mergeRequest/rejectMerge 归 merger 或用户。',
  '3) 任务工作只在该任务自己的 git worktree 里做，绝不直接 commit/push 到 target。',
  '4) 不要手改 .agents/tasks.json：所有改动走 task_center 动作（或面板）。',
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
    '动作只通过 `task_center` 工具发起（面板走同一套 API）。',
    '',
    '## 你是谁：Lead',
    '',
    '本会话里你扮演 **Lead**，不是 worker / reviewer / tester 中的任何一个。',
    '',
    '- **你做**：拆卡、写卡、申请派发、追踪进度、triage 异常、把需要人的步骤走对话、结束时给证据。',
    '- **你不做**：不替 worker 写实现、不替 reviewer 下评审结论、不替 tester 下测试结论、不合并。越权会被 `wrong-role` / `merger-only` / `tester-only` / `user-only` 拒绝——那是分权，不是故障。',
    '- **卡住先去查事实**：看板、分支、ref、合并记录，再决定 reopen / retry / 打回；不要用"直接改"绕过（见禁区）。',
    '',
    '系统里还有：**worker**（在任务 worktree 里实现）、**reviewer**（只读评审）、**tester**（只读测试，可用隔离 harness）、**merger**（用户或名为 `merger` 的成员）、**用户**（唯一能批准派发、改设置、管角色、代替任何角色下结论）。角色缺失由宿主经活的 Lead 自动 provision。',
    '',
    '## 进入流程',
    '',
    '用户敲 `/godot-bridge-task-center` 或开新会话时：',
    '',
    '1. 解析项目根：会话工作区向上找最近的 git 根，且含 `.agents/` 或 `project.godot`；两者指向不同层时**停下来问**，不要凭空建板。',
    '2. `openProject` 指到该路径（幂等，重复执行只刷新）。',
    '3. `board` 后按固定模板输出简报。',
    '4. **不要**自动 `start`、不要自动建卡、不要改配置。',
    '',
    '```',
    '项目：<path> · 目标：<branch> @ <head>',
    '身份：你是 Lead（<name>）',
    '派发：running / paused（paused 说明需要用户在面板批准）',
    '任务：完成 n / 总 n ｜ 就绪 n · 实现中 n · 评审中 n · 测试中 n · 阻塞 n',
    '在途：<id> <标题> · <阶段>',
    '下一步：<一句>',
    '```',
    '',
    '## 何时用 / 不用',
    '',
    '- 用：活能拆成多项、要排期或并行；要独立评审 + 测试的门禁；多会话改同一仓库要文件锁；要留痕（证据、轮次）。',
    '- 不用：只想看现状就用 `board` / `get` / `locks`。',
    '- **任何改动都不要直接提交 target**：短活也用一张卡走完；真应急就走独立 hotfix 分支，并在 `scripts/check-target-history.mjs` 里登记例外。',
    '',
    '## 最小工作流',
    '',
    '1. `openProject`（项目不是会话工作区时）。',
    '2. `create` —— title 必填；写清 spec / acceptance / writeFiles / dependsOn / priority；能机械验证的声明 `verify`。',
    '3. `start` —— 只是申请：返回 needs-consent + request，等用户批准，不要重试或绕行。',
    '4. `board` / `get` —— 看阶段、轮次、证据、waitingReason（为什么还没跑）。',
    '5. `submit` —— 本地验证通过并提交后带 evidence。',
    '6. 宿主接管：reviewer 评审 → 候选跑 `verify` → tester 测试 → 通过且 target 未动即自动合并；被打回在同一 worktree 修完再 submit。',
    '   - 漂移自动处理：target 前进但分支 head 未动（仅 base 变化）→ 宿主重建候选后直接合并，evidence 记「仅 base 变化，diff 与已验证提交一致」，不新增评审轮次；内容变了必须重走评审+测试。',
    '   - 构建期冲突不再抛给人工：候选与 target 冲突会标 candidate-stale（附冲突文件清单）并自动重建；再次冲突升级 needs-rebase（保留清单），等待 worker/Lead，不阻塞其他卡。',
    '   - 已知边界：自动漂移判定只认真实 hex commit base；夹具/手写板里的 base-sha 之类标签保持旧行为。',
    '',
    '## 动作矩阵',
    '',
    '**只读（并发安全）**：' + names(readOnly) + '。',
    '**可写（模型侧）**：' + names(writable) + '。',
    '',
    '- `pause` 暂停/恢复**派发器**（等同面板开关），不是暂停单张卡；`start` 是申请，不是开关。',
    '- `tick` 让调度器立即跑一轮 settle——排查"为什么没派发"时用。',
    '- 归属：`submit`、`refreshMerge` 仅 assignee / 用户 / merger。',
    '- 仅评审：' + (review.length === 0 ? '（无）' : names(review)) + '；仅测试：' + (tester.length === 0 ? '（无）' : names(tester)) + '；仅合并：' + (merger.length === 0 ? '（无）' : names(merger)) + '。',
    '- 仅用户（工具不暴露，agent 调用报 `user-only`）：' + names(userOnly) + '。',
    '',
    '## 写卡规范',
    '',
    '- spec 自包含：目标、背景代码、要求、测试方法、验收标准；acceptance 可判定。',
    '- writeFiles 就是锁：派发前原子加锁，没有手动锁动作；漏写会互踩，多写会白等。',
    '- `verify` 可选：宿主机在候选里执行声明的 shell 命令（可链式），结果记在 test.hostCheck；失败回 running，不占 tester 轮次。',
    '- `dependsOn` = 前序完成且已合并；`priority` 只在 ready 任务间比较；`maxAttempts` 用尽后 blocked。',
    '- 每张卡可带自己的 `target`：卡可以跑在别的分支上（热修赛道），跨 target 的 `dependsOn` 会被拒绝。',
    '- 改卡用 `update`（可清 `verify`），不要删了重建。',
    '',
    '## 派发与中断',
    '',
    '- **宿主重启不消耗尝试**：宿主重启 / 插件重载把 running 卡收回时，这次 attempt 会**退还**（`attempts` 不变），只累加独立的 `interruptions` 计数并写一条「interrupted by host restart; attempt refunded」的历史 —— 那是基础设施事件，不是执行者失败。只有连续 5 次中断且**始终没有提交**才会 blocked（错误码 `interrupted-too-often`）。',
    '- **一卡只允许一个活执行者**：重派发（含重试、重开、租约回收）会先中断/退休这张卡此前的执行者；若旧执行者仍活着且停不下来，则拒绝第二次派发（`already-dispatched`）。`get` / `board` 的 `liveExecutors` 是这张卡当前活执行者数量，正常恒为 1（running）或 0（其它状态）。',
    '- 重派发会优先复用上一次 attempt 那个**干净且没有提交**的 worktree，不再为同一张卡反复新建目录；有提交则继续那个分支。',
    '',
    '## 机械验证与测试证据',
    '',
    '- `verify` 由卡声明；评审通过、候选建好后宿主自己跑。失败或超时 = 宿主记 failTest，任务回 running、候选丢弃。',
    '- tester 证据分两段：【宿主基线】与【我的探针】——基线是下限不是上限。',
    '- reviewer 不必重跑测试：declared vs actual 与上次 hostCheck 已附在 brief 里。',
    '- 面板活动流显示宿主写入的成员名（用户「你」，解析不出的 id 按角色词回落）；测试事件行是结构化摘要「通过/失败 · exit N · Ns」，全文在「查看全文」。',
    '',
    '## 串联规则',
    '',
    '- **角色槽位串行**：一个 reviewer / tester 槽位一次只处理一张卡，其余带 `queuePosition` 排队；排队的轮次不计入"沉默"判定。',
    '- **`merged` = ref 真的前进了**：宿主在推进后重读 `refs/heads/<target>`，不等于期望的 merge sha 就返回 `target-not-advanced`，任务停在 testing，绝不标 merged。',
    '- **target 动了结论失效**：测试后目标前进，候选与结论作废，需要 `refreshMerge` 重开一轮。',
    '',
    '## 拒绝码（可读失败，不是崩溃）',
    '',
    '- `unknown-project` / `missing-project` / `missing-path`：尚未绑定项目或路径不对 —— 先 `openProject`。',
    '- `needs-consent`：start 只记录了申请 —— 等用户批准，不要重试。',
    '- `role-cannot-implement`：reviewer / tester 不能 submit 实现 —— 交回 worker。',
    '- `wrong-role` / `role-required` / `worker-cannot-self-review` / `worker-cannot-self-test`：结论只属于对应角色 —— 交独立 reviewer / tester。',
    '- `merger-only` / `user-only`：合并与面板动作不属于你 —— 报告现状即可。',
    '- `head-drift`：分支越过请求记录的 head —— `refreshMerge` 重新对齐。',
    '- `test-required` / `review-required` / `not-mergeable-phase`：还到不了合并 —— 按阶段继续走。',
    '- `target-not-advanced`：合并推进没成功（ref 未动）—— 查 git 报错，不要当已合并。',
    '- `worktree-*` / `invalid-verify`：worktree 没建好、工作区脏，或 verify 声明不合法。',
    '- `task-cancelled` / `task-blocked`：卡已取消/阻塞，宿主已中断执行者 —— 立即停止。',
    '- `not-assignee` / `unknown-task`：不是你的卡或 id 不对 —— `board` 核对。',
    '',
    '## 禁区',
    '',
    '- 不手改 `.agents/tasks.json`（破坏并发保护与事件记录）。',
    '- 不直接 commit / push 到 target：只在任务 worktree 里提交自己的分支。',
    '- 不给自己的提交开守卫豁免、不改检查脚本让结果"变绿"——那是绕过评审。',
    '- 不自己发起派发（批准权在用户）；不杀用户 / 编辑器进程；不手工建删 worktree。',
    '- 不替 reviewer / tester 写结论，不伪造 evidence。',
    '- 任务离开 running 后宿主会中断执行者；interrupt 在下一个 step 边界生效，是"尽快停"而不是"瞬间停"。',
    '',
    '## Godot 专属',
    '',
    '启动游戏只用 `godot_*` 工具（`godot_run_headless` / `godot_run_project`）；绝不能走 pwsh / bash 跑 `godot --headless` —— 沙箱会拦 user:// 日志写入，进程 signal 11 崩掉。`diagnosis:"sandbox-crash"` 是启动通道问题，改用 `godot_*` 重跑。',
    '',
    '## 面板',
    '',
    '任务页 5 个页签：`看板`、`队列`、`执行者`、`状态`、`角色`（内置只读，Fork 副本可改）。只有用户能做：批/拒派发、开关派发、改设置、管角色 profile 与实例、代替 reviewer / tester / merger 下结论 —— agent 写成"请用户操作"。',
  ]

  return lines.join('\n')
}