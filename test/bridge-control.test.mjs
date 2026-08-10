// 桥的档位控制口 —— 重点是**白名单挡不挡得住参数注入**。
//
// 为什么这份测试非有不可:model/effort 这两个值会被 push 进 spawn 的 args 数组。
// `shell: false` 挡住了 shell 注入,但**挡不住参数注入** —— 传一个 `--` 开头的值进去,
// CLI 的参数解析器会把它当成一个新开关,而不是 --model 的值。
// 这四种形状我实弹打过一次,但「打过一次」和「以后有人把过滤删了会红」是两件事:
// 过滤点被删掉时,没有断言的代码照样全绿。所以钉进来。
//
// 跑的是**真进程 + 真 HTTP**,不是 import 内部函数 —— 注入点必须走真实控制流,
// 不然测到的是一条用户永远走不到的路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

async function withBridge(fn) {
  const port = await freePort();
  const child = spawn(process.execPath, ['bridge/index.js'], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      CLAUDE_BIN: '/bin/true',            // 不会真去调模型
      CLAUDE_MODEL: 'opus',
      CLAUDE_MODELS: 'opus,sonnet',
      CLAUDE_EFFORT: 'high',
      APP_URL: 'http://127.0.0.1:1',      // 指向死地址:postConsole 失败不该影响这些口
    },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`${base}/control/config`); if (r.ok) break; } catch { /* 等启动 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return await fn(base);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
  }
}
const post = (base, body) => fetch(`${base}/control/config`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const get = (base) => fetch(`${base}/control/config`).then((r) => r.json());

test('读得到当前档位和可选项', async () => {
  const d = await withBridge(get);
  assert.equal(d.effort, 'high');
  assert.equal(d.model, 'opus');
  assert.deepEqual(d.models, ['opus', 'sonnet']);
  assert.ok(d.efforts.includes('xhigh') && d.efforts.includes('max'), 'effort 取值要和 CLI 的 --effort 对齐(含 max)');
});

test('合法值改得动', async () => {
  const d = await withBridge(async (base) => {
    await post(base, { effort: 'low' });
    await post(base, { model: 'sonnet' });
    return get(base);
  });
  assert.equal(d.effort, 'low');
  assert.equal(d.model, 'sonnet');
});

test('★★ 参数注入形状必须被挡,而且挡完档位不许被污染', async () => {
  const shapes = [
    { effort: '--dangerously-skip-permissions' },
    { model: '--mcp-config=/tmp/evil.json' },
    { effort: '-v' },
    { model: '../../etc/passwd' },
    { effort: 'ultra' },          // 看着像档位,但不在 CLI 的取值里
    { model: 'gpt-4' },           // 不在声明的模型表里
  ];
  const { codes, after } = await withBridge(async (base) => {
    const codes = [];
    for (const s of shapes) codes.push((await post(base, s)).status);
    return { codes, after: await get(base) };
  });
  for (const [i, c] of codes.entries()) {
    assert.equal(c, 400, `${JSON.stringify(shapes[i])} 本该被拒,却回了 ${c}`);
  }
  // 被拒之后不能留下半个改动
  assert.equal(after.effort, 'high', '拒绝之后 effort 被污染了');
  assert.equal(after.model, 'opus', '拒绝之后 model 被污染了');
});

test('★ 当前值不在白名单里时,也必须出现在选项里(否则界面切走就回不来)', async () => {
  // 部署方声明了一个白名单外的模型:它得能显示、能选回来
  const port = await freePort();
  const child = spawn(process.execPath, ['bridge/index.js'], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BRIDGE_PORT: String(port), CLAUDE_BIN: '/bin/true', CLAUDE_MODEL: 'some-custom-model', CLAUDE_MODELS: 'opus,sonnet', CLAUDE_EFFORT: 'high', APP_URL: 'http://127.0.0.1:1' },
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`${base}/control/config`); if (r.ok) break; } catch { /* 等 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const d = await get(base);
    assert.ok(d.models.includes('some-custom-model'), '当前模型没出现在选项里,界面显示不出也切不回来');
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
  }
});

test('声明了上下文窗口就报出去(前端据此把「(估)」换成准值)', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['bridge/index.js'], {
    cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BRIDGE_PORT: String(port), CLAUDE_BIN: '/bin/true', CLAUDE_CONTEXT_WINDOW: '1000000', APP_URL: 'http://127.0.0.1:1' },
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch(`${base}/control/config`); if (r.ok) break; } catch { /* 等 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await get(base)).context_window, 1000000);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 3000); });
  }
});
