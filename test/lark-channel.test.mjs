import test from 'node:test';
import assert from 'node:assert/strict';
import { eventDecision, messageText, replyArgs } from '../lark-channel/protocol.mjs';

const now = Date.now();
const config = { ownerOpenId: 'ou_owner', maxEventAgeMs: 300_000, workspace: '/tmp/workspace' };
const event = { type: 'im.message.receive_v1', sender_type: 'user', sender_id: 'ou_owner', chat_type: 'p2p',
  message_id: 'om_test', chat_id: 'oc_test', create_time: String(now) };

test('only owner direct messages can invoke the local agent', () => {
  assert.equal(eventDecision(event, config, now), null);
  assert.equal(eventDecision({ ...event, sender_id: 'ou_stranger' }, config, now), 'sender');
  assert.equal(eventDecision({ ...event, sender_type: 'bot' }, config, now), 'sender_type');
  assert.equal(eventDecision({ ...event, chat_type: 'group' }, config, now), 'chat_type');
  assert.equal(eventDecision({ ...event, create_time: String(now - 400_000) }, config, now), 'stale');
  assert.equal(eventDecision({ ...event, message_id: '../../file' }, config, now), 'message_id');
});
test('group access requires opt-in, the owner and a real mention of this exact bot', () => {
  const enabled = { ...config, allowGroupMentions: true, botOpenId: 'ou_cora' };
  const group = { ...event, chat_type: 'group', mentions: [{ id: 'ou_cora', key: '@_user_1', name: 'Cora' }] };
  assert.equal(eventDecision(group, config, now), 'chat_type');
  assert.equal(eventDecision(group, enabled, now), null);
  assert.equal(eventDecision({ ...group, sender_id: 'ou_stranger' }, enabled, now), 'sender');
  assert.equal(eventDecision({ ...group, sender_type: 'bot' }, enabled, now), 'sender_type');
  assert.equal(eventDecision(group, { ...enabled, botOpenId: undefined }, now), 'bot_identity');
  for (const mentions of [undefined, null, {}, [], [null], [{ id: 'ou_other', name: 'Cora' }], [{ id: 'all' }]]) {
    assert.equal(eventDecision({ ...group, mentions, content: '@Cora 你好' }, enabled, now), 'bot_not_mentioned');
  }
  assert.equal(eventDecision({ ...group, create_time: String(now - 400_000) }, enabled, now), 'stale');
});
test('leading bot mentions are removed for group commands without changing private or other mentions', () => {
  const enabled = { ...config, botOpenId: 'ou_cora' };
  const group = { ...event, chat_type: 'group', mentions: [{ id: 'ou_cora', key: '@_user_1', name: 'Cora' }] };
  assert.equal(messageText({ ...group, content: ' @Cora /status' }, enabled), '/status');
  assert.equal(messageText({ ...group, content: '@_user_1\u00a0/new' }, enabled), '/new');
  assert.equal(messageText({ ...group, content: '@Cora：你好 @Edward' }, enabled), '你好 @Edward');
  assert.equal(messageText({ ...group, content: '@Cora' }, enabled), '');
  assert.equal(messageText({ ...group, content: '@CoraExtra 你好' }, enabled), '@CoraExtra 你好');
  assert.equal(messageText({ ...event, content: '@Cora /status' }, enabled), '@Cora /status');
});
test('rich replies use native Markdown posts while old queued replies keep plain text and idempotency', () => {
  const entry = { messageId: 'om_1', text: '**结果**\n\n- 可用', key: 'stable' };
  assert(replyArgs({ ...entry, format: 'markdown' }).includes('--markdown'));
  assert(!replyArgs({ ...entry, format: 'markdown' }).includes('--text'));
  assert(replyArgs(entry).includes('--text'));
  assert.deepEqual(replyArgs({ ...entry, format: 'markdown' }).slice(-2), ['--idempotency-key', 'stable']);
});
