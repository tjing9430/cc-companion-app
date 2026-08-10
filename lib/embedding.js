// 向量基建:embedding 调用、编解码、余弦相似度、后台回填调度。
// 回填的对象(记忆/资料库)由各域启动时注册进来,这里不认识它们 —— 保持依赖单向。
import { cleanString } from './util.js';

const backfillTargets = [];
function registerBackfillTarget(fn) { backfillTargets.push(fn); }

// Pick the memories most relevant to the current message instead of just the most recent N.
// Score = token overlap weighted by inverse document frequency (distinctive words matter more than
// common ones). Pinned memories are always kept; a query with no usable terms (bare greeting) falls
// back to the most recent memories.
// Semantic recall (opt-in): set EMBEDDING_MODEL (an OpenAI-compatible
// /embeddings model, e.g. text-embedding-3-small) to score memories by
// meaning instead of token overlap. Falls back to lexical recall whenever
// embeddings are unavailable or any call fails.
const EMBEDDING_MODEL = String(process.env.EMBEDDING_MODEL || '').trim();

const EMBEDDING_DIMENSIONS = Math.max(0, Number(process.env.EMBEDDING_DIMENSIONS || 0));

const EMBEDDING_TAG = EMBEDDING_MODEL ? `${EMBEDDING_MODEL}:${EMBEDDING_DIMENSIONS || 'native'}` : '';

const BACKFILL_MAX_ROUNDS = 2000; // ≤64 items/round → ~128k-item backstop; the zero-write break ends it far sooner

// Single-flight background embedding backfill: kept OFF the request hot path. Recall reads only
// already-ready vectors and fails open to lexical scoring until this catches up. Triggered at startup
// and on every memory/document create/update so bulk imports and edits fully backfill on their own,
// not only after the next chat turn.
let backfillInFlight = null;

let backfillDirty = false; // set when a trigger arrives mid-drain → forces one more sweep so nothing is missed
async function embedTexts(texts) {
  // Embeddings can point at a separate endpoint (a cloud key OR a local server like ollama/LM Studio/TEI),
  // independent of the main agent. A local endpoint may need no key. (Phase 2 a)
  const apiKey = String(process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!EMBEDDING_MODEL || !texts.length) return null;
  if (!apiKey && !process.env.EMBEDDING_BASE_URL) return null;  // cloud default needs a key; a custom (local) endpoint may not
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const body = { model: EMBEDDING_MODEL, input: texts };
    if (EMBEDDING_DIMENSIONS) body.dimensions = EMBEDDING_DIMENSIONS;
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(data.data)) return null;
    return data.data.map((item) => item.embedding);
  } finally {
    clearTimeout(timeout);
  }
}

async function embedQueryVec(query) {
  const q = cleanString(query, '');
  if (!EMBEDDING_MODEL || !q) return null;
  try {
    const vectors = await embedTexts([q.slice(0, 2000)]);
    return (vectors && vectors[0]) ? new Float32Array(vectors[0]) : null;
  } catch {
    // embedTexts throws on connection-level failure / DNS / the 20s abort. Fail open to lexical here so
    // a slow or down embedding provider can never crash or stall the whole turn (tri-state: null). This
    // is the single choke point every recall shares, so one guard covers all call sites.
    return null;
  }
}

function vecToB64(vec) {
  return Buffer.from(new Float32Array(vec).buffer).toString('base64');
}

function b64ToVec(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
}

function cosineSim(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function scheduleBackfill() {
  if (!EMBEDDING_MODEL) return null; // nothing to embed without a configured model
  if (backfillInFlight) { backfillDirty = true; return backfillInFlight; }
  backfillInFlight = (async () => {
    try {
      do {
        backfillDirty = false;
        // Drain in bounded ≤64 batches until a full pass writes nothing (caught up) or a round throws
        // (provider down). Stopping on a zero-write pass guarantees a persistently-failing or perpetually-
        // stale item can never spin this loop.
        for (let round = 0; round < BACKFILL_MAX_ROUNDS; round += 1) {
          let wrote = 0;
          try {
            for (const target of backfillTargets) wrote += await target();
          } catch { backfillDirty = false; break; } // provider error → stop (don't spin); next trigger retries
          if (!wrote) break;
        }
      } while (backfillDirty); // a create/update landed during the drain → sweep once more to catch it
    } finally { backfillInFlight = null; }
  })();
  backfillInFlight.catch(() => {}); // never an unhandled rejection
  return backfillInFlight;
}

export {
  EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, EMBEDDING_TAG,
  embedTexts, embedQueryVec, vecToB64, b64ToVec, cosineSim,
  scheduleBackfill, registerBackfillTarget,
};
