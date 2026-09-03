// OpenAI-compatible streaming response parser. Kept separate from chat.js so
// provider edge cases can be tested without booting the whole application.
async function readOpenAiStream(response, onDelta = () => {}) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    return { streamed: false, data: await response.json().catch(() => ({})) };
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Agent API returned an unreadable stream');
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  let usage = null;
  let tools = [];
  let finishReason = '';

  const consume = (block) => {
    for (const raw of block.split(/\r?\n/)) {
      if (!raw.startsWith('data:')) continue;
      const payload = raw.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let data;
      try { data = JSON.parse(payload); } catch { continue; }
      if (data.error) throw new Error(data.error.message || data.error || 'Agent stream failed');
      if (data.usage) usage = data.usage;
      const choice = data.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || choice.message || {};
      if (Array.isArray(delta.cc_tools)) tools = delta.cc_tools;
      const text = typeof delta.content === 'string' ? delta.content : '';
      const reason = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
        : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
      if (reason) { thinking += reason; onDelta('thinking', reason); }
      if (text) { content += text; onDelta('content', text); }
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return { streamed: true, content, thinking, tools, usage: usage || {}, finish_reason: finishReason };
}

export { readOpenAiStream };
