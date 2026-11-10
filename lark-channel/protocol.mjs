// Lark event and lark-cli details: which events reach the hub, the request text after removing
// the bot mention, and the arguments for sending one queued reply part.
// ownerOpenId (one user) and ownerOpenIds (several) may be combined. Every listed user is fully
// trusted: they drive the same agent with the same machine permissions.
export function allowedUsers(config) {
  return [...new Set([config.ownerOpenId, ...(Array.isArray(config.ownerOpenIds) ? config.ownerOpenIds : [])]
    .filter(id => typeof id === 'string' && /^ou_[A-Za-z0-9_-]+$/.test(id)))];
}

export function eventDecision(event, config, now = Date.now()) {
  if (event.type !== 'im.message.receive_v1') return 'event_type';
  if (event.sender_type !== 'user') return 'sender_type';
  if (!allowedUsers(config).includes(event.sender_id)) return 'sender';
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

// A file reply: lark-cli uploads the cwd-relative file, then replies with it.
export function fileReplyArgs(entry, name) {
  return ['im', '+messages-reply', '--as', 'bot', '--message-id', entry.messageId, '--file', name, '--idempotency-key', entry.key];
}

export function cardReplyArgs(entry, card) {
  return ['im', '+messages-reply', '--as', 'bot', '--message-id', entry.messageId, '--msg-type', 'interactive',
    '--content', JSON.stringify(card), '--idempotency-key', entry.key];
}

export function replyArgs(entry) {
  return ['im', '+messages-reply', '--as', 'bot', '--message-id', entry.messageId,
    entry.format === 'markdown' ? '--markdown' : '--text', entry.text, '--idempotency-key', entry.key];
}
