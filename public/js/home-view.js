// 首屏:一条星河从上往下淌,四个入口挂在河道上。
//
// 照她给的样稿做。两处**故意没照抄**,理由写在这儿免得以后有人以为是漏了:
//   · 样稿右上有「Pro」徽章 —— 这是自部署的开源件,没有付费档,摆一个假徽章是撒谎
//   · 样稿右上有铃铛 —— 通知功能这版没有,摆一个点不动的铃铛比不摆更差
// 其余(问候语、已陪伴 N 天、四个入口、最近记忆)一一对应。
//
// 只在 starry 主题下当落地页;light/dark 下这个 tab 也能进,但没有星河底,
// 就是一个朴素的入口页 —— 不为了好看去绑架主题选择。
import { esc, escAttr } from './util.js';
import { state, ICONS } from './state.js';

// 入口。图标复用已入库的星星素材,和顶栏主星成套。
const GATES = [
  { tab: 'chat', star: 'star-private-core.webp', title: '私密聊天', hint: (s) => `与 ${s.assistantName || 'AI'} 畅聊`, size: 92 },
  { tab: 'group', star: 'star-group.webp', title: '群聊空间', hint: (s) => `${s.groupName || '小群'}，提到就唤起`, size: 66 },
  { tab: 'memory', star: 'star-flower-spare.webp', title: '记忆库', hint: () => '珍藏回忆', size: 58 },
  { tab: 'console', star: 'star-console.webp', title: '控制台', hint: () => '个性化设置', size: 58 },
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
        <svg class="river-line" viewBox="0 0 320 620" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="riverGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#E7C47A" stop-opacity="0"/>
              <stop offset="18%" stop-color="#E7C47A" stop-opacity=".85"/>
              <stop offset="55%" stop-color="#8DAFF8" stop-opacity=".7"/>
              <stop offset="100%" stop-color="#8DAFF8" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <path class="river-path" d="M250 0 C 120 90, 250 190, 120 280 C 20 350, 190 430, 90 530 C 60 570, 80 600, 110 620"
                fill="none" stroke="url(#riverGrad)" stroke-width="2.5" stroke-linecap="round"/>
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
