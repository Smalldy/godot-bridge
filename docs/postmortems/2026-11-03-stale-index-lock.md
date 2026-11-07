# 事故复盘：T-150/T-151 merge 停在 open

- 日期：2026-11-03 23:35（锁创建）→ 2026-11-04（发现）
- 影响：两张已通过 review/test 的卡没有自动合并；面板显示 merge open；被误判为“队列卡住/需要 merger”。

## 现象

- T-150/T-151 的 test 已 passed，merge status 仍 open；
- autoMerge sweep 每 5s 运行，lastSweep 只记 skipped，不记原因；
- 主工作树在 feat/task-center-v2，merge 走 git merge --ff-only。

## 根因

- 主仓库 .git/index.lock 存在，0 字节，LastWriteTime 2026-11-03 23:35:09，当前没有 git 进程；
- 这是陈旧锁：某个 git 进程在写 index 时被中断（host/DSH 关闭、命令超时或崩溃）留下的；
- mergeFfOnly 因 index.lock 失败；autoMerge 只 skip，请求保持 open。

## 证据

- Get-Item .git/index.lock：Length 0，LastWriteTime 2026/11/3 23:35:09；
- Get-Process git：无；
- 删除锁后 lastSweep merged:1，T-151 合入 695e20b；T-150 rebase 后合入 b486562。

## 检测缺口

- merge 失败没有 surface 到卡/活动；sweep 只计数；
- 没有 doctor/锁检查；
- 回答“为什么”时先猜队列，后查锁。

## 动作

- 删除陈旧锁（确认无 git 进程）；
- T-150 rebase/refreshMerge，auto-merge 恢复；
- 记录本复盘。

## Guard

- doctor 检查 index.lock age/suspectedStale，merge queue last code；
- 未来 WorkspaceReconciler 在 merge 前检测/回收 stale lock，失败 code 进 diagnostics；
- 测试：doctor.test.mjs 覆盖 stale lock 报告；后续 fake git 崩溃剧本覆盖 merge 失败。
