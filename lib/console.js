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

// 原始流的内存尾巴。只住内存、不碰 store —— 「零落库」是这条通道的验收项,不许动摇。
// 有它,终端档点开就能看到最近一轮的尾巴;原来只有实况广播,不赶巧撞上正在跑的轮,
// 点开永远是空框(反馈原话「这里面一直没有数据」)。进程重启即空,如实不装。
let rawRing = [];
const RAW_RING_CAP = 400;   // 与前端环形缓冲同数:一轮 ~510 行,尾巴 400 行够看

function pushRawLines(lines) {
  rawRing = [...rawRing, ...lines].slice(-RAW_RING_CAP);
}

function rawTailLines() {
  return rawRing;
}

export { addConsoleEvent, latestConsoleEvents, pushRawLines, rawTailLines };
