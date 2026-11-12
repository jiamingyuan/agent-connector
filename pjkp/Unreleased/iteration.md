# Unreleased

V1.4 之后、尚未命名版本的工作。

## 变化内容

1. `/delete` 可一次删除多个会话（2026-11-12）。用户原话：“将/delete做成能够批量删除会话的能力”（飞书）。
   - 写法：多个编号和范围，如 `/delete 1 3 5-7`，分隔符可用空格、逗号、顿号。写名称或会话 ID 时仍按单个会话处理。
   - 不能删的（当前会话、终端里开着的、正在执行任务的、别的机器人开着的、列表里没有的编号）列出原因并跳过，其余照常删除。
   - 确认：发同一条命令加“确认”。只有本次要删的会话和上一次列出的完全一致才删除，否则重新列出。
   - 实现在中枢 `core/hub.mjs` 的 `deleteSession`，Agent 接口 `trash` 不变，每个会话调用一次。

   以下取舍由 Agent 自行决定，未经用户确认：支持范围写法；一个范围最多 100 个编号；没有做“删除全部”。

2. Windows 适配（2026-11-12）。用户先问“现在agent-connector是否兼容mac、windows”，得知 Windows 只能经 WSL 后要求“帮我做一下windows的适配”（飞书）。此前 `service.mjs` 和 `doctor` 在 Windows 上直接报错退出。
   - 启动和结束外部程序统一到新模块 `core/process.mjs`，Agent 和飞书渠道都改用它。原因：Windows 上 npm 装的工具是 `.cmd` 启动脚本，Node.js 只能经 `cmd.exe` 运行它，而消息内容是作为参数传给 `lark-cli` 的，经过 `cmd.exe` 会被当成命令解释。所以改为找出 `.cmd` 实际运行的脚本或程序直接启动；找不出就报错，不退回到 shell。
   - Windows 没有进程组和 SIGTERM：结束任务用 `taskkill` 结束整个进程树。
   - 服务：Windows 用内置守护进程，`install` 在当前用户的注册表启动项登记，登录后启动。守护进程改为经通道请求桥接程序关闭、经请求文件（`runtime/supervisor.stop`）接收停止请求，这两点在所有系统上相同，因此在 Linux 上测得到。守护进程启动桥接程序前清掉失效的锁文件（Windows 注销或断电不会清锁，锁里的进程号可能已被别的程序占用）。
   - 其他：下载结果的路径比对在 Windows 上不分大小写并兼容短路径名；保存的文件名避开 Windows 的设备名和结尾的点；状态文件改名失败时在 Windows 上重试。
   - `.github/workflows/test.yml`：让 GitHub 在 Linux、macOS、Windows 上各跑一遍测试。

   以下取舍由 Agent 自行决定，未经用户确认：登录自启用注册表启动项而不是计划任务或系统服务（不需要管理员权限，代价是登录后才启动、登录时短暂出现命令行窗口）；加了测试工作流。

3. 补全 Codex 模块（2026-11-12）。用户原话：“在agent-connector迭代了这么多版之后，看看codex模块是否开发完全，没开发完全的你先补上，不用进行测试”（飞书）。此前 Codex 只有文字对话、`/model`、`/effort`，且固定在 `workspace` 里运行。
   - 补上：按会话目录运行、图片、收发文件的目录放开、`/mode`（沙箱模式）、`/usage`、`/rename`、`/sessions`、`/switch`、`/delete`、回复卡片上的模型 / 上下文 / 额度 / 本轮 token、失败原因。各项的做法和与 Claude Code 的差别见 README 的 Codex 一节。
   - 依据：Codex 0.167.2 的官方源码（`codex exec` 的参数与事件、会话记录和名称索引的格式）。本机没有装 Codex，下载的程序被权限规则拦住没有运行，所以只读了源码。
   - 没有做 `/compact`：`codex exec` 没有对应命令。
   - 为此改了中枢两处，对 Claude Code 没有影响：Agent 可以给出说明文件名（`instructionsName`）和新会话的默认目录（`sessionDir`）。会话列表的公共部分移到 `core/session-list.mjs`。

   以下取舍由 Agent 自行决定，未经用户确认：新会话默认仍在 `workspace` 里（会话目录就是沙箱可写范围，放到主目录会放大写入范围）；`/rename` 的名称存在桥接程序自己的文件里，不写 Codex 的名称索引（那个文件要求加文件锁，Node.js 做不到）；`/usage` 取最近一次回答时的数据。

## 验证

- `/delete` 批量：`test/delete.test.mjs` 新增一条测试；真实飞书未试。
- Windows 适配：
  - 本机（Linux）`npm test` 通过，`node service.mjs doctor` 用真实配置通过。
  - GitHub 的测试工作流在 Linux、macOS、Windows 上都通过（`98d5182`，2026-11-12）。Windows 上 88 条里 86 条通过、2 条跳过（systemd 和 launchd 的配置文件测试）。第一次运行有 4 条失败，都是测试写死了 Unix 路径或进程号 1，产品代码没有改。
  - Windows 上真实执行过的：用 `taskkill` 结束进程树、PowerShell 查进程命令行、守护进程的启动和停止、`install` / `uninstall` 写入和删除注册表启动项（这一条只在 CI 的 Windows 机器上运行）。
  - 仍未验证：真实的 `lark-cli` 和 Claude Code 在 Windows 上的表现；真实的 `.cmd` 启动脚本（只测了解析）；重新登录后是否真的自启；真实飞书消息。这些需要一台真实的 Windows 机器。

- Codex 模块：按用户要求没有做测试。只用一份按源码格式伪造的会话记录自查了一遍（列表、切换、改名、用量、删除、参数生成不报错），原有 88 条测试照常通过。**没有用真实的 Codex 运行过**，会话记录格式是否与真实文件一致也未确认。

## 当前状态

- `/delete` 批量：已推送到 `main`（`f965fe1`），没有打标签；本机服务 2026-11-12 07:47（UTC）重启后生效。
- Windows 适配：已推送到 `main`（`47b8da6`、`4c54a5f`、`98d5182`），没有打标签。
- Codex 模块：只改在工作区，未提交、未推送；本机服务用的是 Claude Code，不受影响，也没有重启。
