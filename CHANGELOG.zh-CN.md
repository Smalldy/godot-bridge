# 更新日志

本文件记录本项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- **执行者页按三层结构重建（T-137）**：现在一眼能回答「哪个项目 / 哪个 Team / 谁在做什么」。Team 头显示面板项目、会话 Team 及其项目、Lead（Lead 名本身就是 `session-…` 时显示「本会话 Lead」+ 短 id + 复制按钮，不再铺整串原始 id）与会话短 id（完整 id 只在 `title`/复制里）；容量 chips——`并发 N` 来自 `snapshot.dispatch.maxConcurrent`，`上限 N` 来自 `workers.cap`（`maxWorkAgents` 硬上限；仅当宿主没有该字段时才用 `workerCap`）——外加 live 的 执行中 / 空闲 / 启动中 / 失败。`workers.projectMatch === false` 时给一条克制警告：这些执行者属于请求会话在另一个项目的 Team，绝不静默。原 5 列角色表换成 3 张（有 merger 时 4 张）紧凑卡，只显示 live 的 `执行中 / 空闲 / 有卡 / 队列`，不再有「已配置实例数」——团队规模是派发设置（T-138）。成员列表合并为一张表：角色 · 成员 · 状态 · 当前任务 · 队列；角色 badge 来自 `member.kind`，成员名 mono 截断、title 全名，队列独立成列，空闲成员的当前任务只显示「待命」而不再重复长句。样式只用 T-133 token；角色卡用 `auto-fit` 自动换行，表格在自己的容器内滚动，约 579px 窄面板不会撑破页面。角色编辑页移除了实例数输入，角色页明确「团队规模由派发设置决定」。
- **执行者团队的项目归属显式化（T-139）**：`/state` 现在给 `workers` 与 `team` 增加 `project`（所展示 Team 的 Lead 会话的 workspace 项目根；未知为 `null`）与 `projectMatch`（等于本次快照项目为 `true`，属于别的项目为 `false`，会话项目无法解析为 `null`）。T-122/T-130 语义不变——成员表仍是**请求会话**的 Team，绝不按项目切换、也没有缓存——只是消除 T-136 背后的静默歧义：面板 pin 项目 A、而会话属于项目 B 时，现在返回 `workers.project = B`、`workers.projectMatch = false`、`team.project = B`、`team.projectMatch = false`，不再给出没有归属的 Team。装饰在 snapshot 里完成（用 `requesterRootOf`/`projectIdOf`），`workerPool` 仍是纯会话读取、不带项目字段。消费这两个字段的面板警告由 T-137 负责。
- **团队规模移出角色定义（T-138）**：角色 profile 现在只描述**行为**（name/role/stage/prompt/skills/context/permissions），不再带 `instances`。worker 池目标就是派发上限——`min(dispatch.maxConcurrent, dispatch.maxWorkAgents)`——以 `workers.workerCap` / `workers.effectiveWorkerCap` 暴露，旁边的 `workers.cap` 是硬上限 `maxWorkAgents`，另有 `workers.maxConcurrent`。派发从 1 个 worker 起步：有 ready 卡在等且未到 cap 时，每个 pass 只补 1 个；池满时以 `role-full` 回答并带上 cap/live/busy 数字。评审/测试每个会话团队固定 1 个实例（`ensureStageRoles` 传 `count: 1`，阶段队列容量为 1），`bootstrapTeam` 仍只建 1 个 worker。`ensureRole(kind, { count })` 现在由调用方给规模，`workers.roles.desired` 来自派发上限而不是 profile。旧的 `.agents/roles.json` 仍可读取：`instances`/`concurrency` 字段被丢弃、绝不参与调度，并在快照里标记 `deprecated: { instances: 'ignored', movedTo: 'dispatch.maxConcurrent / dispatch.maxWorkAgents' }`；角色配置版本升到 2，保存时写回干净结构。角色 API 对旧客户端传来的 `instances` 接受但忽略，并返回同样的 `deprecated` 标记。
- **看板卡片裁决区样式（T-140）**：卡片上的评审/测试裁决块不再是把两个裸按钮贴在 meta 下面——现在有自己的分隔与节奏：`0.5px` 上边框 + `10px` 内边距、11px 的安静标题、8px 间距的按钮行，以及两个等宽 30px 按钮。通过评审/测试是卡片的**主操作**（品牌蓝实心），打回/失败保持红色 danger 描边。展开理由表单后依次是小号 secondary label、全宽 token 化 textarea（最小 64px、8px 圆角、可纵向拉伸）和同样的等宽提交/取消行。卡片本身改为 `10px 11px` 内边距、7px 间距，让标题、meta 与裁决区呼吸一致。只用 T-133 的 token，不改交互与 DOM。
- **窄面板下的看板滚动（T-135）**：看板现在是自己的有界横向滚动容器——`.gbt-boardwrap` 变成 `height:100%`/`min-height:0` 的 flex 列，`.gbt-board` 自己承担溢出滚动（`flex:1 1 auto;min-height:0;overflow:auto`，细滚动条使用主题 token），`.gbt-cards` 可收缩（`flex:1 1 auto;min-height:0`），列内纵向滚动真正生效。kind filter 留在滚动容器上方，不会被横向滚走。新增 `useEffect`（配纯函数 `tcFirstNonEmptyColumn`）：任务数量或 kind filter 变化后把看板停到第一个有卡的列（目标已完整可见则不动，全空回到最左），所以全 done 的板子会直接打开在 131 张卡的『完成』列，而不是一屏空列。
- **面板配色对齐 DSH 主题（T-133）**：任务中心不再自造主题 token，也不再写死颜色。深色模式下调查筛选条不再是近白横条——容器改为 `transparent`，选中 pill 用 `--dsw-alias-bg-module-platform` + `--dsw-alias-label-primary`，hover 用 `--dsw-alias-interactive-bg-hover`；tabs、chip、pill、计数徽章与选中行改用 module/hover/layer-2 token，替换掉并不存在的 `--dsw-alias-bg-layer-4`；调查 accent 改用品牌蓝 `--dsw-alias-state-business-primary`，删掉写死的青绿；状态色映射到 `--dsw-alias-state-success-primary` / `--dsw-alias-state-warn-label` / `--dsw-alias-state-error-primary`，底统一为中性 module 背景；错误文字改用 `--dsw-alias-state-error-primary`，不再依赖缺失的 `--dsw-alias-label-error`。布局、间距与交互不变。

### 新增

- **面板、技能与文档里的调查卡（T-132）**：看板给调查卡加**调查**标记和类型筛选（全部 / 开发 / 调查），进行中列显示「调查中 N」；任务详情只渲染 **执行 → 交付** 阶段脊（没有评审/测试/合并阶段，也没有 target/合并进度），并展示已交付的报告——summary、body、证据表（命令 / 退出码 / 输出尾部）与 artifacts，未交付时显示「报告未交付」；运行中的调查卡不再显示提交框。队列与执行者页不会为它出现 reviewer/tester 槽位。运行时技能新增完整的「调查卡（investigate）」章节（什么时候用、`kind: "investigate"`、`report` 动作与体积上限、scratch/probe 规则、不 commit/submit/merge、拒绝码与面板呈现），仍在 6–10 KB 预算内；中英文 README 都补了调查卡生命周期与 `create` + `report` 示例。
- **调查卡（`kind: 'investigate'`）**：卡现在可以交付**报告**而不是可合并代码。`create`（与工具）接受 `kind`（默认 `dev`；未知 kind 以 `invalid-kind` 拒绝；`update` 不允许改 kind，旧板缺该字段一律按 `dev`）。派发时从 target head 建一个 **detached** scratch checkout（`.worktrees/<id>-<attempt>`，无分支、不拿 `writeFiles` 锁、不 provision reviewer/tester），并下发宿主机固定的调查 brief（只调查；不要 commit、不要 submit；需要第二份 checkout 时只允许 `probe-<id>-*`，且每个路径都要列进 `artifacts`）。卡用新的 `report` 动作完成（assignee 或用户；`summary` ≤4 KB，`body` 板内 ≤64 KB、全文写 `.agents/reports/<id>.md`，evidence ≤20 条 `{command, exitCode, outputTail}` 且每条尾部 ≤4 KB，artifacts 只存路径）。report 会清 lease/assignee/dispatch、释放锁、强制删除 scratch 与全部 `probe-<id>-*`，把 scratch 里的误提交记为 `probeCommits`，并且**绝不创建 merge request**。`submit` 返回 `investigation-report-only`，评审/测试/合并动作返回 `not-a-dev-task`；reopen 会清空旧报告（历史里说明）；调查卡 done 即可满足依赖，dev 前序仍要求已合并；`counts` 增加 `investigating`，`list` 带 `kind`/`reportSummary`，`get` 带完整报告。面板呈现由后续卡负责。
- **一条命令接入（`onboard`）**：进入项目只需一个动作——宿主解析项目根（显式 path，否则把会话工作区向上找到最近的 git 项目；worktree 的 `.git` 文件也算仓库根）、检查 git/Godot 标记、用与 `openProject` 相同的就绪门禁绑定看板、读取紧凑的看板事实、缺团队时自动补，最后返回一段简报和一个机器可读的 `next` 步骤。阶段（unusable / choose / setup / attention / active / empty / idle）与 next 码覆盖：还没 `git init` 的新项目、不是项目的目录、有卡住的看板、待批准的派发、硬坏的主检出与暂停的派发器；它不猜路径、不建卡、不跑 `git init`、不开派发，响应 <20 KB。技能正文的接入段、常驻规则与工具描述都改为走它。
- **建团队只建 worker 槽位**：`bootstrapTeam`（以及 onboard 的团队步骤）只创建 Lead + worker；reviewer/tester 槽位由各自阶段按需创建（提交后的评审、进入测试时的测试），不会再在没有任何卡时先起三个 agent。worker 收到的是 standby 简报（当前无卡：不要找活、不要 submit、不要编辑），不再塞一张假的 `bootstrap-team` 卡 id；返回值带 `deferred: ['reviewer', 'tester']`。
- **任务中心的运行时技能与常驻硬规则**：激活该行会向宿主技能目录注册 `godot-bridge-task-center`（正文由动作注册表生成：定位、工作流、动作矩阵、写卡规范、拒绝码、Godot 启动规则与面板结构），并注入四条常驻硬规则——`start` 只是需要用户批准的申请、结论只属于对应角色、任务工作绝不提交到 target、绝不手改 `.agents/tasks.json`。`task_center` 工具描述收敛为指向该技能的短路由，不再是一整段两千字节的 API 叙述。宿主没有技能注册表或系统提示服务时两者静默跳过。注册对象带 `source: 'runtime'`：注册表在**加载**技能时才校验它（缺了会先出现在目录里、加载时报错）。
- **宿主机械验证（`verify`）**：任务可声明 `verify: { command, timeoutMs? }`（shell 字符串，可链式）。评审通过并建好测试候选后，由**宿主机**在候选里通过不受沙箱约束的 subprocess 服务执行它（默认上限 10 分钟），并把结果记录为 `test.hostCheck`——命令、退出码、是否超时、耗时、≤4 KB 的输出尾部与时间戳。退出码 0 进入 TESTING，基线随 tester brief 发出；非 0 或超时则记为宿主侧的失败测试：任务带证据回到 running、候选被丢弃、owner 收到通知，既不产生 tester 轮次也进不了合并队列。畸形声明以 `invalid-verify` 拒绝而不是被丢弃。工具把 `verify` 暴露为对象参数（`null` 清除）；target 移动重建候选时会重跑该检查。
- **tester 证据分两段**：tester brief 携带宿主基线，并要求证据区分【宿主基线】与【我的探针】——宿主跑的是下限不是上限，tester 可以说明理由复跑同一命令，也可以跑别的套件。
- **事件带名字、测试行结构化**：活动行与详情事件显示宿主写入的成员名（`byName`，用户显示为「你」），不再依赖运行时名单，解析不出的 id 按该行角色词回落（执行者 / 评审者 / 测试者 / 合并者）再接 label（没有角色词的旧记录才退化为「成员 <label>」）。状态页头部「最近活动」改为与活动卡同源，取同一事件流的最新时间；只有心跳的板子会明说，而不是显示过期或空白的一行。测试事件显示结构化摘要——通过/失败 · exit N · Ns——证据全文放在「查看全文」后面，且每行保留**事件自身的裁决**，所以 fail-then-pass 的历史里早先的失败仍然显示为失败。
- **隔离实例上的视觉验证**：`harnessStatus` 在顶层镜像 `port` / `token` / `url` / `cookie`，截图工具可以直接打开 token URL；面板暴露稳定的 `data-*` 钩子（`[data-panel-root]`、`[data-view]`、`[data-roles-tab]`、`[data-roles-pane]`、`[data-detail]`），README 与 `.agents/notes/design/visual-check.md` 里的导航与截图流程就基于它们。
- **状态页与任务详情重做**：状态页是一句话状态 + 派发/工作树/执行者三张卡 + 整宽活动流（事件是面板语言的可读句子）；任务详情是按容器宽度自适应的宽浮层，带 派发 → 实现 → 评审 → 测试 → 合并 的阶段条（轮次与完成时间）、「现在做到哪了」、摘要列，并把关键事件与最近一次打回原因前置。动作列表新增 `rolesPreview`，面板因此能显示宿主真正会注入的文本。

### 变更

- **所有影响卡片的路径都跟随卡片/会话/项目（不再 any-Lead 猜）**：阶段角色按 `(角色类型, ownerSession)` 分组 provision——两个会话的卡同时处于同一阶段时各得一个评审者；ownerless legacy 卡只有「该项目恰好一个活 Lead」时才被采纳，0 个或多个都会记录并跳过。`memberLiveness`、`interruptMemberNamed`（租约交接、阶段阻塞、评审轮次上限）、评审/测试超时 sweep、角色面板（`rolesList`/`rolesReplace`/`rolesDrain`/`rolesReset`、实例列表、花名册、预览 Lead）都按卡片/面板会话解析团队，所以别的 team 里的同名成员不再被判死、不再被中断、也不会被列出或替换。环境探测带上项目：dispatcher 的读数与按卡的脏状态 streak 都按项目隔离，A 的脏检出不会显示到 B（B 干净也不会洗白 A）。`state.memory.projectHint` 只作为路径/显示兜底，另有静态断言禁止它参与团队/Lead 解析。

- **任务中心快照瘦身：只带摘要、详情按需、支持 `since` 增量**：`GET /state` 只返回面板渲染所需字段（不含 spec / acceptance / evidence / 完整 history），并带 `seq` / `full` / `removed`；新增 `GET /task?id=` 按需取单卡完整详情（详情抽屉与编辑表单打开时才拉取，按 `updatedAt` 缓存），`GET /list?status=&cursor=&limit=&q=` 分页返回摘要且搜索在服务端。`/state?since=<seq>` 返回 `{tasks: [变化的卡], removed: [id], full: false}`；seq 缺失或过新、切换项目、增量日志断层时回退 `full: true`。给 agent 的 `board` 动作保持完整详情不变。本仓库真板（84 卡，81 done）经候选路由实测：明细快照 1,275,964 B → 摘要 183,096 B（远低于 200 KB 目标）——`merge.output` / `merge.tests` / merge 文件数组 / `test.evidence` / `review.reasons` 不再进入摘要，只留状态、轮次、时间戳与 `declaredCount` / `actualCount` / `outputLength` / `testsLength` / `evidenceLength`；完整字符串仍由 `/task?id=` 提供。面板用增量游标轮询，不再每 2.5 秒重发明细。

- **任务中心技能正文补齐 Lead 角色与进入流程，并纠正四处误导**：正文开头新增「你是谁：Lead」（Lead 做什么、系统里的其它角色、明确不做什么），随后是进入流程（解析项目根、`openProject`、读 `board`、固定简报模板、无副作用）；把 `pause` 写清为派发器开关、`tick` 为立即 settle 的排查手段，「一次性小改动直接改」改为「任何改动都不要直接提交 target」（应急走独立 hotfix 分支并在守卫里登记例外），`unknown-project` 补充「尚未绑定或路径不对，先 `openProject`」；另补角色槽位串行（`queuePosition`、排队不计沉默）、`merged` 语义（ref 真的前进了，否则 `target-not-advanced`）、每卡可带 `target`，以及禁止给自己开守卫豁免。合并了面板/角色两节重复的 provision 描述，收紧只读 `skillsCatalog` 措辞；动作清单仍由注册表生成。

- **侧边栏入口点名插件**：任务中心的侧边栏文案由 `任务` / `Tasks` 改为 `GodotBridge 任务中心` / `GodotBridge Task Center`，让用户能看出该 UI 入口来自哪个插件；面板内标题仍为 `任务中心` / `Task Center`。

- **看门狗按沉默时间而非墙上时间**：reviewer/tester 每一次可识别的 `task_center` 调用都会续上该阶段的活动时钟（只存内存，宿主重启可能让已经沉默的轮次直接阻塞）。评审沉默 10 分钟提醒、20 分钟警告、再过 2 分钟宽限才阻塞；测试轮 10 分钟提醒、20 分钟 + 同样宽限阻塞，正好踩线的结论不会被丢掉。`passTest` 触发的合并会等足声明的 `verify` 预算，因为 target 移动会重建候选并重跑该检查。
- **角色 profile 以副本方式修改**：内置 worker / reviewer / tester profile 不可改（`builtin-profile-immutable`）；Fork 生成有名字的草稿副本，保存时一次性创建、绑定阶段并替换在跑实例。面板不再有单独的绑定/应用/替换词汇，只有一个「当前使用」选择器；编辑器两栏：原始提示词与宿主真正注入的文本（由真实 brief 生成器产出）。删掉正在使用的副本会立即回落到内置默认。
- **面板导航**：五个页签（看板、队列、执行者、状态、角色）。页签不再带计数（数字放在看板表头），「文件锁」页签移除。

### 移除

- 文件锁的手动面：`lock` / `unlock` / `forceUnlock` 动作与「文件锁」页签移除。加锁完全自动；`locks` 仅保留为只读诊断。

### 修复

- **任务中心面板不再直出服务端英文提示**：面板路由（`unknown-project`、`content-type`、`origin`、`bad-request`、`no-action`）改为返回稳定的 `code` 与可选 `params`，不再硬编码英文句子；浏览器半按 code 从双语 `TC_DICT`（`err_*` 条目）渲染，遇到未知 code 回退显示服务端 `message`（兼容新旧宿主）。给 agent 的工具错误仍保持英文（受众不同；500 `failed` 携带的是异常诊断文本，不是 UI 文案）。

- 角色页在保存被拒后可能显示假的「保存 ✓」横幅；现在横幅反映真实结果。
- 角色页对内置 profile 可能渲染空左栏、重复锚点与双层卡片；空态、分段渲染与单卡片已修正，注入预览也不会再显示另一个身份的文本。
- 任务详情过去是固定 400 px 抽屉；现在是按容器宽度自适应的宽浮层（<900 px 时全屏）。

## [0.3.0] - 2026-10-20

### 新增

- **任务中心 v2**：项目级任务板（`<项目>/.agents/tasks.json`）、依赖驱动的派发（显式开始/暂停 + 用户同意）、优先级排序、并发与重试设置、文件锁，以及宿主重启后对上一进程 claim 的回收。
- **评审/测试阶段机**：每个任务走 `pending → running → reviewing → testing → done`，以 `blocked`/`cancelled` 作为出口。`submit` 提交 worktree 并进入 REVIEW；评审者通过或打回；通过后构建独立测试候选并进入 TESTING；测试通过后合并、任务变 DONE。每个阶段各自保存记录（轮次、执行者、结论、原因/证据），`reopen`/`retry` 保留历史。
- **角色系统**：三种固定角色——worker（implement）、reviewer（review）、tester（test）——各自以 Agent Teams teammate 槽位（`worker-1`、`reviewer-1`……）在解析出的 Lead 下创建。Profile 存放于 `<项目>/.agents/roles.json`（version 1，始终存在规范化的 `worker`/`reviewer`/`tester`）：角色种类、阶段绑定、实例数（1–8）、权限、fresh/fork 上下文、技能与 prompt 模板。宿主自动补齐缺失的阶段角色，并替换死亡或超时的实例；reviewer/tester 是只读的独立上下文，worker 永远不能评审或测试自己的任务。
- **独立评审者与候选测试者**：`approveReview`/`requestChanges` 属于 reviewer（或用户），`passTest`/`failTest` 属于 tester（或用户）。进入 TESTING 时以当前 target head + 任务分支构建一次性候选 `<项目>/.worktrees/test-<id>`（分支 `test/<id>`），并向 tester 发送自包含 brief（验收标准、候选路径/分支、运行手册、证据格式）；worker 从不裁决自己的任务。
- **宿主驱动的合并队列与自动合并**：宿主每 5 秒扫描一次，把每个被 tester 接受的申请送入唯一的串行合并队列。队列在一次性 `merge-<id>` worktree 中整合已接受的候选；target head 已移动时拒绝合并（从新 head 重建候选并重开测试轮）；冲突会可读地记录；每个任务最多合并一次——重复的 pass 或重复申请都不会重复合并。
- **评审/测试超时策略**：评审 10 分钟无结论先提醒 reviewer，再过 10 分钟仍无结论则把任务置为阻塞待人工处理；测试轮 10 分钟提醒、20 分钟阻塞。评审轮次上限为 3。被任一套策略阻塞的任务会写明轮次、已耗时、执行者与候选状态，而不是无声挂死。
- **宿主动作看门狗**：每个异步宿主动作（候选构建、候选合并、merge request、角色准备、通知）上限 2 分钟。卡住的动作用 `queue-timeout`/`action-timeout` 返回，被放弃单元的任何迟到写入都会被拒绝，因此一个挂起的 await 无法永久占住动作或合并队列。
- **角色/状态 UI**：面板分为 看板 / 队列 / 执行者 / 文件锁 / 状态 / 角色 六个页签。看板是七列（就绪、等待、进行中、评审中、测试中、完成、阻塞）；状态页显示在线 agent、工作树清单与宿主活动环；角色页只有一张 **角色上下文编辑器** 主卡。
- **角色上下文编辑器**：唯一主卡，顶部 实现/测试/评审 分段页签；只读身份行 + profile 选择器与阶段绑定；可编辑上下文模板 + 宿主变量目录（插入 chips + 说明）；宿主固定块（职责、权限边界、结论格式——由真实 brief 生成器产生并标注“宿主固定”）；SKILLS 输入 + 目录弹窗；FORK / 保存 / 应用。Fork/保存成功后编辑器与“应用”的目标立即切换（不等下一轮轮询）；保存失败保留草稿与已编辑内容。
- **角色上下文模板与技能管理**：profile prompt 是模板，可注入 `{{TASK_ID}}`、`{{TASK_TITLE}}`、`{{SPEC}}`、`{{COMPLETIONS_DEF}}`、`{{GIT_INFO}}`、`{{PROJECT}}`、`{{LEAD}}`、`{{ROLE}}`、`{{STAGE}}`；保存时出现其它变量会以 `invalid-role-variable` 拒绝并列出允许变量，空模板合法。新增仅用户、只读的 `skillsCatalog` 动作，从宿主技能注册表（`ctx.get('skills').list`）列技能供面板勾选，服务缺失时降级为可读的 `skills-unavailable`。
- **隔离 DSH 测试 harness**：`harnessStart`/`harnessStatus`/`harnessSmoke`/`harnessRestart`/`harnessStop`（仅 tester 或用户）启动用完即弃的 DSH 实例——独立 `DSH_HOME`、profile、空闲端口与项目副本——把候选插件装进去，证明页面、health、插件行与任务中心路由可应答，且完全不碰生产 profile、会话与端口。版本不匹配（或无法确定版本）时 smoke 失败而不是通过。
- **worktree 创建健壮性**：每次 `git worktree add` 使用独立的 180 秒超时，不再与通用的 git 与子进程预算共用；超时或失败会回滚它可能登记的一切（worktree 条目、分支、锁、已 prune 的元数据），失败后重试一次，且同一仓库内的创建串行执行，两个任务不会争抢同一份 worktree 元数据。无法承载 worktree 的项目仍在派发前以可读原因拒绝。
- **执行者与文件锁可见**：执行者页显示 Lead、上限、忙/闲/启动中/失败计数与每个 WorkAgent 的当前任务；文件锁页显示持有任务/Agent 以及“会等待该文件”的就绪任务（竞争提示，不是 FIFO 队列）。
- **开始派发需要同意**：agent 调 `start` 只写入 `dispatch.request`，不会启动调度器；面板显示发起者与说明，并提供批准/拒绝。`pause` 双方都可立即调用。
- **GUI**：重写面板，包含七列看板、队列、执行者、文件锁、状态与角色视图、派发设置、待批准 start 横幅，以及 2.5 秒宿主快照轮询。

### 变更

- 板子 schema 升到 v2。读到 v1 会自动迁移（旧状态坍缩到当前词表、`blockedBy` 变成 `dependsOn`、旧 claim 被释放）；未来版本会被拒绝而不是降级。任务 id 由构造保证唯一、`seq` 不会冲突、历史最多保留 120 条。
- **`submit` 不再是完成**：它进入 REVIEW。任务只有在独立评审通过 **且** 独立测试通过（或用户/merger 手动完成）后才到 DONE。`accept`、`reject`、`requiresReview` 已移除；旧板子里的 `review` 任务迁移为 `done`。
- **租约最终语义**：运行中的任务持有 60 分钟租约；assignee 的任何活动都会无条件续租，宿主还按固定 5 分钟节奏心跳续租，因此长时间工具运行不会丢 claim。失效租约按 liveness 判定而非只看时钟：holder 仍活着就保住任务（单次尝试 4 小时硬上限，记 `lease-extended`），只有 session 消失/failed 才在中断后交接。同一任务绝不会有两条活跃 agent；交接时若上一尝试留有 commit，则 adopt 其 worktree 与分支。看板暴露 `leaseRemaining`/`leaseReminder`，并记录 `lease-handover`/`attempt-adopt` 事件。
- **合并队列幂等**：候选合并按任务加锁且幂等——队列对每个任务只记录一次合并，拒绝已在合并/已合并的申请，target 移动时执行“重建 + 重测”，绝不合并过期树。
- 浏览器半侧不再包含 mock store：只拉取宿主快照、发送一个动作、渲染宿主返回，因此宿主故障不会再以编造的任务呈现给用户。
- **分支保护与 hotfix 追溯**：`scripts/check-target-history.mjs`（`npm run check:target`，已接入 `npm run check`）会拒绝这样的 target 历史——其中存在既不能由 `task/`/`test/`/`merge/` 合并解释、也不在板子中 done+merged、更不是已声明紧急例外的非 merge commit；`scripts/setup-hooks.mjs` 安装 `pre-commit` 钩子，禁止在 target 上直接提交，除非设置 `TASK_CENTER_MERGE=1`。两次 merge-queue hotfix 以紧急例外记录：`1695506`（合并）与 `2c895b4`（候选合并幂等 + 限制 git 子进程），由 T-30 的回归测试与看门狗现在保障的有界宿主动作路径追溯覆盖。
- 派发设置弹窗只暴露一个值：最大并发。执行者上限自动按并发 + 1 推导，自动新建开启，重试上限保持内部默认 3；工具/HTTP 的 `settings` 仍可覆盖这些高级参数。
- 派发在向进程外发出任何东西之前先 claim、记录投递结果，并在达到尝试预算后把任务置为阻塞，而不是无限重试。
- **角色管理仅限用户**：`rolesList`/`rolesCreate`/`rolesUpdate`/`rolesDelete`/`rolesBind`/`rolesDrain`/`rolesReplace`/`rolesReset` 与 `skillsCatalog` 从工具枚举中隐藏，对 agent 直接拒绝；profile 保存在写入 `roles.json` 前会完整校验（名称、种类、阶段、实例数、上下文、权限、技能、有限长度 prompt 与模板变量）。

### 修复

- 派发忽略优先级，且一次 pass 可能把多个就绪任务交给同一个空闲成员。
- WorkAgent 提交可能被拒绝：板子存的是 Team 成员名，而工具侧量的是 session id；现在两边身份都会记录。
- 任务租约过期从不回收；面板的新建/释放/提交/解除阻塞/重开动作与宿主词汇表不一致。
- 依赖被删除或取消后，下游会无提示地永久等待；现在会报告“依赖已破”。
- 从任务中心切到对话页再切回来时，视图与选中的任务会重置回看板；现在两者都能跨 remount 保留。
- 已 submit 的任务可能永久停在 REVIEW 或 TESTING 而没有任何结论；超时策略现在先提醒一次，然后连同轮次与候选状态一起阻塞待人工处理。
- worktree 创建失败可能残留已登记的 worktree、半建的分支或陈旧锁，从而破坏该仓库后续所有派发；现在会回滚、重试一次，并按仓库串行创建。

### 移除

- `/task` 斜杠命令与 `@deepseek-ai/dsh-llm` peer 依赖。
- 示例 store、种子板、模拟/重置控件以及 `__fixture` 测试接缝。
- 五列 submit-即-完成 的旧看板与 `verify-<id>` 自测 worktree：阶段机的独立候选取代了它们。

## [0.2.1] - 2026-10-24

### 修复

- **本地调试器下的 `eval` 死锁（issue #13）**：`godot_run_project` 默认不再带 `-d`，`godot_command eval` 正常编译用户代码；语法错误仍会在捕获输出里给出错误与文件:行号。`debug:true` 明确为**诊断模式**：实例带本地调试器运行，交互服务器依据桥注入的 `GODOT_BRIDGE_DEBUGGER=1` 环境变量判定（仅靠 `OS.get_cmdline_args()` 不可行——Godot 会先消费 `-d`，4.7.2 实测），并在 `reload()` 之前**拒绝 eval** 并给出 `next`；桥保留 stdin 管道，检测到 `debug>`/`Debugger Break` 时只写一次 `quit`（绝不 `continue`），3 秒未退再终止自己启动的实例。退出结果**按退出码而非速度**分类：0 → `debugger-quit`；非 0 → `debugger-trap` + `exitCode`/`crash`；3 秒未退 → `debugger-trap` + `killed`；三者都带 `debuggerTrace`（break 原因、`*Frame N` 的 `file:line`、≤4KB 尾部）。如实记录：在 4.7.2-stable win64 上写 `quit` 约 38ms 后以 **3221225477（0xC0000005，访问违例）** 退出并打印 C++ 回溯，因此那次运行判为崩溃陷阱而非优雅退出。实测基线（最小工程 + 语法错误脚本）：无 `-d` 约 372ms 退出并输出 `SCRIPT ERROR … at: GDScript::reload`；带 `-d` 且 stdin 为 EOF 时 3 秒内打印 **12089** 行 break/prompt（1.78 MB，约 590 KB/s）必须强杀（issue #13 的死循环）；带 `-d` 且 stdin 为管道时只有一次 break/prompt（2.4 KB），因为调试器在等输入。
- **诊断守卫的纠正**：第一版从 `OS.get_cmdline_args()` 里找 `-d`，真机上是死代码（`eval` 仍会进入 `debug>`）。现在由桥在启动时注入 `GODOT_BRIDGE_DEBUGGER=1`，服务端读取它（`is_local_debugger(args, debugger_flag)`），argv 只作兜底；仍漏网的陷阱会以 `diagnosis: "debugger-trap"` + `debuggerTrace` 返回，而不是一个光秃秃的超时。回归测试：`scripts/test/eval-guard.test.mjs`（自包含）与 `scripts/test/eval_guard.gd`（`godot_run_headless --script`）。带外提交：`745c7b0`（本次守卫纠正）与 `21459a5`（发布提交），二者经 `90a5427` 合入目标分支，并在 `scripts/check-target-history.mjs` 中登记为 emergency exception（对应卡片 T-74/T-76）。
- `godot_command` 超时返回 `bridge timeout` / `diagnosis: unresponsive` / `next`；`godot_ping` 在“端口连上但不应答”时报 `responsive: false`，不再误报 `game_running: false`；`user://logs/godot.log` 过大时告警（不删除用户文件）。
## [0.2.0] - 2026-10-01

### 新增

- **`Godot engine path` 现在可以在 GUI 里编辑。** 本组合包自带浏览器半侧（`client/client.js`，在 manifest 里由 `dsh.client` 声明），以包名为键注册本组合包的配置区（keyed slot `plugins.bundle.config`）——插件页的 **godot-bridge 卡片页**因此直接在描述与行列表之间显示路径字段，带**保存**与针对本 profile 覆盖值的**恢复默认**。（按行注册的 `plugins.row.config`（键为 `<包名>#<行 id>`）会把同一个表单放到深一层、藏在行上的「配置」控件后面；等到一个组合包拥有多个可独立配置的行时它才是正确选择，而本包只有一个。）保存走的是 DSH 设置的同一条路，落到 `godot_set_engine_path` 写入的同一行 `cordis.patch.yml`，所以该字段、那个工具、以及手写的 `config:` 块是同一个值的三种视角，改动立即生效、无需重启。关闭那一行时配置区随之消失——浏览器半侧属于那一行。本条关闭了下方 0.1.8 记录的已知限制。
- `npm run check` 现在同时校验浏览器半侧，把「让组合包失去表单」这一类错误变成构建期失败，而不是运行期静默失败：`dsh.client` 声明（合法成员、`platform: 'web'`、字符串数组 `inject`/`external`、布尔 `immediately`）、`exports["./client"]` 目标存在且被 `files` 覆盖、`window.__ModuleLoader__.load({ id })` 的 id 等于包名、`slots` 服务声明、每个 `require()` 说明符是否落在 web 客户端平台种子模块表或 `dsh.client.external` 内、`plugins.bundle.config` 的键是否等于本包名，以及 `plugins.row.config` 的键是否指向本包 patch 声明的行。slot 键与模块请求都只从**代码**读，注释不能充当通过条件。

### 变更

- 浏览器半侧在无法承载它的运行时上保持静默：0.1.6–0.1.x 已有这些 slot，但没有可读该值的设置表单服务，因此注册包在 `ctx.inject(['configForms'], …)` 之内，那些运行时维持原有行为（没有 GUI 字段，仍用 `godot_set_engine_path` 与 `settings.yaml`）。比 0.1.0-rc.7 更早、根本不扫描 `dsh.client` 的运行时忽略该 manifest 成员。

## [0.1.8] - 2026-09-30

### 修复

- 以 `link:` 依赖安装时，插件在 DSH 0.2.x 上完全无法加载：launcher 的 runtime resolution 只对「linked 包在自己 `peerDependencies` 里声明过的名字」把 `@deepseek-ai/*` 路由到安装版（它读的是 `peerDependencies` 的键，不是 `dependencies`），而 godot-bridge 一个都没声明——于是 `import '@deepseek-ai/dsh-tools'` 报 `ERR_MODULE_NOT_FOUND`，17 个 `godot_*` 工具一个都没注册。manifest 现在声明 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。
- `godotPath` 在 DSH 0.2.x 上不再消失：`@deepseek-ai/dsh-settings` 移除了 `register`，settings 段此前只会静默降级成一条告警，`godot_set_engine_path` 永远回答 settings 服务不可用。
- 在 0.1.x → 0.2.x 升级前配置过的引擎路径会被自动带过来，而不是静默回落到 PATH 上的 `godot`（那通常是版本管理器 shim，也就是与用户当初配置不同的构建）。见「变更」中的迁移说明。

### 变更

- 配置模型：`godotPath` 改为插件 Config 的 `.volatile()` 字段，因此会出现在插件设置页，并按活值读取（volatile 字段原地更新，不 remount 插件）。写入经 `ctx.configEditor.edit(...)` 持久化到 active profile 的 `cordis.patch.yml` 并热重组——无需重启。
- `godot_set_engine_path` 写前校验目标文件是否存在，并回报持久化去向：DSH 0.2.x 上为 `persisted: 'profile-patch'`，旧路径为 `'settings'`。
- 继续兼容旧运行时：0.1.6–0.1.x 上 `settings.register` 仍然存在时插件继续使用它（`@deepseek-ai/dsh-tools` 的声明范围为 `>=0.1.6-0`）。`peerDependenciesMeta.optional` 阻止 pnpm 去 registry 安装 harness 包。
- `settings.yaml` 迁移：DSH 0.2 按插件 entry id 导入遗留段，而本插件的行 id 是 `tool-godot-bridge`，所以 0.1.x 写下的 `godot-bridge:` 段不会被带过来。当当前运行时没有配置路径时，插件会读取该段并把其中的值经与 `godot_set_engine_path` 相同的 profile-patch 写入路径写回，因此升级前配置的引擎构建无需重新填写即可继续使用。已配置的值永远不会被覆盖；记录在磁盘上已不存在的路径会被忽略（这种情况仍保留 PATH 兜底与对应告警）。还原每次插件加载只尝试一次，且尽力而为：写入被拒时保留 PATH 兜底并记一条告警，不会禁用任何工具。

### 新增

- `npm run check` —— `scripts/check-plugin-contract.mjs`：零依赖静态契约检查。裸 `@deepseek-ai/*` import 必须在 `peerDependencies`/`dependencies` 中声明；`dsh.bundle.patch` 必须存在且引用本包；`main`/`exports` 目标文件必须存在且被 `files` 覆盖；入口必须导出 `name`/`apply` 且没有 `export default`。
- `scripts/diagnose-dsh-resolution.mjs` —— 可重跑的 launcher runtime resolution 诊断（bundle 层、被 skip 的 bundle、linked root、每个 import 的解析结果，支持 `--expect ok|fail`）；仅开发用，不发布。

### 文档

- README：新增「DSH 0.2+ 兼容性与故障排查」（解析规则、`link:` 的 peer 要求、症状对照表、`dsh plugin allow-version` 应急、验证命令），并修正配置位置的表述。
- install：新增 `link:` 本地开发一节；重写「配置」一节（volatile 字段、profile-patch 写入路径、旧运行时兜底、`settings.yaml` 迁移说明）；维护一节补上契约检查与诊断脚本。
- ARCHITECTURE：新增「依赖契约与运行时解析」及分层示意图。

### 已知限制

- `godotPath` 在 DSH 0.2 上**没有 GUI 表单项**。插件页只为「自带客户端组件、注册了 keyed slot `plugins.row.config`」的插件渲染行配置表单；没有任何内置包注册该插槽，而 godot-bridge 没有客户端入口。Host 侧不受影响——`settings.describe()` 仍会为 `tool-godot-bridge` 行投影该字段，用 `godot_set_engine_path`（或该行的 `config:` 块）设置即可。该缺口单独作为功能请求跟踪。

## [0.1.7] - 2026-09-07

### 修复

- 旧版 autoload 残留导致端口路由失效：若项目 `autoload/mcp_interaction_server.gd` 早于 `GODOT_BRIDGE_PORT`/`get_instance_info` 引入，无论 `godot_run_project` 请求什么端口都只会绑 9090——于是 `port=9092` 看似成功，后续 `godot_command`/`godot_screenshot` 却只能找到 9090（issues #4）。`ensureInteractionAutoload` 现在会用随包版本覆盖过期的 autoload（该文件属插件管理的基础设施），并在替换时返回 `upgraded`。
- `godot_ping` 与错误文案改为上报真实探测端口，不再写死 `127.0.0.1:9090`。
- `writeProjectFile` 的 fs policy 改为指向目标项目目录而非会话工作区，使对工作区外项目的 autoload/project.godot 写入合法。
- 所有工具返回出口接入 `sanitizeLossless` 防御：偶发的 `undefined`/`NaN` 字段降级为日志记录并修正，而不是静默报 `value is not lossless JSON`。

## [0.1.6] - 2026-09-01

### 新增

- `godot_run_project` 的实例归属处理：先探测端口，若同项目已有实例在运行（典型场景：用户在编辑器里启动了场景，LLM 再运行项目），**直接接管（adopt）**并返回 `external: true`，不再 spawn 一个绑定失败、静默错挂的重复实例（旧行为会制造一个裸奔副本并误驱动用户实例）。
- 异项目占用端口时自动回退到 9091+（或调用方传入的 `port` 参数），不再撞端口。
- `mcp_interaction_server.gd` 支持 `GODOT_BRIDGE_PORT` / `GODOT_BRIDGE_TOKEN` 环境变量，并新增 `get_instance_info` 命令（pid/port/token/project），作为归属识别的身份基础。
- `godot_stop_project` 拒绝终止被接管（用户/编辑器启动）的实例，并说明安全停止方式（编辑器按 F8 / 游戏内退出）；插件绝不杀死自己未启动的进程。新增 `godot-bridge:instance-ownership` 系统提示段，同样禁止用 pwsh 杀进程（会连带把编辑器带崩）。

### 修复

- 兼容 dsh-settings ≥ 0.1.2-alpha：移除已删除的 `settingsNamespace` 导出（改为把裸字符串命名空间传给 `ctx.settings.register`）；settings 与工具注册均加防御式 try/catch，未来 API 再漂移时降级告警而不是拖垮整个 host 启动。

## [0.1.5] - 2026-08-19

### 新增

- `godot_run_headless` 工具：通过不受文件沙箱约束的 subprocess 服务执行有界的 headless 场景/逻辑/测试运行（`godot --headless --path <项目> [--quit-after N] [--script <脚本.gd>]`，超时强杀），取代在受沙箱约束的 pwsh/bash shell 里直接跑 `godot --headless` 导致 signal 11 崩溃的危险做法。

### 变更

- `godot_headless_op` / `godot_validate_script` / `godot_export_project` 崩溃时附带 `diagnosis`（`sandbox-crash`，高/低置信度 + 可执行提示），不再只返回原始 stderr，沙箱崩溃不再被误判为项目 bug。
- 新增 `godot-bridge:launch-channel` 系统提示段：Godot 必须始终通过 godot_* 工具（不受沙箱约束的 subprocess）启动，严禁通过 pwsh/bash（文件沙箱拦截 user:// 日志写入，signal 11 崩溃）。
- `godot_run_project` 描述指向 `godot_run_headless` 用于非交互 headless 运行。

### 修复

- `godot_run_headless` 在正常路径返回 `note: undefined`；DSH 工具层会拒绝任何 `undefined` 属性（"value is not lossless JSON"）并丢弃整个结果。现在 `note` 仅在超时时存在，`exit_code` 归一化处理，确保每个返回字段都是 lossless JSON。
- `godot_validate_script` 的错误条目在缺失文件/行号定位时使用 `null`（而非 `undefined`）。

## [0.1.4] - 2026-08-16

### 修复

- 恢复 0.1.3 中误删的 `timer` 注入：`ctx.timeout()` 是 timer 服务的 mixin，其 getter 读取 `ctx.timer`，移除后导致 `godot_run_project` / `godot_command` / `godot_screenshot` 报 `cannot get property "timer" without inject`。

## [0.1.3] - 2026-08-15

### 新增

- `godot_set_engine_path` 工具：模型向用户索要 Godot 可执行文件路径并写入 settings（schema 与存在性双重校验、热重载、无需重启），补全"未配置引擎"的引导闭环。

### 变更

- `godotPath` 现在是面向用户的 settings 值（Web 插件配置页或 `settings.yaml` 的 `godot-bridge:` 段），不再是 `cordis.patch.yml` 的行配置；插件作者不再预设路径（Godot 是便携 exe，可能位于任意位置）。
- Godot 可执行文件解析顺序：每次调用的 `godot_path` 参数 → `godotPath` 设置 → PATH 上的 `godot` 命令。`godot` 已在 PATH 时无需任何配置。
- 存在性校验从 `apply` 内的 `throw`（会令整个 fiber 失败）移到 settings 的 `validate` 钩子，坏路径不再连累纯文件工具。

### 修复

- 工具描述不再把配置位置误写为 `$DSH_HOME/settings.yaml`（现指向 settings 段，与代码实际读取一致）。

### 移除

- 冗余的 `timer` 注入与 `console.log` 噪声（改用 `ctx.logger`）。

## [0.1.2] - 2026-08-15

### 修复

- 更新提示现在能可靠送达模型：`systemPrompt` 改为注入（此前用惰性 `ctx.get`，可能拿不到服务），提示文本改为明确指令，模型会在每个会话中主动转达"有可用更新：已装 X，最新 Y"。
- `godot_ping` 返回 `plugin_version` / `latest_version` / `update_available`，可随时按需查询。

## [0.1.1] - 2026-08-15

### 新增

- 启动时更新提示：尽力而为的版本检查，抓取仓库 `main` 分支的 `package.json`（`raw.githubusercontent.com`，5 秒超时，失败/离线静默跳过）。存在更新时注册一条系统提示；`package.json` 的 `repository` 字段让 fork 自动跟随检查源。

### 修复

- `godot_command` 的 `timeout_ms` 此前是死参数：一次性 node 桥固定 20 秒封顶。现在超时经 `argv[3]` 传入（缺省 20 秒），`godot_ping`、`godot_run_project` 的就绪轮询以及异步命令都能按各自的超时生效。

### 变更

- 移除 pre-bundle 部署遗留的 headless 脚本兜底路径（`<项目>/tools/godot-bridge/`、`../godot-mcp/src/scripts/`）；模块同目录副本成为唯一来源。

## [0.1.0] - 2026-08-15

首个版本——以原生 Agent 工具取代 godot-mcp MCP 服务器的标准 DSH bundle。

### 新增

- 15 个 `godot_*` 工具：
  - 进程：`godot_run_project` / `godot_stop_project` / `godot_get_debug_output` / `godot_ping`
  - 运行时控制：`godot_command`（覆盖全部交互服务器命令）、`godot_screenshot`
  - headless：`godot_headless_op`（16 个操作）/ `godot_validate_script`
  - 项目编辑：`godot_set_project_setting` / `godot_manage_autoloads` / `godot_manage_input_map` / `godot_manage_export_presets` / `godot_create_script` / `godot_create_project` / `godot_export_project`
- 标准 DSH bundle 形态：`@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register`；`dsh.bundle` manifest 支持 `dsh plugin --profile web add github:Smalldy/godot-bridge` 安装。
- 随包附带游戏侧资产：`mcp_interaction_server.gd`（游戏内 TCP autoload）、`godot_operations.gd`、`validate_script.gd`。
- `godot_manage_input_map` 使用正确的 Godot 4 键码（修复 godot-mcp 的 Godot 3 基线 bug）。
- 双语文档（README / install / ARCHITECTURE / COVERAGE），含安装与移除指南；`cordis.patch.yml` 纳入发布 `files`。

[0.3.0]: https://github.com/Smalldy/godot-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Smalldy/godot-bridge/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/Smalldy/godot-bridge/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Smalldy/godot-bridge/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Smalldy/godot-bridge/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Smalldy/godot-bridge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Smalldy/godot-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Smalldy/godot-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Smalldy/godot-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Smalldy/godot-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Smalldy/godot-bridge/releases/tag/v0.1.0
[0.2.1]: https://github.com/Smalldy/godot-bridge/compare/v0.2.0...v0.2.1
