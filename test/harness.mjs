// Runs the real bridge against a fake lark-cli and a fake Claude Code in a temporary directory.
// Events are delivered one at a time: each waits until every earlier event has been answered.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// The entry file plus the hub and every adapter folder (<name>-agent/, <name>-channel/).
const sourceDir = path.dirname(fileURLToPath(new URL('../bridge.mjs', import.meta.url)));
export const sources = ['bridge.mjs', 'core', ...(await fs.readdir(sourceDir)).filter(name => /-(agent|channel)$/.test(name))];

export async function copySources(root) {
  for (const name of sources) await fs.cp(path.join(sourceDir, name), path.join(root, name), { recursive: true });
}

export const privateEvent = { type: 'im.message.receive_v1', sender_type: 'user', sender_id: 'ou_owner', message_type: 'text',
  chat_type: 'p2p', chat_id: 'oc_private' };

// build(root) writes any fixtures and returns { events, config, state, env, failSummary }. Events get
// message IDs om_step_<index> and a fresh create_time. Returns what the bridge sent and ran.
export async function runBridge(t, build) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lark-bridge-test-')));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      await closed;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const { events, config = {}, state = { sessions: {}, seen: [], outbox: [] }, env = {}, failSummary = [] } = await build(root);
  await copySources(root);
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true });
  await fs.writeFile(path.join(root, 'runtime/state.json'), JSON.stringify(state));
  await fs.writeFile(path.join(root, 'events.json'), JSON.stringify(events.map((event, index) => ({ message_id: `om_step_${index}`, ...event }))));
  await fs.writeFile(path.join(root, 'fake.json'), JSON.stringify({ failSummary }));
  const fakeLark = path.join(root, 'lark');
  await fs.writeFile(fakeLark, `#!${process.execPath}
const fs=require('fs'),path=require('path'),root=__dirname,args=process.argv.slice(2);
if(args.includes('consume')){
 process.stderr.write('[event] ready event_key=im.message.receive_v1\\n');
 const events=JSON.parse(fs.readFileSync(path.join(root,'events.json'),'utf8'));let next=0;
 setInterval(()=>{
  let answered=0;try{answered=fs.readFileSync(path.join(root,'replies.jsonl'),'utf8').trim().split('\\n').filter(Boolean).length;}catch{}
  if(next<events.length&&answered>=next){console.log(JSON.stringify({...events[next],create_time:String(Date.now())}));next++;}
 },25);
 process.stdin.resume();
}else{
 if(args.includes('+messages-reply')){const flag=args.includes('--markdown')?'--markdown':'--text';
  fs.appendFileSync(path.join(root,'replies.jsonl'),JSON.stringify({id:args[args.indexOf('--message-id')+1],format:flag.slice(2),text:args[args.indexOf(flag)+1]})+'\\n');}
 if(args.includes('+messages-resources-download')){
  // Like lark-cli 1.0.98: relative --output under the working directory, absolute saved_path, refuses /root.
  if(process.cwd().startsWith('/root'))return console.log(JSON.stringify({ok:false,error:{type:'validation',subtype:'invalid_argument',message:'protected by the built-in denylist'}}));
  const saved=path.join(process.cwd(),args[args.indexOf('--output')+1]+'.png');
  fs.writeFileSync(saved,Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]));
  fs.appendFileSync(path.join(root,'downloads.jsonl'),JSON.stringify({key:args[args.indexOf('--file-key')+1],cwd:process.cwd()})+'\\n');
  return console.log(JSON.stringify({ok:true,data:{saved_path:saved,size_bytes:12}}));
 }
 console.log(JSON.stringify({ok:true,data:{}}));
}
`, { mode: 0o700 });
  const fakeAgent = path.join(root, 'claude');
  await fs.writeFile(fakeAgent, `#!${process.execPath}
const fs=require('fs'),path=require('path'),root=__dirname,args=process.argv.slice(2);let input='';
const {failSummary}=JSON.parse(fs.readFileSync(path.join(root,'fake.json'),'utf8'));
process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
 const index=args.indexOf('--resume'),resumed=index<0?null:args[index+1],summary=args.includes('--fork-session');
 const mode=args.includes('--permission-mode')?args[args.indexOf('--permission-mode')+1]:null;
 if(!args.includes('--permission-mode')&&!summary&&input==='/usage'){fs.appendFileSync(path.join(root,'usage.jsonl'),JSON.stringify({args,cwd:process.cwd()})+'\\n');console.log(JSON.stringify({type:'result',subtype:'success',session_id:'u',result:'Current session: 14% used'}));return;}
 if(input.startsWith('/rename')){
  // Like Claude Code: '/rename <name>' sets it, a bare '/rename' generates one.
  const name=input.slice('/rename'.length).trim()||'auto-name';
  fs.appendFileSync(path.join(root,'renames.jsonl'),JSON.stringify({args,resumed,input,cwd:process.cwd()})+'\\n');
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:resumed}));
  console.log(JSON.stringify({type:'system',subtype:'session_title_changed',session_id:resumed}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:resumed,result:'Session renamed to: '+name,local_command:'rename'}));return;
 }
 if(input.startsWith('/compact')){
  fs.appendFileSync(path.join(root,'compacts.jsonl'),JSON.stringify({args,resumed,input,cwd:process.cwd()})+'\\n');
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:resumed}));
  console.log(JSON.stringify({type:'system',subtype:'compact_boundary',session_id:resumed,compact_metadata:{trigger:'manual',pre_tokens:22102,post_tokens:7304}}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:resumed,result:''}));return;
 }
 const session=summary?'fork-'+process.pid:(resumed||'new-'+process.pid);
 // With --input-format stream-json the input is one user message whose content carries the images.
 let images=0,text=input;
 if(args.includes('--input-format')){const m=JSON.parse(input).message;images=m.content.filter(b=>b.type==='image').length;text=m.content.find(b=>b.type==='text').text;}
 fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({args,resumed,summary,mode,cwd:process.cwd(),input:text,images})+'\\n');
 if(text.startsWith('LIMIT-ME')){
  console.log(JSON.stringify({type:'system',subtype:'init',session_id:session}));
  console.log(JSON.stringify({type:'assistant',error:'rate_limit',session_id:session,message:{role:'assistant',content:[{type:'text',text:"You've hit your 5-hour limit · resets 5am (UTC)"}]}}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,session_id:session,result:"You've hit your 5-hour limit · resets 5am (UTC)"}));
  process.exit(1);
 }
 if(summary&&failSummary.some(prefix=>resumed.startsWith(prefix)))process.exit(1);
 console.log(JSON.stringify({type:'system',subtype:'init',session_id:session}));
 console.log(JSON.stringify({type:'result',subtype:'success',session_id:session,result:summary?'- 目标：重构 alpha':'answer in '+path.basename(process.cwd())}));
});
`, { mode: 0o700 });
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
    backend: 'claude', profile: 'fake', ownerOpenId: 'ou_owner', botName: 'Cora', larkBin: fakeLark, claudeBin: fakeAgent,
    replyFormat: 'markdown', workspace: root, maxEventAgeMs: 300_000, turnTimeoutMs: 10_000, ...config,
  }));
  child = spawn(process.execPath, [path.join(root, 'bridge.mjs')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let diagnostic = '';
  child.stdout.on('data', d => diagnostic += d);
  child.stderr.on('data', d => diagnostic += d);
  const readLines = async file => {
    try { return (await fs.readFile(path.join(root, file), 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  let replies = [];
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    replies = await readLines('replies.jsonl');
    if (replies.length >= events.length) break;
    if (child.exitCode !== null) assert.fail(diagnostic);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(replies.length, events.length, diagnostic);
  assert.deepEqual(replies.map(r => r.id), events.map((_, index) => `om_step_${index}`));
  // Split each reply into its header line (session name and mode) and the body.
  replies = replies.map(reply => {
    const match = /^(\*\*[^\n]*\*\*(?: -- [^\n]*)?|【[^\n]*】(?: -- [^\n]*)?)\n([\s\S]*)$/.exec(reply.text);
    return match ? { ...reply, head: match[1], text: match[2], raw: reply.text } : { ...reply, head: null, raw: reply.text };
  });
  return { root, replies, calls: await readLines('calls.jsonl'), state: JSON.parse(await fs.readFile(path.join(root, 'runtime/state.json'), 'utf8')) };
}
