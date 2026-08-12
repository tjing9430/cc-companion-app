// 应用状态与配置:.env 装载、全部环境配置常量、store 的装载/落盘/归一化/种子数据。
// 这是依赖图的根:兄弟模块都 import 它,它只 import util —— **和一个例外**:
// store-sqlite.js。破例是因为 loadStore() 在模块顶层同步执行,拿不到注入;
// 而 store-sqlite 自己只依赖 node 内置 + 迁移脚本的 SCHEMA_SQL,**不反向依赖任何 lib**,
// 所以不成环(实测加载过)。写在这儿是为了别让后人以为这条根规矩已经废了。
import fs from 'node:fs';
import { openStoreSync } from './store-sqlite.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from './env.js';
import { cleanString, normalizeTags, defaultMemoryMood, publicMessage } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

loadDotEnv(path.join(ROOT_DIR, '.env'));

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const STORE_FILE = path.join(DATA_DIR, 'app-data.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const AUTH_TOKEN = String(process.env.APP_AUTH_TOKEN || '').trim();
const AGENT_TIMEOUT_MS = Math.max(1000, Number(process.env.AGENT_TIMEOUT_MS || 120000));
const MEMORY_RECALL_LIMIT = Math.max(1, Number(process.env.MEMORY_RECALL_LIMIT || 8));
// Conversation context for the OpenAI-compatible agent. 0 disables history.
// (In Claude Code / cc-connect mode the CC session keeps its own context — these do not apply.)
const CHAT_CONTEXT_MAX = Math.max(0, Number(process.env.CHAT_CONTEXT_MAX_MESSAGES || 40));
const CHAT_CONTEXT_KEEP = Math.max(4, Number(process.env.CHAT_CONTEXT_KEEP_MESSAGES || 24));
// Auto memory extraction (OpenAI mode): run after every N fresh user messages. 0 disables.
const MEMORY_EXTRACT_EVERY = Math.max(0, Number(process.env.MEMORY_EXTRACT_EVERY || 8));
// Reference-document chunks injected per turn.
const DOC_RECALL_LIMIT = Math.max(0, Number(process.env.DOC_RECALL_LIMIT || 3));
const DOC_MAX_CHARS = 200 * 1024;
const FORGE_ADAPTER_URL = String(process.env.FORGE_ADAPTER_URL || '').trim();
const FORGE_ADAPTER_TOKEN = String(process.env.FORGE_ADAPTER_TOKEN || '').trim();
const FORGE_ADAPTER_TIMEOUT_MS = Math.max(1000, Number(process.env.FORGE_ADAPTER_TIMEOUT_MS || 120000));
const QUOTA_ADAPTER_URL = String(process.env.QUOTA_ADAPTER_URL || '').trim();
const QUOTA_ADAPTER_TOKEN = String(process.env.QUOTA_ADAPTER_TOKEN || '').trim();
const QUOTA_ADAPTER_TIMEOUT_MS = Math.max(1000, Number(process.env.QUOTA_ADAPTER_TIMEOUT_MS || 30000));
// Heartbeat: let the assistant occasionally reach out on its own (opt-in). Only meaningful with a
// configured OpenAI-compatible model; the mock agent just sends an occasional demo line.
const HEARTBEAT_ENABLED = String(process.env.HEARTBEAT_ENABLED || '').trim().toLowerCase() === 'true';
const HEARTBEAT_INTERVAL_MINUTES = Math.max(5, Number(process.env.HEARTBEAT_INTERVAL_MINUTES || 90));
const HEARTBEAT_MIN_IDLE_MINUTES = Math.max(0, Number(process.env.HEARTBEAT_MIN_IDLE_MINUTES || 45));
const HEARTBEAT_QUIET_START = Math.min(23, Math.max(0, Number(process.env.HEARTBEAT_QUIET_START || 0)));
const HEARTBEAT_QUIET_END = Math.min(23, Math.max(0, Number(process.env.HEARTBEAT_QUIET_END || 8)));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 存储后端。默认仍是 JSON —— 这是**稳妥优先的取舍**:
// 新路径错了也不影响现有用户,而 §6 定的回滚(「删掉 .db 继续用 JSON」)也只有
// JSON 这条路还活着时才成立。切 sqlite 靠 STORE_BACKEND=sqlite,验稳了再谈翻默认。
const STORE_BACKEND = String(process.env.STORE_BACKEND || 'json').trim().toLowerCase();
const DB_FILE = path.join(DATA_DIR, 'app.db');
let sqliteStore = null;

function loadStore() {
  if (STORE_BACKEND === 'sqlite') return loadStoreSqlite();
  return loadStoreJson();
}

function loadStoreSqlite() {
  sqliteStore = openStoreSync(DB_FILE);
  // 空库 + 有 JSON = 第一次切过来,把 JSON 整份接管进来。
  // ★ 接管之后**不删 JSON** —— 它就是回滚路径本身。
  if (sqliteStore.isEmpty() && fs.existsSync(STORE_FILE)) {
    try {
      sqliteStore.replaceAll(normalizeStore(JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))));
      console.log(`Adopted ${STORE_FILE} into ${DB_FILE} (JSON kept as rollback).`);
    } catch (err) {
      // 接管失败就退回 JSON,而不是拿一个半截库开张
      console.warn(`Could not adopt JSON store (${err.message}); falling back to JSON backend.`);
      sqliteStore.close(); sqliteStore = null;
      return loadStoreJson();
    }
  }
  return normalizeStore(sqliteStore.loadAll());
}

function loadStoreJson() {
  if (!fs.existsSync(STORE_FILE)) return defaultStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return normalizeStore(parsed);
  } catch (err) {
    const backup = `${STORE_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(STORE_FILE, backup);
    console.warn(`Store was invalid. Backed up to ${backup}`);
    return defaultStore();
  }
}

// hint 说明这次改了什么,sqlite 后端据此只写那几行。
// ★ 不给 hint 也是**正确**的,只是退回全量写 —— 这样 22 个调用点可以一个一个改,
//   没改到的照常工作,不会因为漏改一处就写坏数据。正确性不依赖调用方记得传参。
function saveStore(hint) {
  if (sqliteStore) return saveStoreSqlite(hint);
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

function saveStoreSqlite(hint) {
  const k = hint && hint.kind;
  const ROW_KINDS = { message: 'putMessage', console: 'putConsoleEvent', memory: 'putMemory', document: 'putDocument' };
  if (ROW_KINDS[k] && hint.row) {
    // ★ 写行必须**连 counters 一起、同一个事务**。
    //   nextId() 只改内存里的 counters;只写那一行的话 counters 永远落不了盘,
    //   重启后 nextId 会发一个用过的 id,而 putMessage 是 ON CONFLICT DO UPDATE
    //   —— 结果不是报错,是**静默盖掉已有的旧消息**。
    //   同事务是关键:分两次写,中间崩一下就又回到「行进去了、号没进去」那个状态。
    return sqliteStore.tx(() => {
      if (k === 'console') sqliteStore.putConsoleEvent(hint.row, 500);
      else sqliteStore[ROW_KINDS[k]](hint.row);
      sqliteStore.putKv('counters', store.counters);
    });
  }
  if (k === 'kv') return sqliteStore.putKvAll(store);
  return sqliteStore.replaceAll(store);   // 兜底:慢但对
}

// 退出前把 WAL 折回主库。★ 必须是同步的 —— 挂在 process 'exit' 上,
// 那里只跑得动同步代码,而 node:sqlite 正好全是同步的。
// 走 JSON 后端时是空操作,调用方不用判断后端。
function flushStore() {
  if (!sqliteStore) return null;
  try { return sqliteStore.checkpoint(); } catch { return null; }
}

function defaultStore() {
  return normalizeStore({
    counters: { message: 1, memory: 1, console: 1 },
    session: { current_id: newSessionId('session'), forge_count: 0 },
    settings: {
      appName: process.env.APP_NAME || 'CC Companion',
      userName: process.env.USER_NAME || '你',
      assistantName: process.env.ASSISTANT_NAME || 'AI',
      groupName: process.env.GROUP_NAME || '小群',
      agentMention: process.env.AGENT_MENTION || 'assistant',
      autoReplyGroup: String(process.env.AUTO_REPLY_GROUP || '').toLowerCase() === 'true',
      theme: 'light',
      // 星空主题下的图标风格:'star' 手绘尖角星 / 'badge' 徽章。
      // ★ 默认 badge。我最初写的是 star,理由是"老用户不变脸" —— 那个理由是错的:
      //   同一次改动**把底图也换了**,老样子(star3 + galaxy-river)已经不存在,
      //   默认 star 只会把用户放进"新暗底 + 细白线条"这个没被设计确认过的组合里。
      //   ★ 我在为一个**这次改动已经破坏掉的性质**做优化。
      //   实测图标与周围底色的对比:徽章 140~170(五颗齐),星星 61~175(设置那颗只有 61)。
      skyIcons: 'badge',
      // 「已陪伴你 N 天」的起算日。**只在新建 store 这一刻落一次**,所以它天然就是
      // 「第一次跑这个前端的日子」;用户随时可以在设置里改成自己想要的那天。
      //
      // ★ 老库升级上来不会走到这里(store 已存在),字段会是空的 —— 那是对的:
      //   我们不知道他第一次用是哪天,与其编一个,不如空着、让他自己挑
      //   (设置页有「替我挑一个」,拿最早一条消息的日期当建议,他看得见再决定)。
      companion_since: todayISODate(),
    },
    chat_messages: [],
    group_messages: [],
    console_events: [],
    memories: [],
    stickers: [],
  });
}

function ensureSeedData() {
  let changed = false;
  if (!store.chat_messages.length) {
    store.chat_messages.push({
      id: nextId('message'),
      scope: 'chat',
      sender: store.settings.assistantName,
      role: 'assistant',
      content: '欢迎来到私聊。发一句话，就可以测试这个自部署 AI 伴侣 App。',
      attachments: [],
      parent_msg_id: null,
      msg_type: 'chat',
      created_at: new Date().toISOString(),
    });
    changed = true;
  }
  if (!store.group_messages.length) {
    store.group_messages.push({
      id: nextId('message'),
      scope: 'group',
      sender: '系统',
      role: 'assistant',
      content: `欢迎来到 ${store.settings.groupName}。在群聊里提到 @${store.settings.agentMention} 就可以唤起 AI。`,
      attachments: [],
      parent_msg_id: null,
      msg_type: 'chat',
      created_at: new Date().toISOString(),
    });
    changed = true;
  }
  if (!store.memories.length) {
    store.memories.push({
      id: nextId('memory'),
      title: '示例偏好',
      content: '回复尽量简短、自然、可执行。',
      mood: '平静',
      author: store.settings.assistantName || 'AI',
      tags: ['example'],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    changed = true;
  }
  if (changed) saveStore();
}

function normalizeStore(input) {
  const data = input && typeof input === 'object' ? input : {};
  const settings = normalizeSettings(data.settings || {});
  const session = normalizeSession(data.session || {});
  const counters = { message: 1, memory: 1, console: 1 };
  // Preserve every persisted counter (sticker, document, ...), not just the
  // three defaults — dropping one would restart its ids and collide.
  for (const [kind, value] of Object.entries(data.counters || {})) {
    if (Number(value) > 0) counters[kind] = Number(value);
  }
  return {
    counters,
    session,
    settings,
    context_anchor: {
      chat: Number(data.context_anchor && data.context_anchor.chat) || 0,
      group: Number(data.context_anchor && data.context_anchor.group) || 0,
    },
    memory_extract_cursor: {
      chat: Number(data.memory_extract_cursor && data.memory_extract_cursor.chat) || 0,
      group: Number(data.memory_extract_cursor && data.memory_extract_cursor.group) || 0,
    },
    documents: Array.isArray(data.documents) ? data.documents : [],
    chat_messages: Array.isArray(data.chat_messages) ? data.chat_messages.map(publicMessage) : [],
    group_messages: Array.isArray(data.group_messages) ? data.group_messages.map(publicMessage) : [],
    console_events: Array.isArray(data.console_events) ? data.console_events : [],
    stickers: Array.isArray(data.stickers) ? data.stickers : [],
    memories: Array.isArray(data.memories) ? data.memories.map((item) => {
      const tags = normalizeTags(item && item.tags);
      return {
        ...item,
        title: cleanString(item && item.title, 'Untitled memory'),
        content: cleanString(item && item.content, ''),
        mood: cleanString(item && item.mood, defaultMemoryMood(tags)),
        author: cleanString(item && item.author, settings.assistantName || 'AI'),
        tags,
        created_at: cleanString(item && item.created_at, new Date().toISOString()),
        updated_at: cleanString(item && item.updated_at, item && item.created_at || new Date().toISOString()),
      };
    }) : [],
  };
}

function normalizeSession(input) {
  const data = input && typeof input === 'object' ? input : {};
  return {
    current_id: cleanString(data.current_id, newSessionId('session')),
    previous_id: cleanString(data.previous_id, ''),
    forged_at: cleanString(data.forged_at, ''),
    forge_count: Number(data.forge_count) || 0,
    external_forge: data.external_forge && typeof data.external_forge === 'object' ? data.external_forge : null,
  };
}

function normalizeSettings(input) {
  const defaults = {
    appName: process.env.APP_NAME || 'CC Companion',
    userName: process.env.USER_NAME || '你',
    assistantName: process.env.ASSISTANT_NAME || 'AI',
    groupName: process.env.GROUP_NAME || '小群',
    agentMention: process.env.AGENT_MENTION || 'assistant',
    autoReplyGroup: String(process.env.AUTO_REPLY_GROUP || '').toLowerCase() === 'true',
    theme: 'light',
    featureCopyAll: true,
    featureRecall: true,
    featureDelete: true,
    featureAutoExtract: true,
    featureSemanticSearch: true,
    companion_since: '',
    user_avatar: '',
    assistant_avatar: '',
  };
  const settings = { ...defaults, ...(input || {}) };
  return {
    appName: cleanString(settings.appName, defaults.appName),
    userName: cleanString(settings.userName, defaults.userName),
    assistantName: cleanString(settings.assistantName, defaults.assistantName),
    groupName: cleanString(settings.groupName, defaults.groupName),
    agentMention: cleanString(settings.agentMention, defaults.agentMention).replace(/^@+/, '') || 'assistant',
    autoReplyGroup: settings.autoReplyGroup === true || String(settings.autoReplyGroup).toLowerCase() === 'true',
    // 主题白名单。未知值一律回落 dark —— 前端拿到没有对应 CSS 的值会整页裸奔。
    theme: ['light', 'starry'].includes(settings.theme) ? settings.theme : 'dark',
    // ★ 同样是白名单。**这个 return 是显式字面量,不在这儿列出来的字段会被静默丢掉** ——
    //   只加到上面 defaults 里是不够的:POST 会返回 200、值却从来没落地。
    //   (2026-08-11 加 skyIcons 时差点这么交出去。)
    // 手绘星星那套已删,只剩徽章 —— 旧库里存着 'star' 的也一并收敛过来,
    // 免得留一个前端根本不读、只会让人以为还能切的值。
    skyIcons: 'badge',
    featureCopyAll: settings.featureCopyAll !== false && String(settings.featureCopyAll).toLowerCase() !== 'false',
    featureRecall: settings.featureRecall !== false && String(settings.featureRecall).toLowerCase() !== 'false',
    featureDelete: settings.featureDelete !== false && String(settings.featureDelete).toLowerCase() !== 'false',
    featureAutoExtract: settings.featureAutoExtract !== false && String(settings.featureAutoExtract).toLowerCase() !== 'false',
    featureSemanticSearch: settings.featureSemanticSearch !== false && String(settings.featureSemanticSearch).toLowerCase() !== 'false',
    companion_since: normalizeDateOnly(settings.companion_since),
    user_avatar: normalizeAvatar(settings.user_avatar),
    assistant_avatar: normalizeAvatar(settings.assistant_avatar),
  };
}

// 头像只接**已经上传到本机的资源引用**,别的一律丢掉(返回空串,不报错)。
//
// ★ 这是安全边界不是格式校验。放开成"任意 URL"会同时开三个面:
//   ① 外链 = 每次渲染都把用户 IP/UA 送给第三方(还能被拿来探内网,SSRF)
//   ② data: URL = 任意字节经由设置项落进 store,等于开了一条免上传的写入口
//   ③ 路径穿越 = /uploads/../../etc/... 读到不该读的
// 所以这里用白名单形状,不是黑名单过滤:只有 /uploads/ 下的纯文件名放行。
function normalizeAvatar(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) return '';
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(v)) return '';
  if (v.includes('..')) return '';          // 形状已经挡住了,这行是第二道,便宜
  return v;
}

// 只认 YYYY-MM-DD,而且得是真实存在的日期。
// ★ 这个值会进日期运算(算「第几天」),放一个 '2026-02-31' 或者随手一段文本进去,
//   前端算出来的就是 NaN 天 —— 界面上是一句读不懂的话,不是一个报错。
function normalizeDateOnly(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  // 反查一遍:Date 会把 02-31 悄悄滚成 03-03,不比对就放行了一个不存在的日子
  return d.toISOString().slice(0, 10) === v ? v : '';
}

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

function nextId(kind) {
  const current = Number(store.counters[kind] || 1);
  store.counters[kind] = current + 1;
  return current;
}

function newSessionId(prefix = 'session') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

let store = loadStore();
ensureSeedData();

function publicSettings() {
  return {
    ...store.settings,
    authEnabled: Boolean(AUTH_TOKEN),
    agent: agentStatus(),
  };
}

function publicSession() {
  return { ...(store.session || normalizeSession({})) };
}

function applySettingsRename(previous, next) {
  if (!previous || !next) return;
  let changed = false;
  changed = renameStoredSender(previous.userName, next.userName) || changed;
  changed = renameStoredSender(previous.assistantName, next.assistantName) || changed;
  changed = renameStoredMemoryAuthor(previous.assistantName, next.assistantName) || changed;
  return changed;
}

function renameStoredSender(from, to) {
  if (!from || !to || from === to) return false;
  let changed = false;
  for (const key of ['chat_messages', 'group_messages']) {
    for (const message of store[key] || []) {
      if (message.sender === from) {
        message.sender = to;
        changed = true;
      }
    }
  }
  return changed;
}

function renameStoredMemoryAuthor(from, to) {
  if (!from || !to || from === to) return false;
  let changed = false;
  for (const memory of store.memories || []) {
    if (memory.author === from) {
      memory.author = to;
      memory.updated_at = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

function agentStatus() {
  return {
    provider: process.env.OPENAI_API_KEY ? 'openai-compatible' : 'mock',
    model: process.env.OPENAI_API_KEY ? (process.env.OPENAI_MODEL || 'gpt-4.1-mini') : 'mock-agent',
    configured: Boolean(process.env.OPENAI_API_KEY),
  };
}

export {
  flushStore,
  ROOT_DIR, PORT, DATA_DIR, PUBLIC_DIR, STORE_FILE, UPLOAD_DIR, MAX_JSON_BYTES,
  AUTH_TOKEN, AGENT_TIMEOUT_MS, MEMORY_RECALL_LIMIT, CHAT_CONTEXT_MAX, CHAT_CONTEXT_KEEP,
  MEMORY_EXTRACT_EVERY, DOC_RECALL_LIMIT, DOC_MAX_CHARS,
  FORGE_ADAPTER_URL, FORGE_ADAPTER_TOKEN, FORGE_ADAPTER_TIMEOUT_MS,
  QUOTA_ADAPTER_URL, QUOTA_ADAPTER_TOKEN, QUOTA_ADAPTER_TIMEOUT_MS,
  HEARTBEAT_ENABLED, HEARTBEAT_INTERVAL_MINUTES, HEARTBEAT_MIN_IDLE_MINUTES,
  HEARTBEAT_QUIET_START, HEARTBEAT_QUIET_END,
  store, saveStore, nextId, newSessionId, normalizeSession, normalizeSettings, normalizeAvatar, normalizeDateOnly,
  publicSettings, publicSession, applySettingsRename, agentStatus,
};
