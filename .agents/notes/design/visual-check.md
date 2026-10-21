# UI 验收流程（真实渲染）

目标：UI 类任务不再只靠 DOM 断言，而是在插件自带的**隔离 DSH**里打开真实页面、切到角色页、截图并与原型对比。隔离实例独立 DSH_HOME/profile、空闲端口、项目副本，不碰生产环境。

## 前置

- 只能由 **tester 或用户** 驱动 harness（worker 会被拒：`{"code":"tester-only"}`）。本流程第 1 步因此由 tester/用户执行。
- 主工作区有原型 `explore/b.html` 与截图 `shots/final/b.png`（对比基准）。
- 截图工具：`oil_ui_shoot`（Playwright）。`steps` 的语法见 oil-ui skill 的 `references/tools.md`：`click <selector>`、`waitfor <selector>`、`wait <毫秒>`、`key <键>`、`scroll <dy>`、`type/fill/select`；**没有** `wait <selector>`（等元素用 `waitfor`，等时间用 `wait 500`）。

## 侧边栏入口说明

DSH 的侧边栏行由宿主渲染：`<button aria-label={本地化标签} ...><span class=glyph>{plugin glyph}</span>{label}</button>`。该 `button` **没有稳定的 data 属性**，`aria-label` 随语言变化（中文「任务」、英文「Tasks」，注意不是面板标题键「任务中心 / Task Center」）。插件注册进 `sidebar.panellist` 的 glyph 现在自带 `data-panel="task-center"`；glyph 在 `<button>` 内部，点击会冒泡到按钮的 `selectPanel`，因此 `click [data-panel="task-center"]` 是语言无关的入口选择器。文字选择器 `button:has-text("任务")` / `"Tasks"` 仅作人工备用。

进入面板后，面板根的稳定标记是 `[data-panel-root="task-center"]`（面板根同时保留 `data-panel="task-center"`）。

## 步骤与选择器

1. **起隔离实例（tester/user）**
   ```
   task_center { action: "harnessStart" }
   ```
   预期：返回 `ok:true`、`port`、`token`、`url`（`http://127.0.0.1:<port>/?token=<token>`）、`cookie` 布尔、`origin`。
   再取状态：`task_center { action: "harnessStatus" }` —— 顶层与 `harness` 内都有 `url`/`cookie`/`port`/`token`。

2. **打开页面**
   截图工具 target 用返回的 `url`（token 首跳完成认证）；工具已持有 cookie 时可用 `origin`（`http://127.0.0.1:<port>/`）。
   预期：进入 DSH shell（侧边栏 + 主区域）。

3. **进入任务中心面板**
   点击侧边栏 glyph：`[data-panel="task-center"]`（在按钮内部，点击冒泡到 `selectPanel`）。
   等待面板根：`[data-panel-root="task-center"]`。
   预期：看板头部、任务表、导航标签可见。
   人工备用（非首选）：`button:has-text("任务")`，英文界面用 `button:has-text("Tasks")`。

4. **切到角色页**
   点击面板导航的「角色」：`button:has-text("角色")`（面板导航由本插件渲染，无稳定 data 属性；中文界面「角色」，英文界面 `button:has-text("Roles")`）。
   等待页签容器：`[data-role-tabs="true"]`，且 `[data-roles-tab="worker"]`、`[data-roles-tab="tester"]`、`[data-roles-tab="reviewer"]` 均存在。
   预期：顶部工具栏（页签 + 当前使用）、左「原始提示词」卡、右「注入后的提示词」卡、底部动作条。

5. **逐页签截图**
   - 默认 worker：`[data-roles-tab="worker"]` 活动；截全页。
   - 点 `[data-roles-tab="reviewer"]` → 截图；点 `[data-roles-tab="tester"]` → 截图。
   两栏可单独截：`[data-roles-pane="raw"]`、`[data-roles-pane="injected"]`。

6. **对比**
   与 `explore/b.html`（及 `shots/final/b.png`）并排对比：

   - 顶部只有一个工具栏：左页签、右「当前使用」，无锚点行、无重复引导句。
   - 分段标签只在每段首次出现一次，顺序：角色与阶段 → 你的提示词 → 任务数据 → 权限边界与结论 → 技能。
   - 左栏是一张卡：标题、提示词、技能、实例数同卡；内置态提示词只读且带「默认角色不可修改」。
   - 页签为填充式活动项（`--elev` 背景），无下划线、无透明度、不加粗。
   - 卡片 1px 边线 + 圆角 8；标签 11px 带左侧 2px 竖线与来源说明。
   - 底部动作条左右平衡、主按钮唯一；长内容不压动作条（底部渐隐）。

7. **收尾**
   `task_center { action: "harnessStop" }`，预期实例退出、临时目录清理。

## oil_ui_shoot 示例（已按 tools.md 语法）

```
oil_ui_shoot({
  target: "http://127.0.0.1:<port>/?token=<token>",
  size: "1440x900",
  steps: "click [data-panel=\"task-center\"]; waitfor [data-role-tabs=\"true\"]; click [data-roles-tab=\"reviewer\"]; wait 500",
  out: "shots/roles-review.png"
})
```

（`[data-panel="task-center"]` 是侧边栏 glyph；进入后`[data-panel-root="task-center"]` 可作为第二断言。`waitfor` 等元素、`wait 500` 等渲染稳定。）

## 已知限制

- 本卡执行者是 worker，harnessStart 会被 `tester-only` 拒绝（spike 实测返回该拒绝码），因此真实截图需 tester/用户按上述步骤执行。
- 当前环境无法直接登录 DSH 页面做 headless 截图（401），故本卡只交付流程、稳定标记与结构测试，不声称已生成对比截图。
