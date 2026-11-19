# Decision Requests — Requirement Packet

> Status: v1 (2026-11-18) — approved for T-195..T-198.
> This file is the single copy source for task-center decision panels. Cards reference it; do not duplicate long copy in card specs.

## 1. Product decisions already aligned

- Host-initiated, non-blocking two-phase decisions. Agent never has to call `ask_user_question`.
- Every card creation asks. All kinds (dev/investigate).
- Review/test timeout may replace reviewer/tester.
- Cancel/delete show the full chained downstream tree; deletion of a dependency tree requires typing `DELETE`.
- Three consecutive default-continues on a stage timeout auto-block.
- Settings scope: global default + project override.
- Event 10 (host verify fail, merge conflict, worker lost/host restart, target drift, review rounds exhausted) defaults to **notify + auto-recover**, not a modal. After 2 failed auto-recoveries the same event escalates to ask.
- Raw `ask_user_question` remains a general agent tool; it is not the task-center decision path.

## 2. Common modal

```text
标题：关键决策
副标题：{taskId} · {eventLabel}
倒计时：{seconds}s 后自动选择「{defaultLabel}」
队列：还有 {n} 个待决策
入口：查看卡片详情
高危：输入 DELETE 确认
```

Rules:

- The default option is visibly marked.
- Countdown is shown from the server deadline, not a client-only timer.
- Only one question is foregrounded; the rest are queued.
- Answer is one-shot; late answers after expiry are ignored.
- High-risk destructive actions never auto-run on timeout.

## 3. Event catalog and copy

### 3.1 create

Title: `创建任务 {id}？`

Body:

```text
任务：{title}
类型：{dev / investigate}
目标：{target}
依赖：{deps / 无}
写入文件：{files / 无}
验收：{acceptance}
```

Options:

1. `创建任务` — 写入任务板并加入待办队列. Default.
2. `取消创建` — 不写入任务板，向 Agent 返回修改建议.

Textarea: `修改建议（可选）`

Timeout: 120s. Default: create.

Agent result: `已创建 T-184` or `已取消创建 T-184：{note}`.

### 3.2 start (dispatch approval)

Title: `派发 {id}？`

Body:

```text
任务已就绪，等待批准。
当前并发：{running}/{max}
```

Options:

1. `批准派发`
2. `暂不派发` — 保持待办，稍后决定. Default.
3. `取消申请`

Timeout: 300s. Default: hold.

### 3.3 dev timeout

Title: `{id} 开发超时`

Body:

```text
当前阶段：开发
已用时：{elapsed}
最后活动：{lastActivity}
工作树：{worktree}
未提交修改：{changedFiles} 个文件
连续超时：{count}/{max}
```

Options:

1. `继续等待 {minutes} 分钟` — 保留当前工作树，延长本轮开发. Default.
2. `重试开发` — 放弃当前未提交修改，从目标分支重新开始.
   - Requires checkbox: `我确认丢弃当前未提交修改`.
3. `取消任务` — 停止开发；下游 {n} 张卡将进入阻塞/需重新评估.
4. `取消并删除依赖树` — 删除本卡及所有链式下游（{n} 张），不可恢复. High-risk.

Timeout: 120s. Default: continue 20 minutes.

After the third consecutive default-continue: no more modal; auto-block and notify:

```text
T-184 连续 3 次开发超时，已自动阻塞。
```

### 3.4 review timeout

Title: `{id} 评审超时`

Body:

```text
当前 reviewer：{name}
已用时：{elapsed}
候选：{head}
评审轮次：{round}
```

Options:

1. `继续评审 {minutes} 分钟`. Default.
2. `更换 reviewer` — 释放当前 reviewer，另起一轮独立评审.
3. `阻塞任务` — 保留工作树和候选，等待人工处理.
4. `取消任务` — 下游 {n} 张卡需重新评估.

Timeout: 120s. Default: continue.

### 3.5 test timeout

Title: `{id} 测试超时`

Body:

```text
当前 tester：{name}
已用时：{elapsed}
候选：{head}
测试轮次：{round}
```

Options:

1. `继续测试 {minutes} 分钟`. Default.
2. `更换 tester`.
3. `阻塞任务`.
4. `取消任务`.

Timeout: 120s. Default: continue.

### 3.6 reopen

Title: `重新打开 {id}？`

Body:

```text
当前状态：{done / cancelled / blocked}
重新打开会：
- 回到待办
- 清空 review/test 现场
- 由 scheduler 重新派发
```

Options:

1. `重新打开` — Default.
2. `保持关闭`.

Timeout: 120s.

### 3.7 delete

Title: `删除 {id}？`

Body:

```text
任务：{title}
状态：{status}
被依赖：{n} 张卡
下游：
{dependency tree}
```

Options:

1. `保留` — Default.
2. `删除` — 从任务板移除；下游卡的依赖会被解除.
   - 有下游时必须输入 `DELETE`.

Timeout: 120s. Default: keep.

### 3.8 cancel

Title: `取消 {id}？`

Body:

```text
当前状态：{status}
取消后：
- 终止当前 worker/reviewer/tester
- 下游 {n} 张卡进入阻塞/需重新评估
```

Options:

1. `返回` — Default.
2. `确认取消` — 任务进入取消终态.

Timeout: 120s. Default: return.

### 3.9 High-risk: delete dependency tree

Title: `确认删除依赖树？`

Body:

```text
将永久删除本卡及所有链式下游，共 {n} 张：

T-184
├─ T-185
│  └─ T-188
└─ T-187

该操作不可恢复。
```

Input: `输入 DELETE 确认`

Buttons:

1. `永久删除 {n} 张卡` — disabled until input is exactly `DELETE`.
2. `返回` — Default; timeout returns without deleting.

### 3.10 Event 10: notify-only

Default mode: notify. No modal.

Notification:

```text
{event} 已自动处置：{action}
任务继续：{id}
```

| Event | Auto action |
|---|---|
| host verify fail | return to development with evidence |
| merge conflict | return to worker with conflict files/brief |
| worker lost / host restart | redispatch |
| target drift | rebuild candidate and retest |
| review rounds exhausted | block and notify Lead; no auto-approval |

After 2 failed auto-recoveries: escalate to the corresponding ask panel (review/test/merge decision).

## 4. Settings copy

Page title: `关键决策设置`

Scope: `全局默认 / 项目覆盖`

Events:

```text
创建卡片
派发批准
开发超时
Review 超时
Test 超时
Reopen
Delete
Cancel
Host 验证失败
合并冲突
执行者丢失
Target drift
评审轮次用尽
```

Per event:

```text
提问模式：[ask / notify / silent]
默认选项：[下拉]
回答超时：[120] 秒
连续上限：[3] 次
连续自动恢复上限：[2] 次
恢复默认
```

Fixed high-risk protection:

```text
删除依赖树：
[x] 始终要求输入 DELETE
[x] 超时不允许自动删除
```

## 5. Defaults

| Event | Mode | Default | Timeout | Limit |
|---|---|---|---|---|
| create | ask | 创建 | 120s | — |
| dispatch | ask | 暂不派发 | 300s | — |
| dev timeout | ask | 继续 20m | 120s | 3 |
| review timeout | ask | 继续 20m | 120s | 3 |
| test timeout | ask | 继续 20m | 120s | 3 |
| reopen | ask | 重新打开 | 120s | — |
| delete | ask | 保留 | 120s | — |
| cancel | ask | 返回 | 120s | — |
| host verify fail | notify | 退回开发 | — | 2 |
| merge conflict | notify | 退回开发 | — | 2 |
| worker lost | notify | 重新派发 | — | 2 |
| target drift | notify | 重建并重测 | — | 2 |
| review rounds exhausted | notify | 阻塞 | — | — |

## 6. Acceptance for implementing cards

- Every event above has a stable i18n key and zh/en copy.
- The modal shows server deadline and default option; late answers are ignored.
- High-risk deletion requires exact `DELETE`; timeout does not delete.
- Event 10 does not open a modal by default; it writes an activity entry and notifies the user.
- Consecutive counters are per card/stage and reset on progress, verdict, or submit.
- Settings persist and project overrides fall back to global.
- Tests assert exact copy keys and the defaults in section 5.

## 7. Change control

- Need a copy change? Edit this packet, bump the version/date, update the i18n keys and tests in the same change.
- Do not patch copy only in a card spec or chat.
- Cards reference this file as `Spec: docs/refactor/specs/decision-requests.md`.
