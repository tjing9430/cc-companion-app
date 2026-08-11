// CSS 关键选择器闸门。
//
// 起因是一次真事故:一次「整段替换 CSS」的编辑用了 `s[:i] + 新 + s[j:]`,
// 而首屏那 87 行**正好夹在两个标记中间**,连带一起被删掉,推到线上成了裸 HTML。
//
// ★ 最难受的不是删错,是**它溜过了所有闸门**:
//   159 条测试全绿、`node --check` 也过 —— 因为 CSS **既没有语法检查、也没有测试**。
//   同一类错误当天犯了四次,前三次都被测试或 --check 当场逮住,只有落在 CSS 上的这次跑掉了。
//
// 所以这道闸只做一件很笨但很有效的事:**关键选择器少一个就红**。
// 它挡不住样式写歪,但能挡住「整块消失」—— 而整块消失正是最贵、最难在 review 里看出来的那种。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/styles.css'), 'utf8');

// 每一条都对应「没了就有一整块界面变成裸 HTML」的地方。
// 加新界面时把它的根选择器加进来 —— 这份清单的价值全在于它被维护。
const REQUIRED = [
  '.home-view', '.home-hero', '.home-sky', '.sky-galaxy', '.sky-gates', '.sky-gate',
  '.sg-star', '.sg-text', '.sg-title', '.home-recent',
  '.topbar', '.sidebar', '.composer', '.bubble', '.message-list',
  '.cv-strip', '.console-view', '.memory-view', '.chat-view', '.term-view',
  '.event-list', '.memory-list', '.quota-panel',
];

test('关键选择器一个都不能少(挡「整块 CSS 消失」)', () => {
  const missing = REQUIRED.filter((sel) => !CSS.includes(sel));
  assert.deepEqual(missing, [], `styles.css 里少了这些选择器:${missing.join(' ')}`);
});

test('首屏那张银河图确实在仓库里,而且没胖回去', () => {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/assets/galaxy-river.webp');
  assert.ok(fs.existsSync(p), '银河素材不见了,首屏会只剩几颗浮在空中的星');
  const kb = fs.statSync(p).size / 1024;
  // 300KB 是评审定的上限。落地页首屏图,再大就要拿加载时间去换。
  assert.ok(kb < 300, `银河图 ${kb.toFixed(0)}KB,超过 300KB 上限了`);
});

test('首屏容器比例必须跟素材一致 —— 否则星星会偏离银河', () => {
  // 星星的 --x/--y 是从素材像素里算出来的,容器一旦不同比(比如改成 object-fit:cover
  // 去裁切),图被裁掉多少星星就偏多少。这条把那个隐含约定钉成断言。
  const m = /aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/.exec(CSS.slice(CSS.indexOf('.home-sky{')));
  assert.ok(m, '.home-sky 上找不到 aspect-ratio');
  const ratio = Number(m[1]) / Number(m[2]);
  assert.ok(Math.abs(ratio - 2 / 3) < 0.001, `容器比例 ${ratio.toFixed(4)} 与素材的 2:3 不符`);
  assert.ok(!/\.sky-galaxy\{[^}]*object-fit:\s*cover/.test(CSS), '银河图不能用 object-fit:cover:裁切会让星星偏离');
});
