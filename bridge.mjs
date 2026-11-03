// Entry point: reads config.json, loads the configured agent adapter (config.agent, e.g. claude-code)
// and channel adapter (config.channel, e.g. lark) and connects them through the hub.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from './core/hub.mjs';
import { loadAgent, loadChannel } from './core/registry.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const runtime = path.join(root, 'runtime');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const lockFile = path.join(runtime, 'bridge.pid');
const env = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
delete env.CODEX_THREAD_ID;
// The service may be (re)started from inside a Claude Code session; that session's identity must
// not leak into the agents spawned here.
for (const name of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN']) delete env[name];

function log(type, fields = {}) {
  // A caller's `type` field (error subtype) must not overwrite the event name.
  const { type: detail, ...rest } = fields;
  console.log(JSON.stringify({ time: new Date().toISOString(), type, ...(detail === undefined ? {} : { detail }), ...rest }));
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

const context = { root, runtime, env, log };
const agent = (await loadAgent(config)).createAgent(config, context);
const channel = (await loadChannel(config)).createChannel(config, context);
const hub = createHub({ config, agent, channel, runtime, log });

claimLock();
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  hub.shutdown();
  log('stopped', { signal });
  if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8') === String(process.pid)) fs.unlinkSync(lockFile);
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
log('started', { botName: config.botName, workspace: config.workspace, agent: agent.id, channel: channel.id });
hub.start();
