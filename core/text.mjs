// Channel- and agent-independent text helpers: reply splitting, session headers, reply keys.
import { createHash } from 'node:crypto';

export function splitText(text, maxBytes = 12_000) {
  const parts = [];
  let part = '', bytes = 0;
  for (const char of String(text)) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes && part) {
      parts.push(part); part = ''; bytes = 0;
    }
    part += char; bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

// Prefer whole paragraphs, lists and fenced blocks instead of arbitrary UTF-8 cuts.
export function splitMarkdown(text, targetBytes = 6000, hardMaxBytes = 12_000) {
  const blocks = [];
  let block = '', fence = null;
  for (const line of String(text).match(/[^\n]*\n|[^\n]+$/g) || []) {
    block += line;
    if (fence) {
      if (new RegExp('^ {0,3}' + fence.mark + '{' + fence.length + ',}\\s*$').test(line.trimEnd())) fence = null;
    } else {
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (opening) fence = { mark: opening[1][0], length: opening[1].length };
    }
    if (!fence && !line.trim() && !/^#{1,6}\s+[^\n]+$/.test(block.trim())) {
      blocks.push(block); block = '';
    }
  }
  if (block) blocks.push(block);
  const parts = [];
  let part = '';
  const flush = () => { if (part) { parts.push(part); part = ''; } };
  for (const piece of blocks) {
    const size = Buffer.byteLength(piece);
    if (part && Buffer.byteLength(part) + size > targetBytes) flush();
    if (size > hardMaxBytes) {
      flush();
      const code = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1\s*$/.exec(piece);
      if (code && Buffer.byteLength(code[1] + code[2]) < 256) {
        const prefix = code[1] + code[2] + '\n', suffix = '\n' + code[1];
        parts.push(...splitText(code[3], hardMaxBytes - Buffer.byteLength(prefix + suffix)).map(body => prefix + body + suffix));
      } else parts.push(...splitText(piece, hardMaxBytes));
    } else part += piece;
  }
  flush();
  return parts;
}

// Every message can start with a header line: the session name (bold for Markdown posts, bracketed
// for plain text) and an optional note such as the permission mode. Each split part gets the header.
export function replyParts(text, format, label, note = '') {
  const tail = note ? ` -- ${note}` : '';
  const header = !label ? '' : format === 'markdown' ? `**${label}**${tail}\n` : `【${label}】${tail}\n`;
  const room = Buffer.byteLength(header);
  const parts = format === 'markdown' ? splitMarkdown(text, 6000 - room, 12_000 - room) : splitText(text, 12_000 - room);
  return parts.map(part => header + part);
}

export function replyKey(messageId, kind, part = 0) {
  return createHash('sha256').update(`${messageId}:${kind}:${part}`).digest('hex').slice(0, 40);
}


export function clip(text, max) {
  const chars = [...String(text || '').replace(/\s+/g, ' ').trim()];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

// One-line, Markdown-safe and bounded: used for session names and echoed user input.
export function safeLabel(text, max = 40) {
  return clip(String(text || '').replace(/[\u0000-\u001f\u007f*`\\~<>[\]|]/g, ' '), max);
}
