// 存储后端开关。
//
// 封笔版的风险姿势:**默认仍是 JSON**,sqlite 靠 STORE_BACKEND=sqlite 显式打开。
// 理由不是保守本身 —— 是 §6 定的回滚(「删掉 .db 继续用 JSON」)**只有 JSON 那条路
// 还活着时才成立**;硬切会把自己的回滚路径一起拆掉。
//
// 这份测试盯三件事:①默认没变 ②切过去数据一字不差 ③接管之后 JSON 不许被动
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEED = {
  counters: { message: 9, memory: 5, console: 3 },
  settings: { appName: 'CC', userName: '我', assistantName: 'AI', theme: 'starry' },
  chat_messages: [
    { id: 1, scope: 'chat', sender: '我', role: 'user', content: '在吗', session_id: 'sx', created_at: '2026-01-01T10:00:00.000Z' },
    { id: 2, scope: 'chat', sender: 'AI', role: 'assistant', content: '在的', session_id: 'sx', created_at: '2026-01-01T10:00:05.000Z' },
  ],
  // ★ 三个集合都得给一条:空的话 ensureSeedData() 会塞欢迎消息/示例记忆,
  //   顺手吃掉一个 id,counters 就不是我放进去的那个数了 —— 第一版就栽在这:
  //   断言 counters=9 拿到 10,我差点去查存储层,其实是种子被补了。
  group_messages: [{ id: 3, scope: 'group', sender: '我', role: 'user', content: '早', created_at: '2026-01-01T10:01:00.000Z' }],
  memories: [{ id: 1, title: '示例', content: 'x', mood: '平静', author: '我', tags: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }],
  documents: [], console_events: [], stickers: [],
};

// 在子进程里跑 —— state.js 的后端是模块加载那一刻定死的,同进程换 env 不算数。
// (这条本身就是个坑:如果在同进程里 setenv 再 import,拿到的是缓存的旧模块。)
function inChild(dir, backend, code) {
  const r = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO, encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir, STORE_BACKEND: backend, EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0' },
  });
  return new Promise((res) => {
    let out = ''; let err = '';
    r.stdout.on('data', (d) => { out += d; }); r.stderr.on('data', (d) => { err += d; });
    // ★ 只取最后一行:子进程 stdout 里除了我们要的 JSON,还可能有 app 自己的日志
    //   (比如首次接管时那句 "Adopted …")。整段 JSON.parse 会被日志噎住 ——
    //   这是我的夹具脆,不是 app 写错了:它的日志本来就都走 stdout。
    r.on('close', (code2) => res({ out: out.trim().split('\n').pop().trim(), raw: out, err, code: code2 }));
  });
}
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backend-'));

test('默认后端仍是 JSON —— 不设 STORE_BACKEND 就不该出现 .db', async () => {
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, 'app-data.json'), JSON.stringify(SEED));
  const r = await inChild(dir, '', `
    const m = await import('${REPO}/lib/state.js');
    m.store.chat_messages.push({ id: 3, scope:'chat', sender:'我', role:'user', content:'新', created_at:'2026-01-02T00:00:00.000Z' });
    m.saveStore();
    console.log(JSON.stringify({ msgs: m.store.chat_messages.length }));`);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).msgs, 3);
  assert.ok(!fs.existsSync(path.join(dir, 'app.db')), '默认档不该建库');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'app-data.json'), 'utf8')).chat_messages.length, 3, 'JSON 该被写回');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 切 sqlite:数据一字不差,而且 JSON 原封不动(它就是回滚路径)', async () => {
  const dir = mkdir();
  const jsonPath = path.join(dir, 'app-data.json');
  fs.writeFileSync(jsonPath, JSON.stringify(SEED));
  const before = fs.readFileSync(jsonPath);
  const r = await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    console.log(JSON.stringify({
      msgs: m.store.chat_messages.map((x) => [x.id, x.content, x.session_id]),
      settings: m.store.settings.theme, counters: m.store.counters.message,
    }));`);
  assert.equal(r.code, 0, r.err);
  const got = JSON.parse(r.out);
  assert.deepEqual(got.msgs, [[1, '在吗', 'sx'], [2, '在的', 'sx']], '接管后数据要一字不差');
  assert.equal(got.settings, 'starry');
  assert.equal(got.counters, 9);
  assert.ok(fs.existsSync(path.join(dir, 'app.db')), '该建库了');
  assert.deepEqual(fs.readFileSync(jsonPath), before, '★ 接管不许动 JSON —— 动了回滚就没了');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 增量写:再开一次进程,上一次写的还在(落盘是真的,不是只在内存)', async () => {
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, 'app-data.json'), JSON.stringify(SEED));
  const w = await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    const row = { id: 7, scope:'chat', sender:'我', role:'user', content:'落盘验证', session_id:'sx', created_at:'2026-01-03T00:00:00.000Z' };
    m.store.chat_messages.push(row);
    m.saveStore({ kind: 'message', row });   // 带 hint 的增量写
    console.log('ok');`);
  assert.equal(w.code, 0, w.err);
  const r = await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    console.log(JSON.stringify(m.store.chat_messages.map((x) => x.content)));`);
  assert.deepEqual(JSON.parse(r.out), ['在吗', '在的', '落盘验证']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('不给 hint 也必须是对的(22 个调用点可以一个一个改,漏改不会写坏数据)', async () => {
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, 'app-data.json'), JSON.stringify(SEED));
  await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    m.store.chat_messages.push({ id: 8, scope:'chat', sender:'我', role:'user', content:'没给提示', created_at:'2026-01-04T00:00:00.000Z' });
    m.saveStore();   // ← 故意不传 hint,走全量兜底
    console.log('ok');`);
  const r = await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    console.log(JSON.stringify(m.store.chat_messages.map((x) => x.content)));`);
  assert.deepEqual(JSON.parse(r.out), ['在吗', '在的', '没给提示'], '兜底路径也要写得进去');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JSON 坏了的时候,切 sqlite 要退回 JSON 后端,而不是拿半截库开张', async () => {
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, 'app-data.json'), '{ 这不是合法 JSON');
  const r = await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    console.log(JSON.stringify({ msgs: m.store.chat_messages.length }));`);
  assert.equal(r.code, 0, '不该崩,该降级:' + r.err);
  // 降级之后走 JSON 那条路:它自己会备份坏文件并起一个默认 store
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.broken-')), '坏 JSON 该被备份');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★★ counters 陷阱:hint 写行之后重启,绝不许把旧消息盖掉', async () => {
  // 评审在我改调用点**之前**逮到的雷,原样复现:
  //   nextId() 只改内存里的 counters;如果 hint 只写那一行,counters 永远落不了盘。
  //   重启后 nextId 发一个用过的 id → putMessage 是 ON CONFLICT(id) DO UPDATE
  //   → **不是插入失败,是静默盖掉她的旧消息**。这是最坏的一类 bug:没有报错、没有现象。
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, 'app-data.json'), JSON.stringify(SEED));

  // 进程一:像真实调用点那样 —— nextId 拿号 → 塞进内存 → 带 hint 写
  const w = await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    const id = m.nextId('message');
    const row = { id, scope:'chat', sender:'我', role:'user', content:'第一条新消息', session_id:'sx', created_at:'2026-02-01T00:00:00.000Z' };
    m.store.chat_messages.push(row);
    m.saveStore({ kind: 'message', row });
    console.log(JSON.stringify({ id, counter: m.store.counters.message }));`);
  assert.equal(w.code, 0, w.err);
  const first = JSON.parse(w.out);

  // 进程二:重启之后再发一条。★ 拿到的号必须比上一条大,否则就要覆盖了
  const w2 = await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    const id = m.nextId('message');
    const row = { id, scope:'chat', sender:'我', role:'user', content:'第二条新消息', session_id:'sx', created_at:'2026-02-02T00:00:00.000Z' };
    m.store.chat_messages.push(row);
    m.saveStore({ kind: 'message', row });
    console.log(JSON.stringify({ id }));`);
  assert.equal(w2.code, 0, w2.err);
  const second = JSON.parse(w2.out);
  assert.ok(second.id > first.id,
    `★ 重启后发的 id (${second.id}) 没有大过上一条 (${first.id}) —— 下一步就是把旧消息盖掉`);

  // 进程三:清点。两条新消息都要在,一条都不许被顶掉
  const r = await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    console.log(JSON.stringify(m.store.chat_messages.map((x) => x.content)));`);
  const all = JSON.parse(r.out);
  assert.ok(all.includes('第一条新消息'), '★ 第一条被后来的写盖掉了 —— 正是这个雷');
  assert.ok(all.includes('第二条新消息'));
  assert.equal(new Set(all).size, all.length, '出现重复内容,说明有行被覆盖后重建');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('★ 读侧保险带:kv 里的 counters 被人为改小,也不许发出已用过的号', async () => {
  const dir = mkdir();
  fs.writeFileSync(path.join(dir, 'app-data.json'), JSON.stringify(SEED));
  await inChild(dir, 'sqlite', `await import('${REPO}/lib/state.js');`);   // 先接管建库
  // 模拟"counters 落盘落丢了"的最坏情况:直接把 kv 里的值打回 1
  const { openStoreSync } = await import('../lib/store-sqlite.js');
  const s = openStoreSync(path.join(dir, 'app.db'));
  s.putKv('counters', { message: 1, memory: 1, console: 1 });
  s.close();
  const r = await inChild(dir, 'sqlite', `
    const m = await import('${REPO}/lib/state.js');
    console.log(JSON.stringify({ counter: m.store.counters.message, maxId: Math.max(...m.store.chat_messages.concat(m.store.group_messages).map((x) => x.id)) }));`);
  const got = JSON.parse(r.out);
  assert.ok(got.counter > got.maxId,
    `★ counters(${got.counter}) 必须大过表里最大 id(${got.maxId}) —— 否则下一号就是覆盖`);
  fs.rmSync(dir, { recursive: true, force: true });
});
