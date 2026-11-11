# agent-connector

把聊天平台上的消息交给本机的编码 Agent 处理，再以机器人身份回复。当前支持的消息渠道是飞书（通过官方 `lark-cli`），Agent 是 Claude Code 或 Codex；渠道和 Agent 都是可替换的模块，可以按[接口](#架构与接口)扩展到 Slack、微信等。

- 只处理配置中指定用户（owner，可配置多人）的消息：默认只收私聊，可选择允许他们在群聊中真实 @机器人。
- 每个聊天有独立的 Agent 会话，通过会话 ID 续接上下文；私聊、各个群互不读取。同一聊天的消息串行执行，按消息 ID 去重；几个聊天进了同一个会话时，这个会话上的任务也一个个执行，后来的等前一个结束；没发出去的回复存在本地，自动重试。
- 撤回一条消息，机器人就停止处理它：正在执行的任务被中断，还在排队的不再执行，也不再回复；已经做完的操作不会撤销，同一聊天里的其他消息照常处理。飞书上最多约 5 秒后生效。
- 开始处理时在原消息上加一个敬礼表情。Claude Code 支持图片和图文消息（每条最多 4 张，单张 5 MiB、合计 6 MiB 以内，JPEG/PNG/GIF/WebP），支持飞书 Markdown 富文本回复；Codex 目前只收文字。
- 可以发文件（PDF、文本、表格、文档等，单个最多 100 MiB），Agent 也能把改好或生成的文件发回来，见[文件](#文件)；语音、视频消息暂不支持。

## 指令

私聊里直接发送；群聊里先用飞书 @选择器选中机器人，再发指令。

| 指令 | 作用 | 处理时机 | 适用范围 |
| --- | --- | --- | --- |
| `/help` | 列出当前可用的指令 | 排队 | 全部 |
| `/status` | 机器人、Agent、连接状态、当前任务、权限模式、当前会话与会话 ID、工作区 | 立即 | 全部 |
| `/stop` | 停止当前任务，并清空这个聊天里排队的消息；已执行的操作不会撤销，会话上下文保留 | 立即 | 全部 |
| `/new` | 开启新会话：在 `sessionDir`（默认是主目录，与终端里的 Claude Code 会话同处）新建，不再放进本项目的 `workspace/`；如果在其他会话里，先退出 | 排队 | 全部 |
| `/mode [模式名]` | 不带参数时查看当前权限模式和全部选项，带参数时切换（见[权限模式](#权限模式)） | 排队 | Claude Code |
| `/model [名称]` | 不带参数时查看这个聊天使用的模型和可选项，带参数时切换；`/model default` 恢复默认。Claude Code 可写别名（`fable`、`opus`、`sonnet`、`haiku`）或完整模型名。从下一条消息开始生效，只影响这个聊天，重启后保留 | 排队 | Claude Code、Codex |
| `/effort [级别]` | 查看或切换推理深度（Claude Code：`low`、`medium`、`high`、`xhigh`、`max`）；`/effort default` 恢复默认。生效范围同 `/model` | 排队 | Claude Code、Codex |
| `/rename [名称]` | 重命名当前会话；不写名称时根据对话内容自动生成。改名后，回复首行的会话名、`/sessions` 列表和终端的会话列表都会用新名字。调用 Claude Code 自带的 `/rename` | 排队 | Claude Code |
| `/compact [要点]` | 压缩当前会话的上下文，回复压缩前后的 token 数；会话 ID 不变，之后的消息基于压缩后的摘要继续。可附上摘要里要保留的重点，如 `/compact 保留 newdash 的设计决定`。调用 Claude Code 自带的 `/compact` | 排队 | Claude Code |
| `/usage` | 查询 Claude 订阅用量：当前会话窗口和本周的用量百分比与重置时间。调用本机 Claude Code 自带的 `/usage`，不消耗模型调用，也不保存会话 | 立即 | Claude Code |
| `/sessions [all \| 关键词]` | 列出本机可切换的会话（见[切换会话](#切换会话)） | 立即 | Claude Code，仅私聊 |
| `/switch 编号` | 切换到列表中的任一会话，先收到前情梗概；也可写会话 ID 开头几位或完整会话名 | 排队 | Claude Code，仅私聊 |
| `/delete 编号` | 删除列表中的会话（终端开的也可以）：先回复会话信息，10 分钟内发 `/delete 编号 确认` 才删除。会话记录和同名文件夹移到 `runtime/trash/`（附 `restore.json` 说明移回哪里），之后 `/sessions` 和终端的 `/resume` 都不再显示。不能删当前所在的会话、终端里开着的会话和正在执行任务的会话；用过它的聊天下一条消息开新会话 | 排队 | Claude Code，仅私聊 |

- **立即**：马上回复，不等正在运行的任务。**排队**：和普通消息按发送顺序执行，排在它前面的消息不受影响。
- `/compact` 用于会话变长或切换话题前主动压缩，也可以指定摘要里要保留的重点。
- Claude 返回错误时（例如订阅额度用完），回复里会给出原因；额度用完时会提示用 `/usage` 查看重置时间。
- 不以这些指令开头的文字、图片都会交给 Agent。一条消息不超过 40,000 字；同时排队超过 20 条时会请你稍后再发。
- 当前 Agent 不支持的指令（例如 Codex 下的 `/mode`）会回复说明，不会转给 Agent。

## 文件

私聊里直接发文件即可，单个默认最多 100 MiB（`config.json` 的 `maxFileBytes` 可改，飞书实测可下载 88 MB 的文件）。机器人先回复“已收到文件……”，文件存到本机工作区的 `attachments/`。接着发一条消息说明要怎么处理，文件会随这条消息一起交给 Agent，由它用自己的工具读取。

- 文字和文件放在同一条消息里发（飞书富文本消息的附件）时，文件直接随这条消息交给 Agent，不需要再单独说明。
- 可以连发几个文件再一起说明，最多保留 10 个；`/status` 会显示待处理的文件数。
- 交付的那一轮失败（例如订阅额度用完）时，文件会保留到下一条消息。
- 进入其他会话（`/switch`）后也能用：Claude Code 会被授予读取附件目录的权限（`--add-dir`）。
- 文件夹请先压缩成 zip；语音消息、视频消息（不是以文件形式发送的）暂不支持。

### 发回文件

需要给你文件时（例如改好的幻灯片、生成的报告），Agent 把文件存到本轮专用的发件目录，回答发出后桥接程序再把文件逐个回复给你。每轮开始时提示里会写明这个目录，不用你指定。

- 30 MB 以内（飞书聊天的上传上限）作为文件发出；超过 30 MB、不超过 1 GiB 的上传到机器人的飞书云空间，给提问的用户开通可管理权限，再在聊天里发链接。云空间还受租户的单文件上传上限约束（2026-11-07 实测的租户为 20 MB，机器人和用户身份相同），超出时机器人回复原因，文件留在本机。空文件不发；每次回答最多发 5 个，多出的、超限的会在回复里说明，并留在本机工作区的 `outbox/`。
- 上传云空间需要在飞书开发者后台为应用开通权限 `drive:file:upload`、`drive:drive.metadata:readonly` 和 `docs:permission.member:create`；没开通时机器人会回复缺少的权限，文件留在本机。
- 只发普通文件，不发文件夹和链接；发送失败会和文字回复一样重试，发出后本机副本即删除。
- 只在这一轮成功完成后才发送；进入其他会话（`/switch`）后同样可用。

### 能读取哪些文件

各类文件能否读取（2026-11-06 用 Claude Code 2.1.318 实测，标注“未实测”的除外）：

| 文件 | 能否读取 | 说明 |
| --- | --- | --- |
| 纯文本类：txt、md、csv、json、日志、源代码等 | 可以 | Read 工具直接读取，任何权限模式都可以 |
| PDF | 可以 | Read 工具直接读取文字和页面 |
| 图片文件：PNG、JPEG、GIF、WebP | 可以 | Read 工具直接查看 |
| Word（.docx）、Excel（.xlsx）、zip | 通常可以 | Agent 要执行 `unzip` 一类的命令解开读取，需要权限模式允许执行命令（默认的 `auto` 可以，`plan`、`dontAsk` 下可能被拒），本机需装有 `unzip` |
| PowerPoint（.pptx） | 可以 | 实测读出每页标题、要点和表格，并按要求改文字、加列表项、改表格单元格后另存，原文件不变；同样需要允许执行命令的权限模式 |
| 旧版 Office（.doc、.xls、.ppt）及其他二进制格式 | 一般不行（未实测） | 本机没有对应的解析工具 |
| 音频、视频文件 | 不能理解内容 | 只能拿到文件本身，没有转写和抽帧 |

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

## 卡片回复

`replyFormat` 为 `card` 时，每条回复是一张飞书卡片：

- 标题区统一蓝色，标题是会话名；三个标签依次是权限模式（`bypassPermissions` 为红色并带 ⚠️）、模型全称和推理深度（如 `claude opus 5.5 - max`）、`context` 当前上下文大小（5 万以下绿色，5 万起橙色，20 万起红色）。
- 正文上方两行文字额度：5 小时额度和本周额度的剩余比例与重置时间（UTC），剩余比例 50% 以下橙色、20% 以下红色。
- 回答的最后一张卡片底部是本轮用时和 token：输出、新增输入（未缓存输入加写入缓存）、缓存读取；一轮里多次调用模型时为累计值，不含 auto 模式安全检查等附带调用。
- 这些数据都由机器人从 Claude Code 每轮的输出中读取，不增加 token；其他指令的回复显示最近一次的数据，`/switch` 后取那个会话最后一次回答时的模型和上下文。
- 飞书拒收卡片时，这条回复改用富文本发出。

## 切换会话

会话之间没有主次：每个聊天只有一个“当前会话”。`/new` 在 `sessionDir`（默认主目录）里开一个新会话，和终端里开的会话放在同一处；`/switch` 切换到本机任一 Claude Code 会话，包括机器人开的、终端里开的项目会话，切走的会话仍在列表里，随时可以切回。更早版本创建的会话仍在本项目的 `workspace/` 里续接。

- `/sessions` 把这个聊天自己的会话和其他会话放在同一个列表里，按最近活动排序，显示会话名、目录、最近活动，并标注“当前”“终端打开中 / 终端执行中”。默认列出终端或 IDE 里开启的会话和已命名的会话（桥接程序创建的会话第一次回答后会自动起名）；`/sessions all` 还会列出未命名的 `claude -p` 脚本会话，`/sessions 关键词` 按名称、目录或 ID 筛选。
- 会话名依次取 `/rename` 设置的名称、Claude Code 自动生成的标题、第一条提问。
- 机器人发出的每条消息首行都是当前会话名和权限模式，例如 `**agent-connector** -- auto mode`，换行后是回复内容；纯文本回复格式下写成 `【会话名】 -- auto mode`。新会话第一次回答后会自动起名（调用 Claude Code 自带的 `/rename`，根据对话生成，每个会话只起一次），之前显示为“新会话”；用 `/rename` 可以随时改。
- 前情梗概在原会话的临时分支上生成（`--fork-session --no-session-persistence`，不带工具和 MCP），不写入任何会话记录；生成失败时改发最近一轮提问和回复的摘录。
- 之后的消息用 `--resume` 续接原会话，并在会话自己的目录中运行，所以对话会写进这个会话的记录，之后在终端用 `claude --resume <会话 ID>` 打开即可接上。权限按这个聊天当前的权限模式和 `claudeAllowedTools`，读取的是该项目自己的 `CLAUDE.md` 和设置。
- 会话正在终端执行任务时，不能切换进入，也不会执行发来的消息，以免两个进程同时写同一会话。终端只是打开着（空闲）时可以进入，但新对话不会出现在那个终端窗口：回终端继续前，先退出那个窗口，再用 `claude --resume` 重新打开。
- 会话列表读取 `~/.claude/projects/`，终端状态读取 `~/.claude/sessions/<pid>.json`（设置了 `CLAUDE_CONFIG_DIR` 时改用该目录）。两者都是 Claude Code 的内部格式，读不到时只会少列会话或少标注终端状态。

## 多个机器人

一个 agent-connector 可以同时接多个机器人（每个是某个渠道上的一个机器人身份，例如一个飞书应用），它们共用同一个 Agent 和本机的会话。在 `config.json` 里加 `bots`，每项写这个机器人自己的设置，没写的沿用顶层：

```json
{
  "agent": "claude-code",
  "larkBin": "/absolute/path/to/lark-cli",
  "claudeBin": "/absolute/path/to/claude",
  "workspace": "/absolute/path/to/workspace",
  "bots": [
    { "name": "Assistant", "channel": "lark", "profile": "PROFILE_ONE", "ownerOpenId": "ou_USER_ID_IN_APP_ONE" },
    { "name": "Helper", "channel": "lark", "profile": "PROFILE_TWO", "ownerOpenId": "ou_USER_ID_IN_APP_TWO",
      "access": { "sessions": ["/srv/project"], "modes": ["auto", "plan"], "models": ["sonnet", "haiku"] } }
  ]
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 机器人的名字（即单机器人配置里的 `botName`），必填，用于回复、提示和日志。 |
| `id` | 可选，聊天状态里区分机器人用的标识，省略时用 `name`，不能含 `:`。改了它，这个机器人原有的聊天记录（当前会话、模式等）就对不上了。 |
| 其他字段 | `channel`、`profile`、`ownerOpenId` / `ownerOpenIds`、`botOpenId`、`allowGroupMentions`、`replyFormat`、`sessionDir` 等，凡是顶层能写的都可以按机器人覆盖。飞书里同一个人在不同应用下的 open ID 不同，授权用户要按机器人分别填。 |
| `access.sessions` | 这个机器人能列出、切换、删除和继续的会话：`"all"`（默认）、`"own"`（只限它自己开的）或目录列表（会话的工作目录在这些目录之内）。限定了目录时，新会话开在 `sessionDir`（在范围内时）或列表的第一个目录。 |
| `access.modes` | 能用的权限模式：`"all"`（默认）或名单。默认模式不在名单里时，这个机器人以名单第一项为默认。 |
| `access.models` | 能用 `/model` 选的模型：`"all"`（默认）或名单；规则同上。 |

- 飞书：每个机器人是一个应用，在 `lark-cli` 里各有一个配置档（`lark-cli profile add --name <名字> --app-id <App ID> --app-secret-stdin`），`profile` 填配置档的名字；每个应用都要开启机器人能力并订阅接收消息事件。两个应用可以同时监听（`lark-cli` 1.0.99 实测）。
- 每个机器人的聊天互相独立：各有各的当前会话、权限模式、模型和推理深度；同一个群里的两个机器人各自回复 @ 自己的消息。
- 一个会话同一时间只属于一个机器人：某个机器人的聊天正开着的会话，别的机器人 `/switch` 不进去、也删不掉，会提示“正由机器人 X 开着”。那边发 `/new` 或 `/switch` 离开后才能进入。同一个机器人的不同聊天之间没有这个限制，它们在同一个会话里的任务排队执行。
- 范围只限制机器人的指令能选什么，不是安全隔离：Agent 在本机的文件权限不变，被限定目录的机器人仍可以让 Agent 读写别处。
- 从单机器人配置改成 `bots` 时，原有的聊天状态归 `bots` 里的第一个机器人。
- `/status` 显示当前机器人的名字和它受限的范围；`runtime/status.json` 里多一项 `bots`，列出每个机器人是否连接正常。

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
| `codex-agent/` | Codex：运行对话（仅文字）、`/model`、`/effort`（这两项未用真实 Codex 验证），也是基于 `core/cli-turn.mjs` 的最小命令行 Agent 示例。 |
| `service.mjs`、`service/` | 服务管理（systemd / launchd / 内置守护进程）与 `doctor` 检查，见[长期运行](#长期运行linux--macos)。 |
| `example-agent/` | 模板：不依赖外部程序的回声 Agent，复制改名即可开始接入；也可配置 `"agent": "example"` 不花模型额度地测试渠道。 |

中枢只通过下面两个接口和两端交互。下面是摘要；**接入新模块时请读 [core/README.md](core/README.md)**，那里有接入步骤、每个参数和返回值的含义、可选功能的字段、配置与测试约定。

**渠道接口**：负责收发消息，并把各平台的消息转换成统一格式交给中枢。

```js
{
  id, displayName,            // displayName 会出现在回复和提示词里，例如“飞书”
  richText, formatNote,       // 是否支持 Markdown；支持时附在每轮输入后的回复格式要求
  start({ message, recalled, ready, closed }), stop(),
  send(entry),                // { messageId, chatId, text, format: 'markdown' | 'text', key }
  isPermanentSendError(error),
  acknowledge(message),       // 表示已开始处理，不得抛错
  attachments(message),       // Agent 支持图片时下载：[{ path, mediaType, data }]
  files(message),             // 文件消息：下载并返回 [{ path, name, size }]
  fileReplies: { maxBytes },  // 能把文件作为回复发回时提供；send(entry) 会收到带 file 的条目
}
// 统一消息格式
{ id, chatId, chatType: 'private' | 'group', kind: 'text' | 'rich' | 'image' | 'file' | 'other', text, raw }
```

**Agent 接口**：运行一轮对话并返回答案；可选能力存在时，中枢自动启用对应指令。

```js
{
  id, displayName, capabilities: { images, files },
  runTurn({ sessionId, cwd, text, images, files, outbox, mode, timeoutMs, turnKey, onSession }),  // → { cancel(), result }
  modes,               // 可选，启用 /mode
  usage, usageLabel,   // 可选，启用 /usage
  compact,             // 可选，启用 /compact
  rename,              // 可选，启用 /rename
  sessions,            // 可选，启用 /sessions、/switch（提供 trash 时还有 /delete）
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
| `maxFileBytes` | 收文件的单个大小上限（字节），省略时为 100 MiB。发回文件不受此项影响（30 MB 以内直接发，更大的经云空间发链接，最多 1 GiB）。 |
| `sessionDir` | 新会话的工作目录，省略时为运行用户的主目录，会话记录因此与终端里的会话放在一起。会话在此目录之外运行时，`workspace/CLAUDE.md` 会作为附加系统提示传给 Claude Code。 |
| `maxEventAgeMs` | 接受消息的最大年龄，单位毫秒。 |
| `turnTimeoutMs` | 单条任务的最长运行时间，单位毫秒；前情梗概最多 5 分钟。 |
| `recallCheckMs` | 可选，处理一条消息期间每隔多久查一次它是否被撤回，单位毫秒，省略时为 5000；只用于没有撤回事件的渠道（如飞书）。 |
| `allowGroupMentions` / `botOpenId` | 群聊默认关闭；开启时须提供本机器人正确的 open ID，并在飞书启用相应事件权限。 |
| `replyFormat` | `card`：飞书卡片（见下）；`markdown`：飞书富文本，首行写会话名和权限模式；其他值为纯文本。 |
| `claudeModel` | 可选，Claude Code 的默认模型（别名或完整模型名），以 `--model` 传入；省略时用 Claude Code 自己的设置。聊天里可用 `/model` 改。 |
| `claudeEffort` | 可选，Claude Code 的默认推理深度（如 `high`、`max`），以 `--effort` 传入并显示在卡片的模型标签上；省略时用 Claude Code 自己的设置，标签只写模型名。聊天里可用 `/effort` 改。 |
| `claudePermissionMode` | Claude Code 的默认权限模式，省略时为 `auto`，可选值见[权限模式](#权限模式)。 |
| `claudeAllowedTools` | Claude Code 预先允许的工具列表，例如 `["WebSearch", "WebFetch"]`。 |
| `bots` | 可选，同时接多个机器人，见[多个机器人](#多个机器人)。省略时就是上面这些字段描述的一个机器人。 |

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
