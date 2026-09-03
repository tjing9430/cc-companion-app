import { store } from './state.js';
import { agentIsIdle } from './scope-fifo.js';
import { forgeSession } from './forge.js';
import { addConsoleEvent } from './console.js';

const IDLE_MS = 5 * 60 * 1000;
let rotating = false;

function rowsInCurrentSession() {
  const since = Date.parse(store.session && store.session.forged_at || '') || 0;
  return [...(store.chat_messages || []), ...(store.group_messages || [])]
    .filter((message) => (Date.parse(message.created_at || '') || 0) >= since && message.msg_type === 'chat');
}

function currentSessionTokens() {
  const rows = rowsInCurrentSession();
  let measured = 0;
  for (const message of rows) {
    const usage = message && message.api_usage;
    if (!usage) continue;
    measured = Math.max(measured,
      (Number(usage.input_tokens) || 0)
      + (Number(usage.cache_read_tokens) || 0)
      + (Number(usage.output_tokens) || 0));
  }
  if (measured) return { tokens: measured, source: 'provider' };
  const chars = rows.reduce((sum, message) => sum + String(message.content || '').length, 0);
  return { tokens: Math.ceil(chars / 2.5), source: 'estimated-original-text' };
}

function latestActivityAt() {
  return rowsInCurrentSession().reduce((latest, message) => {
    const at = Date.parse(message.created_at || '') || 0;
    return Math.max(latest, at);
  }, 0);
}

async function sessionRotationTick() {
  if (rotating || !agentIsIdle()) return { rotated: false, reason: 'busy' };
  const limit = Math.max(32, Number(store.settings && store.settings.session_max_tokens_k) || 600) * 1000;
  const usage = currentSessionTokens();
  if (usage.tokens < limit) return { rotated: false, reason: 'under-limit', ...usage, limit };
  const lastActivity = latestActivityAt();
  if (!lastActivity || Date.now() - lastActivity < IDLE_MS) {
    return { rotated: false, reason: 'waiting-for-idle', ...usage, limit };
  }
  rotating = true;
  try {
    addConsoleEvent('forge', 'Session 达到自动更换长度', `${Math.round(usage.tokens / 1000)}K / ${Math.round(limit / 1000)}K · 已空闲 5 分钟`);
    const result = await forgeSession();
    return { rotated: true, result, ...usage, limit };
  } finally {
    rotating = false;
  }
}

export { sessionRotationTick, currentSessionTokens };
