# godot-bridge 架构评审与重构方案

> 只读评审，未改任何生产代码。评审对象：J:/mm13dremake_workspace/godot-bridge。
> 方法：全仓文件/行数盘点 + 四个分域深读（后端核心、调度/合并/git、前端、测试/构建/仓库）+ 架构文档与入口装配核对。
> 结论先行：项目已经不是一个“Godot 工具插件”，而是 **Godot 引擎桥 + 任务中心工作流引擎 + 大型 React 面板** 三个 bounded context 挤在一个包里的复杂产品。当前最需要的是**可读性、边界和运行时可观测性**，不是再加功能。

## 1. 执行摘要

**做得好的地方（必须保留）**

- 单一 action registry 的方向正确：tool、HTTP、skill 正文都由同一套动作词汇生成，避免模型和面板两套规则。
- board 的 CAS/版本化、phase machine、依赖图、worktree 隔离、review/test/merge 分权、auto-merge、目标分支保护，都是这个产品真正的护城河。
- 测试量很大（约 2.4 万行、2,800+ 断言），说明关键路径被认真覆盖过。
- ARCHITECTURE.md 详细、准确，Godot 桥与任务中心在**模块 import 层**已经解耦。

**六个结构性问题**

1. **巨型文件**：api.mjs 6,161 行、client.js 约 7,000 行、dispatch.mjs 4,923 行；单文件承担 10+ 种职责，阅读和修改成本高。
2. **“单一 registry”名不副实**：动作名数组 + 41 个 if 分支 + 三张平行名单；新增动作要改 4 处，门禁与 handler 分散。
3. **不变量不在唯一写缝**：调度器有 11 处直接 state.apply 写板，绕过 api.writeTask 的 ownerSession 领养；权限门禁只在 API 层。
4. **运行时正确性没有持久化边界**：bootId/locks/dispatcher/merge chain 都在内存；两个 DSH 进程可互抢卡、锁互不可见；stale .git/index.lock 无自愈；merge unit 超时后分支可能已推进而卡上无记录。
5. **运行时状态不可见**：stale .git/index.lock、merge queue 跳过、team 懒初始化、action 附带 snapshot、缓存命中率等都没有统一诊断/日志；最近两次误判都来自这里。
6. **工程护栏不足**：没有 lint/typecheck/coverage/CI，测试是 11 个巨型集成套件，e2e 0% 自动化；仓库里还有 .investigate 5.5MB、.local 177MB 的过程文件。

**目标**：分层模块化单体（modular monolith），一个任务中心内核 + 明确端口/适配器 + 一个由源码构建的单 client bundle；Godot 桥独立 bounded context；先加护栏和诊断，再按行为保持的方式逐步拆分，不做 big-bang 重写。

## 2. 现状地图

### 2.1 规模

- 230 个文件、约 94k 行（含 .investigate 过程文件约 30k 行）；核心源码约 26k 行。
- 任务中心后端：api 6,161、service 1,347、board 916、schema 822、state 421、routes 383、tool 188、index 365、dispatch 4,923、merge 877、git 627、harness 917、onboard 509。
- 前端：client/client.js 约 7,000 行，单文件；DSH 约束一个包只能暴露一个 ./client bundle。
- Godot 桥：godot-bridge.mjs 2,123 行；mcp_interaction_server.gd 4,934 行；godot_operations.gd 1,888 行。
- 测试：11 套件约 24,482 行、2,837 断言；task-routes 7,923、client-bundle 5,848、dispatch 5,508。

### 2.2 数据流

```
tool.execute / HTTP /action
  → api.perform
  → resolveIncoming（项目/session/role）
  → performResolved（41 个 action 分支）
  → service/model（纯模型）
  → state.apply（state.mjs）
  → updateBoard（board.mjs CAS）
```

- 第二条写路径：dispatch.mjs 直接 state.apply 11 处，绕过 api.writeTask；ownerSession 领养等不变量不在唯一写缝。
- merge queue 是独立串行队列（merge.mjs），candidate 在 test-<id> worktree 中构建，合并通过 advanceTarget 推进 target ref。
- 面板只读 /state + /worktrees + /task，动作走 /action；轮询 2.5s。

### 2.3 强项（保留）

- 一个动作词汇、一个 phase machine、一个 board CAS。
- worktree 创建串行化、180s 超时、失败回滚。
- reviewer/tester 独立上下文 + API 角色门禁。
- target 分支保护与 merge 幂等。
- 详细的 ARCHITECTURE.md 和 runtime skill。

## 3. 分域问题清单

### 3.1 后端核心（api / service / board / schema / state / routes / tool）

**P0**

1. api.mjs 几乎是单个 createApi() 闭包（312–6161），约 90 个内层函数；performResolved（4292–5495）1,204 行、41 个 if 分支。ACTIONS 名字数组 + DEV_ONLY/USER_ONLY/READ 三张平行名单，新增动作要改 4 处。
2. 不变量不在写缝：ownerSession 领养只在 api.writeTask（3308–3340）；dispatch 直接 state.apply 11 处，可能写出无主卡。verdict/role 门禁只在 API 层。
3. 失败三形状：{ok:false} / {failed} / throw；failure/fail/ok/done 在 6 个文件各写一遍；66 个拒绝码是面板/工具契约，却没有集中定义和集合级测试。

**P1**

4. board.mjs 四合一：项目注册表、归档、roles.json、board CAS；任何改动都碰 900 行文件。
5. 依赖倒置：表面层 api.mjs 反向 import dispatch.mjs 41 个符号（33–74），API 测试被迫拖入 brief/lead/roster 全套。
6. 项目解析 4 份：routes.resolveProject、api.resolveIncoming、state.resolveProject、tool.projectPathOf；api.projectFrom 已无调用者且用 projectHint 兜底。
7. state.memory 整体导出，api.reconcileLocks 直接改 state.memory.locks；locks/sessionRoots/projectHint 是跨模块可写的隐式全局。
8. 读模型两套：service.summary/detail 与 api.summaryOf/detailOf 各投影一次。
9. HTTP 层做业务：删 result.board、拼 snapshot、limit 未校验。

**P2**

10. 用户文案写在判定代码里（api 28 行含中文，中英混排）；应只回 code+params。
11. 命名漂移：board/snapshot/state 同物异名；start 与 dispatch 语义重叠。
12. 拒绝只回 message 字符串，不进 logger/activity；14 处空 catch 吞原因。
13. 输入契约两处：tool.mjs 手写参数表 + schema.mjs 归一化器；13 个测试各自重写 check()。

### 3.2 调度 / 合并 / git / 运行时正确性

**结构事实**

- dispatch.mjs 4,923 行、108 个顶层声明；scheduler 在 tick（4261）里串行处理租约/reap/角色供给/worktree/超时扫描/通知，**tick 是全项目单事务**。
- board 全量 JSON read-modify-CAS-write；一次派发对一张卡写 3–6 次。
- 内存真相：locks、dispatcher 状态、role manager、interrupt memory、merge chain、mergingCandidates；见 state.mjs 39–51、dispatch.mjs 3235–3255/2770/4820、merge.mjs 238、api.mjs 341。
- git 是纯注入 runner；worktree 门按项目串行；merge 按 target 分链，unit 上限 135s。
- 多处模块级 WeakMap/fallback（stage slot、phase activity、member projects），运行时状态隐式。

**P0（运行时正确性）**

1. **跨进程无所有权**：bootId 只是进程内 UUID（dispatch 352–359）；另一个 host 认领的 running 卡在 reap 里被判 “worker lost” 并抢回（3682–3698）；文件锁只在内存（state 40），restoreLocks 只恢复本 boot 的行（3506）。共享 ~/.dsh registry 时，两个 DSH 进程驱动同一项目会互抢、锁互不可见。
2. **git 工作区无自愈**：全仓没有 stale .git/index.lock 清理（git 139/1425 仅注释）；advanceTarget 在主 checkout 上 mergeFfOnly（merge 380–397/650），进程被杀（dispatch 1271/1276）即留 MERGE_HEAD/index.lock，而 mergeAbort 只作用于 integration worktree（474）。此后 isClean 失败→status-unreadable（1378）→每轮跳卡，30s 后升格 dirty-worktree 等待（3385–3434）；非 transient 的 worktree-add-timeout/-failed 直接 pause 整个项目（3479–3494/4596–4604）；残留 checkout 靠人工 worktreesCleanup（api 166）。
3. **merge 队列单向放弃**：unit 超时后 token 置 aborted 但 git 继续（merge 266–273 自述），api 只在写板前查 token（api 742/805）→ 分支可能已推进而卡上无记录，下轮 sweep 重建 candidate，形成“卡住/回环”；chains 也在内存（238），重启后无从判断上轮是否落地。

**P1**

4. tick 全项目单事务：单卡 worktree 失败即 break+pause（4604），无整体预算；settle 只等 10s 就抢第二轮（4797–4805）。
5. 内存即真相：drain（2770）、interruptMemory（4873 满 500 直接 clear）、activity ring（100 条，80–133）reload 全丢；drain 丢失会让已 drain 实例被复用。
6. action 附带 snapshot（routes 260–267）+ 2.5s 轮询：每次写全量重写板，snapshot 还逐卡 listMembers（3552）。
7. 错误分类散落字符串码；transient 仅 2 个（1329），无 {retryable, scope, owner}。
8. 团队解析每次全扫（466–550），role config 每轮重读（3816–3821），无缓存/失效协议。
9. 调度器绕过 API 写缝（11 处 state.apply）——与后端 P0 #2 同源。
10. 角色/brief/prompt 与 scheduler 同文件；session/team/project 语义分散；harness 字符串契约无测试。

**P2**

- 可观测性只有 ring + memory.lastError（3240），无结构化日志/阶段耗时。
- 测试四个文件各造 check()；dispatch 用 patchTask 直改板绕过 API（dispatch.test 72–85）、计时靠 settle；真实 git 永不执行 → index.lock 类故障零回归。

**建议**：LeaseRegistry + 项目 leader lease 落盘；WorkspaceManager + Reconciler（worktree list × 卡片 × 目录三向对账、stale lock/残留 worktree 回收、merge intent 恢复）；MergeQueue 状态机 + 幂等键 (id,base,head) + intent/outcome 落盘；tick 拆 stage/预算，失败 skip-card 而非 pause；action 只回 version，面板按 version 拉 /state；事件 ndjson + 健康检查；测试 port 注入 + 假 git 崩溃剧本（时间旅行 clock）。

### 3.3 前端（client/client.js）

**结构事实**

- 约 7,000 行单产物；i18n 600 键、CSS 411 行、纯函数 1801–2568、store 2574–2839、视图闭包 2842–6787、注册 6939–7018。
- RolesEditor 540 行、StatusView 634、DetailView 602、TaskCenter 561、TaskCard 213；React.memo=0、useCallback=0、useMemo=2。

**P0/P1**

1. 9 个模块级可变 store + 手动 bump useState，双源；View 收 props.store，DetailView/TaskForm/Forms 用闭包 store，注入两套约定。
2. 轮询固定 2.5s，无 visibility/退避/abort；一次失败清空整板（tasks:[]），没有 stale 保留；busy 单 token 全禁。
3. 每列每 2.5s JSON.parse localStorage；emit 新 snapshot 无 memo；t/allTasks 每轮新对象，memo 也无效。
4. 无 teamStatus 单一派生：可建队判定是 header 四层三元；team/projectMatch 在 4 处各判，null 与 false 混同；最近“无团队”误报就出在这里。
5. worktree 探测状态机寄生 StatusView 模块对象，失败后 probedSignature 已写，永不重试。
6. 报告 Markdown 解析器 190 行在闭包，只能靠渲染测试触及。
7. a11y：列头/队列行 role=button 无 onKeyDown；Modal 无焦点陷阱/Escape/aria。
8. 同一 h(Board) 写两遍且漂移；i18n 三套插值（replace 只替换首次）；retry 不校验 token。

**建议**：源码拆 + 零依赖拼接构建，仍产出唯一 client/client.js；selectors（teamStatus/boardGroups/worktreeStatus/detailTask）；资源化 store（data/status/error/lastOkAt）；删模块 store，显式注入；a11y 原语；真实 React 状态测试。

### 3.4 测试 / 构建 / 发布 / 仓库

**事实**

- 11 套件 24,482 行、2,837 断言；单元约 8%、集成约 84%、e2e 0%；run.mjs 只发现 *.test.mjs，e2e-two-projects.mjs 永不执行。
- 11 份 check() 自研；无隔离/超时；套件内 throw 截断；spawnSync 无 timeout。
- 巨型套件：task-routes 横跨 state/action/list/task/worktrees/cleanup/merge/roles；client-bundle 同理。
- fixtures 半集中，fakeHostSubprocess 两份；J:/ 常量 28 处；依赖 cwd。
- client-bundle 的 useState setter 是空函数、setInterval 打桩，无重渲染/轮询/竞态；GDScript 6,234 行零执行测试；godot_command 枚举与 .gd match 无生成/一致性校验。
- 无覆盖率（COVERAGE.md 是工具矩阵，不是代码覆盖率）；无 lint/typecheck/build/CI；.github 只有 issue/PR 模板。
- 版本倒挂：CHANGELOG 0.3.0 日期早于 0.2.1；[Unreleased] 60 行；无 version/CHANGELOG 门禁；发布手工。
- 仓库：.investigate 155 文件/5.5MB、.local 177.6MB；.git/info/exclude 与 .gitignore 分裂；.githooks 未入库；project.godot/ui/explore/shots/style-explorer.html 的归属不清。

### 3.5 Godot 桥 × 任务中心

- 模块级解耦合格：godot-bridge.mjs 只依赖 dsh-tools/schemastery/node；task-center 零 import 桥；两行由 cordis.patch.yml 组合。
- 隐式契约在字符串层：路由前缀、skill 名、dispatch 提示里的 godot_run_*；改名不会红。
- 单 client bundle 是宿主约束；引擎表单与任务中心面板同居。
- index.mjs 的 inject 无 subprocess，harness 延迟 ctx.get('subprocess')，缺失仅运行时降级；harness 出厂默认路径被入库的 .agents/test-harness.json 绑定。
- 沙箱收敛正确（Godot 只走 unconfined subprocess），但 .gd 无 CI 语法门。

### 3.6 运行时 / 可观测性（最近两次误判的根因）

- stale .git/index.lock 让 merge 的 git merge --ff-only 失败；sweep 只 skip，不记录原因；面板 open 被误读成“需要 merger”。
- team 是会话级懒初始化；面板在会话就绪前读到 team=null，显示“无团队”；发消息激活后恢复。
- action 成功附带完整 snapshot、status 挂载自动预检、worktree 缓存锚点/命中率，都缺少统一诊断。
- 没有 doctor/runbook/结构化事件；回答“为什么”只能靠读代码猜。

## 4. 目标架构

### 4.1 原则

- 单一职责：一个模块只有一个改变理由；文件目标 ≤500–800 行，函数 ≤50–80 行。
- 依赖单向：interfaces → application → domain；infra 实现端口；domain 不 import host/git/UI。
- 显式状态：所有跨模块状态通过显式 store/端口访问，不导出 memory 对象，不用模块级可变单例。
- 契约优先：动作表、拒绝码、HTTP 形状、工具 schema、skill 正文由同一份元数据生成。
- 错误即值：Result{ok,code,params,message}；跨边界不 throw；空 catch 禁止；日志带 correlation id。
- 可测试：domain 纯函数；application 用 fake ports；UI 用真实 React 状态；e2e 覆盖 host 生命周期。
- 可观测：git 命令、merge 单元、team/session、缓存、轮询都有事件和 /diagnostics。
- 文档即代码：ADR/runbook 与模块同仓，事故复盘必须落到 guard/test。

### 4.2 目录（建议）

```
plugin/
  godot-bridge/            # Godot 引擎桥（原 godot-bridge.mjs + .gd）
  task-center/
    kernel/                # Result/codes/caller/gates/pipeline
    domain/                # board/schema、tasks/phase、deps、leases、locks、reports
    application/           # actions（按域）、dispatch、merge、onboarding、diagnostics
    runtime/               # LeaseRegistry、WorkspaceManager/Reconciler、MergeQueue、Telemetry
    infrastructure/        # git、host（fs/sandbox/subprocess/agentTeams）、logging
    interfaces/            # tool、http、skill
    project/               # 唯一项目解析
client/
  src/                     # boot、api、store、selectors、views、components、css、i18n
  build.mjs                # 零依赖拼接 → 唯一 client/client.js
docs/
  adr/                     # 关键决策
  runbook/                 # 诊断/故障/发布
```

### 4.3 关键接口

```
createTaskCenter(deps) -> {
  perform(action, input, caller),
  snapshot(caller),
  taskDetail(id, caller),
  taskList(query, caller),
  worktrees(query, caller),
  autoMergePending(project),
  diagnostics()
}

ports:
  TaskBoard       { read, update, transaction }   // 持久化唯一写缝
  LockStore       { acquire, release, snapshot }
  LeaseRegistry   { claim, heartbeat, release, holder }
  WorkspaceManager{ reconcile, cleanStaleLocks, recoverMergeIntent }
  MergeQueue      { enqueue, state, recover }
  RoleProvisioner { ensure, drain, slots }
  Reconciler      { plan, apply, report }
  Telemetry       { event, metric, health }
  GitPort         { worktree*, status, merge*, ref, log }
  HostPort        { fs, sandbox, subprocess, agentTeams, skills, systemPrompt, clock }
  Logger          { event(name, fields) }
```

- actions 只依赖 domain + ports，不再 import dispatch.mjs；brief/lead/roster 通过 dispatch-port 暴露。
- 所有写板走 TaskBoard/transaction；dispatch 不再直接 state.apply。
- merge queue 是显式状态机，状态/拒绝码/耗时写入 diagnostics。
- client store 分 snapshot/taskStore/selectors；teamStatus 等派生只在一个 selector。

### 4.4 可读性规则（验收）

- 一个文件一个主题；index/barrel 只做导出；禁止循环依赖（dependency-cruiser/import boundary 测试）。
- 领域模型用纯函数；application 用 use case；infra 只做 IO；interfaces 只做协议转换。
- 命名统一：board（持久数据）/ snapshot（读模型）/ result（动作返回）/ caller（身份）。
- 每个动作一行元数据：name、handler、scope、readOnly、timeout、devOnly、description；tool/skill/route 自动生成。
- 每个拒绝码有常量、说明、集合快照测试；UI 文案按 code 映射，不在判定代码里拼中文。
- 每个模块有 README/ADR：职责、依赖、失败模式、测试入口。
- TypeScript 或 JSDoc + checkJs；ESLint/Prettier；CI 强制。

## 5. 迁移路线（行为保持，逐步）

**Phase 0：护栏与诊断（先做）**

- 加 lint/format/typecheck（JSDoc + tsc 或 TS）、coverage、CI（windows-latest）；e2e 入口。
- 加 doctor/diagnostics：stale .git/index.lock、merge queue 状态、team/session 就绪、worktree/cache、action snapshot；结构化 git 命令日志。
- 两个事故复盘 + runbook + ADR-001（单 client bundle）、ADR-002（subprocess 沙箱）、ADR-003（action/拒绝码契约）。

**Phase 1：运行时正确性（P0）**

- **LeaseRegistry + 项目 leader lease 落盘**：pid/bootId/heartbeat/TTL；reap 只回收自己认领或租约明确过期者；锁表随 lease 持久化，解决两个 DSH 进程互抢。
- **WorkspaceManager + Reconciler**：worktree list × 卡片 × 目录三向对账；stale .git/index.lock 按（无 pid、age、无持有进程）回收；主 checkout 的 merge intent 启动先 abort/恢复；只处理“已登记 ∧ 无 running 卡 ∧ 超宽限”的 worktree，先改名隔离再删。
- **MergeQueue 状态机 + 幂等**：状态 candidate→approved→merging→merged/failed/stale；幂等键 (id,base,head)；intent/outcome 落盘，启动 reconcile；unit 超时后 token 中止与 git 继续的竞态必须可检测；失败 code 进 diagnostics/活动。

**Phase 2：后端 kernel**

- 抽 Result/codes、caller、gates、pipeline、actions/registry；41 个 if 变表驱动；保持动作名/拒绝码/顺序；加特征测试。
- 先加 dispatch-port 适配层，避免 api 的 41 个 import 原样搬走。

**Phase 3：领域与写缝**

- board.mjs 拆 registry/archive/roles-config/board；唯一项目解析；state.memory 改访问器；所有写板走 TaskBoard/transaction；ownerSession 不变量进写缝。
- actions 按域拆（lifecycle/read-model/verdicts/merge/roles/worktrees/onboard/harness）。

**Phase 4：调度 / 角色 / worktree / action 解耦**

- dispatch 拆 scheduler/worker-pool/roles/brief/worktree；merge 拆 queue/candidate/integration；git 端口加 lock 检测/日志。
- tick 拆 stage/预算，失败 skip-card 而非 break+pause；action 只回 version，面板按 version 拉 /state；事件 ndjson + 健康检查。

**Phase 5：前端源码拆分**

- client/src + build.mjs；先纯函数/format/ReportMarkdown，再 store/api/selectors，再视图；仍产出单 client.js；watch 模式避免 DX 退化。
- 真实 React 渲染测试；a11y 原语；i18n 单插值；删除 9 个模块 store。

**Phase 6：测试/CI/e2e/Godot 契约**

- node:test + support/factories；套件按域拆；真实进程重启/锁/队列 e2e；覆盖率门禁；.gd --check-only；godot_command 枚举从 .gd 生成 + golden。

**Phase 7：仓库/文档/发布**

- .investigate 归档为 docs/evidence/<T> 并清理；.local 移出仓库；.git/info/exclude 迁 .gitignore；版本/CHANGELOG 门禁；tag 触发发布；README/ARCHITECTURE 拆分；ADR/runbook。

每阶段独立 PR、测试全绿、行为不变；不追求一次重写。

## 6. 风险与决策

- **跨进程双真相**：旧内存锁与新 LeaseRegistry 会短暂并存；必须一次性切换 + kill-switch，reap 只认自己的 lease 或明确过期。
- **Reconciler 误删**：自动删 worktree 只能处理“已登记 ∧ 无 running 卡 ∧ 超宽限”，先改名隔离再删；否则宁可报 diagnostics。
- **merge intent 与板 schema**：merge intent 落盘、board schema 变更要和 dispatch 4.9k 行拆分同批发布，否则 reload 期旧行读新板；candidate 重建计次/跨轮上限改动会动 tester 流程，需 e2e。
- **bootId 语义**：改成持久 lease 会破坏既有“reload 不算重启”保证；需要兼容窗口和迁移脚本。
- 拒绝码/动作名是面板与模型契约：先固化常量 + 快照测试，再重构；改名会同时打破 client-bundle 和 skill。
- gates 求值次序承重（heartbeat→stopped→devOnly→handler）；表驱动必须锁死顺序。
- 三层串行化（board CAS、merge queue、api serialised）不能拆散；TaskBoard 必须单实例注入。
- DSH 单 client bundle 是硬约束：源码可拆，产物必须一个；构建必须提供 watch。
- 运行时状态（team/session/merge queue）不能只靠代码推断；doctor/logs 先于重构。
- 测试夹具面广；模块移动与 DI 改造放同一 PR，避免两次大 diff。
- 决策待定：TypeScript 还是 JSDoc + checkJs；client 构建工具（esbuild/零依赖）；node:test 迁移；e2e 范围；是否把 Godot 桥拆成独立包（DSH 仍可一行挂载）。

## 7. 建议先做的三张卡

1. **诊断与运行手册**：doctor/diagnostics + stale index.lock/merge queue/team 就绪/worktree 缓存检查 + 结构化 git/merge 日志 + 两个事故复盘 + runbook。
2. **运行时正确性（P0）**：项目 leader lease + WorkspaceManager/Reconciler（stale lock/残留 worktree/merge intent）+ MergeQueue 状态机/幂等。若一张太大，拆成“lease+reconciler”和“merge queue”两张，但仍排在 kernel 前。
3. **后端 kernel 抽取**：Result/codes/gates/pipeline/registry + 特征测试；行为保持；先加 dispatch-port。

client 源码拆分排 Phase 5：它重要，但不是当前故障源；先让运行时真相可恢复、可诊断，再拆 UI 才不会边拆边猜。

## 附录：证据索引

- 后端行数/分支：api.mjs 312–6161、4292–5495；board.mjs 57–916；state.mjs 39–51/342；routes.mjs 111–134。
- 写缝：api.mjs 3308–3340；dispatch.mjs 3338/3438/3456/3481/3667/4243/4526/4623/4675/4723/4745。
- 前端：client.js 2426/3971/4623/4626/5357/6186/6189/6193；2574–2839；2842–6787；6320–6381；5005–5006。
- 测试：scripts/test/run.mjs:20–23；task-routes 7,923 行；client-bundle 5,848；dispatch 5,508；fixtures.mjs 430。
- 调度/运行时：dispatch tick 3186–4815/4261；bootId 352–359；reap 3682–3698；restoreLocks 3506；state.mjs 39–51；merge 224–687/266–273/380–397/650；dispatch 1271/1276；api 742/805；routes 260–267；dispatch.test 72–85；activity 80–133；interrupt 4873；role config 3816–3821。
- 工程：package.json scripts；.github 无 workflow；CHANGELOG 0.3.0/0.2.1 日期倒挂；.investigate 5.5MB。
