// Agent adapter: local Claude Code CLI. Implements the agent interface in core/README.md, plus the
// optional features modes (/mode), models (/model), efforts (/effort), usage (/usage), compact (/compact), rename (/rename) and sessions
// (/sessions, /switch, /delete).
import path from 'node:path';
import { runCliTurn, runCliQuery } from '../core/cli-turn.mjs';
import { needsSession } from '../core/selftest.mjs';
import { permissionModes, permissionMode, findPermissionMode, modelAliases, findModel, effortLevels, findEffort, turnArgs, recapArgs, usageArgs, recapPrompt, turnInput,
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
    runTurn: ({ sessionId, cwd, text, images = [], files = [], outbox, instructionsFile, mode, model, effort, timeoutMs, onSession, onStats }) =>
      run(turnArgs(config, sessionId, { images, mode, model, effort, files, cwd, outbox, instructionsFile }), turnInput(text, images), cwd, timeoutMs, onSession, onStats),
    modes: {
      descriptions: permissionModes,
      resolve: override => permissionMode(config, override),
      find: findPermissionMode,
      privateOnly: ['bypassPermissions'],
      hint: 'bypassPermissions 可简写为 bypass',
    },
    // Unset defaults mean Claude Code's own choice (its settings), which the bridge does not know.
    models: {
      descriptions: modelAliases,
      resolve: override => override || config.claudeModel,
      find: findModel,
      hint: '也可写完整模型名，如 claude-sonnet-5-5',
    },
    efforts: {
      descriptions: effortLevels,
      resolve: override => override || config.claudeEffort,
      find: findEffort,
    },
    // Connection test (/test): the cheapest model and effort to try the switches with, and what
    // only this agent knows how to check.
    selfTest: {
      model: 'haiku',
      effort: 'low',
      checks: [
        { id: 'resume-list', title: '机器人开的会话出现在终端 /resume 列表', when: needsSession, run(context) {
          const session = listSessions({ home, exclude: [] }).find(item => item.id === String(context.session.id).toLowerCase());
          if (!session) throw new Error('在 Claude Code 的会话记录里找不到测试会话');
          // Claude Code hides sessions recorded with the sdk entrypoint from the /resume picker.
          if (session.headless) throw new Error('会话被记成了脚本会话，终端的 /resume 列表里不会显示');
        } },
      ],
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
