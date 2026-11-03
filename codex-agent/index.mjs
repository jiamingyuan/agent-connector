// Agent adapter: local Codex CLI. Text only; implements just the required part of the agent
// interface in core/README.md.
import path from 'node:path';
import { runCliTurn } from '../core/cli-turn.mjs';

// Codex CLI arguments: workspace sandbox, no approval prompts, exact-session resume.
export function codexArgs(config, sessionId, outputFile) {
  const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
    '--enable', 'skip_host_skill_discovery',
    '-c', 'approval_policy="never"', '-C', config.workspace, '-o', outputFile];
  if (sessionId) args.push('resume', sessionId, '-');
  else args.push('-');
  return args;
}

export const requiredBins = config => [config.codexBin];

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
    capabilities: { images: false },
    runTurn({ sessionId, text, timeoutMs, onSession, turnKey }) {
      // Codex writes its final answer to a file instead of the event stream.
      const outputFile = path.join(runtime, `${turnKey}.txt`);
      return runCliTurn({ bin: config.codexBin, args: codexArgs(config, sessionId, outputFile), input: text,
        cwd: config.workspace, env, parse: parseEvent, outputFile, timeoutMs, agentName: 'Codex', onSession });
    },
  };
}
