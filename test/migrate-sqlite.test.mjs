// JSON → SQLite 迁移骨架的测试。
//
// 重点不是"顺利那条路能跑通" —— 迁移脚本自己写的库自己比,顺利本来就该通。
// 重点是**每条断言真的能拦住东西**:所以下面一半的用例是喂坏数据、要求它中止。
// 断言没牙 = 迁移当天数据静默变形,谁都不知道。
//
// ★ node:sqlite 免 flag 要 Node 22.13+/23.4+(实测卡的边界)。拿不到就整份跳过,
//   不让它在还没换矩阵的 CI 上翻红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate, SCHEMA_SQL, loadSqlite, NODE_REQUIREMENT } from '../scripts/migrate-to-sqlite.mjs';

let sqliteOk = true;
try { await loadSqlite(); } catch { sqliteOk = false; }
const gate = { skip: sqliteOk ? false : `这个 Node(${process.version})没有免 flag 的 node:sqlite,本项目要求 ${NODE_REQUIREMENT}` };

// 种子:全是假数据,专门把各种边角撑出来。任何人的真实数据都不该进测试快照。
function seed(overrides = {}) {
  return {
    counters: { message: 9, memory: 5, console: 3, document: 2, sticker: 1 },
    session: { current_id: 'session-test', forge_count: 2 },
    settings: { appName: 'CC Companion', userName: '我', assistantName: '助手', theme: 'light' },
    context_anchor: { chat: 0, group: 0 },
    memory_extract_cursor: { chat: 0, group: 0 },
    // id 1/2 私聊、3 群聊 —— 两个 scope 共用一个序列,合表不该撞
    chat_messages: [
      { id: 1, scope: 'chat', sender: '我', role: 'user', content: '在吗', thinking: '', attachments: [], parent_msg_id: null, msg_type: 'chat', created_at: '2026-01-01T10:00:00.000Z' },
      { id: 2, scope: 'chat', sender: '助手', role: 'assistant', content: '在的', thinking: '先想一下', attachments: [{ name: 'a.png', url: '/uploads/a.png' }], parent_msg_id: 1, msg_type: 'chat', favorited: true, created_at: '2026-01-01T10:00:05.000Z' },
      // 撤回过的消息:正文留痕但标了 recalled(recalled_at 这一列我最初漏了)
      { id: 8, scope: 'chat', sender: '我', role: 'user', content: '手滑发的', recalled: true, recalled_at: '2026-01-01T10:10:00.000Z', created_at: '2026-01-01T10:09:00.000Z' },
    ],
    group_messages: [
      { id: 3, scope: 'group', sender: '我', role: 'user', content: '@assistant 早', attachments: [], parent_msg_id: null, msg_type: 'chat', created_at: '2026-01-01T10:01:00.000Z' },
    ],
    memories: [
      // 旧的指向新的:新记忆 id 更大,单趟插入会撞外键 —— 所以迁移要分两趟
      { id: 1, title: '住处', content: '住在甲地', mood: '平静', author: '我', tags: ['fact', 'place'], pinned: false, fact_key: '住处', superseded_by: 4, superseded_at: '2026-01-02T00:00:00.000Z', strength: 50, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: 4, title: '住处', content: '搬到乙地', mood: '雀跃', author: '我', tags: ['fact'], pinned: true, fact_key: '住处', superseded_by: null, superseded_at: '', strength: 70, embedding_tag: 'test-model', embedding_b64: 'AAAA', created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
    ],
    documents: [
      // 正文首尾留白是内容的一部分:谁在迁移里手贱 trim 一下,这条就红
      { id: 1, name: '缩进敏感.txt', source: 'typed', content: '  行首两空格\n\n结尾有换行\n', size: 20, chunks: [{ text: '  行首两空格' }, { text: '结尾有换行', embedding_tag: 'test-model', embedding_b64: 'BBBB' }], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    ],
    console_events: [{ id: 1, kind: 'memory', title: '记忆已创建', body: '种子', created_at: '2026-01-01T10:02:00.000Z' }],
    stickers: [],
    ...overrides,
  };
}

// ★ 必须是 async + await fn:第一版写成同步 try/finally,fn 一返回 Promise
//   finally 就把临时目录删了,里面的活还没开始跑 —— 18 条里 17 条 ENOENT。
async function withSeed(data, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  const storePath = path.join(dir, 'app-data.json');
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
  try { return await fn({ dir, storePath, dbPath: path.join(dir, 'app.db') }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const run = (data, opts = {}) => withSeed(data, async ({ storePath, dbPath, dir }) => {
  const r = await migrate({ storePath, dbPath, ...opts });
  return { ...r, dir, dbPath, storePath };
});

// 喂坏数据、要求中止。返回错误信息,便于断言它说人话。
async function mustAbort(data, opts = {}) {
  const err = await run(data, opts).then(() => null, (e) => e);
  assert.ok(err, '这份数据本该被拦住,结果迁移过了');
  return err.message;
}

test('演习是默认档:跑完全部断言,但不留库', gate, async () => {
  const out = await withSeed(seed(), async ({ storePath, dbPath, dir }) => {
    const r = await migrate({ storePath, dbPath });
    assert.equal(r.dryRun, true);
    assert.equal(r.dbPath, null);
    assert.ok(!fs.existsSync(dbPath), '演习不该留下 app.db');
    assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.db')).length, 0, '连临时库都要清干净');
    return r;
  });
  assert.equal(out.stats.messages, 4);
});

test('逐表 count 对齐(私聊+群聊合成一张 messages)', gate, async () => {
  const r = await run(seed());
  assert.equal(r.stats.messages, 4, '3 条私聊 + 1 条群聊');
  assert.equal(r.stats.memories, 2);
  assert.equal(r.stats.memory_tags, 3, 'fact/place + fact');
  assert.equal(r.stats.memory_embeddings, 1, '只有一条记忆带向量');
  assert.equal(r.stats.documents, 1);
  assert.equal(r.stats.document_chunks, 2);
  assert.equal(r.stats.console_events, 1);
  assert.equal(r.stats.kv, 5, 'settings/session/两个游标/counters');
});

test('--write 真写库,而且原 JSON 一个字节没动', gate, async () => {
  await withSeed(seed(), async ({ storePath, dbPath }) => {
    const before = fs.readFileSync(storePath);
    const r = await migrate({ storePath, dbPath, write: true });
    assert.equal(r.dbPath, dbPath);
    assert.ok(fs.existsSync(dbPath), '真写就该留下库');
    assert.deepEqual(fs.readFileSync(storePath), before, '迁移不许碰原文件 —— 回滚全靠它');
  });
});

test('不覆盖已有库(手滑重跑不该吃掉上一次的结果)', gate, async () => {
  await withSeed(seed(), async ({ storePath, dbPath }) => {
    fs.writeFileSync(dbPath, 'pretend this is a database');
    const err = await migrate({ storePath, dbPath, write: true }).then(() => null, (e) => e);
    assert.match(err?.message || '', /已存在/);
    assert.equal(fs.readFileSync(dbPath, 'utf8'), 'pretend this is a database', '已有文件必须原样留着');
  });
});

// ---------- 下面全是反例:证明断言有牙 ----------

test('★ 反例:私聊群聊 id 撞了 → 合表前就该停', gate, async () => {
  const bad = seed();
  bad.group_messages[0].id = 1; // 和私聊第一条撞
  assert.match(await mustAbort(bad), /重复的消息 id/);
});

test('★ 反例:parent_msg_id 悬空 → 默认停,不默默改成 NULL', gate, async () => {
  const bad = seed();
  bad.chat_messages[1].parent_msg_id = 999;
  const msg = await mustAbort(bad);
  assert.match(msg, /悬空引用/);
  assert.match(msg, /--allow-repairs/, '要告诉人怎么继续,不能只说不行');
});

test('加了 --allow-repairs 才修,而且要报出修了几处', gate, async () => {
  const bad = seed();
  bad.chat_messages[1].parent_msg_id = 999;
  const r = await run(bad, { allowRepairs: true });
  assert.equal(r.repairs.length, 1);
  assert.match(r.repairs[0], /999/);
});

test('★ 反例:superseded_by 指向不存在的记忆 → 停', gate, async () => {
  const bad = seed();
  bad.memories[0].superseded_by = 777;
  assert.match(await mustAbort(bad), /悬空引用/);
});

test('★ 反例:counters 落后于 max(id) → 停(下一个 id 会撞已有行)', gate, async () => {
  const bad = seed();
  bad.counters.message = 3; // 表里已经有 id=8
  const msg = await mustAbort(bad);
  assert.match(msg, /counters\.message/);
  assert.match(msg, /撞已有行/);
});

test('但 id 有缺口不该误报(删过行的表本来就不连续)', gate, async () => {
  const sparse = seed();
  sparse.chat_messages = [
    { id: 1, scope: 'chat', sender: '我', role: 'user', content: 'a', created_at: '2026-01-01T00:00:00.000Z' },
    { id: 7, scope: 'chat', sender: '我', role: 'user', content: 'b', created_at: '2026-01-01T00:00:01.000Z' },
  ];
  sparse.group_messages = [];
  sparse.counters.message = 9;
  const r = await run(sparse);
  assert.equal(r.stats.messages, 2, 'counters=9 > max=7,应当放行');
});

test('★ 反例:断言不过时整体回滚,不留半个库', gate, async () => {
  await withSeed(seed({ counters: { message: 1, memory: 5, console: 3, document: 2, sticker: 1 } }), async ({ storePath, dbPath, dir }) => {
    await migrate({ storePath, dbPath, write: true }).then(() => assert.fail('本该中止'), () => {});
    assert.ok(!fs.existsSync(dbPath), '失败后不许留下半个库让人以为迁成了');
    assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('app.db')).length, 0);
  });
});

// ---------- 内容保真 ----------

test('文档正文首尾留白必须原样(谁 trim 一下这条就红)', gate, async () => {
  const { DatabaseSync } = await loadSqlite();
  await withSeed(seed(), async ({ storePath, dbPath }) => {
    await migrate({ storePath, dbPath, write: true });
    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT content FROM documents WHERE id = 1').get();
    assert.equal(row.content, '  行首两空格\n\n结尾有换行\n');
    db.close();
  });
});

test('chunk 是 {text} 对象不是裸字符串,而且带向量的那条要迁过去', gate, async () => {
  const { DatabaseSync } = await loadSqlite();
  await withSeed(seed(), async ({ storePath, dbPath }) => {
    await migrate({ storePath, dbPath, write: true });
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare('SELECT seq, text, embedding_tag FROM document_chunks ORDER BY seq').all();
    assert.deepEqual(rows.map((r) => r.text), ['  行首两空格', '结尾有换行']);
    assert.equal(rows[1].embedding_tag, 'test-model');
    db.close();
  });
});

test('撤回痕迹三列都在(favorited / recalled / recalled_at —— 头两版我漏了后两个)', gate, async () => {
  const { DatabaseSync } = await loadSqlite();
  await withSeed(seed(), async ({ storePath, dbPath }) => {
    await migrate({ storePath, dbPath, write: true });
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('SELECT favorited FROM messages WHERE id=2').get().favorited, 1);
    const r = db.prepare('SELECT recalled, recalled_at, content FROM messages WHERE id=8').get();
    assert.equal(r.recalled, 1);
    assert.equal(r.recalled_at, '2026-01-01T10:10:00.000Z');
    assert.equal(r.content, '手滑发的', '撤回的消息正文在库里留痕,是 API 层不发出去');
    db.close();
  });
});

test('顶替关系连得上(旧→新,新 id 更大,单趟插入会撞外键)', gate, async () => {
  const { DatabaseSync } = await loadSqlite();
  await withSeed(seed(), async ({ storePath, dbPath }) => {
    await migrate({ storePath, dbPath, write: true });
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare('SELECT superseded_by FROM memories WHERE id=1').get().superseded_by, 4);
    assert.equal(db.prepare('SELECT superseded_by FROM memories WHERE id=4').get().superseded_by, null);
    const active = db.prepare('SELECT COUNT(*) c FROM memories WHERE superseded_by IS NULL AND archived=0').get().c;
    assert.equal(active, 1, '召回只该看到在效的那条');
    db.close();
  });
});

test('配置类整存进 kv,取回来还是原来的对象', gate, async () => {
  const { DatabaseSync } = await loadSqlite();
  await withSeed(seed(), async ({ storePath, dbPath }) => {
    await migrate({ storePath, dbPath, write: true });
    const db = new DatabaseSync(dbPath);
    const got = JSON.parse(db.prepare("SELECT value FROM kv WHERE key='settings'").get().value);
    assert.equal(got.assistantName, '助手');
    assert.equal(got.theme, 'light');
    db.close();
  });
});

test('★ 迁移脚本自己把外键打开了(不是测 SQLite,是测脚本)', gate, async () => {
  // 第一版这条只在测试里自己建库自己开 pragma —— 变异测试证明:把脚本里改成 OFF
  // 它照样全绿,等于什么都没测。现在改成读脚本返回的实测值。
  const r = await run(seed());
  assert.equal(r.foreignKeys, 1, '脚本没真把外键打开,库里的 REFERENCES 就只是注释');
});

test('DDL 本身的外键约束是有效的', gate, async () => {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  assert.throws(() => db.prepare('INSERT INTO memory_tags (memory_id, tag) VALUES (999, ?)').run('x'),
    /FOREIGN KEY/i, '指向不存在的记忆应当被数据库自己挡住');
  db.close();
});

test('空库也能迁(第一次装的人手上就是这个)', gate, async () => {
  const empty = { counters: {}, settings: {}, session: {}, chat_messages: [], group_messages: [], memories: [], documents: [], console_events: [], stickers: [] };
  const r = await run(empty);
  assert.equal(r.stats.messages, 0);
  assert.equal(r.stats.memories, 0);
});

// ---------- 负向测试:证明 count 断言真的会咬人 ----------
//
// 为什么单独用这种打法:count 断言在**测试环境里杀不掉** —— 测试自己也硬编了预期条数,
// 所以任何真丢行都会先被测试本身抓到,变异碰不到那条断言。可它恰恰是**真实数据迁移时
// 唯一有牙的闸**(真数据那边没有第二把尺子)。所以"它会咬人"必须在实弹前被证明一次。
//
// ★ 做法:把**真脚本**复制一份到临时目录、在副本上动刀、**当成真进程跑**,验退出码。
//   不在生产路径上留任何测试专用的钩子 —— 钩子以上的代码等于没跑过,
//   那样测到的就不是真正会运行的那条控制流。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_SCRIPT = fileURLToPath(new URL('../scripts/migrate-to-sqlite.mjs', import.meta.url));

// 在真脚本的副本上做一处外科手术,返回改好的临时脚本路径。
function mutatedScript(dir, from, to) {
  const src = fs.readFileSync(REAL_SCRIPT, 'utf8');
  // 锚点没命中要立刻炸,而不是"没改成功但测试照样绿" —— 那是最坏的一种假通过。
  assert.ok(src.includes(from), `变异锚点在真脚本里找不到:${from}\n(脚本被重构了?这条测试必须跟着更新,不能静默失效)`);
  const out = path.join(dir, 'migrate-mutated.mjs');
  fs.writeFileSync(out, src.replace(from, to));
  return out;
}

test('★★ 负向:迁移中途丢一行 → 脚本非零退出,报错带表名和差额', gate, async () => {
  await withSeed(seed(), async ({ dir, storePath, dbPath }) => {
    // 动刀点:写消息的那个循环少写最后一条。这是"迁移过程中静默丢行"的真实形态。
    const script = mutatedScript(dir, 'for (const m of src.messages) {', 'for (const m of src.messages.slice(0, -1)) {');

    const r = spawnSync(process.execPath, [script, '--write'], {
      env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8',
    });
    const output = `${r.stdout || ''}${r.stderr || ''}`;

    // ① 必须非零退出 —— 这是给 CI 和给人的那道闸。打印得再好看,退出码是 0 就等于没拦。
    assert.notEqual(r.status, 0, `丢了一行却退出码 0 —— 闸没关上。输出:\n${output}`);

    // ② 报错要说清是哪张表、差了几条
    assert.match(output, /messages/, '报错要带表名');
    assert.match(output, /源 4 条/, '要给出源里的条数');
    assert.match(output, /库里 3 条/, '要给出库里的条数');
    assert.match(output, /少了 1 条/, '要直接把差额算出来,别让人自己减');

    // ③ 失败就得干净回滚:不留半个库让人以为迁成了
    assert.ok(!fs.existsSync(dbPath), '断言不过还留着 .db —— 下次跑会被"已存在"挡住,更糊涂');
    // ④ 原文件一个字节没动
    assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8')).chat_messages.length, 3);
  });
});

test('★★ 负向对照:同一个真脚本不动刀,同样的种子必须成功 —— 证明上一条红是因为动了刀,不是因为跑法有问题', gate, async () => {
  await withSeed(seed(), async ({ dir, dbPath }) => {
    const r = spawnSync(process.execPath, [REAL_SCRIPT, '--write'], {
      env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, `没动刀却失败了:\n${r.stdout}${r.stderr}`);
    assert.ok(fs.existsSync(dbPath));
  });
});

test('★★ 负向:标签表丢行也照样咬(证明这条闸覆盖每张表,不只是 messages)', gate, async () => {
  await withSeed(seed(), async ({ dir }) => {
    const script = mutatedScript(dir,
      'for (const t of Array.isArray(m.tags) ? m.tags : []) putTag.run(int(m.id), str(t));',
      'for (const t of (Array.isArray(m.tags) ? m.tags : []).slice(0, -1)) putTag.run(int(m.id), str(t));');
    const r = spawnSync(process.execPath, [script, '--write'], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    assert.notEqual(r.status, 0);
    assert.match(output, /memory_tags/, '要指到 memory_tags 这张表');
    assert.match(output, /少了 2 条/, '两条记忆各丢一个标签 = 少 2');
  });
});
