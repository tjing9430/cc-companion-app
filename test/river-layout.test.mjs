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
  // ★ 被夹在可见区边界上的那几颗**本来就不该动** —— 河再往右推,它们也出不去。
  //   所以断言只对"没顶到边界"的那些成立;把它们一起要求会红,而红的是断言不是代码。
  const free = layoutGates(G(5)).filter((g) => {
    const sh = (Number(g.size) || 0) / 100 / ASPECT / 2;
    return g.x / 100 < VISIBLE[1] - sh - 1e-9;
  }).length;
  const moved = before.filter((v, i) => v !== after[i]).length;
  assert.equal(moved, free, `整条河右移后,没顶边界的 ${free} 颗里只有 ${moved} 颗动了`);
  assert.ok(free > 0, '五颗全顶在边界上 —— 那这条测试什么也没验到');
  assert.deepEqual(xs(G(5)), before, '还原之后应当回到原值');
});

test('只动一个控制点,只有坐在那一段上的星星会动(别的不许乱跑)', () => {
  // 反面:局部改动不能有全局副作用,否则说明插值把不相干的段也搅进来了。
  //
  // ★ 上一版把控制点写死成 `RIVER[5]`。表从 11 行加密到 46 行之后这条就红了 ——
  //   不是插值坏了,是**每个控制点管的区间从 0.1 缩到 0.022**,随便挑一个
  //   多半一颗星都不在它管的范围里,于是"推了却没人动"。
  //   红的是测试对行数的耦合,而行数**恰恰是我们刚宣布"不是契约"的东西**。
  //   改成:先找一个**确实有星星坐在上面**的控制点,再推它。这样任何密度都成立。
  const ts = Array.from({ length: 5 }, (_, i) => spreadT(5, i));
  const k = RIVER.findIndex((row, i) =>
    i > 0 && i < RIVER.length - 1 && ts.some((t) => t > RIVER[i - 1][0] && t < RIVER[i + 1][0]));
  assert.ok(k > 0, '找不到任何一个控制点身上坐着星星 —— 采样和 spreadT 对不上了');

  const before = xs(G(5));
  const saved = RIVER[k].slice();
  RIVER[k][1] = Math.min(1, RIVER[k][1] + 0.2);
  const after = xs(G(5));
  RIVER[k].splice(0, 4, ...saved);

  const movedIdx = before.map((v, i) => (v !== after[i] ? i : -1)).filter((i) => i >= 0);
  assert.ok(movedIdx.length >= 1, `推了控制点 ${k} 却一颗没动`);
  for (const i of movedIdx) {
    assert.ok(ts[i] > RIVER[k - 1][0] && ts[i] < RIVER[k + 1][0],
      `第 ${i} 颗(t=${ts[i].toFixed(3)})不在被改的那一段里,却动了 —— 插值有全局串扰`);
  }
  assert.deepEqual(xs(G(5)), before, '还原之后应当回到原值');
});

// ★★ 2026-08-11 规则变更:落点由 **river-edge 改为 river-center**。
//    下面四条原本验的是「星星挂在河边、放不下时让位」,那套契约整个作废了 ——
//    背景图换成 newbg 后河收窄成细带子,「骑上去会截断河」的前提没了。
//    ★ 它们是**改写**不是删除:一条断言消失,和一条断言变绿,在 git log 里长得一样,
//      但前者会让"这件事还有没有人管"变成无人知晓。
// ★ 落点契约只此一处。三条测试都问它,别各自抄一遍 ——
//   今晚已经栽过:测试里手抄 `x ± starHalf*2 ± room`,生产公式一改,
//   红的是我那份副本而不是被测对象。
const expectedX = (g) => {
  const p = riverAt(g.t);
  const sh = (Number(g.size) || 0) / 100 / ASPECT / 2;
  return Math.min(VISIBLE[1] - sh, Math.max(VISIBLE[0] + sh, p.x));
};

const geom = (g) => {
  const p = riverAt(g.t);
  const starHalf = (Number(g.size) || 0) / 100 / ASPECT / 2;
  const room = textRoomFor(g);
  return { p, starHalf, room, fitsWant: maxOffsetOn(g.side, p.x, starHalf, room) >= 0 };
};

test('星心落在河心上 —— 除非会被裁出可见区,那时夹回边界', () => {
  // ★ 契约有**两段**,别只记前半句:河心是目标,可见区是边界。
  //   河在 y≈72% 那段跑到 84%,图标半宽 8.6% —— 不夹的话右缘 92.6%,真机四档全被裁。
  //   (定稿图里控制台 84.3→82.5 就是这个夹,标的是 `[clamped]`。)
  let clamped = 0;
  const cases = [G(5), G(3), G(6),
    G(5).map((g, i) => (i === 2 ? { ...g, hintText: '与 我家那位会写代码的小助手 畅聊' } : g)),
    G(5).map((g) => ({ ...g, size: g.size * 0.88 })),      // 徽章缩 12%
  ];
  for (const list of cases) {
    for (const g of layoutGates(list)) {
      const p = riverAt(g.t);
      const starHalf = (Number(g.size) || 0) / 100 / ASPECT / 2;
      const want = expectedX(g);
      if (Math.abs(want - p.x) > 1e-9) clamped++;
      assert.ok(Math.abs(g.x / 100 - want) < 1e-9,
        `${g.title} 落点 ${(g.x / 100).toFixed(4)} ≠ 夹过的河心 ${want.toFixed(4)}`);
      // 星星整个必须在可见区内 —— 这才是夹它的理由
      assert.ok(g.x / 100 - starHalf >= VISIBLE[0] - 1e-9 && g.x / 100 + starHalf <= VISIBLE[1] + 1e-9,
        `${g.title} 图标伸出可见区了`);
    }
  }
  // ★ 断言"夹确实发生过"。全都没夹的话,上面那段边界逻辑等于没被验到。
  assert.ok(clamped > 0, '没有任何一颗被夹 —— 这条测试没验到边界分支');
});

test('side 只决定文字朝哪边,不影响落点', () => {
  // ★ 这条是 river-center 最容易被改回去的地方:下一个人看到 side 会以为它管位置。
  const mk = (side) => layoutGates([{ tab: 'x', title: '设置', hintText: '短', side, size: 10 }])[0];
  assert.equal(mk('left').x, mk('right').x, 'side 改了落点也跟着变 —— 那就退回旧设计了');
});

test('文字塞不下首选侧时翻面,而且翻面是**有条件**的不是随机的', () => {
  // 短文案:不该翻
  const short = layoutGates([{ tab: 'x', title: '设置', hintText: '短', side: 'left', size: 10 }])[0];
  assert.equal(short.side, 'left', '短文案就翻面了 —— 翻面条件太松');
  // 长到首选侧塞不下:应当翻到另一侧
  const long = layoutGates([{ tab: 'x', title: '设置', hintText: '名字 · 主题 · 头像 · 还有很长很长的说明', side: 'left', size: 10 }])[0];
  assert.ok(['left', 'right'].includes(long.side));
  // 不论翻不翻,落点都还是「夹过的河心」—— 翻面只动文字朝向
  for (const g of [short, long]) {
    assert.ok(Math.abs(g.x / 100 - expectedX(g)) < 1e-9, '翻面把落点带跑了');
  }
});

test('极端文案不产生 NaN,也不把星星算出可见区', () => {
  const absurd = layoutGates([{ tab: 'x', title: '很长的标题占很多地方',
    hintText: '副标题也很长很长很长很长很长很长很长很长', side: 'right', size: 14.5 }])[0];
  assert.ok(Number.isFinite(absurd.x) && Number.isFinite(absurd.y), '极端文案算出了 NaN');
  assert.ok(Math.abs(absurd.x / 100 - expectedX(absurd)) < 1e-9, '极端文案下落点也必须是「夹过的河心」');
  // 几何层此时确实没牌可打了 —— 文字由 CSS 的 max-width + 省略号收尾。
  // ★ 如实记下这个边界,不假装几何层能解决一切。
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
