import fs from 'node:fs';
import path from 'node:path';
import { messageDirectory, withStaging, download } from './download.mjs';

export const imageLimits = { count: 4, bytes: 5 * 1024 * 1024, totalBytes: 6 * 1024 * 1024 };

// Accept actual image markers, not arbitrary resource keys mentioned in prose.
export function imageKeys(content) {
  const keys = [];
  const add = key => { if (/^img_[A-Za-z0-9_-]+$/.test(key || '') && !keys.includes(key)) keys.push(key); };
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.image_key) add(node.image_key);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  if (typeof content === 'object') visit(content);
  else if (typeof content === 'string') {
    try { visit(JSON.parse(content)); } catch { /* CLI renders most messages as Markdown. */ }
    // Older lark-cli renders images as ![Image](img_…); 1.0.98 and later as [Image: img_…].
    for (const match of content.matchAll(/!\[[^\]\n]*\]\((img_[A-Za-z0-9_-]+)\)/g)) add(match[1]);
    for (const match of content.matchAll(/\[Image:\s*(img_[A-Za-z0-9_-]+)\s*\]/gi)) add(match[1]);
  }
  return keys;
}

export function imageMediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw new Error('图片格式暂不支持，请发送 PNG、JPEG、GIF 或 WebP 图片。');
}


// Called by the hub only when the agent accepts images.
export async function prepareImages(event, config, runLark) {
  if (!['image', 'post'].includes(event.message_type)) return [];
  let keys = imageKeys(event.content);
  if (!keys.length && (event.message_type === 'image' || /\[image\b/i.test(event.content || ''))) {
    // Some CLI versions omit resource keys from the compact event. Fetch the same message.
    const data = await runLark(['im', '+messages-mget', '--as', 'bot', '--message-ids', event.message_id, '--no-reactions']);
    const message = data.messages?.find(item => item.message_id === event.message_id);
    keys = imageKeys(message?.content);
    if (!keys.length) throw new Error('没有取到这条消息的图片资源，请重新发送原图。');
  }
  if (!keys.length) return [];
  if (keys.length > imageLimits.count) throw new Error('一条消息最多支持 4 张图片，请分批发送。');
  const directory = messageDirectory(config, event.message_id, 'images');
  return withStaging('lark-images-', async staging => {
    const images = [];
    let total = 0;
    for (const [index, key] of keys.entries()) {
      const real = await download(runLark, staging, { messageId: event.message_id, key, type: 'image', output: `image-${index + 1}`,
        timeoutMs: 60_000, failure: '飞书图片下载失败，请重发原图；若仍失败，请检查机器人的消息资源读取权限和网络。' });
      const size = fs.statSync(real).size;
      total += size;
      if (!size || size > imageLimits.bytes || total > imageLimits.totalBytes) {
        throw new Error('图片过大：每张最多 5 MiB，一条消息合计最多 6 MiB，请压缩或分批发送。');
      }
      const bytes = fs.readFileSync(real);
      const mediaType = imageMediaType(bytes);
      const file = path.join(directory, `image-${index + 1}.${mediaType.split('/')[1].replace('jpeg', 'jpg')}`);
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      images.push({ path: file, mediaType, data: bytes.toString('base64') });
    }
    return images;
  });
}
