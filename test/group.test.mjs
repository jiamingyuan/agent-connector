import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copySources } from './harness.mjs';

test('bridge isolates group sessions and enforces configured timeouts and manual stop', { timeout: 15_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lark-group-test-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  await copySources(root);
  await fs.mkdir(path.join(root, 'runtime'));
  await fs.writeFile(path.join(root, 'runtime/state.json'), JSON.stringify({ sessions: { oc_private: { id: 'private-session' } }, seen: [], outbox: [] }));
  const base = { type: 'im.message.receive_v1', sender_type: 'user', sender_id: 'ou_owner', create_time: String(Date.now()), message_type: 'text' };
  const mention = [{ id: 'ou_cora', name: 'Cora', key: '@_user_1' }];
  const events = [
    { ...base, chat_type: 'p2p', chat_id: 'oc_private', message_id: 'om_private', content: 'private request' },
    { ...base, chat_type: 'group', chat_id: 'oc_group', message_id: 'om_no_mention', content: '@Cora fake', mentions: [] },
    { ...base, chat_type: 'group', chat_id: 'oc_group', message_id: 'om_stranger', sender_id: 'ou_stranger', content: '@Cora stranger', mentions: mention },
    { ...base, chat_type: 'group', chat_id: 'oc_group', message_id: 'om_bot', sender_type: 'bot', content: '@Cora bot', mentions: mention },
    { ...base, chat_type: 'group', chat_id: 'oc_group', message_id: 'om_group_one', content: '@Cora group one', mentions: mention },
    { ...base, chat_type: 'group', chat_id: 'oc_group', message_id: 'om_group_two', content: '@_user_1 group two', mentions: mention },
    { ...base, chat_type: 'group', chat_id: 'oc_other', message_id: 'om_other', content: '@Cora other group', mentions: mention },
    { ...base, chat_type: 'group', chat_id: 'oc_group', message_id: 'om_status', content: '@Cora /status', mentions: mention },
    { ...base, chat_type: 'group', chat_id: 'oc_group', message_id: 'om_bare', content: '@Cora', mentions: mention },
    { ...base, chat_type: 'group', chat_id: 'oc_timeout', message_id: 'om_timeout', content: '@Cora hold request', mentions: mention },
    { ...base, chat_type: 'group', chat_id: 'oc_stop', message_id: 'om_stop_hang', content: '@Cora stop request', mentions: mention },
  ];
  await fs.writeFile(path.join(root, 'events.json'), JSON.stringify(events));
  const fakeLark = path.join(root, 'lark');
  await fs.writeFile(fakeLark, `#!${process.execPath}
const fs=require('fs'),path=require('path'),root=__dirname,args=process.argv.slice(2);
if(args.includes('consume')){
 process.stderr.write('[event] ready event_key=im.message.receive_v1\\n');
 setTimeout(()=>{for(const e of JSON.parse(fs.readFileSync(path.join(root,'events.json'),'utf8')))console.log(JSON.stringify(e));},50);
 const poll=setInterval(()=>{
  let calls=[];try{calls=fs.readFileSync(path.join(root,'calls.jsonl'),'utf8').trim().split('\\n').map(JSON.parse);}catch{}
  if(!calls.some(c=>c.input.startsWith('stop request')))return;
  clearInterval(poll);
  const base=JSON.parse(fs.readFileSync(path.join(root,'events.json'),'utf8')).find(e=>e.message_id==='om_stop_hang');
  console.log(JSON.stringify({...base,message_id:'om_stop_queued',content:'@Cora must-not-run'}));
  console.log(JSON.stringify({...base,message_id:'om_stop',content:'@Cora /stop'}));
 },25);
 process.stdin.resume();
}else{
 if(args.includes('+messages-reply'))fs.appendFileSync(path.join(root,'replies.jsonl'),JSON.stringify({id:args[args.indexOf('--message-id')+1],text:args[args.indexOf('--text')+1]})+'\\n');
 console.log(JSON.stringify({ok:true,data:{}}));
}
`, { mode: 0o700 });
  const fakeAgent = path.join(root, 'claude');
  await fs.writeFile(fakeAgent, `#!${process.execPath}
const fs=require('fs'),path=require('path'),root=__dirname,args=process.argv.slice(2);let input='';
process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
 const index=args.indexOf('--resume'),resumed=index<0?null:args[index+1],session=resumed||'group-'+process.pid;
 fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({resumed,session,input})+'\\n');
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:session}));
 if(input.startsWith('hold request')||input.startsWith('stop request')){setInterval(()=>{},1000);return;}
 console.log(JSON.stringify({type:'result',subtype:'success',session_id:session,result:'answer'}));
});
`, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    backend: 'claude', profile: 'fake', ownerOpenId: 'ou_owner', botOpenId: 'ou_cora', allowGroupMentions: true,
    botName: 'Cora', larkBin: fakeLark, claudeBin: fakeAgent, workspace: root, maxEventAgeMs: 300_000, turnTimeoutMs: 1500,
  }));
  child = spawn(process.execPath, [path.join(root, 'bridge.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stdout.on('data', d => diagnostic += d);
  child.stderr.on('data', d => diagnostic += d);
  const readLines = async file => {
    try { return (await fs.readFile(path.join(root, file), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  let replies = [];
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    replies = await readLines('replies.jsonl');
    if (replies.length === 8) break;
    if (child.exitCode !== null) assert.fail(diagnostic);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(replies.length, 8, diagnostic);
  assert.deepEqual(replies.map(r => r.id).sort(), ['om_bare', 'om_group_one', 'om_group_two', 'om_other', 'om_private', 'om_status', 'om_stop', 'om_timeout']);
  assert.match(replies.find(r => r.id === 'om_timeout').text, /任务超过 1 分钟已停止/);
  assert(!replies.find(r => r.id === 'om_timeout').text.includes('15 分钟'));
  assert.match(replies.find(r => r.id === 'om_stop').text, /已请求停止当前任务/);
  // Leave out the automatic /rename that names each new workspace session after its first answer.
  const calls = (await readLines('calls.jsonl')).filter(c => !c.input.startsWith('/rename'));
  assert.equal(calls.length, 6);
  assert(!calls.some(c => c.input.includes('must-not-run')));
  const byText = text => calls.find(c => c.input.startsWith(text));
  assert.equal(byText('private request').resumed, 'private-session');
  assert.equal(byText('group one').resumed, null);
  assert.equal(byText('group two').resumed, byText('group one').session);
  assert.equal(byText('other group').resumed, null);
  assert.notEqual(byText('other group').session, byText('group one').session);
  assert(byText('group one').input.includes('当前为群聊'));
  assert(!byText('private request').input.includes('当前为群聊'));
  assert(!replies.find(r => r.id === 'om_status').text.includes('private-session'));
});
