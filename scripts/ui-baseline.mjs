#!/usr/bin/env node
// 前端结构基线 —— 改 public/ 之前截一份,改完再截一份,逐项比对。
//
// 为什么需要它:后端有 75 条测试,前端一条都没有。app.js 拆模块、换主题这类改动,
// 漏掉一个事件绑定或一个分支渲染,肉眼扫几个页面是看不出来的。
// 它抓的不是像素,是"可见结构":页面上有哪些能点的动作、渲染出了哪些组件类、
// 表单有哪些字段、顶栏写什么、各类元素各几个。结构变了就一定是代码变了。
//
// ★ 一律在**干净的临时 DATA_DIR + 固定种子数据**上跑:
//   ① 你的真实聊天内容一个字节都不会进快照
//   ② 前后两次跑的数据完全一样,差异只可能来自代码
//   (第一版我图省事直接连了正在用的实例,结果两次之间聊了几句,49→57 条消息
//    全成了"不一致",白查一轮。)
//
// 用法:
//   node scripts/ui-baseline.mjs before.json     # 改之前
//   ...改代码...
//   node scripts/ui-baseline.mjs after.json      # 改之后
//   node scripts/ui-baseline.mjs --diff before.json after.json
//
// 需要 puppeteer-core + 一个本地 Chrome(CHROME_PATH 可指定)。没有就跳过,不挡 CI。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

// 固定种子:每次跑都一样。内容全是假的,只为把各种 UI 分支撑出来。
const SEED = {
  settings: { appName: 'CC Companion', userName: '我', assistantName: '助手', groupName: '小群',
    agentMention: 'assistant', autoReplyGroup: false, theme: 'light' },
  chat_messages: [
    { id: 1, scope: 'chat', sender: '我', role: 'user', content: '在吗', created_at: '2026-01-01T10:00:00.000Z' },
    { id: 2, scope: 'chat', sender: '助手', role: 'assistant', content: '在的。**粗体**和 `代码`', created_at: '2026-01-01T10:00:05.000Z' },
  ],
  group_messages: [
    { id: 1, scope: 'group', sender: '我', role: 'user', content: '@assistant 你好', created_at: '2026-01-01T10:01:00.000Z' },
  ],
  console_events: [
    { id: 1, kind: 'memory', title: '记忆已创建', body: '种子', created_at: '2026-01-01T10:02:00.000Z' },
    { id: 2, kind: 'error', title: '出错了', body: '种子错误,用来撑错误卡片分支', created_at: '2026-01-01T10:02:01.000Z' },
  ],
  // 一条在效、一条被顶替 —— 撑出「已被顶替」那个分支
  memories: [
    { id: 1, title: '旧事实', content: '住在甲地', mood: '平静', author: '我', tags: ['fact'], pinned: false,
      fact_key: '住处', superseded_by: 2, superseded_at: '2026-01-02T00:00:00.000Z', strength: 50,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 2, title: '新事实', content: '搬到乙地', mood: '雀跃', author: '我', tags: ['fact'], pinned: true,
      fact_key: '住处', superseded_by: null, superseded_at: '', strength: 50,
      created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
  ],
  documents: [
    { id: 1, name: '种子资料.txt', source: 'typed', content: '一段用来撑资料库卡片的文字。', size: 14, chunks: ['一段用来撑资料库卡片的文字。'],
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
  ],
  stickers: [], counters: { memory: 2, document: 1 },
};

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

// 一页的指纹。只看结构,不看内容 —— 内容是种子造的,没有意义也不该入库。
const FINGERPRINT = () => {
  const tally = {};
  for (const e of document.querySelectorAll('[data-action]')) {
    const a = e.dataset.action; tally[a] = (tally[a] || 0) + 1;
  }
  const classes = new Set();
  for (const e of document.querySelectorAll('*')) for (const c of e.classList) classes.add(c);
  return {
    actions: tally,
    classes: [...classes].sort(),
    fields: [...document.querySelectorAll('input[name],textarea[name],select[name]')].map((e) => `${e.tagName.toLowerCase()}:${e.name}`).sort(),
    topbarTitle: document.querySelector('.topbar h1')?.textContent.trim() || null,
    navCount: document.querySelectorAll('.nav button, .nav a').length,
    counts: { buttons: document.querySelectorAll('button').length, forms: document.querySelectorAll('form').length, articles: document.querySelectorAll('article').length },
    viewport: {
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    },
  };
};

async function capture(out) {
  let puppeteer;
  try { puppeteer = (await import('puppeteer-core')).default; }
  catch { console.error('跳过:没装 puppeteer-core(它不是本项目依赖,按需 npm i -D puppeteer-core)'); process.exit(0); }
  if (!fs.existsSync(CHROME)) { console.error(`跳过:找不到 Chrome(${CHROME}),用 CHROME_PATH 指定`); process.exit(0); }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-baseline-'));
  fs.writeFileSync(path.join(dataDir, 'app-data.json'), JSON.stringify(SEED, null, 2));
  const port = await freePort();
  const server = spawn(process.execPath, ['server.js'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CC_SKIP_DOTENV: '1', PORT: String(port), DATA_DIR: dataDir, APP_AUTH_TOKEN: 'baseline',
      OPENAI_BASE_URL: '', FORGE_ADAPTER_URL: '', DSH_ENABLED: '', TUNNEL: '', EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0' } });
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(base, { headers: { 'x-app-token': 'baseline' } }); if (r.ok) break; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 375, height: 760, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  await page.evaluateOnNewDocument((token) => localStorage.setItem('cc_companion_token', token), 'baseline');
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push('console: ' + m.text().slice(0, 200));
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`.slice(0, 240));
  });
  await page.goto(base, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 2000));

  const wait = () => new Promise((r) => setTimeout(r, 700));
  const nav = async (i) => { await page.evaluate((k) => { const n = document.querySelectorAll('.nav button, .nav a'); n[k]?.click(); }, i); await wait(); };
  const click = async (sel, k = 0) => { await page.evaluate((s, i) => { document.querySelectorAll(s)[i]?.click(); }, sel, k); await wait(); };

  const snap = {};
  for (const [i, name] of [[0, 'chat'], [1, 'group'], [2, 'console'], [3, 'memory-home'], [4, 'settings']]) {
    await nav(i); snap[name] = await page.evaluate(FINGERPRINT);
  }
  await nav(3);
  await click('.mem-note', 0);        snap['memory-diary'] = await page.evaluate(FINGERPRINT);
  await click('.diary-write');        snap['memory-writer'] = await page.evaluate(FINGERPRINT);
  await click('.diary-write');
  await click('.diary-tool');         snap['memory-tools'] = await page.evaluate(FINGERPRINT);
  await click('.diary-tool');
  await click('.memory-card-top', 0); snap['memory-reader'] = await page.evaluate(FINGERPRINT);
  await click('.memory-back');
  await page.evaluate(() => document.querySelector('.topbar-back')?.click()); await wait();
  await click('.mem-note', 1);        snap['memory-docs'] = await page.evaluate(FINGERPRINT);
  snap.__errors = errors;

  fs.writeFileSync(out, JSON.stringify(snap, null, 1));
  console.log(`抓了 ${Object.keys(snap).length - 1} 个页面/状态 → ${out}`);
  console.log('页面报错:', errors.length ? errors : '无');
  await browser.close();
  server.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
}

function diff(aPath, bPath) {
  const a = JSON.parse(fs.readFileSync(aPath, 'utf8'));
  const b = JSON.parse(fs.readFileSync(bPath, 'utf8'));
  const bad = [];
  for (const page of Object.keys(a).filter((k) => k !== '__errors')) {
    for (const f of ['actions', 'classes', 'fields', 'topbarTitle', 'navCount', 'counts', 'viewport']) {
      if (JSON.stringify(a[page]?.[f]) !== JSON.stringify(b[page]?.[f])) bad.push({ page, field: f, before: a[page]?.[f], after: b[page]?.[f] });
    }
  }
  const newErrors = (b.__errors || []).filter((e) => !(a.__errors || []).includes(e));
  for (const d of bad) {
    console.log(`❌ ${d.page} · ${d.field}`);
    if (d.field === 'classes') {
      const A = new Set(d.before || []); const B = new Set(d.after || []);
      console.log('   少了:', [...A].filter((x) => !B.has(x)).slice(0, 10));
      console.log('   多了:', [...B].filter((x) => !A.has(x)).slice(0, 10));
    } else {
      console.log('   前:', JSON.stringify(d.before)?.slice(0, 160));
      console.log('   后:', JSON.stringify(d.after)?.slice(0, 160));
    }
  }
  if (newErrors.length) console.log('❌ 新增页面报错:', newErrors);
  if (!bad.length && !newErrors.length) console.log('✅ 结构指纹逐项一致,零新增页面报错');
  process.exit(bad.length || newErrors.length ? 1 : 0);
}

const args = process.argv.slice(2);
if (args[0] === '--diff') diff(args[1], args[2]);
else await capture(args[0] || 'ui-baseline.json');
