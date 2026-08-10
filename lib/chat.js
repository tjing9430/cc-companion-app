// 聊天管线:收发入库、召回拼 prompt、调用配置的 agent(或 mock)、延迟埋点。
import { runInScopeOrder, newTiming, tmark, latencySegments, formatLatency } from './scope-fifo.js';
import {
  store, saveStore, AGENT_TIMEOUT_MS, MEMORY_RECALL_LIMIT,
  CHAT_CONTEXT_MAX, CHAT_CONTEXT_KEEP, DOC_RECALL_LIMIT,
} from './state.js';
import { cleanString, truncate, normalizeAttachments } from './util.js';
import { sendJson } from './http-util.js';
import { addMessage } from './messages.js';
import { addConsoleEvent } from './console.js';
import { EMBEDDING_MODEL, embedQueryVec, scheduleBackfill } from './embedding.js';
import {
  memoryCorpusReady, recallMemories, recallQueryFor,
  maybeExtractMemories, selectRelevantMemories,
} from './memory.js';
import { docCorpusReady, recallDocumentChunks } from './docs.js';

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

export {
  handleSend, generateAgentReply, callConfiguredAgent, contextHistory,
  mockReply, shouldReplyInGroup, normalizeOutgoingMessages,
};
