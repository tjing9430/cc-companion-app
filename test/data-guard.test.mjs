// data-guard 自己的牙。
//
// ★ 守卫和被守卫的东西一样会坏,而且坏了**更难发现** —— 它坏掉的表现就是"一直绿"。
//   同仓已经有过一次「上线了但一次都没生效过」的占位底(靠 canary 才逮到)。
//   所以这份测试的重点不是"diff 能算对",是**「它真的会红」**。
//
// ★ 为什么守卫本体做成 pretest/posttest 而不是一条普通测试:
//   `node --test` 不保证文件顺序,守卫可能跑在肇事者前面 —— 那就是一条永远绿的假保护。
//   钩子在整套的一头一尾,顺序是确定的。
//   ⇒ 但那样一来守卫本身就不在测试覆盖里了,所以有了这个文件:**在套内测它的判断逻辑**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint, diff } from '../scripts/data-guard.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dguard-'));

test('没动过 → 没有差异', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'app-data.json'), '{"a":1}');
  const before = fingerprint(d);
  assert.deepEqual(diff(before, fingerprint(d)), []);
});

test('★ 阳性对照:新建文件必须报出来(这是 avatar 那个案子的形状)', () => {
  const d = tmp();
  const before = fingerprint(d);
  fs.writeFileSync(path.join(d, 'app.db'), Buffer.alloc(114688));   // sqlite 后端下实测的那个大小
  const bad = diff(before, fingerprint(d));
  assert.equal(bad.length, 1, `期望正好 1 条,实际 ${JSON.stringify(bad)}`);
  assert.match(bad[0], /^新建 {2}data\/app\.db$/);
});

test('★ 阳性对照:**同长度覆写**也必须报(只比大小的尺子会漏掉它)', () => {
  const d = tmp();
  const f = path.join(d, 'app-data.json');
  fs.writeFileSync(f, 'AAAA');
  const before = fingerprint(d);
  // 拨快 mtime,免得同一毫秒内改写被时间戳精度吃掉 —— 这不是造假,
  // 是把"真实世界里必然存在的时间差"补上;不补的话这条测试会**偶发绿**,
  // 而偶发绿的阳性对照比没有更糟(它会让人以为这一面验过了)。
  fs.writeFileSync(f, 'BBBB');
  const st = fs.statSync(f);
  fs.utimesSync(f, st.atime, new Date(st.mtimeMs + 1000));
  const bad = diff(before, fingerprint(d));
  assert.equal(bad.length, 1, `同长度覆写没被报出来:${JSON.stringify(bad)}`);
  assert.match(bad[0], /^改动 {2}data\/app-data\.json/);
});

test('★ 阳性对照:删除也必须报(有人跑测试把库删了,和写坏一样严重)', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'app.db'), 'x');
  const before = fingerprint(d);
  fs.rmSync(path.join(d, 'app.db'));
  const bad = diff(before, fingerprint(d));
  assert.deepEqual(bad, ['删除  data/app.db']);
});

test('子目录里的改动也要看得见(uploads/ 在 data/ 底下)', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'uploads'));
  const before = fingerprint(d);
  fs.writeFileSync(path.join(d, 'uploads', 'x.png'), 'png');
  assert.deepEqual(diff(before, fingerprint(d)), ['新建  data/uploads/x.png']);
});

test('目录不存在 → 空指纹,不炸(全新克隆没有 data/)', () => {
  assert.deepEqual(fingerprint(path.join(os.tmpdir(), 'ccc-definitely-not-here-' + process.pid)), {});
});

test('★ 守卫不读文件内容(观测者不许碰被观测的库)', () => {
  // 指纹只由 size+mtime 组成 —— 如果哪天有人改成读内容做 hash,
  // 这条会红,提醒他:那等于让守卫自己去读用户的库,而 mtime/atime 都可能被带动。
  const d = tmp();
  const f = path.join(d, 'app.db');
  fs.writeFileSync(f, 'SECRET-CONTENT');
  const fp = fingerprint(d);
  assert.equal(Object.keys(fp).length, 1);
  assert.match(fp['app.db'], /^\d+:\d+$/, `指纹应当是 size:mtime,实际 ${fp['app.db']}`);
  assert.ok(!JSON.stringify(fp).includes('SECRET'), '指纹里不该出现文件内容');
});
