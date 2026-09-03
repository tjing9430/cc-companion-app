// 跨文件锚点扫描:文档里 `](other.md#anchor)` 指向的标题必须真的存在。
//
// ★ 为什么值得一条 CI:改标题的人**看不见**谁在链它。
//   在单个文件里搜 `](#` 只能查到本文件内部的锚点 —— 别的文件指进来的那些,
//   那次搜索的范围里根本没有。于是"我查过了"和"我查全了"变成两件事,
//   而它们看起来一模一样。把"记得去看 docs/"换成"忘了也过不了"。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listMarkdown(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listMarkdown(p, acc);
    else if (e.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

// GitHub 的 slug 规则:小写、去标点、空格转连字符。CJK 原样保留。
// ★ 空格必须**逐个**转连字符,不能用 `\s+` 合并:
//   `mode — read` 去掉破折号后剩两个空格,GitHub 出 `mode--read`(两个连字符),
//   合并写法会出 `mode-read`,于是一条**好链接被判成死链**。
//   这个 bug 第一次跑就制造了一条假阳性 —— 尺子先咬了自己。
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function anchorsOf(file) {
  const out = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) out.add(slug(m[2]));
  }
  return out;
}

// 只查指向**本仓库 .md 文件**的锚点链接;外链和纯 `#frag` 同文件锚点都算。
function anchorLinks(file) {
  const text = fs.readFileSync(file, 'utf8');
  const links = [];
  for (const m of text.matchAll(/\]\(([^)\s]*?)#([^)\s]+)\)/g)) {
    const [, target, frag] = m;
    if (/^https?:/i.test(target)) continue;
    const resolved = target === '' ? file : path.resolve(path.dirname(file), target);
    if (!resolved.endsWith('.md')) continue;
    links.push({ target: target || '(本文件)', frag, resolved, line: text.slice(0, m.index).split('\n').length });
  }
  return links;
}

const FILES = listMarkdown(REPO);

test('文档里的跨文件锚点都指向真实存在的标题', () => {
  const anchorCache = new Map();
  const broken = [];
  let checked = 0;
  for (const f of FILES) {
    for (const l of anchorLinks(f)) {
      checked++;
      if (!fs.existsSync(l.resolved)) {
        broken.push(`${path.relative(REPO, f)}:${l.line} → 文件不存在 ${l.target}`);
        continue;
      }
      if (!anchorCache.has(l.resolved)) anchorCache.set(l.resolved, anchorsOf(l.resolved));
      if (!anchorCache.get(l.resolved).has(l.frag.toLowerCase())) {
        broken.push(`${path.relative(REPO, f)}:${l.line} → ${l.target}#${l.frag} 没有这个标题`);
      }
    }
  }
  // ★ 判据本身也要有量:一条都没扫到时"全绿"是假的
  assert.ok(checked > 0, '一个锚点链接都没扫到 —— 是正则坏了,不是文档干净');
  assert.deepEqual(broken, [], `死锚点:\n  ${broken.join('\n  ')}`);
});

test('slug 规则跟 GitHub 对得上(改标题的人靠它判断锚点会不会变)', () => {
  assert.equal(slug('Roadmap'), 'roadmap');
  assert.equal(slug('为什么是它'), '为什么是它');
  assert.equal(slug('为什么要求 Node 22.13+'), '为什么要求-node-2213');
  // ★ 破折号/≠ 这类符号被删掉后,**两边的空格各自变成一个连字符**
  assert.equal(slug('编辑面 ≠ 服务面'), '编辑面--服务面');
  assert.equal(slug('Tool permissions (interactive mode) — read this'), 'tool-permissions-interactive-mode--read-this');
});

// ── README 里的**代码示例**会不会写出代码里根本没有的字段 ─────────────
//
// ★ 由来:README 的 `GATES` 示例里挂着 `star: 'star-moon.webp'`,
//   而那个字段在 5acefed 就删了(图标改成按 tab 名推出来)。
//   照着抄的人会设一个**没人读的字段**,不报错、不生效,自己还以为配好了。
//   ⇒ 文档跟代码脱节是"忘了同步"型的错,而"记得同步"这条路今天已经被证伪过好几次。
//     **能机械检查的就别靠记性。**
test('★ README 代码示例里的字段,必须在真实数据结构里存在', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const home = fs.readFileSync(path.join(REPO, 'public/js/home-view.js'), 'utf8');
  const more = fs.readFileSync(path.join(REPO, 'public/js/more-view.js'), 'utf8');

  // 从 README 的 js 代码块里,把形如 `{ a: ..., b: ... }` 的对象字面量的键抠出来
  const blocks = [...readme.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  const keysIn = (src) => new Set([...src.matchAll(/(?:^|[{,]\s*)([a-zA-Z_$][\w$]*)\s*:/g)].map((m) => m[1]));

  // GATES 那个示例(认得出来:含 side / size)
  const gateEx = blocks.find((b) => /\bside\s*:/.test(b) && /\bsize\s*:/.test(b));
  assert.ok(gateEx, 'README 里找不到 GATES 示例了 —— 是不是改了写法?这条测试要跟着改');
  const gateReal = keysIn(home.slice(home.indexOf('const GATES'), home.indexOf('];', home.indexOf('const GATES'))));
  for (const k of keysIn(gateEx)) {
    assert.ok(gateReal.has(k),
      `README 的 GATES 示例里写了 \`${k}:\`,但 home-view.js 的 GATES 里没有这个字段。\n` +
      `照着抄的人会设一个没人读的字段 —— 不报错、不生效。要么改 README,要么这个字段该加回代码。`);
  }

  // SLOTS 那个示例(认得出来:含 action)
  const slotEx = blocks.find((b) => /\baction\s*:/.test(b) && /\btitle\s*:/.test(b));
  if (slotEx) {
    const slotReal = keysIn(more.slice(more.indexOf('const SLOTS'), more.indexOf('];', more.indexOf('const SLOTS'))));
    for (const k of keysIn(slotEx)) {
      assert.ok(slotReal.has(k),
        `README 的 SLOTS 示例里写了 \`${k}:\`,但 more-view.js 的 SLOTS 里没有这个字段。`);
    }
  }
});
