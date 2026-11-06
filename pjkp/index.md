# agent-connector 项目入口

当前状态（2026-11-05，核对提交 `a798151`，即 V1.1）：V1.1 已发布到 GitHub（标签 `V1.1`）。之后的多系统兼容、`doctor`、多用户、MIT 许可证和回复首行显示权限模式已在本机上线，但未提交、未推送，见 [Unreleased](Unreleased/iteration.md)。飞书机器人 Sophia 以 Claude Code 在本机长期运行，运行环境见[架构](architecture.md)。用户验收未进行。

下一步：待用户为 Unreleased 命名版本，并决定是否提交、推送。

- [规则](rules.md)：暂无。
- [项目简介](project-brief.md)：定位、功能及所属版本、术语。
- [架构](architecture.md)：本机运行环境与运维注意。
- [README](../README.md)、[core/README.md](../core/README.md)：指令、结构、接口、配置、部署与新模块接入的权威说明。

## 版本

- [Unreleased](Unreleased/iteration.md)：进行中，未命名。多系统兼容、`doctor`、多用户、MIT、回复首行显示权限模式。
- [V1.1](V1.1/iteration.md)：`/compact`、`/rename`，飞书图片适配 `lark-cli` 1.0.98，失败时说明真实原因。
- [V1.0](V1.0/iteration.md)：可选会话、`auto` 默认与 `/mode`、`/usage`、拆分渠道与 Agent 模块、接入指南与模板。
