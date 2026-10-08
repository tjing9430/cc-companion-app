import { createOrbitController } from './orbit-controller.js';

export const ORRERY_DUST_LIMIT = 90;
export const ORRERY_MOON_DOT_LIMIT = 1500;

export function hydrateOrrery(stage, settings = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => stage.querySelector(`[id="${CSS.escape(id)}"]`);
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  // 开源版不写死名字和纪念日：都从设置里读，没填就显示通用文案
  const CFG = { aiName: settings.assistantName || '', userName: settings.userName === '你' ? '' : (settings.userName || ''), since: settings.companion_since || '' };
  const now = new Date(), h = now.getHours();
  $('hello').textContent = h < 5 ? '夜 深 了' : h < 11 ? '早 上 好' : h < 13 ? '中 午 好' : h < 18 ? '下 午 好' : '晚 上 好';
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (CFG.since) {
    const [y, m, d] = CFG.since.split('-').map(Number);
    $('days').textContent = Math.round((today - new Date(y, m - 1, d)) / 864e5) + 1;
  } else {
    $('daysLine').textContent = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${'日一二三四五六'[now.getDay()]}`;
  }

  // 月相：九枚，今天那枚点亮
  const SYN = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14);
  const age = (((now - ref) / 864e5) % SYN + SYN) % SYN;
  const todayIdx = Math.round(age / SYN * 8) % 8;
  const ph = $('phases');
  const defs = $('orreryDefs');
  // 月海、环形山的位置按真实月面（单位：月半径，北在上）
  // 不规则的月海轮廓：12 个点、按 seed 起伏，再用二次曲线连圆
  function maryPath(cx, cy, rx, ry, seed, wob = .34) {
    const n = 14, pts = [];
    for (let k = 0; k < n; k++) {
      const a = k / n * 6.283, j = 1 - wob / 2 + wob * Math.abs(Math.sin(seed * 7.3 + k * 2.1)) * (k % 3 ? 1 : .7);
      pts.push([cx + Math.cos(a) * rx * j, cy + Math.sin(a) * ry * j]);
    }
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    let m = mid(pts[0], pts[1]), d = `M${m[0].toFixed(2)},${m[1].toFixed(2)}`;
    for (let k = 1; k <= n; k++) { const p = pts[k % n]; m = mid(p, pts[(k + 1) % n]); d += ` Q${p[0].toFixed(2)},${p[1].toFixed(2)} ${m[0].toFixed(2)},${m[1].toFixed(2)}`; }
    return d + 'Z';
  }
  const MARIA = [[-.32,-.38,.28,.24],[.18,-.32,.17,.16],[.32,.02,.2,.17],[.68,-.18,.1,.12],[.55,.28,.12,.18],
    [.33,.42,.08,.08],[-.55,.05,.28,.42],[-.18,.42,.2,.14],[-.5,.45,.1,.09],[-.05,-.64,.4,.07]];
  const CRATERS = [[-.12,.78,.06],[-.3,-.05,.07],[-.58,-.02,.045],[.05,.62,.05],[.48,-.55,.05],[-.75,.4,.05],[.75,.55,.04],[.15,.15,.035],[-.4,.72,.04]];
  for (let i = 0; i < 9; i++) {
    const x = (i - 4) * 29, f = i / 8;            // 0 新月 → 0.5 满月 → 1 新月
    const lit = i === todayIdx || (todayIdx === 0 && i === 8);
    const R = lit ? 11 : 8.6;
    const g = el('g', { transform: `translate(${x},0)` }, ph);
    const cid = 'mc' + i, lid = 'ml' + i;
    const cc = el('clipPath', { id: cid }, defs); el('circle', { r: R }, cc);
    if (lit) el('circle', { r: R + 9, fill: 'url(#halo-gold)', opacity: .55 }, g);
    const body = el('g', { 'clip-path': `url(#${cid})` }, g);
    // 暗面：地照，很淡的蓝 + 细排线
    el('circle', { r: R, fill: '#9fb0e6', opacity: lit ? .1 : .06 }, body);   // 一点点地球反照
    if (lit) el('rect', { x: -R, y: -R, width: R * 2, height: R * 2, fill: 'url(#hatchFine)', opacity: .3 }, body);
    // 亮面：边缘柔一点的晨昏线
    const k = Math.cos(f * 2 * Math.PI), rx = Math.abs(k) * R;
    const waxing = f < 0.5, so = waxing ? 1 : 0, si = (k > 0) === waxing ? 0 : 1;
    if (f > 0.02 && f < 0.98) {
      const m = el('mask', { id: lid, maskUnits: 'userSpaceOnUse', x: -R - 2, y: -R - 2, width: R * 2 + 4, height: R * 2 + 4 }, defs);
      el('path', { d: `M0,-${R} A${R},${R} 0 0 ${so} 0,${R} A${rx},${R} 0 0 ${si} 0,-${R}Z`, fill: '#fff', filter: 'url(#soft)' }, m);
      const lg = el('g', { mask: `url(#${lid})` }, body);
      if (lit) el('circle', { r: R, fill: 'url(#moonLit)' }, lg);
      else {
        el('circle', { r: R, fill: 'url(#moonLit)', opacity: .85 }, lg);   // A 的浅金底
        MARIA.forEach(([mx, my, rx2, ry2], q) => el('path', { d: maryPath(mx * R, my * R, rx2 * R, ry2 * R, q + 1), fill: '#97794a', opacity: .3 }, lg));
        // 经线式的弧：p 是赤道上的横向位置（-1 左边缘 … 1 右边缘）
        const meridian = (p) => el('path', { d: `M0,${-R} A${(Math.abs(p) * R).toFixed(2)},${R} 0 0 ${p > 0 ? 1 : 0} 0,${R}`, fill: 'none', stroke: '#86693c', 'stroke-width': .18, opacity: .5 }, lg);
        const term = waxing ? k : -k, limb = waxing ? 1 : -1;
        if (Math.abs(f - .5) < .07) { for (const p of [.8, .87, .93, .97, -.8, -.87, -.93, -.97]) meridian(p); }
        else { const span = Math.min(1, .55 / Math.abs(limb - term)); for (let n = 0; n < 10; n++) meridian(term + (limb - term) * span * Math.pow((n + .5) / 10, 1.5)); }
      }
      if (lit) {
      MARIA.forEach(([mx, my, rx2, ry2], q) => {
        const d = maryPath(mx * R, my * R, rx2 * R, ry2 * R, q + 1);
        el('path', { d, fill: '#a58858', opacity: .42 }, lg);
        el('path', { d, fill: 'url(#hatchMare)', opacity: .5 }, lg);
        el('path', { d, fill: 'none', stroke: '#7d6236', 'stroke-width': .12, opacity: .55 }, lg);
      });
      // 月海里零星的小点和山脊
      for (let q = 0; q < 60; q++) {
        const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * R * .95;
        el('circle', { cx: (Math.cos(a) * r).toFixed(2), cy: (Math.sin(a) * r).toFixed(2), r: (Math.random() * .12 + .06).toFixed(2), fill: '#6e5532', opacity: (Math.random() * .4 + .2).toFixed(2) }, lg);
      }
      // 环形山：坑里一弯阴影（靠光源那侧），对面一道亮边，不画整圈描边
      for (const [cx, cy, cr] of CRATERS) {
        const x = cx * R, y = cy * R, r = cr * R;
        el('ellipse', { cx: x, cy: y, rx: r, ry: r * .86, fill: '#a88c5c', opacity: .35 }, lg);
        el('path', { d: `M${(x - r).toFixed(2)},${y.toFixed(2)} A${r.toFixed(2)},${(r * .86).toFixed(2)} 0 0 1 ${(x + r).toFixed(2)},${y.toFixed(2)} A${r.toFixed(2)},${(r * .5).toFixed(2)} 0 0 0 ${(x - r).toFixed(2)},${y.toFixed(2)}Z`, transform: `rotate(-35 ${x.toFixed(2)} ${y.toFixed(2)})`, fill: '#6e5532', opacity: .55 }, lg);
        el('path', { d: `M${(x + r).toFixed(2)},${y.toFixed(2)} A${r.toFixed(2)},${(r * .86).toFixed(2)} 0 0 1 ${(x - r).toFixed(2)},${y.toFixed(2)}`, transform: `rotate(-35 ${x.toFixed(2)} ${y.toFixed(2)})`, fill: 'none', stroke: '#fff4d6', 'stroke-width': .22, opacity: .75 }, lg);
      }
      // 第谷坑的辐射纹
      const [tx, ty] = [-.12 * R, .78 * R];
      for (let r = 0; r < 7; r++) { const a = r / 7 * 6.283 + .3, L = R * (.25 + (r % 3) * .1); el('line', { x1: tx, y1: ty, x2: tx + Math.cos(a) * L, y2: ty + Math.sin(a) * L, stroke: '#fff8e4', 'stroke-width': .18, opacity: .45 }, lg); }
      }
    }
    el('circle', { r: R, fill: 'none', stroke: lit ? 'var(--gold)' : 'rgba(217,191,138,.4)', 'stroke-width': lit ? .6 : .3 }, g);
    if (lit) {
      el('circle', { r: R + 3, fill: 'none', stroke: 'var(--gold)', 'stroke-width': .3, opacity: .7 }, g);
      el('circle', { r: R + 5.2, fill: 'none', stroke: 'var(--gold)', 'stroke-width': .25, 'stroke-dasharray': '.5 1.6', opacity: .55 }, g);
      el('use', { href: '#spark', transform: `translate(0,${-R - 9}) scale(2.8)`, fill: 'var(--gold)' }, g);
    }
    if (i < 8) {
      if (i % 2) el('use', { href: '#spark', transform: `translate(14.5,0) scale(1.5)`, fill: 'var(--gold-soft)' }, g);
      else el('circle', { cx: 14.5, cy: 0, r: .6, fill: 'var(--gold-soft)' }, g);
    }
  }
  const NAMES = ['新月', '蛾眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月'];
  $('moonName').textContent = NAMES[todayIdx];
  $('moonAge').textContent = `月龄 ${age.toFixed(1)} 天`;

  const infoValue = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return { title: value, detail: '' };
    if (typeof value !== 'object') return null;
    const title = String(value.title || value.label || value.text || '').trim();
    const detail = String(value.detail || value.subtitle || value.note || '').trim();
    return title ? { title, detail } : null;
  };
  const infoRows = [
    { node: $('orreryInfoNow'), value: infoValue(settings.currentStatus || settings.assistantStatus) },
    { node: $('orreryInfoWeather'), value: infoValue(settings.weather) },
    { node: $('orreryInfoMoon'), value: { title: NAMES[todayIdx], detail: `月龄 ${age.toFixed(1)} 天` } },
  ];
  const visibleInfo = infoRows.filter((item) => item.value);
  infoRows.forEach((item) => {
    if (item.value) item.node.removeAttribute('hidden');
    else item.node.setAttribute('hidden', '');
  });
  visibleInfo.forEach((item, index) => {
    item.node.classList.toggle('with-divider', index > 0);
    const title = item.node.querySelector('.orrery-info-title');
    const detail = item.node.querySelector('.orrery-info-detail');
    if (title) title.textContent = item.value.title;
    if (detail) detail.textContent = item.value.detail;
  });
  stage.dataset.infoCount = String(visibleInfo.length);
  stage.style.setProperty('--orrery-info-count', String(visibleInfo.length));

  // 月面：金色点刻高地、留空的三块月海、贴着暗边的弧形排线、南边几个环形山和第谷的辐射纹
  const tex = $('moonTex');
  const blob = (cx, cy, rx, ry, seed) => {
    const n = 12, pts = [];
    for (let k = 0; k < n; k++) { const a = k / n * 6.283, j = .86 + .22 * Math.abs(Math.sin(seed * 7.3 + k * 2.1)); pts.push([cx + Math.cos(a) * rx * j, cy + Math.sin(a) * ry * j]); }
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    let m = mid(pts[0], pts[1]), d = `M${m[0].toFixed(1)},${m[1].toFixed(1)}`;
    for (let k = 1; k <= n; k++) { const p = pts[k % n]; m = mid(p, pts[(k + 1) % n]); d += ` Q${p[0].toFixed(1)},${p[1].toFixed(1)} ${m[0].toFixed(1)},${m[1].toFixed(1)}`; }
    return d + 'Z';
  };
  // 月海照真实月面摆，三块不对称：左边斜长的雨海+风暴洋，右上圆一点的澄海+静海，右边缘的危海
  const SEAS = [[-15, -2, 11, 23, 28], [10, -11, 9.5, 8.5, 0], [29, -6, 4, 5.5, 0]];
  const inSea = (x, y) => SEAS.some(([cx, cy, rx, ry, rot]) => {
    const t = -rot * Math.PI / 180, dx = x - cx, dy = y - cy, u = dx * Math.cos(t) - dy * Math.sin(t), v = dx * Math.sin(t) + dy * Math.cos(t);
    return (u / rx) ** 2 + (v / ry) ** 2 < 1;
  });
  // 先铺一层左上亮、右下暗的淡金底，缩小后整颗月亮是亮的
  el('circle', { r: 40, fill: 'url(#moonGold)' }, tex);
  SEAS.forEach(([cx, cy, rx, ry, rot], k) => {
    el('path', { d: blob(cx, cy, rx, ry, k + 2), transform: `rotate(${rot} ${cx} ${cy})`, fill: '#22183a', opacity: .72, filter: 'url(#soft2)' }, tex);
  });
  // 高地密点、月海疏点。点刻一次性烘到一张透明位图里；1500 个静态
  // SVG circle 会让移动五个星座时整棵 SVG 反复栅格化，真机上会明显跳帧。
  const dotCanvas = document.createElement('canvas');
  // 80×80 SVG 单位按设备 DPR 烘制，且至少 4×。DPR3 屏得到 320×320
  // 纹理，覆盖星盘在 390px 视口里的最大显示尺寸，放大检查仍保留点刻边缘。
  const dotScale = Math.max(4, Math.min(6, Math.ceil(window.devicePixelRatio || 1)));
  dotCanvas.width = 80 * dotScale;
  dotCanvas.height = 80 * dotScale;
  const dotContext = dotCanvas.getContext('2d');
  dotContext.translate(40 * dotScale, 40 * dotScale);
  dotContext.scale(dotScale, dotScale);
  for (let i = 0; i < ORRERY_MOON_DOT_LIMIT; i++) {
    const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 39.5, x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (inSea(x, y) && Math.random() > .25) continue;
    const lit = .4 + .5 * (1 - (x + y + 56) / 112);
    dotContext.beginPath();
    dotContext.arc(x, y, Math.random() * .3 + .2, 0, Math.PI * 2);
    dotContext.fillStyle = `rgba(236,214,164,${(lit * (Math.random() * .5 + .5)).toFixed(2)})`;
    dotContext.fill();
  }
  el('image', { x: -40, y: -40, width: 80, height: 80, href: dotCanvas.toDataURL('image/png') }, tex);
  el('circle', { r: 40, fill: 'url(#limb)' }, tex);   // 边缘压暗，球面感
  // 贴着右下暗边的弧形排线，给月亮一点球面
  for (let k = 0; k < 6; k++) {
    const r = 39 - k * 1.5, a1 = -.15 + k * .1, a2 = 2.0 - k * .12;
    el('path', { d: `M${(Math.cos(a1) * r).toFixed(2)},${(Math.sin(a1) * r).toFixed(2)} A${r},${r} 0 0 1 ${(Math.cos(a2) * r).toFixed(2)},${(Math.sin(a2) * r).toFixed(2)}`, fill: 'none', stroke: '#d9bf8a', 'stroke-width': .28, opacity: (.42 - k * .06).toFixed(2) }, tex);
  }
  // 第谷的辐射纹：只这一处，拉长
  const TY = [-6, 27];
  for (let k = 0; k < 10; k++) {
    const a = k / 10 * 6.283 + .35, L = 16 + (k * 7 % 4) * 7;
    el('line', { x1: TY[0], y1: TY[1], x2: TY[0] + Math.cos(a) * L, y2: TY[1] + Math.sin(a) * L, stroke: '#e2c993', 'stroke-width': .25, opacity: .3 }, tex);
  }
  // 环形山：只画半圈亮边和里面的阴影
  for (const [cx, cy, r] of [[-6, 27, 2.6], [11, 20, 4], [-18, 20, 2.8], [21, 6, 2], [3, 32, 1.5], [-28, -20, 1.6]]) {
    el('ellipse', { cx: cx - r * .15, cy: cy - r * .15, rx: r * .82, ry: r * .68, fill: '#0b0820', opacity: .7 }, tex);
    const a1 = -.5, a2 = 2.2;
    el('path', { d: `M${(cx + Math.cos(a1) * r).toFixed(2)},${(cy + Math.sin(a1) * r * .82).toFixed(2)} A${r},${(r * .82).toFixed(2)} 0 0 1 ${(cx + Math.cos(a2) * r).toFixed(2)},${(cy + Math.sin(a2) * r * .82).toFixed(2)}`, fill: 'none', stroke: '#f1dcaa', 'stroke-width': .55, opacity: .85 }, tex);
  }
  // 绕月的小星拖一条渐淡的尾巴
  const trail = el('path', {
    fill: 'none', stroke: '#ffe2a8', 'stroke-width': .75, 'stroke-linecap': 'round',
    'stroke-dasharray': '1.4 1.8', opacity: .42,
  }, $('trail'));
  // 内圈环字
  const motto = CFG.aiName && CFG.userName
    ? `${CFG.aiName} · ${CFG.userName}${CFG.since ? ' · SINCE ' + CFG.since.replace(/-/g, '.') : ''} · A LIGHT LEFT ON FOR YOU ·`.toUpperCase()
    : 'CC COMPANION · SOMEONE IS HERE · A LIGHT LEFT ON FOR YOU ·';
  $('ringText').textContent = motto;
  // 刻度
  const ticks = $('ticks');
  for (let i = 0; i < 72; i++) {
    const a = i / 72 * Math.PI * 2, long = i % 6 === 0;
    const r1 = 94, r2 = long ? 101 : 97;
    el('line', {
      x1: Math.cos(a) * r1, y1: Math.sin(a) * r1, x2: Math.cos(a) * r2, y2: Math.sin(a) * r2,
      stroke: 'var(--gold)', 'stroke-width': long ? .8 : .45, opacity: long ? .8 : .5,
    }, ticks);
  }

  // 背景星尘：零星的小四芒星和点
  const dust = $('dust');
  const rnd = (a, b) => a + Math.random() * (b - a);
  for (let i = 0; i < (reduce ? Math.min(45, ORRERY_DUST_LIMIT) : ORRERY_DUST_LIMIT); i++) {
    const x = rnd(0, 390), y = rnd(180, 676);
    if (Math.hypot(x - 195, y - 438) < 125) continue;
    if (Math.random() < 0.18) {
      const s = rnd(1.6, 3.4);
      el('use', { href: '#spark', transform: `translate(${x},${y}) scale(${s})`, fill: Math.random() < .5 ? '#d9bf8a' : '#c6cff0', opacity: rnd(.25, .7) }, dust);
    } else {
      el('circle', { cx: x, cy: y, r: rnd(.3, .9), fill: '#e6defc', opacity: rnd(.15, .55) }, dust);
    }
  }

  // 真实星座（按星图里的相对位置画，单位约等于 1 = 60px）
  // b 是亮度：2 = 亮星画四芒，1 = 普通，0 = 暗星
  const CONS = [
    { room: '群聊', name: '昴', note: '一簇挤在一起说话的星', color: 'blue',
      stars: [[.52,.50,2],[.82,.48,1],[.84,.38,0],[.36,.36,1],[.30,.56,1],[.44,.66,1],[.22,.44,0]],
      lines: [] },
    { room: '记忆库', name: '天琴', note: '织女在这里，记着的事都在', color: 'gold',
      stars: [[.50,0,2],[.66,.10,0],[.38,.30,1],[.62,.33,1],[.58,.80,1],[.34,.76,1]],
      lines: [[0,1],[0,2],[2,3],[3,4],[4,5],[5,2]] },
    { room: '控制台', name: '猎户', note: '一直在忙的那位', color: 'blue',
      stars: [[.50,0,0],[.20,.14,2,'warm'],[.78,.18,1],[.42,.52,1],[.50,.49,1],[.58,.46,1],[.30,.94,1],[.82,.88,2]],
      lines: [[1,0],[0,2],[1,3],[2,5],[3,4],[4,5],[3,6],[5,7]] },
    { room: '设置', name: '仙后', note: '一个 W，名字和主题', color: 'gold',
      stars: [[0,.18,1],[.25,.56,1,'warm'],[.5,.32,2],[.75,.62,1],[1,.12,1]],
      lines: [[0,1],[1,2],[2,3],[3,4]] },
    { room: '北斗', name: '北斗', note: '更多房间往这儿找', color: 'gold',
      stars: [[0,.14,1],[.18,0,1],[.34,.03,2],[.49,.10,1],[.53,.34,1],[.83,.38,1],[.80,.10,2]],
      lines: [[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,3]] },
  ];
  const ring = $('ring');
  const RX = 140, RY = 188, SIZE = 90;
  const groups = CONS.map((c, i) => {
    const tab = { '群聊': 'group', '记忆库': 'memory', '控制台': 'console', '设置': 'settings', '北斗': 'more' }[c.room];
    const holder = el('g', { class: 'orrery-room', 'data-action': 'tab', 'data-tab': tab, role: 'button', tabindex: '0' }, ring);
    const inner = el('g', {}, holder);
    const col = '#c9d1f0';                                   // 星和连线统一银蓝，金色只留给能点的字
    el('circle', { r: 44, fill: 'transparent' }, inner);       // 好点
    const ox = -SIZE / 2, oy = -SIZE / 2 - 8;
    const P = c.stars.map(([x, y]) => [ox + x * SIZE, oy + y * SIZE]);
    const cy0 = -8;
    // 圈里的暗星
    for (let k = 0; k < 16; k++) {
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 40;
      el('circle', { cx: Math.cos(a) * r, cy: cy0 + Math.sin(a) * r, r: rnd(.22, .55), fill: '#e6defc', opacity: rnd(.15, .45) }, inner);
    }
    // 昴星团：一团淡蓝的反射星云，外加一簇挤着的小星
    if (c.name === '昴') {
      const [nx, ny] = P[0];
      el('ellipse', { cx: nx - 6, cy: ny - 2, rx: 30, ry: 20, fill: '#8fa6e8', opacity: .16, filter: 'url(#neb)' }, inner);
      el('ellipse', { cx: nx - 2, cy: ny + 2, rx: 16, ry: 11, fill: '#b9c8f5', opacity: .14, filter: 'url(#neb)' }, inner);
      for (let k = 0; k < 10; k++) el('circle', { cx: nx + rnd(-26, 22), cy: ny + rnd(-18, 16), r: rnd(.35, .7), fill: '#dfe6ff', opacity: rnd(.4, .8) }, inner);
    }
    if (c.name === '猎户') {
      // 腰带下面挂着的剑，中间那团是猎户座大星云
      const sx = P[4][0] - 1, sy = P[4][1];
      el('ellipse', { cx: sx, cy: sy + 16, rx: 7, ry: 10, fill: '#e2a3c6', opacity: .22, filter: 'url(#neb)' }, inner);
      el('ellipse', { cx: sx + 1, cy: sy + 16, rx: 3.5, ry: 5, fill: '#a9c4ff', opacity: .3, filter: 'url(#neb)' }, inner);
      [[sx - .8, sy + 9, .55], [sx, sy + 16, 1], [sx + .4, sy + 17.6, .5], [sx + .8, sy + 23, .6]].forEach(([x, y, r]) => el('circle', { cx: x, cy: y, r, fill: '#f4f0ff', opacity: .9 }, inner));
    }
    if (c.name === '天琴') {
      // 织女星多一圈大光晕；双双星；指环星云（同色、极淡）
      el('circle', { cx: P[0][0], cy: P[0][1], r: 15, fill: 'url(#halo-blue)', opacity: .45 }, inner);
      el('circle', { cx: P[1][0] + 2, cy: P[1][1] - 1.4, r: .5, fill: '#e6eaff', opacity: .85 }, inner);
      const rx = (P[4][0] + P[5][0]) / 2, ry = (P[4][1] + P[5][1]) / 2 - 1;
      el('ellipse', { cx: rx, cy: ry, rx: 1.6, ry: 1.2, fill: 'none', stroke: '#c9d1f0', 'stroke-width': .35, opacity: .45 }, inner);
    }
    if (c.name === '北斗') {
      // 开阳旁边的辅星
      el('circle', { cx: P[1][0] + 2.6, cy: P[1][1] - 2.4, r: .55, fill: '#e6eaff', opacity: .9 }, inner);
    }
    if (c.name === '仙后') {
      // 银河从仙后座穿过去：一条淡带 + 一片密密的小星
      const mx = P.reduce((t, q) => t + q[0], 0) / P.length, my = P.reduce((t, q) => t + q[1], 0) / P.length;
      el('ellipse', { cx: mx, cy: my + 2, rx: 62, ry: 11, transform: `rotate(-14 ${mx} ${my + 2})`, fill: '#b9c3ef', opacity: .08, filter: 'url(#neb)' }, inner);
      for (let k = 0; k < 40; k++) {
        const u = rnd(-55, 55), v = rnd(-8, 8) * (1 - Math.abs(u) / 70), a = -14 * Math.PI / 180;
        el('circle', { cx: mx + u * Math.cos(a) - v * Math.sin(a), cy: my + 2 + u * Math.sin(a) + v * Math.cos(a), r: rnd(.2, .45), fill: '#e6defc', opacity: rnd(.12, .35) }, inner);
      }
    }
    const lines = el('g', { opacity: .5 }, inner);
    const gap = (b) => b === 2 ? 4.4 : b === 1 ? 3.2 : 2.4;
    for (const [a, b] of c.lines) {
      const [x1, y1] = P[a], [x2, y2] = P[b], d = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / d, uy = (y2 - y1) / d;
      const ga = gap(c.stars[a][2]), gb = gap(c.stars[b][2]);
      el('line', { x1: x1 + ux * ga, y1: y1 + uy * ga, x2: x2 - ux * gb, y2: y2 - uy * gb, stroke: col, 'stroke-width': .4, 'stroke-linecap': 'round' }, lines);
    }
    const stars = el('g', {}, inner);
    const halo = 'url(#halo-blue)', colBase = col;
    c.stars.forEach(([, , b, tint], j) => {
      const [x, y] = P[j];
      const col = tint === 'warm' ? '#ecdcbc' : colBase;
      el('circle', { cx: x, cy: y, r: b === 2 ? 8 : b === 1 ? 4.6 : 2.8, fill: tint === 'warm' ? 'url(#halo-warm)' : halo, opacity: b === 0 ? .55 : .95 }, stars);
      if (b === 2) {
        el('line', { x1: x - 10, y1: y, x2: x + 10, y2: y, stroke: col, 'stroke-width': .22, opacity: .6 }, stars);
        el('line', { x1: x, y1: y - 10, x2: x, y2: y + 10, stroke: col, 'stroke-width': .22, opacity: .6 }, stars);
        el('use', { href: '#spark', transform: `translate(${x},${y}) scale(5.2)`, fill: col }, stars);
        el('use', { href: '#spark', transform: `translate(${x},${y}) rotate(45) scale(2.4)`, fill: col, opacity: .7 }, stars);
        el('circle', { cx: x, cy: y, r: 1, fill: '#fffaf0' }, stars);
      } else if (b === 1) {
        el('circle', { cx: x, cy: y, r: 1.15, fill: '#fbf6ff' }, stars);
        el('circle', { cx: x, cy: y, r: 2, fill: 'none', stroke: col, 'stroke-width': .3, opacity: .65 }, stars);
      } else {
        el('circle', { cx: x, cy: y, r: .75, fill: col, opacity: .85 }, stars);
      }
    });
    const bot = Math.max(...P.map(q => q[1])) + 18;
    const label = el('text', { y: bot, 'text-anchor': 'middle', class: 'serif', 'font-size': 12.5, fill: '#d9bf8a', 'letter-spacing': 4 }, inner);
    label.textContent = c.room;
    const small = el('text', { y: bot + 14, 'text-anchor': 'middle', class: 'serif', 'font-size': 9, fill: 'rgba(228,218,255,.42)', 'letter-spacing': 2 }, inner);
    small.textContent = c.name === c.room ? '大熊座' : c.name + (c.name === '昴' ? '星团' : '座');
    const latin = el('text', { y: bot + 24, 'text-anchor': 'middle', class: 'serif', 'font-size': 5.6, fill: '#d9bf8a', opacity: .4, 'letter-spacing': 1.5 }, inner);
    latin.textContent = { '昴': 'PLEIADES', '天琴': 'LYRA', '猎户': 'ORION', '仙后': 'CASSIOPEIA', '北斗': 'URSA MAJOR' }[c.name];
    return { c, holder, inner, lines, base: i / CONS.length * Math.PI * 2 - Math.PI / 2 };
  });

  function animateDetails(ts) {
    const t = ts / 1000;
    const sa = t * Math.PI * 2 / 40;                  // 四十秒绕一圈
    $('sat').setAttribute('transform', `translate(${(Math.cos(sa) * 76).toFixed(2)},${(Math.sin(sa) * 24).toFixed(2)})`);
    const vis = (q) => Math.sin(q) > 0 || Math.hypot(Math.cos(q) * 76, Math.sin(q) * 24) > 40 ? 1 : 0;   // 转到月亮背后就藏起来
    $('sat').setAttribute('opacity', vis(sa));
    const points = [];
    for (let k = 1; k <= 9; k++) {
      const q = sa - k * .05;
      if (vis(q) < .5) continue;
      points.push(`${points.length ? 'L' : 'M'}${(Math.cos(q) * 76).toFixed(2)},${(Math.sin(q) * 24).toFixed(2)}`);
    }
    trail.setAttribute('d', points.join(' '));
  }
  if (reduce) { $('sat').setAttribute('transform', 'translate(76,0)'); trail.setAttribute('visibility', 'hidden'); }
  const svg = $('s');
  const orbit = createOrbitController({
    stage,
    surface: svg,
    items: groups.map((group) => ({ element: group.holder, angle: group.base })),
    center: { x: 195, y: 438 },
    radius: { x: RX, y: RY },
    reducedMotion: reduce,
    idlePeriodMs: 240000,
    dragThresholdPx: 8,
    onFrame: animateDetails,
  });
  const keyHandler = (event) => {
    const target = event.target.closest?.('[data-action="tab"]');
    if (!target || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  };
  stage.addEventListener('keydown', keyHandler);

  return () => {
    orbit.destroy();
    stage.removeEventListener('keydown', keyHandler);
  };
}
