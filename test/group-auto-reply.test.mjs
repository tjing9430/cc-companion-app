import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CC_SKIP_DOTENV = '1';
process.env.AUTO_REPLY_GROUP = 'true';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'group-reply-'));

const { store } = await import('../lib/state.js');
const { shouldReplyInGroup } = await import('../lib/chat.js');

test('AUTO_REPLY_GROUP 只是初始默认值，设置页关闭后必须生效', () => {
  assert.equal(store.settings.autoReplyGroup, true, '新库仍然应该吃到 env 的初始值');
  store.settings.autoReplyGroup = false;
  assert.equal(shouldReplyInGroup('这是一条没有提及 agent 的普通消息'), false,
    '设置页关闭后，不能被启动时 env 永久压住');
  store.settings.autoReplyGroup = true;
  assert.equal(shouldReplyInGroup('普通消息'), true);
});

test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
