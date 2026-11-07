# agent-connector Unreleased 迭代记录

## 当前状态

日期与核对提交：2026-11-07，`b3b6e05`（基于 V1.1 的 `a798151`）。第 1–7 项随 `28ffd96`、第 8–9 项（收文件、发回文件）随 `b3b6e05` 按用户要求推送到 `main`（用户：“好的，将结果push上github吧”）；没有打版本标签，版本号未定。

已在本机上线：多系统部分 2026-11-04 12:17（UTC），回复首行显示权限模式 12:28（UTC）；之后飞书正常使用至 2026-11-05。用户验收未进行。

下一步：待用户命名版本并决定提交、推送。

## 目标与范围

- 用户转来他人试用 V1.1 后的反馈截图（只有 Debian 部署、依赖 Claude Code 内部格式、单 owner、无许可证、bypass 风险），问：“看看这个问题是否可以解决，是否可以做多os兼容”（飞书）。
- 许可证：“加一下MIT，这个我也比较好奇流程是怎么样的”（飞书）。
- bypass 风险：“各个模式要不直接在会话名后展示（比如 -- auto mode），这样bybass也能被感知到”（飞书）。
- 改名：在“可以叫做agent-connector吗”之后，用户确认“好的，就叫做agent-connector吧，你修改一下所有地方的名字，然后push上github，我再修改github”（飞书）。
- 文件：用户问“现在agent-connector是否能接收文件、音频、视频等？”，得知只支持文字和图片后要求“那就先支持文件吧，然后把支持的文件在readme里列一下”（终端）。
- 发回文件：用户问改 slides 能否正确读取并产出改完后的，得知改好的文件发不回飞书后要求“那做一下回传文件的功能吧”（终端）。
- 不包含：Codex 收图片（本机未装 Codex，无法验证）；语音、视频消息。

## 变化内容

1. 多系统服务：`service.mjs` 在 Linux 有 systemd 时装系统服务（root）或用户服务，macOS 装 LaunchAgent，其他环境用内置守护进程（也可 `--supervisor` 强制）；进程检查不再依赖 `/proc`，`logs` 改用 Node 跟踪日志。纯逻辑在 `service/units.mjs`。验证：单元测试覆盖各平台的配置生成（plist 经 Python `plistlib` 解析）；真实环境只验证了本机 Linux 容器的内置守护进程（新脚本接管运行中的旧守护进程并重启成功）；**macOS 与 systemd 未在真机验证**。
2. `node service.mjs doctor`：检查 Node.js、可执行文件与版本（与 `service/doctor.mjs` 的 `TESTED` 不同时提醒）、工作区可写、Claude Code 会话记录与终端状态能否读出，不输出配置值和会话内容。验证：本机真实运行，查出 Claude Code 已自动升级到 2.1.318，会话记录 35/38 可读；当时会话读取和一张真实飞书图片在 2.1.318 上正常，`TESTED` 随之改为 2.1.318。
3. 图片路径按真实路径校验：macOS 的临时目录或工作区经符号链接（`/var` → `/private/var`）时，原先的比对会误拒；仍拒绝下载结果本身是符号链接。验证：单元测试模拟符号链接；修复后真实飞书中还没收到过带图消息。
4. 多用户：`ownerOpenIds`（可与 `ownerOpenId` 同时用），名单内都是完全信任的用户。验证：单元测试。
5. MIT 许可证：新增 `LICENSE`，`package.json` 写 `"license": "MIT"`，README 末尾注明。
6. 回复首行显示会话名与权限模式，如 `**workspace** -- auto mode`，`bypassPermissions` 带 ⚠️。验证：集成测试覆盖切换模式与改名后的首行；真实飞书中 2026-11-04 12:28（UTC）起的回复都带首行。

7. 项目改名为 agent-connector：`package.json`、README、pjkp 标题，以及服务名（systemd 单元 `agent-connector.service`、LaunchAgent `com.agent-connector`）。用户的原话保留旧名不改；渠道目录 `lark-channel/` 是飞书渠道的名字，不变。README 写明旧版本装过服务的先卸载再按新名安装。GitHub 仓库由用户自己改名。

8. 文件消息：飞书 `file` 消息按 `lark-cli` 的 `<file key=… name=…/>` 标记取文件，经系统临时目录中的私有目录下载（与图片共用 `lark-channel/download.mjs`），以处理过的原文件名存入工作区 `attachments/`，单个最多 50 MiB；文件夹提示先压缩。中枢先回复“已收到文件”，把文件留到这个聊天的下一条普通消息，在提示里写明文件名、大小和路径后交给 Agent，成功的那一轮之后才清除；Claude Code 在会话目录之外时加 `--add-dir`。README 新增“文件”一节，列出各类文件能否读取。验证：单元与集成测试（模拟 `lark-cli` 与 Claude Code）；真实 Claude Code 2.1.318 在 `auto` 模式、从无关目录加 `--add-dir` 读取 9 种样例，txt、md、csv、json、PDF、PNG 用 Read 工具读到，docx、xlsx、zip 用 `unzip` 读到；.pptx 另测：真实 Claude Code 读出 3 页幻灯片的标题、要点和表格，完成改标题、加列表项、改表格单元格并另存，用 python-pptx 独立核对改动正确、原文件未变（2026-11-06）；**还没有通过真实飞书收发过文件消息**，旧版 Office 未测。改完的文件目前无法发回飞书。

9. 发回文件：每轮在工作区 `outbox/` 下建一个私有发件目录，提示里告诉 Agent 把要发给用户的文件存到这里；本轮成功后，中枢把其中的普通文件排进回复队列，在文字回答之后逐个作为文件回复发出，发出后删除。每个最多 30 MB、不发空文件（飞书上传接口的限制，见 `lark-cli schema im.files.create`），每次最多 5 个，其余在回复里说明并留在本机。`lark-cli` 只接受工作目录内的相对路径、且拒绝读取 `/root` 下的文件（`--dry-run` 实测），所以发送前先复制到系统临时目录中的私有目录。`.gitignore` 增加 `workspace/outbox/`。验证：集成测试覆盖顺序、30 MB 与 5 个上限、空文件和链接、失败的一轮不留空目录；真实 Claude Code 按提示把改好的 `.pptx` 存进发件目录，工作目录没有留下临时脚本，标题改动经 python-pptx 核对；**还没有通过真实飞书发出过文件**。

`npm test` 62 项通过。

## 决定

- 服务管理改为多系统兼容（用户），取代 V1.0 范围内的“只支持 Debian”，原决定见 [V1.0 · 决定](../V1.0/iteration.md#决定)。
- 权限模式改为在每条回复首行可见（用户）。Agent 提出的“把 `bypassPermissions` 改为需在配置中显式开启”为候选，用户没有采纳。
- 许可证为 MIT（用户）；版权人写 GitHub 用户名 jiamingyuan、年份 2026，由 Agent 选定，用户未另行确认。
- 项目名 agent-connector（用户）。原话中的旧名不改、`lark-channel/` 不改名，由 Agent 决定，未经用户确认。
- 发回文件的方式由 Agent 决定，未经用户确认：每轮一个发件目录、本轮成功后才发、每次最多 5 个、发出后删除本机副本。
- 文件的处理方式由 Agent 决定，未经用户确认：文件不单独触发一轮，而是随下一条消息交付；单个最多 50 MiB，最多保留 10 个待处理文件；文件夹拒绝；Codex 也标为可接收文件（文件在其工作区内，但未用真实 Codex 验证）。
- 以下由 Agent 自行决定，未经用户确认：workspace 会话的回复也加首行（此前没有首行，否则 workspace 里的 bypass 不可见）；没有权限模式的 Agent（Codex、example）不加首行；多用户名单内都按完全信任处理；`TESTED` 改为 2.1.318。

## todo

暂无用户提出或采纳的事项。
