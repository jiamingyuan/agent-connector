// The template agent runs through the real hub and Lark channel: proves the hub needs nothing
// beyond the documented agent interface, and that commands for missing features degrade cleanly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBridge, privateEvent } from './harness.mjs';
import { createAgent } from '../example-agent/index.mjs';

test('an agent with only the required interface works end to end and keeps its session', { timeout: 20_000 }, async t => {
  const steps = ['你好', '第二句', '/status', '/mode', '/usage', '/sessions', '/help', '/new', '重新开始'];
  const { root, replies, state } = await runBridge(t, async () => ({ events: steps.map(content => ({ ...privateEvent, content })), config: { agent: 'example' } }));
  const text = replies.map(r => r.text);
  assert.equal(text[0], `第 1 轮（${root}）：你好`);
  assert.equal(text[1], `第 2 轮（${root}）：第二句`);
  assert(text[2].includes('Agent：Example') && !text[2].includes('权限模式'));
  assert.equal(text[3], '权限模式切换目前不支持 Example。');
  assert.equal(text[4], '/usage 目前不支持 Example。');
  assert.equal(text[5], '会话切换目前不支持 Example。');
  assert(!text[6].includes('/mode') && !text[6].includes('/sessions') && text[6].includes('/stop'));
  assert.equal(text[8], `第 1 轮（${root}）：重新开始`);
  assert.match(state.sessions.oc_private.id, /^example-/);
});

test('the template honours cancel and timeout as the contract requires', async () => {
  const agent = createAgent({}, { log() {} });
  const sessions = [];
  const handle = agent.runTurn({ text: 'x', cwd: '/w', timeoutMs: 1000, onSession: id => sessions.push(id) });
  handle.cancel();
  assert.equal(await handle.result, null);
  assert.equal(sessions.length, 1);
  const done = await agent.runTurn({ sessionId: sessions[0], text: 'y', cwd: '/w', timeoutMs: 1000, onSession() {} }).result;
  assert.equal(done, '第 2 轮（/w）：y');
});
