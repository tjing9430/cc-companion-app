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
  let tbl = null;
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
  // 表格:`|…|` 行攒着,收尾时验「第二行是 |---|--- 分隔线」才算表 ——
  // 验不过就整段回退成普通段落,竖线原样可见。宁可裸奔也不把不是表的东西画成表。
  // (8/14 她真机抓的:AI 回了张功能对比表,气泡里全是竖线木板,笑场。)
  const tblCells = (row) => {
    let r = row.trim();
    if (r.startsWith('|')) r = r.slice(1);
    if (r.endsWith('|')) r = r.slice(0, -1);
    return r.split('|').map((c) => c.trim());
  };
  const tblIsSep = (row) => /^[|\s:-]+$/.test(row) && row.includes('-');
  const flushTbl = () => {
    if (!tbl) return;
    const rows = tbl; tbl = null;
    if (rows.length >= 2 && tblIsSep(rows[1])) {
      const head = tblCells(rows[0]);
      const body = rows.slice(2).map(tblCells);
      // 列数取全表最大值:GFM 是「多出的格子丢掉」,但丢的是**她的字** ——
      // 宁可表头多几个空格子,不吃内容。
      const cols = Math.max(head.length, ...body.map((r) => r.length), 1);
      const cell = (tag, cells, i) => '<' + tag + '>' + mdInline(cells[i] == null ? '' : cells[i]) + '</' + tag + '>';
      html.push('<div class="md-tbl-wrap"><table class="md-tbl"><thead><tr>'
        + Array.from({ length: cols }, (_, i) => cell('th', head, i)).join('')
        + '</tr></thead><tbody>'
        + body.map((cells) => '<tr>'
          + Array.from({ length: cols }, (_, i) => cell('td', cells, i)).join('')
          + '</tr>').join('')
        + '</tbody></table></div>');
    } else {
      para.push(...rows); flushPara();
    }
  };

  for (const line of s.split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const tableRow = /^\s*\|.*\|\s*$/.test(line);
    if (tableRow) {
      flushPara(); flushList();
      if (!tbl) tbl = [];
      tbl.push(line);
      continue;
    }
    flushTbl();
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
  flushTbl(); flushPara(); flushList();

  const re = new RegExp(MD_MARK + 'B(\\d+)' + MD_MARK, 'g');
  return html.join('').replace(re, (m, i) => slots[Number(i)] || '');
}

export { renderMarkdown, mdInline, mdSafeUrl };
