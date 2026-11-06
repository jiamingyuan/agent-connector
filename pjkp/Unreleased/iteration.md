# agent-connector Unreleased 迭代记录

## 当前状态

日期与核对提交：2026-11-05，基于 `a798151`（V1.1）。以下改动均未提交、未推送，版本号未定。未提交的文件：`README.md`、`core/hub.mjs`、`core/text.mjs`、`lark-channel/images.mjs`、`lark-channel/protocol.mjs`、`package.json`、`service.mjs`、`test/` 下 7 个测试文件，新增 `LICENSE`、`service/`、`test/service.test.mjs`，以及 `pjkp/`。

已在本机上线：多系统部分 2026-11-04 12:17（UTC），回复首行显示权限模式 12:28（UTC）；之后飞书正常使用至 2026-11-05。用户验收未进行。

下一步：待用户命名版本并决定提交、推送。

## 目标与范围

- 用户转来他人试用 V1.1 后的反馈截图（只有 Debian 部署、依赖 Claude Code 内部格式、单 owner、无许可证、bypass 风险），问：“看看这个问题是否可以解决，是否可以做多os兼容”（飞书）。
- 许可证：“加一下MIT，这个我也比较好奇流程是怎么样的”（飞书）。
- bypass 风险：“各个模式要不直接在会话名后展示（比如 -- auto mode），这样bybass也能被感知到”（飞书）。
- 改名：在“可以叫做agent-connector吗”之后，用户确认“好的，就叫做agent-connector吧，你修改一下所有地方的名字，然后push上github，我再修改github”（飞书）。
- 不包含：Codex 收图片（本机未装 Codex，无法验证）。

## 变化内容

1. 多系统服务：`service.mjs` 在 Linux 有 systemd 时装系统服务（root）或用户服务，macOS 装 LaunchAgent，其他环境用内置守护进程（也可 `--supervisor` 强制）；进程检查不再依赖 `/proc`，`logs` 改用 Node 跟踪日志。纯逻辑在 `service/units.mjs`。验证：单元测试覆盖各平台的配置生成（plist 经 Python `plistlib` 解析）；真实环境只验证了本机 Linux 容器的内置守护进程（新脚本接管运行中的旧守护进程并重启成功）；**macOS 与 systemd 未在真机验证**。
2. `node service.mjs doctor`：检查 Node.js、可执行文件与版本（与 `service/doctor.mjs` 的 `TESTED` 不同时提醒）、工作区可写、Claude Code 会话记录与终端状态能否读出，不输出配置值和会话内容。验证：本机真实运行，查出 Claude Code 已自动升级到 2.1.318，会话记录 35/38 可读；当时会话读取和一张真实飞书图片在 2.1.318 上正常，`TESTED` 随之改为 2.1.318。
3. 图片路径按真实路径校验：macOS 的临时目录或工作区经符号链接（`/var` → `/private/var`）时，原先的比对会误拒；仍拒绝下载结果本身是符号链接。验证：单元测试模拟符号链接；修复后真实飞书中还没收到过带图消息。
4. 多用户：`ownerOpenIds`（可与 `ownerOpenId` 同时用），名单内都是完全信任的用户。验证：单元测试。
5. MIT 许可证：新增 `LICENSE`，`package.json` 写 `"license": "MIT"`，README 末尾注明。
6. 回复首行显示会话名与权限模式，如 `**workspace** -- auto mode`，`bypassPermissions` 带 ⚠️。验证：集成测试覆盖切换模式与改名后的首行；真实飞书中 2026-11-04 12:28（UTC）起的回复都带首行。

7. 项目改名为 agent-connector：`package.json`、README、pjkp 标题，以及服务名（systemd 单元 `agent-connector.service`、LaunchAgent `com.agent-connector`）。用户的原话保留旧名不改；渠道目录 `lark-channel/` 是飞书渠道的名字，不变。README 写明旧版本装过服务的先卸载再按新名安装。GitHub 仓库由用户自己改名。

`npm test` 54 项通过。

## 决定

- 服务管理改为多系统兼容（用户），取代 V1.0 范围内的“只支持 Debian”，原决定见 [V1.0 · 决定](../V1.0/iteration.md#决定)。
- 权限模式改为在每条回复首行可见（用户）。Agent 提出的“把 `bypassPermissions` 改为需在配置中显式开启”为候选，用户没有采纳。
- 许可证为 MIT（用户）；版权人写 GitHub 用户名 jiamingyuan、年份 2026，由 Agent 选定，用户未另行确认。
- 项目名 agent-connector（用户）。原话中的旧名不改、`lark-channel/` 不改名，由 Agent 决定，未经用户确认。
- 以下由 Agent 自行决定，未经用户确认：workspace 会话的回复也加首行（此前没有首行，否则 workspace 里的 bypass 不可见）；没有权限模式的 Agent（Codex、example）不加首行；多用户名单内都按完全信任处理；`TESTED` 改为 2.1.318。

## todo

暂无用户提出或采纳的事项。
