// 事实键顶替:同一个事实键上只有最新那条参与召回,旧的留档但不抢话。
// 病症(实测过):「住北京」和「搬到上海」两条并排躺着,搜「住」两条一起进 prompt,模型自己蒙一个。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// import.meta.dirname 要 Node 20.11+,引擎下限是 18,走 fileURLToPath 老路
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

async function startApp() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factkey-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, APP_AUTH_TOKEN: 't', EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/', { headers: { 'x-app-token': 't' } }); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const api = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-app-token': 't' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(() => { try { child.kill('SIGKILL'); } catch {} r(); }, 4000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { api, stop };
}

const list = async (api) => (await api('GET', '/api/memory')).body;
const byId = (rows, id) => rows.find((m) => m.id === id);
// 召回走 /api/memory?q= 之外的内部路径,这里用搜索接口看「还能不能被捞出来」不够准;
// 直接看 superseded_by 字段 + 用 recall 的公开代理(搜索)双查。
const search = async (api, q) => (await api('GET', `/api/memory?q=${encodeURIComponent(q)}`)).body;

test('同键的新事实顶替旧事实,旧的留档不删', async () => {
  const { api, stop } = await startApp();
  try {
    const a = (await api('POST', '/api/memory', { title: '住处', content: '住在北京', fact_key: '住处' })).body;
    const b = (await api('POST', '/api/memory', { title: '住处', content: '搬到上海了', fact_key: '住处' })).body;
    const rows = await list(api);
    assert.equal(byId(rows, a.id).superseded_by, b.id, '旧的要指向新的');
    assert.ok(byId(rows, a.id).superseded_at, '要有顶替时间');
    assert.equal(byId(rows, b.id).superseded_by, null, '新的还在生效');
    assert.ok(byId(rows, a.id), '旧的必须还在库里(留档可回溯,不是删除)');
  } finally { await stop(); }
});

test('没填事实键 = 不建冲突(宁可漏顶替,不可错顶替)', async () => {
  const { api, stop } = await startApp();
  try {
    const a = (await api('POST', '/api/memory', { title: '住处', content: '住在北京' })).body;
    const b = (await api('POST', '/api/memory', { title: '住处', content: '搬到上海了' })).body;
    const rows = await list(api);
    assert.equal(byId(rows, a.id).superseded_by, null);
    assert.equal(byId(rows, b.id).superseded_by, null);
  } finally { await stop(); }
});

test('不同键之间互不干扰', async () => {
  const { api, stop } = await startApp();
  try {
    const home = (await api('POST', '/api/memory', { title: '住处', content: '北京', fact_key: '住处' })).body;
    const job = (await api('POST', '/api/memory', { title: '工作', content: '在读书', fact_key: '工作' })).body;
    const rows = await list(api);
    assert.equal(byId(rows, home.id).superseded_by, null);
    assert.equal(byId(rows, job.id).superseded_by, null);
  } finally { await stop(); }
});

test('把已有记忆编辑成某个键,它成为在效条目、同键其余让位', async () => {
  const { api, stop } = await startApp();
  try {
    const a = (await api('POST', '/api/memory', { title: '住处', content: '北京', fact_key: '住处' })).body;
    const b = (await api('POST', '/api/memory', { title: '住处', content: '上海' })).body;
    await api('PATCH', `/api/memory/${b.id}`, { fact_key: '住处' });
    const rows = await list(api);
    assert.equal(byId(rows, a.id).superseded_by, b.id, '编辑过的那条是用户最新的意思');
    assert.equal(byId(rows, b.id).superseded_by, null);
  } finally { await stop(); }
});

test('被顶替过的记忆若重新成为最新,自己复活', async () => {
  const { api, stop } = await startApp();
  try {
    const a = (await api('POST', '/api/memory', { title: '住处', content: '北京', fact_key: '住处' })).body;
    const b = (await api('POST', '/api/memory', { title: '住处', content: '上海', fact_key: '住处' })).body;
    await api('PATCH', `/api/memory/${a.id}`, { fact_key: '住处', content: '又搬回北京了' });
    const rows = await list(api);
    assert.equal(byId(rows, a.id).superseded_by, null, 'a 重新在效');
    assert.equal(byId(rows, b.id).superseded_by, a.id, '换 b 让位');
  } finally { await stop(); }
});

test('删掉在效那条,不会让旧事实自己爬回来', async () => {
  const { api, stop } = await startApp();
  try {
    const a = (await api('POST', '/api/memory', { title: '住处', content: '北京', fact_key: '住处' })).body;
    const b = (await api('POST', '/api/memory', { title: '住处', content: '上海', fact_key: '住处' })).body;
    await api('DELETE', `/api/memory/${b.id}`);
    const rows = await list(api);
    assert.equal(byId(rows, a.id).superseded_by, b.id, '过时的事实不该因为删除而无声复活');
  } finally { await stop(); }
});

test('三代连续顶替,只剩最后一条在效', async () => {
  const { api, stop } = await startApp();
  try {
    const ids = [];
    for (const c of ['北京', '上海', '广州']) {
      ids.push((await api('POST', '/api/memory', { title: '住处', content: c, fact_key: '住处' })).body.id);
    }
    const rows = await list(api);
    assert.equal(rows.filter((m) => m.fact_key === '住处' && !m.superseded_by).length, 1);
    assert.equal(byId(rows, ids[2]).superseded_by, null);
  } finally { await stop(); }
});

test('新字段进了 API 形状(记忆页照这个形状画)', async () => {
  const { api, stop } = await startApp();
  try {
    const m = (await api('POST', '/api/memory', { title: 'x', content: 'y' })).body;
    for (const k of ['fact_key', 'superseded_by', 'superseded_at', 'strength']) {
      assert.ok(k in m, `返回里要有 ${k}`);
    }
    assert.equal(m.strength, 50, 'strength 先占位给默认值,排序逻辑还没接');
  } finally { await stop(); }
});

test('搜索仍然看得到被顶替的(UI 要能显示「已被顶替」)', async () => {
  const { api, stop } = await startApp();
  try {
    await api('POST', '/api/memory', { title: '住处', content: '住在北京', fact_key: '住处' });
    await api('POST', '/api/memory', { title: '住处', content: '搬到上海了', fact_key: '住处' });
    const hits = await search(api, '住');
    assert.ok(hits.length >= 2, '列表/搜索不过滤,过滤只发生在喂给模型的召回上');
  } finally { await stop(); }
});
