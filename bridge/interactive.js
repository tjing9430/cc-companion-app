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

// Join two text pieces, inserting a blank line when neither side brings its own
// whitespace — separates distinct text blocks (e.g. pre-tool "let me check…" and the
// post-tool conclusion) so precise outputs don't collide as "PART-APART-B". Used both
// inside a fold and when appending across read batches (a turn's text blocks usually
// arrive in different batches, separated by tool execution).
export function appendText(acc, piece) {
  if (!piece) return acc;
  if (acc && !/\s$/.test(acc) && !/^\s/.test(piece)) return acc + '\n\n' + piece;
  return acc + piece;
}

// Fold a batch of transcript entries into deltas. Collects ALL assistant text blocks
// (not only the final end_turn one) so pre-tool transition text ("let me check…") is kept;
// done = an assistant end_turn entry that carries text. Pure — unit-testable.
export function foldTurnEntries(entries) {
  let thinking = '', text = '', done = false;
  const tools = [];
  for (const j of entries || []) {
    if (!j || j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) continue;
    for (const b of j.message.content) {
      if (b.type === 'thinking' && b.thinking) thinking += b.thinking;
      else if (b.type === 'text' && b.text) text = appendText(text, b.text);
      else if (b.type === 'tool_use' && b.name) tools.push(b.name);
    }
    if (j.message.stop_reason === 'end_turn' && j.message.content.some((b) => b.type === 'text')) done = true;
  }
  return { thinking, text, tools, done };
}

export function createInteractiveRunner(opts) {
  const {
    claudeBin = 'claude',
    cwd = process.cwd(),
    model = '',
    mcpConfig = '',
    permissionMode = '',      // BRIDGE_PERMISSION_MODE → --permission-mode (empty = leave the user's config alone)
    sessionFile,              // persist the session uuid for --resume across restarts
    startupMs = 10000,        // TUI boot delay before the first injection (MCP-heavy setups boot slowly)
    injectConfirmFirstMs = 12000, // confirm-injection window on the first (cold) turn
    injectConfirmMs = 6000,   // confirm-injection window on later (warm) turns
    injectAttempts = 3,       // re-paste this many times if the injection isn't confirmed
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
    child.on('exit', (code) => { alive = false; log('warn', `interactive session exited (code ${code}); will --resume on next turn`); });
    alive = true;
    saveUuid(uuid);
    log('info', `interactive session ${resuming ? 'resumed' : 'started'} ${uuid.slice(0, 8)}…`);
  }

  async function ensureAlive() {
    if (alive && child) return;
    spawnSession();
    await sleep(startupMs);
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

  // Inject one turn (bracketed-paste the message + Enter) and read its reply + thinking
  // from the jsonl, confirming the injection actually landed (cold-start pastes can be lost).
  async function runTurn(prompt) {
    await ensureAlive();
    readNewEntries(); // drain any trailing entries from the previous turn so we start clean

    // BRACKETED PASTE: wrap the text so newlines are literal (not mid-message submits) and the
    // whole message goes in one fast write; strip ESC so user text can't break out of the
    // bracket / inject control sequences; \r dropped (paste uses \n for line breaks).
    const msg = String(prompt).replace(/\x1b/g, '').replace(/\r/g, '').trim();
    if (!msg) throw new Error('empty prompt');

    // Inject with confirmation + retry: on a cold start the TUI may not be input-ready and the
    // first paste gets swallowed → no transcript activity. Detect that and re-paste (Ctrl+U
    // first to clear any half-typed residual) instead of waiting out the whole turn timeout.
    let batch = null;
    for (let attempt = 1; attempt <= injectAttempts && !batch; attempt++) {
      if (!alive) throw new Error('interactive session died before injection');
      child.stdin.write('\x15'); // Ctrl+U: clear the input line (drop residual from a swallowed paste)
      await sleep(150);
      child.stdin.write('\x1b[200~' + msg + '\x1b[201~');
      await sleep(settleMs);
      child.stdin.write('\r');
      const until = Date.now() + (attempt === 1 ? injectConfirmFirstMs : injectConfirmMs);
      while (Date.now() < until) {
        if (!alive) throw new Error('interactive session died during injection');
        const fresh = readNewEntries();
        if (fresh.length) { batch = fresh; break; }
        await sleep(400);
      }
      if (!batch && attempt < injectAttempts) log('warn', `injection not confirmed (attempt ${attempt}/${injectAttempts}); clearing + re-pasting`);
    }
    if (!batch) throw new Error('injection failed: no transcript activity after retries (is the CLI stuck at a prompt?)');

    const startedAt = Date.now();
    let thinking = '', finalText = '', lastGrowth = Date.now(), hangWarned = false, done = false;
    const consume = (entries) => {
      if (entries.length) lastGrowth = Date.now();
      const fold = foldTurnEntries(entries);
      if (fold.thinking) { thinking += fold.thinking; postConsole('thinking', assistantName, fold.thinking); }
      for (const name of fold.tools) postConsole('tool', assistantName, `→ ${name}`);
      finalText = appendText(finalText, fold.text); // ALL assistant text (keeps pre-tool transition text)
      if (fold.done) done = true;
    };
    consume(batch); // the entries that confirmed the injection

    while (!done) {
      if (!alive) throw new Error('interactive session died mid-turn');
      if (Date.now() - startedAt > turnTimeoutMs) throw new Error(`interactive turn timed out after ${turnTimeoutMs} ms`);
      consume(readNewEntries());
      if (!done && !hangWarned && Date.now() - lastGrowth > idleHangMs) {
        hangWarned = true;
        postConsole('info', assistantName, '（长时间无进展:可能在等工具权限确认——请到运行 bridge 的终端处理,或用 BRIDGE_PERMISSION_MODE 预设权限）');
      }
      if (!done) await sleep(400);
    }
    await sleep(500); // catch trailing text blocks after end_turn
    finalText = appendText(finalText, foldTurnEntries(readNewEntries()).text);

    const content = finalText.trim();
    if (!content) throw new Error('interactive turn produced no reply text');
    return { content, thinking: thinking.trim(), sessionId: uuid };
  }

  function shutdown() { try { if (child) child.kill('SIGTERM'); } catch { /* ignore */ } }

  return { runTurn, shutdown };
}
