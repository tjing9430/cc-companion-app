// 星河的几何:一条归一化路径 + 由它算出入口位置。
//
// ★ 为什么要有这个文件(而不是像以前那样把坐标写死在 GATES 里):
//   以前每颗星的 x/y 都是**照着素材一颗一颗量出来的像素**。这带来两个死结:
//     ① 换一张银河素材 → 五颗星全部要重量一遍
//     ② 加/减一个入口 → 同样要全部重量
//   对一个开源件来说,②等于在首屏上贴了张「此处不许改」的封条 ——
//   fork 的人想加第六个入口,得先学会拿图去量像素。
//
//   现在:河道是一条 0–1 的归一化路径,入口只声明**它在河上走多远(t)**、
//   **挂在哪一侧(side)**、**多大(size)**。坐标由代码算。于是:
//     换素材 → 只换下面这张表;加入口 → 数组里加一项,其余自动重排。
//
// ★ 路径为什么是采样点而不是贝塞尔控制点:这条河是 S 形、会横向折返,
//   用少数几个控制点拟合反而难对齐;采样点表直观、可视化调整容易,
//   而且是**从素材像素里量出来的**(逐行取 alpha×亮度 的最亮股 + 它的边缘),
//   不是手画的。换素材时重跑一次同样的提取即可。

// [t, x, y, half] —— 全部 0–1,x/y 相对**银河容器**(不是视口),half 是该处河道半宽。
// 这张表对应 assets/galaxy-river.webp(900×1600 的 galaxy-d)。换图必换它。
// 提取办法:逐行取亮度剖面 → 找最亮那股 → 以峰值 35% 为界找它的左右边缘。
const RIVER = [
  [0.00, 0.753, 0.060, 0.151],
  [0.10, 0.640, 0.150, 0.093],
  [0.20, 0.800, 0.240, 0.097],
  [0.30, 0.560, 0.330, 0.073],
  [0.40, 0.838, 0.420, 0.110],
  [0.50, 0.720, 0.510, 0.111],
  [0.60, 0.593, 0.600, 0.108],
  [0.70, 0.820, 0.690, 0.167],   // ← half 收过:折返处两股被当成一股量(中位 0.111,上限取 1.5 倍)
  [0.80, 0.860, 0.780, 0.167],   // ←同上
  [0.90, 0.447, 0.870, 0.124],
  [1.00, 0.593, 0.960, 0.167],   // ←同上
];

// 入口只占河的这一段:上面留给 Hero 文字,下面留一点边。
const T_START = 0.32;
const T_END = 0.94;

// ★ 可见区间:银河容器比视口宽,左右会被裁掉一截,**裁多少由最极端的高宽比决定**
//   (手机 CSS 宽度只在 320–430 之间,但高宽比从 1.77 到 2.22;
//    2.22 那档每侧裁 16.2%)。这是设计层的常量,不是运行时视口 ——
//   按最狠那档定,任何手机上都看得见。
// ★ 素材换成 9:16 之后裁得少多了:320×568 几乎不裁,最狠的 2.22 长屏也只裁 10%
//   (上一版 2:3 的图要裁 16.2%)。可见区间因此宽松了,星星摆得开。
const VISIBLE = [0.10, 0.90];
// 容器宽高比(= 素材宽高比)。星星是正方形,所以「占容器高的百分比」换算成
// 「占容器宽的百分比」要除以这个数 —— 图越竖,同样高的星占宽越多。
const ASPECT = 900 / 1600;
// 标题/副标题那一块要占的横向空间(占容器宽的比例)。
// 取的是最长那条(「名字 · 主题 · 头像」≈121px / 533 ≈ 0.23)。
const TEXT_ROOM = 0.23;

// ★ 门厅不是功能索引。挂太多星,整条河会变成一串糖葫芦。
//   超过这个数的入口应该收进各自页面内部,而不是继续往河上插。
const MAX_GATES = 6;

// 沿路径插值。t 落在两个采样点之间时线性混合 —— 采样够密(每 0.1 一个),
// 线性插值和曲线的差别在视觉上看不出来,却省掉一整套曲线求值。
function riverAt(t) {
  const u = Math.min(1, Math.max(0, Number(t) || 0));
  for (let i = 1; i < RIVER.length; i++) {
    const [t0, x0, y0, h0] = RIVER[i - 1];
    const [t1, x1, y1, h1] = RIVER[i];
    if (u <= t1 || i === RIVER.length - 1) {
      const k = t1 === t0 ? 0 : (u - t0) / (t1 - t0);
      return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, half: h0 + (h1 - h0) * k };
    }
  }
  const [, x, y, h] = RIVER[RIVER.length - 1];
  return { x, y, half: h };
}

// 把入口摊在 [T_START, T_END] 上。**这是「加一个入口,其余自动重排」的全部机制** ——
// t 由序号算,不由人填,所以数组一变,每一颗的位置都跟着变。
function spreadT(n, i) {
  if (n <= 0) return T_START;
  if (n === 1) return (T_START + T_END) / 2;
  return T_START + (T_END - T_START) * (i / (n - 1));
}

// 由入口表算出每颗星的落点。
//
// ★ 星星**挂在河边**,不骑在河中间:偏移 = 该处河道半宽 + 半个星宽的 55%
//   （压进去一点点,看起来是贴着河而不是飘在旁边）。
//   这条是评审那句「沿着路走 ≠ 站在路当中」的实现 —— 骑在中间会把河截断。
//
// ★ size 是「占容器高的百分比」;因为容器宽 = 高 × (2/3)、素材也是 2:3,
//   星宽占容器宽的百分比数值上正好也约等于 size,所以半宽用 size/200。
// 文字块要占多宽(占容器宽的比例)。按字数估,不用一个"最长的那条"去卡所有人 ——
// 「名字 · 主题 · 头像」要 0.23,而「珍藏回忆」只要 0.09,一刀切会把本来放得下的挤掉。
// 基准宽度取最紧那档手机的容器宽(533px):标题 ~15px/字、副标题 ~11px/字。
const REF_W = 450;   // 最紧那档手机(360×800)的容器宽 = 800 × 0.5625
function textRoomFor(g) {
  const title = String(g.title || '');
  const hint = String(g.hintText || '');
  return Math.max(title.length * 15, hint.length * 11) / REF_W;
}

// 在某一侧,星心能放的**最外**位置(再往外文字就出界了)。
function maxOffsetOn(side, center, starHalf, textRoom) {
  return side === 'right'
    ? (VISIBLE[1] - textRoom - starHalf * 2) - center
    : center - (VISIBLE[0] + textRoom + starHalf * 2);
}

function layoutGates(gates) {
  const list = Array.isArray(gates) ? gates : [];
  const n = list.length;
  return list.map((g, i) => {
    const t = spreadT(n, i);
    const p = riverAt(t);
    const starHalf = (Number(g.size) || 0) / 100 / ASPECT / 2;   // 见 ASPECT 注释
    const room = textRoomFor(g);
    const want = g.side === 'left' ? 'left' : 'right';

    // 想要的偏移:挂在河边、压进去一点点(「沿着路走 ≠ 站在路当中」)
    const wish = p.half + starHalf * 0.55;
    // ★ 最小偏移 = 河道半宽本身。低于它,星心就落进带子里了 —— 那就是「骑在河上」,
    //   正是这一版要改掉的毛病。所以这里**不能为了塞下文字而破线**:
    //   放不下就换一侧,两侧都放不下就让文字自己收(CSS 的省略号兜底),
    //   而不是把星星挪回河中间。
    //   (上一版这里写的是 half*0.55,能塞下更多文字,但代价是悄悄退回了旧毛病。)
    const floor = p.half;

    // ★ 关键:**偏移是可伸缩的,不是定死的**。空间紧的时候往里收一点,
    //   而不是硬顶出去把文字挤出屏幕。原来写死 wish,于是河道走到屏幕中间那一段
    //   (两侧都留不出文字位置)就必然溢出 —— 我一开始想靠"翻面"救,
    //   可两侧同样窄的时候翻面救不了,能救的只有"少推一点"。
    const pick = (side) => {
      const cap = maxOffsetOn(side, p.x, starHalf, room);
      if (cap < floor) return null;                       // 这一侧连最小偏移都放不下
      const off = Math.min(wish, cap);
      const dir = side === 'left' ? -1 : 1;
      return { side, x: p.x + dir * off, slack: cap - off };
    };

    // 首选侧放得下就用首选侧;放不下再翻面;都不行取"挤得少"的那边兜底。
    const a = pick(want);
    const b = pick(want === 'left' ? 'right' : 'left');
    const chosen = a || b || {
      side: want,
      x: Math.min(VISIBLE[1] - starHalf, Math.max(VISIBLE[0] + starHalf, p.x + (want === 'left' ? -floor : floor))),
    };
    return { ...g, t, side: chosen.side, x: chosen.x * 100, y: p.y * 100 };
  });
}

export { RIVER, T_START, T_END, MAX_GATES, VISIBLE, TEXT_ROOM, ASPECT, riverAt, spreadT, layoutGates };
