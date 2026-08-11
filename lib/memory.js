// 记忆域:召回(词法+语义)、事实键顶替、增删改查、自动提取、embedding 就绪判断。
import { store, saveStore, nextId, MEMORY_RECALL_LIMIT, MEMORY_EXTRACT_EVERY, AGENT_TIMEOUT_MS } from './state.js';
import { cleanString, truncate, clampLimit, normalizeTags, defaultMemoryMood, normalizeAttachments } from './util.js';
import { HttpError } from './http-util.js';
import { broadcastSse } from './sse.js';
import { addConsoleEvent } from './console.js';
import {
  EMBEDDING_MODEL, EMBEDDING_TAG,
  embedTexts, embedQueryVec, vecToB64, b64ToVec, cosineSim,
  scheduleBackfill, registerBackfillTarget,
} from './embedding.js';

const MEMORY_STOPWORDS = new Set([
  '的', '了', '和', '是', '我', '你', '他', '她', '它', '们', '在', '有', '这', '那', '就', '都', '也', '要', '不', '吗',
  '呢', '啊', '吧', '与', '之', '对', '把', '被', '让', '给', '很', '哦', '嗯', '个', '会', '能', '说', '想', '到', '去',
  '来', '过', '着', '呀', '的话',
  'the', 'a', 'an', 'is', 'are', 'am', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'it', 'i', 'you', 'me', 'my', 'your',
  'we', 'this', 'that', 'for', 'with', 'as', 'be', 'so', 'do', 'if', 'was', 'were', 'not', 'but', 'can',
]);

// A memory/chunk is "embeddable" only with non-empty source text; the backfill skips empty ones, so they
// must not count toward corpus readiness (else one empty row would block semantic recall forever).
const memoryEmbeddable = (m) => !!cleanString(`${(m && m.title) || ''}${(m && m.content) || ''}`, '');

const memorySourceText = (m) => `${m.title || ''}\n${m.content || ''}`.slice(0, 2000);
function memoryTokens(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) {
    if (!MEMORY_STOPWORDS.has(w)) tokens.push(w);
  }
  const cjk = s.match(/[一-鿿]/g) || [];
  for (let i = 0; i < cjk.length; i += 1) {
    if (!MEMORY_STOPWORDS.has(cjk[i])) tokens.push(cjk[i]);
    if (i + 1 < cjk.length) tokens.push(cjk[i] + cjk[i + 1]);
  }
  return tokens;
}

function dedupeMemories(list) {
  const seen = new Set();
  const out = [];
  for (const memory of list) {
    if (!memory) continue;
    const id = memory.id;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(memory);
  }
  return out;
}

function memoryCorpusReady() {
  if (!EMBEDDING_MODEL) return false;
  const eligible = store.memories.filter(memoryEmbeddable);
  return eligible.length > 0 && eligible.every((m) => m.embedding_tag === EMBEDDING_TAG && m.embedding_b64);
}

async function recallMemories(queryText, limit = MEMORY_RECALL_LIMIT, sharedQueryVec = undefined) {
  const semantic = await semanticRecall(queryText, limit, sharedQueryVec);
  return semantic || selectRelevantMemories(queryText, limit);
}

function memoryRecencyFactor(memory) {
  if (memory && memory.pinned) return 1;
  const stamp = Date.parse((memory && (memory.updated_at || memory.created_at)) || '') || Date.now();
  const ageDays = Math.max(0, (Date.now() - stamp) / 86400000);
  return 0.65 + 0.35 * Math.exp(-ageDays / 180);
}

function recallQueryFor(scope, userMessage) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const upper = Number(userMessage.turn_first_id || userMessage.id) || Infinity;
  const recent = store[key]
    .filter((m) => m.role === 'user' && m.id < upper && cleanString(m.content, ''))
    .slice(-2)
    .map((m) => m.content);
  return [...recent, userMessage.content || ''].join('\n').slice(-1500);
}

function memorySimilarity(textA, textB) {
  const setA = new Set(memoryTokens(textA));
  const setB = new Set(memoryTokens(textB));
  if (!setA.size || !setB.size) return 0;
  let overlap = 0;
  for (const token of setA) if (setB.has(token)) overlap += 1;
  return overlap / Math.min(setA.size, setB.size);
}

function findSimilarMemory(text) {
  let best = 0;
  let hit = null;
  // 只跟还在生效的比:拿一条已被顶替的旧事实去挡新记忆,等于让过时的内容继续说话。
  for (const memory of activeMemories(store.memories)) {
    const score = memorySimilarity(text, `${memory.title || ''} ${memory.content || ''}`);
    if (score > best) {
      best = score;
      hit = memory;
    }
  }
  return best >= 0.6 ? hit : null;
}

function parseExtractedMemories(raw) {
  const match = String(raw || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
  } catch (err) {
    return [];
  }
}

async function maybeExtractMemories(scope) {
  if (!MEMORY_EXTRACT_EVERY) return;
  if (store.settings && store.settings.featureAutoExtract === false) return;  // UI opt-out (per-instance toggle)
  // Extraction can run on its own (small/cheap) model via EXTRACT_*; each
  // falls back to the main OPENAI_* config. With EXTRACT_* set this also
  // works in Claude Code mode, where no main API key is configured.
  const apiKey = String(process.env.EXTRACT_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return;
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const cursorKey = scope === 'group' ? 'group' : 'chat';
  if (!store.memory_extract_cursor) store.memory_extract_cursor = { chat: 0, group: 0 };
  const cursor = Number(store.memory_extract_cursor[cursorKey]) || 0;
  const fresh = store[key].filter((m) => m.id > cursor && cleanString(m.content, ''));
  if (fresh.filter((m) => m.role === 'user').length < MEMORY_EXTRACT_EVERY) return;
  // Advance the cursor before calling out so a failing span is never retried in a loop.
  store.memory_extract_cursor[cursorKey] = fresh[fresh.length - 1].id;
  saveStore();
  const segment = fresh.slice(-40).map((m) => `${m.sender}: ${m.content}`).join('\n').slice(0, 6000);
  const baseUrl = String(process.env.EXTRACT_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = String(process.env.EXTRACT_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '从下面的聊天记录中提取值得长期记住的稳定信息（用户的偏好、事实、关系、重要事件）。输出 JSON 数组：[{"title":"...","content":"...","tags":["..."]}]。不要记临时状态、闲聊或一次性话题；没有值得记的就输出 []。只输出 JSON，不要解释。' },
          { role: 'user', content: segment },
        ],
        temperature: 0.2,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return;
    const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    let saved = 0;
    for (const item of parseExtractedMemories(raw).slice(0, 5)) {
      const title = cleanString(item.title, '');
      const content = cleanString(item.content, '');
      if (!title && !content) continue;
      if (findSimilarMemory(`${title} ${content}`)) continue;
      createMemory({
        title: title || truncate(content, 40),
        content,
        tags: [...(Array.isArray(item.tags) ? item.tags : []), 'auto'],
        author: store.settings.assistantName || 'AI',
      });
      saved += 1;
    }
    if (saved) addConsoleEvent('memory', '自动记忆', `从最近对话提取了 ${saved} 条`);
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureMemoryEmbeddings() {
  if (!EMBEDDING_MODEL) return 0;
  const missing = store.memories
    .filter((m) => memoryEmbeddable(m) && m.embedding_tag !== EMBEDDING_TAG)
    .slice(0, 64);
  if (!missing.length) return 0;
  // Capture the exact source each vector is computed from. embedTexts is awaited, and a memory can
  // be edited or deleted meanwhile — we must never write a vector back onto content it no longer
  // matches (a stale/dirty vector), nor onto a memory that has since been removed.
  const sources = missing.map(memorySourceText);
  const vectors = await embedTexts(sources);
  if (!vectors || vectors.length !== missing.length) return 0;
  let wrote = 0;
  missing.forEach((memory, index) => {
    if (!store.memories.includes(memory)) return;             // deleted during the await
    if (memorySourceText(memory) !== sources[index]) return;  // source changed during the await
    memory.embedding_b64 = vecToB64(vectors[index]);
    memory.embedding_tag = EMBEDDING_TAG;
    wrote += 1;
  });
  if (wrote) saveStore();
  return wrote; // caller drains in batches until a pass writes 0
}

async function semanticRecall(queryText, limit = MEMORY_RECALL_LIMIT, sharedQueryVec = undefined) {
  if (!EMBEDDING_MODEL) return null;
  const query = cleanString(queryText, '');
  if (!query || !store.memories.length) return null;
  try {
    // Backfill runs in the background (scheduleBackfill); recall only reads already-ready vectors and
    // fails open to lexical scoring when none are ready yet — the request hot path never waits on it.
    // Symmetric with document recall: only score semantically when the WHOLE eligible corpus is
    // backfilled. On a partial set we'd silently drop every not-yet-embedded memory, so fall open to
    // lexical (which sees all of them) until backfill catches up.
    if (!memoryCorpusReady()) return null;
    // 同样挡掉被顶替的。两条召回路都要挡,漏一条这功能就等于没做。
    const embedded = activeMemories(store.memories).filter((m) => m.embedding_tag === EMBEDDING_TAG && m.embedding_b64);
    // Single-flight: reuse the shared query vector when provided (explicit null = embed already tried
    // and failed → fall open to lexical); only embed here on a direct call (sharedQueryVec undefined).
    const queryVec = (sharedQueryVec !== undefined) ? sharedQueryVec : await embedQueryVec(query);
    if (!queryVec) return null;
    const cap = Math.max(1, Number(limit) || MEMORY_RECALL_LIMIT);
    const scored = embedded
      .map((memory) => ({ memory, score: cosineSim(queryVec, b64ToVec(memory.embedding_b64)) * memoryRecencyFactor(memory) }))
      .sort((a, b) => b.score - a.score)
      .map((item) => item.memory);
    const pinned = store.memories.filter((m) => m && m.pinned);
    return dedupeMemories([...pinned, ...scored]).slice(0, cap);
  } catch (err) {
    return null;
  }
}

async function semanticSearchMemories(q, opts = {}) {
  if (!EMBEDDING_MODEL) return null;
  if (store.settings && store.settings.featureSemanticSearch === false) return null;
  const query = cleanString(q, '');
  if (!query || !store.memories.length) return null;
  if (!memoryCorpusReady()) return null;
  try {
    const queryVec = await embedQueryVec(query);
    if (!queryVec) return null;
    const tagLc = String(opts.tag || '').trim().toLowerCase();
    const limit = Math.min(Number(opts.limit) || 50, 50);
    const scored = store.memories
      .filter((m) => m.embedding_tag === EMBEDDING_TAG && m.embedding_b64)
      .filter((m) => !tagLc || (m.tags || []).map((t) => String(t).toLowerCase()).includes(tagLc))
      .map((m) => ({ m, score: cosineSim(queryVec, b64ToVec(m.embedding_b64)) }))
      .sort((a, b) => ((b.m.pinned === true) - (a.m.pinned === true)) || (b.score - a.score));
    return scored.slice(0, limit).map((x) => publicMemory(x.m));
  } catch (err) {
    return null;
  }
}

function selectRelevantMemories(queryText, limit = MEMORY_RECALL_LIMIT) {
  // 被顶替的不参与召回 —— 它们留在库里可回溯,但不能再跟新事实抢话。
  const memories = activeMemories(store.memories);
  if (!memories.length) return [];
  const cap = Math.max(1, Number(limit) || MEMORY_RECALL_LIMIT);
  const pinned = memories.filter((m) => m && m.pinned);
  const queryTerms = new Set(memoryTokens(queryText));
  if (!queryTerms.size) {
    return dedupeMemories([...pinned, ...memories.slice(-cap)]).slice(0, cap);
  }
  const df = new Map();
  const tokenSets = memories.map((m) => {
    const set = new Set(memoryTokens(`${m.title || ''} ${m.content || ''} ${(m.tags || []).join(' ')}`));
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
    return set;
  });
  const total = memories.length;
  const scored = memories.map((memory, order) => {
    let score = 0;
    for (const term of queryTerms) {
      if (tokenSets[order].has(term)) {
        const idf = Math.log(1 + total / (1 + (df.get(term) || 0)));
        score += idf * (term.length > 1 ? 1.6 : 1);
      }
    }
    return { memory, score: score * memoryRecencyFactor(memory), order };
  });
  scored.sort((a, b) => (b.score - a.score) || (b.order - a.order));
  const relevant = scored.filter((entry) => entry.score > 0).map((entry) => entry.memory);
  return dedupeMemories([...pinned, ...relevant]).slice(0, cap);
}

function publicMemory(memory) {
  const tags = normalizeTags(memory && memory.tags);
  return {
    id: Number(memory && memory.id) || 0,
    title: cleanString(memory && memory.title, 'Untitled memory'),
    content: cleanString(memory && memory.content, ''),
    mood: cleanString(memory && memory.mood, defaultMemoryMood(tags)),
    author: cleanString(memory && memory.author, store.settings.assistantName || 'AI'),
    tags,
    pinned: Boolean(memory && memory.pinned),
    // 事实键:同键只有最新那条参与召回,旧的标 superseded 留档(不删,能回溯)。
    fact_key: cleanString(memory && memory.fact_key, ''),
    superseded_by: Number(memory && memory.superseded_by) || null,
    superseded_at: cleanString(memory && memory.superseded_at, ''),
    // strength 先占位进形状,排序逻辑等 fact_key 真机跑几天再决定接不接。
    strength: Number.isFinite(Number(memory && memory.strength)) ? Number(memory.strength) : 50,
    created_at: cleanString(memory && memory.created_at, new Date().toISOString()),
    updated_at: cleanString(memory && memory.updated_at, memory && memory.created_at || new Date().toISOString()),
  };
}

function isForgeKeepMessage(message) {
  if (!message || typeof message !== 'object') return false;
  const role = String(message.role || '').toLowerCase();
  const type = String(message.msg_type || 'chat').toLowerCase();
  if (role !== 'user' && role !== 'assistant') return false;
  if (type && type !== 'chat') return false;
  if (isNoiseMessage(message)) return false;
  return Boolean(cleanString(message.content, '') || normalizeAttachments(message.attachments).length);
}

function isNoiseMessage(message) {
  const type = String(message && message.msg_type || '').toLowerCase();
  const role = String(message && message.role || '').toLowerCase();
  const sender = String(message && message.sender || '').toLowerCase();
  const content = String(message && message.content || '').trim();
  const haystack = `${type}\n${role}\n${sender}\n${content.slice(0, 512)}`.toLowerCase();
  if (/(^|\b)(thinking|thought|tool|tool_use|tool_result|progress|debug|trace|command)(\b|$)/.test(haystack)) return true;
  if (content.startsWith('{')) {
    try {
      const parsed = JSON.parse(content);
      const kind = String(parsed.kind || parsed.type || '').toLowerCase();
      if (/(thinking|tool|progress|debug|trace|done)/.test(kind)) return true;
    } catch {
      // Keep ordinary JSON-looking text if it is not a known noise object.
    }
  }
  return false;
}

function supersedeSameFactKey(winner) {
  const key = cleanString(winner && winner.fact_key, '');
  if (!key) return 0;
  const now = new Date().toISOString();
  let n = 0;
  for (const m of store.memories) {
    if (!m || m.id === winner.id) continue;
    if (cleanString(m.fact_key, '') !== key) continue;
    if (Number(m.superseded_by) === Number(winner.id)) continue;   // 已经让过位了
    m.superseded_by = winner.id;
    m.superseded_at = now;
    n += 1;
  }
  // 赢家自己若曾被顶替过,现在它是最新的,恢复它。
  if (winner.superseded_by) { winner.superseded_by = null; winner.superseded_at = ''; }
  return n;
}

function activeMemories(list) {
  return (Array.isArray(list) ? list : []).filter((m) => m && !m.superseded_by);
}

function createMemory(input) {
  const now = new Date().toISOString();
  const memory = {
    id: nextId('memory'),
    title: cleanString(input.title, 'Untitled memory'),
    content: cleanString(input.content, ''),
    mood: cleanString(input.mood, defaultMemoryMood(input.tags)),
    author: cleanString(input.author, store.settings.assistantName || 'AI'),
    tags: normalizeTags(input.tags),
    pinned: input.pinned === true,
    fact_key: cleanString(input.fact_key, ''),
    superseded_by: null,
    superseded_at: '',
    strength: Number.isFinite(Number(input.strength)) ? Number(input.strength) : 50,
    created_at: now,
    updated_at: now,
  };
  store.memories.push(memory);
  const superseded = supersedeSameFactKey(memory);
  saveStore();
  addConsoleEvent('memory', '记忆已创建', superseded ? `${memory.title}(顶替了 ${superseded} 条旧的)` : memory.title);
  const output = publicMemory(memory);
  broadcastSse('memory', { action: 'created', memory: output });
  scheduleBackfill(); // embed the new memory in the background (no-op without a model)
  return output;
}

function updateMemory(id, input) {
  const memory = store.memories.find((item) => item.id === id);
  if (!memory) return null;
  const prevSource = memorySourceText(memory);
  if ('title' in input) memory.title = cleanString(input.title, memory.title);
  if ('content' in input) memory.content = cleanString(input.content, memory.content);
  if ('mood' in input) memory.mood = cleanString(input.mood, memory.mood || defaultMemoryMood(memory.tags));
  if ('author' in input) memory.author = cleanString(input.author, memory.author || store.settings.assistantName || 'AI');
  if ('tags' in input) memory.tags = normalizeTags(input.tags);
  if ('pinned' in input) memory.pinned = input.pinned === true;
  if ('fact_key' in input) memory.fact_key = cleanString(input.fact_key, '');
  if ('strength' in input) memory.strength = Number.isFinite(Number(input.strength)) ? Number(input.strength) : memory.strength;
  // 编辑过的这条就是用户最新的意思 → 它成为该键的在效条目,同键其余的让位。
  if ('fact_key' in input) supersedeSameFactKey(memory);
  // Title+content feed the embedding vector; if either changed, the stored vector no longer matches the
  // text. Drop it so semantic recall can never score a stale vector against new content, and let backfill
  // recompute. (Also fixes a pre-existing bug: the old tag-match filter never re-embedded edited memories.)
  if (memorySourceText(memory) !== prevSource) {
    delete memory.embedding_tag;
    delete memory.embedding_b64;
  }
  memory.updated_at = new Date().toISOString();
  saveStore();
  addConsoleEvent('memory', '记忆已更新', memory.title);
  scheduleBackfill(); // re-embed the edited memory in the background (no-op without a model)
  const output = publicMemory(memory);
  broadcastSse('memory', { action: 'updated', memory: output });
  return output;
}

function deleteMemory(id) {
  const before = store.memories.length;
  store.memories = store.memories.filter((item) => item.id !== id);
  const ok = store.memories.length !== before;
  if (ok) {
    saveStore();
    addConsoleEvent('memory', '记忆已删除', `id ${id}`);
    broadcastSse('memory', { action: 'deleted', id });
  }
  return ok;
}

function listMemories(options = '') {
  const opts = typeof options === 'object' && options ? options : { q: options };
  const q = String(opts.q || '').trim().toLowerCase();
  const tag = String(opts.tag || '').trim().toLowerCase();
  const sort = String(opts.sort || 'updated_desc').trim().toLowerCase();
  const limit = clampLimit(opts.limit || 500);
  let rows = store.memories.slice();
  if (q) {
    rows = rows.filter((m) => `${m.title}\n${m.content}\n${m.mood || ''}\n${m.author || ''}\n${(m.tags || []).join(',')}`.toLowerCase().includes(q));
  }
  if (tag) {
    rows = rows.filter((m) => (m.tags || []).map((item) => String(item).toLowerCase()).includes(tag));
  }
  rows.sort((a, b) => {
    const pin = (b.pinned === true) - (a.pinned === true);
    if (pin) return pin;
    const created = String(b.created_at || '').localeCompare(String(a.created_at || ''));
    const updated = String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
    if (sort === 'created_asc') return -created;
    if (sort === 'created_desc') return created;
    if (sort === 'title_asc') return String(a.title || '').localeCompare(String(b.title || ''));
    return updated;
  });
  return rows.slice(0, limit).map(publicMemory);
}

function importMemories(input) {
  if (!Array.isArray(input)) throw new HttpError(400, 'invalid_memories', 'memories must be an array');
  const imported = [];
  for (const item of input.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const title = cleanString(item.title, '');
    const content = cleanString(item.content, '');
    if (!title && !content) continue;
    imported.push(createMemory({
      title: title || 'Imported memory',
      content,
      mood: item.mood || '',
      author: item.author || '',
      tags: item.tags || [],
      pinned: item.pinned === true,
    }));
  }
  return imported;
}

registerBackfillTarget(ensureMemoryEmbeddings);

export {
  memoryTokens, dedupeMemories, memoryCorpusReady, recallMemories, recallQueryFor,
  findSimilarMemory, parseExtractedMemories, maybeExtractMemories,
  ensureMemoryEmbeddings, semanticRecall, semanticSearchMemories, selectRelevantMemories,
  supersedeSameFactKey, activeMemories, createMemory, updateMemory, deleteMemory,
  listMemories, importMemories, isNoiseMessage, isForgeKeepMessage, publicMemory,
  memoryEmbeddable, memorySourceText,
};
