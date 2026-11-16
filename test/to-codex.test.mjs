// /to with the real Codex module: a fake `codex` program and a fake $CODEX_HOME session record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../core/hub.mjs';
import { createAgent } from '../codex-agent/index.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 500; i++) { if (check()) return; await wait(10); }
  assert.fail(`timed out waiting for ${label}`);
}
const id = '11111111-2222-4333-8444-555555555555';

test('Codex: /to resumes the named session in its own directory and answers in a thread', { timeout: 20_000 }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'to-codex-test-')));
  const home = path.join(root, 'codex-home'), project = path.join(root, 'proj'), runtime = path.join(root, 'runtime');
  const day = path.join(home, 'sessions', '2026', '11', '16');
  await Promise.all([fs.mkdir(day, { recursive: true }), fs.mkdir(project), fs.mkdir(runtime)]);
  await fs.writeFile(path.join(day, `rollout-2026-11-16T10-00-00-${id}.jsonl`), [
    { timestamp: '2026-11-16T10:00:00Z', type: 'session_meta', payload: { id, cwd: project, source: 'cli' } },
    { timestamp: '2026-11-16T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'codex alpha task' } },
    { timestamp: '2026-11-16T10:00:02Z', type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  // The fake codex records its arguments and answers with the directory it ran in.
  const bin = path.join(root, 'codex.js'), calls = path.join(root, 'calls.jsonl');
  await fs.writeFile(bin, `const fs=require('fs'),args=process.argv.slice(2);let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,cwd:process.cwd(),input})+'\\n');
const r=args.indexOf('resume'),thread=r<0?'99999999-2222-4333-8444-555555555555':args[r+1],text='codex answer in '+require('path').basename(args[args.indexOf('-C')+1]);
fs.writeFileSync(args[args.indexOf('-o')+1],text);
console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));});`);
  const config = { offerSelfTest: false, workspace: root, sessionDir: root, turnTimeoutMs: 10_000, botName: 'Cora', codexBin: bin };
  const agent = createAgent(config, { env: { ...process.env, CODEX_HOME: home }, runtime });
  const sent = [];
  let handlers;
  const channel = { id: 'stub', displayName: 'Stub', richText: false, threads: true, start(h) { handlers = h; h.ready(); }, stop() {},
    send: async entry => { sent.push(entry); }, isPermanentSendError: () => false, acknowledge: async () => {} };
  const hub = createHub({ config, agent, channel, runtime, log() {} });
  hub.start();
  t.after(async () => { hub.shutdown(); await wait(50); await fs.rm(root, { recursive: true, force: true }); });
  const say = async (msgId, text, thread) => {
    handlers.message({ id: msgId, chatId: 'chat', chatType: 'private', userId: 'u1', kind: 'text', text, ...(thread ? { thread } : {}) });
    await until(() => sent.some(entry => entry.messageId === msgId), `the reply to ${text}`);
    await wait(30);
    return sent.filter(entry => entry.messageId === msgId);
  };
  const [opened] = await say('m1', '/to codex alpha task 看看进度');
  assert.equal(opened.inThread, true);
  assert.match(opened.text, /codex answer in proj$/);
  const [followUp] = await say('m2', '继续', 'm1');
  assert.equal(followUp.inThread, undefined);
  assert.match(followUp.text, /codex answer in proj$/);
  const [main] = await say('m3', '主聊天');
  assert.match(main.text, new RegExp(`codex answer in ${path.basename(root)}$`), 'the chat itself is not in the Codex session');
  const runs = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const resumed = run => (run.args.includes('resume') ? run.args[run.args.indexOf('resume') + 1] : null);
  assert.deepEqual(runs.map(run => [resumed(run), run.input.split('\n')[0]]), [[id, '看看进度'], [id, '继续'], [null, '主聊天']]);
});
