// The connection test (/test): offered once, run feature by feature against the agent and the
// channel, with the steps that need the user, and stoppable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../core/hub.mjs';
import { solidPng, runChecks, skip, formatReport } from '../core/selftest.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, tries = 600) {
  for (let i = 0; i < tries; i++) { if (check()) return; await wait(10); }
  assert.fail(`timed out waiting for ${label}`);
}

// A stub agent that behaves like a model for the test prompts and keeps its sessions in memory,
// and a stub channel that records what it is asked to send. `broken` names behaviours to break.
async function setup(t, { broken = [], config = {}, agentExtras = {}, channelExtras = {} } = {}) {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'selftest-test-'));
  const sent = [], logs = [], calls = [], store = new Map(), hanging = [];
  let handlers, counter = 0;
  const job = answer => ({ cancel() {}, result: Promise.resolve(answer) });
  const agent = {
    id: 'stub', displayName: 'Stub', capabilities: { images: true, files: true },
    runTurn({ sessionId, text, images, mode, model, effort, timeoutMs, onSession, onStats }) {
      const id = sessionId || `session-${++counter}`;
      calls.push({ id, text, images: images.length, mode, model, effort });
      onSession(id);
      onStats({ model: model || 'stub-1', context: 1234, turn: { output: 1, newInput: 2, cacheRead: 3 } });
      const session = store.get(id) || { id, name: '', turns: [] };
      store.set(id, session);
      session.turns.push(text);
      const word = /不要加别的内容：(AC-\w+)/.exec(text)?.[1];
      if (word) { session.word = word; return job(word); }
      if (text.includes('上一条消息让你回复')) return job(broken.includes('resume') ? '不记得了' : session.word);
      if (text.includes('什么颜色')) return job(images.length === 1 ? '红色' : '看不到图片');
      if (text.includes('只回复其中的验证码')) return job(/验证码：(AC-\w+)/.exec(fsSync.readFileSync(/selftest\.txt：(.+)$/m.exec(text)[1], 'utf8'))[1]);
      if (text.includes('新建文件 selftest-out.txt')) {
        if (!broken.includes('outbox')) fsSync.writeFileSync(path.join(/请在目录 (.+?) 里新建文件/.exec(text)[1], 'selftest-out.txt'), /只写这串字符：(AC-\w+)/.exec(text)[1]);
        return job('已完成');
      }
      if (text.includes('从 1 写到 3000')) {
        let finish, fail;
        const turn = { cancelled: false };
        hanging.push(turn);
        const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
        // Like a real agent: stops by itself at the deadline.
        setTimeout(() => fail(Object.assign(new Error('任务超时已停止。'), { code: 'timeout' })), timeoutMs).unref();
        return { cancel() { turn.cancelled = true; finish(null); }, result };
      }
      if (mode === 'strict' && broken.includes('mode')) return { cancel() {}, result: Promise.reject(new Error('mode refused')) };
      return job('OK');
    },
    modes: { descriptions: { normal: 'n', strict: 's', danger: 'd' }, resolve: override => override || 'normal', find: name => name, privateOnly: ['danger'] },
    models: { descriptions: {}, resolve: override => override, find: name => name },
    efforts: { descriptions: { low: 'l', high: 'h' }, resolve: override => override, find: name => name },
    selfTest: { model: 'stub-small', stopAfterMs: 30, timeoutMs: 60, checks: [{ id: 'own', title: '模块自己的检查', run: context => `会话 ${context.session.id}` }] },
    usage: async () => '用量 10%', usageLabel: '用量',
    rename: ({ sessionId, name }) => { store.get(sessionId).name = name; return job(name); },
    compact: () => job('已压缩'),
    sessions: {
      list: () => [...store.values()].map(session => ({ id: session.id, name: session.name || session.turns[0].slice(0, 10), cwd: runtime, mtimeMs: Date.now(), headless: false })),
      filter: list => list, pick: () => [], running: () => new Map(), digest: () => ({ prompt: 'p', reply: 'r' }),
      format: () => 'list', ago: () => '刚刚', resumeHint: id => `stub resume ${id}`,
      recap: () => job('- 目标：接入测试'),
      trash: session => { store.delete(session.id); return { trash: 't', restoreTo: 'r' }; },
    },
    ...agentExtras,
  };
  const channel = {
    id: 'stub', displayName: '测试', richText: true, cards: true, fileReplies: { maxBytes: 1024 }, formatNote: '',
    start(h) { handlers = h; h.ready(); }, stop() {},
    send: async (entry, options) => {
      if (entry.card && options?.strict && broken.includes('card')) throw new Error('card refused');
      sent.push(entry);
    },
    isPermanentSendError: () => false,
    acknowledge: async (message, options) => { if (broken.includes('react') && options?.strict) throw new Error('no reaction'); },
    isRecalled: async message => message.id === 'gone',
    attachments: async message => (message.kind === 'image' ? [{ path: path.join(runtime, 'none.png'), mediaType: 'image/png', data: '' }] : []),
    files: async message => (message.kind === 'file' ? [{ path: path.join(runtime, 'none.bin'), name: '报告.pdf', size: 3 }] : []),
    selfTest: { checks: [{ id: 'heavy', title: '很重的检查', manual: true, run: () => '做了' }] },
    ...channelExtras,
  };
  const hub = createHub({ config: { workspace: runtime, sessionDir: runtime, turnTimeoutMs: 5000, botName: 'Cora', ...config },
    agent, channel, runtime, log: (type, fields) => logs.push({ type, ...fields }) });
  hub.start();
  t.after(async () => { hub.shutdown(); await fs.rm(runtime, { recursive: true, force: true }); });
  const message = (id, text, extra = {}) => handlers.message({ id, chatId: 'chat', chatType: 'private', userId: 'u1', kind: 'text', text, ...extra });
  const texts = kind => sent.filter(entry => entry.kind === kind).map(entry => entry.text);
  const state = () => JSON.parse(fsSync.readFileSync(path.join(runtime, 'state.json'), 'utf8'));
  return { runtime, sent, logs, calls, store, hanging, message, texts, state };
}

test('the first private message after an agent or bot is connected is asked once whether to test', async t => {
  const { sent, message, texts, state } = await setup(t);
  message('m1', '你好');
  await until(() => texts('answer').length === 1, 'the first answer');
  message('m2', '继续');
  await until(() => texts('answer').length === 2, 'the second answer');
  const offers = texts('test-offer');
  assert.equal(offers.length, 1, 'asked once, not with every message');
  assert(offers[0].includes('Agent Stub') && offers[0].includes('机器人 Cora') && offers[0].includes('/test all'), offers[0]);
  assert(state().selftest.agents.stub.offeredAt && state().selftest.bots.default.offeredAt);
  // A group chat is not asked, and neither is anyone with the notice switched off.
  const quiet = await setup(t, { config: { offerSelfTest: false } });
  quiet.message('m1', '你好');
  await until(() => quiet.texts('answer').length === 1, 'the answer');
  assert.equal(quiet.texts('test-offer').length, 0);
  assert(sent.every(entry => entry.kind !== 'test-check'), 'nothing was tested without being asked');
});

test('/test lists the checks; /test all runs every agent and channel check and reports each one', { timeout: 30_000 }, async t => {
  const { runtime, sent, calls, store, hanging, message, texts, state } = await setup(t, { config: { offerSelfTest: false } });
  message('m0', '/test');
  await until(() => texts('test').length === 1, 'the overview');
  const overview = texts('test')[0];
  for (const part of ['turn 对话', 'own 模块自己的检查', 'get-image 接收图片', 'heavy 很重的检查（只在点名时运行）', '/test all', '还没有做过']) assert(overview.includes(part), `${part}\n${overview}`);
  assert.equal(calls.length, 0, 'the overview runs nothing');

  message('m1', '/test all');
  // The channel part asks for an image, a file and a withdrawn message, one after the other.
  await until(() => texts('test-note-1').length === 1, 'the request for an image');
  assert(texts('test-note-1')[0].startsWith('请发一张图片'));
  message('text-instead', '这是文字');
  await until(() => texts('test-note-2').length === 1, 'the reminder');
  message('img', '', { kind: 'image' });
  await until(() => texts('test-note-3').length === 1, 'the request for a file');
  message('skip-file', '跳过');
  await until(() => texts('test-note-4').length === 1, 'the request for a withdrawn message');
  message('gone', '撤回我');
  message('later', '稍后处理');
  await until(() => texts('test-channel').length === 1, 'the channel report', 1500);

  const agentReport = texts('test-agent')[0], channelReport = texts('test-channel')[0];
  assert(agentReport.startsWith('**Agent：Stub**：通过 18 项，失败 0 项，跳过 0 项'), agentReport);
  for (const line of ['✅ 对话', '✅ 续接会话', '✅ 看图片', '✅ 读收到的文件', '✅ 保存要发回的文件', '✅ 权限模式：normal、strict；未测高风险的 danger',
    '✅ 切换模型：stub-small（实际 stub-small）', '✅ 切换推理深度：low', '✅ 回复卡片上的统计：已报告模型、上下文、本轮用量；未报告额度', '✅ /rename 改名', '✅ /sessions 会话列表',
    '✅ /switch 前情梗概', '✅ /compact 压缩上下文', '✅ /usage 用量', '✅ 模块自己的检查：会话 session-1', '✅ /stop 停止任务：0 秒内停下', '✅ 超时停止', '✅ /delete 删除会话：测试会话已移到回收目录']) assert(agentReport.includes(line), `${line}\n${agentReport}`);
  assert(channelReport.startsWith('**渠道：测试（Cora）**：通过 9 项，失败 0 项，跳过 1 项'), channelReport);
  for (const line of ['✅ 接收消息', '✅ 收到消息时的表情回应', '✅ 文字回复', '✅ 富文本回复', '✅ 卡片回复', '✅ 发回文件', '✅ 读取消息是否被撤回',
    '✅ 接收图片：取到 1 张，image/png', '➖ 接收文件：已按你的回复跳过', '✅ 撤回消息后中断']) assert(channelReport.includes(line), `${line}\n${channelReport}`);
  assert(!channelReport.includes('很重的检查'), 'a check marked manual is left out of "all"');

  // Everything ran in one test session, which is gone again.
  const testCalls = calls.filter(call => !call.text.startsWith('稍后处理'));
  assert.deepEqual([...new Set(testCalls.map(call => call.id))], ['session-1']);
  assert(!store.has('session-1'));
  assert.equal(hanging[0].cancelled, true);
  assert.deepEqual(testCalls.filter(call => call.mode).map(call => call.mode), ['normal', 'strict']);
  // The channel got one entry of each kind it can send.
  const tests = sent.filter(entry => entry.kind === 'test-check');
  assert.deepEqual(tests.map(entry => entry.format || (entry.file ? 'file' : '')), ['text', 'markdown', 'card', 'file']);
  assert.deepEqual({ ...state().selftest.agents.stub.last, at: 0 }, { at: 0, pass: 18, fail: 0, skip: 0 });
  assert.equal(state().selftest.bots.default.last.pass, 9);
  // A message the test did not use is answered afterwards as a normal one; the one sent in place
  // of the image was the test's to deal with.
  await until(() => texts('answer').length === 1, 'the left-over message to be answered');
  assert.equal(calls.at(-1).text.split('\n')[0], '稍后处理');
  // It started the chat's own session: the test session never became the chat's.
  assert.equal(calls.at(-1).id, 'session-2');
  assert.equal(state().sessions.chat.id, 'session-2');
  assert(!calls.some(call => call.text.startsWith('这是文字')));
  // Nothing of the test is left in the workspace.
  assert.deepEqual([fsSync.readdirSync(path.join(runtime, 'attachments')), fsSync.readdirSync(path.join(runtime, 'outbox'))], [[], []]);
});

test('failures and unsupported features are reported as such; single checks and manual ones run by name', { timeout: 30_000 }, async t => {
  const broken = await setup(t, { broken: ['resume', 'outbox', 'mode', 'card', 'react'], config: { offerSelfTest: false },
    agentExtras: { compact: undefined, usage: undefined, capabilities: { images: false, files: true } }, channelExtras: { attachments: undefined, files: undefined, isRecalled: undefined } });
  broken.message('m1', '/test all');
  await until(() => broken.texts('test-channel').length === 1, 'both reports', 1500);
  const agentReport = broken.texts('test-agent')[0], channelReport = broken.texts('test-channel')[0];
  for (const line of ['❌ 续接会话：没有记住上一轮的内容（回答：不记得了）', '➖ 看图片：Stub 没有提供图片输入', '❌ 保存要发回的文件：目录里没有出现要求的文件',
    '❌ 权限模式：这些模式下没有完成：strict（mode refused）', '➖ /compact 压缩上下文：Stub 没有提供上下文压缩', '➖ /usage 用量：Stub 没有提供用量查询', '✅ /delete 删除会话']) assert(agentReport.includes(line), `${line}\n${agentReport}`);
  for (const line of ['❌ 收到消息时的表情回应：no reaction', '❌ 卡片回复：card refused', '➖ 接收图片：测试渠道没有提供图片接收', '➖ 撤回消息后中断：这个渠道自己上报撤回，不在这里测']) assert(channelReport.includes(line), `${line}\n${channelReport}`);

  const single = await setup(t, { config: { offerSelfTest: false } });
  single.message('m1', '/test usage heavy');
  await until(() => single.texts('test-channel').length === 1, 'the reports of a named run');
  // A named agent check brings the test session and its removal with it.
  assert(single.texts('test-agent')[0].startsWith('**Agent：Stub**：通过 3 项'), single.texts('test-agent')[0]);
  assert(single.texts('test-channel')[0].includes('✅ 很重的检查：做了') && single.texts('test-channel')[0].startsWith('**渠道：测试（Cora）**：通过 1 项'));
  single.message('m2', '/test nothing-like-this');
  await until(() => single.texts('test').length === 1, 'the answer to an unknown name');
  assert(single.texts('test')[0].startsWith('没有叫「nothing-like-this」的测试项。'));
  single.message('m3', '/test all', { chatType: 'group' });
  await until(() => single.texts('test').length === 2, 'the refusal in a group');
  assert.equal(single.texts('test')[1], '接入测试只能在私聊中进行。');
});

test('/stop ends a running test: the current turn is cancelled and the rest is reported as stopped', { timeout: 30_000 }, async t => {
  let release;
  const { hanging, message, texts } = await setup(t, { config: { offerSelfTest: false },
    agentExtras: { usage: () => new Promise(resolve => { release = resolve; }) } });
  message('m1', '/test agent');
  await until(() => typeof release === 'function', 'the test to reach the slow check');
  message('stop', '/stop');
  release('late');
  await until(() => texts('test-agent').length === 1, 'the report');
  const report = texts('test-agent')[0];
  assert(report.includes('➖ /stop 停止任务：测试已停止') && report.includes('➖ 超时停止：测试已停止') && report.includes('➖ /delete 删除会话：测试已停止'), report);
  assert(report.includes('没有删除'), 'the user is told the test session is still there');
  assert.equal(hanging.length, 0);
  assert.equal(texts('test-channel').length, 0);
});

test('the test image is a valid PNG; a check passes, fails or is skipped by what it does', async () => {
  const png = solidPng(4, [1, 2, 3]);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.equal(png.readUInt32BE(16), 4);
  const results = await runChecks([
    { id: 'a', title: '甲', run: () => '备注' }, { id: 'b', title: '乙', run: () => { throw new Error('坏了'); } },
    { id: 'c', title: '丙', run: () => skip('不适用') }, { id: 'd', title: '丁', when: () => '没有这个功能', run: () => assert.fail('must not run') },
    { id: 'e', title: '戊', timeoutMs: 20, run: () => new Promise(() => {}) },
  ], {});
  assert.deepEqual(results.map(item => item.status), ['pass', 'fail', 'skip', 'skip', 'fail']);
  assert.equal(formatReport('标题', results), '**标题**：通过 1 项，失败 2 项，跳过 2 项\n✅ 甲：备注\n❌ 乙：坏了\n➖ 丙：不适用\n➖ 丁：没有这个功能\n❌ 戊：超过 0 分钟没有完成');
});
