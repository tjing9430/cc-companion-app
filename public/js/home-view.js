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

// 五个入口。
//
// ★★ --x/--y 不是眼睛估的,是**从那张银河图里算出来的**:
//    逐行取「alpha × 亮度」的剖面,找该行最亮的那一股(局部极大),
//    那就是银河实际的走向。星星钉在这组坐标上,才是真的长在带子上。
//
// ★ 为什么不用逐行质心:银河是 S 形、会横向折返,同一行里常有 2~5 股。
//   质心把几股一平均,落点就掉进两股中间的**空处**了 —— 实测 y=34% 那行
//   质心算出来 x=60%,而真正的亮股在 48%,60% 那个位置是透明的。
//
// 两条约束一起解出来的:
//   ① 安全带 x ∈ [17%, 83%] —— 最大那颗 110px 在 390 屏上占 28%,
//      落点太靠边星星会被容器裁掉;
//   ② 相邻两颗横向至少错开 15% —— 否则会排成一条竖线,
//      正是设计稿点名不要的「所有图标都在同一条垂直线上」。
//      (没加这条时,群聊 64.6% 和记忆库 64.5% 撞在了一起。)
//   ③ 纵向也要匀 —— 只管横向的话会挤:第一版控制台 y=77%、设置 y=84%,
//      只差 40px,两颗贴在一起。现在从 16% 到 88% 四段各 ~18%,
//      每颗只在目标位 ±4% 的窗口里挑最亮的那股。
//
// ★★★ size 是**盒子高度**,不是「看上去多大」—— 这两个差得很远,第一版就栽在这:
//    素材是 512×768 的竖图,我塞进一个正方形盒子用 object-fit:contain,
//    110px 的盒子实际只画出 73px 宽,再加上图形本身还留白,可见部分只剩 ~52px。
//    更糟的是**留白比例每张都不一样**(console 图形只占画布高 54%,flower 占 93%),
//    所以给相同的 size,看上去大小完全不同 —— 层级就废了。
//    现在的 size 是**反推**的:想要的可见高度 ÷ 该素材的图形占比。
//      私密 100/0.82=122 · 群聊 60/0.62=98 · 记忆 70/0.93=75 · 控制台 58/0.54=108 · 设置 46/0.58=79
//    盒子高度看着乱,但**画出来的图形**才是 100/60/70/58/46 这组层级。
// ★ nudge:图形在自己画布里未必居中。private-core 偏左 6.2%,
//   不补这一下,星星的**视觉中心**就不在算出来的落点上(差 5px)。
const GATES = [
  { tab: 'chat',     star: 'star-private-core.webp', title: '私密聊天', hint: (s) => `与 ${s.assistantName || 'AI'} 畅聊`,   x: 80.5, y: 16, size: 122, nudge: 5 },
  { tab: 'group',    star: 'star-group.webp',        title: '群聊空间', hint: (s) => `${s.groupName || '小群'}，提到就唤起`, x: 64.6, y: 32, size: 98 },
  { tab: 'memory',   star: 'star-flower-spare.webp', title: '记忆库',   hint: () => '珍藏回忆',                              x: 49.6, y: 49, size: 75 },
  { tab: 'console',  star: 'star-console.webp',      title: '控制台',   hint: () => '看它怎么干活',                          x: 27.0, y: 70, size: 108 },
  { tab: 'settings', star: 'star-moon.webp',         title: '设置',     hint: () => '名字 · 主题 · 头像',                    x: 44.1, y: 88, size: 79 },
];

// 文字摆哪边:靠右的星把字放左边,靠左的放右边 —— 纯粹为了不溢出容器。
// 判据用「在容器里哪边地方大」,不是「哪边星云淡」:压到一点星云无所谓,
// 被容器裁掉才是硬伤。
const sideOf = (x) => (x > 50 ? 'left' : 'right');

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

// 星尘:银河图自己带了颗粒,这里只在**银河之外的天上**补一层稀疏微光和几颗四芒星,
// 让画面在带子以外也有空间感。密度刻意压低 —— 银河才是主角,
// 这层要是也铺满,两层颗粒会互相打架、糊成一片噪点。
export function hydrateHome(root) {
  const sky = (root || document).querySelector('.home-sky');
  const g = sky && sky.querySelector('.sky-dust');
  if (!g || g.childElementCount) return;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let html = '';
  for (let i = 0, N = reduced ? 40 : 90; i < N; i++) {
    const d = (Math.random() * 1.6 + 0.9).toFixed(2);
    const o = (0.18 + Math.random() * 0.45).toFixed(2);
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

      <div class="home-sky">
        <img class="sky-galaxy" src="/assets/galaxy-river.webp" alt="" aria-hidden="true" decoding="async">
        <div class="sky-dust" aria-hidden="true"></div>
        <ul class="sky-gates">
          ${GATES.map((g) => `
            <li class="sky-gate sg-${sideOf(g.x)}" style="--x:${g.x}%;--y:${g.y}%;--size:${g.size}px;--nudge:${g.nudge || 0}px">
              <button type="button" data-action="tab" data-tab="${g.tab}">
                <span class="sg-star"><img src="/assets/stars/${g.star}" alt=""></span>
                <span class="sg-text">
                  <span class="sg-title">${esc(g.title)}</span>
                  <span class="sg-hint">${esc(g.hint(s))}</span>
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
