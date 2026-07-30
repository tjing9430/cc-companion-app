import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Ask the OS for a currently-free port so parallel test runs never collide on a fixed one.
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// Gentle shutdown: ask the child to exit, wait for it, force-kill only if it overstays.
async function stopServer(srv) {
  if (srv.exitCode != null || srv.signalCode != null) return;
  const exited = new Promise((r) => srv.once('exit', () => r()));
  srv.kill('SIGTERM');
  const force = setTimeout(() => { try { srv.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
  await exited;
  clearTimeout(force);
}

// Boots the real server with a configured-but-unreachable agent so the agent fetch fails on the
// hot path, and asserts the failure path STILL records the recall + agent latency segments.
// Regression for the finally-guaranteed marks: before the fix, agentEnd was only marked after a
// successful fetch+json, so `agent_ms` went to `-` on exactly the error path worth measuring.
test('agent failure path still records recall and agent latency (finally-guaranteed marks)', async () => {
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapp-errpath-'));
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    APP_AUTH_TOKEN: '',
    OPENAI_API_KEY: 'k', // forces the real agent path instead of the built-in mock
    OPENAI_BASE_URL: 'http://127.0.0.1:9', // discard port → connection refused (fast, deterministic)
    EMBEDDING_MODEL: '', // pin recall to the lexical/no-network path regardless of the outer env
    AGENT_TIMEOUT_MS: '3000',
  };
  const srv = spawn('node', ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { const r = await fetch(`${base}/api/state`); if (r.status) up = true; } catch { /* not ready */ }
      if (!up) await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(up, 'server booted');

    const r = await fetch(`${base}/api/chat/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'trigger agent failure' }),
    });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.equal(body.queued, true); // async ack: the reply (and its failure) happen in the background

    // The failing turn still yields a graceful fallback reply, delivered asynchronously via the store.
    let fallback = null;
    for (let i = 0; i < 60 && !fallback; i++) {
      const list = await (await fetch(`${base}/api/chat/messages`)).json();
      fallback = (Array.isArray(list) ? list : []).find((m) => m.role === 'assistant' && /无法调用/.test(m.content || ''));
      if (!fallback) await new Promise((rr) => setTimeout(rr, 50));
    }
    assert.ok(fallback, 'failed turn yields a graceful fallback reply (wording unchanged)');

    // The latency line is logged from the background task and records the segments even on the error path.
    for (let i = 0; i < 40 && !/\[latency\]/.test(out); i++) await new Promise((rr) => setTimeout(rr, 50));
    const lat = (out.match(/\[latency\][^\n]*/g) || []).pop() || '';
    assert.match(lat, /agent=\d+ms/, `agent latency must be recorded on the failure path; got: ${lat}`);
    assert.match(lat, /recall=\d+ms/, `recall latency must be recorded; got: ${lat}`);
  } finally {
    await stopServer(srv);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
