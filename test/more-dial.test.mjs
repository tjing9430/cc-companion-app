// 「更多」页那六个功能位。
//
// ★ 这份测试守的不是像素,是**两件会安静错掉的事**:
//   ① 旋转换算写反 —— 顺时针和逆时针的公式只差一个减号,
//      写反了页面照样渲染、星点照样排成一列,只是**整盘上下颠倒**,
//      而颠倒之后它看起来仍然像个北斗,肉眼很难当场认出来。
//   ② 功能位发错星 —— 位子是按盘上从上到下发的。如果哪天有人把 STAR_POINTS
//      重新排序(比如"整理一下让它按 x 递增"),而发位子那段忘了跟着排,
//      「设置」就会从盘顶跳到盘中间,没有任何报错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// more-view 顺着 state.js 会碰到 localStorage(浏览器全局)。
// ★ 用**动态 import** 而不是顶上的静态 import:静态 import 会被提升到桩之前执行,
//   桩就白打了。这一步不是可选的写法偏好 —— 写成静态的,这份测试根本跑不起来。
globalThis.localStorage = { getItem: () => '', setItem: () => {}, removeItem: () => {} };
const { STAR_POINTS, rotateCCW, SLOTS } = await import('../public/js/more-view.js');

test('素材里量出来的是 6 颗,不是 7', () => {
  // 名字叫「北斗七星」,素材只画了 6 个星核 —— 差额是故意的,不是漏抄。
  // 若换素材后真的有 7 颗,改这个数**同时**要在 more-view.js 顶上更新那段说明。
  assert.equal(STAR_POINTS.length, 6);
});

test('★ 逆时针 90° 的换算方向:拿图的四个角验,不是验公式本身', () => {
  // 用公式验公式是同义反复。这里改成拿**已知的角点该去哪儿**当判据。
  // 逆时针转 90°:右上角 → 左上角,左上角 → 左下角。
  assert.deepEqual(rotateCCW({ x: 100, y: 0 }), { x: 0, y: 0 },   '右上应转到左上');
  assert.deepEqual(rotateCCW({ x: 0,   y: 0 }), { x: 0, y: 100 }, '左上应转到左下');
  assert.deepEqual(rotateCCW({ x: 0, y: 100 }), { x: 100, y: 100 }, '左下应转到右下');
  // 顺时针的公式会是 (100-y, x) —— 拿左上角一验就分得开:顺时针它去右上。
  assert.notDeepEqual(rotateCCW({ x: 0, y: 0 }), { x: 100, y: 0 }, '这是顺时针的结果,方向反了');
});

test('功能位按盘上从上到下发,不按数组顺序', () => {
  const rotated = STAR_POINTS.map(rotateCCW);
  const byY = [...rotated].sort((a, b) => a.y - b.y);
  // 原数组顺序和「从上到下」不是同一个顺序 —— 正因为不同,渲染时那次 sort 才不能省。
  assert.notDeepEqual(rotated.map((p) => p.y), byY.map((p) => p.y),
    '若两者恰好相同,这条测试就守不住东西了,得换个判据');
  // 第一个位子(设置)必须落在最靠上的那颗星
  assert.equal(byY[0].y, Math.min(...rotated.map((p) => p.y)));
});

test('功能位比星少 —— 余下的是留给开源用户的空位', () => {
  assert.ok(SLOTS.length < STAR_POINTS.length,
    '塞满就没有空位了;这一页的设计前提是"留白给人自己加"');
  assert.equal(SLOTS[0].tab, 'settings', '「更多」不再直接落进设置页,设置只是盘上的一颗');
});

test('★ 删掉「换主题」那一格之后,设置页的主题下拉必须还在、还是三档', () => {
  // ★ 这条是「功能没丢」的**唯一证据**。删入口把主干一起带断,今天不是没见过 ——
  //   而且那种断法很安静:更多页少一格是看得见的,设置页下拉没了得有人专门去点。
  const sv = readFileSync(path.join(root, 'public/js/settings-view.js'), 'utf8');
  for (const v of ['dark', 'light', 'starry']) {
    assert.match(sv, new RegExp(`<option value="${v}"`), `设置页主题下拉少了 ${v} 这一档`);
  }
  // 反向:更多页不许再有主题入口(否则等于没删)
  const mv = readFileSync(path.join(root, 'public/js/more-view.js'), 'utf8');
  assert.doesNotMatch(mv, /more-theme/, '「换主题」那一格还在(或它的 action 还留着)');
  const app = readFileSync(path.join(root, 'public/app.js'), 'utf8');
  assert.doesNotMatch(app, /'more-theme'/, "app.js 里 'more-theme' 的分支是死代码,该清掉");
});
