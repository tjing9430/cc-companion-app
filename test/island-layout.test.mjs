// 浮岛首屏的落点:四档手机上,岛和标签的盒子必须站得住。
//
// ★ 为什么值得一条独立测试:落点出错是**静默**的 —— 页面照常渲染、控制台不报错,
//   只有真机上那半座岛被裁掉、或者两个标签叠成一坨。而首屏是她睁眼第一个看到的东西。
//
// ★★ 三条约束,以及**为什么只有这三条**:
//      ① 不出屏(横向 + 竖向)  ② 岛不压岛  ③ 标签不压标签
//    ⚠️ **「标签不压岛」不在里面** —— 需求方 8/11 的界面稿上,白色药丸标签本来就压在
//      岛边上。我第一版把它当硬约束,参数搜索 768 组配置**全军覆没**,
//      毙掉它们的是我发明的规矩,不是她的设计。★ 加约束前先回去看需求方画的是什么。
//
// ★★ 标签宽度**不抄 isles.js 的公式**,从 CSS 的字号推:
//      .sg-title{font-size:.92rem}→14.72px(中日韩字符约 1em 宽) · .sg-hint{.68rem}→10.88px
//      island 的 .sg-text{padding:.26rem .6rem;border:1px} → 左右共 +21.2px
//    两条独立路径对不上才逮得到错。(今晚就靠这个逮到 halfWidthOf 里 ×/÷ 写反。)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutIsles, MORE_SPOT } from '../public/js/isles.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 四档**真实**机型。★ 宽高必须成对来自同一台机器:
//   拿 320 的宽配 844 的高会造出一台不存在的手机,在它上面扫出来的问题也是不存在的。
const DEVICES = [
  { name: '320×568 iPhone SE1', w: 320, h: 568 },
  { name: '360×800 常见安卓', w: 360, h: 800 },
  { name: '390×844 iPhone 13', w: 390, h: 844 },
  { name: '430×932 15 Pro Max', w: 430, h: 932 },
];

const ASPECT = 900 / 1600;
const TITLE_PX = 0.92 * 16;
const HINT_PX = 0.68 * 16;
const TEXT_PAD = 21.2;
const GAP = 0.3 * 16;
const BELOW_GAP = 0.25 * 16;
const BELOW_LABEL_H = 0.82 * 16 * 1.35 + 0.26 * 16 * 2 + 2;
const LABEL_H = 0.92 * 16 * 1.3 + 0.68 * 16 * 1.3 + 0.26 * 16 * 2 + 2;

// 手抄自 home-view.js 的 ISLES。★ 手抄件会漂,所以下面有一条 drift 守卫钉着两边。
const GATES = [
  { tab: 'chat', title: '私聊', hintText: '与 CC 畅聊', ratio: 226 / 340, size: 22 },
  { tab: 'group', title: '群聊', hintText: '小群，提到就唤起', ratio: 340 / 231, size: 13 },
  { tab: 'memory', title: '记忆库', hintText: '珍藏回忆', ratio: 233 / 340, size: 20 },
  { tab: 'console', title: '控制台', hintText: '看它怎么干活', ratio: 340 / 236, size: 13 },
  { tab: 'settings', title: '设置', hintText: '名字 · 主题', ratio: 229 / 340, size: 18 },
];
const MORE = { title: '更多', ratio: 333 / 340, size: 11 };

const clampH = (size, h) => Math.min(200, Math.max(52, (size / 100) * h));

// 每个入口的 {岛盒, 标签盒},单位是**视口像素**。盒 = [x0, x1, y0, y1]。
function boxes(dev, gates = GATES, more = MORE_SPOT, moreSize = MORE.size) {
  const cw = dev.h * ASPECT;
  const left = (dev.w - cw) / 2;          // .sky-gates 居中;比视口宽时为负
  const out = layoutIsles(gates).map((g) => {
    const hPx = clampH(g.size, dev.h);
    const wPx = hPx * g.ratio;
    const cx = left + (g.x / 100) * cw;
    const cy = (g.y / 100) * dev.h;
    const tw = Math.min(0.38 * dev.w,
      Math.max(g.title.length * TITLE_PX, g.hintText.length * HINT_PX) + TEXT_PAD);
    const isl = [cx - wPx / 2, cx + wPx / 2, cy - hPx / 2, cy + hPx / 2];
    const txt = g.side === 'right'
      ? [isl[1] + GAP, isl[1] + GAP + tw, cy - LABEL_H / 2, cy + LABEL_H / 2]
      : [isl[0] - GAP - tw, isl[0] - GAP, cy - LABEL_H / 2, cy + LABEL_H / 2];
    return { name: g.title, isl, txt };
  });
  // 「更多」:标签排在正下方,不在左右
  const mh = clampH(moreSize, dev.h);
  const mw = mh * MORE.ratio;
  const mcx = left + (more.x / 100) * cw;
  const mcy = (more.y / 100) * dev.h;
  const misl = [mcx - mw / 2, mcx + mw / 2, mcy - mh / 2, mcy + mh / 2];
  out.push({
    name: '更多',
    isl: misl,
    txt: [mcx - 40, mcx + 40, misl[3] + BELOW_GAP, misl[3] + BELOW_GAP + BELOW_LABEL_H],
  });
  return out;
}

const overlaps = (a, b, slack = 0) =>
  Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > slack
  && Math.min(a[3], b[3]) - Math.max(a[2], b[2]) > slack;

function violations(dev, gates, more, moreSize) {
  const bs = boxes(dev, gates, more, moreSize);
  const bad = [];
  for (const b of bs) {
    for (const [what, box] of [['岛', b.isl], ['标签', b.txt]]) {
      if (box[0] < -0.5) bad.push(`${dev.name} · ${b.name} 的${what}左缘 ${box[0].toFixed(1)} 出屏`);
      if (box[1] > dev.w + 0.5) bad.push(`${dev.name} · ${b.name} 的${what}右缘 ${box[1].toFixed(1)} > ${dev.w}`);
      if (box[3] > dev.h + 0.5) bad.push(`${dev.name} · ${b.name} 的${what}底缘 ${box[3].toFixed(1)} > ${dev.h}`);
    }
  }
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      if (overlaps(bs[i].isl, bs[j].isl)) bad.push(`${dev.name}:${bs[i].name} 和 ${bs[j].name} 两座岛压在一起`);
      if (overlaps(bs[i].txt, bs[j].txt, 2)) bad.push(`${dev.name}:${bs[i].name} 和 ${bs[j].name} 的标签叠在一起`);
    }
  }
  return bad;
}

test('四档手机:不出屏 · 岛不压岛 · 标签不压标签', () => {
  const bad = DEVICES.flatMap((d) => violations(d, GATES, MORE_SPOT, MORE.size));
  assert.deepEqual(bad, [], `\n${bad.join('\n')}`);
});

test('★ 阳性对照:把「更多」放回 y=91%,必须报越出屏底', () => {
  // ★ 91 不是编的 —— 是我这一版**真的写过**的值。CDP 截图上「更多」两个字只剩上半截,
  //   而当时的测试全绿,因为它只量了横向。后来改到 88 仍在 320×568 上越界 3.6px,
  //   那一版**测试是红的** —— 现在这组 y/x/size 是拿这条判据搜出来的,不是看图调的。
  const bad = DEVICES.flatMap((d) => violations(d, GATES, { ...MORE_SPOT, y: 91 }, MORE.size));
  assert.ok(bad.some((x) => x.includes('底缘')),
    '把「更多」放回 91% 居然没报越界 —— 这条竖向判据没有牙');
});

test('★ 阳性对照:把六座岛堆到同一小块上,必须报相撞', () => {
  const squashed = GATES.map((g, i) => ({ ...g, spot: { x: 35 + (i % 2) * 2, y: 40 + i * 2, side: 'left' } }));
  const bad = DEVICES.flatMap((d) => violations(d, squashed, MORE_SPOT, MORE.size));
  assert.ok(bad.some((x) => x.includes('压在一起')), '六座岛堆一块还判没撞 —— 碰撞判据没有牙');
});

test('★ 测试里的 GATES 不许和 home-view.js 的 ISLES 漂开', () => {
  // ★ 上面那张表是手抄的。手抄件会漂,而漂了之后测试**照样绿** ——
  //   它只是在测一个线上不存在的版本。今晚真发生过:我改完 size 忘了改这儿。
  const src = fs.readFileSync(path.join(REPO, 'public', 'js', 'home-view.js'), 'utf8');
  for (const g of [...GATES, { tab: 'more', ...MORE }]) {
    const re = new RegExp(`${g.tab}:\\s*\\{[^}]*ratio:\\s*([\\d.]+)\\s*/\\s*([\\d.]+),\\s*size:\\s*([\\d.]+)`);
    const m = re.exec(src);
    assert.ok(m, `home-view.js 的 ISLES 里找不到 ${g.tab}`);
    assert.equal(Number(m[3]), g.size, `${g.tab} 的 size 漂了:测试 ${g.size} / 线上 ${m[3]}`);
    assert.ok(Math.abs(Number(m[1]) / Number(m[2]) - g.ratio) < 1e-9,
      `${g.tab} 的 ratio 漂了:测试 ${g.ratio} / 线上 ${m[1]}/${m[2]}`);
  }
});

test('★ 每个浮岛入口都指到一张真实存在的图(少一个 file 字段 = 那座岛整个消失)', () => {
  // ⚠️ 这条是**踩出来的**:改尺寸时我的批量脚本顺手删掉了 settings 的 file 字段,
  //   代码照跑不误,只是去请求 `/assets/island/undefined.webp` ——
  //   404 一张图在页面上就是"那个位置什么都没有",没有任何报错。
  //   「资源存在」和「代码指得对」是两件事,少验一件都不够。
  const src = fs.readFileSync(path.join(REPO, 'public', 'js', 'home-view.js'), 'utf8');
  const block = /const ISLES = \{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, 'ISLES 表不见了(或换了写法),这条测试要跟着更新');
  const rows = block[1].split('\n').filter((l) => /^\s*\w+:\s*\{/.test(l));
  assert.equal(rows.length, 6, `ISLES 应有 6 座岛,实际 ${rows.length}`);
  for (const line of rows) {
    const m = /^\s*(\w+):\s*\{\s*file:\s*'([\w-]+)'/.exec(line);
    assert.ok(m, `这一行没有 file 字段 → 会去请求 undefined.webp:\n  ${line.trim()}`);
    const p = path.join(REPO, 'public', 'assets', 'island', `${m[2]}.webp`);
    assert.ok(fs.existsSync(p), `${m[1]} 指向的 island/${m[2]}.webp 不存在`);
    assert.ok(fs.statSync(p).size <= 110 * 1024, `island/${m[2]}.webp 超过 110KB`);
  }
});
