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
import { handleSend } from './lib/chat.js';
import { heartbeatTick } from './lib/heartbeat.js';

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

