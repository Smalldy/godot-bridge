[English](README.md) | **中文**

# godot-bridge

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

原生 **DeepSeek Harness (DSH)** 插件：通过游戏内置的 TCP 交互服务器，启动并操控运行中的 **Godot 4.x** 游戏——以原生 Agent 工具取代 [`godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) MCP 服务器。

无需 MCP 协议、无需 Python 服务器、无需编辑器插件。游戏侧零改动：`McpInteractionServer`（`mcp_interaction_server.gd` autoload）本就在 `127.0.0.1:9090` 监听，采用换行分隔的 JSON 协议——godot-bridge 在 DSH host 内部原生使用同一种协议。

## 工具

| 工具 | 取代 (godot-mcp) | 用途 |
| --- | --- | --- |
| `godot_run_project` | `run_project` | 以调试模式启动项目（`godot -d --path …`），等待 9090 就绪 |
| `godot_stop_project` | `stop_project` | 终止游戏进程（tree-scoped kill） |
| `godot_get_debug_output` | `get_debug_output` | 增量读取已启动进程的 stdout/stderr |
| `godot_command` | 全部 `game_*`（约 130 个） | 发送任意交互服务器命令：`get_scene_tree`、`get_ui_elements`、`eval`、`get/set_property`、`call_method`、`click`、`key_press`、`screenshot`、`raycast`、`serialize_state`、`ui_*`…… |
| `godot_screenshot` | `game_screenshot` | 视口截图（base64 PNG） |
| `godot_ping` | — | 探测游戏是否在 9090 应答 |
| `godot_headless_op` | `read_scene`、`modify_scene_node`、`remove_scene_node`、`attach_script`、`create_resource`、`save_scene`、`create_scene`、`add_node`、`get_uid`、`manage_scene_signals`…… | headless 静态操作（`godot --headless --script godot_operations.gd`）：16 个操作，无需运行游戏 |
| `godot_validate_script` | `validate_script` | headless GDScript 编译检查（`validate_script.gd`）→ `{valid, errors}` |
| `godot_set_project_setting` | `modify_project_settings`、`set_main_scene`、`manage_layers`、`manage_plugins`、`manage_translations` | 在任意 project.godot 段设置类型化键值（`PackedStringArray(...)` / `Vector2i(...)` / bool 等） |
| `godot_manage_autoloads` | `manage_autoloads` | 列出/增删 autoload 单例（`Name="*res://…"`） |
| `godot_manage_input_map` | `manage_input_map` | 列出/增删输入动作——**正确的 Godot 4 键码**（修复 godot-mcp 的 Godot 3 基线 bug） |
| `godot_manage_export_presets` | `manage_export_presets` | 列出/增删导出预设（`export_presets.cfg`） |
| `godot_create_script` | `create_script` | GDScript 模板（extends / class_name / 方法桩 / 自定义源码） |
| `godot_create_project` | `create_project` / `create_csharp_script` | 项目脚手架，可选 Godot .NET `.csproj` |
| `godot_export_project` | `export_project` | headless 导出（`--export-release` / `--export-debug <预设> <输出>`） |

其余 godot-mcp 工具是在 MCP 服务器自己的 Node 进程里实现的：纯文件/编辑器操作由 DSH 原生文件工具覆盖；少数几个带 **Godot 特有写逻辑**（`manage_input_map`、`manage_export_presets`、`modify_project_settings`、项目/脚本模板生成等），通用编辑只能配合格式知识替代——完整对照见 [COVERAGE.md](COVERAGE.zh-CN.md)。

## 工作原理

```
DSH 会话
  └─ godot-bridge（Host 插件）
       ├─ godot_run_project ──────► subprocess.spawn(Godot -d --path <project>)
       ├─ godot_get_debug_output ─► collect 模式输出（增量 offset）
       └─ godot_command / godot_screenshot / godot_ping
            └─ subprocess.spawn(node -e <bridge> <command> <paramsJson>)
                 └─ TCP 127.0.0.1:9090 ◄── 游戏内 McpInteractionServer autoload
```

- 游戏内协议（`{command, params, id}` + 换行）与 godot-mcp **完全一致**，游戏侧与既有工作流无需任何改动。
- 每条命令拉起一个一次性 `node -e` 桥：连接 → 发一行 → 打印第一行响应 → 退出。游戏服务器是单连接/单命令（`_busy`），短连接模型完美匹配。
- 通过 harness 的**原始 `subprocess` 服务**启动（而非受沙箱限制的 shell 执行器），Godot 得以正常写 `user://` 文件，不会被 DSH 文件沙箱杀掉（见"坑"）。

## 环境要求

- DeepSeek Harness（带 host 运行时的会话）
- 注册了 `McpInteractionServer` autoload 的 Godot 4.x 项目。若项目还没有，把 `plugin/mcp_interaction_server.gd` 复制到项目根，并以 `McpInteractionServer` 命名注册为 autoload（godot-mcp 项目已具备）
- `node` 在 PATH 中
- Godot 可执行文件（务必用**真实 exe 完整路径**，不要用 gdvm shim——见"坑"）

## 安装

**推荐——一条命令**（需要 `dsh` CLI）：

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` 是 pnpm 转发器：把包装进 profile 的 `node_modules`，并因包内声明 `dsh.bundle`（其 `cordis.patch.yml` 插入 `tool-godot-bridge` 行）而把它追加进该 profile 的 `dsh.profile.bundles` 层列表。`web` 就是 Web 应用启动所用的**标准 profile**——这条命令只是把工具加进标准模式，**不会新建任何 profile**。重启后该 profile 的所有会话都有 15 个 `godot_*` 工具。已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 社区清单（topic：`dsh-plugin`）。

同一命令也可安装本地 checkout 或 tarball（`dsh plugin --profile web add ./path/to/godot-bridge`）。

> 插件是标准 DSH bundle 模块：`import { defineTool } from '@deepseek-ai/dsh-tools'` 并经 `ctx.tools.register` 注册。它必须通过上面的 bundle 机制安装——harness 启动时会在 profile 的 `node_modules` 里 heal 共享的 `@deepseek-ai/*` 依赖层，import 才解析得到。不要把文件复制进用户 agent 预设（`~/.dsh/.agent-presets/...`）；那个位置解析不到 `@deepseek-ai/dsh-tools`。

### 移除

```sh
dsh plugin --profile web remove godot-bridge
```

从 profile 中删除该包及其 `godot-bridge` bundle 层——重启后该 profile 的会话不再有 15 个 `godot_*` 工具。标准 `web` profile 本身不受影响（这条命令从不创建或删除 profile）。先 `godot_stop_project` 停掉运行中的游戏；插件卸载清理也会终止它启动的 Godot 子进程。任何时候可用上面的 `add` 命令重新安装。

## 更新提示

插件加载时会做一次**尽力而为**的版本检查：抓取仓库 `main` 分支的 `package.json`（`raw.githubusercontent.com`，5 秒超时，失败/离线时静默跳过），与已安装版本比较。存在更新时注册一条系统提示（system-prompt section），让模型在每个会话里转达 **"godot-bridge 有可用更新：已装 X，最新 Y"**，直到插件更新（`dsh plugin --profile web update godot-bridge`，然后重启 DSH）为止。`godot_ping` 也会额外返回 `plugin_version` / `latest_version` / `update_available`，可随时按需查询。

**发布更新**：在 `package.json` 里**递增 `version`**（这是发布标记）并推送——版本没变就不会触发提示。fork 场景：设置 `package.json` 的 `repository` 后，检查会自动跟随你的 fork。

已知限制：提示是系统提示 section，所以 persona 为 complete/抑制型（如**极简模式** `minimal`）的预设不会显示；检查需要启动时能联网。

## 用法

```text
godot_run_project            # 启动游戏（默认当前 workspace）
godot_ping                   # 确认 9090 应答
godot_command get_scene_tree # 查看场景图
godot_command get_ui_elements
godot_command eval {code: "return get_tree().current_scene.name"}
godot_command click {x: 576, y: 300}
godot_screenshot             # 查看游戏画面
godot_get_debug_output       # 读取启动日志
godot_stop_project           # 结束
```

GODOT_PATH 解析顺序：工具参数 `godot_path` → `<workspace>/.omp/mcp.json` 的 `env.GODOT_PATH` → 内置 gdvm 4.7.1 兜底路径。

## 坑（血泪教训）

- **DSH 文件沙箱 vs Godot `user://`**：经沙箱化 shell 执行器（pwsh/bash 工具）启动 Godot 会传播受限令牌，Godot 启动即崩（`Failed to open 'user://logs/…'`，signal 11）。godot-bridge 走原始 `subprocess` 服务、不受文件沙箱限制——这就是它能正常工作的原因。
- **`node -e` 的 argv**：`node -e <script> <cmd> <json>` 时，额外参数落在 `process.argv[1]`/`[2]`（不是 `[2]`/`[3]`）。
- **debug 模式下的 eval**：`eval` 代码出现编译错误会让游戏卡在调试器（与 godot-mcp 相同）。用动态访问（`p.get("global_position")`）绕开静态类型推断；卡死时 `godot_stop_project` + `godot_run_project` 重启。
- **用真实 exe，别用 gdvm shim**：shim 会立即退出并把真实 Godot 变孤儿进程，进程管理会误判其已死亡。

## 项目结构

```
plugin/godot-bridge.mjs           # 插件本体（标准 DSH 模块，命名导出 name/inject/apply）
plugin/mcp_interaction_server.gd  # 取自 godot-mcp（MIT）——游戏内 TCP 服务器 autoload
plugin/godot_operations.gd        # 取自 godot-mcp（MIT）——headless 操作脚本
plugin/validate_script.gd         # 取自 godot-mcp（MIT）——GDScript 编译检查
package.json                      # dsh.bundle manifest（供 `dsh plugin add` 安装）
cordis.patch.yml                  # bundle patch 层（插入工具行）
install.md / install.zh-CN.md     # 详细安装与维护说明
ARCHITECTURE.md / ARCHITECTURE.zh-CN.md  # 如何取代 godot-mcp + 协议细节
COVERAGE.md / COVERAGE.zh-CN.md   # 与 godot-mcp 的逐工具对比
```

`mcp_interaction_server.gd`、`godot_operations.gd` 与 `validate_script.gd` 取自 [godot-mcp](https://github.com/tugcantopaloglu/godot-mcp)（MIT，随包内置）。插件通过模块相对路径定位这些脚本（`import.meta.url`）；传显式 `ops_script` / `validate_script` 参数可覆盖。

## 许可证

MIT
