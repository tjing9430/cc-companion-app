// SQLite 持久化后端。
//
// 它买的是**增长时的代价**,不是今天的卡顿 —— 这个区别我一开始搞错过,写在这儿免得再错。
// saveStore() 整文件重写 JSON,全库 22 个调用点(每条消息/记忆/日志都触发)。
// 用 Node 实测(和 app 同一个引擎):
//   103 KB(一个真实库) → 2.05 ms/次     ← 今天其实**感觉不出来**
//   745 KB            → 12.1 ms/次
//   3.6 MB            → 48.8 ms/次     ← 这才是它开始咬人的地方
// 逐行写:0.33 ms/次,**与库多大无关**。
// ★ 所以诚实的说法是:今天赢 6 倍(2.05→0.33),库长到 3.6MB 时赢 150 倍。
//   这是**给增长上的保险**,不是修一个现在就疼的毛病。
// ★★ 我最初报的是「148KB → 52ms」—— 那是拿 **Python 的 json.dumps** 量的,
//    还赶上机器在忙。拿错引擎量另一个引擎的活,数字大了 25 倍。
//    量一个东西要用它自己跑的那个引擎。
//
// ★ DDL 不在这儿定义,直接吃 scripts/migrate-to-sqlite.mjs 的 SCHEMA_SQL ——
//   稿子里钉过「DDL 真源=脚本」,再抄一份就是第二真源,迟早漂。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SCHEMA_SQL, SCHEMA_VERSION, loadSqlite } from '../scripts/migrate-to-sqlite.mjs';

const str = (v, d = '') => (v == null ? d : String(v));
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const bool = (v) => (v === true || v === 1 || v === '1' ? 1 : 0);
const KV_KEYS = ['settings', 'session', 'context_anchor', 'memory_extract_cursor', 'counters'];

// 同步开库。★ 为什么要有同步版:lib/state.js 在模块顶层 `let store = loadStore()`,
// 是同步的;要用 await 就得把整个 state 模块变成异步,涟漪会扩到每个 importer。
// `require('node:sqlite')` 本身是同步的,用 createRequire 借过来就行 —— 换一行,
// 比把半个项目改成 async 便宜得多。
export function openStoreSync(dbPath) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  return initStore(DatabaseSync, dbPath);
}

export async function openStore(dbPath) {
  const { DatabaseSync } = await loadSqlite();
  return initStore(DatabaseSync, dbPath);
}

function initStore(DatabaseSync, dbPath) {
  const fresh = !fs.existsSync(dbPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  // ★ 外键默认是关的;不显式打开,DDL 里那些 REFERENCES 只是注释。
  //   而且要读回来确认 —— 设完就当它生效,是这一晚栽过的同一类。
  db.exec('PRAGMA foreign_keys = ON');
  if (int(db.prepare('PRAGMA foreign_keys').get().foreign_keys) !== 1) {
    throw new Error('外键没真打开,拒绝在这种库上写数据');
  }
  // WAL:读写不互相阻塞。NORMAL 同步档在 WAL 下是安全的(掉电最多丢最后一个事务,
  // 不会坏库),换来的是不用每次写都等 fsync —— 这正是我们要买的那部分。
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  if (fresh) {
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?,?)').run('schema_version', SCHEMA_VERSION);
  }
  const store = new SqliteStore(db);
  // ★ 开库先收一次口。这条是为「已经躺成空壳的库」准备的自愈:
  //   升级上线那一下 WAL 就被折回主库,不用谁记得去手跑一条命令。
  store.checkpoint();
  return store;
}

class SqliteStore {
  constructor(db) {
    this.db = db;
    this._depth = 0;
    // 每写这么多次收一次口 —— 不能只靠退出时收,服务器可能几周不退。
    // ★ 50 这个数是量出来的,不是拍的。1000 次写的实测:
    //     从不收口 102ms / WAL 峰值 3.94MB   ← 现状,主库可能一直是空壳
    //     每 200   144ms / 2.65MB
    //     每 50    186ms / 0.71MB            ← 取这个
    //     每 20    270ms / 0.29MB
    //   看着是「慢了 82%」,换算成单次写是 **+0.084ms**;而真实链路里每次写的前面
    //   都挂着一次几秒的模型调用。拿紧循环的百分比当决策依据会选错档。
    this._writes = 0;
    this._checkpointEvery = 50;
    this._pending = false;   // 事务里想收口、只能等提交后补的那一笔
    // prepare 一次复用 —— 每次现编 SQL 会把「逐行写」省下来的时间又还回去
    this.q = {
      putKv: db.prepare('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      insMsg: db.prepare(`INSERT INTO messages
        (id, scope, sender, role, content, thinking, msg_type, session_id, parent_msg_id, attachments, favorited, recalled, recalled_at, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content, thinking=excluded.thinking,
          attachments=excluded.attachments, favorited=excluded.favorited,
          recalled=excluded.recalled, recalled_at=excluded.recalled_at`),
      delMsg: db.prepare('DELETE FROM messages WHERE id = ?'),
      delScope: db.prepare('DELETE FROM messages WHERE scope = ?'),
      insEvent: db.prepare('INSERT INTO console_events (id, kind, title, body, created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING'),
      trimEvents: db.prepare('DELETE FROM console_events WHERE id NOT IN (SELECT id FROM console_events ORDER BY id DESC LIMIT ?)'),
      insMem: db.prepare(`INSERT INTO memories
        (id, title, content, mood, author, pinned, fact_key, superseded_by, superseded_at, strength, archived, archived_at, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, mood=excluded.mood,
          author=excluded.author, pinned=excluded.pinned, fact_key=excluded.fact_key,
          superseded_by=excluded.superseded_by, superseded_at=excluded.superseded_at,
          strength=excluded.strength, archived=excluded.archived, archived_at=excluded.archived_at,
          updated_at=excluded.updated_at`),
      delMem: db.prepare('DELETE FROM memories WHERE id = ?'),
      clrTags: db.prepare('DELETE FROM memory_tags WHERE memory_id = ?'),
      insTag: db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?,?)'),
      putVec: db.prepare('INSERT INTO memory_embeddings (memory_id, embedding_tag, embedding_b64) VALUES (?,?,?) ON CONFLICT(memory_id) DO UPDATE SET embedding_tag=excluded.embedding_tag, embedding_b64=excluded.embedding_b64'),
      delVec: db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?'),
      insDoc: db.prepare(`INSERT INTO documents (id, name, source, content, size, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, content=excluded.content,
          size=excluded.size, updated_at=excluded.updated_at`),
      delDoc: db.prepare('DELETE FROM documents WHERE id = ?'),
      clrChunks: db.prepare('DELETE FROM document_chunks WHERE document_id = ?'),
      insChunk: db.prepare('INSERT INTO document_chunks (document_id, seq, text, embedding_tag, embedding_b64) VALUES (?,?,?,?,?)'),
      insSticker: db.prepare('INSERT INTO stickers (id, name, url, created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING'),
      delSticker: db.prepare('DELETE FROM stickers WHERE id = ?'),
    };
  }

  // ★ 可重入。putMemory / putDocument 自己就带事务,而 replaceAll 又把它们包在一个大事务里
  //   —— SQLite 不认嵌套 BEGIN,会直接报 "cannot start a transaction within a transaction"。
  //   与其要求调用方记住「谁在事务里」,不如让 tx 自己数层数:只有最外层真 BEGIN/COMMIT。
  //   (这是跑起来才炸出来的,node --check 一路绿灯。)
  tx(fn) {
    if (this._depth > 0) { this._depth++; try { return fn(); } finally { this._depth--; } }
    this._depth = 1;
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* 没开成事务 */ }
      throw err;
    } finally {
      this._depth = 0;
      // 事务里攒下的那次收口,在这儿补上(此时已经不在事务里了)
      if (this._pending) { this._pending = false; this._writes = 0; this.checkpoint(); }
    }
  }

  // ---- 读:开机时一次性把库读成内存模型 ----
  // 为什么还留内存模型:全项目的读路径都是 store.chat_messages 这种数组操作,
  // 一次性全改成 SQL 查询是另一个量级的改动面。这一版只换**写**的代价
  // (O(全库) → O(改动)),读照旧。库大到读不动是下一个问题,不是这一版的问题。
  loadAll() {
    const rows = (sql, ...a) => this.db.prepare(sql).all(...a);
    const kv = {};
    for (const r of rows('SELECT key, value FROM kv')) {
      try { kv[r.key] = JSON.parse(r.value); } catch { /* 坏了就当没有,用默认值 */ }
    }
    const tagsBy = new Map();
    for (const r of rows('SELECT memory_id, tag FROM memory_tags')) {
      if (!tagsBy.has(r.memory_id)) tagsBy.set(r.memory_id, []);
      tagsBy.get(r.memory_id).push(r.tag);
    }
    const vecBy = new Map(rows('SELECT * FROM memory_embeddings').map((r) => [r.memory_id, r]));
    const chunksBy = new Map();
    for (const r of rows('SELECT * FROM document_chunks ORDER BY document_id, seq')) {
      if (!chunksBy.has(r.document_id)) chunksBy.set(r.document_id, []);
      const c = { text: r.text };
      if (r.embedding_tag) { c.embedding_tag = r.embedding_tag; c.embedding_b64 = r.embedding_b64; }
      chunksBy.get(r.document_id).push(c);
    }
    const msg = (r) => ({
      id: r.id, scope: r.scope, sender: r.sender, role: r.role, content: r.content,
      thinking: r.thinking, msg_type: r.msg_type, session_id: r.session_id, parent_msg_id: r.parent_msg_id,
      attachments: safeJson(r.attachments, []),
      favorited: !!r.favorited, recalled: !!r.recalled, recalled_at: r.recalled_at,
      created_at: r.created_at,
    });
    const all = rows('SELECT * FROM messages ORDER BY id');

    // ★ counters 保险带:取 max(表内最大 id + 1, kv 里存的值)。
    //   为什么需要:nextId() 只动内存里的 counters,而增量写(hint)只写那一行。
    //   一旦 counters 因为任何原因没落盘,重启后 nextId 会**发一个已经用过的 id**,
    //   而 putMessage 是 ON CONFLICT(id) DO UPDATE —— 那不是插入失败,是**静默盖掉旧消息**。
    //   所以读回时不完全信 kv,拿表里的真实最大 id 兜一道。宁可跳号,不能覆盖。
    const maxOf = (t) => int(this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${t}`).get().m, 0);
    const counters = { ...(kv.counters || {}) };
    for (const [kind, table] of [['message', 'messages'], ['memory', 'memories'],
      ['console', 'console_events'], ['document', 'documents'], ['sticker', 'stickers']]) {
      counters[kind] = Math.max(int(counters[kind], 1), maxOf(table) + 1);
    }

    return {
      ...kv,
      counters,
      chat_messages: all.filter((r) => r.scope !== 'group').map(msg),
      group_messages: all.filter((r) => r.scope === 'group').map(msg),
      memories: rows('SELECT * FROM memories ORDER BY id').map((r) => {
        const v = vecBy.get(r.id);
        return {
          id: r.id, title: r.title, content: r.content, mood: r.mood, author: r.author,
          pinned: !!r.pinned, tags: tagsBy.get(r.id) || [], fact_key: r.fact_key,
          superseded_by: r.superseded_by, superseded_at: r.superseded_at,
          strength: r.strength, archived: !!r.archived, archived_at: r.archived_at,
          created_at: r.created_at, updated_at: r.updated_at,
          ...(v ? { embedding_tag: v.embedding_tag, embedding_b64: v.embedding_b64 } : {}),
        };
      }),
      documents: rows('SELECT * FROM documents ORDER BY id').map((r) => ({
        id: r.id, name: r.name, source: r.source, content: r.content, size: r.size,
        chunks: chunksBy.get(r.id) || [], created_at: r.created_at, updated_at: r.updated_at,
      })),
      console_events: rows('SELECT * FROM console_events ORDER BY id').map((r) => ({
        id: r.id, kind: r.kind, title: r.title, body: r.body, created_at: r.created_at,
      })),
      stickers: rows('SELECT * FROM stickers ORDER BY id').map((r) => ({
        id: r.id, name: r.name, url: r.url, created_at: r.created_at,
      })),
    };
  }

  // ---- 写:每种改动只碰它自己那几行 ----
  // 写够数就把 WAL 压回主库。放在这些写入口上,长驻进程也能定期收口。
  _tick() {
    if (++this._writes < this._checkpointEvery) return;
    // ★ 事务里收不了口。`PRAGMA wal_checkpoint` 在打开的事务中**不报错**,
    //   它静默返回 {busy:0, log:0, checkpointed:0} —— 一帧都没搬。
    //   而生产路径(state.js 的 saveStoreSqlite)每次写都包在 tx 里,
    //   所以这里要是直接收,就是发空炮:还顺手把 _writes 清零,导致**永远**收不成。
    //   记一笔,等最外层事务提交完再补。
    if (this._depth > 0) { this._pending = true; return; }
    this._writes = 0;
    this.checkpoint();
  }

  putKv(key, value) { this.q.putKv.run(key, JSON.stringify(value)); this._tick(); }
  putKvAll(store) { this.tx(() => { for (const k of KV_KEYS) if (store[k] !== undefined) this.putKv(k, store[k]); }); }

  putMessage(m) {
    this.q.insMsg.run(int(m.id), str(m.scope, 'chat'), str(m.sender, 'unknown'),
      m.role === 'assistant' ? 'assistant' : 'user', str(m.content), str(m.thinking),
      str(m.msg_type, 'chat'), str(m.session_id), m.parent_msg_id == null ? null : int(m.parent_msg_id),
      JSON.stringify(m.attachments || []), bool(m.favorited), bool(m.recalled),
      str(m.recalled_at), str(m.created_at));
    this._tick();
  }
  deleteMessage(id) { this.q.delMsg.run(int(id)); }
  clearScope(scope) { this.q.delScope.run(str(scope, 'chat')); }

  putConsoleEvent(e, cap) {
    this.q.insEvent.run(int(e.id), str(e.kind, 'event'), str(e.title), str(e.body), str(e.created_at));
    if (cap > 0) this.q.trimEvents.run(int(cap));
    this._tick();
  }

  putMemory(m) {
    this.tx(() => {
      this.q.insMem.run(int(m.id), str(m.title), str(m.content), str(m.mood), str(m.author),
        bool(m.pinned), str(m.fact_key), m.superseded_by == null ? null : int(m.superseded_by),
        str(m.superseded_at), int(m.strength, 50), bool(m.archived), str(m.archived_at),
        str(m.created_at), str(m.updated_at));
      this.q.clrTags.run(int(m.id));
      for (const t of Array.isArray(m.tags) ? m.tags : []) this.q.insTag.run(int(m.id), str(t));
      if (m.embedding_tag && m.embedding_b64) this.q.putVec.run(int(m.id), str(m.embedding_tag), str(m.embedding_b64));
      else this.q.delVec.run(int(m.id));
    });
  }
  deleteMemory(id) { this.q.delMem.run(int(id)); }   // tags/向量靠 ON DELETE CASCADE 跟着走

  putDocument(d) {
    this.tx(() => {
      this.q.insDoc.run(int(d.id), str(d.name, 'untitled'), d.source === 'upload' ? 'upload' : 'typed',
        str(d.content), int(d.size), str(d.created_at), str(d.updated_at));
      this.q.clrChunks.run(int(d.id));
      (Array.isArray(d.chunks) ? d.chunks : []).forEach((c, i) => {
        const text = typeof c === 'string' ? c : str(c && c.text);
        this.q.insChunk.run(int(d.id), i, text, str(c && c.embedding_tag), str(c && c.embedding_b64));
      });
    });
  }
  deleteDocument(id) { this.q.delDoc.run(int(id)); }

  putSticker(s) { this.q.insSticker.run(int(s.id), str(s.name), str(s.url), str(s.created_at)); }
  deleteSticker(id) { this.q.delSticker.run(int(id)); }

  // 兜底:把整个内存模型全量写一遍。只在首次从 JSON 接管、或者调用方说不清改了什么时用。
  // 平时不该走这里 —— 走这里就等于把 JSON 那份 O(全库) 的代价原样搬过来了。
  replaceAll(store) {
    this.tx(() => {
      for (const t of ['memory_tags', 'memory_embeddings', 'document_chunks', 'messages', 'memories', 'documents', 'console_events', 'stickers']) {
        this.db.exec(`DELETE FROM ${t}`);
      }
      for (const k of KV_KEYS) if (store[k] !== undefined) this.putKv(k, store[k]);
      for (const m of [...(store.chat_messages || []), ...(store.group_messages || [])]) this.putMessage(m);
      // ★ 走 putMemory,不再手抄一份写入逻辑。
      //   原来这里是复制粘贴的第二份 —— 变异测试逮到了:把 putMemory 的标签循环删掉,
      //   整套测试照样全绿,因为往返测试走的是 replaceAll 这条**备用**路径,
      //   而它自带一份完好的副本替真正跑在线上的那条打掩护。
      //   两份实现 = 测一份等于没测。superseded_by 仍旧留到第二趟连(新记忆 id 更大)。
      for (const m of store.memories || []) this.putMemory({ ...m, superseded_by: null });
      // 顶替关系第二趟连 —— 新记忆 id 更大,单趟插会撞外键
      const link = this.db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?');
      for (const m of store.memories || []) if (m.superseded_by != null) link.run(int(m.superseded_by), int(m.id));
      for (const d of store.documents || []) this.putDocument(d);
      for (const e of store.console_events || []) this.putConsoleEvent(e, 0);
      for (const s of store.stickers || []) this.putSticker(s);
    });
  }

  // 空库 = 还没从 JSON 接管过。用 kv 判断而不是 messages —— 一个从没聊过天的新用户
  // messages 本来就是空的,拿它判会把新库误当成"待接管"。
  isEmpty() { return int(this.db.prepare('SELECT COUNT(*) c FROM kv').get().c) === 0; }

  // ★ 把 WAL 压回主库并截断 WAL 文件。
  //
  // 为什么必须显式做:`wal_autocheckpoint=1000` 默认开着,它确实会搬数据进主库,
  // **但它是 PASSIVE 的、从不缩小 WAL 文件**,而且长连接下主库可以任意落后。
  // 实测:跑一整轮里主库停在 228KB 而 WAL 一直是 4MB,只有 close() 那一下才收口 ——
  // 而服务器是长驻的,可能几周不 close。真实部署上遇到过:主库 4096 字节(空壳)、
  // 数据全在 4MB 的 WAL 里。
  // ★ 后果不是丢数据(整库完好、integrity_check ok),而是 ——
  //   **谁只备份了 app.db,谁就备份了一个空文件。**
  //   这正是长期无人值守时最容易咬人的形态:照着文档备份,拿到的是一个 4KB 的壳。
  checkpoint(mode = 'TRUNCATE') {
    try { return this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get(); }
    catch { return null; }   // 有并发读时会 busy —— 下次再来。它是收口不是保命,
                             // 数据留在 WAL 里本来就是安全的,不值得为它抛错。
  }

  close() {
    this.checkpoint();       // 关之前先收口
    try { this.db.close(); } catch { /* 已经关了 */ }
  }
}

function safeJson(s, dflt) {
  try { const v = JSON.parse(s); return v == null ? dflt : v; } catch { return dflt; }
}
