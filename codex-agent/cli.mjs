// Codex CLI protocol: `codex exec` arguments and its JSON events. Written against the source of
// Codex 0.167.2 (codex-rs/exec/src/cli.rs, exec_events.rs); not yet run against a real Codex.
import fs from 'node:fs';
import path from 'node:path';

// Modes selectable in config (codexMode) or with /mode. Nobody is there to answer a prompt, so
// every mode decides by itself what happens to an operation that would need approval.
export const sandboxModes = {
  'read-only': '只读：可以看文件和调研，不改文件、不执行会改动系统的命令',
  'workspace-write': '可以改会话目录内的文件；目录之外的写入和联网命令会被拒绝',
  'auto-review': '同 workspace-write，超出范围的操作交给 Codex 的自动审查逐个判断',
  'danger-full-access': '不设沙箱，可以不经确认执行任何操作，风险最高',
};
const aliases = { readonly: 'read-only', write: 'workspace-write', auto: 'auto-review', full: 'danger-full-access' };

// The chat's /mode choice if any, else the configured default, else workspace-write.
export function sandboxMode(config, override) {
  const mode = override || config.codexMode || 'workspace-write';
  if (!Object.hasOwn(sandboxModes, mode)) throw new Error('Unsupported Codex mode');
  return mode;
}
export function findSandboxMode(name) {
  const value = String(name || '').trim().toLowerCase();
  return Object.hasOwn(sandboxModes, value) ? value : aliases[value] || null;
}
function modeArgs(mode) {
  // --approve-for-me sets the workspace-write sandbox and routes approvals to the automatic reviewer.
  if (mode === 'auto-review') return ['--approve-for-me'];
  return ['--sandbox', mode, '-c', 'approval_policy="never"'];
}

export const effortLevels = { minimal: '几乎不思考，最快', low: '思考较少', medium: '适中', high: '思考较多，较慢', xhigh: '思考最多，最慢' };
// Codex model names change often, so any plain model name is accepted and Codex reports a wrong one.
export const findModel = name => (/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(String(name || '').trim()) ? String(name).trim() : null);
export const findEffort = name => Object.keys(effortLevels).find(level => level === String(name || '').trim().toLowerCase()) || null;

// A -c value is TOML; a JSON string is also a valid TOML basic string.
const toml = text => JSON.stringify(text);
const outside = (dir, base) => { const relative = path.relative(base, dir); return relative.startsWith('..') || path.isAbsolute(relative); };

// The bridge's own instructions (workspace/AGENTS.md) for a session that runs in another directory,
// where Codex does not find the file by itself. A long file is not passed on the command line.
export function instructionsArg(file) {
  if (!file) return [];
  let text;
  try { text = fs.readFileSync(file, 'utf8').trim(); } catch { return []; }
  if (!text) return [];
  return ['-c', `developer_instructions=${toml(text.length <= 12_000 ? text : `Before answering, read and follow the instructions in ${file}.`)}`];
}

// One turn. The session runs in `cwd` (the bridge workspace when none is given); files received
// from the user and the outbox live in the workspace and are opened up with --add-dir.
// Options come before the `resume` subcommand, and the images before another option: -i takes
// several values and would otherwise take the prompt marker "-" as one more image.
export function codexArgs(config, sessionId, outputFile, { model, effort, mode, cwd, images = [], files = [], outbox, instructionsFile } = {}) {
  const dir = cwd || config.workspace;
  const args = ['exec', '--json', '--skip-git-repo-check', ...modeArgs(sandboxMode(config, mode)), '--enable', 'skip_host_skill_discovery'];
  for (const image of images) args.push('-i', image.path);
  args.push('-C', dir, '-o', outputFile);
  const extra = [...new Set([...files.map(file => path.dirname(file.path)), ...(outbox ? [outbox] : [])])].filter(item => outside(item, dir));
  for (const item of extra) args.push('--add-dir', item);
  if (model || config.codexModel) args.push('-m', model || config.codexModel);
  if (effort || config.codexEffort) args.push('-c', `model_reasoning_effort="${effort || config.codexEffort}"`);
  args.push(...instructionsArg(instructionsFile));
  if (sessionId) args.push('resume', sessionId, '-');
  else args.push('-');
  return args;
}

// Recap for /switch: a fork of the chosen session that is never written to disk and cannot change
// files, so the original record stays exactly as it was.
export function recapArgs(config, sessionId, outputFile, cwd) {
  return ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-c', 'approval_policy="never"',
    '-C', cwd || config.workspace, '-o', outputFile, 'fork', sessionId, '-'];
}

export const recapPrompt = `[桥接：前情梗概]
用户刚在聊天里切换到这个会话，准备接着用。请只根据本会话已有的上下文，用简体中文写一份前情梗概：
- 目标：这个会话在做什么
- 进展：已完成的关键工作和结论
- 现状：停在哪里，有没有等用户决定的事
- 下一步：建议接着做什么
控制在 300 字以内，用简短列表。不要执行命令，也不要开始新的工作。`;

const count = value => (Number.isFinite(value) ? value : 0);
const reason = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);

// `after(threadId)` may add what the event stream does not carry (model, context size, plan
// limits), read from the session record once the turn is over.
export function parseEvent(event, after) {
  if (event.type === 'thread.started') return { ready: true, sessionId: event.thread_id };
  if (event.type === 'turn.started') return { ready: true };
  // The last agent message is the answer; `-o` writes the same text to the output file.
  if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') return { text: event.item.text };
  if (event.type === 'turn.completed') {
    const usage = event.usage || {};
    const cached = count(usage.cached_input_tokens);
    const turn = { output: count(usage.output_tokens), newInput: Math.max(0, count(usage.input_tokens) - cached), cacheRead: cached };
    const stats = { ...(after?.() || {}), ...(turn.output || turn.newInput || turn.cacheRead ? { turn } : {}) };
    return { completed: true, ...(Object.keys(stats).length ? { stats } : {}) };
  }
  if (event.type === 'turn.failed') return { failed: true, ...(event.error?.message ? { errorText: reason(event.error.message) } : {}) };
  if (event.type === 'error' && event.message) return { errorText: reason(event.message) };
  return {};
}
