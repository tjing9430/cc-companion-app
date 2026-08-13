// stream-format 的纯函数钉子。样本来源见各条注释 —— 真样本优先,手搓样本必须注明推导链。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLine } from '../public/js/stream-format.js';

// ★ 真样本:2026-08-13 在本机 CLI 实弹抓的一行(haiku 探测轮)。
//   allowed 状态**没有 utilization 字段** —— 这行以前渲染成「用量 · five_hour · 重置 00:10」,
//   顶着「用量」两个字却没有数,还披着 ⚠。钉住新行为:不写用量、不给 ⚠、类型写中文。
const REAL_ALLOWED = JSON.stringify({
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', resetsAt: 1786637400, rateLimitType: 'five_hour',
    overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false,
  },
  uuid: '66100f2c-2f99-4e5f-a8db-b47c0b28f751', session_id: '4f11563f-2e34-4e72-ac44-969f3df69dc0',
});

test('rate_limit_event 无 utilization:不空挂「用量」,不冒充警告', () => {
  const r = formatLine(REAL_ALLOWED);
  assert.ok(r && !Array.isArray(r));
  assert.equal(r.mark, '●');
  assert.equal(r.cls, 'sys');
  assert.ok(!r.text.includes('用量'), `不该出现空的用量字样: ${r.text}`);
  assert.ok(!r.text.includes('five_hour'), `类型该翻译成中文: ${r.text}`);
  assert.ok(r.text.includes('五小时窗'), r.text);
  // 重置时刻按**看的人**的本地时区渲染(见 hhmm 注释),测试机时区不定,只钉格式不钉数值
  assert.match(r.text, /重置 \d{2}:\d{2}/);
});

// 手搓样本:字段形状取自上面的真样本,只加 utilization —— 0~1 刻度的依据是
// 8/12 旧代码用 `*100` 渲染出过 94%(她屏幕上见过),说明流里是 0.94 这种小数。
test('rate_limit_event 带 utilization:显示用量并标 ⚠', () => {
  const o = JSON.parse(REAL_ALLOWED);
  o.rate_limit_info.utilization = 0.94;
  const r = formatLine(JSON.stringify(o));
  assert.equal(r.mark, '⚠');
  assert.equal(r.cls, 'warn');
  assert.ok(r.text.includes('用量 94%'), r.text);
});

// status 不是 allowed 时要把状态亮出来 —— 被限流了还静悄悄才是事故
test('rate_limit_event 非 allowed:状态上屏', () => {
  const o = JSON.parse(REAL_ALLOWED);
  o.rate_limit_info.status = 'rejected';
  const r = formatLine(JSON.stringify(o));
  assert.equal(r.mark, '⚠');
  assert.ok(r.text.includes('rejected'), r.text);
});
