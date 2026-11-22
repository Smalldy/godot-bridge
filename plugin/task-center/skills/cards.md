# 写卡

## 写卡规范

- spec 自包含，按「卡片模板」的五段组织（问题 / 当前结论 / 方案 / 不做什么 / 验收）；按真实源码写，不猜接口。
- acceptance 必须可判定：命令、退出码、断言、截图说明；不要写“看起来正常”。
- writeFiles 就是锁：派发前原子加锁，漏写会互踩；文件路径相对项目根。锁只负责串行，不表达先后。
- 卡模型（宿主强制）：新 dev 卡必须声明 `verification.probes`（至少一条可执行命令，tester 会逐条执行）；生产文件 ≤ 5、生产改动 ≤ 250 行、acceptance ≤ 6 条、probes ≤ 8 条。测试文件与生成物 `client/client.js` 不计入生产预算；超限返回 typed error，须在设计阶段拆卡。调查卡（kind=investigate）不受此限；已存在的旧卡不会被静默改写，只有 update 显式声明的字段才校验。
- priority 只在 ready 卡之间比较；maxAttempts 用尽会 blocked。
- 每张卡有 `ownerSession`（创建它的会话）：看板按项目共享，但卡只由该根 Agent 的 worker 执行、阶段子代理评审/测试；不要替别的会话改卡或换 owner。
- 改卡用 `update`；不要手改 `.agents/tasks.json`。

## 卡片模板（spec 自包含）

worker 只拿到卡面（spec / acceptance / writeFiles / evidence），看不到创建者与用户的讨论。spec 必须**自包含**：把对话全部删掉，卡仍然能执行。按五段写：

1. **问题**：什么坏了 / 缺了什么；证据要落到能复现的地方（文件:行、失败命令与退出码、日志尾部、复现步骤）。
2. **当前结论**：已确认的事实与判断；每条结论后面带证据（代码位置、测试名、命令输出），不写“我觉得”。
3. **方案**：按顺序写要改什么、改哪里；有备选就写明它为什么被否（成本 / 风险 / 已验证不可行），别只留结论。
4. **不做什么**：边界——不新增的字段或参数、不改的文件、不动已有卡；防止 worker 顺手扩大范围或重复已否方案。
5. **验收**：可判定的命令、退出码、断言；一条一行，能在该卡 worktree 内执行。

**禁止**：“按商定”“如上”“之前说的”“跟上次一样”。这些词在卡上是失效引用——读卡的人不在那次对话里。把结论提炼进 spec，不引用对话。

### 反例

```
## 方案
按商定做，参考之前说的那版；边界如上。
```

问题：worker 不知道“商定”了什么、否掉了什么，只能猜或重做已否方案；reviewer 也无法判断是否超范围。

### 正例

```
## 问题
node 实测 init 4926 字节（buildInitContent）；写卡提示段 247 字节，直接加会到 5173，超过 5000（scripts/test/skill-resources.test.mjs 的长度断言）。

## 当前结论
不是测试阈值太紧，而是 init 里有两段重复的“你是谁 / 执行者”说明（代码：buildInitContent）；合并它们腾出的字节正好抵消提示段。

## 方案
1) 合并重复段落腾出字节；2) 加 spec 自包含提示；3) 测试覆盖提示、模板与长度。

## 不做什么
不新增 problem/background 字段、不改 create schema、不做机械校验、不改现有卡。

## 验收
`node --test scripts/test/skill-resources.test.mjs` 退出码 0；init < 5000 字节。
```

## 拆卡与并行

拆卡按**不变量/契约**，不按文件数，也不按阶段机械切；一张卡交付一个可独立验收的产物。

### 拆卡前检查

1. **一张卡一个独立可验收的产物**：能单独评审、单独测试、单独合并——review 读得完，test 说得清，失败面定位得到。
2. **不把“实现 + 集成 + E2E + 迁移”塞进一张卡**：四件事各有独立产物和独立失败面，捆在一起只能得到“整体感觉还行”的验收。
3. **拆完至少两张子卡能并行跑**：子卡之间没有逻辑先后、能同时派发；如果只能串行，通常不如合并成一张卡。
4. **按不变量/契约拆，不按文件数或阶段切**：同一批文件里的同类小改动留在同一张卡；不同契约的改动才分开。
5. **dependsOn 只表达逻辑前序**：只有 B 在运行期消费 A 的 schema / 接口 / 产物才加；它解决不了文件重叠——重叠交给 writeFiles 锁串行，无逻辑先后就**不要**加 dependsOn。
6. **单卡可验收**：acceptance/probes 都能在该卡自己的 worktree 内执行完，不依赖同批另一张卡尚未落地的行为。

### 子卡 + 集成卡

大面积同文件重叠时用两层结构，不要用一张 dev 总卡扛：

- **纯模块卡**：只交付契约 / 数据结构 / 纯函数（如 `stage-contract.mjs`），没有调用方接线，多张可先并行。
- **集成卡**：只做接线、真实入口的装配、E2E 与跨卡验收；`dependsOn` 全部子卡，等它们 done + merged 再接。

集成卡的边界：

- **只做接线、E2E、跨卡验收**：把已合并的子卡接进真实入口，跑通端到端并给出证据。
- **不重做子卡**：子卡交付的模块/契约原样复用，发现缺陷回到子卡修，集成卡不复制实现。
- **不吞剩余修复**：子卡 review/test 打回的返工在子卡内完成，集成卡不是“兜底修复卡”。
- **没有独立集成产物就不建 dev 总卡**：没有接线/E2E/跨卡验收可做时，直接并进子卡；总卡只会变成什么都管、什么都验不实的瓶颈。

### 反模式

- **一张大卡包打天下**：实现 + 集成 + E2E + 迁移一起交，review/test 只能抽样看。
- **按文件数机械切**：三个文件三张卡，还要互相 dependsOn，串行反而更慢。
- **用 dependsOn 解决文件重叠**：没有逻辑先后却加依赖，只是把并行改成串行。
- **集成卡吞剩余修复**：子卡的问题在集成卡里改，子卡原来的验收依据当场失效。
- **为并行而并行**：拆出的子卡都卡在同一份未落地的契约上，谁也开不了工——那是拆错，不是拆细。
- **把“等它合完我再改同一文件”写成 dependsOn**：那是 writeFiles 的排队，不是逻辑依赖。

### 并行度与关键路径

- 每拆一次都问：现在到底有几张卡能**同时**跑？只有一条并行线、关键路径没缩短，就没拆出价值，考虑合并。
- 关键路径 = 最长 dependsOn 链；优先缩短它：把契约抽成纯模块卡提前落地，或让纯模块卡并行。
- 派发前核对 ready 集合：卡之间 writeFiles 不重叠（锁不会互相等待），且每张卡都有独立可执行的验收；有卡在等同批另一张卡的行为，说明还没拆干净。

## 阶段契约（v4 结构化交接）

交接物由宿主从 git 生成，不写进 board；board 只存 review/test record 与候选摘要。

- **CandidateArtifact**：`base..head`、changedFiles/declaredFiles/extras、diffstat、keyHunks、acceptance、任务声明的 `probes`、宿主 verify 基线（命令/退出码/输出尾部/候选指纹）。候选未变则指纹不变。
- **reviewer** 交 `ReviewRecord`：`checked`（criterion/method/result，自己实际做的检查）、`findings`（severity blocking|non-blocking、file/line/text）、`residualRisks`。`approveReview` 空 checked 拒绝；`requestChanges` 至少一条 blocking finding，reasons 由 findings 渲染；record ≤ 16 KB。
- **tester** brief 带 artifact + reviewer 的 checked/residualRisks + hostCheck，**不带评审结论**。tester 必须亲自执行 artifact 声明的每个 probe，提交 `TestRecord`：`probes`（id/command/exitCode|timedOut/tail）、`adversarial`、`hostCheckRef`、`notes`；空 probes、漏执行已声明 probe 都拒绝；record ≤ 24 KB。
- **hostCheck 复用**：候选指纹未变时沿用上一次宿主基线，不重复跑整套；怀疑 flaky/环境差异才重跑并在 notes 说明。
- **用户面板判定**是显式 human override：即使只传 `id` 也记录为用户归属的结构化 record，不冒充 tester 执行探针。

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
