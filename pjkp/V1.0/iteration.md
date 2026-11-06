# agent-connector V1.0 迭代记录

## 当前状态

日期：2026-11-03。用户要求“最后再push到github上，作为V1.0”。范围：首次导入 `ef1da8e` 之后的全部提交，即 `827b30e`、[86992d1](https://github.com/jiamingyuan/agent-connector/commit/86992d1)、[c643327](https://github.com/jiamingyuan/agent-connector/commit/c643327) 与本次 V1.0 提交，打标签 `V1.0` 推送到 `origin/main`。`npm test` 39 项通过。本机服务已运行重构后的代码；V1.0 提交中的中枢小改动在服务空闲后自动重启生效。用户验收未进行：提交、推送和测试通过不等于验收。

下一步：待用户提出。

## 目标与范围

把飞书机器人 Sophia 从单一的 Claude Code 桥接，整理成渠道与 Agent 可替换的项目，并补齐让新 Agent 能照文档接入的说明。用户原话：

- 可选会话（终端）：“是否能将lark-agent-bridge开发成可选会话？方式是：在飞书agent上通过指令选择会话；选择完会话以后，飞书agent发一个会话前面的context梗概给用户；飞书在这个会话中，每次回复用户信息里都是：text_bf{{会话名}} 换行 {回复内容}；再设计一个退出会话的指令，退出后回到workspace会话”。
- 默认权限模式：先在飞书说“将dontask模式切成auto模式，后面lark-agent-bridge都用这个模式”，后在终端要求“将lark-agent-bridge 默认的模式改为auto，并且支持通过指令切换模式”。
- 查询用量（飞书，两次）：“将/usage查询余量的能力也开发进来吧”。
- 项目记忆：“通过pjkp来管理lark-agent-bridge”。
- 模块化（飞书）：“将这个项目拆成通过接口连接的agent端与消息接收端（这里我名字可能起得不是很好，如果有更专业的就用更专业的名字）……命名为claude-code-{agent端}、lark-{消息接收端}两个文件夹，并且支持后面扩展其他的模块（codex、slack、wechat等）”。
- 发布（飞书）：“把这些信息补充一下，做到agent通过读readme也能快速准确接入，同时scan一下整个项目有哪些文件是不需要的，删除一下，最后再push到github上，作为V1.0”。

## 变化内容

- `827b30e`（2026-11-02）：`service.mjs` 只支持 Debian；有 systemd 时装为服务，否则用内置守护进程；修复回复卡住。
- `86992d1`：
  - 可选会话 `/sessions`、`/switch`、`/exit`：进入本机其他 Claude Code 会话，前情梗概在不保存的临时分支上生成，会话中每条回复首行为加粗会话名。
  - 默认权限模式改为 `auto`，`/mode` 按聊天切换；本机 `config.json` 同步改为 `auto`（该文件不进仓库）。
  - `/usage` 查询 Claude 订阅用量（由 Sophia 在飞书会话中按用户要求实现）。
  - 重构为 `lark-channel/`、`claude-code-agent/`、`codex-agent/` 和中枢 `core/`；`config.json` 新增 `agent`、`channel`，旧字段 `backend` 仍有效，`runtime/state.json` 格式不变。
  - 启动 Agent 前去掉父 Claude Code 会话的身份环境变量；README 重写，补全指令表。
- `c643327`：pjkp 记录推送状态。
- V1.0 提交：
  - 接入指南：`core/README.md` 写明接入步骤、`context`、`runTurn` 每个参数与返回/错误约定、`runCliTurn`、可选功能（`modes`、`usage`、`sessions` 及会话对象字段）、渠道接口（统一消息、发件箱与 `send` 条目、过滤与重连职责）、配置与测试约定、已知限制。
  - 模板 `example-agent/`：不依赖外部程序的回声 Agent，已登记为 `example`。
  - 中枢去掉 Claude 专属假设：默认模式取自 `modes.resolve()`，群聊禁用的模式由 `modes.privateOnly` 声明，会话记录文件可选（`sessions.fileFor`）。
  - 删除不再需要的文件：`backend-selftest.mjs`（手动 Codex 自测，会调用真实 API，未被引用）；`codex-agent/args.mjs` 并入 `codex-agent/index.mjs`；`lark-channel/events.mjs` 与 `reply.mjs` 合并为 `protocol.mjs`；`test/core.test.mjs` 按模块拆出 `lark-channel.test.mjs`、`codex-agent.test.mjs`。本机 `runtime/` 中一次性的重启脚本与日志也已清理（不在仓库中）。

实际测试与结果：

- `npm test` 39 项通过，包括新增的 `example-agent` 端到端测试：只实现必需接口的 Agent 能正常对话、续接会话，不支持的指令给出明确回复。
- 照文档接入演练：在临时副本中只按 `core/README.md` 新写一个命令行 Agent `foo`（模拟程序 + `runCliTurn` 写法 + 端到端测试），两轮对话正确续接同一会话，接口检查通过；演练副本已删除，未进仓库。
- 重构后的服务于 2026-11-03 13:54（UTC）在本机上线，飞书 `/status`、会话切换等实际可用（`runtime/bridge.log`）。
- 会话中“加粗会话名 + 换行 + 回复”的格式在真实飞书中日常可见；用户没有明确确认显示效果。

## 决定

- 2026-11-02 服务管理只支持 Debian，移除 macOS 与容器脚本（用户要求，原话未留存，依据为 `827b30e`）。**已于 2026-11-04 被多系统兼容取代**，见 [Unreleased · 决定](../Unreleased/iteration.md#决定)。
- 原话中的 `text_bf{{会话名}}` 由 Agent 理解为加粗会话名，用户未另行确认。
- 命名：用户说“消息接收端”“agent端”的名字可换成更专业的；采用 channel（渠道）与 agent（Agent 适配器），中间为 hub（中枢），目录 `<名称>-channel/`、`<名称>-agent/`。
- 模块自己的配置项放在 `config.json` 顶层并以模块名为前缀（Agent 提出，写入接入指南，用户未另行确认）。
- 版本号 V1.0 由用户指定。
- 以下由 Agent 在实现时决定并写入 README，未经用户确认，用户提出新要求时以新要求为准：会话列表默认只列终端或 IDE 里开启的会话（`/sessions all` 才包括脚本会话），不列工作区自己的会话；会话正在终端执行任务时拒绝切换和执行，终端空闲打开时允许进入并提醒；会话切换只在私聊可用；群聊不能切到 `bypassPermissions`；`/mode` 按聊天保存并按顺序排队生效。

## todo

暂无用户提出或采纳的事项。
