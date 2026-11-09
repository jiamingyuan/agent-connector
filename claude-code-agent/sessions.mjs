// Read-only catalog of this machine's Claude Code sessions, used by /sessions and /switch.
// It reads Claude Code's own files: projects/<encoded cwd>/<session id>.jsonl transcripts and the
// sessions/<pid>.json registry of running CLIs. Both are internal formats, so every read is
// best-effort: an unreadable or changed file only hides that session or its terminal status.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clip, safeLabel } from '../core/text.mjs';

const transcriptName = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const bridgeNotes = /\n\n\[(?:桥接|飞书)[^\]\n]*\][\s\S]*$/u;
const injectedText = /^<(?:command-|local-command|bash-|system-reminder|task-notification)/;
const cache = new Map();

export function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Names are shown in bold Markdown headers and one-line lists.
export const sessionLabel = safeLabel;

// What the user typed in a turn. Tool results, slash-command wrappers and the notes this bridge
// appends to Feishu messages are not prompts.
export function promptText(entry) {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain || entry.message?.role !== 'user') return '';
  const content = entry.message.content;
  if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) return '';
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n') : '';
  const cleaned = text.replace(bridgeNotes, '').trim();
  return injectedText.test(cleaned) ? '' : cleaned;
}

function replyText(entry) {
  if (entry?.type !== 'assistant' || entry.isSidechain) return '';
  const content = entry.message?.content;
  if (typeof content === 'string') return content.trim();
  return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('\n').trim() : '';
}

function* entries(file) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* a line the CLI is still writing */ }
  }
}

function inspect(folder, name) {
  const file = path.join(folder, name);
  const { size, mtimeMs } = fs.statSync(file);
  const cached = cache.get(file);
  if (cached?.size === size && cached.mtimeMs === mtimeMs) return cached.session;
  let customTitle = '', agentName = '', aiTitle = '', firstPrompt = '', entrypoint = '', replies = 0;
  const cwds = [];
  for (const entry of entries(file)) {
    if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle;
    else if (entry.type === 'agent-name' && entry.agentName) agentName = entry.agentName;
    else if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle;
    else if (entry.type === 'assistant' && !entry.isSidechain) replies++;
    else if (entry.type === 'user' && !entry.isSidechain) {
      if (typeof entry.cwd === 'string' && cwds.length < 50 && !cwds.includes(entry.cwd)) cwds.push(entry.cwd);
      if (!entrypoint && typeof entry.entrypoint === 'string') entrypoint = entry.entrypoint;
      firstPrompt ||= promptText(entry);
    }
  }
  // Claude Code files a transcript under its launch directory with every non-alphanumeric character
  // replaced by "-"; later entries may record subdirectories the session moved into.
  const cwd = cwds.find(dir => dir.replace(/[^a-zA-Z0-9]/g, '-') === path.basename(folder)) || cwds[0];
  const id = transcriptName.exec(name)[1].toLowerCase();
  const session = firstPrompt && replies && cwd ? {
    id, file, cwd, mtimeMs, headless: entrypoint.startsWith('sdk'), named: Boolean(customTitle || agentName || aiTitle),
    name: sessionLabel(customTitle || agentName || aiTitle || firstPrompt.split('\n')[0]) || id.slice(0, 8),
  } : null;
  cache.set(file, { size, mtimeMs, session });
  return session;
}

// Sessions with at least one exchange, most recently active first.
export function listSessions({ home = claudeHome(), exclude = [] } = {}) {
  const projects = path.join(home, 'projects');
  const skipped = new Set(exclude.map(dir => path.resolve(dir)));
  const sessions = [];
  let folders = [];
  try { folders = fs.readdirSync(projects, { withFileTypes: true }).filter(item => item.isDirectory()); } catch { return sessions; }
  for (const folder of folders) {
    const dir = path.join(projects, folder.name);
    let names = [];
    try { names = fs.readdirSync(dir).filter(name => transcriptName.test(name)); } catch { continue; }
    for (const name of names) {
      try {
        const session = inspect(dir, name);
        if (session && !skipped.has(path.resolve(session.cwd))) sessions.push(session);
      } catch { /* removed or unreadable while listing */ }
    }
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Default view: sessions started in a terminal or IDE. "all" adds scripted `claude -p` runs;
// any other text is a keyword matched against every session's name, directory and ID.
export function filterSessions(sessions, query = '', { include = [] } = {}) {
  const value = query.trim().toLowerCase();
  if (value === 'all' || value === '全部') return sessions;
  // Default view: interactive sessions, named ones (the bridge names its own sessions) and any listed in include.
  if (!value) return sessions.filter(session => !session.headless || session.named || include.includes(session.id));
  return sessions.filter(session => [session.name, session.cwd, session.id].some(field => field.toLowerCase().includes(value)));
}

// A number refers to the chat's last list; otherwise an ID prefix or an exact session name.
export function pickSession(sessions, query, listed = []) {
  const value = query.trim().toLowerCase();
  if (/^\d+$/.test(value)) return sessions.filter(session => session.id === listed[Number(value) - 1]);
  if (/^[0-9a-f-]{6,}$/.test(value)) {
    const byId = sessions.filter(session => session.id.startsWith(value));
    if (byId.length) return byId;
  }
  const name = sessionLabel(query).toLowerCase();
  return sessions.filter(session => session.name.toLowerCase() === name);
}

function move(from, to) {
  try { fs.renameSync(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// Deleting moves the transcript and its <id>/ folder (titles, subagent transcripts) into the trash,
// so it leaves both /sessions and the terminal's /resume. restore.json says where to move them back.
export function trashSession(session, trashRoot) {
  const folder = path.dirname(session.file);
  const target = path.join(trashRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${session.id}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(target, 'restore.json'), JSON.stringify({ id: session.id, name: session.name, cwd: session.cwd,
    restoreTo: folder, deletedAt: new Date().toISOString() }, null, 2) + '\n');
  for (const item of [session.file, path.join(folder, session.id)]) if (fs.existsSync(item)) move(item, path.join(target, path.basename(item)));
  cache.delete(session.file);
  return { trash: target, restoreTo: folder };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Sessions currently open in a running CLI. Only sessions/<pid>.json is opened, never the
// *.key files beside it.
export function runningSessions(home = claudeHome()) {
  const running = new Map();
  const dir = path.join(home, 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter(name => /^\d+\.json$/.test(name)); } catch { return running; }
  for (const name of names) {
    try {
      const { pid, sessionId, status } = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0 || typeof sessionId !== 'string' || !alive(pid)) continue;
      const busy = typeof status === 'string' && status !== 'idle';
      running.set(sessionId, { pid, busy: busy || Boolean(running.get(sessionId)?.busy) });
    } catch { /* stale or partially written entry */ }
  }
  return running;
}

// Last prompt and reply, used when the model-written recap is unavailable.
export function sessionDigest(file, max = 240) {
  let prompt = '', reply = '';
  for (const entry of entries(file)) {
    prompt = promptText(entry) || prompt;
    reply = replyText(entry) || reply;
  }
  return { prompt: clip(prompt, max), reply: clip(reply, max) };
}

export function timeAgo(ms, now = Date.now()) {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

export function formatSessionList(shown, { total = shown.length, running = new Map(), current, query = '', now = Date.now() } = {}) {
  const lines = [];
  if (!shown.length) lines.push(query ? `没有找到匹配「${query}」的会话。` : '还没有可切换的会话。');
  else {
    lines.push('会话（最近活动在前）：');
    for (const [index, session] of shown.entries()) {
      const terminal = running.get(session.id);
      const marks = [session.id === current && '当前', terminal && (terminal.busy ? '终端执行中' : '终端打开中'),
        session.headless && !session.named && '脚本'].filter(Boolean);
      lines.push(`${index + 1}. ${session.name} · ${session.cwd} · ${timeAgo(session.mtimeMs, now)}${marks.map(mark => ' · ' + mark).join('')}`);
    }
    if (total > shown.length) lines.push(`另有 ${total - shown.length} 个更早的会话，可用 /sessions 关键词 筛选。`);
  }
  lines.push('', '发送 /switch 编号 切换会话，/new 开新会话；/sessions all 还会列出未命名的脚本（claude -p）会话。');
  return lines.join('\n');
}
