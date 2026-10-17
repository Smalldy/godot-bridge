[English](README.md) | **中文**

# godot-bridge

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![Listed on DSH Directory](https://dsh.directory/badges/listed.svg)](https://dsh.directory/plugins/smalldy/godot-bridge)

原生 **DeepSeek Harness (DSH)** 插件：通过游戏内置的 TCP 交互服务器，启动并操控运行中的 **Godot 4.x** 游戏——以原生 Agent 工具取代 [`godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) MCP 服务器。

无需 MCP 协议、无需 Python 服务器、无需编辑器插件。游戏侧零改动：`McpInteractionServer`（`mcp_interaction_server.gd` autoload）本就在 `127.0.0.1:9090` 监听，采用换行分隔的 JSON 协议——godot-bridge 在 DSH host 内部原生使用同一种协议。

## 工具

| 工具 | 取代 (godot-mcp) | 用途 |
| --- | --- | --- |
| `godot_run_project` | `run_project` | 以调试模式启动项目（`godot -d --path …`），等待 9090 就绪 |
| `godot_stop_project` | `stop_project` | 终止游戏进程（tree-scoped kill） |
| `godot_get_debug_output` | `get_debug_output` | 增量读取已启动进程的 stdout/stderr |
| `godot_command` | 全部 `game_*`（约 105 个） | 发送任意交互服务器命令：`get_scene_tree`、`get_ui_elements`、`eval`、`get/set_property`、`call_method`、`click`、`key_press`、`screenshot`、`raycast`、`serialize_state`、`ui_*`…… |
| `godot_screenshot` | `game_screenshot` | 视口截图（base64 PNG） |
| `godot_ping` | — | 探测游戏是否在 9090 应答（并报告已装/最新插件版本） |
| `godot_set_engine_path` | — | 把 Godot 引擎可执行文件路径写入插件配置（模型向用户索要路径后据此保存，热重载——DSH 0.2.x 上返回 `persisted: 'profile-patch'`，旧路径返回 `'settings'`） |
| `godot_headless_op` | `read_scene`、`modify_scene_node`、`remove_scene_node`、`attach_script`、`create_resource`、`save_scene`、`create_scene`、`add_node`、`get_uid`、`manage_scene_signals`…… | headless 静态操作（`godot --headless --script godot_operations.gd`）：16 个操作，无需运行游戏 |
| `godot_run_headless` | — | **非交互**地有界运行项目、场景或测试脚本（`godot --headless --path … [--quit-after N] [--script …]`），经不受沙箱约束的 subprocess 服务启动；返回 stdout/stderr，并在命中时给出 sandbox-crash 诊断 |
| `godot_validate_script` | `validate_script` | headless GDScript 编译检查（`validate_script.gd`）→ `{valid, errors}` |
| `godot_set_project_setting` | `modify_project_settings`、`set_main_scene`、`manage_layers`、`manage_plugins`、`manage_translations` | 在任意 project.godot 段设置类型化键值（`PackedStringArray(...)` / `Vector2i(...)` / bool 等） |
| `godot_manage_autoloads` | `manage_autoloads` | 列出/增删 autoload 单例（`Name="*res://…"`） |
| `godot_manage_input_map` | `manage_input_map` | 列出/增删输入动作——**正确的 Godot 4 键码**（修复 godot-mcp 的 Godot 3 基线 bug） |
| `godot_manage_export_presets` | `manage_export_presets` | 列出/增删导出预设（`export_presets.cfg`） |
| `godot_create_script` | `create_script` | GDScript 模板（extends / class_name / 方法桩 / 自定义源码） |
| `godot_create_project` | `create_project` / `create_csharp_script` | 项目脚手架，可选 Godot .NET `.csproj` |
| `godot_export_project` | `export_project` | headless 导出（`--export-release` / `--export-debug <预设> <输出>`） |

其余 godot-mcp 工具是在 MCP 服务器自己的 Node 进程里实现的：纯文件/编辑器操作由 DSH 原生文件工具覆盖；少数几个带 **Godot 特有写逻辑**（`manage_input_map`、`manage_export_presets`、`modify_project_settings`、项目/脚本模板生成等），通用编辑只能配合格式知识替代——完整对照见 [COVERAGE.md](COVERAGE.zh-CN.md)。

## 任务中心（task-center）

同一个包还会挂载第二个组件行 `godot-bridge/task-center`：项目级任务板 + 依赖驱动的派发器 + 文件锁，以及中栏 GUI 面板（左侧栏「任务」）。

- **任务板**：`<项目>/.agents/tasks.json`。schema v2，读到 v1 会自动迁移；重复 id、非法条目、未来版本会被拒绝而不是覆盖；建议把该文件加入项目 `.gitignore`（它是运行态，不是源码）。
- **动作 API**：`task_center` 工具与 `POST /godot-bridge/task-center/action` 共用同一套动作：`create / update / delete / list / get / board / start / pause / settings / tick / submit / accept / reject / cancel / reopen / block / unblock / retry / lock / unlock / locks / forceUnlock / openProject`。
- **依赖**：`B.dependsOn = [A]` 表示 A 完成后才派发 B。就绪任务按 `priority` 降序、创建时间升序取。`A <- B <- C`、`D`、`E <- F` 会先派发 A、D、E；A 完成后派发 B，E 完成后派发 F。
- **派发**：开始/暂停是项目级状态（持久化在板子里）。GUI 只暴露**最大并发**：最多同时跑这么多个任务；执行者上限自动设为并发 + 1，没有空闲执行者时会自动新建，连续失败 3 次后任务阻塞（高级调用仍可用 `settings` 覆盖）。每次派发先 `claim`（15 分钟租约）再交给 Agent Teams：优先 `sendMessage` 给空闲成员，否则 `spawnTeammate`。worker 死掉后租约到期自动回池；宿主重启会回收上一进程的 claim。
- **文件锁**：任务用 `writeFiles` 声明要写的文件；调度器在派发前原子获取全部锁，任务完成/阻塞/取消/租约过期时释放。agent 也可以 `lock` 为自己的运行任务追加锁。路径规范化为项目相对路径，目录锁会与子路径冲突。
- **GUI**：看板（就绪 / 等待 / 进行中 / 待验收 / 完成 / 阻塞）、队列、文件锁；开始/暂停、新建/编辑、验收/打回/重试/重开、派发设置。2.5 秒轮询宿主快照。
- **安全**：HTTP 写动作要求 `application/json` 且校验同源 `Origin`；`?project=` 只是读提示，切换项目走 `openProject`（校验目录存在）。

```sh
# 在 GUI 之外创建任务（任意 HTTP 客户端）
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' \
  -d '{"action":"create","project":"/path/to/game","title":"A","writeFiles":["scripts/a.gd"]}'
# 开始 / 暂停派发
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' -d '{"action":"start","project":"/path/to/game"}'
curl -s -X POST http://127.0.0.1:<port>/godot-bridge/task-center/action \
  -H 'content-type: application/json' -d '{"action":"pause","project":"/path/to/game"}'
```

运行 `npm test` 覆盖 board / service / locks / dispatch / routes / tool / activation / client。

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
- 注册了 `McpInteractionServer` autoload 的 Godot 4.x 项目。若项目还没有，把 `plugin/mcp_interaction_server.gd` 复制到项目根，并以 `McpInteractionServer` 命名注册为 autoload（godot-mcp 项目已具备）。**`godot_run_project` 也会在缺失时自动安装**（把随包文件复制进 `autoload/` 并在 `project.godot` 注册）——无需手动处理；非 Godot 项目完全不受影响。
- `node` 在 PATH 中
- Godot 可执行文件——按此顺序解析：每次调用的 `godot_path` 参数 → **`godotPath` 插件设置**（`tool-godot-bridge` 行的配置：DSH 0.2.x 上是 godot-bridge 卡片页上的 `Godot engine path` 字段或 `godot_set_engine_path` 工具，0.1.x 上是插件 settings 段）→ PATH 上的 `godot` 命令。`godot` 已在 PATH 时**无需任何配置**；否则填你的引擎路径（插件作者不预设路径——Godot 是便携 exe，可能位于任意位置）。务必用**真实 exe 完整路径**，不要用版本管理器的 shim（见"坑"）

## 安装

**推荐——一条命令**（需要 `dsh` CLI）：

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` 是 pnpm 转发器：把包装进 profile 的 `node_modules`，并因包内声明 `dsh.bundle`（其 `cordis.patch.yml` 插入 `tool-godot-bridge` 行）而把它追加进该 profile 的 `dsh.profile.bundles` 层列表。`web` 就是 Web 应用启动所用的**标准 profile**——这条命令只是把工具加进标准模式，**不会新建任何 profile**。重启后该 profile 的所有会话都有 17 个 `godot_*` 工具。已收录于 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 社区清单（topic：`dsh-plugin`）。

同一命令也可安装本地 checkout 或 tarball（`dsh plugin --profile web add ./path/to/godot-bridge`）。

> 插件是标准 DSH bundle 模块：`import { defineTool } from '@deepseek-ai/dsh-tools'` 并经 `ctx.tools.register` 注册。它必须通过上面的 bundle 机制安装。DSH 通过 launcher 的 runtime resolution 从自己的安装里提供 `@deepseek-ai/*`：装进 profile 的包会自动解析；而 `link:`/符号链接的 checkout 只有在插件自己的 `peerDependencies` 里声明了这些包名时才会被路由（godot-bridge ≥ 0.1.8 已声明——见 [DSH 0.2+ 兼容性与故障排查](#dsh-02-兼容性与故障排查)）。不要把文件复制进用户 agent 预设（`~/.dsh/.agent-presets/...`）；那个位置不在任何解析范围内，解析不到 `@deepseek-ai/dsh-tools`。

### 移除

```sh
dsh plugin --profile web remove godot-bridge
```

从 profile 中删除该包及其 `godot-bridge` bundle 层——重启后该 profile 的会话不再有 17 个 `godot_*` 工具。标准 `web` profile 本身不受影响（这条命令从不创建或删除 profile）。先 `godot_stop_project` 停掉运行中的游戏；插件卸载清理也会终止它启动的 Godot 子进程。任何时候可用上面的 `add` 命令重新安装。

## DSH 0.2+ 兼容性与故障排查

DSH 0.2 用进程内的 **runtime resolution** 取代了旧的物理 module-fallback 层：launcher 把它装进 Node 的 ESM 与 CommonJS 解析器。解析器会针对「哪个模块在 import」决定是否把裸 `@deepseek-ai/*` 说明符路由到安装版自己的副本——这正是依赖 harness 包的插件能否加载的前提：

- **装在 profile 内**（`dsh plugin add github:…`、tarball，或任何位于 `$DSH_HOME/profiles/<name>/node_modules` 下的副本）：harness 包自动从安装版解析，无需任何声明。
- **以 `link:` 安装**（符号链接指向本地 checkout）：插件真实路径落在 profiles 树之外，而 Node 的 ESM loader 会先 realpath 再 import。这种 *linked root* **只有在插件自己的 `peerDependencies` 里声明了该包名时**才会被路由——解析器读的是 `peerDependencies` 的键，不是 `dependencies`。godot-bridge ≥ 0.1.8 声明了 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`，并标记 optional，避免 pnpm 去 registry 安装 harness 包。

### 症状

| 症状 | 含义 | 处理 |
| --- | --- | --- |
| 17 个 `godot_*` 工具全部消失，launcher 日志出现 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools' imported from …/godot-bridge.mjs` | harness 包没有被路由到安装版副本。对 `link:` 安装而言就是 `peerDependencies` 缺声明（0.1.7 及更早的失效方式） | 升级到 godot-bridge ≥ 0.1.8；或改用非符号链接安装（`dsh plugin … add ./godot-bridge-<版本>.tgz`） |
| launcher 打印 `dsh: skipping profile bundle "godot-bridge": …`，插件页显示错误 | 声明的 DSH peer 范围与当前运行时版本不匹配。**未声明** peer 不构成约束，因此不会产生这条信息 | 升级插件；或显式接受风险：`dsh plugin --profile <profile> allow-version godot-bridge@<version> --dsh-version <runtime> --accept-risk` |
| 插件设置页看不到 `godotPath`，且 `godot_set_engine_path` 提示 settings 服务不可用 | 在 DSH 0.2.x 上运行 0.1.8 之前的版本；旧的 `settings.register` API 已不存在 | 升级到 godot-bridge ≥ 0.1.8 |
| **godot-bridge 卡片**上看不到 `Godot engine path` 字段 | 注册本组合包配置区（keyed slot `plugins.bundle.config`，以包名为键）的浏览器半侧没有加载：本组合包唯一那行被关闭、更新后没有重启宿主、或安装的副本早于浏览器半侧（≤ 0.1.8）。在 DSH 0.1.6–0.1.x 上运行时没有设置表单服务，因此该字段按设计就不存在 | 升级到 godot-bridge ≥ 0.2.0 并重启 DSH——升级会替换已安装的文件，而 `dsh.client` 的扫描结果按 Loader 行缓存到重启为止。若该行是关闭状态请打开。否则用 `godot_set_engine_path` 设置，或给该行加 `config:` 块（见[安装文档](install.zh-CN.md#dsh-02-上的-gui-字段)） |
| 从 0.1.x 升级后，工具跑的是**与配置不同的 Godot 构建** | 0.2 之前的 `settings.yaml` 段不会被迁移（DSH 按插件 entry id 导入，而本行 id 是 `tool-godot-bridge`），于是解析回落到 PATH 上的 `godot`——通常是版本管理器 shim | godot-bridge ≥ 0.1.8 上无需处理：首次启动会把记录的值自动写回（仅当字段为空且文件仍存在）。若看到点名「丢失值」的告警，说明还原没有生效（记录的路径已不存在，或写入被拒），请用 `godot_set_engine_path` 重新设置 |

### 验证

```sh
npm run check                                                              # 静态契约检查——不需要 DSH
node scripts/diagnose-dsh-resolution.mjs --profile <profile> --expect ok   # 需要已安装的 DSH 应用
```

`npm run check` 会在「裸 `@deepseek-ai/*` import 未在 manifest 声明」「bundle patch 缺失或未引用本包」「入口丢命名导出」，或「浏览器半侧破坏自身契约」时失败：宿主不读的 `dsh.client` 成员、不是 `web` 的 platform、缺失或未被 `files` 覆盖的 `exports["./client"]` 目标、不等于包名的 `__ModuleLoader__` id、落在平台种子模块表之外的 `require()`、不等于本包名的 `plugins.bundle.config` 键、以及指向本包 patch 未声明行的 `plugins.row.config` 键。诊断脚本会打印 profile 的 bundle 层、被 skip 的 bundle、识别到的 linked root，以及插件每个 harness import 的解析结果——修复前后各跑一次，或在 DSH 再次改动解析规则时用来定位。

随后重启 DSH（或在插件页重新加载 profile），确认新会话里出现 17 个 `godot_*` 工具。

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

Godot 可执行文件解析顺序：每次调用的 `godot_path` 参数 → `godotPath` 插件设置（`tool-godot-bridge` 行的配置：DSH 0.2.x 上可用 godot-bridge 卡片页上的 `Godot engine path` 字段、`godot_set_engine_path` 工具，0.1.x 上是插件 settings 段）→ PATH 上的 `godot` 命令。`godot` 已在 PATH 时无需配置；否则填引擎路径，务必指向**真实 exe**，别用 shim。

## 坑（血泪教训）

- **DSH 文件沙箱 vs Godot `user://`**：经沙箱化 shell 执行器（pwsh/bash 工具）启动 Godot 会传播受限令牌，Godot 启动即崩（`Failed to open 'user://logs/…'`，signal 11）。godot-bridge 走原始 `subprocess` 服务、不受文件沙箱限制——这就是它能正常工作的原因。
- **`node -e` 的 argv**：`node -e <script> <cmd> <json>` 时，额外参数落在 `process.argv[1]`/`[2]`（不是 `[2]`/`[3]`）。
- **debug 模式下的 eval**：`eval` 代码出现编译错误会让游戏卡在调试器（与 godot-mcp 相同）。用动态访问（`p.get("global_position")`）绕开静态类型推断；卡死时 `godot_stop_project` + `godot_run_project` 重启。
- **用真实 exe，别用版本管理器 shim**：shim 会立即退出并把真实 Godot 变孤儿进程，进程管理会误判其已死亡。

## 项目结构

```
plugin/godot-bridge.mjs           # 插件本体（标准 DSH 模块，命名导出 name/inject/apply）
plugin/task-center/               # 任务中心宿主半侧（board / service / locks / dispatch / api / tool / routes）
client/client.js                  # 浏览器半侧：引擎路径配置 + 任务中心面板（dsh.client）
plugin/mcp_interaction_server.gd  # 取自 godot-mcp（MIT）——游戏内 TCP 服务器 autoload
plugin/godot_operations.gd        # 取自 godot-mcp（MIT）——headless 操作脚本
plugin/validate_script.gd         # 取自 godot-mcp（MIT）——GDScript 编译检查
package.json                      # dsh.bundle + dsh.client manifest（供 `dsh plugin add` 安装）
cordis.patch.yml                  # bundle patch 层（插入工具行）
install.md / install.zh-CN.md     # 详细安装与维护说明
ARCHITECTURE.md / ARCHITECTURE.zh-CN.md  # 如何取代 godot-mcp + 协议细节
COVERAGE.md / COVERAGE.zh-CN.md   # 与 godot-mcp 的逐工具对比
CHANGELOG.md / CHANGELOG.zh-CN.md  # 版本发布记录
scripts/check-plugin-contract.mjs  # 静态依赖契约检查（`npm run check`）
scripts/diagnose-dsh-resolution.mjs  # 可重跑的 DSH 运行时解析诊断（仅开发用）
```

`mcp_interaction_server.gd`、`godot_operations.gd` 与 `validate_script.gd` 取自 [godot-mcp](https://github.com/tugcantopaloglu/godot-mcp)（MIT，随包内置）。插件通过模块相对路径定位这些脚本（`import.meta.url`）；传显式 `ops_script` / `validate_script` 参数可覆盖。

## 许可证

MIT
