import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.join(os.homedir(), '.local/share/lark-agent-bridge-cora');
const containerRoot = '/home/main/lark-agent-bridge';
const docker = path.join(os.homedir(), '.docker/bin/docker');
const containerNode = '/home/main/.local/nodejs/bin/node';
const label = 'com.jiamingyuan.lark-agent-bridge-cora';
const domain = `gui/${process.getuid()}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const command = process.argv[2] || 'status';
function ctl(...args) { return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function unload() { try { ctl('bootout', `${domain}/${label}`); } catch (error) { if (![3, 113].includes(error.status)) throw error; } }
async function load() {
  for (let attempt = 0; attempt < 20; attempt++) {
    try { ctl('bootstrap', domain, plist); return; }
    catch (error) { if (error.status !== 5 || attempt === 19) throw error; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
}
function xml(s) { return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function inContainer(...args) { return execFileSync(docker, ['exec', '--user', 'main', 'agent-workspace', ...args], { encoding: 'utf8' }); }

if (command === 'install') {
  // The root launcher loads only its protected environment file, then drops to main.
  // Provision this file from the live bridge before the first protected deployment.
  execFileSync(docker, ['exec', '--user', 'root', 'agent-workspace', '/bin/sh', '-c',
    'test -s /etc/lark-agent-bridge-cora/environment.sh || { echo "Missing protected Cora environment; preserve the live bridge environment before installing." >&2; exit 1; }']);
  unload();
  // Wait for the previous remote process to finish before changing its files.
  for (let attempt = 0; attempt < 40; attempt++) {
    const script = `const fs=require('fs');const p='${containerRoot}/runtime/bridge.pid';let alive=false;if(fs.existsSync(p)){try{const pid=Number(fs.readFileSync(p,'utf8'));alive=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes('${containerRoot}/bridge.mjs');}catch{}}console.log(alive?'running':'stopped');`;
    if (inContainer(containerNode, '-e', script).trim() === 'stopped') break;
    if (attempt === 39) throw new Error('Existing container bridge has not stopped; deployment cancelled.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const files = ['bridge.mjs', 'core.mjs', 'backends.mjs', 'images.mjs'].map(name => ({ name, text: fs.readFileSync(path.join(source, name), 'utf8') }));
  const configText = fs.readFileSync(path.join(source, 'config.claude.json'), 'utf8');
  files.push({ name: 'config.json', text: configText });
  files.push({ name: 'CLAUDE.md', directory: JSON.parse(configText).workspace, text: fs.readFileSync(path.join(source, 'workspace/CLAUDE.md'), 'utf8') });
  const script = `const fs=require('fs'),path=require('path');const root='${containerRoot}';for(const f of JSON.parse(fs.readFileSync(0,'utf8'))){const p=path.join(f.directory||root,f.name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,f.text,{mode:f.name==='config.json'?0o600:0o644});}fs.mkdirSync(path.join(root,'runtime'),{recursive:true,mode:0o700});`;
  execFileSync(docker, ['exec', '--interactive', '--user', 'main', 'agent-workspace', containerNode, '-e', script], { input: JSON.stringify(files) });
  execFileSync(docker, ['exec', '--interactive', '--user', 'root', 'agent-workspace', '/bin/sh', '-c',
    'umask 022; /usr/bin/install -d -o root -g root -m 0755 /usr/local/lib/lark-agent-bridge; /bin/cat > /usr/local/lib/lark-agent-bridge/cora-start.sh; /bin/chown root:root /usr/local/lib/lark-agent-bridge/cora-start.sh; /bin/chmod 0755 /usr/local/lib/lark-agent-bridge/cora-start.sh'],
    { input: fs.readFileSync(path.join(source, 'container-start.sh')) });
  fs.mkdirSync(path.join(hostRoot, 'runtime'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(source, 'container-runner.mjs'), path.join(hostRoot, 'container-runner.mjs'));
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/opt/homebrew/bin/node</string><string>${xml(path.join(hostRoot, 'container-runner.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(hostRoot)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>ExitTimeOut</key><integer>12</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(hostRoot, 'runtime/bridge.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(hostRoot, 'runtime/bridge.error.log'))}</string>
</dict></plist>\n`;
  fs.mkdirSync(path.dirname(plist), { recursive: true }); fs.writeFileSync(plist, body);
  await load(); console.log(`Cora installed in agent-workspace:${containerRoot}`);
} else if (command === 'status') {
  console.log(ctl('list', label));
  console.log(inContainer('cat', `${containerRoot}/runtime/status.json`));
} else if (command === 'stop') {
  unload(); console.log('Cora bridge stopped.');
} else if (command === 'start') {
  await load(); console.log('Cora bridge started.');
} else if (command === 'restart') {
  unload(); await load(); console.log('Cora bridge restarted.');
} else throw new Error('Usage: node container-service.mjs install|status|stop|start|restart');
