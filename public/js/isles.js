// 不依赖背景图的落点表 —— 浮岛主题 + 暖深色/奶油白的极简首屏共用。
//
// ★ 为什么不复用 river.js:那套的落点是**从银河素材的像素里量出来的**
//   (RIVER 表逐行取最亮股的重心)。浮岛主题没有那条河 ——
//   照抄一条看不见的河去摆岛,坐标就成了没有来源的魔法数字。
//   需求方自己在设计稿上写的是「**不固定位置,自由排布**」,
//   所以这里是一张**声明式的构图表**,不是从图里反推的。
//
// ★ 和 river.js 共享的契约:入参入出都是同一形状
//   ({tab,title,hintText,side,size} → {..., side, x, y}，x/y 是**百分数**)，
//   于是 home-view 那层不需要知道自己在用哪套几何。
//
// ★★ 和 river.js 关键的一处**不同**,不是风格差异是真 bug 的来源:
//    river.js 算星星半宽用的是 `size/100/ASPECT/2`,那**隐含假设图标是正方形**
//    —— 五张徽章确实都是 384×384。浮岛精灵不是:
//        group 340×231(1.47:1 横) · private 226×340(0.66:1 竖)
//    照抄那个公式,横岛的宽度会被算小 45%,右侧那几座直接出屏而判定说"没事"。
//    所以这里每个入口自带 `ratio`(图的 宽/高),半宽由它算。

// 容器宽高比(= .sky-gates 的 aspect-ratio 900/1600)。size 是「占容器**高**的百分比」,
// 换算成「占容器宽的百分比」要除以它。
const ASPECT = 900 / 1600;

// 可见区间:容器比视口宽,左右各被裁掉一截。取最狠那档(360×800 每侧裁 10%)。
// ★ 这个数是算出来的不是拍的:容器宽 = 视口高 × 0.5625,
//   360×800 → 450 宽,比视口宽 90,每侧 45 → 45/450 = 10%。
const VISIBLE = [0.10, 0.90];

// 文字块最宽能占容器宽的多少。★★ 必须和 styles.css `.sg-text{max-width:38vw}` 同源。
const MAX_TEXT_ROOM = 0.38;
const REF_W = 450;
const STAR_TEXT_GAP = 0.012;

// 构图表。x/y 是**百分数**(0–100),side 决定文字朝哪边展开。
//
// ★ 依据是需求方 8/11 的界面稿:岛左右交错、从 Hero 底下一路排到屏底,
//   文字一律朝**屏幕中心**展开(朝外会被裁)。
// ★ y 值之间可以靠得比"岛高之和"更近 —— 相邻两座在**相反的 x 上**,
//   竖直方向允许交叠,那正是交错排布的意义。是否真的不打架由落点自测量,不靠眼睛。
const SPOTS = [
  { x: 66, y: 34, side: 'left'  },
  { x: 32, y: 47, side: 'right' },
  { x: 68, y: 58, side: 'left'  },
  { x: 31, y: 70, side: 'right' },
  // ★ 81 → 77:81% 时它和「更多」在 320×568 上压到一起。
  //   这个数不是我调出来的手感,是拿四档设备的盒子跑参数搜索解出来的(见 island-layout 测试)。
  { x: 67, y: 79, side: 'left'  },
];

// 「更多」单独一格:排在最底、文字在正下方(左右都会长进邻居那一组)。
// ★ 三个数都是解出来的,不是调出来的:
//   y 91 → 88 → 82:91% 时岛底 + 下方标签整块出屏底(CDP 截图上「更多」只剩上半截),
//     88% 在 320×568 上仍越界 3.6px —— 那一版的测试**是红的**,不是我看图看出来的。
//   x 33 → 38、size 14 → 11:和「设置」那座错开。
//   ⇒ 这组值来自一次四档设备的参数搜索:约束 = 不出屏 + 岛不压岛 + 标签不压标签。
//   ★ 「标签压在岛上」**不在约束里** —— 需求方的界面稿上本来就是白药丸压着岛边。
//     我第一版把它当硬规矩,768 组配置全军覆没,毙掉它们的是我发明的规矩。
const MORE_SPOT = { x: 38, y: 82, size: 11, side: 'below' };

// 入口数和构图表对不上时怎么办 —— **绝不静默截断**。
// 少于 5 个:取前 n 个格位(构图仍然成立,只是稀一点)。
// 多于 5 个:多出来的按等距塞进 34%–81% 之间,左右继续交错。
//   ★ 这条是给 fork 的人留的:他加第六个入口时首屏不会"看起来没反应"。
function spotFor(i, n) {
  if (i < SPOTS.length) return SPOTS[i];
  const lo = SPOTS[0].y, hi = SPOTS[SPOTS.length - 1].y;
  const k = n <= 1 ? 0 : i / (n - 1);
  return { x: i % 2 ? 32 : 67, y: lo + (hi - lo) * k, side: i % 2 ? 'right' : 'left' };
}

function textRoomFor(g) {
  const want = Math.max(String(g.title || '').length * 15, String(g.hintText || '').length * 11) / REF_W;
  return Math.min(want, MAX_TEXT_ROOM);
}

// 在某一侧,精灵中心能站的最外位置(再往外文字就出界)。
function maxOffsetOn(side, center, halfW, textRoom) {
  const reserve = halfW + STAR_TEXT_GAP + textRoom;
  return side === 'right' ? (VISIBLE[1] - reserve) - center : center - (VISIBLE[0] + reserve);
}

// 精灵半宽,单位是「容器宽的比例」。
// size(占容器高 %) → 高度比例 → 乘图的宽高比 → 得宽度比例 → 再除以容器宽高比。
function halfWidthOf(g) {
  const h = (Number(g.size) || 0) / 100;          // 占容器高
  // ★★ 这里是 **÷ASPECT**。我第一版写成 ×,把岛宽算小了 3.16 倍(0.5625²)——
  //   后果不是"报错",是 clamp 和翻边判定**该介入时不介入**,岛悄悄站到屏外。
  //   ⚠️ 它没被 island-layout 那条测试放过,**恰恰因为那条测试没抄这个公式**
  //     (它自己从 hPx×ratio 算真实像素)。两条独立路径对不上,才逮得到。
  //   容器宽 = 容器高 × 0.5625 ⇒ 同一个长度,占宽的比例 = 占高的比例 ÷ 0.5625。
  const w = h * (Number(g.ratio) || 1) / ASPECT;
  return w / 2;
}

function layoutIsles(gates) {
  const list = Array.isArray(gates) ? gates : [];
  const n = list.length;
  return list.map((g, i) => {
    const spot = g.spot || spotFor(i, n);
    const halfW = halfWidthOf(g);
    const room = textRoomFor(g);
    const want = spot.side;

    // 文字塞不下就翻到另一侧;两侧都塞不下保持首选,交给 CSS 的省略号收尾。
    // 'below' 不翻 —— 它本来就不朝左右展开。
    let side = want;
    if (want !== 'below') {
      const other = want === 'left' ? 'right' : 'left';
      if (maxOffsetOn(want, spot.x / 100, halfW, room) < 0
        && maxOffsetOn(other, spot.x / 100, halfW, room) >= 0) side = other;
    }

    // ★ 精灵整体必须留在可见区里。这条 clamp 不是可选的:
    //   构图表是照设计稿写的,而设计稿不知道容器会被裁掉两侧。
    const lo = VISIBLE[0] + halfW, hi = VISIBLE[1] - halfW;
    const x = lo > hi ? (VISIBLE[0] + VISIBLE[1]) / 2 : Math.min(hi, Math.max(lo, spot.x / 100));
    return { ...g, side, x: x * 100, y: spot.y };
  });
}

export { SPOTS, MORE_SPOT, VISIBLE, ASPECT, MAX_TEXT_ROOM, layoutIsles, halfWidthOf, maxOffsetOn, textRoomFor, spotFor };
