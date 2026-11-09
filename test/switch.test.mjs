import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBridge, privateEvent } from './harness.mjs';

const ids = { alpha: 'aaaaaaaa-0000-4000-8000-000000000001', script: 'bbbbbbbb-0000-4000-8000-000000000002',
  busy: 'cccccccc-0000-4000-8000-000000000003', own: 'dddddddd-0000-4000-8000-000000000004' };
const user = (cwd, content, entrypoint = 'cli') => ({ type: 'user', cwd, entrypoint, message: { role: 'user', content } });
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('owner lists and moves between local Claude Code sessions; no session is special', { timeout: 20_000 }, async t => {
  const steps = ['/sessions', '/switch 2', '/switch 1', '继续 alpha', '/status', '/exit', '/switch bbbbbbbb', '/new', '新话题'];
  let project;
  const { root, replies, calls, state } = await runBridge(t, async root => {
    // A fake Claude Code home: a titled terminal session, a scripted one, one busy in a terminal, and the bridge's own.
    const home = path.join(root, 'claude-home');
    project = path.join(root, 'proj');
    await fs.mkdir(project);
    const transcript = async (cwd, id, entries, ageMs) => {
      const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${id}.jsonl`);
      await fs.writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      const time = new Date(Date.now() - ageMs);
      await fs.utimes(file, time, time);
    };
    await transcript(project, ids.alpha, [user(project, '重构 alpha'), assistant('已完成第一步'), { type: 'custom-title', customTitle: 'alpha 项目' }], 60_000);
    await transcript(project, ids.busy, [user(project, '长任务'), { type: 'ai-title', aiTitle: '终端长任务' }, assistant('处理中')], 120_000);
    await transcript(project, ids.script, [user(project, '脚本任务\n\n[桥接运行信息]\n当前工作目录：/x', 'sdk-cli'), assistant('脚本完成')], 86_400_000);
    await transcript(root, ids.own, [user(root, '飞书 workspace 对话', 'sdk-cli'), assistant('回复')], 0);
    await fs.mkdir(path.join(home, 'sessions'));
    await fs.writeFile(path.join(home, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: ids.busy, status: 'busy' }));
    return { events: steps.map(content => ({ ...privateEvent, content })), env: { CLAUDE_CONFIG_DIR: home }, failSummary: ['bbbbbbbb'],
      state: { sessions: { oc_private: { id: 'ws-session' } }, seen: [], outbox: [] } };
  });
  const [list, busy, entered, answer, statusReply, exitReply, fallback, fresh, freshAnswer] = replies;

  assert.equal(list.head, '**新会话** -- auto mode');
  assert.match(list.text, /1\. alpha 项目 · .*proj · 1 分钟前\n2\. 终端长任务 · .* · 终端执行中/);
  assert(!list.text.includes('脚本任务') && !list.text.includes('飞书 workspace'));
  assert.match(busy.text, /正在终端里执行任务/);

  assert.equal(entered.format, 'markdown');
  assert.equal(entered.head, '**alpha 项目** -- auto mode');
  assert(entered.text.startsWith('已进入会话「alpha 项目」') && entered.text.endsWith('直接发消息即可在这个会话里继续。'), entered.text);
  assert(entered.text.includes('前情梗概：\n- 目标：重构 alpha'));
  assert(!entered.text.includes('终端里还开着'));
  assert.deepEqual([answer.head, answer.format, answer.text], ['**alpha 项目** -- auto mode', 'markdown', 'answer in proj']);
  assert(statusReply.text.includes('当前会话：alpha 项目\n') && statusReply.text.includes(`会话 ID：${ids.alpha}`) && statusReply.text.includes(`会话目录：${project}`), statusReply.text);
  assert(exitReply.text.includes('/exit 已取消'), exitReply.text);
  assert.equal(fallback.head, '**脚本任务** -- auto mode');
  assert(fallback.text.includes('自动梗概生成失败') && fallback.text.includes('最近的提问：脚本任务') && fallback.text.includes('最近的回复：脚本完成'));
  assert.equal(fresh.text, '已离开会话「脚本任务」，它仍在 /sessions 列表中。已开启新会话，下一条消息会创建新的 Claude Code 上下文。');
  assert.deepEqual([freshAnswer.head, freshAnswer.text], ['**新会话** -- auto mode', `answer in ${path.basename(root)}`]);

  const [recap, alphaTurn, failedRecap, freshTurn] = calls.filter(call => !call.input.startsWith('/rename'));
  assert.deepEqual([recap.summary, recap.resumed, recap.cwd], [true, ids.alpha, project]);
  assert(recap.args.includes('--fork-session') && recap.args[recap.args.indexOf('--tools') + 1] === '');
  assert.deepEqual([alphaTurn.summary, alphaTurn.resumed, alphaTurn.cwd], [false, ids.alpha, project]);
  // Every session gets the same notes, including where the message came from.
  assert(alphaTurn.input.startsWith('继续 alpha') && alphaTurn.input.includes('这条消息是用户在飞书里发来的') && alphaTurn.input.includes(`当前工作目录：${project}`));
  assert.deepEqual([failedRecap.summary, failedRecap.resumed], [true, ids.script]);
  assert.deepEqual([freshTurn.resumed, freshTurn.cwd], [null, root]);
  assert(freshTurn.input.includes('这条消息是用户在飞书里发来的') && freshTurn.input.includes('[飞书回复格式]'));

  // The old ws-session left no trace once the chat moved on; the fresh session is now the chat's session.
  assert.deepEqual(Object.keys(state.sessions), ['oc_private']);
  assert.notEqual(state.sessions.oc_private.id, 'ws-session');
  assert.equal(state.attached, undefined);
});

test('one list: the chat session sits among the others; after /new the next one starts in sessionDir', { timeout: 20_000 }, async t => {
  // /switch numbers refer to the latest list.
  const steps = ['/sessions', '/sessions all', '/switch 1', '/sessions', '/switch 2', '/switch 2', '/new', '你好'];
  let home, sessionDir;
  const { root, replies, calls, state } = await runBridge(t, async root => {
    home = path.join(root, 'claude-home');
    sessionDir = path.join(root, 'home');
    await fs.mkdir(sessionDir);
    await fs.writeFile(path.join(root, 'CLAUDE.md'), '# bridge instructions');
    const write = async (cwd, id, entries, ageMs) => {
      const dir = path.join(home, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${id}.jsonl`);
      await fs.writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
      const time = new Date(Date.now() - ageMs);
      await fs.utimes(file, time, time);
    };
    const project = path.join(root, 'proj');
    await fs.mkdir(project);
    await write(project, ids.alpha, [user(project, '重构 alpha'), assistant('好'), { type: 'custom-title', customTitle: 'alpha 项目' }], 60_000);
    // The chat's own session: made by the bridge (headless) but named, so it is listed with the others.
    await write(root, ids.own, [user(root, '准备试听课', 'sdk-cli'), assistant('好'), { type: 'custom-title', customTitle: '试听课大纲' }], 120_000);
    await write(root, ids.script, [user(root, '以前的飞书对话', 'sdk-cli'), assistant('回复')], 86_400_000);
    return { events: steps.map(content => ({ ...privateEvent, content })), env: { CLAUDE_CONFIG_DIR: home },
      config: { sessionDir },
      state: { sessions: { oc_private: { id: ids.own, name: '试听课大纲' } }, seen: [], outbox: [] } };
  });
  const text = replies.map(r => r.text);
  assert(text[0].startsWith('会话（最近活动在前）：\n1. alpha 项目 · '), text[0]);
  assert(text[0].includes('2. 试听课大纲 · ') && text[0].includes('· 当前'), text[0]);
  assert(!text[0].includes('workspace 会话：') && !text[0].includes('以前的飞书对话'));
  assert(text[1].includes('以前的飞书对话') && text[1].includes('· 脚本') && !/试听课大纲[^\n]*脚本/.test(text[1]), text[1]);
  assert(text[2].includes('已进入会话「alpha 项目」'));
  assert(/2\. 试听课大纲 · [^\n]*\n/.test(text[3]) && /alpha 项目 · [^\n]*· 当前/.test(text[3]), text[3]);
  // Going back to the session the chat started in works like entering any other one, recap included.
  assert(text[4].startsWith('已进入会话「试听课大纲」\n目录：'), text[4]);
  assert(text[4].includes('前情梗概：\n- 目标：重构 alpha') && text[4].endsWith('直接发消息即可在这个会话里继续。'), text[4]);
  assert(calls.some(call => call.summary && call.resumed === ids.own));
  assert.equal(text[5], '当前已经在会话「试听课大纲」中。');
  // After /new the chat's next session starts in sessionDir, with the bridge instructions passed along.
  const fresh = calls.find(call => call.input.startsWith('你好'));
  assert.equal(fresh.cwd, sessionDir);
  assert.equal(fresh.resumed, null);
  // Not recorded as sdk-cli, so the terminal /resume picker lists it.
  assert.equal(fresh.entrypoint, 'agent-connector');
  assert.equal(fresh.args[fresh.args.indexOf('--append-system-prompt-file') + 1], path.join(root, 'CLAUDE.md'));
  assert.equal(state.sessions.oc_private.cwd, sessionDir);
});
