# agent-connector 项目入口

当前状态（2026-11-11）：V1.3 已推送到 `main` 并打标签 `V1.3`（`af08fed`），2026-11-11 06:36（UTC）起在本机上线，包含 V1.2 之后的全部改动，见 [V1.3](V1.3/iteration.md)。飞书机器人 Sophia 以 Claude Code 在本机长期运行，运行环境见[架构](architecture.md)。用户验收未进行。V1.4（多个机器人）2026-11-11 07:49（UTC）起在本机上线，见 [V1.4](V1.4/iteration.md)。

下一步：用户在飞书确认卡片效果、撤回中断、`/model` 与 `/effort`；超过 30 MB 的文件在当前租户仍发不回（云空间单文件上限约 20 MB），后续方案待用户决定；用户在终端确认机器人开的新会话出现在 `/resume` 列表；真实飞书试用 `/delete`。

- [规则](rules.md)：暂无。
- [项目简介](project-brief.md)：定位、功能及所属版本、术语。
- [架构](architecture.md)：本机运行环境与运维注意。
- [README](../README.md)、[core/README.md](../core/README.md)：指令、结构、接口、配置、部署与新模块接入的权威说明。

## 版本

- [V1.4](V1.4/iteration.md)：已在本机上线（Sophia 与 Cora 两个机器人），是否打标签待定。连接多个机器人（channel agent）、会话独占、按机器人配置会话 / 权限模式 / 模型范围。
- [V1.3](V1.3/iteration.md)：会话不分主次（取消默认会话与 `/exit`）；飞书卡片回复（模式、模型、context、额度、本轮 token）；撤回消息即中断；`/model`、`/effort`。
- [V1.2](V1.2/iteration.md)：多系统服务与 `doctor`、多用户、MIT、回复首行显示权限模式、改名 agent-connector；收发文件；单一会话列表、新会话放在 Claude Code 默认位置并可在终端 `/resume` 找到、自动起名、`/delete`；大文件经云空间发链接（受租户上限约束）、默认会话按名字称呼。
- [V1.1](V1.1/iteration.md)：`/compact`、`/rename`，飞书图片适配 `lark-cli` 1.0.98，失败时说明真实原因。
- [V1.0](V1.0/iteration.md)：可选会话、`auto` 默认与 `/mode`、`/usage`、拆分渠道与 Agent 模块、接入指南与模板。
