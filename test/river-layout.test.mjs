// 首屏入口的**参数化**验收。
//
// 起因是一句产品侧的问题:「我们这个 UI 给别人用了,要是要加功能的话这个首屏怎么改呢」。
// 老做法是把五颗星的 x/y 照着素材一颗颗量成像素常量 —— 换素材要全部重量,
// 加一个入口也要全部重量。对开源件来说,那等于在首屏贴了张「此处不许改」的封条。
//
// ★ 这份测试最要紧的一条是:**加第六个入口时,原来五个的位置必须变**。
//   位置不变就说明 t 根本没参与计算 —— 参数化是假的,只是把常量换了个地方放。
//   这正是「断言卡在别人也满足的条件上就永远不会红」的反面:
//   要断言的是**这套机制独有的后果**,不是「渲染没崩」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RIVER, T_START, T_END, MAX_GATES, VISIBLE, ASPECT,
  riverAt, spreadT, layoutGates, splitGates, maxOffsetOn, textRoomFor,
} from '../public/js/river.js';

const G = (n) => Array.from({ length: n }, (_, i) => ({
  tab: `t${i}`, title: `入口${i}`, side: i % 2 ? 'left' : 'right', size: 10,
}));
const xs = (list) => layoutGates(list).map((g) => Number(g.x.toFixed(3)));
const ys = (list) => layoutGates(list).map((g) => Number(g.y.toFixed(3)));

test('加第六个入口,原来五个必须全部挪位(位置不变 = 参数化是假的)', () => {
  const five = ys(G(5));
  const six = ys(G(6)).slice(0, 5);
  assert.equal(five.length, 5);
  for (let i = 1; i < 5; i++) {   // 第 0 个锚在 T_START,本来就不动,从第 1 个起比
    assert.notEqual(five[i], six[i], `第 ${i} 个入口在加了第六个之后没动 —— t 没参与计算`);
  }
});

test('删掉中间一个,剩下的重新等距', () => {
  const four = layoutGates(G(4)).map((g) => g.t);
  const gaps = four.slice(1).map((t, i) => +(t - four[i]).toFixed(6));
  assert.equal(new Set(gaps).size, 1, `间距不均匀:${gaps.join(', ')}`);
  assert.equal(+four[0].toFixed(6), +T_START.toFixed(6));
  assert.equal(+four[3].toFixed(6), +T_END.toFixed(6));
});

test('改路径,星星跟着走', () => {
  // ★ 第一版这条断言写的是「动一个控制点,至少两颗星要动」—— 结果只动了 1 颗,
  //   而**算术上就该是 1 颗**:五个入口的 t 是 0.26/0.4375/0.615/0.7925/0.97,
  //   我推的是 t=0.50 那个点,只影响 (0.40,0.60) 这一段,里面只坐着一颗。
  //   门槛是我拍的,不是推出来的 —— 于是测试红了,红的却是断言本身。
  //   要验的性质是「路径变了星星就跟着变」,那就**整条路径平移**,断言全部都动。
  const before = xs(G(5));
  const saved = RIVER.map((p) => p.slice());
  RIVER.forEach((p) => { p[1] = Math.min(1, p[1] + 0.05); });
  const after = xs(G(5));
  RIVER.forEach((p, i) => p.splice(0, 4, ...saved[i]));
  const moved = before.filter((v, i) => v !== after[i]).length;
  assert.equal(moved, 5, `整条河右移之后只有 ${moved}/5 颗跟着动`);
  assert.deepEqual(xs(G(5)), before, '还原之后应当回到原值');
});

test('只动一个控制点,只有坐在那一段上的星星会动(别的不许乱跑)', () => {
  // 反面:局部改动不能有全局副作用,否则说明插值把不相干的段也搅进来了。
  const before = xs(G(5));
  const saved = RIVER[5].slice();
  RIVER[5][1] += 0.2;
  const after = xs(G(5));
  RIVER[5].splice(0, 4, ...saved);
  const movedIdx = before.map((v, i) => (v !== after[i] ? i : -1)).filter((i) => i >= 0);
  assert.ok(movedIdx.length >= 1, '推了控制点却一颗没动');
  for (const i of movedIdx) {
    const t = spreadT(5, i);
    assert.ok(t > RIVER[4][0] && t < RIVER[6][0],
      `第 ${i} 颗(t=${t.toFixed(3)})不在被改的那一段里,却动了 —— 插值有全局串扰`);
  }
});

// 「让位」规则的验收。原来这条是**无条件**的「星星永不进河道」;现在放宽成
// 「放得下就不进,放不下宁可贴近河也要让文字留在屏内」。
//
// ★ 收窄一条不变式的时候,最怕的是把判据也一起放软(变成"反正有理由就行")。
//   所以这里不按"文案长不长"分,而是问一个**能算出来的**问题:
//   当时到底存不存在一个「不骑河 + 文字在屏内」的位置?
//     存在 → 必须选它,一次都不许降级
//     不存在 → 降级可以,但必须真的换到"文字在屏内",而且不许翻到河对岸
//   ★ 一开始我按"短文案不许降级"写,当场被 入口4 打脸:它在 t=0.94,河最宽(half .141),
//     文字只允许 cap .117 —— **短文案也放不下**。"文案长短"根本不是那个判据。
const geom = (g) => {
  const p = riverAt(g.t);
  const starHalf = (Number(g.size) || 0) / 100 / ASPECT / 2;
  const room = textRoomFor(g);
  const best = Math.max(maxOffsetOn('left', p.x, starHalf, room), maxOffsetOn('right', p.x, starHalf, room));
  return { p, starHalf, room, best, off: Math.abs(g.x / 100 - p.x) };
};

test('放得下就不许骑河 —— 存在合法位置时,一次都不许降级', () => {
  for (const list of [G(5), G(3), G(6)]) {
    for (const g of layoutGates(list)) {
      const { p, best, off } = geom(g);
      if (best >= p.half) {
        assert.ok(off >= p.half - 1e-9,
          `${g.title} 本来有不骑河的位置(cap ${best.toFixed(3)} ≥ 半宽 ${p.half.toFixed(3)}),却降级到 ${off.toFixed(3)}`);
      }
    }
  }
});

test('放不下时才降级,而且必须真换到「文字在屏内 + 不翻到河对岸」', () => {
  // 用户把 AI 名字起得很长 —— 真实触发路径是设置页打字,不是改代码
  const long = G(5).map((g, i) => (i === 0 ? { ...g, hintText: '与 我家那位会写代码的小助手 畅聊' } : g));
  let degraded = 0;
  for (const list of [G(5), long]) {
    for (const g of layoutGates(list)) {
      const { p, starHalf, room, best, off } = geom(g);
      if (best >= p.half) continue;          // 没降级,上一条测试管
      degraded++;
      const x = g.x / 100;
      assert.ok(g.side === 'left' ? x < p.x : x > p.x,
        `${g.title} 为了救文字被推到了河对岸 —— 这不是让位,是换了个更坏的毛病`);
      // ★ 这里**不再自己算文字边缘**。上一版我在测试里照抄了一遍
      //   `x ± starHalf*2 ± room`,然后生产代码把 `starHalf*2` 修成
      //   `starHalf + 缝` —— 测试立刻报"文字还在屏外",而真实渲染是好的:
      //   **红的是我抄的那份副本,不是被测的东西。**
      //   所以问同一个函数:降级之后的偏移,不许超过"文字还在屏内"允许的最大偏移。
      const cap = maxOffsetOn(g.side, p.x, starHalf, room);
      if (cap > 0) {   // cap ≤ 0 = 文字比整屏还宽,交给 CSS 的 max-width + 省略号
        assert.ok(off <= cap + 1e-9,
          `${g.title} 降了级却没换到东西:偏移 ${off.toFixed(3)} 超过了"文字还在屏内"的上限 ${cap.toFixed(3)}`);
      }
    }
  }
  // ★ 断言"确实发生过降级"。否则上面整个循环可能一次都没进,
  //   而一个从没执行过的检查和没有检查是一回事。
  assert.ok(degraded > 0, '没有任何一颗走到降级分支 —— 这条测试根本没验到东西');
});

test('最终落点必须落在它自己声明/回退的那一侧', () => {
  // 注意断言的是 **g.side**(算完之后的),不是入参里那个"想要的侧"——
  // 空间不够时会翻面,那是设计好的行为。要保证的是「算出来的侧」和「落点」自洽。
  const laid = layoutGates([
    { tab: 'a', title: '左', hintText: '短', side: 'left', size: 10 },
    { tab: 'b', title: '右', hintText: '短', side: 'right', size: 10 },
  ]);
  for (const g of laid) {
    const p = riverAt(g.t);
    if (g.side === 'left') assert.ok(g.x / 100 < p.x, '算出来是 left,落点却在河右边');
    else assert.ok(g.x / 100 > p.x, '算出来是 right,落点却在河左边');
  }
});

test('偏移会为长副标题主动收窄(而不是硬顶出去)', () => {
  // ★ 「偏移可伸缩」的验收:同一个位置,副标题越长,星星应当**离河越近**
  //   —— 把外面的空间让给文字,而不是把文字顶出屏幕。
  const mk = (hint) => layoutGates([{ tab: 'x', title: '设置', hintText: hint, side: 'right', size: 14.5 }])[0];
  // ★ 比的是**离河心的偏移**,不是原始 x:副标题一长可能会翻面,
  //   翻面之后 x 会跳到河的另一边,拿 x 直接比会得出"往外跑了"的错误结论。
  const off = (g) => Math.abs(g.x / 100 - riverAt(g.t).x);
  const short = mk('短');
  const long = mk('名字 · 主题 · 头像');
  assert.ok(off(long) <= off(short) + 1e-9,
    `副标题变长了,星星却没往里收(偏移 ${off(short).toFixed(3)} → ${off(long).toFixed(3)})`);

  // ★ 但几何层不是万能的:副标题长到离谱时它也放不下 ——
  //   那一层由 CSS 的 max-width + 省略号兜底(见 styles.css 的 .sg-text)。
  //   这里如实记下边界,不假装几何层能解决一切。
  const absurd = mk('名字 · 主题 · 头像 · 还有很长很长很长很长的一串说明');
  assert.ok(Number.isFinite(absurd.x), '极端文案不该算出 NaN');
});

test('再挤也不许骑到河心上', () => {
  const laid = layoutGates([
    { tab: 'x', title: '很长的标题占很多地方', hintText: '副标题也很长很长很长很长很长', side: 'right', size: 14.5 },
  ]);
  const g = laid[0]; const p = riverAt(g.t);
  assert.ok(Math.abs(g.x / 100 - p.x) >= p.half * 0.5,
    '被挤得骑到河中间去了 —— 偏移可以收,但有下限');
});

test('路径本身是合法的:t 单调、坐标都在 0–1 内', () => {
  for (let i = 1; i < RIVER.length; i++) {
    assert.ok(RIVER[i][0] > RIVER[i - 1][0], `第 ${i} 个采样点的 t 没有递增`);
  }
  for (const [t, x, y, half] of RIVER) {
    for (const [name, v] of [['t', t], ['x', x], ['y', y], ['half', half]]) {
      assert.ok(v >= 0 && v <= 1, `${name}=${v} 越界(必须归一化到 0–1)`);
    }
  }
  assert.equal(RIVER[0][0], 0);
  assert.equal(RIVER[RIVER.length - 1][0], 1);
});

test('riverAt 边界不炸,且落在采样点上时取到该点', () => {
  for (const bad of [-1, 0, 1, 2, NaN, undefined, null, '0.5']) {
    const p = riverAt(bad);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.half), `riverAt(${bad}) 出了 NaN`);
  }
  const p = riverAt(RIVER[3][0]);
  assert.equal(+p.x.toFixed(6), +RIVER[3][1].toFixed(6));
});

test('门厅有上限 —— 挂太多会变成一串糖葫芦', () => {
  // 上限本身不拦人加功能,它拦的是「往河上无限插星星」这种加法。
  // 超出的入口应当收进各自页面内部,而不是继续挂在门厅上。
  assert.ok(MAX_GATES >= 3 && MAX_GATES <= 8, `MAX_GATES=${MAX_GATES} 不像一个门厅该有的数`);
});

test('入口数为 1 或 0 时不出 NaN', () => {
  assert.deepEqual(layoutGates([]), []);
  const one = layoutGates(G(1));
  assert.equal(one.length, 1);
  assert.ok(Number.isFinite(one[0].x) && Number.isFinite(one[0].y));
  assert.ok(one[0].t > T_START && one[0].t < T_END, '只有一个入口时应当摆在中间');
});

test('超出上限的入口不许静默消失', () => {
  // ★ 早先是 `GATES.slice(0, MAX_GATES)`:第七个入口**无声蒸发** ——
  //   fork 的人加了功能、首屏没变化、控制台一片安静。
  //   这是今天反复咬人的同一个形状:**沉默被当成了成功**。
  const gates = Array.from({ length: MAX_GATES + 2 }, (_, i) => ({ tab: `t${i}`, title: `入口${i}` }));
  const { onRiver, overflow } = splitGates(gates);
  assert.equal(onRiver.length, MAX_GATES, '河上应当正好挂满上限');
  assert.equal(overflow.length, 2, '多出来的必须**返回**,不能丢');
  // 一个都不能少:上河的 + 溢出的 = 原始全集
  assert.deepEqual([...onRiver, ...overflow].map((g) => g.tab), gates.map((g) => g.tab));
});

test('没超限时不发警告(闸门不许平时就吵)', () => {
  // 一个总在报警的闸门等于关掉的闸门 —— 今天在脱敏扫描器上刚吃过这个亏。
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    splitGates(Array.from({ length: MAX_GATES }, (_, i) => ({ tab: `t${i}`, title: `入口${i}` })));
  } finally { console.warn = orig; }
  assert.deepEqual(seen, [], `没超限却发了警告:${seen.join(' / ')}`);
});

test('超限时警告要点名是哪几个(只说"有溢出"等于没说)', () => {
  const seen = [];
  const orig = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    splitGates(Array.from({ length: MAX_GATES + 1 }, (_, i) => ({ tab: `t${i}`, title: `入口${i}` })));
  } finally { console.warn = orig; }
  assert.equal(seen.length, 1, '超限应当正好警告一次');
  assert.match(seen[0], new RegExp(`入口${MAX_GATES}`), '警告里要出现被挤下来的那个入口的名字');
});
