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

function renderMore() {
  const s = state.settings || {};
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
