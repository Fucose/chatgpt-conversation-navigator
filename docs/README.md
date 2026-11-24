# 项目文档入口

最后核对：2026-11-24

这里是开发与跨会话协作的阅读入口。用户安装和使用说明仍以根目录 [README.md](../README.md) 为准。

## 当前知识

- [历史加载与消息导航架构](architecture/history-and-navigation.md)：运行流程、代码数据流、ChatGPT 原生接口兼容策略和当前故障结论。
- [ADR 0001：原生滚动所有权](decisions/0001-native-scroll-ownership.md)：为什么新虚拟列表定位后禁止脚本继续写 `scrollTop`，以及旧接口为何仍保留为回退。

## 当前工作

- 没有进行中的计划。
- 2026-11-20 的虚拟列表滚动循环修复已完成实现和验证；用户在连续数日实测后，于 2026-11-24 授权提交全部改动、推送并发布 `v0.5.6`。发布前检查和恢复步骤见最新交接；最终发布结果以对应 Tag 和 GitHub Actions 为准。
- 最近完成的计划：[历史加载与倒数第二条消息跳动修复](plans/2026-11-20-history-navigation-oscillation.md)。

## 最新交接

- [2026-11-20 历史加载与消息导航交接](handoffs/2026-11-20-history-navigation-oscillation.md)

## 工作与决策记录

- 计划：`docs/plans/`
- 开发日志：[2026-11 开发日志](devlog/2026-11.md)
- 决策：[ADR 0001](decisions/0001-native-scroll-ownership.md)
- 交接：`docs/handoffs/`

## 阅读路线

1. 阅读 [AGENTS.md](../AGENTS.md) 中的仓库约束和连续性契约。
2. 阅读本页，以及 `git status --short --branch`。
3. 阅读与任务相关的架构文档和决策，再检查代码与测试。
4. 如果任务是继续、审查或发布当前修复，阅读最新交接中的验证范围和授权边界。
