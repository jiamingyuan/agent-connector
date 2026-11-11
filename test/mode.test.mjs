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
  // Every reply carries the mode in effect; the high-risk one is flagged. After the first answer the
  // session has its automatic name.
  assert.equal(replies[0].head, '**新会话** -- auto mode');
  assert.equal(replies[2].head, '**auto-name** -- plan mode');
  assert.equal(replies[4].head, '**auto-name** -- plan mode');
  assert.equal(replies[7].head, '**auto-name** -- ⚠️ bypassPermissions mode');
  assert.equal(replies[9].head, '**auto-name** -- ⚠️ bypassPermissions mode');
  assert.equal(replies[10].head, '**auto-name** -- auto mode');
});

test('/usage answers immediately from Claude Code without a model turn or saved session', { timeout: 20_000 }, async t => {
  const { root, replies, calls } = await runBridge(t, async () => ({ events: [{ ...privateEvent, content: '/usage' }] }));
  assert.equal(replies[0].text, 'Current session: 14% used');
  assert.equal(replies[0].head, '**新会话** -- auto mode');
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

const flag = (call, name) => (call.args.includes(name) ? call.args[call.args.indexOf(name) + 1] : null);

test('/model and /effort switch this chat from the next message on, and default goes back', { timeout: 20_000 }, async t => {
  const steps = ['/model', '第一条', '/model Sonnet', '/effort max', '/status', '第二条', '/model gpt 5', '/effort ultra', '/model sonnet',
    '/model claude-haiku-5-5', '第三条', '/model default', '/effort 默认', '第四条', '/help'];
  const { replies, calls, state } = await runBridge(t, async () => ({ events: steps.map(content => ({ ...privateEvent, content })) }));
  const text = replies.map(r => r.text);
  assert(text[0].startsWith('当前模型：Claude Code 默认（默认）') && text[0].includes('sonnet：') && text[0].includes('/model default 恢复默认'), text[0]);
  assert.match(text[2], /^已将模型切换为 sonnet：.*从下一条消息开始生效，\/model default 可恢复默认。$/);
  assert.match(text[3], /^已将推理深度切换为 max：/);
  assert(text[4].includes('模型：sonnet（/model 切换）') && text[4].includes('推理深度：max（/effort 切换）'), text[4]);
  assert(text[6].startsWith('没有「gpt 5」这个模型。') && text[6].includes('当前模型：sonnet（/model 切换）'), text[6]);
  assert(text[7].startsWith('没有「ultra」这个推理深度。') && text[7].includes('low：'), text[7]);
  assert.equal(text[8], '当前模型已经是 sonnet。');
  assert.match(text[9], /^已将模型切换为 claude-haiku-5-5。/);
  assert.match(text[11], /^已将模型切换为 Claude Code 默认（默认）。从下一条消息开始生效。$/);
  assert.match(text[12], /^已将推理深度切换为 Claude Code 默认（默认）。/);
  assert(text[14].includes('/model [名称]') && text[14].includes('/effort [级别]'));
  assert.deepEqual(calls.filter(call => !call.input.startsWith('/rename')).map(call => [call.input.split('\n')[0], flag(call, '--model'), flag(call, '--effort')]),
    [['第一条', null, null], ['第二条', 'sonnet', 'max'], ['第三条', 'claude-haiku-5-5', 'max'], ['第四条', null, null]]);
  assert.deepEqual([state.models, state.efforts], [{}, {}]);
});

test('configured model and effort are the defaults; a chat can override them and the card shows the effort in effect', { timeout: 20_000 }, async t => {
  const { replies, calls, state } = await runBridge(t, async () => ({
    events: ['/effort', '你好', '/effort low', '再来', '/status'].map(content => ({ ...privateEvent, content })),
    config: { claudeModel: 'opus', claudeEffort: 'high', replyFormat: 'card' },
  }));
  assert(replies[0].text.startsWith('当前推理深度：high（默认）') && replies[0].text.includes('high（默认）：'), replies[0].text);
  const turns = calls.filter(call => !call.input.startsWith('/rename'));
  assert.deepEqual(turns.map(call => [flag(call, '--model'), flag(call, '--effort')]), [['opus', 'high'], ['opus', 'low']]);
  const modelTag = reply => reply.card.header.text_tag_list.map(tag => tag.text.content).find(content => content.includes('opus'));
  assert.match(modelTag(replies[1]), / - high$/);
  assert.match(modelTag(replies[2]), / - low$/, 'the reply to /effort already shows the new level');
  assert(replies[4].text.includes('模型：opus（默认）') && replies[4].text.includes('推理深度：low（/effort 切换）'), replies[4].text);
  assert.deepEqual([state.models, state.efforts], [{}, { oc_private: 'low' }]);
});
