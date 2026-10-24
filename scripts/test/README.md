## 裁决权限测试必须双向覆盖

审查（approveReview/requestChanges）与测试（passTest/failTest）是两条独立的权限路径，但共用 `verdictRefusal`。历史上有测试只覆盖 tester 方向，reviewer 侧被改回"第一个 Lead"时不会变红。规则：

- `scripts/test/task-routes.test.mjs` 的 T-112/T-114 区块以参数化 `kind = reviewer|tester` 跑同一组断言：跨会话 `wrong-session`、durable 名（reviewer-1/tester-1）在所属会话被接受、项目槽位（reviewer-p<key>-1/tester-p<key>-1）对自家 Lead 被接受、无角色成员 `role-required` 且消息含 roster。
- 新增权限方向（merge 等）时，必须同样补对称断言，而不是只测一侧。
- 静态守卫（dispatch.test.mjs）同时保证 `plugin/task-center/*.mjs` 没有裸 `resolveLead(ctx)`；展示类只允许显式 `resolveAnyLead`。

# 在 DSH 沙箱里跑真实进程（任务中心测试通道）

这个目录里的测试默认用 `node --test` 直接跑，不需要子进程。但 **e2e / 需要真实
进程边界或真实 git 的验证** 不能这样跑：本会话的沙箱禁止 `node` / `npm` 直接
派生带管道 stdio 的子进程，`spawn` / `spawnSync` 会立刻返回 `EPERM`（
`npm ci`、`npm test`、`npx vsce` 都会因此失败）。这不是代码 bug，是执行环境
的能力限制。

## 合法通道：Godot 的 unconfined subprocess 服务

`godot_run_headless` 通过宿主不受沙箱限制的 subprocess 服务启动 Godot，因此
**Godot 进程树里的 `OS.execute` 可以真正 spawn node**。用一份 driver 脚本把
命令转发进去即可：

```gdscript
# driver.gd —— 放进任意 Godot 项目（例如 .investigate/e2e-project），
# 用 godot_run_headless --script res://driver.gd 执行。
extends SceneTree

func _init():
    var output = []
    # 参数：node 脚本的绝对路径（或 "npm"/"npx" 及其参数）
    var code = OS.execute("node", ["J:/path/to/script.mjs"], output, true)
    print("EXIT=", code)
    for line in output:
        print(line)
    quit()
```

要点：`OS.execute` 读的是 **blocking** 模式（第 4 个参数 `true`），输出在
`output` 数组里；驱动脚本必须 `quit()`，否则 headless 会挂到超时。

## 什么时候用

- e2e：两个真实项目、真实 git、真实子进程重启（见 `e2e-two-projects.mjs`）。
- 需要真实 `git` 二进制或真进程边界的验证（合并 ref、hide/ignore、临时目录）。

## 什么时候不该用

- 普通单元测试继续走 `node --test` / `npm test`；不要为了跑单测把 Godot 拉进来。
- 纯逻辑测试不需要进程边界，夹具更快也更稳。

## 纪律

1. 任何脚本在无 spawn 环境（例如本会话的 shell）里必须 **打印 `SKIP` + 具体原因
   并以 0 退出**；不许静默跳过，更不许把 SKIP 当 PASS。
2. 验收必须附 **真实 transcript**（含退出码 `EXIT=` 与关键 PASS/FAIL 行），由
   tester 在隔离 harness 里执行后贴出。
3. **执行通道与判定角色分离**：执行可以由任何能 spawn 的通道完成（Godot driver、
   隔离 harness、用户 shell），但 PASS/FAIL 的判定仍归 tester —— worker 只能提供
   证据，不能宣布通过。
