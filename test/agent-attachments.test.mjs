// 附件要真的到模型手里。
//
// 起因是用户报「agent 收不到我发的图」。查下来不是丢包,是**从来就没给过它**:
// 拼给模型的那条 user 消息只取 `.content`,没有正文时更是直接送一个字符串 `[attachment]`。
// 图存下来了、界面也画出来了,模型那边**连"有个附件"都不知道**。
//
// ★ 这份测试**抓真实请求体**来验,不看中间函数的返回值 ——
//   「我们以为发出去的」和「真的发出去的」是两件事,这一晚已经吃过亏了。
//   mock 上游把收到的 body 原样录下来,断言直接打在那份 body 上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});

// ★ 绑 0.0.0.0 而不是 127.0.0.1:这样测试能用 **127.0.0.2** 连上来。
//   为什么需要:代码判断「模型是不是跑在本机」用的是字面量 127.0.0.1/localhost,
//   127.0.0.2 同样是环回、连得通,却**不匹配那个判断** ——
//   于是同一个 mock 上游能同时演「本机桥」和「云端厂商」两种部署,不用真去连外网。
async function startUpstream() {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    await new Promise((r) => req.on('end', r));
    if (req.url.includes('/chat/completions')) {
      try { seen.push(JSON.parse(body)); } catch { seen.push({ unparsed: body }); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  return { seen, port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

async function startApp(env = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapp-att-'));
  const srv = spawn('node', ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, APP_AUTH_TOKEN: '',
      OPENAI_API_KEY: 'k', EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0',
      HEARTBEAT_ENABLED: 'false', TUNNEL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  const up = await new Promise((r) => {
    // ★ 上限放宽到 60s。这类测试要 spawn 真 server + 起假上游 + 轮询端口,
    //   是典型的**负载敏感型**:机器一忙就可能超时,在 CI 上表现为随机红 ——
    //   而随机红最坏的地方是**没人分得清是真坏了还是机器忙**。
    //   放宽没有代价:真挂住的话测试框架自己的超时会兜住;
    //   正常情况下它 1 秒内就绪,根本走不到这个上限。
    const t = setTimeout(() => r(false), 60000);
    const iv = setInterval(() => { if (/listening on/i.test(out)) { clearTimeout(t); clearInterval(iv); r(true); } }, 40);
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    up, out, dataDir, base,
    api: (p, init) => fetch(base + p, init),
    close: async () => {
      if (srv.exitCode == null && srv.signalCode == null) {
        await new Promise((r) => { srv.once('close', r); srv.kill('SIGTERM'); });
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// 1×1 PNG,够真实(有 image/png 头),又小到不会撑爆请求体
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function upload(app) {
  const r = await app.api('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'photo.png', data: `data:image/png;base64,${PNG_B64}` }),
  });
  assert.ok(r.status === 200 || r.status === 201, `上传失败 ${r.status}`);
  return r.json();
}

async function sendWith(app, attachments, content = '') {
  const r = await app.api('/api/chat/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, attachments }),
  });
  assert.ok(r.status < 300, `发送失败 ${r.status}`);
  return r;
}

const lastUser = (req) => req.messages[req.messages.length - 1];

async function waitFor(fn, ms = 30000) {   // 同上:等的是真 HTTP 往返,负载高时会慢很多
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
}

test('模型跑在本机时:给绝对路径(那种 agent 能自己打开文件看)', async () => {
  const upstream = await startUpstream();
  const app = await startApp({ OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1` });
  try {
    assert.ok(app.up, app.out);
    const file = await upload(app);
    await sendWith(app, [file], '这是什么');
    const req = await waitFor(() => upstream.seen[0]);
    assert.ok(req, '上游没收到请求');
    const c = lastUser(req).content;
    assert.equal(typeof c, 'string', '本机路径这条走纯文本,不该拼成数组');
    assert.match(c, /这是什么/, '正文还在');
    assert.match(c, /photo\.png/, '附件名要报给模型');
    assert.ok(c.includes(path.join(app.dataDir, 'uploads')), `要给出可读取的绝对路径,实际:\n${c}`);
    // ★ 反面:旧行为是送一个什么都没说的 '[attachment]'
    assert.ok(!/^\[attachment\]$/m.test(c), '不该再出现那个空洞的 [attachment]');
  } finally { await app.close(); await upstream.close(); }
});

test('模型在云端时:图片作为标准 image_url(data URL)随消息附上,且不泄漏本机路径', async () => {
  const upstream = await startUpstream();
  // 127.0.0.2 —— 连得通,但不匹配「本机」判断,所以走云端分支
  const app = await startApp({ OPENAI_BASE_URL: `http://127.0.0.2:${upstream.port}/v1` });
  try {
    assert.ok(app.up, app.out);
    const file = await upload(app);
    await sendWith(app, [file], '看看这个');
    const req = await waitFor(() => upstream.seen[0]);
    assert.ok(req, '上游没收到请求');
    const c = lastUser(req).content;
    assert.ok(Array.isArray(c), `云端分支应该拼成多模态数组,实际是 ${typeof c}`);
    const img = c.find((p) => p.type === 'image_url');
    assert.ok(img, '缺 image_url 部件');
    assert.match(img.image_url.url, /^data:image\/png;base64,/, ' 应该是 data URL');
    assert.ok(img.image_url.url.includes(PNG_B64.slice(0, 24)), '图片内容要真的带上,不是空壳');
    const text = c.find((p) => p.type === 'text').text;
    assert.match(text, /看看这个/);
    // ★ 安全:服务器目录结构不能发给外部厂商
    assert.ok(!text.includes(app.dataDir), `本机路径泄漏到云端请求里了:\n${text}`);
    assert.ok(!JSON.stringify(c).includes(app.dataDir), '整个 payload 里都不许有本机路径');
  } finally { await app.close(); await upstream.close(); }
});

test('没有附件时一切照旧(别把普通消息也改造了)', async () => {
  const upstream = await startUpstream();
  const app = await startApp({ OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1` });
  try {
    await sendWith(app, [], '就是一句普通的话');
    const req = await waitFor(() => upstream.seen[0]);
    const c = lastUser(req).content;
    assert.equal(typeof c, 'string');
    assert.equal(c.trim(), '就是一句普通的话');
    assert.ok(!/附件/.test(c), '没附件就不该冒出附件清单');
  } finally { await app.close(); await upstream.close(); }
});

test('伪造的附件 url 不能把任意路径读出来', async () => {
  const upstream = await startUpstream();
  const app = await startApp({ OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1` });
  try {
    // 三种试探:跳出 uploads / 绝对路径 / 外链
    await sendWith(app, [
      { url: '/uploads/..', name: 'a' },
      { url: '/uploads/../../etc/passwd', name: 'b' },
      { url: '/etc/passwd', name: 'c' },
      { url: 'https://evil.example/x.png', name: 'd' },
    ], '试试');
    const req = await waitFor(() => upstream.seen[0]);
    const c = JSON.stringify(lastUser(req).content);
    assert.ok(!c.includes('/etc/passwd'), `不许把 /etc/passwd 递给模型:\n${c}`);
    assert.ok(!c.includes('uploads/..'), '不许出现跳出 uploads 的路径');
    // 名字还是可以报的(它只是个标签),但不许附带任何可读取的路径
    assert.ok(!/可直接打开读取/.test(c) || !c.includes('passwd'), '越界文件不该被标成可读取');
  } finally { await app.close(); await upstream.close(); }
});
