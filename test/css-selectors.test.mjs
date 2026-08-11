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
import { ASPECT } from '../public/js/river.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/styles.css'), 'utf8');

// 每一条都对应「没了就有一整块界面变成裸 HTML」的地方。
// 加新界面时把它的根选择器加进来 —— 这份清单的价值全在于它被维护。
const REQUIRED = [
  '.home-view', '.home-stage', '.home-hero', '.home-sky', '.sky-inner', '.sky-galaxy',
  '.sky-gates', '.sky-gate', '.sky-dipper', '.sg-star', '.sg-text', '.sg-title', '.home-recent',
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

test('银河盒子和入口层必须同比,且和 river.js 里的 ASPECT 对得上', () => {
  // 星星的 --x/--y 是按容器比例算的。.sky-inner(画图的)和 .sky-gates(摆星星的)
  // 必须是**同一个几何盒子**,任何一方比例变了,星星就从带子上滑下来。
  //
  // ★ 断言不再写死 2:3 —— 换素材时那是个必然会红的假警报。
  //   改成拿 CSS 的比例去和 **river.js 导出的 ASPECT** 对账:
  //   要红就红在"两边不一致"上,而不是"跟我记忆里的数不一样"。
  const ratios = ['.sky-inner', '.sky-gates'].map((sel) => {
    const m = /aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/.exec(ruleFor(sel));
    assert.ok(m, `${sel} 上找不到 aspect-ratio`);
    return Number(m[1]) / Number(m[2]);
  });
  assert.ok(Math.abs(ratios[0] - ratios[1]) < 1e-6, `画图的盒子和摆星星的盒子比例不一致:${ratios}`);
  assert.ok(Math.abs(ratios[0] - ASPECT) < 1e-6,
    `CSS 比例 ${ratios[0].toFixed(4)} 与 river.js 的 ASPECT ${ASPECT.toFixed(4)} 不一致 —— 换素材时两边要一起改`);
  assert.ok(!/\.sky-galaxy\{[^}]*object-fit:\s*cover/.test(CSS), '银河图不能用 object-fit:cover:裁切会让星星偏离');
});

test('第一屏是整整一屏 —— 不是「填满剩下的空间」', () => {
  // flex:1 会被下面的「最近记忆」挤扁(实测只剩 662/844),银河铺不到底、
  // 第一颗星还会撞上 Hero 文字。这条钉住「恰好一屏」。
  assert.match(ruleFor('.home-stage'), /flex:\s*0\s+0\s+100dvh/, '.home-stage 必须固定成一屏高');
});

test('首屏只有一层 —— 融合技巧全部撤掉', () => {
  // 「背景/星河/星星像三个图层」的根治办法不是把三层调得像一层,
  // 而是让它**真的只有一层**:定稿素材把银河和夜空画进了同一张图。
  //
  // ★ 所以这条断言从"必须有 screen 混合 + 光晕副本"**反了过来**:现在它们不该存在。
  //   闸门跟着设计走是应该的 —— 但要跟着**当前**的设计走,
  //   留着上一版的判据就会像刚才那样,在正确的改动上报假警。
  assert.ok(!/mix-blend-mode/.test(CSS), '只有一层了,不该再有混合模式');
  assert.ok(!/\.sky-galaxy\.glow/.test(CSS), '光晕副本层应当已删除');
  assert.ok(!/\.sky-dust/.test(CSS), 'CSS 星尘层应当已删除(素材自带背景星点)');
  // 星星仍要和素材共享光源,只是颜色换成了从新素材采出来的紫/粉
  assert.match(CSS, /\.sg-star\{[^}]*drop-shadow/, '星星缺光晕');
});

test('星星背后不许垫暗晕', () => {
  // 评审原话:落在河亮部被淹要靠**落点算法**解决,不能靠在背后糊黑布 ——
  // 糊黑布会把刚做出来的通透感又抹掉。可读性用描边式 text-shadow。
  const t = /body\[data-theme="starry"\] \.sg-text\{([^}]*)\}/.exec(CSS);
  assert.ok(t, '找不到 starry 下的 .sg-text 规则');
  assert.ok(!/background/.test(t[1]), '.sg-text 背后又垫上底色了');
  assert.match(t[1], /text-shadow/, '去掉暗斑之后要用 text-shadow 保住可读性');
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
