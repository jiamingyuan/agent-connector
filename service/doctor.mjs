// `node service.mjs doctor`: checks the environment and the parts of other tools' formats this
// bridge depends on, so a CLI upgrade that breaks something shows up here instead of silently.
// Prints no configuration values, message content or session content.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentId, channelId, loadAgent, loadChannel } from '../core/registry.mjs';

// Versions the current code was last verified against (see pjkp/ version records).
export const TESTED = { 'claude-code': '2.1.319', 'lark-cli': '1.0.98' };

function version(bin) {
  try { return /\d+\.\d+\.\d+/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }))?.[0] || '?'; }
  catch { return null; }
}

export async function runDoctor({ root, backend, print = console.log }) {
  let failures = 0;
  const ok = text => print(`✓ ${text}`);
  const warn = text => print(`⚠ ${text}`);
  const fail = text => { failures++; print(`✗ ${text}`); };

  print(`Platform: ${process.platform}, Node.js ${process.versions.node}, service mode: ${backend}`);
  if (Number(process.versions.node.split('.')[0]) < 20) fail('Node.js 20 or newer is required');
  if (!['linux', 'darwin'].includes(process.platform)) fail('Supported platforms are Linux and macOS (Windows through WSL)');

  const configFile = path.join(root, 'config.json');
  if (!fs.existsSync(configFile)) { fail('config.json is missing'); return 1; }
  let config;
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { fail('config.json is not valid JSON'); return 1; }
  let agentModule, channelModule;
  try { agentModule = await loadAgent(config); channelModule = await loadChannel(config); ok(`agent ${agentId(config)}, channel ${channelId(config)}`); }
  catch (error) { fail(error.message); return 1; }

  for (const bin of [...channelModule.requiredBins(config), ...agentModule.requiredBins(config)]) {
    try { fs.accessSync(bin, fs.constants.X_OK); } catch { fail(`not executable: ${bin}`); continue; }
    const name = /lark/i.test(path.basename(bin)) ? 'lark-cli' : /claude/i.test(path.basename(bin)) ? 'claude-code' : path.basename(bin);
    const found = version(bin);
    if (!found) warn(`${bin}: --version failed`);
    else if (TESTED[name] && found !== TESTED[name]) warn(`${name} ${found}; this code was last verified with ${TESTED[name]}, check images, /sessions and /usage after upgrading`);
    else ok(`${name} ${found}`);
  }

  try {
    fs.mkdirSync(config.workspace, { recursive: true });
    fs.accessSync(config.workspace, fs.constants.W_OK);
    ok('workspace is writable');
  } catch { fail('workspace is missing or not writable'); }

  // Claude Code's session files are internal formats; check they still parse.
  if (agentId(config) === 'claude-code') {
    const agent = agentModule.createAgent(config, { root, runtime: path.join(root, 'runtime'), env: process.env, log() {} });
    const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '', '.claude'), 'projects');
    let transcripts = 0;
    try { for (const dir of fs.readdirSync(projects)) transcripts += fs.readdirSync(path.join(projects, dir)).filter(name => name.endsWith('.jsonl')).length; }
    catch { /* no projects yet */ }
    const sessions = agent.sessions.list({ exclude: [] });
    if (transcripts && !sessions.length) fail(`Claude Code session records found (${transcripts}) but none could be read: the format may have changed; /sessions and /switch will be empty`);
    else ok(`Claude Code sessions readable: ${sessions.length} of ${transcripts} records have a conversation`);
    const running = agent.sessions.running();
    ok(`terminal status readable: ${running.size} running Claude Code session(s)`);
  }

  print(failures ? `${failures} problem(s) found.` : 'No problems found.');
  return failures ? 1 : 0;
}
