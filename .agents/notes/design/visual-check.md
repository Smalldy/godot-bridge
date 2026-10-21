# UI 验收流程（真实渲染，可复现）

目标：UI 任务在插件自带的隔离 DSH 里打开真实页面、进角色页、截图并与原型对比。隔离实例独立 DSH_HOME/profile、空闲端口、项目副本，不碰生产环境。

## 前置

- 仅 **tester 或用户** 可驱动 harness（worker 调用返回 `tester-only`）。
- 原型：主工作区 `explore/b.html`；基准截图：`shots/final/b.png`。
- 截图工具：`oil_ui_shoot`；`steps` 语法见 oil-ui skill `references/tools.md`：`click <selector>`、`waitfor <selector>`、`wait <毫秒>`、`key <键>`、`scroll <dy>`、`type/fill/select`。等元素用 `waitfor`，等时间用 `wait 500`。**输出路径不要放在隐藏目录**（`.investigate/...` 不被接受）；写到普通目录（如 `shots/visual/`）后再拷贝。

## 完整步骤（逐条可运行）

1. 起隔离实例（tester/用户）：
   ```
   task_center { action: "harnessStart" }
   ```
   取返回的 `url`（形如 `http://127.0.0.1:<port>/?token=<token>`）与 `cookie`/`port`/`token`；也可用 `task_center { action: "harnessStatus" }` 的顶层字段。

2. 打开页面并关掉首次弹窗：
   ```
   key Escape
   wait 500
   ```
   首次进入会出现「开始使用」弹窗，遮罩会挡住点击，必须先 Escape 关掉。

3. 首次打开项目：
   ```
   fill input[placeholder="项目目录的绝对路径"] <项目绝对路径>
   click text="打开项目"
   waitfor [data-panel-root="task-center"]
   ```
   （输入框/按钮来自本项目插件的打开项目表单；已经是已知项目时可跳过 fill/click，但仍等待面板根出现。）

4. 进入面板并切到角色页：
   ```
   click [data-panel="task-center"]
   waitfor [data-panel-root="task-center"]
   click [data-view="roles"]
   waitfor [data-roles-tab="worker"]
   ```
   `[data-panel="task-center"]` 是侧边栏 glyph（在按钮内部，点击冒泡到 `selectPanel`）；DSH 侧边栏行没有稳定 data 属性，`aria-label` 随语言变化（任务/Tasks），不要用 `:has-text`。六个导航按钮都带 `data-view`（board/queue/workers/locks/status/roles）。

5. 三个页签截图（1440×900）：
   ```
   click [data-roles-tab="worker"]; wait 500
   click [data-roles-tab="tester"]; wait 500
   click [data-roles-tab="reviewer"]; wait 500
   ```
   两栏可单独截：`[data-roles-pane="raw"]`、`[data-roles-pane="injected"]`。

6. 对比 `explore/b.html` 与 `shots/final/b.png`：

   - worker 右栏「角色与阶段」只有角色/阶段身份行，任务标题与项目行在「任务数据」。
   - 内置角色模板标签是「内置默认提示词」；自定义/Fork 副本是「你的提示词」。
   - 页签：填充式活动项（`--elev`），无下划线/透明度/加粗。
   - 只有一层卡片边框（外层不再有 `gbt-rcard`；两栏各一张 `gbt-rolecard`）。
   - 标签 11px + 左侧 2px 竖线；动作条左右平衡、主按钮唯一、长内容渐隐不压条。

7. 收尾：
   ```
   task_center { action: "harnessStop" }
   ```

## oil_ui_shoot 示例

```
oil_ui_shoot({
  target: "http://127.0.0.1:<port>/?token=<token>",
  size: "1440x900",
  steps: "key Escape; wait 500; fill input[placeholder=\"项目目录的绝对路径\"] <项目绝对路径>; click text=\"打开项目\"; waitfor [data-panel-root=\"task-center\"]; click [data-panel=\"task-center\"]; waitfor [data-panel-root=\"task-center\"]; click [data-view=\"roles\"]; waitfor [data-roles-tab=\"worker\"]; click [data-roles-tab=\"tester\"]; wait 500; click [data-roles-tab=\"reviewer\"]; wait 500",
  out: "shots/visual/roles-reviewer.png"
})
```

## 已知限制

- worker 不能驱动 harness（tester-only）；真实截图需 tester/用户按上述步骤执行。
- 本环境无法登录 DSH 页面做 headless 截图（401），故本卡以结构断言与原型对照为准，不声称已生成新截图。
