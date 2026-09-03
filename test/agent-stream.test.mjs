import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

test('agent reply streams reasoning/content over app SSE, then commits one final message', async () => {
  let requestedStream = false;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requestedStream = JSON.parse(raw).stream === true;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 25));
    res.write('data: {"choices":[{"delta":{"content":"流式"}}]}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 25));
    res.end('data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-agent-stream-'));
  const app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, CC_SKIP_DOTENV: '1', PORT: String(port), DATA_DIR: dataDir,
      OPENAI_API_KEY: 'test', OPENAI_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`,
      EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0', TUNNEL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });

  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100 && !/listening on/i.test(output); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(output, /listening on/i);
    const controller = new AbortController();
    const streamResponse = await fetch(`${base}/api/stream`, { signal: controller.signal });
    const reader = streamResponse.body.getReader();
    await fetch(`${base}/api/chat/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: '测试流式' }),
    });

    const decoder = new TextDecoder();
    let events = '';
    const abortTimer = setTimeout(() => controller.abort(), 4_000);
    while (!events.includes('"content":"流式完成"')) {
      const result = await reader.read();
      if (result.done) break;
      events += decoder.decode(result.value);
    }
    clearTimeout(abortTimer);
    controller.abort();
    assert.equal(requestedStream, true);
    assert.match(events, /event: message-stream/);
    assert.match(events, /"thinking":"先想"/);
    assert.match(events, /"content":"流式(?:完成)?"/);
    assert.match(events, /event: message\n/);
    assert.match(events, /"content":"流式完成"/);
  } finally {
    if (app.exitCode == null && app.signalCode == null) await new Promise((resolve) => { app.once('close', resolve); app.kill('SIGTERM'); });
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
