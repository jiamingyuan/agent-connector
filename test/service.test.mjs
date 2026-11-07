// Service manager logic for every platform, testable on any machine; and the doctor checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectBackend, servicePath, systemdUnit, systemdUnitPath, launchdPlist, launchdPlistPath, launchctlArgs } from '../service/units.mjs';
import { runDoctor, TESTED } from '../service/doctor.mjs';

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

test('systemd units: system service for root, user service otherwise', () => {
  const base = { root: '/srv/bridge', execPath: '/usr/bin/node', envPath: '/usr/bin:/bin', home: '/home/a' };
  assert.equal(systemdUnitPath({ scope: 'system', home: '/root' }), '/etc/systemd/system/agent-connector.service');
  assert.equal(systemdUnitPath({ scope: 'user', home: '/home/a' }), '/home/a/.config/systemd/user/agent-connector.service');
  const system = systemdUnit({ ...base, scope: 'system' }), user = systemdUnit({ ...base, scope: 'user' });
  assert(system.includes('ExecStart=/usr/bin/node /srv/bridge/bridge.mjs') && system.includes('WantedBy=multi-user.target'));
  assert(user.includes('WantedBy=default.target') && user.includes('Restart=always') && user.includes('UMask=0077'));
});

test('macOS LaunchAgent is a valid plist that restarts the bridge and escapes paths', () => {
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
  const bin = (name, text) => { const file = path.join(root, name); fs.writeFileSync(file, `#!/bin/sh\necho "${text}"\n`, { mode: 0o755 }); return file; };
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
  assert.match(result.text, /✓ lark-cli 1\.0\.98/);
  assert.match(result.text, /⚠ claude-code 9\.9\.9; this code was last verified with 2\.1\.319/);
  assert.match(result.text, /✓ Claude Code sessions readable: 1 of 1/);
  // A format change: records exist but none parse into a conversation.
  fs.writeFileSync(path.join(project, 'aaaaaaaa-0000-4000-8000-000000000001.jsonl'), JSON.stringify({ kind: 'turn', v: 2 }));
  result = await run();
  assert.equal(result.code, 1);
  assert.match(result.text, /✗ Claude Code session records found \(1\) but none could be read/);
});
