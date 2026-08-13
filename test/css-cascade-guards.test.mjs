// 两条**只在样式表里成立、但没有任何东西守着**的隐含依赖。
//
// 它们的共同点:改坏了以后**没有任何报错**,页面照常渲染,只是某个兜底静默失效。
// 评审那句是判据:「注释挡不住它 —— 让它会红。」
//
// ★★ 这份测试特意用「**最后一条生效的声明**」而不是「有没有写过这条声明」。
//    原因是今天刚栽的一次:我在 `@media (max-width:400px)` 里写了 `padding:0`,
//    而 `@media (max-width:1100px)` 里的 `padding:.25rem .55rem` 在**它下面** ——
//    **CSS 层叠按源码顺序,不按媒体查询谁更窄。** 那条更宽的把更窄的顶掉了,
//    本该 10×10 的圆点变成 18.7×10 的椭圆。
//    ⇒ 只检查"写过没有"的测试,对这种覆盖是**瞎的**,而覆盖恰恰是最常见的改法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(path.join(root, 'public/styles.css'), 'utf8');

// 把样式表拆成 { selectors[], body, at } 的规则序列。
// ★ 不用一条大正则去套 —— 第一版就是那么写的,`.sky-gate` 前面是换行(不是 `{`/`,`/`}`)就匹配不上,
//   四条测试全红,而**红的原因是我的解析器,不是被测的样式**。
//   规则块必须真的走一遍花括号深度,`@media` 才不会把它带偏。
function rules() {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');   // 先去注释,否则注释里的花括号会算进深度
  const out = [];
  let depth = 0, selStart = 0, bodyStart = -1, sel = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') {
      if (depth === 0) { sel = clean.slice(selStart, i).trim(); bodyStart = i + 1; }
      depth++;
      // @media 之类:进到第二层才是真正的规则,把外层当容器,重置选择器起点
      if (depth === 1 && /^@/.test(sel)) { selStart = i + 1; }
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && bodyStart >= 0 && !/^@/.test(sel)) {
        out.push({ sel, body: clean.slice(bodyStart, i), at: selStart });
      }
      selStart = i + 1; bodyStart = -1;
    }
  }
  // 上面那趟只拿到顶层规则;@media 里面的要再走一遍
  const mediaRe = /@media[^{]*\{/g;
  let m;
  while ((m = mediaRe.exec(clean)) !== null) {
    let d = 1, i = m.index + m[0].length; const inner = i;
    while (i < clean.length && d > 0) { if (clean[i] === '{') d++; else if (clean[i] === '}') d--; i++; }
    const block = clean.slice(inner, i - 1);
    let s2 = 0;
    for (let j = 0; j < block.length; j++) {
      if (block[j] === '{') {
        const k = block.indexOf('}', j);
        out.push({ sel: block.slice(s2, j).trim(), body: block.slice(j + 1, k), at: inner + s2 });
        j = k; s2 = k + 1;
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// 「选择器 sel 上属性 prop 的**最后一条**生效声明」。
// ★ 用「最后一条」而不是「有没有写过」—— 见文件头那段:今天刚被源码顺序坑过一次。
function lastDeclaration(sel, prop) {
  let found = null;
  for (const r of rules()) {
    if (!r.sel.split(',').some((s) => s.trim() === sel)) continue;
    const dre = new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`, 'g');
    let d;
    while ((d = dre.exec(r.body)) !== null) found = { value: d[1].trim(), at: r.at, sel: r.sel };
  }
  return found;
}

test('★ 占位圆的尺寸来源:.sg-star 在**两套布局下都**拿得到确定高度', () => {
  // ⚠️ 第一版我把不变量写成「.sky-gate 必须有确定高度」—— **错的**:
  //    非星空主题下它本来就是 `height:auto`(styles.css 里明写着),
  //    那一档 .sg-star 直接吃 `height:var(--size)`,根本不靠 .sky-gate。
  //    写成那样的话,这条测试会对着一份**完全正确**的样式表报红。
  // ⇒ 真正的不变量是**终点**不是中途:.sg-star 得有确定高度,两条路径各自成立。
  const gate = lastDeclaration('.sky-gate', 'height');
  assert.ok(gate && gate.value !== 'auto', [
    '星空档:.sky-gate 的高度没了或变成 auto。',
    '链条是 .sky-gate 有确定高度 → .sg-star{height:100%} → .sg-star:not(.lit){aspect-ratio} 推出宽度',
    '   → 占位圆才有地方画。断在这儿,占位圆一次都不会出现,**而且没有任何报错**。',
  ].join('\n'));

  const plain = lastDeclaration('body:not([data-theme="starry"]):not([data-theme="island"]) .sg-star', 'height');
  assert.ok(plain && plain.value !== 'auto', [
    '竖列档(暖深色/奶油白):.sg-star 的高度没了或变成 auto。',
    '这一档不经过 .sky-gate(它就是 auto),.sg-star 直接吃 var(--size)。',
    '⚠️ 2026-08-14 选择器由 `:not(starry)` 收紧成 `:not(starry):not(island)` —— 浮岛走绝对定位,不该被压成竖列。',
  ].join('\n'));

  // ★ 第三条路径:浮岛。它和星空一样走绝对定位,**但高度是自己那条 clamp**
  //   (岛比徽章大得多,徽章那档的上限 132px 会把竖岛齐腰砍掉)。
  //   ⚠️ 这条必须单独钉:如果哪天有人把 island 的 .sky-gate 规则删了,
  //     它会**掉回** `.sky-gate` 那条基础规则 —— 高度仍然"有值",测试若只问
  //     「有没有确定高度」会绿,但岛已经被砍矮了。所以这里问的是**它自己那条在不在**。
  const isle = lastDeclaration('body[data-theme="island"] .sky-gate', 'height');
  assert.ok(isle && isle.value !== 'auto',
    '浮岛档:body[data-theme="island"] .sky-gate 的高度规则没了 —— 岛会掉回徽章那档的 132px 上限被砍矮');
  assert.match(isle.value, /clamp\(/, `浮岛的高度应当是 clamp(下限, var(--size), 上限),实际 "${isle.value}"`);
});

test('★ .sg-star:not(.lit) 的兜底宽高比还在(它是占位圆唯一的尺寸来源)', () => {
  const ar = lastDeclaration('.sg-star:not(.lit)', 'aspect-ratio');
  assert.ok(ar, '兜底宽高比没了 —— 图没到的时候 .sg-star 会塌成 0×0,占位圆等于不存在');
  assert.match(ar.value, /^\d+\s*\/\s*\d+$/, `期望一个纯比例,实际 "${ar.value}"`);
});

test('★★ 圆点那块必须**赢下**层叠 —— 判据是"最后生效的 padding 是 0"', () => {
  // ⚠️ 第一版我写的是「圆点块的位置要在 padding 块后面」,结果对着一份正确的样式表报红:
  //    **我自己那块里也写了 `padding:0`**,于是 lastDeclaration 取到的就是它自己,两个位置相等。
  //    ⇒ 拿"谁在前谁在后"当判据,得先保证两边不是同一条声明。
  //      换成直接问结果:**最后生效的那条 padding 是不是 0。** 位置是手段,结果才是不变量。
  const pad = lastDeclaration('.status-pill', 'padding');
  assert.ok(pad, '.status-pill 上找不到 padding —— 圆点那块是不是被删了?');
  assert.equal(pad.value, '0', [
    `最后生效的 padding 是 "${pad.value}",不是 0 —— 圆点会被撑成椭圆。`,
    'CSS 层叠按源码顺序,不按媒体查询谁更窄:',
    '  @media (max-width:1100px) 里的 padding:.25rem .55rem 只要写在圆点块**下面**就会赢,',
    '  哪怕圆点块的 @media 更窄。实测被撑成过 18.7×10(本该 10×10)。',
    '⇒ 圆点那块要留在样式表末尾。',
  ].join('\n'));

  // 同族的第二个:宽度也得是圆点块说了算
  const w = lastDeclaration('.status-pill', 'width');
  assert.equal(w && w.value, '10px', `最后生效的 width 是 "${w && w.value}",期望 10px`);
});

test('★ 状态点按状态上色的规则还在 —— 否则它退回一个不表达任何东西的灰点', () => {
  // 它原来的注释声称"颜色已经把状态说清楚了",而那句曾经是假的(没有任何上色规则)。
  // 这条测试的作用是:**不让那句注释再变回谎话。**
  assert.match(css, /\.status-pill\[data-stream="live"\]/,
    'live 态的上色规则没了 —— 那条「颜色已经把状态说清楚了」的注释会重新变成谎话');
  const app = readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.match(app, /class="status-pill"\s+data-stream=/,
    'DOM 上没有 data-stream —— CSS 就算写了上色规则也无从下手(这正是当初失效的根因)');
});

test('★★ 状态点:live 必须和三个异常态都不同色 —— 圆的绿的但钉死不动,一样答不了用户那句话', () => {
  // ⚠️ 这条测试原来叫「四档四个**互不相同**的颜色」—— **标题在撒谎**。
  //    断言从来就只查「live ≠ 三个异常态」,而 CSS 里 connecting/reconnecting/fallback
  //    **共用同一个琥珀色**(那是有意的:10×10 的点分不出三档琥珀,它只需要回答"现在正常吗")。
  //    ★ 我写这份测试正是为了修一句撒谎的注释,然后在标题上犯了同一件事 ——
  //      **标题也是一种断言,而且它不会被执行,所以没人会发现它不成立。**
  // ⚠️ 这条是评审补的,而我原来那三条**只咬到了一半**:
  //    我验的是「它是不是圆点」(padding/width),没验「它变不变」。
  //    用户原话是「我也不知道那个灰色椭圆是啥」—— **她问的是"这是什么"**,形状她一个字没提。
  //    一个圆的、绿的、但颜色钉死的点,同样答不了她。
  //    ★ 判据要对着**用户那句话**,不是对着我修的那个地方。
  const states = ['live', 'connecting', 'reconnecting', 'fallback'];
  const colours = new Map();
  for (const st of states) {
    const re = new RegExp(`\\.status-pill\\[data-stream="${st}"\\][^{]*\\{([^}]*)\\}`);
    const m = css.match(re);
    assert.ok(m, `${st} 这一档没有上色规则 —— 它会掉回默认灰,和"待连接"分不开`);
    const bg = /background-color\s*:\s*([^;]+)/.exec(m[1]);
    assert.ok(bg, `${st} 的规则里没有 background-color`);
    colours.set(st, bg[1].trim());
  }
  // live 必须和三个异常态都不同 —— 这是这个点唯一要回答的问题:「现在正常吗」
  for (const st of ['connecting', 'reconnecting', 'fallback']) {
    assert.notEqual(colours.get('live'), colours.get(st),
      `live 和 ${st} 是同一个颜色 —— 那这个点就分不出正常和异常`);
  }
  // idle 故意没有规则:它落回 var(--muted) 灰,而灰**只**留给"还没连上"
  assert.doesNotMatch(css, /\.status-pill\[data-stream="idle"\]/,
    'idle 不该有专门的颜色 —— 灰(默认值)就是它的语义,再给一个会让灰失去含义');
});
