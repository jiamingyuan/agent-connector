// Shared by image and file downloads. lark-cli 1.0.98+ refuses to write anywhere under /root
// ("protected by the built-in denylist"), so resources are downloaded into a private staging dir
// under the system temp dir, checked there, and copied into the workspace for the agent to read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replyKey } from '../core/text.mjs';

export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) {
    throw new Error('附件保存目录异常，请检查桥接服务的 attachments 目录。');
  }
  fs.chmodSync(directory, 0o700);
}

// workspace/attachments/<key of this message and kind>/, private. Real paths throughout: on macOS
// the workspace or the temp dir can sit behind a symlink (/var -> /private/var).
export function messageDirectory(config, messageId, kind) {
  fs.mkdirSync(config.workspace, { recursive: true });
  const base = path.join(fs.realpathSync(config.workspace), 'attachments');
  privateDirectory(base);
  const directory = path.join(base, replyKey(messageId, kind));
  privateDirectory(directory);
  return directory;
}

// For comparing paths. Windows ignores case and may report a folder under its short (8.3) or long name.
const canonical = file => (process.platform === 'win32' ? fs.realpathSync.native(file).toLowerCase() : fs.realpathSync(file));

export async function withStaging(prefix, run) {
  const staging = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  try { return await run(staging); } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

// Downloads one resource of the message into the staging dir and returns the file's real path.
export async function download(runLark, staging, { messageId, key, type, output, timeoutMs, failure }) {
  let downloaded;
  try {
    downloaded = await runLark(['im', '+messages-resources-download', '--as', 'bot',
      '--message-id', messageId, '--file-key', key, '--type', type, '--output', output], timeoutMs, staging);
  } catch {
    throw new Error(failure);
  }
  const staged = path.resolve(staging, downloaded?.saved_path || '');
  let real, inside = false;
  try { real = fs.realpathSync(staged); inside = canonical(staged).startsWith(canonical(staging) + path.sep); } catch { real = null; }
  // The file itself must not be a symlink, and must resolve inside the private staging dir.
  if (!real || !inside || !fs.lstatSync(staged).isFile()) {
    throw new Error('附件下载结果异常，本轮未交给 Agent。');
  }
  return real;
}
