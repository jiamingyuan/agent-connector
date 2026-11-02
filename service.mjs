import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const install = path.join(os.homedir(), '.local/share/lark-agent-bridge');
const label = 'com.jiamingyuan.lark-agent-bridge';
const domain = `gui/${process.getuid()}`;
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
const command = process.argv[2] || 'status';
function ctl(...args) { return execFileSync('/bin/launchctl', args, { encoding: 'utf8' }); }
function unload() { try { ctl('bootout', `${domain}/${label}`); } catch (e) { if (e.status !== 3 && e.status !== 113) throw e; } }
async function load() {
  // bootout can return before launchd has removed the previous job.
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      execFileSync('/bin/launchctl', ['bootstrap', domain, plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return;
    } catch (error) {
      if (error.status !== 5 || attempt === 15) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}
function xml(s) { return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

if (command === 'install') {
  unload();
  fs.mkdirSync(path.join(install, 'runtime'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(install, 'workspace'), { recursive: true });
  for (const file of ['bridge.mjs', 'core.mjs', 'backends.mjs', 'images.mjs']) fs.copyFileSync(path.join(source, file), path.join(install, file));
  fs.copyFileSync(path.join(source, 'workspace/AGENTS.md'), path.join(install, 'workspace/AGENTS.md'));
  const config = JSON.parse(fs.readFileSync(path.join(source, 'config.json'), 'utf8'));
  config.workspace = path.join(install, 'workspace');
  fs.writeFileSync(path.join(install, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  const envPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:' + path.join(os.homedir(), '.local/bin');
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath)}</string><string>${xml(path.join(install, 'bridge.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(install)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(envPath)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(install, 'runtime/bridge.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(install, 'runtime/bridge.error.log'))}</string>
</dict></plist>\n`;
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, body);
  await load();
  console.log(`Installed: ${install}`);
} else if (command === 'status') {
  const file = path.join(install, 'runtime/status.json');
  if (fs.existsSync(file)) console.log(fs.readFileSync(file, 'utf8'));
  console.log(ctl('list', label));
} else if (command === 'stop') {
  unload(); console.log('Stopped.');
} else if (command === 'start') {
  await load(); console.log('Started.');
} else if (command === 'restart') {
  unload(); await load(); console.log('Restarted.');
} else {
  throw new Error('Usage: node service.mjs install|status|stop|start|restart');
}
