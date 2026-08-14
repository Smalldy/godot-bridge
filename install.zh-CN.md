[English](install.md) | **中文**

# godot-bridge — 安装与维护

## 文件

```
plugin/godot-bridge.js            # 动态插件形态：cordis_define 的 code.host 函数体
plugin/godot-bridge.mjs           # 部署形态：零 import ESM 模块（命名导出 name/inject/apply）
plugin/mcp_interaction_server.gd  # 从 godot-mcp 内置（MIT）——游戏内 TCP 服务器 autoload
plugin/godot_operations.gd        # 从 godot-mcp 内置（MIT）——headless 操作脚本
plugin/validate_script.gd         # 从 godot-mcp 内置（MIT）——GDScript 编译检查
```

两种形态实现完全相同的逻辑（TCP 桥 + 进程管理 + 8 个工具），只是注册 API 不同，由两种运行环境决定：

| | 动态插件（方式 B） | 部署/社区 bundle（方式 A/C） |
| --- | --- | --- |
| 运行环境 | 动态沙箱（vm） | 真实 cordis 插件 |
| 注册 | `harness.defineTool` + `harness.registerTool` | `ctx.tools.register` |
| 参数 | DSL / 原始 JSON Schema 包装，根需开放 | 原始 JSON Schema，根 `additionalProperties:false` 也行 |
| import | 无（只用内建） | 无（必须零 import，见下） |

## 为什么部署形态是"零 import"

用户预设位于 `${DSH_HOME:-~/.dsh}/.agent-presets/`。从那里 Node 向上走 `node_modules` 永远到不了 harness 的依赖，所以本地插件模块不能 `import` 任何 `@deepseek-ai/*` 包。因此模块用手写 JSON Schema 构造工具定义，通过注入的 `tools` 服务注册——`ctx.tools.register` 只校验 `output.render`、`output.schema`（经 `assertSupportedJsonSchema`）和 `timeoutMs`，不要求 defineTool 产物。

组合行用**相对路径**引用模块（相对组合文件所在目录解析），文件随预设走：

```yaml
- id: tool-godot-bridge
  name: './plugins/godot-bridge.mjs'
```

该行只注册工具、不发布服务 → 不需要 `isolate` realm，作为普通顶层行即可（和 `tool-bash` 同级）。

模块用命名导出（`export const name`、`export const inject`、`export function apply`）——cordis loader 的 `unwrapExports`（`exports.default ?? exports`）会把命名空间变成插件对象。不要加多余的 `export default`。

## 安装

### A. 部署级 agent 预设

1. 复制 `plugin/godot-bridge.mjs` → `<预设目录>/plugins/godot-bridge.mjs`
2. 在 `<预设目录>/agent.cordis.yml` 追加上面的行
3. 校验：`agentPresets.standingKeyFor('<预设id>')` — 必须无错返回
4. 用该预设开新会话，确认 8 个 `godot_*` 工具在工具列表里

### C. 社区 bundle（`dsh plugin add`）

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

包内 `package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml`，插入 `tool-godot-bridge` 行。纯 ESM + 资产、无构建脚本，git 安装不需要 build 豁免。

### B. 会话内动态插件

让 Agent 读 `plugin/godot-bridge.js`，`cordis_define`（kind new，idPrefix `gbrg`，code.host = 文件内容）后 `cordis_run`。动态插件存在于会话注册表，进程重启丢失——要常驻用预设或 bundle 形态。

## 配置

- GODOT_PATH：工具参数 `godot_path` > `<workspace>/.omp/mcp.json` 的 `env.GODOT_PATH` > 内置 gdvm 4.7.1 兜底。始终指向**真实 exe**，别用 gdvm shim。
- 端口/主机：写死 `127.0.0.1:9090`（与 `McpInteractionServer` autoload 默认一致）。

## 维护

- 改 `plugin/godot-bridge.mjs` 无需重新构建（纯 ESM）。
- 改预设组合后重跑 `standingKeyFor` 做 mount 校验。
- 游戏侧（`mcp_interaction_server.gd` autoload）永远不会被插件修改。
