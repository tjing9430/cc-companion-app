// 桥送去屏幕之前的筛子 + 前端对坏行的兜底。
//
// 起因是 8/14 她圈着终端截图问「这一坨到底是什么呀」——屏幕上两大坨半截 base64。
// 追下去是一条链:CLI 吐的行带一长串 thinking 签名 → 超 4000 字符 → 服务端硬切 →
// 半个 JSON → 前端 parse 不了 → 走「原样显示」的 fail-open 兜底 → 300 字乱码上屏。
// 每一环单独看都讲得通,合起来就是她那一屏。所以这份测试**按链路的每一环钉**,
// 而不是只钉最终效果。
//
// ★ 样本用真的:test/fixtures/real-stream.jsonl 是真跑一次 `claude -p --output-format
//   stream-json --include-partial-messages --verbose` 抓下来的完整原始流。
//   手搓的样本在这个 bug 上会两边都通过 —— 因为手搓的时候不会想到 tools 数组有 3909 字符。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenSafe, SCREEN_HARD_CAP } from '../bridge/screen-safe.js';
import { formatLine, formatLines } from '../public/js/stream-format.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = fs.readFileSync(path.join(HERE, 'fixtures', 'real-stream.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim());

// 上游那一刀:服务端 /api/console/stream 对每行的内存上限。桥送出去的行必须扛得住它。
const wire = (l) => (l.length > SCREEN_HARD_CAP ? `${l.slice(0, SCREEN_HARD_CAP)}…[截断]` : l);

test('真样本:过完筛子没有一行会被上游切坏', () => {
  const kept = REAL.map(screenSafe).filter((l) => l !== null);
  assert.ok(kept.length > 0, '真样本一行都没剩,fixture 或过滤写坏了');
  for (const l of kept) {
    assert.ok(l.length <= SCREEN_HARD_CAP, `还有 ${l.length} 字符的行会被切`);
    if (l.startsWith('{')) JSON.parse(l);   // 解不开就抛,这正是要钉住的
  }
});

test('真样本:补丁前这条链确实会吐乱码(不复现就等于没验)', () => {
  // 不过筛子、只挨上游那一刀 —— 就是她 8/14 看到的那条链
  const rows = formatLines(REAL.map(wire));
  const junk = rows.filter((r) => /[A-Za-z0-9+/]{60,}/.test(r.text));
  assert.ok(junk.length === 0 || junk.every((r) => r.mark === '…'),
    '补丁前的坏行现在应该被前端认出来,而不是原样吐 base64');
  // 过了筛子之后,连"被认出来的坏行"都不该有
  const after = formatLines(REAL.map(screenSafe).filter(Boolean).map(wire));
  assert.equal(after.filter((r) => r.mark === '…').length, 0, '过完筛子不该再有截断行');
});

test('system/init 压完还能数出 tools 个数 —— 屏幕上那行不能变', () => {
  const raw = REAL.find((l) => l.includes('"subtype":"init"'));
  assert.ok(raw, 'fixture 里没有 init 行');
  assert.ok(raw.length > SCREEN_HARD_CAP, `这条 init 只有 ${raw.length} 字符,钉不住"超长"这件事`);
  const n = JSON.parse(raw).tools.length;
  const row = formatLine(wire(screenSafe(raw)));
  assert.match(row.text, /^会话开始 · /);
  assert.match(row.text, new RegExp(`· ${n} tools$`), `tools 个数应为 ${n}:${row.text}`);
});

test('thinking 的签名剥成 [sig],别的字段原样留着', () => {
  const raw = REAL.find((l) => l.includes('"signature"') && l.includes('"type":"assistant"'));
  assert.ok(raw, 'fixture 里没有带签名的 assistant 行');
  const padded = JSON.stringify(JSON.parse(raw), (k, v) =>
    (k === 'signature' ? v + 'A'.repeat(5000) : v));   // 把签名撑到必然超限
  const out = screenSafe(padded);
  const o = JSON.parse(out);
  assert.equal(o.type, 'assistant');
  assert.equal(o.message.content[0].signature, '[sig]');
  assert.equal(o.message.content[0].type, 'thinking');
});

// 压数组的顺序写反过一次:先量长度再压元素,结果 assistant 的 content 数组
// (thinking + text + tool_use 拼起来轻松过 600 字节)被整个换成空元素 —— 消息正文没了,
// 屏幕上只剩几行空白。钉住"正文必须活着"这一条。
test('长 assistant 消息压完,正文和工具名一个都不能少', () => {
  const raw = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-opus-4-8',
      content: [
        { type: 'thinking', thinking: `先想一下这件事。${'思'.repeat(600)}`, signature: 'S'.repeat(4000) },
        { type: 'text', text: `写好了,放在 workspace 里。${'补'.repeat(600)}` },
        { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/桥自测.html', content: 'x'.repeat(3000) } },
      ],
    },
  });
  assert.ok(raw.length > SCREEN_HARD_CAP);
  const rows = formatLines([wire(screenSafe(raw))]);
  assert.equal(rows.length, 3, `三块应各出一行,实际:${JSON.stringify(rows)}`);
  assert.match(rows[0].text, /先想一下这件事/);
  assert.match(rows[1].text, /写好了,放在 workspace 里/);
  assert.match(rows[2].text, /^Write\(.*桥自测\.html\)$/);
});

test('stream_event 整类不上屏(桥自己照用不误)', () => {
  const events = REAL.filter((l) => l.includes('"type":"stream_event"'));
  assert.ok(events.length > 0, 'fixture 里没有 stream_event,这条钉不住');
  for (const l of events) assert.equal(screenSafe(l), null);
});

test('短行零成本放行:原样返回同一个字符串', () => {
  const short = REAL.filter((l) => l.length <= 1500 && !l.includes('stream_event'));
  assert.ok(short.length > 0);
  for (const l of short) assert.equal(screenSafe(l), l);
});

test('前端:以 { 开头却解不开 = 坏行,给一行短提示而不是 300 字乱码', () => {
  const broken = '{"type":"assistant","message":{"content":[{"type":"thinking","signature":"'
    + 'EpMlCokBCBAYAipAP9E4gyIDQjv7Ts73'.repeat(40);
  const row = formatLine(broken);
  assert.equal(row.mark, '…');
  assert.ok(!/[A-Za-z0-9+/]{60,}/.test(row.text), `还在吐 base64:${row.text}`);
  assert.match(row.text, /截断/);
});

test('前端:不以 { 开头的非 JSON 是真内容,照旧原样显示(fail-open 保的是这类)', () => {
  const row = formatLine('warning: something happened on stdout');
  assert.equal(row.cls, 'plain');
  assert.match(row.text, /warning: something happened/);
});

test('前端:system/status 不上屏 —— 一行孤零零的「status」什么也没说', () => {
  assert.equal(formatLine('{"type":"system","subtype":"status","status":"requesting"}'), null);
});
