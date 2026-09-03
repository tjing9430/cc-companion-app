import assert from 'node:assert/strict';
import test from 'node:test';
import { readOpenAiStream } from '../lib/openai-stream.js';

function responseFrom(chunks, contentType = 'text/event-stream') {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'content-type': contentType } });
}

test('OpenAI SSE parser streams reasoning/content across arbitrary chunk boundaries', async () => {
  const seen = [];
  const response = responseFrom([
    'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"你',
    '好"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3}}\n\ndata: [DONE]\n\n',
  ]);
  const result = await readOpenAiStream(response, (channel, delta) => seen.push([channel, delta]));
  assert.equal(result.thinking, '先想');
  assert.equal(result.content, '你好');
  assert.equal(result.finish_reason, 'stop');
  assert.equal(result.usage.prompt_tokens, 3);
  assert.deepEqual(seen, [['thinking', '先想'], ['content', '你好']]);
});

test('OpenAI parser accepts a provider that ignores stream:true and returns JSON', async () => {
  const data = { choices: [{ message: { content: '完整回复' } }] };
  const result = await readOpenAiStream(new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json' },
  }));
  assert.equal(result.streamed, false);
  assert.deepEqual(result.data, data);
});

test('OpenAI SSE parser surfaces an in-stream provider error', async () => {
  const response = responseFrom(['data: {"error":{"message":"断开了"}}\n\ndata: [DONE]\n\n']);
  await assert.rejects(() => readOpenAiStream(response), /断开了/);
});
