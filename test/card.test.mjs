import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCard, modelName, contextColor, fallbackText } from '../lark-channel/card.mjs';
import { runBridge, privateEvent } from './harness.mjs';

test('card: blue header with mode, full model name with effort, and context tags; limits on top, turn totals below', () => {
  assert.equal(modelName('claude-opus-5-5'), 'claude opus 5.5');
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'claude sonnet 4.5');
  assert.deepEqual([contextColor(49_999), contextColor(50_000), contextColor(200_000)], ['green', 'orange', 'red']);
  const card = buildCard('正文', { title: 'acomet', mode: { name: 'bypassPermissions', risky: true }, model: 'claude-opus-5-5', effort: 'max', context: 182_000,
    quota: { fiveHour: { used: 0.92, resetsAt: 1794225000 }, sevenDay: { used: 0.3, resetsAt: 1794430800 } },
    turn: { seconds: 9, output: 640, newInput: 3100, cacheRead: 178_000 } });
  assert.equal(card.header.template, 'blue');
  assert.deepEqual(card.header.text_tag_list.map(t => [t.text.content, t.color]),
    [['⚠️ bypassPermissions', 'red'], ['claude opus 5.5 - max', 'neutral'], ['context 182k', 'orange']]);
  const [limits, , body, , footer] = card.body.elements;
  assert.equal(limits.content, "5 小时额度 <font color='red'>剩 8%</font><font color='grey'> · 11-09 11:50 UTC</font>\n本周额度 <font color='green'>剩 70%</font><font color='grey'> · 11-11 21:00 UTC</font>");
  assert.equal(body.content, '正文');
  assert.equal(footer.content, "<font color='grey'>本轮 9 秒 - 输出 640 - 新增输入 3.1k - 缓存读取 178k</font>");
  // Without stats only the title is drawn.
  const bare = buildCard('hi', { title: '新会话' });
  assert.equal(bare.header.text_tag_list, undefined);
  assert.deepEqual(bare.body.elements, [{ tag: 'markdown', content: 'hi' }]);
  assert.equal(fallbackText('hi', { title: 'x', mode: { name: 'auto' }, context: 1200 }), '**x** -- auto mode · context 1.2k\nhi');
});

test('replies go out as cards carrying the turn\'s stats; a rejected card falls back to a Markdown post', { timeout: 20_000 }, async t => {
  const steps = ['/status', '第一问', '/rename REJECT-CARD', '第二问'];
  const { replies, state } = await runBridge(t, async () => ({ events: steps.map(content => ({ ...privateEvent, content })), config: { replyFormat: 'card' } }));
  const [status, answer] = replies;
  // Before any turn: title and mode only.
  assert.equal(status.format, 'card');
  assert.deepEqual(status.card.header.text_tag_list.map(t => t.text.content), ['auto mode']);
  assert.equal(answer.format, 'card');
  assert.deepEqual(answer.card.header.text_tag_list.map(t => [t.text.content, t.color]),
    [['auto mode', 'blue'], ['claude opus 5.5', 'neutral'], ['context 56.6k', 'orange']]);
  assert.match(answer.text, /5 小时额度 <font color='green'>剩 70%<\/font><font color='grey'> · 11-09 11:50 UTC<\/font>/);
  assert.match(answer.text, /本周额度 <font color='red'>剩 15%<\/font>/);
  assert.match(answer.text, /本轮 \d+ 秒 - 输出 1.2k - 新增输入 14.8k - 缓存读取 60.1k/);
  // The fake rejects cards titled REJECT-CARD; the reply still arrives as a post with the old header.
  const fallback = replies.at(-1);
  assert.equal(fallback.format, 'markdown');
  assert.equal(fallback.head, '**REJECT-CARD** -- auto mode · claude opus 5.5 · context 56.6k');
  assert.match(fallback.text, /^answer in /);
  assert.deepEqual(state.sessions.oc_private.stats, { model: 'claude-opus-5-5', context: 56577 });
  assert.equal(state.quota.sevenDay.used, 0.85);
});
