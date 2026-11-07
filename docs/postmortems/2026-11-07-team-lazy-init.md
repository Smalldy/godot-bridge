# 事故复盘：面板显示“无团队”，发消息后恢复

- 日期：2026-11-07
- 影响：打开任务中心面板显示“该项目团队：无 → 请在该会话中初始化”，看板 149/149 仍在；发一条对话后自动恢复。

## 现象

- 新 DSH 会话/宿主打开面板，team=null；
- 面板显示“无团队”，看起来像项目数据丢失；
- 发消息激活 Lead 后，下一次轮询恢复。

## 根因

- Team 是会话级 Agent Teams 运行时对象，不跨 DSH 重启/新会话持久化；
- 面板在会话/Lead 尚未初始化完成时读取 /state，得到 team=null；
- 发消息激活会话后，Agent Teams 懒创建/挂上团队，轮询拿到新状态。

## 检测缺口

- 前端没有 teamStatus/loading 单一派生，把“初始化中”和“确实无团队”混为红色提示；
- 回答时把“需要建队/reload”当成主路径，实际是初始化时序。

## 动作

- 确认看板/项目文件未丢；
- 发消息或建队/onboard 初始化；
- 记录本复盘。

## Guard

- 前端 selectors：teamStatus = ok|mismatch|building|missing|unavailable|no-members；初始化中显示 loading，不显示“无团队”；
- 面板重试/延迟；T-150 的建队按钮作为 fallback；
- 测试：teamStatus 纯函数 + 渲染测试覆盖 null/初始化/缺失。
