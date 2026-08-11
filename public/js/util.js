// 纯工具:不碰 state、不碰 DOM 全局,谁都能 import。
// ★ 判据是「函数体里出不出现 state」——memoryAuthor 要 state.settings、
//   protectedAssetUrl 要 state.token,所以它俩不在这儿,留在 app.js。
//   第一版我把它们也搬了,整站直接 ReferenceError 掉回登录页,是基线比对抓出来的。

function esc(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escAttr(value) {
  return esc(value).replaceAll('`', '&#96;');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const parts = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('-');
  return `${parts} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase();
}

function isWideMessage(text, attachments = []) {
  if ((attachments || []).length) return true;
  const value = String(text || '');
  return value.includes('\n') || Array.from(value).length > 18;
}

function isNearBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 32;
}

function autosizeTextarea(node) {
  if (!node) return;
  node.style.height = 'auto';
  const next = Math.min(node.scrollHeight, 200);
  node.style.height = next + 'px';
}

function formatDocSize(size) {
  const n = Number(size) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} 字`;
}

function memoryTime(memory) {
  const ts = memory && (memory.updated_at || memory.created_at);
  const t = ts ? new Date(ts).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

function memoryMonthLabel(memory) {
  const ts = memory && (memory.updated_at || memory.created_at);
  if (!ts) return '未知时间';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '未知时间';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

function memoryMood(memory) {
  return String(memory && memory.mood || '平静').trim();
}

// 把一段正文按**段落**切成几块,给「长回复拆成几个小气泡」用。
//
// ★ 光按空行 split 是不行的:Markdown 里代码块、列表、表格、引用**内部也有空行**,
//   从中间切断会把一段代码劈成两半、把一个列表拆成两个列表,渲染出来是乱的。
//   所以只在**段落边界**切,遇到成块的结构就整块留着。
//
// 判据:一个空行要不要切,看它前后 —— 前后都还在同一种块结构里(都是列表项/表格行/
// 引用/缩进代码),那这个空行是结构内部的松散排版,不切;否则才是真正的段落边界。
const BLOCK_CONT = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+|^\s{0,3}\||^\s{0,3}>|^ {4,}\S/;
const FENCE = /^\s{0,3}(```+|~~~+)/;

function splitParagraphs(text) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return [];
  const lines = src.split('\n');
  const segs = [];
  let cur = [];
  let fence = '';
  const lastNonBlank = () => {
    for (let i = cur.length - 1; i >= 0; i--) if (cur[i].trim()) return cur[i];
    return '';
  };
  const flush = () => { const seg = cur.join('\n').trim(); if (seg) segs.push(seg); cur = []; };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {                                   // 围栏代码块:进去了就一路收到出来为止
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence[0])) fence = '';
      cur.push(line);
      continue;
    }
    if (fence || line.trim()) { cur.push(line); continue; }
    // 空行:往后看到下一个非空行,判断这是不是真的段落边界
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const next = j < lines.length ? lines[j] : '';
    if (next && BLOCK_CONT.test(next) && BLOCK_CONT.test(lastNonBlank())) { cur.push(line); continue; }
    flush();
  }
  flush();
  return segs.length ? segs : [src.trim()];
}

export {
  esc,
  escAttr,
  pad2,
  debounce,
  formatTime,
  formatDateTime,
  initials,
  isWideMessage,
  isNearBottom,
  autosizeTextarea,
  formatDocSize,
  memoryTime,
  memoryMonthLabel,
  memoryMood,
  splitParagraphs,
};
