// 聊天页(私聊/群聊共用):消息列表、气泡、引用、附件、贴纸、输入栏草稿。
// 事件路由留在 app.js 壳里(沈屿 #7176):明天换皮只动这里的渲染,壳不动。
// 玻璃拟态只给顶栏/输入栏/大卡片,不下放到每条气泡 —— 那是宝定的,别扩大化。
import { esc, escAttr, formatTime, formatDateTime, initials, isWideMessage } from './util.js';
import { renderMarkdown, mdInline } from './markdown.js';
import { state, ICONS, TEMP_ID_PREFIX, MAX_ATTACHMENT_BYTES } from './state.js';

// 这三个留在 app.js 那个壳里:findMessageById 要翻 state 里的多个列表、loadDraft 读
// localStorage、protectedAssetUrl 要拼 token —— 都属于"壳的职责"。渲染模块不直接去拿,
// 由壳在启动时注入。这样换皮时改这里不会牵动壳,壳换实现也不用改这里。
let shell = {
  findMessageById: () => null,
  loadDraft: () => '',
  protectedAssetUrl: (u) => u,
};
function setChatShellDeps(deps) { shell = { ...shell, ...deps }; }

// 头像:先看用户设过没有,没设就用成套的星星默认图,再兜底首字母圆片。
// 判据用 role 不用发言人名字 —— 群里 sender 是自定义的,靠名字匹配会在改名那天全错。
function avatarHtml(message) {
  const s = state.settings || {};
  const isAssistant = message && message.role === 'assistant';
  const custom = isAssistant ? s.assistant_avatar : s.user_avatar;
  const fallbackStar = isAssistant ? '/assets/stars/star-private-core.webp' : '/assets/stars/star-group.webp';
  const src = custom || fallbackStar;
  const who = (message && message.sender) || (isAssistant ? s.assistantName : s.userName) || '';
  // 图挂了就把 img 摘掉,露出底下的首字母 —— 不要一个碎图标杵在那儿
  return `<div class="avatar has-img">${esc(initials(who))}<img src="${escAttr(src)}" alt="" loading="lazy" onerror="this.remove()"></div>`;
}

function renderChat(scope, rows) {
  const searchOpen = !!(state.chatSearchOpen && state.chatSearchOpen[scope]);
  return `
    <div class="chat-view">
      ${searchOpen ? `<div class="chat-search-row">
        <input data-chat-search="1" data-scope="${escAttr(scope)}" placeholder="搜索聊天内容（只匹配正文）" value="${escAttr(state.chatSearch[scope] || '')}">
        <span class="chat-search-count" data-search-count="${escAttr(scope)}"></span>
        <button class="ghost" type="button" data-action="toggle-chat-search" data-scope="${escAttr(scope)}">关闭</button>
      </div>` : ''}
      <div class="message-list" data-scroll-list data-scroll-scope="${escAttr(scope)}">
        ${renderMessageList(scope, rows)}
      </div>
      ${renderComposer(scope)}
    </div>`;
}

function searchMessages(scope, rows) {
  const q = String(state.chatSearch[scope] || '').trim().toLowerCase();
  if (!q) return null;
  const pool = state.searchPool[scope] || rows || [];
  // Match message body text only — thinking, tool output and attachment
  // names never produce hits.
  return pool.filter((m) => m && String(m.content || '').toLowerCase().includes(q));
}

function renderMessageList(scope, rows) {
  const searchOpen = !!(state.chatSearchOpen && state.chatSearchOpen[scope]);
  if (searchOpen) {
    const hits = searchMessages(scope, rows);
    if (!hits) return '<div class="empty">输入关键词搜索聊天记录。</div>';
    if (!hits.length) return '<div class="empty">没有匹配的消息。</div>';
    return hits.map((message) => renderMessage(message, { showJump: true })).join('');
  }
  const showFav = !!(state.showFavorites && state.showFavorites[scope]);
  if (showFav) {
    const favs = (rows || []).filter((m) => m && m.favorited);
    if (!favs.length) return '<div class="empty">还没有收藏的消息。点消息右下角的 ☆ 收藏它。</div>';
    return favs.map((message) => renderMessage(message, { showJump: true })).join('');
  }
  const drafts = state.composerParts[scope] || [];
  const files = state.pending[scope] || [];
  if (!rows.length && !drafts.length && !files.length && !state.uploading[scope]) return '<div class="empty">还没有消息。</div>';
  return `${rows.map((message) => renderMessage(message)).join('')}${renderComposerDrafts(scope)}`;
}

function renderQuotedParent(message) {
  if (!message || !message.parent_msg_id) return '';
  // Every assistant reply is tagged with the message that triggered it; don't render that as a
  // quote (it would show on every single reply). Only show quotes for explicit user replies.
  if (message.role === 'assistant') return '';
  const parent = shell.findMessageById(message.parent_msg_id);
  if (!parent) return '';
  const snippet = String(parent.content || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '[附件]';
  return `<div class="quoted-parent"><span class="quoted-sender">${esc(parent.sender)}</span><span class="quoted-text">${esc(snippet)}</span></div>`;
}

function renderMessage(message, opts = {}) {
  const isMe = message.role === 'user' || message.sender === state.settings.userName;
  const recalled = !!message.recalled;
  const feat = state.settings || {};
  const attachments = recalled ? [] : (message.attachments || []);
  const text = recalled ? '' : String(message.content || '').replace(/\n{3,}/g, '\n\n').trim();
  const classes = [
    'message-row',
    isMe ? 'me' : '',
    recalled ? 'recalled' : '',
    message.pending ? 'pending' : '',
    message.failed ? 'failed' : '',
    isWideMessage(text, attachments) ? 'wide' : '',
    String(state.openMsgActions || '') === String(message.id) ? 'actions-open' : '',
  ].filter(Boolean).join(' ');
  const idAttr = esc(String(message.id));
  const btns = [];
  if (!recalled && text) btns.push(`<button class="copy-btn" type="button" data-action="copy-message" aria-label="复制消息">复制</button>`);
  if (!recalled && !message.pending) {
    btns.push(`<button class="reply-btn" type="button" data-action="reply-to" data-id="${idAttr}" aria-label="回复">回复</button>`);
    btns.push(`<button class="fav-btn${message.favorited ? ' on' : ''}" type="button" data-action="toggle-favorite" data-id="${idAttr}" aria-label="${message.favorited ? '取消收藏' : '收藏'}">${message.favorited ? '★' : '☆'}</button>`);
    if (isMe && feat.featureRecall !== false) btns.push(`<button class="recall-btn" type="button" data-action="recall-message" data-id="${idAttr}" aria-label="撤回">撤回</button>`);
  }
  if (feat.featureDelete !== false && feat.authEnabled && !message.pending) btns.push(`<button class="del-btn" type="button" data-action="delete-message" data-id="${idAttr}" aria-label="删除">删除</button>`);
  if (opts.showJump) btns.push(`<button class="jump-btn" type="button" data-action="jump-to" data-id="${idAttr}" aria-label="跳到原文">跳转</button>`);
  const bubbleInner = recalled
    ? `<div class="recalled-note">${isMe ? '你撤回了一条消息' : `${esc(message.sender)} 撤回了一条消息`}</div>`
    : `${message.thinking ? `<div class="thinking">💭 ${esc(message.thinking)}</div>` : ''}${renderQuotedParent(message)}${text ? `<div class="body-text md">${renderMarkdown(text)}</div>` : ''}${attachments.length ? `<div class="attachments">${attachments.map(renderAttachment).join('')}</div>` : ''}`;
  return `
    <article class="${classes}" id="msg-${idAttr}">
      ${avatarHtml(message)}
      <div class="msg-col">
        <div class="msg-sender">${esc(message.sender)}</div>
        <div class="bubble">
          ${bubbleInner}
        </div>
        <div class="msg-time">${formatTime(message.created_at)}${btns.length ? `<button class="msg-more" type="button" data-action="toggle-msg-actions" data-id="${idAttr}" aria-label="更多操作" aria-expanded="${String(state.openMsgActions || '') === String(message.id)}">⋮</button><span class="msg-actions">${btns.join(' ')}</span>` : ''}</div>
      </div>
    </article>`;
}

function renderAttachment(file) {
  const isImage = String(file.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(file.url || '');
  const url = shell.protectedAssetUrl(file.url || '');
  if (isImage) {
    const dimensions = file.width && file.height
      ? ` width="${Number(file.width)}" height="${Number(file.height)}" style="aspect-ratio:${Number(file.width)}/${Number(file.height)}"`
      : '';
    return `<a class="attachment-link${file.sticker ? ' is-sticker' : ''}" href="${escAttr(url)}" data-action="open-lightbox" data-url="${escAttr(url)}" data-name="${escAttr(file.name || '')}" target="_blank" rel="noreferrer"><img class="attachment-image${file.sticker ? ' is-sticker' : ''}" src="${escAttr(url)}" alt="${escAttr(file.name || 'attachment')}" loading="lazy" decoding="async"${dimensions}></a>`;
  }
  return `<a class="attachment-file" href="${escAttr(url)}" target="_blank" rel="noreferrer"><span>File</span><span>${esc(file.name || 'attachment')}</span></a>`;
}

function renderStickerPanel(scope) {
  if (!(state.stickerOpen && state.stickerOpen[scope])) return '';
  const stickers = Array.isArray(state.stickers) ? state.stickers : [];
  const editing = Boolean(state.stickerEdit);
  const cells = stickers.map((s) => `<div class="sticker-cell">
      <button class="sticker-item" type="button" data-action="send-sticker" data-sticker-id="${escAttr(String(s.id))}" title="${editing ? '' : '放进输入框'}">
        <img src="${escAttr(shell.protectedAssetUrl(s.url))}" alt="${escAttr(s.name || 'sticker')}" loading="lazy" decoding="async">
      </button>
      ${editing ? `<button class="sticker-del" type="button" data-action="delete-sticker" data-sticker-id="${escAttr(String(s.id))}" aria-label="删除">×</button>` : ''}
    </div>`).join('');
  return `<div class="sticker-panel">
    ${stickers.length ? `<div class="sticker-hint">${editing ? '点 × 删掉不要的表情包' : '点表情放进输入框，再点右边 → 发送'}<button type="button" class="sticker-edit-btn" data-action="toggle-sticker-edit">${editing ? '完成' : '编辑'}</button></div>` : ''}
    ${cells}
    <button type="button" class="sticker-add" data-action="open-sticker-picker" data-sticker-scope="${escAttr(scope)}" title="添加表情包（上传图片）">＋</button>
    ${state.stickerStatus && state.stickerStatus[scope] ? `<div class="sticker-status${state.stickerStatus[scope].startsWith('上传失败') ? ' err' : ''}">${esc(state.stickerStatus[scope])}</div>` : ''}
    ${stickers.length ? '' : '<div class="sticker-empty">还没有表情包，点 ＋ 上传图片。</div>'}
  </div>`;
}

function renderReplyBanner(scope) {
  const target = state.replyTo && state.replyTo[scope];
  if (!target) return '';
  return `<div class="reply-banner">
    <span class="reply-banner-text">回复 <b>${esc(target.sender)}</b>：${esc(target.preview)}</span>
    <button class="reply-banner-cancel" type="button" data-action="cancel-reply" data-scope="${escAttr(scope)}" aria-label="取消回复">×</button>
  </div>`;
}

function renderComposer(scope) {
  const parts = state.composerParts[scope] || [];
  const hasDrafts = Boolean(parts.length || (state.pending[scope] || []).length || state.uploading[scope]);
  const placeholder = scope === 'group'
    ? `发到 ${state.settings.groupName}`
    : `和 ${state.settings.assistantName} 说点什么`;
  const sendDisabled = state.busy || state.offline;
  const draft = shell.loadDraft(scope);
  return `
    <form class="composer" data-send-scope="${escAttr(scope)}">
      ${renderReplyBanner(scope)}
      <div class="composer-bar ${hasDrafts ? 'has-parts' : ''}">
        <!-- 反馈#11:照用户自己 App 的输入栏改——文字胶囊自成一体(表情在胶囊里),
             「+」和「发送」是胶囊外的独立圆键。之前是 +/☺/文字/发送 全塞进一个大胶囊,
             那一坨就是用户说的「笨笨的」。 -->
        <div class="composer-field">
          <button class="composer-btn sticker-toggle${state.stickerOpen && state.stickerOpen[scope] ? ' on' : ''}" type="button" data-action="toggle-stickers" data-scope="${escAttr(scope)}" aria-label="表情" title="表情">${ICONS.sticker}</button>
          <textarea name="content" rows="1" placeholder="${escAttr(placeholder)}" ${state.offline ? 'disabled' : ''}>${esc(draft)}</textarea>
        </div>
        <label class="composer-btn composer-attach" aria-label="添加附件" title="添加附件">
          <input data-file-scope="${escAttr(scope)}" type="file" accept="image/*,.pdf,.txt" multiple ${state.offline ? 'disabled' : ''}>
          ${ICONS.plus}
        </label>
        <button class="composer-btn composer-send" type="submit" aria-label="${state.offline ? '离线' : '发送'}" title="${state.offline ? '离线' : '发送'}" ${sendDisabled ? 'disabled' : ''}>
          ${ICONS.send}
        </button>
      </div>
      ${renderStickerPanel(scope)}
    </form>`;
}

function renderComposerDrafts(scope) {
  const parts = state.composerParts[scope] || [];
  const files = state.pending[scope] || [];
  if (!parts.length && !files.length && !state.uploading[scope]) return '';
  return `<div class="message-drafts" data-draft-scope="${escAttr(scope)}">
    ${parts.map((part, index) => renderComposerDraft(scope, part, index)).join('')}
    ${files.length || state.uploading[scope] ? renderAttachmentDraft(scope, files) : ''}
  </div>`;
}

function renderComposerDraft(scope, part, index) {
  const text = String(part || '').replace(/\n{3,}/g, '\n\n').trim();
  const classes = [
    'message-row',
    'me',
    'composer-draft',
    isWideMessage(text, []) ? 'wide' : '',
  ].filter(Boolean).join(' ');
  return `
    <article class="${classes}">
      ${avatarHtml({ role: 'user', sender: state.settings.userName })}
      <div class="msg-col">
        <div class="msg-sender">${esc(state.settings.userName)}</div>
        <div class="bubble">
          <div class="body-text">${esc(text)}</div>
          <div class="draft-foot">
            <span>未发送</span>
            <div class="draft-actions">
              <button type="button" data-action="edit-composer-part" data-scope="${escAttr(scope)}" data-index="${index}">编辑</button>
              <button type="button" data-action="remove-composer-part" data-scope="${escAttr(scope)}" data-index="${index}">删除</button>
            </div>
          </div>
        </div>
        <div class="msg-time">前端暂存，发送后才会给 agent</div>
      </div>
    </article>`;
}

function renderAttachmentDraft(scope, files) {
  const classes = [
    'message-row',
    'me',
    'composer-draft',
  ].join(' ');
  return `
    <article class="${classes}">
      ${avatarHtml({ role: 'user', sender: state.settings.userName })}
      <div class="msg-col">
        <div class="msg-sender">${esc(state.settings.userName)}</div>
        <div class="bubble">
          ${files.length ? `<div class="attachments draft-attachments">${files.map((file, index) => renderPendingAttachment(scope, file, index)).join('')}</div>` : ''}
          ${state.uploading[scope] ? `<div class="draft-uploading">${esc(state.uploading[scope])}</div>` : ''}
          <div class="draft-foot">
            <span>未发送</span>
            <div class="draft-actions">
              ${files.map((file, index) => {
                const renaming = state.renamingFile && state.renamingFile.scope === scope && Number(state.renamingFile.index) === index;
                const tag = files.length > 1 ? ` ${index + 1}` : '';
                // 反馈#12:文字草稿有「编辑/删除」,附件草稿只有「删除」——补齐。文件能改的就是名字,
                // 而文件名正是发给 agent 的那部分,所以「编辑」=改名。走内联输入框,不弹 prompt(WebView 里会卡)。
                if (renaming) {
                  return `<span class="rename-row">
                    <input class="rename-input" type="text" value="${escAttr(file.name || '')}" data-rename-input aria-label="文件名">
                    <button type="button" class="primary" data-action="save-pending-file-name" data-scope="${escAttr(scope)}" data-index="${index}">保存</button>
                    <button type="button" data-action="cancel-pending-file-name">取消</button>
                  </span>`;
                }
                return `<button type="button" data-action="edit-pending-file-name" data-scope="${escAttr(scope)}" data-index="${index}">编辑${tag}</button>`
                  + `<button type="button" data-action="remove-pending-file" data-scope="${escAttr(scope)}" data-index="${index}">删除${tag}</button>`;
              }).join('')}
            </div>
          </div>
        </div>
        <div class="msg-time">附件已前端暂存，发送后才会给 agent</div>
      </div>
    </article>`;
}

function renderPendingAttachment(scope, file) {
  const html = renderAttachment(file);
  return `<div class="draft-attachment-item">
    ${html}
  </div>`;
}

function renderChatToolsMenu(scope) {
  // 反馈#1:顶栏「复制全部/清空」文字长、把标题挤到截断 → 收进 ⋯,点开才出
  const s = state.settings || {};
  const items = [];
  if (s.featureCopyAll !== false) {
    items.push(`<button type="button" data-action="copy-all" data-scope="${escAttr(scope)}">复制全部对话</button>`);
  }
  if (s.featureDelete !== false && s.authEnabled) {
    items.push(`<button type="button" class="danger-item" data-action="clear-chat" data-scope="${escAttr(scope)}">清空聊天记录</button>`);
  }
  if (!items.length) return '';
  const open = !!state.topbarMenuOpen;
  return `<div class="topbar-menu-wrap">
      <button class="fav-filter topbar-more${open ? ' on' : ''}" type="button" data-action="toggle-topbar-menu" aria-label="更多" aria-expanded="${open}">⋯</button>
      ${open ? `<div class="topbar-menu">${items.join('')}</div>` : ''}
    </div>`;
}

function renderChatSearchBtn(scope) {
  const open = !!(state.chatSearchOpen && state.chatSearchOpen[scope]);
  return `<button class="fav-filter${open ? ' on' : ''}" type="button" data-action="toggle-chat-search" data-scope="${escAttr(scope)}" aria-label="搜索聊天">🔍</button>`;
}

function renderFavFilterBtn(scope) {
  const rows = scope === 'group' ? state.group : state.chat;
  const showFav = !!(state.showFavorites && state.showFavorites[scope]);
  const favCount = (rows || []).filter((m) => m && m.favorited).length;
  return `<button class="fav-filter${showFav ? ' on' : ''}" type="button" data-action="toggle-fav-filter" data-scope="${escAttr(scope)}">${showFav ? '返回全部' : `★ 收藏${favCount ? ` ${favCount}` : ''}`}</button>`;
}

export {
  renderChat, renderChatToolsMenu, renderChatSearchBtn, renderFavFilterBtn,
  renderComposerDrafts, renderMessageList, searchMessages, renderMessage, renderAttachmentDraft,
  setChatShellDeps,
};
