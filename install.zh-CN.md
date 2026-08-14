[English](install.md) | **中文**

# godot-bridge — 安装与维护

## 文件

```
plugin/godot-bridge.mjs           # 插件本体（标准 DSH 模块：命名导出 name/inject/apply）
plugin/mcp_interaction_server.gd  # 取自 godot-mcp（MIT）——游戏内 TCP 服务器 autoload
plugin/godot_operations.gd        # 取自 godot-mcp（MIT）——headless 操作脚本
plugin/validate_script.gd         # 取自 godot-mcp（MIT）——GDScript 编译检查
package.json                      # dsh.bundle manifest（供 `dsh plugin add` 安装）
cordis.patch.yml                  # bundle patch 层（插入工具行）
```

插件是标准 DSH bundle 模块：`import { defineTool } from '@deepseek-ai/dsh-tools'`，15 个 `godot_*` 工具经 `ctx.tools.register` 注册。模块用命名导出（`export const name`、`export const inject`、`export function apply`）——cordis loader 的 `unwrapExports`（`exports.default ?? exports`）会把命名空间变成插件对象。不要加多余的 `export default`：它会令 `unwrapExports` 收敛成那一个值，`name`/`inject`/`apply` 被静默丢弃。

因为要 `import '@deepseek-ai/*'`，模块必须装在 Node 能解析 harness 依赖树的位置——即走官方 bundle 机制（`dsh plugin add`）：包装进 profile 的 `node_modules`（harness 启动时会在那里 heal 共享的 `@deepseek-ai/*` 依赖层）。**不要**把文件复制进用户 agent 预设（`~/.dsh/.agent-presets/...`）：那个位置解析不到 `@deepseek-ai/dsh-tools`。

## 安装

### 推荐：社区 bundle（`dsh plugin add`）

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` 是 pnpm 转发器：把包装进 profile，并因包内 `dsh.bundle` manifest 指向 `cordis.patch.yml`（插入按包名引用的 `tool-godot-bridge` 行）而把 `godot-bridge` 追加进该 profile 的 `dsh.profile.bundles` 层列表。纯 ESM + 资产、无构建脚本，git 安装不需要 `allowBuilds` 豁免。重启后该 profile 的所有会话都有 15 个工具。

同一命令也可安装本地 checkout 或 tarball：

```sh
dsh plugin --profile web add ./path/to/godot-bridge     # 本地 checkout
dsh plugin --profile web add ./godot-bridge-0.1.0.tgz   # pnpm pack 产物
```

## 移除

```sh
dsh plugin --profile web remove godot-bridge
```

`dsh plugin remove` 在 profile 目录里转发 `pnpm remove`，然后调和 `dsh.profile.bundles`——依赖**和** `godot-bridge` bundle 层会一起从 profile 的 `package.json` 中删除。重启后该 profile 的会话不再有 15 个 `godot_*` 工具。标准 `web` profile 本身不受影响；移除插件从不创建或删除 profile。

注意事项：

- 若游戏正在运行，先用 `godot_stop_project` 停掉——插件没了之后就没有工具能停了。作为兜底，插件注册了卸载清理：会话重载后会自动终止它启动的 Godot 子进程。
- 不会动其他任何东西：`project.godot`、游戏的 `McpInteractionServer` autoload、以及任何游戏文件在安装/移除时都不会被修改。
- 任何时候可用上面的 `add` 命令重新安装。

## 配置

- GODOT_PATH：工具参数 `godot_path` > `<workspace>/.omp/mcp.json` 的 `env.GODOT_PATH` > 内置 gdvm 4.7.1 兜底。始终指向**真实 exe**，别用 gdvm shim。
- 端口/主机：写死 `127.0.0.1:9090`（与 `McpInteractionServer` autoload 默认一致）。
- headless 脚本定位：插件按模块相对路径（`import.meta.url`）；传显式 `ops_script` / `validate_script` 参数可覆盖。

## 维护

- 改 `plugin/godot-bridge.mjs` 无需重新构建（纯 ESM）。
- 改完插件后重新安装进 profile（再次 `dsh plugin --profile web add github:Smalldy/godot-bridge`）并重启会话。
- **发布更新**：在 `package.json` 递增 `version` 并推送——插件启动时的版本检查（见 README「更新提示」）以此作为发布标记，已装用户只有在远端版本更高时才会看到提示。
- 游戏侧（`mcp_interaction_server.gd` autoload）永远不会被插件修改。
