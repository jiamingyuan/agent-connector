import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runBridge, privateEvent } from './harness.mjs';

const ids = { alpha: 'aaaaaaaa-0000-4000-8000-000000000001', beta: 'bbbbbbbb-0000-4000-8000-000000000002', open: 'cccccccc-0000-4000-8000-000000000003',
  own: 'dddddddd-0000-4000-8000-000000000004', gamma: 'eeeeeeee-0000-4000-8000-000000000005' };
const user = (cwd, content, entrypoint = 'cli') => ({ type: 'user', cwd, entrypoint, message: { role: 'user', content } });
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('/delete moves a listed session to the trash after confirmation, and refuses current or open sessions', { timeout: 20_000 }, async t => {
  const steps = ['/sessions', '/delete 3', '/delete 2', '/delete 1 确认', '/delete 1 确认', '/sessions', '/delete'];
  let home, folder;
  const { root, replies, state } = await runBridge(t, async root => {
    home = path.join(root, 'claude-home');
    const project = path.join(root, 'proj');
    await fs.mkdir(project);
    const write = async (cwd, id, entries, ageMs) => {
      const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${id}.jsonl`);
      await fs.writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
      const time = new Date(Date.now() - ageMs);
      await fs.utimes(file, time, time);
      return dir;
    };
    folder = await write(project, ids.alpha, [user(project, '重构 alpha'), assistant('好'), { type: 'custom-title', customTitle: 'alpha 项目' }], 60_000);
    await fs.mkdir(path.join(folder, ids.alpha));
    await fs.writeFile(path.join(folder, ids.alpha, 'custom-title.json'), '{}');
    await write(project, ids.open, [user(project, '终端里开着'), assistant('好'), { type: 'custom-title', customTitle: '终端会话' }], 120_000);
    await write(root, ids.own, [user(root, '准备试听课', 'sdk-cli'), assistant('好'), { type: 'custom-title', customTitle: '试听课大纲' }], 180_000);
    await fs.mkdir(path.join(home, 'sessions'));
    await fs.writeFile(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ids.open, status: 'idle' }));
    return { events: steps.map(content => ({ ...privateEvent, content })), env: { CLAUDE_CONFIG_DIR: home },
      state: { sessions: { oc_private: { id: ids.own, cwd: root }, oc_other: { id: ids.alpha, cwd: project } },
        attached: { oc_third: { id: ids.alpha, cwd: project, name: 'alpha 项目' } }, seen: [], outbox: [] } }; // attached: the old format, merged on load
  });
  const text = replies.map(r => r.text);
  assert(/1\. alpha 项目[^\n]*\n2\. 终端会话[^\n]*\n3\. 试听课大纲/.test(text[0]), text[0]);
  assert(text[1].includes('是当前所在的会话，不能删除'), text[1]);
  assert(text[2].includes('在终端里还开着'), text[2]);
  // "确认" without an earlier prompt only asks for the confirmation.
  assert(text[3].startsWith('将删除会话「alpha 项目」') && text[3].includes('/delete 1 确认'), text[3]);
  assert(text[4].startsWith('已删除会话「alpha 项目」'), text[4]);
  assert(!text[5].includes('alpha 项目') && text[5].includes('终端会话'), text[5]);
  assert(text[6].startsWith('用法：/delete 编号'), text[6]);

  assert(!existsSync(path.join(folder, `${ids.alpha}.jsonl`)) && !existsSync(path.join(folder, ids.alpha)));
  const [trashed] = await fs.readdir(path.join(root, 'runtime/trash'));
  const trash = path.join(root, 'runtime/trash', trashed);
  assert.deepEqual((await fs.readdir(trash)).sort(), [ids.alpha, `${ids.alpha}.jsonl`, 'restore.json'].sort());
  const restore = JSON.parse(await fs.readFile(path.join(trash, 'restore.json'), 'utf8'));
  assert.deepEqual([restore.id, restore.restoreTo], [ids.alpha, folder]);
  // Chats that used the deleted session start fresh; the others keep theirs.
  assert.deepEqual(Object.keys(state.sessions), ['oc_private']);
  assert.equal(state.attached, undefined);
  assert.deepEqual(state.pendingDeletes, {});
});

test('/delete takes several numbers and ranges, leaves out what cannot be deleted, and confirms exactly the set it showed', { timeout: 20_000 }, async t => {
  const steps = ['/sessions', '/delete 1-5 9', '/delete 1 2 确认', '/delete 2,1 确认', '/delete 3 5', '/delete 7-5', '/sessions'];
  let folder;
  const { root, replies, state } = await runBridge(t, async root => {
    const home = path.join(root, 'claude-home');
    const project = path.join(root, 'proj');
    await fs.mkdir(project);
    const write = async (cwd, id, title, ageMs, entrypoint) => {
      const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${id}.jsonl`);
      await fs.writeFile(file, [user(cwd, title, entrypoint), assistant('好'), { type: 'custom-title', customTitle: title }].map(e => JSON.stringify(e)).join('\n') + '\n');
      const time = new Date(Date.now() - ageMs);
      await fs.utimes(file, time, time);
      return dir;
    };
    folder = await write(project, ids.alpha, 'alpha 项目', 60_000);
    await write(project, ids.beta, 'beta 项目', 90_000);
    await write(project, ids.open, '终端会话', 120_000);
    await write(project, ids.gamma, 'gamma 项目', 150_000);
    await write(root, ids.own, '试听课大纲', 180_000, 'sdk-cli');
    await fs.mkdir(path.join(home, 'sessions'));
    await fs.writeFile(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ids.open, status: 'idle' }));
    return { events: steps.map(content => ({ ...privateEvent, content })), env: { CLAUDE_CONFIG_DIR: home },
      state: { sessions: { oc_private: { id: ids.own, cwd: root } }, seen: [], outbox: [] } };
  });
  const text = replies.map(r => r.text);
  assert(/1\. alpha 项目[^\n]*\n2\. beta 项目[^\n]*\n3\. 终端会话[^\n]*\n4\. gamma 项目[^\n]*\n5\. 试听课大纲/.test(text[0]), text[0]);
  assert(text[1].startsWith('将删除 3 个会话：\n1. alpha 项目') && /\n2\. beta 项目[^\n]*\n4\. gamma 项目/.test(text[1]), text[1]);
  assert(text[1].includes('不会删除（3 个）：\n3. 终端会话：在终端里还开着\n5. 试听课大纲：当前所在的会话\n9：列表里没有这个编号'), text[1]);
  assert(text[1].endsWith('/delete 1-5 9 确认'), text[1]);
  // "确认" for a set other than the one shown only shows the new set.
  assert(text[2].startsWith('将删除 2 个会话：') && !text[2].includes('gamma'), text[2]);
  assert(text[3].startsWith('已删除 2 个会话：beta 项目、alpha 项目。') && text[3].includes(path.join(root, 'runtime/trash')), text[3]);
  assert(text[4].startsWith('没有可以删除的会话。') && text[4].includes('3. 终端会话：在终端里还开着'), text[4]);
  assert(text[5].startsWith('编号范围要从小到大写'), text[5]);
  assert(!text[6].includes('alpha') && !text[6].includes('beta') && text[6].includes('gamma 项目') && text[6].includes('终端会话'), text[6]);

  assert(!existsSync(path.join(folder, `${ids.alpha}.jsonl`)) && !existsSync(path.join(folder, `${ids.beta}.jsonl`)) && existsSync(path.join(folder, `${ids.gamma}.jsonl`)));
  assert.equal((await fs.readdir(path.join(root, 'runtime/trash'))).length, 2);
  assert.deepEqual(state.pendingDeletes, {});
});
