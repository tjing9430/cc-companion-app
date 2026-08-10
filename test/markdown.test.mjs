// renderMarkdown 单测:功能 + XSS。
// 它已经拆成 public/js/markdown.js 这个真模块 → 直接 import,不再走
// 「整个 app.js 塞进 vm、靠函数提升取函数」那套。app.js 一有 import 语句
// 那套就整个崩,而且崩得静默(函数取不到,测试自己 exit 1)。拆分把这层耦合
// 顶到台面上了,顺手换成正路。
import { renderMarkdown } from '../public/js/markdown.js';

const md = renderMarkdown;
if (typeof md !== 'function') { console.error('FATAL: renderMarkdown 没拿到'); process.exit(1); }

let pass = 0, fail = 0;
const t = (name, input, check) => {
  let out;
  try { out = md(input); } catch (e) { console.log(`✗ ${name} — 抛错 ${e.message}`); fail++; return; }
  const r = check(out);
  if (r === true) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name}\n    in : ${JSON.stringify(input)}\n    out: ${out}\n    why: ${r}`); }
};
const has = (s) => (out) => out.includes(s) || `缺 ${s}`;
const lacks = (s) => (out) => !out.includes(s) || `不该出现 ${s}`;
const all = (...fns) => (out) => { for (const f of fns) { const r = f(out); if (r !== true) return r; } return true; };

// ── 功能 ──
t('粗体', '**粗体**', has('<strong>粗体</strong>'));
t('斜体星', 'say *hi* now', has('<em>hi</em>'));
t('斜体下划线', 'say _hi_ now', has('<em>hi</em>'));
t('行内码', 'run `npm test` ok', has('<code class="md-code">npm test</code>'));
t('代码块', '```js\nconst a=1;\n```', all(has('<pre class="md-pre">'), has('const a=1;')));
t('代码块内不解析强调', '```\n**not bold**\n```', all(has('**not bold**'), lacks('<strong>')));
t('链接', '[点我](https://example.com)', all(has('href="https://example.com"'), has('>点我</a>'), has('rel="noopener noreferrer"')));
t('标题→h3', '# 标题', has('<h3 class="md-h">标题</h3>'));
t('三级标题→h5', '### 小标题', has('<h5 class="md-h">小标题</h5>'));
t('无序列表', '- 甲\n- 乙', all(has('<ul class="md-list">'), has('<li>甲</li>'), has('<li>乙</li>')));
t('有序列表', '1. 甲\n2. 乙', all(has('<ol class="md-list">'), has('<li>甲</li>')));
t('段落切分', 'a\n\nb', (o) => (o.match(/<p>/g) || []).length === 2 || `应两段,得 ${o}`);
t('段内换行→br', 'a\nb', has('<br>'));
t('列表里也能粗体', '- **重点**', has('<strong>重点</strong>'));

// ── XSS(重点)──
t('script 被转义', '<script>alert(1)</script>', all(lacks('<script'), has('&lt;script&gt;')));
t('img onerror 被转义', '<img src=x onerror=alert(1)>', all(lacks('<img'), has('&lt;img')));
t('javascript: 链接不生成 a', '[x](javascript:alert(1))', all(lacks('<a '), lacks('javascript:alert(1)"')));
t('大小写混淆 JaVaScRiPt: 也挡', '[x](JaVaScRiPt:alert(1))', lacks('<a '));
t('data: 链接不生成 a', '[x](data:text/html;base64,PHNjcmlwdD4=)', lacks('<a '));
t('href 引号无法逃逸', '[x](https://a.com" onmouseover="alert(1))', lacks('onmouseover="alert'));
t('代码块内 script 也转义', '```\n<script>bad()</script>\n```', all(lacks('<script'), has('&lt;script&gt;')));
t('占位符伪造无效', 'B0 **x**', all(lacks('<pre'), has('<strong>x</strong>')));
t('属性注入 via 标题', '# <img src=x onerror=alert(1)>', lacks('<img'));
t('链接文字里的标签被转义', '[<b>x</b>](https://a.com)', all(lacks('<b>'), has('&lt;b&gt;')));

// ── 边界 ──
t('空串不炸', '', (o) => o === '' || `应空串,得 ${JSON.stringify(o)}`);
t('null 不炸', null, (o) => o === '' || `应空串,得 ${JSON.stringify(o)}`);
t('纯文本原样', '就是一句普通的话', has('<p>就是一句普通的话</p>'));
t('单个星号不误伤', '3 * 4 = 12', lacks('<em>'));
t('中文长句不炸', '这是一段很长的中文'.repeat(30), has('<p>'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
