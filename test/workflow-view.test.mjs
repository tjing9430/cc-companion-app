import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => '', setItem: () => {}, removeItem: () => {} };
const { buildFlowRows, parseToolDetail } = await import('../public/js/workflow-view.js');

test('workflow hides the bridge generating placeholder', () => {
  const rows = buildFlowRows([
    { id: 1, kind: 'received', body: '你好', created_at: '2026-08-18T00:00:00Z' },
    { id: 2, kind: 'thinking', body: '正在生成回复...', created_at: '2026-08-18T00:00:01Z' },
    { id: 3, kind: 'reply', body: '在呢', created_at: '2026-08-18T00:00:02Z' },
  ]);
  assert.deepEqual(rows.map((row) => row.kind), ['received', 'reply']);
});

test('edit arguments become red/green diff payloads', () => {
  const detail = parseToolDetail(JSON.stringify({
    file_path: '/work/app.css',
    old_string: 'color: red;\npadding: 8px;',
    new_string: 'color: blue;\npadding: 6px;\nmargin: 0;',
  }));
  assert.equal(detail.summary, '/work/app.css');
  assert.equal(detail.removedCount, 2);
  assert.equal(detail.addedCount, 3);
  assert.match(detail.removed, /color: red/);
  assert.match(detail.added, /margin: 0/);
});

test('write arguments are treated as additions', () => {
  const detail = parseToolDetail(JSON.stringify({ file_path: 'new.md', content: '# 新文件\n正文' }));
  assert.equal(detail.removedCount, 0);
  assert.equal(detail.addedCount, 2);
});
