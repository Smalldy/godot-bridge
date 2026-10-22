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
    '动作只通过 \`task_center\` 工具发起（面板走同一套 API）。',
    '',
    '## 定位',
    '',
    '项目级任务板 + 依赖派发 + 文件锁 + 评审/测试/合并流水线。一张卡 = 一个可派发工作项；调度器只在派发开启时按 priority 取 ready 任务。每个任务在自己的 git worktree（\`.worktrees/<id>\`）里做。worker / reviewer / tester 只看得到卡片和自己的 worktree。',
    '',
    '## 何时用 / 不用',
    '',
    '- 用：活能拆成多项、要排期或并行；要独立评审 + 独立测试的门禁；多会话改同一仓库要文件锁；要留痕（证据、打回轮次）。',
    '- 不用：一次性小改动直接改，开卡会多出五个环节；只看现状用 \`board\` / \`get\` / \`locks\`。',
    '',
    '## 最小工作流',
    '',
    '1. \`openProject\` —— 项目不是会话工作区时先切。',
    '2. \`create\` —— title 必填；写清 spec / acceptance / writeFiles / dependsOn / priority；能机械验证的声明 \`verify\`。',
    '3. \`start\` —— 只是申请：返回 needs-consent + request，等用户批准，不要重试或换动作绕过。',
    '4. \`board\` / \`get\` —— 看阶段、轮次、证据、waitingReason（为什么还没跑）。',
    '5. \`submit\` —— 本地验证通过并提交后带 evidence 提交。',
    '6. 宿主接管：reviewer 评审 → 候选里跑 \`verify\` → tester 测试 → 通过且 target 未动即自动合并；被打回在同一 worktree 修完再 submit。',
    '',
    '## 动作矩阵',
    '',
    '**只读（并发安全）**：' + names(readOnly) + '。',
    '**可写（模型侧）**：' + names(writable) + '。',
    '',
    '- 归属：' + names(owner) + ' —— 仅 assignee / 用户 / merger。',
    '- 仅评审：' + (review.length === 0 ? '（无）' : names(review)) + ' —— reviewer 或用户；越权 wrong-role / role-required，自评 worker-cannot-self-review。',
    '- 仅测试：' + (tester.length === 0 ? '（无）' : names(tester)) + ' —— tester 或用户；越权 tester-only / role-required，自测 worker-cannot-self-test。',
    '- 仅 merger：' + (merger.length === 0 ? '（无）' : names(merger)) + ' —— 用户或名为 \`merger\` 的成员，其他 agent 一律 merger-only。',
    '',
    '**仅用户（工具不暴露，agent 调用一律 user-only）**：' + names(userOnly) + '。',
    '',
    'skillsCatalog 只读；roles* 管理 \`.agents/roles.json\`。',
    '',
    '## 写卡规范',
    '',
    '- spec 自包含：目标、背景代码、要求、测试方法、验收标准；acceptance 可判定。',
    '- writeFiles 就是锁：派发前原子加锁，没有手动锁动作；漏写会互踩，多写会白等。',
    '- \`verify\` 可选：宿主机在候选里执行声明的 shell 命令（可链式，默认 10 分钟上限），结果记在 test.hostCheck；失败直接回 running，不占 tester 轮次。',
    '- dependsOn = 前序“完成且已合并”；priority 只在 ready 任务间比较；maxAttempts 用尽后 blocked。',
    '- 改卡用 \`update\`（可清 \`verify\`），不要删了重建。',
    '',
    '## 机械验证与测试证据',
    '',
    '- \`verify\` 由卡声明（create/update 字段）：评审通过、候选建好后宿主机自己跑。失败或超时 = 宿主记 failTest，任务回 running，候选丢弃，不产生 tester 轮次；成功则 tester 收到基线。',
    '- tester 证据分两段：【宿主基线】（宿主跑了什么、退出码、尾部）与【我的探针】（我设计并执行的边界/行为/验收探针）。基线不是 tester 的结论；怀疑 flaky 或环境差异可说明理由复跑，也可跑别的套件——基线是 floor 不是 ceiling。',
    '- reviewer 不必重跑测试：declared vs actual 与上次 hostCheck 已附在 brief 里。',
    '- 面板：活动流事件行显示宿主写入的成员名（byName，用户「你」）；测试事件行是结构化摘要「通过/失败 · exit N · Ns」，证据全文在「查看全文」；每行按事件自身裁决显示（fail-then-pass 里旧失败行仍是失败）。',
    '',
    '## 拒绝码（可读失败，不是崩溃）',
    '',
    '- \`unknown-project\` / \`missing-project\`：路径不对 —— \`openProject\` 指到项目根。',
    '- \`needs-consent\`：start 只记录了申请 —— 等用户批准，不要重试。',
    '- \`role-cannot-implement\`：reviewer / tester 不能 submit 实现 —— 交回 worker。',
    '- \`wrong-role\` / \`role-required\` / \`worker-cannot-self-review\` / \`worker-cannot-self-test\`：结论只能由对应角色（或用户）记录 —— 交给独立 reviewer / tester。',
    '- \`merger-only\`：只有用户或 \`merger\` 能合并/拒绝 —— worker 报告完成即可。',
    '- \`user-only\`：面板上的用户动作（批派发、设置、角色管理、技能目录）—— 请用户操作。',
    '- \`head-drift\`：分支越过请求记录的 head —— 用 \`refreshMerge\` 重新对齐再走评审。',
    '- \`test-required\` / \`review-required\` / \`not-mergeable-phase\`：还到不了合并 —— 按阶段继续走。',
    '- \`worktree-*\` / \`invalid-verify\`：worktree 没建好、工作区不干净，或 verify 声明不合法 —— 先修正再重试。',
    '- \`not-assignee\` / \`unknown-task\`：不是你的卡或 id 不对 —— 用 \`board\` 核对。',
    '',
    '## 禁区',
    '',
    '- 不手改 \`.agents/tasks.json\`（会破坏并发保护与事件记录）。',
    '- 不直接 commit / push 到 target：只在任务 worktree 里提交自己的分支。',
    '- 不自己发起派发（批准权在用户）；不杀用户 / 编辑器进程（尤其 Godot）；不手工建删 worktree 或合并分支。',
    '- 不替 reviewer / tester 写结论，不伪造 evidence。',
    '',
    '## Godot 专属',
    '',
    '启动游戏只能用 \`godot_*\` 工具（\`godot_run_headless\` 有界无头、\`godot_run_project\` 交互）；绝不能走 pwsh / bash 跑 \`godot --headless\` —— 沙箱会拦它的 user:// 日志写入，进程以 signal 11 崩掉。godot_* 报 \`diagnosis:"sandbox-crash"\` 是启动通道问题，改用 godot_* 重跑。',
    '',
    '## 面板（任务页 5 个页签）',
    '',
    '\`看板\`（七列）、\`队列\`、\`执行者\`、\`状态\`（一句话状态 + 三卡 + 整宽活动流）、\`角色\`（内置只读，Fork 副本可改）。页签不带计数。只有用户能做：批/拒派发、开关派发、改设置、管角色 profile 与实例、看技能目录、代替 reviewer/tester/merger 下结论 —— agent 写成“请用户操作”。',
    '',
    '## 角色与流水线',
    '',
    '- 角色：内置 worker / reviewer / tester 只读不可改（分别绑定 implement / review / test），要改就 Fork 副本（保存即创建 + 绑定 + 替换在跑实例）；缺失角色由宿主经活的 Lead 自动 provision，死掉/超时的自动替换。',
    '- 评审：进入评审时宿主发按轮次 brief（spec/acceptance、diff、声明文件 vs 真实改动、evidence、评审清单）；reviewer 只读，只能 \`approveReview\` 或带 reasons 的 \`requestChanges\`。',
    '- 测试：评审通过后宿主建候选 worktree，provision tester 并发测试 brief（验收标准、候选路径/分支、测试计划、证据格式）；tester 对实现只读，\`passTest\` / \`failTest\` 必须带证据；测试后 target 动了结论失效，重建候选并重跑 \`verify\`。',
    '- 合并：\`passTest\` 且 target 未动则宿主立即合并并置 done；\`mergeRequest\` / \`rejectMerge\` 是手动入口（merger-only）；\`refreshMerge\` 重指请求到分支 head 并开新一轮评审（不提交/不合并/不推送）。',
    '- 隔离测试实例（tester 或用户）：harness 起临时 DSH 实例（独立 profile/端口/项目副本，不碰生产环境），用于真实页面视觉验证与冒烟；版本不一致报 version-mismatch。',
    '- 角色 prompt 模板可注入 \`{{TASK_ID}}\` \`{{SPEC}}\` 等 9 个变量，其他 \`{{NAME}}\` 以 invalid-role-variable 拒绝；固定头部由宿主生成。\`skillsCatalog\` 缺服务时报 skills-unavailable。',
    '',
  ]

  return lines.join('\n')
}