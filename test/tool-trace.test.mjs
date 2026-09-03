// 「agent 用了什么工具、动了哪儿」要一路活到私聊界面。
//
// ★ 这条链上有一个**会静默吞字段**的关口:`addMessage` 里的 message 是个
//   **显式字面量** —— 没列进去的字段直接消失,调用方传了、接口返回 200、值却从来没落地,
//   两边都不报错。同一个坑本仓库栽过一次(normalizeSettings 的 skyIcons)。
//   所以这份测试**打在 API 真实输出上**,不看中间函数的返回值:
//   把 `tools:` 从字面量里删掉,下面第一条必须红。
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

// 假上游演 bridge:回复里带 cc_tools(自带桥才有的自定义字段)
async function startUpstream(ccTools) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    await new Promise((r) => req.on('end', r));
    if (req.url.includes('/chat/completions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '看过了', cc_tools: ccTools } }],
      }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

async function startApp(env) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccapp-tool-'));
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
    const t = setTimeout(() => r(false), 60000);
    const iv = setInterval(() => { if (/listening on/i.test(out)) { clearTimeout(t); clearInterval(iv); r(true); } }, 40);
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    up, out, base,
    api: (p, init) => fetch(base + p, init),
    close: async () => {
      if (srv.exitCode == null && srv.signalCode == null) {
        await new Promise((r) => { srv.once('close', r); srv.kill('SIGTERM'); });
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function sendAndFetch(app) {
  await app.api('/api/chat/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '你用个工具看看' }),
  });
  // 回复是后台异步落的,轮一会儿。
  // ★ 必须按**内容**认这条回复,不能只按 `role === 'assistant'` ——
  //   新库会播种示例消息(lib/state.js),里面就有一条 assistant。
  //   按 role 找会拿到那条种子:它当然没有 thinking/tools,于是测试报"字段被吞了",
  //   而代码其实是好的。**筛选条件比我要找的东西宽,量到的就不是那个东西。**
  for (let i = 0; i < 80; i++) {
    const rows = await (await app.api('/api/chat/messages?limit=20')).json();
    const reply = (Array.isArray(rows) ? rows : [])
      .filter((m) => m && m.role === 'assistant' && String(m.content || '').includes('看过了'))
      .pop();
    if (reply) return reply;
    await new Promise((r) => setTimeout(r, 120));
  }
  return null;
}

test('工具记录一路活到 API 输出(白名单漏了它就红)', async () => {
  const upstream = await startUpstream([
    { name: 'Read', arg: '/hello.txt' },
    { name: 'Bash', arg: 'echo hi' },
  ]);
  const app = await startApp({ OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1` });
  try {
    assert.ok(app.up, `server 没起来:\n${app.out.slice(0, 800)}`);
    const reply = await sendAndFetch(app);
    assert.ok(reply, '没等到 assistant 回复');
    // ★ 判据打在**接口真的吐出来的那份数据**上
    assert.ok(Array.isArray(reply.tools), `回复里没有 tools 字段(多半是被 addMessage 的字面量吞了)。实际字段:${Object.keys(reply).join(',')}`);
    assert.equal(reply.tools.length, 2);
    assert.deepEqual(reply.tools[0], { name: 'Read', arg: '/hello.txt' });
    assert.deepEqual(reply.tools[1], { name: 'Bash', arg: 'echo hi' });
  } finally {
    await app.close(); await upstream.close();
  }
});

test('上游给脏数据也不炸:超长截断 / 没名字的丢掉 / 不是数组当空', async () => {
  const upstream = await startUpstream([
    { name: 'x'.repeat(200), arg: 'y'.repeat(500) },
    { arg: '没有名字,应该被丢掉' },
    { name: 'Grep', arg: 'TODO' },
  ]);
  const app = await startApp({ OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1` });
  try {
    assert.ok(app.up, app.out.slice(0, 800));
    const reply = await sendAndFetch(app);
    assert.ok(reply && Array.isArray(reply.tools));
    // 没名字那条被丢掉 ⇒ 只剩 2 条
    assert.equal(reply.tools.length, 2, `实际:${JSON.stringify(reply.tools)}`);
    assert.equal(reply.tools[0].name.length, 60, '工具名截到 60');
    assert.equal(reply.tools[0].arg.length, 160, '参数截到 160');
    assert.equal(reply.tools[1].name, 'Grep');
  } finally {
    await app.close(); await upstream.close();
  }
});

test('普通 OpenAI 兼容口(没有 cc_tools)= 空数组,不是 undefined 也不报错', async () => {
  const upstream = await startUpstream(undefined);
  const app = await startApp({ OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}/v1` });
  try {
    assert.ok(app.up, app.out.slice(0, 800));
    const reply = await sendAndFetch(app);
    assert.ok(reply, '没等到回复');
    assert.deepEqual(reply.tools, [], '没有工具时应当是空数组 —— 前端据此不渲染,不需要额外开关');
  } finally {
    await app.close(); await upstream.close();
  }
});
