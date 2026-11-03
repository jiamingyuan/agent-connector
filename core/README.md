# 模块结构与接口

桥接程序由三部分组成，`bridge.mjs` 按 `config.json` 把它们接起来：

```text
消息渠道（channel）  ──消息──▶  中枢（hub）  ──一轮对话──▶  Agent 适配器（agent）
lark-channel/        ◀──回复──  core/        ◀──最终回答──  claude-code-agent/、codex-agent/
```

| 目录 | 职责 |
| --- | --- |
| `core/` | 中枢：按聊天排队、去重、回复发件箱与重试、聊天状态（`runtime/state.json`），以及全部命令。不含任何渠道或 Agent 的细节。 |
| `<名称>-channel/` | 消息渠道适配器：从某个聊天平台收消息、发回复。当前有 `lark-channel/`（飞书）。 |
| `<名称>-agent/` | Agent 适配器：把一轮对话交给某个 Agent 运行并取回答案。当前有 `claude-code-agent/`、`codex-agent/`。 |

`config.json` 里用 `agent`（`claude-code` / `codex`）和 `channel`（`lark`）选择；旧字段 `backend: "claude" | "codex"` 仍然有效，`channel` 省略时为 `lark`。

## 新增模块

1. 新建目录，例如 `slack-channel/` 或 `gemini-agent/`，`index.mjs` 导出 `requiredBins(config)` 和 `createChannel(config, context)` / `createAgent(config, context)`。
2. 在 [`registry.mjs`](registry.mjs) 登记目录名。
3. `npm test` 中的 [`test/adapters.test.mjs`](../test/adapters.test.mjs) 会检查所有已登记模块是否满足下面的接口；为新模块补上自己的测试。

`context` 为 `{ root, runtime, env, log }`：项目目录、私有运行目录、已清理过的子进程环境变量、结构化日志函数。日志不得写入消息正文、模型输出或凭证。

## 渠道接口

```js
{
  id: 'lark', displayName: '飞书',   // displayName 会出现在回复和提示词里
  richText: true,                     // 能发 Markdown 富文本时为 true
  formatNote: '[飞书回复格式]…',      // richText 时附在每轮输入后的回复格式要求
  start({ message, ready, closed }),  // 开始收消息；断线重连由渠道自己负责
  stop(),
  send(entry),                        // 发出一条回复：{ messageId, chatId, text, format: 'markdown' | 'text', key }
  isPermanentSendError(error),        // true 表示重试也不会成功，回复会被丢弃
  acknowledge(message),               // 表示“已开始处理”（飞书为敬礼表情）；不得抛错
  attachments(message),               // 只在 Agent 支持图片时调用：[{ path, mediaType, data }]
}
```

渠道负责过滤（只把授权用户、需要处理的消息交给中枢），并把消息转换为：

```js
{ id, chatId, chatType: 'private' | 'group', kind: 'text' | 'rich' | 'image' | 'other', text, raw }
```

`text` 是去掉 @机器人 之后的用户文字，`raw` 留给渠道自己的后续处理（如下载图片）。`key` 可作为发送幂等键；发送失败时抛出带 `channel: true` 的错误。

## Agent 接口

```js
{
  id: 'claude-code', displayName: 'Claude Code',
  capabilities: { images: true },
  runTurn({ sessionId, cwd, text, images, mode, timeoutMs, turnKey, onSession }),
  // 返回 { cancel(), result }：result 解析为最终回答文字；cancel() 后解析为 null；
  // 失败时拒绝为带 code（'startup' | 'timeout' | 'failed'）和面向用户 message 的错误。
  // onSession(id) 报告会话 ID，中枢保存后在下一轮作为 sessionId 传回，以续接上下文。

  // 以下可选；提供后中枢启用对应命令
  modes: { descriptions, resolve(override), find(name) },       // /mode
  usage(), usageLabel,                                          // /usage
  sessions: { list, filter, pick, running, digest, format, ago, resumeHint, recap },  // /sessions /switch /exit
}
```

命令行类 Agent 可直接用 [`cli-turn.mjs`](cli-turn.mjs) 的 `runCliTurn`：提供命令、标准输入和逐行解析 JSON 事件的函数，进程管理、超时和取消由它处理。`text` 已由中枢附上渠道与运行信息（群聊范围、当前工作目录、回复格式），Agent 只需按自己的协议送入。
