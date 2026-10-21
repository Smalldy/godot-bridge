# UI 验收流程（真实渲染）

目标：UI 类任务不再只靠 DOM 断言，而是在插件自带的**隔离 DSH**里打开真实页面、切到角色页、截图并与原型对比。隔离实例独立 DSH_HOME/profile、空闲端口、项目副本，不碰生产环境。

## 前置

- 只能由 **tester 或用户** 驱动 harness（worker 会被拒：`{"code":"tester-only"}`）。本流程第 1 步因此由 tester/用户执行。
- 主工作区有原型 `explore/b.html` 与截图 `shots/final/b.png`（对比基准）。
- 截图工具：`oil_ui_shoot`（Playwright），可用 `steps` 做点击/等待。

## 步骤与选择器

1. **起隔离实例（tester/user）**
   ```
   task_center { action: "harnessStart" }
   ```
   预期：返回 `ok:true`、`port`、`token`、`url`（形如 `http://127.0.0.1:<port>/?token=<token>`）、`cookie` 布尔。
   再取一次状态：`task_center { action: "harnessStatus" }` —— 顶层与 `harness` 内都有 `url`/`cookie`/`port`/`token`。

2. **打开页面**
   浏览器/截图工具 target 直接用返回的 `url`。若已交换 cookie，`url` 的首跳仍可完成认证；工具若复用 cookie，用 `origin`（`http://127.0.0.1:<port>/`）即可。
   预期：进入 DSH shell（侧边栏 + 主区域）。

3. **进入任务中心面板**
   点击侧边栏插件入口（中文「任务中心」，英文「Task Center」）：`button:has-text("任务中心")`
   等待面板根出现：`[data-panel="task-center"]`
   预期：看板头部、任务表、导航标签可见。

4. **切到角色页**
   点击面板导航里的「角色」：`button:has-text("角色")`
   等待页签容器：`[data-role-tabs="true"]`，且 `[data-roles-tab="worker"]`、`[data-roles-tab="tester"]`、`[data-roles-tab="reviewer"]` 均存在。
   预期：顶部工具栏（页签 + 当前使用）、左「原始提示词」卡、右「注入后的提示词」卡、底部动作条。

5. **逐页签截图**
   - 默认 worker：`[data-roles-tab="worker"]` 活动；截全页。
   - 点 `[data-roles-tab="reviewer"]` → 截图；点 `[data-roles-tab="tester"]` → 截图。
   两栏选择器可单独截：`[data-roles-pane="raw"]`、`[data-roles-pane="injected"]`。

6. **对比**
   与 `explore/b.html`（以及 `shots/final/b.png`）并排对比：

   - 顶部只有一个工具栏：左页签、右「当前使用」，无锚点行、无重复引导句。
   - 分段标签只在每段首次出现一次，顺序：角色与阶段 → 你的提示词 → 任务数据 → 权限边界与结论 → 技能。
   - 左栏是一张卡：标题、提示词、技能、实例数同卡；内置态提示词只读且带「默认角色不可修改」。
   - 页签为填充式活动项（`--elev` 背景），无下划线、无透明度、不加粗。
   - 卡片 1px 边线 + 圆角 8；标签 11px 带左侧 2px 竖线与来源说明。
   - 底部动作条左右平衡、主按钮唯一；长内容不压动作条（底部渐隐）。

7. **收尾**
   `task_center { action: "harnessStop" }`，预期实例退出、临时目录清理。

## oil_ui_shoot 示例

```
oil_ui_shoot {
  target: "<harnessStart.url>",
  out: "shots/visual/roles-page.png",
  steps: [
    "click button:has-text(\"任务中心\")",
    "wait [data-panel=\"task-center\"]",
    "click button:has-text(\"角色\")",
    "wait [data-role-tabs=\"true\"]",
    "click [data-roles-tab=\"reviewer\"]"
  ]
}
```
（选择器随 DSH 版本可能变化；面板根 `[data-panel="task-center"]` 与页签 `[data-roles-tab]` 是本卡新增的稳定标记。）

## 已知限制

- 本卡执行者是 worker，harnessStart 会被 `tester-only` 拒绝（spike 实测返回该拒绝码），因此真实截图需 tester/用户按上述步骤执行。
- 当前环境无法直接登录 DSH 页面做 headless 截图（401），故本卡只交付流程、稳定标记与结构测试，不声称已生成对比截图。
