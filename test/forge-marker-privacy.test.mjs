import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMessage } from '../lib/util.js';

test('forge handoff remains internal and chat receives only a short paper note', () => {
  const stored = {
    id: 1,
    msg_type: 'forge',
    content: '上一段 Session 的交接纸条：\n[12:00] 用户：很长的原文',
    thinking: 'internal',
    tools: [{ name: 'Read', arg: 'secret' }],
    attachments: [{ url: '/uploads/x.txt', name: 'x.txt' }],
  };
  const visible = publicMessage(stored);
  assert.equal(visible.content, '已整理上一段对话，并开启新的 Session。');
  assert.equal(visible.thinking, '');
  assert.deepEqual(visible.tools, []);
  assert.deepEqual(visible.attachments, []);
  assert.match(stored.content, /很长的原文/);
});
