// Which Lark events reach the hub, and the request text after removing the bot mention.
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
