// /rename names the session the chat continues, through Claude Code's own /rename.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBridge, privateEvent } from './harness.mjs';

const readLines = async file => { try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

test('/rename names the workspace session, generates a name when none is given, and keeps it across turns', { timeout: 20_000 }, async t => {
  const steps = ['/rename 先改名', '你好', '/rename 飞书  助手', '/status', '/rename', '再聊一句', '/status'];
  const { root, replies, state } = await runBridge(t, async () => ({ events: steps.map(content => ({ ...privateEvent, content })) }));
  const text = replies.map(r => r.text);
  assert.equal(text[0], '当前会话还没有上下文，先发一条消息再重命名。');
  assert.equal(text[2], '已将 workspace 会话重命名为「飞书 助手」。回复首行和 /status 里会显示这个名字。');
  assert(text[3].includes('当前会话：workspace（飞书 助手）'), text[3]);
  assert.equal(text[4], '已将 workspace 会话重命名为「auto-name」（根据对话内容自动生成）。回复首行和 /status 里会显示这个名字。');
  assert(text[6].includes('当前会话：workspace（auto-name）'), text[6]);
  const session = state.sessions.oc_private.id;
  const renames = await readLines(path.join(root, 'renames.jsonl'));
  assert.deepEqual(renames.map(r => [r.resumed, r.input]), [[session, '/rename 飞书 助手'], [session, '/rename']]);
  assert.equal(state.sessions.oc_private.name, 'auto-name');
  // The workspace header follows the name.
  assert.equal(replies[2].head, '**飞书 助手** -- auto mode');
  assert.equal(replies[5].head, '**auto-name** -- auto mode');
});

test('/rename in a selected session changes the reply header at once and the name in the list', { timeout: 20_000 }, async t => {
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  let project;
  const steps = ['/sessions', '/switch 1', '/rename beta 项目', '继续', '/sessions'];
  const { root, replies, state } = await runBridge(t, async root => {
    const home = path.join(root, 'claude-home');
    project = path.join(root, 'proj');
    const dir = path.join(home, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
    await fs.mkdir(project);
    await fs.mkdir(dir, { recursive: true });
    const entries = [{ type: 'user', cwd: project, entrypoint: 'cli', message: { role: 'user', content: '重构 alpha' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } }, { type: 'custom-title', customTitle: 'alpha 项目' }];
    await fs.writeFile(path.join(dir, `${id}.jsonl`), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    return { events: steps.map(content => ({ ...privateEvent, content })), env: { CLAUDE_CONFIG_DIR: home } };
  });
  assert.equal(replies[1].head, '**alpha 项目** -- auto mode');
  assert(replies[1].text.startsWith('已进入会话'));
  assert.deepEqual([replies[2].head, replies[2].text], ['**beta 项目** -- auto mode', '已将会话重命名为「beta 项目」。/sessions 列表和终端的会话列表里也会显示新名字。']);
  assert.deepEqual([replies[3].head, replies[3].text], ['**beta 项目** -- auto mode', 'answer in proj']);
  assert.equal(state.attached.oc_private.name, 'beta 项目');
  const [rename] = await readLines(path.join(root, 'renames.jsonl'));
  assert.deepEqual([rename.resumed, rename.input, rename.cwd], [id, '/rename beta 项目', project]);
});
