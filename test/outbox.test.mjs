// Files the agent saves in the turn's outbox are sent back after its answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBridge, privateEvent } from './harness.mjs';

test('files saved in the outbox are sent after the answer; unsuitable ones are reported, not sent', { timeout: 30_000 }, async t => {
  const events = ['MAKE-FILES 生成报告', 'MAKE-SIX 生成六个文件', 'LIMIT-ME 再来'].map(content => ({ ...privateEvent, content }));
  const { root, replies, calls, drive } = await runBridge(t, async () => ({ events, expectReplies: 12 }));
  const [first, second, third] = [replies.filter(r => r.id === 'om_step_0'), replies.filter(r => r.id === 'om_step_1'), replies.filter(r => r.id === 'om_step_2')];
  // Answer first, then the files (over 30 MB as a Drive link), then one note about what was not sent.
  assert.deepEqual(first.map(r => r.format), ['markdown', 'text', 'file', 'markdown']);
  assert.equal(first[1].text, '「big.bin」超过 30 MB，已上传到飞书云空间：https://example.feishu.cn/file/boxcnfake');
  assert.equal(first[2].text, 'report.md');
  assert.equal(first[2].content, '# report');
  assert(path.basename(first[2].cwd).startsWith('lark-upload-') && first[2].cwd.startsWith(fs.realpathSync(os.tmpdir())));
  assert(!first[3].text.includes('big.bin'), first[3].text);
  assert.match(first[3].text, /「empty.txt」是空文件，没有发送/);
  assert.match(first[3].text, /「link」不是普通文件（文件夹或链接），没有发送/);
  // Uploaded from a private temp dir; the sender gets full access.
  const [upload, grant] = drive;
  assert.deepEqual([upload.op, upload.name, upload.size], ['upload', 'big.bin', 31 * 1024 * 1024]);
  assert(upload.cwd.startsWith(fs.realpathSync(os.tmpdir())));
  assert.deepEqual([grant.op, grant.params, grant.data, grant.yes], ['grant', { token: 'boxcnfake', type: 'file' },
    { member_type: 'openid', member_id: 'ou_owner', perm: 'full_access' }, true]);
  // At most five files per answer.
  assert.deepEqual(second.filter(r => r.format === 'file').map(r => r.text), ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);
  assert.match(second.at(-1).text, /「f6.txt」超出每次最多 5 个文件/);
  assert.equal(third.length, 1);
  // The prompt names the outbox; sent files are deleted, a failed turn leaves no empty outbox behind.
  const prompt = calls.find(call => call.input.startsWith('MAKE-FILES')).input;
  assert(prompt.includes('[桥接回传文件]') && prompt.includes(path.join(root, 'outbox')) && prompt.includes('超过 30 MB 的改为上传后发链接，每个最多 1024 MB，最多 5 个'));
  const outboxes = fs.readdirSync(path.join(root, 'outbox'));
  const leftovers = outboxes.map(dir => fs.readdirSync(path.join(root, 'outbox', dir)).sort());
  assert.deepEqual(leftovers.sort((a, b) => a.length - b.length), [['f6.txt'], ['empty.txt', 'link']]);
});

test('without the Drive scopes a large file is reported once and kept on this machine', { timeout: 30_000 }, async t => {
  const { replies, drive, state } = await runBridge(t, async () => ({ events: [{ ...privateEvent, content: 'MAKE-FILES 生成报告' }],
    driveDenied: true, expectReplies: 4 }));
  assert.deepEqual(replies.map(r => r.format), ['markdown', 'text', 'file', 'markdown']);
  assert.match(replies[1].text, /^「big.bin」超过 30 MB，需要上传到飞书云空间再发链接，但机器人缺少权限（missing drive:file:upload）。文件留在本机：.*big\.bin$/);
  assert.equal(fs.statSync(replies[1].text.split('文件留在本机：')[1]).size, 31 * 1024 * 1024);
  assert.deepEqual(drive, []);
  assert.deepEqual(state.outbox, []);
});

test('a file over the tenant Drive size limit is reported once, not retried', { timeout: 30_000 }, async t => {
  const { replies, drive, state } = await runBridge(t, async () => ({ events: [{ ...privateEvent, content: 'MAKE-FILES 生成报告' }],
    driveDenied: 'size', expectReplies: 4 }));
  assert.deepEqual(replies.map(r => r.format), ['markdown', 'text', 'file', 'markdown']);
  assert.match(replies[1].text, /^「big.bin」超过 30 MB，需要上传到飞书云空间再发链接，但飞书云空间拒绝了这个大小的文件（超出租户的单文件上传上限）。文件留在本机：/);
  assert.deepEqual(drive, []);
  assert.deepEqual(state.outbox, []);
});
