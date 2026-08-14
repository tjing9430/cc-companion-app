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

// 主库**内容指纹**:红线①的判据,第三版。
// ★ 版本考古,三把尺子一把比一把接近效果本身:
//   v1  stat app-data.json          → sqlite 下 ENOENT,检查压根没跑(#70①)
//   v2  字节 app-data.json+db+wal   → 字节仍是**代理**:小匠实测 checkpoint 会把 -wal
//       截断回 0,真写 300 行总字节反而净减 49KB —— 泄漏可被抵消成假绿,
//       阳性对照也可能被同一机制搞成偶发红
//   v3  内容指纹(现在这把)          → 效果本身:库里**存了什么**。checkpoint 搬字节
//       不搬内容;行数会漏掉 UPDATE 型泄漏(往已有行里塞流水),内容哈希连它也咬
// ★ sqlite 侧动态枚举 sqlite_master 的用户表 —— 新表自动进指纹,不用回来登记。
// ★ readOnly 打开:观测者不许给被观测的库添一个字节。
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
function storeFingerprint(dir) {
  const parts = [];
  const jf = path.join(dir, 'app-data.json');
  if (fs.existsSync(jf)) parts.push('json:' + JSON.stringify(JSON.parse(fs.readFileSync(jf, 'utf8'))));
  const dbf = path.join(dir, 'app.db');
  if (fs.existsSync(dbf)) {
    const db = new DatabaseSync(dbf, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      for (const t of tables) {
        parts.push(`${t.name}:` + JSON.stringify(db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()));
      }
    } finally { db.close(); }
  }
  if (!parts.length) return null;   // 一个库文件都没有:让断言自己红,别拿空指纹装"量过了"
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

test('★★ 红线①:灌 600 行原始流,库里的内容一个字都不许变', async () => {
  await withApp(async (base, dir) => {
    const before = storeFingerprint(dir);
    assert.ok(before, '主库文件一个都没找到 —— 指纹量了个寂寞,这条测试没在测东西');
    const line = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: 'x' } } });
    for (let i = 0; i < 3; i++) assert.equal((await push(base, Array(200).fill(line))).status, 204);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(storeFingerprint(dir), before, '★ 库的内容变了 —— 这条通道必须是零写入');
    // ★ 常驻阳性对照:走一条**该**落库的通道(console 事件),指纹必须变。
    //   没有这半,上面那个 equal 在"尺子量错东西"时照样绿 —— v1 就是这么瞒过去的。
    //   内容指纹对 checkpoint 免疫,这个对照不会像字节版那样偶发红。
    const grown = await fetch(`${base}/api/console/events`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-app-token': 't' },
      body: JSON.stringify({ kind: 'note', title: '阳性对照', body: '这条就该改变指纹' }),
    });
    assert.equal(grown.status, 201);
    await new Promise((r) => setTimeout(r, 400));
    assert.notEqual(storeFingerprint(dir), before, '★ 落库通道写了一条,指纹却没变 —— 尺子没牙');
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

test('★ 8/14:尾巴落独立小文件 —— 重启回来还在,主库照样一个字节不长', async () => {
  // 起因:8/14 凌晨部署重启,内存环清空,她昨天那 44 行终端记录没了(「为什么今天又什么都没了」)。
  // 尾巴现在落 DATA_DIR/console-tail.json:重启后 GET tail 必须还给得出来。
  // ★ 「零落库」红线不因此松动 —— 这里连主库一起量:两种后端的文件都不许长。
  // ★ STORE_BACKEND 显式清空:本机 .env 带着它,漏清的话这条测的就是另一台机器。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cstream-restart-'));
  const env = { ...process.env, DATA_DIR: dir, APP_AUTH_TOKEN: 't', EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0', STORE_BACKEND: '' };
  const boot = async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PORT: String(port) } });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) {
      try { const r = await fetch(base + '/', { headers: { 'x-app-token': 't' } }); if (r.ok) break; } catch { /* 等 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { child, base };
  };
  const kill = (child) => new Promise((r) => { child.on('exit', r); child.kill('SIGKILL'); setTimeout(r, 3000); });
  const sizeOf = (name) => { try { return fs.statSync(path.join(dir, name)).size; } catch { return 0; } };

  const a = await boot();
  try {
    assert.equal((await push(a.base, ['第一轮的尾巴', '第二行'])).status, 204);
    // 写盘是 500ms 合并 —— 等它落地。900ms 不是拍的:500 合并 + 400 余量。
    await new Promise((r) => setTimeout(r, 900));
    assert.ok(fs.existsSync(path.join(dir, 'console-tail.json')), '★ 独立尾巴文件没落盘');
  } finally { await kill(a.child); }

  const b = await boot();
  try {
    const tail = await (await fetch(`${b.base}/api/console/stream/tail`, { headers: { 'x-app-token': 't' } })).json();
    assert.deepEqual(tail.lines.slice(-2), ['第一轮的尾巴', '第二行'], '★ 重启回来尾巴丢了 —— 落盘/回读有一头没生效');
    // 红线在持久化世界里的对应形状:**同一进程内**再灌一把,主库一个字节不长。
    // ★ 不拿「重启前后库同大小」当判据 —— 第二次开机本来就会写点正常的开机账
    //   (会话号之类),那不是这条通道的字节。第一版就这么断言的,红的是开机不是尾巴。
    const before = sizeOf('app-data.json') + sizeOf('app.db');
    assert.equal((await push(b.base, ['重启后的新行'])).status, 204);
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(sizeOf('app-data.json') + sizeOf('app.db'), before, '★ 尾巴落盘不许连带主库长大');
  } finally {
    await kill(b.child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
