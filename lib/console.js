// 控制台事件流:落 store、限长、实时广播。命令分发(handleConsoleCommand)是聚合层,留在 server.js。
import { store, saveStore, nextId } from './state.js';
import { cleanString, clampLimit } from './util.js';
import { broadcastSse } from './sse.js';

function addConsoleEvent(kind, title, body = '') {
  const event = {
    id: nextId('console'),
    kind: cleanString(kind, 'event'),
    title: cleanString(title, 'event'),
    body: cleanString(body, ''),
    created_at: new Date().toISOString(),
  };
  store.console_events.push(event);
  if (store.console_events.length > 500) store.console_events = store.console_events.slice(-500);
  // 500 条封顶那一刀,sqlite 侧由 putConsoleEvent 的 trim 对应执行,两边同一个数
  saveStore({ kind: 'console', row: event });
  broadcastSse('console', { event });
  return event;
}

function latestConsoleEvents(limit = 120) {
  return store.console_events.slice(-clampLimit(limit));
}

export { addConsoleEvent, latestConsoleEvents };
