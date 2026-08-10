// 消息与表情包的增删改查:私聊/群聊两个 scope 共用,全部变更即时落盘并广播。
import fs from 'node:fs';
import path from 'node:path';
import { store, saveStore, nextId, DATA_DIR } from './state.js';
import { cleanString, clampLimit, normalizeAttachments, publicMessage } from './util.js';
import { broadcastSse } from './sse.js';

function addMessage(scope, input) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const message = {
    id: nextId('message'),
    scope,
    sender: cleanString(input.sender, 'unknown'),
    role: input.role === 'assistant' ? 'assistant' : 'user',
    content: cleanString(input.content, ''),
    thinking: cleanString(input.thinking, ''),
    attachments: normalizeAttachments(input.attachments),
    parent_msg_id: input.parent_msg_id == null ? null : Number(input.parent_msg_id),
    msg_type: input.msg_type || 'chat',
    session_id: cleanString(input.session_id, store.session && store.session.current_id || ''),
    created_at: new Date().toISOString(),
  };
  store[key].push(message);
  saveStore();
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
  if (message.role !== 'user') return null;  // only the user's own messages are recallable (沈屿 #6676 P2)
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
  saveStore();
  broadcastSse('deleted', { scope, id: Number(id) });
  return true;
}

function clearMessages(scope) {
  const key = scope === 'group' ? 'group_messages' : 'chat_messages';
  const rows = Array.isArray(store[key]) ? store[key] : [];
  const count = rows.length;
  if (count) {
    // Undo path: dump what we're about to wipe, timestamped, so a misclick is recoverable. (沈屿 #6676 P1)
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
