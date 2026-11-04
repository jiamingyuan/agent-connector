// Runs one agent turn as a child CLI process that prints JSON lines. Shared by CLI-based agent
// adapters (Claude Code, Codex); an adapter only supplies the command, the stdin input and a
// parser that turns each JSON event into { ready, sessionId, completed, failed, text, errorText }.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class TurnError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function terminate(child) {
  try { process.kill(-child.pid, 'SIGTERM'); }
  catch { child.kill('SIGTERM'); }
}

// Returns { cancel(), result }. result resolves to the final text, or null after cancel();
// it rejects with TurnError code 'startup' | 'timeout' | 'failed'.
export function runCliTurn({ bin, args, input, cwd, env, parse, outputFile, timeoutMs, startupTimeoutMs = 120_000,
  agentName, onSession }) {
  const child = spawn(bin, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const job = { cancelled: false, timedOut: false, startupFailed: false };
  const startupTimer = setTimeout(() => { job.startupFailed = true; terminate(child); }, startupTimeoutMs);
  const timer = setTimeout(() => { job.timedOut = true; terminate(child); }, timeoutMs);
  const result = new Promise((resolve, reject) => {
    let completed = false, failure = null, resultText = '', errorText = '';
    createInterface({ input: child.stdout }).on('line', line => {
      let item;
      try { item = JSON.parse(line); } catch { return; }
      const update = parse(item);
      if (update.ready) clearTimeout(startupTimer);
      if (update.sessionId) onSession?.(update.sessionId);
      if (update.completed) completed = true;
      if (update.failed) { completed = false; failure = 'turn.failed'; }
      if (update.text !== undefined) resultText = update.text;
      // The first reason is the specific one (e.g. an API error); the final result only repeats it.
      if (update.errorText) errorText ||= update.errorText;
    });
    // Never persist raw model/tool events or credentials to the service log.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', error => { failure = error.message; });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(startupTimer);
      let text = resultText.trim();
      if (outputFile && fs.existsSync(outputFile)) { text = fs.readFileSync(outputFile, 'utf8').trim(); fs.unlinkSync(outputFile); }
      if (job.cancelled) return resolve(null);
      if (job.startupFailed) return reject(new TurnError('startup', `${agentName} 初始化超过两分钟，已停止。请查看本机服务状态后重试。`));
      if (job.timedOut) return reject(new TurnError('timeout', `任务超过 ${Math.ceil(timeoutMs / 60_000)} 分钟已停止。已完成的操作不会自动撤销，可以分批继续。`));
      if (code !== 0 || !completed || !text) {
        const error = new TurnError('failed', errorText
          ? `${agentName} 本轮没有完成：${errorText}。会话上下文仍保留。`
          : `${agentName} 本轮运行失败，已有会话仍保留。请稍后重试；服务端可查看 runtime/bridge.log。`);
        error.exitCode = code; error.hasFailure = Boolean(failure); error.completed = completed;
        return reject(error);
      }
      resolve(text);
    });
  });
  return { cancel() { job.cancelled = true; terminate(child); }, result };
}

// Runs a CLI once and returns its result text, for non-turn queries such as /usage.
export function runCliQuery({ bin, args, input, cwd, env, parse, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    let text;
    createInterface({ input: child.stdout }).on('line', line => {
      try { const update = parse(JSON.parse(line)); if (update.text !== undefined) text = update.text; } catch { /* diagnostics */ }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && text?.trim()) resolve(text.trim()); else reject(new Error(`query exited ${code}`));
    });
  });
}
