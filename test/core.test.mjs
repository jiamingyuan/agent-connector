import test from 'node:test';
import assert from 'node:assert/strict';
import { splitText, splitMarkdown, replyParts, replyKey } from '../core/text.mjs';

test('split multilingual replies within UTF-8 byte limit without damaging characters', () => {
  const text = '中文🙂abc'.repeat(5000);
  const parts = splitText(text);
  assert.equal(parts.join(''), text);
  assert(parts.length > 1);
  assert(parts.every(part => Buffer.byteLength(part) <= 12_000));
});
test('reply keys deduplicate the same stage without suppressing another stage', () => {
  assert.equal(replyKey('om_1', 'answer'), replyKey('om_1', 'answer'));
  assert.notEqual(replyKey('om_1', 'answer'), replyKey('om_1', 'ack'));
  assert.notEqual(replyKey('om_1', 'answer', 0), replyKey('om_1', 'answer', 1));
  assert(replyKey('om_1', 'answer').length <= 50);
});
test('Markdown splits keep paragraphs, tables, headings with body, and ordinary code blocks together', () => {
  const intro = '开头。'.repeat(20) + '\n\n';
  const text = intro + '## 结果\n\n这是结论。\n\n| 项目 | 状态 |\n| --- | --- |\n| 联网 | 正常 |\n\n```sh\necho hello\n\necho world\n```\n\n结束。';
  const parts = splitMarkdown(text, 200, 1000);
  assert.equal(parts.join(''), text);
  assert(parts.some(part => part.includes('## 结果\n\n这是结论。')));
  assert(parts.some(part => part.includes('| 项目 | 状态 |\n| --- | --- |\n| 联网 | 正常 |')));
  assert(parts.some(part => part.includes('```sh\necho hello\n\necho world\n```')));
});
test('oversized Markdown code blocks have complete fences and bounded UTF-8 messages', () => {
  const body = '中文🙂abc'.repeat(3000);
  const parts = splitMarkdown('```text\n' + body + '\n```', 100, 500);
  assert(parts.length > 1);
  assert(parts.every(part => Buffer.byteLength(part) <= 500 && part.startsWith('```text\n') && part.endsWith('\n```')));
  assert.equal(parts.map(part => part.slice(8, -4)).join(''), body);
});
test('selected-session replies put the bold session name on its own line above every part', () => {
  assert.deepEqual(replyParts('回复内容', 'markdown', 'newdash'), ['**newdash**\n回复内容']);
  assert.deepEqual(replyParts('纯文本', 'text', 'newdash'), ['【newdash】\n纯文本']);
  assert.deepEqual(replyParts('workspace 回复', 'markdown'), ['workspace 回复']);
  const long = ('段落内容。'.repeat(200) + '\n\n').repeat(10);
  const parts = replyParts(long, 'markdown', '会话名');
  assert(parts.length > 1);
  assert(parts.every(part => part.startsWith('**会话名**\n') && Buffer.byteLength(part) <= 12_000));
  assert.equal(parts.map(part => part.slice('**会话名**\n'.length)).join(''), long);
  const plain = replyParts('中文🙂'.repeat(4000), 'text', '会话名');
  assert(plain.length > 1 && plain.every(part => part.startsWith('【会话名】\n') && Buffer.byteLength(part) <= 12_000));
});
test('the header can carry a note after the session name', () => {
  assert.deepEqual(replyParts('内容', 'markdown', 'workspace', 'auto mode'), ['**workspace** -- auto mode\n内容']);
  assert.deepEqual(replyParts('内容', 'text', 'workspace', '⚠️ bypassPermissions mode'), ['【workspace】 -- ⚠️ bypassPermissions mode\n内容']);
});
