// 长回复拆成小气泡时,按段落切 —— 但**不能切坏 Markdown**。
//
// 光按空行 split 看着最简单,可代码块、列表、表格、引用**内部本来就有空行**:
// 从那儿切断,一段代码会被劈成两半、一个列表会变成两个列表,渲染出来是碎的。
// 这份测试盯的就是「该切的切了 / 不该切的一个没动」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitParagraphs } from '../public/js/util.js';

const n = (s) => splitParagraphs(s).length;

test('普通段落按空行切开', () => {
  assert.equal(n('第一段\n\n第二段'), 2);
  assert.equal(n('第一段\n\n第二段\n\n第三段'), 3);
  assert.equal(n('单独一段'), 1);
  assert.equal(n('连续换行\n\n\n\n也只算一处边界'), 2);
});

test('围栏代码块里的空行不许切', () => {
  const s = '前言\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n后记';
  const segs = splitParagraphs(s);
  assert.equal(segs.length, 3, `应是 前言/代码/后记 三段,实际 ${segs.length}`);
  // 代码那段必须是完整的一块,两行都在里面
  const code = segs.find((x) => x.includes('```'));
  assert.ok(code.includes('const a = 1;') && code.includes('const b = 2;'), '代码被劈开了');
  assert.equal((code.match(/```/g) || []).length, 2, '围栏没配对 —— 说明从中间切断了');
});

test('~~~ 围栏同样算数(不是只认反引号)', () => {
  const segs = splitParagraphs('x\n\n~~~\na\n\nb\n~~~\n\ny');
  assert.equal(segs.length, 3);
});

test('松散列表不会被拆成两个列表', () => {
  assert.equal(n('- one\n\n- two\n\n- three'), 1);
  assert.equal(n('1. 甲\n\n2. 乙'), 1);
});

test('表格和引用整块留着', () => {
  assert.equal(n('| a | b |\n|---|---|\n\n| 1 | 2 |'), 1);
  assert.equal(n('> 上句\n\n> 下句'), 1);
});

test('结构结束之后,后面的正文该切还是要切', () => {
  // 列表结束 → 普通段落:这是真的段落边界
  assert.equal(n('- one\n- two\n\n这是正文'), 2);
  assert.equal(n('> 引用\n\n这是正文'), 2);
});

test('空输入不产出空气泡', () => {
  assert.deepEqual(splitParagraphs(''), []);
  assert.deepEqual(splitParagraphs('   \n\n  '), []);
  assert.deepEqual(splitParagraphs(null), []);
  assert.deepEqual(splitParagraphs(undefined), []);
});

test('切完的内容拼回去,一个字都不能少', () => {
  // ★ 这条是防「切着切着把内容吃掉」—— 比数段数更要紧:
  //   段数不对顶多难看,内容丢了是数据可见地缺一块。
  const src = '第一段\n\n- a\n\n- b\n\n```\ncode\n\nmore\n```\n\n收尾';
  const joined = splitParagraphs(src).join('\n');
  for (const token of ['第一段', '- a', '- b', 'code', 'more', '收尾']) {
    assert.ok(joined.includes(token), `切完之后 "${token}" 不见了`);
  }
});
