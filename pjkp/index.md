# agent-connector 项目入口

当前状态（2026-11-07）：V1.2 已提交、打标签并推送到 `main`（核对提交见 [V1.2](V1.2/iteration.md)）。飞书机器人 Sophia 以 Claude Code 在本机长期运行，运行环境见[架构](architecture.md)。用户验收未进行。

下一步：用户在终端确认机器人开的新会话出现在 `/resume` 列表；真实飞书收发文件、试用 `/delete`；发回超过 30 MB 的文件的方式待用户决定。

- [规则](rules.md)：暂无。
- [项目简介](project-brief.md)：定位、功能及所属版本、术语。
- [架构](architecture.md)：本机运行环境与运维注意。
- [README](../README.md)、[core/README.md](../core/README.md)：指令、结构、接口、配置、部署与新模块接入的权威说明。

## 版本

- [V1.2](V1.2/iteration.md)：多系统服务与 `doctor`、多用户、MIT、回复首行显示权限模式、改名 agent-connector；收发文件；单一会话列表、新会话放在 Claude Code 默认位置并可在终端 `/resume` 找到、自动起名、`/delete`。
- [V1.1](V1.1/iteration.md)：`/compact`、`/rename`，飞书图片适配 `lark-cli` 1.0.98，失败时说明真实原因。
- [V1.0](V1.0/iteration.md)：可选会话、`auto` 默认与 `/mode`、`/usage`、拆分渠道与 Agent 模块、接入指南与模板。
