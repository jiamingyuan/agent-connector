import test from 'node:test';
import assert from 'node:assert/strict';
import { agentInvocation, agentInput, parseAgentEvent } from '../backends.mjs';

const config = { backend: 'claude', claudeBin: '/bin/claude', workspace: '/workspace' };
test('group prompts identify their audience without applying group context to private messages', () => {
  const text = agentInput(config, '你好', [], { chatType: 'group' });
  assert(text.includes('当前为群聊'));
  assert(text.includes('不要读取或引用私聊、其他群'));
  assert(!agentInput(config, '你好').includes('当前为群聊'));
});
test('Claude resumes an explicit session without bypassing tool permissions', () => {
  const invocation = agentInvocation(config, 'cora-session', '/unused');
  assert.equal(invocation.bin, '/bin/claude');
  assert.deepEqual(invocation.args.slice(-2), ['--resume', 'cora-session']);
  assert(invocation.args.includes('dontAsk'));
  assert(invocation.args.includes('none'));
  assert(!invocation.args.some(arg => arg.includes('bypass') || arg.includes('dangerously')));
});
test('Claude results require success and preserve the exact session ID', () => {
  assert.deepEqual(parseAgentEvent(config, { type: 'system', subtype: 'init', session_id: 's1', model: 'current' }),
    { ready: true, sessionId: 's1', model: 'current' });
  assert.equal(parseAgentEvent(config, { type: 'result', subtype: 'success', is_error: false, result: 'answer', session_id: 's1' }).text, 'answer');
  const failure = parseAgentEvent(config, { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'failure' });
  assert.equal(failure.completed, false);
  assert.equal(failure.failed, true);
  assert.equal(failure.text, undefined);
  assert.deepEqual(parseAgentEvent(config, { type: 'assistant', message: { content: 'intermediate text' } }), {});
});
test('Cora can pre-approve web research without granting shell or editing permissions', () => {
  const invocation = agentInvocation({ ...config, claudeAllowedTools: ['WebSearch', 'WebFetch'] }, 's1', '/unused');
  assert.equal(invocation.args[invocation.args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert(invocation.args.includes('dontAsk'));
  assert(!invocation.args.some(arg => /bypass|dangerously|acceptEdits|Bash|Write|Edit/.test(arg)));
  assert.deepEqual(invocation.args.slice(-2), ['--resume', 's1']);
  assert(!agentInvocation(config, null, '/unused').args.includes('--allowedTools'));
});
test('explicit Cora bypass setting applies to the main agent and exact resumed session', () => {
  const invocation = agentInvocation({ ...config, claudePermissionMode: 'bypassPermissions' }, 'existing-session', '/unused');
  assert.equal(invocation.args[invocation.args.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.deepEqual(invocation.args.slice(-2), ['--resume', 'existing-session']);
  assert(!invocation.args.includes('--allowedTools'));
  assert.throws(() => agentInvocation({ ...config, claudePermissionMode: 'typo' }, null, '/unused'), /permission mode/);
  assert.equal(agentInvocation(config, null, '/unused').args[agentInvocation(config, null, '/unused').args.indexOf('--permission-mode') + 1], 'dontAsk');
});
test('Codex protocol retains thread-start and completed-turn semantics', () => {
  assert.deepEqual(parseAgentEvent({}, { type: 'thread.started', thread_id: 'c1' }), { ready: true, sessionId: 'c1' });
  assert.deepEqual(parseAgentEvent({}, { type: 'turn.completed' }), { completed: true });
});
test('Claude receives real image bytes with the text and explicit session resume', () => {
  const images = [{ path: '/workspace/attachments/1.png', mediaType: 'image/png', data: 'aW1hZ2U=' }];
  const invocation = agentInvocation(config, 's1', '/unused', images);
  assert(invocation.args.includes('--input-format'));
  assert.deepEqual(invocation.args.slice(-2), ['--resume', 's1']);
  const input = JSON.parse(agentInput(config, '这是什么？', images));
  assert.equal(input.type, 'user');
  assert(input.message.content[0].text.includes('这是什么？'));
  assert(input.message.content[0].text.includes(images[0].path));
  assert.deepEqual(input.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } });
  assert.equal(agentInput(config, 'plain text'), 'plain text');
  assert.equal(agentInput({}, 'Codex text', images), 'Codex text');
});
test('current rich reply guidance accompanies each turn including an existing resumed conversation', () => {
  const input = agentInput({ ...config, replyFormat: 'markdown' }, '继续刚才的调研');
  assert(input.startsWith('继续刚才的调研'));
  assert(input.includes('[飞书回复格式]'));
  assert(input.includes('当前工作目录：/workspace'));
  assert(input.includes('除非用户本轮另有格式要求'));
  assert.equal(agentInput({}, 'unchanged Codex input'), 'unchanged Codex input');
});
