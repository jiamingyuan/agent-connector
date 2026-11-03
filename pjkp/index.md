# lark-agent-bridge 项目入口

更新：2026-11-03。用户要求“通过pjkp来管理lark-agent-bridge”，当日初始化。当前状态：飞书机器人 Sophia 以 Claude Code 后端在本机长期运行（容器内没有 systemd，用 `service.mjs` 内置守护进程）；`main` 停在 `827b30e`（2026-11-02，本地提交，比 `origin/main` 多 1 个，未推送），另有三项已上线但未提交的功能，见[当前接续](#当前接续)。尚未指定版本号。

- [规则](rules.md)：暂无。
- [项目简介](project-brief.md)：定位、现有能力、术语、已确认的决定与尚未确定的事项。
- [README](../README.md)：功能、配置、命令、部署与测试的权威说明。

## 版本

暂无。用户指定版本号后再建 Vx.x/iteration.md。

## 当前接续

2026-11-03 工作区有以下未提交改动，均在 827b30e 之上；改动前的完整工作区备份在 `/root/lark-agent-bridge-backup-20261103-prerefactor.tar.gz`。提交、推送与用户验收均未进行。

1. 可选会话：`/sessions`、`/switch`、`/exit`，用户要求见[简介 · 已确认的决定](project-brief.md#已确认的决定)。实际使用：2026-11-03 用户在飞书列出会话、切换进入并收到梗概、继续对话 4 轮，日志无报错（runtime/bridge.log）。
2. 默认权限模式改为 `auto`，新增 `/mode` 按聊天切换。本机 `config.json`（不进仓库）的 `claudePermissionMode` 已由 `dontAsk` 改为 `auto`。真实 Claude Code 2.1.317 无界面试跑：`auto` 直接执行了写文件和 `ls`，`plan` 只给方案、未改文件。
3. `/usage`：调用本机 Claude Code 自带的 `/usage` 查询订阅用量与重置时间。由 Sophia 在飞书会话中按用户要求实现（13:14:04 UTC 写入，含测试），服务随后于 13:14:59 重启；13:15 在飞书实际查询成功一次（runtime/bridge.log）。
4. 重构为渠道、中枢、Agent 三部分（用户原话见[简介 · 已确认的决定](project-brief.md#已确认的决定)）：`lark-channel/`、`claude-code-agent/`、`codex-agent/`、`core/`，入口仍是 `bridge.mjs`，接口与新增模块步骤见 [core/README.md](../core/README.md)。旧的 `core.mjs`、`backends.mjs`、`images.mjs`、`sessions.mjs` 已拆入各目录；`config.json` 的旧字段 `backend` 仍有效，`state.json` 格式不变。验证：`npm test` 37 项通过，原有集成测试未改断言即通过；用真实 `config.json` 加载模块正常。上线方式：Agent 在飞书会话中安排服务空闲后自动重启，新进程未就绪则自动恢复重构前代码（`runtime/refactor-deploy.log`）。

下一步：待用户指定版本号，并决定是否提交、推送。
