import test from 'node:test';
import assert from 'node:assert/strict';
import { turnArgs, recapArgs, usageArgs, recapPrompt, turnInput, parseEvent, permissionModes, permissionMode,
  findPermissionMode, compactArgs, compactInput, parseCompactEvent, renameArgs, renameInput, parseRenameEvent } from '../claude-code-agent/cli.mjs';

const config = { agent: 'claude-code', claudeBin: '/bin/claude', workspace: '/workspace' };
const modeOf = args => args[args.indexOf('--permission-mode') + 1];
test('Claude resumes an explicit session without bypassing tool permissions', () => {
  const args = turnArgs(config, 'cora-session');
  assert.deepEqual(args.slice(-2), ['--resume', 'cora-session']);
  assert.equal(modeOf(args), 'auto');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert(!args.some(arg => arg.includes('bypass') || arg.includes('dangerously')));
  assert(!turnArgs(config, null).includes('--resume'));
});
test('Claude results require success and preserve the exact session ID', () => {
  assert.deepEqual(parseEvent({ type: 'system', subtype: 'init', session_id: 's1', model: 'current' }),
    { ready: true, sessionId: 's1', model: 'current' });
  assert.equal(parseEvent({ type: 'result', subtype: 'success', is_error: false, result: 'answer', session_id: 's1' }).text, 'answer');
  const failure = parseEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'failure' });
  assert.equal(failure.completed, false);
  assert.equal(failure.failed, true);
  assert.equal(failure.text, undefined);
  assert.deepEqual(parseEvent({ type: 'assistant', message: { content: 'intermediate text' } }), {});
});
test('Cora can pre-approve web research without granting shell or editing permissions', () => {
  const args = turnArgs({ ...config, claudeAllowedTools: ['WebSearch', 'WebFetch'] }, 's1');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert.equal(modeOf(args), 'auto');
  assert(!args.some(arg => /bypass|dangerously|acceptEdits|Bash|Write|Edit/.test(arg)));
  assert.deepEqual(args.slice(-2), ['--resume', 's1']);
  assert(!turnArgs(config, null).includes('--allowedTools'));
});
test('explicit bypass setting applies to the main agent and exact resumed session', () => {
  const args = turnArgs({ ...config, claudePermissionMode: 'bypassPermissions' }, 'existing-session');
  assert.equal(modeOf(args), 'bypassPermissions');
  assert.deepEqual(args.slice(-2), ['--resume', 'existing-session']);
  assert.throws(() => turnArgs({ ...config, claudePermissionMode: 'typo' }, null), /permission mode/);
});
test('Claude receives real image bytes with the text and explicit session resume', () => {
  const images = [{ path: '/workspace/attachments/1.png', mediaType: 'image/png', data: 'aW1hZ2U=' }];
  const args = turnArgs(config, 's1', { images });
  assert(args.includes('--input-format'));
  assert.deepEqual(args.slice(-2), ['--resume', 's1']);
  const input = JSON.parse(turnInput('这是什么？', images));
  assert.equal(input.type, 'user');
  assert(input.message.content[0].text.includes('这是什么？'));
  assert(input.message.content[0].text.includes(images[0].path));
  assert.deepEqual(input.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } });
  assert.equal(turnInput('plain text'), 'plain text');
});
test('switch recap resumes an unsaved fork without tools, MCP servers or permission bypass; /usage saves nothing', () => {
  const args = recapArgs('chosen-session');
  assert.equal(args[args.indexOf('--resume') + 1], 'chosen-session');
  assert(args.includes('--fork-session') && args.includes('--no-session-persistence') && args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert(!args.some(arg => /bypass|dangerously|allowedTools/.test(arg)));
  assert(recapPrompt.includes('前情梗概') && recapPrompt.includes('不要调用工具'));
  assert(usageArgs().includes('--no-session-persistence') && !usageArgs().includes('--resume'));
});
test('auto is the default mode; config sets another default and a chat choice overrides both', () => {
  assert.equal(permissionMode(config), 'auto');
  assert.equal(permissionMode({ ...config, claudePermissionMode: 'dontAsk' }), 'dontAsk');
  assert.equal(permissionMode({ ...config, claudePermissionMode: 'dontAsk' }, 'plan'), 'plan');
  assert.throws(() => permissionMode(config, 'default'), /permission mode/);
  assert.deepEqual(Object.keys(permissionModes), ['auto', 'dontAsk', 'acceptEdits', 'plan', 'bypassPermissions']);
  const planned = turnArgs({ ...config, claudePermissionMode: 'dontAsk' }, 's1', { mode: 'plan' });
  assert.equal(modeOf(planned), 'plan');
  assert.deepEqual(planned.slice(-2), ['--resume', 's1']);
  assert.equal(modeOf(turnArgs({ ...config, claudePermissionMode: 'dontAsk' }, null, { mode: undefined })), 'dontAsk');
  assert.throws(() => turnArgs(config, null, { mode: 'typo' }), /permission mode/);
});
test('mode names are matched case-insensitively with a short alias for bypassPermissions', () => {
  assert.equal(findPermissionMode(' AUTO '), 'auto');
  assert.equal(findPermissionMode('dontask'), 'dontAsk');
  assert.equal(findPermissionMode('acceptEdits'), 'acceptEdits');
  assert.equal(findPermissionMode('Plan'), 'plan');
  assert.equal(findPermissionMode('bypass'), 'bypassPermissions');
  assert.equal(findPermissionMode('default'), null);
  assert.equal(findPermissionMode(''), null);
});
test('API errors carry their reason, with usage-limit guidance', () => {
  const limit = parseEvent({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 5am (UTC)" }] } });
  assert.match(limit.errorText, /^Claude 订阅额度已用完（You've hit your 5-hour limit · resets 5am \(UTC\)）。.*\/usage/);
  assert.equal(parseEvent({ type: 'assistant', error: 'server_error', message: { content: [{ type: 'text', text: 'Overloaded' }] } }).errorText, 'Overloaded');
  assert.equal(parseEvent({ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long' }).errorText, 'Prompt is too long');
  assert.equal(parseEvent({ type: 'result', subtype: 'success', result: 'fine' }).errorText, undefined);
  assert.equal(parseEvent({ type: 'assistant', message: { content: [] } }).errorText, undefined);
});
test('/compact resumes the exact session and reports the token counts from the compact boundary', () => {
  assert.deepEqual(compactArgs('s1').slice(-2), ['--resume', 's1']);
  assert(compactArgs('s1').includes('--permission-prompts'));
  assert.equal(compactInput(''), '/compact');
  assert.equal(compactInput('保留决定'), '/compact 保留决定');
  assert.equal(parseCompactEvent({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 22102, post_tokens: 7304 } }).text,
    '已压缩会话上下文：约 22,102 → 7,304 tokens。之后的消息会基于压缩后的摘要继续，会话 ID 不变。');
  const done = parseCompactEvent({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's1' });
  assert.equal(done.completed, true);
  assert.equal(done.text, undefined);
});
test('/rename resumes the exact session and resolves to the name Claude Code reports', () => {
  assert.deepEqual(renameArgs('s1').slice(-2), ['--resume', 's1']);
  assert.equal(renameInput(''), '/rename');
  assert.equal(renameInput('新名字'), '/rename 新名字');
  const done = { type: 'result', subtype: 'success', is_error: false, result: 'Session renamed to: 新名字', local_command: 'rename' };
  assert.equal(parseRenameEvent(done, '新名字').text, '新名字');
  assert.equal(parseRenameEvent({ ...done, result: 'Session renamed to: auto-generated' }, '').text, 'auto-generated');
  assert.equal(parseRenameEvent({ ...done, result: 'Renamed.' }, '想要的名字').text, '想要的名字');
  assert.equal(parseRenameEvent({ ...done, is_error: true, result: 'failed' }, 'x').text, undefined);
});
test('received files outside the session directory are opened up with --add-dir', () => {
  const files = [{ path: '/ws/attachments/k1/a.pdf' }, { path: '/ws/attachments/k1/b.txt' }];
  const elsewhere = turnArgs(config, 's1', { files, cwd: '/srv/project' });
  assert.deepEqual(elsewhere.slice(elsewhere.indexOf('--add-dir'), elsewhere.indexOf('--add-dir') + 2), ['--add-dir', '/ws/attachments/k1']);
  assert.equal(elsewhere.filter(arg => arg === '/ws/attachments/k1').length, 1);
  assert.deepEqual(elsewhere.slice(-2), ['--resume', 's1']);
  assert(!turnArgs(config, 's1', { files, cwd: '/ws' }).includes('--add-dir'));
  assert(!turnArgs(config, 's1', { cwd: '/srv/project' }).includes('--add-dir'));
});
test('the outbox is opened up with --add-dir when the session runs elsewhere', () => {
  const args = turnArgs(config, 's1', { cwd: '/srv/project', outbox: '/ws/outbox/k2' });
  assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2), ['--add-dir', '/ws/outbox/k2']);
  assert.deepEqual(args.slice(-2), ['--resume', 's1']);
  assert(!turnArgs(config, 's1', { cwd: '/ws', outbox: '/ws/outbox/k2' }).includes('--add-dir'));
});
