// 文件显示名的清洗。两个方向都要量,少一边就是这次的坑。
//
// 8/14 的账:原来是 \w 白名单,把中文全洗成下划线 ——「给同事.md」变「_.md」。
// 换成黑名单修好了中文,却**连带丢了一面**:双向控制符和零宽字符既不在控制符区、
// 也不是 Windows 禁字符,于是原样通过 ——「发票<U+202E>gpj.exe」在界面上会渲染成
// 「发票exe.jpg」。★ esc() 挡不住它:那些不是 HTML 元字符,转义后原样输出。
//
// 所以这份测试**两向都断言**:该洗的洗掉(欺骗样本),该留的一字不改(阳性对照)。
// 只写前一半的话,"把所有字符都换成 _" 也能全绿 —— 那正是被修掉的那个 bug。
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFileName } from '../lib/util.js';

test('cleanFileName 洗掉双向控制符与零宽字符(显示欺骗)', () => {
  const deception = [
    ['\u53d1\u7968' + '\u202e' + 'gpj.exe', 'RLO \u7ffb\u8f6c'],
    ['a' + '\u200f' + 'b.txt', 'RLM'],
    ['re' + '\u200b' + 'port.md', '\u96f6\u5bbd\u7a7a\u683c'],
    ['a' + '\u2066' + 'b' + '\u2069' + '.png', 'isolate pair'],
    ['x' + '\ufeff' + 'y.txt', 'BOM'],
    ['p' + '\u202a' + 'q.pdf', 'LRE'],
  ];
  const invisible = new RegExp('[' + '\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff' + ']');
  for (const [raw, why] of deception) {
    const got = cleanFileName(raw);
    assert.equal(invisible.test(got), false, why + ': ' + JSON.stringify(got) + ' \u91cc\u8fd8\u6709\u4e0d\u53ef\u89c1\u5b57\u7b26');
  }
});

test('cleanFileName 不动正常名字(阳性对照:中文/空格/连字符都得活着)', () => {
  // 这一半是这次 bug 的直接对照 —— 修 A 面不许砸 B 面。
  for (const name of ['\u7ed9\u5b9d\u5b9d.md', '\u65e5\u62a5 2026-08-14.md', 'normal file.png', '\u6c88\u5c7f\u7684\u7b14\u8bb0 v2.md']) {
    assert.equal(cleanFileName(name), name);
  }
});

test('cleanFileName 仍挡住路径分隔与 Windows 禁字符', () => {
  assert.equal(cleanFileName('a/b.txt').includes('/'), false);
  assert.equal(cleanFileName('a' + '\\' + 'b.txt').includes('\\'), false);
  assert.equal(cleanFileName('a<b>:c.txt'), 'a_b_c.txt');
  assert.equal(cleanFileName(''), 'upload.bin');
});
