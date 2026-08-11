// 资料库域:文档分块、增删改查、chunk embedding 与语义召回。
import { store, saveStore, nextId, DOC_RECALL_LIMIT, DOC_MAX_CHARS } from './state.js';
import { cleanString, truncate, clampLimit, positiveInt } from './util.js';
import { HttpError } from './http-util.js';
import { memoryTokens } from './memory.js';
import { broadcastSse } from './sse.js';
import { addConsoleEvent } from './console.js';
import {
  EMBEDDING_MODEL, EMBEDDING_TAG,
  embedTexts, embedQueryVec, vecToB64, b64ToVec, cosineSim,
  scheduleBackfill, registerBackfillTarget,
} from './embedding.js';

const chunkEmbeddable = (c) => !!cleanString((c && c.text) || '', '');
function docCorpusReady() {
  if (!EMBEDDING_MODEL) return false;
  let any = false;
  for (const doc of store.documents) {
    for (const chunk of doc.chunks || []) {
      if (!chunkEmbeddable(chunk)) continue;
      any = true;
      if (chunk.embedding_tag !== EMBEDDING_TAG || !chunk.embedding_b64) return false;
    }
  }
  return any;
}

function chunkDocumentText(content) {
  const text = String(content || '').replace(/\r/g, '');
  const chunks = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const para of text.split(/\n{2,}/)) {
    if (current && (current.length + para.length) > 900) push();
    current = current ? `${current}\n\n${para}` : para;
    while (current.length > 1800) {
      chunks.push(current.slice(0, 900).trim());
      current = current.slice(900);
    }
  }
  push();
  return chunks.slice(0, 400).map((text) => ({ text }));
}

function publicDocument(doc, options = {}) {
  const output = {
    id: Number(doc && doc.id) || 0,
    name: cleanString(doc && doc.name, 'untitled'),
    source: doc && doc.source === 'upload' ? 'upload' : 'typed',
    size: Number(doc && doc.size) || 0,
    chunk_count: Array.isArray(doc && doc.chunks) ? doc.chunks.length : 0,
    preview: truncate(cleanString(doc && doc.content, ''), 200),
    created_at: cleanString(doc && doc.created_at, ''),
    updated_at: cleanString(doc && doc.updated_at, ''),
  };
  // 全文按原样返回:cleanString 会 trim,而文档正文的首尾空白是内容的一部分
  // (缩进敏感的文件被削掉就不是原文了)。
  if (options.full) output.content = String((doc && doc.content) || '');
  return output;
}

function createDocument(input) {
  const content = String(input.content || '').slice(0, DOC_MAX_CHARS);
  if (!cleanString(content, '')) throw new HttpError(400, 'empty_document', 'document content is empty');
  const now = new Date().toISOString();
  const doc = {
    id: nextId('document'),
    name: cleanString(input.name, '未命名资料'),
    source: input.source === 'upload' ? 'upload' : 'typed',
    content,
    size: content.length,
    chunks: chunkDocumentText(content),
    created_at: now,
    updated_at: now,
  };
  store.documents.push(doc);
  saveStore();
  addConsoleEvent('memory', '资料已添加', doc.name);
  scheduleBackfill(); // embed the new document's chunks in the background (no-op without a model)
  return publicDocument(doc);
}

function updateDocument(id, input) {
  const doc = store.documents.find((item) => item.id === id);
  if (!doc) return null;
  if ('name' in input) doc.name = cleanString(input.name, doc.name);
  if ('content' in input) {
    doc.content = String(input.content || '').slice(0, DOC_MAX_CHARS);
    doc.size = doc.content.length;
    doc.chunks = chunkDocumentText(doc.content);
  }
  doc.updated_at = new Date().toISOString();
  saveStore();
  addConsoleEvent('memory', '资料已更新', doc.name);
  scheduleBackfill(); // re-embed re-chunked content in the background (no-op without a model)
  return publicDocument(doc);
}

function deleteDocument(id) {
  const before = store.documents.length;
  store.documents = store.documents.filter((item) => item.id !== id);
  const ok = store.documents.length !== before;
  if (ok) {
    saveStore();
    addConsoleEvent('memory', '资料已删除', `id ${id}`);
  }
  return ok;
}

async function ensureDocumentEmbeddings() {
  if (!EMBEDDING_MODEL) return 0;
  const missing = [];
  const owners = new Map(); // chunk -> its doc, so we can re-verify reachability after the await
  for (const doc of store.documents) {
    for (const chunk of doc.chunks || []) {
      if (chunk.embedding_tag !== EMBEDDING_TAG && chunkEmbeddable(chunk)) { missing.push(chunk); owners.set(chunk, doc); }
      if (missing.length >= 64) break;
    }
    if (missing.length >= 64) break;
  }
  if (!missing.length) return 0;
  const sources = missing.map((chunk) => chunk.text.slice(0, 2000));
  const vectors = await embedTexts(sources);
  if (!vectors || vectors.length !== missing.length) return 0;
  let wrote = 0;
  missing.forEach((chunk, index) => {
    const doc = owners.get(chunk);
    if (!store.documents.includes(doc)) return;               // document deleted during the await
    if (!(doc.chunks || []).includes(chunk)) return;          // re-chunked / chunk removed during the await
    if (chunk.text.slice(0, 2000) !== sources[index]) return; // chunk text changed during the await
    chunk.embedding_b64 = vecToB64(vectors[index]);
    chunk.embedding_tag = EMBEDDING_TAG;
    wrote += 1;
  });
  if (wrote) saveStore();
  return wrote; // caller drains in batches until a pass writes 0
}

// 词法兜底下,一份资料至少要被查询里 N 个多字词命中才算相关。
// 为什么是 2 而不是 1:一个二元组撞上是很弱的证据。拿真实资料实测(19 块中文文档):
//   门槛 1 → 闲聊误塞 4/9,真问文档 4/4
//   门槛 2 → 闲聊误塞 1/9,真问文档 3/4   ← 取这个
//   门槛 3 → 闲聊误塞 0/9,真问文档 3/4(样本太小,不为多杀一个假阳性牺牲召回)
// 代价说清楚:很短的真问题(「那文件讲了啥」)会被漏掉。词法本来就只是兜底 ——
// 配上 EMBEDDING_MODEL 走语义召回才是正解,那条路有自己的 0.1 相似度下限。
const LEXICAL_MIN_TERM_HITS = 2;

async function recallDocumentChunks(queryText, limit = DOC_RECALL_LIMIT, sharedQueryVec = undefined) {
  if (!limit || !store.documents.length) return [];
  const query = cleanString(queryText, '');
  if (!query) return [];
  const entries = [];
  for (const doc of store.documents) {
    for (const chunk of doc.chunks || []) {
      if (chunkEmbeddable(chunk)) entries.push({ name: doc.name, chunk }); // skip empty chunks: unembeddable, and they'd block the all-ready gate
    }
  }
  if (!entries.length) return [];
  // Semantic scoring only when every chunk already has a ready vector (backfill is background-only);
  // otherwise fall open to lexical. The request hot path never triggers embedding backfill.
  if (EMBEDDING_MODEL) {
    try {
      const embedded = entries.filter((entry) => entry.chunk.embedding_tag === EMBEDDING_TAG && entry.chunk.embedding_b64);
      if (embedded.length === entries.length) {
        const queryVec = (sharedQueryVec !== undefined) ? sharedQueryVec : await embedQueryVec(query);
        if (queryVec) {
          return embedded
            .map((entry) => ({ entry, score: cosineSim(queryVec, b64ToVec(entry.chunk.embedding_b64)) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .filter((item) => item.score > 0.1)
            .map((item) => ({ name: item.entry.name, text: truncate(item.entry.chunk.text, 700) }));
        }
      }
    } catch (err) {
      // fall through to lexical
    }
  }
  // ★ 只用多字词打分,单个汉字不算相关信号。
  // 分词器对中文产的是「单字 + 二元组」,而单字(你/在/的/我)几乎能跟任何长中文文档撞上,
  // 停用词表又只有十几个 —— 于是 `score > 0` 这个下限对中文形同虚设:实测「你好」命中
  // 19 块里的 9 块、「今天天气怎么样」命中 13 块,完全无关的闲聊也会把整份资料拽进 prompt。
  // 后果不是"多花点 token":用户只上传了一份资料时,它**每一轮都在场**,agent 会把这份
  // 反复出现的东西读成一种持续的引导意图,然后开始对着它表态。(这是真实观测到的,
  // 不是推演——用户的 agent 主动抱怨"每轮都把那份东西当参考资料塞进来"。)
  // 记忆召回那边没这个病,因为它有 IDF 加权会自动压掉常见字;文档召回没有,所以在这儿补。
  const queryTerms = new Set(memoryTokens(query).filter((t) => t.length > 1));
  if (!queryTerms.size) return [];
  const scored = entries.map((entry) => {
    const tokens = new Set(memoryTokens(entry.chunk.text));
    let hits = 0;
    for (const term of queryTerms) if (tokens.has(term)) hits += 1;
    return { entry, score: hits };
  });
  return scored
    .filter((item) => item.score >= LEXICAL_MIN_TERM_HITS)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({ name: item.entry.name, text: truncate(item.entry.chunk.text, 700) }));
}

registerBackfillTarget(ensureDocumentEmbeddings);

export {
  docCorpusReady, chunkDocumentText, publicDocument,
  createDocument, updateDocument, deleteDocument,
  ensureDocumentEmbeddings, recallDocumentChunks, chunkEmbeddable,
};
