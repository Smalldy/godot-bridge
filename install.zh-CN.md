[English](install.md) | **中文**

# godot-bridge — 安装与维护

## 文件

```
plugin/godot-bridge.mjs           # 插件本体（零 import ESM 模块，命名导出 name/inject/apply）
plugin/mcp_interaction_server.gd  # 取自 godot-mcp（MIT）——游戏内 TCP 服务器 autoload
plugin/godot_operations.gd        # 取自 godot-mcp（MIT）——headless 操作脚本
plugin/validate_script.gd         # 取自 godot-mcp（MIT）——GDScript 编译检查
package.json                      # dsh.bundle manifest（供 `dsh plugin add` 安装）
cordis.patch.yml                  # bundle patch 层（插入工具行）
```

只发布**一份实现**（TCP 桥 + 进程管理 + 15 个工具）；下面两条安装路径加载的是同一个 `godot-bridge.mjs`。区别只在插件行如何进入你的组合：`dsh plugin add` 通过 bundle manifest 写入，手动路径由你手写。

## 为什么插件是"零 import"

**`import` 解析是"按文件位置"的**：Node 解析裸标识符（`import '@deepseek-ai/...'`）时，从**被导入文件自己的目录**开始逐级向上找 `node_modules`。harness 官方插件位于 harness 依赖树内部，`@deepseek-ai/*` 就在它们上方，所以 import 正常工作；而本插件以独立文件部署在用户预设下：

```
${DSH_HOME:-~/.dsh}/.agent-presets/<预设>/plugins/godot-bridge.mjs
```

从这个位置向上找（`~/.dsh` → 用户主目录 → 盘符根）永远到不了 harness 的 `node_modules`，任何 `import '@deepseek-ai/*'` 都会 `MODULE_NOT_FOUND`。所以"零 import"是**安装位置强加的约束，不是风格选择**——也正是它让"复制一个文件即可安装"成为可能。

为了不 import 任何东西也能注册工具，模块用手写 JSON Schema 构造工具定义，交给注入的 `tools` 服务注册——`ctx.tools.register` 只校验 `output.render`、`output.schema`（经 `assertSupportedJsonSchema`）和 `timeoutMs`，不要求 defineTool 产物。

模块用命名导出（`export const name`、`export const inject`、`export function apply`）——cordis loader 的 `unwrapExports`（`exports.default ?? exports`）会把命名空间变成插件对象。不要加多余的 `export default`：它会令 `unwrapExports` 收敛成那一个值，`name`/`inject`/`apply` 被静默丢弃。

## 安装

### 推荐：社区 bundle（`dsh plugin add`）

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

包内 `dsh.bundle` manifest 指向 `cordis.patch.yml`，把 `tool-godot-bridge` 行（按包名引用）插入 profile。纯 ESM + 资产、无构建脚本，git 安装不需要 `allowBuilds` 豁免。重启后该 profile 的所有会话都有 15 个工具。

### 手动：部署级 agent 预设

没有 `dsh` CLI、或想装进特定预设时用这个。

1. 复制 `plugin/godot-bridge.mjs` → `<预设目录>/plugins/godot-bridge.mjs`
2. 在 `<预设目录>/agent.cordis.yml` 追加：

   ```yaml
   - id: tool-godot-bridge
     name: './plugins/godot-bridge.mjs'
   ```

3. 校验：`agentPresets.standingKeyFor('<预设id>')` — 必须无错返回
4. 用该预设开新会话，确认 15 个 `godot_*` 工具在工具列表里

## 配置

- GODOT_PATH：工具参数 `godot_path` > `<workspace>/.omp/mcp.json` 的 `env.GODOT_PATH` > 内置 gdvm 4.7.1 兜底。始终指向**真实 exe**，别用 gdvm shim。
- 端口/主机：写死 `127.0.0.1:9090`（与 `McpInteractionServer` autoload 默认一致）。
- headless 脚本定位：插件按模块相对路径（`import.meta.url`）；传显式 `ops_script` / `validate_script` 参数可覆盖。

## 维护

- 改 `plugin/godot-bridge.mjs` 无需重新构建（纯 ESM）。
- 改预设组合后重跑 `standingKeyFor` 做 mount 校验。
- 游戏侧（`mcp_interaction_server.gd` autoload）永远不会被插件修改。
