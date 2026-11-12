// A withdrawn message stops its own work and gets no reply, whichever way the channel learns of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../core/hub.mjs';
import { createChannel } from '../lark-channel/index.mjs';
import { fakeBin } from './harness.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (check()) return; await wait(10); }
  assert.fail(`timed out waiting for ${label}`);
}

// A hub with a stub agent whose turns end only when told to, and a stub channel that records replies.
async function setup(t, channelExtras = {}) {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-test-'));
  const turns = [], replies = [], logs = [];
  let handlers;
  const agent = { id: 'stub', displayName: 'Stub', capabilities: { images: false, files: false },
    runTurn({ text }) {
      let finish;
      const turn = { text, cancelled: false, finish: answer => finish(answer) };
      turns.push(turn);
      return { cancel() { turn.cancelled = true; finish(null); }, result: new Promise(resolve => { finish = resolve; }) };
    } };
  const channel = { id: 'stub', displayName: 'Stub', richText: false, start(h) { handlers = h; h.ready(); }, stop() {},
    send: async entry => { replies.push(entry); }, isPermanentSendError: () => false, acknowledge: async () => {}, ...channelExtras };
  const hub = createHub({ config: { workspace: runtime, sessionDir: runtime, turnTimeoutMs: 5000, botName: 'Cora', recallCheckMs: 20 },
    agent, channel, runtime, log: (type, fields) => logs.push({ type, ...fields }) });
  hub.start();
  t.after(async () => { hub.shutdown(); await fs.rm(runtime, { recursive: true, force: true }); });
  const send = (id, text, chatId = 'chat') => handlers.message({ id, chatId, chatType: 'private', kind: 'text', text });
  return { turns, replies, logs, send, handlers };
}

test('a withdrawn message reported by the channel stops its turn, is skipped while queued, and gets no reply', async t => {
  const { turns, replies, logs, send, handlers } = await setup(t);
  send('m1', 'running'); send('m2', 'queued'); send('m3', 'kept'); send('other', 'elsewhere', 'chat-2');
  await until(() => turns.length === 2, 'both chats to start');
  handlers.recalled('m2');
  handlers.recalled('unknown');
  handlers.recalled('m1');
  assert.equal(turns[0].cancelled, true);
  assert.equal(turns[1].cancelled, false, 'another chat is not affected');
  await until(() => turns.length === 3, 'the next message to start');
  assert(turns[2].text.startsWith('kept'), 'the withdrawn queued message never runs');
  turns[2].finish('answer three'); turns[1].finish('answer elsewhere');
  await until(() => replies.length === 2, 'replies');
  assert.deepEqual(replies.map(entry => entry.messageId).sort(), ['m3', 'other']);
  assert.deepEqual(logs.filter(entry => entry.type === 'message_recalled').map(entry => [entry.messageId, entry.running]), [['m2', false], ['m1', true]]);
});

test('an answer that arrives just as its message is withdrawn is not sent', async t => {
  const { turns, replies, send, handlers } = await setup(t);
  send('m1', 'question');
  await until(() => turns.length === 1, 'the turn to start');
  turns[0].finish('late answer');
  handlers.recalled('m1');
  send('m2', 'next');
  await until(() => turns.length === 2, 'the next turn');
  turns[1].finish('second');
  await until(() => replies.length === 1, 'the reply');
  assert.equal(replies[0].messageId, 'm2');
});

test('a channel without a withdrawal event is asked while the message is in flight', async t => {
  const gone = new Set(), asked = [];
  const { turns, replies, send } = await setup(t, { isRecalled: async message => { asked.push(message.id); return gone.has(message.id); } });
  send('m1', 'running'); send('m2', 'kept');
  await until(() => turns.length === 1 && asked.includes('m1'), 'the first check');
  assert.equal(turns[0].cancelled, false);
  gone.add('m1');
  await until(() => turns[0].cancelled, 'the turn to be cancelled');
  await until(() => turns.length === 2, 'the next message to start');
  turns[1].finish('answer');
  await until(() => replies.length === 1, 'the reply');
  assert.equal(replies[0].messageId, 'm2');
  const checks = asked.length;
  await wait(80);
  assert.equal(asked.length, checks, 'finished messages are no longer checked');
});

test('the Feishu channel reads only the withdrawn flag of a message', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recall-lark-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const larkBin = await fakeBin(root, 'lark', `const fs=require('fs'),path=require('path'),args=process.argv.slice(2);
fs.appendFileSync(path.join(__dirname,'args.jsonl'),JSON.stringify(args)+'\\n');
const id=args[args.indexOf('GET')+1].split('/').pop();
if(id==='om_missing')console.log(JSON.stringify({ok:false,error:{type:'api',code:99992354}}));
else console.log(JSON.stringify({ok:true,error:null,data:{deleted:id==='om_gone'}}));
`);
  const channel = createChannel({ larkBin, profile: 'fake' }, { root, env: process.env, log() {} });
  assert.equal(await channel.isRecalled({ id: 'om_gone' }), true);
  assert.equal(await channel.isRecalled({ id: 'om_here' }), false);
  await assert.rejects(channel.isRecalled({ id: 'om_missing' }));
  const args = JSON.parse((await fs.readFile(path.join(root, 'args.jsonl'), 'utf8')).split('\n')[0]);
  assert.deepEqual(args.slice(0, 6), ['--profile', 'fake', 'api', 'GET', '/open-apis/im/v1/messages/om_gone', '--as']);
  assert(args.includes('--jq'), 'the message text is filtered out before it reaches the bridge');
});
