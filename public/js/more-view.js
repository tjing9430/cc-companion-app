// 「更多」页:北斗七星立起来当功能盘。
//
// 需求原话:「点击『更多』之后做一个动画,把这个横着的北斗七星**逆时针旋转 90 度、放大**,
//            然后**每颗星星一个功能**」,以及「那个功能是给开源的人自己做的」。
// 后半句是这一页的设计前提:**它不是一个塞满功能的抽屉,是一块留白的盘。**
// 我们只把手头**真有**的三件挂上去,剩下的位子明摆着空在那儿,并写清楚怎么填。
// 摆一个点不动的假入口,比空着更糟 —— 首屏那个「通知铃」当初就是这么被否掉的。
//
// ★ 素材里是 **6 颗**,不是 7。
//   我按亮度阈值把星核抠出来聚类:6 个直径 26~37px 的圆核,大小相当;
//   另外还有 3 个较暗的亮团,但它们的坐标**正好落在相邻两颗星连线的中点上**
//   (27.46→47.47 的中点 37.47,实测 37.40;47.47→57.60 的中点 52.53,实测 52.46),
//   ⇒ 那是连线的辉光,不是星。所以功能位是 6 个。
//   **别照「北斗七星」这个名字去凑第 7 个** —— 盘上没有那颗星,凑出来的位子点上去是空的。
//
// ★ 换素材要重量一次下面那六组坐标 —— 这是位图方案自带的耦合。
//   **若哪天换成 SVG 线稿**:给六个节点各一个 id、让页面从 DOM 读位置,
//   STAR_POINTS / rotateCCW / 以及"换素材必须重量"这整条警告**就都不必存在了**。
//   (省下的字节是小头;省掉一处必须人肉维护的耦合才是大头 —— 对一个要发给别人改的仓库尤其。)
import { esc, escAttr } from './util.js';
import { state } from './state.js';

// 六颗星在**原图**里的中心,单位是原图宽/高的百分比(素材 1389×480)。
// ★ 存原图坐标、旋转在下面现算 —— 换素材时只要重量一次原图,旋转那段不用跟着改。
//   (存旋转后的坐标就等于把「转了 90 度」这个事实烤死在数字里,下一个人看不出来。)
const STAR_POINTS = [
  { x: 8.17,  y: 38.89 },
  { x: 27.46, y: 32.64 },
  { x: 47.49, y: 54.30 },
  { x: 57.59, y: 80.58 },
  { x: 79.64, y: 73.49 },
  { x: 90.59, y: 30.77 },
];

// 逆时针 90°:原图 (x,y) → 新框 (y, 100-x)。新框的宽高比也跟着倒过来(480:1389)。
// 验算:原图右上角 (100,0) 逆时针转到新框左上角 (0,0) ✓
//       原图左上角 (0,0)   逆时针转到新框左下角 (0,100) ✓
function rotateCCW(p) {
  return { x: p.y, y: 100 - p.x };
}

// 功能位。**想加自己的功能,就在这个数组里加一行** —— 这一页只认这张表。
// 位子按盘上从上到下发,发完为止;表比星少,余下的星就是空位。
//
// ★ 只放**这一页独有**的去处。私聊/群聊/记忆库/控制台/设置这五个已经在首屏星河上了,
//   再在这儿摆一份是同一个地方两条路,盘子看着满、其实没多给用户任何东西。
//   ——「设置」是例外:它本来就是这颗北斗错点进去的地方,给它一个正经位子。
const SLOTS = [
  { key: 'settings', title: '设置',   hint: '名字 · 主题 · 桥',  action: 'tab', tab: 'settings' },
  { key: 'about',    title: '关于',   hint: '版本 · 开源',       action: 'more-about' },
];

// ★ 这里原来有「换主题」那一格 + THEME_ORDER / THEME_LABEL / nextTheme。
//   需求方原话「删掉吧」—— 理由是它**轮流切**:三个主题要绕回原来那个得点三次,
//   而每点一次整页重绘、星盘入场动画重放一遍。
//   ⚠️ 删之前 grep 过消费者:settings-view 那三个 option 是**写死的**,不吃这张表,
//     所以功能不丢(设置页仍然是直选下拉)。三个符号只服务于这一格,一并删。
//   ★ 顺带记一笔:动画重放的根因**不是这个钮**,是"每次重绘都重建 .more-dial"。
//     钮删了那个根因还在 —— 见 .more-dial 的 md-in 那段。

// ==========================================================================
// 浮岛主题的「更多」:水晶球岛阵。
//
// 需求方 8/14 原话:「这个是更多里面的小岛」「放svg图标放在中间小圈圈里面的」「不放在首屏」。
// 每格 = 同一座水晶球岛(orb.webp,她发的透明底成图),SVG 图标嵌在玻璃球心,名字挂岛下面。
// ★ 球心的落点 (50%, 24%) 是**量出来的**,不是目测:拿 10% 网格叠在成图上读的,
//   球体横跨 x 32–68%、纵跨 y 6–42%。换素材必须重量这两个数(还有 CSS 里的 --ico-y)。
// ★ 功能位沿用同一张 SLOTS 表 —— 北斗盘和岛阵是同一批入口的两件衣服,
//   加功能仍然只改 SLOTS 一处,两个主题一起长出来。
// ★ 空位照旧明摆着(静态说明,不是 disabled 按钮),理由同北斗盘:留白的盘是设计前提。
const ORB_ICONS = {
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  about:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  empty:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="6" x2="12" y2="18"/><line x1="6" y1="12" x2="18" y2="12"/></svg>',
};

// 2×2 的岛阵。格数取「够摆下 SLOTS + 至少一个明摆的空位」的最小偶数 ——
// 现在是 2 实位 + 2 空位;SLOTS 长到 4 之后自动变 4+2,不用回来改这儿。
function renderMoreIsles(s) {
  const total = Math.max(4, Math.ceil((SLOTS.length + 1) / 2) * 2);
  const cells = Array.from({ length: total }, (_, i) => {
    const slot = SLOTS[i];
    if (!slot) {
      return `<li class="orb-cell orb-empty">
          <span class="orb-isle"><img src="/assets/island/orb.webp" alt="" decoding="async"><span class="orb-ico">${ORB_ICONS.empty}</span></span>
          <span class="orb-name"><b>空位</b><i>自己加</i></span>
        </li>`;
    }
    const hint = typeof slot.hint === 'function' ? slot.hint(s) : slot.hint;
    const attrs = slot.tab ? ` data-tab="${escAttr(slot.tab)}"` : '';
    return `<li class="orb-cell">
        <button type="button" data-action="${escAttr(slot.action)}"${attrs}>
          <span class="orb-isle"><img src="/assets/island/orb.webp" alt="" decoding="async"><span class="orb-ico oi-${escAttr(slot.key)}">${ORB_ICONS[slot.key] || ORB_ICONS.empty}</span></span>
          <span class="orb-name"><b>${esc(slot.title)}</b><i>${esc(hint)}</i></span>
        </button>
      </li>`;
  }).join('');
  return `
    <div class="more-view mv-isles">
      <ul class="orb-grid">${cells}</ul>
      ${state.moreAbout ? renderAbout(s) : ''}
    </div>`;
}

function renderMore() {
  const s = state.settings || {};
  // 浮岛主题穿岛阵这件衣服;北斗盘留给星空(和暖深色/奶油白 —— 它们没有岛素材)。
  if (s.theme === 'island') return renderMoreIsles(s);
  // 星按**盘上从上到下**排序再发位子 —— 用测出来的坐标排,不靠数组顺序碰运气。
  const stars = STAR_POINTS.map(rotateCCW).sort((a, b) => a.y - b.y);
  const cells = stars.map((pt, i) => {
    const slot = SLOTS[i];
    // 文字往屏幕中间那侧展开:星在左半盘就朝右排,在右半盘就朝左排。
    const side = pt.x < 50 ? 'right' : 'left';
    const style = `--x:${pt.x.toFixed(2)}%;--y:${pt.y.toFixed(2)}%;--i:${i}`;
    if (!slot) {
      // 空位。**不是 disabled 按钮**:disabled 的东西读屏会念出来又点不动,更迷惑。
      // 就是一段静态说明,写清楚这儿为什么空、怎么填。
      return `<div class="md-star md-${side} md-empty" style="${style}">
          <i class="md-dot" aria-hidden="true"></i>
          <span class="md-label"><span class="md-t">空位</span><span class="md-h">自己加</span></span>
        </div>`;
    }
    const hint = typeof slot.hint === 'function' ? slot.hint(s) : slot.hint;
    const attrs = slot.tab ? ` data-tab="${escAttr(slot.tab)}"` : '';
    return `<button type="button" class="md-star md-${side}" style="${style}"
        data-action="${escAttr(slot.action)}"${attrs}>
        <i class="md-dot" aria-hidden="true"></i>
        <span class="md-label"><span class="md-t">${esc(slot.title)}</span><span class="md-h">${esc(hint)}</span></span>
      </button>`;
  }).join('');

  return `
    <div class="more-view">
      <div class="more-dial${state.moreAnim ? ' md-in' : ''}">
        <!-- ★ 图单独转,**盘子不转**。整块一起转的话六段文字也会跟着躺倒,读不了。
             所以:图静态 rotate(-90deg),星点用换算过的坐标摆,文字始终是正的。
             进场那下「从横着转成竖着」是给外层 .more-dial 加的一次性动画
             (它从 rotate(90deg) 转回 0,叠上图自己的 -90deg,
              起手正好是首屏那个横着的样子)。 -->
        <img class="md-img" src="/assets/badges/bigdipper.webp" alt="" decoding="async">
        ${cells}
      </div>
      ${state.moreAbout ? renderAbout(s) : ''}
      <!-- ★「关于」是**浮层**不是流内元素。
           原来它排在盘下面,展开就把内容区撑高 81px —— 这一页于是从"不可滚"变成"可滚",
           用户滚下去读那行桶名,盘的上沿就钻进顶栏后面被切掉。
           而**让她滚下去读那行桶名的正是我们自己**(为了确认她跑的是哪版)。
           ⇒ 根治不是给盘加 padding,是让这一页**永远不产生滚动**:浮层不占流。 -->
    </div>`;
}

function renderAbout(s) {
  return `
    <div class="md-about" role="note">
      <b>${esc(s.appName || 'CC Companion')}</b>
      ${state.appVersion ? `<span>v${esc(state.appVersion)}</span>` : ''}
      <p>自己架的 AI 陪伴 App。星盘上空着的位子是留给你的：<br>
         改 <code>public/js/more-view.js</code> 里的 <code>SLOTS</code>，加一行就多一个功能。</p>
      <p class="md-sw">离线缓存：<code>${esc(state.swVersion || '查询中…')}</code></p>
    </div>`;
}

// 查「这台机器上**真的装着**的是哪一版离线缓存」。
//
// ★ 为什么不去读 /sw.js 里的版本号:那读到的是**服务器现在发的**那一版,
//   不是浏览器已经装上的那一版。两者在"发了新版但 install 还没跑完"的窗口里不一样,
//   而那个窗口恰恰就是要排查的东西 —— 拿服务器的版本去验客户端,等于问了个假问题。
//   caches.keys() 拿到的是**缓存桶的真名**,它就是装上的那一版。
// ★ 拿不到就如实说拿不到(浏览器不支持 / 没注册 SW),不填 "unknown" 冒充查过了。
async function loadSwVersion() {
  try {
    if (typeof caches === 'undefined') return '这个浏览器没有缓存 API';
    const keys = await caches.keys();
    const mine = keys.filter((k) => k.startsWith('cc-companion'));
    if (!mine.length) return keys.length ? `没有本 App 的桶（现有 ${keys.length} 个）` : '还没装上';
    return mine.join('、');
  } catch (err) {
    return `查不到（${err && err.name ? err.name : '未知错误'}）`;
  }
}

export { renderMore, STAR_POINTS, rotateCCW, SLOTS, loadSwVersion };
