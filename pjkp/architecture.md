# agent-connector 架构

核对：2026-11-11，[V1.3](V1.3/iteration.md)。模块结构、接口、配置和各系统的部署方式以 [README](../README.md) 和 [core/README.md](../core/README.md) 为准；这里只写本机实例的运行环境，以及源码和 README 表达不了的注意事项。

## 运行环境（本机实例）

- 2026-11-10 起 Sophia 运行在宿主机上（原先在一个 Docker 容器里，那一份已停用；两份共用同一个飞书应用，不能同时运行）。2026-11-11 起同一个服务接两个飞书机器人 Sophia 和 Cora（`config.json` 的 `bots`，各用一个 `lark-cli` 配置档，设置相同）。以 systemd 系统服务 `agent-connector` 运行，开机自启；日志用 `node service.mjs logs` 查看，不再写入 `runtime/bridge.log`。
- 是否在运行以 `node service.mjs status` 为准：进程被强杀或主机重启后，`runtime/status.json` 可能仍写着 `ready: true`。
- `config.json` 只在本机，不进仓库。
- 飞书私聊可能用 `/switch` 接在终端正在用的 Claude Code 会话上，飞书那边的 Agent 也会改这个仓库，终端会话看不到这些改动。

## 运维注意

- 飞书回合里的 Agent 本身是桥接进程的子进程。在飞书会话里直接 `node service.mjs restart` 会中断这一轮；应由脱离当前进程组的后台脚本等 `runtime/status.json` 中 `active`、`queued`、`pendingReplies` 都为 0 后再重启，并在新进程未就绪时退回上一版。在终端里重启前也先确认空闲。不要再用 `node bridge.mjs` 前台运行同一配置。
- 从 Claude Code 会话或 VS Code 终端启动服务时，会继承该会话和 VS Code 的环境变量。Claude Code 会话身份变量由 `bridge.mjs` 在启动 Agent 前清除；但 VS Code 的 git 凭证助手经 `REMOTE_CONTAINERS_IPC` 工作，VS Code 断线后 `git push` 会卡住。推送改用已登录的 gh：`git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push`。
- 本机没有全局 git 身份，提交时沿用历史提交的身份：`-c user.name=jiamingyuan -c user.email=86648456+jiamingyuan@users.noreply.github.com`。
- Claude Code 或 `lark-cli` 升级后运行 `node service.mjs doctor`；这版代码验证过的版本记在 `service/doctor.mjs` 的 `TESTED`。
