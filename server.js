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
  store, saveStore, nextId, newSessionId, normalizeSession, normalizeSettings, normalizeAvatar,
  publicSettings, publicSession, applySettingsRename, agentStatus, flushStore,
} from './lib/state.js';
import { sseClients, handleSseStream, streamScopeForRoute, broadcastSse, writeSse, setSnapshotProvider } from './lib/sse.js';
import { addConsoleEvent, latestConsoleEvents, pushRawLines, rawTailLines } from './lib/console.js';
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
import { sessionRotationTick } from './lib/session-rotation.js';
import { listConfigFiles, readConfigFile, updateConfigFile } from './lib/config-library.js';

setSnapshotProvider(streamSnapshot);

// 版本号:启动时从 package.json 读一次。
// ★ 读不到就是空串,**不编一个默认值** —— 前端拿到空串会把版本那行省掉,
//   拿到 "0.0.0" 却会一本正经地显示出来。看不见比看见一个假的好。
const APP_VERSION = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).version || '');
  } catch { return ''; }
})();

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

// ★ 退出前把 sqlite 的 WAL 折回主库。
//
// 为什么挂 'exit' 而不是直接挂 SIGTERM:下面 startQuickTunnel() 里那两个信号处理器
// 会 process.exit(0),而 process.exit 会**跳过同信号剩下的监听器** —— 挂在 SIGTERM 上
// 就可能永远不执行。'exit' 则是 process.exit() 也一定会走的那条路。
// 信号本身默认不触发 'exit',所以还要把信号显式转成 exit。
process.on('exit', () => { try { flushStore(); } catch { /* 退出路径上不许再抛 */ } });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

server.listen(PORT, () => {
  addConsoleEvent('system', '服务已启动', `正在监听 http://localhost:${PORT}`);
  console.log(`CC Companion listening on http://localhost:${PORT}`);
  if (HEARTBEAT_ENABLED) {
    setInterval(heartbeatTick, HEARTBEAT_INTERVAL_MINUTES * 60 * 1000);
    console.log(`Heartbeat enabled: every ${HEARTBEAT_INTERVAL_MINUTES} min, min idle ${HEARTBEAT_MIN_IDLE_MINUTES} min, quiet ${HEARTBEAT_QUIET_START}:00-${HEARTBEAT_QUIET_END}:00.`);
  }
  setInterval(() => sessionRotationTick().catch((err) => {
    addConsoleEvent('error', 'Session 自动更换失败', err && err.message ? err.message : String(err));
  }), 30 * 1000);
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
      // ★ 版本从 package.json 现读,不在前端写死一个字符串。
      //   写死的版本号不会报错,只会安静地过期 —— 「关于」上挂一个错版本比不挂更糟:
      //   用户拿它报 bug,我们照着它去查一个不存在的版本。
      version: APP_VERSION,
    });
  }

  if (req.method === 'GET' && route === '/api/settings') {
    return sendJson(res, 200, publicSettings());
  }

  // 档位面板:把桥的 /control/config 透过来。
  //
  // 为什么要代理而不让前端直连桥:①桥是**无鉴权**的本机口,不该暴露给浏览器
  // ②浏览器直连要跨源 ③桥的地址是部署配置,前端不该知道。
  // 走这条路,前端拿到的和别的 API 一样都过 app token 那道门。
  //
  // 桥没配 / 没起 / 不是我们这个桥 → 一律回 { available:false },前端据此**不摆控件**
  // (同 7d26f83 那道能力门:后端给不出的能力,前端不给入口)。
  if (route === '/api/bridge/config' && (req.method === 'GET' || req.method === 'POST')) {
    const base = String(process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
    // /v1 结尾的是 OpenAI 兼容前缀,控制口在它的同级根上
    const root = base.replace(/\/v1$/, '');
    if (!root || !/^https?:\/\//.test(root)) return sendJson(res, 200, { available: false, reason: 'no_bridge' });
    const init = { method: req.method, headers: { 'content-type': 'application/json' } };
    if (req.method === 'POST') init.body = JSON.stringify(await readJson(req));
    try {
      const upstream = await fetch(`${root}/control/config`, { ...init, signal: AbortSignal.timeout(5000) });
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) return sendJson(res, upstream.status, data || { error: 'bridge_error' });
      if (!data || !Array.isArray(data.efforts)) return sendJson(res, 200, { available: false, reason: 'not_our_bridge' });
      return sendJson(res, 200, { available: true, ...data });
    } catch (err) {
      // 桥没起不是错误,是"这个部署没有桥"。回 available:false 让前端安静地不显示。
      return sendJson(res, 200, { available: false, reason: 'unreachable' });
    }
  }

  if (req.method === 'GET' && route === '/api/quota') {
    const result = await queryQuota({ recordEvent: false });
    return sendJson(res, 200, { ok: true, quota: result.quota });
  }

  // AI 自己换自己的头像。**专门开一个只认一个字段的窄口,不复用 /api/settings。**
  //
  // 为什么不复用大口:桥用的 token 就是 app token。让 agent 走 /api/settings,
  // 等于把「整份设置可写」交出去 —— 它能改群聊唤起词、能关掉功能开关、能改主题。
  // 一个字段的需求就开一个字段的口子,这是权限最小化,不是洁癖。
  //
  // 三条约束(逐条对应实现):
  //   ① 只接 assistant_avatar,其余字段**静默忽略**不报错 —— 报错会变成探测器,
  //      告诉调用方"这个字段名存在/不存在"。
  //   ② 值只接已上传资源引用,normalizeAvatar 是白名单形状(见 lib/state.js)。
  //      拿不认识的值进来就落成空串,不是原样存下去。
  //   ③ 每次自改落一条 console 事件 —— 「被看见」是这个产品点的一半,
  //      同时也是审计线:谁在什么时候把自己换成了什么。
  if (req.method === 'POST' && route === '/api/agent/avatar') {
    const body = await readJson(req);
    const next = normalizeAvatar(body && body.assistant_avatar);
    if (!next) {
      return sendJson(res, 400, { error: 'invalid_avatar',
        message: '头像只接受本机已上传的资源引用(/uploads/…),不接受外链或 data URL' });
    }
    store.settings = { ...store.settings, assistant_avatar: next };
    saveStore();
    addConsoleEvent('avatar', 'AI 换了头像', next);
    const settings = publicSettings();
    broadcastSse('settings', { settings });
    return sendJson(res, 200, { ok: true, assistant_avatar: next });
  }

  if (req.method === 'POST' && route === '/api/settings') {
    const body = await readJson(req);
    const previous = store.settings;
    store.settings = normalizeSettings({ ...store.settings, ...body });
    applySettingsRename(previous, store.settings);
    saveStore();
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

  /* 分身发文件给她:落一条 assistant 消息带附件。
     不走 handleSend —— 那是 user 角色入口,还会触发 generateAgentReply
     (分身发文件→又唤起分身回复,自问自答)。这里只插消息,SSE 照常推。 */
  if (req.method === 'POST' && route === '/api/chat/agent-file') {
    const body = await readJson(req);
    const upload = await saveUpload({ name: body.name, data: body.data });
    const message = addMessage('chat', {
      sender: store.settings.assistantName,
      role: 'assistant',
      content: cleanString(body.note, ''),
      attachments: [upload],
      msg_type: 'chat',
    });
    return sendJson(res, 201, { ok: true, message_id: message.id, url: upload.url });
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

  // 真 console 的原始流入口。**只广播 + 内存尾巴,不落库** —— 这是验收项不是风格:
  // 一轮 ~510 行 / ~120KB,灌进 store 的话,一个 148KB 的库一轮就翻倍。
  // 所以这里既不 addConsoleEvent 也不 saveStore,连 store 都不碰;尾巴只住进程内存。
  if (req.method === 'POST' && route === '/api/console/stream') {
    const body = await readJson(req);
    const lines = Array.isArray(body && body.lines) ? body.lines.slice(0, 200) : [];
    if (lines.length) {
      // 这刀是**内存上限**(谁都能 POST 到这个口),留着;但切完要留个记号。
      // 原来是无声硬切:一条 4000+ 的 JSON 被切成半个,前端 parse 不了,
      // 只好把它当普通文本原样吐出来 —— 她 8/14 圈的那坨乱码就是这么来的。
      // 带上标记,前端才分得清「这是坏掉的行」和「这本来就是一行文本」。
      const clean = lines.map((l) => {
        const s = String(l);
        return s.length > 4000 ? `${s.slice(0, 4000)}…[截断]` : s;
      });
      pushRawLines(clean);
      broadcastSse('console-stream', { lines: clean });
    }
    return endNoContent(res);
  }

  // 终端档开屏取一次:最近一轮的尾巴(上面那个内存环),之后 SSE 接着往下滚。
  if (req.method === 'GET' && route === '/api/console/stream/tail') {
    return sendJson(res, 200, { lines: rawTailLines() });
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

  if (req.method === 'GET' && route === '/api/config-files') {
    return sendJson(res, 200, listConfigFiles());
  }
  const configFileMatch = route.match(/^\/api\/config-files\/([a-f0-9]{24})$/);
  if (configFileMatch && req.method === 'GET') {
    return sendJson(res, 200, readConfigFile(configFileMatch[1]));
  }
  if (configFileMatch && req.method === 'PUT') {
    const body = await readJson(req);
    return sendJson(res, 200, updateConfigFile(configFileMatch[1], body.content));
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
    return serveStatic(req, res, route);
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
    const event = addConsoleEvent('command', '/help', '可用命令：/forge 清理本地历史并开一个新的会话段；/quota 查询用量；/heartbeat 让 AI 现在主动说句话；/help 显示本帮助。');
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

// Service worker 的缓存版本号:按被缓存文件的内容算哈希,发的时候注进去。
// 手改版本号这件事已经咬过两次(忘了改 → 用户永远慢一个刷新;sed 改错 →
// 静默不匹配、退出码还是 0)。能自动算出来的东西,别留给人记得。
let swVersionCache = null;
function serviceWorkerTrackedFiles() {
  // 只哈希真正会被缓存的那些文件;顺序固定,免得目录遍历顺序变了版本号跟着跳。
  const tracked = ['index.html', 'app.js', 'styles.css', 'sw.js', 'manifest.json'];
  try {
    for (const f of fs.readdirSync(path.join(PUBLIC_DIR, 'js')).sort()) tracked.push(`js/${f}`);
  } catch { /* 还没有 js/ 目录 */ }
  // ★ assets/ 也要算进来。sw 对图片是**缓存优先**,而换一张背景图不改任何 js/css ——
  //   哈希不覆盖 assets 的话,版本号不变、旧图永远从 cache 出,用户看不到新素材。
  //   2026-08-11 换银河底图时发现:那次碰巧同时改了 home-view.js 才 bump 上,
  //   **是运气不是设计** —— 只换图的那次就会静默失效。
  const walk = (rel) => {
    let ents = [];
    try { ents = fs.readdirSync(path.join(PUBLIC_DIR, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((x, y) => x.name.localeCompare(y.name))) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else tracked.push(`${rel}/${e.name}`);
    }
  };
  walk('assets');
  return tracked;
}

function serviceWorkerVersion() {
  const tracked = serviceWorkerTrackedFiles();
  // 服务可以长驻，public/ 却是直接编辑的。用便宜的 stat 指纹先判断
  // 是否有变，只在变动时重算内容哈希，避免把“自动版本”变成“重启才更新”。
  const fingerprint = tracked.map((rel) => {
    try {
      const stat = fs.statSync(path.join(PUBLIC_DIR, rel));
      return `${rel}:${stat.size}:${stat.mtimeMs}`;
    } catch { return `${rel}:missing`; }
  }).join('|');
  if (swVersionCache && swVersionCache.fingerprint === fingerprint) return swVersionCache.version;

  const hash = crypto.createHash('sha256');
  for (const rel of tracked) {
    try { hash.update(rel).update(fs.readFileSync(path.join(PUBLIC_DIR, rel))); } catch { /* 缺文件就跳过 */ }
  }
  const version = `cc-companion-${hash.digest('hex').slice(0, 12)}`;
  swVersionCache = { fingerprint, version };
  return version;
}

const staticEtagCache = new Map();
function staticEtag(filePath, stat) {
  const fingerprint = `${stat.size}:${stat.mtimeMs}`;
  const cached = staticEtagCache.get(filePath);
  if (cached && cached.fingerprint === fingerprint) return cached.etag;
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
  const etag = `"${digest}"`;
  staticEtagCache.set(filePath, { fingerprint, etag });
  return etag;
}

function serveStatic(req, res, route) {
  const requested = route === '/' ? '/index.html' : route;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!isPathInside(PUBLIC_DIR, filePath)) return sendJson(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const fallback = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(fallback).pipe(res);
  }
  // ★ 首帧就把主题落在 <body> 上。
  //   原来 `data-theme` 是 JS 拿到 settings 之后才写的,于是**第一帧是默认主题**
  //   ——实测 DOMContentLoaded 和第一帧时 body 上都是空的,末态才变成 starry。
  //   两个后果:①用星空主题的人先看见一帧深色默认皮 ②`.sky-galaxy` 的
  //   `opacity:0 → 1` 因为**发生了状态变化**而触发过渡,银河是"淡进来"的。
  //   在这儿注入之后,首帧就是终态:没有错帧,也没有状态变化可过渡。
  //   ★ 放在服务端而不是 localStorage:第一次访问的人也吃得到。
  if (requested === '/index.html') {
    // ⚠️ 主题白名单**一共三份**,改任何一份都要三份一起改:
    //     lib/state.js(存的时候归一) · public/app.js(前端写 body) · 这里(首帧注入)
    //   前两份写成 `['light','starry'] ? : 'dark'` —— dark 靠"当兜底"混进来,
    //   它既是合法选项又是非法值的归宿。这里显式列全,行为一样但读得懂。
    //   (合并成一处更好,但那要动存储层,排在封笔之后。)
    const theme = (store.settings && store.settings.theme) || 'dark';
    const safe = ['dark', 'light', 'starry', 'island'].includes(theme) ? theme : 'dark';
    const html = fs.readFileSync(filePath, 'utf8').replace('<body>', `<body data-theme="${safe}">`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(html);
  }
  if (requested === '/sw.js') {
    // 前置一行注入版本号;sw.js 里读 self.__CC_CACHE_VERSION__,读不到才用回落值。
    const body = `self.__CC_CACHE_VERSION__=${JSON.stringify(serviceWorkerVersion())};\n`
      + fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(body);
  }
  const stat = fs.statSync(filePath);
  const etag = staticEtag(filePath, stat);
  const headers = {
    'content-type': contentTypeFor(filePath),
    'cache-control': 'no-cache',
    etag,
    'last-modified': stat.mtime.toUTCString(),
  };
  const candidates = String(req.headers['if-none-match'] || '').split(',').map((x) => x.trim());
  if (candidates.includes('*') || candidates.includes(etag)) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

