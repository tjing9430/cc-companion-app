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
const CLAUDE_MCP_CONFIG = String(process.env.CLAUDE_MCP_CONFIG || '').trim();
const ASSISTANT_NAME = String(process.env.ASSISTANT_NAME || 'Claude Code').trim() || 'Claude Code';
const DATA_DIR = path.resolve(REPO_ROOT, process.env.DATA_DIR || 'data');
// 'resume' keeps one long-lived Claude Code session (context persists across
// turns and restarts). 'fresh' starts a new session on every bridge restart.
const SESSION_MODE = (process.env.BRIDGE_SESSION_MODE || 'resume').toLowerCase();
const SESSION_FILE = path.join(DATA_DIR, 'bridge-session.json');
const RUN_TIMEOUT_MS = Math.max(10000, Number(process.env.BRIDGE_TIMEOUT_MS || 300000));
const THINKING_FLUSH_MS = 700; // batch thinking deltas before posting to the console

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
    if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);
    if (CLAUDE_MCP_CONFIG) args.push('--mcp-config', CLAUDE_MCP_CONFIG);

    // shell:false + prompt via stdin — never interpolate user text into a shell.
    const child = spawn(CLAUDE_BIN, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let finalText = '';   // authoritative reply from the `result` event
    let streamedText = ''; // fallback: accumulated text_delta
    let thinking = '';    // accumulated thinking_delta
    let newSessionId = '';
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
        if (mcp) postConsole('info', ASSISTANT_NAME, `MCP servers: ${mcp}`);
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
        if (!finalText && (j.is_error || (j.subtype && j.subtype !== 'success'))) {
          finalText = `(claude error: ${j.subtype || 'unknown'})`;
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

// Run a turn, transparently recovering from a stale/expired resume session.
async function runTurn(prompt) {
  const resume = SESSION_MODE === 'fresh' ? '' : sessionId;
  try {
    const out = await enqueue(() => runClaudeTurn(prompt, resume));
    if (out.sessionId) { sessionId = out.sessionId; saveSessionId(out.sessionId); }
    return out;
  } catch (err) {
    if (resume) {
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

// -------------------- extract the latest user text from an OpenAI messages array
function latestUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
      }
    }
  }
  return '';
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
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const route = (url.pathname || '/').replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (route === '/health' || route === '/v1/health')) {
    return sendJson(res, 200, { ok: true, bridge: 'cc-companion', session_id: sessionId || null });
  }
  if (req.method === 'GET' && route === '/v1/models') {
    return sendJson(res, 200, { object: 'list', data: [{ id: 'claude-code', object: 'model', owned_by: 'anthropic' }] });
  }
  if (req.method === 'POST' && route === '/v1/chat/completions') {
    const body = await readJson(req);
    const prompt = latestUserText(body.messages).trim();
    if (!prompt) return sendJson(res, 400, { error: { message: 'no user message in request' } });
    try {
      const { content, thinking } = await runTurn(prompt);
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
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
  log('info', `listening on http://${HOST}:${PORT}  (session: ${sessionId ? sessionId.slice(0, 8) + '…' : 'new'}, mode: ${SESSION_MODE})`);
  log('info', `app=${APP_URL}  claude="${CLAUDE_BIN}"${CLAUDE_MODEL ? ` model=${CLAUDE_MODEL}` : ''}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    log('warn', 'bound to a non-local address — this exposes your Claude subscription. Put auth + TLS in front of it!');
  }
  if (!APP_AUTH_TOKEN) log('warn', 'APP_AUTH_TOKEN is empty — set it to match the app so console events are accepted when the app is protected.');
});
