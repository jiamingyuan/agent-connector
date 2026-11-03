// Known agent and channel adapters. To add one (for example a slack-channel/ or wechat-channel/
// folder), implement the interface in core/README.md and register its folder here.
const agents = {
  'claude-code': () => import('../claude-code-agent/index.mjs'),
  codex: () => import('../codex-agent/index.mjs'),
};
const channels = {
  lark: () => import('../lark-channel/index.mjs'),
};

// config.agent picks the agent; the older config.backend ("claude" / "codex") still works.
export function agentId(config) {
  const value = config.agent || config.backend || 'codex';
  return value === 'claude' ? 'claude-code' : value;
}
export const channelId = config => config.channel || 'lark';

async function load(table, id, kind) {
  if (!Object.hasOwn(table, id)) throw new Error(`Unknown ${kind} "${id}"; known: ${Object.keys(table).join(', ')}`);
  return table[id]();
}
export const loadAgent = config => load(agents, agentId(config), 'agent');
export const loadChannel = config => load(channels, channelId(config), 'channel');
