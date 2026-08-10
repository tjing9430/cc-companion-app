// 资料库 mirror: uploaded documents become real files in the agent's working directory,
// because top-N chunk retrieval is not what people mean by "I put it in the library".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeFileName, planSync, manifestLine, syncLibrary, LIBRARY_DIR } from '../bridge/library.js';

test('filenames can never escape the library directory', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeFileName('..'), 'untitled');
  assert.equal(safeFileName('.hidden'), 'hidden');
  assert.equal(safeFileName('a/b\\c.txt'), 'a-b-c.txt');
  assert.equal(safeFileName(''), 'untitled');
  assert.equal(safeFileName(null), 'untitled');
  assert.ok(!safeFileName('x`whoami`.txt').includes('`'), '反引号要去掉');
});

test('long names are truncated but keep their extension', () => {
  const out = safeFileName('长'.repeat(200) + '.md');
  assert.ok(out.length <= 80);
  assert.ok(out.endsWith('.md'));
});

test('same-name documents get disambiguated, unique ones stay clean', () => {
  const { files } = planSync([
    { id: 1, name: '笔记.txt' },
    { id: 2, name: '笔记.txt' },
    { id: 3, name: '独一份.md' },
  ], []);
  const names = [...files.keys()];
  assert.ok(names.includes('笔记-1.txt') && names.includes('笔记-2.txt'), '重名才加 id');
  assert.ok(names.includes('独一份.md'), '不重名就别加后缀');
});

test('files for deleted documents are removed', () => {
  const { deletes } = planSync([{ id: 1, name: '还在.txt' }], ['还在.txt', '已删.txt']);
  assert.deepEqual(deletes, ['已删.txt']);
});

test('the manifest names the directory so the agent knows to look', () => {
  const { files } = planSync([{ id: 1, name: '笔记.txt' }], []);
  const line = manifestLine(files);
  assert.ok(line.includes(`${LIBRARY_DIR}/笔记.txt`));
  assert.equal(manifestLine(new Map()), '', '空库不占 prompt 的地方');
});

test('end to end: documents land on disk, stale ones get swept', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const docs = [{ id: 7, name: '菜谱.txt', size: 6 }];
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => (url.endsWith('/api/documents') ? docs : { id: 7, name: '菜谱.txt', content: '糖醋排骨' }),
  });
  fs.mkdirSync(path.join(cwd, LIBRARY_DIR));
  fs.writeFileSync(path.join(cwd, LIBRARY_DIR, '早就删了.txt'), 'x');

  const manifest = await syncLibrary({ appUrl: 'http://x', token: 't', cwd, fetchImpl });

  assert.equal(fs.readFileSync(path.join(cwd, LIBRARY_DIR, '菜谱.txt'), 'utf8'), '糖醋排骨');
  assert.ok(!fs.existsSync(path.join(cwd, LIBRARY_DIR, '早就删了.txt')), '删掉的资料不该留在盘上');
  assert.ok(manifest.includes('菜谱.txt'));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a document named ../escape.txt is written inside the library, not above it', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => (url.endsWith('/api/documents')
      ? [{ id: 1, name: '../escape.txt', size: 3 }]
      : { id: 1, content: 'bad' }),
  });
  await syncLibrary({ appUrl: 'http://x', token: 't', cwd, fetchImpl });
  assert.ok(!fs.existsSync(path.join(cwd, 'escape.txt')), '绝不能写到库目录外面');
  assert.ok(fs.existsSync(path.join(cwd, LIBRARY_DIR, 'escape.txt')));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('a dead app never blocks the turn', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await syncLibrary({ appUrl: 'http://x', token: 't', cwd, fetchImpl }), '');
  fs.rmSync(cwd, { recursive: true, force: true });
});

// 中文正文:字符数 ≠ 字节数。按 size 判断「变没变」在这里必然误判、每轮重下,
// 之前那版测试用 'abc' 才蒙混过去 —— 所以这里的正文必须是中文。
test('unchanged documents are not re-downloaded (CJK: chars != bytes)', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const content = '糖醋排骨的做法很长很长';
  const updated = '2026-08-10T02:00:00.000Z';
  let fullFetches = 0;
  const fetchImpl = async (url) => {
    if (!url.endsWith('/api/documents')) fullFetches += 1;
    return { ok: true, json: async () => (url.endsWith('/api/documents')
      ? [{ id: 1, name: '菜谱.txt', size: content.length, updated_at: updated }]
      : { id: 1, content }) };
  };
  const opts = { appUrl: 'http://x', token: 't', cwd, fetchImpl };
  await syncLibrary(opts);
  assert.equal(fullFetches, 1, '第一次要下');
  await syncLibrary(opts);
  await syncLibrary(opts);
  assert.equal(fullFetches, 1, '没改过就别再下 —— 字符数和字节数对不上也不能误判');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('an edited document IS re-downloaded', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  let updated = '2026-08-10T02:00:00.000Z';
  let content = '第一版';
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.endsWith('/api/documents')
    ? [{ id: 1, name: '会改的.txt', size: content.length, updated_at: updated }]
    : { id: 1, content }) });
  const opts = { appUrl: 'http://x', token: 't', cwd, fetchImpl };
  await syncLibrary(opts);
  updated = '2026-08-10T03:00:00.000Z'; content = '改过的第二版';
  await syncLibrary(opts);
  assert.equal(fs.readFileSync(path.join(cwd, LIBRARY_DIR, '会改的.txt'), 'utf8'), '改过的第二版');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('content is mirrored byte for byte, trailing newline and all', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const content = '  开头有空格\n中间\n结尾有换行\n';
  const fetchImpl = async (url) => ({ ok: true, json: async () => (url.endsWith('/api/documents')
    ? [{ id: 1, name: '原样.txt', size: content.length, updated_at: '2026-08-10T02:00:00.000Z' }]
    : { id: 1, content }) });
  await syncLibrary({ appUrl: 'http://x', token: 't', cwd, fetchImpl });
  assert.equal(fs.readFileSync(path.join(cwd, LIBRARY_DIR, '原样.txt'), 'utf8'), content, '首尾空白不许削');
  fs.rmSync(cwd, { recursive: true, force: true });
});
