/**
 * Interactive-mode turn runner (v1.1) — restores extended thinking.
 * -----------------------------------------------------------------
 * Headless `claude -p` redacts extended thinking (only encrypted signatures reach
 * the stream/transcript). Interactive mode exposes plaintext thinking in the session
 * transcript. So we drive a long-lived INTERACTIVE Claude Code CLI inside a pseudo-tty
 * (via util-linux `script`) and read the transcript jsonl for the reply + thinking.
 *
 * ARCHITECTURE RED LINE: the terminal is a DUMB PIPE. We only WRITE keystrokes to it
 * (type the message + Enter) and NEVER parse a byte of its output. All content —
 * thinking, text, tool calls — is read from the transcript jsonl:
 *   ~/.claude/projects/<cwd-escaped>/<session-id>.jsonl
 *
 * Platform: Linux / WSL (needs util-linux `script`). macOS BSD `script` has a
 * different argument form and is untested; Windows is not supported in v1.1.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Claude Code encodes the cwd into the projects-dir folder name by replacing every
// run of non-alphanumeric characters with a single '-'.
function projectDirFor(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]+/g, '-'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createInteractiveRunner(opts) {
  const {
    claudeBin = 'claude',
    cwd = process.cwd(),
    model = '',
    mcpConfig = '',
    permissionMode = '',      // BRIDGE_PERMISSION_MODE → --permission-mode (empty = leave the user's config alone)
    sessionFile,              // persist the session uuid for --resume across restarts
    startupMs = 6000,         // TUI boot delay before the first injection
    idleHangMs = 20000,       // no jsonl growth this long mid-turn → suspected permission prompt
    turnTimeoutMs = 300000,   // give up waiting for end_turn (the process stays alive)
    settleMs = 900,           // pause after the paste before sending Enter
    log = () => {},
    postConsole = () => {},
    assistantName = 'Claude Code',
  } = opts;

  let uuid = loadUuid();
  let child = null;      // the `script` process wrapping claude
  let alive = false;
  let booted = false;    // TUI startup delay elapsed this spawn
  let readOffset = 0;    // bytes consumed from the current jsonl
  let lineBuf = '';      // partial trailing line carried between reads

  function loadUuid() {
    try { return String(JSON.parse(fs.readFileSync(sessionFile, 'utf8')).session_id || '').trim(); } catch { return ''; }
  }
  function saveUuid(id) {
    try { fs.mkdirSync(path.dirname(sessionFile), { recursive: true }); fs.writeFileSync(sessionFile, JSON.stringify({ session_id: id, mode: 'interactive', updated_at: new Date().toISOString() }, null, 2)); }
    catch (err) { log('warn', `persist session id failed: ${err.message}`); }
  }
  function jsonlPath() { return uuid ? path.join(projectDirFor(cwd), uuid + '.jsonl') : ''; }

  function spawnSession() {
    const resuming = Boolean(uuid);
    if (!uuid) { uuid = crypto.randomUUID(); readOffset = 0; lineBuf = ''; }
    const parts = [claudeBin, resuming ? '--resume' : '--session-id', uuid];
    if (permissionMode) parts.push('--permission-mode', permissionMode);
    if (model) parts.push('--model', model);
    if (mcpConfig) parts.push('--mcp-config', mcpConfig);
    // script -q -e -c "<cmd>" /dev/null : run claude in a pty so it sees a TTY → interactive → thinking exposed.
    child = spawn('script', ['-q', '-e', '-c', parts.join(' '), '/dev/null'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {}); // dumb pipe — never parsed (red line)
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('exit', (code) => { alive = false; booted = false; log('warn', `interactive session exited (code ${code}); will --resume on next turn`); });
    alive = true; booted = false;
    saveUuid(uuid);
    log('info', `interactive session ${resuming ? 'resumed' : 'started'} ${uuid.slice(0, 8)}…`);
  }

  async function ensureAlive() {
    if (alive && child) return;
    spawnSession();
    await sleep(startupMs);
    booted = true;
  }

  // Incremental read: only the bytes appended since last call, split into complete
  // JSON lines (partial trailing line is carried over). Scales to long sessions.
  function readNewEntries() {
    const p = jsonlPath();
    let size;
    try { size = fs.statSync(p).size; } catch { return []; }
    if (size <= readOffset) return [];
    let chunk = '';
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(size - readOffset);
      fs.readSync(fd, buf, 0, buf.length, readOffset);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
      readOffset = size;
    } catch { return []; }
    lineBuf += chunk;
    const parts = lineBuf.split('\n');
    lineBuf = parts.pop() || '';
    return parts.filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // Inject one turn (type message + Enter) and read its reply + thinking from the jsonl.
  async function runTurn(prompt) {
    await ensureAlive();
    if (!booted) { await sleep(startupMs); booted = true; }
    readNewEntries(); // drain any trailing entries from the previous turn so we start clean

    // Inject via BRACKETED PASTE: wrap the text in paste markers so newlines are literal
    // (not mid-message submits) and the whole message goes in one fast write; then Enter.
    // Strip ESC (0x1b) from user text so it cannot break out of the paste bracket / inject
    // control sequences. \r is dropped (paste uses \n for line breaks).
    const msg = String(prompt).replace(/\x1b/g, '').replace(/\r/g, '').trim();
    if (!msg) throw new Error('empty prompt');
    child.stdin.write('\x1b[200~' + msg + '\x1b[201~');
    await sleep(settleMs);
    child.stdin.write('\r');
    const startedAt = Date.now();

    let thinking = '';
    let finalText = '';
    let lastGrowth = Date.now();
    let hangWarned = false;
    let done = false;

    while (!done) {
      if (!alive) throw new Error('interactive session died mid-turn');
      if (Date.now() - startedAt > turnTimeoutMs) throw new Error(`interactive turn timed out after ${turnTimeoutMs} ms`);
      const fresh = readNewEntries();
      if (fresh.length) lastGrowth = Date.now();
      for (const j of fresh) {
        if (j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) continue;
        const endTurn = j.message.stop_reason === 'end_turn';
        for (const b of j.message.content) {
          if (b.type === 'thinking' && b.thinking) { thinking += b.thinking; postConsole('thinking', assistantName, b.thinking); }
          else if (b.type === 'tool_use' && b.name) { postConsole('tool', assistantName, `→ ${b.name}`); }
          else if (b.type === 'text' && b.text && endTurn) { finalText += b.text; }
        }
        if (endTurn && j.message.content.some((b) => b.type === 'text')) done = true;
      }
      if (!done && !hangWarned && Date.now() - lastGrowth > idleHangMs) {
        hangWarned = true;
        postConsole('info', assistantName, '（长时间无进展:可能在等工具权限确认——请到运行 bridge 的终端处理,或用 BRIDGE_PERMISSION_MODE 预设权限）');
      }
      if (!done) await sleep(400);
    }
    await sleep(500); // catch trailing end_turn text blocks
    for (const j of readNewEntries()) {
      if (j.type === 'assistant' && j.message && j.message.stop_reason === 'end_turn' && Array.isArray(j.message.content)) {
        for (const b of j.message.content) if (b.type === 'text' && b.text) finalText += b.text;
      }
    }

    const content = finalText.trim();
    if (!content) throw new Error('interactive turn produced no reply text');
    return { content, thinking: thinking.trim(), sessionId: uuid };
  }

  function shutdown() { try { if (child) child.kill('SIGTERM'); } catch { /* ignore */ } }

  return { runTurn, shutdown };
}
