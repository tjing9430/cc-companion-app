#!/usr/bin/env node
/*
 * 分身的本地工具箱(stdio MCP server)。
 *
 * 为什么单独一个进程:claude CLI 只认 --mcp-config 里的 server,而分身沙箱
 * deny 了 Bash —— 它读得了 workspace 文件,却没有任何把文件递出去的手。
 * 这里补的就是那一只手,而且只有这一只:send_file_to_user。
 *
 * 安全边界(动之前想清楚再动):
 *   - 只允许发 CCC_WORKSPACE 里的文件 —— realpath 后前缀校验,symlink 逃逸也拦。
 *   - APP token 从本进程 env 拿(mcp-config.json 的 env 字段注入),
 *     沙箱 settings.json 同时 deny 了分身对 mcp-config.json 的读 ——
 *     分身能用这只手,摸不到手里的钥匙。
 *   - stdout 是协议通道,一个字的日志都不能混进来;要说话走 stderr。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const APP_URL = String(process.env.CCC_APP_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const APP_TOKEN = String(process.env.CCC_APP_TOKEN || '');
const WORKSPACE = fs.realpathSync(process.env.CCC_WORKSPACE || '/ABSOLUTE/PATH/TO/agent-workspace');
const MAX_BYTES = 6 * 1024 * 1024; // dataURL 膨胀 ~1.37x 后仍要过 server 的 payload 上限

const MIME_BY_EXT = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

const TOOLS = [{
  name: 'send_file_to_user',
  description: '把 workspace 里的一个文件作为附件发进和用户的聊天。path 是 workspace 内的文件路径(相对 workspace 根或绝对路径都行),note 是随文件一起说的话(可空)。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'workspace 内的文件路径' },
      note: { type: 'string', description: '随附件说的一句话,可省略' },
    },
    required: ['path'],
  },
}];

function textResult(id, text, isError) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } };
}

async function sendFile(args) {
  const rel = String((args && args.path) || '').trim();
  if (!rel) return 'need path';
  const abs = path.isAbsolute(rel) ? rel : path.join(WORKSPACE, rel);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return `文件不存在: ${rel}`;
  }
  if (real !== WORKSPACE && !real.startsWith(WORKSPACE + path.sep)) {
    return `只能发 workspace 里的文件(拿到的路径解析到了外面): ${rel}`;
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) return `不是文件: ${rel}`;
  if (stat.size > MAX_BYTES) return `文件太大(${stat.size} 字节,上限 ${MAX_BYTES})`;

  const ext = path.extname(real).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const dataUrl = `data:${mime};base64,${fs.readFileSync(real).toString('base64')}`;

  const resp = await fetch(`${APP_URL}/api/chat/agent-file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(APP_TOKEN ? { 'x-app-token': APP_TOKEN } : {}) },
    body: JSON.stringify({ name: path.basename(real), data: dataUrl, note: String((args && args.note) || '') }),
  });
  const body = await resp.text();
  if (!resp.ok) return `发送失败 HTTP ${resp.status}: ${body.slice(0, 200)}`;
  return `已发送: ${path.basename(real)} (${stat.size} 字节) ${body.slice(0, 200)}`;
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { id, method, params } = msg;
  const reply = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

  if (method === 'initialize') {
    return reply({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ccc-tools', version: '1.0.0' },
    } });
  }
  if (method === 'notifications/initialized') return; // 通知无应答
  if (method === 'tools/list') return reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = params && params.name;
    if (name !== 'send_file_to_user') return reply(textResult(id, `unknown tool: ${name}`, true));
    try {
      const out = await sendFile((params && params.arguments) || {});
      const bad = !out.startsWith('已发送');
      return reply(textResult(id, out, bad));
    } catch (err) {
      return reply(textResult(id, `工具内部错误: ${err && err.message}`, true));
    }
  }
  if (id !== undefined && id !== null) {
    reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
