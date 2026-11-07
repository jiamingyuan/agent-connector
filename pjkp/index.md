# agent-connector 项目入口

当前状态（2026-11-07，核对提交 `b3b6e05`）：项目已改名 agent-connector（原 lark-agent-bridge），GitHub 仓库由用户改名。V1.1 之后的多系统兼容、`doctor`、多用户、MIT 许可证、回复首行显示权限模式和改名已上线并推送到 `main`，未打版本标签；接收文件和把文件发回飞书也已推送，见 [Unreleased](Unreleased/iteration.md)。飞书机器人 Sophia 以 Claude Code 在本机长期运行，运行环境见[架构](architecture.md)。用户验收未进行。

下一步：用户通过真实飞书收发文件验证；待用户为 Unreleased 命名版本。GitHub 仓库已由用户改名为 agent-connector。

- [规则](rules.md)：暂无。
- [项目简介](project-brief.md)：定位、功能及所属版本、术语。
- [架构](architecture.md)：本机运行环境与运维注意。
- [README](../README.md)、[core/README.md](../core/README.md)：指令、结构、接口、配置、部署与新模块接入的权威说明。

## 版本

- [Unreleased](Unreleased/iteration.md)：进行中，未命名。多系统兼容、`doctor`、多用户、MIT、回复首行显示权限模式。
- [V1.1](V1.1/iteration.md)：`/compact`、`/rename`，飞书图片适配 `lark-cli` 1.0.98，失败时说明真实原因。
- [V1.0](V1.0/iteration.md)：可选会话、`auto` 默认与 `/mode`、`/usage`、拆分渠道与 Agent 模块、接入指南与模板。
