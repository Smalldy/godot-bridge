---
type: proposal
status: settled
revision: 3
title: 任务中心（Task Center）
sessions:
  - session-ef51d758-9155-48c9-ae94-fd86a5d21550
decisions:
  - 三模块拆分，先做任务管理
  - 任务来源：原生会话讨论 → /task 授权 → agent 拆解成草稿 → 用户发布
  - 只有两个授权点：/task 与面板发布
  - 文件锁取代 write_scopes
  - 多 agent 文件协作只用文件锁；git worktree 已评估并暂缓
  - 任务板 = 项目内单个文件，FsVersion 做 CAS，且**不进 git**
  - 一个包、两个组件行（godot-bridge + godot-bridge/task-center）
  - 方案是一种文档类型，不是新存储
open_questions:
  - 任务计划是否强制
  - 讨论期是否留痕
  - /task 信号的语种与长度
  - 释放锁后如何唤醒等待者（agent.followup 待验证）
  - 是否做对抗式拆解评审
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
- 选文件而非 `storageDomain` 的理由：`storageDomain` 是 **profile 级**（不是项目级）、`domain/changed` **只在本进程可见**、且**没有数据迁移**（改 schema 直接拒绝开域）。文件还带来可移植、插件卸载后仍可读。
- **板子不进 git**（写进项目的 `.gitignore`）。它是**运行态**，不是源码：提交它会让它在分支间来回漂移，并在合并时制造我们正想避免的冲突。**进 git 的是方案文档**——那才是需要被 review、被版本化的产物。这条同时消掉了"板子只认主工作树"的复杂度：没有 worktree，就没有第二份检出。

### 文件锁（取代 write_scopes）

`write_scopes` 已删除：**任务在执行前无法声明它会碰哪些文件**，那个声明永远无法被校验、也永远不真。文件锁是可确定、可观察、可排队的。

- 键 = 项目相对**文件路径**；持有者 = **agent（会话）**，不是任务；锁上可带 `taskId` 只作展示标签。
- **持有者标签由 session id 合成**（`@` + 去前缀后的前 8 位）。依据是 live `tools` 服务契约：`interface Agent { readonly id: SessionId }`——**agent 上没有名字**，面板 mock 里 `@fixer` 那种是 Agent Teams 名字，这一层看不到。已知限制，将来若有服务暴露名字可替换。
- 每个锁带**租约**（见下）。
- **预约**按请求时间排队；**释放时在同一提交内授予等待最久者**，文件永不出现"无人持有却有等待者"的中间态。
- 对同一 agent **幂等**：已在队列中再申请，**保留原始请求时间**（否则反复询问会把自己的优先级洗掉）。
- **读取不需要锁**，但任何 agent 都能查到"谁正在写"。
- 锁**只存宿主内存**，不落文件：写频率高（agent 每动一个文件一次写），和任务记录挤同一文件会互相打断 CAS；宿主重启后持有者已不存在，锁本就该失效。代价是第二个宿主进程看不到它——与已声明的单进程假设一致。

下面四条是检索外部先例后补进设计的（见「协作策略」一节的出处）：

- **租约过期时通知持有者**（"你对 X 的锁已过期"）。不通知的话，agent 会以为自己仍独占而继续写——先例里明确做了这件事。
- **agent 退出时 releaseAll**，不要指望它逐个释放。
- **键支持目录/glob 前缀**（锁 `scripts/core/*` 挡住里面的文件）。原先把目录粒度推迟了，先例把它当基本功能。
- **回收以 PID 存活为准，时间租约只作兜底**（宿主进程内可判；跨进程时退回 TTL）。

#### 租约的职责边界

租约回答的是"**持有者还活着、还在干活吗**"，作用是把**永久死锁换成最多阻塞 N 分钟**。非有不可，因为 agent 的死法很多：宿主崩溃、用户中止本轮、模型报错、会话被关，以及**它就是忘了释放**。最后一条最要紧，也是锁和数据库事务的根本区别——**释放不是事务边界，而是一次模型决策（一次工具调用）**，而模型忘掉一次工具调用是常态。没有租约，这五件事里任何一件都让文件永久被锁、其他 agent 永久等待：**一次崩溃就能让项目不可编辑。**

**租约与存活判断覆盖的是不同的故障，不是两层同一件事：**

| 故障 | 存活判断 | 租约 |
|---|---|---|
| 持有者进程死了 | ✅ 立即回收 | 不必等它过期 |
| 持有者**活着但卡住**（Godot 启动挂起、子 agent 不返回、模型反复重试） | ❌ 看起来一切正常 | ✅ 唯一能发现它 |
| 持有者**活着但忘了释放**（编辑完注意力走了） | ❌ | ✅ 常态故障 |

**过期必须通知持有者。** 静默过期会开一个新洞：持有者以为仍独占而继续写，锁却已经给了别人 → **两个写者**。通知是这个机制的配套，不是可选优化。

**连锁效果：** 有了存活回收，租约只需管"活着但不干活"，所以 TTL 可以放宽而不伤别人；而**续约本身就是心跳**——"还在续约"= "还在动这个文件"，锁因此从**互斥量**升级为**活动指示器**，而"谁正在写"正是其他 agent 最想知道的信号。

**它安全的前提是任务 9（工具边界强制）。** 租约过期之所以能安全释放，是因为下一个写会**响亮地失败**而不是静默双写；**没有任务 9，租约就是危险的**，两件事必须一起上。

**取值**：TTL **10 分钟**（先例是 5 分钟；我们已有存活回收兜底，所以可以放宽），**续约在每次写尝试时发生**（顺带即心跳）。锁只存宿主内存，宿主重启全清，所以**租约不是持久化问题**。

**任务租约与文件锁租约后果不同。** 文件锁过期会放别人进来写；任务认领过期只是让任务看起来"卡住"。所以任务租约**不自动改派**——否则会把任务从仍在工作的 agent 手里抢走——只把它标成「⚠ 租约已过期，可能无人推进」，由用户或别的 agent 决定。

### 协作策略：只用文件锁（worktree 已评估并暂缓）

原先设想两种策略（文件锁 / git worktree）加一个「自动」（git 项目走 worktree，否则走锁）。**现决定只做文件锁**，worktree 暂缓；设置项也**先不做**——只有一个可选项时不值得建设置。检索到的依据（2026-10）：

- [Claude Code 官方文档](https://code.claude.com/docs/en/worktrees)把 worktree 做成一等功能（"Isolate sessions with worktrees"），但需要**四道强制检查**——编辑目标落在主检出、命令 cwd 解析到主检出、把 git 重定向进主检出、以及无法从命令文本确认的命令，全部拦截。它同时**写明漏洞**：这些检查不追踪 shell 命令实际写了哪些文件，`cp` 或重定向写进主检出**不会被拦**。
- [flightdeck 的协调层文档](https://github.com/justinchuby/flightdeck/blob/HEAD/packages/docs/guide/coordination.md)有完整的 `WorktreeManager` 实现却**至今未启用**，理由写在文档里："依赖 agent 环境有正确的 git 设置，这在所有部署上下文里不保证"（例如每个 worktree 要单独 `npm install`），并且**创建失败时回退到共享工作目录**；它实际在跑的是文件锁。
- [一份事故驱动的 worktree 纪律文档](https://github.com/VMAFx/vmafx/blob/27f5a25fe42c88b5d1ba49e6634b6d230e7fc2f4/docs/development/agent-worktree-discipline.md)记录 worktree 的首要失败模式是 **drift**（agent 的 cwd 落到主检出，于是提交进用户的分支、冲掉未提交改动），**一个会话里五次事故**，最后靠宿主侧 pre-commit 闸门兜底。它的结论值得记住：只靠 agent 自律脆弱，只靠宿主闸门有窗口——两层都要。

对我们是**放大器的两端**：worktree 顺利时并行度更高，出事时代价更大。Godot 特有的两件事让它更贵：

- **`user://` 按项目名定位，不是路径。** 本机 `app_userdata` 下的目录名全是项目名，所以同项目的两个 worktree **共享存档与日志**——而本插件 `godot_run_project` 启动的游戏日志正写在 `user://logs/`。worktree 模式下跑游戏必须额外按项目名串行（一个新的锁种类），或给每棵树改 `application/config/name`。
- **`.uid` 是入库文件**（本仓库自己就提交了 `plugin/godot_operations.gd.uid`）。检索到两篇专讲 Godot UID 在合并后错乱/重命名后冲突的文章，但**只拿到标题、未读到正文**，所以不作为证据；要下结论需自己实测（两棵 worktree 各建同名脚本，看 UID 是否相撞）。

**若将来重启 worktree**，需要先具备这四条，它们都不便宜：主检出保护（拒绝写入）、板子从主工作树读取穿透（Claude Code 对 `.claude/skills`/settings 就是这么做的）、跑游戏按项目名串行、以及每棵树各自的 Godot 导入环境。所以"先只用锁"不是妥协，是排序。

### 认领为什么不自动

面板上的「领取」是这个模型里最容易被误读的按钮（用户第一眼就问"不是自动认领吗"），所以把判断写下来。

**宿主无法让空闲的 agent 开始干活。** agent 只在会话收到消息时运行，它不轮询队列。因此"发布时自动指派"只会产生**一条写着进行中却没人做的任务**——比排队更糟，因为它看起来有人在做，是在撒谎。

于是「领取」服务的是**人**，不是 agent：它是"这条我自己做，别让 agent 抢"（记录为 `@user`），顺带在开工前公开"谁在做"，并建立**租约**——面板的倒计时与「⚠ 租约已过期」都建在租约上。agent 那边的对应动作是 `task_center claim`；而按钮文案写成「领取」在混合板子上确实不够清楚，应改为「自己领取」。

**让它"感觉自动"的正确做法是通知，不是指派。** 形态应该是：用户发布 → 插件告诉相关会话「队列变了，这是队列头」→ agent 去领。这正是 **T-7**（事件驱动摘要 + 内容哈希去重）的职责；它依赖 `agent.followup()` 唤醒空闲 agent，而该机制**尚未验证**（见第八节）。若验证通过，认领不再需要人按，「领取」退化为"我自己来"一个用途；若不通过，认领保持显式。

**所以顺序上应先验证 `agent.followup()`——它决定队列能否自己动起来**，比继续加功能更优先。

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
5. **释放锁后如何唤醒等待者**（`agent.followup()` 待验证；租约时长已按先例定为 300 秒起步）。
6. **是否做对抗式拆解评审**（同一方既写方案又拆解又验收是自我确认）。
7. ~~三个探针是否提升为仓库测试~~ —— **已定**：提升到 `scripts/test/`，`npm test` 跑全部、`npm run verify` 再带上契约检查（见第十一节）。

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

- **宿主半：可以真拆文件。** 宿主是真 ESM，相对导入随便用；每个职责还可以是独立的行、独立生命周期。`/task` 在 `plugin/task-center/index.mjs`，板子在 `board.mjs`、模型在 `service.mjs`，都是同目录兄弟模块相对导入。
- **客户端半：机制上只能一个文件。** 一个包只解析一个 `exports["./client"]`，且它是 classic script——没有相对 require、没有动态 import（只有 9 个平台基座 specifier，或 `dsh.client.external` 里指名的**别的包**的 bundle）。所以要么用区域分段，要么引入构建步骤，要么**把逻辑搬到宿主**——最后这条才是真正的解法：客户端今天 2621 行里大半是 mock store（状态机、锁仲裁、种子数据），这些规则本来就该住在宿主，与 `task_center` 工具共享、也才可测。任务 2 落地后客户端应缩到视图 + fetch（数百行），届时一个文件不再难受。

### 热重载的实际边界（实测）

**宿主源码改动只能靠重启加载**，实测两条：

- `hmr` 以 `root: []` 启用，只监听 profile manifest 与两份用户 patch，**不监听插件源码**。
- **bundle 的 disable/enable 不能当重载用。** 提交 `bc5f68f`（给 `/task` 加板子摘要）之后做过一次 `set_bundle false` → `set_bundle true`，两次都报 `application: applied`；随后敲 `/task`，信号完整到达但**不带摘要**。推断是硬的：`await boardDigest()` 在 `agent.steer()` **之前**，若它抛异常就不会有任何消息被送出；消息到了 ⇒ 它返回了字符串；新代码若在内存里，摘要必然出现在消息末尾。**所以内存里仍是旧模块——结论是实测的。** 最可能的机制是旧那一代注册的 `/task` 未被销毁，新注册撞名后由本模块自己的 try/catch 记 warn 并跳过，于是旧 handler 继续应答；**机制是推测，结论不是**。随后一次重启，同一敲法立刻带上了摘要——**换掉模块的唯一途径是重启**，闭环。

推论：宿主源码的开发循环 = 每次重启，或打开 HMR 的源码监听（`root: ["."]`，注意插件是 `link:` 进来的，未必覆盖到）。bundle 自己的 patch 变化需要重启这一条，在第二个行出现时已单独确认过。

## 十一、当前代码状态

- **`godot-bridge`（单包）**：`plugin/godot-bridge.mjs` 1929 行（17 个工具 + 引擎路径配置表单）、`plugin/task-center/index.mjs`（`/task` 行：命令 + 板子摘要 + 注册工具与路由）、`board.mjs`（存储层：CAS + 冲突重放）、`service.mjs`（模型层：状态机 + 锁仲裁，纯函数）、`state.mjs`（两个表面共享的状态：板子访问 + 锁内存 + 项目提示）、`tool.mjs`（`task_center` 工具：薄外壳 + 权限边界）、`routes.mjs`（面板路由：用户表面）、`client/client.js` 2621 行（引擎路径表单 + 任务中心面板，一个 bundle）。patch 插入两个行。
- **两个表面，一份状态。** 锁只存宿主内存，所以必须是**同一个实例**——两份意味着 agent 与面板各看到一半真相、两个 agent 同时以为持有同一文件。`state.mjs` 因此由行创建一次，工具与路由都注入它。测试里有一条专门证明这件事：agent 用工具锁住文件 → 面板在 `state` 里看得见 → 面板 `forceRelease` → 工具再查已经是空。
- **两个表面的权限互为镜像**：工具**拒绝**的动作（`publish` / `unpublish` / `complete` / `approve` / `set_status` / `reorder` / `force_unlock`）正是路由**接受**的动作，因为路由的调用者是 GUI 前的人，而 agent 不通过 HTTP 调用它——"路由 = 用户"就是那条信任边界。但**模型规则对两者同等生效**：`remove` 在有持有者时两个表面都拒绝（测试里踩到过一次）。
- **六套测试**（`scripts/test/`，`npm test` 跑全部，共 **344 项断言**；`npm run verify` = 契约检查 + 测试）：`client-bundle.test.mjs` 63 项、`board.test.mjs` 25 项、`service.test.mjs` 114 项、`task-tool.test.mjs` 66 项、`task-command.test.mjs` 34 项、`task-routes.test.mjs` 42 项。共享的解析桩在 `scripts/test/stubs/`（`hooks.mjs` 把 `dsh-llm` / `dsh-tools` 映射到本地替身）。
- **`task_center` 工具已在真运行时验证**（重启后由本会话直接调用，共 8 次）：`board` 起初报 `not created yet`；`lock scripts/core/damage.gd` 授予成功，租约正好 10 分钟（16:54:06 → 17:04:06），持有者标签 `@ef51d758` 与本会话 id 一致；`create` 建成草稿 T-1 并记录 `proposalRef`；**`claim` 被发布闸门拦住**（`not-released`）；**`publish` 被拒**并附"这是用户的决定"；`remove` + `unlock` 清理后 `board` 报 `.agents/tasks.json`、total 0、锁为空。落盘文件即设计形态（人类可读、可手改、ISO 时间戳），`git status` 干净（忽略规则命中）。
- **平台的另一条实测**：工具注册表是**按调用解析**的，不是按会话冻结——本会话创建时 `task_center` 还不存在（初始 schema 里没有它），重启后可**直接调用**。故插件注册的工具无需新开会话即可用。这与"源码改动要重启才生效"并不矛盾：**注册表是活的，模块不是。**
- **`task_center` 工具的权限边界**（有意为之，不是遗漏）：`publish` / `unpublish` / `complete` / `approve` / `set_status` / `reorder` / `force_unlock` 都在 action 枚举里**可见但被拒绝**，并附上"这是用户的决定、去面板"的理由。理由是：能自己发布草稿的 agent 会让发布队列变成装饰。写动作声明为**独占**（`isConcurrencySafe` 只对读动作返回 `true`）。
- 测试 runner 用 `stdio: 'inherit'` 是**环境约束**而非风格选择：文件沙箱下子进程不能开命名管道，`stdio: 'pipe'`/`execFileSync` 会 EPERM（已实测踩到）。注释里写明了，免得后人"修"成管道。
- 分支 `feat/task-center-ui-prototype`；`/task` 已实测可用（五次）；面板 slot 已实测注册且只占一个。
- 已安装的独立 bundle `dsh-task-center` 已从 profile 撤除（依赖与 `dsh.profile.bundles` 均无残留）。
- **两个行已随重启进入 loader 树**并在插件页显示为「共 2 个 · 2 运行中」（用户截图确认）；`godot-bridge` = `schema`，`godot-bridge/task-center` = `absent`（没有 Config，正常）。
- **摘要已在真运行时验证**，原文 `Board (.agents/tasks.json): not created yet; create it there.`，顺序为 信号 → 附注 → 摘要。这一敲同时验掉三件假 fs 证明不了的事：**真实 `fs.resolve()` 对不存在路径可用**（每次首次读取都依赖它）、命令调用里能取到会话工作区（`invocation.agent.session` 与工具用的 `exec.agent.session` 等价）、附注之后确实跟着摘要。
- **面板在新结构下只确认了注册**（`main` 的 occupant 是 `task-center`/`plugins`/`conversation`，无重复），页面上没有重新看过它的渲染。

## 十二、拆解（任务草稿）

| # | 任务 | 依赖 | 状态 |
|---|---|---|---|
| 1 | 宿主侧任务板：文件格式 + 读取 + `FsVersion` CAS 写入 | — | ✅ `plugin/task-center/board.mjs`，25 项断言 |
| 2a | 宿主侧：共享状态 + 面板路由（用户表面，权限与工具镜像） | 1 | ✅ `state.mjs` + `routes.mjs`，42 项断言 |
| 2b | 客户端 store 从 mock 切到 `fetch`，视图不动 | 2a | |
| 3a | 模型层：任务状态机 + 文件锁仲裁（纯函数，不依赖 Cordis，可独立测试） | — | ✅ `plugin/task-center/service.mjs`，114 项断言 |
| 3b | `task_center` 工具（单工具 + `action`，薄外壳，调 3a） | 3a | ✅ `plugin/task-center/tool.mjs`，66 项断言 + 真运行时验证 |
| 4 | `/task` 附任务板摘要 | 1 | ✅ 34 项断言（原以为依赖 3，实际只依赖 1） |
| 5 | 方案文档层：typed markdown + front matter + 列表/详情 | — | |
| 6 | 任务记 `proposal_ref` / `revision`；重新拆解与 stale 标记 | 5 | |
| 7 | skill：拆解流程与质量标准 | 3, 5 | |
| 8 | 文件锁落宿主：跨会话可见 + 过期通知持有者 + 退出 releaseAll + 目录前缀 + PID 回收 | 1 | |
| 9 | **工具边界强制**：目标被他人锁住时拒绝写入；commit 只 add 自有锁文件并事后校验 | 8 | |
| 10 | 每 agent 摘要改为事件驱动 + 内容哈希去重（先例测到省 40–60% token） | 3, 8 | |
| 11 | 会话跳转（宿主 session target）+ 命令行的自定义渲染 | 2 | |
| 12 | 发版：versions / 双语 CHANGELOG / 验收 | 全部 | |

任务 1、4 已完成；**下一个是任务 3**（工具 + 模型），任务 2 紧随其后（面板显示真数据）。
