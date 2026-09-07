# 更新日志

本文件记录本项目的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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

[0.1.7]: https://github.com/Smalldy/godot-bridge/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Smalldy/godot-bridge/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Smalldy/godot-bridge/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Smalldy/godot-bridge/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Smalldy/godot-bridge/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Smalldy/godot-bridge/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Smalldy/godot-bridge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Smalldy/godot-bridge/releases/tag/v0.1.0
