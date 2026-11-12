// Shared by agents that offer /sessions, /switch and /delete: choosing sessions from a list, the
// list text and moving a deleted session's files to the trash. A session is
// { id, name, cwd, mtimeMs, headless, named, file } (see core/README.md).
import fs from 'node:fs';
import path from 'node:path';
import { safeLabel } from './text.mjs';

// Default view: sessions started in a terminal or IDE. "all" adds scripted runs; any other text is
// a keyword matched against every session's name, directory and ID.
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
  const name = safeLabel(query).toLowerCase();
  return sessions.filter(session => session.name.toLowerCase() === name);
}

export function timeAgo(ms, now = Date.now()) {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}

// `scripted` names the agent's non-interactive command in the closing hint; `temporary` holds the
// IDs of sessions that will be deleted when their chat leaves them (/temp).
export function formatSessionList(shown, { total = shown.length, running = new Map(), current, query = '', now = Date.now(), scripted = 'claude -p', temporary = new Set() } = {}) {
  const lines = [];
  if (!shown.length) lines.push(query ? `没有找到匹配「${query}」的会话。` : '还没有可切换的会话。');
  else {
    lines.push('会话（最近活动在前）：');
    for (const [index, session] of shown.entries()) {
      const terminal = running.get(session.id);
      const marks = [session.id === current && '当前', temporary.has(session.id) && '临时', terminal && (terminal.busy ? '终端执行中' : '终端打开中'),
        session.headless && !session.named && '脚本'].filter(Boolean);
      lines.push(`${index + 1}. ${session.name} · ${session.cwd} · ${timeAgo(session.mtimeMs, now)}${marks.map(mark => ' · ' + mark).join('')}`);
    }
    if (total > shown.length) lines.push(`另有 ${total - shown.length} 个更早的会话，可用 /sessions 关键词 筛选。`);
  }
  lines.push('', `发送 /switch 编号 切换会话，/new 开新会话；/sessions all 还会列出未命名的脚本（${scripted}）会话。`);
  return lines.join('\n');
}

function move(from, to) {
  try { fs.renameSync(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

// Moves a session's files (those of `items` that exist) into a new folder under trashRoot and
// writes restore.json there, which says where to move them back. Returns { trash, restoreTo }.
export function trashFiles(session, items, trashRoot) {
  const restoreTo = path.dirname(session.file);
  const target = path.join(trashRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-${session.id}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(target, 'restore.json'), JSON.stringify({ id: session.id, name: session.name, cwd: session.cwd,
    restoreTo, deletedAt: new Date().toISOString() }, null, 2) + '\n');
  for (const item of items) if (fs.existsSync(item)) move(item, path.join(target, path.basename(item)));
  return { trash: target, restoreTo };
}
