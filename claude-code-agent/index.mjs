// Agent adapter: local Claude Code CLI. Implements the agent interface in core/README.md, plus the
// optional features modes (/mode), usage (/usage) and sessions (/sessions, /switch, /exit).
import path from 'node:path';
import { runCliTurn, runCliQuery } from '../core/cli-turn.mjs';
import { permissionModes, permissionMode, findPermissionMode, turnArgs, recapArgs, usageArgs, recapPrompt, turnInput,
  parseEvent } from './cli.mjs';
import { claudeHome, listSessions, filterSessions, pickSession, runningSessions, sessionDigest, formatSessionList,
  timeAgo } from './sessions.mjs';

export const requiredBins = config => [config.claudeBin];

export function createAgent(config, { env }) {
  const displayName = 'Claude Code';
  const home = claudeHome(env);
  const run = (args, input, cwd, timeoutMs, onSession) =>
    runCliTurn({ bin: config.claudeBin, args, input, cwd, env, parse: parseEvent, timeoutMs, agentName: displayName, onSession });
  return {
    id: 'claude-code',
    displayName,
    capabilities: { images: true },
    runTurn: ({ sessionId, cwd, text, images = [], mode, timeoutMs, onSession }) =>
      run(turnArgs(config, sessionId, { images, mode }), turnInput(text, images), cwd, timeoutMs, onSession),
    modes: {
      descriptions: permissionModes,
      resolve: override => permissionMode(config, override),
      find: findPermissionMode,
      privateOnly: ['bypassPermissions'],
      hint: 'bypassPermissions 可简写为 bypass',
    },
    usage: () => runCliQuery({ bin: config.claudeBin, args: usageArgs(), input: '/usage', cwd: config.workspace, env, parse: parseEvent }),
    usageLabel: '查看 Claude 订阅用量和重置时间',
    sessions: {
      list: ({ exclude }) => listSessions({ home, exclude }),
      filter: filterSessions,
      pick: pickSession,
      running: () => runningSessions(home),
      digest: sessionDigest,
      format: formatSessionList,
      ago: timeAgo,
      resumeHint: id => `claude --resume ${id}`,
      // Transcripts are <id>.jsonl; a resumed session that reports a new ID lives beside the old one.
      fileFor: (file, id) => path.join(path.dirname(file), `${id}.jsonl`),
      // Never reports a session ID: the recap runs on a fork that is not saved.
      recap: ({ sessionId, cwd, timeoutMs }) => run(recapArgs(sessionId), recapPrompt, cwd, timeoutMs),
    },
  };
}
