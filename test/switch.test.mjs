import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runBridge, privateEvent } from './harness.mjs';

const ids = { alpha: 'aaaaaaaa-0000-4000-8000-000000000001', script: 'bbbbbbbb-0000-4000-8000-000000000002',
  busy: 'cccccccc-0000-4000-8000-000000000003', own: 'dddddddd-0000-4000-8000-000000000004' };
const user = (cwd, content, entrypoint = 'cli') => ({ type: 'user', cwd, entrypoint, message: { role: 'user', content } });
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('owner lists, enters and leaves local Claude Code sessions from a private chat', { timeout: 20_000 }, async t => {
  const steps = ['/sessions', '/switch 2', '/switch 1', '继续 alpha', '/status', '/exit', '回到 workspace', '/switch bbbbbbbb', '/exit'];
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
  const [list, busy, entered, answer, statusReply, exited, workspace, fallback, exitedAgain] = replies;

  assert.equal(list.head, '**workspace** -- auto mode');
  assert.match(list.text, /1\. alpha 项目 · .*proj · 1 分钟前\n2\. 终端长任务 · .* · 终端执行中/);
  assert(!list.text.includes('脚本任务') && !list.text.includes('飞书 workspace'));
  assert.match(busy.text, /正在终端里执行任务/);

  assert.equal(entered.format, 'markdown');
  assert.equal(entered.head, '**alpha 项目** -- auto mode');
  assert(entered.text.startsWith('已进入会话「alpha 项目」'), entered.text);
  assert(entered.text.includes('前情梗概：\n- 目标：重构 alpha'));
  assert(!entered.text.includes('终端里还开着'));
  assert.deepEqual([answer.head, answer.format, answer.text], ['**alpha 项目** -- auto mode', 'markdown', 'answer in proj']);
  assert(statusReply.head === '**alpha 项目** -- auto mode' && statusReply.text.includes('当前会话：alpha 项目') && statusReply.text.includes('workspace 会话：ws-session'));
  // After /exit the header already names the workspace session.
  assert.deepEqual([exited.head, exited.text], ['**workspace** -- auto mode', '已退出会话「alpha 项目」，回到 workspace 会话。']);
  assert.deepEqual([workspace.head, workspace.text], ['**workspace** -- auto mode', `answer in ${path.basename(root)}`]);
  assert.equal(fallback.head, '**脚本任务** -- auto mode');
  assert(fallback.text.startsWith('已进入会话「脚本任务」'), fallback.text);
  assert(fallback.text.includes('自动梗概生成失败') && fallback.text.includes('最近的提问：脚本任务') && fallback.text.includes('最近的回复：脚本完成'));
  assert.equal(exitedAgain.head, '**workspace** -- auto mode');

  assert.equal(calls.length, 4);
  const [recap, attachedTurn, workspaceTurn, failedRecap] = calls;
  assert.deepEqual([recap.summary, recap.resumed, recap.cwd], [true, ids.alpha, project]);
  assert(recap.args.includes('--fork-session') && recap.args[recap.args.indexOf('--tools') + 1] === '');
  assert.deepEqual([attachedTurn.summary, attachedTurn.resumed, attachedTurn.cwd], [false, ids.alpha, project]);
  assert(attachedTurn.input.startsWith('继续 alpha') && attachedTurn.input.includes('这条消息是用户在飞书里发来的') && attachedTurn.input.includes(`当前工作目录：${project}`));
  assert.deepEqual([workspaceTurn.resumed, workspaceTurn.cwd], ['ws-session', root]);
  assert(!workspaceTurn.input.includes('飞书里发来的'));
  assert(workspaceTurn.input.startsWith('回到 workspace') && workspaceTurn.input.includes(`当前工作目录：${root}`) && workspaceTurn.input.includes('[飞书回复格式]'));
  assert.deepEqual([failedRecap.summary, failedRecap.resumed], [true, ids.script]);

  assert.deepEqual(Object.keys(state.sessions), ['oc_private']);
  assert.equal(state.sessions.oc_private.id, 'ws-session');
  assert.deepEqual(state.attached, {});
});
