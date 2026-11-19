// A /to thread holds its session for other bots only while in use: while a message of it runs or
// waits, and for threadHoldMinutes after its last message or answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../core/hub.mjs';
import { accessOf } from '../core/bots.mjs';
import { filterSessions, pickSession, timeAgo, formatSessionList } from '../core/session-list.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 500; i++) { if (check()) return; await wait(10); }
  assert.fail(`timed out waiting for ${label}`);
}

// Two bots ("one" and "two") on one stub agent with one existing session, "alpha".
async function setup(t, { holdMs = 300, turnMs = 0 } = {}) {
  const runtime = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'to-hold-test-')));
  const project = path.join(runtime, 'proj');
  await fs.mkdir(project);
  const file = path.join(project, 'alpha.jsonl');
  await fs.writeFile(file, '{}\n');
  const alpha = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'alpha', cwd: project, file, mtimeMs: Date.now() };
  const turns = [], sent = [];
  const agent = { id: 'stub', displayName: 'Stub', capabilities: { images: false, files: false },
    runTurn({ sessionId, text, onSession }) {
      const id = sessionId || `new-${turns.length + 1}`;
      onSession(id);
      turns.push({ id, text: text.split('\n')[0] });
      return { cancel() {}, result: wait(turnMs).then(() => `answer in ${id}`) };
    },
    sessions: { list: () => [alpha], filter: filterSessions, pick: pickSession, running: () => new Map(), format: formatSessionList, ago: timeAgo,
      resumeHint: id => `stub --resume ${id}`, recap: () => ({ cancel() {}, result: Promise.resolve('梗概') }), digest: () => ({ prompt: '', reply: '' }) } };
  const handlers = {};
  const channel = name => ({ id: 'stub', displayName: 'Stub', richText: false, threads: true, start(h) { handlers[name] = h; h.ready(); }, stop() {},
    send: async entry => { sent.push(entry); }, isPermanentSendError: () => false, acknowledge: async () => {} });
  const config = { offerSelfTest: false, workspace: runtime, sessionDir: runtime, turnTimeoutMs: 5000, botName: 'one', threadHoldMinutes: holdMs / 60_000 };
  const bots = ['one', 'two'].map(name => ({ id: name, name, config: { botName: name }, access: accessOf(), channel: channel(name) }));
  const hub = createHub({ config, agent, bots, runtime, log() {} });
  hub.start();
  t.after(async () => { hub.shutdown(); await wait(50); await fs.rm(runtime, { recursive: true, force: true }); });
  let n = 0;
  // Sends as `bot` in its private chat (optionally in a thread) and resolves with the reply text.
  const say = async (bot, text, thread, settle = true) => {
    const id = `m${++n}`;
    handlers[bot].message({ id, chatId: `chat-${bot}`, chatType: 'private', userId: 'u1', kind: 'text', text, ...(thread ? { thread } : {}) });
    if (!settle) return id;
    await until(() => sent.some(entry => entry.bot === bot && entry.messageId === id), `the reply to ${text}`);
    await wait(20);
    return { id, text: sent.filter(entry => entry.bot === bot && entry.messageId === id).map(entry => entry.text).join('\n') };
  };
  const replyTo = async (bot, id) => {
    await until(() => sent.some(entry => entry.bot === bot && entry.messageId === id), `the reply to ${id}`);
    return sent.filter(entry => entry.bot === bot && entry.messageId === id).map(entry => entry.text).join('\n');
  };
  return { say, replyTo, turns, alpha };
}

test('a /to thread lets go of its session after the idle time, and takes it back when the thread carries on', async t => {
  const { say, turns, alpha } = await setup(t, { holdMs: 300 });
  const opened = await say('two', '/to alpha 你好');
  assert.match(opened.text, /answer in aaaaaaaa/);

  // Right after, the session is in use by bot two's thread.
  const refusedTo = await say('one', '/to alpha 问一句');
  assert(refusedTo.text.includes('会话「alpha」正在机器人 two 的一个 /to 话题里使用，不能同时使用。那个话题空闲'), refusedTo.text);
  const refusedSwitch = await say('one', '/switch alpha');
  assert(refusedSwitch.text.includes('正在机器人 two 的一个 /to 话题里使用，不能同时进入'), refusedSwitch.text);
  const status = await say('two', '/status', opened.id);
  assert(status.text.includes('话题：占用着这个会话'), status.text);

  // After the idle time it is free: bot one opens its own thread on it.
  await wait(400);
  const released = await say('two', '/status', opened.id);
  assert(released.text.includes('话题：已释放'), released.text);
  const oneThread = await say('one', '/to alpha 问一句');
  assert.match(oneThread.text, /answer in aaaaaaaa/);

  // Bot two's old thread cannot take it back while bot one's thread holds it ...
  const blocked = await say('two', '接着聊', opened.id);
  assert(blocked.text.includes('正在机器人 one 的一个 /to 话题里使用，这个话题暂时接不上'), blocked.text);
  // ... and can once that one is idle too, carrying on in the same session.
  await wait(400);
  const back = await say('two', '接着聊', opened.id);
  assert.match(back.text, /answer in aaaaaaaa/);
  assert.deepEqual(turns.map(turn => [turn.id, turn.text]), [[alpha.id, '你好'], [alpha.id, '问一句'], [alpha.id, '接着聊']]);
  // And now bot one is the one kept out.
  const refusedAgain = await say('one', '/switch alpha');
  assert(refusedAgain.text.includes('正在机器人 two 的一个 /to 话题里使用'), refusedAgain.text);
});

test('a /to thread keeps its session while its turn runs longer than the idle time', async t => {
  const { say, replyTo } = await setup(t, { holdMs: 100, turnMs: 500 });
  const id = await say('two', '/to alpha 慢慢来', undefined, false);
  await wait(250); // past the idle time, turn still running
  const refused = await say('one', '/to alpha 插一句');
  assert(refused.text.includes('正在机器人 two 的一个 /to 话题里使用'), refused.text);
  assert.match(await replyTo('two', id), /answer in aaaaaaaa/);
});
