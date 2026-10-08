import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderOrreryHome } from '../public/js/orrery-home.js';
import { ORRERY_DUST_LIMIT, ORRERY_MOON_DOT_LIMIT } from '../public/js/orrery.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserCandidates = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const BROWSER = browserCandidates.find((candidate) => fs.existsSync(candidate));
const puppeteerEntry = String(process.env.PUPPETEER_ENTRY || '').trim();
let puppeteer = null;
if (puppeteerEntry && fs.existsSync(puppeteerEntry)) {
  ({ default: puppeteer } = await import(pathToFileURL(puppeteerEntry)));
}

test('星盘结构不写死私人信息，六个入口使用现有 tab 路由', () => {
  const html = renderOrreryHome();
  assert.doesNotMatch(html, /益阳|TA 在书桌前|沈屿|宝宝/);
  assert.doesNotMatch(html, /preserveAspectRatio="xMidYMid slice"/);
  assert.match(html, /class="orrery-head"/);
  assert.match(html, /class="orrery-footer"/);
  assert.match(html, /preserveAspectRatio="xMidYMid meet"/);
  assert.match(html, /data-tab="chat"/);
  assert.equal(ORRERY_DUST_LIMIT, 90);
  assert.equal(ORRERY_MOON_DOT_LIMIT, 1500);
  const source = fs.readFileSync(path.join(REPO, 'public', 'js', 'orrery.js'), 'utf8');
  const orbitSource = fs.readFileSync(path.join(REPO, 'public', 'js', 'orbit-controller.js'), 'utf8');
  for (const [label, tab] of [['群聊', 'group'], ['记忆库', 'memory'], ['控制台', 'console'], ['设置', 'settings'], ['北斗', 'more']]) {
    assert.match(source, new RegExp(`'${label}': '${tab}'`));
  }
  assert.match(source, /createOrbitController/);
  assert.match(orbitSource, /visibilitychange/);
  assert.match(orbitSource, /IntersectionObserver/);
  assert.match(orbitSource, /dragThresholdPx/);
  assert.match(source, /prefers-reduced-motion/);
});

const freePort = () => new Promise((resolve) => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1', () => {
    const { port } = socket.address();
    socket.close(() => resolve(port));
  });
});

const waitForServer = async (base) => {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('test server did not start');
};

test('真浏览器：星盘路由、拖动防误触、缺数据隐藏与 reduced-motion', {
  skip: (!BROWSER || !puppeteer) && '需要 CHROME_PATH 和 PUPPETEER_ENTRY',
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orrery-home-data-'));
  fs.writeFileSync(path.join(dataDir, 'app-data.json'), JSON.stringify({
    settings: { theme: 'starry', assistantName: '测试助手', userName: '', companion_since: '' },
    chat_messages: [], group_messages: [], console_events: [], memories: [], documents: [], stickers: [],
  }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CC_SKIP_DOTENV: '1', PORT: String(port), DATA_DIR: dataDir, STORE_BACKEND: 'json',
      APP_AUTH_TOKEN: '', OPENAI_BASE_URL: '', FORGE_ADAPTER_URL: '', DSH_ENABLED: '',
      TUNNEL: '', EMBEDDING_MODEL: '', MEMORY_EXTRACT_EVERY: '0',
    },
  });
  let browser;
  try {
    await waitForServer(base);
    browser = await puppeteer.launch({ executablePath: BROWSER, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.setBypassServiceWorker(true);
    await page.goto(`${base}/?orrery-test=1`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.orrery-room[data-tab="memory"]');
    const initial = await page.evaluate(() => ({
      tab: document.body.dataset.tab,
      rooms: Array.from(document.querySelectorAll('.orrery-room')).map((node) => node.dataset.tab).sort(),
      nowHidden: getComputedStyle(document.querySelector('#orreryInfoNow')).display,
      weatherHidden: getComputedStyle(document.querySelector('#orreryInfoWeather')).display,
      width: document.documentElement.scrollWidth,
    }));
    assert.deepEqual(initial.rooms, ['console', 'group', 'memory', 'more', 'settings']);
    assert.equal(initial.tab, 'home');
    assert.equal(initial.nowHidden, 'none');
    assert.equal(initial.weatherHidden, 'none');
    assert.equal(initial.width, 390);

    const centerPoint = await page.$eval('.orrery-center', (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.touchscreen.tap(centerPoint.x, centerPoint.y);
    await page.waitForFunction(() => document.body.dataset.tab === 'chat');
    await page.click('button.topbar-home-btn[data-tab="home"]');
    await page.waitForSelector('.orrery-room[data-tab="memory"]');
    const memoryPoint = await page.$eval('.orrery-room[data-tab="memory"]', (node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.touchscreen.tap(memoryPoint.x, memoryPoint.y);
    await page.waitForFunction(() => document.body.dataset.tab === 'memory');
    const memoryLayout = await page.evaluate(() => {
      const content = document.querySelector('.content');
      return { clientHeight: content.clientHeight, scrollHeight: content.scrollHeight };
    });
    assert.equal(memoryLayout.scrollHeight, memoryLayout.clientHeight, '390×844 记忆首屏不能留下 2px 假滚动');
    await page.click('button.topbar-home-btn[data-tab="home"]');
    await page.waitForSelector('.orrery-svg');

    const box = await page.$eval('.orrery-svg', (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .52);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .72, box.y + box.height * .48, { steps: 8 });
    await page.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(await page.evaluate(() => document.body.dataset.tab), 'home', '拖动星盘不能误进房间');

    await page.evaluate(() => document.querySelector('.orrery-room[data-tab="console"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForFunction(() => document.body.dataset.tab === 'console');
    const consoleLayout = await page.evaluate(() => {
      const content = document.querySelector('.content');
      const strip = document.querySelector('.cv-strip');
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        contentWidth: content.scrollWidth,
        contentClientWidth: content.clientWidth,
        stripWidth: strip.scrollWidth,
        stripClientWidth: strip.clientWidth,
      };
    });
    assert.equal(consoleLayout.documentWidth, consoleLayout.viewportWidth);
    assert.equal(consoleLayout.contentWidth, consoleLayout.contentClientWidth);
    assert.ok(consoleLayout.stripWidth > consoleLayout.stripClientWidth, '胶囊应在工具条内部横滑');

    const reduced = await browser.newPage();
    await reduced.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await reduced.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await reduced.setBypassServiceWorker(true);
    await reduced.goto(`${base}/?orrery-reduced=1`, { waitUntil: 'networkidle2' });
    await reduced.waitForSelector('.orrery-room');
    const before = await reduced.$eval('.orrery-room[data-tab="group"]', (node) => getComputedStyle(node).transform);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const after = await reduced.$eval('.orrery-room[data-tab="group"]', (node) => getComputedStyle(node).transform);
    assert.equal(after, before, 'reduced-motion 下星盘必须静止');
    await reduced.close();

    for (const height of [844, 740, 640]) {
      const compact = await browser.newPage();
      await compact.setViewport({ width: 390, height, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      await compact.setBypassServiceWorker(true);
      await compact.goto(`${base}/?orrery-height=${height}`, { waitUntil: 'networkidle2' });
      await compact.waitForSelector('.orrery-room');
      const layout = await compact.evaluate(() => {
        const bounds = (selector) => {
          const rect = document.querySelector(selector).getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        return {
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          viewportHeight: innerHeight,
          phases: bounds('.orrery-phases'),
          dial: bounds('#dial'),
          footer: bounds('.orrery-footer'),
          moonTextureImages: document.querySelectorAll('#moonTex image').length,
          moonTextureCircles: document.querySelectorAll('#moonTex circle').length,
        };
      });
      assert.equal(layout.documentWidth, 390, `${height}px 高度不能产生横向溢出`);
      assert.equal(layout.documentHeight, height, `${height}px 高度不能产生纵向溢出`);
      assert.ok(layout.phases.top >= 0 && layout.phases.bottom <= height, `${height}px 月相必须完整可见`);
      assert.ok(layout.dial.top >= 0 && layout.dial.bottom <= height, `${height}px 星盘必须完整可见`);
      assert.ok(layout.footer.top >= 0 && layout.footer.bottom <= height, `${height}px 底栏必须完整可见`);
      assert.equal(layout.moonTextureImages, 1, '月面点刻应烘到单张静态纹理');
      assert.ok(layout.moonTextureCircles < 20, '月面不能保留上千个 SVG circle');
      await compact.close();
    }
  } finally {
    if (browser) await browser.close();
    if (server.exitCode == null && server.signalCode == null) {
      await new Promise((resolve) => { server.once('close', resolve); server.kill('SIGTERM'); });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

