import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSessions, filterSessions, pickSession, runningSessions, sessionDigest, sessionLabel, promptText,
  formatSessionList, timeAgo } from '../claude-code-agent/sessions.mjs';

const ids = { titled: 'aaaaaaaa-0000-4000-8000-000000000001', scripted: 'bbbbbbbb-0000-4000-8000-000000000002',
  ai: 'cccccccc-0000-4000-8000-000000000003', empty: 'dddddddd-0000-4000-8000-000000000004', bridge: 'eeeeeeee-0000-4000-8000-000000000005' };
const key = dir => dir.replace(/[^a-zA-Z0-9]/g, '-');
const user = (cwd, content, extra = {}) => ({ type: 'user', cwd, entrypoint: 'cli', message: { role: 'user', content }, ...extra });
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
function transcript(home, cwd, id, entries, ageMs) {
  const dir = path.join(home, 'projects', key(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  const time = new Date(Date.now() - ageMs);
  fs.utimesSync(file, time, time);
  return file;
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-sessions-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = '/srv/my.app', workspace = '/srv/bridge/workspace';
  transcript(home, project, ids.titled, [
    { type: 'mode', mode: 'normal' },
    user(project + '/web', '<command-name>/model</command-name>'),
    user(project, '第一次提问\n第二行'),
    { type: 'ai-title', aiTitle: '自动标题' },
    { type: 'user', cwd: project, message: { role: 'user', content: [{ type: 'tool_result', content: 'tool output' }] } },
    assistant('完成第一步'),
    { type: 'custom-title', customTitle: 'my*app `重构`' },
  ], 60_000);
  transcript(home, project, ids.scripted, [user(project, '脚本任务\n\n[桥接运行信息]\n当前工作目录：/x', { entrypoint: 'sdk-cli' }), assistant('脚本完成')], 86_400_000 * 2);
  transcript(home, '/srv/other', ids.ai, [user('/srv/other', '另一个问题'), { type: 'ai-title', aiTitle: '另一个项目' }, assistant('好的')], 3 * 3_600_000);
  transcript(home, '/srv/other', ids.empty, [user('/srv/other', '只有提问')], 1000);
  transcript(home, workspace, ids.bridge, [user(workspace, '飞书里的对话', { entrypoint: 'sdk-cli' }), assistant('回复')], 0);
  fs.writeFileSync(path.join(home, 'projects', key(project), 'agent-1234.jsonl'), JSON.stringify(user(project, 'subagent')) + '\n');
  return { home, project, workspace };
}

test('catalog lists real exchanges, newest first, named by title and filed under the launch directory', t => {
  const { home, project, workspace } = fixture(t);
  const sessions = listSessions({ home, exclude: [workspace] });
  assert.deepEqual(sessions.map(session => session.id), [ids.titled, ids.ai, ids.scripted]);
  const [titled, ai, scripted] = sessions;
  assert.equal(titled.name, 'my app 重构');
  assert.equal(titled.cwd, project);
  assert.equal(titled.headless, false);
  assert.equal(ai.name, '另一个项目');
  assert.equal(scripted.name, '脚本任务');
  assert.equal(scripted.headless, true);
  assert(titled.file.endsWith(`${ids.titled}.jsonl`));
  assert(listSessions({ home }).some(session => session.id === ids.bridge));
  assert.deepEqual(listSessions({ home: path.join(home, 'missing') }), []);
});

test('default view hides scripted sessions; all and keywords search everything', t => {
  const { home, workspace } = fixture(t);
  const sessions = listSessions({ home, exclude: [workspace] });
  assert.deepEqual(filterSessions(sessions).map(session => session.id), [ids.titled, ids.ai]);
  assert.equal(filterSessions(sessions, 'all').length, 3);
  assert.equal(filterSessions(sessions, '全部').length, 3);
  assert.deepEqual(filterSessions(sessions, '脚本').map(session => session.id), [ids.scripted]);
  assert.deepEqual(filterSessions(sessions, '/srv/OTHER').map(session => session.id), [ids.ai]);
  assert.deepEqual(filterSessions(sessions, 'bbbbbbbb').map(session => session.id), [ids.scripted]);
});

test('selection accepts the listed number, an ID prefix or an exact name', t => {
  const { home, workspace } = fixture(t);
  const sessions = listSessions({ home, exclude: [workspace] });
  const listed = filterSessions(sessions).map(session => session.id);
  assert.deepEqual(pickSession(sessions, '2', listed).map(session => session.id), [ids.ai]);
  assert.deepEqual(pickSession(sessions, '9', listed), []);
  assert.deepEqual(pickSession(sessions, 'BBBBBBBB-0000', listed).map(session => session.id), [ids.scripted]);
  assert.deepEqual(pickSession(sessions, '另一个项目', listed).map(session => session.id), [ids.ai]);
  assert.deepEqual(pickSession(sessions, 'my*app `重构`', listed).map(session => session.id), [ids.titled]);
  assert.deepEqual(pickSession(sessions, '另一个', listed), []);
});

test('only live registry entries count as open terminals, and idle is distinguished from busy', t => {
  const { home } = fixture(t);
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ids.titled, status: 'busy' }));
  // Another live process: the one that started this test.
  fs.writeFileSync(path.join(dir, `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, sessionId: ids.ai, status: 'idle' }));
  fs.writeFileSync(path.join(dir, '999999999.json'), JSON.stringify({ pid: 999999999, sessionId: ids.scripted, status: 'idle' }));
  fs.writeFileSync(path.join(dir, '42.0123abcd.key'), 'not json');
  fs.writeFileSync(path.join(dir, '43.json'), '{"pid":');
  const running = runningSessions(home);
  assert.deepEqual(running.get(ids.titled), { pid: process.pid, busy: true });
  assert.deepEqual(running.get(ids.ai), { pid: process.ppid, busy: false });
  assert(!running.has(ids.scripted));
  assert.equal(runningSessions(path.join(home, 'missing')).size, 0);
});

test('recap fallback keeps the last real exchange and strips bridge notes', t => {
  const { home, workspace } = fixture(t);
  const [titled, , scripted] = listSessions({ home, exclude: [workspace] });
  assert.deepEqual(sessionDigest(titled.file), { prompt: '第一次提问 第二行', reply: '完成第一步' });
  assert.deepEqual(sessionDigest(scripted.file), { prompt: '脚本任务', reply: '脚本完成' });
  assert.equal(promptText({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }), '');
  assert.equal(promptText({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image' }] } }), 'hi');
});

test('labels are single-line, Markdown-safe and bounded; list text shows terminal and current markers', () => {
  assert.equal(sessionLabel('a\n**b**  `c` [d](e) <f>|g~h\\'), 'a b c d (e) f g h');
  assert.equal([...sessionLabel('长'.repeat(60))].length, 40);
  const now = Date.now();
  assert.equal(timeAgo(now - 30_000, now), '刚刚');
  assert.equal(timeAgo(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(timeAgo(now - 3 * 3_600_000, now), '3 小时前');
  assert.equal(timeAgo(now - 2 * 86_400_000, now), '2 天前');
  const shown = [{ id: 'one', name: '项目一', cwd: '/srv/one', mtimeMs: now, headless: false },
    { id: 'two', name: '项目二', cwd: '/srv/two', mtimeMs: now - 120_000, headless: true }];
  const text = formatSessionList(shown, { total: 5, now, current: 'two',
    running: new Map([['one', { pid: 1, busy: false }], ['two', { pid: 2, busy: true }]]) });
  assert.match(text, /^会话（最近活动在前）/);
  assert(text.includes('1. 项目一 · /srv/one · 刚刚 · 终端打开中'));
  assert(text.includes('2. 项目二 · /srv/two · 2 分钟前 · 当前 · 终端执行中 · 脚本'));
  assert(text.includes('另有 3 个更早的会话'));
  assert(text.includes('/switch 编号'));
  assert.match(formatSessionList([], { query: 'abc' }), /没有找到匹配「abc」的会话/);
});
