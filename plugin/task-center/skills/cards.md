# 写卡

## 写卡规范

- spec 自包含：目标 / 背景代码 / 要求 / 测试方法 / 验收；按真实源码写，不猜接口。
- acceptance 必须可判定：命令、退出码、断言、截图说明；不要写“看起来正常”。
- writeFiles 就是锁：派发前原子加锁，漏写会互踩；文件路径相对项目根。锁只负责串行，不表达先后。
- priority 只在 ready 卡之间比较；maxAttempts 用尽会 blocked。
- 每张卡有 `ownerSession`（创建它的会话）：看板按项目共享，但卡只由该根 Agent 的 worker 执行、阶段子代理评审/测试；不要替别的会话改卡或换 owner。
- 改卡用 `update`；不要手改 `.agents/tasks.json`。

## 拆卡与并行

拆卡按**不变量/契约**，不按文件数，也不按阶段机械切；一张卡交付一个可独立验收的产物。

1. **dependsOn 只表示逻辑前序**：B 在运行期消费 A 的 schema / 接口 / 产物。宿主等到前序 done + merged 才把 B 置为 ready；它不负责文件串行。
2. **文件重叠交给 writeFiles 锁**：只是改了同一批文件、没有逻辑先后，就**不要**加 dependsOn，让锁排队即可。
3. **大面积同文件重叠要合并或分层**：合成一张卡；或拆成**纯模块卡**（契约 / 数据结构，如 `stage-contract.mjs`：没有调用方接线，可先并行）+ **集成卡**（路由 / 动作 / 接线，`dependsOn` 模块卡，等它 done + merged 再接）。
4. **单卡可验收**：每张卡的 acceptance/probes 都能在该卡自己的 worktree 内执行完，不依赖同批另一张卡尚未落地的行为。
5. 不要把“等它合完我再改同一文件”写成 dependsOn —— 那是 writeFiles 的排队，不是逻辑依赖。

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
