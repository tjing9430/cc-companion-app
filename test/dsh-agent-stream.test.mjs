import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const worker = path.join(root, 'test-fixtures', 'dsh-worker-mock.mjs');
const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});

test('DSH worker deltas reach the app SSE before the committed reply', async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-dsh-stream-'));
  const app = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, CC_SKIP_DOTENV: '1', PORT: String(port), DATA_DIR: dataDir,
      AGENT_PROVIDER: 'dsh', DSH_PYTHON: process.execPath, DSH_WORKER_SCRIPT: worker,
      EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0', TUNNEL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  app.stdout.on('data', (chunk) => { output += chunk; });
  app.stderr.on('data', (chunk) => { output += chunk; });
  try {
    for (let i = 0; i < 100 && !/listening on/i.test(output); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(output, /listening on/i);
    const base = `http://127.0.0.1:${port}`;
    const controller = new AbortController();
    const response = await fetch(`${base}/api/stream`, { signal: controller.signal });
    const reader = response.body.getReader();
    await fetch(`${base}/api/chat/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'DSH test' }),
    });
    const decoder = new TextDecoder();
    let events = '';
    const abortTimer = setTimeout(() => controller.abort(), 3_000);
    while (!events.includes('DSH 流式完成')) {
      const result = await reader.read();
      if (result.done) break;
      events += decoder.decode(result.value);
    }
    clearTimeout(abortTimer);
    controller.abort();
    assert.match(events, /"thinking":"想一下"/);
    assert.match(events, /"content":"DSH 流式"/);
    assert.match(events, /"content":"DSH 流式完成"/);
  } finally {
    if (app.exitCode == null && app.signalCode == null) await new Promise((resolve) => { app.once('close', resolve); app.kill('SIGTERM'); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
