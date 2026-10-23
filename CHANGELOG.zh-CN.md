# 更新日志

本文件记录本项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-10-24

### 修复

- **本地调试器下的 `eval` 死锁（issue #13）**：`godot_run_project` 默认不再带 `-d`，`godot_command eval` 正常编译用户代码；语法错误仍会在捕获输出里给出错误与文件:行号。`debug:true` 明确为**诊断模式**：实例带本地调试器运行，交互服务器依据桥注入的 `GODOT_BRIDGE_DEBUGGER=1` 环境变量判定（仅靠 `OS.get_cmdline_args()` 不可行——Godot 会先消费 `-d`，4.7.2 实测），并在 `reload()` 之前**拒绝 eval** 并给出 `next`；桥保留 stdin 管道，检测到 `debug>`/`Debugger Break` 时只写一次 `quit`（绝不 `continue`），3 秒未退再终止自己启动的实例。退出结果**按退出码而非速度**分类：0 → `debugger-quit`；非 0 → `debugger-trap` + `exitCode`/`crash`；3 秒未退 → `debugger-trap` + `killed`；三者都带 `debuggerTrace`（break 原因、`*Frame N` 的 `file:line`、≤4KB 尾部）。如实记录：在 4.7.2-stable win64 上写 `quit` 约 38ms 后以 **3221225477（0xC0000005，访问违例）** 退出并打印 C++ 回溯，因此那次运行判为崩溃陷阱而非优雅退出。实测基线（最小工程 + 语法错误脚本）：无 `-d` 约 372ms 退出并输出 `SCRIPT ERROR … at: GDScript::reload`；带 `-d` 且 stdin 为 EOF 时 3 秒内打印 **12089** 行 break/prompt（1.78 MB，约 590 KB/s）必须强杀（issue #13 的死循环）；带 `-d` 且 stdin 为管道时只有一次 break/prompt（2.4 KB），因为调试器在等输入。
- **诊断守卫的纠正**：第一版从 `OS.get_cmdline_args()` 里找 `-d`，真机上是死代码（`eval` 仍会进入 `debug>`）。现在由桥在启动时注入 `GODOT_BRIDGE_DEBUGGER=1`，服务端读取它（`is_local_debugger(args, debugger_flag)`），argv 只作兜底；仍漏网的陷阱会以 `diagnosis: "debugger-trap"` + `debuggerTrace` 返回，而不是一个光秃秃的超时。回归测试：`scripts/test/eval-guard.test.mjs`（自包含）与 `scripts/test/eval_guard.gd`（`godot_run_headless --script`）。
- `godot_command` 超时返回 `bridge timeout` / `diagnosis: unresponsive` / `next`；`godot_ping` 在“端口连上但不应答”时报 `responsive: false`，不再误报 `game_running: false`；`user://logs/godot.log` 过大时告警（不删除用户文件）。

## [0.2.0] - 2026-10-01

### 新增

- **`Godot engine path` 现在可以在 GUI 里编辑。** 本组合包自带浏览器半侧（`client/client.js`，在 manifest 里由 `dsh.client` 声明），以包名为键注册本组合包的配置区（keyed slot `plugins.bundle.config`）——插件页的 **godot-bridge 卡片页**因此直接在描述与行列表之间显示路径字段，带**保存**与针对本 profile 覆盖值的**恢复默认**。（按行注册的 `plugins.row.config`（键为 `<包名>#<行 id>`）会把同一个表单放到深一层、藏在行上的「配置」控件后面；等到一个组合包拥有多个可独立配置的行时它才是正确选择，而本包只有一个。）保存走的是 DSH 设置的同一条路，落到 `godot_set_engine_path` 写入的同一行 `cordis.patch.yml`，所以该字段、那个工具、以及手写的 `config:` 块是同一个值的三种视角，改动立即生效、无需重启。关闭那一行时配置区随之消失——浏览器半侧属于那一行。本条关闭了下方 0.1.8 记录的已知限制。
- `npm run check` 现在同时校验浏览器半侧，把「让组合包失去表单」这一类错误变成构建期失败，而不是运行期静默失败：`dsh.client` 声明（合法成员、`platform: 'web'`、字符串数组 `inject`/`external`、布尔 `immediately`）、`exports["./client"]` 目标存在且被 `files` 覆盖、`window.__ModuleLoader__.load({ id })` 的 id 等于包名、`slots` 服务声明、每个 `require()` 说明符是否落在 web 客户端平台种子模块表或 `dsh.client.external` 内、`plugins.bundle.config` 的键是否等于本包名，以及 `plugins.row.config` 的键是否指向本包 patch 声明的行。slot 键与模块请求都只从**代码**读，注释不能充当通过条件。

### 变更

- 浏览器半侧在无法承载它的运行时上保持静默：0.1.6–0.1.x 已有这些 slot，但没有可读该值的设置表单服务，因此注册包在 `ctx.inject(['configForms'], …)` 之内，那些运行时维持原有行为（没有 GUI 字段，仍用 `godot_set_engine_path` 与 `settings.yaml`）。比 0.1.0-rc.7 更早、根本不扫描 `dsh.client` 的运行时忽略该 manifest 成员。

## [0.1.8] - 2026-09-30

### 修复

- 以 `link:` 依赖安装时，插件在 DSH 0.2.x 上完全无法加载：launcher 的 runtime resolution 只对「linked 包在自己 `peerDependencies` 里声明过的名字」把 `@deepseek-ai/*` 路由到安装版（它读的是 `peerDependencies` 的键，不是 `dependencies`），而 godot-bridge 一个都没声明——于是 `import '@deepseek-ai/dsh-tools'` 报 `ERR_MODULE_NOT_FOUND`，17 个 `godot_*` 工具一个都没注册。manifest 现在声明 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`。
- `godotPath` 在 DSH 0.2.x 上不再消失：`@deepseek-ai/dsh-settings` 移除了 `register`，settings 段此前只会静默降级成一条告警，`godot_set_engine_path` 永远回答 settings 服务不可用。
- 在 0.1.x → 0.2.x 升级前配置过的引擎路径会被自动带过来，而不是静默回落到 PATH 上的 `godot`（那通常是版本管理器 shim，也就是与用户当初配置不同的构建）。见「变更」中的迁移说明。

### 变更

- 配置模型：`godotPath` 改为插件 Config 的 `.volatile()` 字段，因此会出现在插件设置页，并按活值读取（volatile 字段原地更新，不 remount 插件）。写入经 `ctx.configEditor.edit(...)` 持久化到 active profile 的 `cordis.patch.yml` 并热重组——无需重启。
- `godot_set_engine_path` 写前校验目标文件是否存在，并回报持久化去向：DSH 0.2.x 上为 `persisted: 'profile-patch'`，旧路径为 `'settings'`。
- 继续兼容旧运行时：0.1.6–0.1.x 上 `settings.register` 仍然存在时插件继续使用它（`@deepseek-ai/dsh-tools` 的声明范围为 `>=0.1.6-0`）。`peerDependenciesMeta.optional` 阻止 pnpm 去 registry 安装 harness 包。
- `settings.yaml` 迁移：DSH 0.2 按插件 entry id 导入遗留段，而本插件的行 id 是 `tool-godot-bridge`，所以 0.1.x 写下的 `godot-bridge:` 段不会被带过来。当当前运行时没有配置路径时，插件会读取该段并把其中的值经与 `godot_set_engine_path` 相同的 profile-patch 写入路径写回，因此升级前配置的引擎构建无需重新填写即可继续使用。已配置的值永远不会被覆盖；记录在磁盘上已不存在的路径会被忽略（这种情况仍保留 PATH 兜底与对应告警）。还原每次插件加载只尝试一次，且尽力而为：写入被拒时保留 PATH 兜底并记一条告警，不会禁用任何工具。

### 新增

- `npm run check` —— `scripts/check-plugin-contract.mjs`：零依赖静态契约检查。裸 `@deepseek-ai/*` import 必须在 `peerDependencies`/`dependencies` 中声明；`dsh.bundle.patch` 必须存在且引用本包；`main`/`exports` 目标文件必须存在且被 `files` 覆盖；入口必须导出 `name`/`apply` 且没有 `export default`。
- `scripts/diagnose-dsh-resolution.mjs` —— 可重跑的 launcher runtime resolution 诊断（bundle 层、被 skip 的 bundle、linked root、每个 import 的解析结果，支持 `--expect ok|fail`）；仅开发用，不发布。

### 文档

- README：新增「DSH 0.2+ 兼容性与故障排查」（解析规则、`link:` 的 peer 要求、症状对照表、`dsh plugin allow-version` 应急、验证命令），并修正配置位置的表述。
- install：新增 `link:` 本地开发一节；重写「配置」一节（volatile 字段、profile-patch 写入路径、旧运行时兜底、`settings.yaml` 迁移说明）；维护一节补上契约检查与诊断脚本。
- ARCHITECTURE：新增「依赖契约与运行时解析」及分层示意图。

### 已知限制

- `godotPath` 在 DSH 0.2 上**没有 GUI 表单项**。插件页只为「自带客户端组件、注册了 keyed slot `plugins.row.config`」的插件渲染行配置表单；没有任何内置包注册该插槽，而 godot-bridge 没有客户端入口。Host 侧不受影响——`settings.describe()` 仍会为 `tool-godot-bridge` 行投影该字段，用 `godot_set_engine_path`（或该行的 `config:` 块）设置即可。该缺口单独作为功能请求跟踪。

## [0.1.7] - 2026-09-07

### 修复

- 旧版 autoload 残留导致端口路由失效：若项目 `autoload/mcp_interaction_server.gd` 早于 `GODOT_BRIDGE_PORT`/`get_instance_info` 引入，无论 `godot_run_project` 请求什么端口都只会绑 9090——于是 `port=9092` 看似成功，后续 `godot_command`/`godot_screenshot` 却只能找到 9090（issues #4）。`ensureInteractionAutoload` 现在会用随包版本覆盖过期的 autoload（该文件属插件管理的基础设施），并在替换时返回 `upgraded`。
- `godot_ping` 与错误文案改为上报真实探测端口，不再写死 `127.0.0.1:9090`。
- `writeProjectFile` 的 fs policy 改为指向目标项目目录而非会话工作区，使对工作区外项目的 autoload/project.godot 写入合法。
- 所有工具返回出口接入 `sanitizeLossless` 防御：偶发的 `undefined`/`NaN` 字段降级为日志记录并修正，而不是静默报 `value is not lossless JSON`。

## [0.1.6] - 2026-09-01

### 新增

- `godot_run_project` 的实例归属处理：先探测端口，若同项目已有实例在运行（典型场景：用户在编辑器里启动了场景，LLM 再运行项目），**直接接管（adopt）**并返回 `external: true`，不再 spawn 一个绑定失败、静默错挂的重复实例（旧行为会制造一个裸奔副本并误驱动用户实例）。
- 异项目占用端口时自动回退到 9091+（或调用方传入的 `port` 参数），不再撞端口。
- `mcp_interaction_server.gd` 支持 `GODOT_BRIDGE_PORT` / `GODOT_BRIDGE_TOKEN` 环境变量，并新增 `get_instance_info` 命令（pid/port/token/project），作为归属识别的身份基础。
- `godot_stop_project` 拒绝终止被接管（用户/编辑器启动）的实例，并说明安全停止方式（编辑器按 F8 / 游戏内退出）；插件绝不杀死自己未启动的进程。新增 `godot-bridge:instance-ownership` 系统提示段，同样禁止用 pwsh 杀进程（会连带把编辑器带崩）。

### 修复

- 兼容 dsh-settings ≥ 0.1.2-alpha：移除已删除的 `settingsNamespace` 导出（改为把裸字符串命名空间传给 `ctx.settings.register`）；settings 与工具注册均加防御式 try/catch，未来 API 再漂移时降级告警而不是拖垮整个 host 启动。

## [0.1.5] - 2026-08-19

### 新增

- `godot_run_headless` 工具：通过不受文件沙箱约束的 subprocess 服务执行有界的 headless 场景/逻辑/测试运行（`godot --headless --path <项目> [--quit-after N] [--script <脚本.gd>]`，超时强杀），取代在受沙箱约束的 pwsh/bash shell 里直接跑 `godot --headless` 导致 signal 11 崩溃的危险做法。

### 变更

- `godot_headless_op` / `godot_validate_script` / `godot_export_project` 崩溃时附带 `diagnosis`（`sandbox-crash`，高/低置信度 + 可执行提示），不再只返回原始 stderr，沙箱崩溃不再被误判为项目 bug。
- 新增 `godot-bridge:launch-channel` 系统提示段：Godot 必须始终通过 godot_* 工具（不受沙箱约束的 subprocess）启动，严禁通过 pwsh/bash（文件沙箱拦截 user:// 日志写入，signal 11 崩溃）。
- `godot_run_project` 描述指向 `godot_run_headless` 用于非交互 headless 运行。

### 修复

- `godot_run_headless` 在正常路径返回 `note: undefined`；DSH 工具层会拒绝任何 `undefined` 属性（"value is not lossless JSON"）并丢弃整个结果。现在 `note` 仅在超时时存在，`exit_code` 归一化处理，确保每个返回字段都是 lossless JSON。
- `godot_validate_script` 的错误条目在缺失文件/行号定位时使用 `null`（而非 `undefined`）。

## [0.1.4] - 2026-08-16

### 修复

- 恢复 0.1.3 中误删的 `timer` 注入：`ctx.timeout()` 是 timer 服务的 mixin，其 getter 读取 `ctx.timer`，移除后导致 `godot_run_project` / `godot_command` / `godot_screenshot` 报 `cannot get property "timer" without inject`。

## [0.1.3] - 2026-08-15

### 新增

- `godot_set_engine_path` 工具：模型向用户索要 Godot 可执行文件路径并写入 settings（schema 与存在性双重校验、热重载、无需重启），补全"未配置引擎"的引导闭环。

### 变更

- `godotPath` 现在是面向用户的 settings 值（Web 插件配置页或 `settings.yaml` 的 `godot-bridge:` 段），不再是 `cordis.patch.yml` 的行配置；插件作者不再预设路径（Godot 是便携 exe，可能位于任意位置）。
- Godot 可执行文件解析顺序：每次调用的 `godot_path` 参数 → `godotPath` 设置 → PATH 上的 `godot` 命令。`godot` 已在 PATH 时无需任何配置。
- 存在性校验从 `apply` 内的 `throw`（会令整个 fiber 失败）移到 settings 的 `validate` 钩子，坏路径不再连累纯文件工具。

### 修复

- 工具描述不再把配置位置误写为 `$DSH_HOME/settings.yaml`（现指向 settings 段，与代码实际读取一致）。

### 移除

- 冗余的 `timer` 注入与 `console.log` 噪声（改用 `ctx.logger`）。

## [0.1.2] - 2026-08-15

### 修复

- 更新提示现在能可靠送达模型：`systemPrompt` 改为注入（此前用惰性 `ctx.get`，可能拿不到服务），提示文本改为明确指令，模型会在每个会话中主动转达"有可用更新：已装 X，最新 Y"。
- `godot_ping` 返回 `plugin_version` / `latest_version` / `update_available`，可随时按需查询。

## [0.1.1] - 2026-08-15

### 新增

- 启动时更新提示：尽力而为的版本检查，抓取仓库 `main` 分支的 `package.json`（`raw.githubusercontent.com`，5 秒超时，失败/离线静默跳过）。存在更新时注册一条系统提示；`package.json` 的 `repository` 字段让 fork 自动跟随检查源。

### 修复

- `godot_command` 的 `timeout_ms` 此前是死参数：一次性 node 桥固定 20 秒封顶。现在超时经 `argv[3]` 传入（缺省 20 秒），`godot_ping`、`godot_run_project` 的就绪轮询以及异步命令都能按各自的超时生效。

### 变更

- 移除 pre-bundle 部署遗留的 headless 脚本兜底路径（`<项目>/tools/godot-bridge/`、`../godot-mcp/src/scripts/`）；模块同目录副本成为唯一来源。

## [0.1.0] - 2026-08-15

首个版本——以原生 Agent 工具取代 godot-mcp MCP 服务器的标准 DSH bundle。

### 新增

- 15 个 `godot_*` 工具：
  - 进程：`godot_run_project` / `godot_stop_project` / `godot_get_debug_output` / `godot_ping`
  - 运行时控制：`godot_command`（覆盖全部交互服务器命令）、`godot_screenshot`
  - headless：`godot_headless_op`（16 个操作）/ `godot_validate_script`
  - 项目编辑：`godot_set_project_setting` / `godot_manage_autoloads` / `godot_manage_input_map` / `godot_manage_export_presets` / `godot_create_script` / `godot_create_project` / `godot_export_project`
- 标准 DSH bundle 形态：`@deepseek-ai/dsh-tools` 的 `defineTool` + `ctx.tools.register`；`dsh.bundle` manifest 支持 `dsh plugin --profile web add github:Smalldy/godot-bridge` 安装。
- 随包附带游戏侧资产：`mcp_interaction_server.gd`（游戏内 TCP autoload）、`godot_operations.gd`、`validate_script.gd`。
- `godot_manage_input_map` 使用正确的 Godot 4 键码（修复 godot-mcp 的 Godot 3 基线 bug）。
- 双语文档（README / install / ARCHITECTURE / COVERAGE），含安装与移除指南；`cordis.patch.yml` 纳入发布 `files`。

[0.2.0]: https://github.com/Smalldy/godot-bridge/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/Smalldy/godot-bridge/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Smalldy/godot-bridge/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Smalldy/godot-bridge/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Smalldy/godot-bridge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Smalldy/godot-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Smalldy/godot-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Smalldy/godot-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Smalldy/godot-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Smalldy/godot-bridge/releases/tag/v0.1.0
[0.2.1]: https://github.com/Smalldy/godot-bridge/compare/v0.2.0...v0.2.1
