// Service manager for the bridge on Linux and macOS. Runs the bridge in place from this directory.
//   Linux with systemd: system service (root) or user service (other users)
//   macOS:              LaunchAgent in ~/Library/LaunchAgents (starts at login)
//   anything else, or --supervisor: a detached Node supervisor that restarts the bridge on exit
// Usage: node service.mjs install|start|stop|restart|status|logs|uninstall|doctor [--supervisor]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { agentId, loadAgent, loadChannel } from './core/registry.mjs';
import { botConfigs } from './core/bots.mjs';
import { detectBackend, servicePath, systemdUnit, systemdUnitPath, launchdPlist, launchdPlistPath, launchctlArgs, UNIT,
  RESTART_DELAY_MS } from './service/units.mjs';
import { runDoctor } from './service/doctor.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, 'runtime');
const supervisorPid = path.join(runtime, 'supervisor.pid');
const logFile = path.join(runtime, 'bridge.log');
const args = process.argv.slice(2);
const command = args.find(arg => !arg.startsWith('--')) || 'status';
const home = os.homedir();
const uid = process.getuid?.() ?? -1;
const envPath = servicePath({ platform: process.platform, execPath: process.execPath, envPath: process.env.PATH });

function pid1() {
  try { return fs.readFileSync('/proc/1/comm', 'utf8').trim(); } catch { return ''; }
}
const backend = detectBackend({ platform: process.platform, pid1: pid1(), uid, forceSupervisor: args.includes('--supervisor') });

const run = (bin, list) => execFileSync(bin, list, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const systemctl = (...list) => run('systemctl', backend.scope === 'user' ? ['--user', ...list] : list);
const launchctl = action => run('launchctl', launchctlArgs(action, { uid, plistPath: launchdPlistPath(home) }));
function readPid(file) {
  try { return Number(fs.readFileSync(file, 'utf8')) || 0; } catch { return 0; }
}
// The command line of a live process, or '' if it is gone. /proc on Linux, ps elsewhere.
function commandLine(pid) {
  if (!pid) return '';
  try { process.kill(pid, 0); } catch (error) { if (error.code !== 'EPERM') return ''; }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); } catch { /* not Linux */ }
  try { return run('ps', ['-p', String(pid), '-o', 'command=']).trim(); } catch { return ''; }
}
const alive = (pid, needle) => commandLine(pid).includes(needle);
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
  if (!['linux', 'darwin'].includes(process.platform)) {
    throw new Error(`Unsupported platform ${process.platform}; run the bridge on Linux or macOS (on Windows, inside WSL).`);
  }
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  const configFile = path.join(root, 'config.json');
  if (!fs.existsSync(configFile)) throw new Error('Missing config.json; copy config.claude.example.json or config.example.json first.');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const bins = new Set((await loadAgent(config)).requiredBins(config));
  for (const bot of botConfigs(config)) for (const bin of (await loadChannel(bot.config)).requiredBins(bot.config)) bins.add(bin);
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

// ---- systemd ----
function installSystemd() {
  const file = systemdUnitPath({ scope: backend.scope, home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, systemdUnit({ scope: backend.scope, root, execPath: process.execPath, envPath, home }), { mode: 0o644 });
  systemctl('daemon-reload');
  systemctl('enable', '--now', UNIT);
  console.log(`Installed and started ${file}.`);
  if (backend.scope === 'user') console.log(`To keep it running after logout and start it at boot: loginctl enable-linger ${os.userInfo().username}`);
}

// ---- launchd (macOS) ----
function installLaunchd() {
  const file = launchdPlistPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, launchdPlist({ root, execPath: process.execPath, envPath, home, logFile }), { mode: 0o644 });
  try { launchctl('unload'); } catch { /* not loaded yet */ }
  launchctl('load');
  console.log(`Installed and started ${file} (starts at login). Log: ${logFile}`);
}
const launchdLoaded = () => { try { launchctl('status'); return true; } catch { return false; } };

// ---- built-in supervisor ----
async function startSupervisor() {
  if (supervisorAlive()) { console.log('Already running.'); return; }
  if (bridgeAlive()) throw new Error('A bridge is already running outside the service (see runtime/bridge.pid); stop it first.');
  const out = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'service.mjs'), '__supervise'], {
    cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, PATH: envPath },
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
  const start = () => {
    child = spawn(process.execPath, [path.join(root, 'bridge.mjs')], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code, signal) => {
      child = undefined;
      if (stopping) return finish();
      note('supervisor_restart_scheduled', { code, signal, delayMs: RESTART_DELAY_MS });
      timer = setTimeout(start, RESTART_DELAY_MS);
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
  start();
}

// Last lines of the log, then follow it (portable replacement for tail -f).
function followLog(file, lines = 100) {
  if (!fs.existsSync(file)) { console.log(`No log yet at ${file}`); return; }
  const text = fs.readFileSync(file, 'utf8');
  process.stdout.write(text.split('\n').slice(-lines - 1).join('\n'));
  let offset = Buffer.byteLength(text);
  fs.watchFile(file, { interval: 500 }, ({ size }) => {
    if (size < offset) offset = 0; // rotated or truncated
    if (size === offset) return;
    const stream = fs.createReadStream(file, { start: offset, end: size - 1 });
    offset = size;
    stream.pipe(process.stdout, { end: false });
  });
}

// ---- commands ----
const label = { systemd: `systemd (${backend.scope})`, launchd: 'launchd', supervisor: 'supervisor' }[backend.kind];
if (command === '__supervise') {
  supervise();
} else if (command === 'doctor') {
  process.exitCode = await runDoctor({ root, backend: label });
} else if (command === 'install') {
  await preflight();
  if (backend.kind === 'systemd') installSystemd();
  else if (backend.kind === 'launchd') installLaunchd();
  else {
    console.log('Using the built-in supervisor (no start on boot): no systemd or launchd here, or --supervisor was given.');
    await startSupervisor();
  }
} else if (command === 'start') {
  await preflight();
  if (backend.kind === 'systemd') { systemctl('start', UNIT); console.log('Started.'); }
  else if (backend.kind === 'launchd') { if (!launchdLoaded()) launchctl('load'); console.log('Started.'); }
  else await startSupervisor();
} else if (command === 'stop') {
  if (backend.kind === 'systemd') { systemctl('stop', UNIT); console.log('Stopped.'); }
  else if (backend.kind === 'launchd') { if (launchdLoaded()) launchctl('unload'); console.log('Stopped.'); }
  else await stopSupervisor();
} else if (command === 'restart') {
  await preflight();
  if (backend.kind === 'systemd') { systemctl('restart', UNIT); console.log('Restarted.'); }
  else if (backend.kind === 'launchd') { if (launchdLoaded()) launchctl('restart'); else launchctl('load'); console.log('Restarted.'); }
  else { await stopSupervisor(); await startSupervisor(); }
} else if (command === 'status') {
  console.log(`Mode: ${label}`);
  if (backend.kind === 'systemd') {
    try { console.log(systemctl('status', '--no-pager', UNIT)); } catch (error) { console.log(error.stdout || error.message); }
  } else if (backend.kind === 'launchd') {
    console.log(`LaunchAgent: ${launchdLoaded() ? 'loaded' : 'not loaded'}\nBridge: ${bridgeAlive() ? 'running' : 'stopped'}`);
  } else {
    console.log(`Supervisor: ${supervisorAlive() ? `running (PID ${readPid(supervisorPid)})` : 'stopped'}\nBridge: ${bridgeAlive() ? 'running' : 'stopped'}`);
  }
  const statusFile = path.join(runtime, 'status.json');
  if (fs.existsSync(statusFile)) console.log(fs.readFileSync(statusFile, 'utf8'));
} else if (command === 'logs') {
  if (backend.kind === 'systemd') spawn('journalctl', [...(backend.scope === 'user' ? ['--user'] : []), '-u', UNIT, '-n', '100', '-f'], { stdio: 'inherit' });
  else followLog(logFile);
} else if (command === 'uninstall') {
  if (backend.kind === 'systemd') {
    try { systemctl('disable', '--now', UNIT); } catch { /* not installed */ }
    fs.rmSync(systemdUnitPath({ scope: backend.scope, home }), { force: true });
    systemctl('daemon-reload');
  } else if (backend.kind === 'launchd') {
    if (launchdLoaded()) launchctl('unload');
    fs.rmSync(launchdPlistPath(home), { force: true });
  } else await stopSupervisor();
  console.log('Uninstalled. config.json, runtime/ and the workspace are kept.');
} else {
  console.error('Usage: node service.mjs install|start|stop|restart|status|logs|uninstall|doctor [--supervisor]');
  process.exitCode = 1;
}
