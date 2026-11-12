// Channel adapter: Feishu / Lark through the official lark-cli. Implements the channel interface in
// core/README.md: receives im.message.receive_v1 events, filters them, hands normalized messages to
// the hub and sends the hub's replies back as the bot.
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { start as startProgram, stop as stopProgram } from '../core/process.mjs';
import { eventDecision, messageText, replyArgs, fileReplyArgs, cardReplyArgs } from './protocol.mjs';
import { buildCard, fallbackText } from './card.mjs';
import { withStaging } from './download.mjs';
import { prepareImages } from './images.mjs';
import { prepareFiles, maxFileBytes } from './files.mjs';
import { uploadToDrive, grantAccess } from './drive.mjs';

export const requiredBins = config => [config.larkBin];

// Lark errors that can never succeed on retry (230011: the original message was withdrawn).
const PERMANENT_REPLY_ERRORS = new Set([230011]);
// Feishu's chat upload limit is 30 MB; larger files (up to 1 GiB) go through Drive and are sent as a link.
const CHAT_FILE_BYTES = 30 * 1024 * 1024;
const DRIVE_FILE_BYTES = 1024 * 1024 * 1024;
// Folders become 'file' so the user is told to zip them instead of getting a generic refusal.
const KINDS = { text: 'text', post: 'rich', image: 'image', file: 'file', folder: 'file' };

export const formatNote = '[飞书回复格式]\n除非用户本轮另有格式要求：先给结论，短段落之间留空行；简短问题直接回答，不套报告模板。可使用少量加粗、简洁列表、命名链接和带语言标签的代码块；避免多层标题、嵌套列表、长段工具日志和满屏加粗。用户要求文档时，把详细正文写入文档，聊天只给简短结论和文档链接。';

// The hub's channel-neutral view of one Lark message; raw keeps the event for Lark-only work.
export function normalize(event, config) {
  return { id: event.message_id, chatId: event.chat_id, chatType: event.chat_type === 'p2p' ? 'private' : 'group',
    userId: event.sender_id, kind: KINDS[event.message_type] || 'other', text: messageText(event, config), raw: event };
}

export function createChannel(config, { root, env, log }) {
  const larkArgs = ['--profile', config.profile];
  let listener, stopped = false, restartTimer, retries = 0;

  function runLark(args, timeoutMs = 40_000, cwd = root) {
    return new Promise((resolve, reject) => {
      const child = startProgram(config.larkBin, [...larkArgs, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => stopProgram(child), timeoutMs);
      child.stdout.on('data', d => { stdout = (stdout + d).slice(-100_000); });
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-20_000); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        let result;
        try { result = JSON.parse(stdout || stderr); } catch { /* report generic failure below */ }
        if (code === 0 && result?.ok === true) return resolve(result.data);
        const error = new Error(`Lark call failed (${result?.error?.subtype || code})`);
        error.detail = result?.error;
        error.channel = true;
        reject(error);
      });
    });
  }

  // lark-cli uploads only cwd-relative files and refuses anything under /root, so the file is copied
  // into a private staging dir under the system temp dir and sent from there.
  async function sendFile(entry) {
    if (!fs.existsSync(entry.file)) throw Object.assign(new Error('file to send is gone'), { permanent: true });
    if (fs.statSync(entry.file).size > CHAT_FILE_BYTES) {
      // Progress is kept on the entry, so a retry does not upload the file again.
      try {
        if (!entry.link) Object.assign(entry, await uploadToDrive(runLark, entry.file)).link = entry.url;
        if (entry.userId && !entry.granted) { await grantAccess(runLark, entry.token, entry.userId); entry.granted = true; }
      } catch (error) {
        // Missing app scopes, or a file over the tenant's Drive size limit (1061043; 20 MB on the
        // tenant tested 2026-11-07), will not fix themselves: say so once and keep the file here.
        const reason = error.detail?.type === 'authorization' ? `机器人缺少权限（${error.detail.message || error.detail.subtype}）`
          : error.detail?.code === 1061043 ? '飞书云空间拒绝了这个大小的文件（超出租户的单文件上传上限）' : null;
        if (!reason) throw error;
        await runLark(replyArgs({ ...entry, format: 'text', text: `「${entry.name}」超过 30 MB，需要上传到飞书云空间再发链接，但${reason}。文件留在本机：${entry.file}` }));
        throw Object.assign(new Error('Drive upload refused'), { permanent: true });
      }
      return runLark(replyArgs({ ...entry, format: 'text', text: `「${entry.name}」超过 30 MB，已上传到飞书云空间：${entry.link}` }));
    }
    const name = path.basename(entry.file);
    return withStaging('lark-upload-', async staging => {
      fs.copyFileSync(entry.file, path.join(staging, name));
      return runLark(fileReplyArgs(entry, name), 120_000, staging);
    });
  }

  // A card Feishu refuses (malformed or too large) goes out once more as the Markdown post it replaces.
  async function sendCard(entry, { strict = false } = {}) {
    try { return await runLark(cardReplyArgs(entry, buildCard(entry.text, entry.card))); }
    catch (error) {
      if (strict || !error.channel || error.detail?.type === 'network') throw error;
      log('card_rejected', { messageId: entry.messageId, code: error.detail?.code, subtype: error.detail?.subtype });
      return runLark(replyArgs({ ...entry, format: 'markdown', text: fallbackText(entry.text, entry.card), key: `${entry.key.slice(0, 36)}post` }));
    }
  }

  function start(handlers) {
    if (stopped) return;
    listener = startProgram(config.larkBin, [...larkArgs, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
      cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Keep this stdin pipe open: lark-cli intentionally exits on stdin EOF.
    listener.stdin.on('error', () => {});
    let sawReady = false;
    const startupTimer = setTimeout(() => { log('listener_ready_timeout'); stopProgram(listener); }, 60_000);
    createInterface({ input: listener.stdout }).on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch (e) { log('event_parse_error', { type: e.name }); return; }
      const reason = eventDecision(event, config);
      if (reason) { log('event_ignored', { reason, messageId: event.message_id, chatType: event.chat_type }); return; }
      handlers.message(normalize(event, config));
    });
    createInterface({ input: listener.stderr }).on('line', line => {
      if (line.includes('[event] ready event_key=im.message.receive_v1')) {
        clearTimeout(startupTimer); sawReady = true; retries = 0; log('listener_ready');
        handlers.ready();
      } else if (line.startsWith('{')) {
        try { const error = JSON.parse(line).error; if (error) log('listener_error', { type: error.type, subtype: error.subtype, message: error.message }); } catch { /* non-JSON diagnostics */ }
      } else if (/WARN|ERROR|exited|drop/i.test(line)) log('listener_diagnostic', { message: line.slice(0, 500) });
    });
    listener.on('error', error => log('listener_spawn_error', { type: error.code }));
    listener.on('close', code => {
      clearTimeout(startupTimer); log('listener_closed', { code, sawReady });
      handlers.closed();
      if (!stopped) restartTimer = setTimeout(() => start(handlers), Math.min(60_000, 2000 * 2 ** Math.min(retries++, 5)));
    });
  }

  return {
    id: 'lark',
    displayName: '飞书',
    richText: config.replyFormat === 'markdown' || config.replyFormat === 'card',
    cards: config.replyFormat === 'card',
    formatNote,
    start,
    stop() { stopped = true; clearTimeout(restartTimer); listener?.stdin.end(); stopProgram(listener); },
    // `strict` (used by the connection test): a refused card is an error instead of falling back to a post.
    send: (entry, options) => (entry.file ? sendFile(entry) : entry.card ? sendCard(entry, options) : runLark(replyArgs(entry))),
    isPermanentSendError: error => error.permanent === true || PERMANENT_REPLY_ERRORS.has(error.detail?.code),
    // Up to 30 MB as a file reply (Feishu's limit, no empty files); larger ones as a Drive link.
    fileReplies: { maxBytes: CHAT_FILE_BYTES, linkMaxBytes: DRIVE_FILE_BYTES },
    // A failed reaction is only logged, unless `strict` asks for the error (the connection test does).
    acknowledge: (message, { strict = false } = {}) => runLark(['im', 'reactions', 'create', '--as', 'bot',
      '--params', JSON.stringify({ message_id: message.id }),
      '--data', JSON.stringify({ reaction_type: { emoji_type: 'SaluteFace' } })], 10_000)
      .then(() => log('ack_reaction_added', { messageId: message.id, emojiType: 'SaluteFace' }))
      .catch(error => { log('ack_reaction_failed', { messageId: message.id, type: error.detail?.subtype || error.name }); if (strict) throw error; }),
    // lark-cli has no event for withdrawn messages, so the hub asks while a message is in flight.
    // Only the flag is read (--jq), never the message text.
    isRecalled: message => runLark(['api', 'GET', `/open-apis/im/v1/messages/${message.id}`, '--as', 'bot',
      '--jq', '{ok, error, data: {deleted: .data.items[0].deleted}}'], 10_000).then(data => data?.deleted === true),
    attachments: message => prepareImages(message.raw, config, runLark),
    files: message => prepareFiles(message.raw, config, runLark),
    incomingFileBytes: maxFileBytes(config),
    // Connection test (/test): what only this channel knows how to check.
    selfTest: {
      checks: [
        { id: 'fetch', title: '按 ID 读取消息（事件里缺图片或文件信息时用）', async run(context) {
          const data = await runLark(['im', '+messages-mget', '--as', 'bot', '--message-ids', context.message.id, '--no-reactions']);
          if (!data?.messages?.some(item => item.message_id === context.message.id)) throw new Error('读回的结果里没有这条消息');
        } },
        // Uploads a real 31 MB file to the bot's Drive space and leaves it there, so only on request.
        { id: 'drive', title: '超过 30 MB 的文件经云空间发回', manual: true, timeoutMs: 15 * 60_000, async run(context) {
          const file = path.join(context.scratch, '接入测试-大文件.bin');
          fs.writeFileSync(file, ''); fs.truncateSync(file, CHAT_FILE_BYTES + 1024 * 1024);
          await sendFile(context.entry('drive', { file, name: '接入测试-大文件.bin', userId: context.message.userId }));
          return '已上传并发出链接；这个文件留在机器人的云空间里';
        } },
      ],
    },
  };
}
