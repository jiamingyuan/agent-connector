// File messages: find the attachment, download it through a private staging dir and keep it in the
// workspace under its original (sanitized) name, for the agent to read with its own tools.
import fs from 'node:fs';
import path from 'node:path';
import { messageDirectory, withStaging, download } from './download.mjs';

// Default cap for received files; an 88 MB file downloaded fine from Feishu (2026-11-07). config.maxFileBytes overrides it.
export const fileLimits = { bytes: 100 * 1024 * 1024 };
export const maxFileBytes = config => (Number.isFinite(config.maxFileBytes) && config.maxFileBytes > 0 ? config.maxFileBytes : fileLimits.bytes);

const unescapeXml = text => text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// lark-cli renders a file message as <file key="file_xxx" name="report.pdf"/> and a folder as
// <folder key="file_xxx" name="assets"/>; the raw API content is {"file_key": "...", "file_name": "..."}.
export function fileRefs(content) {
  const refs = [];
  let folder = false;
  const add = (key, name) => {
    if (/^file_[A-Za-z0-9_-]+$/.test(key || '') && !refs.some(ref => ref.key === key)) refs.push({ key, name: typeof name === 'string' ? name : '' });
  };
  if (content && typeof content === 'object') add(content.file_key, content.file_name);
  else if (typeof content === 'string') {
    try { const parsed = JSON.parse(content); if (parsed && typeof parsed === 'object') add(parsed.file_key, parsed.file_name); } catch { /* rendered markup */ }
    for (const match of content.matchAll(/<file\s+key="([^"]+)"(?:\s+name="([^"]*)")?[^>]*>/g)) add(match[1], unescapeXml(match[2] || ''));
    folder = /<folder[\s>/]/.test(content);
  }
  return { refs, folder };
}

// A single path component: no directories, control or reserved characters, leading dots or
// overlong names (the extension is kept when shortening). Also valid on Windows: no trailing dots
// or spaces, and no device names such as CON or COM1.
export function safeFileName(name, fallback) {
  let clean = path.basename(String(name || '').replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(clean)) clean = `_${clean}`;
  if ([...clean].length > 120) {
    const ext = path.extname(clean).slice(0, 16);
    clean = [...clean.slice(0, clean.length - ext.length)].slice(0, 120 - ext.length).join('') + ext;
  }
  return clean || fallback;
}

// file / folder messages, and rich-text (post) messages that carry files in their attachment zone.
export async function prepareFiles(event, config, runLark) {
  if (!['file', 'folder', 'post'].includes(event.message_type)) return [];
  let { refs, folder } = fileRefs(event.content);
  if (event.message_type === 'post' && !refs.length && !folder) return [];
  if (!refs.length && !folder && event.message_type === 'file') {
    // Some CLI versions omit resource keys from the compact event. Fetch the same message.
    const data = await runLark(['im', '+messages-mget', '--as', 'bot', '--message-ids', event.message_id, '--no-reactions']);
    ({ refs, folder } = fileRefs(data.messages?.find(item => item.message_id === event.message_id)?.content));
  }
  if (folder || event.message_type === 'folder') throw new Error('暂不支持文件夹，请压缩成 zip 后再发。');
  if (!refs.length) throw new Error('没有取到这个文件，请重新发送。');
  const directory = messageDirectory(config, event.message_id, 'files');
  return withStaging('lark-files-', async staging => {
    const files = [];
    for (const [index, ref] of refs.entries()) {
      const real = await download(runLark, staging, { messageId: event.message_id, key: ref.key, type: 'file', output: `file-${index + 1}`,
        timeoutMs: 300_000, failure: '飞书文件下载失败，请重发；若仍失败，请检查机器人的消息资源读取权限和网络。' });
      const size = fs.statSync(real).size;
      const limit = maxFileBytes(config);
      if (size > limit) throw new Error(`文件过大：单个文件最多 ${Math.round(limit / 1024 / 1024)} MiB，请压缩或拆分后发送。`);
      const name = safeFileName(ref.name || path.basename(real), `file-${index + 1}`);
      const file = path.join(directory, name);
      fs.copyFileSync(real, file);
      fs.chmodSync(file, 0o600);
      files.push({ path: file, name, size });
    }
    return files;
  });
}
