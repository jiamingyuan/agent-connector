# 接入指南：模块结构与接口

本文是新增 Agent 或消息渠道时唯一需要读的文档。照着[接入步骤](#接入步骤)做，完成后 `npm test` 会自动检查接口。

## 结构

```text
消息渠道 channel  ──统一消息──▶  中枢 hub  ──runTurn──▶  Agent 适配器 agent
<名称>-channel/   ◀──回复条目──  core/     ◀──最终回答──  <名称>-agent/
```

| 位置 | 内容 |
| --- | --- |
| `bridge.mjs` | 入口：读 `config.json`，按 `channel` / `agent` 加载模块，清理子进程环境变量，取进程锁，启动中枢。 |
| `core/hub.mjs` | 中枢：按聊天排队、去重、回复发件箱与重试、聊天状态 `runtime/state.json`，以及全部指令。只通过下面两个接口访问两端。 |
| `core/registry.mjs` | 模块登记表：名称 → 目录。 |
| `core/cli-turn.mjs` | 命令行类 Agent 共用的进程运行器。 |
| `core/text.mjs` | 回复拆分、会话名标题、幂等键、`safeLabel`。 |
| `lark-channel/` | 飞书渠道（参考实现）。 |
| `claude-code-agent/` | Claude Code（实现了全部可选功能的参考）。 |
| `codex-agent/` | Codex（基于 `runCliTurn` 的最小命令行 Agent）。 |
| `example-agent/` | 模板：不依赖外部程序的回声 Agent，可直接复制改名；也可配置 `"agent": "example"` 不花模型额度地测试渠道。 |

## 接入步骤

1. **新建目录**：Agent 命名为 `<名称>-agent/`，渠道命名为 `<名称>-channel/`，名称用小写和连字符。Agent 可直接复制 `example-agent/`。
2. **写 `index.mjs`**，导出两个函数（ES module）：
   - `requiredBins(config)` → 需要的可执行文件绝对路径数组，例如 `[config.geminiBin]`；没有就返回 `[]`。`node service.mjs install/start/restart` 会逐个检查可执行。
   - `createAgent(config, context)` 或 `createChannel(config, context)` → 下文接口描述的对象。
3. **登记**：在 `core/registry.mjs` 的 `agents` 或 `channels` 里加一行 `名称: () => import('../<名称>-agent/index.mjs')`。
4. **配置**：`config.json` 写 `"agent": "<名称>"` 或 `"channel": "<名称>"`。模块自己的配置项直接放在 `config.json` 顶层，以模块名为前缀，例如 `geminiBin`、`geminiModel`、`slackToken`（凭证类字段只放本地 `config.json`，不要写进示例和仓库）；在根目录 README 的配置表里补上说明。
5. **测试**：新建 `test/<名称>-agent.test.mjs`（或 `-channel`）。`test/adapters.test.mjs` 会对所有已登记模块做接口检查；端到端测试见[测试](#测试)。
6. **文档**：在根目录 README 的“架构与接口”目录表里加一行，并说明支持哪些可选功能。

`context` 对两类模块相同：

| 字段 | 含义 |
| --- | --- |
| `root` | 项目根目录。 |
| `runtime` | 私有运行目录 `runtime/`（权限 700），可存临时文件；内容含私人数据。 |
| `env` | 启动子进程应使用的环境变量：已去掉父 Claude Code 会话的身份变量，并带上 `lark-cli` 的静默开关。 |
| `log(type, fields)` | 写一行 JSON 到服务日志。只记事件类型、ID、计数等；不得记录消息正文、模型输出或凭证。 |

## Agent 接口

```js
export const requiredBins = config => [config.fooBin];
export function createAgent(config, context) {
  return {
    id: 'foo',                       // 与登记名一致
    displayName: 'Foo',              // 用于回复，如“Agent：Foo”“Foo 本轮运行失败”
    capabilities: { images: false, files: false }, // images：中枢下载图片并通过 images 传入；files：接收文件消息并通过 files 传入
    runTurn(request) { return { cancel() {}, result: Promise.resolve('答案') }; },
    // 可选：modes、usage + usageLabel、sessions（见下文）
  };
}
```

### runTurn(request)

中枢每处理一条普通消息调用一次；同一聊天串行，不同聊天可能并发。

| 参数 | 类型 | 含义 |
| --- | --- | --- |
| `sessionId` | string \| undefined | 要续接的会话 ID；这个聊天第一轮或 `/new` 之后为 `undefined`，此时新建会话。 |
| `cwd` | string | 本轮的工作目录：当前会话自己的目录；新会话为 `config.sessionDir`（默认主目录；早先版本创建的会话为 `config.workspace`）。只支持固定目录的 Agent 可以忽略。 |
| `text` | string | 发给 Agent 的完整文字。中枢已在用户原文后附加以 `\n\n[桥接` 开头的说明块（群聊范围、当前工作目录、渠道的回复格式要求），原样送入即可。 |
| `images` | array | `capabilities.images` 为 true 且消息带图时为 `[{ path, mediaType, data }]`（本地文件路径、MIME 类型、base64 内容），否则为 `[]`。 |
| `mode` | string \| undefined | 这个聊天用 `/mode` 选的模式；`undefined` 表示用默认值。没有 `modes` 的 Agent 忽略。 |
| `timeoutMs` | number | 本轮最长运行时间（`config.turnTimeoutMs`）。Agent 必须自己在超时后停止。 |
| `files` | array | 用户在这条消息之前发来、随本轮交付的文件 `[{ path, name, size }]`（`capabilities.files` 为 false 时始终为 `[]`）。中枢已在 `text` 里写明文件名和本地路径；Agent 要保证能读到这些路径，例如 Claude Code 在会话目录之外时加 `--add-dir`。 |
| `outbox` | string \| undefined | 本轮发件目录，渠道支持发回文件且 `capabilities.files` 为 true 时提供。中枢已在 `text` 里告诉模型把要发给用户的文件存到这里；本轮成功后，中枢把目录里的普通文件（每个不超过渠道的 `fileReplies.linkMaxBytes`，没有时为 `maxBytes`；最多 5 个）作为回复发出。Agent 要保证能写这个目录，例如 Claude Code 在会话目录之外时加 `--add-dir`。 |
| `instructionsFile` | string \| undefined | 会话不在 `config.workspace` 中运行时，指向 `workspace/CLAUDE.md`；Agent 应把它作为附加指令（Claude Code 用 `--append-system-prompt-file`）。 |
| `turnKey` | string | 本条消息唯一、可安全用作文件名的键，例如 Codex 用它命名答案文件。 |
| `onSession(id)` | function | 一旦知道会话 ID 就调用（可以多次）。中枢保存后，下一轮作为 `sessionId` 传回；不调用则每轮都是新会话。 |

返回 `{ cancel, result }`，且必须同步返回（启动失败也通过 `result` 拒绝）：

- `result` 解析为最终回答：非空字符串，中枢会自动拆分长文本并发回。
- 调用 `cancel()`（用户发 `/stop` 或服务停止）后，停止工作并让 `result` 解析为 `null`。
- 失败时 `result` 拒绝为 `Error`：`message` 会原样发给用户，所以写成面向用户的中文说明，例如“任务超过 60 分钟已停止”。可带 `code`：`'startup'`（启动超时）、`'timeout'`（运行超时）、`'failed'`（运行失败；可再带 `exitCode`、`hasFailure`、`completed` 供日志记录）。
- 本轮已做的操作不会自动撤销；超时说明里最好提醒用户。

### 用 runCliTurn 接命令行 Agent

Agent 是一个“读标准输入、逐行输出 JSON 事件”的命令行程序时，直接用 `core/cli-turn.mjs`：

```js
import { runCliTurn } from '../core/cli-turn.mjs';
runTurn: ({ sessionId, cwd, text, timeoutMs, onSession }) => runCliTurn({
  bin: config.fooBin, args: sessionId ? ['--resume', sessionId] : [], input: text,
  cwd, env: context.env, timeoutMs, agentName: 'Foo', onSession,
  parse: event => ({ ready, sessionId, completed, failed, text }),  // 每行 JSON 事件 → 字段（都可省略）
  // outputFile: 可选，程序把最终答案写到文件时给出路径，结束后读取并删除
}),
```

`parse` 返回的字段：`ready` 表示已启动（2 分钟内未出现则按启动失败处理）；`sessionId` 会转给 `onSession`；`completed` / `failed` 表示本轮成功或失败；`text` 为最终答案（多次出现取最后一次）；`errorText` 为面向用户的失败原因（取第一次出现的），失败时拼进错误提示，例如“Foo 本轮没有完成：<原因>”。退出码非 0、未出现 `completed` 或答案为空都按失败处理。进程放在独立进程组里，取消或超时会整组终止；stderr 被丢弃，避免把模型输出或凭证写进日志。`runCliQuery({ bin, args, input, cwd, env, parse })` 用于只取一次结果的查询（如 `/usage`）。

### 可选功能

提供以下字段后，中枢自动启用对应指令；不提供时这些指令会回复“目前不支持 <displayName>”，`/help` 里也不显示。

**`modes`** → `/mode`，以及 `/status` 中的“权限模式”：

| 字段 | 含义 |
| --- | --- |
| `descriptions` | `{ 模式名: 说明 }`，顺序即 `/mode` 列出的顺序。 |
| `resolve(override?)` | 返回生效的模式名：有 `override` 用它，否则用配置的默认值；无效时抛错。 |
| `find(name)` | 把用户输入（大小写、简写）解析为模式名，找不到返回 `null`。 |
| `privateOnly` | 可选，只允许在私聊中切换的模式名数组（如高风险模式）；切换后提醒用户用完切回。 |
| `hint` | 可选，附在“发送 /mode 模式名 切换”后的简短说明。 |

**`usage()` 和 `usageLabel`** → `/usage`：`usage()` 返回 `Promise<string>`（直接发给用户的文字），`usageLabel` 是 `/help` 里的说明。失败时中枢回复通用提示。

**`rename({ sessionId, cwd, name, timeoutMs })`** → `/rename [名称]`：给这个会话改名，返回 `{ cancel, result }`，`result` 解析为改名后的名称（`name` 为空字符串时由 Agent 自动生成）。中枢只在聊天已有会话时调用；成功后用新名称更新回复首行和 `/status`。会话 ID 应保持不变，不要调用 `onSession`。

**`compact({ sessionId, cwd, instructions, timeoutMs })`** → `/compact [要点]`：压缩这个会话的上下文，返回与 `runTurn` 相同的 `{ cancel, result }`，`result` 解析为发给用户的结果说明（如压缩前后的 token 数）。`instructions` 是用户附的要点，可能为空字符串。中枢只在聊天已有会话时调用，按排队顺序执行；会话 ID 应保持不变，不要调用 `onSession`。

**`sessions`** → `/sessions`、`/switch`（只在私聊可用）。会话对象：

```js
{ id, name, cwd, mtimeMs, headless, file }
// id 会话 ID；name 显示名（一行、已用 safeLabel 处理）；cwd 会话目录；mtimeMs 最近活动时间；
// headless 是否脚本会话（默认列表不显示）；file 可选，会话记录文件路径，提供后每轮前检查它是否还存在
```

| 函数 | 含义 |
| --- | --- |
| `list({ exclude })` | 返回会话对象数组，最近活动在前；`exclude` 是不应列出的目录（工作区）。 |
| `filter(list, query)` | `query` 为空返回默认视图，`'all'` 返回全部，其他为关键词筛选。 |
| `pick(list, query, listedIds)` | 解析 `/switch` 的参数，返回匹配的会话数组：数字指 `listedIds` 中的序号，也可支持 ID 前缀或名称。 |
| `running()` | 返回 `Map<会话ID, { pid, busy }>`，表示正被其他进程（如终端）打开的会话；`busy` 时中枢拒绝进入和执行。 |
| `digest(file)` | 返回 `{ prompt, reply }`：最近一轮的提问和回答摘录，梗概生成失败时使用。 |
| `format(shown, { total, running, current, query })` | 返回 `/sessions` 的完整回复文字。 |
| `ago(mtimeMs)` | 返回“3 分钟前”这样的时间文字。 |
| `resumeHint(id)` | 返回在终端里重新打开该会话的命令，用于提醒。 |
| `fileFor(file, id)` | 可选，会话 ID 变化后返回新的记录文件路径。 |
| `recap({ sessionId, cwd, timeoutMs })` | 生成前情梗概，返回与 `runTurn` 相同的 `{ cancel, result }`；不得改动原会话，也不得调用 `onSession`。 |
| `trash(session, trashRoot)` | 可选，提供时启用 `/delete`：把会话记录移出 Agent 的会话目录、放到 `trashRoot` 下，返回 `{ trash, restoreTo }`。中枢负责确认、拒绝当前或正在使用的会话，并清掉聊天对它的引用。 |

### Agent 的约定

- 工作区说明文件由 Agent 自己读取：Claude Code 读 `workspace/CLAUDE.md`，Codex 读 `workspace/AGENTS.md`。新 Agent 需要别的文件时放进 `workspace/`，并在 README 说明。
- 权限：默认采用安全设置，不需要有人在场确认（没有人能回答确认提示）；高风险设置只能由用户在配置或 `/mode` 中明确选择。
- 子进程必须用 `context.env`，不要直接用 `process.env`。

## 渠道接口

```js
export const requiredBins = config => [config.fooCliBin];
export function createChannel(config, context) {
  return {
    id: 'foo', displayName: 'Foo',  // displayName 出现在回复和提示词里，如“这条消息是用户在Foo里发来的”
    richText: true,                 // 能发 Markdown 时为 true
    formatNote: '[Foo回复格式]\n…', // richText 时附在每轮输入末尾的回复格式要求
    start(handlers), stop(),
    send(entry), isPermanentSendError(error),
    acknowledge(message), attachments(message), files(message),
    fileReplies: { maxBytes, linkMaxBytes },  // 可选：能把文件作为回复发回时提供；linkMaxBytes 可选，渠道能把超过 maxBytes 的文件改为链接发出时提供，send 自行处理
  };
}
```

### 收消息：start(handlers) 与统一消息

`start({ message, ready, closed })` 开始接收，之后：

- 每收到一条**需要处理**的消息，调用 `handlers.message(msg)`。过滤由渠道负责：只放行授权用户（`config.ownerOpenId` 之类）、本机器人被真实 @ 的群消息、未过期的消息；被忽略的用 `context.log('event_ignored', { reason })` 记录。
- 连接可用时调用 `handlers.ready()`：中枢据此显示“连接正常”并补发积压的回复。断开时调用 `handlers.closed()`。断线重连由渠道自己负责，重连成功后再调用 `ready()`。
- `stop()` 停止接收且不再重连。

统一消息：

| 字段 | 含义 |
| --- | --- |
| `id` | 平台消息 ID，全局唯一；中枢用它去重，也用它生成回复的幂等键。 |
| `chatId` | 聊天 ID，同一私聊或群始终相同；会话、权限模式、排队都按它区分。 |
| `chatType` | `'private'` 或 `'group'`。群聊回复对全群可见，中枢会限制部分指令。 |
| `userId` | 发送者 ID（可选）。中枢原样带到发回文件的回复条目上，供渠道给该用户开通链接的访问权限。 |
| `kind` | `'text'` 纯文字、`'rich'` 富文本（可能含图）、`'image'` 纯图片、`'file'` 文件（含文件夹，由渠道决定是否拒绝）、`'other'` 其他（中枢回复“目前支持文字对话”）。 |
| `text` | 用户文字，已去掉开头的 @机器人。中枢只把已知指令（`/new`、`/status` 等）当作指令，其余文字都交给 Agent。 |
| `raw` | 平台原始事件，留给渠道自己后续使用（如下载图片），中枢不读取。 |

### 发回复：send(entry)

中枢把每条回复先存进发件箱（`runtime/state.json`），再逐条调用 `send`；失败的会在重连后和每 30 秒重试，同一条消息的后续分段会等前一段成功。

| `entry` 字段 | 含义 |
| --- | --- |
| `messageId` | 要回复的那条用户消息的 `id`（以引用回复的方式发出）。 |
| `chatId` | 所在聊天。 |
| `text` | 要发的文字，已拆分：每段不超过 12,000 字节，Markdown 尽量按段落、表格和代码块拆。 |
| `format` | `'markdown'` 或 `'text'`。只有 `richText` 为 true 时才会出现 `'markdown'`。 |
| `key` | 稳定的幂等键（同一回复重试时不变），平台支持时用于去重。 |
| `kind` | 回复类别（`answer`、`status`、`error`、`file` 等），只用于日志。 |
| `file`、`name` | 仅文件回复：要发送的本地文件路径和文件名。没有 `text`。发送成功后中枢删除该文件；文件已不存在时抛出带 `permanent: true` 的错误，中枢会丢弃这一条。 |

- `send` 成功时 resolve；失败时 reject，错误上设 `channel: true`，`detail` 放平台错误详情。
- `isPermanentSendError(error)`：重试也不会成功时返回 true（例如原消息已撤回），中枢会丢弃该条回复。

### 其他方法

- `acknowledge(message)`：表示“已开始处理”，例如加表情或已读回执；返回 Promise 且**不得拒绝**（失败自己记日志）。没有对应能力就返回 `Promise.resolve()`。
- `attachments(message)`：仅当 Agent 支持图片且 `kind` 为 `'image'` 或 `'rich'` 时调用，返回 `[{ path, mediaType, data }]`（没有图返回 `[]`）。文件建议存在 `config.workspace` 下的私有目录（平台工具不允许写入该目录时，先下载到 `os.tmpdir()` 下用 `mkdtemp` 建的私有目录，检查后再复制，参考 `lark-channel/images.mjs`）；遇到不支持的格式或超限时抛出带用户可读 `message` 的错误，中枢会原样回复。
- `files(message)`：仅当 Agent 的 `capabilities.files` 为 true 且 `kind` 为 `'file'` 时调用，返回 `[{ path, name, size }]`：本地路径、处理过的安全文件名（单个路径分量）、字节数。下载方式与 `attachments` 相同（参考 `lark-channel/files.mjs`），超限、文件夹等情况抛出带用户可读 `message` 的错误。中枢收到后先回复“已收到文件”，把文件留到这个聊天的下一条普通消息再交给 Agent（文件和文字在飞书里是分开的两条消息）；那一轮成功后才清除，失败或被 `/stop` 时保留。

## 测试

- **接口检查**：`test/adapters.test.mjs` 遍历登记表，检查导出和必需字段；可选功能出现时检查字段是否齐全。
- **单元测试**：参考 `test/codex-agent.test.mjs`、`test/lark-channel.test.mjs`，测试参数构造、事件解析、消息过滤等纯函数。
- **端到端**：`test/harness.mjs` 的 `runBridge(t, build)` 在临时目录里运行真实的 `bridge.mjs`，用模拟的 `lark-cli` 逐条投递消息并记录回复。`build(root)` 返回 `{ events, config, state, env }`：`config` 会覆盖默认配置，例如 `{ agent: 'foo', fooBin: '<root 下的模拟程序>' }`；返回值含 `replies`（每条 `{ id, format, text }`）和 `state`。示例见 `test/example-agent.test.mjs`；命令行 Agent 可在 `build` 里写一个模拟程序，参考 harness 中模拟的 Claude Code。
- 测试不得调用真实的模型或聊天平台。

## 已知限制

- 中枢固定把回复拆成不超过 12,000 字节的分段，单条上限更小的平台需要在 `send` 里再拆。
- 指令文字（`/new`、`/status` 等）和提示语目前是中文。
- 一个进程只连接一个渠道和一个 Agent；`runtime/` 固定在项目目录下，要同时接多个平台，需要每个平台各用一份项目目录（各自的 `config.json` 和服务）。
