// 工作流档:把控制台事件流折成「一步一行」的结构化流水。
//
// 需求原话:「结构化流水:工具名+参数一条、thinking 一条带时长、回复一条,等宽可折叠」。
//
// ★ 为什么要折:thinking 是 700ms 一批灌进来的(bridge/index.js:130 THINKING_FLUSH_MS),
//   一次思考在事件表里是十几条独立记录。原来的卡片流一条画一张卡 —— 屏幕上是一列
//   长得一模一样的碎卡,读不出「它想了一次、想了多久」。折成一行才是一步。
// ★ 时长是**量出来的**,不是估的:同一批 thinking 的第一条和最后一条 created_at 之差。
//   只有一条时不显示时长 —— 那种情况下差值恒等于 0,写「0s」是在报一个假数。
// ★ 老事件(8/11 之前)没有工具参数,那是因为参数功能那天才上线(c0b7f2d),不是坏了。
//   没有就不画,不拿工具名冒充参数。
import { esc, escAttr, formatTime } from './util.js';
import { state } from './state.js';

// 桥在开始生成时会先发一条占位 thinking,正文就是这七个字。它不是思考内容,
// 是「开始了」这个信号 —— 当思考正文渲染出来会让人以为模型在反复念这句话。
const GENERATING = '正在生成回复...';

// 相邻同类事件合成一行的最大间隔。跨过这个口子就是两次独立的动作,不该并成一条。
const MERGE_GAP_MS = 45000;

const KIND_LABEL = {
  received: '收到',
  reply: '回复',
  thinking: '思考',
  generating: '生成',
  tool: '工具',
  error: '错误',
  memory: '记忆',
  upload: '上传',
  command: '命令',
  quota: '额度',
  heartbeat: '心跳',
  system: '系统',
  settings: '设置',
  info: '信息',
  avatar: '头像',
};

function ms(a, b) {
  const t1 = Date.parse(a), t2 = Date.parse(b);
  return Number.isFinite(t1) && Number.isFinite(t2) ? t2 - t1 : NaN;
}

function fmtDur(msVal) {
  if (!Number.isFinite(msVal) || msVal < 1000) return '';
  const s = Math.round(msVal / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// 「→ Bash  npm test」拆回工具名和参数。桥写的就是这个形状(bridge/index.js:323),
// 拆不开就整条当名字,不猜。
function splitTool(body) {
  const m = String(body || '').match(/^→\s*(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return { name: String(body || '').trim(), arg: '' };
  return { name: m[1], arg: (m[2] || '').trim() };
}

function firstLine(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s;
}

// 事件流 → 行模型。纯函数,好验:给一串事件,应该出几行、每行什么标签,是可以断言的。
function buildFlowRows(events) {
  const rows = [];
  const list = Array.isArray(events) ? events : [];
  for (const ev of list) {
    if (!ev) continue;
    const body = String(ev.body || '');
    // 占位 thinking 单独归一类:它量的是「生成用了多久」,不是「思考了什么」。
    const kind = ev.kind === 'thinking' && body.trim() === GENERATING ? 'generating' : String(ev.kind || 'event');
    const prev = rows[rows.length - 1];
    const mergeable = kind === 'thinking' || kind === 'generating';
    if (
      prev && mergeable && prev.kind === kind
      && Math.abs(ms(prev.lastAt, ev.created_at)) < MERGE_GAP_MS
    ) {
      prev.count += 1;
      prev.lastAt = ev.created_at;
      if (kind === 'thinking') prev.body += body;
      continue;
    }
    rows.push({
      key: `f${ev.id}`,
      kind,
      title: String(ev.title || ''),
      body: kind === 'generating' ? '' : body,
      at: ev.created_at,
      lastAt: ev.created_at,
      count: 1,
    });
  }
  // 只有一条记录的步骤(桥每轮只发一条「正在生成回复」占位)自身跨不出时长,
  // 拿**到下一步的间隔**当它的耗时 —— 那正是「等这一步等了多久」。
  // ★ 封顶 10 分钟:下一步隔了两小时的,那段空白是「今晚没人说话」,不是它算了两小时。
  for (let i = 0; i < rows.length - 1; i += 1) {
    const gap = ms(rows[i].lastAt, rows[i + 1].at);
    if (Number.isFinite(gap) && gap > 0 && gap < 10 * 60 * 1000) rows[i].gapMs = gap;
  }
  return rows;
}

// 一行的三段:标签 / 主内容 / 右侧量出来的数。哪段没有就不占位。
function rowParts(row) {
  const label = KIND_LABEL[row.kind] || row.kind;
  // 多条批次:量它自己的头尾。单条:量到下一步的间隔(buildFlowRows 里算好的 gapMs)。
  const dur = row.count > 1 ? fmtDur(ms(row.at, row.lastAt)) : fmtDur(row.gapMs);
  if (row.kind === 'tool') {
    const { name, arg } = splitTool(row.body);
    return { label, name, text: arg, meta: '', body: arg ? '' : '' };
  }
  if (row.kind === 'thinking') {
    const n = row.body.replace(/\s/g, '').length;
    return { label, name: '', text: firstLine(row.body), meta: [dur, n ? `${n}字` : ''].filter(Boolean).join(' · ') };
  }
  if (row.kind === 'generating') {
    // 正文永远是那句占位,不重复画;这一行的信息量全在时长上。
    return { label, name: '', text: '等模型出话', meta: dur };
  }
  // 「收到」是一轮的开头 —— 只在这儿挂钟点,读的人有个时间锚,又不至于每行都缀一个表。
  if (row.kind === 'received') {
    return { label, name: '', text: firstLine(row.body) || row.title, meta: formatTime(row.at) };
  }
  return { label, name: '', text: firstLine(row.body) || row.title, meta: '' };
}

function renderFlowRow(row) {
  const p = rowParts(row);
  // 「长」的判据跟卡片流一致:一屏放不下才给展开键(超 120 字或有换行)。
  const full = row.kind === 'tool' ? splitTool(row.body).arg : row.body;
  const expandable = full.length > 120 || full.includes('\n');
  const open = !!(state.openEvents && state.openEvents[row.key]);
  const head = `<span class="fw-label">${esc(p.label)}</span>`
    + (p.name ? `<span class="fw-name">${esc(p.name)}</span>` : '')
    + `<span class="fw-text">${esc(p.text)}</span>`
    + (p.meta ? `<span class="fw-meta">${esc(p.meta)}</span>` : '');
  const line = expandable
    ? `<button class="fw-line" type="button" data-action="toggle-event" data-id="${escAttr(row.key)}" aria-expanded="${open}">
        <span class="fw-caret" aria-hidden="true">${open ? '▾' : '▸'}</span>${head}
      </button>`
    : `<div class="fw-line fw-flat"><span class="fw-caret" aria-hidden="true"></span>${head}</div>`;
  return `<article class="fw-row fw-k-${escAttr(row.kind)}${open ? ' open' : ''}" title="${escAttr(formatTime(row.at))}">
    ${line}
    ${open && expandable ? `<pre class="fw-body">${esc(full)}</pre>` : ''}
  </article>`;
}

function renderWorkflow() {
  const rows = buildFlowRows(state.events || []);
  if (!rows.length) return '<div class="empty">还没有控制台事件。</div>';
  return `<div class="fw-list" data-scroll-list data-scroll-scope="console">
    ${rows.map(renderFlowRow).join('')}
  </div>`;
}

export { renderWorkflow, buildFlowRows, splitTool, fmtDur };
