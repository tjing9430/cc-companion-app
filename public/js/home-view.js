// 首屏:一条星河从上往下淌,四个入口挂在河道上。
//
// 照设计稿做。两处**故意没照抄**,理由写在这儿免得以后有人以为是漏了:
//   · 样稿右上有「Pro」徽章 —— 这是自部署的开源件,没有付费档,摆一个假徽章是撒谎
//   · 样稿右上有铃铛 —— 通知功能这版没有,摆一个点不动的铃铛比不摆更差
// 其余(问候语、已陪伴 N 天、四个入口、最近记忆)一一对应。
//
// 只在 starry 主题下当落地页;light/dark 下这个 tab 也能进,但没有星河底,
// 就是一个朴素的入口页 —— 不为了好看去绑架主题选择。
import { esc, escAttr } from './util.js';
import { state, ICONS } from './state.js';

// 入口。图标复用已入库的星星素材,和顶栏主星成套。
// ★ 五颗齐 = 底栏可以整个拆掉。少一颗就会有一个「只能绕路到达」的页面,
//   而绕路的那一下就是用户困住的地方。所以宁可挤一点,也要五颗全在河上。
// ★ 控制台那颗的副标题原来写「个性化设置」—— 它干的根本不是这个(它是看 AI 干活的地方),
//   而且会和真·设置那颗撞名。名不副实的标签比没标签更误导。
const GATES = [
  { tab: 'chat', star: 'star-private-core.webp', title: '私密聊天', hint: (s) => `与 ${s.assistantName || 'AI'} 畅聊`, size: 86 },
  { tab: 'group', star: 'star-group.webp', title: '群聊空间', hint: (s) => `${s.groupName || '小群'}，提到就唤起`, size: 62 },
  { tab: 'memory', star: 'star-flower-spare.webp', title: '记忆库', hint: () => '珍藏回忆', size: 56 },
  { tab: 'console', star: 'star-console.webp', title: '控制台', hint: () => '看它怎么干活', size: 54 },
  { tab: 'settings', star: 'star-moon.webp', title: '设置', hint: () => '名字 · 主题 · 头像', size: 50 },
];

// 「晚上好」跟着本地时间走。用本地小时不是 UTC —— 这句话是说给坐在屏幕前的人听的。
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

// 河道。★ 三层都用同一条 d —— 改形状只改这一处,不会出现「雾和芯不在一条线上」。
const RIVER_D = 'M252 6 C 150 70, 262 150, 128 232 C 26 296, 196 372, 96 470 C 52 512, 74 566, 122 634';

// 星尘:沿路径采样撒粒子。★ 必须在 DOM 里做 —— getPointAtLength 是 SVG 的真几何,
// 自己手算三次贝塞尔的弧长参数化既麻烦又容易和渲染出的曲线对不齐。
export function hydrateHome(root) {
  const svg = (root || document).querySelector('.river-line');
  const path = svg && svg.querySelector('#riverPath');
  const g = svg && svg.querySelector('.river-dust');
  if (!path || !g || g.childElementCount) return;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const total = path.getTotalLength();
  const N = reduced ? 130 : 320;           // 密度就是「像不像星河」的关键,细线撒 20 颗没用
  const NS = 'http://www.w3.org/2000/svg';
  let html = '';
  for (let i = 0; i < N; i++) {
    // 沿弧长均匀取点,再往法线方向随机偏一点 —— 偏移量决定河道的「宽窄」
    const t = (i + Math.random() * 0.8) / N * total;
    const p = path.getPointAtLength(Math.min(t, total));
    const p2 = path.getPointAtLength(Math.min(t + 1, total));
    const nx = -(p2.y - p.y); const ny = p2.x - p.x;
    const len = Math.hypot(nx, ny) || 1;
    // 中间密两边疏:用两次随机取平方,天然向 0 聚
    const spread = (Math.random() - 0.5) * 2;
    const off = spread * spread * spread * 44;
    const x = p.x + (nx / len) * off;
    const y = p.y + (ny / len) * off;
    const r = (Math.random() * 2.0 + 0.6).toFixed(2);
    const o = (0.45 + Math.random() * 0.55).toFixed(2);
    const warm = i / N < 0.62;            // 上半段偏金,下半段偏蓝紫,跟渐变同一套色
    const fill = warm ? (Math.random() < 0.3 ? '#FFF6DC' : '#FFD98A') : (Math.random() < 0.3 ? '#EAE2FF' : '#A9B8F5');
    const dur = (Math.random() * 3 + 2.2).toFixed(1);
    const delay = (Math.random() * 4).toFixed(1);
    html += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}" opacity="${o}"`
      + (reduced ? '' : ` style="--o:${o};--dur:${dur}s;--delay:${delay}s"`) + ' class="dust"/>';
  }
  g.innerHTML = html;
}

function renderHome() {
  const s = state.settings || {};
  const days = daysTogether(s.companion_since);
  // 最近记忆:有就摆两条,没有就整块不出现 —— 空标题配空列表是最难看的一种
  const recent = (state.memories || []).filter((m) => !m.superseded_by && !m.archived).slice(-3).reverse();

  return `
    <div class="home-view">
      <div class="home-head">
        <div class="home-brand">${esc(s.appName || 'CC Companion')}</div>
        <div class="home-who">
          <div class="home-avatar">${s.assistant_avatar
            ? `<img src="${escAttr(s.assistant_avatar)}" alt="">`
            : '<img src="/assets/stars/star-private-core.webp" alt="">'}</div>
          <div>
            <div class="home-status"><i class="dot"></i>${esc(s.assistantName || 'AI')} 在线</div>
            <div class="home-sub">${esc(s.agent && s.agent.configured ? '随时可以说话' : '演示模式')}</div>
          </div>
        </div>
        <h1 class="home-greet">${esc(greeting())}，${esc(s.userName || '你')}</h1>
        ${days ? `<p class="home-days">已陪伴你 <b>${days}</b> 天</p>` : ''}
        <p class="home-ask">今天想聊些什么？</p>
      </div>

      <div class="home-river">
        <svg class="river-line" viewBox="0 0 320 640" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="riverGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stop-color="#FFE9B0" stop-opacity="0"/>
              <stop offset="12%"  stop-color="#FFD98A" stop-opacity="1"/>
              <stop offset="45%"  stop-color="#E7C47A" stop-opacity="1"/>
              <stop offset="72%"  stop-color="#A98CF0" stop-opacity=".95"/>
              <stop offset="100%" stop-color="#8DAFF8" stop-opacity="0"/>
            </linearGradient>
            <filter id="riverBloom" x="-40%" y="-10%" width="180%" height="120%">
              <feGaussianBlur stdDeviation="10"/>
            </filter>
            <filter id="riverBloomWide" x="-60%" y="-10%" width="220%" height="120%">
              <feGaussianBlur stdDeviation="26"/>
            </filter>
          </defs>
          <!-- 三层堆出「有厚度的光」:最外一层大模糊当雾,中间一层当光带,芯是细亮线。
               单独一条 2.5px 的线在深空底上等于没有 —— 第一版就是那样,太淡。 -->
          <path class="rv rv-haze" d="${RIVER_D}" fill="none" stroke="url(#riverGrad)"
                stroke-width="62" stroke-linecap="round" opacity=".42" filter="url(#riverBloomWide)"/>
          <path class="rv rv-band" d="${RIVER_D}" fill="none" stroke="url(#riverGrad)"
                stroke-width="24" stroke-linecap="round" opacity=".62" filter="url(#riverBloom)"/>
          <path class="rv rv-core" id="riverPath" d="${RIVER_D}" fill="none" stroke="url(#riverGrad)"
                stroke-width="1.6" stroke-linecap="round" opacity=".9"/>
          <!-- 星尘:水合时沿着这条路径采样撒进来(见 hydrateHome) -->
          <g class="river-dust"></g>
        </svg>
        <ul class="home-gates">
          ${GATES.map((g, i) => `
            <li class="home-gate gate-${i}">
              <button type="button" data-action="tab" data-tab="${g.tab}">
                <span class="gate-star" style="--gate-size:${g.size}px">
                  <img src="/assets/stars/${g.star}" alt="">
                </span>
                <span class="gate-text">
                  <span class="gate-title">${esc(g.title)} <em>→</em></span>
                  <span class="gate-hint">${esc(g.hint(s))}</span>
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
