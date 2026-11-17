import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBridge, privateEvent } from './harness.mjs';

const alpha = 'aaaaaaaa-0000-4000-8000-000000000001';
const user = (cwd, content) => ({ type: 'user', cwd, entrypoint: 'cli', message: { role: 'user', content } });
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

// A fake Claude Code home with one named terminal session, "alpha 项目", in its own project directory.
async function fixture(root) {
  const home = path.join(root, 'claude-home'), project = path.join(root, 'proj');
  await fs.mkdir(project);
  const dir = path.join(home, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${alpha}.jsonl`), [user(project, '重构 alpha'), assistant('已完成第一步'),
    { type: 'custom-title', customTitle: 'alpha 项目' }].map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return { home, project };
}
// A message the user sends in the thread that hangs on message `root`.
const inThread = (root, content) => ({ ...privateEvent, content, thread_id: `omt_${root}`, root_id: root });

test('/to says the text to another session and answers in a thread; the thread keeps that session, the chat keeps its own', { timeout: 30_000 }, async t => {
  let project;
  const { root, replies, calls, state, reactions } = await runBridge(t, async root => {
    const made = await fixture(root);
    project = made.project;
    return {
      events: [
        { ...privateEvent, content: '/to' },
        { ...privateEvent, content: '/to alpha 项目 看看进度' },
        inThread('om_step_1', '接着做第二步'),
        { ...privateEvent, content: '主聊天的问题' },
        inThread('om_step_1', '/new'),
        inThread('om_step_1', '/mode plan'),
        { ...privateEvent, content: '/to 不存在 你好' },
        { ...privateEvent, content: '/to alpha 项目' },
        inThread('om_other', '别的话题里的消息'),
      ],
      env: { CLAUDE_CONFIG_DIR: made.home },
      state: { sessions: { oc_private: { id: 'chat-session', cwd: root, name: '主会话' } }, seen: [], outbox: [] },
    };
  });
  const [usage, opened, followUp, mainAnswer, refusedNew, modeInThread, unknown, noText, otherThread] = replies;
  assert(usage.raw.includes('用法：/to 会话 正文'), usage.raw);
  assert.deepEqual([opened.thread, opened.head, opened.text], [true, '**alpha 项目** -- auto mode', 'answer in proj'], 'the answer opens a thread and names the session');
  assert.deepEqual([followUp.thread, followUp.head, followUp.text], [undefined, '**alpha 项目** -- auto mode', 'answer in proj'], 'a reply inside the thread stays there by itself');
  assert.equal(mainAnswer.head, '**主会话** -- auto mode', 'the chat is still in its own session');
  assert(refusedNew.text.includes('话题固定对应会话「alpha 项目」') && refusedNew.text.includes('/new'), refusedNew.raw);
  assert(modeInThread.text.includes('plan'), modeInThread.raw);
  assert(unknown.raw.includes('没有找到会话「不存在」'), unknown.raw);
  assert(noText.raw.includes('请在会话后面写上要发的正文'), noText.raw);
  assert.equal(otherThread.head, '**主会话** -- plan mode', 'a thread not opened with /to is part of the chat, and the mode set in the thread is the chat\'s');

  const turns = calls.filter(call => !call.input.startsWith('/rename'));
  assert.deepEqual(turns.map(call => [call.resumed, call.cwd, call.input.split('\n')[0]]), [
    [alpha, project, '看看进度'], [alpha, project, '接着做第二步'], ['chat-session', root, '主聊天的问题'], ['chat-session', root, '别的话题里的消息']]);
  assert.equal(turns[3].mode, 'plan');
  assert.equal(state.sessions.oc_private.id, 'chat-session');
  assert.deepEqual([state.sessions['oc_private#om_step_1'].id, state.sessions['oc_private#om_step_1'].thread], [alpha, true]);
  assert.deepEqual(state.modes, { oc_private: 'plan' });
  const emoji = id => reactions.find(item => item.id === id)?.emoji;
  assert.deepEqual([emoji('om_step_1'), emoji('om_step_2'), emoji('om_step_3')], ['Loudspeaker', 'SaluteFace', 'SaluteFace'], '/to gets a loudspeaker; its thread and the chat keep the salute');
});

test('/to is for private chats only', { timeout: 20_000 }, async t => {
  const mention = [{ id: 'ou_cora', name: 'Cora', key: '@_user_1' }];
  const { replies, calls } = await runBridge(t, async root => {
    const made = await fixture(root);
    return {
      events: [{ ...privateEvent, chat_type: 'group', chat_id: 'oc_group', content: '@Cora /to alpha 项目 你好', mentions: mention }],
      env: { CLAUDE_CONFIG_DIR: made.home }, config: { allowGroupMentions: true, botOpenId: 'ou_cora' },
    };
  });
  assert(replies[0].raw.includes('/to 只能在私聊中使用'), replies[0].raw);
  assert.equal(calls.length, 0);
});
