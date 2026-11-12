# agent-connector 项目入口

当前状态（2026-11-12）：V1.5 已推送到 `main` 并打标签 `V1.5`（`a8ed4b6`），2026-11-12 12:15（UTC）起在本机上线，见 [V1.5](V1.5/iteration.md)。飞书机器人 Sophia 和 Cora 以 Claude Code 在本机长期运行（同一个服务），运行环境见[架构](architecture.md)。每个功能在每个模块上是否开发、是否在真实环境测过，以 README 的“功能与模块”表为准；2026-11-12 用真实的 Claude Code 和真实的飞书（Sophia）跑过接入测试的测试项，全部通过。

下一步：在真实飞书里走一遍 `/test all` 和 `/temp`、`/keep`（聊天里的流程只有模拟测试）；Codex 模块待用真实 Codex 逐项确认；Windows 适配待在真实 Windows 机器上试（真实 `lark-cli`、Claude Code、登录自启）；访问范围的限制（目录、权限模式名单、模型名单）、群聊 @、多个授权用户待第一次实际配置时确认；超过 30 MB 的文件在当前租户仍发不回（云空间单文件上限约 20 MB），后续方案待用户决定。待用户答复：是否在仓库根目录加 `CLAUDE.md`，写一句“处理任务前先读 pjkp/index.md”（已问三次，2026-11-11 用户问这是做什么，已解释）；V1.4 记录里还有几项未决定的候选。

- [规则](rules.md)：新功能同时覆盖所有已有模块并测试；README 的“功能与模块”表记录每个功能在每个模块上的状态。
- [项目简介](project-brief.md)：定位、功能及所属版本、术语。
- [架构](architecture.md)：本机运行环境与运维注意。
- [README](../README.md)、[core/README.md](../core/README.md)：指令、结构、接口、配置、部署与新模块接入的权威说明。

## 版本

- [V1.5](V1.5/iteration.md)：`/delete` 一次删除多个会话；Windows 适配；补全 Codex 模块；接入测试 `/test`；项目规则与 README 的功能模块表；临时会话 `/temp`、`/keep`。
- [V1.4](V1.4/iteration.md)：多个机器人共用一个 Agent、一个会话同一时间只属于一个机器人、按机器人限定会话 / 权限模式 / 模型范围、同一会话上的任务排队。
- [V1.3](V1.3/iteration.md)：会话不分主次（取消默认会话与 `/exit`）；飞书卡片回复（模式、模型、context、额度、本轮 token）；撤回消息即中断；`/model`、`/effort`。
- [V1.2](V1.2/iteration.md)：多系统服务与 `doctor`、多用户、MIT、回复首行显示权限模式、改名 agent-connector；收发文件；单一会话列表、新会话放在 Claude Code 默认位置并可在终端 `/resume` 找到、自动起名、`/delete`；大文件经云空间发链接（受租户上限约束）、默认会话按名字称呼。
- [V1.1](V1.1/iteration.md)：`/compact`、`/rename`，飞书图片适配 `lark-cli` 1.0.98，失败时说明真实原因。
- [V1.0](V1.0/iteration.md)：可选会话、`auto` 默认与 `/mode`、`/usage`、拆分渠道与 Agent 模块、接入指南与模板。
