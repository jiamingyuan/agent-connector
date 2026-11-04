# lark-agent-bridge V1.1 迭代记录

## 当前状态

日期：2026-11-04。用户要求“push一下变更吧，作为V1.1”。范围：V1.0（`c19cfd1`）之后的全部改动，作为一个提交，打标签 `V1.1`，推送到 `origin/main`。`npm test` 47 项通过。本机服务自 2026-11-04 06:38（UTC）起运行的就是这批代码。用户验收未进行：提交、推送和测试通过不等于验收。

真实使用（`runtime/bridge.log`）：06:11 在飞书 `/switch` 进入会话后 `/compact` 成功（约 75 秒）；06:43 在飞书 `/rename` 成功。修复后还没有通过飞书真实发过图片，图片修复的依据是对原失败消息的复跑（见下文）。

下一步：待用户提出。

## 目标与范围

- 增加上下文压缩。用户原话（飞书）：“增加这里context compact能力”。
- 确认飞书图片能否送到 Agent。用户原话（飞书）：“现在飞书发图片，agent能正常接收到不”。
- 增加会话重命名。用户原话（终端）：“现在有/rename能力吗，没有的话加一个”。

## 变化内容

- `/compact [要点]`：压缩当前会话（workspace 会话或 `/switch` 进入的会话）的上下文，调用 Claude Code 自带的 `/compact`，回复压缩前后的 token 数；排队执行，会话 ID 不变。Agent 接口新增可选的 `compact`。
- `/rename [名称]`：重命名当前会话，调用 Claude Code 自带的 `/rename`（写入会话记录的 `custom-title`）；不写名称时由 Claude Code 自动生成。进入的会话改名后回复标题立即更新，workspace 会话的名称显示在 `/status`。Agent 接口新增可选的 `rename`。
- 飞书图片修复（2026-11-04 02:55 UTC 的图片消息失败）：
  - `lark-cli` 1.0.98 把图片写成 `[Image: img_…]`，旧代码只认 `image_key` 和 `![Image](img_…)`；纯图片会报“没有取到图片”，图文消息里的图片会被静默丢弃。现在三种写法都识别。
  - `lark-cli` 1.0.98 拒绝把下载写到 `/root` 下（工作区在其中）。现在先下载到 `os.tmpdir()` 下 `mkdtemp` 建的私有目录（700），检查格式和大小后复制到工作区 `attachments/`，再删除临时目录。
  - 去掉 `prepareImages` 里残留的 `config.backend` 判断：V1.0 起改用 `agent` 字段的配置会丢图。
- 失败原因：Claude 返回 API 错误时，回复里带上真实原因；额度用完时提示用 `/usage` 查看重置时间。同一时段其余消息失败的原因就是订阅 5 小时额度用完（会话记录：“You've hit your 5-hour limit · resets 5am (UTC)”），当时只显示了笼统的“本轮运行失败”。`runCliTurn` 的解析结果新增 `errorText`，保留第一次出现的原因。
- `.gitignore` 增加 `workspace/attachments/`，收到的图片不进仓库。
- 测试：新增 `test/compact-images.test.mjs`、`test/rename.test.mjs`；模拟的 `lark-cli` 按 1.0.98 的行为下载图片（拒绝 `/root`、返回绝对路径），模拟的 Claude Code 支持 `/compact`、`/rename` 和额度用完的错误。文档：README 指令表、`core/README.md` 可选功能与 `errorText`。

实际测试与结果：

- `npm test` 47 项通过。
- 真实 Claude Code 2.1.317 无界面试跑（临时会话，试跑后已删除）：`/compact` 后会话 ID 不变、约 22,102 → 7,304 tokens，之后仍记得压缩前的口令；`/rename 名称` 直接改名，不带名称时自动生成，会话 ID 不变。
- 用失败的那条真实图片消息复跑：新代码下载成功（221 KB JPEG），按桥接的图片输入格式发给 Claude Code，能正确描述图片内容。
- 飞书真实使用见[当前状态](#当前状态)。

## 决定

- 版本号 V1.1 由用户指定。
- `/compact`、`/rename` 都调用 Claude Code 自带的命令，不自己改写会话记录（Agent 提出并实现，用户未另行确认）。

## todo

暂无用户提出或采纳的事项。
