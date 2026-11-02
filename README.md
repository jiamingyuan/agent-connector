# lark-agent-bridge

通过飞书官方 `lark-cli` 接收消息，调用本机 Codex 或 Claude Code，再以飞书机器人身份回复。桥接程序为每个聊天保存独立的会话关联，并通过 CLI 的会话 ID 恢复上下文。

## 功能

- 默认只处理配置中指定用户的私聊；可选择允许该用户在群聊中真实 @机器人。群聊、私聊和不同群分别保存会话；同一群的不同话题共用会话。
- 同一聊天的任务串行执行，使用消息 ID 去重；未发送成功的回复会进入本地队列并重试。
- 开始处理时尝试在原消息上添加敬礼表情；失败不会中断任务。支持普通文本回复和 Claude Code 的 Markdown 富文本回复。
- Claude Code 后端支持接收图片或图文消息：每条最多 4 张，单张最大 5 MiB、总计最大 6 MiB，支持 JPEG、PNG、GIF 和 WebP。Codex 后端目前接收文本。
- 提供 `/new`、`/status`、`/stop` 和 `/help`；群聊中需要先通过飞书 @选择器选中机器人。`/stop` 停止当前任务并清空该聊天的排队消息，已经执行的操作不会自动撤销。

## 前置条件

- Node.js 20 或更新版本，以及已登录的 [飞书 CLI](https://github.com/larksuite/cli)。
- 已创建并启用飞书机器人，为其配置长连接事件订阅 `im.message.receive_v1`，并开通接收消息、发送消息等相应权限。群聊和图片功能还需要对应的群消息和资源读取权限；按实际功能在飞书开放平台检查权限与发布状态。
- 已安装并登录 Codex 或 Claude Code，且 Agent 所在环境能够访问指定工作区。
- 确认运行进程可执行配置中的 CLI 路径，并具有工作区的读写权限。模型、API 凭证和 Agent 登录信息沿用运行环境已有的配置。

## 配置和运行

复制对应示例为 `config.json`，根据实际环境填写飞书 profile、允许使用机器人的用户 open ID、CLI 路径与工作区。示例中的值均为占位符；不要将真实配置或凭证提交到仓库。

```bash
# Codex
cp config.example.json config.json

# 或使用 Claude Code
cp config.claude.example.json config.json
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `backend` | `codex` 或 `claude`；省略时使用 Codex。 |
| `profile` | 飞书 CLI 的应用 profile。 |
| `ownerOpenId` | 唯一允许向机器人发出请求的用户 open ID。 |
| `botName` | 机器人展示名称，用于回复和说明。 |
| `larkBin` / `codexBin` / `claudeBin` | 对应可执行文件路径；只需为所选后端填写对应 Agent 路径。 |
| `workspace` | Agent 使用的绝对路径；Claude Code 下载的图片也保存在该工作区。 |
| `maxEventAgeMs` | 接受消息的最大年龄，单位毫秒。 |
| `turnTimeoutMs` | 单条任务的最大运行时间，单位毫秒。 |
| `allowGroupMentions` / `botOpenId` | 群聊功能默认关闭；开启时须提供当前机器人正确的 open ID，并在飞书启用相应事件权限。 |
| `replyFormat` | 设置为 `markdown` 时，最终答案使用飞书富文本回复；未设置时使用纯文本。 |
| `claudePermissionMode` | Claude Code 默认为 `dontAsk`；也可设置 `bypassPermissions`，后者会跳过权限确认，请自行评估运行环境。可通过 `claudeAllowedTools` 配置允许的工具列表。 |

运行：

```bash
node bridge.mjs
```

桥接程序会在源码目录下创建 `runtime/` 保存进程锁、状态、会话映射和待发送回复；该目录包含私人数据。不要为同一配置同时启动多个桥接进程。按 `Ctrl+C` 停止后可再次启动；重启不会自动重跑中途退出的任务。

Codex 调用使用 `workspace-write` 沙箱和不交互审批策略；`skip_host_skill_discovery` 是 Codex CLI 开发中功能，CLI 版本变化后需验证兼容性。Claude Code 的工具访问取决于所选权限模式、配置及运行用户实际权限。

## 服务脚本

仓库提供 macOS LaunchAgent 辅助脚本，但它们包含原部署环境的路径和服务标签假设，使用前必须检查并按自己的环境调整：

- `service.mjs` 面向本机 Codex，`install` 会复制源码和配置、设置专用工作区并启动服务。
- `container-service.mjs`、`container-runner.mjs` 和 `container-start.sh` 面向特定 Docker 容器布局、容器用户和受保护的服务环境文件。它们不是通用容器安装器；请先核对 Docker 可执行文件、容器名称、路径、用户 ID 和启动凭证的配置。

两套脚本都支持 `install`、`status`、`start`、`stop` 和 `restart`；重新安装或重启会中断正在执行的任务。建议先用前台方式验证配置，再按需要部署服务。

容器脚本的 `install` 从 `config.claude.json` 和 `workspace/CLAUDE.md` 读取部署配置。全新安装时，可分别从 `config.claude.example.json` 和 `workspace/CLAUDE.example.md` 复制、修改这些文件；如已有文件，请先检查后再操作，避免覆盖现有设置。`workspace/CLAUDE.md` 是 Agent 的本地指引，不纳入版本控制。

## 测试

```bash
npm test
```

测试使用 Node.js 内置测试框架和模拟 CLI，覆盖消息过滤、会话隔离、超时和取消、回复拆分、图片处理与后端协议。测试不依赖真实飞书消息或数据库。

## 参考

- [飞书 CLI](https://github.com/larksuite/cli)
- [飞书 CLI 事件说明](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)
- [Claude Code 程序化调用](https://code.claude.com/docs/en/headless)
