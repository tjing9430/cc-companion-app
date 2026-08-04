import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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

async function stopServer(srv) {
  if (srv.exitCode != null || srv.signalCode != null) return;
  const exited = new Promise((r) => srv.once('exit', () => r()));
  srv.kill('SIGTERM');
  const force = setTimeout(() => { try { srv.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
  await exited;
  clearTimeout(force);
}

// Boot the real server on a free port with a throwaway data dir, mock agent (no network).
async function boot() {
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapp-actions-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, APP_AUTH_TOKEN: '', OPENAI_API_KEY: '', EMBEDDING_MODEL: '' };
  const srv = spawn('node', ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.status) up = true; } catch { /* not ready */ }
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(up, 'server booted');
  return { srv, base, dataDir };
}

const json = (r) => r.json();
async function send(base, content) {
  await fetch(`${base}/api/chat/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
}
async function messages(base) { return json(await fetch(`${base}/api/chat/messages`)); }
async function firstUserId(base) {
  for (let i = 0; i < 40; i++) {
    const mine = (await messages(base)).filter((m) => m.role === 'user');
    if (mine.length) return mine[0].id;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no user message appeared');
}

test('recall marks a message recalled and persists', async () => {
  const { srv, base, dataDir } = await boot();
  try {
    await send(base, 'to recall');
    const id = await firstUserId(base);
    const rec = await json(await fetch(`${base}/api/chat/messages/${id}/recall`, { method: 'POST' }));
    assert.equal(rec.recalled, true, 'recall response has recalled=true');
    const after = (await messages(base)).find((m) => Number(m.id) === Number(id));
    assert.equal(after.recalled, true, 'recall persisted in store');
  } finally {
    await stopServer(srv);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('delete removes one message; missing id -> 404', async () => {
  const { srv, base, dataDir } = await boot();
  try {
    await send(base, 'to delete');
    const id = await firstUserId(base);
    const del = await fetch(`${base}/api/chat/messages/${id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const gone = (await messages(base)).find((m) => Number(m.id) === Number(id));
    assert.equal(gone, undefined, 'message removed from store');
    const missing = await fetch(`${base}/api/chat/messages/99999999`, { method: 'DELETE' });
    assert.equal(missing.status, 404, 'deleting a missing id is 404');
  } finally {
    await stopServer(srv);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('clear empties a conversation', async () => {
  const { srv, base, dataDir } = await boot();
  try {
    await send(base, 'one');
    await send(base, 'two');
    await firstUserId(base);
    const clr = await json(await fetch(`${base}/api/chat/messages`, { method: 'DELETE' }));
    assert.equal(clr.ok, true, 'clear returns ok');
    const after = await messages(base);
    assert.equal(after.length, 0, 'chat empty after clear');
  } finally {
    await stopServer(srv);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('feature toggles default on and persist when set off', async () => {
  const { srv, base, dataDir } = await boot();
  try {
    const def = await json(await fetch(`${base}/api/settings`));
    assert.equal(def.featureRecall, true, 'featureRecall defaults on');
    assert.equal(def.featureDelete, true, 'featureDelete defaults on');
    assert.equal(def.featureCopyAll, true, 'featureCopyAll defaults on');
    await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ featureRecall: false, featureDelete: false, featureCopyAll: false }) });
    const off = await json(await fetch(`${base}/api/settings`));
    assert.equal(off.featureRecall, false, 'featureRecall persisted off');
    assert.equal(off.featureDelete, false, 'featureDelete persisted off');
    assert.equal(off.featureCopyAll, false, 'featureCopyAll persisted off');
  } finally {
    await stopServer(srv);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
