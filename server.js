import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInScopeOrder, newTiming, tmark, latencySegments, formatLatency } from './lib/scope-fifo.js';

import { loadDotEnv } from './lib/env.js';
import {
  cleanString, truncate, clampLimit, positiveInt,
  cleanFileName, extensionForMime, storedMimeForExtension, contentTypeFor, isPathInside,
  normalizeTags, defaultMemoryMood, normalizeAttachments, publicMessage,
} from './lib/util.js';
import {
  HttpError, readJson, sendJson, endNoContent, setCommonHeaders, isAuthorized, normalizeRoute,
} from './lib/http-util.js';
import {
  ROOT_DIR, PORT, DATA_DIR, PUBLIC_DIR, STORE_FILE, UPLOAD_DIR, MAX_JSON_BYTES,
  AUTH_TOKEN, AGENT_TIMEOUT_MS, MEMORY_RECALL_LIMIT, CHAT_CONTEXT_MAX, CHAT_CONTEXT_KEEP,
  MEMORY_EXTRACT_EVERY, DOC_RECALL_LIMIT, DOC_MAX_CHARS,
  FORGE_ADAPTER_URL, FORGE_ADAPTER_TOKEN, FORGE_ADAPTER_TIMEOUT_MS,
  QUOTA_ADAPTER_URL, QUOTA_ADAPTER_TOKEN, QUOTA_ADAPTER_TIMEOUT_MS,
  HEARTBEAT_ENABLED, HEARTBEAT_INTERVAL_MINUTES, HEARTBEAT_MIN_IDLE_MINUTES,
  HEARTBEAT_QUIET_START, HEARTBEAT_QUIET_END,
  store, saveStore, nextId, newSessionId, normalizeSession, normalizeSettings,
  publicSettings, publicSession, applySettingsRename, agentStatus,
} from './lib/state.js';
import { sseClients, handleSseStream, streamScopeForRoute, broadcastSse, writeSse, setSnapshotProvider } from './lib/sse.js';
import { addConsoleEvent, latestConsoleEvents } from './lib/console.js';
import {
  addMessage, latestMessages, addSticker, deleteSticker,
  setMessageFavorite, recallMessage, deleteMessage, clearMessages,
} from './lib/messages.js';
import {
  EMBEDDING_MODEL, EMBEDDING_TAG, embedQueryVec, vecToB64, b64ToVec, cosineSim,
  embedTexts, scheduleBackfill, registerBackfillTarget,
} from './lib/embedding.js';
import {
  dedupeMemories, memoryCorpusReady, recallMemories, recallQueryFor,
  maybeExtractMemories, semanticRecall, semanticSearchMemories, selectRelevantMemories,
  activeMemories, createMemory, updateMemory, deleteMemory,
  listMemories, importMemories, isNoiseMessage, isForgeKeepMessage, publicMemory,
} from './lib/memory.js';
import {
  docCorpusReady, publicDocument, createDocument, updateDocument, deleteDocument,
  recallDocumentChunks,
} from './lib/docs.js';
import { forgeSession, queryQuota, publicQuotaAdapterResult } from './lib/forge.js';

setSnapshotProvider(streamSnapshot);

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
    const q = url.searchParams.get('q') || '';
    const tag = url.searchParams.get('tag') || '';
    const limit = url.searchParams.get('limit') || '';
    if (q.trim()) {
      const semantic = await semanticSearchMemories(q, { tag, limit }).catch(() => null);
      if (semantic) return sendJson(res, 200, semantic);  // else fall through to lexical
    }
    return sendJson(res, 200, listMemories({ q, tag, sort: url.searchParams.get('sort') || '', limit }));
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

// ---- Reference documents ("project memory"): typed or uploaded text files
// the agent can consult. Stored chunked; the best-matching chunks are injected
// per turn alongside memory recall. ----

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

