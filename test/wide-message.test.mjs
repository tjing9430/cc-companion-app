// 「这条消息要不要占满一整行」只看**正文**。
//
// ★ 这份测试的由来:`isWideMessage` 原来有一条「有附件就 true」。
//   那条规则成立的前提是**附件渲在气泡里面**、需要横向空间。
//   后来附件被搬到气泡外面(图片不再套框),前提没了 —— 规则却留着,
//   于是"配一句话发张图"的消息,那句话的气泡被撑到最宽。
//   **前提消失时,建立在它上面的规则不会跟着消失,只会安静地继续生效。**
//   改这个函数时全量一条没红(它当时零覆盖),所以补上。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// 这个模块是浏览器侧 ESM,直接 import 会拖进一串 DOM 依赖 —— 只取这一个纯函数来跑。
const src = readFileSync(path.join(root, 'public/js/util.js'), 'utf8');
const start = src.indexOf('function isWideMessage');
assert.ok(start > 0, '找不到 isWideMessage —— 函数被改名了,这份测试就失效了');
const body = src.slice(start, src.indexOf('\n}', start) + 2);
const ctx = { };
vm.createContext(ctx);
vm.runInContext(`${body}; this.isWideMessage = isWideMessage;`, ctx);
const { isWideMessage } = ctx;

test('短句不占满整行', () => {
  assert.equal(isWideMessage('好'), false);
  assert.equal(isWideMessage('这句十八个字以内的话'), false);
});

test('长句 / 多行 占满整行', () => {
  assert.equal(isWideMessage('一'.repeat(19)), true, '超过 18 字');
  assert.equal(isWideMessage('第一行\n第二行'), true, '含换行');
});

test('★ 有附件**不再**把气泡撑宽(附件已经渲在气泡外面了)', () => {
  const img = [{ url: '/a.webp', type: 'image/webp' }];
  assert.equal(isWideMessage('好', img), false,
    '「配一句话发张图」时,那句话的气泡应当按正文长度收窄,不该被附件撑满');
  assert.equal(isWideMessage('', img), false, '纯图片消息连气泡都不该有,更不该是宽的');
  // 正文本身长时,该宽还是宽 —— 判据换成了正文,不是"忽略一切"
  assert.equal(isWideMessage('一'.repeat(30), img), true);
});

test('边界:恰好 18 字不宽,19 字宽(别把 > 写成 >=)', () => {
  assert.equal(isWideMessage('一'.repeat(18)), false);
  assert.equal(isWideMessage('一'.repeat(19)), true);
});

test('按**字符**数不按字节数(中文一个字算一个)', () => {
  // 18 个中文 = 54 字节;若实现改用 .length 以外的字节口径,这条会红
  assert.equal(isWideMessage('中'.repeat(18)), false);
});
