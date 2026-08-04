import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// In-process OpenAI-compatible mock upstream. Controllable chat/embed delay + failure, and it
// records every embed input so tests can assert the query is embedded exactly once / not at all.
async function startMockUpstream(cfg = {}) {
  const state = { embedInputs: [], chatCalls: 0, chatDelayMs: 0, chatFail: false, embedDelayMs: 0, embedDestroy: false, ...cfg };
  const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const server = http.createServer(async (req, res) => {
    if (state.embedDestroy && req.url.includes('/embeddings')) { req.destroy(); return; } // connection-level failure
    const body = await readBody(req);
    if (req.url.includes('/embeddings')) {
      let input = [];
      try { input = JSON.parse(body).input || []; } catch { /* ignore */ }
      state.embedInputs.push(...input);
      if (state.embedDelayMs) await new Promise((r) => setTimeout(r, state.embedDelayMs));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: input.map(() => ({ embedding: Array.from({ length: 8 }, (_, i) => Math.sin(i + input.length)) })) }));
      return;
    }
    if (req.url.includes('/chat/completions')) {
      const n = ++state.chatCalls;
      if (state.chatDelayMs) await new Promise((r) => setTimeout(r, state.chatDelayMs));
      if (state.chatFail) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock chat failure' } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `REPLY#${n}` } }] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

async function startApp(extraEnv = {}) {
  const port = await getFreePort();
  // dataDir/keepDataDir are test knobs, not server env: reuse a data dir across a restart (startup-drain
  // test) and skip the cleanup rm so the second boot can read the first boot's persisted store.
  const { dataDir: reuseDir, keepDataDir = false, ...envRest } = extraEnv;
  const dataDir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ccapp-p2-'));
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, APP_AUTH_TOKEN: '', OPENAI_API_KEY: 'k', EMBEDDING_MODEL: '', ...envRest };
  const srv = spawn('node', ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => (out += d));
  srv.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(`${base}/api/health`); if (r.ok || r.status) up = true; } catch { /* wait */ } if (!up) await new Promise((r) => setTimeout(r, 100)); }
  const json = async (url, init) => { const r = await fetch(base + url, init); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const jbody = (obj) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  return {
    base, dataDir, up,
    get out() { return out; },
    send: (scope, content) => fetch(`${base}/api/${scope}/send`, jbody({ content })),
    messages: async (scope) => (await json(`/api/${scope}/messages`)).body,
    addMemory: (title, content) => json('/api/memory', jbody({ title, content })),
    importMemories: (memories) => json('/api/memory/import', jbody({ memories })),
    updateMemory: (id, patch) => json(`/api/memory/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }),
    addDocument: (name, content) => json('/api/documents', jbody({ name, content })),
    listMemories: async () => (await json('/api/memory')).body,
    listDocuments: async () => (await json('/api/documents')).body,
    delMemory: (id) => fetch(`${base}/api/memory/${id}`, { method: 'DELETE' }),
    delDocument: (id) => fetch(`${base}/api/documents/${id}`, { method: 'DELETE' }),
    async stop() {
      if (srv.exitCode == null && srv.signalCode == null) {
        const ex = new Promise((r) => srv.once('exit', () => r()));
        srv.kill('SIGTERM');
        const f = setTimeout(() => { try { srv.kill('SIGKILL'); } catch { /* gone */ } }, 2000);
        await ex; clearTimeout(f);
      }
      if (!keepDataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function pollFor(fn, { tries = 80, delay = 50 } = {}) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, delay)); }
  return null;
}
const asList = (v) => (Array.isArray(v) ? v : (v && Array.isArray(v.messages) ? v.messages : []));
const assistantWith = (v, re) => asList(v).find((m) => m.role === 'assistant' && re.test(m.content || ''));
// Poll the mock until some embed input contains `needle` — i.e. that text has been embedded (is "ready").
const waitEmbedded = (up, needle, opts) => pollFor(() => up.state.embedInputs.some((t) => typeof t === 'string' && t.includes(needle)), opts);
// Drop the seeded example memory (and any docs) so a test starts from a genuinely empty / fully-controlled corpus.
async function clearCorpus(app) {
  for (const m of asList(await app.listMemories())) await app.delMemory(m.id || (m.memory && m.memory.id));
  const docs = await app.listDocuments();
  for (const d of (Array.isArray(docs) ? docs : [])) await app.delDocument(d.id);
}
const memId = (created) => created && created.body && (created.body.id || (created.body.memory && created.body.memory.id));

test('async ack: /send returns queued immediately; the delayed reply arrives asynchronously', async () => {
  const up = await startMockUpstream({ chatDelayMs: 500 });
  const app = await startApp({ OPENAI_BASE_URL: up.url });
  try {
    assert.ok(app.up, 'app booted');
    const t0 = Date.now();
    const res = await app.send('chat', 'hello');
    const dt = Date.now() - t0;
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.queued, true);
    assert.equal(body.reply, null);
    assert.ok(Array.isArray(body.messages) && body.messages.length === 1, 'user message still echoed (compat)');
    assert.ok(dt < 400, `ack must return before the 500ms reply; took ${dt}ms`);
    const reply = await pollFor(async () => assistantWith(await app.messages('chat'), /REPLY#/));
    assert.ok(reply, 'assistant reply eventually lands in the store (async delivery)');
  } finally { await app.stop(); await up.close(); }
});

test('concurrent same-scope sends reply in strict arrival order under async ack', async () => {
  const up = await startMockUpstream({ chatDelayMs: 250 });
  const app = await startApp({ OPENAI_BASE_URL: up.url });
  try {
    await Promise.all([app.send('chat', 'first'), app.send('chat', 'second')]);
    const replies = await pollFor(async () => {
      // Only count the mock's REPLY# messages — the app seeds a welcome assistant message too.
      const list = asList(await app.messages('chat')).filter((m) => m.role === 'assistant' && /REPLY#/.test(m.content || ''));
      return list.length >= 2 ? list : null;
    });
    assert.ok(replies, 'both replies arrive');
    const idx1 = replies.findIndex((m) => /REPLY#1\b/.test(m.content));
    const idx2 = replies.findIndex((m) => /REPLY#2\b/.test(m.content));
    assert.ok(idx1 >= 0 && idx2 >= 0 && idx1 < idx2, `reply#1 must precede reply#2; got ${replies.map((m) => m.content)}`);
  } finally { await app.stop(); await up.close(); }
});

test('a background reply failure never 500s the send, does not block the next, and stays handled', async () => {
  const up = await startMockUpstream({ chatFail: true });
  const app = await startApp({ OPENAI_BASE_URL: up.url });
  try {
    const r1 = await app.send('chat', 'will fail');
    assert.equal(r1.status, 201); // ack still succeeds even though the background agent call fails
    const fb = await pollFor(async () => assistantWith(await app.messages('chat'), /无法调用/));
    assert.ok(fb, 'failed turn still yields a graceful fallback reply');
    up.state.chatFail = false;
    const r2 = await app.send('chat', 'should still work');
    assert.equal(r2.status, 201);
    const ok = await pollFor(async () => assistantWith(await app.messages('chat'), /REPLY#/));
    assert.ok(ok, 'a subsequent turn is not blocked and still gets a real reply');
    assert.doesNotMatch(app.out, /UnhandledPromiseRejection|Unhandled rejection/i, 'no unhandled rejection in the process');
  } finally { await app.stop(); await up.close(); }
});

test('a not-ready corpus + slow embeddings: neither the ACK nor the FINAL REPLY waits on the embed', async () => {
  // The corpus isn't backfilled yet, so the query-embed gate must skip the (1500ms) embed and fall open
  // to lexical. Crucially we measure the FINAL assistant reply, not just the 201 ACK — the earlier test
  // only proved the ACK is fast, which hid that a ready-path embed could still stall the reply.
  const up = await startMockUpstream({ embedDelayMs: 1500 });
  const app = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: 'mock-embed' });
  try {
    await app.addMemory('seed-title', 'seed content still pending its embed'); // backfill in flight → corpus NOT ready
    const t0 = Date.now();
    const ack = await app.send('chat', 'hello while embed is pending');
    const ackDt = Date.now() - t0;
    assert.equal(ack.status, 201);
    assert.ok(ackDt < 300, `ACK must be immediate; took ${ackDt}ms`);
    const reply = await pollFor(async () => assistantWith(await app.messages('chat'), /REPLY#/));
    const replyDt = Date.now() - t0;
    assert.ok(reply, 'final reply arrives');
    assert.ok(replyDt < 900, `final reply must not wait on the 1500ms embed (gate skipped it → lexical); took ${replyDt}ms`);
  } finally { await app.stop(); await up.close(); }
});

test('gate: an EMPTY corpus embeds the query ZERO times (no wasted embed when semantic cannot run)', async () => {
  const up = await startMockUpstream({});
  const app = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: 'mock-embed' });
  try {
    await clearCorpus(app); // drop the seeded 示例偏好 → nothing is embeddable → semantic can never run
    const marker = 'EMPTYCORPUS_MARKER_Q0';
    const before = up.state.embedInputs.length;
    await app.send('chat', marker);
    await pollFor(async () => assistantWith(await app.messages('chat'), /REPLY#/));
    await new Promise((r) => setTimeout(r, 150)); // let any stray embed settle
    const queryEmbeds = up.state.embedInputs.slice(before).filter((t) => typeof t === 'string' && t.includes(marker));
    assert.equal(queryEmbeds.length, 0, `empty corpus must embed the query 0 times; got ${queryEmbeds.length}`);
  } finally { await app.stop(); await up.close(); }
});

test('gate: DOC_RECALL_LIMIT=0 + ready doc corpus + empty memory embeds the query 0 times (doc recall disabled)', async () => {
  // Narrow edge (R2.1): doc recall is turned OFF (recallDocumentChunks returns early on limit 0), so a
  // ready doc corpus is NOT a usable corpus. With empty memory too, the gate must not pay a query embed
  // that no recall will ever use — otherwise the final reply eats up to a 20s wasted embed.
  const up = await startMockUpstream({});
  const app = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: 'mock-embed', DOC_RECALL_LIMIT: '0' });
  try {
    await clearCorpus(app); // empty memory corpus (seed dropped)
    await app.addDocument('doc', 'DOCONLY_CONTENT_ready_but_recall_disabled');
    assert.ok(await waitEmbedded(up, 'DOCONLY_CONTENT_ready'), 'doc chunk embedded (doc corpus is ready)');
    const marker = 'DOCLIMIT0_MARKER_Q0';
    const before = up.state.embedInputs.length;
    await app.send('chat', marker);
    const reply = await pollFor(async () => assistantWith(await app.messages('chat'), /REPLY#/));
    assert.ok(reply, 'turn still gets a normal reply');
    await new Promise((r) => setTimeout(r, 150)); // let any stray embed settle
    const queryEmbeds = up.state.embedInputs.slice(before).filter((t) => typeof t === 'string' && t.includes(marker));
    assert.equal(queryEmbeds.length, 0, `disabled doc recall + empty memory must embed the query 0 times; got ${queryEmbeds.length}`);
  } finally { await app.stop(); await up.close(); }
});

test('single-flight: with a fully-ready memory+document corpus, the query is embedded EXACTLY ONCE', async () => {
  const up = await startMockUpstream({});
  const app = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: 'mock-embed' });
  try {
    // Build a genuinely double-ready corpus: exactly one memory + one document, both backfilled.
    await clearCorpus(app);
    await app.addMemory('ready-mem', 'READYMEM_CONTENT_alpha');
    await app.addDocument('ready-doc', 'READYDOC_CONTENT_bravo inside one chunk');
    assert.ok(await waitEmbedded(up, 'READYMEM_CONTENT_alpha'), 'memory embedded (memory corpus ready)');
    assert.ok(await waitEmbedded(up, 'READYDOC_CONTENT_bravo'), 'document chunk embedded (doc corpus ready)');
    const marker = 'DOUBLEREADY_SINGLEFLIGHT_Q1';
    const before = up.state.embedInputs.length;
    await app.send('chat', marker);
    await pollFor(async () => assistantWith(await app.messages('chat'), /REPLY#/));
    await new Promise((r) => setTimeout(r, 150));
    const queryEmbeds = up.state.embedInputs.slice(before).filter((t) => typeof t === 'string' && t.includes(marker));
    assert.equal(queryEmbeds.length, 1, `ready corpus embeds the query once, shared across memory+doc recall; got ${queryEmbeds.length}`);
  } finally { await app.stop(); await up.close(); }
});

test('editing a memory clears its stale vector and re-embeds the new content (no stale vector on new text)', async () => {
  const up = await startMockUpstream({});
  const app = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: 'mock-embed' });
  try {
    await clearCorpus(app);
    const created = await app.addMemory('editme', 'ORIGINAL_CONTENT_uno');
    const id = memId(created);
    assert.ok(id, 'memory created with an id');
    assert.ok(await waitEmbedded(up, 'ORIGINAL_CONTENT_uno'), 'original content embedded first');
    // Edit the content. updateMemory must drop the now-stale vector and re-trigger backfill so the NEW
    // text is embedded — without the fix the tag-match filter skips the edited memory and the new content
    // is NEVER embedded (this waitEmbedded would time out), leaving the old vector on the new content.
    await app.updateMemory(id, { content: 'REVISED_CONTENT_dos totally different' });
    assert.ok(await waitEmbedded(up, 'REVISED_CONTENT_dos'), 'edited content was re-embedded (stale vector cleared, backfill recomputed)');
    assert.doesNotMatch(app.out, /UnhandledPromiseRejection|Unhandled rejection/i, 'no unhandled rejection');
  } finally { await app.stop(); await up.close(); }
});

test('embedding connection failure on a READY corpus fails open to lexical — turn still gets a normal reply', async () => {
  // Let the corpus become ready first (embeds succeed), THEN destroy the /embeddings socket. Now the gate
  // DOES attempt the shared query embed (corpus is ready), it throws at the connection level, and
  // embedQueryVec must swallow it → null → lexical. The reply must be a normal agent reply, not a crash.
  const up = await startMockUpstream({});
  const app = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: 'mock-embed' });
  try {
    await clearCorpus(app);
    await app.addMemory('m', 'CORPUS_READY_CONTENT so recall has something to score');
    assert.ok(await waitEmbedded(up, 'CORPUS_READY_CONTENT'), 'corpus reached ready (query embed will now be attempted)');
    up.state.embedDestroy = true; // connection-level failure that THROWS on the shared query embed
    await app.send('chat', 'hello there');
    const normal = await pollFor(async () => assistantWith(await app.messages('chat'), /REPLY#/));
    assert.ok(normal, 'turn produced a normal agent reply despite the embedding connection failure');
    const fallback = assistantWith(await app.messages('chat'), /无法调用/);
    assert.ok(!fallback, 'no fallback — embedding failure fell open to lexical instead of crashing the turn');
    for (let i = 0; i < 40 && !/\[latency\]/.test(app.out); i++) await new Promise((r) => setTimeout(r, 50));
    const lat = (app.out.match(/\[latency\][^\n]*/g) || []).pop() || '';
    assert.match(lat, /recall=\d+ms/, `recall latency recorded (lexical path ran); got: ${lat}`);
  } finally { await app.stop(); await up.close(); }
});

test('backfill drains MORE THAN ONE batch: a >64-item corpus fully embeds (CRUD-triggered drain loop)', async () => {
  const up = await startMockUpstream({});
  const app = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: 'mock-embed' });
  try {
    await clearCorpus(app);
    const N = 70; // > the 64-per-batch cap → a single ensureMemoryEmbeddings pass cannot finish it
    await app.importMemories(Array.from({ length: N }, (_, i) => ({ title: `bulk-${i}`, content: `DRAINITEM_${i}_end` })));
    const all = await pollFor(async () => {
      const seen = new Set(up.state.embedInputs.filter((t) => typeof t === 'string').flatMap((t) => t.match(/DRAINITEM_\d+_end/g) || []));
      return seen.size >= N ? seen : null;
    }, { tries: 200, delay: 50 });
    assert.ok(all, `all ${N} memories embedded via a multi-batch drain (loop ran past the first 64); got ${all ? all.size : 0}`);
  } finally { await app.stop(); await up.close(); }
});

test('startup triggers backfill: a corpus loaded from disk with no vectors fully embeds on boot (drain)', async () => {
  const up = await startMockUpstream({});
  const N = 70;
  // Two boots share one data dir, so track every created resource and tear ALL of it down in finally —
  // including the mock upstream (a missed up.close() here leaks a LISTEN socket that keeps node's event
  // loop alive and hangs the whole runner) and both apps even if the second boot throws mid-setup.
  let app1 = null;
  let app2 = null;
  let dataDir = null;
  try {
    // Boot #1 with NO embedding model: >64 memories persist to disk UNEMBEDDED (scheduleBackfill no-ops).
    app1 = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: '', keepDataDir: true });
    dataDir = app1.dataDir;
    await app1.importMemories(Array.from({ length: N }, (_, i) => ({ title: `boot-${i}`, content: `BOOTITEM_${i}_end` })));
    await app1.stop(); // frees the store file (keeps dataDir) before app2 boots on it
    app1 = null;
    const before = up.state.embedInputs.length; // nothing embedded during boot #1 (no model)
    // Boot #2 with the model + the SAME data dir → the startup scheduleBackfill must drain the whole backlog.
    app2 = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: 'mock-embed', dataDir, keepDataDir: true });
    const all = await pollFor(async () => {
      const seen = new Set(up.state.embedInputs.slice(before).filter((t) => typeof t === 'string').flatMap((t) => t.match(/BOOTITEM_\d+_end/g) || []));
      return seen.size >= N ? seen : null;
    }, { tries: 200, delay: 50 });
    assert.ok(all, `startup drained all ${N} unembedded memories on boot; got ${all ? all.size : 0}`);
  } finally {
    if (app1) await app1.stop();
    if (app2) await app2.stop();
    await up.close(); // the fix: never leak the mock upstream's LISTEN socket
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('memory search: a ready embedded corpus returns matches for a NON-lexical query (semantic path, Phase 2 a)', async () => {
  const up = await startMockUpstream({});
  const app = await startApp({ OPENAI_BASE_URL: up.url, EMBEDDING_MODEL: 'mock-embed' });
  try {
    await clearCorpus(app);
    await app.addMemory('猫', '家里养了一只橘猫');
    await app.addMemory('咖啡', '喝手冲不加糖');
    assert.ok(await waitEmbedded(up, '橘猫'), 'first memory embedded');
    assert.ok(await waitEmbedded(up, '手冲'), 'second memory embedded');
    // The query is NOT a lexical substring of any memory: lexical search → 0 rows; the semantic path,
    // once the corpus is embedded, ranks and returns the embedded rows. Getting ≥1 proves semantic ran.
    const rows = await pollFor(async () => {
      const r = await fetch(`${app.base}/api/memory?q=${encodeURIComponent('ZZZ_no_lexical_hit_here')}`);
      const body = await r.json().catch(() => []);
      return (Array.isArray(body) && body.length >= 1) ? body : null;
    });
    assert.ok(rows && rows.length >= 1, 'semantic search returns matches for a non-lexical query once the corpus is ready (lexical would be 0)');
  } finally { await app.stop(); await up.close(); }
});
