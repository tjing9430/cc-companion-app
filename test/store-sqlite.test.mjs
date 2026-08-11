// SQLite 存储后端。
//
// 这份测试的主角是**往返比对**,不是 CRUD:把一份数据写进去、读回来,
// 要求源里的每个字段都在、每个值都没变。
// ★ 它比「扫代码列字段」可靠得多 —— 实际逮到的:messages 少了一列 session_id。
//   我 grep 过两轮构造函数都没发现(第一轮漏 favorited/recalled_at,第二轮漏 session_id),
//   往返一跑就现形。**字段清单的权威是数据,不是源码。**
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store-sqlite.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sqlstore-'));

// 尽量像真数据:该有的边角都摆上(撤回痕、附件、顶替、chunk 向量、留白正文)
const SEED = {
  // ★ counters 必须**大于**各表最大 id —— 等于就意味着下一号会重发一个用过的号。
  //   第一版这里写了 sticker:1 而种子里就有 id=1 的贴纸,是我自己破了这条不变式;
  //   读侧保险带把它抬到 2 之后,这条往返断言才炸出来。保险带是对的,种子是错的。
  counters: { message: 9, memory: 5, console: 3, document: 2, sticker: 2 },
  session: { current_id: 'session-abc', forge_count: 2 },
  settings: { appName: 'CC', userName: '我', assistantName: 'AI', theme: 'starry', companion_since: '2026-03-16' },
  context_anchor: { chat: 3, group: 0 },
  memory_extract_cursor: { chat: 2, group: 0 },
  chat_messages: [
    { id: 1, scope: 'chat', sender: '我', role: 'user', content: '在吗', thinking: '', msg_type: 'chat', session_id: 'session-abc', parent_msg_id: null, attachments: [], favorited: false, recalled: false, recalled_at: '', created_at: '2026-01-01T10:00:00.000Z' },
    { id: 2, scope: 'chat', sender: 'AI', role: 'assistant', content: '在的', thinking: '想了想', msg_type: 'chat', session_id: 'session-abc', parent_msg_id: 1, attachments: [{ name: 'a.png', url: '/uploads/a.png' }], favorited: true, recalled: false, recalled_at: '', created_at: '2026-01-01T10:00:05.000Z' },
    { id: 8, scope: 'chat', sender: '我', role: 'user', content: '手滑', thinking: '', msg_type: 'chat', session_id: 'session-abc', parent_msg_id: null, attachments: [], favorited: false, recalled: true, recalled_at: '2026-01-01T10:10:00.000Z', created_at: '2026-01-01T10:09:00.000Z' },
  ],
  group_messages: [
    { id: 3, scope: 'group', sender: '我', role: 'user', content: '@assistant 早', thinking: '', msg_type: 'chat', session_id: '', parent_msg_id: null, attachments: [], favorited: false, recalled: false, recalled_at: '', created_at: '2026-01-01T10:01:00.000Z' },
  ],
  memories: [
    { id: 1, title: '住处', content: '住在青禾镇', mood: '平静', author: '我', pinned: false, tags: ['fact', 'place'], fact_key: '住处', superseded_by: 4, superseded_at: '2026-01-02T00:00:00.000Z', strength: 50, archived: false, archived_at: '', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 4, title: '住处', content: '搬到白露城', mood: '雀跃', author: '我', pinned: true, tags: ['fact'], fact_key: '住处', superseded_by: null, superseded_at: '', strength: 70, archived: false, archived_at: '', created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', embedding_tag: 'm1', embedding_b64: 'AAAA' },
  ],
  documents: [
    { id: 1, name: '缩进敏感.txt', source: 'typed', content: '  行首两空格\n\n结尾换行\n', size: 20, chunks: [{ text: '  行首两空格' }, { text: '结尾换行', embedding_tag: 'm1', embedding_b64: 'BBBB' }], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  ],
  console_events: [{ id: 1, kind: 'memory', title: '记忆已创建', body: '种子', created_at: '2026-01-01T10:02:00.000Z' }],
  stickers: [{ id: 1, name: '猫', url: '/uploads/cat.png', created_at: '2026-01-01T00:00:00.000Z' }],
};

async function withStore(fn) {
  const dir = tmp();
  const s = await openStore(path.join(dir, 'app.db'));
  try { return await fn(s, dir); } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('★★ 往返:源里每个字段都在、每个值都没变', async () => {
  await withStore(async (s) => {
    s.replaceAll(SEED);
    const back = s.loadAll();
    for (const coll of ['chat_messages', 'group_messages', 'memories', 'documents', 'console_events', 'stickers']) {
      const A = SEED[coll]; const B = back[coll];
      assert.equal(B.length, A.length, `${coll} 条数不对`);
      for (let i = 0; i < A.length; i++) {
        for (const k of Object.keys(A[i])) {
          assert.ok(k in B[i], `${coll}[${i}] 丢了字段 ${k} —— schema 少列会这样`);
          assert.deepEqual(B[i][k], A[i][k], `${coll}[${i}].${k} 值被改了`);
        }
      }
    }
    for (const k of ['settings', 'session', 'context_anchor', 'memory_extract_cursor']) {
      assert.deepEqual(back[k], SEED[k], `${k} 没原样回来`);
    }
    // counters 单独判:读侧有保险带,**只许抬高不许降低**(抬高=挡住重发用过的号)
    for (const [kind, v] of Object.entries(SEED.counters)) {
      assert.ok(back.counters[kind] >= v, `counters.${kind} 被降低了 —— 保险带只该往上抬`);
    }
  });
});

test('★ session_id 必须活着(这一列是往返比对逮出来的,不是扫代码扫出来的)', async () => {
  await withStore(async (s) => {
    s.replaceAll(SEED);
    assert.equal(s.loadAll().chat_messages[0].session_id, 'session-abc');
  });
});

test('文档正文首尾留白不许被 trim', async () => {
  await withStore(async (s) => {
    s.replaceAll(SEED);
    assert.equal(s.loadAll().documents[0].content, '  行首两空格\n\n结尾换行\n');
  });
});

test('★ 事务可重入:replaceAll 里套 putDocument/putMemory 不能炸', async () => {
  // 这条是跑起来才炸的:SQLite 不认嵌套 BEGIN,而 node --check 一路绿灯
  await withStore(async (s) => {
    assert.doesNotThrow(() => s.replaceAll(SEED));
    s.tx(() => { s.putMemory(SEED.memories[1]); s.putDocument(SEED.documents[0]); });
  });
});

test('顶替关系连得上(旧→新,新 id 更大,单趟插会撞外键)', async () => {
  await withStore(async (s) => {
    s.replaceAll(SEED);
    const m = s.loadAll().memories;
    assert.equal(m.find((x) => x.id === 1).superseded_by, 4);
    assert.equal(m.find((x) => x.id === 4).superseded_by, null);
  });
});

test('删记忆时标签和向量跟着走(ON DELETE CASCADE)', async () => {
  await withStore(async (s) => {
    s.replaceAll(SEED);
    s.deleteMemory(4);
    const back = s.loadAll();
    assert.equal(back.memories.length, 1);
    assert.equal(back.memories[0].id, 1);
    assert.equal(back.memories[0].embedding_tag, undefined, '向量该跟着记忆一起没');
  });
});

test('★ 增量写只碰一行 —— 这是这一刀的全部意义', async () => {
  await withStore(async (s) => {
    s.replaceAll(SEED);
    s.putMessage({ id: 99, scope: 'chat', sender: '我', role: 'user', content: '新的', session_id: 'session-abc', created_at: '2026-01-03T00:00:00.000Z' });
    const back = s.loadAll();
    assert.equal(back.chat_messages.length, 4);
    assert.equal(back.chat_messages.at(-1).content, '新的');
    // 其它行没被动过
    assert.equal(back.chat_messages[1].attachments[0].name, 'a.png');
  });
});

test('外键真开着 —— 关着的话 REFERENCES 只是注释', async () => {
  await withStore(async (s) => {
    assert.equal(Number(s.db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
  });
});

test('★★ 增量路径也要往返:线上真正跑的是 putXxx,不是 replaceAll', async () => {
  // 变异测试逮到的:上面那条往返测试走的是 replaceAll(兜底路径),
  // 而生产上每条消息/记忆/资料都走 putMessage/putMemory/putDocument。
  // 只测兜底 = 给真正跑的那条路打掩护。这条专门从零用增量写口建库。
  await withStore(async (s) => {
    s.tx(() => {
      for (const k of ['settings', 'session', 'counters', 'context_anchor', 'memory_extract_cursor']) s.putKv(k, SEED[k]);
      for (const m of [...SEED.chat_messages, ...SEED.group_messages]) s.putMessage(m);
      for (const m of SEED.memories) s.putMemory({ ...m, superseded_by: null });
      for (const d of SEED.documents) s.putDocument(d);
      for (const e of SEED.console_events) s.putConsoleEvent(e, 0);
      for (const k of SEED.stickers) s.putSticker(k);
    });
    s.putMemory(SEED.memories[0]);   // 第二趟连顶替关系
    const back = s.loadAll();
    for (const coll of ['chat_messages', 'group_messages', 'memories', 'documents', 'console_events', 'stickers']) {
      assert.equal(back[coll].length, SEED[coll].length, `${coll} 条数不对`);
      for (let i = 0; i < SEED[coll].length; i++) {
        for (const k of Object.keys(SEED[coll][i])) {
          assert.ok(k in back[coll][i], `${coll}[${i}] 增量路径丢了字段 ${k}`);
          assert.deepEqual(back[coll][i][k], SEED[coll][i][k], `${coll}[${i}].${k} 增量路径把值写坏了`);
        }
      }
    }
  });
});
