// 首屏:一张沉浸式星河导航页。
//
// ★ 这一版是**推翻重做**,不是在上一版上微调。上一版的批评一针见血:
//   我把「星河」理解成了「一条发光的线 + 左图标右胶囊的列表」——
//   描一条 1.6px 的芯线、糊两层模糊当光晕,本质仍然是**一条线**。
//   要的是**一条有宽度、有纵深、有颗粒的星云带**,入口像长在带子的节点上。
//   这是版式理解错了,不是精细度不够,所以在原图上微调救不回来,只能重来。
//
// 分三层:
//   ① 深蓝夜空渐变底
//   ② 银河:一张带 alpha 的 WebP 当主视觉 —— 这个质感 CSS 硬画不出来
//   ③ 五个入口:绝对定位钉在银河上,大小分层级、左右错落
//
// 两处**故意没照抄**设计稿,免得以后有人以为是漏了:
//   · 稿子写「四个入口」,但要求方后来亲口改成五个(五个 tab 都要有星星)。
//     少一颗,那一页就变成只能绕路进 —— 以原话为准,留五颗。
//   · 稿子要求右上角摆「Pro 徽章 + 通知铃」。不加,两个理由:
//     一是首屏顶栏是刚被明确要求整个去掉的,再往右上角摆东西是把它请回来;
//     二是这两样都是假的 —— 没有付费档、这版也没有通知功能。
//     **摆一个点不动的铃铛比不摆更差。**
import { esc, escAttr } from './util.js';
import { state } from './state.js';
import { layoutGates, splitGates } from './river.js';

// 五个入口。
//
// ★★★ 第二版返工的要害,原话是「**背景/星河/星星 就像在三个图层一样**」——
//    技术上它确实是三层,但**要看起来像一层**。上一版像三张纸叠着,原因有四:
//      ① 银河只占下半屏,上半屏是干净 Hero + 一大片空 —— 要的是**贯穿整屏**
//      ② 背景一粒星尘都没有 → 星河成了画面里唯一的"东西",纸感就是这么来的
//      ③ 星河是直接叠上去的,边缘生硬;星星锐、星河柔,**锐度不统一**一眼看穿
//      ④ 铺满之后文字压在亮部会糊
//    修法在 CSS 里(mix-blend-mode:screen / 底下垫放大重模糊的自身副本 /
//    星星和星河共享一套光源色 / 文字下垫局部径向蒙版),这里只记为什么。
//
// ★ 这里**不再有任何量出来的坐标**。
//   每个入口只说三件事:挂在河的哪一侧、多大、以及它在数组里的次序。
//   位置由 river.js 从归一化路径算出来 —— 于是:
//     · 换一张银河素材 → 只改 river.js 里那张表,这儿一个字不动
//     · 加/减一个入口 → 这儿加一行,**其余四颗的位置会自动重排**
//   (以前是五组照着素材量的像素,换图或加入口都得全部重量一遍;
//    对开源件来说那等于在首屏贴了张「此处不许改」的封条。)
//
// ★ size 是**占容器高的百分比**,不是像素:写死 px 的话,同一颗星
//   在 320 宽屏上占 38%、430 宽屏上只占 28%,一套设计变成两个比例。
//
// ★ side 决定挂河的哪一侧。**这一版五颗全在左**,不是审美选择,是算出来的:
//   定稿素材的河紧贴右缘,右侧放不下「星 + 文字」——
//   实测右侧外缘会越界 10%/32%/10%/42%(只有「设置」那颗放得下)。
//   所以交错让位给了「放得下」。换素材后如果河居中,交错会自己回来。
const GATES = [
  { tab: 'chat',     title: '私聊'    , hint: (s) => `与 ${s.assistantName || 'AI'} 畅聊`,   side: 'left', size: 13   },
  { tab: 'group',    title: '群聊'    , hint: (s) => `${s.groupName || '小群'}，提到就唤起`, side: 'left', size: 10.5 },
  { tab: 'memory',   title: '记忆库',   hint: () => '珍藏回忆',                              side: 'right', size: 8.5  },
  { tab: 'console',  title: '控制台',   hint: () => '看它怎么干活',                          side: 'left', size: 11   },
  { tab: 'settings', title: '设置',     hint: () => '名字 · 主题',                           side: 'left', size: 8    },
];

// 北斗七星:「找不到的功能来这儿」。
// ★ 它**不挂在河上**,而是钉在左边那块空地上 —— 所以不走 layoutGates。
//   理由:它是星座不是单星,跟五颗主入口一眼分得开,不会被当成第六个平级项;
//   语义上北斗本来就是指路的。
// ★ y 从评审给的 47% 挪到了 29%:47% 在**他那版**坐标下不压字,但我的五颗星是
//   由 t 算出来的,群聊正好落在 48.8% —— 两个文字框只差 6px。
//   盒子判定说"不重叠",眼睛看却是「群聊空间 更多」连成一行:
//   **框不相交 ≠ 视觉上分得开**。所以挪到 Hero 与第一颗星之间那块 90px 的真空档。
// ★ side:'right' —— 它在左边那块空地上,文字必须朝**屏幕中心**展开,朝左会被裁掉。
//   (第一版没给 side,于是 .sg-text 没有任何定位规则,文字直接飘出左边界。)
// ★ hint 也短了:原来写「还没挂上来的都在这儿」十个字,在 24% 这个位置放不下。
// ★ 位置与尺寸按设计定稿更新:x 24→30、y 29→56、宽 150px、**副标题去掉**。
//   size 是「占容器高的百分比」,而定稿给的是**宽度** 150px ——
//   新素材宽高比 2.894,所以 150/2.894 = 51.8px 高,占 844 高的 6.14%。
//   ★ 换素材必须重算这个数:同样的 size 换个宽高比就是另一个宽度。
// 图标只有一套:徽章。手绘星星那套(stars3/*.svg)已删 —— 需求方定的:
// 「星空主题删掉手绘星星,留下徽章主题」。
// ★ 顺带把 BADGE_SCALE 也化进 GATES 的 size 里就不必了 —— 那个缩放量是量出来的,
//   写成常量比揉进表里更容易被下一个人看见和复核。
// ★ 做成**独立字段**而不是第四个主题值:主题多一个值意味着 styles.css 里 46 条
//   `[data-theme="starry"]` 选择器每条都要再匹配一次,漏一条就是某档样式静默塌掉。
//   独立字段只碰这几行,那 46 条一条都不用动。
// ★ 徽章**等比缩 12%**;星星那套原样不动 —— 两套的视觉重量不同,
//   星星版偏细,缩了会更难辨认。**别"顺手统一"成一个系数。**
// ★★ 这个缩放量**不是自由参数**,改它要重跑一次验证。结论是有边界的:
//    「在缩放量 12% 这一档下,两套图标的落点差 4~11px,且不改变任何一档的
//      出屏 / 翻面 / 文字截断判定(拿 12 字的名字压过)。」
//    ★ 不是「尺寸与落点无关」—— 落点会被可见区 clamp 夹,而 clamp 边界是
//      `VISIBLE[1] - starHalf`,**starHalf 随尺寸变,所以夹的位置随尺寸变**:
//      被夹的那两颗实测差 0.3% / 1.2%,小图标能往外多站一点。
//    ⇒ 缩放量若改动(比如 12% → 30%),上面那句结论作废,要重新量。
//    写成「12% 这一档」而不是「无关」,是为了让改这个数的人知道他得回来重跑 ——
//    写「无关」他就不会回来了。
const BADGE_SCALE = 0.88;
function starSrc(s, g) {
  return `/assets/badges/${g.tab === 'chat' ? 'private' : g.tab}.webp`;
}
function dipperSrc(s) {
  return '/assets/badges/bigdipper.webp';
}

// ★ side:'below' —— 「更多」的字排在北斗**正下方**,不再排在右边。
//   排右边时它会横着长进「记忆库」那一片,两组标签读起来连成一坨
//   (盒子不相交,但眼睛分不开 —— 同一个毛病上一版在「群聊」身上犯过一次)。
//   北斗底下是整屏最空的一块,字放那儿谁也不挨着。
// ★ tab 从 'settings' 改成 'more'。原来点「更多」直接落进设置页 ——
//   反馈原话「这个更多,点进去咋变成设置界面了」。它现在有自己那一页(more-view.js):
//   北斗立起来当功能盘,设置只是盘上的一颗。
const DIPPER = { tab: 'more', title: '更多', hint: '', x: 30, y: 56, size: 6.14, side: 'below' };

// side 现在是**算出来并写死在表里**的,不再由 x 现推。
// 原因是判据变了:以前只要"不溢出",现在还要满足左右交错的节奏,
// 而且两个条件在最窄的那档手机上会打架 —— 得解一次,不能每次现猜。

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

// 已陪伴 N 天。★ 用两个 UTC 零点相减,不用毫秒差除 86400000 ——
// 后者在跨时区/夏令时的半夜前后会抖出 ±1 天。当天算第 1 天。
function daysTogether(iso) {
  if (!iso) return 0;
  const start = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(start)) return 0;
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.round((today - start) / 86400000)) + 1;
}

function renderHome() {
  const s = state.settings || {};
  // 超出上限的入口不会消失,它们归到「更多」那颗北斗名下(并在控制台点名)
  const { onRiver, overflow } = splitGates(GATES);
  const days = daysTogether(s.companion_since);

  return `
    <div class="home-view">
      <!-- ★ 第一屏是一个固定高度的舞台:银河/Hero/入口都在它里面绝对定位。
           没有这个舞台,入口层因为是 absolute 不占流,「最近记忆」会直接顶到
           Hero 底下和星星叠在一起(第一版就是这样)。
           舞台之外的内容自然落到第一屏**下面**,往下滑才看得到 —— 第一屏保持干净。 -->
      <div class="home-stage">
      <!-- ★ 银河是**整屏的底**,不是页面中段的一块。它排在最前、绝对定位铺满,
           Hero 文字从它上面压过去 —— 「星河要贯穿整个界面」是字面意思。 -->
      <div class="home-sky" aria-hidden="true">
        <!-- ★ 只有一层。新素材把银河和夜空画在同一张图里了 ——
             「背景/星河/星星像三个图层」的根治办法不是把三层调得像一层,
             而是让它**真的只有一层**。所以星尘层、渐变底、预烘光晕全部删掉。 -->
        <div class="sky-inner">
          <img class="sky-galaxy" src="/assets/galaxy-river.webp" alt="" decoding="async">
        </div>
      </div>

      <div class="home-hero">
        <div class="home-who">
          <div class="home-avatar">${s.assistant_avatar
            ? `<img src="${escAttr(s.assistant_avatar)}" alt="">`
            : '<img src="/assets/stars/star-private-core.webp" alt="">'}</div>
          <div>
            <div class="home-status"><i class="dot"></i>${esc(s.assistantName || 'AI')} 在线</div>
            <div class="home-sub">${esc(s.agent && s.agent.configured ? '温柔陪伴中' : '演示模式')}</div>
          </div>
        </div>
        <h1 class="home-greet">${esc(greeting())}，${esc(s.userName || '你')}</h1>
        ${days ? `<p class="home-days">已陪伴你 <b>${days}</b> 天</p>` : ''}
        <p class="home-ask">今天想和 ${esc(s.assistantName || 'AI')} 聊些什么？</p>
      </div>

      <!-- ★ 入口层跟 .sky-inner **同一个盒子**(同样的 aspect-ratio + 居中),
           所以 --x/--y 这组从图里算出来的百分比仍然精确落在银河上。
           它不放在 .home-sky 里面,是因为那层 aria-hidden 且不接事件。 -->
      <ul class="sky-gates">
        ${layoutGates(onRiver.map((g) => ({ ...g, hintText: g.hint(s) }))).map((g) => `
          <li class="sky-gate sg-${g.side}" style="--x:${g.x}%;--y:${g.y}%;--size:${(g.size * BADGE_SCALE).toFixed(2)}%">
            <button type="button" data-action="tab" data-tab="${g.tab}">
              <span class="sg-star"><img src="${starSrc(s, g)}" alt=""></span>
              <span class="sg-text">
                <span class="sg-title">${esc(g.title)}</span>
                <span class="sg-hint">${esc(g.hintText)}</span>
              </span>
            </button>
          </li>`).join('')}
        <li class="sky-gate sky-dipper sg-${DIPPER.side}" style="--x:${DIPPER.x}%;--y:${DIPPER.y}%;--size:${DIPPER.size}%">
          <button type="button" data-action="tab" data-tab="${DIPPER.tab}">
            <span class="sg-star"><img src="${dipperSrc(s)}" alt=""></span>
            <span class="sg-text">
              <span class="sg-title">${esc(DIPPER.title)}</span>
              ${overflow.length ? `<span class="sg-hint">还有 ${overflow.length} 个</span>` : ''}
            </span>
          </button>
        </li>
      </ul>
      </div>
    </div>`;
}

export { renderHome, daysTogether, greeting };
