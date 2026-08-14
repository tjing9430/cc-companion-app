// 设置项数值的清洗。给「美观」面板那排透明度滑杆用的。
//
// ★ 这份测试的重点不是"能不能算对 25",是**非法输入会不会伪装成合法值溜进去**。
//   下游是 CSS:`opacity: NaN` 不会报错,浏览器**安静地当没这条声明** ——
//   面板看着正常、拖动毫无反应、控制台干净。
//   ⇒ 失败长得跟"没生效"一模一样,那是最难查的一类,所以在入口拦。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNumber, clampLimit } from '../lib/util.js';

const D = 30;   // 默认值
const opacity = (v) => cleanNumber(v, D, 0, 100);

test('正常值原样通过', () => {
  assert.equal(opacity(0), 0);
  assert.equal(opacity(25), 25);
  assert.equal(opacity(100), 100);
  assert.equal(opacity(12.5), 12.5);
});

test('★★ 0 必须活下来 —— 这是不复用 clampLimit 的全部理由', () => {
  // clampLimit 写的是 `Number(limit) || 80`,而 `0 || 80 === 80`:
  // `||` 把合法的 0 当成"没填"。滑杆拖到最左端会被静默改回默认值,
  // 用户看到的是"拖到底就弹回去",没有任何报错。
  assert.equal(opacity(0), 0, '0 被吃掉了');
  assert.equal(opacity('0'), 0, '字符串 "0" 被吃掉了');
  // 反面钉住:老 helper 确实有这个毛病(不是我编的靶子)
  assert.equal(clampLimit(0), 80, 'clampLimit(0) 居然不是 80 了 —— 那这条注释要重写');
});

test('★ 数字串收,带空白也收(JSON 里滑杆值可能是字符串)', () => {
  assert.equal(opacity('25'), 25);
  assert.equal(opacity('  25  '), 25);
  assert.equal(opacity('12.5'), 12.5);
});

test('★★ 会伪装成数字的东西必须挡住', () => {
  // 这三个是 Number() 的经典坑:它们都能"成功"转成数字,于是溜进下游。
  assert.equal(opacity(true), D, 'Number(true)===1,布尔伪装成了 1');
  assert.equal(opacity(false), D, 'Number(false)===0,布尔伪装成了 0');
  assert.equal(opacity([]), D, 'Number([])===0,空数组伪装成了 0');
  assert.equal(opacity([50]), D, 'Number([50])===50,单元素数组伪装成了 50');
});

test('★ 真·非法值回落默认', () => {
  for (const bad of [undefined, null, '', '   ', 'abc', '25px', {}, NaN, Infinity, -Infinity, '1e999']) {
    assert.equal(opacity(bad), D, `${JSON.stringify(String(bad))} 应当回落默认 ${D}`);
  }
});

test('★ 越界夹到边界,不回落默认', () => {
  // ⚠️ 越界 ≠ 非法。用户拖过头是明确意图,夹到边界比"弹回默认"更符合预期。
  assert.equal(opacity(999), 100);
  assert.equal(opacity(-5), 0);
  assert.equal(opacity('999'), 100);
});

test('不给 min/max 时不夹', () => {
  assert.equal(cleanNumber(-999, 0), -999);
  assert.equal(cleanNumber(1e6, 0), 1e6);
});

test('★★ 阳性对照:换成"天真实现",上面那些坑必须原形毕露', () => {
  // 没有这条,上面全绿可能只是因为它们没在测东西。
  // 天真版 = 大多数人第一版会写的样子:Number() + || 兜底 + clamp。
  const naive = (v, def, min, max) => Math.min(max, Math.max(min, Number(v) || def));
  const caught = [];
  if (naive(0, D, 0, 100) !== 0) caught.push('0 被 || 吃掉');
  if (naive(true, D, 0, 100) !== D) caught.push('布尔伪装成数字');
  if (naive([], D, 0, 100) !== D) caught.push('空数组伪装成数字');
  if (naive([50], D, 0, 100) !== D) caught.push('单元素数组伪装成数字');
  assert.ok(caught.length >= 3,
    `天真实现居然只暴露了 ${caught.length} 个坑(${caught.join('、')})—— 说明这套判据没在测真东西`);
});
