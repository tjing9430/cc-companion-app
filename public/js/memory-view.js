// 记忆页全家:首屏三张撕纸便签 / 日记列表 / 全屏本子 / 写日记 / 资料库。
// 事件路由留在 app.js 壳里:换皮只动渲染,壳不动。
// ★ 记忆页 UI 明天不许动(星空主题的红线),所以这一刀纯搬位置,一个字节没改渲染。
import { esc, escAttr, formatDateTime, formatDocSize, memoryTime, memoryMonthLabel, memoryMood } from './util.js';
import { state, memoryAuthor } from './state.js';
import { renderMarkdown } from './markdown.js';

// 顶栏在记忆 tab 上显示的是「当前这一叠」的名字和条数,页里就不再写一遍
function memoryTabHeading() {
  const everything = Array.isArray(state.memories) ? state.memories : [];
  const isAuto = (m) => (m.tags || []).some((t) => String(t) === 'auto');
  const tagFilter = state.memoryTagFilter || '';
  const countOf = (list) => (tagFilter ? list.filter((m) => (m.tags || []).some((t) => String(t) === tagFilter)).length : list.length);
  const tail = tagFilter ? ` · 「${tagFilter}」` : ' · 点标题进去看全文';
  if (state.memoryTab === 'docs') {
    const docs = Array.isArray(state.documents) ? state.documents : [];
    return { back: true, title: '资料库', subtitle: `${docs.length} 份 · ${state.settings.assistantName || 'AI'}也读得到` };
  }
  if (state.memoryTab === 'config') {
    const files = Array.isArray(state.configFiles) ? state.configFiles : [];
    return { back: true, title: '配置', subtitle: `${files.length} 个 Hook / Skill / MD 文件` };
  }
  if (state.memoryTab === 'all') {
    return { back: true, title: '全部条目', subtitle: `${countOf(everything)} 条${tail}` };
  }
  if (state.memoryTab === 'diary') {
    return { back: true, title: '日记', subtitle: `${countOf(everything.filter((m) => !isAuto(m)))} 篇${tail}` };
  }
  return { title: '记忆', subtitle: '今天想翻哪一叠?' };
}

// 撕纸的毛边 = feTurbulence 位移,只作用在「纸面层」;字浮在上面,一点不糊
const TORN_DEFS = `
<svg class="torn-defs" width="0" height="0" aria-hidden="true" focusable="false">
  <filter id="tornA"><feTurbulence type="fractalNoise" baseFrequency="0.016 0.042" numOctaves="4" seed="7" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="16" xChannelSelector="R" yChannelSelector="G"/></filter>
  <filter id="tornB"><feTurbulence type="fractalNoise" baseFrequency="0.018 0.038" numOctaves="4" seed="21" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="14" xChannelSelector="R" yChannelSelector="G"/></filter>
  <filter id="tornC"><feTurbulence type="fractalNoise" baseFrequency="0.015 0.045" numOctaves="4" seed="42" result="n"/>
    <feDisplacementMap in="SourceGraphic" in2="n" scale="18" xChannelSelector="R" yChannelSelector="G"/></filter>
</svg>`;

// 记忆首屏:三张撕纸便签贴在横线纸上 —— 「今天想翻哪一叠?」
function renderMemoryHome() {
  const all = Array.isArray(state.memories) ? state.memories : [];
  const mine = all.filter((m) => !(m.tags || []).some((t) => String(t) === 'auto'));
  const docs = Array.isArray(state.documents) ? state.documents : [];
  const note = (cls, tab, kicker, name, count, unit) => `
    <button type="button" class="mem-note ${cls}" data-action="memory-tab" data-tab="${tab}">
      <span class="mem-note-paper" aria-hidden="true"></span>
      <span class="mem-note-grid" aria-hidden="true"></span>
      <span class="mem-note-tape" aria-hidden="true"></span>
      <span class="mem-note-kicker">${kicker}</span>
      <span class="mem-note-name">${name}</span>
      <span class="mem-note-count">${count} ${unit}</span>
    </button>`;
  return `
    <div class="mem-home">
      ${TORN_DEFS}
      ${note('n1 a', 'diary', 'DIARY · 自己写的', '日记', mine.length, '篇')}
      ${note('n2 b', 'docs', 'DOCS · 存起来备查', '资料库', docs.length, '份')}
      ${note('n3 c', 'all', 'ALL · 聊天里自动记的', '全部条目', all.length, '条')}
      ${note('n4 a', 'config', 'CONFIG · HOOK / SKILL / MD', '配置', (state.configFiles || []).length || '打开', (state.configFiles || []).length ? '份' : '')}
      <span class="mem-home-dot" aria-hidden="true"></span>
      <span class="mem-home-heart" aria-hidden="true">♡</span>
    </div>`;
}

function renderMemory() {
  // 返回箭头在顶栏(‹ 日记),页里不再放导航
  if (state.memoryTab === 'home') return renderMemoryHome();
  if (state.memoryTab === 'docs') return renderDocs();
  if (state.memoryTab === 'config') return renderConfigLibrary();
  const editing = state.memoryEditing;
  const writerOpen = Boolean(editing || state.memoryWriterOpen);
  const editTags = editing && Array.isArray(editing.tags) ? editing.tags.join(', ') : '';
  const editMood = editing ? memoryMood(editing) : '';
  const editAuthor = editing ? memoryAuthor(editing) : (state.settings.userName || '你');
  const everything = Array.isArray(state.memories) ? state.memories : [];
  // 日记 = 自己写的;全部条目 = 连聊天里自动记的一起(auto 标签是提取器打的)
  const isAll = state.memoryTab === 'all';
  const all = isAll ? everything : everything.filter((m) => !(m.tags || []).some((t) => String(t) === 'auto'));
  const tagFilter = state.memoryTagFilter || '';
  const shown = tagFilter ? all.filter((m) => (m.tags || []).some((t) => String(t) === tagFilter)) : all;
  const view = state.memoryView === 'timeline' ? 'timeline' : 'cards';
  // 找东西的家什(搜索/标签/视图)默认收起,只在点了放大镜时落下来 —— 日记页要留白
  const toolsOpen = Boolean(state.memoryToolsOpen || state.memoryQuery || tagFilter);
  const searchRow = `
    <div class="search-row memory-search">
      <input data-memory-search="1" placeholder="搜索记忆" value="${escAttr(state.memoryQuery)}">
      ${state.memoryQuery ? '<button class="ghost" type="button" data-action="clear-memory-search">清空</button>' : ''}
    </div>`;
  const viewToggle = `
    <div class="memory-viewtoggle">
      <button type="button" class="${view === 'cards' ? 'on' : ''}" data-action="memory-view" data-view="cards">卡片</button>
      <button type="button" class="${view === 'timeline' ? 'on' : ''}" data-action="memory-view" data-view="timeline">时间线</button>
    </div>`;
  // 全部条目是「翻库」的地方:搜索框和标签一直摆在外面,跟内容一起往上滚
  // 日记只有几篇、要留白,还是收在放大镜里
  if (isAll) {
    return `
      <div class="memory-view mem-lib">
        ${searchRow}
        <div class="mem-tag-scroll">${renderMemoryTagChips(all)}</div>
        <div class="memory-list">
          ${shown.length
            ? shown.map(renderMemoryItem).join('')
            : `<div class="empty">${state.memoryQuery || tagFilter ? '没有匹配的记忆。' : '还没有记忆。'}</div>`}
        </div>
      </div>`;
  }
  return `
    <div class="memory-view">
      <div class="diary-head">
        <span></span>
        <div class="diary-head-acts">
          <button type="button" class="diary-tool${toolsOpen ? ' on' : ''}" data-action="toggle-memory-tools" aria-label="搜索和筛选" aria-expanded="${toolsOpen}">${ICON_SEARCH}</button>
          <button type="button" class="diary-write" data-action="toggle-memory-writer">✎ 写日记</button>
        </div>
      </div>
      ${writerOpen ? renderMemoryWriter(editing, editMood, editAuthor, editTags) : ''}
      ${toolsOpen ? `
      <div class="diary-tools">
        ${searchRow}
        <div class="diary-tools-row">
          ${renderMemoryTagChips(all)}
          ${viewToggle}
        </div>
      </div>` : ''}
      <div class="memory-list">
        ${shown.length
          ? (view === 'timeline' ? renderMemoryTimeline(shown) : shown.map(renderMemoryItem).join(''))
          : `<div class="empty">${state.memoryQuery || tagFilter ? '没有匹配的记忆。' : '还没有记忆。'}</div>`}
      </div>
    </div>`;
}

function renderConfigLibrary() {
  const files = Array.isArray(state.configFiles) ? state.configFiles : [];
  const labels = { md: '核心 MD', hook: 'HOOK 配置与脚本', skill: 'SKILL' };
  const groups = ['md', 'hook', 'skill'].map((kind) => ({ kind, rows: files.filter((file) => file.kind === kind) }));
  const editor = state.configFileEditing;
  const editMode = Boolean(state.configFileEditMode);
  const markdownFile = Boolean(editor && /\.(md|markdown)$/i.test(editor.name || ''));
  return `
    <div class="memory-view config-library">
      <div class="config-library-note">这里保存的是 agent 真正读取和执行的配置文件。保存后会直接写回本机文件。</div>
      ${state.configFileStatus ? `<div class="sticker-status${String(state.configFileStatus).startsWith('保存失败') ? ' err' : ''}">${esc(state.configFileStatus)}</div>` : ''}
      ${groups.map((group) => `
        <section class="config-file-group">
          <h2>${labels[group.kind]}</h2>
          ${group.rows.length ? group.rows.map((file) => `
            <button type="button" class="config-file-row" data-action="open-config-file" data-id="${escAttr(file.id)}">
              <span class="config-file-main"><strong>${esc(file.name)}</strong><small>${esc(file.display_path)}</small></span>
              <span class="config-file-size">${formatDocSize(file.size)}</span>
            </button>`).join('') : '<div class="config-file-empty">没有找到文件</div>'}
        </section>`).join('')}
    </div>
    ${editor ? `
      <section class="config-file-editor" role="dialog" aria-label="编辑 ${escAttr(editor.name)}">
        <header>
          <button type="button" class="config-editor-back" data-action="close-config-editor" aria-label="返回上一页">‹</button>
          <div><strong>${esc(editor.name)}</strong><small>${esc(editor.display_path)}</small></div>
          ${editMode ? '' : `<button type="button" class="config-edit-btn" data-action="enable-config-edit" aria-label="编辑文件" title="编辑"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.5-.7 4.2 4.2-.7L19 8.5 15.5 5 4 16.5Z"/><path d="m13.8 6.7 3.5 3.5"/></svg></button>`}
        </header>
        <form data-config-file-form="1" data-id="${escAttr(editor.id)}" class="${editMode ? 'is-editing' : 'is-reading'}">
          ${editMode
            ? `<textarea name="content" spellcheck="false">${esc(editor.content || '')}</textarea>`
            : markdownFile
              ? `<div class="config-file-readonly config-markdown body-text md">${renderMarkdown(editor.content || '')}</div>`
              : `<pre class="config-file-readonly">${esc(editor.content || '')}</pre>`}
          <div class="config-editor-actions">
            <span>${formatDocSize(new Blob([editor.content || '']).size)}</span>
            ${editMode ? '<button type="submit" class="primary">保存</button>' : ''}
          </div>
        </form>
      </section>` : ''}`;
}

function renderDocs() {
  const docs = Array.isArray(state.documents) ? state.documents : [];
  return `
    <div class="memory-view">
      <div class="doc-toolbar">
        <button class="memory-writer-card doc-add" type="button" data-action="open-doc-picker">
          <span class="memory-writer-icon" aria-hidden="true">↑</span>
          <span>
            <span class="memory-writer-title">上传文件</span>
            <span class="memory-writer-subtitle">txt / md 等文本</span>
          </span>
        </button>
        <button class="memory-writer-card doc-add" type="button" data-action="toggle-doc-writer">
          <span class="memory-writer-icon" aria-hidden="true">+</span>
          <span>
            <span class="memory-writer-title">写一份</span>
            <span class="memory-writer-subtitle">直接打字</span>
          </span>
        </button>
      </div>
      ${state.docStatus ? `<div class="sticker-status${String(state.docStatus).startsWith('失败') ? ' err' : ''}">${esc(state.docStatus)}</div>` : ''}
      ${state.docWriterOpen ? `
      <section class="panel memory-editor">
        <div class="memory-editor-head">
          <div class="memory-editor-title">写资料</div>
          <button class="ghost" type="button" data-action="toggle-doc-writer">收起</button>
        </div>
        <form class="stack" data-doc-form="1">
          <div class="form-row"><label>名字</label><input name="name" maxlength="120" placeholder="比如：我的设定集"></div>
          <div class="form-row"><label>内容</label><textarea name="content" rows="8" placeholder="粘贴或输入任意背景资料，AI 聊天时会参考其中相关的段落。"></textarea></div>
          <div class="composer-actions"><button class="primary" type="submit">保存资料</button></div>
        </form>
      </section>` : ''}
      <div class="memory-list">
        ${docs.length ? docs.map(renderDocItem).join('') : '<div class="empty">还没有资料。上传文本文件或直接写一份，AI 聊天时会参考相关段落。</div>'}
      </div>
    </div>`;
}

function renderDocItem(doc) {
  const id = Number(doc.id);
  const open = state.docOpen[id] === true;
  const full = state.docContent[id];
  return `
    <article class="memory-item ${open ? 'open' : ''}">
      <button class="memory-summary" type="button" data-action="toggle-doc" data-id="${doc.id}" aria-expanded="${open ? 'true' : 'false'}">
        <div class="memory-summary-main">
          <div class="memory-title">${esc(doc.name)}</div>
          <div class="memory-meta">
            <span>${doc.source === 'upload' ? '上传' : '手写'}</span>
            <span>·</span>
            <span>${formatDocSize(doc.size)}</span>
            <span>·</span>
            <time>${esc(formatDateTime(doc.updated_at || doc.created_at))}</time>
          </div>
          ${!open && doc.preview ? `<div class="memory-preview">${esc(doc.preview)}</div>` : ''}
        </div>
        <span class="memory-chevron" aria-hidden="true">▾</span>
      </button>
      ${open ? `
        <div class="memory-content">${esc(full == null ? '加载中…' : full)}</div>
        <div class="memory-rule"></div>
        <div class="memory-actions">
          <button class="danger" data-action="delete-document" data-id="${doc.id}" type="button">删除</button>
        </div>
      ` : ''}
    </article>`;
}

// 六个快选 + 「自己写一个」输入框 —— 心情本身是自由短语,规格不对齐就一眼看得出
// 谁是系统给的、谁是自己写的
const MEMORY_MOODS = ['☀ 晴', '☁ 阴', '☂ 雨天', '✿ 雀跃', '· 平静', '~ 疲惫'];

function renderMemoryWriter(editing, editMood, editAuthor, editTags) {
  return `
    <section class="panel memory-editor">
      <div class="memory-editor-head">
        <div class="memory-editor-title">${editing ? '编辑这篇日记' : '写日记'}</div>
        <button class="ghost" type="button" data-action="${editing ? 'cancel-memory-edit' : 'toggle-memory-writer'}">收起</button>
      </div>
      <form class="stack" data-memory-form="1">
        <div class="memory-form-grid">
          <div class="form-row"><label>标题</label><input name="title" maxlength="120" value="${escAttr(editing && editing.title || '')}"></div>
          <div class="form-row memory-mood-row">
            <label>心情</label>
            <div class="memory-mood-picks">
              ${MEMORY_MOODS.map((m) => `<button type="button" class="memory-mood-pick${editMood === m ? ' on' : ''}" data-action="memory-mood-pick" data-mood="${escAttr(m)}">${esc(m)}</button>`).join('')}
            </div>
            <input name="mood" maxlength="40" placeholder="或者自己写一个…" value="${escAttr(editMood)}">
          </div>
          <div class="form-row"><label>作者</label><input name="author" maxlength="80" value="${escAttr(editAuthor)}"></div>
          <div class="form-row"><label>标签</label><input name="tags" placeholder="日记, 偏好" value="${escAttr(editTags)}"></div>
          <div class="form-row"><label>事实键</label><input name="fact_key" maxlength="60" placeholder="选填,例:住处 / 生日" value="${escAttr(editing && editing.fact_key || '')}"></div>
        </div>
        <div class="form-row"><label>内容</label><textarea name="content">${esc(editing && editing.content || '')}</textarea></div>
        <div class="composer-actions">
          <button class="primary" type="submit">${editing ? '保存修改' : '保存日记'}</button>
          ${editing ? '<button class="ghost" type="button" data-action="cancel-memory-edit">取消</button>' : ''}
        </div>
      </form>
    </section>`;
}

// 月牙用内联 SVG,不用 emoji —— 部分安卓 WebView 没有彩色 emoji 字体会渲成豆腐块
const MEMORY_MOON = '<svg class="memory-moon" viewBox="0 0 12 12" aria-hidden="true"><path d="M9.4 7.85A4.25 4.25 0 0 1 4.15 2.6 4.25 4.25 0 1 0 9.4 7.85Z"/></svg>';

// 画的,不用 emoji —— 🔍 在部分 WebView 里是豆腐块
const ICON_SEARCH = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 13.5 13.5"/></svg>';

// 卡片 = 标题(可换行) + 心情签右上 / 月牙·作者·时间 / 细线 / [编辑][删除]
// 不放正文预览:点标题进全屏本子看全文(卡片下面不放正文,只放编辑/删除)
function renderMemoryItem(memory) {
  const mood = memoryMood(memory);
  const author = memoryAuthor(memory);
  const time = formatDateTime(memory.updated_at || memory.created_at);
  // 被同一事实键的新记忆顶替了:留在列表里可回溯,但已经不喂给 AI 了,得让人一眼看出来。
  const stale = Boolean(memory.superseded_by);
  return `
    <article class="memory-card${stale ? ' memory-card-stale' : ''}">
      <button class="memory-card-top" type="button" data-action="open-memory-reader" data-id="${memory.id}">
        <span class="memory-card-title">${memory.pinned ? '<span class="memory-pin" title="已置顶：永远带给 agent">📌</span>' : ''}${esc(memory.title)}</span>
        ${mood ? `<span class="memory-mood">${esc(mood)}</span>` : ''}
      </button>
      <div class="memory-card-meta">
        ${MEMORY_MOON}<span class="memory-card-who">${esc(author)}</span>
        <span class="memory-card-time">· ${esc(time)}</span>
        ${stale ? '<span class="memory-stale-tag" title="同一件事有更新的说法了,这条不再讲给 AI 听">已被顶替</span>' : ''}
        ${!stale && memory.fact_key ? `<span class="memory-key-tag" title="事实键:同键只有最新一条会讲给 AI 听">${esc(memory.fact_key)}</span>` : ''}
      </div>
      <div class="memory-card-foot">
        <button class="memory-act" data-action="edit-memory" data-id="${memory.id}" type="button">编辑</button>
        <button class="memory-act memory-act-del" data-action="delete-memory" data-id="${memory.id}" type="button">删除</button>
        <button class="memory-act memory-act-pin" data-action="toggle-pin" data-id="${memory.id}" data-pinned="${memory.pinned ? '1' : ''}" type="button">${memory.pinned ? '取消置顶' : '置顶'}</button>
      </div>
    </article>`;
}

// 点开一篇 → 全屏「本子」:横线纸 + 大返回键(88×44,系统推荐最小可点尺寸)
function renderMemoryReader() {
  const id = Number(state.memoryReading);
  if (!id) return '';
  const memory = (state.memories || []).find((item) => Number(item.id) === id);
  if (!memory) return '';
  const mood = memoryMood(memory);
  const time = formatDateTime(memory.updated_at || memory.created_at);
  const tags = (memory.tags || []).filter(Boolean);
  return `
    <div class="memory-reader" role="dialog" aria-label="${escAttr(memory.title)}">
      <div class="memory-reader-bar">
        <button class="memory-back" type="button" data-action="close-memory-reader" aria-label="返回上一页">‹</button>
        <strong class="memory-reader-heading">日记</strong>
        <span class="memory-reader-right">
          ${mood ? `<span class="memory-mood">${esc(mood)}</span>` : ''}
          <span class="memory-reader-date">${esc(time)}</span>
        </span>
      </div>
      <div class="memory-reader-scroll">
        <h2 class="memory-reader-title">${esc(memory.title)}</h2>
        <div class="memory-reader-who">${MEMORY_MOON}${esc(memoryAuthor(memory))}</div>
        <div class="memory-reader-body">${esc(memory.content || '')}</div>
        ${tags.length ? `<div class="memory-tags">${tags.map((tag) => `<span>${esc(tag)}</span>`).join('')}</div>` : ''}
        <div class="memory-reader-foot">
          <button class="memory-act" data-action="edit-memory" data-id="${memory.id}" type="button">编辑</button>
          <button class="memory-act memory-act-del" data-action="delete-memory" data-id="${memory.id}" type="button">删除</button>
        </div>
      </div>
    </div>`;
}

function renderMemoryTagChips(memories) {
  const counts = new Map();
  for (const m of memories) for (const t of (m.tags || [])) {
    const tag = String(t || '').trim();
    if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  if (!counts.size) return '';
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const active = state.memoryTagFilter || '';
  const chip = (tag, label, count) => `<button type="button" class="memory-tag-chip${active === tag ? ' on' : ''}" data-action="memory-tag-filter" data-tag="${escAttr(tag)}">${esc(label)}<span class="memory-tag-count">${count}</span></button>`;
  return `<div class="memory-tag-chips">${chip('', '全部', memories.length)}${top.map(([t, c]) => chip(t, t, c)).join('')}</div>`;
}

function renderMemoryTimeline(memories) {
  const sorted = [...memories].sort((a, b) => memoryTime(b) - memoryTime(a));
  const order = [];
  const byKey = new Map();
  for (const m of sorted) {
    const key = memoryMonthLabel(m);
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key).push(m);
  }
  return order.map((label) => `
    <div class="memory-tl-group">
      <div class="memory-tl-head">${esc(label)}<span>${byKey.get(label).length}</span></div>
      ${byKey.get(label).map(renderMemoryItem).join('')}
    </div>`).join('');
}

export { renderMemory, renderMemoryReader, renderMemoryHome, renderDocs, renderConfigLibrary, memoryTabHeading, MEMORY_MOODS };
