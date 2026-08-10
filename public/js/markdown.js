// 聊天气泡的轻量 markdown。纯函数,只依赖 util 的转义。

import { esc, escAttr } from './util.js';

const MD_MARK = '\u0001';

const MD_URL_OK = /^(https?:\/\/|mailto:)/i;

function mdSafeUrl(escapedUrl) {
  const u = String(escapedUrl || '').trim();
  return MD_URL_OK.test(u) ? u : '';
}

function mdInline(s) {
  let out = s;
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const safe = mdSafeUrl(url);
    return safe
      ? '<a class="md-link" href="' + safe + '" target="_blank" rel="noopener noreferrer">' + text + '</a>'
      : m;
  });
  out = out.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
  return out;
}

function renderMarkdown(value) {
  const src = String(value == null ? '' : value).split(MD_MARK).join('');
  let s = esc(src);
  const slots = [];
  const stash = (html) => MD_MARK + 'B' + (slots.push(html) - 1) + MD_MARK;

  s = s.replace(/```([a-zA-Z0-9_+-]*)\r?\n?([\s\S]*?)```/g, (m, lang, code) =>
    stash('<pre class="md-pre"><code>' + code.replace(/\n$/, '') + '</code></pre>'));
  s = s.replace(/`([^`\n]+)`/g, (m, code) => stash('<code class="md-code">' + code + '</code>'));

  const html = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (!para.length) return;
    html.push('<p>' + mdInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push('<' + list.type + ' class="md-list">'
      + list.items.map((it) => '<li>' + mdInline(it) + '</li>').join('')
      + '</' + list.type + '>');
    list = null;
  };

  for (const line of s.split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); flushList();
      const lv = heading[1].length + 2;
      html.push('<h' + lv + ' class="md-h">' + mdInline(heading[2]) + '</h' + lv + '>');
    } else if (bullet || ordered) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (!list || list.type !== type) { flushList(); list = { type: type, items: [] }; }
      list.items.push(bullet ? bullet[1] : ordered[1]);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList(); para.push(line);
    }
  }
  flushPara(); flushList();

  const re = new RegExp(MD_MARK + 'B(\\d+)' + MD_MARK, 'g');
  return html.join('').replace(re, (m, i) => slots[Number(i)] || '');
}

export { renderMarkdown, mdInline, mdSafeUrl };
