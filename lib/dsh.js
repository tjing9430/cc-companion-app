import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT_DIR, store } from './state.js';
import { addConsoleEvent, pushRawLines } from './console.js';
import { broadcastSse } from './sse.js';

let child = null;
let ready = null;
let seq = 0;
const pending = new Map();

function stopWorker() {
  if (child) child.kill();
  child = null;
  ready = null;
  for (const item of pending.values()) item.reject(new Error('DSH worker stopped'));
  pending.clear();
}

function ensureWorker() {
  if (child && ready) return ready;
  const command = String(process.env.DSH_PYTHON || 'python');
  const workerScript = String(process.env.DSH_WORKER_SCRIPT || path.join(ROOT_DIR, 'adapters', 'dsh-worker.py'));
  const dshPath = [String(process.env.DSH_BASH_DIR || '').trim(), process.env.PATH || ''].filter(Boolean).join(path.delimiter);
  const args = /(?:^|[\\/])node(?:\.exe)?$/i.test(command) ? [workerScript] : ['-u', workerScript];
  child = spawn(command, args, {
    cwd: ROOT_DIR, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PATH: dshPath,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      LANG: process.env.LANG || 'C.UTF-8',
      LC_ALL: process.env.LC_ALL || 'C.UTF-8',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || '',
    },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer = '';
  ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH startup timed out')), Number(process.env.DSH_STARTUP_TIMEOUT_MS || 180000));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const cut = buffer.indexOf('\n');
        if (cut < 0) break;
        const line = buffer.slice(0, cut); buffer = buffer.slice(cut + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'ready') { clearTimeout(timer); addConsoleEvent('system', 'DeepSeek Harness', `已就绪 · ${msg.model}`); resolve(msg); continue; }
        const item = pending.get(String(msg.id || ''));
        if (!item) continue;
        if (msg.type === 'delta') {
          item.onDelta?.(msg.channel === 'thinking' ? 'thinking' : 'content', String(msg.delta || ''));
          continue;
        }
        pending.delete(String(msg.id));
        if (msg.type === 'error') item.reject(new Error(msg.error || 'DSH turn failed'));
        else item.resolve(msg);
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`DSH worker exited (${code})`)); stopWorker(); });
    child.stderr.on('data', (chunk) => { const text = String(chunk).trim(); if (text) addConsoleEvent('debug', 'DSH runtime', text.slice(-1000)); });
  });
  return ready;
}

async function callDshAgent(scope, userMessage, history = [], onDelta = () => {}) {
  await ensureWorker();
  const id = String(++seq);
  const transcript = (Array.isArray(history) ? history : [])
    .map((turn) => `${turn.role === 'assistant' ? 'AI' : '用户'}：${String(turn.content || '').trim()}`)
    .filter((line) => !line.endsWith('：'))
    .join('\n\n');
  const current = `${scope === 'group' ? `${userMessage.sender}: ` : ''}${userMessage.content || '[附件]'}`;
  const basePrompt = transcript
    ? `下面是 CCC 当前聊天界面中的真实前文。请延续这些前文回答，不要声称看不到前文。\n\n${transcript}\n\n【当前消息】\n${current}`
    : current;
  const fileDelivery = [
    '如果用户要求你创建并发送文件：请使用工具把文件写到当前工作目录内。',
    '最终回复末尾为每个要交付的文件单独添加 [[CCC_FILE:文件绝对路径]]。',
    '不要把该标记放进代码块；只有确实存在、需要交付给用户的文件才添加。',
  ].join('\n');
  const prompt = `${fileDelivery}\n\n${basePrompt}`;
  const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject, onDelta }));
  const localSession = String(store.session && store.session.current_id || 'default');
  child.stdin.write(`${JSON.stringify({ id, prompt, session_id: `${process.env.DSH_SESSION_ID || 'ccc-dsh-v2'}-${localSession}-${scope}` })}\n`);
  const timeoutMs = Number(process.env.DSH_REQUEST_TIMEOUT_MS || 360000);
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('DSH turn timed out')), timeoutMs));
  const result = await Promise.race([response, timer]);
  const lines = (result.events || []).slice(-120).map((event) => JSON.stringify({ source: 'dsh', ...event }));
  if (lines.length) { pushRawLines(lines); broadcastSse('console-stream', { lines }); }
  for (const tool of result.tools || []) addConsoleEvent('tool', tool.name, tool.arg || '');
  return {
    content: result.content || '', thinking: result.thinking || '', tools: result.tools || [],
    api_usage: { ...(result.usage || {}), provider: result.provider || 'dsh' },
  };
}

export { callDshAgent, stopWorker };
