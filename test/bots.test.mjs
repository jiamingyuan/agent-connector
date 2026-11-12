// Several bots on one agent: each has its own chats, may be limited in the sessions, permission
// modes and models it can use, and cannot enter a session another bot is in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBridge, privateEvent } from './harness.mjs';
import { createHub } from '../core/hub.mjs';
import { botConfigs, accessOf } from '../core/bots.mjs';

const ids = { alpha: 'aaaaaaaa-0000-4000-8000-000000000001', beta: 'bbbbbbbb-0000-4000-8000-000000000002' };
const user = (cwd, content) => ({ type: 'user', cwd, entrypoint: 'cli', message: { role: 'user', content } });
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('bot settings: inherited from the top level, ids unique, access defaults to all', () => {
  const [single] = botConfigs({ botName: 'Cora', profile: 'p' });
  assert.deepEqual([single.id, single.name, single.access], ['', 'Cora', { sessions: 'all', modes: 'all', models: 'all' }]);
  const bots = botConfigs({ larkBin: '/bin/lark', profile: 'p1', bots: [{ name: 'Cora' }, { name: 'Dana', id: 'd', profile: 'p2', access: { sessions: ['/srv/app/'], modes: ['plan'] } }] });
  assert.deepEqual(bots.map(bot => [bot.id, bot.config.profile, bot.config.larkBin, bot.config.botName]), [['Cora', 'p1', '/bin/lark', 'Cora'], ['d', 'p2', '/bin/lark', 'Dana']]);
  assert.deepEqual(bots[1].access, { sessions: [path.resolve('/srv/app')], modes: ['plan'], models: 'all' });
  assert.equal(accessOf({ sessions: 'own' }).sessions, 'own');
  assert.throws(() => botConfigs({ bots: [{ name: 'A' }, { name: 'A' }] }), /already uses the id "A"/);
  assert.throws(() => botConfigs({ bots: [{ name: 'a:b' }] }), /must not be empty or contain ":"/);
  assert.throws(() => botConfigs({ bots: [] }), /non-empty list/);
  assert.throws(() => accessOf({ sessions: ['relative/dir'] }), /absolute directories/);
  assert.throws(() => accessOf({ models: [] }), /"all" or a non-empty list/);
});

test('two bots share one agent: limited sessions, modes and models, and one bot per session', { timeout: 30_000 }, async t => {
  const steps = [
    ['fake', '/sessions'], ['dana', '/sessions'], ['dana', '/switch bbbbbbbb'], ['fake', '/switch aaaaaaaa'], ['dana', '/switch aaaaaaaa'],
    ['dana', '/mode bypass'], ['dana', '/model opus'], ['dana', '/model'], ['dana', '你好'], ['fake', '/new'], ['dana', '/switch aaaaaaaa'],
    ['dana', '/status'], ['fake', '/delete aaaaaaaa'], ['fake', '/status'], ['dana', '/model claude-haiku-5-5'], ['dana', '继续'],
  ];
  let project;
  const { replies, calls, state } = await runBridge(t, async root => {
    const home = path.join(root, 'claude-home'), other = path.join(root, 'other');
    project = path.join(root, 'proj');
    for (const dir of [project, other]) await fs.mkdir(dir);
    const transcript = async (cwd, id, title, ageMs) => {
      const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${id}.jsonl`);
      await fs.writeFile(file, [user(cwd, '开始'), assistant('好的'), { type: 'custom-title', customTitle: title }].map(entry => JSON.stringify(entry)).join('\n') + '\n');
      const time = new Date(Date.now() - ageMs);
      await fs.utimes(file, time, time);
    };
    await transcript(project, ids.alpha, 'alpha 项目', 60_000);
    await transcript(other, ids.beta, 'beta 项目', 120_000);
    return { events: steps.map(([profile, content]) => ({ ...privateEvent, profile, content })), env: { CLAUDE_CONFIG_DIR: home },
      // Recorded before the config had bots: belongs to the first bot from now on.
      state: { sessions: {}, efforts: { oc_private: 'high' }, seen: [], outbox: [] },
      config: { bots: [{ name: 'Cora' }, { name: 'Dana', profile: 'dana', access: { sessions: [project], modes: ['auto', 'plan'], models: ['Sonnet', 'claude-haiku-5-5'] } }] } };
  });
  const text = replies.map(r => r.text);
  // Each bot answers through its own profile.
  assert.deepEqual(replies.map(r => r.profile), steps.map(([profile]) => profile));
  assert(text[0].includes('alpha 项目') && text[0].includes('beta 项目'), text[0]);
  assert(text[1].includes('alpha 项目') && !text[1].includes('beta 项目'), text[1]);
  assert.match(text[2], /^没有找到会话「bbbbbbbb」/);
  assert.match(text[3], /^已进入会话「alpha 项目」/);
  assert.equal(text[4], '会话「alpha 项目」正由机器人 Cora 开着，不能同时进入。在 Cora 那边发 /new 或 /switch 离开后再试。');
  assert.equal(text[5], '机器人 Dana 不能使用 bypassPermissions 模式（可用：auto、plan）。');
  assert.equal(text[6], '机器人 Dana 不能使用模型 opus（可用：sonnet、claude-haiku-5-5）。');
  assert(text[7].startsWith('当前模型：sonnet（默认）') && text[7].includes('claude-haiku-5-5') && !text[7].includes('opus'), text[7]);
  assert.match(text[10], /^已进入会话「alpha 项目」/);
  for (const line of ['机器人：Dana', `可访问的会话：${project} 目录下的会话`, '可用权限模式：auto、plan', '可用模型：sonnet、claude-haiku-5-5']) assert(text[11].includes(line), text[11]);
  assert.equal(text[12], '会话「alpha 项目」正由机器人 Dana 开着，不能删除。');
  assert(text[13].includes('机器人：Cora') && text[13].includes('推理深度：high（/effort 切换）') && !text[13].includes('可访问的会话'), text[13]);
  // Dana's new session starts in the first directory it may use, on the first model it may use.
  const flag = (call, name) => (call.args.includes(name) ? call.args[call.args.indexOf(name) + 1] : null);
  const turns = calls.filter(call => !call.summary && !call.input.startsWith('/rename'));
  assert.deepEqual(turns.map(call => [call.input.split('\n')[0], call.cwd, call.resumed, flag(call, '--model'), call.mode]),
    [['你好', project, null, 'sonnet', 'auto'], ['继续', project, ids.alpha, 'claude-haiku-5-5', 'auto']]);
  assert.deepEqual(Object.keys(state.sessions), ['Dana:oc_private']);
  assert.equal(state.sessions['Dana:oc_private'].id, ids.alpha);
  assert.deepEqual([state.efforts, state.models], [{ 'Cora:oc_private': 'high' }, { 'Dana:oc_private': 'claude-haiku-5-5' }]);
  assert.equal(Object.values(state.owners)[0], 'Dana');
});

// A hub with two stub bots on stub channels and an agent that answers at once.
async function stubHub(t, access, saved) {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'bots-test-'));
  if (saved) await fs.writeFile(path.join(runtime, 'state.json'), JSON.stringify(saved));
  const turns = [], replies = [], handlers = {};
  const agent = { id: 'stub', displayName: 'Stub', capabilities: { images: false, files: false },
    runTurn({ text, cwd, onSession }) { turns.push({ text: text.split('\n')[0], cwd }); onSession(`s${turns.length}`); return { cancel() {}, result: Promise.resolve(`answer ${turns.length}`) }; } };
  const bot = (id, scope) => ({ id, name: id, config: { botName: id }, access: accessOf(scope),
    channel: { id: 'stub', displayName: 'Stub', richText: false, start(h) { handlers[id] = h; h.ready(); }, stop() {},
      send: async entry => { replies.push({ bot: id, ...entry }); }, isPermanentSendError: () => false, acknowledge: async () => {} } });
  const hub = createHub({ config: { offerSelfTest: false, workspace: runtime, turnTimeoutMs: 5000 }, agent, bots: [bot('one'), bot('two', access)], runtime, log() {} });
  hub.start();
  t.after(async () => { hub.shutdown(); await fs.rm(runtime, { recursive: true, force: true }); });
  const until = async count => { for (let i = 0; i < 200 && replies.length < count; i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(replies.length, count); };
  const state = async () => JSON.parse(await fs.readFile(path.join(runtime, 'state.json'), 'utf8'));
  return { handlers, turns, replies, until, state, runtime };
}

test('the same message and chat reaching two bots is handled once by each, in separate sessions', async t => {
  const { handlers, turns, replies, until, state } = await stubHub(t);
  const message = { id: 'm1', chatId: 'group', chatType: 'private', kind: 'text', text: 'hello' };
  handlers.one.message(message); handlers.two.message(message); handlers.one.message(message);
  await until(2);
  assert.deepEqual(replies.map(entry => [entry.bot, entry.messageId, entry.chatId]).sort(), [['one', 'm1', 'group'], ['two', 'm1', 'group']]);
  assert.notEqual(replies[0].key, replies[1].key);
  assert.equal(turns.length, 2);
  assert.deepEqual(Object.keys((await state()).sessions).sort(), ['one:group', 'two:group']);
});

test('a bot limited to its own sessions cannot continue one another bot started', async t => {
  // The chat still points at a session that bot one started.
  const saved = { sessions: { 'two:c': { id: 'theirs', cwd: os.tmpdir(), name: '别人的会话' } }, owners: { theirs: 'one' }, seen: [], outbox: [] };
  const { handlers, turns, replies, until, state } = await stubHub(t, { sessions: 'own' }, saved);
  const send = (id, text) => handlers.two.message({ id, chatId: 'c', chatType: 'private', kind: 'text', text });
  send('m1', 'continue');
  await until(1);
  assert.match(replies[0].text, /这个会话不在机器人 two 可以访问的范围内（它自己开的会话），这条消息没有发出。/);
  assert.equal(turns.length, 0);
  send('m2', '/new'); send('m3', 'mine'); send('m4', 'still mine');
  await until(4);
  assert.deepEqual(replies.slice(2).map(entry => entry.text.split('\n').pop()), ['answer 1', 'answer 2']);
  const now = await state();
  assert.equal(now.owners[now.sessions['two:c'].id], 'two');
});

test('two chats in the same session take turns; a queued one can still be stopped', async t => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'bots-test-'));
  const saved = { sessions: Object.fromEntries(['c1', 'c2', 'c3'].map(chat => [chat, { id: 'shared', cwd: os.tmpdir(), name: '共用会话' }])), seen: [], outbox: [] };
  await fs.writeFile(path.join(runtime, 'state.json'), JSON.stringify(saved));
  const turns = [], replies = [];
  let handlers;
  const agent = { id: 'stub', displayName: 'Stub', capabilities: { images: false, files: false },
    runTurn({ text }) {
      let finish;
      const turn = { text: text.split('\n')[0], finish: answer => finish(answer) };
      turns.push(turn);
      return { cancel() { finish(null); }, result: new Promise(resolve => { finish = resolve; }) };
    } };
  const channel = { id: 'stub', displayName: 'Stub', richText: false, start(h) { handlers = h; h.ready(); }, stop() {},
    send: async entry => { replies.push(entry); }, isPermanentSendError: () => false, acknowledge: async () => {} };
  const hub = createHub({ config: { offerSelfTest: false, workspace: runtime, turnTimeoutMs: 5000, botName: 'Cora' }, agent, channel, runtime, log() {} });
  hub.start();
  t.after(async () => { hub.shutdown(); await fs.rm(runtime, { recursive: true, force: true }); });
  const send = (id, chatId, text) => handlers.message({ id, chatId, chatType: 'private', kind: 'text', text });
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  send('m1', 'c1', 'first'); send('m2', 'c2', 'second'); send('m3', 'c3', 'third');
  await settle();
  assert.deepEqual(turns.map(turn => turn.text), ['first'], 'only one turn runs on the session');
  send('m4', 'c3', '/stop');
  turns[0].finish('answer one');
  await settle();
  assert.deepEqual(turns.map(turn => turn.text), ['first', 'second'], 'the next chat starts once the first is done; the stopped one never does');
  turns[1].finish('answer two');
  await settle();
  assert.equal(turns.length, 2);
  assert.deepEqual(replies.map(entry => entry.messageId).sort(), ['m1', 'm2', 'm4']);
});
