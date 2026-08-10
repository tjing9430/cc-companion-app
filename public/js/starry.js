// 星空主题的动态零件:背景星野 + 页头主星(双环)。
//
// 环的几何**照抄** star-double-ring-demo.html 的方程(图纸 §3 说了别重新发明):
// 素材坐标系 1024×1536,球心 (511,672),主环 a=423 b=104 倾角 -16°,
// 交叉环 a=387 b=158 倾角 +48°,z=sin(t) 定前后。这些数字一个都没改。
//
// ★ 唯一改的是**线宽**,而且必须改:demo 是照 400px 大图调的,glow 26 / 主线 10 /
//   高光 3.5(viewBox 单位)。同样的数字放到 56px 的页头星上 = 屏幕上 1.4px / 0.55px / 0.19px,
//   金环直接消失。所以这里按**目标屏幕像素**反算 viewBox 线宽 —— 几何不变,权重跟着尺寸走。
//
// 只在 starry 主题下工作;别的主题一行都不跑,不白付性能。
import { state } from './state.js';

const NS = 'http://www.w3.org/2000/svg';
const REDUCED = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- 环的方程(来自 demo,原样) ----
const CX = 511; const CY = 672;
const RINGS = [
  { a: 423, b: 104, ang: -16 * Math.PI / 180, core: '#E7C47A', hi: '#FFF6DC', glowO: 0.5 },
  { a: 387, b: 158, ang: 48 * Math.PI / 180, core: '#E8CFA0', hi: '#FFF9E8', glowO: 0.42 },
];
RINGS.forEach((r) => { r.cos = Math.cos(r.ang); r.sin = Math.sin(r.ang); });

function pt(r, t) {
  const x0 = r.a * Math.cos(t); const y0 = r.b * Math.sin(t);
  return { x: CX + x0 * r.cos - y0 * r.sin, y: CY + x0 * r.sin + y0 * r.cos, z: Math.sin(t) };
}

// 路径是静态的,算一次存着 —— render() 会重跑很多次,不该每次重算 256 个点。
const pathCache = new Map();
function arcPath(ringIndex, zsign) {
  const key = `${ringIndex}:${zsign}`;
  if (pathCache.has(key)) return pathCache.get(key);
  const r = RINGS[ringIndex];
  let d = ''; let pen = false;
  for (let i = 0; i <= 256; i++) {
    const t = i / 256 * Math.PI * 2; const p = pt(r, t);
    if ((zsign > 0 && p.z >= -0.02) || (zsign < 0 && p.z <= 0.02)) {
      d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)} `; pen = true;
    } else pen = false;
  }
  pathCache.set(key, d);
  return d;
}

const BEADS = [
  { ring: 0, grad: 'gGold', r: 4.6, speed: 0.50, phase: 0.0 },
  { ring: 0, grad: 'gWhite', r: 3.1, speed: 0.50, phase: 2.6 },
  { ring: 1, grad: 'gBlue', r: 3.7, speed: -0.62, phase: 1.2 },
  { ring: 1, grad: 'gGold', r: 2.6, speed: -0.62, phase: 4.3 },
  { ring: 0, grad: 'gGold', r: 9.7, speed: 0.18, phase: 1.4, glint: true },
  { ring: 1, grad: 'gGold', r: 8.6, speed: -0.15, phase: 3.0, glint: true },
];

const mk = (tag, attrs, parent) => {
  const el = document.createElementNS(NS, tag);
  for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k]);
  parent.appendChild(el);
  return el;
};

// ---- 页头主星的 HTML(渲染期出字符串,水合期再挂 SVG) ----
const ORB_SRC = {
  chat: 'star-private-core.webp',
  group: 'star-group.webp',
  console: 'star-console.webp',
};

export function orbMarkup(tab, size = 56) {
  const src = ORB_SRC[tab];
  if (!src) return '';
  // data-orb-rings 只有私聊主星有 —— 图纸:群聊/控制台只摇曳+呼吸,不装环
  const rings = tab === 'chat' ? ' data-orb-rings="1"' : '';
  return `<div class="orb" style="--orb-size:${size}px"${rings} aria-hidden="true">
    <svg class="orb-back" viewBox="0 0 1024 1536"></svg>
    <img src="/assets/stars/${src}" alt="">
    <svg class="orb-front" viewBox="0 0 1024 1536"></svg>
  </div>`;
}

let beadRegistry = [];
let rafId = 0;

function buildDefs(svg, idx) {
  const defs = mk('defs', {}, svg);
  const f = mk('filter', { id: `orbGlow${idx}`, x: '-60%', y: '-60%', width: '220%', height: '220%' }, defs);
  mk('feGaussianBlur', { stdDeviation: 9 }, f);
  [['gGold', '#FFF6DC', '#E7C47A'], ['gWhite', '#FFFFFF', '#DCE6FF'], ['gBlue', '#F0F6FF', '#8DAFF8']].forEach((g) => {
    const rg = mk('radialGradient', { id: g[0] + idx }, defs);
    mk('stop', { offset: '0%', 'stop-color': g[1] }, rg);
    mk('stop', { offset: '45%', 'stop-color': g[2] }, rg);
    mk('stop', { offset: '75%', 'stop-color': g[2], 'stop-opacity': 0 }, rg);
  });
}

// 把「想在屏幕上看到几像素」换算成 viewBox 单位。1024 是素材宽。
const vb = (screenPx, sizePx) => (screenPx * 1024) / sizePx;

function hydrateOrb(node, seq) {
  const svgB = node.querySelector('.orb-back');
  const svgF = node.querySelector('.orb-front');
  if (!svgB || !svgF || svgB.childElementCount) return; // 已经挂过就别重挂
  const idB = seq * 2; const idF = seq * 2 + 1;
  buildDefs(svgB, idB);
  buildDefs(svgF, idF);
  if (!node.dataset.orbRings) return; // 群聊/控制台:只要星本体,不装环

  const size = parseFloat(node.style.getPropertyValue('--orb-size')) || 56;
  // 目标屏幕线宽 —— demo 在 400px 上是 10 / 3.9 / 1.4px,这里按尺寸缩了一档还留得住
  const wGlow = vb(3.4, size); const wCore = vb(1.35, size); const wHi = vb(0.55, size);

  RINGS.forEach((r, ri) => {
    [[svgB, -1, 0.55, idB], [svgF, 1, 1, idF]].forEach(([svg, zs, op, fid]) => {
      const d = arcPath(ri, zs);
      mk('path', { d, fill: 'none', stroke: r.core, 'stroke-width': wGlow, 'stroke-linecap': 'round', opacity: r.glowO * op, filter: `url(#orbGlow${fid})` }, svg);
      mk('path', { d, fill: 'none', stroke: r.core, 'stroke-width': wCore, 'stroke-linecap': 'round', opacity: op }, svg);
      mk('path', { d, fill: 'none', stroke: r.hi, 'stroke-width': wHi, 'stroke-linecap': 'round', opacity: 0.9 * op }, svg);
    });
    // 环身七颗静止碎星。★ 这个尺寸是定过稿的,别改小 —— 但那是按大图定的,
    // 换算到页头尺寸后按屏幕像素守住(1.5px),不是照搬 viewBox 里的 12。
    for (let k = 0; k < 7; k++) {
      const p = pt(r, k / 7 * Math.PI * 2 + 0.4);
      const front = p.z >= 0;
      mk('circle', { cx: p.x, cy: p.y, r: vb(1.5, size), fill: `url(#gGold${front ? idF : idB})`, opacity: front ? 0.95 : 0.5 },
        front ? svgF : svgB);
    }
  });

  BEADS.forEach((b) => {
    const scale = vb(1, size);
    const elB = mk('circle', { r: b.r * scale, fill: `url(#${b.grad}${idB})` }, svgB);
    const elF = mk('circle', { r: b.r * scale, fill: `url(#${b.grad}${idF})` }, svgF);
    if (b.glint) { elB.setAttribute('filter', `url(#orbGlow${idB})`); elF.setAttribute('filter', `url(#orbGlow${idF})`); }
    beadRegistry.push({ ...b, elB, elF });
  });
}

function tick(ms) {
  for (const b of beadRegistry) {
    const p = pt(RINGS[b.ring], ms / 1000 * b.speed + b.phase);
    const sc = 0.82 + 0.18 * (p.z + 1) / 2;
    const front = p.z >= 0;
    const on = front ? b.elF : b.elB; const off = front ? b.elB : b.elF;
    on.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) scale(${sc.toFixed(3)})`);
    on.setAttribute('opacity', b.glint ? (front ? 0.9 : 0.35) : (front ? 1 : 0.55));
    off.setAttribute('opacity', 0);
  }
  rafId = requestAnimationFrame(tick);
}

// ---- 背景星野 ----
// 挂在 body 上而不是 app 根节点里:render() 是整片 innerHTML 重写,
// 放里面每次重render 都要重造 70 个节点,还会让闪烁动画从头开始(整屏一起闪)。
let field = null;
function mountField() {
  if (field && field.isConnected) return;
  field = document.createElement('div');
  field.className = 'starfield';
  field.setAttribute('aria-hidden', 'true');
  const n = REDUCED() ? 40 : 70; // 图纸:≤80,用 CSS animation 走合成层
  let html = '';
  for (let i = 0; i < n; i++) {
    const size = (Math.random() * 1.8 + 0.6).toFixed(1);
    html += `<i style="width:${size}px;height:${size}px;left:${(Math.random() * 100).toFixed(2)}%;top:${(Math.random() * 100).toFixed(2)}%;`
      + `--o:${(Math.random() * 0.5 + 0.25).toFixed(2)};--dur:${(Math.random() * 3 + 2).toFixed(1)}s;--delay:${(Math.random() * 4).toFixed(1)}s"></i>`;
  }
  field.innerHTML = html;
  document.body.appendChild(field);
}
function unmountField() {
  if (field) { field.remove(); field = null; }
}

// 每次 render 之后调一次。主题不是 starry 就把东西收干净。
export function hydrateStarry(root) {
  const on = state.settings && state.settings.theme === 'starry';
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  beadRegistry = [];
  if (!on) { unmountField(); return; }
  mountField();
  const orbs = (root || document).querySelectorAll('.orb');
  orbs.forEach((node, i) => hydrateOrb(node, i));
  if (beadRegistry.length) {
    if (REDUCED()) tickOnce();
    else rafId = requestAnimationFrame(tick);
  }
}

// reduced-motion:珠子摆一次静止位置就不动了(图纸:动画停,珠子隐藏,只留静态星+静态环)
function tickOnce() {
  for (const b of beadRegistry) { b.elB.setAttribute('opacity', 0); b.elF.setAttribute('opacity', 0); }
}
