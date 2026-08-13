// 控制台页的渲染。只依赖 util 的转义/时间格式化和 state —— 是耦合最浅的一个域,
// 所以拿它当视图层拆分的第一刀。
// 事件路由(submitConsoleCommand 等)按约定留在 app.js 那个壳里:换皮只动渲染,壳不动。

import { esc, escAttr, formatTime } from './util.js';
import { state, CONSOLE_COMMANDS, ICONS } from './state.js';
import { quotaWindowValue, quotaResetValue } from './settings-view.js';
import { formatLines, fmtCost, hhmm } from './stream-format.js';

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
  //   等于告诉用户"你正在用 claude-fable-5",而那是假的。**撒谎比不显示更糟。**
  //   所以空值时插一条「跟随默认」当选中态,如实说"我们没指定"。
  const sel = (name, cur, opts, label) => {
    if (!opts || !opts.length) return '';
    const has = String(cur || '') !== '';
    // 没显式指定模型时,如果桥报了「实际在跑的那个」,就照实说是它 ——
    // 「跟随默认」是不撒谎,写出真名才是说真话。两者都不许摆一个没人设过的名字。
    const eff = name === 'model' && !has ? String(b.effective_model || '') : '';
    const items = (has ? '' : `<option value="" selected>${eff ? `${esc(eff)}（当前生效）` : '跟随默认'}</option>`)
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
  const raw = state.rawTail || [];
  // 格式化档:一行 stream-json → 一行 CLI 长相,噪音行(thinking_tokens)直接不出现,
  // 所以行数会比原始少 —— 少掉的不是"丢了",是本来就不该占屏。
  // 原始档一个字不动地照抄:格式化解错的时候,只有它能自证。
  const tail = state.rawFmt
    ? formatLines(raw).map((r) => `<div class="tl tl-f tl-f-${esc(r.cls)}"><span class="tl-m">${esc(r.mark)}</span><span class="tl-b">${esc(r.text)}</span></div>`).join('')
    : raw.map((l) => `<div class="tl tl-raw">${esc(l)}</div>`).join('');
  const fmtBtn = `<button type="button" class="term-fmt" data-action="raw-fmt" title="${escAttr(state.rawFmt ? '切到一个字都没动过的原始 JSON' : '切回 CLI 长相')}">${state.rawFmt ? '看原始' : '看格式化'}</button>`;
  // ★ 这一段(含切档钮)原来挂在 `tail ?` 底下 —— 有实时输出才出现。
  //   而原始流只活在内存里、刷新即空,所以**刷完页面这个功能等于不存在**:
  //   反馈原话「我没有看到啊 / 刷新了好几次都没有看到」。
  //   哑掉和没做长得一模一样,这条今晚是第二次咬人了。
  //   ⇒ 头和钮常驻;没数据时说清楚它在等什么,而不是整段消失。
  const liveEmpty = '<div class="empty term-live-empty">还没有实时输出 —— 发一条消息，或在上面敲条命令，它就从这儿往下滚。</div>';
  // ★ 滚动 scope 不能和工作流档共用 "console":共用时,在卡片流里翻到哪儿,
  //   切进终端就落在哪儿 —— 掉在一堆历史中间,实时输出要自己往下扒。
  //   反馈原话「点击终端之后能不能直接就是终端的东西」。
  //   终端的正确落点是**底部**(实时流 + 状态行),历史是往上翻才出现的 scrollback。
  return `
    <div class="term-view" data-scroll-list data-scroll-scope="console-term">
      <div class="term-note">运行事件流（不是原始 stdout）</div>
      ${hist || '<div class="empty">还没有事件。</div>'}
      <div class="term-note term-note-live">↓ 实时原始输出（只在内存里，刷新即空）${fmtBtn}</div>
      ${tail || liveEmpty}
    </div>
    ${renderTermStatus()}`;
}

// 终端底下那条状态行 —— 对着别人家 CLI 的状态栏做的。
//
// ★★ 只显示**真取得到**的东西。摆一个永远写着 "$0.00" 的位子,比空着更糟:
//    它看起来像在工作。
//    ——原来这儿写着「花费报不出来,那就不摆这一栏」。**那句是错的,已删。**
//    错在只问了桥的状态接口,没去看原始流:`result` 行自带 `total_cost_usd`,
//    `rate_limit_event` 行自带 `resetsAt` 和用量百分比。两个数一直在流里躺着,
//    是我没去接。留着这段是给下一个人看的:「取不到」要写清楚是**哪条路取不到**。
// ★ 每一段都自己判断有没有数据,没有就整段不渲染。
//   不是渲染成 "—" —— 破折号会让人以为"现在是零",而真相是"我们不知道"。
function renderTermStatus() {
  const b = state.bridge || {};
  const seg = [];

  // 模型:桥没被显式指定时用它报的「实际在跑的那个」,两个都没有就不显示
  const model = b.model || b.effective_model || '';
  if (model) seg.push(['模型', model]);

  // 上下文:上一轮送进去的 prompt / 窗口。窗口没声明就**不换算百分比** ——
  // 按 200k 估出来的百分比看着像真的,其实是我们猜的。面板那儿标了「~」,
  // 状态行一行字放不下这个注脚,那就干脆只显示绝对值。
  const prompt = Number(b.usage && b.usage.last_turn_prompt) || 0;
  const win = Number(b.context_window) || 0;
  const kk = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  if (prompt) {
    seg.push(['上下文', win ? `${kk(prompt)}/${kk(win)} ${Math.round((prompt / win) * 100)}%` : kk(prompt)]);
  }

  const turns = Number(b.usage && b.usage.turns) || 0;
  if (turns) seg.push(['轮次', String(turns)]);

  // 额度:和设置页共用同一套格式化函数(见 settings-view 的导出注释)
  const q = state.quota || {};
  const d = q.data;
  if (d && d.configured !== false) {
    const five = quotaWindowValue(d.five_hour, d, q.fetched_at);
    if (five) seg.push(['5h', five]);
    const reset = quotaResetValue((d.five_hour && d.five_hour.resets_at) || d.resets_at);
    if (reset) seg.push(['刷新', reset]);
  }

  // 从原始流里顺来的两段。★ 标「上轮」不标「花费」:这是最后一条 result 行自报的数,
  //   我没验过它是本轮还是全会话累计 —— 标成含义确定的那个说法,别让人拿它当账单。
  const m = state.streamMeta || {};
  const cost = fmtCost(m.cost_usd);
  if (cost) seg.push(['上轮', cost]);
  if (m.resets_at) {
    const pct = Number.isFinite(m.utilization) ? `${Math.round(m.utilization * 100)}% · ` : '';
    seg.push(['额度重置', `${pct}${hhmm(m.resets_at)}`]);
  }

  if (!seg.length) return '';
  return `<div class="term-status" role="status">${seg
    .map(([k, v]) => `<span class="ts-seg"><i>${esc(k)}</i>${esc(String(v))}</span>`)
    .join('')}</div>`;
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

export { renderConsole, renderConsoleEvent, renderDialPanel, renderTerminal, renderTermStatus };
