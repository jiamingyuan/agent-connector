// /compact, images in the lark-cli 1.0.98 format, and Claude errors shown with their real reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBridge, privateEvent } from './harness.mjs';

const readLines = async file => { try { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

test('/compact compacts the session the chat continues, keeps its ID, and needs a session first', { timeout: 20_000 }, async t => {
  const steps = ['/compact', '先聊一句', '/compact', '/compact 保留 newdash 的决定', '再聊一句'];
  const { root, replies, calls, state } = await runBridge(t, async () => ({ events: steps.map(content => ({ ...privateEvent, content })) }));
  const text = replies.map(r => r.text);
  assert.equal(text[0], '当前会话还没有上下文，不需要压缩。');
  assert.equal(text[2], '已压缩会话上下文：约 22,102 → 7,304 tokens。之后的消息会基于压缩后的摘要继续，会话 ID 不变。');
  const compacts = await readLines(path.join(root, 'compacts.jsonl'));
  const session = state.sessions.oc_private.id;
  assert.deepEqual(compacts.map(c => [c.resumed, c.input]), [[session, '/compact'], [session, '/compact 保留 newdash 的决定']]);
  assert(compacts.every(c => c.args.includes('--permission-prompts') && c.cwd === root));
  assert.deepEqual(calls.map(c => c.resumed), [null, session]);
});

test('images sent in the lark-cli 1.0.98 format reach Claude, downloaded outside the protected workspace', { timeout: 20_000 }, async t => {
  const events = [
    { ...privateEvent, message_type: 'image', content: '[Image: img_v3_pure]' },
    { ...privateEvent, message_type: 'post', content: '这张图是什么？\n[Image: img_v3_post]' },
  ];
  const { root, replies, calls } = await runBridge(t, async () => ({ events }));
  assert.deepEqual(replies.map(r => r.text), [`answer in ${path.basename(root)}`, `answer in ${path.basename(root)}`]);
  assert.deepEqual(calls.map(c => c.images), [1, 1]);
  assert(calls[0].args.includes('--input-format') && calls[0].input.includes('[桥接附件信息]'));
  assert(calls[1].input.startsWith('这张图是什么？'));
  const downloads = await readLines(path.join(root, 'downloads.jsonl'));
  assert.deepEqual(downloads.map(d => d.key), ['img_v3_pure', 'img_v3_post']);
  // The same resolution the bridge uses: on Windows the temp dir may be known by a short (8.3) name.
  const tmp = realpathSync(os.tmpdir());
  assert(downloads.every(d => path.basename(d.cwd).startsWith('lark-images-') && d.cwd.startsWith(tmp) && !d.cwd.startsWith(path.join(root, 'attachments'))));
  const saved = await fs.readdir(path.join(root, 'attachments'));
  assert.equal(saved.length, 2);
});

test('a usage-limit failure tells the user the real reason instead of a generic error', { timeout: 20_000 }, async t => {
  const { replies } = await runBridge(t, async () => ({ events: [{ ...privateEvent, content: 'LIMIT-ME 你好' }] }));
  assert.equal(replies[0].text, "Claude Code 本轮没有完成：Claude 订阅额度已用完（You've hit your 5-hour limit · resets 5am (UTC)）。额度恢复后重发即可，发 /usage 可查看重置时间。会话上下文仍保留。");
});
