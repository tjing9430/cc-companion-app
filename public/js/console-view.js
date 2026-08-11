// 控制台页的渲染。只依赖 util 的转义/时间格式化和 state —— 是耦合最浅的一个域,
// 所以拿它当视图层拆分的第一刀。
// 事件路由(submitConsoleCommand 等)按约定留在 app.js 那个壳里:换皮只动渲染,壳不动。

import { esc, escAttr, formatTime } from './util.js';
import { state, CONSOLE_COMMANDS, ICONS } from './state.js';

function renderConsole() {
  return `
    <div class="console-view">
      <form class="console-command" data-console-command="1">
        ${renderViewToggle()}
        ${renderDialPanel()}
        <div class="console-shortcuts">
          ${CONSOLE_COMMANDS.map(([cmd, label]) => `<button type="button" data-action="console-shortcut" data-cmd="${escAttr(cmd)}">${esc(label)}</button>`).join('')}
        </div>
        <div class="composer-bar">
          <div class="composer-field">
            <textarea name="command" rows="1" placeholder="输入控制台命令" ${state.offline ? 'disabled' : ''}></textarea>
          </div>
          <button class="composer-btn composer-send" type="submit" aria-label="发送命令" title="发送命令" ${state.offline ? 'disabled' : ''}>${ICONS.send}</button>
        </div>
      </form>
      ${state.consoleView === 'term' ? renderTerminal() : `
      <div class="event-list" data-scroll-list data-scroll-scope="console">
        ${state.events.length ? state.events.map((event) => renderConsoleEvent(event)).join('') : '<div class="empty">还没有控制台事件。</div>'}
      </div>`}
    </div>`;
}

// 「额度仪表盘」:模型定单价、effort 定用量,两个钮相邻摆;下面一条本会话用量。
// ★ 桥给不出这些能力时(没配桥 / 桥没起 / 不是我们这个桥),整块不渲染 ——
//   和头像那道门同一个判据:后端给不出的能力,前端不给入口。
function renderDialPanel() {
  const b = state.bridge;
  if (!b || !b.available) return '';
  const u = b.usage || {};
  const prompt = Number(u.last_turn_prompt) || 0;
  const win = Number(b.context_window) || 200000;   // 没报窗口就按 200k 画,并在文案里说明是估的
  const pct = win > 0 ? Math.min(100, Math.round((prompt / win) * 100)) : 0;
  const kk = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  const sel = (name, cur, opts, label) => (opts && opts.length ? `
    <label class="dial">
      <span class="dial-label">${esc(label)}</span>
      <select data-action="bridge-dial" data-field="${name}" ${state.offline ? 'disabled' : ''}>
        ${opts.map((o) => `<option value="${escAttr(o)}" ${String(cur) === String(o) ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
    </label>` : '');
  return `
    <div class="dial-panel">
      <div class="dial-row">
        ${sel('model', b.model, b.models, '模型')}
        ${sel('effort', b.effort, b.efforts, '思考档')}
      </div>
      <div class="usage-bar" title="上一轮送进模型的 token / 上下文窗口">
        <div class="usage-fill" style="width:${pct}%"></div>
        <span class="usage-text">${kk(prompt)} / ${kk(win)}${b.context_window ? '' : '(估)'} · 本会话 ${u.turns || 0} 轮 · 出 ${kk(Number(u.output_tokens) || 0)}</span>
      </div>
    </div>`;
}

// 两档:工作流(卡片)/ 终端(等宽一行一条)
function renderViewToggle() {
  const tab = (v, label) => `<button type="button" class="cv-tab${state.consoleView === v ? ' on' : ''}" data-action="console-view" data-view="${v}">${esc(label)}</button>`;
  return `<div class="cv-toggle">${tab('flow', '工作流')}${tab('term', '终端')}</div>`;
}

// 终端档 = 两层。
// ★ 为什么不是纯 live tail:原始流只在一轮进行时存在,不聊天的时候它是个空黑框。
//   所以下半屏是**历史**(已有的运行事件,换成终端长相),上面接**实时原始流**。
//   两层的来源不同,界面上如实标出来,不把历史冒充成原始输出。
function renderTerminal() {
  const hist = (state.events || []).slice(-120).map((e) => {
    const t = String(e.created_at || '').slice(11, 19);
    return `<div class="tl tl-${esc(e.kind || 'event')}"><span class="tl-t">${esc(t)}</span><span class="tl-k">${esc((e.kind || '').padEnd(8))}</span><span class="tl-b">${esc(e.title || '')}${e.body ? ' — ' + esc(String(e.body).slice(0, 300)) : ''}</span></div>`;
  }).join('');
  const tail = (state.rawTail || []).map((l) => `<div class="tl tl-raw">${esc(l)}</div>`).join('');
  return `
    <div class="term-view" data-scroll-list data-scroll-scope="console">
      <div class="term-note">运行事件流（不是原始 stdout）</div>
      ${hist || '<div class="empty">还没有事件。</div>'}
      ${tail ? `<div class="term-note term-note-live">↓ 实时原始输出（只在内存里，刷新即空）</div>${tail}` : ''}
    </div>`;
}

function renderConsoleEvent(event) {
  const body = String(event.body || '');
  // 「长」= 一屏放不下:超过 120 字或含换行。短条目(比如 tool 的「→ Bash」)不给展开键,
  // 免得满屏都是点不出东西的箭头。
  const expandable = body.length > 120 || body.includes('\n');
  const open = !!(state.openEvents && state.openEvents[event.id]);
  const idAttr = escAttr(String(event.id));
  return `
    <article class="event k-${escAttr(event.kind)}${open ? ' open' : ''}">
      <div class="event-title">
        <span><span class="event-kind">${esc(event.kind)}</span>${esc(event.title)}</span>
        <time>${formatTime(event.created_at)}</time>
      </div>
      ${body ? `<div class="event-body">${esc(body)}</div>` : ''}
      ${expandable ? `<button class="event-more" type="button" data-action="toggle-event" data-id="${idAttr}" aria-expanded="${open}">${open ? '收起' : `展开全文 · ${body.length} 字`}</button>` : ''}
    </article>`;
}

export { renderConsole, renderConsoleEvent, renderDialPanel, renderTerminal };
