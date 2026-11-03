// Debian service manager for the bridge. Runs the bridge in place from this directory.
//   systemd present (PID 1 is systemd): installs /etc/systemd/system/lark-agent-bridge.service
//   no systemd (e.g. a container):      runs a detached supervisor that restarts the bridge on exit
// Usage: node service.mjs install|start|stop|restart|status|logs|uninstall
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentId, loadAgent, loadChannel } from './core/registry.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, 'runtime');
const unitName = 'lark-agent-bridge.service';
const unitFile = `/etc/systemd/system/${unitName}`;
const supervisorPid = path.join(runtime, 'supervisor.pid');
const logFile = path.join(runtime, 'bridge.log');
const restartDelayMs = 15_000;
const command = process.argv[2] || 'status';

function hasSystemd() {
  try { return fs.readFileSync('/proc/1/comm', 'utf8').trim() === 'systemd'; } catch { return false; }
}
function systemctl(...args) { return execFileSync('systemctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function readPid(file) {
  try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return 0; }
}
function alive(pid, needle) {
  if (!pid) return false;
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(needle); } catch { return false; }
}
function supervisorAlive() { return alive(readPid(supervisorPid), path.join(root, 'service.mjs')); }
function bridgeAlive() { return alive(readPid(path.join(runtime, 'bridge.pid')), 'bridge.mjs'); }
async function waitFor(check, timeoutMs) {
  for (let waited = 0; waited < timeoutMs; waited += 250) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return check();
}

async function preflight() {
  if (process.platform !== 'linux' || !fs.readFileSync('/etc/os-release', 'utf8').includes('ID=debian')) {
    throw new Error('This service script supports Debian only.');
  }
  const configFile = path.join(root, 'config.json');
  if (!fs.existsSync(configFile)) throw new Error('Missing config.json; copy config.claude.example.json or config.example.json first.');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const bins = [...(await loadChannel(config)).requiredBins(config), ...(await loadAgent(config)).requiredBins(config)];
  for (const bin of bins) fs.accessSync(bin, fs.constants.X_OK);
  if (!path.isAbsolute(config.workspace)) throw new Error('config.workspace must be an absolute path.');
  fs.mkdirSync(config.workspace, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  // Claude Code reads CLAUDE.md (not AGENTS.md); seed it once, never overwrite local edits.
  const claudeMd = path.join(config.workspace, 'CLAUDE.md');
  if (agentId(config) === 'claude-code' && !fs.existsSync(claudeMd)) {
    fs.copyFileSync(path.join(root, 'workspace/CLAUDE.example.md'), claudeMd);
    console.log(`Created ${claudeMd} from CLAUDE.example.md`);
  }
}
function servicePath() {
  return [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/sbin']
    .filter((dir, index, all) => all.indexOf(dir) === index).join(':');
}

// ---- systemd backend ----
function writeUnit() {
  const unit = `[Unit]
Description=Lark agent bridge
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${process.execPath} ${path.join(root, 'bridge.mjs')}
Environment=PATH=${servicePath()}
Environment=HOME=${process.env.HOME}
Restart=always
RestartSec=${restartDelayMs / 1000}
KillSignal=SIGTERM
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=multi-user.target
`;
  fs.writeFileSync(unitFile, unit, { mode: 0o644 });
  systemctl('daemon-reload');
}

// ---- supervisor backend (no systemd) ----
async function startSupervisor() {
  if (supervisorAlive()) { console.log('Already running.'); return; }
  if (bridgeAlive()) throw new Error('A bridge is already running outside the service (see runtime/bridge.pid); stop it first.');
  const out = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'service.mjs'), '__supervise'], {
    cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PATH: servicePath() },
  });
  child.unref();
  if (!await waitFor(bridgeAlive, 10_000)) throw new Error(`Bridge did not start; check ${logFile}`);
  console.log(`Started (supervisor PID ${child.pid}). Log: ${logFile}`);
}
async function stopSupervisor() {
  const pid = readPid(supervisorPid);
  if (!supervisorAlive()) { console.log('Not running.'); return; }
  process.kill(pid, 'SIGTERM');
  if (!await waitFor(() => !supervisorAlive() && !bridgeAlive(), 20_000)) throw new Error('Supervisor did not stop within 20 s.');
  console.log('Stopped.');
}
function supervise() {
  fs.writeFileSync(supervisorPid, String(process.pid), { mode: 0o600 });
  let child, stopping = false, timer;
  const note = (type, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), type, ...fields }));
  const run = () => {
    child = spawn(process.execPath, [path.join(root, 'bridge.mjs')], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code, signal) => {
      child = undefined;
      if (stopping) return finish();
      note('supervisor_restart_scheduled', { code, signal, delayMs: restartDelayMs });
      timer = setTimeout(run, restartDelayMs);
    });
  };
  const finish = () => {
    if (readPid(supervisorPid) === process.pid) fs.unlinkSync(supervisorPid);
    process.exit(0);
  };
  const stop = () => {
    if (stopping) return;
    stopping = true; clearTimeout(timer);
    if (!child) return finish();
    child.kill('SIGTERM');
    setTimeout(() => { child?.kill('SIGKILL'); finish(); }, 15_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', () => {}); // survive the launching terminal closing
  note('supervisor_started');
  run();
}

// ---- commands ----
const systemd = hasSystemd();
if (command === '__supervise') {
  supervise();
} else if (command === 'install') {
  await preflight();
  if (systemd) {
    writeUnit();
    systemctl('enable', '--now', unitName);
    console.log(`Installed and started ${unitName} (systemd). Logs: journalctl -u ${unitName} -f`);
  } else {
    console.log('systemd is not PID 1 here; using the built-in supervisor (no start on boot).');
    await startSupervisor();
  }
} else if (command === 'start') {
  if (systemd) { systemctl('start', unitName); console.log('Started.'); }
  else { await preflight(); await startSupervisor(); }
} else if (command === 'stop') {
  if (systemd) { systemctl('stop', unitName); console.log('Stopped.'); }
  else await stopSupervisor();
} else if (command === 'restart') {
  if (systemd) { systemctl('restart', unitName); console.log('Restarted.'); }
  else { await stopSupervisor(); await preflight(); await startSupervisor(); }
} else if (command === 'status') {
  if (systemd) {
    try { console.log(systemctl('status', '--no-pager', unitName)); } catch (error) { console.log(error.stdout || error.message); }
  } else {
    console.log(`Mode: supervisor\nSupervisor: ${supervisorAlive() ? `running (PID ${readPid(supervisorPid)})` : 'stopped'}\nBridge: ${bridgeAlive() ? 'running' : 'stopped'}`);
  }
  const statusFile = path.join(runtime, 'status.json');
  if (fs.existsSync(statusFile)) console.log(fs.readFileSync(statusFile, 'utf8'));
} else if (command === 'logs') {
  if (systemd) spawn('journalctl', ['-u', unitName, '-n', '100', '-f'], { stdio: 'inherit' });
  else spawn('tail', ['-n', '100', '-f', logFile], { stdio: 'inherit' });
} else if (command === 'uninstall') {
  if (systemd) {
    try { systemctl('disable', '--now', unitName); } catch { /* not installed */ }
    fs.rmSync(unitFile, { force: true });
    systemctl('daemon-reload');
  } else await stopSupervisor();
  console.log('Uninstalled. config.json, runtime/ and the workspace are kept.');
} else {
  console.error('Usage: node service.mjs install|start|stop|restart|status|logs|uninstall');
  process.exitCode = 1;
}
