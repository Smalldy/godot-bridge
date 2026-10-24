[English](README.md) | **中文**

# godot-bridge

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![Listed on DSH Directory](https://dsh.directory/badges/listed.svg)](https://dsh.directory/plugins/smalldy/godot-bridge)

原生 **DeepSeek Harness (DSH)** 插件：通过游戏内置的 TCP 交互服务器，启动并操控运行中的 **Godot 4.x** 游戏——以原生 Agent 工具取代 [`godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) MCP 服务器。

无需 MCP 协议、无需 Python 服务器、无需编辑器插件。游戏侧零改动：`McpInteractionServer`（`mcp_interaction_server.gd` autoload）本就在 `127.0.0.1:9090` 监听，采用换行分隔的 JSON 协议——godot-bridge 在 DSH host 内部原生使用同一种协议。

## 工具

| 工具 | 取代 (godot-mcp) | 用途 |
| --- | --- | --- |
| `godot_run_project` | `run_project` | 以调试模式启动项目（`godot -d --path …`），等待 9090 就绪 |
| `godot_stop_project` | `stop_project` | 终止游戏进程（tree-scoped kill） |
| `godot_get_debug_output` | `get_debug_output` | 增量读取已启动进程的 stdout/stderr |
| `godot_command` | 全部 `game_*`（约 105 个） | 发送任意交互服务器命令：`get_scene_tree`、`get_ui_elements`、`eval`、`get/set_property`、`call_method`、`click`、`key_press`、`screenshot`、`raycast`、`serialize_state`、`ui_*`…… |
| `godot_screenshot` | `game_screenshot` | 视口截图（base64 PNG） |
| `godot_ping` | — | 探测游戏是否在 9090 应答（并报告已装/最新插件版本） |
| `godot_set_engine_path` | — | 把 Godot 引擎可执行文件路径写入插件配置（模型向用户索要路径后据此保存，热重载——DSH 0.2.x 上返回 `persisted: 'profile-patch'`，旧路径返回 `'settings'`） |
| `godot_headless_op` | `read_scene`、`modify_scene_node`、`remove_scene_node`、`attach_script`、`create_resource`、`save_scene`、`create_scene`、`add_node`、`get_uid`、`manage_scene_signals`…… | headless 静态操作（`godot --headless --script godot_operations.gd`）：16 个操作，无需运行游戏 |
| `godot_run_headless` | — | **非交互**地有界运行项目、场景或测试脚本（`godot --headless --path … [--quit-after N] [--script …]`），经不受沙箱约束的 subprocess 服务启动；返回 stdout/stderr，并在命中时给出 sandbox-crash 诊断 |
| `godot_validate_script` | `validate_script` | headless GDScript 编译检查（`validate_script.gd`）→ `{valid, errors}` |
| `godot_set_project_setting` | `modify_project_settings`、`set_main_scene`、`manage_layers`、`manage_plugins`、`manage_translations` | 在任意 project.godot 段设置类型化键值（`PackedStringArray(...)` / `Vector2i(...)` / bool 等） |
| `godot_manage_autoloads` | `manage_autoloads` | 列出/增删 autoload 单例（`Name="*res://…"`） |
| `godot_manage_input_map` | `manage_input_map` | 列出/增删输入动作——**正确的 Godot 4 键码**（修复 godot-mcp 的 Godot 3 基线 bug） |
| `godot_manage_export_presets` | `manage_export_presets` | 列出/增删导出预设（`export_presets.cfg`） |
| `godot_create_script` | `create_script` | GDScript 模板（extends / class_name / 方法桩 / 自定义源码） |
| `godot_create_project` | `create_project` / `create_csharp_script` | 项目脚手架，可选 Godot .NET `.csproj` |
| `godot_export_project` | `export_project` | headless 导出（`--export-release` / `--export-debug <预设> <输出>`） |

其余 godot-mcp 工具是在 MCP 服务器自己的 Node 进程里实现的：纯文件/编辑器操作由 DSH 原生文件工具覆盖；少数几个带 **Godot 特有写逻辑**（`manage_input_map`、`manage_export_presets`、`modify_project_settings`、项目/脚本模板生成等），通用编辑只能配合格式知识替代——完整对照见 [COVERAGE.md](COVERAGE.zh-CN.md)。

## 任务中心（task-center）

面板的“当前项目”按**会话**绑定：`/state`、`/task`、`/list` 和所有 action 都携带 `?session=<id>`，宿主只读取该会话的绑定（`state.sessionRootOf(id)` 是唯一读取入口，不存在进程全局的项目槽位）。没有会话标识的请求处于未绑定态，绝不会借用其他会话的项目。

同一个包还会挂载第二个组件行 `godot-bridge/task-center`：项目级任务板 + 阶段驱动的派发器（含独立评审与测试）+ 文件锁 + 角色系统，以及中栏 GUI 面板（左侧栏「任务」）。插件激活时还会注册运行时技能 `godot-bridge-task-center`，并注入四条常驻硬规则（见下文）。

### 执行流程

每个任务都在自己的 git worktree 中执行——`<项目>/.worktrees/<taskId>-<attempt>`，分支 `task/<taskId>-<attempt>`，在任务被 claim 时创建。任务绝不会派发到共享工作区；项目无法承载 worktree 时，派发会直接拒绝开始。每个任务都走同一条阶段机——`pending → running → reviewing → testing → done`，以 `blocked`/`cancelled` 作为出口：

1. **执行**：assignee 只在该 checkout 内修改文件，在那里运行项目测试，并可加载角色 profile 声明的技能。
2. **提交**：`submit` 在 worktree 内提交、记录 base..head diff，并把任务推进到 REVIEW。submit 不是完成。
3. **评审**：宿主准备 reviewer 角色（只读、独立上下文），并发送每轮 brief——spec 与验收标准、diff、声明 vs 实际文件、worker 证据、评审清单，以及宿主已经采集好的机械证据（git 统计的声明/实际文件，加上上一轮的 `verify` 结果），让 reviewer 做判断而不是为了核清单再跑一遍测试。`approveReview` 进入 TESTING；`requestChanges` 带着具体原因退回 running。连续 3 轮未通过则阻塞；评审超时由下面的看门狗处理。
4. **测试**：评审通过时，以当前 target head + 任务分支构建一次性候选 `<项目>/.worktrees/test-<id>`（分支 `test/<id>`）。**在任何 tester 介入之前**，宿主机先在候选里执行任务声明的 `verify` 命令（见下文「宿主机械验证」）：绿了才进入 TESTING，并把基线结果写进 tester 的 brief；红了由宿主直接判失败，不会产生 tester 轮次。tester 在候选里完成验收并记录 `passTest` 或 `failTest`（含证据）；失败会带着证据退回 running。brief 会明确写着：宿主基线**不是** tester 的结论，tester 必须自己设计并执行脚本覆盖不到的探针，证据分【宿主基线】与【我的探针】两段；怀疑 flaky 或环境差异时可以说明理由复跑，也可以跑别的套件——宿主那次是下限，不是上限。
5. **合并**：测试通过后由宿主的串行合并队列（每 5 秒扫描）合并——每个任务只有一个被接受的候选，在一次性 `merge-<id>` worktree 中整合，且最多合并一次。若 verdict 之后 target head 又移动，则从新 head 重建候选、**在新树上重跑宿主机械验证**，并重开测试轮，绝不合并过期树。
6. **异常**：冲突或 target 移动会标记该申请并通知 owner，target 分支保持不变。`mergeRequest` / `rejectMerge` / `refreshMerge` 仍保留给用户或 `merger` 队友，用于手动整合、审计或修复。

- **任务板**：`<项目>/.agents/tasks.json`。schema v2；读到 v1 会自动迁移（旧状态映射到当前词表、`blockedBy` 变成 `dependsOn`、旧 claim 被释放）。重复 id、非法条目、未来版本会被拒绝而不是覆盖。建议把该文件加入项目 `.gitignore`（它是运行态，不是源码）。
- **动作 API**：`task_center` 工具与 `POST /godot-bridge/task-center/action` 共用同一套动作：`create / update / delete / list / get / board / start / pause / approveStart / rejectStart / cancelStartRequest / settings / tick / submit / approveReview / requestChanges / passTest / failTest / mergeRequest / refreshMerge / rejectMerge / cancel / reopen / block / unblock / retry / locks / openProject / rolesList / rolesPreview / rolesCreate / rolesUpdate / rolesDelete / rolesBind / rolesDrain / rolesReplace / rolesReset / skillsCatalog / harnessStart / harnessStatus / harnessSmoke / harnessRestart / harnessStop`。`verify` 不是动作而是任务字段：`create` / `update` 可带，工具侧暴露为对象参数（`null` 清除）。
- **运行时技能与常驻规则**：激活该行会向宿主技能目录注册 `godot-bridge-task-center`。正文由动作注册表生成（定位、何时用、最小工作流、动作矩阵、写卡规范、拒绝码、Godot 启动规则与面板结构），因此不会与 API 漂移。另有四条常驻硬规则随系统提示注入：`start` 只是需要用户批准的申请；评审/测试结论只属于对应角色；任务工作只在任务 worktree 里、绝不提交到 target；不要手改 `.agents/tasks.json`。`task_center` 工具描述刻意收敛为指向该技能的短路由。宿主没有技能注册表或系统提示服务时两者都静默跳过，工具、路由与调度照常可用。
- **依赖**：`B.dependsOn = [A]` 表示 A 完成**且已合并**后才派发 B。就绪任务按 `priority` 降序、创建时间升序取。`A <- B <- C`、`D`、`E <- F` 会先派发 A、D、E；A 完成后派发 B，E 完成后派发 F。
- **派发**：开始/暂停是项目级状态（持久化在板子里）。GUI 只暴露**最大并发**：最多同时跑这么多个任务；执行者上限自动设为并发 + 1，没有空闲执行者时会自动新建，连续失败 3 次后任务阻塞（高级调用仍可用 `settings` 覆盖）。每次派发先 claim（60 分钟租约；assignee 任何活动都会续租，另有固定节奏的宿主心跳）再交给 Agent Teams：优先 `sendMessage` 给空闲成员，否则 `spawnTeammate`。
- **租约与 liveness**：运行中的任务持有 **60 分钟租约**。assignee 的任意一次 `task_center` 调用都会**无条件续租**，且每轮调度都有宿主心跳按固定 5 分钟节奏续租，因此长时间工具运行不会丢 claim。失效租约按 **liveness** 判定而非只看时钟：holder 仍活着就保住任务（单次尝试 4 小时硬上限），只有 session 消失/failed 才在中断后交接。同一任务绝不会有两条活跃 agent；交接时若上一尝试留有 commit，则 adopt 其 worktree 与分支。看板暴露 `leaseRemaining`/`leaseReminder`，并记录 `lease-extended`/`lease-handover`/`attempt-adopt` 事件。
- **宿主重启退还尝试（`interruptions` 与 `attempts` 两条轴）**：claim 被发现属于上一个宿主进程（重启/插件重载）时，那是基础设施事件，不是执行者失败。`interruptDispatch` 会**退还**这次 claim 记下的 attempt（`attempts` 回到 claim 之前的值），只累加独立的 `interruptions` 计数、退休执行者台账里的那条记录，并写一条 `interrupted by worker lost (host restart); attempt refunded` 历史——所以开发宿主重载五次也不会把健康的卡弄成阻塞。真正的失败（投递错误、超时、坏提交）仍照旧消耗 `maxAttempts`；提交成功或一次真失败都会把中断连击清零。**连续** 5 次中断且始终没有提交，才会以 `interrupted-too-often` 阻塞，避免无限重试。`get` / `board` 暴露 `interruptions`、有界的 `executors` 台账和 `liveExecutors`；重派发会先中断/退休上一个执行者再 claim——若旧执行者仍活着且停不下来，本轮以 `already-dispatched` 跳过并留一条历史，所以一张卡永远不会同时有两个活执行者。重试时会**优先复用**上一次那个干净且没有提交的 worktree（脏工作区绝不继承），而 attempt 槽位（`attempts + interruptions + 1`）保证退还之后执行者名字与 checkout 路径不会撞车。
- **角色**：`<项目>/.agents/roles.json`（version 1；规范化的 `worker`/`reviewer`/`tester` profile 始终存在）。一个 profile 指定三种固定角色之一、阶段绑定（implement / review / test）、1–8 个实例、允许的权限、fresh 或 fork 上下文、要加载的技能，以及一个 prompt **模板**。宿主通过活着的 Lead 自动补齐缺失的阶段角色、替换死亡或超时的实例；reviewer 与 tester 是只读独立上下文，worker 永远不能裁决自己的任务。
  - 三个内置 profile 是**不可改**的（可读的默认提示词随插件发布；直接编辑会返回 `builtin-profile-immutable`）。要改行为就 **Fork** 一份：Fork 出来的是有名字的**草稿副本**，保存时一次性创建 profile、绑定阶段并替换在跑实例。面板里不再有单独的「绑定/应用/替换」词汇：只有一个「当前使用」选择器和一次保存；删掉正在使用的副本会立即回落到内置默认。
  - 编辑器是两栏：左栏是**原始提示词**（自定义 profile 可编辑；内置 profile 只读并提示 Fork），右栏是宿主真正会注入的文本，通过 `rolesPreview` 由真实 brief 生成器产出，绝不是面板自造的文案。身份行负责 profile 选择与「当前使用」；实例数与技能在同一张卡里，技能选择器读 `skillsCatalog`。`rolesList` / `rolesPreview` / `rolesCreate` / `rolesUpdate` / `rolesDelete` / `rolesBind` / `rolesDrain` / `rolesReplace` / `rolesReset` 通过动作 API 提供同样的操作。所有角色管理与 `skillsCatalog` 都是**仅限用户**（工具枚举中隐藏，对 agent 直接拒绝）。
  - 模板可注入 `{{TASK_ID}}`、`{{TASK_TITLE}}`、`{{SPEC}}`、`{{COMPLETIONS_DEF}}`、`{{GIT_INFO}}`、`{{PROJECT}}`、`{{LEAD}}`、`{{ROLE}}`、`{{STAGE}}`。出现其它 `{{NAME}}` 时保存会被 `invalid-role-variable` 拒绝并列出允许变量；空模板合法。固定头部、任务数据、职责/权限边界/结论格式都由宿主生成，绝不是模板输出。
- **文件锁（只有自动锁）**：任务用 `writeFiles` 声明要写的文件；调度器在派发前原子获取全部锁，任务完成/阻塞/取消/租约交接时释放。**没有手动加锁动作**：agent 既不能加锁也不能解锁，面板也没有「文件锁」页签；`locks` 只作为只读诊断动作保留（持有任务/Agent，以及会等待该路径的就绪任务）。路径规范化为项目相对路径，目录锁会与子路径冲突。
- **宿主机械验证（`verify`）**：任务可在 `create` / `update` 时声明 `verify: { command, timeoutMs? }`（`task_center` 工具暴露为对象参数，`null` 清除）。`command` 是 shell 字符串——可以链式（`npm run verify && npm run e2e`），由宿主通过不受沙箱约束的 subprocess 服务在候选 checkout 里原样执行，上限 `timeoutMs`（默认 10 分钟）。结果写在任务的 `test.hostCheck`（`command`、`exitCode`、`timedOut`、`durationMs`、≤4 KB 的输出 `tail`、`at`）。退出码 0 正常进入 TESTING，基线随 tester brief 一起发出；非 0 或超时则是**宿主记录的失败测试**（`by: host`，证据 = 命令 + 退出码 + tail）：任务回 running、不产生 tester 轮次、候选被丢弃、owner 收到通知，且永远进不了合并队列。畸形声明会以 `invalid-verify` 拒绝，而不是被静默丢弃。未声明 `verify` 的任务保持历史流程（tester 自己跑套件）。
- **GUI**：五个页签——**看板**（七列：就绪、等待、进行中、评审中、测试中、完成、阻塞）、**队列**、**执行者**、**状态**、**角色**。页签本身不再带计数，数字放在看板表头。执行者页显示 Lead、上限、忙/闲/启动中/失败计数以及每个 WorkAgent 的当前任务。**状态页**顶部是一句话状态（派发状态、未完成的工作、正在落地什么）与派发控件，下面三张卡——派发、工作树、执行者——再下方是整宽的**活动流**：每条事件都是一句面板语言的可读描述（派发、提交、评审轮、测试轮、合并、宿主检查、租约事件），不再是裸 kind；事件行显示宿主写入的成员名（`byName`，用户显示为「你」），不再依赖运行时名单——解析不出的 id 按该行的角色词回落（执行者 / 评审者 / 测试者 / 合并者）再接 label（没有角色词的旧记录才退化为「成员 <label>」）；状态页头部「最近活动」与这张卡同源，取同一事件流的最新时间（只有心跳的板子会明说，而不是空白）。测试事件是**结构化摘要**——通过/失败 · exit N · Ns——不再夹带证据全文，且每行按**事件自身的裁决**显示：fail-then-pass 的历史里，早先的失败行仍显示失败（哪怕任务当前测试记录已是 passed）。**任务详情**是宽浮层，按*容器*宽度自适应：内容区 ≥900 px 时两栏（约 996 px 窗口及以上，所以 1024 px 窗口仍是较窄的两栏），内容 700–900 px 为紧凑形态，更窄单栏；浮层本身在视口 <900 px 时全屏。详情带阶段条（派发 → 实现 → 评审 → 测试 → 合并）与轮次/完成时间、「现在做到哪了」、摘要列，并把关键事件与最近一次打回原因前置；某一轮测试的证据全文放在「查看全文」开关后面。角色页就是上面那张两栏角色上下文编辑器。Agent 的 start 申请显示为带「批准并开始 / 拒绝」的横幅。2.5 秒轮询宿主快照。
- **项目绑定（面板跟随会话）**：浏览器没有 pin 时，面板**不发送** project，由服务端解析会话工作区（向上找到最近的 git 项目）并把 ProjectRef 回答给面板——新浏览器永远不需要手填路径。标题旁显示来源徽标：**会话**（工作区向上解析）、**手动**（本浏览器或调用方 pin 的路径）、**注册表**。项目弹窗里有**「使用当前项目」**，直接填入服务端此刻解析到的路径，不需要手打。当面板 pin 的路径 ≠ 会话项目时，顶部出现「面板：A · 当前会话：B」的提示和**切换**动作：点它既写入浏览器 pin 也调用 `openProject`——界面切换与调度器绑定是同一个动作，所以不会再出现「面板看 A、调度器驱动 B」。手动填写仍然可用（远程/非会话工作区的项目），来源标为「手动」。
- **面板会话身份（面板怎么知道自己是哪个会话）**：面板以「宿主正在显示的那个会话」的身份工作。它读宿主自己的服务——`uiWorkspace.selection`（持久化为 `dsh.sessions.current`，主会话切换时写入），以 `uiSession.current`（主视图绑定）为第二来源——并把这个 id 放进 `/state`、`/list`、`/task` 与每个动作体；这正是工具路径拿到的 `agent.id`。因此面板**不需要** URL 参数、**不需要**手填路径就能跟随会话，切换会话也会立即跟上（选择变化触发刷新，而不是等下一次轮询）。降级路径是明确的、绝不猜：页面 URL 显式的 `?session=` 优先；拿不到宿主身份时按窗口自造一个 id（sessionStorage）并在界面上说明；空的选择**不会**被当成「最近活跃会话」，也没有全局槽位可借。状态页始终显示该 id 与来源（宿主 / URL / 本窗口）。
- **同意**：agent 调 `start` 只写入 `dispatch.request`，不会启动调度器；面板显示申请，只有用户的 `approveStart` 才真正开始。`pause` 双方都可直接调；`settings` 仅用户可改。
- **超时与宿主动作看门狗**：看门狗量的是**沉默时间，而不是墙上时间**——reviewer/tester 每一次可识别的 `task_center` 调用都会续上该阶段的活动时钟（只存内存：宿主重启可能让一个本来就已经沉默的轮次直接阻塞）。评审沉默 10 分钟提醒一次、20 分钟发「即将阻塞」通知，再过 2 分钟宽限才阻塞待人工处理；测试轮 10 分钟提醒、20 分钟 + 同样宽限阻塞，因此正好踩线的结论不会被丢掉；连续 3 轮评审未通过同样阻塞。每个异步宿主动作（候选构建、候选合并、merge request、角色准备、通知）上限 2 分钟：卡住的动作用 `queue-timeout`/`action-timeout` 返回，被放弃单元的迟到写入会被拒绝，因此一个挂起的 await 无法永久占住动作或合并队列。`passTest` 触发的合并会等足声明的 `verify` 预算，因为 target 移动时会重建候选并重跑该检查。
- **离开 running 就停掉执行者**：任务被取消、阻塞、撤回开始申请、租约丢失或被超时策略阻塞时，宿主会通过 Agent Teams 的 `interrupt` 边（以 Lead 身份调用）中断正在处理它的队友。`interrupt` 在**下一个 step 边界**生效——它让执行者在开始下一步之前停下，所以是「尽快停」，不是「掐断正在执行的工具调用」。只对仍处于 `running` 的成员发送（空闲成员、没有 assignee 的任务跳过），同一任务/状态/成员最多一次；中断后释放该任务的文件锁，并给执行者留一条可读的 inbox 消息（「… 已取消/被阻塞，请停止并丢弃未提交改动」）。软的一半在后面兜底：只要任务还是 cancelled/blocked，持有过它的执行者——通过保留下来的 last owner（`lastAssignee`，因为 cancel/block 会清空 live assignee）识别——自己的 `task_center` 调用（`get`、`submit`、裁决类动作等）都会以 `task-cancelled` / `task-blocked` 被拒绝并提示「立即停止当前工作」；其他 agent 和用户仍可读取或修复该任务。
- **worktree 健壮性**：每次 `git worktree add` 使用独立的 180 秒超时（不与通用的 git 与子进程预算共用）；超时或失败会回滚它可能登记的一切（worktree 条目、分支、锁、已 prune 的元数据），失败后重试一次，且同一仓库内的创建串行执行，两个任务不会争抢同一份 worktree 元数据。
- **安全**：HTTP 写动作要求 `application/json` 且校验同源 `Origin`；`?project=` 只是读提示，切换项目走 `openProject`（校验目录存在）。

### 已知限制

- 没有会话跳转 API：状态页可以复制 session id，但打开该会话仍需在 Team 列表中手动操作。
- Godot 必须通过 `godot_*` 工具启动，绝不能走 shell 工具（文件沙箱会让它崩溃——见「坑」）。
- 隔离 harness 需要配置 `dshCommand`（通常还有 `dshArgs`）；CLI 不可用时 smoke 会返回可读失败，而不是算通过。
- 同一时刻只处理一个项目、只使用一个 Team/Lead：共享状态只保留一个项目 hint，派发解析第一个活着的 Lead。缺少 Agent Teams 服务时任务保持 pending 并给出明确原因。
- verdict 之后 target 分支若又移动，会按设计触发「重建 + 重测」（含宿主机械验证）；合并绝不会落到过期树上。
- 上一任执行者仍活着且拒绝被中断的卡会停在 `pending` 等人工处理：`already-dispatched` 拒绝既不消耗 attempt 也不增加 interruption，所以调度器每轮都会重试（并记一条活动）而不是把卡交给第二个执行者。五次中断的防死循环规则只覆盖「中断型 claim」，不覆盖这种拒绝。
- **历史**测试事件里的 exit 与耗时取自任务最新一条测试记录（板子只保留当前轮），所以较早的失败行可能显示后来那一轮的数字；裁决标签本身来自事件自身，失败轮的证据文本仍留在该历史条目的 note 里（活动行以悬停文本携带），详情页「查看全文」显示当前轮证据。

```sh
# 在 GUI 之外创建任务（任意 HTTP 客户端）
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' \
  -d '{"action":"create","project":"/path/to/game","title":"A","writeFiles":["scripts/a.gd"],"verify":{"command":"npm run verify"}}'
# 开始 / 暂停派发
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' -d '{"action":"start","project":"/path/to/game"}'
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' -d '{"action":"pause","project":"/path/to/game"}'
```

运行 `npm test` 覆盖 board / service / locks / dispatch / git / harness / routes / tool / activation / target 历史 与浏览器半侧。

### 候选漂移：哪些自动处理，哪些仍需人工

候选在评审时构建，合并却发生在测试通过之后，中间目标分支几乎总会前进。漂移由宿主 sweep（不是 worker）处理：

- **仅 base 漂移**（目标前进，分支 head 仍等于已验证提交）：sweep 以当前 target head 重建候选并直接合并，evidence 记「仅 base 变化，diff 与已验证提交一致」，**不新增评审/测试轮次**。
- **构建期冲突**：候选与目标冲突时不再直接抛 candidate-conflict，而是把卡片标为 candidate-stale 并附冲突文件清单，自动重建；再次冲突升级为 needs-rebase（保留文件清单），等待 worker/Lead 处理，**不阻塞其他卡**。
- **内容变化**（分支超过已验证提交）：绝不盲目合并；卡片标 candidate-stale（diff changed）并走 refreshMerge 重开评审，重新评审 + 测试。
- **已知边界**：自动漂移判定只认真实 hex commit base；夹具/手写板里的 "base-sha" 之类标签保持旧行为。真实仓库始终是 hex commit。
- 冲突文件写入卡片的 waitingDetail，面板可以直接显示等待原因。

## 隔离 DSH 测试 harness

任务中心同时提供「真实 DSH 冒烟」：`plugin/task-center/harness.mjs` 启动一个**用完即弃的 DSH 实例**，证明候选插件能装、能加载、能应答，而完全不碰生产 profile、会话与端口。只有 tester 角色（或用户）能通过 `task_center` 的 `harnessStart` / `harnessStatus` / `harnessSmoke` / `harnessRestart` / `harnessStop` 驱动；`POST /godot-bridge/task-center/action` 对 GUI 暴露同一组动作。

一次 `harnessStart` 会在同一个系统临时根目录下创建（`harnessStop` 会整个删除）:

- 独立的 `DSH_HOME`（`<root>/home`）与全新的 `web` profile，候选插件由 `dsh plugin --profile web add <candidatePlugin>` 装入；
- 独立的项目副本（`<root>/project`，不含 `.git`、`.worktrees`、`node_modules`、`dist`、`coverage`）；
- 从 `portBase` 起挑一个空闲端口（配置的 `productionPort` 永不入选），以及全新的 web 进程 token。

### 配置

`<project>/.agents/test-harness.json` 保存机器本地路径（与模块默认的 `dshSource` 同类）；所有字段可选，`DSH_TEST_HARNESS_*` 环境变量优先：

| 字段 | 环境变量 | 含义 |
| --- | --- | --- |
| `dshSource` | `DSH_TEST_HARNESS_SOURCE` | 用于与运行中安装版比版本的 DSH checkout |
| `dshCommand` | `DSH_TEST_HARNESS_DSH` | CLI 可执行文件（`argv[0]`）。**不经 shell** 启动，因此带空格的绝对路径可用，但 `.cmd` 不行——请指向真正的可执行文件 |
| `dshArgs` | `DSH_TEST_HARNESS_DSH_ARGS` | 该可执行文件的前置参数，如 `["--import", "<tsx loader>", "<checkout>/apps/cli/src/bin.ts"]` 或 `["<checkout>/apps/cli/lib/bin.js"]`；环境变量形式是 JSON 数组 |
| `dshEnv` | `DSH_TEST_HARNESS_DSH_ENV` | 两次 CLI 调用的额外环境（JSON 对象）。每个实例的 `DSH_HOME`/`DSH_PROFILE` 始终单独设置 |
| `candidatePlugin` | `DSH_TEST_HARNESS_CANDIDATE` | 装入测试 profile 的包，默认是本包 |
| `profile` | `DSH_TEST_HARNESS_PROFILE` | profile 名（默认 `web`） |
| `portBase` / `portRange` | `DSH_TEST_HARNESS_PORT_BASE` / `…_PORT_RANGE` | 端口搜索区间（默认 39000 + 100） |
| `healthPath` / `healthTimeoutMs` / `healthIntervalMs` | 对应的 `…_HEALTH_*` | 就绪探测与预算 |
| `installTimeoutMs` / `stopTimeoutMs` | `DSH_TEST_HARNESS_INSTALL_TIMEOUT_MS` / `…_STOP_TIMEOUT_MS` | `dsh plugin add` 预算与 terminate/等待预算 |
| `productionPort` / `productionVersion` | `DSH_TEST_HARNESS_PRODUCTION_PORT` / `…_PRODUCTION_VERSION` | 永不占用的端口，以及显式的生产版本覆盖 |

### 它遵守的 web 契约

真实 `dsh web` 带 token 鉴权：launcher 打印 `dsh web: http://127.0.0.1:<port>/?token=<一次性>`；该 URL 返回 **303 + Set-Cookie**，而 `/` 在没有 cookie 时返回 401。Node 的 `fetch` 没有 cookie jar，因此 harness 先从头日志里取出 token、自行完成交换，再用 cookie 探测 health/页面。任务中心插件路由不鉴权，smoke 直接访问。生产版本探测顺序：显式配置 → `DSH_VERSION` → 打包目录里的 manifest → Electron `app.asar` 头部（普通 `fs` 无法穿过 asar 路径）；都拿不到时结果为 `unknown`，smoke **失败**而不是算通过。

### 视觉验证

隔离实例同时也是 UI/面板工作「对真实渲染」验收的地方——截图绝不用生产页面。`harnessStatus` 在顶层直接镜像 `port`、`token`、`url` 与 `cookie`，截图工具可以直接拿到实例地址，不必翻嵌套记录：

1. `harnessStart`（tester 或用户），取 `url`（`http://127.0.0.1:<port>/?token=<一次性>`）与 `cookie`。
2. 打开页面：token URL 返回 303 + `Set-Cookie`，后面加载的就是插件面板。
3. 用稳定选择器导航：点 `[data-panel="task-center"]`，等 `[data-panel-root="task-center"]`，用 `[data-view="board|queue|workers|status|roles"]` 切页签，角色页内用 `[data-roles-tab="worker|tester|reviewer"]` / `[data-roles-pane="raw|injected"]`；任务详情浮层带 `[data-detail]`。
4. 按 1440×900 截图。每次开新页面的截图工具都会丢掉面板的内存态，所以**每一张**都要重走一遍导航前缀；输出放在普通（非隐藏）目录。
5. 结束时 `harnessStop`。

首次启动可能有一个弹窗挡在面板前面：预览版用 `click text="继续"`；登录版先聚焦再 Escape（`click text="开始使用"; key Escape`）。完整流程见 `.agents/notes/design/visual-check.md`。

### 真实冒烟证据（本工作区）

`J:\workspace\HARNESS\deepseek-harness` 的版本是 `0.2.1-rc.2`，但其已构建的 `apps/cli/lib` 早于多 patch 的 bundle manifest（`@deepseek-ai/dsh-web-app` 的 `dsh.bundle.patch` 是数组），因此 `node apps/cli/lib/bin.js --profile web` 会在 `loadProfileDirectory` 里报错退出；改走 tsx 跑源码又缺该 checkout 未安装的 `semver`。所以 `.agents/test-harness.json` 直接驱动**安装版运行时 CLI**（与桌面应用自己的 `dsh.cmd` 同一条入口），完全不依赖 PATH 上那个坏掉的 `npm\dsh.ps1` 壳。若该 checkout 重新 `pnpm run build`，更简单的写法是 `dshCommand: "node"` 加 `dshArgs: ["<checkout>/apps/cli/lib/bin.js"]`。

```text
POST …/action {"action":"harnessStart","project":"J:\…\godot-bridge"}
{"ok":true,"status":"running","port":39000,
 "home":"C:\Users\…\Temp\godot-bridge-harness-Uid58s\home",
 "projectCopy":"C:\Users\…\Temp\godot-bridge-harness-Uid58s\project",
 "profile":"web","pluginInstalled":true,
 "sourceVersion":"0.2.1-rc.2","productionVersion":"0.2.1-rc.2","versionStatus":"match",
 "token":"<printed>","cookie":true,"healthUrl":"http://127.0.0.1:39000/"}

POST …/action {"action":"harnessSmoke"}
{"ok":true,"versionStatus":"match",
 "checks":{"page":{"ok":true,"status":200,"html":true,"token":true,"cookie":true},
           "health":{"ok":true,"status":200},
           "pluginRow":{"ok":true,"status":200},
           "taskCenterAction":{"ok":true,"status":200}}}

POST …/action {"action":"harnessStop"}
{"ok":true,"stopped":true,"processExited":true}
```

整个序列前后还会校验隔离边界：stop 后嵌套端口无监听、临时根目录已删除、生产端口仍可访问、生产 `~/.dsh/profiles` 的 mtime 未变、没有实例进程残留（`netstat`/进程扫描）。版本不匹配（或无法确定）时 `harnessSmoke` 返回 `ok:false, code:"version-mismatch"` 并同时给出两侧版本；实例不可达则返回 `health-timeout` 附带最后的 health 状态与日志尾巴——绝不算通过。

## 工作原理

```
DSH 会话
  └─ godot-bridge（Host 插件）
       ├─ godot_run_project ──────► subprocess.spawn(Godot -d --path <project>)
       ├─ godot_get_debug_output ─► collect 模式输出（增量 offset）
       └─ godot_command / godot_screenshot / godot_ping
            └─ subprocess.spawn(node -e <bridge> <command> <paramsJson>)
                 └─ TCP 127.0.0.1:9090 ◄── 游戏内 McpInteractionServer autoload
```

- 游戏内协议（`{command, params, id}` + 换行）与 godot-mcp **完全一致**，游戏侧与既有工作流无需任何改动。
- 每条命令拉起一个一次性 `node -e` 桥：连接 → 发一行 → 打印第一行响应 → 退出。游戏服务器是单连接/单命令（`_busy`），短连接模型完美匹配。
- 通过 harness 的**原始 `subprocess` 服务**启动（而非受沙箱限制的 shell 执行器），Godot 得以正常写 `user://` 文件，不会被 DSH 文件沙箱杀掉（见"坑"）。

## 环境要求

- DeepSeek Harness（带 host 运行时的会话）
- 注册了 `McpInteractionServer` autoload 的 Godot 4.x 项目。若项目还没有，把 `plugin/mcp_interaction_server.gd` 复制到项目根，并以 `McpInteractionServer` 命名注册为 autoload（godot-mcp 项目已具备）。**`godot_run_project` 也会在缺失时自动安装**（把随包文件复制进 `autoload/` 并在 `project.godot` 注册）——无需手动处理；非 Godot 项目完全不受影响。
- `node` 在 PATH 中
- Godot 可执行文件——按此顺序解析：每次调用的 `godot_path` 参数 → **`godotPath` 插件设置**（`tool-godot-bridge` 行的配置：DSH 0.2.x 上是 godot-bridge 卡片页上的 `Godot engine path` 字段或 `godot_set_engine_path` 工具，0.1.x 上是插件 settings 段）→ PATH 上的 `godot` 命令。`godot` 已在 PATH 时**无需任何配置**；否则填你的引擎路径（插件作者不预设路径——Godot 是便携 exe，可能位于任意位置）。务必用**真实 exe 完整路径**，不要用版本管理器的 shim（见"坑"）

## 安装

**推荐——一条命令**（需要 `dsh` CLI）：

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` 是 pnpm 转发器：把包装进 profile 的 `node_modules`，并因包内声明 `dsh.bundle`（其 `cordis.patch.yml` 插入 `tool-godot-bridge` 行）而把它追加进该 profile 的 `dsh.profile.bundles` 层列表。`web` 就是 Web 应用启动所用的**标准 profile**——这条命令只是把工具加进标准模式，**不会新建任何 profile**。重启后该 profile 的所有会话都有 17 个 `godot_*` 工具。已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 社区清单（topic：`dsh-plugin`）。

同一命令也可安装本地 checkout 或 tarball（`dsh plugin --profile web add ./path/to/godot-bridge`）。

> 插件是标准 DSH bundle 模块：`import { defineTool } from '@deepseek-ai/dsh-tools'` 并经 `ctx.tools.register` 注册。它必须通过上面的 bundle 机制安装。DSH 通过 launcher 的 runtime resolution 从自己的安装里提供 `@deepseek-ai/*`：装进 profile 的包会自动解析；而 `link:`/符号链接的 checkout 只有在插件自己的 `peerDependencies` 里声明了这些包名时才会被路由（godot-bridge ≥ 0.1.8 已声明——见 [DSH 0.2+ 兼容性与故障排查](#dsh-02-兼容性与故障排查)）。不要把文件复制进用户 agent 预设（`~/.dsh/.agent-presets/...`）；那个位置不在任何解析范围内，解析不到 `@deepseek-ai/dsh-tools`。

### 移除

```sh
dsh plugin --profile web remove godot-bridge
```

从 profile 中删除该包及其 `godot-bridge` bundle 层——重启后该 profile 的会话不再有 17 个 `godot_*` 工具。标准 `web` profile 本身不受影响（这条命令从不创建或删除 profile）。先 `godot_stop_project` 停掉运行中的游戏；插件卸载清理也会终止它启动的 Godot 子进程。任何时候可用上面的 `add` 命令重新安装。

## DSH 0.2+ 兼容性与故障排查

DSH 0.2 用进程内的 **runtime resolution** 取代了旧的物理 module-fallback 层：launcher 把它装进 Node 的 ESM 与 CommonJS 解析器。解析器会针对「哪个模块在 import」决定是否把裸 `@deepseek-ai/*` 说明符路由到安装版自己的副本——这正是依赖 harness 包的插件能否加载的前提：

- **装在 profile 内**（`dsh plugin add github:…`、tarball，或任何位于 `$DSH_HOME/profiles/<name>/node_modules` 下的副本）：harness 包自动从安装版解析，无需任何声明。
- **以 `link:` 安装**（符号链接指向本地 checkout）：插件真实路径落在 profiles 树之外，而 Node 的 ESM loader 会先 realpath 再 import。这种 *linked root* **只有在插件自己的 `peerDependencies` 里声明了该包名时**才会被路由——解析器读的是 `peerDependencies` 的键，不是 `dependencies`。godot-bridge ≥ 0.1.8 声明了 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`，并标记 optional，避免 pnpm 去 registry 安装 harness 包。

### 症状

| 症状 | 含义 | 处理 |
| --- | --- | --- |
| 17 个 `godot_*` 工具全部消失，launcher 日志出现 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools' imported from …/godot-bridge.mjs` | harness 包没有被路由到安装版副本。对 `link:` 安装而言就是 `peerDependencies` 缺声明（0.1.7 及更早的失效方式） | 升级到 godot-bridge ≥ 0.1.8；或改用非符号链接安装（`dsh plugin … add ./godot-bridge-<版本>.tgz`） |
| launcher 打印 `dsh: skipping profile bundle "godot-bridge": …`，插件页显示错误 | 声明的 DSH peer 范围与当前运行时版本不匹配。**未声明** peer 不构成约束，因此不会产生这条信息 | 升级插件；或显式接受风险：`dsh plugin --profile <profile> allow-version godot-bridge@<version> --dsh-version <runtime> --accept-risk` |
| 插件设置页看不到 `godotPath`，且 `godot_set_engine_path` 提示 settings 服务不可用 | 在 DSH 0.2.x 上运行 0.1.8 之前的版本；旧的 `settings.register` API 已不存在 | 升级到 godot-bridge ≥ 0.1.8 |
| **godot-bridge 卡片**上看不到 `Godot engine path` 字段 | 注册本组合包配置区（keyed slot `plugins.bundle.config`，以包名为键）的浏览器半侧没有加载：本组合包唯一那行被关闭、更新后没有重启宿主、或安装的副本早于浏览器半侧（≤ 0.1.8）。在 DSH 0.1.6–0.1.x 上运行时没有设置表单服务，因此该字段按设计就不存在 | 升级到 godot-bridge ≥ 0.2.0 并重启 DSH——升级会替换已安装的文件，而 `dsh.client` 的扫描结果按 Loader 行缓存到重启为止。若该行是关闭状态请打开。否则用 `godot_set_engine_path` 设置，或给该行加 `config:` 块（见[安装文档](install.zh-CN.md#dsh-02-上的-gui-字段)） |
| 从 0.1.x 升级后，工具跑的是**与配置不同的 Godot 构建** | 0.2 之前的 `settings.yaml` 段不会被迁移（DSH 按插件 entry id 导入，而本行 id 是 `tool-godot-bridge`），于是解析回落到 PATH 上的 `godot`——通常是版本管理器 shim | godot-bridge ≥ 0.1.8 上无需处理：首次启动会把记录的值自动写回（仅当字段为空且文件仍存在）。若看到点名「丢失值」的告警，说明还原没有生效（记录的路径已不存在，或写入被拒），请用 `godot_set_engine_path` 重新设置 |

### 验证

```sh
npm run check                                                              # 静态契约检查——不需要 DSH
node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok   # 需要已安装的 DSH 应用
```

`npm run check` 会在「裸 `@deepseek-ai/*` import 未在 manifest 声明」「bundle patch 缺失或未引用本包」「入口丢命名导出」，或「浏览器半侧破坏自身契约」时失败：宿主不读的 `dsh.client` 成员、不是 `web` 的 platform、缺失或未被 `files` 覆盖的 `exports["./client"]` 目标、不等于包名的 `__ModuleLoader__` id、落在平台种子模块表之外的 `require()`、不等于本包名的 `plugins.bundle.config` 键、以及指向本包 patch 未声明行的 `plugins.row.config` 键。诊断脚本会打印 profile 的 bundle 层、被 skip 的 bundle、识别到的 linked root，以及插件每个 harness import 的解析结果——修复前后各跑一次，或在 DSH 再次改动解析规则时用来定位。

随后重启 DSH（或在插件页重新加载 profile），确认新会话里出现 17 个 `godot_*` 工具。

## 更新提示

插件加载时会做一次**尽力而为**的版本检查：抓取仓库 `main` 分支的 `package.json`（`raw.githubusercontent.com`，5 秒超时，失败/离线时静默跳过），与已安装版本比较。存在更新时注册一条系统提示（system-prompt section），让模型在每个会话里转达 **"godot-bridge 有可用更新：已装 X，最新 Y"**，直到插件更新（`dsh plugin --profile web update godot-bridge`，然后重启 DSH）为止。`godot_ping` 也会额外返回 `plugin_version` / `latest_version` / `update_available`，可随时按需查询。

**发布更新**：在 `package.json` 里**递增 `version`**（这是发布标记）并推送——版本没变就不会触发提示。fork 场景：设置 `package.json` 的 `repository` 后，检查会自动跟随你的 fork。

已知限制：提示是系统提示 section，所以 persona 为 complete/抑制型（如**极简模式** `minimal`）的预设不会显示；检查需要启动时能联网。

## 用法

```text
godot_run_project            # 启动游戏（默认当前 workspace）
godot_ping                   # 确认 9090 应答
godot_command get_scene_tree # 查看场景图
godot_command get_ui_elements
godot_command eval {code: "return get_tree().current_scene.name"}
godot_command click {x: 576, y: 300}
godot_screenshot             # 查看游戏画面
godot_get_debug_output       # 读取启动日志
godot_stop_project           # 结束
```

Godot 可执行文件解析顺序：每次调用的 `godot_path` 参数 → `godotPath` 插件设置（`tool-godot-bridge` 行的配置：DSH 0.2.x 上可用 godot-bridge 卡片页上的 `Godot engine path` 字段、`godot_set_engine_path` 工具，0.1.x 上是插件 settings 段）→ PATH 上的 `godot` 命令。`godot` 已在 PATH 时无需配置；否则填引擎路径，务必指向**真实 exe**，别用 shim。

## 坑（血泪教训）

- **DSH 文件沙箱 vs Godot `user://`**：经沙箱化 shell 执行器（pwsh/bash 工具）启动 Godot 会传播受限令牌，Godot 启动即崩（`Failed to open 'user://logs/…'`，signal 11）。godot-bridge 走原始 `subprocess` 服务、不受文件沙箱限制——这就是它能正常工作的原因。
- **`node -e` 的 argv**：`node -e <script> <cmd> <json>` 时，额外参数落在 `process.argv[1]`/`[2]`（不是 `[2]`/`[3]`）。
- **debug 模式下的 eval**：`eval` 代码出现编译错误会让游戏卡在调试器（与 godot-mcp 相同）。用动态访问（`p.get("global_position")`）绕开静态类型推断；卡死时 `godot_stop_project` + `godot_run_project` 重启。
- **用真实 exe，别用版本管理器 shim**：shim 会立即退出并把真实 Godot 变孤儿进程，进程管理会误判其已死亡。

## 项目结构

```
plugin/godot-bridge.mjs           # 插件入口（标准 DSH 模块，命名导出 name/inject/apply）
plugin/task-center/               # 任务中心宿主半侧（schema / board / service / locks / dispatch / merge / git / api / state / tool / routes / skill / harness / index）
client/client.js                  # 浏览器半侧：引擎路径配置 + 任务中心面板（dsh.client）
plugin/mcp_interaction_server.gd  # 取自 godot-mcp（MIT）——游戏内 TCP 服务器 autoload
plugin/godot_operations.gd        # 取自 godot-mcp（MIT）——headless 操作脚本
plugin/validate_script.gd         # 取自 godot-mcp（MIT）——GDScript 编译检查
package.json                      # dsh.bundle + dsh.client manifest（供 `dsh plugin add` 安装）
cordis.patch.yml                  # bundle patch 层（插入工具行）
install.md / install.zh-CN.md     # 详细安装与维护说明
ARCHITECTURE.md / ARCHITECTURE.zh-CN.md  # 如何取代 godot-mcp + 协议细节
COVERAGE.md / COVERAGE.zh-CN.md   # 与 godot-mcp 的逐工具对比
CHANGELOG.md / CHANGELOG.zh-CN.md  # 版本发布记录
scripts/check-plugin-contract.mjs  # 静态依赖契约检查（`npm run check`）
scripts/check-target-history.mjs   # 分支保护历史守卫（`npm run check:target`）
scripts/setup-hooks.mjs            # 安装 pre-commit target 守卫（`npm run hooks:install`）
scripts/diagnose-dsh-resolution.mjs  # 可重跑的 DSH 运行时解析诊断（仅开发用）
```

任务中心会在 `<项目>/.agents/` 下写项目级运行态文件：`tasks.json`（任务板）、`roles.json`（角色 profile），以及可选的 `test-harness.json`（机器本地的 harness 路径）。它们是运行态而非源码——请加入 `.gitignore`。

`mcp_interaction_server.gd`、`godot_operations.gd` 与 `validate_script.gd` 取自 [godot-mcp](https://github.com/tugcantopaloglu/godot-mcp)（MIT，随包内置）。插件通过模块相对路径定位这些脚本（`import.meta.url`）；传显式 `ops_script` / `validate_script` 参数可覆盖。

## 许可证

MIT
