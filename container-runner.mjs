import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const docker = path.join(os.homedir(), '.docker/bin/docker');
const container = 'agent-workspace';
const root = '/home/main/lark-agent-bridge';
const node = '/home/main/.local/nodejs/bin/node';
const child = spawn(docker, ['exec', '--user', 'root', '--workdir', '/', container,
  '/bin/sh', '/usr/local/lib/lark-agent-bridge/cora-start.sh'], { stdio: ['ignore', 'inherit', 'inherit'] });
let stopping = false;
child.on('error', error => { console.error(JSON.stringify({ type: 'docker_error', code: error.code })); process.exitCode = 1; });
child.on('close', code => process.exit(stopping ? 0 : code || 1));
function stop() {
  if (stopping) return;
  stopping = true;
  const script = `const fs=require('fs');const file='${root}/runtime/bridge.pid';if(fs.existsSync(file)){const pid=Number(fs.readFileSync(file,'utf8'));try{const cmd=fs.readFileSync('/proc/'+pid+'/cmdline','utf8');if(cmd.includes('${root}/bridge.mjs'))process.kill(pid,'SIGTERM');}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}}`;
  execFile(docker, ['exec', '--user', 'main', container, node, '-e', script], { timeout: 6000 }, () => {});
  setTimeout(() => { child.kill('SIGTERM'); process.exit(0); }, 8000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
