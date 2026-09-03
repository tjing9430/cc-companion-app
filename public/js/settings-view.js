// 设置页 + 额度面板的渲染。
// notifySupported/notifyEnabled 留在 app.js 壳里(它们碰浏览器通知权限,属于壳的职责),
// 这里当参数收 —— 渲染模块不直接问浏览器要状态。

import { esc, escAttr, formatDateTime } from './util.js';
import { state, protectedAssetUrl } from './state.js';

function renderSettings({ notifySupported, notifyEnabled }) {
  const s = state.settings;
  return `
    <form class="panel stack" data-settings-form="1">
      <h2>设置</h2>
      ${renderQuotaPanel()}
      <div class="settings-grid">
        ${field('userName', '你的名字', s.userName)}
        ${field('assistantName', 'AI 名字', s.assistantName)}
        ${field('user_signature', '你的签名', s.user_signature || '', '写一句自己的状态')}
        ${field('assistant_signature', 'AI 签名', s.assistant_signature || '', '写一句 TA 的状态')}
        ${field('groupName', '群聊名字', s.groupName)}
        ${field('agentMention', '群聊唤起词', s.agentMention)}
        <div class="form-row session-limit-row">
          <label for="session-max-tokens">Session 自动更换长度：<strong data-session-limit-value>${Number(s.session_max_tokens_k || 600)}K</strong></label>
          <input id="session-max-tokens" name="session_max_tokens_k" type="range" min="32" max="960" step="16" value="${Number(s.session_max_tokens_k || 600)}">
          <p class="form-hint">达到长度后不会打断回复；连续 5 分钟没有聊天且 agent 没有活动时，才生成交接并更换 session。</p>
        </div>
        <div class="form-row">
          <label>主题</label>
          <select name="theme">
            <option value="dark" ${s.theme === 'dark' ? 'selected' : ''}>暖深色</option>
            <option value="light" ${s.theme === 'light' ? 'selected' : ''}>奶油白</option>
            <option value="starry" ${s.theme === 'starry' ? 'selected' : ''}>星空</option>
            <option value="island" ${s.theme === 'island' ? 'selected' : ''}>浮岛</option>
          </select>
        </div>
        ${Object.prototype.hasOwnProperty.call(s, 'companion_since') ? `
        <div class="form-row">
          <label>陪伴起算日</label>
          <div class="since-row">
            <input name="companion_since" type="date" value="${escAttr(s.companion_since || '')}">
            <button type="button" class="since-pick" data-action="pick-since">替我挑一个</button>
          </div>
          <p class="form-hint">${s.companion_since
            ? `已经一起 ${daysSince(s.companion_since)} 天了`
            : '没设的话首屏就不显示这句;「替我挑一个」会拿最早那条消息当建议,你看过再存。'}</p>
        </div>` : ''}
        ${Object.prototype.hasOwnProperty.call(s, 'user_avatar') ? `
        <div class="form-row avatar-row">
          <label>头像</label>
          <div class="avatar-picks">
            ${[['user_avatar', s.userName, '/assets/stars/star-group.webp'],
               ['assistant_avatar', s.assistantName, '/assets/stars/star-private-core.webp']].map(([f, who, dflt]) => `
              <div class="avatar-pick">
                <button type="button" class="avatar-pick-btn" data-action="pick-avatar" data-field="${f}" title="点一下换图">
                  <img src="${escAttr(protectedAssetUrl(s[f] || dflt))}" alt="">
                </button>
                <span class="avatar-pick-who">${esc(who || '')}</span>
                ${s[f] ? `<button type="button" class="avatar-pick-clear" data-action="clear-avatar" data-field="${f}">默认</button>` : ''}
              </div>`).join('')}
          </div>
        </div>` : ''}
      </div>
      <label class="chip"><input name="autoReplyGroup" type="checkbox" ${s.autoReplyGroup ? 'checked' : ''}> 群聊里不提到唤起词也自动回复</label>
      <div class="setting-group">
        <div class="setting-group-head"><span class="setting-group-title">消息操作</span></div>
        <p class="setting-group-hint">控制气泡上出现哪些按钮</p>
        <label class="chip"><input name="featureCopyAll" type="checkbox" ${s.featureCopyAll !== false ? 'checked' : ''}> 顶栏「复制全部」</label>
        <label class="chip"><input name="featureRecall" type="checkbox" ${s.featureRecall !== false ? 'checked' : ''}> 消息「撤回」（只对自己发的）</label>
        <label class="chip"><input name="featureDelete" type="checkbox" ${s.featureDelete !== false ? 'checked' : ''}> 消息「删除」+ 顶栏「清空」</label>
      </div>
      <div class="setting-group">
        <div class="setting-group-head"><span class="setting-group-title">记忆</span></div>
        <p class="setting-group-hint">自动提炼 / 语义搜索需在 .env 配置模型</p>
        <label class="chip"><input name="featureAutoExtract" type="checkbox" ${s.featureAutoExtract !== false ? 'checked' : ''}> 自动从聊天提炼长期记忆</label>
        <label class="chip"><input name="featureSemanticSearch" type="checkbox" ${s.featureSemanticSearch !== false ? 'checked' : ''}> 记忆搜索用语义（配了 EMBEDDING_MODEL 才生效）</label>
      </div>
      <div class="setting-group">
        <div class="setting-group-head"><span class="setting-group-title">AI 接入</span><span class="setting-group-value">${esc(s.agent.model)}</span></div>
        <p class="setting-group-hint">${s.agent.configured ? '服务器已配置 OpenAI-compatible API。' : '当前使用内置演示回复。在 .env 里设置 OPENAI_API_KEY 后会接入真实模型。'}</p>
      </div>
      ${notifySupported() ? `<div class="setting-group">
        <div class="setting-group-head"><span class="setting-group-title">后台通知</span><span class="setting-group-value">${Notification.permission === 'denied' ? '被浏览器拒绝' : (notifyEnabled() ? '已开启' : '未开启')}</span></div>
        <p class="setting-group-hint">页面在后台时，AI 的新消息（包括它主动发来的）会弹系统通知。只对本设备生效。${Notification.permission === 'denied' ? '需要先在浏览器的网站设置里允许通知。' : ''}</p>
        ${Notification.permission === 'denied' ? '' : `<button class="ghost" type="button" data-action="toggle-notify">${notifyEnabled() ? '关闭通知' : '开启通知'}</button>`}
      </div>` : ''}
      <div class="composer-actions">
        <button class="primary" type="submit">保存设置</button>
        ${s.authEnabled ? '<button class="ghost" type="button" data-action="clear-token">重置口令</button>' : ''}
      </div>
    </form>`;
}

function renderQuotaPanel() {
  const q = state.quota || {};
  const data = q.data || null;
  const configured = data && data.configured !== false;
  const title = state.settings && state.settings.assistantName ? state.settings.assistantName : 'Context / Token';
  const note = quotaNote(data, q);
  const rows = quotaRows(data, q);
  return `
    <section class="quota-panel" aria-live="polite">
      <div class="quota-head">
        <div>
          <div class="quota-title">${esc(title)}</div>
          <div class="quota-note">${esc(note)}</div>
        </div>
        <button class="ghost quota-refresh" type="button" data-action="refresh-quota" ${q.loading || state.offline ? 'disabled' : ''}>刷新</button>
      </div>
      <div class="quota-box">
        ${rows.length ? rows.map(([label, value]) => `
          <div class="quota-row">
            <span>${esc(label)}</span>
            <strong>${esc(value)}</strong>
          </div>
        `).join('') : '<div class="quota-empty">暂无额度数据</div>'}
      </div>
      ${q.error ? `<div class="quota-error">${esc(q.error)}</div>` : ''}
    </section>`;
}

function quotaNote(data, q) {
  if (q.loading) return '正在查询额度和上下文。';
  if (q.error) return '查询失败，请检查额度 adapter。';
  if (!data) return '打开设置或点刷新后显示额度。';
  if (data.configured === false) return '未配置 QUOTA_ADAPTER_URL。';
  const subject = state.settings && state.settings.assistantName ? state.settings.assistantName : '当前 agent';
  const window = data.five_hour && (data.five_hour.resets_in || data.five_hour.resets_at) ? '5小时' : (data.window || '当前窗口');
  return `上下文长度来自${subject}；${window}显示额度剩余比例和距刷新还剩多久。`;
}

function quotaRows(data, q) {
  if (q.loading) return [['当前状态', '查询中']];
  if (!data) return [['当前状态', '未查询']];
  if (data.configured === false) return [['当前状态', '未配置']];
  const rows = [];
  const context = quotaContextValue(data);
  const tier = data.limit_tier || data.model || data.window || '';
  const fiveHour = quotaWindowValue(data.five_hour, data, q.fetched_at);
  const fiveHourReset = quotaResetValue(data.five_hour && data.five_hour.resets_at || data.resets_at);
  const weekly = quotaWindowValue(data.weekly, null, q.fetched_at);
  const weeklyReset = quotaResetValue(data.weekly && data.weekly.resets_at);
  if (context) rows.push(['上下文已用', context]);
  if (tier) rows.push(['当前限制层', tier]);
  if (fiveHour) rows.push(['5h 余量', fiveHour]);
  if (fiveHourReset) rows.push(['5h 刷新时间', fiveHourReset]);
  if (weekly) rows.push(['7天余量', weekly]);
  if (weeklyReset) rows.push(['7天刷新时间', weeklyReset]);
  if (!rows.length) {
    const fallback = quotaWindowValue(null, data, q.fetched_at);
    if (fallback) rows.push(['当前状态', fallback]);
  }
  if (q.fetched_at) rows.push(['最后查询', formatDateTime(q.fetched_at)]);
  return rows;
}

function quotaContextValue(data) {
  const context = data && data.context || {};
  const used = context.used ?? (data && data.used);
  const limit = context.limit ?? (data && data.limit);
  const percent = context.percent != null ? context.percent : percentValue(used, limit);
  if (used != null && limit != null && percent != null) return `${formatQuotaNumber(used)} / ${formatQuotaNumber(limit)} (${formatPercent(percent)})`;
  if (used != null && limit != null) return `${formatQuotaNumber(used)} / ${formatQuotaNumber(limit)}`;
  if (percent != null) return formatPercent(percent);
  return '';
}

function quotaWindowValue(section, fallback, fetchedAt) {
  const source = section || {};
  const remaining = source.remaining ?? (fallback && fallback.remaining) ?? (fallback && fallback.raw && fallback.raw.remaining_percent);
  const percent = source.percent ?? (typeof remaining === 'number' ? remaining : null);
  const resetsAt = source.resets_at || (fallback && fallback.resets_at);
  const resets = quotaRemainingTime(resetsAt, fetchedAt) || source.resets_in || '';
  const main = remaining != null && typeof remaining !== 'number' ? String(remaining) : (percent != null ? formatPercent(percent) : '');
  if (main && resets) return `${main} / ${resets}`;
  if (main) return main;
  if (fallback && fallback.used != null && fallback.limit != null) return `${formatQuotaNumber(fallback.used)} / ${formatQuotaNumber(fallback.limit)}`;
  return '';
}

function percentValue(used, limit) {
  const a = Number(used);
  const b = Number(limit);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return (a / b) * 100;
}

function formatPercent(value) {
  if (typeof value === 'string') return value.includes('%') ? value : `${value}%`;
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value || '');
  const percent = n <= 1 ? n * 100 : n;
  return `${percent.toFixed(1)}%`;
}

function formatQuotaNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value || '');
  if (Math.abs(n) >= 1000) {
    const unit = n / 1000;
    return `${Number.isInteger(unit) ? unit.toFixed(0) : unit.toFixed(1)}k`;
  }
  return String(n);
}

function formatQuotaReset(value) {
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) return formatDateTime(value);
  return String(value || '');
}

function quotaResetValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function quotaRemainingTime(resetsAt, fetchedAt) {
  if (!resetsAt || !fetchedAt) return '';
  const reset = new Date(resetsAt);
  const fetched = new Date(fetchedAt);
  if (Number.isNaN(reset.getTime()) || Number.isNaN(fetched.getTime())) return '';
  const minutes = Math.max(0, Math.round((reset.getTime() - fetched.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
}

// 「已经一起 N 天」。★ 用**日期**算不用毫秒差:跨时区/夏令时的时候,
// 毫秒差除以 86400000 会在半夜前后抖出 ±1 天。取两个 UTC 零点再相减就稳。
function daysSince(iso) {
  const start = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(start)) return 0;
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.max(0, Math.round((today - start) / 86400000)) + 1;   // 当天算第 1 天
}

function field(name, label, value, placeholder = '') {
  return `<div class="form-row"><label>${esc(label)}</label><input name="${escAttr(name)}" value="${escAttr(value)}"${placeholder ? ` placeholder="${escAttr(placeholder)}"` : ''}></div>`;
}

function agentProviderLabel() {
  if (!state.settings || !state.settings.agent) return 'AI 伴侣';
  return state.settings.agent.configured ? '已接入模型' : '演示代理';
}

// ★ quotaWindowValue / quotaResetValue 也导出:控制台「终端」档那条状态行要同一套口径。
//   自己在那边再写一遍格式化,两处迟早会对不上 —— 到时候同一份额度在两页显示成两个数,
//   而两边都"没报错"。**同一个数只许有一个算法。**
export { renderSettings, renderQuotaPanel, agentProviderLabel, quotaWindowValue, quotaResetValue };
