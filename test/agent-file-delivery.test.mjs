import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, UPLOAD_DIR } from '../lib/state.js';
import { collectAgentFiles } from '../lib/agent-files.js';

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
