import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInScopeOrder, newTiming, tmark, latencySegments, formatLatency } from './lib/scope-fifo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
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
const sseClients = new Set();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let store = loadStore();
ensureSeedData();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    const status = err && err.statusCode ? err.statusCode : 500;
    if (status >= 500) console.error(err);
    sendJson(res, status, {
      error: err && err.errorCode ? err.errorCode : 'internal_error',
      message: err && err.message ? err.message : 'internal error',
    });
  });
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Unable to start CC Companion: port ${PORT} is already in use.`);
    console.error('Set PORT to another available port in .env (for example PORT=8799) and start again.');
    process.exitCode = 1;
    return;
  }
  console.error(`Unable to start CC Companion: ${err.message}`);
  process.exitCode = 1;
});

server.listen(PORT, () => {
  addConsoleEvent('system', '服务已启动', `正在监听 http://localhost:${PORT}`);
  console.log(`CC Companion listening on http://localhost:${PORT}`);
  if (HEARTBEAT_ENABLED) {
    setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MINUTES * 60 * 1000);
    console.log(`Heartbeat enabled: every ${HEARTBEAT_INTERVAL_MINUTES} min, min idle ${HEARTBEAT_MIN_IDLE_MINUTES} min, quiet ${HEARTBEAT_QUIET_START}:00-${HEARTBEAT_QUIET_END}:00.`);
  }
  startQuickTunnel();
  scheduleBackfill(); // backfill memories/documents loaded from disk that predate embeddings (no-op without a model)
});

// TUNNEL=quick: expose the app on a public HTTPS URL via a Cloudflare quick
// tunnel, so the phone can reach it from anywhere while the computer is on —
// no same-WiFi requirement, no account needed. Requires the free `cloudflared`
// binary on PATH.
function startQuickTunnel() {
  if (String(process.env.TUNNEL || '').trim().toLowerCase() !== 'quick') return;
  let announced = false;
  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sniff = (chunk) => {
    if (announced) return;
    const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!match) return;
    announced = true;
    console.log(`[tunnel] 手机随时随地可访问：${match[0]}`);
    addConsoleEvent('system', '外网地址', `${match[0]} —— 电脑开着就能从任何网络访问（重启会换新地址）`);
    if (!AUTH_TOKEN) {
      console.warn('[tunnel] 警告：未设置 APP_AUTH_TOKEN，任何拿到链接的人都能使用你的 AI！强烈建议在 .env 里设置口令。');
      addConsoleEvent('error', '安全提醒', '公网隧道已开但没有设置 APP_AUTH_TOKEN，强烈建议在 .env 里加上口令再分享链接');
    }
  };
  child.stdout.on('data', sniff);
  child.stderr.on('data', sniff);
  child.on('error', () => {
    console.warn('[tunnel] 未找到 cloudflared。安装（免费）：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    addConsoleEvent('error', '隧道未启动', 'TUNNEL=quick 需要 cloudflared，安装后重启服务即可');
  });
  child.on('exit', (code) => {
    if (announced) addConsoleEvent('system', '隧道已断开', `cloudflared 退出（code ${code == null ? '?' : code}），重启服务可重新打开`);
  });
  // cloudflared is not killed automatically with its parent — clean it up on
  // exit/Ctrl+C so a dead server doesn't leave a live tunnel behind.
  const stopTunnel = () => { try { child.kill(); } catch (err) { /* ignore */ } };
  process.on('exit', stopTunnel);
  process.on('SIGINT', () => { stopTunnel(); process.exit(0); });
  process.on('SIGTERM', () => { stopTunnel(); process.exit(0); });
}

async function handleRequest(req, res) {
  setCommonHeaders(res);
  if (req.method === 'OPTIONS') return endNoContent(res);

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const route = normalizeRoute(url.pathname);

  if ((route.startsWith('/api/') || route.startsWith('/uploads/')) && !isAuthorized(req, url)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  if (req.method === 'GET' && route === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      name: 'cc-companion-app',
      storage: STORE_FILE,
      session: publicSession(),
      agent: agentStatus(),
    });
  }

  if (req.method === 'GET' && (route === '/api/stream' || route === '/api/group/stream' || route === '/api/chat/stream')) {
    return handleSseStream(req, res, streamScopeForRoute(route));
  }

  if (req.method === 'GET' && route === '/api/bootstrap') {
    return sendJson(res, 200, {
      settings: publicSettings(),
      chat: latestMessages('chat'),
      group: latestMessages('group'),
      console: latestConsoleEvents(),
      memories: listMemories(url.searchParams.get('q') || ''),
      session: publicSession(),
    });
  }

  if (req.method === 'GET' && route === '/api/settings') {
    return sendJson(res, 200, publicSettings());
  }

  if (req.method === 'GET' && route === '/api/quota') {
    const result = await queryQuota({ recordEvent: false });
    return sendJson(res, 200, { ok: true, quota: result.quota });
  }

  if (req.method === 'POST' && route === '/api/settings') {
    const body = await readJson(req);
    const previous = store.settings;
    store.settings = normalizeSettings({ ...store.settings, ...body });
    applySettingsRename(previous, store.settings);
    saveStore();
    addConsoleEvent('settings', '设置已更新', '应用设置已保存。');
    const settings = publicSettings();
    broadcastSse('settings', { settings });
    return sendJson(res, 200, settings);
  }

  if (req.method === 'GET' && route === '/api/chat/messages') {
    return sendJson(res, 200, latestMessages('chat', Number(url.searchParams.get('limit') || 80)));
  }

  if (req.method === 'GET' && route === '/api/group/messages') {
    return sendJson(res, 200, latestMessages('group', Number(url.searchParams.get('limit') || 80)));
  }

  if (req.method === 'POST' && route === '/api/chat/send') {
    return handleSend(res, 'chat', await readJson(req));
  }

  if (req.method === 'POST' && route === '/api/group/send') {
    return handleSend(res, 'group', await readJson(req));
  }

  const favoriteMatch = route.match(/^\/api\/(chat|group)\/messages\/(\d+)\/favorite$/);
  if (favoriteMatch && req.method === 'POST') {
    const body = await readJson(req);
    const message = setMessageFavorite(favoriteMatch[1], Number(favoriteMatch[2]), body.favorited !== false);
    if (!message) return sendJson(res, 404, { error: 'message_not_found' });
    return sendJson(res, 200, message);
  }

  const recallMatch = route.match(/^\/api\/(chat|group)\/messages\/(\d+)\/recall$/);
  if (recallMatch && req.method === 'POST') {
    const message = recallMessage(recallMatch[1], Number(recallMatch[2]));
    if (!message) return sendJson(res, 404, { error: 'message_not_found' });
    return sendJson(res, 200, message);
  }

  const deleteMessageMatch = route.match(/^\/api\/(chat|group)\/messages\/(\d+)$/);
  if (deleteMessageMatch && req.method === 'DELETE') {
    if (!AUTH_TOKEN) return sendJson(res, 403, { error: 'auth_required', message: '设置 APP_AUTH_TOKEN 后才能删除消息' });
    const ok = deleteMessage(deleteMessageMatch[1], Number(deleteMessageMatch[2]));
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'message_not_found' });
  }

  if (req.method === 'DELETE' && (route === '/api/chat/messages' || route === '/api/group/messages')) {
    if (!AUTH_TOKEN) return sendJson(res, 403, { error: 'auth_required', message: '设置 APP_AUTH_TOKEN 后才能清空聊天记录' });
    const scope = route === '/api/group/messages' ? 'group' : 'chat';
    return sendJson(res, 200, { ok: true, cleared: clearMessages(scope) });
  }

  if (req.method === 'GET' && route === '/api/stickers') {
    return sendJson(res, 200, Array.isArray(store.stickers) ? store.stickers : []);
  }
  if (req.method === 'POST' && route === '/api/stickers') {
    return sendJson(res, 201, addSticker(await readJson(req)));
  }
  const stickerMatch = route.match(/^\/api\/stickers\/(\d+)$/);
  if (stickerMatch && req.method === 'DELETE') {
    const ok = deleteSticker(Number(stickerMatch[1]));
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'sticker_not_found' });
  }

  if (req.method === 'GET' && route === '/api/console/events') {
    return sendJson(res, 200, latestConsoleEvents(Number(url.searchParams.get('limit') || 120)));
  }

  if (req.method === 'POST' && route === '/api/console/events') {
    const body = await readJson(req);
    const event = addConsoleEvent(body.kind || 'note', body.title || 'note', body.body || body.text || '');
    return sendJson(res, 201, event);
  }

  if (req.method === 'POST' && route === '/api/console/commands') {
    const body = await readJson(req);
    return sendJson(res, 201, await handleConsoleCommand(body.command || body.text || ''));
  }

  if (req.method === 'GET' && route === '/api/memory') {
    return sendJson(res, 200, listMemories({
      q: url.searchParams.get('q') || '',
      tag: url.searchParams.get('tag') || '',
      sort: url.searchParams.get('sort') || '',
      limit: url.searchParams.get('limit') || '',
    }));
  }

  if (req.method === 'POST' && route === '/api/memory') {
    const body = await readJson(req);
    const memory = createMemory(body);
    return sendJson(res, 201, memory);
  }

  if (req.method === 'GET' && route === '/api/memory/export') {
    return sendJson(res, 200, { memories: listMemories({ limit: 500 }), exported_at: new Date().toISOString() });
  }

  if (req.method === 'POST' && route === '/api/memory/import') {
    const body = await readJson(req);
    const memories = importMemories(body.memories || body.items || []);
    return sendJson(res, 201, { ok: true, imported: memories.length, memories });
  }

  if (req.method === 'GET' && route === '/api/documents') {
    return sendJson(res, 200, store.documents.map((doc) => publicDocument(doc)));
  }

  if (req.method === 'POST' && route === '/api/documents') {
    return sendJson(res, 201, createDocument(await readJson(req)));
  }

  const documentMatch = route.match(/^\/api\/documents\/(\d+)$/);
  if (documentMatch && req.method === 'GET') {
    const doc = store.documents.find((item) => item.id === Number(documentMatch[1]));
    if (!doc) return sendJson(res, 404, { error: 'document_not_found' });
    return sendJson(res, 200, publicDocument(doc, { full: true }));
  }

  if (documentMatch && req.method === 'PATCH') {
    const doc = updateDocument(Number(documentMatch[1]), await readJson(req));
    if (!doc) return sendJson(res, 404, { error: 'document_not_found' });
    return sendJson(res, 200, doc);
  }

  if (documentMatch && req.method === 'DELETE') {
    const ok = deleteDocument(Number(documentMatch[1]));
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'document_not_found' });
  }

  const memoryMatch = route.match(/^\/api\/memory\/(\d+)$/);
  if (memoryMatch && req.method === 'PATCH') {
    const memory = updateMemory(Number(memoryMatch[1]), await readJson(req));
    if (!memory) return sendJson(res, 404, { error: 'memory_not_found' });
    return sendJson(res, 200, memory);
  }

  if (memoryMatch && req.method === 'DELETE') {
    const ok = deleteMemory(Number(memoryMatch[1]));
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'memory_not_found' });
  }

  if (req.method === 'POST' && route === '/api/uploads') {
    return sendJson(res, 201, await saveUpload(await readJson(req)));
  }

  if (req.method === 'GET' && route.startsWith('/uploads/')) {
    return serveUpload(res, route);
  }

  if (req.method === 'GET') {
    return serveStatic(res, route);
  }

  sendJson(res, 404, { error: 'not_found' });
}

function handleSseStream(req, res, scope = 'all') {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const client = { res, scope };
  sseClients.add(client);
  writeSse(client, 'ready', { scope, now: new Date().toISOString() });
  writeSse(client, 'snapshot', streamSnapshot(scope));
  const keepAlive = setInterval(() => {
    writeSse(client, 'ping', { now: new Date().toISOString() });
  }, 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(client);
  });
}

function streamScopeForRoute(route) {
  if (route === '/api/group/stream') return 'group';
  if (route === '/api/chat/stream') return 'chat';
  return 'all';
}

function streamSnapshot(scope) {
  if (scope === 'group') return { scope, group: latestMessages('group') };
  if (scope === 'chat') return { scope, chat: latestMessages('chat') };
  return {
    scope,
    settings: publicSettings(),
    chat: latestMessages('chat'),
    group: latestMessages('group'),
    console: latestConsoleEvents(),
    memories: listMemories(''),
    session: publicSession(),
  };
}

function broadcastSse(event, payload) {
  if (!sseClients.size) return;
  for (const client of Array.from(sseClients)) {
    if (!shouldSendToClient(client, event, payload)) continue;
    writeSse(client, event, payload);
  }
}

function shouldSendToClient(client, event, payload) {
  if (!client || client.scope === 'all') return true;
  if (event === 'message') return payload && payload.scope === client.scope;
  if (event === 'snapshot') return payload && payload.scope === client.scope;
  return false;
}

function writeSse(client, event, payload) {
  try {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    sseClients.delete(client);
  }
}

async function handleSend(res, scope, body) {
  const timing = newTiming();
  const settings = store.settings;
  const sender = cleanString(body.sender, settings.userName);
  const outgoing = normalizeOutgoingMessages(body);
  if (!outgoing.length) {
    return sendJson(res, 400, { error: 'empty_message' });
  }

  const messages = outgoing.map((item) => addMessage(scope, {
    sender,
    role: 'user',
    content: item.content,
    attachments: item.attachments,
    parent_msg_id: body.reply_to_id || body.parent_msg_id || null,
    msg_type: 'chat',
  }));

  const combinedContent = messages.map((message) => message.content).filter(Boolean).join('\n');
  let queued = false;
  if (scope === 'chat' || shouldReplyInGroup(combinedContent)) {
    const replySource = { ...messages[messages.length - 1], content: combinedContent, turn_first_id: messages[0].id };
    queued = true;
    // Async ack: acknowledge the send immediately and produce the reply in the background.
    // Ordering is still guaranteed per scope by runInScopeOrder (concurrent same-scope sends reply
    // in arrival order; different scopes run concurrently). The finished assistant message reaches
    // clients through addMessage → SSE, so we never await it on the request path.
    runInScopeOrder(scope, () => {
      tmark(timing, 'processStart'); // FIFO acquired — admission (queue wait) ends here
      return generateAgentReply(scope, replySource, timing);
    }).then(
      () => {
        try { console.log(formatLatency(scope, latencySegments(timing))); } catch { /* logging must never break */ }
        scheduleBackfill(); // embedding backfill runs off the request hot path
      },
      (err) => {
        // A background task must never surface as an unhandled rejection. generateAgentReply already
        // converts agent errors into a fallback reply, so this only fires on truly unexpected faults.
        try { addConsoleEvent('error', '后台回复失败', (err && err.message) ? err.message : String(err)); } catch { /* noop */ }
      },
    );
  }

  sendJson(res, 201, { ok: true, messages, message: messages[0], reply: null, queued });
}

async function generateAgentReply(scope, userMessage, timing) {
  const settings = store.settings;
  const assistantName = settings.assistantName || 'Assistant';
  addConsoleEvent('received', scope === 'group' ? '群聊消息' : '私聊消息', userMessage.content || '[附件]');
  addConsoleEvent('thinking', assistantName, '正在生成回复...');

  let content = '';
  let thinking = '';
  try {
    const result = await callConfiguredAgent(scope, userMessage, timing);
    content = result.content;
    thinking = result.thinking || '';
  } catch (err) {
    addConsoleEvent('error', 'AI 调用失败', err.message);
    content = `暂时无法调用已配置的 AI：${err.message}`;
  }

  const reply = addMessage(scope, {
    sender: assistantName,
    role: 'assistant',
    content,
    thinking,
    attachments: [],
    parent_msg_id: userMessage.id,
    msg_type: 'chat',
  });
  tmark(timing, 'finalEnd');
  addConsoleEvent('reply', assistantName, content);
  maybeExtractMemories(scope).catch(() => {});
  return reply;
}

const MEMORY_STOPWORDS = new Set([
  '的', '了', '和', '是', '我', '你', '他', '她', '它', '们', '在', '有', '这', '那', '就', '都', '也', '要', '不', '吗',
  '呢', '啊', '吧', '与', '之', '对', '把', '被', '让', '给', '很', '哦', '嗯', '个', '会', '能', '说', '想', '到', '去',
  '来', '过', '着', '呀', '的话',
  'the', 'a', 'an', 'is', 'are', 'am', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'it', 'i', 'you', 'me', 'my', 'your',
  'we', 'this', 'that', 'for', 'with', 'as', 'be', 'so', 'do', 'if', 'was', 'were', 'not', 'but', 'can',
]);

// Tokenize for lightweight relevance scoring, no NLP dependency: latin words plus CJK single chars
// and adjacent-character bigrams (bigrams stand in for word segmentation on Chinese text).
function memoryTokens(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) {
    if (!MEMORY_STOPWORDS.has(w)) tokens.push(w);
  }
  const cjk = s.match(/[一-鿿]/g) || [];
  for (let i = 0; i < cjk.length; i += 1) {
    if (!MEMORY_STOPWORDS.has(cjk[i])) tokens.push(cjk[i]);
    if (i + 1 < cjk.length) tokens.push(cjk[i] + cjk[i + 1]);
  }
  return tokens;
}

function dedupeMemories(list) {
  const seen = new Set();
  const out = [];
  for (const memory of list) {
    if (!memory) continue;
    const id = memory.id;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(memory);
  }
  return out;
}

// Pick the memories most relevant to the current message instead of just the most recent N.
// Score = token overlap weighted by inverse document frequency (distinctive words matter more than
// common ones). Pinned memories are always kept; a query with no usable terms (bare greeting) falls
// back to the most recent memories.
// Semantic recall (opt-in): set EMBEDDING_MODEL (an OpenAI-compatible
// /embeddings model, e.g. text-embedding-3-small) to score memories by
// meaning instead of token overlap. Falls back to lexical recall whenever
// embeddings are unavailable or any call fails.
const EMBEDDING_MODEL = String(process.env.EMBEDDING_MODEL || '').trim();
const EMBEDDING_DIMENSIONS = Math.max(0, Number(process.env.EMBEDDING_DIMENSIONS || 0));
const EMBEDDING_TAG = EMBEDDING_MODEL ? `${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS || 'native'}` : '';
const BACKFILL_MAX_ROUNDS = 2000; // ≤64 items/round → ~128k-item backstop; the zero-write break ends it far sooner

// A memory/chunk is "embeddable" only with non-empty source text; the backfill skips empty ones, so they
// must not count toward corpus readiness (else one empty row would block semantic recall forever).
const memoryEmbeddable = (m) => !!cleanString(`${(m && m.title) || ''}${(m && m.content) || ''}`, '');
const chunkEmbeddable = (c) => !!cleanString((c && c.text) || '', '');

// A corpus is "ready" only when EVERY embeddable item already carries a current-tag vector. Semantic
// recall and the per-turn shared query embed both gate on this: an empty or partially-backfilled corpus
// fails open to lexical, so a newly-added (not-yet-embedded) item is never silently dropped from results.
function memoryCorpusReady() {
  if (!EMBEDDING_MODEL) return false;
  const eligible = store.memories.filter(memoryEmbeddable);
  return eligible.length > 0 && eligible.every((m) => m.embedding_tag === EMBEDDING_TAG && m.embedding_b64);
}
function docCorpusReady() {
  if (!EMBEDDING_MODEL) return false;
  let any = false;
  for (const doc of store.documents) {
    for (const chunk of doc.chunks || []) {
      if (!chunkEmbeddable(chunk)) continue;
      any = true;
      if (chunk.embedding_tag !== EMBEDDING_TAG || !chunk.embedding_b64) return false;
    }
  }
  return any;
}

async function recallMemories(queryText, limit = MEMORY_RECALL_LIMIT, sharedQueryVec = undefined) {
  const semantic = await semanticRecall(queryText, limit, sharedQueryVec);
  return semantic || selectRelevantMemories(queryText, limit);
}

// Older memories fade in recall (never to zero); pinned ones don't age.
function memoryRecencyFactor(memory) {
  if (memory && memory.pinned) return 1;
  const stamp = Date.parse((memory && (memory.updated_at || memory.created_at)) || '') || Date.now();
  const ageDays = Math.max(0, (Date.now() - stamp) / 86400000);
  return 0.65 + 0.35 * Math.exp(-ageDays / 180);
}

// Recall works a lot better with a little topic continuity: follow-ups like
// "那后来呢" carry no content words, so blend the last couple of user
// messages into the recall query.
function recallQueryFor(scope, userMessage) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const upper = Number(userMessage.turn_first_id || userMessage.id) || Infinity;
  const recent = store[key]
    .filter((m) => m.role === 'user' && m.id < upper && cleanString(m.content, ''))
    .slice(-2)
    .map((m) => m.content);
  return [...recent, userMessage.content || ''].join('\n').slice(-1500);
}

// Containment-style similarity for dedupe: how much of the smaller token set
// is inside the other.
function memorySimilarity(textA, textB) {
  const setA = new Set(memoryTokens(textA));
  const setB = new Set(memoryTokens(textB));
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  for (const token of setA) if (setB.has(token)) overlap += 1;
  return overlap / Math.min(setA.size, setB.size);
}

function findSimilarMemory(text) {
  let best = 0;
  let hit = null;
  for (const memory of store.memories) {
    const score = memorySimilarity(text, `${memory.title || ''} ${memory.content || ''}`);
    if (score > best) {
      best = score;
      hit = memory;
    }
  }
  return best >= 0.6 ? hit : null;
}

function parseExtractedMemories(raw) {
  const match = String(raw || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch (err) {
    return [];
  }
}

// After enough fresh conversation, ask the model to pull out stable facts
// worth remembering, dedupe them against the existing library, and save them
// as AI-authored memories. Fire-and-forget; never blocks the reply.
async function maybeExtractMemories(scope) {
  if (!MEMORY_EXTRACT_EVERY) return;
  // Extraction can run on its own (small/cheap) model via EXTRACT_*; each
  // falls back to the main OPENAI_* config. With EXTRACT_* set this also
  // works in Claude Code mode, where no main API key is configured.
  const apiKey = String(process.env.EXTRACT_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return;
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const cursorKey = scope === 'group' ? 'group' : 'chat';
  if (!store.memory_extract_cursor) store.memory_extract_cursor = { chat: 0, group: 0 };
  const cursor = Number(store.memory_extract_cursor[cursorKey]) || 0;
  const fresh = store[key].filter((m) => m.id > cursor && cleanString(m.content, ''));
  if (fresh.filter((m) => m.role === 'user').length < MEMORY_EXTRACT_EVERY) return;
  // Advance the cursor before calling out so a failing span is never retried in a loop.
  store.memory_extract_cursor[cursorKey] = fresh[fresh.length - 1].id;
  saveStore();
  const segment = fresh.slice(-40).map((m) => `${m.sender}: ${m.content}`).join('\n').slice(0, 6000);
  const baseUrl = String(process.env.EXTRACT_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = String(process.env.EXTRACT_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '从下面的聊天记录中提取值得长期记住的稳定信息（用户的偏好、事实、关系、重要事件）。输出 JSON 数组：[{"title":"...","content":"...","tags":["..."]}]。不要记临时状态、闲聊或一次性话题；没有值得记的就输出 []。只输出 JSON，不要解释。' },
          { role: 'user', content: segment },
        ],
        temperature: 0.2,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return;
    const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    let saved = 0;
    for (const item of parseExtractedMemories(raw).slice(0, 5)) {
      const title = cleanString(item.title, '');
      const content = cleanString(item.content, '');
      if (!title && !content) continue;
      if (findSimilarMemory(`${title} ${content}`)) continue;
      createMemory({
        title: title || truncate(content, 40),
        content,
        tags: [...(Array.isArray(item.tags) ? item.tags : []), 'auto'],
        author: store.settings.assistantName || 'AI',
      });
      saved += 1;
    }
    if (saved) addConsoleEvent('memory', '自动记忆', `从最近对话提取了 ${saved} 条`);
  } finally {
    clearTimeout(timeout);
  }
}

async function embedTexts(texts) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey || !EMBEDDING_MODEL || !texts.length) return null;
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const body = { model: EMBEDDING_MODEL, input: texts };
    if (EMBEDDING_DIMENSIONS) body.dimensions = EMBEDDING_DIMENSIONS;
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.data)) return null;
    return data.data.map((item) => item.embedding);
  } finally {
    clearTimeout(timeout);
  }
}

// Embed the recall query at most once. callConfiguredAgent computes this a single time per turn and
// shares the result with both memory and document recall (single-flight), so the query never gets
// embedded twice for one message.
async function embedQueryVec(query) {
  const q = cleanString(query, '');
  if (!EMBEDDING_MODEL || !q) return null;
  try {
    const vectors = await embedTexts([q.slice(0, 2000)]);
    return (vectors && vectors[0]) ? new Float32Array(vectors[0]) : null;
  } catch {
    // embedTexts throws on connection-level failure / DNS / the 20s abort. Fail open to lexical here so
    // a slow or down embedding provider can never crash or stall the whole turn (tri-state: null). This
    // is the single choke point every recall shares, so one guard covers all call sites.
    return null;
  }
}

function vecToB64(vec) {
  return Buffer.from(new Float32Array(vec).buffer).toString('base64');
}

function b64ToVec(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

function cosineSim(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const memorySourceText = (m) => `${m.title || ''}\n${m.content || ''}`.slice(0, 2000);

async function ensureMemoryEmbeddings() {
  if (!EMBEDDING_MODEL) return 0;
  const missing = store.memories
    .filter((m) => memoryEmbeddable(m) && m.embedding_tag !== EMBEDDING_TAG)
    .slice(0, 64);
  if (!missing.length) return 0;
  // Capture the exact source each vector is computed from. embedTexts is awaited, and a memory can
  // be edited or deleted meanwhile — we must never write a vector back onto content it no longer
  // matches (a stale/dirty vector), nor onto a memory that has since been removed.
  const sources = missing.map(memorySourceText);
  const vectors = await embedTexts(sources);
  if (!vectors || vectors.length !== missing.length) return 0;
  let wrote = 0;
  missing.forEach((memory, index) => {
    if (!store.memories.includes(memory)) return;             // deleted during the await
    if (memorySourceText(memory) !== sources[index]) return;  // source changed during the await
    memory.embedding_b64 = vecToB64(vectors[index]);
    memory.embedding_tag = EMBEDDING_TAG;
    wrote += 1;
  });
  if (wrote) saveStore();
  return wrote; // caller drains in batches until a pass writes 0
}

// Single-flight background embedding backfill: kept OFF the request hot path. Recall reads only
// already-ready vectors and fails open to lexical scoring until this catches up. Triggered at startup
// and on every memory/document create/update so bulk imports and edits fully backfill on their own,
// not only after the next chat turn.
let backfillInFlight = null;
let backfillDirty = false; // set when a trigger arrives mid-drain → forces one more sweep so nothing is missed
function scheduleBackfill() {
  if (!EMBEDDING_MODEL) return null; // nothing to embed without a configured model
  if (backfillInFlight) { backfillDirty = true; return backfillInFlight; }
  backfillInFlight = (async () => {
    try {
      do {
        backfillDirty = false;
        // Drain in bounded ≤64 batches until a full pass writes nothing (caught up) or a round throws
        // (provider down). Stopping on a zero-write pass guarantees a persistently-failing or perpetually-
        // stale item can never spin this loop.
        for (let round = 0; round < BACKFILL_MAX_ROUNDS; round += 1) {
          let wrote = 0;
          try {
            wrote += await ensureMemoryEmbeddings();
            wrote += await ensureDocumentEmbeddings();
          } catch { backfillDirty = false; break; } // provider error → stop (don't spin); next trigger retries
          if (!wrote) break;
        }
      } while (backfillDirty); // a create/update landed during the drain → sweep once more to catch it
    } finally { backfillInFlight = null; }
  })();
  backfillInFlight.catch(() => {}); // never an unhandled rejection
  return backfillInFlight;
}

async function semanticRecall(queryText, limit = MEMORY_RECALL_LIMIT, sharedQueryVec = undefined) {
  if (!EMBEDDING_MODEL) return null;
  const query = cleanString(queryText, '');
  if (!query || !store.memories.length) return null;
  try {
    // Backfill runs in the background (scheduleBackfill); recall only reads already-ready vectors and
    // fails open to lexical scoring when none are ready yet — the request hot path never waits on it.
    // Symmetric with document recall: only score semantically when the WHOLE eligible corpus is
    // backfilled. On a partial set we'd silently drop every not-yet-embedded memory, so fall open to
    // lexical (which sees all of them) until backfill catches up.
    if (!memoryCorpusReady()) return null;
    const embedded = store.memories.filter((m) => m.embedding_tag === EMBEDDING_TAG && m.embedding_b64);
    // Single-flight: reuse the shared query vector when provided (explicit null = embed already tried
    // and failed → fall open to lexical); only embed here on a direct call (sharedQueryVec undefined).
    const queryVec = (sharedQueryVec !== undefined) ? sharedQueryVec : await embedQueryVec(query);
    if (!queryVec) return null;
    const cap = Math.max(1, Number(limit) || MEMORY_RECALL_LIMIT);
    const scored = embedded
      .map((memory) => ({ memory, score: cosineSim(queryVec, b64ToVec(memory.embedding_b64)) * memoryRecencyFactor(memory) }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.memory);
    const pinned = store.memories.filter((m) => m && m.pinned);
    return dedupeMemories([...pinned, ...scored]).slice(0, cap);
  } catch (err) {
    return null;
  }
}

function selectRelevantMemories(queryText, limit = MEMORY_RECALL_LIMIT) {
  const memories = Array.isArray(store.memories) ? store.memories : [];
  if (!memories.length) return [];
  const cap = Math.max(1, Number(limit) || MEMORY_RECALL_LIMIT);
  const pinned = memories.filter((m) => m && m.pinned);
  const queryTerms = new Set(memoryTokens(queryText));
  if (!queryTerms.size) {
    return dedupeMemories([...pinned, ...memories.slice(-cap)]).slice(0, cap);
  }
  const df = new Map();
  const tokenSets = memories.map((m) => {
    const set = new Set(memoryTokens(`${m.title || ''} ${m.content || ''} ${(m.tags || []).join(' ')}`));
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
    return set;
  });
  const total = memories.length;
  const scored = memories.map((memory, order) => {
    let score = 0;
    for (const term of queryTerms) {
      if (tokenSets[order].has(term)) {
        const idf = Math.log(1 + total / (1 + (df.get(term) || 0)));
        score += idf * (term.length > 1 ? 1.6 : 1);
      }
    }
    return { memory, score: score * memoryRecencyFactor(memory), order };
  });
  scored.sort((a, b) => (b.score - a.score) || (b.order - a.order));
  const relevant = scored.filter((entry) => entry.score > 0).map((entry) => entry.memory);
  return dedupeMemories([...pinned, ...relevant]).slice(0, cap);
}

// Conversation history for the model, structured to stay prompt-cache friendly:
// everything before the changing tail must be byte-stable across turns, so the
// window is trimmed with a persisted anchor that only advances in batches
// (never a per-turn sliding window), and per-turn recall is kept OUT of this
// stable prefix.
function contextHistory(scope, beforeId) {
  if (!CHAT_CONTEXT_MAX) return [];
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const anchorKey = scope === 'group' ? 'group' : 'chat';
  if (!store.context_anchor) store.context_anchor = { chat: 0, group: 0 };
  const anchor = Number(store.context_anchor[anchorKey]) || 0;
  const upper = Number(beforeId) || Infinity;
  const eligible = store[key].filter((m) => m.id > anchor && m.id < upper && cleanString(m.content, ''));
  const toTurn = (m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: scope === 'group' && m.role !== 'assistant' ? `${m.sender}: ${m.content}` : m.content,
  });
  if (eligible.length > CHAT_CONTEXT_MAX) {
    const kept = eligible.slice(-CHAT_CONTEXT_KEEP);
    store.context_anchor[anchorKey] = eligible[eligible.length - CHAT_CONTEXT_KEEP - 1].id;
    saveStore();
    return kept.map(toTurn);
  }
  return eligible.map(toTurn);
}

async function callConfiguredAgent(scope, userMessage, timing) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return { content: mockReply(scope, userMessage), thinking: '（演示思考）当前是内置 mock agent。配置一个会返回推理内容的模型（例如 deepseek-reasoner）后，这里会显示它真实的思考过程。' };

  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = String(process.env.OPENAI_MODEL || 'gpt-4.1-mini');
  // Static system block only — per-turn recall lives in a separate message at
  // the tail so the cached prefix (system + old history) stays byte-identical.
  const system = [
    `你是 ${store.settings.assistantName || 'AI'}，运行在一个自部署 AI 伴侣聊天 App 里。`,
    '请用清楚、简短、自然的中文回复。',
  ].join('\n\n');
  tmark(timing, 'recallStart');
  let history;
  let memories = '';
  let docsBlock = '';
  try {
    history = contextHistory(scope, userMessage.turn_first_id || userMessage.id);
    const recallQuery = recallQueryFor(scope, userMessage);
    // Single-flight query embedding: embed the recall query at most once per turn AND only when it can
    // actually be used — i.e. at least one corpus (memory or docs) is fully backfilled. An empty or
    // partially-embedded corpus falls open to lexical, so paying the (up to 20s) embed here would be pure
    // latency on the final reply. null = "don't embed" → both recalls score lexically. Docs only count
    // when doc recall is actually enabled (DOC_RECALL_LIMIT > 0): a ready doc corpus with recall disabled
    // must not trigger a query embed that recallDocumentChunks then skips (limit 0 → early return).
    const sharedQueryVec = (EMBEDDING_MODEL && (memoryCorpusReady() || (DOC_RECALL_LIMIT > 0 && docCorpusReady())))
      ? await embedQueryVec(recallQuery)
      : null;
    const [mem, docChunks] = await Promise.all([
      recallMemories(recallQuery, MEMORY_RECALL_LIMIT, sharedQueryVec),
      recallDocumentChunks(recallQuery, DOC_RECALL_LIMIT, sharedQueryVec),
    ]);
    memories = mem.map((m) => `- ${m.title}: ${m.content}`).join('\n');
    docsBlock = docChunks.map((chunk) => `【${chunk.name}】${chunk.text}`).join('\n---\n');
  } finally {
    // Guarantee the recall segment is observable even when recall throws (the error path is the
    // one we most want measured). The original exception still propagates.
    tmark(timing, 'recallEnd');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  let response;
  let data = {};
  tmark(timing, 'agentStart');
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          ...history,
          ...(docsBlock ? [{ role: 'system', content: `参考资料（供参考）：\n${docsBlock}` }] : []),
          ...(memories ? [{ role: 'system', content: `相关记忆（供参考）：\n${memories}` }] : []),
          {
            role: 'user',
            content: (scope === 'group' ? `${userMessage.sender}: ` : '') + (userMessage.content || '[attachment]'),
          },
        ],
        temperature: 0.7,
      }),
    });
    data = await response.json().catch(() => ({}));
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`Agent API timed out after ${AGENT_TIMEOUT_MS} ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
    // Guarantee the agent segment is observable on the error path too (network refused / abort /
    // parse), which is exactly when it used to go missing. The original exception still propagates.
    tmark(timing, 'agentEnd');
  }

  if (!response.ok) {
    const message = data && data.error && data.error.message ? data.error.message : `HTTP ${response.status}`;
    throw new Error(message);
  }
  const replyMessage = data && data.choices && data.choices[0] && data.choices[0].message;
  const text = replyMessage ? replyMessage.content : '';
  // Reasoning models that speak the OpenAI shape expose their thinking here (DeepSeek-R1 uses
  // reasoning_content; some gateways use reasoning). Empty for normal chat models.
  const thinking = replyMessage ? (replyMessage.reasoning_content || replyMessage.reasoning || '') : '';
  return { content: cleanString(text, mockReply(scope, userMessage)), thinking: cleanString(thinking, '') };
}

function mockReply(scope, userMessage) {
  const memories = selectRelevantMemories(userMessage.content, 3).map((m) => m.title).filter(Boolean);
  const memoryHint = memories.length ? ` 我也能看到这些记忆：${memories.join('、')}。` : '';
  const place = scope === 'group' ? '群聊' : '私聊';
  const quoted = userMessage.content ? `“${truncate(userMessage.content, 160)}”` : '你的附件';
  return `演示 AI 在${place}里收到了${quoted}。${memoryHint}在 .env 里设置 OPENAI_API_KEY 后，就会切换成真实模型回复。`;
}

function shouldReplyInGroup(content) {
  if (String(process.env.AUTO_REPLY_GROUP || '').toLowerCase() === 'true') return true;
  if (store.settings.autoReplyGroup === true) return true;
  const text = String(content || '').toLowerCase();
  const mention = String(store.settings.agentMention || 'assistant').toLowerCase();
  return text.includes(`@${mention}`) || text.includes('@assistant') || text.includes('@agent') || text.includes('@codex');
}

function normalizeOutgoingMessages(body) {
  const source = Array.isArray(body.messages) && body.messages.length
    ? body.messages
    : [{ content: body.content, attachments: body.attachments }];
  return source.map((item) => {
    const input = item && typeof item === 'object' ? item : { content: item };
    return {
      content: cleanString(input.content, ''),
      attachments: normalizeAttachments(input.attachments),
    };
  }).filter((item) => item.content || item.attachments.length);
}

function heartbeatInQuietHours(now = new Date()) {
  if (HEARTBEAT_QUIET_START === HEARTBEAT_QUIET_END) return false;
  const h = now.getHours();
  if (HEARTBEAT_QUIET_START < HEARTBEAT_QUIET_END) return h >= HEARTBEAT_QUIET_START && h < HEARTBEAT_QUIET_END;
  return h >= HEARTBEAT_QUIET_START || h < HEARTBEAT_QUIET_END; // wraps midnight (e.g. 22-6)
}

async function heartbeatDecision() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = String(process.env.OPENAI_MODEL || 'gpt-4.1-mini');
  const recent = store.chat_messages.slice(-6).map((m) => `${m.sender}: ${m.content}`).join('\n');
  const memories = selectRelevantMemories('', 6).map((m) => `- ${m.title}: ${m.content}`).join('\n');
  const system = [
    `你是 ${store.settings.assistantName || 'AI'}，${store.settings.userName || '对方'} 的 AI 伴侣。`,
    '现在已经安静了一会儿。你可以【主动】给对方发一句简短、温暖、自然的话：一个想法、一句关心、或你想起的一件小事。',
    '如果此刻你并不想主动开口，就只回复 SKIP，不要有别的字。',
    '想说就直接说那句话，简短自然，不要解释你在做什么。',
    memories ? `你记得：\n${memories}` : '',
    recent ? `最近的对话：\n${recent}` : '',
  ].filter(Boolean).join('\n\n');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: '（心跳）现在，你想对我说点什么吗？' }],
        temperature: 0.9,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return '';
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    return cleanString(msg ? msg.content : '', '');
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

async function heartbeatTick(opts = {}) {
  try {
    if (!opts.force && heartbeatInQuietHours()) return;
    const last = store.chat_messages[store.chat_messages.length - 1];
    const idleMinutes = last ? (Date.now() - Date.parse(last.created_at)) / 60000 : Infinity;
    if (!opts.force && idleMinutes < HEARTBEAT_MIN_IDLE_MINUTES) return; // do not interrupt an active conversation
    const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
    let content = '';
    if (!apiKey) {
      if (opts.force || Math.random() < 0.5) content = '（心跳演示）在想你。配置真实模型后，我会自己判断要不要主动找你说话。';
    } else {
      const decision = await heartbeatDecision();
      if (decision && decision.trim().toUpperCase() !== 'SKIP') content = decision.trim();
    }
    if (!content) {
      addConsoleEvent('heartbeat', '心跳', '这次没有主动开口。');
      return;
    }
    addMessage('chat', { sender: store.settings.assistantName || 'AI', role: 'assistant', content, msg_type: 'heartbeat' });
    addConsoleEvent('heartbeat', '主动消息', content);
  } catch (err) {
    addConsoleEvent('error', 'heartbeat 失败', err && err.message);
  }
}

function addMessage(scope, input) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const message = {
    id: nextId('message'),
    scope,
    sender: cleanString(input.sender, 'unknown'),
    role: input.role === 'assistant' ? 'assistant' : 'user',
    content: cleanString(input.content, ''),
    thinking: cleanString(input.thinking, ''),
    attachments: normalizeAttachments(input.attachments),
    parent_msg_id: input.parent_msg_id == null ? null : Number(input.parent_msg_id),
    msg_type: input.msg_type || 'chat',
    session_id: cleanString(input.session_id, store.session && store.session.current_id || ''),
    created_at: new Date().toISOString(),
  };
  store[key].push(message);
  saveStore();
  broadcastSse('message', { scope, message: publicMessage(message) });
  return message;
}

function latestMessages(scope, limit = 80) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  return store[key].slice(-clampLimit(limit)).map(publicMessage);
}

function addSticker(input) {
  if (!Array.isArray(store.stickers)) store.stickers = [];
  const sticker = {
    id: nextId('sticker'),
    url: cleanString(input && input.url, ''),
    name: cleanString(input && input.name, 'sticker'),
    type: cleanString(input && input.type, 'image/png'),
    width: Number(input && input.width) || null,
    height: Number(input && input.height) || null,
    created_at: new Date().toISOString(),
  };
  store.stickers.push(sticker);
  saveStore();
  broadcastSse('stickers', { stickers: store.stickers });
  return sticker;
}

function deleteSticker(id) {
  if (!Array.isArray(store.stickers)) return false;
  const before = store.stickers.length;
  store.stickers = store.stickers.filter((s) => Number(s.id) !== Number(id));
  if (store.stickers.length === before) return false;
  saveStore();
  broadcastSse('stickers', { stickers: store.stickers });
  return true;
}

function setMessageFavorite(scope, id, favorited) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const message = store[key].find((m) => Number(m.id) === Number(id));
  if (!message) return null;
  message.favorited = !!favorited;
  saveStore();
  broadcastSse('message', { scope, message: publicMessage(message) });
  return publicMessage(message);
}

function recallMessage(scope, id) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const message = (store[key] || []).find((m) => Number(m.id) === Number(id));
  if (!message) return null;
  if (message.role !== 'user') return null;  // only the user's own messages are recallable (沈屿 #6676 P2)
  message.recalled = true;
  message.recalled_at = new Date().toISOString();
  saveStore();
  broadcastSse('message', { scope, message: publicMessage(message) });
  return publicMessage(message);
}

function deleteMessage(scope, id) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  if (!Array.isArray(store[key])) return false;
  const before = store[key].length;
  store[key] = store[key].filter((m) => Number(m.id) !== Number(id));
  if (store[key].length === before) return false;
  saveStore();
  broadcastSse('deleted', { scope, id: Number(id) });
  return true;
}

function clearMessages(scope) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const rows = Array.isArray(store[key]) ? store[key] : [];
  const count = rows.length;
  if (count) {
    // Undo path: dump what we're about to wipe, timestamped, so a misclick is recoverable. (沈屿 #6676 P1)
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(DATA_DIR, `cleared-${scope}-${stamp}.json`), JSON.stringify(rows, null, 2));
    } catch (err) {
      console.error('clearMessages backup failed:', err && err.message);
    }
  }
  store[key] = [];
  saveStore();
  broadcastSse('cleared', { scope });
  return count;
}

function publicMessage(message) {
  const out = { ...message, attachments: normalizeAttachments(message.attachments) };
  // A recalled message keeps its content in the store (trace) but must not leak it over the API. (沈屿 #6676 P1)
  if (out.recalled) { out.content = ''; out.attachments = []; }
  return out;
}

function publicMemory(memory) {
  const tags = normalizeTags(memory && memory.tags);
  return {
    id: Number(memory && memory.id) || 0,
    title: cleanString(memory && memory.title, 'Untitled memory'),
    content: cleanString(memory && memory.content, ''),
    mood: cleanString(memory && memory.mood, defaultMemoryMood(tags)),
    author: cleanString(memory && memory.author, store.settings.assistantName || 'AI'),
    tags,
    pinned: Boolean(memory && memory.pinned),
    created_at: cleanString(memory && memory.created_at, new Date().toISOString()),
    updated_at: cleanString(memory && memory.updated_at, memory && memory.created_at || new Date().toISOString()),
  };
}

function addConsoleEvent(kind, title, body = '') {
  const event = {
    id: nextId('console'),
    kind: cleanString(kind, 'event'),
    title: cleanString(title, 'event'),
    body: cleanString(body, ''),
    created_at: new Date().toISOString(),
  };
  store.console_events.push(event);
  if (store.console_events.length > 500) store.console_events = store.console_events.slice(-500);
  saveStore();
  broadcastSse('console', { event });
  return event;
}

function latestConsoleEvents(limit = 120) {
  return store.console_events.slice(-clampLimit(limit));
}

async function handleConsoleCommand(input) {
  const command = cleanString(input, '');
  if (!command) throw new HttpError(400, 'empty_command', 'command is required');
  if (command.trim().toLowerCase() === '/forge') {
    const result = await forgeSession();
    return { ok: true, event: result.event, forge: result, chat: latestMessages('chat'), group: latestMessages('group'), session: publicSession() };
  }
  if (command.trim().toLowerCase() === '/quota') {
    const result = await queryQuota({ recordEvent: true });
    return { ok: true, event: result.event, quota: result.quota };
  }
  if (command.trim().toLowerCase() === '/heartbeat') {
    await heartbeatTick({ force: true });
    const event = addConsoleEvent('command', '/heartbeat', '已触发一次主动心跳。');
    return { ok: true, event, chat: latestMessages('chat') };
  }
  if (command.trim().toLowerCase() === '/help') {
    const event = addConsoleEvent('command', '/help', '可用命令：/forge 清理本地历史并开一个新的会话段；/quota 查询用量（需配置 QUOTA_ADAPTER_URL）；/heartbeat 让 AI 现在主动说句话；/help 显示本帮助。');
    return { ok: true, event };
  }
  const event = addConsoleEvent('command', command.split(/\s+/, 1)[0] || 'command', command);
  return { ok: true, event };
}

async function queryQuota({ recordEvent = true } = {}) {
  if (!QUOTA_ADAPTER_URL) {
    const event = recordEvent
      ? addConsoleEvent('quota', '/quota 未配置', 'QUOTA_ADAPTER_URL is not set. Configure a quota adapter to fetch real remaining usage.')
      : null;
    return {
      event,
      quota: {
        configured: false,
        status: 'not_configured',
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

function isForgeKeepMessage(message) {
  if (!message || typeof message !== 'object') return false;
  const role = String(message.role || '').toLowerCase();
  const type = String(message.msg_type || 'chat').toLowerCase();
  if (role !== 'user' && role !== 'assistant') return false;
  if (type && type !== 'chat') return false;
  if (isNoiseMessage(message)) return false;
  return Boolean(cleanString(message.content, '') || normalizeAttachments(message.attachments).length);
}

function isNoiseMessage(message) {
  const type = String(message && message.msg_type || '').toLowerCase();
  const role = String(message && message.role || '').toLowerCase();
  const sender = String(message && message.sender || '').toLowerCase();
  const content = String(message && message.content || '').trim();
  const haystack = `${type}\n${role}\n${sender}\n${content.slice(0, 512)}`.toLowerCase();
  if (/(^|\b)(thinking|thought|tool|tool_use|tool_result|progress|debug|trace|command)(\b|$)/.test(haystack)) return true;
  if (content.startsWith('{')) {
    try {
      const parsed = JSON.parse(content);
      const kind = String(parsed.kind || parsed.type || '').toLowerCase();
      if (/(thinking|tool|progress|debug|trace|done)/.test(kind)) return true;
    } catch {
      // Keep ordinary JSON-looking text if it is not a known noise object.
    }
  }
  return false;
}

function createMemory(input) {
  const now = new Date().toISOString();
  const memory = {
    id: nextId('memory'),
    title: cleanString(input.title, 'Untitled memory'),
    content: cleanString(input.content, ''),
    mood: cleanString(input.mood, defaultMemoryMood(input.tags)),
    author: cleanString(input.author, store.settings.assistantName || 'AI'),
    tags: normalizeTags(input.tags),
    pinned: input.pinned === true,
    created_at: now,
    updated_at: now,
  };
  store.memories.push(memory);
  saveStore();
  addConsoleEvent('memory', '记忆已创建', memory.title);
  const output = publicMemory(memory);
  broadcastSse('memory', { action: 'created', memory: output });
  scheduleBackfill(); // embed the new memory in the background (no-op without a model)
  return output;
}

function updateMemory(id, input) {
  const memory = store.memories.find((item) => item.id === id);
  if (!memory) return null;
  const prevSource = memorySourceText(memory);
  if ('title' in input) memory.title = cleanString(input.title, memory.title);
  if ('content' in input) memory.content = cleanString(input.content, memory.content);
  if ('mood' in input) memory.mood = cleanString(input.mood, memory.mood || defaultMemoryMood(memory.tags));
  if ('author' in input) memory.author = cleanString(input.author, memory.author || store.settings.assistantName || 'AI');
  if ('tags' in input) memory.tags = normalizeTags(input.tags);
  if ('pinned' in input) memory.pinned = input.pinned === true;
  // Title+content feed the embedding vector; if either changed, the stored vector no longer matches the
  // text. Drop it so semantic recall can never score a stale vector against new content, and let backfill
  // recompute. (Also fixes a pre-existing bug: the old tag-match filter never re-embedded edited memories.)
  if (memorySourceText(memory) !== prevSource) {
    delete memory.embedding_tag;
    delete memory.embedding_b64;
  }
  memory.updated_at = new Date().toISOString();
  saveStore();
  addConsoleEvent('memory', '记忆已更新', memory.title);
  scheduleBackfill(); // re-embed the edited memory in the background (no-op without a model)
  const output = publicMemory(memory);
  broadcastSse('memory', { action: 'updated', memory: output });
  return output;
}

function deleteMemory(id) {
  const before = store.memories.length;
  store.memories = store.memories.filter((item) => item.id !== id);
  const ok = store.memories.length !== before;
  if (ok) {
    saveStore();
    addConsoleEvent('memory', '记忆已删除', `id ${id}`);
    broadcastSse('memory', { action: 'deleted', id });
  }
  return ok;
}

function listMemories(options = '') {
  const opts = typeof options === 'object' && options ? options : { q: options };
  const q = String(opts.q || '').trim().toLowerCase();
  const tag = String(opts.tag || '').trim().toLowerCase();
  const sort = String(opts.sort || 'updated_desc').trim().toLowerCase();
  const limit = clampLimit(opts.limit || 500);
  let rows = store.memories.slice();
  if (q) {
    rows = rows.filter((m) => `${m.title}\n${m.content}\n${m.mood || ''}\n${m.author || ''}\n${(m.tags || []).join(',')}`.toLowerCase().includes(q));
  }
  if (tag) {
    rows = rows.filter((m) => (m.tags || []).map((item) => String(item).toLowerCase()).includes(tag));
  }
  rows.sort((a, b) => {
    const pin = (b.pinned === true) - (a.pinned === true);
    if (pin) return pin;
    const created = String(b.created_at || '').localeCompare(String(a.created_at || ''));
    const updated = String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
    if (sort === 'created_asc') return -created;
    if (sort === 'created_desc') return created;
    if (sort === 'title_asc') return String(a.title || '').localeCompare(String(b.title || ''));
    return updated;
  });
  return rows.slice(0, limit).map(publicMemory);
}

function importMemories(input) {
  if (!Array.isArray(input)) throw new HttpError(400, 'invalid_memories', 'memories must be an array');
  const imported = [];
  for (const item of input.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const title = cleanString(item.title, '');
    const content = cleanString(item.content, '');
    if (!title && !content) continue;
    imported.push(createMemory({
      title: title || 'Imported memory',
      content,
      mood: item.mood || '',
      author: item.author || '',
      tags: item.tags || [],
      pinned: item.pinned === true,
    }));
  }
  return imported;
}

// ---- Reference documents ("project memory"): typed or uploaded text files
// the agent can consult. Stored chunked; the best-matching chunks are injected
// per turn alongside memory recall. ----

function chunkDocumentText(content) {
  const text = String(content || '').replace(/\r/g, '');
  const chunks = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const para of text.split(/\n{2,}/)) {
    if (current && (current.length + para.length) > 900) push();
    current = current ? `${current}\n\n${para}` : para;
    while (current.length > 1800) {
      chunks.push(current.slice(0, 900).trim());
      current = current.slice(900);
    }
  }
  push();
  return chunks.slice(0, 400).map((text) => ({ text }));
}

function publicDocument(doc, options = {}) {
  const output = {
    id: Number(doc && doc.id) || 0,
    name: cleanString(doc && doc.name, 'untitled'),
    source: doc && doc.source === 'upload' ? 'upload' : 'typed',
    size: Number(doc && doc.size) || 0,
    chunk_count: Array.isArray(doc && doc.chunks) ? doc.chunks.length : 0,
    preview: truncate(cleanString(doc && doc.content, ''), 200),
    created_at: cleanString(doc && doc.created_at, ''),
    updated_at: cleanString(doc && doc.updated_at, ''),
  };
  if (options.full) output.content = cleanString(doc && doc.content, '');
  return output;
}

function createDocument(input) {
  const content = String(input.content || '').slice(0, DOC_MAX_CHARS);
  if (!cleanString(content, '')) throw new HttpError(400, 'empty_document', 'document content is empty');
  const now = new Date().toISOString();
  const doc = {
    id: nextId('document'),
    name: cleanString(input.name, '未命名资料'),
    source: input.source === 'upload' ? 'upload' : 'typed',
    content,
    size: content.length,
    chunks: chunkDocumentText(content),
    created_at: now,
    updated_at: now,
  };
  store.documents.push(doc);
  saveStore();
  addConsoleEvent('memory', '资料已添加', doc.name);
  scheduleBackfill(); // embed the new document's chunks in the background (no-op without a model)
  return publicDocument(doc);
}

function updateDocument(id, input) {
  const doc = store.documents.find((item) => item.id === id);
  if (!doc) return null;
  if ('name' in input) doc.name = cleanString(input.name, doc.name);
  if ('content' in input) {
    doc.content = String(input.content || '').slice(0, DOC_MAX_CHARS);
    doc.size = doc.content.length;
    doc.chunks = chunkDocumentText(doc.content);
  }
  doc.updated_at = new Date().toISOString();
  saveStore();
  addConsoleEvent('memory', '资料已更新', doc.name);
  scheduleBackfill(); // re-embed re-chunked content in the background (no-op without a model)
  return publicDocument(doc);
}

function deleteDocument(id) {
  const before = store.documents.length;
  store.documents = store.documents.filter((item) => item.id !== id);
  const ok = store.documents.length !== before;
  if (ok) {
    saveStore();
    addConsoleEvent('memory', '资料已删除', `id ${id}`);
  }
  return ok;
}

async function ensureDocumentEmbeddings() {
  if (!EMBEDDING_MODEL) return 0;
  const missing = [];
  const owners = new Map(); // chunk -> its doc, so we can re-verify reachability after the await
  for (const doc of store.documents) {
    for (const chunk of doc.chunks || []) {
      if (chunk.embedding_tag !== EMBEDDING_TAG && chunkEmbeddable(chunk)) { missing.push(chunk); owners.set(chunk, doc); }
      if (missing.length >= 64) break;
    }
    if (missing.length >= 64) break;
  }
  if (!missing.length) return 0;
  const sources = missing.map((chunk) => chunk.text.slice(0, 2000));
  const vectors = await embedTexts(sources);
  if (!vectors || vectors.length !== missing.length) return 0;
  let wrote = 0;
  missing.forEach((chunk, index) => {
    const doc = owners.get(chunk);
    if (!store.documents.includes(doc)) return;               // document deleted during the await
    if (!(doc.chunks || []).includes(chunk)) return;          // re-chunked / chunk removed during the await
    if (chunk.text.slice(0, 2000) !== sources[index]) return; // chunk text changed during the await
    chunk.embedding_b64 = vecToB64(vectors[index]);
    chunk.embedding_tag = EMBEDDING_TAG;
    wrote += 1;
  });
  if (wrote) saveStore();
  return wrote; // caller drains in batches until a pass writes 0
}

async function recallDocumentChunks(queryText, limit = DOC_RECALL_LIMIT, sharedQueryVec = undefined) {
  if (!limit || !store.documents.length) return [];
  const query = cleanString(queryText, '');
  if (!query) return [];
  const entries = [];
  for (const doc of store.documents) {
    for (const chunk of doc.chunks || []) {
      if (chunkEmbeddable(chunk)) entries.push({ name: doc.name, chunk }); // skip empty chunks: unembeddable, and they'd block the all-ready gate
    }
  }
  if (!entries.length) return [];
  // Semantic scoring only when every chunk already has a ready vector (backfill is background-only);
  // otherwise fall open to lexical. The request hot path never triggers embedding backfill.
  if (EMBEDDING_MODEL) {
    try {
      const embedded = entries.filter((entry) => entry.chunk.embedding_tag === EMBEDDING_TAG && entry.chunk.embedding_b64);
      if (embedded.length === entries.length) {
        const queryVec = (sharedQueryVec !== undefined) ? sharedQueryVec : await embedQueryVec(query);
        if (queryVec) {
          return embedded
            .map((entry) => ({ entry, score: cosineSim(queryVec, b64ToVec(entry.chunk.embedding_b64)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .filter((item) => item.score > 0.1)
            .map((item) => ({ name: item.entry.name, text: truncate(item.entry.chunk.text, 700) }));
        }
      }
    } catch (err) {
      // fall through to lexical
    }
  }
  const queryTerms = new Set(memoryTokens(query));
  if (!queryTerms.size) return [];
  const scored = entries.map((entry) => {
    const tokens = new Set(memoryTokens(entry.chunk.text));
    let score = 0;
    for (const term of queryTerms) if (tokens.has(term)) score += term.length > 1 ? 1.6 : 1;
    return { entry, score };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({ name: item.entry.name, text: truncate(item.entry.chunk.text, 700) }));
}

async function saveUpload(input) {
  const name = cleanFileName(input.name || 'upload.bin');
  const data = String(input.data || '');
  const match = data.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new HttpError(400, 'invalid_upload', 'upload data must be a data URL');
  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_JSON_BYTES) throw new HttpError(413, 'payload_too_large', 'upload too large');
  const ext = extensionForMime(mime);
  const storedMime = storedMimeForExtension(ext);
  const fileName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);
  addConsoleEvent('upload', '文件已上传', name);
  return {
    url: `/uploads/${fileName}`,
    name,
    type: storedMime,
    size: buffer.length,
    original_size: positiveInt(input.original_size),
    width: positiveInt(input.width),
    height: positiveInt(input.height),
    optimized: input.optimized === true,
  };
}

function serveUpload(res, route) {
  const fileName = path.basename(route);
  const filePath = path.join(UPLOAD_DIR, fileName);
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: 'upload_not_found' });
  res.writeHead(200, { 'content-type': contentTypeFor(filePath), 'cache-control': 'public, max-age=86400' });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(res, route) {
  const requested = route === '/' ? '/index.html' : route;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!isPathInside(PUBLIC_DIR, filePath)) return sendJson(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const fallback = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(fallback).pipe(res);
  }
  res.writeHead(200, { 'content-type': contentTypeFor(filePath), 'cache-control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
}

function loadStore() {
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

function saveStore() {
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
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
  };
  const settings = { ...defaults, ...(input || {}) };
  return {
    appName: cleanString(settings.appName, defaults.appName),
    userName: cleanString(settings.userName, defaults.userName),
    assistantName: cleanString(settings.assistantName, defaults.assistantName),
    groupName: cleanString(settings.groupName, defaults.groupName),
    agentMention: cleanString(settings.agentMention, defaults.agentMention).replace(/^@+/, '') || 'assistant',
    autoReplyGroup: settings.autoReplyGroup === true || String(settings.autoReplyGroup).toLowerCase() === 'true',
    theme: settings.theme === 'light' ? 'light' : 'dark',
    featureCopyAll: settings.featureCopyAll !== false && String(settings.featureCopyAll).toLowerCase() !== 'false',
    featureRecall: settings.featureRecall !== false && String(settings.featureRecall).toLowerCase() !== 'false',
    featureDelete: settings.featureDelete !== false && String(settings.featureDelete).toLowerCase() !== 'false',
  };
}

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

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input.map((item) => ({
    url: cleanString(item && item.url, ''),
    name: cleanString(item && item.name, 'attachment'),
    type: cleanString(item && item.type, ''),
    size: Number(item && item.size) || 0,
    original_size: positiveInt(item && item.original_size),
    width: positiveInt(item && item.width),
    height: positiveInt(item && item.height),
    optimized: item && item.optimized === true,
    sticker: item && item.sticker === true,
  })).filter((item) => item.url);
}

function normalizeTags(input) {
  const source = Array.isArray(input) ? input : String(input || '').split(',');
  return Array.from(new Set(source.map((tag) => cleanString(tag, '').toLowerCase()).filter(Boolean))).slice(0, 12);
}

function defaultMemoryMood(tags = []) {
  return '平静';
}

function nextId(kind) {
  const current = Number(store.counters[kind] || 1);
  store.counters[kind] = current + 1;
  return current;
}

function newSessionId(prefix = 'session') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function endNoContent(res) {
  res.writeHead(204);
  res.end();
}

function setCommonHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-app-token');
  res.setHeader('x-content-type-options', 'nosniff');
}

function isAuthorized(req, url = null) {
  if (!AUTH_TOKEN) return true;
  const token = String(req.headers['x-app-token'] || '').trim();
  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token === AUTH_TOKEN || auth === AUTH_TOKEN) return true;
  // Query-string token only authorizes GET (EventSource can't set headers). Never for writes:
  // SSE/asset URLs leak into history, proxy logs, Referer — a leaked token must not enable DELETE. (沈屿 #6676 P2)
  if (req.method === 'GET') {
    const query = url && url.searchParams ? String(url.searchParams.get('token') || '').trim() : '';
    if (query && query === AUTH_TOKEN) return true;
  }
  return false;
}

function normalizeRoute(route) {
  const value = String(route || '/').replace(/\/{2,}/g, '/');
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function cleanString(value, fallback) {
  const text = String(value == null ? '' : value).replace(/\r/g, '').trim();
  return text || fallback;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function clampLimit(limit) {
  const n = Number(limit) || 80;
  return Math.min(500, Math.max(1, n));
}

function positiveInt(value) {
  const n = Number(value) || 0;
  return n > 0 ? Math.round(n) : 0;
}

function cleanFileName(name) {
  return String(name || 'upload.bin').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'upload.bin';
}

function extensionForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'text/plain') return '.txt';
  if (mime === 'application/pdf') return '.pdf';
  return '.bin';
}

function storedMimeForExtension(ext) {
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
  };
  return types[ext] || 'application/octet-stream';
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
  };
  return types[ext] || 'application/octet-stream';
}

function isPathInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

class HttpError extends Error {
  constructor(statusCode, errorCode, message) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
