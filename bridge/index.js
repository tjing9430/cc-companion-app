/**
 * cc-companion bridge
 * -------------------
 * Connects your locally-installed Claude Code CLI to the companion app — with no
 * API key. The app talks to this bridge as if it were an OpenAI-compatible
 * provider; the bridge runs `claude -p` (print mode, streaming JSON), so you keep
 * your Claude subscription, your MCP tools, and extended thinking.
 *
 *   app  --(POST /v1/chat/completions)-->  bridge  --(spawn)-->  claude CLI
 *        <-------- reply + thinking --------        <-- stream-json --
 *   bridge --(POST /api/console/events)--> app      (live thinking / tool feed)
 *
 * Zero npm dependencies: Node 18+ standard library only.
 *
 * SECURITY: this server is an unauthenticated proxy to your Claude subscription.
 * It binds to 127.0.0.1 by default. Do NOT bind it to a public interface without
 * putting real authentication + TLS in front of it (see docs/CC-CONNECT.md).
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInteractiveRunner } from './interactive.js';
import { buildPrompt } from './prompt.js';
import { syncLibrary } from './library.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

// Load the app's .env so `npm run bridge` shares the same config (same parser as server.js).
function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      // Strip an unquoted trailing comment: `KEY=value   # why`. Without this the comment
      // becomes part of the value and the setting silently misbehaves — which is worse than
      // failing, because the config *looks* right. Quote the value if you need a literal '#'.
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (key && !(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv(path.join(REPO_ROOT, '.env'));

// ---------------------------------------------------------------- config (env)
const HOST = process.env.BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 8788);
const APP_URL = String(process.env.APP_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const APP_AUTH_TOKEN = String(process.env.APP_AUTH_TOKEN || '').trim();
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_MODEL = String(process.env.CLAUDE_MODEL || '').trim();
// --effort:交互态想拿到 thinking 正文,这个是必需项之一(实测 2026-08-10,claude-opus-4-8)。
// 不设的话 transcript 里的 thinking 块只有 signature、正文是空字符串。
// 另一半在 <HOME>/.claude/settings.json 的 showThinkingSummaries:true —— 两个缺一个都拿不到明文,
// 单开任一个实测都是 0 字,是拆开验过的,不是推的。
const CLAUDE_EFFORT = String(process.env.CLAUDE_EFFORT || '').trim();

// ---- 运行时可调的档位(App 控制台上那两个钮打到这里)----
//
// 为什么要有这一层:CLAUDE_MODEL / CLAUDE_EFFORT 是启动时从 env 读一次的常量,
// 想在 App 里点一下就换,只有两条路 —— 重启桥,或者让它们变成可写的运行时状态。
// 重启桥会打断正在进行的会话,所以走后者。下一轮 turn 生效,不影响手上这轮。
//
// ★ 白名单是**必须**的,不是洁癖:这两个值会被 push 进 spawn 的 args 数组。
//   shell:false 挡住了 shell 注入,但挡不住**参数注入** —— 传一个以 `--` 开头的值
//   进去,CLI 的参数解析器会把它当成新开关。所以只认列表里的字面量,别的一律拒。
const EFFORT_CHOICES = ['low', 'medium', 'high', 'xhigh'];
// 模型列表不写死在代码里(图纸要求「按 bridge 实际支持列表读」)——
// 但也没法向 CLI 问出一份可靠清单,所以做成部署方声明:CLAUDE_MODELS=a,b,c。
// 没声明就退回「只有当前这一个」,宁可少给选项,也不谎报支持。
const MODEL_CHOICES = String(process.env.CLAUDE_MODELS || '')
  .split(',').map((x) => x.trim()).filter(Boolean);

let runtimeModel = CLAUDE_MODEL;
let runtimeEffort = CLAUDE_EFFORT;

// 本次进程存活期内的累计用量。桥重启就归零 —— 它衡量的是「这个会话烧了多少」,
// 不是账单,所以不落盘(落盘就得考虑并发写、轮转、清理,不值当)。
const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turns: 0 };
function addUsage(u) {
  if (!u || typeof u !== 'object') return;
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const v = Number(u[k]);
    if (Number.isFinite(v) && v > 0) usageTotals[k] += v;
  }
  usageTotals.turns += 1;
}
// 「这一轮往模型里塞了多少」= 新输入 + 缓存命中 + 建缓存。用来对着上下文窗口看。
let lastTurnPrompt = 0;
let lastTurnOutput = 0;
// 可选:凭证过期时从哪儿重新取一份。留空 = 不自愈(默认行为不变)。
// 用在「claude 的登录态放在另一个 HOME、桥用的是它的副本」这种部署里 ——
// 主 HOME 一刷新 token,副本就作废,症状是聊天框里冒出一句英文 401。
const CLAUDE_CREDENTIALS_SOURCE = String(process.env.CLAUDE_CREDENTIALS_SOURCE || '').trim();
const CLAUDE_MCP_CONFIG = String(process.env.CLAUDE_MCP_CONFIG || '').trim();
const ASSISTANT_NAME = String(process.env.ASSISTANT_NAME || 'Claude Code').trim() || 'Claude Code';
const DATA_DIR = path.resolve(REPO_ROOT, process.env.DATA_DIR || 'data');
// 'resume' keeps one long-lived Claude Code session (context persists across
// turns and restarts). 'fresh' starts a new session on every bridge restart.
const SESSION_MODE = (process.env.BRIDGE_SESSION_MODE || 'resume').toLowerCase();
const SESSION_FILE = path.join(DATA_DIR, 'bridge-session.json');
const RUN_TIMEOUT_MS = Math.max(10000, Number(process.env.BRIDGE_TIMEOUT_MS || 300000));
const THINKING_FLUSH_MS = 700; // batch thinking deltas before posting to the console
// v1.1: 'interactive' drives a real interactive CLI in a pty and reads the transcript
// jsonl (exposes extended thinking); 'print' is the v1 headless `claude -p` (no thinking).
const BRIDGE_MODE = (process.env.BRIDGE_MODE || 'interactive').toLowerCase();
const BRIDGE_PERMISSION_MODE = String(process.env.BRIDGE_PERMISSION_MODE || '').trim();
const INTERACTIVE_SESSION_FILE = path.join(DATA_DIR, 'bridge-session-interactive.json');

// ---------------------------------------------------- session state (--resume)
function loadSessionId() {
  if (SESSION_MODE === 'fresh') return '';
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return String((raw && raw.session_id) || '').trim();
  } catch {
    return '';
  }
}
function saveSessionId(id) {
  if (!id) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ session_id: id, updated_at: new Date().toISOString() }, null, 2));
  } catch (err) {
    log('warn', `could not persist session id: ${err.message}`);
  }
}
// The active Claude Code session id. To start a fresh conversation, stop the
// bridge and delete DATA_DIR/bridge-session.json (or set BRIDGE_SESSION_MODE=fresh).
let sessionId = loadSessionId();
let lastMcpAnnounced = ''; // -p re-inits each turn; only announce MCP list when it changes

// ----------------------------------------------------------------- tiny logger
function log(level, msg) {
  const line = `[bridge] ${level}: ${msg}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

// ------------------------------------ post a console event to the app (feed UI)
async function postConsole(kind, title, body) {
  try {
    await fetch(`${APP_URL}/api/console/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(APP_AUTH_TOKEN ? { 'x-app-token': APP_AUTH_TOKEN } : {}),
      },
      body: JSON.stringify({ kind, title, body: String(body || '').slice(0, 4000) }),
      signal: AbortSignal.timeout(5000), // don't hang if the app is unresponsive
    });
  } catch (err) {
    // Non-fatal: the reply itself still returns via the HTTP response.
    log('warn', `console post failed: ${err.message}`);
  }
}

// --------------------- run one Claude turn: `claude -p --output-format stream-json`
// Resolves { content, thinking, sessionId }. `resume` is the session id to continue
// (empty string = start a new session).
function runClaudeTurn(prompt, resume) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
    if (resume) args.push('--resume', resume);
    if (runtimeModel) args.push('--model', runtimeModel);
    if (runtimeEffort) args.push('--effort', runtimeEffort);
    if (CLAUDE_MCP_CONFIG) args.push('--mcp-config', CLAUDE_MCP_CONFIG);

    // shell:false + prompt via stdin — never interpolate user text into a shell.
    const child = spawn(CLAUDE_BIN, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let finalText = '';   // authoritative reply from the `result` event
    let streamedText = ''; // fallback: accumulated text_delta
    let thinking = '';    // accumulated thinking_delta
    let newSessionId = '';
    let resultError = '';  // claude-side error -> reject (502) rather than a fake reply
    let stderr = '';
    let buf = '';
    let settled = false;

    // batch thinking deltas so we don't hammer the console endpoint per token
    let pendingThinking = '';
    let flushTimer = null;
    function scheduleFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        const chunk = pendingThinking.trim();
        pendingThinking = '';
        if (chunk) postConsole('thinking', ASSISTANT_NAME, chunk);
      }, THINKING_FLUSH_MS);
    }
    function flushThinkingNow() {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const chunk = pendingThinking.trim();
      pendingThinking = '';
      if (chunk) postConsole('thinking', ASSISTANT_NAME, chunk);
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`claude timed out after ${RUN_TIMEOUT_MS} ms`));
    }, RUN_TIMEOUT_MS);

    function handleLine(line) {
      const s = line.trim();
      if (!s) return;
      let j;
      try { j = JSON.parse(s); } catch { return; } // ignore non-JSON noise
      if (j.type === 'system' && j.subtype === 'init') {
        if (j.session_id) newSessionId = j.session_id;
        const mcp = Array.isArray(j.mcp_servers) ? j.mcp_servers.map((m) => m.name).filter(Boolean).join(', ') : '';
        if (mcp && mcp !== lastMcpAnnounced) { lastMcpAnnounced = mcp; postConsole('info', ASSISTANT_NAME, `MCP servers: ${mcp}`); }
        return;
      }
      if (j.type === 'stream_event' && j.event) {
        const ev = j.event;
        if (ev.type === 'content_block_delta' && ev.delta) {
          const d = ev.delta;
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            streamedText += d.text;
          } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
            thinking += d.thinking;
            pendingThinking += d.thinking;
            scheduleFlush();
          }
        }
        return;
      }
      if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
        // surface tool calls (incl. MCP) to the live console feed
        for (const block of j.message.content) {
          if (block && block.type === 'tool_use') postConsole('tool', ASSISTANT_NAME, `→ ${block.name}`);
        }
        return;
      }
      if (j.type === 'result') {
        if (j.session_id) newSessionId = j.session_id;
        if (typeof j.result === 'string') finalText = j.result;
        // CLI 在 result 事件里给了真实用量,原来这里整段扔掉、对外报 0。
        // 字段名是从真实 transcript 里核出来的,不是照 OpenAI 的形状猜的。
        if (j.usage) {
          addUsage(j.usage);
          lastTurnPrompt = (Number(j.usage.input_tokens) || 0)
            + (Number(j.usage.cache_read_input_tokens) || 0)
            + (Number(j.usage.cache_creation_input_tokens) || 0);
          lastTurnOutput = Number(j.usage.output_tokens) || 0;
        }
        if (j.is_error || (j.subtype && j.subtype !== 'success')) {
          resultError = String(j.subtype || 'error');
        }
        return;
      }
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { stderr += c; });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`failed to spawn "${CLAUDE_BIN}": ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buf.trim()) handleLine(buf); // trailing partial line
      flushThinkingNow();
      const content = (finalText || streamedText || '').trim();
      if (resultError && !content) return reject(new Error(`claude: ${resultError}`)); // surface claude errors as 502, not a fake reply
      if (code !== 0 && !content) {
        return reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
      if (!content) return reject(new Error('claude returned an empty reply'));
      resolve({ content, thinking: thinking.trim(), sessionId: newSessionId });
    });

    child.stdin.on('error', () => { /* ignore EPIPE if the CLI exits before reading */ });
    child.stdin.end(prompt);
  });
}

// ------------------ serialize turns: one claude process at a time (guards --resume)
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

// v1.1 interactive runner (restores thinking) — a singleton long-lived session.
const interactiveRunner = BRIDGE_MODE === 'interactive' ? createInteractiveRunner({
  claudeBin: CLAUDE_BIN, cwd: process.cwd(), model: CLAUDE_MODEL, effort: CLAUDE_EFFORT, mcpConfig: CLAUDE_MCP_CONFIG,
  permissionMode: BRIDGE_PERMISSION_MODE, sessionFile: INTERACTIVE_SESSION_FILE,
  turnTimeoutMs: RUN_TIMEOUT_MS, log, postConsole, assistantName: ASSISTANT_NAME,
}) : null;

// ★ 认出"登录态失效"。这东西的阴险之处:claude 把它当成**正常回复文本**吐出来
//   (result 事件里就是一句 "Failed to authenticate. API Error: 401 ..."),
//   于是桥原样当回答塞给用户 —— 用户看到的不是"出错了",是 AI 突然说英文。
const AUTH_FAILURE_RE = /(OAuth (?:access )?token (?:has been revoked|has expired)|Failed to authenticate|API Error: 401|invalid[_ ]api[_ ]key)/i;

// 从配置的源头重新取一份凭证。成功返回 true —— 只有这时才值得重试。
function resyncCredentials() {
  if (!CLAUDE_CREDENTIALS_SOURCE) return false;
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) return false;
    const target = path.join(home, '.claude', '.credentials.json');
    if (path.resolve(target) === path.resolve(CLAUDE_CREDENTIALS_SOURCE)) return false;  // 同一个文件,重拷没意义
    const fresh = fs.readFileSync(CLAUDE_CREDENTIALS_SOURCE, 'utf8');
    if (!fresh.trim()) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fresh, { mode: 0o600 });
    log('info', 'credentials resynced from CLAUDE_CREDENTIALS_SOURCE');
    return true;
  } catch (err) {
    log('warn', `credentials resync failed: ${err.message}`);
    return false;
  }
}

// Dispatch a turn to the configured runner (interactive by default; print as fallback).
async function runTurn(prompt) {
  const once = () => (interactiveRunner ? enqueue(() => interactiveRunner.runTurn(prompt)) : runPrintTurn(prompt));
  const out = await once();
  // 登录态失效走的是"正常回复"这条路,不是异常路 —— 所以得看回复内容才认得出来。
  if (!AUTH_FAILURE_RE.test(String((out && out.content) || ''))) return out;
  if (resyncCredentials()) {
    log('warn', 'auth failed; credentials resynced, retrying this turn once');
    const retry = await once();
    if (!AUTH_FAILURE_RE.test(String((retry && retry.content) || ''))) return retry;
  }
  // 重同步没配、或者拿到的还是过期的 —— 别把英文 401 当回复递给用户。
  await postConsole('error', ASSISTANT_NAME,
    '登录态失效了:Claude Code 的凭证过期或被吊销。到跑 bridge 的机器上重新 `claude login`;'
    + '若凭证是从别处拷来的,设 CLAUDE_CREDENTIALS_SOURCE 指向源文件即可自动重取。');
  throw new Error('claude: authentication failed (token expired or revoked)');
}

// v1 print-mode runner (headless `claude -p`; thinking redacted) — kept as a fallback.
// Recovers transparently from a stale/expired resume session.
async function runPrintTurn(prompt) {
  try {
    // read sessionId inside the queued thunk (at queue-head time), not before
    // enqueue — otherwise two concurrent turns capture a stale id and --resume forks context.
    const out = await enqueue(() => runClaudeTurn(prompt, SESSION_MODE === 'fresh' ? '' : sessionId));
    if (out.sessionId) { sessionId = out.sessionId; saveSessionId(out.sessionId); }
    return out;
  } catch (err) {
    if (SESSION_MODE !== 'fresh' && sessionId) {
      // The saved session may be gone (deleted transcript, CLI upgrade). Start fresh once.
      log('warn', `resume failed (${err.message}); starting a fresh session`);
      sessionId = '';
      const out = await enqueue(() => runClaudeTurn(prompt, ''));
      if (out.sessionId) { sessionId = out.sessionId; saveSessionId(out.sessionId); }
      return out;
    }
    throw err;
  }
}

// -------------------------------------------------- HTTP (OpenAI-compatible surface)
function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost'); // fixed base — a malformed Host header must not throw (would crash the process)
  const route = (url.pathname || '/').replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (route === '/health' || route === '/v1/health')) {
    return sendJson(res, 200, { ok: true, bridge: 'cc-companion', session_id: sessionId || null });
  }
  // 档位读写 + 用量快照。和 /v1/chat/completions 同一个监听器(仅本机),
  // 所以没有引入新的信任边界:能打这个口的人本来就能打那个口花掉整份订阅。
  if (route === '/control/config' && (req.method === 'GET' || req.method === 'POST')) {
    if (req.method === 'POST') {
      let body = {};
      try { body = await readJson(req); } catch { body = {}; }
      // 只认白名单里的字面量。传别的进来直接 400,不静默忽略 ——
      // 这个口是给人点的,点了没反应比报错更难查。
      if (body.effort !== undefined) {
        const e = String(body.effort || '');
        if (e && !EFFORT_CHOICES.includes(e)) {
          return sendJson(res, 400, { error: { message: `effort 只能是 ${EFFORT_CHOICES.join('/')}` } });
        }
        runtimeEffort = e;
      }
      if (body.model !== undefined) {
        const m = String(body.model || '');
        const allowed = MODEL_CHOICES.length ? MODEL_CHOICES : [CLAUDE_MODEL].filter(Boolean);
        if (m && !allowed.includes(m)) {
          return sendJson(res, 400, { error: { message: `model 不在允许列表里(${allowed.join('/') || '未声明 CLAUDE_MODELS'})` } });
        }
        runtimeModel = m;
      }
      log('info', `档位已改 model=${runtimeModel || '(默认)'} effort=${runtimeEffort || '(默认)'}`);
    }
    return sendJson(res, 200, {
      model: runtimeModel,
      effort: runtimeEffort,
      models: MODEL_CHOICES.length ? MODEL_CHOICES : [CLAUDE_MODEL].filter(Boolean),
      efforts: EFFORT_CHOICES,
      usage: { ...usageTotals, last_turn_prompt: lastTurnPrompt, last_turn_output: lastTurnOutput },
    });
  }

  if (req.method === 'GET' && route === '/v1/models') {
    return sendJson(res, 200, { object: 'list', data: [{ id: 'claude-code', object: 'model', owned_by: 'anthropic' }] });
  }
  if (req.method === 'POST' && route === '/v1/chat/completions') {
    const body = await readJson(req);
    const prompt = buildPrompt(body.messages).trim();
    if (!prompt) return sendJson(res, 400, { error: { message: 'no user message in request' } });
    // Put the 资料库 on disk where the agent can actually open it (retrieval only ever
    // sends a few chunks). Failure here is non-fatal — the turn goes ahead without it.
    const manifest = await syncLibrary({ appUrl: APP_URL, token: APP_AUTH_TOKEN, cwd: process.cwd(), log });
    const fullPrompt = manifest ? `${manifest}\n\n---\n\n${prompt}` : prompt;
    try {
      const { content, thinking } = await runTurn(fullPrompt);
      const now = Math.floor(Date.now() / 1000);
      return sendJson(res, 200, {
        id: `chatcmpl-bridge-${now}`,
        object: 'chat.completion',
        created: now,
        model: body.model || 'claude-code',
        choices: [{
          index: 0,
          // content -> chat bubble; reasoning_content -> the app's thinking block
          message: { role: 'assistant', content, reasoning_content: thinking || undefined },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: lastTurnPrompt, completion_tokens: lastTurnOutput, total_tokens: lastTurnPrompt + lastTurnOutput },
      });
    } catch (err) {
      log('error', `turn failed: ${err.message}`);
      await postConsole('error', ASSISTANT_NAME, err.message);
      return sendJson(res, 502, { error: { message: err.message } });
    }
  }
  sendJson(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, HOST, () => {
  log('info', `listening on http://${HOST}:${PORT}  (mode: ${BRIDGE_MODE}${BRIDGE_MODE === 'print' ? '/' + SESSION_MODE : ''})`);
  log('info', `app=${APP_URL}  claude="${CLAUDE_BIN}"${CLAUDE_MODEL ? ` model=${CLAUDE_MODEL}` : ''}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    log('warn', 'bound to a non-local address — this exposes your Claude subscription. Put auth + TLS in front of it!');
  }
  if (!APP_AUTH_TOKEN) log('info', 'no APP_AUTH_TOKEN set — that is fine for local use. If you add a password to the app later, put the same value here so console events keep coming through.');
});
