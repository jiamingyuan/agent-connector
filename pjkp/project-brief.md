# agent-connector 项目简介

记录：2026-11-11，对应 [V1.4](V1.4/iteration.md)。功能、配置、命令和部署细节以 [README](../README.md) 为准；各项的用户原话、决定状态与验证见对应版本记录。

## 项目介绍

### 项目定位

通过飞书官方 `lark-cli` 接收消息，调用本机 Claude Code 或 Codex，再以飞书机器人身份回复。当前实例是机器人 Sophia 和 Cora：Claude Code，只处理指定用户的私聊。

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
| 可选会话 `/sessions`、`/switch`，进入时发前情梗概 | [V1.0](V1.0/iteration.md)；单一列表见 [V1.2](V1.2/iteration.md)；会话不分主次、取消 `/exit` 见 [V1.3](V1.3/iteration.md) |
| 新会话放在 Claude Code 默认位置并可在终端 `/resume` 找到；自动起名；`/delete` 删除会话（移到回收目录） | [V1.2](V1.2/iteration.md) |
| 默认权限模式 `auto`，`/mode` 按聊天切换；每条回复首行显示会话名与模式 | [V1.0](V1.0/iteration.md)；首行显示见 [V1.2](V1.2/iteration.md) |
| `/model`、`/effort` 按聊天切换模型和推理深度（Agent 可选功能，Claude Code 与 Codex 已接） | [V1.3](V1.3/iteration.md) |
| 飞书卡片回复：标题区显示会话名、权限模式、模型与推理深度、context，正文上方是额度，底部是本轮用时与 token | [V1.3](V1.3/iteration.md) |
| 撤回消息即中断：正在处理的停止、排队的跳过、不再回复 | [V1.3](V1.3/iteration.md) |
| 多个机器人共用一个 Agent：一个会话同一时间只属于一个机器人；按机器人限定会话、权限模式、模型的范围；同一会话上的任务排队执行 | [V1.4](V1.4/iteration.md) |
| `/usage` 查询订阅用量 | [V1.0](V1.0/iteration.md) |
| `/compact`、`/rename`；失败时回复真实原因 | [V1.1](V1.1/iteration.md) |
| 服务管理：Linux（systemd）、macOS（LaunchAgent）、Windows 与其他环境内置守护进程；`doctor` 检查 | [V1.2](V1.2/iteration.md)，此前只支持 Debian；Windows 见 [Unreleased](Unreleased/iteration.md) |
| 接收文件消息（随下一条消息交给 Agent，可读类型见 README）；Agent 存进发件目录的文件随回答发回，超过 30 MB 的经云空间发链接（受租户单文件上限约束） | [V1.2](V1.2/iteration.md) |
| 多个授权用户 `ownerOpenIds` | [V1.2](V1.2/iteration.md) |
| MIT 许可证 | [V1.2](V1.2/iteration.md) |

## 术语

| 名称 | 当前含义 |
| --- | --- |
| 当前会话 | 每个聊天正在用的 Claude Code 会话；`/new` 新建（在 `sessionDir`，默认运行用户主目录），`/switch` 换成本机任一会话，各会话不分主次（见 [V1.3](V1.3/iteration.md)；V1.2 及以前有“默认会话 / 进入的会话”之分） |
| 前情梗概 | 进入会话时发送的摘要，在原会话的临时分支上生成，不写入任何会话记录 |
| 渠道（channel） | 消息接收端，如飞书；目录 `<名称>-channel/` |
| Agent 适配器（agent） | 运行对话的一端，如 Claude Code、Codex；目录 `<名称>-agent/` |
| 中枢（hub） | `core/`，连接两端，负责排队、发件箱、状态和指令 |
| 机器人（bot） | 某个渠道上的一个机器人身份，例如一个飞书应用；用户也称 channel agent。一个服务可以接多个，共用同一个 Agent（见 [V1.4](V1.4/iteration.md)） |
| 权限模式 | Claude Code 的 `--permission-mode`。桥接程序始终带 `--permission-prompts none`，需要确认的操作一律拒绝 |
