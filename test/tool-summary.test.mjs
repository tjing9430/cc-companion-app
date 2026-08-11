// 工具调用摘要:回答「它用了什么工具、动了哪儿」,但**不端出文件内容**。
//
// ★ 这条测试存在的直接原因:改 `fold.tools` 的形状(string[] → {name,arg}[])时,
//   全量 202 条一条都没红 —— 说明这块之前完全没有闸。一个没人测的数据形状,
//   下一次改它的人同样不会收到任何警告。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolInput, foldTurnEntries } from '../bridge/interactive.js';

test('摘要取「动了哪儿」:文件路径 / 命令 / 搜索词', () => {
  assert.equal(summarizeToolInput({ file_path: '/home/u/notes.md' }), '/home/u/notes.md');
  assert.equal(summarizeToolInput({ command: 'ls -la /tmp' }), 'ls -la /tmp');
  assert.equal(summarizeToolInput({ pattern: 'TODO' }), 'TODO');
  assert.equal(summarizeToolInput({ url: 'https://example.com/a' }), 'https://example.com/a');
});

// ★★ 这条是隐私守卫,必须证明它会咬:Write/Edit 的正文可能是**整个文件**,
//    它不该出现在聊天气泡里。守卫的实现方式是「白名单取键」而不是「黑名单排除」——
//    白名单的好处是:将来新增一个叫 `secret_blob` 的字段,它默认就出不来。
test('★ 不端内容:content / new_string / old_string 一律不进摘要', () => {
  assert.equal(summarizeToolInput({ content: '整个文件的正文……' }), '');
  assert.equal(summarizeToolInput({ old_string: 'aaa', new_string: 'bbb' }), '');
  // 同时给了路径和正文时,只取路径
  assert.equal(summarizeToolInput({ file_path: '/x.txt', content: '不该出现' }), '/x.txt');
  // 未知字段一律不取(白名单语义)
  assert.equal(summarizeToolInput({ secret_blob: 'nope' }), '');
});

test('长值硬截断,换行折成空格(这行字要挤进聊天气泡)', () => {
  const long = 'x'.repeat(400);
  const out = summarizeToolInput({ command: long });
  assert.equal(out.length, 120, '截到 120(119 + 省略号)');
  assert.ok(out.endsWith('…'));
  assert.equal(summarizeToolInput({ command: 'a\n  b\tc' }), 'a b c');
});

test('空输入不炸', () => {
  for (const v of [null, undefined, 0, '', [], {}]) assert.equal(summarizeToolInput(v), '');
});

test('foldTurnEntries 吐 {name, arg},名字和参数都在', () => {
  const entries = [{
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: '想一下' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/hello.txt' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } },
        { type: 'text', text: '好了' },
      ],
      stop_reason: 'end_turn',
    },
  }];
  const fold = foldTurnEntries(entries);
  assert.deepEqual(fold.tools, [
    { name: 'Read', arg: '/hello.txt' },
    { name: 'Bash', arg: 'echo hi' },
  ]);
  assert.equal(fold.thinking, '想一下');
  assert.equal(fold.done, true);
});

test('没有 input 的工具仍然记名字(arg 为空,不是崩)', () => {
  const fold = foldTurnEntries([{
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Mystery' }], stop_reason: 'tool_use' },
  }]);
  assert.deepEqual(fold.tools, [{ name: 'Mystery', arg: '' }]);
});
