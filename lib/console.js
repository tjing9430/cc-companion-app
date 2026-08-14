// 控制台事件流:落 store、限长、实时广播。命令分发(handleConsoleCommand)是聚合层,留在 server.js。
import fs from 'node:fs';
import path from 'node:path';
import { store, saveStore, nextId, DATA_DIR } from './state.js';
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

// 原始流的内存尾巴。不碰 store —— 「主库零写入」是这条通道的验收项,不许动摇。
// 有它,终端档点开就能看到最近一轮的尾巴;原来只有实况广播,不赶巧撞上正在跑的轮,
// 点开永远是空框(反馈原话「这里面一直没有数据」)。
//
// ★ 8/14 起尾巴**落一个独立小文件**(DATA_DIR/console-tail.json),重启不再清空。
//   起因:8/14 凌晨上浮岛版重启服务,内存环一清,她昨天那 44 行没了 ——
//   反馈原话「昨天明明应该有记录的,为什么今天又什么都没了」。
//   ★★ 「零落库」的验收项没有动摇:红线①量的是 app-data.json / app.db 一个字节不长,
//     这个小文件在主库外面,一轮封顶 ~160KB(400 行 × 4000 字上限),不进任何查询链路。
//   ★ 写盘是 500ms 合并 + tmp/rename 原子换 —— 一轮 ~510 行是几十次 push,
//     逐次全量写会把 SSD 当草稿纸用;进程被 kill -9 最多丢最后半秒,可接受。
let rawRing = [];
const RAW_RING_CAP = 400;   // 与前端环形缓冲同数:一轮 ~510 行,尾巴 400 行够看
const TAIL_FILE = path.join(DATA_DIR, 'console-tail.json');

try {
  const saved = JSON.parse(fs.readFileSync(TAIL_FILE, 'utf8'));
  // 只认「字符串数组」这一种形状;文件被人手改坏就当没有,空着起步,不抛不挡启动。
  if (Array.isArray(saved)) rawRing = saved.filter((l) => typeof l === 'string').slice(-RAW_RING_CAP);
} catch { /* 没有文件(首跑)或坏 JSON:空着起步 */ }

let tailTimer = null;
let tailWarned = false;
function scheduleTailSave() {
  if (tailTimer) return;
  tailTimer = setTimeout(() => {
    tailTimer = null;
    try {
      fs.writeFileSync(`${TAIL_FILE}.tmp`, JSON.stringify(rawRing));
      fs.renameSync(`${TAIL_FILE}.tmp`, TAIL_FILE);
    } catch (err) {
      // 只报第一次:写不进去(磁盘满/权限)是环境病,刷屏没意义;但一声不吭会把
      // 「重启还是丢」误诊成"这个功能没做" —— 沉默和死亡长得一样。
      if (!tailWarned) { tailWarned = true; console.warn('[console-tail] 尾巴文件写入失败:', err && err.message); }
    }
  }, 500);
  // 不拽着进程:定时器悬着时进程该退就退,最后半秒的尾巴让它去
  if (typeof tailTimer.unref === 'function') tailTimer.unref();
}

function pushRawLines(lines) {
  rawRing = [...rawRing, ...lines].slice(-RAW_RING_CAP);
  scheduleTailSave();
}

function rawTailLines() {
  return rawRing;
}

export { addConsoleEvent, latestConsoleEvents, pushRawLines, rawTailLines };
