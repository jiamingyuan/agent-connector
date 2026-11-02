import { createHash } from 'node:crypto';

export function eventDecision(event, config, now = Date.now()) {
  if (event.type !== 'im.message.receive_v1') return 'event_type';
  if (event.sender_type !== 'user') return 'sender_type';
  if (event.sender_id !== config.ownerOpenId) return 'sender';
  if (event.chat_type === 'group') {
    if (config.allowGroupMentions !== true) return 'chat_type';
    if (!/^ou_[A-Za-z0-9_-]+$/.test(config.botOpenId || '')) return 'bot_identity';
    if (!Array.isArray(event.mentions) || !event.mentions.some(mention => mention?.id === config.botOpenId)) return 'bot_not_mentioned';
  } else if (event.chat_type !== 'p2p') return 'chat_type';
  if (!/^om_[A-Za-z0-9_-]+$/.test(event.message_id || '')) return 'message_id';
  if (!/^oc_[A-Za-z0-9_-]+$/.test(event.chat_id || '')) return 'chat_id';
  const created = Number(event.create_time);
  if (!Number.isFinite(created) || created < now - config.maxEventAgeMs || created > now + 60_000) return 'stale';
  return null;
}

export function messageText(event, config) {
  let text = typeof event.content === 'string' ? event.content : '';
  if (event.chat_type !== 'group' || !config.botOpenId) return text;
  const mentions = Array.isArray(event.mentions) ? event.mentions : [];
  for (const mention of mentions.filter(item => item?.id === config.botOpenId)) {
    for (const token of [mention.key, mention.name && '@' + mention.name].filter(value => typeof value === 'string' && value)) {
      const start = text.trimStart();
      if (start === token || start.startsWith(token) && /^[\s:：,，]/u.test(start.slice(token.length))) {
        text = start.slice(token.length).replace(/^[\s:：,，]+/u, '');
      }
    }
  }
  return text;
}

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

export function replyArgs(entry) {
  return ['im', '+messages-reply', '--as', 'bot', '--message-id', entry.messageId,
    entry.format === 'markdown' ? '--markdown' : '--text', entry.text, '--idempotency-key', entry.key];
}

export function replyKey(messageId, kind, part = 0) {
  return createHash('sha256').update(`${messageId}:${kind}:${part}`).digest('hex').slice(0, 40);
}

export function codexArgs(config, sessionId, outputFile) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
    '--enable', 'skip_host_skill_discovery',
    '-c', 'approval_policy="never"', '-C', config.workspace, '-o', outputFile];
  if (sessionId) args.push('resume', sessionId, '-');
  else args.push('-');
  return args;
}
