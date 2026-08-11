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
} from './js/state.js';
import { renderConsole, renderConsoleEvent } from './js/console-view.js';
import { renderSettings, renderQuotaPanel, agentProviderLabel } from './js/settings-view.js';
import { renderMemory, renderMemoryReader, memoryTabHeading } from './js/memory-view.js';
import {
  renderChat, renderChatToolsMenu, renderChatSearchBtn, renderFavFilterBtn,
  renderComposerDrafts, renderMessageList, searchMessages, renderMessage, renderAttachmentDraft,
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
  document.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const name = action.dataset.action;
    if (name === 'tab') {
      state.tab = action.dataset.tab || 'chat';
      render();
      await refreshCurrent().catch(handleBackgroundError);
    }
    if (name === 'console-view') {
      state.consoleView = action.dataset.view === 'term' ? 'term' : 'flow';
      render();
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
        const file = await pickOneImage();
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
      const ok = await copyText(body ? body.textContent : '');
      flashCopied(action, ok);
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
        const input = document.querySelector(`.chat-search-row input[data-scope="${CSS.escape(scope)}"]`);
        if (input) input.focus();
      }
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
      state.memoryTab = ['home', 'docs', 'all'].includes(tab) ? tab : 'diary';
      state.memoryToolsOpen = false;
      // 换一叠就把筛选松开:「全部条目」里筛着 auto 再切回日记,日记会空成 0 条(日记本就不含 auto)
      const hadQuery = Boolean(state.memoryQuery);
      state.memoryTagFilter = '';
      state.memoryQuery = '';
      render();
      if (state.memoryTab === 'docs') loadDocuments();
      else if (hadQuery) loadMemories();
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
    if (input.dataset.fileScope) await uploadFiles(input.dataset.fileScope, Array.from(input.files || []));
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
    else if (state.tab === 'console') { await loadConsole(); await loadBridgeConfig(); }
    else if (state.tab === 'memory') await loadMemories();
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
  const tempMessages = outgoing.map((item) => optimisticMessage(scope, item.content, item.attachments, replyToId));
  state[scope].push(...tempMessages);
  state.pending[scope] = [];
  state.composerParts[scope] = [];
  if (state.replyTo) state.replyTo[scope] = null;
  textarea.value = '';
  clearDraft(scope);
  textarea.blur();
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
    ${renderLightbox()}`;
  scrollLists();
  // 星空主题的动态零件(背景星野 / 页头主星的环和珠子)要在 DOM 落地之后挂。
  // 非 starry 主题时它自己会把东西收干净,不用在这儿判断。
  hydrateStarry(root);
  // (首屏不再需要水合:新素材把银河和夜空画在同一张图里,没有要 JS 撒的星尘了)
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
      : (tabs.find(([id]) => id === state.tab)?.[1] || 'App')));
  const subtitle = mem ? mem.subtitle : {
    home: '',
    chat: `和 ${state.settings.assistantName} 单独说话。`,
    group: `共享房间，提到 @${state.settings.agentMention} 会唤起 AI。`,
    console: '查看运行事件、回复和调试日志。',
    memory: '保存会被 AI 参考的长期记忆。',
    settings: '调整名字、群聊触发和主题。',
  }[state.tab];
  const status = state.offline ? '离线快照' : (state.settings.agent.configured ? 'API 已配置' : '演示模式');
  const live = state.offline ? status : `${streamStatusLabel()} - ${status}`;
  return `
    <header class="topbar${mem ? ' topbar-paper' : ''}${state.tab === 'home' ? ' topbar-home' : ''}">
      <div class="topbar-title">
        ${state.tab === 'home' ? '' : '<button type="button" class="topbar-home-btn" data-action="tab" data-tab="home" aria-label="回首页" title="回首页">✦</button>'}
        ${mem && mem.back ? '<button type="button" class="topbar-back" data-action="memory-tab" data-tab="home" aria-label="回记忆">‹</button>' : ''}
        <!-- ★ 顶栏那颗装饰球(orbMarkup)撤掉:它 aria-hidden、不可点、每一页都挂一个,
             占掉标题左边一大块却不回答任何问题。留下的 ✦ 是**回首页键**(有 aria-label),
             跟它长得像但不是一回事 —— 底栏是全局拆掉的,✦ 是每页唯一的回家路。 -->
        <div class="topbar-title-text"><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>
      </div>
      <div class="topbar-actions">
        ${(state.tab === 'chat' || state.tab === 'group') ? renderChatSearchBtn(state.tab) : ''}
        ${(state.tab === 'chat' || state.tab === 'group') ? `<span class="only-wide">${renderFavFilterBtn(state.tab)}</span>` : ''}
        ${(state.tab === 'chat' || state.tab === 'group') ? renderChatToolsMenu(state.tab) : ''}
        <div class="status-pill" title="${escAttr(live)}"><span class="pill-long">${esc(live)}</span><span class="pill-short">${esc(streamStatusLabel())}</span></div>
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
  const list = document.querySelector(`.message-list[data-scroll-scope="${CSS.escape(scope)}"]`);
  if (!list) return;
  list.innerHTML = renderMessageList(scope, scope === 'group' ? state.group : state.chat);
  const hits = searchMessages(scope, scope === 'group' ? state.group : state.chat);
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
    if (response.status === 401) state.settings = null;
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
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
    upsertMessage(data.scope, data.message);
    state.offline = false;
    cacheBootstrap();
    renderMessages(data.scope);
    maybeNotify(data.message);
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

function optimisticMessage(scope, content, attachments = [], parentId = null) {
  return {
    id: TEMP_ID_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    scope,
    sender: state.settings.userName,
    role: 'user',
    content,
    attachments,
    parent_msg_id: parentId || null,
    msg_type: 'chat',
    created_at: new Date().toISOString(),
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
  document.body.dataset.theme = ['light', 'starry'].includes(t) ? t : 'dark';
  // ★ 把当前页也挂到 body 上:样式要「只在某一页生效」时,总得有个抓手。
  //   之前没有,于是想给私聊单独定规矩就只能改模板 —— 而模板是各页共用的。
  document.body.dataset.tab = state.tab || 'chat';
  // 这里不水合:applyTheme 是 render() 开头调的,那会儿 root 还是上一帧的 DOM。
  // 水合统一放在 render() 结尾(DOM 已就位),切主题也是走 render,不会漏。
}










/* Markdown light renderer —— 起因是 AI 的回复里 **粗体** / - 列表 / # 标题 都以原文露出来了。
   Safety model: esc() the whole string FIRST, then run regexes over the escaped text.
   Any <script> in the source is already &lt;script&gt; by then, so the tags this
   function inserts are the only HTML in the output.
   Scope kept deliberately narrow (not the full spec): bold / italic / inline code /
   code fence / links, plus "- list" and "# heading". No tables,
   blockquotes, images, or nested lists. */




function protectedAssetUrl(url) {
  const value = String(url || '');
  if (!state.token || !value.startsWith('/uploads/')) return value;
  const separator = value.includes('?') ? '&' : '?';
  return `${value}${separator}token=${encodeURIComponent(state.token)}`;
}
