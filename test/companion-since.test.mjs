// 陪伴起算日。
//
// 规格:①用户可自选 ②不选就默认「第一次跑这个前端的日子」——首跑时间戳落进 settings。
// 这是给自部署用户的功能,不是自家彩蛋,所以两条都得对任何人成立。
//
// 校验为什么必须严:这个值会进日期运算(算「第几天」)。放一个 '2026-02-31' 或者一段
// 文本进去,界面上出现的不是报错,是「已经一起 NaN 天了」—— 一句读不懂的话。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'since-'));
const { normalizeDateOnly, store, normalizeSettings } = await import('../lib/state.js');

test('只认 YYYY-MM-DD 的真实日期', () => {
  assert.equal(normalizeDateOnly('2026-03-16'), '2026-03-16');
  assert.equal(normalizeDateOnly('  2026-03-16  '), '2026-03-16', '两头空白要容忍');
});

test('★ 不存在的日期要挡住 —— Date 会把 02-31 悄悄滚成 03-03', () => {
  // 这就是为什么光 new Date() 不报错还不够,必须把结果反查回字符串比一遍
  assert.equal(normalizeDateOnly('2026-02-31'), '');
  assert.equal(normalizeDateOnly('2026-02-29'), '', '2026 不是闰年');
  assert.equal(normalizeDateOnly('2026-13-01'), '');
  assert.equal(normalizeDateOnly('2026-00-10'), '');
});

test('格式不对一律空,不抛', () => {
  for (const v of ['今天', '2026-3-6', '2026/03/16', '<script>alert(1)</script>', '', '   ', null, undefined, 42, {}, []]) {
    assert.equal(normalizeDateOnly(v), '', `${JSON.stringify(v)} 该被吞掉`);
  }
});

test('★ 全新安装:首跑就有起算日,且是今天', () => {
  // defaultStore 只在新建时跑一次,所以这个戳天然就是「第一次跑的日子」
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(store.settings.companion_since, today,
    '新库的 companion_since 该等于今天 —— 它就是「首次使用」的定义');
});

test('用户改得动,而且脏值改不动', () => {
  assert.equal(normalizeSettings({ ...store.settings, companion_since: '2026-03-16' }).companion_since, '2026-03-16');
  assert.equal(normalizeSettings({ ...store.settings, companion_since: '2026-02-31' }).companion_since, '',
    '脏值要落成空串,不能原样存下去');
});

test('结构守卫:设置页的控件必须挂能力门', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(REPO, 'public', 'js', 'settings-view.js'), 'utf8');
  assert.ok(src.includes("hasOwnProperty.call(s, 'companion_since')"),
    '后端还不认这个字段的那个窗口里,前端不该摆这个控件(同头像那道门)');
  assert.ok(src.includes('name="companion_since"'), '输入框要有 name,否则 FormData 收不到、存不进去');
});
