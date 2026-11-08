# 写卡

## 写卡规范

- spec 自包含：目标 / 背景代码 / 要求 / 测试方法 / 验收；按真实源码写，不猜接口。
- acceptance 必须可判定：命令、退出码、断言、截图说明；不要写“看起来正常”。
- writeFiles 就是锁：派发前原子加锁，漏写会互踩；文件路径相对项目根。
- dependsOn 表示前序必须 **done + merged**；不要依赖一张只是 running/reviewing 的卡。
- priority 只在 ready 卡之间比较；maxAttempts 用尽会 blocked。
- 改卡用 `update`；不要手改 `.agents/tasks.json`。

## verify

- `verify` 可选，声明一个宿主在候选 checkout 里执行的 shell 命令。
- 评审通过后宿主先跑 verify；失败/超时 = 宿主记 failTest，回 running，不占 tester 轮次。
- 别盲写 `npm run verify`：先看 package scripts，用 typecheck/test；首次接入在宿主侧实测。

## 调查卡（investigate）

- 什么时候用：只要答案/定位/对比，不交付可合并代码（要改产品开 dev 卡）。
- `create` 带 `kind: "investigate"`；生命周期 待办→进行→完成，**无评审/测试/合并**。
- 执行：派发到 detached scratch（无分支）；可跑命令、改代码，但**不 commit、不 submit、不 merge**；需要第二份 checkout 只用 `probe-<id>-*`，宿主会清掉。
- 交付：`task_center { action: "report", id, summary, body, evidence? }`。
  - summary 是结论（≤4 KB）
  - body 是完整报告（≤64 KB，全文写 `.agents/reports/<id>.md`）
  - evidence 是 `{ command, exitCode, outputTail }` 数组（≤20 条）
  - artifacts 列探测 checkout 的路径
- 写法：结论以证据为准（命令、exit code、输出尾部、复现步骤）；没有 `report` 不算完成。
- 拒绝码：`submit` 拒 `investigation-report-only`；评审/测试/合并拒 `not-a-dev-task`。
