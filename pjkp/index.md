# agent-connector 项目入口

当前状态（2026-11-09）：V1.2 已推送到 `main`（标签 `V1.2` 在 `d164721`，其后的大文件经云空间发回与默认会话改名随 `971f54b` 推送、沿用 V1.2，见 [V1.2](V1.2/iteration.md)）。飞书机器人 Sophia 以 Claude Code 在本机长期运行，运行环境见[架构](architecture.md)。用户验收未进行。

会话不再分主次（取消默认会话与 `/exit`），已推送（`b21fbf0`，版本号未定），见 [Unreleased](Unreleased/iteration.md)。

下一步：超过 30 MB 的文件在当前租户仍发不回（云空间单文件上限约 20 MB），后续方案待用户决定；用户在终端确认机器人开的新会话出现在 `/resume` 列表；真实飞书试用 `/delete`。

- [规则](rules.md)：暂无。
- [项目简介](project-brief.md)：定位、功能及所属版本、术语。
- [架构](architecture.md)：本机运行环境与运维注意。
- [README](../README.md)、[core/README.md](../core/README.md)：指令、结构、接口、配置、部署与新模块接入的权威说明。

## 版本

- [Unreleased](Unreleased/iteration.md)：进行中，未命名。会话不分主次。
- [V1.2](V1.2/iteration.md)：多系统服务与 `doctor`、多用户、MIT、回复首行显示权限模式、改名 agent-connector；收发文件；单一会话列表、新会话放在 Claude Code 默认位置并可在终端 `/resume` 找到、自动起名、`/delete`；大文件经云空间发链接（受租户上限约束）、默认会话按名字称呼。
- [V1.1](V1.1/iteration.md)：`/compact`、`/rename`，飞书图片适配 `lark-cli` 1.0.98，失败时说明真实原因。
- [V1.0](V1.0/iteration.md)：可选会话、`auto` 默认与 `/mode`、`/usage`、拆分渠道与 Agent 模块、接入指南与模板。
