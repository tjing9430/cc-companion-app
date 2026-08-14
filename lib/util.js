// 纯函数工具箱:字符串清洗、数值钳制、文件名/MIME、附件与消息的公共形状。
// 只依赖 node:path,不碰 store 和网络 —— 谁都能安全 import 它。
import path from 'node:path';

function publicMessage(message) {
  const out = { ...message, attachments: normalizeAttachments(message.attachments) };
  // A recalled message keeps its content in the store (trace) but must not leak it over the API.
  if (out.recalled) { out.content = ''; out.attachments = []; }
  return out;
}

function normalizeAttachments(input) {
  if (!Array.isArray(input)) return [];
  return input.map((item) => ({
    url: cleanString(item && item.url, ''),
    name: cleanString(item && item.name, 'attachment'),
    type: cleanString(item && item.type, ''),
    size: Number(item && item.size) || 0,
    original_size: positiveInt(item && item.original_size),
    width: positiveInt(item && item.width),
    height: positiveInt(item && item.height),
    optimized: item && item.optimized === true,
    sticker: item && item.sticker === true,
  })).filter((item) => item.url);
}

function normalizeTags(input) {
  const source = Array.isArray(input) ? input : String(input || '').split(',');
  return Array.from(new Set(source.map((tag) => cleanString(tag, '').toLowerCase()).filter(Boolean))).slice(0, 12);
}

function defaultMemoryMood(tags = []) {
  return '平静';
}

function cleanString(value, fallback) {
  const text = String(value == null ? '' : value).replace(/\r/g, '').trim();
  return text || fallback;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

// 设置项里的数值(滑杆那类)。
//
// ★★ 为什么不复用 clampLimit / positiveInt:**它们会把合法的 0 吃掉。**
//    `Number(0) || 80` → 80 —— `||` 认为 0 是"没填"。
//    滑杆拖到最左端(0% 不透明度)本来是个正当选择,却会被静默改回默认值,
//    用户看到的是"拖到底就弹回去了",而**没有任何报错**。
//
// ★★ 另外两个 `Number()` 的坑,也是这里显式挡掉的原因:
//    `Number(true) === 1`  → 布尔会伪装成一个合法数字混进来
//    `Number([]) === 0`    → 空数组也是
//    JSON 从网络进来,这两种形状都可能出现(前端写错、老客户端、手改的库)。
//    ⇒ 只接受 number 和**能整体解析成数字的字符串**,别的一律回落默认。
//
// ★ 为什么这件事值得这么小心:非法值往下游走会变成 CSS 的 `opacity: NaN`,
//   而 **CSS 对非法声明的处理是安静地当没这条** —— 面板看着正常、拖动毫无反应、
//   控制台不报错。失败长得跟"没生效"一模一样,那是最难查的一类。
function cleanNumber(value, fallback, min = -Infinity, max = Infinity) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return fallback;                 // null / undefined / 布尔 / 数组 / 对象 / 空串
  if (!Number.isFinite(n)) return fallback;   // NaN、Infinity 都挡在这儿
  return Math.min(max, Math.max(min, n));
}

function clampLimit(limit) {
  const n = Number(limit) || 80;
  return Math.min(500, Math.max(1, n));
}

function positiveInt(value) {
  const n = Number(value) || 0;
  return n > 0 ? Math.round(n) : 0;
}

function cleanFileName(name) {
  /* 这是显示名,不是落盘名(落盘名由服务端生成)。原来的 \w 白名单把中文全洗成
     下划线 ——「给同事.md」变「_.md」。改成黑名单:只挡路径分隔、Windows 禁字符
     和控制符,中文/空格放行;渲染端 esc 兜 XSS。

     * 后面那四段(200b-200f / 202a-202e / 2066-2069 / feff)是 8/14 补的:白名单换
     黑名单时连带丢的一面 —— 双向控制符和零宽字符既不在控制符区、也不是 Windows
     禁字符,原样通过。「发票<U+202E>gpj.exe」在界面上渲成「发票exe.jpg」。
     esc() 挡不住:它们不是 HTML 元字符,转义后原样输出。
     这个端点上尤其要管 —— 显示名是分身填的,而分身读得到 workspace 和网页。
     (内联执行那条路另有两道闸:html/svg 不进扩展名表 + octet-stream 兜底) */
  return String(name || 'upload.bin')
    .replace(/[\/\\<>:"|?*\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, '_')
    .slice(0, 120).trim() || 'upload.bin';
}

function extensionForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'text/plain') return '.txt';
  if (mime === 'text/markdown') return '.md';
  if (mime === 'application/pdf') return '.pdf';
  /* .html/.svg 故意不进表:octet-stream 兜底逼浏览器下载而不是内联渲染,
     分身递出来的文件没有 XSS 面。加类型前先想这一条。 */
  return '.bin';
}

function storedMimeForExtension(ext) {
  const types = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
  };
  return types[ext] || 'application/octet-stream';
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
  };
  return types[ext] || 'application/octet-stream';
}

function isPathInside(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export {
  cleanString,
  cleanNumber, truncate, clampLimit, positiveInt,
  cleanFileName, extensionForMime, storedMimeForExtension, contentTypeFor, isPathInside,
  normalizeTags, defaultMemoryMood, normalizeAttachments, publicMessage,
};
