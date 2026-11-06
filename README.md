# agent-connector

把聊天平台上的消息交给本机的编码 Agent 处理，再以机器人身份回复。当前支持的消息渠道是飞书（通过官方 `lark-cli`），Agent 是 Claude Code 或 Codex；渠道和 Agent 都是可替换的模块，可以按[接口](#架构与接口)扩展到 Slack、微信等。

- 只处理配置中指定用户（owner，可配置多人）的消息：默认只收私聊，可选择允许他们在群聊中真实 @机器人。
- 每个聊天有独立的 Agent 会话，通过会话 ID 续接上下文；私聊、各个群互不读取。同一聊天的消息串行执行，按消息 ID 去重；没发出去的回复存在本地，自动重试。
- 开始处理时在原消息上加一个敬礼表情。Claude Code 支持图片和图文消息（每条最多 4 张，单张 5 MiB、合计 6 MiB 以内，JPEG/PNG/GIF/WebP），支持飞书 Markdown 富文本回复；Codex 目前只收文字。

## 指令

私聊里直接发送；群聊里先用飞书 @选择器选中机器人，再发指令。

| 指令 | 作用 | 处理时机 | 适用范围 |
| --- | --- | --- | --- |
| `/help` | 列出当前可用的指令 | 排队 | 全部 |
| `/status` | 机器人、Agent、连接状态、当前任务、权限模式、当前会话与会话 ID、工作区 | 立即 | 全部 |
| `/stop` | 停止当前任务，并清空这个聊天里排队的消息；已执行的操作不会撤销，会话上下文保留 | 立即 | 全部 |
| `/new` | 开启新的 workspace 会话；如果在其他会话里，先退出 | 排队 | 全部 |
| `/mode [模式名]` | 不带参数时查看当前权限模式和全部选项，带参数时切换（见[权限模式](#权限模式)） | 排队 | Claude Code |
| `/rename [名称]` | 重命名当前会话（workspace 会话或 `/switch` 进入的会话）；不写名称时根据对话内容自动生成。进入的会话改名后，回复首行的会话名、`/sessions` 列表和终端的会话列表都会用新名字；workspace 会话的名字显示在回复首行和 `/status`。调用 Claude Code 自带的 `/rename` | 排队 | Claude Code |
| `/compact [要点]` | 压缩当前会话的上下文（workspace 会话或 `/switch` 进入的会话），回复压缩前后的 token 数；会话 ID 不变，之后的消息基于压缩后的摘要继续。可附上摘要里要保留的重点，如 `/compact 保留 newdash 的设计决定`。调用 Claude Code 自带的 `/compact` | 排队 | Claude Code |
| `/usage` | 查询 Claude 订阅用量：当前会话窗口和本周的用量百分比与重置时间。调用本机 Claude Code 自带的 `/usage`，不消耗模型调用，也不保存会话 | 立即 | Claude Code |
| `/sessions [all \| 关键词]` | 列出本机可切换的会话（见[切换会话](#切换会话)） | 立即 | Claude Code，仅私聊 |
| `/switch 编号` | 进入列表中的会话，先收到前情梗概；也可写会话 ID 开头几位或完整会话名 | 排队 | Claude Code，仅私聊 |
| `/exit` | 退出当前会话，回到 workspace 会话 | 排队 | Claude Code，仅私聊 |

- **立即**：马上回复，不等正在运行的任务。**排队**：和普通消息按发送顺序执行，排在它前面的消息不受影响。
- `/compact` 用于会话变长或切换话题前主动压缩，也可以指定摘要里要保留的重点。
- Claude 返回错误时（例如订阅额度用完），回复里会给出原因；额度用完时会提示用 `/usage` 查看重置时间。
- 不以这些指令开头的文字、图片都会交给 Agent。一条消息不超过 40,000 字；同时排队超过 20 条时会请你稍后再发。
- 当前 Agent 不支持的指令（例如 Codex 下的 `/mode`）会回复说明，不会转给 Agent。

## 权限模式

Claude Code 默认使用 `auto` 模式。`config.json` 的 `claudePermissionMode` 设置默认值，`/mode` 按聊天临时切换：

| 模式 | 说明 |
| --- | --- |
| `auto`（默认） | Claude Code 逐个检查操作的风险和提示注入，常规操作直接执行，高风险操作会被拦下。需要账号套餐支持 auto 模式；检查服务不可用时，需要检查的操作会被拒绝。 |
| `dontAsk` | 只执行预先允许的工具（`claudeAllowedTools` 和 Claude Code 设置里的允许规则），其他一律拒绝。 |
| `acceptEdits` | 自动接受文件编辑，其他需要确认的操作会被拒绝。 |
| `plan` | 只调研并给出方案，不改文件、不执行命令。方案存到 `~/.claude/plans/`；确认后切回 `auto` 再让它执行。 |
| `bypassPermissions` | 跳过所有权限检查，可以不经确认执行任何操作，风险最高。群聊里不能切换到这个模式。 |

- 每条回复的首行都标出当前模式，例如 `**workspace** -- auto mode`；`bypassPermissions` 显示为 `⚠️ bypassPermissions mode`，开着时一眼能看出来。
- 模式名不区分大小写，`bypassPermissions` 可简写为 `bypass`。
- 切换只影响当前聊天，保存在 `runtime/state.json`，重启后保留；切回默认模式时清除该聊天的设置，之后跟随 `config.json`。
- 桥接程序始终带 `--permission-prompts none` 运行：没有人在场确认，所以任何需要确认的操作都会被拒绝，其余由权限模式决定。

## 切换会话

私聊默认使用 workspace 会话，也就是桥接程序在工作区里为这个聊天创建的会话。也可以进入本机其他 Claude Code 会话，例如终端里开过的项目会话，从手机接着用。

- `/sessions` 列出最近 10 个在终端或 IDE 里开启的会话，显示会话名、目录、最近活动，并标注“终端打开中 / 终端执行中”。`/sessions all` 包括 `claude -p` 脚本会话，`/sessions 关键词` 按名称、目录或 ID 筛选。工作区自己的会话不在列表里，用 `/exit` 回去。
- 会话名依次取 `/rename` 设置的名称、Claude Code 自动生成的标题、第一条提问。
- 机器人发出的每条消息首行都是当前会话名和权限模式，例如 `**agent-connector** -- auto mode`，换行后是回复内容；纯文本回复格式下写成 `【会话名】 -- auto mode`。workspace 会话显示为 `workspace`（改名后显示新名字）。
- 前情梗概在原会话的临时分支上生成（`--fork-session --no-session-persistence`，不带工具和 MCP），不写入任何会话记录；生成失败时改发最近一轮提问和回复的摘录。
- 之后的消息用 `--resume` 续接原会话，并在会话自己的目录中运行，所以对话会写进这个会话的记录，之后在终端用 `claude --resume <会话 ID>` 打开即可接上。权限按这个聊天当前的权限模式和 `claudeAllowedTools`，读取的是该项目自己的 `CLAUDE.md` 和设置。
- 会话正在终端执行任务时，不能切换进入，也不会执行发来的消息，以免两个进程同时写同一会话。终端只是打开着（空闲）时可以进入，但新对话不会出现在那个终端窗口：回终端继续前，先退出那个窗口，再用 `claude --resume` 重新打开。
- 会话列表读取 `~/.claude/projects/`，终端状态读取 `~/.claude/sessions/<pid>.json`（设置了 `CLAUDE_CONFIG_DIR` 时改用该目录）。两者都是 Claude Code 的内部格式，读不到时只会少列会话或少标注终端状态。

## 架构与接口

```text
消息渠道 channel  ──消息──▶  中枢 hub  ──一轮对话──▶  Agent 适配器 agent
lark-channel/     ◀──回复──  core/     ◀──最终回答──  claude-code-agent/、codex-agent/
```

| 目录 | 职责 |
| --- | --- |
| `bridge.mjs` | 入口：读 `config.json`，按 `channel` 和 `agent` 从 `core/registry.mjs` 加载模块，清理子进程环境变量，取得进程锁，启动中枢。 |
| `core/` | 中枢 `hub.mjs`：按聊天排队、去重、回复发件箱与重试、聊天状态，以及上面全部指令。`cli-turn.mjs` 是命令行类 Agent 共用的进程运行器，`text.mjs` 负责回复拆分和会话名标题。不含任何渠道或 Agent 的细节。 |
| `lark-channel/` | 飞书：`lark-cli` 长连接收 `im.message.receive_v1`、过滤非 owner 和过期消息、去掉 @机器人、发回复、加表情、下载图片。`lark-cli` 1.0.98 起拒绝把下载写到 `/root` 下，图片先下载到系统临时目录中的私有目录（700），检查格式和大小后复制到工作区 `attachments/`，再删除临时目录。 |
| `claude-code-agent/` | Claude Code：运行对话、权限模式、`/rename`、`/compact`、`/usage`、本机会话列表与前情梗概。 |
| `codex-agent/` | Codex：运行对话（仅文字），也是基于 `core/cli-turn.mjs` 的最小命令行 Agent 示例。 |
| `service.mjs`、`service/` | 服务管理（systemd / launchd / 内置守护进程）与 `doctor` 检查，见[长期运行](#长期运行linux--macos)。 |
| `example-agent/` | 模板：不依赖外部程序的回声 Agent，复制改名即可开始接入；也可配置 `"agent": "example"` 不花模型额度地测试渠道。 |

中枢只通过下面两个接口和两端交互。下面是摘要；**接入新模块时请读 [core/README.md](core/README.md)**，那里有接入步骤、每个参数和返回值的含义、可选功能的字段、配置与测试约定。

**渠道接口**：负责收发消息，并把各平台的消息转换成统一格式交给中枢。

```js
{
  id, displayName,            // displayName 会出现在回复和提示词里，例如“飞书”
  richText, formatNote,       // 是否支持 Markdown；支持时附在每轮输入后的回复格式要求
  start({ message, ready, closed }), stop(),
  send(entry),                // { messageId, chatId, text, format: 'markdown' | 'text', key }
  isPermanentSendError(error),
  acknowledge(message),       // 表示已开始处理，不得抛错
  attachments(message),       // Agent 支持图片时下载：[{ path, mediaType, data }]
}
// 统一消息格式
{ id, chatId, chatType: 'private' | 'group', kind: 'text' | 'rich' | 'image' | 'other', text, raw }
```

**Agent 接口**：运行一轮对话并返回答案；可选能力存在时，中枢自动启用对应指令。

```js
{
  id, displayName, capabilities: { images },
  runTurn({ sessionId, cwd, text, images, mode, timeoutMs, turnKey, onSession }),  // → { cancel(), result }
  modes,               // 可选，启用 /mode
  usage, usageLabel,   // 可选，启用 /usage
  compact,             // 可选，启用 /compact
  rename,              // 可选，启用 /rename
  sessions,            // 可选，启用 /sessions、/switch、/exit
}
```

`runTurn` 的 `result` 解析为最终回答，取消后解析为 `null`，失败时拒绝为带 `code`（`startup` / `timeout` / `failed`）和面向用户提示的错误；`onSession(id)` 报告会话 ID，中枢保存后在下一轮作为 `sessionId` 传回。中枢在 `text` 里附上群聊范围、当前工作目录和渠道的回复格式要求，Agent 只按自己的协议送入。

### 扩展新模块

1. 复制 `example-agent/` 为 `<名称>-agent/`（渠道则新建 `<名称>-channel/`，参考 `lark-channel/`），在 `index.mjs` 导出 `requiredBins(config)` 和 `createAgent(config, context)` / `createChannel(config, context)`。
2. 在 `core/registry.mjs` 登记，`config.json` 里用 `agent` / `channel` 选择；模块自己的配置项放在 `config.json` 顶层，以模块名为前缀（如 `geminiBin`）。
3. 命令行类 Agent 直接用 `core/cli-turn.mjs` 的 `runCliTurn`，只需提供命令、标准输入和逐行事件解析函数。
4. `npm test`：`test/adapters.test.mjs` 自动检查接口；用 `test/harness.mjs` 的 `runBridge` 写端到端测试。详见 [core/README.md · 接入步骤](core/README.md#接入步骤)。

## 前置条件

- Node.js 20 或更新版本，以及已登录的 [飞书 CLI](https://github.com/larksuite/cli)。
- 已创建并启用飞书机器人，配置长连接事件订阅 `im.message.receive_v1`，并开通接收、发送消息等权限；群聊和图片功能还需要相应的群消息和资源读取权限。
- 已安装并登录 Claude Code 或 Codex，且 Agent 能访问指定工作区。运行进程须能执行配置中的 CLI 路径，并有工作区的读写权限。模型、API 凭证和 Agent 登录信息沿用运行环境已有的配置。

## 配置和运行

复制示例为 `config.json` 并填写实际值。示例中的值都是占位符；不要把真实配置或凭证提交到仓库。

```bash
cp config.claude.example.json config.json   # Claude Code
cp config.example.json config.json          # 或 Codex
```

| 字段 | 说明 |
| --- | --- |
| `agent` | `claude-code`、`codex` 或 `example`（模板回声 Agent）。旧字段 `backend`（`claude` / `codex`）仍然有效；都省略时使用 Codex。 |
| `channel` | 目前只有 `lark`，省略时即为 `lark`。 |
| `profile` | 飞书 CLI 的应用 profile。 |
| `ownerOpenId` / `ownerOpenIds` | 允许向机器人发出请求的用户 open ID：一个用 `ownerOpenId`，多个用数组 `ownerOpenIds`，可同时写。名单里的每个人都被完全信任：他们驱动同一个 Agent、拥有本机同样的权限，也能用 `/sessions` 看到并进入本机的 Claude Code 会话；每个人的私聊各有独立的会话。 |
| `botName` | 机器人展示名称，用于回复和说明。 |
| `larkBin` / `claudeBin` / `codexBin` | 对应可执行文件路径，只需填写所选模块用到的。 |
| `workspace` | Agent 的工作区绝对路径；收到的图片保存在其中的 `attachments/`。 |
| `maxEventAgeMs` | 接受消息的最大年龄，单位毫秒。 |
| `turnTimeoutMs` | 单条任务的最长运行时间，单位毫秒；前情梗概最多 5 分钟。 |
| `allowGroupMentions` / `botOpenId` | 群聊默认关闭；开启时须提供本机器人正确的 open ID，并在飞书启用相应事件权限。 |
| `replyFormat` | 设为 `markdown` 时用飞书富文本回复，否则用纯文本。 |
| `claudePermissionMode` | Claude Code 的默认权限模式，省略时为 `auto`，可选值见[权限模式](#权限模式)。 |
| `claudeAllowedTools` | Claude Code 预先允许的工具列表，例如 `["WebSearch", "WebFetch"]`。 |

前台运行：

```bash
node bridge.mjs
```

桥接程序在源码目录下的 `runtime/` 保存进程锁、状态、会话映射和待发送回复，该目录包含私人数据。不要为同一配置同时启动多个进程；重启不会自动重跑中途退出的任务。

Codex 使用 `workspace-write` 沙箱和不交互审批策略；`skip_host_skill_discovery` 是 Codex CLI 开发中功能，CLI 版本变化后需验证兼容性。

## 长期运行（Linux / macOS）

`service.mjs` 在源码目录原地运行桥接程序，崩溃或退出后自动重启，按系统选择服务方式：

| 系统 | 方式 | 开机/登录自启 | 日志 |
| --- | --- | --- | --- |
| Linux（有 systemd，任意发行版） | root 安装为系统服务 `/etc/systemd/system/agent-connector.service`；普通用户安装为用户服务 `~/.config/systemd/user/` | 是；用户服务要在注销后继续运行并随开机启动，需执行一次 `loginctl enable-linger <用户名>` | `journalctl [--user] -u agent-connector` |
| macOS | LaunchAgent `~/Library/LaunchAgents/com.agent-connector.plist`，退出后自动拉起 | 登录后启动 | `runtime/bridge.log` |
| 其他（Docker 容器、没有 systemd 的 Linux），或加 `--supervisor` | 内置守护进程（Node 实现） | 否，容器或机器重启后需再执行 `node service.mjs start` | `runtime/bridge.log` |

```bash
node service.mjs install    # 检查配置并安装、启动服务
node service.mjs status     # 服务方式、运行状态和 runtime/status.json
node service.mjs logs       # 跟踪日志
node service.mjs restart    # 修改代码或配置后重启
node service.mjs doctor     # 检查环境与依赖工具（见下）
node service.mjs stop | start | uninstall
```

- Windows 不直接支持，请在 WSL 里按 Linux 方式运行。
- 项目原名 lark-agent-bridge。用旧版本装过 systemd 服务或 LaunchAgent 的，先用旧版本执行 `node service.mjs uninstall`（或删除 `lark-agent-bridge.service` / `com.lark-agent-bridge.plist`），再用新版本 `install`。
- macOS 上 Node.js、`lark-cli`、`claude` 常装在 `/opt/homebrew/bin`，服务的 PATH 已包含它；`config.json` 里的可执行文件仍需写绝对路径（可用 `which claude` 查看）。
- 使用 Claude Code 且工作区没有 `CLAUDE.md` 时，安装会从 `workspace/CLAUDE.example.md` 复制一份，已有文件不会被覆盖。
- 重启或停止会中断正在执行的任务。不要再用 `node bridge.mjs` 前台运行同一配置。

### 升级依赖工具后：doctor

会话列表、终端状态、`/usage`、图片下载依赖 Claude Code 和 `lark-cli` 的内部格式，它们升级后可能变化。`node service.mjs doctor` 会检查：Node.js 版本、各可执行文件与版本（与这版代码验证过的版本不同时给出提醒）、工作区可写、Claude Code 会话记录还能读出多少、终端状态能否读取。有问题时以非 0 退出，可用于定时检查。它不输出配置值或任何会话内容。

## 测试

```bash
npm test
```

使用 Node.js 内置测试框架和模拟 CLI，不依赖真实飞书消息。覆盖消息过滤、会话隔离、超时和取消、回复拆分、图片处理、各 Agent 协议、指令（切换会话、权限模式、`/rename`、`/compact`、`/usage`）、新版 `lark-cli` 的图片格式，各系统的服务配置与 `doctor`，以及所有已登记模块是否满足接口。

## 参考

- [飞书 CLI](https://github.com/larksuite/cli)
- [飞书 CLI 事件说明](https://github.com/larksuite/cli/blob/main/skills/lark-event/SKILL.md)
- [Claude Code 程序化调用](https://code.claude.com/docs/en/headless)

## 许可证

[MIT](LICENSE)。
