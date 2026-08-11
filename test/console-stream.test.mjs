// 真 console 的原始流通道。
//
// 两条红线就是这份测试的全部重点,别的都次要:
//   ① **不入库一个字节** —— 一轮 ~510 行 / ~120KB,灌进 store 的话 148KB 的库一轮翻倍
//   ② **fail-open** —— 这条通道死了,聊天主链必须零感知(它是命根链路,这条是日志)
// 「日志通道拖垮业务」是经典事故形态,这里要从测试上钉死它不会发生。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

async function withApp(fn) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cstream-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, APP_AUTH_TOKEN: 't', EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0' },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 150; i++) {
      try { const r = await fetch(base + '/', { headers: { 'x-app-token': 't' } }); if (r.ok) break; } catch { /* 等 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return await fn(base, dir);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const push = (base, lines) => fetch(`${base}/api/console/stream`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-app-token': 't' },
  body: JSON.stringify({ lines }),
});

test('★★ 红线①:灌 600 行原始流,库一个字节都不许长', async () => {
  await withApp(async (base, dir) => {
    const file = path.join(dir, 'app-data.json');
    const before = fs.statSync(file).size;
    const beforeEvents = (await (await fetch(`${base}/api/console/events?limit=999`, { headers: { 'x-app-token': 't' } })).json()).length;
    const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'x' } } });
    for (let i = 0; i < 3; i++) assert.equal((await push(base, Array(200).fill(line))).status, 204);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(fs.statSync(file).size, before, '★ 库长大了 —— 这条通道必须是零写入');
    const afterEvents = (await (await fetch(`${base}/api/console/events?limit=999`, { headers: { 'x-app-token': 't' } })).json()).length;
    assert.equal(afterEvents, beforeEvents, '★ 原始流不许变成 console 事件');
  });
});

test('★ 原始流要真的广播出去(不落库不等于不送达)', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/stream?scope=chat`, { headers: { 'x-app-token': 't' } });
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let seen = '';
    const collect = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += dec.decode(value, { stream: true });
        if (seen.includes('console-stream')) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 300));
    await push(base, ['{"type":"result","subtype":"success"}']);
    await Promise.race([collect, new Promise((r) => setTimeout(r, 5000))]);
    reader.cancel().catch(() => {});
    assert.ok(seen.includes('console-stream'), 'SSE 里没收到 console-stream 事件');
    assert.ok(seen.includes('"type":\\"result\\"') || seen.includes('result'), '收到的内容里该有原始行');
  });
});

test('未鉴权打不进来', async () => {
  await withApp(async (base) => {
    const r = await fetch(`${base}/api/console/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines: ['x'] }),
    });
    assert.equal(r.status, 401);
  });
});

test('畸形输入不炸(lines 不是数组 / 超长行 / 空)', async () => {
  await withApp(async (base) => {
    for (const body of ['{"lines":"不是数组"}', '{}', '{"lines":[]}', `{"lines":["${'x'.repeat(9000)}"]}`]) {
      const r = await fetch(`${base}/api/console/stream`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-app-token': 't' }, body,
      });
      assert.ok(r.status === 204, `${body.slice(0, 30)} 该被安静收下,得到 ${r.status}`);
    }
  });
});

test('★★ 红线②:tee 的结构守卫 —— 不许 await、必须吞错、必须有队列上限', () => {
  const src = fs.readFileSync(path.join(REPO, 'bridge', 'index.js'), 'utf8');
  const i = src.indexOf('function flushRaw');
  assert.ok(i > 0, 'flushRaw 不见了');
  // ★ 切到**函数结束**为止,不能拍脑袋切固定字符数。
  //   今天早些时候头像那道守卫就栽在这(切进隔壁 /api/settings 分支),
  //   这里我又犯了一次:900 字符正好越进 postConsole,而它是**合法**要 await 的,
  //   于是断言对着别人的代码报警。同一个错一天两次,说明「切片要有边界」得成肌肉记忆。
  const rest = src.slice(i);
  const next = rest.indexOf('\nasync function ', 10);
  const next2 = rest.indexOf('\nfunction ', 10);
  const end = Math.min(...[next, next2].filter((n) => n > 0));
  const block = Number.isFinite(end) ? rest.slice(0, end) : rest;
  assert.ok(!/await\s+fetch/.test(block), '★ tee 不许 await —— 等它就是让日志给回话让路');
  assert.ok(/\.catch\(/.test(block), '★ tee 必须吞错,否则一次失败就变成未处理拒绝');
  assert.ok(/AbortSignal\.timeout/.test(block), 'tee 必须带超时');
  // ★ 盯**截断动作**而不是常量名:第一版只 grep 常量,把声明改个名字它照样绿
  //   (因为使用处还留着同名字符串)。守卫要盯行为,别盯拼写。
  assert.match(src, /streamQueue\s*=\s*streamQueue\.slice\(-/,
    '★ 队列必须真的被截断 —— 下游堵住时宁可丢日志,不能涨内存');
  assert.ok(/streamBroken\s*=\s*true/.test(src), '★ 失败一次就该闭嘴,不反复重试刷日志');
});
