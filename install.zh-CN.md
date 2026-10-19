[English](install.md) | **中文**

# godot-bridge — 安装与维护

## 文件

```
plugin/godot-bridge.mjs           # 插件的工具行（标准 DSH 模块：命名导出 name/inject/apply）
plugin/task-center/*.mjs          # 任务中心 host 半侧（任务板、派发、合并队列、API 路由与工具）
client/client.js                  # 浏览器半侧：引擎路径配置页 + 任务中心面板（同一个 dsh.client bundle）
plugin/mcp_interaction_server.gd  # 取自 godot-mcp（MIT）——游戏内 TCP 服务器 autoload
plugin/godot_operations.gd        # 取自 godot-mcp（MIT）——headless 操作脚本
plugin/validate_script.gd         # 取自 godot-mcp（MIT）——GDScript 编译检查
package.json                      # dsh.bundle + dsh.client manifest（供 `dsh plugin add` 安装）
cordis.patch.yml                  # bundle patch 层（插入两条 row：工具行与任务中心）
```

插件是标准 DSH bundle 模块：`import { defineTool } from '@deepseek-ai/dsh-tools'`，17 个 `godot_*` 工具经 `ctx.tools.register` 注册。模块用命名导出（`export const name`、`export const inject`、`export function apply`）——cordis loader 的 `unwrapExports`（`exports.default ?? exports`）会把命名空间变成插件对象。不要加多余的 `export default`：它会令 `unwrapExports` 收敛成那一个值，`name`/`inject`/`apply` 被静默丢弃。

自 0.3.0 起，bundle 会插入**同一个包的两条 row**（`cordis.patch.yml`）：`tool-godot-bridge`（17 个 `godot_*` 工具）与 `task-center`（`godot-bridge/task-center`：`task_center` 工具 + 任务中心面板）。插件页卡片数跟随 bundle、组件数跟随 row，因此两条 row 落在同一张卡片上，同一个浏览器 bundle（`client/client.js`）承载两个界面。`task_center` 刻意不算 `godot_*` 工具，所以「17 个 `godot_*` 工具」始终准确。

任务中心的**运行态都放在使用它的项目里**，从不放进包或 profile：`<项目>/.agents/tasks.json`（任务板）、`.agents/roles.json`（角色配置）、`.agents/test-harness.json`（harness 配置）。它们是工作状态——请把 `.agents/` 加进该项目的 `.gitignore`。任务板、角色、合并队列与 harness 流程见 [README → 任务中心](README.zh-CN.md#任务中心task-center) 与 [README → 隔离 DSH 测试 harness](README.zh-CN.md#隔离-dsh-测试-harness)；本页只讲安装与维护。

因为要 `import '@deepseek-ai/*'`，模块必须在加载时解析到 harness 依赖树。DSH 0.2 用 launcher 的 runtime resolution 取代了物理 fallback 层：装进 `$DSH_HOME/profiles/<name>/node_modules` 的 bundle 会自动被路由到安装版副本；而 `link:` 的 checkout——真实路径落在 profiles 树之外（Node 的 ESM loader 会先 realpath 再 import）——只有在插件自己的 `peerDependencies` 里声明了该包名时才会被路由。godot-bridge ≥ 0.1.8 声明了 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`（均标 `peerDependenciesMeta.optional`，pnpm 不会去 registry 安装 harness 包）。改 manifest 时保留该声明——`npm run check` 会在缺失时失败。**不要**把文件复制进用户 agent 预设（`~/.dsh/.agent-presets/...`）：那里不在任何解析范围内，解析不到 `@deepseek-ai/dsh-tools`。

## 安装

### 推荐：社区 bundle（`dsh plugin add`）

```sh
dsh plugin --profile web add github:Smalldy/godot-bridge
```

`dsh plugin` 是 pnpm 转发器：把包装进 profile，并因包内 `dsh.bundle` manifest 指向 `cordis.patch.yml`（插入按包名引用的 `tool-godot-bridge` 与 `task-center` 两条 row）而把 `godot-bridge` 追加进该 profile 的 `dsh.profile.bundles` 层列表。纯 ESM + 资产、无构建脚本，git 安装不需要 `allowBuilds` 豁免。重启后该 profile 的所有会话都有 17 个 `godot_*` 工具加 `task_center`，插件页也会出现任务中心面板。

同一命令也可安装本地 checkout 或 tarball：

```sh
dsh plugin --profile web add ./path/to/godot-bridge     # 本地 checkout
dsh plugin --profile web add ./godot-bridge-0.3.0.tgz   # pnpm pack 产物
```

### 本地开发（`link:`）

`link:` 依赖（`"godot-bridge": "link:/path/to/godot-bridge"`，即把本地 checkout 加进 profile 时 pnpm 写下的形式）会把 profile 的 `node_modules/godot-bridge` 变成指向你工作副本的符号链接，因此改代码无需重装即可生效：浏览器半侧（`client/client.js`）由宿主按产物文件轮询在约一秒内热换，插件 host 半侧在重载 profile 时重新 import。唯一的例外是 `package.json`——见下一条。它同时也是 launcher 的 runtime resolution 唯一无法自动路由的安装形态：插件真实路径在 profiles 树之外，而 *linked root* 只有在插件 `peerDependencies` 里声明了该包名时才会拿到 harness 包。这次正是为此补上声明——没有它，整个 bundle 会 import 失败（`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools' imported from …godot-bridge.mjs`），17 个 `godot_*` 工具（以及 `task_center`）一个都注册不上。

- 不需要「改完即生效」时，优先用非符号链接安装：`pnpm pack` 后 `dsh plugin --profile web add ./godot-bridge-0.3.0.tgz`（每次改动后重装）。
- 改完插件的 host 半侧后，重新加载 profile（插件页）或重启 DSH，确认 17 个 `godot_*` 工具与任务中心面板都在。改完 `package.json`（`dsh.client` 声明、`exports`、`files`）则**必须重启 DSH**：客户端模块扫描对每个 Loader 行只读一次该包的 manifest，并缓存到宿主重启为止，重载 profile 不够。`npm run check` 守护依赖契约，`scripts/diagnose-dsh-resolution.mjs` 会报告 launcher 实际路由了什么——见 [README → DSH 0.2+ 兼容性与故障排查](README.zh-CN.md#dsh-02-兼容性与故障排查)。

## 移除

```sh
dsh plugin --profile web remove godot-bridge
```

`dsh plugin remove` 在 profile 目录里转发 `pnpm remove`，然后调和 `dsh.profile.bundles`——依赖**和** `godot-bridge` bundle 层会一起从 profile 的 `package.json` 中删除。重启后该 profile 的会话不再有 17 个 `godot_*` 工具，`task_center` 工具与任务中心面板也一并消失。标准 `web` profile 本身不受影响；移除插件从不创建或删除 profile。

注意事项：

- 若游戏正在运行，先用 `godot_stop_project` 停掉——插件没了之后就没有工具能停了。作为兜底，插件注册了卸载清理：会话重载后会自动终止它启动的 Godot 子进程。
- 不会动其他任何东西：`project.godot`、游戏的 `McpInteractionServer` autoload、以及任何游戏文件在安装/移除时都不会被修改。
- 任何时候可用上面的 `add` 命令重新安装。

## 配置

- Godot 可执行文件：每次调用的 `godot_path` 参数 > `godotPath` 插件设置 > PATH 上的 `godot` 命令。插件作者**不预设**路径（Godot 是便携 exe，可能位于任意位置）；`godot` 不在 PATH 时，请填自己的引擎路径。始终指向**真实 exe**，别用版本管理器 shim。

  `godotPath` 是插件自身配置里的 `.volatile()` 字段：按活值读取（volatile 字段更新不需要 remount 插件）。取值位置：

  - **DSH 0.2.x** —— `tool-godot-bridge` 行的配置，有三条等价入口：插件页 **godot-bridge 卡片页**上的 `Godot 可执行文件路径` 字段（见下文[DSH 0.2 上的 GUI 字段](#dsh-02-上的-gui-字段)）、`godot_set_engine_path` 工具（它经 `ctx.configEditor.edit(...)` 写入 profile patch，立即生效、无需重启），或在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里给该行手写 `config:` 块。工具会在写入前校验文件存在，并返回 `persisted: 'profile-patch'`；GUI 字段是一次纯文本保存（浏览器无法 stat 文件），请直接指向真实 exe。

    ```yaml
    - id: tool-godot-bridge
      config:
        godotPath: C:/path/to/Godot_v4.4-stable_win64.exe
    ```
  - **DSH 0.1.6–0.1.x** —— 旧 settings 段（`$DSH_HOME/settings.yaml` 的 `godot-bridge:` 段，或该版本的插件配置页）；该 API 存在时插件仍走 `settings.register`，并返回 `persisted: 'settings'`。
  - 0.1.x → 0.2.x 迁移：`settings.yaml` 里的 `godot-bridge:` 段**不会**被带过去，因为 DSH 0.2 按插件 entry id 导入遗留段，而本插件的行 id 是 `tool-godot-bridge`。但不需要你重新填写：当当前运行时没有配置路径时，插件会读取该段，并把其中的值经与工具相同的 profile-patch 写入路径写回，升级前配置的引擎构建即可继续使用。已配置的值永远不会被覆盖；记录在磁盘上已不存在的路径会被忽略——这种情况仍保留 PATH 上 `godot` 的兜底，并打印一条点名丢失值的告警。
- 端口/主机：写死 `127.0.0.1:9090`（与 `McpInteractionServer` autoload 默认一致）。
- headless 脚本定位：插件按模块相对路径（`import.meta.url`）；传显式 `ops_script` / `validate_script` 参数可覆盖。

## DSH 0.2 上的 GUI 字段

只有当某个**浏览器半侧**以**包名**为键注册 keyed slot `plugins.bundle.config` 时，DSH 才会渲染该组合包的配置区（某一**行**自己的表单则用 keyed slot `plugins.row.config`、以 `<包名>#<行 id>` 为键，位置更深一层；组合包有多个可独立配置的行时它才是正确选择）。本组合包自带该浏览器半侧（`client/client.js`，在 manifest 里由 `dsh.client` 声明）并注册 `godot-bridge`，因此在插件页打开 **godot-bridge** 卡片时，`Godot 可执行文件路径` 字段就出现在描述与行列表之间，带**保存**与针对本 profile 覆盖值的**恢复默认**。

保存走的是 DSH 设置的同一条路：落到本 profile `cordis.patch.yml` 的 `tool-godot-bridge` 行，也就是 `godot_set_engine_path` 写入的同一处。所以该字段、那个工具、以及手写的 `config:` 块是同一个值的三种视角，改动立即生效、无需重启。关闭那一行时配置区随之消失——浏览器半侧属于那一行。

在 DSH 0.1.6–0.1.x 上，该 slot 虽然存在，但运行时没有设置表单服务可读该值，因此浏览器半侧在那里不注册，卡片维持上文[配置](#配置)一节描述的行为（没有 GUI 字段，用工具或 `settings.yaml`）。

## 维护

- 改 `plugin/godot-bridge.mjs` 无需重新构建（纯 ESM）；改 `client/client.js` 同样无需构建——宿主按产物文件轮询，约一秒内热换。
- 改完插件后重新安装进 profile（再次 `dsh plugin --profile web add github:Smalldy/godot-bridge`）并重启会话。`link:` 安装无需重装——host 半侧的改动重载 profile（插件页）即可，而 `package.json`（`dsh.client`/`exports`/`files`）的改动必须重启 DSH：这些事实对每个 Loader 行只读一次并缓存到重启为止。
- 提交或发布前先跑 `npm run check`（静态依赖契约：`@deepseek-ai/*` peers 声明、bundle patch、入口导出）。`node scripts/diagnose-dsh-resolution.mjs --profile <profile>` 会重跑 launcher 的解析并打印它实际路由了什么（仅开发用，需要已安装的 DSH 应用）。
- manifest 的 `peerDependencies` 会影响 DSH 的加载决策：声明的 `@deepseek-ai/dsh-*` 范围与当前运行时不匹配时，DSH 会带明确信息 **skip** 该 bundle，而不是在 import 阶段失败。
- **发布更新**：在 `package.json` 递增 `version` 并推送——插件启动时的版本检查（见 README「更新提示」）以此作为发布标记，已装用户只有在远端版本更高时才会看到提示。
- 游戏侧（`mcp_interaction_server.gd` autoload）永远不会被插件修改。
