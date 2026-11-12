// Temporary sessions: /temp opens one, leaving it deletes it, /keep makes it a regular session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../core/hub.mjs';
import { formatSessionList } from '../core/session-list.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 300; i++) { if (check()) return; await wait(10); }
  assert.fail(`timed out waiting for ${label}`);
}

// A stub agent with sessions kept in memory and a stub channel that records replies.
async function setup(t, { trash = true, running = new Map(), rename = true } = {}) {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'temp-test-'));
  const sent = [], store = new Map(), trashed = [], renames = [];
  let handlers, counter = 0;
  const job = answer => ({ cancel() {}, result: Promise.resolve(answer) });
  const agent = {
    id: 'stub', displayName: 'Stub', capabilities: { images: false, files: false },
    runTurn({ sessionId, text, onSession }) {
      const id = sessionId || `session-${++counter}`;
      onSession(id);
      store.set(id, { id, name: `会话 ${id}`, cwd: runtime, mtimeMs: Date.now(), headless: false });
      return job(`answer in ${id}: ${text.split('\n')[0]}`);
    },
    ...(rename ? { rename: ({ sessionId, name }) => { renames.push([sessionId, name]); return job(name || '自动名'); } } : {}),
    sessions: {
      list: () => [...store.values()], filter: list => list,
      pick: (list, query, listed) => list.filter(session => session.id === listed[Number(query) - 1] || session.id === query),
      running: () => running, digest: () => ({ prompt: 'p', reply: 'r' }), format: formatSessionList, ago: () => '刚刚',
      resumeHint: id => `stub resume ${id}`, recap: () => job('- 梗概'),
      ...(trash ? { trash: session => { store.delete(session.id); trashed.push(session.id); return { trash: 't', restoreTo: 'r' }; } } : {}),
    },
  };
  const channel = { id: 'stub', displayName: 'Stub', richText: false, start(h) { handlers = h; h.ready(); }, stop() {},
    send: async entry => { sent.push(entry); }, isPermanentSendError: () => false, acknowledge: async () => {} };
  const hub = createHub({ config: { offerSelfTest: false, workspace: runtime, sessionDir: runtime, turnTimeoutMs: 5000, botName: 'Cora' }, agent, channel, runtime, log() {} });
  hub.start();
  t.after(async () => { hub.shutdown(); await fs.rm(runtime, { recursive: true, force: true }); });
  let n = 0;
  // Sends one message and resolves to the text of its reply (the header line removed).
  const say = async (text, chatId = 'chat') => {
    const id = `m${++n}`;
    handlers.message({ id, chatId, chatType: 'private', userId: 'u1', kind: 'text', text });
    await until(() => sent.some(entry => entry.messageId === id), `the reply to ${text}`);
    await wait(20);
    return sent.filter(entry => entry.messageId === id).map(entry => entry.text).join('\n');
  };
  const state = async () => JSON.parse(await fs.readFile(path.join(runtime, 'state.json'), 'utf8'));
  return { say, store, trashed, renames, state, sent };
}

test('/temp opens a session that is deleted when the chat leaves it with /new, /temp or /switch', async t => {
  const { say, store, trashed, renames, state } = await setup(t);
  assert((await say('一条普通消息')).includes('answer in session-1'));
  const opened = await say('/temp');
  assert(opened.includes('已离开会话「自动名」，它仍在 /sessions 列表中。已开启临时会话') && opened.includes('/keep'), opened);
  assert(opened.startsWith('【临时会话】'), 'the header says so before the first message');
  const answer = await say('临时问一句');
  assert(answer.startsWith('【临时会话】') && answer.includes('answer in session-2'), answer);
  assert((await say('再问一句')).includes('answer in session-2'), 'it continues like any session');
  assert.equal((await state()).sessions.chat.temp, true);
  assert((await say('/status')).includes('（临时会话，离开后自动删除；发 /keep 保留）'));
  assert(/2\. .*· 当前 · 临时|1\. .*· 当前 · 临时/.test(await say('/sessions')), 'marked in the list');
  // Not named automatically: only the regular session was.
  assert.deepEqual(renames, [['session-1', '']]);

  assert.equal(await say('/new'), '临时会话已删除。已开启新会话，下一条消息会创建新的 Stub 上下文。');
  assert.deepEqual([trashed, [...store.keys()]], [['session-2'], ['session-1']]);
  assert.equal((await state()).sessions.chat, undefined);

  // Left by opening another temporary session, then by switching away.
  await say('/temp'); await say('第二个临时会话');
  assert((await say('/temp')).startsWith('【临时会话】\n临时会话已删除。已开启临时会话'));
  await say('第三个临时会话');
  await say('/sessions');
  const list = (await state()).listings.chat;
  const switched = await say(`/switch ${list.indexOf('session-1') + 1}`);
  assert(switched.includes('临时会话已删除。\n已进入会话「会话 session-1」'), switched);
  assert.deepEqual(trashed, ['session-2', 'session-3', 'session-4']);
  assert.equal((await state()).sessions.chat.temp, undefined);
  // An unused temporary session leaves nothing to delete.
  await say('/temp');
  assert.equal(await say('/new'), '已开启新会话，下一条消息会创建新的 Stub 上下文。');
  assert.equal(trashed.length, 3);
});

test('/keep turns the temporary session into a regular one, which is then named and kept', async t => {
  const { say, store, trashed, renames, state } = await setup(t);
  assert.equal(await say('/keep'), '当前没有临时会话。发 /temp 开一个。');
  await say('/temp');
  assert((await say('/keep')).includes('这个临时会话还没有内容，已改成普通的新会话'));
  await say('/temp'); await say('值得留下的讨论');
  const kept = await say('/keep');
  assert(kept.includes('已保留：这个会话现在是常规会话，离开后不会删除，可以在 /sessions 里找到。'), kept);
  await until(() => renames.length === 1, 'the kept session to be named');
  assert.deepEqual(renames, [['session-1', '']]);
  assert.equal((await state()).sessions.chat.temp, undefined);
  assert((await say('/keep')).includes('当前会话本来就是常规会话'));
  assert((await say('/new')).startsWith('已离开会话「自动名」，它仍在 /sessions 列表中。'));
  assert.deepEqual([trashed, [...store.keys()]], [[], ['session-1']]);
});

test('a temporary session that is still in use, open in a terminal or cannot be deleted is left alone', async t => {
  const running = new Map();
  const { say, store, trashed, state } = await setup(t, { running });
  await say('/temp'); await say('临时内容');
  // Another chat switched into it.
  await say('/sessions', 'other');
  await say('/switch 1', 'other');
  assert.equal(await say('/new'), '临时会话还有别的聊天在用，没有删除。已开启新会话，下一条消息会创建新的 Stub 上下文。');
  assert.equal((await state()).sessions.other.id, 'session-1');
  // Open in a terminal.
  await say('/temp'); await say('又一个');
  running.set('session-2', { pid: 1, busy: false });
  assert((await say('/new')).startsWith('临时会话在终端里还开着，没有删除'));
  assert.deepEqual([trashed, [...store.keys()]], [[], ['session-1', 'session-2']]);

  // An agent that cannot delete session records.
  const plain = await setup(t, { trash: false });
  await plain.say('/temp'); await plain.say('内容');
  assert.equal(await plain.say('/new'), '已离开临时会话。Stub 不支持删除会话记录，它没有被删除。已开启新会话，下一条消息会创建新的 Stub 上下文。');
});
