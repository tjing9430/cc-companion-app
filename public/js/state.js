// 全局可变状态 + 常量 + 图标。所有视图模块都从这里拿 state。
// ★ 这是「碰 state 的那些函数」的落脚点:第一刀我把两个碰 state 的函数
//   当纯工具搬进 util.js,整站掉回登录页。有了这个模块,以后碰 state 的
//   东西 import 它就行,不用被迫留在 app.js。
// state 是**同一个对象引用**被所有模块共享 —— 谁改都生效,和拆分前的行为一致。

const CONSOLE_COMMANDS = [
  ['/forge', 'Forge'],
  ['/quota', 'Quota'],
  ['/list', 'List'],
  ['/switch ', 'Switch'],
  ['/current', 'Current'],
  ['/name ', 'Name'],
];

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const SMALL_IMAGE_BYTES = 280 * 1024;

const IMAGE_MAX_EDGE = 1440;

const IMAGE_QUALITY = 0.8;

const BOOTSTRAP_CACHE_KEY = 'cc_companion_bootstrap_snapshot_v1';

const DRAFT_KEY_PREFIX = 'cc_draft_';

const TEMP_ID_PREFIX = 'temp-';

const ICONS = {
  chat:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H8.5L5 16v-3H6a2 2 0 0 1-2-2V6z"/></svg>',
  group:   '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.2" cy="7.8" r="2.5"/><circle cx="13.6" cy="8.6" r="2"/><path d="M2.5 16c.4-2.5 2.3-4 4.7-4s4.3 1.5 4.7 4M12 16c.3-1.9 1.6-3 3-3s2.5 1.1 2.5 3"/></svg>',
  console: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M6 8l2.5 2L6 12M10.5 12.8h4"/></svg>',
  memory:  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3.5h10v13l-5-3.5-5 3.5v-13z"/></svg>',
  settings:'<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2M10 15.5v2M3.5 10h2M14.5 10h2M5.4 5.4l1.4 1.4M13.2 13.2l1.4 1.4M5.4 14.6l1.4-1.4M13.2 6.8l1.4-1.4"/></svg>',
  plus:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11"/></svg>',
  send:    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 10h13M11 4.5l5.5 5.5L11 15.5"/></svg>',
  sticker: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="6.7"/><circle class="sk-eye" cx="7.7" cy="8.5" r=".9" fill="currentColor" stroke="none"/><circle class="sk-eye sk-eye2" cx="12.3" cy="8.5" r=".9" fill="currentColor" stroke="none"/><path class="sk-mouth" d="M7.4 11.9c.7.9 1.6 1.4 2.6 1.4s1.9-.5 2.6-1.4"/></svg>',
};

const state = {
  tab: 'chat',
  settings: null,
  chat: [],
  group: [],
  events: [],
  memories: [],
  session: null,
  quota: { loading: false, data: null, error: '', fetched_at: '' },
  pending: { chat: [], group: [] },
  composerParts: { chat: [], group: [] },
  replyTo: { chat: null, group: null },
  showFavorites: { chat: false, group: false },
  chatSearchOpen: { chat: false, group: false },
  chatSearch: { chat: '', group: '' },
  searchPool: { chat: null, group: null },
  openMsgActions: null,   // 反馈#4:每条底下 5 个按钮太重 → 收进 ⋮,这里记展开的那条 id
  topbarMenuOpen: false,  // 反馈#1:顶栏挤成一坨 → 复制全部/清空 收进 ⋯
  renamingFile: null,     // 反馈#12:附件草稿只有「删除」没「编辑」→ {scope,index} 表示正在改名的那个
  openEvents: {},         // 日志页展开的条目 id→true(可同时展开多条,跟消息气泡的单开不同)
  memoryTab: 'home',
  documents: [],
  docContent: {},
  docOpen: {},
  docWriterOpen: false,
  stickerOpen: { chat: false, group: false },
  stickers: [],
  uploading: { chat: '', group: '' },
  memoryQuery: '',
  memoryEditing: null,
  memoryWriterOpen: false,
  memoryOpen: {},
  memoryReading: null,
  memoryView: 'cards',
  memoryTagFilter: '',
  memoryToolsOpen: false,
  stickToBottom: { chat: true, group: true, console: true },
  scrollTop: { chat: 0, group: 0, console: 0 },
  busy: false,
  token: localStorage.getItem('cc_companion_token') || '',
  error: '',
  offline: false,
  streamStatus: 'idle',
};

export {
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
};
