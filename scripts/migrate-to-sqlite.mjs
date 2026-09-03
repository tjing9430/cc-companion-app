#!/usr/bin/env node
// app-data.json → SQLite 迁移骨架。
//
// 状态:骨架。schema 还没过审(见 docs/SQLITE-SCHEMA-DRAFT.md),先不要对真数据跑。
//
// 三条设计原则,都是被咬出来的:
//
// ① **默认不写盘。** 不带 --write 就是演习:照样建表、照样灌数据、照样跑全部断言,
//    只是跑完把库删掉。想知道"能不能迁"不需要先冒一次险。
//
// ② **断言是控制流,不是打印。** 每条检查失败就 throw,事务整体回滚。
//    "能看见失败"和"失败被挡住"是两回事 —— 这一晚栽过两次。
//
// ③ **原文件只读。** 迁完 app-data.json 一个字节没动,回滚 = 删掉 .db 继续用 JSON。
//
// 用法:
//   node scripts/migrate-to-sqlite.mjs                      # 演习(默认)
//   node scripts/migrate-to-sqlite.mjs --write              # 真写
//   node scripts/migrate-to-sqlite.mjs --allow-repairs      # 允许把悬空引用置 NULL
//   DATA_DIR=/tmp/x node scripts/migrate-to-sqlite.mjs      # 换数据目录
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 免 flag 能拿到 node:sqlite 的最低版本。这两个数是下官方二进制实测出来的,不是查文档抄的:
//   v22.12.0 → ERR_UNKNOWN_BUILTIN_MODULE   v22.13.0 → ✅
//   v23.3.0  → ERR_UNKNOWN_BUILTIN_MODULE   v23.4.0  → ✅
// ★ 注意 23.0–23.3 是个洞:unflag 在 22 线和 23 线是分别落的(nodejs/node#55890)。
//   所以 engines 不能写 >=22.13.0 —— 那会把这个洞放进来。
export const NODE_REQUIREMENT = '^22.13.0 || >=23.4.0';

export async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch {
    throw new Error(
      `这个 Node 拿不到内置 sqlite(当前 ${process.version})。\n`
      + `  免 flag 可用:v22.13.0+(22 线)、v23.4.0+(23 线及以上)\n`
      + `  v22.5–v22.12 和 v23.0–v23.3 要加 --experimental-sqlite\n`
      + `  本项目要求:${NODE_REQUIREMENT}`,
    );
  }
}

// DDL 单独导出,让测试能直接建一个空库验结构,不必走整条迁移。
export const SCHEMA_SQL = `
CREATE TABLE kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE messages (
  id            INTEGER PRIMARY KEY,
  scope         TEXT NOT NULL,
  sender        TEXT NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL DEFAULT '',
  thinking      TEXT NOT NULL DEFAULT '',
  msg_type      TEXT NOT NULL DEFAULT 'chat',
  -- ★ 这一列是**往返比对**逮出来的,不是扫代码扫出来的:真实库里每条消息都带 session_id,
  --   而我两轮 grep 字段都漏了它(第一次漏 favorited/recalled_at,这是第二次)。
  --   教训:字段清单的权威是**真实数据**,不是源码里的构造函数。
  session_id    TEXT NOT NULL DEFAULT '',
  parent_msg_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  attachments   TEXT NOT NULL DEFAULT '[]',
  favorited     INTEGER NOT NULL DEFAULT 0,
  recalled      INTEGER NOT NULL DEFAULT 0,
  recalled_at   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_messages_scope_id ON messages(scope, id);
CREATE INDEX idx_messages_parent   ON messages(parent_msg_id);

CREATE TABLE memories (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',
  mood          TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  pinned        INTEGER NOT NULL DEFAULT 0,
  fact_key      TEXT NOT NULL DEFAULT '',
  superseded_by INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  superseded_at TEXT NOT NULL DEFAULT '',
  strength      INTEGER NOT NULL DEFAULT 50,
  archived      INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_memories_active ON memories(id)
  WHERE superseded_by IS NULL AND archived = 0;
CREATE INDEX idx_memories_factkey ON memories(fact_key) WHERE fact_key <> '';

CREATE TABLE memory_tags (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX idx_memory_tags_tag ON memory_tags(tag);

CREATE TABLE memory_embeddings (
  memory_id     INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding_tag TEXT NOT NULL,
  embedding_b64 TEXT NOT NULL
);

CREATE TABLE entities (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'person',
  created_at TEXT NOT NULL,
  UNIQUE (name, kind)
);
CREATE TABLE memory_entities (
  memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);

CREATE TABLE documents (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'typed',
  content    TEXT NOT NULL DEFAULT '',
  size       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE document_chunks (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  text          TEXT NOT NULL,
  embedding_tag TEXT NOT NULL DEFAULT '',
  embedding_b64 TEXT NOT NULL DEFAULT '',
  UNIQUE (document_id, seq)
);
CREATE INDEX idx_chunks_embed ON document_chunks(embedding_tag);

CREATE TABLE console_events (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE stickers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  url        TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const SCHEMA_VERSION = '1';

const str = (v, dflt = '') => (v == null ? dflt : String(v));
const int = (v, dflt = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : dflt);
const bool = (v) => (v === true || v === 1 || v === '1' ? 1 : 0);

// 断言:失败就 throw,不是 console.log。事务在外层整体回滚。
function must(ok, message) {
  if (!ok) throw new Error(`验收断言不过 → ${message}`);
}

// 逐字段比对一行。返回不一致的字段名,空数组=一致。
function diffRow(source, row, fields) {
  const bad = [];
  for (const [key, expected] of Object.entries(fields)) {
    const actual = row[key];
    // SQLite 里 0/1 存布尔、NULL 存空引用,比之前先归一到同一种表示
    const a = typeof expected === 'number' ? Number(actual ?? 0) : str(actual);
    const b = typeof expected === 'number' ? Number(expected) : str(expected);
    if (a !== b) bad.push(`${key}(源=${JSON.stringify(b).slice(0, 60)} 库=${JSON.stringify(a).slice(0, 60)})`);
  }
  return bad;
}

// 抽样:小表全比,大表等距抽。等距而不是随机 —— 同一份数据每次跑抽到的是同一批,
// 出了问题能复现。
function sampleIndexes(total, cap = 200) {
  if (total <= cap) return Array.from({ length: total }, (_, i) => i);
  const step = total / cap;
  return Array.from({ length: cap }, (_, i) => Math.floor(i * step));
}

export async function migrate({ storePath, dbPath, write = false, allowRepairs = false, log = () => {} } = {}) {
  const { DatabaseSync } = await loadSqlite();

  const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const src = {
    messages: [...(raw.chat_messages || []), ...(raw.group_messages || [])],
    memories: raw.memories || [],
    documents: raw.documents || [],
    console_events: raw.console_events || [],
    stickers: raw.stickers || [],
  };

  // 私聊和群聊共用 nextId('message') 这一个序列,所以能合成一张表。
  // 但那是"现在的代码"如此,老数据未必 —— 所以这里不假设,直接验。
  const ids = src.messages.map((m) => int(m.id));
  must(new Set(ids).size === ids.length, '私聊+群聊里有重复的消息 id,合表会撞主键');

  if (write && fs.existsSync(dbPath)) throw new Error(`${dbPath} 已存在。迁移不覆盖已有库,先自己挪走。`);
  const target = write ? dbPath : `${dbPath}.dryrun-${process.pid}`;
  if (fs.existsSync(target)) fs.rmSync(target);

  const db = new DatabaseSync(target);
  const repairs = [];
  let foreignKeys = 0;
  try {
    // ★ 外键默认是关的。不显式打开,上面那些 REFERENCES 只是注释。
    db.exec('PRAGMA foreign_keys = ON');
    // 而且要**读回来确认**,不能设完就当它生效了 —— 这一晚在 sed 上栽过同一课:
    // 「发出去了」和「到了」是两件事。变异测试也证明:少了这一行,把上面改成 OFF
    // 整套测试照样全绿,这条 pragma 就成了摆设。
    foreignKeys = int(db.prepare('PRAGMA foreign_keys').get().foreign_keys);
    must(foreignKeys === 1, '外键没真打开,库里的 REFERENCES 只是注释');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_SQL);

    db.exec('BEGIN');

    // ---- kv:配置类整存,不拆列 ----
    // ★ counters 必须跟着迁,不能指望「SQLite 主键自己会发号」:
    //   INTEGER PRIMARY KEY 发的是 max(rowid)+1。历史硬删过行时 counters 会领先 max,
    //   那些「发过又被删掉」的 id 就会被**第二次发出去**。实测:表里 1,2,5 + counters=9,
    //   新行拿到 6 —— 6/7/8 都是旧系统发过的号。(插哨兵行再删也没用,删完高水位掉回去;
    //   只有 AUTOINCREMENT 才记得住,但那要改主键语义。)
    //   所以最省事也最准的做法就是:counters 原样存进 kv,发号权仍归它。
    const putKv = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)');
    for (const key of ['settings', 'session', 'context_anchor', 'memory_extract_cursor', 'counters']) {
      if (raw[key] !== undefined) putKv.run(key, JSON.stringify(raw[key]));
    }

    // ---- messages ----
    // 悬空的 parent_msg_id:JSON 里没有外键,指向已删消息是可能的。
    // 默认当成错误停下来,而不是"顺手修好了不吭声" —— 迁移期间偷偷改数据最难查。
    const known = new Set(ids);
    const putMsg = db.prepare(`INSERT INTO messages
      (id, scope, sender, role, content, thinking, msg_type, session_id, parent_msg_id, attachments, favorited, recalled, recalled_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const m of src.messages) {
      let parent = m.parent_msg_id == null ? null : int(m.parent_msg_id);
      if (parent != null && !known.has(parent)) {
        repairs.push(`消息 ${m.id} 的 parent_msg_id=${parent} 指向不存在的消息`);
        parent = null;
      }
      putMsg.run(int(m.id), str(m.scope, 'chat'), str(m.sender, 'unknown'),
        m.role === 'assistant' ? 'assistant' : 'user', str(m.content), str(m.thinking),
        str(m.msg_type, 'chat'), str(m.session_id), parent, JSON.stringify(m.attachments || []),
        bool(m.favorited), bool(m.recalled), str(m.recalled_at), str(m.created_at));
    }

    // ---- memories(+ 标签、向量分表)----
    const memIds = new Set(src.memories.map((m) => int(m.id)));
    const putMem = db.prepare(`INSERT INTO memories
      (id, title, content, mood, author, pinned, fact_key, superseded_by, superseded_at, strength, archived, archived_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const putTag = db.prepare('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
    const putVec = db.prepare('INSERT INTO memory_embeddings (memory_id, embedding_tag, embedding_b64) VALUES (?,?,?)');
    // 两趟:先全部插完再连 superseded_by,否则新记忆还没进表就被旧记忆引用
    for (const m of src.memories) {
      putMem.run(int(m.id), str(m.title), str(m.content), str(m.mood), str(m.author), bool(m.pinned),
        str(m.fact_key), null, str(m.superseded_at), int(m.strength, 50),
        bool(m.archived), str(m.archived_at), str(m.created_at), str(m.updated_at));
      for (const t of Array.isArray(m.tags) ? m.tags : []) putTag.run(int(m.id), str(t));
      if (m.embedding_tag && m.embedding_b64) putVec.run(int(m.id), str(m.embedding_tag), str(m.embedding_b64));
    }
    const link = db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?');
    for (const m of src.memories) {
      if (m.superseded_by == null) continue;
      const by = int(m.superseded_by);
      if (!memIds.has(by)) { repairs.push(`记忆 ${m.id} 的 superseded_by=${by} 指向不存在的记忆`); continue; }
      link.run(by, int(m.id));
    }

    // ---- documents + chunks ----
    const putDoc = db.prepare('INSERT INTO documents (id, name, source, content, size, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
    const putChunk = db.prepare('INSERT INTO document_chunks (document_id, seq, text, embedding_tag, embedding_b64) VALUES (?,?,?,?,?)');
    for (const d of src.documents) {
      putDoc.run(int(d.id), str(d.name, 'untitled'), d.source === 'upload' ? 'upload' : 'typed',
        str(d.content), int(d.size), str(d.created_at), str(d.updated_at));
      const chunks = Array.isArray(d.chunks) ? d.chunks : [];
      chunks.forEach((c, i) => {
        // chunk 在库里是 { text, embedding_tag?, embedding_b64? },不是裸字符串。
        // (写测试夹具时按裸字符串写过一次,白查一轮。)
        const text = typeof c === 'string' ? c : str(c && c.text);
        putChunk.run(int(d.id), i, text, str(c && c.embedding_tag), str(c && c.embedding_b64));
      });
    }

    // ---- console_events / stickers ----
    const putEv = db.prepare('INSERT INTO console_events (id, kind, title, body, created_at) VALUES (?,?,?,?,?)');
    for (const e of src.console_events) putEv.run(int(e.id), str(e.kind, 'event'), str(e.title), str(e.body), str(e.created_at));
    const putSticker = db.prepare('INSERT INTO stickers (id, name, url, created_at) VALUES (?,?,?,?)');
    for (const s of src.stickers) putSticker.run(int(s.id), str(s.name), str(s.url), str(s.created_at));

    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?,?)').run('schema_version', SCHEMA_VERSION);
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?,?)').run('migrated_from', path.basename(storePath));
    // 迁移时间戳:出事回头查「这库是哪一版、什么时候建的」全靠它
    db.prepare('INSERT INTO schema_meta (key, value) VALUES (?,?)').run('migrated_at', new Date().toISOString());

    // ================= 验收断言 =================
    // 全部在 COMMIT 之前跑。任何一条不过,下面的 catch 整体 ROLLBACK。

    // 断言 0:悬空引用。默认停,不默默改数据。
    must(allowRepairs || repairs.length === 0,
      `发现 ${repairs.length} 处悬空引用,迁移会把它们置 NULL(= 改了你的数据)。\n`
      + repairs.slice(0, 5).map((r) => `      · ${r}`).join('\n')
      + `\n    确认可以就加 --allow-repairs 再跑。`);

    // 断言 1:逐表 count 对齐。
    // ★ 这条是**真实数据那边唯一有牙的闸** —— 测试环境还有第二把尺子(测试自己硬编了
    //   预期条数),真数据这里没有,只有它自己。所以报错必须带**表名和差额**,
    //   让人一眼看出是哪张表丢了几条,而不是只知道「不对」。
    //   「它会咬人」由 test 里的负向测试证明:变异真脚本、跑真进程、验退出码。
    const countOf = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    for (const [table, expected] of [
      ['messages', src.messages.length], ['memories', src.memories.length],
      ['documents', src.documents.length], ['console_events', src.console_events.length],
      ['stickers', src.stickers.length],
      ['document_chunks', src.documents.reduce((n, d) => n + (Array.isArray(d.chunks) ? d.chunks.length : 0), 0)],
      ['memory_tags', new Set(src.memories.flatMap((m) => (Array.isArray(m.tags) ? m.tags : []).map((t) => JSON.stringify([m.id, t])))).size],
    ]) {
      const got = countOf(table);
      const delta = got - expected;
      must(got === expected,
        `${table} 条数对不上:源 ${expected} 条,库里 ${got} 条,`
        + `${delta < 0 ? `少了 ${-delta} 条` : `多了 ${delta} 条`}`);
    }

    // 断言 2:抽样内容逐字段比对(count 对不代表内容对)
    let compared = 0;
    for (const i of sampleIndexes(src.messages.length)) {
      const m = src.messages[i];
      const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(int(m.id));
      must(row, `消息 ${m.id} 在库里找不到`);
      const bad = diffRow(m, row, { scope: str(m.scope, 'chat'), sender: str(m.sender, 'unknown'), content: str(m.content), thinking: str(m.thinking), created_at: str(m.created_at) });
      must(bad.length === 0, `消息 ${m.id} 字段不一致:${bad.join(' / ')}`);
      compared++;
    }
    for (const i of sampleIndexes(src.memories.length)) {
      const m = src.memories[i];
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(int(m.id));
      must(row, `记忆 ${m.id} 在库里找不到`);
      const bad = diffRow(m, row, { title: str(m.title), content: str(m.content), mood: str(m.mood), author: str(m.author), fact_key: str(m.fact_key), strength: int(m.strength, 50), created_at: str(m.created_at) });
      must(bad.length === 0, `记忆 ${m.id} 字段不一致:${bad.join(' / ')}`);
      compared++;
    }
    for (const i of sampleIndexes(src.documents.length)) {
      const d = src.documents[i];
      const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(int(d.id));
      must(row, `资料 ${d.id} 在库里找不到`);
      // 文档正文首尾空白是内容的一部分,这里必须全等而不是 trim 后比
      must(str(row.content) === str(d.content), `资料 ${d.id} 正文不一致(长度 源 ${str(d.content).length} 库 ${str(row.content).length})`);
      compared++;
    }

    // 断言 3:关系完整性。交给 SQLite 自己查,比我手写靠谱。
    const fkBad = db.prepare('PRAGMA foreign_key_check').all();
    must(fkBad.length === 0, `外键检查有 ${fkBad.length} 条不满足:${JSON.stringify(fkBad.slice(0, 3))}`);

    // 断言 4:计数器不能发出一个已经用掉的 id。
    // ★ 是 counters > max(id),不是 == max+1 —— 删过行的表本来就有缺口。
    for (const [kind, table] of [['message', 'messages'], ['memory', 'memories'], ['console', 'console_events'], ['document', 'documents'], ['sticker', 'stickers']]) {
      const counter = int(raw.counters && raw.counters[kind], 0);
      const max = int(db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get().m, 0);
      if (!counter && !max) continue;
      must(counter > max, `counters.${kind}=${counter} 不大于 ${table} 的 max(id)=${max},下一个 id 会撞已有行`);
    }

    // 断言 5:往返。从库里读回来重建,和源逐条比 —— 这条最贵也最实在,
    // 前四条都过了但字段映射写反的情况,只有它抓得住。
    const backMsgs = db.prepare('SELECT id, scope, sender, role, content FROM messages ORDER BY id').all();
    const srcMsgs = [...src.messages].sort((a, b) => int(a.id) - int(b.id));
    must(backMsgs.length === srcMsgs.length, '往返:消息条数变了');
    for (let i = 0; i < backMsgs.length; i++) {
      must(int(backMsgs[i].id) === int(srcMsgs[i].id), `往返:第 ${i} 条 id 对不上`);
      must(str(backMsgs[i].content) === str(srcMsgs[i].content), `往返:消息 ${backMsgs[i].id} 正文对不上`);
    }

    db.exec('COMMIT');
    log(`✅ 断言全过(比对了 ${compared} 行样本)`);
    if (repairs.length) log(`⚠️  修补了 ${repairs.length} 处悬空引用(--allow-repairs 已开)`);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 没开事务就 ROLLBACK 会报错,忽略 */ }
    db.close();
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    throw err;
  }

  const stats = {};
  for (const t of ['messages', 'memories', 'memory_tags', 'memory_embeddings', 'documents', 'document_chunks', 'console_events', 'stickers', 'kv']) {
    stats[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  }
  db.close();

  if (!write) {
    fs.rmSync(target, { force: true });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${target}${suffix}`, { force: true });
    log('演习结束,库已删。要真写加 --write。');
  }
  return { stats, repairs, foreignKeys, dryRun: !write, dbPath: write ? dbPath : null };
}

// 直接跑才执行,被 import 时不执行。
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const storePath = path.join(dataDir, 'app-data.json');
  if (!fs.existsSync(storePath)) {
    console.error(`找不到 ${storePath}(用 DATA_DIR= 指定数据目录)`);
    process.exit(1);
  }
  try {
    const out = await migrate({
      storePath,
      dbPath: path.join(dataDir, 'app.db'),
      write: argv.includes('--write'),
      allowRepairs: argv.includes('--allow-repairs'),
      log: (m) => console.log(m),
    });
    console.log(Object.entries(out.stats).map(([k, v]) => `  ${k.padEnd(18)} ${v}`).join('\n'));
    if (out.dbPath) console.log(`\n已写入 ${out.dbPath}。原 app-data.json 未改动,回滚就是删掉 .db。`);
  } catch (err) {
    console.error(`\n❌ 迁移中止,库已回滚、原文件未动。\n${err.message}`);
    process.exit(1);
  }
}
