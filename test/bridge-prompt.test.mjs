// The bridge used to forward only the last user message, so recalled documents and memories
// never reached the agent — the user uploaded a file to 资料库 and the agent kept saying it
// couldn't see anything. These pin the fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../bridge/prompt.js';

const PERSONA = { role: 'system', content: '你是 AI 助手。' };
const DOCS = { role: 'system', content: '参考资料（供参考）：\n【笔记.txt】橘猫叫大王' };
const MEM = { role: 'system', content: '相关记忆（供参考）：\n- 咖啡: 只喝手冲' };

test('recalled documents reach the prompt (the bug: they were dropped)', () => {
  const out = buildPrompt([PERSONA, DOCS, { role: 'user', content: '猫叫什么' }]);
  assert.ok(out.includes('橘猫叫大王'), '文档内容必须进 prompt');
  assert.ok(out.includes('猫叫什么'), '用户这句也要在');
});

test('both recall blocks go through, in order, with the user message last', () => {
  const out = buildPrompt([PERSONA, DOCS, MEM, { role: 'user', content: '问题' }]);
  assert.ok(out.indexOf('参考资料') < out.indexOf('相关记忆'), '顺序跟 app 拼的一致');
  assert.ok(out.indexOf('相关记忆') < out.indexOf('问题'), '用户消息在最后');
});

test('history is NOT re-sent — the resumed session already has it', () => {
  const out = buildPrompt([
    PERSONA,
    { role: 'user', content: '上一轮问的' },
    { role: 'assistant', content: '上一轮答的' },
    DOCS,
    { role: 'user', content: '这一轮' },
  ]);
  assert.ok(!out.includes('上一轮问的'), '旧的用户消息不该重发');
  assert.ok(!out.includes('上一轮答的'), '旧的回复不该重发');
  assert.ok(out.includes('橘猫叫大王') && out.includes('这一轮'));
});

test('the app persona prompt stays out — the sandbox CLAUDE.md owns the persona', () => {
  const out = buildPrompt([PERSONA, DOCS, { role: 'user', content: '问题' }]);
  assert.ok(!out.includes('你是 AI 助手'), 'messages[0] 不转发');
});

test('no recall this turn → the prompt is exactly the user message', () => {
  assert.equal(buildPrompt([PERSONA, { role: 'user', content: '就一句话' }]), '就一句话');
});

test('array-shaped content (vision-style parts) is flattened', () => {
  const out = buildPrompt([
    PERSONA,
    { role: 'system', content: [{ type: 'text', text: '参考资料：块 A' }] },
    { role: 'user', content: [{ type: 'text', text: '看图' }] },
  ]);
  assert.ok(out.includes('参考资料：块 A') && out.includes('看图'));
});

test('degenerate inputs never throw', () => {
  assert.equal(buildPrompt(undefined), '');
  assert.equal(buildPrompt([]), '');
  assert.equal(buildPrompt([PERSONA]), '', '没有 user 消息就返回空,调用方会回 400');
  assert.equal(buildPrompt([{ role: 'user', content: '只有用户' }]), '只有用户');
});

test('empty recall blocks are skipped, not turned into blank separators', () => {
  const out = buildPrompt([PERSONA, { role: 'system', content: '   ' }, { role: 'user', content: '问题' }]);
  assert.equal(out, '问题');
});
