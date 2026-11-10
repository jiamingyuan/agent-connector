// Feishu message cards (JSON 2.0) for replies when config.replyFormat is 'card': a blue header with
// the session name and tags for permission mode, model and context size; plan limits (as text) at the top
// and this turn's token totals at the bottom. Warning colours only mark the module concerned.

const short = n => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)).replace(/\.0(?=[kM]$)/, '');

// claude-opus-5-5 -> "claude opus 5.5"; a trailing date (claude-sonnet-4-5-20250929) is dropped.
export function modelName(id) {
  const words = String(id || '').split(/[-_]/).filter(word => word && !/^\d{8}$/.test(word));
  const out = [];
  for (const word of words) {
    if (/^\d+$/.test(word) && /^\d+(\.\d+)*$/.test(out.at(-1) || '')) out[out.length - 1] += `.${word}`;
    else out.push(word);
  }
  return out.join(' ');
}

// Context size by absolute tokens: from 50k orange, from 200k red.
export const contextColor = tokens => (tokens >= 200_000 ? 'red' : tokens >= 50_000 ? 'orange' : 'green');
// Plan limits by what is left: under 50% orange, under 20% red.
const leftColor = left => (left < 20 ? 'red' : left < 50 ? 'orange' : 'green');

const utc = seconds => {
  if (!Number.isFinite(seconds)) return '';
  const date = new Date(seconds * 1000).toISOString();
  return `${date.slice(5, 10)} ${date.slice(11, 16)} UTC`;
};

// Text only: block-character bars rendered unevenly in Feishu's mobile fonts.
function quotaLine(label, window) {
  const left = Math.max(0, Math.min(100, Math.round((1 - window.used) * 100)));
  const reset = utc(window.resetsAt);
  return `${label} <font color='${leftColor(left)}'>剩 ${left}%</font>${reset ? `<font color='grey'> · ${reset}</font>` : ''}`;
}

const tag = (content, color) => ({ tag: 'text_tag', text: { tag: 'plain_text', content }, color });

export function buildCard(text, info = {}) {
  const tags = [];
  if (info.mode) tags.push(info.mode.risky ? tag(`⚠️ ${info.mode.name}`, 'red') : tag(`${info.mode.name} mode`, 'blue'));
  if (info.model) tags.push(tag(`${modelName(info.model)}${info.effort ? ` - ${info.effort}` : ''}`, 'neutral'));
  if (Number.isFinite(info.context)) tags.push(tag(`context ${short(info.context)}`, contextColor(info.context)));
  const elements = [];
  const quota = [info.quota?.fiveHour && quotaLine('5 小时额度', info.quota.fiveHour), info.quota?.sevenDay && quotaLine('本周额度', info.quota.sevenDay)].filter(Boolean);
  if (quota.length) elements.push({ tag: 'markdown', content: quota.join('\n'), text_size: 'notation' }, { tag: 'hr' });
  elements.push({ tag: 'markdown', content: text });
  const turn = info.turn;
  if (turn) {
    const items = [Number.isFinite(turn.seconds) && `本轮 ${turn.seconds} 秒`, `输出 ${short(turn.output || 0)}`,
      `新增输入 ${short(turn.newInput || 0)}`, `缓存读取 ${short(turn.cacheRead || 0)}`].filter(Boolean);
    elements.push({ tag: 'hr' }, { tag: 'markdown', content: `<font color='grey'>${items.join(' - ')}</font>`, text_size: 'notation' });
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: info.title || '新会话' }, template: 'blue', ...(tags.length ? { text_tag_list: tags.slice(0, 3) } : {}) },
    body: { elements },
  };
}

// The same reply as a Markdown post, for when Feishu rejects the card: the old one-line header.
export function fallbackText(text, info = {}) {
  const note = [info.mode && `${info.mode.risky ? '⚠️ ' : ''}${info.mode.name} mode`, info.model && modelName(info.model),
    Number.isFinite(info.context) && `context ${short(info.context)}`].filter(Boolean).join(' · ');
  return `**${info.title || '新会话'}**${note ? ` -- ${note}` : ''}\n${text}`;
}
