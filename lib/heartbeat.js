// 心跳:静默时段与闲置判断,偶发主动开口(仅在配置了模型时有真内容)。
import {
  store, AGENT_TIMEOUT_MS,
  HEARTBEAT_MIN_IDLE_MINUTES, HEARTBEAT_QUIET_START, HEARTBEAT_QUIET_END,
} from './state.js';
import { cleanString } from './util.js';
import { addMessage } from './messages.js';
import { addConsoleEvent } from './console.js';
import { selectRelevantMemories } from './memory.js';

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

export { heartbeatInQuietHours, heartbeatDecision, heartbeatTick };
