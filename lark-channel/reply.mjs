// lark-cli arguments for sending one queued reply part.
export function replyArgs(entry) {
  return ['im', '+messages-reply', '--as', 'bot', '--message-id', entry.messageId,
    entry.format === 'markdown' ? '--markdown' : '--text', entry.text, '--idempotency-key', entry.key];
}
