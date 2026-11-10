# Task Center 运行手册

> 适用：godot-bridge task center（插件行 godot-bridge/task-center）。
> 先取证，再动作。不要在没有证据时删锁、删 worktree 或重置分支。

## 1. 诊断入口

- HTTP：GET /godot-bridge/task-center/diagnostics?project=<绝对路径>
- 返回：project、dispatch（agents/agentTeams/lead/members）、scheduler.status、merge（active/queued/chains/last）、doctor。
- doctor 检查：
  - git-repo：项目是否是可读 git worktree；
  - index-lock：.git/index.lock 是否存在、age、suspectedStale（默认 5 分钟）；
  - merge-state：MERGE_HEAD / rebase-merge / rebase-apply；
  - worktrees：git worktree list 的条目；
  - working-tree：是否 clean；
  - merge-queue：最近一个 merge unit 的 ok/code/message。
- doctor 只读，不修复；修复动作要人确认。

## 2. stale .git/index.lock

症状：
- 任务 review/test 已通过，merge 一直 open；
- merge 队列 last.code 可能是 queue-timeout/merge-failed，或没有记录；
- git merge --ff-only 报 index.lock 存在。

诊断（PowerShell）：
    Get-Item .git/index.lock -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime
    Get-Process git -ErrorAction SilentlyContinue
    git status --short

判断：
- 锁文件 0 字节、LastWriteTime 很旧、没有 git 进程 → 陈旧锁；
- 如果有 git 进程，或 MERGE_HEAD/rebase 存在，不要删；
- 删之前先备份分支/工作区；删锁只删 .git/index.lock，不删 index。

恢复：
    Remove-Item .git/index.lock -Force
    git status --short
    # 触发一次 merge sweep 或重新 refreshMerge；不要手改 tasks.json

预防：
- doctor 报 suspectedStale；
- 未来 WorkspaceReconciler 在 merge 前检查（无 pid、age、无持有进程）并 surface code，不静默 skip。

## 3. merge 队列卡住 / open

1. GET /diagnostics 看 merge.active/queued/last；active>0 且长时间不变 = 单元卡住；last.code 记录原因。
2. 看 board 的 task.merge.status/base/head/mergeCommit；base 落后 target = 需要 rebase/refreshMerge。
3. 查 stale index.lock（第 2 节）。
4. 查 worktree：git worktree list；candidate/integration 残留会让后续失败。
5. 不要连续点 merge；队列是串行的，重复点击只会排队。
6. 失败 code 进 runbook/复盘；不要只记“skipped”。

## 4. 团队缺失 / 懒初始化

症状：
- 面板按会话显示团队胶囊；`dispatchReady` 为 false 时提示等待 worker（缺 reviewer/tester 只在状态/角色页显示）；
- 看板 149/149 done 还在。

原因：
- Team 是会话级 Agent Teams 运行时对象，不跨 DSH 重启/新会话持久化；
- 面板可能在会话就绪前读到 team=null，发消息/激活 Lead 后自动恢复；
- 不是看板/项目数据丢失。

诊断：
- /diagnostics 的 dispatch.hasAgents/hasAgentTeams/lead/members；
- 当前会话是否已有 Lead；项目是否匹配。

恢复：
- 先发一条对话激活会话，等一次轮询；
- 仍无团队 → 面板“建队”或 onboard bootstrapTeam；
- 不要因为“无团队”重建项目/删看板。

## 5. worktree 残留

- git worktree list；doctor.worktrees；
- worktreesCleanup 默认 dry-run，只删“已登记 ∧ 无 running 卡 ∧ 干净/已合并 ∧ 超宽限”；
- 不确定就保留，先改名隔离；不要 --force 删 running/dirty。

## 6. host 重启后

- 先跑 /diagnostics；
- 查 stale lock、merge intent、worktree；
- board 是 CAS 文件，先读再写；不要手改 .agents/tasks.json。

## 7. 证据格式

每次事故记录：现象、命令、原始输出、时间、根因、检测缺口、guard/test。
