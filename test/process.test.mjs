// How configured programs are started and stopped on each system.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { launch, shimTarget, check, start, stop } from '../core/process.mjs';

// What `npm install -g` writes on Windows as <name>.cmd.
const npmShim = target => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n`
  + `IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n`
  + `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

test('a configured program starts directly, a script under Node.js, and a Windows launcher as what it runs', () => {
  const npm = 'C:\\Users\\a b\\AppData\\Roaming\\npm';
  const files = {
    [`${npm}\\lark-cli.cmd`]: npmShim('node_modules\\@larksuite\\cli\\scripts\\run.js'),
    [`${npm}\\tool.cmd`]: '@ECHO off\r\n"%~dp0\\node_modules\\tool\\bin\\tool.exe" %*\r\n',
    [`${npm}\\other.cmd`]: '@echo off\r\necho hello\r\n',
    'C:\\Users\\a\\.local\\bin\\claude.exe': '',
  };
  const windows = { platform: 'win32', exists: file => Object.hasOwn(files, file), read: file => files[file] };
  assert.deepEqual(launch('/usr/bin/lark-cli', { platform: 'linux' }), ['/usr/bin/lark-cli', []]);
  assert.deepEqual(launch('/opt/tool/run.mjs', { platform: 'linux' }), [process.execPath, ['/opt/tool/run.mjs']]);
  // A .cmd on Linux is just a file name.
  assert.deepEqual(launch('/opt/tool/run.cmd', { platform: 'linux' }), ['/opt/tool/run.cmd', []]);
  assert.deepEqual(launch('C:\\Users\\a\\.local\\bin\\claude.exe', windows), ['C:\\Users\\a\\.local\\bin\\claude.exe', []]);
  // What `where claude` prints without the extension.
  assert.deepEqual(launch('C:\\Users\\a\\.local\\bin\\claude', windows), ['C:\\Users\\a\\.local\\bin\\claude.exe', []]);
  assert.deepEqual(launch(`${npm}\\lark-cli.cmd`, windows), [process.execPath, [`${npm}\\node_modules\\@larksuite\\cli\\scripts\\run.js`]]);
  assert.deepEqual(launch(`${npm}\\lark-cli`, windows), [process.execPath, [`${npm}\\node_modules\\@larksuite\\cli\\scripts\\run.js`]]);
  assert.deepEqual(launch(`${npm}\\tool.cmd`, windows), [`${npm}\\node_modules\\tool\\bin\\tool.exe`, []]);
  assert.throws(() => launch(`${npm}\\other.cmd`, windows), /batch file that cannot be started directly/);
  // The launcher's own node.exe is not the target.
  assert.equal(shimTarget('IF EXIST "%dp0%\\node.exe" (\r\n', npm), null);
});

test('a script is started under Node.js and stopped together with what it started', { timeout: 20_000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'process-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const script = path.join(root, 'parent.cjs');
  // Starts a grandchild that would write a file after 3 s, then waits.
  fs.writeFileSync(script, `const {spawn}=require('child_process'),path=require('path');
spawn(process.execPath,['-e','setTimeout(()=>require("fs").writeFileSync(process.argv[1],"late"),3000)',path.join(__dirname,'late.txt')],{stdio:'ignore'});
console.log('up '+process.argv.slice(2).join('|'));setInterval(()=>{},1000);`);
  check(script);
  assert.throws(() => check(path.join(root, 'missing.cjs')), { code: 'ENOENT' });
  const child = start(script, ['a b', '"q"', '&|<>^%PATH%'], { group: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const [line] = await once(child.stdout, 'data');
  // Arguments arrive as written: nothing in between interprets them.
  assert.equal(String(line).trim(), 'up a b|"q"|&|<>^%PATH%');
  const closed = once(child, 'close');
  stop(child, { group: true });
  await closed;
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(fs.existsSync(path.join(root, 'late.txt')), false, 'the grandchild was stopped too');
  // Stopping again, or stopping nothing, is harmless.
  stop(child, { group: true }); stop(undefined);
});
