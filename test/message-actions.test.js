import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = 'test-token';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function stopServer(srv) {
  if (srv.exitCode != null || srv.signalCode != null) return;
  const exited = new Promise((r) => srv.once('exit', () => r()));
  srv.kill('SIGTERM');
  const force = setTimeout(() => { try { srv.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
  await exited;
  clearTimeout(force);
}

// Boot the real server on a free port + throwaway data dir. token='' means no APP_AUTH_TOKEN
// (destructive routes are then refused). token set means auth is on.
async function boot({ token = '' } = {}) {
  const port = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapp-actions-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, APP_AUTH_TOKEN: token, OPENAI_API_KEY: '', EMBEDDING_MODEL: '' };
  const srv = spawn('node', ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { const r = await fetch(base + '/'); if (r.status) up = true; } catch { /* not ready */ }
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(up, 'server booted');
  return { srv, base, dataDir, token };
}

// Fetch that carries the token via header (like the real client's api()).
function af(ctx, p, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (ctx.token) headers['x-app-token'] = ctx.token;
  return fetch(ctx.base + p, { ...opts, headers });
}
const json = (r) => r.json();
const send = (ctx, content) => af(ctx, '/api/chat/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) });
const messages = async (ctx) => json(await af(ctx, '/api/chat/messages'));
async function waitFor(ctx, pred, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const hit = (await messages(ctx)).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test('recall: marks recalled, persists, and the API no longer leaks content (P1)', async () => {
  const ctx = await boot({ token: TOKEN });
  try {
    await send(ctx, '机密内容-ABC123');
    const mine = await waitFor(ctx, (m) => m.role === 'user');
    assert.ok(mine, 'user message present');
    const rec = await json(await af(ctx, `/api/chat/messages/${mine.id}/recall`, { method: 'POST' }));
    assert.equal(rec.recalled, true);
    assert.equal(rec.content, '', 'recall response strips content');
    const after = (await messages(ctx)).find((m) => Number(m.id) === Number(mine.id));
    assert.equal(after.recalled, true, 'recall persisted');
    assert.equal(after.content, '', 'API does not leak recalled content');
  } finally { await stopServer(ctx.srv); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test('recall: refuses a non-user (assistant) message (P2 ownership)', async () => {
  const ctx = await boot({ token: TOKEN });
  try {
    await send(ctx, 'hi there');
    const ai = await waitFor(ctx, (m) => m.role === 'assistant');
    assert.ok(ai, 'mock assistant reply present');
    const r = await af(ctx, `/api/chat/messages/${ai.id}/recall`, { method: 'POST' });
    assert.equal(r.status, 404, 'recalling a non-user message is refused');
  } finally { await stopServer(ctx.srv); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test('delete: removes one message; missing id -> 404', async () => {
  const ctx = await boot({ token: TOKEN });
  try {
    await send(ctx, 'to delete');
    const mine = await waitFor(ctx, (m) => m.role === 'user');
    const del = await af(ctx, `/api/chat/messages/${mine.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await messages(ctx)).find((m) => Number(m.id) === Number(mine.id)), undefined);
    const missing = await af(ctx, '/api/chat/messages/99999999', { method: 'DELETE' });
    assert.equal(missing.status, 404);
  } finally { await stopServer(ctx.srv); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test('clear: empties the conversation and writes a timestamped backup (P1)', async () => {
  const ctx = await boot({ token: TOKEN });
  try {
    await send(ctx, 'one');
    await send(ctx, 'two');
    await waitFor(ctx, (m) => m.role === 'user');
    const clr = await json(await af(ctx, '/api/chat/messages', { method: 'DELETE' }));
    assert.equal(clr.ok, true);
    assert.equal((await messages(ctx)).length, 0, 'chat empty after clear');
    const backups = fs.readdirSync(ctx.dataDir).filter((f) => /^cleared-chat-.*\.json$/.test(f));
    assert.ok(backups.length >= 1, 'a backup file was written before wiping');
  } finally { await stopServer(ctx.srv); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test('P0: destructive routes are refused (403) when no token is configured', async () => {
  const ctx = await boot({ token: '' });
  try {
    await send(ctx, 'x');
    const mine = await waitFor(ctx, (m) => m.role === 'user');
    assert.equal((await af(ctx, `/api/chat/messages/${mine.id}`, { method: 'DELETE' })).status, 403, 'single delete refused');
    assert.equal((await af(ctx, '/api/chat/messages', { method: 'DELETE' })).status, 403, 'clear refused');
    assert.ok((await messages(ctx)).length >= 1, 'read + send stay open without a token');
  } finally { await stopServer(ctx.srv); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test('P0/P2: with a token set, unauthenticated + query-token DELETE are both blocked (401)', async () => {
  const ctx = await boot({ token: TOKEN });
  try {
    await send(ctx, 'x');
    const mine = await waitFor(ctx, (m) => m.role === 'user');
    assert.equal((await fetch(`${ctx.base}/api/chat/messages/${mine.id}`, { method: 'DELETE' })).status, 401, 'no-credential delete blocked');
    assert.equal((await fetch(`${ctx.base}/api/chat/messages/${mine.id}?token=${TOKEN}`, { method: 'DELETE' })).status, 401, 'query token must not authorize a write');
    assert.ok((await messages(ctx)).find((m) => Number(m.id) === Number(mine.id)), 'message survived the blocked deletes');
  } finally { await stopServer(ctx.srv); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});

test('feature toggles default on and persist off', async () => {
  const ctx = await boot({ token: TOKEN });
  try {
    const def = await json(await af(ctx, '/api/settings'));
    assert.equal(def.featureRecall, true);
    assert.equal(def.featureDelete, true);
    assert.equal(def.featureCopyAll, true);
    await af(ctx, '/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ featureRecall: false, featureDelete: false, featureCopyAll: false }) });
    const off = await json(await af(ctx, '/api/settings'));
    assert.equal(off.featureRecall, false);
    assert.equal(off.featureDelete, false);
    assert.equal(off.featureCopyAll, false);
  } finally { await stopServer(ctx.srv); fs.rmSync(ctx.dataDir, { recursive: true, force: true }); }
});
