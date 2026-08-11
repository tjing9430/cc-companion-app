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
  '.home-view', '.home-stage', '.home-hero', '.home-sky', '.sky-inner', '.sky-galaxy',
  '.sky-gates', '.sky-gate', '.sg-star', '.sg-text', '.sg-title', '.home-recent',
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

// ★ 这条第一版是**搭便车**的:它从 `.home-sky{` 往后 grep 第一个 aspect-ratio,
//   首屏改版后 .home-sky 已经不带比例了(改成 inset:0 铺满),它却顺手匹配到了后面
//   .sky-inner 的比例,照样绿。断言必须**点名**它真正要管的那个盒子。
//   (同一个坑今天第三次:断言卡在别人也满足的条件上,就永远不会红。)
function ruleFor(sel) {
  const i = CSS.indexOf(`${sel}{`);
  return i < 0 ? '' : CSS.slice(i, CSS.indexOf('}', i));
}

test('银河盒子和入口层必须同比、且都等于素材的 2:3 —— 否则星星会偏离银河', () => {
  // 星星的 --x/--y 是从素材像素里算出来的。.sky-inner(画图的)和 .sky-gates(摆星星的)
  // 必须是**同一个几何盒子**,任何一方比例变了,星星就从带子上滑下来。
  for (const sel of ['.sky-inner', '.sky-gates']) {
    const m = /aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/.exec(ruleFor(sel));
    assert.ok(m, `${sel} 上找不到 aspect-ratio`);
    const ratio = Number(m[1]) / Number(m[2]);
    assert.ok(Math.abs(ratio - 2 / 3) < 0.001, `${sel} 比例 ${ratio.toFixed(4)} 与素材的 2:3 不符`);
  }
  assert.ok(!/\.sky-galaxy\{[^}]*object-fit:\s*cover/.test(CSS), '银河图不能用 object-fit:cover:裁切会让星星偏离');
});

test('第一屏是整整一屏 —— 不是「填满剩下的空间」', () => {
  // flex:1 会被下面的「最近记忆」挤扁(实测只剩 662/844),银河铺不到底、
  // 第一颗星还会撞上 Hero 文字。这条钉住「恰好一屏」。
  assert.match(ruleFor('.home-stage'), /flex:\s*0\s+0\s+100dvh/, '.home-stage 必须固定成一屏高');
});

test('三层要融合,不是叠着 —— 混合、光晕层、星星共光源都得在', () => {
  // 「背景/星河/星星像三个图层」是这一版返工的原话。消除贴纸感靠这三样,
  // 谁把它们删了,画面立刻退回三张纸叠着的样子,而且没有任何报错。
  //
  // ★ 断言盯的是**性质**(有没有一层更柔更大的光晕),不是**实现手法**。
  //   第一版写死了 `blur(`,后来光晕改成预先烘好的小图、不再用 CSS 滤镜 ——
  //   性质没变、还更快,断言却红了。**把手法钉死的断言,会在改进时误报。**
  assert.match(CSS, /\.sky-galaxy\{[\s\S]{0,400}?mix-blend-mode:\s*screen/, '银河层缺 mix-blend-mode:screen');
  const glow = /\.sky-galaxy\.glow\{([^}]*)\}/.exec(CSS);
  assert.ok(glow, '缺独立的光晕层 .sky-galaxy.glow');
  assert.match(glow[1], /transform:\s*scale\(1\.\d/, '光晕层必须比本体大一圈,光才溢得出来');
  assert.match(CSS, /\.sg-star\{[^}]*drop-shadow/, '星星缺和银河同色系的光晕(锐度不统一会一眼看穿)');
});

test('光晕层用的是预烘小图,不是全尺寸实时模糊', () => {
  // blur(46px) × 780×1170 在软件渲染下一次合成能跑到 45 秒以上(实测截图直接超时),
  // 而低端手机正是这个开源件的目标用户。模糊本来就抹掉细节 —— 缩到 1/5 烘好再放大,
  // 观感一样,代价几乎为零。这条防止有人"顺手"把 filter:blur 加回来。
  const glow = /\.sky-galaxy\.glow\{([^}]*)\}/.exec(CSS)[1];
  assert.ok(!/filter:\s*blur\(/.test(glow), '光晕层不该再挂实时 blur —— 用预烘的 galaxy-glow.webp');
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/assets/galaxy-glow.webp');
  assert.ok(fs.existsSync(p), '预烘光晕图 galaxy-glow.webp 不在');
  assert.ok(fs.statSync(p).size < 40 * 1024, '预烘光晕图应该很小(它是被模糊过的,不需要分辨率)');
});

test('row-reverse 下不许再写 justify-content:flex-end —— 它俩会互相抵消', () => {
  // 真机上暴露过:自己的消息整行贴到了**左边**。
  // `flex-direction:row-reverse` 把主轴翻过来,main-end 因此在左;
  // 再写 `justify-content:flex-end` 就是"推到左边",正好抵消掉 row-reverse 想要的效果。
  // 头像确实到了气泡右侧(所以半对),可整行位置反了。row-reverse 下要靠右得用 flex-start。
  //
  // ★ 这个 bug **只有短消息看得出来** —— 长回复占满 76% 宽度,贴左贴右几乎没差别,
  //   而我自测用的正是长文本。**样本的形状把 bug 藏住了**:不是没验,是验的东西碰不到它。
  const rule = /\.message-row\.me\{([^}]*)\}/.exec(CSS);
  assert.ok(rule, '找不到 .message-row.me');
  const body = rule[1];
  if (/flex-direction:\s*row-reverse/.test(body)) {
    assert.ok(!/justify-content:\s*flex-end/.test(body),
      'row-reverse 配 flex-end 会把整行推到左边 —— 要靠右请用 flex-start');
  }
});

test('底栏全局拆掉之后,不能再给它留着位置', () => {
  // 藏元素和撤空间是两件事。首屏那次就栽过:.sidebar 早就 display:none 了,
  // 可 .main 上给固定底栏预留的 58px padding 没跟着撤,底下白空一块。
  assert.match(CSS, /(^|\n)\.sidebar\{display:none\}/, '底栏应当全局隐藏(需求方拍的 A 案)');
  const mainPads = [...CSS.matchAll(/\.main\{[^}]*padding-bottom:\s*([^;}]+)/g)].map((m) => m[1].trim());
  const reserving = mainPads.filter((v) => !/^0$/.test(v));
  assert.deepEqual(reserving, [], `底栏没了却还留着位置:${reserving.join(' / ')}`);
});
