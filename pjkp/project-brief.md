# agent-connector 项目简介

记录：2026-11-05，核对提交 `a798151` 加 [Unreleased](Unreleased/iteration.md) 中的改动。功能、配置、命令和部署细节以 [README](../README.md) 为准；各项的用户原话、决定状态与验证见对应版本记录。

## 项目介绍

### 项目定位

通过飞书官方 `lark-cli` 接收消息，调用本机 Claude Code 或 Codex，再以飞书机器人身份回复。当前实例是机器人 Sophia：Claude Code，只处理指定用户的私聊。

为什么做、服务谁之外的定位：待确认。

### 项目概要

消息渠道（收发消息）、中枢（排队、发件箱、聊天状态、指令）与 Agent 适配器（运行对话）通过接口连接，可以扩展到其他渠道和 Agent；接入步骤见 [core/README.md](../core/README.md)。

### 项目价值

- 待确认。实际用法：用户在飞书里切进本机终端中的 Claude Code 会话继续开发（2026-11-03 起）。

### 长期愿景

暂无用户提出的长期规划。

## 项目功能

| 功能 | 所属版本 |
| --- | --- |
| 每个聊天独立会话，串行执行、去重、回复失败重试；`/new`、`/status`、`/stop`、`/help`；Claude Code 收图片、Markdown 回复 | 首次导入起；图片适配 `lark-cli` 1.0.98 见 [V1.1](V1.1/iteration.md) |
| 渠道与 Agent 模块化、接入指南、`example-agent/` 模板 | [V1.0](V1.0/iteration.md) |
| 可选会话 `/sessions`、`/switch`、`/exit`，进入时发前情梗概 | [V1.0](V1.0/iteration.md) |
| 默认权限模式 `auto`，`/mode` 按聊天切换；每条回复首行显示会话名与模式 | [V1.0](V1.0/iteration.md)；首行显示见 [Unreleased](Unreleased/iteration.md) |
| `/usage` 查询订阅用量 | [V1.0](V1.0/iteration.md) |
| `/compact`、`/rename`；失败时回复真实原因 | [V1.1](V1.1/iteration.md) |
| 服务管理：Linux（systemd）、macOS（LaunchAgent）、其他环境内置守护进程；`doctor` 检查 | [Unreleased](Unreleased/iteration.md)，此前只支持 Debian |
| 多个授权用户 `ownerOpenIds` | [Unreleased](Unreleased/iteration.md) |
| MIT 许可证 | [Unreleased](Unreleased/iteration.md) |

## 术语

| 名称 | 当前含义 |
| --- | --- |
| workspace 会话 | 默认会话：桥接程序在 `config.workspace` 下为每个聊天创建并续接的 Claude Code 会话 |
| 选择的会话 | 用 `/switch` 进入的本机其他 Claude Code 会话，例如终端里开的会话；在该会话自己的目录中用 `--resume` 续接 |
| 前情梗概 | 进入会话时发送的摘要，在原会话的临时分支上生成，不写入任何会话记录 |
| 渠道（channel） | 消息接收端，如飞书；目录 `<名称>-channel/` |
| Agent 适配器（agent） | 运行对话的一端，如 Claude Code、Codex；目录 `<名称>-agent/` |
| 中枢（hub） | `core/`，连接两端，负责排队、发件箱、状态和指令 |
| 权限模式 | Claude Code 的 `--permission-mode`。桥接程序始终带 `--permission-prompts none`，需要确认的操作一律拒绝 |
