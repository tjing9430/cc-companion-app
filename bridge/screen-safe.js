// 送去屏幕之前的一道筛子。桥的 teeRaw 每一行都过这里。
//
// 8/14 她圈着终端问「这一坨到底是什么呀」——圈的是半截 base64 签名。
// 量了她那一轮真实落盘的 400 行:只有 64 行有内容,其余 336 行是 stream_event 的
// 逐字增量(174 条)和一堆生命周期事件,屏幕上一条都不显示(formatLine 判 null),
// 却把 400 行的环形缓冲吃掉三分之二 —— 她能往回翻的真实历史只剩三分之一。
//
// ★ stream_event 整类不上屏:桥自己**仍然**在 handleLine 里用它拼流式文本,
//   这里丢的只是「送去屏幕的那一份」,不影响回话。
// ★ 超长行**压小而不是切断**:切断会切出半个 JSON,前端 parse 不了只好原样吐 300 字乱码
//   ——她圈的就是这个。压的依据是「屏幕到底要看多少」:public/js/stream-format.js
//   里最宽的一处也只 clip 到 300 字符,所以任何字符串留 320 就够;数组只被用来数个数
//   (`${tools.length} tools`),超大的数组换成同长度的空元素,个数不变、字节掉两位数。
//   实测:一条 5628 字符的 system/init(tools 数组独占 3909)压到 300 以内,
//   屏幕上那行「会话开始 · 模型 · 目录 · 133 tools」一个字不差。
// ★ 单独成模块不是为了好看,是为了测试能 import 到**真正在跑的这份**:
//   bridge/index.js 末尾直接 listen,import 它就会起一个服务。

const SCREEN_SAFE_LEN = 1500;      // 之下的行不解析,直接放行(中位数 264,绝大多数走这条)
const SCREEN_MAX_STR = 320;        // 单个字符串字段的上限,比 formatLine 最宽的 clip(300) 略松
const SCREEN_MAX_ARR = 600;        // 数组序列化超过这个字节就只留「有多少个」
const SCREEN_HARD_CAP = 4000;      // 跟服务端 /api/console/stream 的内存上限对齐

function screenSafe(line) {
  const s = String(line == null ? '' : line);
  if (!s) return null;
  // stream_event 的 type 一定落在行首那个对象的头几个字段里,只扫前 120 字符
  if (/"type"\s*:\s*"stream_event"/.test(s.slice(0, 120))) return null;
  if (s.length <= SCREEN_SAFE_LEN) return s;
  let o;
  try { o = JSON.parse(s); } catch { return `${s.slice(0, SCREEN_HARD_CAP)}…[截断]`; }
  const compact = JSON.stringify(shrink(o));
  return compact.length > SCREEN_HARD_CAP ? `${compact.slice(0, SCREEN_HARD_CAP)}…[截断]` : compact;
}

function shrink(v) {
  if (typeof v === 'string') return v.length > SCREEN_MAX_STR ? `${v.slice(0, SCREEN_MAX_STR)}…` : v;
  if (Array.isArray(v)) {
    // ★ 折成「只剩长度」的判据是**元素是不是标量**,不是数组有多大。
    //   屏幕只对标量数组数个数(system/init 的 tools/skills/slash_commands:一堆名字,
    //   formatLine 只读 .length 拼「30 tools」);元素是对象的数组是内容本身
    //   (assistant 的 content:thinking / text / tool_use 三块逐块渲染),再大也得留着。
    //   第一版拿字节数当判据,把 content 折成 ["","",""] —— 消息正文整条消失,
    //   屏幕上只剩几行空白。回归测试抓的就是这一下。
    const mapped = v.map(shrink);
    const scalarOnly = mapped.every((x) => x === null || typeof x !== 'object');
    if (scalarOnly && JSON.stringify(mapped).length > SCREEN_MAX_ARR) return new Array(v.length).fill('');
    return mapped;
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = k === 'signature' ? '[sig]' : shrink(val);
    return out;
  }
  return v;
}

export { screenSafe, SCREEN_SAFE_LEN, SCREEN_MAX_STR, SCREEN_MAX_ARR, SCREEN_HARD_CAP };
