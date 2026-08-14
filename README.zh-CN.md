[English](README.md) | **中文**

# godot-bridge

原生 **DeepSeek Harness (DSH)** 插件：通过游戏内置的 TCP 交互服务器，启动并操控运行中的 **Godot 4.x** 游戏——用一等公民的 Agent 工具取代 [`godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) MCP 服务器。

无需 MCP 协议、无需 Python 服务器、无需编辑器插件。游戏侧零改动：`McpInteractionServer`（`mcp_interaction_server.gd` autoload）本就在 `127.0.0.1:9090` 监听并说换行分隔 JSON——godot-bridge 在 DSH host 内部原生说同一种协议。

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

其余 godot-mcp 工具（`read_project_settings`、`manage_autoloads`、`manage_input_map`、`create_project`、`export_project`……）是在 MCP 服务器自己的 Node 进程里实现的文件/编辑器操作——DSH 原生文件工具（`read`/`write`/`edit`/`glob`/`grep` + shell）已覆盖，故不在此重复实现。

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
- 注册了 `McpInteractionServer` autoload 的 Godot 4.x 项目。若项目还没有，把 `plugin/mcp_interaction_server.gd` 复制到项目根，并注册为名为 `McpInteractionServer` 的 autoload（godot-mcp 项目已具备）
- `node` 在 PATH 中
- Godot 可执行文件（务必用**真实 exe 完整路径**，不要用 gdvm shim——见"坑"）

## 安装

### A. 部署级 agent 预设（推荐，重启不丢）

1. 把 `plugin/godot-bridge.mjs` 复制进你的用户预设：

   ```
   ${DSH_HOME:-~/.dsh}/.agent-presets/<你的预设>/plugins/godot-bridge.mjs
   ```

2. 在该预设的 `agent.cordis.yml` 里加一行（普通消费行——只注册工具、不发布服务，无需 `isolate` realm）：

   ```yaml
   - id: tool-godot-bridge
     name: './plugins/godot-bridge.mjs'
   ```

3. 校验挂载（`agentPresets.standingKeyFor('<你的预设>')`），然后用该预设开新会话——6 个 `godot_*` 工具即可用。

> 该模块刻意做成**零 import**：用户预设位于 `~/.dsh` 下，Node 向上解析不到 harness 的 `node_modules`。工具定义用手写 JSON Schema 并通过 `ctx.tools.register` 注册（`register` 只校验 `output.render` / `output.schema` / `timeoutMs`，无需 import `defineTool`）。

### B. 会话内动态插件（快速试用）

让你的 Agent 用 `plugin/godot-bridge.js` 定义动态 Host 插件（`cordis_define`，idPrefix `gbrg`，`code.host` = 文件内容）并运行。此形态走动态沙箱的 `harness.defineTool` / `harness.registerTool` API；逻辑与 A 完全一致。

### C. 社区 bundle（`dsh plugin add`）

直接从 GitHub 安装——纯 ESM + 资产，无需 npm 账号、无需构建步骤：

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

包内带 `dsh.bundle` manifest（`cordis.patch.yml`），会把 `tool-godot-bridge` 行插入你的 profile。重启后该 profile 的所有会话都有 8 个 `godot_*` 工具。同时已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 社区清单（topic：`dsh-plugin`）。

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
plugin/godot-bridge.js            # 动态插件形态（code.host 函数体）
plugin/godot-bridge.mjs           # 部署形态（零 import ESM 模块，命名导出）
plugin/mcp_interaction_server.gd  # 从 godot-mcp 内置（MIT）——游戏内 TCP 服务器 autoload
plugin/godot_operations.gd        # 从 godot-mcp 内置（MIT）——headless 操作脚本
plugin/validate_script.gd         # 从 godot-mcp 内置（MIT）——GDScript 编译检查
install.md                        # 详细安装与维护说明
ARCHITECTURE.md                   # 如何取代 godot-mcp + 协议细节
COVERAGE.md                       # 与 godot-mcp 的逐工具对比
```

`mcp_interaction_server.gd`、`godot_operations.gd` 与 `validate_script.gd` 从 [godot-mcp](https://github.com/tugcantopaloglu/godot-mcp)（MIT）内置而来。部署形态通过模块相对路径定位（`import.meta.url`）；动态形态回退到 `<workspace>/tools/godot-bridge/` 或 `godot-mcp` checkout，或显式传 `ops_script` / `validate_script` 参数。

## 许可证

MIT
