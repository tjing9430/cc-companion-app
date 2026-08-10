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
} from './js/state.js';
import { renderConsole, renderConsoleEvent } from './js/console-view.js';
import { renderSettings, renderQuotaPanel, agentProviderLabel } from './js/settings-view.js';
const root = document.getElementById('app');
let eventStream = null;
let fallbackTimer = null;



const tabs = [
  ['chat',     '私聊',   '私聊'],
  ['group',    '群聊',   '群聊'],
  ['console',  '控制台', '日志'],
  ['memory',   '记忆',   '记忆'],
  ['settings', '设置',   '设置'],
];

boot();

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
    if (!(input instanceof HTMLInputElement)) return;
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
    if (state.tab === 'chat') await loadMessages('chat');
    else if (state.tab === 'group') await loadMessages('group');
    else if (state.tab === 'console') await loadConsole();
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
  // 记忆 tab 的顶栏跟着小 tab 走 —— 页里不再重复一遍标题(反馈 #47434)
  const mem = state.tab === 'memory' ? memoryTabHeading() : null;
  const title = mem ? mem.title : (state.tab === 'chat'
    ? state.settings.assistantName
    : (state.tab === 'group'
      ? state.settings.groupName
      : (tabs.find(([id]) => id === state.tab)?.[1] || 'App')));
  const subtitle = mem ? mem.subtitle : {
    chat: `和 ${state.settings.assistantName} 单独说话。`,
    group: `共享房间，提到 @${state.settings.agentMention} 会唤起 AI。`,
    console: '查看运行事件、回复和调试日志。',
    memory: '保存会被 AI 参考的长期记忆。',
    settings: '调整名字、群聊触发和主题。',
  }[state.tab];
  const status = state.offline ? '离线快照' : (state.settings.agent.configured ? 'API 已配置' : '演示模式');
  const live = state.offline ? status : `${streamStatusLabel()} - ${status}`;
  return `
    <header class="topbar${mem ? ' topbar-paper' : ''}">
      <div class="topbar-title">
        ${mem && mem.back ? '<button type="button" class="topbar-back" data-action="memory-tab" data-tab="home" aria-label="回记忆">‹</button>' : ''}
        <div class="topbar-title-text"><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>
      </div>
      <div class="topbar-actions">
        ${(state.tab === 'chat' || state.tab === 'group') ? renderChatSearchBtn(state.tab) : ''}
        ${(state.tab === 'chat' || state.tab === 'group') ? renderFavFilterBtn(state.tab) : ''}
        ${(state.tab === 'chat' || state.tab === 'group') ? renderChatToolsMenu(state.tab) : ''}
        <div class="status-pill" title="${escAttr(live)}"><span class="pill-long">${esc(live)}</span><span class="pill-short">${esc(streamStatusLabel())}</span></div>
      </div>
    </header>`;
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

function renderTab() {
  if (state.tab === 'chat') return renderChat('chat', state.chat);
  if (state.tab === 'group') return renderChat('group', state.group);
  if (state.tab === 'console') return renderConsole();
  if (state.tab === 'memory') return renderMemory();
  return renderSettings({ notifySupported, notifyEnabled });
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

function renderQuotedParent(message) {
  if (!message || !message.parent_msg_id) return '';
  // Every assistant reply is tagged with the message that triggered it; don't render that as a
  // quote (it would show on every single reply). Only show quotes for explicit user replies.
  if (message.role === 'assistant') return '';
  const parent = findMessageById(message.parent_msg_id);
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
      <div class="avatar">${esc(initials(message.sender))}</div>
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
  const url = protectedAssetUrl(file.url || '');
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
        <img src="${escAttr(protectedAssetUrl(s.url))}" alt="${escAttr(s.name || 'sticker')}" loading="lazy" decoding="async">
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
  const draft = loadDraft(scope);
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
      <div class="avatar">${esc(initials(state.settings.userName))}</div>
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
      <div class="avatar">${esc(initials(state.settings.userName))}</div>
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
      <span class="mem-home-dot" aria-hidden="true"></span>
      <span class="mem-home-heart" aria-hidden="true">♡</span>
    </div>`;
}

function renderMemory() {
  // 返回箭头在顶栏(‹ 日记),页里不再放导航
  if (state.memoryTab === 'home') return renderMemoryHome();
  if (state.memoryTab === 'docs') return renderDocs();
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
  // 全部条目是「翻库」的地方:搜索框和标签一直摆在外面,跟内容一起往上滚(反馈 #47455)
  // 日记只有几篇、要留白,还是收在放大镜里
  if (isAll) {
    return `
      <div class="memory-view mem-lib">
        ${searchRow}
        <div class="mem-lib-views">${viewToggle}</div>
        <div class="mem-tag-scroll">${renderMemoryTagChips(all)}</div>
        <div class="memory-list">
          ${shown.length
            ? (view === 'timeline' ? renderMemoryTimeline(shown) : shown.map(renderMemoryItem).join(''))
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

// 六个快选 + 「自己写一个」输入框 —— 沈屿的心情是自由短语,规格不对齐就一眼看得出
// 谁是系统给的、谁是自己写的(小匠 #7023)
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
// 不放正文预览:点标题进全屏本子看全文(反馈 #7012「下面不要内容,是编辑/删除」)
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
        <button class="memory-back" type="button" data-action="close-memory-reader">‹ 日记</button>
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
  document.body.dataset.theme = state.settings && state.settings.theme === 'light' ? 'light' : 'dark';
}





function memoryAuthor(memory) {
  return String(memory && memory.author || state.settings.assistantName || 'AI').trim();
}





/* Markdown light renderer (bao #2: AI replies showed raw **bold** / - list / # heading)
   Safety model: esc() the whole string FIRST, then run regexes over the escaped text.
   Any <script> in the source is already &lt;script&gt; by then, so the tags this
   function inserts are the only HTML in the output.
   Scope kept narrow (shenyu: don't do the full spec): bold / italic / inline code /
   code fence / links, plus the "- list" and "# heading" bao named. No tables,
   blockquotes, images, or nested lists. */




function protectedAssetUrl(url) {
  const value = String(url || '');
  if (!state.token || !value.startsWith('/uploads/')) return value;
  const separator = value.includes('?') ? '&' : '?';
  return `${value}${separator}token=${encodeURIComponent(state.token)}`;
}
