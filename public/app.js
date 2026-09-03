import {
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
} from './js/util.js';
import { renderMarkdown, mdInline, mdSafeUrl } from './js/markdown.js';
import { hydrateStarry } from './js/starry.js';
import { renderHome } from './js/home-view.js';
import { renderMore, loadSwVersion } from './js/more-view.js';
import {
  CONSOLE_COMMANDS,
  MAX_ATTACHMENT_BYTES,
  SMALL_IMAGE_BYTES,
  IMAGE_MAX_EDGE,
  IMAGE_QUALITY,
  BOOTSTRAP_CACHE_KEY,
  DRAFT_KEY_PREFIX,
  TEMP_ID_PREFIX,
  ICONS,
  state,
  memoryAuthor,
  protectedAssetUrl,
} from './js/state.js';
import { renderConsole, renderConsoleEvent } from './js/console-view.js';
import { scanMeta } from './js/stream-format.js';
import { cycleTheme } from './js/actions/theme.js';
import { renderSettings, renderQuotaPanel, agentProviderLabel } from './js/settings-view.js';
import { renderMemory, renderMemoryReader, memoryTabHeading } from './js/memory-view.js';
import {
  renderChat, renderChatToolsMenu, renderChatSearchBtn, renderFavFilterBtn,
  renderComposerDrafts, renderMessageList, renderSearchResults, searchMessages, renderMessage, renderAttachmentDraft,
  setChatShellDeps,
} from './js/chat-view.js';
const root = document.getElementById('app');
let eventStream = null;
let fallbackTimer = null;



// ★ 'home' 不在这个列表里 —— 它是落地页不是并列 tab:
//   ① 样稿上首屏没有底栏 ② 塞进去底栏就是 6 格,390px 上挤到换行
//   进首屏靠顶栏那颗星,从首屏出去靠星河上的四个入口。
const tabs = [
  ['chat',     '私聊',   '私聊'],
  ['group',    '群聊',   '群聊'],
  ['console',  '控制台', '日志'],
  ['memory',   '记忆',   '记忆'],
  ['settings', '设置',   '设置'],
];

boot();

// 聊天渲染模块要用的三个"壳的能力"(翻消息 / 读草稿 / 给受保护资源拼 token),
// 在这里注入一次。渲染模块不直接碰 DOM 存储和 token,换皮时互不牵动。
setChatShellDeps({ findMessageById, loadDraft, protectedAssetUrl });

async function boot() {
  bindEvents();
  registerServiceWorker();
  await loadBootstrap();
  connectStream();
}

function bindEvents() {
  let pressTimer = null;
  let pressPoint = null;
  const cancelLongPress = () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = null; pressPoint = null; };
  document.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const row = event.target.closest('.message-row[data-message-id]');
    if (!row || !event.target.closest('.bubble,.attachments')) return;
    pressPoint = { x: event.clientX, y: event.clientY };
    pressTimer = setTimeout(() => {
      state.openMsgActions = row.dataset.messageId;
      if (navigator.vibrate) navigator.vibrate(18);
      render();
      pressTimer = null;
    }, 480);
  }, { passive: true });
  document.addEventListener('pointermove', (event) => {
    if (pressPoint && Math.hypot(event.clientX - pressPoint.x, event.clientY - pressPoint.y) > 10) cancelLongPress();
  }, { passive: true });
  document.addEventListener('pointerup', cancelLongPress, { passive: true });
  document.addEventListener('pointercancel', cancelLongPress, { passive: true });
  document.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.message-row[data-message-id]');
    if (!row || !event.target.closest('.bubble,.attachments')) return;
    event.preventDefault();
    state.openMsgActions = row.dataset.messageId;
    render();
  });
  document.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const name = action.dataset.action;
    if (action.closest('.msg-actions') && name !== 'copy-message') state.openMsgActions = null;
    if (name === 'tab') {
      state.tab = action.dataset.tab || 'chat';
      // 只有**进**「更多」那一下才放入场动画;页内任何重绘都不再重放
      state.moreAnim = state.tab === 'more';
      render();
      await refreshCurrent().catch(handleBackgroundError);
    }
    if (name === 'cycle-theme') {
      await cycleTheme({ state, api, cacheBootstrap, applyTheme, render, reportError: handleBackgroundError });
      return;
    }
    if (name === 'console-view') {
      state.consoleView = action.dataset.view === 'term' ? 'term' : 'flow';
      // 档位落 localStorage(state.js 开机读):不落的话刷新必回工作流档,
      // 对住在终端档的人等于「终端每次刷新就消失」。
      try { localStorage.setItem('cc_console_view', state.consoleView); } catch { /* 私密模式拿不到就算了 */ }
      // 每次**进**终端档都落到底部(实时流+状态行) —— 终端的东西在底下,
      // 上次翻到 scrollback 半截的位置不带进这一次。工作流档的位置照旧各记各的。
      if (state.consoleView === 'term') state.stickToBottom['console-term'] = true;
      render();
      // 切到终端档时补一次额度 —— 否则状态行要等下一次 refreshCurrent 才有数,
      // 中间那段空白会被读成"这台没有额度数据",而其实只是还没去问。
      if (state.consoleView === 'term' && !(state.quota && state.quota.data)) {
        loadQuota().then(render).catch(handleBackgroundError);
      }
      if (state.consoleView === 'term') loadRawTail();
      return;
    }
    if (name === 'raw-fmt') {
      state.rawFmt = !state.rawFmt;
      try { localStorage.setItem('cc_raw_fmt', state.rawFmt ? '1' : '0'); } catch { /* 同上 */ }
      render();
      return;
    }
    if (name === 'more-about') {
      state.moreAbout = !state.moreAbout;
      render();
      // 展开时才去问缓存版本 —— 不展开就不问,别为一行诊断信息在每次进页面时都查一遍。
      if (state.moreAbout && !state.swVersion) {
        loadSwVersion().then((v) => { state.swVersion = v; if (state.moreAbout) render(); });
      }
      return;
    }
    if (name === 'bridge-dial') return;   // select 走 change 事件,不在 click 里处理
    if (name === 'pick-since') {
      // 只把建议值**填进输入框**,不直接落库 —— 让用户看见挑的是哪天、能改、按保存才生效。
      // 「替我挑一个」不该是「替我决定」。
      const all = [...(state.chat || []), ...(state.group || [])]
        .map((m) => m && m.created_at).filter(Boolean).sort();
      const suggestion = (all[0] || new Date().toISOString()).slice(0, 10);
      const input = document.querySelector('input[name="companion_since"]');
      if (input) { input.value = suggestion; input.focus(); }
      return;
    }
    if (name === 'pick-avatar' || name === 'clear-avatar') {
      const field = action.dataset.field === 'assistant_avatar' ? 'assistant_avatar' : 'user_avatar';
      let url = '';
      if (name === 'pick-avatar') {
        // 走和贴纸/附件同一条上传链:先落成 /uploads/ 资源,再把**引用**写进设置。
        // 不把图片本身塞进 settings —— 那会让 store 里躺着 base64,也和自改窄口
        // 「只收已上传引用」的口径对不上(见 server.js 的 /api/agent/avatar)。
        // Reuse the attachment picker path that is already proven on Android
        // and vendor WebViews. The older avatar-only picker could stay pending
        // after returning from Gallery on some phones.
        const file = (await pickAttachments('image', false))[0] || null;
        if (!file) return;
        try {
          const uploaded = await api('/api/uploads', { method: 'POST', body: await prepareUpload(file) });
          url = uploaded && uploaded.url ? uploaded.url : '';
        } catch (err) { handleBackgroundError(err); return; }
        if (!url) return;
      }
      state.settings = await api('/api/settings', { method: 'POST', body: { ...state.settings, [field]: url } });
      cacheBootstrap();
      render();
    }
    if (name === 'copy-message') {
      const row = action.closest('.message-row');
      const body = row && row.querySelector('.body-text');
      const message = action.dataset.id ? findMessageById(action.dataset.id) : null;
      const ok = await copyText(body ? body.textContent : String(message && message.content || ''));
      flashCopied(action, ok);
      setTimeout(() => {
        if (state.openMsgActions) {
          state.openMsgActions = null;
          render();
        }
      }, 280);
    }
    if (name === 'copy-all') {
      const scope = action.dataset.scope || (state.tab === 'group' ? 'group' : 'chat');
      const rows = (scope === 'group' ? state.group : state.chat) || [];
      const text = rows
        .filter((m) => !m.recalled && !m.pending)
        .map((m) => `${m.sender}: ${String(m.content || ((m.attachments || []).length ? '[附件]' : '')).trim()}`)
        .join('\n\n');
      flashCopied(action, await copyText(text));
    }
    if (name === 'recall-message') {
      const list = action.closest('.message-list');
      const scope = (list && list.dataset.scrollScope) || (state.tab === 'group' ? 'group' : 'chat');
      const id = action.dataset.id;
      const msg = findMessageById(id);
      if (!msg) return;
      const prev = msg.recalled;
      msg.recalled = true;
      render();
      try {
        await api(`/api/${scope}/messages/${id}/recall`, { method: 'POST' });
      } catch (err) {
        msg.recalled = prev;
        render();
        handleBackgroundError(err);
      }
    }
    if (name === 'delete-message') {
      if (!confirm('删除这条消息？不可恢复。\n（AI 可能仍记得它。）')) return;
      const list = action.closest('.message-list');
      const scope = (list && list.dataset.scrollScope) || (state.tab === 'group' ? 'group' : 'chat');
      const id = action.dataset.id;
      removeMessagesById(scope, [id]);
      render();
      try {
        await api(`/api/${scope}/messages/${id}`, { method: 'DELETE' });
      } catch (err) {
        await refreshCurrent().catch(handleBackgroundError);
      }
    }
    if (name === 'clear-chat') {
      const scope = action.dataset.scope || (state.tab === 'group' ? 'group' : 'chat');
      if (!confirm(`清空${scope === 'group' ? '群聊' : '对话'}的全部消息？此操作不可恢复。\n（AI 已记住或已写入记忆库的内容不受影响；服务器会在 data/ 存一份带时间戳的备份。）`)) return;
      state[scope] = [];
      render();
      try {
        await api(`/api/${scope}/messages`, { method: 'DELETE' });
      } catch (err) {
        await refreshCurrent().catch(handleBackgroundError);
      }
    }
    if (name === 'reply-to') {
      const list = action.closest('.message-list');
      const scope = (list && list.dataset.scrollScope) || (state.tab === 'group' ? 'group' : 'chat');
      const target = findMessageById(action.dataset.id);
      if (target) {
        if (!state.replyTo) state.replyTo = { chat: null, group: null };
        const preview = String(target.content || '').replace(/\s+/g, ' ').trim().slice(0, 50) || '[附件]';
        state.replyTo[scope] = { id: target.id, sender: target.sender, preview };
        render();
        const ta = document.querySelector(`form[data-send-scope="${CSS.escape(scope)}"] textarea[name="content"]`);
        if (ta) ta.focus({ preventScroll: true });
      }
    }
    if (name === 'cancel-reply') {
      const scope = action.dataset.scope || (state.tab === 'group' ? 'group' : 'chat');
      if (state.replyTo) state.replyTo[scope] = null;
      render();
    }
    if (name === 'toggle-favorite') {
      const list = action.closest('.message-list');
      const scope = (list && list.dataset.scrollScope) || (state.tab === 'group' ? 'group' : 'chat');
      const id = action.dataset.id;
      const msg = findMessageById(id);
      const next = !(msg && msg.favorited);
      if (msg) msg.favorited = next;
      render();
      try {
        await api(`/api/${scope}/messages/${id}/favorite`, { method: 'POST', body: { favorited: next } });
      } catch (err) {
        if (msg) msg.favorited = !next;
        render();
        handleBackgroundError(err);
      }
    }
    if (name === 'fp-html-mode') {
      if (state.filePreview) {
        state.filePreview.htmlMode = state.filePreview.htmlMode === 'source' ? 'render' : 'source';
        render();
      }
      return;
    }
    if (name === 'toggle-event') {
      const id = action.dataset.id;
      if (!state.openEvents) state.openEvents = {};
      if (state.openEvents[id]) delete state.openEvents[id]; else state.openEvents[id] = true;
      render();
      return;
    }
    if (name === 'toggle-topbar-menu') {
      state.topbarMenuOpen = !state.topbarMenuOpen;
      render();
      return;
    }
    if (state.topbarMenuOpen && name !== 'toggle-topbar-menu') state.topbarMenuOpen = false;
    if (name === 'toggle-msg-actions') {
      const id = action.dataset.id;
      state.openMsgActions = String(state.openMsgActions || '') === String(id) ? null : id;
      render();
    }
    if (name === 'close-msg-actions') {
      state.openMsgActions = null;
      render();
      return;
    }
    if (name === 'toggle-fav-filter') {
      const scope = action.dataset.scope || (state.tab === 'group' ? 'group' : 'chat');
      if (!state.showFavorites) state.showFavorites = { chat: false, group: false };
      state.showFavorites[scope] = !state.showFavorites[scope];
      if (state.showFavorites[scope]) state.chatSearchOpen[scope] = false;
      render();
    }
    if (name === 'toggle-chat-search') {
      const scope = action.dataset.scope || (state.tab === 'group' ? 'group' : 'chat');
      state.chatSearchOpen[scope] = !state.chatSearchOpen[scope];
      if (state.chatSearchOpen[scope]) {
        state.showFavorites[scope] = false;
        loadSearchPool(scope);
      } else {
        state.chatSearch[scope] = '';
      }
      render();
      if (state.chatSearchOpen[scope]) {
        const input = document.querySelector(`.chat-search-sheet input[data-scope="${CSS.escape(scope)}"]`);
        if (input) input.focus();
      }
    }
    if (name === 'chat-search-mode') {
      const scope = action.dataset.scope || (state.tab === 'group' ? 'group' : 'chat');
      if (!state.chatSearchMode) state.chatSearchMode = { chat: 'all', group: 'all' };
      state.chatSearchMode[scope] = ['all', 'image', 'file', 'link'].includes(action.dataset.mode) ? action.dataset.mode : 'all';
      render();
      const input = document.querySelector(`.chat-search-sheet input[data-scope="${CSS.escape(scope)}"]`);
      if (input) input.focus({ preventScroll: true });
      return;
    }
    if (name === 'jump-to') {
      const list = action.closest('.message-list');
      const scope = (list && list.dataset.scrollScope) || (state.tab === 'group' ? 'group' : 'chat');
      if (state.showFavorites) state.showFavorites[scope] = false;
      if (state.chatSearchOpen && state.chatSearchOpen[scope]) {
        ensureMessageLoaded(scope, action.dataset.id);
        state.chatSearchOpen[scope] = false;
        state.chatSearch[scope] = '';
      }
      render();
      scrollToMessage(action.dataset.id);
    }
    if (name === 'toggle-stickers') {
      const scope = action.dataset.scope || (state.tab === 'group' ? 'group' : 'chat');
      if (!state.stickerOpen) state.stickerOpen = { chat: false, group: false };
      state.stickerOpen[scope] = !state.stickerOpen[scope];
      render();
      if (state.stickerOpen[scope]) loadStickers();
    }
    if (name === 'toggle-attach-menu') {
      const scope = action.dataset.scope || (state.tab === 'group' ? 'group' : 'chat');
      if (!state.attachMenuOpen) state.attachMenuOpen = { chat: false, group: false };
      state.attachMenuOpen[scope] = !state.attachMenuOpen[scope];
      if (state.attachMenuOpen[scope] && state.stickerOpen) state.stickerOpen[scope] = false;
      render();
      return;
    }
    if (name === 'pick-attachment') {
      const scope = action.dataset.scope === 'group' ? 'group' : 'chat';
      const kind = action.dataset.kind === 'image' ? 'image' : 'file';
      if (state.attachMenuOpen) state.attachMenuOpen[scope] = false;
      render();
      const files = await pickAttachments(kind);
      if (files.length) await uploadFiles(scope, files);
      return;
    }
    if (name === 'send-sticker' && !state.stickerEdit) {
      const form = action.closest('form');
      const scope = (form && form.dataset.sendScope) || (state.tab === 'group' ? 'group' : 'chat');
      const sticker = (state.stickers || []).find((x) => String(x.id) === String(action.dataset.stickerId));
      if (sticker) pickSticker(scope, sticker);
    }
    if (name === 'toggle-sticker-edit') {
      state.stickerEdit = !state.stickerEdit;
      render();
    }
    if (name === 'open-sticker-picker') {
      openStickerPicker(action.dataset.stickerScope || (state.tab === 'group' ? 'group' : 'chat'));
    }
    if (name === 'delete-sticker') {
      if (!confirm('删除这个表情包？')) return;
      try {
        await api(`/api/stickers/${action.dataset.stickerId}`, { method: 'DELETE' });
        await loadStickers();
      } catch (err) {
        handleBackgroundError(err);
      }
    }
    if (name === 'open-lightbox') {
      event.preventDefault();
      state.lightbox = { url: action.dataset.url, name: action.dataset.name || '' };
      render();
      return;
    }
    if (name === 'close-lightbox') {
      state.lightbox = null;
      render();
      return;
    }
    if (name === 'preview-file') {
      event.preventDefault();
      openFilePreview({
        url: action.dataset.url,
        name: action.dataset.name || '',
        ext: action.dataset.ext || '',
      });
      return;
    }
    if (name === 'close-file-preview') {
      state.filePreview = null;
      render();
      return;
    }
    if (name === 'toggle-notify') {
      if (notifyEnabled()) {
        localStorage.removeItem('cc-notify');
      } else if (notifySupported()) {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') localStorage.setItem('cc-notify', '1');
      }
      render();
    }
    if (name === 'memory-tab') {
      const tab = action.dataset.tab;
      state.memoryTab = ['home', 'docs', 'all', 'config'].includes(tab) ? tab : 'diary';
      state.memoryToolsOpen = false;
      // 换一叠就把筛选松开:「全部条目」里筛着 auto 再切回日记,日记会空成 0 条(日记本就不含 auto)
      const hadQuery = Boolean(state.memoryQuery);
      state.memoryTagFilter = '';
      state.memoryQuery = '';
      render();
      if (state.memoryTab === 'docs') loadDocuments();
      else if (state.memoryTab === 'config') loadConfigFiles();
      else if (hadQuery) loadMemories();
    }
    if (name === 'open-config-file') {
      state.configFileStatus = '';
      state.configFileEditMode = false;
      try {
        state.configFileEditing = await api(`/api/config-files/${action.dataset.id}`);
      } catch (err) {
        state.configFileStatus = `加载失败：${err.message}`;
      }
      render();
      return;
    }
    if (name === 'close-config-editor') {
      state.configFileEditing = null;
      state.configFileEditMode = false;
      render();
      return;
    }
    if (name === 'enable-config-edit') {
      state.configFileEditMode = true;
      render();
      const textarea = document.querySelector('.config-file-editor textarea[name="content"]');
      if (textarea) textarea.focus({ preventScroll: true });
      return;
    }
    if (name === 'memory-view') {
      state.memoryView = action.dataset.view === 'timeline' ? 'timeline' : 'cards';
      render();
    }
    if (name === 'memory-tag-filter') {
      const tag = action.dataset.tag || '';
      state.memoryTagFilter = state.memoryTagFilter === tag ? '' : tag;
      render();
    }
    if (name === 'toggle-doc-writer') {
      state.docWriterOpen = !state.docWriterOpen;
      render();
    }
    if (name === 'open-doc-picker') {
      // Same click-driven picker as stickers: vendor in-app browsers don't
      // reliably fire a bubbling `change` for hidden, label-associated inputs.
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,.md,.markdown,.log,.json,.csv,text/*';
      input.setAttribute('aria-hidden', 'true');
      input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
      const cleanup = () => { try { input.remove(); } catch (err) {} };
      input.addEventListener('change', async () => {
        const file = (input.files || [])[0];
        cleanup();
        if (file) await addDocumentFromFile(file);
      });
      input.addEventListener('cancel', cleanup);
      document.body.appendChild(input);
      input.click();
    }
    if (name === 'toggle-doc') {
      const id = Number(action.dataset.id);
      state.docOpen[id] = !state.docOpen[id];
      render();
      if (state.docOpen[id] && state.docContent[id] == null) {
        try {
          const doc = await api(`/api/documents/${id}`);
          state.docContent[id] = String(doc.content || '');
        } catch (err) {
          state.docContent[id] = '（加载失败）';
        }
        render();
      }
    }
    if (name === 'delete-document') {
      if (!confirm('删除这份资料？')) return;
      try {
        await api(`/api/documents/${action.dataset.id}`, { method: 'DELETE' });
        await loadDocuments();
      } catch (err) {
        handleBackgroundError(err);
      }
    }
    if (name === 'toggle-pin') {
      try {
        await api(`/api/memory/${action.dataset.id}`, { method: 'PATCH', body: { pinned: !action.dataset.pinned } });
        await loadMemories();
      } catch (err) {
        handleBackgroundError(err);
      }
    }
    if (name === 'delete-memory') {
      if (!confirm('删除这条记忆？删掉就找不回来了。')) return;
      state.memoryReading = null;
      await api(`/api/memory/${action.dataset.id}`, { method: 'DELETE' });
      await loadMemories();
    }
    if (name === 'edit-memory') {
      const id = Number(action.dataset.id);
      state.memoryReading = null;
      state.memoryEditing = state.memories.find((item) => Number(item.id) === id) || null;
      if (state.memoryEditing) state.memoryOpen[id] = true;
      if (state.memoryEditing) state.memoryWriterOpen = true;
      render();
    }
    if (name === 'cancel-memory-edit') {
      state.memoryEditing = null;
      state.memoryWriterOpen = false;
      render();
    }
    if (name === 'toggle-memory-writer') {
      state.memoryEditing = null;
      state.memoryWriterOpen = !state.memoryWriterOpen;
      render();
    }
    if (name === 'toggle-memory-tools') {
      const hadQuery = Boolean(state.memoryQuery);
      const open = !(state.memoryToolsOpen || state.memoryQuery || state.memoryTagFilter);
      state.memoryToolsOpen = open;
      // 收起时把筛选一起松开,免得东西藏起来了还在过滤、看着像丢了日记
      if (!open) { state.memoryQuery = ''; state.memoryTagFilter = ''; }
      if (!open && hadQuery) await loadMemories(); else render();
    }
    if (name === 'toggle-memory') {
      const id = Number(action.dataset.id);
      state.memoryOpen[id] = !state.memoryOpen[id];
      render();
    }
    if (name === 'open-memory-reader') {
      state.memoryReading = Number(action.dataset.id);
      render();
    }
    if (name === 'close-memory-reader') {
      state.memoryReading = null;
      render();
    }
    if (name === 'memory-mood-pick') {
      const input = document.querySelector('[data-memory-form] input[name="mood"]');
      if (input) {
        input.value = action.dataset.mood || '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelectorAll('.memory-mood-pick').forEach((el) => {
        el.classList.toggle('on', el === action);
      });
    }
    if (name === 'remove-composer-part') {
      const scope = action.dataset.scope;
      const index = Number(action.dataset.index);
      if (state.composerParts[scope]) state.composerParts[scope].splice(index, 1);
      updateComposerDrafts(scope);
    }
    if (name === 'remove-pending-file') {
      const scope = action.dataset.scope;
      const index = Number(action.dataset.index);
      if (state.pending[scope]) state.pending[scope].splice(index, 1);
      updateComposerDrafts(scope);
    }
    if (name === 'edit-pending-file-name') {
      state.renamingFile = { scope: action.dataset.scope, index: Number(action.dataset.index) };
      render();
      const input = document.querySelector('[data-rename-input]');
      if (input) { input.focus({ preventScroll: true }); input.select(); }
      return;
    }
    if (name === 'cancel-pending-file-name') {
      state.renamingFile = null;
      render();
      return;
    }
    if (name === 'save-pending-file-name') {
      const scope = action.dataset.scope;
      const index = Number(action.dataset.index);
      const input = document.querySelector('[data-rename-input]');
      const next = input ? String(input.value || '').trim() : '';
      const list = state.pending[scope] || [];
      if (list[index] && next) list[index].name = next;   // 空名不接受,留原名
      state.renamingFile = null;
      updateComposerDrafts(scope);
      render();
      return;
    }
    if (name === 'edit-composer-part') {
      const scope = action.dataset.scope;
      const index = Number(action.dataset.index);
      const parts = state.composerParts[scope] || [];
      const text = parts.splice(index, 1)[0] || '';
      saveDraft(scope, text);
      const textarea = document.querySelector(`form[data-send-scope="${CSS.escape(scope)}"] textarea[name="content"]`);
      if (textarea) {
        textarea.value = text;
        autosizeTextarea(textarea);
        textarea.focus({ preventScroll: true });
      }
      updateComposerDrafts(scope);
    }
    if (name === 'console-shortcut') {
      const form = action.closest('form');
      const textarea = form && form.elements.command;
      if (textarea) {
        textarea.value = action.dataset.cmd || '';
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        autosizeTextarea(textarea);
      }
    }
    if (name === 'clear-memory-search') {
      state.memoryQuery = '';
      await loadMemories();
    }
    if (name === 'refresh-quota') {
      await loadQuota();
    }
    if (name === 'clear-token') {
      localStorage.removeItem('cc_companion_token');
      state.token = '';
      await loadBootstrap();
    }
  });

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    if (form.dataset.sendScope) await submitMessage(form.dataset.sendScope, form);
    if (form.dataset.consoleCommand) await submitConsoleCommand(form);
    if (form.dataset.memoryForm) await submitMemory(form);
    if (form.dataset.docForm) await submitDocument(form);
    if (form.dataset.configFileForm) await submitConfigFile(form);
    if (form.dataset.settingsForm) await submitSettings(form);
    if (form.dataset.authForm) await submitAuth(form);
  });

  document.addEventListener('change', async (event) => {
    const input = event.target;
    // ★ 下拉必须先接住,再进那道 HTMLInputElement 守卫。
    //   HTMLSelectElement **不继承** HTMLInputElement —— 我当初把 bridge-dial 分支写在
    //   守卫下面,于是它从上线起一次都没执行过:钮点了没反应,而且不报错。
    //   更该记的是我怎么「验过」的:我用 curl 从 App 代理一路打到桥进程,
    //   报「整条链通了」—— 但我验的是**断点下面那一层**,用户真正碰的那一下一次没点。
    //   → 验一个按钮,得从**按钮**开始验,不是从它底下的 API 开始验。
    if (input instanceof HTMLSelectElement && input.dataset.action === 'bridge-dial') {
      const field = input.dataset.field === 'model' ? 'model' : 'effort';
      try {
        state.bridge = await api('/api/bridge/config', { method: 'POST', body: { [field]: input.value } });
      } catch (err) { handleBackgroundError(err); }
      render();
      return;
    }
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.action === 'bridge-dial') {
      const field = input.dataset.field === 'model' ? 'model' : 'effort';
      try {
        state.bridge = await api('/api/bridge/config', { method: 'POST', body: { [field]: input.value } });
      } catch (err) { handleBackgroundError(err); }
      render();
      return;
    }
    if (input.dataset.fileScope) {
      const scope = input.dataset.fileScope;
      if (state.attachMenuOpen) state.attachMenuOpen[scope] = false;
      await uploadFiles(scope, Array.from(input.files || []));
    }
    if (input.dataset.stickerScope) {
      const scope = input.dataset.stickerScope;
      const file = (input.files || [])[0];
      input.value = '';
      if (file) await addStickerFromFile(scope, file);
    }
  });

  document.addEventListener('input', debounce(async (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.memorySearch) {
      state.memoryQuery = input.value;
      await loadMemories();
    }
    if (input.dataset.chatSearch) {
      const scope = input.dataset.scope || (state.tab === 'group' ? 'group' : 'chat');
      state.chatSearch[scope] = input.value;
      refreshSearchList(scope);
    }
  }, 250));

  document.addEventListener('input', (event) => {
    const node = event.target;
    if (node && node.matches && node.matches('input[name="session_max_tokens_k"]')) {
      const value = node.closest('.session-limit-row')?.querySelector('[data-session-limit-value]');
      if (value) value.textContent = `${node.value}K`;
    }
    if (node && node.tagName === 'TEXTAREA' && node.closest && node.closest('.composer-bar')) {
      autosizeTextarea(node);
      const form = node.closest('form');
      if (form && form.dataset.sendScope) handleComposerInput(form.dataset.sendScope, node);
    }
  });

  document.addEventListener('beforeinput', (event) => {
    const node = event.target;
    if (!node || node.tagName !== 'TEXTAREA') return;
    const form = node.closest('form');
    if (!form || !form.dataset.sendScope) return;
    if (!isLineBreakInput(event)) return;
    event.preventDefault();
    cacheComposerPart(form.dataset.sendScope, node);
  });

  document.addEventListener('keydown', (event) => {
    const node = event.target;
    if (!node || node.tagName !== 'TEXTAREA') return;
    const form = node.closest('form');
    if (!form) return;
    if (event.key === 'Enter' && form.dataset.sendScope && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      cacheComposerPart(form.dataset.sendScope, node);
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.memoryReading) {
      state.memoryReading = null;
      render();
      return;
    }
    if (event.key === 'Escape' && state.lightbox) {
      state.lightbox = null;
      render();
      return;
    }
    if (event.key === 'Escape' && state.filePreview) {
      state.filePreview = null;
      render();
    }
  });

  document.addEventListener('scroll', (event) => {
    const node = event.target;
    if (!node || !node.dataset || !node.dataset.scrollScope) return;
    const scope = node.dataset.scrollScope;
    state.scrollTop[scope] = node.scrollTop;
    state.stickToBottom[scope] = isNearBottom(node);
  }, true);
}

async function loadBootstrap() {
  try {
    const data = await api('/api/bootstrap');
    applyBootstrap(data, { offline: false });
    cacheBootstrap();
  } catch (err) {
    if (err && err.status === 401) {
      state.settings = null;
      state.error = err.message;
      renderAuth();
      return;
    }
    const cached = readCachedBootstrap();
    if (cached && cached.settings) {
      applyBootstrap(cached, { offline: true, error: `离线快照：${err.message}` });
      return;
    }
    state.error = err.message;
    renderAuth();
  }
}

async function refreshCurrent() {
  if (!state.settings) return;
  try {
    if (state.tab === 'home') await loadMemories();
    if (state.tab === 'chat') await loadMessages('chat');
    else if (state.tab === 'group') await loadMessages('group');
    // ★ 终端档那条状态行要额度数据,而额度原来只在设置页拉。
    //   只在**终端档**拉:工作流档看不到那条状态行,替它去查一次额度是白花一次往返。
    else if (state.tab === 'console') {
      await loadConsole();
      await loadBridgeConfig();
      if (state.consoleView === 'term') { await loadQuota(); await loadRawTail(); }
    }
    else if (state.tab === 'memory') {
      if (state.memoryTab === 'config') await loadConfigFiles();
      else if (state.memoryTab === 'docs') await loadDocuments();
      else await loadMemories();
    }
    else if (state.tab === 'settings') await loadQuota();
  } catch (err) {
    handleBackgroundError(err);
  }
}

async function loadMessages(scope) {
  const rows = await api(`/api/${scope}/messages`);
  state[scope] = rows || [];
  state.offline = false;
  state.error = '';
  cacheBootstrap();
  renderMessages(scope);
}

// 桥的档位/用量。取不到不是错 —— 这个部署可能压根没有桥,
// 所以失败就把 available 归 false 让面板消失,而不是弹错误给用户。
async function loadBridgeConfig() {
  const before = JSON.stringify(state.bridge || null);
  try {
    state.bridge = await api('/api/bridge/config');
  } catch {
    state.bridge = { available: false };
  }
  // ★ 拉完必须重绘。渲染发生在切 tab 的那一刻,而这个请求是**渲染之后**才回来的,
  //   只改 state 不重绘 = 面板永远等下一次别的重绘才出现,用户看到的就是"没有这块"。
  //   这是从下拉本身验才发现的第二处断点 —— 光验 API 层永远看不见。
  if (JSON.stringify(state.bridge || null) !== before && state.tab === 'console') render();
}

async function loadConsole() {
  state.events = await api('/api/console/events');
  state.offline = false;
  state.error = '';
  cacheBootstrap();
  render();
}

async function loadMemories() {
  state.memories = await api(`/api/memory?q=${encodeURIComponent(state.memoryQuery)}`);
  state.offline = false;
  state.error = '';
  cacheBootstrap();
  render();
}

// 终端档开屏先取最近一轮的尾巴 —— 原始流只在轮子跑着时才往外推,不取这一把,
// 平时点开永远是空框(反馈原话「这里面一直没有数据」)。
// 只在本地还一片空白时取:SSE 已经喂过数据就不取,免得同一批行进两遍。
async function loadRawTail() {
  if ((state.rawTail || []).length) return;
  try {
    const data = await api('/api/console/stream/tail');
    if (!Array.isArray(data.lines) || !data.lines.length) return;
    if ((state.rawTail || []).length) return;   // 取的路上 SSE 先到了 —— 它的更新,让它
    state.rawTail = data.lines.slice(-400);
    state.streamMeta = scanMeta(data.lines, state.streamMeta);
    if (state.tab === 'console' && state.consoleView === 'term') render();
  } catch { /* 尾巴取不到不挡终端本体,下次进档再试 */ }
}

async function loadQuota() {
  if (!state.settings) return;
  state.quota = { ...state.quota, loading: true, error: '' };
  if (state.tab === 'settings') render();
  try {
    const result = await api('/api/quota');
    state.quota = {
      loading: false,
      data: result.quota || null,
      error: '',
      fetched_at: new Date().toISOString(),
    };
    state.offline = false;
    state.error = '';
    cacheBootstrap();
  } catch (err) {
    state.quota = {
      ...state.quota,
      loading: false,
      error: err && err.message ? err.message : '查询失败',
    };
  } finally {
    if (state.tab === 'settings') render();
  }
}

async function submitMessage(scope, form) {
  const textarea = form.elements.content;
  const messages = composerMessages(scope, textarea);
  const attachments = state.pending[scope] || [];
  if (!messages.length && !attachments.length) return;
  const replyToId = (state.replyTo && state.replyTo[scope]) ? state.replyTo[scope].id : null;
  const outgoing = messages.length
    ? messages.map((content, index) => ({
        content,
        attachments: index === messages.length - 1 ? attachments : [],
      }))
    : [{ content: '', attachments }];
  const batchCreatedAt = new Date().toISOString();
  const tempMessages = outgoing.map((item) => optimisticMessage(scope, item.content, item.attachments, replyToId, batchCreatedAt));
  state[scope].push(...tempMessages);
  state.pending[scope] = [];
  state.composerParts[scope] = [];
  if (state.replyTo) state.replyTo[scope] = null;
  textarea.value = '';
  clearDraft(scope);
  textarea.blur();
  // ★ 自己发言 = 无条件回到最底下。
  //   `stickToBottom` 是按"用户有没有往上翻"自动算的:翻上去看旧消息时它变 false,
  //   于是新消息进来不打扰你。**但那条规则不该管到"你自己刚按下发送"** ——
  //   人翻上去找东西、顺手回一句,期待的是跳回自己那条,不是留在半空。
  //   放在乐观插入之后、render 之前:这一帧就带着新气泡滚到底,不用等服务端回。
  state.stickToBottom[scope] = true;
  render();
  try {
    const result = await api(`/api/${scope}/send`, {
      method: 'POST',
      body: {
        sender: state.settings.userName,
        messages: outgoing,
        reply_to_id: replyToId || undefined,
      },
    });
    removeMessagesById(scope, tempMessages.map((message) => message.id));
    if (Array.isArray(result.messages)) {
      for (const message of result.messages) upsertMessage(scope, message);
    }
    if (result.message) upsertMessage(scope, result.message);
    if (result.reply) upsertMessage(scope, result.reply);
    cacheBootstrap();
  } catch (err) {
    for (const message of tempMessages) message.failed = true;
    state.error = err && err.message ? err.message : '发送失败';
  } finally {
    render();
  }
}

async function submitConsoleCommand(form) {
  const textarea = form.elements.command;
  const command = textarea.value.trim();
  if (!command) return;
  textarea.value = '';
  autosizeTextarea(textarea);
  const result = await api('/api/console/commands', {
    method: 'POST',
    body: { command },
  });
  if (result.event) upsertById(state.events, result.event);
  if (Array.isArray(result.chat)) state.chat = result.chat;
  if (Array.isArray(result.group)) state.group = result.group;
  if (result.forge && result.forge.session) state.session = result.forge.session;
  if (result.session) state.session = result.session;
  if (result.quota) {
    state.quota = {
      loading: false,
      data: result.quota,
      error: '',
      fetched_at: new Date().toISOString(),
    };
  }
  state.events = state.events.slice(-500);
  cacheBootstrap();
  render();
}

async function submitMemory(form) {
  const title = form.elements.title.value.trim();
  const content = form.elements.content.value.trim();
  const mood = form.elements.mood.value.trim();
  const author = form.elements.author.value.trim();
  const tags = form.elements.tags.value.trim();
  // 事实键:填了同一个键,新的会顶掉旧的(旧的留档,只是不再喂给 AI)
  const fact_key = form.elements.fact_key ? form.elements.fact_key.value.trim() : '';
  if (!title && !content) return;
  if (state.memoryEditing && state.memoryEditing.id != null) {
    await api(`/api/memory/${state.memoryEditing.id}`, { method: 'PATCH', body: { title, content, mood, author, tags, fact_key } });
    state.memoryEditing = null;
  } else {
    await api('/api/memory', { method: 'POST', body: { title, content, mood, author, tags, fact_key } });
  }
  state.memoryWriterOpen = false;
  form.reset();
  await loadMemories();
}

async function submitSettings(form) {
  const previous = { ...state.settings };
  const body = Object.fromEntries(new FormData(form).entries());
  body.autoReplyGroup = form.elements.autoReplyGroup.checked;
  body.featureCopyAll = form.elements.featureCopyAll ? form.elements.featureCopyAll.checked : true;
  body.featureRecall = form.elements.featureRecall ? form.elements.featureRecall.checked : true;
  body.featureDelete = form.elements.featureDelete ? form.elements.featureDelete.checked : true;
  body.featureAutoExtract = form.elements.featureAutoExtract ? form.elements.featureAutoExtract.checked : true;
  body.featureSemanticSearch = form.elements.featureSemanticSearch ? form.elements.featureSemanticSearch.checked : true;
  state.settings = await api('/api/settings', { method: 'POST', body });
  applySettingsRename(previous, state.settings);
  cacheBootstrap();
  applyTheme();
  render();
}

async function submitAuth(form) {
  const token = form.elements.token.value.trim();
  localStorage.setItem('cc_companion_token', token);
  state.token = token;
  await loadBootstrap();
}

async function uploadFiles(scope, files) {
  if (!files.length) return;
  state.busy = true;
  updateComposerDrafts(scope);
  try {
    for (const file of files) {
      state.uploading[scope] = `准备 ${file.name}...`;
      updateComposerDrafts(scope);
      const upload = await prepareUpload(file);
      state.uploading[scope] = `上传 ${file.name}...`;
      updateComposerDrafts(scope);
      const uploaded = await api('/api/uploads', {
        method: 'POST',
        body: upload,
      });
      state.pending[scope].push(uploaded);
      updateComposerDrafts(scope);
    }
    state.uploading[scope] = '';
  } catch (err) {
    state.uploading[scope] = `上传失败：${err.message}`;
  } finally {
    state.busy = false;
    updateComposerDrafts(scope);
  }
}

function pickAttachments(kind, multiple = true) {
  return new Promise((resolve) => {
    // Keep the native picker outside #app. SSE/bootstrap renders replace #app's
    // innerHTML; an input living there can disappear while Android's picker is
    // open, so its eventual change event never reaches our delegated listener.
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = kind === 'image'
      ? 'image/*'
      : '.pdf,.txt,.md,.json,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,application/*,text/*';
    input.hidden = true;
    document.body.appendChild(input);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', finish, { once: true });
    input.addEventListener('cancel', finish, { once: true });
    input.click();
  });
}

function render() {
  if (!state.settings) return renderAuth();
  applyTheme();
  root.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">${esc(initials(state.settings.assistantName))}</div>
          <div>
            <div class="brand-title">${esc(state.settings.appName)}</div>
            <div class="brand-subtitle">${esc(agentProviderLabel())}</div>
          </div>
        </div>
        <nav class="nav">${tabs.map(([id, label, short]) => navButton(id, label, short)).join('')}</nav>
        <div class="side-footer">
          <div>用户：${esc(state.settings.userName)}</div>
          <div>AI：${esc(state.settings.assistantName)}</div>
        </div>
      </aside>
      <section class="main">
        ${renderTopbar()}
        <div class="content">${renderTab()}</div>
      </section>
    </div>
    ${renderMemoryReader()}
    ${renderLightbox()}
    ${renderFilePreview()}`;
  scrollLists();
  // 星空主题的动态零件(背景星野 / 页头主星的环和珠子)要在 DOM 落地之后挂。
  // 非 starry 主题时它自己会把东西收干净,不用在这儿判断。
  hydrateStarry(root);
  // (首屏不再需要水合:新素材把银河和夜空画在同一张图里,没有要 JS 撒的星尘了)
  markLoadedIcons(root);
  // ★ 令牌用完即焚 —— 放在这儿而不是 renderMore 里面,是为了让渲染函数保持"只读 state"。
  //   (renderMore 里改 state 也能work,但那会让"渲染有副作用"成为这个文件的先例。)
  if (state.moreAnim) state.moreAnim = false;
}

// 入口图标:DOM 刚重建完,**已经加载好的图立刻补上 .lit**,别等它的 load 事件。
//
// ★ 为什么需要这一步:每次 render() 都会把首屏整块重建,新的 <img> 上没有 .lit;
//   图明明在缓存里(complete=true),但 `.lit` 要等 load 事件那个**任务**才补上 ——
//   中间那一帧占位圆是亮着的。实测热缓存三轮里两轮抓到 `6 星 / 0 lit / 6 张图已完成` 的采样帧。
//   ⚠️ 那一帧的可见性其实很低(占位圆画在徽章底下、又不到 60ms),
//      **但这行代码的成本比"它到底看不看得见"这个问题还低**,就不留着了。
// ★ 同时它也堵住评审提的那个反向竞态(load 早于监听挂上 → .lit 永远打不上)。
//   ⚠️ 那个竞态我**没能复现**(冷 1 轮 + 热 3 轮,终态全是 6/6/6)——
//      内联 onload 是随元素一起解析的,load 又必然异步派发,理论上轮不到它。
//      写这一行不是因为量到了它,是因为**我的测量证不了"永远不会"**,而这行只要三句。
function markLoadedIcons(scope) {
  for (const img of scope.querySelectorAll('.sg-star img')) {
    if (img.complete && img.naturalWidth > 0) img.parentNode.classList.add('lit');
  }
}

function renderLightbox() {
  if (!state.lightbox) return '';
  return `<div class="lightbox" data-action="close-lightbox" role="dialog" aria-label="查看图片">
    <img src="${escAttr(state.lightbox.url)}" alt="${escAttr(state.lightbox.name || 'image')}">
    <div class="lightbox-bar">
      <span class="lightbox-name">${esc(state.lightbox.name || '')}</span>
      <a href="${escAttr(state.lightbox.url)}" target="_blank" rel="noreferrer" class="lightbox-open">原图</a>
      <button type="button" class="lightbox-close" data-action="close-lightbox" aria-label="关闭">×</button>
    </div>
  </div>`;
}

/* 文件预览层。8/14 她圈着一条 .md 说「文件发出来长这样有点草率」——
   在这之前文件卡片点下去只会新开一个标签页(手机上等于跳出 App 去下载),
   想看一眼里面写了什么得先离开聊天。这里就地读:md 走聊天同一套 markdown,
   其它文本走等宽原文。二进制根本不给这个入口(卡片那边就不挂 data-action)。 */
const FILE_PREVIEW_LIMIT = 256 * 1024;   // 超出只读前 256KB,手机上再多也是卡住自己
function renderFilePreview() {
  const fp = state.filePreview;
  if (!fp) return '';
  let body;
  if (fp.status === 'loading') {
    body = '<div class="fp-hint">读取中…</div>';
  } else if (fp.status === 'error') {
    body = `<div class="fp-hint fp-error">打不开这个文件${fp.error ? `：${esc(fp.error)}` : ''}</div>`;
  } else if (!String(fp.text || '').trim()) {
    body = '<div class="fp-hint">空文件</div>';
  } else if (fp.isHtml && fp.htmlMode !== 'source') {
    // ★ 8/14 她问「html 也可以看吗」——能点开,但原来只给源码。一个网页看源码
    //   等于把菜谱端上桌。这里直接把它渲染出来。
    // ★ 走 src= 不走 srcdoc:srcdoc 要把整份 HTML 塞进一个属性里转义,大文件还会
    //   撞上 256KB 那道读取上限;src 是浏览器自己去取,原样、完整。
    // ★ sandbox 只给 allow-scripts,**不给** allow-same-origin —— 两个一起给等于
    //   没有沙箱(页面能反过来摸这个 App 的 token/localStorage)。单给脚本时它跑在
    //   一个不透明源里,自己玩自己的。
    body = `<iframe class="fp-frame" src="${escAttr(fp.url)}" sandbox="allow-scripts"
      referrerpolicy="no-referrer" title="${escAttr(fp.name || '网页预览')}"></iframe>`;
  } else if (fp.isMarkdown) {
    // ★ 借气泡那套 .body-text.md 的皮:标题/列表/表格/代码块的样式全挂在它下面,
    //   自己再写一份必然漏掉几样(第一版就漏了表格边框和代码块底色,截图里裸成一堆字)。
    body = `<div class="fp-md body-text md">${renderMarkdown(fp.text)}</div>`;
  } else {
    body = `<pre class="fp-code"><code>${esc(fp.text)}</code></pre>`;
  }
  return `<div class="file-preview" role="dialog" aria-label="文件预览">
    <div class="fp-scrim" data-action="close-file-preview"></div>
    <div class="fp-panel">
      <div class="fp-head">
        <span class="fp-badge" aria-hidden="true">${esc(fp.ext || '文件')}</span>
        <span class="fp-title">${esc(fp.name || '')}</span>
        ${fp.isHtml ? `<button type="button" class="fp-raw fp-mode" data-action="fp-html-mode">${fp.htmlMode === 'source' ? '看页面' : '看源码'}</button>` : ''}
        <a class="fp-raw" href="${escAttr(fp.url)}" target="_blank" rel="noreferrer">原文</a>
        <button type="button" class="fp-close" data-action="close-file-preview" aria-label="关闭">×</button>
      </div>
      <div class="fp-body">
        ${body}
        ${fp.truncated ? '<div class="fp-hint fp-truncated">文件较大，只显示了前 256KB，剩下的点「原文」看</div>' : ''}
      </div>
    </div>
  </div>`;
}

async function openFilePreview({ url, name, ext }) {
  state.filePreview = {
    url,
    name,
    ext,
    status: 'loading',
    text: '',
    isMarkdown: /\.(md|markdown)$/i.test(name || ''),
    // 网页默认渲染成页面;想看源码在头上切一下。判据只认扩展名 ——
    // 和 isPreviewable 那儿同一条规矩(上传方给的 mime 不可信)。
    isHtml: /\.html?$/i.test(name || ''),
    htmlMode: 'render',
    truncated: false,
  };
  render();
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    // 竞态:读的过程中她可能已经关掉了、或点开了另一个文件。认 url 再落文本。
    if (!state.filePreview || state.filePreview.url !== url) return;
    state.filePreview.truncated = raw.length > FILE_PREVIEW_LIMIT;
    state.filePreview.text = state.filePreview.truncated ? raw.slice(0, FILE_PREVIEW_LIMIT) : raw;
    state.filePreview.status = 'ready';
  } catch (err) {
    if (!state.filePreview || state.filePreview.url !== url) return;
    state.filePreview.status = 'error';
    state.filePreview.error = err && err.message ? err.message : '';
  }
  render();
}

// Incremental update: re-render ONLY the message list for a chat scope, leaving the composer
// (textarea focus/cursor/value), sidebar and topbar untouched. Used for incoming/polled messages so
// they don't blow away the whole page (which lost composer focus mid-typing and caused flicker).
// Click handling is delegated on document, so replacing the list's innerHTML keeps all handlers.
// Falls back to a full render() if the expected list node isn't mounted yet.
function renderMessages(scope) {
  const list = document.querySelector(`.message-list[data-scroll-scope="${CSS.escape(scope)}"]`);
  if (!list) {
    render();
    return;
  }
  const rows = scope === 'group' ? state.group : state.chat;
  list.innerHTML = renderMessageList(scope, rows);
  scrollLists();
}

function renderAuth() {
  root.innerHTML = `
    <main class="auth-card">
      <h1>CC Companion</h1>
      <p class="brand-subtitle">如果服务器开启了 APP_AUTH_TOKEN，在这里输入访问口令。</p>
      ${state.error ? `<p class="server-note">${esc(state.error)}</p>` : ''}
      <form data-auth-form="1" class="stack">
        <div class="form-row">
          <label>访问口令</label>
          <input name="token" type="password" value="${escAttr(state.token)}" autocomplete="current-password">
        </div>
        <button class="primary" type="submit">进入</button>
      </form>
    </main>`;
}

function renderTopbar() {
  // 记忆 tab 的顶栏跟着小 tab 走 —— 页里不再重复一遍标题
  const mem = state.tab === 'memory' ? memoryTabHeading() : null;
  const title = mem ? mem.title : (state.tab === 'chat'
    ? state.settings.assistantName
    : (state.tab === 'home'
      ? state.settings.appName
      : state.tab === 'group'
      ? state.settings.groupName
      // ★「更多」不在 tabs 表里(它没有底栏格位,只从首屏那颗北斗进),
      //   照原来那条 find 会落到兜底的 'App' —— 顶栏顶着 "App" 两个字。
      : state.tab === 'more'
      ? '更多'
      : (tabs.find(([id]) => id === state.tab)?.[1] || 'App')));
  const subtitle = mem ? mem.subtitle : {
    home: '',
    chat: `和 ${state.settings.assistantName} 单独说话。`,
    group: `共享房间，提到 @${state.settings.agentMention} 会唤起 AI。`,
    console: '查看运行事件、回复和调试日志。',
    memory: '保存会被 AI 参考的长期记忆。',
    settings: '调整名字、群聊触发和主题。',
    more: '北斗上的功能位，空着的留给你自己加。',
  }[state.tab];
  const chatProfile = state.tab === 'chat' ? `
    <div class="topbar-profile">
      <span class="topbar-polaroid"><img src="${escAttr(protectedAssetUrl(state.settings.assistant_avatar || '/assets/stars/star-private-core.webp'))}" alt=""></span>
      <span class="topbar-profile-copy">
        <strong>${esc(state.settings.assistantName)}</strong>
        <small>${esc(state.settings.assistant_signature || '今天也在这里')}</small>
      </span>
    </div>` : '';
  return `
    <header class="topbar${mem ? ' topbar-paper' : ''}${state.tab === 'home' ? ' topbar-home' : ''}">
      <div class="topbar-title">
        ${state.tab === 'home' ? '' : `<button type="button" class="topbar-home-btn" data-action="tab" data-tab="home" aria-label="回首页" title="回首页"><span class="home-glyph-star" aria-hidden="true">✦</span><svg class="home-glyph-vane" viewBox="0 0 24 24" aria-hidden="true"><path d="m11.2 10.8-6.8-2 .9-2.9 6.2 4.3M13.2 11.2l2-6.8 2.9.9-4.3 6.2M12.8 13.2l6.8 2-.9 2.9-6.2-4.3M10.8 12.8l-2 6.8-2.9-.9 4.3-6.2"></path><circle cx="12" cy="12" r="1.45"></circle><path d="M10.4 13.3 9 21h6l-1.4-7.7"></path></svg></button>`}
        ${mem && mem.back ? '<button type="button" class="topbar-back" data-action="memory-tab" data-tab="home" aria-label="回记忆">‹</button>' : ''}
        <!-- ★ 顶栏那颗装饰球(orbMarkup)撤掉:它 aria-hidden、不可点、每一页都挂一个,
             占掉标题左边一大块却不回答任何问题。留下的 ✦ 是**回首页键**(有 aria-label),
             跟它长得像但不是一回事 —— 底栏是全局拆掉的,✦ 是每页唯一的回家路。 -->
        ${chatProfile || `<div class="topbar-title-text"><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>`}
      </div>
      <div class="topbar-actions">
        ${(state.tab === 'chat' || state.tab === 'group') ? renderChatSearchBtn(state.tab) : ''}
        ${state.tab === 'chat' ? renderFavFilterBtn('chat') : ''}
        ${(state.tab === 'chat' || state.tab === 'group') ? renderChatToolsMenu(state.tab) : ''}
        <button type="button" class="theme-cycle-btn" data-action="cycle-theme" aria-label="更换主题" title="更换主题：奶油白 → 浮岛 → 星空 → 暖深色"><span class="theme-cycle-glyph" aria-hidden="true"></span></button>
      </div>
    </header>`;
}


async function loadSearchPool(scope) {
  try {
    const rows = await api(`/api/${scope}/messages?limit=500`);
    state.searchPool[scope] = Array.isArray(rows) ? rows : [];
    refreshSearchList(scope);
  } catch (err) {
    // Search then falls back to the messages already loaded.
  }
}

function refreshSearchList(scope) {
  if (!(state.chatSearchOpen && state.chatSearchOpen[scope])) return;
  const rows = scope === 'group' ? state.group : state.chat;
  const results = document.querySelector('.chat-search-results');
  if (results) results.innerHTML = renderSearchResults(scope, rows);
  const hits = searchMessages(scope, rows);
  const count = document.querySelector(`[data-search-count="${CSS.escape(scope)}"]`);
  if (count) count.textContent = hits ? `${hits.length} 条` : '';
}

function ensureMessageLoaded(scope, id) {
  const rows = scope === 'group' ? state.group : state.chat;
  if (rows.some((m) => String(m.id) === String(id))) return;
  const pool = state.searchPool[scope] || [];
  if (!pool.length) return;
  const byId = new Map();
  for (const m of [...pool, ...rows]) byId.set(String(m.id), m);
  const merged = [...byId.values()].sort((a, b) => (Number(a.id) || Infinity) - (Number(b.id) || Infinity));
  if (scope === 'group') state.group = merged; else state.chat = merged;
}



function renderTab() {
  if (state.tab === 'home') return renderHome();
  if (state.tab === 'chat') return renderChat('chat', state.chat);
  if (state.tab === 'group') return renderChat('group', state.group);
  if (state.tab === 'console') return renderConsole();
  if (state.tab === 'memory') return renderMemory();
  if (state.tab === 'more') return renderMore();
  return renderSettings({ notifySupported, notifyEnabled });
}




function notifySupported() {
  return typeof Notification !== 'undefined';
}

function notifyEnabled() {
  return notifySupported() && localStorage.getItem('cc-notify') === '1' && Notification.permission === 'granted';
}

// Fire a system notification for assistant messages (heartbeat ones included)
// arriving while the page is in the background. Device-local preference.
function maybeNotify(message) {
  if (!message || message.role !== 'assistant') return;
  if (!document.hidden || !notifyEnabled()) return;
  const body = String(message.content || '').slice(0, 90) || '[图片]';
  try {
    const note = new Notification(message.sender || 'AI', { body, tag: `cc-msg-${message.id}` });
    note.onclick = () => {
      try { window.focus(); } catch (err) { /* ignore */ }
      note.close();
    };
  } catch (err) {
    // Some in-app browsers expose Notification but throw on construction.
  }
}

async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  // navigator.clipboard only exists in a secure context (HTTPS or localhost). This app is commonly
  // self-hosted over plain HTTP, where navigator.clipboard is undefined — so fall back to a
  // temporary <textarea> + execCommand('copy'), which works in non-secure contexts too.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (err) {
      // fall through to the legacy path
    }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    const selection = document.getSelection();
    const saved = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (saved && selection) {
      selection.removeAllRanges();
      selection.addRange(saved);
    }
    return ok;
  } catch (err) {
    return false;
  }
}

function flashCopied(button, ok) {
  if (!button) return;
  if (!button.dataset.copyLabel) button.dataset.copyLabel = button.textContent || '复制';
  button.textContent = ok ? '已复制' : '复制失败';
  button.classList.toggle('copied', ok);
  button.classList.toggle('copy-failed', !ok);
  clearTimeout(button._copyTimer);
  button._copyTimer = setTimeout(() => {
    button.textContent = button.dataset.copyLabel || '复制';
    button.classList.remove('copied', 'copy-failed');
  }, 1400);
}

function scrollToMessage(id) {
  requestAnimationFrame(() => {
    const node = document.getElementById('msg-' + id);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1600);
  });
}

function findMessageById(id) {
  const key = String(id);
  return [...(state.chat || []), ...(state.group || [])].find((m) => String(m.id) === key) || null;
}





async function loadStickers() {
  try {
    state.stickers = (await api('/api/stickers')) || [];
    render();
  } catch (err) {
    // ignore — stickers just won't show
  }
}

function openStickerPicker(scope) {
  if (!state.stickerStatus) state.stickerStatus = {};
  // Vendor in-app browsers (Honor/Baidu WebView etc.) often don't fire a bubbling `change` for a
  // hidden, label-associated <input> caught via document delegation. So we trigger the picker from a
  // click (clicks work reliably here) using a fresh on-DOM input with a DIRECT change listener.
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.setAttribute('aria-hidden', 'true');
  input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
  const cleanup = () => { try { input.remove(); } catch (e) {} };
  input.addEventListener('change', async () => {
    const file = (input.files || [])[0];
    cleanup();
    if (file) {
      await addStickerFromFile(scope, file);
    } else {
      state.stickerStatus[scope] = '';
      render();
    }
  });
  // Some webviews fire a `cancel` event when the picker is dismissed with no selection.
  input.addEventListener('cancel', () => { cleanup(); state.stickerStatus[scope] = ''; render(); });
  document.body.appendChild(input);
  input.click();
  // Immediate feedback so a stuck step is visible: if this text lingers, the picker opened but
  // `change` never fired; if it never appears, the tap didn't route.
  state.stickerStatus[scope] = '已打开选择器，选张图…';
  render();
}

// 弹一次系统选图,返回 File 或 null。隐藏 input 的写法照抄贴纸那条已经跑通的路径 ——
// 尤其 `cancel` 事件:有些 webview 取消时只发 cancel 不发 change,不收就会一直等下去。
function pickOneImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.setAttribute('aria-hidden', 'true');
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    const done = (file) => { try { input.remove(); } catch (e) {} resolve(file); };
    input.addEventListener('change', () => done((input.files || [])[0] || null));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

async function addStickerFromFile(scope, file) {
  if (!file) return;
  if (!state.stickerStatus) state.stickerStatus = {};
  // Show progress right in the sticker panel so a failure is never silent.
  state.stickerStatus[scope] = '上传中…';
  render();
  try {
    const upload = await prepareUpload(file);
    const uploaded = await api('/api/uploads', { method: 'POST', body: upload });
    await api('/api/stickers', {
      method: 'POST',
      body: { url: uploaded.url, name: uploaded.name, type: uploaded.type, width: uploaded.width, height: uploaded.height },
    });
    state.stickerStatus[scope] = '✓ 已添加，点它放进输入框再发送';
    await loadStickers();
  } catch (err) {
    state.stickerStatus[scope] = '上传失败：' + (err && err.message ? err.message : '未知错误');
  }
  render();
}

function pickSticker(scope, sticker) {
  if (!sticker || !sticker.url) return;
  if (!state.pending[scope]) state.pending[scope] = [];
  // Drop the sticker into the composer draft (just like an uploaded image) so it goes out with the
  // normal → send button. This makes it unmistakable that a sticker can be sent.
  state.pending[scope].push({
    url: sticker.url,
    name: sticker.name || 'sticker',
    type: sticker.type || 'image/png',
    width: sticker.width,
    height: sticker.height,
    sticker: true,
  });
  updateComposerDrafts(scope);
}
















async function submitDocument(form) {
  const name = String(form.elements.name.value || '').trim();
  const content = String(form.elements.content.value || '').trim();
  if (!content) return;
  try {
    await api('/api/documents', { method: 'POST', body: { name: name || '未命名资料', content, source: 'typed' } });
    state.docWriterOpen = false;
    state.docStatus = '';
    await loadDocuments();
  } catch (err) {
    state.docStatus = '失败：' + (err && err.message ? err.message : '未知错误');
    render();
  }
}

async function loadDocuments() {
  try {
    const rows = await api('/api/documents');
    state.documents = Array.isArray(rows) ? rows : [];
    render();
  } catch (err) {
    handleBackgroundError(err);
  }
}

async function loadConfigFiles() {
  try {
    const rows = await api('/api/config-files');
    state.configFiles = Array.isArray(rows) ? rows : [];
    state.configFileStatus = '';
    render();
  } catch (err) {
    state.configFileStatus = `加载失败：${err.message}`;
    render();
  }
}

async function submitConfigFile(form) {
  const id = String(form.dataset.id || '');
  const content = String(form.elements.content.value || '');
  if (!id) return;
  state.configFileStatus = '正在保存…';
  try {
    const saved = await api(`/api/config-files/${id}`, { method: 'PUT', body: { content } });
    state.configFileEditing = saved;
    await loadConfigFiles();
    state.configFileEditing = saved;
    state.configFileEditMode = false;
    state.configFileStatus = `已保存 ${saved.name}`;
    render();
  } catch (err) {
    state.configFileStatus = `保存失败：${err.message}`;
    render();
  }
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

async function addDocumentFromFile(file) {
  if (!file) return;
  state.docStatus = '上传中…';
  render();
  try {
    if (file.size > 500 * 1024) throw new Error('文本文件需在 500KB 以内。');
    const content = await readFileAsText(file);
    await api('/api/documents', { method: 'POST', body: { name: file.name, content, source: 'upload' } });
    state.docStatus = '';
    await loadDocuments();
  } catch (err) {
    state.docStatus = '失败：' + (err && err.message ? err.message : '未知错误');
    render();
  }
}
























function streamStatusLabel() {
  const labels = {
    idle: '待连接',
    connecting: '连接中',
    live: '实时',
    reconnecting: '重连中',
    fallback: '轮询',
  };
  return labels[state.streamStatus] || state.streamStatus || '待连接';
}

function navButton(id, label, short) {
  const counts = {
    chat: state.chat.length,
    group: state.group.length,
    console: state.events.length,
    memory: state.memories.length,
    settings: '',
  };
  const icon = ICONS[id] || '';
  return `<button type="button" class="${state.tab === id ? 'active' : ''}" data-action="tab" data-tab="${id}" aria-label="${escAttr(label)}"><span class="nav-icon">${icon}</span><span class="nav-label">${esc(label)}</span><span class="nav-short">${esc(short || label)}</span><span class="count">${counts[id]}</span></button>`;
}

async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    headers: { accept: 'application/json' },
  };
  if (state.token) init.headers['x-app-token'] = state.token;
  if (options.body) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // A secondary page request must not throw the whole App back to the login
    // screen. Bootstrap owns the actual login decision; console/quota/search
    // requests can fail independently and should surface as ordinary errors.
    const err = new Error(data.message || data.error || `HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

function applyBootstrap(data, options = {}) {
  state.settings = data.settings;
  state.chat = data.chat || [];
  state.group = data.group || [];
  state.events = data.console || data.events || [];
  state.memories = data.memories || [];
  state.session = data.session || state.session;
  if (data.version) state.appVersion = data.version;
  if (data.quota) {
    state.quota = Object.prototype.hasOwnProperty.call(data.quota, 'data')
      ? { loading: false, data: data.quota.data || null, error: data.quota.error || '', fetched_at: data.quota.fetched_at || '' }
      : { loading: false, data: data.quota, error: '', fetched_at: '' };
  }
  state.error = options.error || '';
  state.offline = options.offline === true;
  applyTheme();
  render();
}

function connectStream() {
  if (!state.settings || state.offline) return;
  if (!('EventSource' in window)) {
    startFallbackPolling();
    return;
  }
  stopFallbackPolling();
  if (eventStream) eventStream.close();
  const token = state.token ? `?token=${encodeURIComponent(state.token)}` : '';
  state.streamStatus = 'connecting';
  render();
  eventStream = new EventSource(`/api/stream${token}`);
  eventStream.onopen = () => {
    state.streamStatus = 'live';
    state.offline = false;
    render();
  };
  eventStream.onerror = () => {
    if (!state.offline) {
      state.streamStatus = 'reconnecting';
      render();
    }
  };
  eventStream.addEventListener('snapshot', (event) => {
    const data = parseStreamData(event);
    if (!data) return;
    applyStreamSnapshot(data);
  });
  eventStream.addEventListener('message', (event) => {
    const data = parseStreamData(event);
    if (!data || !data.scope || !data.message) return;
    if (data.message.role === 'assistant' && state.streaming[data.scope]) state.streaming[data.scope] = null;
    upsertMessage(data.scope, data.message);
    state.offline = false;
    cacheBootstrap();
    renderMessages(data.scope);
    maybeNotify(data.message);
  });
  eventStream.addEventListener('message-stream', (event) => {
    const data = parseStreamData(event);
    const scope = data && data.scope;
    if ((scope !== 'chat' && scope !== 'group') || !data.stream_id) return;
    if (data.phase === 'start') {
      state.streaming[scope] = {
        id: `stream-${data.stream_id}`,
        stream_id: data.stream_id,
        scope,
        sender: data.sender || state.settings.assistantName || 'AI',
        role: 'assistant',
        content: '',
        thinking: '',
        attachments: [],
        parent_msg_id: data.parent_msg_id || null,
        created_at: data.created_at || new Date().toISOString(),
        pending: true,
        streaming: true,
      };
      renderMessages(scope);
      return;
    }
    const current = state.streaming[scope];
    if (!current || String(current.stream_id) !== String(data.stream_id)) return;
    if (data.phase === 'end') {
      state.streaming[scope] = null;
      renderMessages(scope);
      return;
    }
    if (data.phase !== 'delta') return;
    current.content += String(data.content || '');
    current.thinking += String(data.thinking || '');
    patchStreamingMessage(scope, current);
  });
  eventStream.addEventListener('deleted', (event) => {
    const data = parseStreamData(event);
    if (!data || !data.scope || data.id == null) return;
    removeMessagesById(data.scope, [data.id]);
    cacheBootstrap();
    renderMessages(data.scope);
  });
  eventStream.addEventListener('cleared', (event) => {
    const data = parseStreamData(event);
    if (!data || (data.scope !== 'chat' && data.scope !== 'group')) return;
    state[data.scope] = [];
    cacheBootstrap();
    renderMessages(data.scope);
  });
  eventStream.addEventListener('console', (event) => {
    const data = parseStreamData(event);
    if (!data || !data.event) return;
    upsertById(state.events, data.event);
    state.events = state.events.slice(-500);
    cacheBootstrap();
    if (state.tab === 'console') render();
  });
  eventStream.addEventListener('memory', (event) => {
    const data = parseStreamData(event);
    if (!data) return;
    if (data.action === 'deleted') state.memories = state.memories.filter((item) => Number(item.id) !== Number(data.id));
    else if (data.memory) upsertById(state.memories, data.memory);
    cacheBootstrap();
    if (state.tab === 'memory') render();
  });
  // 真 console 的原始流。★ 只塞进内存环形缓冲 —— 不写 store、不写 localStorage,
  //   刷新即空。这条通道对用户的库零写入,那是它的验收项。
  eventStream.addEventListener('console-stream', (event) => {
    const data = parseStreamData(event);
    if (!data || !Array.isArray(data.lines)) return;
    const RAW_CAP = 400;   // 一轮 ~510 行,留最近 400 行够看,再多是白占内存
    state.rawTail = [...(state.rawTail || []), ...data.lines].slice(-RAW_CAP);
    // 花费和额度重置时间只在这条流里出现 —— 扫描要在**入队时**做,不能挪进渲染:
    // 环形缓冲会把老行挤掉,那条报花费的 result 行一旦被挤走,渲染时就再也扫不到了。
    state.streamMeta = scanMeta(data.lines, state.streamMeta);
    // 只有正开着终端档才重绘 —— 否则后台每 120ms 整页重绘是纯浪费
    if (state.tab === 'console' && state.consoleView === 'term') render();
  });
  eventStream.addEventListener('settings', (event) => {
    const data = parseStreamData(event);
    if (!data || !data.settings) return;
    state.settings = data.settings;
    applyTheme();
    cacheBootstrap();
    render();
  });
}

function parseStreamData(event) {
  try {
    return JSON.parse(event.data || '{}');
  } catch {
    return null;
  }
}

function applyStreamSnapshot(data) {
  if (data.settings) state.settings = data.settings;
  if (Array.isArray(data.chat)) state.chat = data.chat;
  if (Array.isArray(data.group)) state.group = data.group;
  if (Array.isArray(data.console)) state.events = data.console;
  if (Array.isArray(data.memories)) state.memories = data.memories;
  if (data.session) state.session = data.session;
  state.offline = false;
  state.streamStatus = 'live';
  cacheBootstrap();
  render();
}

function applySettingsRename(previous, next) {
  if (!previous || !next) return;
  renameLocalSender(previous.userName, next.userName);
  renameLocalSender(previous.assistantName, next.assistantName);
  renameLocalMemoryAuthor(previous.assistantName, next.assistantName);
}

function renameLocalSender(from, to) {
  if (!from || !to || from === to) return;
  for (const scope of ['chat', 'group']) {
    for (const message of state[scope] || []) {
      if (message.sender === from) message.sender = to;
    }
  }
}

function renameLocalMemoryAuthor(from, to) {
  if (!from || !to || from === to) return;
  for (const memory of state.memories || []) {
    if (memory.author === from) memory.author = to;
  }
}

function upsertMessage(scope, message) {
  if (scope !== 'chat' && scope !== 'group') return;
  upsertById(state[scope], message);
}

function patchStreamingMessage(scope, stream) {
  const row = document.querySelector(`[data-stream-id="${CSS.escape(String(stream.stream_id))}"]`);
  if (!row) { renderMessages(scope); return; }
  const content = row.querySelector('.stream-content');
  if (content) content.innerHTML = stream.content ? renderMarkdown(stream.content) : '';
  const thinking = row.querySelector('.stream-thinking');
  if (thinking) thinking.textContent = stream.thinking || '正在思考…';
  const details = row.querySelector('.stream-cot');
  if (details && stream.thinking) details.open = true;
  if (state.stickToBottom[scope]) scrollLists();
}

function removeMessagesById(scope, ids) {
  if (scope !== 'chat' && scope !== 'group') return;
  const remove = new Set((ids || []).map(String));
  state[scope] = state[scope].filter((message) => !remove.has(String(message.id)));
}

function upsertById(list, item) {
  if (!item || item.id == null) return;
  const id = Number(item.id);
  const index = list.findIndex((entry) => Number(entry.id) === id);
  if (index >= 0) list[index] = item;
  else list.push(item);
}

function startFallbackPolling() {
  state.streamStatus = 'fallback';
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => refreshCurrent().catch(handleBackgroundError), 15000);
  render();
}

function stopFallbackPolling() {
  if (!fallbackTimer) return;
  clearInterval(fallbackTimer);
  fallbackTimer = null;
}

function cacheBootstrap() {
  if (!state.settings) return;
  try {
    localStorage.setItem(BOOTSTRAP_CACHE_KEY, JSON.stringify({
      settings: state.settings,
      chat: state.chat,
      group: state.group,
      console: state.events,
      memories: state.memories,
      session: state.session,
      quota: state.quota,
      cached_at: new Date().toISOString(),
    }));
  } catch {
    // Local storage can be unavailable in private browsing or full quota states.
  }
}

function saveDraft(scope, text) {
  try {
    localStorage.setItem(DRAFT_KEY_PREFIX + scope, String(text || ''));
  } catch {
    // Draft persistence is best effort.
  }
}

function loadDraft(scope) {
  try {
    return localStorage.getItem(DRAFT_KEY_PREFIX + scope) || '';
  } catch {
    return '';
  }
}

function clearDraft(scope) {
  try {
    localStorage.removeItem(DRAFT_KEY_PREFIX + scope);
  } catch {
    // Draft persistence is best effort.
  }
}

function composerMessages(scope, textarea) {
  const current = textarea.value.trim();
  return [...(state.composerParts[scope] || []), current].map((part) => part.trim()).filter(Boolean);
}

function optimisticMessage(scope, content, attachments = [], parentId = null, createdAt = '') {
  return {
    id: TEMP_ID_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    scope,
    sender: state.settings.userName,
    role: 'user',
    content,
    attachments,
    parent_msg_id: parentId || null,
    msg_type: 'chat',
    created_at: createdAt || new Date().toISOString(),
    pending: true,
  };
}

function cacheComposerPart(scope, textarea) {
  const value = textarea.value.trim();
  if (!value) return;
  state.composerParts[scope] = state.composerParts[scope] || [];
  state.composerParts[scope].push(value);
  textarea.value = '';
  clearDraft(scope);
  updateComposerDrafts(scope);
  autosizeTextarea(textarea);
  textarea.focus({ preventScroll: true });
}

function isLineBreakInput(event) {
  return event.inputType === 'insertLineBreak'
    || event.inputType === 'insertParagraph'
    || event.data === '\n';
}

function handleComposerInput(scope, textarea) {
  if (textarea.value.includes('\n')) {
    const pieces = textarea.value.split(/\n+/).map((part) => part.trim()).filter(Boolean);
    if (pieces.length) {
      state.composerParts[scope] = state.composerParts[scope] || [];
      state.composerParts[scope].push(...pieces);
    }
    textarea.value = '';
    clearDraft(scope);
    updateComposerDrafts(scope);
    autosizeTextarea(textarea);
    textarea.focus({ preventScroll: true });
    return;
  }
  saveDraft(scope, textarea.value);
}

function updateComposerDrafts(scope) {
  const form = document.querySelector(`form[data-send-scope="${CSS.escape(scope)}"]`);
  if (!form) return render();
  const bar = form.querySelector('.composer-bar');
  const hasDrafts = Boolean((state.composerParts[scope] || []).length || (state.pending[scope] || []).length || state.uploading[scope]);
  if (bar) bar.classList.toggle('has-parts', hasDrafts);
  const list = document.querySelector(`[data-scroll-scope="${CSS.escape(scope)}"]`);
  if (!list) return render();
  const existing = list.querySelector(`.message-drafts[data-draft-scope="${CSS.escape(scope)}"]`);
  const html = renderComposerDrafts(scope);
  const empty = Array.from(list.children).find((child) => child.classList && child.classList.contains('empty'));
  if (html && empty) empty.remove();
  if (existing) {
    if (html) existing.outerHTML = html;
    else existing.remove();
  } else if (html) {
    list.insertAdjacentHTML('beforeend', html);
  }
  if (!html && !(state[scope] || []).length && !list.querySelector('.empty')) {
    list.insertAdjacentHTML('beforeend', '<div class="empty">还没有消息。</div>');
  }
  if (state.stickToBottom[scope] !== false) list.scrollTop = list.scrollHeight;
}



function readCachedBootstrap() {
  try {
    const raw = localStorage.getItem(BOOTSTRAP_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function handleBackgroundError(err) {
  if (!state.settings) return;
  state.offline = true;
  state.error = err && err.message ? err.message : '离线';
  render();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('Service worker registration failed:', err);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

async function prepareUpload(file) {
  const isImage = String(file.type || '').startsWith('image/');
  if (!isImage || file.type === 'image/gif' || file.size <= SMALL_IMAGE_BYTES) {
    // Non-images / gifs / already-small files are sent as-is, so enforce the size cap here.
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('文件需在 10MB 以内。');
    return {
      name: file.name,
      data: await readFileAsDataUrl(file),
      original_size: file.size,
      optimized: false,
    };
  }
  // Large images fall through to compression below (a phone photo can be >10MB before compressing),
  // so we deliberately do NOT reject on raw size here.

  try {
    const decoded = await decodeImage(file);
    try {
      const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(decoded.width, decoded.height));
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const outputType = file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
      const context = canvas.getContext('2d', { alpha: outputType === 'image/webp', desynchronized: true });
      if (!context) throw new Error('Image canvas is unavailable.');
      if (outputType === 'image/jpeg') {
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
      }
      context.drawImage(decoded.source, 0, 0, width, height);
      const compressed = await canvasToBlob(canvas, outputType, IMAGE_QUALITY);
      const selected = compressed.size < file.size ? compressed : file;
      const optimized = selected !== file;
      return {
        name: optimized ? replaceImageExtension(file.name, outputType) : file.name,
        data: await readFileAsDataUrl(selected),
        original_size: file.size,
        width: optimized ? width : decoded.width,
        height: optimized ? height : decoded.height,
        optimized,
      };
    } finally {
      decoded.release();
    }
  } catch (err) {
    // Some in-app browsers (e.g. vendor browsers) can't decode/resize images via canvas. Fall back
    // to sending the raw image so uploads and stickers still work — but if it couldn't be compressed
    // and is still over the cap, surface a clear error instead of a silent failure.
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('图片太大且无法压缩，请换 10MB 以内的图片。');
    return { name: file.name, data: await readFileAsDataUrl(file), original_size: file.size, optimized: false };
  }
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      let bitmap;
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        bitmap = await createImageBitmap(file);
      }
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // createImageBitmap exists but failed (some vendor in-app browsers). Fall through to the
      // <img> + canvas path below, which is more widely supported, so compression still happens.
    }
  }

  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  await image.decode();
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Image compression failed.'));
    }, type, quality);
  });
}

function replaceImageExtension(name, type) {
  const ext = type === 'image/webp' ? '.webp' : '.jpg';
  return String(name || 'image').replace(/\.[^.]+$/, '') + ext;
}

function scrollLists() {
  requestAnimationFrame(() => {
    for (const node of document.querySelectorAll('[data-scroll-list]')) {
      const scope = node.dataset.scrollScope || '';
      if (!scope || state.stickToBottom[scope] !== false) {
        node.scrollTop = node.scrollHeight;
      } else {
        node.scrollTop = state.scrollTop[scope] || 0;
      }
    }
    for (const node of document.querySelectorAll('.composer-bar textarea')) autosizeTextarea(node);
  });
}


function applyTheme() {
  const t = state.settings && state.settings.theme;
  document.body.dataset.theme = ['light', 'starry', 'island'].includes(t) ? t : 'dark';
  // ★ 把当前页也挂到 body 上:样式要「只在某一页生效」时,总得有个抓手。
  //   之前没有,于是想给私聊单独定规矩就只能改模板 —— 而模板是各页共用的。
  document.body.dataset.tab = state.tab || 'chat';
  // 这里不水合:applyTheme 是 render() 开头调的,那会儿 root 还是上一帧的 DOM。
  // 水合统一放在 render() 结尾(DOM 已就位),切主题也是走 render,不会漏。
}










/* Markdown 渲染已整体搬去 js/markdown.js(现在也支持表格);
   protectedAssetUrl 搬去 js/state.js —— 三个视图模块都要用它包 /uploads/ 的 src,
   留在壳里只有壳够得着,头像就是这么漏的。 */
