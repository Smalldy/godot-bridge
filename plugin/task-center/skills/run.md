# 派发与执行

## 先能派发，再建卡

- 项目 board 是项目级的；每张卡有 `ownerSession`，运行中的卡由该根 Agent spawn 的 worker 执行。
- 没有 Team、没有 `dispatchReady`、没有 Lead 花名册；reviewer/tester 只在自己的阶段存在，结束后释放。
- `onboard` 盘点项目与会话；别的会话有进行中卡时只做归属提示，默认**不接管**，按 `next.code` 让用户选择。
- 面板只有一个工作区作用域条：与当前对话工作区不一致时自动跟随（spinner → 淡入），未接入显示 setup 卡，失败保留旧 board 并在条内报错。

## start 是申请，不是启动

- `start` 是 **dispatch-wide**：只申请调度器开始派发，不接受 `taskId`。
- 返回 `needs-consent` 不是失败：等用户在任务中心面板批准，不要重试、不要自己开派发。
- 带 `taskId` 调 `start` 会返回 `start-is-dispatch-only`；要指定卡，用 `board`/`get` 看调度结果。

## 调度器

- `pause` 暂停/恢复**派发器**（同面板开关），不是单张卡。
- `tick` 立即跑一轮 settle，排查“为什么没派发”。
- `maxConcurrent` 是并发运行卡数；每张运行中的卡一个 worker，reviewer/tester 是阶段子代理，不占常驻槽位。

## worktree 与中断

- 任务工作只在该任务自己的 git worktree 里做；绝不直接 commit/push 到 target。
- 一卡一个活执行者：重派发先中断旧执行者，停不下来就拒（`already-dispatched`），`liveExecutors` 正常 0/1。
- 优先复用上次干净未提交的 worktree。
- **重启不消耗尝试**：收回 running 卡时 attempt 退还，只累加 `interruptions`；连续 5 次中断且没提交才 blocked（`interrupted-too-often`）。

## 状态与追踪

- `board` 看阶段、轮次、`waitingReason`、`queuePosition`（默认 TaskSummary 分页：`limit`/`cursor`，`view:"full"` 仅诊断）；`get` 取 spec/acceptance/evidence/history 等 detail。状态/执行者页展示根 Agent 的执行树，没有 Team 聚合。
- 派发前看依赖是否 done+merged；target 动了结论失效，用 `refreshMerge` 重开一轮。
- 卡住先查事实：看板、分支、ref、合并记录，再决定 reopen / retry / 打回。

## 非 Godot / 无 `.agents`

- 项目根 = git 根 + 标记（`.agents/` 看板 **或** `project.godot` Godot）；**空 `.agents/` 就够，不要求 Godot**。
- `.agents/`、`.worktrees/` 会写入 `.git/info/exclude`。
- 显式 `project` 参数可绕过标记，但面板/onboard 不认，不推荐。
- `verify` 别盲写 `npm run verify`（如 `verify:blender` 缺 Blender 会失败）：先看 package scripts，用 typecheck/test，首次接入在宿主侧实测。

