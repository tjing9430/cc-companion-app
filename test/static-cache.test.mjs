import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve) => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1', () => {
    const { port } = socket.address();
    socket.close(() => resolve(port));
  });
});

async function withServer(fn) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-cache-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CC_SKIP_DOTENV: '1', PORT: String(port), DATA_DIR: dataDir,
      APP_AUTH_TOKEN: '', EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0', TUNNEL: '' },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${base}/styles.css`)).ok) break; } catch { /* wait */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await fn(base);
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => { child.once('close', resolve); child.kill('SIGTERM'); });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('静态资源支持 ETag 协商缓存', async () => {
  await withServer(async (base) => {
    const first = await fetch(`${base}/styles.css`);
    const etag = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.ok(etag, '首次 200 必须带 ETag');
    const second = await fetch(`${base}/styles.css`, { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304, '内容没变时应该只返 304');
    assert.equal(await second.text(), '', '304 不应携带文件正文');
  });
});
