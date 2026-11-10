# 评审、测试、合并

## submit

- 本地验证通过并提交后带 evidence；`submit` 仅 assignee / 用户 / merger。
- submit 记录 base/head 和 actualFiles；不要伪造 evidence。
- 提交后宿主打开 review 阶段；worker 不要自己下结论。

## 评审

- 仅 reviewer 能 `approveReview` / `requestChanges`。
- reviewer 看 declared vs actual、候选 diff、hostCheck；有未声明文件或 base 漂移要指出。
- 打回在同一 worktree 修完再 submit；不要新开 checkout。
- 角色越权会被 `wrong-role` / `worker-cannot-self-review` 拒绝，那是分权。

## 候选与 hostCheck

- 评审通过后宿主构建独立测试候选（target 当前 head + 任务分支），不移动主检出。
- 候选的 base 可能比 submit 时更新；重建候选会刷新 `actualFiles`，reviewer 看到的是当前 base 的 diff。
- **target drift 必须显式说明**：dispatch/submit 记录 `targetBase` 和 `verifyFingerprint`；候选重建时若 target head 变了，宿主写 `merge.targetDrift = {from, to, at}` 并刷新 base/actualFiles，review brief 会显示 drift。
- **verify 变更必须显式说明**：verify 命令/超时（以及命令点名的脚本内容）变了会写 `merge.verifyChanged = true` 与旧/新 `merge.verifyFingerprints`，review brief 必须显示。缺这两个信号时不得声称“与上轮一致”。
- drift 不是自动失败：候选重建通过后可继续，但已批准的 review 结论按既有规则失效（内容变了要重评）；不要替 reviewer 决定是否接受新 base。
- 卡声明的 `verify` 由宿主在候选里先跑；失败/超时 = 宿主 failTest，回 running。
- 冲突自动重建；再次冲突升级 needs-rebase，等 worker/Lead。只认真实 hex base。

## 测试

- 仅 tester 能 `passTest` / `failTest`；tester 证据分【宿主基线】【我的探针】，基线是下限。
- reviewer 不必重跑 verify；declared vs actual 与 hostCheck 已在 brief 里。
- 一个 reviewer / tester 槽位串行处理；`queuePosition` 排队。

## 合并

- 仅 merger 或用户能 `mergeRequest` / `rejectMerge`。
- `merged` = target ref 真的前进了；`target-not-advanced` 停在 testing，查 git 报错。
- target 动了结论失效：用 `refreshMerge` 重开一轮。
- 合并由任务中心执行；Lead/worker 不要直接 commit/push 到 target。
