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
};
