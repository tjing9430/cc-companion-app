// 控制台页的渲染。只依赖 util 的转义/时间格式化和 state —— 是耦合最浅的一个域,
// 所以拿它当视图层拆分的第一刀。
// 事件路由(submitConsoleCommand 等)按约定留在 app.js 那个壳里:换皮只动渲染,壳不动。

import { esc, escAttr, formatTime } from './util.js';
import { state, CONSOLE_COMMANDS, ICONS } from './state.js';

function renderConsole() {
  return `
    <div class="console-view">
      <form class="console-command" data-console-command="1">
        <div class="cv-strip" role="toolbar" aria-label="控制台工具条">
          ${renderViewToggle()}
          ${renderDialPanel()}
          <span class="cv-sep" aria-hidden="true"></span>
          ${CONSOLE_COMMANDS.map(([cmd, label]) => `<button type="button" class="cv-cmd" data-action="console-shortcut" data-cmd="${escAttr(cmd)}">${esc(label)}</button>`).join('')}
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

// 「额度仪表盘」压成三枚胶囊:模型定单价、effort 定用量、用量条给反馈。
// ★ 原来是一块竖着的大面板 —— 反馈原话「这一坨东西太大了」。控制台的主角是事件流,
//   档位和命令是**手边的工具**不是仪表盘,所以压成一条、溢出就横滑,纵向还给内容。
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
  // ★ 当前值为空时(部署方没设 CLAUDE_MODEL,桥吃 CLI 默认),不能让浏览器
  //   自己选中第一个 option —— 那会在界面上显示一个**没人设过的模型名**,
  //   等于告诉她"你正在用 claude-fable-5",而那是假的。**撒谎比不显示更糟。**
  //   所以空值时插一条「跟随默认」当选中态,如实说"我们没指定"。
  const sel = (name, cur, opts, label) => {
    if (!opts || !opts.length) return '';
    const has = String(cur || '') !== '';
    const items = (has ? '' : '<option value="" selected>跟随默认</option>')
      + opts.map((o) => `<option value="${escAttr(o)}"${has && String(cur) === String(o) ? ' selected' : ''}>${esc(o)}</option>`).join('');
    // 压成一枚胶囊:下拉自己就是胶囊,不再另起一行标签
    return `<label class="cv-pill cv-dial" title="${escAttr(label)}">
      <select data-action="bridge-dial" data-field="${name}" ${state.offline ? 'disabled' : ''}>${items}</select>
    </label>`;
  };
  // 三枚胶囊平铺进外面那条横滚带,不再自己占一整块
  return `${sel('model', b.model, b.models, '模型')}${sel('effort', b.effort, b.efforts, '思考档')}
    <span class="cv-pill cv-usage" style="--pct:${pct}%"
          title="上一轮送进模型的 token / 上下文窗口${b.context_window ? '' : '(窗口未声明,按 200k 估)'}">
      <i class="cv-usage-fill" aria-hidden="true"></i>
      <span class="cv-usage-text">${kk(prompt)}/${kk(win)}${b.context_window ? '' : '~'} · ${u.turns || 0}轮</span>
    </span>`;
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
