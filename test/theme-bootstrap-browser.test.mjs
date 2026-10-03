import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

test('浏览器启动后应用 bootstrap 中保存的 light 主题', {
  skip: (!BROWSER || !puppeteer) && '需要 CHROME_PATH 和 PUPPETEER_ENTRY',
}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-bootstrap-data-'));
  fs.writeFileSync(path.join(dataDir, 'app-data.json'), JSON.stringify({
    settings: { theme: 'light' },
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
    await page.setBypassServiceWorker(true);
    await page.goto(`${base}/?theme-bootstrap-test=1`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(
      () => document.body.dataset.theme === 'light' && Boolean(document.querySelector('.home-view')),
      { timeout: 5000 },
    );
    assert.deepEqual(await page.evaluate(() => ({
      theme: document.body.dataset.theme,
      rendered: Boolean(document.querySelector('.home-view')),
    })), { theme: 'light', rendered: true });
  } finally {
    if (browser) await browser.close();
    if (server.exitCode == null && server.signalCode == null) {
      await new Promise((resolve) => { server.once('close', resolve); server.kill('SIGTERM'); });
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
