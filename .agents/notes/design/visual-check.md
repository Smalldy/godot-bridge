# UI 验收流程（真实渲染，可复现）

目标：UI 任务在插件自带的隔离 DSH 里打开真实页面、进角色页、截图并与原型对比。隔离实例独立 DSH_HOME/profile、空闲端口、项目副本，不碰生产环境。

## 前置

- 仅 **tester 或用户** 可驱动 harness（worker 调用返回 `tester-only`）。
- 原型：主工作区 `explore/b.html`；基准截图：`shots/final/b.png`。
- 截图工具：`oil_ui_shoot`；`steps` 语法见 oil-ui skill `references/tools.md`：`click <selector>`、`waitfor <selector>`、`wait <毫秒>`、`key <键>`、`scroll <dy>`、`type/fill/select`。等元素用 `waitfor`，等时间用 `wait 500`。**输出路径不要放隐藏目录**（`.investigate/...` 不被接受），先写普通目录（如 `shots/visual/`）再拷贝。

## 完整步骤（逐条可运行）

1. 起隔离实例（tester/用户）：
   ```
   task_center { action: "harnessStart" }
   ```
   取返回的 `url`（`http://127.0.0.1:<port>/?token=<token>`）与 `cookie`/`port`/`token`；也可用 `task_center { action: "harnessStatus" }` 顶层字段。

2. 关掉首次弹窗（首启有两种形态，二选一；不要两种都执行）：
   ```
   # A. 「预览版说明」+「继续」按钮
   click text="继续"
   wait 500

   # B. 「开始使用」/ 登录弹窗（先聚焦再 Escape）
   wait 1000
   click text="开始使用"
   wait 300
   key Escape
   wait 900
   ```
   两种形态：**A = 预览版说明 + 继续**（旧版首启，真实截图 `.investigate/visual/shell.png` 就是这一种，点「继续」直关）；**B = 开始使用 / 登录**（新版首启的登录弹窗，Escape 不会直接生效——必须先用 `click text="开始使用"` 让它拿到焦点，再 `key Escape`，最后 `wait 900` 等遮罩退场，否则后面的点击都会落在遮罩上）。判断依据是页面上有没有「继续」按钮；有就走 A，没有就走 B。

3. 进入任务中心面板（先点 glyph，之后才可能有打开项目表单）：
   ```
   click [data-panel="task-center"]
   waitfor [data-panel-root="task-center"]
   ```
   `[data-panel="task-center"]` 是侧边栏 glyph（在按钮内部，点击冒泡到 `selectPanel`）。DSH 侧边栏行没有稳定 data 属性、`aria-label` 随语言变化（任务/Tasks），不要用 `:has-text`。

4. 仅在没有项目时才打开项目（表单在面板内部）：
   ```
   fill input[placeholder="项目目录的绝对路径"] <项目绝对路径>
   click text="打开项目"
   waitfor [data-panel-root="task-center"]
   ```
   说明：打开项目表单由本插件渲染在 TaskCenter 面板里（`snapshot.project` 为空时显示），**面板根不存在时表单也不存在**，所以必须先做第 3 步。harness 的首屏常见情况是项目与面板已经打开在弹窗后面（shell.png），这时直接跳过本步；手动首次进入才需要 fill/click。若真实首启表单其实是 DSH 自己的启动页而非本插件表单，以 DSH 实际界面为准并在证据里注明。

5. 切到角色页：
   ```
   click [data-view="roles"]
   waitfor [data-roles-tab="worker"]
   ```
   五个导航按钮都带 `data-view`（board/queue/workers/status/roles）。**没有 locks 页签**：文件锁已收敛为纯自动锁，`locks` 只是只读动作，面板不再有锁视图，任何 `[data-view="locks"]` 的步骤都是过期写法。

6. 三个页签各截一张 1440×900（缺一不可）：
   ```
   click [data-roles-tab="worker"]; wait 500
   click [data-roles-tab="tester"]; wait 500
   click [data-roles-tab="reviewer"]; wait 500
   ```
   两栏可单独截：`[data-roles-pane="raw"]`、`[data-roles-pane="injected"]`。

7. 对比 `explore/b.html` 与 `shots/final/b.png`：

   - worker 右栏「角色与阶段」只有角色/阶段身份行；任务标题与项目行在「任务数据」。
   - 内置角色模板标签是「内置默认提示词」；自定义/Fork 副本是「你的提示词」。
   - 页签：填充式活动项（`--elev`），无下划线/透明度/加粗。
   - 只有一层卡片边框（无 `gbt-rcard`；两栏各一张 `gbt-rolecard`）。
   - 标签 11px + 左侧 2px 竖线；动作条左右平衡、主按钮唯一、长内容渐隐不压条。

8. 收尾：
   ```
   task_center { action: "harnessStop" }
   ```

## oil_ui_shoot 示例（三次独立运行，每次都要重新导航）

每次 `oil_ui_shoot` 都新开一个页面：插件面板的 view 是内存态（新页面回到 `board`），所以**每次都要重走一遍导航前缀**（关弹窗 → glyph → 等面板根 → 需要时打开项目 → `[data-view="roles"]` → 目标页签）。缺前缀的后两次会在 `waitfor [data-roles-tab=...]` 上挂住。

**输出路径**：`oil_ui_shoot` 不接受隐藏输出目录（`.investigate/…`、`.tmp/…` 之类会被拒绝）；`out` 一律写普通目录（如 `shots/visual/roles-worker.png`），需要归档到隐藏目录时先写在普通目录再拷贝，主工作树保持干净。

```
oil_ui_shoot({ target: "http://127.0.0.1:<port>/?token=<token>", size: "1440x900",
  steps: "key Escape; wait 500; click [data-panel=\"task-center\"]; waitfor [data-panel-root=\"task-center\"]; click [data-view=\"roles\"]; waitfor [data-roles-tab=\"worker\"]; click [data-roles-tab=\"worker\"]; wait 500",
  out: "shots/visual/roles-worker.png" })

oil_ui_shoot({ target: "http://127.0.0.1:<port>/?token=<token>", size: "1440x900",
  steps: "key Escape; wait 500; click [data-panel=\"task-center\"]; waitfor [data-panel-root=\"task-center\"]; click [data-view=\"roles\"]; waitfor [data-roles-tab=\"tester\"]; click [data-roles-tab=\"tester\"]; wait 500",
  out: "shots/visual/roles-tester.png" })

oil_ui_shoot({ target: "http://127.0.0.1:<port>/?token=<token>", size: "1440x900",
  steps: "key Escape; wait 500; click [data-panel=\"task-center\"]; waitfor [data-panel-root=\"task-center\"]; click [data-view=\"roles\"]; waitfor [data-roles-tab=\"reviewer\"]; click [data-roles-tab=\"reviewer\"]; wait 500",
  out: "shots/visual/roles-reviewer.png" })
```

如果某个页面里没有项目（面板里出现打开项目表单），在 `click [data-view="roles"]` 之前追加：`fill input[placeholder="项目目录的绝对路径"] <项目绝对路径>; click text="打开项目"; waitfor [data-panel-root="task-center"]`。

## T-90：项目跟随会话（不再手填路径）

目标：证明 (1) 新浏览器 localStorage 为空时面板直接显示会话项目；(2) 项目弹窗有「使用当前项目」；(3) 面板记住的路径 ≠ 会话项目时顶部有可点击提示；(4) 切换会调用 `openProject`（界面切换 = 调度器绑定）。

准备：先把浏览器里的 pin 清掉，模拟“第一次打开”：`localStorage.removeItem('godotBridge.taskCenter.project')`（无痕窗口等效）。

```
# 1) 首次加载跟随会话
oil_ui_shoot({ target: "http://127.0.0.1:<port>/?token=<token>", size: "1440x900",
  steps: "key Escape; wait 500; click [data-panel=\"task-center\"]; waitfor [data-panel-root=\"task-center\"]; wait 800",
  out: "shots/visual/t90-session-project.png" })
```
预期：项目行直接是会话项目，标题右侧有「会话」来源徽标（`[data-project-source="session"]`），**没有**出现打开项目表单，全程没有手打过路径。

```
# 2) 项目弹窗里的「使用当前项目」
click text="⌂ 项目"
waitfor [data-action="use-current-project"]
click [data-action="use-current-project"]
wait 300
```
预期：`[data-project-input]` 已被填入服务端解析的项目路径（输入框旁的小字给出同一个路径），不需要手打。

```
# 3) 不一致提示：手动切到另一个项目，再回到会话项目
fill [data-project-input] <另一个真实存在的项目路径>
click text="打开项目"
wait 800
```
预期：顶部出现橙色 `[data-project-mismatch="true"]` 提示「面板：A · 当前会话：B」，右侧是「切换到会话项目」按钮（`[data-action="switch-to-session-project"]`）。点它之后：提示消失、项目行变成会话项目、来源徽标回到「会话」，并且 DSH 日志里能看到一次 `openProject` 动作（绑定同步，而不是只改了前端）。

若 harness 里没有会话工作区（服务端解析不出项目），面板会退回「尚未选择项目」+ 项目表单，此时「使用当前项目」按钮是禁用的——这是预期形态，不是失败。

## 验收状态与限制

- 本卡执行者是 worker：`harnessStart` 返回 `tester-only`；本环境也无法 headless 登录 DSH（401）。因此**三张 1440×900 截图仍需 tester/user 按修正后的流程重拍**，在完成前本卡不能算视觉验收通过。
- `shots/visual/roles-worker.png`、`roles-tester.png`、`roles-reviewer.png` 三张齐全后，与 `explore/b.html` / `shots/final/b.png` 逐项对照；截图放非隐藏目录或 `.investigate/visual/` 时先输出再拷贝，主工作树保持干净。
