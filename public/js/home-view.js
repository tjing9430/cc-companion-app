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
import { layoutGates, MAX_GATES } from './river.js';

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
// ★ side 决定挂河的哪一侧,左右交错让河留得出通路 ——
//   「沿着路走 ≠ 站在路当中」,骑在带子中间会把河截断。
const GATES = [
  { tab: 'chat',     star: 'star-private-core.webp', title: '私密聊天', hint: (s) => `与 ${s.assistantName || 'AI'} 畅聊`,   side: 'right', size: 14.5 },
  { tab: 'group',    star: 'star-group.webp',        title: '群聊空间', hint: (s) => `${s.groupName || '小群'}，提到就唤起`, side: 'left',  size: 11.6 },
  { tab: 'memory',   star: 'star-flower-spare.webp', title: '记忆库',   hint: () => '珍藏回忆',                              side: 'right', size: 9.4  },
  { tab: 'console',  star: 'star-console.webp',      title: '控制台',   hint: () => '看它怎么干活',                          side: 'left',  size: 12.2 },
  { tab: 'settings', star: 'star-moon.webp',         title: '设置',     hint: () => '名字 · 主题 · 头像',                    side: 'right', size: 8.6  },
];

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

// 背景星尘。
// ★ 第一版这层刻意压得很稀(怕和银河的颗粒打架),结果**反了**:
//   背景太干净,银河一放上去就像浮在一张白纸上 —— 「三个图层」的一大半是这么来的。
//   背景本身有内容,星河才是"从夜空里长出来的"而不是"贴在夜空上的"。
//   所以这一版加密、加细、铺满整屏,但**每颗都很暗**(靠数量给质感,不靠亮度抢戏)。
export function hydrateHome(root) {
  const sky = (root || document).querySelector('.home-sky');
  const g = sky && sky.querySelector('.sky-dust');
  if (!g || g.childElementCount) return;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let html = '';
  for (let i = 0, N = reduced ? 90 : 260; i < N; i++) {
    const d = (Math.random() * 1.3 + 0.5).toFixed(2);
    const o = (0.10 + Math.random() * 0.38).toFixed(2);
    const vars = reduced ? '' : `--dur:${(Math.random() * 3.5 + 2.4).toFixed(1)}s;--delay:${(Math.random() * 5).toFixed(1)}s;`;
    html += `<i class="sd" style="left:${(Math.random() * 100).toFixed(2)}%;top:${(Math.random() * 100).toFixed(2)}%;`
      + `width:${d}px;height:${d}px;--o:${o};${vars}"></i>`;
  }
  // 几颗四芒星高光 —— 设计稿点名要的那种「少量」。多了就俗气。
  for (let i = 0, N = reduced ? 2 : 5; i < N; i++) {
    html += `<i class="sd-spark" style="left:${(10 + Math.random() * 78).toFixed(1)}%;top:${(8 + Math.random() * 82).toFixed(1)}%;`
      + `--s:${(7 + Math.random() * 9).toFixed(1)}px;--delay:${(Math.random() * 6).toFixed(1)}s"></i>`;
  }
  g.innerHTML = html;
}

function renderHome() {
  const s = state.settings || {};
  const days = daysTogether(s.companion_since);
  // 最近记忆:有就摆几条,没有就整块不出现 —— 空标题配空列表是最难看的一种
  const recent = (state.memories || []).filter((m) => !m.superseded_by && !m.archived).slice(-3).reverse();

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
        <div class="sky-dust"></div>
        <!-- 两层:下面是**预先烘好的**光晕(一张 156×234 的小图,模糊已经画进去了),
             上面是本体。光溢出到四周,边缘才化得开 —— 只放一张,边界是硬的,像贴纸。
             ★ 光晕不用 CSS 的 blur():46px 模糊 × 780×1170 的图,浏览器每帧重算,
               软件渲染下一次截图能跑到 45 秒以上。而模糊本来就把细节抹平了 ——
               缩到 1/5 烘好再放大,看着一样,代价几乎为零(11KB vs 224KB)。
               这对低端手机是实打实的省,不只是我这台跑得快。 -->
        <div class="sky-inner">
          <img class="sky-galaxy glow" src="/assets/galaxy-glow.webp" alt="" decoding="async">
          <img class="sky-galaxy core" src="/assets/galaxy-river.webp" alt="" decoding="async">
        </div>
      </div>

      <div class="home-hero">
        <div class="home-brand">${esc(s.appName || 'CC Companion')}</div>
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
        ${layoutGates(GATES.slice(0, MAX_GATES).map((g) => ({ ...g, hintText: g.hint(s) }))).map((g) => `
          <li class="sky-gate sg-${g.side}" style="--x:${g.x}%;--y:${g.y}%;--size:${g.size}%">
            <button type="button" data-action="tab" data-tab="${g.tab}">
              <span class="sg-star"><img src="/assets/stars/${g.star}" alt=""></span>
              <span class="sg-text">
                <span class="sg-title">${esc(g.title)}</span>
                <span class="sg-hint">${esc(g.hintText)}</span>
              </span>
            </button>
          </li>`).join('')}
      </ul>
      </div>

      ${recent.length ? `
      <div class="home-recent">
        <div class="home-recent-head">最近记忆</div>
        ${recent.map((m) => `
          <button type="button" class="home-recent-row" data-action="tab" data-tab="memory">
            <span class="rr-title">${esc(m.title || '未命名')}</span>
            <span class="rr-mood">${esc(m.mood || '')}</span>
          </button>`).join('')}
      </div>` : ''}
    </div>`;
}

export { renderHome, daysTogether, greeting };
