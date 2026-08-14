// 消息与表情包的增删改查:私聊/群聊两个 scope 共用,全部变更即时落盘并广播。
import fs from 'node:fs';
import path from 'node:path';
import { store, saveStore, nextId, DATA_DIR } from './state.js';
import { cleanString, clampLimit, normalizeAttachments, publicMessage } from './util.js';
import { broadcastSse } from './sse.js';

// 只留 name + arg,各自截断。数据来自**外部 bridge**,长度和形状不该由它说了算;
// 而这行字最后要挤进一个聊天气泡。
function normalizeTools(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 40).map((t) => ({
    name: cleanString(t && t.name, '').slice(0, 60),
    arg: cleanString(t && t.arg, '').slice(0, 160),
  })).filter((t) => t.name);
}

function addMessage(scope, input) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const message = {
    id: nextId('message'),
    scope,
    sender: cleanString(input.sender, 'unknown'),
    role: input.role === 'assistant' ? 'assistant' : 'user',
    content: cleanString(input.content, ''),
    thinking: cleanString(input.thinking, ''),
    // ★ 这一轮 agent 用过的工具:[{name, arg}]。
    //   **必须显式列在这儿** —— 上面这个 message 是个显式字面量,没列出来的字段会被
    //   静默丢掉:调用方传了、返回 200、值却从来没落地,而且两边都不报错。
    //   (同一个坑本仓库栽过一次:normalizeSettings 的 skyIcons。)
    tools: normalizeTools(input.tools),
    attachments: normalizeAttachments(input.attachments),
    parent_msg_id: input.parent_msg_id == null ? null : Number(input.parent_msg_id),
    msg_type: input.msg_type || 'chat',
    session_id: cleanString(input.session_id, store.session && store.session.current_id || ''),
    created_at: new Date().toISOString(),
  };
  store[key].push(message);
  // ★ 带 hint:只写这一行(sqlite 后端),而不是整文件重写。
  //   Node 实测:103KB(一个真实库)整写 2.05ms、745KB 12.1ms、3.6MB 48.8ms;
  //   逐行写恒 0.33ms。今天赢 6 倍,库长大之后赢到 150 倍 —— 买的是增长,不是现在。
  //   不带 hint 也**正确**,只是退回全量 —— 所以只挑最热的两处改,其余 20 个原样不动:
  //   这是稳妥优先的取舍,不是懒。
  saveStore({ kind: 'message', row: message });
  broadcastSse('message', { scope, message: publicMessage(message) });
  return message;
}

function latestMessages(scope, limit = 80) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  return store[key].slice(-clampLimit(limit)).map(publicMessage);
}

function addSticker(input) {
  if (!Array.isArray(store.stickers)) store.stickers = [];
  const sticker = {
    id: nextId('sticker'),
    url: cleanString(input && input.url, ''),
    name: cleanString(input && input.name, 'sticker'),
    type: cleanString(input && input.type, 'image/png'),
    width: Number(input && input.width) || null,
    height: Number(input && input.height) || null,
    created_at: new Date().toISOString(),
  };
  store.stickers.push(sticker);
  saveStore();
  broadcastSse('stickers', { stickers: store.stickers });
  return sticker;
}

function deleteSticker(id) {
  if (!Array.isArray(store.stickers)) return false;
  const before = store.stickers.length;
  store.stickers = store.stickers.filter((s) => Number(s.id) !== Number(id));
  if (store.stickers.length === before) return false;
  saveStore();
  broadcastSse('stickers', { stickers: store.stickers });
  return true;
}

function setMessageFavorite(scope, id, favorited) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const message = store[key].find((m) => Number(m.id) === Number(id));
  if (!message) return null;
  message.favorited = !!favorited;
  saveStore();
  broadcastSse('message', { scope, message: publicMessage(message) });
  return publicMessage(message);
}

function recallMessage(scope, id) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const message = (store[key] || []).find((m) => Number(m.id) === Number(id));
  if (!message) return null;
  if (message.role !== 'user') return null;  // only the user's own messages are recallable
  message.recalled = true;
  message.recalled_at = new Date().toISOString();
  saveStore();
  broadcastSse('message', { scope, message: publicMessage(message) });
  return publicMessage(message);
}

function deleteMessage(scope, id) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  if (!Array.isArray(store[key])) return false;
  const before = store[key].length;
  store[key] = store[key].filter((m) => Number(m.id) !== Number(id));
  if (store[key].length === before) return false;
  // 带 hint:sqlite 走行级删除。不带的话兜底 replaceAll 会拿「回复还引用着这条」的
  // 整表去重插,撞 parent_msg_id 外键(#70③ 就是这么 500 的);JSON 后端忽略 hint,照旧全量写。
  saveStore({ kind: 'message_delete', id: Number(id) });
  broadcastSse('deleted', { scope, id: Number(id) });
  return true;
}

function clearMessages(scope) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const rows = Array.isArray(store[key]) ? store[key] : [];
  const count = rows.length;
  if (count) {
    // Undo path: dump what we're about to wipe, timestamped, so a misclick is recoverable.
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(DATA_DIR, `cleared-${scope}-${stamp}.json`), JSON.stringify(rows, null, 2));
    } catch (err) {
      console.error('clearMessages backup failed:', err && err.message);
    }
  }
  store[key] = [];
  saveStore();
  broadcastSse('cleared', { scope });
  return count;
}

export {
  addMessage, latestMessages, addSticker, deleteSticker,
  setMessageFavorite, recallMessage, deleteMessage, clearMessages,
};
