# 任务中心参考

## 动作矩阵

**只读（并发安全）**：`board`、`list`、`get`、`locks`、`harnessStatus`。
**可写（模型侧）**：`create`、`update`、`delete`、`start`、`pause`、`tick`、`submit`、`report`、`approveReview`、`requestChanges`、`passTest`、`failTest`、`mergeRequest`、`refreshMerge`、`rejectMerge`、`harnessStart`、`harnessStop`、`harnessRestart`、`harnessSmoke`、`bootstrapTeam`、`cancelStartRequest`、`cancel`、`reopen`、`block`、`unblock`、`retry`、`openProject`、`onboard`。

- `pause` 暂停/恢复**派发器**（同面板开关），不是单张卡；`start` 是申请。`tick` 立即跑一轮 settle，排查“为什么没派发”。
- 归属：`submit`、`refreshMerge` 仅 assignee / 用户 / merger。
- 仅评审：`approveReview`、`requestChanges`；仅测试：`passTest`、`failTest`、`harnessStart`、`harnessStop`、`harnessRestart`、`harnessStatus`、`harnessSmoke`；仅合并：`mergeRequest`、`rejectMerge`。
- 仅用户（工具不暴露，agent 调用报 `user-only`）：`settings`、`rolesList`、`rolesPreview`、`rolesCreate`、`rolesUpdate`、`rolesDelete`、`rolesBind`、`rolesDrain`、`rolesReplace`、`rolesPrune`、`rolesReset`、`skillsCatalog`、`approveStart`、`rejectStart`、`worktreesCleanup`。

## 拒绝码（可读失败，不是崩溃）

- `unknown-project` / `missing-project` / `missing-path`：项目没绑定或路径不对 —— 先 `openProject`。
- `needs-consent`：start 只是申请 —— 等用户批准，别重试。
- `wrong-role` / `role-required` / `worker-cannot-self-review` / `worker-cannot-self-test`：结论只属于对应角色 —— 交独立 reviewer / tester。
- `merger-only` / `user-only`：合并与面板动作不属于你 —— 报告现状。
- `head-drift`：分支越过请求的 head —— `refreshMerge` 对齐。
- `test-required`/`review-required`/`not-mergeable-phase`：还到不了合并，按阶段走；`target-not-advanced`：合并没推进（ref 未动），查 git 报错。
- `worktree-*` / `invalid-verify`：worktree 没建好或 verify 声明不合法。
- `task-cancelled` / `task-blocked`：卡已取消/阻塞 —— 立即停止。
- `not-assignee` / `unknown-task`：不是你的卡或 id 不对 —— `board` 核对。

## 禁区

- 不手改 `.agents/tasks.json`（破坏并发保护与事件记录）。
- 不直接 commit / push 到 target：只在任务 worktree 里提交自己的分支。
- 不给自己的提交开守卫豁免、不改检查脚本让结果“变绿”——那是绕过评审。
- 不自己发起派发（批准权在用户）；不杀用户 / 编辑器进程；不手工建删 worktree。
- 不替 reviewer/tester 写结论、不伪造 evidence；任务离开 running 后宿主会中断执行者。

## Godot 专属

只用 `godot_*` 工具（`godot_run_headless` / `godot_run_project`）跑游戏；绝不走 pwsh/bash 跑 `godot --headless`（沙箱拦 user:// 写入，signal 11 崩）。`diagnosis:"sandbox-crash"` 是启动通道问题，用 godot_* 重跑。

## 面板

任务页 5 页签：`看板`、`队列`、`执行者`、`状态`、`角色`。只有用户能：批/拒派发、开关派发、改设置、管角色、代替 reviewer/tester/merger 下结论——agent 写成“请用户操作”。

## 角色分组

评审 `approveReview`、`requestChanges`；测试 `passTest`、`failTest`、`harnessStart`、`harnessStop`、`harnessRestart`、`harnessStatus`、`harnessSmoke`；合并 `mergeRequest`、`rejectMerge`；归属 `submit`、`refreshMerge`。
