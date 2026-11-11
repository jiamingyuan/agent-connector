// Bots: the identities the bridge answers as, each on one channel (for example one Feishu app).
// config.bots lists them; every entry inherits the top-level settings, overrides what differs
// (channel, profile, authorized users, ...) and may narrow what the bot can reach with `access`.
// A config without `bots` is a single bot made from the top-level settings, with nothing narrowed.
import path from 'node:path';

const ALL = 'all';

function list(value, label) {
  if (value === undefined || value === ALL) return ALL;
  if (Array.isArray(value) && value.length && value.every(item => typeof item === 'string' && item.trim())) return value.map(item => item.trim());
  throw new Error(`${label} must be "all" or a non-empty list of names`);
}

// sessions: "all", "own" (only sessions this bot started) or a list of directories; modes and
// models: "all" or a list of names. Anything left out is "all".
export function accessOf(scope = {}, label = 'access') {
  let sessions = scope.sessions ?? ALL;
  if (sessions !== ALL && sessions !== 'own') {
    if (!Array.isArray(sessions) || !sessions.length || !sessions.every(dir => typeof dir === 'string' && path.isAbsolute(dir))) {
      throw new Error(`${label}.sessions must be "all", "own" or a list of absolute directories`);
    }
    sessions = sessions.map(dir => path.resolve(dir));
  }
  return { sessions, modes: list(scope.modes, `${label}.modes`), models: list(scope.models, `${label}.models`) };
}

// Returns [{ id, name, config, access }]. id is '' for the single bot of a config without `bots`,
// so its chats keep the state keys they always had; otherwise it prefixes every state key.
export function botConfigs(config) {
  const { bots, ...shared } = config;
  if (bots === undefined) return [{ id: '', name: config.botName, config: shared, access: accessOf() }];
  if (!Array.isArray(bots) || !bots.length) throw new Error('config.bots must be a non-empty list');
  const ids = new Set();
  return bots.map((bot, index) => {
    const label = `config.bots[${index}]`;
    const { access, id: ownId, name, ...own } = bot || {};
    if (typeof name !== 'string' || !name.trim()) throw new Error(`${label}.name is required`);
    const id = String(ownId ?? name).trim();
    if (!id || id.includes(':')) throw new Error(`${label}.id must not be empty or contain ":"`);
    if (ids.has(id)) throw new Error(`${label}: another bot already uses the id "${id}"`);
    ids.add(id);
    return { id, name: name.trim(), config: { ...shared, ...own, botName: name.trim() }, access: accessOf(access, `${label}.access`) };
  });
}

export const within = (dir, base) => {
  const relative = path.relative(base, dir);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
