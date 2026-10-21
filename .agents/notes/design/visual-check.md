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

2. 关掉首次弹窗：
   ```
   key Escape
   wait 500
   ```
   真实截图（`.investigate/visual/shell.png`）里首屏弹窗是 **「预览版说明」**，按钮是 **「继续」**；遮罩会挡住点击。用 `key Escape` 或 `click text="继续"` 关掉。

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
   六个导航按钮都带 `data-view`（board/queue/workers/locks/status/roles）。

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

## oil_ui_shoot 示例（三次，三张图）

```
oil_ui_shoot({ target: "http://127.0.0.1:<port>/?token=<token>", size: "1440x900",
  steps: "key Escape; wait 500; click [data-panel=\"task-center\"]; waitfor [data-panel-root=\"task-center\"]; click [data-view=\"roles\"]; waitfor [data-roles-tab=\"worker\"]; click [data-roles-tab=\"worker\"]; wait 500",
  out: "shots/visual/roles-worker.png" })

oil_ui_shoot({ target: "http://127.0.0.1:<port>/?token=<token>", size: "1440x900",
  steps: "waitfor [data-roles-tab=\"tester\"]; click [data-roles-tab=\"tester\"]; wait 500",
  out: "shots/visual/roles-tester.png" })

oil_ui_shoot({ target: "http://127.0.0.1:<port>/?token=<token>", size: "1440x900",
  steps: "waitfor [data-roles-tab=\"reviewer\"]; click [data-roles-tab=\"reviewer\"]; wait 500",
  out: "shots/visual/roles-reviewer.png" })
```

## 验收状态与限制

- 本卡执行者是 worker：`harnessStart` 返回 `tester-only`；本环境也无法 headless 登录 DSH（401）。因此**三张 1440×900 截图仍需 tester/user 按修正后的流程重拍**，在完成前本卡不能算视觉验收通过。
- `shots/visual/roles-worker.png`、`roles-tester.png`、`roles-reviewer.png` 三张齐全后，与 `explore/b.html` / `shots/final/b.png` 逐项对照；截图放非隐藏目录或 `.investigate/visual/` 时先输出再拷贝，主工作树保持干净。
