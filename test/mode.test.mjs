import test from 'node:test';
import assert from 'node:assert/strict';
import { runBridge, privateEvent } from './harness.mjs';

const groupEvent = { ...privateEvent, chat_type: 'group', chat_id: 'oc_group', mentions: [{ id: 'ou_cora', name: 'Cora', key: '@_user_1' }] };

test('auto is the default and /mode switches this chat in order, keeping bypass out of groups', { timeout: 20_000 }, async t => {
  const steps = ['/mode', '第一条', '/mode plan', '/status', '第二条', '/mode plan', '/mode 不存在', '/mode BYPASS',
    '@Cora /mode bypass', '第三条', '/mode auto', '第四条', '/help'];
  const { replies, calls, state } = await runBridge(t, async () => ({
    events: steps.map(content => content.startsWith('@Cora') ? { ...groupEvent, content } : { ...privateEvent, content }),
    config: { allowGroupMentions: true, botOpenId: 'ou_cora' },
  }));
  const text = replies.map(r => r.text);
  assert(text[0].startsWith('当前权限模式：auto（默认）'), text[0]);
  for (const mode of ['auto（默认）：Claude Code 逐个检查', 'dontAsk：', 'acceptEdits：', 'plan：', 'bypassPermissions：']) assert(text[0].includes(mode), mode);
  assert.match(text[2], /^已切换到 plan 模式：只调研并给出方案/);
  assert(text[3].includes('权限模式：plan（/mode 切换）'), text[3]);
  assert.equal(text[5], '当前已经是 plan 模式。');
  assert(text[6].startsWith('没有「不存在」这个模式。') && text[6].includes('当前权限模式：plan'), text[6]);
  assert(text[7].startsWith('已切换到 bypassPermissions 模式：跳过所有权限检查') && text[7].endsWith('用完记得发 /mode auto 切回。'), text[7]);
  assert.equal(text[8], '群聊里不能切换到 bypassPermissions，请在私聊中使用。');
  assert.match(text[10], /^已切换到 auto 模式（默认）：/);
  assert(text[12].includes('/mode：查看或切换权限模式'));
  assert.deepEqual(calls.map(call => [call.input.split('\n')[0], call.mode]),
    [['第一条', 'auto'], ['第二条', 'plan'], ['第三条', 'bypassPermissions'], ['第四条', 'auto']]);
  assert(calls.every(call => call.args[call.args.indexOf('--permission-prompts') + 1] === 'none'));
  assert.deepEqual(state.modes, {});
  // Every reply carries the mode in effect; the high-risk one is flagged.
  assert.equal(replies[0].head, '**workspace** -- auto mode');
  assert.equal(replies[2].head, '**workspace** -- plan mode');
  assert.equal(replies[4].head, '**workspace** -- plan mode');
  assert.equal(replies[7].head, '**workspace** -- ⚠️ bypassPermissions mode');
  assert.equal(replies[9].head, '**workspace** -- ⚠️ bypassPermissions mode');
  assert.equal(replies[10].head, '**workspace** -- auto mode');
});

test('/usage answers immediately from Claude Code without a model turn or saved session', { timeout: 20_000 }, async t => {
  const { root, replies, calls } = await runBridge(t, async () => ({ events: [{ ...privateEvent, content: '/usage' }] }));
  assert.equal(replies[0].text, 'Current session: 14% used');
  assert.equal(replies[0].head, '**workspace** -- auto mode');
  assert.equal(calls.length, 0);
  const fs = await import('node:fs/promises');
  const [usage] = (await fs.readFile(root + '/usage.jsonl', 'utf8')).trim().split('\n').map(JSON.parse);
  assert(usage.args.includes('--no-session-persistence') && usage.args[usage.args.indexOf('--tools') + 1] === '');
});

test('a configured default other than auto is shown as the default and a chat can override it', { timeout: 20_000 }, async t => {
  const { replies, calls, state } = await runBridge(t, async () => ({
    events: ['/mode', '你好', '/mode auto', '/status'].map(content => ({ ...privateEvent, content })),
    config: { claudePermissionMode: 'dontAsk' },
  }));
  assert(replies[0].text.startsWith('当前权限模式：dontAsk（默认）') && replies[0].text.includes('dontAsk（默认）：只执行预先允许的工具'));
  assert.equal(calls[0].mode, 'dontAsk');
  assert.match(replies[2].text, /^已切换到 auto 模式：/);
  assert(replies[3].text.includes('权限模式：auto（/mode 切换）'));
  assert.deepEqual(state.modes, { oc_private: 'auto' });
});
