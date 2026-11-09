// Files too large for a chat reply (Feishu caps uploads at 30 MB) go to the bot's Feishu Drive
// space; the user who asked gets full access and the chat gets a link.
import fs from 'node:fs';
import path from 'node:path';
import { withStaging } from './download.mjs';

// First string found under any of the given keys, searching nested objects.
function find(value, keys) {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) if (typeof value[key] === 'string' && value[key]) return value[key];
  for (const item of Object.values(value)) { const found = find(item, keys); if (found) return found; }
  return undefined;
}

// Needs the app scopes drive:file:upload and drive:drive.metadata:readonly. Returns { url, token }.
export async function uploadToDrive(runLark, file, { timeoutMs = 600_000 } = {}) {
  const name = path.basename(file);
  const data = await withStaging('lark-drive-', async staging => {
    fs.copyFileSync(file, path.join(staging, name));
    return runLark(['drive', '+upload', '--as', 'bot', '--file', name], timeoutMs, staging);
  });
  const token = find(data, ['file_token', 'token']);
  const url = find(data, ['url']);
  if (!token || !url) throw Object.assign(new Error('Drive upload returned no link'), { channel: true });
  return { url, token };
}

// lark-cli already grants its own login user; the sender may be another authorized user.
// Needs docs:permission.member:create.
export function grantAccess(runLark, token, userId) {
  return runLark(['drive', 'permission.members', 'create', '--as', 'bot', '--yes', '--params', JSON.stringify({ token, type: 'file' }),
    '--data', JSON.stringify({ member_type: 'openid', member_id: userId, perm: 'full_access' })]);
}
