# agent-connector 项目入口

当前状态（2026-11-11）：V1.4 已推送到 `main` 并打标签 `V1.4`（`d307ca5`），2026-11-11 07:49（UTC）起在本机上线，见 [V1.4](V1.4/iteration.md)；此前的 V1.3（`af08fed`）见 [V1.3](V1.3/iteration.md)。飞书机器人 Sophia 和 Cora 以 Claude Code 在本机长期运行（同一个服务），运行环境见[架构](architecture.md)。V1.4 的多机器人与会话占用已由用户在真实飞书中试过；其余各版的用户验收未进行。

下一步：访问范围的限制（目录、权限模式名单、模型名单）待第一次实际配置时在真实飞书中确认；用户在飞书确认卡片效果、撤回中断、`/model` 与 `/effort`；超过 30 MB 的文件在当前租户仍发不回（云空间单文件上限约 20 MB），后续方案待用户决定；用户在终端确认机器人开的新会话出现在 `/resume` 列表；真实飞书试用 `/delete`。待用户答复：是否在仓库根目录加 `CLAUDE.md`，写一句“处理任务前先读 pjkp/index.md”（已问两次，2026-11-11 用户问这是做什么，已解释）；V1.4 记录里还有几项未决定的候选。

- [规则](rules.md)：暂无。
- [项目简介](project-brief.md)：定位、功能及所属版本、术语。
- [架构](architecture.md)：本机运行环境与运维注意。
- [README](../README.md)、[core/README.md](../core/README.md)：指令、结构、接口、配置、部署与新模块接入的权威说明。

## 版本

- [V1.4](V1.4/iteration.md)：多个机器人共用一个 Agent、一个会话同一时间只属于一个机器人、按机器人限定会话 / 权限模式 / 模型范围、同一会话上的任务排队。
- [V1.3](V1.3/iteration.md)：会话不分主次（取消默认会话与 `/exit`）；飞书卡片回复（模式、模型、context、额度、本轮 token）；撤回消息即中断；`/model`、`/effort`。
- [V1.2](V1.2/iteration.md)：多系统服务与 `doctor`、多用户、MIT、回复首行显示权限模式、改名 agent-connector；收发文件；单一会话列表、新会话放在 Claude Code 默认位置并可在终端 `/resume` 找到、自动起名、`/delete`；大文件经云空间发链接（受租户上限约束）、默认会话按名字称呼。
- [V1.1](V1.1/iteration.md)：`/compact`、`/rename`，飞书图片适配 `lark-cli` 1.0.98，失败时说明真实原因。
- [V1.0](V1.0/iteration.md)：可选会话、`auto` 默认与 `/mode`、`/usage`、拆分渠道与 Agent 模块、接入指南与模板。
