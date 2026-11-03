// The hub connects one channel adapter (where messages come from) to one agent adapter (who answers).
// It owns everything that is neither channel- nor agent-specific: per-chat queues, dedupe, the reply
// outbox, chat state and the commands. Interfaces: core/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { replyParts, replyKey, safeLabel } from './text.mjs';

const LIST_LIMIT = 10;
const SUMMARY_TIMEOUT_MS = 5 * 60_000;

export function commandArgs(text, name) {
  if (text === name) return '';
  return text.startsWith(name) && /\s/u.test(text[name.length]) ? text.slice(name.length).trim() : null;
}

export function createHub({ config, agent, channel, runtime, log }) {
  const stateFile = path.join(runtime, 'state.json');
  const statusFile = path.join(runtime, 'status.json');
  const agentName = agent.displayName;
  const where = channel.displayName;
  let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { sessions: {}, seen: [], outbox: [] };
  state.outbox ||= [];
  // attached: chat ID -> agent session selected with /switch; sessions keeps the workspace session.
  state.attached ||= {};
  state.listings ||= {};
  // modes: chat ID -> permission mode chosen with /mode; absent means the configured default.
  state.modes ||= {};
  const seen = new Set(state.seen);
  const active = new Map();
  const queues = new Map();
  const generations = new Map();
  let stopping = false, ready = false, processingCount = 0, sending = Promise.resolve();
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
  function status() {
    atomicJson(statusFile, { pid: process.pid, startedAt, updatedAt: new Date().toISOString(), ready,
      active: active.size, queued: processingCount, sessionCount: Object.keys(state.sessions).length,
      attachedSessions: Object.keys(state.attached).length,
      ...(agent.modes ? { defaultPermissionMode: config.claudePermissionMode || 'auto', modeOverrides: Object.keys(state.modes).length } : {}),
      pendingReplies: state.outbox.length, botName: config.botName, workspace: config.workspace,
      agent: agent.id, channel: channel.id, agentName, turnTimeoutMs: config.turnTimeoutMs });
  }
  const superseded = (message, generation) => stopping || generation !== (generations.get(message.chatId) || 0);
  const logReplyError = e => log('reply_error', { type: e.detail?.subtype || e.name });

  // ---- replies ----
  async function flushOutbox() {
    // A failing reply only holds back later parts for the same message, so one stuck
    // reply cannot block answers to other messages.
    const blocked = new Set();
    let firstError;
    for (const entry of [...state.outbox]) {
      if (blocked.has(entry.messageId)) continue;
      try {
        await channel.send(entry);
      } catch (error) {
        if (channel.isPermanentSendError(error)) {
          drop(entry);
          log('reply_dropped', { messageId: entry.messageId, kind: entry.kind, code: error.detail?.code });
          continue;
        }
        blocked.add(entry.messageId);
        firstError ||= error;
        continue;
      }
      drop(entry);
      log('reply_sent', { messageId: entry.messageId, kind: entry.kind });
    }
    if (firstError) throw firstError;
  }
  function drop(entry) {
    state.outbox = state.outbox.filter(item => item.key !== entry.key);
    save(); status();
  }
  function flushLater() {
    sending = sending.catch(() => {}).then(flushOutbox).catch(error => log('outbox_error', { type: error.detail?.subtype || error.name }));
  }
  function reply(message, text, kind = 'answer') {
    // While a session is selected, every message (answers and notices) is headed by its name.
    const label = state.attached[message.chatId]?.name;
    const format = channel.richText && (kind === 'answer' || label) ? 'markdown' : 'text';
    for (const [index, part] of replyParts(text, format, label).entries()) {
      const key = replyKey(message.id, kind, index);
      if (!state.outbox.some(entry => entry.key === key)) state.outbox.push({
        messageId: message.id, chatId: message.chatId, text: part, format, kind, key, createdAt: Date.now(),
      });
    }
    save();
    sending = sending.catch(() => {}).then(flushOutbox);
    return sending;
  }

  // ---- agent turns ----
  // Where this chat's next turn runs: the session chosen with /switch, else the workspace session.
  function chatTarget(chatId) {
    const attached = state.attached[chatId];
    if (attached) return { kind: 'attached', id: attached.id, cwd: attached.cwd, name: attached.name, file: attached.file };
    return { kind: 'workspace', id: state.sessions[chatId]?.id, cwd: config.workspace };
  }
  function rememberSession(chatId, target, id) {
    const updatedAt = new Date().toISOString();
    if (target.kind === 'attached') {
      const current = state.attached[chatId];
      if (!current || (current.id !== target.id && current.id !== id)) return;
      if (current.id !== id) current.file = path.join(path.dirname(current.file), `${id}.jsonl`);
      Object.assign(current, { id, updatedAt });
    } else state.sessions[chatId] = { id, updatedAt };
    save();
  }
  // Bridge notes appended to the user's text; Claude session listings strip everything from "\n\n[桥接".
  function composeText(message, target) {
    let text = message.text;
    if (message.chatType === 'group') {
      text = `${text || ''}\n\n[桥接会话范围]\n当前为群聊，最终回复对本群成员可见。本群使用独立会话；不要读取或引用私聊、其他群的会话记录或私人记忆来补充回答。`;
    }
    // A session selected with /switch was started elsewhere; tell it where this turn came from.
    const from = target.kind === 'attached' ? `这条消息是用户在${where}里发来的，你的最终回复会转发到${where}。\n` : '';
    if (channel.richText) text = `${text || ''}\n\n[桥接运行信息]\n${from}当前工作目录：${target.cwd}\n\n${channel.formatNote}`;
    else if (from) text = `${text || ''}\n\n[桥接运行信息]\n${from.trim()}`;
    return text;
  }
  // Runs one tracked turn for the chat so /stop and shutdown can cancel it.
  async function track(message, handle, logType) {
    const job = { handle };
    active.set(message.chatId, job); status();
    try {
      const text = await handle.result;
      if (text !== null) log(`${logType}_completed`, { agent: agent.id, messageId: message.id, characters: text.length });
      return text;
    } catch (error) {
      if (error.code === 'failed') log(`${logType}_failed`, { agent: agent.id, code: error.exitCode, hasFailure: error.hasFailure, completed: error.completed });
      throw error;
    } finally {
      active.delete(message.chatId); status();
    }
  }
  function runAgent(message, { images = [], target }) {
    return track(message, agent.runTurn({ sessionId: target.id, cwd: target.cwd, text: composeText(message, target), images,
      mode: state.modes[message.chatId], timeoutMs: config.turnTimeoutMs, turnKey: replyKey(message.id, 'output'),
      onSession: id => rememberSession(message.chatId, target, id) }), 'agent');
  }

  // ---- /usage ----
  function showUsage(message) {
    if (!agent.usage) return reply(message, `/usage 目前不支持 ${agentName}。`, 'usage');
    return agent.usage().then(text => reply(message, text, 'usage'), error => {
      log('usage_error', { type: error.code || error.name });
      return reply(message, '查询用量失败，请稍后重试；服务端可查看 runtime/bridge.log。', 'usage');
    });
  }

  // ---- selectable sessions (/sessions, /switch, /exit) ----
  const sessions = agent.sessions;
  function sessionCommandRefusal(message) {
    if (!sessions) return `会话切换目前不支持 ${agentName}。`;
    if (message.chatType !== 'private') return '会话切换只能在私聊中使用，以免把其他会话的内容发到群里。';
    return null;
  }
  // The bridge's own workspace sessions are reached with /exit, so they are not listed.
  const catalog = () => sessions.list({ exclude: [config.workspace] });
  function showSessions(message, query) {
    const refusal = sessionCommandRefusal(message);
    if (refusal) return reply(message, refusal, 'sessions');
    const found = sessions.filter(catalog(), query);
    const shown = found.slice(0, LIST_LIMIT);
    state.listings[message.chatId] = shown.map(session => session.id); save();
    return reply(message, sessions.format(shown, { total: found.length, running: sessions.running(),
      current: state.attached[message.chatId]?.id, query: safeLabel(query) }), 'sessions');
  }
  function fallbackRecap(file) {
    try {
      const { prompt, reply: answer } = sessions.digest(file);
      return ['（自动梗概生成失败，以下是最近一轮对话的摘录）', prompt && `最近的提问：${prompt}`, answer && `最近的回复：${answer}`]
        .filter(Boolean).join('\n');
    } catch { return '（自动梗概生成失败，也无法读取会话记录。）'; }
  }
  async function switchSession(message, query, generation) {
    const refusal = sessionCommandRefusal(message);
    if (refusal) return reply(message, refusal, 'switch');
    if (!query) return reply(message, '用法：/switch 编号。先发 /sessions 查看列表；也可以写会话 ID 的开头几位或完整会话名。', 'switch');
    const all = catalog();
    const listed = state.listings[message.chatId] || sessions.filter(all).slice(0, LIST_LIMIT).map(session => session.id);
    const matches = sessions.pick(all, query, listed);
    if (matches.length > 1) {
      return reply(message, `有 ${matches.length} 个会话匹配「${safeLabel(query)}」，请改用编号或会话 ID：\n`
        + matches.slice(0, LIST_LIMIT).map(session => `${session.id.slice(0, 8)} · ${session.name} · ${session.cwd}`).join('\n'), 'switch');
    }
    const [session] = matches;
    if (!session) return reply(message, `没有找到会话「${safeLabel(query)}」。发 /sessions 查看可切换的会话。`, 'switch');
    if (state.attached[message.chatId]?.id === session.id) return reply(message, `已经在会话「${session.name}」中。发 /exit 回到 workspace 会话。`, 'switch');
    if (!fs.existsSync(session.cwd)) return reply(message, `会话目录 ${session.cwd} 已不存在，无法恢复这个会话。`, 'switch');
    const terminal = sessions.running().get(session.id);
    // Resuming while a terminal is mid-turn would interleave two writers in one transcript.
    if (terminal?.busy) return reply(message, `会话「${session.name}」正在终端里执行任务，等它结束后再切换。`, 'switch');
    await channel.acknowledge(message);
    if (superseded(message, generation)) return;
    state.attached[message.chatId] = { id: session.id, cwd: session.cwd, name: session.name, file: session.file,
      attachedAt: new Date().toISOString() };
    save(); status();
    log('session_attached', { chatId: message.chatId, messageId: message.id });
    let recap;
    try {
      recap = await track(message, sessions.recap({ sessionId: session.id, cwd: session.cwd,
        timeoutMs: Math.min(config.turnTimeoutMs, SUMMARY_TIMEOUT_MS) }), 'summary');
      if (recap === null) return; // stopped with /stop; the switch itself stays in effect
    } catch (error) {
      log('summary_error', { messageId: message.id, type: error.name });
      recap = fallbackRecap(session.file);
    }
    if (stopping) return;
    return reply(message, [
      `已进入会话「${session.name}」\n目录：${session.cwd}\n最近活动：${sessions.ago(session.mtimeMs)}`,
      terminal && `注意：这个会话在终端里还开着。${where}里的新对话不会出现在那个终端窗口；回终端继续前，先退出那个窗口，再运行 ${sessions.resumeHint(session.id)}。`,
      `前情梗概：\n${recap}`,
      '直接发消息即可在这个会话里继续；发 /exit 回到 workspace 会话。',
    ].filter(Boolean).join('\n\n'), 'switch');
  }
  function exitSession(message) {
    const current = state.attached[message.chatId];
    if (!current) return reply(message, '当前已经在 workspace 会话中。', 'exit');
    delete state.attached[message.chatId]; save(); status();
    log('session_detached', { chatId: message.chatId, messageId: message.id });
    return reply(message, `已退出会话「${current.name}」，回到 workspace 会话。`, 'exit');
  }
  // Checked before every turn in a selected session.
  function attachedProblem(target) {
    if (!fs.existsSync(target.file)) return `会话「${target.name}」的记录已不存在，无法继续。发 /exit 回到 workspace 会话。`;
    if (!fs.existsSync(target.cwd)) return `会话目录 ${target.cwd} 已不存在，无法继续。发 /exit 回到 workspace 会话。`;
    if (sessions?.running().get(target.id)?.busy) {
      return '这个会话正在终端里执行任务，这条消息没有发出。等终端任务结束后重发，或发 /exit 回到 workspace 会话。';
    }
    return null;
  }

  // ---- permission modes (/mode) ----
  const modes = agent.modes;
  function modeOverview(current, fallback) {
    return [`当前权限模式：${current}${current === fallback ? '（默认）' : ''}`, '',
      ...Object.entries(modes.descriptions).map(([mode, text]) => `${mode}${mode === fallback ? '（默认）' : ''}：${text}`), '',
      '发送 /mode 模式名 切换（bypassPermissions 可简写为 bypass），只影响这个聊天，重启后保留。'].join('\n');
  }
  function changeMode(message, query) {
    if (!modes) return reply(message, `权限模式切换目前不支持 ${agentName}。`, 'mode');
    let fallback, current;
    try { fallback = modes.resolve(); current = modes.resolve(state.modes[message.chatId]); }
    catch { return reply(message, 'config.json 中的 claudePermissionMode 无效，请修正后重启服务。', 'mode'); }
    if (!query) return reply(message, modeOverview(current, fallback), 'mode');
    const mode = modes.find(query);
    if (!mode) return reply(message, `没有「${safeLabel(query)}」这个模式。\n\n${modeOverview(current, fallback)}`, 'mode');
    // Group members can see replies; a group is not where every safeguard should be switched off.
    if (mode === 'bypassPermissions' && message.chatType !== 'private') return reply(message, '群聊里不能切换到 bypassPermissions，请在私聊中使用。', 'mode');
    if (mode === current) return reply(message, `当前已经是 ${mode} 模式。`, 'mode');
    if (mode === fallback) delete state.modes[message.chatId]; else state.modes[message.chatId] = mode;
    save(); status();
    log('mode_changed', { chatId: message.chatId, messageId: message.id, mode });
    return reply(message, `已切换到 ${mode} 模式${mode === fallback ? '（默认）' : ''}：${modes.descriptions[mode]}。`
      + (mode === 'bypassPermissions' ? `\n用完记得发 /mode ${fallback} 切回。` : ''), 'mode');
  }
  function modeLabel(chatId) {
    try {
      const mode = modes.resolve(state.modes[chatId]);
      return mode === modes.resolve() ? `${mode}（默认）` : `${mode}（/mode 切换）`;
    } catch (error) { return `配置无效（${error.message}）`; }
  }

  // ---- help and status ----
  function helpText() {
    const lines = [`私聊直接发文字${agent.capabilities.images ? '或图片（支持图文混合，每条最多 4 张）' : ''}即可与 ${agentName} 对话。`
      + (config.allowGroupMentions ? `\n群聊请 @${config.botName} 后发送请求或以下命令；只接受已授权用户，每个群使用独立上下文。` : ''),
    `/new：新会话${sessions ? '（会先退出已选择的会话）' : ''}`, '/status：查看状态', '/stop：停止当前任务并清空排队消息'];
    if (modes) lines.push(`/mode：查看或切换权限模式（${Object.keys(modes.descriptions).join('、')}）`);
    if (agent.usage) lines.push(`/usage：${agent.usageLabel}`);
    if (sessions) lines.push(`/sessions：列出本机可切换的 ${agentName} 会话（仅私聊；/sessions all 包括脚本会话，/sessions 关键词 筛选）`,
      '/switch 编号：进入列表中的会话，并收到前情梗概', '/exit：退出当前会话，回到 workspace 会话');
    lines.push('/help：使用说明');
    return lines.join('\n');
  }
  function statusText(message) {
    const attached = state.attached[message.chatId];
    const workspaceSession = state.sessions[message.chatId]?.id || '尚未创建';
    return [`机器人：${config.botName}`, `Agent：${agentName}`, `连接：${ready ? '正常' : '重连中'}`,
      `当前任务：${active.has(message.chatId) ? '运行中' : '空闲'}`, `单条任务时限：${Math.ceil(config.turnTimeoutMs / 60_000)} 分钟`,
      ...(modes ? [`权限模式：${modeLabel(message.chatId)}`] : []),
      ...(attached
        ? [`当前会话：${attached.name}（/exit 回到 workspace）`, `会话 ID：${attached.id}`, `会话目录：${attached.cwd}`, `workspace 会话：${workspaceSession}`]
        : ['当前会话：workspace', `会话：${workspaceSession}`]),
      `工作区：${config.workspace}`].join('\n');
  }

  // ---- message handling ----
  async function handle(message, generation) {
    if (superseded(message, generation)) return;
    const text = (message.text || '').trim();
    if (text === '/new') {
      const left = state.attached[message.chatId]?.name;
      delete state.sessions[message.chatId]; delete state.attached[message.chatId]; save();
      return reply(message, `${left ? `已退出会话「${left}」。` : ''}已开启新会话，下一条消息会创建新的 ${agentName} 上下文。`, 'new');
    }
    if (text === '/exit') return exitSession(message);
    const modeQuery = commandArgs(text, '/mode');
    if (modeQuery !== null) return changeMode(message, modeQuery);
    const switchQuery = commandArgs(text, '/switch');
    if (switchQuery !== null) return switchSession(message, switchQuery, generation);
    if (!['text', 'rich'].includes(message.kind) && !(agent.capabilities.images && message.kind === 'image')) {
      return reply(message, '目前支持文字对话，请把需要处理的内容或本机文件路径用文字发给我。', 'unsupported');
    }
    if (!text && message.chatType === 'group' && message.kind === 'text') return reply(message, '我在，@我并发送问题就能开始。', 'help');
    if (!text && message.kind !== 'image') return;
    if (text.length > 40_000) return reply(message, '消息过长，请拆分后发送。', 'limit');
    if (text === '/help') return reply(message, helpText(), 'help');
    const target = chatTarget(message.chatId);
    const problem = target.kind === 'attached' && attachedProblem(target);
    if (problem) return reply(message, problem, 'blocked');
    try {
      await channel.acknowledge(message);
      if (superseded(message, generation)) return;
      const images = agent.capabilities.images && ['image', 'rich'].includes(message.kind) ? await channel.attachments(message) : [];
      if (superseded(message, generation)) return;
      if (images.length) log('images_prepared', { messageId: message.id, count: images.length });
      const result = await runAgent(message, { images, target });
      if (result && !stopping) await reply(message, result);
    } catch (error) {
      log('turn_error', { messageId: message.id, type: error.detail?.subtype || error.name });
      if (!stopping) await reply(message, error.channel ? `${where}消息发送失败，请查看本机服务日志。` : error.message, 'error').catch(() => {});
    }
  }
  function receive(message) {
    if (seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > 4000) { for (const id of [...seen].slice(0, 1000)) seen.delete(id); }
    save();
    log('message_received', { messageId: message.id, messageType: message.kind, chatType: message.chatType, chatId: message.chatId });
    const command = message.text?.trim() || '';
    if (command === '/status') { void reply(message, statusText(message), 'status').catch(logReplyError); return; }
    if (command === '/stop') {
      generations.set(message.chatId, (generations.get(message.chatId) || 0) + 1);
      const job = active.get(message.chatId);
      if (job) job.handle.cancel();
      void reply(message, job ? '已请求停止当前任务，排队消息已取消。会话上下文保留。' : '当前没有运行中的任务，排队消息已取消。', 'stop').catch(logReplyError);
      return;
    }
    if (command === '/usage') { void showUsage(message).catch(logReplyError); return; }
    // Listing only reads files, so it answers at once instead of waiting behind a running task.
    const sessionsQuery = commandArgs(command, '/sessions');
    if (sessionsQuery !== null) {
      try { void showSessions(message, sessionsQuery).catch(logReplyError); }
      catch (error) {
        log('sessions_error', { type: error.code || error.name });
        void reply(message, '读取会话列表失败，请查看本机服务日志。', 'sessions').catch(() => {});
      }
      return;
    }
    if (processingCount >= 20) {
      void reply(message, '排队消息较多，请稍后再试，或发 /stop 取消当前任务。', 'busy').catch(() => {}); return;
    }
    processingCount++; status();
    const generation = generations.get(message.chatId) || 0;
    const promise = (queues.get(message.chatId) || Promise.resolve()).catch(() => {}).then(() => handle(message, generation))
      .catch(error => log('handler_error', { type: error.name }))
      .finally(() => { processingCount--; if (queues.get(message.chatId) === promise) queues.delete(message.chatId); status(); });
    queues.set(message.chatId, promise);
  }

  return {
    start() {
      status();
      channel.start({
        message: receive,
        ready() { ready = true; status(); flushLater(); },
        closed() { ready = false; status(); },
      });
      setInterval(() => { if (!stopping && ready && state.outbox.length) flushLater(); }, 30_000).unref();
    },
    shutdown() {
      stopping = true; ready = false;
      channel.stop();
      for (const { handle } of active.values()) handle.cancel();
      save(); status();
    },
  };
}
