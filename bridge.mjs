import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { eventDecision, messageText, splitText, splitMarkdown, replyKey, replyArgs } from './core.mjs';
import { agentName, agentInvocation, agentInput, parseAgentEvent } from './backends.mjs';
import { prepareImages } from './images.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const backendName = agentName(config);
const runtime = path.join(root, 'runtime');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const stateFile = path.join(runtime, 'state.json');
const statusFile = path.join(runtime, 'status.json');
const lockFile = path.join(runtime, 'bridge.pid');
const env = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
delete env.CODEX_THREAD_ID;
const larkArgs = ['--profile', config.profile];
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { sessions: {}, seen: [], outbox: [] };
state.outbox ||= [];
const seen = new Set(state.seen);
const active = new Map();
const queues = new Map();
const generations = new Map();
let listener, stopping = false, ready = false, restartTimer, retries = 0;
let processingCount = 0;
const startedAt = new Date().toISOString();

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
function save() {
  state.seen = [...seen].slice(-3000);
  atomicJson(stateFile, state);
}
function log(type, fields = {}) {
  // A caller's `type` field (error subtype) must not overwrite the event name.
  const { type: detail, ...rest } = fields;
  console.log(JSON.stringify({ time: new Date().toISOString(), type, ...(detail === undefined ? {} : { detail }), ...rest }));
}
function status() {
  atomicJson(statusFile, { pid: process.pid, startedAt, updatedAt: new Date().toISOString(), ready,
    active: active.size, queued: processingCount, sessionCount: Object.keys(state.sessions).length,
    pendingReplies: state.outbox.length, botName: config.botName, workspace: config.workspace,
    backend: config.backend || 'codex', agentName: backendName, turnTimeoutMs: config.turnTimeoutMs });
}
function claimLock() {
  try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lockFile, 'utf8'));
    let alive = false;
    try { if (pid > 0) { process.kill(pid, 0); alive = true; } } catch (e) { if (e.code !== 'ESRCH') throw e; }
    if (alive) throw new Error(`Bridge already running (PID ${pid})`);
    fs.unlinkSync(lockFile);
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
}
function runLark(args, timeoutMs = 40_000, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.larkBin, [...larkArgs, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
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
      reject(error);
    });
  });
}

// Lark errors that can never succeed on retry (230011: the original message was withdrawn).
const PERMANENT_REPLY_ERRORS = new Set([230011]);
function dropFromOutbox(entry) {
  state.outbox = state.outbox.filter(item => item.key !== entry.key);
  save(); status();
}
async function flushOutbox() {
  // A failing reply only holds back later parts for the same message, so one stuck
  // reply cannot block answers to other messages.
  const blocked = new Set();
  let firstError;
  for (const entry of [...state.outbox]) {
    if (blocked.has(entry.messageId)) continue;
    try {
      await runLark(replyArgs(entry));
    } catch (error) {
      if (PERMANENT_REPLY_ERRORS.has(error.detail?.code)) {
        dropFromOutbox(entry);
        log('reply_dropped', { messageId: entry.messageId, kind: entry.kind, code: error.detail.code });
        continue;
      }
      blocked.add(entry.messageId);
      firstError ||= error;
      continue;
    }
    dropFromOutbox(entry);
    log('reply_sent', { messageId: entry.messageId, kind: entry.kind });
  }
  if (firstError) throw firstError;
}
let sending = Promise.resolve();
function reply(event, text, kind = 'answer') {
  const format = kind === 'answer' && config.replyFormat === 'markdown' ? 'markdown' : 'text';
  const parts = format === 'markdown' ? splitMarkdown(text) : splitText(text);
  for (const [index, part] of parts.entries()) {
    const key = replyKey(event.message_id, kind, index);
    if (!state.outbox.some(entry => entry.key === key)) state.outbox.push({
      messageId: event.message_id, text: part, format, kind, key, createdAt: Date.now(),
    });
  }
  save();
  sending = sending.catch(() => {}).then(flushOutbox);
  return sending;
}

function terminate(child) {
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch { child.kill('SIGTERM'); }
}
function runAgent(event, images = []) {
  return new Promise((resolve, reject) => {
    const chatId = event.chat_id;
    const previous = state.sessions[chatId];
    const outputFile = path.join(runtime, `${replyKey(event.message_id, 'output')}.txt`);
    const invocation = agentInvocation(config, previous?.id, outputFile, images);
    const child = spawn(invocation.bin, invocation.args, {
      cwd: config.workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const job = { child, cancelled: false, timedOut: false, startupFailed: false };
    active.set(chatId, job); status();
    const startupTimer = setTimeout(() => { job.startupFailed = true; terminate(child); }, 120_000);
    const timer = setTimeout(() => { job.timedOut = true; terminate(child); }, config.turnTimeoutMs);
    let completed = false, failure = null, resultText = '';
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let item;
      try { item = JSON.parse(line); } catch { return; }
      const update = parseAgentEvent(config, item);
      if (update.ready) {
        clearTimeout(startupTimer);
      }
      if (update.sessionId) {
        state.sessions[chatId] = { id: update.sessionId, updatedAt: new Date().toISOString() };
        save();
      }
      if (update.completed) completed = true;
      if (update.failed) { completed = false; failure = 'turn.failed'; }
      if (update.text !== undefined) resultText = update.text;
    });
    // Never persist raw model/tool events or credentials to the service log.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(agentInput(config, event.content, images, { chatType: event.chat_type }));
    child.on('error', error => { failure = error.message; });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(startupTimer); active.delete(chatId); status();
      let text = resultText.trim();
      if (fs.existsSync(outputFile)) { text = fs.readFileSync(outputFile, 'utf8').trim(); fs.unlinkSync(outputFile); }
      if (job.cancelled) return resolve(null);
      if (job.startupFailed) return reject(new Error(`${backendName} 初始化超过两分钟，已停止。请查看本机服务状态后重试。`));
      if (job.timedOut) return reject(new Error(`任务超过 ${Math.ceil(config.turnTimeoutMs / 60_000)} 分钟已停止。已完成的操作不会自动撤销，可以分批继续。`));
      if (code !== 0 || !completed || !text) {
        log('agent_failed', { backend: config.backend || 'codex', code, hasFailure: Boolean(failure), completed });
        return reject(new Error(`${backendName} 本轮运行失败，已有会话仍保留。请稍后重试；服务端可查看 runtime/bridge.log。`));
      }
      log('agent_completed', { backend: config.backend || 'codex', messageId: event.message_id, characters: text.length });
      resolve(text);
    });
  });
}

async function handle(event, generation) {
  if (stopping || generation !== (generations.get(event.chat_id) || 0)) return;
  const text = (event.content || '').trim();
  if (text === '/new') {
    delete state.sessions[event.chat_id]; save();
    return reply(event, `已开启新会话，下一条消息会创建新的 ${backendName} 上下文。`, 'new');
  }
  if (!['text', 'post'].includes(event.message_type) && !(config.backend === 'claude' && event.message_type === 'image')) {
    return reply(event, '目前支持文字对话，请把需要处理的内容或本机文件路径用文字发给我。', 'unsupported');
  }
  if (!text && event.chat_type === 'group' && event.message_type === 'text') return reply(event, '我在，@我并发送问题就能开始。', 'help');
  if (!text && event.message_type !== 'image') return;
  if (text.length > 40_000) return reply(event, '消息过长，请拆分后发送。', 'limit');
  if (text === '/help') return reply(event, `私聊直接发文字${config.backend === 'claude' ? '或图片（支持图文混合，每条最多 4 张）' : ''}即可与 ${backendName} 对话。${config.allowGroupMentions ? '\n群聊请 @' + config.botName + ' 后发送请求或以下命令；只接受已授权用户，每个群使用独立上下文。' : ''}\n/new：新会话\n/status：查看状态\n/stop：停止当前任务并清空排队消息\n/help：使用说明`, 'help');
  try {
    await runLark(['im', 'reactions', 'create', '--as', 'bot',
      '--params', JSON.stringify({ message_id: event.message_id }),
      '--data', JSON.stringify({ reaction_type: { emoji_type: 'SaluteFace' } })], 10_000)
      .then(() => log('ack_reaction_added', { messageId: event.message_id, emojiType: 'SaluteFace' }))
      .catch(error => log('ack_reaction_failed', { messageId: event.message_id, type: error.detail?.subtype || error.name }));
    if (stopping || generation !== (generations.get(event.chat_id) || 0)) return;
    const images = await prepareImages(event, config, runLark);
    if (stopping || generation !== (generations.get(event.chat_id) || 0)) return;
    if (images.length) log('images_prepared', { messageId: event.message_id, count: images.length });
    const result = await runAgent(event, images);
    if (result && !stopping) await reply(event, result);
  } catch (error) {
    log('turn_error', { messageId: event.message_id, type: error.detail?.subtype || error.name });
    if (!stopping) await reply(event, error.detail ? '飞书消息发送失败，请查看本机服务日志。' : error.message, 'error').catch(() => {});
  }
}
function receive(event) {
  const reason = eventDecision(event, config);
  if (reason) { log('event_ignored', { reason, messageId: event.message_id, chatType: event.chat_type }); return; }
  if (seen.has(event.message_id)) return;
  event = { ...event, content: messageText(event, config) };
  seen.add(event.message_id);
  if (seen.size > 4000) { for (const id of [...seen].slice(0, 1000)) seen.delete(id); }
  save();
  log('message_received', { messageId: event.message_id, messageType: event.message_type, chatType: event.chat_type, chatId: event.chat_id });
  if (event.content?.trim() === '/status') {
    const session = state.sessions[event.chat_id]?.id || '尚未创建';
    void reply(event, `机器人：${config.botName}\nAgent：${backendName}\n连接：${ready ? '正常' : '重连中'}\n当前任务：${active.has(event.chat_id) ? '运行中' : '空闲'}\n单条任务时限：${Math.ceil(config.turnTimeoutMs / 60_000)} 分钟\n会话：${session}\n工作区：${config.workspace}`, 'status').catch(e => log('reply_error', { type: e.detail?.subtype || e.name }));
    return;
  }
  if (event.content?.trim() === '/stop') {
    generations.set(event.chat_id, (generations.get(event.chat_id) || 0) + 1);
    const job = active.get(event.chat_id);
    if (job) { job.cancelled = true; terminate(job.child); }
    void reply(event, job ? '已请求停止当前任务，排队消息已取消。会话上下文保留。' : '当前没有运行中的任务，排队消息已取消。', 'stop').catch(e => log('reply_error', { type: e.detail?.subtype || e.name }));
    return;
  }
  if (processingCount >= 20) {
    void reply(event, '排队消息较多，请稍后再试，或发 /stop 取消当前任务。', 'busy').catch(() => {}); return;
  }
  processingCount++; status();
  const generation = generations.get(event.chat_id) || 0;
  const promise = (queues.get(event.chat_id) || Promise.resolve()).catch(() => {}).then(() => handle(event, generation))
    .catch(error => log('handler_error', { type: error.name }))
    .finally(() => { processingCount--; if (queues.get(event.chat_id) === promise) queues.delete(event.chat_id); status(); });
  queues.set(event.chat_id, promise);
}

function startListener() {
  if (stopping) return;
  ready = false; status();
  listener = spawn(config.larkBin, [...larkArgs, 'event', 'consume', 'im.message.receive_v1', '--as', 'bot'], {
    cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Keep this stdin pipe open: lark-cli intentionally exits on stdin EOF.
  listener.stdin.on('error', () => {});
  let sawReady = false;
  const startupTimer = setTimeout(() => { log('listener_ready_timeout'); listener.kill('SIGTERM'); }, 60_000);
  const lines = createInterface({ input: listener.stdout });
  lines.on('line', line => {
    try { receive(JSON.parse(line)); } catch (e) { log('event_parse_error', { type: e.name }); }
  });
  const errors = createInterface({ input: listener.stderr });
  errors.on('line', line => {
    if (line.includes('[event] ready event_key=im.message.receive_v1')) {
      clearTimeout(startupTimer); sawReady = true; ready = true; retries = 0; status(); log('listener_ready');
      sending = sending.catch(() => {}).then(flushOutbox).catch(error => log('outbox_error', { type: error.detail?.subtype || error.name }));
    } else if (line.startsWith('{')) {
      try { const error = JSON.parse(line).error; if (error) log('listener_error', { type: error.type, subtype: error.subtype, message: error.message }); } catch { /* non-JSON diagnostics */ }
    } else if (/WARN|ERROR|exited|drop/i.test(line)) log('listener_diagnostic', { message: line.slice(0, 500) });
  });
  listener.on('error', error => log('listener_spawn_error', { type: error.code }));
  listener.on('close', code => {
    clearTimeout(startupTimer); ready = false; status(); log('listener_closed', { code, sawReady });
    if (!stopping) restartTimer = setTimeout(startListener, Math.min(60_000, 2000 * 2 ** Math.min(retries++, 5)));
  });
}
function shutdown(signal) {
  if (stopping) return;
  stopping = true; ready = false; clearTimeout(restartTimer);
  listener?.stdin.end(); listener?.kill('SIGTERM');
  for (const { child } of active.values()) terminate(child);
  save(); status(); log('stopped', { signal });
  if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile);
  setTimeout(() => process.exit(0), 1000).unref();
}

claimLock();
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
status(); log('started', { botName: config.botName, workspace: config.workspace });
startListener();
setInterval(() => {
  if (stopping || !ready || state.outbox.length === 0) return;
  sending = sending.catch(() => {}).then(flushOutbox).catch(error => log('outbox_error', { type: error.detail?.subtype || error.name }));
}, 30_000).unref();
