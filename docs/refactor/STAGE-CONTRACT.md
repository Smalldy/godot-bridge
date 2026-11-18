# Task Center 阶段契约 v4

> 状态：设计完成，待实施。
> 目标：降低任务总耗时，同时保留 reviewer/tester 的独立判断；不接受兼容层、超时调参或靠拆卡掩盖范围问题。
> 依据：T-187（Team API 调查）、T-188（真实耗时）、T-186/T-189（owner session 恢复）。

## 1. 问题

当前阶段是三个独立 agent，各自从零建立上下文：

```text
worker 提交自由文本 evidence
reviewer 重新读 diff、spec、文件列表
tester 重新读 diff、worker evidence、host check
```

T-188 的实测：

```text
worker   62 分钟  真实实现
reviewer 22.5 分钟 独立审 diff
host     45 秒    npm test 67/67
tester   22 分钟  39 步后仍被固定超时 kill
```

tester 不慢在测试，慢在重复建立上下文。reviewer 已经确认过的范围，tester 完全不知道。

同时，插件仍保留大量 Team legacy 兼容代码。T-188 的 capability probe/adapter 只是把旧 API 调用变成可读的旧 API 调用，仍然是技术债。

## 2. 非目标

- 不通过调大 `REVIEW_TIMEOUT_MS` / `TEST_TIMEOUT_MS` 解决慢。
- 不把 review 结论直接作为 tester 结论。
- 不保留 Team 0.1.x / 旧 roster API 的兼容 adapter。
- 不为了缩短时间引入无限递归子代理。
- 不把完整 diff、日志或 artifact 内容塞进 `.agents/tasks.json`。

## 3. 数据模型

### 3.1 CandidateArtifact

候选物由 host 在 submit / review approval / test candidate 构建时从 git 派生，不持久化正文。

```js
{
  base: "2963f529...",
  head: "b80759c1...",
  changedFiles: ["plugin/task-center/dispatch.mjs", "..."],
  declaredFiles: ["..."],
  extras: [],
  diffstat: { files: 7, insertions: 420, deletions: 118 },
  keyHunks: [
    { file: "plugin/task-center/dispatch.mjs", hunk: "@@ ...", summary: "capability gate" }
  ],
  acceptance: ["..."],
  probes: [
    { id: "modern-team-service", command: "node --test scripts/test/team-service-modern.test.mjs", timeoutMs: 120000 }
  ],
  hostCheck: {
    command: "npm test",
    exitCode: 0,
    durationMs: 45531,
    tail: "..."
  },
  hash: "sha256:..."
}
```

规则：

- `base`、`head`、`changedFiles`、`diffstat` 由 host 从 git 生成。
- `acceptance`、`probes` 来自任务定义，不允许 reviewer/tester 临时发明替代。
- `keyHunks` 是摘要，不是替代完整 diff；reviewer/tester 可以按需读完整文件。
- `hash` 是 `base..head` 加任务 acceptance/probes 的指纹；候选未变化时复用 hostCheck。
- 不把 artifact 写入 board，只在 brief 中按需生成。

### 3.2 ReviewRecord

review 必须返回结构化记录，不再只有 `reasons` 字符串。

```js
{
  verdict: "approved" | "changes-requested",
  checked: [
    { criterion: "no removed Team API is called", method: "rg + unit test", result: "pass" }
  ],
  findings: [
    { severity: "blocking" | "non-blocking", file: "...", line: 123, text: "..." }
  ],
  residualRisks: [
    "bootstrapTeam assertion may be vacuous"
  ]
}
```

存储：

```text
task.review.record = ReviewRecord
```

约束：

- `approveReview` 要求 `checked.length > 0`，否则拒绝。
- `requestChanges` 要求至少一条 blocking finding；`reasons` 由 findings 渲染，不再单独维护。
- `checked` 是 reviewer 实际做过的检查，不是 worker evidence 的复制。

### 3.3 TestRecord

```js
{
  verdict: "passed" | "failed",
  probes: [
    { id: "modern-team-service", command: "...", exitCode: 0, tail: "..." }
  ],
  adversarial: [
    { criterion: "no team service", command: "...", exitCode: 0, tail: "..." }
  ],
  hostCheckRef: "sha256:...",
  notes: "..."
}
```

规则：

- tester 必须执行 `CandidateArtifact.probes`。
- 每个 acceptance 至少一个 adversarial probe；可在 `adversarial` 中记录。
- hostCheck 已在候选上通过时，tester 不重复完整 suite；只在怀疑 flaky / 环境差异时重跑，并记录原因。
- `passTest` / `failTest` 必须带 `record`，空 evidence 不再接受。

## 4. 阶段流

```text
create/update
  -> 任务必须带 acceptance + probes
submit
  -> host 生成 CandidateArtifact
  -> reviewer brief = artifact + task + worker evidence
review approve
  -> 保存 ReviewRecord
  -> host 生成/复用 candidate + hostCheck
  -> tester brief = artifact + ReviewRecord.checked + residualRisks + hostCheck
test pass/fail
  -> 保存 TestRecord
merge
  -> 只依赖 TestRecord + hostCheck + merge 状态
```

### 4.1 Reviewer 职责

- 判断 diff 是否符合 spec/acceptance。
- 判断 probes 是否覆盖 acceptance。
- 检查架构一致性、错误处理、死代码、无声明文件。
- 不做完整测试 suite；host 负责基线。
- 输出 ReviewRecord。

### 4.2 Tester 职责

- 执行 artifact.probes。
- 对每个 acceptance 增加 adversarial probe。
- 使用 ReviewRecord.checked 作为范围输入，不重复 reviewer 的架构审查。
- 不把 review 结论当作自己的结论。
- 输出 TestRecord。

### 4.3 超时

固定 20 分钟不是工作预算，只是安全网。

本次不改 timeout 数值作为方案的一部分。阶段变快应来自：

- 结构化 candidate artifact
- review -> tester 的范围交接
- 可执行 probes
- 卡只包含一个主要不变量

如果阶段仍无法在安全网内完成，应把卡拆成更小的不变量，而不是继续加时间。

## 5. 卡模型

开发卡必须满足：

```text
一个主要不变量
acceptance 可执行
probes 可由 host 或 tester 运行
不超过一个 subsystem
生成物（client/client.js）不计入改动行数
```

建议上限：

```text
生产文件 <= 5
生产改动 <= 250 行
acceptance <= 6 条
probes <= 8 条
```

超过时在设计阶段拆分，不在 test 阶段解释。

## 6. 删除 legacy Team

开发期不保留 Team 兼容层。

删除范围：

```text
plugin/task-center/dispatch.mjs
  servicesFor().agentTeams
  workerPool / leadInventory / projectTeamState / roleRoster
  roleSlot / provision / ensure / prune / drain
  legacy mailbox / name-based interrupt

plugin/task-center/api.mjs
  teamsSnapshot / workerPool
  workers / teams legacy snapshot 字段
  /diagnostics 的 legacy* 字段

plugin/task-center/actions/roles.mjs
  role manager / slot 相关动作（保留纯 role profile 配置）

plugin/task-center/actions/project-admin.mjs
  bootstrapTeam

plugin/task-center/actions/onboard.mjs
  Team bootstrap / handoff 的 Team 分支

client/src/views/workers.cjs
  workers / teams 旧视图（如已无入口）
```

保留：

- `taskAgents`（subagent worker）
- `stageAgents`（subagent reviewer/tester）
- `agentTree`（subagent tree）
- role profile 配置（仅作为 prompt/skills 配置，不参与 Team roster）
- accepted/merged 历史卡、审计字段

不保留：

- capability probe
- `legacyTeamApi` / `legacyTeamCode`
- `no-team-service` 作为可恢复状态
- 旧 API adapter

## 7. 代码落点

新增：

```text
plugin/task-center/stage-contract.mjs
  buildCandidateArtifact(task, candidate, hostCheck)
  validateReviewRecord(input)
  validateTestRecord(input)
  renderReviewBrief(...)
  renderTesterBrief(...)
```

修改：

```text
plugin/task-center/schema.mjs
  task.verification { probes[] }
  review.record / test.record 的边界与大小限制

plugin/task-center/service.mjs
  approveReview / requestChanges / passTest / failTest
  校验并写入 record；拒绝空 checked / 空 probes

plugin/task-center/dispatch.mjs
  reviewBriefFor / testerBriefFor 消费 stage-contract
  删除 legacy Team 分支

plugin/task-center/actions/submit.mjs
  生成 CandidateArtifact，写入 merge.artifact 摘要

plugin/task-center/actions/review-verdicts.mjs
  审核 ReviewRecord 并持久化

plugin/task-center/actions/test-verdicts.mjs
  审核 TestRecord 并持久化

plugin/task-center/stage-service.mjs / task-agents.mjs
  不引入 helper depth；保持 depth 1
```

### 7.1 边界

- `stage-contract.mjs` 是纯函数模块，不读写文件、不 spawn agent。
- board 只存 record 摘要，不存 diff 正文。
- record 大小限制：ReviewRecord <= 16 KB，TestRecord <= 24 KB；超出拒绝并提示拆卡。
- 所有 schema 校验返回 typed error，不抛未捕获异常。

## 8. 实施卡

### TC-190 删除 legacy Team 层

范围：删除第 6 节列出的代码与 snapshot 字段，只保留 subagent-first 路径。  
验收：

- 全仓无 `agentTeams` legacy roster 调用。
- `workers/teams` legacy 字段不再出现在 /state。
- `bootstrapTeam` / role slot 动作删除或明确 user-only typed error。
- 不使用 capability probe / adapter。
- `npm test` 全绿。

### TC-191 阶段契约与结构化交接

范围：新增 stage-contract、ReviewRecord/TestRecord、CandidateArtifact、tester brief。  
依赖：TC-190（先收缩表面）。  
验收：

- reviewer 必须提交 checked/findings/residualRisks。
- tester brief 包含 ReviewRecord.checked + residualRisks + CandidateArtifact。
- tester 必须执行 probes 并输出 TestRecord。
- hostCheck 复用，不重复完整 suite。
- 新增 stage-contract / stage-flow 测试。

### TC-192 卡模型与 probes 校验

范围：create/update 要求 acceptance + probes；校验大小/数量。  
依赖：TC-191。  
验收：

- 无 probes 的 dev 卡拒绝创建。
- 超限卡返回 typed error。
- 现有任务迁移或明确失败原因。

## 9. 测试

新增：

```text
scripts/test/stage-contract.test.mjs
  CandidateArtifact 生成 / hash / keyHunks / 大小限制
  ReviewRecord 校验：空 checked 拒绝
  TestRecord 校验：空 probes 拒绝
  tester brief 包含 review 范围但不复制 verdict

scripts/test/stage-flow.test.mjs
  submit -> review -> approve -> tester brief
  review record -> tester 可见
  hostCheck 复用 / 不重复 suite
  test pass/fail 持久化

scripts/test/legacy-team-absent.test.mjs
  rg 级断言：无 agentTeams roster 调用、无 legacy adapter、无 Teams 字段
```

更新：

```text
scripts/test/task-routes.test.mjs
scripts/test/client-store.test.mjs
scripts/test/dispatch.test.mjs
scripts/test/dispatch-agent-runtime.test.mjs
```

## 10. 质量护栏

- tester 仍必须独立执行 probes，不能只引用 ReviewRecord。
- reviewer 不跑完整 suite，host 负责基线。
- test fail 仍回到 worker，不允许超时自动 pass。
- 不删除历史 done/merged 卡。
- record 校验失败是 typed refusal，不是 silent drop。
- 每次删除 legacy 路径都同步删除测试和 client 字段，不留半套 UI。

## 11. 不采用的方案

- **调大 timeout**：只延长卡死等待，不解决重复上下文。
- **只把 review reasons 拼进 tester brief**：reasons 是 blocking 文本，不是 checked 范围，tester 仍不知道 reviewer 看过什么。
- **tester depth 2**：在 record/contract 之前加 helper，只会让多个 agent 重复读同一份 diff；先解决 artifact。
- **按文件数机械拆卡**：按不变量拆；文件数是结果，不是依据。
- **保留 legacy Team adapter**：开发期没有兼容义务，adapter 会成为永久分支。
