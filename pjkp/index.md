# lark-agent-bridge 项目入口

更新：2026-11-03。当前版本 [V1.0](V1.0/iteration.md)，在 `main` 维护，标签 `V1.0` 已推送到 GitHub（[jiamingyuan/lark-agent-bridge](https://github.com/jiamingyuan/lark-agent-bridge)）。项目由飞书渠道、中枢和 Agent 适配器（Claude Code、Codex、模板 example）组成；飞书机器人 Sophia 以 Claude Code 在本机长期运行（容器内没有 systemd，用 `service.mjs` 内置守护进程）。用户验收未进行。

- [规则](rules.md)：暂无。
- [项目简介](project-brief.md)：定位、现有能力、术语、已确认的决定与尚未确定的事项。
- [README](../README.md)：指令、架构、配置、部署与测试；新模块接入看 [core/README.md](../core/README.md)。

## 版本

- [V1.0](V1.0/iteration.md)：当前版本。可选会话、auto 默认与 `/mode`、`/usage`、拆分渠道与 Agent 模块、接入指南与模板、清理无用文件。
