// Starting and stopping the external programs (agent CLIs, lark-cli) the same way on Linux, macOS
// and Windows. Nothing here goes through a shell: message text is passed as arguments, and a shell
// (cmd.exe above all) would interpret parts of it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCRIPT = new Set(['.js', '.mjs', '.cjs']);

// What an npm launcher on Windows (name.cmd) starts: the script or program named after %dp0%.
export function shimTarget(text, folder, paths = path.win32) {
  const targets = [...text.matchAll(/"%~?dp0%?\\([^"\r\n]+?\.(?:[cm]?js|exe))"/gi)].map(match => match[1])
    .filter(target => paths.basename(target).toLowerCase() !== 'node.exe');
  return targets.length ? paths.join(folder, targets.at(-1)) : null;
}

// How to start a configured program: [command, leading arguments].
// A .js / .mjs / .cjs file runs under this Node.js on every system. On Windows a name without an
// extension stands for name.exe or name.cmd, and name.cmd (what npm installs) is replaced by the
// script or program it starts, because Node.js can only run a .cmd file through cmd.exe.
export function launch(bin, { platform = process.platform, exists = fs.existsSync, read = file => fs.readFileSync(file, 'utf8') } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let file = bin;
  if (platform === 'win32' && !paths.extname(file)) file = ['.exe', '.cmd'].map(ext => file + ext).find(exists) || file;
  const ext = paths.extname(file).toLowerCase();
  if (SCRIPT.has(ext)) return [process.execPath, [file]];
  if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    const target = shimTarget(read(file), paths.dirname(file), paths);
    if (!target) throw new Error(`${file} is a batch file that cannot be started directly; set the path of the program (.exe) or script (.js) it runs instead`);
    return launch(target, { platform, exists, read });
  }
  return [file, []];
}

// Throws when a configured program is missing or cannot be started.
export function check(bin) {
  const [command, leading] = launch(bin);
  if (leading.length) fs.accessSync(leading[0], fs.constants.R_OK); else fs.accessSync(command, fs.constants.X_OK);
}

// spawn() for a configured program. Windows gets no console window and no process group (it has
// none); elsewhere `group` makes the child a group leader so stop() reaches what it started.
export function start(bin, args, { group = false, ...options } = {}) {
  const [command, leading] = launch(bin);
  return spawn(command, [...leading, ...args], { ...options, windowsHide: true, detached: group && process.platform !== 'win32' });
}

// Ends a child and, on Windows or with `group`, everything it started. Windows has no SIGTERM:
// kill() there ends only the process itself, so taskkill ends the tree.
export function stop(child, { group = false } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    } catch { child.kill(); }
    return;
  }
  if (group) { try { process.kill(-child.pid, 'SIGTERM'); return; } catch { /* not a group leader */ } }
  child.kill('SIGTERM');
}
