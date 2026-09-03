// service worker 缓存版本号自动化。
//
// 手改版本号这件事咬过两次:①忘了改 → stale-while-revalidate 让用户永远慢一个刷新,
// 把已经修好的东西当成"你忘记做了" ②用 sed 改,日期写错 → **静默不匹配、退出码还是 0**,
// 差点当它改成功了。所以改成服务端按内容算哈希注入,人这一环彻底拿掉。
//
// 这份测试的重点不是"有没有版本号",是**内容变了版本号必须跟着变** —— 那才是它存在的理由。
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

async function withServer(fn) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swver-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, APP_AUTH_TOKEN: 't', EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0' } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch(base + '/', { headers: { 'x-app-token': 't' } }); if (r.ok) break; } catch { /* 等启动 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return await fn(base);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const swVersion = async (base) => {
  const body = await (await fetch(base + '/sw.js')).text();
  const m = body.match(/self\.__CC_CACHE_VERSION__=("[^"]+")/);
  return m ? JSON.parse(m[1]) : null;
};

test('sw.js 发出去时带着自动算出的版本号', async () => {
  const v = await withServer(swVersion);
  assert.ok(v, '必须注入 __CC_CACHE_VERSION__');
  assert.match(v, /^cc-companion-[0-9a-f]{12}$/, '格式是内容哈希,不是人写的日期');
});

test('★ 改了被缓存的文件,版本号必须跟着变(这才是它存在的理由)', async () => {
  const before = await withServer(swVersion);
  const target = path.join(REPO, 'public', 'styles.css');
  const original = fs.readFileSync(target, 'utf8');
  try {
    fs.writeFileSync(target, original + '\n/* 版本号联动测试 */\n');
    const after = await withServer(swVersion);
    assert.notEqual(after, before, '改了 styles.css 版本号却没变 = 用户拿不到新样式');
  } finally {
    fs.writeFileSync(target, original);
  }
  const restored = await withServer(swVersion);
  assert.equal(restored, before, '内容还原后版本号也要还原(说明它只跟内容走,不掺时间戳)');
});

test('★ 服务不重启，编辑 public/ 后版本号也必须当场变', async () => {
  const target = path.join(REPO, 'public', 'styles.css');
  const original = fs.readFileSync(target, 'utf8');
  await withServer(async (base) => {
    const before = await swVersion(base);
    try {
      fs.writeFileSync(target, `${original}\n/* same-process sw version test */\n`);
      const after = await swVersion(base);
      assert.notEqual(after, before, '同一进程里改了样式，SW 版本仍被旧内存缓存锁死');
    } finally {
      fs.writeFileSync(target, original);
    }
  });
});

test('没改东西时版本号稳定(不能每次请求都变,否则缓存永远失效)', async () => {
  const [a, b] = await withServer(async (base) => [await swVersion(base), await swVersion(base)]);
  assert.equal(a, b);
});

test('sw.js 源文件自己带回落值(不经本项目服务端直接静态托管时也能跑)', () => {
  const src = fs.readFileSync(path.join(REPO, 'public', 'sw.js'), 'utf8');
  assert.match(src, /self\.__CC_CACHE_VERSION__\s*\|\|/, '要读注入值');
  assert.match(src, /'cc-companion-[a-z-]+'/, '读不到时要有回落常量');
});
