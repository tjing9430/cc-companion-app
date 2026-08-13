// Forge 无缝续接与配额:上下文快照打包、adapter 调用、配额查询与播报。
import fs from 'node:fs';
import { store, saveStore, nextId, newSessionId, publicSettings, publicSession,
  FORGE_ADAPTER_URL, FORGE_ADAPTER_TOKEN, FORGE_ADAPTER_TIMEOUT_MS,
  QUOTA_ADAPTER_URL, QUOTA_ADAPTER_TOKEN, QUOTA_ADAPTER_TIMEOUT_MS } from './state.js';
import { cleanString, truncate, publicMessage, normalizeAttachments } from './util.js';
import { HttpError } from './http-util.js';
import { isForgeKeepMessage } from './memory.js';
import { broadcastSse, streamSnapshot } from './sse.js';
import { addConsoleEvent } from './console.js';
import { latestMessages, addMessage } from './messages.js';

// ---- 内置配额源:没配外部 adapter 时,拿桥同一份凭据直接问 OAuth usage 端点 ----
//
// ★ 为什么能这么做:CLI 流里的 rate_limit_event 平时**不带** utilization(8/13 实测,
//   接近上限才出现),所以「五小时用量」在流里拿不到;而这个端点随时给
//   {five_hour:{utilization: 27.0(0~100 已用), resets_at: ISO}, seven_day:{…}}(8/13 真样本)。
// ★ 语义翻译在这儿做,不留给前端:端点给的是**已用**,quotaWindowValue/设置页的
//   headline 是**余量**(文案「5h 余量」)。percent 存余量,used_percent 存已用,
//   两个名字各说各的真话 —— 把 27 当 73 显示这种事故只能死在这一层。
// ★ 凭据只读 accessToken、只进请求头,不落日志不进事件正文。失败一律回 null:
//   /quota 的表现退回「未配置」,不重试不刷屏。
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const BUILTIN_QUOTA_TTL_MS = 60_000;   // 状态行每次进终端档都会拉一次,不能每次都打真端点
let builtinQuotaCache = { at: 0, quota: null };

async function builtinQuota() {
  if (builtinQuotaCache.quota && Date.now() - builtinQuotaCache.at < BUILTIN_QUOTA_TTL_MS) {
    return builtinQuotaCache.quota;
  }
  const credPath = process.env.CLAUDE_CREDENTIALS_SOURCE || '';
  if (!credPath) return null;
  let token = '';
  try {
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    token = (cred && cred.claudeAiOauth && cred.claudeAiOauth.accessToken) || '';
  } catch { return null; }
  if (!token) return null;
  let data;
  try {
    const res = await fetch(OAUTH_USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch { return null; }
  const win = (w) => {
    const used = w ? Number(w.utilization) : NaN;
    if (!Number.isFinite(used)) return null;
    return {
      percent: Math.max(0, 100 - used),      // 余量,给 quotaWindowValue/设置页
      used_percent: used,                    // 已用,给终端状态行「5h用量」
      resets_at: (w && w.resets_at) || null,
    };
  };
  const fiveHour = win(data && data.five_hour);
  const weekly = win(data && data.seven_day);
  if (!fiveHour && !weekly) return null;
  const quota = {
    configured: true,
    status: 'ok',
    provider: 'builtin_oauth',
    five_hour: fiveHour,
    weekly,
    raw: {
      five_hour_used: fiveHour ? `${fiveHour.used_percent}%` : '',
      seven_day_used: weekly ? `${weekly.used_percent}%` : '',
      five_hour_resets_at: (fiveHour && fiveHour.resets_at) || '',
    },
  };
  builtinQuotaCache = { at: Date.now(), quota };
  return quota;
}

async function queryQuota({ recordEvent = true } = {}) {
  if (!QUOTA_ADAPTER_URL) {
    const builtin = await builtinQuota();
    if (builtin) {
      const event = recordEvent ? addConsoleEvent('quota', '/quota 查询结果', formatQuotaEventBody(builtin)) : null;
      return { event, quota: builtin };
    }
    // 「没配」和「配了但这次没取到」是两个病,报错别张冠李戴
    const hasCred = !!process.env.CLAUDE_CREDENTIALS_SOURCE;
    const event = recordEvent
      ? addConsoleEvent('quota',
          hasCred ? '/quota 暂时拿不到' : '/quota 未配置',
          hasCred
            ? '内置额度源(OAuth usage)这一次没取到 —— 网络抖动或凭据过期都可能,稍后再试。'
            : 'QUOTA_ADAPTER_URL is not set. Configure a quota adapter to fetch real remaining usage.')
      : null;
    return {
      event,
      quota: {
        configured: false,
        status: hasCred ? 'unavailable' : 'not_configured',
      },
    };
  }
  const payload = {
    operation: 'quota',
    requested_at: new Date().toISOString(),
    settings: publicSettings(),
    session: publicSession(),
  };
  const data = await callJsonAdapter({
    url: QUOTA_ADAPTER_URL,
    token: QUOTA_ADAPTER_TOKEN,
    tokenHeader: 'x-quota-token',
    timeoutMs: QUOTA_ADAPTER_TIMEOUT_MS,
    errorPrefix: 'quota_adapter',
    payload,
  });
  const quota = publicQuotaAdapterResult(data);
  const event = recordEvent ? addConsoleEvent('quota', '/quota 查询结果', formatQuotaEventBody(quota)) : null;
  return { event, quota };
}

async function forgeSession() {
  const previousId = store.session && store.session.current_id ? store.session.current_id : newSessionId('session');
  const nextIdValue = newSessionId('forge');
  const now = new Date().toISOString();
  const chat = buildForgeMessageList('chat', nextIdValue);
  const group = buildForgeMessageList('group', nextIdValue);
  const external = await callForgeAdapter({
    operation: 'forge',
    previous_local_history_id: previousId,
    new_local_history_id: nextIdValue,
    created_at: now,
    settings: publicSettings(),
    stats: {
      kept: chat.kept + group.kept,
      removed_noise: chat.removed + group.removed,
    },
    chat: {
      kept: chat.kept,
      removed_noise: chat.removed,
      messages: chat.rows.map(publicMessage),
    },
    group: {
      kept: group.kept,
      removed_noise: group.removed,
      messages: group.rows.map(publicMessage),
    },
  });
  chat.rows.push(createForgeMarker('chat', nextIdValue, now, external));
  group.rows.push(createForgeMarker('group', nextIdValue, now, external));
  store.chat_messages = chat.rows;
  store.group_messages = group.rows;
  store.session = {
    current_id: nextIdValue,
    previous_id: previousId,
    forged_at: now,
    forge_count: Number(store.session && store.session.forge_count || 0) + 1,
    external_forge: external.public,
  };
  const body = [
    `new_local_history=${nextIdValue}`,
    `previous_local_history=${previousId}`,
    `kept=${chat.kept + group.kept}`,
    `removed_noise=${chat.removed + group.removed}`,
    external.configured
      ? `external_forge=${external.public.status || 'completed'}`
      : 'external_forge=not_configured',
    external.configured
      ? 'real_session=adapter_handled'
      : 'real_session=unchanged',
    external.configured
      ? 'note=external forge adapter completed before companion local history was committed'
      : 'note=standalone fallback only; set FORGE_ADAPTER_URL to rotate a real Claude Code / cc-connect session',
  ].join('\n');
  const event = addConsoleEvent(
    'forge',
    external.configured ? '/forge completed' : '/forge local only (no new Claude session)',
    body,
  );
  broadcastSse('snapshot', streamSnapshot('all'));
  return {
    event,
    session: publicSession(),
    previous_session_id: previousId,
    new_session_id: nextIdValue,
    kept: chat.kept + group.kept,
    removed_noise: chat.removed + group.removed,
    external_forge: external.public,
    scopes: { chat, group },
  };
}

function buildForgeMessageList(scope, nextIdValue) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const source = Array.isArray(store[key]) ? store[key] : [];
  const cleaned = [];
  let removed = 0;
  for (const message of source) {
    if (isForgeKeepMessage(message)) {
      cleaned.push({
        ...message,
        attachments: normalizeAttachments(message.attachments),
        session_id: nextIdValue,
      });
    } else {
      removed += 1;
    }
  }
  return { rows: cleaned, kept: cleaned.length, removed };
}

function createForgeMarker(scope, nextIdValue, now, external) {
  const externalDone = external && external.configured;
  return {
    id: nextId('message'),
    scope,
    sender: '系统',
    role: 'assistant',
    content: externalDone
      ? `已 forge：外部 forge adapter 已完成真实会话处理；companion 去掉 tool/thinking 等噪音、保留原文，并开启新的本地历史段 ${nextIdValue}。`
      : `已本地整理：去掉 tool/thinking 等噪音，保留原文，并开启新的 companion 本地历史段 ${nextIdValue}；未开启新的 Claude Code / cc-connect session。`,
    attachments: [],
    parent_msg_id: null,
    msg_type: 'forge',
    session_id: nextIdValue,
    created_at: now,
  };
}

async function callForgeAdapter(payload) {
  if (!FORGE_ADAPTER_URL) {
    return {
      configured: false,
      public: { configured: false, status: 'not_configured' },
    };
  }
  const { data, endpoint } = await callJsonAdapter({
    url: FORGE_ADAPTER_URL,
    token: FORGE_ADAPTER_TOKEN,
    tokenHeader: 'x-forge-token',
    timeoutMs: FORGE_ADAPTER_TIMEOUT_MS,
    errorPrefix: 'forge_adapter',
    payload,
  });
  return {
    configured: true,
    raw: data,
    public: {
      configured: true,
      status: cleanString(data.status || data.message, 'completed'),
      adapter: `${endpoint.protocol}//${endpoint.host}`,
      result: publicForgeAdapterResult(data),
    },
  };
}

async function callJsonAdapter({ url, token, tokenHeader, timeoutMs, errorPrefix, payload }) {
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new HttpError(500, `invalid_${errorPrefix}_url`, `${errorPrefix.toUpperCase()} URL is invalid`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let data = {};
  try {
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
    };
    if (token) {
      headers.authorization = `Bearer ${token}`;
      headers[tokenHeader || `x-${errorPrefix.replace(/_/g, '-')}-token`] = token;
    }
    response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    data = await response.json().catch(() => ({}));
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new HttpError(504, `${errorPrefix}_timeout`, `${errorPrefix} timed out after ${timeoutMs} ms`);
    }
    throw new HttpError(502, `${errorPrefix}_failed`, `${errorPrefix} request failed: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok || data.ok === false) {
    const message = data.message || data.error || `HTTP ${response.status}`;
    throw new HttpError(502, `${errorPrefix}_rejected`, `${errorPrefix} rejected request: ${message}`);
  }
  return { data, endpoint };
}

function publicForgeAdapterResult(data) {
  const source = data && typeof data === 'object' && data.data && typeof data.data === 'object'
    ? { ...data, ...data.data }
    : (data && typeof data === 'object' ? data : {});
  const keys = [
    'session_key',
    'previous_session_key',
    'new_session_key',
    'agent_session_id',
    'previous_agent_session_id',
    'new_agent_session_id',
    'transcript',
    'retained_messages',
    'retained_tokens',
    'removed_noise',
  ];
  const out = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string') out[key] = truncate(value, 240);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function publicQuotaAdapterResult(data) {
  const source = data && typeof data === 'object' && data.data && typeof data.data === 'object'
    ? { ...data, ...data.data }
    : (data && typeof data === 'object' ? data : {});
  const quota = {
    configured: true,
    status: cleanString(source.status || source.message, 'ok'),
    subject: cleanString(source.subject || source.name || source.session_name || source.agent || '', ''),
    provider: cleanString(source.provider || source.service, ''),
    model: cleanString(source.model || source.plan, ''),
    remaining: quotaValue(source.remaining ?? source.remaining_tokens ?? source.remaining_messages ?? source.remaining_percent),
    limit: quotaValue(source.limit ?? source.total ?? source.limit_tokens ?? source.max),
    used: quotaValue(source.used ?? source.used_tokens ?? source.used_messages),
    resets_at: cleanString(source.resets_at || source.reset_at || source.reset_time, ''),
    window: cleanString(source.window || source.period, ''),
    context: publicQuotaSection(source.context || source.context_window || {}, {
      used: source.context_used ?? source.context_tokens ?? source.context_current,
      limit: source.context_limit ?? source.context_max,
      percent: source.context_percent ?? source.context_percentage,
    }),
    limit_tier: cleanString(source.limit_tier || source.quota_tier || source.tier || source.plan_label || '', ''),
    five_hour: publicQuotaSection(source.five_hour || source.fiveHour || source.five_hour_quota || source['5h'] || {}, {
      remaining: source.five_hour_remaining ?? source.five_hour_remaining_percent ?? source.remaining_5h ?? source.remaining_5h_percent,
      percent: source.five_hour_percent ?? source.five_hour_remaining_percent ?? source.remaining_5h_percent,
      resets_in: source.five_hour_resets_in ?? source.five_hour_reset_in ?? source.resets_in_5h,
      resets_at: source.five_hour_resets_at ?? source.five_hour_reset_at ?? source.reset_at_5h,
    }),
    weekly: publicQuotaSection(source.weekly || source.seven_day || source.sevenDay || source['7d'] || {}, {
      remaining: source.weekly_remaining ?? source.weekly_remaining_percent ?? source.seven_day_remaining ?? source.seven_day_remaining_percent,
      percent: source.weekly_percent ?? source.weekly_remaining_percent ?? source.seven_day_percent ?? source.seven_day_remaining_percent,
      resets_in: source.weekly_resets_in ?? source.weekly_reset_in ?? source.seven_day_resets_in,
      resets_at: source.weekly_resets_at ?? source.weekly_reset_at ?? source.seven_day_resets_at,
    }),
    raw: {},
  };
  for (const key of ['remaining_tokens', 'remaining_messages', 'remaining_percent', 'used_tokens', 'used_messages', 'limit_tokens']) {
    if (source[key] != null) quota.raw[key] = quotaValue(source[key]);
  }
  return quota;
}

function publicQuotaSection(section, fallback = {}) {
  const source = section && typeof section === 'object' ? section : {};
  const out = {
    used: quotaValue(source.used ?? source.current ?? source.tokens ?? fallback.used),
    limit: quotaValue(source.limit ?? source.max ?? source.total ?? fallback.limit),
    remaining: quotaValue(source.remaining ?? source.remaining_percent ?? fallback.remaining),
    percent: quotaValue(source.percent ?? source.percentage ?? source.used_percent ?? fallback.percent),
    resets_in: cleanString(source.resets_in || source.reset_in || source.remaining_time || fallback.resets_in, ''),
    resets_at: cleanString(source.resets_at || source.reset_at || source.reset_time || fallback.resets_at, ''),
    label: cleanString(source.label || fallback.label, ''),
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== null && value !== ''));
}

function quotaValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return truncate(value.trim(), 120);
  return null;
}

function formatQuotaEventBody(quota) {
  const lines = [`status=${quota.status || 'ok'}`];
  if (quota.provider) lines.push(`provider=${quota.provider}`);
  if (quota.model) lines.push(`model=${quota.model}`);
  if (quota.remaining != null) lines.push(`remaining=${quota.remaining}`);
  if (quota.used != null) lines.push(`used=${quota.used}`);
  if (quota.limit != null) lines.push(`limit=${quota.limit}`);
  if (quota.resets_at) lines.push(`resets_at=${quota.resets_at}`);
  if (quota.window) lines.push(`window=${quota.window}`);
  for (const key of Object.keys(quota.raw || {})) {
    if (!lines.some((line) => line.startsWith(`${key}=`))) lines.push(`${key}=${quota.raw[key]}`);
  }
  return lines.join('\n');
}

export {
  forgeSession, createForgeMarker, callForgeAdapter, publicForgeAdapterResult,
  publicQuotaAdapterResult, formatQuotaEventBody, queryQuota,
};
