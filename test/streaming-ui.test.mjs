import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.localStorage = { getItem: () => '', setItem: () => {}, removeItem: () => {} };

const { state } = await import('../public/js/state.js');
const { renderMessageList } = await import('../public/js/chat-view.js');

test('live assistant reply renders as one stable unsplit bubble', () => {
  state.settings = { userName: '我', assistantName: 'AI' };
  state.streaming.chat = {
    id: 'stream-demo', stream_id: 'demo', scope: 'chat', sender: 'AI', role: 'assistant',
    content: '第一段\n\n第二段', thinking: '正在推理', attachments: [], pending: true, streaming: true,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const html = renderMessageList('chat', []);
  assert.match(html, /data-stream-id="demo"/);
  assert.match(html, /stream-content/);
  assert.match(html, /stream-thinking/);
  assert.equal((html.match(/<article/g) || []).length, 1, '流式期间不应按段落拆成多个气泡');
  assert.doesNotMatch(html, /msg-footer/, '未完成的流不显示伪时间戳');
  state.streaming.chat = null;
});
