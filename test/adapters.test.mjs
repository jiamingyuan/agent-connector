// Every registered adapter must satisfy the interface the hub relies on (core/README.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentId, channelId, loadAgent, loadChannel } from '../core/registry.mjs';
import { parseEvent as codexEvent } from '../codex-agent/index.mjs';
import { normalize } from '../lark-channel/index.mjs';

const context = { root: '/tmp', runtime: '/tmp', env: {}, log() {} };
const base = { claudeBin: '/bin/claude', codexBin: '/bin/codex', larkBin: '/bin/lark-cli', profile: 'p', workspace: '/workspace' };

test('config picks adapters by name and keeps the older backend setting working', async () => {
  assert.equal(agentId({ backend: 'claude' }), 'claude-code');
  assert.equal(agentId({ backend: 'codex' }), 'codex');
  assert.equal(agentId({}), 'codex');
  assert.equal(agentId({ agent: 'claude-code', backend: 'codex' }), 'claude-code');
  assert.equal(channelId({}), 'lark');
  await assert.rejects(loadAgent({ agent: 'gpt' }), /Unknown agent "gpt"; known: claude-code, codex, example/);
  await assert.rejects(loadChannel({ channel: 'slack' }), /Unknown channel "slack"; known: lark/);
});

test('agents expose identity, capabilities and runTurn; optional features are complete when present', async () => {
  for (const id of ['claude-code', 'codex', 'example']) {
    const module = await loadAgent({ ...base, agent: id });
    assert.deepEqual(module.requiredBins({ ...base }), { 'claude-code': ['/bin/claude'], codex: ['/bin/codex'], example: [] }[id]);
    const agent = module.createAgent({ ...base }, context);
    assert.equal(agent.id, id);
    assert.equal(typeof agent.displayName, 'string');
    assert.equal(typeof agent.capabilities.images, 'boolean');
    assert.equal(typeof agent.runTurn, 'function');
    if (agent.modes) for (const key of ['descriptions', 'resolve', 'find']) assert(agent.modes[key], key);
    if (agent.sessions) for (const key of ['list', 'filter', 'pick', 'running', 'digest', 'format', 'ago', 'resumeHint', 'recap']) assert.equal(typeof agent.sessions[key], 'function', key);
    if (agent.usage) assert.equal(typeof agent.usageLabel, 'string');
  }
  assert.deepEqual(codexEvent({ type: 'thread.started', thread_id: 'c1' }), { ready: true, sessionId: 'c1' });
  assert.deepEqual(codexEvent({ type: 'turn.completed' }), { completed: true });
  assert.deepEqual(codexEvent({ type: 'turn.failed' }), { failed: true });
});

test('channels expose send, receive and acknowledge, and normalize messages for the hub', async () => {
  const module = await loadChannel(base);
  assert.deepEqual(module.requiredBins(base), ['/bin/lark-cli']);
  const channel = module.createChannel({ ...base, replyFormat: 'markdown' }, context);
  for (const key of ['start', 'stop', 'send', 'isPermanentSendError', 'acknowledge', 'attachments']) assert.equal(typeof channel[key], 'function', key);
  assert.equal(channel.id, 'lark');
  assert.equal(channel.richText, true);
  assert(channel.formatNote.startsWith('[飞书回复格式]'));
  assert.equal(channel.isPermanentSendError({ detail: { code: 230011 } }), true);
  assert.equal(channel.isPermanentSendError(new Error('network')), false);
  const event = { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'post', content: '你好' };
  assert.deepEqual(normalize(event, base), { id: 'om_1', chatId: 'oc_1', chatType: 'private', kind: 'rich', text: '你好', raw: event });
  assert.equal(normalize({ ...event, chat_type: 'group', message_type: 'file' }, base).kind, 'other');
  assert.equal(normalize({ ...event, chat_type: 'group' }, base).chatType, 'group');
});
