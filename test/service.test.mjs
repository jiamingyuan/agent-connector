// Service manager logic for every platform, testable on any machine; and the doctor checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectBackend, servicePath, systemdUnit, systemdUnitPath, launchdPlist, launchdPlistPath, launchctlArgs, RUN_KEY, runKeyArgs,
  commandLineArgs } from '../service/units.mjs';
import { runDoctor, TESTED } from '../service/doctor.mjs';
import { copySources } from './harness.mjs';

const windows = process.platform === 'win32';
// The unit and plist tests compare POSIX paths, which only exist where those services do.
const posixOnly = { skip: windows && 'systemd and launchd files are not written on Windows' };
// A fake CLI: a Node.js script with a shebang, or on Windows a .cjs file the bridge runs under Node.js.
function fakeBin(root, name, source) {
  const file = path.join(root, windows ? `${name}.cjs` : name);
  fs.writeFileSync(file, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return file;
}

test('the service manager is chosen per platform, with the supervisor as fallback', () => {
  assert.deepEqual(detectBackend({ platform: 'linux', pid1: 'systemd', uid: 0 }), { kind: 'systemd', scope: 'system' });
  assert.deepEqual(detectBackend({ platform: 'linux', pid1: 'systemd', uid: 1000 }), { kind: 'systemd', scope: 'user' });
  assert.deepEqual(detectBackend({ platform: 'linux', pid1: 'zsh', uid: 0 }), { kind: 'supervisor' });
  assert.deepEqual(detectBackend({ platform: 'darwin', pid1: '', uid: 501 }), { kind: 'launchd' });
  assert.deepEqual(detectBackend({ platform: 'freebsd', pid1: '', uid: 0 }), { kind: 'supervisor' });
  assert.deepEqual(detectBackend({ platform: 'darwin', uid: 501, forceSupervisor: true }), { kind: 'supervisor' });
  assert.equal(servicePath({ platform: 'darwin', execPath: '/opt/homebrew/bin/node' }).split(':')[0], '/opt/homebrew/bin');
  assert(servicePath({ platform: 'darwin', execPath: '/Users/a/.nvm/bin/node' }).includes('/opt/homebrew/bin'));
  assert(!servicePath({ platform: 'linux', execPath: '/usr/bin/node' }).includes('homebrew'));
});

test('Windows: the supervisor, started at login from the Run key', () => {
  assert.deepEqual(detectBackend({ platform: 'win32', pid1: '', uid: -1 }), { kind: 'supervisor' });
  const paths = { execPath: 'C:\\Program Files\\nodejs\\node.exe', script: 'D:\\agent connector\\service.mjs' };
  assert.deepEqual(runKeyArgs('add', paths), ['add', RUN_KEY, '/v', 'agent-connector', '/t', 'REG_SZ',
    '/d', '"C:\\Program Files\\nodejs\\node.exe" "D:\\agent connector\\service.mjs" start', '/f']);
  assert.deepEqual(runKeyArgs('remove'), ['delete', RUN_KEY, '/v', 'agent-connector', '/f']);
  assert.deepEqual(runKeyArgs('query'), ['query', RUN_KEY, '/v', 'agent-connector']);
  assert(RUN_KEY.startsWith('HKCU\\'), 'the current user\'s key: no administrator rights');
  // Only a number reaches the PowerShell command.
  assert.match(commandLineArgs(4321).at(-1), /Filter 'ProcessId = 4321'\)\.CommandLine$/);
  assert.match(commandLineArgs('1; Remove-Item x').at(-1), /ProcessId = NaN'/);
  // Windows keeps the user's own PATH, with Node.js first.
  assert.equal(servicePath({ platform: 'win32', execPath: 'C:\\node\\node.exe', envPath: 'C:\\Windows;C:\\tools' }).split(';').length, 3);
});

test('systemd units: system service for root, user service otherwise', posixOnly, () => {
  const base = { root: '/srv/bridge', execPath: '/usr/bin/node', envPath: '/usr/bin:/bin', home: '/home/a' };
  assert.equal(systemdUnitPath({ scope: 'system', home: '/root' }), '/etc/systemd/system/agent-connector.service');
  assert.equal(systemdUnitPath({ scope: 'user', home: '/home/a' }), '/home/a/.config/systemd/user/agent-connector.service');
  const system = systemdUnit({ ...base, scope: 'system' }), user = systemdUnit({ ...base, scope: 'user' });
  assert(system.includes('ExecStart=/usr/bin/node /srv/bridge/bridge.mjs') && system.includes('WantedBy=multi-user.target'));
  assert(user.includes('WantedBy=default.target') && user.includes('Restart=always') && user.includes('UMask=0077'));
});

test('macOS LaunchAgent is a valid plist that restarts the bridge and escapes paths', posixOnly, () => {
  const home = '/Users/a & b';
  const plist = launchdPlist({ root: '/Users/a & b/agent-connector', execPath: '/opt/homebrew/bin/node', envPath: '/opt/homebrew/bin:/usr/bin', home, logFile: '/Users/a & b/agent-connector/runtime/bridge.log' });
  assert.equal(launchdPlistPath('/Users/a'), '/Users/a/Library/LaunchAgents/com.agent-connector.plist');
  assert(plist.includes('/Users/a &amp; b/agent-connector/bridge.mjs') && !plist.includes('a & b'));
  let parsed;
  try {
    parsed = JSON.parse(execFileSync('python3', ['-c', 'import plistlib,sys,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'], { input: plist, encoding: 'utf8' }));
  } catch (error) { if (error.code === 'ENOENT') return; throw error; } // no python3: skip the parser check
  assert.equal(parsed.Label, 'com.agent-connector');
  assert.deepEqual(parsed.ProgramArguments, ['/opt/homebrew/bin/node', '/Users/a & b/agent-connector/bridge.mjs']);
  assert.equal(parsed.KeepAlive, true);
  assert.equal(parsed.RunAtLoad, true);
  assert.equal(parsed.Umask, 0o077);
  assert.equal(parsed.EnvironmentVariables.HOME, home);
  assert.deepEqual(launchctlArgs('load', { uid: 501, plistPath: '/p.plist' }), ['bootstrap', 'gui/501', '/p.plist']);
  assert.deepEqual(launchctlArgs('restart', { uid: 501 }), ['kickstart', '-k', 'gui/501/com.agent-connector']);
  assert.deepEqual(launchctlArgs('unload', { uid: 501 }), ['bootout', 'gui/501/com.agent-connector']);
});

test('doctor reports tool versions and catches unreadable Claude Code session records', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lark-doctor-')));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const bin = (name, text) => fakeBin(root, name, `console.log(${JSON.stringify(text)});`);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ agent: 'claude-code', channel: 'lark', workspace: path.join(root, 'ws'),
    larkBin: bin('lark-cli', `lark-cli version ${TESTED['lark-cli']}`), claudeBin: bin('claude', '9.9.9 (Claude Code)') }));
  const home = path.join(root, 'claude-home'), project = path.join(home, 'projects', '-p');
  fs.mkdirSync(project, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = home;
  const good = [{ type: 'user', cwd: '/p', entrypoint: 'cli', message: { role: 'user', content: 'hi' } }, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }];
  fs.writeFileSync(path.join(project, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), good.map(e => JSON.stringify(e)).join('\n'));
  const run = async () => { const lines = []; const code = await runDoctor({ root, backend: 'supervisor', print: line => lines.push(line) }); return { code, text: lines.join('\n') }; };
  let result = await run();
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /✓ lark-cli 1\.0\.99/);
  assert.match(result.text, /⚠ claude-code 9\.9\.9; this code was last verified with 2\.1\.322/);
  assert.match(result.text, /✓ Claude Code sessions readable: 1 of 1/);
  // A format change: records exist but none parse into a conversation.
  fs.writeFileSync(path.join(project, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), JSON.stringify({ kind: 'turn', v: 2 }));
  result = await run();
  assert.equal(result.code, 1);
  assert.match(result.text, /✗ Claude Code session records found \(1\) but none could be read/);
});

test('the built-in supervisor starts the bridge, and stops it on request without a signal', { timeout: 60_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'service-test-')));
  const service = (...args) => execFileSync(process.execPath, [path.join(root, 'service.mjs'), ...args, '--supervisor'], { cwd: root, encoding: 'utf8' });
  t.after(() => {
    try { service('stop'); } catch { /* already stopped */ }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await copySources(root);
  fs.cpSync(new URL('../service.mjs', import.meta.url), path.join(root, 'service.mjs'));
  fs.cpSync(new URL('../service', import.meta.url), path.join(root, 'service'), { recursive: true });
  // lark-cli as the bridge needs it here: reports ready, then waits until its input closes.
  const larkBin = fakeBin(root, 'lark', `if(process.argv.includes('consume')){process.stderr.write('[event] ready event_key=im.message.receive_v1\\n');
process.stdin.resume();process.stdin.on('end',()=>process.exit(0));}else console.log('{"ok":true,"data":{}}');`);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ agent: 'example', profile: 'fake', ownerOpenId: 'ou_owner', botName: 'T',
    larkBin, workspace: path.join(root, 'ws'), maxEventAgeMs: 300_000, turnTimeoutMs: 10_000 }));
  const pidFile = name => path.join(root, 'runtime', name);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const gone = async (...names) => {
    for (let waited = 0; waited < 20_000 && names.some(name => fs.existsSync(pidFile(name))); waited += 100) await wait(100);
    return !names.some(name => fs.existsSync(pidFile(name)));
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

  assert.match(service('start'), /Started \(supervisor PID \d+\)/);
  assert.match(service('status'), /Supervisor: running \(PID \d+\)\nBridge: running/);
  assert.match(service('start'), /Already running/);
  const supervisor = Number(fs.readFileSync(pidFile('supervisor.pid'), 'utf8')), bridge = Number(fs.readFileSync(pidFile('bridge.pid'), 'utf8'));
  // The request file alone stops both: this is the only way on Windows, which has no SIGTERM.
  fs.writeFileSync(pidFile('supervisor.stop'), String(supervisor));
  assert(await gone('supervisor.pid', 'bridge.pid', 'supervisor.stop'), 'supervisor and bridge stopped and cleaned up');
  for (let waited = 0; waited < 5000 && (alive(supervisor) || alive(bridge)); waited += 100) await wait(100);
  assert(!alive(supervisor) && !alive(bridge));
  // The bridge was asked to shut down, so it stopped its own listener and removed its lock.
  assert.match(fs.readFileSync(pidFile('bridge.log'), 'utf8'), /"type":"stopped","signal":"supervisor"/);

  // A lock left by a bridge that was ended without warning does not block the next start.
  fs.writeFileSync(pidFile('bridge.pid'), String(process.pid));
  assert.match(service('start'), /Started/);
  assert.notEqual(Number(fs.readFileSync(pidFile('bridge.pid'), 'utf8')), process.pid);
  assert.match(service('stop'), /Stopped\./);
  assert(await gone('supervisor.pid', 'bridge.pid'));
  assert.match(service('stop'), /Not running\./);
});
