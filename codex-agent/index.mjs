// Agent adapter: local Codex CLI. Text only; implements the required part of the agent interface in
// core/README.md, plus models (/model) and efforts (/effort).
import path from 'node:path';
import { runCliTurn } from '../core/cli-turn.mjs';

// Codex CLI arguments: workspace sandbox, no approval prompts, exact-session resume.
// The chat's /model and /effort choices are passed as -m and model_reasoning_effort (not verified
// with a real Codex); without them Codex uses its own configuration.
export function codexArgs(config, sessionId, outputFile, { model, effort } = {}) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
    '--enable', 'skip_host_skill_discovery',
    '-c', 'approval_policy="never"', '-C', config.workspace, '-o', outputFile];
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (sessionId) args.push('resume', sessionId, '-');
  else args.push('-');
  return args;
}

export const requiredBins = config => [config.codexBin];

export const effortLevels = { minimal: '几乎不思考，最快', low: '思考较少', medium: '适中', high: '思考较多，较慢' };
// Codex model names change often, so any plain model name is accepted and Codex reports a wrong one.
const findModel = name => (/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(String(name || '').trim()) ? String(name).trim() : null);
const findEffort = name => Object.keys(effortLevels).find(level => level === String(name || '').trim().toLowerCase()) || null;

export function parseEvent(event) {
  if (event.type === 'thread.started') return { ready: true, sessionId: event.thread_id };
  if (event.type === 'turn.completed') return { completed: true };
  if (event.type === 'turn.failed') return { failed: true };
  return {};
}

export function createAgent(config, { env, runtime }) {
  return {
    id: 'codex',
    displayName: 'Codex',
    // Received files are saved in the workspace, which Codex can read; not verified with a real Codex.
    capabilities: { images: false, files: true },
    runTurn({ sessionId, text, timeoutMs, onSession, turnKey, model, effort }) {
      // Codex writes its final answer to a file instead of the event stream.
      const outputFile = path.join(runtime, `${turnKey}.txt`);
      return runCliTurn({ bin: config.codexBin, args: codexArgs(config, sessionId, outputFile, { model, effort }), input: text,
        cwd: config.workspace, env, parse: parseEvent, outputFile, timeoutMs, agentName: 'Codex', onSession });
    },
    models: { descriptions: {}, resolve: override => override, find: findModel, hint: '写 Codex 支持的模型名' },
    efforts: { descriptions: effortLevels, resolve: override => override, find: findEffort },
  };
}
