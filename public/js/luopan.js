// 罗盘首屏的动态零件：刻度环 / 二十四山 / 后天八卦 / 二十四节气 / 外圈房间，
// 以及指针的晃动。小样（luopan.final-20261004.html）里那套手写拖动逻辑整段换成了
// orbit-controller —— 拖动、惯性、点击阈值、切后台/出屏暂停、销毁都在那边，
// 这里只负责「画什么」和「每帧动什么」。
import { createOrbitController } from './orbit-controller.js';
import { daysTogether } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

// 后天八卦：坎北、艮东北、震东、巽东南、离南、坤西南、兑西、乾西北；
// 爻从里往外读（初爻在内）。卦象码 1 = 阳爻（整条），0 = 阴爻（中间断）。
const GUA = {
  坎: [0, '010'], 艮: [45, '001'], 震: [90, '100'], 巽: [135, '011'],
  离: [180, '101'], 坤: [225, '000'], 兑: [270, '110'], 乾: [315, '111'],
};

// 五个房间：一个房间配一卦。note 是卦象解释，只进 aria-label，不上屏。
// ★ tab 和首屏那五颗星是同一套（chat 由天池进，这里只列外圈五个），
//   所以点房间走的是全站那条 data-action="tab" 路由，不需要在这儿再挂事件。
const ROOMS = [
  { room: '群聊', tab: 'group', gua: '兑', note: '兑为泽，为口，大家说话的地方' },
  { room: '记忆库', tab: 'memory', gua: '艮', note: '艮为山，止而藏之' },
  { room: '控制台', tab: 'console', gua: '震', note: '震为雷，动起来的地方' },
  { room: '设置', tab: 'settings', gua: '巽', note: '巽为风，随你调' },
  { room: '更多', tab: 'more', gua: '坎', note: '坎在正北，往北去找' },
];

const RX = 158, RY = 204;
const IDLE_PERIOD_MS = 300000;   // 小样：300 秒转一圈

// 上一份水合留下的清理句柄。首屏重建时必须先收干净，见 hydrateLuopan 开头那段。
let cleanup = null;

// 二十四山：从北偏西的「壬」开始顺时针，子在正北
const MTS = '壬子癸丑艮寅甲卯乙辰巽巳丙午丁未坤申庚酉辛戌乾亥';
// 二十四节气：冬至在正北（子），春分正东，夏至正南，秋分正西
const TERM_RING = ['冬至', '小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种',
  '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪'];
// 节气日期按每年大致日期排，够首屏用 —— 不查真历，所以个别年份可能差一天。
const TERMS = [['小寒', 1, 6], ['大寒', 1, 20], ['立春', 2, 4], ['雨水', 2, 19], ['惊蛰', 3, 6], ['春分', 3, 21],
  ['清明', 4, 5], ['谷雨', 4, 20], ['立夏', 5, 6], ['小满', 5, 21], ['芒种', 6, 6], ['夏至', 6, 21],
  ['小暑', 7, 7], ['大暑', 7, 23], ['立秋', 8, 8], ['处暑', 8, 23], ['白露', 9, 8], ['秋分', 9, 23],
  ['寒露', 10, 8], ['霜降', 10, 23], ['立冬', 11, 7], ['小雪', 11, 22], ['大雪', 12, 7], ['冬至', 12, 22]];
// 宜忌：几句玩笑话，一天换一句
const YJ = [['早睡', '熬夜'], ['吃热饭', '空腹'], ['多喝水', '久坐'], ['出门走走', '想太多'],
  ['说想念', '嘴硬'], ['伸懒腰', '驼背'], ['看云', '刷到两点']];

function infoValue(value) {
  if (!value) return null;
  if (typeof value === 'string') return { title: value, detail: '' };
  if (typeof value !== 'object') return null;
  const title = String(value.title || value.label || value.text || '').trim();
  const detail = String(value.detail || value.subtitle || value.note || '').trim();
  return title ? { title, detail } : null;
}

export function hydrateLuopan(root, settings = {}) {
  // ★ 每次 render 都会把首屏整块重建，而 orbit-controller 在 window / document 上
  //   挂了 pointerup、pointercancel、visibilitychange 三个监听，还开着一个
  //   IntersectionObserver。**不先收上一份就是每渲染一次多一条 rAF 循环** ——
  //   星空那边同样把清理句柄放在模块级（starry.js 的 cleanupOrrery），照这个来。
  if (cleanup) { cleanup(); cleanup = null; }
  const stage = (root || document).querySelector('.luopan-stage');
  if (!stage) return;
  // ★ 用小样那套 [id="…"] + CSS.escape 取值，不用 getElementById：
  //   首屏随时可能被重建，getElementById 会捞到别的页面上同名的节点。
  const $ = (id) => stage.querySelector(`[id="${CSS.escape(id)}"]`);
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  // ---- 顶部：日子 / 问候 / 印章 / 宜忌 ----
  // 问候的时段边界和文案都照小样（13 点起是「午后好」）。
  // ★ 和 home-view.js 的 greeting() **故意**不一致（那边 14 点起、写「下午好」）：
  //   派单说文案以设计小样为准，所以这里不图省事去复用。别顺手统一。
  const now = new Date(), h = now.getHours();
  $('lpHello').textContent = h < 5 ? '夜 深 了' : h < 11 ? '早 上 好' : h < 13 ? '中 午 好' : h < 18 ? '午 后 好' : '晚 上 好';

  const CN = '〇一二三四五六七八九十';
  const cnNum = (n) => (n <= 10 ? CN[n] : n < 20 ? `十${CN[n - 10]}` : CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : ''));
  const dateText = `${cnNum(now.getMonth() + 1)}月${cnNum(now.getDate())}日 · 星期${'日一二三四五六'[now.getDay()]}`;
  // ★「第 N 天」用 util.js 的 daysTogether（全站唯一一份，本地零点相减）。
  //   小样里那版是本地零点相减，本来是对的；但 app 里另外几处曾经用 UTC 日期，
  //   北京 00:00–08:00 会比它少一天 —— 现在统一到 util.js 那一份。
  const days = daysTogether(settings.companion_since);
  $('lpDate').textContent = days ? `${dateText} · 第 ${days} 天` : dateText;

  // 印章只装一个字：取 assistantName 首字，没填（还是出厂默认的 AI/Assistant）就退回「伴」。
  const name = String(settings.assistantName || '').trim();
  $('lpSeal').textContent = (name && name !== 'AI' && name !== 'Assistant' ? name : '伴').slice(0, 1);

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yj = YJ[Math.floor(today / 864e5) % YJ.length];
  $('lpAlmanac').textContent = `宜 ${yj[0]}　忌 ${yj[1]}`;

  // ---- 节气：本机算，任何时候都有值 ----
  const yr = now.getFullYear();
  const list = [...TERMS.map(([n, m, d]) => [n, new Date(yr, m - 1, d)]), ['小寒', new Date(yr + 1, 0, 6)]];
  let cur = ['冬至', new Date(yr - 1, 11, 22)], next = list[0];
  for (let i = 0; i < list.length; i++) {
    if (list[i][1] <= today) { cur = list[i]; next = list[i + 1]; }
  }
  // ---- 底部三格：此刻 / 天气 / 节气 ----
  // ★「此刻」和「天气」读的是和星空首屏同一处（settings.currentStatus || assistantStatus、
  //   settings.weather）。但**现在没有任何地方会往这两个键里写**，而且 normalizeSettings
  //   的返回是一段显式字面量、这两个键根本不在白名单里（lib/state.js:317-343）——
  //   所以实际上只会亮「节气」这一格（星空首屏的两格同样一直是空的）。
  //   哪天要给这两格数据，先把键加进白名单，这里一行都不用改。
  //
  // ★ 亮几格就排几格：定稿是三等分，缺格的时候把剩下的居中排开，
  //   不然会留下两根没有内容的竖线，看着像坏了 —— 和星空首屏那条
  //   `--orrery-info-count`（按数量重排网格）是同一件事，只是这里在 SVG 里排。
  const cells = [
    { node: $('lpInfoNow'), value: infoValue(settings.currentStatus || settings.assistantStatus) },
    { node: $('lpInfoWeather'), value: infoValue(settings.weather) },
    { node: $('lpInfoTerm'), value: { title: cur[0], detail: `距${next[0]} ${Math.round((next[1] - today) / 864e5)} 天` } },
  ];
  const visible = cells.filter((c) => c.value);
  cells.forEach((c) => (c.value ? c.node.removeAttribute('display') : c.node.setAttribute('display', 'none')));
  const offsets = visible.length === 1 ? [0] : visible.length === 2 ? [-59, 59] : [-118, 0, 118];
  visible.forEach((c, i) => {
    c.node.setAttribute('transform', `translate(${offsets[i]},32)`);
    const title = c.node.querySelector('.luopan-info-title');
    const detail = c.node.querySelector('.luopan-info-detail');
    if (title) title.textContent = c.value.title;
    if (detail) detail.textContent = c.value.detail;
  });
  // 分隔线只画在**相邻且都亮着**的两格之间，位置取两格中心的中点。
  [$('lpDiv1'), $('lpDiv2')].forEach((line, k) => {
    const a = visible.indexOf(cells[k]), b = visible.indexOf(cells[k + 1]);
    if (a < 0 || b < 0) { line.setAttribute('display', 'none'); return; }
    line.removeAttribute('display');
    const mid = (offsets[a] + offsets[b]) / 2;
    line.setAttribute('x1', mid);
    line.setAttribute('x2', mid);
  });

  // ---- 刻度环：一圈 120 格，每 5 格一条长线 ----
  const deg = $('lpDeg');
  for (let i = 0; i < 120; i++) {
    const a = (i / 120) * Math.PI * 2, long = i % 5 === 0;
    const r1 = 84, r2 = long ? 92 : 88;
    el('line', {
      x1: Math.cos(a) * r1, y1: Math.sin(a) * r1, x2: Math.cos(a) * r2, y2: Math.sin(a) * r2,
      stroke: 'var(--lp-line)', 'stroke-width': long ? 0.6 : 0.35, opacity: long ? 0.9 : 0.55,
    }, deg);
  }

  // ---- 二十四山 ----
  const mt = $('lpMountains');
  for (let i = 0; i < 24; i++) {
    const a = (i - 1) * 15, r = 72;
    const t = el('text', {
      x: 0, y: 0, transform: `rotate(${a}) translate(0,${-r + 3.2})`, 'text-anchor': 'middle',
      class: 'serif', 'font-size': 7.6, fill: i % 2 ? 'var(--lp-ink)' : 'var(--lp-ink-soft)',
    }, mt);
    t.textContent = MTS[i];
    const b = ((a + 7.5 - 90) * Math.PI) / 180;
    el('line', {
      x1: Math.cos(b) * 65, y1: Math.sin(b) * 65, x2: Math.cos(b) * 79, y2: Math.sin(b) * 79,
      stroke: 'var(--lp-line-faint)', 'stroke-width': 0.4,
    }, mt);
  }

  // ---- 后天八卦 ----
  const drawGua = (parent, code, w, gapY, sw) => {
    for (let k = 0; k < 3; k++) {
      const y = (1 - k) * gapY;                     // k=0 是初爻，在下
      if (code[k] === '1') {
        el('line', { x1: -w / 2, y1: y, x2: w / 2, y2: y, stroke: 'var(--lp-line)', 'stroke-width': sw, 'stroke-linecap': 'butt' }, parent);
      } else {
        el('line', { x1: -w / 2, y1: y, x2: -w * 0.1, y2: y, stroke: 'var(--lp-line)', 'stroke-width': sw }, parent);
        el('line', { x1: w * 0.1, y1: y, x2: w / 2, y2: y, stroke: 'var(--lp-line)', 'stroke-width': sw }, parent);
      }
    }
  };
  const guaRing = $('lpGua');
  for (const [guaName, [a, code]] of Object.entries(GUA)) {
    const g = el('g', { transform: `rotate(${a}) translate(0,-50)` }, guaRing);
    drawGua(g, code, 12, 3.2, 1.5);
    const t = el('text', { y: -7.6, 'text-anchor': 'middle', class: 'serif', 'font-size': 6, fill: 'var(--lp-ink-soft)' }, g);
    t.textContent = guaName;
  }

  // ---- 二十四节气环：当下的那个字和它外沿一颗朱点都走红 ----
  const termsG = $('lpTerms');
  TERM_RING.forEach((termName, i) => {
    const a = i * 15, on = termName === cur[0];
    const t = el('text', {
      transform: `rotate(${a}) translate(0,-106.5)`, 'text-anchor': 'middle', class: 'serif',
      'font-size': 6.4, 'letter-spacing': 0.4, fill: on ? 'var(--lp-red)' : 'var(--lp-ink-soft)',
    }, termsG);
    t.textContent = termName;
    if (on) el('circle', { transform: `rotate(${a}) translate(0,-114.6)`, r: 1.5, fill: 'var(--lp-red)' }, termsG);
    const b = ((a + 7.5 - 90) * Math.PI) / 180;
    el('line', {
      x1: Math.cos(b) * 102, y1: Math.sin(b) * 102, x2: Math.cos(b) * 117, y2: Math.sin(b) * 117,
      stroke: 'var(--lp-line-faint)', 'stroke-width': 0.4,
    }, termsG);
  });

  // ---- 外圈五个房间 ----
  const ring = $('lpRing');
  const groups = ROOMS.map((c, i) => {
    const holder = el('g', {
      class: 'luopan-room luopan-hit', 'data-action': 'tab', 'data-tab': c.tab,
      role: 'button', tabindex: '0', 'aria-label': `${c.room} · ${c.note}`,
    }, ring);
    const inner = el('g', {}, holder);
    el('circle', { r: 34, fill: 'transparent' }, inner);          // 好点
    const badge = el('g', {}, inner);
    // 卦牌：双圈，卦在中间
    el('circle', { r: 20, fill: 'var(--lp-bg)', stroke: 'var(--lp-line)', 'stroke-width': 0.8 }, badge);
    el('circle', { r: 17.2, fill: 'none', stroke: 'var(--lp-line-soft)', 'stroke-width': 0.4 }, badge);
    drawGua(badge, GUA[c.gua][1], 15, 4.6, 2);
    const label = el('text', { y: 36, 'text-anchor': 'middle', class: 'serif', 'font-size': 12.5, fill: 'var(--lp-ink)', 'letter-spacing': 4 }, inner);
    label.textContent = c.room;
    const small = el('text', { y: 49, 'text-anchor': 'middle', class: 'serif', 'font-size': 8.5, fill: 'var(--lp-ink-faint)', 'letter-spacing': 2 }, inner);
    small.textContent = `${c.gua} 卦`;
    // 第一个房间在正上方（-90°），顺时针排
    return { holder, base: (i / ROOMS.length) * Math.PI * 2 - Math.PI / 2 };
  });

  // 指针轻轻晃，像真的罗盘在找北；天池的涟漪一呼一吸。
  // ★ 走 style.transform / style.opacity，不走 setAttribute：
  //   改 SVG 的 transform 属性会让整棵大 SVG 重新栅格化，而 CSS 变换留在合成层上。
  //   指针的旋转中心是罗盘的圆心，也就是这个 SVG 的坐标原点 —— 圆的规矩。
  const needle = $('lpNeedle'), ripples = $('lpRipples');
  const animateDetails = (ts) => {
    const t = ts / 1000;
    needle.style.transform = `rotate(${(Math.sin(t * 0.9) * 3.5 + Math.sin(t * 2.3) * 1.2).toFixed(2)}deg)`;
    ripples.style.opacity = (0.6 + 0.4 * Math.sin(t * 0.8)).toFixed(2);
  };

  const orbit = createOrbitController({
    stage,
    surface: $('lpDial'),
    items: groups.map((group) => ({ element: group.holder, angle: group.base })),
    center: { x: 0, y: 0 },
    radius: { x: RX, y: RY },
    reducedMotion: reduce,
    idlePeriodMs: IDLE_PERIOD_MS,
    dragThresholdPx: 8,
    onFrame: reduce ? () => {} : animateDetails,
  });

  // 键盘也能挑房间：Enter / 空格 当成点一下
  const keyHandler = (event) => {
    const target = event.target.closest?.('[data-action="tab"]');
    if (!target || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  stage.addEventListener('keydown', keyHandler);

  cleanup = () => {
    orbit.destroy();
    stage.removeEventListener('keydown', keyHandler);
  };
}
