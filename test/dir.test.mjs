// /dir: the directory a chat's new sessions start in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../core/hub.mjs';
import { accessOf } from '../core/bots.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 300; i++) { if (check()) return; await wait(10); }
  assert.fail(`timed out waiting for ${label}`);
}

// A stub agent that records where each turn runs, and a stub channel that records replies.
async function setup(t, makeScope) {
  const runtime = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dir-test-')));
  const project = path.join(runtime, 'project'), other = path.join(runtime, 'other');
  await fs.mkdir(project); await fs.mkdir(other);
  await fs.writeFile(path.join(runtime, 'a-file'), '');
  const sent = [], turns = [];
  const scope = makeScope?.({ project, other });
  let handlers, counter = 0;
  const agent = { id: 'stub', displayName: 'Stub', capabilities: { images: false, files: false },
    runTurn({ sessionId, cwd, text, onSession }) {
      const id = sessionId || `session-${++counter}`;
      onSession(id);
      turns.push({ id, cwd, text: text.split('\n')[0] });
      return { cancel() {}, result: Promise.resolve(`answer in ${id}`) };
    } };
  const channel = { id: 'stub', displayName: 'Stub', richText: false, start(h) { handlers = h; h.ready(); }, stop() {},
    send: async entry => { sent.push(entry); }, isPermanentSendError: () => false, acknowledge: async () => {} };
  const config = { offerSelfTest: false, workspace: runtime, sessionDir: runtime, turnTimeoutMs: 5000, botName: 'Cora' };
  const hub = scope
    ? createHub({ config, agent, bots: [{ id: 'one', name: 'one', config: { botName: 'one', sessionDir: project }, access: accessOf(scope), channel }], runtime, log() {} })
    : createHub({ config, agent, channel, runtime, log() {} });
  hub.start();
  t.after(async () => { hub.shutdown(); await fs.rm(runtime, { recursive: true, force: true }); });
  let n = 0;
  const say = async (text, chatId = 'chat', chatType = 'private') => {
    const id = `m${++n}`;
    handlers.message({ id, chatId, chatType, userId: 'u1', kind: 'text', text });
    await until(() => sent.some(entry => entry.messageId === id), `the reply to ${text}`);
    await wait(20);
    return sent.filter(entry => entry.messageId === id).map(entry => entry.text).join('\n');
  };
  const state = async () => JSON.parse(await fs.readFile(path.join(runtime, 'state.json'), 'utf8'));
  return { say, turns, state, runtime, project, other };
}

test('/dir sets where the chat\'s new sessions start, starts one there, and keeps it for later sessions', async t => {
  const { say, turns, state, runtime, project } = await setup(t);
  await say('第一条');
  assert.equal(turns.at(-1).cwd, runtime);
  const shown = await say('/dir');
  assert(shown.includes(`这个聊天的新会话目录：${runtime}（默认）`) && shown.includes(`当前会话在 ${runtime} 里运行`), shown);

  const set = await say(`/dir ${project}`);
  assert(set.includes(`已设置：这个聊天的新会话都在 ${project} 里开始，直到再次修改。已开启新会话`), set);
  await say('在项目里问');
  assert.deepEqual([turns.at(-1).id, turns.at(-1).cwd], ['session-2', project]);
  await say('接着问');
  assert.deepEqual([turns.at(-1).id, turns.at(-1).cwd], ['session-2', project], 'the session continues there');
  await say('/new'); await say('新会话');
  assert.deepEqual([turns.at(-1).id, turns.at(-1).cwd], ['session-3', project], 'later sessions start there too');
  await say('/temp'); await say('临时会话');
  assert.equal(turns.at(-1).cwd, project);
  assert((await say('/status')).includes(`新会话目录：${project}（用 /dir 设置的）`));
  assert.equal((await state()).dirs.chat, project);

  // Another chat is not affected.
  await say('别的聊天', 'chat-2');
  assert.equal(turns.at(-1).cwd, runtime);

  const reset = await say('/dir default');
  assert(reset.includes(`已恢复默认：这个聊天的新会话在 ${runtime} 里开始。已开启新会话`), reset);
  await say('回到默认');
  assert.equal(turns.at(-1).cwd, runtime);
  assert.equal((await state()).dirs.chat, undefined);
});

test('/dir works in a group and refuses what is not a directory', async t => {
  const { say, turns, state, runtime, project } = await setup(t);
  assert((await say(`/dir ${project}`, 'group', 'group')).includes('已设置'));
  await say('群里的问题', 'group', 'group');
  assert.equal(turns.at(-1).cwd, project);
  // Refusals leave the setting and the session as they were.
  assert.equal(await say('/dir project', 'group', 'group'), '请写完整的目录路径，如 /srv/project 或 ~/project。');
  assert((await say(`/dir ${path.join(runtime, 'missing')}`, 'group', 'group')).startsWith('本机没有目录'));
  assert((await say(`/dir ${path.join(runtime, 'a-file')}`, 'group', 'group')).startsWith('本机没有目录'));
  await say('还在原来的会话', 'group', 'group');
  assert.deepEqual([turns.at(-1).id, turns.at(-1).cwd, (await state()).dirs.group], ['session-1', project, project]);
  // "~" is the home directory.
  assert((await say('/dir ~', 'group', 'group')).includes(`都在 ${os.homedir()} 里开始`));
});

test('a bot limited to some directories only takes a /dir inside them', async t => {
  const { say, turns, project, other } = await setup(t, ({ project: allowed }) => ({ sessions: [allowed] }));
  assert.equal(await say(`/dir ${other}`), `机器人 one 只能在这些目录里开会话：${project}。`);
  assert((await say(`/dir ${project}`)).includes('已设置'));
  await say('在范围内');
  assert.equal(turns.at(-1).cwd, project);
});

test('/new and /temp take a directory for that one session without changing the chat\'s own', async t => {
  const { say, turns, state, runtime, project, other } = await setup(t);
  const opened = await say(`/new ${project}`);
  assert.equal(opened, `已在 ${project} 开启新会话，下一条消息会在这个目录里创建新的 Stub 上下文。这只对这一个会话有效，想让以后的新会话都在这个目录，用 /dir。`);
  await say('在项目里'); await say('接着问');
  assert.deepEqual(turns.map(turn => [turn.id, turn.cwd]), [['session-1', project], ['session-1', project]]);
  assert((await say('/status')).includes(`会话目录：${project}`));
  // The next plain /new is back in the chat's own directory.
  await say('/new'); await say('默认目录');
  assert.deepEqual([turns.at(-1).id, turns.at(-1).cwd], ['session-2', runtime]);
  assert.equal((await state()).dirs.chat, undefined);

  // With /dir set, a directory on /new still wins for that one session.
  await say(`/dir ${other}`);
  await say(`/new ${project}`); await say('一次性的目录');
  assert.equal(turns.at(-1).cwd, project);
  await say('/new'); await say('回到 /dir 的目录');
  assert.equal(turns.at(-1).cwd, other);

  const temp = await say(`/temp ${project}`);
  assert(temp.includes(`已在 ${project} 开启临时会话`) && temp.includes('/keep'), temp);
  await say('临时的');
  assert.equal(turns.at(-1).cwd, project);
  assert.equal((await state()).sessions.chat.temp, true);

  // A bad directory changes nothing: the chat stays in its session.
  const before = (await state()).sessions.chat.id;
  assert.equal(await say('/new project'), '【临时会话】\n请写完整的目录路径，如 /srv/project 或 ~/project。');
  assert((await say(`/new ${path.join(runtime, 'missing')}`)).includes('本机没有目录'));
  assert.equal((await state()).sessions.chat.id, before);
  // Not a command: text that merely starts with /new goes to the agent.
  await say('/newer idea');
  assert.equal(turns.at(-1).text, '/newer idea');
});
