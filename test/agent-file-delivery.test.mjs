import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// state.js 会在 import 时初始化 DATA_DIR；必须先把它指向临时目录，
// 否则一份全新 clone 跑测试会在仓库里生成 data/app-data.json。
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-file-delivery-'));
process.env.DATA_DIR = TEST_DATA_DIR;
const { ROOT_DIR, UPLOAD_DIR } = await import('../lib/state.js');
const { collectAgentFiles } = await import('../lib/agent-files.js');

test.after(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

test('agent file marker becomes a real local attachment and disappears from text', () => {
  const source = path.join(ROOT_DIR, 'agent-file-smoke.txt');
  fs.writeFileSync(source, 'hello from agent', 'utf8');
  let copied = '';
  try {
    const result = collectAgentFiles(`文件做好了。\n[[CCC_FILE:${source}]]`);
    assert.equal(result.content, '文件做好了。');
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].name, 'agent-file-smoke.txt');
    assert.equal(result.attachments[0].type, 'text/plain; charset=utf-8');
    copied = path.join(UPLOAD_DIR, path.basename(result.attachments[0].url));
    assert.equal(fs.readFileSync(copied, 'utf8'), 'hello from agent');
  } finally {
    fs.rmSync(source, { force: true });
    if (copied) fs.rmSync(copied, { force: true });
  }
});

test('agent file marker cannot publish files outside the allowed workspace', () => {
  const result = collectAgentFiles('[[CCC_FILE:C:\\Windows\\win.ini]]');
  assert.equal(result.content, '');
  assert.deepEqual(result.attachments, []);
});
