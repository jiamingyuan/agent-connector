import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexArgs } from './codex-agent/args.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const reportFile = path.join(root, 'runtime/backend-selftest.json');
let sessionId;
const startedAt = new Date().toISOString();
function report(fields) { fs.writeFileSync(reportFile, JSON.stringify({ startedAt, ...fields }, null, 2), { mode: 0o600 }); }
function turn(prompt, resume) {
  const output = path.join(root, 'runtime/backend-selftest-output.txt');
  return new Promise((resolve, reject) => {
    const child = spawn(config.codexBin, codexArgs(config, resume, output), { cwd: config.workspace, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      for (const line of stdout.split('\n')) {
        try { const event = JSON.parse(line); if (event.type === 'thread.started') sessionId = event.thread_id; } catch { /* diagnostics */ }
      }
      if (code !== 0) return reject(new Error(`exit=${code}, diagnostic=${stderr.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')}`));
      const answer = fs.readFileSync(output, 'utf8').trim();
      fs.unlinkSync(output);
      resolve(answer);
    });
  });
}

report({ stage: 'first_turn' });
try {
  const first = await turn('这是飞书后台服务的最小测试。请记住测试口令 FS_CODEX_7824；不要调用工具，只回复 OK。');
  report({ stage: 'resume_turn', first, sessionId });
  const second = await turn('只回复上一轮要求你记住的测试口令，不要调用任何工具。', sessionId);
  report({ stage: 'complete', ok: first === 'OK' && second === 'FS_CODEX_7824', first, second, sessionId });
} catch (error) {
  report({ stage: 'failed', ok: false, error: error.message }); process.exitCode = 1;
}
