# Task Center 重构执行计划

> 本文件是重构期间的**唯一协调源**。重构不依赖任务中心；任务中心 149/149 done，已冻结。
> 架构依据：[docs/architecture-review.md](../architecture-review.md)。
> 基线：代码 b486562；备份分支 backup/task-center-v2-pre-refactor-2026-11-07；标签 pre-refactor-2026-11-07；bundle .git/backups/pre-refactor-2026-11-07.bundle。
> 工作树：.worktrees/refactor-arch（分支 merge/task-center-refactor）；主工作树 feat/task-center-v2 保持稳定，运行中的宿主继续加载旧代码。

## 0. 约束

- 不使用 task_center 建卡、派发、评审或合并；不依赖任务中心可用。
- 不直接改主工作树；所有重构提交在 refactor worktree。
- 分支名刻意用 merge/：scripts/check-target-history.mjs 只把 task/test/merge 分支的合并视为可追溯；本次是项目级重构、不建 task center 卡，记录在本 PLAN。合并时必须 --no-ff，subject 为 Merge branch 'merge/task-center-refactor'，否则 guard 会判 untraceable。
- 每步行为保持；先加测试/诊断，再移动代码。
- 每个提交必须能单独回滚；合并前 npm run verify 全绿 + 独立 review。
- 不 push；备份/远端操作单独确认。

## 4. 进度

- 2026-11-07：基线 b486562；备份 branch/tag/bundle；隔离 worktree；B 首步（syntax guard、suite timeout、CI syntax job、17/17 verify）；A 首步（doctor 检查 index.lock/MERGE_HEAD/worktree/merge queue last、/diagnostics 接入、runbook、两份复盘）。
- A 剩余：team/session 的 loading/selector（E 的前端部分）、cache/action snapshot 检查。
- C 首步（2026-11-07）：workspace.mjs 提供只读 plan + 保守 apply：只在锁超龄、无 merge/rebase、注入的 processChecker 明确返回 false 时把 index.lock 改名隔离，绝不删除；未知进程状态一律 manual-check。diagnostics 暴露 workspace plan。18/18 verify。
- C 第二步（2026-11-07）：lease-registry.mjs 提供跨进程项目 leader lease（owner/bootId/pid/heartbeat/TTL；文件锁 + 原子替换；held/renewed/released/expired）。19/19 verify。
- C 第三步（2026-11-07）：lease-gate.mjs 接入 dispatcher：tick 前 claim，非 leader 返回 not-leader 且不读/不 reap/不 claim；status 暴露 leader；dispose releaseAll；index 按项目注入 .agents/leader-leases.json。20/20 verify。尚未做双进程 e2e。
- C 第四步（2026-11-07）：merge-journal.mjs 提供持久 merge intent/outcome + planReconcile（merged/abandoned/stale）；21/21 verify。
- C 第五步（2026-11-07）：journal 接入 merge.mjs 的 mergeRequest：git 前 begin，返回后 finish；journal 失败不阻断 merge；index 按项目注入 .agents/merge-journal.json。22/22 verify。
- C 第六步（2026-11-07）：merge-reconcile.mjs 在每个 leader tick 前运行：读 pending intent、解析 target head、isAncestor；mark-merged 先写 board（recordMergeResult）再 finish journal；abandoned/stale 只关 journal；board 写失败保留 pending 重试。23/23 verify。
- C 第七步（2026-11-07）：process-check.mjs（Windows tasklist / POSIX ps，注入 runner；失败=unknown）接入 workspace；mergeRequest 在 clean/target 探测前跑 workspace preflight：stale lock 可 rename 恢复，fresh/held/merge 状态返回 workspace-blocked，不再静默失败。25/25 verify。
- C 第八步（2026-11-07）：真实双 node 进程抢同一 lease（恰好一个赢）；新 journal 实例读取旧文件并 reconcile board（重启语义）。27/27 verify。
- C 阶段完成，带边界：process-check 用 Node execFile（宿主沙箱禁止则 unknown → manual-check）；没有真实 DSH host 重启/双 dispatcher e2e。
- D 第一步（2026-11-07）：actions/registry.mjs 成为唯一动作元数据表；ACTIONS/DEV_ONLY/USER_ONLY/READ/AGENT 全部派生，保持原顺序；api.mjs 只 re-export。28/28 verify。
- D 第二步（2026-11-07）：actions/read.mjs 抽出 board/list/get/locks；performResolved 改为 readActions 表路由；语义不变。29/29 verify。
- D 第三步（2026-11-07）：actions/harness.mjs 抽出 harnessStart/Stop/Restart/Status/Smoke；权限/不可用/status 平铺字段保持不变。30/30 verify。
- D 第四步（2026-11-07）：dispatch-port.mjs 成为 API 到 dispatcher 的唯一命名端口；api.mjs 不再直接 import dispatch.mjs。31/31 verify。端口目前是 re-export，下一步才收窄接口。
- D 第五步（2026-11-07）：actions/control.mjs 抽出 pause/settings/tick；settings 的 maxConcurrent 派生、user-only、no-change、scheduler kick 保持不变。32/32 verify。
- D 第六步（2026-11-07）：actions/lifecycle.mjs 抽出 cancel/reopen/unblock/retry/block；锁释放、interrupt、investigation cleanup 语义不变。33/33 verify。
- D 第七步（2026-11-07）：actions/roles.mjs 抽出 10 个 roles 动作；roleAdminRefusal、panel session 作用域、persist/ensure/drain 语义不变。33/33 verify。
- D 第八步（2026-11-07）：actions/merge.mjs 抽出 mergeRequest/rejectMerge；队列/notify/phase/open-merge 语义不变。refreshMerge 仍在 api.mjs。34/34 verify。
- D 第九步（2026-11-07）：refreshMerge 也迁入 actions/merge.mjs；branch/diff/reviewer 编排、base 重定位、fresh review round 语义不变。34/34 verify。
- D 第十步（2026-11-07）：actions/report.mjs 抽出 investigation report；writeTask/report file/cleanup/warnings 语义不变。34/34 verify。
- D 第十一步（2026-11-07）：actions/submit.mjs 抽出 submit；prepareMergeRequest、reviewer provisioning、review round limit、reviewer delivery、lock release 语义不变。34/34 verify。
- D 第十二步（2026-11-07）：actions/test-verdicts.mjs 抽出 passTest/failTest；candidate merge/discard、tester delivery、timeout、stage cleanup 语义不变。34/34 verify。
- D 第十三步（2026-11-07）：actions/review-verdicts.mjs 抽出 approveReview/requestChanges；candidate build/conflict/rebuild、host check、tester delivery、stage promotion 语义不变。34/34 verify。
- D 第十四步（2026-11-07）：actions/project.mjs 抽出 openProject/resolveIncoming；路径解析、preflight、registry flush、session binding、resolvedFrom 语义不变。34/34 verify。
- D 第十五步（2026-11-07）：actions/onboard.mjs 抽出 onboard；项目解析/绑定、Team 复用或 bootstrap、board facts、brief/next 语义不变。34/34 verify。
- D 第十六步（2026-11-07）：actions/task-admin.mjs 抽出 create/update/delete/start/approveStart/rejectStart/cancelStartRequest；Team gate、ownerSession、preflight、dispatch consent、interrupt 语义不变。34/34 verify。
- D 第十七步（2026-11-07）：actions/project-admin.mjs 抽出 skillsCatalog/worktreesCleanup/bootstrapTeam；user-only gate、worktree cleanup、team bootstrap 语义不变。34/34 verify。
- D 第十八步（2026-11-07）：kernel/action-preflight.mjs 抽出 lease heartbeat、stopped-card refusal、phase activity、dev-only guard；performResolved 现在只剩 remember/now + 一次 preflight + handler 表。34/34 verify。
- D 第十九步（2026-11-07）：kernel/gates.mjs 抽出 roleAdminRefusal/mergeRefusal/harnessRefusal/wrongProjectRefusal；verdictRefusal（roster/registry 回退）仍留在 api.mjs。34/34 verify。
- D 第二十步（2026-11-07）：kernel/verdict-gate.mjs 抽出 verdictRefusal；T-114 的源码断言改为读取 kernel/verdict-gate.mjs + api.mjs 的 callerLookup。34/34 verify。
- D 第二十一步（2026-11-07）：kernel/caller-helpers.mjs 抽出 callerIdentifiers/callerRoleKindOf/rosterSummary/isAssignee；callerLookup/callerMemberOf/ownerOf 仍在 api.mjs。34/34 verify。
- D 第二十二步（2026-11-07）：kernel/caller-lookup.mjs 抽出 callerLookup/callerMemberOf/callerRole/ownerOf/assigneeMatches；T-114 的源码断言同时读取 caller-lookup.mjs。34/34 verify。
- D 第二十三步（2026-11-07）：dispatch-port.mjs 改为单一 `dispatchPort` 对象；api.mjs 只 import 一个符号并解构 40 个字段。字段仍平铺，按 brief/lead/roster/workspace 分组留作后续。34/34 verify。
- D 阶段完成（caveat：端口对象是显式 seam，但尚未按能力分组）。
- E 第一步（2026-11-07）：client 源码拆成 client/src/*.part（head/selectors/store/views/tail），scripts/build-client.mjs 无依赖拼接为 client/client.js；verify 先构建。34/34 verify（client-bundle 仍全绿）。
- E 第二步（2026-11-07）：纯 selectors 迁到 client/src/selectors.cjs（35 个函数，可被 Node require），build 生成 IIFE 包装注入 bundle；session/column 状态留在 15-client-state.part。新增 client-selectors.test.mjs。35/35 verify。
- E 第三步（2026-11-07）：store 迁到 client/src/store.cjs（createTaskStore(t, deps)），build 生成绑定 TC_*/tc* 依赖的 wrapper；新增 client-store.test.mjs。36/36 verify。
- E 第四步（2026-11-07）：30-views.part 按域拆成 30-core/31-queue/32-roles/33-status/34-detail/35-forms/36-shell；拼接顺序固定，bundle 行为不变。36/36 verify。
- E 阶段完成（caveat：views 是分域片段，还不是可独立测试的 React 模块）。
- F 第一步（2026-11-07）：CI 从 syntax-only 改为 `npm run verify`（contract + syntax + client build + 36 suites）；新增 docs/refactor/TESTING.md 记录测试金字塔与已知缺口。36/36 verify。
- F 第二步（2026-11-07）：新增 docs/refactor/ARCHITECTURE.md 记录 host/browser 模块图与依赖规则；ARCHITECTURE.md / ARCHITECTURE.zh-CN.md 的 task-center 段落改为指向新模块。36/36 verify。
- 后续第一步（2026-11-08）：dispatchPort 按 brief/lead/roster/workspace/task/dispatch 分组；api 解构分组，平铺字段成为测试失败。36/36 verify。
- 后续第二步（2026-11-08）：TaskCard 迁到 client/src/views/task-card.cjs，build 注入 React/h/selectors/board helpers；新增 client-task-card.test.mjs。37/37 verify。
- 后续第三步（2026-11-08）：Column/Board 迁到 views/column.cjs、views/board.cjs；新增 client-column/client-board.test.mjs。39/39 verify。
- 后续第四步（2026-11-08）：DoneAllDrawer 迁到 views/done-all-drawer.cjs；新增 client-done-all.test.mjs。40/40 verify。
- 后续第五步（2026-11-08）：QueueRow/QueueView 迁到 views/queue.cjs；新增 client-queue.test.mjs。41/41 verify。
- 后续第六步（2026-11-08）：WorkersView 迁到 views/workers.cjs；新增 client-workers.test.mjs。42/42 verify。
- 后续第七步（2026-11-08）：AgentRow 迁到 views/agent-row.cjs；新增 client-agent-row.test.mjs。43/43 verify。
- 后续第八步（2026-11-08）：RoleCreateForm 迁到 views/role-create-form.cjs；新增 client-role-create-form.test.mjs。44/44 verify。
- 后续第九步（2026-11-08）：RolesView 迁到 views/roles-view.cjs；新增 client-roles-view.test.mjs。45/45 verify。
- 后续第十步（2026-11-08）：RolesEditor 迁到 views/roles-editor.cjs；新增 client-roles-editor.test.mjs。46/46 verify。
- 后续第十一步（2026-11-08）：StatusView 迁到 views/status-view.cjs；新增 client-status-view.test.mjs。47/47 verify。
- 后续第十二步（2026-11-08）：DetailView 迁到 views/detail-view.cjs；新增 client-detail-view.test.mjs。48/48 verify。
- 后续第十三步（2026-11-08）：TaskForm 迁到 views/task-form.cjs；新增 client-task-form.test.mjs。49/49 verify。
- 后续第十四步（2026-11-08）：SettingsForm/ProjectForm 迁到 views/settings-form.cjs、views/project-form.cjs；新增对应 per-view 测试。51/51 verify。
- 后续第十五步（2026-11-08）：Glyph 迁到 views/glyph.cjs；新增 client-glyph.test.mjs。52/52 verify。
- 下一阶段：TaskCenter shell；Godot e2e/contract 作为已知缺口。

## 1. 阶段

### A. 诊断与运行手册（先做）

范围：
- 新增 diagnostics 收集器：项目/会话、team 就绪、git 工作区、stale .git/index.lock、merge 队列、worktree/cache、action snapshot 开关。
- 结构化事件：git 命令 start/end/exit/duration；merge unit id/state；team/session 生命周期。
- runbook：stale index.lock、merge 队列卡住、team 缺失/懒初始化、host 重启、worktree 残留。
- 两个事故复盘：stale lock、team 懒初始化。

验收：
- 合成 stale index.lock / merge 失败时，diagnostics 能报出明确 code 和证据。
- 面板/HTTP 能读到健康状态；不改变现有动作语义。
- runbook 可照着排查；复盘有根因、检测缺口、guard。

### B. 工程护栏

范围：
- 语法检查（node --check，覆盖 plugin/client/scripts）；测试 runner 加 timeout/失败隔离。
- lint/format/typecheck 的引入策略（先 JSDoc + tsc 或 ESLint/Prettier，不一次全量改造）。
- CI 骨架：至少语法 + 现有 verify；完整测试 CI 依赖 DSH runtime 的解析方案，先 spike。
- 覆盖率：c8 或等价；先报告，不设阻断阈值。

验收：
- npm run check:syntax 可用并进入 verify。
- 故意写坏语法能被拦住；测试超时能失败并清理。
- CI 在本仓库可复现；不能复现的部分写清限制。

### C. 运行时正确性（P0）

- LeaseRegistry/项目 leader lease 落盘：pid/bootId/heartbeat/TTL；reap 只回收自己或明确过期者；锁随 lease 持久化。
- WorkspaceManager/Reconciler：worktree list × 卡片 × 目录对账；stale index.lock 回收；主 checkout merge intent 启动恢复；只处理已登记/无 running/超宽限的 worktree。
- MergeQueue 状态机/幂等：candidate→approved→merging→merged/failed/stale；幂等键 (id,base,head)；intent/outcome 落盘；启动 reconcile；失败 code 进 diagnostics。

验收：两个 DSH 进程不互抢；stale lock 自愈；merge 失败可解释；重启后可恢复。

### D. 后端 kernel

- Result/codes、caller、gates、pipeline、actions/registry；41 个 if 变表驱动；保持动作名/拒绝码/顺序。
- 先加 dispatch-port；再拆 actions 按域；board 四分；唯一项目解析；唯一写缝。
- 每步加特征测试，行为不变。

### E. 前端源码拆分

- client/src + build.mjs，仍产出唯一 client/client.js。
- selectors（teamStatus/boardGroups/worktreeStatus/detailTask）；资源化 store；删 9 个模块 store；真实 React 状态测试。
- watch 模式避免 DX 退化。

### F. 测试/CI/e2e/仓库

- node:test + support/factories；套件按域拆；真实 git 崩溃/锁/队列/重启 e2e；覆盖率门禁。
- Godot .gd --check-only；godot_command 枚举从 .gd 生成 + golden。
- .investigate 归档/清理；.local 移出；.git/info/exclude 迁 .gitignore；版本/CHANGELOG 门禁；tag 发布。

## 2. 每步流程

1. 在 refactor worktree 建小提交；先写失败测试/诊断，再改实现。
2. 本地 npm run verify（后续加 check:syntax/coverage）。
3. 独立 subagent review：范围、证据、回滚、测试。
4. 通过后合回 feat/task-center-v2；主工作树跑一次 smoke/doctor。
5. 坏了：git checkout pre-refactor-2026-11-07 或 backup 分支；不 force-push。

## 3. 第一轮

A + B 并行（文件不重叠）：
- A: docs/runbook + diagnostics 收集器 + 结构化事件。
- B: scripts/check-syntax.mjs + package.json + scripts/test/run.mjs timeout + CI 语法骨架。

完成 A/B 后再开 C。
