// stream-json → CLI 长相的一行。
//
// 输入是桥 teeRaw 原样送出来的**一行原始 stdout**（`claude --output-format stream-json --verbose`）。
// 输出是 0 或 1 条 {mark, text, cls}：
//   返回 null = 这行不该出现在屏幕上（噪音），不是"格式化失败"。
//
// ★ 为什么必须能返回 null：实测 16 行样本里 8 行是 `system/thinking_tokens`
//   （每次 +1 token 报一次），一行信息量为零。原样滚出去，一半屏幕在刷废话。
// ★ 为什么不 throw：这条通道是 fail-open 的日志链（见 bridge/index.js:174）。
//   任何一行解不开，就退回"原样显示这一行"，绝不让格式化把内容吃掉。

const TOOL_ARG = {
  Bash: (i) => i.command,
  Read: (i) => short(i.file_path),
  Edit: (i) => short(i.file_path),
  Write: (i) => short(i.file_path),
  NotebookEdit: (i) => short(i.notebook_path),
  Glob: (i) => i.pattern,
  Grep: (i) => i.pattern,
  WebFetch: (i) => i.url,
  WebSearch: (i) => i.query,
  Task: (i) => i.description,
  Skill: (i) => i.skill,
};

function short(p) {
  const s = String(p || '');
  const parts = s.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : s;
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// 工具的主参数：CLI 上 `Bash(npm test)` 括号里那一坨。
// 没登记的工具不猜字段名 —— 猜错了显示的是另一个参数，比不显示更误导。
function toolArg(name, input) {
  const i = input || {};
  const f = TOOL_ARG[name];
  if (f) return clip(f(i), 60);
  const keys = Object.keys(i);
  return keys.length === 1 ? clip(i[keys[0]], 60) : '';
}

function fmtDur(ms) {
  const s = Number(ms || 0) / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`;
}

function fmtCost(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n)) return '';
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function hhmm(epochSec) {
  const n = Number(epochSec);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  // ★ 取的是**看的人**那台机器的本地时区 —— 这个模块跑在浏览器里，所以是她手机的 +0800。
  //   别搬到服务端调用：VPS 是 UTC，同一行会显示成早八小时（我自测时就撞了这一下，
  //   node 里打出 17:00，浏览器里才是 01:00）。
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatLine(raw) {
  const line = String(raw == null ? '' : raw).trim();
  if (!line) return null;

  let o;
  try {
    o = JSON.parse(line);
  } catch {
    // ★ 分两种情况,别混成一种。
    //   ① 以 `{` 开头却解不开 = 一条**被截断的 JSON**(上游 4000 字硬切)。
    //      原样吐出去就是她 8/14 圈的那坨半截 base64 —— 300 个字符的乱码,
    //      对读的人是负价值:占屏幕、看不懂、还盖住上下文。给一行短的告诉她这儿断了。
    //   ② 不以 `{` 开头 = CLI 往 stdout 写的警告/提示行,是**真内容**,照旧原样给。
    //      fail-open 保的是这一类(见文件头),不是保坏掉的 JSON。
    if (line.startsWith('{')) {
      return { mark: '…', cls: 'plain', text: `[这行太长被截断了，看不出内容 · ${line.length} 字符]` };
    }
    return { mark: ' ', cls: 'plain', text: clip(line, 300) };
  }
  if (!o || typeof o !== 'object') return { mark: ' ', cls: 'plain', text: clip(line, 300) };

  // 桥补的输入侧回显(她/触发方的原话)。CLI 的 stream-json 不回显 prompt,
  // 这行是 bridge 在轮子起跑前写进流的,bridge_ 前缀自报家门(见 bridge/index.js)。
  if (o.type === 'bridge_user_input') {
    const t = clip(o.text, 300);
    return t ? { mark: '>', cls: 'user', text: t } : null;
  }

  if (o.type === 'system') {
    if (o.subtype === 'thinking_tokens') return null;           // 纯噪音，见文件头
    // 一轮里 15 条,内容只有 status:"requesting" —— 屏幕上落成孤零零一个词「status」,
    // 既不说明发生了什么也不能点。CLI 自己也不显示它。(真样本:她 8/14 那轮的落盘尾巴)
    if (o.subtype === 'status') return null;
    if (o.subtype === 'init') {
      const n = Array.isArray(o.tools) ? o.tools.length : 0;
      return { mark: '●', cls: 'sys', text: `会话开始 · ${o.model || '?'} · ${short(o.cwd)}${n ? ` · ${n} tools` : ''}` };
    }
    return { mark: '●', cls: 'sys', text: clip(o.subtype || 'system', 120) };
  }

  if (o.type === 'rate_limit_event') {
    const r = o.rate_limit_info || {};
    // ★ 真样本(8/13 实测):allowed 状态的事件只有 status/resetsAt/rateLimitType/overage*,
    //   **没有 utilization** —— 8/12 见过 94% 是接近上限才带的(0~1 刻度)。
    //   所以百分比只在字段真在时显示;平时的五小时用量由状态行从 /api/quota 拿,
    //   这一行不揣着一个空数写「用量」骗人。routine 事件也不配 ⚠ —— 橙色留给真警告。
    const WIN = { five_hour: '五小时窗', seven_day: '七天窗' };
    const win = WIN[r.rateLimitType] || (r.rateLimitType ? String(r.rateLimitType) : '额度');
    const pct = Number.isFinite(Number(r.utilization)) ? `${Math.round(Number(r.utilization) * 100)}%` : '';
    const at = hhmm(r.resetsAt);
    const bad = !!(r.status && r.status !== 'allowed');
    const warn = bad || !!pct;
    return { mark: warn ? '⚠' : '●', cls: warn ? 'warn' : 'sys',
      text: `${win}${pct ? ` · 用量 ${pct}` : ''}${bad ? ` · ${r.status}` : ''}${at ? ` · 重置 ${at}` : ''}` };
  }

  if (o.type === 'result') {
    const bits = [fmtDur(o.duration_ms)];
    const out = o.usage && o.usage.output_tokens;
    if (out) bits.push(`${out} tok`);
    const c = fmtCost(o.total_cost_usd);
    if (c) bits.push(c);
    const bad = o.is_error || o.subtype !== 'success';
    return { mark: bad ? '✗' : '●', cls: bad ? 'err' : 'done', text: `${bad ? (o.subtype || 'error') : '完成'} ${bits.join(' · ')}` };
  }

  const content = o.message && Array.isArray(o.message.content) ? o.message.content : null;
  if (!content) return null;

  // 一条 assistant 消息可能同时带 thinking + text + 多个 tool_use。
  // 屏幕是一行一条，所以这里返回数组，由 formatLines 摊平。
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'thinking') {
      const first = String(b.thinking || '').split('\n').find((x) => x.trim());
      out.push({ mark: '✻', cls: 'think', text: `Thinking… ${clip(first, 100)}` });
    } else if (b.type === 'text') {
      const t = clip(b.text, 300);
      if (t) out.push({ mark: '●', cls: 'text', text: t });
    } else if (b.type === 'tool_use') {
      const a = toolArg(b.name, b.input);
      out.push({ mark: '●', cls: 'tool', text: `${b.name}(${a})` });
    } else if (b.type === 'tool_result') {
      const c = b.content;
      const s = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map((x) => (x && x.type === 'text' ? x.text : `[${x && x.type}]`)).join('\n')
        : '';
      const lines = s ? s.split('\n').length : 0;
      const head = clip(s.split('\n')[0], 80);
      const more = lines > 1 ? ` (+${lines - 1} 行)` : '';
      out.push({ mark: '⎿', cls: b.is_error ? 'err' : 'res', text: `${head || (b.is_error ? '出错' : '空')}${more}` });
    }
  }
  return out.length === 1 ? out[0] : out.length ? out : null;
}

// ★ 缓存不是优化,是**功能能不能上线的前提**。
//   渲染是纯函数(state → HTML),所以每次重绘都会把整个 400 行环形缓冲重新格式化一遍;
//   而一轮进行中每 120ms 就重绘一次。实测 400 行裸跑 18.6ms(VPS),
//   手机按慢 8 倍算 ~150ms > 120ms 的重绘间隔 —— 光格式化就吃光帧预算,还没算 DOM。
//   行内容本身不可变,格式化又是纯函数,所以按原文串缓存,重绘时命中率接近 100%。
//   加缓存后:全命中重绘 0.51ms,真实一拍(360 命中 + 40 条新行)3.5ms。
//   ⚠️ 量的时候踩过一次:构造"各不相同的行"时在行尾拼了 " #i",把 JSON 拼坏了,
//      量到的其实是 400 次抛异常的兜底路径。造压测样本也得是**合法**样本。
const CACHE = new Map();
const CACHE_MAX = 800;   // 环形缓冲 400 行,留一倍余量;超了整清,摊销到每行几乎为零

// 一批行 → 一批屏幕行（丢掉 null，摊平数组）
function formatLines(rawLines) {
  const out = [];
  for (const l of rawLines || []) {
    let r;
    if (CACHE.has(l)) {
      r = CACHE.get(l);
    } else {
      r = formatLine(l);
      if (CACHE.size >= CACHE_MAX) CACHE.clear();
      CACHE.set(l, r);
    }
    if (!r) continue;
    if (Array.isArray(r)) out.push(...r);
    else out.push(r);
  }
  return out;
}

// 从同一批原始行里顺出状态行要的两个数。
//
// ★ 为什么单独一趟而不是在 formatLine 里捎带:格式化只在**开着终端档**时跑,
//   而这两个数不管你开没开都该是最新的。所以扫描挂在收流那一侧,和渲染解耦。
// ★ 只认最后一次出现的值,不做累加 —— `total_cost_usd` 是 CLI 在那条 result 行上
//   自己报的数,我没验过它是"本轮"还是"整个会话累计"。**不确定就别加**:
//   把两个含义不明的数相加,得到的是一个一定错的数。界面上如实标成「上轮」。
function scanMeta(rawLines, prev) {
  const meta = { ...(prev || {}) };
  for (const l of rawLines || []) {
    let o;
    try { o = JSON.parse(String(l)); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.type === 'result' && Number.isFinite(Number(o.total_cost_usd))) {
      meta.cost_usd = Number(o.total_cost_usd);
      if (o.usage && Number(o.usage.output_tokens)) meta.out_tokens = Number(o.usage.output_tokens);
    } else if (o.type === 'rate_limit_event' && o.rate_limit_info) {
      const r = o.rate_limit_info;
      if (Number.isFinite(Number(r.resetsAt))) meta.resets_at = Number(r.resetsAt);
      if (Number.isFinite(Number(r.utilization))) meta.utilization = Number(r.utilization);
      if (r.rateLimitType) meta.limit_type = String(r.rateLimitType);
    }
  }
  return meta;
}

export { formatLine, formatLines, scanMeta, fmtCost, hhmm };
