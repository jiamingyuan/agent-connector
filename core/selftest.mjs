// Connection test ("接入测试", /test): checks a running bridge against the real agent and the real
// channel, where `npm test` uses fake CLIs and `doctor` only looks at the environment.
// The checks here follow the interfaces in core/README.md, so they apply to every agent and
// channel: a feature a module does not provide is reported as skipped. A module adds what only it
// knows through its `selfTest` field: { model, effort, checks } for an agent, { checks } for a channel.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';

export const PASS = 'pass', FAIL = 'fail', SKIP = 'skip';
const TURN_TIMEOUT_MS = 5 * 60_000;
const STEP_TIMEOUT_MS = 6 * 60_000;

class Skipped extends Error {}
// A check calls this when it does not apply; the reason is shown to the user.
export function skip(reason) { throw new Skipped(reason); }
const code = () => `AC-${randomBytes(4).toString('hex').toUpperCase()}`;
const said = (answer, word) => String(answer || '').replace(/\s+/g, '').includes(word);
const short = text => { const line = String(text || '').replace(/\s+/g, ' ').trim(); return line.length > 80 ? `${line.slice(0, 80)}…` : line; };

// A one-colour PNG, built here so the image check needs no file shipped with the project.
export function solidPng(size, [red, green, blue]) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3)]);
  for (let x = 0; x < size; x++) row.set([red, green, blue], 1 + x * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

// Runs the checks in order. A check passes when run() returns (its return value is a note for the
// report), is skipped when `when` gives a reason or run() calls skip(), and fails when run() throws.
export async function runChecks(checks, context, { stopped = () => false } = {}) {
  const results = [];
  for (const check of checks) {
    const result = { id: check.id, title: check.title, status: SKIP, detail: '' };
    results.push(result);
    if (stopped()) { result.detail = '测试已停止'; continue; }
    const reason = check.when?.(context);
    if (typeof reason === 'string') { result.detail = reason; continue; }
    let timer;
    try {
      const limit = new Promise((_, reject) => { timer = setTimeout(() => { context.abort?.(); reject(new Error(`超过 ${Math.round((check.timeoutMs || STEP_TIMEOUT_MS) / 60_000)} 分钟没有完成`)); }, check.timeoutMs || STEP_TIMEOUT_MS); });
      result.detail = (await Promise.race([check.run(context), limit])) || '';
      result.status = PASS;
    } catch (error) {
      result.status = error instanceof Skipped ? SKIP : FAIL;
      result.detail = short(error.message) || '失败';
    } finally { clearTimeout(timer); }
  }
  return results;
}

const MARK = { [PASS]: '✅', [FAIL]: '❌', [SKIP]: '➖' };
export const tally = results => ({ pass: results.filter(item => item.status === PASS).length, fail: results.filter(item => item.status === FAIL).length,
  skip: results.filter(item => item.status === SKIP).length });
export function formatReport(title, results) {
  const { pass, fail, skip: skipped } = tally(results);
  return [`**${title}**：通过 ${pass} 项，失败 ${fail} 项，跳过 ${skipped} 项`,
    ...results.map(item => `${MARK[item.status]} ${item.title}${item.detail ? `：${item.detail}` : ''}`)].join('\n');
}

// ---- agent ----
// What the agent checks run in: one session of their own, started by the first check, in the
// directory a new chat would use. `scratch` is a private folder in the workspace for the files the
// checks hand to the agent; `outbox` is where the agent is asked to save a file.
export function agentContext({ agent, config, cwd, scratch, outbox }) {
  let current = null, stopped = false, turns = 0;
  const instructions = path.join(config.workspace, agent.instructionsName || 'CLAUDE.md');
  const context = {
    agent, config, cwd, scratch, outbox, session: { id: undefined, name: undefined }, stats: {},
    // Waits for one piece of agent work ({ cancel, result }), so that a stop or a timeout can end it.
    async wait(job) {
      if (stopped) { job.cancel(); throw new Error('测试已停止'); }
      current = job;
      try { return await job.result; } finally { if (current === job) current = null; }
    },
    // One real turn. Without `fresh` it continues the test session.
    turn(text, { fresh = false, ...request } = {}) {
      return context.wait(agent.runTurn({ sessionId: fresh ? undefined : context.session.id, cwd, text, images: [], files: [],
        timeoutMs: TURN_TIMEOUT_MS, turnKey: `selftest-${Date.now()}-${turns++}`,
        instructionsFile: cwd !== config.workspace && fs.existsSync(instructions) ? instructions : undefined, ...request,
        onSession: id => { if (!fresh) context.session.id = id; },
        onStats: stats => Object.assign(context.stats, stats) }));
    },
    // A turn whose answer is needed: null means it was stopped.
    async ask(text, request) {
      const answer = await context.turn(text, request);
      if (answer === null) throw new Error('任务被停止');
      return answer;
    },
    abort() { current?.cancel(); },
    stop() { stopped = true; current?.cancel(); },
  };
  return context;
}

export const needsSession = context => (context.session.id ? undefined : '没有测试会话（“对话”一项没有通过，或 Agent 没有报告会话 ID）');
const unsupported = (agent, what) => `${agent.displayName} 没有提供${what}`;

// Checks for every feature of the agent interface, then the agent's own, then the cleanup.
export function agentChecks(agent) {
  const hints = agent.selfTest || {};
  const sessions = agent.sessions;
  const find = context => sessions.list({ exclude: [] }).find(session => session.id === String(context.session.id).toLowerCase() || session.id === context.session.id);
  const words = {};
  return [
    { id: 'turn', title: '对话', async run(context) {
      words.first = code();
      const answer = await context.ask(`这是 agent-connector 的接入测试，不需要做任何别的事。请只回复下面这串字符，不要加别的内容：${words.first}`, { fresh: false });
      if (!said(answer, words.first)) throw new Error(`回答里没有要求的字符（回答：${short(answer)}）`);
      return context.session.id ? '' : 'Agent 没有报告会话 ID，每条消息都会是新会话';
    } },
    { id: 'resume', title: '续接会话', when: needsSession, async run(context) {
      const answer = await context.ask('上一条消息让你回复的那串字符是什么？只回复那串字符。');
      if (!said(answer, words.first)) throw new Error(`没有记住上一轮的内容（回答：${short(answer)}）`);
    } },
    { id: 'image', title: '看图片', when: () => (agent.capabilities.images ? undefined : unsupported(agent, '图片输入')), async run(context) {
      const file = path.join(context.scratch, 'selftest.png'), bytes = solidPng(96, [220, 30, 30]);
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      const answer = await context.ask('这张图片整体是什么颜色？只回答一个词。', { images: [{ path: file, mediaType: 'image/png', data: bytes.toString('base64') }] });
      if (!/红|red/i.test(answer)) throw new Error(`没有认出图片的颜色（回答：${short(answer)}）`);
    } },
    { id: 'file', title: '读收到的文件', when: () => (agent.capabilities.files ? undefined : unsupported(agent, '文件输入')), async run(context) {
      words.file = code();
      const file = path.join(context.scratch, 'selftest.txt');
      fs.writeFileSync(file, `接入测试文件。验证码：${words.file}\n`, { mode: 0o600 });
      const answer = await context.ask(`请读取这个文件，只回复其中的验证码。\n\n[桥接附件信息]\n用户发来了文件，已保存在本机：\n- selftest.txt：${file}`,
        { files: [{ path: file, name: 'selftest.txt', size: fs.statSync(file).size }] });
      if (!said(answer, words.file)) throw new Error(`没有读到文件内容（回答：${short(answer)}）`);
    } },
    { id: 'outbox', title: '保存要发回的文件', when: () => (agent.capabilities.files ? undefined : unsupported(agent, '文件输出')), async run(context) {
      words.out = code();
      const file = path.join(context.outbox, 'selftest-out.txt');
      await context.ask(`请在目录 ${context.outbox} 里新建文件 selftest-out.txt，内容只写这串字符：${words.out}。完成后回复“已完成”。`, { outbox: context.outbox });
      if (!fs.existsSync(file) || !said(fs.readFileSync(file, 'utf8'), words.out)) throw new Error('目录里没有出现要求的文件（当前权限模式可能不允许写文件）');
    } },
    { id: 'modes', title: '权限模式', when: context => (agent.modes ? needsSession(context) : unsupported(agent, '权限模式')), async run(context) {
      // Modes that need a private chat are the high-risk ones; they are not exercised here.
      const names = Object.keys(agent.modes.descriptions).filter(name => !agent.modes.privateOnly?.includes(name));
      const failed = [];
      for (const mode of names) {
        try { await context.ask('接入测试：请只回复 OK。', { mode }); } catch (error) { failed.push(`${mode}（${short(error.message)}）`); }
      }
      if (failed.length) throw new Error(`这些模式下没有完成：${failed.join('、')}`);
      return `${names.join('、')}${agent.modes.privateOnly?.length ? `；未测高风险的 ${agent.modes.privateOnly.join('、')}` : ''}`;
    } },
    { id: 'model', title: '切换模型', when: context => (!agent.models ? unsupported(agent, '模型切换') : !hints.model ? '这个 Agent 模块没有指定测试用的模型' : needsSession(context)), async run(context) {
      await context.ask('接入测试：请只回复 OK。', { model: hints.model });
      return `${hints.model}${context.stats.model ? `（实际 ${context.stats.model}）` : ''}`;
    } },
    { id: 'effort', title: '切换推理深度', when: context => (agent.efforts ? needsSession(context) : unsupported(agent, '推理深度切换')), async run(context) {
      const effort = hints.effort || Object.keys(agent.efforts.descriptions)[0];
      if (!effort) skip('这个 Agent 模块没有列出可选的推理深度');
      await context.ask('接入测试：请只回复 OK。', { effort });
      return effort;
    } },
    { id: 'stats', title: '回复卡片上的统计', when: needsSession, run(context) {
      const got = ['model', 'context', 'quota', 'turn'].filter(key => context.stats[key] !== undefined);
      if (!got.length) skip('Agent 没有报告模型、上下文、额度或本轮用量，卡片上不会显示这些');
      const names = { model: '模型', context: '上下文', quota: '额度', turn: '本轮用量' };
      return `已报告${got.map(key => names[key]).join('、')}${got.length < 4 ? `；未报告${Object.keys(names).filter(key => !got.includes(key)).map(key => names[key]).join('、')}` : ''}`;
    } },
    { id: 'rename', title: '/rename 改名', when: context => (agent.rename ? needsSession(context) : unsupported(agent, '会话改名')), async run(context) {
      const name = `接入测试 ${code().slice(3, 7)}`;
      const final = await context.wait(agent.rename({ sessionId: context.session.id, cwd: context.cwd, name, timeoutMs: TURN_TIMEOUT_MS }));
      if (!String(final || '').includes(name)) throw new Error(`返回的名称不是要求的（${short(final)}）`);
      context.session.name = name;
    } },
    { id: 'sessions', title: '/sessions 会话列表', when: context => (sessions ? needsSession(context) : unsupported(agent, '会话列表')), run(context) {
      const session = find(context);
      if (!session) throw new Error('列表里找不到测试会话');
      if (context.session.name && session.name !== context.session.name) throw new Error(`列表里的名称没有更新（${short(session.name)}）`);
      context.session.file = session.file; context.session.entry = session;
      const digest = session.file ? sessions.digest(session.file) : {};
      return !session.file || digest.prompt || digest.reply ? '' : '读不出最近一轮的摘录';
    } },
    { id: 'recap', title: '/switch 前情梗概', when: context => (sessions ? needsSession(context) : unsupported(agent, '会话切换')), async run(context) {
      const before = context.session.file && fs.existsSync(context.session.file) ? fs.statSync(context.session.file) : null;
      const recap = await context.wait(sessions.recap({ sessionId: context.session.id, cwd: context.cwd, timeoutMs: TURN_TIMEOUT_MS }));
      if (!String(recap || '').trim()) throw new Error('没有生成梗概');
      const after = before && fs.existsSync(context.session.file) ? fs.statSync(context.session.file) : null;
      if (before && (!after || after.size !== before.size)) throw new Error('生成梗概时改动了原会话的记录');
    } },
    { id: 'compact', title: '/compact 压缩上下文', when: context => (agent.compact ? needsSession(context) : unsupported(agent, '上下文压缩')), async run(context) {
      const text = await context.wait(agent.compact({ sessionId: context.session.id, cwd: context.cwd, instructions: '', timeoutMs: TURN_TIMEOUT_MS, onStats() {} }));
      if (!String(text || '').trim()) throw new Error('没有返回压缩结果');
    } },
    { id: 'usage', title: '/usage 用量', when: () => (agent.usage ? undefined : unsupported(agent, '用量查询')), async run() {
      if (!String(await agent.usage() || '').trim()) throw new Error('没有返回用量');
    } },
    ...(hints.checks || []),
    { id: 'stop', title: '/stop 停止任务', when: needsSession, async run(context) {
      const job = agent.runTurn({ sessionId: context.session.id, cwd: context.cwd, text: '接入测试：请从 1 写到 3000，每个数字单独一行，全部写出来。', images: [], files: [],
        timeoutMs: TURN_TIMEOUT_MS, turnKey: `selftest-stop-${Date.now()}`, onSession() {}, onStats() {} });
      const started = Date.now();
      // Long enough for the agent to be at work; a module can say how long that is for it.
      setTimeout(() => job.cancel(), hints.stopAfterMs ?? 4000).unref();
      const answer = await context.wait(job).catch(() => undefined);
      if (answer === null) return `${Math.round((Date.now() - started) / 1000)} 秒内停下`;
      if (answer === undefined) throw new Error('停止时任务报错，而不是正常停下');
      skip('任务在发出停止之前就完成了，没有测到');
    } },
    { id: 'timeout', title: '超时停止', when: needsSession, async run(context) {
      // The agent must stop by itself at the turn's deadline and say so (core/README.md).
      const limit = hints.timeoutMs ?? 3000;
      const job = agent.runTurn({ sessionId: context.session.id, cwd: context.cwd, text: '接入测试：请从 1 写到 3000，每个数字单独一行，全部写出来。', images: [], files: [],
        timeoutMs: limit, turnKey: `selftest-timeout-${Date.now()}`, onSession() {}, onStats() {} });
      let timer;
      const late = new Promise(resolve => { timer = setTimeout(() => { job.cancel(); resolve('late'); }, limit + 20_000); });
      const outcome = await Promise.race([context.wait(job).then(answer => (answer === null ? 'stopped' : 'answered'), error => error), late]);
      clearTimeout(timer);
      if (outcome === 'late') throw new Error('过了时限 20 秒仍在运行');
      if (outcome === 'answered') skip('任务在时限之前就完成了，没有测到');
      if (outcome === 'stopped') throw new Error('测试被停止');
      if (outcome.code !== 'timeout') throw new Error(`停下了，但报的不是超时（${short(outcome.message)}）`);
    } },
    { id: 'delete', title: '/delete 删除会话', when: context => (!sessions?.trash ? unsupported(agent, '会话删除') : needsSession(context)), run(context) {
      const session = context.session.entry || find(context);
      if (!session) throw new Error('列表里找不到测试会话，没有删除');
      sessions.trash(session, context.trash);
      if (find(context)) throw new Error('删除后会话仍在列表里');
      context.session.deleted = true;
      return '测试会话已移到回收目录';
    } },
  ];
}

// ---- channel ----
// Channel checks get: the message that asked for the test (`message`, with the hub's fields), the
// channel, `entry(kind, fields)` for a reply entry to that message, `say(text)` to tell the user
// something, and `ask(text, accept)` for the steps that need the user: it shows the request and
// resolves to the next message for which accept(message) is true, or skips the check when the user
// answers "跳过" or does not answer in time.
export function channelChecks(channel) {
  const hints = channel.selfTest || {};
  const name = channel.displayName;
  const lacks = what => `${name}渠道没有提供${what}`;
  // Sent directly, not through the hub's queue, and strictly: a refused reply is the check's failure.
  const send = (context, kind, fields) => channel.send(context.entry(kind, fields), { strict: true });
  return [
    { id: 'receive', title: '接收消息', run: context => (context.message.id && context.message.userId ? '' : '消息缺少 ID 或发送者') },
    { id: 'react', title: '收到消息时的表情回应', async run(context) { await channel.acknowledge(context.message, { strict: true }); } },
    { id: 'text', title: '文字回复', async run(context) { await send(context, 'text', { format: 'text', text: '接入测试：这是一条纯文字回复。' }); } },
    { id: 'rich', title: '富文本回复', when: () => (channel.richText ? undefined : lacks('富文本回复')), async run(context) {
      await send(context, 'rich', { format: 'markdown', text: '**接入测试**：这是一条富文本回复。\n\n- 列表第一项\n- `行内代码` 和 [链接](https://example.com)\n\n```js\nconsole.log("代码块");\n```' });
      return '请看一眼加粗、列表和代码块是否正常显示';
    } },
    { id: 'card', title: '卡片回复', when: () => (channel.cards ? undefined : lacks('卡片回复（或没有开启）')), async run(context) {
      await send(context, 'card', { format: 'card', text: '接入测试：这是一张卡片回复，标题区应显示会话名、权限模式、模型和上下文。',
        card: { title: '接入测试', mode: { name: 'auto', risky: false }, model: 'test-model', effort: 'low', context: 12_345,
          quota: { fiveHour: { used: 0.25, resetsAt: Math.round(Date.now() / 1000) + 3600 } }, turn: { output: 12, newInput: 34, cacheRead: 56, seconds: 1 } } });
      return '请看一眼卡片的标题区和底部的用量是否正常显示';
    } },
    { id: 'send-file', title: '发回文件', when: () => (channel.fileReplies ? undefined : lacks('文件回复')), async run(context) {
      const file = path.join(context.scratch, '接入测试.txt');
      fs.writeFileSync(file, '这是接入测试发回的文件。\n', { mode: 0o600 });
      await send(context, 'file', { file, name: '接入测试.txt', userId: context.message.userId });
    } },
    { id: 'recall-read', title: '读取消息是否被撤回', when: () => (channel.isRecalled ? undefined : lacks('撤回状态查询（渠道自己上报撤回时不需要）')), async run(context) {
      if (await channel.isRecalled(context.message) !== false) throw new Error('把一条没有撤回的消息报成了已撤回');
    } },
    ...(hints.checks || []),
    { id: 'get-image', title: '接收图片', when: () => (channel.attachments ? undefined : lacks('图片接收')), async run(context) {
      const message = await context.ask('请发一张图片（不想测这一项就回复“跳过”）。', item => ['image', 'rich'].includes(item.kind));
      const images = await channel.attachments(message);
      if (!images.length) throw new Error('没有从这条消息里取到图片');
      for (const image of images) fs.rmSync(image.path, { force: true });
      return `取到 ${images.length} 张，${images[0].mediaType}`;
    } },
    { id: 'get-file', title: '接收文件', when: () => (channel.files ? undefined : lacks('文件接收')), async run(context) {
      const message = await context.ask('请发一个小文件（不想测这一项就回复“跳过”）。', item => ['file', 'rich'].includes(item.kind));
      const files = await channel.files(message);
      if (!files.length) throw new Error('没有从这条消息里取到文件');
      for (const file of files) fs.rmSync(file.path, { force: true });
      return `取到「${short(files[0].name)}」`;
    } },
    { id: 'recall', title: '撤回消息后中断', when: () => (channel.isRecalled ? undefined : '这个渠道自己上报撤回，不在这里测'), async run(context) {
      const message = await context.ask('请发任意一条文字消息，然后在 30 秒内把它撤回（不想测这一项就回复“跳过”）。', item => item.kind === 'text');
      for (let waited = 0; waited < 45_000; waited += 3000) {
        if (await channel.isRecalled(message).catch(() => false)) return `撤回后约 ${Math.round(waited / 1000)} 秒发现`;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      throw new Error('45 秒内没有发现这条消息被撤回');
    } },
  ];
}
