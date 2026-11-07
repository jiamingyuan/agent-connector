// Files the agent saves in the turn's outbox are sent back after its answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBridge, privateEvent } from './harness.mjs';

test('files saved in the outbox are sent after the answer; unsuitable ones are reported, not sent', { timeout: 30_000 }, async t => {
  const events = ['MAKE-FILES 生成报告', 'MAKE-SIX 生成六个文件', 'LIMIT-ME 再来'].map(content => ({ ...privateEvent, content }));
  const { root, replies, calls } = await runBridge(t, async () => ({ events, expectReplies: 11 }));
  const [first, second, third] = [replies.filter(r => r.id === 'om_step_0'), replies.filter(r => r.id === 'om_step_1'), replies.filter(r => r.id === 'om_step_2')];
  // Answer first, then the file, then one note about what was not sent.
  assert.deepEqual(first.map(r => r.format), ['markdown', 'file', 'markdown']);
  assert.equal(first[1].text, 'report.md');
  assert.equal(first[1].content, '# report');
  assert(path.basename(first[1].cwd).startsWith('lark-upload-') && first[1].cwd.startsWith(fs.realpathSync(os.tmpdir())));
  assert.match(first[2].text, /「big.bin」（31 MB）超过 30 MB，没有发送/);
  assert.match(first[2].text, /「empty.txt」是空文件，没有发送/);
  assert.match(first[2].text, /「link」不是普通文件（文件夹或链接），没有发送/);
  // At most five files per answer.
  assert.deepEqual(second.filter(r => r.format === 'file').map(r => r.text), ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']);
  assert.match(second.at(-1).text, /「f6.txt」超出每次最多 5 个文件/);
  assert.equal(third.length, 1);
  // The prompt names the outbox; sent files are deleted, a failed turn leaves no empty outbox behind.
  const prompt = calls.find(call => call.input.startsWith('MAKE-FILES')).input;
  assert(prompt.includes('[桥接回传文件]') && prompt.includes(path.join(root, 'outbox')) && prompt.includes('每个最多 30 MB，最多 5 个'));
  const outboxes = fs.readdirSync(path.join(root, 'outbox'));
  const leftovers = outboxes.map(dir => fs.readdirSync(path.join(root, 'outbox', dir)).sort());
  assert.deepEqual(leftovers.sort((a, b) => a.length - b.length), [['f6.txt'], ['big.bin', 'empty.txt', 'link']]);
});
