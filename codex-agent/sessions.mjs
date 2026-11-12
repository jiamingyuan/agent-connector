// Read-only catalog of this machine's Codex sessions, used by /sessions, /switch and /usage.
// It reads Codex's own files: the session records $CODEX_HOME/sessions/YYYY/MM/DD/
// rollout-<time>-<session id>.jsonl (older ones compressed to .jsonl.zst) and the name index
// session_index.jsonl. Both are internal formats (read from the source of Codex 0.167.2, not yet
// checked against a real Codex), so every read is best-effort: an unreadable or changed file only
// hides that session or its details.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { clip, safeLabel } from '../core/text.mjs';
import { trashFiles } from '../core/session-list.mjs';

const recordName = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(?:\.zst)?$/i;
const bridgeNotes = /\n\n\[(?:桥接|飞书)[^\]\n]*\][\s\S]*$/u;
const cache = new Map();

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function readText(file) {
  if (!file.endsWith('.zst')) return fs.readFileSync(file, 'utf8');
  // Node.js 22.15 and later; without it compressed sessions are not listed.
  if (!zlib.zstdDecompressSync) throw new Error('zstd is not available in this Node.js');
  return zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
}

// Lines are { timestamp, type, payload }. Model inputs and tool output (response_item) make up most
// of a record and are not needed here, so those lines are skipped without parsing them.
function* entries(file) {
  for (const line of readText(file).split('\n')) {
    if (!line || line.slice(0, 160).includes('"type":"response_item"')) continue;
    try { yield JSON.parse(line); } catch { /* a line Codex is still writing */ }
  }
}

// Plan limits as Codex reports them with each answer: share used (0-1) and reset time (epoch
// seconds) per window. The short window fills the hub's five-hour slot, the long one the weekly slot.
function quotaOf(limits) {
  const window = item => (item && Number.isFinite(item.used_percent)
    ? { used: item.used_percent / 100, resetsAt: item.resets_at ?? undefined, minutes: item.window_minutes ?? undefined } : undefined);
  const windows = [window(limits?.primary), window(limits?.secondary)].filter(Boolean);
  if (!windows.length) return undefined;
  const short = windows.find(item => !item.minutes || item.minutes <= 1440), long = windows.find(item => item.minutes > 1440);
  return { fiveHour: short, sevenDay: long };
}

function inspect(file, id) {
  const { size, mtimeMs } = fs.statSync(file);
  const cached = cache.get(file);
  if (cached?.size === size && cached.mtimeMs === mtimeMs) return cached.facts;
  const facts = { id, file, mtimeMs, cwd: '', source: '', child: false, firstPrompt: '', lastPrompt: '', lastReply: '', replies: 0 };
  for (const { type, payload, timestamp } of entries(file)) {
    if (!payload || typeof payload !== 'object') continue;
    if (type === 'session_meta') {
      if (typeof payload.cwd === 'string') facts.cwd ||= payload.cwd;
      // A sub-agent's record names its parent, or carries an object as its source.
      facts.child ||= Boolean(payload.parent_thread_id) || (payload.source !== undefined && typeof payload.source !== 'string') || payload.thread_source === 'subagent';
      if (typeof payload.source === 'string') facts.source ||= payload.source;
    } else if (type === 'turn_context') {
      if (typeof payload.model === 'string') facts.model = payload.model;
    } else if (type === 'event_msg') {
      if (payload.type === 'user_message' && typeof payload.message === 'string') {
        const text = payload.message.replace(bridgeNotes, '').trim();
        if (text) { facts.firstPrompt ||= text; facts.lastPrompt = text; }
      } else if (payload.type === 'agent_message' && typeof payload.message === 'string' && payload.message.trim()) {
        facts.replies++; facts.lastReply = payload.message.trim();
      } else if (payload.type === 'token_count') {
        const last = payload.info?.last_token_usage;
        if (Number.isFinite(last?.input_tokens)) facts.context = last.input_tokens;
        const quota = quotaOf(payload.rate_limits);
        if (quota) { facts.quota = quota; facts.quotaAt = Date.parse(timestamp) || mtimeMs; }
      }
    }
  }
  cache.set(file, { size, mtimeMs, facts });
  return facts;
}

// Every session record under <home>/sessions, as { file, id }.
function records(home) {
  const found = [];
  const walk = (dir, depth) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (item.isDirectory()) { if (depth < 3) walk(path.join(dir, item.name), depth + 1); continue; }
      const id = recordName.exec(item.name)?.[1];
      if (id) found.push({ file: path.join(dir, item.name), id: id.toLowerCase() });
    }
  };
  walk(path.join(home, 'sessions'), 0);
  return found;
}

// Names given in Codex itself (/rename there): the last entry for a session wins.
function codexNames(home) {
  const names = new Map();
  try {
    for (const line of fs.readFileSync(path.join(home, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!line) continue;
      try { const entry = JSON.parse(line); if (typeof entry.id === 'string' && typeof entry.thread_name === 'string') names.set(entry.id.toLowerCase(), entry.thread_name); } catch { /* partial line */ }
    }
  } catch { /* no index yet */ }
  return names;
}

function inspectAll(home) {
  const byId = new Map();
  for (const { file, id } of records(home)) {
    try {
      const facts = inspect(file, id);
      // A reverted session has several records; the latest one is the session.
      if (!byId.has(id) || byId.get(id).mtimeMs < facts.mtimeMs) byId.set(id, facts);
    } catch { /* removed or unreadable while listing */ }
  }
  return [...byId.values()];
}

// Sessions with at least one exchange, most recently active first. `names` holds the names given
// through the bridge (session ID -> name); they come before Codex's own.
export function listSessions({ home = codexHome(), exclude = [], names = {} } = {}) {
  const skipped = new Set(exclude.map(dir => path.resolve(dir)));
  const own = codexNames(home);
  const sessions = [];
  for (const facts of inspectAll(home)) {
    if (facts.child || !facts.firstPrompt || !facts.replies || !facts.cwd || skipped.has(path.resolve(facts.cwd))) continue;
    const given = names[facts.id] || own.get(facts.id) || '';
    sessions.push({ id: facts.id, file: facts.file, cwd: facts.cwd, mtimeMs: facts.mtimeMs, headless: facts.source === 'exec', named: Boolean(given),
      name: safeLabel(given || facts.firstPrompt.split('\n')[0]) || facts.id.slice(0, 8) });
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const factsOf = file => { try { return file ? inspect(file, recordName.exec(path.basename(file))?.[1]?.toLowerCase()) : {}; } catch { return {}; } };

// Model and context size as of the session's last answer, for the reply header after /switch.
export function sessionStats(file) {
  const { model, context } = factsOf(file);
  return { ...(model ? { model } : {}), ...(Number.isFinite(context) ? { context } : {}) };
}

// Last prompt and reply, used when the model-written recap is unavailable.
export function sessionDigest(file, max = 240) {
  const { lastPrompt = '', lastReply = '' } = factsOf(file);
  return { prompt: clip(lastPrompt, max), reply: clip(lastReply, max) };
}

// A short name for a session nobody named, taken from its first prompt.
export function promptName(file) {
  return safeLabel((factsOf(file).firstPrompt || '').split('\n')[0], 30);
}

// The record of one session (the latest, when it was reverted and has several), or undefined.
export function recordFile(home, id) {
  return records(home).filter(record => record.id === String(id).toLowerCase())
    .map(record => record.file).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

// What the event stream of a turn does not carry, read from the session's record afterwards.
export function turnStats(home, id) {
  const file = recordFile(home, id);
  if (!file) return {};
  const { model, context, quota } = factsOf(file);
  return { ...(model ? { model } : {}), ...(Number.isFinite(context) ? { context } : {}), ...(quota ? { quota } : {}) };
}

// /usage: Codex reports plan limits only with an answer, so this is the latest report found in the
// session records. No model call is made.
export function usageText(home = codexHome(), now = Date.now()) {
  const latest = inspectAll(home).filter(facts => facts.quota).sort((a, b) => b.quotaAt - a.quotaAt)[0];
  if (!latest) return '还没有 Codex 的用量数据：Codex 只在回答时报告额度，先发一条消息再查。';
  const label = item => (!item.minutes ? '额度' : item.minutes % 1440 === 0 ? `${item.minutes / 1440} 天额度` : item.minutes % 60 === 0 ? `${item.minutes / 60} 小时额度` : `${item.minutes} 分钟额度`);
  const line = item => `${label(item)}：已用 ${Math.round(item.used * 100)}%${item.resetsAt ? `，${new Date(item.resetsAt * 1000).toISOString().slice(5, 16).replace('T', ' ')} UTC 重置` : ''}`;
  const minutes = Math.max(0, Math.round((now - latest.quotaAt) / 60_000));
  return [...[latest.quota.fiveHour, latest.quota.sevenDay].filter(Boolean).map(line),
    `数据来自 Codex 最近一次回答（${minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`}），之后的消耗未计入。`].join('\n');
}

// Deleting moves the session record into the trash, so it leaves /sessions here. restore.json says
// where to move it back.
export function trashSession(session, trashRoot) {
  const moved = trashFiles(session, [session.file], trashRoot);
  cache.delete(session.file);
  return moved;
}
