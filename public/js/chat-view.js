// 聊天页(私聊/群聊共用):消息列表、气泡、引用、附件、贴纸、输入栏草稿。
// 事件路由留在 app.js 壳里:明天换皮只动这里的渲染,壳不动。
// 玻璃拟态只给顶栏/输入栏/大卡片,不下放到每条气泡 —— 定稿如此,别扩大化。
import { esc, escAttr, formatTime, formatDateTime, initials, isWideMessage, splitParagraphs } from './util.js';
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
  // ★ 必须包 token:/uploads/ 服务端有鉴权,裸 src 在开口令的实例上 401 → onerror
  //   摘图退回首字母,自定义头像看起来"传了没生效"(8/14 她真机报的,测试实例不开鉴权测不出)。
  const src = shell.protectedAssetUrl(custom || fallbackStar);
  const who = (message && message.sender) || (isAssistant ? s.assistantName : s.userName) || '';
  // 图挂了就把 img 摘掉,露出底下的首字母 —— 不要一个碎图标杵在那儿。
  // ★ 连 has-img 一起摘:那个 class 把文字设成了 transparent(挡住名字从透明 PNG 底下透出来),
  //   不摘的话图挂了会变成**空白头像** —— 兜底静默失效,而且看起来跟"正常"一模一样。
  return `<div class="avatar has-img">${esc(initials(who))}<img src="${escAttr(src)}" alt="" loading="lazy" onerror="this.remove();this.parentNode&&this.parentNode.classList.remove('has-img')"></div>`;
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
  return `${rows.map((message, i) => `${timeDivider(rows[i - 1], message)}${renderMessage(message)}`).join('')}${renderComposerDrafts(scope)}`;
}

// 「7月28日 17:30」——24 小时制,不补零到「07月」(中文日期不那么写)。
function dayTimeLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

// 隔得久了,在正中间插一条灰色小字的时间。
// ★ 判据是**两条消息之间的间隔**,不是"换天了" —— 凌晨 1 点接着 23 点那条聊,
//   按"换天"会插一条,按间隔不会;而人感觉那是同一场对话。反过来,同一天里
//   隔了六小时,按"换天"什么都不插,人却早就断片了。**间隔才是人感知的那个量。**
const DIVIDER_GAP_MS = 30 * 60 * 1000;
function timeDivider(prev, cur) {
  if (!cur || !cur.created_at) return '';
  const now = new Date(cur.created_at).getTime();
  if (Number.isNaN(now)) return '';
  if (prev && prev.created_at) {
    const before = new Date(prev.created_at).getTime();
    if (!Number.isNaN(before) && now - before < DIVIDER_GAP_MS) return '';
  }
  const label = dayTimeLabel(cur.created_at);
  return label ? `<div class="time-divider"><span>${esc(label)}</span></div>` : '';
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
  const footer = `<div class="msg-time">${formatTime(message.created_at)}${btns.length ? `<button class="msg-more" type="button" data-action="toggle-msg-actions" data-id="${idAttr}" aria-label="更多操作" aria-expanded="${String(state.openMsgActions || '') === String(message.id)}">⋮</button><span class="msg-actions">${btns.join(' ')}</span>` : ''}</div>`;

  if (recalled) {
    return `
    <article class="${classes}" id="msg-${idAttr}">
      ${avatarHtml(message)}
      <div class="msg-col">
        <div class="msg-sender">${esc(message.sender)}</div>
        <div class="bubble"><div class="recalled-note">${isMe ? '你撤回了一条消息' : `${esc(message.sender)} 撤回了一条消息`}</div></div>
        ${footer}
      </div>
    </article>`;
  }

  // ★ 长回复按段落拆成几个小气泡,每个自带头像 —— 这是明确要的效果。
  //   切法见 util.splitParagraphs:**只在段落边界切**,代码块/列表/表格/引用整块不拆,
  //   否则一段代码会被劈成两半。
  // ★ 拆开之后的分工:名字只挂第一条(不然一串重复的名字),
  //   时间和操作按钮只挂最后一条(它们属于「这条消息」,不属于每一段),
  //   附件也跟在最后 —— 图片跟在正文说完之后出现,顺序才对。
  //   `id="msg-N"` 只给第一条:跳转锚点必须唯一。
  const segments = text ? splitParagraphs(text) : [];
  // ★ 思考链默认**折叠**。摊开时它是整段长文,而 `.msg-col` 是 `width:max-content` ——
  //   于是"只回了三个字"的一条,气泡照样被思考链撑到最宽(真机上逮到的就是这个)。
  //   收成一个 `thinking` 小标签之后,气泡宽度重新由正文决定。
  //   ★ 用原生 <details>:点开不需要任何 JS,展开态存在 DOM 属性上,
  //     不会被聊天列表的重渲染冲掉(存在 state 里就会)。
  // 工具块跟思考链并排,同样默认折叠、同样不参与气泡宽度。
  // ★ 摘要只说「用了什么、动了哪儿」,**不含文件内容** —— 那一刀在 bridge 侧
  //   `summarizeToolInput` 用白名单取键做的,前端这儿只负责显示。
  const toolList = Array.isArray(message.tools) ? message.tools : [];
  const toolBlock = toolList.length
    ? `<details class="cot tools"><summary>${toolList.length} tools</summary><div class="cot-body">${
        toolList.map((t) => `<div class="tool-row"><b>${esc(t.name)}</b>${t.arg ? ` <span>${esc(t.arg)}</span>` : ''}</div>`).join('')
      }</div></details>`
    : '';
  // ★ 思考链 / 工具块渲在**气泡外面、正上方**,不跟正文共用一个框。
  //   她的原话:「thinking 和正文信息不要共用一个文本框」「放在文本框外面的上面」。
  //   道理也站得住:思考不是"他说的话",是"他说这句话之前在想什么" ——
  //   塞进同一个气泡等于把两种东西说成一种。
  //   引用(quoted parent)仍留在气泡里:那是这句话的一部分语境,不是另一层。
  const preBubble = `${message.thinking
    ? `<details class="cot"><summary>thinking</summary><div class="cot-body">${esc(message.thinking)}</div></details>`
    : ''}${toolBlock}`;
  const head = renderQuotedParent(message);

  // ★ 附件**移出气泡**,当作 .msg-col 的兄弟。她的原话:
  //   「文字单独一个文本框,图片不要文本框,就是有和文本框一样的裁剪就行」
  //   图片自己就是内容,再套一层带底色和内边距的框,等于给画配了个不必要的相框。
  //   圆角仍然跟气泡对齐(8px),所以看着还是一家人。
  //   ★ 右对齐不用单独写:`.message-row.me .msg-col{justify-items:end}` 已经管着
  //     这一列的所有孩子 —— 附件搬出来之后自动跟着靠右。
  const atts = attachments.length
    ? `<div class="attachments">${attachments.map(renderAttachment).join('')}</div>` : '';
  // 没正文也没思考链/引用时不留空气泡 —— 纯图片消息就该只有图。
  // 只有正文或引用才需要气泡 —— 思考链已经自己在外面了
  const hasBubble = Boolean(text) || Boolean(head);

  if (segments.length <= 1) {
    const inner = `${head}${text ? `<div class="body-text md">${renderMarkdown(text)}</div>` : ''}`;
    return `
    <article class="${classes}${isWideMessage(text, attachments) ? ' wide' : ''}" id="msg-${idAttr}">
      ${avatarHtml(message)}
      <div class="msg-col">
        <div class="msg-sender">${esc(message.sender)}</div>
        ${preBubble}
        ${hasBubble ? `<div class="bubble">
          ${inner}
        </div>` : ''}
        ${atts}
        ${footer}
      </div>
    </article>`;
  }

  return segments.map((seg, i) => {
    const first = i === 0;
    const last = i === segments.length - 1;
    // ★ wide 按**段**算,不按整条算 —— 整条很长但某一段只有两个字("好的。")时,
    //   那个气泡不该被连坐铺满(真机上她圈出来的就是这个)。
    const rowClass = `${classes}${first ? '' : ' cont'}${isWideMessage(seg, []) ? ' wide' : ''}`;
    const inner = `${first ? head : ''}<div class="body-text md">${renderMarkdown(seg)}</div>`;
    return `
    <article class="${rowClass}"${first ? ` id="msg-${idAttr}"` : ''}>
      ${avatarHtml(message)}
      <div class="msg-col">
        ${first ? `<div class="msg-sender">${esc(message.sender)}</div>` : ''}
        ${first ? preBubble : ''}
        <div class="bubble">
          ${inner}
        </div>
        ${last ? atts : ''}
        ${last ? footer : ''}
      </div>
    </article>`;
  }).join('');
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
  // ★ 「File」那个词去掉了 —— 文件夹的形状已经说明它是文件,再写一遍是同一句话讲两次。
  const name = file.name || 'attachment';
  const ext = fileExtLabel(name, file.url);
  const canPreview = isPreviewable(name, file.type);
  const sub = [file.size ? formatFileSize(file.size) : '', canPreview ? '点击预览' : '点击下载']
    .filter(Boolean).join(' · ');
  // 能预览的走壳里的预览层(preventDefault),不能预览的保留原来的新标签页下载。
  const hook = canPreview
    ? ` data-action="preview-file" data-url="${escAttr(url)}" data-name="${escAttr(name)}" data-ext="${escAttr(ext)}"`
    : '';
  return `<a class="attachment-file${canPreview ? ' can-preview' : ''}" href="${escAttr(url)}"${hook} target="_blank" rel="noreferrer">
    <span class="af-icon" aria-hidden="true">${esc(ext)}</span>
    <span class="af-body">
      <span class="af-name">${esc(name)}</span>
      ${sub ? `<span class="af-sub">${esc(sub)}</span>` : ''}
    </span>
  </a>`;
}

// 扩展名徽章:最多四个字符,免得 .markdown 把卡片撑开。没有扩展名就画个通用文件符号。
function fileExtLabel(name, url) {
  const source = String(name || '') || String(url || '');
  const match = source.match(/\.([A-Za-z0-9]{1,8})$/);
  if (!match) return '文件';
  const ext = match[1].toUpperCase();
  return ext.length > 4 ? ext.slice(0, 4) : ext;
}

// 能在 App 里当文本读的类型。
// ★ 有扩展名就**只认扩展名**,不给 mime 翻案的机会:服务端存的 mime 跟着上传方给的走,
//   一个 archive.zip 被上传成 text/* 就会被当文本打开(自测里真撞到了,一屏乱码)。
//   名字说它是 zip,那就按 zip 待它。mime 只在文件名压根没有扩展名时兜底。
const PREVIEW_EXT = /\.(md|markdown|txt|text|log|json|jsonl|ya?ml|toml|ini|conf|cfg|env|csv|tsv|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cc|cpp|cs|php|swift|kt|sh|bash|zsh|sql|css|scss|html?|xml|svg|diff|patch|gitignore)$/i;
function isPreviewable(name, type) {
  const named = String(name || '');
  if (/\.[A-Za-z0-9]{1,8}$/.test(named)) return PREVIEW_EXT.test(named);
  const mime = String(type || '').toLowerCase();
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml';
}

// 附件显示的是**字节**。util 的 formatDocSize 在 1KB 以下写「N 字」——
// 那是给资料库的字数用的,搬到二进制大小上会读成"这文件才 105 个字",差着三倍。
function formatFileSize(size) {
  const n = Number(size) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
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
  // ★ 不用 emoji:🔍 在不同系统上是不同的画(苹果彩色放大镜 / 安卓扁平 / Windows 又一版),
  //   而且大小和基线各家不一样,跟旁边的 ⋯ 永远对不齐。纯 CSS 画的形状到处一模一样。
  //   镜片 = 圆环(border+border-radius),把手 = 一根旋转 45° 的短线。
  //   打开时那圈描边慢慢转一下(cc-lens-spin),表示"在搜"——比换颜色更好认,
  //   而且 prefers-reduced-motion 下自动停,不会变成一个一直在动的干扰源。
  return `<button class="fav-filter lens-btn${open ? ' on' : ''}" type="button" data-action="toggle-chat-search" data-scope="${escAttr(scope)}" aria-label="搜索聊天"><span class="lens" aria-hidden="true"></span></button>`;
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
