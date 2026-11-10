// Agent adapter: local Claude Code CLI. Implements the agent interface in core/README.md, plus the
// optional features modes (/mode), usage (/usage), compact (/compact), rename (/rename) and sessions
// (/sessions, /switch, /delete).
import path from 'node:path';
import { runCliTurn, runCliQuery } from '../core/cli-turn.mjs';
import { permissionModes, permissionMode, findPermissionMode, turnArgs, recapArgs, usageArgs, recapPrompt, turnInput,
  parseEvent, compactArgs, compactInput, parseCompactEvent, renameArgs, renameInput, parseRenameEvent } from './cli.mjs';
import { claudeHome, listSessions, filterSessions, pickSession, runningSessions, sessionDigest, formatSessionList,
  timeAgo, trashSession, sessionStats } from './sessions.mjs';

export const requiredBins = config => [config.claudeBin];

// Claude Code hides sessions whose recorded entrypoint is sdk-cli (what `claude -p` writes) from the
// terminal /resume picker; any other preset value is kept (checked on 2.1.319). Naming the bridge as
// the entrypoint keeps the sessions it creates listed there.
export const ENTRYPOINT = 'agent-connector';

export function createAgent(config, { env: baseEnv }) {
  const env = { ...baseEnv, CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT };
  const displayName = 'Claude Code';
  const home = claudeHome(env);
  const run = (args, input, cwd, timeoutMs, onSession, onStats) =>
    runCliTurn({ bin: config.claudeBin, args, input, cwd, env, parse: parseEvent, timeoutMs, agentName: displayName, onSession, onStats });
  return {
    id: 'claude-code',
    displayName,
    capabilities: { images: true, files: true },
    runTurn: ({ sessionId, cwd, text, images = [], files = [], outbox, instructionsFile, mode, timeoutMs, onSession, onStats }) => {
      // The effort is whatever the bridge passes (--effort); Claude Code does not report it.
      if (config.claudeEffort) onStats?.({ effort: config.claudeEffort });
      return run(turnArgs(config, sessionId, { images, mode, files, cwd, outbox, instructionsFile }), turnInput(text, images), cwd, timeoutMs, onSession, onStats);
    },
    modes: {
      descriptions: permissionModes,
      resolve: override => permissionMode(config, override),
      find: findPermissionMode,
      privateOnly: ['bypassPermissions'],
      hint: 'bypassPermissions 可简写为 bypass',
    },
    usage: () => runCliQuery({ bin: config.claudeBin, args: usageArgs(), input: '/usage', cwd: config.workspace, env, parse: parseEvent }),
    usageLabel: '查看 Claude 订阅用量和重置时间',
    // Resolves to the session's new name.
    rename: ({ sessionId, cwd, name, timeoutMs }) => runCliTurn({ bin: config.claudeBin, args: renameArgs(sessionId),
      input: renameInput(name), cwd, env, parse: event => parseRenameEvent(event, name), timeoutMs, agentName: displayName }),
    compact: ({ sessionId, cwd, instructions, timeoutMs, onStats }) => runCliTurn({ bin: config.claudeBin, args: compactArgs(sessionId),
      input: compactInput(instructions), cwd, env, parse: parseCompactEvent, timeoutMs, agentName: displayName, onStats }),
    sessions: {
      list: ({ exclude }) => listSessions({ home, exclude }),
      filter: filterSessions,
      pick: pickSession,
      running: () => runningSessions(home),
      digest: sessionDigest,
      stats: sessionStats,
      format: formatSessionList,
      ago: timeAgo,
      resumeHint: id => `claude --resume ${id}`,
      // Transcripts are <id>.jsonl; a resumed session that reports a new ID lives beside the old one.
      fileFor: (file, id) => path.join(path.dirname(file), `${id}.jsonl`),
      trash: trashSession,
      // Never reports a session ID: the recap runs on a fork that is not saved.
      recap: ({ sessionId, cwd, timeoutMs }) => run(recapArgs(sessionId), recapPrompt, cwd, timeoutMs),
    },
  };
}
