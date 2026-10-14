---
type: proposal
status: settled
revision: 2
title: 任务中心（Task Center）
sessions:
  - session-ef51d758-9155-48c9-ae94-fd86a5d21550
decisions:
  - 三模块拆分，先做任务管理
  - 任务来源：原生会话讨论 → /task 授权 → agent 拆解成草稿 → 用户发布
  - 只有两个授权点：/task 与面板发布
  - 文件锁取代 write_scopes
  - 任务板 = 项目内单个文件，FsVersion 做 CAS
  - 一个包、两个组件行（godot-bridge + godot-bridge/task-center）
  - 方案是一种文档类型，不是新存储
open_questions:
  - 任务计划是否强制
  - 讨论期是否留痕
  - /task 信号的语种与长度
  - 锁租约时长与释放后如何唤醒等待者
  - 是否做对抗式拆解评审
  - 客户端探针是否提升为仓库测试
---

# 任务中心 —— 方案（P-1）

> 本文档是「方案」这一文档类型的第一个实例：`status: settled` 指**方向已冻结**，不是细节已定。
> 下面第七节列出的待定项属于实现选择，不构成方向变更。

## 一、结论

**任务中心 = 项目级、跨会话的共享工作上下文**，由三部分组成：文档、任务、工作台。三者寿命不同，必须分开：

| 概念 | 容器 | 寿命 |
|---|---|---|
| 讨论 | DSH 原生会话 | 会话级；可 fork/恢复 |
| **方案** | 项目内文档 | 跨会话；会被取代 |
| 任务 | 项目内任务板 | 跨会话 |
| 任务计划 | 项目内文档 | 跟随任务 |
| 文件锁 | 宿主内存 | 分钟～小时 |

**先做任务管理**（工作台最后），因为另外两个模块都产出或消费任务。

宿主里已有的近邻原语不能重复造：计划模式是**会话内一次执行**的提案-批准；`goal` 是**每会话至多一个**且不调度工作。**"项目级、被讨论过、被冻结的方向"在 DSH 里没有原语承载**——这正是本方案要补的缺口。

## 二、任务从哪里来

```
原生会话讨论（零侵入，插件不参与）
        │  用户敲 /task
        ▼
   agent 拆解为「任务草稿」
        │  用户在面板里「发布到队列」
        ▼
        队列 → agent 领取
```

**整条链上没有任何一步可以由 agent 自己启动。** 两个授权点：

1. **敲 `/task`** —— 允许创建真实任务。
2. **面板里点发布** —— 允许进入队列。

agent 可以先报告打算建什么再等你确认，也可以先建后报：**草稿本身无害**，真正的安全阀是发布那一步。

## 三、`/task` 命令（已实现并实测）

- **必须注册**：未注册的斜杠行会被适配器**直接拒绝**，不会变成提示词。
- **命令自己进不了模型**：`dsh-commands` 在宿主上执行命令、不产生模型消息；命令的返回文本只渲染在 UI 里。
- **信号靠 `Agent` 送进去**，照抄 `dsh-plan-mode` 的 `/plan <message>`：

  ```js
  agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
  ```

  `createUserMessage` 来自 `@deepseek-ai/dsh-llm`，**动态 import**：解析不了只会让 `/task` 回一句可读错误，不会拖垮整个插件模块。
- 命令后的自由文本原样追加为 `rawInput`，所以**不需要子命令**；顺序交给 agent 判断。
- `recordInput` 保留默认值 `true`，于是 `/task` 本身留在会话日志里——将来"这个方案是哪个会话产出的"有据可查。

实测记录：连发三次 `/task`（含附加文本与空 `rawInput`），信号每次都作为**一条用户消息**到达模型，命令自身的结算文本均未进入模型。

## 四、任务板与数据落地

**一个文件**：`<被工作的项目>/.agents/tasks.json`

不为它建目录——今天只有一份数据；真出现第二个文件时再升成目录（一次 `git mv` ＋ 改一个路径常量）。

- **并发**：`fs.stat` 取 `FsInfo.version`，写用 `fs.writeText(target, content, { kind: 'replaceIfVersion', version })`，冲突报 `FS_STALE_VERSION`。契约保证 mutation 是原子的。
- **写入纪律**：进程内先串行化；收 `FS_STALE_VERSION` 时**重读并重放变更函数**（不是重放旧内容），重试 ≤3 次。这样用户手改板子或多个宿主同时写都不会互相覆盖。
- **变更通知**：`fs.watch(board)` → 失效内存缓存 + 推给面板。它可能在 provider 不支持时 throw，必须降级成轮询。
- 选文件而非 `storageDomain` 的理由：`storageDomain` 是 **profile 级**（不是项目级）、`domain/changed` **只在本进程可见**、且**没有数据迁移**（改 schema 直接拒绝开域）。文件还带来 git 可见、可移植、插件卸载后仍可读。

### 文件锁（取代 write_scopes）

`write_scopes` 已删除：**任务在执行前无法声明它会碰哪些文件**，那个声明永远无法被校验、也永远不真。文件锁是可确定、可观察、可排队的。

- 键 = 项目相对**文件路径**；持有者 = **agent（会话）**，不是任务；锁上可带 `taskId` 只作展示标签。
- 每个锁带**租约**，死掉的 agent 不能永久占住文件。
- **预约**按请求时间排队；**释放时在同一提交内授予等待最久者**，文件永不出现"无人持有却有等待者"的中间态。
- 对同一 agent **幂等**：已在队列中再申请，**保留原始请求时间**（否则反复询问会把自己的优先级洗掉）。
- **读取不需要锁**，但任何 agent 都能查到"谁正在写"。
- 锁**只存宿主内存**，不落文件：写频率高（agent 每动一个文件一次写），和任务记录挤同一文件会互相打断 CAS；宿主重启后持有者已不存在，锁本就该失效。代价是第二个宿主进程看不到它——与已声明的单进程假设一致。

### 方案文档

方案**不是新存储**，而是一种文档类型（front matter 即元数据）：`type: proposal`、`status`、`revision`、`sessions`、`decisions`、`open_questions`。

状态机：`draft → discussing → settled → superseded`（旁支 `abandoned`）。

**核心不变式：只有 `settled` 的版本可以被拆解；每个任务记录 `proposal_ref` + `proposal_revision`。** 否则方案一改版就无法判断哪些任务过期。方案改版后"从新版本重新拆解"是一等操作，旧版本拆出的任务标 **stale 交用户处置，不自动删除**。

## 五、命名

| 概念 | 名称 |
|---|---|
| 一场讨论 | 议题 / Topic（就是一个会话，不发明新词） |
| 冻结下来的方向 | **方案 / Proposal** |
| 可执行单元 | 任务 / Task |
| 每个任务的执行计划 | 任务计划 / Task plan |

**不采用 AIM**：DSH 已有 `goal`，再造近义词会凑出五个同义概念；首字母缩写不自解释，翻译与双语读者都拿不到语义；而且它把"讨论"和"产物"盖成一个词——两者的差别（产物需要冻结、讨论不需要）恰恰是本设计最值钱的地方。

**方案定稿后，它的生命周期就是一条 ADR**：`settled` 是"已决定"，`superseded` 是"被取代"。所以：方案 = 讨论稿 + 定稿；定稿即决策记录。

## 六、界面

- **中栏整页面板**，不是右栏抽屉：右栏的 `sidebar.right.pane.tab` 是 **session 作用域**，而任务板是项目级、跨会话的对象。
- 面板入口：`sidebar.panellist` 只提供字形（宿主画按钮、解析 label、调用 `layout.selectPanel(id)`；条目 props 是 `{ size, active }`）；中栏 `main` 是 keyed slot，按 `activePanelId` 派发。两者用同一个 `task-center` id。
- **看板 = 状态列 + 卡片**（不做拖拽：客户端基座没有 dnd 库，手写拖拽加键盘可达的成本远高于收益）。列最小宽 172px、可横向滚动；`已关闭` 默认折叠成窄条。
- 卡片：id + 状态胶囊 + 标题（两行截断）+ 指派者 + 租约倒计时 + 🔒/⏳ 锁徽标。
- **归档平铺**：折叠头会藏住这个视图唯一要看的东西。
- **文件锁视图**：被占用的文件在前，带等待队列，队列头标 ①（下一个赢家）；空闲文件在后。
- 详情：按状态给出动作、审计时间线、"本任务 agent 持有的文件 / 正在等待的文件"。
- 「查看会话」是**禁用占位**并附说明：跳会话需要宿主的 session target，原型不该假装能用。
- 只用 `--dsw-alias-*` 主题 token；文案走 locale 服务（zh/en）；不 require 任何 Harness 客户端包。

## 七、待定

1. ~~分发包的落地方式~~ —— **已定**：一个包，随 `godot-bridge` 一起安装/更新（见第十节）。
2. **任务计划是否强制**（倾向不强制，只在界面显示"无计划"缺口）。
3. **讨论期是否留痕**：零侵入（倾向）还是边谈边记。
4. **`/task` 信号的语种与长度**：现在约 250 token 且中英双语、会永久留在会话历史里。倾向砍成一两句，把流程移入 **skill**。
5. **锁租约时长**，以及"释放后如何唤醒等待者"。
6. **是否做对抗式拆解评审**（同一方既写方案又拆解又验收是自我确认）。
7. **客户端探针是否提升为仓库测试**（现在在 `.investigate/`，已 gitignore）。

## 八、未验证的机制

- `agent.followup()`（唤醒排队等锁的 agent）。
- 第三方自建 Remote namespace（已绕开：走 `webServer.register` + `fetch` 的成熟路线）。

## 九、已知观察（无法复现，记录备查）

斜杠命令 token 曾变蓝且退格手感异常，之后无法复现。相关代码位置：`dsh-client-ui-commands/lib/client.js:874-880` 与 `:1123-1129`（`slash/input-consume-token`；`via === 'menu'` 消费 span，否则消费 bare-token）。最可能的触发是**认领发生时命令目录正好变更**（当时命令刚注册），使草稿里的记号变成孤儿。复现时请记录：斜杠菜单开/关、控制台告警、当时是否刚发生重载、截图。

## 十、打包：一个包、两个组件行

**卡片数 = bundle 数；组件数 = 行数。** 这两件事是独立的，所以"任务中心是 godot-bridge 的一个组件、而不是一个独立插件"并不需要把代码合成一个文件：

```yaml
# godot-bridge/cordis.patch.yml
- insert:
    - id: tool-godot-bridge
      name: godot-bridge
    - id: task-center
      name: godot-bridge/task-center      # 包内子路径行
```

行名可以是包内子路径——官方组合就是这么挂 `@deepseek-ai/dsh-plugin-manager/tools` 的，而那个行模块**只导出 `inject`/`apply`，没有 `name`**（插件身份由包入口持有）。所以宿主半可以按职责拆文件，客户端半不行。

### 被否决的做法：拆成独立包

曾实现过（提交 `6cd240c`，后被 `git revert` 退回），理由是"一包一个 client bundle"与"不把开销摊给所有用户"。**否决原因是分发**：`dsh plugin add github:Smalldy/godot-bridge` 只装一个包，独立包要求用户多装一次、或要求 godot-bridge 依赖一个必须另行发布的包。**"装/更新 godot-bridge 就能用"是硬要求**，它优先于上述工程偏好；而"不摊开销"这一点也因为任务中心今天只带来一条命令和一个面板而基本不成立。

### 职责分离

- **宿主半：可以真拆文件。** 宿主是真 ESM，相对导入随便用；每个职责还可以是独立的行、独立生命周期。`/task` 已在 `plugin/task-center.mjs`；将来任务板与 `task_center` 工具作为同目录兄弟模块相对导入。
- **客户端半：机制上只能一个文件。** 一个包只解析一个 `exports["./client"]`，且它是 classic script——没有相对 require、没有动态 import（只有 9 个平台基座 specifier，或 `dsh.client.external` 里指名的**别的包**的 bundle）。所以要么用区域分段，要么引入构建步骤，要么**把逻辑搬到宿主**——最后这条才是真正的解法：客户端今天 2346 行里大半是 mock store（状态机、锁仲裁、种子数据），这些规则本来就该住在宿主，与将来的 `task_center` 工具共享、也才可测。任务 1+2 落地后客户端应缩到视图 + fetch（数百行），届时一个文件不再难受。

## 十一、当前代码状态

- **`godot-bridge`（单包）**：`plugin/godot-bridge.mjs` 1929 行（17 个工具 + 引擎路径配置表单）、`plugin/task-center.mjs` 126 行（`/task` 行）、`client/client.js` 2621 行（引擎路径表单 + 任务中心面板，一个 bundle）。patch 插入两个行。
- **`.investigate/tc-probe.mjs`**（gitignore）：63 项断言，覆盖两个 slot 注册、locale 键集、每个视图渲染、看板状态迁移，以及锁的仲裁规则（授予等待最久者、未预约者什么都拿不到、空闲文件取用与释放、释放+授予同一提交）。
- 分支 `feat/task-center-ui-prototype`；`/task` 已实测可用（三次）；面板 slot 已实测注册且只占一个。
- 已安装的独立 bundle `dsh-task-center` 已从 profile 撤除（依赖与 `dsh.profile.bundles` 均无残留）。
- **待重启**：bundle 自己的 patch 不在 HMR 监听范围内（`hmr` 以 `root: []` 启用，只监听 profile manifest 与两份用户 patch），所以第二个行 `task-center` 尚未进入 loader 树。重启后应出现 `godot-bridge` + `godot-bridge/task-center` 两行，且 `/task` 与面板恢复。
- **面板的实际渲染在新结构下尚未在页面上确认。**

## 十二、拆解（任务草稿）

| # | 任务 | 依赖 |
|---|---|---|
| 1 | 宿主侧任务板：文件格式 + 读取 + `FsVersion` CAS 写入 | — |
| 2 | 客户端 store 从 mock 切到宿主通路（webServer 路由 + fetch），视图不动 | 1 |
| 3 | `task_center` 工具（单工具 + `action`，与宿主服务同一实现） | 1 |
| 4 | `/task` 附任务板摘要 | 1, 3 |
| 5 | 方案文档层：typed markdown + front matter + 列表/详情 | — |
| 6 | 任务记 `proposal_ref` / `revision`；重新拆解与 stale 标记 | 5 |
| 7 | skill：拆解流程与质量标准 | 3, 5 |
| 8 | 文件锁落宿主：跨会话可见 + 释放后唤醒等待者 | 1 |
| 9 | 会话跳转（宿主 session target）+ 命令行的自定义渲染 | 2 |
| 10 | 发版：versions/双语 CHANGELOG/验收 | 全部 |

任务 1 不受任何待定项阻塞。
